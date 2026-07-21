#!/usr/bin/env python3
"""
Onyx Baseball - auto_build.py (second-half rebuild)
Single loader for all DBs. Normalizes every name to nk() form BEFORE any
model lookup, killing the O'Hearn/Crow-Armstrong default-fallback bug
without modifying model.py. Applies second-half adjustments (platoon,
blended pitcher factor, bullpen exposure, pull-air, temperature) as a
post-model layer. Reads new odds.json format (nk keys -> american odds).
Auto-logs edge plays to picks_input.json when odds are present.
"""

import json, os, re, sys, unicodedata
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

# ---------------------------------------------------------------- adjustment layer
def platoon_mult(bat, p_hand):
    """Regressed batter-vs-hand HR rate vs overall. Capped, sample-aware."""
    if not bat or p_hand not in ("L", "R") or not bat.get("c"):
        return 1.0
    tag, ptag = ("vl", "pvl") if p_hand == "L" else ("vr", "pvr")
    rate, pa = bat.get(tag), bat.get(ptag, 0)
    if rate is None or pa < 40:
        return 1.0
    base = bat["c"]
    w = min(pa / 400.0, 1.0)                     # full trust at ~400 PA vs hand
    blended = base * (1 - w) + rate * w
    return min(max(blended / base, 0.75), 1.30) if base > 0 else 1.0

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

def temp_mult(temp_f):
    if temp_f is None:
        return 1.0
    try:
        return min(max(1.0 + (float(temp_f) - 72.0) * 0.004, 0.90), 1.12)
    except (TypeError, ValueError):
        return 1.0

def game_temp(game):
    w = game.get("weather") or {}
    return w.get("temp") or w.get("temperature")

# ---------------------------------------------------------------- build slate
def get_prob(batter_name, pitcher_name, game_ctx):
    """model.py call with nk-normalized names; nk output is lowercase so
    model's internal .lower() lookups now hit the real DB keys."""
    bkey, pkey = nk(batter_name), nk(pitcher_name or "")
    try:
        p = model.hr_probability(bkey, pkey, game_ctx)      # primary interface
    except AttributeError:
        p = model.calc_hr_prob(bkey, pkey, game_ctx)        # legacy name
    except Exception:
        p = None
    return p

players, games_out = [], []
now = datetime.now(timezone.utc)

if isinstance(LINEUPS, list):
    _games_iter = LINEUPS
elif isinstance(LINEUPS, dict):
    _games_iter = LINEUPS.get("games") or LINEUPS.get("schedule") or []
else:
    _games_iter = []
for game in _games_iter:
    if not isinstance(game, dict):
        continue
    temp = game_temp(game)
    for side in ("home", "away"):
        lineup   = game.get(f"{side}_lineup") or game.get(side, {}).get("lineup") or []
        opp_sp   = game.get(f"{'away' if side=='home' else 'home'}_pitcher") \
                   or game.get("pitchers", {}).get("away" if side == "home" else "home")
        opp_team = game.get(f"{'away' if side=='home' else 'home'}_team") \
                   or game.get("away" if side == "home" else "home", {}).get("team")
        sp_e   = PITCHERS.get(nk(opp_sp or ""))
        p_hand = (sp_e or {}).get("hand") or HANDS.get(nk(opp_sp or ""))

        for spot, batter in enumerate(lineup, 1):
            bname = batter if isinstance(batter, str) else batter.get("name", "")
            if not bname:
                continue
            bkey = nk(bname)
            bat  = CAREER.get(bkey)
            base = get_prob(bname, opp_sp, game)
            if base is None:
                continue
            adj = base
            adj *= platoon_mult(bat, p_hand)
            adj *= bullpen_mult(opp_team, sp_e)
            adj *= pull_air_mult(bat)
            adj *= temp_mult(temp)
            adj = min(max(adj, 0.005), 0.45)

            o = ODDS.get(bkey)
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
    games_out.append(game)

players.sort(key=lambda x: (x["edge"] is None, -(x["edge"] or 0)))

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
payload = {
    "built": now.isoformat(), "date": now.strftime("%b %d, %Y").upper(),
    "players": players, "games": len(games_out), "bullpen": BULLPEN,
}
with open("shell.html", encoding="utf-8") as f:
    shell = f.read()
MARK = re.search(r"(/\*ONYX_DATA_START\*/)(.*?)(/\*ONYX_DATA_END\*/)", shell, re.S) \
       or re.search(r"(<!--DATA_START-->)(.*?)(<!--DATA_END-->)", shell, re.S)
if not MARK:
    sys.exit("FATAL: no data injection markers found in shell.html - refusing to build")
blob = json.dumps(payload, ensure_ascii=False)
html = shell[:MARK.start(2)] + f"\nwindow.ONYX_DATA = {blob};\n" + shell[MARK.end(2):]
with open("index.html", "w", encoding="utf-8") as f:
    f.write(html)
print(f"✓ index.html: {len(players)} players, {len(games_out)} games")
