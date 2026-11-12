const {
  getSpotPrice,
  listAccounts,
  marketSell,
  getCandles,
  roundToIncrement,
  roundUpToIncrement,
  getProduct,
  getBestBidAsk,
  limitOrderPostOnly,
  getOrder,
  cancelOrders,
} = require("../lib/coinbase");
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
// Buys and profit-taking now use post-only LIMIT orders, which pay the lower
// maker fee. Stop-losses stay as MARKET orders so they always execute.
const COINBASE_MAKER_FEE_PCT = 0.006;
// A limit order that hasn't filled after this long is cancelled on the next
// run; the signal is re-checked from scratch after that.
const PENDING_ORDER_MAX_AGE_MS = 50 * 60 * 1000;
const TERMINAL_ORDER_STATUSES = ["FILLED", "CANCELLED", "EXPIRED", "FAILED"];
// Holdings worth less than this are treated as leftover dust, not a position.
const DUST_THRESHOLD_GBP = 0.05;
const MIN_PROFIT_AFTER_FEES_PCT = 0.03; // require >=3% gain before taking profit (covers the real ~2.4% round-trip fee plus a margin)
const MIN_TRADE_SIZE_GBP = 3; // minimum size for a new BUY

// Profit-taking (Nov 2026, change A). Previously the bot sold only the gain
// and only if that gain was worth £3+ — with £4–£22 holdings that almost never
// happened, so XTZ (+19%) and ADA (+7%) gave all their gains back. Now, the
// first time a profit-taking signal fires on a position, the bot sells HALF
// the coins. Coinbase fees are a percentage, so small sells are fine down to
// MIN_SELL_SIZE_GBP (or Coinbase's own minimum for the coin, if higher).
// After that, the remaining half is managed by the locked-in stop (change C).
const PROFIT_TAKE_FRACTION = 0.5;
const MIN_SELL_SIZE_GBP = 1;

// Shared cash pool model: one pot of GBP (stored in risk_state.shared_cash_gbp)
// funds buys of ANY coin, and profit-skims flow back into it.
// Change B (Nov 2026): one buy per coin until it's sold (no averaging down —
// ADA was bought 3 times on the way down and grew to over half the bot), and
// each buy is capped to a share of the WHOLE bot (cash + coins), not of
// whatever cash happens to be left: 30% for the main coins, 10% otherwise.
const COIN_CAP_PCT = { "BTC-GBP": 0.30, "ETH-GBP": 0.30, "ADA-GBP": 0.30 };
const COIN_CAP_PCT_DEFAULT = 0.10;

// Change C (Nov 2026): lock in gains. Once a coin is LOCK_TRIGGER_PCT above
// its buy price (or after half has been sold for profit), its stop moves up
// to LOCK_FLOOR_PCT above the buy price — enough to roughly cover the buy and
// sell fees — and from then on follows the price up (same swing-based
// distance as the normal stop), never down.
const LOCK_TRIGGER_PCT = 0.05;
const LOCK_FLOOR_PCT = 0.02;
const LOCK_MIN_RAISE_PCT = 0.005; // only move the stop when it rises by 0.5%+ (avoids hourly noise)
const DAILY_LOSS_LIMIT_PCT = 0.05; // 5%
const MOMENTUM_TRAILING_STOP_PCT = 0.025; // 2.5% below peak — profit-taking trigger only, never a full exit
const MEAN_REVERSION_TAKE_PROFIT_PCT = 0.04; // midpoint of 3-5%

// Wider, volatility-based stop-loss (Nov 2026). Replaces the fixed 2.5% stop,
// which sold BTC/ETH/ADA on ordinary dips that then recovered.
//  - Each position's stop is set from the coin's normal swing size:
//    5x the hourly ATR (roughly one day's typical move), kept between 4% and
//    10% below entry. It's saved once in trading_positions.stop_price so it
//    doesn't drift afterwards (reset whenever the entry price changes).
//  - It only fires once a completed hourly candle closes below the stop AND
//    the price is still below it — a brief dip/wick doesn't trigger a sale.
//  - Crash guard: if the price falls 1.5x the stop distance below entry, the
//    bot sells immediately without waiting for the hourly close.
const STOP_ATR_MULTIPLE = 5;
const STOP_MIN_PCT = 0.04;
const STOP_MAX_PCT = 0.10;
const STOP_FALLBACK_PCT = 0.06; // used when there's too little price history to measure swings
const STOP_EMERGENCY_MULTIPLE = 1.5;
// If a thinly traded coin has no completed candle in this long, the live
// price alone confirms the stop (there's no fresh hourly close to wait for).
const STALE_CANDLE_MS = 2 * 3600 * 1000;
// Buy and profit-taking signals need this much hourly history. Stop-losses
// are checked on held coins even when there's less (the XTZ gap, Nov 2026).
const MIN_CANDLES_FOR_SIGNALS = 60;

