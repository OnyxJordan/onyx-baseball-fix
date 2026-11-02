#!/usr/bin/env python3
"""
cbb_minutes_backtest.py - fits and tests the college minutes projection (cbb_minutes.py), dev only.

For a season Y, every player on a Y roster (Torvik's player file for Y says who played where) is
projected from season Y-1 only: his own last season (any team), his class, the transfer's level
change (Y-1 adjusted efficiency margins), and for newcomers without a college season his recruit
rating (Torvik's 0-100, read from the raw Torvik CSVs). Raw projections are scaled per team to the
minutes a roster plays. Graded on minutes per game against what happened, for players with 5+
games, against two naive guesses: "the same minutes as last season" (newcomers get the average
newcomer) and the same scaled per team.

Fits on 2023-2025, tests on 2026 (held out), and also reports 2025 fitted on 2022-2024.
  python3 tools/cbb_minutes_backtest.py <torvik csv cache dir> [--write]
--write stores the fitted weights in cbb_minutes.py (FIT).
"""
import csv, json, os, re, sys
from collections import defaultdict
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cbb_minutes as M   # noqa: E402

CACHE = sys.argv[1]
REC = {}
def rec(season):
    if season in REC:
        return REC[season]
    out = {}
    p = os.path.join(CACHE, f"torvik_pl_{season}.csv")
    if os.path.exists(p):
        for r in csv.reader(open(p, encoding="utf-8", errors="replace")):
            if len(r) > 34:
                try:
                    out[int(r[32])] = float(r[34]) if r[34] not in ("", "NA") else 0.0
                except ValueError:
                    pass
    REC[season] = out
    return out


def ht(s):
    m = re.match(r"(\d+)-(\d+)", str(s or ""))
    return int(m.group(1)) * 12 + int(m.group(2)) if m else 78


def rows(Y):
    """(group-features, actual mpg, team, pid, naive mpg) for season Y from Y-1"""
    cur, prev = M.load_players(Y), {r["pid"]: r for r in M.load_players(Y - 1)}
    prev2 = {r["pid"]: r for r in M.load_players(Y - 2)}
    em = M.team_em(Y - 1)
    R = rec(Y)
    keep = [r for r in cur if (r.get("gp") or 0) >= 5 and r.get("mpg") is not None]
    P = {r["pid"]: prev.get(r["pid"]) or prev2.get(r["pid"]) for r in keep}
    proven = defaultdict(float)
    for r in keep:
        if P[r["pid"]]:
            proven[r["t"]] += P[r["pid"]].get("mpg") or 0
    out = []
    for r in keep:
        p = P[r["pid"]]
        tr = bool(p) and p["t"] != r["t"]
        crowd = (proven[r["t"]] - ((p.get("mpg") or 0) if p else 0)) / 100.0
        gf = M.feats(p, r.get("cls"), R.get(r["pid"]), ht(r.get("ht")), em.get(r["t"]), em.get(p["t"]) if p else None, tr, crowd)
        out.append((gf, float(r["mpg"]), r["t"], r["pid"], float(p["mpg"]) if p and p.get("mpg") is not None else None))
    return out


def fit(seasons, ridge=1.0):
    X, y = defaultdict(list), defaultdict(list)
    for Y in seasons:
        for (g, f), a, *_ in rows(Y):
            X[g].append(f); y[g].append(a)
    W = {}
    for g in X:
        A, b = np.array(X[g]), np.array(y[g])
        I = np.eye(A.shape[1]); I[0, 0] = 0
        W[g] = [float(v) for v in np.linalg.solve(A.T @ A + ridge * I, A.T @ b)]
    return W


def grade(Y, W):
    R = rows(Y)
    newbie = np.mean([a for gf, a, t, pid, nv in R if nv is None]) if R else 8.0
    by = defaultdict(dict)
    for gf, a, t, pid, nv in R:
        by[t][pid] = (M.raw(gf, W), a, nv if nv is not None else newbie, gf[0])
    err = defaultdict(list)
    for t, P in by.items():
        sm = M.scale_team({k: v[0] for k, v in P.items()})
        for k, (m, a, nv, g) in P.items():
            err["model"].append(abs(m - a)); err["model_scaled"].append(abs(sm[k] - a)); err["naive"].append(abs(nv - a))
            err[g + "_model"].append(abs(m - a)); err[g + "_naive"].append(abs(nv - a))
            err["w4"].append(abs(m - a) <= 4); err["w4n"].append(abs(nv - a) <= 4)
    res = {k: round(float(np.mean(v)) * (100 if k in ("w4", "w4n") else 1), 2) for k, v in err.items()}
    res["n"] = len(R)
    return res


if __name__ == "__main__":
    for train, test in (([2022, 2023, 2024], 2025), ([2023, 2024, 2025], 2026)):
        w = fit(train)
        print(f"fit {train} -> test {test}:", json.dumps(grade(test, w)))
    w = fit([2023, 2024, 2025, 2026])
    print("weights (all seasons):", {g: [round(v, 2) for v in ws] for g, ws in w.items()})
    if "--write" in sys.argv:
        p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cbb_minutes.py")
        s = open(p).read()
        s = re.sub(r"^FIT = .*$", "FIT = " + json.dumps({g: [round(v, 4) for v in ws] for g, ws in w.items()}), s, count=1, flags=re.M)
        open(p, "w").write(s)
        print("wrote FIT to cbb_minutes.py")
