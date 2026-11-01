# Onyx Baseball

Daily MLB home-run analytics PWA. A self-correcting HR probability model prices every
hitter on every slate, publishes picks and a tracked parlay, projects pitcher strikeouts,
and grades itself against real box scores every day — with every result public on the
site. The business goal: funnel users to **app.onyxodds.com** (referral `KR680261`) via
one-tap bet buttons and the Parlay Builder. **Parlays are the product.**

- **Live site:** https://onyxjordan.github.io/onyx-baseball-fix/ (GitHub Pages, PWA installable)
- **Repo:** `OnyxJordan/onyx-baseball-fix` · owner: Jordan (marketing lead, jordan@onyxodds.com)
- **Dev branch convention:** work on a `claude/...` feature branch, PR to `main`, squash-merge
- **Current model:** v42 (see the changelog at the top of `model.py` — every version documents its evidence)
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
| `fetch_playoffs.py` | the clinched field plus the high-leverage splits behind the Playoffs tab (`lc` late/close, `risp`, `vl`/`vr`, `pi000`/`pi076`). Takes `--if-stale N` so the 30-minute refresh no-ops instead of re-pulling final regular-season stats |
| `grade_picks.py` | grades everything pending against final box scores: picks, ticket legs, K calls, HR-edge plays. Scratches void after 2 days. One shared `day_hr_map()` per date serves all four ledgers |
| `calibrate.py` | self-calibration from graded picks: `scale = (actual+15)/(expected+15)`, clamped 0.75–1.15, written to `data/calibration.json`, read by `model.py` |
| `generate_recap.py` | daily recap blurb |
| `validate_build.py` | the gate: blocks the commit when the page is structurally broken, a batting slot is duplicated or missing, or a graded ledger shrank. Runs in both pipeline workflows before the commit step, and on every pull request |
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

## The model (`model.py`, v42)

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
| NBA Model's Parlay (`nba/ticket_history.json`) | the algorithm's best look to win: the 3 Onyx main-line legs with the highest blended win chance (pts / reb / ast, over or under, -400..+150, 24+ min, one per game and player), frozen at the slate's first tip (`nba/ticket_lock.json` refreshes until then); graded leg by leg, a DNP or push is void and drops from the payout; one $10 ticket per slate. Chosen by replaying 2025-26 at Onyx prices: Feb-Apr hit 28.6% open / 22.4% close vs 12.2% / 4.1% for top-scorer overs | starts 10/26 |
| HR Edge (`hr_history.json`) | edge >1.5pp **and** price ≤+400 **and** edge ≤2.5pp **and** ≥2 signals (v45), straight up at listed price. **All-time, no prune** (see below) | 25-285 @ 10/15 (the vig wall, displayed honestly) |

**The ledger files hold more rows than the site shows, and that is deliberate.**
`k_history.json` and `hr_history.json` keep *every* row ever written; the conviction
filter is applied at injection time in `auto_build.py`, so the threshold can move later
without losing history. Counting the raw JSON will not reproduce the published record:

| ledger | raw rows | raw W-L | displayed filter | displayed W-L |
|---|---|---|---|---|
| `k_history.json` | 1,203 | 576-508 | `proj > line×1.10` or `proj < line×0.90` | 478-435 |
| `hr_history.json` | 612 (all-time) | 59-506 | `prob − implied > 1.5` | 25-285 |

`picks_input.json` and `ticket_history.json` are unfiltered — raw equals displayed.

**The HR edge lane got selective on 10/15 (v45), and the display filter did not move.**
The lane had one screen (edge > 1.5) where the picks lane had three; that was an
oversight from v35, not a decision. Across 565 graded rows it ran 25-285, −$1,299,
−41.9% ROI, and the losses had a shape:

| cut | n | W-L | ROI |
|---|---|---|---|
| edge > 1.5 (the old lane) | 310 | 25-285 | −41.9% |
| …of which priced >+400 | 279 | 20-259 | −43.1% |
| …of which priced ≤+400 | 31 | 5-26 | −30.9% |
| + edge ≤ 2.5 | 22 | 5-17 | −2.6% |
| + signals ≥ 2 (the v45 lane) | 10 | 3-7 | +28.8% |

Three screens were propagated from the picks lane: **price ≤ +400** (279 of 310
plays and 93% of the losses were above it; the picks lane hit the same cliff on
a separate sample, >+400 going 10-85 there), **edge ≤ 2.5** (raising the edge bar
makes the lane *worse* — 2.5-4 was −64.8%, 4-6 was −100% on n=11 — the winner's
curse again), and **signals ≥ 2** (sig < 2 went 1-28, −66.9%).

What this does **not** claim: the +28.8% bottom row is n=10 and must not be quoted
as a profitable lane. A split-half by date on the 22-play cut reads −22.4% then
+17.1%, which is noise. The supported claim is that the longshot tail was a
reliable loser across two independent samples and we stopped posting into it.
Volume drops from ~5.4 posted plays a day to ~0.4; many slates now post nothing,
and that is the correct answer on a slate where nothing qualifies.

The screens are a strict **subset** of edge > 1.5, so the display filter stays at
1.5 and no historical row is re-cut — tightening the display would retroactively
delete 288 losing plays from the public record, which is the same rolling-window
dishonesty the all-time change removed hours earlier.

Open item for whoever revisits this: `hr_prob` is running about 2× hot on this
lane (15-20% claimed → 7.9% actual, 20-25% → 10.2%). The v45 screens are damage
control on the symptom; the cure is recalibrating the probability itself, and that
wants more graded rows under the tightened regime first.

**`hr_history.json` is all-time; the 60-day prune was removed on 10/15.** It used
to drop rows older than 60 days, which made the published HR Edge record a
rolling window that quietly shed old losses — the number on the site was not what
the model had actually posted since July. Going all-time moved it from 14-182
(−$825, 42 days) to **25-285 (−$1,299, 57 days)**, i.e. it looks worse, which is
the point. 393 rows were recovered out of git history when the prune was removed.

That prune also caused an outage: it only ran when a new row was added, so a
16-day gap with no qualifying play meant it fired all at once (576 → 219) and
`validate_build`'s ledger rule read it as regeneration and blocked every commit
for 7 hours on 10/15. With the prune gone, `hr_history` is back under the strict
"never shrinks" rule along with the other three ledgers.
Before reporting "the record on the site is wrong," apply the filter first.

Grading conventions: never-appeared = void (`"void"`/`"dnp"`), client checks are strict
`=== true / === false` so void strings are record-safe.

**Closing a season (10/29, after the 2026 World Series, Brewers in five).** The record
moves, it is never deleted. `python3 tools/mlb_season_close.py 2026 "The Brewers won the
World Series."`:
- copies the four MLB ledgers byte for byte to `data/archive/mlb_2026/`;
- freezes `mlb-2026.html`, today's page with the final grades injected (the offseason
  build stops at "no games today - leaving index.html untouched", so Game 5's grades would
  otherwise never reach the page);
- empties the four live ledgers and the live page's record globals, and puts a note atop
  the Record pane (in `index.html` and `shell.html`) linking the frozen page.

`validate_build.py` allows a ledger to shrink only when every row it held at HEAD is in a
`data/archive/*/` copy (a warning, not a failure); any other shrink still blocks the build.
Final 2026 as displayed: Top 5 Plays 58-241 (-19.4% ROI; the 5 "pending" are voids the
record tab has always counted that way). Next season, the live record starts at 0-0 on
Opening Day.

## Injected globals: the TDZ rule, precisely

`auto_build.py` injects 12 globals via `replace_const()`; `update_stats.py` injects
`PICKS` separately — 17 in total. `replace_const` rewrites the *value* and preserves
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
| `PLAYOFF_FIELD`, `PLAYOFF_GAMES`, `PLAYOFF_HITTERS`, `PLAYOFF_PITCHERS` | var | 6465-6468 | read in `renderPlayoffs()` | safe (var) |

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

## Playoffs tab (v42)

**The tab is a game-by-game board, the same as the rest of the site.** For every
postseason game it shows the model's HR probability against the listed Onyx
price, the implied probability, and the **edge** measured vs that price, plus
each starter's projected strikeouts against his K line. Intent is unchanged from
the main board: model projection vs the market, and where the largest honest edge
is.

It **re-uses `results_out` and `pitchers_out`** rather than projecting anything of
its own, so a playoff row and a main-board row for the same bat are the same
number by construction (verified: identical probability, odds and edge). During
October today's slate simply *is* the playoff slate — `fetch_data.py` has no
`gameType` filter, so postseason games flow through the pipeline like any other.
`fetch_playoffs.py` supplies which games are postseason and what round they are.

**Ranking is composite (calibrated probability first, positive edge breaking
ties), not edge-first.** The graded study that put top-five-by-edge at 0-36
applies here exactly as on the board. Edge is what the user is shopping for and
it appears on every row; it just is not what sorts them. A bat with **no price
shows a dash, never `0.0`** — no market means no edge, not a fair one.

Two supporting rating views sit behind the board (`Bat Ratings` / `Arm Ratings`),
scoring the clinched field on what October asks of it:

| what changes in October | split | how it is used |
|---|---|---|
| bullpens shorten, managers matchup-hunt from the 6th | `vl` / `vr` | a bat is scored on its **weaker** platoon side |
| starters get pulled at the first hint of a third time through | `pi000` vs `pi076` | how well an arm holds past 76 pitches |
| runs get scarce, late innings decide games | `lc`, `risp`, `ig07` | leverage and traffic |

`lc` (Late / Close) is the API's own high-leverage proxy: 7th or later with the
tying run at least on deck.

**These splits are small and are treated accordingly.** Median hitter has 49
late/close PA, median pitcher 27 batters faced. Clutch on 49 PA is noise, so the
leverage and RISP terms are regressed toward zero by their own sample
(`delta × n/(n+K)`, K=250 PA / 200 BF, keeping ~16% and ~12% at the median),
capped, and left as minority weights. Large samples carry the rating: hitters
power 35 / contact 25 / weak platoon side 20 / late-close 12 / RISP 8; pitchers
strikeouts 35 / HR suppression 22 / past-76 18 / late-close 15 / RISP 10. Every
card prints the raw split **and its sample**; an empty sample renders as a dash.
The rating appears on the board as the `Oct` column, context only.

**Nothing on this tab is priced, bet or graded beyond what the board already
does.** The ratings feed no ledger. `model.py` v42 is additive: HR and K math is
byte-identical to v41, so every graded ledger stays continuous.

The field comes from the API's own `clinched` flag, never inferred from win
totals. `fetch_playoffs.py --if-stale N` gates only the ~25 heavy split calls;
**the slate is refetched every run** because it changes daily. `--force`
overrides. Age is judged by git commit time, not file mtime, which
`actions/checkout` resets (see `fetch_odds.py` for the same lesson).

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

## Onyx Sports (the hub and the design layer, 10/26)

The installed app is **Onyx Sports** (`manifest.json`: name, `start_url: home.html`,
`id: ./` so existing installs update in place). `index.html` stays MLB at the root URL,
so old links and the pipeline are unchanged.

