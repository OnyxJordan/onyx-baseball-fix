#!/usr/bin/env python3
"""nhl_box_pull.py - NHL API boxscores (ice time, position, power-play goals, shots,
hits, blocks; goalie saves) for every game in bt/nhl_box.json -> bt/nhl_api_box.json.
Dev only: feeds tools/nhl_feature_screen.py."""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests

OUT = "bt/nhl_api_box.json"


def toi(s):
    try:
        m, sec = s.split(":")
        return int(m) + int(sec) / 60
    except Exception:
        return 0.0


def one(gid):
    for i in range(3):
        try:
            r = requests.get(f"https://api-web.nhle.com/v1/gamecenter/{gid}/boxscore", timeout=30)
            if r.status_code == 200:
                d = r.json()
                out = {"id": gid, "date": d.get("gameDate"), "type": d.get("gameType"),
                       "home": d["homeTeam"]["abbrev"], "away": d["awayTeam"]["abbrev"],
                       "hs": d["homeTeam"].get("score"), "as": d["awayTeam"].get("score"),
                       "hsog": d["homeTeam"].get("sog"), "asog": d["awayTeam"].get("sog"), "p": []}
                for side in ("homeTeam", "awayTeam"):
                    pb = d.get("playerByGameStats", {}).get(side, {})
                    for grp in ("forwards", "defense", "goalies"):
                        for x in pb.get(grp, []):
                            row = {"id": x["playerId"], "n": x["name"]["default"], "h": side == "homeTeam", "pos": x.get("position"),
                                   "toi": round(toi(x.get("toi", "0:00")), 2)}
                            if grp == "goalies":
                                row.update(sa=x.get("shotsAgainst", 0), sv=x.get("saves", 0), ga=x.get("goalsAgainst", 0),
                                           st=bool(x.get("starter")))
                            else:
                                row.update(g=x.get("goals", 0), a=x.get("assists", 0), pts=x.get("points", 0), sog=x.get("sog", 0),
                                           ppg=x.get("powerPlayGoals", 0), hit=x.get("hits", 0), blk=x.get("blockedShots", 0),
                                           pm=x.get("plusMinus", 0), sh=x.get("shifts", 0))
                            out["p"].append(row)
                return out
            if r.status_code == 404:
                return None
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return None


def main():
    ids = sorted({x["id"] for x in json.load(open("bt/nhl_box.json"))})
    have = json.load(open(OUT)) if os.path.exists(OUT) else {}
    todo = [g for g in ids if str(g) not in have]
    print(f"{len(ids)} games, {len(todo)} to pull", flush=True)
    with ThreadPoolExecutor(8) as ex:
        for i, r in enumerate(ex.map(one, todo)):
            if r:
                have[str(r["id"])] = r
            if i % 250 == 0:
                print(i, flush=True)
                json.dump(have, open(OUT, "w"))
    json.dump(have, open(OUT, "w"))
    print("done", len(have))


if __name__ == "__main__":
    main()
