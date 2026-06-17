"""
auto_build.py — Onyx Baseball daily build v3

Reads data/ JSON files → runs model → injects into shell.html → writes index.html
v3 changes:
  - Wind factor now covers ALL outdoor parks (was 8-park whitelist → neutral everywhere else)
  - SUMMARIES includes away_pitcher / home_pitcher (fixes "vs undefined" on game cards)
  - ATH / Las Vegas Ballpark support + OAK<->ATH game_key aliasing for game_lines.json
  - Date header replacement is case-insensitive (fixes frozen "MAY 23" board header)
"""

import json, re, unicodedata, datetime
from pathlib import Path
from model import (
    project_player, apply_game_diversity,
    PARK_HR_FACTOR, PITCHER_CAREER_DB, pitcher_factor
)

DATA  = Path("data")
BASE  = Path(__file__).parent
SHELL = BASE / "shell.html"
OUT   = BASE / "index.html"

TEAM_PARK = {
    "PIT": ("PNC Park",                False),
    "TOR": ("Rogers Centre",           True),
    "DET": ("Comerica Park",           False),
    "BAL": ("Camden Yards",            False),
    "MIN": ("Target Field",            False),
    "BOS": ("Fenway Park",             False),
    "TB":  ("Tropicana Field",         True),
    "NYY": ("Yankee Stadium",          False),
    "CLE": ("Progressive Field",       False),
    "PHI": ("Citizens Bank Park",      False),
    "NYM": ("Citi Field",              False),
    "MIA": ("loanDepot Park",          True),
    "STL": ("Busch Stadium",           False),
    "CIN": ("Great American Ball Park",False),
    "LAD": ("Dodger Stadium",          False),
    "MIL": ("American Family Field",   True),
    "SEA": ("T-Mobile Park",           False),
    "KC":  ("Kauffman Stadium",        False),
    "HOU": ("Minute Maid Park",        True),
    "CHC": ("Wrigley Field",           False),
    "CWS": ("Guaranteed Rate Field",   False),
    "SF":  ("Oracle Park",             False),
    "COL": ("Coors Field",             False),
    "ARI": ("Chase Field",             True),
    "WAS": ("Nationals Park",          False),
    "ATL": ("Truist Park",             False),
    "OAK": ("Oakland Coliseum",        False),
    "ATH": ("Las Vegas Ballpark",      False),
    "SD":  ("Petco Park",              False),
    "TEX": ("Globe Life Field",        True),
    "LAA": ("Angel Stadium",           False),
}

PITCHER_HAND = {
    # June 17 LHP starters
    "anthony kay": "L",
    "nick lodolo": "L",
    "sam aldegheri": "L",
    "carlos rodon": "L",
    "robbie ray": "L",
    "shane mcclanahan": "L",
    "eduardo rodriguez": "L",
    "jake bennett": "L",
    "sean sullivan": "L",
    # Common LHP starters (kept so they're correct on future days too)
    "jesus luzardo": "L", "framber valdez": "L", "payton tolle": "L",
    "foster griffin": "L", "robert gasser": "L", "justin wrobleski": "L",
    "andrew abbott": "L", "mackenzie gore": "L", "garrett crochet": "L",
    "cole ragans": "L", "max fried": "L", "tarik skubal": "L",
    "blake snell": "L", "chris sale": "L", "yusei kikuchi": "L",
    "kyle harrison": "L", "dylan cease": "R",  # (Cease is R — explicit guard)
}

def pitcher_hand(pname):
    """Return 'L' or 'R'. Checks PITCHER_HAND, then pitcher_db 'hand', else 'R'."""
    if not pname:
        return "R"
    pk = pname.lower()
    if pk in PITCHER_HAND:
        return PITCHER_HAND[pk]
    db_hand = PITCHER_CAREER_DB.get(pk, {}).get("hand")
    return db_hand if db_hand in ("L", "R") else "R"
  