- **`home.html`** is the hub, a static page you edit by hand. No build step reads or writes it.
  - Sections: mint announcement bar, hero, a "tonight" strip, the seven sports (Basketball
    and Baseball live; NFL, College Football, NHL, Tennis and Golf marked coming soon),
    "what this is", gamecenter, the public record, the Model's Parlay, and the footer.
  - Live numbers come from same-origin data files: `data/nba/slate.json`,
    `ticket_lock.json`, `ticket_history.json` and `picks_history.json`. Each fetch fails
    soft.
  - Adding a sport means one entry in the `SPORTS` array.
- **`onyx.css`** is the onyxodds.com design system: tokens, bracket buttons, dot rules,
  pills, marquee, the hub layout, and a restyle of the sport sites.
  - It is linked **last** in each page head, so it wins ties without editing the sites'
    rules.
  - Fonts: onyxodds.com licenses ABC Schengen and FK Raster. We use free stand-ins in the
    same roles: Archivo at 125% width for display, Geist Mono for labels, Doto for raster
    numerals. Do not copy the licensed `.woff2` files into this public repo.
  - It also fixes the 761-1279px desktop header, which used to run 406px off-screen at
    768px.
- **`onyx.js`** draws the raster art (shapes filled with ramp characters that ripple
  around the pointer) on any `<canvas data-ox-art="…">`.
  - Shapes: the real Onyx wordmark and mark, plus the sport balls, court, diamond and field.
  - It animates only while on screen and draws one still frame for reduced motion.
- **`ui.js`** adds three things to each sport site: the Onyx mark in the header (links to
  the hub), "All Onyx sports" in the More menu, and the Onyx footer (sport links plus the
  giant raster ONYX).
- **`verify_pwa.js`** also checks the hub at 320px and 393px: manifest, status bar,
  header, all seven sports, no sideways scroll, and that the wordmark draws.

## Onyx Sports pages: NFL, college football, NHL, tennis, golf (10/26)

One engine, one template, one config per sport (`sports_common.SPORTS`). Each sport reads
and writes only `data/<sport>/` and `<sport>.html`. The pipeline step is
`continue-on-error`, so no sport can block MLB, NBA or another sport.

- **Pipeline:**
  - `sports_espn.py <sport>` writes `slate.json` in one shape for every sport. Team
    sports fill `games`; tennis fills `events` with their singles matches; golf fills
    `events` with the leaderboard.
  - For the NFL it also reads every final box score once into `player_games.json`. The
    first run backfills last season, which is the model's prior.
  - `sports_build.py <sport>` builds the page from `sport_shell.html`. It injects the MLB
    stylesheet (like `nba_build.py`), the sport key (`window.OX_SITE`, which `ui.js`
    reads for the bar, menu, search and footer) and `SD`.
- **Template:** Home, Games, Onyx Board, Plays and Model tabs. The page polls ESPN's
  scoreboard live: every 15s while anything is live, otherwise every 30s. Gamecenters
  by kind:
  - **Football:** the field with the ball spot, line of scrimmage and first-down marker,
    down and distance, win probability, scoring plays, drives, team stats and leaders.
    All from ESPN's `summary`.
  - **Hockey:** by-period scores, goals and team stats.
  - **Tennis:** live and finished singles matches by tournament, set scores and who is
    serving.
  - **Golf:** a searchable leaderboard with every round.
- **History:** `sports_history.py`, called by `sports_espn.py`, keeps final results in
  `data/<sport>/results.json` (NHL by day, NFL and college football by week, read once
  and remembered, with the last few days or a week re-read). Tennis keeps only the last
  45 days of matches. Older ones are folded into the Elo state `data/tennis/elo.json`,
  seeded once from 36,666 ATP and WTA singles matches since 2023, so the committed
  file stays small.
- **Onyx prices:** `sports_odds.py <sport>` runs in both pipelines between the slate and
  the build. It writes `odds.json` with Onyx main lines and share selections:
  - NFL and college football: moneyline, spread, total, player yards and receptions,
    anytime TD.
  - NHL: moneyline, puck line, total, player points and assists.
  - Tennis: ATP and WTA moneyline, game spread, total games. Unpriced matches are
    dropped; on 10/26, 57 of 66 matches were priced.
  - Golf: Onyx prices nothing, so there is no fetch.

  `tools/onyx_markets_probe.py` (the manual `odds_probe.yml` workflow, `job=probe`)
  reports what the Onyx book prices.
- **The model frame (`sports_lab.py`):** shared by every sport. It holds:
  - probabilities: normal, Poisson, negative binomial, no-vig fair price, the
    model/Onyx blend, EV;
  - the backtest gate: picks are live only when `data/<sport>/backtest.json` says
    `passed` for the model's current `VERSION`;
  - an append-only ledger, `data/<sport>/picks_history.json`, where odds are recorded
    when a play qualifies, graded off `results.json` (props off the box scores), with a
    $10-a-pick record. `validate_build.py` guards it never-shrink, like every other
    ledger.

  Each model module carries `VERSION` and a changelog citing its evidence, and the Model
  tab shows it.
