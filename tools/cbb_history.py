#!/usr/bin/env python3
"""Dev-only: build the men's college basketball (D1) HISTORY data layer.

  python3 tools/cbb_history.py [all|teams|players|games|map|ats] [--cache DIR]
                               [--first 2008] [--last 2027]

Writes compact JSON under data/cbb/history/. Raw downloads are cached in
--cache (default: $TMPDIR/onyx_cbb_cache) so reruns only fetch what is new.
Season labels follow Torvik: 2026 = the 2025-26 season (ended spring 2026).
2027 = the season starting Nov 2026 (Torvik preseason ratings, few or no
player rows yet).

Sources
-------
1. Bart Torvik team seasons  https://barttorvik.com/{YEAR}_team_results.json
   JSON list of 45-element lists. Column mapping VERIFIED against 2024
   Connecticut (37-3, adjOE 127.97, adjDE 91.27, barthag .980, adjT 64.6),
   Purdue and Houston:
     0 rank (T-Rank, by barthag)   1 team          2 conf      3 record "W-L"
     4 adj_o                       5 adj_o rank    6 adj_d     7 adj_d rank
     8 barthag                     9 barthag rank  10/11 W/L   12/13 conf W/L
     14 conf record "W-L"          41 WAB (UConn 11.2, Purdue 10.6)
     44 adjusted tempo (UConn 64.6, Houston 63.4, Purdue 67.1)
   Others (15-40, 42-43) are four-factor / SOS / projection fields we skip.
   2027 at fetch time is a preseason projection (record "0-0", 10/11
   projected W/L), kept as-is.

2. Torvik player seasons  https://barttorvik.com/getadvstats.php?year=Y&csv=1
   CSV, no header, 67 columns (same width 2008-2027). VERIFIED with 2024 Zach
   Edey (Purdue: 39 GP, Min% 79.2, ORtg 128.8, usage 33.4, 25.2 ppg,
   12.2 rpg, 2.0 apg, 32.0 mpg, draft pick 9, Sr, 7-4) and Dalton Knecht
   (21.6 ppg, pick 17):
     0 name   1 team   2 conf   3 GP   4 Min%   5 ORtg   6 usage   7 eFG
     8 TS%    9 OR%    10 DR%   11 AST%  12 TO%  13 FTM  14 FTA  15 FT%
     16 2PM   17 2PA   18 2P%   19 3PM   20 3PA  21 3P%   22 BLK%  23 STL%
     24 FT rate (FTA/FGA*100)   25 class (Fr/So/Jr/Sr)   26 height "6-9"
     27 jersey   28 PORPAG   29 adjOE   30 fouls/40 (pfr)   31 year
     32 player id (stable across seasons; Knecht 75441 at N. Colorado 2023
        and Tennessee 2024)  33 hometown  34 recruit rating  35 ast/tov
     36/37 rim made/att  38/39 mid made/att  40 rim%  41 mid%
     42/43 dunks made/att  44 dunk%  45 NBA draft pick  46 DRtg  47 adj DRtg
     48 DPORPAG  49 stops  50 BPM  51 OBPM  52 DBPM  53 GBPM  54 mpg
     55 OGBPM  56 DGBPM  57 orb/g  58 drb/g  59 reb/g  60 ast/g  61 stl/g
     62 blk/g  63 pts/g  64 role ("C", "Wing G", "Combo G", ...)
     65 unverified (skipped)  66 birth date
   Derived: 3PA rate = 3PA / (2PA + 3PA).

3. ESPN games + closing lines (2024-25 and 2025-26 = seasons 2025, 2026)
   Scoreboard: site.api.espn.com/.../scoreboard?dates=YYYYMMDD&groups=50
   &limit=400 (groups=50 = all D1; without it ESPN returns only ~6 games).
   The scoreboard carries NO odds for past dates and the summary's
   pickcenter is empty for them (and the summary is ~350 KB), so lines come
   from the core API .../events/{id}/competitions/{id}/odds (~13 KB). We use
   the first provider whose name does not contain "Live"; its top-level
   `spread` / `overUnder` equal its `close` values and `spread` is from the
   HOME team's perspective (verified: details "ISU -5.5", Iowa State home,
   homeTeamOdds.favorite true, spread -5.5). Opening spread comes from
   homeTeamOdds.open.pointSpread.

ATS grading: home covers when (home - away) + spread_home > 0, push at 0.
Favorite = side with the negative spread (pick'em = no favorite).
Over when home + away > total. Only D1-vs-anything FINAL games with a
spread are graded; per-team records count from that team's side.

Measured 2026-11-02: every stored closing spread and total is a half point
(provider mix: ESPN BET ~58%, DraftKings ~42% of lined games), so there are
no pushes in either season. ~8% of final games (mostly vs non-D1 or low-
major openers) have no line.

Outputs (data/cbb/history/)
  teams.json              {season: [{team, conf, rec, adj_o, adj_d, adj_em, tempo, barthag, wab, rank}]}
  players_{Y}.json        {"cols": PCOLS, "rows": [[...]]}  one row per player-team-season
  player_index.json       {"cols", "teams": [names], "players": {pid: [name, [yy, team_idx, min%, usage, ortg, class], ...]}}
  transfers_{Y}.json      team in Y differs from the player's latest earlier season (Y-1, or
                          Y-2 for pre-2021 sit-out transfers; `gap` says which)
  games_{S}.json          S = 2025 (2024-25), 2026 (2025-26); final games incl. non-lined
  team_map.json           {espn_id: {abbr, espn, torvik}}
  ats.json                {"league": {S: ...}, "teams": {S: {torvik_name: {...}}}}; records are "W-L-P"

Team names differ between Torvik and ESPN; team_map.json maps every ESPN
team (from the D1 team list plus every team seen in a lined game) to its
Torvik name via normalization ("State" -> "St.") plus the ALIASES table.
"""
import argparse, csv, io, json, os, re, sys, tempfile, time, unicodedata
import urllib.error, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cbb" / "history"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball"
WORKERS = 6
GAME_SEASONS = (2025, 2026)

