#!/usr/bin/env python3
"""
cbb_stats.py - projected season stat lines and depth charts for men's college basketball.

Each player's projected points, rebounds, assists, made threes, steals and blocks per game is
    projected minutes (cbb_minutes.py) x projected production per 40 minutes.
Production per 40 starts from last season's per-40 rate (Torvik per-game stats over his minutes,
wherever he played) and is adjusted, by stat and by group, for
  sample        a rate built on few minutes is pulled toward the group's average
  class         freshmen and sophomores grow the most
  usage         the rest of the roster's proven usage (teammates' last-season usage x minutes):
                a crowded roster takes shots and touches from him
  transfer      the move's level change (new team's adjusted efficiency margin minus the old one)
                and the new team's tempo against the old team's (more possessions, more stats)
  newcomers     recruit rating (Torvik's 0-100), height and the new team's level
The weights are fitted by least squares on earlier seasons and tested on a held-out season by
tools/cbb_stats_backtest.py, which rewrites FIT and BACKTEST below. In season, real production
takes over: rate = (minutes played x real rate + K_RATE x projected rate) / (minutes played + K_RATE).

Writes data/cbb/depth.json (the shared depth-chart schema: teams -> players with projected
minutes and per-game stats). Uses ESPN rosters and Torvik's current-season file over `requests`.
"""
import json, math, os
from datetime import datetime, timezone

import cbb_minutes as MIN

ROOT = os.path.dirname(os.path.abspath(__file__))
HIST = MIN.HIST
STATS = ["pts", "reb", "ast", "3pm", "stl", "blk"]
SHOW = ["pts", "reb", "ast", "3pm"]
K_RATE = 150.0        # minutes of real production worth one preseason projection
CLS = MIN.CLS
# fitted by tools/cbb_stats_backtest.py (features in feats(); see its report)
FIT = {"pts": {"returning": [3.1849, 0.4474, 0.3893, -0.1272, -0.1085, -0.0513, 2.309, 1.079, 3.2238], "newcomer": [14.1116, -3.5983, 7.5547, -0.1999, -0.0108, -1.5642], "transfer": [8.311, 0.2553, 0.1771, -0.1007, -0.0275, 0.0033, 0.6848, 0.1989, 2.4451, 0.0162, -1.1122, 0.0978]}, "reb": {"returning": [1.3742, 0.697, 0.1851, 0.0296, -0.0447, -0.0076, 0.5646, 0.1366, -0.4248], "newcomer": [6.6117, -1.0014, 0.5894, 1.6201, -0.0163, 0.3253], "transfer": [2.7093, 0.6457, 0.1944, 0.0197, -0.1909, -0.0303, 1.2978, 0.2517, -1.2934, 0.031, -0.3639, 0.3915]}, "ast": {"returning": [0.5577, 0.5118, 0.5509, -0.0838, -0.0178, -0.0327, 0.2679, 0.1364, 0.099], "newcomer": [2.3027, -0.3292, 1.1869, -0.7618, 0.0518, -0.159], "transfer": [0.9012, 0.4797, 0.5297, -0.1096, -0.053, -0.0045, 0.296, 0.0675, -0.1189, 0.0238, -0.2043, 0.2991]}, "3pm": {"returning": [0.372, 0.6324, 0.4112, -0.06, -0.0868, -0.0492, 0.2234, 0.0873, -0.065], "newcomer": [1.3735, -0.1524, 0.5089, -0.3196, 0.053, -0.2198], "transfer": [0.59, 0.6834, 0.2855, -0.0583, -0.0977, -0.0492, 0.2889, 0.1141, -0.2263, 0.0284, -0.1113, 0.3827]}, "stl": {"returning": [0.5318, 0.2824, 0.5036, 0.0107, -0.1023, -0.0819, 0.192, 0.1083, -0.0133], "newcomer": [1.2455, -0.1378, 0.2567, -0.1965, 0.0121, 0.0205], "transfer": [0.5994, 0.1962, 0.4486, -0.0005, -0.1249, 0.0148, 0.2559, 0.0141, 0.0936, 0.0262, -0.0892, 0.2972]}, "blk": {"returning": [0.1541, 0.4601, 0.4447, 0.1132, 0.0259, -0.0336, 0.0482, 0.0321, -0.0539], "newcomer": [0.7081, -0.2011, 0.2231, 0.4319, -0.0106, 0.1493], "transfer": [0.3583, 0.3658, 0.4813, 0.1161, 0.0054, -0.0228, 0.076, 0.0278, -0.1872, 0.0262, -0.0516, 0.6695]}}
BACKTEST = {"season": "2025-26", "n": 4548, "minutes_mae": 5.96, "minutes_naive": 7.36, "stats": {"pts": {"model": 2.97, "naive": 3.57}, "reb": {"model": 1.12, "naive": 1.33}, "ast": {"model": 0.59, "naive": 0.69}, "3pm": {"model": 0.4, "naive": 0.43}, "stl": {"model": 0.27, "naive": 0.31}, "blk": {"model": 0.18, "naive": 0.2}}, "groups": {"returning": {"n": 1469, "min": {"model": 4.78, "naive": 5.95}, "pts": {"model": 2.45, "naive": 2.87}, "reb": {"model": 0.94, "naive": 1.07}, "ast": {"model": 0.49, "naive": 0.57}, "3pm": {"model": 0.33, "naive": 0.34}, "stl": {"model": 0.25, "naive": 0.27}, "blk": {"model": 0.17, "naive": 0.17}}, "transfer": {"n": 1436, "min": {"model": 5.9, "naive": 8.56}, "pts": {"model": 3.32, "naive": 4.54}, "reb": {"model": 1.22, "naive": 1.64}, "ast": {"model": 0.64, "naive": 0.76}, "3pm": {"model": 0.43, "naive": 0.48}, "stl": {"model": 0.29, "naive": 0.36}, "blk": {"model": 0.21, "naive": 0.23}}, "newcomer": {"n": 1643, "min": {"model": 7.08, "naive": 7.56}, "pts": {"model": 3.12, "naive": 3.36}, "reb": {"model": 1.2, "naive": 1.29}, "ast": {"model": 0.62, "naive": 0.72}, "3pm": {"model": 0.42, "naive": 0.47}, "stl": {"model": 0.29, "naive": 0.31}, "blk": {"model": 0.18, "naive": 0.21}}}}


