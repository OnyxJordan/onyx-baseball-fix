#!/usr/bin/env python3
"""
cbb_stats_backtest.py - fits and tests the college stat projection (cbb_stats.py), dev only.

For a season Y, every player with 5+ games on a Y roster is projected from season Y-1 (or Y-2)
only: minutes from cbb_minutes (its weights fitted on the three seasons before Y), production per
40 minutes from cbb_stats.feats (last season's rates, class, the rest of the roster's proven usage,
a transfer's level change and tempo change, and for newcomers the recruit rating). Graded per
game on points, rebounds, assists, made threes, steals and blocks against what happened, beside
the naive guess "last season's per-game line" (newcomers get the average newcomer's line).

Stat weights fit on 2022-2025, test on 2026 (held out); also 2021-2024 -> 2025.
  python3 tools/cbb_stats_backtest.py <torvik csv cache dir> [--write-box] [--write]
--write-box writes data/cbb/history/box_{2021..2027}.json (per-game lines incl. threes, steals,
blocks) from the raw Torvik CSVs; --write stores the fitted weights and the 2026 test in cbb_stats.py.
"""
import csv, json, os, re, sys
from collections import defaultdict
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import cbb_minutes as M          # noqa: E402
import cbb_stats as S            # noqa: E402
import cbb_minutes_backtest as MB  # noqa: E402  (reads the cache dir from argv[1])

CACHE = sys.argv[1]
BOX_COLS = ["pid", "gp", "mpg", "pts", "reb", "ast", "3pm", "stl", "blk"]


def box_from_csv(season):
    out = []
    p = os.path.join(CACHE, f"torvik_pl_{season}.csv")
    if not os.path.exists(p):
        return out
    for r in csv.reader(open(p, encoding="utf-8", errors="replace")):
        if len(r) < 64:
            continue
        try:
            gp = int(float(r[3] or 0))
            f = lambda i: round(float(r[i]), 2) if r[i] not in ("", "NA") else 0.0
            out.append([int(r[32]), gp, f(54), f(63), f(59), f(60), round(float(r[19] or 0) / gp, 2) if gp else 0.0, f(61), f(62)])
        except ValueError:
            pass
    return out


def write_box(seasons):
    for y in seasons:
        rows = box_from_csv(y)
        if rows:
            json.dump({"cols": BOX_COLS, "rows": rows}, open(os.path.join(M.HIST, f"box_{y}.json"), "w"), separators=(",", ":"))
            print(f"box_{y}.json: {len(rows)} players")


_cache = {}


def rows(Y):
    """per player of season Y: minutes features, stat features by stat, actual line, naive line"""
    if Y in _cache:
        return _cache[Y]
    mrows = {pid: (gf, a, nv) for gf, a, t, pid, nv in MB.rows(Y)}
    cur = {r["pid"]: r for r in M.load_players(Y)}
    prev = {r["pid"]: r for r in M.load_players(Y - 1)}
    prev2 = {r["pid"]: r for r in M.load_players(Y - 2)}
    bx, bp, bp2 = S.load_box(Y), S.load_box(Y - 1), S.load_box(Y - 2)
    em, tempo = M.team_em(Y - 1), S.team_tempo(Y - 1)
    R = MB.rec(Y)
    P = {pid: (prev.get(pid) and (prev[pid], bp.get(pid))) or (prev2.get(pid) and (prev2[pid], bp2.get(pid))) or None for pid in mrows}
    proven = defaultdict(float)
    for pid in mrows:
        if P[pid] and pid in cur:
            proven[cur[pid]["t"]] += (P[pid][0].get("usg") or 0) * (P[pid][0].get("mpg") or 0) / 40.0
    out = []
    for pid, (gf, a_mpg, nv) in mrows.items():
        if pid not in cur or pid not in bx:
            continue
        r, act = cur[pid], bx[pid]
        pr, pb = P[pid] if P[pid] else (None, None)
        g = gf[0] if pb else "newcomer"
        own = ((pr or {}).get("usg") or 0) * ((pr or {}).get("mpg") or 0) / 40.0
        comp = (proven[r["t"]] - (own if pr else 0)) / 100.0
        t_new, t_old = r["t"], (pr or {}).get("t")
        lvl = ((em.get(t_new) or 0) - (em.get(t_old) or 0)) / 10.0 if g == "transfer" and em.get(t_new) is not None and em.get(t_old) is not None else 0.0
        tr = tempo[t_new] / tempo[t_old] if g == "transfer" and tempo.get(t_new) and tempo.get(t_old) else 1.0
        F = {s: S.feats(s, g, pr, pb or {}, R.get(pid), MB.ht(r.get("ht")), lvl, em.get(t_new), comp, tr) for s in S.STATS}
        naive = {s: (pb or {}).get(s) for s in S.STATS} if pb else None
        out.append({"pid": pid, "t": t_new, "mgf": gf, "g": g, "F": F, "act": act, "naive": naive, "naive_mpg": nv})
    _cache[Y] = out
    return out


