-- Run this in the Supabase SQL editor.
-- This REPLACES the simple trailing-stop schema with the adaptive
-- regime-based engine's state tracking.

create table if not exists trading_positions (
  product_id text primary key,          -- e.g. 'BTC-GBP'
  base_currency text not null,          -- e.g. 'BTC'
  enabled boolean not null default true,

  -- Dedicated capital pot for this coin only. Proceeds from selling this
  -- coin go back into `cash_gbp` for this SAME row only — never shared
  -- with other coins' pots.
  cash_gbp numeric not null default 0,      -- GBP currently sitting uninvested, available to buy this coin
  base_size numeric not null default 0,     -- how much of the coin the bot currently holds (bot-managed only)

  in_position boolean not null default false,
  entry_price numeric,                      -- price paid when the current position was opened
  peak_price numeric,                       -- highest price since entry (for momentum trailing stop)

  last_regime text,                         -- 'MOMENTUM' | 'MEAN_REVERSION'
  last_checked_at timestamptz,
  last_checked_price numeric,
  last_trade_at timestamptz,                -- used for the 30-min cooldown

  updated_at timestamptz not null default now()
);

create table if not exists trading_log (
  id bigint generated always as identity primary key,
  product_id text not null,
  action text not null,               -- 'BUY' | 'SELL'
  regime text,                        -- which mode triggered this
  reasoning text,                     -- human-readable explanation of why
  price numeric not null,
  amount_gbp numeric,                 -- GBP spent (buy) or received (sell)
  base_size numeric,
  coinbase_order_id text,
  status text not null,               -- 'success' | 'error' | 'skipped'
  detail text,
  created_at timestamptz not null default now()
);

-- One row, tracks whether the daily loss limit has halted new BUYS today.
-- Protective SELLS (stop-losses) still run even when halted.
create table if not exists risk_state (
  id int primary key default 1,
  day date not null default current_date,
  day_start_capital_gbp numeric not null default 0,
  trading_halted_today boolean not null default false,
  check (id = 1)
);
insert into risk_state (id) values (1) on conflict (id) do nothing;

alter table trading_positions enable row level security;
alter table trading_log enable row level security;
alter table risk_state enable row level security;

create policy "Allow public read on trading_positions" on trading_positions for select using (true);
create policy "Allow public read on trading_log" on trading_log for select using (true);
create policy "Allow public read on risk_state" on risk_state for select using (true);