def load_box(season):
    """pid -> {gp, mpg, pts, reb, ast, 3pm, stl, blk} (per game) for a Torvik season"""
    p = os.path.join(HIST, f"box_{season}.json")
    if not os.path.exists(p):
        return {}
    d = json.load(open(p))
    return {r[0]: dict(zip(d["cols"][1:], r[1:])) for r in d["rows"]}


def team_tempo(season):
    t = json.load(open(os.path.join(HIST, "teams.json"))).get(str(season)) or []
    return {x["team"]: x["tempo"] for x in t if x.get("tempo")}


def per40(box, stat):
    m = (box or {}).get("mpg") or 0
    return (box.get(stat) or 0) * 40.0 / m if m > 0 else 0.0


def feats(stat, group, prev, box, rec=None, ht_in=78, lvl=0.0, em_new=None, comp=0.0, tempo_ratio=1.0):
    """features for one player's per-40 rate of one stat.
    prev = last season's Torvik row (class, usage), box = its per-game line; comp = the rest of the
    roster's proven usage (sum of usage% x mpg / 40, over 100); lvl = adj_em change / 10."""
    if group == "newcomer":
        r = (rec or 0) / 100.0
        return [1.0, r, r ** 3, (ht_in - 78) / 3.0, (em_new or 0) / 10.0, comp]
    r = per40(box, stat)
    mins = (box.get("gp") or 0) * (box.get("mpg") or 0)
    rel = mins / (mins + 300.0)
    c = CLS.get((prev or {}).get("cls"), 2)
    fr, so = float(c == 0), float(c == 1)
    usg = ((prev or {}).get("usg") or 20.0) / 20.0
    f = [1.0, r, r * rel, r * comp, r * fr, r * so, fr, so, usg]
    if group == "transfer":
        f += [r * lvl, lvl, r * (tempo_ratio - 1.0)]
    return f


