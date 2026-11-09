"""
live_log.py - the live value record (on trial): every live value play the site shows, logged the
first time it shows and graded off the final, so live value becomes provable.

    python3 live_log.py            # log what is live now, grade what has finished
    python3 live_log.py --grade    # grade only
    python3 live_log.py --tennis-now   # the minute watcher (live_watch.yml): log tennis picks only

Tennis is logged the minute it qualifies (11/5, Jordan: the 30-minute build logged picks long after the
page showed them, at a different price). live_watch.yml runs `--tennis-now` every 60 seconds all day:
it reads the same live line the page reads and writes each new match pick to data/live/tennis_now.json
(append-only, only the watcher writes it, so the build's rebase can never drop a row). Every build run
copies those rows into data/live/ledger.json untouched, then grades them like every other row. The
build still logs tennis itself as a fallback when the watcher is down; a match is never logged twice.

Runs inside the refresh build (refresh_build.yml, every ~30 minutes through the slate), fail-soft:
any error prints a warning and exits 0, so it can never block a build.

For every sport with a game in progress (NFL, college football, NBA, college basketball, NHL,
ATP / WTA tennis) it reads ESPN's live state and the relay's live line (GET <ai.json url>/live,
the same in-game line the page prices, one book per market, never named), prices every game line
with live_model.py (the same math as live.js; tools/verify_live.js checks they agree) from Onyx's
pregame line (data/<sport>/pregame.json), and appends to data/live/ledger.json each play whose
edge clears the page's Value threshold (3 points, live_model.VALUE) with the gates the page uses
(no game line in the last 15% of a game, nothing over a 12-point disagreement, prices -500..+500).

One row per game, market and side, at the first live line it showed value at: price, our chance,
the edge, the score state and the time.

Live player props (11/9, live-v7): NBA, NFL and college football props are priced the way the page
prices them (live_model.prop_bets = live.js bets(): the relay's live prop line, the player's stat in
ESPN's live box score, his pregame projection from data/<sport>/pregame.json "pp", the parameters in
data/live/prop_params.json) and logged two ways:
  data/live/ledger.json      each prop VALUE play once (one side per player market), kind "prop",
                             with "prop_model" = the prop_params version, graded off the final box
                             score. The page does not call these value until data/live/props_gate.json
                             passes (tools/live_props_backtest.js --gate); this is the gate's sample.
  data/live/prop_snaps.json  every priced live prop at each build (both sides' prices when quoted),
                             at most one snapshot per prop per 10 minutes of game time, 21 days kept,
                             so calibration against real live prices can be tested (--fit reads it).

    python3 live_log.py --dry-run          # everything, but write nothing (prints what it would log)
    python3 live_log.py --ledger=PATH --snaps=PATH   # write somewhere else (tests)

data/live/ledger.json is append-only and sacred like every ledger (validate_build.py's shrink
check). It is NOT Onyx Picks: live models have no backtest against live prices (there is no
historical in-game price data), so this record is how they get one.
"""

import json, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import live_model as LM

ET = ZoneInfo("America/New_York")
LEDGER = Path("data/live/ledger.json")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/"
LEAGUES = {"nfl": ["football/nfl"], "cfb": ["football/college-football"], "nba": ["basketball/nba"], "nhl": ["hockey/nhl"],
           "cbb": ["basketball/mens-college-basketball"], "tennis": ["tennis/atp", "tennis/wta"]}
SBQ = {"cfb": "groups=80", "cbb": "groups=50&limit=400"}
UA = {"User-Agent": "Mozilla/5.0 (onyx live log)"}
NOW = Path("data/live/tennis_now.json")
SNAPS = Path("data/live/prop_snaps.json")
SUMPATH = {"nfl": "football/nfl", "cfb": "football/college-football", "nba": "basketball/nba"}   # live.js SUMPATH: the sports whose props we price
SNAP_DAYS = 21        # prop_snaps.json keeps this many baseball days
SNAP_MIN = 10         # at most one snapshot per prop per this many minutes of game time
SNAP_CAP = 8000       # rows a day, a ceiling well over a full NFL Sunday (about 4,000)
DRY = "--dry-run" in sys.argv
for _a in sys.argv:
    if _a.startswith("--ledger="):
        LEDGER = Path(_a.split("=", 1)[1])
    elif _a.startswith("--snaps="):
        SNAPS = Path(_a.split("=", 1)[1])
