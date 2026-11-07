#!/usr/bin/env python3
"""
fb_pace_pull.py - pace and efficiency for every football final (dev only).

11/6 (Jordan: totals "so far off"; tools/totals_audit.py: the ratings model loses most big disagreements with
the line, worst in college football, 18% of games 7+ points apart). Team totals from additive ratings cannot see
pace: two slow, run-heavy offenses (Air Force, Army) shorten the game for each other. This pulls, for every final
in data/<sport>/results.json, each team's offensive plays (rushes + pass attempts), possession time, yards and
points from ESPN's game summary into data/<sport>/pace.json, so a pace x efficiency total can be fitted and tested
(like college basketball's v2 total).

    python3 tools/fb_pace_pull.py cfb [nfl]      resumes: games already in pace.json are skipped
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor

import requests

ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/{lg}/summary"
LG = {"cfb": "college-football", "nfl": "nfl"}
UA = {"User-Agent": "onyx-sports-dev"}


def mmss(s):
    try:
        m, x = str(s).split(":")
        return int(m) * 60 + int(x)
    except Exception:
        return None


def one(lg, gid):
    for i in range(3):
        try:
            j = requests.get(ESPN.format(lg=lg), params={"event": gid}, headers=UA, timeout=20).json()
            out = {}
            for t in (j.get("boxscore") or {}).get("teams") or []:
                st = {s.get("name"): s.get("displayValue") for s in t.get("statistics") or []}
                ca = str(st.get("completionAttempts") or "0/0").replace("-", "/").split("/")
                att = int(ca[1]) if len(ca) > 1 and ca[1].isdigit() else None
                ru = int(st["rushingAttempts"]) if str(st.get("rushingAttempts", "")).isdigit() else None
                out[t["team"]["abbreviation"]] = {"plays": (att or 0) + (ru or 0) if att is not None and ru is not None else None,
                                                   "rush": ru, "pass": att, "top": mmss(st.get("possessionTime")),
                                                   "yds": int(st["totalYards"]) if str(st.get("totalYards", "")).lstrip("-").isdigit() else None}
            return gid, out or None
        except Exception:
            time.sleep(1 + i)
    return gid, None


def main():
    for key in (sys.argv[1:] or ["cfb"]):
        res = json.load(open(f"data/{key}/results.json"))["games"]
        path = f"data/{key}/pace.json"
        P = json.load(open(path)) if os.path.exists(path) else {}
        todo = [g["id"] for g in res if g.get("hs") is not None and str(g["id"]) not in P]
        print(f"{key}: {len(todo)} games to pull ({len(P)} already)")
        with ThreadPoolExecutor(4) as ex:
            for n, (gid, v) in enumerate(ex.map(lambda x: one(LG[key], x), todo), 1):
                if v:
                    P[str(gid)] = v
                if n % 200 == 0:
                    json.dump(P, open(path, "w"), separators=(",", ":"))
                    print(f"  {n}/{len(todo)}")
        json.dump(P, open(path, "w"), separators=(",", ":"))
        print(f"{key}: {len(P)} games with pace in {path}")


if __name__ == "__main__":
    main()
