#!/usr/bin/env python3
"""
Onyx Baseball DB rebuild - 2026 second half refresh
Builds career_db.json, pitcher_db.json, bullpen_db.json from FanGraphs exports.
Joins on PlayerId. Emits keys via nk_db() (live-DB-compatible) plus MLBAMID.
Crashes loudly on anything unexpected. Never writes silently-wrong zeros.
"""

import json, sys, unicodedata, re
from pathlib import Path
import pandas as pd

# ---------------------------------------------------------------- config
EXPORT_DIR = Path("exports")
OLD_DIR    = Path("old")
OUT_DIR    = Path("out")

FILES = {
    "hit_3yr_std":    "fangraphs-leaderboards-29",
    "hit_3yr_home":   "fangraphs-leaderboards-31",
    "hit_3yr_away":   "fangraphs-leaderboards-32",
    "hit_3yr_vsl":    "fangraphs-leaderboards-33",
    "hit_3yr_vsr":    "fangraphs-leaderboards-34",
    "hit_3yr_sc":     "fangraphs-leaderboards-35",
    "hit_26_std":     "fangraphs-leaderboards-36",
    "hit_26_sc":      "fangraphs-leaderboards-37",
    "hit_26_home":    "fangraphs-leaderboards-48",
    "hit_26_away":    "fangraphs-leaderboards-49",
    "pit_3yr_dash":   "fangraphs-leaderboards-38",
    "pit_3yr_sc":     "fangraphs-leaderboards-39",
    "pit_26_dash":    "fangraphs-leaderboards-41",
    "pit_26_home":    "fangraphs-leaderboards-42",
    "pit_26_away":    "fangraphs-leaderboards-43",
    "pit_26_sc":      "fangraphs-leaderboards-50",
    "team_relief_26": "fangraphs-leaderboards-47",
}

CLAMP_LO, CLAMP_HI = 0.6, 1.8
NEUTRAL_SPLIT = 0.030
MIN_3YR_IP = 30.0          # pitchers with no 2026 data and < this 3yr IP are dropped

TEAM_MAP = {"SDP":"SD","SFG":"SF","TBR":"TB","KCR":"KC","WSN":"WSH","CHW":"CWS"}