- **Models:**
  - **Team sports, game lines (`team_model.py`):** offense and defense ratings by
    weighted least squares on final scores, with a recency half-life and a ridge pull
    to average.
    - Football: a normal margin and total.
    - Hockey: Poisson goals per side, with an overtime split; whole-number totals
      handle the push.
    - Parameters and tests live in `nfl_model.GAME_P`, `cfb_model.P` and `nhl_model.P`.
      Each was tuned on early-season games and judged on later games it never saw.
  - **NHL rebuild, tested 10/29 and not adopted (the page stays on v1 leans):** every
    test tuned before 1/15/2026 and scored on later games, 1,766 ESPN box scores.
    - Team ratings v1: the moneyline lane went 5-33 at Onyx's opening prices.
    - Skater points / assists (24k + 24k Onyx lines; per-60 rate decayed 30 games,
      shrunk 5 hours to position, x expected TOI, + power-play role and home ice):
      Onyx's price is sharper (log loss .6294 vs .6343), every edge size loses (-5% to
      -12%), and a 20/80 model / Onyx blend only matches Onyx.
    - Starting goalie (each team's usual #1 over 20 games vs who started; goals saved
      above the league rate per 30 shots): +7% on the tuning months, -12.6% on later
      games at the open. Onyx's opening lines already carry the starter.
    - Data note: about 2% of Onyx's historical opening prop pairs are not real two-sided
      lines (e.g. over +1400 / under -115: a ladder rung's over against the main
      under). An unfiltered NHL props run showed +58.8% at 8pp+ edges, all of it from
      those pairs. `tools/sports_backtest.py` already keeps only pairs with 0-12% vig
      (`sane`); any ad hoc backtest must do the same. Re-checked the live NFL receptions
      lane with the filter: 184-160 (+12.5%) at 5pp+ on 2026, unchanged.
  - **NFL player props (`nfl_model.py` v1):** projections as before. The chances come
    from spreads fitted to real Onyx lines.
  - **NFL receptions v5 and the opening-price lane (10/29):** `nfl_verse.py` pulls
    nflverse play-by-play and snap counts once a day into `data/nfl/nflverse.json`
    (current season + the last one, ~800 KB). v5 receptions = 50/50 average of the v4
    volume projection and `nfl_model.project_verse` (targets per team dropback, snap
    trend, team dropbacks x implied points and spread). 3pp+ value bets at Onyx's
    OPENING price: 2025 +2.5% (848), 2026 +17.6% (367); at the close 2025 -7.2%. So it
    runs as `sports_build.nfl_open_lane`: the first price seen for each receptions line
    goes to `data/nfl/opening.json`; a play is logged to `data/nfl/open_trial.json`
    (append-only, validate_build ledger list) only while the live line is still the
    opening one, every one that qualifies (no daily cap since v8, 11/1), graded off the box score.
  - **NFL v6: players who played without a touch (10/31).** Every NFL prop backtest
    before 10/31 graded a priced player off his ESPN box line and skipped him when he
    had none. But a player with snaps and no target or carry has no box line, and for
    him the under (or the TD "no") is a sure winner. Skipping those games flattered
    overs and yes bets. Re-run with nflverse snap counts (only no snaps = void, as Onyx
    grades it):
    - Anytime TD (8,540 priced player-games): priced players score 17.7% vs 22.0%
      implied. Value bets 5pp+ at the open lose (2025 -26.6%, 2026 -14.5%), and the v3
      50/50 blend loses to Onyx's price. Shown chance is now Onyx's price x .82 (fitted
      on 2025, calibrated on 2026); no TD is ever flagged as value. Red-zone / goal-line
      shares did not help.
    - Receptions trial lane (286 zero-target games added): overs 2025 -14.8%, 2026 +5.9%
      at the open; unders 2025 +6.1%, 2026 +20.1%. The lane now logs unders only
      (`nfl_model.TRIAL_SIDES`), and receptions overs are never a play or Top 10 entry.
    - Receiving yards: overs lose both seasons (-11.6% / -4.9%), unders flat; never a
      play now (`VOL_P["rec_yds"]["edge"] = 1.0`).
    - `tools/sports_backtest.py` now uses the snap counts in `data/nfl/nflverse.json` the
      same way, so future NFL prop tests count these games.
  - **NFL v11 market models (11/1).** `nfl_features.py` computes ~45 pre-kickoff statistics
    per player from nflverse weekly stats (`nfl_verse.py` now also stores
    `stats_player_week` as `wk` in `data/nfl/nflverse.json`) and snap shares; the same code
    runs in `tools/nfl_feature_screen.py` (the backtest) and the live build, so the site
    computes exactly what was tested. Per market, P(over) = sigmoid(a + b logit(Onyx no-vig)
    + sum c z(stat)); statistics chosen on 2025 (must help both halves out of fold), judged
    on 2026, coefficients refit on both (`nfl_model.V11`). Three lanes on trial at the
    opening price, 3pp+, logged to `open_trial.json` with a `lane` field and the `why`
    (each statistic's push in points): rushing yards unders, passing yards overs, pass
    attempts unders. Each new lane's first run marks every line already up as a baseline
    (`opening.json` `_lane_start`). Closing-price check: the edges mostly vanish, so they
    are opening-price lanes only. Re-run: `python3 -B tools/nfl_feature_screen.py --select`.
  - **College rushing yards unders (11/1, cfb_players v2, on trial).** `tools/cfb_feature_screen.py`
    runs the NFL v11 method on 2026 Onyx college props (one season, so chosen on lines
    before 10/1, judged after) with features from `cfb_players.MarketIndex` (shared with the
    live build). Rushing yards passed: log loss .6794 vs .6916; unders 5pp+ 33-14 before,
    47-20 (+31.7%) after; 3-5pp flat in both. Logged at 5pp+ at the opening price to its own
    ledger `data/cfb/prop_trial.json` (capture `prop_opening.json`), graded off the box; a
    player with no box line is a void (Onyx settles him at 0, so this undercounts unders).
    Receiving yards failed; receptions and passing yards had too few early lines to choose on.
  - **NBA assists unders (11/1, open_lanes open-v3, on trial).** `tools/nba_feature_screen.py`
    runs the v11 method on 49,000 Onyx 2025-26 lines (chosen before 2/1/2026, judged after).
    Points and rebounds: nothing beat Onyx. **Assists unders pass**: opponent assists allowed
    (vs league) and the line vs the player's usual range (last-10 sd); log loss .6845 vs Onyx
    .6857; unders 3pp+ 97-80 (+13.0%) before, 47-35 (+13.8%) after; 5pp+ 14-10. Built as the
    `ast_under` kind in `open_lanes.py` (statistics in `nba_market.py`, shared with the screen),
    logged at 3pp+ to `data/nba/open_trial.json`, graded off the box like the tracked props.
    The same change fixed `open_lanes.run` reading its capture file with `load(OPENING, None)`,
    which always returned None, so from 10/30 to 11/1 every run was a first look and no
    1st-quarter or first-basket play could be logged. NBA home back-to-back unders on
    game totals: +9% before February, -5% after; not adopted.
  - **NHL unders on a home back-to-back (11/1, nhl_model v2, on trial).** `tools/nhl_game_screen.py`
    screens ~60 team statistics from the NHL API boxscores against Onyx's moneyline, puck
    line and total (chosen before 2/1/2026, judged after). Nothing chosen beat Onyx, but the
    home team on a back-to-back helped total-goals log loss in both periods (2026 .6836 vs
    .6875). As a rule, every under on a home back-to-back: 2024-25 market prices 41-32
    +9.6%, Onyx before 2/1 54-35 +16.9%, after 26-9 +46.2%; close 38-29 / 21-8. Logged at
    the opening total and price by `sports_build.nhl_b2b_lane` to `data/nhl/b2b_trial.json`
    (capture `b2b_opening.json`); who played yesterday comes from the NHL schedule API by
    local date (ESPN results are dated in UTC, which misreads late games). Graded off
    `results.json`.
  - **NFL v12: three seasons and the wind (11/1).** `tools/nfl_feature_screen.py` now reads 2024 at
    market prices (`bt/nfl_2024_mkt.json`; receptions, receiving / rushing / passing yards) and
    nflverse play-by-play (`--pbp`: pass rate over expected, neutral pace, the defense's PROE
    and pace, wind / temperature / roof), trains on any seasons (`--train=2024,2025`) and
    judges on any (`--test=2024`). Passing yards overs failed on 2024 (7-16, -42.6%) and left
    the lanes; rushing yards unders held weakly (+2.5%). Wind held in all three seasons; as a
    rule, unders at 15+ mph won (passing yards 15-4 / 28-10 in 2024 / 2025). Onyx moves those
    lines as forecasts firm up, so the `wind_under` lane logs only while the kickoff forecast
    (`nfl_weather.py`, Open-Meteo, one batched request per build, `data/nfl/weather.json`) is
    15+ mph at an open stadium and Onyx still shows its opening price.
  - **NFL projections from usage, depth charts and injuries (11/1, tested, not adopted).**
    `tools/nfl_proj_test.py`: volume x efficiency (team attempts / carries from Onyx's spread
    and implied points, the player's target / carry / attempt share, regressed efficiency,
    snap-trend role) tuned on 2025, judged on 2026, ties a decayed average and loses to
    Onyx's own line in every market (MAE 2026: receptions 1.62 vs line 1.58, receiving yards
    21.7 vs 20.3, rushing 18.9 vs 17.3, passing 62.2 vs 57.8, attempts 7.6 vs 6.6); the snap
    trend tuned to zero. `nfl_feature_screen.py --role` adds nflverse daily depth charts
    (rank the day before, move up the chart) and weekly injury reports (targets / carries
    vacated by teammates ruled Out or Doubtful, own Questionable): no market's selection
    changed; vacated volume flips sign between seasons everywhere; depth rank for rushing +
    receiving yards helps both seasons (2026 -3.2 log-loss points) but not enough to pass.
    Onyx's lines already carry the public role news; the edges left are at the opening price.
  - **NFL cross-market statistics (11/1, tested, not adopted).** `--cross` adds Onyx's own
    opening lines in the player's other markets (a combo vs the sum of its parts, yards vs
    catches, passing TDs vs passing yards). Passing + rushing yards vs its parts sharpens the
    chance (2026 log loss .6885 vs Onyx .6931, 196 lines) but rarely makes a 3pp edge (7 bets);
    rushing + receiving yards' parts gap won in 2025 (+12.7%) and lost in 2026 (-11.6%).
    Receiving yards and passing TDs: nothing. No lane.
  - **Tennis vs Onyx (11/1, tested, not adopted).** `tools/tennis_feature_screen.py` rebuilds
    Elo, surface Elo, 14/45-day form and fatigue, games share and games per match walk-forward
    from 36,666 results and runs the v11 method on 15,491 matched Onyx lines (match winner
    5,059 / 6,581, total games 1,411 / 2,503, games spread 1,418 / 2,546; chosen before
    1/1/2026, judged after). Nothing beat Onyx on the unseen year: match winner .6009 vs .6000,
    total games .6927 vs .6909 (unders 3pp+ -15.5%), spread .6935 vs .6890. Onyx's tennis prices
    are efficient; tennis stays leans.
  - **NHL points and assists vs Onyx (11/1, tested, not adopted).** `tools/nhl_box_pull.py`
    pulls NHL API boxscores (ice time, shots, power-play goals, shifts, hits, blocks,
    position) and `tools/nhl_feature_screen.py` runs the NFL v11 method on 16,484 points and
    16,430 assists lines (chosen before 2/1/2026, judged after). No statistic passed: the
    best (opponent goals and shots allowed over 10 games, the team's win chance and the
    total) improve Onyx's log loss by 0.0003-0.0005, same sign in both periods, far below
    the margin. Onyx's NHL point prices are efficient; they stay leans.
  - **NFL 1st-half and 1st-quarter totals (10/31, tested, not adopted).** Onyx's 1H / 1Q
    lines (nfl_td.json, 391 games with nflverse quarter scores) against a walk-forward
    model: the empirical share of the full-game total each part carried, applied to
    Onyx's full-game line. 2025 (tune) at the open lost both markets (1H 2pp+ -9.2%,
    1Q -5.6%), so no rule carries forward; 2026 1H looked good (+15.8%, 64 bets) but
    the rule fails its tuning season. Line ratios match reality (1H line 0.505 of the
    total, actual 0.506). Always-under 1H: 2025 +1.8% (285), 2026 +12.9% (106): too thin.
  - **Rules lab history and splits (10/31).** `data/rules_lab/<sport>/<market>.json` (columnar, loaded per
    market) holds 825,148 priced lines: NBA 2024-25 (Onyx from Feb 2025 and market prices), 2025-26 with the
    model replay, 2026-27 to date, game lines, threes; MLB 2025-26 Onyx (home run yes, hits, total bases,
    strikeouts, game lines; MLB 2024 had no earlier prices); NHL 2024-25 market, 2025-27 Onyx props and lines;
    NFL 2024 market, 2025-26 Onyx; CFB 2024 market (73 games), 2025-26 Onyx with 2026 props; ATP tennis.
    Every row carries splits (`tools/rules_ctx.py`). Split test (logistic on Onyx's fair price + model + splits,
    trained on earlier periods, judged on the last; opening prices): no split adds information in NBA (3 seasons),
    MLB (2 seasons, 75k hits props), NHL props or CFB; small gains only on NHL moneyline (.6439 vs .6469, 230
    test games) and NFL receptions / rushing yards (.6864 vs .6876, .6890 vs .6921), too thin to change a model.
    Onyx already prices rest, travel, home and day / night. Rebuild: `python3 tools/rules_lab_build.py`.
  - **Ask Onyx test sets (10/31).** `tools/ask_corpus.py` writes `tools/ask_corpus.json` (482 phrasings: every
    sport x market x intent template plus 118 hand-written "how people type it" requests), and
    `tools/ask_holdout.json` / `ask_holdout2.json` are fresh sets scored once before any fix. `node tools/verify_ask.js
    [--holdout|--holdout2] [--slow]` runs them on today's boards: a query passes when the reading matches (sport,
    market, intent, count, side, prices, confidence, team, player, props only), every play returned honors it,
    and the answer is not empty while the board holds something that fits (day, price and side aware). Scores
    on 10/31: corpus 482/482; holdout 1 52/59 (88.1%) before its fixes; holdout 2 47/49 (95.9%) on first run. Run
    it after any `ask.js` change. Speed: boards ~220 KB gzipped, preloaded by the home page; ET day lookups are
    cached (dated searches went from ~1.1 s to under 15 ms); slowest query 51 ms.
  - **Ask Onyx, game lines and team names (10/31).** Every board now carries both sides of
    every Onyx game line (`sports_build.both_sides`; NBA game lines from `nba_build.write_top`,
    priced at Onyx's no-vig chance since there is no NBA game model) and each play's team
    full name (`tn`, from the slate), so "Ohio State spread", "Georgia Tech", "Buckeyes
    moneyline" resolve to the team and to that team's own side. `ask.js`: betting words
    ("sides", "props", "dogs", "lines"...) are never player names; "sides" = spreads and
    moneylines, "game lines" adds totals; "favorites" / "dogs" with no market = moneyline;
    "props" = player props only; a game line is one play per game and market (every total
    was named "Total", which kept one total across the board); a named team or player
    drops the standard-price floor; a ticket left short by the floor widens to -250 and
    says so; capital-letter abbreviations only ("MIN -200" is odds).
  - **Scorecard and rules lab (`scorecard.html`, 10/31).** One page for every pick lane on
    the site, graded in the browser straight from the ledgers (NBA props, Model's Parlay
    and opening trials; NFL receptions trial; CFB tracked and trial; the closed MLB 2026
    lanes from `data/archive/mlb_2026/` with the published filters: HR edge > 1.5pp, K
    projection beats the line by > 10%), plus NHL, tennis, NFL and golf as leans with
    their backtest verdicts. The rules lab (`#lab`) tests a rule (sport, market, side,
    price band, model edge) against `data/rules_lab.json`: 52,505 real Onyx open and close
    prices (NFL game lines, props and anytime TD; CFB; NHL; ATP tennis), each with the
    walk-forward model chance and the result, split into the tune and test windows the
    backtests use. Rebuild it with `python3 tools/rules_lab_build.py` (dev only, needs
    the local `bt/` pulls). A rule shows "worth a trial" only with 30+ bets in each
    window and a profit at the opening price in both. NBA history is not in it yet.
  - **College touchdown scorers in Ask Onyx (10/31).** `sports_build.cfb_td_board` puts every
    Onyx CFB anytime and first TD price on `data/cfb/board.json` (about 800 a Saturday).
    There is no college TD model: the chance is Onyx's price x `TD_SCALE` .82 (the NFL v6
    fit), first TD is the player's share of the game's first-TD prices x .9, and `lam`
    comes from the anytime chance for "2+ TD" questions. In `ask.js`, a "best value"
    search where nothing beats Onyx's price (every TD search, after v6) ranks by chance
    instead of by the least-negative edge, which would only surface longshots, and says
    so in a note under "Read as".
  - **NFL v7: rushing and passing yards never a play (10/31).** With zero-touch games
    counted, the v1 projection blended with Onyx's price makes Onyx worse every window
    (rushing 2026 open log loss .6951 vs .6921; passing .6955 vs .6934). A volume rebuild
    (share of team carries / dropbacks x team volume x implied points and spread x yards
    per carry / attempt) improved rushing MAE slightly (19.57 vs 19.78) but its 2025
    winner (unders 3pp+ +10.7%) lost 14.4% on 2026, and passing lost on 2025. Both are
    in `nfl_model.NO_VALUE` with receiving yards: projections stay, never plays or Top 10.
  - **NFL injury feed (10/31):** `sports_espn.fetch_injuries` reads ESPN's league-wide
    report each build (matched by ESPN athlete id, then name). Out, IR, PUP, NFI,
    inactive, suspended and doubtful players are left off the slate entirely: no
    projection, no lean, no TD chance, no Top 10 entry, no receptions trial play.
    Questionable players stay, tagged `inj: "Q"` (a Q badge on the page) and kept out
    of the Top 10. Fail-soft: no report means the slate runs as before (the build logs
    `nfl injuries: N ruled out left off the slate, M questionable tagged`). First run,
    week 9: 29 ruled out, 10 questionable; one ruled-out player (Brenen Thompson, LAC)
    still had live Onyx anytime and first TD prices. Not a model change (projections
    are unchanged for everyone who plays), so `nfl_model` stays v5; the volume share of
    a missing player is not redistributed (tested and left out in v5).
  - **NFL game lines from play-by-play (10/31, tested, not adopted):** opponent-adjusted
    offense and defense ratings in EPA per play (nflverse 2024-2026, win probability
    10-90% plays, half-life 60/120/240 days, ridge 100/300/1000), alone and next to the
    score ratings, fitted on 2025 and judged on 2026 weeks 1-8 against Onyx (440
    games). Does the rating explain what Onyx's line misses? Slope of (result minus
    line) on the rating: 2025 weeks 9+ spread open t 1.30, total open t 1.29; 2026
    spread open t -1.20, close t -1.46, total open t 0.56, close t -0.62. Model-alone
    log loss 0.730 spread / 0.725 total vs Onyx 0.694 / 0.690; a 20% blend still loses
    to Onyx on 2026. Wind (game-time, from nflverse) was not monotone (8-12 mph
    unders 36/57, 16+ mph 9/16) and is not known at the open. Nothing shipped;
    NFL sides and totals stay leans. Script: scratch only, numbers here.
  - **Baseline rule (both NBA and NFL opening lanes):** the system's very first capture
    (no `opening.json` yet) marks every price already on the board as a baseline and
    never logs it, because those lines may have opened days earlier. Only markets that
    appear after capture is running can produce plays.
  - **Tennis (`tennis_model.py` v1):** Elo, K = 150/(n+5)^0.4. On 7,875 matches in
    2026 it never saw, log loss is 0.627 and the favourite won 64.0%.
  - **Golf (`golf_model.py`, golf-v1, 10/29):** stays "model in the lab" because Onyx
    prices no golf market. `tools/onyx_golf_probe.py` (`odds_probe.yml`, `job=golf`)
    scanned every PGA, LPGA and DP World Tour fixture this week and the 60 days before:
    zero Onyx prices. The model is still built and tested against results:
    - **Rating:** strokes gained per round vs the field. Form (every round in four
      seasons, 240-day half-life, newcomers start at -1.0 with 4 rounds of evidence),
      plus course history (his residuals at this course, shrunk by 8 rounds, x0.25),
      plus course fit (ridge regression of residuals on his decayed stat profile:
      driving distance, accuracy, greens hit, putts per GIR, learned per course, x0.5).
    - **History:** `data/golf/history.json`, one row per player-event
      `[pid, name, finish, [SG per round], [z dist, acc, gir, putt]]`, four years.
      `sports_espn.py golf` appends each finished event (`golf_model.update`) and
      stores this week's course and cut rule on the slate. Rebuild from ESPN with
      `python3 golf_model.py data/golf/history.json 2023`.
    - **Simulation (in the page, `gfSim`):** 2,000 tournaments; each round is the
      rating plus N(0, 2.6) strokes, rounded to whole strokes so "top 65 and ties"
      cuts exactly (50 at the Masters and signature events, 60 US Open, 70 PGA and
      The Open, none when ESPN's `cutRound` is 0). Live, each player keeps his
      strokes and plays only the holes he has left.
    - **Backtest (walk-forward, 222 stroke-play events 2022-26, tuned 2023-24,
      scored 2025-26):** round error 3.17 (field average) to 2.79 (form) to 2.78
      (+ history) to 2.76 (+ fit); head to head 58.8% over 133k pairs; calibrated
      finishing chances (top 10 13.6% predicted, 12.3% happened; make the cut 59%
      to 61%, 81% to 81%). History and fit barely move the finishing chances.
    - **Tested and left out:** green type (bermuda / paspalum vs bent / poa, 63
      courses tagged where the grass is certain): no signal. Wind (Open-Meteo archive,
      playing-hours wind for every round): a player's windy-round record scored 2.7588
      and "wind widens the gaps" 2.7570 vs 2.7569 without, on 2025-26. Left out.
    - **Pipeline:** pure Python (`requests` only; the course-fit solve is a 4x4
      Gaussian elimination). Replaying all history takes about half a second.
- **Backtests (`tools/sports_backtest.py`, dev only):**
  - **Data:** historical Onyx opening and closing lines come from
    `tools/onyx_lines_pull.py` (`odds_probe.yml`, `job=lines`) into `bt/`.
  - **Method:** every game is priced only from results before it. The blend weight and
    the lane (markets, edge band, price band) are chosen on the tune window and judged
    on the test window.
  - **Pass bar:** the blend's log loss must beat Onyx's no-vig price on the lane's
    markets, the lane must win money at opening AND closing prices, and it needs at
    least 30 test picks.
  - **Output:** the result writes `backtest.json`, which the Model tab shows in plain
    words.
- **NFL backtest (10/26, 440 games, 14,032 player lines, 2025 tune, 2026 test):** not
  passed.
  - The moneyline blend beats Onyx's price (0.6549 vs 0.6577 log loss), but spreads,
    totals and every prop market do not.
  - No lane made money on the tune window.
  - The NFL stays leans only, and the page says why.
- **College football, NHL and tennis backtests (10/26):** none passed, so all three stay
  leans only.

  | Sport | Lines tested | Blend vs Onyx (log loss) | Best rule on test games |
  |---|---|---|---|
  | College football | 939 FBS games matched (of 2,911; FCS games have no ratings) | Spread 0.6934 vs 0.6947 and total 0.6897 vs 0.6927, both slightly better; moneyline 0.5192 vs 0.5167, worse | Moneyline: +5.4% at opening prices, -7.9% at closing |
  | NHL | 1,539 games | Moneyline, puck line and total all slightly worse | Moneyline: 5-33 at opening prices |
  | Tennis (ATP) | 5,149 matches | The best blend gave the model no weight | 38-51, -8.4% at opening prices |

  The college football spread and total edges are the lead worth building on.
- **College football spread lane (10/26, live):** run with
  `tools/sports_backtest.py cfb bt/cfb_lines.json --markets=spread,total`.
  - **Rule:** 20% model / 80% Onyx no-vig, edge 2-6pp, price -200 to +150, at most 6 a
    slate.
  - **Tune (2025):** 13-8.
  - **Test (2026):** 27-19 (+12.2%) at opening prices, 21-19 (+0.6%) at closing.
  - **Caveat:** the market restriction was chosen after the first run, on the same test
    games, and 46 picks is a small sample, so the public ledger is the real test. If it
    bleeds at closing prices, pull it.
- **NBA gamecenter (10/26):**
  - **Header:** the five-column header cannot overlap the score and the clock at any
    width.
  - **Box score:** ESPN's full box, roster-sized, with F. Last names and a team totals
    row. It has three fit-to-screen views:
    - Props: the live stat over our projection and the Onyx line, coloured by the lean;
    - Shooting: FG, FG%, 3PT, FT, +/-;
    - Hustle: REB, OR, DR, AST, STL, BLK, TO, PF.
  - **Shot chart:** tap a player (in the box or the chips) to filter the court to his
    shots. His panel shows his live props against the projection, the line and his
    pace, with a jump to his bet card.
  - **The floor:** the ten players ESPN marks `active` are drawn by jersey number.
    Offense sits at its spots, each defender a step inside, the last shooter where he
    shot from, and the ball with the team in possession. Who is on the floor is live;
    the spots are illustrative and labelled so.
  - **Refresh:** the open game refreshes every 5s.
- **Live experience (10/27):**
  - **Stacked header:** on phones the header stacks, like a scoreboard: each team
    gets a row with logo, full name, record and score, and the clock sits under them.
  - **See the shot:** every shot in the play feed has a "See shot" tap. It marks the
    spot on the court, draws its line to the rim, and labels the quarter, clock,
    distance and make or miss.
  - **Your players · live:** the card sits at the top of Home and Games.
    - It tracks every player in the parlay slip on his slip legs, plus anyone
      followed with "Follow" on his shot-chart panel (stored in localStorage
      `onyxNbaFollow`), on the model's side of his Onyx lines.
    - Each leg shows the live stat, a bar to the line, "needs N", the pace, and
      cashed or dead.
    - Alerts come as toasts through `window.OX_TOAST` from `ui.js`: every stat
      gain, a vibrate when an over cashes, and when an under dies.
    - Tracked games outside the open one refresh every 12s.
- **NFL / college football / NHL live tracker (10/27, `sport_shell.html`):**
  - **Box score:** compact and fits the screen. Football has passing, rushing and
    receiving tables; hockey has skaters (G, A, SOG, +/-, TOI) and goalies, with a green
    dot for who is on the ice.
  - **Player panel:** tap a player for his live number against every Onyx line on him,
    our projection, Follow, and Bet him on Onyx.
  - **Your players · live:** on Home and Games, stored in localStorage
    `onyxFollow_<sport>`. Follow from the panel or the star on any projection row. It
    shows each followed player's Onyx lines on the model's side: the live stat, a bar
    to the line, "needs N", and cashed or dead.
  - **Alerts:** toasts through `window.OX_TOAST`; followed live games refresh every 12s.
  - **Football plays:** recent plays (deduped across drives); tap one to draw it on the
    field, snap to whistle, with down, distance and yards.
  - **Hockey rink:** every shot, home team shooting right; goals as dots, other shots as
    crosses.
    - The skaters ESPN lists in `onIce` are drawn by jersey number (spots illustrative).
    - Filter by player with the chips, and tap a shot to mark it.
  - **Header:** the gamecenter header stacks on phones, like NBA's.
- **Tennis live tracker (10/27):** ESPN's tennis feed carries set scores, the server and
  results only, with no point-by-point or serve stats, so the tracker is built from those.
  - **Match center:** tap any match for:
    - both players with flag, seed and Elo, the live set grid, the server dot and sets
      won;
    - every Onyx line scored live: moneyline, game spread ("covering by", "needs",
      "missed by") and total games ("N games, needs M"), each tappable to bet;
    - the Elo lean and each player's last six results (`model.players` from
      `sports_build.tennis_players`).
  - **Your players · live:** follow a player and his live, next or latest match this week
    shows on Home and Games with his lines.
  - **Alerts (`tnAlerts`, on every 10s poll):**
    - a break of serve (one game since the last poll won by the receiver);
    - a set (from completed-set counts);
    - the over cashing;
    - the result.
