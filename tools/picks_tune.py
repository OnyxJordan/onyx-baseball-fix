#!/usr/bin/env python3
"""
picks_tune.py - tune each market's pick rule on its tuning months, judge it on games it never saw (dev only).

11/6 (Jordan: "run backtesting on what the picks would have been if we ran the same math through all sports
seasons and tune it until it's in a positive position across the board"). Tuning until the whole history is
positive would fit noise, so this keeps the held-out discipline of tools/picks_backtest.py:

  1. replay every market exactly as picks_backtest does, but keep EVERY priced side (the pick rule switched
     off), with its chance, its opening and closing price and the result;
  2. per market, try each rule in the grid (edge band, price band, expected return, side) on the TUNING months
     only, and keep the one with the best worst-of(open, close) ROI on 30+ tuning bets;
  3. judge that one rule once on the HELD-OUT months, by the same gate (60+ bets, +2% at the open and the
     close; opener markets at the open), and report every market: tuned rule, tuning and held-out results.

Writes tools/picks_tune.json (not data/picks/backtest.json: the official verdicts come only from
picks_backtest.py with the live rule). A rule that passes here becomes live only when it is put into the live
pick rule and picks_backtest.py re-judges it.

    python3 tools/picks_tune.py
"""
import itertools, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import picks_backtest as B    # noqa: E402
import daily_top as DT        # noqa: E402
import sports_lab as L        # noqa: E402

RAW = {}


def capture():
    """Every priced side reaches market(); market() keeps them instead of judging."""
    keep_ok = DT.ok
    DT.ok = lambda r: r.get("price") is not None and r.get("prob") is not None   # every priced side
    orig = B.market

    def market(sport, mkt, version, chance, source, split, rows_o, rows_c, held="", notes=""):
        RAW[(sport, mkt)] = {"split": split, "o": [r for r in rows_o if r], "c": [r for r in rows_c if r], "version": version}
        return orig(sport, mkt, version, chance, source, split, [], [], held, notes)
    B.market = market
    B.OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tune_scratch.json")
    try:
        B.main()
    finally:
        DT.ok = keep_ok
        B.market = orig


GRID = {"min_edge": [0.02, 0.03, 0.04, 0.05, 0.06], "max_edge": [0.08, 0.10, 0.12, 0.16],
        "price": [(-150, 200), (-200, 150), (-130, 130), (-120, 250), (-250, 120)], "min_ev": [0.0, 0.03, 0.05],
        "side": ["any", "over", "under"]}


def rule_ok(c, R):
    e = c["prob"] - L.implied(c["price"])
    return (R["price"][0] <= c["price"] <= R["price"][1] and R["min_edge"] <= e <= R["max_edge"] and c["prob"] >= 0.4
            and DT.ev(c["price"], c["prob"]) >= R["min_ev"] and (R["side"] == "any" or c.get("side") == R["side"]))


def run(rows, R, split, test):
    cs = [c for c in rows if (c["date"] >= split) == test and rule_ok(c, R)]
    return B.tally(B.card(cs))


def main():
    capture()
    out = []
    for (sport, mkt), v in sorted(RAW.items()):
        sides = {c.get("side") for c in v["o"]}
        grid = [dict(zip(GRID, x)) for x in itertools.product(*GRID.values())
                if x[0] < x[1] and (x[4] == "any" or x[4] in sides)]
        best, bk = None, None
        for R in grid:
            to, tc = run(v["o"], R, v["split"], False), run(v["c"], R, v["split"], False)
            if (to["n"] or 0) < B.TUNE_N or to["roi"] is None or tc["roi"] is None:
                continue
            score = to["roi"] if (sport, mkt) in B.OPENER else min(to["roi"], tc["roi"])
            if bk is None or score > bk:
                best, bk = (R, to, tc), score
        row = {"sport": sport, "market": mkt, "version": v["version"], "candidates": len(v["o"])}
        if not best:
            row.update(verdict="no rule with 30+ tuning bets")
            out.append(row)
            continue
        R, to, tc = best
        ho, hc = run(v["o"], R, v["split"], True), run(v["c"], R, v["split"], True)
        verdict, why = B.judge(ho, hc, to, tc, (sport, mkt) in B.OPENER)
        row.update(rule=R, tune={"open": to, "close": tc}, test={"open": ho, "close": hc}, verdict=verdict, why=why)
        out.append(row)
    json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "picks_tune.json"), "w"), indent=1)
    print(f"\n{'market':22s} {'tuned rule':44s} {'tuning open/close':20s} {'held-out open/close (n)':26s} verdict")
    for r in out:
        if "rule" not in r:
            print(f"{r['sport'] + ' ' + r['market']:22s} {r['verdict']}")
            continue
        R, t, h = r["rule"], r["tune"], r["test"]
        f = lambda x: "-" if x is None else f"{100 * x:+.1f}%"
        print(f"{r['sport'] + ' ' + r['market']:22s} edge {R['min_edge']:.2f}-{R['max_edge']:.2f} price {R['price'][0]}..{R['price'][1]} ev {R['min_ev']:.2f} {R['side']:5s}"
              f"  {f(t['open']['roi']):>7s}/{f(t['close']['roi']):<7s} ({t['open']['n']:3d})  {f(h['open']['roi']):>7s}/{f(h['close']['roi']):<7s} ({h['open']['n']:3d})  {r['verdict']}")


if __name__ == "__main__":
    main()
