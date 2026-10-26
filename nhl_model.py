"""
nhl_model.py - Onyx NHL game model: team attack and defense ratings in goals
(team_model.py), Poisson goals for each side, overtime split.

Changelog (newest first; each entry cites its evidence)

  v1  10/26  Ratings from 1,671 NHL finals since 10/2025 (ESPN), half-life
      45 days, ridge 40, home edge 0.2 goals, a regulation tie goes to the
      home side 52% of the time. Tuned on 10/20/2025-1/14/2026, judged on
      909 later games it never saw: win log loss 0.678 against 0.690 for
      the home-team base rate; total goals error 1.83 against 1.84 for the
      league average (totals barely beat a constant). A heavier ridge (80,
      160) fit the tuning window better and the test window worse, so it was
      not taken. Leans only until the Onyx price backtest passes.
"""

VERSION = "v1"
KIND = "hockey"
P = {"half_life": 45, "ridge": 40, "home": 0.2, "p_ot_home": 0.52, "min_games": 3}
TEST = {"n": 909, "logloss": 0.678, "base_logloss": 0.690, "mae_total": 1.830, "base_mae_total": 1.837,
        "window": "1/15/2026 on"}