def rate(stat, group, f, fit=None):
    w = ((fit or FIT).get(stat) or {}).get(group)
    if not w:
        return f[1] if group != "newcomer" else 0.0
    return max(0.0, sum(a * b for a, b in zip(f, w)))


def blend(proj_rate, minutes_played, real_rate):
    if not minutes_played:
        return proj_rate
    return (minutes_played * real_rate + K_RATE * proj_rate) / (minutes_played + K_RATE)


def _ht_in(s):
    import re
    m = re.match(r"(\d+)\D+(\d+)", str(s or ""))
    return int(m.group(1)) * 12 + int(m.group(2)) if m else 78


def team_pace(as_of):
    """projected possessions per 40 for each ESPN abbreviation, from the game model's pace ratings"""
    try:
        import cbb_model as CM
        lane = os.path.join(ROOT, "data", "cbb")
        names = json.load(open(os.path.join(lane, "teams_espn.json")))
        games = (json.load(open(os.path.join(lane, "results.json"))) or {}).get("games") or []
        return (CM.ratings(lane, games, as_of, names) or {}).get("poss") or {}
    except Exception as e:
        print(f"cbb_stats: no pace ({e})")
        return {}


METHOD = ("Minutes first: a separate fit for returning players, transfers and newcomers turns last season's role, class, the "
          "level of any transfer, the recruit rating and the competition on the roster into minutes per game. Production per "
          "40 minutes comes from last season's rates wherever he played, pulled toward average when they rest on few minutes, "
          "grown for freshmen and sophomores, cut when the new roster already holds a lot of proven usage, and for transfers "
          "moved by the step up or down in level and by the new team's tempo against the old one. Freshmen start from their "
          "recruit rating and height. Projected stats are minutes times rate. Every weight is fitted on earlier seasons and "
          "tested on 2025-26 without seeing it. In season, real minutes and real production take over game by game. "
          "Research, not tracked picks.")


