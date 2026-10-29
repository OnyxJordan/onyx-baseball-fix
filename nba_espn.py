#!/usr/bin/env python3
"""
nba_espn.py - ESPN backup for the NBA fetcher. nba_fetch.py (OpticOdds)
runs this only when the OpticOdds key is missing or its fixtures call fails.

Writes, under data/nba/espn/ (ESPN ids, kept apart from the OpticOdds files):
  prior.json         last regular season per-player averages (refreshed weekly)
  player_games.json  this season's box-score lines, one row per player-game
  team_games.json    this season's team box totals (pace / defense inputs)
  slate.json         today's games (lines, status) + every rostered player
                     with injury status

Box scores are ingested incrementally: every final regular-season game is
read once and remembered in player_games.json["_games"]. The first run
backfills from BACKFILL_FROM; later runs look back LOOKBACK_DAYS so a late
final or a missed run still lands.

    python3 nba_espn.py
"""

import sys, time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import nba_common
from nba_common import (ESPN, ESPN_WEB, ET, espn_get, game_day, load, save,
                        team_abbr, nk)

nba_common.DATA = Path("data/nba/espn")
nba_common.DATA.mkdir(parents=True, exist_ok=True)

BOX_VER = 2     # 2: rows carry fga/fta/tov/plus-minus (usage rate); a bump re-ingests the season
BACKFILL_FROM = date(2026, 10, 15)   # before the 2026-27 opener; preseason is filtered out
LOOKBACK_DAYS = 4
PRIOR_MAX_AGE_DAYS = 7


# ── PRIOR SEASON ────────────────────────────────────────────────────────────
def fetch_prior(season_year):
    """Last regular season per-game averages for every player ESPN lists.
    season_year is ESPN's label for the CURRENT season (2027 = 2026-27), so
    the prior is season_year - 1."""
    cur = load("prior.json", {})
    built = cur.get("_built")
    if built and cur.get("_season") == season_year - 1 and cur.get("_ver") == BOX_VER:
        try:
            age = (date.today() - date.fromisoformat(built)).days
            if age < PRIOR_MAX_AGE_DAYS and len(cur) > 300:
                print(f"  prior: cached ({len(cur) - 3} players, {age}d old)")
                return cur
        except ValueError:
            pass
    print(f"  prior: fetching {season_year - 1} regular-season averages...")
    out = {"_built": date.today().isoformat(), "_season": season_year - 1, "_ver": BOX_VER}
    page, pages = 1, 1
    while page <= pages and page <= 30:
        d = espn_get(f"{ESPN_WEB}/statistics/byathlete",
                     {"season": season_year - 1, "seasontype": 2,
                      "limit": 100, "page": page})
        if not d:
            break
        pages = (d.get("pagination") or {}).get("pages", 1)
        cats = {c["name"]: c.get("names", []) for c in d.get("categories", [])}
        for row in d.get("athletes", []):
            a = row.get("athlete", {})
            vals = {}
            for c in row.get("categories", []):
                names = cats.get(c.get("name"), [])
                for n, v in zip(names, c.get("totals") or c.get("values") or []):
                    vals.setdefault(n, v)
            try:
                gp = int(float(vals.get("gamesPlayed", 0)))
                mins = float(vals.get("minutes", 0))
            except (TypeError, ValueError):
                continue
            if gp < 1 or mins <= 0:
                continue
            def tot(k):
                try:
                    return float(vals.get(k, 0))
                except (TypeError, ValueError):
                    return 0.0
            out[str(a.get("id"))] = {
                "n": a.get("displayName", ""),
                "t": a.get("teamShortName", ""),
                "pos": (a.get("position") or {}).get("abbreviation", ""),
                "gp": gp, "min": round(mins, 1),
                "pts": tot("points"), "reb": tot("rebounds"), "ast": tot("assists"),
                "fg3": tot("threePointFieldGoalsMade"),
                # usage inputs; None (not 0) when ESPN omits them, so the model
                # falls back to this season's box scores instead of a zero usage
                "fga": tot("fieldGoalsAttempted") if "fieldGoalsAttempted" in vals else None,
                "fta": tot("freeThrowsAttempted") if "freeThrowsAttempted" in vals else None,
                "tov": tot("turnovers") if "turnovers" in vals else None,
            }
        page += 1
        time.sleep(0.3)
    if len(out) > 300:
        save("prior.json", out)
        print(f"  prior: {len(out) - 3} players")
        return out
    print(f"  prior: fetch came back thin ({len(out) - 3}); keeping cached copy")
    return cur


# ── BOX SCORES ──────────────────────────────────────────────────────────────
def _num(s):
    try:
        return float(str(s).split("-")[0])
    except (TypeError, ValueError):
        return 0.0


def _pm(s):
    try:
        return float(str(s).replace("+", ""))
    except (TypeError, ValueError):
        return None


def _made_att(s):
    try:
        m, a = str(s).split("-")
        return float(m), float(a)
    except (TypeError, ValueError):
        return 0.0, 0.0


