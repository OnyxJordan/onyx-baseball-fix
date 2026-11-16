#!/usr/bin/env python3
"""nfl_sgp_corr.py - real same-game correlations for the NFL Studio's Parlay Lab (11/16, dev only, bt/ files).

Jordan: "build the real same-game correlations for parlay lab". The lab plays a slip out with a Gaussian copula: every
leg keeps the model's chance and two legs in one game share a correlation looked up in a table by how they relate
(the same player, teammates, opponents, a team's side, the game total) and what they are (passing, attempts,
receiving, rushing, anytime TD). Until now that table was hand-set round numbers. This fits every cell from what Onyx's
own lines did, game by game, in 2025 and 2026:

  every Onyx opening line with a result (bt/nfl_lines.json receptions / receiving / rushing / passing yards,
  bt/nfl_combo_a.json pass attempts, bt/nfl_td.json anytime TD, bt/nfl_game.json spread and total), graded off the
  box score (data/nfl/player_games.json) and the final (the fixtures' scores)
  a continuous leg's score is how far the result landed from the line, in that market's own spread; an anytime TD is
  a yes / no against Onyx's price with its margin taken out (Onyx's TD prices carry about 21%), turned into the latent
  normal the copula uses (the biserial correction: r_latent = r_observed / sd(E[Z | yes or no]))
  every pair of legs in the same game is one observation of its cell. The default fit: each market's chances are
  calibrated first (a logit shift so they match how often the market hit), then each cell's correlation is the one
  that best predicts how often its real pairs both hit (log loss over a grid, the way the lab uses it), shrunk toward
  0 by n / (n + 80). --pearson prints the residual-correlation fit instead (the first try: it did no better than the
  old hand-set table held out, because prices running a little low on overs and TDs leaked into it)

The fit is judged the way the lab is used: on 2026's same-game two-leg parlays (every pair of overs in one game,
"over" = the leg's more-of-the-stat side), the joint chance from (a) independence, (b) the old hand-set table and
(c) this table fitted on 2025 only, scored by log loss against what happened. Then the table is refitted on both
seasons and printed as the JavaScript studio-lab.js uses.

    python3 tools/nfl_sgp_corr.py            both held-out checks, then the table fitted on both seasons, as JS (~8 min)
    python3 tools/nfl_sgp_corr.py --json     also writes $TMPDIR/nfl_sgp_corr.json
"""
import json, math, os, re, sys, unicodedata
from collections import defaultdict
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BT = os.path.join(ROOT, "bt")
NICK = {"Cardinals": "ARI", "Falcons": "ATL", "Ravens": "BAL", "Bills": "BUF", "Panthers": "CAR", "Bears": "CHI", "Bengals": "CIN",
        "Browns": "CLE", "Cowboys": "DAL", "Broncos": "DEN", "Lions": "DET", "Packers": "GB", "Texans": "HOU", "Colts": "IND",
        "Jaguars": "JAX", "Chiefs": "KC", "Raiders": "LV", "Chargers": "LAC", "Rams": "LAR", "Dolphins": "MIA", "Vikings": "MIN",
        "Patriots": "NE", "Saints": "NO", "Giants": "NYG", "Jets": "NYJ", "Eagles": "PHI", "Steelers": "PIT", "49ers": "SF",
        "Seahawks": "SEA", "Buccaneers": "TB", "Titans": "TEN", "Commanders": "WSH"}
MK = {"player_receptions": ("rec", "recv", "rec"), "player_receiving_yards": ("rec_yds", "recv", "rec_yds"),
      "player_rushing_yards": ("rush_yds", "rush", "rush_yds"), "player_passing_yards": ("pass_yds", "pass", "pass_yds"),
      "player_passing_attempts": ("pass_att", "att", "att")}
TD_MARGIN = 1.21
SHRINK, CAP = 80.0, 0.85

