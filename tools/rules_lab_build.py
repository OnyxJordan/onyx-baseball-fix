#!/usr/bin/env python3
"""
rules_lab_build.py - the history behind the Rules lab (scorecard.html#lab). Dev only.

Every priced line we have history for, open and close, with the model's chance where a
model priced it, how it finished, and the game's context (the splits), written to
data/rules_lab.json (index) and data/rules_lab/<sport>.json. The page applies a rule
(sport, market, side, price band, model edge, splits) in the browser.

    python3 tools/rules_lab_build.py

Sources (bt/ is local, not committed):
  Onyx prices (tools/onyx_lines_pull.py): bt/nfl_game.json, bt/nfl_lines.json, bt/nfl_td.json,
    bt/cfb_lines.json, bt/cfb_props.json, bt/nhl_lines.json, bt/nhl_props.json,
    bt/tennis_atp_lines.json, bt/tennis_wta_lines.json, bt/nba_lines_full.json, bt/nba_threes_pra.json,
    bt/mlb_2025_lines.json, bt/mlb_2026_lines.json, bt/nba/ (the NBA backtest pull)
  Earlier seasons at market prices, before Onyx priced them (onyx_lines_pull.py with another
    book; research only, shown as "market prices, before Onyx", the book never named):
    bt/nfl_2024_mkt.json, bt/nba_2425_mkt.json, bt/mlb_2024_mkt.json, bt/nhl_2425_mkt.json,
    bt/cfb_2024_mkt.json
  Results: ESPN box scores and results (data/<sport>/), MLB Stats API boxes (bt/mlb_box*.json),
    NHL API boxes (bt/nhl_box.json), nflverse 2024 stats and snaps (bt/nfl24/)
Model chances come from tools/sports_backtest.py and tools/nba_backtest.py (walk-forward:
every chance priced only from results before that game; zero-touch NFL players count).

Row in the per-sport file: [period, p, line, priceA, priceB, y, ctx]
  side A is the over, the home team (spread, moneyline) or "yes"; y = 1 when side A won;
  ctx = [side A is home (1/0/null), night (1) / day (0), home time zone (0 E, 1 C, 2 M, 3 P),
         zones the away team crossed, home rest days, away rest days, month] (tools/rules_ctx.py)
"""
import csv, json, os, sys
from collections import Counter
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
os.chdir(ROOT)
import sports_backtest as SB           # noqa: E402
import rules_ctx as RC                 # noqa: E402
from sports_common import Lane, nk     # noqa: E402

MKT = " · market prices, before Onyx"
# each sport's periods: (first day, name, market-price period?). Splits match the backtests.
WINDOWS = {"nba": [("0000", "2024-25" + MKT, 1), ("0000", "2024-25 season", 0), ("2025-08-01", "Oct 2025 to Jan 2026", 0), ("2026-02-01", "Feb to Jun 2026", 0),
                   ("2026-08-01", "2026-27 season", 0)],
           "nfl": [("0000", "2024 season" + MKT, 1), ("2025-03-01", "2025 season", 0), ("2026-03-01", "2026 season", 0)],
           "cfb": [("0000", "2024 season" + MKT, 1), ("2025-03-01", "2025 season", 0), ("2026-03-01", "2026 season", 0)],
           "nhl": [("0000", "2024-25" + MKT, 1), ("2025-08-01", "2025-26 to Jan 14", 0), ("2026-01-15", "Jan 15 to Jun 2026", 0),
                   ("2026-08-01", "2026-27 season", 0)],
           "tennis": [("0000", "2025", 0), ("2026-01-01", "2026", 0)],
           "mlb": [("0000", "2024 season" + MKT, 1), ("2025-01-01", "2025 season", 0), ("2026-01-01", "2026 season", 0)]}
S = RC.Schedule()


def win(sport, d, market=False):
    """The period a game falls in: market-price rows (files named *_mkt.json, another book before
    Onyx priced the sport) get their own periods, Onyx rows the dated ones."""
    c = [i for i, w in enumerate(WINDOWS[sport]) if bool(w[2]) == bool(market) and d >= w[0]]
    return c[-1] if c else max(i for i, w in enumerate(WINDOWS[sport]) if d >= w[0])


