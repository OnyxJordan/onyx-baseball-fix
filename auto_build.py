"""
auto_build.py — Onyx Baseball daily build v2

Reads data/ JSON files → runs model → injects into shell.html → writes index.html
RESULTS schema matches original HTML exactly so all tabs/UI work correctly.
"""

import json, re, datetime
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
    "SD":  ("Petco Park",              False),
    "TEX": ("Globe Life Field",        True),
    "LAA": ("Angel Stadium",           False),
}

PARK_OUT = {
    "Wrigley Field":            ["SW","WSW","SSW","W","WNW"],
    "Citizens Bank Park":       ["SW","WSW","W","WNW","NW"],
    "Oracle Park":              ["E","SE","ESE","SSE","NE"],
    "Great American Ball Park": ["SW","S","SSW","W","WSW"],
    "Yankee Stadium":           ["SW","SSW","S","WSW","W"],
    "Fenway Park":              ["SW","SSW","W","WSW"],
    "Globe Life Field":         ["S","SSW","SW","SSE"],
    "Truist Park":              ["SW","W","WSW","S"],
}
PARK_IN = {
    "Wrigley Field":            ["NE","ENE","N","NNE"],
    "Citizens Bank Park":       ["NE","ENE","E"],
    "Great American Ball Park": ["N","NE","NNE","E"],
    "Oracle Park":              ["W","NW","WNW","SW"],
}

def bracket_replace(html, varname, new_json_str):
    idx = html.find(f"const {varname} = ")
    if idx < 0: return html, False
    start = idx + len(f"const {varname} = ")
    ch = html[start]; end_ch = "]" if ch == "[" else "}"
    depth = 0; i = start
    while i < len(html):
        if html[i] == ch:    depth += 1
        elif html[i] == end_ch:
            depth -= 1
            if depth == 0:
                ei = i + 1
                if ei < len(html) and html[ei] == ";": ei += 1
                return html[:idx] + f"const {varname} = {new_json_str};" + html[ei:], True
        i += 1
    return html, False

def extract_obj(html, varname):
    idx = html.find(f"const {varname} = ")
    if idx < 0: return "[]"
    start = idx + len(f"const {varname} = ")
    ch = html[start]; end_ch = "]" if ch=="[" else "}"
    depth=0; i=start
    while i < len(html):
        if html[i]==ch: depth+=1
        elif html[i]==end_ch:
            depth-=1
            if depth==0: return html[start:i+1]
        i+=1
    return "[]"

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
    elif park in PARK_IN and wind_dir in PARK_IN.get(park, []):
        factor -= 0.004 * min(wind_mph, 20)
    factor += max(0, (temp - 72) * 0.002)
    return round(max(0.85, min(1.15, factor)), 4)

def format_game_time(game_time_iso):
    try:
        dt = datetime.datetime.fromisoformat(game_time_iso.replace("Z","+00:00"))
        eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
        return eastern.strftime("%-I:%M %p ET")
    except:
        return ""

def build():
    print("=== Onyx Auto-Build ===\n")

    lineups   = json.loads((DATA / "lineups.json").read_text())
  odds_path = DATA / "odds.json"
