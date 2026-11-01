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
  ast_under    assists unders (nba_market.py): Onyx's opening price moved by the
               assists the opponent allows and the line vs his usual range; logged
               when the under beats the opening price by 3+ points
  first_basket tip winner scores first 65%; jumper record (won+2)/(jumped+4); the
               five starters split it by ((FGA x gp + .9) / (min x gp + 30))^.5
               x ((first shots + .4) / (starts + 2))^.25; value when the model
               is 20%+ above Onyx's implied chance

CHANGELOG
  open-v3 (2026-11-01) ASSISTS UNDERS. tools/nba_feature_screen.py tested ~30 statistics
     (minutes and their trend, usage, per-36 rates, starter share, pace, what the
     opponent allows, Onyx's total and spread, rest, back-to-backs) against 49,000
     Onyx 2025-26 points, rebounds and assists lines: P(over) = sigmoid(a + b logit(Onyx
     no-vig) + sum c z(stat)), chosen on lines before 2/1/2026, judged after. Points and
     rebounds: nothing beat Onyx. Assists: the assists the opponent allows (last 15
     games vs the league) and the line against his last-10 average in his own spread.
     On the unseen half, log loss .6845 vs Onyx .6857; unders at 3+ points of edge
     99-78 (+15.1%) before 2/1 and 47-37 (+11.1%) after, 5+ points 15-10 (+18.7%).
     Overs lost (-14.0%), so unders only. Graded off the box score (a player who does
     not play is a void).
     FIX: run() read the opening file with load(OPENING, None), which nba_common.load
     answers with None whatever is on disk, so every run counted as the first look and
     marked every opening price a baseline: from 10/30 to 11/1 the 1st-quarter total and
     first-basket lanes could not log a single play (open_trial.json stayed empty). The
     first look is now decided by whether the file exists.
  open-v2 (2026-10-30) FIRST-SHOT SHARE IN THE FIRST-BASKET SPLIT.
     ESPN's play-by-play (shot log, 2,435 games 2024-26) shows who took each
     team's first field-goal attempt. Teams open with a set for the same man,
     so a starter's share of his team's first shots (this season x1, last x.5,
     the one before x.25; shrunk by 2 starts toward 1 in 5) is information the
     season shot rate misses. Fit on 2024-25, judged on 2025-26 (team-first
     scorer among the ten starters, 1,012 games): log loss 2.2760 -> 2.2694
     (usage alone was 2.3026 -> 2.2760, so this adds about a third again).
     A share of the first THREE shots fit 2024-25 better but tested worse
     (2.2736): dropped. Against Onyx's real 2025-26 prices (1,047 games):
       open,  edge 20%+   v1 45-376 +41.3% (~174u)  ->  v2 57-476 +38.3% (~204u)
       open,  edge 10%+   v1 +17.5%                 ->  v2 +28.1%
       open,  after 1/15  v1 18-151 +23.9%          ->  v2 20-175 +18.5%
       close, edge 20%+   v1 +19.8%                 ->  v2 +12.6%
       log loss vs Onyx's opening prices: v1 2.2777, v2 2.2718 (Onyx 2.3845)
     More accurate in every window; more plays at a similar return at the
     opening price, which is the only price this lane logs at.
     Tested in the same pass and NOT used anywhere: shot-quality "luck" (made
     vs expected points from shot type and distance), referee crews (free
     throws and pace) and travel / rest for points, rebounds and assists. Luck
     moved points MAE 5.354 -> 5.343 on unseen games, the rest nothing; none of
     them changed the props lane at opening prices beyond noise.
  open-v1 (2026-10-29) the lane opens: 1Q total and first basket at Onyx's
     opening price (backtests: +7.5% and +41% at the open).

Pipeline-safe: ESPN via requests (nba_common.espn_get) only.
"""
import math
from datetime import date, datetime, timedelta, timezone

from nba_common import DATA, ESPN, espn_get, load, save, team_abbr

OPENING = "opening.json"
LEDGER = "open_trial.json"
VERSION = "open-v3"
P = {"q1": .254, "q1_sd": 12.0, "q1_edge": .03,
     "fb_g": .5, "fb_q": .65, "fb_a0": .9, "fb_m0": 30.0, "fb_h": .25, "fb_fs0": 2.0,
     "fb_rel": .20, "fb_per_game": 2}
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


def fb_probs(rows, game, jumps, fshots=None):
    """{pid: probability} for the ten projected starters, or {} without two full fives."""
    T = {t: starters(rows, game["gid"], t) for t in (game["away"], game["home"])}
    if any(len(v) < 5 for v in T.values()):
        return {}
    jp = lambda r: jumps.get(str(r.get("hs") or ""), [0, 0])
    fsh = lambda r: (fshots or {}).get(str(r.get("hs") or ""), [0, 0])
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
            n, f = fsh(r)
            w.append((((s.get("fga") or 0) * gp + P["fb_a0"]) / ((s.get("min") or 0) * gp + P["fb_m0"])) ** P["fb_g"]
                     * ((f + P["fb_fs0"] * .2) / (n + P["fb_fs0"])) ** P["fb_h"])
        W = sum(w) or 1
        for r, wi in zip(five, w):
            out[r["pid"]] = first * wi / W
    return out


# ── capture, then log at the opening price ──────────────────────────────────
def _ast_inputs(pg, tg, today):
    """Per player: assists in games played before today; per team: assists allowed per
    game before today; the league's average allowed per team-game before this month."""
    ah = {pid: [g[7] or 0 for g in (rec.get("g") or []) if g[0] < today and (g[4] or 0) > 0]
          for pid, rec in (pg or {}).items() if isinstance(rec, dict)}
    allowed, alls = {}, []
    month = today[:7] + "-01"
    for team, gs in (tg or {}).items():
        if not isinstance(gs, list):
            continue
        xs = sorted((x for x in gs if x.get("d", "9") < today and x.get("opp_ast") is not None), key=lambda x: x["d"])
        allowed[team] = [x["opp_ast"] for x in xs]
        alls += [x["opp_ast"] for x in xs if x["d"] < month]
    if not alls:     # the season's first month: everything before today
        alls = [a for v in allowed.values() for a in v]
    return ah, allowed, (sum(alls) / len(alls)) if alls else None


def run(rows, slate, props, today, jumps, fshots=None, games_log=None, tg=None, source=None):
    """Capture first-seen prices, log qualifying plays. Returns (ledger, n_logged)."""
    import nba_market as NM
    from nba_common import nk
    # the system's first look: every price already up is a baseline, never a play. (11/1: this
    # read load(OPENING, None), which nba_common.load always answers with None, so every
    # run was a "first look" and no play could ever be logged; the file's existence decides.)
    first_run = not (DATA / OPENING).exists()
    O = load(OPENING, {})
    if O.get("date") != today:
        O = {"date": today, "q1": {}, "fb": {}, "ast": {}}
    ast_first = "ast" not in O     # the assists lane's first look today (open-v3): lines already up are baselines
    O.setdefault("ast", {})
    book = (props or {}).get("players") or {}
    by_optic = {v.get("optic_pid"): v for v in book.values() if v.get("optic_pid")}

    def ast_line(r):
        rec = (by_optic.get(r["pid"]) if source == "optic" else None) or book.get(nk(r["name"])) or {}
        m = rec.get("ast") or {}
        return m if None not in (m.get("line"), m.get("over"), m.get("under")) else None
    pg = (props or {}).get("games") or {}
    ts = _now()
    for g in slate.get("games", []):
        gl = pg.get(f"{g['away']}_{g['home']}") or {}
        if gl.get("q1_total") is not None and g["gid"] not in O["q1"] and g.get("state", "pre") == "pre":
            O["q1"][g["gid"]] = {"line": gl["q1_total"], "over": gl.get("q1_over_price"), "under": gl.get("q1_under_price"),
                                 "total": gl.get("total"), "ts": ts, **({"baseline": True} if first_run else {})}
    for r in rows:
        fb = r.get("fb") or {}
        key = f"{r['gid']}|{r['pid']}"
        if fb.get("yes") is not None and key not in O["fb"]:
            O["fb"][key] = {"yes": fb["yes"], "ts": ts, **({"baseline": True} if first_run else {})}
        m = ast_line(r) if not r.get("out") else None
        if m and key not in O["ast"]:
            O["ast"][key] = {"line": m["line"], "over": m["over"], "under": m["under"], "ts": ts,
                             **({"baseline": True} if first_run or ast_first else {})}
    save(OPENING, O, indent=1)
    ah, allowed, lg_allowed = _ast_inputs(games_log, tg, today) if games_log and tg else ({}, {}, None)

    ledger = load(LEDGER, []) or []
    have = {(k["date"], k["kind"], k["key"]) for k in ledger}
    added = 0
    for g in slate.get("games", []):
        if g.get("state", "pre") != "pre":
            continue
        gl = pg.get(f"{g['away']}_{g['home']}") or {}
        # 1st-quarter total
        op = O["q1"].get(g["gid"])
        if op and op.get("total") and not op.get("baseline"):
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
        probs = fb_probs(rows, g, jumps, fshots)
        n_game = sum(1 for k in ledger if k["date"] == today and k["kind"] == "first_basket" and k["gid"] == g["gid"])
        cands = []
        for r in rows:
            if r["gid"] != g["gid"] or r["pid"] not in probs:
                continue
            op = O["fb"].get(f"{r['gid']}|{r['pid']}"); fb = r.get("fb") or {}
            if not op or op.get("baseline") or fb.get("yes") != op["yes"]:
                continue
            p = probs[r["pid"]]
            if p >= implied(op["yes"]) * (1 + P["fb_rel"]):
                cands.append((p / implied(op["yes"]), r, p, op, fb))
        # assists unders (open-v3)
        for r in rows:
            if r["gid"] != g["gid"] or r.get("out") or lg_allowed is None:
                continue
            key = f"{r['gid']}|{r['pid']}"
            op, m = O["ast"].get(key), ast_line(r)
            if not op or op.get("baseline") or not m or (today, "ast_under", key) in have:
                continue
            if (m["line"], m["over"], m["under"]) != (op["line"], op["over"], op["under"]):
                continue          # no longer at the opening price
            f = NM.features(ah.get(r["pid"]) or [], allowed.get(r.get("opp")) or [], lg_allowed, op["line"])
            if f is None:
                continue
            io, iu = implied(op["over"]), implied(op["under"])
            p_under = 1 - NM.prob_over(io / (io + iu), f)
            if p_under - iu < NM.EDGE:
                continue
            ledger.append({"date": today, "kind": "ast_under", "key": key, "gid": g["gid"],
                           "matchup": f"{g['away']} @ {g['home']}", "away": g["away"], "home": g["home"],
                           "pid": r["pid"], "hs": r.get("hs"), "name": r["name"], "team": r["team"], "data_src": source,
                           "side": "under", "line": op["line"], "price": op["under"], "sel": m.get("under_sel"),
                           "prob": round(p_under, 4), "implied": round(iu, 4), "proj": round(f["l10"], 1),
                           "why": NM.why(io / (io + iu), f), "opened_at": op["ts"], "logged_at": ts, "model": VERSION,
                           "result": None, "actual": None})
            have.add((today, "ast_under", key))
            added += 1
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
    stores = {}
    for k in ledger:
        if k.get("result"):
            continue
        if k["kind"] == "ast_under":     # off the box score, like the tracked props (nba_build.grade)
            sub = "espn/" if k.get("data_src") == "espn" else ""
            if sub not in stores:
                stores[sub] = load(sub + "player_games.json", {}) or {}
            pg = stores[sub]
            if k["gid"] in set(pg.get("_games", [])):
                g = next((x for x in (pg.get(k["pid"]) or {}).get("g", []) if x[1] == k["gid"]), None)
                if not g or (g[4] or 0) <= 0:
                    k["result"], k["actual"] = "V", None      # did not play: void
                else:
                    k["actual"] = g[7]
                    k["result"] = "P" if g[7] == k["line"] else ("W" if g[7] < k["line"] else "L")
                k["graded_at"] = _now()
                n += 1
            elif date.fromisoformat(k["date"]) < date.fromisoformat(today) - timedelta(days=VOID_AFTER_DAYS):
                k["result"], k["actual"] = "V", None
                n += 1
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
    for kind in ("q1_total", "first_basket", "ast_under", "all"):
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
