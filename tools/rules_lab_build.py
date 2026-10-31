#!/usr/bin/env python3
"""
rules_lab_build.py - the history behind the Rules lab (scorecard.html#lab). Dev only.

Every priced Onyx line we have history for, open and close, with the model's chance
and how it finished, written compactly to data/rules_lab.json. The page applies a rule
(sport, market, side, price band, model edge) to these rows in the browser, so anyone
can test a rule of thumb against real Onyx prices in seasons it was never fitted on.

    python3 tools/rules_lab_build.py

Sources (bt/ is local, from tools/onyx_lines_pull.py; not committed):
  bt/nfl_game.json, bt/nfl_lines.json, bt/nfl_td.json, bt/cfb_lines.json, bt/nhl_lines.json,
  bt/tennis_atp_lines.json (+ bt/tennis_results_full.json)
Rows come from tools/sports_backtest.py (walk-forward: every chance is priced only from
results before that game), which also counts zero-touch NFL players as action.

Row: [sport, market, t ("o" open / "c" close), window (0 earlier / 1 later), date,
      p (model chance of side A, or null), line, priceA, priceB (null when one-sided), y (1 = side A won)]
Side A is the over, the home team (spread, moneyline) or "yes" (touchdown props).
"""
import json, os, sys
from collections import Counter
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
os.chdir(ROOT)
import sports_backtest as SB           # noqa: E402
import sports_lab as L                 # noqa: E402
from sports_common import Lane, nk     # noqa: E402

# each sport's periods: (first day, name). A rule is judged period by period; the splits
# match the backtests (NBA tunes on Oct-Jan, tests Feb-Apr; NHL tunes before Jan 15).
WINDOWS = {"nba": [("0000", "2024-25 season"), ("2025-08-01", "Oct 2025 to Jan 2026"), ("2026-02-01", "Feb to Jun 2026"),
                   ("2026-08-01", "2026-27 season")],
           "nfl": [("0000", "2024 season"), ("2025-03-01", "2025 season"), ("2026-03-01", "2026 season")],
           "cfb": [("0000", "2025 season"), ("2026-03-01", "2026 season")],
           "nhl": [("0000", "2025-26 to Jan 14"), ("2026-01-15", "Jan 15, 2026 on")],
           "tennis": [("0000", "2025"), ("2026-01-01", "2026")],
           "mlb": [("0000", "2025 season"), ("2026-01-01", "2026 season")]}


def win(sport, d):
    return max(i for i, (a, _) in enumerate(WINDOWS[sport]) if d >= a)


def row(sport, r, mkt=None):
    p = r.get("p")
    return [sport, mkt or r["mkt"], r["when"], win(sport, r["date"]), r["date"], None if p is None else round(p, 3),
            r.get("line"), r["over"], r["under"], r["y"]]


