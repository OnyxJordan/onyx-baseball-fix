#!/usr/bin/env python3
"""
sports_build.py - build <sport>.html from sport_shell.html.

    python3 sports_build.py nfl|cfb|nhl|tennis|golf

Reads data/<sport>/slate.json (sports_espn.py), odds.json (sports_odds.py,
optional) and, for the NFL, player_games.json for nfl_model. Injects the MLB
stylesheet (one design system, like nba_build.py), the sport's key and its
data, and writes <sport>.html. A sport with no slate still builds: the page
says so instead of going blank.
"""

import json, math, re, sys
from datetime import datetime, timezone

from sports_common import Lane, SPORTS, game_day, nk
import sports_lab as L

ONYX_LEAGUE = {"nfl": "NFL", "cfb": "NCAAF", "nhl": "NHL"}

ROADMAP = {
    "nfl": ["Tested 10/26 to 10/31 against two seasons of real Onyx lines (440 games), counting every priced player who played, including games he was never thrown to: receptions unders beat Onyx's opening price in both seasons (+6.1% and +20.1%), so they run on trial at the open; overs did not",
            "Tested 10/31: first-half and first-quarter totals, against how much of a game's total each part has really carried (2025 tuning, 2026 judging, 391 games). The 2025 rule lost at the opening price, so there is nothing to carry forward; always taking the first-half under made +1.8% in 2025 and +12.9% on 106 games in 2026, too few to call it an edge",
            "Tested 10/31: rushing, passing and receiving yards, the current projections and a rebuild from each player's share of his team's carries, dropbacks and targets. None beat Onyx's price in a season it was not tuned on, so they are projections only, never plays",
            "Re-tested 10/31: touchdown scorers lost to Onyx's price in both seasons once players who played without a touch were counted, so the touchdown chance shown is Onyx's price with its margin removed, and no scorer is flagged as value",
            "Tested 10/31: game ratings from every play since 2024 (expected points per play, adjusted for opponent, with scores alongside). On 2026 games they never saw, they made Onyx's spread and total worse, open and close, as the score-only ratings did. NFL sides and totals stay leans",
            "Live 10/31: ESPN's injury report. A player ruled out (out, IR, inactive, doubtful) gets no projection, lean, Top 10 spot or trial play; a questionable player is marked Q and kept out of the Top 10",
            "Touchdown scorer and passing touchdown markets"],
    "cfb": ["Backtest the team ratings against a season of real Onyx spreads and moneylines before any pick",
            "Drive efficiency and tempo in the ratings, so totals beat the league average",
            "Player projections, built on the NFL engine"],
    "nhl": ["Tested 10/29 against a season of real Onyx prices: team ratings, skater points and assists from ice time, and starting goalies. None beat Onyx on games they never saw, so NHL stays leans",
            "Tested 10/31: shot-quality (expected goals) ratings from every NHL shot since 2024 (3,008 games). They helped before mid-January 2025-26 but made Onyx's price worse after it and in the first weeks of 2026-27 (moneyline, puck line and total all lost), so they are not used",
            "Skater shots on goal, if Onyx starts pricing them"],
    "tennis": ["Backtest the Elo ratings against real Onyx match prices before any pick",
               "Surface-specific ratings (hard, clay, grass)",
               "Total games and game spread from a serve and return point model"],
    "golf": ["Onyx does not price golf yet: when it does (outrights, top 10, matchups), the model is tested against those prices before any pick",
             "Recent-event weighting by field strength: beating a signature-event field counts for more than an opposite-field week",
             "LPGA and DP World Tour fields, on the same strokes-gained engine"],
}
METHOD = {
    "football": "Scores, drives, down and distance, win probability and team stats come from ESPN's public feed, refreshed through the day and polled live on this page every 15 to 30 seconds.",
    "hockey": "Scores, periods, goals and team stats come from ESPN's public feed, polled live on this page every 15 to 30 seconds.",
    "tennis": "Every ATP and WTA singles match this week comes from ESPN's public feed, polled live: set scores, who is serving, rounds and results.",
    "golf": "The leaderboard comes from ESPN's public feed, polled live: position, score to par and every round.",
}


OPEN_MAX = None   # nfl_model v8: no daily cap; every under 3pp+ at the open, exactly as the v6 test ran


def team_open_lane(lane, rule, rows, slate, M):
    """A game-line lane on trial at Onyx's opening price (CFB totals since 11/1): the
    first price we see for each market is written once to data/<sport>/opening.json and
    a play is logged (data/<sport>/open_trial.json, append-only) only when the lane's
    rule passes at that opening price and the live line and price are still the opening
    ones. Graded from results.json like the tracked picks."""
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    O = lane.load("opening.json", None)
    first_run = O is None          # the first look: every line already up is a baseline, never a play
    O = O or {}
    ledger = lane.load("open_trial.json", []) or []
    games = {g["gid"]: g for g in slate.get("games") or []}
    for k in [k for k in O if k.split("|")[0] in games and games[k.split("|")[0]].get("state") == "post"]:
        O.pop(k)
    have = {k["key"] for k in ledger}
    cands = []
    for r in rows:
        if r["mkt"] not in rule.get("markets", ()):
            continue
        g = games.get(r["gid"]) or {}
        key = f"{r['gid']}|{r['mkt']}|{r['side']}"
        if key not in O and g.get("state") == "pre":
            O[key] = {"line": r["line"], "price": r["price"], "ts": ts, **({"baseline": True} if first_run else {})}
        op = O.get(key)
        if not op or op.get("baseline") or g.get("state") != "pre" or key in have:
            continue
        if (op["line"], op["price"]) != (r["line"], r["price"]):
            continue          # moved off the opening price: not bettable as logged
        if not (rule["edge_min"] <= r["edge"] <= rule["edge_max"] and rule["price_min"] <= r["price"] <= rule["price_max"]):
            continue
        cands.append((r["edge"], {"date": slate.get("date"), "key": key, "gid": r["gid"], "matchup": r["matchup"], "kind": r["kind"],
                                  "mkt": r["mkt"], "name": r.get("name"), "side": r["side"], "line": r["line"], "price": r["price"],
                                  "sel": r.get("sel"), "prob": r["prob"], "implied": r["implied"], "detail": r.get("detail"),
                                  "opened_at": op["ts"], "logged_at": ts, "model": M.VERSION, "result": None, "actual": None}))
    today_n = sum(1 for k in ledger if k.get("date") == slate.get("date"))
    for e, row in sorted(cands, key=lambda c: -c[0])[:max(0, rule.get("max_per_slate", 6) - today_n)]:
        ledger.append(row)
    resolve = grade_team(lane)
    for k in ledger:
        if k.get("result"):
            continue
        act = resolve(dict(k, team_side=None))
        if act is None:
            continue
        k["actual"] = act
        k["result"] = "P" if act == k["line"] else ("W" if (act > k["line"]) == (k["side"] == "over") else "L")
        k["graded_at"] = ts
    lane.save("opening.json", O, indent=1)
    lane.save("open_trial.json", ledger, indent=1)
    w = sum(1 for k in ledger if k["result"] == "W"); l_ = sum(1 for k in ledger if k["result"] == "L")
    pay = lambda a: a / 100.0 if a > 0 else 100.0 / -a
    units = sum((pay(k["price"]) if k["result"] == "W" else -1.0 if k["result"] == "L" else 0.0) for k in ledger)
    return {"w": w, "l": l_, "p": sum(1 for k in ledger if k["result"] == "P"), "pending": sum(1 for k in ledger if not k["result"]),
            "units": round(units, 2), "roi": round(units / (w + l_), 4) if w + l_ else None,
            "rows": list(reversed(ledger[-80:])), "started": ledger[0]["date"] if ledger else None,
            "note": ("Totals, logged only while Onyx still shows the first total and price we saw for that game, at that price, and "
                     "graded off the final score. They beat Onyx on the 2026 games (+21% at opening prices, +12% at closing) but lost "
                     "at closing prices in 2025 (-20%), so totals are on trial: separate from the graded spreads record until this one "
                     "says otherwise. Six totals logged on 10/31, before this rule, sit on the graded record.")}


