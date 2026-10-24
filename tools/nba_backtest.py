#!/usr/bin/env python3
"""
nba_backtest.py - walk-forward backtest of nba_model.project_slate (dev only).

Replays the 2025-26 regular season one game day at a time. On each day the
model sees ONLY what existed before tip: 2024-25 as the prior, 2025-26 box
scores from earlier days, team pace / defense from earlier days. It then
projects every player who suited up that night and is scored against the
real box score.

Data: bt/games.json + bt/box.json from tools/nba_backtest_pull.py (OpticOdds).

What it can and cannot see (read before quoting numbers):
  - Who played is taken from the box score, i.e. it assumes the final
    injury report is known at tip. Production has that too (OUT / GTD).
  - No historical game lines: the points environment uses the no-line path
    (team scoring vs what the opponent allows). Production fits team points
    to the Onyx implied total, which should only help.

Usage:
  python3 tools/nba_backtest.py bt/                 # score the live params
  python3 tools/nba_backtest.py bt/ --tune          # tune on Oct-Jan, test Feb-Apr
"""

import json, math, sys, time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import nba_model as M
from nba_common import team_abbr

STATS = ("pts", "reb", "ast")
SPLIT = "2026-02-01"          # tune before, test on/after
MIN_PROJ = 20.0               # prop-relevant players for the headline numbers


def gday(iso):
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt - timedelta(hours=8)).date().isoformat()   # UTC -> ET (~-4/-5) -> game day (-4h); tips are 12-11 PM ET


def load(bt):
    games = json.load(open(Path(bt) / "games.json"))
    box = json.load(open(Path(bt) / "box.json"))
    G = {}
    for g in games.values():
        h, a = team_abbr(g["home"]), team_abbr(g["away"])
        if not h or not a:
            continue
        G[g["id"]] = {"gid": g["id"], "d": gday(g["start"]), "home": h, "away": a,
                      "hs": g.get("hs"), "as": g.get("as")}
    lines = defaultdict(list)
    for (fid, pid, name, pos, team, starter, mins, secs, pts, reb, ast, fg3, fga, fta, oreb, tov) in box:
        if fid not in G:
            continue
        m = mins if mins is not None else (secs or 0) / 60.0
        lines[fid].append({"pid": pid, "name": name, "pos": pos or "", "team": team_abbr(team),
                           "starter": starter, "min": float(m or 0), "pts": float(pts or 0),
                           "reb": float(reb or 0), "ast": float(ast or 0), "fg3": float(fg3 or 0),
                           "fga": float(fga or 0), "fta": float(fta or 0), "oreb": float(oreb or 0),
                           "tov": float(tov or 0)})
    return G, lines


def build_prior(G, lines, before):
    pr = {}
    for fid, ls in lines.items():
        if G[fid]["d"] >= before:
            continue
        for l in ls:
            if l["min"] <= 0:
                continue
            a = pr.setdefault(l["pid"], {"n": l["name"], "t": l["team"], "pos": l["pos"], "gp": 0,
                                         "min": 0.0, "pts": 0.0, "reb": 0.0, "ast": 0.0, "fg3": 0.0, "_last": ""})
            a["gp"] += 1
            for k in ("min", "pts", "reb", "ast", "fg3"):
                a[k] += l[k]
            if G[fid]["d"] >= a["_last"]:
                a["_last"], a["t"] = G[fid]["d"], l["team"]
    return pr


