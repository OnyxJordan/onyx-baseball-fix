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

## Phase 1: Kill the manual morning routine (automation)

The only remaining manual inputs are odds, betting lines, FanGraphs L14 CSVs, and pick results. Automate each:

1. **Odds via The Odds API** (the-odds-api.com)
   - `batter_home_runs` player prop market, free tier is enough for one fetch per day
   - New `fetch_odds.py` path: try The Odds API (key via GitHub secret `ODDS_API_KEY`), then DK direct, then manual file; write `odds_meta.json` with the true source
   - Also grab game totals and moneylines from the same call and merge into `game_lines.json`, removing that manual input too
2. **L14 form without CSV uploads**
   - Replace the FanGraphs CSV dependency with MLB Stats API aggregates: `/api/v1/stats` with `stats=byDateRange` gives PA/HR/ISO per hitter for any window, no key, CORS-friendly
   - Statcast quality (barrel, EV) via pybaseball in the Action (pip install in workflow) writing the same `statcast_l14.json` shape; keep the CSV path as a fallback loader
3. **Auto-grade picks**
   - New `grade_picks.py` post-games step (second cron, ~3 AM ET): for each pending pick, hit the MLB Stats API boxscore for that date and set `hit` true/false automatically
   - Manual editing of `picks_input.json` becomes optional forever
4. **Confirmed-lineup refresh**
   - Second lightweight workflow run hourly from 3 PM to first pitch: refetch lineups and weather only, rebuild, commit only if lineups changed
   - Fixes the "11:30 AM projected lineups" weakness; also improve the projected fallback (recent-orders hydrate currently returns zero; use per-game boxscores from the last 10 finals instead)

Exit criteria: on a normal day, zero human actions and the board still shows odds, edges, confirmed lineups, and graded picks.

## Phase 2: Pipeline hardening

1. **Schema validation gate**: a `validate_build.py` step that checks index.html parses, RESULTS is a non-empty array of objects with required keys, SUMMARIES matches ALL_GAME_KEYS; nonzero exit blocks the commit so yesterday's page stays live
2. **Workflow ordering**: commit+push only after validation passes; deploy job depends on it
3. **Envelope extraction**: move the injected payload out of regex-on-HTML into a real `data/envelope_mlb.json` fetched by the shell (`{ sport, version, generated_at, columns[], rows[] }`); shell falls back to baked constants if fetch fails. This is the foundation for Phase 5 and removes the fragile `replace_const` regex entirely (schema version bumped in shell and builder in the same commit)
4. **Second-half DB refresh cadence**: run the `rebuild.yml` DB rebuild monthly on a schedule instead of manually

## Phase 3: Live layer (client-side, zero backend)

1. **Live ticker** (top product priority)
   - Horizontal scroll strip pinned above the board, polling `statsapi.mlb.com/api/v1/schedule?sportId=1&hydrate=linescore` every 30s on game days
   - Matchup, score, inning + half, outs, runners as diamond icons; pregame shows start time + probables; final shows final
   - Fails silent: any fetch error hides the ticker, never breaks the page
2. **Live game cards**: expand a ticker game into current batter / pitcher / count / last play via the live feed endpoint; highlight modeled batters at the plate
3. **In-game HR tracking**: when a modeled batter homers, HIT badge on the board row and a running daily model record (hits vs pending vs misses)
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
