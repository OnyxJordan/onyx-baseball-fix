"""
sports_history.py - final results per sport, the input every team and match
model fits from. Called by sports_espn.py after the slate is saved; the first
run backfills last season and this one, later runs only read what is new.

data/<sport>/results.json
  {"_ver": n, "_seen": [day or week keys already read],
   "games": [{id, date, season, st, home, away, hs, as, neutral}]}      team sports
   "matches": [{id, date, tour, event, round, w, l, sets_w, sets_l,
                games_w, games_l, sets}]}                               tennis

Only completed games land here. Team sports use ESPN abbreviations, the same
keys as the slate. Golf keeps no results: Onyx prices no golf market, so
there is nothing to test a golf model against yet.
"""

import time
from datetime import date, timedelta

from sports_common import espn_get, game_day

RES_VER = 1
RECENT_DAYS = 4        # always re-read the last few days (late finals, postponements)
RECENT_WEEKS = 1


def _load(lane):
    r = lane.load("results.json", {}) or {}
    if r.get("_ver") != RES_VER:
        r = {"_ver": RES_VER, "_seen": [], "games": [], "matches": []}
    return r


def _team_game(e, season, st):
    c = (e.get("competitions") or [{}])[0]
    s = (e.get("status") or {}).get("type") or {}
    if not s.get("completed"):
        return None
    t = {x.get("homeAway"): x for x in c.get("competitors") or []}
    if "home" not in t or "away" not in t:
        return None
    try:
        hs, as_ = float(t["home"].get("score")), float(t["away"].get("score"))
    except (TypeError, ValueError):
        return None
    return {"id": e.get("id"), "date": (e.get("date") or "")[:10], "season": season, "st": st,
            "home": (t["home"].get("team") or {}).get("abbreviation"), "away": (t["away"].get("team") or {}).get("abbreviation"),
            "hs": hs, "as": as_, "neutral": bool(c.get("neutralSite")),
            "ot": (s.get("name") or "").endswith("OT") or "OT" in (s.get("shortDetail") or "") or "SO" in (s.get("shortDetail") or "")}


def _merge(res, games):
    have = {g["id"]: i for i, g in enumerate(res["games"])}
    n = 0
    for g in games:
        if not g or not g.get("home") or not g.get("away"):
            continue
        if g["id"] in have:
            res["games"][have[g["id"]]] = g
        else:
            res["games"].append(g)
            have[g["id"]] = len(res["games"]) - 1
            n += 1
    return n


def ingest_daily(lane, path, start, q=""):
    """Team sports keyed by day (NHL): every day from start to today."""
    res = _load(lane)
    seen = set(res["_seen"])
    today = game_day()
    d, added, calls = start, 0, 0
    while d <= today:
        key = d.isoformat()
        if key not in seen or (today - d).days <= RECENT_DAYS:
            sb = espn_get(path + "/scoreboard", (q + "&" if q else "") + "dates=" + d.strftime("%Y%m%d")) or {}
            calls += 1
            season = d.year + 1 if d.month >= 9 else d.year     # ESPN names a hockey season by the year it ends
            added += _merge(res, [_team_game(e, season, (e.get("season") or {}).get("type")) for e in sb.get("events") or []])
            if (today - d).days > RECENT_DAYS and sb:
                seen.add(key)
            time.sleep(0.12)
        d += timedelta(days=1)
    res["_seen"] = sorted(seen)
    res["games"].sort(key=lambda g: (g["date"], g["id"]))
    lane.save("results.json", res)
    print(f"  results: +{added} games ({calls} days read), {len(res['games'])} total")
    return res


def ingest_weekly(lane, path, seasons, cur_season, cur_week, q="", reg=16, post=1):
    """Team sports keyed by week (college football; the NFL also has box
    scores). Regular season weeks 1-16 plus the postseason."""
    res = _load(lane)
    seen = set(res["_seen"])
    added, calls = 0, 0
    for season in seasons:
        for st, weeks in ((2, range(1, reg + 1)), (3, range(1, post + 1))):
            for wk in weeks:
                key = f"{season}:{st}:{wk}"
                current = season == cur_season and st == 2 and cur_week and wk >= (cur_week or 0) - RECENT_WEEKS
                if season == cur_season and st == 2 and cur_week and wk > cur_week:
                    continue
                if season == cur_season and st == 3:
                    continue
                if key in seen and not current:
                    continue
                sb = espn_get(path + "/scoreboard", (q + "&" if q else "") + f"seasontype={st}&week={wk}&dates={season}") or {}
                calls += 1
                added += _merge(res, [_team_game(e, season, st) for e in sb.get("events") or []])
                if sb and not current:
                    seen.add(key)
                time.sleep(0.12)
    res["_seen"] = sorted(seen)
    res["games"].sort(key=lambda g: (g["date"], g["id"]))
    lane.save("results.json", res)
    print(f"  results: +{added} games ({calls} weeks read), {len(res['games'])} total")
    return res


