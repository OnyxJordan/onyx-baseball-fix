#!/usr/bin/env python3
"""
depth_hockey.py - NHL lines, pairs and goalies with projected ice time and per-game
goals, assists, points and shots, written to data/nhl/depth.json (the shared depth
schema the page's Depth tab renders).

    python3 -B depth_hockey.py [--force]

Sources (the NHL's public API, api-web.nhle.com and api.nhle.com, free):
  - this season's boxscores (ice time, goals, assists, shots), read once per game into
    data/nhl/player_games.json (columnar, newest season only);
  - lines and pairs: shift charts of each team's latest game. Forwards are grouped
    by who shared the most ice with whom (three at a time), defensemen in twos; lines
    are ordered by ice time. Goalies by starts in the team's last 10 games;
  - rosters (who is on the team now; a rostered player not in the latest game is a
    scratch) and last season's per-player totals (club stats, cached once in
    data/nhl/depth_prior.json, the projection's prior);
  - ESPN's injury report (out, IR) by name.

Projection (tested by tools/depth_backtest.py nhl, see P):
  ice time  = decayed average of this season's TOI, pulled toward last season's;
  per game  = per-60 rate (decayed this season, pulled toward last season's rate, which is
              pulled toward the position's) x projected ice time.
Fail-soft and cached: a full refresh at most every MAX_AGE_H hours; any failure keeps
the last depth.json. Pipeline-safe: requests only (plus the standard library).

Changelog (newest first; each entry cites its evidence, tools/depth_backtest.py nhl)

  depth v1  11/2  First build. Projections only, never picks; nhl_model is unchanged. NHL API
      boxscores (bt/nhl_api_box.json), tuned on 2025-26 games before 1/15/2026 with 2024-25 as
      the prior, judged on the 20,487 skater-games after it, average miss vs the season-to-date
      / last-3 averages: ice time 1.87 min vs 2.03 / 1.97; shots 1.016 vs 1.017 / 1.133 (level);
      goals .273 vs .270 / .273, assists .406 vs .399 / .403, points .535 vs .525 / .551: the
      projection misses slightly MORE on average than the season average for goals, assists
      and points (an average-miss score rewards predicting zero), and slightly less by squared
      error (goals .419 vs .422, assists .537 vs .540, points .684 vs .687). 2026-27 to date
      (3,838): ice time 1.89 vs 1.94 / 1.96, shots 1.026 vs 1.104 / 1.159, points .538 vs .544 /
      .554. The page states the per-game rates barely beat the season average.
      Lines: even-strength shared ice from the latest game's shift chart (LINES_VER 2); not
      backtested, there is no official record of line combinations to score them against.
"""

import sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

import requests

from sports_common import Lane, UA, game_day, nk
from depth_football import shrink, age_h, _r, bt_text, save_depth

DEPTH_VER = 1
PG_VER = 1
LINES_VER = 2      # 11/2: lines from even-strength shared ice
MAX_AGE_H = 3
WEB = "https://api-web.nhle.com/v1/"
# tuned on 2025-26 games before 1/15/2026 (2024-25 as the prior), judged on the games after it
# (tools/depth_backtest.py nhl --tune, 11/2): ice time on its average miss, the per-60 rates on
# squared error (the mean; an average-miss score rewards guessing zero goals). Judged: ice time
# 1.87 min vs 2.03 season average / 1.97 last 3; shots 1.016 vs 1.017 / 1.133; goals, assists
# and points miss slightly more on average than the season average (.273 vs .270 goals) but
# less by squared error (.419 vs .422). Rates barely beat the season average: said so on the page.
P = {"toi_dec": 0.8, "toi_k": 2.0, "rate_dec": 0.95, "rate_k": 10.0, "pos_k": 5.0}
STATS = ["g", "a", "pts", "sog"]
LABELS = {"g": "G", "a": "A", "pts": "PTS", "sog": "SOG", "gp": "GP"}
NHL_TO_ESPN = {"TBL": "TB", "NJD": "NJ", "SJS": "SJ", "LAK": "LA", "UTA": "UTAH"}
GROUPS = ["F", "D", "G"]
GROUP_NAME = {"F": "Forward lines", "D": "Defense pairs", "G": "Goalies"}


