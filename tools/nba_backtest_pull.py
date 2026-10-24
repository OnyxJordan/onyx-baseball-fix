#!/usr/bin/env python3
"""Dev-only (temporary): dump the full shape of OpticOdds historical odds
for two finished NBA fixtures (Onyx book). Never prints the key."""
import json, os, sys, time
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC
H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}
os.makedirs("bt", exist_ok=True)
out = {}
for fid in ("20251231CB4314AC", "20260412ED96FD0E"):
    for mk in ("player_points", "total_points"):
        url = (f"{OPTIC}/fixtures/odds/historical?sport=basketball&league=nba&fixture_id={fid}"
               f"&sportsbook=onyx_odds&market={mk}&odds_format=AMERICAN")
        try:
            d = http_json(url, headers=H)
        except Exception as e:
            d = {"error": str(e)[:300]}
        out[f"{fid}|{mk}"] = d
        rows = (d.get("data") or [{}]) if isinstance(d, dict) else [{}]
        od = rows[0].get("odds") or []
        print(fid, mk, "odds rows", len(od), "top keys", list(d.keys()) if isinstance(d, dict) else None)
        for x in od[:3]:
            print("  ", json.dumps(x, default=str)[:1500])
        time.sleep(1)
json.dump(out, open("bt/hist_shape.json", "w"), default=str)
