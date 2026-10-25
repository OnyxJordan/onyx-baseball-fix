#!/usr/bin/env python3
"""
nba_backtest.py - walk-forward backtest of nba_model.project_slate (dev only).

Replays the 2025-26 regular season one game day at a time. On each day the
model sees ONLY what existed before tip: 2024-25 as the prior, 2025-26 box
scores from earlier days, team pace / defense from earlier days. It then
projects every player who suited up that night and is scored against the
real box score.

Data: bt/games.json + bt/box.json + bt/lines.json from tools/nba_backtest_pull.py
(OpticOdds box scores and historical Onyx main lines, open + close).

What it can and cannot see (read before quoting numbers):
  - Who played is taken from the box score, i.e. it assumes the final
    injury report is known at tip. Production has that too (OUT / GTD).
  - Game environment uses the CLOSING Onyx total / spread (production
    refreshes up to tip). Props are scored at both opening and closing
    prices; real picks land in between.

Usage (data: run the "NBA backtest data" workflow, download its artifact to bt/):
  python3 tools/nba_backtest.py bt/                 # score the live model + picks lane
  python3 tools/nba_backtest.py bt/ --tune          # tune on Oct-Jan, test Feb-Apr

Run it after ANY nba_model.py / picks-lane change and quote the test-window
numbers in the changelog entry.
"""

import json, math, sys, time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import nba_model as M
from nba_common import team_abbr, nk

NAMEMAP = {}   # gid -> {nk(name): props}, filled when lines load

STATS = ("pts", "reb", "ast")
SIM_OUT = True                # reconstruct the injury report (see walk)
SPLIT = "2026-02-01"          # tune before, test on/after
MIN_PROJ = 20.0               # prop-relevant players for the headline numbers


def gday(iso):
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt - timedelta(hours=8)).date().isoformat()   # UTC -> ET (~-4/-5) -> game day (-4h); tips are 12-11 PM ET


def load(bt):
    games = json.load(open(Path(bt) / "games.json"))
    box = json.load(open(Path(bt) / "box.json"))
    G = {}
    for g in games.values():
        h, a = team_abbr(g["home"]), team_abbr(g["away"])
        if not h or not a:
            continue
        G[g["id"]] = {"gid": g["id"], "d": gday(g["start"]), "home": h, "away": a,
                      "hs": g.get("hs"), "as": g.get("as")}
    lines = defaultdict(list)
    for row in box:
        (fid, pid, name, pos, team, starter, mins, secs, pts, reb, ast, fg3, fga, fta, oreb, tov) = row[:16]
        pm = row[16] if len(row) > 16 else None
        if fid not in G:
            continue
        m = mins if mins is not None else (secs or 0) / 60.0
        lines[fid].append({"pid": pid, "name": name, "pos": pos or "", "team": team_abbr(team),
                           "starter": starter, "min": float(m or 0), "pts": float(pts or 0),
                           "reb": float(reb or 0), "ast": float(ast or 0), "fg3": float(fg3 or 0),
                           "fga": float(fga or 0), "fta": float(fta or 0), "oreb": float(oreb or 0),
                           "tov": float(tov or 0), "pm": float(pm) if pm is not None else None})
    return G, lines


def build_prior(G, lines, before):
    pr = {}
    for fid, ls in lines.items():
        if G[fid]["d"] >= before:
            continue
        for l in ls:
            if l["min"] <= 0:
                continue
            a = pr.setdefault(l["pid"], {"n": l["name"], "t": l["team"], "pos": l["pos"], "gp": 0,
                                         "min": 0.0, "pts": 0.0, "reb": 0.0, "ast": 0.0, "fg3": 0.0,
                                         "fga": 0.0, "fta": 0.0, "tov": 0.0, "_last": ""})
            a["gp"] += 1
            for k in ("min", "pts", "reb", "ast", "fg3", "fga", "fta", "tov"):
                a[k] += l[k]
            if G[fid]["d"] >= a["_last"]:
                a["_last"], a["t"] = G[fid]["d"], l["team"]
    return pr