# ESPN `location` -> Torvik name, where normalization alone fails.
ALIASES = {
    "American University": "American", "App State": "Appalachian St.",
    "California Baptist": "Cal Baptist", "UConn": "Connecticut",
    "Florida International": "FIU", "Grambling": "Grambling St.",
    "IU Indianapolis": "IU Indy", "UIC": "Illinois Chicago",
    "Kansas City": "UMKC", "LSU New Orleans": "New Orleans",
    "Long Island University": "LIU", "Loyola Maryland": "Loyola MD",
    "McNeese": "McNeese St.", "Miami": "Miami FL", "Ole Miss": "Mississippi",
    "Omaha": "Nebraska Omaha", "Nicholls": "Nicholls St.",
    "Pennsylvania": "Penn", "SE Louisiana": "Southeastern Louisiana",
    "Sam Houston": "Sam Houston St.", "San José State": "San Jose St.",
    "Seattle U": "Seattle", "South Carolina Upstate": "USC Upstate",
    "Texas A&M-Corpus Christi": "Texas A&M Corpus Chris",
    "UAlbany": "Albany", "UL Monroe": "Louisiana Monroe",
    "UT Martin": "Tennessee Martin", "Hawai'i": "Hawaii",
    "Miami (OH)": "Miami OH", "St. Francis (PA)": "Saint Francis",
    "Saint Francis": "Saint Francis", "Southern Miss": "Southern Miss",
    "UT Rio Grande Valley": "UT Rio Grande Valley", "Purdue Fort Wayne": "Purdue Fort Wayne",
    "Texas A&M-Commerce": "Texas A&M Commerce", "East Texas A&M": "Texas A&M Commerce",
    "St. Thomas-Minnesota": "St. Thomas", "St. Thomas (MN)": "St. Thomas",
    "Loyola Chicago": "Loyola Chicago", "Prairie View A&M": "Prairie View A&M",
    "Arkansas-Pine Bluff": "Arkansas Pine Bluff", "Bethune-Cookman": "Bethune Cookman",
    "Gardner-Webb": "Gardner Webb", "Maryland-Eastern Shore": "Maryland Eastern Shore",
    "Little Rock": "Little Rock", "UT Arlington": "UT Arlington",
    "Southern": "Southern", "Detroit Mercy": "Detroit Mercy",
    "N.C. State": "N.C. State", "NC State": "N.C. State",
    "Queens University": "Queens", "Queens": "Queens",
    "Central Connecticut": "Central Connecticut", "SIU Edwardsville": "SIU Edwardsville",
    "Southern Indiana": "Southern Indiana", "Lindenwood": "Lindenwood",
    "Le Moyne": "Le Moyne", "Stonehill": "Stonehill", "Mercyhurst": "Mercyhurst",
    "West Georgia": "West Georgia", "New Haven": "New Haven",
}


