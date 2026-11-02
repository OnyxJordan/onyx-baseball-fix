#!/usr/bin/env python3
"""
depth_football.py - NFL and college football depth charts with usage and per-game
projections, written to data/<sport>/depth.json (the shared depth schema the page's
Depth tab renders for every sport).

    python3 -B depth_football.py nfl|cfb [--force]

NFL
  - Order: ESPN's team depth charts (site API /teams/{id}/depthcharts): offense,
    defense and special teams, with ESPN's injury status on each player.
  - Usage: offense / defense / special-teams snap share from nflverse snap counts
    (github.com/nflverse/nflverse-data, free; every position, every game). The
    projection is a decayed average of this season's snap shares pulled toward last
    season's (SNAP_P, tuned on 2025, judged on 2026: tools/depth_backtest.py).
  - Stats: nfl_model.project (the NFL model's season projection: decayed average,
    last season's prior, opponent adjustment) for passing, rushing, receiving yards and
    receptions; touchdowns and passing touchdowns from the same decayed average (TD_P).
  - Pace: offensive plays per game (the team's most offensive snaps in each game).
College football
  - ESPN has no college depth charts, so the order is usage: each team's players by
    position (ESPN roster, cached a week in data/cfb/rosters.json) ranked by projected
    share of the team's passes (QB), carries (RB) or catches (WR, TE).
  - Stats: cfb_players.project (passing, rushing, receiving yards, receptions) and the
    same decayed touchdown average.

Fail-soft and cached: a full refresh at most every MAX_AGE_H hours; any failure keeps
the last depth.json. Pipeline-safe: requests only (plus the standard library).

Changelog (newest first; each entry cites its evidence, tools/depth_backtest.py)

  depth v1  11/2  First build. Projections only, never picks; nothing here changes nfl_model or
      cfb_players (their VERSIONs stand). Every game projected only from games before it,
      scored by average miss against the season-to-date and last-3 averages:
      NFL, tuned on 2025 (2024 snap counts as the prior), judged on 2026 weeks 3-8:
        snap share 10.6 points vs 11.0 / 10.9 (6,340 player-games; SNAP_P dec .5, no pull);
        nfl_model.project passing yards 64.9 vs 67.9 / 71.6 (166), rushing 27.4 vs 27.9 / 27.7
        (257), receptions 1.76 vs 1.85 / 1.92 (739), receiving yards 24.7 vs 26.0 / 26.9 (739);
        touchdowns: the grid chose the plain season average (.438 vs .438 / .437), passing
        touchdowns the same (.965 vs .965 / .981). No gain there, and the page says so.
      College, one season on file, tuned on 2026 weeks 4-6, judged on weeks 7-9: usage share
        (every team game after his first two, 0 when he has no box line) 9.2 points vs 10.1 /
        9.6 (4,579; CFB_SHARE_P dec .4); cfb_players passing 67.0 vs 68.6 / 73.2, rushing 29.1 vs
        30.3 / 31.3, receptions 1.44 vs 1.45 / 1.51, receiving yards 22.7 vs 22.8 / 23.8 (level);
        touchdowns .502 vs .502 / .498 (the last 3 is slightly better).
      Not backtested: ESPN's depth chart order (ESPN keeps no history of it) and the injury
      tags; a player ruled out simply gets no projection. A backup quarterback under half the
      snaps gets no per-game line (it would read as if he starts).
"""

import csv, io, json, re, sys, time, unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

from sports_common import Lane, UA, espn_get

DEPTH_VER = 1
MAX_AGE_H = 3
NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download/"
# snap share: decayed average of this season (dec) pulled toward last season's mean with k
# pseudo-games. Tuned on 2025 weeks 3-18 (2024 as the prior), judged on 2026 weeks 3-8
# (tools/depth_backtest.py nfl --tune, 11/2): the grid chose dec .5 and no pull (k 0), so last
# season only fills in for a player with no snaps yet. 2026 error 10.6 points vs 11.0 season
# average, 10.9 last 3.
SNAP_P = {"dec": 0.5, "k": 0.0}
# touchdowns per game: same shape. The 2025 grid chose no decay and no pull (dec 1, k 0): the
# plain season average; nothing in the grid beat it (2026: .438 vs .438 / .437 last 3).
TD_P = {"dec": 1.0, "k": 0.0}
VERSE_TEAM = {"WSH": "WAS", "LAR": "LA"}            # ESPN -> nflverse team abbreviations

