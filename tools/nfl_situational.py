#!/usr/bin/env python3
"""
nfl_situational.py - every NFL prop line Onyx priced (2024 at market prices, 2025 and 2026 at Onyx's opening
price), what our projection said before kickoff, and how every situation would have done. Dev only (bt/ files).

Jordan (11/14): "backtest all of these sports with 50,000 backtests each and see what the results would have been
based on our projections situationally and start to make those adjustments to the projections starting with NFL";
"also what if we do this at X% if it's 55, 60, 65".

  1. Rows: tools/nfl_feature_screen.py --proj --role --pbp (pre-kickoff features, the opening line and prices, the
     actual). Projection: tools/nfl_proj_test.Proj (volume x efficiency), its parameters tuned on 2024 + 2025 only.
     Chance and side as the site makes them: the projection's chance (nfl_model.prob_over_volume / prob_over), blended
     with Onyx's no-vig price at the live weight, side picked by sports_lab.price_side; rushing yards and pass
     attempts use the live v11 market models (nfl_model.prob_v11, V11_SHOW).
  2. Rules: every combination of up to three conditions (side, our chance 50 to 70%, edge, price, home / road,
     favorite / underdog, implied points, wind, dome, cold, depth chart, teammates out, snap trend, line against
     his recent games, projection against the line, week of season, opponent defense, pace, thin history) for each
     market. Chosen on 2024 + 2025, judged on 2026, never the other way.
  3. Ranking a daily top N: most likely (today's lists), best value, chance cutoffs 55 / 60 / 65%.
  4. Calibration: our chance against what happened.
  5. Projection bias: actual over projected by situation, and whether it holds on 2026.
  6. Adjustments: multiplicative projection corrections fitted on 2024 + 2025, kept only if they cut 2026's error
     and do not hurt 2026's log loss.

    python3 tools/nfl_situational.py [--pickle path] [--out report.json]
"""
import itertools, json, math, os, pickle, sys, time
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import nfl_model as M          # noqa: E402
import sports_lab as L          # noqa: E402

STAT = {"rec": "receptions", "rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards",
        "pass_att": "attempts", "rush_rec_yds": "rush_rec_yds", "pass_rush_yds": "pass_rush_yds"}
TUNE, TEST = (2024, 2025), (2026,)


def load(pk):
    if pk and os.path.exists(pk):
        return pickle.load(open(pk, "rb")), None
    sys.argv = ["x", "--proj", "--role", "--pbp"]
    import nfl_feature_screen as S
    DATA, IX = S.main()
    if pk:
        pickle.dump(DATA, open(pk, "wb"))
    return DATA, IX


def _w(mkt):
    """The model's share of the chance shown (a 0 is a 0, not the default)."""
    v = (M.VOL_P.get(mkt) or {}).get("w")
    return v if v is not None else M.BLEND_W.get(mkt, 0.3)


def payout(price):
    return price / 100.0 if price > 0 else 100.0 / -price


def build_rows(DATA, IX):
    """Each line: projection, the side and chance the site would show, the result at the opening price."""
    import nfl_proj_test as PT
    PJ = PT.Proj(IX)
    base_P = {"tn": 4, "sp_a": 0.01, "sp_c": 0.015, "imp_v": 0.01, "d": 0.8, "snap": 0.5, "k_t": 40, "k_c": 60, "k_a": 150}
    grid = {"sp_a": [0.0, 0.01, 0.02], "imp_v": [0.0, 0.01, 0.02], "d": [0.7, 0.85], "snap": [0.0, 0.5, 1.0]}
    out, params = [], {}
    for mkt, rows in DATA.items():
        if mkt not in STAT:
            continue
        stat = STAT[mkt]
        tr = [r for r in rows if r["season"] in TUNE]
        best = None
        for vals in itertools.product(*grid.values()):
            P = dict(base_P, **dict(zip(grid, vals)))
            e, n = 0.0, 0
            for r in tr[::3]:            # every third tuning line: the grid only ranks parameter sets
                pr = PJ.project(r, stat, P)
                if pr is not None:
                    e += abs(pr - r["act"]); n += 1
            m = e / max(1, n)
            if best is None or m < best[0]:
                best = (m, P)
        P = best[1]
        params[mkt] = {k: P[k] for k in grid}
        w = _w(mkt)
        for r in rows:
            pr = PJ.project(r, stat, P)
            if pr is None or r.get("po") is None or r.get("pu") is None:
                continue
            if mkt in M.V11:
                ps = L.price_side(M.prob_v11(mkt, r["p"], r["f"]), r["po"], r["pu"], M.V11_SHOW.get(mkt, 1.0))
            elif mkt in M.VOL_P:
                ps = L.price_side(M.prob_over_volume(mkt, pr, r["line"]), r["po"], r["pu"], w)
            else:
                ps = L.price_side(M.prob_over(mkt, pr, r["line"]), r["po"], r["pu"], w)
            if not ps:
                continue
            won = (r["y"] == 1) == (ps["side"] == "over")
            out.append({"mkt": mkt, "season": r["season"], "date": r["date"], "week": r["week"], "team": r["team"],
                        "opp": r["opp"], "pid": r["pid"], "line": r["line"], "act": r["act"], "proj": pr, "y": r["y"],
                        "p_onyx": r["p"], "po": r["po"], "pu": r["pu"], "side": ps["side"], "chance": ps["prob"],
                        "implied": ps["implied"], "edge": ps["edge"], "price": ps["price"], "won": won,
                        "profit": payout(ps["price"]) if won else -1.0, "f": r["f"], "env": r["env"]})
    return out, params


