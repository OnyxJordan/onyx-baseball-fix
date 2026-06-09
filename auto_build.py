"""
auto_build.py — Onyx Baseball daily build v3

Changes from v2:
  1. SUMMARIES / PITCHERS / ALL_GAME_KEYS now match the shell.html data contract
     exactly (keyed by game label, awayP/homeP fields, pitcher projections).
     Fixes the "vs undefined / undefinedHP" bug and broken game filters.
  2. Persistent saved stats:
       data/picks_input.json -> merged into PICKS  (dedup, newest first)
       data/dfs_input.json   -> merged into DFS_RECORD (dedup by date)
     Stats now survive every rebuild. You only ever edit the two JSON files.
  3. Doubleheader-safe game-line lookup (strips _2 suffix).
"""

import json, re, unicodedata, datetime
from pathlib import Path
from model import (
    project_player, apply_game_diversity,
    PARK_HR_FACTOR, PITCHER_CAREER_DB, pitcher_factor, CAREER_DB,
    sc_score, implied_prob
)

DATA  = Path("data")
BASE  = Path(__file__).parent
SHELL = BASE / "shell.html"
OUT   = BASE / "index.html"

TEAM_PARK = {
    "PIT": ("PNC Park",                False),
    "TOR": ("Rogers Centre",           True),
    "DET": ("Comerica Park",           False),
    "BAL": ("Oriole Park at Camden Yards", False),
    "MIN": ("Target Field",            False),
    "BOS": ("Fenway Park",             False),
    "TB":  ("Tropicana Field",         True),
    "NYY": ("Yankee Stadium",          False),
    "CLE": ("Progressive Field",       False),
    "PHI": ("Citizens Bank Park",      False),
    "NYM": ("Citi Field",              False),
    "MIA": ("loanDepot park",          True),
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

# ── NAME / SALARY HELPERS ─────────────────────────────────────────────────────
def _norm_name(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().strip()
    s = re.sub(r"[.'`\-]", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()

def lookup_salary(sal_map, name):
    if not name:
        return {}
    nk = name.lower()
    if nk in sal_map:
        return sal_map[nk]
    target = _norm_name(name)
    cache_key = id(sal_map)
    idx = getattr(lookup_salary, "_cache", None)
    if idx is None or idx.get("_key") != cache_key:
        idx = {"_key": cache_key}
        for k, v in sal_map.items():
            idx[_norm_name(k)] = v
        lookup_salary._cache = idx
    return idx.get(target, {})

def load_salaries():
    path = DATA / "salaries.json"
    if not path.exists():
        print("  WARNING: salaries.json not found — using default salaries")
        return {}
    raw = json.loads(path.read_text())
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
    path = DATA / "game_lines.json"
    if not path.exists():
        print("  WARNING: game_lines.json not found — moneylines/totals will be empty")
        return {}
    raw = json.loads(path.read_text())
    # Support both dict {key:{...}} and list [{game_key,...}] shapes
    gl = {}
    if isinstance(raw, list):
        for e in raw:
            k = (e.get("game_key") or "").replace("@", "_")
            if k: gl[k] = e
    else:
        for k, v in raw.items():
            gl[k.replace("@", "_")] = v
    print(f"  Game lines: {len(gl)} games loaded")
    return gl

def get_game_line(game_lines, away, home):
    """Doubleheader-safe lookup: AWAY_HOME, with _2 suffix fallback."""
    base = f"{away}_{home}"
    return game_lines.get(base) or game_lines.get(base + "_2") or {}

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

# ── PERSISTENT STATS: PICKS ───────────────────────────────────────────────────
def merge_picks(html):
    """Merge data/picks_input.json into the shell's existing PICKS array.
    Picks with "hit": null are PENDING and skipped (they'd count as losses in
    the P&L math) — set true/false after the games and rebuild."""
    try:
        existing = json.loads(extract_obj(html, "PICKS"))
    except Exception:
        existing = []
    path = DATA / "picks_input.json"
    incoming = []
    if path.exists():
        try:
            incoming = json.loads(path.read_text())
        except Exception as e:
            print(f"  WARNING: picks_input.json unreadable: {e}")
    seen = {(p.get("date"), _norm_name(p.get("player","")), p.get("odds")) for p in existing}
    added, pending = [], 0
    for p in incoming:
        if p.get("hit") is None:
            pending += 1
            continue
        key = (p.get("date"), _norm_name(p.get("player","")), p.get("odds"))
        if key in seen:
            # update result if it changed (e.g. was logged earlier as miss)
            for ex in existing:
                if (ex.get("date"), _norm_name(ex.get("player","")), ex.get("odds")) == key:
                    ex["hit"] = bool(p["hit"])
            continue
        seen.add(key)
        added.append({"date": p["date"], "player": p["player"],
                      "odds": p["odds"], "hit": bool(p["hit"])})
    merged = added + existing          # newest first
    hits = sum(1 for p in merged if p["hit"])
    print(f"  PICKS: {len(existing)} existing + {len(added)} new "
          f"({pending} pending skipped) → record {hits}-{len(merged)-hits}")
    return merged

# ── PERSISTENT STATS: DFS RECORD ──────────────────────────────────────────────
def merge_dfs(html):
    """Merge data/dfs_input.json into the shell's DFS_RECORD array.
    Entry shape: {"date":"26-May","dk_entry":0,"dk_win":0,"fd_entry":0,"fd_win":0}
    Dedupes by date (incoming wins). Order: oldest → newest (shell convention)."""
    try:
        existing = json.loads(extract_obj(html, "DFS_RECORD"))
    except Exception:
        existing = []
    path = DATA / "dfs_input.json"
    incoming = []
    if path.exists():
        try:
            incoming = json.loads(path.read_text())
        except Exception as e:
            print(f"  WARNING: dfs_input.json unreadable: {e}")
    by_date = {e["date"]: e for e in existing}
    added = 0
    for e in incoming:
        if e.get("date") and e["date"] not in by_date:
            added += 1
        if e.get("date"):
            by_date[e["date"]] = {
                "date": e["date"],
                "dk_entry": e.get("dk_entry", 0), "dk_win": e.get("dk_win", 0),
                "fd_entry": e.get("fd_entry", 0), "fd_win": e.get("fd_win", 0),
            }
    def date_key(d):
        try:
            day, mon = d["date"].split("-")
            months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
            return (months.index(mon[:3]), int(day))
        except Exception:
            return (99, 99)
    merged = sorted(by_date.values(), key=date_key)
    pnl = sum(e["dk_win"]-e["dk_entry"]+e["fd_win"]-e["fd_entry"] for e in merged)
    print(f"  DFS_RECORD: {len(existing)} existing + {added} new → P&L ${pnl:+.0f}")
    return merged

# ── WEATHER / WIND HELPERS ────────────────────────────────────────────────────
def weather_flag(precip_pct):
    if precip_pct >= 70: return "ppd_risk"
    if precip_pct >= 40: return "delay_risk"
    if precip_pct >= 20: return "shower_risk"
    return "clear"

def calc_wind_factor(park, wind_dir, wind_mph, temp, roof):
    if roof:
        return 1.0
    factor = 1.0
    if park in PARK_OUT and wind_dir in PARK_OUT[park]:
        factor += 0.005 * min(wind_mph, 20)
    elif park in PARK_IN and wind_dir in PARK_IN.get(park, []):
        factor -= 0.004 * min(wind_mph, 20)
    factor += max(0, (temp - 72) * 0.002)
    return round(max(0.85, min(1.15, factor)), 4)

def wind_alignment(wf, roof):
    if roof: return 0.0
    return round((wf - 1.0) * 20, 2)

def make_weather_label(wind_dir, wind_mph, wf, roof):
    if roof:
        return "Dome 🏟️"
    if wf > 1.005:   arrow, tag = "↗", " OUT"
    elif wf < 0.995: arrow, tag = "↓", " IN"
    else:            arrow, tag = "↔", ""
    return f"{wind_dir} {int(wind_mph)}mph {arrow}{tag}"

def format_game_time(game_time_iso):
    try:
        dt = datetime.datetime.fromisoformat(game_time_iso.replace("Z", "+00:00"))
        eastern = dt.astimezone(datetime.timezone(datetime.timedelta(hours=-4)))
        return eastern.strftime("%-I:%M %p")
    except Exception:
        return ""

# ── PITCHER PROJECTION (shell PITCHERS schema) ────────────────────────────────
def project_pitcher(pname, team, opp, role, game_label, time_str, venue,
                    l14_pitch, sal_map):
    pk = pname.lower()
    pd_ = PITCHER_CAREER_DB.get(pk, {})
    era  = pd_.get("e3", 4.20) or 4.20
    xfip = pd_.get("xf3", 4.20) or 4.20
    hr9  = round(pd_.get("h3", 1.10) or 1.10, 3)
    hand = pd_.get("hand", "R") or "R"
    pf   = round(pitcher_factor(pname, l14_pitch), 3)

    l14 = l14_pitch.get(pk, {})
    if l14.get("l14_k_rate"):
        k9 = max(5.5, min(11.0, round(l14["l14_k_rate"] * 27, 1)))
    else:
        k9 = 7.5
    k9_blend = round(0.6 * 7.5 + 0.4 * k9, 1)
    k9_adj   = round(k9_blend * (2 - pf), 1)

    ip = round(min(6.5, max(4.8, 7.0 - 0.32 * era)), 1)
    k_exp = k9_adj / 9 * ip
    dk_proj = round(2.25 * ip + 2 * k_exp - era, 2)
    fd_proj = round(dk_proj * 1.45, 2)

    psal = lookup_salary(sal_map, pname)
    dk_sal = int(psal.get("dk") or 7000)
    fd_sal = int(psal.get("fd") or 8000)

    return {
        "name": pname, "hand": hand, "team": team, "opp": opp,
        "role": role, "location": role,
        "game": game_label, "time": time_str, "venue": venue,
        "hr9": hr9, "era26": round(era, 3), "xfip": round(xfip, 3),
        "ip": ip, "k9_blend": k9_blend, "k9_adj": k9_adj, "p_factor": pf,
        "dk_salary": dk_sal, "fd_salary": fd_sal,
        "dk_proj": dk_proj, "fd_proj": fd_proj,
        "dk_value": round(dk_proj / max(dk_sal, 1000) * 1000, 3),
        "fd_value": round(fd_proj / max(fd_sal, 1000) * 1000, 3),
    }

# ── MAIN BUILD ────────────────────────────────────────────────────────────────
def build():
    print("=== Onyx Auto-Build v3 ===\n")

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
    RESULTS, SUMMARIES, PITCHERS, ALL_GAME_KEYS = [], [], [], []

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
        walign     = wind_alignment(wf, roof)
        wlabel     = make_weather_label(wind_dir, wind_mph, wf, roof)

        time_str   = format_game_time(game.get("game_time", ""))
        game_label = f"{away_team} @ {home_team} ({time_str})"

        home_pitcher = game.get("home_pitcher", "TBD")
        away_pitcher = game.get("away_pitcher", "TBD")

        def pstats(pname):
            pk = pname.lower()
            pd_ = PITCHER_CAREER_DB.get(pk, {})
            pf = pitcher_factor(pname, l14_pitch)
            era  = pd_.get("e3", 4.50) or 4.50
            xfip = pd_.get("xf3", 4.00) or 4.00
            hr9  = round(pd_.get("h3", xfip * 0.27) or xfip * 0.27, 3)
            hand = pd_.get("hand", "R") or "R"
            return pf, era, xfip, hr9, hand

        h_pf, h_era, h_xfip, h_hr9, h_hand = pstats(home_pitcher)
        a_pf, a_era, a_xfip, a_hr9, a_hand = pstats(away_pitcher)

        all_players = (
            [(p, True)  for p in game["home_lineup"]] +
            [(p, False) for p in game["away_lineup"]]
        )

        game_results = []
        for player, is_home in all_players:
            name = player["name"]
            pos  = player.get("pos", "OF")
            bo   = player.get("batting_order", 5)
            team = home_team if is_home else away_team
            opp  = away_team if is_home else home_team
            opp_pitcher = away_pitcher if is_home else home_pitcher
            opp_pf, opp_era, opp_xfip, opp_hr9, opp_hand = (
                (a_pf, a_era, a_xfip, a_hr9, a_hand) if is_home
                else (h_pf, h_era, h_xfip, h_hr9, h_hand)
            )

            dk_odds = odds_map.get(name.lower())
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

            d   = CAREER_DB.get(name.lower(), {})
            l14 = l14_hit.get(name.lower(), {})
            career_rate = d.get("c", 0.038) or 0.038
            split_rate  = d.get("ch" if is_home else "ca", career_rate) or career_rate
            l14_pa = l14.get("l14_pa", 0)
            l14_hr = l14.get("l14_hr", 0)
            sc     = proj["sc_score"]

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

            implied = round(implied_prob(dk_odds) * 100, 2) if dk_odds else None

            r = {
                "batter_name": name, "matched_name": name,
                "batting_order": bo, "batter_hand": d.get("hand", "R"),
                "pos": pos, "dk_pos": pos, "fd_pos": pos,
                "location": "home" if is_home else "away",
                "team": team, "opp": opp, "away": away_team, "home": home_team,
                "game": game_label, "time": time_str,
                "venue": park, "weather_label": wlabel,
                "wind_from": wind_dir, "wind_factor": wf,
                "wind_alignment": walign, "park_hr": park_f, "env_factor": wf,
                "temp": temp, "wind_mph": wind_mph, "weather_flag": wflag,
                "opp_pitcher": opp_pitcher, "opp_pitcher_hand": opp_hand,
                "opp_pitcher_hr9": opp_hr9, "opp_pitcher_era": round(opp_era, 3),
                "p_factor": round(opp_pf, 4),
                "career_hr_pa": round(career_rate, 5),
                "split_hr_pa": round(split_rate, 5),
                "l14_hr": l14_hr, "l14_pa": l14_pa,
                "l14_xwoba": round(l14.get("l14_hit_rate", 0.30), 4),
                "ev90_26": d.get("e3", 95), "barrel_26": d.get("b3", 0.08),
                "hh_pct": d.get("h3", 0.40), "iso_ctx": d.get("i3", 0.165),
                "sc_score": sc, "barrel_pct": d.get("b3", 0.08),
                "ev90": d.get("e3", 95),
                "hr_per_pa": round(proj["hr_prob"] / 100 / 4.3, 5),
                "hr_pg": round(proj["hr_prob"] / 100, 4),
                "hr_prob": proj["hr_prob"],
                "due_score": round(due_score, 3), "due_adj": proj["due_mult"],
                "due_label": due_label, "due_detail": due_detail,
                "dk_proj": proj["dk_pts"], "fd_proj": proj["fd_pts"],
                "dk_salary": proj["dk_salary"], "fd_salary": proj["fd_salary"],
                "dk_value": round(proj["dk_pts"] / max(proj["dk_salary"], 1000) * 1000, 2),
                "fd_value": round(proj["fd_pts"] / max(proj["fd_salary"], 1000) * 1000, 2),
                "dk_hr_odds": dk_odds, "dk_hr_implied": implied,
                "hr_edge": proj["hr_edge"], "composite": proj["composite"],
                "lineup_confirmed": game.get("home_confirmed" if is_home else "away_confirmed", False),
            }
            game_results.append(r)

        RESULTS.extend(game_results)

        # ── SUMMARIES entry (shell schema) ────────────────────────────────────
        away_rs = [r for r in game_results if r["location"] == "away"]
        home_rs = [r for r in game_results if r["location"] == "home"]
        a_top = max(away_rs, key=lambda x: x["hr_prob"]) if away_rs else None
        h_top = max(home_rs, key=lambda x: x["hr_prob"]) if home_rs else None
        gl = get_game_line(game_lines, away_team, home_team)
        SUMMARIES.append({
            "game": game_label, "time": time_str,
            "away": away_team, "home": home_team, "venue": park,
            "ou": gl.get("ou"), "roof": roof,
            "away_ml": gl.get("away_ml", ""), "home_ml": gl.get("home_ml", ""),
            "temp": temp, "wind_spd": wind_mph, "wind_dir": wind_dir,
            "wind_factor": wf, "env_factor": wf, "wind_alignment": walign,
            "weather_label": wlabel,
            "awayP": away_pitcher, "awayHand": a_hand, "awayP_hr9": a_hr9,
            "homeP": home_pitcher, "homeHand": h_hand, "homeP_hr9": h_hr9,
            "away_top": a_top["batter_name"] if a_top else "",
            "away_top_prob": a_top["hr_prob"] if a_top else 0,
            "home_top": h_top["batter_name"] if h_top else "",
            "home_top_prob": h_top["hr_prob"] if h_top else 0,
            "away_exp_hr": round(sum(r["hr_pg"] for r in away_rs), 2),
            "home_exp_hr": round(sum(r["hr_pg"] for r in home_rs), 2),
            "n_away": len(away_rs), "n_home": len(home_rs),
            "label": game_label,
        })

        # ── PITCHERS entries (shell schema) ───────────────────────────────────
        if away_pitcher and away_pitcher != "TBD":
            PITCHERS.append(project_pitcher(away_pitcher, away_team, home_team,
                "away", game_label, time_str, park, l14_pitch, sal_map))
        if home_pitcher and home_pitcher != "TBD":
            PITCHERS.append(project_pitcher(home_pitcher, home_team, away_team,
                "home", game_label, time_str, park, l14_pitch, sal_map))

        ALL_GAME_KEYS.append(game_label)

    RESULTS = apply_game_diversity(RESULTS)
    print(f"Model ran: {len(RESULTS)} players across {len(lineups)} games")

    # ── Persistent stats merge ───────────────────────────────────────────────
    PICKS      = merge_picks(html)
    DFS_RECORD = merge_dfs(html)

    # ── Inject everything ────────────────────────────────────────────────────
    for var, val in [
        ("RESULTS",       json.dumps(RESULTS)),
        ("SUMMARIES",     json.dumps(SUMMARIES)),
        ("PITCHERS",      json.dumps(PITCHERS)),
        ("ALL_GAME_KEYS", json.dumps(ALL_GAME_KEYS)),
        ("PICKS",         json.dumps(PICKS)),
        ("DFS_RECORD",    json.dumps(DFS_RECORD)),
    ]:
        html, ok = bracket_replace(html, var, val)
        print(f"  {var}: {'✓' if ok else 'FAILED'}")

    # Update date headers
    html = re.sub(
        r"(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) \d+ · \d{4}",
        today.strftime("%b %-d · %Y").upper(), html)
    html = re.sub(
        r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+, \d{4}",
        today.strftime("%b %-d, %Y"), html)
    html = re.sub(
        r"<title[^>]*>Onyx Baseball · [^<]+</title>",
        f'<title data-id="th-modified">Onyx Baseball · {today.strftime("%b %-d")}</title>', html)

    with open(OUT, "w") as f:
        f.write(html)

    top5 = sorted([r for r in RESULTS if r.get("dk_hr_odds")],
                  key=lambda x: -x["composite"])[:5]
    confirmed = sum(1 for r in RESULTS if r.get("lineup_confirmed"))
    print(f"\n✅ index.html written — {len(RESULTS)} players, {confirmed} confirmed")
    print("\nTop 5 edge plays:")
    for p in top5:
        conf = "✓" if p.get("lineup_confirmed") else "~"
        print(f"  {conf} {p['batter_name']:25s} prob={p['hr_prob']}% "
              f"edge={p['hr_edge']}% odds=+{p['dk_hr_odds']} comp={p['composite']:.3f}")

if __name__ == "__main__":
    build()
