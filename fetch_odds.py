#!/usr/bin/env python3
"""
Onyx Baseball - odds fetcher + freshness gate.
Source priority:
 1. The Odds API (ODDS_API_KEY env / GitHub secret) - HR props per event,
    plus game totals and moneylines merged into data/game_lines.json
 2. DraftKings direct (blocked from datacenter IPs; self-upgrades if it lifts)
 3. Manually uploaded data/odds.json, gated by the last git commit that
    touched it (36h max) - stale or missing means the build continues
    WITHOUT odds: no edges shown, no picks logged, no fake data
Writes data/odds_meta.json so the page can display odds freshness honestly.
"""

import json, os, subprocess, sys, time, unicodedata, re, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

ODDS = "data/odds.json"
META = "data/odds_meta.json"
GAMELINES = "data/game_lines.json"
LINE_HISTORY = "data/line_history.json"
LEAGUE_URL = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/84240"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
MAX_AGE_HOURS = 36

OAPI_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb"
BOOK_PREF = ["draftkings", "fanduel", "betmgm", "caesars"]

# Full team name -> abbr, aligned with fetch_data.TEAM_ID_TO_ABBR game_keys
TEAMNAME_TO_ABBR = {
    "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL", "Detroit Tigers": "DET",
    "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Oakland Athletics": "ATH",
    "Athletics": "ATH", "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD",
    "San Francisco Giants": "SF", "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH",
}

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def _oapi_get(path, key, **params):
    params["apiKey"] = key
    url = f"{OAPI_BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        remaining = r.headers.get("x-requests-remaining")
        return json.loads(r.read().decode("utf-8")), remaining

def _slate_date():
    """The slate being built = fetch_data's schedule date, which is the
    runner's UTC date. Late-night ET runs would otherwise filter for
    yesterday's (already delisted) props while the build targets tomorrow."""
    return datetime.now(timezone.utc).date()

def _event_is_today(ev):
    try:
        dt = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
        # event's ET calendar day vs the slate date
        return (dt - timedelta(hours=4)).date() == _slate_date()
    except Exception:
        return False

def _pick_book(bookmakers, market_key):
    """Preferred book that actually carries the market; else first with it."""
    with_mkt = [b for b in (bookmakers or [])
                if any(m.get("key") == market_key for m in b.get("markets", []))]
    for pref in BOOK_PREF:
        for b in with_mkt:
            if b.get("key") == pref:
                return b
    return with_mkt[0] if with_mkt else None

def _market(book, market_key):
    for m in book.get("markets", []):
        if m.get("key") == market_key:
            return m
    return None

def try_odds_api():
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        print("ODDS_API_KEY not set - skipping The Odds API")
        return None
    try:
        events, _ = _oapi_get("/events", key)
    except Exception as ex:
        print(f"The Odds API events fetch failed ({ex})")
        return None
    todays = [e for e in events if _event_is_today(e)]
    print(f"The Odds API: {len(todays)} events today")
    if not todays:
        return None

    odds, remaining = {}, None
    for ev in todays:
        try:
            data, remaining = _oapi_get(
                f"/events/{ev['id']}/odds", key,
                regions="us", markets="batter_home_runs", oddsFormat="american")
        except Exception as ex:
            print(f"  props fetch failed for {ev.get('away_team')} @ {ev.get('home_team')}: {ex}")
            continue
        book = _pick_book(data.get("bookmakers"), "batter_home_runs")
        if not book:
            continue
        mkt = _market(book, "batter_home_runs")
        for o in mkt.get("outcomes", []):
            # Over 0.5 HR is the standard "to hit a HR" line
            if o.get("name") == "Over" and o.get("description") and o.get("price") is not None:
                try:
                    odds[o["description"]] = int(o["price"])
                except (TypeError, ValueError):
                    pass

    merge_game_lines(key)
    if remaining is not None:
        print(f"The Odds API credits remaining: {remaining}")
    # A short slate can legitimately be under 50 players; require a sane floor
    return odds if len(odds) >= 20 else None

def merge_game_lines(key):
    """Fill total / away_ml / home_ml on data/game_lines.json from one
    h2h+totals call. Pitchers, times, venues stay owned by fetch_data.py."""
    try:
        lines = json.load(open(GAMELINES, encoding="utf-8"))
    except Exception:
        return
    try:
        games, _ = _oapi_get("/odds", key, regions="us",
                             markets="h2h,totals", oddsFormat="american")
    except Exception as ex:
        print(f"game lines fetch failed ({ex}) - totals/ML unchanged")
        return
    updated = 0
    for g in games:
        away = TEAMNAME_TO_ABBR.get(g.get("away_team", ""))
        home = TEAMNAME_TO_ABBR.get(g.get("home_team", ""))
        gk = f"{away}_{home}" if away and home else None
        if not gk or gk not in lines:
            continue
        h2h_book = _pick_book(g.get("bookmakers"), "h2h")
        tot_book = _pick_book(g.get("bookmakers"), "totals")
        if h2h_book:
            for o in _market(h2h_book, "h2h").get("outcomes", []):
                if o.get("name") == g.get("away_team"):
                    lines[gk]["away_ml"] = o.get("price")
                elif o.get("name") == g.get("home_team"):
                    lines[gk]["home_ml"] = o.get("price")
        if tot_book:
            outs = _market(tot_book, "totals").get("outcomes", [])
            if outs and outs[0].get("point") is not None:
                lines[gk]["total"] = outs[0]["point"]
        updated += 1
    if updated:
        json.dump(lines, open(GAMELINES, "w", encoding="utf-8"),
                  indent=2, ensure_ascii=False)
        print(f"game_lines.json: totals/ML updated for {updated} games")