# ESPN depth chart slot -> (group, short label)
SLOT = {"qb": ("QB", "QB"), "rb": ("RB", "RB"), "fb": ("RB", "FB"), "wr1": ("WR", "WR"), "wr2": ("WR", "WR"),
        "wr3": ("WR", "WR"), "wr": ("WR", "WR"), "te": ("TE", "TE"),
        "lt": ("OL", "LT"), "lg": ("OL", "LG"), "c": ("OL", "C"), "rg": ("OL", "RG"), "rt": ("OL", "RT"),
        "lde": ("DL", "DE"), "rde": ("DL", "DE"), "ldt": ("DL", "DT"), "rdt": ("DL", "DT"), "nt": ("DL", "NT"),
        "de": ("DL", "DE"), "dt": ("DL", "DT"),
        "wlb": ("LB", "LB"), "mlb": ("LB", "LB"), "slb": ("LB", "LB"), "lilb": ("LB", "LB"), "rilb": ("LB", "LB"),
        "lolb": ("LB", "OLB"), "rolb": ("LB", "OLB"), "olb": ("LB", "OLB"), "ilb": ("LB", "LB"), "lb": ("LB", "LB"),
        "lcb": ("DB", "CB"), "rcb": ("DB", "CB"), "cb": ("DB", "CB"), "nb": ("DB", "NB"), "ss": ("DB", "S"),
        "fs": ("DB", "S"), "s": ("DB", "S"),
        "pk": ("ST", "K"), "p": ("ST", "P"), "ls": ("ST", "LS")}
GROUPS = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "ST"]
GROUP_NAME = {"QB": "Quarterbacks", "RB": "Running backs", "WR": "Wide receivers", "TE": "Tight ends",
              "OL": "Offensive line", "DL": "Defensive line", "LB": "Linebackers", "DB": "Secondary",
              "ST": "Special teams"}
UNIT_OF = {"QB": "off", "RB": "off", "WR": "off", "TE": "off", "OL": "off", "DL": "def", "LB": "def", "DB": "def",
           "ST": "st"}
STATS = ["pass_yds", "pass_td", "rush_yds", "rec", "rec_yds", "td"]
LABELS = {"pass_yds": "Pass yds", "pass_td": "Pass TD", "rush_yds": "Rush yds", "rec": "Rec", "rec_yds": "Rec yds",
          "td": "TD", "gp": "GP"}
OUT_STATUS = ("out", "injured reserve", "ir", "pup", "nfi", "suspend", "doubtful", "reserve")


