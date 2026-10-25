"""
nba_model.py - Onyx NBA points / rebounds / assists projection model.

CHANGELOG (the lab notebook: every change bumps VERSION and cites evidence)
  v3 (2026-10-25) ROLE CHECK + usage / utilization / pace / net rating /
     plus-minus tracked. Same walk-forward replay as v2 (2025-26, tuned
     Oct-Jan, judged Feb-Apr), with OUT teammates simulated (3 of the team's
     last 5 games at 15+ min, absent tonight).
     - Role check (role_gap): when |projection - line| exceeds 1.5 sd of the
       stat, the model's side won 47.4% (train, n=38) and 50.0% (test, n=10)
       and its MAE was ~2x the line's. Those props are kept off the picks
       lane (nba_build.PICK_MAX_GAP). Picks lane, test window: open 74-63
       (+5.6%) -> 75-60 (+8.4%); close 53-48 (+3.3%) -> 53-47 (+4.3%).
       Train: open +24.6% -> +26.7%.
     - Tested as weights and NOT applied (P values stay neutral). Test-window
       objective (MAE / mean, all projected players), v2 = 0.4722:
         usage redistribution alpha 0.3   0.4730 (worse; train worse too: the
                                          240-minute fit already re-homes an
                                          OUT player's minutes)
         starter pull start_w 0.3 / 0.6   0.4721 / 0.4730 (train tie / worse)
         pace_mix 0.25                    0.4722 (no change)
         recent minutes 15% over 5 games  0.4764 (worse)
         prior 4 games                    0.4721 (train worse)
         plus-minus pm_k                  no plus-minus in the 2025-26 pull
                                          yet; re-test once rows carry it
       A full joint retune scored train 0.3981 vs 0.3989 but test pts MAE
       5.15 -> 5.17 and test picks 74-63 -> 47-47: overfit, rejected.
     - Data: box rows now carry fga / fta / tov / plus-minus (rows 10-13)
       and priors carry fga / fta / tov, so usage rate (FGA + 0.44 FTA + TOV
       per minute) and utilization (projected minutes / 48) are reported per
       player; team pace and ORtg / DRtg / net per 100 feed the no-line game
       script and the Model tab.
  v2 (2026-10-24) BACKTESTED. tools/nba_backtest.py replays the 2025-26
     regular season walk-forward (2024-25 as prior, no look-ahead), 26,352
     player-games, with OpticOdds box scores and the historical Onyx main
     lines (17,668 props, open + close). Tuned on Oct-Jan, judged on Feb-Apr
     only (the tuner never saw it). Test-window results, players projected
     20+ min:
       projection MAE      v1 -> v2: pts 5.21 -> 5.15, reb 2.03 -> 1.99,
                           ast 1.59 -> 1.57 (season-average baseline 5.48 /
                           2.05 / 1.63; last-10 baseline 5.38 / 2.07 / 1.63)
       bias                pts +0.42 -> -0.16, reb +0.24 -> -0.08
       v1 picks lane       131-128, -3.4% ROI at Onyx closing prices,
                           claimed 59.8% vs hit 50.6%: overconfident
       v2 picks lane       74-63 (+5.6%) at Onyx opening prices, 53-48 (+3.3%)
                           at closing; claimed 54.2% vs hit 54.0% (open).
                           n is ~100-140: calibrated, profit NOT yet proven.
     Changes, each chosen on the train window:
     - final per-stat scale pts 0.96 / reb 0.94 / ast 0.96 (v1 ran high)
     - minutes prior 2 games (was 4); back-to-back 0.95 (was 0.97);
       opponent-allowed exponent 0.75 (was 0.5); home points +/-2% (was 1%)
     - probability: negative binomial (right-skewed) replaces the normal,
       sd = a*mean + b fitted on train residuals: pts (0.181, 3.732),
       reb (0.257, 1.304), ast (0.299, 0.947). The normal put P(over)
       5-9pp too high in every middle bucket.
     - market blend 20% model / 80% Onyx no-vig (was 50/50): best train
       logloss; test logloss 0.6893 vs Onyx alone 0.6898 vs model alone
       0.7179. The Onyx closing line itself has MAE 3.05 vs our projection
       3.12 on the same props: the market is the sharper single read, the
       model adds a little on top.
     Recency decay on minutes / rates, pace exponent and the L5 nudge were
     tested and left as they were (no train gain).
  v1 (2026-10-24) initial model, no graded evidence yet. Structure:
     projection = expected minutes x per-minute rate x game environment.
     - Minutes: last season's MPG as a 4-game prior (2 if the player changed
       teams), this season's games (DNPs count as 0) pull it toward current
       usage, then 30% weight on the last 3 games once there are 3. Team
       minutes are rescaled to 240 so minutes freed by OUT/DOUBTFUL
       teammates flow to who is left (scale clamped 0.80-1.25).
       Back-to-back and blowout-spread haircuts for heavy-minute players.
     - Rates: last season's per-minute rate as a 300-minute prior, blended
       with this season's actual minutes; players with no prior shrink to a
       positional league rate (150-minute prior). L5 form nudge capped at 15%.
     - Environment: points scale with the team total implied by the spread
       and game total (exponent 0.85); rebounds and assists scale with game
       pace (total vs league) and what the opponent allows, regressed by
       games played (n/(n+10)), square-rooted.
     - Probability: normal approximation with per-stat spread
       (pts 0.30*mean+2.0, reb 0.35*mean+1.0, ast 0.40*mean+0.8), discrete
       correction for whole-number lines (push mass removed), then blended
       50/50 with the vig-stripped market (first live slate, 10/24: at 60/40
       64 of 236 Onyx props showed >4pp edge, far more than a sharp market
       leaves; the MLB studies found the market the better-calibrated side). Edge is measured vs the LISTED
       price, the price a user actually gets.
     Open items once graded rows exist: calibrate the 60/40 blend and the
     spread constants by bucket, as the MLB side did with its studies.
"""

