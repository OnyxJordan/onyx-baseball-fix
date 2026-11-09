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
- **One look on every sport page (11/2).** MLB and NBA use the engine pages' header and
  hero: the Onyx square logo (not a sport ball), text-only tabs, no MLB / NBA link in the tab
  row (switch sports with the Onyx mark, the More menu or the phone pill), no "updated" stamp
  or gradient line, the hamburger last on the right (ui.js moves it), a two-line hero
  ("Every ___. / Every Onyx line.") with the raster ball behind it, and the same three buttons
  and bottom bar (Home, Plays, Games, Board, More). The CSS is the "one header" block at the
  end of `onyx.css`. MLB's `index.html` is not rebuilt on days with no games, so its hero and
  logo edits were made in `index.html` too; keep the two in step until opening day.
- **`verify_pwa.js`** also checks the hub at 320px and 393px: manifest, status bar,
  header, all seven sports, no sideways scroll, and that the wordmark draws.
- **iPhone Duo (11/3).** The foldable has a 466x678 cover screen and an inner screen that opens
  wider than tall at 890x626. The app chrome (ui.js bottom bar, More sheet, hamburger header)
  now runs on phones AND on touch screens up to 1024px (`(max-width:760px),(max-width:1024px)
  and (pointer:coarse)`, `APP`/`DESK` in ui.js; the header half is the iPhone Duo block at the
  end of `onyx.css`). Before, the unfolded screen got the desktop header with its tabs cut off
  and no bottom bar. Content layouts stay width-based. Screens under 720px tall get a shorter
  hero. `verify_pwa.js` loads six pages on the cover screen, unfolds, folds and unfolds again,
  and fails on a missing bottom bar or menu button, a desktop tab strip, or sideways scroll.
  **11/4, from Jordan's screenshots of the real phone:** iOS puts the Duo's status bar down the
  right edge, so pages get about 382x678 folded and 811x626 unfolded, and the inner screen still
  drew the desktop header with no bottom bar (the device did not match `pointer:coarse`). ui.js
  now decides touch from any signal (coarse or no-hover pointer, touch points, the installed
  app) and sets `html.ox-touch`, which the onyx.css header and parlay-button rules key off.
  fitHeader also treats under 6px between the logo and the first control as not fitting (the
  NBA/MLB switch hides on the 382px cover screen). verify_pwa runs the Duo at the real sizes
  with a touch pointer and with a misreported fine pointer.
  **The fold (11/4).** Unfolded, the Duo is laid out as a book so it reads flat and half-folded.
  `ui.js` sets `html.ox-fold` plus `--fold-x/-l/-r/-rw/-gap/-pl/-pr`. The hinge comes from the
  Viewport Segments API when Safari has it switched on; that API and Device Posture are behind
  developer flags in Safari 27.1. Otherwise the inner screen is recognised (touch, landscape,
  700-1024 wide, 500+ tall) and the hinge is the physical center, about 445px into an 811px page.
  - The body is padded so content is symmetric around the hinge, and equal-column grids split on it.
  - The bottom bar splits 3 + 2 around the hinge.
  - The More sheet, My picks and team/player cards open on the right page over a light, unblurred dim.
  - `foldFit` splits any grid that spans the hinge (one-column lists of like cards become two
    columns) and keeps crossing text and wrapping button rows on the left page. Tables, tickers
    and art are left alone. Every change is marked `data-oxf` and undone when the book layout turns off.
  - `verify_pwa.js` checks six pages: no text or bottom-bar item on the hinge, and the menu on the
    right page. Folded and at laptop width the book layout must be off.
  - **11/4, after Jordan's photo:** the first book was right (one live pick per page). Pass two's
    "spreads" (full-width blocks flowed left then right) were wrong and are gone. What stays from it:
    `foldFit` re-runs after taps and `gotoTab`, and undo compares styles as the browser stores them.
    The gutter is now 16px (8 either side of the crease), so two cards meet right at the fold, the
    same width. `verify_pwa` checks that split on every page.
  - **The real phone (Jordan's More-menu readout, 11/4):** the installed app gets a page of
    867x669, `screen` reports the COVER screen (466x678), angle 270, the status strip on the right,
    and the posture and segments APIs are off. So `foldGeom` treats a touch page 820-890 wide and
    600-700 tall as the Duo's 890-point inner screen: the crease is 445 from the left (measured from
    the right at angle 90). The "Screen check" readout that gave these numbers was removed once Jordan
    confirmed the split on the phone (11/4).
    After Jordan's Tennis photos the crease is set 3 points right of the screen's middle (448) with a
    24-point gutter, and a lone card or a card's own two-part layout (words plus a button) stays whole
    on the left page instead of being split across the crease. The Duo can't tell a web app it is half-folded
    (Polymarket's native app can), so the book layout holds whenever the screen is unfolded.
  - **The rule (Jordan, 11/4): "full screen where it works and halves when it has to."** Wide pieces
    (art, the stats strip, game boards, stat tables, charts, tickers, the footer) span the screen.
    Things that come in pairs or lists (picks, live cards, Top 10, sport tiles, record cards) split
    one per page on the crease. On the hub (`home.html`) each section is a spread: its title and words
    on the left page, the thing you use (buttons, the Ask box, the Onyx Picks card, the live and
    tracker panels, the parlay ticket) on the right, lists below across both (end of `onyx.css`).
    `foldFit` leaves a grid alone when it already splits on the crease. The fold uses the visible
    width (visual viewport), not `innerWidth`, which grows with anything wider than the screen.

- **Tennis live picks need 60%+ to hit (11/4, Jordan: "only when it's confident").** Graded tennis
  live plays to then: 28-32 (-6.46u). Under 60% to hit 12-25 (-8.62u; the 50-60% band 8-18), 60%+
  16-7 (+2.16u), better on both days. A tennis live bet now counts as value only with 3+ points of
  edge AND a 60%+ chance (`live.js` TN_CONF/isVal, `live_model.TN_CONF`, `live_log.py`, which logs as
  `live-v2`; v1 rows stay as logged). Below it the card reads "Too close to call". 60 graded plays is a
  small sample: the lane stays on trial and the bar is revisited as rows come in.
- **One tennis pick per match (11/5, Jordan: a Musetti match showed three different picks).** Before,
  a match could log a moneyline, a spread and a total, or both sides as the line moved (25 of 36
  matches had more than one row). `live_log.py` (`live-v3`) now logs one pick per tennis match, the
  most confident value play when the match first qualifies, and nothing more for that match. The
  page ranks tennis bets by confidence and, once a match is logged, shows that pick locked ("Our pick,
  logged") with no other side. The ledger keeps every row (append-only); the record counts one per
  tennis match (`live.js` onePerMatch): from the match's first logging run, the most confident play,
  never chosen by result. Tennis 37-37 (-4.96u, 75 rows) reads 20-15 (-1.32u, 36 matches).

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
- **College basketball (`cbb`, 11/2):** men's Division I on the same engine, `kind:
  "basketball"`, a day slate (ESPN `basketball/mens-college-basketball`, `groups=50`;
  ESPN's undated scoreboard is NOT today's games, so the page, the hub and the slate
  always pass `dates=`). `sports_history` reads finals by day from last November,
  skipping May to October, and keeps `teams_espn.json` (abbreviation to names).
  `sports_espn.ingest_bb_box` reads this season's finals into a columnar
  `player_games.json` (`cols` + `rows`: minutes, starter, DNP, points, makes and
  attempts, rebounds, assists, steals, blocks, turnovers, fouls), newest first, at most
  260 games or 120 seconds a run, so cbb runs LAST in the sports loop (the step has a
  12-minute cap). An empty slate stores `next_date` and the page says when play resumes.
  `cbb_model.py` (v2) fits this season only, every rating
  pulled toward a preseason prior: last season's Torvik adjusted efficiency from
  `data/cbb/history/teams.json` (Torvik names mapped to ESPN abbreviations in
  `cbb_model.ALIAS`) kept at 85%, or, without that file, last season's own fitted
  ratings (ridge 1). `team_model.fit` takes the prior as `carry_off` / `carry_def`
  (and `mu0` / `mu_k`); without them it is unchanged. v2 adds pace to the total only:
  `cbb_model.fit_pace` fits log points = level + pace[home] + pace[away] + off - opp def,
  pace pulled toward last season's Torvik tempo (kept 50%, 30 games of prior), and
  `ratings()` hands `team_model.expect` an `R["expect"]` that takes the margin from the
  v1 additive fit and the total from possessions x efficiency (`tools/cbb_model_backtest.py`:
  total error 13.62 vs 13.76 on 1/1-4/9/2026; the closing total is 13.38, so it does not
  beat the market). Depth charts: `cbb_stats.py` (runs `cbb_minutes.build` on every ESPN
  roster, then minutes x per-40 production; weights from `tools/cbb_stats_backtest.py`)
  writes `data/cbb/depth.json`, the shared depth schema read by `cbb-players.html`, once a
  day from both pipeline workflows (`--if-older 20`, fail-soft). Per-game threes, steals and
  blocks come from `data/cbb/history/box_{YEAR}.json` (Torvik CSV columns 3, 19, 54, 59-63).
  Transfer impact (11/2): `cbb_transfers.py` runs right after the depth build (from
  `cbb_stats.py`, fail-soft, under a second) and writes `data/cbb/transfers.json` (every
  2026-27 transfer: level change = new team's last-season adj_em minus the old team's, step
  up / down / lateral at 5 points, conference change, last and projected line, impact = projected
  BPM above replacement x minutes x pace, confidence, and the historical note for that kind of
  move) and `data/cbb/team_prior.json` (a player-based preseason adj_em / adj_o / adj_d per team,
  Torvik's preseason rating, a fitted blend, portal in / out). Weights, the 2019-2026 translation
  table and the backtest live in `data/cbb/history/transfer_fit.json`, written by
  `tools/cbb_transfers_backtest.py <cache> --write` (needs Torvik's time-machine preseason files
  `tm_YYYYMMDD.gz` in the cache). Walk-forward result: team MAE on final adj_em 4.65 / 4.86
  (2025 / 2026) vs 5.94 / 6.00 for last season carried over (what `cbb_model` v2 uses as its
  prior) and 4.72 / 4.83 for Torvik's preseason; the blend 4.56 / 4.69. Against the close,
  Nov-Dec games 5+ points off: 644-544 (54.2%), not significant over 52.4% (z 1.26), Torvik's
  own preseason 53.7%; flat by February. It is NOT wired into `cbb_model.py`: adopting the blend
  as the v2 prior's replacement is a v3 decision for the price backtest. Page: the Transfer
  impact and Team ratings tabs of `cbb-players.html`.
  Onyx price backtest (11/2): `tools/cbb_price_backtest.py` replays 5,489 college basketball games
  with Onyx's 2025-26 opening and closing moneyline / spread / total (`bt/cbb_lines.json`; all 365
  OpticOdds names map to ESPN via `team_map.json`, `cbb_model`'s Torvik folding and 10 aliases in
  the tool; every game matched to its ESPN final), priced exactly as `sports_build.game_rows` does,
  ratings as of each game's date. It feeds `tools/sports_backtest.py cbb` (writes
  `data/cbb/backtest.json`, the `sports_lab.gate`; it passed on its rule with a thin 35 held-out
  lane picks at a 20% blend, and that file is deliberately NOT committed (11/2: it would have
  started a tracked cbb ledger against the Onyx Picks rule), so the live site blends cbb at
  `sports_build.DEFAULT_W` 30%) and the cbb rows of `tools/picks_backtest.py` (Onyx Picks,
  replayed at the live 30%). The transfer-aware blend as the prior
  (`cbb_model.ratings(blend=...)`, 2025-26 prior from `tools/cbb_transfers_backtest.py <cache>
  --prior 2026 bt/cbb_prior_2026.json`) was slightly better on log loss and margin error but
  better only at the opening price and worse at the close, so `cbb_model` stays v2 (numbers in
  its docstring).
  Onyx league `ncaab`: moneyline,
  spread, total, player points / rebounds / assists / made threes / PRA (NBA market ids;
  confirmed by the 11/3 history pull, over-only lines; tested in Onyx Picks, see below). Gate: `tools/verify_sports.js` renders a real
  finished-game box score from `tools/fixtures/cbb_summary.json`.
- **Template:** Home, Games, Onyx Board, Plays and Model tabs. The page polls ESPN's
  scoreboard live: every 15s while anything is live, otherwise every 30s. Gamecenters
  by kind:
  - **Football:** the field with the ball spot, line of scrimmage and first-down marker,
    down and distance, win probability, scoring plays, drives, team stats and leaders.
    All from ESPN's `summary`.
  - **Hockey:** by-period scores, goals and team stats.
  - **Basketball:** score by half, the latest plays, win probability, team stats,
    leaders, and a box score (starters, bench, DNP, team totals) with MIN PTS REB AST
    3PM FG FT STL BLK TO PF that scrolls sideways inside its card on a phone.
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
  - **Fallback (11/5, Jordan):** when Onyx prices nothing for a sport (that day at ~10 AM ET the
    sweeps book `onyx_odds` went silent on OpticOdds in every sport; `onyx_predictions` is Onyx's
    separate prediction product and prices differently, `odds_probe.yml` job=compare, so it is
    never used), the same pull runs against DraftKings into `market.json` (`"fallback": true`).
    `odds.json` stays Onyx-only, so every ledger, trial lane and Onyx Pick sees no prices.
    `sports_build.market_leans` then prices each game line against `market.json` with the pure
    `game_rows` / `tennis_rows`, flags the rows `src: "market"` (no selection id), and adds them as
    leans to the Plays tab, `top.json` and `board.json`. The page and the home Top 10 label those
    prices "Market line", never Onyx or the book's name, with an "Onyx prices are down" note;
    `picks.log` refuses `src: "market"`. Ignored when older than 3 hours or from another day.
    When Onyx answers again, the next run writes an empty `market.json` and the leans go back
    to Onyx prices.
  - NBA (its own pipeline) follows the same rule: `nba_odds.py` pulls the market line with the
    same parser when Onyx prices nothing (rows `src: "market"`, no selection ids; earlier Onyx
    prices are dropped so none goes stale on the board) and flags `props.json` `"fallback"`.
    `nba_build` shows them as leans on the board and Top 10 and says so above the plays; picks,
    the Model's Parlay ticket and every trial lane read `src: "onyx"` only, and `open_lanes`
    never captures a market price as an opening.

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
  - **`cb_pass_over` capture lane (11/8, Jordan: "set up the CB out lane to log prices now").** In
    `sports_build.nfl_open_lane`, same ledger (`data/nfl/open_trial.json`, append-only, on trial, never an Onyx
    Pick): a QB's passing yards OVER when the opponent has a cornerback with 60%+ of defensive snaps this season
    (depth.json `now.use`, 2+ games) tagged Out or Doubtful on ESPN's injury report (IR left out, as tested), priced
    -130 to +120, logged once at the Onyx price when it first qualifies (not only the opening price: the report
    usually lands after the open, and the backtest's close earned as much as its open). Key `gid|name|pass_yds|cb`,
    graded off the box like the other lanes. Promotion bar: 30+ 2026 bets with a profit at the logged price, then
    the picks test. First day: 4 logged for the 1 PM slate (Nix, Young, Willis, Geno Smith).
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
  - **NFL factor backtests, 11/8 (none shipped; the record so nobody re-runs them blind).** Jordan: the Colts' trades,
    splits, who covers whom, snap counts, a pass-catching back vs a run-stout / pass-weak defense. nflverse 2019-2026,
    fit on earlier seasons, judged on unseen ones; the splits also against Onyx's opening prices (2024 market, 2025-26
    Onyx, nfl_feature_screen lines). Scripts and outputs were scratch work, not committed.
    - Line personnel (missing OL / DL starters by trailing snap share; the Colts traded LG Nelson 10/27, DT Buckner
      10/28): a missing OL starter cuts the RB1's rushing about 5% (-4.4% fit / -6.4% held out, ~3 yards) and team
      rushing ~3.5%, but held-out error is flat (28.20 -> 28.16 yards, within one standard error) and over/under log
      loss slightly worse; the player's own recent stats absorb it within 1-3 games. Missing DL: no effect on
      opponents. 18 mid-season OL/DL trades since 2019 showed no extra effect.
    - Matchups: defense vs position (catches / yards allowed to RBs, WRs, TEs), run- and pass-funnel defenses, man/zone
      (participation data; 2026 not published, so only last season's rates could run live). Best: receptions DvP,
      better in 3 of 4 held-out seasons by ~0.1% of error (1.65 catches). Funnels flip sign; live man/zone worse in
      2+ of 4 seasons. The team-wide opp_rec / opp_rush_yds already carry most of it. Who covers whom, slot vs
      outside and CB shadowing are not in public data. Untested yet: passing-yards DvP against the price.
    - Vacated volume (a 6+ target or 10+ carry teammate ruled out): spreading his share proportionally is worse held
      out (rec yds MAE +2.15); pass catchers lose volume when the RB1 is out. Real but unproven: the next RB gains
      ~+23 rushing yards on a 32 base (fit +23.4, held out +24.9, n=50), not significant held out yet.
    - Player splits vs Onyx's price (log loss x1000, 2024 / 2025 / 2026): the player's own home/away, dome/turf and
      primetime splits are noise (better in 0 of 3); domes (+4-7% receiving), rain (-12-17%) and primetime pass
      attempts (+3%) are real but already in Onyx's price; short week and bye too thin; safeties/LBs out flip.
      Watch only: passing-yards overs vs a defense with a regular CB Out/Doubtful on the final injury report, 15-3 /
      28-16 / 6-4 at the open (log loss -16.8 / -1.1 / +2.1); needs a capture lane at the price when the report lands.
      Coaching changes: nflverse's coach field is wrong from 2024, untestable.
    - Follow-ups (same day): backup RB by depth role: the replacement runs ~+22 yards over his trailing mean, but Onyx's
      opening line already sits +21.9 above it (role projection within 1.8), 18-18 at the open; name him by trailing
      carries (70% right) not the depth chart (63%). Not shipped. Passing yards vs defense-by-position at Onyx's price:
      rules chosen on 2024-25 lost on 2026 (unders vs top-10 32-40, -16.3%); QBs vs a top-5 pass defense finish ~10
      yds under the line, vs bottom-5 ~5 over, mostly priced. Watch: explosive pass rate allowed (same sign 3 folds).
    - CB out, the full test: QBs +8 yds with a regular CB Out/Doubtful (+6.5 2019-23, +12.3 2024-26); overs 17-6 /
      49-32 / 10-11 at the open (+14.8% open, +20.1% close overall), 2026 alone -9.6% at the open on 21: short of the
      trial bar. Jordan, 11/8: log it anyway to build the 2026 record -> the `cb_pass_over` capture lane below.
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

## Push notifications: Onyx Pick alerts (11/7)

Jordan: "an alerts system for at the open that sends push notifications when it's over X%, and track that pick."
His calls: **every alert is an Onyx Pick** (already logged in data/picks/ledger.json at the price shown when it
qualified, so it is on the graded record; never a second tracked list), sent through **OneSignal**.

- `alerts.js` (home page under Onyx Picks, picks.html): "Pick alerts" with X = 55 / 60 / 65%. Turning it on asks
  for permission and sets OneSignal tags `picks=1`, `min_conf=X`. It reads the public app id from `data/push.json`
  and says "coming soon" while that is empty. iPhone needs the PWA on the Home Screen (Apple's rule for web push).
- `pick_alerts.py` (refresh and daily builds, after picks are logged; requests only, fail-soft): one push per new
  Onyx Pick ("New Onyx Pick", the pick, price, chance, league), filtered to `picks=1` and `min_conf` below the pick's
  chance + 1; at most once per pick (`data/picks/alerted.json`), only picks logged in the last 3 hours whose game
  has not started, so switching push on never floods old picks. It writes `data/push.json` from the secret.
- `sw.js` already imports OneSignal's worker.

**To switch it on** (one time): create a free OneSignal Web Push app with site URL
`https://onyxjordan.github.io/onyx-baseball-fix/`, then add repo secrets `ONESIGNAL_APP_ID` (the App ID) and
`ONESIGNAL_API_KEY` (the App API key, REST). The next build writes data/push.json and the card turns on.

The OneSignal app's **Web** platform must be configured too (Settings, Push & In-App, Web; done 11/7 as a Typical
Site with origin `https://onyxjordan.github.io`). A Typical Site's worker lives at the domain root
(`/OneSignalSDKWorker.js`), which a Pages project site cannot serve, so `alerts.js` inits with
`serviceWorkerOverrideForTypical: true, path: '/onyx-baseball-fix/', serviceWorkerPath: 'sw.js', serviceWorkerParam:
{scope: '/onyx-baseball-fix/'}`; without the override flag v16 ignores the code's path. Our `sw.js` imports
OneSignal's worker, so the site keeps one worker for offline and push (OneSignal's downloadable
`OneSignalSDKWorker.js` is the same one-line import and is not needed). Check the app's live web config with
`curl "https://api.onesignal.com/sync/<app_id>/web?callback=x"` (the old onesignal.com/api/v1 path can serve a
stale "not configured" answer for a while). Keep the dashboard's slide prompt **auto-prompt off**: the site asks
only from the Pick alerts card, so subscribers get the `picks` and `min_conf` tags the sender filters on.
The card shows the reason when it cannot turn on, never a silent no-op. Entry points: the bell in the home
header, "Pick alerts" in the hero and the More sheet, and picks.html#alerts.

