#!/usr/bin/env python3
"""
cfb_feature_screen.py - college football player props (receptions, receiving, rushing and
passing yards) against Onyx's price, the NFL v11 method. Dev only (bt/ files).

One season of Onyx props (2026), so the split is by date: statistics chosen on lines before
SPLIT (labelled 2025 in the output), judged on lines after it (labelled 2026). Inputs: ESPN
box scores (data/cfb/player_games.json) and Onyx's spread and total (bt/cfb_lines.json).

    python3 tools/cfb_feature_screen.py [--select] [rec|rec_yds|rush_yds|pass_yds]
"""
import json, os, re, sys, unicodedata
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                  # noqa: E402
import nfl_feature_screen as S          # noqa: E402

SPLIT = "2026-10-01"
MARKETS = {"rec": "player_receptions", "rec_yds": "player_receiving_yards", "rush_yds": "player_rushing_yards",
           "pass_yds": "player_passing_yards"}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    import cfb_players as C
    rows = json.load(open("data/cfb/player_games.json"))["rows"]
    IX = C.MarketIndex(rows)
    by_day_name = {}
    for r in rows:
        by_day_name[(r["date"], nk(r["name"]))] = r
    lines = json.load(open("bt/cfb_lines.json"))
    props = json.load(open("bt/cfb_props.json"))
    DATA = {}
    for mkt, mid in MARKETS.items():
        if only and mkt not in only:
            continue
        out = []
        for fid, x in props.items():
            gl = (lines.get(fid) or x).get("game") or {}
            sp, tt = gl.get("point_spread") or {}, gl.get("total_points") or {}
            if x["home"] not in sp or "over" not in tt or sp[x["home"]]["o"][0] is None or tt["over"]["o"][0] is None:
                continue
            hsp, tot = sp[x["home"]]["o"][0], tt["over"]["o"][0]
            d0 = (x.get("start") or "")[:10]
            for nm, mk in (x.get("props") or {}).items():
                v = mk.get(mid)
                if not v or None in v["o"]:
                    continue
                ln, po, pu = v["o"]
                io, iu = L.implied(po), L.implied(pu)
                if not (1.0 <= io + iu <= 1.15):
                    continue
                r = None
                for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
                    r = by_day_name.get((dd, nk(nm))) or r
                if r is None:
                    continue           # no box line: did not play or not found, void
                act = r.get(mkt) or 0.0
                if act == ln:
                    continue
                f = IX.features(r["pid"], r["team"], r["opp"], r["home"], r["date"], ln, mkt,
                                hsp if r["home"] else -hsp, tot)
                if f is None:
                    continue
                c = v.get("c") or [None, None, None]
                out.append({"season": 2025 if r["date"] < SPLIT else 2026, "date": r["date"], "p": io / (io + iu),
                            "po": po, "pu": pu, "line_": ln, "cl": c[0], "co": c[1], "cu": c[2], "line": ln,
                            "y": int(act > ln), "f": f})
        DATA[mkt] = out
        print(f"{mkt}: {sum(1 for s in out if s['season'] == 2025)} before {SPLIT}, {sum(1 for s in out if s['season'] == 2026)} after")
    if "--select" not in sys.argv:
        S.screen(DATA, "bt/cfb_screen.json")
    S.select_and_test(DATA, out="bt/cfb_select.json")


if __name__ == "__main__":
    main()