def ingest_game(gid, pg, tg):
    """Read one final game's box score into the player and team stores."""
    d = espn_get(f"{ESPN}/summary", {"event": gid})
    hdr = ((d.get("header") or {}).get("competitions") or [{}])[0]
    if (hdr.get("status") or {}).get("type", {}).get("name") != "STATUS_FINAL":
        return False
    gdate = str(game_day(datetime.fromisoformat(
        hdr["date"].replace("Z", "+00:00")).astimezone(ET)))
    comps = {c["homeAway"]: c for c in hdr.get("competitors", [])}
    if set(comps) != {"home", "away"}:
        return False
    abbr = {ha: team_abbr(c["team"]["abbreviation"]) or c["team"]["abbreviation"]
            for ha, c in comps.items()}
    score = {ha: _num(c.get("score")) for ha, c in comps.items()}

    team_box = {}
    for t in (d.get("boxscore") or {}).get("teams", []):
        ab = team_abbr(t["team"]["abbreviation"]) or t["team"]["abbreviation"]
        st = {s.get("name"): s.get("displayValue") for s in t.get("statistics", [])}
        fgm, fga = _made_att(st.get("fieldGoalsMade-fieldGoalsAttempted"))
        ftm, fta = _made_att(st.get("freeThrowsMade-freeThrowsAttempted"))
        team_box[ab] = {
            "reb": _num(st.get("totalRebounds")), "ast": _num(st.get("assists")),
            "oreb": _num(st.get("offensiveRebounds")),
            "tov": _num(st.get("totalTurnovers") or st.get("turnovers")),
            "fga": fga, "fta": fta,
        }

    for ha, opp_ha in (("home", "away"), ("away", "home")):
        me, op = abbr[ha], abbr[opp_ha]
        b, ob = team_box.get(me, {}), team_box.get(op, {})
        poss = b.get("fga", 0) - b.get("oreb", 0) + b.get("tov", 0) + 0.44 * b.get("fta", 0)
        rows = tg.setdefault(me, [])
        if any(r["gid"] == gid for r in rows):
            continue
        rows.append({
            "d": gdate, "gid": gid, "opp": op, "home": ha == "home",
            "pts": score[ha], "opp_pts": score[opp_ha],
            "reb": b.get("reb", 0), "opp_reb": ob.get("reb", 0),
            "ast": b.get("ast", 0), "opp_ast": ob.get("ast", 0),
            "poss": round(poss, 1),
        })

    n = 0
    for team in (d.get("boxscore") or {}).get("players", []):
        ab = team_abbr(team["team"]["abbreviation"]) or team["team"]["abbreviation"]
        ha = "home" if ab == abbr["home"] else "away"
        opp = abbr["away" if ha == "home" else "home"]
        for blk in team.get("statistics", []):
            labels = blk.get("labels") or []
            idx = {l: i for i, l in enumerate(labels)}
            for a in blk.get("athletes", []):
                ath = a.get("athlete") or {}
                pid = str(ath.get("id") or "")
                if not pid:
                    continue
                rec = pg.setdefault(pid, {"n": ath.get("displayName", ""), "t": ab, "g": []})
                rec["n"], rec["t"] = ath.get("displayName", rec["n"]), ab
                if any(g[1] == gid for g in rec["g"]):
                    continue
                stats = a.get("stats") or []
                if a.get("didNotPlay") or not stats:
                    # a DNP is a real data point for the minutes model
                    rec["g"].append([gdate, gid, opp, int(ha == "home"), 0, 0, 0, 0, 0, 0])
                    continue
                def v(lbl):
                    i = idx.get(lbl)
                    return _num(stats[i]) if i is not None and i < len(stats) else 0.0
                def att(lbl):
                    i = idx.get(lbl)
                    return _made_att(stats[i])[1] if i is not None and i < len(stats) else 0.0
                pm_i = idx.get("+/-")
                rec["g"].append([gdate, gid, opp, int(ha == "home"), v("MIN"), v("PTS"),
                                 v("REB"), v("AST"), v("3PT"), int(bool(a.get("starter"))),
                                 att("FG"), att("FT"), v("TO"),
                                 _pm(stats[pm_i]) if pm_i is not None and pm_i < len(stats) else None])
                n += 1
    return n > 0


def ingest_box_scores(today):
    pg = load("player_games.json", {})
    tg = load("team_games.json", {})
    if pg.get("_ver") != BOX_VER:
        print(f"  box scores: format v{pg.get('_ver', 1)} -> v{BOX_VER}, re-ingesting the season")
        pg, tg = {}, {}
    done = set(pg.get("_games", []))
    start = BACKFILL_FROM if not done else max(BACKFILL_FROM, today - timedelta(days=LOOKBACK_DAYS))
    added, day = 0, start
    while day < today + timedelta(days=1):
        sb = espn_get(f"{ESPN}/scoreboard", {"dates": day.strftime("%Y%m%d")})
        for e in sb.get("events", []):
            if (e.get("season") or {}).get("type") != 2:
                continue   # preseason / play-in / playoffs stay out of the regular-season rates
            if e["status"]["type"]["name"] != "STATUS_FINAL" or e["id"] in done:
                continue
            if ingest_game(e["id"], pg, tg):
                done.add(e["id"])
                added += 1
            time.sleep(0.25)
        day += timedelta(days=1)
    pg["_games"] = sorted(done)
    pg["_ver"] = BOX_VER
    save("player_games.json", pg)
    save("team_games.json", tg)
    print(f"  box scores: +{added} games this run, {len(done)} season games, "
          f"{sum(1 for k in pg if not k.startswith('_'))} players")
    return pg, tg


