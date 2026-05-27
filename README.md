[README-8.md](https://github.com/user-attachments/files/28290262/README-8.md)
# Onyx Baseball

A daily HR probability engine and DFS tool for MLB. Combines Statcast quality metrics, pitcher matchups, park environment, and market calibration to surface edge plays where the model diverges from DraftKings lines.

**Live site:** https://onyxjordan.github.io/onyx-baseball-fix

---

## What it does

- **HR probability model** — career rate (Bayesian-regressed), Statcast SC score, pitcher xFIP, park factor, wind/weather, due meter, market calibration
- **Live score ticker** — real-time MLB scores scrolling across the top, green when a player hits an HR, red when their game ends without one
- **Edge plays board** — top plays where model probability exceeds DK implied odds, filtered by power floor (EV90 ≥ 102, barrel ≥ 7%, ISO ≥ 0.110)
- **DFS projections** — full slash-line model (1B/2B/3B/HR/BB/SB/R/RBI) calibrated to DK and FD scoring
- **SB record** — every HR prop pick tracked with odds and result
- **DFS record** — entry/win tracking with P&L charts

## Current record (as of May 26, 2026)

| | Record | P&L |
|---|---|---|
| HR Props | 11-43 (20.4%) | — |
| DraftKings DFS | — | -$64 |
| FanDuel DFS | — | +$46 |
| **Combined DFS** | | **-$18** |

---

## How the autonomous build works

The site rebuilds itself automatically every day at **11:30 AM ET** via GitHub Actions:

```
GitHub Actions (cron: 11:30 AM ET)
  → fetch_data.py
      → reads data/odds.json       ← uploaded manually each morning
      → reads data/salaries.json   ← uploaded manually each morning
      → fetches lineups from MLB Stats API (confirmed + projected fallback)
      → fetches weather from Open-Meteo
      → fetches Statcast L14 from Baseball Savant
  → auto_build.py
      → runs v13 HR model + DFS projections
      → injects into shell.html
      → writes index.html
  → deploys to GitHub Pages (~60s)
```

## Daily update routine (5 minutes)

Each morning before games start:

1. **Download the DK HR odds page as PDF** → upload to Claude → download `odds.json`
2. **Download the DK + FD lineups page as PDF** → upload to Claude → download `salaries.json`
3. **Upload both files** to the repo under `data/odds.json` and `data/salaries.json`
4. **Log today's picks** — add to `data/picks_input.json` before first pitch
5. **After games** — update `data/picks_input.json` with results (hit/miss)

The workflow triggers automatically at 11:30 AM ET. You can also trigger manually from the Actions tab.

## Logging picks and results

To track HR props, create/update `data/picks_input.json`:

```json
[
  {"date":"5/26","player":"Aaron Judge","odds":220,"hit":null},
  {"date":"5/26","player":"Kyle Schwarber","odds":262,"hit":null}
]
```

Set `"hit": true` or `"hit": false` after the game. The build merges these into the PICKS history automatically.

## Files in this repo

| File | Purpose |
|---|---|
| `index.html` | The full Onyx Baseball app (auto-generated daily) |
| `shell.html` | Base template with CAREER_DB baked in |
| `auto_build.py` | Orchestrates model run and HTML injection |
| `fetch_data.py` | Pulls lineups, weather, Statcast from APIs |
| `model.py` | v13 HR probability + DFS projection model |
| `career_db.json` | 687-player career Statcast database |
| `pitcher_db.json` | 828-pitcher career database |
| `data/odds.json` | Today's DK HR odds (uploaded daily) |
| `data/salaries.json` | Today's DK + FD salaries (uploaded daily) |
| `data/picks_input.json` | Today's HR prop picks + results |

## Model version

**v13** — Bayesian base rate regression, full slash-line DFS projections, park-aware composite scoring, live MLB API scoring. See the **Model** tab on the live site for full build history and technical spec.

---

## GitHub Secrets required

| Secret | Source |
|---|---|
| *(none required)* | Odds and salaries are uploaded manually as JSON files |

---

## Roadmap

- Platt scaling (need ~50 outcomes)
- Hit rate by probability bucket
- Speed tier table for SB projections
- Pull% × park interaction
- Auto-parse odds/salaries from PDF via GitHub Actions
