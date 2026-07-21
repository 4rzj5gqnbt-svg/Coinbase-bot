-- Run this in the Supabase SQL editor to set up state tracking.

create table if not exists positions (
  product_id text primary key,       -- e.g. 'BTC-GBP'
  base_currency text not null,       -- e.g. 'BTC'
  peak_price numeric not null,       -- highest price seen since tracking started
  trailing_stop_pct numeric not null default 5,   -- sell if price falls this % from peak
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_checked_price numeric,
  previous_checked_price numeric,    -- price from the check before this one, for % change display
  updated_at timestamptz not null default now()
);

create table if not exists trade_log (
  id bigint generated always as identity primary key,
  product_id text not null,
  action text not null,              -- 'SELL'
  price numeric not null,
  peak_price numeric not null,
  base_size numeric,
  coinbase_order_id text,
  status text not null,              -- 'success' | 'error'
  detail text,
  created_at timestamptz not null default now()
);

-- Allow the dashboard (using the public anon key) to READ these two tables,
-- but not insert/update/delete. The bot itself uses the service_role key,
-- which bypasses RLS entirely, so this doesn't affect the bot's writes.
alter table positions enable row level security;
alter table trade_log enable row level security;

create policy "Allow public read on positions"
  on positions for select
  using (true);

create policy "Allow public read on trade_log"
  on trade_log for select
  using (true);

-- If you already created the `positions` table before this column existed,
-- run this too (safe to run even if the column already exists):
alter table positions add column if not exists previous_checked_price numeric;