import math

VERSION = "v3"

LEAGUE = {"ppg": 115.0, "reb": 44.0, "ast": 27.0, "poss": 99.5}
POS_RATE = {   # per-minute league rates by listed position, used only without a prior
    "G": {"pts": 0.46, "reb": 0.14, "ast": 0.17},
    "F": {"pts": 0.44, "reb": 0.21, "ast": 0.09},
    "C": {"pts": 0.45, "reb": 0.30, "ast": 0.08},
}
PRIOR_GAMES_K = 2
RATE_PRIOR_MIN = 300.0
POS_PRIOR_MIN = 150.0
SD = {"pts": (0.181, 3.732), "reb": (0.257, 1.304), "ast": (0.299, 0.947)}   # v2: fitted, see changelog
MODEL_WEIGHT = 0.20                 # v2: 20% model / 80% Onyx no-vig
# Tunables (nba_backtest.py walks these). Values here are the live model's.
P = {
    "min_recent_w": 0.30,    # weight on the last-N-games minutes average
    "min_recent_n": 3,
    "min_decay": 1.0,        # per-game weight decay for this season's minutes (1.0 = flat mean)
    "rate_decay": 1.0,       # per-game weight decay for this season's per-minute rates
    "l5_nudge": 0.25,        # share of the L5 rate gap applied
    "l5_cap": 0.15,
    "b2b_mult": 0.95,
    "pace_exp": 0.5,
    "opp_exp": 0.75,
    "pts_fit_exp": 0.8,      # how hard team points are pulled to the target total
    "home_pts": 0.02,
    "blowout_k": 0.004,
    "scale_pts": 0.96,        # final per-stat scale (bias correction from the backtest)
    "scale_reb": 0.94,
    "scale_ast": 0.96,
    # usage redistribution (teammates OUT): share of the missing usage that
    # is re-absorbed, how strongly it tilts to high-usage players, and how a
    # usage bump converts into per-minute points / assists / rebounds
    "pace_mix": 0.0,         # share of matchup possessions vs the posted total in the pace read
    "home_court": 1.5,       # points of home edge in the no-line margin
    "start_w": 0.0,          # utilization: pull toward starter minutes after 2 of the last 3 starts
    "pm_k": 0.0,             # minutes nudge per +10 plus-minus per 36 (recent)
    "usg_alpha": 0.0,
    "usg_gamma": 1.0,
    "usg_beta_pts": 0.8,
    "usg_beta_ast": 0.5,
    "usg_beta_reb": 0.0,
}
OUT_STATUSES = {"OUT", "DOUBTFUL", "O", "D", "SUSPENSION"}
RISK_STATUSES = {"QUESTIONABLE", "GTD", "Q", "DAY-TO-DAY", "DTD"}
STATS = ("pts", "reb", "ast")
IDX = {"min": 4, "pts": 5, "reb": 6, "ast": 7, "fga": 10, "fta": 11, "tov": 12}
# league plays used (FGA + 0.44 FTA + TOV) per team game; a player's USG% is
# his plays-used per minute over the team's per-player-minute share of these
LEAGUE_TEAM_PLAYS = 112.0
USE_PRIOR_MIN = 300.0


