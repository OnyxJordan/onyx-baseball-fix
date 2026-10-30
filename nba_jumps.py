#!/usr/bin/env python3
"""
nba_jumps.py - every opening tip: who jumped and who won it (data/nba/jumps.json).

The first-basket lean on the page needs each jumper's record: the team that wins
the opening tip scores first 65% of the time (2,428 games, 2024-26), so the tip is
most of the team half of "who scores first". ESPN's play-by-play names the two
jumpers and the team that gained possession; this reads that once per final game.

  {"games": {espn_game_id: {"d": date, "j": [jumper, jumper], "w": winner,
                             "st": [the ten starters], "fs": [each team's first shooter]}},
   "players": {espn_athlete_id: [tips won, tips jumped]}}

The same read records who took each team's first field-goal attempt. A starter's
share of his team's first shots (first_shots) is the second half of the
first-basket model: teams run a set for the same man to open games, and that
share beat shot volume alone on 2025-26 (see open_lanes.py, open-v2).

Seeded from the 2024-25 and 2025-26 play-by-play; run daily (nba_fetch.py calls
update()) to add the last few days' finals. Pipeline-safe: ESPN via nba_common only.
"""
import json, sys, time
from datetime import date, timedelta
from pathlib import Path

from nba_common import ESPN, espn_get, game_day

PATH = Path("data/nba/jumps.json")   # fixed: the ESPN backup points nba_common.DATA elsewhere
LOOKBACK_DAYS = 4


def first_shooters(d, team):
    """(the ten starters, each team's first field-goal attempter) from a summary."""
    st = []
    for t in (d.get("boxscore") or {}).get("players") or []:
        for blk in t.get("statistics") or []:
            for a in blk.get("athletes") or []:
                aid = str((a.get("athlete") or {}).get("id") or "")
                if aid and a.get("starter") and aid not in st:
                    st.append(aid)
    fs = {}
    for p in d.get("plays") or []:
        if not p.get("shootingPlay") or p.get("pointsAttempted") not in (2, 3) \
                or ((p.get("type") or {}).get("text") or "").startswith("Free Throw"):
            continue
        aid = str((((p.get("participants") or [{}])[0]).get("athlete") or {}).get("id") or "")
        if aid in team and team[aid] not in fs:
            fs[team[aid]] = aid
        if len(fs) == 2:
            break
    return st, list(fs.values())


def tip(gid):
    """{'j': [a, b], 'w': winner, 'st': [...], 'fs': [...]} from a final game's play-by-play, or None."""
    d = espn_get(f"{ESPN}/summary", {"event": gid}) or {}
    team = {}
    for t in (d.get("boxscore") or {}).get("players") or []:
        tid = str((t.get("team") or {}).get("id") or "")
        for blk in t.get("statistics") or []:
            for a in blk.get("athletes") or []:
                aid = str((a.get("athlete") or {}).get("id") or "")
                if aid:
                    team[aid] = tid
    st, fs = first_shooters(d, team)
    extra = {"st": st, "fs": fs} if len(st) == 10 and len(fs) == 2 else {}
    for p in d.get("plays") or []:
        if (p.get("type") or {}).get("text") == "Jumpball" and (p.get("period") or {}).get("number") == 1:
            js = [str(x["athlete"]["id"]) for x in p.get("participants") or [] if x.get("athlete")][:2]
            won = str((p.get("team") or {}).get("id") or "")
            if len(js) == 2 and js[0] in team and js[1] in team and team[js[0]] != team[js[1]]:
                w = next((x for x in js if team[x] == won), None)
                if w:
                    return {"j": js, "w": w, **extra}
            return extra or None
    return extra or None


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
            if not gid or (gid in games and "st" in games[gid]) \
                    or ((e.get("status") or {}).get("type") or {}).get("name") != "STATUS_FINAL":
                continue
            seen = gid in games          # recorded before first shots were kept: add them, count the tip once
            t = tip(gid)
            if seen:
                if t and "st" in t:
                    games[gid].update(st=t["st"], fs=t["fs"])
                time.sleep(0.25)
                continue
            games[gid] = {"d": str(day), **(t or {"skip": 1})}
            if t and "j" in t:
                for p in t["j"]:
                    r = players.setdefault(p, [0, 0])
                    r[1] += 1
                    r[0] += p == t["w"]
                added += 1
            time.sleep(0.25)
    PATH.write_text(json.dumps(J, separators=(",", ":")), encoding="utf-8")
    print(f"  opening tips: +{added} games, {len(players)} jumpers on record")
    return J


def _season(d):
    return int(d[:4]) if d[5:7] >= "08" else int(d[:4]) - 1


def first_shots(J, today, ids=None):
    """{athlete id: [starts, first shots]}: this season at full weight, last
    season at half, the one before at a quarter (the backtest's decay)."""
    cur, out = _season(str(today)), {}
    for g in (J.get("games") or {}).values():
        if "st" not in g:
            continue
        w = 0.5 ** (cur - _season(g["d"]))
        if w < 0.25:
            continue
        for p in g["st"]:
            if ids is not None and p not in ids:
                continue
            r = out.setdefault(p, [0.0, 0.0])
            r[0] += w
            r[1] += w * (p in g["fs"])
    return {p: [round(a, 2), round(b, 2)] for p, a, b in ((p, *v) for p, v in out.items())}


if __name__ == "__main__":
    # python3 nba_jumps.py [YYYY-MM-DD]  (backfill from that date)
    update(since=date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else None)
