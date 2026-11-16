#!/usr/bin/env python3
"""sgp_lines_corr.py - game-line correlations for the Parlay Lab (11/16, dev only, reads bt/ files).

The Parlay Lab plays a same-game slip out with a Gaussian copula (see tools/nfl_sgp_corr.py). For the game lines of
the NBA, college basketball, the NHL and tennis it needs three links, measured here from Onyx's own opening lines and
the finals:

  favml|over  the favorite's moneyline with the over; the underdog's moneyline is the same number with the sign
              flipped (it is the other half of the same bet)
  favsp|over  the favorite's spread (puck line, game spread) with the over; the underdog's, sign flipped
  same        a team's moneyline with its own spread
  cross       a team's moneyline with the other team's spread

Each cell is the latent correlation that best predicts how often its real pairs both hit (log loss over a grid, the
way the lab uses it), on devigged opening chances, shrunk toward 0 by n / (n + 80). Pushes are dropped. Held out:
fitted on the first half of the games by date and judged on the second, against independence.

  NBA      bt/nba_lines_full.json, bt/nba_2425_mkt.json (finals in the files)
  CBB      bt/cbb_lines.json
  NHL      bt/nhl_lines.json (puck line, total goals; finals include overtime and the shootout goal)
  tennis   bt/tennis_atp_lines.json, bt/tennis_wta_lines.json for prices; games won from bt/tennis_results_full.json
           (matched by players and date: the line files' finals are sets)

    python3 tools/sgp_lines_corr.py
"""
import json, math, os, random, re, sys, unicodedata
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfl_sgp_corr as N  # noqa: E402  (bvn_upper, imp)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.environ.get("ONYX_BT") or os.path.join(ROOT, "bt")
SHRINK = 80.0


def load(name):
    p = os.path.join(BT, name)
    return json.load(open(p)) if os.path.exists(p) else {}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", s)


def dv(a, b):
    """devigged chance of the first of two prices"""
    if a is None or b is None:
        return None
    x, y = N.imp(a), N.imp(b)
    return x / (x + y)


def legs_of(fx, h_score, a_score, keys):
    """[(kind, team, fav, p, y)] for one game: kind ml / side (spread) / over"""
    gm = fx.get("game") or {}
    home, away = fx.get("home"), fx.get("away")
    out = []
    ml = gm.get("moneyline") or {}
    mh, ma = (ml.get(home) or {}).get("o"), (ml.get(away) or {}).get("o")
    pfav = None
    if mh and ma and mh[1] is not None and ma[1] is not None:
        ph = dv(mh[1], ma[1])
        if h_score != a_score:
            out.append(("ml", home, ph > 0.5, ph, int(h_score > a_score)))
            out.append(("ml", away, ph < 0.5, 1 - ph, int(a_score > h_score)))
        pfav = ph
    sp = gm.get(keys["spread"]) or {}
    sh_, sa_ = (sp.get(home) or {}).get("o"), (sp.get(away) or {}).get("o")
    if sh_ and sa_ and sh_[0] is not None and sh_[1] is not None and sa_[1] is not None:
        res = (h_score - a_score) + sh_[0]
        if res != 0:
            p = dv(sh_[1], sa_[1])
            fav_home = sh_[0] < 0 if sh_[0] != 0 else (pfav is not None and pfav > 0.5)
            out.append(("side", home, fav_home, p, int(res > 0)))
            out.append(("side", away, not fav_home, 1 - p, int(res < 0)))
    tot = gm.get(keys["total"]) or {}
    o, u = (tot.get("over") or {}).get("o"), (tot.get("under") or {}).get("o")
    if o and u and o[0] is not None and o[1] is not None and u[1] is not None:
        res = h_score + a_score - o[0]
        if res != 0:
            out.append(("over", None, None, dv(o[1], u[1]), int(res > 0)))
    return out


def team_games(files, keys):
    games = []
    for f in files:
        for fid, fx in load(f).items():
            if fx.get("hs") is None or fx.get("as") is None or "Preseason" in (fx.get("season_type") or ""):
                continue
            L = legs_of(fx, fx["hs"], fx["as"], keys)
            if len(L) >= 2:
                games.append((fx.get("start") or "", L))
    return games


