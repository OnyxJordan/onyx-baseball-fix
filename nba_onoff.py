"""
nba_onoff.py - on/off splits from lineup stints (ESPN play-by-play).

For every pair of teammates (P, T) it keeps what P produced per minute with
T on the floor and with T off it: minutes, points, field goal and free
throw attempts, rebounds, assists, turnovers. The model reads the ratio
"T off / T on" for a player whose teammate T is OUT tonight: measured for
this player and this teammate, instead of a formula that hands the missing
shots around by usage (tried twice, v3 and v5, and rejected both times).

Stints come from tools/nba_pbp_pull.py (backtest) or pull_game() here
(production): {"stints": [[team, t0, t1, [5 ids]]], "ev": [[t, team, kind,
actor, other]], "names": {id: name}}. Keys are ESPN athlete ids, which the
slate already carries as `hs`.
"""

import json, math, os, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import requests

SB = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={}"
SUM = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={}"
S = requests.Session()

STATS = ("pts", "fga", "fta", "reb", "ast", "tov")


# ── ESPN play-by-play -> lineup stints ──────────────────────────────────
def get(url, tries=4):
    for i in range(tries):
        try:
            r = S.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def clock_sec(period, disp):
    """Seconds elapsed since tip: 12-minute quarters, 5-minute overtimes."""
    try:
        m, s = (disp or "0:0").split(":") if ":" in str(disp) else (0, disp)
        left = int(m) * 60 + float(s)
    except ValueError:
        left = 0.0
    if period <= 4:
        return (period - 1) * 720 + (720 - left)
    return 2880 + (period - 5) * 300 + (300 - left)


def period_end(period):
    return period * 720 if period <= 4 else 2880 + (period - 4) * 300


def parse_game(eid, d):
    g = get(SUM.format(eid))
    if not g or not g.get("plays"):
        return None
    box = (g.get("boxscore") or {}).get("players") or []
    teams, names, on = {}, {}, {}
    for t in box:
        tid = str(t["team"]["id"])
        teams[tid] = t["team"].get("abbreviation")
        st = (t.get("statistics") or [{}])[0]
        on[tid] = [str(a["athlete"]["id"]) for a in st.get("athletes", []) if a.get("starter")]
        for a in st.get("athletes", []):
            names[str(a["athlete"]["id"])] = a["athlete"].get("displayName")
    if len(teams) != 2 or any(len(v) != 5 for v in on.values()):
        return None
    stints, ev = [], []
    start = {tid: 0.0 for tid in on}
    cur_p = 1

    def close(tid, t):
        if t > start[tid]:
            stints.append([tid, round(start[tid], 1), round(t, 1), sorted(on[tid])])
        start[tid] = t

    for p in g["plays"]:
        per = (p.get("period") or {}).get("number") or 1
        t = clock_sec(per, (p.get("clock") or {}).get("displayValue"))
        typ = (p.get("type") or {}).get("text") or ""
        tid = str((p.get("team") or {}).get("id") or "")
        ids = [str((x.get("athlete") or {}).get("id")) for x in p.get("participants") or []]
        if per != cur_p:
            # a new period: ESPN lists the period's starters only implicitly; the
            # five on the floor carry over and the first subs of the period fix it
            cur_p = per
        if typ == "Substitution" and tid in on and len(ids) >= 2:
            inn, out = ids[0], ids[1]
            if out in on[tid] and inn not in on[tid]:
                close(tid, t)
                on[tid] = [inn if x == out else x for x in on[tid]]
            continue
        if not ids or tid not in on:
            continue
        a = ids[0]
        o = ids[1] if len(ids) > 1 else None
        if p.get("shootingPlay"):
            if "Free Throw" in typ:
                ev.append([round(t, 1), tid, "ft" if p.get("scoringPlay") else "fm", a, None])
            else:
                three = (p.get("pointsAttempted") or 0) == 3
                if p.get("scoringPlay"):
                    ev.append([round(t, 1), tid, "f3" if three else "f2", a, o])
                else:
                    ev.append([round(t, 1), tid, "m3" if three else "m2", a, None])
        elif "Offensive Rebound" in typ:
            ev.append([round(t, 1), tid, "or", a, None])
        elif "Defensive Rebound" in typ:
            ev.append([round(t, 1), tid, "dr", a, None])
        elif "Turnover" in typ and "Team" not in (p.get("text") or ""):
            ev.append([round(t, 1), tid, "to", a, None])
    end = max(period_end(cur_p), max((e[0] for e in ev), default=0))
    for tid in on:
        close(tid, end)
    return {"id": eid, "d": d, "teams": teams, "names": names, "stints": stints, "ev": ev}

