#!/usr/bin/env python3
"""
sports_backtest.py - replay a sport's model against real historical Onyx
lines, walk-forward, and write data/<sport>/backtest.json (dev only; the
historical lines come from tools/onyx_lines_pull.py via the manual
odds_probe.yml workflow).

    python3 tools/sports_backtest.py nfl  bt/nfl_game.json  [bt/nfl_lines.json]
    python3 tools/sports_backtest.py cfb  bt/cfb_lines.json
    python3 tools/sports_backtest.py nhl  bt/nhl_lines.json
    python3 tools/sports_backtest.py tennis bt/tennis_atp_lines.json [bt/tennis_wta_lines.json]

Every game is priced only from results before its date. Prices are Onyx's
opening line (what a pick logged at the morning build would get) and closing
line (the harder test). The rule (blend weight, markets, edge band, price
band) is chosen on the tune window and judged on the test window it never
saw. Picks go live (passed = true) only when, on the test window:
  - the blend's log loss beats Onyx's own no-vig price on the lane's markets
  - the lane wins money at opening AND closing prices
  - the lane made at least MIN_PICKS picks
A sport that fails stays leans only, and the page says why, with the numbers.
"""

import json, math, os, sys
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L                       # noqa: E402
from sports_common import Lane, espn_get, nk  # noqa: E402

MIN_PICKS = 30
SPLIT = {"nfl": "2026-03-01", "cfb": "2026-03-01", "nhl": "2026-01-15", "tennis": "2026-01-01"}
W_GRID = (0.0, 0.1, 0.2, 0.3, 0.5)
EDGE_GRID = ((0.02, 0.06), (0.02, 0.10), (0.03, 0.08), (0.04, 0.12), (0.05, 0.15))
PRICE_GRID = ((-200, 150), (-250, 250), (-150, 130))
MKT_SETS = (("ml",), ("spread",), ("total",), ("ml", "spread"), ("ml", "spread", "total"))


def sane(a, b):
    """Two sides of a real two-sided market: both priced, vig 0-12%."""
    if a is None or b is None:
        return False
    s = L.implied(a) + L.implied(b)
    return 1.0 <= s <= 1.12


# ── team sports ────────────────────────────────────────────────────────
def team_map(key):
    path = {"nfl": "football/nfl", "cfb": "football/college-football", "nhl": "hockey/nhl"}[key]
    out = {}
    j = espn_get(path + "/teams", "limit=1000") or {}
    for t in ((j.get("sports") or [{}])[0].get("leagues") or [{}])[0].get("teams") or []:
        t = t.get("team") or {}
        for k in ("displayName", "shortDisplayName", "location", "name"):
            if t.get(k):
                out.setdefault(nk(t[k]), t.get("abbreviation"))
        if t.get("location") and t.get("name"):
            out[nk(t["location"] + " " + t["name"])] = t.get("abbreviation")
    return out


