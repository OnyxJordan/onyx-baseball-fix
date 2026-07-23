# Onyx Baseball -> Onyx Sports Insights: Build-Out Roadmap

Goal state: a fully autonomous daily pipeline (zero manual uploads on a normal day), a live in-game layer on the site, and a generalized multi-sport envelope, all on the existing zero-backend GitHub Pages architecture.

Ordered by priority. Each phase is shippable on its own.

---

## Phase 0: Restore working condition (DONE, this branch)

- Restored `model.py` v16 from git history (it had been overwritten with a copy of `auto_build.py`, which self-imported and killed the model)
- Fixed weather wiring: `auto_build.py` now finds weather keyed by home team and reads the field names `fetch_data.py` actually writes; parks and wind reach the model again
- `game_lines.json` is now written from the MLB schedule every run (pitchers, start times, venues); manual betting lines carry over by game key
- Weather fetches fresh from Open-Meteo every run instead of freezing on the first committed `weather.json`; `data/weather_manual.json` is the override hook
- Odds freshness gate now uses the last git commit touching `odds.json` instead of file mtime (which CI checkout resets, making stale odds look fresh)
- `heal_hands.py` reads probable starters from `game_lines.json` (it was finding zero starters in the flat lineup file)
- Auto-logged picks now match the shell PICKS schema (`player` / `hit`), so they merge into the record instead of collapsing
- Build fails loudly on an empty slate and exits clean on off-days

## Phase 1: Kill the manual morning routine (DONE, this branch)

1. **Odds via The Odds API**: `fetch_odds.py` now tries The Odds API first (GitHub secret `ODDS_API_KEY`, DK book preferred per event), then DK direct, then the manual file with its git-time freshness gate. Game totals and moneylines from the same source are merged into `game_lines.json`. ACTION NEEDED: add the `ODDS_API_KEY` repo secret (Settings -> Secrets and variables -> Actions).
2. **L14 form without CSV uploads**: hitter and pitcher L14 now come from MLB Stats API byDateRange aggregates (421 hitters / 447 pitchers on first run vs 414 / 285 from the CSVs). Statcast CSVs still enrich barrel/EV when present; FanGraphs CSVs remain as a fallback only.
3. **Auto-grade picks**: `grade_picks.py` grades pending picks from final boxscores in the daily run. Verified against real slates: HR hit -> true, appeared without HR -> false, never appeared -> stays pending (voided prop).
4. **Confirmed-lineup refresh**: `refresh_build.yml` reruns the pipeline hourly 1:30-7:30 PM ET and commits/deploys only when output changed.

Remaining in this phase: improve the projected-lineup fallback (the recent-orders hydrate returns zero entries; use per-game boxscores from the last 10 finals instead). Statcast quality via pybaseball in the Action is optional polish on top of the CSV enrichment path.

## Phase 3 head start (DONE, this branch): live score ticker

Ported from the early New-Baseball-Test iteration and adapted to the current pipeline's team abbreviations and payload fields:
- Score ticker bar pinned under the nav: every game today with logos, live scores, inning, LIVE / F states
- Polls MLB Stats API every 90s, ESPN scoreboard fallback, schedule-mode fallback from the baked payload when both fail; never breaks the page
- Play-by-play HR detection lights modeled players green in the edge ticker (HR badge + live score), grays out finished no-HR games
- `gamePk` now flows from the schedule into `game_lines.json`, RESULTS rows, and SUMMARIES, ready for live game cards and board badges

## Phase 2: Pipeline hardening

1. **Schema validation gate**: a `validate_build.py` step that checks index.html parses, RESULTS is a non-empty array of objects with required keys, SUMMARIES matches ALL_GAME_KEYS; nonzero exit blocks the commit so yesterday's page stays live
2. **Workflow ordering**: commit+push only after validation passes; deploy job depends on it
3. **Envelope extraction**: move the injected payload out of regex-on-HTML into a real `data/envelope_mlb.json` fetched by the shell (`{ sport, version, generated_at, columns[], rows[] }`); shell falls back to baked constants if fetch fails. This is the foundation for Phase 5 and removes the fragile `replace_const` regex entirely (schema version bumped in shell and builder in the same commit)
4. **Second-half DB refresh cadence**: run the `rebuild.yml` DB rebuild monthly on a schedule instead of manually

## Phase 3: Live layer, remaining work (client-side, zero backend)

The ticker and HR detection shipped early (see above). Still to build:

1. **Ticker detail**: outs and runners-on-base diamond icons on live games; pregame probables on hover; optional 30s poll rate on game days
2. **Live game cards**: expand a ticker game into current batter / pitcher / count / last play via the live feed endpoint; highlight modeled batters at the plate
3. **In-game HR tracking on the board**: HIT badge on main board rows (livePlayerData is already populated; the board renderer just needs to read it) and a running daily model record (hits vs pending vs misses)
4. **Live-adjusting board**: gray out finished games, badge batters who already homered, estimated PAs remaining per batter

## Phase 4: Board UX polish

- Sortable columns with persisted sort choice (localStorage)
- Player and team search filter
- Last-updated timestamp (from envelope `generated_at`) visible at the top
- Full usability at 380px width, ticker included
- Onyx branding pass: #0D0D14 base, magenta-to-violet gradient accents only

## Phase 5: Multi-sport envelope (Onyx Sports Insights)

- Formalize the envelope schema and make the shell render any conforming sport envelope; MLB is the reference implementation
- Sport switcher in the header driven by an `envelopes/index.json` manifest
- Golf (strokes gained model) onboards second; its pipeline writes `envelope_golf.json` and nothing in the shell changes

## Phase 6: Model improvements (each gets a version bump + changelog line)

- Platt scaling of raw probabilities once ~50 graded outcomes exist (auto-grading in Phase 1 feeds this)
- Hit rate by probability bucket on the site (calibration transparency)
- Pull% x park interaction (short porches vs pull-heavy hitters)
- Bullpen exposure by expected starter innings instead of the flat 60/40 split
- Home/away splits automated from MLB Stats API (splits.json is currently empty because the CSVs stopped arriving)

---

## Standing rules (from CLAUDE.md, non-negotiable)

- `shell.html`, `career_db.json`, `pitcher_db.json` are canonical: surgical edits only, never regenerated
- No DFS fields, ever; odds and probabilities only
- Envelope schema changes ship with the matching shell update in the same commit
- Every model change bumps the version with a one-line changelog at the top of `model.py`
