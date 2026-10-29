#!/usr/bin/env python3
"""
nba_odds.py - NBA prices from the ONYX book (OpticOdds), consensus fills gaps.

Verified against live payloads on 10/24 (book id 'onyx_odds', the same one
fetch_onyx.py resolves for MLB):
  /fixtures/odds?...&market=player_points&market=player_rebounds
     &market=player_assists&market=moneyline&market=point_spread
     &market=total_points
  Player props carry an alternate ladder; the main line is the pair flagged
  is_main (both over and under). Every row carries Onyx's own share link
  (deep_link.desktop = app.onyxodds.com/share?selection=<uuid>&referrer=..);
  the uuid is kept per side so a tap opens that exact ticket and several
  uuids build a parlay.

The Odds API (ODDS_API_KEY) fills player-markets Onyx did not price. That
key also feeds MLB and props cost credits per event, so the pull is
throttled and skipped once Onyx covers the slate.

Writes data/nba/props.json:
  {date, fetched, players: {nk(name): {name, pid, pts|reb|ast: {line, over,
   under, over_sel, under_sel, src}}}, games: {AWAY_HOME: {gid, slug,
   spread, total, away_ml, home_ml, away_ml_sel, home_ml_sel, src,
   away/home_spread(_price, _sel), over/under_price, over/under_sel}}}
"""

import json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

from nba_common import ET, game_day, load, save, team_abbr, nk, american_from_any
from fetch_onyx import http_json, OPTIC

STATS = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast"}
GAME_MKTS = ("moneyline", "point_spread", "total_points")
# priced by Onyx but not modeled for picks: shown on the player bet card
# The 10/26 markets probe (tools/onyx_markets_probe.py) found Onyx also
# prices points + rebounds + assists, points + rebounds and points + assists;
# an earlier check that asked only for named markets had missed them.
EXTRA = {"player_made_threes": "fg3", "player_double_double": "dd", "player_triple_double": "td",
         "player_points_+_rebounds_+_assists": "pra", "player_points_+_rebounds": "pr",
         "player_points_+_assists": "pa"}
OAPI = "https://api.the-odds-api.com/v4/sports/basketball_nba"
BOOK_PREF = ["draftkings", "fanduel", "betmgm", "caesars"]
PROPS_MIN_AGE_MIN = int(os.environ.get("NBA_PROPS_MIN_AGE_MIN", "90"))
SEL_RE = re.compile(r"selection=([0-9a-fA-F-]{36})")


def _sel(od):
    dl = od.get("deep_link") or {}
    for k in ("desktop", "ios", "android"):
        m = SEL_RE.search(str(dl.get(k) or ""))
        if m:
            return m.group(1)
    return None


def current_slate():
    """Today's slate: OpticOdds files first, the ESPN backup otherwise."""
    today = str(game_day())
    for path in ("slate.json", "espn/slate.json"):
        s = load(path, {})
        if s.get("date") == today and s.get("games"):
            return s
    return {}


