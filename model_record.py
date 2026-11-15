"""model_record.py - the Model record: every sport's model picks, graded (11/14).

Jordan: "where's tennis record where's nhl record we're missing all of that from the site there's no oversight
into how it's actually performing". His call (11/14): grade the model's plays in every sport, in a record kept
apart from the official Onyx Picks record (picks.py, data/picks/ledger.json), and rebuild the past weeks from the
site's own history.

What is graded: the plays the sport page shows in its model picks lists (daily_top.TOPS -> data/<sport>/tops.json,
"Top 5 against the spread", "Top 10 player props" ...), chosen exactly as the page chooses them: games not started,
one play per game and per player, the top N of each list. A play is logged once, on its game's day (the baseball
day, ET minus 4 hours), at the Onyx price showing when it first makes its list, and never more than N a list a
day. It is graded off ESPN with picks.resolve, the same grader as the Onyx Picks.

data/picks/model_log.json is append-only and in validate_build's ledger list. Rows rebuilt from the git history
of data/<sport>/board.json (tools/model_record_rebuild.py) carry "src": "rebuilt" and the commit time they were
first shown at; rows logged by the pipeline carry "src": "live".

    python3 model_record.py            the record by sport and list
    python3 model_record.py grade      settle every finished play (all sports)
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import picks as PK

LOG = PK.DIR / "model_log.json"


def load():
    rows = PK._load(LOG, [])
    return rows if isinstance(rows, list) else []


SUMMARY = PK.DIR / "model_record.json"


def save(rows):
    PK.DIR.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    write_summary(rows)


def write_summary(rows):
    """data/picks/model_record.json: what the pages show (the full log is too big to load on a phone): the record
    by sport and by list, where it starts, how much of it was rebuilt, and each sport's 25 latest graded plays."""
    R = record(rows)
    titles = {f"{r['sport']}:{r['cat']}": r.get("cat_title") for r in rows}
    for k, v in R["cat"].items():
        v["title"] = titles.get(k)
    recent = {}
    for r in sorted((r for r in rows if r.get("result")), key=lambda r: (r.get("start") or "", r.get("id")), reverse=True):
        L = recent.setdefault(r["sport"], [])
        if len(L) < 25:
            L.append({k: r.get(k) for k in ("date", "cat", "label", "matchup", "price", "chance", "result", "actual", "profit", "src")})
    dates = sorted(r["date"] for r in rows)
    out = {"generated": PK._iso(PK._now()), "since": dates[0] if dates else None,
           "rebuilt": sum(1 for r in rows if r.get("src") == "rebuilt"), "live": sum(1 for r in rows if r.get("src") == "live"),
           **R, "recent": recent}
    SUMMARY.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")


def who_key(r):
    """Ask Onyx's WHO: a player, or a game's side / total."""
    return r.get("who") if r.get("kind") == "prop" else f"{r.get('gid')}:{r.get('kind')}"


def select(T, now):
    """{list key: [rows]} the page shows at `now` (sport_shell.html topsHtml)."""
    out = {}
    for L in (T or {}).get("lists") or []:
        games, who, rows = set(), set(), []
        for r in L.get("rows") or []:
            if len(rows) >= L["n"]:
                break
            st = PK._when(r.get("start"))
            w = who_key(r)
            if not st or st <= now or r.get("gid") in games or w in who:
                continue
            games.add(r.get("gid"))
            who.add(w)
            rows.append(r)
        out[L["key"]] = (L, rows)
    return out


def key(sport, cat, r):
    return (sport, cat, str(r.get("gid")), str(r.get("who")), str(r.get("mkt") or r.get("market")))


