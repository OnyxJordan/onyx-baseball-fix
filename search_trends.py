"""search_trends.py - what people really ask Ask Onyx, counted for the NFL Studio's Insights tab (11/16).

Jordan: "add the search logging so trending is real". ask.js logs each search a person types (OnyxAsk.logSearch: the
question text and how Ask read it, never who asked) into Supabase's search_log (supabase/schema.sql), insert-only
from the site. This reads the last 7 days with the service key (the site can never read the table), tags every
question by type the same way tools/insights_freq.py tags the test corpora, and writes data/insights/trending.json:

  {"generated", "days": 7, "searches": all searches, "nfl": NFL searches, "sports": {sport: n},
   "types": {type: n} (NFL), "top": [{"q", "n"}] (NFL questions asked 3+ times, normalized)}

It also deletes rows older than 90 days. Fail-soft and silent without SUPABASE_URL / SUPABASE_SERVICE_KEY (the page
then keeps the corpus counts, labelled as such). Imports requests only, like the rest of the pipeline.

    python3 search_trends.py
"""
import json
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

OUT = Path(__file__).resolve().parent / "data" / "insights" / "trending.json"
DAYS, KEEP_DAYS, TOP_MIN = 7, 90, 3
FOOT = {"rec", "rec_yds", "rush_yds", "pass_yds", "pass_td", "pass_att", "rush_rec_yds", "pass_rush_yds",
        "anytime_td", "first_td", "two_td", "two_plus_td", "three_td"}


def types(q, e):
    """The question's types: the tagger of tools/insights_freq.py, on the reading ask.js logged."""
    q, mk, t = q.lower(), set(e.get("markets") or []), set()
    if e.get("intent") in ("parlay", "rr") or re.search(r"\bparlay|legger|\bleg\b", q): t.add("parlay")
    if e.get("intent") == "sgp" or re.search(r"same game|\bsgp\b", q): t.add("sgp")
    if mk & {"anytime_td", "first_td", "two_td", "two_plus_td", "three_td"} or re.search(r"\btds?\b|touchdown|scores? first", q): t.add("td")
    if mk & {"rec", "rec_yds"}: t.add("receiving")
    if mk & {"rush_yds", "rush_rec_yds"}: t.add("rushing")
    if mk & {"pass_yds", "pass_td", "pass_att", "pass_rush_yds"}: t.add("passing")
    if "spread" in mk: t.add("spread")
    if "total" in mk: t.add("total")
    if "ml" in mk: t.add("ml")
    if e.get("player"): t.add("player")
    if e.get("team"): t.add("game")
    if (e.get("min_price") or 0) >= 100 or re.search(r"plus money|plus odds|underdog|\bdogs?\b|longshot", q): t.add("plus")
    if e.get("min_conf") or re.search(r"safe|most likely|\block|highest prob", q): t.add("safe")
    if e.get("pos_value") or re.search(r"value|\bedge\b|\bev\b|sharp", q): t.add("value")
    if e.get("side") == "under": t.add("under")
    if e.get("side") == "over": t.add("over")
    if re.search(r"\bbest\b|\btop\b|of the day|recommend", q): t.add("best")
    return t


def is_nfl(row):
    e = row.get("spec") or {}
    sp, mk = e.get("sports") or [], set(e.get("markets") or [])
    if "nfl" in sp:
        return True
    if sp:
        return False
    return bool(mk and mk <= FOOT) or row.get("page") == "studio" or "nfl" in str(row.get("q") or "").lower()


def norm(q):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s+.\-']", " ", str(q or "").lower())).strip()


def fetch(url, key, since):
    h = {"apikey": key, "authorization": f"Bearer {key}"}
    rows, start = [], 0
    while True:
        r = requests.get(f"{url}/rest/v1/search_log", headers=dict(h, range=f"{start}-{start + 999}"),
                         params={"select": "q,sport,spec,page,at", "at": f"gte.{since}", "order": "at.asc"}, timeout=30)
        if r.status_code == 404 or (r.status_code >= 400 and "search_log" in r.text):
            raise RuntimeError("the search_log table is not in Supabase yet (run supabase/schema.sql's 11/16 block)")
        r.raise_for_status()
        part = r.json()
        rows += part
        if len(part) < 1000:
            return rows
        start += 1000


def main():
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url:
        try:
            url = json.loads((Path(__file__).resolve().parent / "accounts.json").read_text()).get("url", "").rstrip("/")
        except Exception:
            url = ""
    if not url or not key:
        print("search trends: no SUPABASE_URL / SUPABASE_SERVICE_KEY; Insights keeps the corpus counts")
        return 0
    now = datetime.now(timezone.utc)
    try:
        rows = fetch(url, key, (now - timedelta(days=DAYS)).isoformat())
    except Exception as x:
        print(f"search trends: skipped ({str(x)[:160]})")
        return 0
    nfl = [r for r in rows if is_nfl(r)]
    T, Q = Counter(), Counter()
    for r in nfl:
        for t in types(r.get("q") or "", r.get("spec") or {}):
            T[t] += 1
        Q[norm(r.get("q"))] += 1
    out = {"generated": now.isoformat(timespec="seconds"), "days": DAYS, "searches": len(rows), "nfl": len(nfl),
           "sports": dict(Counter((r.get("sport") or "any") for r in rows).most_common()),
           "types": dict(T.most_common()),
           "top": [{"q": q, "n": n} for q, n in Q.most_common(25) if n >= TOP_MIN and len(q) >= 3]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"search trends: {len(rows)} searches in {DAYS} days, {len(nfl)} NFL -> {OUT.relative_to(OUT.parent.parent.parent)}")
    try:      # keep the log small: nothing older than 90 days
        requests.delete(f"{url}/rest/v1/search_log", headers={"apikey": key, "authorization": f"Bearer {key}", "prefer": "return=minimal"},
                        params={"at": f"lt.{(now - timedelta(days=KEEP_DAYS)).isoformat()}"}, timeout=30)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
