#!/usr/bin/env python3
"""
tennis_feature_screen.py - tennis match winner, games spread and total games against
Onyx's price, the NFL v11 method. Dev only (bt/ files).

Statistics are rebuilt match by match from bt/tennis_results_full.json (every ATP and WTA
singles result since 2023), so each one is known before the match: Elo (tennis_model),
surface Elo, form and fatigue over 14 / 45 days, share of games won, games per match.
Chosen on Onyx lines before 2026-01-01 (labelled 2025), judged after (labelled 2026).

    python3 tools/tennis_feature_screen.py [--select] [ml|total|spread]
"""
import json, os, sys
from collections import defaultdict, deque
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                  # noqa: E402
import nfl_feature_screen as S          # noqa: E402
import tennis_model as TM               # noqa: E402
from sports_common import nk            # noqa: E402

SPLIT = "2026-01-01"
CLAY = ("roland", "french open", "madrid", "rome", "internazionali", "monte", "barcelona", "hamburg", "gstaad", "kitzb", "umag",
        "bastad", "bucharest", "estoril", "marrakech", "houston", "geneva", "lyon", "cordoba", "buenos aires", "rio", "santiago",
        "charleston", "stuttgart open", "strasbourg", "rabat", "palermo", "parma", "prague", "bogota", "lausanne", "iasi")
GRASS = ("wimbledon", "halle", "queen", "stuttgart", "s-hertogenbosch", "hertogenbosch", "mallorca", "eastbourne", "newport",
         "berlin", "bad homburg", "nottingham", "birmingham")


