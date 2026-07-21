#!/usr/bin/env python3
"""
Onyx Baseball - fetch HR 1+ odds from the DraftKings API into data/odds.json.
Standalone daily step. Fails LOUDLY (exit 1) if odds can't be fetched,
so a dead feed turns the Actions run red instead of publishing stale data.
"""

import json, sys, time, unicodedata, re, urllib.request

OUT = "data/odds.json"
LEAGUE_URL = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/84240"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.\u2019'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def main():
    try:
        data = get(LEAGUE_URL)
    except Exception as ex:
        sys.exit(f"FATAL: DK league fetch failed: {ex}")

    odds = {}
    markets = data.get("markets", []) or []
    selections = data.get("selections", []) or []
    hr_market_ids = set()

    for m in markets:
        name = (m.get("name") or "").lower()
        if "home run" in name and ("1+" in name or "to hit" in name or name.strip() == "home runs"):
            hr_market_ids.add(m.get("id"))

    for s in selections:
        if s.get("marketId") in hr_market_ids:
            label = s.get("participants", [{}])[0].get("name") or s.get("label") or ""
            us = (s.get("displayOdds") or {}).get("american")
            if label and us:
                try:
                    odds[nk(label)] = int(str(us).replace("+", "").replace("−", "-"))
                except ValueError:
                    continue

    if len(odds) < 50:
        sys.exit(f"FATAL: DK returned only {len(odds)} HR odds entries. "
                 f"Endpoint/market shape may have changed - NOT overwriting odds.json.")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(odds, f, indent=1, ensure_ascii=False)
    print(f"odds.json written: {len(odds)} players (american odds, nk keys)")

if __name__ == "__main__":
    main()
