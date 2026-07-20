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

  const token = buildJwt({ keyName, keySecret, method, path });

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

// List accounts (balances) — used to know what you actually hold
async function listAccounts() {
  const data = await cbRequest("GET", "/api/v3/brokerage/accounts");
  return data.accounts || [];
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

module.exports = { getSpotPrice, listAccounts, marketSell };
