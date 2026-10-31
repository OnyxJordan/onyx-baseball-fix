#!/usr/bin/env python3
"""
sports_espn.py - ESPN slate (and, for the NFL, box scores) for one sport.

    python3 sports_espn.py nfl|cfb|nhl|tennis|golf

Writes under data/<sport>/:
  slate.json         the current slate in one shape for every sport:
                     {date, sport, label, games: [...], events: [...]}
                     team sports fill games, tennis fills events (each with
                     its matches), golf fills events (each with a leaderboard)
  results.json       final scores (tennis: recent matches, older ones folded
                     into elo.json): the model's history, sports_history.py
  player_games.json  NFL only: one row per player-game, box scores read
                     once and remembered in ["_games"]; the first run
                     backfills last season (the model's prior) and this one

The page polls ESPN live on its own; this file is the pre-game snapshot the
model and the Onyx prices attach to.
"""

import sys, time
from datetime import datetime, timedelta, timezone

from sports_common import Lane, SPORTS, espn_get, game_day, nk

BOX_VER = 1
LOOKBACK_WEEKS = 2


def _team(c):
    t = c.get("team") or {}
    rec = (c.get("records") or [{}])[0].get("summary") if c.get("records") else None
    return {"abbr": t.get("abbreviation"), "name": t.get("displayName"), "short": t.get("shortDisplayName"),
            "loc": t.get("location"),
            "logo": t.get("logo"), "color": t.get("color"), "rec": rec,
            "rank": (c.get("curatedRank") or {}).get("current"),
            "score": c.get("score")}


def team_games(sb):
    out = []
    for e in (sb or {}).get("events") or []:
        c = (e.get("competitions") or [{}])[0]
        teams = {x.get("homeAway"): _team(x) for x in c.get("competitors") or []}
        if "home" not in teams or "away" not in teams:
            continue
        st = (e.get("status") or {}).get("type") or {}
        a, h = teams["away"], teams["home"]
        out.append({
            "gid": e.get("id"), "start": e.get("date"), "state": st.get("state"), "status": st.get("name"),
            "detail": st.get("shortDetail") or st.get("detail"), "name": e.get("shortName"),
            "away": a["abbr"], "home": h["abbr"], "away_name": a["name"], "home_name": h["name"],
            "away_short": a["short"], "home_short": h["short"], "away_loc": a["loc"], "home_loc": h["loc"],
            "away_logo": a["logo"], "home_logo": h["logo"],
            "away_color": a["color"], "home_color": h["color"], "away_rec": a["rec"], "home_rec": h["rec"],
            "away_rank": a["rank"] if a["rank"] and a["rank"] < 99 else None,
            "home_rank": h["rank"] if h["rank"] and h["rank"] < 99 else None,
            "away_score": a["score"], "home_score": h["score"],
            "venue": (c.get("venue") or {}).get("fullName"), "neutral": c.get("neutralSite"),
            "tv": ", ".join(n for b in c.get("broadcasts") or [] for n in b.get("names") or [])[:40] or None,
            "week": ((sb or {}).get("week") or {}).get("number"),
        })
    out.sort(key=lambda g: (g["start"] or "", g["gid"]))
    return out


def tennis_events(paths):
    events = []
    for path in paths:
        sb = espn_get(path + "/scoreboard") or {}
        tour = path.split("/")[-1].upper()
        for e in sb.get("events") or []:
            matches = []
            for gr in e.get("groupings") or []:
                draw = (gr.get("grouping") or {}).get("displayName") or ""
                if "Singles" not in draw:
                    continue
                for c in gr.get("competitions") or []:
                    st = (c.get("status") or {}).get("type") or {}
                    ps = []
                    for p in c.get("competitors") or []:
                        a = p.get("athlete") or {}
                        ps.append({"name": a.get("displayName"), "short": a.get("shortName"),
                                   "flag": ((a.get("flag") or {}).get("href")), "seed": p.get("seed"),
                                   "win": bool(p.get("winner")), "sets": [int(l.get("value") or 0) for l in p.get("linescores") or []],
                                   "serve": bool(p.get("possession"))})
                    if len(ps) != 2:
                        continue
                    matches.append({"id": c.get("id"), "start": c.get("date") or c.get("startDate"), "state": st.get("state"),
                                    "detail": st.get("shortDetail") or st.get("detail"), "round": (c.get("round") or {}).get("displayName"),
                                    "draw": draw, "court": (c.get("venue") or {}).get("court"), "p": ps})
            if matches:
                events.append({"id": e.get("id"), "tour": tour, "name": e.get("name"), "start": e.get("date"),
                               "end": e.get("endDate"), "major": bool(e.get("major")),
                               "venue": ((e.get("venue") or {}).get("fullName")), "matches": matches})
    return events