def td_rows():
    """NFL anytime / first TD yes prices, graded from the box score and nflverse snaps
    (a player with snaps and no box line scored no touchdown; no snaps = void)."""
    lane = Lane("nfl")
    rows = (lane.load("player_games.json", {}) or {}).get("rows") or []
    res = (lane.load("results.json", {}) or {}).get("games") or []
    verse = lane.load("nflverse.json", {}) or {}
    import nfl_model as M
    snaps = {(s_, w_, t_, n_) for yr, xv in (verse.get("seasons") or {}).items() for s_, w_, t_, n_, pct in xv.get("snaps") or [] if pct}
    tm = SB.team_map("nfl")
    by_day = {}
    for g in res:
        by_day.setdefault(g["date"], []).append(g)
    box = {}
    for r in rows:
        box.setdefault(r["gid"], {})[nk(r["name"])] = r
    team_of = {}
    for r in sorted(rows, key=lambda r: r["date"]):
        team_of[nk(r["name"])] = r["team"]
    out = []
    for fid, x in json.load(open("bt/nfl_td.json")).items():
        h, a = tm.get(nk(x["home"])), tm.get(nk(x["away"]))
        d0 = (x["start"] or "")[:10]
        g = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
            g = next((y for y in by_day.get(dd, []) if y["home"] == h and y["away"] == a), None) or g
        if not g or g["id"] not in box:
            continue
        b = box[g["id"]]
        wk = next(iter(b.values()))
        for name, mk in (x.get("props") or {}).items():
            r = b.get(nk(name))
            if r:
                td = (r.get("rush_td") or 0) + (r.get("rec_td") or 0)
            else:
                t = team_of.get(nk(name))
                if not t or (wk["season"], wk["week"], M.VERSE_TEAM.get(t, t), M._vk(name)) not in snaps:
                    continue
                td = 0
            for src, m in (("anytime_touchdown_scorer", "anytime_td"), ("first_touchdown_scorer", "first_td")):
                v = mk.get(src)
                if not v:
                    continue
                for when in ("o", "c"):
                    pr = v[when][1]
                    if pr is None:
                        continue
                    y = int(td > 0) if m == "anytime_td" else None
                    if y is None:
                        continue      # first-TD outcomes need the scoring order: not graded here
                    out.append(["nfl", m, when, win("nfl", g["date"]), g["date"], None, 0.5, pr, None, y])
    return out


def _et_day(iso):
    from datetime import datetime, timedelta as td
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - td(hours=8)).date().isoformat()


def onyx_game_rows(sport, path, names=None):
    """Moneyline, spread / run line and game total from a tools/onyx_lines_pull.py file,
    graded from the final score on the fixture. No model chance (p = null): these rows are
    for price and side rules."""
    if not os.path.exists(path):
        return []
    out = []
    MK = {"moneyline": "ml", "point_spread": "spread", "run_line": "spread", "puck_line": "spread",
          "total_points": "total", "total_runs": "total", "total_goals": "total"}
    for fid, x in json.load(open(path)).items():
        hs, as_ = x.get("hs"), x.get("as")
        if hs is None or as_ is None or not x.get("start"):
            continue
        d = _et_day(x["start"])
        m_, t_ = hs - as_, hs + as_
        for mk, sel in (x.get("game") or {}).items():
            m = MK.get(mk)
            if not m:
                continue
            for when in ("o", "c"):
                if m == "total":
                    if "over" not in sel or "under" not in sel:
                        continue
                    ln, pa = sel["over"][when]; pb = sel["under"][when][1]
                    if ln is None or not SB.sane(pa, pb) or t_ == ln:
                        continue
                    out.append([sport, m, when, win(sport, d), d, None, ln, pa, pb, int(t_ > ln)])
                    continue
                hk = x.get("home") if x.get("home") in sel else None
                ak = x.get("away") if x.get("away") in sel else None
                if not hk or not ak:
                    continue
                (ln, pa), pb = sel[hk][when], sel[ak][when][1]
                if not SB.sane(pa, pb):
                    continue
                if m == "ml":
                    if m_ == 0:
                        continue
                    out.append([sport, m, when, win(sport, d), d, None, None, pa, pb, int(m_ > 0)])
                elif ln is not None and m_ + ln != 0:
                    out.append([sport, m, when, win(sport, d), d, None, ln, pa, pb, int(m_ + ln > 0)])
    return out


def onyx_prop_rows(sport, path, stat_of, actual, skip=lambda d: False):
    """Player props from a tools/onyx_lines_pull.py file. actual(fid, game, name, stat) returns
    the player's number, None when he did not play (a void). No model chance."""
    if not os.path.exists(path):
        return []
    out = []
    for fid, x in json.load(open(path)).items():
        if not x.get("start"):
            continue
        d = _et_day(x["start"])
        if skip(d):
            continue
        for name, mk in (x.get("props") or {}).items():
            for src, v in mk.items():
                st = stat_of.get(src)
                if not st:
                    continue
                a = actual(fid, x, name, st)
                if a is None:
                    continue
                for when in ("o", "c"):
                    ln, pa, pb = v[when]
                    if st.endswith("_yes"):          # yes / no market: side A = yes
                        if pa is None:
                            continue
                        out.append([sport, st, when, win(sport, d), d, None, 0.5, pa, pb, int(a > 0)])
                        continue
                    if ln is None or not SB.sane(pa, pb) or a == ln:
                        continue
                    out.append([sport, st, when, win(sport, d), d, None, ln, pa, pb, int(a > ln)])
    return out


