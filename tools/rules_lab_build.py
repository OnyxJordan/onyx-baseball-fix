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

WINDOWS = {"nfl": ("2026-03-01", "2025 season", "2026 season"), "cfb": ("2026-03-01", "2025 season", "2026 season"),
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


def main():
    import importlib
    R = []
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
    out = {"built": date.today().isoformat(), "windows": {k: {"split": v[0], "names": [v[1], v[2]]} for k, v in WINDOWS.items()},
           "cols": ["w", "p", "line", "a", "b", "y"], "data": G}
    json.dump(out, open("data/rules_lab.json", "w"), separators=(",", ":"))
    print(len(R), "rows", Counter((r[0], r[1]) for r in R), os.path.getsize("data/rules_lab.json") // 1024, "KB")


if __name__ == "__main__":
    main()