# Wind FROM these compass directions blows OUT toward CF (approx CF bearings,
# tune per park as results come in). Roofed parks never reach these tables.
PARK_OUT = {
    "Wrigley Field":            ["SW","WSW","SSW","W","WNW"],
    "Citizens Bank Park":       ["SW","WSW","W","WNW","NW"],
    "Oracle Park":              ["E","SE","ESE","SSE","NE"],
    "Great American Ball Park": ["SW","S","SSW","W","WSW"],
    "Yankee Stadium":           ["SW","SSW","S","WSW","W"],
    "Fenway Park":              ["SW","SSW","W","WSW"],
    "Globe Life Field":         ["S","SSW","SW","SSE"],
    "Truist Park":              ["SW","W","WSW","S"],
    "PNC Park":                 ["S","SSW","SW","SSE"],
    "Comerica Park":            ["W","WSW","SW","WNW"],
    "Camden Yards":             ["S","SSW","SW"],
    "Target Field":             ["W","WSW","WNW","SW"],
    "Progressive Field":        ["S","SSW","SSE","SW"],
    "Citi Field":               ["SW","SSW","S","WSW"],
    "Busch Stadium":            ["WSW","SW","W","SSW"],
    "Dodger Stadium":           ["S","SSW","SW","SSE"],
    "T-Mobile Park":            ["SW","SSW","S","WSW"],
    "Kauffman Stadium":         ["SW","WSW","SSW","W"],
    "Guaranteed Rate Field":    ["S","SSW","SW","SSE"],
    "Coors Field":              ["S","SSW","SSE","SW"],
    "Nationals Park":           ["SW","SSW","S","WSW"],
    "Oakland Coliseum":         ["SW","WSW","SSW","W"],
    "Las Vegas Ballpark":       ["SW","SSW","WSW","S"],
    "Angel Stadium":            ["WSW","SW","W","SSW"],
    "Petco Park":               ["S","SSW","SSE","SW"],
}
PARK_IN = {
    "Wrigley Field":            ["NE","ENE","N","NNE"],
    "Citizens Bank Park":       ["NE","ENE","E"],
    "Great American Ball Park": ["N","NE","NNE","E"],
    "Oracle Park":              ["W","NW","WNW","SW"],
    "Yankee Stadium":           ["NE","ENE","N"],
    "Fenway Park":              ["NE","ENE","E"],
    "Truist Park":              ["NE","E","ENE"],
    "PNC Park":                 ["N","NNE","NE"],
    "Comerica Park":            ["E","ENE","ESE"],
    "Camden Yards":             ["N","NNE","NE"],
    "Target Field":             ["E","ESE","ENE"],
    "Progressive Field":        ["N","NNE","NNW"],
    "Citi Field":               ["NE","NNE","N"],
    "Busch Stadium":            ["ENE","NE","E"],
    "Dodger Stadium":           ["N","NNE","NE"],
    "T-Mobile Park":            ["NE","NNE","N"],
    "Kauffman Stadium":         ["NE","ENE","NNE"],
    "Guaranteed Rate Field":    ["N","NNE","NNW"],
    "Coors Field":              ["N","NNE","NNW"],
    "Nationals Park":           ["NE","NNE","N"],
    "Oakland Coliseum":         ["NE","ENE","NNE"],
    "Las Vegas Ballpark":       ["NE","NNE","ENE"],
    "Angel Stadium":            ["ENE","NE","E"],
    "Petco Park":               ["N","NNE","NNW"],
}

