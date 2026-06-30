#!/usr/bin/env python3
"""
auto_build.py — Onyx Baseball daily build (pairs with model.py v15)
Imports project_player()/apply_game_diversity() + career/pitcher DBs from model,
reads data/ files and L14 CSVs directly, injects RESULTS/SUMMARIES/PITCHERS into
shell.html -> index.html. No fetch_data dependency.
"""
import json, re, os, csv, datetime, unicodedata
from collections import defaultdict
import model  # v15 — loads career_db.json, pitcher_db.json, splits.json on import

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
TODAY = datetime.date.today()
DATE_LABEL = TODAY.strftime("%B %-d")
DATE_FULL  = TODAY.strftime("%B %-d, %Y")

def nk(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    s = re.sub(r"\s*\(.*?\)\s*", "", s)        # drop "(LAD)" disambiguation tags
    return s.strip().lower()

def f(x, d=0.0):
    try: return float(x)
    except (TypeError, ValueError): return d

def jload(name, default=None):
    p = os.path.join(DATA, name)
    if not os.path.exists(p): return default if default is not None else {}
    with open(p) as fh: return json.load(fh)

# ── committed inputs (formats built this session) ───────────────────────────────
lineups    = jload("lineups.json", [])      # list of batter dicts
odds       = jload("odds.json", {})         # name_lower (+ "(team)" for dupes) -> american
game_lines = jload("game_lines.json", {})   # AWAY_HOME -> {time,total,awayP,homeP,away_ml,home_ml,...}
weather    = jload("weather.json", {})      # home_abbr -> {venue,temp,precip,wind_spd,wind_dir,roof,flag}

def get_odds(name, team):
    return (odds.get(f"{nk(name)} ({team.lower()})")
            or odds.get(name.lower())
            or odds.get(nk(name)))

# ── L14 from CSV (this is the fetch_data PA-gate fix, done right: no row dropped) ─
def _pct(v):
    v = f(v); return v/100 if v > 1 else v   # FanGraphs reports % as 11.9, Savant as 0.119

def load_l14_hitters():
    """Read data/statcast_l14.json produced by fetch_data.fetch_statcast()."""
    p = os.path.join(DATA, "statcast_l14.json")
    if not os.path.exists(p):
        print("  WARNING: statcast_l14.json missing — run fetch_data.py first")
        return {}
    with open(p) as fh:
        raw = json.load(fh)
    # already keyed by name_lower with l14_* fields model.py expects; just normalize key
    return {nk(k): v for k, v in raw.items()}

def load_l14_pitchers():
    """Read data/pitchers_l14.json produced by fetch_data.fetch_pitcher_statcast()."""
    p = os.path.join(DATA, "pitchers_l14.json")
    if not os.path.exists(p):
        return {}
    with open(p) as fh:
        raw = json.load(fh)
    return {nk(k): v for k, v in raw.items()}
hit_l14 = load_l14_hitters()
pit_l14 = load_l14_pitchers()

# ── venue -> model.PARK_HR_FACTOR key (names differ in weather.json) ─────────────
VENUE_ALIAS = {
    "Oriole Park at Camden Yards": "Camden Yards",
    "Daikin Park": "Minute Maid Park",
    "Sutter Health Park": "Oakland Coliseum",   # A's Sacramento — approx, neutral-ish
}
def park_factor(venue):
    return model.PARK_HR_FACTOR.get(VENUE_ALIAS.get(venue, venue), 1.0)

DUE = [(1.30,"OVERDUE"),(1.15,"DUE"),(1.05,"COOL"),(1.00,"NORMAL"),(0.97,"WARM"),(0.93,"HOT")]
def due_label(m):
    for thr, lbl in DUE:
        if m >= thr: return lbl
    return "FIRE"

# ── build RESULTS ────────────────────────────────────────────────────────────
RESULTS = []
for b in lineups:
    name, team, gk = b["name"], b["team"], b["game_key"]
    gl = game_lines.get(gk, {})
    if "_" not in gk: continue
    away, home = gk.split("_", 1)
    is_home = (team == home)
    w = weather.get(home, {})
    venue = w.get("venue", "")
    opp_p = (gl.get("awayP") if is_home else gl.get("homeP")) or ""
    odds_val = get_odds(name, team)
    pf = park_factor(venue)

    res = model.project_player(
        name=name, pos=b.get("pos", "OF"), batting_order=b.get("batting_order", 5),
        is_home=is_home, opp_pitcher=opp_p, park=venue, park_factor=pf,
        wind_dir=w.get("wind_dir", "calm"), wind_mph=w.get("wind_spd", 0),
        temp=w.get("temp", 72), roof=bool(w.get("roof", False)),
        dk_odds=odds_val, dk_salary=b.get("dk_salary", 3000), fd_salary=b.get("fd_salary", 3000),
        l14_statcast=hit_l14, l14_pitchers=pit_l14,
        game_key=gk, game_label=f"{away} @ {home} ({gl.get('time','')} ET)".strip(),
        team=team, weather_flag=w.get("flag", "clear"),
    )

    l14 = hit_l14.get(nk(name), {})
    pdb = model.PITCHER_CAREER_DB.get(nk(opp_p), {})
    cdb = model.CAREER_DB.get(nk(name), {})
    implied = model.implied_prob(odds_val) * 100 if odds_val else None
    dk_proj, fd_proj = res["dk_pts"], res["fd_pts"]
    dk_sal, fd_sal = res["dk_salary"], res["fd_salary"]
    wd = str(w.get("wind_dir", "")).lower()
    wa = 0.6 if wd.startswith("out") else -0.6 if wd.startswith("in") else 0.0

    res.update({
        "matched_name": name,
        "dk_pos": b.get("dk_pos", b.get("pos", "OF")),
        "fd_pos": b.get("fd_pos", b.get("pos", "OF")),
        "batter_hand": b.get("hand", "R"),
        "location": "home" if is_home else "away",
        "opp": away if is_home else home, "away": away, "home": home,
        "game": res["game_label"], "time": gl.get("time", ""), "venue": venue,
        "weather_label": f'{w.get("wind_dir","")} {w.get("wind_spd",0)}mph'.strip(),
        "wind_from": w.get("wind_dir", ""),
        "wind_factor": res["env"], "env_factor": res["env"], "wind_alignment": wa,
        "park_hr": res["park_factor"],
        "opp_pitcher_hand": pdb.get("hand", "R"),
        "opp_pitcher_hr9": f(pdb.get("hr9"), 1.20),
        "opp_pitcher_era": f(pdb.get("era"), 4.20),
        "career_hr_pa": f(cdb.get("c"), 0.025),
        "split_hr_pa": f(cdb.get("ch" if is_home else "ca"), f(cdb.get("c"), 0.025)),
        "l14_hr": l14.get("l14_hr", 0), "l14_pa": l14.get("l14_pa", 0),
        "l14_xwoba": l14.get("l14_xwoba", 0),
        "ev90_26": round(l14.get("l14_ev90", 0), 1),
        "barrel_26": round(l14.get("l14_barrel_pct", 0), 4),
        "hh_pct": round(l14.get("l14_hh_pct", 0), 4),
        "iso_ctx": round(l14.get("l14_iso", 0), 4),
        "barrel_pct": round(l14.get("l14_barrel_pct", 0), 4),
        "ev90": round(l14.get("l14_ev90", 0), 1),
        "due_adj": res["due_mult"], "due_label": due_label(res["due_mult"]),
        "due_detail": f'{int(l14.get("l14_hr",0))}HR/{int(l14.get("l14_pa",0))}PA',
        "dk_proj": round(dk_proj, 2), "fd_proj": round(fd_proj, 2),
        "dk_value": round(dk_proj / (dk_sal / 1000), 2) if dk_sal else 0,
        "fd_value": round(fd_proj / (fd_sal / 1000), 2) if fd_sal else 0,
        "dk_hr_odds": odds_val,
        "dk_hr_implied": round(implied, 2) if implied else None,
    })
    RESULTS.append(res)

RESULTS = model.apply_game_diversity(RESULTS)

# ── SUMMARIES ────────────────────────────────────────────────────────────────
groups = defaultdict(list)
for r in RESULTS: groups[r["game_key"]].append(r)

SUMMARIES = []
for gk, players in groups.items():
    gl = game_lines.get(gk, {}); away, home = gk.split("_", 1)
    w = weather.get(home, {})
    ap = [p for p in players if p["team"] == away]
    hp = [p for p in players if p["team"] == home]
    at = sorted(ap, key=lambda x: -x["hr_prob"])
    ht = sorted(hp, key=lambda x: -x["hr_prob"])
    top = sorted(players, key=lambda x: -x["composite"])[:3]
    SUMMARIES.append({
        "game": gk, "label": gl.get("label", f"{away} @ {home}"),
        "time": gl.get("time", ""), "away": away, "home": home,
        "venue": w.get("venue", ""), "roof": bool(w.get("roof", False)),
        "temp": w.get("temp", 72), "wind_spd": w.get("wind_spd", 0), "wind_dir": w.get("wind_dir", ""),
        "weather_label": f'{w.get("wind_dir","")} {w.get("wind_spd",0)}mph'.strip(),
        "wind_from": w.get("wind_dir", ""),
        "wind_factor": players[0]["env_factor"] if players else 1.0,
        "wind_alignment": players[0]["wind_alignment"] if players else 0.0,
        "env_factor": players[0]["env_factor"] if players else 1.0,
        "park_hr": park_factor(w.get("venue", "")),
        "ou": gl.get("total", 8.0), "away_ml": gl.get("away_ml") or "+100", "home_ml": gl.get("home_ml") or "-120",
        "awayP": gl.get("awayP", ""), "homeP": gl.get("homeP", ""),
        "awayHand": model.PITCHER_CAREER_DB.get(nk(gl.get("awayP","")), {}).get("hand", "R"),
        "homeHand": model.PITCHER_CAREER_DB.get(nk(gl.get("homeP","")), {}).get("hand", "R"),
        "awayP_hr9": f(model.PITCHER_CAREER_DB.get(nk(gl.get("awayP","")), {}).get("hr9"), 1.2),
        "homeP_hr9": f(model.PITCHER_CAREER_DB.get(nk(gl.get("homeP","")), {}).get("hr9"), 1.2),
        "away_top": at[0]["batter_name"] if at else "", "away_top_prob": at[0]["hr_prob"] if at else 0,
        "home_top": ht[0]["batter_name"] if ht else "", "home_top_prob": ht[0]["hr_prob"] if ht else 0,
        "away_exp_hr": round(sum(p["hr_prob"] for p in ap) / 100, 2),
        "home_exp_hr": round(sum(p["hr_prob"] for p in hp) / 100, 2),
        "n_away": len(ap), "n_home": len(hp),
        "top_targets": [{"name": p["batter_name"], "prob": p["hr_prob"], "edge": p["hr_edge"]} for p in top],
        "avg_hr_prob": round(sum(p["hr_prob"] for p in players) / len(players), 1) if players else 0,
    })
SUMMARIES.sort(key=lambda x: x["time"])

# ── PITCHERS ─────────────────────────────────────────────────────────────────
PITCHERS, seen = [], set()
for gk, gl in game_lines.items():
    away, home = gk.split("_", 1)
    for side, opp, is_home_p in [("awayP", home, False), ("homeP", away, True)]:
        pname = gl.get(side, "")
        if not pname or pname in seen: continue
        seen.add(pname)
        pdb = model.PITCHER_CAREER_DB.get(nk(pname), {})
        PITCHERS.append({
            "name": pname, "hand": pdb.get("hand", "R"),
            "team": (away if side == "awayP" else home), "opp": opp, "game": gk,
            "era": round(f(pdb.get("era"), 4.20), 2), "hr9": round(f(pdb.get("hr9"), 1.20), 2),
            "xfip": round(f(pdb.get("xfip"), 4.00), 2),
            "p_factor": model.pitcher_factor(pname, pit_l14, is_home_pitcher=is_home_p),
            "dk_salary": 0, "fd_salary": 0, "dk_proj": 0, "fd_proj": 0,  # SP salaries not captured this slate
        })

ALL_GAME_KEYS = [s["game"] for s in SUMMARIES]

# ── inject into shell.html ───────────────────────────────────────────────────
with open(os.path.join(BASE, "shell.html")) as fh:
    html = fh.read()

def bracket_replace(html, var, val):
    idx = html.find(f"const {var} = ")
    if idx < 0: return html
    start = idx + len(f"const {var} = "); ch = html[start]; end = "]" if ch == "[" else "}"
    depth, i = 0, start
    while i < len(html):
        if html[i] == ch: depth += 1
        elif html[i] == end:
            depth -= 1
            if depth == 0:
                ei = i + 1 + (1 if i + 1 < len(html) and html[i+1] == ";" else 0)
                return html[:idx] + f"const {var} = {json.dumps(val)};" + html[ei:]
        i += 1
    return html

for var, val in [("RESULTS", RESULTS), ("SUMMARIES", SUMMARIES),
                 ("PITCHERS", PITCHERS), ("ALL_GAME_KEYS", ALL_GAME_KEYS)]:
    html = bracket_replace(html, var, val)

html = re.sub(r"[A-Z][a-z]+ \d+, 2026", DATE_FULL, html)
html = re.sub(r"[A-Z][a-z]+ \d+ · 2026", f"{DATE_LABEL} · 2026", html)
html = re.sub(r"Live · [A-Z][a-z]+ \d+, 2026", f"Live · {DATE_FULL}", html)
html = re.sub(r"<title>Onyx Baseball · [^<]*</title>", f"<title>Onyx Baseball · {DATE_LABEL}</title>", html)

with open(os.path.join(BASE, "index.html"), "w") as fh:
    fh.write(html)

print(f"✓ index.html: {len(RESULTS)} players, {len(SUMMARIES)} games")
