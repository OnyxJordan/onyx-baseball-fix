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