def et_day(iso):
    return (datetime.fromisoformat(str(iso).replace("Z", "+00:00")) - timedelta(hours=8)).date().isoformat()


def R_(sport, mkt, when, d, p, line, a, b, y, ctx, market=False):
    return [sport, mkt, when, win(sport, d, market), d, None if p is None else round(p, 2), line, a, b, y, ctx]


def ctx(sport, home, away, start, d, a_home):
    return RC.ctx(sport, home, away, start or d + "T23:00:00Z", d, a_home, S)


def sample_row(sport, r):
    """A tools/sports_backtest.py sample (team sports and NFL props)."""
    if r["mkt"] in ("ml", "spread"):
        ah = 1
    elif r.get("team"):
        ah = int(r["team"] == r.get("ht"))
    else:
        ah = None
    c = ctx(sport, r.get("ht"), r.get("at"), r.get("start"), r["date"], ah) if r.get("ht") else None
    return R_(sport, r["mkt"], r["when"], r["date"], r.get("p"), r.get("line"), r["over"], r["under"], r["y"], c)


# ── schedules (rest days) ──────────────────────────────────────────────
def load_schedules():
    for sp in ("nfl", "cfb", "nhl"):
        for g in (Lane(sp).load("results.json", {}) or {}).get("games") or []:
            S.add(sp, g["home"], g["away"], g["date"])
    for f, sp in (("bt/nba/games.json", "nba"),):
        if os.path.exists(f):
            for g in json.load(open(f)).values():
                if g.get("start"):
                    S.add(sp, g["home"], g["away"], et_day(g["start"]))
    for f in ("bt/mlb_box_2024.json", "bt/mlb_box.json"):
        if os.path.exists(f):
            for g in json.load(open(f)):
                S.add("mlb", g["home"], g["away"], g["date"])
    if os.path.exists("bt/nhl_box.json"):
        for g in json.load(open("bt/nhl_box.json")):
            if g.get("start"):
                S.add("nhl", g["home"], g["away"], et_day(g["start"]))
    # every completed fixture in every lines pull, priced or not
    for sp, files in (("nba", ["bt/nba_lines_full.json", "bt/nba_2425_mkt.json"]), ("nfl", ["bt/nfl_2024_mkt.json"]),
                      ("nhl", ["bt/nhl_props.json", "bt/nhl_2425_mkt.json"]), ("cfb", ["bt/cfb_2024_mkt.json"])):
        for f in files:
            if os.path.exists(f):
                for x in json.load(open(f)).values():
                    if x.get("start"):
                        S.add(sp, x.get("home"), x.get("away"), et_day(x["start"]))


# ── generic Onyx-pull files: game lines and props ──────────────────────
GAME_MK = {"moneyline": "ml", "point_spread": "spread", "run_line": "spread", "puck_line": "spread",
           "total_points": "total", "total_runs": "total", "total_goals": "total"}


def game_rows(sport, path):
    """Moneyline, spread / run line / puck line and game total, graded from the final score."""
    if not os.path.exists(path):
        return []
    out, mkf = [], "_mkt" in path
    for fid, x in json.load(open(path)).items():
        hs, as_ = x.get("hs"), x.get("as")
        if hs is None or as_ is None or not x.get("start"):
            continue
        d = et_day(x["start"])
        m_, t_ = hs - as_, hs + as_
        for mk, sel in (x.get("game") or {}).items():
            m = GAME_MK.get(mk)
            if not m:
                continue
            for when in ("o", "c"):
                if m == "total":
                    if "over" not in sel or "under" not in sel:
                        continue
                    ln, pa = sel["over"][when]; pb = sel["under"][when][1]
                    if ln is None or not SB.sane(pa, pb) or t_ == ln:
                        continue
                    out.append(R_(sport, m, when, d, None, ln, pa, pb, int(t_ > ln), ctx(sport, x["home"], x["away"], x["start"], d, None), mkf))
                    continue
                hk = x.get("home") if x.get("home") in sel else None
                ak = x.get("away") if x.get("away") in sel else None
                if not hk or not ak:
                    continue
                (ln, pa), pb = sel[hk][when], sel[ak][when][1]
                if not SB.sane(pa, pb):
                    continue
                c = ctx(sport, x["home"], x["away"], x["start"], d, 1)
                if m == "ml":
                    if m_ != 0:
                        out.append(R_(sport, m, when, d, None, None, pa, pb, int(m_ > 0), c, mkf))
                elif ln is not None and m_ + ln != 0:
                    out.append(R_(sport, m, when, d, None, ln, pa, pb, int(m_ + ln > 0), c, mkf))
    return out