def golf_round(l):
    """One round: strokes and to-par, every hole played as [hole, strokes, to-par],
    and ESPN's birdie / bogey / eagle counts (the page's live tracker reads the
    same shape off the scoreboard)."""
    holes = sorted((h for h in l.get("linescores") or [] if h.get("value") is not None), key=lambda h: h.get("period") or 0)
    st = ((((l.get("statistics") or {}).get("categories") or [{}])[0]).get("stats") or [])
    val = lambda i: (st[i].get("value") if i < len(st) else None)
    return {"s": l.get("value"), "d": l.get("displayValue"),
            "h": [[h.get("period"), int(h["value"]), (h.get("scoreType") or {}).get("displayValue") or "E"] for h in holes],
            "b": val(0), "bo": val(1), "e": val(4)}


def golf_events(paths):
    events = []
    for path in paths:
        sb = espn_get(path + "/scoreboard") or {}
        for e in sb.get("events") or []:
            c = (e.get("competitions") or [{}])[0]
            st = (e.get("status") or {}).get("type") or {}
            board = []
            for p in c.get("competitors") or []:
                a = p.get("athlete") or {}
                rounds = [golf_round(l) for l in p.get("linescores") or [] if l.get("value") is not None or l.get("linescores")]
                board.append({"pos": p.get("order"), "name": a.get("displayName"), "flag": (a.get("flag") or {}).get("href"),
                              "to_par": p.get("score"), "rounds": rounds,
                              "id": a.get("id") or p.get("id")})
            board.sort(key=lambda r: r["pos"] or 999)
            events.append({"id": e.get("id"), "tour": path.split("/")[-1].upper(), "name": e.get("name"),
                           "start": e.get("date"), "end": e.get("endDate"), "state": st.get("state"),
                           "detail": st.get("shortDetail") or st.get("detail"), "round": (c.get("status") or {}).get("period"),
                           "venue": ((c.get("venue") or e.get("venue") or {}).get("fullName")), "board": board[:150]})
    return events


def golf_meta(lane, events):
    """The golf model's inputs for this week's PGA TOUR event: its course and cut rule
    (ESPN's core API), and any newly finished events appended to data/golf/history.json."""
    import golf_model
    for e in events:
        if e.get("tour") != "PGA" or not e.get("id"):
            continue
        try:
            meta = golf_model._get(golf_model.CORE.format(e["id"])) or {}
            c = (meta.get("courses") or [None])[0] if len(meta.get("courses") or []) == 1 else None
            t = golf_model._get(str(((meta.get("tournament") or {}).get("$ref") or "")).replace("http://", "https://")
                                .replace(".pvt/", ".com/")) if meta.get("tournament") else None
            e["course"] = {"id": str(c["id"]), "name": c.get("name"), "par": c.get("shotsToPar"), "yards": c.get("totalYards"),
                           "where": ", ".join(x for x in ((c.get("address") or {}).get("city"), (c.get("address") or {}).get("state")
                                                          or (c.get("address") or {}).get("country")) if x)} if c else None
            e["signature"] = bool(meta.get("isSignature"))
            e["cut_n"] = golf_model.cut_rule(e.get("name"), e["signature"], (t or {}).get("cutRound", 2))
        except Exception as x:   # the leaderboard above is already saved
            print(f"  golf meta: {str(x)[:160]}")
        break
    try:
        _, n = golf_model.update(str(lane.data / "history.json"))
        if n:
            print(f"  golf history: +{n} events")
    except Exception as x:
        print(f"  golf history: {str(x)[:160]}")


