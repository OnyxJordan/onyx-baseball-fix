"""
fetch_data.py — Onyx Baseball daily data fetcher v3
Fixes: odds market key, recent batting orders, weather timeout
"""

import os, json, time, requests, csv, io, datetime
from pathlib import Path
from collections import defaultdict

OUT = Path("data")
OUT.mkdir(exist_ok=True)

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")

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

TEAM_ID_TO_ABBR = {
    109:"ARI",110:"BAL",111:"BOS",112:"CHC",113:"CIN",114:"CLE",115:"COL",
    116:"DET",117:"HOU",118:"KC",119:"LAD",120:"WAS",121:"NYM",133:"OAK",
    134:"PIT",135:"SD",136:"SEA",137:"SF",138:"STL",139:"TB",140:"TEX",
    141:"TOR",142:"MIN",143:"PHI",144:"ATL",145:"CWS",146:"MIA",147:"NYY",
    158:"MIL",108:"LAA",
}

POS_DEFAULT_ORDER = {
    "CF":2,"SS":2,"2B":3,"3B":4,"1B":4,"LF":5,"RF":5,"DH":4,"C":7,"OF":5,"P":9
}

def mlb_get(path, params=None):
    url = f"https://statsapi.mlb.com/api/v1{path}"
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()

def player_name_key(name):
    return name.lower().strip()

# ── 1. SCHEDULE ───────────────────────────────────────────────────────────────
def fetch_schedule():
    today = datetime.date.today().strftime("%Y-%m-%d")
    data = mlb_get("/schedule", {
        "sportId": 1, "date": today,
        "hydrate": "lineups,probablePitcher,team,linescore",
    })
    games = [g for de in data.get("dates",[]) for g in de.get("games",[])
             if g.get("status",{}).get("abstractGameState") != "Final"]
    print(f"  Schedule: {len(games)} games today")
    return games

# ── 2. RECENT BATTING ORDERS ──────────────────────────────────────────────────
def fetch_recent_batting_orders():
    today = datetime.date.today()
    # Try last 14 days to get more data
    start = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = (today - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"  Fetching recent batting orders ({start} to {end})...")
    try:
        data = mlb_get("/schedule", {
            "sportId":1, "startDate":start, "endDate":end,
            "hydrate":"lineups,team", "gameType":"R",
        })
    except Exception as e:
        print(f"  Recent orders error: {e}")
        return {}

    team_orders = defaultdict(lambda: defaultdict(list))
    for de in data.get("dates",[]):
        for g in de.get("games",[]):
            lineups = g.get("lineups",{})
            if not lineups: continue
            away_id = g["teams"]["away"]["team"]["id"]
            home_id = g["teams"]["home"]["team"]["id"]
            away_abbr = TEAM_ID_TO_ABBR.get(away_id,"")
            home_abbr = TEAM_ID_TO_ABBR.get(home_id,"")
            for p in lineups.get("awayPlayers",[]):
                name = player_name_key(p.get("fullName",""))
                bo = p.get("battingOrder",0)//100
                if name and 1<=bo<=9: team_orders[away_abbr][name].append(bo)
            for p in lineups.get("homePlayers",[]):
                name = player_name_key(p.get("fullName",""))
                bo = p.get("battingOrder",0)//100
                if name and 1<=bo<=9: team_orders[home_abbr][name].append(bo)

    avg_orders = {team: {name: round(sum(o)/len(o)) for name,o in players.items()}
                  for team,players in team_orders.items()}
    total = sum(len(v) for v in avg_orders.values())
    print(f"  Recent batting orders: {total} entries across {len(avg_orders)} teams")
    return avg_orders

# ── 3. ROSTER FALLBACK ────────────────────────────────────────────────────────
def fetch_roster(team_id):
    try:
        data = mlb_get(f"/teams/{team_id}/roster", {"rosterType":"active"})
        return [{"name":p["person"]["fullName"],"pos":p.get("position",{}).get("abbreviation","OF")}
                for p in data.get("roster",[])
                if p.get("position",{}).get("abbreviation","P") not in ("P","SP","RP")]
    except:
        return []

