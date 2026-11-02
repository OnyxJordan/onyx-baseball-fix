"""
cbb_model.py - Onyx College Basketball game model: men's Division I team
offense and defense ratings in points (team_model.py), normal margin and total,
started each season from last season's ratings pulled toward average.

Changelog (newest first; each entry cites its evidence)

  v2  11/2  Pace in totals. Still LEANS ONLY (sports_lab.gate: no Onyx price
      backtest; this version bump would send it back to the lab anyway).
      The total now comes from possessions x efficiency: a second fit on log
      points, log pts = level + pace[home] + pace[away] + off - opp def +/- home,
      each rating pulled toward last season's Torvik rating (efficiency kept
      PRIOR_KEEP, tempo kept PACE_KEEP = 0.5 because Torvik tempo correlates
      only .46 season to season against .82 for efficiency margin; pace carries
      30 games of prior because final scores alone barely tell pace from
      offense and defense). The margin and win chance stay v1's additive
      ratings: the pace fit's margin was no better (8.966 vs 8.955 on the test
      window, log loss .5867 vs .5854).
      Chosen on 11/1-12/31/2025 (2,196 D1 games, each week predicted from
      games before it): pace keep 0 / .35 / .5 / .65 / .8 at ridge 30 gave
      total error 14.43 / 14.31 / 14.28 / 14.29 / 14.32 against v1's 14.51.
      Judged on 1/1-4/9/2026 (3,528 games it never tuned on): total error
      13.62 vs 13.76 for v1 (bias -1.66 to +0.36); margin 8.955 and log loss
      .5854 unchanged. Against the closing lines in history/games_2026.json
      (3,527 games) it does NOT beat the market: the closing total misses by
      13.38 and the closing spread by 8.76. Taking the model's side when it
      disagrees with the close went 51.3% on totals at 4+ points (475-451),
      51.7% at 6+ (164-153), and 49.9% ATS at 2+ points (667-671), all under
      the 52.4% a -110 price needs. tools/cbb_model_backtest.py reproduces all
      of it.

  v1  11/2  First model. LEANS ONLY: no Onyx price backtest exists yet, so
      sports_lab.gate keeps it in the lab (no data/cbb/backtest.json).
      Ratings: points scored = league mean + home edge + offense - opponent
      defense, fitted on this season's finals only (ESPN, groups=50), each
      rating pulled toward a preseason prior instead of zero. The prior is last
      season's adjusted efficiency (data/cbb/history/teams.json, adj_o / adj_d
      per 100 possessions x 68 possessions, the average D1 tempo), kept at
      PRIOR_KEEP of its distance from average; without that file it is last
      season's own fitted ratings (results.json), kept the same share.
      Parameters chosen on the 2025-26 season (6,300 ESPN finals), every game
      predicted only from games before its week, prior from 2024-25 ratings.
      Tuned on D1-vs-D1 games 11/3-12/31/2025 (2,419): keep 0.5 / 0.7 / 0.85
      / 1.0 gave win log loss .4839 / .4748 / .4702 / .4697 (ridge 6, home
      3.5); 0.85 taken, within .0005 of no pull at all, because rosters turn
      over and one season's tuning is thin evidence for none. Ridge 6 beat 3,
      4, 8, 12; half-life 120 beat 30 and 60; home 3.5 beat 2.5 and 3.0;
      margin spread 11 (10.5 to 12 within .002).
      Judged on 1/1-4/9/2026 games it never tuned on (3,528): win log loss
      .585 against .697 for the tuning window's home win rate (.697); margin
      error 8.94 points; total error 13.77 against 15.42 for the tuning
      window's average total (150.6). Totals ride on the same ratings; tempo
      is not modelled yet.
"""

import json, math, re, unicodedata
from datetime import date
from pathlib import Path

VERSION = "v2"
KIND = "basketball"
TEMPO = 68.0          # possessions per 40 minutes, D1 average, turns per-100 efficiency into points
PRIOR_KEEP = 0.85     # share of last season's distance from average a team starts with
P = {"half_life": 120, "ridge": 6, "home": 3.5, "sd_margin": 11.0, "sd_total": 17.0, "min_games": 3,
     "mu0": 75.0, "mu_k": 40}