def prop_rows(sport, path, stat_of, actual, skip=lambda d: False):
    """Player props. actual(fid, game, name, stat) -> (number, player is home) or None (did not
    play: a void, as books grade it)."""
    if not os.path.exists(path):
        return []
    out, mkf = [], "_mkt" in path
    for fid, x in json.load(open(path)).items():
        if not x.get("start"):
            continue
        d = et_day(x["start"])
        if skip(d):
            continue
        for name, mk in (x.get("props") or {}).items():
            for src, v in mk.items():
                st = stat_of.get(src)
                if not st:
                    continue
                got = actual(fid, x, name, st)
                if got is None or got[0] is None:
                    continue
                a, home = got
                c = ctx(sport, x.get("home"), x.get("away"), x["start"], d, None if home is None else int(home))
                for when in ("o", "c"):
                    ln, pa, pb = v[when]
                    if st.endswith("_yes"):
                        if pa is not None:
                            out.append(R_(sport, st, when, d, None, 0.5, pa, pb, int(a > 0), c, mkf))
                        continue
                    if ln is None or not SB.sane(pa, pb) or a == ln:
                        continue
                    out.append(R_(sport, st, when, d, None, ln, pa, pb, int(a > ln), c, mkf))
    return out


# ── NBA ────────────────────────────────────────────────────────────────
def nba_rows(bt="bt/nba"):
    """Points, rebounds, assists 2025-26 with the walk-forward nba_model chance."""
    import nba_backtest as NB
    from nba_common import team_abbr
    G, lines = NB.load(bt)
    prior = NB.build_prior(G, lines, "2025-08-01")
    mkt = json.load(open(os.path.join(bt, "lines.json")))
    for gid, g in mkt.items():
        NB.NAMEMAP[gid] = {nk(n): v for n, v in (g.get("props") or {}).items()}
    NB.SIM_ROSTER, NB.SIM_LINEUP = True, True
    recs = NB.walk(G, lines, "2025-10-01", "2026-04-30", prior, mkt)
    starts = {g["id"]: g.get("start") for g in json.load(open(os.path.join(bt, "games.json"))).values()}
    team_of = {(gid, l["pid"]): l["team"] for gid, ls in lines.items() for l in ls}
    out = []
    for which in ("o", "c"):
        for x in NB.market_rows(recs, "0000", "9999", which):
            r = x["r"]; g = G[r["gid"]]; d = r["d"]
            tm = team_of.get((r["gid"], r["pid"]))
            c = ctx("nba", g["home"], g["away"], starts.get(r["gid"]), d, None if not tm else int(tm == g["home"]))
            out.append(R_("nba", x["s"], which, d, x["p_model"], x["line"], x["po"], x["pu"], int(x["over"]), c))
    print(f"  nba props (model replay): {len(out)}")
    return out