def _pos_key(pos):
    p = (pos or "").upper()
    if "C" in p:
        return "C"
    if "F" in p:
        return "F"
    return "G"


def league_from_teams(team_games):
    """League per-team averages this season, shrunk to the static baseline
    until the sample is meaningful (~60 team-games)."""
    rows = [r for t, rs in team_games.items() for r in rs]
    n = len(rows)
    if not n:
        return dict(LEAGUE)
    w = n / (n + 60.0)
    out = {}
    for k, col in (("ppg", "pts"), ("reb", "reb"), ("ast", "ast"), ("poss", "poss")):
        avg = sum(r.get(col, 0) for r in rows) / n
        out[k] = round(w * avg + (1 - w) * LEAGUE[k], 2)
    return out


def team_profile(team_games, team, lg):
    """Regressed scoring for the team and what its opponents get against it."""
    rows = team_games.get(team, [])
    n = len(rows)
    w = n / (n + 10.0)
    def avg(col, base):
        return (w * (sum(r.get(col, 0) for r in rows) / n) + (1 - w) * base) if n else base
    out = {
        "n": n,
        "ppg": avg("pts", lg["ppg"]), "opp_ppg": avg("opp_pts", lg["ppg"]),
        "opp_reb": avg("opp_reb", lg["reb"]), "opp_ast": avg("opp_ast", lg["ast"]),
        "poss": avg("poss", lg["poss"]),
        "dates": {r["d"] for r in rows},
    }
    # ratings per 100 possessions (regressed the same way): offense, defense, net
    out["ortg"] = 100.0 * out["ppg"] / out["poss"]
    out["drtg"] = 100.0 * out["opp_ppg"] / out["poss"]
    out["net"] = out["ortg"] - out["drtg"]
    return out


def base_minutes(prior, games, team, team_gp=0):
    """Expected minutes before team rescaling. games = this season's rows
    (DNPs included as 0). team_gp = games the team has played this season."""
    prior_mpg = (prior["min"] / prior["gp"]) if prior and prior.get("gp") else None
    mins = [g[IDX["min"]] for g in games]
    n = len(mins)
    if n == 0 and team_gp >= 2:
        # not even listed in a box score this season: inactive, two-way or
        # just back from injury. Small stake until he actually plays.
        return min(6.0, prior_mpg or 0.0)
    if prior_mpg is not None:
        k = PRIOR_GAMES_K if (not prior.get("t") or prior.get("t") == team) else PRIOR_GAMES_K / 2
        w = [P["min_decay"] ** (n - 1 - i) for i in range(n)]
        base = (prior_mpg * k + sum(wi * m for wi, m in zip(w, mins))) / (k + sum(w))
    elif n:
        w = [P["min_decay"] ** (n - 1 - i) for i in range(n)]
        base = sum(wi * m for wi, m in zip(w, mins)) / sum(w)
    else:
        base = 4.0
    # utilization: a new starter's role shows up in the starter flag before
    # it shows up in a season average
    if n >= 3 and P["start_w"] > 0:
        last3 = games[-3:]
        starts = [g for g in last3 if len(g) > 9 and g[9]]
        if len(starts) >= 2:
            smin = sum(g[IDX["min"]] for g in starts) / len(starts)
            if smin > base:
                base = (1 - P["start_w"]) * base + P["start_w"] * smin
    if n >= 3:
        k_n = int(P["min_recent_n"])
        base = (1 - P["min_recent_w"]) * base + P["min_recent_w"] * (sum(mins[-k_n:]) / len(mins[-k_n:]))
    # plus-minus: recent on-court results nudge minutes (coaches play winners)
    pm_games = [g for g in games[-10:] if len(g) > 13 and g[13] is not None and g[IDX["min"]] > 0]
    pm_min = sum(g[IDX["min"]] for g in pm_games)
    if P["pm_k"] and pm_min >= 60:
        pm36 = 36.0 * sum(g[13] for g in pm_games) / pm_min
        base *= 1 + P["pm_k"] * max(-1.5, min(1.5, pm36 / 10.0))
    return base


