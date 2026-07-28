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

import json, os, re, time, urllib.error, urllib.parse, urllib.request
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
    "New York Yankees": "NYY", "Athletics": "ATH", "Oakland Athletics": "ATH",
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
    "NYM": "NYM", "NYY": "NYY", "OAK": "ATH", "ATH": "ATH", "PHI": "PHI",
    "PIT": "PIT", "SD": "SD", "SDP": "SD", "SEA": "SEA", "SF": "SF",
    "SFG": "SF", "STL": "STL", "TB": "TB", "TBR": "TB", "TEX": "TEX",
    "TOR": "TOR", "WSH": "WSH", "WSN": "WSH", "WAS": "WSH",
}
SLUG_RE = re.compile(r"^\d+-\d+-\d{4}-\d{2}-\d{2}-\d+$")


def http_json(url, timeout=30, headers=None):
    """GET json. On HTTP errors, raise with the response BODY and rate-limit
    headers attached — a 429's body says whether it's burst pacing or a
    exhausted plan quota, which are fixed very differently."""
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            body = ""
        meta = {k: v for k, v in (e.headers or {}).items()
                if k.lower() in ("retry-after", "x-ratelimit-limit",
                                 "x-ratelimit-remaining", "x-ratelimit-reset")}
        raise RuntimeError(f"HTTP {e.code} {meta or ''} body: {body or '(empty)'}") from None


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


def _slug_from_row(fx):
    """Find the Onyx slug anywhere in a fixture row: the usual id fields
    first, then any string value matching the strict slug shape (some API
    versions carry it as game_id inside a nested fixture object)."""
    for k in ("id", "fixture_id", "game_id", "slug"):
        v = str(fx.get(k) or "")
        if SLUG_RE.match(v):
            return v
    for v in fx.values():
        if isinstance(v, str) and SLUG_RE.match(v):
            return v
        if isinstance(v, dict):
            for vv in v.values():
                if isinstance(vv, str) and SLUG_RE.match(vv):
                    return vv
    return None


def harvest_optic(key, date):
    """Every MLB fixture id (= slug) for the slate, keyed away_home.

    Verified live 7/28: the fixtures endpoint works with X-Api-Key auth but
    bursts get 429'd (hence spacing + Retry-After retries), the active list
    can still carry YESTERDAY's finished fixtures (hence the slug-date
    filter — a stale slug resolves to the wrong game's ticket), and late
    West Coast starts live on TOMORROW's UTC date (hence the second
    start_date harvest)."""
    links = {}
    qk = urllib.parse.quote(key)
    try:
        from datetime import datetime as _dt, timedelta as _td
        tomorrow = (_dt.strptime(date, "%Y-%m-%d") + _td(days=1)).strftime("%Y-%m-%d")
    except Exception:
        tomorrow = date
    # explicit plan: today (header auth), then key-param fallback if that
    # failed, then tomorrow's UTC date for late West Coast starts, then the
    # active list as a last resort if still empty
    attempts = [
        ("today",    f"{OPTIC}/fixtures?sport=baseball&league=mlb&start_date={date}", {"X-Api-Key": key}),
        ("today2",   f"{OPTIC}/fixtures?key={qk}&sport=baseball&league=mlb&start_date={date}", None),
        ("tomorrow", f"{OPTIC}/fixtures?sport=baseball&league=mlb&start_date={tomorrow}", {"X-Api-Key": key}),
        ("active",   f"{OPTIC}/fixtures/active?sport=baseball&league=mlb", {"X-Api-Key": key}),
    ]
    today_ok = False
    for phase, url, hdrs in attempts:
        if phase == "today2" and today_ok:
            continue
        if phase == "active" and links:
            break
        safe_url = url.replace(qk, "***")
        data = None
        for attempt in range(3):
            try:
                data = http_json(url, headers=hdrs)
                break
            except Exception as e:
                msg = str(e)
                print(f"onyx: {safe_url} -> {msg[:280]}")
                if "HTTP 429" in msg and attempt < 2:
                    m = re.search(r"'[Rr]etry-[Aa]fter':\s*'?(\d+)", msg)
                    wait = min(60, int(m.group(1)) if m else 15)
                    print(f"onyx: rate limited, waiting {wait}s and retrying")
                    time.sleep(wait)
                    continue
                break
        if data is None:
            time.sleep(3)
            continue
        rows = None
        if isinstance(data, dict):
            for k in ("data", "fixtures", "games", "results"):
                if isinstance(data.get(k), list):
                    rows = data[k]
                    break
        elif isinstance(data, list):
            rows = data
        if not isinstance(rows, list) or not rows:
            keys = list(data.keys())[:8] if isinstance(data, dict) else type(data).__name__
            print(f"onyx: {safe_url} -> 200 but no fixture list (top-level: {keys})")
            continue
        matched_slug = 0
        for fx in rows:
            if not isinstance(fx, dict):
                continue
            slug = _slug_from_row(fx)
            if not slug:
                continue
            # stale-fixture guard: the slug embeds its own date; anything
            # before today ET is yesterday's game and must never be linked
            dm = re.search(r"(\d{4}-\d{2}-\d{2})", slug)
            if dm and dm.group(1) < date:
                continue
            matched_slug += 1
            away, home = team_abbr(fx, "away"), team_abbr(fx, "home")
            if away and home:
                links.setdefault(f"{away}_{home}", slug)   # today's harvest wins
        if links and phase in ("today", "today2"):
            today_ok = True
            print(f"onyx: harvested {len(links)} via {safe_url}")
        # rows exist but nothing usable: dump the first row's shape so the
        # log IS the diagnosis (keys + id-ish and team-ish fields)
        r0 = rows[0]
        diag = {k: r0.get(k) for k in list(r0.keys())[:14]}
        print(f"onyx: {safe_url} -> {len(rows)} row(s), {matched_slug} slug-shaped id(s), 0 mapped")
        print("      first row: " + json.dumps(diag, ensure_ascii=False, default=str)[:700])
    return links


