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

import json, re, sys
from datetime import datetime, timezone

from sports_common import Lane, SPORTS, nk
import sports_lab as L

ONYX_LEAGUE = {"nfl": "NFL", "cfb": "NCAAF", "nhl": "NHL"}

ROADMAP = {
    "nfl": ["Backtest the projections and the game ratings against a full season of real Onyx lines; tracked picks switch on only where they beat the price",
            "Injury and inactive feed, so a scratched player never gets a lean",
            "Touchdown scorer and passing touchdown markets"],
    "cfb": ["Backtest the team ratings against a season of real Onyx spreads and moneylines before any pick",
            "Drive efficiency and tempo in the ratings, so totals beat the league average",
            "Player projections, built on the NFL engine"],
    "nhl": ["Backtest the team ratings against a season of real Onyx moneylines, puck lines and totals before any pick",
            "Goalie confirmations: the starter moves an NHL price more than anything else",
            "Skater point and assist projections from time on ice, for the player lines Onyx prices"],
    "tennis": ["Backtest the Elo ratings against real Onyx match prices before any pick",
               "Surface-specific ratings (hard, clay, grass)",
               "Total games and game spread from a serve and return point model"],
    "golf": ["Onyx outrights, top 5, 10 and 20, and head-to-head matchups",
             "Strokes-gained projections by course fit, tested against Onyx prices before any pick",
             "Live round-by-round leaderboard with each player's Onyx price"],
}
METHOD = {
    "football": "Scores, drives, down and distance, win probability and team stats come from ESPN's public feed, refreshed through the day and polled live on this page every 15 to 30 seconds.",
    "hockey": "Scores, periods, goals and team stats come from ESPN's public feed, polled live on this page every 15 to 30 seconds.",
    "tennis": "Every ATP and WTA singles match this week comes from ESPN's public feed, polled live: set scores, who is serving, rounds and results.",
    "golf": "The leaderboard comes from ESPN's public feed, polled live: position, score to par and every round.",
}