def walk(G, lines, season_start, season_end, prior):
    """Yield one record per player-game: projection, baselines, actual."""
    by_day = defaultdict(list)
    for fid, g in G.items():
        if season_start <= g["d"] <= season_end:
            by_day[g["d"]].append(fid)
    pg, tg, out = {}, {}, []
    for d in sorted(by_day):
        fids = by_day[d]
        slate = {"date": d, "games": [], "players": []}
        for fid in fids:
            g = G[fid]
            slate["games"].append({"gid": fid, "away": g["away"], "home": g["home"], "state": "pre",
                                   "spread": None, "total": None})
            for l in lines[fid]:
                if l["min"] <= 0 or l["team"] not in (g["home"], g["away"]):
                    continue
                opp = g["away"] if l["team"] == g["home"] else g["home"]
                slate["players"].append({"pid": l["pid"], "name": l["name"], "team": l["team"], "opp": opp,
                                         "home": l["team"] == g["home"], "gid": fid, "pos": l["pos"], "inj": ""})
        rows, _ = M.project_slate(slate, prior, pg, tg)
        actual = {(fid, l["pid"]): l for fid in fids for l in lines[fid]}
        for r in rows:
            a = actual.get((r["gid"], r["pid"]))
            if not a:
                continue
            hist = [x for x in (pg.get(r["pid"]) or {}).get("g", []) if x[4] > 0]
            pri = prior.get(r["pid"])
            base = {}
            for s in STATS:
                i = M.IDX[s]
                szn = sum(x[i] for x in hist) / len(hist) if len(hist) >= 3 else None
                l10 = sum(x[i] for x in hist[-10:]) / len(hist[-10:]) if hist else None
                pv = pri[s] / pri["gp"] if pri and pri.get("gp") else None
                base[s] = {"szn": szn if szn is not None else pv, "l10": l10 if l10 is not None else pv, "prior": pv}
            out.append({"d": d, "pid": r["pid"], "name": r["name"], "pmin": r["min"], "amin": a["min"],
                        "proj": dict(r["proj"]), "act": {s: a[s] for s in STATS}, "base": base,
                        "gp": len(hist)})
        # the day is over: its box scores join the history
        for fid in fids:
            g = G[fid]
            team_tot = defaultdict(lambda: defaultdict(float))
            for l in lines[fid]:
                if l["team"] not in (g["home"], g["away"]):
                    continue
                opp = g["away"] if l["team"] == g["home"] else g["home"]
                rec = pg.setdefault(l["pid"], {"n": l["name"], "t": l["team"], "g": []})
                rec["g"].append([d, fid, opp, int(l["team"] == g["home"]), l["min"], l["pts"], l["reb"],
                                 l["ast"], l["fg3"], l["starter"]])
                for k in ("pts", "reb", "ast", "fga", "fta", "oreb", "tov"):
                    team_tot[l["team"]][k] += l[k]
            for team in (g["home"], g["away"]):
                opp = g["away"] if team == g["home"] else g["home"]
                t, o = team_tot[team], team_tot[opp]
                tg.setdefault(team, []).append({
                    "d": d, "gid": fid, "opp": opp, "home": team == g["home"],
                    "pts": t["pts"], "opp_pts": o["pts"], "reb": t["reb"], "opp_reb": o["reb"],
                    "ast": t["ast"], "opp_ast": o["ast"],
                    "poss": t["fga"] - t["oreb"] + t["tov"] + 0.44 * t["fta"]})
    return out


def score(recs, lo="0000", hi="9999", min_proj=MIN_PROJ):
    sel = [r for r in recs if lo <= r["d"] < hi and r["pmin"] >= min_proj]
    res = {"n": len(sel)}
    if not sel:
        return res
    res["min_mae"] = sum(abs(r["pmin"] - r["amin"]) for r in sel) / len(sel)
    for s in STATS:
        e = [r["proj"][s] - r["act"][s] for r in sel]
        res[s] = {"mae": sum(map(abs, e)) / len(e), "rmse": math.sqrt(sum(x * x for x in e) / len(e)),
                  "bias": sum(e) / len(e), "mean": sum(r["act"][s] for r in sel) / len(sel)}
        for b in ("szn", "l10", "prior"):
            bb = [(r["base"][s][b], r["act"][s]) for r in sel if r["base"][s][b] is not None]
            res[s][b] = sum(abs(p - a) for p, a in bb) / len(bb) if bb else None
    res["obj"] = sum(res[s]["mae"] / res[s]["mean"] for s in STATS) / 3
    return res


def fmt(res, title):
    print(f"\n{title}: {res['n']} player-games (projected 20+ min); minutes MAE {res.get('min_mae', 0):.2f}")
    print(f"  {'stat':5s} {'model MAE':>9s} {'RMSE':>6s} {'bias':>6s} | {'szn avg':>7s} {'last 10':>7s} {'prior':>6s}")
    for s in STATS:
        r = res[s]
        print(f"  {s:5s} {r['mae']:9.3f} {r['rmse']:6.2f} {r['bias']:+6.2f} | {r['szn']:7.3f} {r['l10']:7.3f} {r['prior']:6.3f}")


