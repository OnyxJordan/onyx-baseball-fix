#!/usr/bin/env python3
"""
fb_totals_bt.py - football game totals, pace x efficiency, priced against Onyx (dev only; 11/10, task #77,
Jordan 11/8: "push CFB to Tuesday").

totals_audit.py showed the pace model's totals are closer to the final than the ratings model's (CFB MAE 13.12 vs
13.42) but never priced a bet. This walks every game in data/picks/lines/<sport>.json forward (each fit sees only
games before that day) and prices the over/under at Onyx's OPENING and CLOSING prices:

    ratings   the live model's additive points ratings (cfb_model / nfl_model GAME_P)
    pace      plays (tempo vs plays allowed) x points per 100 plays (offense vs defense)
    ypp       plays x yards per play (offense vs defense) x the league's points per yard so far
    mix       mean of pace and ratings

P(over) = Normal(projection, sd) with sd fitted on the tuning season; blended with the no-vig price at weight w;
a bet when the edge over the price's implied chance is inside [emin, emax] and the price is -200..+150 (the
live lanes' rule). Rules are chosen on the TUNE window only (before the split) and reported on the held-out TEST
window, by tuning month as well, against Jordan's bar (CLAUDE.md, 11/3): 60+ held-out bets, ROI +2% or better at
the open AND the close, no tuning month worse than -5% on 30+ bets.

    python3 tools/fb_totals_bt.py cfb [nfl]
"""
import json, math, os, sys
from collections import defaultdict
from datetime import date, timedelta
from statistics import mean, pstdev

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import team_model as T          # noqa: E402
from totals_audit import pace_fit, MOD   # noqa: E402

SPLIT = "2026-03-01"
DEBIAS = "--debias" in sys.argv


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def imp(a):
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def payout(a):
    return a / 100 if a > 0 else 100 / -a


def ypp_fit(res, pace, as_of, P):
    """plays x yards per play x points per yard (league, games before as_of)"""
    G_pl, G_yp, pts, yds = [], [], 0.0, 0.0
    for g in res:
        if g["date"] >= as_of:
            continue
        b = pace.get(str(g["id"])) or {}
        h, a = b.get(g["home"]) or {}, b.get(g["away"]) or {}
        if not (h.get("plays") and a.get("plays") and h.get("yds") and a.get("yds")) or g.get("hs") is None:
            continue
        base = {"date": g["date"], "home": g["home"], "away": g["away"], "neutral": g.get("neutral")}
        G_pl.append(dict(base, hs=h["plays"], **{"as": a["plays"]}))
        G_yp.append(dict(base, hs=h["yds"] / h["plays"], **{"as": a["yds"] / a["plays"]}))
        pts += g["hs"] + g["as"]
        yds += h["yds"] + a["yds"]
    Pp = dict(P, home=P.get("home_plays", 0.0), ridge=P.get("ridge_pace", 3))
    Py = dict(P, home=P.get("home_ypp", 0.3), ridge=P.get("ridge_ypp", 3))
    Rl, Ry = T.fit(G_pl, as_of, Pp), T.fit(G_yp, as_of, Py)
    ppy = pts / yds if yds else 0.07

    def expect(home, away, neutral=False):
        ph, pa = T.expect(Rl, home, away, neutral)
        yh, ya = T.expect(Ry, home, away, neutral)
        return ph * yh * ppy, pa * ya * ppy
    return expect, Rl["n"]