PTS = {"f2": 2, "f3": 3, "ft": 1}


def game_pairs(g):
    """{(p, t): [min_on, min_off, *stats_on, *stats_off]} for one game, p and
    t teammates who both appear in it (t's absent spells count as 'off')."""
    team_of = {}
    for tid, t0, t1, ids in g["stints"]:
        for i in ids:
            team_of[i] = tid
    roster = defaultdict(set)
    for i, tid in team_of.items():
        roster[tid].add(i)
    # each player's production inside each stint
    ev_by_team = defaultdict(list)
    for t, tid, kind, a, o in g["ev"]:
        ev_by_team[tid].append((t, kind, a, o))
    for v in ev_by_team.values():
        v.sort(key=lambda e: e[0])
    n = len(STATS)
    out = defaultdict(lambda: [0.0] * (2 + 2 * n))
    for tid, t0, t1, ids in g["stints"]:
        mins = (t1 - t0) / 60.0
        if mins <= 0:
            continue
        prod = defaultdict(lambda: [0.0] * n)
        for t, kind, a, o in ev_by_team[tid]:
            if t < t0 or t >= t1:
                if t >= t1:
                    break
                continue
            if a in ids:
                p = prod[a]
                p[0] += PTS.get(kind, 0)
                p[1] += kind in ("f2", "f3", "m2", "m3")
                p[2] += kind in ("ft", "fm")
                p[3] += kind in ("or", "dr")
                p[5] += kind == "to"
            if kind in ("f2", "f3") and o in ids:
                prod[o][4] += 1
        on = set(ids)
        for p in ids:
            st = prod.get(p, [0.0] * n)
            for t in roster[tid]:
                if t == p:
                    continue
                row = out[(p, t)]
                if t in on:
                    row[0] += mins
                    for k in range(n):
                        row[2 + k] += st[k]
                else:
                    row[1] += mins
                    for k in range(n):
                        row[2 + n + k] += st[k]
    return out


class OnOff:
    """Running pair table; add() games in date order, ratio() reads it."""

    def __init__(self):
        self.t = defaultdict(lambda: [0.0] * (2 + 2 * len(STATS)))

    def add(self, g, w=1.0):
        for k, row in game_pairs(g).items():
            acc = self.t[k]
            for i, v in enumerate(row):
                acc[i] += w * v

    def log_ratio(self, p, t, stat, k_min):
        """Shrunk log of P's per-minute `stat` with T off over with T on.
        0 when unknown; shrunk toward 0 by k_min minutes of evidence on the
        smaller side."""
        row = self.t.get((p, t))
        if not row:
            return 0.0
        m_on, m_off = row[0], row[1]
        if m_on < 1 or m_off < 1:
            return 0.0
        i = STATS.index(stat)
        n = len(STATS)
        # a small constant keeps a zero-count side finite
        r_on = (row[2 + i] + 0.5) / m_on
        r_off = (row[2 + n + i] + 0.5) / m_off
        lr = math.log(r_off / r_on)
        w = min(m_on, m_off) / (min(m_on, m_off) + k_min)
        return lr * w

    def dump(self, min_minutes=30.0):
        return {f"{p}|{t}": [round(x, 2) for x in row] for (p, t), row in self.t.items()
                if row[0] + row[1] >= min_minutes}

    @classmethod
    def load(cls, d):
        o = cls()
        for k, row in (d or {}).items():
            p, t = k.split("|")
            o.t[(p, t)] = list(row)
        return o


