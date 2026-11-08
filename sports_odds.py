#!/usr/bin/env python3
"""
sports_odds.py - Onyx book prices for one sport (OpticOdds, OPTICODDS_API_KEY).

    python3 sports_odds.py nfl|cfb|cbb|nhl|tennis

Markets per sport are the ones the Onyx book actually prices, from the
markets probe (tools/onyx_markets_probe.py, run 10/26):
  NFL / college football  moneyline, point_spread, total_points; player
                          passing / rushing / receiving yards, receptions,
                          passing touchdowns, anytime touchdown scorer
  college basketball      moneyline, point_spread, total_points; player points,
                          rebounds, assists and made threes when Onyx posts them
                          (the NBA market ids, nba_odds.py; added 11/2, not yet
                          confirmed by a markets probe on ncaab)
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
from fetch_onyx import http_json, OPTIC, ONYX_BOOKS   # noqa: E402

SEL_RE = re.compile(r"selection=([0-9a-fA-F-]{36})")
FOOTBALL_PROPS = {"player_passing_yards": "pass_yds", "player_rushing_yards": "rush_yds",
                  "player_receiving_yards": "rec_yds", "player_receptions": "rec",
                  "player_passing_touchdowns": "pass_td", "player_passing_attempts": "pass_att",
                  "player_passing_+_rushing_yards": "pass_rush_yds", "player_rushing_+_receiving_yards": "rush_rec_yds"}
MARKETS = {
    "nfl": {"game": ("moneyline", "point_spread", "total_points"), "props": FOOTBALL_PROPS,
            "yes": {"anytime_touchdown_scorer": "anytime_td", "first_touchdown_scorer": "first_td"}, "extra": ("player_touchdowns",)},
    "cfb": {"game": ("moneyline", "point_spread", "total_points"), "props": FOOTBALL_PROPS,
            "yes": {"anytime_touchdown_scorer": "anytime_td", "first_touchdown_scorer": "first_td"}},
    "cbb": {"game": ("moneyline", "point_spread", "total_points"),
            "props": {"player_points": "points", "player_rebounds": "rebounds", "player_assists": "assists",
                      "player_made_threes": "threes"}, "yes": {}},
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


def american_prob(p):
    return 100 / (p + 100) if p > 0 else -p / (-p + 100)


MARKET_BOOK = "draftkings"   # the fallback when Onyx prices nothing (never named on the site)


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

    books = [os.environ.get("ONYX_SPORTSBOOK", "").strip()] if os.environ.get("ONYX_SPORTSBOOK", "").strip() else list(ONYX_BOOKS)

    days = 9 if lane.cfg["slate"] == "week" else 2   # 9: reaches next Sunday from Sunday and Monday (next-week capture)
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

    def pull(book):
        out = {"date": slate.get("date"), "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "book": book, "games": {}, "props": [], "matches": {}, "next_props": []}
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
                elif slate.get("next_games"):
                    g, a, h = match_game(f, slate["next_games"])
                    if g:
                        targets[fid] = (lg, ("next", g, a, h))
        mk = "".join(f"&market={urllib.parse.quote(m)}" for m in list(spec["game"]) + list(spec["props"]) + list(spec["yes"]) + list(spec.get("extra", ())))
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
                    if kind[0] == "next":
                        # next week's game: its two-sided player lines only, kept apart from this
                        # week's props (they are keyed by name), for the opening-price capture
                        nxt = {}
                        for od in row.get("odds") or []:
                            price, mid = american(od.get("price")), od.get("market_id")
                            sel, side = od.get("selection") or od.get("name") or "", str(od.get("selection_line") or "").lower()
                            if (price is None or mid not in spec["props"] or not od.get("is_main") or side not in ("over", "under")
                                    or od.get("points") is None or not sel):
                                continue
                            e = nxt.setdefault((sel, mid), {"name": sel, "mkt": spec["props"][mid], "line": float(od["points"]),
                                                            "gid": g["gid"], "over": None, "under": None})
                            if float(od["points"]) == e["line"]:
                                e[side], e[side + "_sel"] = price, _sel(od)
                        out["next_props"] += [e for e in nxt.values() if e["over"] is not None and e["under"] is not None]
                        continue
                    gl = out["games"].setdefault(g["gid"], {})
                    props, alt = {}, {}
                    for od in row.get("odds") or []:
                        price = american(od.get("price"))
                        if price is None:
                            continue
                        mid = od.get("market_id")
                        sel = od.get("selection") or od.get("name") or ""
                        side = str(od.get("selection_line") or "").lower()
                        if mid == "player_touchdowns" and side == "over" and od.get("points") is not None and float(od["points"]) == 1.5 and sel:
                            # 2+ touchdowns (11/1): Onyx's over 1.5 on a player's touchdowns, not its main (0.5) line
                            out["props"].append({"name": sel, "mkt": "two_td", "line": 1.5, "over": price, "over_sel": _sel(od),
                                                 "under": None, "under_sel": None, "gid": g["gid"]})
                            continue
                        if mid in spec["yes"] and od.get("is_main"):
                            who = od.get("selection") or od.get("selection_line") or od.get("name")
                            if who:
                                out["props"].append({"name": who, "mkt": spec["yes"][mid], "line": 0.5, "over": price,
                                                     "over_sel": _sel(od), "under": None, "under_sel": None, "gid": g["gid"]})
                            continue
                        if mid in spec["props"]:
                            if book == MARKET_BOOK and side in ("over", "under") and od.get("points") is not None and sel:
                                # the fallback book flags one side of a line as main (college lines, 11/5): pair
                                # both sides at every line, then keep the main line if it is two-sided, else the
                                # closest two-sided line to it (below)
                                alt.setdefault((sel, mid), {}).setdefault(float(od["points"]), {})[side] = (price, bool(od.get("is_main")))
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
                    for (sel_, mid_), lines in alt.items():
                        e = props.get((sel_, mid_))
                        if e and e["over"] is not None and e["under"] is not None:
                            continue
                        two = [(ln, v) for ln, v in lines.items() if "over" in v and "under" in v]
                        if not two:
                            continue
                        main = next((ln for ln, v in lines.items() if any(x[1] for x in v.values())), None)
                        ln, v = min(two, key=lambda t: (abs(t[0] - main) if main is not None else 0,
                                                        abs(american_prob(t[1]["over"][0]) - 0.5)))
                        props[(sel_, mid_)] = {"name": sel_, "mkt": spec["props"][mid_], "line": ln, "gid": g["gid"],
                                               "over": v["over"][0], "under": v["under"][0], "over_sel": None, "under_sel": None}
                    out["props"] += [e for e in props.values() if e["over"] is not None or e["under"] is not None]
        out["games"] = {k: v for k, v in out["games"].items() if v}
        out["matches"] = {k: v for k, v in out["matches"].items() if len(v) > 1}   # drop matches Onyx has not priced
        return out

    def report(out, book, file):
        print(f"{key} odds: book '{book}' -> {file} · {len(fixtures)} fixtures · "
              f"{len(out['games'])} games with lines, {len(out['props'])} player lines, {len(out['matches'])} matches"
              + (f", {len(out['next_props'])} next-week player lines" if out["next_props"] else ""))

    # Onyx's books in order: the first that prices anything is Onyx's live book (11/8)
    for book in books:
        out = pull(book)
        if out["games"] or out["props"] or out["matches"]:
            break
    lane.save("odds.json", out, indent=None)       # Onyx prices only, even when empty: the ledgers and picks read this file
    report(out, book, "odds.json")
    # 11/5 (Jordan): when Onyx's feed has an issue (at 10 AM ET that day it went silent in every sport),
    # fall back to DraftKings lines so every game still gets a lean. They go to market.json, never
    # odds.json: sports_build prices leans from them, labelled "Market line" on the page, and nothing
    # priced from them is ever tracked, logged or graded.
    if not (out["games"] or out["props"] or out["matches"]):
        mk_out = pull(MARKET_BOOK)
        mk_out["fallback"] = True
        lane.save("market.json", mk_out, indent=None)
        report(mk_out, MARKET_BOOK, "market.json (fallback)")
    elif lane.load("market.json", None) is not None:
        lane.save("market.json", {"date": out["date"], "fetched": out["fetched"], "fallback": False, "games": {}, "props": [], "matches": {}}, indent=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