# ── 4. BUILD LINEUP ────────────────────────────────────────────────────────────
def build_lineup(game, recent_orders, side):
    team_data = game["teams"][side]
    team_id   = team_data["team"]["id"]
    team_abbr = TEAM_ID_TO_ABBR.get(team_id,"")
    key = "awayPlayers" if side=="away" else "homePlayers"
    confirmed = game.get("lineups",{}).get(key,[])

    if confirmed:
        result = []
        for p in confirmed:
            name = p.get("fullName","")
            pos  = p.get("position",{}).get("abbreviation","OF")
            bo   = p.get("battingOrder",500)//100
            if not name or pos=="P": continue
            result.append({"name":name,"pos":pos,"batting_order":max(1,min(9,bo))})
        if result:
            return result, team_abbr, True

    # Roster fallback
    roster = fetch_roster(team_id)
    team_recent = recent_orders.get(team_abbr,{})
    players = []
    for p in roster:
        nk = player_name_key(p["name"])
        bo = team_recent.get(nk) or POS_DEFAULT_ORDER.get(p["pos"],6)
        players.append({"name":p["name"],"pos":p["pos"],"batting_order":bo})

    players.sort(key=lambda x: x["batting_order"])
    has_recent = [p for p in players if player_name_key(p["name"]) in team_recent]
    no_recent  = [p for p in players if player_name_key(p["name"]) not in team_recent]
    lineup = (has_recent + no_recent)[:9]
    for i,p in enumerate(lineup):
        p["batting_order"] = i+1
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

        away_pitcher = g["teams"]["away"].get("probablePitcher",{}).get("fullName","TBD")
        home_pitcher = g["teams"]["home"].get("probablePitcher",{}).get("fullName","TBD")
        away_lineup, _, away_conf = build_lineup(g, recent_orders, "away")
        home_lineup, _, home_conf = build_lineup(g, recent_orders, "home")

        games[game_key] = {
            "game_key":game_key,"game_id":g["gamePk"],
            "game_time":g.get("gameDate",""),
            "away_team":away_abbr,"home_team":home_abbr,
            "away_pitcher":away_pitcher,"home_pitcher":home_pitcher,
            "away_lineup":away_lineup,"home_lineup":home_lineup,
            "away_confirmed":away_conf,"home_confirmed":home_conf,
            "status":g.get("status",{}).get("detailedState",""),
        }
        conf = "✓" if (away_conf and home_conf) else "~projected"
        print(f"  {game_key:12s}  {away_pitcher:22s} vs {home_pitcher:22s}  [{conf}]")

    fully = sum(1 for g in games.values() if g["away_confirmed"] and g["home_confirmed"])
    print(f"\n  Total: {len(games)} games, {fully} fully confirmed")
    with open(OUT/"lineups.json","w") as f: json.dump(games,f,indent=2)
    return games

