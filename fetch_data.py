"""
fetch_data.py — Onyx Baseball daily data fetcher v2
Pulls: MLB lineups (confirmed OR projected from rosters), HR odds, weather, Statcast L14

Strategy for lineups:
  1. Try confirmed lineups from MLB Stats API (available ~1hr before first pitch)
  2. Fall back to recent game batting orders per player (last 7 days)
  3. Fall back to team roster with position-based default batting orders

This guarantees the site always populates even at 11:30 AM when lineups aren't out yet.

Usage:  python3 fetch_data.py
Output: data/lineups.json, data/odds.json, data/weather.json,
        data/statcast_l14.json, data/pitchers_l14.json
"""

import os, json, time, requests, csv, io, datetime, math
from pathlib import Path
from collections import defaultdict

OUT = Path("data")
OUT.mkdir(exist_ok=True)

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")

# Stadium GPS + park names keyed by MLB team abbreviation
STADIUMS = {
    "PIT": ("PNC Park",                40.4469, -80.0057, False),
    "TOR": ("Rogers Centre",           43.6414, -79.3894, True),
    "DET": ("Comerica Park",           42.3390, -83.0485, False),
    "BAL": ("Camden Yards",            39.2838, -76.6218, False),
    "MIN": ("Target Field",            44.9817, -93.2783, False),
    "BOS": ("Fenway Park",             42.3467, -71.0972, False),
    "TB":  ("Tropicana Field",         27.7683, -82.6534, True),
    "NYY": ("Yankee Stadium",          40.8296, -73.9262, False),
    "CLE": ("Progressive Field",       41.4954, -81.6854, False),
    "PHI": ("Citizens Bank Park",      39.9061, -75.1665, False),
    "NYM": ("Citi Field",              40.7571, -73.8458, False),
    "MIA": ("loanDepot Park",          25.7781, -80.2197, True),
    "STL": ("Busch Stadium",           38.6226, -90.1928, False),
    "CIN": ("Great American Ball Park",39.0979, -84.5082, False),
    "LAD": ("Dodger Stadium",          34.0739,-118.2400, False),
    "MIL": ("American Family Field",   43.0282, -87.9712, True),
    "SEA": ("T-Mobile Park",           47.5914,-122.3325, False),
    "KC":  ("Kauffman Stadium",        39.0517, -94.4803, False),
    "HOU": ("Minute Maid Park",        29.7573, -95.3555, True),
    "CHC": ("Wrigley Field",           41.9484, -87.6553, False),
    "CWS": ("Guaranteed Rate Field",   41.8300, -87.6339, False),
    "SF":  ("Oracle Park",             37.7786,-122.3893, False),
    "COL": ("Coors Field",             39.7559,-104.9942, False),
    "ARI": ("Chase Field",             33.4453,-112.0667, True),
    "WAS": ("Nationals Park",          38.8730, -77.0074, False),
    "ATL": ("Truist Park",             33.8908, -84.4678, False),
    "OAK": ("Oakland Coliseum",        37.7516,-122.2005, False),
    "SD":  ("Petco Park",              32.7076,-117.1570, False),
    "TEX": ("Globe Life Field",        32.7473, -97.0845, True),
    "LAA": ("Angel Stadium",           33.8003,-117.8827, False),
}

# MLB team ID → abbreviation (for Stats API responses)
TEAM_ID_TO_ABBR = {
    109:"ARI",110:"BAL",111:"BOS",112:"CHC",113:"CIN",114:"CLE",115:"COL",
    116:"DET",117:"HOU",118:"KC",119:"LAD",120:"WAS",121:"NYM",133:"OAK",
    134:"PIT",135:"SD",136:"SEA",137:"SF",138:"STL",139:"TB",140:"TEX",
    141:"TOR",142:"MIN",143:"PHI",144:"ATL",145:"CWS",146:"MIA",147:"NYY",
    158:"MIL",108:"LAA",
}

# Default batting order by position (if all else fails)
POS_DEFAULT_ORDER = {
    "CF":2,"SS":2,"2B":2,"3B":3,"1B":4,"LF":4,"RF":5,"DH":4,"C":7,"OF":5,"P":9
}