# ── conditions: (family, name, predicate on a row) ─────────────────────────────
def conditions():
    C = []
    add = lambda fam, nm, fn: C.append((fam, nm, fn))
    for t in (0.55, 0.60, 0.65, 0.70):
        add("chance", f"chance {int(t*100)}%+", lambda r, t=t: r["chance"] >= t)
    add("edge", "edge > 0", lambda r: r["edge"] > 0)
    add("edge", "edge 2pp+", lambda r: r["edge"] >= 0.02)
    add("edge", "edge 4pp+", lambda r: r["edge"] >= 0.04)
    add("edge", "edge < 0", lambda r: r["edge"] < 0)
    add("price", "price -150 or shorter", lambda r: r["price"] <= -150)
    add("price", "price -149 to -111", lambda r: -150 < r["price"] <= -111)
    add("price", "price -110 or longer", lambda r: r["price"] > -111)
    add("venue", "home", lambda r: bool(r["env"][2]))
    add("venue", "road", lambda r: not r["env"][2])
    add("fav", "team favored by 3+", lambda r: (r["env"][1] or 0) <= -3)
    add("fav", "team underdog by 3+", lambda r: (r["env"][1] or 0) >= 3)
    add("fav", "close game (spread under 3)", lambda r: abs(r["env"][1] or 0) < 3)
    add("imp", "team implied 24+", lambda r: (r["env"][0] or 0) >= 24)
    add("imp", "team implied under 20", lambda r: (r["env"][0] or 99) < 20)
    add("wx", "wind 15+ mph", lambda r: (r["f"].get("wind") or 0) >= 15)
    add("wx", "dome", lambda r: bool(r["f"].get("dome")))
    add("wx", "cold (under 40F)", lambda r: bool(r["f"].get("cold")))
    add("depth", "depth chart starter", lambda r: (r["f"].get("depth") or 9) <= 1)
    add("depth", "not the starter", lambda r: (r["f"].get("depth") or 0) >= 2)
    add("vac", "teammate volume out", lambda r: (r["f"].get("vac_tgt") or 0) + (r["f"].get("vac_car") or 0) > 0)
    add("vac", "backup QB tonight", lambda r: (r["f"].get("vac_qb") or 0) > 0)
    add("snap", "snaps trending up", lambda r: (r["f"].get("snap_trend") or 0) > 0.05)
    add("snap", "snaps trending down", lambda r: (r["f"].get("snap_trend") or 0) < -0.05)
    add("lvl", "line above his last 5", lambda r: (r["f"].get("line_vs_l5") or 0) > 0.1)
    add("lvl", "line below his last 5", lambda r: (r["f"].get("line_vs_l5") or 0) < -0.1)
    add("gap", "projection 15%+ over the line", lambda r: r["proj"] >= 1.15 * r["line"])
    add("gap", "projection 15%+ under the line", lambda r: r["proj"] <= 0.85 * r["line"])
    add("gap", "projection within 5% of the line", lambda r: abs(r["proj"] - r["line"]) <= 0.05 * max(r["line"], 1))
    add("wk", "weeks 1-6", lambda r: r["week"] <= 6)
    add("wk", "weeks 7-12", lambda r: 7 <= r["week"] <= 12)
    add("wk", "weeks 13+", lambda r: r["week"] >= 13)
    add("hist", "under 4 games of history", lambda r: (r["f"].get("games_played") or 0) < 4)
    add("opp", "opponent pass defense weak", lambda r: (r["f"].get("opp_pass_epa") or 0) > 0.05)
    add("opp", "opponent pass defense strong", lambda r: (r["f"].get("opp_pass_epa") or 0) < -0.05)
    add("opp", "opponent run defense weak", lambda r: (r["f"].get("opp_rush_epa") or 0) > 0.03)
    add("opp", "opponent run defense strong", lambda r: (r["f"].get("opp_rush_epa") or 0) < -0.08)
    add("pace", "fast game (pace)", lambda r: (r["f"].get("game_pace") or 0) > 0.5)
    add("pace", "slow game (pace)", lambda r: (r["f"].get("game_pace") or 0) < -0.5)
    add("trend", "recent form up", lambda r: (r["f"].get("trend") or 0) > 0.5)
    add("trend", "recent form down", lambda r: (r["f"].get("trend") or 0) < -0.5)
    return C


