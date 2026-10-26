"""
sports_common.py - shared helpers for the Onyx Sports lanes beyond MLB and NBA:
NFL, college football, NHL, tennis and golf.

One engine, one config per sport. Every sport reads and writes only under
data/<sport>/ and builds only <sport>.html, so a failure in one never touches
MLB, NBA or another sport (the workflow steps are continue-on-error).
The pipeline depends on `requests` only, like MLB and NBA.

Sources:
  ESPN public API (site.api.espn.com): schedule, live state, box scores.
    Open to datacenter IPs and CORS-open, so pages poll it live.
  OpticOdds (OPTICODDS_API_KEY): Onyx book prices, sports_odds.py.
"""

import json, re, time, unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/"

# kind picks the page's gamecenter: football (field, drives), hockey
# (periods, shots), tennis (sets), golf (leaderboard).
# slate: "week" = ESPN's current week, "day" = the game day, "event" = the
# current tournament(s). optic: OpticOdds sport / league ids for Onyx prices.
SPORTS = {
    "nfl": {"name": "NFL", "full": "Onyx NFL", "espn": ["football/nfl"], "kind": "football", "slate": "week",
            "optic": ("football", "nfl"), "tone": "green", "art": "football", "box": True,
            "season_start": "2026-09-01"},
    "cfb": {"name": "College Football", "full": "Onyx College Football", "espn": ["football/college-football"],
            "kind": "football", "slate": "week", "optic": ("football", "ncaaf"), "tone": "lilac", "art": "cfb",
            "espn_q": "groups=80&limit=300"},
    "nhl": {"name": "NHL", "full": "Onyx NHL", "espn": ["hockey/nhl"], "kind": "hockey", "slate": "day",
            "optic": ("hockey", "nhl"), "tone": "blue", "art": "hockey"},
    "tennis": {"name": "Tennis", "full": "Onyx Tennis", "espn": ["tennis/atp", "tennis/wta"], "kind": "tennis",
               "slate": "event", "optic": ("tennis", None), "tone": "green", "art": "tennis"},
    "golf": {"name": "Golf", "full": "Onyx Golf", "espn": ["golf/pga"], "kind": "golf", "slate": "event",
             "optic": ("golf", None), "tone": "purple", "art": "golf"},
}


class Lane:
    """Paths and I/O for one sport: everything under data/<sport>/."""

    def __init__(self, key):
        if key not in SPORTS:
            raise SystemExit(f"unknown sport {key!r}; one of {', '.join(SPORTS)}")
        self.key, self.cfg = key, SPORTS[key]
        self.data = Path("data") / key
        self.data.mkdir(parents=True, exist_ok=True)

    def load(self, name, default=None):
        p = self.data / name
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return default

    def save(self, name, obj, indent=None):
        p = self.data / name
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, indent=indent, separators=(",", ":") if indent is None else None,
                                  ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)


def game_day(now=None):
    """The slate date: Eastern Time minus 4 hours, the rollover MLB and NBA
    use. Never the runner's UTC date."""
    now = now or datetime.now(ET)
    return (now.astimezone(ET) - timedelta(hours=4)).date()


def espn_get(path, params="", tries=3):
    """GET an ESPN site API path (e.g. 'football/nfl/scoreboard')."""
    url = ESPN_SITE + path + (("?" + params) if params else "")
    for attempt in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=25)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 502, 503) and attempt < tries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            print(f"  espn {path}: HTTP {r.status_code}")
            return None
        except Exception as e:
            if attempt < tries - 1:
                time.sleep(2)
                continue
            print(f"  espn {path}: {str(e)[:120]}")
            return None


def nk(name):
    """Name key shared across sources: accents, dots, apostrophes, suffixes."""
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.’'\-]", " ", s).lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def american(v):
    """Any price format to an American int, or None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if abs(f) >= 100:
        return int(round(f))
    if f > 1:   # decimal odds
        return int(round((f - 1) * 100)) if f >= 2 else int(round(-100 / (f - 1)))
    return None


def implied(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)
