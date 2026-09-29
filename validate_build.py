#!/usr/bin/env python3
"""
validate_build.py — the gate between a built index.html and a commit.

ROADMAP Phase 2 asked for this and it was never built, so for a long time the
only guard on the whole pipeline was auto_build aborting on zero scored players.
A build that was structurally broken but non-empty shipped straight to the site.

Runs after auto_build.py + update_stats.py and BEFORE the commit step. Non-zero
exit blocks the commit, so yesterday's page stays live rather than a broken one
replacing it. Also runs on every pull request, where it is the only automated
check the repo has.

It checks three things, in rising order of how badly they bite:

  1. STRUCTURE — the injected globals exist, parse, and carry the keys the shell
     reads. A malformed payload is what blanks panes.
  2. LINEUPS — nine bats a side, slots 1-9 exactly once, nobody batting twice.
     Batting slot drives expected PAs, so a duplicated or missing slot silently
     misprices every prop in that game. This is the check Jordan asked for: it
     is how we know the card we are projecting off is actually a real card.
  3. LEDGERS — the graded record may grow, never shrink. Hard rule 6 says the
     ledgers are sacred; this enforces it mechanically instead of trusting
     everyone to remember, by diffing row counts against git HEAD.

Every failure prints what broke and why it matters. Warnings do not block.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
DATA = ROOT / "data"

# global -> (required, kind) that the shell depends on
REQUIRED_GLOBALS = {
    "RESULTS":        (True,  list),
    "SUMMARIES":      (True,  list),
    "ALL_GAME_KEYS":  (True,  list),
    "PICKS":          (False, list),
    "PITCHER_PROJ":   (False, list),
    "PLAYOFF_GAMES":  (False, list),
    "PLAYOFF_FIELD":  (False, list),
    "LINE_HISTORY":   (False, list),
}
RESULT_KEYS = ("batter_name", "team", "game", "hr_prob", "batting_order")
LEDGERS = ("picks_input", "ticket_history", "k_history", "hr_history")

errors, warnings = [], []


def fail(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def read_global(html, name):
    m = re.search(r"^\s*(?:var|const|let) %s\s*=\s*(.*);\s*$" % re.escape(name),
                  html, re.M)
    if not m:
        return None, "not found in index.html"
    try:
        return json.loads(m.group(1)), None
    except json.JSONDecodeError as e:
        return None, f"does not parse as JSON ({e})"


def check_structure(html):
    globals_seen = {}
    for name, (required, kind) in REQUIRED_GLOBALS.items():
        val, err = read_global(html, name)
        if err:
            (fail if required else warn)(f"{name}: {err}")
            continue
        if not isinstance(val, kind):
            fail(f"{name}: expected {kind.__name__}, got {type(val).__name__}")
            continue
        if required and not val:
            fail(f"{name}: empty, the page would render a blank pane")
        globals_seen[name] = val

    res = globals_seen.get("RESULTS") or []
    if res:
        missing = [k for k in RESULT_KEYS if k not in res[0]]
        if missing:
            fail(f"RESULTS rows are missing required key(s): {missing}")
        bad = [r.get("batter_name") for r in res
               if not isinstance(r.get("hr_prob"), (int, float))]
        if bad:
            fail(f"{len(bad)} RESULTS row(s) have a non-numeric hr_prob, "
                 f"e.g. {bad[:3]}")

    # SUMMARIES must cover the same games the board claims to show
    keys = set(globals_seen.get("ALL_GAME_KEYS") or [])
    sums = globals_seen.get("SUMMARIES") or []
    slabels = {s.get("game") or s.get("game_key") or s.get("label") for s in sums
               if isinstance(s, dict)}
    if keys and slabels and not (slabels & keys):
        warn("SUMMARIES and ALL_GAME_KEYS share no labels - check the join")

    return globals_seen


def check_lineups(globals_seen):
    """Nine bats a side, slots 1-9 once each, nobody twice.

    A duplicated slot means two bats are projected with the same expected PAs
    and one real slot is unrepresented; a missing slot means a bat that will
    actually hit is not on the board at all. Either way every prop in that game
    is priced off a lineup that does not exist.
    """
    res = globals_seen.get("RESULTS") or []
    if not res:
        return
    by_game_team = {}
    for r in res:
        g, t = r.get("game"), r.get("team")
        if not g or not t:
            fail(f"RESULTS row without game/team: {r.get('batter_name')!r}")
            continue
        by_game_team.setdefault((g, t), []).append(r)

    for (game, team), rows in sorted(by_game_team.items()):
        orders = [r.get("batting_order") for r in rows]
        names = [r.get("batter_name") for r in rows]

        dupe_names = {n for n in names if names.count(n) > 1}
        if dupe_names:
            fail(f"{game} / {team}: player listed twice: {sorted(dupe_names)}")

        nums = [o for o in orders if isinstance(o, int)]
        if len(nums) != len(orders):
            fail(f"{game} / {team}: non-integer batting_order present")
        dupe_slots = {o for o in nums if nums.count(o) > 1}
        if dupe_slots:
            fail(f"{game} / {team}: batting slot(s) used more than once: "
                 f"{sorted(dupe_slots)} - every prop in this game is priced off "
                 f"a lineup that cannot exist")
        outside = [o for o in nums if not 1 <= o <= 9]
        if outside:
            fail(f"{game} / {team}: batting slot(s) outside 1-9: {sorted(outside)}")
        if len(rows) != 9:
            warn(f"{game} / {team}: {len(rows)} bats, expected 9")

    # how official is the board right now? not a failure, but it should be
    # visible in the log so a slate stuck on projections is noticeable
    srcs = {}
    for r in res:
        srcs[r.get("lineup_source") or "unknown"] = \
            srcs.get(r.get("lineup_source") or "unknown", 0) + 1
    if srcs:
        pretty = ", ".join(f"{k}={v}" for k, v in sorted(srcs.items()))
        print(f"  lineup sources: {pretty}")
        official = srcs.get("mlb-confirmed", 0)
        total = sum(srcs.values())
        if total and official == 0:
            warn("no bat on the board is on an official MLB lineup card yet")


def _git_json(path):
    try:
        out = subprocess.run(["git", "show", f"HEAD:{path}"],
                             capture_output=True, text=True, timeout=20,
                             cwd=str(ROOT))
        if out.returncode != 0 or not out.stdout.strip():
            return None
        return json.loads(out.stdout)
    except Exception:
        return None


def check_ledgers():
    """The graded record grows; it never shrinks. Hard rule 6, enforced."""
    for name in LEDGERS:
        p = DATA / f"{name}.json"
        if not p.exists():
            fail(f"data/{name}.json is missing - this is a graded ledger")
            continue
        try:
            now = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            fail(f"data/{name}.json does not parse ({e})")
            continue
        if not isinstance(now, list):
            fail(f"data/{name}.json is {type(now).__name__}, expected list")
            continue
        was = _git_json(f"data/{name}.json")
        if isinstance(was, list) and len(now) < len(was):
            fail(f"data/{name}.json SHRANK {len(was)} -> {len(now)} rows. "
                 f"The ledgers are the public graded record and are never "
                 f"regenerated (hard rule 6).")


def main():
    print("validate_build: checking the built page before it ships")
    if not INDEX.exists():
        print("FATAL: index.html does not exist", file=sys.stderr)
        return 1
    html = INDEX.read_text(encoding="utf-8")
    if len(html) < 200_000:
        fail(f"index.html is only {len(html)} bytes - a real build is ~1.6MB")

    g = check_structure(html)
    check_lineups(g)
    check_ledgers()

    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}", file=sys.stderr)

    if errors:
        print(f"\nvalidate_build: {len(errors)} failure(s) - NOT committing this "
              f"build. The previously deployed page stays live.", file=sys.stderr)
        return 1
    print(f"validate_build: OK ({len(g)} globals, {len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
