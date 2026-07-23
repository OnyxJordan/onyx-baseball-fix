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

# No games scheduled (off-day, All-Star break): leave yesterday's page live
# and exit clean so the Action stays green.
if not _by_game:
    print("no games today - leaving index.html untouched")
    sys.exit(0)

for gk, rows in _by_game.items():
    away, _, home = gk.partition("_")
    gl = GAMES.get(gk, {}) if isinstance(GAMES, dict) else {}
    # weather.json is keyed by HOME team abbr (fetch_data.fetch_weather);
    # tolerate legacy game_key-keyed files too
    wx = {}
    if isinstance(WEATHER, dict):
        wx = WEATHER.get(home) or WEATHER.get(gk) or {}
    time_s = gl.get("time", "") or ""
    label = f"{away} @ {home}" + (f" ({time_s})" if time_s else "")
    game = {
        "game_key": gk, "label": label,
        "away_team": away, "home_team": home,
        "away_pitcher": gl.get("awayP") or "",
        "home_pitcher": gl.get("homeP") or "",
        "total": gl.get("total"),
        "away_ml": gl.get("away_ml"), "home_ml": gl.get("home_ml"),
        "time": time_s, "venue": gl.get("venue", "") or wx.get("venue", "") or wx.get("park", ""),
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
# label -> gamePk map for live-layer wiring in the shell
gl_pk_by_label = {g["label"]: (GAMES.get(g["game_key"], {}) or {}).get("gamePk")
                  for g in games_out}

def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default

_model_errs = 0
for game in games_out:
    wx = game.get("weather") or {}
    park      = game.get("venue") or wx.get("venue") or wx.get("park") or ""
    wind_dir  = wx.get("wind_dir") or wx.get("wind_direction") or ""
    wind_mph  = _num(wx.get("wind_mph") or wx.get("wind_speed") or wx.get("wind_spd"), 0.0)
    temp      = _num(wx.get("temp") or wx.get("temperature"), 72.0)
    roof      = bool(wx.get("roof") or wx.get("roof_closed"))
    humidity  = _num(wx.get("humidity") or wx.get("humidity_pct"), 50.0)
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

            # ---- shell payload: model output enriched to the FULL schema the
            # shell renders (board columns, edge plays, chips, due meter).
            # Missing any of these leaves "undefined" on the page.
            l14  = L14N.get(bkey) or {}
            spl  = P14N.get(nk(opp_sp or "")) or {}
            batd = bat or {}
            o_imp = round(o["prob"] * 100, 2) if o else None
            blow  = r.get("wind_blow")
            if roof:
                wlabel = "ROOF"
            elif wind_dir:
                tag = {"out": "↗ OUT", "in": "↘ IN", "cross": "→ CROSS"}.get(blow, "")
                wlabel = f"{wind_dir} {int(round(wind_mph))}mph {tag}".strip()
            else:
                wlabel = ""
            hr9 = spl.get("l14_hr_rate") and round(spl["l14_hr_rate"] * 38.7, 2)
            if not hr9:
                hr9 = (sp_e or {}).get("hr9_6") or (sp_e or {}).get("hr9_3")
            ds = r.get("due_score") or 0
            due_label = "DUE" if ds >= 3 else ("HOT" if ds <= -3 else "NORMAL")
            dk_pts, fd_pts = r.get("dk_pts") or 0, r.get("fd_pts") or 0
            dk_sal = r.get("dk_salary") or 3000
            fd_sal = r.get("fd_salary") or 3000

            rec = dict(r)
            rec.update({
                "game":          game["label"],
                "gamePk":        gl_pk_by_label.get(game["label"]),
                "batter_name":   bname,
                "matched_name":  bname,
                "batter_hand":   b_hand or batd.get("hand") or "",
                "hand":          b_hand or batd.get("hand") or "",
                "dk_pos":        sal.get("dk_pos") or b_pos or "",
                "fd_pos":        sal.get("fd_pos") or b_pos or "",
                "location":      "home" if is_home else "away",
                # away/home as TEAM ABBRS (model's "home" is a boolean; the
                # shell builds game chips from `${r.away}@${r.home}`)
                "away":          game.get("away_team") or "",
                "home":          game.get("home_team") or "",
                "opp":           opp_team or "",
                "time":          game.get("time", ""),
                "venue":         park,
                "weather_label": wlabel,
                "wind_from":     wind_dir,
                "wind_factor":   r.get("env"),
                "wind_alignment": {"out": 1.0, "cross": 0.25, "in": -1.0}.get(blow, 0.0),
                "park_hr":       r.get("park_factor"),
                "env_factor":    r.get("env"),
                "opp_sp":        opp_sp or "",
                "opp_pitcher":   opp_sp or "",       # display name, not nk key
                "sp_hand":       p_hand or "",
                "opp_pitcher_hand": p_hand or "",
                "opp_pitcher_hr9":  round(hr9, 2) if hr9 else None,
                "opp_pitcher_era":  spl.get("l14_era"),
                "career_hr_pa":  batd.get("c"),
                "split_hr_pa":   batd.get("ch" if is_home else "ca"),
                "l14_hr":        l14.get("l14_hr", 0),
                "l14_pa":        l14.get("l14_pa", 0),
                "l14_xwoba":     l14.get("l14_xwoba"),
                "week_hr":       l14.get("l14_hr", 0),
                "week_pa":       l14.get("l14_pa", 0),
                # 2026-season quality (recent 6wk window first, 3yr fallback,
                # then L14 measurements) - POWER_FLOOR reads these
                "ev90_26":       batd.get("e6") or batd.get("e3") or l14.get("l14_ev90"),
                "barrel_26":     batd.get("b6") or batd.get("b3") or l14.get("l14_barrel_pct"),
                # h3 is HardHit%; h6/a6 are recent home/away HR splits, NOT hardhit
                "hh_pct":        batd.get("h3") or l14.get("l14_hh_pct"),
                "iso_ctx":       batd.get("i6") or batd.get("i3") or l14.get("l14_iso"),
                "ev90":          l14.get("l14_ev90") or batd.get("e3"),
                "barrel_pct":    l14.get("l14_barrel_pct") or batd.get("b3"),
                "due_label":     due_label,
                "due_detail":    f"{int(l14.get('l14_hr') or 0)}HR/{int(l14.get('l14_pa') or 0)}PA",
                "dk_hr_implied": o_imp,
                "avg_implied":   o_imp,
                "consensus_odds": o["american"] if o else None,
                "best_book":     "DK" if o else None,
                "open":          None,
                "dk_proj":       round(dk_pts, 2),
                "fd_proj":       round(fd_pts, 2),
                "dk_value":      round(dk_pts / (dk_sal / 1000.0), 2) if dk_sal else 0,
                "fd_value":      round(fd_pts / (fd_sal / 1000.0), 2) if fd_sal else 0,
            })
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

# ---------------------------------------------------------------- auto-log the TOP 5 board plays
# Mirrors the shell's Top Edge Plays tab exactly (POWER_FLOOR + positive edge,
# sorted by edge). Exactly these 5 form the daily tracked record; grade_picks
# settles them from boxscores the next morning. Hard cap of 5 per day even
# across hourly refresh runs.
def _power_floor(r):
    return ((r.get("ev90_26") or 0) >= 102.0
            and (r.get("barrel_26") or 0) >= 0.070
            and (r.get("iso_ctx") or 0) >= 0.110)

board = [r for r in results_out
         if r.get("dk_hr_odds") and (r.get("hr_edge") or 0) > 0 and _power_floor(r)]
board.sort(key=lambda r: -(r.get("hr_edge") or 0))
if board:
    picks = jload(dpath("picks_input.json"), [])
    if not isinstance(picks, list):
        picks = []
    stamp = now.strftime("%Y-%m-%d")
    have = {(p.get("date"), nk(p.get("player") or p.get("name") or ""))
            for p in picks if isinstance(p, dict)}
    room = 5 - sum(1 for p in picks if isinstance(p, dict) and p.get("date") == stamp)
    added = 0
    for r in board:
        if room - added <= 0:
            break
        key = nk(r["batter_name"])
        if (stamp, key) in have:
            continue
        picks.append({"date": stamp, "player": r["batter_name"],
                      "odds": r.get("dk_hr_odds"),
                      "prob": round((r.get("hr_prob") or 0) / 100, 4),
                      "edge": round(r.get("hr_edge") or 0, 2),
                      "hit": None})
        added += 1
    if added:
        with open(dpath("picks_input.json"), "w", encoding="utf-8") as f:
            json.dump(picks, f, indent=1, ensure_ascii=False)
    print(f"picks: top-5 tracker logged {added} new play(s) for {stamp}")
else:
    print("picks: no qualifying board plays (or no odds) - nothing logged")

# ---------------------------------------------------------------- inject payload into shell
# Fail loudly: an empty slate means upstream data broke. Abort without touching
# index.html so yesterday's page stays live instead of shipping a blank board.
if not results_out:
    sys.exit("FATAL: 0 players scored - refusing to overwrite index.html")

with open("shell.html", encoding="utf-8") as f:
    shell = f.read()

def replace_const(src, name, payload):
    pat = re.compile(r"^(\s*const %s\s*=\s*).*$" % re.escape(name), re.M)
    if not pat.search(src):
        sys.exit(f"FATAL: const {name} not found in shell.html")
    return pat.sub(lambda m: m.group(1) + json.dumps(payload, ensure_ascii=False) + ";", src, count=1)

def _sp_hand(name):
    key = nk(name or "")
    return (PITCHERS.get(key) or {}).get("hand") or HANDS.get(key) or "R"

def _sp_hr9(name):
    key = nk(name or "")
    spl = P14N.get(key) or {}
    if spl.get("l14_hr_rate"):
        return round(spl["l14_hr_rate"] * 38.7, 2)
    e = PITCHERS.get(key) or {}
    v = e.get("hr9_6") or e.get("hr9_3")
    return round(v, 2) if v else None

# group scored records per game for card aggregates
_by_label = {}
for rec in results_out:
    _by_label.setdefault(rec["game"], []).append(rec)

def _side_stats(rows):
    if not rows:
        return "", 0, 0.0
    top = max(rows, key=lambda x: x.get("hr_prob") or 0)
    exp = round(sum((x.get("hr_prob") or 0) for x in rows) / 100.0, 2)
    return top["batter_name"], top.get("hr_prob") or 0, exp

sums_out, keys_out = [], []
for g in games_out:
    k = g["label"]
    keys_out.append(k)
    rows  = _by_label.get(k, [])
    arows = [x for x in rows if x.get("team") == g.get("away_team")]
    hrows = [x for x in rows if x.get("team") == g.get("home_team")]
    a_top, a_top_p, a_exp = _side_stats(arows)
    h_top, h_top_p, h_exp = _side_stats(hrows)
    r0 = rows[0] if rows else {}
    wx = g.get("weather") or {}
    sums_out.append({
        "game": k, "label": k, "time": g.get("time",""),
        "away": g.get("away_team",""), "home": g.get("home_team",""),
        "venue": g.get("venue",""), "ou": g.get("total"),
        "gamePk": gl_pk_by_label.get(k),
        "roof": bool(wx.get("roof")),
        "away_ml": ("" if g.get("away_ml") is None else str(g["away_ml"])),
        "home_ml": ("" if g.get("home_ml") is None else str(g["home_ml"])),
        "awayP": g.get("away_pitcher",""), "homeP": g.get("home_pitcher",""),
        "awayHand": _sp_hand(g.get("away_pitcher")),
        "homeHand": _sp_hand(g.get("home_pitcher")),
        "awayP_hr9": _sp_hr9(g.get("away_pitcher")),
        "homeP_hr9": _sp_hr9(g.get("home_pitcher")),
        "away_top": a_top, "away_top_prob": a_top_p, "away_exp_hr": a_exp,
        "home_top": h_top, "home_top_prob": h_top_p, "home_exp_hr": h_exp,
        "n_away": len(arows), "n_home": len(hrows),
        "weather_label": r0.get("weather_label",""),
        "wind_factor": r0.get("env_factor") or 1.0,
        "wind_alignment": r0.get("wind_alignment") or 0.0,
        "wind_from": r0.get("wind_from",""),
    })

shell = replace_const(shell, "RESULTS", results_out)
shell = replace_const(shell, "SUMMARIES", sums_out)
shell = replace_const(shell, "ALL_GAME_KEYS", keys_out)

# ---- stamp the build date over the baked date literals ----
_badge = f"{now.strftime('%b').upper()} {now.day} · {now.year}"      # JUL 23 · 2026
_short = f"{now.strftime('%B')} {now.day}"                            # July 23
_long  = f"{_short}, {now.year}"                                      # July 23, 2026
shell = re.sub(r"[A-Z]{3} \d{1,2} · \d{4}", _badge, shell)
shell = re.sub(r"(Live · |Today · )[A-Z][a-z]+ \d{1,2}, \d{4}", r"\g<1>" + _long, shell)
shell = re.sub(r"(Onyx Baseball · )[A-Z][a-z]+ \d{1,2}", r"\g<1>" + _short, shell)
shell = re.sub(r"(Top Edge Plays — )[A-Z][a-z]+ \d{1,2}", r"\g<1>" + _short, shell)
with open("index.html", "w", encoding="utf-8") as f:
    f.write(shell)
print(f"index.html: {len(results_out)} players, {len(games_out)} games")
