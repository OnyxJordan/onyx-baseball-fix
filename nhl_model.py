"""
nhl_model.py - Onyx NHL game model: team attack and defense ratings in goals
(team_model.py), Poisson goals for each side, overtime split.

Changelog (newest first; each entry cites its evidence)

  v3  11/15  Honest prices: the chance shown is essentially Onyx's (W_BLEND 0.1, was the
      backtest's 0.5) and the ratings remember longer (half-life 180 days, ridge 20; was
      45 / 40). Why: the NHL best-value list lost live (rule v2 16-25, -12.8u; puck lines
      9-17) and the 11/15 scope found that where the model disagrees with Onyx, Onyx is
      right. Re-tested on 7,207 priced game lines (moneyline, puck line, total; 2024-25 at
      market prices before Onyx, 2025-26 and 2026-27 to 11/9 at Onyx's), choosing on one
      season and judging on the others, at the opening and the closing price: 28 ratings
      settings (half-life 45-365, ridge 5-40, home edge .1-.3) x 3 adjustments (none;
      back-to-back goals; backup goalie, an upper bound since it uses who actually started)
      x 7 blend weights (0-1) = 588 configs, run in both directions, plus Onyx's puck line
      priced from its own moneyline and total.
      Chosen on 2024-25: 180 days, ridge 20, weight 0.1 (weight 0 tied; a 0.3 home edge
      scored the same at this weight and split the seasons on its own, so 0.2 stays). Held
      out, log loss of the chance shown (home / over side, all three markets) vs Onyx no-vig:
        2025-26  open .6633 vs Onyx .6639 (v2 .6628), close .6618 vs .6623 (v2 .6618)
        2026-27  open .6589 vs Onyx .6587 (v2 .6668), close .6568 vs .6561 (v2 .6664)
      Best-value list (daily_top: edge > 0, -200 or longer, 50%+, top 5 a market a day):
        v2  2025-26 738 bets +0.8% open, 697 +2.1% close; 2026-27 147 -21.3%, 172 -14.2%
        v3  2025-26 4 bets open, 2 close; 2026-27 none
      With the chance essentially Onyx's the model almost never claims value, which is the
      honest answer: nothing beat Onyx held out. Model alone (weight 1) the longer memory is
      better: 2026-27 log loss .6656 vs v2 .6800, 2024-25 .6795 vs .6817, 2025-26 tied
      (.6662 vs .6666); win log loss on 982 finals since 1/15/2026 .6715 vs .6800 (home base
      rate .6924). Chosen the other way (on 2025-26), the winner was a 50/50 blend with
      back-to-back goals, and it lost to Onyx on both other seasons (log loss .0017-.0045
      worse; list -8.5% / -13.5% in 2026-27, -4.8% / -12.7% in 2024-25), so 2025-26 picks
      noise. Rejected, each failed a held-out season: back-to-back goal adjustments, backup
      goalie, any weight above 0.1 in any market, and pricing the puck line from Onyx's own
      moneyline and total (beat Onyx's puck line in 2025-26, .6230 vs .6262, lost 2026-27
      at -16.7% open). The v2 home back-to-back under trial lane is unchanged.

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

VERSION = "v3"
KIND = "hockey"
P = {"half_life": 180, "ridge": 20, "home": 0.2, "p_ot_home": 0.52, "min_games": 3}
TEST = {"n": 982, "logloss": 0.6715, "base_logloss": 0.6924, "mae_total": 1.844, "base_mae_total": 1.844,
        "window": "1/15/2026 on"}
# v3: the model's share of the chance shown (sports_build.team_block, tools/picks_backtest.py; it overrides
# data/nhl/backtest.json's lane w). Nothing beat Onyx's price held out, so the chance shown is essentially
# Onyx's own no-vig price.
W_BLEND = 0.1


# v2: totals under when the home team played the night before (changelog), at the opening price
B2B = {"markets": ("total",), "side": "under", "price_min": -200, "price_max": 200}
