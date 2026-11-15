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
    for r in sorted((r for r in rows if r.get("result") and is_current(r)), key=lambda r: (r.get("start") or "", r.get("id")), reverse=True):
        L = recent.setdefault(r["sport"], [])
        if len(L) < 25:
            L.append({k: r.get(k) for k in ("date", "cat", "label", "matchup", "price", "chance", "result", "actual", "profit", "src")})
    dates = sorted(r["date"] for r in rows if is_current(r))
    out = {"generated": PK._iso(PK._now()), "since": dates[0] if dates else None,
           "rebuilt": sum(1 for r in rows if r.get("src") == "rebuilt"), "live": sum(1 for r in rows if r.get("src") == "live"),
           **R, "recent": recent}
    SUMMARY.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")


# The list rules a row was logged under (11/15). "v1": 10/30-11/15, every list "most likely first". "v2": from 11/15
# (Jordan, after the six-sport audit): NFL Recommended plays (unders in receptions, pass attempts and rushing yards,
# -150 to +150, expected value 10%+) and best value, positive edge only, everywhere else; logged the moment a play
# qualifies, any day before its start, at the price showing. Rows of one rule never block or mix with the other's.
RULE = "v2"
# "v3" (11/15, the tune-ups Jordan approved: "commit everything"): NBA props unders only, no single-stat points, edge
# over 2 points; college football spreads with a 2-point edge and rushing yards unders (its totals turned leans, never
# graded). A sport on a newer rule leads with it; its v2 rows are kept as the previous rule's record ("prev").
RULES = {"nba": "v3", "cfb": "v3"}


def rule_of(r):
    return r.get("rule") or "v1"


def current(sport):
    """The list rule a sport logs and leads with now."""
    return RULES.get(sport, RULE)


def is_current(r):
    return rule_of(r) == current(r["sport"])


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
            if not st or st <= now or (r.get("gid") in games and L.get("mode") != "ev") or w in who:
                continue
            games.add(r.get("gid"))
            who.add(w)
            rows.append(r)
        out[L["key"]] = (L, rows)
    return out


def key(sport, cat, r):
    return (sport, cat, str(r.get("gid")), str(r.get("who")), str(r.get("mkt") or r.get("market")))


def version_now(sport):
    """The sport model's VERSION right now (picks.MODULE), so the record splits by model version (11/14, Jordan:
    show each sport's current-model record first, earlier versions below)."""
    try:
        return PK.live_version(sport, None)
    except Exception:
        return None


def log(sport, T, now=None, rows=None, src="live", model_v=None):
    """Log the plays the page shows now (v2: any game still to start, the moment it qualifies). Returns how many
    were added (writes only when `rows` is not passed in: the rebuild passes its own list and saves once)."""
    now = now or PK._now()
    own = rows is None
    rows = load() if own else rows
    rule = current(sport)
    have = {(r["sport"], r["cat"], str(r.get("gid")), str(r.get("who")), str(r.get("market"))) for r in rows if rule_of(r) == rule}
    per = {}
    for r in rows:
        if rule_of(r) == rule:
            k = (r["sport"], r["cat"], r["date"])
            per[k] = per.get(k, 0) + 1
    added = 0
    for cat, (L, shown) in select(T, now).items():
        if L.get("info"):
            continue          # "most likely to score" lists are information, not picks (11/15): never graded
        for e in shown:
            k = key(sport, cat, e)
            if k in have or e.get("price") is None or e.get("conf") is None or e.get("src") == "market":
                continue
            st = PK._when(e.get("start"))
            d = PK.day_of(st)
            if per.get((sport, cat, d), 0) >= L["n"]:     # v2: early is fine (the price is the one showing)
                continue
            m = e.get("mkt") or e.get("kind")
            rows.append({"id": f"{sport}-{cat}-{e.get('gid')}-{e.get('who')}-{m}-{rule}", "rule": rule, "sport": sport, "cat": cat,
                         "cat_title": L.get("title"), "date": d, "logged_at": PK._iso(now), "src": src,
                         "start": e.get("start"), "gid": e.get("gid"), "matchup": e.get("matchup"),
                         "label": e.get("label"), "market": m, "kind": e.get("kind"), "name": e.get("name"),
                         "team": e.get("team"), "who": e.get("who"), "side": e.get("side"), "line": e.get("line"),
                         "hcap": e.get("hcap"), "price": e["price"], "chance": e["conf"], "edge": e.get("edge"),
                         "sel": e.get("sel"), "model": model_v if model_v is not None else version_now(sport),
                         "result": None, "actual": None, "profit": None, "graded_at": None})
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
    # the current list rule's record leads (sport, cat, ver, src); the earlier rule's is kept under "old"
    old = [r for r in rows if rule_of(r) == "v1"]
    prev = [r for r in rows if rule_of(r) != "v1" and not is_current(r)]
    rows = [r for r in rows if is_current(r)]
    out = {"rule": RULE, "rules": {**RULES}, "all": agg(rows), "sport": {}, "cat": {}, "ver": {}, "src": {}, "old": {}, "prev": {}}
    for key_, src_ in (("old", old), ("prev", prev)):
        for sp in sorted({r["sport"] for r in src_}):
            o = [r for r in src_ if r["sport"] == sp]
            out[key_][sp] = dict(agg(o), start=min(r["date"] for r in o), end=max(r["date"] for r in o))
    for sp in sorted({r["sport"] for r in rows}):
        out["src"][sp] = {k: sum(1 for r in rows if r["sport"] == sp and (r.get("src") or "live") == k) for k in ("replay", "rebuilt", "live")}
    by_s, by_c = {}, {}
    for r in rows:
        by_s.setdefault(r["sport"], []).append(r)
        by_c.setdefault(f"{r['sport']}:{r['cat']}", []).append(r)
    out["sport"] = {k: agg(v) for k, v in by_s.items()}
    # by model version, newest first: {sport: [{"v", "from", "to", ...record}]}
    for sp, rs in by_s.items():
        vs = {}
        for r in rs:
            vs.setdefault(str(r.get("model") or "?"), []).append(r)
        L = [dict(agg(v), v=k, start=min(x["date"] for x in v), end=max(x["date"] for x in v),
                  cat={c: agg([x for x in v if x["cat"] == c]) for c in sorted({x["cat"] for x in v})}) for k, v in vs.items()]
        out["ver"][sp] = sorted(L, key=lambda x: (x["end"], x["start"]), reverse=True)
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