VERSION = "live-v7"   # v7 (11/9): live player props logged (kind "prop", one side per player market) and snapshotted (prop_snaps.json)   # v6 (11/6): tennis needs 65%+ (live_model.TN_CONF)   # v5 (11/6): tennis totals, college basketball spreads and moneylines paused (live_model.PAUSED); the starting line falls back to the market line when Onyx has none   # v4 (11/5): tennis logged by the minute watcher at the price the page shows   # v3 (11/5): one tennis pick per match, the most confident; v2 (11/4): tennis needs 60%+; earlier rows stay as logged


def get(url, tries=2):
    for i in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=20)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1 + i)
    return None


def game_day(now=None):
    now = now or datetime.now(ET)
    return (now.astimezone(ET) - timedelta(hours=4)).date().isoformat()


def relay_url():
    try:
        return (json.loads(Path("ai.json").read_text()).get("url") or "").rstrip("/") or None
    except Exception:
        return None


def load_json(p, d):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return d


# ── the pregame Onyx line (live.js pregame()) ────────────────────────────────────────
def same_game(m, home, away):
    return m in (f"{away} @ {home}", f"{home} vs {away}", f"{away} vs {home}")


def pregame(pre, gid, home, away):
    out = {"margin": None, "total": None, "home_win": None, "home_ml": None, "away_ml": None, "pp": None}
    hit = pre.get(str(gid)) if str(gid) in pre and same_game(pre[str(gid)].get("m"), home, away) else None
    if not hit:
        hit = next((v for v in pre.values() if same_game(v.get("m"), home, away)), None)
    if not hit:
        return out
    sp, ml = hit.get("sp") or {}, hit.get("ml") or {}
    out["src"] = hit.get("src") or "onyx"
    out["pp"] = hit.get("pp") or None      # pregame player props: line l, projection j, expected TDs lam, Onyx o / u
    pick = lambda d, n: next((k for k in d if k == n or LM.nk(k) == LM.nk(n)), None)
    hn, an = pick(sp, home), pick(sp, away)
    hl = sp[hn] if hn is not None else (-sp[an] if an is not None else None)
    if hl is not None:
        out["margin"] = -hl
    if hit.get("tot") is not None:
        out["total"] = hit["tot"]
    mh, ma = pick(ml, home), pick(ml, away)
    out["home_ml"] = ml.get(mh) if mh is not None else None
    out["away_ml"] = ml.get(ma) if ma is not None else None
    if mh is not None:
        out["home_win"] = LM.no_vig(ml[mh], ml.get(ma) if ma is not None else None)
    elif ma is not None:
        out["home_win"] = 1 - LM.no_vig(ml[ma], None)
    return out


# ── ESPN live games -> the same state live.js reads ──────────────────────────────────
def sides(c):
    cs = c.get("competitors") or []
    H = {}
    for x in cs:
        H[x.get("homeAway") or ("home" if x.get("order") == 1 else "away")] = x
    if "home" not in H or "away" not in H:
        if len(cs) < 2:
            return None, None
        H = {"away": cs[0], "home": cs[1]}
    return H["home"], H["away"]


def short(x):
    t, a = x.get("team") or {}, x.get("athlete") or {}
    return t.get("abbreviation") or a.get("displayName") or t.get("displayName")


def full(x):
    t, a = x.get("team") or {}, x.get("athlete") or {}
    return t.get("displayName") or a.get("displayName") or t.get("abbreviation") or ""


