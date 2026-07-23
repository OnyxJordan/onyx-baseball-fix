# Onyx Baseball

A daily MLB home run probability engine. Combines career Statcast profiles, recent form, pitcher matchups, park factors, and live weather to surface plays where the model diverges from the market.

**Live site:** https://onyxjordan.github.io/onyx-baseball-fix

The site is evolving into Onyx Sports Insights: a multi-sport shell that renders per-sport JSON data envelopes. Odds and probabilities only. DFS fields have been retired and will not return.

---

## What it does

- **HR probability model (v16)**: Bayesian-regressed career base rates, Statcast SC score, L14 form, platoon splits, pitcher factor blended from xFIP / HR9 / HRFB / GB% / Barrel%, park HR factor with per-park wind sensitivity, air density (temperature, humidity, pressure), due meter
- **Edge board**: model probability vs DraftKings implied probability where odds are available, with an honest freshness gate (stale odds means no edges and no picks, never fake data)
- **Pick tracking**: qualifying edge plays are auto-logged daily and merged into the running record on the site

## How the autonomous build works

GitHub Actions runs the full pipeline daily at 11:30 AM ET (cron 15:30 UTC):

```
fetch_data.py
    lineups + probables from MLB Stats API (confirmed, roster fallback)
    game_lines.json written from the schedule (pitchers, start times, venues;
        manually uploaded betting totals/moneylines are carried over by game key)
    weather.json fetched fresh from Open-Meteo every run
        (per-team overrides via data/weather_manual.json)
    hitter L14 from data/fangraphs_l14.csv + Statcast CSVs
    pitcher L14 from data/fangraphs_pitchers_l14.csv
fetch_odds.py
    tries the DraftKings API (currently 403 from datacenter IPs)
    falls back to manually uploaded data/odds.json
    freshness judged by last git commit touching odds.json (36h max)
heal_hands.py
    backfills throwing hand for any new probable starter via MLB Stats API
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

## Daily routine (manual, until odds are automated)

1. Upload fresh HR odds to `data/odds.json` (shape: `{"Player Name": american_int}`)
2. Optionally update totals/moneylines in `data/game_lines.json` (only `total`, `away_ml`, `home_ml` are read; pitchers, times, venues are automatic)
3. After games, set `"hit": true/false` on entries in `data/picks_input.json`

Everything else is automatic. If odds are stale or missing the site still builds, just without edges or new picks.

## Files in this repo

| File | Purpose |
|---|---|
| `index.html` | The built site (generated daily, do not edit) |
| `shell.html` | Canonical template. Never regenerate; surgical edits only |
| `fetch_data.py` | Lineups, game lines, weather, L14 form |
| `fetch_odds.py` | Odds freshness gate (DK fetch attempt + manual fallback) |
| `heal_hands.py` | Rolling pitcher-hand backfill |
| `auto_build.py` | Model run + HTML injection |
| `update_stats.py` | Pick record persistence across rebuilds |
| `model.py` | v16 HR probability model |
| `career_db.json` | Hitter career database (canonical, never regenerate) |
| `pitcher_db.json` | Pitcher career database (canonical, never regenerate) |
| `bullpen_db.json` | Team bullpen HR/9 |
| `rebuild_dbs.py` + `rebuild.yml` | Manual workflow to refresh the career DBs |

## Model version

**v16**: per-park wind sensitivity, wind classification exposed as `wind_blow`, humidity and pressure air-density terms, platoon factor, 2026 park factor refresh, due meter in output. Every model change gets a version bump and a changelog line at the top of `model.py`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full build-out plan: odds automation, live ticker, in-game HR tracking, pipeline hardening, and the multi-sport envelope.
