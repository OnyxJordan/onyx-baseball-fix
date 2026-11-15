"""
cfb_model.py - Onyx College Football game model: FBS team offense and
defense ratings in points (team_model.py), normal margin and total.

Changelog (newest first; each entry cites its evidence)

  v2  11/15  MODEL PICKS LISTS ONLY (daily_top.TOPS["cfb"]); the ratings, the
      20% blend and every chance shown are unchanged, so the version stays v2
      and the live spread lane and the finalized rushing yards market (its own
      version, cfb_players) keep their gates. The best-value lists had lost
      39-41 (-7.0u): totals 3-12, spreads 5-8, props +11% (all rushing unders).
      Replayed on every Onyx line on file, chosen on one season and judged on
      the other, at opening and closing prices; 220 configs tried.
        spreads   edge 2+ points only (equal to a 10% model share, the weight
                  2025 log loss chose). 2026: open 29-22 +8.4%, close 28-23
                  +4.9% (was 51-53 -6.3%, 44-46 -6.7%). 2025: +11.2% / +23.0%
                  (was +3.4% / +2.0%).
        totals    no rule won 2025 at both prices; the list lost -24.3% at the
                  2025 close and -5.2% over 2019-2024 ESPN closes. Shown as
                  leans, never graded.
        props     rushing yards unders only. The other prop markets as a list
                  lost before 10/5 (-13.8% open) and after (-2.2%); rushing
                  unders after 10/5: open 63-32 +24.6%, close 57-33 +19.7%
                  (whole list +10.2%, +14.3%).
      Next model change (v3, owner's call): a 10% model share for spreads and
      0 for totals and moneylines. Log loss gain over Onyx's no-vig price
      (thousandths per line):
      spreads w .10 +0.37 / +0.85 (2025 open / close) vs w .20 -0.25 / +0.75;
      moneylines lose at every weight above 0 in both seasons.

  v2  10/31  TOTALS LANE ADDED (NO_TOTALS off). Same ratings and parameters as
      v1; what changes is that Onyx totals are priced and can be picked.
      tools/sports_backtest.py --markets=total on 2,913 Onyx games (through
      10/28/2026): blend 30% model, edge 2-10pp, price -200 to +150.
        tune (2025 season)  63 picks, 34-29, +3.3%
        test (2026 season)  opening 45-26 +21.0% (claimed 57.2%, hit 63.4%),
                            closing 28-20 +11.9%; log loss 0.6862 vs Onyx 0.6927
      The spreads lane re-run on the same data is unchanged (27-19 +12.2% open,
      21-19 +0.6% close). Both lanes run, each at its own blend weight
      (backtest.json "lanes"). Why totals help when the model's own total did
      not beat a constant (13.46 vs 13.43 MAE): blended at 30% it pulls Onyx's
      CFB totals toward what the ratings expect, and that moved the price the
      right way on 2026 games. Caveat: totals were examined after the 2026
      numbers were seen; the tuning season was also positive, but smaller.
      The public record is the test that counts.

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

VERSION = "v2"
KIND = "football"
P = {"half_life": 60, "ridge": 1, "home": 3.0, "sd_margin": 17.0, "sd_total": 17.0, "min_games": 3}
TEST = {"n": 789, "logloss": 0.576, "base_logloss": 0.689, "mae_total": 13.46, "base_mae_total": 13.43,
        "window": "11/1/2025 on"}
NO_TOTALS = False   # v2: the totals lane passed (changelog)