# ── HELPERS ────────────────────────────────────────────────────────────────────
def mlb_get(path, params=None):
    url = f"https://statsapi.mlb.com/api/v1{path}"
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()

def player_name_key(name):
    return name.lower().strip()

# ── 1. TODAYS SCHEDULE ────────────────────────────────────────────────────────
def fetch_schedule():
    today = datetime.date.today().strftime("%Y-%m-%d")
    data = mlb_get("/schedule", {
        "sportId": 1,
        "date": today,
        "hydrate": "lineups,probablePitcher,team,linescore,weather",
    })
    games = []
    for date_entry in data.get("dates", []):
        for g in date_entry.get("games", []):
            status = g.get("status", {}).get("abstractGameState", "")
            if status == "Final":
                continue
            games.append(g)
    print(f"  Schedule: {len(games)} games today")
    return games

# ── 2. RECENT BATTING ORDERS (last 7 days, per team) ─────────────────────────
def fetch_recent_batting_orders():
    """Returns {team_abbr: {player_name_key: avg_batting_order}}"""
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=7)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")

    print("  Fetching recent batting orders (last 7 days)...")
    data = mlb_get("/schedule", {
        "sportId": 1,
        "startDate": start,
        "endDate": end,
        "hydrate": "lineups,team",
        "gameType": "R",
    })

    team_orders = defaultdict(lambda: defaultdict(list))

    for date_entry in data.get("dates", []):
        for g in date_entry.get("games", []):
            lineups = g.get("lineups", {})
            if not lineups:
                continue
            away_id = g["teams"]["away"]["team"]["id"]
            home_id = g["teams"]["home"]["team"]["id"]
            away_abbr = TEAM_ID_TO_ABBR.get(away_id, "")
            home_abbr = TEAM_ID_TO_ABBR.get(home_id, "")

            for player in lineups.get("awayPlayers", []):
                name = player_name_key(player.get("fullName", ""))
                bo = player.get("battingOrder", 0) // 100
                if name and 1 <= bo <= 9:
                    team_orders[away_abbr][name].append(bo)

            for player in lineups.get("homePlayers", []):
                name = player_name_key(player.get("fullName", ""))
                bo = player.get("battingOrder", 0) // 100
                if name and 1 <= bo <= 9:
                    team_orders[home_abbr][name].append(bo)

    # Average the batting orders
    avg_orders = {}
    for team, players in team_orders.items():
        avg_orders[team] = {name: round(sum(orders)/len(orders)) for name, orders in players.items()}

    print(f"  Recent batting orders: {sum(len(v) for v in avg_orders.values())} player-entries across {len(avg_orders)} teams")
    return avg_orders

# ── 3. TEAM ROSTERS (fallback) ─────────────────────────────────────────────────
def fetch_roster(team_id):
    """Get active 40-man roster for a team."""
    try:
        data = mlb_get(f"/teams/{team_id}/roster", {"rosterType": "active"})
        return [
            {
                "name": p["person"]["fullName"],
                "pos": p.get("position", {}).get("abbreviation", "OF"),
            }
            for p in data.get("roster", [])
            if p.get("position", {}).get("abbreviation", "P") != "P"  # exclude pitchers from lineup
        ]
    except Exception as e:
        print(f"    Roster fetch error for team {team_id}: {e}")
        return []

