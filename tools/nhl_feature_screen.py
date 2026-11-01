#!/usr/bin/env python3
"""
nhl_feature_screen.py - which statistics predict NHL player points and assists beyond
Onyx's own price? Dev only (bt/ files). Same method as tools/nfl_feature_screen.py:

    P(over) = sigmoid(a + b logit(Onyx no-vig) + sum c z(stat))

Statistics come from NHL API boxscores (tools/nhl_box_pull.py: ice time, shots, power-play
goals, shifts, position) and Onyx's game lines. Chosen on Onyx lines before 2/1/2026
(labelled 2025 in the output), judged on everything after (labelled 2026).

    python3 tools/nhl_feature_screen.py [--select] [points|assists|...]
"""
import json, math, os, re, sys, unicodedata
from collections import defaultdict
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                  # noqa: E402
import nfl_feature_screen as S          # noqa: E402  (fit, ll, screen, select_and_test)

SPLIT = "2026-02-01"
MARKETS = {"points": ("player_points", "pts"), "assists": ("player_assists", "a"), "goals": ("player_goals", "g"),
           "shots": ("player_shots_on_goal", "sog"), "saves": ("player_total_saves", "sv")}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", s)


def short(full):
    """'Brad Marchand' -> 'bmarchand' (the API box name is 'B. Marchand')."""
    parts = (full or "").replace(".", " ").split()
    return nk(parts[0][:1] + "".join(parts[1:])) if len(parts) > 1 else nk(full)


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    box = json.load(open("bt/nhl_api_box.json"))
    games = sorted(box.values(), key=lambda g: (g["date"], g["id"]))
    names = {}
    for x in json.load(open("bt/nhl_box.json")):
        names[x["home_name"]] = x["home"]
        names[x["away_name"]] = x["away"]
    # player-game history, team and opponent game logs
    hist = defaultdict(list)       # (team, short) -> [rows]
    tlog = defaultdict(list)       # team -> [{gf, ga, sf, sa, date}]
    glog = defaultdict(list)       # team -> [goalie sv%, by game]
    by_game = {}
    for g in games:
        if g.get("hs") is None:
            continue
        for side, team, opp, gf, ga, sf, sa in (("h", g["home"], g["away"], g["hs"], g["as"], g["hsog"], g["asog"]),
                                                 ("a", g["away"], g["home"], g["as"], g["hs"], g["asog"], g["hsog"])):
            tlog[team].append({"date": g["date"], "gf": gf, "ga": ga, "sf": sf or 0, "sa": sa or 0, "id": g["id"]})
        for p in g["p"]:
            team = g["home"] if p["h"] else g["away"]
            k = (team, nk(p["n"]))
            if p["pos"] == "G":
                if p.get("toi", 0) > 30:
                    hist[k].append(dict(p, date=g["date"], gid=g["id"], team=team))
                continue
            hist[k].append(dict(p, date=g["date"], gid=g["id"], team=team))
        by_game[(g["date"], g["home"], g["away"])] = g
    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0

    def team_before(team, d, n=10):
        return [t for t in tlog[team] if t["date"] < d][-n:]

    def feats(k, d, line, stat, env):
        h = [r for r in hist[k] if r["date"] < d]
        if len(h) < 5:
            return None
        cur_season = d[:4] if d[5:7] >= "08" else str(int(d[:4]) - 1)
        cur = [r for r in h if (r["date"][:4] if r["date"][5:7] >= "08" else str(int(r["date"][:4]) - 1)) == cur_season]
        l5, l10, l20 = h[-5:], h[-10:], h[-20:]
        v = lambda gs, x: mean([r.get(x, 0) for r in gs])
        per60 = lambda gs, x: 60 * sum(r.get(x, 0) for r in gs) / max(1.0, sum(r["toi"] for r in gs))
        team, opp = env["team"], env["opp"]
        tb, ob = team_before(team, d), team_before(opp, d)
        lgf = mean([t["gf"] for tm in tlog for t in tlog[tm][-10:] if t["date"] < d]) or 3.0
        last = h[-1]["date"]
        rest = (date.fromisoformat(d) - date.fromisoformat(last)).days
        f = {"l5": v(l5, stat), "l10": v(l10, stat), "l20": v(l20, stat), "season": v(cur, stat) if cur else v(l20, stat),
             "rate_hit10": mean([1.0 if r.get(stat, 0) > line else 0.0 for r in l10]),
             "rate_hit20": mean([1.0 if r.get(stat, 0) > line else 0.0 for r in l20]),
             "toi_l5": v(l5, "toi"), "toi_l20": v(l20, "toi"), "toi_trend": v(l5, "toi") - v(l20, "toi"),
             "pts60": per60(l20, "pts"), "a60": per60(l20, "a"), "g60": per60(l20, "g"), "sog60": per60(l20, "sog"),
             "sog_l10": v(l10, "sog"), "shpct": sum(r.get("g", 0) for r in l20) / max(1.0, sum(r.get("sog", 0) for r in l20)),
             "ppg_l20": v(l20, "ppg"), "shifts_l10": v(l10, "sh"), "pm_l10": v(l10, "pm"), "hits_l10": v(l10, "hit"),
             "blk_l10": v(l10, "blk"), "def": 1.0 if h[-1].get("pos") == "D" else 0.0,
             "team_gf10": mean([t["gf"] for t in tb]), "team_sf10": mean([t["sf"] for t in tb]),
             "opp_ga10": mean([t["ga"] for t in ob]), "opp_sa10": mean([t["sa"] for t in ob]),
             "opp_sv10": 1 - sum(t["ga"] for t in ob) / max(1.0, sum(t["sa"] for t in ob)),
             "share_pts": sum(r.get("pts", 0) for r in l10) / max(1.0, sum(t["gf"] for t in tb)),
             "total": env["total"], "win_p": env["win_p"], "home": 1.0 if env["home"] else 0.0,
             "rest": float(min(rest, 7)), "b2b": 1.0 if rest <= 1 else 0.0, "games": float(len(cur)), "line": line,
             "lg_gf": lgf}
        return f

    lines = {}
    for fn in ("bt/nhl_lines.json", "bt/nhl_props.json"):
        for fid, x in json.load(open(fn)).items():
            lines.setdefault(fid, x)
    DATA = {}
    for mkt, (mid, stat) in MARKETS.items():
        if only and mkt not in only:
            continue
        rows = []
        for fid, x in lines.items():
            h_, a_ = names.get(x["home"]), names.get(x["away"])
            st = x.get("start") or ""
            if not h_ or not a_ or x.get("season_type") == "Preseason":
                continue
            # Onyx start is UTC; the NHL game date is local (ET-ish)
            g = None
            for dd in (st[:10], (date.fromisoformat(st[:10]).toordinal() - 1)):
                dd = dd if isinstance(dd, str) else date.fromordinal(dd).isoformat()
                g = by_game.get((dd, h_, a_)) or g
            if not g:
                continue
            gm = x.get("game") or {}
            tt = (gm.get("total_goals") or {}).get("over", {}).get("o") or [None, None]
            ml = gm.get("moneyline") or {}
            mh, ma = (ml.get(x["home"]) or {}).get("o"), (ml.get(x["away"]) or {}).get("o")
            if tt[0] is None or not mh or not ma or mh[1] is None or ma[1] is None:
                continue
            ph, pa = L.implied(mh[1]), L.implied(ma[1])
            wh = ph / (ph + pa)
            pmap = {}
            for p in g["p"]:
                pmap[(g["home"] if p["h"] else g["away"], nk(p["n"]))] = p
            for nm, mk in (x.get("props") or {}).items():
                v = mk.get(mid)
                if not v or None in v["o"]:
                    continue
                ln, po, pu = v["o"]
                io, iu = L.implied(po), L.implied(pu)
                if not (1.0 <= io + iu <= 1.2):
                    continue
                sk = short(nm)
                team = next((t for t in (h_, a_) if (t, sk) in pmap), None)
                if not team:
                    continue          # did not play: void
                act = pmap[(team, sk)].get(stat, 0)
                if act == ln:
                    continue
                home = team == h_
                env = {"team": team, "opp": a_ if home else h_, "total": tt[0], "win_p": wh if home else 1 - wh, "home": home}
                f = feats((team, sk), g["date"], ln, stat, env)
                if f is None:
                    continue
                c = v.get("c") or [None, None, None]
                rows.append({"season": 2025 if g["date"] < SPLIT else 2026, "date": g["date"], "p": io / (io + iu),
                             "po": po, "pu": pu, "line_": ln, "cl": c[0], "co": c[1], "cu": c[2], "line": ln,
                             "y": int(act > ln), "f": f})
        DATA[mkt] = rows
        print(f"{mkt}: {sum(1 for s in rows if s['season'] == 2025)} lines before {SPLIT}, {sum(1 for s in rows if s['season'] == 2026)} after")
    if "--select" not in sys.argv:
        S.screen(DATA, "bt/nhl_screen.json")
    S.select_and_test(DATA, out="bt/nhl_select.json")


if __name__ == "__main__":
    main()