def nfl_block(lane, slate, odds):
    import nfl_model as M
    pg = lane.load("player_games.json", {}) or {}
    rows = pg.get("rows") or []
    season = slate.get("season") or max((r["season"] for r in rows), default=None)
    block = {"status": "lab", "version": M.VERSION, "title": "Player projections and team ratings, tested in the open",
             "note": ("Projections for passing, rushing and receiving yards and receptions, built from every box score this season "
                      "with last season as the prior and the opponent's defense, and tested every build on games the model never saw. "
                      "They are leans, not picks: tracked picks switch on only after the model is backtested against real Onyx prices."),
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
    by = M._games_by_player(rows)
    allowed = M._team_allowed(rows)
    lgc = {}
    last_game = {}
    for r in rows:
        if r["season"] == season:
            k = r["team"]
            last_game[k] = max(last_game.get(k, 0), r["week"])
    props = {(nk(p.get("name")), p.get("mkt")): p for p in (odds or {}).get("props") or []}
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
                for s in M.STATS:
                    pr, info = M.project(gs, s, season, wk, opp, allowed, M.P, lgc)
                    if pr is None:
                        continue
                    ln = props.get((nk(cur[-1]["name"]), s))
                    out.append({"pid": pid, "name": cur[-1]["name"], "hs": cur[-1].get("hs"), "team": team, "opp": opp,
                                "home": home, "gid": g["gid"], "mkt": s, "proj": round(pr, 1),
                                "season": round(info["season"], 1) if info["season"] is not None else None,
                                "l3": [int(v) for v in info["l3"]], "opp_f": round(info["opp"], 3),
                                "line": ln.get("line") if ln else None,
                                "over": ln.get("over") if ln else None, "under": ln.get("under") if ln else None,
                                "over_sel": ln.get("over_sel") if ln else None, "under_sel": ln.get("under_sel") if ln else None})
    # price every two-sided Onyx line: the model's chance, the blend, the edge
    bt = lane.load("backtest.json", None) or {}
    w = ((bt.get("lane") or {}).get("w_props")) or DEFAULT_W
    for r in out:
        if r["line"] is None or r["over"] is None or r["under"] is None:
            continue
        po = M.prob_over(r["mkt"], r["proj"], r["line"])
        ps = L.price_side(po, r["over"], r["under"], w)
        if ps:
            r.update(side=ps["side"], price=ps["price"], sel=r["over_sel"] if ps["side"] == "over" else r["under_sel"],
                     prob=ps["prob"], implied=ps["implied"], edge=ps["edge"], ev=ps["ev"], model_p=ps["model_p"],
                     matchup=f"{r['team']} {'vs' if r['home'] else '@'} {r['opp']}")
    # lines Onyx prices first, largest gap between projection and line first
    out.sort(key=lambda r: (r["line"] is None, -abs(r["proj"] - r["line"]) / max(1.0, r["line"]) if r["line"] is not None else -r["proj"]))
    # the slate's headline numbers: best projection per market
    top = []
    for s in M.STATS:
        top += [r for r in out if r["mkt"] == s][:2]
    block["top"] = top
    # game lines on the same frame as college football and the NHL
    import team_model as T
    games = (lane.load("results.json", {}) or {}).get("games") or []
    gw = ((bt.get("lane") or {}).get("w")) or DEFAULT_W
    R = T.fit(games, slate.get("date") or "9999", M.GAME_P)
    grows, proj = game_rows("nfl", M, slate, odds, R, gw)
    block["tests"].append({"k": "Game win log loss", "v": f"{M.GAME_TEST['logloss']:.3f}",
                           "d": f"vs {M.GAME_TEST['base_logloss']:.3f} home base rate · {M.GAME_TEST['n']} games"})
    block["method"].append("Game lines: every team carries an offense and a defense rating in points, fitted on every final this season and "
                           "last, and each Onyx moneyline, spread and total is priced from them, then blended with Onyx's no-vig price.")
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
    block["proj"] = proj
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
    out.sort(key=lambda r: -r["edge"])
    return out


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


def model_frame(key, lane, slate, odds, M, rows, base, resolve):
    """Gate, lane, ledger and record around a sport's rows."""
    bt, live = L.gate(lane, M.VERSION)
    led = L.Ledger(lane)
    led.grade(resolve)
    picks = []
    if live:
        picks = lane_picks(rows, bt, slate.get("date"))
        for p in picks:
            led.add({k: p.get(k) for k in ("date", "gid", "start", "matchup", "kind", "mkt", "name", "side", "line", "line_txt",
                                           "team_side", "price", "sel", "prob", "implied", "edge", "ev", "model_p", "proj", "hs")})
    led.save()
    rec = led.record()
    base.update(status="live" if live else "lab", version=M.VERSION, backtest=(bt or {}).get("page"),
                changelog=L.changelog(M.__doc__), rows=rows, picks=picks, record=rec if led.rows else None)
    return base


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
              f"recent games weighing more. Each Onyx moneyline, spread and total is priced from them and blended with Onyx's own "
              f"no-vig price. Tracked picks switch on only after the ratings beat real Onyx prices in a backtest."),
        method=[METHOD[cfg["kind"]],
                f"Ratings: {unit} scored = league average + home edge + the team's offense - the opponent's defense, fitted by weighted "
                f"least squares with a pull toward average so a team with three games is not rated off three games.",
                ("Hockey prices: each side's goals are Poisson; a regulation tie goes to overtime. " if cfg["kind"] == "hockey" else
                 "Football prices: the margin and the total are normal around the ratings' projection. ") +
                f"The blend gives the model {round(w * 100)}% and Onyx's no-vig price the rest; edge is the blended chance minus the price's implied chance."],
        tests=[{"k": "Win log loss", "v": f"{TEST['logloss']:.3f}", "d": f"vs {TEST['base_logloss']:.3f} home base rate · {TEST['n']} games from {TEST['window']}"},
               {"k": f"Total error ({unit})", "v": f"{TEST['mae_total']:.2f}", "d": f"vs {TEST['base_mae_total']:.2f} league average"}],
        roadmap=ROADMAP.get(key, []))
    base = model_frame(key, lane, slate, odds, M, rows, base, grade_team(lane))
    base["proj"] = proj
    return base


def tennis_block(lane, slate, odds):
    import tennis_model as TM
    bt = lane.load("backtest.json", None) or {}
    w = ((bt.get("lane") or {}).get("w")) or DEFAULT_W
    rows = tennis_rows(lane, slate, odds, w)
    base = L.model_block(
        title="Elo ratings against every Onyx match price",
        note=("Every ATP and WTA singles player carries an Elo rating built from every completed match since 2023. Each Onyx match "
              "price is set against it and blended with Onyx's own no-vig price. Tracked picks switch on only after the ratings "
              "beat real Onyx prices in a backtest."),
        method=[METHOD["tennis"],
                "Elo: a win moves a rating by K x (1 - expected), K = 150 / (matches + 5)^0.4, so new players move fast and veterans slowly. "
                "Retirements and walkovers are dropped. A player needs 10 matches before the model prices them.",
                f"The blend gives the model {round(w * 100)}% and Onyx's no-vig price the rest."],
        tests=[{"k": "Match log loss", "v": "0.627", "d": "7,875 matches in 2026 the ratings never saw"},
               {"k": "Favourite won", "v": "64.0%", "d": "same matches"}],
        roadmap=ROADMAP["tennis"])
    base = model_frame("tennis", lane, slate, odds, TM, rows, base, grade_tennis(lane))
    base["players"] = tennis_players(lane, slate)
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


def lab_block(key, cfg):
    return {"status": "lab", "version": None, "title": "What is live, and what the model will be",
            "note": (f"Onyx {cfg['name']} is live for scores, the gamecenter and Onyx prices as they post. The {cfg['name']} model "
                     "is in the lab: nothing here is a pick until it has been backtested against real Onyx prices."),
            "method": [METHOD[cfg["kind"]], "Every price on this page is an Onyx price."],
            "roadmap": ROADMAP.get(key, []), "tests": [], "rows": [], "top": []}


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
    else:
        model = lab_block(key, cfg)
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