# ── 4. BUILD LINEUP (confirmed → recent orders → roster) ─────────────────────
def build_lineup(game, recent_orders, away_or_home):
    """
    Returns list of {name, pos, batting_order} for one side of a game.
    Priority: confirmed lineup → recent batting order history → roster fallback.
    """
    team_data = game["teams"][away_or_home]
    team_id   = team_data["team"]["id"]
    team_abbr = TEAM_ID_TO_ABBR.get(team_id, "")

    # Try confirmed lineup first
    lineups = game.get("lineups", {})
    key = "awayPlayers" if away_or_home == "away" else "homePlayers"
    confirmed = lineups.get(key, [])

    if confirmed:
        result = []
        for p in confirmed:
            name = p.get("fullName", "")
            pos  = p.get("position", {}).get("abbreviation", "OF")
            bo   = p.get("battingOrder", 500) // 100
            if not name or pos == "P": continue
            result.append({"name": name, "pos": pos, "batting_order": max(1, min(9, bo))})
        if result:
            return result, team_abbr, True  # confirmed=True

    # Fall back: use roster + recent batting orders
    roster = fetch_roster(team_id)
    team_recent = recent_orders.get(team_abbr, {})

    players = []
    for p in roster:
        name = p["name"]
        pos  = p["pos"]
        nk   = player_name_key(name)
        # Look up recent batting order, fall back to position default
        bo = team_recent.get(nk) or POS_DEFAULT_ORDER.get(pos, 6)
        players.append({"name": name, "pos": pos, "batting_order": bo, "_nk": nk})

    # Sort by batting order, deduplicate by closest to typical order
    players.sort(key=lambda x: x["batting_order"])

    # Take top 9 (excluding pure pitchers already filtered)
    # Prefer players with recent batting order data
    has_recent = [p for p in players if player_name_key(p["name"]) in team_recent]
    no_recent  = [p for p in players if player_name_key(p["name"]) not in team_recent]

    lineup = has_recent[:9]
    if len(lineup) < 9:
        lineup += no_recent[:9 - len(lineup)]

    # Re-assign batting orders 1-9 cleanly
    lineup = lineup[:9]
    for i, p in enumerate(lineup):
        p["batting_order"] = i + 1
        p.pop("_nk", None)

    return lineup, team_abbr, False  # confirmed=False (projected)

# ── 5. MAIN LINEUP FETCH ──────────────────────────────────────────────────────
def fetch_lineups():
    print("Fetching lineups...")
    games_raw  = fetch_schedule()
    recent_orders = fetch_recent_batting_orders()

    games = {}
    for g in games_raw:
        away_id   = g["teams"]["away"]["team"]["id"]
        home_id   = g["teams"]["home"]["team"]["id"]
        away_abbr = TEAM_ID_TO_ABBR.get(away_id, str(away_id))
        home_abbr = TEAM_ID_TO_ABBR.get(home_id, str(home_id))
        game_key  = f"{away_abbr}_{home_abbr}"

        away_pitcher = g["teams"]["away"].get("probablePitcher", {}).get("fullName", "TBD")
        home_pitcher = g["teams"]["home"].get("probablePitcher", {}).get("fullName", "TBD")

        away_lineup, _, away_confirmed = build_lineup(g, recent_orders, "away")
        home_lineup, _, home_confirmed = build_lineup(g, recent_orders, "home")

        game_time = g.get("gameDate", "")
        status    = g.get("status", {}).get("detailedState", "")

        games[game_key] = {
            "game_key":       game_key,
            "game_id":        g["gamePk"],
            "game_time":      game_time,
            "away_team":      away_abbr,
            "home_team":      home_abbr,
            "away_pitcher":   away_pitcher,
            "home_pitcher":   home_pitcher,
            "away_lineup":    away_lineup,
            "home_lineup":    home_lineup,
            "away_confirmed": away_confirmed,
            "home_confirmed": home_confirmed,
            "status":         status,
        }
        conf = "✓" if (away_confirmed and home_confirmed) else "~projected"
        print(f"  {game_key:12s}  {away_pitcher:20s} vs {home_pitcher:20s}  [{conf}]")

    print(f"\n  Total: {len(games)} games, "
          f"{sum(1 for g in games.values() if g['away_confirmed'] and g['home_confirmed'])} fully confirmed")

    with open(OUT / "lineups.json", "w") as f:
        json.dump(games, f, indent=2)
    return games

