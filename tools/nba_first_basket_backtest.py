#!/usr/bin/env python3
"""
nba_first_basket_backtest.py - the first-basket model and its betting rule against
Onyx's real 2025-26 prices (dev only, never runs in the pipeline).

  python3 tools/nba_first_basket_backtest.py PBP_DIR ONYX_FB_PRICES [--jumps data/nba/jumps.json]

PBP_DIR         tools/nba_pbp_pull.py output (<date>/<event id>.json), 2024-25 and 2025-26
ONYX_FB_PRICES  {key: {start, home, away, props: {name: {first_basket_including_ft:
                 {o: [_, open], c: [_, close]}}}}} from tools/onyx_lines_pull.py

Labels. The game's first points (free throws count, Onyx's market) are the first
f2 / f3 / ft event in the play-by-play (made 2, made 3, made free throw). The
2026-10 scratch study used m2 / m3 / ft, and m2 / m3 are MISSED shots in this
format, so its "first scorer" was the first missed shot or made free throw: it
matched the real first scorer in 12% of games. Every number in open-v1 / open-v2
(57-476, +38%, "tip winner scores first 65%") was graded on that label.

Features, walk-forward (only games before the one being priced), exactly what the
page and open_lanes.fb_probs see on a game day:
  tip     each team's jumper = the starter with the most opening tips on record;
          his record [won, jumped] from every earlier tip (data/nba/jumps.json)
  usage   season FGA and minutes per game, games played (from the play-by-play)
  first   [starts, first shots] with this season x1, last x.5, the one before x.25
          (nba_jumps.first_shots; first shot = team's first field-goal attempt)

Model fit by log loss of the real first scorer on 2024-25, tested on 2025-26.
Betting rules are tuned on 2025-26 games before 2/1 and judged on 2/1 onward.
"""
import argparse, collections, glob, itertools, json, math, re, sys, unicodedata
from datetime import datetime, timedelta
from pathlib import Path

SCORE = ("f2", "f3", "ft")
FGA = ("f2", "f3", "m2", "m3")


def season(d):
    return int(d[:4]) if d[5:7] >= "08" else int(d[:4]) - 1


