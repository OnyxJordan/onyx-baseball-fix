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


def _fx_start(fx):
    """Best-effort fixture start timestamp string, for doubleheader ordering."""
    for k in ("start_date", "start_time", "game_date", "commence_time"):
        v = fx.get(k)
        if v:
            return str(v)
    return ""


def _board_keys():
    """The slate's authoritative game keys (incl. AWAY_HOME_2 doubleheader
    keys) from game_lines.json, written by fetch_data earlier in the run."""
    try:
        gl = json.load(open("data/game_lines.json", encoding="utf-8"))
        return gl if isinstance(gl, dict) else {}
    except Exception:
        return {}


def _start_dist(iso_a, iso_b):
    try:
        a = datetime.fromisoformat(str(iso_a or "").replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(iso_b or "").replace("Z", "+00:00"))
        return abs((a - b).total_seconds())
    except Exception:
        return float("inf")


def harvest_optic(key, date):
    """Every MLB fixture id (= slug) for the slate, keyed away_home.

    Verified live 7/28: the fixtures endpoint works with X-Api-Key auth but
    bursts get 429'd (hence spacing + Retry-After retries), the active list
    can still carry YESTERDAY's finished fixtures (hence the slug-date
    filter — a stale slug resolves to the wrong game's ticket), and late
    West Coast starts live on TOMORROW's UTC date (hence the second
    start_date harvest).

    DOUBLEHEADERS: a pair can have two fixtures today. Fixtures are collected
    per pair, then matched to the board's keys (AWAY_HOME / AWAY_HOME_2 from
    game_lines.json) by start-time proximity, so each game's bet buttons deep
    link to ITS OWN Onyx ticket.

    Returns (links, fids): links maps game_key -> share slug (the fixture's
    game_id); fids maps game_key -> the fixture's actual API id (e.g.
    202607306B77C754), which is what /fixtures/odds filters on — passing the
    slug there matches nothing (verified 7/29: 200 with empty data)."""
    links, by_pair = {}, {}   # by_pair: pair -> {slug: (start_ts, fid)}
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
        if phase == "active" and by_pair:
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
                fid = str(fx.get("id") or "")
                fid = fid if fid and fid != slug else ""
                by_pair.setdefault(f"{away}_{home}", {}).setdefault(
                    slug, (_fx_start(fx), fid))
        if by_pair and phase in ("today", "today2"):
            today_ok = True
            n_fx = sum(len(v) for v in by_pair.values())
            print(f"onyx: harvested {n_fx} fixture(s) via {safe_url}")
        # rows exist but nothing usable: dump the first row's shape so the
        # log IS the diagnosis (keys + id-ish and team-ish fields)
        r0 = rows[0]
        diag = {k: r0.get(k) for k in list(r0.keys())[:14]}
        print(f"onyx: {safe_url} -> {len(rows)} row(s), {matched_slug} slug-shaped id(s), 0 mapped")
        print("      first row: " + json.dumps(diag, ensure_ascii=False, default=str)[:700])

    # assign harvested fixtures to board keys; greedy nearest-start matching
    # covers doubleheaders (and keeps tomorrow's same-pair fixture, swept in
    # by the tomorrow-UTC phase, from claiming today's key)
    GL = _board_keys()
    fids = {}
    fid_of = {s: v[1] for slugs in by_pair.values() for s, v in slugs.items()}
    for pair, slugs in by_pair.items():
        cand = sorted(slugs.items(), key=lambda kv: (kv[1][0] or "9999", kv[0]))
        exp = sorted((k for k in GL
                      if k == pair or (k.startswith(pair + "_")
                                       and k[len(pair) + 1:].isdigit())),
                     key=lambda k: (len(k), k))
        if not exp:
            # pair not on today's board: keep only a TODAY-dated slug (the
            # active list sweeps in future series — 45 links incl. Aug/Sep
            # fixtures landed in the 7/28 file otherwise)
            slug0 = cand[0][0]
            dm = re.search(r"(\d{4}-\d{2}-\d{2})", slug0)
            if dm and dm.group(1) == date:
                links[pair] = slug0
                if fid_of.get(slug0):
                    fids[pair] = fid_of[slug0]
            continue
        used = set()
        for k in exp:
            best_s, best_d = None, None
            for slug, (st, _fid) in cand:
                if slug in used:
                    continue
                d = _start_dist(GL[k].get("start"), st)
                if best_d is None or d < best_d:
                    best_s, best_d = slug, d
            if best_s:
                used.add(best_s)
                links[k] = best_s
                if fid_of.get(best_s):
                    fids[k] = fid_of[best_s]
    return links, fids


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