def vk(s):
    """nflverse name key: letters only, suffixes dropped (matches nfl_verse.nk)."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def shrink(vals, prior, dec, k):
    """Decayed average of vals (oldest first), pulled toward prior with k pseudo-games."""
    if not vals:
        return prior
    n = len(vals)
    w = [dec ** (n - 1 - i) for i in range(n)]
    m = sum(v * wi for v, wi in zip(vals, w)) / sum(w)
    if prior is None or k <= 0:
        return m
    ne = sum(w)
    return (ne * m + k * prior) / (ne + k)


def _r(v, d=1):
    return None if v is None else round(v, d)


def strip(o):
    """Drop empty fields (None, {}, []) from player rows: the page treats a missing field as empty."""
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if v not in (None, {}, [])}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o


def save_depth(lane, out):
    for t in out["teams"].values():
        t["players"] = [strip(p) for p in t["players"]]
        for p in t["players"]:
            if p.get("grp") == p.get("pos"):
                p.pop("grp")
    lane.save("depth.json", out)


def age_h(doc):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(doc["generated"])).total_seconds() / 3600
    except Exception:
        return 1e9


# ── nflverse snap counts ───────────────────────────────────────────────
def snap_csv(yr, local=None):
    """Rows of nflverse snap_counts_{yr}.csv (regular season and playoffs), or None."""
    if local:
        try:
            return list(csv.DictReader(open(local, encoding="utf-8")))
        except Exception:
            pass
    for i in range(3):
        try:
            r = requests.get(f"{NFLVERSE}snap_counts/snap_counts_{yr}.csv", timeout=90)
            if r.status_code == 200:
                return list(csv.DictReader(io.StringIO(r.content.decode("utf-8", "replace"))))
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return None


def snap_series(rows):
    """{(team, key): [(week, off, def, st)]} and {(team, week): offensive snaps} from snap rows."""
    by, plays = defaultdict(list), defaultdict(float)
    for r in rows or []:
        if r.get("game_type") not in ("REG", "WC", "DIV", "CON", "SB"):
            continue
        wk, tm = int(r["week"]), r["team"]
        f = lambda k: float(r.get(k) or 0)
        by[(tm, vk(r["player"]))].append((wk, f("offense_pct"), f("defense_pct"), f("st_pct"), r.get("position") or ""))
        plays[(tm, wk)] = max(plays[(tm, wk)], f("offense_snaps"))
    for v in by.values():
        v.sort()
    return by, plays


def unit_vals(series, unit):
    i = {"off": 1, "def": 2, "st": 3}[unit]
    return [x[i] for x in series if x[i] > 0]


def prior_snaps(lane, season):
    """Last season's mean snap share per (team, key) and per key, cached once in depth_prior.json."""
    pri = lane.load("depth_prior.json", None) or {}
    if pri.get("season") == season - 1 and pri.get("snap"):
        return pri
    rows = snap_csv(season - 1)
    if not rows:
        return pri if pri.get("snap") else {"season": None, "snap": {}}
    by, _ = snap_series(rows)
    out = {}
    for (tm, key), ser in by.items():
        d = out.setdefault(key, {"n": 0, "off": [], "def": [], "st": []})
        d["n"] += len(ser)
        for u in ("off", "def", "st"):
            d[u] += unit_vals(ser, u)
    snap = {k: [v["n"]] + [_r(sum(v[u]) / len(v[u]), 3) if v[u] else None for u in ("off", "def", "st")] for k, v in out.items()}
    pri = {"season": season - 1, "snap": snap}
    lane.save("depth_prior.json", pri)
    return pri


def proj_snap(vals, prior, p=None):
    p = p or SNAP_P
    return shrink(vals, prior, p["dec"], p["k"])


# ── box-score statistics ─────────────────────────────────────────────
def td_of(g):
    return (g.get("rush_td") or 0) + (g.get("rec_td") or 0)


def proj_td(hist, season, week, p=None, kind="td"):
    """Touchdowns per game: this season's games before `week`, decayed, pulled toward last season's mean."""
    p = p or TD_P
    f = td_of if kind == "td" else (lambda g: g.get("pass_td") or 0)
    cur = [f(g) for g in hist if g["season"] == season and g["week"] < week]
    prev = [f(g) for g in hist if g["season"] == season - 1]
    prior = sum(prev) / len(prev) if len(prev) >= 4 else None
    if not cur and prior is None:
        return None
    return shrink(cur, prior, p["dec"], p["k"])


def per_game(gs, keys):
    if not gs:
        return {}
    out = {"gp": len(gs)}
    for k in keys:
        if k == "td":
            out[k] = _r(sum(td_of(g) for g in gs) / len(gs), 2)
        else:
            out[k] = _r(sum(g.get(k) or 0 for g in gs) / len(gs), 2 if k in ("pass_td", "rec") else 1)
    return out


def stat_keys_for(grp, gs):
    """Which stat columns mean something for a player: by position, plus anything he has done."""
    base = {"QB": ["pass_yds", "pass_td", "rush_yds", "td"], "RB": ["rush_yds", "rec", "rec_yds", "td"],
            "WR": ["rec", "rec_yds", "td"], "TE": ["rec", "rec_yds", "td"]}.get(grp, [])
    return base


