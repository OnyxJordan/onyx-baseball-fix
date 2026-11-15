#!/usr/bin/env python3
"""
cbb_v3_backtest.py - dev only (11/15). The evidence for cbb_model v3 (honest chances): which margin shape,
total adjustment and blend weight make the college basketball chance honest against Onyx's price, and
whether any of them makes the best-value lists (daily_top.tops: edge > 0, -200 or longer, 50%+, top 5 a
market a day, one per game) profitable on games that were never used to choose it.

    python3 tools/cbb_v3_backtest.py CACHE_DIR --build [--bt /path/to/bt/cbb_lines.json]   # once, about 10 minutes
    python3 tools/cbb_v3_backtest.py CACHE_DIR                  # v2 against v3 by window
    python3 tools/cbb_v3_backtest.py CACHE_DIR --grid spread|total [--choose ch1925|ch2025|on26o] [--by ll|roi]

--build writes CACHE_DIR/cbb_{close,onyx}{,_k100,_k114}.json: one row per game market and price snapshot with
the model's projected points from ratings fitted on games before the game's date (cbb_model.ratings, v3's
stretch switched off so the shape can be re-applied here), at PRIOR_KEEP 0.85 / 1.0 / 1.14:
  close  ESPN providers' closing spread and total with prices (data/cbb/situations_hist.json), 2018-19 on
  onyx   Onyx's opening ("o") and closing ("c") moneyline, spread and total (tools/cbb_price_backtest.samples)
Windows: ch2025 / ch1924 / ch1925 = closing lines 2024-25, 2018-24, 2018-25 (the choose sets); cl2026, cl2027
= closing lines 2025-26, 2026-27; on26o/c, on27o/c = Onyx 2025-26 and 2026-27 at the open / close (judged).
Log loss is reported as the blended chance's log loss minus Onyx's (or the closing book's) no-vig price, x1e4.
"""
import itertools, json, math, os, sys, time
from datetime import date
from multiprocessing import Pool

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
import cbb_model as M        # noqa: E402
import team_model as T       # noqa: E402

LANE = os.path.join(ROOT, "data", "cbb")
OFF = {"early": 1.0, "late": 1.0, "games": 0}
KEEPS = {"": 0.85, "_k100": 1.0, "_k114": 1.14}


# ── build ─────────────────────────────────────────────────────────────────────────────────────
def team_gp(games):
    gp, out = {}, {}
    for g in sorted(games, key=lambda g: (g["date"], g["id"])):
        out[g["id"]] = (gp.get((g["season"], g["home"]), 0), gp.get((g["season"], g["away"]), 0))
        for t in (g["home"], g["away"]):
            gp[(g["season"], t)] = gp.get((g["season"], t), 0) + 1
    return out


def hist_games():
    h = json.load(open(os.path.join(LANE, "situations_hist.json")))
    out = []
    for row in h["rows"]:
        r = dict(zip(h["cols"], row))
        if r["hs"] is None or r["as"] is None:
            continue
        d = r["d"]
        out.append({"id": str(r["id"]), "date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "season": r["s"], "home": r["h"], "away": r["a"],
                    "hs": float(r["hs"]), "as": float(r["as"]), "neutral": bool(r["neu"]), "sp": r["sp"], "tot": r["tot"],
                    "hpr": r["hpr"], "apr": r["apr"], "opr": r["opr"], "upr": r["upr"]})
    return out


def walk(args):
    season, keep = args
    M.PRIOR_KEEP, M.STRETCH = keep, OFF
    nm = json.load(open(os.path.join(LANE, "teams_espn.json")))
    games = [g for g in hist_games() if g["season"] == season]
    E, fit = {}, {}
    for g in sorted(games, key=lambda g: g["date"]):
        if g["sp"] is None and g["tot"] is None:
            continue
        if g["date"] not in fit:
            fit = {g["date"]: M.ratings(LANE, games, g["date"], nm)}
        R = fit[g["date"]]
        if R["n"].get(g["home"], 0) >= M.P["min_games"] and R["n"].get(g["away"], 0) >= M.P["min_games"]:
            E[g["id"]] = T.expect(R, g["home"], g["away"], g.get("neutral"))
    return season, E


