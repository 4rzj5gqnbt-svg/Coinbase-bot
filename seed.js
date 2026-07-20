// Run once with `node seed.js` after setting up .env and the Supabase schema.
// Edit the PRODUCTS list to match what you actually want the bot to watch.

require("dotenv").config();
const { getSupabase } = require("./lib/supabase");
const { getSpotPrice } = require("./lib/coinbase");

// Coinbase product IDs (base-quote). Adjust quote currency if you don't trade in GBP.
const PRODUCTS = [
  { product_id: "BTC-GBP", base_currency: "BTC" },
  { product_id: "ETH-GBP", base_currency: "ETH" },
  { product_id: "SOL-GBP", base_currency: "SOL" },
  { product_id: "ADA-GBP", base_currency: "ADA" },
  { product_id: "ATOM-GBP", base_currency: "ATOM" }, // Cosmos
  { product_id: "ALGO-GBP", base_currency: "ALGO" }, // Algorand
  { product_id: "XTZ-GBP", base_currency: "XTZ" },   // Tezos
  // Not included:
  // - USDS: a stablecoin, designed to stay near a fixed value — a 5%
  //   trailing stop doesn't make sense for it.
  // - Green Satoshi Token (GST): not listed on Coinbase Advanced Trade,
  //   so there's no product_id to track it with.
  //
  // Note: ETH/SOL/ADA/ATOM/XTZ show as partly or fully staked in your app.
  // Staked balance won't be in "available_balance" and can't be sold until
  // unstaked, so the bot will simply have nothing to sell for those portions.
];

const TRAILING_STOP_PCT = 5;

async function main() {
  const supabase = getSupabase();

  for (const p of PRODUCTS) {
    const price = await getSpotPrice(p.product_id);
    const { error } = await supabase.from("positions").upsert({
      product_id: p.product_id,
      base_currency: p.base_currency,
      peak_price: price,
      trailing_stop_pct: TRAILING_STOP_PCT,
      enabled: true,
      last_checked_at: new Date().toISOString(),
      last_checked_price: price,
    });
    if (error) {
      console.error(`Failed to seed ${p.product_id}:`, error);
    } else {
      console.log(`Seeded ${p.product_id} at peak price ${price}`);
    }
  }
}

main().then(() => process.exit(0));