def method_text(sport, bt):
    if sport == "nfl":
        s = ("Order and injury status come from ESPN's team depth charts. Usage is snap share: the share of the team's "
             "offensive, defensive or special-teams snaps a player is projected to play, from nflverse snap counts, a decayed "
             "average of this season's games (last season's share for a player with no snaps yet). Passing, rushing and "
             "receiving numbers are the NFL model's season projections per game (recent weeks weigh more, last season is the "
             "prior, the next opponent's defense adjusts them); touchdowns are his season average, since nothing tested beat "
             "it. Pace is offensive plays per game. A player "
             "ruled out has no projection. These are projections, not picks.")
    else:
        s = ("ESPN publishes no college depth charts, so the order here is usage: each team's quarterbacks, backs, "
             "receivers and tight ends (positions from ESPN's roster) ranked by their projected share of the team's passes, "
             "carries or catches, a decayed average of this season. Yards and catches are the college model's projections "
             "per game, touchdowns the season average. College box scores carry no snap counts, so usage is a share of "
             "touches, not snaps. These are projections, not picks.")
    return s + " " + bt_text(bt)


def _g(v):
    return f"{v:,.3f}".rstrip("0").rstrip(".") if v < 10 else f"{v:,.1f}"


def bt_text(bt):
    """Plain sentences per tested quantity, honest where the projection does not beat the baseline."""
    if not bt or not bt.get("rows"):
        return "Backtest: not run yet."
    parts = []
    for r in bt["rows"]:
        m, a, l3 = r["mae"], r["avg"], r["l3"]
        best = min(a, l3)
        v = "better than both" if m < best * 0.995 else "level with the better one" if m <= best * 1.005 else \
            "worse than the season average" if m > a else "worse than the last 3"
        t = f"{r['k']}, average miss {_g(m)} vs {_g(a)} season average and {_g(l3)} last 3 ({v}"
        if r.get("rmse") is not None and r.get("rmse_avg"):
            rb = min(r["rmse_avg"], r["rmse_l3"])
            t += f"; by squared error {_g(r['rmse'])} vs {_g(rb)}, " + ("better" if r["rmse"] < rb * 0.995 else "level" if r["rmse"] <= rb * 1.005 else "worse")
        parts.append(t + f", {r['n']:,} games)")
    return f"Backtest on {bt.get('window', 'past games')}, each game projected only from the games before it: " + "; ".join(parts) + "."


# ── NFL ──────────────────────────────────────────────────────────────
def nfl_teams():
    d = espn_get("football/nfl/teams") or {}
    out = []
    for t in (((d.get("sports") or [{}])[0].get("leagues") or [{}])[0].get("teams") or []):
        t = t.get("team") or {}
        if t.get("id") and t.get("abbreviation"):
            out.append({"id": t["id"], "abbr": t["abbreviation"], "name": t.get("displayName"), "logo": (t.get("logos") or [{}])[0].get("href")})
    return out


def nfl_chart(tid):
    for i in range(2):
        try:
            r = requests.get(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{tid}/depthcharts",
                             headers=UA, timeout=20)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1)
    return None


