"""
nfl_model.py - Onyx NFL player projections.

VERSION v2 (10/29). The lab notebook: every change bumps VERSION and adds an
entry here citing its evidence (CLAUDE.md rule 2 applies to this model too).

  v2  10/29  Touchdown scorers: anytime and first TD chances per player.
             Expected team TDs = c x Onyx implied team points / 7 (implied =
             (total -/+ spread) / 2). A player's share of them blends his
             opportunity share (rushes and targets over the team's, last 8
             games, rush weight .8, target weight 1.0) with his own TD share
             pulled toward that opportunity share (k = 4 team TDs), weight .3.
             Anytime = 1 - exp(-lambda). First TD = (1 - .055) x his lambda /
             all listed players' lambda in the game (5.5% of 2025 first TDs
             were defense, returns or unlisted players). Tuned on 2025
             (4,241 player-games), judged on 2026 (1,423): anytime log loss
             0.4819 vs 0.5819 for the player's own TD rate and 0.5302 flat;
             calibrated (predicted .150 actual .159, .369/.369, .539/.521).
             First TD log score 2.823 vs 3.017 uniform over listed players
             (78 games; predicted .044/.051, .105/.103). Not yet tested
             against Onyx's TD prices: leans only.

  v1  10/26  Game lines: team offense and defense ratings in points from
             392 NFL finals (2025 and 2026, team_model.py), half-life 240
             days, ridge 5, home field 2 points, margin spread 13.5 and total
             spread 13. Tuned on 9/25-11/30/2025, judged on 199 later games
             it never saw: win log loss 0.648 against 0.698 for the home-team
             base rate, margin error 9.98 points, total error 10.90 against
             11.71 for the league average.
             Onyx price backtest (tools/sports_backtest.py, 440 games and
             14,032 player lines, 2025 tune / 2026 test, opening prices):
             moneyline blend log loss 0.6549 vs Onyx 0.6577 (103 games), but
             spreads (0.6949 vs 0.6936) and totals (0.6920 vs 0.6903) lose to
             Onyx's own price and no lane made money on the tune window. Props:
             the projections alone lose to Onyx's line in every market even
             with their spread widened to the best fit (2x for yards, 1.6x
             for receptions; passing 0.707 vs 0.693, receiving 0.702 vs
             0.693), so the projections carry no edge over the line yet. Prop
             spreads are widened to that fit so the page's chances are honest.
             NFL stays leans only.

  v0  10/26  Passing, rushing and receiving yards and receptions per player.
             proj = shrink(recency-weighted this-season mean, toward last
             season's mean) x opponent factor. Tuned on 2025 (weeks 4-18),
             tested out of sample on 2026 weeks 3+ against two baselines a
             bettor would use: the season-to-date average and the last-3
             average. Grid tune (decay x prior weight x opponent weight) chose
             decay .95, prior 1.5 games, opponent .5. Out of sample (2026,
             MAE improvement vs season avg / vs last 3):
               passing yards   +5.8% / +9.8%   (138 player-games)
               receiving yds   +5.7% / +8.6%   (617)
               receptions      +5.3% / +8.2%   (617)
               rushing yards   +1.9% / +2.5%   (211)
             Most of the gain is last season as the prior: 2025 itself had no
             2024 data, and there the model only matches the season average.
             The test re-runs on every build (test()) and the page shows it.
             Not a pick model yet: no Onyx price backtest, no injury feed, so
             the page shows leans, never tracked picks.

Inputs: data/nfl/player_games.json rows from sports_espn.py (one per
player-game: pass_yds, rush_yds, rec_yds, rec, tgt, att, rush_att...).
"""

from collections import defaultdict

VERSION = "v2"
# game lines (team_model.py), tuned 10/26: see v1
GAME_P = {"half_life": 240, "ridge": 5, "home": 2.0, "sd_margin": 13.5, "sd_total": 13.0, "min_games": 3}
GAME_TEST = {"n": 199, "logloss": 0.648, "base_logloss": 0.698, "mae_total": 10.90, "base_mae_total": 11.71,
             "window": "12/1/2025 on"}
