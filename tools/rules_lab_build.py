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

WINDOWS = {"nba": ("2026-02-01", "Oct 2025 to Jan 2026", "Feb to Apr 2026"),
           "nfl": ("2026-03-01", "2025 season", "2026 season"), "cfb": ("2026-03-01", "2025 season", "2026 season"),
           "nhl": ("2026-01-15", "2025-26 to Jan 14", "Jan 15, 2026 on"), "tennis": ("2026-01-01", "2025", "2026")}


def row(sport, r, mkt=None):
    split = WINDOWS[sport][0]
    p = r.get("p")
    return [sport, mkt or r["mkt"], r["when"], int(r["date"] >= split), r["date"], None if p is None else round(p, 3),
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
                    out.append(["nfl", m, when, int(g["date"] >= WINDOWS["nfl"][0]), g["date"], None, 0.5, pr, None, y])
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
            out.append(["nba", x["s"], which, int(d >= WINDOWS["nba"][0]), d, x["p_model"], x["line"], x["po"], x["pu"], int(x["over"])])
    print(f"  nba props: {len(out)} priced samples")
    return out


def main():
    import importlib
    R = []
    R += nba_rows()
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
        idx["sports"][sp] = {"split": WINDOWS[sp][0], "names": [WINDOWS[sp][1], WINDOWS[sp][2]],
                             "markets": {m: sum(len(v) for v in t.values()) for m, t in mk.items()},
                             "kb": os.path.getsize(f"data/rules_lab/{sp}.json") // 1024}
    json.dump(idx, open("data/rules_lab.json", "w"), indent=1)
    print(len(R), "rows", Counter((r[0], r[1]) for r in R), {k: v["kb"] for k, v in idx["sports"].items()}, "KB")


if __name__ == "__main__":
    main()
