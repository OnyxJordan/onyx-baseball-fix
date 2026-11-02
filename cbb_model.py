"""
cbb_model.py - Onyx College Basketball game model: men's Division I team
offense and defense ratings in points (team_model.py), normal margin and total,
started each season from last season's ratings pulled toward average.

Changelog (newest first; each entry cites its evidence)

  v1  11/2  First model. LEANS ONLY: no Onyx price backtest exists yet, so
      sports_lab.gate keeps it in the lab (no data/cbb/backtest.json).
      Ratings: points scored = league mean + home edge + offense - opponent
      defense, fitted on this season's finals only (ESPN, groups=50), each
      rating pulled toward a preseason prior instead of zero. The prior is last
      season's adjusted efficiency (data/cbb/history/teams.json, adj_o / adj_d
      per 100 possessions x 68 possessions, the average D1 tempo), kept at
      PRIOR_KEEP of its distance from average; without that file it is last
      season's own fitted ratings (results.json), kept the same share.
      Parameters chosen on the 2025-26 season (6,300 ESPN finals), each game
      predicted only from games before its week, prior from 2024-25:
      see TEST. Totals ride on the same ratings; tempo is not modelled yet.
"""

import json, re, unicodedata
from pathlib import Path

VERSION = "v1"
KIND = "basketball"
TEMPO = 68.0          # possessions per 40 minutes, D1 average, turns per-100 efficiency into points
PRIOR_KEEP = 0.7      # share of last season's distance from average a team starts with
P = {"half_life": 60, "ridge": 6, "home": 3.0, "sd_margin": 11.0, "sd_total": 16.0, "min_games": 3,
     "mu0": 72.5, "mu_k": 40}
TEST = {"n": 0, "logloss": 0.0, "base_logloss": 0.0, "mae_total": 0.0, "base_mae_total": 0.0, "window": "2025-26"}

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
    R = T.fit(last, "9999-12-31", dict(P_, half_life=10 ** 6))
    return ({t: PRIOR_KEEP * v for t, v in R["off"].items()}, {t: PRIOR_KEEP * v for t, v in R["def"].items()})


def ratings(lane_dir, games, as_of, names=None, P_=None):
    """This season's ratings as of an ISO date, pulled toward the preseason prior.
    A team with a prior counts as min_games played, so it is priced from opening night."""
    import team_model as T
    P_ = dict(P_ or P)
    season = season_of(as_of)
    pr = prior_torvik(lane_dir, season, names) or prior_results(games, season, P_)
    if pr:
        P_["carry_off"], P_["carry_def"] = pr
    cur = [g for g in games if g.get("season") == season]
    R = T.fit(cur, as_of, P_)
    if pr:
        for t in pr[0]:
            R["n"][t] = max(R["n"].get(t, 0), P_.get("min_games", 3))
    R["prior"] = "torvik" if pr and P_.get("carry_off") and prior_torvik(lane_dir, season, names) else ("results" if pr else None)
    return R