def build(cache, bt):
    os.makedirs(cache, exist_ok=True)
    allg = hist_games()
    gpc = team_gp(allg)
    seasons = sorted({g["season"] for g in allg})
    res = json.load(open(os.path.join(LANE, "results.json")))["games"]
    gpo, gi = team_gp(res), {g["id"]: g for g in res}
    for tag, keep in KEEPS.items():
        t0 = time.time()
        with Pool(4) as pool:
            E = dict(pool.map(walk, [(s, keep) for s in seasons]))
        out = []
        for g in allg:
            if g["id"] not in E.get(g["season"], {}):
                continue
            eh, ea = E[g["season"]][g["id"]]
            m, tot = g["hs"] - g["as"], g["hs"] + g["as"]
            base = {"date": g["date"], "gid": g["id"], "season": g["season"], "eh": eh, "ea": ea, "hs": g["hs"], "as": g["as"],
                    "neutral": int(g["neutral"]), "gp_h": gpc[g["id"]][0], "gp_a": gpc[g["id"]][1], "when": "c"}
            if g["sp"] is not None and m + g["sp"] != 0 and g["hpr"] is not None and g["apr"] is not None:
                out.append(dict(base, mkt="spread", over=g["hpr"], under=g["apr"], y=int(m + g["sp"] > 0), line=g["sp"]))
            if g["tot"] is not None and tot != g["tot"] and g["opr"] is not None and g["upr"] is not None:
                out.append(dict(base, mkt="total", over=g["opr"], under=g["upr"], y=int(tot > g["tot"]), line=g["tot"]))
        json.dump({"rows": out}, open(os.path.join(cache, f"cbb_close{tag}.json"), "w"))
        print(f"close{tag}: {len(out)} rows, {time.time() - t0:.0f}s", flush=True)
        import cbb_price_backtest as PB
        import picks_lines as PL
        M.PRIOR_KEEP, M.STRETCH = keep, OFF
        S, _ = PB.samples(PL.lines("cbb", bt) if bt else PL.lines("cbb"))
        out = []
        for r in S:
            g = gi[r["gid"]]
            out.append(dict(r, season=g["season"], neutral=int(bool(g.get("neutral"))), gp_h=gpo[r["gid"]][0], gp_a=gpo[r["gid"]][1]))
        json.dump({"rows": out}, open(os.path.join(cache, f"cbb_onyx{tag}.json"), "w"))
        print(f"onyx{tag}: {len(out)} rows", flush=True)


# ── evaluate ──────────────────────────────────────────────────────────────────────────────────
def imp(p):
    a = np.abs(p)
    return np.where(p > 0, 100 / (a + 100), a / (a + 100))


def dec(p):
    a = np.abs(p)
    return np.where(p > 0, 1 + a / 100, 1 + 100 / np.maximum(a, 1))


def ncdf(x):
    x = np.asarray(x, float) / math.sqrt(2)
    s, a = np.sign(x), np.abs(x)
    t = 1 / (1 + 0.3275911 * a)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-a * a)
    return 0.5 * (1 + s * y)


def load(path):
    rows = [r for r in json.load(open(path))["rows"] if r.get("over") is not None and r.get("under") is not None]
    D = {k: np.array([float(r.get(k) or 0.0) for r in rows]) for k in ("eh", "ea", "hs", "as", "over", "under", "y", "neutral", "gp_h", "gp_a", "season", "line")}
    for k in ("mkt", "when", "date", "gid"):
        D[k] = np.array([r[k] for r in rows])
    D["gpm"] = np.minimum(D["gp_h"], D["gp_a"])
    by = {}      # rolling scoring level: mean(actual - projected total) of the season's games in the last N days
    for r in rows:
        by.setdefault(r["season"], {}).setdefault(r["gid"], (date.fromisoformat(r["date"]).toordinal(), r["hs"] + r["as"] - r["eh"] - r["ea"]))
    lev = {}
    for s, G in by.items():
        L = sorted(G.values()); od = np.array([x[0] for x in L]); cs = np.concatenate([[0], np.cumsum([x[1] for x in L])])
        for dd in set(od.tolist()):
            for win in (7, 14, 28):
                lo, hi = np.searchsorted(od, dd - win), np.searchsorted(od, dd)
                lev[(s, dd, win)] = ((cs[hi] - cs[lo]) / (hi - lo) if hi > lo else 0.0, hi - lo)
    for win in (7, 14, 28):
        x = [lev[(r["season"], date.fromisoformat(r["date"]).toordinal(), win)] for r in rows]
        D[f"lev{win}"] = np.array([a if n >= 20 else 0.0 for a, n in x])
    return D