# ---------------------------------------------------------------- http
def get(url, cache_file=None, tries=6, allow_404=False):
    """GET with cache, retry on 429/5xx/network errors. Returns bytes or None (404)."""
    if cache_file and cache_file.exists():
        b = cache_file.read_bytes()
        return None if b == b"__404__" else b
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404 and allow_404:
                b = None
                break
            if e.code in (429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(2 ** i)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if i == tries - 1:
                raise
            time.sleep(2 ** i)
    if cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(b"__404__" if b is None else b)
    return b


def pmap(fn, items):
    with ThreadPoolExecutor(WORKERS) as ex:
        return list(ex.map(fn, items))


def dump(name, obj):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / name
    p.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    print(f"  wrote {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.0f} KB")


def r1(x, nd=1):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if v == v else None


def num(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- torvik teams
def torvik_teams(years, cache):
    def one(y):
        b = get(f"https://barttorvik.com/{y}_team_results.json", cache / f"torvik_team_{y}.json", allow_404=True)
        return y, (json.loads(b) if b else None)
    out = {}
    for y, rows in pmap(one, years):
        if not rows:
            print(f"  teams {y}: not available")
            continue
        lst = []
        for r in rows:
            o, d = float(r[4]), float(r[6])
            lst.append({"team": r[1], "conf": r[2], "rec": r[3], "adj_o": round(o, 1),
                        "adj_d": round(d, 1), "adj_em": round(o - d, 1),
                        "tempo": r1(r[44]), "barthag": r1(r[8], 4), "wab": r1(r[41]),
                        "rank": int(r[0])})
        lst.sort(key=lambda t: t["rank"])
        out[str(y)] = lst
        print(f"  teams {y}: {len(lst)}")
    return out


# ---------------------------------------------------------------- torvik players
def player_row(r):
    pa2, pa3 = num(r[17]) or 0, num(r[20]) or 0
    row = {
        "pid": num(r[32]), "n": r[0], "t": r[1], "c": r[2], "gp": num(r[3]),
        "min": r1(r[4]), "mpg": r1(r[54]), "ortg": r1(r[5]), "usg": r1(r[6]),
        "efg": r1(r[7]), "ts": r1(r[8]), "orb": r1(r[9]), "drb": r1(r[10]),
        "ast": r1(r[11]), "tov": r1(r[12]), "blk": r1(r[22]), "stl": r1(r[23]),
        "ftr": r1(r[24]), "tpr": round(100 * pa3 / (pa2 + pa3), 1) if pa2 + pa3 else None,
        "tp": r1(r[21], 3), "ft": r1(r[15], 3),
        "ppg": r1(r[63]), "rpg": r1(r[59]), "apg": r1(r[60]),
        "cls": r[25] or None, "ht": r[26] or None,
        "porpag": r1(r[28], 2), "bpm": r1(r[50]), "obpm": r1(r[51]), "dbpm": r1(r[52]),
        "role": r[64] or None,
    }
    return {k: v for k, v in row.items() if v is not None}


def torvik_players(years, cache):
    def one(y):
        b = get(f"https://barttorvik.com/getadvstats.php?year={y}&csv=1", cache / f"torvik_pl_{y}.csv", allow_404=True)
        return y, b
    seasons = {}
    for y, b in pmap(one, years):
        if not b:
            print(f"  players {y}: not available")
            continue
        rows = [r for r in csv.reader(io.StringIO(b.decode("utf-8", "replace"))) if len(r) >= 65]
        lst = [player_row(r) for r in rows]
        lst = [p for p in lst if p.get("pid") is not None]
        lst.sort(key=lambda p: (p["t"], -(p.get("min") or 0)))
        seasons[y] = lst
    return seasons


PCOLS = ["pid", "n", "t", "c", "gp", "min", "mpg", "ortg", "usg", "efg", "ts", "orb", "drb",
         "ast", "tov", "blk", "stl", "ftr", "tpr", "tp", "ft", "ppg", "rpg", "apg", "cls", "ht",
         "porpag", "bpm", "obpm", "dbpm", "role"]


def write_players(seasons):
    # Column-array layout ({"cols": [...], "rows": [[...]]}) roughly halves the
    # size versus one object per player (~0.9 MB per season instead of ~1.7 MB).
    for y, lst in sorted(seasons.items()):
        dump(f"players_{y}.json", {"cols": PCOLS, "rows": [[p.get(k) for k in PCOLS] for p in lst]})
        print(f"    players {y}: {len(lst)} rows")
    # player_index: arrays + interned team names, season as yy, min% and ORtg
    # rounded to integers, to stay under ~3 MB (full precision is in players_Y).
    teams = sorted({p["t"] for lst in seasons.values() for p in lst})
    tix = {t: i for i, t in enumerate(teams)}
    idx, names = defaultdict(list), {}
    for y, lst in sorted(seasons.items()):
        for p in lst:
            mn, og = p.get("min"), p.get("ortg")
            idx[str(p["pid"])].append([y - 2000, tix[p["t"]], None if mn is None else round(mn),
                                       p.get("usg"), None if og is None else round(og), p.get("cls")])
            names[str(p["pid"])] = p["n"]
    dump("player_index.json", {
        "cols": ["season_minus_2000", "team_idx", "min_pct", "usage", "ortg", "class"],
        "teams": teams,
        "players": {pid: [names[pid]] + rows for pid, rows in idx.items()},
    })
    print(f"    player_index: {len(idx)} players, {sum(len(v) for v in idx.values())} player-seasons")
    # transfers_{Y}: team in Y differs from the player's most recent EARLIER season
    # (Y-1, or Y-2 to catch pre-2021 sit-out-a-year transfers; gap says which).
    for y in sorted(seasons):
        prev = {}
        for back in (2, 1):  # Y-1 overwrites Y-2
            for p in seasons.get(y - back, []):
                o = prev.get(p["pid"])
                if o is None or o[0] != y - back or (p.get("min") or 0) > (o[1].get("min") or 0):
                    prev[p["pid"]] = (y - back, p)
        if not prev:
            continue
        moves = []
        for p in seasons[y]:
            if p["pid"] not in prev:
                continue
            py, o = prev[p["pid"]]
            if o["t"] == p["t"]:
                continue
            moves.append({"pid": p["pid"], "n": p["n"], "from": o["t"], "to": p["t"],
                          "from_conf": o["c"], "to_conf": p["c"], "cls": p.get("cls"), "gap": y - py,
                          "prev": {"s": py, "min": o.get("min"), "usg": o.get("usg"), "ortg": o.get("ortg"), "bpm": o.get("bpm")},
                          "now": {"min": p.get("min"), "usg": p.get("usg"), "ortg": p.get("ortg"), "bpm": p.get("bpm")}})
        moves.sort(key=lambda m: -(m["prev"].get("min") or 0))
        dump(f"transfers_{y}.json", moves)
        print(f"    transfers {y}: {len(moves)} ({sum(1 for m in moves if m['gap'] == 2)} after a sit-out year)")


# ---------------------------------------------------------------- espn games
def season_dates(season):
    d, end = date(season - 1, 11, 1), date(season, 4, 10)
    while d <= end:
        yield d
        d += timedelta(days=1)


def scoreboard_day(args):
    d, cache = args
    ds = d.strftime("%Y%m%d")
    cf = cache / "espn_sb" / f"{ds}.json"
    if cf.exists():
        return json.loads(cf.read_text())
    b = get(f"{ESPN}/scoreboard?dates={ds}&groups=50&limit=400")
    games = []
    for e in json.loads(b).get("events", []):
        c = e["competitions"][0]
        st = c["status"]["type"]
        side = {}
        for t in c["competitors"]:
            tm = t["team"]
            side[t["homeAway"]] = {"id": tm.get("id"), "abbr": tm.get("abbreviation"),
                                   "name": tm.get("displayName"), "loc": tm.get("location"),
                                   "score": num(t.get("score"))}
        if "home" not in side or "away" not in side:
            continue
        games.append({"id": e["id"], "date": ds, "final": st.get("name") == "STATUS_FINAL",
                      "neutral": bool(c.get("neutralSite")), "conf": bool(c.get("conferenceCompetition")),
                      "type": (c.get("type") or {}).get("abbreviation"),
                      "home": side["home"], "away": side["away"]})
    cf.parent.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(games))
    return games


def game_odds(args):
    gid, cache = args
    b = get(f"{CORE}/events/{gid}/competitions/{gid}/odds", cache / "espn_odds" / f"{gid}.json", allow_404=True)
    if not b:
        return gid, None
    items = json.loads(b).get("items", [])
    items = [i for i in items if "live" not in (i.get("provider", {}).get("name") or "").lower()] or items
    for it in items:
        sp, tot = it.get("spread"), it.get("overUnder")
        if sp is None and tot is None:
            continue
        op = None
        try:
            op = float(it["homeTeamOdds"]["open"]["pointSpread"]["american"])
        except (KeyError, TypeError, ValueError):
            pass
        fav = (it.get("homeTeamOdds") or {}).get("favorite")
        return gid, {"spread": sp, "total": tot, "open": op, "home_fav": fav, "details": it.get("details")}
    return gid, None


def pull_games(season, cache):
    days = list(season_dates(season))
    t0 = time.time()
    games = [g for day in pmap(scoreboard_day, [(d, cache) for d in days]) for g in day]
    seen, uniq = set(), []
    for g in games:
        if g["id"] not in seen:
            seen.add(g["id"])
            uniq.append(g)
    fin = [g for g in uniq if g["final"]]
    print(f"  season {season}: {len(days)} scoreboards, {len(uniq)} events, {len(fin)} final ({time.time() - t0:.0f}s)")
    t0 = time.time()
    odds = dict(pmap(game_odds, [(g["id"], cache) for g in fin]))
    print(f"    odds fetched for {len(fin)} games ({time.time() - t0:.0f}s), {sum(1 for v in odds.values() if v)} with a line")
    rows, sign_bad = [], 0
    for g in fin:
        o = odds.get(g["id"]) or {}
        sp = o.get("spread")
        if sp is not None and o.get("home_fav") is not None and sp != 0:
            if (sp < 0) != bool(o["home_fav"]):
                sign_bad += 1
        h, a = g["home"], g["away"]
        rows.append({"d": g["date"], "id": g["id"],
                     "h": h["abbr"], "hn": h["name"], "hid": h["id"], "hs": h["score"],
                     "a": a["abbr"], "an": a["name"], "aid": a["id"], "as": a["score"],
                     "sp": sp, "sp_open": o.get("open"), "tot": o.get("total"),
                     "neu": 1 if g["neutral"] else 0, "cg": 1 if g["conf"] else 0})
    print(f"    spread sign vs favorite flag disagreements: {sign_bad}")
    return rows, {g["home"]["id"]: g["home"] for g in fin} | {g["away"]["id"]: g["away"] for g in fin}


# ---------------------------------------------------------------- team map
def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"\bState\b", "St.", s)
    return re.sub(r"[^a-z0-9]", "", s.lower().replace("&", "and"))


