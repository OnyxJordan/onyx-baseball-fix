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

def _hours_since_start(iso):
    """Hours since scheduled first pitch; 0.0 pregame or unparseable."""
    if not iso:
        return 0.0
    try:
        import datetime as _dt
        st = _dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return max(0.0, (_dt.datetime.now(_dt.timezone.utc) - st).total_seconds() / 3600.0)
    except Exception:
        return 0.0

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
HSPLITS  = jload(dpath("hand_splits.json"), {})   # vs-hand power + real batSide

LINEUPS  = jload(dpath("lineups.json"), {})
WEATHER  = jload(dpath("weather.json"), {})
ODDS_RAW = jload(dpath("odds.json"), {})
SEASONP  = jload(dpath("pitcher_season.json"), {})   # starter season + 3yr K history
KLINES   = jload(dpath("k_lines.json"), {})          # listed K prop lines
TEAMK    = jload(dpath("team_k.json"), {})           # season team K% vs hand

def _sp_hand(name):
    key = nk(name or "")
    return (PITCHERS.get(key) or {}).get("hand") or HANDS.get(key) or "R"

def _sp_hr9(name):
    """Career-anchored HR/9 for display: 3-year base, season shrunk in by
    innings, L14 a nudge — the same shape the model uses (v29)."""
    key = nk(name or "")
    e = PITCHERS.get(key) or {}
    spl = P14N.get(key) or {}
    car, sea = e.get("hr9_3"), e.get("hr9_6")
    hr9 = car or sea
    if car and sea:
        ip_sea = (SEASONP.get(key) or {}).get("ip") or 0
        w = min(0.45, ip_sea / 220.0)
        hr9 = (1 - w) * car + w * sea
    l14 = spl.get("l14_hr_rate") and spl["l14_hr_rate"] * 38.7
    if l14 and hr9:
        w14 = min(0.15, (spl.get("l14_bf") or 0) / 400.0)
        hr9 = (1 - w14) * hr9 + w14 * l14
    elif l14 and not hr9:
        hr9 = l14
    return round(hr9, 2) if hr9 else None

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
    """Blend xFIP-derived factor with HR-specific legs (HR/9, HR/FB, air
    rate, Barrel% allowed). v17 tuning: legs cap at 30% total weight inside
    tighter clamps, and prefer the 3-year rates over the noisier current
    season splits so one bad stretch cannot dominate the factor."""
    if base is None:
        base = 1.0
    legs, weights = [], []
    hr9 = e.get("hr9_3") if e.get("hr9_3") else e.get("hr9_6")
    if hr9 is not None:
        legs.append(min(max(float(hr9) / 1.15, 0.7), 1.5)); weights.append(0.15)
    hrfb = e.get("hrfb3") if e.get("hrfb3") else e.get("hrfb6")
    if hrfb is not None:
        legs.append(min(max(float(hrfb) / 0.115, 0.7), 1.5)); weights.append(0.08)
    gb = e.get("gb3") if e.get("gb3") else e.get("gb6")
    if gb is not None:
        legs.append(min(max((1.0 - float(gb)) / 0.575, 0.7), 1.5)); weights.append(0.05)
    brl = e.get("brl3")
    if brl is not None:
        legs.append(min(max(float(brl) / 0.075, 0.7), 1.5)); weights.append(0.02)
    if not legs:
        return base
    hr_leg = sum(l * w for l, w in zip(legs, weights)) / sum(weights)
    hr_w = sum(weights)                          # up to 0.30
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
def bullpen_mult(team_abbr, starter_e, starter_name=None):
    """Blend starter suppression with team relief HR/9, weighted by how deep
    TODAY'S starter actually goes (v32 — was a flat 40% bullpen share). A
    6.5-IP horse leaves ~28% of PAs to relievers; a 4-inning opener leaves
    ~55%, and facing a soft bullpen matters that much more that day."""
    bp = BULLPEN.get(team_abbr)
    if not bp or not bp.get("hr9"):
        return 1.0
    share = 0.40
    sp = SEASONP.get(nk(starter_name or "")) or {}
    try:
        ip, gs = float(sp.get("ip") or 0), float(sp.get("gs") or 0)
        if gs >= 3 and ip > 0:
            share = min(0.55, max(0.25, 1.0 - (ip / gs) / 9.0))
    except (TypeError, ValueError):
        pass
    bp_leg = min(max(float(bp["hr9"]) / 1.05, 0.7), 1.5)
    sp_leg = (starter_e or {}).get("pf_blend", 1.0)
    return round(((1.0 - share) * sp_leg + share * bp_leg) / max(sp_leg, 1e-6), 4)

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
    # doubleheader keys carry a numeric suffix (CLE_CIN_2): strip it before
    # deriving team abbrs, else the home team parses as "CIN_2"
    _kparts = gk.split("_")
    _gm = _kparts.pop() if (len(_kparts) > 2 and _kparts[-1].isdigit()) else ""
    away, home = _kparts[0], _kparts[1]
    gl = GAMES.get(gk, {}) if isinstance(GAMES, dict) else {}
    # weather.json is keyed by HOME team abbr (fetch_data.fetch_weather);
    # tolerate legacy game_key-keyed files too
    wx = {}
    if isinstance(WEATHER, dict):
        wx = WEATHER.get(home) or WEATHER.get(gk) or {}
    time_s = gl.get("time", "") or ""
    _tag = ", ".join(x for x in ([f"Gm {_gm}"] if _gm else []) + ([time_s] if time_s else []))
    label = f"{away} @ {home}" + (f" ({_tag})" if _tag else "")
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
            # lineups.json "hand" is a hardcoded display placeholder ("R" for
            # everyone); the real bat side comes from the MLB people batSide
            # captured in hand_splits.json
            b_hand = "" if isinstance(batter, str) else (batter.get("hand") or "")
            b_hand = (HSPLITS.get(bkey) or {}).get("bats") or b_hand
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
            # v29: career-anchored, not L14-first — same blend the model uses
            hr9 = _sp_hr9(opp_sp or "")
            # 7-tier heat label on the model's real due_score scale (expected
            # HRs minus actual over L14, sc-weighted; realistic range ~ -4..+2).
            # Bands mirror model.due_meter so the label always matches the
            # multiplier actually applied. Old +-3 thresholds landed everyone
            # on NORMAL forever.
            ds = r.get("due_score") or 0
            if   ds >  1.2:  due_label = "OVERDUE"
            elif ds >  0.6:  due_label = "DUE"
            elif ds >  0.15: due_label = "COOL"
            elif ds > -0.15: due_label = "NORMAL"
            elif ds > -0.6:  due_label = "WARM"
            elif ds > -1.2:  due_label = "HOT"
            else:            due_label = "FIRE"
            dk_pts, fd_pts = r.get("dk_pts") or 0, r.get("fd_pts") or 0
            dk_sal = r.get("dk_salary") or 3000
            fd_sal = r.get("fd_salary") or 3000

            # ---- live-slate honesty: a mid-game rebuild reprices this bat
            # against LIVE odds (remaining-ABs prices), but the model number
            # is a FULL-GAME probability. Measure edge with the probability
            # decayed by probable ABs remaining (elapsed time since first
            # pitch) so a +2000 live line never reads as a +8 "edge" against
            # a full-game 12%. hr_prob itself stays full-game — the shell's
            # live layer owns the displayed decay.
            _sh = _hours_since_start(gl.get("start"))
            if _sh > 0.05 and (r.get("hr_prob") or 0) > 0 and o_imp is not None:
                _frac_left = max(0.0, 1.0 - _sh / 2.9)
                _p = min(0.95, (r.get("hr_prob") or 0) / 100.0)
                _dec = (1.0 - (1.0 - _p) ** _frac_left) * 100.0
                r["hr_edge"] = round(_dec - o_imp, 1)

            rec = dict(r)
            rec.update({
                "game":          game["label"],
                "gamePk":        gl_pk_by_label.get(game["label"]),
                "mid":           batd.get("mid"),   # MLB player id for game logs
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
                # h3 is career HardHit%, but tiny-sample players carry junk
                # values (up to 1.000); anything past 62% is treated as
                # unreliable and falls back to the L14 measurement
                "hh_pct":        (batd.get("h3") if batd.get("h3") and batd["h3"] <= 0.62
                                  else l14.get("l14_hh_pct")) or l14.get("l14_hh_pct") or 0.38,
                "iso_ctx":       batd.get("i6") or batd.get("i3") or l14.get("l14_iso"),
                "ev90":          l14.get("l14_ev90") or batd.get("e3"),
                "barrel_pct":    l14.get("l14_barrel_pct") or batd.get("b3"),
                "due_label":     due_label,
                "due_detail":    f"{int(l14.get('l14_hr') or 0)}HR/{int(l14.get('l14_pa') or 0)}PA",
                "dk_hr_implied": o_imp,
                "avg_implied":   o_imp,
                "consensus_odds": o["american"] if o else None,
                "best_book":     "Onyx" if o else None,
                "open":          None,
                "dk_proj":       round(dk_pts, 2),
                "fd_proj":       round(fd_pts, 2),
                "dk_value":      round(dk_pts / (dk_sal / 1000.0), 2) if dk_sal else 0,
                "fd_value":      round(fd_pts / (fd_sal / 1000.0), 2) if fd_sal else 0,
            })
            # ---- ticket conviction: the Model's Ticket follows the DAY, not
            # a static list of sluggers. Raw probability is softened (^0.7)
            # and TODAY's situation stack is amplified on top: weather/env,
            # pitcher matchup, platoon, due meter, batter air geometry vs the
            # pitcher's fly-ball tendency, bullpen exposure, park, and
            # lineup-slot ABs. The top reasons ride along as chips.
            _why = []
            _sit = 1.0
            _envf = rec.get("env_factor") or 1.0
            _sit *= _envf ** 1.6
            if _envf >= 1.05: _why.append((_envf - 1, f"wind/heat ×{_envf:.2f}"))
            _pf = rec.get("p_factor") or 1.0
            _sit *= _pf ** 1.3
            if _pf >= 1.06: _why.append((_pf - 1, f"pitcher matchup ×{_pf:.2f}"))
            _plat = rec.get("platoon_factor") or 1.0
            _sit *= _plat
            if _plat >= 1.06: _why.append((_plat - 1, "platoon edge"))
            _duem = {"OVERDUE": 1.10, "DUE": 1.05, "COOL": 1.02}.get(rec.get("due_label") or "", 1.0)
            _sit *= _duem
            if _duem >= 1.05: _why.append((_duem - 1, (rec.get("due_label") or "").lower()))
            _bfb = (bat or {}).get("fb")
            if _bfb:
                _m = 1 + 0.35 * (float(_bfb) - 0.38) / 0.38
                _sit *= _m
                if _m >= 1.07: _why.append((_m - 1, f"{round(float(_bfb) * 100)}% FB bat"))
            _gb = (sp_e or {}).get("gb3") or (sp_e or {}).get("gb6")
            if _gb:
                _m = 1 + 0.30 * ((1 - float(_gb)) - 0.56) / 0.56
                _sit *= _m
                if _m >= 1.05: _why.append((_m - 1, "fly-ball pitcher"))
            _bpm = bullpen_mult(opp_team, sp_e, opp_sp)
            _sit *= _bpm
            if _bpm >= 1.04: _why.append((_bpm - 1, "soft bullpen"))
            _sit *= {1: 1.10, 2: 1.07, 3: 1.05, 4: 1.03, 5: 1.00,
                     6: 0.97, 7: 0.94, 8: 0.92, 9: 0.90}.get(spot, 1.0)
            _parkf = rec.get("park_hr") or 1.0
            _sit *= _parkf ** 0.7
            if _parkf >= 1.08: _why.append((_parkf - 1, f"park ×{_parkf:.2f}"))
            rec["ticket_score"] = round(((rec.get("hr_prob") or 0) / 100.0) ** 0.7 * _sit, 4)
            rec["ticket_why"] = [w for t in sorted([x for x in _why if x], reverse=True)[:3] for w in [t[1]]]

            results_out.append(rec)

            # ---- edge/picks lane: model prob + bullpen & pull-air layers ----
            base = (r.get("hr_prob") or 0) / 100.0
            if base <= 0:
                continue
            adj = base
            adj *= bullpen_mult(opp_team, sp_e, opp_sp)
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
def _quality_floor(r):
    # v21: a pick must show real contact quality. Speed-only profiles with
    # near-zero barrel rates never qualify, whatever the market prices.
    return ((r.get("hh_pct") or 0) >= model.QUALITY_HH_MIN
            and (r.get("barrel_26") or 0) >= model.QUALITY_BARREL_MIN)