def nba_more_rows():
    """NBA game lines (2024-25 market, 2025-26, 2026-27) and props the replay does not cover:
    threes all along, everything 2026-27 and 2024-25, graded from the box scores."""
    from nba_common import team_abbr
    out = []
    for f in ("bt/nba_2425_mkt.json", "bt/nba_2425_lines.json", "bt/nba_lines_full.json"):
        out += game_rows("nba", f)
    box = {}
    if os.path.exists("bt/nba/box.json"):
        gh = {g["id"]: team_abbr(g["home"]) for g in json.load(open("bt/nba/games.json")).values()}
        for r in json.load(open("bt/nba/box.json")):
            fid, pid, name, pos, team, starter, mins, secs, pts, reb, ast, fg3 = r[:12]
            m = mins if mins is not None else (secs or 0) / 60.0
            if m and m > 0:
                box[(fid, nk(name))] = ({"pts": pts or 0, "reb": reb or 0, "ast": ast or 0, "fg3": fg3 or 0}, team_abbr(team) == gh.get(fid))
    pg = json.load(open("data/nba/player_games.json")) if os.path.exists("data/nba/player_games.json") else {}
    for pid, rec in pg.items():
        if pid.startswith("_") or not isinstance(rec, dict):
            continue
        for g in rec.get("g") or []:
            if len(g) > 8 and g[4] and g[4] > 0:
                box[(g[1], nk(rec.get("n")))] = ({"pts": g[5], "reb": g[6], "ast": g[7], "fg3": g[8]}, bool(g[3]))
    def act(fid, x, name, st):
        b = box.get((fid, nk(name)))
        if not b:
            return None
        s = b[0]
        if st in ("pra", "pr", "pa"):   # combos, should Onyx history for them appear (none for 2025-27 as of 11/1)
            parts = [s.get(k) for k in {"pra": ("pts", "reb", "ast"), "pr": ("pts", "reb"), "pa": ("pts", "ast")}[st]]
            return (None if None in parts else sum(parts), b[1])
        return (s.get(st), b[1])
    STAT = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast", "player_threes": "fg3", "player_made_threes": "fg3",
            "player_points_+_rebounds_+_assists": "pra", "player_points_+_rebounds": "pr", "player_points_+_assists": "pa"}
    full = prop_rows("nba", "bt/nba_lines_full.json", STAT, act)
    out += [r for r in full if r[1] == "fg3" or r[4] >= "2026-08-01"]   # 2025-26 pts / reb / ast: the replay rows
    out += prop_rows("nba", "bt/nba_2425_mkt.json", STAT, act)
    out += prop_rows("nba", "bt/nba_2425_lines.json", STAT, act)
    if os.path.exists("bt/nba_threes_pra.json"):   # made threes, 2025-26 on (points + rebounds + assists not graded yet)
        out += prop_rows("nba", "bt/nba_threes_pra.json", STAT, act)
    print(f"  nba game lines + extra props: {len(out)}")
    return out


def nba_period_rows():
    """NBA 1st-quarter and 1st-half totals and first basket (yes prices), graded from ESPN
    play-by-play (bt/nba_periods.json: points scored before 12:00 and 24:00 of game time, and the
    first player to score, free throws included), 2024-25 and 2025-26."""
    if not os.path.exists("bt/nba_periods.json"):
        return []
    from nba_common import team_abbr
    per = {(g["d"], tuple(g["teams"])): g for g in json.load(open("bt/nba_periods.json"))}
    out = []
    for f in ("bt/nba_2425_lines.json", "bt/nba_lines_full.json", "bt/nba_2425_mkt.json"):
        if not os.path.exists(f):
            continue
        mkf = "_mkt" in f
        for fid, x in json.load(open(f)).items():
            if not x.get("start"):
                continue
            d = et_day(x["start"])
            h, a = team_abbr(x.get("home")), team_abbr(x.get("away"))
            g = per.get((d, tuple(sorted([h or "", a or ""]))))
            if not g:
                continue
            c = ctx("nba", x["home"], x["away"], x["start"], d, None)
            for mk, key, name in (("1st_quarter_total_points", "q1", "q1_total"), ("1st_half_total_points", "h1", "h1_total")):
                sel = (x.get("game") or {}).get(mk) or {}
                if "over" not in sel or "under" not in sel:
                    continue
                for when in ("o", "c"):
                    ln, pa = sel["over"][when]; pb = sel["under"][when][1]
                    if ln is None or not SB.sane(pa, pb) or g[key] == ln:
                        continue
                    out.append(R_("nba", name, when, d, None, ln, pa, pb, int(g[key] > ln), c, mkf))
            first = nk(g.get("first") or "")
            if not first:
                continue
            for name, mk in (x.get("props") or {}).items():
                v = mk.get("first_basket_including_ft")
                if not v:
                    continue
                for when in ("o", "c"):
                    if v[when][1] is not None:
                        out.append(R_("nba", "first_basket", when, d, None, 0.5, v[when][1], None, int(nk(name) == first), c, mkf))
    print(f"  nba 1Q / 1H totals + first basket: {len(out)}")
    return out