def fit_team_minutes(mins, total=240.0):
    """Rescale one team's expected minutes to the 240 available.
    Over 240 (deep benches over-counted): trim the deep bench first, starters
    only if that is not enough. Under 240 (teammates out): hand the freed
    minutes to the rotation (15+ min) in proportion, capped at 40."""
    m = list(mins)
    tot = sum(m)
    if tot <= 0:
        return m
    if tot > total:
        excess = tot - total
        for lo, hi in ((0, 15), (15, 26), (26, 99)):
            band = [i for i, x in enumerate(m) if lo <= x < hi]
            avail = sum(m[i] for i in band) * (0.6 if hi < 99 else 1.0)
            if avail <= 0:
                continue
            cut = min(excess, avail)
            band_sum = sum(m[i] for i in band)
            for i in band:
                m[i] -= cut * m[i] / band_sum
            excess -= cut
            if excess <= 0.01:
                break
    else:
        for _ in range(3):
            short = total - sum(m)
            rot = [i for i, x in enumerate(m) if 15 <= x < 40]
            if short <= 0.5 or not rot:
                break
            rs = sum(m[i] for i in rot)
            for i in rot:
                m[i] = min(40.0, m[i] + short * m[i] / rs)
    return m


def usage_per_min(prior, games):
    """Plays used (FGA + 0.44 FTA + TOV) per minute: last season as a
    300-minute prior, this season's box scores on top. None without data."""
    played = [g for g in games if g[IDX["min"]] > 0 and len(g) > IDX["tov"]]
    cur_min = sum(g[IDX["min"]] for g in played)
    cur_use = sum(g[IDX["fga"]] + 0.44 * g[IDX["fta"]] + g[IDX["tov"]] for g in played)
    if prior and prior.get("min", 0) > 0 and prior.get("fga") is not None:
        r0 = (prior["fga"] + 0.44 * prior.get("fta", 0) + prior.get("tov", 0)) / prior["min"]
        k = USE_PRIOR_MIN
    elif cur_min >= 30:
        return cur_use / cur_min
    else:
        return None
    return (r0 * k + cur_use) / (k + cur_min)


def usg_pct(u):
    return round(100.0 * u * 48.0 / LEAGUE_TEAM_PLAYS, 1) if u else None


def per_minute(prior, games, stat, pos):
    played = [g for g in games if g[IDX["min"]] > 0]
    n = len(played)
    w = [P["rate_decay"] ** (n - 1 - i) for i in range(n)]
    cur_min = sum(wi * g[IDX["min"]] for wi, g in zip(w, played))
    cur_s = sum(wi * g[IDX[stat]] for wi, g in zip(w, played))
    if prior and prior.get("min", 0) > 0:
        r0, k = prior[stat] / prior["min"], RATE_PRIOR_MIN
    else:
        r0, k = POS_RATE[_pos_key(pos)][stat], POS_PRIOR_MIN
    rate = (r0 * k + cur_s) / (k + cur_min)
    last5 = played[-5:]
    l5_min = sum(g[IDX["min"]] for g in last5)
    if l5_min >= 60:
        l5 = sum(g[IDX[stat]] for g in last5) / l5_min
        nudge = max(-P["l5_cap"], min(P["l5_cap"], (l5 / rate - 1) * P["l5_nudge"])) if rate > 0 else 0
        rate *= 1 + nudge
    return rate


