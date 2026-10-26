"""
team_model.py - the team-strength engine shared by the NHL, college football
and NFL game-line models. Not a model by itself: each sport's module
(nhl_model.py, cfb_model.py, nfl_model.py) owns its parameters, version and
changelog, and calls in here.

Ratings: every team gets an offense and a defense rating in points (goals)
per game, fitted by weighted least squares on final scores,

    points(team vs opp) = league mean + home edge + off[team] - def[opp]

where older games weigh less (half-life in days) and every rating is pulled
toward zero (ridge), so a team with three games is not rated off three games.
The offseason needs no special case: the summer gap decays last season.

Prices from ratings:
  football  margin ~ Normal(mean, sd_margin), total ~ Normal(mean, sd_total)
  hockey    each side's goals ~ Poisson; a regulation tie goes to overtime,
            won by the home side with p_ot_home
"""

import math
from datetime import date

from sports_lab import ncdf, poisson_cdf


def _days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def fit(games, as_of, P, iters=12):
    """Ratings from games played before as_of (an ISO date). P: half_life,
    ridge, home (fixed home edge, points), carry (dict team -> (off, def)
    prior centre, optional)."""
    rows = [g for g in games if g["date"] < as_of]
    if not rows:
        return {"mu": P.get("mu0", 0.0), "off": {}, "def": {}, "home": P["home"], "n": {}}
    hl = P["half_life"]
    w = [0.5 ** (_days(g["date"], as_of) / hl) for g in rows]
    sw = sum(w)
    mu = sum(wi * (g["hs"] + g["as"]) / 2 for wi, g in zip(w, rows)) / sw
    home = P["home"]
    off, de = {}, {}
    n = {}
    for g in rows:
        for t in (g["home"], g["away"]):
            off.setdefault(t, 0.0)
            de.setdefault(t, 0.0)
            n[t] = n.get(t, 0) + 1
    lam = P["ridge"]
    for _ in range(iters):
        # offense: residual of points scored after mean, home and opponent defense
        num, den = {t: 0.0 for t in off}, {t: lam for t in off}
        for wi, g in zip(w, rows):
            h = 0.0 if g.get("neutral") else home
            num[g["home"]] += wi * (g["hs"] - mu - h / 2 + de[g["away"]])
            den[g["home"]] += wi
            num[g["away"]] += wi * (g["as"] - mu + h / 2 + de[g["home"]])
            den[g["away"]] += wi
        off = {t: num[t] / den[t] for t in off}
        num, den = {t: 0.0 for t in de}, {t: lam for t in de}
        for wi, g in zip(w, rows):
            h = 0.0 if g.get("neutral") else home
            num[g["away"]] += wi * (mu + h / 2 + off[g["home"]] - g["hs"])
            den[g["away"]] += wi
            num[g["home"]] += wi * (mu - h / 2 + off[g["away"]] - g["as"])
            den[g["home"]] += wi
        de = {t: num[t] / den[t] for t in de}
    return {"mu": mu, "off": off, "def": de, "home": home, "n": n}


def expect(R, home, away, neutral=False):
    """Expected points (goals) for home and away."""
    h = 0.0 if neutral else R["home"]
    eh = R["mu"] + h / 2 + R["off"].get(home, 0.0) - R["def"].get(away, 0.0)
    ea = R["mu"] - h / 2 + R["off"].get(away, 0.0) - R["def"].get(home, 0.0)
    return max(eh, 0.05), max(ea, 0.05)


# ── football ───────────────────────────────────────────────────────────
def fb_probs(eh, ea, P):
    """P(home wins), P(home covers spread s) and P(total over t) as functions."""
    m, t = eh - ea, eh + ea
    sm, st = P["sd_margin"], P["sd_total"]
    return {
        "mean_margin": m, "mean_total": t,
        "home_win": 1 - ncdf((0 - m) / sm),
        # home spread s (e.g. -3.5): home covers when margin + s > 0
        "home_cover": lambda s: 1 - ncdf((-s - m) / sm),
        "over": lambda line: 1 - ncdf((line - t) / st),
    }