# ── 6. HR ODDS ────────────────────────────────────────────────────────────────
def fetch_odds():
    print("Fetching HR odds from The Odds API...")
    if not ODDS_API_KEY:
        print("  WARNING: No ODDS_API_KEY")
        with open(OUT/"odds.json","w") as f: json.dump({},f)
        return {}

    today_str = datetime.date.today().isoformat()
    odds_map  = {}

    # Try multiple market keys — API has changed these over time
    MARKET_KEYS = ["batter_home_runs", "player_home_runs", "batter_hr"]

    try:
        r = requests.get("https://api.the-odds-api.com/v4/sports/baseball_mlb/events",
            params={"apiKey":ODDS_API_KEY,"dateFormat":"iso"}, timeout=15)
        r.raise_for_status()
        events = r.json()
        print(f"  Events found: {len(events)}")
    except Exception as e:
        print(f"  Events error: {e}")
        with open(OUT/"odds.json","w") as f: json.dump({},f)
        return {}

    # Find which market key works using first event
    working_market = None
    today_events = [e for e in events if e.get("commence_time","")[:10] == today_str]
    print(f"  Today's events: {len(today_events)}")

    if today_events:
        test_id = today_events[0]["id"]
        for mkey in MARKET_KEYS:
            try:
                r2 = requests.get(
                    f"https://api.the-odds-api.com/v4/sports/baseball_mlb/events/{test_id}/odds",
                    params={"apiKey":ODDS_API_KEY,"regions":"us","markets":mkey,
                            "bookmakers":"draftkings","oddsFormat":"american"}, timeout=15)
                r2.raise_for_status()
                data = r2.json()
                for bm in data.get("bookmakers",[]):
                    for market in bm.get("markets",[]):
                        if market.get("outcomes"):
                            working_market = mkey
                            print(f"  Working market key: {mkey}")
                            break
                if working_market: break
            except Exception as e:
                print(f"  Market key {mkey} error: {e}")
            time.sleep(0.2)

    if not working_market:
        # Last resort: try the player_props endpoint
        print("  Trying player_props endpoint...")
        try:
            r3 = requests.get(
                "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds",
                params={"apiKey":ODDS_API_KEY,"regions":"us",
                        "markets":"batter_home_runs","bookmakers":"draftkings",
                        "oddsFormat":"american","dateFormat":"iso"}, timeout=15)
            r3.raise_for_status()
            bulk = r3.json()
            for game in bulk:
                if game.get("commence_time","")[:10] != today_str: continue
                for bm in game.get("bookmakers",[]):
                    for market in bm.get("markets",[]):
                        for outcome in market.get("outcomes",[]):
                            if outcome.get("name")=="Over" and outcome.get("point",0)<1.5:
                                player = (outcome.get("description","") or outcome.get("name","")).lower().strip()
                                if player:
                                    odds_map[player] = outcome["price"]
            print(f"  Bulk odds: {len(odds_map)} players")
        except Exception as e:
            print(f"  Bulk odds error: {e}")
        with open(OUT/"odds.json","w") as f: json.dump(odds_map,f,indent=2)
        return odds_map

    # Fetch per-event with working market key
    for event in today_events:
        try:
            r2 = requests.get(
                f"https://api.the-odds-api.com/v4/sports/baseball_mlb/events/{event['id']}/odds",
                params={"apiKey":ODDS_API_KEY,"regions":"us","markets":working_market,
                        "bookmakers":"draftkings","oddsFormat":"american"}, timeout=15)
            r2.raise_for_status()
            data = r2.json()
            for bm in data.get("bookmakers",[]):
                if bm["key"] != "draftkings": continue
                for market in bm.get("markets",[]):
                    for outcome in market.get("outcomes",[]):
                        if outcome.get("name")=="Over" and outcome.get("point",0.5)<1.5:
                            player = (outcome.get("description","") or "").lower().strip()
                            if player:
                                odds_map[player] = outcome["price"]
        except Exception as e:
            print(f"  Props error {event.get('id','')}: {e}")
        time.sleep(0.25)

    print(f"  Odds: {len(odds_map)} players")
    with open(OUT/"odds.json","w") as f: json.dump(odds_map,f,indent=2)
    return odds_map

# ── 7. WEATHER ────────────────────────────────────────────────────────────────
def deg_to_compass(deg):
    dirs=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return dirs[round(deg/22.5)%16]

def fetch_weather(games):
    print("Fetching weather from Open-Meteo...")
    weather = {}
    home_teams = {g["home_team"] for g in games.values()}

    for team in home_teams:
        if team not in STADIUMS: continue
        park_name, lat, lon, roof = STADIUMS[team]

        game_hour = 14
        for g in games.values():
            if g["home_team"]==team and g.get("game_time"):
                try:
                    dt = datetime.datetime.fromisoformat(g["game_time"].replace("Z","+00:00"))
                    eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
                    game_hour = eastern.hour; break
                except: pass

        try:
            r = requests.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude":lat,"longitude":lon,
                "hourly":"temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m",
                "temperature_unit":"fahrenheit","wind_speed_unit":"mph",
                "forecast_days":1,"timezone":"America/New_York",
            }, timeout=20)
            r.raise_for_status()
            h = r.json().get("hourly",{})
            idx = min(game_hour,23)
            weather[team] = {
                "park":park_name,
                "temp":       h.get("temperature_2m",[72]*24)[idx],
                "precip_pct": h.get("precipitation_probability",[0]*24)[idx],
                "wind_mph":   h.get("wind_speed_10m",[5]*24)[idx],
                "wind_dir":   deg_to_compass(h.get("wind_direction_10m",[180]*24)[idx]),
                "roof":       roof,
            }
        except Exception as e:
            print(f"  Weather error {team}: {e}")
            weather[team] = {"park":park_name,"temp":72,"precip_pct":0,
                             "wind_mph":5,"wind_dir":"N","roof":roof}
        time.sleep(0.15)

    print(f"  Weather: {len(weather)} stadiums")
    with open(OUT/"weather.json","w") as f: json.dump(weather,f,indent=2)
    return weather