# ── SALARY HELPERS ─────────────────────────────────────────────────────────────
def _norm_name(s):
    """Lowercase, strip accents/punctuation and Jr/Sr/II/III suffixes."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().strip()
    s = re.sub(r"[.'`\-]", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()

def lookup_salary(sal_map, name):
    """Return {dk, fd} salary dict for a player, tolerant of name-format differences."""
    if not name:
        return {}
    nk = name.lower()
    if nk in sal_map:
        return sal_map[nk]
    target = _norm_name(name)
    # Build normalised index once per sal_map instance
    cache_key = id(sal_map)
    idx = getattr(lookup_salary, "_cache", None)
    if idx is None or idx.get("_key") != cache_key:
        idx = {"_key": cache_key}
        for k, v in sal_map.items():
            idx[_norm_name(k)] = v
        lookup_salary._cache = idx
    return idx.get(target, {})

def load_salaries():
    """Load salaries.json → {player_name_lower: {dk, fd}}"""
    path = DATA / "salaries.json"
    if not path.exists():
        print("  WARNING: salaries.json not found — using default salaries")
        return {}
    raw = json.loads(path.read_text())
    # Support both {name: {dk,fd}} and [{name,dk_salary,fd_salary}] shapes
    sal_map = {}
    if isinstance(raw, list):
        for entry in raw:
            n = entry.get("name", "")
            if n:
                sal_map[n.lower()] = {
                    "dk": entry.get("dk_salary") or entry.get("dk") or 3000,
                    "fd": entry.get("fd_salary") or entry.get("fd") or 3000,
                }
    else:
        for k, v in raw.items():
            sal_map[k.lower()] = v if isinstance(v, dict) else {"dk": v, "fd": v}
    print(f"  Salaries: {len(sal_map)} players loaded")
    return sal_map

def load_game_lines():
    """Load game_lines.json → {game_key: {ou, away_ml, home_ml}}"""
    path = DATA / "game_lines.json"
    if not path.exists():
        print("  WARNING: game_lines.json not found — moneylines/totals will be empty")
        return {}
    gl = json.loads(path.read_text())
    print(f"  Game lines: {len(gl)} games loaded")
    return gl

def get_game_line(game_lines, gk):
    """Lookup with OAK<->ATH aliasing so DK keys match MLB API keys either way."""
    if gk in game_lines:
        return game_lines[gk]
    for a, b in (("OAK", "ATH"), ("ATH", "OAK")):
        alias = gk.replace(a, b)
        if alias != gk and alias in game_lines:
            return game_lines[alias]
    return {}

# ── HTML INJECTION HELPERS ────────────────────────────────────────────────────
def bracket_replace(html, varname, new_json_str):
    idx = html.find(f"const {varname} = ")
    if idx < 0:
        return html, False
    start = idx + len(f"const {varname} = ")
    ch = html[start]
    end_ch = "]" if ch == "[" else "}"
    depth = 0
    i = start
    while i < len(html):
        if html[i] == ch:
            depth += 1
        elif html[i] == end_ch:
            depth -= 1
            if depth == 0:
                ei = i + 1
                if ei < len(html) and html[ei] == ";":
                    ei += 1
                return html[:idx] + f"const {varname} = {new_json_str};" + html[ei:], True
        i += 1
    return html, False

def extract_obj(html, varname):
    idx = html.find(f"const {varname} = ")
    if idx < 0:
        return "[]"
    start = idx + len(f"const {varname} = ")
    ch = html[start]
    end_ch = "]" if ch == "[" else "}"
    depth = 0
    i = start
    while i < len(html):
        if html[i] == ch:
            depth += 1
        elif html[i] == end_ch:
            depth -= 1
            if depth == 0:
                return html[start:i+1]
        i += 1
    return "[]"

# ── WEATHER / WIND HELPERS ────────────────────────────────────────────────────
def weather_flag(precip_pct):
    if precip_pct >= 70: return "ppd_risk"
    if precip_pct >= 40: return "delay_risk"
    if precip_pct >= 20: return "shower_risk"
    return "clear"

def wind_label(wind_dir, wind_mph, park, wind_factor):
    arrow = "↗" if wind_factor > 1.02 else "↘" if wind_factor < 0.98 else "→"
    direction = "OUT" if wind_factor > 1.02 else "IN" if wind_factor < 0.98 else "NEUTRAL"
    return f"{wind_dir} {int(wind_mph)}mph {arrow} {direction}"

def calc_wind_factor(park, wind_dir, wind_mph, temp, roof):
    if roof:
        return max(0.96, 1 + (temp - 72) * 0.002)
    factor = 1.0
    if park in PARK_OUT and wind_dir in PARK_OUT[park]:
        factor += 0.005 * min(wind_mph, 20)
    elif wind_dir in PARK_IN.get(park, []):
        factor -= 0.004 * min(wind_mph, 20)
    factor += max(0, (temp - 72) * 0.002)
    return round(max(0.85, min(1.15, factor)), 4)

def format_game_time(game_time_iso):
    try:
        dt = datetime.datetime.fromisoformat(game_time_iso.replace("Z", "+00:00"))
        eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
        return eastern.strftime("%-I:%M %p ET")
    except:
        return ""

# ── MAIN BUILD ────────────────────────────────────────────────────────────────
def build():
    print("=== Onyx Auto-Build ===\n")

    lineups    = json.loads((DATA / "lineups.json").read_text())
    odds_map   = json.loads((DATA / "odds.json").read_text())
    weather    = json.loads((DATA / "weather.json").read_text())
    l14_hit    = json.loads((DATA / "statcast_l14.json").read_text())
    l14_pitch  = json.loads((DATA / "pitchers_l14.json").read_text())
    sal_map    = load_salaries()
    game_lines = load_game_lines()

    with open(SHELL) as f:
        html = f.read()

    today = datetime.date.today()

    RESULTS = []

    for game_key, game in lineups.items():
        home_team = game["home_team"]
        away_team = game["away_team"]
        park, roof = TEAM_PARK.get(home_team, ("Unknown Park", False))
        park_f = PARK_HR_FACTOR.get(park, 1.00)

        w          = weather.get(home_team, {})
        temp       = w.get("temp", 72)
        wind_mph   = w.get("wind_mph", 5)
        wind_dir   = w.get("wind_dir", "N")
        precip_pct = w.get("precip_pct", 0)
        wflag      = weather_flag(precip_pct)
        wf         = calc_wind_factor(park, wind_dir, wind_mph, temp, roof)
        wlabel     = wind_label(wind_dir, wind_mph, park, wf)

        game_time  = game.get("game_time", "")
        time_str   = format_game_time(game_time)
        game_label = f"{away_team} @ {home_team} ({time_str})"

        home_pitcher = game.get("home_pitcher", "TBD")
        away_pitcher = game.get("away_pitcher", "TBD")

        # Pitcher stats for display
        def get_pitcher_stats(pname):
            pk = pname.lower()
            pd = PITCHER_CAREER_DB.get(pk, {})
            pf = pitcher_factor(pname, l14_pitch)
            era  = pd.get("e3", 4.50) or 4.50
            xfip = pd.get("xf3", 4.00) or 4.00
            hr9  = round(pd.get("h3", xfip * 0.12) or xfip * 0.12, 3)
            return pf, era, xfip, hr9

        home_pf, home_era, home_xfip, home_hr9 = get_pitcher_stats(home_pitcher)
        away_pf, away_era, away_xfip, away_hr9 = get_pitcher_stats(away_pitcher)

        all_players = (
            [(p, True)  for p in game["home_lineup"]] +
            [(p, False) for p in game["away_lineup"]]
        )

        for player, is_home in all_players:
            name = player["name"]
            pos  = player.get("pos", "OF")
            bo   = player.get("batting_order", 5)
            team = home_team if is_home else away_team
            opp  = away_team if is_home else home_team
            opp_pitcher = away_pitcher if is_home else home_pitcher
            opp_pf, opp_era, opp_xfip, opp_hr9 = (
                (away_pf, away_era, away_xfip, away_hr9) if is_home
                else (home_pf, home_era, home_xfip, home_hr9)
            )

            dk_odds = odds_map.get(name.lower())

            # ── Salary lookup (replaces hardcoded $3000/$7000/$8000) ──────────
            bsal       = lookup_salary(sal_map, name)
            bat_dk_sal = int(bsal.get("dk") or 3000)
            bat_fd_sal = int(bsal.get("fd") or 3000)

            proj = project_player(
                name=name, pos=pos, batting_order=bo, is_home=is_home,
                opp_pitcher=opp_pitcher, park=park, park_factor=park_f,
                wind_dir=wind_dir, wind_mph=wind_mph, temp=temp, roof=roof,
                dk_odds=dk_odds, dk_salary=bat_dk_sal, fd_salary=bat_fd_sal,
                l14_statcast=l14_hit, l14_pitchers=l14_pitch,
                game_key=game_key, game_label=game_label, team=team,
                weather_flag=wflag,
            )

            from model import CAREER_DB, sc_score, implied_prob
            d   = CAREER_DB.get(name.lower(), {})
            l14 = l14_hit.get(name.lower(), {})

            career_rate = d.get("c", 0.038) or 0.038
            split_rate  = d.get("ch" if is_home else "ca", career_rate) or career_rate
            l14_pa  = l14.get("l14_pa", 0)
            l14_hr  = l14.get("l14_hr", 0)
            sc      = proj["sc_score"]

            # Due meter label
            if l14_pa >= 20:
                expected  = career_rate * l14_pa
                due_score = (expected - l14_hr) * sc
                if due_score > 1.2:    due_label = "OVERDUE"
                elif due_score > 0.6:  due_label = "DUE"
                elif due_score > 0.15: due_label = "COOL"
                elif due_score > -0.15:due_label = "NORMAL"
                elif due_score > -0.6: due_label = "WARM"
                elif due_score > -1.2: due_label = "HOT"
                else:                  due_label = "FIRE"
                due_detail = f"{int(l14_hr)}HR/{int(l14_pa)}PA"
            else:
                due_score = 0; due_label = "NORMAL"; due_detail = "—"

            implied = round(implied_prob(dk_odds) * 100, 2) if dk_odds else 0

            r = {
                # Identity
                "batter_name":       name,
                "matched_name":      name,
                "batting_order":     bo,
                "batter_hand":       d.get("hand", "R"),
                "pos":               pos,
                "dk_pos":            pos,
                "fd_pos":            pos,
                "location":          "home" if is_home else "away",
                "team":              team,
                "opp":               opp,
                "away":              away_team,
                "home":              home_team,
                # Game
                "game":              game_label,
                "time":              time_str,
                "game_key":          game_key,
                "game_label":        game_label,
                "weather_flag":      wflag,
                # Park / weather
                "venue":             park,
                "weather_label":     wlabel,
                "wind_from":         wind_dir,
                "wind_factor":       wf,
                "park_hr":           park_f,
                "env_factor":        proj["env"],
                "temp":              temp,
                "wind_mph":          wind_mph,
                # Pitcher
                "opp_pitcher":       opp_pitcher,
                "opp_pitcher_hand":  pitcher_hand(opp_pitcher),
                "opp_pitcher_hr9":   opp_hr9,
                "opp_pitcher_era":   opp_era,
                "p_factor":          opp_pf,
                # Career / Statcast
                "career_hr_pa":      round(career_rate, 5),
                "split_hr_pa":       round(split_rate, 5),
                "l14_hr":            l14_hr,
                "l14_pa":            l14_pa,
                "l14_xwoba":         round(l14.get("l14_hit_rate", 0.30), 4),
                "ev90_26":           d.get("e3", 95),
                "barrel_26":         d.get("b3", 0.08),
                "hh_pct":            d.get("h3", 0.40),
                "iso_ctx":           d.get("i3", 0.165),
                "sc_score":          sc,
                "barrel_pct":        d.get("b3", 0.08),
                "ev90":              d.get("e3", 95),
                # Model outputs
                "hr_per_pa":         round(proj["hr_prob"] / 100 / 4.3, 5),
                "hr_pg":             round(proj["hr_prob"] / 100, 4),
                "hr_prob":           proj["hr_prob"],
                "due_score":         round(due_score, 3),
                "due_adj":           proj["due_mult"],
                "due_label":         due_label,
                "due_detail":        due_detail,
                # Projections
                "dk_proj":           proj["dk_pts"],
                "fd_proj":           proj["fd_pts"],
                "dk_salary":         proj["dk_salary"],
                "fd_salary":         proj["fd_salary"],
                "dk_value":          round(proj["dk_pts"] / max(proj["dk_salary"], 1000) * 1000, 2),
                "fd_value":          round(proj["fd_pts"] / max(proj["fd_salary"], 1000) * 1000, 2),
                # Odds / edge
                "dk_hr_odds":        dk_odds,
                "dk_hr_implied":     implied,
                "hr_edge":           proj["hr_edge"],
                "composite":         proj["composite"],
                "wind_alignment":    round(wf - 1.0, 4),
                # Confirmed flag
                "lineup_confirmed":  game.get("home_confirmed" if is_home else "away_confirmed", False),
            }
            RESULTS.append(r)

    RESULTS = apply_game_diversity(RESULTS)
    print(f"Model ran: {len(RESULTS)} players across {len(lineups)} games")

    # ── SUMMARIES (with game_key + pitchers + moneylines/total) ──────────────
    game_map = {}
    for r in RESULTS:
        gk = r["game_key"]
        if gk not in game_map:
            game_map[gk] = []
        game_map[gk].append(r)

  SUMMARIES = []
for gk in lineups:
    players = game_map.get(gk, [])
    top = sorted(players, key=lambda x: -x["composite"])[:3] if players else []
    home_team = lineups[gk]["home_team"]
        park, roof = TEAM_PARK.get(home_team, ("Unknown", False))
        w  = weather.get(home_team, {})
        gl = get_game_line(game_lines, gk)
        SUMMARIES.append({
            "game_key":      gk,
            "game":          players[0]["game"],
            "label":         players[0]["game"],
            "away":          lineups[gk]["away_team"],
            "home":          home_team,
            "away_pitcher":  lineups[gk].get("away_pitcher", "TBD"),
            "home_pitcher":  lineups[gk].get("home_pitcher", "TBD"),
            "time":          players[0]["time"],
            "park":          park,
            "park_factor":   PARK_HR_FACTOR.get(park, 1.0),
            "weather_flag":  players[0]["weather_flag"],
            "temp":          w.get("temp", 72),
            "wind_mph":      w.get("wind_mph", 5),
            "wind_dir":      w.get("wind_dir", "N"),
            "ou":            gl.get("ou"),
            "away_ml":       gl.get("away_ml", ""),
            "home_ml":       gl.get("home_ml", ""),
            "top_plays":     [
                {
                    "name":      p["batter_name"],
                    "prob":      p["hr_prob"],
                    "edge":      p["hr_edge"],
                    "composite": p["composite"],
                }
                for p in top
            ],
        })

    # ── PITCHERS ──────────────────────────────────────────────────────────────
    seen = set()
    PITCHERS = []
    for gk, game in lineups.items():
        for pname in [game.get("home_pitcher", ""), game.get("away_pitcher", "")]:
            if not pname or pname == "TBD" or pname in seen:
                continue
            seen.add(pname)
            pk = pname.lower()
            pd = PITCHER_CAREER_DB.get(pk, {})
            # Pitcher salary lookup
            psal       = lookup_salary(sal_map, pname)
            pit_dk_sal = int(psal.get("dk") or 7500)
            pit_fd_sal = int(psal.get("fd") or 8000)
            PITCHERS.append({
                "name":      pname,
                "game_key":  gk,
                "xfip":      pd.get("xf3", 4.0),
                "era":       pd.get("e3", 4.0),
                "hr9":       pd.get("h3", 1.0),
                "pfh":       pd.get("pfh", 1.0),
                "pfa":       pd.get("pfa", 1.0),
                "p_factor":  pitcher_factor(pname, l14_pitch),
                "dk_salary": pit_dk_sal,
                "fd_salary": pit_fd_sal,
            })

    ALL_GAME_KEYS = list(game_map.keys())

    # ── Inject into shell.html ────────────────────────────────────────────────
    picks_str      = extract_obj(html, "PICKS")
    dfs_record_str = extract_obj(html, "DFS_RECORD")

    for var, val in [
        ("RESULTS",       json.dumps(RESULTS)),
        ("SUMMARIES",     json.dumps(SUMMARIES)),
        ("PITCHERS",      json.dumps(PITCHERS)),
        ("ALL_GAME_KEYS", json.dumps(ALL_GAME_KEYS)),
        ("PICKS",         picks_str),
        ("DFS_RECORD",    dfs_record_str),
    ]:
        html, ok = bracket_replace(html, var, val)
        print(f"  {var}: {'✓' if ok else 'FAILED'}")

    # Update date header (case-insensitive — shell may have uppercase text)
    months = r"jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
    html = re.sub(
        rf"(?i)({months})[a-z]* \d{{1,2}}, \d{{4}}",
        today.strftime("%b %-d, %Y"), html)
    html = re.sub(
        rf"(?i)(top edge plays\s*[—–-]+\s*)({months})[a-z]*\.? ?\d{{1,2}}",
        lambda m: m.group(1) + today.strftime("%b %-d").upper(),
        html)
    html = re.sub(
        rf"(?i)<title>Onyx Baseball · ({months})[a-z]* \d{{1,2}}</title>",
        f"<title>Onyx Baseball · {today.strftime('%b %-d')}</title>", html)

    with open(OUT, "w") as f:
        f.write(html)

    top5 = sorted([r for r in RESULTS if r.get("dk_hr_odds")], key=lambda x: -x["composite"])[:5]
    confirmed = sum(1 for r in RESULTS if r.get("lineup_confirmed"))
    print(f"\n✅ index.html written — {len(RESULTS)} players, {confirmed} in confirmed lineups")
    print("\nTop 5 edge plays:")
    for p in top5:
        conf = "✓" if p.get("lineup_confirmed") else "~"
        sal  = f"DK${p['dk_salary']:,}"
        val  = f"{p['dk_value']:.2f}x"
        print(f"  {conf} {p['batter_name']:25s} prob={p['hr_prob']}% edge={p['hr_edge']}% "
              f"odds=+{p['dk_hr_odds']} comp={p['composite']:.3f} {sal} val={val}")

if __name__ == "__main__":
    build()