def _get(url, tries=3):
    for i in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=25)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def toi_min(s):
    try:
        m, sec = str(s).split(":")
        return int(m) + int(sec) / 60
    except Exception:
        return 0.0


def grp_of(pos):
    return "G" if pos == "G" else "D" if pos == "D" else "F"


# ── the projection (shared with the backtest) ─────────────────────────
def logs_from_box(games):
    """bt/nhl_api_box.json-shaped games -> {pid: [{date, team, pos, toi, g, a, pts, sog}]} (skaters, oldest first)."""
    out = defaultdict(list)
    for gm in games:
        for x in gm.get("p") or []:
            if x.get("pos") == "G" or x.get("toi", 0) <= 0:
                continue
            out[x["id"]].append({"date": gm["date"], "team": gm["home"] if x.get("h") else gm["away"],
                                 "pos": x.get("pos"), "toi": x["toi"], "g": x.get("g", 0), "a": x.get("a", 0),
                                 "pts": x.get("pts", (x.get("g", 0) + x.get("a", 0))), "sog": x.get("sog", 0)})
    for v in out.values():
        v.sort(key=lambda r: r["date"])
    return out


def prior_from_logs(logs):
    """Last season's totals per player: {pid: {gp, toi (minutes), g, a, sog, grp}}."""
    out = {}
    for pid, gs in logs.items():
        out[pid] = {"gp": len(gs), "toi": sum(g["toi"] for g in gs), "g": sum(g["g"] for g in gs),
                    "a": sum(g["a"] for g in gs), "sog": sum(g["sog"] for g in gs), "grp": grp_of(gs[-1]["pos"])}
    return out


def pos_rates(prior):
    """Per-60 rates by position group (F / D) from last season's totals."""
    out = {}
    for gp in ("F", "D"):
        rows = [v for v in prior.values() if v["grp"] == gp]
        t = sum(v["toi"] for v in rows) / 60 or 1
        out[gp] = {s: sum(v[s] for v in rows) / t for s in ("g", "a", "sog")}
        out[gp]["toi"] = sum(v["toi"] for v in rows) / max(1, sum(v["gp"] for v in rows))
    return out


def project(cur, pri, grp, prates, p=None):
    """cur: this season's games before the one projected (oldest first); pri: last season's totals or None.
    Returns {toi, g, a, pts, sog} per game, or None."""
    p = p or P
    if not cur and not pri:
        return None
    pos = prates.get(grp) or prates.get("F")
    pri_toi = pri["toi"] / pri["gp"] if pri and pri["gp"] >= 5 else None
    toi = shrink([g["toi"] for g in cur], pri_toi, p["toi_dec"], p["toi_k"]) if cur else pri_toi
    if toi is None:
        toi = pos["toi"]
    n = len(cur)
    w = [p["rate_dec"] ** (n - 1 - i) for i in range(n)]
    hrs = sum(wi * g["toi"] for wi, g in zip(w, cur)) / 60
    out = {"toi": toi}
    for s in ("g", "a", "sog"):
        if pri:
            ph = pri["toi"] / 60
            prate = (pri[s] + p["pos_k"] * pos[s]) / (ph + p["pos_k"])
        else:
            prate = pos[s]
        num = sum(wi * g[s] for wi, g in zip(w, cur))
        rate = (num + p["rate_k"] * prate) / (hrs + p["rate_k"])
        out[s] = rate * toi / 60
    out["pts"] = out["g"] + out["a"]
    return out


