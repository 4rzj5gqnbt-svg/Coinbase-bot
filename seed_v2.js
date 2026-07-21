// Run with `node seed_v2.js` after running schema_v2_adaptive.sql.
// EDIT the `cash_gbp` values below to however much you want dedicated to
// each coin. This is a hard cap — the bot will only ever spend up to this
// amount buying that specific coin, and proceeds from selling it are
// added back into this same pot (never shared with other coins).

require("dotenv").config();
const { getSupabase } = require("./lib/supabase");

const ALLOCATIONS = [
  { product_id: "BTC-GBP", base_currency: "BTC", cash_gbp: 2 },
  { product_id: "ETH-GBP", base_currency: "ETH", cash_gbp: 2 },
  { product_id: "SOL-GBP", base_currency: "SOL", cash_gbp: 2 },
  { product_id: "ADA-GBP", base_currency: "ADA", cash_gbp: 2 },
  { product_id: "ATOM-GBP", base_currency: "ATOM", cash_gbp: 2 },
  { product_id: "ALGO-GBP", base_currency: "ALGO", cash_gbp: 2 },
  { product_id: "XTZ-GBP", base_currency: "XTZ", cash_gbp: 2 },
];

async function main() {
  const supabase = getSupabase();

  for (const a of ALLOCATIONS) {
    const { error } = await supabase.from("trading_positions").upsert({
      product_id: a.product_id,
      base_currency: a.base_currency,
      cash_gbp: a.cash_gbp,
      base_size: 0,
      in_position: false,
      enabled: a.cash_gbp > 0, // no point enabling a coin with £0 allocated
    });
    if (error) {
      console.error(`Failed to seed ${a.product_id}:`, error);
    } else {
      console.log(`Seeded ${a.product_id} with £${a.cash_gbp} allocated${a.cash_gbp === 0 ? " (disabled — set an amount to enable)" : ""}`);
    }
  }

  const totalCapital = ALLOCATIONS.reduce((sum, a) => sum + a.cash_gbp, 0);
  await supabase.from("risk_state").update({
    day: new Date().toISOString().slice(0, 10),
    day_start_capital_gbp: totalCapital,
    trading_halted_today: false,
  }).eq("id", 1);
  console.log(`Total starting capital across all coins: £${totalCapital}`);
}

main().then(() => process.exit(0));