def games(key, variants):
    M = __import__(MOD[key])
    GP = M.GAME_P if key == "nfl" else M.P
    res = json.load(open(f"data/{key}/results.json"))["games"]
    lines = json.load(open(f"data/picks/lines/{key}.json"))
    pace = json.load(open(f"data/{key}/pace.json"))
    teams = json.load(open(f"data/{key}/teams_espn.json")) if os.path.exists(f"data/{key}/teams_espn.json") else {}
    by = defaultdict(list)
    for g in res:
        if g.get("hs") is not None:
            by[g["date"]].append(g)
    cache, rows = {}, []
    for fid, x in sorted(lines.items(), key=lambda kv: kv[1].get("start") or ""):
        tp = ((x.get("game") or {}).get("total_points") or {})
        ov, un = tp.get("over") or {}, tp.get("under") or {}
        if x.get("hs") is None or not x.get("start"):
            continue
        d0 = x["start"][:10]
        g = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
            c = [y for y in by.get(dd, []) if int(y["hs"]) == int(x["hs"]) and int(y["as"]) == int(x["as"])]
            if len(c) == 1:
                g = c[0]
                break
        if not g:
            continue
        d = g["date"]
        if d not in cache:
            R = M.ratings(f"data/{key}", res, d, teams) if hasattr(M, "ratings") else T.fit(res, d, GP)
            cache[d] = {"R": R}
            for name, (fn, P) in variants.items():
                cache[d][name] = fn(res, pace, d, dict(GP, **P))
        C = cache[d]
        R = C["R"]
        mg = GP.get("min_games", 3)
        if R["n"].get(g["home"], 0) < mg or R["n"].get(g["away"], 0) < mg:
            continue
        eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
        proj = {"ratings": eh + ea}
        ok = True
        for name in variants:
            ex, n = C[name]
            if n.get(g["home"], 0) < 3 or n.get(g["away"], 0) < 3:
                ok = False
                break
            ph, pa = ex(g["home"], g["away"], g.get("neutral"))
            proj[name] = ph + pa
        if not ok:
            continue
        if "pace" in proj:
            proj["mix"] = (proj["pace"] + proj["ratings"]) / 2
        px = {}
        for k in ("o", "c"):
            o, u = ov.get(k), un.get(k)
            if o and u and o[0] is not None and o[1] is not None and u[1] is not None and o[0] == u[0]:
                px[k] = (o[0], o[1], u[1])
        if not px:
            continue
        rows.append({"date": d, "final": g["hs"] + g["as"], "proj": proj, "px": px, "game": f"{g['away']} @ {g['home']}"})
    return rows


def bets(rows, var, sd, w, emin, emax, at):
    out = []
    for r in rows:
        if at not in r["px"]:
            continue
        line, po, pu = r["px"][at]
        pm = 1 - ncdf((line - r["proj"][var]) / sd)
        io, iu = imp(po), imp(pu)
        fair = io / (io + iu)
        p = w * pm + (1 - w) * fair
        for side, pr, ps in (("over", po, p), ("under", pu, 1 - p)):
            e = ps - imp(pr)
            if emin <= e <= emax and -200 <= pr <= 150:
                if r["final"] == line:
                    res = 0.0
                else:
                    won = r["final"] > line if side == "over" else r["final"] < line
                    res = payout(pr) if won else -1.0
                out.append({"date": r["date"], "res": res, "side": side})
                break
    return out


def roi(b):
    return (sum(x["res"] for x in b) / len(b) * 100) if b else 0.0


def rec(b):
    w = sum(1 for x in b if x["res"] > 0)
    l = sum(1 for x in b if x["res"] < 0)
    return f"{w}-{l}"


def logloss(rows, var, sd, w, at):
    s, n = 0.0, 0
    for r in rows:
        if at not in r["px"] or r["final"] == r["px"][at][0]:
            continue
        line, po, pu = r["px"][at]
        io, iu = imp(po), imp(pu)
        fair = io / (io + iu)
        p = w * (1 - ncdf((line - r["proj"][var]) / sd)) + (1 - w) * fair
        p = min(max(p, 1e-6), 1 - 1e-6)
        y = r["final"] > line
        s -= math.log(p if y else 1 - p)
        n += 1
    return s / n if n else None


