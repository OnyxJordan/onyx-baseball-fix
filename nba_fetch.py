#!/usr/bin/env python3
"""
nba_fetch.py - Onyx NBA daily data fetcher. OpticOdds first, ESPN backup.

OpticOdds (OPTICODDS_API_KEY, the same key fetch_onyx.py uses) supplies,
verified against live payloads on 10/24:
  /fixtures                     today's games: fixture id, Onyx slug
                                (game_id), teams, status, records, scores
  /fixtures/player-results      box scores (several fixture_id per call);
                                players who did not play are absent
  /fixtures/player-results/last-x
                                a player's last 47 games across seasons,
                                used once per player for last season's prior
  /injuries                     statuses 'out' / 'gtd'
  /players                      rosters (7 pages of 100)

Writes under data/nba/ (keyed by OpticOdds ids):
  slate.json, player_games.json, team_games.json, prior.json

If the key is missing or the fixtures call fails, nba_espn.py runs instead
and writes the same files under data/nba/espn/ (ESPN ids; kept apart so the
two id spaces never mix). nba_build.py uses whichever slate is today's,
preferring OpticOdds.
"""

import json, os, subprocess, sys, time, urllib.parse
from datetime import date, datetime, timedelta, timezone

from nba_common import ET, game_day, load, save, team_abbr, nk
from fetch_onyx import http_json, OPTIC

Q = "sport=basketball&league=nba"
SEASON_START = date(2026, 10, 20)        # 2026-27 opener; earlier games are preseason
PRIOR_START = date(2025, 10, 21)         # 2025-26 opener (playoffs included in the prior)
LOOKBACK_DAYS = 4
PRIOR_REFETCH_PER_RUN = 160              # first run seeds ~450 players over three runs

_KEY = ""


def get(path, params=""):
    url = f"{OPTIC}{path}?{Q}{params}"
    for attempt in range(5):
        try:
            return http_json(url, headers={"X-Api-Key": _KEY})
        except Exception as e:
            msg = str(e)
            if "HTTP 429" in msg and attempt < 4:
                time.sleep(min(30, 5 * (attempt + 1)))
                continue
            print(f"  optic {path}: {msg[:200]}")
            return None
        finally:
            time.sleep(0.35)


def paged(path, params=""):
    rows, page = [], 1
    while page <= 20:
        d = get(path, f"{params}&page={page}")
        if not isinstance(d, dict):
            break
        rows.extend(d.get("data") or [])
        if not d.get("has_more"):
            break
        page += 1
    return rows


def comp_abbr(fx, side):
    comps = fx.get(f"{side}_competitors") or []
    c = comps[0] if comps else {}
    return team_abbr(c.get("name")) or team_abbr(c.get("abbreviation")) or \
        team_abbr(fx.get(f"{side}_team_display"))


def fixture_day(fx):
    try:
        dt = datetime.fromisoformat(str(fx.get("start_date")).replace("Z", "+00:00"))
        return game_day(dt.astimezone(ET))
    except Exception:
        return None


def _stat(st, *keys):
    for k in keys:
        v = st.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return 0.0


def _all_period(stats_list):
    for s in stats_list or []:
        if s.get("period") == "all":
            return s.get("stats") or {}
    return {}