def team_samples(key, lines, M, GP):
    """One row per (game, market, side-pair) with model chance, open and
    close prices and the outcome."""
    import team_model as T
    lane = Lane(key)
    res = (lane.load("results.json", {}) or {}).get("games") or []
    tm = team_map(key)
    by_day = defaultdict(list)
    for g in res:
        by_day[g["date"]].append(g)
    kind = getattr(M, "KIND", "football")
    cache = {}
    out, unmatched = [], 0
    for fid, x in sorted(lines.items(), key=lambda kv: kv[1]["start"] or ""):
        h, a = tm.get(nk(x["home"])), tm.get(nk(x["away"]))
        d0 = (x["start"] or "")[:10]
        if not (h and a and d0):
            unmatched += 1
            continue
        g = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
            g = next((y for y in by_day.get(dd, []) if y["home"] == h and y["away"] == a), None)
            if g:
                break
        if not g:
            unmatched += 1
            continue
        if g["date"] not in cache:
            cache[g["date"]] = T.fit(res, g["date"], GP)
        R = cache[g["date"]]
        if R["n"].get(h, 0) < GP.get("min_games", 3) or R["n"].get(a, 0) < GP.get("min_games", 3):
            continue
        eh, ea = T.expect(R, h, a, g.get("neutral"))
        pr = (T.fb_probs if kind == "football" else T.hk_probs)(eh, ea, GP)
        m, tot = g["hs"] - g["as"], g["hs"] + g["as"]
        gm = x.get("game") or {}
        ml = gm.get("moneyline") or {}
        hk_ = next((k for k in ml if tm.get(nk(k)) == h), None)
        ak_ = next((k for k in ml if tm.get(nk(k)) == a), None)
        for when in ("o", "c"):
            if hk_ and ak_:
                po, pu = ml[hk_][when][1], ml[ak_][when][1]
                if sane(po, pu) and m != 0:
                    out.append({"date": g["date"], "gid": g["id"], "mkt": "ml", "when": when, "p": pr["home_win"],
                                "over": po, "under": pu, "y": 1 if m > 0 else 0})
            sp = gm.get("point_spread") or gm.get("puck_line") or {}
            hs_ = next((k for k in sp if tm.get(nk(k)) == h), None)
            as_ = next((k for k in sp if tm.get(nk(k)) == a), None)
            if hs_ and as_:
                pts, po = sp[hs_][when]
                pu = sp[as_][when][1]
                if pts is not None and sane(po, pu) and m + pts != 0:
                    out.append({"date": g["date"], "gid": g["id"], "mkt": "spread", "when": when, "p": pr["home_cover"](pts),
                                "over": po, "under": pu, "y": 1 if m + pts > 0 else 0, "line": pts})
            tt = gm.get("total_points") or gm.get("total_goals") or {}
            if "over" in tt and "under" in tt:
                ln, po = tt["over"][when]
                pu = tt["under"][when][1]
                if ln is not None and sane(po, pu) and tot != ln:
                    out.append({"date": g["date"], "gid": g["id"], "mkt": "total", "when": when, "p": pr["over"](ln),
                                "over": po, "under": pu, "y": 1 if tot > ln else 0, "line": ln})
    print(f"  {key}: {len(lines)} Onyx games, {unmatched} not matched to ESPN finals, {len(out)} priced samples")
    return out


# ── NFL player props ────────────────────────────────────────────────────
PROP_MKT = {"player_passing_yards": "pass_yds", "player_rushing_yards": "rush_yds",
            "player_receiving_yards": "rec_yds", "player_receptions": "rec"}


def nfl_prop_samples(lines):
    import nfl_model as M
    lane = Lane("nfl")
    rows = (lane.load("player_games.json", {}) or {}).get("rows") or []
    res = (lane.load("results.json", {}) or {}).get("games") or []
    tm = team_map("nfl")
    by_day = defaultdict(list)
    for g in res:
        by_day[g["date"]].append(g)
    by_gid = defaultdict(dict)
    for r in rows:
        by_gid[r["gid"]][nk(r["name"])] = r
    by = M._games_by_player(rows)
    allowed = M._team_allowed(rows)
    lgc = {}
    out = []
    for fid, x in lines.items():
        h, a = tm.get(nk(x["home"])), tm.get(nk(x["away"]))
        d0 = (x["start"] or "")[:10]
        g = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat() if d0 else ""):
            g = next((y for y in by_day.get(dd, []) if y["home"] == h and y["away"] == a), None)
            if g:
                break
        if not g or g["id"] not in by_gid:
            continue
        box = by_gid[g["id"]]
        for name, mk in (x.get("props") or {}).items():
            r = box.get(nk(name))
            if not r:
                continue
            hist = [q for q in by.get(r["pid"], []) if (q["season"], q["week"]) < (r["season"], r["week"])]
            for mid, v in mk.items():
                s = PROP_MKT.get(mid)
                if not s:
                    continue
                pr, _ = M.project(hist, s, r["season"], r["week"], r["opp"], allowed, M.P, lgc)
                if pr is None:
                    continue
                act = r.get(s) or 0.0
                for when in ("o", "c"):
                    ln, po, pu = v[when]
                    if ln is None or not sane(po, pu) or act == ln:
                        continue
                    out.append({"date": g["date"], "gid": g["id"], "mkt": s, "when": when, "p": M.prob_over(s, pr, ln),
                                "over": po, "under": pu, "y": 1 if act > ln else 0, "line": ln, "proj": pr})
    print(f"  nfl props: {len(out)} priced samples")
    return out