def nba_more_rows():
    """NBA game lines (2024-25 if Onyx has it, 2025-26, 2026-27 to date) and props the
    2025-26 model replay does not cover: threes all along, and every prop from 2026-27,
    graded from the box scores (bt/nba/box.json for 2025-26, data/nba/player_games.json
    for this season). A player with no minutes is a void."""
    out = []
    for f in ("bt/nba_2425_lines.json", "bt/nba_lines_full.json"):
        out += onyx_game_rows("nba", f)
    box = {}
    if os.path.exists("bt/nba/box.json"):
        for r in json.load(open("bt/nba/box.json")):
            fid, pid, name, pos, team, starter, mins, secs, pts, reb, ast, fg3 = r[:12]
            m = mins if mins is not None else (secs or 0) / 60.0
            if m and m > 0:
                box[(fid, nk(name))] = {"pts": pts or 0, "reb": reb or 0, "ast": ast or 0, "fg3": fg3 or 0}
    pg = json.load(open("data/nba/player_games.json")) if os.path.exists("data/nba/player_games.json") else {}
    for pid, rec in pg.items():
        if pid.startswith("_") or not isinstance(rec, dict):
            continue
        for g in rec.get("g") or []:
            if len(g) > 8 and g[4] and g[4] > 0:
                box[(g[1], nk(rec.get("n")))] = {"pts": g[5], "reb": g[6], "ast": g[7], "fg3": g[8]}
    act = lambda fid, x, name, st: (box.get((fid, nk(name))) or {}).get(st)
    STAT = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast", "player_threes": "fg3"}
    full = onyx_prop_rows("nba", "bt/nba_lines_full.json", STAT, act)
    # 2025-26 points / rebounds / assists come from the model replay (with its chance): keep threes only there
    out += [r for r in full if r[1] == "fg3" or r[4] >= "2026-08-01"]
    out += onyx_prop_rows("nba", "bt/nba_2425_lines.json", STAT, act)
    print(f"  nba game lines and extra props: {len(out)}")
    return out


def mlb_rows():
    """MLB game lines and props (home runs, strikeouts, hits, total bases), 2025 and 2026,
    graded from MLB Stats API box scores (bt/mlb_box.json: dev pull). A player not in the
    box (did not play) is a void."""
    if not os.path.exists("bt/mlb_box.json"):
        return []
    from datetime import datetime
    games = json.load(open("bt/mlb_box.json"))
    by = {}
    for g in games:
        by.setdefault((nk(g["home"]), nk(g["away"])), []).append(g)
    def match(x):
        c = by.get((nk(x.get("home")), nk(x.get("away")))) or []
        t = datetime.fromisoformat(x["start"].replace("Z", "+00:00")).timestamp()
        best = min(c, key=lambda g: abs(datetime.fromisoformat(g["start"].replace("Z", "+00:00")).timestamp() - t), default=None)
        if best and abs(datetime.fromisoformat(best["start"].replace("Z", "+00:00")).timestamp() - t) < 6 * 3600:
            return best
        return None
    cache = {}
    def act(fid, x, name, st):
        if fid not in cache:
            g = match(x)
            cache[fid] = {nk(n): v for n, v in (g or {}).get("players", {}).items()} if g else None
        pl = (cache[fid] or {}).get(nk(name))
        if not pl:
            return None
        if st == "k":
            return pl.get("k") if pl.get("gs") else None      # starters only: a reliever's K line is not this market
        if st == "hr_yes":
            return pl["hr"] if pl.get("pa") else None
        return pl.get(st) if pl.get("pa") else None
    out = []
    STAT = {"player_home_runs_yes_no": "hr_yes", "player_strikeouts": "k", "pitcher_strikeouts": "k",
            "player_hits": "h", "player_total_bases": "tb"}
    for f in ("bt/mlb_2025_lines.json", "bt/mlb_2026_lines.json"):
        out += onyx_game_rows("mlb", f)
        out += onyx_prop_rows("mlb", f, STAT, act)
    print(f"  mlb: {len(out)} priced samples")
    return out


