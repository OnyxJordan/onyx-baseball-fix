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

import json, re, sys
from datetime import date, datetime, timedelta, timezone

import nba_common
from nba_common import DATA, current_season, game_day, load, save, nk
import nba_model as M
from nba_model import role_gap, VERSION, project_slate, price_side, STATS

SHELL, OUT = "nba_shell.html", "nba.html"
LEDGER = "picks_history.json"

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
PICK_MAX_PER_GAME = 2
PICK_MAX_PER_SLATE = 6
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
        for k in ("spread", "total", "away_ml", "home_ml", "away_ml_sel", "home_ml_sel", "slug"):
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


def qualifies(r, s, pr, game):
    if not pr or pr["src"] != "onyx" or game.get("state") != "pre":
        return False
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
                     "per_game": PICK_MAX_PER_GAME, "per_slate": PICK_MAX_PER_SLATE},
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


def summarize(ledger):
    rec = {"w": 0, "l": 0, "p": 0, "v": 0, "pending": 0, "units": 0.0,
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
        if res in ("W", "L"):
            b = rec["by_stat"][k["stat"]]
            b[res.lower()] += 1
            b["units"] = round(b["units"] + u, 2)
    rec["units"] = round(rec["units"], 2)
    rec["rows"] = list(reversed(ledger[-200:]))
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
    rows, lg = project_slate(slate, prior, pg, tg, th, roles)
    priced = attach_props(rows, props, source)

    ledger = load(LEDGER, [])
    n_graded = grade(ledger, today)
    games = {g["gid"]: g for g in slate["games"]}
    have = {(k["date"], k["pid"], k["stat"]) for k in ledger}
    today_rows = [k for k in ledger if k["date"] == today]
    per_game = {}
    for k in today_rows:
        per_game[k["gid"]] = per_game.get(k["gid"], 0) + 1
    cands = []
    for r in rows:
        for s, pr in r["props"].items():
            if qualifies(r, s, pr, games.get(r["gid"], {})):
                cands.append((pr["edge"], r, s, pr))
    cands.sort(key=lambda c: -c[0])
    added, used_players = 0, {k["pid"] for k in today_rows}
    for edge, r, s, pr in cands:
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
    save(LEDGER, ledger, indent=1)

    media = {p["pid"]: (p.get("hs"), p.get("logo")) for p in slate.get("players", [])}
    players_out = []
    for r in rows:
        if r["min"] < 4 and not r["props"]:
            continue
        out = {k: v for k, v in r.items() if k not in ("prior_gp",)}
        out["hs"], out["img"] = media.get(r["pid"], (None, None))
        players_out.append(out)
    data = {
        "date": today, "source": source, "model_version": VERSION,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "league": lg,
        "meta": {"players_projected": sum(1 for r in rows if not r["out"] and r["min"] >= 10),
                 "priced": priced, "picks": len(today_rows)},
        "games": slate["games"], "players": players_out,
        "picks": today_rows, "record": summarize(ledger),
        # 80px team logos baked in (tools/nba_make_logos.py): no third-party
        # host needed at page load
        "logos": load("team_logos.json", {}),
        "engine": engine_card(slate, tg, lg, hist, th),
    }
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
          f"(today {len(today_rows)}), record {rec['w']}-{rec['l']}-{rec['p']} {rec['units']:+.2f}u")
    print(f"  wrote {OUT} ({len(html) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
