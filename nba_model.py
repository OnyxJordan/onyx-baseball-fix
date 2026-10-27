"""
nba_model.py - Onyx NBA points / rebounds / assists projection model.

CHANGELOG (the lab notebook: every change bumps VERSION and cites evidence)
  v4 (2026-10-25) THREE SEASONS OF HISTORY, AGED, REGRESSED TO ROLE.
     The prior was one season of box scores: a player who missed last season
     (Haliburton, Achilles) projected like a near-rookie, and early-season
     numbers leaned on two games. Now (history_prior / slate_history):
     - ESPN season totals for the last 3 seasons, weighted 6/3/1 by recency
       (tested 5/4/3, 4/3/2, 3/2/0, last-season-only), per-minute rates
       weighted by minutes; a missed season simply leans on the earlier ones.
     - Age curve fitted on every consecutive-season pair before the season
       being projected (2018-19 on), per-minute rates and MPG by age, 3-age
       smoothed, applied at half strength (age_k 0.5; 1.0 and 1.5 overshot).
     - Rates regressed toward ROLE (position x minutes band) by 250 minutes;
       rookies start from their role's production at the minutes they are
       actually playing, not a generic position rate.
     - Team pace / scoring / allowed regressed toward last season's team at
       80% (team_carry), not toward a blank league average.
     - RATE_PRIOR_MIN 300 -> 500 (history earns more weight on rates).
       PRIOR_GAMES_K stays 2: weighting history more on MINUTES (4 / 6 / 10
       games) was worse in BOTH seasons; rotations really do move fast.
     Evidence (tools/nba_backtest_hist.py: tuned on all of 2024-25 with a
     2021-24 prior, judged on 2025-26, never seen). Same player-games, v3 ->
     v4 MAE:
       all 26,353          pts 4.439 -> 4.439  reb 1.844 -> 1.840  ast 1.309 -> 1.307  min 4.87 -> 4.86
       first 10 team games pts 4.396 -> 4.388  reb 1.827 -> 1.819  ast 1.304 -> 1.297  min 4.76 -> 4.72
       missed last season  pts 4.231 -> 3.932  reb 1.749 -> 1.695  ast 1.125 -> 1.074  min 5.37 -> 5.00
       team switchers      pts 4.356 -> 4.350  reb 1.762 -> 1.757  min 5.07 -> 5.04
       age 31 and over     pts 4.314 -> 4.303
       no NBA history      ast 1.195 -> 1.176; pts / reb / min flat
       age 23 and under    pts 4.408 -> 4.415 (slightly worse), min 5.04 -> 5.02
     Picks lane (same rules), Feb-Apr 2026: open 75-60 -> 73-59, close 53-47
     (+4.3%) -> 53-45 (+5.6%); Oct-Jan close 39-31 -> 39-38. ~170-275 picks:
     within noise either way (Oct-Jan was also the lane's own tuning window).
     Projection vs Onyx closing line, full season: 3.088 -> 3.087 (line 3.030).
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
         plus-minus pm_k .01 / .02 / .04  0.4722 / 0.4722 / 0.4726 (no gain;
                                          test picks open 75-60 -> 73-59 /
                                          70-59 / 67-58, worse)
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
from collections import defaultdict

VERSION = "v4"

LEAGUE = {"ppg": 115.0, "reb": 44.0, "ast": 27.0, "poss": 99.5}
POS_RATE = {   # per-minute league rates by listed position, used only without a prior
    "G": {"pts": 0.46, "reb": 0.14, "ast": 0.17, "fg3": 0.070},
    "F": {"pts": 0.44, "reb": 0.21, "ast": 0.09, "fg3": 0.050},
    "C": {"pts": 0.45, "reb": 0.30, "ast": 0.08, "fg3": 0.015},
}
PRIOR_GAMES_K = 2
RATE_PRIOR_MIN = 500.0   # v4: with a 3-season prior, history earns more weight on rates
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
    "usg_pos": 0.0,          # extra share of an OUT player's plays to teammates at his position
    # who inherits an OUT teammate's minutes (refill_minutes). fill_on 0 = the
    # v1-v4 rule (fit_team_minutes: the 15+ min rotation, in proportion)
    "fill_on": 0.0,
    "fill_exp": 1.0,         # weight ~ base minutes ^ exp (below 1 spreads to the bench)
    "fill_pos": 0.0,         # extra weight for the OUT player's position group
    "fill_cap": 99.0,        # most minutes one player can inherit
    "fill_floor": 15.0,      # least base minutes to inherit any
    "usg_beta_pts": 0.8,
    "usg_beta_ast": 0.5,
    "usg_beta_reb": 0.0,
}
OUT_STATUSES = {"OUT", "DOUBTFUL", "O", "D", "SUSPENSION"}
RISK_STATUSES = {"QUESTIONABLE", "GTD", "Q", "DAY-TO-DAY", "DTD"}
STATS = ("pts", "reb", "ast")
IDX = {"min": 4, "pts": 5, "reb": 6, "ast": 7, "fg3": 8, "fga": 10, "fta": 11, "tov": 12}
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


# ── multi-season history: weighted seasons, aging, role baselines ───────────
# H holds the history knobs (nba_backtest.py tunes them). Seasons are weighted
# most-recent first; every season is aged forward to this season with an age
# curve fitted on past year-to-year changes, then regressed toward what
# players in the same ROLE (position x minutes band) produce, by REG_MIN
# minutes. A player who missed last season simply leans on the two before.
H = {
    # v4 values: tuned on 2024-25, judged on 2025-26 (tools/nba_backtest_hist.py)
    "w": (6.0, 3.0, 1.0),     # weights for 1 / 2 / 3 seasons back
    "reg_min": 250.0,         # minutes of role-average production mixed into the rates
    "min_reg_gp": 0.0,        # games of role-average minutes mixed into MPG (tested 4-16: no gain)
    "age_k": 0.5,             # strength of the fitted age curve (0 = no aging; 1.0+ overshot)
    "team_carry": 0.8,        # share of last season's team pace / ratings carried into the regression target
}
MIN_BANDS = ((0, 14), (14, 22), (22, 30), (30, 99))
HIST_STATS = ("pts", "reb", "ast", "fg3", "fga", "fta", "tov")


def min_band(mpg):
    for i, (lo, hi) in enumerate(MIN_BANDS):
        if lo <= mpg < hi:
            return i
    return len(MIN_BANDS) - 1


def role_table(season_rows):
    """Per-minute production by (position, minutes band) from one season of
    league-wide totals: {"G|2": {"pts": .., ..., "mpg": ..}}. Rookies and
    thin histories regress toward their ROLE, not a generic position mean."""
    acc = {}
    for r in season_rows.values():
        if not r.get("gp") or not r.get("min") or r["gp"] < 10:
            continue
        mpg = r["min"] / r["gp"]
        key = f"{_pos_key(r.get('pos'))}|{min_band(mpg)}"
        a = acc.setdefault(key, {"min": 0.0, "gp": 0.0, **{k: 0.0 for k in HIST_STATS}})
        a["min"] += r["min"]; a["gp"] += r["gp"]
        for k in HIST_STATS:
            a[k] += r.get(k) or 0.0
    out = {}
    for key, a in acc.items():
        out[key] = {k: a[k] / a["min"] for k in HIST_STATS}
        out[key]["mpg"] = a["min"] / a["gp"]
    return out


def role_rates(table, pos, mpg):
    key = f"{_pos_key(pos)}|{min_band(mpg)}"
    if key in table:
        return table[key]
    base = POS_RATE[_pos_key(pos)]
    return {**{k: 0.0 for k in HIST_STATS}, **base, "mpg": mpg}


def fit_aging(seasons, last_season, ref_season):
    """Year-over-year change by age, fitted on consecutive seasons up to
    `last_season` (never the season being projected). Returns
    {"min": {age: delta mpg}, stat: {age: log ratio of per-minute rate}}.
    seasons = {season: {espn_id: row}}; ages are as of ref_season."""
    pairs = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))   # kind -> age -> [sum w*x, sum w]
    for s in sorted(int(x) for x in seasons):
        nxt = str(s + 1)
        if s + 1 > last_season or nxt not in seasons:
            continue
        a_rows, b_rows = seasons[str(s)], seasons[nxt]
        for pid, a in a_rows.items():
            b = b_rows.get(pid)
            if not b or a.get("age") is None or not a.get("min") or not b.get("min"):
                continue
            if a["gp"] < 20 or b["gp"] < 20:
                continue
            age = int(a["age"]) - (ref_season - s)          # age during season s
            w = 1.0 / (1.0 / a["min"] + 1.0 / b["min"])      # harmonic minutes
            pairs["min"][age][0] += w * (b["min"] / b["gp"] - a["min"] / a["gp"])
            pairs["min"][age][1] += w
            for k in ("pts", "reb", "ast", "fga"):
                ra, rb = (a.get(k) or 0) / a["min"], (b.get(k) or 0) / b["min"]
                if ra > 0 and rb > 0:
                    pairs[k][age][0] += w * math.log(rb / ra)
                    pairs[k][age][1] += w
    out = {}
    for kind, by_age in pairs.items():
        raw = {age: v[0] / v[1] for age, v in by_age.items() if v[1] > 0}
        sm = {}
        for age in range(19, 40):     # 3-age smoothing, ends clamped
            near = [(raw[x], by_age[x][1]) for x in (age - 1, age, age + 1) if x in raw]
            if near:
                sm[age] = sum(v * w for v, w in near) / sum(w for _, w in near)
        out[kind] = sm
    out["fta"] = out["tov"] = out.get("fga", {})
    out["fg3"] = out.get("pts", {})
    return out


def _age_shift(aging, kind, age_from, age_to):
    tot = 0.0
    tab = aging.get(kind) or {}
    for a in range(int(age_from), int(age_to)):
        tot += tab.get(max(19, min(39, a)), 0.0)
    return tot


def history_prior(rows, age_now, aging, roles, cur_team=None):
    """One player's prior from up to three past seasons.
    rows = [(seasons_back, row)], seasons_back 1 = last season. age_now = age
    this season. Returns the prior dict project_slate expects (gp / min /
    stat totals; rate = stat/min, MPG = min/gp) or None without history."""
    W = H["w"]
    rows = [(k, r) for k, r in rows if r and r.get("gp") and r.get("min") and 1 <= k <= len(W) and W[k - 1] > 0]
    if not rows:
        return None
    wmin = sum(W[k - 1] * r["min"] for k, r in rows)
    wgp = sum(W[k - 1] * r["gp"] for k, r in rows)
    # minutes per game, each season aged forward to this season
    mpg_parts = []
    for k, r in rows:
        mpg = r["min"] / r["gp"]
        if age_now is not None and aging:
            mpg += H["age_k"] * _age_shift(aging, "min", age_now - k, age_now)
        mpg_parts.append((W[k - 1] * r["gp"], mpg))
    mpg = sum(w * m for w, m in mpg_parts) / wgp
    role = role_rates(roles, rows[0][1].get("pos"), mpg)
    mpg = (mpg * wgp / sum(W[k - 1] for k, _ in rows) + role.get("mpg", mpg) * H["min_reg_gp"]) \
        / (wgp / sum(W[k - 1] for k, _ in rows) + H["min_reg_gp"])
    rates = {}
    for st in HIST_STATS:
        num = 0.0
        for k, r in rows:
            v = (r.get(st) or 0.0)
            if age_now is not None and aging and v > 0:
                v *= math.exp(H["age_k"] * _age_shift(aging, st, age_now - k, age_now))
            num += W[k - 1] * v
        rates[st] = (num + H["reg_min"] * role.get(st, 0.0)) / (wmin + H["reg_min"])
    last = min(rows, key=lambda x: x[0])
    gp = int(last[1]["gp"])
    tot_min = mpg * gp
    out = {"gp": gp, "min": tot_min, "pos": last[1].get("pos", ""),
           "t": last[1].get("t", ""), "seasons": len(rows), "back": last[0],
           "hist_min": round(sum(r["min"] for _, r in rows)), "age": age_now}
    for st in HIST_STATS:
        out[st] = rates[st] * tot_min
    if cur_team and out["t"] and out["t"] != cur_team:
        out["switched"] = True
    # what actually happened, for the page: the most recent season played,
    # and each season in the window per game
    lr = last[1]
    out["ls"] = {"pts": round((lr.get("pts") or 0) / lr["gp"], 1), "reb": round((lr.get("reb") or 0) / lr["gp"], 1),
                 "ast": round((lr.get("ast") or 0) / lr["gp"], 1), "min": round(lr["min"] / lr["gp"], 1),
                 "gp": int(lr["gp"]), "back": last[0]}
    out["hist"] = [{"back": k, "t": r.get("t", ""), "gp": int(r["gp"]), "min": round(r["min"] / r["gp"], 1),
                    "pts": round((r.get("pts") or 0) / r["gp"], 1), "reb": round((r.get("reb") or 0) / r["gp"], 1),
                    "ast": round((r.get("ast") or 0) / r["gp"], 1),
                    "usg": usg_pct(((r.get("fga") or 0) + 0.44 * (r.get("fta") or 0) + (r.get("tov") or 0)) / r["min"])}
                   for k, r in sorted(rows, key=lambda x: x[0])]
    return out


def slate_history(slate, hist, cur_season):
    """Priors for tonight's players from data/nba/history.json (ESPN season
    totals, nba_fetch.fetch_history), plus last season's team baselines and
    role table. Players are matched by ESPN id (the slate's `hs`), then name.
    Returns (priors by pid, team_hist, roles, n_matched)."""
    from nba_common import nk as _nk
    P = (hist or {}).get("players") or {}
    if not P:
        return {}, {}, {}, 0
    ref = int(hist.get("_ref") or cur_season)
    aging = fit_aging(P, cur_season - 1, ref)
    roles = role_table(P.get(str(cur_season - 1), {}))
    th = team_history(((hist.get("teams") or {}).get(str(cur_season - 1))))
    by_name = {}
    for k in (1, 2, 3):
        m = {}
        for r in P.get(str(cur_season - k), {}).values():
            key = _nk(r["n"])
            if key not in m or r["min"] > m[key]["min"]:
                m[key] = r
        by_name[k] = m
    out = {}
    for p in slate.get("players", []):
        eid = str(p.get("hs") or "")
        rows, age = [], None
        for k in (1, 2, 3):
            season = P.get(str(cur_season - k), {})
            r = season.get(eid) if eid else None
            r = r or by_name[k].get(_nk(p.get("name", "")))
            rows.append((k, r))
            if r and age is None and r.get("age") is not None:
                age = int(r["age"]) - (ref - cur_season)
        pr = history_prior(rows, age, aging, roles, p.get("team"))
        if pr:
            pr["n"] = p.get("name", "")
            out[p["pid"]] = pr
    return out, th, roles, len(out)



def team_history(season_teams):
    """Each team's last-season pace / scoring / what it allowed, as ratios to
    that season's league average (so a league-wide pace drift does not leak
    into one team): {team: {"poss": 1.03, ...}}."""
    rows = {t: r for t, r in (season_teams or {}).items() if r.get("gp") and r.get("poss")}
    if not rows:
        return {}
    def per_g(r, k):
        return (r.get(k) or 0.0) / r["gp"]
    lg = {k: sum(per_g(r, k) if k not in ("poss", "ppg", "opp_ppg") else r[k] for r in rows.values()) / len(rows)
          for k in ("poss", "ppg", "opp_ppg", "opp_reb", "opp_ast")}
    out = {}
    for t, r in rows.items():
        out[t] = {"poss": r["poss"] / lg["poss"], "ppg": r["ppg"] / lg["ppg"], "opp_ppg": r["opp_ppg"] / lg["opp_ppg"],
                  "opp_reb": per_g(r, "opp_reb") / lg["opp_reb"], "opp_ast": per_g(r, "opp_ast") / lg["opp_ast"]}
    return out


def team_profile(team_games, team, lg, th=None):
    """Regressed scoring for the team and what its opponents get against it.
    This season's games are regressed toward last season's team (th, ratios
    to league) by H["team_carry"], not toward a blank league average."""
    rows = team_games.get(team, [])
    n = len(rows)
    w = n / (n + 10.0)
    th = (th or {}).get(team) or {}
    def tgt(k, base):
        return base * (1 + H["team_carry"] * (th[k] - 1)) if k in th else base
    def avg(col, base):
        return (w * (sum(r.get(col, 0) for r in rows) / n) + (1 - w) * base) if n else base
    out = {
        "n": n,
        "ppg": avg("pts", tgt("ppg", lg["ppg"])), "opp_ppg": avg("opp_pts", tgt("opp_ppg", lg["ppg"])),
        "opp_reb": avg("opp_reb", tgt("opp_reb", lg["reb"])), "opp_ast": avg("opp_ast", tgt("opp_ast", lg["ast"])),
        "poss": avg("poss", tgt("poss", lg["poss"])),
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


def refill_minutes(rs):
    """fit_team_minutes with a say in WHO inherits: when the team is under
    240 (teammates out), the shortfall is split by each OUT player's minutes
    and handed to everyone left with weight (base + 4) ^ fill_exp (below 0
    leans to the bench, which is where coaches actually find the minutes),
    x (1 + fill_pos) at the OUT player's position, each player inheriting
    at most fill_cap minutes and 40 in all. Over 240 it trims as before."""
    m = [0.0 if r["out"] else r["min_base"] for r in rs]
    if sum(m) >= 240.0:
        return fit_team_minutes(m)
    outs = [o for o in rs if o["out"] and o["min_full"] > 0]
    tot_out = sum(min(o["min_full"], 36.0) for o in outs)
    short = 240.0 - sum(m)
    shares = [(o, short * min(o["min_full"], 36.0) / tot_out) for o in outs] if tot_out > 0 else [(None, short)]
    got = [0.0] * len(rs)
    for o, give in shares:
        for _ in range(4):
            elig = [i for i, r in enumerate(rs) if not r["out"] and m[i] >= P["fill_floor"]
                    and got[i] < P["fill_cap"] - 1e-6 and m[i] < 40.0]
            if give <= 0.25 or not elig:
                break
            w = {i: (m[i] + 4.0) ** P["fill_exp"] *
                 (1 + (P["fill_pos"] if o is not None and _pos_key(rs[i]["pos"]) == _pos_key(o["pos"]) else 0.0))
                 for i in elig}
            ws = sum(w.values())
            left = 0.0
            for i in elig:
                add = give * w[i] / ws
                take = min(add, P["fill_cap"] - got[i], 40.0 - m[i])
                m[i] += take; got[i] += take; left += add - take
            give = left
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
        r0, k = (prior.get(stat) or 0.0) / prior["min"], RATE_PRIOR_MIN
    else:
        # no NBA history: start from what players in his ROLE produce (his
        # minutes so far this season pick the band), not a generic position rate
        mpg_now = (sum(g[IDX["min"]] for g in played) / n) if n else 0.0
        rr = role_rates(ROLES, pos, mpg_now) if ROLES else POS_RATE[_pos_key(pos)]
        r0, k = rr.get(stat, POS_RATE[_pos_key(pos)][stat]) or POS_RATE[_pos_key(pos)][stat], POS_PRIOR_MIN
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


COMBOS = {"pra": ("pts", "reb", "ast"), "pr": ("pts", "reb"), "pa": ("pts", "ast")}


def combo_var(proj, combo):
    """Variance of a combined stat: the fitted per-stat spreads, summed as if
    independent. Points, rebounds and assists rise together with minutes, so
    the true spread is wider; NOT backtested, the bet card labels combos that
    way and never recommends from them."""
    return sum(max(0.8, SD[s][0] * proj.get(s, 0.0) + SD[s][1]) ** 2 for s in COMBOS[combo])


def prob_over_combo(proj, combo, line):
    mean = sum(proj.get(s, 0.0) for s in COMBOS[combo])
    return 1 - _nb_cdf(math.floor(line), mean, max(combo_var(proj, combo), mean * 1.0001))


def prob_over_fg3(mean, line):
    """P(over) for made threes: negative binomial with variance 1.35 x mean.
    A reasonable shape for a rare-count stat, NOT fitted or backtested; the
    bet card labels it that way and never recommends from it."""
    mean = max(mean, 0.05)
    return 1 - _nb_cdf(math.floor(line), mean, 1.35 * mean)


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


ROLES = {}    # role_table of last season, set per slate (project_slate roles=)


def project_slate(slate, prior, player_games, team_games, team_hist=None, roles=None):
    """One projection row per rostered player on today's slate."""
    global ROLES
    ROLES = roles or {}
    lg = league_from_teams(team_games)
    games = {g["gid"]: g for g in slate.get("games", [])}
    profiles = {}
    def prof(t):
        if t not in profiles:
            profiles[t] = team_profile(team_games, t, lg, team_hist)
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
        fitted = refill_minutes(rs) if P["fill_on"] else fit_team_minutes([r["min_base"] for r in rs])
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
        avail = [r for r in rs if not r["out"] and r["upm"] and r["min"] > 0]
        for r in rs:
            r["usg"] = usg_pct(r["upm"])
            r["usg_boost"] = 1.0
        if P["usg_alpha"] > 0 and avail:
            extra = {id(r): 0.0 for r in avail}
            for o in rs:
                if not o["out"] or not o["upm"]:
                    continue
                lost = o["upm"] * min(o["min_full"], 36.0)
                w = {id(r): r["upm"] ** (1 + P["usg_gamma"]) * r["min"] *
                     (1 + P["usg_pos"] * (_pos_key(r["pos"]) == _pos_key(o["pos"]))) for r in avail}
                ws = sum(w.values())
                for r in avail:
                    extra[id(r)] += P["usg_alpha"] * lost * w[id(r)] / ws
            for r in avail:
                r["usg_boost"] = round(min(1.35, 1 + extra[id(r)] / r["min"] / r["upm"]), 4)
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
        # made threes, for the player bet card only: minutes x per-minute rate
        # from the same 3-season history, no environment terms. NOT backtested
        # and never used by the picks lane.
        proj["fg3"] = round(r["min"] * per_minute(r["_prior"], r["_games"], "fg3", r["pos"]), 2) if not r["out"] else 0.0
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
        if pr and pr.get("ls"):
            r["last_season"] = dict(pr["ls"])
            r["history"] = pr.get("hist")
            r["baseline"] = {s: round(pr[s] / pr["gp"], 1) for s in STATS} | {"min": round(pr["min"] / pr["gp"], 1)}
            r["age"] = pr.get("age")
        else:
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
