"""
fetch_data.py — Onyx Baseball daily data fetcher v6
Odds:    reads data/odds.json directly (uploaded manually each morning)
Lineups: MLB Stats API with roster fallback
Weather: manual data/weather.json wins; falls back to Open-Meteo if missing
Statcast: reads data/fangraphs_l14.csv + data/fangraphs_pitchers_l14.csv (uploaded daily)
"""
import json, time, requests, csv, datetime
from pathlib import Path
from collections import defaultdict

OUT = Path("data")
OUT.mkdir(exist_ok=True)

# ── CONSTANTS ─────────────────────────────────────────────────────────────────
STADIUMS = {
    "PIT": ("PNC Park",                 40.4469,  -80.0057, False),
    "TOR": ("Rogers Centre",            43.6414,  -79.3894, True),
    "DET": ("Comerica Park",            42.3390,  -83.0485, False),
    "BAL": ("Camden Yards",             39.2838,  -76.6218, False),
    "MIN": ("Target Field",             44.9817,  -93.2783, False),
    "BOS": ("Fenway Park",              42.3467,  -71.0972, False),
    "TB":  ("Tropicana Field",          27.7683,  -82.6534, True),
    "NYY": ("Yankee Stadium",           40.8296,  -73.9262, False),
    "CLE": ("Progressive Field",        41.4954,  -81.6854, False),
    "PHI": ("Citizens Bank Park",       39.9061,  -75.1665, False),
    "NYM": ("Citi Field",               40.7571,  -73.8458, False),
    "MIA": ("loanDepot Park",           25.7781,  -80.2197, True),
    "STL": ("Busch Stadium",            38.6226,  -90.1928, False),
    "CIN": ("Great American Ball Park", 39.0979,  -84.5082, False),
    "LAD": ("Dodger Stadium",           34.0739, -118.2400, False),
    "MIL": ("American Family Field",    43.0282,  -87.9712, True),
    "SEA": ("T-Mobile Park",            47.5914, -122.3325, False),
    "KC":  ("Kauffman Stadium",         39.0517,  -94.4803, False),
    "HOU": ("Minute Maid Park",         29.7573,  -95.3555, True),
    "CHC": ("Wrigley Field",            41.9484,  -87.6553, False),
    "CWS": ("Guaranteed Rate Field",    41.8300,  -87.6339, False),
    "SF":  ("Oracle Park",              37.7786, -122.3893, False),
    "COL": ("Coors Field",              39.7559, -104.9942, False),
    "ARI": ("Chase Field",              33.4453, -112.0667, True),
    "WAS": ("Nationals Park",           38.8730,  -77.0074, False),
    "ATL": ("Truist Park",              33.8908,  -84.4678, False),
    "OAK": ("Oakland Coliseum",         37.7516, -122.2005, False),
    "SD":  ("Petco Park",               32.7076, -117.1570, False),
    "TEX": ("Globe Life Field",         32.7473,  -97.0845, True),
    "LAA": ("Angel Stadium",            33.8003, -117.8827, False),
}

TEAM_ID_TO_ABBR = {
    108:"LAA", 109:"ARI", 110:"BAL", 111:"BOS", 112:"CHC", 113:"CIN",
    114:"CLE", 115:"COL", 116:"DET", 117:"HOU", 118:"KC",  119:"LAD",
    120:"WAS", 121:"NYM", 133:"OAK", 134:"PIT", 135:"SD",  136:"SEA",
    137:"SF",  138:"STL", 139:"TB",  140:"TEX", 141:"TOR", 142:"MIN",
    143:"PHI", 144:"ATL", 145:"CWS", 146:"MIA", 147:"NYY", 158:"MIL",
}

POS_DEFAULT_ORDER = {
    "CF":2, "SS":2, "2B":3, "3B":4, "1B":4,
    "LF":5, "RF":5, "DH":4, "C":7,  "OF":5, "P":9,
}

# ── HELPERS ───────────────────────────────────────────────────────────────────
MLB_BASE = "https://statsapi.mlb.com/api/v1"

