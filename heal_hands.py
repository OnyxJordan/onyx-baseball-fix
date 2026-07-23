#!/usr/bin/env python3
"""
Onyx Baseball - rolling pitcher hand maintenance.
Reads today's probable starters from data/lineups.json, finds any pitcher
missing from data/pitcher_hand.json, fetches his hand from the MLB Stats API
by name search, and appends it. Never removes entries. Runs daily.
"""

import json, sys, unicodedata, re, urllib.request, urllib.parse

HAND_FILE = "data/pitcher_hand.json"
LINEUPS   = "data/lineups.json"
GAMELINES = "data/game_lines.json"
SEARCH    = "https://statsapi.mlb.com/api/v1/people/search?names={q}&fields=people,id,fullName,pitchHand,code,primaryPosition,abbreviation"

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def collect_starters(node, found):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("pitcher", "home_pitcher", "away_pitcher", "probable", "sp",
                     "awayP", "homeP") and isinstance(v, str):
                found.add(v)
            else:
                collect_starters(v, found)
    elif isinstance(node, list):
        for item in node:
            collect_starters(item, found)

def main():
    try:
        hands = json.load(open(HAND_FILE, encoding="utf-8"))
    except Exception:
        hands = {}
    starters = set()
    # probable starters live in game_lines.json (awayP/homeP); lineups.json is
    # a flat batter list but is still walked for any legacy pitcher fields
    for path in (GAMELINES, LINEUPS):
        try:
            collect_starters(json.load(open(path, encoding="utf-8")), starters)
        except Exception as ex:
            print(f"WARNING: could not read {path} ({ex})")
    starters.discard("TBD")
    starters.discard("")
    missing = [s for s in starters if nk(s) not in hands]
    print(f"starters found: {len(starters)}, missing hand: {len(missing)}")

    added, failed = 0, []
    for name in missing:
        try:
            data = get(SEARCH.format(q=urllib.parse.quote(name)))
            for p in data.get("people", []):
                if (p.get("primaryPosition") or {}).get("abbreviation") == "P":
                    code = (p.get("pitchHand") or {}).get("code")
                    if code in ("L", "R", "S"):
                        hands[nk(name)] = code
                        added += 1
                        print(f"  + {name}: {code}")
                        break
            else:
                failed.append(name)
        except Exception:
            failed.append(name)

    if added:
        json.dump(hands, open(HAND_FILE, "w", encoding="utf-8"),
                  indent=1, ensure_ascii=False)
    print(f"healed: {added}, unresolved: {len(failed)} {failed[:5]}")

if __name__ == "__main__":
    main()