def evaluate(logs, prior, p, d0=None, d1=None):
    """MAE of ice time and per-game stats vs the season-to-date and last-3 averages, every
    skater-game in [d0, d1) with 2+ earlier games this season."""
    prates = pos_rates(prior)
    keys = [("toi", "Ice time (minutes)"), ("g", "Goals"), ("a", "Assists"), ("pts", "Points"), ("sog", "Shots on goal")]
    err = {k: ([], [], []) for k, _ in keys}
    for pid, gs in logs.items():
        for i, g in enumerate(gs):
            if i < 2 or (d0 and g["date"] < d0) or (d1 and g["date"] >= d1):
                continue
            cur = gs[:i]
            pr = project(cur, prior.get(pid), grp_of(g["pos"]), prates, p)
            if not pr:
                continue
            for k, _ in keys:
                vals = [x[k] for x in cur]
                e = err[k]
                e[0].append(pr[k] - g[k]); e[1].append(sum(vals) / len(vals) - g[k])
                e[2].append(sum(vals[-3:]) / len(vals[-3:]) - g[k])
    return [score_row(nm, *err[k], d=2 if k == "toi" else 3) for k, nm in keys if err[k][0]]


def score_row(nm, m, a, l3, d=2):
    """Errors (projection minus actual) -> MAE and root mean squared error for the projection and both baselines."""
    n = len(m)
    mae = lambda e: round(sum(abs(x) for x in e) / n, d)
    rmse = lambda e: round((sum(x * x for x in e) / n) ** 0.5, d)
    return {"k": nm, "n": n, "mae": mae(m), "avg": mae(a), "l3": mae(l3), "rmse": rmse(m), "rmse_avg": rmse(a), "rmse_l3": rmse(l3)}


# ── live data ─────────────────────────────────────────────────────────
def season_id(today):
    y = today.year if today.month >= 8 else today.year - 1
    return f"{y}{y + 1}", y


def final_games(start, today):
    """[(gid, date, away, home)] of this season's finished regular-season games."""
    out, d, seen = [], start, set()
    while d <= today:
        sc = _get(WEB + f"schedule/{d.isoformat()}") or {}
        for day in sc.get("gameWeek") or []:
            for g in day.get("games") or []:
                if g.get("gameType") == 2 and g.get("gameState") in ("OFF", "FINAL") and g["id"] not in seen:
                    seen.add(g["id"])
                    out.append((g["id"], day["date"], g["awayTeam"]["abbrev"], g["homeTeam"]["abbrev"]))
        d += timedelta(days=7)
    return sorted(out, key=lambda x: (x[1], x[0]))


def box_rows(gid):
    d = _get(WEB + f"gamecenter/{gid}/boxscore")
    if not d:
        return None, {}
    rows, names = [], {}
    date = d.get("gameDate")
    for side, tk in (("homeTeam", "homeTeam"), ("awayTeam", "awayTeam")):
        team = d[tk]["abbrev"]
        pb = (d.get("playerByGameStats") or {}).get(side) or {}
        for grp in ("forwards", "defense", "goalies"):
            for x in pb.get(grp) or []:
                t = round(toi_min(x.get("toi", "0:00")), 2)
                if t <= 0:
                    continue
                pos = "G" if grp == "goalies" else x.get("position") or ("D" if grp == "defense" else "C")
                rows.append([gid, date, team, x["playerId"], pos, t, x.get("goals", 0) or 0, x.get("assists", 0) or 0,
                             x.get("sog", 0) or 0])
                names[str(x["playerId"])] = (x.get("name") or {}).get("default") or ""
    return rows, names


COLS = ["gid", "date", "team", "pid", "pos", "toi", "g", "a", "sog"]


def ingest(lane, sid, start, today, cap=400):
    pg = lane.load("player_games.json", None) or {}
    if pg.get("_ver") != PG_VER or pg.get("season") != sid:
        pg = {"_ver": PG_VER, "season": sid, "cols": COLS, "_games": [], "rows": [], "names": {}, "lines": {}}
    have = set(pg["_games"])
    todo = [g for g in final_games(start, today) if g[0] not in have][:cap]
    if todo:
        with ThreadPoolExecutor(8) as ex:
            for g, (rows, names) in zip(todo, ex.map(box_rows, [g[0] for g in todo])):
                if rows:
                    pg["rows"].extend(rows)
                    pg["names"].update(names)
                    pg["_games"].append(g[0])
        lane.save("player_games.json", pg)
    print(f"  nhl boxscores: +{len(todo)} games, {len(pg['_games'])} this season, {len(pg['rows'])} rows")
    return pg


