"""model_record_rebuild.py - rebuild the Model record from the site's own history (dev only, 11/14).

Jordan chose (11/14) to rebuild the past weeks, not only start today. Every committed version of
data/<sport>/board.json (the pipeline writes it about every 35 minutes, from 10/30) is replayed in order, as of
the moment it was generated: the model picks lists it would have shown (daily_top.tops), the plays the page would
have shown (model_record.select), logged once on their game day at the price on that board, the same rule the
pipeline follows from now on. Then every play is graded off ESPN (model_record.grade). Rows carry "src": "rebuilt".

Rows already in data/picks/model_log.json are kept as they are (append-only); a rebuilt play the log already
holds is skipped.

    git fetch --shallow-since=2026-10-20 origin main     # the history, once
    python3 tools/model_record_rebuild.py [--ref origin/main] [--sports nfl,nhl,...] [--no-grade]
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import daily_top as DT       # noqa: E402
import model_record as MR    # noqa: E402


def versions(ref, sport):
    """(commit, commit time) for every version of the sport's board, oldest first."""
    out = subprocess.run(["git", "log", "--reverse", "--format=%H %ct", ref, "--", f"data/{sport}/board.json"],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    return [(h, int(t)) for h, t in (x.split() for x in out if x.strip())]


def timeline(ref, sport):
    """[(unix time, VERSION)] of the sport's model module (picks.MODULE), oldest first, from git."""
    f = MR.PK.MODULE[sport] + ".py"
    out = subprocess.run(["git", "log", "--reverse", "--format=%H %ct", "-G", "^VERSION *=", ref, "--", f],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    T = []
    for x in out:
        if not x.strip():
            continue
        h, ct = x.split()
        src = subprocess.run(["git", "show", f"{h}:{f}"], cwd=ROOT, capture_output=True, text=True).stdout
        import re
        m = re.search(r'^VERSION *= *["\']([^"\']+)', src, re.M)
        if m:
            T.append((int(ct), m.group(1)))
    return T


def version_at(T, ts):
    v = None
    for t, x in T:
        if t <= ts:
            v = x
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="origin/main")
    ap.add_argument("--sports", default=",".join(DT.TOPS))
    ap.add_argument("--no-grade", action="store_true")
    a = ap.parse_args()
    rows = MR.load()
    before = len(rows)
    cat = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for sport in a.sports.split(","):
        V = versions(a.ref, sport)
        TL = timeline(a.ref, sport)
        added = 0
        for h, ct in V:
            cat.stdin.write(f"{h}:data/{sport}/board.json\n".encode())
            cat.stdin.flush()
            hdr = cat.stdout.readline().split()
            if len(hdr) < 3 or hdr[1] != b"blob":
                continue
            body = cat.stdout.read(int(hdr[2]))
            cat.stdout.read(1)
            try:
                B = json.loads(body)
            except ValueError:
                continue
            now = MR.PK._when(B.get("generated")) or datetime.fromtimestamp(ct, timezone.utc)
            T = DT.tops(sport, B.get("date"), B.get("plays") or [], now=now)
            added += MR.log(sport, T, now=now, rows=rows, src="rebuilt", model_v=version_at(TL, now.timestamp()))
        print(f"{sport}: {len(V)} boards replayed, {added} plays logged")
    cat.stdin.close()
    cat.wait()
    # rows rebuilt before rows carried the model version (11/14): stamped from the same timeline, nothing else touched
    for sport in a.sports.split(","):
        TL = timeline(a.ref, sport)
        for r in rows:
            if r["sport"] == sport and r.get("src") == "rebuilt" and not r.get("model"):
                r["model"] = version_at(TL, MR.PK._when(r["logged_at"]).timestamp())
    if not a.no_grade:
        n = MR.grade(rows=rows)
        print(f"graded {n}")
    MR.save(rows)
    print(f"model_log.json: {before} -> {len(rows)} rows")
    print(json.dumps(MR.record(rows), indent=1))


if __name__ == "__main__":
    main()