# ── NFL box scores (the model's input) ─────────────────────────────────────
CATS = {
    "passing": {"completions/passingAttempts": ("cmp", "att"), "passingYards": "pass_yds", "passingTouchdowns": "pass_td",
                "interceptions": "int"},
    "rushing": {"rushingAttempts": "rush_att", "rushingYards": "rush_yds", "rushingTouchdowns": "rush_td"},
    "receiving": {"receptions": "rec", "receivingYards": "rec_yds", "receivingTouchdowns": "rec_td", "receivingTargets": "tgt"},
}


def _num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def box_rows(summary, gid, season, week, date):
    rows = {}
    teams = {}
    for comp in ((summary.get("header") or {}).get("competitions") or [{}])[:1]:
        for c in comp.get("competitors") or []:
            teams[c.get("homeAway")] = (c.get("team") or {}).get("abbreviation")
    for side in (summary.get("boxscore") or {}).get("players") or []:
        team = (side.get("team") or {}).get("abbreviation")
        opp = teams.get("home") if teams.get("away") == team else teams.get("away")
        home = teams.get("home") == team
        for cat in side.get("statistics") or []:
            spec = CATS.get(cat.get("name"))
            if not spec:
                continue
            keys = cat.get("keys") or []
            for ath in cat.get("athletes") or []:
                a = ath.get("athlete") or {}
                pid = a.get("id")
                if not pid:
                    continue
                r = rows.setdefault(pid, {"gid": gid, "season": season, "week": week, "date": date, "team": team, "opp": opp,
                                          "home": home, "pid": pid, "name": a.get("displayName"),
                                          "hs": (a.get("headshot") or {}).get("href"),
                                          "cats": []})
                r["cats"].append(cat["name"])
                for k, v in zip(keys, ath.get("stats") or []):
                    tgt = spec.get(k)
                    if isinstance(tgt, tuple):
                        a1, a2 = (str(v).split("/") + ["0"])[:2]
                        r[tgt[0]], r[tgt[1]] = _num(a1), _num(a2)
                    elif tgt:
                        r[tgt] = _num(v)
    return list(rows.values())


def ingest_nfl(lane, cur_week, year):
    """The NFL: last season once (the prior), then this season's weeks."""
    return ingest_box(lane, "football/nfl", "", cur_week, year, prior_weeks=range(1, 19))


def ingest_box(lane, path, q, cur_week, year, prior_weeks=()):
    """Box scores into data/<sport>/player_games.json: last season's prior_weeks once,
    then this season's weeks up to now (the last LOOKBACK_WEEKS re-checked). College
    football (11/1) reads this season only: ~65 FBS games a week is enough history by
    midseason, and a full prior season would double the file."""
    pg = lane.load("player_games.json", {}) or {}
    if pg.get("_ver") != BOX_VER:
        pg = {"_ver": BOX_VER, "_games": [], "rows": []}
    seen = set(pg["_games"])
    todo = []
    # last season once (the prior), then this season's weeks up to now
    for season, weeks in ((year - 1, prior_weeks), (year, range(1, (cur_week or 1) + 1))):
        recent = season == year
        for wk in weeks:
            if not recent and any(g.startswith(f"{season}:{wk}:") for g in seen):
                continue
            if recent and cur_week and wk < cur_week - LOOKBACK_WEEKS and any(g.startswith(f"{season}:{wk}:") for g in seen):
                continue
            sb = espn_get(path + "/scoreboard", f"seasontype=2&week={wk}&dates={season}" + (("&" + q) if q else "")) or {}
            for e in sb.get("events") or []:
                st = ((e.get("status") or {}).get("type") or {})
                key = f"{season}:{wk}:{e.get('id')}"
                if st.get("completed") and key not in seen:
                    todo.append((key, e.get("id"), season, wk, (e.get("date") or "")[:10]))
            time.sleep(0.15)
    added = 0
    for key, gid, season, wk, d in todo:
        s = espn_get(path + "/summary", f"event={gid}")
        if not s:
            continue
        pg["rows"].extend(box_rows(s, gid, season, wk, d))
        pg["_games"].append(key)
        seen.add(key)
        added += 1
        time.sleep(0.15)
    if added or not lane.load("player_games.json"):
        lane.save("player_games.json", pg)
    print(f"  box scores: +{added} games, {len(pg['_games'])} total, {len(pg['rows'])} player rows")