def calibration(recs, lo, hi):
    """Distribution check: for a market-like line (season average to date,
    rounded to x.5), does P(over) from prob_over match how often it went over?
    Also fits the per-stat spread (sd = a*mean + b) from residuals."""
    sel = [r for r in recs if lo <= r["d"] < hi and r["pmin"] >= MIN_PROJ]
    out = {}
    for s in STATS:
        buckets = defaultdict(lambda: [0, 0, 0.0])
        for r in sel:
            b = r["base"][s]["szn"]
            if b is None:
                continue
            line = math.floor(b) + 0.5
            p, _ = M.prob_over(r["proj"][s], line, s)
            k = min(9, int(p * 10))
            buckets[k][0] += 1
            buckets[k][1] += r["act"][s] > line
            buckets[k][2] += p
        rows = [(k, v[0], v[2] / v[0], v[1] / v[0]) for k, v in sorted(buckets.items()) if v[0] >= 30]
        brier_gap = sum(n * abs(pp - aa) for _, n, pp, aa in rows) / max(1, sum(n for _, n, _, _ in rows))
        # least squares |resid| ~ a*mean + b, converted to sd (E|x| = sd*sqrt(2/pi))
        xs = [r["proj"][s] for r in sel]
        ys = [abs(r["proj"][s] - r["act"][s]) / math.sqrt(2 / math.pi) for r in sel]
        n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
        a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
        out[s] = {"rows": rows, "gap": brier_gap, "sd_fit": (round(a, 3), round(my - a * mx, 2))}
    return out


GRID = {
    "PRIOR_GAMES_K": [2, 4, 6, 10],
    "RATE_PRIOR_MIN": [150.0, 300.0, 500.0, 800.0],
    "min_recent_w": [0.0, 0.15, 0.30, 0.45],
    "min_recent_n": [3, 5],
    "min_decay": [1.0, 0.95, 0.9],
    "rate_decay": [1.0, 0.97, 0.93],
    "l5_nudge": [0.0, 0.25, 0.5],
    "b2b_mult": [0.95, 0.97, 1.0],
    "opp_exp": [0.0, 0.25, 0.5, 0.75],
    "pace_exp": [0.0, 0.5, 1.0],
    "pts_fit_exp": [0.0, 0.4, 0.8],
    "home_pts": [0.0, 0.01, 0.02],
}


def setp(k, v):
    if k in ("PRIOR_GAMES_K", "RATE_PRIOR_MIN"):
        setattr(M, k, v)
    else:
        M.P[k] = v


def getp(k):
    return getattr(M, k) if k in ("PRIOR_GAMES_K", "RATE_PRIOR_MIN") else M.P[k]


def main():
    bt = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "bt"
    G, lines = load(bt)
    prior = build_prior(G, lines, "2025-08-01")
    print(f"loaded {len(G)} games, prior for {len(prior)} players (2024-25)")
    run = lambda: walk(G, lines, "2025-10-01", "2026-04-30", prior)
    t0 = time.time()
    recs = run()
    print(f"walk-forward: {len(recs)} player-games in {time.time() - t0:.1f}s")
    fmt(score(recs, hi=SPLIT), "LIVE params, train window (Oct-Jan)")
    fmt(score(recs, lo=SPLIT), "LIVE params, test window (Feb-Apr)")
    if "--tune" not in sys.argv:
        return
    base_obj = score(recs, hi=SPLIT)["obj"]
    best = {k: getp(k) for k in GRID}
    for sweep in range(2):
        for k, vals in GRID.items():
            scores = {}
            for v in vals:
                setp(k, v)
                scores[v] = score(run(), hi=SPLIT)["obj"]
            v_best = min(scores, key=scores.get)
            setp(k, v_best)
            best[k] = v_best
            print(f"  sweep {sweep + 1} {k:15s} -> {v_best}  (" +
                  ", ".join(f"{v}:{o:.4f}" for v, o in scores.items()) + ")")
    recs = run()
    tr, te = score(recs, hi=SPLIT), score(recs, lo=SPLIT)
    print(f"\nTRAIN objective {base_obj:.4f} -> {tr['obj']:.4f}")
    fmt(tr, "TUNED params, train window (Oct-Jan)")
    fmt(te, "TUNED params, TEST window (Feb-Apr, never seen by the tuner)")
    print("\nbest params:", json.dumps(best))
    cal = calibration(recs, SPLIT, "9999")
    for s, c in cal.items():
        print(f"\ncalibration {s} (test window): mean |pred - actual| per bucket {c['gap']:.3f}; sd fit {c['sd_fit']}")
        for k, n, p, a in c["rows"]:
            print(f"   P(over) {k / 10:.1f}-{(k + 1) / 10:.1f}: n={n:5d} predicted {p:.3f} actual {a:.3f}")
    json.dump({"best": best, "train": tr, "test": te,
               "calibration": {s: {"gap": c["gap"], "sd_fit": c["sd_fit"]} for s, c in cal.items()}},
              open(Path(bt) / "tuned.json", "w"), indent=1)


if __name__ == "__main__":
    main()