# ── 6. HR ODDS ────────────────────────────────────────────────────────────────
def fetch_odds():
    print("Fetching HR odds from The Odds API...")
    if not ODDS_API_KEY:
        print("  WARNING: ODDS_API_KEY not set.")
        with open(OUT / "odds.json", "w") as f:
            json.dump({}, f)
        return {}

    today_str = datetime.date.today().isoformat()
    odds_map  = {}

    try:
        events_url = "https://api.the-odds-api.com/v4/sports/baseball_mlb/events"
        r = requests.get(events_url, params={"apiKey": ODDS_API_KEY, "dateFormat": "iso"}, timeout=15)
        r.raise_for_status()
        events = r.json()
    except Exception as e:
        print(f"  Events error: {e}")
        with open(OUT / "odds.json", "w") as f:
            json.dump({}, f)
        return {}

    for event in events:
        if event.get("commence_time", "")[:10] != today_str:
            continue
        event_id = event["id"]
        try:
            r2 = requests.get(
                f"https://api.the-odds-api.com/v4/sports/baseball_mlb/events/{event_id}/odds",
                params={
                    "apiKey":      ODDS_API_KEY,
                    "regions":     "us",
                    "markets":     "batter_home_runs",
                    "bookmakers":  "draftkings",
                    "oddsFormat":  "american",
                },
                timeout=15,
            )
            r2.raise_for_status()
            prop_data = r2.json()
        except Exception as e:
            print(f"  Props error: {e}")
            continue

        for bm in prop_data.get("bookmakers", []):
            if bm["key"] != "draftkings":
                continue
            for market in bm.get("markets", []):
                if market["key"] != "batter_home_runs":
                    continue
                for outcome in market.get("outcomes", []):
                    if outcome["name"] == "Over" and outcome.get("point", 0) < 1.5:
                        player = outcome["description"].lower().strip()
                        odds_map[player] = outcome["price"]
        time.sleep(0.25)

    print(f"  Odds: {len(odds_map)} players")
    with open(OUT / "odds.json", "w") as f:
        json.dump(odds_map, f, indent=2)
    return odds_map

# ── 7. WEATHER ────────────────────────────────────────────────────────────────
def deg_to_compass(deg):
    dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return dirs[round(deg / 22.5) % 16]

def fetch_weather(games):
    print("Fetching weather from Open-Meteo...")
    weather = {}
    home_teams = {g["home_team"] for g in games.values()}

    # Try to pick the right hour index based on game time
    for team in home_teams:
        if team not in STADIUMS:
            continue
        park_name, lat, lon, roof = STADIUMS[team]

        # Find earliest game for this home team to pick weather hour
        game_hour = 14  # default 2pm local
        for g in games.values():
            if g["home_team"] == team and g.get("game_time"):
                try:
                    dt = datetime.datetime.fromisoformat(g["game_time"].replace("Z","+00:00"))
                    eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
                    game_hour = eastern.hour
                    break
                except: pass

        try:
            r = requests.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude":         lat,
                "longitude":        lon,
                "hourly":           "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m",
                "temperature_unit": "fahrenheit",
                "wind_speed_unit":  "mph",
                "forecast_days":    1,
                "timezone":         "America/New_York",
            }, timeout=10)
            r.raise_for_status()
            h = r.json().get("hourly", {})
            idx = min(game_hour, 23)
            weather[team] = {
                "park":       park_name,
                "temp":       h.get("temperature_2m",       [72]*24)[idx],
                "precip_pct": h.get("precipitation_probability", [0]*24)[idx],
                "wind_mph":   h.get("wind_speed_10m",       [5]*24)[idx],
                "wind_dir":   deg_to_compass(h.get("wind_direction_10m", [180]*24)[idx]),
                "roof":       roof,
            }
        except Exception as e:
            print(f"  Weather error {team}: {e}")
            weather[team] = {"park": park_name, "temp":72,"precip_pct":0,"wind_mph":5,"wind_dir":"N","roof":roof}
        time.sleep(0.1)

    print(f"  Weather: {len(weather)} stadiums")
    with open(OUT / "weather.json", "w") as f:
        json.dump(weather, f, indent=2)
    return weather

