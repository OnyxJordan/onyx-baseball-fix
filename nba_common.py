"""
nba_common.py - shared helpers for the Onyx NBA pipeline.

The NBA lane lives beside the MLB one and never touches its files:
every NBA script reads and writes under data/nba/, and the page is built
into nba.html (index.html stays MLB-only). The pipeline depends on
`requests` only, same as MLB.

Data sources:
  ESPN public API (site.api.espn.com) - schedule, box scores, rosters,
    injuries, game lines. cdn.nba.com and stats.nba.com both refuse
    datacenter IPs (403 / timeout from cloud runners), ESPN does not.
  OpticOdds (OPTICODDS_API_KEY) - Onyx book prices + fixture slugs.
  The Odds API (ODDS_API_KEY) - consensus prop lines where Onyx has none.
"""

import json, re, time, unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

DATA = Path("data/nba")
DATA.mkdir(parents=True, exist_ok=True)

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

ET = ZoneInfo("America/New_York")

# ESPN abbreviations are the site's keys. Full names (The Odds API,
# OpticOdds) map onto them; ESPN itself says "LA Clippers".
TEAM_NAMES = {
    "ATL": "Atlanta Hawks", "BOS": "Boston Celtics", "BKN": "Brooklyn Nets",
    "CHA": "Charlotte Hornets", "CHI": "Chicago Bulls", "CLE": "Cleveland Cavaliers",
    "DAL": "Dallas Mavericks", "DEN": "Denver Nuggets", "DET": "Detroit Pistons",
    "GS": "Golden State Warriors", "HOU": "Houston Rockets", "IND": "Indiana Pacers",
    "LAC": "Los Angeles Clippers", "LAL": "Los Angeles Lakers", "MEM": "Memphis Grizzlies",
    "MIA": "Miami Heat", "MIL": "Milwaukee Bucks", "MIN": "Minnesota Timberwolves",
    "NO": "New Orleans Pelicans", "NY": "New York Knicks", "OKC": "Oklahoma City Thunder",
    "ORL": "Orlando Magic", "PHI": "Philadelphia 76ers", "PHX": "Phoenix Suns",
    "POR": "Portland Trail Blazers", "SAC": "Sacramento Kings", "SA": "San Antonio Spurs",
    "TOR": "Toronto Raptors", "UTAH": "Utah Jazz", "WSH": "Washington Wizards",
}
NAME_TO_ABBR = {v: k for k, v in TEAM_NAMES.items()}
NAME_TO_ABBR.update({"LA Clippers": "LAC", "Utah": "UTAH"})
# other books' short codes -> ESPN's
CODE_TO_ABBR = {k: k for k in TEAM_NAMES}
CODE_TO_ABBR.update({
    "BRK": "BKN", "BKN": "BKN", "CHO": "CHA", "GSW": "GS", "NOP": "NO", "NOR": "NO",
    "NYK": "NY", "SAS": "SA", "UTA": "UTAH", "WAS": "WSH", "PHO": "PHX",
})


def team_abbr(val):
    """Resolve a team name or code from any source to the ESPN abbreviation."""
    if not val:
        return None
    s = str(val).strip()
    return NAME_TO_ABBR.get(s) or CODE_TO_ABBR.get(s.upper())


def nk(name):
    """Name key shared across sources: accents, dots, apostrophes, suffixes."""
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.’'\-]", " ", s).lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def game_day(now=None):
    """The slate date: Eastern Time minus 4 hours, the same rollover the MLB
    side uses, so a 9 PM ET build never prices tomorrow's slate. Never use
    the runner's UTC date."""
    now = now or datetime.now(ET)
    return (now.astimezone(ET) - timedelta(hours=4)).date()


def espn_get(url, params=None, retries=3, timeout=25):
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                print(f"  espn_get failed {url}: {e}")
                return {}
            time.sleep(2 ** attempt)
    return {}


def load(name, default):
    p = DATA / name
    try:
        v = json.loads(p.read_text(encoding="utf-8"))
        return v if isinstance(v, type(default)) else default
    except Exception:
        return default


def save(name, obj, indent=None):
    (DATA / name).write_text(json.dumps(obj, indent=indent, ensure_ascii=False),
                             encoding="utf-8")


def implied(american):
    try:
        a = float(american)
    except (TypeError, ValueError):
        return None
    if a == 0:
        return None
    return 100.0 / (a + 100.0) if a > 0 else -a / (-a + 100.0)


