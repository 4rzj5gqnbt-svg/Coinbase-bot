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

// Coinbase charges a taker fee on both the buy and the sell side of a trade
// (check your tier at coinbase.com/advanced-fees). Small profit-skims were
// very likely losing money after fees despite showing as "successful".
// Measured from this account's own reconciliations (Jul–Oct 2026): every buy
// delivered ~1.2% less coin than spend/price, so the real taker fee is ~1.2%
// per side (~2.4% round trip), not 0.6%.
const COINBASE_TAKER_FEE_PCT = 0.012;
const MIN_PROFIT_AFTER_FEES_PCT = 0.03; // require >=3% gain before taking profit (covers the real ~2.4% round-trip fee plus a margin)
const MIN_TRADE_SIZE_GBP = 3; // skip trades this small — fees take too large a bite proportionally

// Shared cash pool model: one pot of GBP (stored in risk_state.shared_cash_gbp)
// funds buys of ANY coin, and profit-skims flow back into it. To avoid the
// pool being drained into a single coin, each buy is capped to a fraction of
// the *current* pool: 30% for the main coins, 10% for everything else.
const POOL_CAP_PCT = { "BTC-GBP": 0.30, "ETH-GBP": 0.30, "ADA-GBP": 0.30 };
const POOL_CAP_PCT_DEFAULT = 0.10;
const DAILY_LOSS_LIMIT_PCT = 0.05; // 5%
const MOMENTUM_TRAILING_STOP_PCT = 0.025; // 2.5%
const MEAN_REVERSION_TAKE_PROFIT_PCT = 0.04; // midpoint of 3-5%
const MEAN_REVERSION_STOP_LOSS_PCT = 0.025; // 2-3% band, using 2.5%

// Entry-condition thresholds — back to the ORIGINAL stricter spec (Oct 2026).
// The loosened versions (0.6x ATR, 1.2x volume, etc.) produced more trades,
// but Jul–Oct data showed the extra trading didn't beat simply holding and
// often bought back near local tops. Fewer, better-confirmed entries instead.
const MOMENTUM_ATR_MULTIPLE = 1.2; // loosened version was 0.6
const MOMENTUM_VOLUME_MULTIPLE = 1.5; // loosened version was 1.2
const MOMENTUM_RESISTANCE_PROXIMITY = 1.0; // must fully break above (loosened was 0.995)
const MEAN_REVERSION_ATR_MULTIPLE = 1.5; // loosened version was 0.8
const MEAN_REVERSION_RSI_OVERSOLD = 30; // loosened version was 40
const MEAN_REVERSION_VOLUME_MULTIPLE = 1.5; // loosened version was 1.2
const MEAN_REVERSION_SUPPORT_PROXIMITY = 1.01; // loosened version was 1.02

// Anti-churn rules. The bot repeatedly sold a coin and then bought it back
// higher within a day or two (e.g. ADA sold ~0.2048 on 5 Oct, rebought 0.209
// on 6 Oct). After any successful sell of a coin:
//  - no buying that coin again for REBUY_BLOCK_HOURS, and
//  - until REBUY_BELOW_SELL_HOURS, only buy it back at or below the sell price.
const REBUY_BLOCK_HOURS = 24;
const REBUY_BELOW_SELL_HOURS = 72;