def shifts(gid):
    """{playerId: [(start s, end s)]} from the NHL shift chart (game seconds), or {}."""
    d = _get(f"https://api.nhle.com/stats/rest/en/shiftcharts?cayenneExp=gameId={gid}")
    out = defaultdict(list)
    for s in (d or {}).get("data") or []:
        if s.get("typeCode") != 517 or not s.get("duration"):
            continue
        a = (s["period"] - 1) * 1200 + toi_min(s["startTime"]) * 60
        b = (s["period"] - 1) * 1200 + toi_min(s["endTime"]) * 60
        if b > a:
            out[s["playerId"]].append((int(a), int(b)))
    return out


def es_masks(sh, team_of, goalies):
    """Each skater's even-strength seconds as a bit mask: seconds when both teams had five
    skaters on the ice, so power-play and penalty-kill units do not blur the lines."""
    cnt = defaultdict(lambda: [0] * 4000)
    for pid, iv in sh.items():
        if pid in goalies or pid not in team_of:
            continue
        c = cnt[team_of[pid]]
        for a, b in iv:
            for t in range(a, min(b, 4000)):
                c[t] += 1
    teams = list(cnt)
    es = 0
    if len(teams) == 2:
        c1, c2 = cnt[teams[0]], cnt[teams[1]]
        for t in range(4000):
            if c1[t] == 5 and c2[t] == 5:
                es |= 1 << t
    out = {}
    for pid, iv in sh.items():
        m = 0
        for a, b in iv:
            b = min(b, 4000)
            if b > a:
                m |= ((1 << (b - a)) - 1) << a
        out[pid] = m & es if es else m
    return out


def make_units(ids, toi, masks, size, n_units):
    """Greedy: the most-used unassigned player and the teammates he shared the most even-strength ice with."""
    left = sorted(ids, key=lambda i: -toi.get(i, 0))
    units = []
    while left and len(units) < n_units:
        a = left.pop(0)
        ma = masks.get(a, 0)
        mates = sorted(left, key=lambda j: -bin(ma & masks.get(j, 0)).count("1"))[: size - 1]
        for m in mates:
            left.remove(m)
        units.append([a] + mates)
    units.sort(key=lambda u: -sum(toi.get(i, 0) for i in u) / len(u))
    return units, left


def lines_for(gid, rows):
    """{team: {"F": [[pid x3] x4], "D": [[pid x2] x3], "x": [extra skaters]}} from one game's shift chart."""
    sh = shifts(gid)
    out = {}
    by_team = defaultdict(list)
    for r in rows:
        if r[0] == gid:
            by_team[r[2]].append(r)
    team_of = {r[3]: r[2] for rs in by_team.values() for r in rs}
    goalies = {r[3] for rs in by_team.values() for r in rs if r[4] == "G"}
    masks = es_masks(sh, team_of, goalies) if sh else {}
    for team, rs in by_team.items():
        toi = {r[3]: r[5] for r in rs}
        fw = [r[3] for r in rs if r[4] in ("C", "L", "R")]
        dm = [r[3] for r in rs if r[4] == "D"]
        if masks:
            F, xf = make_units(fw, toi, masks, 3, 4)
            D, xd = make_units(dm, toi, masks, 2, 3)
        else:   # no shift chart: lines by ice time order
            fs, ds = sorted(fw, key=lambda i: -toi[i]), sorted(dm, key=lambda i: -toi[i])
            F, D, xf, xd = [fs[i:i + 3] for i in range(0, min(12, len(fs)), 3)], [ds[i:i + 2] for i in range(0, min(6, len(ds)), 2)], fs[12:], ds[6:]
        out[team] = {"F": F, "D": D, "x": xf + xd, "shifts": bool(masks)}
    return out