def log(sport, T, now=None, rows=None, src="live"):
    """Log the plays the page shows now whose game is today. Returns how many were added (writes only when
    `rows` is not passed in: the rebuild passes its own list and saves once)."""
    now = now or PK._now()
    own = rows is None
    rows = load() if own else rows
    have = {(r["sport"], r["cat"], str(r.get("gid")), str(r.get("who")), str(r.get("market"))) for r in rows}
    per = {}
    for r in rows:
        k = (r["sport"], r["cat"], r["date"])
        per[k] = per.get(k, 0) + 1
    today = (now.astimezone(PK.ET) - timedelta(hours=4)).date().isoformat()
    added = 0
    for cat, (L, shown) in select(T, now).items():
        for e in shown:
            k = key(sport, cat, e)
            if k in have or e.get("price") is None or e.get("conf") is None or e.get("src") == "market":
                continue
            st = PK._when(e.get("start"))
            d = PK.day_of(st)
            if d != today or per.get((sport, cat, d), 0) >= L["n"]:
                continue
            m = e.get("mkt") or e.get("kind")
            rows.append({"id": f"{sport}-{cat}-{e.get('gid')}-{e.get('who')}-{m}", "sport": sport, "cat": cat,
                         "cat_title": L.get("title"), "date": d, "logged_at": PK._iso(now), "src": src,
                         "start": e.get("start"), "gid": e.get("gid"), "matchup": e.get("matchup"),
                         "label": e.get("label"), "market": m, "kind": e.get("kind"), "name": e.get("name"),
                         "team": e.get("team"), "who": e.get("who"), "side": e.get("side"), "line": e.get("line"),
                         "hcap": e.get("hcap"), "price": e["price"], "chance": e["conf"], "edge": e.get("edge"),
                         "sel": e.get("sel"), "result": None, "actual": None, "profit": None, "graded_at": None})
            have.add(k)
            per[(sport, cat, d)] = per.get((sport, cat, d), 0) + 1
            added += 1
    if own and added:
        save(rows)
        print(f"  model record: logged {added} {sport} model pick(s)")
    return added


def grade(sports=None, now=None, rows=None):
    """Settle every pending play whose game is final (picks.resolve). Returns how many were graded."""
    now = now or PK._now()
    own = rows is None
    rows = load() if own else rows
    cache, n = {}, 0
    for r in rows:
        if r.get("result") or (sports and r["sport"] not in sports):
            continue
        try:
            got = PK.resolve(r, cache, now)
        except Exception as x:
            print(f"  model record: grade {r.get('id')}: {str(x)[:100]}")
            got = None
        if not got:
            continue
        r["result"], r["actual"] = got
        r["profit"] = round(PK.payout(r["price"]), 4) if got[0] == "W" else -1.0 if got[0] == "L" else 0.0
        r["graded_at"] = PK._iso(now)
        n += 1
    if own and n:
        save(rows)
        print(f"  model record: graded {n}")
    return n


def record(rows=None):
    """W-L, units and ROI (one unit a play, at the price logged) by sport and by sport + list."""
    rows = load() if rows is None else rows

    def agg(rs):
        w = sum(1 for r in rs if r.get("result") == "W")
        l_ = sum(1 for r in rs if r.get("result") == "L")
        u = sum(r.get("profit") or 0.0 for r in rs if r.get("result"))
        return {"w": w, "l": l_, "p": sum(1 for r in rs if r.get("result") in ("P", "V")),
                "pending": sum(1 for r in rs if not r.get("result")), "units": round(u, 2),
                "roi": round(u / (w + l_), 4) if w + l_ else None}
    out = {"all": agg(rows), "sport": {}, "cat": {}}
    by_s, by_c = {}, {}
    for r in rows:
        by_s.setdefault(r["sport"], []).append(r)
        by_c.setdefault(f"{r['sport']}:{r['cat']}", []).append(r)
    out["sport"] = {k: agg(v) for k, v in by_s.items()}
    out["cat"] = {k: agg(v) for k, v in by_c.items()}
    return out


def hook(sport, T):
    """daily_top.write_tops: grade this sport's finished plays, then log today's. Fail-soft, and silent on the
    lines-only and dry runs (their commits carry no record)."""
    import os
    if os.environ.get("NBA_LINES_ONLY") == "1" or os.environ.get("ONYX_PICKS_DRY") == "1":
        return
    try:
        if any(not r.get("result") and r["sport"] == sport for r in load()):
            grade([sport])
    except Exception as x:
        print(f"  model record: grading skipped ({str(x)[:120]})")
    try:
        log(sport, T)
    except Exception as x:
        print(f"  model record: logging skipped ({str(x)[:120]})")


if __name__ == "__main__":
    if (sys.argv[1:] or [""])[0] == "grade":
        print(f"graded {grade(sys.argv[2:] or None)}")
    print(json.dumps(record(), indent=1))
