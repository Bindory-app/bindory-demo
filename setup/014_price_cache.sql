-- 014: Shared cache for external price, FX, and listing lookups across serverless instances.
-- Run once in the Supabase SQL Editor. Service role only (RLS enabled, no policies).

create table if not exists public.price_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null
);

create index if not exists price_cache_expires_at on public.price_cache (expires_at);

alter table public.price_cache enable row level security;
revoke all on public.price_cache from anon, authenticated;
grant all on public.price_cache to service_role;
