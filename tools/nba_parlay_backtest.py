#!/usr/bin/env python3
"""
nba_parlay_backtest.py - replay the NBA Model's Parlay rules at Onyx prices (dev only).

The Model's Parlay v1 ("the model's best look to win", 10/26-11/17) took the 3
highest blended win chances (one per game and player, -150..+150, 28+ projected
minutes). It ignores price, so every leg is a favorite the blend agrees with
Onyx about and the ticket pays Onyx's margin three times: 1-17, -$150.55 live.

v2 ("value legs only", Jordan 11/17): a leg qualifies only when the blended
chance beats Onyx's vig-inclusive implied (edge > 0, so EV > 0), same price /
minutes guards plus the picks lane's role-mismatch guard, ranked by EV, up to 3,
and NO ticket with fewer than 2 qualifying legs.

Replays 2025-26 through the live nba_model.project_slate exactly as
tools/nba_minutes_backtest.py does (v4 history prior, whole roster on the slate,
reconstructed injury report, closing Onyx total / spread), then builds each
day's ticket at Onyx OPENING and CLOSING main-line prices (bt/nba/lines.json).
Thresholds are chosen on Oct-Jan only; Feb-Apr is the held-out judge.

Then two looks at the price Onyx charges now (~11.5% two-way prop margin on
onyx_predictions since 11/8, ~6.5% before):
  - every 2025-26 leg re-priced to an 11.5% two-way margin (no-vig chance kept);
  - the real 2026-27 board (data/nba/prop_archive.json: Onyx prices and the
    pregame projection 'j' as the page showed them), graded off
    data/nba/player_games.json. Projected minutes are not in the archive, so
    that check stands in the player's average minutes over his earlier games
    this season (3+ games) for the 28-minute guard.

    python3 tools/nba_parlay_backtest.py [bt/nba] [--json out.json]
"""

import json, math, pickle, sys, time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import nba_backtest as B   # noqa: E402
import nba_model as M      # noqa: E402
from nba_common import nk  # noqa: E402

SPLIT = B.SPLIT
STATS = ("pts", "reb", "ast")
STAKE = 10.0
W = M.MODEL_WEIGHT


def dec(price):
    return 1 + (price / 100.0 if price > 0 else 100.0 / -price)


def american(p):
    """Fair American price for a win chance p (0 < p < 1)."""
    return round(-100 * p / (1 - p)) if p >= 0.5 else round(100 * (1 - p) / p)


def legs_of(recs, which, margin=None):
    """Every priced side of every Onyx main line, with the board's blended chance.
    Pushes are kept as voids (a ticket leg that pushes drops out of the payout)."""
    out = []
    for r in recs:
        for s in STATS:
            m = (r["props"] or {}).get(s)
            if not m or not m.get(which):
                continue
            line, po, pu = m[which]
            io, iu = M.implied(po), M.implied(pu)
            if line is None or not io or not iu or not (1.0 <= io + iu <= 1.15):
                continue
            line = float(line)
            nv = io / (io + iu)
            p_over, p_push = M.prob_over(r["proj"][s], line, s)
            pm = p_over / (1 - p_push) if p_push < 1 else p_over
            act = r["act"][s]
            for side, pmod, pmk, price in (("over", pm, nv, po), ("under", 1 - pm, 1 - nv, pu)):
                if margin is not None:      # re-price this side at a two-way margin of `margin`
                    imp = min(0.97, pmk * (1 + margin))
                    price = american(imp)
                pb = W * pmod + (1 - W) * pmk
                imp = M.implied(price)
                res = "void" if act == line else ((act > line) == (side == "over"))
                out.append({"d": r["d"], "gid": r["gid"], "pid": r["pid"], "s": s, "side": side,
                            "line": line, "price": int(price), "pb": pb, "imp": imp, "edge": pb - imp,
                            "ev": pb * dec(price) - 1, "pmin": r["pmin"],
                            "gap": M.role_gap(r["proj"][s], line, s), "hit": res})
    return out


def rule_v1(c, lo=-150, hi=150, min_min=28.0, **_):
    return c["pmin"] >= min_min and lo <= c["price"] <= hi, -c["pb"]