def prior_totals(lane, prev_sid, teams):
    pri = lane.load("depth_prior.json", None) or {}
    if pri.get("season") == prev_sid and pri.get("p"):
        return pri
    tot = {}
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda t: _get(WEB + f"club-stats/{t}/{prev_sid}/2"), teams))
    for d in res:
        for x in (d or {}).get("skaters") or []:
            v = tot.setdefault(str(x["playerId"]), {"gp": 0, "toi": 0.0, "g": 0, "a": 0, "sog": 0, "grp": grp_of(x.get("positionCode"))})
            gp = x.get("gamesPlayed") or 0
            v["gp"] += gp
            v["toi"] += round((x.get("avgTimeOnIcePerGame") or 0) * gp / 60, 1)
            v["g"] += x.get("goals") or 0
            v["a"] += x.get("assists") or 0
            v["sog"] += x.get("shots") or 0
        for x in (d or {}).get("goalies") or []:
            v = tot.setdefault(str(x["playerId"]), {"gp": 0, "gs": 0, "grp": "G"})
            v["gp"] = v.get("gp", 0) + (x.get("gamesPlayed") or 0)
            v["gs"] = v.get("gs", 0) + (x.get("gamesStarted") or 0)
            v["svp"] = x.get("savePercentage")
    if not tot:
        return pri if pri.get("p") else {"season": None, "p": {}}
    pri = {"season": prev_sid, "p": tot}
    lane.save("depth_prior.json", pri)
    return pri