def nfl_open_lane(lane, out, slate, season, rows, M):
    """Receptions at Onyx's opening price, on trial. The first price we see for each
    receptions line is written once to data/nfl/opening.json; a play is logged
    (data/nfl/open_trial.json, append-only) only when the v5 model beats that opening
    price by 3pp+ and the live Onyx line is still the opening one. Graded from the box."""
    from datetime import datetime, timedelta, timezone
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    O = lane.load("opening.json", None)
    first_run = O is None          # the system's first look: every line already up is a baseline, never a play
    O = O or {}
    ledger = lane.load("open_trial.json", []) or []
    games = {g["gid"]: g for g in slate.get("games") or []}
    for k in [k for k in O if k.split("|")[0] in games and games[k.split("|")[0]].get("state") == "post"]:
        O.pop(k)    # finished games leave the capture file; their plays live in the ledger
    have = {k["key"] for k in ledger}
    # games we have watched for opening prices (11/1). A game first seen already in this
    # week's slate (next week's fetch missed it) may have lines up for days: they are
    # baselines, never the open. Seeded once with this week's games, watched since 10/30.
    seen = O.setdefault("_seen", {g: ts for g in games} if not first_run else {})
    for g in slate.get("next_games") or []:
        seen.setdefault(g["gid"], ts)
    nxt_games = {g["gid"] for g in slate.get("next_games") or []}
    # v11: the market-model lanes (rushing yards unders, passing yards overs, pass attempts
    # unders) capture their opening prices the same way. A lane's first run marks every line
    # already up as a baseline (it may have opened before we looked); lines that appear
    # after that are opens.
    v11 = getattr(M, "V11", {})
    mkts = ("rec",) + tuple(v11)
    starts = O.setdefault("_lane_start", {})
    new_lanes = [m for m in v11 if m not in starts]
    for m in new_lanes:
        starts[m] = ts
    for p in (lane.load("odds.json", {}) or {}).get("next_props") or []:
        if p.get("mkt") in mkts and p.get("gid") in nxt_games and None not in (p.get("line"), p.get("over"), p.get("under")):
            O.setdefault(f"{p['gid']}|{nk(p['name'])}|{p['mkt']}", {"line": p["line"], "over": p["over"], "under": p["under"],
                                                                    "ts": ts, "next": True,
                                                                    **({"baseline": True} if p["mkt"] in new_lanes else {})})
    fresh = {gid for gid in games if gid not in seen}
    for gid in games:
        seen.setdefault(gid, ts)
    for gid in [g for g, t in seen.items() if t < (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()]:
        seen.pop(gid)
    cands = []
    for r in out:
        if r["mkt"] not in mkts or r["line"] is None or r["over"] is None or r["under"] is None:
            continue
        g = games.get(r["gid"]) or {}
        key = f"{r['gid']}|{nk(r['name'])}|{r['mkt']}"
        if key not in O and g.get("state") == "pre":
            O[key] = {"line": r["line"], "over": r["over"], "under": r["under"], "ts": ts,
                      **({"baseline": True} if first_run or r["gid"] in fresh or r["mkt"] in new_lanes else {})}
        op = O.get(key)
        if not op or op.get("baseline") or g.get("state") != "pre" or key in have:
            continue
        if (op["line"], op["over"], op["under"]) != (r["line"], r["over"], r["under"]):
            continue          # moved off the opening price: not bettable as logged
        if r["mkt"] in v11:
            if r.get("v11") is None:
                continue
            side = v11[r["mkt"]]["side"]
            p = r["v11"] if side == "over" else 1 - r["v11"]
            price, sel = (r["over"], r.get("over_sel")) if side == "over" else (r["under"], r.get("under_sel"))
            if p - L.implied(price) >= M.V11_EDGE:
                cands.append((p - L.implied(price), {"date": slate.get("date"), "season": season, "week": g.get("week"), "key": key,
                               "gid": r["gid"], "pid": r["pid"], "name": r["name"], "team": r["team"], "opp": r["opp"],
                               "matchup": f"{r['team']} {'vs' if r['home'] else '@'} {r['opp']}", "kind": r["mkt"],
                               "lane": f"{r['mkt']}_{side}", "side": side, "line": r["line"], "price": price, "sel": sel,
                               "proj": r["proj"], "prob": round(p, 4), "implied": round(L.implied(price), 4),
                               "why": r.get("why"), "opened_at": op["ts"], "logged_at": ts, "model": M.VERSION,
                               "result": None, "actual": None}))
            continue
        if not r.get("vol"):
            continue
        po = M.prob_over_volume("rec", r["proj"], r["line"])
        for side, p, price, sel in (("over", po, r["over"], r.get("over_sel")), ("under", 1 - po, r["under"], r.get("under_sel"))):
            if side not in getattr(M, "TRIAL_SIDES", ("over", "under")):
                continue          # v6: unders only (overs lost 15% at the open in 2025 once zero-target games count)
            if p - L.implied(price) >= 0.03:
                cands.append((p - L.implied(price), {"date": slate.get("date"), "season": season, "week": g.get("week"), "key": key, "gid": r["gid"],
                               "pid": r["pid"], "name": r["name"], "team": r["team"], "opp": r["opp"],
                               "matchup": f"{r['team']} {'vs' if r['home'] else '@'} {r['opp']}", "kind": "rec",
                               "side": side, "line": r["line"], "price": price, "sel": sel, "proj": r["proj"],
                               "prob": round(p, 4), "implied": round(L.implied(price), 4), "opened_at": op["ts"],
                               "logged_at": ts, "model": M.VERSION, "result": None, "actual": None}))
                break
    # every qualifying under (v8): a daily cap kept the biggest edges, the weakest bets
    today_n = sum(1 for k in ledger if k.get("date") == slate.get("date"))
    for e, row in sorted(cands, key=lambda c: -c[0])[:None if OPEN_MAX is None else max(0, OPEN_MAX - today_n)]:
        ledger.append(row)
    # grade: the receiver's catches from the box score once his game is final
    box = {}
    for x in rows:
        box[(x.get("gid"), nk(x["name"]))] = x
    box_games = {x.get("gid") for x in rows}
    # 11/1: a player with snaps and no box line was never thrown to: 0 catches, the under
    # wins, exactly as the v6 backtest grades him (and as Onyx settles it). Only a player
    # with no snaps is a void. nflverse posts snap counts a day or two after the game, so
    # until that week is in, he stays pending (voided only if it never arrives in 10 days).
    snaps, snap_weeks = set(), set()
    for yr, xv in ((lane.load("nflverse.json", {}) or {}).get("seasons") or {}).items():
        for s_, w_, t_, n_, pct in xv.get("snaps") or []:
            snap_weeks.add((s_, w_, t_))
            if pct:
                snaps.add((s_, w_, t_, n_))
    vt = getattr(M, "VERSE_TEAM", {})
    for k in ledger:
        if k.get("result"):
            continue
        g = games.get(k["gid"])
        x = box.get((k["gid"], nk(k["name"])))
        stat = k.get("kind") or "rec"
        if x is not None:
            a = x.get(stat) or 0
            k["actual"] = a
            k["result"] = "P" if a == k["line"] else ("W" if (a > k["line"]) == (k["side"] == "over") else "L")
            k["graded_at"] = ts
        elif k["gid"] in box_games:
            t_ = vt.get(k.get("team"), k.get("team"))
            if (k.get("season"), k.get("week"), t_, M._vk(k["name"])) in snaps:
                a = 0     # on the field, no catches
                k["actual"] = a
                k["result"] = "P" if a == k["line"] else ("W" if (a > k["line"]) == (k["side"] == "over") else "L")
                k["graded_at"], k["graded_by"] = ts, "snaps, no box line"
            elif (k.get("season"), k.get("week"), t_) in snap_weeks or k.get("date", "9") < (
                    datetime.now(timezone.utc) - timedelta(days=10)).date().isoformat():
                k["result"], k["actual"], k["graded_at"] = "V", None, ts    # no snaps: did not play, a void
    lane.save("opening.json", O, indent=1)
    lane.save("open_trial.json", ledger, indent=1)
    w = sum(1 for k in ledger if k["result"] == "W"); l_ = sum(1 for k in ledger if k["result"] == "L")
    pay = lambda a: a / 100.0 if a > 0 else 100.0 / -a
    units = sum((pay(k["price"]) if k["result"] == "W" else -1.0 if k["result"] == "L" else 0.0) for k in ledger)
    LN = {"rec_under": "Receptions unders", "rush_yds_under": "Rushing yards unders", "pass_yds_over": "Passing yards overs",
          "pass_att_under": "Pass attempts unders"}
    lanes = []
    for ln_ in ["rec_under"] + [f"{m}_{v11[m]['side']}" for m in v11]:
        ks = [k for k in ledger if (k.get("lane") or "rec_under") == ln_]
        ww = sum(1 for k in ks if k["result"] == "W"); ll_ = sum(1 for k in ks if k["result"] == "L")
        lanes.append({"lane": ln_, "name": LN.get(ln_, ln_), "w": ww, "l": ll_, "p": sum(1 for k in ks if k["result"] == "P"),
                      "pending": sum(1 for k in ks if not k["result"]),
                      "units": round(sum((pay(k["price"]) if k["result"] == "W" else -1.0 if k["result"] == "L" else 0.0) for k in ks), 2)})
    note = ("Four NFL lanes, each logged only while Onyx still shows the first price we saw for that line, at that price, and graded off the box score. "
            "Receptions unders (since 10/31): counting every priced player who played, the model's unders beat Onyx's opening price in both seasons tested (+6.1% and +20.1%). "
            "Since 11/1 (v11), three market models that start from Onyx's own price and add the statistics that beat it in a season they never saw: "
            "rushing yards unders (2025 +9.3%, 2026 +11.1%), passing yards overs (+6.9%, +10.0%) and pass attempts unders (+20.0%, +9.1%). "
            "Each play lists why the model got there. At Onyx's closing price these edges mostly disappear, so they count only at the open. "
            "They stay on trial until this record says otherwise.") if v11 else None
    return {"w": w, "l": l_, "p": sum(1 for k in ledger if k["result"] == "P"), "pending": sum(1 for k in ledger if not k["result"]),
            "units": round(units, 2), "roi": round(units / (w + l_), 4) if w + l_ else None, "lanes": lanes,
            **({"note": note, "empty": "line"} if note else {}),
            "rows": list(reversed(ledger[-80:])), "started": ledger[0]["date"] if ledger else None}


def nfl_block(lane, slate, odds):
    import nfl_model as M
    pg = lane.load("player_games.json", {}) or {}
    rows = pg.get("rows") or []
    season = slate.get("season") or max((r["season"] for r in rows), default=None)
    block = {"status": "trial", "version": M.VERSION, "title": "Receptions unders graded on trial; everything else priced, tested and explained",
             "note": ("One NFL lane is graded in public: receptions unders where the model beats Onyx's opening price by 3 points or more, "
                      "the only NFL market that beat Onyx in both seasons it was tested on. Everything else on this page is a lean or information: "
                      "spreads, totals, yards and touchdown chances were each tested against two seasons of real Onyx prices and did not beat them, "
                      "so they are shown with their numbers, never graded as picks. Injured players are removed before anything is priced."),
             "method": [METHOD["football"],
                        "Each projection blends this season's games (recent weeks weigh more) with last season's average, then adjusts for how much of that stat the opponent's defense has allowed, regressed toward league average.",
                        "The test below re-runs on every build: for every player-game this season from week 3 on, the model's projection against two simple baselines a bettor would use, the season average and the last-3 average. Lower error is better."],
             "roadmap": ROADMAP["nfl"], "tests": [], "rows": [], "top": []}
    if not rows or not season:
        return L.model_block(**block)
    t = M.test(rows, season)
    names = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec_yds": "Receiving yards", "rec": "Receptions"}
    for s in M.STATS:
        v = t.get(s)
        if v:
            block["tests"].append({"k": names[s], "v": f"{(1 - v['mae'] / v['avg']) * 100:+.1f}%",
                                   "d": f"vs season avg · {(1 - v['mae'] / v['l3']) * 100:+.1f}% vs last 3 · {v['n']} games"})
    if hasattr(M, "add_derived"):
        M.add_derived(rows)     # v10: combined totals Onyx prices (rush + rec, pass + rush) and touches
    by = M._games_by_player(rows)
    allowed = M._team_allowed(rows)
    lgc = {}
    last_game = {}
    for r in rows:
        if r["season"] == season:
            k = r["team"]
            last_game[k] = max(last_game.get(k, 0), r["week"])
    props = {(nk(p.get("name")), p.get("mkt")): p for p in (odds or {}).get("props") or []}
    # v4 volume inputs: each team's Onyx implied points and spread tonight (+ = underdog)
    team_env = {}
    for g in slate.get("games") or []:
        o = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
        if o.get("total") is not None:
            hsp = o.get("home_spread") or 0.0
            team_env[g["home"]] = ((o["total"] - hsp) / 2, hsp)
            team_env[g["away"]] = ((o["total"] + hsp) / 2, -hsp)
    vol_ph, vol_th = M.volume_history(rows) if hasattr(M, "VOL_P") else ({}, {})
    # v5: nflverse targets per dropback and snap trend (nfl_verse.py), averaged with v4 for receptions
    verse = lane.load("nflverse.json", None)
    vidx = M.verse_index(verse) if hasattr(M, "verse_index") else None
    # v11: the market models' statistics (nflverse weekly stats, nfl_features.py)
    fidx = None
    if getattr(M, "V11", None):
        import nfl_features as F
        fidx = F.index_of(verse)
    # ESPN's injury report: ruled out (out, IR, inactive, doubtful) gets nothing; questionable is tagged "Q"
    import sports_espn as E
    try:
        inj = E.fetch_injuries("football/nfl")
    except Exception as ex:          # fail-soft: no report means the slate runs as before
        print(f"  nfl injuries: {ex}")
        inj = {}
    dropped = set()
    out = []
    for g in slate.get("games") or []:
        if g.get("state") != "pre":
            continue
        wk = g.get("week") or 0
        for team, opp, home in ((g["away"], g["home"], False), (g["home"], g["away"], True)):
            lw = last_game.get(team)
            for pid, gs in by.items():
                cur = [x for x in gs if x["season"] == season]
                if not cur or cur[-1]["team"] != team or cur[-1]["week"] != lw:
                    continue   # only players who played in the team's latest game
                it = E.injury_of(inj, pid, cur[-1]["name"])
                if it and it["s"] == "OUT":
                    dropped.add(pid)
                    continue
                for s in getattr(M, "PROJ_STATS", M.STATS):
                    pr, info = M.project(gs, s, season, wk, opp, allowed, M.P, lgc)
                    if pr is None:
                        continue
                    vol = False
                    if s in getattr(M, "VOL_P", {}) and team in team_env:
                        pv = M.project_volume(s, vol_ph.get(pid, []), vol_th.get(team, []), *team_env[team])
                        if pv is not None and s == "rec" and vidx:
                            pvv = M.project_verse(vidx, team, cur[-1]["name"], season, wk, *team_env[team])
                            if pvv is not None:
                                pv = M.VERSE_P["w"] * pvv + (1 - M.VERSE_P["w"]) * pv
                        if pv is not None:
                            pr, vol = pv, True
                    ln = props.get((nk(cur[-1]["name"]), s))
                    out.append({"pid": pid, "name": cur[-1]["name"], "hs": cur[-1].get("hs"), "team": team, "opp": opp,
                                "home": home, "gid": g["gid"], "mkt": s, "proj": round(pr, 1),
                                "season": round(info["season"], 1) if info["season"] is not None else None,
                                "l3": [int(v) for v in info["l3"]], "opp_f": round(info["opp"], 3),
                                "line": ln.get("line") if ln else None,
                                "over": ln.get("over") if ln else None, "under": ln.get("under") if ln else None,
                                "over_sel": ln.get("over_sel") if ln else None, "under_sel": ln.get("under_sel") if ln else None,
                                "vol": vol, **({"inj": "Q", "inj_d": it["d"]} if it else {})})
                # v9: passing touchdowns for a quarterback who passed in the team's last game
                if hasattr(M, "project_pass_td") and (cur[-1].get("att") or 0) >= M.PTD_P["min_att"] and team in team_env:
                    lam = M.project_pass_td(gs, team_env[team][0])
                    if lam is not None:
                        qg = [x for x in cur if (x.get("att") or 0) >= M.PTD_P["min_att"]]
                        ln = props.get((nk(cur[-1]["name"]), "pass_td"))
                        out.append({"pid": pid, "name": cur[-1]["name"], "hs": cur[-1].get("hs"), "team": team, "opp": opp,
                                    "home": home, "gid": g["gid"], "mkt": "pass_td", "proj": round(lam, 2),
                                    "season": round(sum(x.get("pass_td") or 0 for x in qg) / len(qg), 2) if qg else None,
                                    "l3": [int(x.get("pass_td") or 0) for x in qg[-3:]], "opp_f": 1.0,
                                    "line": ln.get("line") if ln else None,
                                    "over": ln.get("over") if ln else None, "under": ln.get("under") if ln else None,
                                    "over_sel": ln.get("over_sel") if ln else None, "under_sel": ln.get("under_sel") if ln else None,
                                    "vol": False, "ptd": True, **({"inj": "Q", "inj_d": it["d"]} if it else {})})
    # price every two-sided Onyx line: the model's chance, the blend, the edge
    bt = lane.load("backtest.json", None) or {}
    w = ((bt.get("lane") or {}).get("w_props")) or DEFAULT_W
    for r in out:
        if r["line"] is None or r["over"] is None or r["under"] is None:
            continue
        if fidx is not None and r["mkt"] in M.V11 and team_env.get(r["team"]):
            fo, _ = L.fair_pair(r["over"], r["under"])
            vt = getattr(M, "VERSE_TEAM", {})
            tm, op_ = vt.get(r["team"], r["team"]), vt.get(r["opp"], r["opp"])
            gwk = next((g.get("week") for g in slate.get("games") or [] if g["gid"] == r["gid"]), None)
            pid_v = fidx.pid_of(season, tm, F.nk(r["name"])) if gwk else None
            if fo is not None and pid_v:
                wk_v = gwk + (18 if slate.get("season_type") == 3 else 0)
                f = fidx.features(pid_v, season, wk_v, tm, op_, F.STAT[r["mkt"]], r["line"], *team_env[r["team"]], r["home"])
                if f is not None:
                    r["v11"] = round(M.prob_v11(r["mkt"], fo, f), 4)
                    r["why"] = M.why_v11(r["mkt"], fo, f)
        if r.get("v11") is not None:     # v11: Onyx's price moved by the statistics that beat it
            ps = L.price_side(r["v11"], r["over"], r["under"], 1.0)
            side = M.V11[r["mkt"]]["side"]
            r["value_min"] = M.V11_EDGE if ps and ps["side"] == side else 1.0
        elif r.get("ptd"):    # v9: passing touchdowns, Poisson, 30% model
            po = M.prob_over_poisson(r["proj"], r["line"])
            ps = L.price_side(po, r["over"], r["under"], M.PTD_P["w"])
        elif r.get("vol"):    # v4: volume projection, its own spread, blend weight and value bar
            po = M.prob_over_volume(r["mkt"], r["proj"], r["line"])
            ps = L.price_side(po, r["over"], r["under"], M.VOL_P[r["mkt"]]["w"])
            r["value_min"] = M.VOL_P[r["mkt"]]["edge"]
        else:
            po = M.prob_over(r["mkt"], r["proj"], r["line"])
            ps = L.price_side(po, r["over"], r["under"], getattr(M, "BLEND_W", {}).get(r["mkt"], w))
        if ps:
            r.update(side=ps["side"], price=ps["price"], sel=r["over_sel"] if ps["side"] == "over" else r["under_sel"],
                     prob=ps["prob"], implied=ps["implied"], edge=ps["edge"], ev=ps["ev"], model_p=ps["model_p"],
                     matchup=f"{r['team']} {'vs' if r['home'] else '@'} {r['opp']}")
            if r.get("vol") and r["mkt"] == "rec" and ps["side"] not in getattr(M, "TRIAL_SIDES", ("over", "under")):
                r["value_min"] = 1.0      # v6: receptions overs lost at the open (2025 -14.8%), never a play or Top 10
            if r["mkt"] in getattr(M, "NO_VALUE", ()) and r.get("v11") is None:
                r["value_min"] = 1.0      # v7: rushing, passing and receiving yards lost their re-tests, leans only
    # receptions unders at Onyx's opening price, on trial (v6: the side that beat the open in both seasons)
    block["open"] = nfl_open_lane(lane, out, slate, season, rows, M)
    # touchdown scorers (nfl_model v2): anytime and first TD chances from Onyx's
    # implied team points, against Onyx's yes prices (one-sided, so the edge is
    # measured against the price as listed, margin included)
    td_rows = []
    if hasattr(M, "td_lambdas"):
        implied, players, meta = {}, [], {}
        for g in slate.get("games") or []:
            o = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
            if g.get("state") != "pre" or o.get("total") is None:
                continue
            hsp = o.get("home_spread") or 0.0
            implied[g["home"]], implied[g["away"]] = (o["total"] - hsp) / 2, (o["total"] + hsp) / 2
            for team, opp, home in ((g["away"], g["home"], False), (g["home"], g["away"], True)):
                lw = last_game.get(team)
                for pid, gs in by.items():
                    cur = [x for x in gs if x["season"] == season]
                    it = E.injury_of(inj, pid, cur[-1]["name"]) if cur else None
                    if it and it["s"] == "OUT":
                        dropped.add(pid)
                        continue    # ruled out: his share goes to no one here (redistribution tested, left out in v5)
                    if cur and cur[-1]["team"] == team and cur[-1]["week"] == lw and \
                            any((x.get("rush_att") or 0) + (x.get("tgt") or 0) > 0 for x in cur[-4:]):
                        players.append((pid, team))
                        meta[pid] = (g, team, opp, home, cur[-1])
        lams = M.td_lambdas(rows, players, implied)
        by_g = {}
        for pid, l in lams.items():
            by_g.setdefault(meta[pid][0]["gid"], {})[pid] = l
        probs = M.td_probs(by_g)
        for pid, (p_any, p_first) in probs.items():
            g, team, opp, home, last = meta[pid]
            row = {"pid": pid, "name": last["name"], "hs": last.get("hs"), "team": team, "opp": opp, "home": home, "gid": g["gid"],
                   "matchup": f"{team} {'vs' if home else '@'} {opp}", "any": round(p_any, 4), "first": round(p_first, 4)}
            it = E.injury_of(inj, pid, last["name"])
            if it:
                row["inj"], row["inj_d"] = "Q", it["d"]
            TP = M.TD_P
            for key, mk in (("any", "anytime_td"), ("first", "first_td")):
                ln = props.get((nk(last["name"]), mk))
                if ln and ln.get("over") is not None:
                    imp_ = L.implied(ln["over"])
                    row[key + "_price"], row[key + "_sel"] = ln["over"], ln.get("over_sel")
                    row[key + "_model"] = row[key]
                    if key == "any":
                        # v6: the chance shown is Onyx's price with its margin removed (x mkt_scale), the
                        # model's weight w_blend (0: it lost to the price in the 10/31 re-test); never value
                        row["any"] = round(TP["w_blend"] * row["any_model"] + (1 - TP["w_blend"]) * TP["mkt_scale"] * imp_, 4)
                        row["any_edge"] = round(row["any"] - imp_, 4)
                        row["any_value"] = TP["value_edge"] is not None and row["any_model"] - imp_ >= TP["value_edge"]
                    else:
                        row["first_edge"] = round(row["first"] - imp_, 4)
                        row["first_value"] = False    # Onyx's first-TD price beat the model in the backtest
            # v10: 2+ touchdowns from the anytime chance shown (Poisson: lambda = -ln(1 - anytime)),
            # against Onyx's over 1.5 price; information, never value
            lam2 = -math.log(max(1e-6, 1 - row["any"]))
            row["two"] = round(1 - math.exp(-lam2) * (1 + lam2), 4)
            ln2 = props.get((nk(last["name"]), "two_td"))
            if ln2 and ln2.get("over") is not None:
                row["two_price"], row["two_sel"] = ln2["over"], ln2.get("over_sel")
                row["two_edge"] = round(row["two"] - L.implied(ln2["over"]), 4)
            td_rows.append(row)
        td_rows.sort(key=lambda r: -r["any"])
        block["td"] = td_rows[:400]
    # lines Onyx prices first, largest gap between projection and line first
    out.sort(key=lambda r: (r["line"] is None, -abs(r["proj"] - r["line"]) / max(1.0, r["line"]) if r["line"] is not None else -r["proj"]))
    # the slate's headline numbers: best projection per market
    top = []
    for s in M.STATS:
        top += [r for r in out if r["mkt"] == s][:2]
    block["top"] = top
    n_q = len({r["pid"] for r in out if r.get("inj")})
    block["injuries"] = {"out": len(dropped), "q": n_q, "ok": bool(inj.get("id") or inj.get("name")) if inj else False}
    print(f"  nfl injuries: {len(dropped)} ruled out left off the slate, {n_q} questionable tagged"
          + ("" if block["injuries"]["ok"] else " (no report: ESPN did not answer)"))
    # game lines on the same frame as college football and the NHL
    import team_model as T
    games = (lane.load("results.json", {}) or {}).get("games") or []
    gw = ((bt.get("lane") or {}).get("w")) or DEFAULT_W
    R = T.fit(games, slate.get("date") or "9999", M.GAME_P)
    grows, proj = game_rows("nfl", M, slate, odds, R, gw)
    block["tests"].append({"k": "Game win log loss", "v": f"{M.GAME_TEST['logloss']:.3f}",
                           "d": f"vs {M.GAME_TEST['base_logloss']:.3f} home base rate · {M.GAME_TEST['n']} games"})
    block["method"].append("Game lines: every team carries an offense and a defense rating in points, fitted on every final this season and "
                           "last, and each Onyx moneyline, spread and total is priced from them, then blended with the Onyx market.")
    by_gid = {}
    for r in rows:
        by_gid.setdefault(r["gid"], {})[nk(r["name"])] = r

    team_res = grade_team(lane)

    def resolve(r):
        if r.get("kind"):
            return team_res(r)
        game = by_gid.get(r.get("gid"))
        if not game:
            return None
        row = game.get(nk(r["name"]))
        return (row.get(r["mkt"]) or 0.0) if row else "void"
    block = model_frame("nfl", lane, slate, odds, M, grows + out, block, resolve)
    if block.get("status") != "live":
        block["status"] = "trial"       # the receptions unders lane is graded at the opening price
    block["_cands"] = grows + out
    block["proj"] = proj
    eng = engine_team("nfl", M, M.GAME_P, gw, bt, block["status"] == "live")
    eng["steps"].insert(0, engine_nfl_props(M))
    if getattr(M, "V11", None):
        import nfl_features as F
        W = {"rush_yds": "Rushing yards unders", "pass_yds": "Passing yards overs", "pass_att": "Pass attempts unders"}
        eng["steps"].insert(1, {"t": "Market models (v11) · Onyx's price plus the statistics that beat it", "rows":
            [[W.get(m, m), "; ".join(f"{F.LABEL.get(k, k)} ({'+' if c > 0 else '-'} to the over)" for k, c in zip(S["features"], S["w"][2:]))]
             for m, S in M.V11.items()] + [["How chosen", "about 45 statistics tested on every Onyx line in 2025; one is kept only if it beats Onyx's price on both halves of 2025, then judged on 2026, which it never saw"],
                                          ["When", f"logged on trial at Onyx's opening price, {round(M.V11_EDGE * 100)}pp edge or more; at the closing price these edges mostly vanish"]],
            "note": "Every play from these models lists each statistic's push on the chance in points, so you can see why it got there."})
    eng["factors"].insert(0, ["chart", "Player projections", "Passing, rushing and receiving yards and receptions from every box score this season, last season as the prior and the opponent's defense, re-tested on every build against the season average and last-3 average.", "Foundation", ""])
    block["engine"] = eng
    if block["status"] != "live":
        # touchdown scorers join the plays as anytime TD props
        tdp = [{"pid": r["pid"], "name": r["name"], "hs": r.get("hs"), "gid": r["gid"], "matchup": r["matchup"], "mkt": "anytime_td",
                "side": "over", "line": 0.5, "price": r["any_price"], "sel": r.get("any_sel"), "prob": r["any"],
                "implied": round(L.implied(r["any_price"]), 4), "edge": r["any_edge"]}
               for r in block.get("td", []) if r.get("any_price") is not None and r.get("any_value")]
        block["projected"] = top_plays(grows + out + tdp)
        # a play the receptions trial lane logged today is graded: mark it, never call it an untracked lean
        trial = {r.get("sel") for r in (block.get("open") or {}).get("rows") or [] if r.get("sel") and not r.get("result")}
        for p in block["projected"]:
            if p.get("sel") in trial:
                p["trial"] = True
    return block

TEAM_MODELS = {"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model"}
DEFAULT_W = 0.3        # model share of the blend until a backtest sets it


def _row(g, kind, name, line, line_txt, _side, model_p_over, over, under, over_sel, under_sel, w, detail):
    """One game lean: the better side of a two-sided Onyx price after the
    blend. 'over' is the first side passed (home, the home spread, the over)."""
    ps = L.price_side(model_p_over, over, under, w)
    if not ps:
        return None
    first = ps["side"] == "over"
    fo, fu = L.fair_pair(over, under)
    r = {"gid": g["gid"], "start": g.get("start"), "matchup": f"{g['away']} @ {g['home']}", "kind": kind, "mkt": kind,
         "price": ps["price"], "sel": over_sel if first else under_sel, "prob": ps["prob"], "implied": ps["implied"],
         "edge": ps["edge"], "ev": ps["ev"], "model_p": ps["model_p"], "fair": round(fo if first else fu, 4), "detail": detail}
    if kind == "total":
        r.update(name="Total", side=ps["side"], line=line)
    else:
        team, opp_line = name if first else name_other(g, name), line if first else -line
        r.update(name=team, side="over", line=-opp_line if kind == "spread" else 0.0,
                 line_txt=(f"{opp_line:+g}" if kind == "spread" else ""), team_side=("home" if team == g["home"] else "away"))
    return r


def name_other(g, team):
    return g["away"] if team == g["home"] else g["home"]


def game_rows(key, M, slate, odds, R, w):
    import team_model as T
    GP = M.GAME_P if key == "nfl" else M.P
    kind = M.KIND if hasattr(M, "KIND") else "football"
    out, proj = [], {}
    for g in slate.get("games") or []:
        if g.get("state") != "pre":
            continue
        if R["n"].get(g["home"], 0) < GP.get("min_games", 3) or R["n"].get(g["away"], 0) < GP.get("min_games", 3):
            continue
        eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
        pr = (T.fb_probs if kind == "football" else T.hk_probs)(eh, ea, GP)
        unit = "goals" if kind == "hockey" else "pts"
        detail = f"model {g['away']} {ea:.1f} {g['home']} {eh:.1f}"
        proj[g["gid"]] = {"home": round(eh, 2), "away": round(ea, 2), "home_win": round(pr["home_win"], 4), "unit": unit}
        o = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
        if o.get("home_ml") is not None and o.get("away_ml") is not None:
            out.append(_row(g, "ml", g["home"], 0.0, "", None, pr["home_win"], o["home_ml"], o["away_ml"],
                            o.get("home_ml_sel"), o.get("away_ml_sel"), w, detail))
        if o.get("home_spread") is not None and o.get("home_spread_price") is not None and o.get("away_spread_price") is not None:
            sp = o["home_spread"]
            out.append(_row(g, "spread", g["home"], sp, f"{sp:+g}", None, pr["home_cover"](sp), o["home_spread_price"],
                            o["away_spread_price"], o.get("home_spread_sel"), o.get("away_spread_sel"), w, detail))
        if o.get("total") is not None and o.get("over_price") is not None and o.get("under_price") is not None and not getattr(M, "NO_TOTALS", False):
            out.append(_row(g, "total", "Total", o["total"], "", None, pr["over"](o["total"]), o["over_price"], o["under_price"],
                            o.get("over_sel"), o.get("under_sel"), w, detail + f" · total {eh + ea:.1f}"))
    out = [r for r in out if r]
    out.sort(key=lambda r: -r["edge"])
    return out, proj


def tennis_rows(lane, slate, odds, w):
    import tennis_model as TM
    E = TM.load(lane)
    out = []
    mo = (odds or {}).get("matches") or {}
    for e in slate.get("events") or []:
        for m in e.get("matches") or []:
            if m.get("state") != "pre":
                continue
            o = mo.get(m["id"]) or {}
            a, b = m["p"][0]["name"], m["p"][1]["name"]
            if not (E.known(nk(a)) and E.known(nk(b))):
                continue
            p0 = E.p(nk(a), nk(b))
            g = {"gid": m["id"], "start": m.get("start"), "away": b, "home": a}
            if o.get("ml0") is not None and o.get("ml1") is not None:
                r = _row(g, "ml", a, 0.0, "", None, p0, o["ml0"], o["ml1"], o.get("ml0_sel"), o.get("ml1_sel"), w,
                         f"Elo {E.r.get(nk(a), 1500):.0f} vs {E.r.get(nk(b), 1500):.0f} · {e.get('name')}")
                if r:
                    r["matchup"] = f"{a} vs {b}"
                    out.append(r)
            # games markets (v2): the Elo view of the total and the game spread
            if o.get("total") is not None or o.get("sp0") is not None:
                gm = TM.games_markets(p0, e.get("tour"), e.get("name"), o.get("total"), o.get("sp0"))
                det = f"Elo {E.r.get(nk(a), 1500):.0f} vs {E.r.get(nk(b), 1500):.0f} · {gm['exp_games']:.1f} games projected"
                if o.get("total") is not None and o.get("over") is not None and o.get("under") is not None:
                    r = _row(g, "total", "Total games", o["total"], "", None, gm["p_over"], o["over"], o["under"],
                             o.get("over_sel"), o.get("under_sel"), w, det)
                    if r:
                        r["matchup"] = f"{a} vs {b}"
                        out.append(r)
                if o.get("sp0") is not None and o.get("sp0_price") is not None and o.get("sp1_price") is not None:
                    r = _row(g, "spread", a, o["sp0"], f"{o['sp0']:+g}", None, gm["p_cover0"], o["sp0_price"], o["sp1_price"],
                             o.get("sp0_sel"), o.get("sp1_sel"), w, det)
                    if r:
                        r["matchup"] = f"{a} vs {b}"
                        out.append(r)
    out.sort(key=lambda r: -r["edge"])
    return out


MKT_WORD = {"ml": "moneyline", "spread": "spread", "total": "total", "pass_yds": "passing yards", "rush_yds": "rushing yards",
            "rec_yds": "receiving yards", "rec": "receptions", "pass_td": "passing TDs",
            "pass_att": "pass attempts", "pass_rush_yds": "passing + rushing yards", "rush_rec_yds": "rushing + receiving yards", "two_td": "2+ touchdowns"}


# what people bet first: spreads, totals and player props lead the plays; a
# moneyline only shows when its game has no spread or total worth playing
PLAY_PREF = {"spread": 1.0, "total": 1.0, "prop": 1.0, "ml": 0.5}
PLAY_MAX, PLAY_PER_GAME, PLAY_MIN_EDGE, PLAY_MIN_PROB = 12, 2, 0.01, 0.50   # a play is more likely to win than not


def top_plays(rows):
    """The slate's plays for a sport still in the lab: every priced Onyx line
    the model has a chance for, value only (the blended chance beats the
    price's implied chance by PLAY_MIN_EDGE), one per game market and one per
    player, spreads / totals / props first. Each carries its confidence (the
    blended chance of the side). Leans, never logged or graded."""
    best = {}
    for r in rows:
        if r.get("prob") is None or r.get("price") is None or r.get("edge") is None:
            continue
        if r["edge"] < max(PLAY_MIN_EDGE, r.get("value_min") or 0) or r["prob"] < PLAY_MIN_PROB:
            continue
        kind = r.get("kind") or "prop"
        key = (r.get("gid"), kind if kind != "prop" else ("p", r.get("pid") or r.get("name")))
        score = r["edge"] * PLAY_PREF.get(kind, 1.0)
        if key not in best or score > best[key][0]:
            best[key] = (score, r)
    ranked = sorted(best.values(), key=lambda x: -x[0])
    out, per_game = [], {}
    for score, r in ranked:
        if per_game.get(r.get("gid"), 0) >= PLAY_PER_GAME:
            continue
        per_game[r.get("gid")] = per_game.get(r.get("gid"), 0) + 1
        out.append(dict(r, projected=True, value=True))
        if len(out) >= PLAY_MAX:
            break
    return out


def projected_plays(rows, bt, date):
    """What the lane WOULD play on this slate: the same screen as a tracked
    pick (the backtest's best lane: markets, edge band, price band, one per
    game). For a sport in the lab these are leans on the page, never logged,
    never graded; the label says the lane has not beaten Onyx yet."""
    if not (bt or {}).get("lane"):
        return []
    return [dict(r, projected=True) for r in lane_picks(rows, bt, date)]


def _lane_card(bt, live):
    lane = (bt or {}).get("lane") or {}
    if not lane:
        return None
    return {"markets": [MKT_WORD.get(m, m) for m in lane.get("markets", [])], "edge": [lane.get("edge_min"), lane.get("edge_max")],
            "price": [lane.get("price_min"), lane.get("price_max")], "per_slate": lane.get("max_per_slate"),
            "w": lane.get("w"), "passed": bool(bt.get("passed")), "live": live}


def engine_team(key, M, GP, w, bt, live):
    """The Model tab's breakdown for a team-ratings sport, from the live
    parameters: each step of a price, the factors, the lane."""
    hockey = getattr(M, "KIND", "football") == "hockey"
    unit = "goals" if hockey else "points"
    T = M.GAME_TEST if key == "nfl" else M.TEST
    steps = [
        {"t": "1 · Team ratings", "rows": [
            ["Built from", f"every final this season and last ({T['n']:,} games held out to test it)" if T.get("n") else "every final this season and last"],
            ["Recency", f"a game {GP['half_life']} days old counts half as much as tonight's (half-life)"],
            ["Pull to average", f"each rating starts with {GP['ridge']:g} {'game' if GP['ridge'] == 1 else 'games'}' worth of league average, so a hot start is not a rating".replace("1 game' worth", "1 game's worth")],
            ["Home edge", f"{GP['home']:g} {unit} to the home side, none at a neutral site"],
            ["Needs", f"{GP.get('min_games', 3)} games for both teams before a line is priced"]]},
        {"t": "2 · From ratings to a price", "rows": (
            [["Goals", "each side's goals are Poisson around its expected goals"],
             ["Overtime", f"a regulation tie goes to the home side {GP['p_ot_home'] * 100:.0f}% of the time"],
             ["Puck line, total", "read off the same goal distribution, overtime included"]] if hockey else
            [["Margin", f"normal around the projected margin, spread {GP['sd_margin']:g} points"],
             ["Total", f"normal around the projected total, spread {GP['sd_total']:g} points"],
             ["Moneyline, spread", "the chance the margin clears zero, or the line"]])},
        {"t": "3 · Against the Onyx price", "bars": [["Onyx market", round((1 - w) * 100)], ["Onyx model", round(w * 100)]],
         "note": "The model's chance is blended with the Onyx market; edge is the blended chance minus the chance the listed price implies. " +
                 ("The market carries most of the weight because, line for line, it is the sharper read." if w < 0.5 else
                  "The backtest gave the model and the market an even say." if w == 0.5 else
                  "The backtest gave the model the larger say.")}]
    factors = [
        ["chart", "Offense and defense", f"Every team carries two ratings in {unit}: what it scores above average and what it allows. Tonight's projection is league average plus the home edge plus one side's offense minus the other's defense.", "Foundation", ""],
        ["clock", "Recency", f"Half-life {GP['half_life']} days: rosters and form move, so last month counts more than last season. The summer break decays last season on its own.", "Tuned", "purple"],
        ["shield", "Pull to average", f"Ridge {GP['ridge']:g}: ratings are shrunk toward average until a team has earned it, which is what stops a 3-game sample from looking elite.", "Tuned", "blue"],
        ["scale", "Market blend", f"{round(w * 100)}% model, {round((1 - w) * 100)}% Onyx market. Chosen by the backtest against real Onyx prices.", "Market", "blue"],
    ]
    if getattr(M, "NO_TOTALS", False):
        factors.append(["eye", "Totals held back", f"The ratings' totals did not beat a flat league average ({T['mae_total']:.2f} vs {T['base_mae_total']:.2f} {unit} of error), so totals are never leaned or picked.", "Guardrail", "blue"])
    elif T.get("mae_total") is not None:
        factors.append(["eye", "Totals", f"Total error {T['mae_total']:.2f} {unit} vs {T['base_mae_total']:.2f} for the league average on games the ratings never saw.", "Tested", ""])
    if hockey:
        factors.append(["bell", "Goalies next", "The starting goalie moves an NHL price more than anything else. Confirmations are not in the model yet, which is part of why it stays leans only.", "Planned", ""])
    return {"steps": steps, "factors": factors, "lane": _lane_card(bt, live)}


def engine_nfl_props(M):
    return {"t": "Player projections", "rows": [
        ["This season", f"recent games weigh more: each week back counts {M.P['decay']:g}x the one after it"],
        ["Last season", f"worth {M.P['k_prior']:g} games of this season, so week 2 is not a coin flip"],
        ["Opponent", f"what the defense allows, regressed {M.P['opp_k']:g} games toward league average, at strength {M.P['opp_w']:g}"],
        ["Role", "only players with a real role in the stat (attempts, carries or targets per game) get a projection"],
        ["Spread", "yards are normal around the projection, receptions negative binomial, widened to the spread that fits Onyx lines best"]]}


def engine_tennis(TM, w, bt, live):
    P = TM.P
    return {"steps": [
        {"t": "1 · Elo ratings", "rows": [
            ["Built from", "every completed ATP and WTA singles match since 2023, retirements and walkovers dropped"],
            ["Update", f"a win moves a rating by K x (1 - expected chance), K = {P['k0']:g} / (matches + 5)^{P['shape']:g}"],
            ["New players", "move fast; veterans move slowly"],
            ["Needs", f"{P['min_matches']} matches for both players before a match is priced"]]},
        {"t": "2 · Against the Onyx price", "bars": [["Onyx market", round((1 - w) * 100)], ["Onyx model", round(w * 100)]],
         "note": "Elo gives the chance each player wins; it is blended with the Onyx market and the edge is measured against the price you actually get."}],
        "factors": [
            ["chart", "Elo", "One number per player that rises with wins and falls with losses, scaled by how surprising the result was.", "Foundation", ""],
            ["pace", "K schedule", f"K = {P['k0']:g} / (matches + 5)^{P['shape']:g}, FiveThirtyEight's schedule: a newcomer's rating finds its level in a few weeks, a veteran's barely moves on one upset.", "Tuned", "purple"],
            ["eye", "Grand Slams", "Weighting Slam results more (1.1x, 1.3x) tested no better, so every match counts the same.", "Tested", "blue"],
            ["bell", "Surfaces next", "Clay, grass and hard-court ratings are the next step; a single rating blurs specialists.", "Planned", ""],
            ["scale", "Market blend", f"{round(w * 100)}% model, {round((1 - w) * 100)}% Onyx market.", "Market", "blue"]],
        "lane": _lane_card(bt, live)}


def lane_picks(rows, bt, date):
    """The tracked lane, only when the backtest for this version passed:
    its markets, edge band, price band and cap, best edge first."""
    rule = (bt or {}).get("lane") or {}
    picks = []
    used = set()
    for r in rows:
        if r["mkt"] not in rule.get("markets", ()):
            continue
        if not (rule.get("edge_min", 1) <= r["edge"] <= rule.get("edge_max", 0)):
            continue
        if not (rule.get("price_min", -200) <= r["price"] <= rule.get("price_max", 200)):
            continue
        if r["gid"] in used:
            continue
        used.add(r["gid"])
        picks.append(dict(r, date=date))
        if len(picks) >= rule.get("max_per_slate", 4):
            break
    return picks


def grade_team(lane):
    res = {g["id"]: g for g in (lane.load("results.json", {}) or {}).get("games") or []}

    def resolve(r):
        g = res.get(r.get("gid"))
        if not g:
            return None
        if r["kind"] == "total":
            return g["hs"] + g["as"]
        m = g["hs"] - g["as"]
        return m if r.get("team_side") == "home" else -m
    return resolve


def grade_tennis(lane):
    res = {m["id"]: m for m in (lane.load("results.json", {}) or {}).get("matches") or []}

    def resolve(r):
        m = res.get(r.get("gid"))
        if not m:
            return None
        return 1.0 if nk(m["w"]) == nk(r["name"]) else -1.0
    return resolve


def model_frame(key, lane, slate, odds, M, rows, base, resolve, rows_for=None):
    """Gate, lane, ledger and record around a sport's rows. A backtest may hold
    several lanes ("lanes": spreads and totals, each with its own blend weight);
    rows_for(w) re-prices the slate at a lane's weight."""
    bt, live = L.gate(lane, M.VERSION)
    led = L.Ledger(lane)
    led.grade(resolve)
    picks = []
    if live:
        lanes = (bt or {}).get("lanes") or [(bt or {}).get("lane")]
        for rule in [r for r in lanes if r and not r.get("trial")]:     # a "trial" lane logs at opening prices instead
            rws = rows_for(rule.get("w")) if rows_for and rule.get("w") is not None else rows
            picks += lane_picks(rws, {"lane": rule}, slate.get("date"))
        for p in picks:
            led.add({k: p.get(k) for k in ("date", "gid", "start", "matchup", "kind", "mkt", "name", "side", "line", "line_txt",
                                           "team_side", "price", "sel", "prob", "implied", "edge", "ev", "model_p", "proj", "hs")})
    led.save()
    rec = led.record()
    base.update(status="live" if live else "lab", version=M.VERSION, backtest=(bt or {}).get("page"),
                changelog=L.changelog(M.__doc__), rows=rows, picks=picks, record=rec if led.rows else None)
    return base


def cfb_player_rows(lane, slate, odds, w):
    """College football player projections (cfb_players.py) for every FBS player
    with a role on tonight's slate, priced against Onyx's player props where
    Onyx has a line. Leans: no history of Onyx college prop prices to test on."""
    import cfb_players as C
    import nfl_model as N
    pg = lane.load("player_games.json", {}) or {}
    rows = pg.get("rows") or []
    season = slate.get("season")
    if not rows or not season:
        return []
    wk = int((slate.get("label") or "Week 0").split()[-1]) if str(slate.get("label") or "").startswith("Week") else 99
    by = N._games_by_player(rows)
    allowed = N._team_allowed(rows)
    last_game, lgc = {}, {}
    for r in rows:
        if r["season"] == season and r["week"] < wk:
            last_game[r["team"]] = max(last_game.get(r["team"], 0), r["week"])
    props = {(nk(p.get("name")), p.get("mkt")): p for p in (odds or {}).get("props") or []}
    # v2: market models on Onyx's price (rushing yards), from the same box scores
    MI = C.MarketIndex(rows) if getattr(C, "V2", None) else None
    out = []
    for g in slate.get("games") or []:
        if g.get("state") != "pre":
            continue
        o_ = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
        gdate = None
        if g.get("start"):
            from datetime import datetime as _dt, timedelta as _td
            gdate = (_dt.fromisoformat(g["start"].replace("Z", "+00:00")) - _td(hours=5)).date().isoformat()
        for team, opp, home in ((g["away"], g["home"], False), (g["home"], g["away"], True)):
            lw = last_game.get(team)
            for pid, gs in by.items():
                cur = [x for x in gs if x["season"] == season and x["week"] < wk]
                if not cur or cur[-1]["team"] != team or cur[-1]["week"] != lw:
                    continue   # only players who played in the team's latest game
                for st in C.STATS:
                    pr, info = C.project(gs, st, season, wk, opp, allowed, C.P, lgc)
                    if pr is None:
                        continue
                    ln = props.get((nk(cur[-1]["name"]), st)) or {}
                    r = {"pid": pid, "name": cur[-1]["name"], "hs": cur[-1].get("hs"), "team": team, "opp": opp, "home": home,
                         "gid": g["gid"], "start": g.get("start"), "mkt": st, "proj": round(pr, 1),
                         "season": round(info["season"], 1), "l3": [int(v) for v in info["l3"]], "opp_f": round(info["opp"], 3),
                         "line": ln.get("line"), "over": ln.get("over"), "under": ln.get("under"),
                         "over_sel": ln.get("over_sel"), "under_sel": ln.get("under_sel"),
                         "matchup": f"{team} {'vs' if home else '@'} {opp}"}
                    pr = max(0.0, pr)     # college rushing counts sacks: a quarterback can average below zero
                    r["proj"] = round(pr, 1)
                    # role guard (as NBA's): a projection 1+ sd from the line, or under 60% / over 167% of it,
                    # describes a different role (a split backfield, a new starter) or a stale line, not an
                    # edge: shown, never priced. Without it the biggest "edges" were all role changes.
                    sd_ = (C.SD[st][0] + C.SD[st][1] * pr) if st in C.SD else math.sqrt(C.REC_VAR * max(pr, 0.3))
                    ratio = pr / r["line"] if r["line"] else 1.0
                    if r["line"] is not None and (abs(pr - r["line"]) > 1.0 * sd_ or not (0.6 <= ratio <= 1.67)):
                        r["role_flag"] = True
                    elif r["line"] is not None and r["over"] is not None and r["under"] is not None:
                        ps = L.price_side(C.prob_over(st, pr, r["line"]), r["over"], r["under"], w)
                        if ps:
                            r.update(side=ps["side"], price=ps["price"], sel=r["over_sel"] if ps["side"] == "over" else r["under_sel"],
                                     prob=ps["prob"], implied=ps["implied"], edge=ps["edge"], ev=ps["ev"], model_p=ps["model_p"])
                    # v2: the market model prices its markets whatever the projection says (it was tested on every line)
                    if MI is not None and st in C.V2 and None not in (r["line"], r["over"], r["under"]) \
                            and o_.get("total") is not None and gdate:
                        fo, _ = L.fair_pair(r["over"], r["under"])
                        hsp = o_.get("home_spread") or 0.0
                        f = MI.features(pid, team, opp, home, gdate, r["line"], st, hsp if home else -hsp, o_["total"]) if fo else None
                        if f is not None:
                            r["v2"] = round(C.prob_v2(st, fo, f), 4)
                            r["why"] = C.why_v2(st, fo, f)
                            ps = L.price_side(r["v2"], r["over"], r["under"], 1.0)
                            if ps:
                                r.pop("role_flag", None)
                                r.update(side=ps["side"], price=ps["price"], sel=r["over_sel"] if ps["side"] == "over" else r["under_sel"],
                                         prob=ps["prob"], implied=ps["implied"], edge=ps["edge"], ev=ps["ev"], model_p=ps["model_p"],
                                         value_min=C.V2_EDGE if ps["side"] == C.V2[st]["side"] else 1.0)
                    out.append(r)
    out.sort(key=lambda r: (r["line"] is None, -abs(r["proj"] - (r["line"] or r["proj"])) / max(1.0, r["line"] or 1.0)))
    return out


def cfb_prop_lane(lane, prow, slate, C):
    """College rushing yards unders at Onyx's opening price, on trial (cfb_players v2). Its own
    capture and ledger (prop_opening.json, prop_trial.json, append-only), apart from the totals
    lane. A play is logged once, when the v2 model beats the opening price by V2_EDGE and the
    live line and price are still the opening ones. Graded from the box score; a player with no
    box line once his game's box is in is a void."""
    from datetime import datetime, timedelta, timezone
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    O = lane.load("prop_opening.json", None)
    first_run = O is None
    O = O or {}
    ledger = lane.load("prop_trial.json", []) or []
    games = {g["gid"]: g for g in slate.get("games") or []}
    for k in [k for k in O if k.split("|")[0] in games and games[k.split("|")[0]].get("state") == "post"]:
        O.pop(k)
    have = {k["key"] for k in ledger}
    cands = []
    for r in prow:
        if r["mkt"] not in C.V2 or None in (r.get("line"), r.get("over"), r.get("under")):
            continue
        g = games.get(r["gid"]) or {}
        key = f"{r['gid']}|{nk(r['name'])}|{r['mkt']}"
        if key not in O and g.get("state") == "pre":
            O[key] = {"line": r["line"], "over": r["over"], "under": r["under"], "ts": ts, **({"baseline": True} if first_run else {})}
        op = O.get(key)
        if not op or op.get("baseline") or g.get("state") != "pre" or key in have or r.get("v2") is None:
            continue
        if (op["line"], op["over"], op["under"]) != (r["line"], r["over"], r["under"]):
            continue
        side = C.V2[r["mkt"]]["side"]
        p = r["v2"] if side == "over" else 1 - r["v2"]
        price, sel = (r["over"], r.get("over_sel")) if side == "over" else (r["under"], r.get("under_sel"))
        if p - L.implied(price) >= C.V2_EDGE:
            cands.append({"date": slate.get("date"), "key": key, "gid": r["gid"], "pid": r["pid"], "name": r["name"], "team": r["team"],
                          "opp": r["opp"], "matchup": r["matchup"], "kind": r["mkt"], "lane": f"{r['mkt']}_{side}", "side": side,
                          "line": r["line"], "price": price, "sel": sel, "proj": r.get("proj"), "prob": round(p, 4),
                          "implied": round(L.implied(price), 4), "why": r.get("why"), "opened_at": op["ts"], "logged_at": ts,
                          "model": C.VERSION, "result": None, "actual": None})
    ledger.extend(cands)
    box, box_games = {}, set()
    for x in (lane.load("player_games.json", {}) or {}).get("rows") or []:
        box[(x["gid"], nk(x["name"]))] = x
        box_games.add(x["gid"])
    for k in ledger:
        if k.get("result"):
            continue
        x = box.get((k["gid"], nk(k["name"])))
        if x is not None:
            a = x.get(k["kind"]) or 0
            k["actual"], k["graded_at"] = a, ts
            k["result"] = "P" if a == k["line"] else ("W" if (a > k["line"]) == (k["side"] == "over") else "L")
        elif k["gid"] in box_games or k.get("date", "9") < (datetime.now(timezone.utc) - timedelta(days=10)).date().isoformat():
            k["result"], k["actual"], k["graded_at"] = "V", None, ts
    lane.save("prop_opening.json", O, indent=1)
    lane.save("prop_trial.json", ledger, indent=1)
    w = sum(1 for k in ledger if k["result"] == "W"); l_ = sum(1 for k in ledger if k["result"] == "L")
    pay = lambda a: a / 100.0 if a > 0 else 100.0 / -a
    units = sum((pay(k["price"]) if k["result"] == "W" else -1.0 if k["result"] == "L" else 0.0) for k in ledger)
    return {"w": w, "l": l_, "p": sum(1 for k in ledger if k["result"] == "P"), "pending": sum(1 for k in ledger if not k["result"]),
            "units": round(units, 2), "roi": round(units / (w + l_), 4) if w + l_ else None, "empty": "rushing yards line", "title": "On trial · college rushing yards unders",
            "rows": list(reversed(ledger[-80:])), "started": ledger[0]["date"] if ledger else None,
            "note": ("Rushing yards unders, since 11/1: Onyx's opening price moved by the rushing yards and carries the defense allows "
                     "and how far the line sits from the runner's usual range, logged at 5 points of edge or more while Onyx still shows "
                     "the first price we saw, and graded off the box score. On weeks the model never saw these unders went 47-20 (+31.7%) "
                     "at the opening price, and Onyx's college rushing lines go over only 42% of the time. Each play lists why. "
                     "On trial until this record says otherwise.")}


def team_block(key, lane, slate, odds):
    import importlib
    import team_model as T
    M = importlib.import_module(TEAM_MODELS[key])
    GP = M.GAME_P if key == "nfl" else M.P
    TEST = M.GAME_TEST if key == "nfl" else M.TEST
    bt = lane.load("backtest.json", None) or {}
    w = ((bt.get("lane") or {}).get("w")) or DEFAULT_W
    games = (lane.load("results.json", {}) or {}).get("games") or []
    R = T.fit(games, slate.get("date") or "9999", GP)
    rows, proj = game_rows(key, M, slate, odds, R, w)
    cfg = lane.cfg
    unit = "goals" if cfg["kind"] == "hockey" else "points"
    base = L.model_block(
        title="Team ratings against every Onyx game line",
        note=(f"Every team carries an offense and a defense rating in {unit}, fitted on every final this season and last, "
              f"recent games weighing more. Each Onyx moneyline, spread and total is priced from them and blended with the Onyx "
              f"market. Tracked picks switch on only after the ratings beat real Onyx prices in a backtest."),
        method=[METHOD[cfg["kind"]],
                f"Ratings: {unit} scored = league average + home edge + the team's offense - the opponent's defense, fitted by weighted "
                f"least squares with a pull toward average so a team with three games is not rated off three games.",
                ("Hockey prices: each side's goals are Poisson; a regulation tie goes to overtime. " if cfg["kind"] == "hockey" else
                 "Football prices: the margin and the total are normal around the ratings' projection. ") +
                f"The blend gives the model {round(w * 100)}% and the Onyx market the rest; edge is the blended chance minus the price's implied chance."],
        tests=[{"k": "Win log loss", "v": f"{TEST['logloss']:.3f}", "d": f"vs {TEST['base_logloss']:.3f} home base rate · {TEST['n']} games from {TEST['window']}"},
               {"k": f"Total error ({unit})", "v": f"{TEST['mae_total']:.2f}", "d": f"vs {TEST['base_mae_total']:.2f} league average"}],
        roadmap=ROADMAP.get(key, []))
    base = model_frame(key, lane, slate, odds, M, rows, base, grade_team(lane),
                       rows_for=lambda w_: game_rows(key, M, slate, odds, R, w_)[0])
    trial = [r for r in (bt.get("lanes") or []) if r.get("trial")] if base["status"] == "live" else []
    if trial:
        rule = trial[0]
        base["open"] = team_open_lane(lane, rule, game_rows(key, M, slate, odds, R, rule["w"])[0], slate, M)
    base["_cands"] = rows
    base["proj"] = proj
    base["engine"] = engine_team(key, M, GP, w, bt, base["status"] == "live")
    if key == "cfb":
        # v2 11/1: player projections (cfb_players.py) join the game lines, leans only
        import cfb_players as C
        prow = cfb_player_rows(lane, slate, odds, DEFAULT_W)
        base["rows"] = rows + prow
        base["_cands"] = rows + [r for r in prow if r.get("prob") is not None]
        names = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec_yds": "Receiving yards", "rec": "Receptions"}
        for st, (n, mae, avg, l3) in C.TEST.items():
            base["tests"].append({"k": names[st] + " (players)", "v": f"{(1 - mae / avg) * 100:+.1f}%",
                                  "d": f"vs season avg · {(1 - mae / l3) * 100:+.1f}% vs last 3 · {n} games, weeks 7-9"})
        base["projected"] = top_plays(rows + [r for r in prow if r.get("prob") is not None])
        if getattr(C, "V2", None):
            base["open2"] = cfb_prop_lane(lane, prow, slate, C)
            trial2 = {k.get("sel") for k in base["open2"]["rows"] if k.get("sel") and not k.get("result")}
            for p in base["projected"]:
                if p.get("sel") in trial2:
                    p["trial"] = True
    else:
        base["projected"] = top_plays(rows)     # leans; a live sport shows them under its tracked picks
    return base


def tennis_block(lane, slate, odds):
    import tennis_model as TM
    bt = lane.load("backtest.json", None) or {}
    w = ((bt.get("lane") or {}).get("w")) or DEFAULT_W
    rows = tennis_rows(lane, slate, odds, w)
    base = L.model_block(
        title="Elo ratings against every Onyx match price",
        note=("Every ATP and WTA singles player carries an Elo rating built from every completed match since 2023. Each Onyx match "
              "price is set against it and blended with the Onyx market. Tracked picks switch on only after the ratings "
              "beat real Onyx prices in a backtest."),
        method=[METHOD["tennis"],
                "Elo: a win moves a rating by K x (1 - expected), K = 150 / (matches + 5)^0.4, so new players move fast and veterans slowly. "
                "Retirements and walkovers are dropped. A player needs 10 matches before the model prices them.",
                f"The blend gives the model {round(w * 100)}% and the Onyx market the rest."],
        tests=[{"k": "Match log loss", "v": "0.627", "d": "7,875 matches in 2026 the ratings never saw"},
               {"k": "Favourite won", "v": "64.0%", "d": "same matches"}],
        roadmap=ROADMAP["tennis"])
    base = model_frame("tennis", lane, slate, odds, TM, rows, base, grade_tennis(lane))
    base["_cands"] = rows
    base["players"] = tennis_players(lane, slate)
    base["engine"] = engine_tennis(TM, w, bt, base["status"] == "live")
    base["projected"] = top_plays(rows)
    return base


def tennis_players(lane, slate):
    """For the match center: each player on the board this week, his Elo,
    the matches it rests on, and his last six results (45 days kept)."""
    import tennis_model as TM
    E = TM.load(lane)
    res = (lane.load("results.json", {}) or {}).get("matches") or []
    names = {p["name"] for e in slate.get("events") or [] for m in e.get("matches") or [] if m.get("state") != "post" for p in m["p"]}
    out = {}
    for n in names:
        k = nk(n)
        form = [m for m in res if nk(m["w"]) == k or nk(m["l"]) == k][-6:]
        out[k] = {"elo": round(E.r[k]) if k in E.r else None, "n": E.n.get(k, 0),
                  "form": [{"d": m["date"][5:], "w": nk(m["w"]) == k, "opp": m["l"] if nk(m["w"]) == k else m["w"],
                            "s": f"{m['sets_w']}-{m['sets_l']}" if nk(m["w"]) == k else f"{m['sets_l']}-{m['sets_w']}",
                            "ev": m.get("event"), "rd": m.get("round")} for m in reversed(form)]}
    return out


def golf_block(lane, slate):
    """Ratings for this week's PGA TOUR field; the page simulates the tournament from them."""
    import golf_model as G
    cfg = lane.cfg
    base = lab_block("golf", cfg)
    e = next((x for x in slate.get("events") or [] if x.get("tour") == "PGA"), None)
    H = lane.load("history.json", None)
    if not e or not H:
        return base
    course = (e.get("course") or {}).get("id")
    players = G.field_ratings(H, e.get("board") or [], course, slate.get("date") or str(game_day()))
    wins = G.wins_here(H, course) if course else None
    base.update({
        "status": "lab", "version": G.VERSION, "changelog": G.CHANGELOG, "tests": G.TESTS,
        "title": "Strokes gained, simulated: how a golf read is built",
        "note": ("Onyx does not price golf yet, so nothing here is a pick: these are the model's chances, "
                 "tested against five seasons of PGA TOUR results. They become tracked picks only after they beat real Onyx prices."),
        "method": [METHOD["golf"],
                   "Every player gets a rating in strokes gained per round against the field, from every round he has played "
                   "in the last four seasons (recent rounds count most), what he has done at this course before, and how his "
                   "game fits what this course rewards. The page then plays the tournament 2,000 times, cut and all, from the "
                   "first tee or from the live leaderboard, and counts how often each player wins, finishes top 5, 10 and 20, "
                   "and makes the cut."],
        "golf": {"event": e.get("id"), "course": e.get("course"), "cut": e.get("cut_n", 65),
                 "sim": {"sr": G.P["sr"], "sp": G.P["sp"]}, "players": players, "wins": wins, "tour": G.tour_wins(H),
                 "history_events": len(H.get("rows") or {})},
        "engine": {"steps": [
            {"t": "The rating: strokes gained per round vs the field", "rows": [
                ["Form", "every round in four seasons, a round 240 days old counts half; new players start at -1.0"],
                ["Course history", "what form missed by at this course before, shrunk hard (8 rounds of evidence) and added at a quarter"],
                ["Course fit", "which games over-perform here: driving distance, accuracy, greens hit and putting, learned from past weeks at the course"],
                ["Green type", "bermuda and paspalum vs bent and poa: tested, no signal, left out"],
                ["Wind", "tested on 86,000 rounds of course weather: no player beats his form in the wind, and wind does not widen the gaps, so it is left out"]],
             "note": "Form carries almost all of it. Course history and fit move a player a tenth of a stroke or two."},
            {"t": "The simulation", "rows": [
                ["Each round", "his rating plus noise: one round swings about 2.6 strokes either way for anyone"],
                ["The cut", f"top {e.get('cut_n', 65)} and ties after 36 holes" if e.get("cut_n") else "no cut this week"],
                ["Live", "from the current leaderboard: holes left in the round underway, then the rounds to come"]]}],
            "factors": [], "lane": None},
    })
    return base


def lab_block(key, cfg):
    return {"status": "lab", "version": None, "title": "What is live, and what the model will be",
            "note": (f"Onyx {cfg['name']} is live for scores, the gamecenter and Onyx prices as they post. The {cfg['name']} model "
                     "is in the lab: nothing here is a pick until it has been backtested against real Onyx prices."),
            "method": [METHOD[cfg["kind"]], "Every price on this page is an Onyx price."],
            "roadmap": ROADMAP.get(key, []), "tests": [], "rows": [], "top": [],
            "engine": {"steps": [{"t": "What is live today", "rows": [
                ["Leaderboard", "position, score to par, today and thru, polled live"],
                ["Every hole", "each player's card hole by hole, with birdies, bogeys and the rest marked"],
                ["Tournament stats", "driving, fairways, greens, putting, sand saves and earnings for each player"]]}],
                "factors": [], "lane": None}}


def both_sides(key, lane, slate, pre, start, board, DT):
    """Every side of every Onyx game line for Ask Onyx, not only the side a model leans:
    "Georgia to cover" needs Georgia's spread even when the lean is Florida's. A side whose
    other half the model priced gets the complement of that chance; a game the model did not
    price gets Onyx's own price with the margin removed. Leans only, never value plays."""
    odds = (lane.load("odds.json", {}) or {}).get("games") or {}
    have = {e.get("sel") for e in board if e.get("sel")}
    model = {}
    for e in board:
        if e.get("kind") in ("spread", "ml", "total"):
            model[(e["gid"], e["kind"])] = e
    out = []
    for g in slate.get("games") or []:
        o = odds.get(g["gid"]) or {}
        if g["gid"] not in pre or not o:
            continue
        mu = f"{g['away']} @ {g['home']}"
        sides = []
        for side, other in (("home", "away"), ("away", "home")):
            if o.get(f"{side}_spread_sel") and o.get(f"{side}_spread_price") is not None and o.get(f"{other}_spread_price") is not None and o.get(f"{side}_spread") is not None:
                ln = o[f"{side}_spread"]
                sides.append(("spread", g[side], "over", -ln, f"{ln:+g}", o[f"{side}_spread_price"], o[f"{other}_spread_price"], o[f"{side}_spread_sel"]))
            if o.get(f"{side}_ml_sel") and o.get(f"{side}_ml") is not None and o.get(f"{other}_ml") is not None:
                sides.append(("ml", g[side], "over", 0.0, "", o[f"{side}_ml"], o[f"{other}_ml"], o[f"{side}_ml_sel"]))
        for side, other in (("over", "under"), ("under", "over")):
            if o.get(f"{side}_sel") and o.get(f"{side}_price") is not None and o.get(f"{other}_price") is not None and o.get("total") is not None:
                sides.append(("total", "Total", side, o["total"], "", o[f"{side}_price"], o[f"{other}_price"], o[f"{side}_sel"]))
        for kind, name, side, ln, ltxt, price, oprice, sel in sides:
            if sel in have:
                continue
            ip, io = L.implied(price), L.implied(oprice)
            m = model.get((g["gid"], kind))
            p = (1 - m["conf"]) if m and m.get("conf") is not None else ip / (ip + io)
            c = {"kind": kind, "mkt": kind, "name": name, "team": name if kind != "total" else None, "side": side, "line": ln,
                 "line_txt": ltxt, "price": price, "prob": p, "edge": p - ip, "sel": sel, "gid": g["gid"], "matchup": mu}
            out.append(DT.entry(key, c, "lean", start.get(g["gid"])))
            have.add(sel)
    return out


TD_SCALE = 0.82        # Onyx's anytime-TD yes price x this = the chance (NFL v6 fit: priced players
                       # score 17.7% vs 22.0% implied; the margin on a one-sided TD price is that big)
CFB_FIRST_LISTED = 0.9   # share of first touchdowns scored by a listed player (rest: defense, returns, unlisted)


def cfb_td_board(lane, slate, pre, start, DT):
    """College touchdown scorers for "Ask Onyx": every Onyx anytime and first TD price on a
    game not yet started. There is no college touchdown model: the chance is Onyx's price
    with its margin taken out (TD_SCALE, fitted on NFL prices), and first TD is each
    listed player's share of the game's prices x CFB_FIRST_LISTED. So the edge is never
    positive and nothing here is ever value; it answers "who is most likely to score"."""
    odds = lane.load("odds.json", {}) or {}
    games = {g["gid"]: g for g in slate.get("games") or []}
    team_of = {}
    for r in (lane.load("player_games.json", {}) or {}).get("rows") or []:
        team_of[nk(r.get("name"))] = r.get("team")
    first_sum = {}
    for p in odds.get("props") or []:
        if p.get("mkt") == "first_td" and p.get("over") is not None:
            first_sum[p["gid"]] = first_sum.get(p["gid"], 0.0) + L.implied(p["over"])
    out = []
    for p in odds.get("props") or []:
        g = games.get(p.get("gid"))
        if p.get("mkt") not in ("anytime_td", "first_td") or p.get("over") is None or not g or p["gid"] not in pre:
            continue
        imp = L.implied(p["over"])
        tm = team_of.get(nk(p.get("name")))
        tm = tm if tm in (g.get("home"), g.get("away")) else None
        if p["mkt"] == "anytime_td":
            conf = TD_SCALE * imp
        else:
            conf = CFB_FIRST_LISTED * imp / max(first_sum.get(p["gid"], 1.0), 1.0)
        c = {"kind": "prop", "mkt": p["mkt"], "name": p.get("name"), "team": tm, "side": "over", "line": 0.5,
             "price": p["over"], "prob": conf, "edge": conf - imp, "sel": p.get("over_sel"), "gid": p["gid"],
             "matchup": f"{g.get('away')} @ {g.get('home')}"}
        e = DT.entry("cfb", c, "lean", start.get(p["gid"]))
        if p["mkt"] == "anytime_td":
            e["lam"] = round(-math.log(max(1e-6, 1 - conf)), 4)
        out.append(e)
    return out


def write_top(key, lane, slate, model):
    """data/<sport>/top.json for the home page's Top 10 (daily_top.py)."""
    import daily_top as DT
    cands = model.pop("_cands", None) or []
    start = {g["gid"]: g.get("start") for g in slate.get("games") or []}
    for e in slate.get("events") or []:
        for m in e.get("matches") or []:
            start[m["id"]] = m.get("start")
    tracked = {r.get("sel") for r in model.get("picks") or [] if r.get("sel")}
    trial = {r.get("sel") for r in ((model.get("open") or {}).get("rows") or []) if r.get("sel") and not r.get("result")}
    pre = {g["gid"] for g in slate.get("games") or [] if g.get("state") == "pre"} | \
          {m["id"] for e in slate.get("events") or [] for m in e.get("matches") or [] if m.get("state") == "pre"}
    rows = [DT.entry(key, r, "tracked" if r.get("sel") in tracked else "trial" if r.get("sel") in trial else "lean",
                     start.get(r.get("gid")))
            for r in cands if DT.ok(r) and r.get("gid") in pre and not r.get("inj")    # no questionable players in the Top 10
            and (r.get("value_min") or 0) < 1]                                         # nor a side its own test says loses
    DT.write(lane.data, key, slate.get("date"), rows)
    # the full board for "Ask Onyx": every priced side, any price, plus every
    # anytime-TD price with its expected touchdowns (lam) for "2+ TD" questions
    tag = lambda r: "tracked" if r.get("sel") in tracked else "trial" if r.get("sel") in trial else "lean"
    board = [dict(DT.entry(key, r, tag(r), start.get(r.get("gid"))), proj=r.get("proj"))
             for r in cands if r.get("price") is not None and r.get("prob") is not None and r.get("edge") is not None
             and r.get("gid") in pre]
    for r in model.get("td") or []:
        if r.get("any_price") is None or r.get("gid") not in pre:
            continue
        c = {"kind": "prop", "mkt": "anytime_td", "name": r["name"], "pid": r.get("pid"), "team": r.get("team"), "side": "over",
             "line": 0.5, "price": r["any_price"], "prob": r["any"], "edge": r.get("any_edge") or 0.0, "sel": r.get("any_sel"),
             "gid": r["gid"], "matchup": r.get("matchup")}
        board.append(dict(DT.entry(key, c, tag(c), start.get(r["gid"])), lam=round(-math.log(max(1e-6, 1 - r["any"])), 4)))
        if r.get("first_price") is not None:              # first touchdown scorer (shown, never recommended: Onyx won its backtest)
            c1 = dict(c, mkt="first_td", price=r["first_price"], prob=r["first"], edge=r.get("first_edge") or 0.0, sel=r.get("first_sel"))
            board.append(DT.entry(key, c1, "lean", start.get(r["gid"])))
        if r.get("two_price") is not None:                # 2+ touchdowns at Onyx's over 1.5 (v10, information)
            c2 = dict(c, mkt="two_td", line=1.5, price=r["two_price"], prob=r["two"], edge=r.get("two_edge") or 0.0, sel=r.get("two_sel"))
            board.append(DT.entry(key, c2, "lean", start.get(r["gid"])))
    if key == "cfb":
        board += cfb_td_board(lane, slate, pre, start, DT)
    board += both_sides(key, lane, slate, pre, start, board, DT)
    teams = {}
    for g in slate.get("games") or []:
        for side in ("home", "away"):
            if g.get(side) and g.get(side + "_name"):
                teams[g[side]] = g[side + "_name"]
    DT.write_board(lane.data, key, slate.get("date"), board, teams)


def main():
    key = (sys.argv[1:] or ["nfl"])[0]
    lane = Lane(key)
    cfg = lane.cfg
    slate = lane.load("slate.json", {}) or {}
    odds = lane.load("odds.json", None)
    if odds and odds.get("date") != slate.get("date") and cfg["slate"] == "day":
        odds = None   # yesterday's prices never sit on today's slate
    if key == "nfl":
        model = nfl_block(lane, slate, odds)
    elif key in TEAM_MODELS:
        model = team_block(key, lane, slate, odds)
    elif key == "tennis":
        model = tennis_block(lane, slate, odds)
    elif key == "golf":
        model = golf_block(lane, slate)
    else:
        model = lab_block(key, cfg)
    write_top(key, lane, slate, model)
    page_cfg = {"name": cfg["name"], "full": cfg["full"], "kind": cfg["kind"], "espn": cfg["espn"],
                "espn_q": cfg.get("espn_q", ""), "tone": cfg["tone"], "art": cfg["art"],
                "onyx_league": ONYX_LEAGUE.get(key)}
    data = {"sport": key, "cfg": page_cfg, "date": slate.get("date"), "label": slate.get("label"),
            "season": slate.get("season"), "games": slate.get("games") or [], "events": slate.get("events") or [],
            "odds": odds or {}, "model": model,
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    shell = open("sport_shell.html", encoding="utf-8").read()
    mlb = open("shell.html", encoding="utf-8").read()
    i, j = mlb.find("<style>"), mlb.find("</style>")
    if i < 0 or j < i or shell.count("/*MLB_CSS*/") != 1:
        print("ERROR: MLB stylesheet or its placeholder not found")
        return 1
    shell = shell.replace("/*MLB_CSS*/", mlb[i + len("<style>"):j])
    shell = shell.replace("/*SPORT_TITLE*/", cfg["name"].upper() if key != "cfb" else "COLLEGE FOOTBALL")
    shell = shell.replace("/*SPORT_KEY*/", key)
    blob = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    html, n = re.subn(r"/\*SPORT_DATA\*/.*?/\*END_SPORT_DATA\*/", lambda m: "/*SPORT_DATA*/" + blob + "/*END_SPORT_DATA*/",
                      shell, flags=re.S)
    if n != 1:
        print("ERROR: SPORT_DATA marker not found exactly once")
        return 1
    out = f"{key}.html"
    open(out, "w", encoding="utf-8").write(html)
    print(f"=== {cfg['full']}: {len(data['games'])} games, {len(data['events'])} events, "
          f"{len(model['rows'])} projections, odds {'yes' if odds else 'none'} -> {out} ({len(html) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