def walk(G, lines, season_start, season_end, prior, mkt=None):
    """One record per player-game: projection, baselines, actual, and the
    Onyx main line (open + close) when the historical pull has one."""
    mkt = mkt or {}
    by_day = defaultdict(list)
    for fid, g in G.items():
        if season_start <= g["d"] <= season_end:
            by_day[g["d"]].append(fid)
    pg, tg, out = {}, {}, []
    recent = defaultdict(list)    # team -> last 5 games' {pid: (name, pos, min)}
    for d in sorted(by_day):
        fids = by_day[d]
        slate = {"date": d, "games": [], "players": []}
        for fid in fids:
            g = G[fid]
            gl = mkt.get(fid) or {}
            # closing Onyx total / home spread: production refreshes up to tip
            tot = (gl.get("total") or [None, None])[1]
            spr = (gl.get("spread_home") or [None, None])[1]
            slate["games"].append({"gid": fid, "away": g["away"], "home": g["home"], "state": "pre",
                                   "spread": spr, "total": tot})
            here = set()
            for l in lines[fid]:
                if l["min"] <= 0 or l["team"] not in (g["home"], g["away"]):
                    continue
                here.add(l["pid"])
                opp = g["away"] if l["team"] == g["home"] else g["home"]
                slate["players"].append({"pid": l["pid"], "name": l["name"], "team": l["team"], "opp": opp,
                                         "home": l["team"] == g["home"], "gid": fid, "pos": l["pos"], "inj": ""})
            # the injury report, reconstructed: a recent rotation player (3 of
            # the team's last 5 games, 15+ min there) absent tonight is OUT
            if SIM_OUT:
                for team in (g["home"], g["away"]):
                    seen = defaultdict(list)
                    for gm in recent[team][-5:]:
                        for pid, (nm, pos, mn) in gm.items():
                            seen[pid].append((nm, pos, mn))
                    for pid, apps in seen.items():
                        if pid in here or len(apps) < 3 or sum(a[2] for a in apps) / len(apps) < 15:
                            continue
                        opp = g["away"] if team == g["home"] else g["home"]
                        slate["players"].append({"pid": pid, "name": apps[-1][0], "team": team, "opp": opp,
                                                 "home": team == g["home"], "gid": fid, "pos": apps[-1][1],
                                                 "inj": "OUT"})
        rows, _ = M.project_slate(slate, prior, pg, tg)
        n_out = defaultdict(int)
        for p in slate["players"]:
            if p["inj"] == "OUT":
                n_out[(p["gid"], p["team"])] += 1
        actual = {(fid, l["pid"]): l for fid in fids for l in lines[fid]}
        for r in rows:
            a = actual.get((r["gid"], r["pid"]))
            if not a:
                continue
            hist = [x for x in (pg.get(r["pid"]) or {}).get("g", []) if x[4] > 0]
            pri = prior.get(r["pid"])
            base = {}
            for s in STATS:
                i = M.IDX[s]
                szn = sum(x[i] for x in hist) / len(hist) if len(hist) >= 3 else None
                l10 = sum(x[i] for x in hist[-10:]) / len(hist[-10:]) if hist else None
                l5 = sum(x[i] for x in hist[-5:]) / len(hist[-5:]) if len(hist) >= 3 else None
                pv = pri[s] / pri["gp"] if pri and pri.get("gp") else None
                base[s] = {"szn": szn if szn is not None else pv, "l10": l10 if l10 is not None else pv,
                           "prior": pv, "szn_raw": szn if len(hist) >= 2 else None, "l5": l5}
            props = ((mkt.get(r["gid"]) or {}).get("props") or {}).get(r["name"]) or \
                    NAMEMAP.get(r["gid"], {}).get(nk(r["name"])) or {}
            out.append({"d": d, "pid": r["pid"], "name": r["name"], "gid": r["gid"], "pmin": r["min"],
                        "team_out": n_out[(r["gid"], r["team"])],
                        "amin": a["min"], "proj": dict(r["proj"]), "act": {s: a[s] for s in STATS},
                        "base": base, "gp": len(hist), "props": props})
        # the day is over: its box scores join the history
        for fid in fids:
            g = G[fid]
            team_tot = defaultdict(lambda: defaultdict(float))
            for l in lines[fid]:
                if l["team"] not in (g["home"], g["away"]):
                    continue
                opp = g["away"] if l["team"] == g["home"] else g["home"]
                rec = pg.setdefault(l["pid"], {"n": l["name"], "t": l["team"], "g": []})
                rec["g"].append([d, fid, opp, int(l["team"] == g["home"]), l["min"], l["pts"], l["reb"],
                                 l["ast"], l["fg3"], l["starter"], l["fga"], l["fta"], l["tov"], l.get("pm")])
                for k in ("pts", "reb", "ast", "fga", "fta", "oreb", "tov"):
                    team_tot[l["team"]][k] += l[k]
            for team in (g["home"], g["away"]):
                recent[team].append({l["pid"]: (l["name"], l["pos"], l["min"]) for l in lines[fid]
                                     if l["team"] == team and l["min"] > 0})
                recent[team] = recent[team][-5:]
                opp = g["away"] if team == g["home"] else g["home"]
                t, o = team_tot[team], team_tot[opp]
                tg.setdefault(team, []).append({
                    "d": d, "gid": fid, "opp": opp, "home": team == g["home"],
                    "pts": t["pts"], "opp_pts": o["pts"], "reb": t["reb"], "opp_reb": o["reb"],
                    "ast": t["ast"], "opp_ast": o["ast"],
                    "poss": t["fga"] - t["oreb"] + t["tov"] + 0.44 * t["fta"]})
    return out


