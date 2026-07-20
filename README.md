# Crypto Trailing-Stop Bot

Runs on Vercel's scheduler (no laptop/server of yours needs to stay on).
Every 15 minutes it checks the price of each tracked coin; if price has
fallen more than X% (default 5%) from the highest price seen since you
started tracking it, it sells your available (non-staked) balance via
Coinbase's Advanced Trade API.

## Why trailing stop instead of flat ±5%

A flat "sell at +5%" caps every winner at a small gain and ignores trend.
A trailing stop lets a position run while price is climbing, and only
sells once it has pulled back 5% from its peak — closer to "protect
gains" than "guess a ceiling." It's still a simple rule, not a guarantee
of good outcomes — crypto can gap through any stop level, and Coinbase
market orders can fill at worse prices during fast moves.

## What this does NOT do

- It does not buy anything — sell-side only, as you described.
- It cannot sell staked balances. Your Ethereum, Solana, Cardano, Cosmos,
  and Tezos holdings show as partly/fully staked in your app — the bot
  only acts on `available_balance`, so staked portions are simply
  untouched until you unstake them manually.
- It is not tax software. Every sale is a disposal for capital gains tax
  purposes in the UK — keep the `trade_log` table for your records and
  talk to an accountant.

## Setup

### 1. Coinbase API key

In Coinbase Developer Platform (not the consumer app), create an API key
with **trade** permission (not withdraw). You'll get:
- a key name like `organizations/{org_id}/apiKeys/{key_id}`
- an EC private key (PEM format)

### 2. Supabase

Create a free Supabase project. In the SQL editor, run `schema.sql` from
this repo. Grab your project URL and **service role key** (Settings → API).

### 3. Environment variables

Create `.env` locally (for seeding) and add the same vars in Vercel's
project settings (Settings → Environment Variables):

```
COINBASE_KEY_NAME=organizations/xxx/apiKeys/xxx
COINBASE_KEY_SECRET="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxx
CRON_SECRET=<generate a random string, e.g. `openssl rand -hex 32`>
```

Setting `CRON_SECRET` in Vercel automatically makes Vercel Cron send it as
a Bearer token when it calls your endpoint — that's what `api/check.js`
checks against.

### 4. Install and seed

```bash
npm install
node seed.js
```

Edit `PRODUCTS` in `seed.js` first if you want different coins or a
different trailing-stop percentage per coin.

### 5. Deploy

Push this folder to a GitHub repo and import it in Vercel, or run
`vercel deploy` from inside the folder. Vercel will pick up `vercel.json`
and start running `/api/check` every 15 minutes automatically.

### 6. Test before trusting it with real money

- Try it first with a trailing_stop_pct set high (e.g. 50) so it's very
  unlikely to fire, and watch `trade_log` / `positions.last_checked_price`
  update correctly for a day.
- Coinbase does not have a free sandbox for Advanced Trade — consider
  testing logic against a tiny balance (a few pounds of one coin) before
  scaling up.

## Adjusting the strategy

- `trailing_stop_pct` is per-row in the `positions` table — you can set
  tighter stops on volatile small-caps and looser ones on BTC/ETH if you
  want.
- To re-arm a position after it sells, set `enabled = true` and
  `peak_price` = current price in Supabase.
- To pause everything, set `enabled = false` on all rows, or just remove
  the cron in `vercel.json`.