# ── tennis ─────────────────────────────────────────────────────────────
def tennis_samples(lines_files):
    import tennis_model as TM
    allm = json.load(open("bt/tennis_results_full.json"))
    lines = {}
    for f in lines_files:
        lines.update(json.load(open(f)))
    by_pair = {}
    for m in allm:
        by_pair.setdefault((m["date"], frozenset((nk(m["w"]), nk(m["l"])))), m)
    # walk the results once, snapshotting a player's chance when a priced match comes up
    want = defaultdict(list)
    for fid, x in lines.items():
        a, b = nk(x["home"]), nk(x["away"])
        d0 = (x["start"] or "")[:10]
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat() if d0 else "",
                   (date.fromisoformat(d0) + timedelta(days=1)).isoformat() if d0 else ""):
            m = by_pair.get((dd, frozenset((a, b))))
            if m:
                want[m["id"]].append((x, a, b))
                break
    E = TM.Elo(TM.P)
    out = []
    for m in allm:
        for x, a, b in want.get(m["id"], []):
            if E.known(a) and E.known(b):
                p = E.p(a, b)
                ml = (x.get("game") or {}).get("moneyline") or {}
                ka = next((k for k in ml if nk(k) == a), None)
                kb = next((k for k in ml if nk(k) == b), None)
                if ka and kb:
                    for when in ("o", "c"):
                        po, pu = ml[ka][when][1], ml[kb][when][1]
                        if sane(po, pu):
                            out.append({"date": m["date"], "gid": m["id"], "mkt": "ml", "when": when, "p": p,
                                        "over": po, "under": pu, "y": 1 if nk(m["w"]) == a else 0})
        E.update(nk(m["w"]), nk(m["l"]), m.get("event"))
    print(f"  tennis: {len(lines)} Onyx matches, {len(want)} matched to results, {len(out)} priced samples")
    return out


# ── the evaluation ─────────────────────────────────────────────────────
def logloss(rows, w):
    mod = mkt = 0.0
    for r in rows:
        fo, _ = L.fair_pair(r["over"], r["under"])
        pb = min(max(L.blend(r["p"], fo, w), 1e-4), 1 - 1e-4)
        pm = min(max(fo, 1e-4), 1 - 1e-4)
        mod += -math.log(pb if r["y"] else 1 - pb)
        mkt += -math.log(pm if r["y"] else 1 - pm)
    n = len(rows) or 1
    return mod / n, mkt / n


def lane_run(rows, w, mkts, edge, price, cap_per_day=6):
    """Picks the live lane would make: best side per sample, one per game,
    by edge, capped per day. Returns (n, wins, units, claimed)."""
    cands = defaultdict(list)
    for r in rows:
        if r["mkt"] not in mkts:
            continue
        ps = L.price_side(r["p"], r["over"], r["under"], w)
        if not ps or not (edge[0] <= ps["edge"] <= edge[1]) or not (price[0] <= ps["price"] <= price[1]):
            continue
        won = (r["y"] == 1) == (ps["side"] == "over")
        cands[r["date"]].append((ps["edge"], r["gid"], ps, won))
    n = wins = 0
    units = claimed = 0.0
    for d, cs in cands.items():
        cs.sort(key=lambda c: -c[0])
        used = set()
        for e, gid, ps, won in cs:
            if gid in used or len(used) >= cap_per_day:
                continue
            used.add(gid)
            n += 1
            wins += won
            claimed += ps["prob"]
            units += (L.decimal(ps["price"]) - 1) if won else -1.0
    return n, wins, units, claimed


