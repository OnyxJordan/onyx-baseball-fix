# Onyx Baseball

A daily MLB home run probability engine. Combines career Statcast profiles, recent form, pitcher matchups, park factors, and live weather to surface plays where the model diverges from the market.

**Live site:** https://onyxjordan.github.io/onyx-baseball-fix

The site is evolving into Onyx Sports Insights: a multi-sport shell that renders per-sport JSON data envelopes. Odds and probabilities only. DFS fields have been retired and will not return.

---

## What it does

- **HR probability model (v30)**: Bayesian-regressed career base rates, Statcast SC score, L14 form, platoon splits, pitcher factor blended from xFIP / HR9 / HRFB / GB% / Barrel%, park HR factor with per-park wind sensitivity, air density (temperature, humidity, pressure), due meter
- **Edge board**: model probability vs DraftKings implied probability where odds are available, with an honest freshness gate (stale odds means no edges and no picks, never fake data)
- **Pitcher K projections**: expected strikeouts for every starter vs the listed K prop line — 3-year K/BF history anchoring the current season by sample size, season team K% vs the pitcher's hand blended with the actual lineup's L14 K%, park K factor, home/away weighting, xFIP shading; plus projected pitch count, HRs allowed, and win likelihood from the devigged moneyline (Pitchers & Ks tab under SB Tools)
- **Pick tracking**: the top five qualifying edge plays LOCK at the slate's first pregame build (never topped up mid-day) and are auto-graded into the running record

## How the autonomous build works

GitHub Actions runs the full pipeline daily at 11:30 AM ET (cron 15:30 UTC):

```
fetch_data.py
    lineups + probables from MLB Stats API (confirmed, roster fallback)
    game_lines.json written from the schedule (pitchers, ET start times,
        venues, gamePk); betting lines carried over until fetch_odds updates them
    weather.json fetched fresh from Open-Meteo every run
        (per-team overrides via data/weather_manual.json)
    hitter + pitcher L14 form from MLB Stats API byDateRange aggregates
        (Statcast CSVs enrich barrel/EV when present; FanGraphs CSVs are
        only a fallback if the API fails)
fetch_odds.py
    1) The Odds API (ODDS_API_KEY secret): HR props per event, prefers DK
       book; also fills totals + moneylines into game_lines.json
    2) DraftKings direct (403 from datacenter IPs; self-upgrades if lifted)
    3) manual data/odds.json, gated by last git commit time (36h max)
heal_hands.py
    backfills throwing hand for any new probable starter via MLB Stats API
grade_picks.py
    grades pending picks from final boxscores (HR -> hit, played -> miss,
    never appeared -> stays pending)
auto_build.py
    scores every batter with model.project_player()
    applies bullpen exposure and pull-air adjustments to the edge lane
    injects RESULTS / SUMMARIES / ALL_GAME_KEYS into shell.html -> index.html
    fails loudly: zero scored players aborts the build and keeps yesterday's page
    off-days exit clean without touching the page
update_stats.py
    merges data/picks_input.json into the PICKS record inside index.html
deploy to GitHub Pages
```

A second workflow (`refresh_build.yml`) reruns the full pipeline every 30
minutes from 11 AM to 11 PM ET to pick up confirmed lineups, fresh weather,
and HR-prop line moves through in-game at-bats, committing and redeploying
only when something changed. This keeps the live edge board (decayed model
probability vs the current line) honest during games; prop pulls are
skipped for games that started more than ~4.5h ago to save Odds API
credits. It also appends the market line-history snapshots that used to
live in a separate pulse workflow.

## Live layer (client-side, zero backend)

The shell now carries a live score ticker pinned under the nav: all of
today's games with team logos, live scores, inning state, and LIVE / F
badges, polling the MLB Stats API every 90 seconds with an ESPN fallback.
When a modeled player homers, play-by-play detection lights their edge
ticker entry green with an HR badge; a final loss grays it out. All of it
degrades gracefully: with no network the bar simply shows the day's
schedule from the baked payload.

## Onyx ticket links

Every price on the site (moneyline Yes/No, run lines, totals, HR props on
the Plays board and player cards) deep links to Onyx's public share
endpoint, which resolves the pick server-side against live Onyx odds and
renders a branded ticket preview with the app CTA.

Onyx is built on OpticOdds, and a game's Onyx URL uses the OpticOdds
fixture id as its slug (`{id1}-{id2}-{date}-{nn}`). Slugs change daily, so
`fetch_onyx.py` pulls them straight from the OpticOdds fixtures API each
run:

