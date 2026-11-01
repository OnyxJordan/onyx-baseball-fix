"""
nhl_model.py - Onyx NHL game model: team attack and defense ratings in goals
(team_model.py), Poisson goals for each side, overtime split.

Changelog (newest first; each entry cites its evidence)

  v2  11/1  Totals: unders when the home team played the night before, on trial at Onyx's
      opening price. tools/nhl_game_screen.py screened ~60 team statistics (goals and
      shots for and against over 5/10/20 games, save %, rest, back-to-backs) against Onyx's
      moneyline, puck line and total, chosen on games before 2/1/2026, judged after: nothing
      chosen beat Onyx, but one statistic helped in both periods with the same sign, the home
      team on a back-to-back (total goals log loss, 2026 .6836 vs Onyx .6875). As a plain
      rule, every under on a home back-to-back: 2024-25 at market prices before Onyx 41-32
      +9.6%, Onyx before 2/1 54-35 +16.9%, Onyx after 2/1 26-9 +46.2%; at Onyx's closing
      price 38-29 +7.3% and 21-8 +53.1%. Rested home teams' unders lost in every period
      (-3.3%, -11.0%, -6.7%). Who played yesterday comes from the NHL schedule (local dates).

  v1  10/26  Ratings from 1,671 NHL finals since 10/2025 (ESPN), half-life
      45 days, ridge 40, home edge 0.2 goals, a regulation tie goes to the
      home side 52% of the time. Tuned on 10/20/2025-1/14/2026, judged on
      909 later games it never saw: win log loss 0.678 against 0.690 for
      the home-team base rate; total goals error 1.83 against 1.84 for the
      league average (totals barely beat a constant). A heavier ridge (80,
      160) fit the tuning window better and the test window worse, so it was
      not taken. Leans only until the Onyx price backtest passes.
"""

VERSION = "v2"
KIND = "hockey"
P = {"half_life": 45, "ridge": 40, "home": 0.2, "p_ot_home": 0.52, "min_games": 3}
TEST = {"n": 909, "logloss": 0.678, "base_logloss": 0.690, "mae_total": 1.830, "base_mae_total": 1.837,
        "window": "1/15/2026 on"}


# v2: totals under when the home team played the night before (changelog), at the opening price
B2B = {"markets": ("total",), "side": "under", "price_min": -200, "price_max": 200}
