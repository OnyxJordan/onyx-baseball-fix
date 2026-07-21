#!/usr/bin/env python3
"""
Onyx Baseball - odds freshness gate.
DraftKings blocks datacenter IPs (403 from Actions runners), so odds arrive
via manual upload of data/odds.json. This step VALIDATES rather than fetches:
 - odds.json fresh (updated today or yesterday) -> pass
 - odds.json stale or missing -> build continues WITHOUT odds
   (auto_build's guard means: no edges shown, no picks logged, no fake data)
It still tries a DK fetch first, so if the block ever lifts, it self-upgrades.
Writes data/odds_meta.json so the page can display odds freshness honestly.
"""

import json, os, sys, time, unicodedata, re, urllib.request
from datetime import datetime, timezone

ODDS = "data/odds.json"
META = "data/odds_meta.json"
LEAGUE_URL = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/84240"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
MAX_AGE_HOURS = 36

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

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

    age_h = (time.time() - os.path.getmtime(ODDS)) / 3600.0
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