# ── 8. STATCAST L14 ───────────────────────────────────────────────────────────
def fetch_statcast():
    print("Fetching Statcast L14 hitter data...")
    today = datetime.date.today()
    start = (today-datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    url = (f"https://baseballsavant.mlb.com/statcast_search/csv"
           f"?all=true&player_type=batter&hfGT=R%7C&hfSea=2026%7C"
           f"&game_date_gt={start}&game_date_lt={end}"
           f"&min_abs=5&group_by=name&sort_col=pitches&sort_order=desc&type=details&")
    statcast = {}
    try:
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        reader = csv.DictReader(io.StringIO(r.text))
        agg = defaultdict(lambda:{"pa":0,"hr":0,"ev_sum":0,"ev_n":0,"barrels":0,"hard_hits":0,"hits":0})
        for row in reader:
            raw = (row.get("player_name","") or "").strip()
            if not raw: continue
            if "," in raw:
                last,first = raw.split(",",1)
                name = f"{first.strip()} {last.strip()}".lower()
            else: name = raw.lower()
            events = row.get("events","") or ""
            ev_s = row.get("launch_speed","") or ""
            la_s = row.get("launch_angle","") or ""
            agg[name]["pa"] += 1
            if events=="home_run": agg[name]["hr"]+=1
            if events in ("single","double","triple","home_run"): agg[name]["hits"]+=1
            try:
                ev=float(ev_s); agg[name]["ev_sum"]+=ev; agg[name]["ev_n"]+=1
                if ev>=95: agg[name]["hard_hits"]+=1
                if ev>=98 and 26<=float(la_s)<=30: agg[name]["barrels"]+=1
            except: pass
        for name,d in agg.items():
            pa=max(d["pa"],1)
            statcast[name]={"l14_pa":d["pa"],"l14_hr":d["hr"],"l14_rate":round(d["hr"]/pa,4),
                "l14_avg_ev":round(d["ev_sum"]/d["ev_n"],1) if d["ev_n"] else 90.0,
                "l14_barrel_pct":round(d["barrels"]/pa,4),"l14_hh_pct":round(d["hard_hits"]/pa,4),
                "l14_hit_rate":round(d["hits"]/pa,4)}
    except Exception as e: print(f"  Statcast error: {e}")
    print(f"  Statcast hitters: {len(statcast)}")
    with open(OUT/"statcast_l14.json","w") as f: json.dump(statcast,f,indent=2)
    return statcast

# ── 9. PITCHER L14 ────────────────────────────────────────────────────────────
def fetch_pitcher_statcast():
    print("Fetching Statcast L14 pitcher data...")
    today = datetime.date.today()
    start = (today-datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    url = (f"https://baseballsavant.mlb.com/statcast_search/csv"
           f"?all=true&player_type=pitcher&hfGT=R%7C&hfSea=2026%7C"
           f"&game_date_gt={start}&game_date_lt={end}"
           f"&min_abs=10&group_by=name&sort_col=pitches&sort_order=desc&type=details&")
    pitchers = {}
    try:
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        reader = csv.DictReader(io.StringIO(r.text))
        agg = defaultdict(lambda:{"bf":0,"hr":0,"k":0,"bb":0})
        for row in reader:
            raw = (row.get("player_name","") or "").strip()
            if not raw: continue
            if "," in raw:
                last,first = raw.split(",",1)
                name = f"{first.strip()} {last.strip()}".lower()
            else: name = raw.lower()
            events = row.get("events","") or ""
            agg[name]["bf"]+=1
            if events=="home_run": agg[name]["hr"]+=1
            if events in ("strikeout","strikeout_double_play"): agg[name]["k"]+=1
            if events=="walk": agg[name]["bb"]+=1
        for name,d in agg.items():
            bf=max(d["bf"],1)
            pitchers[name]={"l14_bf":d["bf"],"l14_hr_rate":round(d["hr"]/bf,4),
                "l14_k_rate":round(d["k"]/bf,4),"l14_bb_rate":round(d["bb"]/bf,4)}
    except Exception as e: print(f"  Pitcher error: {e}")
    print(f"  Statcast pitchers: {len(pitchers)}")
    with open(OUT/"pitchers_l14.json","w") as f: json.dump(pitchers,f,indent=2)
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