def _implied(a):
    try:
        a = int(a)
    except (TypeError, ValueError):
        return None
    return (100.0 / (a + 100.0)) if a > 0 else (abs(a) / (abs(a) + 100.0))

def snapshot_line_history():
    """Append one win-probability snapshot per run so the Markets tab can
    chart line movement across builds. Raw market-implied probabilities,
    exactly what each moneyline charges. Trimmed to 14 days."""
    try:
        lines = json.load(open(GAMELINES, encoding="utf-8"))
    except Exception:
        return
    games = {}
    for gk, e in (lines.items() if isinstance(lines, dict) else []):
        pa, ph = _implied(e.get("away_ml")), _implied(e.get("home_ml"))
        if pa and ph:
            games[gk] = [round(pa, 4), round(ph, 4)]
    if not games:
        print("line history: no moneylines to snapshot")
        return
    try:
        hist = json.load(open(LINE_HISTORY, encoding="utf-8"))
        if not isinstance(hist, list):
            hist = []
    except Exception:
        hist = []
    now_ts = int(time.time())
    # skip if the last snapshot is under 10 minutes old (double-triggered runs)
    if hist and now_ts - hist[-1].get("ts", 0) < 600:
        return
    hist.append({"ts": now_ts, "games": games})
    cutoff = now_ts - 14 * 86400
    hist = [h for h in hist if h.get("ts", 0) >= cutoff]
    json.dump(hist, open(LINE_HISTORY, "w", encoding="utf-8"))
    print(f"line history: snapshot #{len(hist)} ({len(games)} games)")

def try_dk():
    try:
        req = urllib.request.Request(LEAGUE_URL, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as ex:
        print(f"DK fetch unavailable ({ex}) - falling back to manual odds.json")
        return None
    odds = {}
    hr_ids = {m.get("id") for m in data.get("markets", [])
              if "home run" in (m.get("name") or "").lower()}
    for s in data.get("selections", []):
        if s.get("marketId") in hr_ids:
            label = (s.get("participants") or [{}])[0].get("name") or s.get("label") or ""
            us = (s.get("displayOdds") or {}).get("american")
            if label and us:
                try:
                    odds[nk(label)] = int(str(us).replace("+", "").replace("−", "-"))
                except ValueError:
                    pass
    return odds if len(odds) >= 50 else None

def main():
    now = datetime.now(timezone.utc)
    try:
        run()
    finally:
        snapshot_line_history()

def run():
    now = datetime.now(timezone.utc)

    oapi = try_odds_api()
    if oapi:
        json.dump(oapi, open(ODDS, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        json.dump({"source": "the-odds-api", "fetched": now.isoformat(),
                   "count": len(oapi), "fresh": True},
                  open(META, "w", encoding="utf-8"))
        print(f"odds.json written from The Odds API: {len(oapi)} players")
        return

    dk = try_dk()
    if dk:
        json.dump(dk, open(ODDS, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        json.dump({"source": "draftkings-api", "fetched": now.isoformat(),
                   "count": len(dk), "fresh": True},
                  open(META, "w", encoding="utf-8"))
        print(f"odds.json written from DK API: {len(dk)} players")
        return

    if not os.path.exists(ODDS):
        json.dump({"source": "none", "fetched": None, "count": 0, "fresh": False},
                  open(META, "w", encoding="utf-8"))
        print("WARNING: no odds.json present - building without odds (no edges, no picks)")
        return

    # File mtime is useless in CI (git checkout resets it, so year-old odds
    # look minutes old). Prefer the last commit that touched odds.json.
    ts = None
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%ct", "--", ODDS],
            capture_output=True, text=True, timeout=15)
        if out.returncode == 0 and out.stdout.strip():
            ts = float(out.stdout.strip())
    except Exception:
        pass
    if ts is None:
        ts = os.path.getmtime(ODDS)
    age_h = (time.time() - ts) / 3600.0
    try:
        count = len(json.load(open(ODDS, encoding="utf-8")))
    except Exception:
        count = 0
    fresh = age_h <= MAX_AGE_HOURS and count >= 50
    json.dump({"source": "manual-upload", "age_hours": round(age_h, 1),
               "count": count, "fresh": fresh},
              open(META, "w", encoding="utf-8"))
    if fresh:
        print(f"manual odds.json OK: {count} players, {age_h:.1f}h old")
    else:
        print(f"WARNING: odds.json is {age_h:.1f}h old ({count} players) - "
              f"treating as STALE, building without edges/picks")

if __name__ == "__main__":
    main()