def stats(mask, won, profit):
    n = int(mask.sum())
    if not n:
        return 0, 0, 0.0, None
    w = int(won[mask].sum())
    u = float(profit[mask].sum())
    return n, w, u, u / n


def grid(rows):
    """Every rule (market, which side, up to three conditions from different families), tuned and tested."""
    C = conditions()
    res, total = [], 0
    by_m = defaultdict(list)
    for r in rows:
        by_m[r["mkt"]].append(r)
    for mkt, rs in sorted(by_m.items()):
        cond = np.array([[fn(r) for (_, _, fn) in C] for r in rs], dtype=bool)
        season = np.array([r["season"] for r in rs])
        tune, test = np.isin(season, TUNE), np.isin(season, TEST)
        # three ways to bet each rule: the model's side, always the over, always the under (the over / under
        # results come from the line itself: y and the over / under opening prices)
        bets = {}
        msd = np.array([r["side"] == "over" for r in rs])
        won_m = np.array([r["won"] for r in rs]); pr_m = np.array([r["profit"] for r in rs])
        y = np.array([r["y"] == 1 for r in rs])
        pr_o = np.array([payout(r["po"]) if r["y"] == 1 else -1.0 for r in rs])
        pr_u = np.array([payout(r["pu"]) if r["y"] == 0 else -1.0 for r in rs])
        bets["model side"] = (won_m, pr_m, None)
        bets["over"] = (y, pr_o, None)
        bets["under"] = (~y, pr_u, None)
        idx = list(range(len(C)))
        combos = [()] + [(i,) for i in idx] + [c for c in itertools.combinations(idx, 2) if C[c[0]][0] != C[c[1]][0]] \
            + [c for c in itertools.combinations(idx, 3) if len({C[i][0] for i in c}) == 3]
        for how, (won, profit, _) in bets.items():
            for c in combos:
                mask = np.ones(len(rs), dtype=bool)
                for i in c:
                    mask &= cond[:, i]
                total += 1
                nt, wt, ut, rt = stats(mask & tune, won, profit)
                if nt < 60:
                    continue
                ne, we, ue, re_ = stats(mask & test, won, profit)
                res.append({"mkt": mkt, "bet": how, "rule": " + ".join(C[i][1] for i in c) or "every line",
                            "tune": [nt, wt, round(ut, 1), round(rt, 4)], "test": [ne, we, round(ue, 1), None if re_ is None else round(re_, 4)]})
    return res, total


def binom_p(w, n, p0):
    """One-sided chance of w+ wins in n at break-even rate p0 (normal approximation with continuity)."""
    if n == 0:
        return 1.0
    mu, sd = n * p0, math.sqrt(n * p0 * (1 - p0))
    z = (w - 0.5 - mu) / max(sd, 1e-9)
    return 0.5 * math.erfc(z / math.sqrt(2))


