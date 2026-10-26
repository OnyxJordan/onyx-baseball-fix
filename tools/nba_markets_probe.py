#!/usr/bin/env python3
"""TEMPORARY dev probe (removed before merge): which NBA player markets the
Onyx book prices on OpticOdds, and what its alternate ladders look like."""
import json, os, sys, time, urllib.parse
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC

KEY = os.environ["OPTICODDS_API_KEY"]
H = {"X-Api-Key": KEY}
BOOK = "onyx_odds"
def get(url):
    try:
        return http_json(url, headers=H)
    except Exception as e:
        print("ERR", str(e)[:300]); return None
    finally:
        time.sleep(0.5)

m = get(f"{OPTIC}/markets?sport=basketball&league=nba") or {}
mk = [x.get("id") for x in (m.get("data") or [])]
print("MARKETS ENDPOINT:", len(mk), "markets;", [x for x in mk if x and "player" in x][:120])
slate = json.load(open("data/nba/slate.json"))
fids = [g["gid"] for g in slate["games"] if g.get("state") == "pre"][:2]
print("FIXTURES", fids)
pm = [x for x in mk if x and x.startswith("player_")]
found = Counter(); ladders = defaultdict(dict)
for i in range(0, len(pm), 10):
    q = "".join(f"&market={x}" for x in pm[i:i + 10])
    r = get(f"{OPTIC}/fixtures/odds?sport=basketball&league=nba&sportsbook={BOOK}&odds_format=AMERICAN&fixture_id={fids[0]}{q}") or {}
    for row in r.get("data") or []:
        for od in row.get("odds") or []:
            found[od.get("market_id")] += 1
            nm = od.get("selection") or ""
            key = (od.get("market_id"), nm)
            ladders[key].setdefault(od.get("points"), {})[str(od.get("selection_line"))] = (od.get("price"), bool(od.get("is_main")))
print("ONYX PRICES BY MARKET (fixture 1):", dict(found))
star = max({k[1] for k in ladders if k[0] == "player_points"} or {""}, key=lambda n: sum(1 for k in ladders if k[1] == n))
print("SAMPLE PLAYER:", star)
for (mid, nm), lad in sorted(ladders.items()):
    if nm != star:
        continue
    pts = sorted((p for p in lad if p is not None), key=float)
    print(f"  {mid}: {len(pts)} lines", [(p, lad[p]) for p in pts][:40])
od0 = None
r = get(f"{OPTIC}/fixtures/odds?sport=basketball&league=nba&sportsbook={BOOK}&odds_format=AMERICAN&fixture_id={fids[0]}&market=player_points") or {}
for row in r.get("data") or []:
    for od in row.get("odds") or []:
        od0 = od; break
print("RAW ROW KEYS:", json.dumps(od0)[:900] if od0 else None)
