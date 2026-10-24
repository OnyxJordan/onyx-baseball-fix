"""
nba_model.py - Onyx NBA points / rebounds / assists projection model.

CHANGELOG (the lab notebook: every change bumps VERSION and cites evidence)
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
       60/40 with the vig-stripped market. Edge is measured vs the LISTED
       price, the price a user actually gets.
     Open items once graded rows exist: calibrate the 60/40 blend and the
     spread constants by bucket, as the MLB side did with its studies.
"""

import math

VERSION = "v1"

LEAGUE = {"ppg": 115.0, "reb": 44.0, "ast": 27.0, "poss": 99.5}
POS_RATE = {   # per-minute league rates by listed position, used only without a prior
    "G": {"pts": 0.46, "reb": 0.14, "ast": 0.17},
    "F": {"pts": 0.44, "reb": 0.21, "ast": 0.09},
    "C": {"pts": 0.45, "reb": 0.30, "ast": 0.08},
}
PRIOR_GAMES_K = 4
RATE_PRIOR_MIN = 300.0
POS_PRIOR_MIN = 150.0
SD = {"pts": (0.30, 2.0), "reb": (0.35, 1.0), "ast": (0.40, 0.8)}
MODEL_WEIGHT = 0.60
OUT_STATUSES = {"OUT", "DOUBTFUL", "O", "D", "SUSPENSION"}
RISK_STATUSES = {"QUESTIONABLE", "GTD", "Q", "DAY-TO-DAY", "DTD"}
STATS = ("pts", "reb", "ast")
IDX = {"min": 4, "pts": 5, "reb": 6, "ast": 7}


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
    return {
        "n": n,
        "ppg": avg("pts", lg["ppg"]), "opp_ppg": avg("opp_pts", lg["ppg"]),
        "opp_reb": avg("opp_reb", lg["reb"]), "opp_ast": avg("opp_ast", lg["ast"]),
        "poss": avg("poss", lg["poss"]),
        "dates": {r["d"] for r in rows},
    }


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
        base = (prior_mpg * k + sum(mins)) / (k + n)
    elif n:
        base = sum(mins) / n
    else:
        base = 4.0
    if n >= 3:
        base = 0.7 * base + 0.3 * (sum(mins[-3:]) / 3)
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


def per_minute(prior, games, stat, pos):
    played = [g for g in games if g[IDX["min"]] > 0]
    cur_min = sum(g[IDX["min"]] for g in played)
    cur_s = sum(g[IDX[stat]] for g in played)
    if prior and prior.get("min", 0) > 0:
        r0, k = prior[stat] / prior["min"], RATE_PRIOR_MIN
    else:
        r0, k = POS_RATE[_pos_key(pos)][stat], POS_PRIOR_MIN
    rate = (r0 * k + cur_s) / (k + cur_min)
    last5 = played[-5:]
    l5_min = sum(g[IDX["min"]] for g in last5)
    if l5_min >= 60:
        l5 = sum(g[IDX[stat]] for g in last5) / l5_min
        nudge = max(-0.15, min(0.15, (l5 / rate - 1) * 0.25)) if rate > 0 else 0
        rate *= 1 + nudge
    return rate


def env_factors(game, team, opp, is_home, tp, op, lg):
    """Multipliers for reb/ast from pace and the opponent, plus the team
    points target the player points are normalized to (pts multiplier 1.0
    apart from home/away)."""
    total, spread = game.get("total"), game.get("spread")
    f = {}
    if total and spread is not None:
        home_imp = (total - spread) / 2.0
        implied = home_imp if is_home else total - home_imp
        target = implied
        pace = (total / (2 * lg["ppg"])) ** 0.5
    else:
        implied = None
        # no line: the team's scoring vs what this opponent allows, both regressed
        target = (tp["ppg"] * op["opp_ppg"]) / lg["ppg"]
        pace = (((tp["poss"] + op["poss"]) / 2) / lg["poss"]) ** 0.5
    f["pts"] = 1.01 if is_home else 0.99
    f["reb"] = pace * (op["opp_reb"] / lg["reb"]) ** 0.5
    f["ast"] = pace * (op["opp_ast"] / lg["ast"]) ** 0.5
    for k in ("reb", "ast"):
        f[k] = max(0.88, min(1.12, f[k]))
    f["implied"] = round(implied, 1) if implied else None
    f["target_pts"] = round(target, 1)
    return f