# ── the production table: data/nba/onoff.json ──────────────────────────
# {"seasons": {"2026": {"p|t": row}, ...}, "names": {id: name},
#  "done": {"2027": [event ids]}, "through": {"2027": "YYYY-MM-DD"}}
# Last season is seeded once (tools/nba_pbp_pull.py + seed()); the current
# season grows by every final the refresh has not counted yet.
KEEP_MIN = 60.0


def finals_on(day):
    sb = get(SB.format(day.strftime("%Y%m%d"))) or {}
    out, pending = [], False
    for e in sb.get("events") or []:
        if (e.get("season") or {}).get("type") not in (2, None):
            continue
        st = ((e.get("status") or {}).get("type") or {}).get("state")
        if st == "post":
            out.append(e["id"])
        else:
            pending = True
    return out, pending


def refresh(today, load, save, season_of):
    """Count every regular-season final not counted yet. load/save are
    nba_common's (data/nba/...), season_of its current_season."""
    st = load("onoff.json", {}) or {}
    season = str(season_of(today))
    seasons, done, through = st.setdefault("seasons", {}), st.setdefault("done", {}), st.setdefault("through", {})
    names = st.setdefault("names", {})
    tab = OnOff.load(seasons.get(season))
    seen = set(done.get(season) or [])
    start = date.fromisoformat(through[season]) if season in through else date(int(season) - 1, 10, 1)
    day, last_clean, added = start, through.get(season), 0
    jobs = []
    while day <= today:
        ids, pending = finals_on(day)
        jobs += [(i, day.isoformat()) for i in ids if i not in seen]
        if not pending and day < today:
            last_clean = day.isoformat()
        day += timedelta(days=1)

    def work(j):
        try:
            return parse_game(*j)
        except (KeyError, TypeError, ValueError, IndexError):
            return "bad"
    failed = []
    with ThreadPoolExecutor(6) as ex:
        for (eid, _), g in zip(jobs, ex.map(work, jobs)):
            if g == "bad":
                seen.add(eid)          # malformed summary: skipped for good
            elif g:
                tab.add(g)
                names.update(g["names"])
                added += 1
                seen.add(eid)
            else:
                failed.append(_)       # the fetch failed: rescan that day next run
    seasons[season] = tab.dump(KEEP_MIN)
    done[season] = sorted(seen)
    if failed:
        first = (date.fromisoformat(min(failed)) - timedelta(days=1)).isoformat()
        last_clean = min(last_clean, first) if last_clean else None
    if last_clean:
        through[season] = last_clean
    keep = {season, str(int(season) - 1)}
    for k in list(seasons):
        if k not in keep:
            seasons.pop(k)
    for k in list(done):
        if k not in keep:
            done.pop(k)
    save("onoff.json", st)
    print(f"  on/off: +{added} games this run, {len(done[season])} counted for {season}, "
          f"{len(seasons[season])} pairs; last season {'loaded' if str(int(season) - 1) in seasons else 'MISSING'}")
    return st


def tonight(st, season, w_prev=1.0):
    """The OnOff the model reads: last season at w_prev plus this season."""
    o = OnOff()
    for k, w in ((str(int(season) - 1), w_prev), (str(season), 1.0)):
        for key, row in ((st.get("seasons") or {}).get(k) or {}).items():
            p, t = key.split("|")
            acc = o.t[(p, t)]
            for i, v in enumerate(row):
                acc[i] += w * v
    return o


def per36(o, p, t):
    """For the page: P's points per 36 with T on and off, and the off minutes."""
    row = o.t.get((p, t))
    if not row or row[0] < 1 or row[1] < 1:
        return None
    n = len(STATS)
    return {"on": round(36 * row[2] / row[0], 1), "off": round(36 * row[2 + n] / row[1], 1),
            "min_off": round(row[1])}