odds_map  = json.loads(odds_path.read_text()) if odds_path.exists() else {}
    weather   = json.loads((DATA / "weather.json").read_text())
    l14_hit   = json.loads((DATA / "statcast_l14.json").read_text())
    l14_pitch = json.loads((DATA / "pitchers_l14.json").read_text())

    with open(SHELL) as f:
        html = f.read()

    today = datetime.date.today()
    date_label = today.strftime("%-m/%-d")

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
            # Build HR/9 from pitcher career data
            era  = pd.get("era", 4.50)
            xfip = pd.get("xfip", 4.00)
            hr9  = round(xfip * 0.12, 3)  # approximate from xFIP
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
            opp_pitcher      = away_pitcher if is_home else home_pitcher
            opp_pf, opp_era, opp_xfip, opp_hr9 = (
                (away_pf, away_era, away_xfip, away_hr9) if is_home
                else (home_pf, home_era, home_xfip, home_hr9)
            )

            dk_odds = odds_map.get(name.lower())

            proj = project_player(
                name=name, pos=pos, batting_order=bo, is_home=is_home,
                opp_pitcher=opp_pitcher, park=park, park_factor=park_f,
                wind_dir=wind_dir, wind_mph=wind_mph, temp=temp, roof=roof,
                dk_odds=dk_odds, dk_salary=3000, fd_salary=3000,
                l14_statcast=l14_hit, l14_pitchers=l14_pitch,
                game_key=game_key, game_label=game_label, team=team,
                weather_flag=wflag,
            )

            # Get player career data for extra fields the original HTML uses
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
                expected = career_rate * l14_pa
                due_score = (expected - l14_hr) * sc
                if due_score > 1.2:   due_label = "OVERDUE"
                elif due_score > 0.6: due_label = "DUE"
                elif due_score > 0.15:due_label = "COOL"
                elif due_score >-0.15:due_label = "NORMAL"
                elif due_score >-0.6: due_label = "WARM"
                elif due_score >-1.2: due_label = "HOT"
                else:                 due_label = "FIRE"
                due_detail = f"{int(l14_hr)}HR/{int(l14_pa)}PA"
            else:
                due_score = 0; due_label = "NORMAL"; due_detail = "—"

            implied = round(implied_prob(dk_odds) * 100, 2) if dk_odds else 0

            # Build full result matching original HTML schema
            r = {
                # Identity
                "batter_name":        name,
                "matched_name":       name,
                "batting_order":      bo,
                "batter_hand":        d.get("hand", "R"),
                "pos":                pos,
                "dk_pos":             pos,
                "fd_pos":             pos,
                "location":           "home" if is_home else "away",
                "team":               team,
                "opp":                opp,
                "away":               away_team,
                "home":               home_team,
                # Game
                "game":               game_label,
                "time":               time_str,
                "game_key":           game_key,
                "game_label":         game_label,
                "weather_flag":       wflag,
                # Park / weather
                "venue":              park,
                "weather_label":      wlabel,
                "wind_from":          wind_dir,
                "wind_factor":        wf,
                "park_hr":            park_f,
                "env_factor":         proj["env"],
                "temp":               temp,
                "wind_mph":           wind_mph,
                # Pitcher
                "opp_pitcher":        opp_pitcher,
                "opp_pitcher_hand":   "R",
                "opp_pitcher_hr9":    opp_hr9,
                "opp_pitcher_era":    opp_era,
                "p_factor":           opp_pf,
                # Career / Statcast
                "career_hr_pa":       round(career_rate, 5),
                "split_hr_pa":        round(split_rate, 5),
                "l14_hr":             l14_hr,
                "l14_pa":             l14_pa,
                "l14_xwoba":          round(l14.get("l14_hit_rate", 0.30), 4),
                "ev90_26":            d.get("e3", 95),
                "barrel_26":          d.get("b3", 0.08),
                "hh_pct":             d.get("h3", 0.40),
                "iso_ctx":            d.get("i3", 0.165),
                "sc_score":           sc,
                "barrel_pct":         d.get("b3", 0.08),
                "ev90":               d.get("e3", 95),
                # Model outputs
                "hr_per_pa":          round(proj["hr_prob"] / 100 / 4.3, 5),
                "hr_pg":              round(proj["hr_prob"] / 100, 4),
                "hr_prob":            proj["hr_prob"],
                "due_score":          round(due_score, 3),
                "due_adj":            proj["due_mult"],
                "due_label":          due_label,
                "due_detail":         due_detail,
                # Projections
                "dk_proj":            proj["dk_pts"],
                "fd_proj":            proj["fd_pts"],
                "dk_salary":          proj["dk_salary"],
                "fd_salary":          proj["fd_salary"],
                "dk_value":           round(proj["dk_pts"] / max(proj["dk_salary"], 1000) * 1000, 2),
                "fd_value":           round(proj["fd_pts"] / max(proj["fd_salary"], 1000) * 1000, 2),
                # Odds / edge
                "dk_hr_odds":         dk_odds,
                "dk_hr_implied":      implied,
                "hr_edge":            proj["hr_edge"],
                "composite":          proj["composite"],
                "wind_alignment":     round(wf - 1.0, 4),
                # Confirmed flag
                "lineup_confirmed":   game.get("home_confirmed" if is_home else "away_confirmed", False),
            }
            RESULTS.append(r)

    RESULTS = apply_game_diversity(RESULTS)
    print(f"Model ran: {len(RESULTS)} players across {len(lineups)} games")

    # SUMMARIES
    game_map = {}
    for r in RESULTS:
        gk = r["game_key"]
        if gk not in game_map: game_map[gk] = []
        game_map[gk].append(r)

    SUMMARIES = []
    for gk, players in game_map.items():
        top = sorted(players, key=lambda x: -x["composite"])[:3]
        home_team = lineups[gk]["home_team"]
        park, roof = TEAM_PARK.get(home_team, ("Unknown", False))
        w = weather.get(home_team, {})
        SUMMARIES.append({
            "game_key":    gk,
            "label":       players[0]["game"],
            "park":        park,
            "park_factor": PARK_HR_FACTOR.get(park, 1.0),
            "weather_flag":players[0]["weather_flag"],
            "temp":        w.get("temp", 72),
            "wind_mph":    w.get("wind_mph", 5),
            "wind_dir":    w.get("wind_dir", "N"),
            "top_plays":   [{"name":p["batter_name"],"prob":p["hr_prob"],"edge":p["hr_edge"],"composite":p["composite"]} for p in top],
        })

    # PITCHERS
    seen = set()
    PITCHERS = []
    for gk, game in lineups.items():
        for pname in [game.get("home_pitcher",""), game.get("away_pitcher","")]:
            if not pname or pname == "TBD" or pname in seen: continue
            seen.add(pname)
            pk = pname.lower()
            pd = PITCHER_CAREER_DB.get(pk, {})
            PITCHERS.append({
                "name":     pname,
                "game_key": gk,
                "xfip":     pd.get("xfip", 4.0),
                "era":      pd.get("era", 4.0),
                "k9":       pd.get("k9", 8.0),
                "p_factor": pitcher_factor(pname, l14_pitch),
            })

    ALL_GAME_KEYS = list(game_map.keys())

    # Inject into shell
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

    # Update date
    html = re.sub(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+, \d{4}",
                  today.strftime("%b %-d, %Y"), html)
    html = re.sub(r"Top Edge Plays — (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+",
                  f"Top Edge Plays — {today.strftime('%b %-d')}", html)
    html = re.sub(r"<title>Onyx Baseball · (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+</title>",
                  f"<title>Onyx Baseball · {today.strftime('%b %-d')}</title>", html)

    with open(OUT, "w") as f:
        f.write(html)

    # Print summary
    top5 = sorted([r for r in RESULTS if r.get("dk_hr_odds")], key=lambda x: -x["composite"])[:5]
    confirmed = sum(1 for r in RESULTS if r.get("lineup_confirmed"))
    print(f"\n✅ index.html written — {len(RESULTS)} players, {confirmed} in confirmed lineups")
    print("\nTop 5 edge plays:")
    for p in top5:
        conf = "✓" if p.get("lineup_confirmed") else "~"
        print(f"  {conf} {p['batter_name']:25s} prob={p['hr_prob']}% edge={p['hr_edge']}% odds=+{p['dk_hr_odds']} comp={p['composite']:.3f}")

if __name__ == "__main__":
    build()