def score(recs, lo="0000", hi="9999", min_proj=MIN_PROJ, only_out=False):
    sel = [r for r in recs if lo <= r["d"] < hi and r["pmin"] >= min_proj and (not only_out or r.get("team_out"))]
    res = {"n": len(sel)}
    if not sel:
        return res
    res["min_mae"] = sum(abs(r["pmin"] - r["amin"]) for r in sel) / len(sel)
    for s in STATS:
        e = [r["proj"][s] - r["act"][s] for r in sel]
        res[s] = {"mae": sum(map(abs, e)) / len(e), "rmse": math.sqrt(sum(x * x for x in e) / len(e)),
                  "bias": sum(e) / len(e), "mean": sum(r["act"][s] for r in sel) / len(sel)}
        for b in ("szn", "l10", "prior"):
            bb = [(r["base"][s][b], r["act"][s]) for r in sel if r["base"][s][b] is not None]
            res[s][b] = sum(abs(p - a) for p, a in bb) / len(bb) if bb else None
    res["obj"] = sum(res[s]["mae"] / res[s]["mean"] for s in STATS) / 3
    return res


def fmt(res, title):
    print(f"\n{title}: {res['n']} player-games (projected 20+ min); minutes MAE {res.get('min_mae', 0):.2f}")
    print(f"  {'stat':5s} {'model MAE':>9s} {'RMSE':>6s} {'bias':>6s} | {'szn avg':>7s} {'last 10':>7s} {'prior':>6s}")
    for s in STATS:
        r = res[s]
        print(f"  {s:5s} {r['mae']:9.3f} {r['rmse']:6.2f} {r['bias']:+6.2f} | {r['szn']:7.3f} {r['l10']:7.3f} {r['prior']:6.3f}")


def fit_sd(recs, lo, hi):
    """Per-stat spread sd = a*proj + b from the residuals in a window
    (E|resid| = sd * sqrt(2/pi) for a roughly normal error)."""
    sel = [r for r in recs if lo <= r["d"] < hi and r["pmin"] >= 10]
    out = {}
    for s in STATS:
        xs = [r["proj"][s] for r in sel]
        ys = [abs(r["proj"][s] - r["act"][s]) / math.sqrt(2 / math.pi) for r in sel]
        n = len(xs); mx, my = sum(xs) / n, sum(ys) / n
        a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
        out[s] = (round(a, 3), round(my - a * mx, 3))
    return out


