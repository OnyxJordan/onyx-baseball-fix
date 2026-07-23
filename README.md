# Onyx Baseball

A daily MLB home run probability engine. Combines career Statcast profiles, recent form, pitcher matchups, park factors, and live weather to surface plays where the model diverges from the market.

**Live site:** https://onyxjordan.github.io/onyx-baseball-fix

The site is evolving into Onyx Sports Insights: a multi-sport shell that renders per-sport JSON data envelopes. Odds and probabilities only. DFS fields have been retired and will not return.

---

## What it does

- **HR probability model (v19)**: Bayesian-regressed career base rates, Statcast SC score, L14 form, platoon splits, pitcher factor blended from xFIP / HR9 / HRFB / GB% / Barrel%, park HR factor with per-park wind sensitivity, air density (temperature, humidity, pressure), due meter
- **Edge board**: model probability vs DraftKings implied probability where odds are available, with an honest freshness gate (stale odds means no edges and no picks, never fake data)
- **Pick tracking**: qualifying edge plays are auto-logged daily and merged into the running record on the site

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

A second workflow (`refresh_build.yml`) reruns the pipeline hourly from 1:30
to 7:30 PM ET to pick up confirmed lineups, fresh weather, and line moves,
committing and redeploying only when something changed.

## Live layer (client-side, zero backend)

The shell now carries a live score ticker pinned under the nav: all of
today's games with team logos, live scores, inning state, and LIVE / F
badges, polling the MLB Stats API every 90 seconds with an ESPN fallback.
When a modeled player homers, play-by-play detection lights their edge
ticker entry green with an HR badge; a final loss grays it out. All of it
degrades gracefully: with no network the bar simply shows the day's
schedule from the baked payload.

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
| `model.py` | v19 HR probability model |
| `career_db.json` | Hitter career database (canonical, never regenerate) |
| `pitcher_db.json` | Pitcher career database (canonical, never regenerate) |
| `bullpen_db.json` | Team bullpen HR/9 |
| `rebuild_dbs.py` + `rebuild.yml` | Manual workflow to refresh the career DBs |

## Model version

**v19**: nightly self-calibration from graded picks; v18 normalized output, market-anchored blend, edges land in the honest 1-5pp range; v17 de-weighted recency so small-sample hot and cold streaks nudge rather than drive projections; v16 added per-park wind sensitivity, wind classification exposed as `wind_blow`, humidity and pressure air-density terms, platoon factor, 2026 park factor refresh, due meter in output. Every model change gets a version bump and a changelog line at the top of `model.py`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full build-out plan: odds automation, live ticker, in-game HR tracking, pipeline hardening, and the multi-sport envelope.
