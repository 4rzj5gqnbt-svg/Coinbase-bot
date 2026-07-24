const { getSpotPrice, listAccounts, marketSell, marketBuy, getCandles, getBaseIncrement, roundToIncrement } = require("../lib/coinbase");
const { getSupabase } = require("../lib/supabase");
const {
  sma,
  isMovingAverageRising,
  rsi,
  atr,
  averageVolume,
  recentResistance,
  recentSupport,
} = require("../lib/indicators");

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SIMULTANEOUS_TRADES = 5;
const RISK_PER_TRADE_PCT = 0.02; // 2% of total capital
const DAILY_LOSS_LIMIT_PCT = 0.05; // 5%
const MOMENTUM_TRAILING_STOP_PCT = 0.025; // 2.5%
const MEAN_REVERSION_TAKE_PROFIT_PCT = 0.04; // midpoint of 3-5%
const MEAN_REVERSION_STOP_LOSS_PCT = 0.025; // 2-3% band, using 2.5%

// Entry-condition thresholds — loosened from the original spec so the bot
// finds more (lower-conviction) trades instead of sitting idle for long
// stretches. Loosening these means more trades and more fee drag, and each
// individual trade is less "confirmed" than the original stricter version.
const MOMENTUM_ATR_MULTIPLE = 0.6; // was 1.2
const MOMENTUM_VOLUME_MULTIPLE = 1.2; // was 1.5
const MOMENTUM_RESISTANCE_PROXIMITY = 0.995; // was: must fully break above (1.0)
const MEAN_REVERSION_ATR_MULTIPLE = 0.8; // was 1.5
const MEAN_REVERSION_RSI_OVERSOLD = 40; // was 30
const MEAN_REVERSION_VOLUME_MULTIPLE = 1.2; // was 1.5
const MEAN_REVERSION_SUPPORT_PROXIMITY = 1.02; // was 1.01

