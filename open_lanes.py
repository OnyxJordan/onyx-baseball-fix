#!/usr/bin/env python3
"""
open_lanes.py - NBA plays at Onyx's opening price, tracked in public "on trial".

The backtests found Onyx beatable at its first price and rarely at its last
(first basket +41% at the open on 421 bets, -4% at the close after mid-January;
the 1st-quarter total +7.5% at the open, +3.3% at the close). So:

  capture   the first Onyx price we ever see for each market is written once to
            data/nba/opening.json and never overwritten (timestamped)
  log       a play is logged only when the model beats THAT opening price and the
            live Onyx price is still the opening price, so it was bettable at the
            logged price (odds recorded at the moment the play qualifies)
  grade     after the game from ESPN: the 1st-quarter score, and who scored the
            game's first points (free throws count, Onyx's market)

The ledger (data/nba/open_trial.json) is append-only like every other record and
sits in validate_build's sacred list. "On trial": lanes graduate or get dropped
on this public record, never on the backtest alone.

Lanes:
  q1_total     1Q total = 25.4% of Onyx's game total, sd 12; lean when the model
               is 3+ points above Onyx's implied chance
  first_basket tip winner scores first 65%; jumper record (won+2)/(jumped+4); the
               five starters split it by ((FGA x gp + .9) / (min x gp + 30))^.75;
               value when the model is 20%+ above Onyx's implied chance

Pipeline-safe: ESPN via requests (nba_common.espn_get) only.
"""
import math
from datetime import date, datetime, timedelta, timezone

from nba_common import ESPN, espn_get, load, save, team_abbr

OPENING = "opening.json"
LEDGER = "open_trial.json"
VERSION = "open-v1"
P = {"q1": .254, "q1_sd": 12.0, "q1_edge": .03,
     "fb_g": .75, "fb_q": .65, "fb_a0": .9, "fb_m0": 30.0, "fb_rel": .20, "fb_per_game": 2}
VOID_AFTER_DAYS = 3


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def implied(a):
    return 1.0 / (1 + (a / 100.0 if a > 0 else 100.0 / -a))


def payout(a):
    return a / 100.0 if a > 0 else 100.0 / -a


def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


# ── the first-basket model (the page's fbModel, in Python) ──────────────────
def starters(rows, gid, team):
    roster = [r for r in rows if r["gid"] == gid and r["team"] == team and not r["out"]]
    rate = lambda r: ((r.get("season") or {}).get("starts") or 0) / max(1, (r.get("season") or {}).get("gp") or 1)
    return sorted(roster, key=lambda r: (-rate(r), -r["min"]))[:5]


def fb_probs(rows, game, jumps):
    """{pid: probability} for the ten projected starters, or {} without two full fives."""
    T = {t: starters(rows, game["gid"], t) for t in (game["away"], game["home"])}
    if any(len(v) < 5 for v in T.values()):
        return {}
    jp = lambda r: jumps.get(str(r.get("hs") or ""), [0, 0])
    jumper = {t: max(v, key=lambda r: jp(r)[1]) for t, v in T.items()}
    rate = lambda r: (jp(r)[0] + 2) / (jp(r)[1] + 4)
    ra, rh = rate(jumper[game["away"]]), rate(jumper[game["home"]])
    tip = {game["away"]: ra / (ra + rh), game["home"]: rh / (ra + rh)}
    out = {}
    for t, five in T.items():
        first = tip[t] * P["fb_q"] + (1 - tip[t]) * (1 - P["fb_q"])
        w = []
        for r in five:
            s = r.get("season") or {}
            gp = s.get("gp") or 0
            w.append((((s.get("fga") or 0) * gp + P["fb_a0"]) / ((s.get("min") or 0) * gp + P["fb_m0"])) ** P["fb_g"])
        W = sum(w) or 1
        for r, wi in zip(five, w):
            out[r["pid"]] = first * wi / W
    return out


