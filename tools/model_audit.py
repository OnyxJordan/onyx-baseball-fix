"""model_audit.py - every play every model priced since 10/30, graded (dev only, 11/14).

Jordan (11/14): "start the value ranking test ... we need a full scope of those models and what we're looking at
vs who's outscoring projections ... also what if we do this at X% if it's 55, 60, 65".

Replays every committed data/<sport>/board.json (as tools/model_record_rebuild.py does). Each play (game, player or
side, market, side) is taken once: its first appearance on its game day (the baseball day), at that price, chance,
edge and projection, the same moment the Model record logs at. Graded off ESPN with picks.resolve. Writes one row a
play to --out (JSON lines); tools/model_audit_report.py reads it.

    python3 tools/model_audit.py --out /path/universe.jsonl [--sports nfl,nhl,...]
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import picks as PK          # noqa: E402
import daily_top as DT      # noqa: E402
from model_record_rebuild import versions, timeline, version_at   # noqa: E402  (tools/ is on the path as the script dir)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="origin/main")
    ap.add_argument("--sports", default=",".join(DT.TOPS))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cat = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    plays = {}
    for sport in a.sports.split(","):
        TL = timeline(a.ref, sport)
        n0 = len(plays)
        for h, ct in versions(a.ref, sport):
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
            now = PK._when(B.get("generated")) or datetime.fromtimestamp(ct, timezone.utc)
            today = (now.astimezone(PK.ET) - timedelta(hours=4)).date().isoformat()
            for e in B.get("plays") or []:
                st = PK._when(e.get("start"))
                if not st or st <= now or e.get("price") is None or e.get("conf") is None or e.get("src") == "market":
                    continue
                d = PK.day_of(st)
                if d != today:
                    continue
                m = e.get("mkt") or e.get("kind")
                k = (sport, str(e.get("gid")), str(e.get("who")), m, e.get("side"))
                if k in plays:
                    continue
                plays[k] = {"sport": sport, "date": d, "at": PK._iso(now), "start": e.get("start"), "gid": e.get("gid"),
                            "matchup": e.get("matchup"), "label": e.get("label"), "market": m, "kind": e.get("kind"),
                            "name": e.get("name"), "team": e.get("team"), "who": e.get("who"), "side": e.get("side"),
                            "line": e.get("line"), "hcap": e.get("hcap"), "price": e["price"], "chance": e["conf"],
                            "edge": e.get("edge"), "proj": e.get("proj"), "model_p": e.get("model"), "tag": e.get("tag"),
                            "model": version_at(TL, now.timestamp())}
        print(f"{sport}: {len(plays) - n0} plays", flush=True)
    cat.stdin.close()
    cat.wait()
    now = PK._now()
    cache, n, g = {}, 0, 0
    with open(a.out, "w") as f:
        for r in plays.values():
            got = None
            if PK.gradable(r["sport"], r["market"]) or r["market"] in PK.BOX.get(r["sport"], {}) or r["sport"] == "tennis":
                try:
                    got = PK.resolve(r, cache, now)
                except Exception:
                    got = None
            if got:
                r["result"], r["actual"] = got
                r["profit"] = round(PK.payout(r["price"]), 4) if got[0] == "W" else -1.0 if got[0] == "L" else 0.0
                g += 1
            f.write(json.dumps(r) + "\n")
            n += 1
            if n % 2000 == 0:
                print(f"  graded {g} of {n}", flush=True)
    print(f"{n} plays, {g} graded -> {a.out}")


if __name__ == "__main__":
    main()