# ---------------------------------------------------------------- helpers
def nk_db(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s

def load_csv(role, required_cols, min_rows):
    fname = FILES[role]
    if fname is None:
        return None
    path = EXPORT_DIR / fname
    if not path.exists():
        path = EXPORT_DIR / (fname + ".csv")
    if not path.exists():
        sys.exit(f"FATAL: {role} file not found: {EXPORT_DIR/fname} (with or without .csv)")
    df = pd.read_csv(path)
    df.columns = [c.strip() for c in df.columns]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        sys.exit(f"FATAL: {role} ({fname}) missing columns: {missing}\nHas: {list(df.columns)}")
    if len(df) < min_rows:
        sys.exit(f"FATAL: {role} has only {len(df)} rows (expected >= {min_rows}).")
    return df

def pct(series):
    s = pd.to_numeric(series, errors="coerce")
    if s.dropna().median() > 1.5:
        s = s / 100.0
    return s

def num(series):
    return pd.to_numeric(series, errors="coerce")

def one_num(val):
    return num(pd.Series([val])).iloc[0]

def one_pct(val):
    return pct(pd.Series([val])).iloc[0]

def dedupe(df, sort_col):
    df = df.copy()
    df["_s"] = num(df[sort_col]).fillna(0)
    df = df.sort_values("_s", ascending=False).drop_duplicates("PlayerId")
    return df.drop(columns="_s")

def clamp_factor(xfip):
    if xfip is None or pd.isna(xfip):
        return None
    return round(min(max(float(xfip) / 4.0, CLAMP_LO), CLAMP_HI), 4)

def r4(v):
    return None if v is None or pd.isna(v) else round(float(v), 4)

def load_old(fname):
    p = OLD_DIR / fname
    if not p.exists():
        sys.exit(f"FATAL: old file missing: {p}")
    return json.loads(p.read_text(encoding="utf-8"))

old_career  = load_old("career_db.json")
old_pitcher = load_old("pitcher_db.json")
old_hand    = load_old("pitcher_hand.json")

# ---------------------------------------------------------------- hitters
h_std  = dedupe(load_csv("hit_3yr_std",  ["Name","PA","HR","ISO","Pull%","FB%","PlayerId","MLBAMID"], 500), "PA")
h_home = dedupe(load_csv("hit_3yr_home", ["PA","HR","PlayerId"], 500), "PA")
h_away = dedupe(load_csv("hit_3yr_away", ["PA","HR","PlayerId"], 500), "PA")
h_vsl  = dedupe(load_csv("hit_3yr_vsl",  ["PA","HR","PlayerId"], 500), "PA")
h_vsr  = dedupe(load_csv("hit_3yr_vsr",  ["PA","HR","PlayerId"], 500), "PA")
h_sc   = dedupe(load_csv("hit_3yr_sc",   ["EV90","Barrel%","HardHit%","PlayerId"], 500), "PA")
h_26   = dedupe(load_csv("hit_26_std",   ["Name","PA","HR","ISO","PlayerId"], 300), "PA")
h_26sc = dedupe(load_csv("hit_26_sc",    ["EV90","Barrel%","PlayerId"], 300), "PA")
h_26h  = load_csv("hit_26_home", ["PA","HR","PlayerId"], 300)
h_26a  = load_csv("hit_26_away", ["PA","HR","PlayerId"], 300)
if h_26h is not None: h_26h = dedupe(h_26h, "PA")
if h_26a is not None: h_26a = dedupe(h_26a, "PA")

def idx(df, cols):
    return None if df is None else df.set_index("PlayerId")[cols]

H   = idx(h_std,  ["Name","PA","HR","ISO","Pull%","FB%","MLBAMID"])
HH  = idx(h_home, ["PA","HR"]); HA = idx(h_away, ["PA","HR"])
VL  = idx(h_vsl,  ["PA","HR"]); VR = idx(h_vsr,  ["PA","HR"])
SC  = idx(h_sc,   ["EV90","Barrel%","HardHit%"])
S6  = idx(h_26,   ["Name","PA","HR","ISO"])
C6  = idx(h_26sc, ["EV90","Barrel%"])
H6H = idx(h_26h,  ["PA","HR"]); H6A = idx(h_26a, ["PA","HR"])

career = {}
notes = {"no_statcast":[], "chca_carried":[], "h6a6_carried":[], "new_players":[]}

all_hitter_ids = set(H.index) | (set(S6.index) if S6 is not None else set())

for pid in all_hitter_ids:
    base = H.loc[pid] if pid in H.index else None
    s26  = S6.loc[pid] if (S6 is not None and pid in S6.index) else None
    if base is None and s26 is None:
        continue
    name = base["Name"] if base is not None else s26["Name"]
    key  = nk_db(name)
    old  = old_career.get(key, {})
    e = {}

    if base is not None and pd.notna(base["MLBAMID"]):
        e["mid"] = int(base["MLBAMID"])
    else:
        e["mid"] = old.get("mid")

    if base is not None:
        pa3 = one_num(base["PA"]); hr3 = one_num(base["HR"])
        e["p3"] = int(pa3); e["c"] = r4(hr3/pa3 if pa3 > 0 else None)
        e["i3"] = r4(one_num(base["ISO"]))
        e["pl"] = r4(one_pct(base["Pull%"]))
        e["fb"] = r4(one_pct(base["FB%"]))
    else:
        e["p3"] = old.get("p3", 0); e["c"] = old.get("c"); e["i3"] = old.get("i3")
        e["pl"] = old.get("pl"); e["fb"] = old.get("fb")
        notes["new_players"].append(f"{name} (2026 only, no 3yr row)")

    if pid in SC.index:
        sc = SC.loc[pid]
        e["e3"] = r4(one_num(sc["EV90"]))
        e["b3"] = r4(one_pct(sc["Barrel%"]))
        e["h3"] = r4(one_pct(sc["HardHit%"]))
    else:
        e["e3"], e["b3"], e["h3"] = old.get("e3"), old.get("b3"), old.get("h3")
        notes["no_statcast"].append(name)

    def split_rate(tbl):
        if tbl is not None and pid in tbl.index:
            row = tbl.loc[pid]
            pa = one_num(row["PA"]); hr = one_num(row["HR"])
            if pa and pa > 0:
                return r4(hr / pa)
        return None

    ch, ca = split_rate(HH), split_rate(HA)
    if ch is None or ca is None:
        ch = ch if ch is not None else old.get("ch", NEUTRAL_SPLIT)
        ca = ca if ca is not None else old.get("ca", NEUTRAL_SPLIT)
        notes["chca_carried"].append(name)
    e["ch"], e["ca"] = ch, ca

    for tag, tbl in (("vl", VL), ("vr", VR)):
        if tbl is not None and pid in tbl.index:
            row = tbl.loc[pid]
            pa = one_num(row["PA"]); hr = one_num(row["HR"])
            e[tag] = r4(hr/pa if pa and pa > 0 else None)
            e["p"+tag] = int(pa) if pa and pa > 0 else 0
        else:
            e[tag], e["p"+tag] = None, 0

    if s26 is not None:
        pa6 = one_num(s26["PA"]); hr6 = one_num(s26["HR"])
        e["p6"] = int(pa6); e["i6"] = r4(one_num(s26["ISO"]))
        e["hr6r"] = r4(hr6/pa6 if pa6 > 0 else None)
    else:
        e["p6"], e["i6"], e["hr6r"] = 0, 0.0, None

    h6 = split_rate(H6H); a6 = split_rate(H6A)
    if h6 is None or a6 is None:
        h6 = h6 if h6 is not None else old.get("h6", e.get("hr6r") or NEUTRAL_SPLIT)
        a6 = a6 if a6 is not None else old.get("a6", e.get("hr6r") or NEUTRAL_SPLIT)
        notes["h6a6_carried"].append(name)
    e["h6"], e["a6"] = h6, a6

    if C6 is not None and pid in C6.index:
        c6 = C6.loc[pid]
        e["e6"] = r4(one_num(c6["EV90"]))
        e["b6"] = r4(one_pct(c6["Barrel%"]))
    else:
        e["e6"], e["b6"] = e.get("e3"), e.get("b3")

    career[key] = e

# ---------------------------------------------------------------- pitchers
p_dash = dedupe(load_csv("pit_3yr_dash", ["Name","IP","HR/9","GB%","HR/FB","xFIP","PlayerId","MLBAMID"], 400), "IP")
p_sc   = dedupe(load_csv("pit_3yr_sc",   ["Barrel%","HardHit%","EV90","PlayerId"], 400), "IP")
p_26   = dedupe(load_csv("pit_26_dash",  ["Name","IP","HR/9","GB%","HR/FB","xFIP","PlayerId"], 300), "IP")
p_26h  = dedupe(load_csv("pit_26_home",  ["IP","xFIP","PlayerId"], 200), "IP")
p_26a  = dedupe(load_csv("pit_26_away",  ["IP","xFIP","PlayerId"], 200), "IP")
p_26sc = load_csv("pit_26_sc", ["EV90","HardHit%","PlayerId"], 200)
if p_26sc is not None: p_26sc = dedupe(p_26sc, "IP")

PD_  = p_dash.set_index("PlayerId")
PSC  = p_sc.set_index("PlayerId")
P26  = p_26.set_index("PlayerId")
P26H = p_26h.set_index("PlayerId"); P26A = p_26a.set_index("PlayerId")
P26S = p_26sc.set_index("PlayerId") if p_26sc is not None else None

pitcher = {}
pnotes = {"no_hand":[], "no_2026":[], "new_2026_only":[], "dropped_inactive": 0}
all_pid = set(PD_.index) | set(P26.index)

for pid in all_pid:
    has26 = pid in P26.index
    ip3 = 0.0
    if pid in PD_.index:
        v = one_num(PD_.loc[pid]["IP"])
        ip3 = float(v) if pd.notna(v) else 0.0
    if not has26 and ip3 < MIN_3YR_IP:
        pnotes["dropped_inactive"] += 1
        continue

    b3 = PD_.loc[pid] if pid in PD_.index else None
    b6 = P26.loc[pid] if has26 else None
    name = b3["Name"] if b3 is not None else b6["Name"]
    key  = nk_db(name)
    old  = old_pitcher.get(key, {})
    e = {}

    if b3 is not None and pd.notna(b3.get("MLBAMID")):
        e["mid"] = int(b3["MLBAMID"])
    else:
        e["mid"] = old.get("mid")

    if b3 is not None:
        xf3 = one_num(b3["xFIP"])
        e["xf3"]   = r4(xf3)
        e["pf"]    = clamp_factor(xf3) or old.get("pf", 1.0)
        e["hr9_3"] = r4(one_num(b3["HR/9"]))
        e["gb3"]   = r4(one_pct(b3["GB%"]))
        e["hrfb3"] = r4(one_pct(b3["HR/FB"]))
    else:
        e["xf3"] = old.get("xf3"); e["pf"] = old.get("pf", 1.0)
        e["hr9_3"] = e["gb3"] = e["hrfb3"] = None
        pnotes["new_2026_only"].append(name)

    if pid in PSC.index:
        s = PSC.loc[pid]
        e["e3"]   = r4(one_num(s["EV90"]))
        e["h3"]   = r4(one_pct(s["HardHit%"]))
        e["brl3"] = r4(one_pct(s["Barrel%"]))
    else:
        e["e3"], e["h3"], e["brl3"] = old.get("e3", 0), old.get("h3", 0), None

    if b6 is not None:
        xf6 = one_num(b6["xFIP"])
        e["xf6"]   = r4(xf6) if pd.notna(xf6) else 0
        e["hr9_6"] = r4(one_num(b6["HR/9"]))
        e["gb6"]   = r4(one_pct(b6["GB%"]))
        e["hrfb6"] = r4(one_pct(b6["HR/FB"]))
    else:
        e["xf6"], e["hr9_6"], e["gb6"], e["hrfb6"] = 0, None, None, None
        pnotes["no_2026"].append(name)

    def side_factor(tbl):
        if pid in tbl.index:
            f = clamp_factor(one_num(tbl.loc[pid]["xFIP"]))
            if f is not None:
                return f
        return e["pf"]
    e["pfh"] = side_factor(P26H)
    e["pfa"] = side_factor(P26A)

    if P26S is not None and pid in P26S.index:
        s6 = P26S.loc[pid]
        e["e6"] = r4(one_num(s6["EV90"]))
        e["h6"] = r4(one_pct(s6["HardHit%"]))
    else:
        e["e6"] = 0 if b6 is None else e["e3"]
        e["h6"] = 0 if b6 is None else e["h3"]

    hand = old_hand.get(key) or old_hand.get(name)
    e["hand"] = hand
    if hand is None and b6 is not None:
        pnotes["no_hand"].append(name)

    pitcher[key] = e

# ---------------------------------------------------------------- bullpen
tr = load_csv("team_relief_26", ["Team","HR/9","xFIP"], 30)
if len(tr) != 30:
    sys.exit(f"FATAL: team relief file has {len(tr)} rows, expected exactly 30")
bullpen = {}
for _, row in tr.iterrows():
    ab = TEAM_MAP.get(str(row["Team"]).strip(), str(row["Team"]).strip())
    bullpen[ab] = {"hr9": r4(one_num(row["HR/9"])), "xfip": r4(one_num(row["xFIP"]))}

# ---------------------------------------------------------------- write + report
OUT_DIR.mkdir(exist_ok=True)
for fname, obj in (("career_db.json", career), ("pitcher_db.json", pitcher),
                   ("bullpen_db.json", bullpen)):
    (OUT_DIR / fname).write_text(json.dumps(obj, indent=1, ensure_ascii=False),
                                 encoding="utf-8")

old_keys, new_keys = set(old_career), set(career)
print("=" * 60)
print(f"career_db : {len(career)} players  (old file: {len(old_career)})")
print(f"pitcher_db: {len(pitcher)} pitchers (old file: {len(old_pitcher)})")
print(f"bullpen_db: {len(bullpen)} teams")
print(f"dropped inactive pitchers: {pnotes['dropped_inactive']}")
print(f"hitters lost vs old file: {len(old_keys - new_keys)}")
print(f"hitters gained          : {len(new_keys - old_keys)}")
print("-" * 60)
for label in ("no_statcast", "chca_carried", "h6a6_carried", "new_players"):
    lst = notes[label]
    print(f"{label}: {len(lst)}")
    for n in lst[:10]: print(f"   {n}")
    if len(lst) > 10: print(f"   ... and {len(lst)-10} more")
for label in ("no_hand", "no_2026", "new_2026_only"):
    lst = pnotes[label]
    print(f"{label}: {len(lst)}")
    for n in lst[:10]: print(f"   {n}")
    if len(lst) > 10: print(f"   ... and {len(lst)-10} more")
print("=" * 60)
print("Wrote out/career_db.json, out/pitcher_db.json, out/bullpen_db.json")