module.exports = async function handler(req, res) {
  console.log("VERSION CHECK: buy-fix-deployed-v2");
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const supabase = getSupabase();
  const results = [];

  try {
    const { data: positions, error } = await supabase
      .from("trading_positions")
      .select("*")
      .eq("enabled", true);
    if (error) throw error;

    const accounts = await listAccounts();
    const pricesNow = {};
    for (const pos of positions) {
      pricesNow[pos.product_id] = await getSpotPrice(pos.product_id);
    }
    const totalCapitalNow = positions.reduce(
      (sum, p) => sum + p.cash_gbp + p.base_size * (pricesNow[p.product_id] || 0),
      0
    );

    let { data: riskRows } = await supabase.from("risk_state").select("*").eq("id", 1);
    let risk = riskRows && riskRows[0];
    const today = new Date().toISOString().slice(0, 10);
    if (!risk || risk.day !== today) {
      risk = {
        id: 1,
        day: today,
        day_start_capital_gbp: totalCapitalNow,
        trading_halted_today: false,
      };
      await supabase.from("risk_state").upsert(risk);
    }
    const drawdownPct =
      risk.day_start_capital_gbp > 0
        ? (risk.day_start_capital_gbp - totalCapitalNow) / risk.day_start_capital_gbp
        : 0;
    const haltedToday = risk.trading_halted_today || drawdownPct >= DAILY_LOSS_LIMIT_PCT;
    if (haltedToday && !risk.trading_halted_today) {
      await supabase.from("risk_state").update({ trading_halted_today: true }).eq("id", 1);
    }

    const openPositionsCount = positions.filter((p) => p.in_position).length;

    for (const pos of positions) {
      const logAndPush = async (entry) => {
        await supabase.from("trading_log").insert({
          product_id: pos.product_id,
          ...entry,
        });
        results.push({ product_id: pos.product_id, ...entry });
      };

      try {
        const price = pricesNow[pos.product_id];

        // Reconcile with your ACTUAL Coinbase balance. If you manually
        // bought/sold this coin outside the bot (e.g. via the Coinbase
        // app), the bot's own ledger (base_size) would otherwise be stale
        // and it would keep thinking it holds nothing when you really do
        // (or vice versa). We correct base_size to match reality here,
        // every check, before making any buy/sell decision.
        const account = accounts.find((a) => a.currency === pos.base_currency);
        const actualBalance = account ? parseFloat(account.available_balance.value) : 0;
        const trackedBalance = pos.base_size || 0;
        const balanceDiff = Math.abs(actualBalance - trackedBalance);
        const balanceMismatch = balanceDiff > trackedBalance * 0.01 + 0.00000001; // >1% relative, plus a tiny absolute floor for dust/rounding

        if (balanceMismatch) {
          const wasInPosition = pos.in_position;
          pos.base_size = actualBalance;
          pos.in_position = actualBalance > 0;
          if (actualBalance > 0 && !wasInPosition) {
            // We now hold this coin but the bot didn't know — likely a
            // manual buy. We don't know your real purchase price, so use
            // the current price as a starting reference point.
            pos.entry_price = price;
            pos.peak_price = price;
          } else if (actualBalance <= 0) {
            pos.entry_price = null;
            pos.peak_price = null;
          }

          await supabase
            .from("trading_positions")
            .update({
              base_size: pos.base_size,
              in_position: pos.in_position,
              entry_price: pos.entry_price,
              peak_price: pos.peak_price,
            })
            .eq("product_id", pos.product_id);

          await logAndPush({
            action: "RECONCILE",
            status: "success",
            price,
            reasoning: `Bot's tracked balance (${trackedBalance}) didn't match your actual Coinbase balance (${actualBalance}) — corrected. This usually means a manual buy/sell happened outside the bot.`,
          });
        }


        const inCooldown =
          pos.last_trade_at &&
          Date.now() - new Date(pos.last_trade_at).getTime() < COOLDOWN_MS;

        const candles = await getCandles(pos.product_id, {
          granularity: "ONE_HOUR",
          candleCount: 210,
        });

        if (candles.length < 60) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            detail: "Not enough candle history yet for reliable indicators.",
          });
          continue;
        }

        const ma50 = sma(candles, 50);
        const ma200 = sma(candles, Math.min(200, candles.length));
        const ma50Rising = isMovingAverageRising(candles, 50);
        const rsi14 = rsi(candles, 14);
        const atr1h = atr(candles, 14);
        const avgVol = averageVolume(candles, 20);
        const resistance = recentResistance(candles, 20);
        const support = recentSupport(candles, 20);
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        const currentVolume = lastCandle.volume;

        const regime =
          ma200 !== null && price > ma200 && ma50Rising && ma50 > ma200
            ? "MOMENTUM"
            : "MEAN_REVERSION";

        await supabase
          .from("trading_positions")
          .update({
            last_checked_at: new Date().toISOString(),
            last_checked_price: price,
            last_regime: pos.in_position ? pos.last_regime : regime,
            updated_at: new Date().toISOString(),
          })
          .eq("product_id", pos.product_id);

        if (inCooldown) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: "In 30-minute post-trade cooldown.",
          });
          continue;
        }

        // A coin is only treated as "meaningfully held" if it's worth more
        // than a few pence — otherwise leftover dust (e.g. 0.0000000067 ETH
        // from a previous profit-skim) would permanently block the bot from
        // ever checking buy conditions again, leaving cash stuck idle
        // forever. This was a real bug: coins never returned to a
        // buyable/"watching" state once any tiny fraction remained.
        const DUST_THRESHOLD_GBP = 0.05;
        const holdingValueGbp = pos.base_size * price;
        const hasMeaningfulHolding = holdingValueGbp > DUST_THRESHOLD_GBP;

        // Self-correct stale state: if the DB still says "in position" but
        // what's left is just unsellable dust, fix that now so this coin
        // isn't stuck permanently counted as an open trade.
        if (!hasMeaningfulHolding && pos.in_position) {
          await supabase
            .from("trading_positions")
            .update({ in_position: false })
            .eq("product_id", pos.product_id);
          pos.in_position = false;
        }

        let sellExecutedThisCycle = false;

        // ============= CHECK SELL CONDITIONS (if meaningfully holding) =============
        if (hasMeaningfulHolding) {
          const newPeak = Math.max(pos.peak_price || pos.entry_price || price, price);
          let shouldSell = false;
          let reasoning = "";

          if (pos.last_regime === "MOMENTUM") {
            const stopPrice = newPeak * (1 - MOMENTUM_TRAILING_STOP_PCT);
            const momentumWeakening = rsi14 >= 75 && price < prevCandle.close;
            if (price <= stopPrice) {
              shouldSell = true;
              reasoning = `Momentum trailing stop: price ${price} <= ${stopPrice.toFixed(4)} (2.5% below peak ${newPeak}).`;
            } else if (momentumWeakening) {
              shouldSell = true;
              reasoning = `RSI overbought (${rsi14.toFixed(1)}) and price weakening.`;
            }
          } else {
            const takeProfitPrice = pos.entry_price * (1 + MEAN_REVERSION_TAKE_PROFIT_PCT);
            const stopLossPrice = pos.entry_price * (1 - MEAN_REVERSION_STOP_LOSS_PCT);
            if (price >= takeProfitPrice) {
              shouldSell = true;
              reasoning = `Take-profit hit: price ${price} >= ${takeProfitPrice.toFixed(4)} (+${(MEAN_REVERSION_TAKE_PROFIT_PCT * 100).toFixed(1)}% from entry).`;
            } else if (rsi14 >= 60) {
              shouldSell = true;
              reasoning = `RSI back to neutral/overbought (${rsi14.toFixed(1)}) — exiting mean-reversion trade.`;
            } else if (price <= stopLossPrice) {
              shouldSell = true;
              reasoning = `Stop-loss hit: price ${price} <= ${stopLossPrice.toFixed(4)}.`;
            }
          }

          if (pos.last_regime === "MOMENTUM") {
            await supabase
              .from("trading_positions")
              .update({ peak_price: newPeak })
              .eq("product_id", pos.product_id);
            pos.peak_price = newPeak;
          }

          if (!shouldSell) {
            await logAndPush({
              action: "HOLD",
              status: "skipped",
              price,
              regime: pos.last_regime,
              reasoning: "No exit condition met.",
            });
          } else {
            const hasGain = price > pos.entry_price;
            let sellBaseSize;
            let sellType;
            if (hasGain) {
              const profitGbp = pos.base_size * (price - pos.entry_price);
              sellBaseSize = profitGbp / price;
              sellType = "partial (profit only)";
            } else {
              sellBaseSize = pos.base_size;
              sellType = "full (stop-loss, no gain to skim)";
            }

            const baseIncrement = await getBaseIncrement(pos.product_id);
            sellBaseSize = roundToIncrement(sellBaseSize, baseIncrement);

            if (sellBaseSize <= 0) {
              await logAndPush({
                action: "SELL",
                status: "skipped",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [profit portion rounds to 0 at this coin's minimum order precision — nothing to sell yet]`,
              });
            } else {
              const order = await marketSell({
                productId: pos.product_id,
                baseSize: sellBaseSize,
              });

              if (order.success === false) {
                await logAndPush({
                  action: "SELL",
                  status: "error",
                  price,
                  regime: pos.last_regime,
                  reasoning: `${reasoning} [${sellType}]`,
                  detail: `Order rejected by Coinbase, position left unchanged: ${JSON.stringify(order.error_response || order)}`,
                });
              } else {
                const proceedsGbp = sellBaseSize * price;
                const remainingBaseSize = pos.base_size - sellBaseSize;
                const stillHolding = remainingBaseSize * price > DUST_THRESHOLD_GBP;

                await supabase
                  .from("trading_positions")
                  .update({
                    cash_gbp: pos.cash_gbp + proceedsGbp,
                    base_size: stillHolding ? remainingBaseSize : 0,
                    in_position: stillHolding,
                    entry_price: stillHolding ? price : null,
                    peak_price: stillHolding ? price : null,
                    last_trade_at: new Date().toISOString(),
                  })
                  .eq("product_id", pos.product_id);

                // Keep our in-memory copy in sync for the buy-check below.
                pos.cash_gbp = pos.cash_gbp + proceedsGbp;
                pos.base_size = stillHolding ? remainingBaseSize : 0;
                pos.in_position = stillHolding;

                await logAndPush({
                  action: "SELL",
                  status: "success",
                  price,
                  regime: pos.last_regime,
                  amount_gbp: proceedsGbp,
                  base_size: sellBaseSize,
                  coinbase_order_id: order?.success_response?.order_id || null,
                  reasoning: `${reasoning} [${sellType} — sold ${sellBaseSize.toFixed(8)} of ${(remainingBaseSize + sellBaseSize).toFixed(8)}, kept ${remainingBaseSize.toFixed(8)} invested]`,
                  detail: JSON.stringify(order),
                });
                sellExecutedThisCycle = true;
              }
            }
          }
        }

        // ============= CHECK BUY CONDITIONS =============
        // Runs regardless of whether we already hold some of this coin —
        // averaging into an existing holding on a dip is fine. Skipped only
        // if we just sold this same coin this cycle (avoid buying straight
        // back into what we just sold in the same run).
        if (sellExecutedThisCycle) {
          continue;
        }
        if (haltedToday) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Daily loss limit hit (${(drawdownPct * 100).toFixed(1)}% drawdown) — new buys paused for today.`,
          });
          continue;
        }

        if (openPositionsCount >= MAX_SIMULTANEOUS_TRADES) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Max simultaneous trades (${MAX_SIMULTANEOUS_TRADES}) already open.`,
          });
          continue;
        }

        if (pos.cash_gbp < 1) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: "No cash allocated to this coin (or balance too small to trade).",
          });
          continue;
        }

        let shouldBuy = false;
        let reasoning = "";
        let diagnostics = "";

        if (regime === "MOMENTUM") {
          const priceMove = price - prevCandle.close;
          const brokeResistance = resistance !== null && price > resistance * MOMENTUM_RESISTANCE_PROXIMITY;
          const volumeSpike = avgVol !== null && currentVolume >= MOMENTUM_VOLUME_MULTIPLE * avgVol;
          const bigEnoughMove = atr1h !== null && priceMove >= MOMENTUM_ATR_MULTIPLE * atr1h;
          diagnostics = `move=${priceMove.toFixed(4)} (need>=${(MOMENTUM_ATR_MULTIPLE * atr1h).toFixed(4)}: ${bigEnoughMove}), volume=${currentVolume.toFixed(2)} (need>=${(MOMENTUM_VOLUME_MULTIPLE * avgVol).toFixed(2)}: ${volumeSpike}), price=${price} vs resistance*${MOMENTUM_RESISTANCE_PROXIMITY}=${(resistance * MOMENTUM_RESISTANCE_PROXIMITY).toFixed(4)} (${brokeResistance})`;
          if (bigEnoughMove && volumeSpike && brokeResistance) {
            shouldBuy = true;
            reasoning = `Momentum breakout (loosened thresholds): +${priceMove.toFixed(4)} move (>=${MOMENTUM_ATR_MULTIPLE}x ATR ${atr1h.toFixed(4)}), volume ${currentVolume.toFixed(2)} >= ${MOMENTUM_VOLUME_MULTIPLE}x avg ${avgVol.toFixed(2)}, near/above resistance ${resistance.toFixed(4)}.`;
          }
        } else {
          const priceDrop = prevCandle.close - price;
          const nearSupport = support !== null && price <= support * MEAN_REVERSION_SUPPORT_PROXIMITY;
          const volumeSpike = avgVol !== null && currentVolume >= MEAN_REVERSION_VOLUME_MULTIPLE * avgVol;
          const bigEnoughDrop = atr1h !== null && priceDrop >= MEAN_REVERSION_ATR_MULTIPLE * atr1h;
          const oversold = rsi14 !== null && rsi14 <= MEAN_REVERSION_RSI_OVERSOLD;
          diagnostics = `drop=${priceDrop.toFixed(4)} (need>=${(MEAN_REVERSION_ATR_MULTIPLE * atr1h).toFixed(4)}: ${bigEnoughDrop}), RSI=${rsi14?.toFixed(1)} (need<=${MEAN_REVERSION_RSI_OVERSOLD}: ${oversold}), volume=${currentVolume.toFixed(2)} (need>=${(MEAN_REVERSION_VOLUME_MULTIPLE * avgVol).toFixed(2)}: ${volumeSpike}), price=${price} vs support*${MEAN_REVERSION_SUPPORT_PROXIMITY}=${(support * MEAN_REVERSION_SUPPORT_PROXIMITY).toFixed(4)} (${nearSupport})`;
          if (bigEnoughDrop && oversold && volumeSpike && nearSupport) {
            shouldBuy = true;
            reasoning = `Mean-reversion dip (loosened thresholds): -${priceDrop.toFixed(4)} drop (>=${MEAN_REVERSION_ATR_MULTIPLE}x ATR ${atr1h.toFixed(4)}), RSI ${rsi14.toFixed(1)} <= ${MEAN_REVERSION_RSI_OVERSOLD}, volume spike, near support ${support.toFixed(4)}.`;
          }
        }

        if (!shouldBuy) {
          await logAndPush({
            action: "HOLD",
            status: "skipped",
            price,
            regime,
            reasoning: `No entry condition met. ${diagnostics}`,
          });
          continue;
        }

        const stopDistancePct =
          regime === "MOMENTUM" ? MOMENTUM_TRAILING_STOP_PCT : MEAN_REVERSION_STOP_LOSS_PCT;
        const maxRiskGbp = RISK_PER_TRADE_PCT * totalCapitalNow;
        const riskBasedSizeGbp = stopDistancePct > 0 ? maxRiskGbp / stopDistancePct : pos.cash_gbp;
        const spendGbp = Math.min(pos.cash_gbp, riskBasedSizeGbp);

        if (spendGbp < 1) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: "Risk-adjusted position size rounds to under £1 — skipping.",
          });
          continue;
        }

        const order = await marketBuy({ productId: pos.product_id, quoteSize: spendGbp });

        if (order.success === false) {
          await logAndPush({
            action: "BUY",
            status: "error",
            price,
            regime,
            reasoning,
            detail: `Order rejected by Coinbase, no cash was spent: ${JSON.stringify(order.error_response || order)}`,
          });
          continue; // do NOT update position state — nothing was actually bought
        }

        const approxBaseSize = spendGbp / price;
        const newBaseSize = pos.base_size + approxBaseSize;
        // If already holding some, blend entry price (weighted average);
        // otherwise this is a fresh entry.
        const newEntryPrice =
          pos.base_size > 0 && pos.entry_price
            ? (pos.entry_price * pos.base_size + price * approxBaseSize) / newBaseSize
            : price;
        const newPeak = Math.max(pos.peak_price || price, price);

        await supabase
          .from("trading_positions")
          .update({
            cash_gbp: pos.cash_gbp - spendGbp,
            base_size: newBaseSize,
            in_position: true,
            entry_price: newEntryPrice,
            peak_price: newPeak,
            last_regime: regime,
            last_trade_at: new Date().toISOString(),
          })
          .eq("product_id", pos.product_id);

        await logAndPush({
          action: "BUY",
          status: "success",
          price,
          regime,
          amount_gbp: spendGbp,
          base_size: approxBaseSize,
          coinbase_order_id: order?.success_response?.order_id || null,
          reasoning,
          detail: JSON.stringify(order),
        });
      } catch (innerErr) {
        await logAndPush({
          action: "ERROR",
          status: "error",
          price: pricesNow[pos.product_id] || 0,
          detail: String(innerErr),
        });
      }
    }

    return res.status(200).json({ ok: true, haltedToday, totalCapitalNow, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
