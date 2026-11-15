#!/usr/bin/env python3
"""
model_record_nfl_replay.py - the NFL Recommended plays' 2026 record before the site's board history (dev only, 11/15).

Jordan (11/15): "fix the record reasonably what it would of recommended and what it would be on the 2026 season ...
do this across all sports with new models". The site's own board history starts 10/30 (tools/model_record_rebuild.py
replays it under the v2 list rules for every sport). For the NFL weeks before that, this replays every Onyx prop line of
the 2026 season (tools/nfl_situational.py: the live chance and side, projections tuned on 2024-25 only) through the
Recommended plays rule (unders in receptions, pass attempts and rushing yards, -150 to +150, expected value 10%+) at
Onyx's opening price, the price the v2 early logging takes, graded off the actual stat. Rows: rule v2, cat "rec",
src "replay" (the page says so). Games on or after 10/30 are left to the board history. Appends only; a row already
in the log is skipped.

    python3 tools/model_record_nfl_replay.py
"""
import os, re, sys, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import json
import model_record as MR      # noqa: E402
import nfl_situational as NS   # noqa: E402

CUT = "2026-10-30"
MK = {"rec": "receptions", "pass_att": "pass attempts", "rush_yds": "rushing yards"}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s)).split()


def main():
    sys.argv = ["x", "--proj", "--role", "--pbp"]
    import nfl_feature_screen as S
    DATA, IX = S.main()
    rows, _ = NS.build_rows(DATA, IX)
    PG = json.load(open(os.path.join(os.path.dirname(MR.PK.ROOT / "x"), "data/nfl/player_games.json")))["rows"]
    names = json.load(open(MR.PK.ROOT / "data/nfl/nflverse.json"))["seasons"]["2026"].get("names") or {}
    by_tm = {}
    for r in PG:
        by_tm.setdefault((r["date"], r["team"]), []).append(r)
    E2V = {"WSH": "WAS", "LAR": "LA"}
    pay = lambda p: p / 100 if p > 0 else 100 / -p
    log = MR.load()
    have = {r["id"] for r in log}
    add = 0
    for r in rows:
        if r["season"] != 2026 or r["date"] >= CUT or r["mkt"] not in MK or r["side"] != "under":
            continue
        ev = r["chance"] * pay(r["price"]) - (1 - r["chance"])
        if not (-150 <= r["price"] <= 150 and ev >= 0.10):
            continue
        short = names.get(r["pid"]) or ""            # "T.McBride"
        first, last = (short.split(".", 1) + [""])[:2] if "." in short else ("", short)
        full = short
        for t in (r["team"], {v: k for k, v in E2V.items()}.get(r["team"], r["team"])):
            for g in by_tm.get((r["date"], t), []):
                n = nk(g["name"])
                if n and n[-1] == (nk(last) or [""])[-1] and (not first or n[0][:1] == first[:1].lower()):
                    full = g["name"]
        home = bool(r["env"][2])
        rid = f"nfl-rec-replay-{r['pid']}-{r['date']}-{r['mkt']}-{MR.RULE}"
        if rid in have:
            continue
        won = None if r["act"] == r["line"] else r["act"] < r["line"]
        log.append({"id": rid, "rule": MR.RULE, "sport": "nfl", "cat": "rec", "cat_title": "Recommended plays", "date": r["date"],
                    "logged_at": r["date"] + "T12:00:00+00:00", "src": "replay", "start": None, "gid": None,
                    "matchup": f"{r['team']} {'vs' if home else '@'} {r['opp']}",
                    "label": f"{full} Under {r['line']} {MK[r['mkt']]}", "market": r["mkt"], "kind": "prop", "name": full,
                    "team": r["team"], "who": r["pid"], "side": "under", "line": r["line"], "hcap": None, "price": r["price"],
                    "chance": round(r["chance"], 4), "edge": round(r["edge"], 4), "sel": None, "model": "replay",
                    "result": "P" if won is None else "W" if won else "L", "actual": r["act"],
                    "profit": 0.0 if won is None else round(pay(r["price"]), 4) if won else -1.0, "graded_at": MR.PK._iso(MR.PK._now())})
        have.add(rid)
        add += 1
    MR.save(log)
    R = [x for x in log if x.get("src") == "replay" and x["sport"] == "nfl"]
    w = sum(x["result"] == "W" for x in R); l = sum(x["result"] == "L" for x in R); u = sum(x["profit"] for x in R)
    print(f"added {add} replay rows; NFL Recommended replay 9/10-10/29: {w}-{l}, {u:+.1f}u, {100 * u / max(w + l, 1):+.1f}%")


if __name__ == "__main__":
    main()