def sub(D, m):
    return {k: v[m] for k, v in D.items()}


BASE = dict(k_e=1.0, k_l=1.0, early_gp=12, dh=0.0, ts=0.0, tlev=0.0, lwin=14, tb=0.0, sdm=M.P["sd_margin"], sdt=M.P["sd_total"],
            w_spread=0.3, w_total=0.3, w_ml=0.3, wG=0, wfloor=0.0)
V3 = dict(BASE, k_e=M.STRETCH["early"], k_l=M.STRETCH["late"], early_gp=M.STRETCH["games"],
          w_spread=M.BLEND_W["spread"], w_total=M.BLEND_W["total"], w_ml=M.BLEND_W["ml"])


def fair(D):
    a, b = imp(D["over"]), imp(D["under"])
    return a / (a + b)


def blended(D, c):
    m = (D["eh"] - D["ea"]) * np.where(D["gpm"] < c["early_gp"], c["k_e"], c["k_l"]) + np.where(D["neutral"] > 0, 0.0, c["dh"])
    t = D["eh"] + D["ea"] + c["ts"] + c["tlev"] * D[f"lev{c['lwin']}"]      # tempo term needs the prior's tempo; not in this cache
    mk = D["mkt"]
    p = np.where(mk == "ml", 1 - ncdf(-m / c["sdm"]),
                 np.where(mk == "spread", 1 - ncdf((-D["line"] - m) / c["sdm"]), 1 - ncdf((D["line"] - t) / c["sdt"])))
    w = np.where(mk == "ml", c["w_ml"], np.where(mk == "spread", c["w_spread"], c["w_total"]))
    if c["wG"]:
        w = w * (c["wfloor"] + (1 - c["wfloor"]) * np.clip(D["gpm"] / c["wG"], 0, 1))
    return w * p + (1 - w) * fair(D)


def ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(np.mean(-(y * np.log(p) + (1 - y) * np.log(1 - p))))


def best_list(D, po, n=5):
    evo, evu = po * dec(D["over"]) - 1, (1 - po) * dec(D["under"]) - 1
    over = evo >= evu
    prob, price = np.where(over, po, 1 - po), np.where(over, D["over"], D["under"])
    edge = prob - imp(price)
    win = np.where(over, D["y"] == 1, D["y"] == 0)
    prof = np.where(win, dec(price) - 1, -1.0)
    day = {}
    for i in np.nonzero((price >= -200) & (prob >= 0.5) & (edge > 0))[0]:
        day.setdefault((D["date"][i], D["mkt"][i]), []).append(i)
    sel = np.array([i for L in day.values() for i in sorted(L, key=lambda i: -edge[i])[:n]], int)
    return (len(sel), int(win[sel].sum()), float(prof[sel].sum())) if len(sel) else (0, 0, 0.0)


def fmt(t):
    n, w, p = t
    return f"{w}-{n - w} ({n}) {100 * p / n:+.1f}%" if n else "0 bets"


def windows(cache, tag=""):
    C, O = load(os.path.join(cache, f"cbb_close{tag}.json")), load(os.path.join(cache, f"cbb_onyx{tag}.json"))
    s, so, wo = C["season"], O["season"], O["when"]
    return {"ch2025": sub(C, s == 2025), "ch1924": sub(C, s <= 2024), "ch1925": sub(C, s <= 2025), "cl2026": sub(C, s == 2026),
            "cl2027": sub(C, s == 2027), "on26o": sub(O, (so == 2026) & (wo == "o")), "on26c": sub(O, (so == 2026) & (wo == "c")),
            "on27o": sub(O, (so == 2027) & (wo == "o")), "on27c": sub(O, (so == 2027) & (wo == "c"))}