def tennis_game_rows(path):
    """Tennis total games and game spread (side A = the first-listed player), graded from the
    results file (games won by each player). No model chance."""
    if not os.path.exists(path) or not os.path.exists("bt/tennis_results_full.json"):
        return []
    res = {}
    for m in json.load(open("bt/tennis_results_full.json")):
        res.setdefault((m["date"], frozenset((nk(m["w"]), nk(m["l"])))), m)
    out = []
    for fid, x in json.load(open(path)).items():
        if not x.get("start"):
            continue
        a, b = nk(x.get("home")), nk(x.get("away"))
        d0 = x["start"][:10]; m = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat(), (date.fromisoformat(d0) + timedelta(days=1)).isoformat()):
            m = res.get((dd, frozenset((a, b)))) or m
        if not m or m.get("games_w") is None:
            continue
        ga, gb = (m["games_w"], m["games_l"]) if nk(m["w"]) == a else (m["games_l"], m["games_w"])
        tot, mar = ga + gb, ga - gb
        for mk, sel in (x.get("game") or {}).items():
            for when in ("o", "c"):
                if mk == "total_games" and "over" in sel and "under" in sel:
                    ln, pa = sel["over"][when]; pb = sel["under"][when][1]
                    if ln is not None and SB.sane(pa, pb) and tot != ln:
                        out.append(R_("tennis", "total_games", when, m["date"], None, ln, pa, pb, int(tot > ln), None))
                elif mk == "game_spread":
                    ka = next((k for k in sel if nk(k) == a), None); kb = next((k for k in sel if nk(k) == b), None)
                    if ka and kb:
                        (ln, pa), pb = sel[ka][when], sel[kb][when][1]
                        if ln is not None and SB.sane(pa, pb) and mar + ln != 0:
                            out.append(R_("tennis", "game_spread", when, m["date"], None, ln, pa, pb, int(mar + ln > 0), None))
    print(f"  tennis games markets {path}: {len(out)}")
    return out


# ── MLB ────────────────────────────────────────────────────────────────
def mlb_rows():
    games = []
    for f in ("bt/mlb_box_2024.json", "bt/mlb_box.json"):
        if os.path.exists(f):
            games += json.load(open(f))
    if not games:
        return []
    by = {}
    for g in games:
        by.setdefault((nk(g["home"]), nk(g["away"])), []).append(g)
    ts = lambda iso: datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    cache = {}
    def match(fid, x):
        if fid not in cache:
            c = by.get((nk(x.get("home")), nk(x.get("away")))) or []
            t = ts(x["start"])
            best = min(c, key=lambda g: abs(ts(g["start"]) - t), default=None)
            cache[fid] = best if best and abs(ts(best["start"]) - t) < 6 * 3600 else None
        return cache[fid]
    def act(fid, x, name, st):
        g = match(fid, x)
        if not g:
            return None
        pl = {nk(n): v for n, v in (g.get("players") or {}).items()}.get(nk(name))
        if not pl:
            return None
        home = pl.get("side") == "home"
        if st == "k":
            return (pl.get("k"), home) if pl.get("gs") else None      # starters' strikeout lines only
        if not pl.get("pa"):
            return None
        return (pl["hr"] if st == "hr_yes" else pl.get(st), home)
    STAT = {"player_home_runs_yes_no": "hr_yes", "player_strikeouts": "k", "pitcher_strikeouts": "k",
            "player_hits": "h", "player_total_bases": "tb"}
    out = []
    for f in ("bt/mlb_2024_mkt.json", "bt/mlb_2025_lines.json", "bt/mlb_2026_lines.json"):
        out += game_rows("mlb", f)
        out += prop_rows("mlb", f, STAT, act)
    print(f"  mlb: {len(out)}")
    return out


