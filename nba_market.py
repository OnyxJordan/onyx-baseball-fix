#!/usr/bin/env python3
"""
nba_market.py - NBA market models on Onyx's price (11/1). Assists unders.

The statistics, computed the same way for the backtest (tools/nba_feature_screen.py)
and the live lane (open_lanes.py), from what was known before tip:

  opp_allowed  assists the opponent allowed per game over its last 15 games, over the
               league's average per team-game before this month
  line_z       (Onyx's line - his last-10 assists average) / his last-10 spread

P(over) = sigmoid(a + b logit(Onyx no-vig over) + c1 z(opp_allowed) + c2 z(line_z)),
chosen on 2025-26 lines before 2/1/2026, judged after, coefficients refit on both
(open_lanes changelog, open-v3). Stdlib only.
"""
import math

AST = {"features": ["opp_allowed", "line_z"], "mu": [1.00369, -0.04186], "sd": [0.0731, 0.42603],
       "w": [-0.05092, 0.79489, 0.08428, -0.06529]}
EDGE = 0.03
MIN_GAMES = 5
LABEL = {"opp_allowed": "assists the opponent allows", "line_z": "line vs his usual range"}


def features(ast_hist, allowed_hist, league_allowed, line):
    """ast_hist: his assists in games he played, oldest first, before tonight.
    allowed_hist: assists the opponent allowed per game, oldest first, before tonight.
    league_allowed: league average assists allowed per team-game before this month."""
    if len(ast_hist) < MIN_GAMES:
        return None
    l10 = ast_hist[-10:]
    m = sum(l10) / len(l10)
    sd = (sum((a - m) ** 2 for a in l10) / (len(l10) - 1)) ** 0.5 if len(l10) > 1 else 0.0
    ob = allowed_hist[-15:]
    return {"opp_allowed": (sum(ob) / len(ob)) / (league_allowed or 1.0) if ob else 1.0,
            "line_z": (line - m) / sd if sd else 0.0, "l10": m}


def prob_over(p_onyx, f, S=AST):
    p = min(max(p_onyx, 1e-4), 1 - 1e-4)
    z = S["w"][0] + S["w"][1] * math.log(p / (1 - p))
    for k, mu, sd, c in zip(S["features"], S["mu"], S["sd"], S["w"][2:]):
        z += c * (f.get(k, 0.0) - mu) / (sd or 1.0)
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def why(p_onyx, f, S=AST):
    """Each statistic's push on the chance of the over, in points."""
    mid = dict(zip(S["features"], S["mu"]))
    base = prob_over(p_onyx, mid, S)
    out = [{"k": LABEL.get(k, k), "v": round(f.get(k, 0.0), 2), "avg": round(mu, 2),
            "pp": round(100 * (prob_over(p_onyx, dict(mid, **{k: f.get(k, 0.0)}), S) - base), 1)}
           for k, mu in zip(S["features"], S["mu"])]
    return sorted(out, key=lambda d: -abs(d["pp"]))
