# Onyx Baseball

Daily MLB home-run analytics PWA. A self-correcting HR probability model prices every
hitter on every slate, publishes picks and a tracked parlay, projects pitcher strikeouts,
and grades itself against real box scores every day — with every result public on the
site. The business goal: funnel users to **app.onyxodds.com** (referral `KR680261`) via
one-tap bet buttons and the Parlay Builder. **Parlays are the product.**

- **Live site:** https://onyxjordan.github.io/onyx-baseball-fix/ (GitHub Pages, PWA installable)
- **Repo:** `OnyxJordan/onyx-baseball-fix` · owner: Jordan (marketing lead, jordan@onyxodds.com)
- **Dev branch convention:** work on a `claude/...` feature branch, PR to `main`, squash-merge
- **Current model:** v41 (see the changelog at the top of `model.py` — every version documents its evidence)
- **Agent rules:** [CLAUDE.md](CLAUDE.md) is the auto-loaded short form of the hard rules below. Keep the two in sync.

---

## HARD RULES (read before touching anything)

1. **Never regenerate `shell.html`, `career_db.json`, or `pitcher_db.json`.** Surgical
   edits only. These files are the product of months of hand-tuning; a regeneration
   loses everything.
2. **Every model change bumps the version and adds a changelog entry at the top of
   `model.py`** stating the evidence for the change. No exceptions — the changelog is
   the lab notebook.
3. **All odds on the site are labeled "Onyx"** — never DraftKings/FanDuel branding.
4. **No em dashes in site copy.** No yellow anywhere (brand rule; Spark tones excluded).
   (This applies to rendered site copy, not to repo docs like this one.)
5. **Any injected JS global that is read before its declaration line must be `var`.**
   A `const` read from an earlier line throws at runtime and kills every script after
   it — a `typeof` guard does **NOT** protect a `const` in its temporal dead zone.
   This blanked the site on 8/8. Declaration order is what matters, not the keyword
   alone; see [Injected globals](#injected-globals-the-tdz-rule-precisely) for the
   current audit of which globals are safe and which are not.
6. **The ledgers are sacred.** `data/picks_input.json`, `ticket_history.json`,
   `k_history.json`, `hr_history.json` are the graded record. Never regenerate them;
   during merges always `git checkout origin/main -- data/<ledger>` so a stale local
   copy can't clobber the live record. Record odds **at the moment a play qualifies**
   (odds drift all day — this burned us once with B. Lowe).
7. **Never include the AI model ID in anything pushed to the repo** (commits, comments,
   PR bodies). Chat replies only.
8. **Verify headless before shipping shell changes** (see Verification below). The one
   time this was skipped, the site went blank.

---

## Architecture

Static site, zero servers. A Python pipeline builds a single `index.html` from
`shell.html` (the hand-tuned template) by injecting JSON globals; GitHub Actions builds
and deploys to Pages; the browser does live-score polling client-side against the MLB
Stats API.

### Pipeline (runs in this order)

| script | job |
|---|---|
| `fetch_data.py` | MLB Stats API: schedule (keyed to the **baseball day**, see Dates), lineups/probables, weather, L14 hitter form, hand splits, pitcher season stats, team K%, season trend windows (`fetch_trend_splits`) |
| `fetch_odds.py` | The Odds API consensus HR props + game lines (`ODDS_API_KEY` secret). Respects `onyx_ts` freshness stamps so it never clobbers newer Onyx prices. Also appends market snapshots to `line_history.json` |
| `fetch_onyx.py` | OpticOdds (`OPTICODDS_API_KEY` secret): Onyx book game links/fixture ids (`onyx_games.json`), full-board prices (ML/totals/HR props — **HR props MERGE over consensus, never replace**), player ids for share links (`onyx_players.json` — learned from prop rows, the `/players` pager alone is insufficient) |
| `heal_hands.py` | pitcher handedness repair |
| `grade_picks.py` | grades everything pending against final box scores: picks, ticket legs, K calls, HR-edge plays. Scratches void after 2 days. One shared `day_hr_map()` per date serves all four ledgers |
| `calibrate.py` | self-calibration from graded picks: `scale = (actual+15)/(expected+15)`, clamped 0.75–1.15, written to `data/calibration.json`, read by `model.py` |
| `generate_recap.py` | daily recap blurb |
| `auto_build.py` | scores ~290 batters via `model.project_player()`, builds the board/picks/ticket/ledger aggregates, injects the JSON globals into `shell.html` → `index.html` |
| `update_stats.py` | persists the picks record (`PICKS`) into the page |

`rebuild_dbs` (manual workflow) is the only thing that touches the career/pitcher DBs.

**Runtime dependency: `requests` only.** The whole daily pipeline installs nothing else.
`rebuild.yml` is the exception and installs `pandas` for `rebuild_dbs.py`. Keep it that
way: a new third-party import in the daily path means editing every workflow that runs it.

### Automation — the self-driving chain (important!)

GitHub's cron scheduler has failed three separate times (a 20-hour concurrency wedge
8/6, silent late fires 8/26, an 11-hour total event blackout 8/27 where even
`workflow_run` completion events were dropped). **Do not trust GitHub event delivery.**