module.exports = async function handler(req, res) {
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
    const positionsValue = positions.reduce(
      (sum, p) => sum + p.base_size * (pricesNow[p.product_id] || 0),
      0
    );
    // Shared pool is added below once it's loaded from risk_state.
    let totalCapitalNow = positionsValue;

    let { data: riskRows } = await supabase.from("risk_state").select("*").eq("id", 1);
    let risk = riskRows && riskRows[0];
    const today = new Date().toISOString().slice(0, 10);
    if (!risk || risk.day !== today) {
      risk = {
        id: 1,
        day: today,
        day_start_capital_gbp: totalCapitalNow,
        trading_halted_today: false,
        // Carry the shared cash pool across the daily reset — it's real
        // money, not a per-day counter, so it must never be wiped.
        shared_cash_gbp: risk ? risk.shared_cash_gbp || 0 : 0,
      };
      await supabase.from("risk_state").upsert(risk);
    }
    // Live handle on the shared pool for this run.
    let sharedCash = parseFloat(risk.shared_cash_gbp || 0);
    totalCapitalNow += sharedCash;
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
        const balanceMismatch = balanceDiff > trackedBalance * 0.002 + 0.00000001; // >0.2% relative (was 1%, which let fee drift pile up unnoticed), plus a tiny absolute floor for dust/rounding

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

          // isProtectiveExit distinguishes a genuine capital-protection exit
          // (price fell below your original cost basis) from a routine
          // profit-taking signal. Only the former should ever close the
          // whole position — profit-taking signals just skim the gain.
          let isProtectiveExit = false;

          if (pos.last_regime === "MOMENTUM") {
            const stopPrice = newPeak * (1 - MOMENTUM_TRAILING_STOP_PCT);
            const momentumWeakening = rsi14 >= 75 && price < prevCandle.close;
            const hardStopPrice = pos.entry_price * (1 - MOMENTUM_TRAILING_STOP_PCT);
            if (price <= hardStopPrice) {
              shouldSell = true;
              isProtectiveExit = true;
              reasoning = `Stop-loss: price ${price} fell ${(MOMENTUM_TRAILING_STOP_PCT * 100).toFixed(1)}% below original entry ${pos.entry_price} — closing to protect capital.`;
            } else if (price <= stopPrice) {
              shouldSell = true;
              reasoning = `Momentum trailing stop: price ${price} <= ${stopPrice.toFixed(4)} (2.5% below peak ${newPeak}) — taking profit, keeping principal.`;
            } else if (momentumWeakening) {
              shouldSell = true;
              reasoning = `RSI overbought (${rsi14.toFixed(1)}) and price weakening — taking profit, keeping principal.`;
            }
          } else {
            const takeProfitPrice = pos.entry_price * (1 + MEAN_REVERSION_TAKE_PROFIT_PCT);
            const stopLossPrice = pos.entry_price * (1 - MEAN_REVERSION_STOP_LOSS_PCT);
            if (price <= stopLossPrice) {
              shouldSell = true;
              isProtectiveExit = true;
              reasoning = `Stop-loss hit: price ${price} <= ${stopLossPrice.toFixed(4)} — closing to protect capital.`;
            } else if (price >= takeProfitPrice) {
              shouldSell = true;
              reasoning = `Take-profit hit: price ${price} >= ${takeProfitPrice.toFixed(4)} (+${(MEAN_REVERSION_TAKE_PROFIT_PCT * 100).toFixed(1)}% from entry) — taking profit, keeping principal.`;
            } else if (rsi14 >= 60) {
              shouldSell = true;
              reasoning = `RSI back to neutral/overbought (${rsi14.toFixed(1)}) — taking profit, keeping principal.`;
            }
          }

          // Fee-awareness gate: a profit-taking trigger (not a protective
          // stop-loss) only proceeds if the gain actually clears Coinbase's
          // round-trip fee cost with a margin. Otherwise the trade is very
          // likely a net loss once fees are factored in, even though it
          // looks like a "successful" profit-taking sell. We just hold and
          // wait for either a bigger gain or a genuine stop-loss instead.
          if (shouldSell && !isProtectiveExit) {
            const gainPct = (price - pos.entry_price) / pos.entry_price;
            if (gainPct < MIN_PROFIT_AFTER_FEES_PCT) {
              shouldSell = false;
              reasoning = `${reasoning} [skipped: gain of ${(gainPct * 100).toFixed(2)}% doesn't clear the ~${(MIN_PROFIT_AFTER_FEES_PCT * 100).toFixed(1)}% needed to cover round-trip fees — holding for a bigger move instead]`;
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
            // Full exit ONLY on a genuine protective stop-loss. Every other
            // trigger is profit-taking: skim the gain, keep the principal
            // invested so it keeps riding the coin.
            let sellBaseSize;
            let sellType;
            if (isProtectiveExit) {
              sellBaseSize = pos.base_size;
              sellType = "full exit (stop-loss — protecting capital)";
            } else {
              const profitGbp = pos.base_size * Math.max(0, price - pos.entry_price);
              sellBaseSize = profitGbp / price;
              sellType = "partial (profit only, principal kept invested)";
            }

            // Never ask Coinbase to sell more than is actually available.
            // The bot's ledger can run slightly ahead of reality (buy fees
            // come out of the coin received), and a full stop-loss sell of
            // the ledger amount was being rejected with INSUFFICIENT_FUND
            // every hour — so the stop-loss never actually fired.
            sellBaseSize = Math.min(sellBaseSize, actualBalance);
            const baseIncrement = await getBaseIncrement(pos.product_id);
            sellBaseSize = roundToIncrement(sellBaseSize, baseIncrement);

            // Skip tiny profit-skims below our minimum trade size — fees
            // take too large a bite of a very small trade. This does NOT
            // apply to protective stop-loss exits, which must always fully
            // execute regardless of size to actually protect your capital.
            if (!isProtectiveExit && sellBaseSize * price < MIN_TRADE_SIZE_GBP) {
              await logAndPush({
                action: "SELL",
                status: "skipped",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [profit portion (£${(sellBaseSize * price).toFixed(2)}) is below the £${MIN_TRADE_SIZE_GBP} minimum trade size — holding for a bigger skim instead]`,
              });
            } else if (sellBaseSize <= 0) {
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
                // Coinbase takes its fee out of the GBP proceeds, so credit
                // the pool with what actually arrives, not the gross amount.
                const proceedsGbp = sellBaseSize * price * (1 - COINBASE_TAKER_FEE_PCT);
                const remainingBaseSize = Math.max(0, Math.min(pos.base_size, actualBalance) - sellBaseSize);
                const stillHolding = remainingBaseSize * price > DUST_THRESHOLD_GBP;

                // Proceeds flow into the SHARED pool, not a per-coin pot —
                // so profit skimmed from one coin's climb can fund a buy of
                // any coin next time a signal fires.
                sharedCash += proceedsGbp;

                await supabase
                  .from("trading_positions")
                  .update({
                    base_size: stillHolding ? remainingBaseSize : 0,
                    in_position: stillHolding,
                    // Keep the ORIGINAL entry price when we've only skimmed
                    // profit — it's still the true cost basis for what's
                    // left. Only clear it when the position is fully closed.
                    entry_price: stillHolding ? pos.entry_price : null,
                    // Reset the peak so the trailing stop measures the next
                    // climb from here rather than from an old high we've
                    // already taken profit on.
                    peak_price: stillHolding ? price : null,
                    last_trade_at: new Date().toISOString(),
                  })
                  .eq("product_id", pos.product_id);

                await supabase
                  .from("risk_state")
                  .update({ shared_cash_gbp: sharedCash })
                  .eq("id", 1);

                // Keep our in-memory copy in sync for the buy-check below.
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

        if (sharedCash < 1) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Shared cash pool too low to trade (£${sharedCash.toFixed(2)}).`,
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
            reasoning = `Momentum breakout: +${priceMove.toFixed(4)} move (>=${MOMENTUM_ATR_MULTIPLE}x ATR ${atr1h.toFixed(4)}), volume ${currentVolume.toFixed(2)} >= ${MOMENTUM_VOLUME_MULTIPLE}x avg ${avgVol.toFixed(2)}, near/above resistance ${resistance.toFixed(4)}.`;
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
            reasoning = `Mean-reversion dip: -${priceDrop.toFixed(4)} drop (>=${MEAN_REVERSION_ATR_MULTIPLE}x ATR ${atr1h.toFixed(4)}), RSI ${rsi14.toFixed(1)} <= ${MEAN_REVERSION_RSI_OVERSOLD}, volume spike, near support ${support.toFixed(4)}.`;
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

        // Anti-churn check: look up the last successful sell of this coin.
        const { data: lastSells } = await supabase
          .from("trading_log")
          .select("price, created_at")
          .eq("product_id", pos.product_id)
          .eq("action", "SELL")
          .eq("status", "success")
          .order("created_at", { ascending: false })
          .limit(1);
        const lastSell = lastSells && lastSells[0];
        if (lastSell) {
          const hoursSinceSell = (Date.now() - new Date(lastSell.created_at).getTime()) / 3600000;
          const lastSellPrice = parseFloat(lastSell.price);
          let churnBlock = null;
          if (hoursSinceSell < REBUY_BLOCK_HOURS) {
            churnBlock = `sold ${hoursSinceSell.toFixed(1)}h ago — no rebuy within ${REBUY_BLOCK_HOURS}h of a sell`;
          } else if (hoursSinceSell < REBUY_BELOW_SELL_HOURS && price > lastSellPrice) {
            churnBlock = `price ${price} is above last sell price ${lastSellPrice} (${hoursSinceSell.toFixed(1)}h ago) — within ${REBUY_BELOW_SELL_HOURS}h only rebuy at or below the sell price`;
          }
          if (churnBlock) {
            await logAndPush({
              action: "SKIP",
              status: "skipped",
              price,
              regime,
              reasoning: `Buy signal ignored (anti-churn): ${churnBlock}. Signal was: ${reasoning}`,
            });
            continue;
          }
        }

        const stopDistancePct =
          regime === "MOMENTUM" ? MOMENTUM_TRAILING_STOP_PCT : MEAN_REVERSION_STOP_LOSS_PCT;
        const maxRiskGbp = RISK_PER_TRADE_PCT * totalCapitalNow;
        const riskBasedSizeGbp = stopDistancePct > 0 ? maxRiskGbp / stopDistancePct : sharedCash;
        // Per-coin cap on the shared pool: 30% for main coins, 10% otherwise.
        const capPct = POOL_CAP_PCT[pos.product_id] || POOL_CAP_PCT_DEFAULT;
        const capGbp = sharedCash * capPct;
        const spendGbp = Math.min(sharedCash, riskBasedSizeGbp, capGbp);

        if (spendGbp < MIN_TRADE_SIZE_GBP) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Position size after ${(capPct * 100).toFixed(0)}% pool cap and risk sizing is under the £${MIN_TRADE_SIZE_GBP} minimum (pool £${sharedCash.toFixed(2)}) — skipping.`,
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

        // The fee is taken out of the coin received, so record the net amount.
        const approxBaseSize = (spendGbp * (1 - COINBASE_TAKER_FEE_PCT)) / price;
        const newBaseSize = pos.base_size + approxBaseSize;
        // If already holding some, blend entry price (weighted average);
        // otherwise this is a fresh entry.
        // Cost basis includes the fee (spendGbp is what actually left the pool).
        const newEntryPrice =
          pos.base_size > 0 && pos.entry_price
            ? (pos.entry_price * pos.base_size + spendGbp) / newBaseSize
            : spendGbp / approxBaseSize;
        const newPeak = Math.max(pos.peak_price || price, price);

        // Deduct spend from the shared pool.
        sharedCash -= spendGbp;
        await supabase
          .from("risk_state")
          .update({ shared_cash_gbp: sharedCash })
          .eq("id", 1);

        await supabase
          .from("trading_positions")
          .update({
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

    return res.status(200).json({ ok: true, haltedToday, totalCapitalNow, sharedCashPool: sharedCash, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
