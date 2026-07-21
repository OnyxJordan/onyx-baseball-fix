#!/usr/bin/env python3
"""
Onyx Baseball - auto_build.py (second-half rebuild)
Groups flat lineups.json rows (bot-written) into game objects keyed by
game_key, pulling pitchers and lines from game_lines.json. Calls
model.project_player() per batter; injects the model's NATIVE return
dicts as RESULTS (shell.html reads those fields directly, e.g.
r.due_score, r.dk_pts). Game keys use the shell's baked label format
"AWAY @ HOME (TIME)". Pre-normalizes statcast_l14 entries so l14_rate
always exists (model does a hard l14["l14_rate"] lookup). Applies only
adjustments model.py does NOT cover (bullpen exposure, pull-air) to the
edge/picks lane. Reads new odds.json format. Auto-logs edge plays.
Prints the first few model exceptions with tracebacks.
"""

import json, os, re, sys, traceback, unicodedata
from datetime import datetime, timezone

# ---------------------------------------------------------------- paths
DATA = "data"
def dpath(f): return os.path.join(DATA, f)

# ---------------------------------------------------------------- normalizer (matches rebuild_dbs.nk_db)
def nk(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s

def jload(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

# ---------------------------------------------------------------- load DBs (root) + daily data
CAREER   = jload("career_db.json", {})
PITCHERS = jload("pitcher_db.json", {})
BULLPEN  = jload("bullpen_db.json", {})
HANDS    = jload(dpath("pitcher_hand.json"), {})

LINEUPS  = jload(dpath("lineups.json"), {})
WEATHER  = jload(dpath("weather.json"), {})
ODDS_RAW = jload(dpath("odds.json"), {})
GAMES    = jload(dpath("game_lines.json"), {})
L14      = jload(dpath("statcast_l14.json"), {})
P14      = jload(dpath("pitchers_l14.json"), {})
SALARIES = jload(dpath("salaries.json"), {})

# ---- normalize L14 hitters: nk keys + guarantee l14_rate exists ----
# model.py does l14["l14_rate"] (hard lookup, no default) inside its form
# adjustment for any batter with l14_pa >= 20 - i.e. nearly every starter.
L14N = {}
if isinstance(L14, dict):
    for k, v in L14.items():
        if not isinstance(v, dict):
            continue
        v = dict(v)
        if v.get("l14_rate") is None:
            pa = v.get("l14_pa") or 0
            hr = v.get("l14_hr") or 0
            try:
                v["l14_rate"] = (float(hr) / float(pa)) if pa else 0.0
            except (TypeError, ValueError):
                v["l14_rate"] = 0.0
        L14N[nk(k)] = v

P14N = {nk(k): v for k, v in P14.items() if isinstance(v, dict)} \
       if isinstance(P14, dict) else {}

# odds.json (new): { nk_name: american_int }. Tolerate old formats gracefully.
def american_to_prob(a):
    try:
        a = int(a)
    except (TypeError, ValueError):
        return None
    return (100.0 / (a + 100.0)) if a > 0 else (abs(a) / (abs(a) + 100.0))

ODDS_META = jload(dpath("odds_meta.json"), {"fresh": False})
ODDS = {}
for k, v in (ODDS_RAW.items() if (isinstance(ODDS_RAW, dict) and ODDS_META.get("fresh")) else []):
    if isinstance(v, dict):                      # legacy shape {name: {"dk": +450, ...}}
        v = v.get("dk") or v.get("odds") or v.get("american")
    p = american_to_prob(v)
    if p:
        ODDS[nk(k)] = {"american": int(v), "prob": p}

# ---------------------------------------------------------------- blended pitcher factor (pre-compute onto PITCHERS)
def blended_factor(e, base):
    """Blend xFIP-derived factor with HR-specific legs: HR/9, HR/FB, air rate, Barrel% allowed."""
    if base is None:
        base = 1.0
    legs, weights = [], []
    hr9 = e.get("hr9_6") if e.get("hr9_6") else e.get("hr9_3")
    if hr9 is not None:
        legs.append(min(max(float(hr9) / 1.15, 0.6), 1.8)); weights.append(0.30)
    hrfb = e.get("hrfb6") if e.get("hrfb6") else e.get("hrfb3")
    if hrfb is not None:
        legs.append(min(max(float(hrfb) / 0.115, 0.6), 1.8)); weights.append(0.15)
    gb = e.get("gb6") if e.get("gb6") else e.get("gb3")
    if gb is not None:
        legs.append(min(max((1.0 - float(gb)) / 0.575, 0.6), 1.8)); weights.append(0.10)
    brl = e.get("brl3")
    if brl is not None:
        legs.append(min(max(float(brl) / 0.075, 0.6), 1.8)); weights.append(0.05)
    if not legs:
        return base
    hr_leg = sum(l * w for l, w in zip(legs, weights)) / sum(weights)
    hr_w = sum(weights)                          # up to 0.60
    return round(base * (1 - hr_w) + hr_leg * hr_w, 4)

for key, e in PITCHERS.items():
    b = blended_factor(e, e.get("pf", 1.0))
    e["pf_blend"] = b
    e["pfh"] = round((e.get("pfh") or b) * 0.5 + b * 0.5, 4)
    e["pfa"] = round((e.get("pfa") or b) * 0.5 + b * 0.5, 4)
    if not e.get("hand"):
        e["hand"] = HANDS.get(key)

# ---------------------------------------------------------------- inject into model (model.py stays untouched)
import model
for attr, obj in (("CAREER_DB", CAREER), ("PITCHER_CAREER_DB", PITCHERS),
                  ("PITCHER_DB", PITCHERS), ("PITCHER_HAND", HANDS)):
    if hasattr(model, attr):
        setattr(model, attr, obj)
print(f"model: DBs injected ({len(CAREER)} hitters, {len(PITCHERS)} pitchers, "
      f"{len(BULLPEN)} bullpens, {len(HANDS)} hands)")

# ---------------------------------------------------------------- adjustment layer (only what model.py does NOT cover)
def bullpen_mult(team_abbr, starter_e):
    """~40% of PAs vs bullpen: blend starter suppression with team relief HR/9."""
    bp = BULLPEN.get(team_abbr)
    if not bp or not bp.get("hr9"):
        return 1.0
    bp_leg = min(max(float(bp["hr9"]) / 1.05, 0.7), 1.5)
    sp_leg = (starter_e or {}).get("pf_blend", 1.0)
    return round((0.60 * sp_leg + 0.40 * bp_leg) / max(sp_leg, 1e-6), 4)

def pull_air_mult(bat):
    if not bat or bat.get("pl") is None or bat.get("fb") is None:
        return 1.0
    pa_rate = float(bat["pl"]) * float(bat["fb"])      # crude pulled-air proxy
    return min(max(1.0 + (pa_rate - 0.155) * 1.2, 0.90), 1.12)

# ---------------------------------------------------------------- build slate
players, games_out, results_out = [], [], []
now = datetime.now(timezone.utc)

# ---- group flat lineups.json rows into game objects ----
_rows = LINEUPS if isinstance(LINEUPS, list) else \
        (LINEUPS.get("games") or LINEUPS.get("schedule") or [])
_by_game = {}
for r in _rows:
    if isinstance(r, dict) and r.get("game_key") and r.get("name"):
        _by_game.setdefault(r["game_key"], []).append(r)

def _order(r):
    try:
        return int(r.get("batting_order") or 0)
    except (TypeError, ValueError):
        return 0

for gk, rows in _by_game.items():
    away, _, home = gk.partition("_")
    gl = GAMES.get(gk, {}) if isinstance(GAMES, dict) else {}
    wx = (WEATHER.get(gk) if isinstance(WEATHER, dict) else None) or {}
    time_s = gl.get("time", "") or ""
    label = f"{away} @ {home}" + (f" ({time_s})" if time_s else "")
    game = {
        "game_key": gk, "label": label,
        "away_team": away, "home_team": home,
        "away_pitcher": gl.get("awayP") or "",
        "home_pitcher": gl.get("homeP") or "",
        "total": gl.get("total"),
        "away_ml": gl.get("away_ml"), "home_ml": gl.get("home_ml"),
        "time": time_s, "venue": gl.get("venue", "") or wx.get("park", ""),
        "weather": wx,
        "away_lineup": [], "home_lineup": [],
    }
    for r in sorted(rows, key=_order):
        side = "away" if r.get("team") == away else "home"
        game[f"{side}_lineup"].append({"name": r.get("name", ""),
                                       "hand": r.get("hand", ""),
                                       "pos": r.get("pos", "")})
    games_out.append(game)

# ---- score every batter via model.project_player ----
def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default

_model_errs = 0
for game in games_out:
    wx = game.get("weather") or {}
    park      = game.get("venue") or wx.get("park") or ""
    wind_dir  = wx.get("wind_dir") or wx.get("wind_direction") or ""
    wind_mph  = _num(wx.get("wind_mph") or wx.get("wind_speed"), 0.0)
    temp      = _num(wx.get("temp") or wx.get("temperature"), 72.0)
    roof      = bool(wx.get("roof") or wx.get("roof_closed"))
    humidity  = _num(wx.get("humidity"), 50.0)
    pressure  = _num(wx.get("pressure_mb") or wx.get("pressure"), 1013.0)

    for side in ("home", "away"):
        is_home  = side == "home"
        lineup   = game.get(f"{side}_lineup") or []
        opp_sp   = game.get(f"{'away' if is_home else 'home'}_pitcher")
        opp_team = game.get(f"{'away' if is_home else 'home'}_team")
        sp_e   = PITCHERS.get(nk(opp_sp or ""))
        p_hand = (sp_e or {}).get("hand") or HANDS.get(nk(opp_sp or "")) or "R"

        for spot, batter in enumerate(lineup, 1):
            bname = batter if isinstance(batter, str) else batter.get("name", "")
            if not bname:
                continue
            bkey = nk(bname)
            bat  = CAREER.get(bkey)
            b_hand = "" if isinstance(batter, str) else (batter.get("hand") or "")
            b_pos  = "" if isinstance(batter, str) else (batter.get("pos") or "")
            sal = {}
            if isinstance(SALARIES, dict):
                sal = SALARIES.get(bkey) or SALARIES.get(bname.lower()) or {}
            o = ODDS.get(bkey)

            try:
                r = model.project_player(
                    name=bkey,
                    pos=(sal.get("dk_pos") or b_pos or "OF"),
                    batting_order=spot,
                    is_home=is_home,
                    opp_pitcher=nk(opp_sp or ""),
                    park=park,
                    park_factor=1.0,
                    wind_dir=wind_dir,
                    wind_mph=wind_mph,
                    temp=temp,
                    roof=roof,
                    dk_odds=o["american"] if o else None,
                    dk_salary=int(sal.get("dk_salary") or 3000),
                    fd_salary=int(sal.get("fd_salary") or 3000),
                    l14_statcast=L14N,
                    l14_pitchers=P14N,
                    game_key=game["label"],
                    game_label=game["label"],
                    team=game.get(f"{side}_team") or "",
                    humidity=humidity,
                    pressure_mb=pressure,
                    batter_hand=b_hand or "R",
                    opp_pitcher_hand=p_hand,
                )
            except Exception as ex:
                _model_errs += 1
                if _model_errs <= 3:
                    print(f"model error for {bname}: {ex!r}")
                    traceback.print_exc()
                continue

            # ---- shell payload: model-native record (shell reads these fields) ----
            rec = dict(r)
            rec["batter_name"]  = bname            # display name, not nk key
            rec["matched_name"] = bname
            rec["batter_hand"]  = (b_hand or (bat or {}).get("hand") or "")
            rec["dk_pos"]       = sal.get("dk_pos") or b_pos or ""
            rec["fd_pos"]       = sal.get("fd_pos") or b_pos or ""
            rec["location"]     = "home" if is_home else "away"
            rec["opp_sp"]       = opp_sp or ""
            rec["sp_hand"]      = p_hand or ""
            results_out.append(rec)

            # ---- edge/picks lane: model prob + bullpen & pull-air layers ----
            base = (r.get("hr_prob") or 0) / 100.0
            if base <= 0:
                continue
            adj = base
            adj *= bullpen_mult(opp_team, sp_e)
            adj *= pull_air_mult(bat)
            adj = min(max(adj, 0.005), 0.45)

            edge = round(adj - o["prob"], 4) if o else None
            players.append({
                "name": bname, "key": bkey, "spot": spot,
                "team": game.get(f"{side}_team") or "",
                "opp_sp": opp_sp or "", "sp_hand": p_hand or "",
                "prob": round(adj, 4), "base_prob": round(base, 4),
                "odds": o["american"] if o else None,
                "market_prob": round(o["prob"], 4) if o else None,
                "edge": edge,
                "bat": bat or {}, "pit": sp_e or {},
            })

print(f"model: {len(players)} scored, {_model_errs} errors")

players.sort(key=lambda x: (x["edge"] is None, -(x["edge"] or 0)))
results_out.sort(key=lambda x: -(x.get("composite") or 0))

# ---------------------------------------------------------------- auto-log picks (guarded: no odds, no picks)
EDGE_MIN = 0.015
todays = [p for p in players if p["edge"] is not None and p["edge"] >= EDGE_MIN
          and (p["bat"].get("e3") or 0) >= 102 and (p["bat"].get("b3") or 0) >= 0.110]
if todays:
    picks = jload(dpath("picks_input.json"), [])
    stamp = now.strftime("%Y-%m-%d")
    have = {(p.get("date"), p.get("key")) for p in picks if isinstance(p, dict)}
    for p in todays[:8]:
        if (stamp, p["key"]) not in have:
            picks.append({"date": stamp, "name": p["name"], "key": p["key"],
                          "odds": p["odds"], "prob": p["prob"], "result": None})
    with open(dpath("picks_input.json"), "w", encoding="utf-8") as f:
        json.dump(picks, f, indent=1, ensure_ascii=False)
    print(f"picks: auto-logged {min(len(todays),8)} edge plays for {stamp}")
else:
    print("picks: no qualifying edge plays (or no odds) - nothing logged")

# ---------------------------------------------------------------- inject payload into shell
with open("shell.html", encoding="utf-8") as f:
    shell = f.read()

def replace_const(src, name, payload):
    pat = re.compile(r"^(\s*const %s\s*=\s*).*$" % re.escape(name), re.M)
    if not pat.search(src):
        sys.exit(f"FATAL: const {name} not found in shell.html")
    return pat.sub(lambda m: m.group(1) + json.dumps(payload, ensure_ascii=False) + ";", src, count=1)

sums_out, keys_out = [], []
for g in games_out:
    k = g["label"]
    keys_out.append(k)
    sums_out.append({"game": k, "time": g.get("time",""), "away": g.get("away_team",""),
        "home": g.get("home_team",""), "venue": g.get("venue",""), "ou": g.get("total"),
        "roof": False,
        "away_ml": ("" if g.get("away_ml") is None else str(g["away_ml"])),
        "home_ml": ("" if g.get("home_ml") is None else str(g["home_ml"]))})

shell = replace_const(shell, "RESULTS", results_out)
shell = replace_const(shell, "SUMMARIES", sums_out)
shell = replace_const(shell, "ALL_GAME_KEYS", keys_out)
with open("index.html", "w", encoding="utf-8") as f:
    f.write(shell)
print(f"index.html: {len(results_out)} players, {len(games_out)} games")