def run(key):
    VAR = {}
    for hl in (45, 90, 365):
        for rg in (2, 6):
            VAR[f"pace_h{hl}_r{rg}"] = (pace_fit, {"half_life": hl, "ridge_pace": rg, "ridge_ppp": rg})
            VAR[f"ypp_h{hl}_r{rg}"] = (ypp_fit, {"half_life": hl, "ridge_pace": rg, "ridge_ypp": rg * 0.02})
    rows = games(key, VAR)
    tune = [r for r in rows if r["date"] < SPLIT]
    test = [r for r in rows if r["date"] >= SPLIT]
    print(f"\n== {key}: {len(rows)} priced games, tune {len(tune)} (to {SPLIT}), test {len(test)}")

    def mae(rs, v):
        return mean(abs(r["proj"][v] - r["final"]) for r in rs)
    # pick each family's best fit by TUNE accuracy only
    fams = {"ratings": "ratings"}
    for fam in ("pace", "ypp"):
        best = min((v for v in VAR if v.startswith(fam + "_")), key=lambda v: mae(tune, v))
        fams[fam] = best
    for r in rows:
        r["proj"]["mix"] = (r["proj"][fams["pace"]] + r["proj"]["ratings"]) / 2
        r["proj"]["mix_ypp"] = (r["proj"][fams["ypp"]] + r["proj"]["ratings"]) / 2
    fams["mix"] = "mix"
    fams["mix_ypp"] = "mix_ypp"
    cl = lambda rs: mean(abs(r["px"].get("c", r["px"].get("o"))[0] - r["final"]) for r in rs)
    op = lambda rs: mean(abs(r["px"].get("o", r["px"].get("c"))[0] - r["final"]) for r in rs)
    print(f"   MAE vs final (tune | test):  open line {op(tune):.2f} | {op(test):.2f}   close line {cl(tune):.2f} | {cl(test):.2f}")
    out = {}
    for fam, v in fams.items():
        sd = pstdev([r["proj"][v] - r["final"] for r in tune]) or 17
        bias = mean(r["proj"][v] - r["final"] for r in tune)
        if DEBIAS:      # the tuning season's bias taken off every projection (tune and test alike)
            for r in rows:
                r["proj"][v + "_db"] = r["proj"][v] - bias
            v = v + "_db"
        print(f"   {fam:8s} ({v}) MAE {mae(tune, v):.2f} | {mae(test, v):.2f}   tune bias {bias:+.2f}  sd {sd:.1f}")
        # rules from the tune window at the OPEN price
        best = None
        for w in (0.1, 0.2, 0.3, 0.5):
            for emin in (0.02, 0.03, 0.04, 0.05):
                for emax in (0.10, 0.15):
                    b = bets(tune, v, sd, w, emin, emax, "o")
                    if len(b) < 40:
                        continue
                    sc = roi(b)
                    if best is None or sc > best[0]:
                        best = (sc, w, emin, emax)
        if not best:
            print("      no rule with 40+ tuning bets")
            continue
        _, w, emin, emax = best
        res = {"var": v, "w": w, "emin": emin, "emax": emax, "sd": round(sd, 2)}
        for lab, rs in (("tune", tune), ("test", test)):
            for at in ("o", "c"):
                b = bets(rs, v, sd, w, emin, emax, at)
                res[f"{lab}_{at}"] = (len(b), rec(b), round(roi(b), 1))
        months = defaultdict(list)
        for x in bets(tune, v, sd, w, emin, emax, "o"):
            months[x["date"][:7]].append(x)
        worst = min(((m, roi(b), len(b)) for m, b in months.items() if len(b) >= 30), key=lambda z: z[1], default=None)
        ll = (logloss(test, v, sd, w, "c"), logloss(test, v, sd, 0.0, "c"))
        n_t, r_o, r_c = res["test_o"][0], res["test_o"][2], res["test_c"][2]
        passed = n_t >= 60 and r_o >= 2 and r_c >= 2 and (worst is None or worst[1] > -5)
        print(f"      rule w {w} edge {emin:.2f}-{emax:.2f}: tune open {res['tune_o']} close {res['tune_c']}")
        print(f"      TEST  open {res['test_o']}  close {res['test_c']}   log loss at close {ll[0]:.4f} vs Onyx {ll[1]:.4f}"
              f"   worst tuning month {worst}   -> {'PASSES' if passed else 'does not pass'} the bar")
        res["passed"] = passed
        out[fam] = res
    return out


if __name__ == "__main__":
    R = {k: run(k) for k in ([a for a in sys.argv[1:] if not a.startswith("--")] or ["cfb"])}
    json.dump(R, open("/dev/stdout", "w"), indent=None, default=str)
    print()