PLAYERS_OUT = "data/onyx_players.json"

def _nk(name):
    import unicodedata
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[.’'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def harvest_players(key):
    """OpticOdds player ids for today's lineup bats + starters. Player-prop
    share selections REQUIRE the player id as the tail (verified live:
    'player_home_runs:Pete Alonso Over 0.5:74987F97F7F3' renders a priced
    ticket, ':null' does not). Ids are stable, so the cache only refetches
    when someone in today's lineups is missing from it."""
    try:
        cache = json.load(open(PLAYERS_OUT, encoding="utf-8"))
        if not isinstance(cache, dict):
            cache = {}
    except Exception:
        cache = {}

    needed = set()
    try:
        for p in json.load(open("data/lineups.json", encoding="utf-8")):
            if p.get("name"):
                needed.add(_nk(p["name"]))
    except Exception:
        pass
    try:
        gl = json.load(open("data/game_lines.json", encoding="utf-8"))
        for g in (gl if isinstance(gl, list) else gl.values()):
            for k in ("awayP", "homeP"):
                if g.get(k):
                    needed.add(_nk(g[k]))
    except Exception:
        pass

    missing = {n for n in needed if n not in cache}
    if not missing:
        print(f"onyx: player ids cached for all {len(needed)} names")
        return cache
    print(f"onyx: {len(missing)} player id(s) missing; paging the players API")

    got = 0
    for page in range(1, 13):
        url = f"{OPTIC}/players?sport=baseball&league=mlb&page={page}"
        data = None
        for attempt in range(3):
            try:
                data = http_json(url, headers={"X-Api-Key": key})
                break
            except Exception as e:
                msg = str(e)
                print(f"onyx: players page {page} -> {msg[:200]}")
                if "HTTP 429" in msg and attempt < 2:
                    time.sleep(15)
                    continue
                break
        if data is None:
            break
        rows = data.get("data") if isinstance(data, dict) else data
        if not isinstance(rows, list) or not rows:
            if page == 1 and isinstance(data, dict):
                print(f"onyx: players response top-level keys: {list(data.keys())[:8]}")
            break
        for r in rows:
            if not isinstance(r, dict):
                continue
            pid = str(r.get("id") or "")
            nm = r.get("name") or r.get("full_name") or ""
            if pid and nm:
                cache[_nk(nm)] = pid
                got += 1
        time.sleep(1.5)
    json.dump(cache, open(PLAYERS_OUT, "w", encoding="utf-8"))
    still = len({n for n in needed if n not in cache})
    print(f"onyx: player ids -> {got} harvested this run, cache {len(cache)}, "
          f"{still} of today's names still unmatched")
    return cache


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
    # same stale guard on carried-over entries: a slug dated before today is
    # yesterday's game (or a pre-fix orphan key) and must not survive merges
    prev_links = {k: v for k, v in prev_links.items()
                  if not (re.search(r"(\d{4}-\d{2}-\d{2})", v)
                          and re.search(r"(\d{4}-\d{2}-\d{2})", v).group(1) < today)}

    key = (os.environ.get("OPTICODDS_API_KEY") or "").strip()
    if not key:
        print("onyx: OPTICODDS_API_KEY not set; keeping existing links "
              f"({len(prev_links)} for today)")
        return

    links = harvest_optic(key, today)
    harvest_players(key)
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
