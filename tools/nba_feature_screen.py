#!/usr/bin/env python3
"""
nba_feature_screen.py - which statistics predict NBA points, rebounds and assists beyond
Onyx's own price? The NFL v11 method (tools/nfl_feature_screen.py) on the NBA backtest
files (tools/nba_backtest_pull.py: bt/nba/box.json, games.json, lines.json). Dev only.

Statistics known before tip: the player's recent and season averages, minutes and their
trend, usage (shots + free throws + turnovers per minute), per-36 rates, starter share,
the team's pace and the opponent's allowed rate for the stat, Onyx's game total and
spread, home, rest and back-to-backs. Chosen on Onyx lines before 2/1/2026 (labelled 2025),
judged after (labelled 2026).

    python3 tools/nba_feature_screen.py [--select] [pts|reb|ast]
"""
import json, os, sys
from collections import defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                  # noqa: E402
import nfl_feature_screen as S          # noqa: E402
import nba_market as NM                 # noqa: E402

SPLIT = "2026-02-01"
COLS = ("fid", "pid", "name", "pos", "team", "starter", "min", "sec", "pts", "reb", "ast", "fg3", "fga", "fta", "oreb", "tov", "pm", "dreb")


def et_day(iso):
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - timedelta(hours=5)).date().isoformat()


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    games = json.load(open("bt/nba/games.json"))
    for g in games.values():
        g["day"] = et_day(g["start"])
    rows = []
    for r in json.load(open("bt/nba/box.json")):
        d = dict(zip(COLS, r))
        g = games.get(d["fid"])
        if not g or not d["sec"]:
            continue
        d["min"] = (d["sec"] or 0) / 60.0
        for k in ("pts", "reb", "ast", "fg3", "fga", "fta", "tov", "oreb", "dreb"):
            d[k] = d[k] or 0
        d["day"] = g["day"]
        d["opp"] = g["away"] if d["team"] == g["home"] else g["home"]
        d["home"] = d["team"] == g["home"]
        rows.append(d)
    rows.sort(key=lambda d: d["day"])
    by_pid = defaultdict(list)
    team_g = defaultdict(lambda: defaultdict(float))   # (fid, team)
    opp_g = defaultdict(lambda: defaultdict(float))    # (fid, defense)
    played = defaultdict(set)
    for d in rows:
        by_pid[d["pid"]].append(d)
        played[d["team"]].add(d["day"])
        for k in ("pts", "reb", "ast", "fga", "fta", "tov", "oreb"):
            team_g[(d["fid"], d["team"])][k] += d[k]
            opp_g[(d["fid"], d["opp"])][k] += d[k]
    tday = {}
    for (fid, t) in team_g:
        tday[(fid, t)] = games[fid]["day"]
    mean = lambda xs: sum(xs) / len(xs) if xs else 0.0

    def tlog(team, day, src, n=15):
        xs = sorted(((tday[(f, t)], v) for (f, t), v in src.items() if t == team and tday[(f, t)] < day), key=lambda x: x[0])[-n:]
        return [v for _, v in xs]
    lg_cache = {}

    def lg(day, k):
        mo = day[:7]
        if (mo, k) not in lg_cache:
            vals = [v[k] for (f, t), v in opp_g.items() if tday[(f, t)] < mo + "-01"]
            lg_cache[(mo, k)] = mean(vals) or 1.0
        return lg_cache[(mo, k)]
    tcache = {}

    def tl(team, day, src_key):
        key = (team, day, src_key)
        if key not in tcache:
            tcache[key] = tlog(team, day, team_g if src_key == "t" else opp_g)
        return tcache[key]

    lines = json.load(open("bt/nba/lines.json"))
    box_at = {(d["fid"], d["name"]): d for d in rows}
    DATA = {"pts": [], "reb": [], "ast": []}
    for fid, x in lines.items():
        g = games.get(fid)
        if not g or x.get("total") is None:
            continue
        tot = x["total"][0] if isinstance(x["total"], list) else x["total"]          # [open, close]
        sh = x["spread_home"][0] if isinstance(x.get("spread_home"), list) else x.get("spread_home")
        if tot is None or sh is None:
            continue
        for nm, mk in (x.get("props") or {}).items():
            b = box_at.get((fid, nm))
            if b is None:
                continue                   # did not play: void
            h = [r for r in by_pid[b["pid"]] if r["day"] < b["day"]]
            if len(h) < 5:
                continue
            l5, l10 = h[-5:], h[-10:]
            cur = [r for r in h if r["day"] >= ("2025-10-01" if b["day"] < "2026-08-01" else "2026-10-01")] or l10
            team, opp = b["team"], b["opp"]
            tb, ob = tl(team, b["day"], "t"), tl(opp, b["day"], "o")
            rest = (datetime.fromisoformat(b["day"]) - datetime.fromisoformat(h[-1]["day"])).days
            prev = (datetime.fromisoformat(b["day"]) - timedelta(days=1)).date().isoformat()
            m10 = sum(r["min"] for r in l10) or 1.0
            imp = (tot - sh) / 2 if b["home"] else (tot + sh) / 2
            for stat, v in mk.items():
                if stat not in DATA or not v.get("o") or None in v["o"]:
                    continue
                ln, po, pu = v["o"]
                io, iu = L.implied(po), L.implied(pu)
                if not (1.0 <= io + iu <= 1.15):
                    continue
                act = b[stat]
                if act == ln:
                    continue
                sd10 = (sum((r[stat] - mean([q[stat] for q in l10])) ** 2 for r in l10) / 9) ** 0.5
                f = {"l5": mean([r[stat] for r in l5]), "l10": mean([r[stat] for r in l10]), "season": mean([r[stat] for r in cur]),
                     "line_vs_l5": ln - mean([r[stat] for r in l5]), "line_vs_l10": ln - mean([r[stat] for r in l10]),
                     "line_vs_season": ln - mean([r[stat] for r in cur]),
                     "line_z": (ln - mean([r[stat] for r in l10])) / sd10 if sd10 else 0.0, "sd10": sd10,
                     "min_l5": mean([r["min"] for r in l5]), "min_season": mean([r["min"] for r in cur]),
                     "min_trend": mean([r["min"] for r in l5]) - mean([r["min"] for r in cur]),
                     "per36": 36 * sum(r[stat] for r in l10) / m10,
                     "usage": sum(r["fga"] + 0.44 * r["fta"] + r["tov"] for r in l10) / m10,
                     "fg3_rate": sum(r["fg3"] for r in l10) / m10, "oreb_share": sum(r["oreb"] for r in l10) / max(1.0, sum(r["reb"] for r in l10)),
                     "starter": mean([1.0 if r["starter"] else 0.0 for r in l10]), "pm_l10": mean([r["pm"] or 0 for r in l10]),
                     "team_pace": mean([t["fga"] + 0.44 * t["fta"] + t["tov"] - t["oreb"] for t in tb]),
                     "team_stat": mean([t[stat] for t in tb]),
                     "opp_allowed": mean([o[stat] for o in ob]) / lg(b["day"], stat) if ob else 1.0,
                     "opp_pace": mean([o["fga"] + 0.44 * o["fta"] + o["tov"] - o["oreb"] for o in ob]) / max(1.0, lg(b["day"], "fga")) if ob else 1.0,
                     "total": tot, "spread": sh if b["home"] else -sh, "implied": imp, "home": 1.0 if b["home"] else 0.0,
                     "rest": float(min(rest, 5)), "b2b": 1.0 if prev in played[team] else 0.0,
                     "opp_b2b": 1.0 if prev in played[opp] else 0.0, "games": float(len(cur)), "line": ln}
                if stat == "ast":     # the live lane's definitions (nba_market.py), so the test is what runs
                    fm = NM.features([r["ast"] for r in h], [o["ast"] for o in ob], lg(b["day"], "ast"), ln)
                    f.update(opp_allowed=fm["opp_allowed"], line_z=fm["line_z"])
                c = v.get("c") or [None, None, None]
                DATA[stat].append({"season": 2025 if b["day"] < SPLIT else 2026, "date": b["day"], "p": io / (io + iu), "po": po, "pu": pu,
                                   "line_": ln, "cl": c[0], "co": c[1], "cu": c[2], "line": ln, "y": int(act > ln), "f": f})
    for k in list(DATA):
        if only and k not in only:
            DATA.pop(k)
            continue
        print(f"{k}: {sum(1 for s in DATA[k] if s['season'] == 2025)} before {SPLIT}, {sum(1 for s in DATA[k] if s['season'] == 2026)} after", flush=True)
    if "--select" not in sys.argv:
        S.screen(DATA, "bt/nba_screen.json")
    S.select_and_test(DATA, out="bt/nba_select.json")


if __name__ == "__main__":
    main()
