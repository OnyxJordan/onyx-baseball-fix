#!/usr/bin/env python3
"""
fetch_onyx.py - harvest today's Onyx game slugs so every bet button on the
site deep links to the right Onyx page.

Onyx is built on OpticOdds (o_default_v8 book). A game's Onyx URL
(app.onyxodds.com/game/{slug}) uses the OpticOdds FIXTURE ID as the slug,
format {id1}-{id2}-{YYYY-MM-DD}-{nn}. The slate is discovered straight from
the OpticOdds fixtures API, so no login cookie and nothing that expires:

  OPTICODDS_API_KEY secret set -> GET api.opticodds.com/api/v3/fixtures
  ?key=...&league=mlb, read each fixture's id (= slug) and home/away team,
  map to our abbreviations, write data/onyx_games.json.

ZERO-TOUCH DESIGN: nothing here needs code changes once the key is added.
The response parser is tolerant of every OpticOdds team-field shape
(display names, nested competitor objects, or raw abbreviations), and if
fixtures come back but none map it prints the raw team fields so any
mismatch is a one-line dictionary fix. The public share endpoint is used
only to VERIFY a harvested slug, never to discover the slate. Without the
key the previous file is kept and the site falls back to the MLB board.
data/onyx_games.json can also be hand-edited:
{"date": "YYYY-MM-DD", "links": {"SD_ATL": "<slug>"}}.
"""

import json, os, re, urllib.parse, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

OUT = "data/onyx_games.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
OPTIC = "https://api.opticodds.com/api/v3"

# OpticOdds full team names -> our abbreviations (matches shell ONYX_TEAM_NAMES)
NAME_ABBR = {
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
# OpticOdds' own abbreviation codes -> ours (their codes vary from the site's)
CODE_ABBR = {
    "ARI": "ARI", "AZ": "ARI", "ATL": "ATL", "BAL": "BAL", "BOS": "BOS",
    "CHC": "CHC", "CHW": "CWS", "CWS": "CWS", "CIN": "CIN", "CLE": "CLE",
    "COL": "COL", "DET": "DET", "HOU": "HOU", "KC": "KC", "KCR": "KC",
    "LAA": "LAA", "LAD": "LAD", "MIA": "MIA", "MIL": "MIL", "MIN": "MIN",
    "NYM": "NYM", "NYY": "NYY", "OAK": "OAK", "ATH": "OAK", "PHI": "PHI",
    "PIT": "PIT", "SD": "SD", "SDP": "SD", "SEA": "SEA", "SF": "SF",
    "SFG": "SF", "STL": "STL", "TB": "TB", "TBR": "TB", "TEX": "TEX",
    "TOR": "TOR", "WSH": "WSH", "WSN": "WSH", "WAS": "WSH",
}
SLUG_RE = re.compile(r"^\d+-\d+-\d{4}-\d{2}-\d{2}-\d+$")


def http_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def today_et():
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def _abbr_from(val):
    """Resolve one candidate value (string or dict) to our abbreviation."""
    if not val:
        return None
    if isinstance(val, dict):
        # try nested strings in priority order
        for k in ("name", "display_name", "full_name"):
            hit = NAME_ABBR.get((val.get(k) or "").strip())
            if hit:
                return hit
        for k in ("abbreviation", "abbr", "short_name", "code"):
            hit = CODE_ABBR.get((val.get(k) or "").strip().upper())
            if hit:
                return hit
        return None
    s = str(val).strip()
    return NAME_ABBR.get(s) or CODE_ABBR.get(s.upper())


def team_abbr(fx, side):
    """side is 'home' or 'away'. Try every field shape OpticOdds uses."""
    candidates = [
        fx.get(f"{side}_team_display"),
        fx.get(f"{side}_team"),
        fx.get(f"{side}_team_name"),
        fx.get(side),
    ]
    comps = fx.get(f"{side}_competitors") or fx.get(f"{side}_competitor")
    if isinstance(comps, list) and comps:
        candidates.append(comps[0])
    elif isinstance(comps, dict):
        candidates.append(comps)
    for c in candidates:
        ab = _abbr_from(c)
        if ab:
            return ab
    return None


def harvest_optic(key, date):
    """Every MLB fixture id (= slug) for the date, keyed away_home."""
    links, sample = {}, None
    qk = urllib.parse.quote(key)
    urls = [
        f"{OPTIC}/fixtures?key={qk}&league=mlb&start_date={date}",
        f"{OPTIC}/fixtures?key={qk}&sport=baseball&league=mlb&start_date={date}",
        f"{OPTIC}/fixtures/active?key={qk}&league=mlb",
        f"{OPTIC}/fixtures?key={qk}&league=mlb",
    ]
    for url in urls:
        try:
            data = http_json(url)
        except Exception as e:
            print(f"onyx: fixtures fetch failed ({e})")
            continue
        rows = data.get("data") if isinstance(data, dict) else data
        if not isinstance(rows, list) or not rows:
            continue
        for fx in rows:
            if not isinstance(fx, dict):
                continue
            fid = str(fx.get("id") or fx.get("fixture_id") or fx.get("game_id") or "")
            if not SLUG_RE.match(fid):
                continue
            if sample is None:
                sample = fx
            away, home = team_abbr(fx, "away"), team_abbr(fx, "home")
            if away and home:
                links[f"{away}_{home}"] = fid
        if links:
            break
    if not links and sample is not None:
        # fixtures came back but nothing mapped: show the raw team fields so
        # any name/code mismatch is an obvious one-line dictionary fix
        team_fields = {k: v for k, v in sample.items()
                       if "team" in k.lower() or "competitor" in k.lower()}
        print("onyx: fixtures returned but no teams mapped. Raw team fields "
              "from first fixture:")
        print("      " + json.dumps(team_fields, ensure_ascii=False)[:600])
    return links


def verify(slug):
    """Confirm one slug resolves on the public share endpoint (best effort)."""
    for full in ("Atlanta Braves", "New York Yankees", "Los Angeles Dodgers",
                 "Boston Red Sox"):
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

    merged = dict(prev_links)
    merged.update(links)   # harvested wins over any hand-seeded entry
    json.dump({"date": today, "links": merged},
              open(OUT, "w", encoding="utf-8"), indent=1)
    for k, v in sorted(links.items()):
        print(f"onyx: {k.replace('_', ' @ ')} -> {v}")

    # one best-effort resolution check so the log confirms the format is live
    any_slug = next(iter(links.values()))
    ok = verify(any_slug)
    print(f"onyx: share-endpoint check {'passed' if ok else 'inconclusive'} "
          f"for {any_slug}")
    print(f"onyx: wrote {len(merged)} game link(s) for {today}")


if __name__ == "__main__":
    main()