def mlb_get(endpoint, params=None, retries=3):
    url = MLB_BASE + endpoint
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                print(f"  mlb_get failed {endpoint}: {e}")
                return {}
            time.sleep(2 ** attempt)
    return {}

def player_name_key(name):
    return (name or "").lower().strip()

def deg_to_compass(deg):
    dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
            "S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return dirs[round(deg / 22.5) % 16]

# ── 1. SCHEDULE ───────────────────────────────────────────────────────────────
def fetch_schedule():
    today = datetime.date.today().strftime("%Y-%m-%d")
    data = mlb_get("/schedule", {
        "sportId": 1, "date": today,
        "hydrate": "lineups,probablePitcher,team,linescore",
    })
    games = [
        g for de in data.get("dates", [])
        for g in de.get("games", [])
        if g.get("status", {}).get("abstractGameState") != "Final"
    ]
    print(f"  Schedule: {len(games)} games today")
    return games

# ── 2. RECENT BATTING ORDERS ──────────────────────────────────────────────────
def fetch_recent_batting_orders():
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = (today - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    print("  Fetching recent batting orders...")
    data = mlb_get("/schedule", {
        "sportId": 1, "startDate": start, "endDate": end,
        "hydrate": "lineups,team", "gameType": "R",
    })
    team_orders = defaultdict(lambda: defaultdict(list))
    for de in data.get("dates", []):
        for g in de.get("games", []):
            lineups = g.get("lineups", {})
            if not lineups:
                continue
            away_abbr = TEAM_ID_TO_ABBR.get(g["teams"]["away"]["team"]["id"], "")
            home_abbr = TEAM_ID_TO_ABBR.get(g["teams"]["home"]["team"]["id"], "")
            for p in lineups.get("awayPlayers", []):
                nk = player_name_key(p.get("fullName", ""))
                bo = p.get("battingOrder", 0) // 100
                if nk and 1 <= bo <= 9:
                    team_orders[away_abbr][nk].append(bo)
            for p in lineups.get("homePlayers", []):
                nk = player_name_key(p.get("fullName", ""))
                bo = p.get("battingOrder", 0) // 100
                if nk and 1 <= bo <= 9:
                    team_orders[home_abbr][nk].append(bo)
    avg_orders = {
        team: {name: round(sum(o) / len(o)) for name, o in players.items()}
        for team, players in team_orders.items()
    }
    total = sum(len(v) for v in avg_orders.values())
    print(f"  Recent batting orders: {total} entries across {len(avg_orders)} teams")
    return avg_orders

# ── 3. ROSTER FALLBACK ────────────────────────────────────────────────────────
def fetch_roster(team_id):
    try:
        data = mlb_get(f"/teams/{team_id}/roster", {"rosterType": "active"})
        return [
            {"name": p["person"]["fullName"],
             "pos":  p.get("position", {}).get("abbreviation", "OF")}
            for p in data.get("roster", [])
            if p.get("position", {}).get("abbreviation", "P") not in ("P", "SP", "RP")
        ]
    except:
        return []

# ── 4. BUILD LINEUP ───────────────────────────────────────────────────────────
def build_lineup(game, recent_orders, side):
    team_id   = game["teams"][side]["team"]["id"]
    team_abbr = TEAM_ID_TO_ABBR.get(team_id, "")
    key       = "awayPlayers" if side == "away" else "homePlayers"
    confirmed = game.get("lineups", {}).get(key, [])

    if confirmed:
        result = []
        for p in confirmed:
            name = p.get("fullName", "")
            pos  = p.get("position", {}).get("abbreviation", "OF")
            bo   = p.get("battingOrder", 500) // 100
            if not name or pos == "P":
                continue
            result.append({"name": name, "pos": pos, "batting_order": max(1, min(9, bo))})
        if result:
            return result, team_abbr, True

    # Roster fallback
    roster      = fetch_roster(team_id)
    team_recent = recent_orders.get(team_abbr, {})
    players = []
    for p in roster:
        nk = player_name_key(p["name"])
        bo = team_recent.get(nk) or POS_DEFAULT_ORDER.get(p["pos"], 6)
        players.append({"name": p["name"], "pos": p["pos"], "batting_order": bo})
    players.sort(key=lambda x: x["batting_order"])
    has_recent = [p for p in players if player_name_key(p["name"]) in team_recent]
    no_recent  = [p for p in players if player_name_key(p["name"]) not in team_recent]
    lineup = (has_recent + no_recent)[:9]
    for i, p in enumerate(lineup):
        p["batting_order"] = i + 1
    return lineup, team_abbr, False

# ── 5. FETCH LINEUPS ──────────────────────────────────────────────────────────
def fetch_lineups():
    print("Fetching lineups...")
    games_raw     = fetch_schedule()
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

        away_lineup, _, away_conf = build_lineup(g, recent_orders, "away")
        home_lineup, _, home_conf = build_lineup(g, recent_orders, "home")

        games[game_key] = {
            "game_key":       game_key,
            "game_id":        g["gamePk"],
            "game_time":      g.get("gameDate", ""),
            "away_team":      away_abbr,
            "home_team":      home_abbr,
            "away_pitcher":   away_pitcher,
            "home_pitcher":   home_pitcher,
            "away_lineup":    away_lineup,
            "home_lineup":    home_lineup,
            "away_confirmed": away_conf,
            "home_confirmed": home_conf,
            "status":         g.get("status", {}).get("detailedState", ""),
        }
        conf = "✓ confirmed" if (away_conf and home_conf) else "~ projected"
        print(f"  {game_key:12s}  {away_pitcher:22s} vs {home_pitcher:22s}  [{conf}]")

    fully = sum(1 for g in games.values() if g["away_confirmed"] and g["home_confirmed"])
    print(f"\n  Total: {len(games)} games, {fully} fully confirmed")
    with open(OUT / "lineups.json", "w") as f:
        json.dump(games, f, indent=2)
    return games

# ── 6. WEATHER — manual weather.json wins; Open-Meteo fallback ────────────────
def fetch_weather(games):
    weather_path = OUT / "weather.json"

    if weather_path.exists():
        print("  weather.json found — using manual upload, skipping Open-Meteo")
        return json.loads(weather_path.read_text())

    print("  No manual weather.json — fetching from Open-Meteo...")
    weather = {}
    for team in {g["home_team"] for g in games.values()}:
        if team not in STADIUMS:
            continue
        park_name, lat, lon, roof = STADIUMS[team]
        game_hour = 14
        for g in games.values():
            if g["home_team"] == team and g.get("game_time"):
                try:
                    dt = datetime.datetime.fromisoformat(g["game_time"].replace("Z", "+00:00"))
                    eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
                    game_hour = eastern.hour
                    break
                except:
                    pass
        try:
            r = requests.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lon,
                "hourly": "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m",
                "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                "forecast_days": 1, "timezone": "America/New_York",
            }, timeout=25)
            r.raise_for_status()
            h   = r.json().get("hourly", {})
            idx = min(game_hour, 23)
            weather[team] = {
                "park":       park_name,
                "temp":       h.get("temperature_2m",           [72] * 24)[idx],
                "precip_pct": h.get("precipitation_probability", [0] * 24)[idx],
                "wind_mph":   h.get("wind_speed_10m",            [5] * 24)[idx],
                "wind_dir":   deg_to_compass(h.get("wind_direction_10m", [180] * 24)[idx]),
                "roof":       roof,
            }
        except Exception as e:
            print(f"  Weather error {team}: {e}")
            weather[team] = {"park": park_name, "temp": 72, "precip_pct": 0,
                             "wind_mph": 5, "wind_dir": "N", "roof": roof}
        time.sleep(0.15)

    print(f"  Weather: {len(weather)} stadiums")
    with open(weather_path, "w") as f:
        json.dump(weather, f, indent=2)
    return weather

