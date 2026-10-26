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
from /fixtures/odds/historical (olv / clv), the endpoint tools/nba_backtest_pull.py
uses for the NBA backtest.
"""
import json, os, sys, time, urllib.parse
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}


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
        props = {}
        for od in (rows[0].get("odds") if rows else None) or []:
            if not od.get("is_main"):
                continue
            m, side, who = od.get("market_id"), str(od.get("selection_line") or "").lower(), od.get("selection")
            if m not in markets or side not in ("over", "under") or not who:
                continue
            e = props.setdefault(who, {}).setdefault(m, {"o": [None, None, None], "c": [None, None, None]})
            j = 1 if side == "over" else 2
            for key, v in (("o", od.get("olv") or {}), ("c", od.get("clv") or {})):
                if v.get("points") is not None:
                    e[key][0] = v["points"]
                e[key][j] = v.get("price")
        g["props"] = props
        n_props += sum(len(v) for v in props.values())
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    json.dump(games, open(out, "w"))
    print(f"wrote {out}: {len(games)} fixtures, {sum(1 for g in games.values() if g['props'])} with Onyx lines, {n_props} player-market lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