def implied(a):
    if a is None:
        return None
    a = float(a)
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def market_rows(recs, lo, hi, which="c"):
    """Every player-game with a two-sided Onyx main line: model P(over),
    vig-free market P(over), outcome."""
    out = []
    for r in recs:
        if not (lo <= r["d"] < hi):
            continue
        for s in STATS:
            m = (r["props"] or {}).get(s)
            if not m:
                continue
            line, po, pu = m[which]
            io, iu = implied(po), implied(pu)
            if line is None or not io or not iu:
                continue
            if not (1.0 <= io + iu <= 1.15):
                continue                      # sides posted at different lines (open/close race): no market
            act = r["act"][s]
            if act == line:
                continue                      # push: no outcome
            p_over, p_push = M.prob_over(r["proj"][s], float(line), s)
            p_model = p_over / (1 - p_push) if p_push < 1 else p_over
            out.append({"r": r, "s": s, "line": float(line), "po": int(po), "pu": int(pu),
                        "p_model": p_model, "p_mkt": io / (io + iu), "over": act > line,
                        "io": io, "iu": iu})
    return out


def brier(rows, key):
    return sum((x[key] - x["over"]) ** 2 for x in rows) / len(rows)


def logloss(rows, key):
    e = 1e-6
    return -sum(math.log(max(e, x[key])) if x["over"] else math.log(max(e, 1 - x[key])) for x in rows) / len(rows)


def payout(price):
    return price / 100 if price > 0 else 100 / -price


def simulate_picks(rows, w, min_edge, max_edge, price_lo=-180, price_hi=150, min_min=24.0,
                   min_sig=2, per_game=2, per_slate=6, max_gap=None):
    """Replay the nba_build.py picks lane at the listed Onyx prices."""
    cands = []
    for x in rows:
        r, s = x["r"], x["s"]
        if r["pmin"] < min_min:
            continue
        if max_gap is not None and M.role_gap(r["proj"][s], x["line"], s) > max_gap:
            continue                          # projection and line describe different roles
        pb = w * x["p_model"] + (1 - w) * x["p_mkt"]
        for side, p, price, imp in (("over", pb, x["po"], x["io"]), ("under", 1 - pb, x["pu"], x["iu"])):
            edge = p - imp
            if not (min_edge <= edge <= max_edge and price_lo <= price <= price_hi):
                continue
            if p * (1 + payout(price)) - 1 <= 0:
                continue
            b = r["base"][s]
            reads = [v for v in (b["prior"], b["szn_raw"], b["l5"]) if v is not None]
            sig = sum(1 for v in reads if (v > x["line"]) == (side == "over") and v != x["line"])
            if sig < min_sig:
                continue
            win = x["over"] if side == "over" else not x["over"]
            cands.append((r["d"], edge, r["gid"], r["pid"], s, side, price, win, p))
    by_day = defaultdict(list)
    for c in cands:
        by_day[c[0]].append(c)
    picks = []
    for d, cs in by_day.items():
        cs.sort(key=lambda c: -c[1])
        used, pg_n = set(), defaultdict(int)
        for c in cs:
            if len([p for p in picks if p[0] == d]) >= per_slate:
                break
            if c[3] in used or pg_n[c[2]] >= per_game:
                continue
            used.add(c[3]); pg_n[c[2]] += 1
            picks.append(c)
    w_, l_ = sum(1 for p in picks if p[7]), sum(1 for p in picks if not p[7])
    units = sum(payout(p[6]) if p[7] else -1 for p in picks)
    exp = sum(p[8] for p in picks)
    return {"n": len(picks), "w": w_, "l": l_, "units": round(units, 2),
            "roi": round(units / len(picks), 4) if picks else 0.0,
            "claimed": round(exp / len(picks), 4) if picks else 0.0,
            "hit": round(w_ / len(picks), 4) if picks else 0.0,
            "by_stat": {s: (sum(1 for p in picks if p[4] == s and p[7]), sum(1 for p in picks if p[4] == s and not p[7]))
                        for s in STATS},
            "by_side": {sd: (sum(1 for p in picks if p[5] == sd and p[7]), sum(1 for p in picks if p[5] == sd and not p[7]))
                        for sd in ("over", "under")}}


def calib_table(rows, key):
    b = defaultdict(lambda: [0, 0, 0.0])
    for x in rows:
        k = min(9, int(x[key] * 10))
        b[k][0] += 1; b[k][1] += x["over"]; b[k][2] += x[key]
    return [(k, v[0], v[2] / v[0], v[1] / v[0]) for k, v in sorted(b.items()) if v[0] >= 40]