# ── NHL props ──────────────────────────────────────────────────────────
def nhl_more_rows():
    out = game_rows("nhl", "bt/nhl_2425_mkt.json")
    if not os.path.exists("bt/nhl_box.json"):
        return out
    games = json.load(open("bt/nhl_box.json"))
    by = {}
    for g in games:
        hk, _ = RC.team("nhl", g["home"]); ak, _ = RC.team("nhl", g["away"])
        if g.get("start"):
            by[(hk, ak, et_day(g["start"]))] = g
    def act(fid, x, name, st):
        hk, _ = RC.team("nhl", x.get("home")); ak, _ = RC.team("nhl", x.get("away"))
        g = by.get((hk, ak, et_day(x["start"])))
        if not g:
            return None
        pls = g.get("players") or {}
        last = nk(name).split()[-1] if nk(name) else ""
        cand = [v for n, v in pls.items() if nk(n) == nk(name)] or \
               [v for n, v in pls.items() if nk(n).split()[-1:] == [last] and nk(n)[:1] == nk(name)[:1]]
        if len(cand) != 1:
            return None
        v = cand[0]
        return (v[{"pts": "pts", "g_yes": "g", "sog": "sog", "ast": "a"}[st]], v.get("side") == "home")
    STAT = {"player_points": "pts", "anytime_goal_scorer": "g_yes", "player_shots_on_goal": "sog", "player_assists": "ast",
            "player_goals": None}
    for f in ("bt/nhl_2425_mkt.json", "bt/nhl_props.json"):
        out += prop_rows("nhl", f, {k: v for k, v in STAT.items() if v}, act)
    print(f"  nhl game lines (market) + props: {len(out)}")
    return out


# ── NFL: anytime TD (Onyx 2025-26) and the 2024 season at market prices ──
def td_rows():
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
    first = json.load(open("bt/nfl_first_td.json")) if os.path.exists("bt/nfl_first_td.json") else {}
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
                td, t = (r.get("rush_td") or 0) + (r.get("rec_td") or 0), r["team"]
            else:
                t = team_of.get(nk(name))
                if not t or (wk["season"], wk["week"], M.VERSE_TEAM.get(t, t), M._vk(name)) not in snaps:
                    continue
                td = 0
            c = ctx("nfl", g["home"], g["away"], x["start"], g["date"], int(t == g["home"]))
            v = mk.get("anytime_touchdown_scorer")
            if v:
                for when in ("o", "c"):
                    if v[when][1] is not None:
                        out.append(R_("nfl", "anytime_td", when, g["date"], None, 0.5, v[when][1], None, int(td > 0), c))
            v, ft = mk.get("first_touchdown_scorer"), first.get(g["id"])
            if v and ft:   # first TD scorer: he played (a box line or snaps), graded off ESPN's scoring plays
                won = int(bool(ft.get("name")) and nk(ft["name"]) == nk(name))
                for when in ("o", "c"):
                    if v[when][1] is not None:
                        out.append(R_("nfl", "first_td", when, g["date"], None, 0.5, v[when][1], None, won, c))
    return out


def nfl_pass_td_rows():
    """QB passing touchdowns (Onyx 2025-26 on), graded off the ESPN box (data/nfl/player_games.json):
    a quarterback with no passing line did not play, a void."""
    f = "bt/nfl_pass_td.json"
    if not os.path.exists(f):
        return []
    lane = Lane("nfl")
    rows = (lane.load("player_games.json", {}) or {}).get("rows") or []
    res = (lane.load("results.json", {}) or {}).get("games") or []
    tm = SB.team_map("nfl")
    by_day = {}
    for g in res:
        by_day.setdefault(g["date"], []).append(g)
    box = {}
    for r in rows:
        if r.get("att"):
            box[(r["gid"], nk(r["name"]))] = r
    gid_of = {}
    def act(fid, x, name, st):
        if fid not in gid_of:
            h, a = tm.get(nk(x["home"])), tm.get(nk(x["away"]))
            d0, g = (x["start"] or "")[:10], None
            for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
                g = next((y for y in by_day.get(dd, []) if y["home"] == h and y["away"] == a), None) or g
            gid_of[fid] = g["id"] if g else None
        r = box.get((gid_of[fid], nk(name)))
        return (r.get("pass_td"), bool(r.get("home"))) if r else None
    out = prop_rows("nfl", f, {"player_passing_touchdowns": "pass_td"}, act)
    print(f"  nfl passing TDs: {len(out)}")
    return out


