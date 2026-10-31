#!/usr/bin/env python3
"""
daily_top.py - each sport's candidates for the home page's Top 10 plays of the day.

Every build (nba_build.py, sports_build.py) hands its priced Onyx sides here and
gets data/<sport>/top.json back: the plays its model likes at a mainstream price.
home.html reads every sport's file and ranks one Top 10 across them.

A candidate must:
  - be an Onyx main line priced -150 to +150 (no -179 / -195 juice, nothing a
    casual bettor cannot find on any book)
  - be value by the sport's own model: its chance at least the price's implied
    chance (edge >= 0)
  - be more likely to win than not (confidence 50%+)
  - be for a game that has not started

Confidence is the sport's own blended chance (the number its page shows). Each
row says what it is: "tracked" (a graded pick on its page), "trial" (logged at
Onyx's opening price, on trial) or "lean" (the model's read, not graded).
Pipeline-safe: json only.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

PRICE = (-150, 150)
MIN_CONF = 0.50
KEEP = 30
WORD = {"pts": "points", "reb": "rebounds", "ast": "assists", "pass_yds": "passing yards", "rush_yds": "rushing yards",
        "rec_yds": "receiving yards", "rec": "receptions", "q1_total": "1st-quarter points"}


def _num(x):
    return f"{x:g}" if isinstance(x, (int, float)) else str(x)


def label(r):
    """'WPG +1.5', 'Over 6.5 · total', 'A. Jones Over 29.5 rushing yards'."""
    kind = r.get("kind") or "prop"
    side = "Over" if r.get("side") == "over" else "Under"
    if kind == "spread":
        return f"{r['name']} {r.get('line_txt') or ''}".strip()
    if kind == "ml":
        return f"{r['name']} to win"
    if kind == "total":
        return f"{side} {_num(r['line'])} {'total games' if r.get('name') == 'Total games' else 'total'}"
    mkt = r.get("mkt") or r.get("stat")
    if mkt == "anytime_td":
        return f"{r['name']} anytime TD"
    return f"{r['name']} {side} {_num(r['line'])} {WORD.get(mkt, mkt or '')}".strip()


def entry(sport, r, tag="lean", start=None):
    return {"sport": sport, "label": label(r), "matchup": r.get("matchup") or "", "start": r.get("start") or start,
            "gid": r.get("gid"), "who": r.get("pid") or r.get("name"), "price": r["price"], "conf": round(r["prob"], 4),
            "edge": round(r["edge"], 4), "sel": r.get("sel"), "tag": tag,
            # what the home page needs to follow a saved pick live (saved.js / My picks)
            "kind": r.get("kind") or "prop", "mkt": r.get("mkt") or r.get("stat") or r.get("kind"), "side": r.get("side"),
            "line": r.get("line"), "hcap": _hcap(r), "name": r.get("name"), "team": r.get("team")}


def _hcap(r):
    try:
        return float(r["line_txt"]) if r.get("kind") == "spread" and r.get("line_txt") else None
    except ValueError:
        return None


def ok(r):
    return (r.get("price") is not None and r.get("prob") is not None and r.get("edge") is not None
            and PRICE[0] <= r["price"] <= PRICE[1] and r["edge"] >= 0 and r["prob"] >= MIN_CONF)


def write(data_dir, sport, date, rows):
    """rows: entry() dicts. Best first by confidence; one per player or game
    market. Written every build so a quiet night is an empty list, not a stale one."""
    seen, out = set(), []
    for e in sorted(rows, key=lambda e: (-{"tracked": 2, "trial": 1}.get(e["tag"], 0), -e["conf"], -e["edge"])):
        k = (e["gid"], e["who"])
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    out = sorted(out, key=lambda e: (-e["conf"], -e["edge"]))[:KEEP]
    p = Path(data_dir) / "top.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"sport": sport, "date": date, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "plays": out}, separators=(",", ":")), encoding="utf-8")
    return out


BOARD_KEEP = 800


def write_board(data_dir, sport, date, rows):
    """data/<sport>/board.json: every priced Onyx side the model reads today,
    any price, for the home page's "Ask Onyx" search (it filters and builds
    parlays from this list; the AI only turns a sentence into a filter).
    rows: entry() dicts, plus "proj" and, for touchdown props, "lam" (expected
    touchdowns, so "2+ touchdowns" can be answered from the same number)."""
    seen, out = set(), []
    for e in sorted(rows, key=lambda e: -e["conf"]):
        k = (e["gid"], e["who"], e.get("mkt"), e.get("side"))
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    p = Path(data_dir) / "board.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"sport": sport, "date": date, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "plays": out[:BOARD_KEEP]}, separators=(",", ":")), encoding="utf-8")
    return out