# the hand-set table studio-lab.js used before (for the comparison)
OLD = {"same": {"pass|pass": 0.6, "att|pass": 0.55, "att|att": 0.6, "recv|recv": 0.7, "rush|rush": 0.7, "recv|rush": 0.35, "recv|td": 0.35,
                "rush|td": 0.35, "pass|td": 0.15, "td|td": 0.65, "att|td": 0.05, "pass|rush": 0.2},
       "team": {"pass|recv": 0.45, "att|recv": 0.3, "pass|td": 0.3, "att|td": 0.1, "pass|rush": -0.05, "att|rush": -0.2, "att|pass": 0.5,
                "recv|recv": -0.05, "recv|td": 0.1, "rush|td": 0.15, "td|td": 0.1, "rush|rush": -0.15},
       "opp": {"pass|pass": 0.15, "pass|recv": 0.12, "recv|recv": 0.12, "td|td": 0.1, "pass|td": 0.1, "recv|td": 0.1, "rush|rush": -0.1,
               "att|att": -0.1, "att|rush": 0.15},
       "side_own": {"rush": 0.3, "td": 0.25, "recv": 0.1, "pass": 0.05, "att": -0.25},
       "side_opp": {"rush": -0.25, "td": -0.2, "recv": 0, "pass": 0, "att": 0.25},
       "total": {"pass": 0.4, "att": 0.15, "recv": 0.3, "rush": 0.15, "td": 0.35}}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def imp(p):
    return 100 / (p + 100) if p > 0 else -p / (-p + 100)


def Phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def phi(x):
    return math.exp(-x * x / 2) / math.sqrt(2 * math.pi)


def qnorm(p):
    lo, hi = -9.0, 9.0
    for _ in range(70):
        m = (lo + hi) / 2
        if Phi(m) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


GL = [(-0.9739065285, 0.0666713443), (-0.8650633667, 0.1494513492), (-0.6794095683, 0.2190863625), (-0.4333953941, 0.2692667193),
      (-0.1488743390, 0.2955242247), (0.1488743390, 0.2955242247), (0.4333953941, 0.2692667193), (0.6794095683, 0.2190863625),
      (0.8650633667, 0.1494513492), (0.9739065285, 0.0666713443)]


def bvn_upper(pa, pb, r):
    """P(A and B) for two legs that hit with chances pa, pb, latents correlated r (both hit on the upper tail)."""
    a, b = qnorm(1 - pa), qnorm(1 - pb)
    # P(Z1 > a, Z2 > b) = P(Z1 < -a, Z2 < -b) = Phi(-a)Phi(-b) + integral_0^r phi2(a, b; t) dt
    s = 0.0
    for x, w in GL:
        t = r * (x + 1) / 2
        q = 1 - t * t
        s += w * math.exp(-(a * a - 2 * t * a * b + b * b) / (2 * q)) / (2 * math.pi * math.sqrt(q))
    return min(min(pa, pb), max(1e-6, pa * pb + s * r / 2))


def load(name):
    p = os.path.join(BT, name)
    return json.load(open(p)) if os.path.exists(p) else {}


