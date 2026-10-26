#!/usr/bin/env python3
"""
sports_odds.py - Onyx book prices for one sport (OpticOdds, OPTICODDS_API_KEY).

    python3 sports_odds.py nfl|cfb|nhl|tennis

Markets per sport are the ones the Onyx book actually prices, from the
markets probe (tools/onyx_markets_probe.py, run 10/26):
  NFL / college football  moneyline, point_spread, total_points; player
                          passing / rushing / receiving yards, receptions,
                          passing touchdowns, anytime touchdown scorer
  NHL                     moneyline, puck_line, total_goals; player points,
                          assists (Onyx prices no shots on goal)
  tennis (ATP main tour)  moneyline, game_spread, total_games
  golf                    nothing priced by Onyx on 10/26: no fetch
Main lines only (is_main). Every price keeps Onyx's own share-link selection
uuid, so a tap opens that exact ticket. Writes data/<sport>/odds.json:
  {date, fetched, book, games: {espn gid: {...}}, props: [...], matches: {...}}
Fixtures are matched to the ESPN slate by team (or player) name. A missing
key or a failed call leaves the previous file alone.
"""

import json, os, re, sys, time, urllib.parse
from datetime import datetime, timedelta, timezone

from sports_common import Lane, american, game_day, nk

sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC   # noqa: E402

SEL_RE = re.compile(r"selection=([0-9a-fA-F-]{36})")
FOOTBALL_PROPS = {"player_passing_yards": "pass_yds", "player_rushing_yards": "rush_yds",
                  "player_receiving_yards": "rec_yds", "player_receptions": "rec",
                  "player_passing_touchdowns": "pass_td"}
MARKETS = {
    "nfl": {"game": ("moneyline", "point_spread", "total_points"), "props": FOOTBALL_PROPS, "yes": {"anytime_touchdown_scorer": "anytime_td"}},
    "cfb": {"game": ("moneyline", "point_spread", "total_points"), "props": FOOTBALL_PROPS, "yes": {"anytime_touchdown_scorer": "anytime_td"}},
    "nhl": {"game": ("moneyline", "puck_line", "total_goals"), "props": {"player_points": "points", "player_assists": "assists"}, "yes": {}},
    "tennis": {"game": ("moneyline", "game_spread", "total_games"), "props": {}, "yes": {}, "leagues": ("atp", "wta")},
}
SPREAD = {"point_spread", "puck_line", "game_spread"}
TOTAL = {"total_points", "total_goals", "total_games"}


def _sel(od):
    dl = od.get("deep_link") or {}
    for k in ("desktop", "ios", "android"):
        m = SEL_RE.search(str(dl.get(k) or ""))
        if m:
            return m.group(1)
    return None


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", "", nk(s))


def team_match(name, g, side):
    """How well an OpticOdds team name fits one side of an ESPN game:
    3 exact full name, 2 exact location (college: 'Western Kentucky'),
    1 one name a prefix of the other, 0 no match."""
    n = _norm(name)
    full, loc, short = _norm(g.get(side + "_name")), _norm(g.get(side + "_loc")), _norm(g.get(side + "_short"))
    if not n:
        return 0
    if n == full:
        return 3
    if n in (loc, short):
        return 2
    if full.startswith(n + " ") or n.startswith(full + " "):
        return 1
    return 0


def match_game(fx, games):
    a = ((fx.get("away_competitors") or [{}])[0]).get("name")
    h = ((fx.get("home_competitors") or [{}])[0]).get("name")
    best, score = None, 0
    for g in games:
        sc = min(team_match(a, g, "away"), team_match(h, g, "home"))
        if sc > score:
            best, score = g, sc
    return best, a, h


def match_tennis(fx, events):
    names = {_norm(c.get("name")).split(" ")[-1] for c in (fx.get("home_competitors") or []) + (fx.get("away_competitors") or [])}
    for e in events:
        for m in e.get("matches") or []:
            if m.get("state") == "post":
                continue
            last = {_norm(p.get("name")).split(" ")[-1] for p in m.get("p") or []}
            if len(names) == 2 and names == last:
                return m
    return None


