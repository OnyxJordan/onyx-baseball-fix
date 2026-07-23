"""
fetch_data.py — Onyx Baseball daily data fetcher v8
Odds:    reads data/odds.json directly (uploaded manually each morning)
Lineups: MLB Stats API with roster fallback -> data/lineups.json (FLAT list for auto_build)
Weather: manual data/weather.json wins; falls back to Open-Meteo if missing
Hitters: data/fangraphs_l14.csv + real Statcast (statcast_l14.csv / statcast_season.csv)
Splits:  data/hitters_home.csv + data/hitters_away.csv -> splits.json
Pitchers: data/fangraphs_pitchers_l14.csv

v8 fixes:
  - fetch_splits(): repaired IndentationError + wrong body (had Statcast loader
    pasted in referencing undefined `out`). Now reads hitters_home/away CSVs and
    writes splits.json with ch/ca + _pa keys that model.py expects.
  - _load_statcast_file(): removed the `if pa < 1: continue` gate. Statcast
    quality exports carry no PA column, so that gate silently dropped EVERY row
    and hitters fell back to iso*0.18 barrel estimates. Now keeps any row with a
    real quality signal, with aliased headers for resilience.
  - fetch_lineups(): writes data/lineups.json as a FLAT list of batter dicts
    (name/team/game_key/batting_order/pos), the format auto_build.py iterates.
  - Abbr alignment: WAS->WSH, OAK->ATH so game_keys match the manual
    odds/game_lines/weather files (CWS_BAL, WSH_BOS, LAD_ATH, ...).
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
    "HOU": ("Daikin Park",              29.7573,  -95.3555, True),
    "CHC": ("Wrigley Field",            41.9484,  -87.6553, False),
    "CWS": ("Rate Field",               41.8300,  -87.6339, False),
    "SF":  ("Oracle Park",              37.7786, -122.3893, False),
    "COL": ("Coors Field",              39.7559, -104.9942, False),
    "ARI": ("Chase Field",              33.4453, -112.0667, True),
    "WSH": ("Nationals Park",           38.8730,  -77.0074, False),
    "ATL": ("Truist Park",              33.8908,  -84.4678, False),
    "ATH": ("Sutter Health Park",       38.5800, -121.5130, False),
    "SD":  ("Petco Park",               32.7076, -117.1570, False),
    "TEX": ("Globe Life Field",         32.7473,  -97.0845, True),
    "LAA": ("Angel Stadium",            33.8003, -117.8827, False),
}

TEAM_ID_TO_ABBR = {
    108:"LAA", 109:"ARI", 110:"BAL", 111:"BOS", 112:"CHC", 113:"CIN",
    114:"CLE", 115:"COL", 116:"DET", 117:"HOU", 118:"KC",  119:"LAD",
    120:"WSH", 121:"NYM", 133:"ATH", 134:"PIT", 135:"SD",  136:"SEA",
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

def _f(row, *keys, default=0.0):
    """First non-empty float among keys; strips % signs."""
    for k in keys:
        v = row.get(k)
        if v not in (None, "", "NA"):
            try:
                return float(str(v).replace("%", ""))
            except ValueError:
                continue
    return default

def _name_key(row):
    raw = (row.get("Name") or row.get("NameASCII") or "").strip()
    return raw.lower() if raw else None

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
    except Exception:
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

# ── 5. FETCH LINEUPS — writes FLAT data/lineups.json for auto_build ────────────
def fetch_lineups():
    print("Fetching lineups...")
    games_raw     = fetch_schedule()
    recent_orders = fetch_recent_batting_orders()
    games = {}     # internal, keyed by game_key — used by fetch_weather
    flat  = []     # what auto_build.py iterates

    for g in games_raw:
        away_abbr = TEAM_ID_TO_ABBR.get(g["teams"]["away"]["team"]["id"], "")
        home_abbr = TEAM_ID_TO_ABBR.get(g["teams"]["home"]["team"]["id"], "")
        if not away_abbr or not home_abbr:
            continue
        game_key = f"{away_abbr}_{home_abbr}"

        away_pitcher = g["teams"]["away"].get("probablePitcher", {}).get("fullName", "TBD")
        home_pitcher = g["teams"]["home"].get("probablePitcher", {}).get("fullName", "TBD")

        away_lineup, _, away_conf = build_lineup(g, recent_orders, "away")
        home_lineup, _, home_conf = build_lineup(g, recent_orders, "home")

        games[game_key] = {
            "game_key":     game_key,
            "game_id":      g["gamePk"],
            "game_time":    g.get("gameDate", ""),
            "away_team":    away_abbr,
            "home_team":    home_abbr,
            "away_pitcher": away_pitcher,
            "home_pitcher": home_pitcher,
            "status":       g.get("status", {}).get("detailedState", ""),
        }

        for team, lineup, conf in [(away_abbr, away_lineup, away_conf),
                                   (home_abbr, home_lineup, home_conf)]:
            for p in lineup:
                pos = p["pos"]
                flat.append({
                    "name":             p["name"],
                    "team":             team,
                    "game_key":         game_key,
                    "batting_order":    p["batting_order"],
                    "pos":              pos,
                    "dk_pos":           pos,
                    "fd_pos":           pos,
                    "hand":             "R",   # MLB lineup feed omits bat side; display-only
                    "lineup_confirmed": conf,
                })

        conf = "✓ confirmed" if (away_conf and home_conf) else "~ projected"
        print(f"  {game_key:12s}  {away_pitcher:22s} vs {home_pitcher:22s}  [{conf}]")

    fully = sum(1 for g in games.values()
                if any(b["lineup_confirmed"] for b in flat if b["game_key"] == g["game_key"]))
    print(f"\n  Total: {len(games)} games, {len(flat)} batters")
    with open(OUT / "lineups.json", "w") as f:
        json.dump(flat, f, indent=2)
    write_game_lines(games)
    return games

# ── 5b. GAME LINES — auto-written from schedule; manual lines merged in ───────
def _format_et(iso_ts):
    """ISO UTC timestamp -> '7:05 PM' Eastern. Empty string on failure."""
    if not iso_ts:
        return ""
    try:
        dt = datetime.datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        try:
            from zoneinfo import ZoneInfo
            et = dt.astimezone(ZoneInfo("America/New_York"))
        except Exception:
            et = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
        return et.strftime("%-I:%M %p") if hasattr(et, "strftime") else ""
    except Exception:
        return ""

def write_game_lines(games):
    """
    Replaces the manual game_lines.json workflow. Pitchers, start times, and
    venues come straight from the MLB schedule. Betting lines (total, ML) are
    preserved from the existing file when the game_key matches, since there is
    no free lines API yet; they simply stay null otherwise.
    """
    path = OUT / "game_lines.json"
    old = {}
    if path.exists():
        try:
            old = json.loads(path.read_text())
        except Exception:
            old = {}
    lines = {}
    for gk, g in games.items():
        prev = old.get(gk, {}) if isinstance(old, dict) else {}
        venue = STADIUMS.get(g["home_team"], ("",))[0]
        lines[gk] = {
            "awayP":   g.get("away_pitcher") or "",
            "homeP":   g.get("home_pitcher") or "",
            "time":    _format_et(g.get("game_time")),
            "venue":   venue,
            "gamePk":  g.get("game_id"),
            "total":   prev.get("total"),
            "away_ml": prev.get("away_ml"),
            "home_ml": prev.get("home_ml"),
        }
    with open(path, "w") as f:
        json.dump(lines, f, indent=2)
    carried = sum(1 for v in lines.values() if v["total"] is not None)
    print(f"  Game lines: {len(lines)} games written ({carried} with carried-over totals)")

# ── 6. WEATHER — always fetch fresh; weather_manual.json overrides per team ───
def fetch_weather(games):
    """
    Always pulls fresh Open-Meteo data (the old behavior of skipping when
    weather.json existed froze weather forever once the daily build committed
    the file). Manual per-team overrides go in data/weather_manual.json using
    the same shape; they are merged on top of the fresh fetch.
    """
    weather_path = OUT / "weather.json"
    print("  Fetching fresh weather from Open-Meteo...")
    weather = {}
    for team in {g["home_team"] for g in games.values()}:
        if team not in STADIUMS:
            continue
        park_name, lat, lon, roof = STADIUMS[team]
        game_hour = 19
        for g in games.values():
            if g["home_team"] == team and g.get("game_time"):
                try:
                    dt = datetime.datetime.fromisoformat(g["game_time"].replace("Z", "+00:00"))
                    eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
                    game_hour = eastern.hour
                    break
                except Exception:
                    pass
        try:
            r = requests.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lon,
                "hourly": "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,relative_humidity_2m,surface_pressure",
                "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                "forecast_days": 1, "timezone": "America/New_York",
            }, timeout=25)
            r.raise_for_status()
            h = r.json().get("hourly", {})
            idx = min(game_hour, 23)
            weather[team] = {
                "venue":        park_name,
                "temp":         h.get("temperature_2m",            [72]  * 24)[idx],
                "precip":       h.get("precipitation_probability", [0]   * 24)[idx],
                "wind_spd":     h.get("wind_speed_10m",             [5]   * 24)[idx],
                "wind_dir":     deg_to_compass(h.get("wind_direction_10m", [180] * 24)[idx]),
                "humidity_pct": h.get("relative_humidity_2m",       [50]  * 24)[idx],
                "pressure_mb":  h.get("surface_pressure",           [1013]* 24)[idx],
                "roof":         roof,
                "flag":         "clear",
            }
        except Exception as e:
            print(f"  Weather error {team}: {e}")
            weather[team] = {"venue": park_name, "temp": 72, "precip": 0,
                             "wind_spd": 5, "wind_dir": "N", "roof": roof, "flag": "clear"}
        time.sleep(0.15)
    manual_path = OUT / "weather_manual.json"
    if manual_path.exists():
        try:
            overrides = json.loads(manual_path.read_text())
            for team, wx in overrides.items():
                if isinstance(wx, dict):
                    weather.setdefault(team, {}).update(wx)
            print(f"  Weather: merged manual overrides for {len(overrides)} teams")
        except Exception as e:
            print(f"  WARNING: weather_manual.json unreadable ({e}) — ignored")
    print(f"  Weather: {len(weather)} stadiums")
    with open(weather_path, "w") as f:
        json.dump(weather, f, indent=2)
    return weather

# ── STATCAST LOADER (season + L14) ────────────────────────────────────────────
def _load_statcast_file(path):
    """
    Return {name_lower: {ev90, barrel_pct, hardhit_pct, xwoba, pa}}.
    Statcast quality exports often carry NO PA column — gating on PA dropped
    every row and forced the ISO fallback. Keep any row with a real quality
    signal (barrel / hardhit / EV present); aliased headers for resilience.
    """
    out = {}
    if not path.exists():
        return out
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            nk = _name_key(row)
            if not nk:
                continue
            pa   = int(_f(row, "PA", "pa", default=0))
            bpct = _f(row, "Barrel%", "barrel_pct", "Brl%", "Barrels/PA%")
            hpct = _f(row, "HardHit%", "hardhit_pct", "HardHit", "HH%")
            ev90 = _f(row, "EV90", "EV", "avg_best_speed", default=0.0)
            xw   = _f(row, "xwOBA", "wOBA", "est_woba", default=0.320)
            if bpct == 0 and hpct == 0 and ev90 == 0:
                continue  # no real Statcast signal in this row
            if bpct > 1: bpct /= 100
            if hpct > 1: hpct /= 100
            out[nk] = {
                "ev90":        round(ev90 or 95.0, 1),
                "barrel_pct":  round(bpct, 4),
                "hardhit_pct": round(hpct, 4),
                "xwoba":       round(xw, 4),
                "pa":          pa,
            }
    return out

# ── 7. HITTER L14 — MLB Stats API primary, FanGraphs CSV fallback ────────────
def _pct_str(v, default=0.0):
    """Parse MLB API rate strings like '.517'; tolerate '-.--' and None."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default