def _phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def prob_over(mean, line, stat):
    """P(over), P(push) for a prop line under the normal approximation."""
    a, b = SD[stat]
    sd = max(0.8, a * mean + b)
    if abs(line - round(line)) < 1e-9:   # whole number: a push is possible
        p_over = 1 - _phi((line + 0.5 - mean) / sd)
        p_push = _phi((line + 0.5 - mean) / sd) - _phi((line - 0.5 - mean) / sd)
        return p_over, p_push
    return 1 - _phi((line - mean) / sd), 0.0


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
        pg = (player_games.get(p["pid"]) or {}).get("g", [])
        status = (p.get("inj") or "").upper()
        out = status in OUT_STATUSES
        rows.append({
            "pid": p["pid"], "name": p["name"], "team": p["team"], "opp": p["opp"],
            "home": p["home"], "gid": p["gid"], "pos": p.get("pos", ""),
            "inj": status, "inj_detail": p.get("inj_detail", ""), "out": out,
            "_prior": pr, "_games": pg,
            "min_base": 0.0 if out else base_minutes(
                pr, pg, p["team"], len(team_games.get(p["team"], []))),
            "gp": len([x for x in pg if x[IDX["min"]] > 0]),
            "prior_gp": (pr or {}).get("gp", 0),
        })

    # team minutes rescale: 240 available, freed minutes flow to who is left
    by_team = {}
    for r in rows:
        by_team.setdefault((r["gid"], r["team"]), []).append(r)
    for (gid, team), rs in by_team.items():
        fitted = fit_team_minutes([r["min_base"] for r in rs])
        g = games[gid]
        b2b = yday in prof(team)["dates"]
        spread = abs(g.get("spread") or 0)
        for r, m in zip(rs, fitted):
            if b2b and m >= 30:
                m *= 0.97
            if spread >= 10 and m >= 28:
                m *= max(0.94, 1 - 0.004 * (spread - 8))
            r["min"] = round(m, 1)
            r["b2b"] = b2b

    for r in rows:
        g = games[r["gid"]]
        tp, op = prof(r["team"]), prof(r["opp"])
        f = env_factors(g, r["team"], r["opp"], r["home"], tp, op, lg)
        r["team_implied"] = f.pop("implied")
        tgt = f.pop("target_pts")
        r["env"] = {k: round(v, 3) for k, v in f.items()}
        f["target_pts"] = tgt
        proj = {}
        for s in STATS:
            rate = per_minute(r["_prior"], r["_games"], s, r["pos"])
            proj[s] = round(r["min"] * rate * f[s], 2) if not r["out"] else 0.0
        r["proj"] = proj
        r["_target_pts"] = f.get("target_pts")
        played = [x for x in r["_games"] if x[IDX["min"]] > 0]
        r["season"] = {s: round(sum(x[IDX[s]] for x in played) / len(played), 1)
                       for s in ("min",) + STATS} if played else None
        r["last5"] = [{"d": x[0], "opp": x[2], "min": x[4], "pts": x[5], "reb": x[6], "ast": x[7]}
                      for x in r["_games"][-5:]]
        pr = r["_prior"]
        r["last_season"] = ({s: round(pr[s] / pr["gp"], 1) for s in STATS} |
                            {"min": round(pr["min"] / pr["gp"], 1), "gp": pr["gp"]}) if pr else None
        del r["_prior"], r["_games"], r["min_base"]

    # a team's player points must add up to the team's expected score: pull
    # each team's sum toward the implied team total (exponent 0.8, partial
    # trust; clamped). This replaces a per-player environment multiplier,
    # which let every rotation inflate together (CLE summed to 138 against
    # a 120 implied on 10/24 in development).
    for (gid, team), rs in by_team.items():
        tgt = next((r["_target_pts"] for r in rs if r.get("_target_pts")), None)
        tot = sum(r["proj"]["pts"] for r in rs)
        if tgt and tot > 0:
            k = max(0.85, min(1.18, (tgt / tot) ** 0.8))
            for r in rs:
                r["proj"]["pts"] = round(r["proj"]["pts"] * k, 2)
        for r in rs:
            r.pop("_target_pts", None)
    return rows, lg