def evaluate(key, samples, version, label):
    split = SPLIT[key]
    tune_o = [r for r in samples if r["when"] == "o" and r["date"] < split]
    test_o = [r for r in samples if r["when"] == "o" and r["date"] >= split]
    test_c = [r for r in samples if r["when"] == "c" and r["date"] >= split]
    mk_all = sorted({r["mkt"] for r in samples})
    # 1) blend weight per market group, on log loss in the tune window
    tw = [r for r in tune_o if not ONLY or r["mkt"] in ONLY]
    best_w = min(W_GRID, key=lambda w: logloss(tw, w)[0]) if tw else 0.0
    # 2) lane rule on the tune window: highest ROI with at least MIN_PICKS/2 picks
    best = None
    sets = [ms for ms in MKT_SETS if all(m in mk_all for m in ms)] or [tuple(mk_all)]
    if ONLY:   # --markets: the lane may use only these (and the blend is judged on them)
        sets = [ms for ms in sets if all(m in ONLY for m in ms)]
    if key == "nfl" and any(m not in ("ml", "spread", "total") for m in mk_all):
        sets = [(m,) for m in mk_all if m not in ("ml", "spread", "total")] + [tuple(m for m in mk_all if m not in ("ml", "spread", "total"))]
    for ms in sets:
        for lw in sorted({best_w, 0.1, 0.2, 0.3} - {0.0}):
            for e in EDGE_GRID:
                for pr in PRICE_GRID:
                    n, wi, u, cl = lane_run(tune_o, lw, ms, e, pr)
                    if n < MIN_PICKS // 2:
                        continue
                    roi = u / n
                    if best is None or roi > best[0]:
                        best = (roi, ms, e, pr, lw)
    lines_out = {"tune": {}, "test": {}}
    per_mkt = {}
    for m in mk_all:
        a = [r for r in test_o if r["mkt"] == m]
        if a:
            ll, llm = logloss(a, best_w)
            per_mkt[m] = {"n": len(a), "blend_ll": round(ll, 4), "onyx_ll": round(llm, 4), "model_only_ll": round(logloss(a, 1.0)[0], 4)}
    per_mkt_tune = {}
    for m in mk_all:
        a = [r for r in tune_o if r["mkt"] == m]
        if a:
            ll, llm = logloss(a, best_w)
            per_mkt_tune[m] = {"n": len(a), "blend_ll": round(ll, 4), "onyx_ll": round(llm, 4)}
    result = {"per_market_tune": per_mkt_tune, "only": list(ONLY) if ONLY else None, "version": version, "sport": key, "label": label, "split": split, "w": best_w, "per_market_test": per_mkt,
              "n_samples": len(samples)}
    passed = False
    if best:
        roi_t, ms, e, pr, lw = best
        nt, wt, ut, ct = lane_run(test_o, lw, ms, e, pr)
        nc, wc, uc, cc = lane_run(test_c, lw, ms, e, pr)
        n0, w0, u0, c0 = lane_run(tune_o, lw, ms, e, pr)
        lane_ll = logloss([r for r in test_o if r["mkt"] in ms], lw)
        passed = (nt >= MIN_PICKS and ut > 0 and uc > 0 and lane_ll[0] < lane_ll[1])
        result.update(lane_ll={"blend": round(lane_ll[0], 4), "onyx": round(lane_ll[1], 4)}, lane={"markets": list(ms), "w": lw, "edge_min": e[0], "edge_max": e[1],
                            "price_min": pr[0], "price_max": pr[1], "max_per_slate": 6},
                      tune={"n": n0, "w": w0, "roi": round(u0 / n0, 4) if n0 else None},
                      test_open={"n": nt, "w": wt, "roi": round(ut / nt, 4) if nt else None, "claimed": round(ct / nt, 4) if nt else None,
                                 "hit": round(wt / nt, 4) if nt else None},
                      test_close={"n": nc, "w": wc, "roi": round(uc / nc, 4) if nc else None})
    result["passed"] = passed
    return result


