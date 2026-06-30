"""
model.py — Onyx Baseball v15 HR probability + DFS projection model

v15 changes vs v14:
  - De-vig: market implied prob is stripped of HR_VIG before it anchors the
    blend AND before edge is measured, so edge = w*(raw - fair) cleanly.
  - Market-blend weights w widened ~+0.15/tier so model factors (incl. weather)
    show through instead of being damped to a third of their size.
  - wind_env() rewritten: parses descriptive labels ("out"/"in"/"L-R"/"calm")
    as well as compass tokens, ~3x stronger out-wind coefficient, wider clamp,
    roof returns flat 1.0.

PATH NOTE: SEASON_SPLITS loads from _BASE / "data" / "splits.json".
fetch_data.py writes splits.json into its OUT dir (data/). As long as model.py
sits at repo root and the build runs from root, these line up. If you ever see
SEASON_SPLITS come back empty, check this path first.
"""

import json, math
from pathlib import Path

# Load career databases (baked in at repo root)
_BASE = Path(__file__).parent
with open(_BASE / "career_db.json") as f:
    CAREER_DB = json.load(f)
with open(_BASE / "pitcher_db.json") as f:
    PITCHER_CAREER_DB = json.load(f)

# Optional season home/away splits produced by fetch_data.py fetch_splits().
# Safe if the file is missing — model falls back to CAREER_DB ch/ca fields.
try:
    with open(_BASE / "data" / "splits.json") as f:
        SEASON_SPLITS = json.load(f)
    print(f"  model: SEASON_SPLITS loaded ({len(SEASON_SPLITS)} players)")
except Exception:
    SEASON_SPLITS = {}
    print("  model: splits.json not found — using CAREER_DB ch/ca fallback")

# ── CONSTANTS ──────────────────────────────────────────────────────────────────
POS_HR_AVG = {
    "C": 0.032, "1B": 0.050, "2B": 0.028, "3B": 0.035,
    "SS": 0.025, "OF": 0.038, "DH": 0.043, "P": 0.005,
}
REG_K  = 250
SCALE  = 0.86
HR_VIG = 0.13   # approx single-side hold on HR-Yes props; calibrate vs resolved results

PA_TABLE   = {1:4.492,2:4.363,3:4.367,4:4.269,5:4.223,6:4.059,7:3.946,8:3.831,9:3.748}
RUNS_BY_BO = {1:0.533,2:0.543,3:0.476,4:0.469,5:0.451,6:0.401,7:0.403,8:0.399,9:0.409}
RBI_BY_BO  = {1:0.438,2:0.514,3:0.495,4:0.547,5:0.478,6:0.403,7:0.415,8:0.399,9:0.403}

PARK_HR_FACTOR = {
    "Coors Field": 1.35,
    "Great American Ball Park": 1.12,
    "Wrigley Field": 1.09,
    "Citizens Bank Park": 1.07,
    "Yankee Stadium": 1.07,
    "Chase Field": 1.02,
    "American Family Field": 1.02,
    "Globe Life Field": 1.02,
    "Nationals Park": 0.98,
    "loanDepot Park": 0.98,
    "Truist Park": 0.98,
    "Rogers Centre": 0.98,
    "PNC Park": 0.97,
    "Camden Yards": 0.95,
    "Fenway Park": 0.95,
    "Kauffman Stadium": 0.95,
    "T-Mobile Park": 0.95,
    "Target Field": 0.95,
    "Minute Maid Park": 0.97,
    "Guaranteed Rate Field": 0.97,
    "Progressive Field": 0.97,
    "Comerica Park": 0.96,
    "Citi Field": 0.96,
    "Busch Stadium": 0.92,
    "Angel Stadium": 0.93,
    "Petco Park": 0.88,
    "Oracle Park": 0.88,
    "Oakland Coliseum": 0.94,
    "Tropicana Field": 0.96,
}