def build_nhl(lane, slate, force=False):
    old = lane.load("depth.json", None)
    if old and not force and old.get("v") == DEPTH_VER and age_h(old) < MAX_AGE_H:
        print(f"  depth: fresh ({age_h(old):.1f}h old), kept")
        return old
    today = game_day()
    sid, y = season_id(today)
    prev_sid = f"{y - 1}{y}"
    st = _get(WEB + "standings/now") or {}
    teams = {s["teamAbbrev"]["default"]: {"name": (s.get("teamName") or {}).get("default"), "logo": s.get("teamLogo")}
             for s in st.get("standings") or []}
    if not teams:
        print("  depth: NHL standings unavailable, kept the last depth.json")
        return old
    pg = ingest(lane, sid, datetime(y, 9, 25).date(), today)
    rows = pg["rows"]
    if not rows:
        print("  depth: no NHL boxscores yet, kept the last depth.json")
        return old
    pri = prior_totals(lane, prev_sid, list(teams)).get("p") or {}
    prior = {int(k): v for k, v in pri.items() if v.get("grp") != "G" and v.get("gp")}
    prates = pos_rates(prior) if prior else {"F": {"g": .8, "a": 1.2, "sog": 7.0, "toi": 15.5}, "D": {"g": .3, "a": 1.0, "sog": 4.5, "toi": 20.0}}
    # per-player logs this season, per-team game order
    logs = defaultdict(list)
    team_games = defaultdict(list)
    for r in rows:
        logs[r[3]].append(dict(zip(COLS, r)))
        if r[0] not in team_games[r[2]]:
            team_games[r[2]].append(r[0])
    for v in logs.values():
        v.sort(key=lambda x: (x["date"], x["gid"]))
    for t in team_games:
        team_games[t].sort()
    # lines from each team's latest game (cached per game id)
    lines = pg.get("lines") or {} if pg.get("lines_v") == LINES_VER else {}
    pg["lines_v"] = LINES_VER
    latest = {t: gs[-1] for t, gs in team_games.items()}
    need = sorted({g for g in latest.values() if str(g) not in lines})
    with ThreadPoolExecutor(6) as ex:
        for g, ln in zip(need, ex.map(lambda g: lines_for(g, rows), need)):
            lines[str(g)] = ln
    keep = {str(g) for g in latest.values()}
    pg["lines"] = {k: v for k, v in lines.items() if k in keep}
    lane.save("player_games.json", pg)
    with ThreadPoolExecutor(8) as ex:
        rosters = dict(zip(teams, ex.map(lambda t: _get(WEB + f"roster/{t}/current"), list(teams))))
    try:
        import sports_espn as E
        inj = E.fetch_injuries("hockey/nhl")
    except Exception as ex_:
        print(f"  nhl injuries: {ex_}")
        inj = {}
    nxt = {}
    for g in slate.get("games") or []:
        if g.get("state") == "pre":
            nxt.setdefault(g["home"], g["away"])
            nxt.setdefault(g["away"], g["home"])
    bt = lane.load("depth_backtest.json", None)
    out = {"sport": "nhl", "v": DEPTH_VER, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "season": sid, "unit": "toi", "use_label": "Ice time", "stats": STATS, "labels": LABELS,
           "groups": GROUPS, "group_names": GROUP_NAME, "pace_label": "Shots per game", "group_units": {"G": "start%"},
           "method": method_text(bt), "backtest": bt or {}, "teams": {}}
    n_pl = 0
    for t, info in teams.items():
        ro = rosters.get(t) or {}
        names = {}
        posmap = {}
        for grp, key in (("forwards", "F"), ("defensemen", "D"), ("goalies", "G")):
            for x in ro.get(grp) or []:
                names[x["id"]] = f"{(x.get('firstName') or {}).get('default', '')} {(x.get('lastName') or {}).get('default', '')}".strip()
                posmap[x["id"]] = x.get("positionCode") or key
        gid = latest.get(t)
        ln = (pg["lines"].get(str(gid)) or {}).get(t) or {}
        tg = team_games.get(t, [])
        res, placed = [], set()

        def injury(pid):
            return E.injury_of(inj, None, names.get(pid) or pg["names"].get(str(pid))) if inj else None

        def row(pid, role, tier, grp):
            gs = logs.get(pid, [])
            pos = posmap.get(pid) or (gs[-1]["pos"] if gs else grp)
            it = injury(pid)
            out_now = bool(it and it.get("s") == "OUT")
            pr = None if out_now or grp == "G" else project(gs, prior.get(pid), grp, prates)
            now, last = {}, {}
            if gs and grp != "G":
                n = len(gs)
                now = {"gp": n, "use": _r(sum(g["toi"] for g in gs) / n), **{s: _r(sum(g[s] for g in gs) / n, 2) for s in ("g", "a", "sog")}}
                now["pts"] = _r((sum(g["g"] + g["a"] for g in gs)) / n, 2)
            pv = pri.get(str(pid))
            if pv and grp != "G" and pv.get("gp"):
                n = pv["gp"]
                last = {"gp": n, "use": _r(pv["toi"] / n), "g": _r(pv["g"] / n, 2), "a": _r(pv["a"] / n, 2),
                        "pts": _r((pv["g"] + pv["a"]) / n, 2), "sog": _r(pv["sog"] / n, 2)}
            use = _r(pr["toi"]) if pr else None
            if grp == "G":
                starts = [r_ for r_ in rows if r_[3] == pid and r_[0] in tg[-10:]]
                st_ = sum(1 for r_ in starts if r_[5] >= 30)
                use = _r(100 * st_ / max(1, min(10, len(tg))), 0) if not out_now else None   # share of the last 10 starts
                n_st = sum(1 for g in gs if g["toi"] >= 30)
                now = {"gp": len(gs), "use": _r(100 * n_st / max(1, len(tg)), 0)} if gs else {}
                if pv and pv.get("gp"):
                    last = {"gp": pv["gp"], "use": _r(100 * (pv.get("gs") or 0) / 82, 0)}
            tag = []
            if it:
                tag.append(("Out" if it["s"] == "OUT" else "Questionable") + (f" · {it['d']}" if it.get("d") else ""))
            return {"id": str(pid), "n": names.get(pid) or pg["names"].get(str(pid)) or str(pid), "pos": "LW" if pos == "L" else "RW" if pos == "R" else pos,
                    "grp": grp, "role": role, "tier": "Out" if out_now else tier, "tag": " · ".join(tag) or None,
                    "use": use, "proj": {k: _r(pr[k], 2) for k in STATS} if pr else {}, "now": now, "last": last}

        for i, unit in enumerate(ln.get("F") or []):
            for pid in unit:
                res.append(row(pid, f"L{i + 1}", "Starter" if i < 2 else "Rotation", "F")); placed.add(pid)
        for i, unit in enumerate(ln.get("D") or []):
            for pid in unit:
                res.append(row(pid, f"D{i + 1}", "Starter" if i < 2 else "Rotation", "D")); placed.add(pid)
        for pid in ln.get("x") or []:
            res.append(row(pid, "Extra", "Bench", grp_of((logs.get(pid) or [{"pos": "C"}])[-1]["pos"]))); placed.add(pid)
        # goalies: by starts in the last 10 games
        gl = [pid for pid in names if posmap.get(pid) == "G"]
        gl.sort(key=lambda pid: -sum(1 for r_ in rows if r_[3] == pid and r_[0] in tg[-10:] and r_[5] >= 30))
        for i, pid in enumerate(gl):
            res.append(row(pid, f"G{i + 1}", "Starter" if i == 0 else "Rotation", "G")); placed.add(pid)
        # rostered, not in the latest game: scratched or hurt
        for pid in names:
            if pid in placed or posmap.get(pid) == "G":
                continue
            r_ = row(pid, "Scratch", "Bench", "D" if posmap.get(pid) == "D" else "F")
            res.append(r_)
        if not res:
            continue
        sog = [r_ for r_ in rows if r_[2] == t]
        pace = _r(sum(r_[8] for r_ in sog) / len(tg)) if tg else None
        ek = NHL_TO_ESPN.get(t, t)
        out["teams"][ek] = {"name": info["name"], "logo": info["logo"], "pace": pace,
                            "next": {"opp": nxt[ek]} if ek in nxt else None,
                            "lines_from": "shift chart" if ln.get("shifts") else "ice time", "players": res}
        n_pl += len(res)
    if not out["teams"]:
        return old
    save_depth(lane, out)
    print(f"  depth: {len(out['teams'])} teams, {n_pl} players")
    return out


