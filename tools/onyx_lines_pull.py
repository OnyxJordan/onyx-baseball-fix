#!/usr/bin/env python3
"""
onyx_lines_pull.py - historical Onyx main lines for a backtest (dev only;
run by the manual odds_probe.yml workflow with job=lines, which holds the
OpticOdds key). Never prints the key.

    python3 tools/onyx_lines_pull.py football nfl 2025-09-01 2026-10-26 \\
        player_passing_yards,player_rushing_yards,player_receiving_yards,player_receptions bt/nfl_lines.json

For every completed fixture in the window: start, teams, final score, and per
player and market the Onyx main line at open and at close,
  {"o": [line, over, under], "c": [line, over, under]}
Game markets (moneyline, spreads, totals) land in "game":
  {market: {selection: {"o": [points, price], "c": [points, price]}}}
with totals keyed "over" / "under".
from /fixtures/odds/historical (olv / clv), the endpoint tools/nba_backtest_pull.py
uses for the NBA backtest.
"""
import json, os, sys, time, urllib.parse
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}
YES_MARKETS = {"first_basket_including_ft", "first_touchdown_scorer", "anytime_touchdown_scorer",
               "first_goal_scorer", "anytime_goal_scorer", "player_home_runs_yes_no"}
GAME = {"moneyline", "point_spread", "puck_line", "game_spread", "run_line",
        "total_points", "total_goals", "total_games", "total_runs"}


def main():
    sport, league, d0, d1, markets, out = sys.argv[1:7]
    markets = [m for m in markets.split(",") if m]
    q = f"sport={sport}&league={league}"

    def get(path, params=""):
        for attempt in range(6):
            try:
                return http_json(f"{OPTIC}{path}?{q}{params}", headers=H)
            except Exception as e:
                if "429" in str(e) and attempt < 5:
                    time.sleep(5 * (attempt + 1))
                    continue
                print("ERR", path, str(e)[:160])
                return None
            finally:
                time.sleep(0.2)

    games = {}
    d, end = date.fromisoformat(d0), date.fromisoformat(d1)
    while d <= end:
        for f in (get("/fixtures", f"&start_date={d.isoformat()}") or {}).get("data") or []:
            if str(f.get("status")).lower() != "completed":
                continue
            sc = (f.get("result") or {}).get("scores") or {}
            games[f["id"]] = {"start": f.get("start_date"), "season_type": f.get("season_type"),
                              "week": f.get("week"),
                              "home": ((f.get("home_competitors") or [{}])[0]).get("name"),
                              "away": ((f.get("away_competitors") or [{}])[0]).get("name"),
                              "hs": (sc.get("home") or {}).get("total"), "as": (sc.get("away") or {}).get("total")}
        d += timedelta(days=1)
    print("completed fixtures", len(games))

    mk = "".join(f"&market={m}" for m in markets)
    n_props = 0
    for fid, g in games.items():
        r = get("/fixtures/odds/historical", f"&fixture_id={urllib.parse.quote(fid)}&sportsbook=onyx_odds"
                                             f"&odds_format=AMERICAN{mk}")
        rows = (r or {}).get("data") or []
        props, game = {}, {}
        for od in (rows[0].get("odds") if rows else None) or []:
            m, side, who = od.get("market_id"), str(od.get("selection_line") or "").lower(), od.get("selection")
            # yes-only player markets (first basket, first / anytime TD) carry no over / under
            # and no main line: store the "yes" price where an over would go, "no" as the under
            if m in YES_MARKETS and m in markets and who:
                e = props.setdefault(who, {}).setdefault(m, {"o": [None, None, None], "c": [None, None, None]})
                j = 2 if side == "no" else 1
                for key, v in (("o", od.get("olv") or {}), ("c", od.get("clv") or {})):
                    e[key][j] = v.get("price")
                continue
            if not od.get("is_main"):
                continue
            if m in GAME:
                key = side if side in ("over", "under") else (who or od.get("name"))
                if key:
                    o, c = od.get("olv") or {}, od.get("clv") or {}
                    game.setdefault(m, {})[key] = {"o": [o.get("points"), o.get("price")], "c": [c.get("points"), c.get("price")]}
                continue
            if m not in markets or side not in ("over", "under") or not who:
                continue
            e = props.setdefault(who, {}).setdefault(m, {"o": [None, None, None], "c": [None, None, None]})
            j = 1 if side == "over" else 2
            for key, v in (("o", od.get("olv") or {}), ("c", od.get("clv") or {})):
                if v.get("points") is not None:
                    e[key][0] = v["points"]
                e[key][j] = v.get("price")
        g["props"] = props
        g["game"] = game
        n_props += sum(len(v) for v in props.values())
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    json.dump(games, open(out, "w"))
    print(f"wrote {out}: {len(games)} fixtures, {sum(1 for g in games.values() if g['props'] or g['game'])} with Onyx lines, "
          f"{n_props} player-market lines, {sum(1 for g in games.values() if g['game'])} with game lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