PARK_OUT = {
    "Wrigley Field":            ["S","SSW","SSE","SW","WSW","W","WNW","SE"],
    "Citizens Bank Park":       ["SW","WSW","W","WNW","NW","SSW","S"],
    "Oracle Park":              ["E","SE","ESE","SSE","NE"],
    "Great American Ball Park": ["SW","S","SSW","W","WSW","SSE","SE"],
    "Yankee Stadium":           ["SW","SSW","S","WSW","W"],
    "Fenway Park":              ["SW","SSW","W","WSW","S"],
    "Globe Life Field":         ["S","SSW","SW","SSE","SE"],
    "Truist Park":              ["SW","W","WSW","S","SSW","SSE"],
    "Busch Stadium":            ["SW","SSW","S","W","WSW","NW"],
    "Target Field":             ["S","SSW","SW","SSE","SE"],
    "Coors Field":              ["SW","S","SSW","W","WSW","NW","SSE"],
    "Dodger Stadium":           ["S","SW","SSW","SSE","SE"],
    "Petco Park":               ["SW","WSW","W","SSW","S"],
    "Comerica Park":            ["SW","SSW","S","W","WSW"],
    "PNC Park":                 ["SW","S","SSW","W","WSW"],
    "Kauffman Stadium":         ["S","SW","SSW","SSE","SE"],
    "Nationals Park":           ["S","SW","SSW","SSE","SE"],
    "T-Mobile Park":            ["S","SW","SSW","SSE","SE"],
    "Progressive Field":        ["SW","S","SSW","W","WSW"],
    "Angel Stadium":            ["SW","S","SSW","W","SSE"],
    "Citi Field":               ["SW","SSW","S","W","WSW"],
    "loanDepot Park":           ["SE","SSE","E","ESE","S"],
    "American Family Field":    ["S","SW","SSW","SE","SSE"],
    "Camden Yards":             ["SW","SSW","S","W","WSW"],
    "Tropicana Field":          ["S","SW","SSW","SE","SSE"],
    "Guaranteed Rate Field":    ["S","SW","SSW","SE","SSE"],
    "Minute Maid Park":         ["S","SW","SSW","SE","SSE"],
    "Chase Field":              ["S","SW","SSW","SE","SSE"],
}
PARK_IN = {
   "Wrigley Field":            ["N","NNE","NE","ENE","NNW","NW"],
    "Citizens Bank Park":       ["NE","ENE","E","N","NNE"],
    "Great American Ball Park": ["N","NE","NNE","E","ENE","NNW"],
    "Oracle Park":              ["W","NW","WNW","SW","NNW"],
    "Yankee Stadium":           ["N","NE","NNE","ENE","NNW"],
    "Fenway Park":              ["N","NE","NNE","ENE","NNW"],
    "Comerica Park":            ["W","NW","WNW","N","NNW","E"],
    "Busch Stadium":            ["NE","ENE","E","NNE","N"],
    "Target Field":             ["N","NNW","NW","NNE","NE"],
    "Coors Field":              ["NE","ENE","E","NNE","N"],
    "Dodger Stadium":           ["N","NNW","NW","NE","NNE"],
    "Petco Park":               ["NE","ENE","E","NNE","N"],
    "Kauffman Stadium":         ["N","NNE","NE","NNW","NW"],
    "PNC Park":                 ["N","NE","NNE","NNW","NW"],
    "Citi Field":               ["N","NE","NNE","NNW","NW"],
    "Nationals Park":           ["N","NE","NNE","NNW","NW"],
    "Truist Park":              ["N","NE","NNE","NNW","NW"],
    "Camden Yards":             ["N","NE","NNE","ENE","NNW"],
    "T-Mobile Park":            ["N","NNW","NW","NNE","NE"],
    "Progressive Field":        ["N","NE","NNE","ENE","NNW"],
    "Angel Stadium":            ["N","NNW","NW","NNE","NE"],
}

# ── HELPERS ────────────────────────────────────────────────────────────────────
def implied_prob(american_odds: int) -> float:
    if american_odds >= 0:
        return 100 / (100 + american_odds)
    return abs(american_odds) / (abs(american_odds) + 100)

