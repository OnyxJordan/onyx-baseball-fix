#!/usr/bin/env python3
"""
nfl_proj_test.py - do volume x efficiency projections beat recent averages, and how close
do they get to Onyx's own line? Dev only (bt/ files, through tools/nfl_feature_screen.py).

For every Onyx player-prop line of 2025 and 2026 with the actual result:
  volume      the team's pass attempts / carries expected tonight: its last-4 average,
              moved by Onyx's spread (a team expected to trail throws more) and implied points
  share       the player's share of targets / carries / team attempts, recent weeks weighted
              more, scaled by his snap-share trend
  efficiency  catches per target, yards per target / carry / attempt, regressed to his
              position's average by a fixed number of attempts
Parameters tuned on 2025, judged on 2026 (MAE, and bias). Baselines: last-5 average,
season average, a decayed average, and Onyx's opening line (the bar).

    python3 tools/nfl_proj_test.py
"""
import itertools, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfl_feature_screen as S          # noqa: E402

MK = ("rec", "rec_yds", "rush_yds", "pass_yds", "pass_att", "rush_rec_yds", "pass_rush_yds")
STAT = {"rec": "receptions", "rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards",
        "pass_att": "attempts", "rush_rec_yds": "rush_rec_yds", "pass_rush_yds": "pass_rush_yds"}


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def wavg(xs, d):
    """decayed average, newest weighted 1, the one before d, ..."""
    if not xs:
        return 0.0
    w = [d ** i for i in range(len(xs))][::-1]
    return sum(a * b for a, b in zip(xs, w)) / sum(w)


class Proj:
    def __init__(self, IX):
        self.IX = IX
        self.pos_eff = {}

    def team_vol(self, team, season, week, imp, spread, P):
        th = self.IX.team_hist(team, season, week, n=P["tn"])
        if not th:
            return None, None
        att = mean([t["attempts"] for t in th]) or 32.0
        car = mean([t["carries"] for t in th]) or 26.0
        # spread: + = underdog, trailing teams throw more and run less; implied points scale plays
        att *= (1 + P["sp_a"] * spread) * (1 + P["imp_v"] * (imp - 22.5))
        car *= (1 - P["sp_c"] * spread) * (1 + P["imp_v"] * (imp - 22.5))
        return att, car

    def share(self, h, key, tot, P):
        """the player's share of team volume, recent weeks weighted more"""
        xs = []
        for g in h[-8:]:
            t = self.IX.team_wk[(g["season"], g["week"], g["team"])][tot]
            if t > 0:
                xs.append(g[key] / t)
        return wavg(xs, P["d"])

    def eff(self, h, num, den, prior, k):
        n, d_ = sum(g[num] for g in h[-16:]), sum(g[den] for g in h[-16:])
        return (n + prior * k) / (d_ + k)

    def project(self, r, stat, P):
        IX = self.IX
        h = IX.hist(r["pid"], r["season_"], r["week"])
        if len(h) < 2:
            return None
        imp, spr, home = r["env"]
        att, car = self.team_vol(r["team"], r["season_"], r["week"], imp, spr, P)
        if att is None:
            return None
        # snap trend: last game's snap share over his recent average, damped
        sn = [IX.snaps.get((g["season"], g["week"], g["team"], g["key"])) for g in h[-5:]]
        sn = [x for x in sn if x is not None]
        role = 1.0
        if len(sn) >= 2 and mean(sn) > 0:
            role = 1 + P["snap"] * (sn[-1] / mean(sn) - 1)
        tgt = att * self.share(h, "targets", "targets", P) * role
        rush = car * self.share(h, "carries", "carries", P) * role
        qb = self.share(h, "attempts", "attempts", P)
        catch = self.eff(h, "receptions", "targets", 0.64, P["k_t"])
        ypt = self.eff(h, "receiving_yards", "targets", 7.4, P["k_t"])
        ypc = self.eff(h, "rushing_yards", "carries", 4.3, P["k_c"])
        ypa = self.eff(h, "passing_yards", "attempts", 6.6, P["k_a"])
        out = {"receptions": tgt * catch, "receiving_yards": tgt * ypt, "rushing_yards": rush * ypc,
               "attempts": att * qb, "passing_yards": att * qb * ypa}
        out["rush_rec_yds"] = out["receiving_yards"] + out["rushing_yards"]
        out["pass_rush_yds"] = out["passing_yards"] + out["rushing_yards"]
        return out[stat]


def baselines(IX, r, stat):
    h = IX.hist(r["pid"], r["season_"], r["week"])
    xs = [g[stat] for g in h]
    cur = [g[stat] for g in h if g["season"] == r["season_"]] or xs[-8:]
    return {"last5": mean(xs[-5:]), "season": mean(cur), "decayed": wavg(xs[-10:], 0.85)}


def main():
    sys.argv = ["x", "--proj"] + [a for a in sys.argv[1:] if not a.startswith("--")]
    DATA, IX = S.main()
    PJ = Proj(IX)
    base_P = {"tn": 4, "sp_a": 0.01, "sp_c": 0.015, "imp_v": 0.01, "d": 0.8, "snap": 0.5, "k_t": 40, "k_c": 60, "k_a": 150}
    grid = {"sp_a": [0.0, 0.01, 0.02], "imp_v": [0.0, 0.01, 0.02], "d": [0.7, 0.85], "snap": [0.0, 0.5, 1.0]}
    print(f"\n{'market':14s} {'n 2026':>7s}  {'Onyx line':>9s} {'last 5':>7s} {'season':>7s} {'decayed':>8s} {'vol x eff':>9s} {'blend':>7s}  tuned on 2025")
    for mkt in MK:
        rows = DATA.get(mkt) or []
        stat = STAT[mkt]
        tr = [r for r in rows if r["season"] == 2025]
        te = [r for r in rows if r["season"] == 2026]
        if len(tr) < 100 or len(te) < 40:
            continue

        def mae(rs, P, blend=None):
            e, n = 0.0, 0
            for r in rs:
                pr = PJ.project(r, stat, P)
                if pr is None:
                    continue
                if blend is not None:
                    pr = blend * pr + (1 - blend) * baselines(IX, r, stat)["decayed"]
                e += abs(pr - r["act"]); n += 1
            return e / max(1, n)
        best = None
        for vals in itertools.product(*grid.values()):
            P = dict(base_P, **dict(zip(grid, vals)))
            m = mae(tr, P)
            if best is None or m < best[0]:
                best = (m, P)
        P = best[1]
        bl = min((mae(tr, P, b), b) for b in (0.5, 0.7, 0.85, 1.0))[1]
        res = {"line": mean([abs(r["line"] - r["act"]) for r in te])}
        for k in ("last5", "season", "decayed"):
            res[k] = mean([abs(baselines(IX, r, stat)[k] - r["act"]) for r in te])
        res["vol"] = mae(te, P)
        res["blend"] = mae(te, P, bl)
        print(f"{mkt:14s} {len(te):7d}  {res['line']:9.2f} {res['last5']:7.2f} {res['season']:7.2f} {res['decayed']:8.2f} {res['vol']:9.2f} {res['blend']:7.2f}  "
              f"blend {bl} {dict((k, P[k]) for k in grid)}")


if __name__ == "__main__":
    main()