def chart_players(chart):
    """ESPN depth chart -> [{id, n, grp, slot, rank, inj}] in depth order, one entry per player (his best slot)."""
    seen, out = set(), []
    order = []
    for f in (chart or {}).get("depthchart") or []:
        for sk, pos in (f.get("positions") or {}).items():
            if sk not in SLOT:
                continue
            for rk, a in enumerate(pos.get("athletes") or []):
                order.append((rk, GROUPS.index(SLOT[sk][0]), sk, a))
    order.sort(key=lambda x: (x[0], x[1]))
    for rk, _, sk, a in order:
        pid = str(a.get("id") or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        inj = [str(i.get("status") or "") for i in a.get("injuries") or [] if i.get("status")]
        out.append({"id": pid, "n": a.get("displayName") or "", "grp": SLOT[sk][0], "slot": SLOT[sk][1], "sk": sk,
                    "rank": rk, "inj": inj[0] if inj else None})
    return out


def label_roles(players):
    """Depth labels: QB1 QB2, RB1, WR1 WR2 WR3 WR4, TE1; line and defense by slot (LT, LT2, CB, CB2...)."""
    cnt = defaultdict(int)
    for p in sorted(players, key=lambda p: (GROUPS.index(p["grp"]), p["rank"])):
        if p["grp"] in ("QB", "RB", "WR", "TE"):
            lab = p["slot"] if p["slot"] == "FB" else p["grp"]
            cnt[lab] += 1
            p["role"] = f"{lab}{cnt[lab]}"
        else:
            p["role"] = p["slot"] + ("" if p["rank"] == 0 else str(p["rank"] + 1))
        if p["grp"] in ("QB", "RB", "WR", "TE"):
            n, st = cnt[p["role"].rstrip("0123456789")], {"WR": 3}.get(p["grp"], 1)
            p["tier"] = "Starter" if n <= st else "Rotation" if n <= st + (2 if p["grp"] == "WR" else 1) else "Bench"
        else:
            p["tier"] = "Starter" if p["rank"] == 0 else "Rotation" if p["rank"] == 1 else "Bench"
    return players


def is_out(s):
    s = (s or "").lower()
    return any(x in s for x in OUT_STATUS)


def build_nfl(lane, slate, force=False):
    import nfl_model as M
    old = lane.load("depth.json", None)
    if old and not force and old.get("v") == DEPTH_VER and age_h(old) < MAX_AGE_H:
        print(f"  depth: fresh ({age_h(old):.1f}h old), kept")
        return old
    season = int(slate.get("season") or datetime.now().year)
    teams = nfl_teams()
    if not teams:
        print("  depth: ESPN team list unavailable, kept the last depth.json")
        return old
    with ThreadPoolExecutor(8) as ex:
        charts = dict(zip([t["id"] for t in teams], ex.map(nfl_chart, [t["id"] for t in teams])))
    snaps_rows = snap_csv(season)
    by_snap, plays = snap_series(snaps_rows)
    pri = prior_snaps(lane, season)
    pg = lane.load("player_games.json", {}) or {}
    rows = pg.get("rows") or []
    by = M._games_by_player(rows)
    allowed = M._team_allowed(rows)
    lgc = {}
    last_wk = defaultdict(int)
    for r in rows:
        if r["season"] == season:
            last_wk[r["team"]] = max(last_wk[r["team"]], r["week"])
    nxt = {}
    for g in (slate.get("games") or []) + (slate.get("next_games") or []):
        if g.get("state") == "pre":
            for t, o in ((g["away"], g["home"]), (g["home"], g["away"])):
                nxt.setdefault(t, (g.get("week"), o))
    bt = lane.load("depth_backtest.json", None)
    out = {"sport": "nfl", "v": DEPTH_VER, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "season": season, "unit": "snap%", "use_label": "Snap share", "stats": STATS, "labels": LABELS,
           "groups": GROUPS, "group_names": GROUP_NAME, "pace_label": "Plays per game",
           "method": method_text("nfl", bt), "backtest": bt or {}, "teams": {}}
    n_pl = n_proj = 0
    for t in teams:
        ch = charts.get(t["id"])
        players = label_roles(chart_players(ch))
        if not players:
            continue
        ab, vt = t["abbr"], VERSE_TEAM.get(t["abbr"], t["abbr"])
        wk, opp = nxt.get(ab, (last_wk.get(ab, 0) + 1, None))
        wk = wk or last_wk.get(ab, 0) + 1
        tp = sorted((w, v) for (tm, w), v in plays.items() if tm == vt)
        pace = _r(shrink([v for _, v in tp], None, SNAP_P["dec"] ** 0.5, 0)) if tp else None
        res = []
        for p in players:
            unit = UNIT_OF[p["grp"]]
            ser = by_snap.get((vt, vk(p["n"])), [])
            vals = unit_vals(ser, unit)
            pr = (pri.get("snap") or {}).get(vk(p["n"]))
            prior = pr[1 + ("off", "def", "st").index(unit)] if pr and pr[0] >= 4 else None
            out_now = is_out(p["inj"])
            gs = by.get(p["id"], [])
            cur = [g for g in gs if g["season"] == season]
            prev = [g for g in gs if g["season"] == season - 1]
            keys = stat_keys_for(p["grp"], gs)
            proj = {}
            if not out_now and keys:
                for s in keys:
                    if s in M.STATS:
                        v, _ = M.project(gs, s, season, wk, opp, allowed, M.P, lgc)
                    elif s == "td":
                        v = proj_td(gs, season, wk) if (cur or len(prev) >= 4) else None
                    else:
                        v = proj_td(gs, season, wk, kind="pass") if (cur or len(prev) >= 4) else None
                    if v is not None:
                        proj[s] = _r(v, 2 if s in ("td", "pass_td", "rec") else 1)
            use = None if out_now else proj_snap(vals, prior)
            if p["grp"] == "QB" and p["role"] != "QB1" and (use or 0) < 0.5:
                proj = {}       # a backup quarterback's per-game line would read as if he starts: none until he does
            now = per_game(cur, keys)
            if vals:
                now["use"] = _r(sum(vals) / len(vals) * 100, 0)
                now.setdefault("gp", len(vals))
            last = per_game(prev, keys)
            if prior is not None:
                last["use"] = _r(prior * 100, 0)
                last.setdefault("gp", pr[0])
            tag = []
            if p["inj"]:
                tag.append(p["inj"])
            if not cur and not vals and not out_now and p["grp"] in ("QB", "RB", "WR", "TE") and p["rank"] == 0:
                tag.append("no snaps yet")
            row = {"id": p["id"], "n": p["n"], "pos": p["slot"], "grp": p["grp"], "role": p["role"],
                   "tier": "Out" if out_now else p["tier"], "tag": " · ".join(tag) or None,
                   "use": _r(use * 100, 0) if use is not None else None, "proj": proj, "now": now, "last": last}
            if p["inj"] and not out_now:
                row["q"] = True
            res.append(row)
            n_pl += 1
            n_proj += bool(proj)
        out["teams"][ab] = {"name": t["name"], "logo": t.get("logo"), "pace": pace,
                            "next": {"wk": wk, "opp": opp} if opp else None, "players": res}
    if not out["teams"]:
        print("  depth: no depth charts read, kept the last depth.json")
        return old
    save_depth(lane, out)
    print(f"  depth: {len(out['teams'])} teams, {n_pl} players, {n_proj} with projections, "
          f"snap counts {'yes' if snaps_rows else 'none'}")
    return out


# ── college football ─────────────────────────────────────────────────
CFB_POS = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}
CFB_STATS = ["pass_yds", "rush_yds", "rec", "rec_yds", "td"]
CFB_VOL = {"QB": "att", "RB": "rush_att", "WR": "rec", "TE": "rec"}
CFB_SHARE_P = {"dec": 0.4}     # tuned on 2026 weeks 4-6 (grid .3 to 1), judged on 7+: tools/depth_backtest.py cfb --tune (11/2)
ROSTER_AGE_H = 24 * 7


