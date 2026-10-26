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

ONYX_LEAGUE = {"nfl": "NFL", "cfb": "NCAAF", "nhl": "NHL"}

ROADMAP = {
    "nfl": ["Onyx NFL player prices next to every projection (the Onyx feed for the NFL is being wired)",
            "Backtest the projections against a full season of real Onyx lines; tracked picks switch on only if they beat the price",
            "Injury and inactive feed, so a scratched player never gets a lean",
            "Touchdown scorer and passing touchdown markets"],
    "cfb": ["Onyx college football game lines and player markets",
            "Team ratings from drive efficiency, tested against the closing Onyx spread before any pick",
            "Player projections, built on the NFL engine"],
    "nhl": ["Onyx NHL lines: moneyline, puck line, totals and player shots and points",
            "Skater shot and point projections from time on ice and shot rates, backtested before any pick",
            "Goalie confirmations and save projections"],
    "tennis": ["Onyx match prices for every ATP and WTA singles match",
               "Serve and return point model by surface, tested against Onyx match prices before any pick",
               "Live point-by-point momentum in the match center"],
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
    block = {"status": "lab", "version": M.VERSION, "title": "Player projections, tested in the open",
             "note": ("Projections for passing, rushing and receiving yards and receptions, built from every box score this season "
                      "with last season as the prior and the opponent's defense, and tested every build on games the model never saw. "
                      "They are leans, not picks: tracked picks switch on only after the model is backtested against real Onyx prices."),
             "method": [METHOD["football"],
                        "Each projection blends this season's games (recent weeks weigh more) with last season's average, then adjusts for how much of that stat the opponent's defense has allowed, regressed toward league average.",
                        "The test below re-runs on every build: for every player-game this season from week 3 on, the model's projection against two simple baselines a bettor would use, the season average and the last-3 average. Lower error is better."],
             "roadmap": ROADMAP["nfl"], "tests": [], "rows": [], "top": []}
    if not rows or not season:
        return block
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
                                "line": ln.get("line") if ln else None})
    out.sort(key=lambda r: -r["proj"])
    block["rows"] = out
    # the slate's headline numbers: best projection per market
    top = []
    for s in M.STATS:
        top += [r for r in out if r["mkt"] == s][:2]
    block["top"] = top
    return block


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
    model = nfl_block(lane, slate, odds) if key == "nfl" else lab_block(key, cfg)
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