# ── hockey ─────────────────────────────────────────────────────────────
def _pois(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


def hk_probs(eh, ea, P, kmax=12):
    ph = [_pois(k, eh) for k in range(kmax + 1)]
    pa = [_pois(k, ea) for k in range(kmax + 1)]
    win = tie = 0.0
    diff = {}
    for i, x in enumerate(ph):
        for j, y in enumerate(pa):
            p = x * y
            diff[i - j] = diff.get(i - j, 0.0) + p
            if i > j:
                win += p
            elif i == j:
                tie += p
    p_home = win + tie * P["p_ot_home"]

    def cover(s):
        # home puck line s (-1.5 or +1.5): home covers when regulation margin + s > 0;
        # an overtime game is a one-goal game, so a tie becomes +1 for the OT winner
        tot = 0.0
        for d, p in diff.items():
            if d == 0:
                tot += p * (P["p_ot_home"] * (1 + s > 0) + (1 - P["p_ot_home"]) * (-1 + s > 0))
            elif d + s > 0:
                tot += p
        return tot

    lam_t = eh + ea

    def over(line):
        # regulation goals, plus one for the overtime or shootout winner on a
        # tie. A whole-number line can push: the chance returned is the chance
        # of the over given no push, which is what a two-sided price compares.
        k = math.floor(line)
        tie_k = sum(ph[i] * pa[i] for i in range(kmax + 1) if 2 * i == k)
        reg_gt = 1 - poisson_cdf(k, lam_t)
        if k != line:
            return reg_gt + tie_k               # a k-k tie (k even) ends at k+1
        tie_k1 = sum(ph[i] * pa[i] for i in range(kmax + 1) if 2 * i == k - 1)
        reg_eq = poisson_cdf(k, lam_t) - poisson_cdf(k - 1, lam_t)
        p_over = reg_gt + tie_k                 # finals above the line
        p_push = reg_eq - tie_k + tie_k1        # finals exactly on it
        return p_over / max(1 - p_push, 1e-9)

    return {"mean_margin": eh - ea, "mean_total": lam_t, "home_win": p_home, "home_cover": cover, "over": over}


# ── evaluation helpers (the backtests and the page's tests) ─────────────
def walk(games, P, kind, start=None, step_days=7):
    """Walk-forward predictions: ratings refit every step_days, each game
    predicted only from games before its date. Returns (game, eh, ea)."""
    out = []
    cur, R = None, None
    for g in games:
        if start and g["date"] < start:
            continue
        if cur is None or _days(cur, g["date"]) >= step_days:
            cur = g["date"]
            R = fit(games, cur, P)
        if R["n"].get(g["home"], 0) < P.get("min_games", 3) or R["n"].get(g["away"], 0) < P.get("min_games", 3):
            continue
        eh, ea = expect(R, g["home"], g["away"], g.get("neutral"))
        out.append((g, eh, ea))
    return out


def score(preds, kind, P):
    """MAE of margin and total, and the log loss of the win probability,
    against a coin flip with home edge (the baseline a bettor gets free)."""
    if not preds:
        return None
    mm = mt = ll = 0.0
    for g, eh, ea in preds:
        pr = (fb_probs if kind == "football" else hk_probs)(eh, ea, P)
        m, t = g["hs"] - g["as"], g["hs"] + g["as"]
        mm += abs(m - pr["mean_margin"])
        mt += abs(t - pr["mean_total"])
        p = min(max(pr["home_win"], 1e-4), 1 - 1e-4)
        ll += -math.log(p if m > 0 else 1 - p)
    n = len(preds)
    return {"n": n, "mae_margin": mm / n, "mae_total": mt / n, "logloss": ll / n}