def env_factors(game, team, opp, is_home, tp, op, lg):
    """Multipliers for reb/ast from pace and the opponent, plus the team
    points target the player points are normalized to (pts multiplier 1.0
    apart from home/away)."""
    total, spread = game.get("total"), game.get("spread")
    f = {}
    # matchup pace: expected possessions = team pace x opponent pace / league
    # pace (a fast team facing a slow one lands in between)
    game_poss = tp["poss"] * op["poss"] / lg["poss"]
    pace_poss = game_poss / lg["poss"]
    if total and spread is not None:
        home_imp = (total - spread) / 2.0
        implied = home_imp if is_home else total - home_imp
        target = implied
        pace_raw = (1 - P["pace_mix"]) * (total / (2 * lg["ppg"])) + P["pace_mix"] * pace_poss
    else:
        implied = None
        # no line: the team's scoring vs what this opponent allows, both regressed
        target = (tp["ppg"] * op["opp_ppg"]) / lg["ppg"]
        pace_raw = pace_poss
    pace = pace_raw ** P["pace_exp"]
    f["game_poss"] = round(game_poss, 1)
    f["pts"] = 1 + P["home_pts"] if is_home else 1 - P["home_pts"]
    f["reb"] = pace * (op["opp_reb"] / lg["reb"]) ** P["opp_exp"]
    f["ast"] = pace * (op["opp_ast"] / lg["ast"]) ** P["opp_exp"]
    for k in ("reb", "ast"):
        f[k] = max(0.88, min(1.12, f[k]))
    f["implied"] = round(implied, 1) if implied else None
    f["target_pts"] = round(target, 1)
    # expected margin for game script: the spread when posted, else net
    # ratings over the expected possessions plus home court
    if spread is not None:
        f["margin"] = (-spread if is_home else spread)
    else:
        net_diff = (tp["net"] - op["net"]) * game_poss / 100.0
        f["margin"] = net_diff + (P["home_court"] if is_home else -P["home_court"])
    return f


def _phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _nb_cdf(k, mean, var):
    """P(X <= k) for a negative binomial with this mean and variance
    (Poisson when the variance does not exceed the mean)."""
    if k < 0:
        return 0.0
    mean = max(mean, 0.05)
    if var <= mean * 1.0001:
        term = math.exp(-mean)
        tot = term
        for i in range(1, int(k) + 1):
            term *= mean / i
            tot += term
        return min(1.0, tot)
    r = mean * mean / (var - mean)
    q = mean / (r + mean)              # success prob of the "count" side
    term = (1 - q) ** r                # P(X = 0)
    tot = term
    for i in range(1, int(k) + 1):
        term *= (r + i - 1) / i * q
        tot += term
    return min(1.0, tot)


def prob_over(mean, line, stat):
    """P(over), P(push) for a prop line.

    v2: negative binomial with sd = a*mean + b (SD, fitted on the 2025-26
    backtest). Stat lines are right-skewed (the median night sits below the
    average), which a symmetric normal ignores: in the backtest it put P(over)
    5-9pp too high in every middle bucket."""
    a, b = SD[stat]
    sd = max(0.8, a * mean + b)
    var = sd * sd
    if abs(line - round(line)) < 1e-9:   # whole number: a push is possible
        k = int(round(line))
        p_le_minus = _nb_cdf(k - 1, mean, var)
        p_le = _nb_cdf(k, mean, var)
        return 1 - p_le, p_le - p_le_minus
    return 1 - _nb_cdf(math.floor(line), mean, var), 0.0


def role_gap(mean, line, stat):
    """How far the projection sits from the line, in standard deviations of
    the stat. A big gap almost never means the book is asleep: it means the
    model and the market disagree about the player's ROLE (minutes, a return
    from injury, a new starter), which box-score history cannot see."""
    a, b = SD[stat]
    return abs(mean - line) / max(0.8, a * line + b)


def implied(american):
    try:
        a = float(american)
    except (TypeError, ValueError):
        return None
    return 100.0 / (a + 100.0) if a > 0 else -a / (-a + 100.0)