STATS = ("pass_yds", "rush_yds", "rec_yds", "rec")
# who counts as having a role in a stat (per-game volume in the window used)
ROLE = {"pass_yds": ("att", 15), "rush_yds": ("rush_att", 6), "rec_yds": ("tgt", 3), "rec": ("tgt", 3)}
# tuned on 2025 weeks 4-18 (tune()); see the changelog for the test
P = {"decay": 0.95, "k_prior": 1.5, "opp_w": 0.5, "opp_k": 4.0}


# spread of the outcome around the projection, fitted 10/26 on 2025 weeks
# 4-18 residuals by projection quartile: yards ~ Normal(proj, a + b * proj),
# receptions ~ negative binomial with variance 1.25 x mean
# v1: widened to the spread that fits real Onyx lines best (2x yards, 1.6x
# receptions sd): narrower, the model was confidently wrong against the line
PROP_SD = {"pass_yds": (160.0, 0.0), "rush_yds": (40.0, 0.54), "rec_yds": (30.0, 0.66)}
REC_VAR = 3.2


def prob_over(s, proj, line):
    import sports_lab as L
    if s == "rec":
        return L.count_over(proj, line, REC_VAR * proj)
    a, b = PROP_SD[s]
    return L.normal_over(proj, a + b * proj, line)


def _games_by_player(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["pid"]].append(r)
    for v in by.values():
        v.sort(key=lambda r: (r["season"], r["week"]))
    return by


def _team_allowed(rows):
    """Per (season, week, defense team): yards allowed by stat, from the
    offense rows of that game."""
    out = defaultdict(lambda: defaultdict(float))
    for r in rows:
        k = (r["season"], r["week"], r["opp"])
        for s in STATS:
            out[k][s] += r.get(s) or 0.0
    return out


def _opp_factor(allowed, season, week, opp, s, p, lg_cache):
    """How much of stat s this defense allows vs league average, from its
    games before `week`, regressed with opp_k pseudo-games."""
    vals = [allowed[(season, w, opp)][s] for w in range(1, week) if (season, w, opp) in allowed]
    if not vals:
        return 1.0
    key = (season, week, s)
    if key not in lg_cache:
        pool = [d[s] for (se, w, _t), d in allowed.items() if se == season and w < week]
        lg_cache[key] = (sum(pool) / len(pool)) if pool else None
    lg = lg_cache[key]
    if not lg:
        return 1.0
    n = len(vals)
    ratio = (sum(vals) / n) / lg
    return 1 + p["opp_w"] * (ratio - 1) * n / (n + p["opp_k"])


def project(hist, s, season, week, opp, allowed, p=None, lg_cache=None):
    """Projection for stat s in (season, week) from the player's games
    strictly before it. Returns (proj, info) or (None, None) without a role."""
    p = p or P
    lg_cache = {} if lg_cache is None else lg_cache
    cur = [g for g in hist if g["season"] == season and g["week"] < week]
    prev = [g for g in hist if g["season"] == season - 1]
    rk, rmin = ROLE[s]
    recent = cur[-4:] or prev[-4:]
    if not recent or sum(g.get(rk) or 0 for g in recent) / len(recent) < rmin:
        return None, None
    w = [p["decay"] ** i for i in range(len(cur))][::-1]
    m_cur = sum((g.get(s) or 0) * wi for g, wi in zip(cur, w)) / sum(w) if cur else None
    n_eff = sum(w)
    prior = (sum(g.get(s) or 0 for g in prev) / len(prev)) if len(prev) >= 4 else None
    if m_cur is None and prior is None:
        return None, None
    if m_cur is None:
        base = prior
    elif prior is None:
        base = m_cur
    else:
        base = (n_eff * m_cur + p["k_prior"] * prior) / (n_eff + p["k_prior"])
    f = _opp_factor(allowed, season, week, opp, s, p, lg_cache) if opp else 1.0
    return base * f, {"season": m_cur, "prior": prior, "opp": f, "l3": [g.get(s) or 0 for g in cur[-3:]]}


