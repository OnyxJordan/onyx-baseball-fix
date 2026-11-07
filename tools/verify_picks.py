#!/usr/bin/env python3
"""
verify_picks.py - Onyx Picks end to end on real finished games (dev only).

For one finished game per sport (NBA, NFL, college football, NHL) it builds Top 10
entries the way daily_top.entry does, logs them through picks.log into a TEMPORARY
ledger (the real data/picks/ledger.json is never touched), then grades them through
picks.grade against ESPN and checks every result against the score / box score read
independently here. Also checks: logged once, never after the start, the daily cap,
and that a non-finalized market is never logged.

    python3 tools/verify_picks.py            # exits 1 on any failure
"""
import json, os, sys, tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import requests                    # noqa: E402
import picks                       # noqa: E402

ESPN = "https://site.api.espn.com/apis/site/v2/sports/"
fails = []


def check(ok, msg):
    print(("  ok   " if ok else "  FAIL ") + msg)
    if not ok:
        fails.append(msg)


def get(path, **p):
    return requests.get(ESPN + path, params=p, timeout=25).json()


def final_event(sport, days):
    """The first finished game on ESPN's scoreboard for one of these days."""
    for d in days:
        sb = get(picks.PATH[sport] + "/scoreboard", dates=d, **({"groups": "80"} if sport == "cfb" else {}))
        for e in sb.get("events") or []:
            if ((e.get("status") or {}).get("type") or {}).get("state") == "post":
                return e
    return None


def side(e):
    c = e["competitions"][0]
    s = {x["homeAway"]: x for x in c["competitors"]}
    return s["home"], s["away"]


def entry(sport, e, mkt, kind, name, side_, line, hcap=None, who=None, gid=None, price=-110, conf=0.56):
    h, a = side(e)
    return {"sport": sport, "label": f"test {mkt}", "matchup": f"{a['team']['abbreviation']} @ {h['team']['abbreviation']}",
            "start": e["date"], "gid": gid or e["id"], "who": who or name, "price": price, "conf": conf, "edge": 0.04,
            "ev": round(conf * (1 + 100 / 110) - 1, 4), "sel": "test-sel", "tag": "lean", "kind": kind, "mkt": mkt,
            "side": side_, "line": line, "hcap": hcap, "name": name, "team": None}


def box_player(sport, eid, group, label):
    """A player with a number in this box group, and that number (read here, not by picks.py)."""
    s = get(picks.PATH[sport] + "/summary", event=eid)
    for t in s["boxscore"]["players"]:
        for st in t["statistics"]:
            if group and st.get("name") != group:
                continue
            labels = st.get("labels") or []
            if label not in labels:
                continue
            for a in st["athletes"]:
                if a.get("stats"):
                    raw = a["stats"][labels.index(label)]
                    v = float(raw.split("/")[1]) if "/" in raw else float(raw)
                    return a["athlete"]["id"], a["athlete"]["displayName"], v
    return None