- `refresh_build.yml` — jobs: `refresh` (pipeline + commit), `deploy` (Pages, with one
  60s retry for the API's 503 bursts), `requeue` (arms the sleeper and exits in seconds).
  Concurrency group `onyx-build`, `cancel-in-progress: true` (a stuck run is evicted by
  the next one). Crons exist for slate hours + morning coverage but are **backup only**.
- `chain.yml` — the sleeper, in its own group `onyx-chain`: sleeps 30 min during slate
  hours (11 AM–1 AM ET) / 2 h overnight, then API-dispatches the next refresh. The loop
  uses **only `workflow_dispatch` API calls** — no event delivery anywhere.
- `daily_build.yml` — 11:30 AM ET full build (largely redundant with refresh now).
- `notify_watch.yml` — closed-app push watcher, **currently dormant** (see Push).
- `rebuild.yml` — manual career/pitcher DB rebuild.
- **If the site is ever stale:** press "Run workflow" on `refresh_build.yml`. One manual
  run refreshes everything AND re-seeds the chain. That is the universal fix.

**Cron times are UTC and assume EDT.** Every schedule in this repo is written as
`UTC = ET + 4`. That holds for the whole MLB season; if anything ever runs into November,
each cron fires an hour late in ET until the offset is changed to +5. The chain sleeper
is immune (it reads `TZ=America/New_York` at runtime) — only the backup crons drift.

### Dates: everything runs on the "baseball day"

The **baseball day = Eastern Time minus 4 hours** (rolls at 4 AM ET), matching the
shell's `etGameDay()`. `fetch_data.ball_today()`, `fetch_odds._slate_date()`, and
`auto_build`'s `stamp`/header badge all use it. History: a 9 PM ET build once ran on the
runner's UTC date, fetched *tomorrow's* schedule mid-slate, and seeded phantom next-day
rows in all four ledgers. Never date anything off UTC "today."

---

## The model (`model.py`, v41)

Read the changelog at the top of the file first — it is the authoritative history, and
each entry cites its evidence. Philosophy: **large samples decide, recency advises,
graded evidence referees.** The self-built studies (archived pregame boards from git
history joined to box scores; latest: 7,055 player-games, 751 HR, 8/5–9/5) drive every
weight.

**Hitter HR probability, in order:**
1. Base rate: 3-yr career HR/PA (position-shrunk) blended 55/45 with a **contact-quality
   anchor** (barrel rate × league conversion, adjusted by flyball%/pull% launch
   geometry). The 2026 season blends into both by its own sample
   (`pa/(pa+300)`, cap 60%) — season outcome rate comes **live** from the trend windows,
   not the frozen mid-July `career_db` bake. (This fixed the "Cal Raleigh projects off
   his 2025" bug: career 6.3% HR/PA & 16.4% barrels vs 2026's 4.0% & 11.1%.)
2. Home/away split, L14 form (floor 0.80 / cap 1.08 — both extremes are overpriced:
   ice-cold cashed 58% of price, on-fire 61%), **stability-shaped trajectory** (fades
   |change| vs early season, floor 0.82, boosts nothing — fallers AND risers both lag
   steady bats at price), due meter (capped 1.10 — the old 1.18 tier was never earned).
3. Situational: pitcher factor (**dampened 60%** — fully priced by the market, high-pf
   tercile actually the worst cell), park, weather env, **platoon at full strength**
   (the one priced feature with real spread left: opp-hand 0.84 vs same-hand 0.74 of
   implied), elite-HH kicker, home 0.97/away 1.03.
4. Reality checks: compression knee 19 / slope 0.40 / cap 26 (every graded bucket above
   20 paid ~0.76–0.79 of its claim), × nightly calibration scale, then blended ~55/45
   with the vig-stripped Onyx price (weather deference shifts weight to the market when
   |env−1| > 4pp). **Edge is measured vs the listed price.**

**Calibration status (9/23):** buckets below 20% are calibrated within ~0.6pp. The
20%+ tail is the residual battle — check it before believing any "model is broken" report.

**Pitcher K projections:** 3-yr K/BF anchor, season shrunk in by BF, L14 nudge (≤15%),
30-day K-rate trend nudge (≤20%), opponent's actual-lineup L14 K%, park, home/away.
This side works — protect it.

**What the studies proved (don't relearn these):**
- Ranking by *edge* selects for model error (top-5-by-edge went 0-36). Rank by
  **calibrated probability**; edge breaks ties. Server + client composites both do this.
- Weather, bad pitchers, big HR parks are fully priced by the market (park/env HIGH
  terciles are the *worst* cells at price). They stay in the probability, not the edge.
- The Onyx HR prop vig is a ~20–37% wall. Most days there is no positive-EV HR bet;
  an honest edge lane is a quiet edge lane.
- Longshots >+400 went 10-85. Price cap stays.

**Expected startup lines (a healthy `auto_build.py` run).** Anything far off these is the
first symptom worth chasing:

```
model: calibration scale 0.91 (active, n=259)
model: SEASON_SPLITS loaded (0 players)      <- expected; see Known gaps
model: HAND_SPLITS loaded (253 players)
model: DBs injected (841 hitters, 850 pitchers, 30 bullpens, 872 hands)
model: 288 scored, 0 errors
```

## Tracked ledgers (the site's spine — grade, never hide)

| ledger | rule | displayed record @ 9/23 |
|---|---|---|
| Top 5 Picks (`picks_input.json`) | ticket legs first, then +EV fills; locked by first pitch; $10 grading | 51-208 (19.7% — roughly what the model claims; the issue is price, not calibration) |
| Model's Ticket (`ticket_history.json`) | one $10 parlay/day, 2–4 legs, **one bat per team**, frozen at slate first pitch (`ticket_lock.json`) | 5-53, +$114 |
| K Projections (`k_history.json`) | model's side vs listed line, only when projection beats line by >10% | 436-380 (53.4%) |
| HR Edge (`hr_history.json`) | every bat with >1.5pp edge, straight up at listed price | 23-250 (the vig wall, displayed honestly) |

**The ledger files hold more rows than the site shows, and that is deliberate.**
`k_history.json` and `hr_history.json` keep *every* row ever written; the conviction
filter is applied at injection time in `auto_build.py`, so the threshold can move later
without losing history. Counting the raw JSON will not reproduce the published record:

| ledger | raw rows | raw W-L | displayed filter | displayed W-L |
|---|---|---|---|---|
| `k_history.json` | 1,093 | 534-453 | `proj > line×1.10` or `proj < line×0.90` | 436-380 |
| `hr_history.json` | 573 | 57-471 | `prob − implied > 1.5` | 23-250 |

`picks_input.json` and `ticket_history.json` are unfiltered — raw equals displayed.
Before reporting "the record on the site is wrong," apply the filter first.

Grading conventions: never-appeared = void (`"void"`/`"dnp"`), client checks are strict
`=== true / === false` so void strings are record-safe.

## Injected globals: the TDZ rule, precisely

`auto_build.py` injects 12 globals via `replace_const()`; `update_stats.py` injects
`PICKS` separately — 13 in total. `replace_const` rewrites the *value* and preserves
whatever keyword is already in `shell.html`, so the keyword is a property of the shell,
not the builder. Changing a global's keyword means a surgical shell edit.

The rule that matters is **declaration order, not the keyword**. A `const` is only
dangerous when something reads it on a line that executes *earlier* than its declaration.
Current state:

| global | keyword | declared | first `typeof` guard | status |
|---|---|---|---|---|
| `PICKS` | var | 6364 | 6306 | safe (var hoists) |
| `TICKET_LOCK` | var | 6365 | 6005 | safe |
| `DAILY_RECAP` | var | 6371 | 3400 | safe |
| `ONYX_PLAYER_IDS` | var | 5321 | 5377 | safe |
| `TICKET_HISTORY`, `K_HISTORY`, `HR_RECORD`, `ONYX_GAME_LINKS` | var | 6366-6368, 5289 | — | safe |
| `RESULTS`, `SUMMARIES` | const | 2438, 2442 | 3944, 2961 | safe (guard runs after declaration) |
| `TEAM_LOGOS` | const | 2830 | 3638 | safe |
| `PITCHER_PROJ` | const | 6370 | 6378 | safe |
| `LINE_HISTORY` | var | 6374 | 5112 | fixed, was the one violation |

**Why the whole file is one scope:** `index.html` carries a single `<script>` block
spanning roughly lines 2434-7004. Every global above shares it, so a `const` declared at
6369 is in its temporal dead zone for everything that executes earlier in the same
block — including the top-level render calls at ~6350. Cross-block references would be
harmless (the binding would simply not exist yet, and `typeof` would return
`"undefined"`); same-block references throw. That is why declaration order is the rule.

`LINE_HISTORY` was the one violation and is now `var`. `mktHist()` at line 5112 does
`typeof LINE_HISTORY !== 'undefined' ? LINE_HISTORY : []` more than 1,200 lines *above*
the declaration. As a `const` that guard threw
`ReferenceError: Cannot access 'LINE_HISTORY' before initialization` — the 8/8 pattern.
It never blanked the site only because the one reachable early caller (`gcBetBar`, line
3926) wraps it in `try/catch`, so the error was swallowed and the line-movement chip
rendered blank instead. Standing rule: **any new typeof-guarded global goes in this
table, and an un-caught early caller of one is a site-blanker.**

## Onyx integration

- Share links: `app.onyxodds.com/share?selection={slug}:o_default_v8:{market}:{label}:{tail}&referrer=KR680261`.
  HR props **require** the OpticOdds player id as `tail` (`:null` legs get silently
  dropped by Onyx). Multi-leg = repeated `selection=` params (verified to hydrate).
- Slugs come from `onyx_games.json` (fixture API `id`, NOT the share slug), DH game 2
  under `AWAY_HOME_2`. Fallback URL is `ONYX_FALLBACK_URL`
  (`https://app.onyxodds.com/leagues/MLB`), never an invented slug.
- Only *same-day* slugs are injected; `auto_build.py` drops anything dated otherwise.
- OpticOdds rate limits are shared with production: reset-aligned 429 backoff, don't
  hammer.
- Parlay Builder (client): arm mode turns every odds chip into add-leg; slip caps 10;
  flags id-less legs; docks above the mobile bottom nav.

## Frontend (`shell.html`, ~7,000 lines)

Brand: purple leads (hub palette — Purple 400 `#B038F9` on Onyx `#0C0C0C`, Titanium
text, Seed green **only** for wins/live/positive money, lilac replaces all amber, no
yellow ever). Logo = official Onyx mark on a Titanium baseball, horizontal spin.
Gamecenter: last play leads, matchup + count + live strike zone, HR cam. Live scores
poll 30s, gamecast 7s. Client live-decay (`liveHRProb`) shows FINAL/HR ✓ states, never
a bare 0.0%. GA4 analytics: `G-03T8V1N52E`, custom events `onyx_click` (link_type
single/parlay/fallback), `parlay_add`, `tab_view`. GA's "tag not detected" banner is a
permanent false negative (it checks the domain root, which 404s) — ignore it; Realtime
is the truth.

## Push notifications (dormant — decide, then wire or delete)

Closed-app push for HRs and finals is fully built but **switched off**:

- `notify_watch.yml` runs every 30 min during game hours (17-23 and 0-6 UTC) and calls
  `push_watch.py`, which polls the MLB Stats API every ~45s for a ~28-minute window.
- `push_watch.py` exits immediately unless `ONESIGNAL_APP_ID` and `ONESIGNAL_API_KEY`
  are set, so today every scheduled run is a near-instant no-op.
- `shell.html` has `const ONESIGNAL_APP_ID = ''` (line ~3281). While it is empty the
  client SDK never loads, so **no browser can subscribe** even if the secrets existed.

To turn it on: create a free OneSignal Web Push app pointed at the live site URL, paste
the Web App ID into `shell.html`, and add the two repo secrets. In-app bell toggles map
to OneSignal tags (`hr`, `final`). iPhone users must install the PWA first (iOS requires
an installed PWA for web push). To turn it off for good, delete `notify_watch.yml` and
`push_watch.py` — leaving it half-wired is what makes it look broken.

## Secrets and configuration

| name | where | used by | if missing |
|---|---|---|---|
| `ODDS_API_KEY` | Actions secret | `fetch_odds.py` | no consensus HR props / game lines; build still runs |
| `OPTICODDS_API_KEY` | Actions secret | `fetch_onyx.py` | no Onyx prices, slugs, or player ids; share links fall back to the MLB board |
| `ONESIGNAL_APP_ID` | Actions secret **and** `shell.html` | `push_watch.py`, client SDK | push is a no-op (current state) |
| `ONESIGNAL_API_KEY` | Actions secret | `push_watch.py` | push is a no-op (current state) |
| `GITHUB_TOKEN` | automatic | chain dispatch, commits | chain cannot self-arm; crons are the only trigger |

Secrets exist only in Actions. Local runs use whatever is committed in `data/` — which is
why a local `auto_build.py` still produces a full board.

## Repo map

| path | role |
|---|---|
| `shell.html` | hand-tuned template — **never regenerate** |
| `index.html` | the built page (generated every run; never hand-edit) |
| `model.py` | v41 HR model + pitcher K projections; changelog at top is the lab notebook |
| `career_db.json`, `pitcher_db.json` | canonical hitter/pitcher DBs — **never regenerate** outside `rebuild.yml` |
| `bullpen_db.json` | team bullpen HR/9, consumed by `auto_build.py` |
| `data/*_history.json`, `data/picks_input.json` | the four graded ledgers — sacred |
| `data/line_history.json` | market snapshots for the line-movement UI |
| `data/salaries.json` | read by `auto_build.py` only; a leftover of the retired DFS lane |
| `data/splits.json`, `data/pitcher_l14.json` | **empty** — see Known gaps |
| `rebuild_dbs.py`, `build_pitcher_hand.py` | DB rebuild, manual workflow only |
| `push_watch.py` | dormant push watcher |
| `exports/` | archived FanGraphs leaderboard CSVs (fallback inputs, not in the live path) |
| `old/`, `onyx-rebuild/` | historical copies; nothing reads them |
| `ROADMAP.md` | forward plan; Phases 0-1 and the ticker shipped, the rest is open |

## Verification discipline (non-negotiable)

Before shipping any shell/model change:
```bash
rm -rf __pycache__ && python3 -B auto_build.py && python3 -B update_stats.py
# then headless (playwright-core + /opt/pw-browsers/chromium in the cloud env):
#   serve repo on :8901, load index.html at 390x844, capture pageerror,
#   walk all 8 tabs, grep rendered text for 'undefined'/'NaN', assert key DOM
```
Abort external requests in probes (`page.route`) or screenshots hang on Google Fonts.

A local build touches only `index.html` when the committed data is current — if it also
rewrites files under `data/`, something re-fetched or re-graded, and that belongs in its
own commit, not bundled into a shell change.

## Merge ritual (main moves constantly under you — the chain commits every ~35 min)

```
push branch → open PR → merge usually CONFLICTS on index.html/data →
git merge origin/main → checkout --theirs index.html → checkout origin/main -- data/ →
checkout HEAD -- <your source files> → rebuild → commit merge → push → squash-merge PR →
dispatch refresh_build.yml (also re-seeds the chain) → verify the DEPLOYED page
(watch for a marker that actually ships in index.html — not a source-file comment)
```

## Incident playbook

| symptom | first check | history |
|---|---|---|
| site stale / "not running" | Actions tab: any run since the last commit? | cron blackouts (8/27), Pages 503 bursts (8/17), concurrency wedge (8/6). Fix: Run workflow on refresh_build.yml |
| whole site blank | a global read before its declaration (TDZ) | 8/8 — see Injected globals, verify headless |
| board = yesterday, all 0.0% live | UTC date leak or overnight gap | 8/26 — everything dates off ball_today() |
| odds wrong vs Onyx app | is `onyx_ts` fresh? partial pull replaced instead of merged? | 7/30 board flap |
| phantom next-day ledger rows | a build ran on UTC "tomorrow" | 8/26 — purge rows, keep aggregates honest |
| "model broken, no plays" | calibration buckets + league weekly HR rate first | 9/6 — it was variance; the model was calibrated |
| published record ≠ the JSON | apply the conviction filter before concluding anything | see Tracked ledgers |
| line-movement chip blank | a typeof-guarded global read before its declaration, swallowed by a try/catch | 9/23 — `LINE_HISTORY` was const; see Injected globals |

## Known gaps (open, tracked, not bugs to rediscover)

- **`data/splits.json` is `{}` and always will be** until someone wires it to the API.
  It is written by `fetch_data.fetch_splits()`, which reads `data/hitters_home.csv` /
  `hitters_away.csv` — manual uploads that stopped arriving when the CSV routine was
  retired. `model.py` falls back to `CAREER_DB` `ch`/`ca`, so per-player home/away still
  works off career data; only the 2026-season refinement is dormant. `model.py`'s own
  PATH NOTE suggests checking the file path first — the path is fine, the inputs are gone.
  Tracked as ROADMAP Phase 6.
- **`data/pitcher_l14.json` is 0 bytes and nothing reads it.** Safe to delete.
- **No `validate_build.py`.** ROADMAP Phase 2 called for a schema gate that blocks the
  commit when `RESULTS`/`SUMMARIES` come out malformed. It was never built, so the only
  guard today is `auto_build.py` aborting on zero scored players. A structurally broken
  but non-empty build would still ship.
- ~~`LINE_HISTORY` const/TDZ~~ — **fixed**; it is `var` now. The audit table in
  [Injected globals](#injected-globals-the-tdz-rule-precisely) is the live record.

## Working with Jordan

Marketing lead, non-engineer, sharp instincts — his gut reports ("Raleigh shouldn't
project like this", "same-team legs kill the ticket") have almost always pointed at real
bugs. Verify with data, show receipts, keep replies plain-language with the numbers that
matter. He screenshots problems; trust the screenshot over your assumptions (his "+0.5%
edge" screenshot corrected the ledger once). Priorities: parlays funnel first, honest
public records always, purple brand, PWA experience. He will say "it broke" — diagnose
before assuming the model (it's been GitHub infra roughly as often).

## Environment notes (Claude Code cloud sessions)

- Headless Chromium: `playwright-core` with `executablePath: '/opt/pw-browsers/chromium'`
  (`npm install playwright-core --no-save` in the scratchpad after container recycles).
- GitHub via MCP tools (no `gh` CLI). Git history may be shallow — `git fetch --deepen`.
- Secrets (`ODDS_API_KEY`, `OPTICODDS_API_KEY`) exist only in Actions; local pipeline
  runs use committed data from `origin/main`.
- Archived pregame boards for studies: one pre-17:00Z commit per date from `git log`,
  `git show <sha>:index.html`, join to box scores via the MLB Stats API.
