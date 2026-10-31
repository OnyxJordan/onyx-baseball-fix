#!/usr/bin/env python3
"""
nba_build.py - build nba.html from nba_shell.html (MLB's index.html is never
touched).

  1. picks today's slate: OpticOdds files (data/nba/) first, the ESPN backup
     (data/nba/espn/) otherwise
  2. projects every rostered player (nba_model.project_slate)
  3. prices each projection against the Onyx line (data/nba/props.json)
  4. grades pending picks in the public ledger, then appends any newly
     qualified ones (data/nba/picks_history.json, append-only, odds frozen at
     the moment a play qualifies)
  5. injects one global, NBA_DATA, into the shell

The ledger is the public record: rows are only ever added or graded, never
removed or re-priced. A pick whose player never logs a minute is a void.

    python3 nba_build.py
"""

import json, os, re, sys
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

import nba_common
from nba_common import DATA, current_season, game_day, load, save, nk
import nba_model as M
from nba_model import role_gap, VERSION, project_slate, price_side, STATS

SHELL, OUT = "nba_shell.html", "nba.html"
LEDGER = "picks_history.json"
TICKETS = "ticket_history.json"     # the Model's Parlay, one $10 ticket per slate
TICKET_LOCK = "ticket_lock.json"     # today's ticket, refreshed until the first tip, then frozen
# The Model's Parlay: the algorithm's best look to WIN. Replayed on 2025-26 at
# Onyx prices (main lines), chosen on Oct-Jan, judged on Feb-Apr: picking the
# 3 highest blended win chances (any of pts / reb / ast, either side, one per
# game and player) hit 28.6% at opening / 22.4% at closing prices (claimed
# 24%), against 12.2% / 4.1% for top-scorer overs. Main lines only (the
# history has no alternate ladders to prove them on).
# 10/30: MAINSTREAM LEGS. Jordan: -179 / -195 legs are not listed on every book
# and the ticket should be starters on standard prices. The replay (2025-26,
# 142 slates, v7, Onyx prices) put the old -400..+150 / 24 min ticket at -18%
# at both opening and closing prices (median leg -176); -150..+150 with 28+
# projected minutes: -14% at the open, +19% at the close (median leg -146).
# No version is proven at ~140 tickets; this one is no worse and plays like
# a ticket people actually bet.
TICKET_LEGS, TICKET_MIN_LEGS, TICKET_MIN_MIN = 3, 2, 28.0
TICKET_PRICE = (-150, 150)
STAKE = 10.0

# Picks lane (v1). Deliberately strict: an honest lane is a quiet lane.
# v2 band from the backtest (tools/nba_backtest.py): chosen on Oct-Jan 2025-26,
# test Feb-Apr 74-63 +5.6% at Onyx opening prices. With the 20/80 blend a
# real edge is small; 5pp+ almost never happens and was not profitable.
PICK_MIN_EDGE = 0.02          # blended prob minus listed implied
PICK_MAX_EDGE = 0.08          # bigger "edges" are usually the model missing news
PICK_MIN_SIGNALS = 2          # of last season / this season / last 5 on the pick's side
PICK_PRICE = (-180, 150)
PICK_MIN_MIN = 24.0           # projected minutes
PICK_MAX_GAP = 1.5           # role-mismatch guard: projection >1.5 SD off the line is a role
                             # disagreement, not an edge (backtest: model side 47-50% there)
PICK_LOCK_H = 3.0             # an UNSETTLED game's picks wait for the last 3 hours before tip: a team on
                              # the second night of a back-to-back (those reports land in the afternoon)
                              # or a 15+ min player listed questionable / day-to-day. 10/26: OKC (b2b)
                              # locked Ajay Mitchell Under 15.5 at 5 AM ET; Holmgren was ruled out at
                              # 2:30 PM ET and the projection flipped (he scored 30). Settled games still
                              # lock early: the lane's edge is at opening prices (v5 changelog).
PICK_MAX_PER_GAME = 2
PICK_MAX_PER_SLATE = 6
PICK_MAX_LINE_AGE_MIN = 20    # never log a pick off Onyx prices older than this (a failed odds pull
                              # leaves the last props.json in place: its edges are against stale lines)
# NBA_LINES_ONLY=1 (nba_lines.yml, every 10 min through the evening): re-price
# and rebuild the page from fresh Onyx lines without touching any ledger -
# no grading, no new picks, no ticket changes. The full refresh owns those.
LINES_ONLY = os.environ.get("NBA_LINES_ONLY") == "1"


