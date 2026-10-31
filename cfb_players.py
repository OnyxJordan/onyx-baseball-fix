"""
cfb_players.py - Onyx College Football player projections: passing, rushing and
receiving yards and receptions from every FBS box score this season (ESPN, read by
sports_espn.ingest_box into data/cfb/player_games.json).

The engine is nfl_model's: a decayed season average, adjusted for how much of the
stat the opponent's defense has allowed (regressed toward league average). What is
college-specific: ESPN's college box has no targets, so a receiving role is set by
receptions; there is no prior season on file (this season only); and the spread of
outcomes around a projection is fitted on college games, which are wider than the NFL's.

Changelog (newest first; each entry cites its evidence)

  v1  11/1  Built on 575 FBS games, weeks 1-9 of 2026. Parameters tuned on weeks 4-6,
      judged on weeks 7-9 the tuner never saw: MAE vs the season average / last-3
      average, rushing yards 29.5 vs 30.7 / 31.5 (+3.7% / +6.2%), passing 70.2 vs
      71.4 / 75.8 (+1.7% / +7.4%), receiving 22.4 vs 22.5 / 23.7 (+0.4% / +5.3%),
      receptions 1.44 vs 1.45 / 1.51. Small but steady gains over the baselines.
      Outcome spread fitted on weeks 4-6 residuals. Leans only: there is no history of Onyx college
      prop prices to backtest against yet, so nothing here is a tracked pick.
"""

import math
from collections import defaultdict

import nfl_model as N

VERSION = "v1"
STATS = N.STATS
ROLE = {"pass_yds": ("att", 12), "rush_yds": ("rush_att", 5), "rec_yds": ("rec", 1.5), "rec": ("rec", 1.5)}
P = {"decay": 0.95, "k_prior": 0.0, "opp_w": 1.0, "opp_k": 8.0}   # tuned on weeks 4-6
# outcome spread around the projection (fitted, see changelog): yards Normal(proj, a + b proj)
SD = {"pass_yds": (97.4, 0.0), "rush_yds": (21.6, 0.407), "rec_yds": (18.2, 0.345)}   # fitted on weeks 4-6
REC_VAR = 1.29
# judged on weeks 7-9 (never seen by the tuner): MAE, and the season-average / last-3 baselines
TEST = {"pass_yds": (240, 70.17, 71.37, 75.75), "rush_yds": (691, 29.54, 30.68, 31.48),
        "rec_yds": (1285, 22.43, 22.52, 23.68), "rec": (1285, 1.44, 1.45, 1.51)}


def project(hist, s, season, week, opp, allowed, p=None, lg_cache=None):
    """nfl_model.project with college roles: (proj, info) or (None, None)."""
    p = p or P
    lg_cache = {} if lg_cache is None else lg_cache
    cur = [g for g in hist if g["season"] == season and g["week"] < week]
    rk, rmin = ROLE[s]
    recent = cur[-4:]
    if len(cur) < 2 or sum(g.get(rk) or 0 for g in recent) / len(recent) < rmin:
        return None, None
    w = [p["decay"] ** i for i in range(len(cur))][::-1]
    base = sum((g.get(s) or 0) * wi for g, wi in zip(cur, w)) / sum(w)
    f = N._opp_factor(allowed, season, week, opp, s, p, lg_cache) if opp else 1.0
    return base * f, {"season": sum(g.get(s) or 0 for g in cur) / len(cur), "opp": f, "l3": [g.get(s) or 0 for g in cur[-3:]]}


def prob_over(s, proj, line):
    import sports_lab as L
    if s == "rec":
        return L.count_over(proj, line, REC_VAR * max(proj, 0.3))
    a, b = SD[s]
    return L.normal_over(proj, a + b * proj, line)


def evaluate(rows, season, w0, w1, p=None):
    """MAE of the projection vs the season average and last-3 average, weeks w0..w1."""
    p = p or P
    by = N._games_by_player(rows)
    allowed = N._team_allowed(rows)
    lgc, err, res = {}, {s: {"m": [], "avg": [], "l3": []} for s in STATS}, {s: [] for s in STATS}
    for pid, gs in by.items():
        for i, g in enumerate(gs):
            if g["season"] != season or not (w0 <= g["week"] <= w1):
                continue
            prior = gs[:i]
            cur = [x for x in prior if x["season"] == season]
            for s in STATS:
                pr, _ = project(prior, s, season, g["week"], g["opp"], allowed, p, lgc)
                if pr is None:
                    continue
                act = g.get(s) or 0
                avg = sum(x.get(s) or 0 for x in cur) / len(cur)
                l3 = sum(x.get(s) or 0 for x in cur[-3:]) / len(cur[-3:])
                err[s]["m"].append(abs(pr - act)); err[s]["avg"].append(abs(avg - act)); err[s]["l3"].append(abs(l3 - act))
                res[s].append((pr, act))
    out = {}
    for s, e in err.items():
        n = len(e["m"])
        if n:
            out[s] = {"n": n, "mae": sum(e["m"]) / n, "avg": sum(e["avg"]) / n, "l3": sum(e["l3"]) / n}
    return out, res


def tune(rows, season, w0=4, w1=6):
    best = None
    for decay in (0.6, 0.75, 0.85, 0.95):
        for ow in (0.0, 0.25, 0.5, 0.75, 1.0):
            for ok in (2.0, 4.0, 8.0):
                p = {"decay": decay, "k_prior": 0.0, "opp_w": ow, "opp_k": ok}
                r, _ = evaluate(rows, season, w0, w1, p)
                score = sum(v["mae"] / v["avg"] for v in r.values()) / max(1, len(r))
                if best is None or score < best[0]:
                    best = (score, p)
    return best


def fit_sd(res):
    """Spread around the projection by projection band: yards sd = a + b proj."""
    out = {}
    for s in ("pass_yds", "rush_yds", "rec_yds"):
        pts = sorted(res[s])
        if len(pts) < 100:
            continue
        k = len(pts) // 4
        xs, ys = [], []
        for q in range(4):
            chunk = pts[q * k:(q + 1) * k]
            xs.append(sum(p for p, a in chunk) / len(chunk))
            ys.append(math.sqrt(sum((a - p) ** 2 for p, a in chunk) / len(chunk)))
        n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / max(1e-9, sum((x - mx) ** 2 for x in xs))
        out[s] = (round(max(5.0, my - b * mx), 1), round(max(0.0, b), 3))
    pr = res["rec"]
    if pr:
        m = sum(p for p, a in pr) / len(pr)
        v = sum((a - p) ** 2 for p, a in pr) / len(pr)
        out["rec_var"] = round(v / max(m, 0.1), 2)
    return out


if __name__ == "__main__":
    import json, sys
    rows = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "data/cfb/player_games.json"))["rows"]
    season = max(r["season"] for r in rows)
    best = tune(rows, season)
    print("tuned on weeks 4-6:", best)
    p = best[1]
    _, res = evaluate(rows, season, 4, 6, p)
    print("spread fitted on weeks 4-6:", fit_sd(res))
    test, _ = evaluate(rows, season, 7, 9, p)
    for s, v in test.items():
        print(f"TEST weeks 7-9 {s:9s} n={v['n']:5d}  model {v['mae']:6.2f}  season avg {v['avg']:6.2f} ({(1 - v['mae'] / v['avg']) * 100:+.1f}%)  last 3 {v['l3']:6.2f} ({(1 - v['mae'] / v['l3']) * 100:+.1f}%)")
