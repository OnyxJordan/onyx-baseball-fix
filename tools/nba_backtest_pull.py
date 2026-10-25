#!/usr/bin/env python3
"""
nba_backtest_pull.py - data for tools/nba_backtest.py (dev only; runs from
the manual "NBA backtest data" workflow because it needs OPTICODDS_API_KEY).

Writes bt/:
  games.json  every completed regular-season fixture, 2024-25 and 2025-26
  box.json    one row per player-game (OpticOdds /fixtures/player-results)
  lines.json  historical Onyx main lines for 2025-26 (/fixtures/odds/historical,
              open + close): player points / rebounds / assists, game total,
              home spread
Roughly 1,500 + 600 + 1,200 calls; ~25 minutes. Never prints the key.
"""
import json, os, sys, time, urllib.parse
from datetime import date, timedelta
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC

H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}
Q = "sport=basketball&league=nba"
STAT = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast"}
SEASONS = [(date(2024, 10, 22), date(2025, 4, 13)), (date(2025, 10, 21), date(2026, 4, 12))]
LINES_FROM = "2025-10-01"
os.makedirs("bt", exist_ok=True)


def get(path, params=""):
    for attempt in range(6):
        try:
            return http_json(f"{OPTIC}{path}?{Q}{params}", headers=H)
        except Exception as e:
            if "HTTP 429" in str(e) and attempt < 5:
                time.sleep(5 * (attempt + 1))
                continue
            print("ERR", path, str(e)[:160])
            return None
        finally:
            time.sleep(0.2)


games = {}
for a, b in SEASONS:
    d = a
    while d <= b:
        for f in (get("/fixtures", f"&start_date={d.isoformat()}") or {}).get("data") or []:
            if str(f.get("status")).lower() != "completed":
                continue
            if "regular" not in str(f.get("season_type") or "").lower():
                continue
            sc = (f.get("result") or {}).get("scores") or {}
            games[f["id"]] = {"id": f["id"], "start": f.get("start_date"),
                              "home": ((f.get("home_competitors") or [{}])[0]).get("name"),
                              "away": ((f.get("away_competitors") or [{}])[0]).get("name"),
                              "hs": (sc.get("home") or {}).get("total"), "as": (sc.get("away") or {}).get("total")}
        d += timedelta(days=1)
print("games", len(games))
json.dump(games, open("bt/games.json", "w"))

box, ids = [], sorted(games)
for i in range(0, len(ids), 4):
    r = get("/fixtures/player-results", "".join(f"&fixture_id={urllib.parse.quote(x)}" for x in ids[i:i + 4])) or {}
    for row in r.get("data") or []:
        fid = (row.get("fixture") or {}).get("id")
        for res in row.get("results") or []:
            st = next((s.get("stats") or {} for s in res.get("stats") or [] if s.get("period") == "all"), {})
            pl, tm = res.get("player") or {}, res.get("team") or {}
            box.append([fid, pl.get("id"), pl.get("name"), pl.get("position"), tm.get("name"),
                        int(bool(res.get("is_starter"))), st.get("minutes"), st.get("seconds"),
                        st.get("points"), st.get("total_rebounds"), st.get("assists"),
                        st.get("three_point_field_goals_made"), st.get("field_goals_attempted"),
                        st.get("free_throws_attempted"), st.get("offensive_rebounds"), st.get("turnovers"),
                        st.get("plus_minus"), st.get("defensive_rebounds")])
print("box rows", len(box))
json.dump(box, open("bt/box.json", "w"))

mk = "".join(f"&market={m}" for m in list(STAT) + ["total_points", "point_spread"])
lines = {}
for fid in ids:
    g = games[fid]
    if (g.get("start") or "") < LINES_FROM:
        continue
    r = get("/fixtures/odds/historical", f"&fixture_id={urllib.parse.quote(fid)}&sportsbook=onyx_odds"
                                         f"&odds_format=AMERICAN{mk}")
    rows = (r or {}).get("data") or []
    if not rows:
        continue
    out = {"props": {}}
    for od in rows[0].get("odds") or []:
        if not od.get("is_main"):
            continue
        m, side = od.get("market_id"), str(od.get("selection_line") or "").lower()
        o, c = od.get("olv") or {}, od.get("clv") or {}
        if m in STAT and side in ("over", "under") and od.get("selection"):
            e = out["props"].setdefault(od["selection"], {}).setdefault(
                STAT[m], {"o": [None, None, None], "c": [None, None, None]})
            j = 1 if side == "over" else 2
            for key, v in (("o", o), ("c", c)):
                if v.get("points") is not None:
                    e[key][0] = v["points"]
                e[key][j] = v.get("price")
        elif m == "total_points" and side == "over":
            out["total"] = [o.get("points"), c.get("points")]
        elif m == "point_spread" and od.get("selection") == g["home"]:
            out["spread_home"] = [o.get("points"), c.get("points")]
    lines[fid] = out
print("games with Onyx lines", len(lines), "props", sum(len(v["props"]) for v in lines.values()))
json.dump(lines, open("bt/lines.json", "w"))