def build():
    """Per game: its legs [(cat, team, player key or None, score, hit (over side), p_over, binary sd)]."""
    PG = json.load(open(os.path.join(ROOT, "data/nfl/player_games.json")))["rows"]
    box = defaultdict(dict)
    for r in PG:
        box[(r["date"], r["team"])][nk(r["name"])] = r
    lines, combo, td, game = load("nfl_lines.json"), load("nfl_combo_a.json"), load("nfl_td.json"), load("nfl_game.json")
    games = []
    for fid in set(lines) | set(game):
        fx = lines.get(fid) or game.get(fid)
        h, a = NICK.get((fx.get("home") or "").split()[-1]), NICK.get((fx.get("away") or "").split()[-1])
        hs, as_ = fx.get("hs"), fx.get("as")
        if not h or not a or hs is None or as_ is None:
            continue
        st = datetime.fromisoformat(fx["start"].replace("Z", "+00:00")) - timedelta(hours=5)
        season = 2025 if fx["start"] < "2026-03-01" else 2026
        dates = [(st + timedelta(days=d)).date().isoformat() for d in (0, 1, -1)]
        legs = []

        def row_of(name):
            k = nk(name)
            for d in dates:
                for t in (h, a):
                    r = box.get((d, t), {}).get(k)
                    if r:
                        return t, r
            return None, None

        for src in (lines.get(fid), combo.get(fid)):
            for name, mk in ((src or {}).get("props") or {}).items():
                for mid, v in mk.items():
                    if mid not in MK or not v.get("o") or v["o"][0] is None or None in v["o"][1:3]:
                        continue
                    key, cat, stat = MK[mid]
                    t, r = row_of(name)
                    if r is None:
                        continue
                    act = r.get(stat) or 0.0
                    po = imp(v["o"][1]) / (imp(v["o"][1]) + imp(v["o"][2]))
                    legs.append({"cat": cat, "mkt": key, "team": t, "who": nk(name), "res": act - v["o"][0], "y": int(act > v["o"][0]),
                                 "push": act == v["o"][0], "p": po})
        for name, mk in ((td.get(fid) or {}).get("props") or {}).items():
            v = mk.get("anytime_touchdown_scorer")
            if not v or not v.get("o") or v["o"][1] is None:
                continue
            t, r = row_of(name)
            if r is None:
                continue
            y = int(((r.get("rush_td") or 0) + (r.get("rec_td") or 0)) >= 1)
            p = min(0.95, imp(v["o"][1]) / TD_MARGIN)
            legs.append({"cat": "td", "mkt": "anytime_td", "team": t, "who": nk(name), "y": y, "push": False, "p": p, "bin": True})
        gm = (game.get(fid) or {}).get("game") or {}
        sp = gm.get("point_spread") or {}
        hsp = next((v["o"][0] for k, v in sp.items() if NICK.get(k.split()[-1]) == h and v.get("o")), None)
        if hsp is not None:
            res = (hs - as_) + hsp
            for t, sgn in ((h, 1), (a, -1)):
                legs.append({"cat": "side", "mkt": "spread", "team": t, "who": None, "res": sgn * res, "y": int(sgn * res > 0), "push": res == 0, "p": 0.5})
        tot = (gm.get("total_points") or {}).get("over")
        if tot and tot.get("o") and tot["o"][0] is not None:
            res = hs + as_ - tot["o"][0]
            legs.append({"cat": "total", "mkt": "total", "team": None, "who": None, "res": res, "y": int(res > 0), "push": res == 0, "p": 0.5})
        if len(legs) >= 2:
            games.append({"season": season, "legs": legs, "h": h, "a": a})
    # continuous scores in each market's own spread (centered per season); binary legs as E[Z | y]
    sd, mu = {}, {}
    for s in (2025, 2026):
        acc = defaultdict(list)
        for g in games:
            if g["season"] == s:
                for l in g["legs"]:
                    if not l.get("bin"):
                        acc[l["mkt"]].append(l["res"])
        for m, xs in acc.items():
            mu[(s, m)] = sum(xs) / len(xs)
            sd[(s, m)] = math.sqrt(sum((x - mu[(s, m)]) ** 2 for x in xs) / max(1, len(xs) - 1)) or 1.0
    for g in games:
        for l in g["legs"]:
            if l.get("bin"):
                c = qnorm(1 - l["p"]); f = phi(c)
                l["z"] = f / l["p"] if l["y"] else -f / (1 - l["p"])
                l["k"] = f / math.sqrt(l["p"] * (1 - l["p"]))      # sd of E[Z | y]: the biserial correction
            else:
                l["z"] = (l["res"] - mu[(g["season"], l["mkt"])]) / sd[(g["season"], l["mkt"])]
                l["k"] = 1.0
    return games


def rel(a, b):
    """(group, key) of a pair in the lab's table, or None for pairs the lab never needs (a side with a side)."""
    A, B = a["cat"], b["cat"]
    if A == "total" or B == "total":
        o = b if A == "total" else a
        return None if o["cat"] in ("total", "side") else ("total", o["cat"])
    if A == "side" or B == "side":
        if A == "side" and B == "side":
            return None
        s, o = (a, b) if A == "side" else (b, a)
        return ("side_own" if s["team"] == o["team"] else "side_opp", o["cat"])
    k = "|".join(sorted((A, B)))
    if a["team"] == b["team"] and a["who"] == b["who"]:
        return None if a["mkt"] == b["mkt"] else ("same", k)
    return ("team" if a["team"] == b["team"] else "opp", k)


def fit(games, seasons):
    S = defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0.0, 0.0])      # n, sum xy, sum x2, sum y2, sum k_a k_b
    for g in games:
        if g["season"] not in seasons:
            continue
        L = [l for l in g["legs"] if not l["push"]]
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                r = rel(L[i], L[j])
                if not r:
                    continue
                c = S[r]
                c[0] += 1; c[1] += L[i]["z"] * L[j]["z"]; c[2] += L[i]["z"] ** 2; c[3] += L[j]["z"] ** 2; c[4] += L[i]["k"] * L[j]["k"]
    T = defaultdict(dict)
    for (grp, key), c in S.items():
        if c[0] < 20 or c[2] <= 0 or c[3] <= 0:
            continue
        r_obs = c[1] / math.sqrt(c[2] * c[3])
        r = r_obs / max(0.3, c[4] / c[0])                      # back to the latent scale (1 for two continuous legs)
        r = max(-CAP, min(CAP, r * c[0] / (c[0] + SHRINK)))
        T[grp][key] = {"r": round(r, 3), "n": c[0]}
    return T