# ── 7. HITTER L14 — reads data/fangraphs_l14.csv ─────────────────────────────
def fetch_statcast():
    print("Fetching L14 hitter data from FanGraphs CSV...")
    fg_path = OUT / "fangraphs_l14.csv"
    statcast = {}

    if not fg_path.exists():
        print("  WARNING: fangraphs_l14.csv not found — L14 hitter data will be empty")
        with open(OUT / "statcast_l14.json", "w") as f:
            json.dump({}, f)
        return {}

    try:
        with open(fg_path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                raw = (row.get("Name") or row.get("NameASCII") or "").strip()
                if not raw:
                    continue
                name = raw.lower()
                pa   = int(float(row.get("PA")  or 0))
                hr   = int(float(row.get("HR")  or 0))
                iso  = float(row.get("ISO")  or 0)
                bb_pct = float((row.get("BB%") or "0").replace("%", "")) / 100
                k_pct  = float((row.get("K%")  or "0").replace("%", "")) / 100
                xwoba  = float(row.get("xwOBA") or row.get("wOBA") or 0.320)
                woba   = float(row.get("wOBA")  or 0.320)
                if pa < 1:
                    continue
                statcast[name] = {
                    "l14_pa":         pa,
                    "l14_hr":         hr,
                    "l14_rate":       round(hr / pa, 4),
                    "l14_avg_ev":     90.0,
                    "l14_barrel_pct": round(iso * 0.18, 4),
                    "l14_hh_pct":     round(iso * 0.45, 4),
                    "l14_hit_rate":   round(woba / 1.25, 4),
                    "l14_xwoba":      xwoba,
                    "l14_iso":        iso,
                    "l14_bb_pct":     bb_pct,
                    "l14_k_pct":      k_pct,
                }
    except Exception as e:
        print(f"  FanGraphs hitter parse error: {e}")
        with open(OUT / "statcast_l14.json", "w") as f:
            json.dump({}, f)
        return {}

    print(f"  L14 hitters: {len(statcast)} players loaded")
    with open(OUT / "statcast_l14.json", "w") as f:
        json.dump(statcast, f, indent=2)
    return statcast

# ── 8. PITCHER L14 — reads data/fangraphs_pitchers_l14.csv ───────────────────
def fetch_pitcher_statcast():
    print("Fetching L14 pitcher data from FanGraphs CSV...")
    fg_path = OUT / "fangraphs_pitchers_l14.csv"
    pitchers = {}

    if not fg_path.exists():
        print("  WARNING: fangraphs_pitchers_l14.csv not found — pitcher L14 will be empty")
        with open(OUT / "pitchers_l14.json", "w") as f:
            json.dump({}, f)
        return {}

    try:
        with open(fg_path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                raw = (row.get("Name") or row.get("NameASCII") or "").strip()
                if not raw:
                    continue
                name = raw.lower()
                ip   = float(row.get("IP")   or 0)
                hr9  = float(row.get("HR/9") or 0)
                k9   = float(row.get("K/9")  or 0)
                bb9  = float(row.get("BB/9") or 0)
                xfip = float(row.get("xFIP") or 4.0)
                era  = float(row.get("ERA")  or 4.0)
                if ip < 1:
                    continue
                bf = round(ip * 4.3)
                pitchers[name] = {
                    "l14_bf":      bf,
                    "l14_hr_rate": round(hr9 / 27, 4),
                    "l14_k_rate":  round(k9  / 27, 4),
                    "l14_bb_rate": round(bb9 / 27, 4),
                    "l14_xfip":    xfip,
                    "l14_era":     era,
                }
    except Exception as e:
        print(f"  FanGraphs pitcher parse error: {e}")
        with open(OUT / "pitchers_l14.json", "w") as f:
            json.dump({}, f)
        return {}

    print(f"  L14 pitchers: {len(pitchers)} players loaded")
    with open(OUT / "pitchers_l14.json", "w") as f:
        json.dump(pitchers, f, indent=2)
    return pitchers

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=== Onyx Baseball — Fetching data ===\n")
    games = fetch_lineups()
    fetch_weather(games)
    fetch_statcast()
    fetch_pitcher_statcast()
    print("\n=== Done. Ready for auto_build.py ===")