def _ev(r):
    p = (r.get("hr_prob") or 0) / 100.0
    o = r.get("dk_hr_odds") or 0
    return p * (o / 100.0) - (1 - p) if o > 0 else -1.0

# ONLY positive-EV plays that clear the v21 quality floor are tracked and
# graded: the record is the money record and the calibration signal. v20
# edge is vs the listed price, so edge > 0 IS positive EV; the quality
# floor (min hard-hit + barrel rate) then screens out market noise on
# no-power profiles. On tight days fewer than five log, and that is the
# honest answer.
_cands = [r for r in results_out if r.get("dk_hr_odds")]
board = sorted([r for r in _cands
                if (r.get("hr_edge") or 0) > 0 and _ev(r) > 0 and _quality_floor(r)],
               key=lambda r: -(r.get("hr_edge") or 0))
for r in board:
    r["_tier"] = "edge"
picks = jload(dpath("picks_input.json"), [])
if not isinstance(picks, list):
    picks = []
stamp = now.strftime("%Y-%m-%d")

# v30: collapse duplicate (date, player) entries — build races / merge
# unions had doubled entries (7/25 carried 10 picks incl. the same player
# twice). First occurrence wins; the record is sacred.
_seen, _clean = set(), []
for p in picks:
    if not isinstance(p, dict):
        continue
    kk = (p.get("date"), nk(p.get("player") or p.get("name") or ""))
    if kk in _seen:
        continue
    _seen.add(kk)
    _clean.append(p)
