-- 11/16 search log (Jordan: "add the search logging so trending is real"). What people type into Ask Onyx, so the
-- NFL Studio's Insights tab ranks real questions. Only the question text and how Ask read it (sport, markets, side,
-- intent: never who asked, no user id, no device id). The site can only add a row (insert from the public key);
-- nothing on the site can read the table back: search_trends.py reads it on the server with the service key and
-- publishes counts (data/insights/trending.json), and deletes rows older than 90 days.
create table if not exists public.search_log (
  id bigint generated always as identity primary key,
  q text not null check (char_length(q) between 2 and 200),
  sport text check (sport is null or char_length(sport) <= 12),
  spec jsonb,
  page text check (page is null or char_length(page) <= 24),
  at timestamptz not null default now()
);
alter table public.search_log enable row level security;
drop policy if exists "anyone can log a search" on public.search_log;
create policy "anyone can log a search" on public.search_log for insert to anon, authenticated with check (true);
create index if not exists search_log_at on public.search_log (at);