def lookup(T, a, b, old=False):
    r = rel(a, b)
    if not r:
        return 0.0
    grp, key = r
    if old:
        return OLD.get(grp, {}).get(key, 0.3 if grp == "same" else 0.0)
    return (T.get(grp, {}).get(key) or {}).get("r", 0.0)


def logit(p):
    p = min(1 - 1e-6, max(1e-6, p)); return math.log(p / (1 - p))


def calib(games, seasons):
    """Per market, the logit shift that makes the legs' chances match how often they hit (fitted on `seasons`), so a
    correlation is fitted on dependence, not on a market's prices running a little high or low."""
    acc = defaultdict(list)
    for g in games:
        if g["season"] in seasons:
            for l in g["legs"]:
                if not l["push"]:
                    acc[l["mkt"]].append((l["p"], l["y"]))
    sh = {}
    for m, xs in acc.items():
        lo, hi = -2.0, 2.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if sum(1 / (1 + math.exp(-(logit(p) + mid))) for p, _ in xs) < sum(y for _, y in xs):
                lo = mid
            else:
                hi = mid
        sh[m] = (lo + hi) / 2
    return sh


def pc(l, sh):
    return 1 / (1 + math.exp(-(logit(l["p"]) + sh.get(l["mkt"], 0.0))))


def pairs(games, seasons):
    for g in games:
        if g["season"] not in seasons:
            continue
        L = [l for l in g["legs"] if not l["push"]]
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                r = rel(L[i], L[j])
                if r:
                    yield r, L[i], L[j]


def fit_mle(games, seasons, sh, cap=12000):
    """Each cell's correlation as the one that best predicts how often its two-leg pairs both hit (log loss over a
    grid, -0.6 to 0.9), on calibrated chances; shrunk toward 0 by n / (n + 80)."""
    import random
    random.seed(7)
    cells = defaultdict(list)
    for r, a, b in pairs(games, seasons):
        cells[r].append((pc(a, sh), pc(b, sh), a["y"] * b["y"]))
    T = defaultdict(dict)
    grid = [x / 20 for x in range(-12, 19)]
    for (grp, key), xs in cells.items():
        if len(xs) < 40:
            continue
        smp = random.sample(xs, cap) if len(xs) > cap else xs
        best = min(grid, key=lambda rho: sum(-(y * math.log(max(1e-6, q)) + (1 - y) * math.log(max(1e-6, 1 - q)))
                                              for pa, pb, y in smp for q in (bvn_upper(pa, pb, rho),)))
        T[grp][key] = {"r": round(best * len(xs) / (len(xs) + SHRINK), 3), "n": len(xs)}
    return T


def judge2(games, T, sh, test):
    out = {"indep": 0.0, "old": 0.0, "fit": 0.0}
    n = hits = 0
    by = defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0])
    for (grp, key), a, b in pairs(games, (test,)):
        if grp.startswith("side") and False:
            continue
        pa, pb, y = pc(a, sh), pc(b, sh), a["y"] * b["y"]
        n += 1; hits += y
        for k, rho in (("indep", 0.0), ("old", lookup(T, a, b, old=True)), ("fit", lookup(T, a, b))):
            q = max(1e-4, min(1 - 1e-4, bvn_upper(pa, pb, rho)))
            out[k] += -(y * math.log(q) + (1 - y) * math.log(1 - q))
        c = by[grp]; c[0] += 1; c[1] += y; c[2] += bvn_upper(pa, pb, lookup(T, a, b)); c[3] += bvn_upper(pa, pb, lookup(T, a, b, old=True)); c[4] += pa * pb
    return {k: v / max(n, 1) for k, v in out.items()}, n, hits, by


def judge(games, T):
    """2026 same-game two-leg parlays of overs: log loss of the joint chance, three ways."""
    out = {"indep": [0, 0.0], "old": [0, 0.0], "fit": [0, 0.0]}
    hits = n = 0
    by = defaultdict(lambda: [0, 0.0, 0.0, 0.0])
    for g in games:
        if g["season"] != 2026:
            continue
        L = [l for l in g["legs"] if not l["push"] and l["cat"] != "side"]
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                a, b = L[i], L[j]
                if not rel(a, b):
                    continue
                y = a["y"] * b["y"]
                n += 1; hits += y
                for k, rho in (("indep", 0.0), ("old", lookup(T, a, b, old=True)), ("fit", lookup(T, a, b))):
                    p = max(1e-4, min(1 - 1e-4, bvn_upper(a["p"], b["p"], rho)))
                    out[k][0] += 1; out[k][1] += -(y * math.log(p) + (1 - y) * math.log(1 - p))
                grp = rel(a, b)[0]
                pf = bvn_upper(a["p"], b["p"], lookup(T, a, b)); pi = a["p"] * b["p"]
                by[grp][0] += 1; by[grp][1] += y; by[grp][2] += pf; by[grp][3] += pi
    return out, n, hits, by