The MLB HR/final watcher (`notify_watch.yml`, `push_watch.py`, `shell.html`'s own `ONESIGNAL_APP_ID`) rides the
same secrets; shell.html's constant is still empty, so MLB in-page toggles stay off until it is pasted there.

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
team that wins the opening tip scores first 66% of the time (2,424 games); each team's jumper is
the starter with the most tips in `data/nba/jumps.json` (`nba_jumps.py`, seeded from the 2024-26
play-by-play, updated by both NBA fetch paths), tip chance (won+2)/(jumped+4) against the other;
the five starters (ESPN's posted lineup, else the most regular starters) split the team's share
by ((FGA x games + 0.9) / (minutes x games + 30))^0.5 x ((first shots + 1.6) / (starts + 8))^0.25,
the jumper x1.22 (`season.fga` from the box rows). Onyx's
`first_basket_including_ft` price rides along in `nba_odds.py` (`props.json` players[].fb).
**open-v4 (11/2): opportunity first, then the price.** A lean is one of his team's two likeliest,
priced +800 or shorter, expected return (model x decimal - 1) 10%+, the best one a game, shown
with the reason ("BOS wins the tip 58% (Horford 41-19) · takes BOS's first shot 38% of starts").
`tools/nba_first_basket_backtest.py` found every earlier number (+41% on 421, +38% on 533, the
old "20% over implied" rule) was graded on a wrong label: the scratch study took the first m2 /
m3 / ft event as the first score, and m2 / m3 are MISSED shots, so it matched the real first
scorer 12% of the time. On the real one, 2025-26 Onyx prices: the old ratio rule 46-501, -1.4%
at the open, -14.9% at the close (median +1120); the opportunity rule 14-96, +1.9% at the open,
-8.7% at the close (median +730). Neither has an edge; Onyx's no-vig price is as sharp as the
model on log loss. The only pattern: Onyx's opening long shots (+1201 and up) hit 8.8% vs 6.8%
implied (+27.6% blind at the open) but are cut by the close; the old rule was harvesting that. Shown in the
gamecenter and as "First basket leans" on the Picks tab, never tracked. **On trial at Onyx's opening price** (`open_lanes.py`, `data/nba/open_trial.json`, append-only
and in validate_build's ledger list): every edge we found beats Onyx's first price far more
often than its last, so the full refresh (never the 10-minute lines-only run) writes the
first price it sees for each 1st-quarter total and first-basket market to
`data/nba/opening.json` (once, timestamped) and logs a play only when the model beats that
opening price AND the live Onyx price is still the opening one, so every logged play was
bettable at its logged odds. Lanes: 1Q total (25.4% of the game total, sd 12, 3pp+) and
first basket (open-v4 opportunity rule above, one per game, each with its "why"). Graded from ESPN (1Q line score;
first scoring play's athlete id). Shown on the Picks tab as "On trial · Onyx opening prices"
with its own record. **NBA deep dive (10/30, open-v2):** ESPN's play-by-play carries every
shot's type and distance, the three referees and the venue, so 2,435 games (2024-26) were
pulled and four new reads tested against the v7 projections and Onyx's 2025-26 OPENING
prices (fit before February, judged after): shot-quality "luck" (made vs expected points by
shot type and distance), referee crews (free throws, pace), rest / travel / altitude, and
for first basket each starter's share of his team's FIRST shot. Only the last one earned its
place: first-basket log loss 2.2760 -> 2.2694 on unseen games, and at the opening price
(edge 20%+) 57-476 +38% (~204u) against 45-376 +41% (~174u) before. (Superseded 11/2, open-v4:
those were graded on the wrong first scorer; see First basket above.) Shot luck improved points
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
| `cards.py`, `cards.js` | team and player cards (11/2): `data/<sport>/cards.json` + `cards/<team>.json`, opened from any `data-oxt` / `data-oxp` element |
| `onyx.css`, `onyx.js` | Onyx design layer and raster art, shared by every page |
| `model.py` | v41 HR model + pitcher K projections; changelog at top is the lab notebook |
| `career_db.json`, `pitcher_db.json` | canonical hitter/pitcher DBs — **never regenerate** outside `rebuild.yml` |
| `bullpen_db.json` | team bullpen HR/9, consumed by `auto_build.py` |
| `data/*_history.json`, `data/picks_input.json` | the four graded ledgers — sacred |
| `data/line_history.json` | market snapshots for the line-movement UI |
| `data/live/ledger.json`, `data/live/tennis_now.json` | live value record (`live_log.py`; game lines and, since 11/9, live player props `kind: "prop"`) and the tennis minute watcher's picks — append-only, sacred |
| `data/live/prop_params.json` | live prop pricing constants (PVAR / PK / YSD, versioned) read by `live.js` and `live_model.py`; only the weekly re-fit changes it |
| `data/live/props_gate.json` | live prop value gate (`tools/live_props_backtest.js --gate`): live.js calls a prop Value only when it passed |
| `data/live/prop_snaps.json` | every priced live prop at each build, 21 days rolling (calibration against live prices; not a ledger) |
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
`saved.js` (loaded by every page, by `ui.js` where a page does not load it itself) keeps one
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

**Lists, NBA specials and matchups (11/9).** Jordan: "top 5 point scorers, top 7 most likely to score a TD, the
best value to have a triple double tonight ... you should be able to ask it about specific matchups as well."
The NBA board (`nba_build.write_top`) now carries 3-pointers made (`threes`), P+R+A / P+R / P+A (`pra`, `pr`,
`pa`) off the bet ladders' main line, and double-double / triple-double (`dbl_dbl`, `trp_dbl`): the model's
chance is built from P(10+) in points, rebounds and assists (independent stats; DD = any two, TD = all three),
blended at `M.MODEL_WEIGHT` with the de-vigged Onyx price. These are named `dbl_dbl`/`trp_dbl`, never `dd`/`td`,
because `td` collides with touchdown markets and the parlay words in ask.js. `BOARD_KEEP` is 3000 so the
new rows fit. Search: "top N point scorers" sorts points by projection; "threes"/"three point shooters" is
the threes market; "best value triple double" with no positive edge ranks by model chance x payout and
says so; "A or B points" / "A vs B" returns both players; two teams of one game with no market is a game
card (best moneyline, spread, total, then that game's props), "who wins X Y" is the moneyline and "who covers
X Y" the spread. "top 10 receptions in the 1 PM games" now reads 10 (the stat word after "top N" only means a
line when followed by +, "or more", "for" or "per"). Gates: verify_ask full corpus 797/813 (the 16 misses are
the Sunday NFL-slot cases that need a Sunday board, plus a CFB player not on today's board, all failing
identically on main), holdouts 59/59 and 49/49, list sweeps 2,926/2,926 tuned and 3,000/3,000 fresh.

**The 100k backtest (11/6).** Jordan: "we need to get through 100000+ search terms of back testing, I have
no confidence in its search ability." `python3 tools/ask_mega.py 100000 7` writes 100,000 requests from
today's boards (every sport; real teams by nickname, full name and abbreviation pair; real players;
same-game parlays with a minimum total price; TD-scorer parlays; payout targets; slang, filler, mixed
case, typos) into `tools/ask_mega.json` (gitignored: regenerate it), and
`node tools/verify_ask.js --corpus=tools/ask_mega.json --out=res.json` grades them in ~35 minutes.
verify_ask now grades the ticket, not only the reading: the leg count the words ask for, one game for a
same-game parlay, the payout reached (or a note saying the closest), no leg twice, no both sides of one
bet, nothing started, every play on the board file at its price, and no empty answer when the board has
that team or player. First stricter sample: 82.6%. After the fixes: 99.85% of 100,000 (99,937 answered
with plays), 744/744 hand cases, both holdouts 100%, and 300/300 through the live AI relay.
Fixes it found: "minimum total odds of +300" is the ticket's payout (the word "total" is not the totals
market); number words after top/best/safest; "point spread" is the spread; two abbreviations of one
game ("LV vs SF") read as that game; the widening ladder keeps each step; a short ticket or a payout it
cannot reach says so; a named game with no line in that market shows its other lines; 2night,
moneylnes, tuchdown, spreds; New Orleans after "@" is not a negation; "Wild" with a capital W. And the
board itself: `both_sides` now carries both sides of every game line while Onyx is down (from the
market line) and in tennis (`tennis_both_sides`), so "Bears moneyline" is never empty because the model
leaned the other way.

Jordan: type what you want ("3-leg parlay, NBA points overs, minimum odds -200", "player most
likely to score 2 TDs", "your favorite correlated SGP", "most value in college football") and
it builds it. **The AI never picks plays.** It only turns the sentence into a search spec;
`ask.js` runs that spec against today's boards, so every answer is a real Onyx line with our
model's number on it.

- Boards: `daily_top.write_board` writes `data/<sport>/board.json` on every build: every priced
  Onyx side (any price) with its blended confidence, edge, tag (tracked / trial / lean),
  selection id, and for NFL anytime-TD props `lam`, the expected touchdowns, so 2+ TD chance is
  1 - e^-lam (1 + lam). NBA rows skip held (closed) lines.
- 2+ and 3+ touchdowns at Onyx's price (11/8): Onyx prices `player_touchdowns` over 1.5 (2+) and over 2.5
  (3+); `sports_odds.py` keeps both (`two_td`, `three_td`) and the NFL board carries them with the Poisson
  chance from the anytime chance. Search builds a 2+ TD ticket from the `two_td` rows (their prices, their
  floors), so "3 leg 2+ TD parlay, +1000 or more" pays +1000 or more; the anytime-priced 2+ mode is only the
  fallback for a board with no 2+ prices (college football). First TD is `first_td`; the feed carries no
  last-TD market for Onyx (probe, 11/8).
- Granular lists (11/8): "your favorite" / "our top" is what we recommend (sort rec), never the betting
  favorites; "by value" ranks by edge; "projections" ranks by projection, and a projection list drops the
  pick floors (50%+, -200) so it is the biggest projections, every one.
- Positive value only (11/8): "positive value", "+ev", "only value plays", "with an edge", "beats the price" (or the
  "+ Positive value only" chip) set `pos_value`: a filter, every play's edge above zero, ranked by value, the 50% floor
  off. First TD and first basket stay out unless named (Onyx's price beat the model there). Nothing qualifies: the
  answer says so and shows the closest to value, never calling them value. "value plays" alone still only ranks.
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

**Live line and value (11/2).** The relay's `GET /live?sport=` serves the feed's in-game lines
(DraftKings first, each market from one book, never named on the site: "Live line"), and every
card prices them: Started (Onyx pregame), Live line, Our fair, Value when our chance beats the
line's implied chance by 3+ points. Player props use the live box line plus our pregame
projection (`pregame.json` "pp"). No game-line bet in the last 15% of a game and none where we
disagree with the line by more than 12 points (the first night's 20-50 point "edges" were all
late football games the model could not see).
Tested two ways. `tools/live_backtest.js` replays finished games (ESPN play-by-play and pregame
lines, 2025-26 and 2026-27 so far): 1,891 games and 23,000+ frozen moments (NBA 500, NFL 391,
NHL 500, college 400), graded against the final and against ESPN's own live win probability.
It showed the old margin SDs overconfident (we said 15%, underdogs won 23-33%), so
`tools/live_fit.js` refit them on half the games and checked the other half: NBA 17 / 21.6 with
the game's own pace weighted 0.2, NFL 16.5 / 17.5 with pace 0.4 and the points still to come
x1.02, college unchanged (already fit). Our live win chance now scores better than ESPN's
model at every stage where bets show (NBA first half Brier 0.1875 / 0.1674 vs ESPN 0.1958 /
0.1733). NHL now adds the overtime or shootout goal to the final score for totals and puck
lines (over/under log loss 0.5973 -> 0.5877). `tools/verify_live.js` stress-tests the cards on
generated games (5,000 per seed; run on 5 seeds, 277,425 bets): chances in range, fair price =
our chance, edge math, every gate, model shape (a bigger lead never lowers the chance), no
NaN / em dash / book names on a card, no sideways scroll at 390px.

**Live player-prop pricing, backtested (11/9).** `tools/live_props_backtest.js` (dev only) replays
`data/<sport>/prop_archive.json` (pregame line, projection, lam, Onyx prices; 21 days kept): each archived
player's stat rebuilt at 10 moments from ESPN play-by-play (NBA points/rebounds/assists 99.8-100% exact vs
the box; NFL catches 100%, yards 93-99% within tolerance; college lower, mismatches dropped), priced with
`live.js` `propP` and graded on the final. Week of 11/2-11/8: 40 NBA / 16 NFL / 35 college games, 3,133 props,
53,324 priced moments. Finding: the stat still to come ran short of projection x time left (a 50-50 line at
that mean went over 37-42%, worse late: blowout minutes, skewed yards). Refit on half the games, checked on
the other half both ways: `PK` scales the projection still to come (pts .95, reb .9, ast .85, rec yds .85,
rush yds .9), PVAR pts 2.4 -> 4 and ast 1.6 -> 1.3, yards SD rec .3 x proj + 12 and rush .35 x proj + 18.
Live log loss NBA pts .6040 -> .5982, ast .5675 -> .5558, NFL rec yds .5922 -> .5773, college rec yds
.5894 -> .5706. Catches, passing yards and anytime TD (already calibrated: NFL said 10.6%, hit 12.0%) unchanged.
Value calls on props: not trustworthy yet. No in-game prices are archived, so only the opening moment
could be tested: Onyx's no-vig price beat our chance on every NBA prop market (points .691 vs .709 log loss),
and Value calls at those prices went NBA 255-260 (-7.1%), NFL 55-44 (+3.6%, 16 games), college 68-61 (-1.4%).
`node tools/live_props_backtest.js [--fit]`.

**Live player props: logged, re-fit weekly, Value earned (11/9, `live-v7`, `props-v1`).** Jordan: "keep
adjusting to the results and focus on shoring up the process." A live prop is never called Value on
the page until its logged value plays have earned it at real live prices.
- **One set of numbers.** `data/live/prop_params.json` `{version, at, evidence, PVAR, PK, YSD}` holds the
  prop pricing constants. `live.js` loads it (with `props_gate.json`, once, fail-soft, never holding the
  first card more than 1.5 s; `OnyxLive.propFiles`) and `live_model.py` reads it at import; both fall back
  to identical built-in defaults. `live_model.prop_p` / `td_p` / `prop_bets` / `box_stats` are live.js
  `propP`, the anytime-TD chance (1 - exp(-lam x share left), nothing once he has scored, no "no TD"
  side), `bets()`'s prop branch and `box()`, line for line. `tools/verify_live.js` checks parity (propP
  and TD on 600 random states, `prop_bets` vs `bets()` on 600 generated games, and that both loaded the
  same params version).
- **Logging** (`live_log.py`, in every refresh build, fail-soft; a prop error never costs the game
  lines). For each live NBA / NFL / college game with a pregame projection (`data/<sport>/pregame.json`
  "pp", the source the page uses) and relay prop lines, it reads ESPN's live box score and prices every
  prop at the page's gates (8%+ of the game left, -500..+500, no 12+ point disagreement, Value at 3
  points). (a) Each prop VALUE play is appended once to `data/live/ledger.json` (one side per player
  market; id `<sport>-<gid>-prop-<player>-<mkt>-<side>`, `kind: "prop"`, price, chance, implied, edge,
  line, cur, proj, f, `prop_model` = params version), graded off the final box score (a player not in
  the box is void). These rows are logged whether or not the gate has passed: they are its sample. (b)
  `data/live/prop_snaps.json` keeps every priced live prop (both sides' prices when quoted, our over
  chance, cur, proj, f, time): columnar (`k` = sport, gid, player, market, proj; `r` = t, k, line, over,
  under, p, cur, f), one row per line, at most one snapshot per prop per 10 minutes of game time, 21
  baseball days kept, capped at 8,000 rows a day. About 45 bytes a row: an NBA night (10 games x ~40
  props x ~5 builds) is ~2,000 rows / 90 KB, an NFL Sunday ~4,000 / 180 KB, so 2-4 MB at most.
  `--dry-run` writes nothing; `--ledger=` / `--snaps=` write elsewhere.
