#!/usr/bin/env python3
"""
fetch_onyx.py - harvest today's Onyx game slugs so every bet button on the
site deep links to the right Onyx page. Slugs ({id1}-{id2}-{date}-{nn})
change daily and the league board is login-gated, so discovery runs in two
stages:

  1. ONYX_COOKIE secret set: fetch app.onyxodds.com/leagues/MLB with the
     session cookie and pull every /game/{slug} link out of the HTML.
  2. Each slug is resolved to away/home teams through the PUBLIC share
     endpoint (no auth): probe moneyline selections until one resolves,
     then read the "Away vs Home" line from the rendered page.

Output: data/onyx_games.json  {"date": "YYYY-MM-DD", "links": {"SD_ATL": slug}}
auto_build.py injects the links into the shell only when the date matches
today (ET), so stale slugs never ship. If the cookie is missing or expired
the previous file is left untouched and the site keeps its fallback links.
Manual override: hand-edit data/onyx_games.json with today's date and the
pipeline will respect it (this script skips writing if it cannot improve).
"""

import json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

OUT = "data/onyx_games.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

TEAM_ABBR = {
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
SLUG_RE = re.compile(r"/game/(\d+-\d+-\d{4}-\d{2}-\d{2}-\d+)")
VS_RE = re.compile(r"([A-Z][A-Za-z. ]+?)(?:<!-- -->)? vs (?:<!-- -->)?([A-Z][A-Za-z. ]+?)</p>")


def http_get(url, cookie=None, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if cookie:
        req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace"), r.geturl()


def today_et():
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def harvest_slugs(cookie):
    """All /game/ slugs on the authenticated MLB league board."""
    try:
        status, html, final = http_get("https://app.onyxodds.com/leagues/MLB", cookie)
    except Exception as e:
        print(f"onyx: leagues fetch failed ({e})")
        return []
    if "/login" in final or status != 200:
        print("onyx: session cookie missing/expired (redirected to login)")
        return []
    slugs = list(dict.fromkeys(SLUG_RE.findall(html)))
    print(f"onyx: {len(slugs)} game link(s) on the MLB board")
    return slugs


def resolve_slug(slug):
    """Map a slug to (away, home) abbrs via the public share endpoint."""
    for full, ab in TEAM_ABBR.items():
        sel = f"{slug}:o_default_v8:moneyline:{full}:null"
        url = ("https://app.onyxodds.com/share?selection="
               + urllib.parse.quote(sel, safe=""))
        try:
            _, html, _ = http_get(url, timeout=20)
        except Exception:
            continue
        title = re.search(r"<title>([^<]*)</title>", html)
        if not title or title.group(1).strip().startswith("Shared Pick"):
            time.sleep(0.15)
            continue
        m = VS_RE.search(html)
        if m:
            a = TEAM_ABBR.get(m.group(1).strip())
            h = TEAM_ABBR.get(m.group(2).strip())
            if a and h:
                return a, h
        # title resolved but no vs-line: at least we know slug is valid
        return None, None
    return None, None


def main():
    today = today_et()
    prev = {}
    try:
        prev = json.load(open(OUT, encoding="utf-8"))
    except Exception:
        pass
    prev_links = prev.get("links") or {} if prev.get("date") == today else {}

    cookie = (os.environ.get("ONYX_COOKIE") or "").strip()
    if not cookie:
        print("onyx: ONYX_COOKIE not set; keeping existing links "
              f"({len(prev_links)} for today)")
        return

    slugs = harvest_slugs(cookie)
    if not slugs:
        print(f"onyx: nothing harvested; keeping existing links ({len(prev_links)})")
        return

    links = dict(prev_links)
    known = set(links.values())
    for slug in slugs:
        if slug in known:
            continue
        a, h = resolve_slug(slug)
        if a and h:
            links[f"{a}_{h}"] = slug
            print(f"onyx: {a} @ {h} -> {slug}")
        else:
            print(f"onyx: could not resolve teams for {slug}")
        time.sleep(0.2)

    json.dump({"date": today, "links": links},
              open(OUT, "w", encoding="utf-8"), indent=1)
    print(f"onyx: wrote {len(links)} game link(s) for {today}")


if __name__ == "__main__":
    main()