# ── 8. STATCAST L14 ───────────────────────────────────────────────────────────
def fetch_statcast():
    print("Fetching Statcast L14 hitter data...")
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")

    url = (
        "https://baseballsavant.mlb.com/statcast_search/csv"
        f"?all=true&player_type=batter&hfGT=R%7C&hfSea=2026%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
        f"&min_abs=5&group_by=name&sort_col=pitches&sort_order=desc&type=details&"
    )

    statcast = {}
    try:
        r = requests.get(url, timeout=45)
        r.raise_for_status()
        reader = csv.DictReader(io.StringIO(r.text))
        agg = defaultdict(lambda: {"pa":0,"hr":0,"ev_sum":0,"ev_n":0,"barrels":0,"hard_hits":0,"hits":0})

        for row in reader:
            raw = (row.get("player_name","") or "").strip()
            if not raw: continue
            # Savant format: "Last, First"
            if "," in raw:
                last, first = raw.split(",", 1)
                name = f"{first.strip()} {last.strip()}".lower()
            else:
                name = raw.lower()

            events = row.get("events","") or ""
            ev_s   = row.get("launch_speed","") or ""
            la_s   = row.get("launch_angle","") or ""

            agg[name]["pa"] += 1
            if events == "home_run": agg[name]["hr"] += 1
            if events in ("single","double","triple","home_run"): agg[name]["hits"] += 1
            try:
                ev = float(ev_s)
                agg[name]["ev_sum"] += ev
                agg[name]["ev_n"]   += 1
                if ev >= 95: agg[name]["hard_hits"] += 1
                la = float(la_s)
                if ev >= 98 and 26 <= la <= 30: agg[name]["barrels"] += 1
            except: pass

        for name, d in agg.items():
            pa = max(d["pa"], 1)
            statcast[name] = {
                "l14_pa":       d["pa"],
                "l14_hr":       d["hr"],
                "l14_rate":     round(d["hr"] / pa, 4),
                "l14_avg_ev":   round(d["ev_sum"] / d["ev_n"], 1) if d["ev_n"] else 90.0,
                "l14_barrel_pct": round(d["barrels"] / pa, 4),
                "l14_hh_pct":   round(d["hard_hits"] / pa, 4),
                "l14_hit_rate": round(d["hits"] / pa, 4),
            }
    except Exception as e:
        print(f"  Statcast hitter error: {e}")

    print(f"  Statcast hitters: {len(statcast)}")
    with open(OUT / "statcast_l14.json", "w") as f:
        json.dump(statcast, f, indent=2)
    return statcast

# ── 9. PITCHER L14 ────────────────────────────────────────────────────────────
def fetch_pitcher_statcast():
    print("Fetching Statcast L14 pitcher data...")
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")

    url = (
        "https://baseballsavant.mlb.com/statcast_search/csv"
        f"?all=true&player_type=pitcher&hfGT=R%7C&hfSea=2026%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
        f"&min_abs=10&group_by=name&sort_col=pitches&sort_order=desc&type=details&"
    )

    pitchers = {}
    try:
        r = requests.get(url, timeout=45)
        r.raise_for_status()
        reader = csv.DictReader(io.StringIO(r.text))
        agg = defaultdict(lambda: {"bf":0,"hr":0,"k":0,"bb":0})

        for row in reader:
            raw = (row.get("player_name","") or "").strip()
            if not raw: continue
            if "," in raw:
                last, first = raw.split(",", 1)
                name = f"{first.strip()} {last.strip()}".lower()
            else:
                name = raw.lower()
            events = row.get("events","") or ""
            agg[name]["bf"] += 1
            if events == "home_run": agg[name]["hr"] += 1
            if events in ("strikeout","strikeout_double_play"): agg[name]["k"] += 1
            if events == "walk": agg[name]["bb"] += 1

        for name, d in agg.items():
            bf = max(d["bf"], 1)
            pitchers[name] = {
                "l14_bf":      d["bf"],
                "l14_hr_rate": round(d["hr"] / bf, 4),
                "l14_k_rate":  round(d["k"]  / bf, 4),
                "l14_bb_rate": round(d["bb"] / bf, 4),
            }
    except Exception as e:
        print(f"  Statcast pitcher error: {e}")

    print(f"  Statcast pitchers: {len(pitchers)}")
    with open(OUT / "pitchers_l14.json", "w") as f:
        json.dump(pitchers, f, indent=2)
    return pitchers

# ── MAIN ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=== Onyx Baseball — Fetching data ===\n")
    games = fetch_lineups()
    fetch_odds()
    fetch_weather(games)
    fetch_statcast()
    fetch_pitcher_statcast()
    print("\n=== Done. Ready for auto_build.py ===")
