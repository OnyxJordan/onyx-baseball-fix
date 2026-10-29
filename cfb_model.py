"""
cfb_model.py - Onyx College Football game model: FBS team offense and
defense ratings in points (team_model.py), normal margin and total.

Changelog (newest first; each entry cites its evidence)

  v1  10/26  Spread pick lane (tools/sports_backtest.py --markets=spread,total,
      2,911 Onyx games, 939 matched to FBS finals). Blend 20% model / 80%
      Onyx market, edge 2-6pp, price -200 to +150, at most 6 a slate. Chosen
      on 2025 games (21 picks, 13-8), judged on 2026: 27-19 (+12.2%) at
      opening prices, 21-19 (+0.6%) at closing; spread log loss 0.6938 vs
      Onyx 0.6947. Passed the bar, so spread picks are live and graded in
      public. Caveat on the record: the spread / total market restriction was
      chosen after the first run showed those markets beating Onyx on the
      same test games, and 46 picks is a small sample, so the live record is
      the real test. Totals were tried in the same search and did not make
      the lane.

  v1  10/26  Ratings from 1,500 FBS finals over the 2025 and 2026 seasons
      (ESPN, regular season and bowls), half-life 60 days, ridge 1, home
      field 3 points, margin and total spread 17 points. Tuned on 9/20-
      10/31/2025, judged on 789 later games it never saw: win log loss 0.576
      against 0.689 for the home-team base rate, margin error 13.3 points.
      Totals did not beat a constant (13.46 vs 13.43): total leans are shown
      as information only, never as a pick. Leans only until the Onyx price
      backtest passes.
"""

VERSION = "v1"
KIND = "football"
P = {"half_life": 60, "ridge": 1, "home": 3.0, "sd_margin": 17.0, "sd_total": 17.0, "min_games": 3}
TEST = {"n": 789, "logloss": 0.576, "base_logloss": 0.689, "mae_total": 13.46, "base_mae_total": 13.43,
        "window": "11/1/2025 on"}
NO_TOTALS = True