def js(T):
    """The table as studio-lab.js reads it."""
    def obj(d):
        return "{" + ", ".join(f"'{k}': {v['r']}" for k, v in sorted(d.items(), key=lambda kv: -kv[1]["n"])) + "}"
    return "\n".join([
        f"  var SAME_PLAYER = {obj(T.get('same', {}))};",
        f"  var TEAMMATES = {obj(T.get('team', {}))};",
        f"  var OPPONENTS = {obj(T.get('opp', {}))};",
        f"  var SIDE_OWN = {obj(T.get('side_own', {}))};",
        f"  var SIDE_OPP = {obj(T.get('side_opp', {}))};",
        f"  var TOTAL = {obj(T.get('total', {}))};"])


def main():
    games = build()
    if "--pearson" not in sys.argv:     # the default: calibrated chances, each cell fitted on its pairs' joint hits
        for tr, te in ((2025, 2026), (2026, 2025)):
            sh = calib(games, (tr,))
            Tm = fit_mle(games, (tr,), sh)
            out, n, hits, by = judge2(games, Tm, sh, te)
            print(f"fit on {tr}, judged on {te}: {n} same-game two-leg pairs, {hits} both hit ({100 * hits / max(n, 1):.1f}%)")
            print(f"  log loss: independent {out['indep']:.5f}  old hand-set {out['old']:.5f}  fitted {out['fit']:.5f}")
            for grp, (m, y, pf, po, pi) in sorted(by.items(), key=lambda kv: -kv[1][0]):
                print(f"    {grp:9s} {m:6d}  both hit {100 * y / m:5.1f}%  fitted {100 * pf / m:5.1f}%  old {100 * po / m:5.1f}%  multiplied {100 * pi / m:5.1f}%")
        shA = calib(games, (2025, 2026))
        TA = fit_mle(games, (2025, 2026), shA)
        print("\nfitted on 2025 + 2026 (r, pairs):")
        for grp in ("same", "team", "opp", "side_own", "side_opp", "total"):
            cells = sorted(TA.get(grp, {}).items(), key=lambda kv: -kv[1]["n"])
            print(f"  {grp:9s} " + ", ".join(f"{k} {v['r']:+.2f} ({v['n']})" for k, v in cells))
        print("\n// studio-lab.js\n" + js(TA))
        if "--json" in sys.argv:
            json.dump(TA, open(os.path.join(os.environ.get("TMPDIR", "/tmp"), "nfl_sgp_corr.json"), "w"), indent=1)
        return
    nl = sum(len(g["legs"]) for g in games)
    print(f"{len(games)} games, {nl} graded Onyx lines (2025: {sum(1 for g in games if g['season'] == 2025)} games, 2026: {sum(1 for g in games if g['season'] == 2026)})")
    T25 = fit(games, (2025,))
    out, n, hits, by = judge(games, T25)
    print(f"\n2026 same-game two-leg parlays of overs (held out from the 2025 fit): {n} pairs, {hits} hit ({100 * hits / max(n, 1):.1f}%)")
    for k, lab in (("indep", "independent (legs multiplied)"), ("old", "the old hand-set table"), ("fit", "fitted on 2025")):
        print(f"  log loss {out[k][1] / max(out[k][0], 1):.5f}  {lab}")
    print("\n  by relation (2026): pairs, hit rate, fitted joint chance, legs multiplied")
    for grp, (m, y, pf, pi) in sorted(by.items(), key=lambda kv: -kv[1][0]):
        print(f"    {grp:9s} {m:6d}  hit {100 * y / m:5.1f}%  fitted {100 * pf / m:5.1f}%  multiplied {100 * pi / m:5.1f}%")
    T = fit(games, (2025, 2026))
    if "--json" in sys.argv:
        print(json.dumps(T, indent=1))
        return
    print("\nfitted on 2025 + 2026 (r, pairs), every cell:")
    for grp in ("same", "team", "opp", "side_own", "side_opp", "total"):
        cells = sorted(T.get(grp, {}).items(), key=lambda kv: -kv[1]["n"])
        print(f"  {grp:9s} " + ", ".join(f"{k} {v['r']:+.2f} ({v['n']})" for k, v in cells))
    print("\n// studio-lab.js\n" + js(T))


if __name__ == "__main__":
    main()