# ── TODAY'S SLATE ───────────────────────────────────────────────────────────
INJ_RANK = {"OUT": 4, "DOUBTFUL": 3, "QUESTIONABLE": 2, "GTD": 2, "DAY-TO-DAY": 1, "PROBABLE": 0}


def fetch_injuries():
    """{name_key: {status, detail}} from the league-wide injury report."""
    d = espn_get(f"{ESPN}/injuries")
    out = {}
    for t in d.get("injuries", []):
        for i in t.get("injuries", []):
            ath = i.get("athlete") or {}
            fs = ((i.get("details") or {}).get("fantasyStatus") or {}).get("abbreviation")
            status = (fs or i.get("status") or "").upper()
            det = i.get("details") or {}
            out[nk(ath.get("displayName", ""))] = {
                "status": status,
                "detail": " ".join(x for x in (det.get("type"), det.get("detail")) if x),
            }
    return out


def fetch_slate(today):
    sb = espn_get(f"{ESPN}/scoreboard", {"dates": today.strftime("%Y%m%d")})
    season_year = ((sb.get("leagues") or [{}])[0].get("season") or {}).get("year")
    games = []
    for e in sb.get("events", []):
        c = e["competitions"][0]
        side = {t["homeAway"]: t for t in c["competitors"]}
        if set(side) != {"home", "away"}:
            continue
        o = (c.get("odds") or [{}])[0]
        st = e["status"]["type"]
        games.append({
            "gid": e["id"], "start": e["date"],
            "season_type": (e.get("season") or {}).get("type"),
            "slug": None,
            "state": {"in": "live", "post": "post"}.get(st.get("state"), "pre"), "status": st.get("name"),
            "detail": st.get("shortDetail", ""),
            "away": team_abbr(side["away"]["team"]["abbreviation"]) or side["away"]["team"]["abbreviation"],
            "home": team_abbr(side["home"]["team"]["abbreviation"]) or side["home"]["team"]["abbreviation"],
            "away_id": side["away"]["team"]["id"], "home_id": side["home"]["team"]["id"],
            "away_score": side["away"].get("score"), "home_score": side["home"].get("score"),
            "away_rec": ((side["away"].get("records") or [{}])[0]).get("summary", ""),
            "home_rec": ((side["home"].get("records") or [{}])[0]).get("summary", ""),
            # ESPN's spread is the HOME spread ("SA -14.5" at DAL = +14.5)
            "spread": o.get("spread"), "total": o.get("overUnder"),
            "away_ml": (o.get("awayTeamOdds") or {}).get("moneyLine"),
            "home_ml": (o.get("homeTeamOdds") or {}).get("moneyLine"),
        })

    inj = fetch_injuries()
    players = []
    for g in games:
        for ha in ("away", "home"):
            ab, tid = g[ha], g[f"{ha}_id"]
            opp = g["home" if ha == "away" else "away"]
            ro = espn_get(f"{ESPN}/teams/{tid}/roster")
            for a in ro.get("athletes", []):
                key = nk(a.get("displayName", ""))
                i = inj.get(key)
                if not i and a.get("injuries"):
                    i = {"status": str(a["injuries"][0].get("status", "")).upper(), "detail": ""}
                players.append({
                    "pid": str(a.get("id")), "name": a.get("displayName", ""),
                    "team": ab, "opp": opp, "home": ha == "home", "gid": g["gid"],
                    "pos": (a.get("position") or {}).get("abbreviation", ""),
                    "inj": (i or {}).get("status", ""), "inj_detail": (i or {}).get("detail", ""),
                    "hs": str(a.get("id") or "") or None, "logo": "",
                })
            time.sleep(0.2)
    slate = {"date": today.isoformat(), "season_year": season_year, "source": "espn",
             "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "games": games, "players": players}
    save("slate.json", slate, indent=1)
    print(f"  slate {today}: {len(games)} games, {len(players)} rostered players, "
          f"{sum(1 for p in players if p['inj'])} on the injury report")
    return slate


def main():
    print("=== Onyx NBA: ESPN backup fetch ===")
    today = game_day()
    slate = fetch_slate(today)
    year = slate.get("season_year") or (today.year + (1 if today.month >= 8 else 0))
    fetch_prior(year)
    ingest_box_scores(today)
    if not Path("data/nba/history.json").exists():   # the OpticOdds path keeps the shared copy
        nba_common.refresh_history(today)
    nba_common.refresh_onoff(today)
    try:
        import nba_jumps   # opening tips for the first-basket lean (data/nba/jumps.json)
        nba_jumps.update(today)
    except Exception as e:
        print(f"  opening tips: {str(e)[:160]}")
    print("=== NBA ESPN backup done ===")


if __name__ == "__main__":
    sys.exit(main())