def tennis_games():
    res = defaultdict(list)
    for r in load("tennis_results_full.json"):
        res[frozenset((nk(r["w"]), nk(r["l"])))].append(r)
    games = []
    for f in ("tennis_atp_lines.json", "tennis_wta_lines.json"):
        for fid, fx in load(f).items():
            h, a, st = fx.get("home"), fx.get("away"), (fx.get("start") or "")[:10]
            if not h or not a or not st:
                continue
            d0 = date.fromisoformat(st)
            hit = None
            for r in res.get(frozenset((nk(h), nk(a))), []):
                if abs((date.fromisoformat(r["date"]) - d0).days) <= 2:
                    hit = r
                    break
            if not hit:
                continue
            hw = nk(hit["w"]) == nk(h)
            hg, ag = (hit["games_w"], hit["games_l"]) if hw else (hit["games_l"], hit["games_w"])
            # the moneyline is graded on the match, the spread and total on games
            L = legs_of(fx, hg, ag, {"spread": "game_spread", "total": "total_games"})
            L = [l for l in L if l[0] != "ml"]
            ml = (fx.get("game") or {}).get("moneyline") or {}
            mh, ma = (ml.get(h) or {}).get("o"), (ml.get(a) or {}).get("o")
            if mh and ma and mh[1] is not None and ma[1] is not None:
                ph = dv(mh[1], ma[1])
                L += [("ml", h, ph > 0.5, ph, int(hw)), ("ml", a, ph < 0.5, 1 - ph, int(not hw))]
            if len(L) >= 2:
                games.append((fx["start"], L))
    return games


def cell(a, b):
    """(cell, sign) for a pair, sign = how the cell's correlation applies to this pair"""
    ka, kb = a[0], b[0]
    if "over" in (ka, kb):
        s = b if ka == "over" else a
        if s[0] == "over":
            return None
        return (("favml" if s[0] == "ml" else "favsp") + "|over", 1 if s[2] else -1)
    if a[1] == b[1]:
        return ("same", 1) if ka != kb else None
    return ("cross", 1) if ka != kb else None


def pairs(games):
    for _st, L in games:
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                c = cell(L[i], L[j])
                if c:
                    yield c, L[i], L[j]


GRID = [x / 20 for x in range(-19, 20)]


def fit(games):
    cells = defaultdict(list)
    for (c, sg), a, b in pairs(games):
        cells[c].append((a[3], b[3], a[4] * b[4], sg))
    T = {}
    for c, xs in cells.items():
        if len(xs) < 40:
            continue
        smp = random.Random(7).sample(xs, 8000) if len(xs) > 8000 else xs
        best = min(GRID, key=lambda r: sum(-(y * math.log(max(1e-6, q)) + (1 - y) * math.log(max(1e-6, 1 - q)))
                                           for pa, pb, y, sg in smp for q in (N.bvn_upper(pa, pb, r * sg),)))
        T[c] = {"r": round(best * len(xs) / (len(xs) + SHRINK), 3), "n": len(xs)}
    return T


def judge(games, T):
    ll = {"indep": 0.0, "fit": 0.0}
    n = 0
    for (c, sg), a, b in pairs(games):
        y = a[4] * b[4]
        for k, r in (("indep", 0.0), ("fit", (T.get(c) or {}).get("r", 0.0) * sg)):
            q = max(1e-4, min(1 - 1e-4, N.bvn_upper(a[3], b[3], r)))
            ll[k] += -(y * math.log(q) + (1 - y) * math.log(1 - q))
        n += 1
    return {k: v / max(1, n) for k, v in ll.items()}, n


def main():
    sets = {
        "nba": team_games(("nba_lines_full.json", "nba_2425_mkt.json"), {"spread": "point_spread", "total": "total_points"}),
        "cbb": team_games(("cbb_lines.json",), {"spread": "point_spread", "total": "total_points"}),
        "nhl": team_games(("nhl_lines.json",), {"spread": "puck_line", "total": "total_goals"}),
        "tennis": tennis_games(),
    }
    out = {}
    for sp, games in sets.items():
        games.sort(key=lambda g: g[0])
        half = len(games) // 2
        T1 = fit(games[:half])
        ll, n = judge(games[half:], T1)
        T = fit(games)
        out[sp] = T
        print(f"{sp}: {len(games)} games with lines and a final; held out ({n} pairs): log loss independent {ll['indep']:.5f}, fitted {ll['fit']:.5f}")
        print("   " + ", ".join(f"{c} {v['r']:+.3f} ({v['n']} pairs)" for c, v in sorted(T.items())))
    print("\n// studio-lab.js")
    for sp, T in out.items():
        print(f"    {sp}: " + "{" + ", ".join(f"'{c}': {v['r']}" for c, v in sorted(T.items())) + "},")


if __name__ == "__main__":
    main()