def onyx_pull(key, slate):
    hdr = {"X-Api-Key": key}
    def get(url):
        for attempt in range(5):
            try:
                return http_json(url, headers=hdr)
            except Exception as e:
                msg = str(e)
                if "HTTP 429" in msg and attempt < 4:
                    time.sleep(min(30, 5 * (attempt + 1)))
                    continue
                print(f"nba onyx: {msg[:200]}")
                return None
            finally:
                time.sleep(0.4)

    try:
        book = json.load(open("data/onyx_games.json", encoding="utf-8")).get("book") or "onyx_odds"
    except Exception:
        book = "onyx_odds"
    book = os.environ.get("ONYX_SPORTSBOOK", "").strip() or book

    # fixture ids: an OpticOdds slate already carries them; the ESPN backup
    # slate needs them looked up by team pair
    pairs = {f"{g['away']}_{g['home']}": g for g in slate["games"] if g.get("state") != "post"}
    fids = {k: g["gid"] for k, g in pairs.items() if slate.get("source") == "optic"}
    slugs = {k: g.get("slug") for k, g in pairs.items() if g.get("slug")}
    if len(fids) < len(pairs):
        today = datetime.strptime(slate["date"], "%Y-%m-%d")
        for d in (today, today + timedelta(days=1)):
            r = get(f"{OPTIC}/fixtures?sport=basketball&league=nba&start_date={d:%Y-%m-%d}") or {}
            for f in r.get("data") or []:
                a = team_abbr(((f.get("away_competitors") or [{}])[0]).get("name"))
                h = team_abbr(((f.get("home_competitors") or [{}])[0]).get("name"))
                k = f"{a}_{h}"
                if k in pairs and k not in fids:
                    fids[k], slugs[k] = f["id"], f.get("game_id")
    if not fids:
        print("nba onyx: no fixtures to price")
        return {}, {}
    by_fid = {v: k for k, v in fids.items()}
    mk = "".join(f"&market={m}" for m in list(STATS) + list(EXTRA) + list(GAME_MKTS))

    players, games = {}, {}
    order = list(fids.items())
    for i in range(0, len(order), 5):
        chunk = order[i:i + 5]
        q = "".join(f"&fixture_id={urllib.parse.quote(f)}" for _, f in chunk)
        r = get(f"{OPTIC}/fixtures/odds?sport=basketball&league=nba"
                f"&sportsbook={urllib.parse.quote(book)}&odds_format=AMERICAN{q}{mk}")
        for row in (r or {}).get("data") or []:
            gk = by_fid.get(row.get("id"))
            if not gk:
                continue
            away, home = gk.split("_")
            gl = {"gid": row.get("id"), "slug": slugs.get(gk) or row.get("game_id"), "src": "onyx"}
            ladders, ladders_all, extras = {}, {}, {}
            for od in row.get("odds") or []:
                m = od.get("market_id")
                price = american_from_any(od.get("price"))
                if price is None:
                    continue
                if m in STATS or m in EXTRA:
                    side = str(od.get("selection_line") or "").lower()
                    name = od.get("selection") or ""
                    stat = STATS.get(m) or EXTRA[m]
                    if side not in ("over", "under", "yes", "no") or not name:
                        continue
                    side = {"yes": "over", "no": "under"}.get(side, side)
                    pts_ = float(od["points"]) if od.get("points") is not None else 0.5
                    # the whole ladder (alternates are over-only), for the bet card
                    lad = ladders_all.setdefault((name, stat), {})
                    rung = lad.setdefault(pts_, {})
                    rung[side], rung[side + "_sel"] = price, _sel(od)
                    if m in EXTRA or not od.get("is_main"):
                        if m in EXTRA and od.get("is_main"):
                            ex = extras.setdefault((name, stat), {"line": pts_, "pid": od.get("player_id")})
                            ex[side], ex[side + "_sel"] = price, _sel(od)
                        continue   # alternates (the 9.5 ... 39.5 ladder) never set the main line
                    if od.get("points") is None:
                        continue
                    e = ladders.setdefault((name, STATS[m]), {"line": float(od["points"]),
                                                             "pid": od.get("player_id")})
                    if float(od["points"]) != e["line"]:
                        continue
                    e[side], e[side + "_sel"] = price, _sel(od)
                elif m == "moneyline":
                    t = team_abbr(od.get("selection") or od.get("name"))
                    if t in (away, home):
                        side = "away" if t == away else "home"
                        gl[f"{side}_ml"], gl[f"{side}_ml_sel"] = price, _sel(od)
                elif m == "point_spread" and od.get("is_main"):
                    # both sides, priced and tappable on the scoreboard (like every other sport)
                    t = team_abbr(od.get("selection"))
                    if t in (away, home) and od.get("points") is not None:
                        side = "away" if t == away else "home"
                        gl[f"{side}_spread"], gl[f"{side}_spread_price"], gl[f"{side}_spread_sel"] = float(od["points"]), price, _sel(od)
                        if t == home:
                            gl["spread"] = float(od["points"])
                elif m == "total_points" and od.get("is_main") and od.get("points") is not None:
                    gl["total"] = float(od["points"])
                    ts = str(od.get("selection_line") or "").lower()
                    if ts in ("over", "under"):
                        gl[f"{ts}_price"], gl[f"{ts}_sel"] = price, _sel(od)
            for (name, stat), e in list(ladders.items()) + list(extras.items()):
                if e.get("over") is None and e.get("under") is None:
                    continue
                rec = players.setdefault(nk(name), {"name": name})
                if e.get("pid"):
                    rec["optic_pid"] = e["pid"]
                rec[stat] = {"line": e["line"], "over": e.get("over"), "under": e.get("under"),
                             "over_sel": e.get("over_sel"), "under_sel": e.get("under_sel"), "src": "onyx"}
            # ladder rows: [line, over, over_sel, under, under_sel], low to high
            for (name, stat), lad in ladders_all.items():
                rec = players.get(nk(name))
                if rec is None or stat not in rec:
                    continue
                rec[stat]["ladder"] = [[ln, r.get("over"), r.get("over_sel"), r.get("under"), r.get("under_sel")]
                                       for ln, r in sorted(lad.items())]
            games[gk] = gl
    n = sum(1 for r in players.values() for s in STATS.values() if s in r)
    print(f"nba onyx: book '{book}' priced {n} player-markets ({len(players)} players) "
          f"and lines for {len(games)} of {len(fids)} games")
    return players, games


def _oapi(path, key, **params):
    params["apiKey"] = key
    url = f"{OAPI}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8")), r.headers.get("x-requests-remaining")


