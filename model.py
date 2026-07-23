"""
model.py — Onyx Baseball v19 HR probability model

v19: continuous self-calibration — calibrate.py measures every graded pick
against its stated probability nightly and writes a shrunk global factor
(clamped 0.75-1.25, active at 25+ graded picks) that scales raw
probabilities, so the model keeps tuning itself toward what actually
cashes.

v18: output normalization — raw probabilities shrink toward the league
per-game HR rate (0.8 factor, cap 25 instead of 30) and the market becomes
the blend anchor (model weight 0.30-0.40 by odds band instead of 0.48-0.65).
HR prop markets are efficient; edges now land in the honest 1-5pp range
instead of double digits, and composite gates re-tiered to the compressed
scale.

v17: recency de-weighted across the board — small-sample L14 outcomes were
compounding through four multipliers (batter form, SC quality replacement,
pitcher L14 leg, due meter) and letting one cold pitcher stack a whole
lineup at the top of the board. Form is now reliability-shrunk (PA-based,
capped ±12%/−10%), L14 quality blends with career instead of replacing it
(max 65%), the pitcher L14 leg needs 25+ BF and maxes at 15% weight inside
tighter clamps, and the due meter's range narrows to 0.92–1.18.

v16 changes vs v15:
  - wind_env() rewritten again: adds a per-park PARK_WIND_SENSITIVITY multiplier
    (Wrigley's open-bowl corridor amplifies wind far more than an enclosed park;
    conversely PARK_WIND_NEUTRAL parks — Oracle, Comerica, Petco, Kauffman — have
    swirling/marine or unreliable wind that doesn't translate to real carry, so
    sensitivity is locked to 1.0 there regardless of gauge reading).
  - classify_wind() extracted as its own function — single source of truth for
    "out"/"in"/"cross"/None, exposed on the return dict as "wind_blow" so
    auto_build.py never has to re-derive it from raw wind_dir strings again
    (it was doing that with a check that only matched literal "out"/"in", never
    the compass tokens the weather data actually uses — wind_alignment had been
    silently 0.0 for every game until this).
  - humidity + barometric pressure added to wind_env() as air-density terms:
    humid air is *less* dense (water vapor is lighter than N2/O2, more carry);
    lower pressure is thinner air, also more carry. Both were completely absent
    from the model before, despite being on every weather.json entry.
  - platoon_factor() added: batter-hand vs pitcher-hand adjustment, applied
    independently of the home/away split. Switch hitters get a modest fixed
    edge since they always bat from the favorable side.
  - PARK_HR_FACTOR updated with 2026 venue renames (Daikin Park, Sutter Health
    Park, UNIQLO Field at Dodger Stadium, Rate Field) and blended toward this
    season's measured team-level HR factors where they agree directionally
    with multi-year history. Coors, Busch, Tropicana, and Angel Stadium keep
    their historical values — their 2026 single-team reads look like sample
    noise (one team's home/road split, not a real multi-team park factor).
  - due_score now included in the return dict. It was already being computed
    correctly inside project_player() (an earlier NameError got the placement
    right), but never added to the output — shell.html reads r.due_score and
    was silently getting undefined for every player.

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

# Self-calibration factor written nightly by calibrate.py from graded picks.
# Inactive (1.0) until 25+ picks have settled; always clamped 0.75-1.25.
try:
    with open(_BASE / "data" / "calibration.json") as f:
        _CAL = json.load(f)
    CAL_SCALE = max(0.75, min(1.25, float(_CAL.get("scale", 1.0)))) if _CAL.get("active") else 1.0
    print(f"  model: calibration scale {CAL_SCALE} "
          f"({'active' if _CAL.get('active') else 'collecting'}, n={_CAL.get('n', 0)})")
except Exception:
    CAL_SCALE = 1.0

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

# 2026-blended park HR factors. Where the 2026 team-level distance/factor data
# agreed directionally with multi-year history, blended toward it. Where the
# 2026 read looked like single-team sample noise (Coors, Busch, Tropicana,
# Angel Stadium), historical value kept — revisit once a real multi-team
# composite is available.
PARK_HR_FACTOR = {
    "Coors Field": 1.35,
    "Yankee Stadium": 1.33,
    "Great American Ball Park": 1.31,
    "Daikin Park": 1.24,
    "American Family Field": 1.16,
    "UNIQLO Field at Dodger Stadium": 1.14,
    "Citizens Bank Park": 1.13,
    "PNC Park": 1.04,
    "Citi Field": 1.03,
    "Petco Park": 1.03,
    "Chase Field": 1.02,
    "Rogers Centre": 1.02,
    "Camden Yards": 1.02,
    "Wrigley Field": 1.02,
    "Globe Life Field": 1.00,
    "Comerica Park": 1.00,
    "loanDepot Park": 0.98,
    "Nationals Park": 0.97,
    "Tropicana Field": 0.96,
    "Rate Field": 0.90,
    "Sutter Health Park": 1.05,
    "Kauffman Stadium": 0.92,
    "Busch Stadium": 0.92,
    "Target Field": 0.90,
    "Fenway Park": 0.88,
    "Truist Park": 0.88,
    "Progressive Field": 0.88,
    "Angel Stadium": 0.87,
    "Oracle Park": 0.83,
    "Oakland Coliseum": 0.94,  # legacy key, kept in case any archived data still references it
}

PARK_OUT = {
    "Wrigley Field":                 ["S","SSW","SSE","SW","WSW","W","WNW","SE"],
    "Citizens Bank Park":            ["SW","WSW","W","WNW","NW","SSW","S"],
    "Oracle Park":                   ["E","SE","ESE","SSE","NE"],
    "Great American Ball Park":      ["SW","S","SSW","W","WSW","SSE","SE"],
    "Yankee Stadium":                ["SW","SSW","S","WSW","W"],
    "Fenway Park":                   ["SW","SSW","W","WSW","S"],
    "Globe Life Field":              ["S","SSW","SW","SSE","SE"],
    "Truist Park":                   ["SW","W","WSW","S","SSW","SSE"],
    "Busch Stadium":                 ["SW","SSW","S","W","WSW","NW"],
    "Target Field":                  ["S","SSW","SW","SSE","SE"],
    "Coors Field":                   ["SW","S","SSW","W","WSW","NW","SSE"],
    "UNIQLO Field at Dodger Stadium":["S","SW","SSW","SSE","SE"],
    "Petco Park":                    ["SW","WSW","W","SSW","S"],
    "Comerica Park":                 ["SW","SSW","S","W","WSW"],
    "PNC Park":                      ["SW","S","SSW","W","WSW"],
    "Kauffman Stadium":              ["S","SW","SSW","SSE","SE"],
    "Nationals Park":                ["S","SW","SSW","SSE","SE"],
    "T-Mobile Park":                 ["S","SW","SSW","SSE","SE"],
    "Progressive Field":             ["SW","S","SSW","W","WSW"],
    "Angel Stadium":                 ["SW","S","SSW","W","SSE"],
    "Citi Field":                    ["SW","SSW","S","W","WSW"],
    "loanDepot Park":                ["SE","SSE","E","ESE","S"],
    "American Family Field":         ["S","SW","SSW","SE","SSE"],
    "Camden Yards":                  ["SW","SSW","S","W","WSW"],
    "Tropicana Field":               ["S","SW","SSW","SE","SSE"],
    "Rate Field":                    ["S","SW","SSW","SE","SSE"],
    "Daikin Park":                   ["S","SW","SSW","SE","SSE"],
    "Chase Field":                   ["S","SW","SSW","SE","SSE"],
}
PARK_IN = {
    "Wrigley Field":                 ["N","NNE","NE","ENE","NNW","NW"],
    "Citizens Bank Park":            ["NE","ENE","E","N","NNE"],
    "Great American Ball Park":      ["N","NE","NNE","E","ENE","NNW"],
    "Oracle Park":                   ["W","NW","WNW","SW","NNW"],
    "Yankee Stadium":                ["N","NE","NNE","ENE","NNW"],
    "Fenway Park":                   ["N","NE","NNE","ENE","NNW"],
    "Comerica Park":                 ["W","NW","WNW","N","NNW","E"],
    "Busch Stadium":                 ["NE","ENE","E","NNE","N"],
    "Target Field":                  ["N","NNW","NW","NNE","NE"],
    "Coors Field":                   ["NE","ENE","E","NNE","N"],
    "UNIQLO Field at Dodger Stadium":["N","NNW","NW","NE","NNE"],
    "Petco Park":                    ["NE","ENE","E","NNE","N"],
    "Kauffman Stadium":              ["N","NNE","NE","NNW","NW"],
    "PNC Park":                      ["N","NE","NNE","NNW","NW"],
    "Citi Field":                    ["N","NE","NNE","NNW","NW"],
    "Nationals Park":                ["N","NE","NNE","NNW","NW"],
    "Truist Park":                   ["N","NE","NNE","NNW","NW"],
    "Camden Yards":                  ["N","NE","NNE","ENE","NNW"],
    "T-Mobile Park":                 ["N","NNW","NW","NNE","NE"],
    "Progressive Field":             ["N","NE","NNE","ENE","NNW"],
    "Angel Stadium":                 ["N","NNW","NW","NNE","NE"],
}

# Parks with no reliable wind corridor — swirling/marine wind, deep power
# alleys, or a track record of gauge readings not translating to carry.
# Oracle is the clearest case: bay wind reads strong on paper but the
# suppression there comes from cold/dense air and fence depth, not wind
# direction — giving it a sensitivity multiplier would move the model the
# wrong way on exactly the days it looks most tempting to.
PARK_WIND_NEUTRAL = {"Oracle Park", "Comerica Park", "Petco Park", "Kauffman Stadium"}

# Parks where wind direction genuinely swings HR rate more than a typical
# enclosed park — open bowls, shallow fences, corridor effects.
PARK_WIND_SENSITIVITY = {
    "Wrigley Field": 1.75,
    "Great American Ball Park": 1.20,
    "Coors Field": 1.15,
    "Citizens Bank Park": 1.10,
}

# ── HELPERS ────────────────────────────────────────────────────────────────────
def implied_prob(american_odds: int) -> float:
    if american_odds >= 0:
        return 100 / (100 + american_odds)
    return abs(american_odds) / (abs(american_odds) + 100)

def classify_wind(park: str, wind_dir: str, wind_mph: float):
    """'out' / 'in' / 'cross' / None. Single source of truth — wind_env() uses
    this internally, and project_player() exposes the result on the return
    dict so auto_build.py never has to re-derive it from raw strings."""
    wd = str(wind_dir or "").strip().lower()
    mph = float(wind_mph or 0)
    if wd.startswith("out"): return "out"
    if wd.startswith("in"):  return "in"
    if wd in ("l-r", "r-l", "cross", "across"): return "cross"
    if wd == "calm": return None
    if park in PARK_OUT and wind_dir in PARK_OUT[park]: return "out"
    if park in PARK_IN and wind_dir in PARK_IN.get(park, []): return "in"
    return "cross" if mph >= 8 else None

def wind_env(park: str, wind_dir: str, wind_mph: float, temp: float, roof: bool,
             humidity: float = 50.0, pressure_mb: float = 1013.0) -> float:
    """
    HR environment factor from wind + temp + humidity + pressure. Roof = flat 1.0.
    Wind term is scaled by PARK_WIND_SENSITIVITY (or locked to neutral for parks
    with no reliable corridor). Temp/humidity/pressure model air density and
    apply everywhere wind doesn't, including PARK_WIND_NEUTRAL parks.
    """
    if roof:
        return 1.0
    mph = min(float(wind_mph or 0), 25)
    blow = classify_wind(park, wind_dir, mph)
    sensitivity = 1.0 if park in PARK_WIND_NEUTRAL else PARK_WIND_SENSITIVITY.get(park, 1.0)

    env = 1.0
    if   blow == "out":   env += 0.010 * mph * sensitivity      # ~+0.15 at 15mph straight out, unscaled park
    elif blow == "in":    env -= 0.008 * mph * sensitivity
    elif blow == "cross": env += 0.002 * mph * sensitivity

    env += (temp - 72) * 0.0025            # warm air is thinner, more carry
    env += (humidity - 50) * 0.0006        # humid air is *less* dense than dry air
    env += (1013 - pressure_mb) * 0.00015  # lower pressure = thinner air, more carry

    return max(0.78, min(1.35, env))

def platoon_factor(batter_hand: str, pitcher_hand: str) -> float:
    """Batter-vs-pitcher-hand adjustment, independent of the home/away split.
    Switch hitters get a modest fixed edge since they always bat from the
    favorable side — smaller than a true opposite-hand matchup since we don't
    have their actual split-specific rate, just the general handedness tendency."""
    bh = str(batter_hand or "R").upper()
    ph = str(pitcher_hand or "R").upper()
    if bh == "S":
        return 1.03
    if bh == ph:
        return 0.93
    return 1.07

def sc_score(d: dict, l14: dict = None) -> float:
    """
    Statcast quality score. Prefers LIVE L14 Statcast (real barrel%/EV90/hardhit
    from statcast_l14.json) when present; falls back to baked-in career fields.
    """
    def _raw(b, h, e, i):
        r = (0.35*(b/0.085) + 0.25*(h/0.40) + 0.25*((e-85)/20) + 0.15*(i/0.165))
        return max(0.60, min(1.35, r))

    # career quality is the anchor
    car_pa = d.get("p3", 0) or 0
    car_raw = _raw(d.get("b3", 0.085) or 0.085, d.get("h3", 0.40) or 0.40,
                   d.get("e3", 95) or 95, d.get("i3", 0.165) or 0.165)
    car_conf = min(car_pa / 400.0, 1.0)
    career_sc = car_conf * car_raw + (1 - car_conf) * 0.90

    # L14 quality NUDGES the career anchor, never replaces it (max 65%)
    if l14 and l14.get("l14_pa", 0) >= 15:
        pa = l14.get("l14_pa", 0) or 0
        l14_raw = _raw(l14.get("l14_barrel_pct", 0.085) or 0.085,
                       l14.get("l14_hh_pct", 0.40) or 0.40,
                       l14.get("l14_avg_ev", 95) or 95,
                       l14.get("l14_iso", 0.165) or 0.165)
        w = min(pa / 120.0, 0.65)
        return w * l14_raw + (1 - w) * career_sc
    return career_sc

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

    # L14 pitcher HR rate is 2-3 starts of outcome noise: it nudges the
    # career/season factor only with a real sample, tight clamps, max 15%
    if l14_pitchers and pk in l14_pitchers:
        l14 = l14_pitchers[pk]
        bf = l14.get("l14_bf", 0)
        if bf >= 25:
            hr_rate = l14.get("l14_hr_rate", 0.03)
            l14_pf = max(0.75, min(1.30, hr_rate / 0.033))
            w = min(bf / 150, 0.15)
            base_pf = (1 - w) * base_pf + w * l14_pf

    return round(base_pf, 3)

def due_meter(d: dict, sc: float, l14: dict = None) -> float:
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
    if due_score > 1.2:   return 1.18
    if due_score > 0.6:   return 1.10
    if due_score > 0.15:  return 1.04
    if due_score > -0.15: return 1.00
    if due_score > -0.6:  return 0.98
    if due_score > -1.2:  return 0.95
    return 0.92

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
    humidity: float = 50.0,
    pressure_mb: float = 1013.0,
    batter_hand: str = "R",
    opp_pitcher_hand: str = "R",
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

    # 2. L14 form adjustment — reliability-shrunk. HR/PA needs ~170 PA to
    # stabilize; a 50-PA window is mostly noise, so the observed ratio is
    # regressed toward 1.0 by sample size and capped tight.
    if l14 and l14.get("l14_pa", 0) >= 20 and base > 0:
        l14_pa_f = l14.get("l14_pa", 0) or 0
        ratio = max(0.5, min(1.8, l14["l14_rate"] / base))
        rel = l14_pa_f / (l14_pa_f + 130.0)
        form_adj = max(0.90, min(1.12, 1.0 + (ratio - 1.0) * rel))
        base = base * form_adj

    # 3. SC score (prefers live L14 Statcast)
    sc = sc_score(d, l14)

    # 4. Pitcher factor
    pf = pitcher_factor(opp_pitcher, l14_pitchers, is_home_pitcher=not is_home)

    # 5. Park + weather environment
    env = wind_env(park, wind_dir, wind_mph, temp, roof, humidity=humidity, pressure_mb=pressure_mb)
    park_f = PARK_HR_FACTOR.get(park, park_factor)

    # 6. Due meter
    due_mult = due_meter(d, sc, l14)
    _dpa = (l14 or {}).get("l14_pa", 0) or 0
    _dhr = (l14 or {}).get("l14_hr", 0) or 0
    _drate = d.get("c", 0.038) or 0.038
    due_score = ((_drate * _dpa) - _dhr) * sc if _dpa >= 20 else 0.0

    # 6b. Platoon factor (batter hand vs pitcher hand — independent of home/away split)
    plat = platoon_factor(batter_hand, opp_pitcher_hand)

    # 7. Raw probability, then shrink toward the league per-game HR rate.
    # The multiplier chain can stack good-but-correlated signals into
    # implausible territory; deviations from league average compress 20%
    # and the ceiling drops to 25.
    raw_prob = max(1.0, min(30.0, base * sc * 3.5 * 100 * pf * env * park_f * due_mult * plat))
    LEAGUE_GAME_HR = 12.5
    raw_prob = max(1.0, min(25.0, LEAGUE_GAME_HR + (raw_prob - LEAGUE_GAME_HR) * 0.8))
    # v19: nightly self-calibration from graded picks
    raw_prob = max(1.0, min(25.0, raw_prob * CAL_SCALE))

    # 8. Market calibration — the market is the anchor. HR props are priced
    # efficiently, so the model LEANS off the fair price rather than
    # overruling it; honest edges live in the 1-5pp range.
    if dk_odds is not None:
        mkt_prob  = implied_prob(dk_odds) * 100
        fair_prob = mkt_prob * (1 - HR_VIG)          # strip vig before anchoring + measuring
        if dk_odds <= 250:   w = 0.35
        elif dk_odds <= 400: w = 0.38
        elif dk_odds <= 600: w = 0.38
        elif dk_odds <= 900: w = 0.34
        else:                w = 0.30
        final_prob = w * raw_prob + (1 - w) * fair_prob
    else:
        final_prob = raw_prob * 0.75
        fair_prob  = final_prob

    edge = final_prob - fair_prob

    # 9. Composite score (gates re-tiered for the v18 compressed scale)
    gate = 1.0 if final_prob >= 19 else 0.72 if final_prob >= 16 else 0.45 if final_prob >= 13 else 0.20
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
        "wind_blow":     classify_wind(park, wind_dir, wind_mph),
        "platoon_factor": round(plat, 3),
        "due_mult":      round(due_mult, 3),
        "due_score":     round(due_score, 3),
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