def ranking(rows, n_top=(5, 10)):
    """A daily top N on 2026 lines (each date's lines), by: most likely, best value, and chance cutoffs."""
    days = defaultdict(list)
    for r in rows:
        if r["season"] in TEST and r["price"] >= -200:
            days[r["date"]].append(r)
    out = {}
    rules = {
        "most likely (today)": (lambda r: r["chance"] >= 0.5, lambda r: -(r["chance"] + r["edge"] / 10)),
        "best value": (lambda r: r["edge"] > 0, lambda r: -r["edge"]),
        "chance 55%+, best value": (lambda r: r["chance"] >= 0.55 and r["edge"] > 0, lambda r: -r["edge"]),
        "chance 60%+, best value": (lambda r: r["chance"] >= 0.60 and r["edge"] > 0, lambda r: -r["edge"]),
        "chance 65%+, best value": (lambda r: r["chance"] >= 0.65 and r["edge"] > 0, lambda r: -r["edge"]),
        "chance 55%+, most likely": (lambda r: r["chance"] >= 0.55, lambda r: -r["chance"]),
        "chance 60%+, most likely": (lambda r: r["chance"] >= 0.60, lambda r: -r["chance"]),
        "chance 65%+, most likely": (lambda r: r["chance"] >= 0.65, lambda r: -r["chance"]),
    }
    for k, (ok, key) in rules.items():
        for N in n_top:
            sel = []
            for d, rs in days.items():
                c = sorted([r for r in rs if ok(r)], key=key)
                seen = set()
                for r in c:
                    if len([x for x in sel if x["date"] == d]) >= N:
                        break
                    if r["pid"] in seen:
                        continue
                    seen.add(r["pid"])
                    sel.append(r)
            n = len(sel); w = sum(r["won"] for r in sel); u = sum(r["profit"] for r in sel)
            out[f"{k} · top {N}"] = {"n": n, "w": w, "units": round(u, 1), "roi": round(u / n, 4) if n else None,
                                     "avg_chance": round(sum(r["chance"] for r in sel) / n, 4) if n else None}
    return out


def calibration(rows):
    out = {}
    for part, seasons in (("2024-25", TUNE), ("2026", TEST)):
        b = defaultdict(lambda: [0, 0, 0.0])
        for r in rows:
            if r["season"] in seasons:
                k = min(0.75, math.floor(r["chance"] * 20) / 20)
                b[k][0] += 1; b[k][1] += r["won"]; b[k][2] += r["chance"]
        out[part] = {f"{int(k*100)}-{int(k*100)+5}%": {"n": v[0], "claimed": round(v[2] / v[0], 3), "hit": round(v[1] / v[0], 3)} for k, v in sorted(b.items()) if v[0] >= 20}
    return out


def bias(rows):
    """Actual over projection by market and condition, 2024-25 against 2026."""
    C = conditions()
    out = []
    by_m = defaultdict(list)
    for r in rows:
        if r["proj"] > 0.5:
            by_m[r["mkt"]].append(r)
    for mkt, rs in by_m.items():
        for fam, nm, fn in [("all", "every line", lambda r: True)] + C:
            if fam in ("chance", "edge", "price"):
                continue
            a = [r for r in rs if fn(r)]
            t = [r for r in a if r["season"] in TUNE]; e = [r for r in a if r["season"] in TEST]
            if len(t) < 80 or len(e) < 30:
                continue
            rt = sum(r["act"] for r in t) / sum(r["proj"] for r in t)
            re_ = sum(r["act"] for r in e) / sum(r["proj"] for r in e)
            out.append({"mkt": mkt, "cond": nm, "n_tune": len(t), "ratio_tune": round(rt, 3), "n_test": len(e), "ratio_test": round(re_, 3)})
    return out


def logloss(ps, ys):
    return -sum(math.log(max(1e-6, p if y else 1 - p)) for p, y in zip(ps, ys)) / max(1, len(ys))