- **Tennis live model (10/29):** the match center models the match game by game, since
  the feed has no point score.
  - **Fit:** each player's point-on-serve chance is fitted to Onyx's moneyline and its game
    total at once, as two form scenarios (favourite sharp, favourite flat) around a tour
    baseline (ATP .64, WTA .56).
    - One fixed strength over-projected totals by 2-3 games: on 10/29's 30 priced matches
      the over came out 60% against Onyx's 49%.
    - With the two scenarios, all 30 match both prices to within 0.2 points.
  - **Live:** the score reweights the scenarios (how likely each finished set, and the set
    in play, was under each), then holds, tiebreaks and sets are played out exactly.
  - **Shown:** win chance and its path (start, each set, every game seen), projected total
    and margin, each Onyx line's chance to cash, hold chances, and breaks per set.
    - Breaks per set come from who served every game, rebuilt from the current server and
      the games played.
  - **Also shown:** "serving for the set or match" and "up a break"; a court (surface by
    tournament, ends from the games played, server marked); a game log of holds and
    breaks seen while the page is open (`sessionStorage`).
  - Best of five only for ATP at the four Slams.
- **Gamecenter navigation (10/29):** every gamecenter (football, hockey, tennis) opens
  with a bar:
  - "‹ Scoreboard" (or "‹ All matches") closes it and scrolls to the list;
  - a strip of every other game switches straight to it.
  - The shared stylesheet clips the body sideways, which breaks `position: sticky`, so
    `gcFloatSync` pins a copy of the bar to the top once the original scrolls away.
