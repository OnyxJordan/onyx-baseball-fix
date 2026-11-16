#!/usr/bin/env python3
"""nba_sgp_corr.py - same-game correlations for the NBA Parlay Lab (11/16, dev only, reads bt/ files).

The NBA twin of tools/nfl_sgp_corr.py (same method, same fitting code imported from it): every Onyx opening line with a
result in two seasons, graded off the box scores, and each cell of the lab's table set to the correlation that best
predicts how often its real same-game pairs both hit.

  lines   bt/nba_2425_lines.json (2024-25 points / rebounds / assists), bt/nba_lines_full.json (2025-26 on: points,
          rebounds, assists, spread, total), bt/nba_threes_pra.json (3-pointers made), bt/nba_combos_a.json and
          bt/nba_combos_b.json (points + rebounds, points + assists, points + rebounds + assists)
  results bt/nba/box.json (one row per player-game) and the fixtures' finals
  cells   pts, reb, ast, thr (3-pointers), pr, pa, pra; each pair by relation: the same player, teammates, opponents,
          a team's side and its own / the other team's players, the game total and anything in it

Held out the way the lab is used: fitted on 2024-25 and judged on 2025-26's same-game two-leg pairs, then the other
way (log loss against independence), then refitted on both and printed as the JavaScript studio-lab.js reads.

    python3 tools/nba_sgp_corr.py          (~5 min)
"""
import json, os, sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfl_sgp_corr as N  # noqa: E402  (bvn_upper, calib, pc, fit_mle, judge2, nk, imp, qnorm, phi)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.environ.get("ONYX_BT") or os.path.join(ROOT, "bt")
MK = {"player_points": ("pts", "pts"), "player_rebounds": ("reb", "reb"), "player_assists": ("ast", "ast"),
      "player_made_threes": ("thr", "fg3"), "player_points_+_rebounds": ("pr", "pr"), "player_points_+_assists": ("pa", "pa"),
      "player_points_+_rebounds_+_assists": ("pra", "pra")}


def load(name):
    p = os.path.join(BT, name)
    return json.load(open(p)) if os.path.exists(p) else {}


def build():
    box = defaultdict(dict)       # fid -> player key -> (team full name, stats)
    for r in load("nba/box.json"):
        fid, _pid, name, _pos, team, _st, mins, _secs, pts, reb, ast, fg3 = r[:12]
        if not mins:
            continue
        pts, reb, ast, fg3 = float(pts or 0), float(reb or 0), float(ast or 0), float(fg3 or 0)
        box[fid][N.nk(name)] = (team, {"pts": pts, "reb": reb, "ast": ast, "fg3": fg3, "pr": pts + reb, "pa": pts + ast, "pra": pts + reb + ast})
    files = [load(f) for f in ("nba_2425_lines.json", "nba_lines_full.json", "nba_threes_pra.json", "nba_combos_a.json", "nba_combos_b.json", "nba_2425_mkt.json")]
    games = []
    for fid in set().union(*[set(f) for f in files]):
        fx = next(f[fid] for f in files if fid in f)
        hs, as_, start = fx.get("hs"), fx.get("as"), fx.get("start") or ""
        if hs is None or as_ is None or fid not in box or "Preseason" in (fx.get("season_type") or ""):
            continue
        season = 2025 if start < "2025-08-01" else 2026
        legs, seen = [], set()
        for f in files:
            src = f.get(fid) or {}
            for name, mk in (src.get("props") or {}).items():
                hit = box[fid].get(N.nk(name))
                if not hit:
                    continue
                team, st = hit
                for mid, v in mk.items():
                    if mid not in MK or not v.get("o") or v["o"][0] is None or None in v["o"][1:3]:
                        continue
                    key, stat = MK[mid]
                    if (name, key) in seen:
                        continue
                    seen.add((name, key))
                    act = st[stat]
                    po = N.imp(v["o"][1]) / (N.imp(v["o"][1]) + N.imp(v["o"][2]))
                    legs.append({"cat": key, "mkt": key, "team": team, "who": N.nk(name), "res": act - v["o"][0],
                                 "y": int(act > v["o"][0]), "push": act == v["o"][0], "p": po})
            gm = src.get("game") or {}
            sp = gm.get("point_spread") or {}
            if sp and "spread" not in seen:
                hsp = next((v["o"][0] for k, v in sp.items() if k == fx.get("home") and v.get("o") and v["o"][0] is not None), None)
                if hsp is not None:
                    seen.add("spread")
                    res = (hs - as_) + hsp
                    for t, sgn in ((fx.get("home"), 1), (fx.get("away"), -1)):
                        legs.append({"cat": "side", "mkt": "spread", "team": t, "who": None, "res": sgn * res, "y": int(sgn * res > 0), "push": res == 0, "p": 0.5})
            tot = (gm.get("total_points") or {}).get("over")
            if tot and tot.get("o") and tot["o"][0] is not None and "total" not in seen:
                seen.add("total")
                res = hs + as_ - tot["o"][0]
                legs.append({"cat": "total", "mkt": "total", "team": None, "who": None, "res": res, "y": int(res > 0), "push": res == 0, "p": 0.5})
        if len(legs) >= 2:
            games.append({"season": season, "legs": legs})
    for g in games:
        for l in g["legs"]:
            l["k"] = 1.0
    return games


def js(T):
    def obj(d):
        return "{" + ", ".join(f"'{k}': {v['r']}" for k, v in sorted(d.items(), key=lambda kv: -kv[1]["n"])) + "}"
    return "\n".join(f"    {nm}: {obj(T.get(g, {}))}," for nm, g in (("same", "same"), ("team", "team"), ("opp", "opp"),
                                                                     ("sideOwn", "side_own"), ("sideOpp", "side_opp"), ("total", "total")))


def main():
    games = build()
    nl = sum(len(g["legs"]) for g in games)
    print(f"{len(games)} games, {nl} graded Onyx lines (2024-25: {sum(1 for g in games if g['season'] == 2025)} games, "
          f"2025-26 on: {sum(1 for g in games if g['season'] == 2026)})")
    for tr, te in ((2025, 2026), (2026, 2025)):
        sh = N.calib(games, (tr,))
        Tm = N.fit_mle(games, (tr,), sh, cap=6000)
        out, n, hits, by = N.judge2(games, Tm, sh, te)
        print(f"fit on {tr}, judged on {te}: {n} same-game two-leg pairs, {hits} both hit ({100 * hits / max(n, 1):.1f}%)")
        print(f"  log loss: independent {out['indep']:.5f}  fitted {out['fit']:.5f}")
        for grp, (m, y, pf, _po, pi) in sorted(by.items(), key=lambda kv: -kv[1][0]):
            print(f"    {grp:9s} {m:7d}  both hit {100 * y / m:5.1f}%  fitted {100 * pf / m:5.1f}%  multiplied {100 * pi / m:5.1f}%")
    sh = N.calib(games, (2025, 2026))
    TA = N.fit_mle(games, (2025, 2026), sh, cap=6000)
    print("\nfitted on both (r, pairs):")
    for grp in ("same", "team", "opp", "side_own", "side_opp", "total"):
        cells = sorted(TA.get(grp, {}).items(), key=lambda kv: -kv[1]["n"])
        print(f"  {grp:9s} " + ", ".join(f"{k} {v['r']:+.2f} ({v['n']})" for k, v in cells))
    print(f"\n// studio-lab.js NBA table ({datetime.now():%m/%d})\n" + js(TA))


if __name__ == "__main__":
    main()
