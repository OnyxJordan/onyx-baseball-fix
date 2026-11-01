#!/usr/bin/env python3
"""
nhl_game_screen.py - NHL moneyline, total goals and puck line against Onyx's price, the
NFL v11 method. Dev only. Team form from NHL API boxscores (tools/nhl_box_pull.py):
goals and shots for and against over 5 / 10 / 20 games, save percentage, rest and
back-to-backs. Chosen on games before 2/1/2026, judged after.

    python3 tools/nhl_game_screen.py [--select] [ml|total|puck]
"""
import json, os, sys
from collections import defaultdict
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                  # noqa: E402
import nfl_feature_screen as S          # noqa: E402

SPLIT = "2026-02-01"


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    box = sorted(json.load(open("bt/nhl_api_box.json")).values(), key=lambda g: (g["date"], g["id"]))
    names = {}
    for x in json.load(open("bt/nhl_box.json")):
        names[x["home_name"]] = x["home"]
        names[x["away_name"]] = x["away"]
    tlog = defaultdict(list)
    by_game = {}
    for g in box:
        if g.get("hs") is None or g.get("type") not in (2, 3):
            continue
        gs = {True: [p for p in g["p"] if p["pos"] == "G" and p["h"]], False: [p for p in g["p"] if p["pos"] == "G" and not p["h"]]}
        for home in (True, False):
            t, o = (g["home"], g["away"]) if home else (g["away"], g["home"])
            gf, ga = (g["hs"], g["as"]) if home else (g["as"], g["hs"])
            sf, sa = (g["hsog"], g["asog"]) if home else (g["asog"], g["hsog"])
            tlog[t].append({"date": g["date"], "gf": gf, "ga": ga, "sf": sf or 0, "sa": sa or 0, "home": home,
                            "pim": 0})
        by_game[(g["date"], g["home"], g["away"])] = g
    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0

    def form(t, d):
        h = [x for x in tlog[t] if x["date"] < d]
        if len(h) < 5:
            return None
        l5, l10, l20 = h[-5:], h[-10:], h[-20:]
        rest = (date.fromisoformat(d) - date.fromisoformat(h[-1]["date"])).days
        sv = 1 - sum(x["ga"] for x in l20) / max(1.0, sum(x["sa"] for x in l20))
        return {"gf5": mean([x["gf"] for x in l5]), "ga5": mean([x["ga"] for x in l5]), "gf10": mean([x["gf"] for x in l10]),
                "ga10": mean([x["ga"] for x in l10]), "gf20": mean([x["gf"] for x in l20]), "ga20": mean([x["ga"] for x in l20]),
                "sf10": mean([x["sf"] for x in l10]), "sa10": mean([x["sa"] for x in l10]), "sf20": mean([x["sf"] for x in l20]),
                "sa20": mean([x["sa"] for x in l20]), "sv20": sv, "sh20": sum(x["gf"] for x in l20) / max(1.0, sum(x["sf"] for x in l20)),
                "rest": float(min(rest, 5)), "b2b": 1.0 if rest <= 1 else 0.0, "w10": mean([1.0 if x["gf"] > x["ga"] else 0.0 for x in l10])}

    lines = json.load(open("bt/nhl_lines.json"))
    DATA = {"ml": [], "total": [], "puck": []}
    for fid, x in lines.items():
        h_, a_ = names.get(x["home"]), names.get(x["away"])
        st = (x.get("start") or "")[:10]
        if not h_ or not a_ or x.get("season_type") == "Preseason" or not st:
            continue
        g = None
        for dd in (st, date.fromordinal(date.fromisoformat(st).toordinal() - 1).isoformat()):
            g = by_game.get((dd, h_, a_)) or g
        if not g:
            continue
        H, A = form(h_, g["date"]), form(a_, g["date"])
        if not H or not A:
            continue
        f = {**{"h_" + k: v for k, v in H.items()}, **{"a_" + k: v for k, v in A.items()}}
        for k in ("gf10", "ga10", "sf10", "sa10", "sv20", "sh20", "rest", "b2b", "w10", "gf20", "ga20", "sf20", "sa20"):
            f["d_" + k] = H[k] - A[k]
        f["xg_h"] = (H["sf20"] + A["sa20"]) / 2 * (H["sh20"] + (1 - A["sv20"])) / 2
        f["xg_a"] = (A["sf20"] + H["sa20"]) / 2 * (A["sh20"] + (1 - H["sv20"])) / 2
        f["xg_tot"], f["xg_diff"] = f["xg_h"] + f["xg_a"], f["xg_h"] - f["xg_a"]
        gm = x.get("game") or {}
        season = 2025 if g["date"] < SPLIT else 2026
        ml = gm.get("moneyline") or {}
        mh, ma = (ml.get(x["home"]) or {}).get("o"), (ml.get(x["away"]) or {}).get("o")
        if mh and ma and mh[1] is not None and ma[1] is not None:
            ph, pa = L.implied(mh[1]), L.implied(ma[1])
            if 1.0 <= ph + pa <= 1.1:
                c1, c2 = ((ml.get(x["home"]) or {}).get("c") or [None, None])[1], ((ml.get(x["away"]) or {}).get("c") or [None, None])[1]
                DATA["ml"].append({"season": season, "date": g["date"], "p": ph / (ph + pa), "po": mh[1], "pu": ma[1], "line_": 0,
                                   "cl": 0 if c1 is not None and c2 is not None else None, "co": c1, "cu": c2,
                                   "y": int(g["hs"] > g["as"]), "f": f})
        tt = gm.get("total_goals") or {}
        if tt.get("over") and tt.get("under") and tt["over"]["o"][0] is not None and None not in (tt["over"]["o"][1], tt["under"]["o"][1]):
            ln, po, pu = tt["over"]["o"][0], tt["over"]["o"][1], tt["under"]["o"][1]
            io, iu = L.implied(po), L.implied(pu)
            if 1.0 <= io + iu <= 1.1 and g["hs"] + g["as"] != ln:
                c, cu = tt["over"].get("c") or [None, None], (tt["under"].get("c") or [None, None])[1]
                DATA["total"].append({"season": season, "date": g["date"], "p": io / (io + iu), "po": po, "pu": pu, "line_": ln,
                                      "cl": c[0], "co": c[1], "cu": cu, "y": int(g["hs"] + g["as"] > ln), "f": dict(f, line=ln)})
        pl = gm.get("puck_line") or {}
        if x["home"] in pl and x["away"] in pl and pl[x["home"]]["o"][0] is not None:
            ln, po, pu = pl[x["home"]]["o"][0], pl[x["home"]]["o"][1], pl[x["away"]]["o"][1]
            if po is not None and pu is not None:
                io, iu = L.implied(po), L.implied(pu)
                marg = g["hs"] - g["as"] + ln
                if 1.0 <= io + iu <= 1.1 and marg != 0:
                    c, cu = pl[x["home"]].get("c") or [None, None], (pl[x["away"]].get("c") or [None, None])[1]
                    DATA["puck"].append({"season": season, "date": g["date"], "p": io / (io + iu), "po": po, "pu": pu, "line_": ln,
                                         "cl": c[0], "co": c[1], "cu": cu, "y": int(marg > 0), "f": dict(f, line=ln)})
    for k in list(DATA):
        if only and k not in only:
            DATA.pop(k)
            continue
        print(f"{k}: {sum(1 for s in DATA[k] if s['season'] == 2025)} before {SPLIT}, {sum(1 for s in DATA[k] if s['season'] == 2026)} after")
    if "--select" not in sys.argv:
        S.screen(DATA, "bt/nhl_game_screen.json")
    S.select_and_test(DATA, out="bt/nhl_game_select.json")


if __name__ == "__main__":
    main()