def cfb_roster(abbr, tid=None):
    d = espn_get(f"football/college-football/teams/{tid or abbr}/roster", tries=2) or {}
    out = {}
    for g in d.get("athletes") or []:
        for a in g.get("items") or []:
            pos = ((a.get("position") or {}).get("abbreviation") or "").upper()
            if pos in CFB_POS and a.get("id"):
                out[str(a["id"])] = pos
    return abbr, out, (d.get("team") or {}).get("displayName"), ((d.get("team") or {}).get("logo"))


def cfb_rosters(lane, teams):
    cache = lane.load("rosters.json", None) or {}
    try:
        fresh = (datetime.now(timezone.utc) - datetime.fromisoformat(cache.get("at"))).total_seconds() / 3600 < ROSTER_AGE_H
    except Exception:
        fresh = False
    have = cache.get("teams") or {}
    todo = [t for t in teams if not fresh or t not in have]
    if todo:
        tl = espn_get("football/college-football/teams", "limit=1000") or {}
        ids = {(t.get("team") or {}).get("abbreviation"): (t.get("team") or {}).get("id")
               for t in (((tl.get("sports") or [{}])[0].get("leagues") or [{}])[0].get("teams") or [])}
        with ThreadPoolExecutor(8) as ex:
            for ab, pos, nm, logo in ex.map(lambda a: cfb_roster(a, ids.get(a)), todo):
                if pos:
                    have[ab] = {"pos": pos, "name": nm, "logo": logo}
        cache = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds") if (not fresh or not cache.get("at")) else cache["at"],
                 "teams": have}
        lane.save("rosters.json", cache)
    return have