# ── SLATE ───────────────────────────────────────────────────────────────────
def fetch_slate(today):
    fx = []
    for d in (today, today + timedelta(days=1)):   # late West Coast tips sit on tomorrow's UTC date
        r = get("/fixtures", f"&start_date={d.isoformat()}")
        if r is None:
            return None
        fx.extend(r.get("data") or [])
    games, seen = [], set()
    for f in fx:
        if fixture_day(f) != today or f["id"] in seen:
            continue
        seen.add(f["id"])
        away, home = comp_abbr(f, "away"), comp_abbr(f, "home")
        if not away or not home:
            print(f"  unmapped teams: {f.get('away_team_display')} @ {f.get('home_team_display')}")
            continue
        sc = ((f.get("result") or {}).get("scores") or {})
        st = str(f.get("status") or "").lower()
        games.append({
            "gid": f["id"], "slug": f.get("game_id"), "start": f.get("start_date"),
            "season_type": f.get("season_type"),
            "state": "post" if st == "completed" else "live" if st == "live" or f.get("is_live") else "pre",
            "status": st, "detail": "",
            "away": away, "home": home,
            "away_rec": f.get("away_record") or "", "home_rec": f.get("home_record") or "",
            "away_score": (sc.get("away") or {}).get("total"),
            "home_score": (sc.get("home") or {}).get("total"),
            "spread": None, "total": None, "away_ml": None, "home_ml": None,   # nba_odds.py fills from Onyx
        })
    games.sort(key=lambda g: g["start"] or "")

    teams = {g["away"]: g for g in games} | {g["home"]: g for g in games}
    roster = load("roster.json", {})
    if roster.get("date") != today.isoformat() or not roster.get("players"):
        rows = paged("/players")
        if rows:
            roster = {"date": today.isoformat(), "players": [
                {"pid": p["id"], "name": p.get("name", ""), "pos": p.get("position", ""),
                 "team": team_abbr((p.get("team") or {}).get("name"))}
                for p in rows if p.get("is_active", True)]}
            save("roster.json", roster)
    inj_rows = paged("/injuries")
    inj = {str((i.get("player") or {}).get("id")): i for i in inj_rows}
    inj_by_name = {nk((i.get("player") or {}).get("name")): i for i in inj_rows}

    players = []
    for p in roster.get("players", []):
        g = teams.get(p["team"])
        if not g:
            continue
        i = inj.get(p["pid"]) or inj_by_name.get(nk(p["name"]))
        status = str((i or {}).get("status") or "").upper()
        players.append({
            "pid": p["pid"], "name": p["name"], "team": p["team"],
            "opp": g["home"] if p["team"] == g["away"] else g["away"],
            "home": p["team"] == g["home"], "gid": g["gid"], "pos": p["pos"],
            "inj": status, "inj_detail": (i or {}).get("type") or "",
        })
    slate = {"date": today.isoformat(), "source": "optic",
             "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "games": games, "players": players}
    save("slate.json", slate, indent=1)
    print(f"  slate {today}: {len(games)} games, {len(players)} rostered players, "
          f"{sum(1 for p in players if p['inj'])} on the injury report")
    return slate


# ── BOX SCORES ──────────────────────────────────────────────────────────────
def ingest_box_scores(today):
    pg = load("player_games.json", {})
    tg = load("team_games.json", {})
    done = set(pg.get("_games", []))
    start = SEASON_START if not done else max(SEASON_START, today - timedelta(days=LOOKBACK_DAYS))
    todo, meta = [], {}
    d = start - timedelta(days=1)
    while d <= today:
        r = get("/fixtures", f"&start_date={d.isoformat()}") or {}
        for f in r.get("data") or []:
            if str(f.get("status")).lower() != "completed" or f["id"] in done:
                continue
            if "regular" not in str(f.get("season_type") or "").lower():
                continue
            fd = fixture_day(f)
            if not fd or fd < SEASON_START:
                continue
            todo.append(f["id"])
            meta[f["id"]] = (fd.isoformat(), comp_abbr(f, "away"), comp_abbr(f, "home"))
        d += timedelta(days=1)
    added = 0
    for i in range(0, len(todo), 4):
        chunk = todo[i:i + 4]
        r = get("/fixtures/player-results", "".join(f"&fixture_id={urllib.parse.quote(x)}" for x in chunk))
        for row in (r or {}).get("data") or []:
            fid = (row.get("fixture") or {}).get("id")
            if fid not in meta:
                continue
            gd, away, home = meta[fid]
            box = {away: [], home: []}
            for res in row.get("results") or []:
                team = team_abbr((res.get("team") or {}).get("name"))
                if team not in box:
                    continue
                st = _all_period(res.get("stats"))
                mins = _stat(st, "minutes") or round(_stat(st, "seconds") / 60.0)
                line = {"pid": str((res.get("player") or {}).get("id")),
                        "name": (res.get("player") or {}).get("name", ""),
                        "min": mins, "pts": _stat(st, "points"), "reb": _stat(st, "total_rebounds", "rebounds"),
                        "ast": _stat(st, "assists"), "fg3": _stat(st, "three_point_field_goals_made"),
                        "fga": _stat(st, "field_goals_attempted"), "fta": _stat(st, "free_throws_attempted"),
                        "oreb": _stat(st, "offensive_rebounds"), "tov": _stat(st, "turnovers"),
                        "starter": int(bool(res.get("is_starter")))}
                box[team].append(line)
            if not box[away] or not box[home]:
                continue
            for team, opp in ((away, home), (home, away)):
                for ln in box[team]:
                    rec = pg.setdefault(ln["pid"], {"n": ln["name"], "t": team, "g": []})
                    rec["n"], rec["t"] = ln["name"], team
                    if not any(x[1] == fid for x in rec["g"]):
                        rec["g"].append([gd, fid, opp, int(team == home), ln["min"], ln["pts"],
                                         ln["reb"], ln["ast"], ln["fg3"], ln["starter"]])
                        rec["g"].sort(key=lambda x: x[0])
                t = {k: sum(x[k] for x in box[team]) for k in ("pts", "reb", "ast", "fga", "fta", "oreb", "tov")}
                o = {k: sum(x[k] for x in box[opp]) for k in ("pts", "reb", "ast")}
                rows = tg.setdefault(team, [])
                if not any(x["gid"] == fid for x in rows):
                    rows.append({"d": gd, "gid": fid, "opp": opp, "home": team == home,
                                 "pts": t["pts"], "opp_pts": o["pts"], "reb": t["reb"], "opp_reb": o["reb"],
                                 "ast": t["ast"], "opp_ast": o["ast"],
                                 "poss": round(t["fga"] - t["oreb"] + t["tov"] + 0.44 * t["fta"], 1)})
                    rows.sort(key=lambda x: x["d"])
            done.add(fid)
            added += 1
    pg["_games"] = sorted(done)
    save("player_games.json", pg)
    save("team_games.json", tg)
    print(f"  box scores: +{added} games this run ({len(todo)} new finals found), "
          f"{len(done)} season games, {len(pg) - 1} players")


# ── PRIOR (last season, from each player's last-x log) ─────────────────────
def fetch_priors(slate):
    prior = load("prior.json", {})
    want = [p for p in slate.get("players", []) if p["pid"] not in prior]
    # fetch for the players most likely to matter first: anyone with a game this season
    pg = load("player_games.json", {})
    want.sort(key=lambda p: -sum(g[4] for g in (pg.get(p["pid"]) or {}).get("g", [])))
    got = 0
    for p in want[:PRIOR_REFETCH_PER_RUN]:
        r = get("/fixtures/player-results/last-x", f"&player_id={urllib.parse.quote(p['pid'])}")
        if r is None:
            continue
        row = ((r.get("data") or [{}]) or [{}])[0]
        st = row.get("stats") or {}
        fids = st.get("fixture_ids") or []
        mins = st.get("minutes") or [round((s or 0) / 60.0) for s in (st.get("seconds") or [])]
        agg = {"n": p["name"], "t": team_abbr((row.get("team") or {}).get("name")) or "",
               "pos": p.get("pos", ""), "gp": 0, "min": 0.0, "pts": 0.0, "reb": 0.0, "ast": 0.0, "fg3": 0.0}
        for i, fid in enumerate(fids):
            try:
                d = date(int(fid[0:4]), int(fid[4:6]), int(fid[6:8]))
            except (ValueError, TypeError):
                continue
            if not (PRIOR_START <= d < SEASON_START - timedelta(days=60)):
                continue   # last season only (regular + playoffs); this preseason/season excluded
            m = (mins[i] if i < len(mins) else 0) or 0
            if m <= 0:
                continue
            agg["gp"] += 1
            agg["min"] += m
            for k, src in (("pts", "points"), ("reb", "total_rebounds"), ("ast", "assists"),
                           ("fg3", "three_point_field_goals_made")):
                arr = st.get(src) or []
                agg[k] += float(arr[i] or 0) if i < len(arr) else 0.0
        prior[p["pid"]] = agg   # gp 0 is cached too: a rookie is not re-fetched every run
        got += 1
    prior["_built"] = date.today().isoformat()
    save("prior.json", prior)
    have = sum(1 for k, v in prior.items() if not k.startswith("_") and v.get("gp"))
    print(f"  priors: +{got} fetched, {have} players with last-season games, "
          f"{max(0, len(want) - got)} still queued")


def run_espn_backup(reason):
    print(f"  falling back to ESPN ({reason})")
    return subprocess.call([sys.executable, "-B", "nba_espn.py"])


def main():
    global _KEY
    print("=== Onyx NBA: fetching data ===")
    today = game_day()
    _KEY = os.environ.get("OPTICODDS_API_KEY", "").strip()
    if not _KEY:
        return run_espn_backup("OPTICODDS_API_KEY not set")
    slate = fetch_slate(today)
    if slate is None:
        return run_espn_backup("OpticOdds fixtures call failed")
    ingest_box_scores(today)
    fetch_priors(slate)
    print("=== NBA fetch done (OpticOdds) ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
