#!/usr/bin/env python3
"""
mlb_season_close.py - close an MLB season (dev only, run once after the World Series).

  python3 tools/mlb_season_close.py 2026 "The Brewers won the World Series."

1. Copies the four graded ledgers (picks_input, ticket_history, k_history,
   hr_history) to data/archive/mlb_<year>/, byte for byte. The record is never
   deleted: it moves.
2. Freezes the final page: mlb-<year>.html is today's index.html with the
   ledgers' final grades injected (the offseason build leaves index.html
   untouched, so the last games' grades would otherwise never reach it), plus a
   note that it is the frozen record.
3. Starts the live record fresh: the four ledgers become [] and index.html's
   record globals are emptied the same way auto_build injects them.
4. Puts a note at the top of the Record pane, linking the frozen page, in both
   index.html (live now) and shell.html (so every build until next season keeps it).

validate_build.py diffs ledgers against git HEAD, so commit the archive and the
emptied ledgers together; every later build compares against the empty ones.
"""
import json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LEDGERS = ("picks_input", "ticket_history", "k_history", "hr_history")
NOTE_ID = "season-archive"


def replace_const(src, name, payload):
    pat = re.compile(r"^(\s*(?:const|var|let) %s\s*=\s*).*$" % re.escape(name), re.M)
    if not pat.search(src):
        sys.exit(f"FATAL: const {name} not found in index.html")
    return pat.sub(lambda m: m.group(1) + json.dumps(payload, ensure_ascii=False) + ";", src, count=1)


def k_conviction(p):   # auto_build.py's injection filter, unchanged
    try:
        pj, ln = float(p.get("proj")), float(p.get("line"))
    except (TypeError, ValueError):
        return False
    return pj > ln * 1.10 or pj < ln * 0.90


def note(html, text):
    """The archive note at the top of the Record pane (replaced if already there)."""
    html = re.sub(r'\n?<div id="%s".*?</div>' % NOTE_ID, "", html, flags=re.S)
    anchor = '<div class="pane" id="pane-record">'
    if html.count(anchor) != 1:
        sys.exit("FATAL: record pane not found exactly once")
    div = (f'<div id="{NOTE_ID}" style="margin:12px 20px 0;padding:12px 14px;border-radius:12px;'
           'border:1px solid rgba(176,56,249,.45);background:rgba(176,56,249,.10);font-size:13px;'
           f'line-height:1.55;color:var(--text2)">{text}</div>')
    return html.replace(anchor, anchor + "\n  " + div)


def main():
    year = (sys.argv[1:] or ["2026"])[0]
    champ = (sys.argv[2:] or [""])[0]
    arch = DATA / "archive" / f"mlb_{year}"
    arch.mkdir(parents=True, exist_ok=True)
    L = {}
    for name in LEDGERS:
        src = DATA / f"{name}.json"
        L[name] = json.loads(src.read_text(encoding="utf-8"))
        if (arch / src.name).exists():
            sys.exit(f"FATAL: {arch / src.name} already exists; the {year} season is already closed")
        shutil.copyfile(src, arch / src.name)
        print(f"archived {name}: {len(L[name])} rows -> {arch / src.name}")

    index = (ROOT / "index.html").read_text(encoding="utf-8")
    # the frozen page: final grades in, same filters the live build applies
    snap = replace_const(index, "K_HISTORY", [p for p in L["k_history"] if isinstance(p, dict) and k_conviction(p)])
    snap = replace_const(snap, "TICKET_HISTORY", L["ticket_history"])
    snap = replace_const(snap, "PICKS", L["picks_input"])
    snap = note(snap, f'<b style="color:var(--text)">The final {year} record.</b> Frozen after the World Series, every '
                      f'graded pick exactly as it was tracked. The live site starts fresh on Opening Day: '
                      f'<a href="index.html" style="color:#d795ff;font-weight:700">back to Onyx Baseball</a>.')
    (ROOT / f"mlb-{year}.html").write_text(snap, encoding="utf-8")
    print(f"froze mlb-{year}.html")

    # the live page and ledgers start fresh
    for name in LEDGERS:
        (DATA / f"{name}.json").write_text("[]\n", encoding="utf-8")
    live = replace_const(index, "K_HISTORY", [])
    live = replace_const(live, "TICKET_HISTORY", [])
    live = replace_const(live, "PICKS", [])
    live = replace_const(live, "TICKET_LOCK", None)
    live = replace_const(live, "HR_RECORD", {"days": [], "pending": 0, "imp_avg": None, "prob_avg": None})
    live_note = (f'<b style="color:var(--text)">{year} is in the books.</b> {champ} Every graded {year} pick is '
                 f'archived exactly as it was tracked: <a href="mlb-{year}.html" style="color:#d795ff;font-weight:700">'
                 f'see the {year} record</a>. This record starts fresh on Opening Day.').replace("  ", " ")
    live = note(live, live_note)
    (ROOT / "index.html").write_text(live, encoding="utf-8")
    shell = (ROOT / "shell.html").read_text(encoding="utf-8")
    (ROOT / "shell.html").write_text(note(shell, live_note), encoding="utf-8")
    print("index.html and shell.html: record starts fresh, note links the archive")


if __name__ == "__main__":
    main()
