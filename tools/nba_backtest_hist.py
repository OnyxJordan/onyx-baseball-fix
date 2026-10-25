#!/usr/bin/env python3
"""Dev-only: tune and judge the multi-season history prior (nba_model.H).

Tunes on the whole 2024-25 season (prior = 2021-22..2023-24 seasons, aging
fitted on seasons before 2024-25), then judges on 2025-26, which the tuner
never sees. Reports every player, the first 10 team games (the window the
history matters most), team switchers, players 23 and under, players who
missed last season and players with no NBA history.

  python3 tools/nba_backtest_hist.py BT_DIR [--quick]

BT_DIR holds games.json / box.json (nba_backtest_pull.py), lines.json and
history.json (nba_history_pull.py)."""
import json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import nba_backtest as B
import nba_model as M

bt = sys.argv[1]
G, lines = B.load(bt)
hist = json.load(open(Path(bt) / "history.json"))
SEASONS = {2025: ("2024-10-01", "2025-04-30"), 2026: ("2025-10-01", "2026-04-30")}
GROUPS = {
    "all": None,
    "first 10 team games": lambda r: r["tgp"] < 10,
    "team switchers": lambda r: r["switched"],
    "age 23 and under": lambda r: r["age"] is not None and r["age"] <= 23,
    "missed last season": lambda r: r["missed_last"],
    "no NBA history": lambda r: r["no_prior"],
}
H0, P0 = dict(M.H), dict(M.P)
K0, R0 = M.PRIOR_GAMES_K, M.RATE_PRIOR_MIN


def run(season, mode="hist"):
    lo, hi = SEASONS[season]
    if mode == "v3":
        prior = B.build_prior(G, lines, "2025-08-01")   # one season of Optic box scores (v3)
        B.HIST_CTX.update(team_hist=None, roles=None)
    else:
        prior, th, roles, _, hit, n = B.build_hist_prior(lines, hist, target=season)
        B.HIST_CTX.update(team_hist=th, roles=roles)
    return B.walk(G, lines, lo, hi, prior, {})


def table(recs, title):
    print(f"\n{title}")
    print(f"  {'group':22s} {'n':>6s}  {'pts':>6s} {'reb':>6s} {'ast':>6s} {'min':>6s}   obj")
    out = {}
    for g, f in GROUPS.items():
        r = B.score(recs, min_proj=0, where=f)
        if r["n"] < 30:
            continue
        out[g] = r
        print(f"  {g:22s} {r['n']:6d}  {r['pts']['mae']:6.3f} {r['reb']['mae']:6.3f} {r['ast']['mae']:6.3f} "
              f"{r['min_mae']:6.2f}   {r['obj']:.4f}")
    return out


def obj(recs):
    a = B.score(recs, min_proj=0)["obj"]
    e = B.score(recs, min_proj=0, where=GROUPS["first 10 team games"])["obj"]
    return 0.5 * a + 0.5 * e        # the start of a season counts as much as the rest of it


if __name__ == "__main__":
    t0 = time.time()
    v3 = run(2026, "v3")
    table(v3, "v3 (one season of box scores as the prior), 2025-26")
    M.H.update(w=(1.0, 0.0, 0.0), age_k=0.0, reg_min=1.0, min_reg_gp=0.0, team_carry=0.0)
    one = run(2026)
    table(one, "ESPN last season only, no aging / roles / team carry, 2025-26 (sanity: should match v3)")
    M.H.clear(); M.H.update(H0)
    table(run(2026), "history defaults (5/4/3, aging, roles, team carry), 2025-26")
    print(f"  ({time.time() - t0:.0f}s)")
    if "--quick" in sys.argv:
        sys.exit(0)

    GRID = {
        "w": [(5.0, 4.0, 3.0), (6.0, 3.0, 1.0), (4.0, 3.0, 2.0), (1.0, 0.0, 0.0), (3.0, 2.0, 0.0)],
        "reg_min": [100.0, 250.0, 400.0, 800.0],
        "min_reg_gp": [0.0, 4.0, 8.0, 16.0],
        "age_k": [0.0, 0.5, 1.0, 1.5],
        "team_carry": [0.0, 0.4, 0.6, 0.8],
        "PRIOR_GAMES_K": [2, 4, 6, 10],
        "RATE_PRIOR_MIN": [300.0, 500.0, 800.0, 1200.0],
        "min_recent_w": [0.15, 0.3],
    }

    def setp(k, v):
        if k in M.H:
            M.H[k] = v
        else:
            B.setp(k, v)

    def getp(k):
        return M.H[k] if k in M.H else B.getp(k)

    best = {k: getp(k) for k in GRID}
    for sweep in range(2):
        for k, vals in GRID.items():
            sc = {}
            for v in vals:
                setp(k, v)
                sc[v] = obj(run(2025))
            v_best = min(sc, key=sc.get)
            setp(k, v_best); best[k] = v_best
            print(f"  sweep {sweep + 1} {k:15s} -> {v_best}  (" + ", ".join(f"{v}:{o:.4f}" for v, o in sc.items()) + ")",
                  flush=True)
    print("\nTUNED on 2024-25:", best)
    table(run(2025), "TUNED, 2024-25 (train)")
    test = table(run(2026), "TUNED, 2025-26 (TEST, never seen by the tuner)")
    json.dump({"best": {k: list(v) if isinstance(v, tuple) else v for k, v in best.items()}},
              open(Path(bt) / "hist_tuned.json", "w"), indent=1)