_deduped = len(picks) - len(_clean)
picks = _clean

_slate_started = any(
    _hours_since_start((g or {}).get("start")) > 0.0
    for g in (GAMES.values() if isinstance(GAMES, dict) else []))

# v32 TICKET LOCK: the Model's Ticket is decided server-side and FROZEN at
# the slate's first pitch. It was rebuilt client-side from the live pool on
# every render, so legs dropped out as their games started and the ticket
# visibly wandered all evening. Pregame builds may refresh it (fresher
# lineups/odds); once any game starts, the saved ticket is the ticket.
TICKET_PATH = dpath("ticket_lock.json")
_tlock = jload(TICKET_PATH, {})
if _tlock.get("date") != stamp or not _slate_started:
    _tl_pool, _tl_seen = [], set()
    for r in sorted(results_out, key=lambda x: -(x.get("ticket_score") or 0)):
        if not r.get("mid") or (r.get("hr_prob") or 0) < 15:
            continue
        if (r.get("hh_pct") or 0) < 0.32 or (r.get("barrel_26") or 0) < 0.05:
            continue
        k = nk(r.get("batter_name") or "")
        if k in _tl_seen:
            continue
        gk_ = next((g["game_key"] for g in games_out if g["label"] == r.get("game")), "")
        if _hours_since_start((GAMES.get(gk_, {}) or {}).get("start")) > 0.0:
            continue
        _tl_seen.add(k)
        _tl_pool.append(r)
    if len(_tl_pool) >= 2:
        _legs_n = max(2, min(5, sum(1 for r in _tl_pool if (r.get("ticket_score") or 0) >= 0.65)))
        _tlock = {"date": stamp,
                  "locked": bool(_slate_started),
                  "legs": [{"player": r.get("batter_name"), "mid": r.get("mid"),
                            "team": r.get("team"), "odds": r.get("dk_hr_odds"),
                            "prob": r.get("hr_prob"),
                            "score": round(r.get("ticket_score") or 0, 3),
                            "why": r.get("ticket_why") or [],
                            "away": r.get("away") or "", "home": r.get("home") or "",
                            "opp": r.get("opp_pitcher") or "", "time": r.get("time") or ""}
                           for r in _tl_pool[:_legs_n]]}
        with open(TICKET_PATH, "w", encoding="utf-8") as f:
            json.dump(_tlock, f, indent=1, ensure_ascii=False)
        print(f"ticket: {len(_tlock['legs'])} leg(s) for {stamp} "
              f"({'FROZEN' if _slate_started else 'refreshing until first pitch'})")
    elif _tlock.get("date") != stamp:
        _tlock = {}