def build(out_path=None):
    tm_last = MIN.SEASON_LAST
    m = MIN.build(None, keep_raw=True)
    box = {**load_box(tm_last - 1), **load_box(tm_last)}       # the latest season wins
    usg_of = {}
    for r in MIN.load_players(tm_last - 1) + MIN.load_players(tm_last):
        usg_of[r["pid"]] = r
    em = MIN.team_em(tm_last)
    tempo = team_tempo(tm_last)
    today = datetime.now(timezone.utc)
    pace = team_pace(MIN.baseball_day())
    teams = {}
    for ab, t in m["teams"].items():
        tv = t.get("torvik")
        players = t["players"]
        proven = sum(((usg_of.get((p.get("last") or {}).get("pid")) or {}).get("usg") or 0) * ((p.get("last") or {}).get("mpg") or 0) / 40.0
                     for p in players)
        out = []
        for p in players:
            l = p.get("last") or {}
            prev = usg_of.get(l.get("pid")) if l else None
            b = box.get(l.get("pid")) if l else None
            if prev and not b:          # no box line: per-game from the player file, no threes / steals / blocks
                b = {"gp": prev.get("gp"), "mpg": prev.get("mpg"), "pts": prev.get("ppg"), "reb": prev.get("rpg"), "ast": prev.get("apg")}
            g = p["g"] if b else "newcomer"
            own = ((prev or {}).get("usg") or 0) * (l.get("mpg") or 0) / 40.0
            comp = (proven - own) / 100.0
            lvl = (p.get("lvl") or 0) / 10.0
            tr = (tempo.get(tv) or 0) / tempo[l["t"]] if g == "transfer" and tempo.get(l.get("t")) and tempo.get(tv) else 1.0
            now = p.get("_now") or {}
            played = (now.get("gp") or 0) * (now.get("mpg") or 0)
            proj = {}
            for s in STATS:
                f = feats(s, g, prev, b or {}, p.get("rec"), p.get("_ht") or 78, lvl, em.get(tv), comp, tr)
                r = rate(s, g, f)
                if played and now.get(s) is not None:
                    r = blend(r, played, (now[s] or 0) * 40.0 / max(now.get("mpg") or 1, 1))
                proj[s] = round(p["mpg"] * r / 40.0, 1)
            if g == "transfer":
                lv = p.get("lvl") or 0
                tag = f"Transfer from {p.get('from')} " + (f"({'step up' if lv > 0 else 'step down'} {abs(lv):g})" if abs(lv) >= 0.5 else "(same level)")
            elif g == "newcomer":
                tag = "Freshman" if (p.get("cls") or "").upper() == "FR" else "Newcomer"
            else:
                tag = "Returning"
            x = {"id": p.get("id"), "n": p.get("n"), "pos": p.get("pos"), "cls": p.get("cls"), "role": p.get("role"), "tag": tag,
                 "g": g, "use": p["mpg"], "proj": {s: proj[s] for s in STATS}}
            if p.get("ht"):
                x["ht"] = p["ht"]
            if p.get("hs"):
                x["hs"] = 1
            if p.get("rec"):
                x["rec"] = p["rec"]
            if l:
                x["last"] = {"t": l.get("t"), "s": l.get("s"), "use": l.get("mpg"), "gp": l.get("gp"), "pts": l.get("ppg"), "reb": l.get("rpg"),
                             "ast": l.get("apg"), "3pm": round((b or {})["3pm"], 1) if (b or {}).get("3pm") is not None else None, "bpm": l.get("bpm")}
            if now.get("gp"):
                x["now"] = {"gp": now["gp"], "use": now.get("mpg"), "pts": now.get("pts"), "reb": now.get("reb"), "ast": now.get("ast"), "3pm": now.get("3pm")}
            out.append(x)
        teams[ab] = {"name": t["name"], "pace": pace.get(ab), "em_last": t.get("em_last"), "players": out}
    bt = BACKTEST or {}
    d = {"sport": "cbb", "generated": today.isoformat(timespec="seconds"), "unit": "min", "stats": SHOW, "extra": ["stl", "blk"],
         "season": m["season"], "method": METHOD, "backtest": bt, "teams": teams, "matched": m["matched"]}
    n = sum(len(t["players"]) for t in teams.values())
    if out_path:
        if n < 2000 or len(teams) < 300:     # ESPN or Torvik down: keep yesterday's file rather than a hollow one
            raise SystemExit(f"cbb depth: only {len(teams)} teams / {n} players, not written")
        json.dump(d, open(out_path, "w"), separators=(",", ":"))
    return d


def _age_hours(path):
    try:
        g = json.load(open(path)).get("generated")
        return (datetime.now(timezone.utc) - datetime.fromisoformat(g)).total_seconds() / 3600
    except Exception:
        return None


def _transfers():
    """transfer impact and the player-based team prior (cbb_transfers.py) from depth.json; fail-soft"""
    try:
        import cbb_transfers
        tj, pj = cbb_transfers.build()
        print(f"cbb transfers: {tj['n']} transfers, {len(pj['teams'])} team priors")
    except (Exception, SystemExit) as e:
        print(f"cbb transfers: skipped ({e})")


if __name__ == "__main__":
    import sys
    out = os.path.join(ROOT, "data", "cbb", "depth.json")
    if "--if-older" in sys.argv:          # the 30-minute refresh: rebuild at most once in that many hours
        age, lim = _age_hours(out), float(sys.argv[sys.argv.index("--if-older") + 1])
        if age is not None and age < lim:
            print(f"cbb depth: {age:.1f} h old, under {lim:g} h, kept")
            ta = _age_hours(os.path.join(ROOT, "data", "cbb", "transfers.json"))
            if ta is None or ta > age + 0.5:      # transfers lag the depth chart: catch up
                _transfers()
            sys.exit(0)
    o = build(out)
    n = sum(len(t["players"]) for t in o["teams"].values())
    print(f"cbb depth: {len(o['teams'])} teams, {n} players, {o['matched']} matched to a college season")
    _transfers()
