// Coinbase Advanced Trade API client.
// Uses CDP API key (organizations/{org_id}/apiKeys/{key_id}) + EC private key,
// per Coinbase's current JWT auth scheme. Verify against Coinbase's docs before
// relying on this in production — auth details have changed before and may again.

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const BASE_URL = "https://api.coinbase.com";

function buildJwt({ keyName, keySecret, method, path }) {
  const uri = `${method} api.coinbase.com${path}`;
  const payload = {
    iss: "cdp",
    nbf: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    sub: keyName,
    uri,
  };
  const header = {
    kid: keyName,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return jwt.sign(payload, keySecret, {
    algorithm: "ES256",
    header,
  });
}

async function cbRequest(method, path, body) {
  const keyName = process.env.COINBASE_KEY_NAME;
  const keySecret = process.env.COINBASE_KEY_SECRET.replace(/\\n/g, "\n");

  // Coinbase's JWT `uri` claim must be the path WITHOUT any query string,
  // even though the actual HTTP request does include the query string.
  const pathForSigning = path.split("?")[0];
  const token = buildJwt({ keyName, keySecret, method, path: pathForSigning });

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Coinbase API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Get current spot price for a product, e.g. "BTC-GBP"
async function getSpotPrice(productId) {
  const data = await cbRequest("GET", `/api/v3/brokerage/products/${productId}`);
  return parseFloat(data.price);
}

// List accounts (balances) — used to know what you actually hold.
// Coinbase paginates this endpoint; a real account can easily have 40-50+
// small "dust" wallets from old promos, so we must follow the cursor to
// make sure we actually reach BTC/ETH/etc. rather than stopping at
// whichever accounts happen to be on the first page.
async function listAccounts() {
  let allAccounts = [];
  let cursor = undefined;
  let hasNext = true;

  while (hasNext) {
    const query = new URLSearchParams({ limit: "250" });
    if (cursor) query.set("cursor", cursor);

    const data = await cbRequest("GET", `/api/v3/brokerage/accounts?${query.toString()}`);
    allAccounts = allAccounts.concat(data.accounts || []);
    hasNext = !!data.has_next;
    cursor = data.cursor;
    if (!cursor) hasNext = false; // safety net against an infinite loop
  }

  return allAccounts;
}

// Place a market sell order for a given base currency amount
async function marketSell({ productId, baseSize }) {
  const clientOrderId = crypto.randomUUID();
  const body = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: "SELL",
    order_configuration: {
      market_market_ioc: {
        base_size: String(baseSize),
      },
    },
  };
  return cbRequest("POST", "/api/v3/brokerage/orders", body);
}

// Get historical candles for indicator calculations.
// granularity: ONE_HOUR, FIVE_MINUTE, etc. Coinbase caps ~300 candles per call.
async function getCandles(productId, { granularity = "ONE_HOUR", candleCount = 210 } = {}) {
  const end = Math.floor(Date.now() / 1000);
  const secondsPerCandle = { ONE_HOUR: 3600, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900 }[granularity] || 3600;
  const start = end - secondsPerCandle * candleCount;

  const data = await cbRequest(
    "GET",
    `/api/v3/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`
  );

  // Coinbase returns newest-first; normalize to oldest-first for indicator math.
  const candles = (data.candles || [])
    .map((c) => ({
      time: Number(c.start),
      low: parseFloat(c.low),
      high: parseFloat(c.high),
      open: parseFloat(c.open),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }))
    .sort((a, b) => a.time - b.time);

  return candles;
}

// Place a market buy order spending a fixed GBP (quote currency) amount
async function marketBuy({ productId, quoteSize }) {
  const clientOrderId = crypto.randomUUID();
  const body = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: "BUY",
    order_configuration: {
      market_market_ioc: {
        quote_size: String(quoteSize.toFixed(2)),
      },
    },
  };
  return cbRequest("POST", "/api/v3/brokerage/orders", body);
}

module.exports = { getSpotPrice, listAccounts, marketSell, marketBuy, getCandles };