def team_volume(rows):
    """{(team, week): {att, rush_att, rec}} from box rows."""
    tv = defaultdict(lambda: defaultdict(float))
    for r in rows:
        for k in ("att", "rush_att", "rec"):
            tv[(r["team"], r["week"])][k] += r.get(k) or 0
    return tv


def share_series(gs, tv, vol):
    """A player's share of his team's volume in each of his games (oldest first)."""
    out = []
    for g in gs:
        t = tv.get((g["team"], g["week"]), {}).get(vol) or 0
        if t > 0:
            out.append((g.get(vol) or 0) / t)
    return out


def team_weeks(tv):
    out = defaultdict(list)
    for (t, w) in tv:
        out[t].append(w)
    return {t: sorted(ws) for t, ws in out.items()}


def share_all(gs, tv, vol, weeks, before=99):
    """A player's share of his team's volume in every team game from his first through `before`
    (exclusive), 0 in a game he has no box line, oldest first; and how many of those he appeared in."""
    if not gs:
        return [], 0
    team, first = gs[-1]["team"], gs[0]["week"]
    mine = {g["week"]: g.get(vol) or 0 for g in gs if g["team"] == team}
    out, n = [], 0
    for w in weeks.get(team, []):
        if w < first or w >= before:
            continue
        t = tv.get((team, w), {}).get(vol) or 0
        if t > 0:
            out.append(mine.get(w, 0) / t)
            n += w in mine
    return out, n


def guess_pos(gs):
    att = sum(g.get("att") or 0 for g in gs)
    car = sum(g.get("rush_att") or 0 for g in gs)
    rec = sum(g.get("rec") or 0 for g in gs)
    if att >= max(car, rec) and att > 0:
        return "QB"
    return "RB" if car > rec else "WR"