def price_side(mean, stat, mkt):
    """Price both sides of one prop. mkt = {line, over, under}. Returns the
    better side with model, blended and market probabilities and edge."""
    line = mkt.get("line")
    if line is None:
        return None
    p_over, p_push = prob_over(mean, float(line), stat)
    p_under = max(0.0, 1 - p_over - p_push)
    io, iu = implied(mkt.get("over")), implied(mkt.get("under"))
    if io and iu:
        nv_over = io / (io + iu)
    elif io:
        nv_over = min(0.97, io * 0.955)
    elif iu:
        nv_over = 1 - min(0.97, iu * 0.955)
    else:
        nv_over = None
    sides = []
    for side, pm, imp, price in (("over", p_over, io, mkt.get("over")),
                                 ("under", p_under, iu, mkt.get("under"))):
        if imp is None:
            continue
        nv = nv_over if side == "over" else (1 - nv_over if nv_over is not None else None)
        live = 1 - p_push
        pm_cond = pm / live if live > 0 else pm
        pb = MODEL_WEIGHT * pm_cond + (1 - MODEL_WEIGHT) * nv if nv is not None else pm_cond
        dec = 1 + (price / 100.0 if price > 0 else 100.0 / -price)
        sides.append({
            "side": side, "price": int(price), "model_p": round(pm_cond, 4),
            "market_p": round(nv, 4) if nv is not None else None,
            "prob": round(pb, 4), "implied": round(imp, 4),
            "edge": round(pb - imp, 4), "ev": round(pb * dec - 1, 4),
        })
    if not sides:
        return None
    best = max(sides, key=lambda s: s["edge"])
    best["line"] = float(line)
    best["src"] = mkt.get("src", "")
    best["all"] = {s["side"]: {"price": s["price"], "prob": s["prob"], "edge": s["edge"]} for s in sides}
    return best


