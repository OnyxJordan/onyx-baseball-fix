#!/usr/bin/env python3
"""
cbb_model_backtest.py - judges the college basketball game model (cbb_model.py), dev only.

Replays the 2025-26 season week by week: every Division I vs Division I game (both teams carry a
Torvik prior) is predicted from games before its week only (ratings as of that Monday), with the
preseason prior from 2024-25. Parameters are chosen on 11/1-12/31/2025 and judged on
1/1-4/9/2026, which the choice never saw. v1 (additive points, no pace) and v2 (possessions x
efficiency) are run side by side, then both are graded against the closing spread and total in
data/cbb/history/games_2026.json: the line's own error is the bar, and the model's side of the
line is graded wherever it disagrees with the closing number by a set margin.

  python3 tools/cbb_model_backtest.py [--grid] [--json out.json]
"""
import json, math, os, sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import cbb_model as M      # noqa: E402
import team_model as T     # noqa: E402
from sports_lab import ncdf  # noqa: E402

LANE = os.path.join(ROOT, "data", "cbb")
TUNE, TEST = ("2025-11-01", "2025-12-31"), ("2026-01-01", "2026-04-09")


def load():
    names = json.load(open(os.path.join(LANE, "teams_espn.json")))
    G = [g for g in json.load(open(os.path.join(LANE, "results.json")))["games"] if g.get("season") == 2026]
    pr = M.prior_torvik(LANE, 2026, names)
    D = [g for g in G if g["home"] in pr[0] and g["away"] in pr[0]]
    close = {g["id"]: g for g in json.load(open(os.path.join(LANE, "history", "games_2026.json")))}
    return names, G, D, close


def monday(d):
    x = date.fromisoformat(d)
    return str(x - timedelta(days=x.weekday()))


def replay(version, G, D, names, lo, hi, Q=None):
    """[(game, expected home, expected away)] for games in [lo, hi]"""
    out = []
    if True:
        for wk in sorted({monday(g["date"]) for g in D}):
            gs = [g for g in D if monday(g["date"]) == wk and lo <= g["date"] <= hi]
            if not gs:
                continue
            if version == "v2" and Q:     # the grid: pace ratings alone, both sides
                R = M.fit_pace([g for g in G if g.get("season") == 2026], wk, M.prior_pace(LANE, 2026, names), Q)
            else:
                R = M.ratings(LANE, G, wk, names, pace=version != "v1")
            for g in gs:
                eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
                out.append((g, eh, ea))
    return out


def score(P):
    ll, mm, mt, rt = [], [], [], []
    for g, eh, ea in P:
        p = min(max(1 - ncdf(-(eh - ea) / M.P["sd_margin"]), 1e-6), 1 - 1e-6)
        ll.append(-math.log(p if g["hs"] > g["as"] else 1 - p))
        mm.append(abs(eh - ea - (g["hs"] - g["as"])))
        mt.append(abs(eh + ea - g["hs"] - g["as"]))
        rt.append(g["hs"] + g["as"] - eh - ea)
    n = len(P)
    mean_r = sum(rt) / n
    return {"n": n, "logloss": round(sum(ll) / n, 4), "margin_mae": round(sum(mm) / n, 3), "total_mae": round(sum(mt) / n, 3),
            "total_bias": round(mean_r, 2), "total_sd": round((sum((r - mean_r) ** 2 for r in rt) / n) ** 0.5, 2)}


def vs_close(P, close):
    """the model against the closing line, on games that have one"""
    S = {"games": 0, "close_total_mae": [], "model_total_mae": [], "close_margin_mae": [], "model_margin_mae": []}
    ats = {t: [0, 0, 0] for t in (0, 1, 2, 3, 4, 6)}
    ou = {t: [0, 0, 0] for t in (0, 2, 4, 6, 8)}
    for g, eh, ea in P:
        c = close.get(g["id"])
        if not c:
            continue
        m, tot = g["hs"] - g["as"], g["hs"] + g["as"]
        if c.get("sp") is not None:
            S["close_margin_mae"].append(abs(m + c["sp"])); S["model_margin_mae"].append(abs(eh - ea - m))
            gap = (eh - ea) + c["sp"]          # > 0: the model likes the home side against the number
            res = m + c["sp"]
            for t, rec in ats.items():
                if abs(gap) >= max(t, 0.5) and gap != 0:
                    rec[0 if res * gap > 0 else 1 if res * gap < 0 else 2] += 1
        if c.get("tot") is not None:
            S["games"] += 1
            S["close_total_mae"].append(abs(tot - c["tot"])); S["model_total_mae"].append(abs(eh + ea - tot))
            gap, res = eh + ea - c["tot"], tot - c["tot"]
            for t, rec in ou.items():
                if abs(gap) >= max(t, 0.5):
                    rec[0 if res * gap > 0 else 1 if res * gap < 0 else 2] += 1
    f = lambda v: round(sum(v) / len(v), 3) if v else None
    pct = lambda r: round(100 * r[0] / (r[0] + r[1]), 1) if r[0] + r[1] else None
    return {"games_with_total": S["games"], "close_total_mae": f(S["close_total_mae"]), "model_total_mae": f(S["model_total_mae"]),
            "games_with_spread": len(S["close_margin_mae"]), "close_margin_mae": f(S["close_margin_mae"]), "model_margin_mae": f(S["model_margin_mae"]),
            "ats": {f"gap>={t}": {"w": r[0], "l": r[1], "p": r[2], "pct": pct(r)} for t, r in ats.items()},
            "ou": {f"gap>={t}": {"w": r[0], "l": r[1], "p": r[2], "pct": pct(r)} for t, r in ou.items()}}


if __name__ == "__main__":
    names, G, D, close = load()
    if "--grid" in sys.argv:
        base_keep = M.PACE_KEEP
        for kp in (0.0, 0.35, 0.5, 0.65, 0.8):
            for rp in (3, 6, 15, 30, 60):
                M.PACE_KEEP = kp
                s = score(replay("v2", G, D, names, *TUNE, Q={"ridge_pace": rp}))
                print(f"tune  pace keep {kp:.2f} ridge {rp:>2}: log loss {s['logloss']:.4f} margin {s['margin_mae']:.3f} total {s['total_mae']:.3f}", flush=True)
        M.PACE_KEEP = base_keep
    rep = {}
    for v in ("v1", "v2"):
        for nm, win in (("tune", TUNE), ("test", TEST)):
            P = replay(v, G, D, names, *win)
            rep[f"{v}_{nm}"] = dict(score(P), **({"close": vs_close(P, close)} if nm == "test" else {}))
    for k, s in rep.items():
        print(k, json.dumps({x: y for x, y in s.items() if x != "close"}))
    for v in ("v1", "v2"):
        c = rep[f"{v}_test"]["close"]
        print(f"\n{v} vs the closing line, 1/1-4/9/2026")
        print(f"  totals: model MAE {c['model_total_mae']} vs closing total {c['close_total_mae']} ({c['games_with_total']} games)")
        print(f"  margins: model MAE {c['model_margin_mae']} vs closing spread {c['close_margin_mae']} ({c['games_with_spread']} games)")
        for k, r in c["ats"].items():
            print(f"  ATS  model vs line {k:>7}: {r['w']}-{r['l']}-{r['p']}  {r['pct']}%")
        for k, r in c["ou"].items():
            print(f"  O/U  model vs line {k:>7}: {r['w']}-{r['l']}-{r['p']}  {r['pct']}%")
    if "--json" in sys.argv:
        json.dump(rep, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
