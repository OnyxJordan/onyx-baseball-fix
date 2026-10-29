#!/usr/bin/env python3
"""
nba_jumps.py - every opening tip: who jumped and who won it (data/nba/jumps.json).

The first-basket lean on the page needs each jumper's record: the team that wins
the opening tip scores first 65% of the time (2,428 games, 2024-26), so the tip is
most of the team half of "who scores first". ESPN's play-by-play names the two
jumpers and the team that gained possession; this reads that once per final game.

  {"games": {espn_game_id: {"d": date, "j": [jumper, jumper], "w": winner}},
   "players": {espn_athlete_id: [tips won, tips jumped]}}

Seeded from the 2024-25 and 2025-26 play-by-play; run daily (nba_fetch.py calls
update()) to add the last few days' finals. Pipeline-safe: ESPN via nba_common only.
"""
import json, sys, time
from datetime import date, timedelta
from pathlib import Path

from nba_common import ESPN, espn_get, game_day

PATH = Path("data/nba/jumps.json")   # fixed: the ESPN backup points nba_common.DATA elsewhere
LOOKBACK_DAYS = 4


def tip(gid):
    """{'j': [a, b], 'w': winner} from a final game's play-by-play, or None."""
    d = espn_get(f"{ESPN}/summary", {"event": gid}) or {}
    team = {}
    for t in (d.get("boxscore") or {}).get("players") or []:
        tid = str((t.get("team") or {}).get("id") or "")
        for blk in t.get("statistics") or []:
            for a in blk.get("athletes") or []:
                aid = str((a.get("athlete") or {}).get("id") or "")
                if aid:
                    team[aid] = tid
    for p in d.get("plays") or []:
        if (p.get("type") or {}).get("text") == "Jumpball" and (p.get("period") or {}).get("number") == 1:
            js = [str(x["athlete"]["id"]) for x in p.get("participants") or [] if x.get("athlete")][:2]
            won = str((p.get("team") or {}).get("id") or "")
            if len(js) == 2 and js[0] in team and js[1] in team and team[js[0]] != team[js[1]]:
                w = next((x for x in js if team[x] == won), None)
                if w:
                    return {"j": js, "w": w}
            return None
    return None


def update(today=None, since=None):
    try:
        J = json.loads(PATH.read_text(encoding="utf-8"))
    except Exception:
        J = {}
    games, players = J.setdefault("games", {}), J.setdefault("players", {})
    today = today or game_day()
    added = 0
    back = (today - since).days if since else LOOKBACK_DAYS
    for k in range(back, -1, -1):
        day = today - timedelta(days=k)
        sb = espn_get(f"{ESPN}/scoreboard", {"dates": day.strftime("%Y%m%d")}) or {}
        for e in sb.get("events") or []:
            gid = str(e.get("id") or "")
            if not gid or gid in games or ((e.get("status") or {}).get("type") or {}).get("name") != "STATUS_FINAL":
                continue
            t = tip(gid)
            games[gid] = {"d": str(day), **(t or {"skip": 1})}
            if t:
                for p in t["j"]:
                    r = players.setdefault(p, [0, 0])
                    r[1] += 1
                    r[0] += p == t["w"]
                added += 1
            time.sleep(0.25)
    PATH.write_text(json.dumps(J, separators=(",", ":")), encoding="utf-8")
    print(f"  opening tips: +{added} games, {len(players)} jumpers on record")
    return J


if __name__ == "__main__":
    # python3 nba_jumps.py [YYYY-MM-DD]  (backfill from that date)
    update(since=date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else None)