elif _tlock.get("date") == stamp and not _tlock.get("locked"):
    _tlock["locked"] = True   # slate started: freeze whatever the last pregame build saved
    with open(TICKET_PATH, "w", encoding="utf-8") as f:
        json.dump(_tlock, f, indent=1, ensure_ascii=False)
    print(f"ticket: FROZEN for {stamp} ({len(_tlock.get('legs') or [])} legs)")

# v33 TICKET LEDGER: one $10 parlay per day, tracked and graded like the
# picks. The day's entry follows the ticket lock while it is still pregame,
# freezes with it, and grade_picks settles the legs off the box scores.
TH_PATH = dpath("ticket_history.json")
_thist = jload(TH_PATH, [])
if not isinstance(_thist, list):
    _thist = []
if _tlock.get("date") == stamp and (_tlock.get("legs") or []):
    _legs_h = [{"player": l.get("player"), "odds": l.get("odds"),
                "prob": l.get("prob"), "hit": None} for l in _tlock["legs"]]
    _entry = next((t for t in _thist if isinstance(t, dict) and t.get("date") == stamp), None)
    if _entry is None:
        _thist.append({"date": stamp, "stake": 10, "legs": _legs_h,
                       "result": None, "pnl": None})
        _thist.sort(key=lambda t: str(t.get("date") or ""))
        with open(TH_PATH, "w", encoding="utf-8") as f:
            json.dump(_thist, f, indent=1, ensure_ascii=False)
        print(f"ticket ledger: opened {stamp} ({len(_legs_h)} legs, $10 stake)")
    elif not _tlock.get("locked") and _entry.get("result") is None:
        if _entry.get("legs") != _legs_h:
            _entry["legs"] = _legs_h
            with open(TH_PATH, "w", encoding="utf-8") as f:
                json.dump(_thist, f, indent=1, ensure_ascii=False)
            print(f"ticket ledger: refreshed {stamp} legs (pregame)")