def consensus_pull(key, slate):
    meta = load("props_meta.json", {})
    age = (time.time() - meta.get("consensus_ts", 0)) / 60
    if meta.get("date") == slate["date"] and age < PROPS_MIN_AGE_MIN:
        print(f"nba odds api: last consensus pull {age:.0f} min ago; skipping")
        return {}
    events, _ = _oapi("/events", key)
    pairs = {f"{g['away']}_{g['home']}" for g in slate["games"] if g.get("state") == "pre"}
    out, remaining, n_ev = {}, None, 0
    for e in events:
        try:
            dt = datetime.fromisoformat(e["commence_time"].replace("Z", "+00:00"))
        except Exception:
            continue
        if str(game_day(dt.astimezone(ET))) != slate["date"]:
            continue
        if f"{team_abbr(e.get('away_team'))}_{team_abbr(e.get('home_team'))}" not in pairs:
            continue
        try:
            data, remaining = _oapi(f"/events/{e['id']}/odds", key, regions="us",
                                    markets=",".join(STATS), oddsFormat="american")
        except Exception as ex:
            print(f"  consensus props failed for {e.get('away_team')} @ {e.get('home_team')}: {ex}")
            continue
        n_ev += 1
        books = sorted(data.get("bookmakers") or [],
                       key=lambda b: BOOK_PREF.index(b["key"]) if b.get("key") in BOOK_PREF else 99)
        for b in books:
            for m in b.get("markets", []):
                stat = STATS.get(m.get("key"))
                for o in m.get("outcomes", []) if stat else []:
                    name, pt, price = o.get("description"), o.get("point"), o.get("price")
                    if not name or pt is None or price is None:
                        continue
                    rec = out.setdefault(nk(name), {"name": name})
                    e2 = rec.setdefault(stat, {"line": float(pt), "src": "consensus", "book": b.get("key")})
                    if e2.get("book") != b.get("key") or float(pt) != e2["line"]:
                        continue
                    e2["over" if o.get("name") == "Over" else "under"] = int(price)
    save("props_meta.json", {"date": slate["date"], "consensus_ts": int(time.time()),
                             "events": n_ev, "remaining": remaining})
    print(f"nba odds api: consensus props for {len(out)} players over {n_ev} events "
          f"(credits remaining {remaining})")
    return out


def main():
    slate = current_slate()
    if not slate:
        print("nba odds: no NBA slate today; nothing to price")
        return 0
    prev = load("props.json", {})
    same = prev.get("date") == slate["date"]
    players = dict(prev.get("players") or {}) if same else {}
    games = dict(prev.get("games") or {}) if same else {}

    okey = os.environ.get("OPTICODDS_API_KEY", "").strip()
    n_onyx = 0
    if okey:
        try:
            o_players, o_games = onyx_pull(okey, slate)
            ALL = list(STATS.values()) + list(EXTRA.values())
            had = sum(1 for cur in players.values() for s in ALL if (cur.get(s) or {}).get("src") == "onyx")
            got = sum(1 for rec in o_players.values() for s in ALL if s in rec)
            if o_players and got >= 0.6 * had:
                # a market Onyx no longer lists (taken down: a scratch, a tipped
                # game) must not keep its old price on the board. Only on a
                # full-looking pull: a partial one (a fixture timed out) must
                # not wipe a whole game's lines.
                for k, cur in players.items():
                    for s in ALL:
                        if (cur.get(s) or {}).get("src") == "onyx" and s not in (o_players.get(k) or {}):
                            cur.pop(s, None)
            for k, rec in o_players.items():
                cur = players.setdefault(k, {"name": rec["name"]})
                cur.update({kk: vv for kk, vv in rec.items() if kk != "name"})
                n_onyx += sum(1 for s in STATS.values() if s in rec)
            for gk, gl in o_games.items():
                games.setdefault(gk, {}).update({k: v for k, v in gl.items() if v is not None})
        except Exception as ex:
            print(f"nba onyx: pull failed ({ex}); keeping earlier prices")
    else:
        print("nba onyx: OPTICODDS_API_KEY not set; no Onyx prices this run")

    akey = os.environ.get("ODDS_API_KEY", "").strip()
    if akey and n_onyx < 40:
        try:
            for k, rec in consensus_pull(akey, slate).items():
                cur = players.setdefault(k, {"name": rec["name"]})
                for s in STATS.values():
                    # Onyx wins per player-market; consensus only fills holes
                    if s in rec and (cur.get(s) or {}).get("src") != "onyx":
                        cur[s] = rec[s]
        except Exception as ex:
            print(f"nba odds api: failed ({ex})")

    # "fetched" is when ONYX prices were last pulled: a failed or empty pull
    # keeps the earlier time, so the page and the pick guard see their real age
    fetched = datetime.now(timezone.utc).isoformat(timespec="seconds") if n_onyx else (prev.get("fetched") if same else None)
    save("props.json", {"date": slate["date"],
                        "fetched": fetched,
                        "players": players, "games": games})
    n = sum(1 for r in players.values() for s in STATS.values() if s in r)
    print(f"nba odds: {n} priced player-markets for {slate['date']} ({n_onyx} from Onyx this run)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