- **The gate.** `node tools/live_props_backtest.js --gate` (no network) writes `data/live/props_gate.json`
  `{passed, n, w, l, units, roi, by_half, version, at, rule}`: **60+ graded prop value plays logged under
  the prop params version in use, ROI +2% or better at the logged price, profitable in both halves split
  by date** (the Onyx Picks bar's spirit). live.js: only when it says passed for the version in use does a
  prop get the Value badge, "Live value", the value sentence and a place in the live value record;
  otherwise it shows as "Live projection, player prop" with our chance, our fair price and a "Value
  untested" note. Game lines are unchanged.
- **Weekly re-fit** (`.github/workflows/live_props_retest.yml`, Tuesdays 12:47 UTC, after
  `picks_retest.yml`; own concurrency group): `--fit --write-params --gate` refits on the archive plus
  the snapshots (graded on ESPN finals; also reports our chance against the live line's no-vig price) and
  writes new numbers ONLY for markets whose refit beats the current ones on BOTH held-out halves (by
  .0005 log loss each), bumping the version and recording the evidence. **A new params version resets
  the gate's sample**, like a model `VERSION` bump: the gate counts only plays logged under it. Then
  `verify_live.js --pages=0` and `validate_build.py` must pass before it commits the two files
  (rebase-and-retry push). First run here, 11/9: no market beat props-v1 on both halves; params unchanged.

**Live on every sport page, tennis live model, live value record (11/3).** Jordan: "live picks on
each sports page... there's X or Y value right now, take this pick."
- `live.js` is the one implementation: models, pricing (`bets`) and rendering (`card`, `block`,
  `spot`, `recordHTML`, `mount`, CSS injected once). `home.html`'s Live tab and Ask Onyx call
  `OnyxLive.card`; `sport_shell.html` (nfl, cfb, cbb, nhl, tennis; golf gets only the spot plays)
  and `nba_shell.html` mount it with `OnyxLive.mount({sport, home: 'oxLiveHome', games: 'oxLiveGames'})`.
  The Live block leads with "Value right now: X at +120 live. Our chance 52%, the live line says
  45%: +7 points." and the Onyx link, then the live game cards; with nothing at value it says "No live
  value right now" and lists the closest lines. Refresh: 30 s while live, 2 min otherwise, paused
  when the tab is hidden. Label on every block: "Live value, not a tracked pick, untested against
  live prices."
- Home "Best plays today" (`spotHTML`, from `data/<sport>/top.json`): Onyx Picks first, then the best
  value, each with a reason (`daily_top.why`: a prop's projection and biggest drivers, else the game
  model's detail). NBA Home already leads with the Model's Parlay and Onyx Picks, so it gets the Live
  block only.
- College basketball live: normal model, SDs 15.4 / 20.2 (closing-line residuals 11.3 / 16.8 on
  5,344 games x the in-game inflation NBA's fit needed); not replayed in-game yet. Relay `/live`
  gains `cbb` (ncaab) and prices up to 40 fixtures for cbb and tennis.
- Tennis live model: the point -> game -> set chain (`OnyxLive.tn`, which the tennis match center now
  calls too) from the sets, games and server, pregame chance = Onyx's no-vig moneyline (the blended
  chance, tennis blend weight 0), Elo (`data/tennis/elo.json`) when unpriced. Serve baselines refit
  on ESPN set scores (`tools/tennis_live_backtest.py`, `bt/tennis_sets.json`): ATP .62 / form .02,
  WTA .54 / .034. Held-out 2026 (4,000 matches, `data/tennis/live_backtest.json`), Elo start: every
  set boundary Brier .1695 / log loss .514 vs pregame-only .2244 / .640 and the old sets-only model
  .1704 / .517; inside sets (game order reconstructed, server unknown) .1622 / .488 vs .2217 / .634
  and sets-only .1898 / .561; every 10% band within 3 points. At 1-1 in sets it is no better than
  sets-only (.2426 vs .2401). No historical live prices exist, so value against live lines is untested.
- `live_model.py` is the same math in Python (verify_live checks parity to 5e-5). `live_log.py` runs
  in `refresh_build.yml` (fail-soft) and appends each live value play once (game, market, side) to
  `data/live/ledger.json` with the price, our chance, the edge and the score, then grades it off
  ESPN's final. Since 11/9 live player props too (see "Live player props: logged, re-fit weekly" above). In validate_build's ledger list. Shown
  as "Live value record (on trial)" on each sport's Live block, the home Live tab and `picks.html`.
  Not Onyx Picks.
- **Tennis logs the minute it qualifies (11/5, `live-v4`).** `live_watch.yml` is one long GitHub job
  (~5h40m, then it dispatches its successor; an hourly cron restarts it if a hand-off is lost and
  exits at once while one is running) that runs `live_log.py --tennis-now` every 60 seconds against
  the same relay live line the page reads, and commits each new match pick to
  `data/live/tennis_now.json`. Only the watcher writes that file, so the build's `-X theirs` rebase
  can never drop one of its rows (it is in validate_build's ledger list too). Every build copies its
  rows into `data/live/ledger.json` unchanged (`merge_now`, one pick per match, the ledger row wins),
  then logs tennis itself only for matches still missing, as a fallback. `live.js` reads the file
  from raw.githubusercontent.com (cached ~5 min there) so the card locks before the next build.
  Why not the Cloudflare relay: the tennis Markov chain costs ~4 ms of CPU per match cold, and a
  free Worker gets 10 ms per run; 20 live matches would not fit. Onyx itself sends no tennis prices
  to OpticOdds (11/5 probe: 0 rows on 14 live matches and on matches about to start).
- **Tennis live bar raised to 65% (11/6, `live-v6`).** Graded tennis live picks under the 60% rule (54):
  60-64% to hit went 13-14 (-13.5%; hit 48% against 62% predicted, totals 5-9), 65%+ went 20-7 (+13.9%;
  hit 74% against 72%). `live_model.TN_CONF` and live.js `TN_CONF` are 0.65. A trial: re-check after the
  next 50 graded tennis picks.
- **Picks lock on game day, and through an Onyx outage (11/6).** Jordan: "we have a pick we lock in that
  shouldn't change ... we need recommendations at the right time." `picks.log` locks a finalized market's
  pick only on its own game day (baseball day), at the price shown when it first qualifies that day, never
  days ahead. While Onyx prices nothing in a sport (every play in that build is on the market line), a
  finalized market locks at the market line instead (`"src": "market"`, labelled "Market line" on
  picks.html); when Onyx returns, only Onyx prices lock. A locked pick never changes.
- **Live starting lines and paused live markets (11/6, `live-v5`).** Every live chance starts from the
  game's saved pregame line (`data/<sport>/pregame.json`, `daily_top.keep_pregame`). Since 11/5 that file
  held Onyx prices only, so with Onyx silent every new game would have started from a coin flip. Now a
  game Onyx has not priced saves the market line (`"src": "market"`; the page says "Market pregame"); a
  saved Onyx line is never overwritten by a market one; props stay Onyx-only. Each run's lines replace
  the game's saved lines whole, so both sides of a spread come from the same moment (24 of 42 saved
  college basketball spreads had mismatched sides, both teams getting points). Live rows carry
  `pre_src`. Paused until they test positive, on the page and in the record (`live_model.PAUSED`,
  live.js `PAUSED`): tennis totals (13-17, -21% graded 11/1-11/6), college basketball spreads (24-27,
  -12%) and moneylines (6-12, -13%). NHL live (spreads +38%, totals +23%) and college basketball totals
  (+7%) stay on.
- **Line tracking (11/6, `status.html`).** Jordan: "if lines disappear we need to address why."
  `lines_status.py` runs in every refresh build and writes `data/lines/status.json`: per sport, how
  many lines came from Onyx and how many from the market fallback, every game still to play with no
  line from either, and every live game with no live line and why (`feed error`, `not on the feed`,
  `no book pricing it`, `names differ`). The relay's `/live` now returns `fixtures` (every live fixture
  on the feed, priced or not) so "the feed has it but nobody prices it" can be told from "the feed
  never had it." The tennis watcher runs `lines_status.py --live tennis` each minute and appends a
  row to `data/lines/live_gaps.json` when a match loses its line and when it gets it back (only the
  watcher writes that file). Tennis draw slots with a player still TBD are counted apart
  (`awaiting_players`): nobody prices them, and they are not a gap. First reading (11/6 morning):
  Onyx 0 lines in every sport; market fallback covers NFL 14/14, NBA 9/9, NHL 3/3, tennis every
  decided match; CFB 7 of 56 and CBB 20 of 72 games had no line from either (mostly lower-division
  opponents the books do not post).

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

**Ask Onyx: every kind of request (11/2).** `tools/ask_taxonomy.py` builds requests from a map of
what bettors ask: bet type (straight, parlay of N in leg / legger / team / pick / fold / acca /
multi / double / treble, SGP, round robin, payouts as +500, 10 to 1, "turn $10 into $100", "$20
to win $100", 3x), what to see (safest, recommended, value, longshots), every market in bettor
words, sides, price rules, confidence, days, teams, matchups ("KC @ DEN"), players, exclusions
("no Kelce", "except the Lakers") and bets search does not cover (teasers, futures, golf, MLB,
NHL goal scorers, threes, double-doubles, combined stats, team totals, quarter spreads, hedging,
exact scores, promos, other sports), which now say so and offer what we do price. First run
94.4% of 20,000; after the fixes 80,000 / 80,000 on four seeds with the built-in reader and
997 / 1,000 through the live AI (the 3, "even money" read as exactly +100, fixed: a price rule the
reader finds now wins in the blend). Test against full boards: on a thin night, shift a past
board's start times forward locally and restore `data/` after.

**Ask Onyx: college basketball and every team name (11/2).** Jordan: "make sure all of these college
terms now all work in Ask Onyx". `ask.js` now loads `data/cbb/board.json` (NCAAB, `cbb.html`) and reads
college basketball in every wording (college hoops, NCAAB, NCAA basketball, CBB, NCAAM, men's college
basketball); "college" alone is both college sports unless a market says which. Teams come from one directory
(`teamDir`): every Division I school (`D1`: cbb abbr, cfb abbr, school, mascot, from `data/cbb/depth.json`,
`data/cbb/teams_espn.json`, `data/cfb/depth.json`), every NBA / NFL / NHL team (`PRO`), aliases (`CALIAS`: Zags,
Nova, UConn, the U, K-State...) and abbreviations. Rules: the longest name wins ("boston college" is not Boston);
a full player name beats a team word in it (LaMelo Ball, PJ Washington, Jalen Green); a pro city or nickname is
the pro team unless the request is about college ("Houston", "Bruins"); a college name is never a pro team; a
name several teams share (Wildcats, Huskies, Bulldogs, Tigers, college "Miami", Kings when both play) asks which,
with a button per team, never a guess; a pro city with no game when its college plays asks "Did you mean ...".
Teams filter per sport (`tabbr`), since abbreviations collide across leagues (DEN is the Nuggets and the Denver
Pioneers). Conferences (`CONF`, 2026-27 membership: SEC, Big Ten, Big 12, ACC, Big East, Pac-12, Mountain West,
WCC, A-10, American, MAC, Sun Belt, C-USA, Ivy, Missouri Valley; update on realignment) filter to their teams;
the others say they are not listed. Depth questions (who starts, minutes, rotation, pace, usage) answer from
`data/<sport>/depth.json` with a link to the team's depth chart. "Onyx picks" shows only logged picks
(`data/picks/ledger.json`, every pick, no default floors) and says plainly when there are none; "best bets" ranks
logged picks first and says when what it shows are projections. College basketball player props and halves are
not on our board: the answer says so. March Madness out of season says when it starts. Tests: hand-written
`tools/ask_college_cases.js` (237 cases, run with the default `verify_ask.js` and alone with `--college`);
`tools/ask_taxonomy.py` adds a college category built from `ask.js`'s own tables (schools by every safe name, shared
mascots, pro names, conferences, depth, props, picks). `verify_ask.js` now checks every answer in every corpus:
each play is on the board file at the same Onyx price, Onyx Pick tags match the ledger, no play outside the
sports read or off the named teams, no em dash or other book's name. `ai/worker.js` knows `cbb` and these rules
(needs the ai_worker.yml deploy); the reader's teams, sports, conferences, depth and picks readings win in `blend()`.

**Accounts (11/2, off until set up).** Optional sign-in so saved picks, followed players and My
bets follow a person to every device. Supabase: email magic link (no passwords) plus Postgres with
row-level security; the site stays static and, signed out or with accounts off, works exactly as
before (device-only). `accounts.js` (loaded by `saved.js` on every page that has picks or
follows) syncs the same localStorage lists the pages already use (`onyxSaved`, `onyxMyBets`,
`onyxNbaFollow`, `onyxFollow_<sport>`): a removal on one device is removed everywhere, everything
else is the union, and the first sign-in merges the device into the account. My Onyx shows the
account card (sign in, synced time, sign out, delete my account) and a short privacy note.
Turn on: (1) create a Supabase project; (2) run `supabase/schema.sql` in its SQL editor;
(3) Authentication -> URL Configuration: Site URL `https://onyxjordan.github.io/onyx-baseball-fix/`
and add `https://onyxjordan.github.io/onyx-baseball-fix/home.html` (and the other pages) to the
redirect URLs; (4) GitHub Actions variables `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the public
anon key; never the service key); (5) run "Accounts (turn on / update)", which writes
`accounts.json` on main. Empty the variables and rerun to turn accounts off. Gate:
`node tools/verify_accounts.js` (a stand-in Supabase, no keys: off, sign-in, first-sign-in merge,
two devices, removals, privacy between users, session refresh, sign out, delete).

**Signing in inside the installed app (11/7).** Jordan: "you can't sign in on the PWA because it takes you to
Safari." On iPhone the emailed link always opens Safari, and Safari and the Home Screen app never share storage,
so a link cannot sign the app in. The Account page now has **Have a code?**, which takes either:
- the **6-digit code** from the email (`POST /auth/v1/verify`, type `email`). Supabase only puts a code in the
  email when the Magic Link template includes `{{ .Token }}` (Authentication -> Emails -> Magic Link), e.g.
  `<p>Your Onyx Sports code: <b>{{ .Token }}</b></p>` above the link; or
- an **app code**: when the link lands in a phone browser that is not the installed app, the signed-in Account
  page shows that session's refresh token with "Copy code for the app". Copying signs the browser out locally
  (no server logout, which would end the session the app takes); pasting it in the app trades it for the app's
  own session (`grant_type=refresh_token`). Works once, like the link.
`accounts.js`: `useCode`, `appCode`, `handOff`, `fromLink`.

**Parlay Builder on every page (11/8).** Jordan: "we had parlay builder fully working on onyx baseball original."
`parlay.js` brings the Onyx Baseball builder (shell.html `parlayToggle` / `renderParlaySlip`) to every page but
index.html (which keeps its own), loaded by ui.js: the floating Parlay Builder pill arms the page and every odds
button adds its row's play (found through the row's save star, `OnyxSaved.pickAt`); tap again to remove; both sides
of one bet swap instead of riding together; started games leave the slip. The slip: legs and prices, combined
odds, what $10 pays, our chance every leg hits, value against the odds you got, Save parlay to my account (a
tracked ticket) and Build on Onyx (one share link; disabled with a note while legs have no Onyx id). picks.html
`#builder`: today's boards, every sport, filters by sport, sort (most likely, best value, biggest price, soonest)
and a find box, with + Add on each play. `OnyxParlay.add(pick)`.

**Saving picks and parlays, your odds, value check (11/8).** Jordan: "save picks to our account including the parlay
builder so we know exactly how we're tracking; a tool where we enter the odds and you give us the value." With Onyx's
feed down no play has a selection id, so the star vanished; `saved.js` `withId` keys such a pick from its game,
market, player, side and line. A parlay from Ask Onyx saves as one ticket (`saveTicket`: `{kind: 'parlay', legs}`)
in My picks and the history (synced to the account), tracked and graded by its legs (any leg lost is a loss; every
leg won, pushes dropping out, a win), in the profile and in `my_alerts.py` pushes. `setMyPrice` stores the odds you
got; the record, units and profile use them. **Value check** (`value(prob, price)`; under every answer and on its
own under the search box): a leg, the whole parlay, or any play you type, against your odds: our chance, the chance
your price needs, fair price, value per $100, edge and a Kelly ceiling.
**Parlay value from the odds (11/8).** Jordan: "you can't just add up all the percentages to gauge value, we need
actual value based on the odds." `OnyxSaved.parlayValue(legs, total)`: each leg's value is our chance x its decimal
odds (x1.00 is break-even), the ticket's is those multiplied (= our chance all hit x the combined payout), or our
chance all hit x the ticket price when one is typed (Onyx prices same-game legs together). The slip and the value
check show every leg's odds (editable: the odds you got), our chance, fair price and multiplier, then the combined
odds, our fair ticket odds, the chance the ticket needs and value per $100. A saved ticket keeps the typed legs'
combined odds as the odds you got.

**Your profile (11/8).** Jordan: "a whole profile history: best picks, best sport, best type of bet, studying the
profile habits and making a profile on them, and recommend the types of bets they're interested in." `profile.js`
(Account page, More -> Your profile) reads the permanent pick history (`OnyxSaved.history()`, synced to the account
when signed in): a one-line read of how you bet (sports, bet types, side lean, price habit, props vs lines), record /
units / ROI, best sport, best type of bet, best price band, best side, streak, pace and median price, the coldest spot,
your best picks (biggest prices cashed), players you come back to, and tables by sport, type, price and side. **Picks
for you today** scores every play on today's boards by fit to your habits (sport 40%, type 35%, side 15%, price 10%),
weighted up or down by what each spot has paid you, then blended with the model's chance; one per game, top 5, each
with its reason. **Search my kind of bets** opens Ask Onyx (`home.html?ask=...`) with your profile filled in.
Projections chosen for you, never labeled Onyx Picks.

**Search editing, + and -, slots, ticket totals (11/8).** `ask.js`: `-word` / `+word` add and take out anything
(`plusMinus`); with " + " between rules, " - " takes a word out too (a + between stat words stays one market).
Every answer shows its rules as chips (`chips`, `chipBase`): tap to remove one, + / - for the leg count, quick adds,
and a box for more. Kickoff windows (`slot`, `slotOk`): 1 PM / early, 4 PM / late, Sunday / Monday / Thursday night,
primetime, any "N PM games". "Total / ticket / parlay / combined odds of at least +N" is the ticket minimum, read before
per-leg prices; "maximum odds of +N" per leg. Cases: `tools/ask_compound_cases.js`.

**Push checklist (11/8).** The saved-picks part of the control center is a checklist (Game starts, Lead changes,
Halftime check, Results, Daily recap; Everything / None), stored as a comma list in `profiles.push_level`.

**Alerts control center (11/7).** Jordan: "a push notification control center where you can get updates on all
your picks and you can select how often." `alerts.js` (home #alerts, picks.html#alerts, More -> Alerts) has two parts:
- **Onyx Picks**: a switch and 55/60/65%; `pick_alerts.py` pushes each pick that locks (tags `picks`, `min_conf`).
- **Your saved picks**, signed-in people only (Jordan's call): Every update / Key moments / Results only / Daily
  recap / Off. Choosing one asks for permission, links this phone to the account (`OneSignal.login(user id)`, so
  the OneSignal external_id is the Supabase user id) and saves `profiles.push_level` (`OnyxAccounts.setProfile`).
`my_alerts.py` (workflow `my_alerts.yml`: one watcher at a time polling every 75 s for 5h40m, then handing off, an hourly cron as backup; before 11/8 every 20 minutes, exiting early when no saved pick
is live or starting soon) reads signed-in people's saved picks with the service key, grades them live off ESPN
with saved.js's rules, and pushes by level: `all` = game start, lead changes (at most every 15 minutes, 4 a
pick), halftime and the result; `key` = start and result; `results` = result; `recap` = the 14:47 UTC run's one
morning push (yesterday's record and units, today's saved picks). A pick already decided when first seen sends
only the result. Every event goes to `push_sent` (user, pick, event) so nothing repeats. **Turn on:** run the 11/7
block at the end of `supabase/schema.sql` in the Supabase SQL editor, and add the secret `SUPABASE_SERVICE_KEY`
(Supabase -> Project Settings -> API -> service_role; server only, never in the site). Until then the card shows
"almost ready" and the workflow exits saying what is missing.

**Pull to refresh and the bottom bar (11/7).** In the installed app (`display-mode: standalone`; `?ptr=1` turns it
on in a browser for testing), `ui.js` adds pull to refresh on every page: at the top, pull down past the line and
let go, and the page reloads fresh (sw.js is network-first). Never from an open menu or My picks, a text field,
a sideways swipe, or a box that is itself scrolled down. A page can define `window.onyxRefresh()` returning a
promise to refresh in place instead. `anchorBar()` puts the bottom bar back at the screen bottom when iOS leaves
the layout short after the keyboard or a system sheet (Jordan's screenshot: the bar two thirds down the screen).

**Test push.** `.github/workflows/push_test.yml` ("Pick alerts test push", Run workflow) sends one notification
to everyone with Pick alerts on (tag `picks=1`) with the repo's OneSignal secrets, and logs OneSignal's answer.

**One account, one tracker on every page (11/2).** Jordan: "the account page and tracking should
live through all sports and pages ... a uniform experience across the board". `ui.js` now loads on
every page (home, every sport, picks, account, how, scorecard, cbb-players, mlb-2026) and:
- puts the same two header controls on each, just left of the menu button (the hub: at the right
  end of its own header): **My picks** (star + saved count) and **Account** (`.ox-acct`: "Sign in"
  when accounts are on and you are signed out, "Account" with a green dot when signed in, "Account"
  when accounts are off). Icon-only below 1100px. `fitHeader()` measures the header: a tab row that
  does not fit scrolls (`.ox-scroll`); if it still does not fit, the controls go icon-only and the
  phone sport pill steps aside (`.ox-tight`). The hub's old `#acctNav` link is replaced by this control.
- gives the pages that are not a sport site (picks, account, how, scorecard, cbb-players) the
  standard sport header (`nav.nav.ox-stdnav`, built by `stdNav()`), the bottom bar (Home, Picks,
  Live, My picks, More), the More menu and the Onyx footer. account.html lost its one-off header.
- **My picks** opens one slide-over everywhere (`OnyxUI.openPicks()`, also from the More menu, the
  page bottom bar and the win pop-up): sign-in state, your record (`OnyxSaved.stats()`), every saved
  pick followed live (`OnyxSaved.track`), the same star to take one back, links to
  `account.html#record` and My Onyx.
- loads `saved.js` (which loads `accounts.js`) on any page that did not, so sync, the star, win
  alerts and the sign-in forwarder run on every page. Storage keys are unchanged.
- the save star (`OnyxSaved.btn`) is now also on Onyx Picks' card, the engine sports' player cards
  (the exact line on the Bets face) and team cards (every Onyx game line), and the NBA player card;
  the home Top 10 star is no longer shrunk. Follow (`.fl-btn`, one style from ui.js) is on every
  engine sport's player card (`cards.js` calls the page's `toggleF`) and on cbb-players.html (same
  `onyxFollow_cbb` list). MLB is off-season with no Onyx prices, so it has no star yet.
Gate: `node tools/verify_account_ui.js` (CI): every page at 390 and 1280px, the Account control in
the header, on screen and identical, My picks from the header and the More menu opens the tracker, a
save star raises the shared count and the tracker's star takes it back, signed-in state, a sign-in
link landing on any page forwards to account.html, no errors, no sideways scroll.

## Similar spots (11/2)

Jordan: "compare similar teams in similar spots, what happens ATS at X points." A card in every
gamecenter (CBB, CFB, NFL, NHL in `sport_shell.html`; the NBA game card in `nba_shell.html`):
for each side and the total, how past games in the same spot did against their CLOSING line,
with W-L, %, average cover, n, seasons, a significance tag and one line of out-of-sample
backtest. **Context, not a pick:** nothing here creates a play or touches a ledger, the Top 10
or Onyx Picks.

- **History:** `data/<sport>/situations_hist.json` (columnar), every final game with ESPN's
  closing spread / total / prices (its line providers: ESPN BET, DraftKings, Caesars...), so the
  page says "closing line", never Onyx. Coverage: CBB 47,124 games 2018-19 to 2025-26 (43,335
  lined), NBA 8,808 (2019-20 on; the 2020 bubble and July 2021 playoff games are outside the pull
  window), NHL 9,266 (2019-20 on), NFL 2,086 (2019 on), CFB 7,017 FBS games (2019 on).
  Built once by `tools/situations_pull.py <sport> --write` (dev, cached; CBB reuses
  `tools/cbb_history.py`'s pull and cache). The builds append finished games
  (`situations.update_history`: ESPN scoreboard + core odds, `requests` only, 25 s cap,
  skipped on pull-request CI).
- **Engine:** `situations.py`. Features from what was known before tip: spread bucket (NHL:
  by the favorite's moneyline, the puck line is always 1.5), home / road / neutral, both teams'
  rating tier (a walk-forward margin rating seeded from last season, CBB from last season's
  Torvik adj_em; never the final-season rating), conference (NFL: division) game, rest and rest
  edge, previous result (win / loss / upset loss / blowout), 3-game ATS streak, rematch, season
  phase, total bucket, line move from the open. Templates and their backoff are fixed in
  `TEMPLATES` / `TTEMPLATES`; a game shows the core spot plus the first three that apply in a
  fixed order, never the best looking ones. Significance is a binomial test against what the
  closing prices implied (50% at -110; puck lines far from it). Page payload:
  `data/<sport>/situations.json`, fetched when a gamecenter opens (`simSpots(gid)` in both
  shells, self-contained).
- **Backtest:** `python3 tools/situations_backtest.py all --write` -> `data/<sport>/situations_bt.json`.
  Walk-forward by season (tables from earlier seasons only), bet every side whose matched
  spot beat its price by 5+ / 8+ points of cover rate (55% / 58% at -110) on 50+ / 100+ games,
  graded at the closing price. Result (55%, 50+, any shown spot): CBB 1,777-1,754 (-4.9%),
  CFB 976-956 (-3.8%), NFL 527-486 (-0.7%), NBA 1,028-950 (-1.0%), NHL 515-516 (-0.6%).
  Trends do not beat the closing line out of sample; the card says so. One spot survived a
  multiple-comparison correction: NFL road dogs of 3.5-7, 77-40 when the rule bet it (2021-24),
  but that whole bucket went 125-125 from 2023 on, so it is not a rule.
- Changing a feature, bucket or template is a model change: bump `situations.VERSION` and
  re-run the backtest.
- **v2 (11/2), team first.** Jordan: "relevant to the team and more situational, maybe last
  10-20 ... more recent trends." Each side now leads with THAT team's own games this season
  and last (at most the last 20 of each kind, `situations.team_side`), in a fixed order: ATS
  last 20 with last 10 (NHL: puck line), in today's role (road dog, home favorite...), in
  today's spread range, off today's last result (this season only), vs today's opponent tier;
  a situational row needs 5+ games (`TEAM_MIN`). Totals: each team's O/U last 20 with last 10,
  and both combined (`team_total`). Each row: W-L-P, %, avg cover, the window ("last 20, since
  Jan 2026, 6 this season"; early in a college season "last season, last 20"), and a luck read:
  binomial against the closing prices' no-vig chance, tag `small sample` (under 10 decided
  games) / `within normal luck` / `unusual` (p < .05), plus "7-3 is common luck at this sample".
  College basketball adds a roster-turnover note when 50%+ of the projected top-8 minutes are
  new (`data/cbb/depth.json`). The league-wide spot is ONE row per side and total, built from
  the last two seasons only. Payload: `games[gid].team` / `.note` beside the old keys; logs are
  rebuilt every build from `situations_hist.json`, which the builds append to.
- **Team-row backtest** (`tools/situations_backtest.py all --write`, or `--team` to re-run only
  that part): game by game, each team's record from earlier games only, next game graded at
  the closing price. Teams 8-2+ ATS in their last 10: CBB 1,979-1,976 (-5.4%), NBA 421-408
  (-3.3%), NHL 532-509 (-6.4%), CFB 248-249 (-4.6%), NFL 83-104 (-14.7%). 15-5+ in the last 20,
  70%+ in role and 2-8 or worse cold teams: none beat the close at p < .05 in any sport (best:
  NFL 15-5+ 45-35, +7.1%, p .27). Team ATS streaks are noise; the card's footer says so. The
  league row's backtest now also uses a two-season window and the first (only shown) spot:
  CBB 1,479-1,438 (-4.1%), CFB 345-345 (-4.6%), NFL 293-267 (+0.0%), NBA 608-599 (-4.1%),
  NHL 271-279 (-9.2%).

## Onyx Picks (11/2)

**Markets with their own tuned rule (11/6, `daily_top.MKT_RULE`).** Jordan asked to backtest every market
and tune it. `tools/picks_tune.py` tries ~1,500 rules per market (edge band, price band, expected return, side) on
the tuning months only and judges the chosen one on held-out games (report: tools/picks_tune.json). Most tuned
rules collapse on games they never saw (NHL spreads +22% to -27%, tennis moneylines +4% to -26%), so nothing goes
live from the report itself. One rule held up in both periods: NBA 1st-half totals, unders only, edge 4 to 16
points, price -150 to +200 (tuning +22.1% / +22.8% on 90 bets; held out 40-23, +22.3% / +8.1%, 25 closing prices).
It is a `daily_top.MKT_RULE` entry that the live pick list (`nba_build.write_top`), the official replay
(`picks_backtest.cand(..., mk=)`, `tools/picks_replays.nba_h1`) and the tuning tool all read; picks.py grades
1st-half totals from ESPN's first two quarters (`picks.H1_SIG` is the read's version).

**Sides and totals of the day (11/6, `sidesday.js`).** Jordan: "a section with an AI writeup for picks of the day
on sides and totals, be transparent on the % and why we're picking it in every sport." On the home page (every
sport) and each sport's Plays tab: the best-value side and total on today's games the model priced (the other side
of a model-priced game borrows its reading; a bare market price is not a read, so NBA, with no game model, says so).
Each card shows our chance, the chance the price implies, the edge, the model's projected score, what moved it, the
market's record in testing (data/picks/backtest.json) and Onyx Pick or Projection; "No value today, the closest" when
nothing has an edge. The write-up comes from the relay's `{writeup}` mode (ai/worker.js), told to use only the
card's numbers, cached at the edge for 6 hours by the cards' content; without the relay, a write-up built from the
same numbers.

**Opener markets (11/6, NBA points).** Jordan: picks should reach main markets and player props. NBA points
wins at Onyx's opening price and loses by the close (held-out 30-23, +9.4% at the open on 53 bets, +24% in the
tuning months, -6.7% at the close: the line moves to our number). `picks.OPENER` lists markets that lock only
at the opener: `open_lanes` records each NBA points line's first Onyx price of the day in
`data/nba/opening.json` ("pts"; a line already up at the day's first look is a baseline, never an opener),
and `picks.log` locks a pick in that market only while its line and price still match it.
`tools/picks_backtest.py` judges opener markets at the open alone (60+ held-out bets, +2%, no tuning loss
worse than -5% at the open); the close is shown, not decisive. NBA points goes live on its own when it reaches
60 held-out bets and still passes (7 short on 11/6, and no new bets while Onyx's feed is down).

**Picks vs projections, one list (11/6).** Jordan: "I'll see lists of picks everywhere then I'll see different
things tracked, lets nail this down." Two words on the whole site. **Onyx Picks** (data/picks/ledger.json) are
the only picks: `onyxpicks.js` renders the same card everywhere (home top, each sport's Home and Plays tabs,
the NBA Home and Plays tabs, the scorecard), each pick with "Locked <time> at <price>" (and the date when it
locked before game day), its status and the bet button. **Projections** are everything else: the home Top
list ("Top projections, not picks", Onyx Picks removed from it), each sport's projections, live cards (a
live value read says "Value by our numbers", the tennis first read is "Live projection, first read", buttons
say "Open on Onyx"), and the lab. Jordan's calls: live plays are projections until a live market passes the
picks test; the home page shows picks first, then projections. The lab (old graded lanes, on-trial lanes,
the NBA props lane and Model's Parlay, the live projections record) lives on the scorecard under "The lab ·
not recommended" and on the NBA Plays tab under "The lab"; the picks page is Onyx Picks only. The NBA Home
section titled "Onyx Picks" had been showing the props lane; it now shows the real Onyx Picks.

Jordan: "we need to track plays what it recommends not leans and trials this is who I'd pick
today with tracking and visibility there's too much obscurity right now". **Decision: markets
that pass the test below are posted as tracked Onyx Picks; every other market shows projections
only and is never labeled a pick.** The sport pages' own lanes (tracked, on trial) keep running
and keep their records; the Onyx Picks record is the one public card across sports.

- **One rule** (the home Top 10, `daily_top.ok`): Onyx main line -150 to +200, our chance beats
  the implied chance by 2 to 12 points, expected return +3%+, chance 40%+, game not started.
- **The test** (`tools/picks_backtest.py`, dev only; reads the committed Onyx lines history
  `data/picks/lines/<sport>.json`, merged with the local `bt/` caches when present; writes `data/picks/backtest.json`):
  replays that rule on every market where the live chance can be rebuilt walk-forward, at Onyx's
  real opening and closing prices, as the card logs it (one per player or game market a game, best
  expected return first, up to 5 a day). **Finalized** = on the held-out period: 60+ bets, ROI of +2% or
  better at the open AND at the close, and no loss worse than -5% in the market's own tuning months
  (30+ bets; tightened 11/3, see CLAUDE.md). Fewer than 60 is "not enough yet", never a pass (60 bets at -110
  still carry about +/-13 points of ROI noise). Each verdict records the model version
  (`nba_model.VERSION` etc.; the 1Q total uses its own signature, `picks.q1_signature`, so a
  first-basket change does not re-gate it); a version change sends the market back to projections.
- **Result of the 11/2 run** (held out, open / close):

  | Market | Held out | Open | Close | Verdict |
  |---|---|---|---|---|
  | NBA 1st-quarter total | Feb-Apr 2026 | 101-71, +12.5% | 99-85, +3.4% | **finalized** |
  | NBA points (28+ min) | Feb-Apr 2026 | 27-18, +15.7% | 19-21, -9.1% | not enough yet |
  | NBA rebounds / assists | Feb-Apr 2026 | 7-2 / 9-13 | | not enough yet |
  | CFB spread / total / ml | fall 2026 | 27-19 +12.0% / 23-15 +15.6% / 7-8 | +6.7% / +19.4% / | not enough yet |
  | NFL spread / ml / total | fall 2026 | 9-5 / 3-5 / 4-5 | | not enough yet |
  | NFL rushing yds unders, pass att unders (v11) | fall 2026 | 22-15 +12.8%, 25-18 +10.7% | -23% (5), -5% (10) | not enough yet |
  | NHL moneyline / puck line | Jan 15 2026 on | 38-59 -4.6% / 64-62 -8.8% | -17.3% / -8.5% | fails |
  | NHL total | Jan 15 2026 on | 8-9 | | not enough yet |
  | Tennis moneyline | 2026 | 154-225 -7.3% | -5.1% | fails |

- **Re-run of 11/2 evening** (fresh Onyx pulls: NFL 10/28-11/2 +13 games, CFB 10/29-11/2 +111 games / +103
  with props, NHL 10/29-11/2 +32, NBA 2026-27 10/20-11/2 92 games with 1st-quarter / half lines and props; no
  CBB games yet). NBA 1st-quarter / 1st-half totals are now graded on ESPN's official line scores (the
  play-by-play quarters differed in 164 of 2,460 games) and include the 2026 play-in / playoffs. NBA props add
  the 2026-27 walk (v8 was chosen on Oct 2025 to Jan 2026, so all of 2026-27 is held out).

  | Market | Held out | Open | Close | Verdict |
  |---|---|---|---|---|
  | NBA 1st-quarter total | Feb 2026 on | 148-106, +11.7% | 144-120, +4.8% | **finalized** (2026-27 so far: 27-18 open, 22-23 -6.4% close) |
  | CFB rushing yards (v2 unders) | Oct 2026 on | 67-23, +39.8% | 58-27, +29.1% | **finalized** |
  | CBB total | Jan-Apr 2026 | 52-41, +6.8% | 90-67, +9.4% | **finalized** (at the live 30% blend: no `data/cbb/backtest.json` on main) |
  | CBB moneyline / spread | Jan-Apr 2026 | 35-43 -7.1% / 73-79 -7.6% | +6.4% / -6.6% | fails |
  | NBA 1st-half total | Feb 2026 on | 147-139, -1.8% | 154-138, +1.0% | fails (was "passes, not offered") |
  | NBA points / reb / ast | Feb 2026 on | 30-22 +11.5% / 8-4 / 12-21 | -6.7% / +2.4% / -25.5% | not enough yet |
  | CFB spread / total / ml | fall 2026 | 27-19 +12.0% / 24-17 +11.9% / 7-8 | +8.7% / +14.6% / +24.4% | not enough yet |
  | NFL v11 rush yds / pass att unders | fall 2026 | 25-19 +8.1% / 28-19 +13.9% | -45% (7) / -5% (12) | not enough yet |
  | NFL receptions unders | fall 2026 | 31-18 +40.3% | 14-18 -11.0% | not enough yet |

  The CBB rows moved from 6-27 bets to 78-152 because the earlier run read a lane weight of 20% from a
  `data/cbb/backtest.json` that is not on main; the live site blends CBB at `sports_build.DEFAULT_W` (30%), and
  the test replays what the site shows. `picks.py` re-gates on a model VERSION change only, not a blend weight
  change: if a CBB lane backtest lands, re-run this (or wait for the weekly re-test).
- **College basketball player props (11/3)**: `tools/cbb_props_backtest.py`, rows `cbb` `pts` / `reb` / `ast` / `3pm`
  / `pra` via `tools/picks_replays.cbb_props`. Onyx's 2025-26 ncaab props pulled with `odds_probe.yml` job=lines
  (748 games with props, Nov 3 2025 to Mar 2026: points 3,491, rebounds 1,372, made threes 516, assists 156, PRA 62;
  merged into `data/picks/lines/cbb.json`, which the weekly re-test now extends with these markets), graded on ESPN box
  scores of all 6,300 games (`bt/cbb_box_2026.json`, 36 did-not-play voids). Walk-forward: the `cbb_stats` preseason
  projection from 2024-25 only (weights fitted on 2022-2025, minutes on 2023-2025), blended in season (KMIN 1 game,
  KRATE 50-150 minutes, chosen on Nov-Dec), negative binomial (sd fitted on Nov-Dec player-games), blended with
  Onyx per stat (weight chosen on Nov-Dec log loss). **Onyx lists the over only** (every line from Jan 2026; 143 of
  1,155 Nov-Dec lines had an under), and those overs cashed 45.2% against 52.2% implied (points), 39.5% vs 50.4%
  (rebounds), so the fair over is the implied chance x 0.878 (Nov-Dec). Held out Jan 1 to Apr 9 2026:

  | Stat | Blend (Nov-Dec) | Held out open / close | Model alone (100%) open / close | Verdict |
  |---|---|---|---|---|
  | Points | 0% (the projection lost to Onyx's price on Nov-Dec log loss) | no bets | 64-73 -9.8% / 65-72 -8.6% | no bets |
  | Rebounds | 50% | 4-3 / 0-3 | 32-34 +1.7% / 29-31 +0.5% | not enough yet |
  | Assists | 100% | 4-3 +16.7% / 5-2 +51.5% | same | not enough yet |
  | Made threes / PRA | 0% / 70% | no bets | 2-3 / 1-2 | no bets |

  The transfer-aware projection beats "last season's per-minute rate x minutes" only slightly once games are played
  (held-out points MAE 5.07 vs 5.09, rebounds 2.33 vs 2.33; transfers 4.97 vs 5.01) and does not turn a profit on these
  prices either (naive, model alone: points -11.1% / -13.9%, rebounds +7.4% / +6.7% on 66). Nothing is close to the bar,
  so the live site still does not price college props with a model chance and `picks.py` has no made-threes grader.
  The rows carry their own version (`cbb-props-v1`, not `cbb_model.VERSION`), so even a pass would not log until the
  live site prices them under that version. The 2025-26 card is kept in `data/picks/lines/cbb_props_frozen.json` for
  runners without `bt/`, used while its rule signature matches; a 2026-27 walk (live box scores) is not built yet.
- **Weekly re-test** (`.github/workflows/picks_retest.yml`, Tuesdays 10:17 UTC + Run workflow): pulls the
  last 8 baseball days of Onyx lines for nfl, cfb, nhl, nba, cbb (`tools/onyx_lines_pull.py`, the
  `OPTICODDS_API_KEY` secret), appends them to `data/picks/lines/<sport>.json` (`tools/picks_lines.py merge`:
  only the markets the replays read, a price on file is never changed, a disagreeing pull is reported as a
  conflict), fills NBA quarter / half scores from ESPN (`periods`), re-runs `tools/picks_backtest.py`, gates on
  `tools/verify_picks.py` and `validate_build.py`, and commits only `data/picks/backtest.json` and
  `data/picks/lines/` (own concurrency group `onyx-picks-retest`, rebase-and-retry push like `nba_lines.yml`).
  **Finalization follows the tool**: same rule (60+ held-out bets, +2% ROI or better at the open AND the close, no -5% tuning loss, live
  model version). On a fresh runner every replay runs from the committed history except the ones whose inputs
  are only in `bt/` (NFL v11 rows, tennis): those keep their last computed verdict, marked `"carried"` with the
  day it was computed. NBA props replay 2026-27 from the live box scores (`data/nba/player_games.json`,
  `data/nba/prior.json`) and take 2025-26 from its card frozen in `data/picks/lines/nba_frozen.json`, used only
  while its rule signature (model version, blend, price / edge / EV / chance limits) matches.
  No replay of the live chance (never picks): NBA first basket (corrected open-v4 backtest loses at
  the close) and 1st-half total (board only), NFL receptions v5, passing TDs, rec / passing yards and
  TDs (excluded by their own tests), tennis games markets, golf (no Onyx prices), MLB (season closed).
- **Live** (`picks.py`, pipeline-safe): `daily_top.write` calls `picks.hook(sport, plays)`: grade
  the sport's finished picks, then log each play in a finalized market once (key: sport, game,
  player or side), at the Onyx price shown, before its start, up to 5 a sport a day by expected
  return, and mark it `"pick": true` in `top.json`. The NBA lines-only run (`NBA_LINES_ONLY=1`)
  only marks; it commits no ledger. `ONYX_PICKS_DRY=1` does the same for local testing.
  Rows: id, sport, date (baseball day of the start), logged_at, start, gid, matchup, label, market,
  name, who, side, line, hcap, price, chance, edge, ev, sel, model version, then result (W / L / P /
  V), actual, profit (units at the logged price), graded_at. Grading reads ESPN's summary (NBA's
  game found on ESPN's scoreboard by the two teams, since its gid comes from the odds feed): scores,
  1st-quarter line scores, box scores (a player who did not play is a void; an NFL / college
  player who played without a carry or catch is a 0). A game with no final 4 days after its start
  is void. `data/picks/ledger.json` is append-only, in validate_build's ledger list; daily_build
  and refresh_build commit `data/` so it rides along.
- **Page** `picks.html`: today's card (Onyx price at logging, bet link with referral KR680261),
  the record (overall, by sport, by market, units, ROI), every graded pick newest first, and how
  picks are chosen with the backtest numbers. Linked from the hub (hero, a banner on top of the Top
  10, footer) and the shared menu and footer in `ui.js`. Home Top 10: "Onyx Pick" (logged) vs
  "Projection" (everything else), picks ranked first.
- **Gate:** `python3 tools/verify_picks.py`: one finished game per sport (NBA, NFL, CFB, NHL), logged
  into a temporary ledger and graded against ESPN, every result checked against the score read
  independently; logged once, never after the start, the daily cap, nothing unfinalized logged.

## Team and player cards (11/2)

Jordan: "every sport needs this for every team as a whole and player ... everything we need to
explain why we are getting to the number." One card for every sport, built like the NBA player
card: header (face, matchup, the model's number), a Player | Bets or Team | Bets switch, "Why this
number" from the model's own inputs, seasons with the model's baseline row, last 5, and every Onyx
line with Model / Onyx implied / Blended / EV per $10, a distribution and line scrubber where the
model has a distribution, Add to parlay and Bet on Onyx (share link + `KR680261`).

- **Data:** `cards.py`, called fail-soft by `sports_build.py` (after the model block, before
  `write_top`; the block carries `_R` ratings and `_w` blend weight, popped before the page) and by
  `nba_build.py` (teams only: the NBA player card stays in `nba_shell.html`). Writes a small index
  `data/<sport>/cards.json` and one file per team `data/<sport>/cards/<team>.json` (team + its
  rotation players); an unchanged file is not rewritten, and files of teams off the slate are
  removed. Tennis keeps its players in the index. Golf has none (Onyx does not price golf; its
  player view is the leaderboard row).
- **Page:** `cards.js` (loaded deferred by `sport_shell.html` and `nba_shell.html`) fetches only
  the index and the tapped team's file. Any element with `data-oxt="<abbr>"` opens a team,
  `data-oxp="<name>"` (+ `data-oxpt` team, `data-oxg` game, `data-oxf="bets"`) a player. Hooks:
  game card team names, the gamecenter header, depth chart team and player names, Plays and Board
  player names, the tennis match center. The click is taken in the capture phase, so a team name
  in a game card opens the team, the rest of the card the gamecenter. Non-NBA pages get a light
  parlay slip (`#cxSlip`, localStorage `onyxCardSlip_<sport>`); nba.html uses its own slip.
- **Honesty rules in code:** only numbers the model uses (team ratings, projections, the depth
  model, Torvik, blend weights) and facts (scores, box scores). ATS and O/U are graded against
  the **closing line** from `data/<sport>/situations_hist.json` (situations.py; ESPN's line
  providers, labelled "closing line", never Onyx; college basketball falls back to
  `data/cbb/history/games_*.json`). Rest and injuries are shown as context and say they are not in
  the rating. NHL skater and college basketball props are priced from the depth projection
  (Poisson; college uses the NBA model's fitted spread) and labelled untested, never recommended;
  NBA sides show Onyx's own no-vig chance (the NBA model prices props, not sides).
- **Bets tab = best bets (11/2, Jordan: "the bets should be the best bets with this team or players
  from this team ... with all of the information, the sliding bars, everything").** A team's Bets
  tab lists every Onyx market on it: its game lines (NFL / CFB / NHL / CBB with the ratings' chance;
  NBA sides with Onyx's own no-vig chance, plus the NBA 1st-quarter and 1st-half totals and the
  1st-quarter winner from the qhCard read) and every prop on its players (NBA: every market
  `bet_ladders` prices, on Onyx's main line; engine sports: every `mk` in the team file). A player's
  Bets tab is the same list for his markets. Order: logged Onyx Picks (`data/picks/ledger.json`,
  matched by selection id), then tested markets by expected return at the Onyx price (blended
  chance x decimal odds - 1, the home Top 10's number), then tested markets priced outside -200 to
  +200, then Onyx-only lines, then markets not tested against Onyx or that did not beat it (these
  show the model's chance, never a dollar figure). "Tested" comes from `cards.json` `tests`
  (`cards.market_tests`: the Onyx Picks backtest verdict per market, `retest` when the live model
  version differs). Every row is badged **Onyx Pick** or **Projection**. The "Best bet" box on top
  is the best positive expected return among tested markets in -200 to +200; with none positive it
  says so and names the closest to fair, never as a best bet. A row opens the full bet card in
  place (Over / Under, Model / Onyx implied / Blended / EV per $10, the distribution, the slider
  that snaps to Onyx's lines, line chips with prices, Add to parlay, Bet on Onyx, save star); a
  spread's chart is the team's margin. NBA player rows open nba.html's own bet card
  (`openBetCard`, then `BC` set to that line and side) above the team card. Engine sports have no
  alternate lines (`sports_odds.py` keeps `is_main` only), so their chips hold the one line; the
  card reads a `lad` ladder (`[line, over, over_sel, under, under_sel, p_model, p_blend]`) if one
  is ever added. NHL game sides carry no chart (the hockey model is Poisson with an overtime rule,
  not one distribution). nba.html's own card orders its market chips best value first and badges
  an Onyx Pick (`OXC.isPick`).
- **Gate:** `node tools/verify_sports.js` opens a team card from a real tap on a game card's team
  name (it must not open the gamecenter) and the player with the most Onyx markets, both faces,
  scrubs the chart and checks it snaps back; `node tools/verify_nba.js` does the same for an NBA
  team card.