def build_map(cache, torvik_names, extra_teams):
    b = get(f"{ESPN}/teams?groups=50&limit=500", cache / "espn_teams.json")
    d1 = {t["team"]["id"]: t["team"] for t in json.loads(b)["sports"][0]["leagues"][0]["teams"]}
    tv = {norm(n): n for n in torvik_names}
    out, miss = {}, []
    teams = {i: {"abbr": t["abbreviation"], "name": t["displayName"], "loc": t["location"], "d1list": 1}
             for i, t in d1.items()}
    for i, t in extra_teams.items():
        teams.setdefault(i, {"abbr": t["abbr"], "name": t["name"], "loc": t.get("loc") or t["name"], "d1list": 0})
    for i, t in teams.items():
        loc = t["loc"]
        name = ALIASES.get(loc)
        if name not in torvik_names:
            name = tv.get(norm(loc)) or tv.get(norm(ALIASES.get(loc, "")))
        if name:
            out[i] = {"abbr": t["abbr"], "espn": t["name"], "torvik": name}
        elif t["d1list"]:
            miss.append(t)
        else:
            out[i] = {"abbr": t["abbr"], "espn": t["name"], "torvik": None}
    return out, miss, d1


# ---------------------------------------------------------------- ats
def rec():
    return {"w": 0, "l": 0, "p": 0}