# v2 pace: possessions = average tempo x exp(pace[home] + pace[away]); points = possessions x efficiency.
# PACE_KEEP is the share of last season's tempo gap a team starts with (Torvik tempo correlates .46
# season to season, efficiency margin .82); ridge_pace is how many games' worth of that prior each
# pace rating carries (final scores alone barely separate pace from offense and defense)
PACE_KEEP = 0.5
P2 = {"half_life": 120, "ridge": 6, "ridge_pace": 30, "home": 3.5, "mu0": 72.0, "mu_k": 40, "iters": 15}
TEST = {"n": 3528, "logloss": 0.585, "base_logloss": 0.697, "mae_total": 13.62, "base_mae_total": 15.42,
        "mae_total_v1": 13.76, "mae_total_close": 13.38, "window": "1/1/2026 on"}

# Torvik team names that do not match an ESPN location / short name after the
# usual folding ("St." -> "State"); value is the ESPN abbreviation
ALIAS = {"Connecticut": "CONN", "Saint Mary's": "SMC", "Miami FL": "MIA", "Miami OH": "M-OH", "N.C. State": "NCSU",
         "Mississippi": "MISS", "McNeese St.": "MCN", "Cal Baptist": "CBU", "Seattle": "SEA", "Sam Houston St.": "SHSU",
         "Illinois Chicago": "UIC", "Hawaii": "HAW", "Texas A&M Corpus Chris": "AMCC", "Appalachian St.": "APP",
         "New Orleans": "NOLA", "LIU": "LIU", "Nebraska Omaha": "OMA", "Nicholls St.": "NICH", "Tennessee Martin": "UTM",
         "Southeastern Louisiana": "SELA", "USC Upstate": "UPST", "Grambling St.": "GRAM", "Albany": "UALB",
         "Louisiana Monroe": "ULM", "UMKC": "KC"}


