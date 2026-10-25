#!/usr/bin/env python3
"""Dev-only: pull ESPN season totals (players + teams) for the backtest's
multi-season prior and the aging-curve fit.

  python3 tools/nba_history_pull.py OUT_DIR [first_season] [last_season]

Writes OUT_DIR/history.json = {"players": {season: {espn_id: row}},
"teams": {season: {team: row}}}. Seasons are ESPN labels (2026 = 2025-26)."""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nba_common import espn_season_players, espn_season_teams

out = Path(sys.argv[1])
lo = int(sys.argv[2]) if len(sys.argv) > 2 else 2017
hi = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
hist = {"players": {}, "teams": {}}
for season in range(lo, hi + 1):
    hist["players"][str(season)] = espn_season_players(season)
    hist["teams"][str(season)] = espn_season_teams(season)
    print(f"  {season}: {len(hist['players'][str(season)])} players, {len(hist['teams'][str(season)])} teams")
out.mkdir(parents=True, exist_ok=True)
(out / "history.json").write_text(json.dumps(hist, separators=(",", ":")))