# v33 SLATE LOCK: ONE story between the ticket and the record. The tracked
# five now lead with the TICKET LEGS — the model's favorite plays regardless
# of edge — then fill with the best positive-edge plays. The old edge-only
# gate is how 7/30's #1 conviction play (B. Lowe, 25.8%, +270, homered)
# stayed off the ledger while three +800 longshots got graded: the ticket
# and the tracker were keeping different scoreboards. Top-up until the
# slate's first pitch (add-only, never replace), then freeze.
_today_names = {nk(p.get("player") or "") for p in picks if p.get("date") == stamp}
_pregame = [r for r in board
            if _hours_since_start((GAMES.get(
                next((g["game_key"] for g in games_out if g["label"] == r.get("game")), ""), {})
                or {}).get("start")) <= 0.0]
_ticket_rows, _ticket_ids = [], set()
if _tlock.get("date") == stamp:
    _by_bname = {nk(r.get("batter_name") or ""): r for r in results_out}
    for l in (_tlock.get("legs") or []):
        rr = _by_bname.get(nk(l.get("player") or ""))
        if rr is None:
            continue
        gk_ = next((g["game_key"] for g in games_out if g["label"] == rr.get("game")), "")
        if _hours_since_start((GAMES.get(gk_, {}) or {}).get("start")) <= 0.0:
            _ticket_rows.append(rr)
            _ticket_ids.add(id(rr))
