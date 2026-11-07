-- Onyx Sports accounts: run in the Supabase SQL editor (Project -> SQL Editor -> New query). Safe to
-- run again after an update (every statement checks first): 11/2 added pick_history.
-- Sign-in is Supabase Auth (email magic link, no passwords). Every table below holds one person's
-- rows only: row-level security lets a signed-in user read and write their own rows and nothing
-- else, so the public (anon) key in accounts.json can safely sit in the page. The service key is
-- never used by the site and must never be committed.
--
-- What is stored: the email Supabase Auth keeps for sign-in, plus the same lists the site already
-- keeps on the device (saved picks, followed players, My bets), so they follow the person to
-- another phone or computer. Nothing else.

-- one row per person, created on first sign-in
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- saved picks (saved.js, localStorage onyxSaved): one row per Onyx selection id
create table if not exists public.saved_picks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- followed players (onyxNbaFollow, onyxFollow_<sport>): one row per sport and player
create table if not exists public.followed_players (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sport text not null,
  item_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, sport, item_id)
);

-- My bets (ui.js, localStorage onyxMyBets): one row per bet (its selection ids, sorted)
create table if not exists public.bets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- the permanent pick history (saved.js, localStorage onyxHistory): every pick saved, graded W / L / P
-- when its game ends. Never cleared by the 24-hour clean-up of the saved list.
create table if not exists public.pick_history (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.profiles enable row level security;
alter table public.saved_picks enable row level security;
alter table public.followed_players enable row level security;
alter table public.bets enable row level security;
alter table public.pick_history enable row level security;

-- each person: their own rows, every operation; nobody else's, ever
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "own saved picks" on public.saved_picks;
create policy "own saved picks" on public.saved_picks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own follows" on public.followed_players;
create policy "own follows" on public.followed_players for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own bets" on public.bets;
create policy "own bets" on public.bets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own history" on public.pick_history;
create policy "own history" on public.pick_history for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- the profile row, made when someone signs in for the first time
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- "Delete my account" in My Onyx: removes the person's sign-in (and, through the cascades above,
-- every row they have). Runs as the signed-in user and can only ever delete that user.
create or replace function public.delete_me() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

-- ── 11/7 push control center (alerts.js, my_alerts.py) ──────────────────────────────────────
-- How often a signed-in person wants pushes about their own saved picks:
--   all      every update: game starts, lead changes, halftime, the result
--   key      key moments: game starts and the result
--   results  results only: won, lost or push
--   recap    one morning push: yesterday's record and today's saved picks
--   off      none (the default)
-- The person sets it from the control center (their own profile row, under "own profile" above).
alter table public.profiles add column if not exists push_level text not null default 'off';
do $$ begin
  alter table public.profiles add constraint profiles_push_level_ck check (push_level in ('all', 'key', 'results', 'recap', 'off'));
exception when duplicate_object then null; end $$;

-- What my_alerts.py has already sent (or graded) for each person's pick, so nothing is pushed twice
-- and the morning recap can count yesterday's results. Written and read only by the server with the
-- service key: row-level security is on and there is no policy, so the site can never read it.
create table if not exists public.push_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null,
  event text not null,
  res text,
  pushed boolean not null default true,
  data jsonb,
  sent_at timestamptz not null default now(),
  primary key (user_id, item_id, event)
);
alter table public.push_sent enable row level security;
