#!/usr/bin/env python3
"""
update_stats.py — Onyx Baseball stat persistence (post-build step)

Runs AFTER auto_build.py in the GitHub Actions workflow.
Merges data/picks_input.json and data/dfs_input.json into the
PICKS and DFS_RECORD arrays inside the freshly built index.html,
so your record never resets when the site rebuilds.

Repo layout expected:
  index.html                 <- built by auto_build.py
  data/picks_input.json      <- you edit this (HR prop picks + results)
  data/dfs_input.json        <- you edit this (DFS entries + P&L)

picks_input.json format (list, any order):
  [
    {"date":"6/9","player":"Aaron Judge","odds":255,"hit":null},
    {"date":"6/8","player":"Kyle Schwarber","odds":300,"hit":false}
  ]
  "hit": true / false / null (null = pending, shown as pending)

dfs_input.json format (list):
  [
    {"date":"6/8","site":"DK","entry":100,"won":57},
    {"date":"6/8","site":"FD","entry":50,"won":0}
  ]

Merge rules:
  - Picks keyed by (date, lowercased player): existing entry's result
    gets updated if "hit" changed; new entries are added.
  - DFS keyed by (date, site): same update-or-add behavior.
  - Final arrays are sorted newest-first by date.
  - Nothing is ever deleted from index.html history; the input files
    only need entries you're adding or updating, not the whole history.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
INDEX = ROOT / "index.html"
DATA = ROOT / "data"


def parse_date(d):
    """Parse '6/9' or '6/9/26' or '2026-06-09' -> sortable tuple."""
    d = str(d).strip()
    try:
        if "-" in d:
            dt = datetime.strptime(d[:10], "%Y-%m-%d")
            return (dt.year, dt.month, dt.day)
        parts = d.split("/")
        m, day = int(parts[0]), int(parts[1])
        yr = int(parts[2]) if len(parts) > 2 else 2026
        if yr < 100:
            yr += 2000
        return (yr, m, day)
    except Exception:
        return (0, 0, 0)


def extract_array(html, name):
    """
    Find `NAME = [ ... ];` in the HTML (with or without const/let/var)
    and return (parsed_list, match_span). Tolerant of whitespace.
    Uses bracket counting so nested objects/arrays are safe.
    """
    m = re.search(r"(?:const|let|var)?\s*\b" + name + r"\b\s*=\s*\[", html)
    if not m:
        return None, None
    start = html.index("[", m.end() - 1)
    depth = 0
    in_str = None
    esc = False
    for i in range(start, len(html)):
        c = html[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == in_str:
                in_str = None
            continue
        if c in ("'", '"'):
            in_str = c
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                raw = html[start : i + 1]
                try:
                    data = parse_js_array(raw)
                except Exception as e:
                    print(f"  !! Could not parse {name}: {e}")
                    return None, None
                return data, (start, i + 1)
    return None, None


def parse_js_array(raw):
    """Parse a JS array literal that may use single quotes / unquoted keys."""
    try:
        return json.loads(raw)
    except Exception:
        pass
    s = raw
    # unquoted keys -> quoted  ({date: -> {"date":)
    s = re.sub(r"([\{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:", r'\1"\2":', s)
    # single-quoted strings -> double-quoted
    s = re.sub(r"'((?:[^'\\]|\\.)*)'", lambda m: json.dumps(m.group(1)), s)
    # trailing commas
    s = re.sub(r",\s*([\]\}])", r"\1", s)
    # JS literals
    s = re.sub(r"\btrue\b", "true", s)
    s = re.sub(r"\bfalse\b", "false", s)
    s = re.sub(r"\bnull\b|\bundefined\b", "null", s)
    return json.loads(s)


def merge(existing, incoming, keyfn):
    index = {keyfn(e): e for e in existing}
    added, updated = 0, 0
    for item in incoming:
        k = keyfn(item)
        if k in index:
            if index[k] != {**index[k], **item}:
                index[k].update(item)
                updated += 1
        else:
            existing.append(item)
            index[k] = item
            added += 1
    existing.sort(key=lambda e: parse_date(e.get("date", "")), reverse=True)
    return existing, added, updated


def replace_span(html, span, name, data):
    js = json.dumps(data, ensure_ascii=False)
    return html[: span[0]] + js + html[span[1] :]


def main():
    if not INDEX.exists():
        print("!! index.html not found — run auto_build.py first")
        sys.exit(1)

    html = INDEX.read_text(encoding="utf-8")
    changed = False

    # ---- PICKS (HR props) ----
    picks_path = DATA / "picks_input.json"
    if picks_path.exists():
        incoming = json.loads(picks_path.read_text())
        picks, span = extract_array(html, "PICKS")
        if picks is None:
            print("!! PICKS array not found in index.html — skipping")
        else:
            keyfn = lambda p: (
                str(p.get("date", "")).strip(),
                str(p.get("player", "")).strip().lower(),
            )
            picks, a, u = merge(picks, incoming, keyfn)
            html = replace_span(html, span, "PICKS", picks)
            wins = sum(1 for p in picks if p.get("hit") is True)
            losses = sum(1 for p in picks if p.get("hit") is False)
            print(f"  PICKS: +{a} new, {u} updated -> record {wins}-{losses}")
            changed = True
    else:
        print("  data/picks_input.json not found — picks unchanged")

    # ---- DFS_RECORD ----  (re-extract after PICKS edit shifted offsets)
    dfs_path = DATA / "dfs_input.json"
    if dfs_path.exists():
        incoming = json.loads(dfs_path.read_text())
        dfs, span = extract_array(html, "DFS_RECORD")
        if dfs is None:
            print("!! DFS_RECORD array not found in index.html — skipping")
        else:
            keyfn = lambda d: (
                str(d.get("date", "")).strip(),
                str(d.get("site", "")).strip().upper(),
            )
            dfs, a, u = merge(dfs, incoming, keyfn)
            html = replace_span(html, span, "DFS_RECORD", dfs)
            net = sum(
                (e.get("won", 0) or 0) - (e.get("entry", 0) or 0) for e in dfs
            )
            print(f"  DFS_RECORD: +{a} new, {u} updated -> combined P&L ${net:+.0f}")
            changed = True
    else:
        print("  data/dfs_input.json not found — DFS record unchanged")

    if changed:
        INDEX.write_text(html, encoding="utf-8")
        print("✅ index.html updated with persisted stats")
    else:
        print("No changes applied")


if __name__ == "__main__":
    main()