- **Plays lead with spreads, totals and props (10/29):** a sport still in the lab now fills its
  plays with `sports_build.top_plays` instead of the backtested lane's market (which made NHL and
  tennis all moneylines).
  - **What qualifies:** every priced Onyx line where the blended chance beats the price by at least
    1pp and the play is more likely than not (`PLAY_MIN_PROB` .50).
  - **Selection:** one per game market or player, two per game, twelve per slate. Moneylines are
    down-weighted (`PLAY_PREF`).
  - **Display:** each card shows its confidence (the chance) and stays a lean until the sport
    passes its backtest.
- **NFL touchdown scorers (`nfl_model` v2):** anytime and first TD chances from Onyx's implied team
  points, opportunity share and own TD share (evidence in the changelog). A "Touchdown scorers"
  table runs on Plays and in each gamecenter, and anytime TD props can be plays.
  - `sports_odds.py` now also pulls `first_touchdown_scorer`.
- **Tennis games markets (`tennis_model` v2):** the game-level match chain prices total games and
  the game spread from Elo, so tennis plays are spreads and totals.
- **NBA scoreboard matches every sport (10/29):** NBA's games use the same cards, Onyx odds
  board and gamecenter bar as `sport_shell.html`.
  - The CSS is lifted verbatim, with `sbCard`, `nbNav` and `gcFloatSync` in
    `nba_shell.html`.
  - `nba_odds.py` now keeps both spread sides and the over and under with prices and
    selections, so every cell is tappable.
  - On every sport, cards show prices only before the game starts. Pre-game prices never
    sit on a live game (stale line); live games say "follow it live in the gamecenter".
- **Card names fit on phones (10/29):** iOS hyphenated long names ("Sacramen-to"), so
  names never break mid-word; `fitNames` steps a name's font down (not below 11px) until
  its longest word fits.
- **Sport ledger key (10/29):** `sports_lab.Ledger` keys a pick by game, market and side
  rather than by build date.
  - Weekly slates rebuild daily, so the date in the key re-logged PITT +7.5 on 10/26,
    10/27 and 10/28.
- **Golf live tracker (10/27):** pgatour.com-style leaderboard: Pos, Player (follow star),
  Total, Today, Thru.
  - **Click-down row:** clicking a row opens the player inline with:
    - round tabs;
    - a hole-by-hole course strip, each hole drawn by its par (from strokes and score to
      par), with his score on the green and eagle, birdie, par, bogey or double colouring;
    - out / in totals;
    - his tournament stats from ESPN's core API (CORS open): drive average, fairways,
      greens in regulation, putts per GIR, sand saves, birdies, eagles, bogeys and
      earnings.
  - **Your players:** a followed golfer's position, total, today, thru, last six holes
    and movement.
  - **Alerts:** every non-par hole, with a vibrate on an eagle, and taking the lead.
  - **Data:** `sports_espn.golf_round` stores every hole as [hole, strokes, to-par]; the
    page parses the live scoreboard into the same shape (`gfParse`).
  - **No shot positions:** shot-by-shot ball positions are PGA TOUR ShotLink, licensed
    and not public. The page says so instead of drawing invented shots.
- **My Onyx (10/27), `home.html#my`:** one place for everything a user follows, across
  every sport. Tabs:
  - **Live now:** every live game in NBA, NFL, CFB, NHL, MLB and tennis (set by set), plus
    the golf leader. When nothing is live it shows "Up next".
  - **My players:** every followed player across all sports with a live stat line from
    ESPN (NBA follows and slip legs, `onyxFollow_<sport>`, tennis by name, golf by id).
  - **My bets:** every Onyx bet opened from the app on this device.
  - **How bets are logged (`ui.js`):** `window.open` and share-link taps to
    `app.onyxodds.com/share` are logged to `localStorage.onyxMyBets` (last 200; an
    identical bet within 60s is a duplicate).
    - Each page's `window.OX_SELINFO(sel)` turns a selection into its label, Onyx price
      and game.
    - `window.OX_ONBET(rec)` auto-follows the player on a prop bet (or a tennis
      moneyline), so his live line starts tracking.
  - **Honest limit:** this is device-local and only sees bets opened from the app. It is
    not the user's Onyx account. Syncing real bets and settlements needs an Onyx account
    API, which is a product ask for the Onyx team.
- **Ticker pace (10/27):** every score and picks ticker scrolls at one speed (~38 px/s).
  `ui.js` measures each track after every refresh and sets its duration; a fixed 60s had a
  56-game CFB slate scrolling at ~240 px/s. Sport pages repeat short slates so the loop has
  no gap.
- **NBA on/off splits (10/28, model v7):** `nba_onoff.py` rebuilds every lineup from ESPN
  play-by-play (starters plus each substitution) and keeps, for every teammate pair, what
  each player produces per minute with the teammate on the floor and off it. A teammate OUT
  tonight moves the player's points / rebounds / assists by his own split, shrunk hard
  (`oo_k` 1,500 minutes) and applied lightly (`oo_a` 0.6). `data/nba/onoff.json` holds last
  season (seeded once with `tools/nba_pbp_pull.py`) and this season, grown by
  `nba_common.refresh_onoff` in both fetchers (fail soft; a failed fetch is retried, a
  malformed summary is skipped). The player card shows the split for each rotation
  teammate out tonight. Evidence in the v7 changelog: a small, steady gain.
- **Fresh NBA lines (10/28):** edges are only as good as the line. `nba_lines.yml` re-pulls
  only the Onyx NBA prices every 10 minutes through the evening and rebuilds `nba.html` with
  `NBA_LINES_ONLY=1` (no grading, no picks, no ticket changes: it never writes a ledger and
  commits only `data/nba/props.json` and `nba.html`). `nba_build` refuses to log a pick off
  prices older than `PICK_MAX_LINE_AGE_MIN` (20). `nba_odds` stamps `fetched` only on a real
  Onyx pull (a failed pull keeps the old time, so the age is honest) and drops a line Onyx
  delisted. The Plays tab shows the prices' age and flags them once they are stale.
  Scheduled crons for it never fired on 10/28, so it runs as a loop like the refresh: each
  run with a game tipping within 4 hours arms `nba_lines_chain.yml` (one sleeper, ~9 min),
  which starts the next run; every full refresh also starts it, and the cron stays as a
  third backup.
  Newest pull wins: when a push is rejected, the pipelines rebase preferring their own files,
  which once put 38-second-older prices back on main. `newest_lines.py` runs after every such
  rebase (refresh, daily build, lines) and, if main's Onyx pull is newer, keeps it and rebuilds
  `nba.html` in lines-only mode. Every deploy then uploads the latest main, not the run's own
  snapshot, so a run that deploys last cannot roll the page back.
- **Sport model breakdowns (10/27):** `sports_build.py` emits `model.engine` for every sport
  (the steps of a price, the factors and the pick lane, all read from the live model
  parameters and `backtest.json`), rendered on the Model tab. A sport still in the lab also
  gets `model.projected`: what its best backtest lane would play on this slate, shown on
  the Plays tab as "Lean · not tracked" and never written to a ledger.
- **College football** shares the football tracker. It was checked on a real final, PITT
  @ MIA 10/24: a followed receiver at 149 receiving yards, 14 tappable plays and 6 box
  tables.
- **Sport gamecenters:** the open live football or hockey game refreshes its summary
  every 6s, and the scoreboard polls every 10s while anything is live.
- **NBA combos:** the historical Onyx feed has no points, rebounds and assists combo
  lines for 2025-26 (0 of 1,223 games). Combos stay on the bet card labelled "not
  backtested" and stay out of picks and the Model's Parlay until there is a season of
  their prices to test.
- **Pregame gamecenter:** for football and hockey it shows:
  - Onyx lines, plus the model's projected score and win chance;
  - the model against every Onyx game line;
  - player projections and more Onyx player lines (top 12; the rest are on the Board);
  - season per-game team stats, the injury report and each team's last five.

  The score ticker uses MLB's `score-game` marquee styles.
- **Gate:** `tools/verify_sports.js` checks every page and tab at 390px and 1280px, and
  opens a gamecenter. CI runs it.

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

## NBA sister site (`nba.html`)

Points / rebounds / assists projections against Onyx prices, plus a projected
top-scorers board. Lives in this repo so it shares the Actions secrets
(`OPTICODDS_API_KEY`, `ODDS_API_KEY`) and the Pages deploy, but it is
**fully isolated from MLB**: its own scripts (`nba_*.py`), its own template
(`nba_shell.html` -> `nba.html`), its own data (`data/nba/`). It never reads
or writes `index.html` or any MLB data file. MLB's nav links to it, and it links back.