def wind_env(park: str, wind_dir: str, wind_mph: float, temp: float, roof: bool) -> float:
    """
    HR environment factor from wind + temperature. Parses descriptive labels
    ("out"/"in"/"L-R"/"calm") as well as compass tokens. Roof = flat 1.0.
    Kept in lockstep with auto_build.calc_wind_factor().
    """
    if roof:
        return 1.0
    env = 1.0
    wd  = str(wind_dir or "").strip().lower()
    mph = min(float(wind_mph or 0), 25)

    if   wd.startswith("out"):                        blow = "out"
    elif wd.startswith("in"):                         blow = "in"
    elif wd in ("l-r", "r-l", "cross", "across"):     blow = "cross"
    elif wd == "calm":                                blow = None
    elif park in PARK_OUT and wind_dir in PARK_OUT[park]:        blow = "out"
    elif park in PARK_IN  and wind_dir in PARK_IN.get(park, []): blow = "in"
    else:                                             blow = "cross" if mph >= 8 else None

    if   blow == "out":   env += 0.010 * mph      # ~+0.15 at 15mph straight out
    elif blow == "in":    env -= 0.008 * mph
    elif blow == "cross": env += 0.002 * mph

    env += (temp - 72) * 0.0025
    return max(0.82, min(1.22, env))

def sc_score(d: dict, l14: dict = None) -> float:
    """
    Statcast quality score. Prefers LIVE L14 Statcast (real barrel%/EV90/hardhit
    from statcast_l14.json) when present; falls back to baked-in career fields.
    """
    if l14 and l14.get("l14_pa", 0) >= 15:
        b  = l14.get("l14_barrel_pct", 0.085) or 0.085
        h  = l14.get("l14_hh_pct", 0.40)      or 0.40
        e  = l14.get("l14_avg_ev", 95)        or 95
        i  = l14.get("l14_iso", 0.165)        or 0.165
        pa = l14.get("l14_pa", 0)             or 0
        pa_ref = 55           # barrel%/EV/HH stabilize fast — trust a ~50-PA L14 window          # L14 sample matures faster than 3yr
    else:
        b  = d.get("b3", 0.085) or 0.085
        h  = d.get("h3", 0.40)  or 0.40
        e  = d.get("e3", 95)    or 95
        i  = d.get("i3", 0.165) or 0.165
        pa = d.get("p3", 0)     or 0
        pa_ref = 400

    sc_raw = (0.35*(b/0.085) + 0.25*(h/0.40) + 0.25*((e-85)/20) + 0.15*(i/0.165))
    sc_raw = max(0.60, min(1.35, sc_raw))
    pa_conf = min(pa / pa_ref, 1.0)
    return pa_conf * sc_raw + (1 - pa_conf) * 0.90

def pitcher_factor(pitcher_name: str, l14_pitchers: dict = None, is_home_pitcher: bool = False) -> float:
    """
    is_home_pitcher: True if this pitcher is pitching at HOME (i.e. batters face him at his home park).
    pfh = factor when pitching at home, pfa = factor when pitching away.
    """
    pk = pitcher_name.lower()
    pd = PITCHER_CAREER_DB.get(pk, {})
    if is_home_pitcher and pd.get("pfh"):
        base_pf = max(0.50, min(1.80, float(pd["pfh"])))
    elif not is_home_pitcher and pd.get("pfa"):
        base_pf = max(0.50, min(1.80, float(pd["pfa"])))
    elif pd.get("pf"):
        base_pf = max(0.50, min(1.80, float(pd["pf"])))
    else:
        base_xfip = pd.get("xf3") or pd.get("xf6") or 4.0
        base_pf = max(0.50, min(1.80, base_xfip / 4.0))

    if l14_pitchers and pk in l14_pitchers:
        l14 = l14_pitchers[pk]
        bf = l14.get("l14_bf", 0)
        if bf >= 10:
            hr_rate = l14.get("l14_hr_rate", 0.03)
            l14_pf = max(0.60, min(1.50, hr_rate / 0.033))
            w = min(bf / 100, 0.30)
            base_pf = (1 - w) * base_pf + w * l14_pf

    return round(base_pf, 3)