def rule_v2(c, lo=-150, hi=150, min_min=28.0, min_edge=0.0, max_gap=1.5, **_):
    ok = (c["pmin"] >= min_min and lo <= c["price"] <= hi and c["edge"] > min_edge and c["ev"] > 0
          and (max_gap is None or c["gap"] <= max_gap))
    return ok, -c["ev"]


def tickets(legs, rule, lo_d="0000", hi_d="9999", n_legs=3, min_legs=2, **kw):
    by_day = defaultdict(list)
    for c in legs:
        if lo_d <= c["d"] < hi_d:
            ok, key = rule(c, **kw)
            if ok:
                by_day[c["d"]].append((key, c))
    out = []
    for d in sorted(by_day):
        cs = sorted(by_day[d], key=lambda x: x[0])
        pick, g_used, p_used = [], set(), set()
        for _, c in cs:
            if len(pick) >= n_legs:
                break
            if c["gid"] in g_used or c["pid"] in p_used:
                continue
            g_used.add(c["gid"]); p_used.add(c["pid"])
            pick.append(c)
        if len(pick) >= min_legs:
            out.append((d, pick))
    return out


def grade(tks):
    w = l = v = 0
    pnl = 0.0
    legs = []
    for d, pick in tks:
        live = [c for c in pick if c["hit"] != "void"]
        legs += live
        if not live:
            v += 1
            continue
        if all(c["hit"] is True for c in live):
            w += 1
            pnl += STAKE * (math.prod(dec(c["price"]) for c in live) - 1)
        else:
            l += 1
            pnl -= STAKE
    n = w + l
    return {"tickets": n, "w": w, "l": l, "void": v, "hit": round(w / n, 3) if n else None,
            "pnl": round(pnl, 2), "roi": round(pnl / (n * STAKE), 3) if n else None,
            "legs": len(legs), "leg_hit": round(sum(c["hit"] is True for c in legs) / len(legs), 3) if legs else None,
            "leg_model": round(sum(c["pb"] for c in legs) / len(legs), 3) if legs else None,
            "leg_implied": round(sum(c["imp"] for c in legs) / len(legs), 3) if legs else None,
            "med_price": sorted(c["price"] for c in legs)[len(legs) // 2] if legs else None}


def days_with_lines(legs, lo_d, hi_d):
    return len({c["d"] for c in legs if lo_d <= c["d"] < hi_d})


def line(lab, g):
    if not g["tickets"]:
        return f"  {lab:34s} no tickets"
    return (f"  {lab:34s} {g['tickets']:3d} tickets {g['w']:2d}-{g['l']:<3d} hit {g['hit']:.3f}  "
            f"${g['pnl']:+8.2f}  ROI {g['roi']:+.3f} | legs {g['legs']:3d} model {g['leg_model']:.3f} "
            f"Onyx {g['leg_implied']:.3f} hit {g['leg_hit']:.3f} median {g['med_price']:+d}")


def season_2627(margin_note=True):
    """The live 2026-27 board as the page priced it (prop_archive.json)."""
    root = Path(__file__).resolve().parent.parent / "data" / "nba"
    A = json.load(open(root / "prop_archive.json"))
    pg = json.load(open(root / "player_games.json"))
    done = set(pg.get("_games", []))
    by_name = {}
    for pid, rec in pg.items():
        if pid.startswith("_") or not isinstance(rec, dict):
            continue
        by_name[nk(rec.get("n", ""))] = (pid, rec)
    from datetime import datetime, timedelta
    legs = []
    for gid, g in A.items():
        if gid not in done:
            continue
        d = (datetime.fromisoformat(g["start"].replace("Z", "+00:00")) - timedelta(hours=8)).date().isoformat()
        for key, p in (g.get("pp") or {}).items():
            name, s = key.rsplit("|", 1)
            if s not in STATS or p.get("j") is None or p.get("o") is None or p.get("u") is None:
                continue
            hit = by_name.get(nk(name))
            if not hit:
                continue
            gs = hit[1].get("g", [])
            row = next((x for x in gs if x[1] == gid), None)
            if not row or row[4] <= 0:
                continue
            before = [x[4] for x in gs if x[0] < row[0] and x[4] > 0]
            if len(before) < 3:
                continue
            pmin = sum(before) / len(before)
            act = {"pts": row[5], "reb": row[6], "ast": row[7]}[s]
            line_, po, pu = float(p["l"]), p["o"], p["u"]
            io, iu = M.implied(po), M.implied(pu)
            nv = io / (io + iu)
            p_over, p_push = M.prob_over(p["j"], line_, s)
            pm = p_over / (1 - p_push) if p_push < 1 else p_over
            for side, pmod, pmk, price in (("over", pm, nv, po), ("under", 1 - pm, 1 - nv, pu)):
                pb = W * pmod + (1 - W) * pmk
                imp = M.implied(price)
                legs.append({"d": d, "gid": gid, "pid": hit[0], "s": s, "side": side, "line": line_,
                             "price": int(price), "pb": pb, "imp": imp, "edge": pb - imp,
                             "ev": pb * dec(price) - 1, "pmin": pmin, "margin": io + iu - 1,
                             "gap": M.role_gap(p["j"], line_, s),
                             "hit": "void" if act == line_ else ((act > line_) == (side == "over"))})
    return legs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    bt = Path(args[0] if args else "bt/nba")
    cache = bt / "_parlay_recs.pkl"
    if cache.exists() and "--fresh" not in sys.argv:
        recs = pickle.load(open(cache, "rb"))
    else:
        G, lines = B.load(bt)
        hist = json.load(open(bt / "history.json"))
        prior, th, roles, _, _, _ = B.build_hist_prior(lines, hist, target=2026)
        B.HIST_CTX.update(team_hist=th, roles=roles)
        mkt = json.load(open(bt / "lines.json"))
        for gid, g in mkt.items():
            B.NAMEMAP[gid] = {nk(n): v for n, v in (g.get("props") or {}).items()}
        B.SIM_ROSTER = True
        t0 = time.time()
        recs = B.walk(G, lines, "2025-10-01", "2026-04-30", prior, mkt)
        print(f"walk-forward: {len(recs)} player-games in {time.time() - t0:.0f}s")
        pickle.dump(recs, open(cache, "wb"))
    out = {}
    L = {w: legs_of(recs, w) for w in ("o", "c")}
    for w, lab in (("o", "opening"), ("c", "closing")):
        mg = [c["imp"] for c in L[w] if c["side"] == "over"]
        print(f"{lab}: {len(L[w]) // 2} two-sided Onyx main lines; slates with lines: "
              f"tune {days_with_lines(L[w], '0000', SPLIT)}, test {days_with_lines(L[w], SPLIT, '9999')}")

    # 1) choose v2's thresholds on Oct-Jan only (both prices must be judged; the tuner sees the
    #    average ROI of the opening and closing replays, needs 15+ tickets at each)
    grid = [dict(lo=lo, hi=hi, min_edge=me, max_gap=mg_)
            for lo, hi in ((-150, 150), (-180, 150), (-200, 200), (-150, 250))
            for me in (0.0, 0.01, 0.02, 0.03)
            for mg_ in (1.5, None)]
    print("\nv2 grid on TUNE (Oct-Jan): open / close")
    scored = []
    for kw in grid:
        go = grade(tickets(L["o"], rule_v2, hi_d=SPLIT, **kw))
        gc = grade(tickets(L["c"], rule_v2, hi_d=SPLIT, **kw))
        ok = go["tickets"] >= 15 and gc["tickets"] >= 15
        sc = ((go["roi"] or 0) + (gc["roi"] or 0)) / 2 if ok else -9
        scored.append((sc, kw, go, gc))
        print(f"  {str(kw):60s} open {go['tickets']:3d} {go['w']}-{go['l']} {go['roi'] if go['roi'] is not None else 0:+.3f}"
              f" | close {gc['tickets']:3d} {gc['w']}-{gc['l']} {gc['roi'] if gc['roi'] is not None else 0:+.3f}")
    best = max(scored, key=lambda x: x[0])[1]
    live = dict(lo=-150, hi=150, min_edge=0.0, max_gap=1.5)
    print(f"\nchosen on tune: {best}   (the brief's default: {live})")
    out["chosen"] = best

    # 2) v1 vs v2 on the same slates, tune and held-out windows, open and close
    for kw_lab, kw in (("v2 default (edge>0, -150..+150)", live), ("v2 tuned " + str(best), best)):
        print(f"\n== {kw_lab}")
        for w, lab in (("o", "open"), ("c", "close")):
            for lo_d, hi_d, win in (("0000", SPLIT, "tune Oct-Jan"), (SPLIT, "9999", "TEST Feb-Apr")):
                g1 = grade(tickets(L[w], rule_v1, lo_d, hi_d))
                g2 = grade(tickets(L[w], rule_v2, lo_d, hi_d, **kw))
                nd = days_with_lines(L[w], lo_d, hi_d)
                print(f" {lab:5s} {win} ({nd} slates)")
                print(line("v1 most likely", g1))
                print(line("v2 value only", g2))
                out[f"{kw_lab}|{lab}|{win}"] = {"slates": nd, "v1": g1, "v2": g2}

    # 3) leg calibration, whole season: blended chance vs hit, per rule
    for w, lab in (("o", "open"), ("c", "close")):
        for nm, rule, kw in (("v1", rule_v1, {}), ("v2", rule_v2, live)):
            legs = [c for _, p in tickets(L[w], rule, **kw) for c in p if c["hit"] != "void"]
            b = defaultdict(lambda: [0, 0, 0.0, 0.0])
            for c in legs:
                k = min(19, int(c["pb"] * 20)) / 20
                b[k][0] += 1; b[k][1] += c["hit"] is True; b[k][2] += c["pb"]; b[k][3] += c["imp"]
            print(f"\n leg calibration {nm} at {lab} (bucket: n, blended, Onyx implied, hit):")
            for k, v in sorted(b.items()):
                print(f"   {k:.2f}: {v[0]:4d}  {v[2] / v[0]:.3f}  {v[3] / v[0]:.3f}  {v[1] / v[0]:.3f}")

    # 4) today's margin: 2025-26 legs re-priced to an 11.5% two-way margin
    print("\n== 2025-26 re-priced to an 11.5% two-way margin (onyx_predictions since 11/8)")
    for w, lab in (("o", "open"), ("c", "close")):
        Lm = legs_of(recs, w, margin=0.115)
        nd = days_with_lines(Lm, "0000", "9999")
        g1, g2 = grade(tickets(Lm, rule_v1)), grade(tickets(Lm, rule_v2, **live))
        g2b = grade(tickets(Lm, rule_v2, **best))
        qual = sum(1 for c in Lm if rule_v2(c, **live)[0])
        print(f" {lab}: {nd} slates, {qual} qualifying legs all season")
        print(line("v1 most likely", g1)); print(line("v2 value only", g2)); print(line("v2 tuned", g2b))
        out[f"margin11.5|{lab}"] = {"slates": nd, "qualifying_legs": qual, "v1": g1, "v2": g2, "v2_tuned": g2b}

    # 5) the real 2026-27 board
    L27 = season_2627()
    if L27:
        mg = sorted(c["margin"] for c in L27 if c["side"] == "over")
        nd = days_with_lines(L27, "0000", "9999")
        print(f"\n== 2026-27 live board (prop_archive, {nd} slates, {len(L27) // 2} lines, median two-way "
              f"margin {mg[len(mg) // 2]:.3f}; minutes = season average so far)")
        for lab, lo_d, hi_d in (("onyx_odds, through 11/7", "0000", "2026-11-08"), ("onyx_predictions, 11/8 on", "2026-11-08", "9999")):
            sub = [c for c in L27 if lo_d <= c["d"] < hi_d]
            q = sum(1 for c in sub if rule_v2(c, **live)[0])
            g1, g2 = grade(tickets(sub, rule_v1, lo_d, hi_d)), grade(tickets(sub, rule_v2, lo_d, hi_d, **live))
            print(f" {lab}: {days_with_lines(sub, lo_d, hi_d)} slates, {q} qualifying legs")
            print(line("v1 most likely", g1)); print(line("v2 value only", g2))
            out[f"2026-27|{lab}"] = {"qualifying_legs": q, "v1": g1, "v2": g2}
    if "--json" in sys.argv:
        json.dump(out, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