def nba_rows(bt="bt/nba"):
    """NBA points, rebounds and assists (2025-26, bt/nba/ from the "NBA backtest data"
    workflow): the walk-forward nba_model projection for every priced player who suited
    up (a priced player who sat is a void, as Onyx grades it), open and close."""
    import nba_backtest as NB
    G, lines = NB.load(bt)
    prior = NB.build_prior(G, lines, "2025-08-01")
    mkt = json.load(open(os.path.join(bt, "lines.json")))
    for gid, g in mkt.items():
        NB.NAMEMAP[gid] = {nk(n): v for n, v in (g.get("props") or {}).items()}
    NB.SIM_ROSTER, NB.SIM_LINEUP = True, True          # as production sees the slate (v8)
    recs = NB.walk(G, lines, "2025-10-01", "2026-04-30", prior, mkt)
    out = []
    for which in ("o", "c"):
        for x in NB.market_rows(recs, "0000", "9999", which):
            d = x["r"]["d"]
            out.append(["nba", x["s"], which, win("nba", d), d, x["p_model"], x["line"], x["po"], x["pu"], int(x["over"])])
    print(f"  nba props: {len(out)} priced samples")
    return out


def main():
    import importlib
    R = []
    R += nba_rows()
    R += nba_more_rows()
    R += mlb_rows()
    R += onyx_game_rows("nfl", "bt/nfl_2024_lines.json")
    for key, f in (("nfl", "bt/nfl_game.json"), ("cfb", "bt/cfb_lines.json"), ("nhl", "bt/nhl_lines.json")):
        M = importlib.import_module({"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model"}[key])
        GP = M.GAME_P if key == "nfl" else M.P
        R += [row(key, r) for r in SB.team_samples(key, json.load(open(f)), M, GP)]
    R += [row("nfl", r) for r in SB.nfl_prop_samples(json.load(open("bt/nfl_lines.json")))]
    R += td_rows()
    R += [row("tennis", r) for r in SB.tennis_samples(["bt/tennis_atp_lines.json"])]
    # grouped and compact (phones load this): {sport: {market: {"o"|"c": [[w, p, line, a, b, y], ...]}}}
    G = {}
    for sp, mk, t, w, d, p, ln, pa, pb, y in R:
        G.setdefault(sp, {}).setdefault(mk, {}).setdefault(t, []).append([w, None if p is None else round(p, 2), ln, pa, pb, y])
    # one small index (data/rules_lab.json) and one file per sport (data/rules_lab/<sport>.json),
    # so a phone loads only the sport being tested
    os.makedirs("data/rules_lab", exist_ok=True)
    idx = {"built": date.today().isoformat(), "cols": ["w", "p", "line", "a", "b", "y"], "sports": {}}
    for sp, mk in G.items():
        json.dump(mk, open(f"data/rules_lab/{sp}.json", "w"), separators=(",", ":"))
        idx["sports"][sp] = {"names": [n for _, n in WINDOWS[sp]],
                             "periods": sorted({r[0] for t in mk.values() for rr in t.values() for r in rr}),
                             "markets": {m: sum(len(v) for v in t.values()) for m, t in mk.items()},
                             "kb": os.path.getsize(f"data/rules_lab/{sp}.json") // 1024}
    json.dump(idx, open("data/rules_lab.json", "w"), indent=1)
    print(len(R), "rows", Counter((r[0], r[1]) for r in R), {k: v["kb"] for k, v in idx["sports"].items()}, "KB")


if __name__ == "__main__":
    main()