def fit(seasons, ridge=2.0):
    W = {}
    for s in S.STATS:
        X, y, w = defaultdict(list), defaultdict(list), defaultdict(list)
        for Y in seasons:
            for x in rows(Y):
                m = x["act"].get("mpg") or 0
                if m < 3:
                    continue
                X[x["g"]].append(x["F"][s]); y[x["g"]].append((x["act"].get(s) or 0) * 40.0 / m); w[x["g"]].append(m * (x["act"].get("gp") or 0))
        W[s] = {}
        for g in X:
            A, b, sw = np.array(X[g]), np.array(y[g]), np.sqrt(np.array(w[g]) / np.mean(w[g]))
            A2, b2 = A * sw[:, None], b * sw
            I = np.eye(A.shape[1]); I[0, 0] = 0
            W[s][g] = [float(v) for v in np.linalg.solve(A2.T @ A2 + ridge * I, A2.T @ b2)]
    return W


def grade(Y, W, Wmin):
    R = rows(Y)
    newb = {s: float(np.mean([x["act"].get(s) or 0 for x in R if x["naive"] is None])) for s in S.STATS}
    newb_m = float(np.mean([x["act"]["mpg"] for x in R if x["naive"] is None]))
    err = defaultdict(list)
    for x in R:
        mp = min(M.CAP, M.raw(x["mgf"], Wmin))
        a_m = x["act"]["mpg"]
        nv_m = x["naive_mpg"] if x["naive_mpg"] is not None else newb_m
        for grp in ("all", x["g"]):
            err[(grp, "min", "model")].append(abs(mp - a_m)); err[(grp, "min", "naive")].append(abs(nv_m - a_m))
        for s in S.STATS:
            rt = S.rate(s, x["g"], x["F"][s], W)
            pred = mp * rt / 40.0
            nv = (x["naive"] or {}).get(s)
            nv = newb[s] if nv is None else nv
            a = x["act"].get(s) or 0
            # the rate model on its own: real minutes x projected rate, against real minutes x last season's rate
            r_old = x["F"][s][1] if x["g"] != "newcomer" else newb[s] * 40.0 / max(newb_m, 1)
            for grp in ("all", x["g"]):
                err[(grp, s, "model")].append(abs(pred - a)); err[(grp, s, "naive")].append(abs(nv - a))
                err[(grp, s, "rate_model")].append(abs(a_m * rt / 40.0 - a)); err[(grp, s, "rate_naive")].append(abs(a_m * r_old / 40.0 - a))
    out = defaultdict(dict)
    for (grp, s, k), v in err.items():
        out[grp].setdefault(s, {})[k] = round(float(np.mean(v)), 3)
        out[grp].setdefault("n", len(v))
    return out


def show(title, G):
    print(f"\n{title}")
    print(f"  {'group':<10}{'stat':<6}{'n':>6}{'model':>8}{'naive':>8}{'gain':>7}   rate only: {'model':>6}{'naive':>7}")
    for grp in ("all", "returning", "transfer", "newcomer"):
        for s in ["min"] + S.STATS:
            r = G[grp].get(s)
            if not r:
                continue
            gain = 100 * (1 - r["model"] / r["naive"]) if r["naive"] else 0
            extra = f"   {r['rate_model']:>17.3f}{r['rate_naive']:>7.3f}" if "rate_model" in r else ""
            print(f"  {grp:<10}{s:<6}{G[grp]['n']:>6}{r['model']:>8.3f}{r['naive']:>8.3f}{gain:>6.1f}%{extra}")


if __name__ == "__main__":
    if "--write-box" in sys.argv:
        write_box(range(2019, 2028))
    res = {}
    for train, test in (([2021, 2022, 2023, 2024], 2025), ([2022, 2023, 2024, 2025], 2026)):
        W = fit(train)
        Wmin = MB.fit([test - 3, test - 2, test - 1])
        res[test] = grade(test, W, Wmin)
        show(f"stat weights fit on {train}, minutes on {[test - 3, test - 2, test - 1]} -> test {test} (held out)", res[test])
    if "--write" in sys.argv:
        W = fit([2022, 2023, 2024, 2025, 2026])
        g = res[2026]
        bt = {"season": "2025-26", "n": g["all"]["n"], "minutes_mae": round(g["all"]["min"]["model"], 2), "minutes_naive": round(g["all"]["min"]["naive"], 2),
              "stats": {s: {"model": round(g["all"][s]["model"], 2), "naive": round(g["all"][s]["naive"], 2)} for s in S.STATS},
              "groups": {grp: {"n": g[grp]["n"], **{s: {"model": round(g[grp][s]["model"], 2), "naive": round(g[grp][s]["naive"], 2)} for s in ["min"] + S.STATS}}
                         for grp in ("returning", "transfer", "newcomer")}}
        p = os.path.join(ROOT, "cbb_stats.py")
        src = open(p).read()
        src = re.sub(r"^FIT = .*$", "FIT = " + json.dumps({s: {gr: [round(v, 4) for v in ws] for gr, ws in d.items()} for s, d in W.items()}), src, count=1, flags=re.M)
        src = re.sub(r"^BACKTEST = .*$", "BACKTEST = " + json.dumps(bt), src, count=1, flags=re.M)
        open(p, "w").write(src)
        print("\nwrote FIT and BACKTEST to cbb_stats.py (final weights fit on 2022-2026)")
