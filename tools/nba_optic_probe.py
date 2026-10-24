#!/usr/bin/env python3
"""Dev-only probe (temporary): log the SHAPE of OpticOdds NBA responses so
the NBA parsers are built against real payloads. Never prints the key."""
import json, os, sys, time, urllib.parse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC

KEY = os.environ.get("OPTICODDS_API_KEY", "").strip()
H = {"X-Api-Key": KEY}

def show(label, url, n=1500):
    print(f"\n===== {label}: {url}")
    try:
        d = http_json(url, headers=H)
    except Exception as e:
        print("ERROR", str(e)[:400]); return None
    rows = d.get("data") if isinstance(d, dict) else d
    if isinstance(d, dict):
        print("top keys:", list(d.keys())[:12], {k: d[k] for k in ("page", "total_pages") if k in d})
    if isinstance(rows, list):
        print("rows:", len(rows))
        if rows:
            print(json.dumps(rows[0], default=str)[:n])
    else:
        print(json.dumps(d, default=str)[:n])
    time.sleep(2)
    return rows

if not KEY:
    print("no key"); sys.exit(0)
et = datetime.now(ZoneInfo("America/New_York")) - timedelta(hours=4)
today, yday = et.strftime("%Y-%m-%d"), (et - timedelta(days=1)).strftime("%Y-%m-%d")
q = "sport=basketball&league=nba"
fx_today = show("fixtures today", f"{OPTIC}/fixtures?{q}&start_date={today}", 2500) or []
fx_y = show("fixtures yesterday", f"{OPTIC}/fixtures?{q}&start_date={yday}") or []
done = [f for f in fx_y if isinstance(f, dict) and str(f.get("status", "")).lower() in ("completed", "final", "finished")] or fx_y
fid = done[0]["id"] if done else None
print("status values:", sorted({str(f.get('status')) for f in fx_today + fx_y if isinstance(f, dict)}))
if fid:
    show("results", f"{OPTIC}/fixtures/results?fixture_id={urllib.parse.quote(fid)}", 2500)
    pr = show("player-results", f"{OPTIC}/fixtures/player-results?fixture_id={urllib.parse.quote(fid)}", 4000)
    pid = None
    try:
        blob = json.dumps(pr)
        import re
        m = re.search(r'"player"\s*:\s*\{[^{}]*"id"\s*:\s*"([^"]+)"', blob)
        pid = m.group(1) if m else None
    except Exception:
        pass
    if pid:
        show("player-results last-x", f"{OPTIC}/fixtures/player-results/last-x?{q}&player_id={urllib.parse.quote(pid)}&last_x=5", 3000)
show("injuries", f"{OPTIC}/injuries?{q}", 1500)
show("players", f"{OPTIC}/players?{q}&page=1", 1200)
show("markets", f"{OPTIC}/markets?{q}", 600)
try:
    book = json.load(open("data/onyx_games.json")).get("book") or "onyx"
except Exception:
    book = "onyx"
print("book:", book)
up = [f for f in fx_today if isinstance(f, dict) and str(f.get("status", "")).lower() in ("unplayed", "scheduled", "not_started", "")] or fx_today
if up:
    f0 = up[-1]["id"]
    d = None
    try:
        d = http_json(f"{OPTIC}/fixtures/odds?{q}&sportsbook={urllib.parse.quote(book)}&odds_format=AMERICAN&fixture_id={urllib.parse.quote(f0)}", headers=H)
    except Exception as e:
        print("odds ERROR", str(e)[:300])
    rows = (d or {}).get("data") or []
    for r in rows[:1]:
        print("\n===== odds row keys:", [k for k in r if k != "odds"], "n odds:", len(r.get("odds") or []))
        mk = {}
        for od in r.get("odds") or []:
            mk.setdefault(od.get("market_id") or od.get("market"), od)
        print("markets:", sorted(map(str, mk))[:120])
        for m, od in mk.items():
            if "point" in str(m).lower() or "rebound" in str(m).lower() or "assist" in str(m).lower():
                print("  sample", m, json.dumps(od, default=str)[:700])
