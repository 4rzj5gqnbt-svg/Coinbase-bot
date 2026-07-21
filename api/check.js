const { getSpotPrice, listAccounts, marketSell, marketBuy, getCandles } = require("../lib/coinbase");
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

        // ============= ALREADY IN A POSITION: CHECK SELL CONDITIONS =============
        if (pos.in_position) {
          const newPeak = Math.max(pos.peak_price || pos.entry_price, price);
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
          }

          if (!shouldSell) {
            await logAndPush({
              action: "HOLD",
              status: "skipped",
              price,
              regime: pos.last_regime,
              reasoning: "No exit condition met.",
            });
            continue;
          }

          const order = await marketSell({
            productId: pos.product_id,
            baseSize: pos.base_size,
          });
          const proceedsGbp = pos.base_size * price;

          await supabase
            .from("trading_positions")
            .update({
              cash_gbp: pos.cash_gbp + proceedsGbp,
              base_size: 0,
              in_position: false,
              entry_price: null,
              peak_price: null,
              last_trade_at: new Date().toISOString(),
            })
            .eq("product_id", pos.product_id);

          await logAndPush({
            action: "SELL",
            status: "success",
            price,
            regime: pos.last_regime,
            amount_gbp: proceedsGbp,
            base_size: pos.base_size,
            coinbase_order_id: order?.order_id || order?.success_response?.order_id || null,
            reasoning,
            detail: JSON.stringify(order),
          });
          continue;
        }

        // ============= NOT IN A POSITION: CHECK BUY CONDITIONS =============

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

        if (regime === "MOMENTUM") {
          const priceMove = price - prevCandle.close;
          const brokeResistance = resistance !== null && price > resistance;
          const volumeSpike = avgVol !== null && currentVolume >= 1.5 * avgVol;
          const bigEnoughMove = atr1h !== null && priceMove >= 1.2 * atr1h;
          if (bigEnoughMove && volumeSpike && brokeResistance) {
            shouldBuy = true;
            reasoning = `Momentum breakout: +${priceMove.toFixed(4)} move (>=1.2x ATR ${atr1h.toFixed(4)}), volume ${currentVolume.toFixed(2)} >= 1.5x avg ${avgVol.toFixed(2)}, broke resistance ${resistance.toFixed(4)}.`;
          }
        } else {
          const priceDrop = prevCandle.close - price;
          const nearSupport = support !== null && price <= support * 1.01;
          const volumeSpike = avgVol !== null && currentVolume >= 1.5 * avgVol;
          const bigEnoughDrop = atr1h !== null && priceDrop >= 1.5 * atr1h;
          const oversold = rsi14 !== null && rsi14 <= 30;
          if (bigEnoughDrop && oversold && volumeSpike && nearSupport) {
            shouldBuy = true;
            reasoning = `Mean-reversion dip: -${priceDrop.toFixed(4)} drop (>=1.5x ATR ${atr1h.toFixed(4)}), RSI ${rsi14.toFixed(1)} <= 30, volume spike, near support ${support.toFixed(4)}.`;
          }
        }

        if (!shouldBuy) {
          await logAndPush({
            action: "HOLD",
            status: "skipped",
            price,
            regime,
            reasoning: "No entry condition met.",
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
        const approxBaseSize = spendGbp / price;

        await supabase
          .from("trading_positions")
          .update({
            cash_gbp: pos.cash_gbp - spendGbp,
            base_size: approxBaseSize,
            in_position: true,
            entry_price: price,
            peak_price: price,
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
          coinbase_order_id: order?.order_id || order?.success_response?.order_id || null,
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