| script | job |
|---|---|
| `nba_fetch.py` | OpticOdds: fixtures (Onyx slug = `game_id`), box scores (`/fixtures/player-results`, several fixture ids per call; DNPs are absent), last season per player from `/fixtures/player-results/last-x` (cached in `prior.json`, ~160 new players per run), injuries (`out` / `gtd`), rosters (`/players`, cached daily). Falls back to `nba_espn.py` when the key is missing or `/fixtures` fails |
| `nba_espn.py` | ESPN public API backup, writes `data/nba/espn/` (ESPN ids, never mixed with OpticOdds ids). `cdn.nba.com` and `stats.nba.com` refuse datacenter IPs; ESPN does not |
| `nba_odds.py` | Onyx book (`onyx_odds`) via `/fixtures/odds` filtered to `player_points` / `player_rebounds` / `player_assists` / `moneyline` / `point_spread` / `total_points`. Main line = the pair flagged `is_main` (props carry an alternate ladder). Each side keeps Onyx's share selection uuid from `deep_link`, which is what bet buttons and the parlay builder open. The Odds API fills only player-markets Onyx did not price, throttled (90 min) because the key also feeds MLB |
| `nba_model.py` | v4 projection, changelog at the top (every change cites the backtest). Minutes (prior + this season, fitted to 240 per team so OUT minutes flow to the rotation) x per-minute rates (300-minute prior) x environment (team points fitted to the implied team total; rebounds / assists by pace and opponent) x a fitted bias scale. Negative-binomial over/under probability blended 20% model / 80% vig-free Onyx; edge vs the listed price |
| `nba_build.py` | prices projections, grades and extends the picks ledger, injects one `var NBA_DATA` into `nba_shell.html` |

**Picks ledger** `data/nba/picks_history.json`: append-only, odds and Onyx
selection frozen at the moment a play qualifies, graded from box scores
(W / L / P, void if the player never logs a minute or the game never goes
final within 3 days). Lane v2: Onyx price only, edge 2-8pp (20/80 blend),
price -180 to +150, projected minutes >= 24, no injury tag, at least 2 of
{last season, this season, last 5} on the pick's side of the line, max 2 per
game / 6 per slate, one per player.

**Backtest (the evidence for every NBA setting).** `tools/nba_backtest.py`
replays the 2025-26 regular season walk-forward through the live
`nba_model.project_slate` (2024-25 as the prior, no look-ahead; who played
comes from the box score, i.e. a known final injury report), scored against
OpticOdds box scores and the historical Onyx main lines (open + close). Data:
run the manual **NBA backtest data** workflow and download its artifact into
`bt/`. Tune on Oct-Jan, judge on Feb-Apr only. v2 on the test window
(players projected 20+ min, 6,437 player-games; 12,821 two-sided Onyx lines):

| | v1 | v2 | season-avg baseline | Onyx line |
|---|---|---|---|---|
| points MAE | 5.21 | 5.15 | 5.48 | |
| rebounds MAE | 2.03 | 1.99 | 2.05 | |
| assists MAE | 1.59 | 1.57 | 1.63 | |
| prop MAE (same props) | | 3.12 | | 3.05 |
| logloss on over/under | | 0.6893 (blend) | | 0.6898 |
| picks lane | 131-128, -3.4% | 74-63 +5.6% open / 53-48 +3.3% close | | |
| picks claimed vs hit | 59.8% / 50.6% | 54.2% / 54.0% | | |

Read it honestly: the Onyx line alone is a better single predictor than our
projection; the value is in the blend, which is calibrated within ~0-3pp
where 95% of props sit. ~100-140 test picks is not proof of profit (95%
interval on hit rate ~ +/-10pp); the live ledger decides. v1's 50/50 lane
was overconfident and lost money in the replay, which is why it was replaced
before it posted a second night. Re-run the backtest after any model or lane
change and quote its test-window numbers in the `nba_model.py` changelog. `validate_build.py` guards it with the same never-shrinks
rule as the MLB ledgers.

**v4 (three seasons of history).** Every player's prior is his last three
seasons of ESPN season totals (`data/nba/history.json`, 8 seasons kept for
the age-curve fit; `nba_common.refresh_history` pulls each past season once
and re-reads only on a new season), weighted 6/3/1, aged on a curve fitted
from consecutive seasons (`nba_model.fit_aging`, applied at half strength),
regressed 250 minutes toward his role (position x minutes band,
`role_table`). Rookies start from their role. Team pace / ratings start 80%
from last season's team (`team_history`). Matched to OpticOdds players by
ESPN id (the headshot map), then name; the one-season box-score prior is the
fallback. Tune / judge with `tools/nba_history_pull.py` then
`tools/nba_backtest_hist.py` (tunes on 2024-25, judges on 2025-26, reports
the first 10 team games, switchers, young, missed-season and rookie groups).
The drawer shows each player's seasons and the weighted baseline.

**v3 (role check + tracked context).** Props where projection and line are
more than 1.5 sd apart (`nba_model.role_gap`) are a role disagreement, not an
edge: the board shows "role check" and the picks lane skips them
(`PICK_MAX_GAP`). Usage rate, utilization, plus-minus, team pace and
ORtg / DRtg / net are tracked and shown (board drawer, gamecenter, Model tab,
fed by `nba_build.engine_card`) but carry no projection weight: each was
backtested alone and jointly and none beat v2 on the held-out months (the
joint retune overfit). Box rows carry fga / fta / tov / plus-minus in slots
10-13; `BOX_VER` / `PRIOR_VER` in the fetchers force a one-time re-ingest when
that format changes. The Model tab reads its weights from `D.engine`, so its
numbers cannot drift from the code; its evidence and history copy
(`ENGINE_NOTES` in `nba_shell.html`) is updated by hand with the changelog.

**Gamecenter live court.** The open live game polls ESPN's summary every 8s:
shot chart from play coordinates, possession inferred from the last decisive
play (ESPN publishes no NBA possession field), last play and play-by-play.
Headshot rings judge the model's lean: overs go green once they clear, unders
stay lilac until the final then go green, red the moment an under is beaten.

**Plays tab (NBA).** The recommended plays, built like MLB's Edge Plays. Tracked picks
(`D.picks`, logged by `nba_build`) are ranked cards with:
- a conviction badge. It ranks the screens a pick cleared (edge, form reads, win chance)
  and is not a backtested hit rate.
- the logged price, plus Onyx's current price when it has moved;
- win chance, implied, edge and EV per $10;
- the form reads with ✓/✗, and the last games charted against the line;
- Add to parlay and Bet on Onyx buttons.

Tapping a card opens the player's bet card on that market. Below a divider, the watchlist
re-runs `qualifies()`'s screens in the page (`plMisses`) on every other priced line for
rotation players. It ranks them by fewest failed screens and names the screen each one
missed. They are never picks and never graded. Home pick cards, scorer cards, and Props
Board, Top Scorers and box rows are all tappable through to the player.