def build_cfb(lane, slate, force=False):
    import cfb_players as CP
    import nfl_model as N
    old = lane.load("depth.json", None)
    if old and not force and old.get("v") == DEPTH_VER and age_h(old) < MAX_AGE_H:
        print(f"  depth: fresh ({age_h(old):.1f}h old), kept")
        return old
    pg = lane.load("player_games.json", {}) or {}
    rows = pg.get("rows") or []
    if not rows:
        return old
    season = max(r["season"] for r in rows)
    rows = [r for r in rows if r["season"] == season]
    games_of = defaultdict(set)
    for r in rows:
        games_of[r["team"]].add(r["gid"])
    teams = sorted(t for t, g in games_of.items() if len(g) >= 4)      # FBS teams (FCS opponents appear once or twice)
    ros = cfb_rosters(lane, teams)
    by = N._games_by_player(rows)
    allowed = N._team_allowed(rows)
    tv = team_volume(rows)
    tweeks = team_weeks(tv)
    lgc = {}
    last_wk = defaultdict(int)
    for r in rows:
        last_wk[r["team"]] = max(last_wk[r["team"]], r["week"])
    nxt = {}
    names = {}
    for g in slate.get("games") or []:
        names[g["home"]] = (g.get("home_name"), g.get("home_logo"))
        names[g["away"]] = (g.get("away_name"), g.get("away_logo"))
        if g.get("state") == "pre":
            for t, o in ((g["away"], g["home"]), (g["home"], g["away"])):
                nxt.setdefault(t, (g.get("week"), o))
    bt = lane.load("depth_backtest.json", None)
    out = {"sport": "cfb", "v": DEPTH_VER, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "season": season, "unit": "use%", "use_label": "Usage share", "stats": CFB_STATS, "labels": LABELS,
           "groups": ["QB", "RB", "WR", "TE"], "group_names": GROUP_NAME, "pace_label": "Plays per game",
           "method": method_text("cfb", bt), "backtest": bt or {}, "teams": {}}
    by_team = defaultdict(list)
    for pid, gs in by.items():
        last_team = gs[-1]["team"]
        if last_team in teams:
            by_team[last_team].append((pid, gs))
    n_pl = 0
    for ab in teams:
        r_ = ros.get(ab) or {}
        posmap = r_.get("pos") or {}
        wk, opp = nxt.get(ab, (last_wk[ab] + 1, None))
        wk = wk or last_wk[ab] + 1
        tw = sorted(w for (t, w) in tv if t == ab)
        pace = _r(sum(tv[(ab, w)]["att"] + tv[(ab, w)]["rush_att"] for w in tw) / len(tw)) if tw else None
        cands = []
        for pid, gs in by_team[ab]:
            pos = CFB_POS.get(posmap.get(pid) or "") or guess_pos(gs)
            vol = CFB_VOL[pos]
            sh, _ = share_all(gs, tv, vol, tweeks)
            if not sh or max(sh) <= 0:
                continue
            use = shrink(sh, None, CFB_SHARE_P["dec"], 0)
            recent = gs[-1]["week"] >= last_wk[ab] - 2      # played in one of the team's last three weeks
            cands.append((pos, use, pid, gs, recent, sh))
        res = []
        for pos in ("QB", "RB", "WR", "TE"):
            grp = sorted([c for c in cands if c[0] == pos], key=lambda c: -c[1])
            keep = grp[: {"QB": 3, "RB": 4, "WR": 7, "TE": 3}[pos]]
            for i, (pos_, use, pid, gs, recent, sh) in enumerate(keep):
                keys = {"QB": ["pass_yds", "rush_yds", "td"], "RB": ["rush_yds", "rec", "rec_yds", "td"]}.get(pos, ["rec", "rec_yds", "td"])
                proj = {}
                for s in keys:
                    if s in CP.STATS:
                        v, _ = CP.project(gs, s, season, wk, opp, allowed, CP.P, lgc)
                    else:
                        v = proj_td(gs, season, wk) if len(gs) >= 2 else None
                    if v is not None:
                        proj[s] = _r(v, 2 if s in ("td", "rec") else 1)
                starters = {"WR": 3}.get(pos, 1)
                tier = "Starter" if i < starters and use >= {"QB": 0.4, "RB": 0.25, "WR": 0.1, "TE": 0.05}[pos] else \
                    "Rotation" if use >= 0.08 else "Bench"
                tag = None if recent else "not in the last three games"
                now = per_game(gs, keys)
                now["use"] = _r(sum(sh) / len(sh) * 100, 0)
                res.append({"id": pid, "n": gs[-1]["name"], "pos": pos, "grp": pos, "role": f"{pos}{i + 1}", "tier": tier,
                            "tag": tag, "use": _r(use * 100, 0), "proj": proj, "now": now, "last": {}})
                n_pl += 1
        nm, logo = names.get(ab, (None, None))
        out["teams"][ab] = {"name": nm or r_.get("name") or ab, "logo": logo or r_.get("logo"), "pace": pace,
                            "next": {"wk": wk, "opp": opp} if opp else None, "players": res}
    save_depth(lane, out)
    print(f"  depth: {len(out['teams'])} teams, {n_pl} players")
    return out


def build(key, lane=None, slate=None, force=False):
    lane = lane or Lane(key)
    slate = slate if slate is not None else (lane.load("slate.json", {}) or {})
    try:
        return (build_nfl if key == "nfl" else build_cfb)(lane, slate, force)
    except Exception as e:      # fail-soft: the last depth.json stays
        import traceback
        traceback.print_exc()
        print(f"  depth: {str(e)[:160]}")
        return None


if __name__ == "__main__":
    k = (sys.argv[1:] or ["nfl"])[0]
    build(k, force="--force" in sys.argv)
