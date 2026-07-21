#!/usr/bin/env python3
"""
Builds pitcher_hand.json from the MLB Stats API using the MLBAMIDs
in out/pitcher_db.json. Keys match nk_db format (live-DB compatible).
"""

import json, sys, time, urllib.request
from pathlib import Path

PDB_PATH = Path("out/pitcher_db.json")
OUT_PATH = Path("out/pitcher_hand.json")
API = "https://statsapi.mlb.com/api/v1/people?personIds={ids}&fields=people,id,fullName,pitchHand,code"

if not PDB_PATH.exists():
    sys.exit("FATAL: run rebuild_dbs.py first, out/pitcher_db.json not found")

pdb = json.loads(PDB_PATH.read_text(encoding="utf-8"))

id_to_key = {}
missing_mid = []
for key, entry in pdb.items():
    mid = entry.get("mid")
    if mid:
        id_to_key[int(mid)] = key
    else:
        missing_mid.append(key)

hand = {}
no_hand_from_api = []
ids = list(id_to_key)
BATCH = 100

for i in range(0, len(ids), BATCH):
    chunk = ids[i:i+BATCH]
    url = API.format(ids=",".join(str(x) for x in chunk))
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for person in data.get("people", []):
        pid = person["id"]
        code = (person.get("pitchHand") or {}).get("code")
        if code in ("L", "R", "S"):
            hand[id_to_key[pid]] = code
        else:
            no_hand_from_api.append(id_to_key[pid])
    print(f"fetched {min(i+BATCH, len(ids))}/{len(ids)}")
    time.sleep(0.5)

OUT_PATH.write_text(json.dumps(hand, indent=1, ensure_ascii=False), encoding="utf-8")

print("=" * 50)
print(f"pitcher_hand.json written: {len(hand)} pitchers")
print(f"no MLBAMID in pitcher_db : {len(missing_mid)}")
for n in missing_mid[:10]: print(f"   {n}")
print(f"API returned no hand     : {len(no_hand_from_api)}")
for n in no_hand_from_api[:10]: print(f"   {n}")
print("=" * 50)