GRID = {
    "usg_alpha": [0.0, 0.3, 0.6, 0.9],
    "usg_gamma": [0.0, 1.0, 2.0],
    "usg_beta_pts": [0.5, 0.8, 1.0],
    "usg_beta_ast": [0.3, 0.6, 1.0],
    "usg_beta_reb": [0.0, 0.3],
    "pace_mix": [0.0, 0.25, 0.5],
    "start_w": [0.0, 0.3, 0.6],
    "pm_k": [0.0, 0.01, 0.02, 0.04],
    "home_court": [0.0, 1.5, 3.0],
    "PRIOR_GAMES_K": [2, 4, 6, 10],
    "RATE_PRIOR_MIN": [150.0, 300.0, 500.0, 800.0],
    "min_recent_w": [0.0, 0.15, 0.30, 0.45],
    "min_recent_n": [3, 5],
    "min_decay": [1.0, 0.95, 0.9],
    "rate_decay": [1.0, 0.97, 0.93],
    "l5_nudge": [0.0, 0.25, 0.5],
    "b2b_mult": [0.95, 0.97, 1.0],
    "opp_exp": [0.0, 0.25, 0.5, 0.75],
    "pace_exp": [0.0, 0.5, 1.0],
    "pts_fit_exp": [0.0, 0.4, 0.8, 1.0],
    "home_pts": [0.0, 0.01, 0.02],
    "scale_pts": [0.94, 0.96, 0.98, 1.0],
    "scale_reb": [0.94, 0.96, 0.98, 1.0],
    "scale_ast": [0.96, 0.98, 1.0, 1.02],
}


def setp(k, v):
    if k in ("PRIOR_GAMES_K", "RATE_PRIOR_MIN"):
        setattr(M, k, v)
    else:
        M.P[k] = v


def getp(k):
    return getattr(M, k) if k in ("PRIOR_GAMES_K", "RATE_PRIOR_MIN") else M.P[k]


def report_market(recs, lo, hi, title, w):
    rows = market_rows(recs, lo, hi)
    if not rows:
        print(f"\n{title}: no Onyx lines in window")
        return None
    for x in rows:
        x["p_blend"] = w * x["p_model"] + (1 - w) * x["p_mkt"]
    with_line = [x for x in rows]
    mae_m = sum(abs(x["r"]["proj"][x["s"]] - x["r"]["act"][x["s"]]) for x in with_line) / len(with_line)
    mae_l = sum(abs(x["line"] - x["r"]["act"][x["s"]]) for x in with_line) / len(with_line)
    print(f"\n{title}: {len(rows)} Onyx closing lines (two-sided, no pushes)")
    print(f"  projection MAE {mae_m:.3f} vs Onyx line MAE {mae_l:.3f} (same player-games)")
    for key, lab in (("p_model", "model"), ("p_mkt", "Onyx no-vig"), ("p_blend", f"blend w={w}")):
        print(f"  {lab:14s} Brier {brier(rows, key):.4f}  logloss {logloss(rows, key):.4f}")
    print("  calibration of the BLEND (P(over) bucket: n, predicted, actual):")
    for k, n, pp, aa in calib_table(rows, "p_blend"):
        print(f"    {k / 10:.1f}-{(k + 1) / 10:.1f}: {n:5d}  {pp:.3f}  {aa:.3f}")
    return rows