def main():
    key = (sys.argv[1:] or ["nfl"])[0]
    lane = Lane(key)
    cfg = lane.cfg
    today = str(game_day())
    slate = {"date": today, "sport": key, "name": cfg["name"], "label": None, "games": [], "events": [],
             "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if cfg["kind"] in ("football", "hockey"):
        path = cfg["espn"][0] + "/scoreboard"
        q = cfg.get("espn_q", "")
        if cfg["slate"] == "day":
            q = (q + "&" if q else "") + "dates=" + today.replace("-", "")
        sb = espn_get(path, q) or {}
        slate["games"] = team_games(sb)
        wk = (sb.get("week") or {}).get("number")
        slate["label"] = f"Week {wk}" if wk else datetime.strptime(today, "%Y-%m-%d").strftime("%a %b %-d")
        slate["season"] = (sb.get("season") or {}).get("year")
        slate["season_type"] = (sb.get("season") or {}).get("type")
        slate["bye"] = [t.get("abbreviation") for t in (sb.get("week") or {}).get("teamsOnBye") or []]
        if cfg.get("box") and slate["season"]:
            if key == "nfl":
                ingest_nfl(lane, wk, slate["season"])
            else:
                ingest_box(lane, cfg["espn"][0], cfg.get("espn_q", ""), wk, slate["season"])
        if key == "nfl" and slate["season"]:
            try:   # nflverse targets, dropbacks and snap shares for the v5 receptions model (once a day)
                import nfl_verse
                nfl_verse.update(int(slate["season"]), str(lane.data / "nflverse.json"))
            except Exception as x:
                print(f"  nflverse: {str(x)[:160]}")
    elif cfg["kind"] == "tennis":
        slate["events"] = tennis_events(cfg["espn"])
        slate["label"] = " · ".join(e["name"] for e in slate["events"][:3])
    elif cfg["kind"] == "golf":
        slate["events"] = golf_events(cfg["espn"])
        slate["label"] = " · ".join(e["name"] for e in slate["events"][:2])
        golf_meta(lane, slate["events"])
    lane.save("slate.json", slate, indent=1)
    try:
        import sports_history
        sports_history.ingest(lane, slate)
    except Exception as e:   # history feeds the model; the slate above already saved
        print(f"  results: {str(e)[:160]}")
    n = len(slate["games"]) or sum(len(e.get("matches") or e.get("board") or []) for e in slate["events"])
    print(f"=== {cfg['full']} slate {today}: {slate['label']} · {len(slate['games'])} games, "
          f"{len(slate['events'])} events, {n} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# ── injury report ───────────────────────────────────────────────────────
# ESPN's league-wide report. NOT_PLAYING never gets a projection, a lean, a
# Top 10 spot or a trial play; QUESTIONABLE stays on the board, tagged "Q".
NOT_PLAYING = {"OUT", "IR", "IR-R", "PUP-R", "PUP-P", "NFI-R", "NFI-A", "INACTIVE", "RESERVE-SUS", "SUSPENSION",
               "INJURED RESERVE", "DOUBTFUL", "D"}


def fetch_injuries(path="football/nfl"):
    """{"id": {espn athlete id: tag}, "name": {name key: tag}}, tag = {"s": "OUT" | "Q",
    "d": "Ankle", "c": short comment}. Players listed Active are left out. Fail-soft:
    an empty report when ESPN does not answer, so the build runs exactly as before."""
    import re
    d = espn_get(path + "/injuries") or {}
    out = {"id": {}, "name": {}}
    for t in d.get("injuries") or []:
        for i in t.get("injuries") or []:
            ath = i.get("athlete") or {}
            det = i.get("details") or {}
            st = ((det.get("fantasyStatus") or {}).get("abbreviation") or i.get("status") or "").upper()
            tag = "OUT" if st in NOT_PLAYING else "Q" if st.startswith("Q") else None
            if not tag:
                continue
            v = {"s": tag, "d": det.get("type") or "", "c": (i.get("shortComment") or "")[:160]}
            for l in ath.get("links") or []:
                m = re.search(r"/id/(\d+)", l.get("href") or "")
                if m:
                    out["id"][m.group(1)] = v
                    break
            if ath.get("displayName"):
                out["name"][nk(ath["displayName"])] = v
    return out


def injury_of(inj, pid, name):
    if not inj:
        return None
    return (inj.get("id") or {}).get(str(pid)) or (inj.get("name") or {}).get(nk(name or ""))