- Set the `OPTICODDS_API_KEY` secret (Onyx's OpticOdds/OddsJam key). The
  script fetches `api.opticodds.com/api/v3/fixtures?league=mlb` for today,
  reads each fixture id (= slug) and its home/away teams, and writes
  `data/onyx_games.json`. No cookie, nothing that expires.
- No key: the existing `data/onyx_games.json` is kept. The file can also
  be hand-edited (`{"date": "YYYY-MM-DD", "links": {"SD_ATL": "<slug>"}}`).
- `auto_build.py` injects only same-day links; games without a slug fall
  back to the real Onyx MLB board (`ONYX_FALLBACK_URL`), never a 404. All
  links carry the referral code (`ONYX_REFERRER` in `shell.html`).

Verified market keys for the share endpoint: `moneyline` ("Atlanta
Braves"), `run_line` ("San Diego Padres +1.5"), `total_runs` ("Over 9.5"),
`player_home_runs` ("{Player} Over 0.5").

## Push notifications (closed-app)

In-app alerts (Notification API) fire while the site is open. True push
with the app closed rides OneSignal's free tier plus a GitHub Actions
watcher (`notify_watch.yml` -> `push_watch.py`) that polls live games
every ~45 seconds through game hours and sends within about a minute:

- **HR pushes**: modeled batters only — headline `💣 HR — {name} ({team})`,
  body carries the Statcast line (distance, EV, launch angle, pitcher) and
  what the model projected pregame (probability, edge, listed odds).
- **Final pushes**: score line when a game the watcher saw live goes final.

Setup (one time): create a free OneSignal Web Push app pointed at the live
site URL, paste the Web App ID into `ONESIGNAL_APP_ID` in `shell.html`,
and add `ONESIGNAL_APP_ID` + `ONESIGNAL_API_KEY` (REST key) repo secrets.
The in-app bell toggles map to OneSignal tags (`hr`, `final`), so HR-only
or finals-only preferences hold across both delivery paths. Without the
keys everything is a free no-op and in-app alerts still work. iPhone users
must add the site to their home screen (iOS requires an installed PWA for
web push).

## Daily routine

With the `ODDS_API_KEY` secret set: nothing. Odds, totals, moneylines, lineups, weather, L14 form, and pick grading are all automatic. Manual hooks that still work if ever needed:

- `data/odds.json` upload (fallback when The Odds API is unavailable; freshness gated at 36h via git commit time)
- `data/weather_manual.json` per-team weather overrides
- Hand-editing `"hit"` in `data/picks_input.json` (auto-grading normally does this)

If odds are stale or missing the site still builds, just without edges or new picks.

## Files in this repo

| File | Purpose |
|---|---|
| `index.html` | The built site (generated daily, do not edit) |
| `shell.html` | Canonical template. Never regenerate; surgical edits only |
| `fetch_data.py` | Lineups, game lines, weather, L14 form |
| `fetch_odds.py` | The Odds API -> DK -> manual fallback chain + freshness gate |
| `heal_hands.py` | Rolling pitcher-hand backfill |
| `grade_picks.py` | Automatic pick grading from final boxscores |
| `auto_build.py` | Model run + HTML injection |
| `update_stats.py` | Pick record persistence across rebuilds |
| `model.py` | v30 HR probability model + pitcher K projections |
| `career_db.json` | Hitter career database (canonical, never regenerate) |
| `pitcher_db.json` | Pitcher career database (canonical, never regenerate) |
| `bullpen_db.json` | Team bullpen HR/9 |
| `rebuild_dbs.py` + `rebuild.yml` | Manual workflow to refresh the career DBs |

## Model version

**v30**: launch geometry (career FB% + pull rate, validated on 3 weeks of actual homers: equal-barrel hitters split by FB% homer at a 1.20x ratio) joins the contact-quality anchor, which now applies to every projection path (it had been dormant for regulars), and the daily five picks LOCK at the slate's first pregame build, no topping up across refresh runs; v29 set career anchors everywhere, HRs-allowed and displayed pitcher HR/9 now build from 3-year rates with the season shrunk in by innings and L14 as a nudge, and the Statcast quality score caps recent-form influence at 45%, large samples project and recency advises across the whole site; v28 put the K model on a real sample, 3-year K/BF history anchors the current season (shrunk by its own batters faced) and the opponent read blends season team K% vs hand with the lineup's L14 form, lifting consensus correlation to 0.77 with 0.66 K average error; v27 set the calibration medium (vig 0.12 / level 0.95, between the pure consensus correction and the graded tuning arc) plus the pitcher K projection module, validated at 0.69 correlation and under one strikeout of average error against the same professional consensus; v26 set the consensus-calibrated level, validated against a professional projection slate (0.942 correlation) and corrected for a +3pp global hot bias via a recalibrated vig strip (0.16) and a fixed 0.90 level anchor; v25 added top-end headroom and lineup-slot plate appearances, the soft ceiling that made it mathematically impossible to match a short price (locking every elite hitter into negative edge) now starts at 24 with a 34 cap, and expected PAs scale by batting-order slot instead of a flat 3.5 for all nine spots; v24 added player-specific platoon power, each bat's real vs-LHP / vs-RHP HR rate (career + season, MLB Stats API) shrunk toward the league prior by sample size, and real bat sides from the API (the lineup feed had every batter as "R", so lefty-lefty matchups were being boosted instead of penalized); v23 rebuilt the pressure term as a true weather signal, sea-level pressure (not station pressure, which mostly encoded stadium elevation already owned by the park factors) with a physics-calibrated coefficient so real barometric swings move the number ~±2%; v22 added the power-anchored base rate, the base HR/PA blends outcome history 55/45 with expected HR/PA from barrel rate so no-power profiles cannot project like sluggers, plus a soft ceiling that keeps top-of-board separation instead of a wall of identical capped values; v21 added the pick quality floor, a tracked play must show at least a 32% hard-hit rate and 5% barrel rate so speed-only profiles never make the money list; v20 measured edge vs the listed price so positive edge always means positive EV; v19 added nightly self-calibration from graded picks; v18 normalized output, market-anchored blend, edges land in the honest 1-5pp range; v17 de-weighted recency so small-sample hot and cold streaks nudge rather than drive projections; v16 added per-park wind sensitivity, wind classification exposed as `wind_blow`, humidity and pressure air-density terms, platoon factor, 2026 park factor refresh, due meter in output. Every model change gets a version bump and a changelog line at the top of `model.py`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full build-out plan: odds automation, live ticker, in-game HR tracking, pipeline hardening, and the multi-sport envelope.