def live_games(sport):
    pre = load_json(f"data/{sport}/pregame.json", {})
    elo = (load_json("data/tennis/elo.json", {}) or {}).get("r") or {} if sport == "tennis" else {}
    out = []
    for path in LEAGUES[sport]:
        j = get(ESPN + path + "/scoreboard" + ("?" + SBQ[sport] if sport in SBQ else "")) or {}
        for e in j.get("events") or []:
            if sport == "tennis":
                comps = [(gr, c) for gr in e.get("groupings") or [] if "singles" in ((gr.get("grouping") or {}).get("displayName") or "").lower()
                         for c in gr.get("competitions") or []]
            else:
                comps = [(None, (e.get("competitions") or [{}])[0])]
            for gr, c in comps:
                st = c.get("status") or e.get("status") or {}
                if (st.get("type") or {}).get("state") != "in":
                    continue
                h, a = sides(c)
                if not h:
                    continue
                home, away = short(h), short(a)
                g = {"sport": sport, "gid": str(c.get("id") if sport == "tennis" else e.get("id")), "home": home, "away": away,
                     "hn": full(h), "an": full(a), "detail": (st.get("type") or {}).get("shortDetail") or ""}
                P = pregame(pre, g["gid"], home, away)
                if sport == "tennis":
                    la, lb = h.get("linescores") or [], a.get("linescores") or []
                    sets = [(int(x.get("value") or 0), int((lb[i] if i < len(lb) else {}).get("value") or 0)) for i, x in enumerate(la)]
                    srv = 0 if h.get("possession") else 1 if a.get("possession") else None
                    women = "women" in ((gr.get("grouping") or {}).get("displayName") or "").lower()
                    need = 3 if not women and any(s in (e.get("name") or "").lower() for s in ("australian open", "roland", "french open", "wimbledon", "us open")) else 2
                    if P["home_win"] is None:
                        from sports_common import nk as enk
                        ra, rb = elo.get(enk(g["hn"])), elo.get(enk(g["an"]))
                        if ra and rb and ra[1] >= 10 and rb[1] >= 10:
                            P["home_win"] = 1 / (1 + 10 ** ((rb[0] - ra[0]) / 400))
                    stt = LM.tn_state(sets, srv)
                    # sets away-home, like the matchup ("away vs home") and the page cards; srv: who is serving
                    g.update({"f": None, "state": {"sets": " ".join(f"{y}-{x}" for x, y in sets), "srv": ["home", "away"][srv] if srv is not None else None, "need": need}})
                    M = LM.Tennis(P["home_win"], need, stt, "WTA" if women else "ATP")
                else:
                    f = LM.left(sport, st.get("period"), st.get("clock"))
                    if f is None:
                        continue
                    hs, as_ = int(float(h.get("score") or 0)), int(float(a.get("score") or 0))
                    pm = P["margin"] if P["margin"] is not None else ((P["home_win"] - 0.5) * 2 * LM.ML_PTS[sport] if P["home_win"] is not None and sport != "nhl" else 0)
                    gg = {"hs": hs, "as": as_, "f": f, "pre_margin": pm, "pre_total": P["total"] if P["total"] is not None else LM.DEF_TOTAL[sport],
                          "pre_home_win": P["home_win"] if P["home_win"] is not None else 0.5}
                    M = LM.Hockey(gg) if sport == "nhl" else LM.Normal(sport, gg)
                    g.update({"f": f, "state": {"score": f"{away} {as_} - {hs} {home}", "period": st.get("period"), "clock": st.get("displayClock"), "f": round(f, 3)}})
                g["M"], g["pre"] = M, P
                out.append(g)
    return out


def relay_lines(url, sport):
    j = get(f"{url}/live?sport={sport}") if url else None
    return (j or {}).get("games") or []


def match(L, g):
    for x in L:
        if (LM.same_team(x.get("home"), g["hn"]) and LM.same_team(x.get("away"), g["an"])) or \
           (LM.same_team(x.get("home"), g["an"]) and LM.same_team(x.get("away"), g["hn"])):
            return x
    return None


def row_id(sport, gid, b):
    if b.get("kind") == "prop":
        return f"{sport}-{gid}-prop-{LM.pn(b['player']).replace(' ', '_')}-{b['mkt']}-{b['side']}"
    return f"{sport}-{gid}-{b['kind']}-{b['side']}"


def market_key(sport, gid, kind, player=None, mkt=None):
    """One side per market per game; for a prop the market is the player's market."""
    if kind == "prop":
        return (sport, str(gid), "prop|" + LM.pn(player) + "|" + str(mkt))
    return (sport, str(gid), kind)


def live_box(sport, gid):
    """The live box score (ESPN summary) -> live_model.box_stats; None when it cannot be read."""
    j = get(f"{ESPN}{SUMPATH[sport]}/summary?event={gid}")
    return LM.box_stats(sport, j) if j else None