function stopPctFor(atr1h, price) {
  if (!atr1h || !price) return STOP_FALLBACK_PCT;
  return Math.min(STOP_MAX_PCT, Math.max(STOP_MIN_PCT, (STOP_ATR_MULTIPLE * atr1h) / price));
}

// Coinbase includes the current, still-forming hour as the newest candle.
// Return the newest candle whose hour has fully finished.
function lastCompletedCandle(candles, nowMs) {
  for (let i = candles.length - 1; i >= 0; i--) {
    if ((candles[i].time + 3600) * 1000 <= nowMs) return candles[i];
  }
  return null;
}

const fmt = (n) => (n === null || n === undefined ? "n/a" : String(+Number(n).toPrecision(6)));

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
    // Cash reserved for limit buys that haven't filled yet is still your
    // money — count it, or the daily-loss check would misread a reservation
    // as a loss.
    const reservedForPendingBuys = positions.reduce(
      (sum, p) => sum + (p.pending_order_id && p.pending_side === "BUY" ? parseFloat(p.pending_quote_gbp || 0) : 0),
      0
    );

    let { data: riskRows } = await supabase.from("risk_state").select("*").eq("id", 1);
    let risk = riskRows && riskRows[0];
    // Total capital = coins + shared cash pool + reserved cash. (Previously the
    // day's starting capital left out the cash pool, so the 5% daily loss
    // limit could effectively never trigger.)
    let totalCapitalNow =
      positionsValue + parseFloat((risk && risk.shared_cash_gbp) || 0) + reservedForPendingBuys;
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

        // ============= RESOLVE ANY LIMIT ORDER FROM AN EARLIER RUN =============
        const clearPending = {
          pending_order_id: null,
          pending_side: null,
          pending_base_size: null,
          pending_limit_price: null,
          pending_quote_gbp: null,
          pending_placed_at: null,
          pending_reasoning: null,
          pending_regime: null,
        };

        // Book whatever part of a finished limit order actually filled, using
        // Coinbase's real fill size, price and fee (not estimates).
        const applyFinishedOrder = async (order) => {
          const filledBase = parseFloat(order.filled_size || 0);
          const filledValue = parseFloat(order.filled_value || 0);
          const fees = parseFloat(order.total_fees || 0);
          const avgPrice =
            parseFloat(order.average_filled_price || 0) || parseFloat(pos.pending_limit_price || price);
          const partial = order.status !== "FILLED" ? " (partly filled before cancelling)" : "";
          const nowIso = new Date().toISOString();
          let update = { ...clearPending };

          if (pos.pending_side === "BUY") {
            const reserved = parseFloat(pos.pending_quote_gbp || 0);
            const cost = filledBase > 0 ? filledValue + fees : 0;
            sharedCash += reserved - cost; // hand back whatever part of the reservation wasn't spent
            if (filledBase > 0) {
              const newBase = (pos.base_size || 0) + filledBase;
              const newEntry =
                pos.base_size > 0 && pos.entry_price
                  ? (pos.entry_price * pos.base_size + cost) / newBase
                  : cost / filledBase;
              const newPeak = Math.max(pos.peak_price || avgPrice, avgPrice);
              const newRegime = pos.pending_regime || pos.last_regime;
              update = {
                ...update,
                base_size: newBase,
                in_position: true,
                entry_price: newEntry,
                peak_price: newPeak,
                last_regime: newRegime,
                last_trade_at: nowIso,
                // Entry changed — the stop is recalculated later this run.
                stop_price: null,
              };
              await logAndPush({
                action: "BUY",
                status: "success",
                price: avgPrice,
                regime: newRegime,
                amount_gbp: cost,
                base_size: filledBase,
                coinbase_order_id: pos.pending_order_id,
                reasoning: `${pos.pending_reasoning || ""} [limit buy filled${partial}: ${filledBase} at avg ${avgPrice}, maker fee £${fees.toFixed(4)}]`,
                detail: JSON.stringify(order),
              });
              Object.assign(pos, update);
            } else {
              await logAndPush({
                action: "BUY",
                status: "expired",
                price,
                regime: pos.pending_regime,
                coinbase_order_id: pos.pending_order_id,
                reasoning: `Limit buy at ${pos.pending_limit_price} was cancelled before it filled — £${reserved.toFixed(2)} back in the cash pool. The signal will be re-checked from scratch.`,
              });
            }
          } else {
            if (filledBase > 0) {
              const proceeds = filledValue - fees;
              sharedCash += proceeds;
              const remaining = Math.max(0, (pos.base_size || 0) - filledBase);
              const stillHolding = remaining * price > DUST_THRESHOLD_GBP;
              update = {
                ...update,
                base_size: stillHolding ? remaining : 0,
                in_position: stillHolding,
                // Keep the original cost basis for what's left after a skim.
                entry_price: stillHolding ? pos.entry_price : null,
                // Trailing stop measures the next climb from here.
                peak_price: stillHolding ? avgPrice : null,
                // Change C: after taking profit, the rest can't turn into a
                // loss — the stop is lifted to at least just above the buy price.
                stop_price: stillHolding
                  ? Math.max(pos.stop_price || 0, pos.entry_price * (1 + LOCK_FLOOR_PCT))
                  : null,
                last_trade_at: nowIso,
              };
              await logAndPush({
                action: "SELL",
                status: "success",
                price: avgPrice,
                regime: pos.pending_regime || pos.last_regime,
                amount_gbp: proceeds,
                base_size: filledBase,
                coinbase_order_id: pos.pending_order_id,
                reasoning: `${pos.pending_reasoning || ""} [limit sell filled${partial}: ${filledBase} at avg ${avgPrice}, maker fee £${fees.toFixed(4)}, kept ${remaining.toFixed(8)} invested]`,
                detail: JSON.stringify(order),
              });
              Object.assign(pos, update);
            } else {
              await logAndPush({
                action: "SELL",
                status: "expired",
                price,
                regime: pos.pending_regime || pos.last_regime,
                coinbase_order_id: pos.pending_order_id,
                reasoning: `Limit sell at ${pos.pending_limit_price} was cancelled before it filled. Coins stay invested; the signal will be re-checked.`,
              });
            }
          }

          await supabase.from("trading_positions").update(update).eq("product_id", pos.product_id);
          await supabase.from("risk_state").update({ shared_cash_gbp: sharedCash }).eq("id", 1);
          Object.assign(pos, clearPending);
        };

        // Check the open limit order; cancel it if it's too old (or when a
        // stop-loss needs the coins). Returns true if it's STILL open after.
        const resolvePendingOrder = async ({ forceCancel = false } = {}) => {
          if (!pos.pending_order_id) return false;
          let order = await getOrder(pos.pending_order_id);
          const ageMs = Date.now() - new Date(pos.pending_placed_at).getTime();
          if (!TERMINAL_ORDER_STATUSES.includes(order.status) && (forceCancel || ageMs > PENDING_ORDER_MAX_AGE_MS)) {
            await cancelOrders([pos.pending_order_id]);
            order = await getOrder(pos.pending_order_id);
          }
          if (!TERMINAL_ORDER_STATUSES.includes(order.status)) {
            if (ageMs > 6 * 3600 * 1000) {
              await logAndPush({
                action: "ERROR",
                status: "error",
                price,
                detail: `Limit order ${pos.pending_order_id} still not finished after ${(ageMs / 3600000).toFixed(1)}h (status ${order.status}) — check it in Coinbase.`,
              });
            }
            return true;
          }
          await applyFinishedOrder(order);
          return false;
        };

        // While a coin has (or just had) a limit order, its Coinbase balance is
        // partly on hold or just changed, so we don't reconcile it or place new
        // orders for it this run. Only a stop-loss may still act.
        const hadPendingOrder = !!pos.pending_order_id;
        let pendingOpen = hadPendingOrder ? await resolvePendingOrder() : false;

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

        if (balanceMismatch && !hadPendingOrder) {
          const wasInPosition = pos.in_position;
          pos.base_size = actualBalance;
          pos.in_position = actualBalance > 0;
          if (actualBalance > 0 && !wasInPosition) {
            // We now hold this coin but the bot didn't know — likely a
            // manual buy. We don't know your real purchase price, so use
            // the current price as a starting reference point.
            pos.entry_price = price;
            pos.peak_price = price;
            pos.stop_price = null; // recalculated from the new entry below
          } else if (actualBalance <= 0) {
            pos.entry_price = null;
            pos.peak_price = null;
            pos.stop_price = null;
          }

          await supabase
            .from("trading_positions")
            .update({
              base_size: pos.base_size,
              in_position: pos.in_position,
              entry_price: pos.entry_price,
              peak_price: pos.peak_price,
              stop_price: pos.stop_price ?? null,
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

        // Thinly traded coins (e.g. XTZ) can return too few hourly candles
        // for buy/profit signals. Previously the bot then skipped the coin
        // entirely — including its stop-loss — so a held coin went
        // unprotected. Now: not held → skip as before; held → still check
        // the stop-loss (buy and profit-taking checks are skipped).
        const thinHistory = candles.length < MIN_CANDLES_FOR_SIGNALS;
        const holdsCoin = (pos.base_size || 0) * price > DUST_THRESHOLD_GBP;
        if (thinHistory && !holdsCoin) {
          await supabase
            .from("trading_positions")
            .update({ last_checked_at: new Date().toISOString(), last_checked_price: price })
            .eq("product_id", pos.product_id);
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            reasoning: `Only ${candles.length} hourly candles available (need ${MIN_CANDLES_FOR_SIGNALS}) — no buy checks this run.`,
            detail: "Not enough candle history yet for reliable indicators.",
          });
          continue;
        }

        const ma50 = sma(candles, 50);
        const ma200 = sma(candles, Math.min(200, candles.length));
        const ma50Rising = isMovingAverageRising(candles, 50);
        const rsi14 = rsi(candles, 14);
        const atr1h = atr(candles, 14); // needs only 15 candles, so usually available even when thin
        const avgVol = averageVolume(candles, 20);
        const resistance = recentResistance(candles, 20);
        const support = recentSupport(candles, 20);
        const lastCandle = candles[candles.length - 1] || null;
        const prevCandle = candles[candles.length - 2] || null;
        const currentVolume = lastCandle ? lastCandle.volume : 0;

        const regime = thinHistory
          ? pos.last_regime || "MEAN_REVERSION"
          : ma200 !== null && price > ma200 && ma50Rising && ma50 > ma200
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
        // (DUST_THRESHOLD_GBP is defined at the top of the file.)
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
          let stopNote = "";

          // ---- Protective stop-loss (both regimes) ----
          // Set this position's stop once: after a new buy, a manual buy the
          // bot picked up, or for positions opened before Nov 2026.
          if (!pos.stop_price && pos.entry_price) {
            const pct = stopPctFor(atr1h, price);
            pos.stop_price = pos.entry_price * (1 - pct);
            await supabase
              .from("trading_positions")
              .update({ stop_price: pos.stop_price })
              .eq("product_id", pos.product_id);
            await logAndPush({
              action: "STOP_SET",
              status: "success",
              price,
              regime: pos.last_regime,
              reasoning: `Stop-loss set at ${fmt(pos.stop_price)}: ${(pct * 100).toFixed(1)}% below entry ${fmt(pos.entry_price)} (${atr1h ? `5x hourly swing of ${fmt(atr1h)}, kept within ${STOP_MIN_PCT * 100}–${STOP_MAX_PCT * 100}%` : `fallback ${STOP_FALLBACK_PCT * 100}% — not enough history to measure swings`}). Crash guard at ${fmt(pos.entry_price - STOP_EMERGENCY_MULTIPLE * (pos.entry_price - pos.stop_price))}.`,
            });
          }

          // ---- Change C: lock in gains ----
          // Once the coin is 5%+ above the buy price (or the stop is already
          // locked above it), lift the stop to at least 2% above the buy price
          // and let it follow the price up — never down.
          if (pos.stop_price && pos.entry_price) {
            const alreadyLocked = pos.stop_price >= pos.entry_price;
            const gainNow = (price - pos.entry_price) / pos.entry_price;
            if (alreadyLocked || gainNow >= LOCK_TRIGGER_PCT) {
              const trailPct = stopPctFor(atr1h, price);
              const candidate = Math.max(pos.entry_price * (1 + LOCK_FLOOR_PCT), price * (1 - trailPct));
              if (candidate > pos.stop_price * (1 + LOCK_MIN_RAISE_PCT) && candidate < price) {
                const oldStop = pos.stop_price;
                pos.stop_price = candidate;
                await supabase
                  .from("trading_positions")
                  .update({ stop_price: pos.stop_price })
                  .eq("product_id", pos.product_id);
                await logAndPush({
                  action: "STOP_SET",
                  status: "success",
                  price,
                  regime: pos.last_regime,
                  reasoning: `Stop raised to lock in gains: ${fmt(oldStop)} → ${fmt(pos.stop_price)} (price ${price} is ${(gainNow * 100).toFixed(1)}% above entry ${fmt(pos.entry_price)}; stop never goes below ${LOCK_FLOOR_PCT * 100}% above entry, then follows the price up ${(trailPct * 100).toFixed(1)}% behind).`,
                });
              }
            }
          }

          if (pos.stop_price && pos.entry_price) {
            const stopPrice = pos.stop_price;
            const stopPctBelow = ((pos.entry_price - stopPrice) / pos.entry_price) * 100;
            const lockedGain = stopPrice >= pos.entry_price;
            // Crash guard sits half a stop-distance below the stop. For a
            // normal stop that's the same as before (1.5x the distance below
            // entry); for a locked-in stop the distance is the coin's swing size.
            const crashPrice = lockedGain
              ? stopPrice * (1 - (STOP_EMERGENCY_MULTIPLE - 1) * stopPctFor(atr1h, price))
              : pos.entry_price - STOP_EMERGENCY_MULTIPLE * (pos.entry_price - stopPrice);
            const stopDesc = lockedGain
              ? `locked-in stop ${fmt(stopPrice)}, ${(-stopPctBelow).toFixed(1)}% above entry ${fmt(pos.entry_price)}`
              : `stop ${fmt(stopPrice)}, ${stopPctBelow.toFixed(1)}% below entry ${fmt(pos.entry_price)}`;
            const nowMs = Date.now();
            const closed = lastCompletedCandle(candles, nowMs);
            const closedIsStale = !closed || nowMs - (closed.time + 3600) * 1000 > STALE_CANDLE_MS;

            if (price <= crashPrice) {
              shouldSell = true;
              isProtectiveExit = true;
              reasoning = `Crash guard: price ${price} fell past ${fmt(crashPrice)} (${stopDesc}) — selling now without waiting for the hourly close.`;
            } else if (price <= stopPrice && (closedIsStale || closed.close <= stopPrice)) {
              shouldSell = true;
              isProtectiveExit = true;
              const why = lockedGain ? "selling to keep the gain" : "closing to protect capital";
              reasoning = closedIsStale
                ? `Stop-loss: price ${price} <= ${stopDesc}; no recent hourly candle for this thinly traded coin, so the live price confirms it — ${why}.`
                : `Stop-loss: hourly candle closed at ${closed.close} <= ${stopDesc}, and price ${price} is still below — ${why}.`;
            } else if (price <= stopPrice) {
              stopNote = ` Price ${price} is below the stop ${fmt(stopPrice)} — waiting for an hourly close below it before selling.`;
            } else {
              stopNote = ` Stop ${fmt(stopPrice)}.`;
            }
          }

          // ---- Profit-taking signals (need full price history) ----
          // Change A: half is sold the first time; after that the remaining
          // half rides the locked-in stop instead of being sold off in slices.
          // "First time" = no successful sell of this coin since its last buy.
          let profitAlreadyTaken = false;
          if (!shouldSell && !thinHistory) {
            const { data: lastTrades } = await supabase
              .from("trading_log")
              .select("action")
              .eq("product_id", pos.product_id)
              .in("action", ["BUY", "SELL"])
              .eq("status", "success")
              .order("created_at", { ascending: false })
              .limit(1);
            profitAlreadyTaken = !!(lastTrades && lastTrades[0] && lastTrades[0].action === "SELL");
          }
          if (!shouldSell && !thinHistory && !profitAlreadyTaken) {
            if (pos.last_regime === "MOMENTUM") {
              const trailPrice = newPeak * (1 - MOMENTUM_TRAILING_STOP_PCT);
              const momentumWeakening = rsi14 >= 75 && prevCandle && price < prevCandle.close;
              if (price <= trailPrice) {
                shouldSell = true;
                reasoning = `Momentum trailing stop: price ${price} <= ${trailPrice.toFixed(4)} (2.5% below peak ${newPeak}) — taking profit, keeping principal.`;
              } else if (momentumWeakening) {
                shouldSell = true;
                reasoning = `RSI overbought (${rsi14.toFixed(1)}) and price weakening — taking profit, keeping principal.`;
              }
            } else {
              const takeProfitPrice = pos.entry_price * (1 + MEAN_REVERSION_TAKE_PROFIT_PCT);
              if (price >= takeProfitPrice) {
                shouldSell = true;
                reasoning = `Take-profit hit: price ${price} >= ${takeProfitPrice.toFixed(4)} (+${(MEAN_REVERSION_TAKE_PROFIT_PCT * 100).toFixed(1)}% from entry) — taking profit, keeping principal.`;
              } else if (rsi14 !== null && rsi14 >= 60) {
                shouldSell = true;
                reasoning = `RSI back to neutral/overbought (${rsi14.toFixed(1)}) — taking profit, keeping principal.`;
              }
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
              reasoning: thinHistory
                ? `No exit condition met.${stopNote} (Only ${candles.length} hourly candles — stop-loss checked, profit-taking and buys skipped.)`
                : profitAlreadyTaken
                  ? `No exit condition met.${stopNote} (Half already sold for profit — the rest exits via the locked-in stop.)`
                  : `No exit condition met.${stopNote}`,
            });
          } else if (!isProtectiveExit && hadPendingOrder) {
            // A limit order for this coin is open or only just finished —
            // its balance is in flux, so wait for the next run before
            // placing another profit-taking order.
            await logAndPush({
              action: "SELL",
              status: "skipped",
              price,
              regime: pos.last_regime,
              reasoning: `${reasoning} [waiting: a limit order for this coin is open or just finished — re-checking next run]`,
            });
          } else if (isProtectiveExit) {
            // ---------- STOP-LOSS: always a MARKET order ----------
            // If a limit order is still open it may be holding the coins, so
            // cancel it first and book any part that filled.
            let available = actualBalance;
            if (pendingOpen) {
              pendingOpen = await resolvePendingOrder({ forceCancel: true });
            }
            if (pendingOpen) {
              await logAndPush({
                action: "SELL",
                status: "error",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [full exit (stop-loss)]`,
                detail: "Stop-loss waiting: couldn't cancel the open limit order yet — will retry next run.",
              });
              continue;
            }
            if (hadPendingOrder) {
              // Balance changed during this run — fetch it fresh.
              const fresh = (await listAccounts()).find((a) => a.currency === pos.base_currency);
              available = fresh ? parseFloat(fresh.available_balance.value) : 0;
            }

            // Never ask Coinbase to sell more than is actually available.
            // The bot's ledger can run slightly ahead of reality, and a full
            // stop-loss sell of the ledger amount was being rejected with
            // INSUFFICIENT_FUND every hour — so the stop-loss never fired.
            const product = await getProduct(pos.product_id);
            const baseIncrement = parseFloat(product.base_increment);
            const sellBaseSize = roundToIncrement(Math.min(pos.base_size, available), baseIncrement);
            const sellType = "full exit (stop-loss — protecting capital)";

            if (sellBaseSize <= 0) {
              await logAndPush({
                action: "SELL",
                status: "skipped",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [nothing available to sell at this coin's order precision]`,
              });
            } else {
              const order = await marketSell({ productId: pos.product_id, baseSize: sellBaseSize });

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
                // Market orders pay the taker fee out of the GBP proceeds.
                const proceedsGbp = sellBaseSize * price * (1 - COINBASE_TAKER_FEE_PCT);
                const remainingBaseSize = Math.max(0, Math.min(pos.base_size, available) - sellBaseSize);
                const stillHolding = remainingBaseSize * price > DUST_THRESHOLD_GBP;
                sharedCash += proceedsGbp;

                await supabase
                  .from("trading_positions")
                  .update({
                    base_size: stillHolding ? remainingBaseSize : 0,
                    in_position: stillHolding,
                    entry_price: stillHolding ? pos.entry_price : null,
                    peak_price: stillHolding ? price : null,
                    stop_price: stillHolding ? pos.stop_price : null,
                    last_trade_at: new Date().toISOString(),
                  })
                  .eq("product_id", pos.product_id);
                await supabase.from("risk_state").update({ shared_cash_gbp: sharedCash }).eq("id", 1);

                pos.base_size = stillHolding ? remainingBaseSize : 0;
                pos.in_position = stillHolding;
                if (!stillHolding) pos.stop_price = null;

                await logAndPush({
                  action: "SELL",
                  status: "success",
                  price,
                  regime: pos.last_regime,
                  amount_gbp: proceedsGbp,
                  base_size: sellBaseSize,
                  coinbase_order_id: order?.success_response?.order_id || null,
                  reasoning: `${reasoning} [${sellType}, market order — sold ${sellBaseSize.toFixed(8)}, kept ${remainingBaseSize.toFixed(8)}]`,
                  detail: JSON.stringify(order),
                });
                sellExecutedThisCycle = true;
              }
            }
          } else {
            // ---------- PROFIT-TAKING: post-only LIMIT order (maker fee) ----------
            // Change A: sell half the position (once); the rest stays invested
            // behind a locked-in stop.
            const product = await getProduct(pos.product_id);
            const baseIncrement = parseFloat(product.base_increment);
            const priceIncrement = parseFloat(product.price_increment || product.quote_increment);
            const baseMin = parseFloat(product.base_min_size || 0);
            const minSellGbp = Math.max(MIN_SELL_SIZE_GBP, parseFloat(product.quote_min_size || 0));
            const sellBaseSize = roundToIncrement(
              Math.min(pos.base_size * PROFIT_TAKE_FRACTION, actualBalance),
              baseIncrement
            );

            if (sellBaseSize * price < minSellGbp) {
              await logAndPush({
                action: "SELL",
                status: "skipped",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [half the holding (£${(sellBaseSize * price).toFixed(2)}) is below the £${minSellGbp.toFixed(2)} minimum sell size — holding]`,
              });
            } else if (sellBaseSize <= 0 || sellBaseSize < baseMin) {
              await logAndPush({
                action: "SELL",
                status: "skipped",
                price,
                regime: pos.last_regime,
                reasoning: `${reasoning} [half the holding is below Coinbase's minimum order size for this coin — holding]`,
              });
            } else {
              // Sit at the best ask (the lowest current seller) so the order
              // rests on the book and pays the maker fee.
              const { ask } = await getBestBidAsk(pos.product_id);
              const limitPrice = roundUpToIncrement(ask || price, priceIncrement);
              const order = await limitOrderPostOnly({
                productId: pos.product_id,
                side: "SELL",
                baseSize: sellBaseSize,
                limitPrice,
                baseIncrement,
                priceIncrement,
              });

              if (order.success === false) {
                await logAndPush({
                  action: "SELL",
                  status: "error",
                  price,
                  regime: pos.last_regime,
                  reasoning: `${reasoning} [profit-take (half), limit order]`,
                  detail: `Limit order rejected by Coinbase, position left unchanged: ${JSON.stringify(order.error_response || order)}`,
                });
              } else {
                const orderId = order?.success_response?.order_id || null;
                const pendingFields = {
                  pending_order_id: orderId,
                  pending_side: "SELL",
                  pending_base_size: sellBaseSize,
                  pending_limit_price: limitPrice,
                  pending_quote_gbp: 0,
                  pending_placed_at: new Date().toISOString(),
                  pending_reasoning: `${reasoning} [profit-take: selling half, the rest stays invested behind a locked-in stop]`,
                  pending_regime: pos.last_regime,
                };
                // If the bot can't record the order, cancel it — an order the
                // bot doesn't know about could be placed twice.
                const { error: saveErr } = await supabase
                  .from("trading_positions")
                  .update(pendingFields)
                  .eq("product_id", pos.product_id);
                if (saveErr) {
                  await cancelOrders([orderId]);
                  await logAndPush({
                    action: "ERROR",
                    status: "error",
                    price,
                    detail: `Couldn't record limit sell ${orderId} in the database (${saveErr.message}) — cancelled it to be safe.`,
                  });
                  continue;
                }
                Object.assign(pos, pendingFields);
                await logAndPush({
                  action: "SELL",
                  status: "pending",
                  price: limitPrice,
                  regime: pos.last_regime,
                  base_size: sellBaseSize,
                  coinbase_order_id: orderId,
                  reasoning: `${reasoning} [limit sell placed: ${sellBaseSize} at ${limitPrice} — books when it fills, cancelled if not filled within ~1 hour]`,
                  detail: JSON.stringify(order),
                });
                sellExecutedThisCycle = true; // don't also try to buy this coin in the same run
              }
            }
          }
        }

        // ============= CHECK BUY CONDITIONS =============
        // Change B: one buy per coin until it's sold — no adding to a coin
        // already held (averaging down). Also skipped if we just sold this
        // same coin this cycle.
        if (sellExecutedThisCycle) {
          continue;
        }
        if (hasMeaningfulHolding && pos.base_size > 0) {
          continue; // already holding — the HOLD row above covers this run
        }
        // Too little price history for buy signals — the stop-loss check
        // above was all this coin needed this run.
        if (thinHistory) {
          continue;
        }
        if (hadPendingOrder) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: pendingOpen
              ? "Limit order still open for this coin — waiting for it to fill or be cancelled."
              : "Limit order for this coin just finished — buy checks resume next run.",
          });
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
          // Change D (Nov 2026): downtrend filter. Don't buy dips while the coin
          // is in a clear downtrend — below its 200-hour average AND its
          // 50-hour average still falling. Every dip-buy in early Nov (ADA x3,
          // ETH) was made in a falling market and ended at a loss.
          const inDowntrend =
            candles.length >= 200 && ma200 !== null && price < ma200 && !ma50Rising;
          if (bigEnoughDrop && oversold && volumeSpike && nearSupport) {
            if (inDowntrend) {
              await logAndPush({
                action: "SKIP",
                status: "skipped",
                price,
                regime,
                reasoning: `Dip-buy signal ignored — downtrend filter: price ${price} is below its 200-hour average ${ma200.toFixed(4)} and the 50-hour average is still falling.`,
              });
              continue;
            }
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

        // Size against the same stop distance this position will get.
        const stopDistancePct = stopPctFor(atr1h, price);
        const maxRiskGbp = RISK_PER_TRADE_PCT * totalCapitalNow;
        const riskBasedSizeGbp = stopDistancePct > 0 ? maxRiskGbp / stopDistancePct : sharedCash;
        // Change B: per-coin cap as a share of the WHOLE bot (cash + coins):
        // 30% for main coins, 10% otherwise.
        const capPct = COIN_CAP_PCT[pos.product_id] || COIN_CAP_PCT_DEFAULT;
        const capGbp = totalCapitalNow * capPct;
        const spendGbp = Math.min(sharedCash, riskBasedSizeGbp, capGbp);

        if (spendGbp < MIN_TRADE_SIZE_GBP) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Position size after the ${(capPct * 100).toFixed(0)}%-of-bot cap (£${capGbp.toFixed(2)}) and risk sizing is under the £${MIN_TRADE_SIZE_GBP} minimum (cash £${sharedCash.toFixed(2)}) — skipping.`,
          });
          continue;
        }

        // ---------- BUY: post-only LIMIT order at the best bid (maker fee) ----------
        const product = await getProduct(pos.product_id);
        const baseIncrement = parseFloat(product.base_increment);
        const priceIncrement = parseFloat(product.price_increment || product.quote_increment);
        const baseMin = parseFloat(product.base_min_size || 0);
        const { bid } = await getBestBidAsk(pos.product_id);
        const limitPrice = roundToIncrement(bid || price, priceIncrement);
        // Size the order so coins + maker fee fit inside the spend budget.
        const buyBaseSize = roundToIncrement(spendGbp / (limitPrice * (1 + COINBASE_MAKER_FEE_PCT)), baseIncrement);
        const reserveGbp = buyBaseSize * limitPrice * (1 + COINBASE_MAKER_FEE_PCT);

        if (buyBaseSize <= 0 || buyBaseSize < baseMin) {
          await logAndPush({
            action: "SKIP",
            status: "skipped",
            price,
            regime,
            reasoning: `Buy signal, but £${spendGbp.toFixed(2)} is below Coinbase's minimum order size for this coin — skipping. Signal was: ${reasoning}`,
          });
          continue;
        }

        const order = await limitOrderPostOnly({
          productId: pos.product_id,
          side: "BUY",
          baseSize: buyBaseSize,
          limitPrice,
          baseIncrement,
          priceIncrement,
        });

        if (order.success === false) {
          await logAndPush({
            action: "BUY",
            status: "error",
            price,
            regime,
            reasoning,
            detail: `Limit order rejected by Coinbase, no cash was spent: ${JSON.stringify(order.error_response || order)}`,
          });
          continue; // nothing placed, nothing reserved
        }

        const orderId = order?.success_response?.order_id || null;
        const pendingFields = {
          pending_order_id: orderId,
          pending_side: "BUY",
          pending_base_size: buyBaseSize,
          pending_limit_price: limitPrice,
          pending_quote_gbp: reserveGbp,
          pending_placed_at: new Date().toISOString(),
          pending_reasoning: reasoning,
          pending_regime: regime,
        };
        // If the bot can't record the order, cancel it — an order the bot
        // doesn't know about could be placed twice.
        const { error: saveErr } = await supabase
          .from("trading_positions")
          .update(pendingFields)
          .eq("product_id", pos.product_id);
        if (saveErr) {
          await cancelOrders([orderId]);
          await logAndPush({
            action: "ERROR",
            status: "error",
            price,
            detail: `Couldn't record limit buy ${orderId} in the database (${saveErr.message}) — cancelled it to be safe.`,
          });
          continue;
        }
        Object.assign(pos, pendingFields);

        // Reserve the cash now (Coinbase holds it while the order is open);
        // whatever isn't spent goes back into the pool when the order finishes.
        sharedCash -= reserveGbp;
        await supabase.from("risk_state").update({ shared_cash_gbp: sharedCash }).eq("id", 1);

        await logAndPush({
          action: "BUY",
          status: "pending",
          price: limitPrice,
          regime,
          amount_gbp: reserveGbp,
          base_size: buyBaseSize,
          coinbase_order_id: orderId,
          reasoning: `${reasoning} [limit buy placed: ${buyBaseSize} at ${limitPrice} (£${reserveGbp.toFixed(2)} reserved) — books when it fills, cancelled if not filled within ~1 hour]`,
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