# ── capture, then log at the opening price ──────────────────────────────────
def run(rows, slate, props, today, jumps):
    """Capture first-seen prices, log qualifying plays. Returns (ledger, n_logged)."""
    O = load(OPENING, {}) or {}
    if O.get("date") != today:
        O = {"date": today, "q1": {}, "fb": {}}
    pg = (props or {}).get("games") or {}
    ts = _now()
    for g in slate.get("games", []):
        gl = pg.get(f"{g['away']}_{g['home']}") or {}
        if gl.get("q1_total") is not None and g["gid"] not in O["q1"] and g.get("state", "pre") == "pre":
            O["q1"][g["gid"]] = {"line": gl["q1_total"], "over": gl.get("q1_over_price"), "under": gl.get("q1_under_price"),
                                 "total": gl.get("total"), "ts": ts}
    for r in rows:
        fb = r.get("fb") or {}
        key = f"{r['gid']}|{r['pid']}"
        if fb.get("yes") is not None and key not in O["fb"]:
            O["fb"][key] = {"yes": fb["yes"], "ts": ts}
    save(OPENING, O, indent=1)

    ledger = load(LEDGER, []) or []
    have = {(k["date"], k["kind"], k["key"]) for k in ledger}
    added = 0
    for g in slate.get("games", []):
        if g.get("state", "pre") != "pre":
            continue
        gl = pg.get(f"{g['away']}_{g['home']}") or {}
        # 1st-quarter total
        op = O["q1"].get(g["gid"])
        if op and op.get("total"):
            mu = op["total"] * P["q1"]
            po = 1 - _phi((op["line"] - mu) / P["q1_sd"])
            for side, p, price, sel in (("over", po, op["over"], gl.get("q1_over_sel")), ("under", 1 - po, op["under"], gl.get("q1_under_sel"))):
                live = gl.get(f"q1_{side}_price")
                if price is None or live != price or gl.get("q1_total") != op["line"]:
                    continue          # no longer at the opening price: not bettable as logged
                if p - implied(price) >= P["q1_edge"] and (today, "q1_total", g["gid"]) not in have:
                    ledger.append({"date": today, "kind": "q1_total", "key": g["gid"], "gid": g["gid"],
                                   "matchup": f"{g['away']} @ {g['home']}", "away": g["away"], "home": g["home"],
                                   "side": side, "line": op["line"], "price": price, "sel": sel,
                                   "prob": round(p, 4), "implied": round(implied(price), 4), "proj": round(mu, 1),
                                   "opened_at": op["ts"], "logged_at": ts, "model": VERSION, "result": None, "actual": None})
                    have.add((today, "q1_total", g["gid"]))
                    added += 1
        # first basket
        probs = fb_probs(rows, g, jumps)
        n_game = sum(1 for k in ledger if k["date"] == today and k["kind"] == "first_basket" and k["gid"] == g["gid"])
        cands = []
        for r in rows:
            if r["gid"] != g["gid"] or r["pid"] not in probs:
                continue
            op = O["fb"].get(f"{r['gid']}|{r['pid']}"); fb = r.get("fb") or {}
            if not op or fb.get("yes") != op["yes"]:
                continue
            p = probs[r["pid"]]
            if p >= implied(op["yes"]) * (1 + P["fb_rel"]):
                cands.append((p / implied(op["yes"]), r, p, op, fb))
        for rel, r, p, op, fb in sorted(cands, key=lambda c: -c[0]):
            key = f"{r['gid']}|{r['pid']}"
            if n_game >= P["fb_per_game"] or (today, "first_basket", key) in have:
                continue
            ledger.append({"date": today, "kind": "first_basket", "key": key, "gid": g["gid"],
                           "matchup": f"{g['away']} @ {g['home']}", "away": g["away"], "home": g["home"],
                           "pid": r["pid"], "hs": r.get("hs"), "name": r["name"], "team": r["team"],
                           "side": "yes", "line": None, "price": op["yes"], "sel": fb.get("sel"),
                           "prob": round(p, 4), "implied": round(implied(op["yes"]), 4),
                           "opened_at": op["ts"], "logged_at": ts, "model": VERSION, "result": None, "actual": None})
            have.add((today, "first_basket", key))
            n_game += 1
            added += 1
    save(LEDGER, ledger, indent=1)
    return ledger, added


# ── grading from ESPN ───────────────────────────────────────────────────────
def _espn_game(day, away, home, cache):
    if day not in cache:
        cache[day] = espn_get(f"{ESPN}/scoreboard", {"dates": day.replace("-", "")}) or {}
    for e in cache[day].get("events") or []:
        c = (e.get("competitions") or [{}])[0]
        side = {x.get("homeAway"): x for x in c.get("competitors") or []}
        if not side.get("home") or not side.get("away"):
            continue
        if team_abbr(side["home"]["team"]["abbreviation"]) == home and team_abbr(side["away"]["team"]["abbreviation"]) == away:
            return e, side
    return None, None


def grade(today):
    ledger = load(LEDGER, []) or []
    cache, sums, n = {}, {}, 0
    for k in ledger:
        if k.get("result"):
            continue
        e, side = _espn_game(k["date"], k["away"], k["home"], cache)
        done = e is not None and ((e.get("status") or {}).get("type") or {}).get("state") == "post"
        if not done:
            if date.fromisoformat(k["date"]) < date.fromisoformat(today) - timedelta(days=VOID_AFTER_DAYS):
                k["result"], k["actual"] = "V", None
                n += 1
            continue
        if k["kind"] == "q1_total":
            try:
                q1 = sum(float((side[s].get("linescores") or [{}])[0].get("value")) for s in ("away", "home"))
            except Exception:
                continue
            k["actual"] = q1
            k["result"] = "P" if q1 == k["line"] else ("W" if (q1 > k["line"]) == (k["side"] == "over") else "L")
        elif k["kind"] == "first_basket":
            if e["id"] not in sums:
                sums[e["id"]] = espn_get(f"{ESPN}/summary", {"event": e["id"]}) or {}
            plays = sorted((sums[e["id"]].get("plays") or []), key=lambda p: int(p.get("sequenceNumber") or 0))
            first = next((p for p in plays if p.get("scoringPlay")), None)
            if not first:
                continue
            fid = str((((first.get("participants") or [{}])[0]).get("athlete") or {}).get("id") or "")
            k["actual"] = first.get("text")
            k["result"] = "W" if fid and fid == str(k.get("hs") or "") else "L"
        k["graded_at"] = _now()
        n += 1
    save(LEDGER, ledger, indent=1)
    return ledger, n


def summarize(ledger):
    out = {"kinds": {}, "rows": [], "today": []}
    for kind in ("q1_total", "first_basket", "all"):
        rows = [k for k in ledger if kind == "all" or k["kind"] == kind]
        w = sum(1 for k in rows if k["result"] == "W"); l = sum(1 for k in rows if k["result"] == "L")
        units = sum(payout(k["price"]) if k["result"] == "W" else -1.0 if k["result"] == "L" else 0.0 for k in rows)
        out["kinds"][kind] = {"w": w, "l": l, "p": sum(1 for k in rows if k["result"] == "P"),
                              "pending": sum(1 for k in rows if not k["result"]), "units": round(units, 2),
                              "roi": round(units / (w + l), 4) if w + l else None}
    out["rows"] = [dict(k) for k in reversed(ledger[-120:])]
    out["started"] = ledger[0]["date"] if ledger else None
    out["version"] = VERSION
    return out