# ── prop_snaps.json: every priced live prop, compact (columnar), for calibration against live prices ──
SNAP_COLS = {"k": ["sport", "gid", "player", "mkt", "proj"], "r": ["t", "k", "line", "over", "under", "p", "cur", "f"]}


def load_snaps():
    j = load_json(SNAPS, None)
    if not isinstance(j, dict) or not isinstance(j.get("days"), dict):
        return {"v": 1, "cols": SNAP_COLS, "days": {}}
    return j


def snap_props(snaps, sport, g, lines, pp, bx, ts):
    """Add one snapshot of every priced prop on this game (both sides' prices). -> rows added."""
    day = snaps["days"].setdefault(game_day(), {"k": [], "r": []})
    K, R = day["k"], day["r"]
    kidx = {tuple(k[:4]): i for i, k in enumerate(K)}
    last = {}
    for r in R:
        last[r[1]] = r[7]
    L = LM.LEN.get(sport)
    step = SNAP_MIN / (L[0] * L[1]) if L else 0.15
    grp = {}
    for x in lines or []:
        if x.get("m") in ("ml", "spread", "total"):
            continue
        o = LM.prop_price(x, pp, bx, g["f"])
        if not o or o["price"] is None:
            continue
        gk = (o["player"], o["mkt"], o["pt"])
        e = grp.setdefault(gk, {"o": o, "over": None, "under": None})
        if o["side"] in ("over", "yes"):
            e["over"] = o["price"]
            e["p"] = o["p"]
        else:
            e["under"] = o["price"]
            e.setdefault("p", 1 - o["p"])
    n = 0
    for (player, mkt, pt), e in grp.items():
        if len(R) >= SNAP_CAP:
            print(f"::warning::prop snapshots: {SNAP_CAP} rows today, not adding more")
            break
        k = (sport, str(g["gid"]), player, mkt)
        if k not in kidx:
            kidx[k] = len(K)
            K.append([sport, str(g["gid"]), player, mkt, round(e["o"]["proj"], 3)])
        ki = kidx[k]
        if ki in last and abs(last[ki] - g["f"]) < step:
            continue
        R.append([ts, ki, pt, e["over"], e["under"], round(e["p"], 4), e["o"]["cur"], round(g["f"], 3)])
        last[ki] = g["f"]
        n += 1
    return n