def table(cache):
    Wd = windows(cache)
    for name, c in (("v2", BASE), ("v3", V3), ("v3, spread weight 0.1", dict(V3, w_spread=0.1))):
        print(f"\n=== {name}")
        for wn in ("ch1925", "cl2026", "cl2027", "on26o", "on26c", "on27o", "on27c"):
            D, parts, tot = Wd[wn], [], [0, 0, 0.0]
            for mk in ("spread", "total", "ml"):
                s = sub(D, D["mkt"] == mk)
                if not len(s["y"]):
                    continue
                pb = blended(s, c)
                t = best_list(s, pb)
                tot = [a + b for a, b in zip(tot, t)]
                parts.append(f"{mk} ll {1e4 * (ll(pb, s['y']) - ll(fair(s), s['y'])):+6.1f} list {fmt(t)}")
            print(f"  {wn:7} all {fmt(tuple(tot)):22} | " + " | ".join(parts))


def grid(cache, mkt, choose, by):
    if mkt == "spread":
        G = dict(k_e=[0.9, 1.0, 1.1, 1.2, 1.3], k_l=[0.9, 1.0, 1.1], early_gp=[6, 12], dh=[-1.0, 0.0, 1.0],
                 sdm=[9.0, 11.0, 13.0], w=[0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45], wG=[0, 8, 16], wfloor=[0.0, 0.5])
    else:
        G = dict(ts=[-1.0, 0.0, 1.0, 2.0, 3.0], tlev=[0.0, 0.5, 1.0], lwin=[7, 14, 28], sdt=[13.0, 15.0, 17.0],
                 w=[0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45], wG=[0, 8, 16], wfloor=[0.0, 0.5])
    res, n = [], 0
    for tag in KEEPS:
        S = {k: sub(D, D["mkt"] == mkt) for k, D in windows(cache, tag).items()}
        for vals in itertools.product(*G.values()):
            c = dict(BASE, **dict(zip(G, vals)))
            if (c["wG"] == 0 and c["wfloor"] > 0) or (mkt == "total" and c["tlev"] == 0 and c["lwin"] != 14):
                continue
            c["w_spread"] = c["w_total"] = c["w_ml"] = c["w"]
            n += 1
            pb = blended(S[choose], c)
            if by == "ll":
                res.append((ll(pb, S[choose]["y"]), tag, c))
            else:
                b = best_list(S[choose], pb)
                if b[0] >= (1000 if choose == "ch1925" else 200):
                    res.append((-b[2] / b[0], tag, c))
        if tag == "":
            S0 = S
    print(f"{n} configurations, chosen by {by} on {choose}")
    res.sort(key=lambda x: x[0])
    for v, tag, c in res[:10]:
        S = {k: sub(D, D["mkt"] == mkt) for k, D in windows(cache, tag).items()} if tag else S0
        print(f"{v:.4f} keep {KEEPS[tag]} " + " ".join(f"{k}={c[k]}" for k in G))
        print("    " + "  ".join(f"{k} {1e4 * (ll(blended(s, c), s['y']) - ll(fair(s), s['y'])):+.1f} {fmt(best_list(s, blended(s, c)))}"
                                for k, s in S.items() if k != choose))


if __name__ == "__main__":
    cache = sys.argv[1]
    if "--build" in sys.argv:
        build(cache, sys.argv[sys.argv.index("--bt") + 1] if "--bt" in sys.argv else None)
    elif "--grid" in sys.argv:
        a = sys.argv
        grid(cache, a[a.index("--grid") + 1], a[a.index("--choose") + 1] if "--choose" in a else "ch1925", a[a.index("--by") + 1] if "--by" in a else "ll")
    else:
        table(cache)