def tally(r, v):
    r["w" if v > 0 else "l" if v < 0 else "p"] += 1


def build_ats(game_seasons, tmap):
    out = {"league": {}, "teams": {}}
    for season, rows in game_seasons.items():
        L = {"games": 0, "home_cover": rec(), "fav_cover": rec(), "over": rec(), "neutral_excluded_home": True}
        teams = defaultdict(lambda: {"ats": rec(), "fav": rec(), "dog": rec(), "home": rec(), "away": rec(),
                                     "neutral": rec(), "ou": rec(), "cm_sum": 0.0, "n": 0})
        for g in rows:
            if g["sp"] is None or g["hs"] is None or g["as"] is None:
                continue
            L["games"] += 1
            margin = g["hs"] - g["as"]
            hc = margin + g["sp"]  # >0 home covers
            if not g["neu"]:
                tally(L["home_cover"], hc)
            if g["sp"] != 0:
                tally(L["fav_cover"], hc if g["sp"] < 0 else -hc)
            ou = None
            if g["tot"] is not None:
                ou = (g["hs"] + g["as"]) - g["tot"]
                tally(L["over"], ou)
            for tid, cm, is_home in ((g["hid"], hc, True), (g["aid"], -hc, False)):
                key = (tmap.get(tid) or {}).get("torvik") or f"espn:{tid}"
                T = teams[key]
                tally(T["ats"], cm)
                my_sp = g["sp"] if is_home else -g["sp"]
                if my_sp < 0:
                    tally(T["fav"], cm)
                elif my_sp > 0:
                    tally(T["dog"], cm)
                tally(T["neutral"] if g["neu"] else T["home"] if is_home else T["away"], cm)
                if ou is not None:
                    tally(T["ou"], ou)
                T["cm_sum"] += cm
                T["n"] += 1
        for k in ("home_cover", "fav_cover", "over"):
            r = L[k]
            L[k + "_pct"] = round(100 * r["w"] / (r["w"] + r["l"]), 1) if r["w"] + r["l"] else None
        del L["neutral_excluded_home"]
        out["league"][str(season)] = L
        tt = {}
        for k, T in sorted(teams.items()):
            n = T.pop("n")
            cm = T.pop("cm_sum")
            row = {f: f"{v['w']}-{v['l']}-{v['p']}" for f, v in T.items()}
            row["avg_cover"] = round(cm / n, 2) if n else None
            row["n"] = n
            tt[k] = row
        out["teams"][str(season)] = tt
        print(f"  ats {season}: {L['games']} lined games, home cover {L['home_cover_pct']}%, "
              f"fav cover {L['fav_cover_pct']}%, over {L['over_pct']}%")
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", nargs="?", default="all", choices=["all", "teams", "players", "games", "map", "ats"])
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "onyx_cbb_cache"))
    ap.add_argument("--first", type=int, default=2008)
    ap.add_argument("--last", type=int, default=2027)
    a = ap.parse_args()
    cache = Path(a.cache)
    years = list(range(a.first, a.last + 1))
    w = a.what

    if w in ("all", "teams", "map", "ats"):
        teams = torvik_teams(years, cache)
        if w in ("all", "teams"):
            dump("teams.json", teams)
    if w in ("all", "players"):
        write_players(torvik_players(years, cache))
    if w in ("all", "games", "map", "ats"):
        gs, seen = {}, {}
        for s in GAME_SEASONS:
            rows, tm = pull_games(s, cache)
            gs[s] = rows
            seen.update(tm)
            if w in ("all", "games"):
                dump(f"games_{s}.json", rows)
                print(f"    games_{s}: {len(rows)} rows, {sum(1 for r in rows if r['sp'] is not None)} with spread")
    if w in ("all", "map", "ats"):
        names = set()
        for s in ("2025", "2026", "2027"):
            names |= {t["team"] for t in teams.get(s, [])}
        lined = {}
        for rows in gs.values():
            for r in rows:
                if r["sp"] is not None:
                    lined[r["hid"]] = seen[r["hid"]]
                    lined[r["aid"]] = seen[r["aid"]]
        tmap, miss, d1 = build_map(cache, names, lined)
        dump("team_map.json", tmap)
        ok = sum(1 for i in d1 if i in tmap and tmap[i]["torvik"])
        print(f"  team_map: {ok}/{len(d1)} ESPN D1-list teams matched; {len(tmap)} entries total")
        for t in miss:
            print(f"    UNMATCHED D1: {t['abbr']} {t['name']}")
        unl = sorted({v['espn'] for v in tmap.values() if not v["torvik"]})
        print(f"    lined non-D1-list teams without a Torvik name: {len(unl)} {unl[:20]}")
        tv_used = {v["torvik"] for v in tmap.values() if v["torvik"]}
        cur = {t["team"] for t in teams.get("2026", [])}
        print(f"    Torvik 2026 teams with no ESPN id: {sorted(cur - tv_used)}")
        dump("ats.json", build_ats(gs, tmap))


if __name__ == "__main__":
    main()