def main():
    bt = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "bt"
    G, lines = load(bt)
    prior = build_prior(G, lines, "2025-08-01")
    mkt = {}
    lp = Path(bt) / "lines.json"
    if lp.exists() and "--no-lines" not in sys.argv:
        mkt = json.load(open(lp))
        for gid, g in mkt.items():
            NAMEMAP[gid] = {nk(n): v for n, v in (g.get("props") or {}).items()}
    print(f"loaded {len(G)} games, prior for {len(prior)} players (2024-25), Onyx lines for {len(mkt)} games")
    run = lambda: walk(G, lines, "2025-10-01", "2026-04-30", prior, mkt)
    t0 = time.time()
    recs = run()
    print(f"walk-forward: {len(recs)} player-games in {time.time() - t0:.1f}s")
    fmt(score(recs, hi=SPLIT), "CURRENT params, train window (Oct-Jan)")
    fmt(score(recs, lo=SPLIT), "CURRENT params, test window (Feb-Apr)")
    fmt(score(recs, lo=SPLIT, only_out=True), "CURRENT params, test window, team missing a rotation player")
    if mkt:
        report_market(recs, SPLIT, "9999", "CURRENT model vs Onyx, test window", M.MODEL_WEIGHT)
        import nba_build
        for which, lab in (("o", "opening"), ("c", "closing")):
            rows = market_rows(recs, SPLIT, "9999", which)
            print(f"  picks lane (nba_build.py rules) at Onyx {lab} prices:",
                  simulate_picks(rows, M.MODEL_WEIGHT, nba_build.PICK_MIN_EDGE, nba_build.PICK_MAX_EDGE,
                                 min_min=nba_build.PICK_MIN_MIN, min_sig=nba_build.PICK_MIN_SIGNALS,
                                 per_game=nba_build.PICK_MAX_PER_GAME, per_slate=nba_build.PICK_MAX_PER_SLATE,
                                 max_gap=nba_build.PICK_MAX_GAP))
    if "--tune" not in sys.argv:
        return

    # 1) projection params: minimize normalized MAE on the train window
    best = {k: getp(k) for k in GRID}
    for sweep in range(2):
        for k, vals in GRID.items():
            sc = {}
            for v in vals:
                setp(k, v)
                sc[v] = score(run(), hi=SPLIT)["obj"]
            setp(k, min(sc, key=sc.get)); best[k] = getp(k)
            print(f"  sweep {sweep + 1} {k:15s} -> {best[k]}  (" + ", ".join(f"{v}:{o:.4f}" for v, o in sc.items()) + ")")
    recs = run()
    tr, te = score(recs, hi=SPLIT), score(recs, lo=SPLIT)
    fmt(tr, "TUNED params, train window (Oct-Jan)")
    fmt(te, "TUNED params, TEST window (Feb-Apr, never seen by the tuner)")
    fmt(score(recs, lo=SPLIT, only_out=True), "TUNED params, TEST window, team missing a rotation player")

    # 2) distribution spread, fitted on train only
    sd = fit_sd(recs, "0000", SPLIT)
    M.SD.update(sd)
    print("\nSD fitted on train:", sd)

    out = {"best": best, "sd": sd, "train": tr, "test": te}
    if mkt:
        # 3) model / market blend weight: best train logloss
        tr_rows = market_rows(recs, "0000", SPLIT)
        ws = {}
        for w in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
            for x in tr_rows:
                x["p_blend"] = w * x["p_model"] + (1 - w) * x["p_mkt"]
            ws[w] = logloss(tr_rows, "p_blend")
        w_best = min(ws, key=ws.get)
        print("blend weight (train logloss):", {k: round(v, 4) for k, v in ws.items()}, "->", w_best)
        report_market(recs, "0000", SPLIT, "TUNED model vs Onyx, train window", w_best)
        te_rows = report_market(recs, SPLIT, "9999", "TUNED model vs Onyx, TEST window", w_best)
        # 4) picks lane: choose the edge band on train, report test
        grid = [(lo_, hi_) for lo_ in (0.02, 0.03, 0.04, 0.05, 0.06) for hi_ in (0.08, 0.10, 0.15)]
        res = {g: simulate_picks(tr_rows, w_best, *g) for g in grid}
        ok = {g: r for g, r in res.items() if r["n"] >= 40}
        g_best = max(ok, key=lambda g: ok[g]["roi"]) if ok else (0.05, 0.10)
        print("\npicks lane on TRAIN by edge band (n, W-L, ROI):")
        for g, r in res.items():
            print(f"   edge {g[0]:.2f}-{g[1]:.2f}: n={r['n']:4d} {r['w']}-{r['l']} roi {r['roi']:+.3f}")
        te_pick = simulate_picks(te_rows, w_best, *g_best)
        print(f"\nchosen band {g_best} -> TEST picks: {te_pick}")
        out.update({"blend_w": w_best, "edge_band": g_best, "test_picks": te_pick,
                    "train_picks": res.get(g_best)})
    json.dump(out, open(Path(bt) / "tuned.json", "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