GAMELINES = "data/game_lines.json"
ODDS_JSON = "data/odds.json"
ODDS_META = "data/odds_meta.json"
# the Onyx book's identity on OpticOdds; overridable without a code change
BOOK_CANDIDATES = [b for b in [
    (os.environ.get("ONYX_SPORTSBOOK") or "").strip(), "onyx", "Onyx", "o_default_v8",
] if b]


def _american(v):
    """Coerce an OpticOdds price to an American int (tolerates decimal odds)."""
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


def harvest_game_odds(key, links, fids=None, prev_book=""):
    """Price the board straight from the ONYX book via OpticOdds so the site
    matches app.onyxodds.com exactly (user report: site TEX +116 vs Onyx
    +144 — consensus books are not Onyx's prices). Fills game_lines.json
    moneylines/totals and, when the slate is covered, replaces odds.json HR
    props. The Odds API stays the fallback: on any miss here, its numbers
    survive untouched.

    /fixtures/odds filters on the fixture's API id, NOT the share slug
    (7/29 log: slug-filtered queries returned 200 with empty data for every
    book name). Queries go out with fids and responses map back through
    both id and game_id. Returns the resolved book name for caching."""
    fids = fids or {}
    try:
        lines = json.load(open(GAMELINES, encoding="utf-8"))
        assert isinstance(lines, dict) and lines
    except Exception:
        print("onyx odds: no game_lines.json; skipping Onyx pricing")
        return prev_book
    # board order (game 1 before its doubleheader twin) so name-keyed HR
    # prices keep the current game's number, mirroring fetch_odds
    ordered = [(k, fids.get(k) or links[k]) for k in lines if links.get(k)]
    if not ordered:
        print("onyx odds: no fixture links match the board; skipping")
        return prev_book
    # responses map back via BOTH the API id and the slug-shaped game_id
    id_to_gk = {fx: k for k, fx in ordered}
    for k in lines:
        if links.get(k):
            id_to_gk.setdefault(links[k], k)
    book = None
    hr, ml_games, tot_games = {}, set(), set()

    # The key's 4000-req/15s window is shared with production traffic and is
    # often pinned at remaining:0 for minutes (verified in the 7/28 logs, where
    # every naive retry burned quota and lost). Sleep to the advertised reset
    # (+2s so we are not first in the stampede) and retry up to 8 times inside
    # a shared wall-clock budget instead of rotating book names on 429 — a 429
    # says nothing about the book, they all share one limiter.
    budget = [300.0]
    def _get(url):
        for attempt in range(8):
            try:
                return http_json(url, headers={"X-Api-Key": key})
            except Exception as e:
                msg = str(e)
                print(f"onyx odds: {msg[:180]}")
                if "HTTP 429" not in msg or budget[0] <= 0:
                    return None
                m = (re.search(r"[Rr]eset at:\s*(\d{9,11})", msg)
                     or re.search(r"ratelimit-reset':\s*'?(\d{9,11})", msg))
                wait = 16.0
                if m:
                    wait = max(2.0, min(45.0, int(m.group(1)) - time.time() + 2.0))
                wait = min(wait, max(0.0, budget[0]))
                if wait <= 0:
                    return None
                time.sleep(wait)
                budget[0] -= wait
        return None

    # resolve the ONYX book's identity from the API's own sportsbook list
    # instead of guessing names: env override, then last run's cached answer,
    # then /sportsbooks (anything containing 'onyx'), then the static guesses
    candidates = list(BOOK_CANDIDATES)
    if prev_book and prev_book not in candidates:
        candidates.insert(0, prev_book)
    if not (os.environ.get("ONYX_SPORTSBOOK") or "").strip() and not prev_book:
        for sb_url in (f"{OPTIC}/sportsbooks?sport=baseball", f"{OPTIC}/sportsbooks"):
            data = _get(sb_url)
            rows0 = data.get("data") if isinstance(data, dict) else data
            if not isinstance(rows0, list) or not rows0:
                continue
            names = []
            for r in rows0:
                if isinstance(r, dict):
                    nid, nnm = str(r.get("id") or ""), str(r.get("name") or "")
                    names.append(nid or nnm)
                    if "onyx" in (nid + " " + nnm).lower():
                        candidates.insert(0, nid or nnm)
            hits = [c for c in candidates if "onyx" in c.lower()]
            if hits:
                print(f"onyx odds: sportsbooks list matched {hits}")
            else:
                print(f"onyx odds: no 'onyx' among {len(names)} sportsbooks; "
                      "sample: " + ", ".join(names[:40]))
            break

    for i in range(0, len(ordered), 5):
        if budget[0] <= 0:
            print("onyx odds: retry budget exhausted; finishing with what we have")
            break
        chunk = ordered[i:i + 5]
        fx_q = "".join(f"&fixture_id={urllib.parse.quote(s)}" for _, s in chunk)
        rows = None
        for bk in ([book] if book else candidates):
            # no market filter: naming varies (7/29 run returned ML+totals but
            # zero HR rows under market=player_home_runs); pull the book's full
            # board per fixture and let the parser pick what it understands
            url = (f"{OPTIC}/fixtures/odds?sport=baseball&league=mlb"
                   f"&sportsbook={urllib.parse.quote(bk)}"
                   f"&odds_format=AMERICAN{fx_q}")
            data = _get(url)
            if data is None:
                break   # rate-limit storm or hard error: other books share the limiter
            cand = data.get("data") if isinstance(data, dict) else data
            if isinstance(cand, list) and any(isinstance(r, dict) and r.get("odds") for r in cand):
                rows, book = cand, bk
                break
            keys = list(data.keys())[:8] if isinstance(data, dict) else type(data).__name__
            print(f"onyx odds: book '{bk}' -> 200 but no odds rows (top-level: {keys})")
        if rows is None:
            continue
        for row in rows:
            gk = (id_to_gk.get(str(row.get("id") or ""))
                  or id_to_gk.get(_slug_from_row(row) or ""))
            if not gk:
                continue
            parts = gk.split("_")
            if len(parts) > 2 and parts[-1].isdigit():
                parts = parts[:-1]
            gk_away, gk_home = parts[0], parts[1]
            mkts_seen = set()
            for od in (row.get("odds") or []):
                if not isinstance(od, dict):
                    continue
                mkt = str(od.get("market") or od.get("market_id") or "")
                mkt = re.sub(r"[\s\-]+", "_", mkt.strip().lower())
                mkts_seen.add(mkt)
                # full-game markets only: no 1st-inning / first-5 / period lines
                if re.search(r"1st|first|inning|period|half|f5", mkt):
                    continue
                nm = str(od.get("name") or od.get("selection") or "")
                price = _american(od.get("price"))
                if price is None:
                    continue
                if "moneyline" in mkt and "method" not in mkt:
                    ab = _abbr_from(nm) or _abbr_from(od.get("selection")) \
                         or _abbr_from(od.get("team"))
                    if ab == gk_away:
                        lines[gk]["away_ml"] = price; ml_games.add(gk)
                    elif ab == gk_home:
                        lines[gk]["home_ml"] = price; ml_games.add(gk)
                elif ("total" in mkt and "team" not in mkt and "player" not in mkt
                      and "hit" not in mkt and "base" not in mkt and "strikeout" not in mkt):
                    # the odds list carries ALTERNATE totals too (Over 15.5 was
                    # winning as the last row on 7/29). Only the book's main
                    # line counts; without an is_main flag, first row wins.
                    sel = str(od.get("selection_line") or "").lower()
                    if sel == "over" or (not sel and nm.lower().startswith("over")):
                        is_main = od.get("is_main")
                        if is_main is True or gk not in tot_games:
                            pts = od.get("points")
                            if pts is None:
                                m = re.search(r"(\d+(?:\.\d+)?)", nm)
                                pts = m.group(1) if m else None
                            try:
                                pts = float(pts)
                            except (TypeError, ValueError):
                                continue
                            if 5.0 <= pts <= 14.0:   # sanity: MLB game totals
                                lines[gk]["total"] = pts
                                tot_games.add(gk)
                elif "home_run" in mkt and "team" not in mkt:
                    sel = str(od.get("selection_line") or "").lower()
                    over = sel == "over" or re.search(r"\bover\b", nm, re.I) \
                           or "to_hit" in mkt or "to_record" in mkt
                    pts = od.get("points")
                    if pts is None:
                        m = re.search(r"over\s+(\d+(?:\.\d+)?)", nm, re.I)
                        pts = float(m.group(1)) if m else 0.5
                    try:
                        pts = float(pts)
                    except (TypeError, ValueError):
                        continue
                    if not over or pts > 0.5:
                        continue
                    player = od.get("selection") if od.get("selection_line") else None
                    player = player or re.sub(r"\s+(over|under)\s+[\d.]+\s*$", "", nm, flags=re.I)
                    if player:
                        hr.setdefault(_nk(player), price)
            if i == 0 and not hr and mkts_seen:
                hrish = sorted(m for m in mkts_seen if "home" in m or "player" in m)
                print("onyx odds: no HR props parsed; markets seen: "
                      + ", ".join(sorted(mkts_seen))[:600])
                if hrish:
                    print("onyx odds: HR-ish candidates: " + ", ".join(hrish)[:300])
        time.sleep(1.2)

    if not book:
        print(f"onyx odds: no book matched/reachable (tried {candidates}); "
              "consensus lines kept")
        return prev_book
    if ml_games or tot_games:
        now_ts = int(time.time())
        for gk in ml_games | tot_games:
            lines[gk]["onyx_ts"] = now_ts   # fetch_odds --pulse respects this
        json.dump(lines, open(GAMELINES, "w", encoding="utf-8"),
                  indent=2, ensure_ascii=False)
        print(f"onyx odds: book '{book}' priced ML for {len(ml_games)} and "
              f"totals for {len(tot_games)} of {len(ordered)} games")
    # only take over the HR board when coverage is real; a thin result keeps
    # the consensus odds.json (median tripwire mirrors fetch_odds)
    if len(hr) >= 20:
        srt = sorted(hr.values())
        med = srt[len(srt) // 2]
        if med > 1500:
            print(f"onyx odds: HR median +{med} is not a 0.5-line slate - discarded")
            return book
        json.dump(hr, open(ODDS_JSON, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        json.dump({"source": "onyx-opticodds",
                   "fetched": datetime.now(ZoneInfo("UTC")).isoformat(),
                   "count": len(hr), "fresh": True},
                  open(ODDS_META, "w", encoding="utf-8"))
        print(f"onyx odds: odds.json now Onyx-priced ({len(hr)} HR props, median +{med})")
    elif hr:
        print(f"onyx odds: only {len(hr)} HR props from Onyx - keeping consensus odds.json")
    return book


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
    # and drop carried keys no longer on today's board (e.g. a doubleheader's
    # plain AWAY_HOME after game 1 went final) — a stale key would shadow the
    # right game's slug in the shell's fallback lookup
    _board = _board_keys()
    if _board:
        prev_links = {k: v for k, v in prev_links.items() if k in _board}

    key = (os.environ.get("OPTICODDS_API_KEY") or "").strip()
    if not key:
        print("onyx: OPTICODDS_API_KEY not set; keeping existing links "
              f"({len(prev_links)} for today)")
        return

    prev_fids = prev.get("fids") or {} if prev.get("date") == today else {}
    prev_book = str(prev.get("book") or "")

    links, fids = harvest_optic(key, today)
    merged = dict(prev_links)
    merged.update(links)   # harvested wins over any hand-seeded entry
    merged_fids = dict(prev_fids)
    merged_fids.update(fids)
    # price the board FIRST: the shared quota is heavily contended and this
    # is the call that makes site lines match the Onyx app
    book = prev_book
    if merged:
        book = harvest_game_odds(key, merged, merged_fids, prev_book) or ""
    harvest_players(key)
    if not links:
        print(f"onyx: no fixtures harvested; keeping existing links ({len(prev_links)})")
        if book != prev_book and prev.get("date") == today:
            prev["book"] = book
            json.dump(prev, open(OUT, "w", encoding="utf-8"), indent=1)
        return
    json.dump({"date": today, "links": merged, "fids": merged_fids, "book": book},
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