added = 0
if not _slate_started:
    for r in _ticket_rows + _pregame:
        if len(_today_names) >= 5:
            break
        if nk(r.get("batter_name") or "") in _today_names:
            continue
        picks.append({"date": stamp, "player": r["batter_name"],
                      "odds": r.get("dk_hr_odds"),
                      "prob": round((r.get("hr_prob") or 0) / 100, 4),
                      "edge": round(r.get("hr_edge") or 0, 2),
                      "tier": "ticket" if id(r) in _ticket_ids else r.get("_tier", "edge"),
                      "hit": None})
        _today_names.add(nk(r["batter_name"]))
        added += 1
if added or _deduped:
    with open(dpath("picks_input.json"), "w", encoding="utf-8") as f:
        json.dump(picks, f, indent=1, ensure_ascii=False)
if added:
    print(f"picks: +{added} play(s) -> {len(_today_names)}/5 for {stamp}"
          f"{' (slate open, top-up until first pitch)' if not _slate_started else ''}")
elif _slate_started:
    print(f"picks: slate LOCKED for {stamp} ({len(_today_names)} play(s))")
else:
    print(f"picks: {len(_today_names)}/5 for {stamp} - no new qualifying plays this run")
if _deduped:
    print(f"picks: removed {_deduped} duplicate record entr(ies)")

# ---------------------------------------------------------------- inject payload into shell
# Fail loudly: an empty slate means upstream data broke. Abort without touching
# index.html so yesterday's page stays live instead of shipping a blank board.
if not results_out:
    sys.exit("FATAL: 0 players scored - refusing to overwrite index.html")

with open("shell.html", encoding="utf-8") as f:
    shell = f.read()

def replace_const(src, name, payload):
    pat = re.compile(r"^(\s*(?:const|var|let) %s\s*=\s*).*$" % re.escape(name), re.M)
    if not pat.search(src):
        sys.exit(f"FATAL: const {name} not found in shell.html")
    return pat.sub(lambda m: m.group(1) + json.dumps(payload, ensure_ascii=False) + ";", src, count=1)

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

KLINES_NK = {nk(k): v for k, v in KLINES.items()} if isinstance(KLINES, dict) else {}

def _opp_k_pct(opprows):
    vals = [(L14N.get(nk(x.get("batter_name") or "")) or {}).get("l14_k_pct") for x in opprows]
    vals = [v for v in vals if v]
    return sum(vals) / len(vals) if len(vals) >= 5 else None

