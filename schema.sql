-- Run this in the Supabase SQL editor to set up state tracking.

create table if not exists positions (
  product_id text primary key,       -- e.g. 'BTC-GBP'
  base_currency text not null,       -- e.g. 'BTC'
  peak_price numeric not null,       -- highest price seen since tracking started
  trailing_stop_pct numeric not null default 5,   -- sell if price falls this % from peak
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_checked_price numeric,
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
