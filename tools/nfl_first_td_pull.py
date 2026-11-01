#!/usr/bin/env python3
"""nfl_first_td_pull.py - the first touchdown of every NFL game in data/nfl/player_games.json,
from ESPN's scoring plays (dev only; feeds the rules lab's first-TD scorer grading).

    python3 tools/nfl_first_td_pull.py bt/nfl_first_td.json

Writes {espn game id: {"name": scorer or None, "kind": "td" | "def" | "none"}}. The scorer is named
for return touchdowns too ("kind": "return"), as books grade the first TD scorer; "none"
means no touchdown in the game, and every ticket loses."""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from nba_common import espn_get   # noqa: E402

SUM = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary"


def first_td(gid):
    d = espn_get(SUM, {"event": gid}) or {}
    plays = d.get("scoringPlays")
    if plays is None:
        return None
    for p in plays:
        if (p.get("scoringType") or {}).get("abbreviation") != "TD":
            continue
        txt = p.get("text") or ""
        # the scorer leads the text: "Name 12 Yd pass from QB (kick)", "Name 98 Yd Kickoff Return";
        # a lateral credits the last man: "... lateral to Name for 80 yards"
        m = re.search(r"lateral to (.+?) for \d+", txt) or re.match(r"^(.+?) \d+ (?:Yd|yd|Yard|yard)", txt)
        low = txt.lower()
        ret = any(w in low for w in ("interception return", "fumble return", "punt return", "kickoff return",
                                     "return of blocked", "blocked punt return", "blocked field goal return"))
        return {"name": m.group(1).strip() if m else None, "kind": "return" if ret else "td", "text": txt[:120]}
    return {"name": None, "kind": "none"}


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "bt/nfl_first_td.json"
    rows = json.load(open("data/nfl/player_games.json"))["rows"]
    gids = sorted({r["gid"] for r in rows})
    out = json.load(open(out_path)) if os.path.exists(out_path) else {}
    for i, g in enumerate(gids):
        if g in out:
            continue
        r = first_td(g)
        if r is not None:
            out[g] = r
        if i % 50 == 0:
            print(i, len(gids), flush=True)
            json.dump(out, open(out_path, "w"))
        time.sleep(0.15)
    json.dump(out, open(out_path, "w"))
    print("games", len(out), "defensive/none", sum(1 for v in out.values() if not v["name"]))


if __name__ == "__main__":
    main()