def _l14_from_mlb_api(sc_l14, sc_season):
    """
    L14 hitter form straight from the MLB Stats API (byDateRange aggregate,
    playerPool=all). No key, no CSV upload. Statcast CSV quality metrics are
    merged on top when present, same as the FanGraphs path.
    """
    today = datetime.date.today()
    data = mlb_get("/stats", {
        "stats": "byDateRange", "group": "hitting", "sportId": 1,
        "startDate": (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d"),
        "endDate": today.strftime("%Y-%m-%d"),
        "limit": 3000, "offset": 0, "playerPool": "all",
    })
    splits = (data.get("stats") or [{}])[0].get("splits") or []
    out = {}
    for sp in splits:
        name = (sp.get("player") or {}).get("fullName") or ""
        nk = name.lower().strip()
        st = sp.get("stat") or {}
        pa = int(st.get("plateAppearances") or 0)
        if not nk or pa < 1:
            continue
        hr  = int(st.get("homeRuns") or 0)
        avg = _pct_str(st.get("avg"));  slg = _pct_str(st.get("slg"))
        obp = _pct_str(st.get("obp"))
        iso = max(slg - avg, 0.0)
        bb  = (st.get("baseOnBalls") or 0) / pa
        kk  = (st.get("strikeOuts") or 0) / pa
        # rough wOBA estimate (no wOBA on this endpoint); Statcast xwOBA
        # overrides it whenever the quality CSVs are present. Clamped so
        # tiny samples (1-for-1 days) cannot produce absurd rates.
        woba_est = (obp + slg) / 2 * 0.88 if (obp or slg) else 0.320
        woba_est = min(max(woba_est, 0.200), 0.480)
        sc = sc_l14.get(nk) or sc_season.get(nk) or {}
        out[nk] = {
            "l14_pa":         pa,
            "l14_hr":         hr,
            "l14_rate":       round(hr / pa, 4),
            "l14_avg_ev":     round(sc.get("ev90", 95.0), 1),
            "l14_ev90":       round(sc.get("ev90", 95.0), 1),
            "l14_barrel_pct": sc.get("barrel_pct", round(iso * 0.18, 4)),
            "l14_hh_pct":     sc.get("hardhit_pct", round(iso * 0.45 + 0.20, 4)),
            "l14_hit_rate":   round(woba_est / 1.25, 4),
            "l14_xwoba":      sc.get("xwoba", round(woba_est, 4)),
            "l14_iso":        round(iso, 4),
            "l14_bb_pct":     round(bb, 4),
            "l14_k_pct":      round(kk, 4),
        }
    return out

def fetch_statcast():
    print("Fetching L14 hitter data (MLB API + Statcast, FanGraphs fallback)...")
    fg_path   = OUT / "fangraphs_l14.csv"
    sc_l14    = _load_statcast_file(OUT / "statcast_l14.csv")
    sc_season = _load_statcast_file(OUT / "statcast_season.csv")

    api = _l14_from_mlb_api(sc_l14, sc_season)
    if len(api) >= 100:
        matched_sc = sum(1 for nk in api if nk in sc_l14 or nk in sc_season)
        print(f"  L14 hitters: {len(api)} from MLB API, {matched_sc} with real Statcast")
        (OUT / "statcast_l14.json").write_text(json.dumps(api, indent=2))
        return api
    print(f"  MLB API L14 returned only {len(api)} hitters — falling back to FanGraphs CSV")

    statcast = {}
    if not fg_path.exists():
        print("  WARNING: fangraphs_l14.csv not found — L14 hitter data will be empty")
        (OUT / "statcast_l14.json").write_text("{}")
        return {}

    try:
        with open(fg_path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                nk = _name_key(row)
                if not nk:
                    continue
                pa = int(_f(row, "PA"))     # FanGraphs L14 HAS a PA column — gate is correct here
                hr = int(_f(row, "HR"))
                if pa < 1:
                    continue
                iso   = _f(row, "ISO")
                bb    = _f(row, "BB%") / 100
                kk    = _f(row, "K%") / 100
                xwoba = _f(row, "xwOBA", "wOBA", default=0.320)
                woba  = _f(row, "wOBA", default=0.320)

                sc = sc_l14.get(nk) or sc_season.get(nk) or {}
                barrel  = sc.get("barrel_pct", round(iso * 0.18, 4))
                hardhit = sc.get("hardhit_pct", round(iso * 0.45 + 0.20, 4))
                ev90    = sc.get("ev90", 95.0)

                statcast[nk] = {
                    "l14_pa":         pa,
                    "l14_hr":         hr,
                    "l14_rate":       round(hr / pa, 4),
                    "l14_avg_ev":     round(ev90, 1),
                    "l14_ev90":       round(ev90, 1),
                    "l14_barrel_pct": barrel,
                    "l14_hh_pct":     hardhit,
                    "l14_hit_rate":   round(woba / 1.25, 4),
                    "l14_xwoba":      round(xwoba, 4),
                    "l14_iso":        iso,
                    "l14_bb_pct":     round(bb, 4),
                    "l14_k_pct":      round(kk, 4),
                }
    except Exception as e:
        print(f"  FanGraphs hitter parse error: {e}")
        (OUT / "statcast_l14.json").write_text("{}")
        return {}

    matched_sc = sum(1 for nk in statcast if nk in sc_l14 or nk in sc_season)
    print(f"  L14 hitters: {len(statcast)} loaded, {matched_sc} with real Statcast "
          f"(rest on ISO estimate)")
    (OUT / "statcast_l14.json").write_text(json.dumps(statcast, indent=2))
    return statcast

# ── 7b. SEASON SPLITS — home/away HR-per-PA -> splits.json ────────────────────
def fetch_splits():
    print("Fetching home/away HR splits...")
    splits = {}

    def load_side(path, side_key):
        if not path.exists():
            print(f"  WARNING: {path.name} not found — {side_key} split falls back to career")
            return
        with open(path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                nk = _name_key(row)
                if not nk:
                    continue
                pa = int(_f(row, "PA", "pa", default=0))
                hr = int(_f(row, "HR", "hr", default=0))
                if pa < 1:
                    continue
                rec = splits.setdefault(nk, {})
                rec[side_key] = round(hr / pa, 5)
                rec[f"{side_key}_pa"] = pa

    load_side(OUT / "hitters_home.csv", "ch")
    load_side(OUT / "hitters_away.csv", "ca")

    print(f"  Splits: {len(splits)} players")
    (OUT / "splits.json").write_text(json.dumps(splits, indent=2))
    return splits

# ── 8. PITCHER data — MLB Stats API primary, FanGraphs CSV fallback ──────────
def _ip_to_float(ip):
    """MLB innings strings: '12.1' means 12 and 1/3."""
    try:
        s = str(ip)
        whole, _, frac = s.partition(".")
        return int(whole) + {"1": 1 / 3, "2": 2 / 3}.get(frac, 0.0)
    except (TypeError, ValueError):
        return 0.0

def _l14_pitchers_from_mlb_api():
    today = datetime.date.today()
    data = mlb_get("/stats", {
        "stats": "byDateRange", "group": "pitching", "sportId": 1,
        "startDate": (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d"),
        "endDate": today.strftime("%Y-%m-%d"),
        "limit": 3000, "offset": 0, "playerPool": "all",
    })
    splits = (data.get("stats") or [{}])[0].get("splits") or []
    out = {}
    for sp in splits:
        name = (sp.get("player") or {}).get("fullName") or ""
        nk = name.lower().strip()
        st = sp.get("stat") or {}
        ip = _ip_to_float(st.get("inningsPitched"))
        if not nk or ip < 1:
            continue
        hr = int(st.get("homeRuns") or 0)
        k  = int(st.get("strikeOuts") or 0)
        bb = int(st.get("baseOnBalls") or 0)
        hr9, k9, bb9 = hr * 9 / ip, k * 9 / ip, bb * 9 / ip
        era = _pct_str(st.get("era"), 4.0)
        # no xFIP on this endpoint; FIP is the closest keyless stand-in
        fip = (13 * hr + 3 * bb - 2 * k) / ip + 3.1
        out[nk] = {
            "l14_bf":      int(st.get("battersFaced") or round(ip * 4.3)),
            "l14_hr_rate": round(hr9 / 38.7, 4),
            "l14_k_rate":  round(k9 / 38.7, 4),
            "l14_bb_rate": round(bb9 / 38.7, 4),
            "l14_xfip":    round(min(max(fip, 1.5), 8.0), 2),
            "l14_era":     round(min(max(era, 0.0), 15.0), 2),
        }
    return out

def fetch_pitcher_statcast():
    print("Fetching pitcher data (MLB API, FanGraphs fallback)...")
    api = _l14_pitchers_from_mlb_api()
    if len(api) >= 80:
        print(f"  Pitchers: {len(api)} from MLB API")
        (OUT / "pitchers_l14.json").write_text(json.dumps(api, indent=2))
        return api
    print(f"  MLB API L14 returned only {len(api)} pitchers — falling back to FanGraphs CSV")

    fg_path = OUT / "fangraphs_pitchers_l14.csv"
    pitchers = {}
    if not fg_path.exists():
        print("  WARNING: fangraphs_pitchers_l14.csv not found — pitcher data empty")
        (OUT / "pitchers_l14.json").write_text("{}")
        return {}
    try:
        with open(fg_path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                nk = _name_key(row)
                if not nk:
                    continue
                ip = _f(row, "IP")
                if ip < 1:
                    continue
                pitchers[nk] = {
                    "l14_bf":      round(ip * 4.3),
                    "l14_hr_rate": round(_f(row, "HR/9") / 38.7, 4),
                    "l14_k_rate":  round(_f(row, "K/9") / 38.7, 4),
                    "l14_bb_rate": round(_f(row, "BB/9") / 38.7, 4),
                    "l14_xfip":    _f(row, "xFIP", default=4.0),
                    "l14_era":     _f(row, "ERA", default=4.0),
                }
    except Exception as e:
        print(f"  FanGraphs pitcher parse error: {e}")
        (OUT / "pitchers_l14.json").write_text("{}")
        return {}
    print(f"  Pitchers: {len(pitchers)} loaded")
    (OUT / "pitchers_l14.json").write_text(json.dumps(pitchers, indent=2))
    return pitchers

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=== Onyx Baseball — Fetching data ===\n")
    games = fetch_lineups()
    fetch_weather(games)
    fetch_statcast()
    fetch_splits()
    fetch_pitcher_statcast()
    print("\n=== Done. Ready for auto_build.py ===")