def method_text(bt):
    return ("Lines and pairs come from each team's latest game: forwards grouped by who shared the most ice with whom "
            "(the NHL's shift charts), defensemen in twos, ordered by ice time; goalies by starts in the last 10 games, their usage the share of those starts. "
            "A rostered player who did not dress is a scratch; injuries from ESPN's report. Ice time is projected as a "
            "decayed average of this season pulled toward last season's; goals, assists and shots are his per-60 rates "
            "(this season pulled toward last season's, and that toward his position's) times the projected ice time. "
            "Pace is the team's shots per game. These are projections, not picks. " + bt_text(bt) + _std(bt))


def _std(bt):
    """This season so far, the same projection (never tuned on it)."""
    r = {x["k"]: x for x in (bt or {}).get("season_to_date") or []}
    t, p = r.get("Ice time (minutes)"), r.get("Points")
    if not t or not p:
        return ""
    return (f" This season to date ({t['n']:,} skater-games): ice time misses by {t['mae']:g} minutes vs {t['avg']:g} for the "
            f"season average, points by {p['mae']:g} vs {p['avg']:g}. Goals, assists and points barely beat the season "
            "average at best, so read them as a player's usual rate, not an edge.")


def build(lane=None, slate=None, force=False):
    lane = lane or Lane("nhl")
    slate = slate if slate is not None else (lane.load("slate.json", {}) or {})
    try:
        return build_nhl(lane, slate, force)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"  depth: {str(e)[:160]}")
        return None


if __name__ == "__main__":
    build(force="--force" in sys.argv)