def due_meter(d: dict, sc: float, l14: dict = None) -> float:
  due_mult = due_meter(d, sc, l14)
_dpa = (l14 or {}).get("l14_pa", 0) or 0
_dhr = (l14 or {}).get("l14_hr", 0) or 0
_drate = d.get("c", 0.038) or 0.038
due_score = ((_drate * _dpa) - _dhr) * sc if _dpa >= 20 else 0.0
    """Multiplicative due meter based on career expectation vs recent results."""
    if not l14:
        return 1.0
    career_rate = d.get("c", 0.038) or 0.038
    l14_pa = l14.get("l14_pa", 0) or 0
    l14_hr = l14.get("l14_hr", 0) or 0
    if l14_pa < 20:
        return 1.0
    expected = career_rate * l14_pa
    due_score = (expected - l14_hr) * sc
    if due_score > 1.2:   return 1.30
    if due_score > 0.6:   return 1.15
    if due_score > 0.15:  return 1.05
    if due_score > -0.15: return 1.00
    if due_score > -0.6:  return 0.97
    if due_score > -1.2:  return 0.93
    return 0.88

# ── MAIN PROJECTION ────────────────────────────────────────────────────────────
def project_player(
    name: str,
    pos: str,
    batting_order: int,
    is_home: bool,
    opp_pitcher: str,
    park: str,
    park_factor: float,
    wind_dir: str,
    wind_mph: float,
    temp: float,
    roof: bool,
    dk_odds: int = None,
    dk_salary: int = 3000,
    fd_salary: int = 3000,
    l14_statcast: dict = None,
    l14_pitchers: dict = None,
    game_key: str = "",
    game_label: str = "",
    team: str = "",
    weather_flag: str = "clear",
) -> dict:

    player_key = name.lower()
    d = CAREER_DB.get(player_key, {})
    l14 = (l14_statcast or {}).get(player_key, {})

    # 1. Base rate (Bayesian regression)
    career_rate = d.get("c", POS_HR_AVG.get(pos, 0.038)) or POS_HR_AVG.get(pos, 0.038)
    pa_3yr      = d.get("p3", 0) or 0
    pos_avg     = POS_HR_AVG.get(pos, 0.038)
    c_adj = (career_rate * pa_3yr + REG_K * pos_avg) / (pa_3yr + REG_K)

    # Home/away split — prefer 2026 season splits (splits.json), else CAREER_DB ch/ca
    _split = SEASON_SPLITS.get(player_key, {})
    side_key = "ch" if is_home else "ca"
    if _split.get(side_key) is not None:
        split_rate = _split[side_key] or career_rate
        split_pa   = _split.get(f"{side_key}_pa", 0) or 1
    else:
        split_rate = d.get(side_key, career_rate) or career_rate
        split_pa   = max(pa_3yr / 2, 1)

    if split_pa >= 50 and career_rate > 0:
        SPLIT_REG_K = 75
        pos_avg = POS_HR_AVG.get(pos, 0.038)
        base = (split_rate * split_pa + pos_avg * SPLIT_REG_K) / (split_pa + SPLIT_REG_K)
    else:
        base = c_adj

    # 2. L14 form adjustment
    if l14 and l14.get("l14_pa", 0) >= 20:
        l14_rate = l14["l14_rate"]
        form_adj = max(0.85, min(1.20, l14_rate / base)) if base > 0 else 1.0
        base = base * form_adj

    # 3. SC score (prefers live L14 Statcast)
    sc = sc_score(d, l14)

    # 4. Pitcher factor
    pf = pitcher_factor(opp_pitcher, l14_pitchers, is_home_pitcher=not is_home)

    # 5. Park + weather environment
    env = wind_env(park, wind_dir, wind_mph, temp, roof)
    park_f = PARK_HR_FACTOR.get(park, park_factor)

    # 6. Due meter
    due_mult = due_meter(d, sc, l14)

    # 7. Raw probability
    raw_prob = max(1.0, min(30.0, base * sc * 3.5 * 100 * pf * env * park_f * due_mult))

    # 8. Market calibration
    if dk_odds is not None:
        mkt_prob  = implied_prob(dk_odds) * 100
        fair_prob = mkt_prob * (1 - HR_VIG)          # strip vig before anchoring + measuring
        if dk_odds <= 250:   w = 0.50
        elif dk_odds <= 400: w = 0.60
        elif dk_odds <= 600: w = 0.65
        elif dk_odds <= 900: w = 0.58
        else:                w = 0.48
        final_prob = w * raw_prob + (1 - w) * fair_prob
    else:
        final_prob = raw_prob * 0.75
        fair_prob  = final_prob

    edge = final_prob - fair_prob

    # 9. Composite score
    gate = 1.0 if final_prob >= 22 else 0.72 if final_prob >= 18 else 0.45 if final_prob >= 14 else 0.20
    ev_val = (final_prob / 100) * (dk_odds / 100 if dk_odds and dk_odds >= 0 else 1.0)
    park_comp_adj = (
        0.80 if park_f <= 0.90 else
        0.90 if park_f <= 0.95 else
        1.05 if park_f <= 1.10 else 1.10
    )
    raw_comp = gate * (0.35 * min(final_prob / 28, 1) + 0.50 * min(max(edge, 0) / 12, 1) + 0.15 * min(ev_val / 0.40, 1))
    composite = raw_comp * park_comp_adj

    # 10. DFS projections
    pa        = PA_TABLE.get(batting_order, 4.0)
    hr_rate   = final_prob / 100
    hit_rate  = base
    single_r  = max(0, hit_rate * 0.55 - hr_rate * 0.55)
    double_r  = hit_rate * 0.19
    triple_r  = hit_rate * 0.01
    bb_r      = max(0.06, min(0.18, (d.get("e3", 95) - 85) * 0.002 + 0.09))
    sb_r      = max(0, (d.get("h3", 0.35) - 0.35) * 0.05)

    runs = RUNS_BY_BO.get(batting_order, 0.43) * pa * 0.75
    rbi  = RBI_BY_BO.get(batting_order, 0.43) * pa * 0.75

    dk_pts = pa * (3*single_r + 5*double_r + 8*triple_r + 10*hr_rate + 2*bb_r + 5*sb_r)
    dk_pts += 2*runs + 2*rbi
    dk_pts *= SCALE

    fd_pts = pa * (3*single_r + 6*double_r + 9*triple_r + 12*hr_rate + 3*bb_r + 3*sb_r)
    fd_pts += 3.2*runs + 3.5*rbi
    fd_pts *= SCALE

    return {
        "batter_name":   name,
        "team":          team,
        "pos":           pos,
        "batting_order": batting_order,
        "game_key":      game_key,
        "game_label":    game_label,
        "home":          is_home,
        "opp_pitcher":   opp_pitcher,
        "park":          park,
        "park_factor":   park_f,
        "wind_dir":      wind_dir,
        "wind_mph":      wind_mph,
        "temp":          temp,
        "weather_flag":  weather_flag,
        "hr_prob":       round(final_prob, 1),
        "hr_edge":       round(edge, 1),
        "sc_score":      round(sc, 3),
        "composite":     round(composite, 4),
        "dk_hr_odds":    dk_odds,
        "dk_salary":     dk_salary,
        "fd_salary":     fd_salary,
        "dk_pts":        round(dk_pts, 2),
        "fd_pts":        round(fd_pts, 2),
        "p_factor":      pf,
        "env":           round(env, 3),
        "due_mult":      round(due_mult, 3),
    }


def apply_game_diversity(results: list) -> list:
    """Discount players from the same game beyond the top-ranked."""
    game_rank = {}
    for r in sorted(results, key=lambda x: -x["composite"]):
        gk = r["game_key"]
        game_rank[gk] = game_rank.get(gk, 0) + 1
        rank = game_rank[gk]
        mult = 1.0 if rank==1 else 0.90 if rank==2 else 0.78 if rank==3 else 0.65 if rank==4 else 0.55
        r["composite"] = round(r["composite"] * mult, 4)
    return results