def nk(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def dec(a):
    return 1 + (a / 100 if a > 0 else 100 / -a)


# ── data ────────────────────────────────────────────────────────────────────
def build(pbp_dir, jumps_path):
    J = json.load(open(jumps_path))["games"]
    G = []
    for f in glob.glob(str(Path(pbp_dir) / "*" / "*.json")):
        g = json.load(open(f))
        G.append(g)
    G.sort(key=lambda g: (g["d"], g["id"]))
    stat = collections.defaultdict(lambda: [0.0, 0.0, 0, 0])   # (season, pid) -> fga, min, gp, starts
    fsh = collections.defaultdict(list)                       # pid -> [(season, started, first shot)]
    tips = collections.defaultdict(lambda: [0, 0])            # pid -> [won, jumped]
    rows = []
    for g in G:
        s = season(g["d"])
        st = {}
        for t, a, b, ids in g["stints"]:
            if a == 0.0 and t not in st:
                st[t] = list(ids)
        jg = J.get(g["id"]) or {}
        first = next((e for e in g["ev"] if e[2] in SCORE and e[3]), None)
        if len(st) == 2 and all(len(v) == 5 for v in st.values()) and first:
            feat = {}
            for t, five in st.items():
                for p in five:
                    fga, mn, gp, starts = stat[(s, p)]
                    fs = [0.0, 0.0]
                    for ss, a, b in fsh[p]:
                        w = 0.5 ** (s - ss)
                        if w >= 0.25:
                            fs[0] += w * a; fs[1] += w * b
                    feat[p] = {"fga": fga / gp if gp else 0, "min": mn / gp if gp else 0, "gp": gp,
                               "fs": fs, "jr": list(tips[p])}
            home = None
            rows.append({"id": g["id"], "d": g["d"], "s": s, "names": g["names"], "teams": g["teams"], "st": st,
                         "feat": feat, "fp": first[3], "ft": first[1],
                         "tipw": next((t for t, five in st.items() if jg.get("w") in five), None) if jg.get("j") else None,
                         "jumpers": jg.get("j"), "fs_act": jg.get("fs")})
        # update after the game
        mins = collections.defaultdict(float)
        for t, a, b, ids in g["stints"]:
            for p in ids:
                mins[p] += (b - a) / 60
        att = collections.Counter(e[3] for e in g["ev"] if e[2] in FGA and e[3])
        starters = {p for v in st.values() for p in v}
        for p, m in mins.items():
            r = stat[(s, p)]
            r[0] += att[p]; r[1] += m; r[2] += 1; r[3] += p in starters
        firsts = set()
        for t in st:
            e = next((e for e in g["ev"] if e[1] == t and e[2] in FGA and e[3]), None)
            if e:
                firsts.add(e[3])
        for p in starters:
            fsh[p].append((s, 1, int(p in firsts)))
        if jg.get("j") and jg.get("w"):
            for p in jg["j"]:
                tips[p][1] += 1
                tips[p][0] += p == jg["w"]
    return rows


# ── the model ───────────────────────────────────────────────────────────────
OLD = {"g": .5, "q": .65, "a0": .9, "m0": 30.0, "h": .25, "fs0": 2.0, "k": 1.0, "jb": 0.0}


def jumper_of(r, t):
    return max(r["st"][t], key=lambda p: r["feat"][p]["jr"][1])


def tip_rate(r, p):
    w, n = r["feat"][p]["jr"]
    return (w + 2) / (n + 4)


def tip_prob(r, P):
    """{team: chance to win the opening tip}."""
    a, b = list(r["st"])
    ja, jb = jumper_of(r, a), jumper_of(r, b)
    la = math.log(tip_rate(r, ja) / (1 - tip_rate(r, ja)))
    lb = math.log(tip_rate(r, jb) / (1 - tip_rate(r, jb)))
    pa = 1 / (1 + math.exp(-P["k"] * (la - lb)))
    return {a: pa, b: 1 - pa}, {a: ja, b: jb}


def probs(r, P):
    tip, jump = tip_prob(r, P)
    out = {}
    for t, five in r["st"].items():
        first = tip[t] * P["q"] + (1 - tip[t]) * (1 - P["q"])
        w = []
        for p in five:
            f = r["feat"][p]
            gp = f["gp"]
            n, s = f["fs"]
            w.append(((f["fga"] * gp + P["a0"]) / (f["min"] * gp + P["m0"])) ** P["g"]
                     * ((s + P["fs0"] * .2) / (n + P["fs0"])) ** P["h"]
                     * math.exp(P["jb"] * (p == jump[t])))
        W = sum(w)
        for p, wi in zip(five, w):
            out[p] = first * wi / W
    return out, tip, jump


def nll(rows, P):
    return -sum(math.log(max(probs(r, P)[0].get(r["fp"], 0) * .985, .015 / 50)) for r in rows) / len(rows)


def fit(rows, start):
    P = dict(start)
    grid = {"q": [.55, .6, .62, .64, .66, .68, .7], "k": [0, .5, .75, 1, 1.25, 1.5],
            "g": [0, .25, .5, .75, 1, 1.25], "h": [0, .25, .5, .75, 1, 1.25, 1.5],
            "fs0": [1, 2, 4, 8], "jb": [-.4, -.2, 0, .2, .4]}
    best = nll(rows, P)
    for _ in range(3):
        for k, vals in grid.items():
            for v in vals:
                Q = dict(P, **{k: v})
                x = nll(rows, Q)
                if x < best - 1e-6:
                    best, P = x, Q
    return P, best


# ── prices ──────────────────────────────────────────────────────────────────
def attach_prices(rows, prices):
    byd = collections.defaultdict(list)
    for r in rows:
        byd[r["d"]].append(r)
    n = 0
    for g in prices.values():
        d = (datetime.fromisoformat(g["start"].replace("Z", "+00:00")) - timedelta(hours=6)).strftime("%Y-%m-%d")
        pr = {nk(nm): m["first_basket_including_ft"] for nm, m in (g.get("props") or {}).items()
              if "first_basket_including_ft" in m}
        if len(pr) < 6:
            continue
        for r in byd.get(d, []):
            nm = {p: nk(r["names"].get(p, "")) for t in r["st"] for p in r["st"][t]}
            if sum(v in pr for v in nm.values()) >= 7:
                r["px"] = {p: pr[v] for p, v in nm.items() if v in pr}
                r["px_all"] = {side: sum(1 / dec(m[side][1]) for m in pr.values() if m[side][1]) for side in ("o", "c")}
                n += 1
                break
    return n


# ── betting rules ───────────────────────────────────────────────────────────
def ratio_rule(rel=.20, per_game=2):
    def pick(cands):
        c = [x for x in cands if x["p"] >= x["imp"] * (1 + rel)]
        return sorted(c, key=lambda x: -x["p"] / x["imp"])[:per_game]
    return pick


def opp_rule(top=2, pmin=.10, cap=700, ev=.10, dmin=0.0, per_game=1):
    def pick(cands):
        c = [x for x in cands if (x["rank"] <= top or x["p"] >= pmin) and x["price"] <= cap
             and x["p"] * dec(x["price"]) - 1 >= ev and x["p"] - x["imp"] >= dmin]
        return sorted(c, key=lambda x: -(x["p"] * dec(x["price"]) - 1))[:per_game]
    return pick


def bets(rows, P, rule, side="o", lo=None, hi=None):
    out = []
    for r in rows:
        if "px" not in r or (lo and r["d"] < lo) or (hi and r["d"] >= hi):
            continue
        key = tuple(sorted(P.items()))
        if key not in r.setdefault("_pm", {}):
            r["_pm"][key] = probs(r, P)[0]
        pm = r["_pm"][key]
        rank = {}
        for t, five in r["st"].items():
            for i, p in enumerate(sorted(five, key=lambda p: -pm[p])):
                rank[p] = i + 1
        cands = []
        for p, m in r["px"].items():
            o = m["o"][1]
            if o is None:
                continue
            cands.append({"p": pm[p], "price": o, "imp": 1 / dec(o), "rank": rank[p], "pid": p})
        for x in rule(cands):      # chosen at the opening price (the lane logs only there)
            price = x["price"] if side == "o" else r["px"][x["pid"]]["c"][1]
            if price is None:
                continue
            out.append({"d": r["d"], "price": price, "win": r["fp"] == x["pid"], "p": x["p"],
                        "pid": x["pid"], "name": r["names"].get(x["pid"])})
    return out


def summ(b):
    n = len(b); w = sum(x["win"] for x in b)
    u = sum(dec(x["price"]) - 1 if x["win"] else -1 for x in b)
    ap = sorted(x["price"] for x in b)
    return {"n": n, "w": w, "l": n - w, "hit": w / n if n else 0, "units": u, "roi": u / n if n else 0,
            "med_price": ap[n // 2] if n else None, "exp_hit": sum(x["p"] for x in b) / n if n else 0}


def fmt(s):
    if not s["n"]:
        return "   0 bets"
    se = (s["hit"] * (1 - s["hit"])) ** .5 * dec(s["med_price"]) / s["n"] ** .5 if s["hit"] else 0
    return (f"{s['w']:>3}-{s['l']:<4} hit {100*s['hit']:4.1f}% (model said {100*s['exp_hit']:4.1f}%)  "
            f"med +{s['med_price']:<5} {s['units']:+7.1f}u  ROI {100*s['roi']:+6.1f}% (+/-{100*se:.0f})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbp"); ap.add_argument("prices")
    ap.add_argument("--jumps", default="data/nba/jumps.json")
    ap.add_argument("--out")
    a = ap.parse_args()
    rows = build(a.pbp, a.jumps)
    tr = [r for r in rows if r["s"] == 2024 and r["d"] >= "2024-11-01"]
    te = [r for r in rows if r["s"] == 2025]
    print(f"games with ten starters and a first score: {len(rows)} (fit {len(tr)}, test {len(te)})")
    # facts on the real label
    tipd = [r for r in rows if r["tipw"]]
    q = sum(r["tipw"] == r["ft"] for r in tipd) / len(tipd)
    fsf = [r for r in rows if r.get("fs_act")]
    sh = sum(r["fp"] in r["fs_act"] for r in fsf) / len(fsf)
    bench = sum(r["fp"] not in r["st"][r["ft"]] for r in rows) / len(rows)
    print(f"tip winner scores first {100*q:.1f}% ({len(tipd)} games) | first scorer took his team's first shot "
          f"{100*sh:.1f}% | first scorer not a starter {100*bench:.1f}%")
    P_new, _ = fit(tr, OLD)
    print("old  params", OLD, f"  log loss fit {nll(tr, OLD):.4f} test {nll(te, OLD):.4f}")
    print("new  params", {k: round(v, 3) for k, v in P_new.items()}, f"  log loss fit {nll(tr, P_new):.4f} test {nll(te, P_new):.4f}")
    print(f"uniform over ten starters {math.log(10):.4f}")
    n = attach_prices(rows, json.load(open(a.prices)))
    print(f"Onyx-priced games matched: {n}")
    # Onyx's own log loss, no-vig over the ten starters (only starters are on the floor for
    # the first points: 0 of 2,435 games went to a bench player), games where all ten are priced
    for side in ("o", "c"):
        for lo, hi in (("2025-10", "2026-02"), ("2026-02", "2026-07")):
            lm = lo_ = k = 0
            for r in rows:
                st = [p for t in r["st"] for p in r["st"][t]]
                if "px" not in r or not lo <= r["d"] < hi or not all(p in r["px"] and r["px"][p][side][1] for p in st):
                    continue
                imp = {p: 1 / dec(r["px"][p][side][1]) for p in st}
                k += 1
                lo_ -= math.log(imp[r["fp"]] / sum(imp.values()))
                lm -= math.log(probs(r, P_new)[0][r["fp"]])
            print(f"  {'open ' if side == 'o' else 'close'} {lo}..{hi}: {k} games, log loss model {lm/k:.4f} "
                  f"vs Onyx no-vig {lo_/k:.4f}")
    TUNE, HOLD = ("2025-10-01", "2026-02-01"), ("2026-02-01", "2026-07-01")
    print("\nevery priced starter, blind, by opening price (hit vs Onyx implied, ROI at open | at close):")
    for lab_, lo, hi in (("<=+400", 0, 400), ("+401..+700", 401, 700), ("+701..+1200", 701, 1200), ("+1201+", 1201, 99999)):
        n = w = io = uo = uc = nc = 0
        for r in rows:
            for p, m in (r.get("px") or {}).items():
                o, c = m["o"][1], m["c"][1]
                if o is None or not lo <= o <= hi:
                    continue
                win = r["fp"] == p
                n += 1; w += win; io += 1 / dec(o); uo += dec(o) - 1 if win else -1
                if c is not None:
                    nc += 1; uc += dec(c) - 1 if win else -1
        print(f"  {lab_:12} {n:5} hit {100*w/n:4.1f}% implied {100*io/n:4.1f}%  ROI open {100*uo/n:+6.1f}%  close {100*uc/nc:+6.1f}%")
    # tune the opportunity rule on Oct-Jan at the opening price
    # one play a game, top 2 on his team by the model, price cap and expected return. Single
    # cells are noise (tens of bets), so the pick is the cell whose own ROI averaged with its
    # cap and EV neighbours is best on Oct-Jan, with 60+ bets.
    CAPS, EVS = [500, 600, 700, 800, 900, 1000, 1200], [0, .05, .10, .15, .20]
    roi = {}
    for top, cap, ev in itertools.product([1, 2], CAPS, EVS):
        s = summ(bets(rows, P_new, opp_rule(top, 1, cap, ev, 0, 1), "o", *TUNE))
        roi[(top, cap, ev)] = (s["roi"], s["n"])
    def smooth(k):
        top, cap, ev = k
        i, j = CAPS.index(cap), EVS.index(ev)
        nb = [k] + [(top, CAPS[i + a], EVS[j + b]) for a, b in ((-1, 0), (1, 0), (0, -1), (0, 1))
                    if 0 <= i + a < len(CAPS) and 0 <= j + b < len(EVS)]
        return sum(roi[x][0] for x in nb) / len(nb)
    res = sorted(((smooth(k), roi[k][0], roi[k][1], k) for k in roi if roi[k][1] >= 60 and k[1] <= 1000), reverse=True)
    print("\nopportunity rule on Oct-Jan at the open (top, cap, ev): neighbour-smoothed ROI, own ROI, bets")
    for sm, r_, nb, k in res[:8]:
        print(f"  {k}  smoothed {100*sm:+.1f}%  own {100*r_:+.1f}%  {nb} bets")
    res = [(sm, nb, (k[0], 1, k[1], k[2], 0, 1)) for sm, r_, nb, k in res]
    # the judged rules
    rules = {
        "A old ratio, old model (live rule)": (OLD, ratio_rule(.20, 2)),
        "B old ratio, refit model": (P_new, ratio_rule(.20, 2)),
        "C opportunity, refit, tuned on Oct-Jan " + str(res[0][2][:4]): (P_new, opp_rule(*res[0][2])),
        "D opportunity, refit, cap +700 (the brief's guess), EV 10%": (P_new, opp_rule(2, 1, 700, .10, 0, 1)),
    }
    out = {"params_new": P_new, "params_old": OLD, "tuned": res[0][2], "tables": {}}
    for side, lab in (("o", "OPENING"), ("c", "CLOSING")):
        print(f"\n=== at Onyx's {lab} price (plays chosen at the open) ===")
        for name, (P, rule) in rules.items():
            print(f"{name}")
            for wl, (lo, hi) in (("tune Oct-Jan", TUNE), ("JUDGE Feb-Apr", HOLD), ("whole season", (TUNE[0], HOLD[1]))):
                b = bets(rows, P, rule, side, lo, hi)
                print(f"   {wl:14} {fmt(summ(b))}")
                out["tables"][f"{side}|{name}|{wl}"] = summ(b)
    for name, (P, rule) in rules.items():
        print(f"\n--- {name}: by month (open | close) and by price bucket on Feb-Apr ---")
        bo, bc = bets(rows, P, rule, "o", *TUNE[:1], HOLD[1]), bets(rows, P, rule, "c", *TUNE[:1], HOLD[1])
        for mo in sorted({x["d"][:7] for x in bo}):
            print(f"   {mo}  open {fmt(summ([x for x in bo if x['d'][:7] == mo]))}")
            print(f"            close {fmt(summ([x for x in bc if x['d'][:7] == mo]))}")
        for lab_, lo, hi in (("<=+400", 0, 400), ("+401..+700", 401, 700), ("+701+", 701, 99999)):
            for side, bb in (("open ", bo), ("close", bc)):
                sel = [x for x in bb if x["d"] >= HOLD[0] and lo <= x["price"] <= hi]
                print(f"   {lab_:11} {side} {fmt(summ(sel))}")
            sel = [x for x in bo if x["d"] < HOLD[0] and lo <= x["price"] <= hi]
            print(f"   {lab_:11} open (Oct-Jan) {fmt(summ(sel))}")
    if a.out:
        json.dump(out, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
