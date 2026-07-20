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

## Scheduling: GitHub Actions instead of Vercel Cron

Vercel's free Hobby plan only allows once-a-day cron jobs. Instead, this
repo uses a **GitHub Actions workflow** (`.github/workflows/check.yml`)
to call your Vercel endpoint every 5 minutes for free. Vercel still hosts
and runs `/api/check` — GitHub Actions is just the "alarm clock" that
calls it on a schedule.

### Enabling it

1. Push this repo to GitHub (if you haven't already).
2. In the GitHub repo: Settings → Secrets and variables → Actions → **New
   repository secret**. Add two secrets:
   - `CHECK_ENDPOINT_URL` — your deployed endpoint, e.g.
     `https://your-project.vercel.app/api/check`
   - `CRON_SECRET` — the exact same value you set in Vercel's environment
     variables
3. That's it — GitHub will start running the workflow every 5 minutes
   automatically. You can also trigger it manually any time from the
   repo's **Actions** tab → "Check trailing stops" → **Run workflow**.

Note: GitHub's schedule is best-effort, not exact — under heavy platform
load it can occasionally run a few minutes late. Fine for this use case.

## Dashboard

`public/dashboard.html` is a simple read-only web page showing:
- Every tracked position (peak price, last price, stop level, when last checked)
- A full trade history table (every sell attempt, success or error, with detail)

It's a static page — once you deploy it as part of this Vercel project, it's
reachable at `https://your-project.vercel.app/dashboard.html` from your
phone or any browser, no login needed.

### Setup

1. Open `public/dashboard.html` and replace these two placeholders near the
   bottom of the file:
   ```js
   const SUPABASE_URL = "REPLACE_WITH_YOUR_SUPABASE_URL";
   const SUPABASE_ANON_KEY = "REPLACE_WITH_YOUR_SUPABASE_ANON_KEY";
   ```
   Use your **Project URL** (same as `SUPABASE_URL` elsewhere) and the
   **anon / public** key (NOT the service_role key — the anon key is
   designed to be safely exposed in browser code, unlike service_role).
   Find it in Supabase: Settings → API Keys → API Keys tab (or Legacy API
   Keys tab, labeled `anon` `public`).

2. Run the updated `schema.sql` in Supabase's SQL editor again — it now
   also adds two read-only security policies so this page can view (but
   never modify) your `positions` and `trade_log` tables using the public
   key.

3. Push and redeploy — the page will be live at `/dashboard.html` on your
   existing Vercel domain.

Since this uses the anon key with read-only policies, it's safe to visit
from any device — it cannot place trades, change settings, or modify
data, only display it.

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