def adjust(rows):
    """Projection corrections: per market, a multiplier for each condition whose 2024-25 bias is 4%+ and held its
    sign on 2026 is a candidate; fitted as one multiplicative model on 2024-25 (log ratio least squares, shrunk),
    kept only if it cuts 2026's error and does not hurt 2026's log loss on the over."""
    C = [c for c in conditions() if c[0] not in ("chance", "edge", "price", "gap")]
    out = {}
    by_m = defaultdict(list)
    for r in rows:
        if r["proj"] > 0.5 and r["mkt"] not in M.V11:
            by_m[r["mkt"]].append(r)
    for mkt, rs in by_m.items():
        t = [r for r in rs if r["season"] in TUNE]; e = [r for r in rs if r["season"] in TEST]
        if len(t) < 300 or len(e) < 100:
            continue
        X = np.array([[1.0] + [float(fn(r)) for (_, _, fn) in C] for r in t])
        yv = np.array([math.log((max(r["act"], 0) + 1) / (r["proj"] + 1)) for r in t])
        lam = 25.0
        A = X.T @ X + lam * np.eye(X.shape[1]); A[0, 0] -= lam
        beta = np.linalg.solve(A, X.T @ yv)
        Xe = np.array([[1.0] + [float(fn(r)) for (_, _, fn) in C] for r in e])
        mult = np.exp(Xe @ beta)
        adj = [(r["proj"] + 1) * m - 1 for r, m in zip(e, mult)]
        mae0 = sum(abs(r["proj"] - r["act"]) for r in e) / len(e)
        mae1 = sum(abs(a - r["act"]) for a, r in zip(adj, e)) / len(e)
        w = _w(mkt)
        f = M.prob_over_volume if mkt in M.VOL_P else M.prob_over
        p0 = [L.blend(f(mkt, r["proj"], r["line"]), r["p_onyx"], w) for r in e]
        p1 = [L.blend(f(mkt, a, r["line"]), r["p_onyx"], w) for a, r in zip(adj, e)]
        ys = [r["y"] == 1 for r in e]
        # betting the model's side at the opening price, before and after
        def roi(ps):
            u, n = 0.0, 0
            for p, r in zip(ps, e):
                ps_ = L.price_side(None, r["po"], r["pu"], 0.0) if False else None
                fo = r["p_onyx"]
                side = "over" if (p - L.implied(r["po"])) * 1 >= ((1 - p) - L.implied(r["pu"])) else "under"
                edge = (p - L.implied(r["po"])) if side == "over" else ((1 - p) - L.implied(r["pu"]))
                if edge <= 0:
                    continue
                won = (r["y"] == 1) == (side == "over")
                u += payout(r["po"] if side == "over" else r["pu"]) if won else -1.0; n += 1
            return n, round(u, 1), round(u / n, 4) if n else None
        out[mkt] = {"terms": {nm: round(float(b), 4) for (_, nm, _), b in zip(C, beta[1:]) if abs(b) >= 0.02},
                    "intercept": round(float(beta[0]), 4), "mae_2026": [round(mae0, 3), round(mae1, 3)],
                    "logloss_2026": [round(logloss(p0, ys), 4), round(logloss(p1, ys), 4)],
                    "value_bets_2026": [roi(p0), roi(p1)], "kept": mae1 < mae0 and logloss(p1, ys) <= logloss(p0, ys)}
    return out


def main():
    pk = sys.argv[sys.argv.index("--pickle") + 1] if "--pickle" in sys.argv else None
    outp = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "nfl_situational.json"
    t0 = time.time()
    DATA, IX = load(pk)
    if IX is None:       # rows came from the pickle; the projection still needs the stats index
        sys.argv = ["x", "--proj", "--role", "--pbp"]
        import nfl_feature_screen as S
        DATA, IX = S.main()
    rows, params = build_rows(DATA, IX)
    print(f"{len(rows)} priced lines with a projection ({time.time() - t0:.0f}s); params {params}", flush=True)
    G, total = grid(rows)
    print(f"{total} rules tested, {len(G)} with 60+ bets in 2024-25 ({time.time() - t0:.0f}s)", flush=True)
    # the rules that looked good in 2024-25 (ROI 5%+ on 100+ bets): how did they do on 2026?
    good = [g for g in G if g["tune"][0] >= 100 and g["tune"][3] >= 0.05 and g["test"][0] >= 30]
    held = [g for g in good if g["test"][3] > 0]
    for g in good:
        n, w = g["test"][0], g["test"][1]
        be = 0.52     # about -110: the win rate a rule needs to break even (rough, for the significance test only)
        g["p_test"] = binom_p(w, n, be)
    # Benjamini-Hochberg at 10% over every rule judged on 2026
    ps = sorted(g["p_test"] for g in good)
    k_bh = max([i + 1 for i, p in enumerate(ps) if p <= 0.10 * (i + 1) / max(1, len(ps))] or [0])
    cut = ps[k_bh - 1] if k_bh else -1
    sig = sorted([g for g in good if g["p_test"] <= cut], key=lambda g: -g["test"][2])
    rep = {"rows": len(rows), "params": params, "rules_tested": total, "rules_60_tune": len(G),
           "good_in_tune": len(good), "positive_on_2026": len(held),
           "significant_on_2026_bh10": len(sig), "significant": sig[:60],
           "top_tune_then_test": sorted(good, key=lambda g: -g["tune"][3])[:60],
           "base": [g for g in G if g["rule"] == "every line"],
           "ranking_2026": ranking(rows), "calibration": calibration(rows), "bias": bias(rows), "adjust": adjust(rows)}
    json.dump(rep, open(outp, "w"), indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    print(json.dumps({k: rep[k] for k in ("rows", "rules_tested", "rules_60_tune", "good_in_tune", "positive_on_2026", "significant_on_2026_bh10")}))
    print(f"done ({time.time() - t0:.0f}s) -> {outp}")


if __name__ == "__main__":
    main()