def line_age_min(props, now=None):
    """Minutes since props.json was fetched; None when it has no time."""
    try:
        t = datetime.fromisoformat(str(props.get("fetched")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return ((now or datetime.now(timezone.utc)) - t).total_seconds() / 60.0
VOID_AFTER_DAYS = 3


def pick_source(today):
    for sub, src in (("", "optic"), ("espn/", "espn")):
        s = load(sub + "slate.json", {})
        if s.get("date") == today and s.get("games"):
            return sub, src, s
    return "", "none", {"date": today, "games": [], "players": []}


def merge_lines(slate, props):
    for g in slate["games"]:
        gl = (props.get("games") or {}).get(f"{g['away']}_{g['home']}") or {}
        for k in ("spread", "total", "away_ml", "home_ml", "away_ml_sel", "home_ml_sel", "slug",
                  "away_spread", "away_spread_price", "away_spread_sel", "home_spread", "home_spread_price", "home_spread_sel",
                  "over_price", "over_sel", "under_price", "under_sel",
                  "q1_total", "q1_over_price", "q1_over_sel", "q1_under_price", "q1_under_sel",
                  "h1_total", "h1_over_price", "h1_over_sel", "h1_under_price", "h1_under_sel",
                  "q1_away_ml", "q1_away_ml_sel", "q1_home_ml", "q1_home_ml_sel"):
            if gl.get(k) is not None:
                g[k] = gl[k]
        if g.get("total") and g.get("spread") is not None:
            home = (g["total"] - g["spread"]) / 2.0
            g["home_implied"], g["away_implied"] = round(home, 1), round(g["total"] - home, 1)
        else:
            g["home_implied"] = g["away_implied"] = None


def attach_props(rows, props, source):
    book = props.get("players") or {}
    by_pid = {v.get("optic_pid"): v for v in book.values() if v.get("optic_pid")}
    priced = 0
    for r in rows:
        rec = (by_pid.get(r["pid"]) if source == "optic" else None) or book.get(nk(r["name"]))
        r["props"] = {}
        if not rec or r["out"]:
            continue
        r["bets"] = bet_ladders(r, rec)
        if (rec.get("fb") or {}).get("yes") is not None:
            r["fb"] = rec["fb"]   # Onyx first basket (incl. FT): the page's first-basket lean
        for s in STATS:
            mkt = rec.get(s)
            if not mkt:
                continue
            best = price_side(r["proj"][s], s, mkt)
            if not best:
                continue
            for side in ("over", "under"):
                if side in best["all"]:
                    best["all"][side]["sel"] = mkt.get(side + "_sel")
            # projection and line describe different roles: show it, never call it an edge
            best["gap"] = round(role_gap(r["proj"][s], best["line"], s), 2)
            best["role_flag"] = best["gap"] > PICK_MAX_GAP
            r["props"][s] = best
            priced += 1
    return priced


BET_STATS = ("pts", "reb", "ast", "fg3", "pra", "pr", "pa")


TIP_LINES = "tip_lines.json"


def hold_tip_lines(rows, games, today):
    """Onyx takes a player's pregame props down at tip, so a live or finished
    game came back with "no line" in Points watch. Every build keeps the last
    pregame main line per player (data/nba/tip_lines.json, today only) and a
    started game shows it, marked closed: no selection ids, so no bet button,
    and picks / the Top 10 / the parlay only ever read untipped games."""
    T = load(TIP_LINES, {}) or {}
    if T.get("date") != today:
        T = {"date": today, "p": {}}
    for r in rows:
        if (games.get(r["gid"]) or {}).get("state", "pre") == "pre":
            if r["props"]:
                T["p"][r["pid"]] = r["props"]
            continue
        for s_, b in (T["p"].get(r["pid"]) or {}).items():
            if s_ not in r["props"]:
                r["props"][s_] = dict(b, closed=True, all={side: {k: v for k, v in a.items() if k != "sel"}
                                                           for side, a in (b.get("all") or {}).items()})
    save(TIP_LINES, T)


def bet_ladders(r, rec):
    """Every Onyx line on this player for the bet card. Per stat, rows of
    [line, over, over_sel, under, under_sel, p_model, p_blend] (P of the
    OVER), low to high. p_blend = 20% model / 80% Onyx fair, the main lane's
    blend: the fair chance is the listed price with the margin measured on
    this player's two-sided main line taken out (alternates are over-only).
    Threes use an unfitted shape (labelled on the card, never recommended);
    double-double / triple-double carry the price only."""
    out = {}
    for s in BET_STATS:
        mk = (rec or {}).get(s)
        if not mk:
            continue
        io, iu = M.implied(mk.get("over")), M.implied(mk.get("under"))
        vig = (io + iu) if io and iu and 1.0 <= io + iu <= 1.2 else 1.05
        lad = mk.get("ladder") or [[mk["line"], mk.get("over"), mk.get("over_sel"), mk.get("under"), mk.get("under_sel")]]
        mean = r["proj"].get(s, 0.0) if s not in M.COMBOS else sum(r["proj"].get(x, 0.0) for x in M.COMBOS[s])
        rows = []
        for line, op, osel, up, usel in lad:
            if op is None and up is None:
                continue
            if s == "fg3":
                pm = M.prob_over_fg3(mean, line)
            elif s in M.COMBOS:
                pm = M.prob_over_combo(r["proj"], s, line)
            else:
                po, pp_ = M.prob_over(mean, float(line), s)
                pm = po / (1 - pp_) if pp_ < 1 else po
            if op is not None and up is not None:
                ia, ib = M.implied(op), M.implied(up)
                fair = ia / (ia + ib)
            else:
                fair = min(0.985, M.implied(op) / vig) if op is not None else 1 - min(0.985, M.implied(up) / vig)
            pb = M.MODEL_WEIGHT * pm + (1 - M.MODEL_WEIGHT) * fair
            rows.append([line, op, osel, up, usel, round(pm, 4), round(pb, 4)])
        if rows:
            out[s] = rows
    for s in ("dd", "td"):
        mk = (rec or {}).get(s)
        if mk and mk.get("over") is not None:
            out[s] = [[0.5, mk.get("over"), mk.get("over_sel"), mk.get("under"), mk.get("under_sel"), None, None]]
    return out


def unsettled_games(rows):
    """Games whose injury picture can still move: either team on a back-to-back's
    second night, or a 15+ minute player questionable / day-to-day."""
    return {r["gid"] for r in rows if r.get("b2b") or (r["inj"] in M.RISK_STATUSES and r["min"] >= 15)}


def qualifies(r, s, pr, game, unsettled=()):
    if not pr or pr["src"] != "onyx" or game.get("state") != "pre":
        return False
    if r["gid"] in unsettled:
        try:
            tip = datetime.fromisoformat(game["start"].replace("Z", "+00:00"))
            if datetime.now(timezone.utc) < tip - timedelta(hours=PICK_LOCK_H):
                return False
        except (KeyError, TypeError, ValueError, AttributeError):
            return False            # no tip time: never lock an unsettled game blind
    if r["out"] or r["inj"] or r["min"] < PICK_MIN_MIN:
        return False
    if not (r["gp"] >= 2 or r["prior_gp"] >= 20):
        return False
    if pr.get("role_flag"):
        return False
    if not (PICK_PRICE[0] <= pr["price"] <= PICK_PRICE[1]):
        return False
    if not (PICK_MIN_EDGE <= pr["edge"] <= PICK_MAX_EDGE and pr["ev"] > 0):
        return False
    return signals(r, s, pr) >= PICK_MIN_SIGNALS


def signals(r, s, pr):
    """How many independent form reads sit on the pick's side of the line:
    last season's average, this season's (2+ games), the last five games.
    The MLB lane's sig >= 2 screen, ported: a projection alone is not enough."""
    over = pr["side"] == "over"
    reads = []
    if r.get("last_season"):
        reads.append(r["last_season"][s])
    if r.get("season") and r["gp"] >= 2:
        reads.append(r["season"][s])
    l5 = [g[s] for g in r.get("last5") or [] if g.get("min", 0) > 0]
    if len(l5) >= 3:
        reads.append(sum(l5) / len(l5))
    return sum(1 for v in reads if (v > pr["line"]) == over and v != pr["line"])


def engine_card(slate, tg, lg, hist=None, th=None):
    """The live model's own weights and tonight's team environment, for the
    Model tab: the page reads these instead of restating them in copy, so
    what it says can never drift from what the model does."""
    teams = []
    for g in slate.get("games", []):
        for t, o in ((g["away"], g["home"]), (g["home"], g["away"])):
            tp, op = M.team_profile(tg, t, lg, th), M.team_profile(tg, o, lg, th)
            teams.append({"team": t, "opp": o, "gp": tp["n"], "pace": round(tp["poss"], 1),
                          "ortg": round(tp["ortg"], 1), "drtg": round(tp["drtg"], 1), "net": round(tp["net"], 1),
                          "game_poss": round(tp["poss"] * op["poss"] / lg["poss"], 1)})
    return {"version": M.VERSION, "P": dict(M.P), "sd": {k: list(v) for k, v in M.SD.items()},
            "w": M.MODEL_WEIGHT, "prior_games": M.PRIOR_GAMES_K, "rate_prior": M.RATE_PRIOR_MIN,
            "use_prior": M.USE_PRIOR_MIN,
            "lane": {"min_edge": PICK_MIN_EDGE, "max_edge": PICK_MAX_EDGE, "signals": PICK_MIN_SIGNALS,
                     "price": list(PICK_PRICE), "min_min": PICK_MIN_MIN, "max_gap": PICK_MAX_GAP,
                     "per_game": PICK_MAX_PER_GAME, "per_slate": PICK_MAX_PER_SLATE, "lock_h": PICK_LOCK_H},
            "teams": teams, "H": {k: (list(v) if isinstance(v, tuple) else v) for k, v in M.H.items()},
            "aging": aging_card(hist)}


def aging_card(hist):
    """The fitted age curve as the Model tab shows it: per-year change in
    points per minute and in minutes per game at a few ages, at the strength
    the model applies (H["age_k"])."""
    P = (hist or {}).get("players") or {}
    if not P:
        return []
    cur = int(hist.get("_ref") or 0)
    ag = M.fit_aging(P, cur - 1, cur)
    k = M.H["age_k"]
    out = []
    for age in (20, 22, 24, 26, 28, 30, 32, 34):
        pts = ag.get("pts", {}).get(age)
        mn = ag.get("min", {}).get(age)
        if pts is None or mn is None:
            continue
        out.append({"age": age, "pts": round(100 * (pow(2.718281828, k * pts) - 1), 1), "min": round(k * mn, 1)})
    return out


def payout(price):
    return price / 100.0 if price > 0 else 100.0 / -price


def grade(ledger, today):
    """Settle pending rows from the box scores of the source each pick came from."""
    stores = {}
    n = 0
    for k in ledger:
        if k.get("result"):
            continue
        sub = "espn/" if k.get("data_src") == "espn" else ""
        if sub not in stores:
            stores[sub] = load(sub + "player_games.json", {})
        pg = stores[sub]
        if k["gid"] in set(pg.get("_games", [])):
            g = next((x for x in (pg.get(k["pid"]) or {}).get("g", []) if x[1] == k["gid"]), None)
            if not g or g[4] <= 0:
                k["result"], k["actual"] = "V", None          # never played: void
            else:
                actual = {"pts": g[5], "reb": g[6], "ast": g[7]}[k["stat"]]
                k["actual"] = actual
                if actual == k["line"]:
                    k["result"] = "P"
                elif (actual > k["line"]) == (k["side"] == "over"):
                    k["result"] = "W"
                else:
                    k["result"] = "L"
            k["graded_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            n += 1
        elif date.fromisoformat(k["date"]) < date.fromisoformat(today) - timedelta(days=VOID_AFTER_DAYS):
            k["result"], k["actual"] = "V", None              # postponed / never final
            n += 1
    return n


# ── the daily Top Scorer Parlay, tracked like the MLB Model's Ticket ─────────
def ticket_legs(rows, games):
    """The Model's Parlay: the three Onyx main-line legs with the highest
    blended win chance (20% model / 80% Onyx no-vig, the board's number),
    any of points / rebounds / assists, over or under, priced -150..+150,
    projected 28+ minutes (starters on standard prices), healthy, untipped, one leg per game and per player."""
    cands = []
    for r in rows:
        if r["out"] or r["inj"] or r["min"] < TICKET_MIN_MIN:
            continue
        if (games.get(r["gid"]) or {}).get("state") != "pre":
            continue
        for s_, pr in (r.get("props") or {}).items():
            if pr.get("src") != "onyx":
                continue
            for side, a in (pr.get("all") or {}).items():
                if not a.get("sel") or a.get("prob") is None or a.get("price") is None:
                    continue
                if not (TICKET_PRICE[0] <= a["price"] <= TICKET_PRICE[1]):
                    continue
                cands.append((a["prob"], r, s_, side, pr, a))
    cands.sort(key=lambda c: -c[0])
    out, g_used, p_used = [], set(), set()
    for prob, r, s_, side, pr, a in cands:
        if len(out) >= TICKET_LEGS:
            break
        if r["gid"] in g_used or r["pid"] in p_used:
            continue
        g_used.add(r["gid"]); p_used.add(r["pid"])
        out.append({"pid": r["pid"], "player": r["name"], "team": r["team"], "opp": r["opp"], "gid": r["gid"],
                    "stat": s_, "side": side, "line": pr["line"], "odds": a["price"], "prob": prob,
                    "proj": r["proj"][s_], "sel": a["sel"], "hit": None})
    return out


def write_top(rows, games, today_rows, open_led, today):
    """data/nba/top.json for the home page's Top 10 (daily_top.py): every Onyx
    main-line prop side for a starter (28+ projected minutes, the parlay's
    mainstream bar) and every 1st-quarter total the on-trial model reads."""
    import daily_top as DT, open_lanes as OL
    tracked = {k.get("sel") for k in today_rows if k.get("sel")}
    trial = {k.get("sel") for k in open_led if k.get("date") == today and k.get("sel")}
    tag = lambda sel: "tracked" if sel in tracked else "trial" if sel in trial else "lean"
    out, board = [], []
    for r in rows:
        g = games.get(r["gid"]) or {}
        if r["out"] or r["inj"] or g.get("state") != "pre":
            continue
        for s_, pr in (r.get("props") or {}).items():
            if pr.get("src") != "onyx" or pr.get("closed"):
                continue
            for side, a in (pr.get("all") or {}).items():
                c = {"kind": "prop", "mkt": s_, "name": r["name"], "pid": r["pid"], "team": r["team"], "side": side, "line": pr["line"],
                     "price": a.get("price"), "prob": a.get("prob"), "edge": a.get("edge"), "sel": a.get("sel"),
                     "gid": r["gid"], "matchup": f"{g.get('away')} @ {g.get('home')}", "start": g.get("start")}
                if not a.get("sel") or c["price"] is None or c["prob"] is None:
                    continue
                board.append(dict(DT.entry("nba", c, tag(a.get("sel"))), proj=(r.get("proj") or {}).get(s_), min=r["min"]))
                if r["min"] >= TICKET_MIN_MIN and DT.ok(c):
                    out.append(DT.entry("nba", c, tag(a.get("sel"))))
    for g in games.values():
        if g.get("state") != "pre" or g.get("q1_total") is None or not g.get("total"):
            continue
        po = 1 - OL._phi((g["q1_total"] - g["total"] * OL.P["q1"]) / OL.P["q1_sd"])
        for side, p in (("over", po), ("under", 1 - po)):
            price, sel = g.get(f"q1_{side}_price"), g.get(f"q1_{side}_sel")
            if price is None or not sel:
                continue
            c = {"kind": "prop", "mkt": "q1_total", "name": f"{g['away']} @ {g['home']}", "pid": "q1", "team": g["away"], "side": side,
                 "line": g["q1_total"], "price": price, "prob": p, "edge": p - OL.implied(price), "sel": sel,
                 "gid": g["gid"], "matchup": f"{g['away']} @ {g['home']}", "start": g.get("start")}
            board.append(DT.entry("nba", c, tag(sel)))
            if DT.ok(c):
                out.append(DT.entry("nba", c, tag(sel)))
    DT.write_board(Path("data/nba"), "nba", today, board)
    return DT.write(Path("data/nba"), "nba", today, out)


def slate_started(slate, now=None):
    """The first tip: any game no longer 'pre', or the earliest start time passed."""
    now = now or datetime.now(timezone.utc)
    for g in slate.get("games", []):
        if g.get("state") in ("live", "post"):
            return True
        try:
            if g.get("start") and datetime.fromisoformat(str(g["start"]).replace("Z", "+00:00")) <= now:
                return True
        except ValueError:
            pass
    return False


def update_ticket(rows, games, slate, today, source):
    """Refresh today's ticket until the first tip, then freeze it into the
    ledger exactly once (the MLB rule: locked at first pitch, never edited)."""
    lock = load(TICKET_LOCK, {})
    if lock.get("date") != today:
        lock = {"date": today, "locked": False, "legs": []}
    if not lock.get("locked"):
        if slate_started(slate):
            lock["locked"] = True
            if len(lock["legs"]) >= TICKET_MIN_LEGS:
                hist = load(TICKETS, [])
                if not any(t.get("date") == today for t in hist):
                    hist.append({"date": today, "stake": STAKE, "data_src": source, "legs": lock["legs"],
                                 "result": None, "pnl": None,
                                 "locked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
                    save(TICKETS, hist, indent=1)
                    print(f"  ticket: locked {len(lock['legs'])}-leg parlay for {today}")
        else:
            legs = ticket_legs(rows, games)
            lock["legs"] = legs if len(legs) >= TICKET_MIN_LEGS else []
        save(TICKET_LOCK, lock, indent=1)
    return lock


def dec_odds(price):
    return 1 + payout(price)


def grade_tickets(today):
    """Settle each ticket leg off the box score: over the line = hit, under =
    miss, never played = void (drops out of the payout, as on MLB). The
    ticket wins only if every live leg hits; all legs void = void."""
    hist = load(TICKETS, [])
    stores, n = {}, 0
    for t in hist:
        if t.get("result"):
            continue
        sub = "espn/" if t.get("data_src") == "espn" else ""
        if sub not in stores:
            stores[sub] = load(sub + "player_games.json", {})
        pg = stores[sub]
        done = set(pg.get("_games", []))
        stale = date.fromisoformat(t["date"]) < date.fromisoformat(today) - timedelta(days=VOID_AFTER_DAYS)
        for leg in t["legs"]:
            if leg.get("hit") is not None:
                continue
            if leg["gid"] in done:
                g = next((x for x in (pg.get(leg["pid"]) or {}).get("g", []) if x[1] == leg["gid"]), None)
                if not g or g[4] <= 0:
                    leg["hit"], leg["actual"] = "void", None
                else:
                    act = {"pts": g[5], "reb": g[6], "ast": g[7]}[leg.get("stat", "pts")]
                    leg["actual"] = act
                    if act == leg["line"]:
                        leg["hit"] = "void"                       # push: drops out like a DNP
                    else:
                        leg["hit"] = (act > leg["line"]) == (leg.get("side", "over") == "over")
            elif stale:
                leg["hit"], leg["actual"] = "void", None
        if any(l.get("hit") is None for l in t["legs"]):
            continue
        live = [l for l in t["legs"] if l["hit"] != "void"]
        if not live:
            t["result"], t["pnl"] = "void", 0.0
        elif all(l["hit"] is True for l in live):
            d = 1.0
            for l in live:
                d *= dec_odds(l["odds"])
            t["result"], t["pnl"] = "win", round(t["stake"] * (d - 1), 2)
        else:
            t["result"], t["pnl"] = "loss", -t["stake"]
        t["graded_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        n += 1
    if n:
        save(TICKETS, hist, indent=1)
    return hist, n


def summarize_tickets(hist, lock):
    settled = [t for t in hist if t.get("result") in ("win", "loss")]
    w = sum(1 for t in settled if t["result"] == "win")
    pnl = round(sum(t["pnl"] for t in settled), 2)
    staked = sum(t["stake"] for t in settled)
    return {"w": w, "l": len(settled) - w, "pending": sum(1 for t in hist if not t.get("result")),
            "void": sum(1 for t in hist if t.get("result") == "void"),
            "pnl": pnl, "roi": round(pnl / staked, 4) if staked else 0.0,
            "rows": [{**t, "legs": [dict(l) for l in t["legs"]]} for t in reversed(hist)],
            "today": {**lock, "legs": [dict(l) for l in lock["legs"]]} if lock.get("legs") else None}


def headshot_index(slate, hist):
    """name key -> ESPN headshot id for anyone the record mentions: tonight's
    slate first, then the daily ESPN roster map, then every season of
    history.json (which knows every player of the last 8 seasons)."""
    idx = {}
    P = (hist or {}).get("players") or {}
    for season in sorted(P):                      # oldest first, newest wins
        for eid, r in P[season].items():
            idx[nk(r.get("n", ""))] = eid
    for k, eid in load("headshots.json", {}).items():
        if "|" in k:
            idx[k.split("|", 1)[1]] = eid
    for p in slate.get("players", []):
        if p.get("hs"):
            idx[nk(p.get("name", ""))] = str(p["hs"])
    return idx


def summarize(ledger):
    rec = {"w": 0, "l": 0, "p": 0, "v": 0, "pending": 0, "units": 0.0, "dollars": 0.0, "stake": STAKE,
           "by_stat": {s: {"w": 0, "l": 0, "units": 0.0} for s in STATS},
           "started": ledger[0]["date"] if ledger else None}
    for k in ledger:
        res = k.get("result")
        if not res:
            rec["pending"] += 1
            continue
        u = payout(k["price"]) if res == "W" else -1.0 if res == "L" else 0.0
        rec[res.lower()] += 1
        rec["units"] += u
        rec["dollars"] += u * STAKE
        if res in ("W", "L"):
            b = rec["by_stat"][k["stat"]]
            b[res.lower()] += 1
            b["units"] = round(b["units"] + u, 2)
    rec["units"] = round(rec["units"], 2)
    rec["dollars"] = round(rec["dollars"], 2)
    staked = (rec["w"] + rec["l"]) * STAKE
    rec["roi"] = round(rec["dollars"] / staked, 4) if staked else 0.0
    for b in rec["by_stat"].values():
        b["dollars"] = round(b["units"] * STAKE, 2)
    rec["rows"] = [dict(k) for k in reversed(ledger[-200:])]   # copies: the page gets extras, the ledger never does
    return rec


def main():
    today = str(game_day())
    sub, source, slate = pick_source(today)
    print(f"=== Onyx NBA build {today} (source: {source}, model {VERSION}) ===")
    prior = load(sub + "prior.json", {})
    pg = load(sub + "player_games.json", {})
    tg = load(sub + "team_games.json", {})
    props = load("props.json", {})
    if props.get("date") != today:
        props = {}
    merge_lines(slate, props)
    # three past seasons, aged and regressed to role (nba_model.history_prior);
    # last season's box-score prior stays as the fallback for anyone unmatched
    hist = load(sub + "history.json", {}) or load("history.json", {})
    hp, th, roles, n_hist = M.slate_history(slate, hist, current_season(date.fromisoformat(today)))
    prior = {**prior, **hp}
    print(f"  history priors: {n_hist} of {len(slate.get('players', []))} players")
    # on/off splits (nba_onoff.py, data/nba/onoff.json): last season + this one
    import nba_onoff
    oo_state = load("onoff.json", {}) or {}
    oo = nba_onoff.tonight(oo_state, current_season(date.fromisoformat(today)), M.P["oo_prev"]) if oo_state.get("seasons") else None
    rows, lg = project_slate(slate, prior, pg, tg, th, roles, oo)
    if oo is not None:
        # for the page: each player's own split without each teammate OUT tonight
        names = {str(r.get("hs")): r["name"] for r in rows if r.get("hs")}
        by_team = {}
        for r in rows:
            by_team.setdefault((r["gid"], r["team"]), []).append(r)
        for rs in by_team.values():
            def mpg(o):   # how much the missing teammate normally plays
                return ((o.get("season") or {}).get("min") or (o.get("baseline") or {}).get("min") or 0)
            outs = [o for o in rs if o["out"] and o.get("hs") and mpg(o) >= 15]
            for r in rs:
                if r["out"] or not r.get("hs") or not outs:
                    continue
                ctx = []
                for o in outs:
                    v = nba_onoff.per36(oo, str(r["hs"]), str(o["hs"]))
                    if v and v["min_off"] >= 60:
                        ctx.append({"name": names.get(str(o["hs"]), o["name"]), "mpg": round(mpg(o), 1), **v})
                if ctx:
                    r["oo_ctx"] = sorted(ctx, key=lambda c: -c["mpg"])[:3]
    priced = attach_props(rows, props, source)
    hold_tip_lines(rows, {g["gid"]: g for g in slate["games"]}, today)

    ledger = load(LEDGER, [])
    n_graded = 0 if LINES_ONLY else grade(ledger, today)
    age = line_age_min(props)
    fresh = age is not None and age <= PICK_MAX_LINE_AGE_MIN
    if not LINES_ONLY and props and not fresh:
        print(f"  picks: Onyx prices are {'of unknown age' if age is None else f'{age:.0f} min old'}; "
              f"none logged until a fresh pull (max {PICK_MAX_LINE_AGE_MIN} min)")
    games = {g["gid"]: g for g in slate["games"]}
    have = {(k["date"], k["pid"], k["stat"]) for k in ledger}
    today_rows = [k for k in ledger if k["date"] == today]
    per_game = {}
    for k in today_rows:
        per_game[k["gid"]] = per_game.get(k["gid"], 0) + 1
    cands = []
    unsettled = unsettled_games(rows)
    for r in rows:
        for s, pr in r["props"].items():
            if qualifies(r, s, pr, games.get(r["gid"], {}), unsettled):
                cands.append((pr["edge"], r, s, pr))
    cands.sort(key=lambda c: -c[0])
    added, used_players = 0, {k["pid"] for k in today_rows}
    for edge, r, s, pr in cands:
        if LINES_ONLY or not fresh:
            break
        if len(today_rows) >= PICK_MAX_PER_SLATE:
            break
        if (today, r["pid"], s) in have or r["pid"] in used_players:
            continue
        if per_game.get(r["gid"], 0) >= PICK_MAX_PER_GAME:
            continue
        row = {"date": today, "gid": r["gid"], "pid": r["pid"], "data_src": source,
               "name": r["name"], "team": r["team"], "opp": r["opp"], "stat": s,
               "side": pr["side"], "line": pr["line"], "price": pr["price"],
               "sel": pr["all"][pr["side"]].get("sel"),
               "proj": r["proj"][s], "prob": pr["prob"], "implied": pr["implied"],
               "edge": pr["edge"], "signals": signals(r, s, pr), "model": VERSION,
               "logged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "result": None, "actual": None}
        ledger.append(row)
        today_rows.append(row)
        used_players.add(r["pid"])
        per_game[r["gid"]] = per_game.get(r["gid"], 0) + 1
        added += 1
    if not LINES_ONLY:
        save(LEDGER, ledger, indent=1)

    # opening-price lanes, on trial (open_lanes.py): capture Onyx's first prices, log
    # plays only while the live price is still the opening one, grade from ESPN
    import open_lanes, nba_jumps
    hs_of = {p["pid"]: p.get("hs") for p in slate.get("players", [])}
    jumps_all = load("jumps.json", {}) or {}
    jp = jumps_all.get("players") or {}
    # [starts, first shots] for tonight's players: the first-basket split (open-v2)
    fshots = nba_jumps.first_shots(jumps_all, today, {str(h) for h in hs_of.values() if h})
    for r in rows:
        r["hs"] = r.get("hs") or hs_of.get(r["pid"])
    if LINES_ONLY:
        open_led, n_open = load(open_lanes.LEDGER, []) or [], 0
    else:
        open_led, n_open_g = open_lanes.grade(today)
        n_open = 0
        if fresh:
            open_led, n_open = open_lanes.run(rows, slate, props, today, jp, fshots)
        print(f"  on trial (opening prices): {n_open_g} graded, +{n_open} logged, {len(open_led)} on record")

    # the daily Top Scorer Parlay: grade past tickets, refresh / lock today's
    if LINES_ONLY:
        lock = load(TICKET_LOCK, {})
        if lock.get("date") != today:
            lock = {"date": today, "locked": False, "legs": []}
    else:
        th_hist, n_tk = grade_tickets(today)
        lock = update_ticket(rows, games, slate, today, source)
    th_hist = load(TICKETS, [])
    tickets = summarize_tickets(th_hist, lock)
    # every record row gets a headshot, not only players on tonight's slate
    hsx = headshot_index(slate, hist)
    record = summarize(ledger)
    for rr in record["rows"] + [l for t in tickets["rows"] for l in t["legs"]] + ((tickets["today"] or {}).get("legs") or []):
        rr["hs"] = hsx.get(nk(rr.get("name") or rr.get("player") or ""))
    media = {p["pid"]: (p.get("hs"), p.get("logo")) for p in slate.get("players", [])}
    players_out = []
    for r in rows:
        if r["min"] < 4 and not r["props"]:
            continue
        out = {k: v for k, v in r.items() if k not in ("prior_gp",)}
        out["hs"], out["img"] = media.get(r["pid"], (None, None))
        # combined-stat projections for the bet card: sums of the three (card only)
        out["proj"] = {**r["proj"], **{c: round(sum(r["proj"].get(x, 0.0) for x in xs), 2) for c, xs in M.COMBOS.items()}}
        players_out.append(out)
    data = {
        "date": today, "source": source, "model_version": VERSION,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "league": lg,
        "meta": {"players_projected": sum(1 for r in rows if not r["out"] and r["min"] >= 10),
                 "priced": priced, "picks": len(today_rows),
                 # games whose picks wait for the last PICK_LOCK_H hours (the page's watchlist says so)
                 "unsettled": sorted(unsettled), "lock_h": PICK_LOCK_H,
                 # when these Onyx prices were pulled: the page shows their age
                 "lines_at": props.get("fetched"), "lines_max_age": PICK_MAX_LINE_AGE_MIN},
        "games": slate["games"], "players": players_out,
        "picks": today_rows, "record": record, "tickets": tickets,
        # 80px team logos baked in (tools/nba_make_logos.py): no third-party
        # host needed at page load
        "logos": load("team_logos.json", {}),
        "engine": engine_card(slate, tg, lg, hist, th),
        # opening-tip records [won, jumped] for tonight's players (nba_jumps.py): the
        # first-basket lean picks each team's jumper and the chance it wins the tip
        "jumps": {h: jp[h] for h in {p.get("hs") for p in players_out} if h in jp},
        # [starts, first shots taken] per starter, decayed by season: the split of
        # a team's chance to score first among its five (open_lanes.fb_probs)
        "fshots": {h: fshots[h] for h in {str(p.get("hs")) for p in players_out} if h in fshots},
        # plays at Onyx's opening price, on trial (open_lanes.py)
        "open": open_lanes.summarize(open_led),
    }
    # today's best plays (home page Top 10 and the top of the Plays tab)
    data["top"] = write_top(rows, games, today_rows, open_led, today)[:10]
    shell = open(SHELL, encoding="utf-8").read()
    # one design system: the MLB stylesheet is copied out of shell.html on
    # every build, so a styling change on the MLB site carries to NBA
    mlb = open("shell.html", encoding="utf-8").read()
    i, j = mlb.find("<style>"), mlb.find("</style>")
    if i < 0 or j < i or shell.count("/*MLB_CSS*/") != 1:
        print("ERROR: MLB stylesheet or its NBA placeholder not found")
        return 1
    shell = shell.replace("/*MLB_CSS*/", mlb[i + len("<style>"):j])
    blob = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    html, n = re.subn(r"/\*NBA_DATA\*/.*?/\*END_NBA_DATA\*/",
                      lambda m: "/*NBA_DATA*/" + blob + "/*END_NBA_DATA*/", shell, flags=re.S)
    if n != 1:
        print("ERROR: NBA_DATA marker not found exactly once in nba_shell.html")
        return 1
    open(OUT, "w", encoding="utf-8").write(html)
    rec = data["record"]
    print(f"  {len(slate['games'])} games, {data['meta']['players_projected']} projected, "
          f"{priced} priced props, {n_graded} graded, +{added} picks "
          f"(today {len(today_rows)}), record {rec['w']}-{rec['l']}-{rec['p']} {rec['units']:+.2f}u"
          f"{' [lines only: no ledger writes]' if LINES_ONLY else ''}")
    print(f"  wrote {OUT} ({len(html) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