def american_from_any(v):
    """Coerce a price (American or decimal) to an American int."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if abs(f) >= 100:
        return int(round(f))
    if f >= 2.0:
        return int(round((f - 1.0) * 100))
    if f > 1.01:
        return -int(round(100.0 / (f - 1.0)))
    return None


# ── multi-season history (ESPN season totals) ───────────────────────────────
# OpticOdds has game logs, not season totals; three past seasons from it would
# be thousands of calls. ESPN's byathlete / byteam endpoints give a whole
# season in ~6 pages, with age and debut year, so the history comes from here.
# `season` is ESPN's label: the year the season ENDS (2026 = 2025-26).
HIST_KEYS = ("min", "pts", "reb", "ast", "fg3", "fga", "fta", "tov", "oreb")


def _cat_values(row, cats, split=None):
    vals = {}
    for c in row.get("categories", []):
        if split is not None and str(c.get("splitId", "0")) != split:
            continue
        for n, v in zip(cats.get(c.get("name"), []), c.get("totals") or c.get("values") or []):
            vals.setdefault(n, v)
    return vals


def _f(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def espn_season_players(season):
    """{espn_id: {n, t, pos, age, debut, gp, min, pts, ...}} season totals, or {}."""
    out, page, pages = {}, 1, 1
    while page <= pages and page <= 30:
        d = espn_get(f"{ESPN_WEB}/statistics/byathlete",
                     {"season": season, "seasontype": 2, "limit": 100, "page": page})
        if not d:
            return {}
        pages = (d.get("pagination") or {}).get("pages", 1)
        cats = {c["name"]: c["names"] for c in d.get("categories", []) if c.get("names")}
        for row in d.get("athletes", []):
            a = row.get("athlete") or {}
            v = _cat_values(row, cats)
            gp, mins = _f(v.get("gamesPlayed")), _f(v.get("minutes"))
            if not a.get("id") or not gp or not mins:
                continue
            rec = {"n": a.get("displayName", ""), "t": team_abbr(a.get("teamShortName")) or a.get("teamShortName", ""),
                   "pos": (a.get("position") or {}).get("abbreviation", ""),
                   "age": a.get("age"), "debut": a.get("debutYear"), "gp": int(gp)}
            names = {"min": "minutes", "pts": "points", "reb": "rebounds", "ast": "assists",
                     "fg3": "threePointFieldGoalsMade", "fga": "fieldGoalsAttempted",
                     "fta": "freeThrowsAttempted", "tov": "turnovers", "oreb": "offensiveRebounds"}
            for k, src in names.items():
                rec[k] = _f(v.get(src))
            out[str(a["id"])] = rec
        page += 1
        time.sleep(0.25)
    return out


def espn_season_teams(season):
    """{team: {gp, pts, opp_pts, poss, ...}} season totals, or {}."""
    d = espn_get(f"{ESPN_WEB}/statistics/byteam", {"season": season, "seasontype": 2, "limit": 40})
    if not d:
        return {}
    cats = {c["name"]: c["names"] for c in d.get("categories", []) if c.get("names")}
    out = {}
    for row in d.get("teams", []):
        t = team_abbr((row.get("team") or {}).get("abbreviation"))
        if not t:
            continue
        rec = {}
        for side, split in (("", "0"), ("opp_", "900")):
            v = _cat_values(row, cats, split)
            for k, src in (("gp", "gamesPlayed"), ("pts", "points"), ("fga", "fieldGoalsAttempted"),
                           ("fta", "freeThrowsAttempted"), ("tov", "turnovers"),
                           ("oreb", "offensiveRebounds"), ("reb", "rebounds"), ("ast", "assists")):
                rec[side + k] = _f(v.get(src))
        gp = rec.get("gp") or 0
        if gp and rec.get("fga") is not None:
            # possessions per game: FGA - OREB + TOV + 0.44 FTA, own and
            # opponent averaged (the standard estimate)
            own = rec["fga"] - (rec["oreb"] or 0) + (rec["tov"] or 0) + 0.44 * (rec["fta"] or 0)
            opp = (rec["opp_fga"] or 0) - (rec["opp_oreb"] or 0) + (rec["opp_tov"] or 0) + 0.44 * (rec["opp_fta"] or 0)
            rec["poss"] = round((own + opp) / 2 / gp, 2) if opp else round(own / gp, 2)
            rec["ppg"] = round(rec["pts"] / gp, 2)
            rec["opp_ppg"] = round((rec["opp_pts"] or 0) / gp, 2)
        out[t] = rec
    return out


HISTORY_SEASONS = 8      # 3 feed each player's prior; all 8 fit the age curve


def current_season(day):
    """ESPN's label for the season `day` falls in (2027 = 2026-27)."""
    return day.year + 1 if day.month >= 8 else day.year


def refresh_onoff(day):
    """data/nba/onoff.json (nba_onoff.py): count every new final's lineup
    stints. Always the shared data/nba/ copy, whichever fetcher runs, and
    never fatal: a failed pull leaves yesterday's table in place."""
    import nba_onoff
    base = Path("data/nba")

    def ld(name, default):
        try:
            v = json.loads((base / name).read_text(encoding="utf-8"))
            return v if isinstance(v, type(default)) else default
        except (OSError, ValueError):
            return default

    def sv(name, obj):
        (base / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    try:
        nba_onoff.refresh(day, ld, sv, current_season)
    except Exception as ex:
        print(f"  on/off: refresh failed ({ex}); keeping the last table")


def refresh_history(day):
    """data/nba/history.json: ESPN season totals for the last HISTORY_SEASONS
    seasons, players and teams. Past seasons never change, so each is pulled
    once; a new season (or a missing one) triggers only what is missing.
    Ages are stored as of `_ref` (the season they were read in)."""
    cur = current_season(day)
    h = load("history.json", {})
    if h.get("_ref") != cur:
        h = {"_ref": cur, "players": {}, "teams": {}}   # ages are relative to _ref: re-read on a new season
    want = [str(cur - k) for k in range(1, HISTORY_SEASONS + 1)]
    got = 0
    for season in want:
        if h["players"].get(season) and h["teams"].get(season):
            continue
        pl, tm = espn_season_players(int(season)), espn_season_teams(int(season))
        if len(pl) < 300 or len(tm) < 30:
            print(f"  history: season {season} came back thin ({len(pl)} players, {len(tm)} teams); retry next run")
            continue
        # compact rows: only what the model reads
        h["players"][season] = {pid: {k: (round(v, 1) if isinstance(v, float) else v) for k, v in r.items()}
                                for pid, r in pl.items()}
        h["teams"][season] = tm
        got += 1
    if got:
        h["_built"] = day.isoformat()
        save("history.json", h)
    have = sum(1 for s in want if h["players"].get(s))
    print(f"  history: {have}/{len(want)} seasons on file (+{got} this run)")
    return h
