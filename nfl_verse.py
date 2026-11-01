#!/usr/bin/env python3
"""
nfl_verse.py - nflverse's public NFL data, reduced to what the receptions model reads.

nflverse (github.com/nflverse/nflverse-data, free) publishes every play of every game,
weekly snap counts and injury reports. Once a day this pulls the current season's
play-by-play and snap counts and writes data/nfl/nflverse.json:

  ply    [season, week, team, receiver id, {tgt, rec, yds, air}]   targets per game
  team   [season, week, team, {db, tgt, air}]                      dropbacks per game
  snaps  [season, week, team, player key, offense snap share]
  names  {receiver id: "T.Kelce"}
  wk     nflverse weekly player stats (nfl_features.HEAD + FIELDS), the v11 model's inputs

The last season is pulled once and kept (the model's prior). Pipeline-safe: requests only.
"""
import csv, io, json, os, re, sys, time, unicodedata
from datetime import datetime, timezone

import requests

BASE = "https://github.com/nflverse/nflverse-data/releases/download/"
PATH = "data/nfl/nflverse.json"
MAX_AGE_H = 12


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def _csv(url):
    for i in range(3):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 200:
                return csv.DictReader(io.StringIO(r.content.decode("utf-8", "replace")))
        except Exception:
            pass
        time.sleep(3 * (i + 1))
    return None


def season_rows(yr):
    pbp = _csv(f"{BASE}pbp/play_by_play_{yr}.csv")
    sn = _csv(f"{BASE}snap_counts/snap_counts_{yr}.csv")
    if pbp is None:
        return None
    ply, team, names = {}, {}, {}
    for r in pbp:
        if r.get("season_type") not in ("REG", "POST") or not r.get("posteam"):
            continue
        k = (yr, int(r["week"]), r["posteam"])
        t = team.setdefault(k, {"db": 0, "tgt": 0, "air": 0.0})
        if r.get("qb_dropback") == "1":
            t["db"] += 1
        if r.get("pass_attempt") == "1" and r.get("receiver_player_id") and r.get("sack") != "1":
            pk = k + (r["receiver_player_id"],)
            p = ply.setdefault(pk, {"tgt": 0, "rec": 0, "yds": 0.0, "air": 0.0})
            air = float(r.get("air_yards") or 0)
            p["tgt"] += 1
            p["air"] += air
            if r.get("complete_pass") == "1":
                p["rec"] += 1
                p["yds"] += float(r.get("receiving_yards") or 0)
            t["tgt"] += 1
            t["air"] += air
            names[r["receiver_player_id"]] = r.get("receiver_player_name")
    snaps = []
    for r in sn or []:
        if r.get("game_type") in ("REG", "WC", "DIV", "CON", "SB") and r.get("position") in ("WR", "TE", "RB", "FB") \
                and float(r.get("offense_pct") or 0) > 0:
            snaps.append([yr, int(r["week"]), r["team"], nk(r["player"]), float(r.get("offense_pct") or 0)])
    # v11 (11/1): weekly player stats, the inputs of the market models (nfl_features.py)
    import nfl_features as F
    wk = [c for c in (F.compact(r) for r in _csv(f"{BASE}stats_player/stats_player_week_{yr}.csv") or []) if c]
    return {"ply": [[*k, v] for k, v in ply.items()], "team": [[*k, v] for k, v in team.items()],
            "snaps": snaps, "names": names, "wk": wk}


def update(season, path=PATH):
    """Refresh the current season (at most every MAX_AGE_H hours); keep the last one."""
    try:
        D = json.load(open(path))
    except Exception:
        D = {"seasons": {}}
    cur = D["seasons"].get(str(season)) or {}
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(cur["at"])).total_seconds() / 3600 if cur.get("at") else 1e9
    if age >= MAX_AGE_H or "wk" not in cur:
        x = season_rows(season)
        if x:
            D["seasons"][str(season)] = {**x, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            print(f"  nflverse {season}: {len(x['ply'])} player-games, {len(x['team'])} team-games, {len(x['snaps'])} snap rows, "
                  f"{len(x['wk'])} weekly stat rows")
    if str(season - 1) not in D["seasons"] or "wk" not in D["seasons"][str(season - 1)]:
        x = season_rows(season - 1)
        if x:
            D["seasons"][str(season - 1)] = {**x, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    for k in [k for k in D["seasons"] if int(k) < season - 1]:
        D["seasons"].pop(k)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(D, open(path, "w"), separators=(",", ":"))
    return D


if __name__ == "__main__":
    update(int(sys.argv[1]) if len(sys.argv) > 1 else datetime.now().year)