**Player card (NBA).** One card with two faces that flips like a video-game
sports card (`pcOpen` / `pcFlip` in `nba_shell.html`; Player | Bets toggle,
sideways swipe, or F). A name opens the **Player** face (projection, why
this number, seasons, last 5); a prop chip opens the **Bets** face. Phones get
a full-height bottom sheet (pull down to close), desktop a centered card that
tilts with the pointer; reduced-motion users get a crossfade. The face turned
away is `inert` (3D backfaces still hit-test, which swallowed clicks on
desktop). The Bets face is rendered once per market and then only patched
(`bcUpdate`): on 10/26 a full re-render replaced the slider under the finger
and a drag moved one rung. The slider and the chart both scrub in 0.1 steps;
between Onyx lines they show the model chance and "not offered", release
snaps to the nearest line you can bet, with a haptic tick on each Onyx line.
The side you pick (default: the model's lean) sticks across over-only rungs.
The slider is a custom rail on the **chart's own scale** (`bcScale`). The thumb, chart
marker and a tick per Onyx line share one mapping, and the line chips scroll with the
finger. Before 10/26 the native slider used the ladder's scale, so its thumb sat up to
60px from the line it showed. `verify_nba.js` fails if they drift more than 2px apart.
The Bets face lists every market Onyx prices on him (points, rebounds, assists, made threes,
double-double, triple-double; verified 10/26), search, and a slider over
Onyx's alternate ladder. `nba_odds.py` keeps the ladders
(`props.json` → `ladder: [[line, over, over_sel, under, under_sel]]`,
alternates are over-only); `nba_build.bet_ladders` adds per rung the model
P(over) and the blend (20% model / 80% Onyx fair, margin measured on the
two-sided main line). The card opens on the **main line, on the side the
model projects**; if Onyx offers only the over and we project under, it says
so. The "best value" banner only recommends points / rebounds / assists
lines priced -200 to +200 (the calibrated zone); threes use an unfitted
shape (`prob_over_fg3`) and DD / TD are price-only, never recommended.
`verify_nba.js` opens both faces, flips, checks the slider survives an input
event, shows "not offered" between lines and snaps on release.

**App shell (`ui.js`, both sites).** Loaded `defer` by `shell.html` /
`index.html` and `nba_shell.html`, after each page's own script. It builds
the phone bottom bar and the More sheet (every page as a tile, search over
pages and players, MLB / NBA switch, parlay builder, share, What's new),
wraps `gotoTab` and `renderParlaySlip` (active state, parlay toasts), and
owns the status-bar fix: `--sat` / `--sab` carry the safe-area inset
everywhere, and when an installed iPhone app reports 0 it measures that and
sets the real height (the 10/25 "menu cut off, nothing clickable" bug, plus
two old phone rules that zeroed the header's top padding). The status bar is
the solid `black` style: with `black-translucent` the page draws under the
bar, where iOS blurs and dims a band that faded the header on Dynamic Island
phones; the translucent fallback (59 / 47 / 20pt) stays for safety. Off-season the
MLB build leaves `index.html` untouched, so shell edits there must be
applied to `index.html` too. Gate: `tools/verify_pwa.js` (CI).

**Design:** `nba_build.py` copies the MLB stylesheet out of `shell.html`
into `nba.html` on every build (the `/*MLB_CSS*/` placeholder), so both sports
share one design system and the NBA page uses the MLB components as-is:
score ticker, home hero and stat cards, gamecenter (`.sb-*` game cards,
`.gc-header`, `.gc-hs` headshot row, `.gc-line` line score, `.gc-betbar`),
and the `.pb-*` parlay slip. Team logos are 80px PNGs baked into
`data/nba/team_logos.json` (`tools/nba_make_logos.py`); headshots come from
ESPN's resizing CDN, matched to OpticOdds players by team + name once a day
(`data/nba/headshots.json`), with the OpticOdds image as a fallback. Live
scores, quarter line scores, box scores and win probability are polled
client-side from ESPN's public scoreboard / summary (15s while a game is
live). **First basket** (`fbModel` / `fbCard` / `fbLeans` in `nba_shell.html`, lean only): the
team that wins the opening tip scores first 65% of the time (2,428 games); each team's jumper is
the starter with the most tips in `data/nba/jumps.json` (`nba_jumps.py`, seeded from the 2024-26
play-by-play, updated by both NBA fetch paths), tip chance (won+2)/(jumped+4) against the other;
the five starters (ESPN's posted lineup, else the most regular starters) split the team's share
by ((FGA x games + 0.9) / (minutes x games + 30))^0.75 (`season.fga` from the box rows). Onyx's
`first_basket_including_ft` price rides along in `nba_odds.py` (`props.json` players[].fb).
Value = model at least 20% over Onyx's implied chance. Backtest (fit 2024-25, 1,075 Onyx-priced
2025-26 games): +41.3% ROI on 421 bets at the opening price, +19.8% at the close, but -4.4% at
the close after mid-January (open-v2 with the first-shot share: +38.3% on 533 at the open); Onyx's price is slightly sharper on log loss. Shown in the
gamecenter and as "First basket leans" on the Picks tab, never tracked. **On trial at Onyx's opening price** (`open_lanes.py`, `data/nba/open_trial.json`, append-only
and in validate_build's ledger list): every edge we found beats Onyx's first price far more
often than its last, so the full refresh (never the 10-minute lines-only run) writes the
first price it sees for each 1st-quarter total and first-basket market to
`data/nba/opening.json` (once, timestamped) and logs a play only when the model beats that
opening price AND the live Onyx price is still the opening one, so every logged play was
bettable at its logged odds. Lanes: 1Q total (25.4% of the game total, sd 12, 3pp+) and
first basket (20%+ over implied, two per game at most). Graded from ESPN (1Q line score;
first scoring play's athlete id). Shown on the Picks tab as "On trial · Onyx opening prices"
with its own record. **NBA deep dive (10/30, open-v2):** ESPN's play-by-play carries every
shot's type and distance, the three referees and the venue, so 2,435 games (2024-26) were
pulled and four new reads tested against the v7 projections and Onyx's 2025-26 OPENING
prices (fit before February, judged after): shot-quality "luck" (made vs expected points by
shot type and distance), referee crews (free throws, pace), rest / travel / altitude, and
for first basket each starter's share of his team's FIRST shot. Only the last one earned its
place: first-basket log loss 2.2760 -> 2.2694 on unseen games, and at the opening price
(edge 20%+) 57-476 +38% (~204u) against 45-376 +41% (~174u) before. Shot luck improved points
MAE slightly (5.354 -> 5.343) but did not move the props lane beyond noise; referees, rest and
travel did nothing for props or for game totals (refs called totals 45% before February, 58%
after: noise). Production: `nba_jumps.py` now also records each final's ten starters and both
teams' first field-goal attempters (`st` / `fs` in `data/nba/jumps.json`, seeded 2024-26) and
`first_shots()` turns them into [starts, first shots] (this season x1, last x.5); `open_lanes.fb_probs`
and the page's `fbModel` (`D.fshots`) use them identically. **Quarters and halves**
(`qhCard`, lean only): each read scales Onyx's own full-game line to the period (1Q total
25.4% of the game total, 1H 50.5%, 1Q margin 34% of the spread; sd 12 / 18 / 11, tuned on
Oct-Jan 2025-26 for honest chances). Onyx's `1st_quarter_total_points`,
`1st_half_total_points` and `1st_quarter_moneyline` ride along in `nba_odds.py` (game
`q1_*` / `h1_*` keys). Against 1,197 Onyx-priced games (rebuilt 1Q / 1H scores match
Onyx's finals in 1,195), scored on Feb-Apr: the 1Q total beat Onyx's price (log loss
.6862 vs .6918 open, .6870 vs .6924 close; 3pp+ edge 84-66 +7.5% open, 81-70 +3.3% close,
promising, not proven); the 1H total (.6913 vs .6905) and the 1Q moneyline (.6487 vs .6485
close) did not. Onyx's period lines are well set on average (1Q line 25.33% of the game
total at the open vs 25.46% scored). Only the 1Q total shows a "lean" flag. **Live pace**
(`livePace` / `paceOver` / `paceCard` in `nba_shell.html`): once a
game tips, every prop shows where it finishes from where it stands, and the gamecenter's
Live pace card lists every Onyx line with the chance the model's side lands from here.
Final = current stat + rest-of-game minutes x rate. Minutes left use his share so far
blended with his projected share (96 minutes of evidence), cut for starters and lifted for
the bench past a 12-point margin late. The rate counts tonight's stats as that many minutes
of evidence against the model's per-minute rate (pts/reb 128, ast/3PM 192): one hot half
rarely carries. Backtested on 342,428 checkpoints (every 6 minutes of 3,096 ESPN
play-by-play games), fit on 2024-25 and scored on 2025-26: final-line error vs the old
50/50 pace number fell pts 3.66 to 3.13, reb 1.51 to 1.27, ast 1.03 to 0.89, 3PM 0.65 to
0.58. Chances are a negative binomial (variance a*mu + c*mu^2, plus a 0.65 logit slope on
points) calibrated within about 3 points on the held-out season. The game clock comes from
the scoreboard (`LIVE[gid].per/.clk`; under a minute ESPN sends seconds only). Fouls are
not in the play-by-play archive, so foul trouble is not modeled yet. The **Top Scorer Parlay** (home + Top Scorers tab) takes tonight's
highest projected scorers, one per untipped game, whose Onyx points-over is
priced and not leaned against by the blend, and opens them as one Onyx slip.

**Pipelines:** `refresh_build.yml` and `daily_build.yml` run the three NBA
steps after the MLB build, each `continue-on-error` with its own timeout, so
an NBA problem can never block or delay MLB. CI builds `nba.html` from
committed data and runs `node tools/verify_nba.js` (six tabs at 390px and
1280px, plus both faces of the player card).

**Dates:** the NBA slate uses the same game day as MLB (ET minus 4h).

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
| `home.html` | Onyx Sports hub, the PWA start page (static, hand-edited) |
| `sport_shell.html`, `sports_*.py`, `nfl_model.py` | NFL, college football, NHL, tennis and golf pages: one template, one engine; `data/<sport>/` |
| `nfl.html` … `golf.html` | built sport pages (generated every run; never hand-edit) |
| `onyx.css`, `onyx.js` | Onyx design layer and raster art, shared by every page |
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

## CI and the build gate

`validate_build.py` is the gate. It runs **after** `auto_build.py` + `update_stats.py`
and **before** the commit step in both `refresh_build.yml` and `daily_build.yml`, and it
is not `continue-on-error` — a non-zero exit blocks the commit, so the previously
deployed page stays live rather than a broken one replacing it. It checks:

1. **Structure** — the injected globals exist, parse, and carry the keys the shell reads.
2. **Lineups** — nine bats a side, slots 1-9 exactly once, nobody batting twice. Batting
   slot drives expected PAs, so a duplicated or missing slot silently misprices every
   prop in that game. It also logs the lineup-source split each run.
3. **Ledgers** — the graded record may grow, never shrink (hard rule 6, enforced by
   diffing row counts against git HEAD instead of trusting everyone to remember).

`ci.yml` runs on every pull request: it builds from the committed data (no secrets, no
network fetches, so a flaky upstream API can never fail a PR), runs the validator, then
runs `tools/verify_shell.js` headless across all ten tabs. Before this the repo had **no
pull-request check at all** — every merge was verified only by whoever was careful that
day.

## Verification discipline (non-negotiable)

Before shipping any shell/model change:

```bash
rm -rf __pycache__ && python3 -B auto_build.py && python3 -B update_stats.py
npm install playwright-core --no-save        # once per container
node tools/verify_shell.js                   # checks the local build
node tools/verify_shell.js --live            # checks the DEPLOYED page
```

`tools/verify_shell.js` is the gate: it serves the repo on :8901, loads
`index.html` at 390x844, reads every typeof-guarded global, calls `mktHist()`,
walks all **ten** tabs, greps rendered text for `undefined` / `NaN` /
`[object Object]`, and exits non-zero on any uncaught page error. Run it before
you push and again with `--live` after the deploy lands.

Three things the script handles that a hand-rolled probe gets wrong. Each one
cost a cycle on 9/23:

- **Switch tabs with `gotoTab()`, never by clicking `[data-tab=...]`.** At 390px
  several tabs exist only in the hamburger drawer, so clicking the nav silently
  skips them and the probe passes on tabs it never opened. There are **10** tabs
  (home, gamecenter, board, power, pitchers, record, markets, rankings, model,
  playoffs).
- **Abort every off-origin request** (`page.route`) or the probe hangs on Google
  Fonts.
- **`--live` cannot navigate to `https://` directly from a cloud session.** The
  agent proxy terminates TLS with a CA Chromium does not trust, so `page.goto()`
  fails `ERR_CERT_AUTHORITY_INVALID`. The script curls the deployed bytes (curl
  *does* trust the proxy CA) and serves them locally. **Do not "fix" this by
  disabling certificate checking.**

Verifying the *deployed* page is a separate step from a green build, not a
formality: on 9/23 the fix was committed to `main` and the site was still
serving the old bundle while the Pages deploy job ran.

A local build touches only `index.html` when the committed data is current — if
it also rewrites files under `data/`, something re-fetched or re-graded, and
that belongs in its own commit, not bundled into a shell change.


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

## Today's top 10 and the Plays tabs (10/30)

Jordan: "what's the point of a model if there's no value to it". The tracked lanes stay
strict (most nights they post nothing, by design), so every page now leads with the
model's best plays of the day, clearly labelled, and the home page ranks one Top 10
across every sport.

- `daily_top.py`: each build (`nba_build.write_top`, `sports_build.write_top`) writes
  `data/<sport>/top.json`: Onyx main lines priced **-150 to +150** where the sport's own
  blended chance is at least the price's implied chance and 50%+, for games not yet
  started. Each row is tagged `tracked` (a graded pick), `trial` (logged at the opening
  price) or `lean` (the model's read, not graded). NBA: props for 28+ minute starters and
  the 1st-quarter totals the on-trial model reads.
- `home.html` `#top10`: reads every sport's file, drops started games and anything more
  than three days out, ranks by confidence, at most 4 per sport and 2 per game (the rest
  fill in on a quiet night), and links each to its Onyx selection.
- Plays tabs: NBA opens with "Today's best plays" (the same list) and a "what we track"
  strip (tracked picks, on trial, the Model's Parlay); the tracked-picks banner follows.
  The sport pages lead with the plays (a live sport: tracked picks, then "More plays"),
  then the on-trial lane and record, with "How this model works" moved to the bottom.
- The Model's Parlay legs are now **-150 to +150 with 28+ projected minutes** (was -400 to
  +150, 24+): Jordan's call, -179 / -195 legs are not on every book. Replay in
  `nba_build.py` beside `TICKET_PRICE`.

## Saved picks (10/31)

Jordan: "save a pick local so you can follow it the rest of the night by clicking it".
`saved.js` (loaded by `home.html`, `nba_shell.html`, `sport_shell.html`) keeps one
localStorage list, `onyxSaved`, and draws the star button (`OnyxSaved.btn(pick)`) on the
home Top 10, the NBA "Today's best plays" and tracked pick cards, and every sport page's
play cards. A pick carries what is needed to follow it: sport, game id, team, kind (prop /
spread / total / ml), market, side, line, handicap, player or team name (`daily_top.entry`
writes the same fields into `top.json`). The home page's My Onyx opens on **My picks**
(`myPicks` / `pkTrack`): ESPN's scoreboard gives the score for game lines, the summary box
gives the player's live number for props (NBA pts / reb / ast; NFL receptions, receiving,
rushing and passing yards, anytime TD) and the 1st-quarter total, with Winning / Losing
live and Won / Lost / Push when settled (an over that has cleared, or a 1st-quarter total
after the 1st, settles early). Tapping a pick opens its game. Picks clear 36 hours after
their game starts. Device-only by design: nothing is sent anywhere.

**Held pregame lines (10/31).** Onyx takes pregame player props down at tip, so a live NBA
game's Points watch said "no line". `nba_build.hold_tip_lines` keeps each player's last
pregame main line for the day in `data/nba/tip_lines.json` (written by full and
lines-only builds; `nba_lines.yml` commits it) and a tipped game shows it marked
`closed`: selection ids stripped, `propLeg` returns nothing for it, so it is shown but
never a bet button, a pick, a Top 10 play or a parlay leg.


## Ask Onyx (10/31)

Jordan: type what you want ("3-leg parlay, NBA points overs, minimum odds -200", "player most
likely to score 2 TDs", "your favorite correlated SGP", "most value in college football") and
it builds it. **The AI never picks plays.** It only turns the sentence into a search spec;
`ask.js` runs that spec against today's boards, so every answer is a real Onyx line with our
model's number on it.

- Boards: `daily_top.write_board` writes `data/<sport>/board.json` on every build: every priced
  Onyx side (any price) with its blended confidence, edge, tag (tracked / trial / lean),
  selection id, and for NFL anytime-TD props `lam`, the expected touchdowns, so 2+ TD chance is
  1 - e^-lam (1 + lam). NBA rows skip held (closed) lines.
- `ask.js`: the spec (`intent` list / parlay / sgp, count, sports, markets, side, price bounds,
  confidence and edge floors, player, team, sort conf / rec / edge / price / two_td). Defaults
  are mainstream: no parlay or SGP leg shorter than -150 and no single shorter than -200 unless
  the request names its own odds. "Recommended" ranks tracked picks, then on-trial plays, then
  confidence plus value. SGP: each game gets one storyline from its best leg (shootout: the over,
  scorers' overs, the anchor team covering; grinder: the under, unders), only legs that fit join,
  and the page shows the product of chances as a floor (correlated legs hit together) and says
  Onyx prices SGPs itself.
- Language: a built-in parser covers the common phrasings with no AI at all. When `ai.json`
  holds a URL, the sentence goes to the relay first and the parser is the fallback.
- Relay (OpenAI since 11/1): `ai/worker.js` (Cloudflare Worker, plain `fetch` to OpenAI's chat
  completions with a strict JSON schema, 20 requests a minute per visitor). Two calls per question:
  the spec (with `say`, one line back to the bettor) and, after the answer renders, `explain`, a
  short read on the legs from their own numbers (conf, price, edge, TD model, tag). Follow-ups:
  ask.js sends the previous request, spec and legs (`ctx`), so "swap leg 2", "make it +500" and
  "same but unders" edit the last answer; `exclude` drops named players. Nothing learned is lost:
  ask.js also sends the built-in reader's spec (`hint`) and the AI starts from it, and the AI's
  spec still goes through `normalize()` and `run()` (price floors, 50% legs, one per market, TD
  favorites by the TD model). Deployed by `.github/workflows/ai_worker.yml`, which also writes
  `ai.json`. Needs, in the repo's Actions settings: secrets `OPENAI_API_KEY`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; optional variable `AI_MODEL` (default
  gpt-4.1-mini). The key is never committed. Set a monthly budget on the OpenAI account: the page
  is public. With `ai.json` live, `node tools/verify_ask.js` runs the 500-query corpus through it.

**Live tab (11/1).** `home.html#live`, plus Ask Onyx for any "live" question or a request whose
teams are playing now. `live.js` reads every game in progress off ESPN (NFL, college football,
NBA, NHL, ATP/WTA) and gives our live numbers: the chance each side wins, our spread and total
from here, and how far the game has swung from Onyx's pregame line. Models: football and NBA
play the rest of the game as a normal draw around the pregame spread and total (full-game SDs
NFL 13.5/13.5, college 16/17, NBA 12.5/18) scaled by the share of the game left; NHL is Poisson
goals for the time left, the rates split to match the pregame moneyline (OT a coin flip); tennis
plays out the remaining sets from a set-win chance fitted to the pregame match price. Each
reproduces the pregame price at the start. The pregame line comes from
`data/<sport>/pregame.json` (`daily_top.keep_pregame`: every game's last line captured before its
start, kept 36 hours), because the board drops a game once it starts.
Onyx does not put in-game prices in our feed: `tools/onyx_live_probe.py` (odds_probe job=live,
11/1 21:38 UTC) found 0 priced rows on all 15 games in progress while not-started games on the
same call had 1786 (BKN @ IND) and 193 (EDM @ NYR). So the tab shows our numbers, not edges or
bet buttons, says so, and links to the live price in the Onyx app. The live models are not
tested against in-game prices, so nothing live is a pick.

**10/31 follow-ups.** A parlay spreads across games first and, when the board is short of
games, fills its remaining legs from games it already uses (an SGP+, labelled on the ticket,
never one player twice, one game line of each kind per game). My bets (`onyxMyBets`, ui.js and
home.html) and saved picks (`saved.js`) both clear themselves after 24 hours.

**Ask Onyx without AI (10/31).** Jordan chose no accounts and no keys, so the built-in reader
(`ask.js` `localSpec(q, board)`) does the language. It reads the request against today's boards:
every player with a line (full name, a last name or first name only one player has), team
nicknames and abbreviations (NBA, NFL, NHL), markets in everyday words (boards, dimes, catches,
QB, carries, TD scorer, PRA, puck line, straight up), odds in any wording ("-200 or better",
"no -150 juice", "+300 or less", "even money", "plus money", "dogs", "chalk"), counts ("4
legger", "a couple", "a few", "double"), days ("tonight", "Sunday", "this weekend") and asks
("lock of the day", "what do you like", "best bet", "most value", "longshots", "who scores
the most points"). A player question lists every line on him, the model's side of each. The AI
relay (ai/) stays in the repo, unused unless ai.json is ever filled in.


**Ask Onyx, wider (10/31).** Names: a full name wins ("Luka Garza"), then star nicknames
(Giannis, LeBron, Steph, KD, Wemby, SGA, Joker...), then last or first names and one-letter typos
("luke", "jokick"), always resolving to the most prominent player (NBA points a game from
`data/nba/prior.json`; NFL by the size of his lines); team and everyday words never match a name.
A star with no line right now gets "No Onyx line on X right now". New asks: round robins
("round robin 4 picks by 2s": every combination as its own ticket), payout targets ("parlay that
pays +500"; with a leg count each leg carries its share), first TD (NFL), first basket and
1st-half totals (NBA, both now on the board), "top / leading rusher, passer, receiver, scorer",
"who will rebound the most", over-and-under questions (both sides), and "total receptions" as a
player prop. The relay's schema in `ai/worker.js` carries the same fields.

**College football v2 and an all-sports home page (10/31).** `cfb_model` v2 turns totals on
(`NO_TOTALS` off) and `data/cfb/backtest.json` carries two lanes (`"lanes"`), each with its own
blend weight: spreads (20%, 27-19 +12.2% open / +0.6% close on 2026) and totals (30%, 45-26
+21.0% open / 28-20 +11.9% close; 2025 tuning 34-29 +3.3%). `sports_build.model_frame` runs
every lane, re-pricing the slate at each lane's weight (`rows_for`). Home page: the strip under
the hero counts every sport from the ESPN scoreboards (games today, plays priced today, next
start, sports on today and how many models are graded), and the Top 10 takes only games on the
site's day (ET, rolling at 4 AM), so Sunday's NFL waits for Sunday.

**NHL expected goals, tested and not used (10/31).** Every NHL shot since 10/2024 from the NHL
API (3,008 games): a shot model on 2024-25 (distance, angle, shot type, strength, rebounds,
empty net; log loss 0.223 vs 0.254 base) turned into walk-forward team xG for and against, Poisson
prices for moneyline, puck line and total, blended with Onyx's no-vig price. Before 1/15/2026 the
blend beat Onyx (moneyline 0.6864 vs 0.6896 at w .5); after it, and on 2026-27 so far, every weight
above 0 was worse than Onyx alone and every lane lost (2026-27 moneyline -11% / puck line -7% at
opening prices). NHL stays leans. Also re-tried 10/31 with market-restricted lanes: NFL game lines
(spread / total / moneyline: tuning windows all negative, 8-14 test picks) and tennis moneylines
(-8% open): neither passes.


**College football totals on trial (11/1).** Jordan uploaded RotoWire and SaberSim projections
for the 10/31 main slate. Sides agreed with SaberSim within 3.0 points on average; totals ran 4.2
points hotter, and 6-11 points hotter on the games the totals lane picked (FLA@UGA, ASU@BYU,
OSU@USC). With 2025's totals at closing prices (-20.3%) the lane is weaker than its 2026 numbers
alone suggest, so the totals lane is `"trial": true` in `data/cfb/backtest.json`: graded lanes
skip it, and `sports_build.team_open_lane` logs it only at Onyx's opening price (first sight in
`data/cfb/opening.json`, baseline rule as NFL) into `data/cfb/open_trial.json` (append-only, in
validate_build's ledger list), shown under "On trial" on the CFB Plays tab. The six totals logged
on 10/31 stay on the graded record. A guard skipping totals far from the market was tested and
did not help.

**College football player projections (11/1).** `sports_espn.ingest_box` (the NFL box-score
reader, generalized) reads every FBS box score this season into `data/cfb/player_games.json`
(575 games, weeks 1-9 seeded; the daily run adds new finals). `cfb_players.py` runs nfl_model's
engine with college roles (no targets in ESPN's college box, so receptions set the receiving
role), tuned on weeks 4-6 and judged on 7-9: MAE vs the season average rushing +3.7%, passing
+1.7%, receiving +0.4%, receptions +0.6% (and +4-7% vs the last-3 average). Priced against Onyx's
college player props as leans (no Onyx college prop history to backtest on), with a role guard:
a projection more than 1 sd from the line, or under 60% / over 167% of it, is shown but never
priced. Against RotoWire's 10/31 projections: correlation 0.96-0.98 on passing, rushing and
receiving yards and receptions, typical gap 6-12%; our rushing runs ~5 yards lower because
college rushing counts sacks.

**NBA v8: confirmed starting fives (11/1).** Jordan's SaberSim comparison of 10/30 showed our
worst misses were late starters (Capela, Gafford, Jase Richardson projected 5-15 minutes, played
29-33). `nba_build.attach_lineups` reads ESPN's game summary for games within 4 hours of tip and,
for a team with exactly five starters posted, marks every player starter True / False (None
otherwise, and the model runs as v7). `nba_model.lineup_minutes` pulls a confirmed starter halfway
to his minutes as a starter (or 29) and a usual starter left out of the five halfway to his bench
minutes (or 18), before the 240-minute refill. Backtest (`SIM_LINEUP` in tools/nba_backtest.py):
Feb-Apr minutes MAE 5.45 -> 5.30, points 4.604 -> 4.559, lane open +2.5% -> +8.7%, close +13.0% ->
+23.4%. Fail-soft: a lineup error leaves the slate as it was.
