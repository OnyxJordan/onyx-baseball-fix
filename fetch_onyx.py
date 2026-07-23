#!/usr/bin/env python3
"""
fetch_onyx.py - harvest today's Onyx game slugs so every bet button on the
site deep links to the right Onyx page.

Onyx is built on OpticOdds (o_default_v8 book). A game's Onyx URL
(app.onyxodds.com/game/{slug}) uses the OpticOdds FIXTURE ID as the slug,
format {id1}-{id2}-{YYYY-MM-DD}-{nn}. The slate is discovered straight from
the OpticOdds fixtures API, so no login cookie and nothing that expires:

  OPTICODDS_API_KEY secret set -> GET api.opticodds.com/api/v3/fixtures
  ?key=...&league=mlb&start_date=today, read each fixture's id (= slug) and
  home/away team, map to our abbreviations, write data/onyx_games.json.

The public share endpoint (app.onyxodds.com/share) is used only to VERIFY a
freshly harvested slug resolves, never to discover the slate. Without the
key the previous file is kept untouched and the site keeps its links (same
day) or falls back to the MLB board. data/onyx_games.json can also be
hand-edited: {"date": "YYYY-MM-DD", "links": {"SD_ATL": "<slug>"}}.
"""

import json, os, re, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

OUT = "data/onyx_games.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
OPTIC = "https://api.opticodds.com/api/v3"

# OpticOdds team names -> our abbreviations (matches shell ONYX_TEAM_NAMES)
ABBR = {
    "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
    "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Athletics": "OAK", "Oakland Athletics": "OAK",
    "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD",
    "Seattle Mariners": "SEA", "San Francisco Giants": "SF", "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB", "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH",
}
SLUG_RE = re.compile(r"^\d+-\d+-\d{4}-\d{2}-\d{2}-\d+$")


def http_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def today_et():
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def team_abbr(obj):
    """Pull an abbreviation from an OpticOdds team field (name or dict)."""
    if isinstance(obj, dict):
        for k in ("name", "abbreviation", "display_name"):
            v = obj.get(k)
            if v and v in ABBR:
                return ABBR[v]
        # OpticOdds sometimes ships the abbreviation directly
        ab = obj.get("abbreviation")
        if ab in ABBR.values():
            return ab
        return None
    return ABBR.get(obj)


def harvest_optic(key, date):
    """Every MLB fixture id (= slug) for the date, keyed away_home."""
    links = {}
    base = (f"{OPTIC}/fixtures?key={urllib.parse.quote(key)}"
            f"&league=mlb&sport=baseball&start_date={date}")
    for url in (base, base + "&status=unplayed", f"{OPTIC}/fixtures/active"
                f"?key={urllib.parse.quote(key)}&league=mlb&sport=baseball"):
        try:
            data = http_json(url)
        except Exception as e:
            print(f"onyx: fixtures fetch failed ({e})")
            continue
        rows = data.get("data") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            continue
        for fx in rows:
            fid = str(fx.get("id") or fx.get("fixture_id") or "")
            if not SLUG_RE.match(fid) or not fid.split("-", 2)[2].startswith(date):
                continue
            away = team_abbr(fx.get("away_team") or fx.get("away_team_display")
                             or fx.get("away"))
            home = team_abbr(fx.get("home_team") or fx.get("home_team_display")
                             or fx.get("home"))
            if away and home:
                links[f"{away}_{home}"] = fid
        if links:
            break
    return links


def verify(slug):
    """Sanity check one slug resolves on the public share endpoint."""
    for full in ("Atlanta Braves", "New York Yankees", "Los Angeles Dodgers"):
        sel = f"{slug}:o_default_v8:moneyline:{full}:null"
        url = "https://app.onyxodds.com/share?selection=" + urllib.parse.quote(sel, safe="")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                html = r.read().decode("utf-8", "replace")
            t = re.search(r"<title>([^<]*)</title>", html)
            if t and not t.group(1).strip().startswith("Shared Pick"):
                return True
        except Exception:
            pass
    return None  # inconclusive, not a hard fail


def main():
    today = today_et()
    prev = {}
    try:
        prev = json.load(open(OUT, encoding="utf-8"))
    except Exception:
        pass
    prev_links = prev.get("links") or {} if prev.get("date") == today else {}

    key = (os.environ.get("OPTICODDS_API_KEY") or "").strip()
    if not key:
        print("onyx: OPTICODDS_API_KEY not set; keeping existing links "
              f"({len(prev_links)} for today)")
        return

    links = harvest_optic(key, today)
    if not links:
        print(f"onyx: no fixtures harvested; keeping existing links ({len(prev_links)})")
        return

    # merge onto anything already known for today, harvested wins
    merged = dict(prev_links)
    merged.update(links)
    json.dump({"date": today, "links": merged},
              open(OUT, "w", encoding="utf-8"), indent=1)
    for k, v in sorted(links.items()):
        print(f"onyx: {k.replace('_', ' @ ')} -> {v}")
    print(f"onyx: wrote {len(merged)} game link(s) for {today}")


if __name__ == "__main__":
    main()