def page(result, key):
    """The Model tab's backtest card, in plain words with the numbers."""
    pm = result.get("per_market_test") or {}
    name = {"ml": "Moneyline", "spread": "Spread", "total": "Total", "pass_yds": "Passing yards", "rush_yds": "Rushing yards",
            "rec_yds": "Receiving yards", "rec": "Receptions"}
    stats = [{"k": f"{name.get(m, m)} log loss", "v": f"{v['blend_ll']:.4f}", "d": f"vs Onyx {v['onyx_ll']:.4f} · model alone {v['model_only_ll']:.4f} · {v['n']} lines"}
             for m, v in pm.items()]
    lane = result.get("lane")
    t, c = result.get("test_open") or {}, result.get("test_close") or {}
    if lane:
        stats.append({"k": "Lane at opening prices", "v": f"{t['w']}-{t['n'] - t['w']}", "d": f"ROI {t['roi'] * 100:+.1f}% · claimed {t['claimed'] * 100:.1f}% vs hit {t['hit'] * 100:.1f}%" if t.get("n") else "no picks"})
        stats.append({"k": "Lane at closing prices", "v": f"{c['w']}-{c['n'] - c['w']}", "d": f"ROI {c['roi'] * 100:+.1f}%" if c.get("n") else "no picks"})
    summary = [f"Every game priced only from results before it, against Onyx's real opening and closing lines. The rule was chosen on games before {result['split']} and judged on {result['split']} on, which it never saw.",
               (f"The model's weight in the blend is {round(result['w'] * 100)}%." if result["w"] else "On the tuning window the best blend gave the model no weight: Onyx's own price was better on its own.")]
    if result["passed"]:
        summary.append("Passed: the blend beat Onyx's no-vig price and the lane won money at both opening and closing prices. Tracked picks are live, graded in public.")
    else:
        why = []
        if not lane:
            why.append("no rule made enough picks on the tuning window")
        else:
            if (t.get("n") or 0) < MIN_PICKS:
                why.append(f"only {t.get('n') or 0} test picks (needs {MIN_PICKS})")
            if (t.get("roi") or 0) <= 0:
                why.append("the lane lost money at opening prices")
            if (c.get("roi") or 0) <= 0:
                why.append("the lane lost money at closing prices")
        summary.append("Not passed: " + ("; ".join(why) or "the blend did not beat Onyx's own price on the lane's markets") + ". Leans only until it does.")
    return {"passed": result["passed"], "version": result["version"], "run": str(date.today()), "title": result["label"],
            "summary": summary, "stats": stats}


ONLY = None


def main():
    global ONLY
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    for a in sys.argv[1:]:
        if a.startswith("--markets="):
            ONLY = tuple(a.split("=", 1)[1].split(","))
    key = args[0]
    files = args[1:]
    if key == "tennis":
        import tennis_model as M
        samples = tennis_samples(files)
        res = evaluate(key, samples, M.VERSION, "Elo against real Onyx match prices")
        out = {**res, "page": page(res, key)}
    else:
        import importlib
        M = importlib.import_module({"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model"}[key])
        GP = M.GAME_P if key == "nfl" else M.P
        lines = json.load(open(files[0]))
        samples = team_samples(key, lines, M, GP)
        res = evaluate(key, samples, M.VERSION, "Team ratings against real Onyx game lines")
        out = {**res, "page": page(res, key)}
        if key == "nfl" and len(files) > 1:
            ps = nfl_prop_samples(json.load(open(files[1])))
            pres = evaluate("nfl", ps, M.VERSION, "Player projections against real Onyx prop lines")
            out["props"] = {**pres, "page": page(pres, key)}
            # props pass or fail on their own; the page shows both
            lane = out.get("lane") or {}
            if pres.get("passed"):
                out["lane_props"] = pres["lane"]
    print(json.dumps({k: v for k, v in out.items() if k != "page"}, indent=1)[:4000])
    if True:
        Lane(key).save("backtest.json", out, indent=1)
        print(f"wrote data/{key}/backtest.json · passed={out['passed']}" + (f" · props passed={out['props']['passed']}" if "props" in out else ""))


if __name__ == "__main__":
    sys.exit(main())