def save_snaps(snaps):
    """Prune to the last SNAP_DAYS baseball days, then write one row per line (small git diffs)."""
    keep = (datetime.fromisoformat(game_day()) - timedelta(days=SNAP_DAYS - 1)).date().isoformat()
    days = {d: v for d, v in sorted(snaps["days"].items()) if d >= keep}
    c = lambda x: json.dumps(x, separators=(",", ":"), ensure_ascii=False)
    parts = []
    for d, v in days.items():
        parts.append(c(d) + ':{"k":[\n' + ",\n".join(c(k) for k in v["k"]) + '\n],"r":[\n' + ",\n".join(c(r) for r in v["r"]) + "\n]}")
    body = ('{"v":1,"note":"every priced live player prop at each build (live_log.py); r.k indexes k; over/under: the live line\'s prices; '
            'p: our chance of the over (anytime TD: of a TD); f: share of the game left","cols":' + c(SNAP_COLS) + ',"days":{\n' + ",\n".join(parts) + "\n}}\n")
    json.loads(body)      # never write a file that does not parse
    SNAPS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SNAPS.with_suffix(".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(SNAPS)


def log_live(led, url, sports=None, also=(), snaps=None, stats=None):
    """Append new value plays to `led`. `also`: rows logged elsewhere that count as already logged.
    snaps: prop_snaps.json's content, to add every priced live prop to (None: no snapshots).
    stats: a dict that gets the prop counts {props, prop_values, snaps}."""
    seen = list(led) + list(also)
    have = {r["id"] for r in seen}
    # one side per market per game (11/3: Waltert and Yamalapalli to win, and Over 20.5 and Under 22.5,
    # were both logged in one match as the live line swung, so one of each pair was a sure loss): once a
    # game's moneyline, spread or total is logged, the other side of that market is never logged
    taken = {market_key(r["sport"], r["gid"], r["kind"], r.get("player"), r.get("mkt")) for r in seen}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    added = 0
    for sport in sports or LEAGUES:
        G = live_games(sport)
        if not G:
            continue
        L = relay_lines(url, sport)
        print(f"  live {sport}: {len(G)} in play, {len(L)} with a live line")
        for g in G:
            x = match(L, g)
            if not x:
                continue
            B = LM.bets(sport, g, g["M"], x.get("lines") or [], g["pre"])
            if sport == "tennis":
                # one pick per tennis match (11/4, Jordan: a Musetti match showed three different picks as the
                # live line moved): a match already in the record gets nothing more, and a new one logs only
                # its most confident value play, never a second market or the other side
                if any(r["sport"] == "tennis" and str(r["gid"]) == str(g["gid"]) for r in seen):
                    continue
                C = [b for b in B if b["edge"] >= LM.VALUE and b["p"] >= LM.TN_CONF]
                B = [max(C, key=lambda b: (b["p"], b["edge"]))] if C else []
            for b in B:
                if b["edge"] < LM.VALUE:
                    continue
                # tennis: only when the model is confident (11/4, Jordan). Graded tennis live plays to then:
                # under 60% to hit 12-25 (-8.62u; the 50-60% band 8-18), 60%+ 16-7 (+2.16u)
                if sport == "tennis" and b["p"] < LM.TN_CONF:
                    continue
                rid = row_id(sport, g["gid"], b)
                mk = (sport, str(g["gid"]), b["kind"])
                if rid in have or mk in taken:
                    continue
                have.add(rid); taken.add(mk)
                row = {"id": rid, "sport": sport, "gid": g["gid"], "date": game_day(), "logged_at": now,
                            "matchup": f"{g['away']} {'vs' if sport == 'tennis' else '@'} {g['home']}", "home": g["home"], "away": g["away"],
                            "label": b["label"], "kind": b["kind"], "side": b["side"], "line": b["pt"], "price": b["price"],
                            "chance": round(b["p"], 4), "implied": round(LM.implied(b["price"]), 4), "edge": b["edge"], "fair": b["fair"],
                            "state": g["state"], "pre_src": (g.get("pre") or {}).get("src"), "model": VERSION, "result": None, "actual": None, "profit": None, "graded_at": None}
                led.append(row); seen.append(row)
                added += 1
            # live player props: the page's pricing (live_model.prop_bets), the gate's sample
            try:
                added += log_props(led, seen, have, taken, sport, g, x.get("lines") or [], now, snaps, stats)
            except Exception as e:      # a prop problem never costs the game lines
                print(f"::warning::live props {sport} {g['gid']}: {str(e)[:160]}")
    return added


def log_props(led, seen, have, taken, sport, g, lines, now, snaps, stats):
    pp = (g.get("pre") or {}).get("pp")
    if sport not in SUMPATH or not pp or g.get("f") is None or not any(x.get("m") not in ("ml", "spread", "total") for x in lines):
        return 0
    bx = live_box(sport, g["gid"])
    if bx is None:
        return 0
    st = stats if stats is not None else {}
    if snaps is not None:
        st["snaps"] = st.get("snaps", 0) + snap_props(snaps, sport, g, lines, pp, bx, int(time.time()))
    B = LM.prop_bets(sport, g["f"], lines, pp, bx)
    st["props"] = st.get("props", 0) + len(B)
    added = 0
    for b in B:
        if b["edge"] < LM.VALUE:
            continue
        rid = row_id(sport, g["gid"], b)
        mk = market_key(sport, g["gid"], "prop", b["player"], b["mkt"])
        if rid in have or mk in taken:
            continue
        have.add(rid); taken.add(mk)
        row = {"id": rid, "sport": sport, "gid": g["gid"], "date": game_day(), "logged_at": now,
               "matchup": f"{g['away']} @ {g['home']}", "home": g["home"], "away": g["away"],
               "label": b["label"], "kind": "prop", "mkt": b["mkt"], "player": b["player"], "side": b["side"], "line": b["pt"],
               "price": b["price"], "chance": round(b["p"], 4), "implied": round(LM.implied(b["price"]), 4), "edge": b["edge"], "fair": b["fair"],
               "cur": b["cur"], "proj": round(b["proj"], 3), "f": round(g["f"], 3), "state": g["state"], "pre_src": (g.get("pre") or {}).get("src"),
               "model": VERSION, "prop_model": LM.PROP_VERSION, "result": None, "actual": None, "profit": None, "graded_at": None}
        led.append(row); seen.append(row)
        added += 1
        st["prop_values"] = st.get("prop_values", 0) + 1
    return added


# ── grading off ESPN's finals ─────────────────────────────────────────────────────────
def final_of(r):
    """(home score, away score) for a team game; (home games, away games, home won) for tennis;
    'void' for a tennis retirement or walkover; None while not final."""
    d0 = datetime.fromisoformat(r["logged_at"]).astimezone(ET).date()
    for dd in (0, -1, 1):
        day = (d0 + timedelta(days=dd)).strftime("%Y%m%d")
        for path in LEAGUES[r["sport"]]:
            q = ("&" + SBQ[r["sport"]]) if r["sport"] in SBQ else ""
            j = get(f"{ESPN}{path}/scoreboard?dates={day}{q}") or {}
            for e in j.get("events") or []:
                comps = [c for gr in e.get("groupings") or [] for c in gr.get("competitions") or []] if r["sport"] == "tennis" else (e.get("competitions") or [])[:1]
                for c in comps:
                    if str(c.get("id") if r["sport"] == "tennis" else e.get("id")) != str(r["gid"]):
                        continue
                    t = ((c.get("status") or e.get("status") or {}).get("type") or {})
                    if t.get("state") != "post":
                        return None
                    h, a = sides(c)
                    if r["sport"] == "tennis":
                        if t.get("name") in ("STATUS_RETIRED", "STATUS_WALKOVER", "STATUS_ABANDONED"):
                            return "void"
                        gh = sum(int(x.get("value") or 0) for x in h.get("linescores") or [])
                        ga = sum(int(x.get("value") or 0) for x in a.get("linescores") or [])
                        return (gh, ga, bool(h.get("winner")))
                    return (int(float(h.get("score") or 0)), int(float(a.get("score") or 0)), None)
    return None


def prop_final(r, cache):
    """A logged prop's final from ESPN's box score: (result, actual) or None while not final.
    A player not in the box (did not play) is void, as the books grade it."""
    key = (r["sport"], str(r["gid"]))
    if key not in cache:
        cache[key] = get(f"{ESPN}{SUMPATH[r['sport']]}/summary?event={r['gid']}")
    j = cache[key]
    if not j:
        return None
    t = ((((j.get("header") or {}).get("competitions") or [{}])[0].get("status") or {}).get("type") or {})
    if t.get("state") != "post":
        return None
    me = LM.box_stats(r["sport"], j).get(LM.pn(r["player"]))
    if not me or (r["sport"] != "nba" and not any(k in me for k in ("pass_yds", "rush_yds", "rec", "rec_yds"))):
        return ("V", "did not play")
    if r["mkt"] == "anytime_td":
        td = me.get("td") or 0
        return ("W" if td >= 1 else "L"), f"{int(td)} TD"
    v = me.get(r["mkt"])
    if v is None:
        if r["sport"] == "nba":
            return ("V", "no stat in the box")
        v = 0
    if v == r["line"]:
        return ("P", str(v))
    return ("W" if (v > r["line"]) == (r["side"] == "over") else "L"), (str(int(v)) if float(v).is_integer() else str(v))


def grade(led):
    n = 0
    stale = datetime.now(timezone.utc) - timedelta(days=4)
    cache = {}
    for r in led:
        if r.get("result"):
            continue
        if r.get("kind") == "prop":
            fin = prop_final(r, cache) if r.get("sport") in SUMPATH else None
            if fin is None:
                if datetime.fromisoformat(r["logged_at"]) < stale:
                    r.update({"result": "V", "actual": "no final found", "profit": 0.0, "graded_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
                    n += 1
                continue
            res, act = fin
            pr = r["price"]
            r.update({"result": res, "actual": act, "graded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      "profit": round(pr / 100 if pr > 0 else 100 / -pr, 4) if res == "W" else -1.0 if res == "L" else 0.0})
            n += 1
            continue
        fin = final_of(r)
        if fin is None:
            if datetime.fromisoformat(r["logged_at"]) < stale:
                r.update({"result": "V", "actual": "no final found", "profit": 0.0, "graded_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
                n += 1
            continue
        if fin == "void":
            res, act = "V", "retired or walkover"
        else:
            hs, as_, hw = fin
            home = r["side"] == "home"
            if r["kind"] == "ml":
                won = (hw if hw is not None else hs > as_) if home else not (hw if hw is not None else hs > as_)
                res, act = ("W" if won else "L"), f"{hs}-{as_}"
            elif r["kind"] == "spread":
                m = (hs - as_ if home else as_ - hs) + r["line"]
                res, act = ("W" if m > 0 else "L" if m < 0 else "P"), f"{hs}-{as_}"
            else:
                t = hs + as_
                over = t > r["line"]
                res = "P" if t == r["line"] else ("W" if over == (r["side"] == "over") else "L")
                act = str(t)
        pr = r["price"]
        r.update({"result": res, "actual": act, "graded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "profit": round(pr / 100 if pr > 0 else 100 / -pr, 4) if res == "W" else -1.0 if res == "L" else 0.0})
        n += 1
    return n


def save(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def merge_now(led, now):
    """Copy the watcher's tennis picks into the ledger as they were logged; a match already in the
    ledger keeps its row (one pick per match). -> rows copied."""
    gids = {str(r["gid"]) for r in led if r.get("sport") == "tennis"}
    n = 0
    for r in sorted(now, key=lambda r: str(r.get("logged_at"))):
        if r.get("sport") != "tennis" or str(r.get("gid")) in gids:
            continue
        led.append(dict(r))
        gids.add(str(r["gid"]))
        n += 1
    return n


def watch():
    """--tennis-now: one pass of the minute watcher. Writes only data/live/tennis_now.json."""
    led = load_json(LEDGER, [])
    now = load_json(NOW, None)
    if not isinstance(now, list) or not isinstance(led, list):
        print("::warning::tennis_now or the live ledger does not parse; not touching it")
        return
    before = len(now)
    added = log_live(now, relay_url(), sports=["tennis"], also=led)
    if added and len(now) > before:
        save(NOW, now)
        for r in now[before:]:
            print(f"  logged {r['matchup']}: {r['label']} {r['price']:+d} ({round(100 * r['chance'])}% to hit, edge {round(100 * r['edge'])} pts)")
    print(f"tennis now: {added} new pick(s), {len(now)} rows")


def main():
    if "--tennis-now" in sys.argv:
        return watch()
    led = load_json(LEDGER, None)
    if not isinstance(led, list):
        if LEDGER.exists():
            print("::warning::live ledger does not parse; not touching it")
            return
        led = []
    before = len(led)
    now = load_json(NOW, [])
    copied = merge_now(led, now if isinstance(now, list) else [])
    snaps, stats = (None, {}) if "--grade" in sys.argv else (load_snaps(), {})
    added = 0 if "--grade" in sys.argv else log_live(led, relay_url(), snaps=snaps, stats=stats)
    graded = grade(led)
    if len(led) < before:      # append-only, belt and braces (validate_build checks it too)
        print("::warning::live ledger would shrink; not writing")
        return
    msg = (f"live ledger: {copied} tennis pick(s) from the minute watcher, {added} new value play(s) logged "
           f"({stats.get('prop_values', 0)} player props, prop params {LM.PROP_VERSION}), {graded} graded, {len(led)} rows; "
           f"{stats.get('props', 0)} live props priced, {stats.get('snaps', 0)} snapshots")
    if DRY:
        for r in led[before:]:
            print(f"  would log {r['id']}: {r['label']} {r['price']:+d} (chance {r['chance']}, edge {r['edge']})")
        print("dry run, nothing written: " + msg)
        return
    save(LEDGER, led)
    if snaps is not None and stats.get("snaps"):
        try:
            save_snaps(snaps)
        except Exception as e:      # the snapshots never cost the ledger
            print(f"::warning::prop snapshots not written: {str(e)[:160]}")
    print(msg)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:      # fail-soft: never block a build
        print(f"::warning::live_log failed: {str(e)[:200]}")