def surface(event):
    e = (event or "").lower()
    if any(k in e for k in GRASS) and "stuttgart open" not in e:
        return "grass"
    if any(k in e for k in CLAY):
        return "clay"
    return "hard"


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    res = sorted(json.load(open("bt/tennis_results_full.json")), key=lambda m: m["date"])
    # walk forward: a snapshot of each player's state before every match date
    E = TM.Elo(TM.P)
    ES = {s: TM.Elo(TM.P) for s in ("hard", "clay", "grass")}
    hist = defaultdict(deque)   # player -> recent (date, won, games_for, games_against)
    snap = {}                   # (date, player) -> features before that date
    by_day = defaultdict(list)
    for m in res:
        by_day[m["date"]].append(m)
    days = sorted(by_day)

    def state(p, d, sfc, opp):
        h = [x for x in hist[p] if x[0] >= (date.fromisoformat(d) - timedelta(days=45)).isoformat()]
        h14 = [x for x in h if x[0] >= (date.fromisoformat(d) - timedelta(days=14)).isoformat()]
        gf, ga = sum(x[2] for x in h), sum(x[3] for x in h)
        return {"elo": E.r.get(p, 1500.0), "n": E.n.get(p, 0), "selo": ES[sfc].r.get(p, 1500.0), "sn": ES[sfc].n.get(p, 0),
                "f45": (sum(x[1] for x in h) + 1) / (len(h) + 2), "n45": len(h), "n14": len(h14),
                "gshare": (gf + 6) / (gf + ga + 12), "gpm": (gf + ga) / len(h) if h else 22.0,
                "rest": (date.fromisoformat(d) - date.fromisoformat(hist[p][-1][0])).days if hist[p] else 30}
    lines = {}
    for fn, tour in (("bt/tennis_atp_lines.json", "ATP"), ("bt/tennis_wta_lines.json", "WTA")):
        for fid, x in json.load(open(fn)).items():
            lines[fid] = dict(x, tour=tour)
    want = defaultdict(list)    # date -> lines starting that day (UTC date and the day before)
    for fid, x in lines.items():
        d0 = (x.get("start") or "")[:10]
        if d0:
            want[d0].append(fid)
            want[(date.fromisoformat(d0) - timedelta(days=1)).isoformat()].append(fid)
    feats = {}                  # fid -> (match, home state, away state)
    for d in days:
        for m in by_day[d]:
            a, b = nk(m["w"]), nk(m["l"])
            for fid in want.get(d, ()):
                if fid in feats:
                    continue
                x = lines[fid]
                h_, a_ = nk(x["home"]), nk(x["away"])
                if {h_, a_} == {a, b}:
                    sfc = surface(m.get("event") or x.get("season_type"))
                    feats[fid] = (m, state(h_, d, sfc, a_), state(a_, d, sfc, h_), sfc)
        for m in by_day[d]:
            a, b = nk(m["w"]), nk(m["l"])
            sfc = surface(m.get("event"))
            E.update(a, b, m.get("event"))
            ES[sfc].update(a, b)
            hist[a].append((d, 1, m.get("games_w") or 0, m.get("games_l") or 0))
            hist[b].append((d, 0, m.get("games_l") or 0, m.get("games_w") or 0))
            for p in (a, b):
                while len(hist[p]) > 60:
                    hist[p].popleft()
    print(f"{len(feats)} Onyx lines matched to a result")
    DATA = {"ml": [], "total": [], "spread": []}
    for fid, (m, H, A, sfc) in feats.items():
        x = lines[fid]
        if H["n"] < 10 or A["n"] < 10:
            continue
        home_won = nk(m["w"]) == nk(x["home"])
        gw, gl = m.get("games_w") or 0, m.get("games_l") or 0
        gh, ga_ = (gw, gl) if home_won else (gl, gw)
        slam = 1.0 if TM._is_slam(m.get("event") or x.get("season_type")) and x["tour"] == "ATP" else 0.0
        elo_p = 1 / (1 + 10 ** ((A["elo"] - H["elo"]) / 400))
        f = {"elo_p": elo_p, "elo_diff": H["elo"] - A["elo"], "selo_diff": H["selo"] - A["selo"],
             "selo_p": 1 / (1 + 10 ** ((A["selo"] - H["selo"]) / 400)), "sn_min": float(min(H["sn"], A["sn"])),
             "f45_diff": H["f45"] - A["f45"], "n14_diff": float(H["n14"] - A["n14"]), "n45_diff": float(H["n45"] - A["n45"]),
             "gshare_diff": H["gshare"] - A["gshare"], "gpm_sum": H["gpm"] + A["gpm"], "rest_diff": float(min(H["rest"], 30) - min(A["rest"], 30)),
             "n_min": float(min(H["n"], A["n"])), "slam": slam, "wta": 1.0 if x["tour"] == "WTA" else 0.0,
             "clay": 1.0 if sfc == "clay" else 0.0, "grass": 1.0 if sfc == "grass" else 0.0}
        g = x.get("game") or {}
        season = 2025 if m["date"] < SPLIT else 2026
        ml = g.get("moneyline") or {}
        mh, ma = (ml.get(x["home"]) or {}), (ml.get(x["away"]) or {})
        if mh.get("o") and ma.get("o") and mh["o"][1] is not None and ma["o"][1] is not None:
            ph, pa = L.implied(mh["o"][1]), L.implied(ma["o"][1])
            if 1.0 <= ph + pa <= 1.12:
                c1, c2 = (mh.get("c") or [None, None])[1], (ma.get("c") or [None, None])[1]
                DATA["ml"].append({"season": season, "date": m["date"], "p": ph / (ph + pa), "po": mh["o"][1], "pu": ma["o"][1],
                                   "line_": 0, "cl": 0 if c1 is not None and c2 is not None else None, "co": c1, "cu": c2,
                                   "y": int(home_won), "f": dict(f, mkt_p=ph / (ph + pa))})
        tt = g.get("total_games") or {}
        if tt.get("over") and tt["over"]["o"][0] is not None and tt.get("under") and tt["under"]["o"][1] is not None:
            ln, po, pu = tt["over"]["o"][0], tt["over"]["o"][1], tt["under"]["o"][1]
            io, iu = L.implied(po), L.implied(pu)
            if 1.0 <= io + iu <= 1.15 and gw + gl != ln and (gw + gl) > 0:
                c = tt["over"].get("c") or [None, None]
                cu = (tt["under"].get("c") or [None, None])[1]
                DATA["total"].append({"season": season, "date": m["date"], "p": io / (io + iu), "po": po, "pu": pu, "line_": ln,
                                      "cl": c[0], "co": c[1], "cu": cu, "y": int(gw + gl > ln),
                                      "f": dict(f, line=ln, mkt_fav=abs(L.implied((mh.get("o") or [0, -110])[1] or -110) - 0.5))})
        sp = g.get("game_spread") or {}
        if x["home"] in sp and x["away"] in sp and sp[x["home"]]["o"][0] is not None:
            ln, po, pu = sp[x["home"]]["o"][0], sp[x["home"]]["o"][1], sp[x["away"]]["o"][1]
            if po is not None and pu is not None and (gw + gl) > 0:
                io, iu = L.implied(po), L.implied(pu)
                marg = gh - ga_ + ln
                if 1.0 <= io + iu <= 1.15 and marg != 0:
                    c = sp[x["home"]].get("c") or [None, None]
                    cu = (sp[x["away"]].get("c") or [None, None])[1]
                    DATA["spread"].append({"season": season, "date": m["date"], "p": io / (io + iu), "po": po, "pu": pu, "line_": ln,
                                           "cl": c[0], "co": c[1], "cu": cu, "y": int(marg > 0), "f": dict(f, line=ln)})
    for k in list(DATA):
        if only and k not in only:
            DATA.pop(k)
            continue
        print(f"{k}: {sum(1 for s in DATA[k] if s['season'] == 2025)} before {SPLIT}, {sum(1 for s in DATA[k] if s['season'] == 2026)} after")
    if "--select" not in sys.argv:
        S.screen(DATA, "bt/tennis_screen.json")
    S.select_and_test(DATA, out="bt/tennis_select.json")


if __name__ == "__main__":
    main()