def nfl_2024_rows():
    """The 2024 season at market prices: game lines from the score, props from nflverse weekly
    stats with snap counts (snaps and no stat line = 0, no snaps = void)."""
    f = "bt/nfl_2024_mkt.json"
    if not os.path.exists(f):
        return []
    out = game_rows("nfl", f)
    stats, snaps = {}, set()
    p1, p2 = "bt/nfl24/stats_player_week_2024.csv", "bt/nfl24/snap_counts_2024.csv"
    if os.path.exists(p1):
        for r in csv.DictReader(open(p1)):
            num = lambda k: float(r.get(k) or 0)
            stats[(int(r["week"]), r["team"], nk(r["player_display_name"]))] = {
                "rec": num("receptions"), "rec_yds": num("receiving_yards"), "rush_yds": num("rushing_yards"),
                "pass_yds": num("passing_yards"), "td_yes": num("rushing_tds") + num("receiving_tds")}
    if os.path.exists(p2):
        for r in csv.DictReader(open(p2)):
            if int(r["offense_snaps"] or 0) > 0:
                snaps.add((int(r["week"]), r["team"], nk(r["player"])))
    wk_of = {}
    pbp = "bt/nfl24/games.json"
    if os.path.exists(pbp):
        for g in json.load(open(pbp)):
            if g["season"] == 2024:
                wk_of[(RC.team("nfl", g["home"])[0], g["date"])] = (g["week"], g["home"], g["away"])
    def act(fid, x, name, st):
        hk, _ = RC.team("nfl", x.get("home"))
        d = et_day(x["start"])
        wk = wk_of.get((hk, d)) or wk_of.get((hk, (date.fromisoformat(d) + timedelta(days=1)).isoformat()))
        if not wk:
            return None
        for t in (wk[1], wk[2]):
            s = stats.get((wk[0], t, nk(name)))
            if s:
                return (s[st], t == wk[1])
            if (wk[0], t, nk(name)) in snaps:
                return (0.0, t == wk[1])
        return None
    STAT = {"player_receptions": "rec", "player_receiving_yards": "rec_yds", "player_rushing_yards": "rush_yds",
            "player_passing_yards": "pass_yds", "anytime_touchdown_scorer": "td_yes"}
    rows = prop_rows("nfl", f, STAT, act)       # *_mkt.json: market-price periods
    for r in rows:
        if r[1] == "td_yes":
            r[1] = "anytime_td"
    out += rows
    print(f"  nfl 2024 (market): {len(out)}")
    return out


# ── CFB props (2026) ───────────────────────────────────────────────────
def cfb_prop_rows():
    """College props graded from ESPN box scores. ESPN's college box has no snap counts, so a
    priced player missing from the box is a void, not a zero: this leans slightly toward overs."""
    rows = (Lane("cfb").load("player_games.json", {}) or {}).get("rows") or []
    box = {}
    for r in rows:
        box[(r["date"], nk(r["name"]))] = r
    def act(fid, x, name, st):
        d = et_day(x["start"])
        r = box.get((d, nk(name))) or box.get(((date.fromisoformat(d) + timedelta(days=1)).isoformat(), nk(name)))
        if not r:
            return None
        v = (r.get("rush_td") or 0) + (r.get("rec_td") or 0) if st == "td_yes" else (r.get(st) or 0)
        return (v, bool(r.get("home")))
    STAT = {"player_receptions": "rec", "player_receiving_yards": "rec_yds", "player_rushing_yards": "rush_yds",
            "player_passing_yards": "pass_yds", "anytime_touchdown_scorer": "td_yes"}
    out = prop_rows("cfb", "bt/cfb_props.json", STAT, act)
    for r in out:
        if r[1] == "td_yes":
            r[1] = "anytime_td"
    print(f"  cfb props: {len(out)}")
    return out


