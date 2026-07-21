const { getSpotPrice, listAccounts, marketSell } = require("../lib/coinbase");
const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  // Protect the endpoint so randoms on the internet can't trigger trades
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const supabase = getSupabase();
  const results = [];

  try {
    const { data: positions, error } = await supabase
      .from("positions")
      .select("*")
      .eq("enabled", true);

    if (error) throw error;

    const accounts = await listAccounts();

    for (const pos of positions) {
      try {
        const price = await getSpotPrice(pos.product_id);
        const newPeak = Math.max(pos.peak_price, price);
        const stopPrice = newPeak * (1 - pos.trailing_stop_pct / 100);
        const shouldSell = price <= stopPrice;

        await supabase
          .from("positions")
          .update({
            peak_price: newPeak,
            last_checked_at: new Date().toISOString(),
            previous_checked_price: pos.last_checked_price,
            last_checked_price: price,
            updated_at: new Date().toISOString(),
          })
          .eq("product_id", pos.product_id);

        if (!shouldSell) {
          results.push({ product_id: pos.product_id, price, peak: newPeak, action: "hold" });
          continue;
        }

        // Find available balance for this base currency
        const account = accounts.find(
          (a) => a.currency === pos.base_currency
        );
        const baseSize = account ? parseFloat(account.available_balance.value) : 0;

        if (!baseSize || baseSize <= 0) {
          await supabase.from("trade_log").insert({
            product_id: pos.product_id,
            action: "SELL",
            price,
            peak_price: newPeak,
            base_size: 0,
            status: "error",
            detail: "No available balance to sell (may be staked or already sold).",
          });
          results.push({ product_id: pos.product_id, action: "skip_no_balance" });
          continue;
        }

        const order = await marketSell({
          productId: pos.product_id,
          baseSize,
        });

        await supabase
          .from("positions")
          .update({ enabled: false }) // stop tracking after selling; re-enable manually to resume
          .eq("product_id", pos.product_id);

        await supabase.from("trade_log").insert({
          product_id: pos.product_id,
          action: "SELL",
          price,
          peak_price: newPeak,
          base_size: baseSize,
          coinbase_order_id: order?.order_id || order?.success_response?.order_id || null,
          status: "success",
          detail: JSON.stringify(order),
        });

        results.push({ product_id: pos.product_id, action: "sold", price, baseSize });
      } catch (innerErr) {
        await supabase.from("trade_log").insert({
          product_id: pos.product_id,
          action: "SELL",
          price: 0,
          peak_price: pos.peak_price,
          status: "error",
          detail: String(innerErr),
        });
        results.push({ product_id: pos.product_id, action: "error", error: String(innerErr) });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