def _eval(rows, seasons, weeks_from, p):
    """Mean absolute error of the projection vs the two baselines, on every
    player-game with a role in the stat (season-to-date mean needs 2 games)."""
    by = _games_by_player(rows)
    allowed = _team_allowed(rows)
    lgc = {}
    err = {s: {"m": [], "avg": [], "l3": []} for s in STATS}
    for pid, gs in by.items():
        for i, g in enumerate(gs):
            if g["season"] not in seasons or g["week"] < weeks_from:
                continue
            prior_games = gs[:i]
            cur = [x for x in prior_games if x["season"] == g["season"]]
            if len(cur) < 2:
                continue
            for s in STATS:
                pr, _ = project(prior_games, s, g["season"], g["week"], g["opp"], allowed, p, lgc)
                if pr is None:
                    continue
                act = g.get(s) or 0
                avg = sum(x.get(s) or 0 for x in cur) / len(cur)
                l3 = cur[-3:]
                l3m = sum(x.get(s) or 0 for x in l3) / len(l3)
                err[s]["m"].append(abs(pr - act)); err[s]["avg"].append(abs(avg - act)); err[s]["l3"].append(abs(l3m - act))
    out = {}
    for s, e in err.items():
        n = len(e["m"])
        if n:
            out[s] = {"n": n, "mae": sum(e["m"]) / n, "avg": sum(e["avg"]) / n, "l3": sum(e["l3"]) / n}
    return out


def tune(rows, season):
    best = None
    for decay in (0.75, 0.85, 0.95):
        for kp in (1.5, 3.0, 5.0):
            for ow in (0.0, 0.5, 1.0):
                p = {"decay": decay, "k_prior": kp, "opp_w": ow, "opp_k": 4.0}
                r = _eval(rows, {season}, 4, p)
                score = sum(v["mae"] / v["avg"] for v in r.values()) / max(1, len(r))
                if best is None or score < best[0]:
                    best = (score, p)
    return best


def test(rows, season):
    """Out-of-sample: this season, weeks 3+, with the shipped parameters."""
    return _eval(rows, {season}, 3, P)


# ── touchdown scorers (v2) ────────────────────────────────────────────
TD_P = {"c": 0.8, "w_rush": 0.8, "w_tgt": 1.0, "w_hist": 0.3, "k": 4.0, "n_games": 8, "other": 0.055}


def td_lambdas(rows, players, implied, p=TD_P):
    """Expected TDs for each player tonight. rows: every player-game so far;
    players: [(pid, team)] who suit up; implied: {team: Onyx implied points}."""
    by_game = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))   # gid -> team -> [opportunities, TDs]
    for r in rows:
        t = by_game[r["gid"]][r["team"]]
        t[0] += (r.get("rush_att") or 0) + (r.get("tgt") or 0)
        t[1] += (r.get("rush_td") or 0) + (r.get("rec_td") or 0)
    hist = defaultdict(list)
    for r in sorted(rows, key=lambda r: r["date"]):
        hist[r["pid"]].append(r)
    out = {}
    for pid, team in players:
        h = hist.get(pid, [])[-p["n_games"]:]
        imp = implied.get(team)
        if len(h) < 2 or not imp:
            continue
        opps = sum(by_game[x["gid"]][x["team"]][0] for x in h) or 1.0
        tds_team = sum(by_game[x["gid"]][x["team"]][1] for x in h)
        u = (p["w_rush"] * sum(x.get("rush_att") or 0 for x in h) + p["w_tgt"] * sum(x.get("tgt") or 0 for x in h)) / opps
        own = sum((x.get("rush_td") or 0) + (x.get("rec_td") or 0) for x in h)
        hs = (own + p["k"] * u) / (tds_team + p["k"])
        out[pid] = p["c"] * imp / 7.0 * ((1 - p["w_hist"]) * u + p["w_hist"] * hs)
    return out


def td_probs(lams_by_game, p=TD_P):
    """{gid: {pid: lambda}} -> {pid: (anytime, first)}."""
    import math
    out = {}
    for gid, lams in lams_by_game.items():
        z = sum(lams.values())
        for pid, l in lams.items():
            out[pid] = (1 - math.exp(-l), (1 - p["other"]) * l / z if z > 0 else 0.0)
    return out
