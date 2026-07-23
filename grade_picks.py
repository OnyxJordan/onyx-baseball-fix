#!/usr/bin/env python3
"""
Onyx Baseball - automatic pick grading.
For every pending pick (hit == null) with a date in the past, pulls that
day's final boxscores from the MLB Stats API and sets hit true/false:
  - player homered that day  -> hit: true
  - player appeared, no HR   -> hit: false
  - player never appeared    -> left pending (voided prop / scratch), reported
Runs before auto_build in the daily workflow so update_stats.py merges the
graded results into the site record the same morning.
"""

import json, re, unicodedata, urllib.request
from datetime import datetime, timedelta, timezone

PICKS = "data/picks_input.json"
MLB = "https://statsapi.mlb.com/api/v1"

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.’'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def today_et():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).date()

def parse_date(d):
    """'2026-07-23' or '7/23' or '7/23/26' -> date, else None."""
    d = str(d).strip()
    try:
        if "-" in d:
            return datetime.strptime(d[:10], "%Y-%m-%d").date()
        parts = d.split("/")
        m, day = int(parts[0]), int(parts[1])
        yr = int(parts[2]) if len(parts) > 2 else today_et().year
        if yr < 100:
            yr += 2000
        return datetime(yr, m, day).date()
    except Exception:
        return None

def day_hr_map(date_str):
    """{nk_name: hr_count} plus set of players who appeared, for one date."""
    hrs, appeared = {}, set()
    sched = get(f"{MLB}/schedule?sportId=1&date={date_str}")
    pks = [g["gamePk"] for de in sched.get("dates", []) for g in de.get("games", [])
           if g.get("status", {}).get("abstractGameState") == "Final"]
    for pk in pks:
        try:
            box = get(f"{MLB}/game/{pk}/boxscore")
        except Exception:
            continue
        for side in ("home", "away"):
            for pdata in (box.get("teams", {}).get(side, {}).get("players") or {}).values():
                name = nk((pdata.get("person") or {}).get("fullName") or "")
                if not name:
                    continue
                bat = (pdata.get("stats") or {}).get("batting") or {}
                pa = (bat.get("plateAppearances") or 0) + (bat.get("atBats") or 0)
                if pa > 0 or bat.get("gamesPlayed"):
                    appeared.add(name)
                    hrs[name] = hrs.get(name, 0) + (bat.get("homeRuns") or 0)
    return hrs, appeared

def main():
    try:
        picks = json.load(open(PICKS, encoding="utf-8"))
    except Exception:
        print("no picks_input.json - nothing to grade")
        return
    if not isinstance(picks, list):
        print("picks_input.json is not a list - skipping")
        return

    cutoff = today_et()
    pending_dates = sorted({str(p.get("date")) for p in picks
                            if isinstance(p, dict) and p.get("hit") is None
                            and (parse_date(p.get("date")) or cutoff) < cutoff})
    if not pending_dates:
        print("no pending picks from past dates - nothing to grade")
        return

    graded = voided = 0
    for dstr in pending_dates:
        d = parse_date(dstr)
        iso = d.strftime("%Y-%m-%d")
        try:
            hrs, appeared = day_hr_map(iso)
        except Exception as ex:
            print(f"  {iso}: boxscore fetch failed ({ex}) - will retry next run")
            continue
        for p in picks:
            if not isinstance(p, dict) or p.get("hit") is not None:
                continue
            if str(p.get("date")) != dstr:
                continue
            key = nk(p.get("player") or p.get("name") or "")
            if key in hrs and hrs[key] >= 1:
                p["hit"] = True; graded += 1
            elif key in appeared:
                p["hit"] = False; graded += 1
            else:
                voided += 1
                print(f"  {iso}: {p.get('player') or p.get('name')} never appeared - left pending")

    if graded:
        json.dump(picks, open(PICKS, "w", encoding="utf-8"),
                  indent=1, ensure_ascii=False)
    wins = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is True)
    losses = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is False)
    print(f"graded: {graded}, still pending: {voided}, record now {wins}-{losses}")

if __name__ == "__main__":
    main()