def _tennis_matches(sb, tour):
    out = []
    for e in sb.get("events") or []:
        for gr in e.get("groupings") or []:
            draw = (gr.get("grouping") or {}).get("displayName") or ""
            if "Singles" not in draw:
                continue
            for c in gr.get("competitions") or []:
                st = (c.get("status") or {}).get("type") or {}
                if not st.get("completed"):
                    continue
                ps = c.get("competitors") or []
                if len(ps) != 2:
                    continue
                w = next((p for p in ps if p.get("winner")), None)
                if not w:
                    continue
                l = ps[1] if ps[0] is w else ps[0]
                sw = [int(x.get("value") or 0) for x in w.get("linescores") or []]
                sl = [int(x.get("value") or 0) for x in l.get("linescores") or []]
                if not sw or "retired" in (st.get("detail") or "").lower() or "walkover" in (st.get("detail") or "").lower():
                    continue   # retirements and walkovers say nothing about strength
                out.append({"id": c.get("id"), "date": (c.get("date") or e.get("date") or "")[:10], "tour": tour,
                            "event": e.get("name"), "round": (c.get("round") or {}).get("displayName"),
                            "w": (w.get("athlete") or {}).get("displayName"), "l": (l.get("athlete") or {}).get("displayName"),
                            "sets_w": sum(1 for a, b in zip(sw, sl) if a > b), "sets_l": sum(1 for a, b in zip(sw, sl) if b > a),
                            "games_w": sum(sw), "games_l": sum(sl), "sets": len(sw)})
    return out


def ingest_tennis(lane, paths, start):
    """Tennis by week: ESPN returns every tournament overlapping a date range."""
    res = _load(lane)
    seen = set(res["_seen"])
    have = {m["id"] for m in res["matches"]}
    today = game_day()
    d, added, calls = start, 0, 0
    while d <= today:
        e = min(d + timedelta(days=6), today)
        key = d.isoformat()
        recent = (today - e).days <= RECENT_DAYS
        if key not in seen or recent:
            for path in paths:
                sb = espn_get(path + "/scoreboard", f"dates={d.strftime('%Y%m%d')}-{e.strftime('%Y%m%d')}") or {}
                calls += 1
                for m in _tennis_matches(sb, path.split("/")[-1].upper()):
                    if m["id"] not in have:
                        res["matches"].append(m)
                        have.add(m["id"])
                        added += 1
                time.sleep(0.15)
            if not recent:
                seen.add(key)
        d += timedelta(days=7)
    res["_seen"] = sorted(seen)[-12:]     # weeks older than the fold line are never re-read
    res["matches"].sort(key=lambda m: (m["date"], m["id"]))
    import tennis_model
    folded = tennis_model.fold(lane, res, today)
    lane.save("results.json", res)
    print(f"  results: +{added} matches ({calls} weeks read), {folded} folded into the Elo state, {len(res['matches'])} kept")
    return res


def ingest(lane, slate):
    key = lane.key
    today = game_day()
    if key == "nhl":
        # last season from its October start, then this one
        return ingest_daily(lane, "hockey/nhl", date(today.year - 1 if today.month >= 9 else today.year - 2, 10, 1))
    if key in ("cfb", "nfl"):
        season = slate.get("season") or today.year
        wk = None
        try:
            wk = int(str(slate.get("label") or "").split()[-1])
        except (ValueError, IndexError):
            pass
        q = lane.cfg.get("espn_q", "") if key == "cfb" else ""
        return ingest_weekly(lane, lane.cfg["espn"][0], (season - 1, season), season, wk, q,
                             *((18, 5) if key == "nfl" else (16, 1)))
    if key == "tennis":
        # with an Elo state, only the weeks since its fold line; a fresh lane backfills 18 months
        st = lane.load("elo.json", {}) or {}
        start = date.fromisoformat(st["through"]) - timedelta(days=7) if st.get("through") else today - timedelta(days=560)
        return ingest_tennis(lane, lane.cfg["espn"], start)
    return None
