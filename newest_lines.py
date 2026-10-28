#!/usr/bin/env python3
"""
newest_lines.py - the newer Onyx NBA pull always wins a push race.

The full refresh, the daily build and the 10-minute lines run all commit
data/nba/props.json and nba.html. When a push is rejected they rebase onto
main preferring their OWN files, so a run that pulled prices first but
pushed last put older prices back on main (10/28: prices from 6:46:08 PM
replaced ones from 6:46:46 PM).

Run right after that rebase: if main's prices were pulled later than ours,
take main's props.json and rebuild nba.html from it in lines-only mode (no
grading, no picks, no ticket changes; the ledgers are whatever the rebase
left, which already includes both runs), then commit. Our own newer prices
are left alone. Never fatal: any problem leaves the rebase result as it was.
"""

import json, os, subprocess, sys
from datetime import datetime

PROPS = "data/nba/props.json"


def fetched(d):
    try:
        return datetime.fromisoformat(str(d.get("fetched")).replace("Z", "+00:00"))
    except (TypeError, ValueError, AttributeError):
        return None


def main():
    try:
        theirs_raw = subprocess.run(["git", "show", f"origin/main:{PROPS}"], capture_output=True, text=True, check=True).stdout
        theirs = json.loads(theirs_raw)
        ours = json.load(open(PROPS, encoding="utf-8"))
    except Exception as ex:
        print(f"newest lines: nothing to compare ({ex})")
        return 0
    t, o = fetched(theirs), fetched(ours)
    if not t or theirs.get("date") != ours.get("date") or (o and o >= t):
        print(f"newest lines: keeping ours ({ours.get('fetched')} vs main {theirs.get('fetched')})")
        return 0
    open(PROPS, "w", encoding="utf-8").write(theirs_raw)
    r = subprocess.run([sys.executable, "-B", "nba_build.py"], env={**os.environ, "NBA_LINES_ONLY": "1"})
    if r.returncode != 0:
        print("newest lines: rebuild failed; restoring the rebase result")
        subprocess.run(["git", "checkout", "--", PROPS, "nba.html"])
        return 0
    subprocess.run(["git", "add", PROPS, "nba.html"], check=False)
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode != 0:
        subprocess.run(["git", "commit", "-q", "-m", f"NBA lines: keep the newer Onyx pull ({theirs.get('fetched')})"], check=False)
    print(f"newest lines: main's prices are newer ({theirs.get('fetched')} vs ours {ours.get('fetched')}); rebuilt nba.html from them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
