-- 013: Trade-up games (two collectors at a card show put in cards; one fair draw decides who takes all).
-- Run once in the Supabase SQL Editor. Players can only READ their own games; every change goes
-- through the server (/api/tradeup, service role), which prices the cards and runs the draw, so a
-- phone can never set its own card values or the result.

create table if not exists public.tradeup_games (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{6}$'),
  host_id uuid not null references auth.users (id) on delete cascade,
  guest_id uuid references auth.users (id) on delete cascade,
  host_cards jsonb not null default '[]'::jsonb,
  guest_cards jsonb not null default '[]'::jsonb,
  host_total numeric(12, 2) not null default 0,
  guest_total numeric(12, 2) not null default 0,
  host_commit text,
  guest_commit text,
  host_secret text,
  guest_secret text,
  status text not null default 'open' check (status in ('open', 'rolled', 'cancelled')),
  winner text check (winner in ('host', 'guest')),
  draw numeric,
  host_chance numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 hours'
);

-- One open game per join code at a time.
create unique index if not exists tradeup_games_open_code on public.tradeup_games (code) where status = 'open';
create index if not exists tradeup_games_host on public.tradeup_games (host_id, created_at desc);
create index if not exists tradeup_games_guest on public.tradeup_games (guest_id, created_at desc);

alter table public.tradeup_games enable row level security;
revoke all on public.tradeup_games from anon, authenticated;
grant select on public.tradeup_games to authenticated;
grant all on public.tradeup_games to service_role;

drop policy if exists "players read their games" on public.tradeup_games;
create policy "players read their games" on public.tradeup_games
  for select to authenticated using (auth.uid() = host_id or auth.uid() = guest_id);
