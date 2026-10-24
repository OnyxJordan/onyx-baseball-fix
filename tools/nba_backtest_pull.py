#!/usr/bin/env python3
"""Dev-only (temporary): pull two seasons of NBA box scores from OpticOdds
for the projection backtest, and probe whether historical prop lines exist.
Writes bt/games.json, bt/box.json, bt/odds_probe.json. Never prints the key."""
import json, os, sys, time, urllib.parse
from datetime import date, timedelta
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC

KEY = os.environ.get("OPTICODDS_API_KEY", "").strip()
Q = "sport=basketball&league=nba"
os.makedirs("bt", exist_ok=True)

def get(path, params=""):
    url = f"{OPTIC}{path}?{Q}{params}"
    for attempt in range(6):
        try:
            return http_json(url, headers={"X-Api-Key": KEY})
        except Exception as e:
            if "HTTP 429" in str(e) and attempt < 5:
                time.sleep(5 * (attempt + 1)); continue
            print("ERR", path, str(e)[:200]); return None
        finally:
            time.sleep(0.25)

SEASONS = [(date(2024, 10, 22), date(2025, 4, 13)), (date(2025, 10, 21), date(2026, 4, 12))]
games = {}
for a, b in SEASONS:
    d = a
    while d <= b:
        r = get("/fixtures", f"&start_date={d.isoformat()}") or {}
        for f in r.get("data") or []:
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

box = []
ids = sorted(games)
for i in range(0, len(ids), 4):
    r = get("/fixtures/player-results", "".join(f"&fixture_id={urllib.parse.quote(x)}" for x in ids[i:i + 4])) or {}
    for row in r.get("data") or []:
        fid = (row.get("fixture") or {}).get("id")
        for res in row.get("results") or []:
            st = next((s.get("stats") or {} for s in res.get("stats") or [] if s.get("period") == "all"), {})
            box.append([fid, (res.get("player") or {}).get("id"), (res.get("player") or {}).get("name"),
                        (res.get("player") or {}).get("position"), (res.get("team") or {}).get("name"),
                        int(bool(res.get("is_starter"))), st.get("minutes"), st.get("seconds"),
                        st.get("points"), st.get("total_rebounds"), st.get("assists"),
                        st.get("three_point_field_goals_made"), st.get("field_goals_attempted"),
                        st.get("free_throws_attempted"), st.get("offensive_rebounds"), st.get("turnovers")])
    if i % 200 == 0:
        print("box progress", i, len(box))
print("box rows", len(box))
json.dump(box, open("bt/box.json", "w"))

# historical odds probe: does OpticOdds keep closing prop lines, and for which books?
probe = {}
late = [g for g in ids if g.startswith("2026")][-3:] + [g for g in ids if g.startswith("2025")][-3:]
for fid in late:
    for book in ("onyx_odds", "draftkings", "fanduel"):
        for path in ("/fixtures/odds/historical", "/fixtures/odds"):
            r = get(path, f"&fixture_id={fid}&sportsbook={book}&market=player_points&odds_format=AMERICAN")
            rows = (r or {}).get("data") or []
            n = sum(len(x.get("odds") or []) for x in rows) if isinstance(rows, list) else 0
            sample = json.dumps(rows[0], default=str)[:900] if rows else (json.dumps(r, default=str)[:300] if r else None)
            probe[f"{fid}|{book}|{path}"] = {"n": n, "sample": sample}
            print("odds probe", fid, book, path, n)
json.dump(probe, open("bt/odds_probe.json", "w"))
