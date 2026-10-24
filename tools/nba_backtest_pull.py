#!/usr/bin/env python3
"""Dev-only (temporary): historical Onyx main lines for every 2025-26 NBA
regular-season game (opening + closing), for the prop backtest.
Reads bt/games.json from the first pull's artifact list of ids (re-fetched
here from /fixtures) and writes bt/lines.json:
  {fixture_id: {"total": [open, close], "spread_home": [open, close],
                "props": {player name: {stat: {"o": [line, over, under],
                                               "c": [line, over, under]}}}}}
Never prints the key."""
import json, os, sys, time, urllib.parse
from datetime import date, timedelta
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC

H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}
Q = "sport=basketball&league=nba"
STAT = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast"}
os.makedirs("bt", exist_ok=True)

def get(path, params=""):
    for attempt in range(6):
        try:
            return http_json(f"{OPTIC}{path}?{Q}{params}", headers=H)
        except Exception as e:
            if "HTTP 429" in str(e) and attempt < 5:
                time.sleep(5 * (attempt + 1)); continue
            print("ERR", path, str(e)[:160]); return None
        finally:
            time.sleep(0.2)

ids, d = [], date(2025, 10, 21)
while d <= date(2026, 4, 12):
    for f in (get("/fixtures", f"&start_date={d.isoformat()}") or {}).get("data") or []:
        if str(f.get("status")).lower() == "completed" and "regular" in str(f.get("season_type") or "").lower():
            ids.append((f["id"], ((f.get("home_competitors") or [{}])[0]).get("name")))
    d += timedelta(days=1)
print("fixtures", len(ids))

mk = "".join(f"&market={m}" for m in list(STAT) + ["total_points", "point_spread"])
out = {}
for i, (fid, home) in enumerate(ids):
    r = get("/fixtures/odds/historical", f"&fixture_id={urllib.parse.quote(fid)}&sportsbook=onyx_odds&odds_format=AMERICAN{mk}")
    rows = (r or {}).get("data") or []
    if not rows:
        continue
    g = {"props": {}}
    for od in rows[0].get("odds") or []:
        if not od.get("is_main"):
            continue
        m, side = od.get("market_id"), str(od.get("selection_line") or "").lower()
        o, c = od.get("olv") or {}, od.get("clv") or {}
        if m in STAT and side in ("over", "under") and od.get("selection"):
            e = g["props"].setdefault(od["selection"], {}).setdefault(STAT[m], {"o": [None, None, None], "c": [None, None, None]})
            j = 1 if side == "over" else 2
            for key, v in (("o", o), ("c", c)):
                if v.get("points") is not None:
                    e[key][0] = v["points"]
                e[key][j] = v.get("price")
        elif m == "total_points" and side == "over":
            g["total"] = [o.get("points"), c.get("points")]
        elif m == "point_spread" and od.get("selection") == home:
            g["spread_home"] = [o.get("points"), c.get("points")]
    out[fid] = g
    if i % 100 == 0:
        print("progress", i, len(out))
print("games with lines", len(out), "props", sum(len(v["props"]) for v in out.values()))
json.dump(out, open("bt/lines.json", "w"))