def project_slate(slate, prior, player_games, team_games):
    """One projection row per rostered player on today's slate."""
    lg = league_from_teams(team_games)
    games = {g["gid"]: g for g in slate.get("games", [])}
    profiles = {}
    def prof(t):
        if t not in profiles:
            profiles[t] = team_profile(team_games, t, lg)
        return profiles[t]
    from datetime import date, timedelta
    yday = (date.fromisoformat(slate["date"]) - timedelta(days=1)).isoformat()

    rows = []
    for p in slate.get("players", []):
        g = games.get(p["gid"])
        if not g:
            continue
        pr = prior.get(p["pid"])
        if pr and not pr.get("gp"):
            pr = None   # cached "no last-season games" (rookies): no prior
        pg = (player_games.get(p["pid"]) or {}).get("g", [])
        status = (p.get("inj") or "").upper()
        out = status in OUT_STATUSES
        rows.append({
            "pid": p["pid"], "name": p["name"], "team": p["team"], "opp": p["opp"],
            "home": p["home"], "gid": p["gid"], "pos": p.get("pos", ""),
            "inj": status, "inj_detail": p.get("inj_detail", ""), "out": out,
            "_prior": pr, "_games": pg,
            "min_full": base_minutes(pr, pg, p["team"], len(team_games.get(p["team"], []))),
            "upm": usage_per_min(pr, pg),
            "gp": len([x for x in pg if x[IDX["min"]] > 0]),
            "prior_gp": (pr or {}).get("gp", 0),
        })

    # team minutes rescale: 240 available, freed minutes flow to who is left
    by_team = {}
    for r in rows:
        by_team.setdefault((r["gid"], r["team"]), []).append(r)
    for r in rows:
        r["min_base"] = 0.0 if r["out"] else r["min_full"]
    for (gid, team), rs in by_team.items():
        fitted = fit_team_minutes([r["min_base"] for r in rs])
        g = games[gid]
        b2b = yday in prof(team)["dates"]
        if g.get("spread") is not None:
            spread = abs(g["spread"])
        else:   # no line: game script from net ratings over the expected possessions
            op_t = g["home"] if team == g["away"] else g["away"]
            tp_, op_ = prof(team), prof(op_t)
            gp_ = tp_["poss"] * op_["poss"] / lg["poss"]
            spread = abs((tp_["net"] - op_["net"]) * gp_ / 100.0 + (P["home_court"] if team == g["home"] else -P["home_court"]))
        for r, m in zip(rs, fitted):
            if b2b and m >= 30:
                m *= P["b2b_mult"]
            if spread >= 10 and m >= 28:
                m *= max(0.94, 1 - P["blowout_k"] * (spread - 8))
            r["min"] = round(m, 1)
            r["b2b"] = b2b
        # usage redistribution: the plays an OUT teammate would have used are
        # re-absorbed by who is left, tilted toward high-usage players
        # (share ~ upm^(1+gamma) x minutes); a usage bump lifts per-minute
        # points / assists by (boost)^beta, efficiency slipping as it rises
        lost = sum((r["upm"] or 0) * min(r["min_full"], 36.0) for r in rs if r["out"])
        avail = [r for r in rs if not r["out"] and r["upm"] and r["min"] > 0]
        wsum = sum(r["upm"] ** (1 + P["usg_gamma"]) * r["min"] for r in avail)
        for r in rs:
            r["usg"] = usg_pct(r["upm"])
            r["usg_boost"] = 1.0
        if lost > 0 and wsum > 0 and P["usg_alpha"] > 0:
            for r in avail:
                extra = P["usg_alpha"] * lost * (r["upm"] ** (1 + P["usg_gamma"]) * r["min"]) / wsum
                r["usg_boost"] = round(min(1.35, 1 + extra / r["min"] / r["upm"]), 4)
        for r in rs:
            r["usg_adj"] = usg_pct((r["upm"] or 0) * r["usg_boost"]) if r["upm"] else None

    for r in rows:
        g = games[r["gid"]]
        tp, op = prof(r["team"]), prof(r["opp"])
        f = env_factors(g, r["team"], r["opp"], r["home"], tp, op, lg)
        r["team_implied"] = f.pop("implied")
        r["game_poss"] = f.pop("game_poss")
        r["margin"] = round(f.pop("margin"), 1)
        r["team_pace"] = round(tp["poss"], 1)
        r["opp_pace"] = round(op["poss"], 1)
        r["team_net"] = round(tp["net"], 1)
        r["opp_net"] = round(op["net"], 1)
        tgt = f.pop("target_pts")
        r["env"] = {k: round(v, 3) for k, v in f.items()}
        f["target_pts"] = tgt
        proj = {}
        for s in STATS:
            rate = per_minute(r["_prior"], r["_games"], s, r["pos"])
            rate *= r["usg_boost"] ** P["usg_beta_" + s]
            proj[s] = round(r["min"] * rate * f[s], 2) if not r["out"] else 0.0
        r["proj"] = proj
        r["_target_pts"] = f.get("target_pts")
        played = [x for x in r["_games"] if x[IDX["min"]] > 0]
        r["season"] = {s: round(sum(x[IDX[s]] for x in played) / len(played), 1)
                       for s in ("min",) + STATS} if played else None
        if played:
            pmv = [x[13] for x in played if len(x) > 13 and x[13] is not None]
            r["season"]["pm"] = round(sum(pmv) / len(pmv), 1) if pmv else None
            r["season"]["starts"] = sum(1 for x in played if len(x) > 9 and x[9])
            r["season"]["gp"] = len(played)
        r["util"] = round(100.0 * r["min"] / 48.0, 1)
        r["last5"] = [{"d": x[0], "opp": x[2], "min": x[4], "pts": x[5], "reb": x[6], "ast": x[7]}
                      for x in r["_games"][-5:]]
        pr = r["_prior"]
        r["last_season"] = ({s: round(pr[s] / pr["gp"], 1) for s in STATS} |
                            {"min": round(pr["min"] / pr["gp"], 1), "gp": pr["gp"]}) if pr else None
        del r["_prior"], r["_games"], r["min_base"], r["min_full"], r["upm"]

    # a team's player points must add up to the team's expected score: pull
    # each team's sum toward the implied team total (exponent 0.8, partial
    # trust; clamped). This replaces a per-player environment multiplier,
    # which let every rotation inflate together (CLE summed to 138 against
    # a 120 implied on 10/24 in development).
    for (gid, team), rs in by_team.items():
        tgt = next((r["_target_pts"] for r in rs if r.get("_target_pts")), None)
        tot = sum(r["proj"]["pts"] for r in rs)
        if tgt and tot > 0:
            k = max(0.85, min(1.18, (tgt / tot) ** P["pts_fit_exp"]))
            for r in rs:
                r["proj"]["pts"] = round(r["proj"]["pts"] * k, 2)
        for r in rs:
            r.pop("_target_pts", None)
            for s in STATS:
                r["proj"][s] = round(r["proj"][s] * P["scale_" + s], 2)
    return rows, lg