def _fold(s):
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower().replace("&", " and ")
    s = re.sub(r"[.'’ʻ()\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _variants(x):
    y = _fold(x)
    return {y, re.sub(r"\bst$", "state", y), re.sub(r"\bst\b", "state", y), re.sub(r"^st\b", "saint", y)}


def torvik_map(names):
    """Torvik name -> ESPN abbreviation, from data/cbb/teams_espn.json."""
    idx = {}
    for ab, m in (names or {}).items():
        for f in ("loc", "short", "name"):
            for v in _variants(m.get(f)):
                idx.setdefault(v, set()).add(ab)

    def look(team):
        if team in ALIAS:
            return ALIAS[team]
        hits = set()
        for v in _variants(team):
            hits |= idx.get(v, set())
        return next(iter(hits)) if len(hits) == 1 else None
    return look


def season_of(d):
    """ESPN names a college basketball season by the year it ends."""
    return int(d[:4]) + 1 if int(d[5:7]) >= 7 else int(d[:4])


def prior_torvik(lane_dir, season, names):
    """(carry_off, carry_def) in points from last season's adjusted efficiency, or None."""
    p = Path(lane_dir) / "history" / "teams.json"
    try:
        rows = json.loads(p.read_text(encoding="utf-8")).get(str(season - 1)) or []
    except Exception:
        return None
    rows = [r for r in rows if r.get("adj_o") is not None and r.get("adj_d") is not None]
    if not rows:
        return None
    look = torvik_map(names)
    mo = sum(r["adj_o"] for r in rows) / len(rows)
    md = sum(r["adj_d"] for r in rows) / len(rows)
    co, cd = {}, {}
    for r in rows:
        ab = look(r.get("team"))
        if not ab:
            continue
        co[ab] = PRIOR_KEEP * (r["adj_o"] - mo) * TEMPO / 100
        cd[ab] = PRIOR_KEEP * (md - r["adj_d"]) * TEMPO / 100
    return (co, cd) if co else None


def prior_results(games, season, P_):
    """Fallback prior: last season's own fitted ratings, kept PRIOR_KEEP."""
    import team_model as T
    last = [g for g in games if g.get("season") == season - 1]
    if not last:
        return None
    # ridge 1, not the in-season 6: with no prior to pull toward, a heavy ridge flattens whole
    # conferences (they meet only in November and December): Michigan 2025-26 rated +9.9 at
    # ridge 6 against +24.8 at ridge 1 and +17.8 by raw scoring margin
    R = T.fit(last, "9999-12-31", dict(P_, half_life=10 ** 6, ridge=1))
    return ({t: PRIOR_KEEP * v for t, v in R["off"].items()}, {t: PRIOR_KEEP * v for t, v in R["def"].items()})


def prior_pace(lane_dir, season, names):
    """Log-scale preseason priors from last season's Torvik ratings, or None:
    (off, def, pace, average tempo, average efficiency). off = PRIOR_KEEP x log(adj_o / average),
    def = PRIOR_KEEP x log(average / adj_d), pace = PACE_KEEP x log(tempo / average tempo)."""
    p = Path(lane_dir) / "history" / "teams.json"
    try:
        rows = json.loads(p.read_text(encoding="utf-8")).get(str(season - 1)) or []
    except Exception:
        return None
    rows = [r for r in rows if r.get("adj_o") and r.get("adj_d") and r.get("tempo")]
    if not rows:
        return None
    look = torvik_map(names)
    eo = sum(r["adj_o"] for r in rows) / len(rows)
    ed = sum(r["adj_d"] for r in rows) / len(rows)
    tm = sum(r["tempo"] for r in rows) / len(rows)
    o, d, pc = {}, {}, {}
    for r in rows:
        ab = look(r.get("team"))
        if not ab:
            continue
        o[ab] = PRIOR_KEEP * math.log(r["adj_o"] / eo)
        d[ab] = PRIOR_KEEP * math.log(ed / r["adj_d"])
        pc[ab] = PACE_KEEP * math.log(r["tempo"] / tm)
    return (o, d, pc, tm, eo) if o else None


def _days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def fit_pace(games, as_of, prior, Q=None):
    """v2 ratings: weighted least squares on log points,
        log pts(team vs opp) = c + pace[home] + pace[away] + off[team] - def[opp] +/- home,
    each rating pulled toward its preseason prior (ridge, in games' worth), older games weighing
    less (half-life). Returns the ratings and an expect(home, away, neutral) in points."""
    Q = dict(P2, **(Q or {}))
    o0, d0, p0, tm, _ = prior
    rows = [g for g in games if g["date"] < as_of and (g.get("hs") or 0) > 0 and (g.get("as") or 0) > 0]
    w = [0.5 ** (_days(g["date"], as_of) / Q["half_life"]) for g in rows]
    hm = Q["home"] / 2 / Q["mu0"]
    teams = set(o0) | {t for g in rows for t in (g["home"], g["away"])}
    o = {t: o0.get(t, 0.0) for t in teams}
    d = {t: d0.get(t, 0.0) for t in teams}
    pc = {t: p0.get(t, 0.0) for t in teams}
    c0 = c = math.log(Q["mu0"])
    lh = [math.log(g["hs"]) for g in rows]
    la = [math.log(g["as"]) for g in rows]
    hh = [0.0 if g.get("neutral") else hm for g in rows]
    lam, lp = Q["ridge"], Q["ridge_pace"]
    n = {}
    for g in rows:
        for t in (g["home"], g["away"]):
            n[t] = n.get(t, 0) + 1
    for _ in range(Q["iters"]):
        num, den = Q["mu_k"] * c0, Q["mu_k"]
        for wi, g, yh, ya, h in zip(w, rows, lh, la, hh):
            pp = pc[g["home"]] + pc[g["away"]]
            num += wi * (yh - pp - o[g["home"]] + d[g["away"]] - h + ya - pp - o[g["away"]] + d[g["home"]] + h)
            den += 2 * wi
        c = num / den
        nu, de = {t: lam * o0.get(t, 0.0) for t in teams}, {t: lam for t in teams}
        for wi, g, yh, ya, h in zip(w, rows, lh, la, hh):
            pp = c + pc[g["home"]] + pc[g["away"]]
            nu[g["home"]] += wi * (yh - pp + d[g["away"]] - h); de[g["home"]] += wi
            nu[g["away"]] += wi * (ya - pp + d[g["home"]] + h); de[g["away"]] += wi
        o = {t: nu[t] / de[t] for t in teams}
        nu, de = {t: lam * d0.get(t, 0.0) for t in teams}, {t: lam for t in teams}
        for wi, g, yh, ya, h in zip(w, rows, lh, la, hh):
            pp = c + pc[g["home"]] + pc[g["away"]]
            nu[g["away"]] += wi * (pp + o[g["home"]] + h - yh); de[g["away"]] += wi
            nu[g["home"]] += wi * (pp + o[g["away"]] - h - ya); de[g["home"]] += wi
        d = {t: nu[t] / de[t] for t in teams}
        nu, de = {t: lp * p0.get(t, 0.0) for t in teams}, {t: lp for t in teams}
        for wi, g, yh, ya, h in zip(w, rows, lh, la, hh):
            H, A = g["home"], g["away"]
            r = (yh - c - o[H] + d[A] - h) + (ya - c - o[A] + d[H] + h)
            nu[H] += wi * (r - 2 * pc[A]); de[H] += 2 * wi
            nu[A] += wi * (r - 2 * pc[H]); de[A] += 2 * wi
        pc = {t: nu[t] / de[t] for t in teams}
    def expect(home, away, neutral=False):
        h = 0.0 if neutral else hm
        pp = c + pc.get(home, 0.0) + pc.get(away, 0.0)
        return (max(math.exp(pp + o.get(home, 0.0) - d.get(away, 0.0) + h), 0.05),
                max(math.exp(pp + o.get(away, 0.0) - d.get(home, 0.0) - h), 0.05))

    mu = math.exp(c)
    return {"mu": mu, "home": Q["home"], "n": n, "c": c, "pace": pc, "tempo": tm,
            # point equivalents for anything that reads the additive form
            "off": {t: mu * (math.exp(v) - 1) for t, v in o.items()},
            "def": {t: mu * (1 - math.exp(-v)) for t, v in d.items()},
            "poss": {t: round(tm * math.exp(v), 1) for t, v in pc.items()},
            "expect": expect}


def ratings(lane_dir, games, as_of, names=None, P_=None, pace=True):
    """This season's ratings as of an ISO date, pulled toward the preseason prior.
    A team with a prior counts as min_games played, so it is priced from opening night.
    v2: with Torvik's file the total comes from the pace ratings (fit_pace), the margin from v1's
    additive ratings; without the file (or pace=False) it is v1 exactly."""
    import team_model as T
    P_ = dict(P_ or P)
    season = season_of(as_of)
    pr = prior_torvik(lane_dir, season, names) or prior_results(games, season, P_)
    P_["_prior"] = None if not pr else "torvik" if (Path(lane_dir) / "history" / "teams.json").exists() else "results"
    if pr:
        P_["carry_off"], P_["carry_def"] = pr
    cur = [g for g in games if g.get("season") == season]
    R = T.fit(cur, as_of, P_)
    R["prior"] = P_["_prior"]
    if pr:
        for t in pr[0]:
            R["n"][t] = max(R["n"].get(t, 0), P_.get("min_games", 3))
    pp = prior_pace(lane_dir, season, names) if pace else None
    if pp:
        # v2: the margin stays v1's additive ratings (pace did not improve it: 8.966 vs 8.955), the
        # total comes from possessions x efficiency (13.62 vs 13.76 on games it never saw)
        Rp = fit_pace(cur, as_of, pp)
        add = R

        def expect(home, away, neutral=False):
            eh, ea = T.expect(dict(add, expect=None), home, away, neutral)
            ph, pa = Rp["expect"](home, away, neutral)
            m, tot = eh - ea, ph + pa
            return max((tot + m) / 2, 0.05), max((tot - m) / 2, 0.05)
        R = dict(R, expect=expect, pace=Rp["pace"], poss=Rp["poss"], tempo=Rp["tempo"])
    return R