sums_out, keys_out, pitchers_out = [], [], []
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
    gl = GAMES.get(g["game_key"], {}) if isinstance(GAMES, dict) else {}
    sums_out.append({
        "game": k, "label": k, "time": g.get("time",""),
        "game_key": g["game_key"], "start": gl.get("start"),
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

    # ---- Pitchers tab: K / pitch-count / HRs-allowed / win projections for
    # both probables, opponent recency read from the ACTUAL opposing lineup
    for side, pname, is_home in (("away", g.get("away_pitcher"), False),
                                 ("home", g.get("home_pitcher"), True)):
        if not pname:
            continue
        pk_ = nk(pname)
        opprows = hrows if side == "away" else arows
        try:
            proj = model.project_pitcher(
                pname,
                pdb_entry=PITCHERS.get(pk_),
                l14=P14N.get(pk_),
                season=SEASONP.get(pk_),
                opp_k_pct=_opp_k_pct(opprows),
                opp_team_k=TEAMK.get(g.get("home_team" if side == "away" else "away_team") or ""),
                park=g.get("venue") or "",
                is_home=is_home,
                ml_self=g.get("home_ml") if is_home else g.get("away_ml"),
                ml_opp=g.get("away_ml") if is_home else g.get("home_ml"),
                k_line=KLINES.get(pname) or KLINES_NK.get(pk_),
            )
        except Exception:
            proj = None
        if not proj:
            continue
        proj.update({
            "name": pname,
            "team": g.get(f"{side}_team") or "",
            "opp":  g.get("home_team" if side == "away" else "away_team") or "",
            "game": k, "time": g.get("time", ""),
            "venue": g.get("venue", ""),
        })
        pitchers_out.append(proj)

pitchers_out.sort(key=lambda p: (p.get("k_edge") is None, -(p.get("k_edge") or 0), -(p.get("k_proj") or 0)))

shell = replace_const(shell, "RESULTS", results_out)
shell = replace_const(shell, "SUMMARIES", sums_out)
shell = replace_const(shell, "ALL_GAME_KEYS", keys_out)
shell = replace_const(shell, "LINE_HISTORY", jload(dpath("line_history.json"), []))
shell = replace_const(shell, "PITCHER_PROJ", pitchers_out)
shell = replace_const(shell, "DAILY_RECAP", jload(dpath("recap.json"), {}))
shell = replace_const(shell, "TICKET_LOCK", _tlock if _tlock.get("legs") else None)
shell = replace_const(shell, "TICKET_HISTORY", _thist)

# ---- Onyx game links: only today's harvested slugs ever ship ----
from zoneinfo import ZoneInfo
_onyx = jload(dpath("onyx_games.json"), {}) or {}
_et_today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
_onyx_links = _onyx.get("links") or {} if _onyx.get("date") == _et_today else {}
shell = replace_const(shell, "ONYX_GAME_LINKS", _onyx_links)

# OpticOdds player ids for today's bats + starters: player-prop share
# selections need the id as the tail. Injected only for today's names so
# the payload stays small.
_opids_all = jload(dpath("onyx_players.json"), {})
_opids = {}
if isinstance(_opids_all, dict):
    for rec in results_out:
        k2 = nk(rec.get("matched_name") or "")
        if k2 in _opids_all:
            _opids[k2] = _opids_all[k2]
    for p in pitchers_out:
        k2 = nk(p.get("name") or "")
        if k2 in _opids_all:
            _opids[k2] = _opids_all[k2]
shell = replace_const(shell, "ONYX_PLAYER_IDS", _opids)
print(f"onyx player ids: {len(_opids)} injected for today")
print(f"onyx links: {len(_onyx_links)} game(s) wired for {_et_today}")

# ---- stamp the build date over the baked date literals ----
_badge = f"{now.strftime('%b').upper()} {now.day} · {now.year}"      # JUL 23 · 2026
_short = f"{now.strftime('%B')} {now.day}"                            # July 23
_long  = f"{_short}, {now.year}"                                      # July 23, 2026
shell = re.sub(r"[A-Z]{3} \d{1,2} · \d{4}", _badge, shell)
shell = re.sub(r"(Live · |Today · )[A-Z][a-z]+ \d{1,2}, \d{4}", r"\g<1>" + _long, shell)
shell = re.sub(r"(Onyx Baseball · )[A-Z][a-z]+ \d{1,2}", r"\g<1>" + _short, shell)
shell = re.sub(r"(Top Edge Plays — )[A-Z][a-z]+ \d{1,2}", r"\g<1>" + _short, shell)

# last-updated stamp in the nav (Eastern)
try:
    from zoneinfo import ZoneInfo
    _et = now.astimezone(ZoneInfo("America/New_York"))
except Exception:
    from datetime import timedelta as _td, timezone as _tz
    _et = now.astimezone(_tz(_td(hours=-4)))
_stamp = "updated " + _et.strftime("%-I:%M %p ET").lower()
shell = re.sub(r'(id="buildStamp">)[^<]*', r"\g<1>" + _stamp, shell)
with open("index.html", "w", encoding="utf-8") as f:
    f.write(shell)
print(f"index.html: {len(results_out)} players, {len(games_out)} games")