def main():
    import importlib
    load_schedules()
    R = []
    R += nba_rows()
    R += nba_more_rows()
    R += nba_period_rows()
    R += mlb_rows()
    for key, f in (("nfl", "bt/nfl_game.json"), ("cfb", "bt/cfb_lines.json"), ("nhl", "bt/nhl_lines.json")):
        M = importlib.import_module({"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model"}[key])
        GP = M.GAME_P if key == "nfl" else M.P
        R += [sample_row(key, r) for r in SB.team_samples(key, json.load(open(f)), M, GP)]
    R += game_rows("cfb", "bt/cfb_2024_mkt.json")
    R += cfb_prop_rows()
    R += nhl_more_rows()
    R += [sample_row("nfl", r) for r in SB.nfl_prop_samples(json.load(open("bt/nfl_lines.json")))]
    R += td_rows()
    R += nfl_pass_td_rows()
    R += nfl_2024_rows()
    for f in ("bt/tennis_atp_games.json", "bt/tennis_wta_games.json"):
        R += tennis_game_rows(f)
    for f in ("bt/tennis_atp_lines.json", "bt/tennis_wta_lines.json"):
        if os.path.exists(f):
            R += [R_("tennis", r["mkt"], r["when"], r["date"], r["p"], None, r["over"], r["under"], r["y"], None)
                  for r in SB.tennis_samples([f])]
    G = {}
    for sp, mk, t, w, d, p, ln, pa, pb, y, c in R:
        G.setdefault(sp, {}).setdefault(mk, {}).setdefault(t, []).append([w, p, ln, pa, pb, y, c])
    os.makedirs("data/rules_lab", exist_ok=True)
    idx = {"built": date.today().isoformat(), "cols": ["t (0 open, 1 close)", "w", "p", "l (line)", "a", "b", "y", "c (ctx)"],
           "ctx": ["side A home", "night", "home zone (0 E, 1 C, 2 M, 3 P)", "zones the away team crossed", "home rest", "away rest", "month"],
           "sports": {}}
    import shutil
    for old in os.listdir("data/rules_lab"):
        p = os.path.join("data/rules_lab", old)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    for sp, mk in G.items():
        # one file per sport and market, columnar (a list per column, open and close rows together
        # with t = 0 open / 1 close): about half the size of row lists and quick to parse on a phone
        os.makedirs(f"data/rules_lab/{sp}", exist_ok=True)
        for m, byT in mk.items():
            cols = {k: [] for k in ("t", "w", "p", "l", "a", "b", "y", "c")}
            for t, rows in byT.items():
                for w, p, ln, pa, pb, y, c in rows:
                    cols["t"].append(0 if t == "o" else 1); cols["w"].append(w); cols["p"].append(p); cols["l"].append(ln)
                    cols["a"].append(pa); cols["b"].append(pb); cols["y"].append(y); cols["c"].append(c)
            json.dump(cols, open(f"data/rules_lab/{sp}/{m}.json", "w"), separators=(",", ":"))
        idx["sports"][sp] = {"names": [w[1] for w in WINDOWS[sp]], "market": [i for i, w in enumerate(WINDOWS[sp]) if w[2]],
                             "periods": sorted({r[0] for tt in mk.values() for rr in tt.values() for r in rr}),
                             "markets": {m: sum(len(v) for v in tt.values()) for m, tt in mk.items()},
                             "kb": sum(os.path.getsize(f"data/rules_lab/{sp}/{m}.json") for m in mk) // 1024}
    json.dump(idx, open("data/rules_lab.json", "w"), indent=1)
    print(len(R), "rows", Counter((r[0], r[1]) for r in R))
    print({k: (v["kb"], v["periods"]) for k, v in idx["sports"].items()})


if __name__ == "__main__":
    main()
