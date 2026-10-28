#!/usr/bin/env python3
"""
nba_pbp_pull.py - ESPN NBA play-by-play into lineup stints (dev only).

For every regular-season game in a date range: who was on the floor for
every second (starters from the box, then each "X enters the game for Y"),
and a compact event log credited to players. The on/off model
(nba_onoff.py) reads these; the raw 400 KB summaries are not kept.

  python3 tools/nba_pbp_pull.py OUT_DIR 2024-10-22 2025-04-13 [--workers 8]

Writes OUT_DIR/<YYYY-MM-DD>/<event id>.json:
  {"id", "d", "teams": {espn_team_id: abbr}, "names": {athlete_id: name},
   "stints": [[team_id, t0, t1, [5 athlete ids]], ...],      seconds from tip
   "ev": [[t, team_id, kind, actor, other], ...]}
kind: f2 / f3 (made 2 / 3, other = assister), m2 / m3 (missed),
      ft / fm (made / missed free throw), or / dr (rebounds), to (turnover).
Requests only; resumable (a game already on disk is skipped).
"""

import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nba_onoff import get, parse_game as game, SB  # one parser for the pull and production



def main():
    out, d0, d1 = Path(sys.argv[1]), date.fromisoformat(sys.argv[2]), date.fromisoformat(sys.argv[3])
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 8
    jobs = []
    d = d0
    while d <= d1:
        sb = get(SB.format(d.strftime("%Y%m%d"))) or {}
        for e in sb.get("events") or []:
            st = ((e.get("season") or {}).get("type"))
            if st not in (2, None):        # regular season only (2); skip preseason, cup final, playoffs
                continue
            if (((e.get("status") or {}).get("type") or {}).get("state")) != "post":
                continue
            f = out / d.isoformat() / f"{e['id']}.json"
            if not f.exists():
                jobs.append((e["id"], d.isoformat(), f))
        d += timedelta(days=1)
    print(f"{len(jobs)} games to pull", flush=True)

    def work(j):
        eid, ds, f = j
        try:
            r = game(eid, ds)
        except (KeyError, TypeError, ValueError, IndexError) as ex:
            print(f"  skip {eid} {ds}: {ex!r}", flush=True)   # a malformed summary: skip, never stop the pull
            return False
        if r:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(r, separators=(",", ":")))
        return bool(r)

    ok = 0
    with ThreadPoolExecutor(workers) as ex:
        for i, r in enumerate(ex.map(work, jobs)):
            ok += r
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(jobs)} ({ok} ok)", flush=True)
    print(f"done: {ok} of {len(jobs)} games", flush=True)


if __name__ == "__main__":
    main()
