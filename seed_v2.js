// Run with `node seed_v2.js` after running schema_v2_adaptive.sql.
//
// This version seeds the bot with your ACTUAL Coinbase holdings for each
// coin (not a separate empty cash pot) — so the bot starts by treating you
// as already "in a position" for whatever you currently hold, and its first
// decision is whether to SELL (per the momentum/mean-reversion sell rules).
// Once it sells, the proceeds land in that coin's own cash_gbp pot, ready
// to buy back in later when conditions say "low."
//
// Coins where you hold zero (or where you don't want the bot touching your
// holdings) can be left out of ENABLED_COINS below.

require("dotenv").config();
const { getSupabase } = require("./lib/supabase");
const { getSpotPrice, listAccounts, getCandles } = require("./lib/coinbase");
const { sma, isMovingAverageRising } = require("./lib/indicators");

// Which coins to hand over to the bot. Remove any you don't want it to
// touch (e.g. if you want to keep some holdings untouched manually).
const ENABLED_COINS = [
  { product_id: "BTC-GBP", base_currency: "BTC" },
  { product_id: "ETH-GBP", base_currency: "ETH" },
  { product_id: "SOL-GBP", base_currency: "SOL" },
  { product_id: "ADA-GBP", base_currency: "ADA" },
  { product_id: "ATOM-GBP", base_currency: "ATOM" },
  { product_id: "ALGO-GBP", base_currency: "ALGO" },
  { product_id: "XTZ-GBP", base_currency: "XTZ" },
];

// Optional: extra GBP to also allocate per coin on top of existing holdings,
// in case you want the bot able to buy MORE before it's sold anything.
// Leave at 0 to rely purely on "sell what I hold, then rebuy with proceeds."
const EXTRA_CASH_PER_COIN_GBP = 0;

async function main() {
  const supabase = getSupabase();
  const accounts = await listAccounts();

  let totalCapital = 0;

  for (const coin of ENABLED_COINS) {
    const account = accounts.find((a) => a.currency === coin.base_currency);
    const heldAmount = account ? parseFloat(account.available_balance.value) : 0;

    if (heldAmount <= 0) {
      console.log(`Skipping ${coin.product_id} — no available (unstaked) balance found.`);
      continue;
    }

    const price = await getSpotPrice(coin.product_id);
    const holdingValueGbp = heldAmount * price;
    totalCapital += holdingValueGbp + EXTRA_CASH_PER_COIN_GBP;

    // Determine which rule set (momentum vs mean-reversion) applies right
    // now, so the bot exits this holding using the correct sell rules from
    // its very first check rather than defaulting to one arbitrarily.
    const candles = await getCandles(coin.product_id, { granularity: "ONE_HOUR", candleCount: 210 });
    let regime = "MEAN_REVERSION";
    if (candles.length >= 60) {
      const ma50 = sma(candles, 50);
      const ma200 = sma(candles, Math.min(200, candles.length));
      const ma50Rising = isMovingAverageRising(candles, 50);
      if (ma200 !== null && price > ma200 && ma50Rising && ma50 > ma200) {
        regime = "MOMENTUM";
      }
    }

    const { error } = await supabase.from("trading_positions").upsert({
      product_id: coin.product_id,
      base_currency: coin.base_currency,
      cash_gbp: EXTRA_CASH_PER_COIN_GBP,
      base_size: heldAmount,
      in_position: true,           // bot treats this as an open position it can sell
      entry_price: price,          // reference point for mean-reversion take-profit/stop
      peak_price: price,           // reference point for momentum trailing stop
      last_regime: regime,
      enabled: true,
    });

    if (error) {
      console.error(`Failed to seed ${coin.product_id}:`, error);
    } else {
      console.log(
        `Seeded ${coin.product_id}: holding ${heldAmount} ${coin.base_currency} (~£${holdingValueGbp.toFixed(2)}) at £${price} [${regime}], plus £${EXTRA_CASH_PER_COIN_GBP} cash.`
      );
    }
  }

  await supabase
    .from("risk_state")
    .update({
      day: new Date().toISOString().slice(0, 10),
      day_start_capital_gbp: totalCapital,
      trading_halted_today: false,
    })
    .eq("id", 1);

  console.log(`Total starting capital across all coins: £${totalCapital.toFixed(2)}`);
}

main().then(() => process.exit(0));