def main():
    key = (sys.argv[1:] or ["nfl"])[0]
    if key not in MARKETS:
        print(f"{key} odds: Onyx prices nothing for this sport yet (markets probe 10/26); skipping")
        return 0
    lane = Lane(key)
    okey = os.environ.get("OPTICODDS_API_KEY", "").strip()
    if not okey:
        print(f"{key} odds: OPTICODDS_API_KEY not set; no Onyx prices this run")
        return 0
    slate = lane.load("slate.json", {}) or {}
    sport, league = lane.cfg["optic"]
    spec = MARKETS[key]
    hdr = {"X-Api-Key": okey}

    def get(url):
        for attempt in range(4):
            try:
                return http_json(url, headers=hdr)
            except Exception as e:
                if "429" in str(e) and attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                print(f"  {key} odds: {str(e)[:160]}")
                return None
            finally:
                time.sleep(0.3)

    try:
        book = json.load(open("data/onyx_games.json", encoding="utf-8")).get("book") or "onyx_odds"
    except Exception:
        book = "onyx_odds"
    book = os.environ.get("ONYX_SPORTSBOOK", "").strip() or book

    days = 7 if lane.cfg["slate"] == "week" else 2
    start = datetime.strptime(slate.get("date") or str(game_day()), "%Y-%m-%d")
    leagues = spec.get("leagues") or (league,)
    fixtures = {}
    for lg in leagues:
        for d in range(days):
            day = (start + timedelta(days=d)).strftime("%Y-%m-%d")
            r = get(f"{OPTIC}/fixtures?sport={sport}&league={lg}&start_date={day}") or {}
            for f in r.get("data") or []:
                if str(f.get("status") or "unplayed").lower() in ("unplayed", "live"):
                    fixtures[f["id"]] = (lg, f)
    if not fixtures:
        print(f"{key} odds: no upcoming fixtures")
        return 0

    out = {"date": slate.get("date"), "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "book": book, "games": {}, "props": [], "matches": {}}
    targets = {}
    for fid, (lg, f) in fixtures.items():
        if key == "tennis":
            m = match_tennis(f, slate.get("events") or [])
            if m:
                targets[fid] = (lg, ("match", m))
        else:
            g, a, h = match_game(f, slate.get("games") or [])
            if g and g.get("state") != "post":
                targets[fid] = (lg, ("game", g, a, h))
    mk = "".join(f"&market={m}" for m in list(spec["game"]) + list(spec["props"]) + list(spec["yes"]))
    by_league = {}
    for fid, (lg, t) in targets.items():
        by_league.setdefault(lg, []).append(fid)
    for lg, fids in by_league.items():
        for i in range(0, len(fids), 5):
            q = "".join(f"&fixture_id={urllib.parse.quote(f)}" for f in fids[i:i + 5])
            r = get(f"{OPTIC}/fixtures/odds?sport={sport}&league={lg}&sportsbook={urllib.parse.quote(book)}"
                    f"&odds_format=AMERICAN{q}{mk}") or {}
            for row in r.get("data") or []:
                t = targets.get(row.get("id"))
                if not t:
                    continue
                kind = t[1]
                if kind[0] == "match":
                    m = kind[1]
                    if os.environ.get("ODDS_DEBUG") and not out["matches"]:
                        print("  debug tennis row:", json.dumps((row.get("odds") or [])[:3])[:900])
                    names = [_norm(p.get("name")).split(" ")[-1] for p in m["p"]]
                    mo = out["matches"].setdefault(m["id"], {"p": [p["name"] for p in m["p"]]})
                    for od in row.get("odds") or []:
                        price = american(od.get("price"))
                        if price is None or not od.get("is_main"):
                            continue
                        mid, who = od.get("market_id"), _norm(od.get("selection") or od.get("name")).split(" ")
                        idx = next((j for j, n in enumerate(names) if n and n in who), None)
                        if mid == "moneyline" and idx is not None:
                            mo[f"ml{idx}"], mo[f"ml{idx}_sel"] = price, _sel(od)
                        elif mid in TOTAL and od.get("points") is not None:
                            side = str(od.get("selection_line") or "").lower()
                            if side in ("over", "under"):
                                mo["total"] = float(od["points"])
                                mo[side], mo[side + "_sel"] = price, _sel(od)
                        elif mid in SPREAD and idx is not None and od.get("points") is not None:
                            mo[f"sp{idx}"], mo[f"sp{idx}_price"], mo[f"sp{idx}_sel"] = float(od["points"]), price, _sel(od)
                    continue
                g, a_name, h_name = kind[1], kind[2], kind[3]
                gl = out["games"].setdefault(g["gid"], {})
                props = {}
                for od in row.get("odds") or []:
                    price = american(od.get("price"))
                    if price is None:
                        continue
                    mid = od.get("market_id")
                    sel = od.get("selection") or od.get("name") or ""
                    side = str(od.get("selection_line") or "").lower()
                    if mid in spec["yes"] and od.get("is_main"):
                        who = od.get("selection") or od.get("selection_line") or od.get("name")
                        if who:
                            out["props"].append({"name": who, "mkt": spec["yes"][mid], "line": 0.5, "over": price,
                                                 "over_sel": _sel(od), "under": None, "under_sel": None, "gid": g["gid"]})
                        continue
                    if mid in spec["props"]:
                        if not od.get("is_main") or side not in ("over", "under") or od.get("points") is None or not sel:
                            continue
                        e = props.setdefault((sel, mid), {"name": sel, "mkt": spec["props"][mid], "line": float(od["points"]),
                                                          "gid": g["gid"], "over": None, "under": None})
                        if float(od["points"]) != e["line"]:
                            continue
                        e[side], e[side + "_sel"] = price, _sel(od)
                        continue
                    if not od.get("is_main"):
                        continue
                    is_home = _norm(sel) == _norm(h_name) or (team_match(sel, g, "home") and not team_match(sel, g, "away"))
                    is_away = _norm(sel) == _norm(a_name) or (team_match(sel, g, "away") and not team_match(sel, g, "home"))
                    if mid == "moneyline":
                        if is_home:
                            gl["home_ml"], gl["home_ml_sel"] = price, _sel(od)
                        elif is_away:
                            gl["away_ml"], gl["away_ml_sel"] = price, _sel(od)
                    elif mid in SPREAD and od.get("points") is not None:
                        if is_home:
                            gl["home_spread"], gl["home_spread_price"], gl["home_spread_sel"] = float(od["points"]), price, _sel(od)
                        elif is_away:
                            gl["away_spread"], gl["away_spread_price"], gl["away_spread_sel"] = float(od["points"]), price, _sel(od)
                    elif mid in TOTAL and od.get("points") is not None and side in ("over", "under"):
                        gl["total"] = float(od["points"])
                        gl[side + "_price"], gl[side + "_sel"] = price, _sel(od)
                out["props"] += [e for e in props.values() if e["over"] is not None or e["under"] is not None]
    out["games"] = {k: v for k, v in out["games"].items() if v}
    lane.save("odds.json", out, indent=None)
    print(f"{key} odds: book '{book}' · {len(fixtures)} fixtures, {len(targets)} matched to the slate · "
          f"{len(out['games'])} games with lines, {len(out['props'])} player lines, {len(out['matches'])} matches")
    return 0


if __name__ == "__main__":
    sys.exit(main())