def main():
    tmp = Path(tempfile.mkdtemp())
    picks.DIR, picks.LEDGER = tmp, tmp / "ledger.json"
    today = datetime.now(timezone.utc)
    days = [(today - timedelta(days=k)).strftime("%Y%m%d") for k in range(1, 8)]
    plan = []          # (sport, entry, expected result, expected actual)
    for sport in ("nba", "nfl", "cfb", "nhl"):
        e = final_event(sport, days)
        if not e:
            check(False, f"{sport}: no finished game in the last week")
            continue
        h, a = side(e)
        hs, as_ = float(h["score"]), float(a["score"])
        H, A = h["team"]["abbreviation"], a["team"]["abbreviation"]
        print(f"{sport}: {A} {as_:g} @ {H} {hs:g} (event {e['id']}, {e['date']})")
        gid = "OPTIC-TEST-" + e["id"] if sport == "nba" else None     # NBA gids come from the odds feed, not ESPN
        tot = hs + as_
        plan.append((sport, entry(sport, e, "total", "total", "Total", "over", tot - 0.5, gid=gid), "W", tot))
        plan.append((sport, entry(sport, e, "ml", "ml", H, "over", 0.0, gid=gid, who=H),
                     "W" if hs > as_ else "L" if hs < as_ else "P", hs - as_))
        plan.append((sport, entry(sport, e, "spread", "spread", A, "over", 3.5, hcap=3.5, gid=gid, who=A),
                     "W" if as_ - hs + 3.5 > 0 else "L", as_ - hs))
        if sport == "nba":
            q1 = sum(float(x["linescores"][0]["value"]) for x in (h, a))
            plan.append((sport, entry(sport, e, "q1_total", "prop", f"{A} @ {H}", "under", q1 + 0.5, gid=gid, who="q1"), "W", q1))
            bp = box_player(sport, e["id"], "", "PTS")
            if bp:
                plan.append((sport, entry(sport, e, "pts", "prop", bp[1], "over", bp[2] - 0.5, gid=gid, who="optic-pid"), "W", bp[2]))
        if sport in ("nfl", "cfb"):
            bp = box_player(sport, e["id"], "rushing", "YDS")
            if bp:
                plan.append((sport, entry(sport, e, "rush_yds", "prop", bp[1], "under", bp[2] + 0.5, who=bp[0]), "W", bp[2]))
        if sport == "nfl":
            bp = box_player(sport, e["id"], "passing", "C/ATT")
            if bp:
                plan.append((sport, entry(sport, e, "pass_att", "prop", bp[1], "over", bp[2] + 0.5, who=bp[0]), "L", bp[2]))
    # every test market counts as finalized for this run only
    picks._FIN = {(sp, en["mkt"]): {"version": "test"} for sp, en, _, _ in plan}
    by_sport = {}
    for sp, en, _, _ in plan:
        by_sport.setdefault(sp, []).append(en)
    # opener markets (picks.OPENER, 11/6) log only at Onyx's first price of the day: give each test play its
    # opening, and check that a play whose price moved off the opener is never logged
    for sp, en, _, _ in plan:
        if (sp, en["mkt"]) in getattr(picks, "OPENER", ()):
            d = picks.day_of(datetime.fromisoformat(en["start"].replace("Z", "+00:00")))
            O = picks._OPEN.setdefault(sp, {"date": d})
            O.setdefault(en["mkt"], {})[f"{en['gid']}|{en['who']}"] = {"line": en["line"], en["side"]: en["price"]}
            st0 = datetime.fromisoformat(en["start"].replace("Z", "+00:00")) - timedelta(hours=1)
            moved = dict(en, price=en["price"] - 15, gid=str(en["gid"]) + "-moved")
            O[en["mkt"]][f"{moved['gid']}|{en['who']}"] = {"line": en["line"], en["side"]: en["price"]}
            check(picks.log(sp, [moved], now=st0) == 0, f"{sp} {en['mkt']}: a price moved off the opener is never logged")
    for sp, es in by_sport.items():
        st = min(datetime.fromisoformat(x["start"].replace("Z", "+00:00")) for x in es)
        before = st - timedelta(hours=1)
        n = picks.log(sp, [dict(x) for x in es], now=before)
        check(n == min(len(es), picks.CAP), f"{sp}: logged {n} of {len(es)} before the start (cap {picks.CAP})")
        check(picks.log(sp, [dict(x) for x in es], now=before) == 0, f"{sp}: a second build logs nothing new (logged once)")
    rows = picks.load()
    check(all(r["result"] is None and r["price"] == -110 for r in rows), "logged rows carry the shown price and no result")
    # after the start nothing is logged
    late = dict(plan[0][1], gid="late-game", who="late")
    check(picks.log(plan[0][0], [late], now=datetime.now(timezone.utc) + timedelta(days=30)) == 0, "a started game is never logged")
    # a market that is not finalized is never logged
    picks._FIN = {}
    other = dict(plan[0][1], gid="other-game", who="other", start=(today + timedelta(days=2)).isoformat())
    check(picks.log(plan[0][0], [other]) == 0, "a market that is not finalized is never logged")
    snapshot = json.dumps([{k: v for k, v in r.items() if k not in ("result", "actual", "profit", "graded_at")} for r in picks.load()], sort_keys=True)
    # grade
    n = picks.grade(now=datetime.now(timezone.utc))
    rows = {(r["sport"], r["market"], str(r["who"])): r for r in picks.load()}
    logged = 0
    for sp, en, want, act in plan:
        r = rows.get((sp, en["mkt"], str(en["who"])))
        if not r:
            continue         # over the daily cap: not logged
        logged += 1
        ok = r["result"] == want and (r["actual"] is None or abs(float(r["actual"]) - act) < 1e-6)
        prof = round(100 / 110, 4) if want == "W" else -1.0 if want == "L" else 0.0
        check(ok and abs((r["profit"] or 0) - prof) < 1e-6,
              f"{sp} {en['mkt']:8s} {en['label'] if False else r['side']} {en['line']}: graded {r['result']} actual {r['actual']} profit {r['profit']} (expected {want}, {act})")
    check(n == logged, f"graded {n} of {logged} logged picks")
    after = json.dumps([{k: v for k, v in r.items() if k not in ("result", "actual", "profit", "graded_at")} for r in picks.load()], sort_keys=True)
    check(after == snapshot, "grading changed nothing but the result fields")
    rec = picks.record()
    print("record:", json.dumps(rec["all"]), {k: (v["w"], v["l"]) for k, v in rec["sport"].items()})
    print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all checks passed'} (temporary ledger {picks.LEDGER})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
