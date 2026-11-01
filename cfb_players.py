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

  v2  11/1  Rushing yards: a market model on Onyx's price. tools/cfb_feature_screen.py runs the
      NFL v11 method on every Onyx college rushing-yards line of 2026 (opening price):
      P(over) = sigmoid(a + b logit(Onyx no-vig) + sum c z(stat)), statistics chosen on
      lines before 10/1 (221) and judged on lines after (525). Chosen: rushing yards the
      opponent allows (vs league), carries it allows, and how far the line sits from the
      runner's season average in his own game-to-game spread. On the unseen weeks: log loss
      .6794 vs Onyx .6916; unders at 3pp+ 92-59 +14.4%, at 5pp+ 47-20 +31.7%; at Onyx's
      closing price with the same line 24-19 +5.5%. By edge, unders at 3-5pp were flat in
      both periods (-1.4%, +0.6%) and 5pp+ won in both (33-14 before 10/1, 47-20 after), so
      the lane is rushing yards unders at 5pp+ at the opening price, on trial
      (data/cfb/prop_trial.json). Onyx's college rushing lines go over only 41.7% of the
      time, so most of the edge is that unders are underpriced; the model picks which.
      Players with no box line are voids here (Onyx settles them at 0, an under win), so the
      test undercounts unders. Receiving yards (2026 log loss .6987 vs .6938), receptions
      and passing yards (too few early lines to choose on) stay leans.

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

VERSION = "v2"
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


# v2 (11/1): market models on Onyx's price. The statistics, computed the same way here for
# the backtest (tools/cfb_feature_screen.py) and the live build, from box scores before the game.
VOL = {"rec": "rec", "rec_yds": "rec", "rush_yds": "rush_att", "pass_yds": "att"}
_SUM = ("rec", "rec_yds", "rush_yds", "pass_yds", "rush_att", "att")


class MarketIndex:
    def __init__(self, rows):
        self.by_pid = defaultdict(list)
        self.team_g = defaultdict(lambda: defaultdict(float))     # (gid, team) totals
        self.opp_g = defaultdict(lambda: defaultdict(float))      # (gid, defense) allowed
        self.gdate = {}
        for r in sorted(rows, key=lambda r: r["date"]):
            r = dict(r)
            for k in _SUM:
                r[k] = r.get(k) or 0.0
            self.by_pid[r["pid"]].append(r)
            self.gdate[(r["gid"], r["team"])] = r["date"]
            self.gdate[(r["gid"], r["opp"])] = r["date"]
            for k in _SUM:
                self.team_g[(r["gid"], r["team"])][k] += r[k]
                self.opp_g[(r["gid"], r["opp"])][k] += r[k]
        self._lg = {}

    def _log(self, team, d, src):
        return [v for (gid, t), v in src.items() if t == team and self.gdate[(gid, t)] < d]

    def lg(self, d, k):
        if (d, k) not in self._lg:
            vals = [v[k] for (gid, t), v in self.opp_g.items() if self.gdate[(gid, t)] < d]
            self._lg[(d, k)] = (sum(vals) / len(vals) if vals else 0.0) or 1.0
        return self._lg[(d, k)]

    def features(self, pid, team, opp, home, d, line, mkt, spread, total):
        """Statistics known before the game on date d; spread is the team's (+ = underdog)."""
        mean = lambda xs: sum(xs) / len(xs) if xs else 0.0
        h = [g for g in self.by_pid.get(pid, []) if g["date"] < d]
        if len(h) < 2:
            return None
        l3, vol = h[-3:], VOL[mkt]
        sd = (sum((g[mkt] - mean([q[mkt] for q in h])) ** 2 for g in h) / max(1, len(h) - 1)) ** 0.5
        tl, ol = self._log(team, d, self.team_g), self._log(opp, d, self.opp_g)
        return {"l3": mean([g[mkt] for g in l3]), "season": mean([g[mkt] for g in h]),
                "line_vs_l3": line - mean([g[mkt] for g in l3]), "line_vs_season": line - mean([g[mkt] for g in h]),
                "line_z": (line - mean([g[mkt] for g in h])) / sd if sd else 0.0, "sd": sd,
                "trend": mean([g[mkt] for g in l3]) - mean([g[mkt] for g in h]),
                "vol_l3": mean([g[vol] for g in l3]), "vol_season": mean([g[vol] for g in h]),
                "eff": sum(g[mkt] for g in h) / max(1.0, sum(g[vol] for g in h)) if mkt != "rec" else 0.0,
                "share": mean([g[vol] / max(1.0, self.team_g[(g["gid"], g["team"])][vol]) for g in h]),
                "team_vol": mean([t[vol] for t in tl]), "team_stat": mean([t[mkt] for t in tl]),
                "opp_allowed": mean([o[mkt] for o in ol]) / self.lg(d, mkt) if ol else 1.0,
                "opp_vol": mean([o[vol] for o in ol]) / self.lg(d, vol) if ol else 1.0,
                "implied": (total - spread) / 2, "spread": spread, "total": total, "home": 1.0 if home else 0.0,
                "games": float(len(h)), "line": line}


V2 = {
 "rush_yds": {
  "side": "under",
  "features": [
   "opp_allowed",
   "opp_vol",
   "line_z"
  ],
  "mu": [
   0.76618,
   0.93086,
   -0.04839
  ],
  "sd": [
   0.3329,
   0.13902,
   6.167
  ],
  "w": [
   -0.33483,
   0.09384,
   0.33464,
   -0.09416,
   -0.24238
  ]
 }
}
V2_EDGE = 0.05
LABEL = {"opp_allowed": "rushing yards the defense allows", "opp_vol": "carries the defense allows",
         "line_z": "line vs his usual range"}


def prob_v2(mkt, p_onyx, f):
    S = V2[mkt]
    p = min(max(p_onyx, 1e-4), 1 - 1e-4)
    z = S["w"][0] + S["w"][1] * math.log(p / (1 - p))
    for k, mu, sd, c in zip(S["features"], S["mu"], S["sd"], S["w"][2:]):
        z += c * (f.get(k, 0.0) - mu) / (sd or 1.0)
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def why_v2(mkt, p_onyx, f):
    S = V2[mkt]
    mid = dict(zip(S["features"], S["mu"]))
    base = prob_v2(mkt, p_onyx, mid)
    out = [{"k": LABEL.get(k, k), "v": round(f.get(k, 0.0), 2), "avg": round(mu, 2),
            "pp": round(100 * (prob_v2(mkt, p_onyx, dict(mid, **{k: f.get(k, 0.0)})) - base), 1)}
           for k, mu in zip(S["features"], S["mu"])]
    return sorted(out, key=lambda d: -abs(d["pp"]))
