"""
auto_build.py — Onyx Baseball daily build v3
RESULTS/SUMMARIES/PITCHERS schemas match shell.html JS exactly.
"""

import json, re, datetime, math
from pathlib import Path
from model import (
    project_player, apply_game_diversity,
    PARK_HR_FACTOR, PITCHER_CAREER_DB, CAREER_DB,
    pitcher_factor, sc_score, implied_prob, wind_env
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

# ── HELPERS ────────────────────────────────────────────────────────────────────
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

def wind_alignment(park, wind_dir, wind_mph, roof):
    if roof: return 0.0
    if park in PARK_OUT and wind_dir in PARK_OUT[park]:
        return round(min(wind_mph / 15, 1.0), 2)
    if park in PARK_IN and wind_dir in PARK_IN.get(park, []):
        return round(-min(wind_mph / 15, 1.0), 2)
    return 0.0

def wind_label(wind_dir, wind_mph, wf, roof):
    if roof: return "DOME"
    arrow = "↗" if wf > 1.02 else "↘" if wf < 0.98 else "→"
    direction = "OUT" if wf > 1.02 else "IN" if wf < 0.98 else "NEUTRAL"
    return f"{wind_dir} {int(wind_mph)}mph {arrow} {direction}"

def weather_flag(precip_pct):
    if precip_pct >= 70: return "ppd_risk"
    if precip_pct >= 40: return "delay_risk"
    if precip_pct >= 20: return "shower_risk"
    return "clear"

def format_game_time(game_time_iso):
    try:
        dt = datetime.datetime.fromisoformat(game_time_iso.replace("Z","+00:00"))
        eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
        return eastern.strftime("%-I:%M %p")
    except:
        return "TBD"

def get_pitcher_info(pname, l14_pitch):
    pk = pname.lower()
    pd = PITCHER_CAREER_DB.get(pk, {})
    # pf = pre-computed pitcher factor, xf3 = xFIP 3yr, e3 = ERA 3yr, h3 = HR/9 3yr
    pf   = pd.get("pf") or pitcher_factor(pname, l14_pitch)
    xfip = pd.get("xf3") or pd.get("xf6") or 4.0
    era  = pd.get("e3")  or pd.get("e6")  or round(xfip * 1.05, 2)
    hr9  = pd.get("h3")  or pd.get("h6")  or round(xfip * 0.11, 3)
    # k9: estimate from xFIP (no direct field) - good pitchers have lower xFIP
    k9   = round(max(4.0, 12.0 - xfip * 1.5), 1)
    hand = pd.get("hand", "R") or "R"
    return {"pf": float(pf), "xfip": float(xfip), "era": float(era), "k9": float(k9), "hr9": float(hr9), "hand": hand}

# ── MAIN BUILD ─────────────────────────────────────────────────────────────────
def build():
    print("=== Onyx Auto-Build v3 ===\n")

    lineups   = json.loads((DATA / "lineups.json").read_text())
    odds_path = DATA / "odds.json"
    odds_map  = json.loads(odds_path.read_text()) if odds_path.exists() else {}
    sal_path  = DATA / "salaries.json"
    sal_map   = json.loads(sal_path.read_text()) if sal_path.exists() else {}
    print(f"  Salaries: {len(sal_map)} players loaded" if sal_map else "  Salaries: not found")
    weather   = json.loads((DATA / "weather.json").read_text())
    l14_hit   = json.loads((DATA / "statcast_l14.json").read_text())
    l14_pitch = json.loads((DATA / "pitchers_l14.json").read_text())

    with open(SHELL) as f:
        html = f.read()

    today = datetime.date.today()

    RESULTS  = []
    SUMMARIES = []
    PITCHERS  = []
    seen_pitchers = set()

    for game_key, game in lineups.items():
        home_team    = game["home_team"]
        away_team    = game["away_team"]
        park, roof   = TEAM_PARK.get(home_team, ("Unknown Park", False))
        park_f       = PARK_HR_FACTOR.get(park, 1.00)

        w            = weather.get(home_team, {})
        temp         = w.get("temp", 72)
        wind_mph_val = w.get("wind_mph", 5)
        wind_dir     = w.get("wind_dir", "N")
        precip_pct   = w.get("precip_pct", 0)

        wf           = calc_wind_factor(park, wind_dir, wind_mph_val, temp, roof)
        wa           = wind_alignment(park, wind_dir, wind_mph_val, roof)
        wlabel       = wind_label(wind_dir, wind_mph_val, wf, roof)
        wflag        = weather_flag(precip_pct)

        time_str     = format_game_time(game.get("game_time",""))
        game_label   = f"{away_team} @ {home_team} ({time_str})"

        home_pitcher = game.get("home_pitcher", "TBD")
        away_pitcher = game.get("away_pitcher", "TBD")
        home_pi      = get_pitcher_info(home_pitcher, l14_pitch)
        away_pi      = get_pitcher_info(away_pitcher, l14_pitch)

        # Build PITCHERS entries
        for pname, pi, role, team, opp in [
            (home_pitcher, home_pi, "home", home_team, away_team),
            (away_pitcher, away_pi, "away", away_team, home_team),
        ]:
            if pname and pname != "TBD" and pname not in seen_pitchers:
                seen_pitchers.add(pname)
                PITCHERS.append({
                    "name":     pname,
                    "hand":     pi["hand"],
                    "team":     team,
                    "opp":      opp,
                    "role":     role,
                    "location": role,
                    "game":     game_label,
                    "time":     time_str,
                    "venue":    park,
                    "hr9":      pi["hr9"],
                    "era26":    pi["era"],
                    "xfip":     pi["xfip"],
                    "ip":       5.5,
                    "k9_blend": pi["k9"],
                    "k9_adj":   pi["k9"],
                    "p_factor": pi["pf"],
                    "dk_salary": 7000,
                    "fd_salary": 8000,
                    "dk_proj":  round(pi["k9"] * 0.8 + (5.0 - pi["xfip"]) * 2.5 + 12, 2),
                    "fd_proj":  round(pi["k9"] * 1.2 + (5.0 - pi["xfip"]) * 3.0 + 15, 2),
                    "dk_value": 0,
                    "fd_value": 0,
                })

        # Build RESULTS for each player
        home_results = []
        away_results = []

        all_players = (
            [(p, True,  home_team, away_team, away_pitcher, away_pi) for p in game["home_lineup"]] +
            [(p, False, away_team, home_team, home_pitcher, home_pi) for p in game["away_lineup"]]
        )

        for player, is_home, team, opp, opp_pname, opp_pi in all_players:
            name = player["name"]
            pos  = player.get("pos", "OF")
            bo   = player.get("batting_order", 5)

            dk_odds = odds_map.get(name.lower())

            proj = project_player(
                name=name, pos=pos, batting_order=bo, is_home=is_home,
                opp_pitcher=opp_pname, park=park, park_factor=park_f,
                wind_dir=wind_dir, wind_mph=wind_mph_val, temp=temp, roof=roof,
                dk_odds=dk_odds, dk_salary=3000, fd_salary=3000,
                l14_statcast=l14_hit, l14_pitchers=l14_pitch,
                game_key=game_key, game_label=game_label, team=team,
                weather_flag=wflag,
            )

            d   = CAREER_DB.get(name.lower(), {})
            l14 = l14_hit.get(name.lower(), {})

            career_rate = d.get("c", 0.038) or 0.038
            split_rate  = d.get("ch" if is_home else "ca", career_rate) or career_rate
            l14_pa  = l14.get("l14_pa", 0)
            l14_hr  = l14.get("l14_hr", 0)
            sc      = proj["sc_score"]

            if l14_pa >= 20:
                expected  = career_rate * l14_pa
                due_score = (expected - l14_hr) * sc
                if due_score > 1.2:    due_label = "OVERDUE"
                elif due_score > 0.6:  due_label = "DUE"
                elif due_score > 0.15: due_label = "COOL"
                elif due_score >-0.15: due_label = "NORMAL"
                elif due_score >-0.6:  due_label = "WARM"
                elif due_score >-1.2:  due_label = "HOT"
                else:                  due_label = "FIRE"
                due_detail = f"{int(l14_hr)}HR/{int(l14_pa)}PA"
            else:
                due_score = 0.0; due_label = "NORMAL"; due_detail = "—"

            implied_mkt = round(implied_prob(dk_odds) * 100, 2) if dk_odds else 0.0

            r = {
                # Identity — exact field names the JS reads
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
                "venue":             park,
                # Weather — exact field names
                "weather_label":     wlabel,
                "wind_from":         wind_dir,
                "wind_factor":       wf,
                "wind_alignment":    wa,
                "park_hr":           park_f,
                "env_factor":        wf,
                # Pitcher — exact field names
                "opp_pitcher":       opp_pname,
                "opp_pitcher_hand":  opp_pi["hand"],
                "opp_pitcher_hr9":   opp_pi["hr9"],
                "opp_pitcher_era":   opp_pi["era"],
                "p_factor":          opp_pi["pf"],
                # Career / Statcast — exact field names
                "career_hr_pa":      round(career_rate, 5),
                "split_hr_pa":       round(split_rate, 5),
                "l14_hr":            l14_hr,
                "l14_pa":            l14_pa,
                "l14_xwoba":         round(l14.get("l14_hit_rate", 0.30), 4),
                "ev90_26":           d.get("e3", 95.0),
                "barrel_26":         d.get("b3", 0.08),
                "hh_pct":            d.get("h3", 0.40),
                "iso_ctx":           d.get("i3", 0.165),
                "sc_score":          sc,
                "barrel_pct":        d.get("b3", 0.08),
                "ev90":              d.get("e3", 95.0),
                # Model outputs — exact field names
                "hr_per_pa":         round(proj["hr_prob"] / 100 / 4.3, 5),
                "hr_pg":             round(proj["hr_prob"] / 100, 4),
                "hr_prob":           proj["hr_prob"],
                "due_score":         round(due_score, 3),
                "due_adj":           proj["due_mult"],
                "due_label":         due_label,
                "due_detail":        due_detail,
                # DFS projections — exact field names
                "dk_proj":           proj["dk_pts"],
                "fd_proj":           proj["fd_pts"],
                "dk_salary":         3000,
                "fd_salary":         3000,
                "dk_value":          round(proj["dk_pts"] / 3.0, 2),
                "fd_value":          round(proj["fd_pts"] / 3.0, 2),
                # Internal key for diversity calc
                "game_key":          game_key,
                # Odds / edge — exact field names
                "dk_hr_odds":        dk_odds,
                "dk_hr_implied":     implied_mkt,
                "hr_edge":           proj["hr_edge"],
                "composite":         proj["composite"],
            }
            RESULTS.append(r)
            if is_home:
                home_results.append(r)
            else:
                away_results.append(r)

        # Build SUMMARIES entry with exact field names JS expects
        def top_for_team(players):
            valid = [p for p in players if p["hr_prob"] > 0]
            valid.sort(key=lambda x: -x["hr_prob"])
            return valid[0] if valid else None

        away_top_r  = top_for_team(away_results)
        home_top_r  = top_for_team(home_results)
        away_exp_hr = round(sum(r["hr_prob"]/100 for r in away_results), 2)
        home_exp_hr = round(sum(r["hr_prob"]/100 for r in home_results), 2)

        SUMMARIES.append({
            "game":           game_label,
            "label":          game_label,
            "time":           time_str,
            "away":           away_team,
            "home":           home_team,
            "venue":          park,
            "ou":             None,
            "roof":           roof,
            "away_ml":        "",
            "home_ml":        "",
            "temp":           temp,
            "wind_spd":       wind_mph_val,
            "wind_dir":       wind_dir,
            "wind_factor":    wf,
            "env_factor":     wf,
            "wind_alignment": wa,
            "weather_label":  wlabel,
            "wind_from":      wind_dir,
            # Pitcher fields — JS reads awayP/homeP (confusingly: awayP = pitcher the away team faces = HOME pitcher)
            "awayP":          home_pitcher,   # pitcher facing away batters
            "awayHand":       home_pi["hand"],
            "awayP_hr9":      home_pi["hr9"],
            "homeP":          away_pitcher,   # pitcher facing home batters
            "homeHand":       away_pi["hand"],
            "homeP_hr9":      away_pi["hr9"],
            # Top plays
            "away_top":       away_top_r["batter_name"] if away_top_r else "",
            "away_top_prob":  away_top_r["hr_prob"] if away_top_r else 0,
            "home_top":       home_top_r["batter_name"] if home_top_r else "",
            "home_top_prob":  home_top_r["hr_prob"] if home_top_r else 0,
            "away_exp_hr":    away_exp_hr,
            "home_exp_hr":    home_exp_hr,
            "n_away":         len(away_results),
            "n_home":         len(home_results),
        })

    RESULTS = apply_game_diversity(RESULTS)
    ALL_GAME_KEYS = list(lineups.keys())

    # Preserve PICKS and DFS_RECORD from shell
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

    # Update date labels
    html = re.sub(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+, \d{4}",
                  today.strftime("%b %-d, %Y"), html)
    html = re.sub(r"Top Edge Plays — \w+ \d+",
                  f"Top Edge Plays — {today.strftime('%b %-d')}", html)
    html = re.sub(r"<title>Onyx Baseball · \w+ \d+</title>",
                  f"<title>Onyx Baseball · {today.strftime('%b %-d')}</title>", html)

    with open(OUT, "w") as f:
        f.write(html)

    top5 = sorted([r for r in RESULTS if r.get("dk_hr_odds")], key=lambda x: -x["composite"])[:5]
    print(f"\n✅ {len(RESULTS)} players, {len(SUMMARIES)} games, {len(PITCHERS)} pitchers → index.html")
    print("\nTop 5 edge plays:")
    for p in top5:
        print(f"  {p['batter_name']:25s} prob={p['hr_prob']}% edge={p['hr_edge']}% odds=+{p['dk_hr_odds']}")

if __name__ == "__main__":
    build()
