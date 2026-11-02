#!/usr/bin/env python3
"""
cbb_price_backtest.py - college basketball against real Onyx prices, 2025-26. Dev only.

    python3 tools/cbb_price_backtest.py [bt/cbb_lines.json] [--prior bt/cbb_prior_2026.json] [--json out.json]

bt/cbb_lines.json: Onyx's opening ("o") and closing ("c") moneyline, spread and total for 5,489
college basketball games, Nov 2025 to Apr 2026 (OpticOdds team names). Every game is matched to
its ESPN final (data/cbb/results.json) by the two teams within a day of its start, and priced the
way the live page prices it (sports_build.game_rows): cbb_model.ratings as of the game's date
(only games before it), team_model.fb_probs on the expected points, blended with Onyx's no-vig
price, the better side kept. The pick rule is the home Top 10 rule (daily_top.ok), one per game
market a day, best expected return first, at most picks.CAP a day (tools/picks_backtest.card).

Two priors are replayed side by side:
  v2     last season's Torvik efficiency kept 85% (cbb_model v2, live through 11/2)
  blend  the transfer-aware preseason blend (data/cbb/team_prior.json's method, every weight fitted
         on seasons before 2025-26: tools/cbb_transfers_backtest.py --prior 2026 bt/cbb_prior_2026.json)
Anything tuned (the blend weight, the blend's keep) is chosen on 11/1-12/31/2025 only and judged on
1/1-4/9/2026. Grades at Onyx's opening AND closing prices, by market and by month.

samples() is what tools/sports_backtest.py and tools/picks_backtest.py read for cbb.
"""
import json, math, os, sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
import cbb_model as M        # noqa: E402
import team_model as T       # noqa: E402
import sports_lab as L       # noqa: E402

LANE = os.path.join(ROOT, "data", "cbb")
LINES = os.path.join(ROOT, "bt", "cbb_lines.json")
PRIOR = os.path.join(ROOT, "bt", "cbb_prior_2026.json")
SPLIT = "2026-01-01"
TUNE, TEST = ("2025-11-01", "2025-12-31"), ("2026-01-01", "2026-04-09")

# OpticOdds names that fold to no ESPN location / short name / Torvik name (value: ESPN abbreviation)
ALIAS = {"Miami Florida": "MIA", "North Carolina State": "NCSU", "Southern Mississippi": "USM", "Miami Ohio": "M-OH",
         "IUPUI": "IUIN", "St. Thomas-Minnesota": "STMN", "Appalachian State": "APP", "St. Francis Pennsylvania": "SFPA",
         "Sam Houston State": "SHSU", "Texas A&M Commerce": "ETAM"}


def sane(a, b):
    if a is None or b is None:
        return False
    s = L.implied(a) + L.implied(b)
    return 1.0 <= s <= 1.12


def namer():
    names = json.load(open(os.path.join(LANE, "teams_espn.json")))
    tm = json.load(open(os.path.join(LANE, "history", "team_map.json")))
    tv = {v["torvik"]: v["abbr"] for v in tm.values()}
    es = {M._fold(v["espn"]): v["abbr"] for v in tm.values()}
    look = M.torvik_map(names)
    return names, lambda n: ALIAS.get(n) or tv.get(n) or es.get(M._fold(n)) or look(n)


def et_day(start):
    d = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(timezone.utc) - timedelta(hours=5)
    return d.date().isoformat()


def match(lines, games, team_of):
    """[(fixture, game, {OpticOdds name: ESPN abbr})] and the match report."""
    by = defaultdict(list)
    for g in games:
        by[g["date"]].append(g)
    out, rep = [], {"fixtures": len(lines), "names": 0, "names_mapped": 0, "slots": 0, "slots_mapped": 0,
                    "matched": 0, "score_mismatch": 0, "unmapped": {}}
    seen = {}
    for x in lines.values():
        for n in (x["home"], x["away"]):
            seen[n] = team_of(n)
            rep["slots"] += 1
            rep["slots_mapped"] += bool(seen[n])
    rep["names"], rep["names_mapped"] = len(seen), sum(1 for v in seen.values() if v)
    rep["unmapped"] = sorted(n for n, v in seen.items() if not v)
    used = set()
    for fid, x in sorted(lines.items(), key=lambda kv: kv[1].get("start") or ""):
        h, a = team_of(x["home"]), team_of(x["away"])
        if not (h and a and x.get("start")):
            continue
        d0 = et_day(x["start"])
        g = None
        for k in (0, -1, 1):
            dd = (date.fromisoformat(d0) + timedelta(days=k)).isoformat()
            g = next((y for y in by.get(dd, []) if {y["home"], y["away"]} == {h, a} and y["id"] not in used), None)
            if g:
                break
        if not g:
            continue
        used.add(g["id"])
        sc = {h: x.get("hs"), a: x.get("as")}
        if sc[g["home"]] is not None and (sc[g["home"]], sc[g["away"]]) != (g["hs"], g["as"]):
            rep["score_mismatch"] += 1
        out.append((fid, x, g, {x["home"]: h, x["away"]: a}))
    rep["matched"] = len(out)
    return out, rep


def load_prior(path=PRIOR):
    try:
        return json.load(open(path))["teams"]
    except Exception:
        return None


def walk(matched, games, names, blend=None):
    """{game id: (eh, ea)}: ratings as of each game's date, from games before that date only."""
    fits, out = {}, {}
    for fid, x, g, nm in matched:
        d = g["date"]
        if d not in fits:
            fits[d] = M.ratings(LANE, games, d, names, blend=blend)
        R = fits[d]
        if R["n"].get(g["home"], 0) < M.P["min_games"] or R["n"].get(g["away"], 0) < M.P["min_games"]:
            continue
        out[g["id"]] = T.expect(R, g["home"], g["away"], g.get("neutral"))
    return out


def samples(lines_path=LINES, prior="v2", prior_path=PRIOR, quiet=False):
    """sports_backtest-style rows: {date, gid, mkt, when, p (home / home cover / over), over, under, y, line}."""
    lines = lines_path if isinstance(lines_path, dict) else json.load(open(lines_path))   # a dict: tools/picks_lines.lines
    names, team_of = namer()
    games = (json.load(open(os.path.join(LANE, "results.json"))) or {}).get("games") or []
    matched, rep = match(lines, games, team_of)
    blend = load_prior(prior_path) if prior == "blend" else None
    if prior == "blend" and not blend:
        raise SystemExit(f"no blend prior at {prior_path} (tools/cbb_transfers_backtest.py <cache> --prior 2026 {prior_path})")
    E = walk(matched, games, names, blend)
    out = []
    for fid, x, g, nm in matched:
        if g["id"] not in E:
            continue
        eh, ea = E[g["id"]]
        pr = T.fb_probs(eh, ea, M.P)
        m, tot = g["hs"] - g["as"], g["hs"] + g["as"]
        gm = x.get("game") or {}
        base = {"date": g["date"], "gid": g["id"], "ht": g["home"], "at": g["away"], "eh": eh, "ea": ea, "hs": g["hs"], "as": g["as"]}
        side = lambda d: ({k: v for k, v in (d or {}).items() if nm.get(k) == g["home"]},
                          {k: v for k, v in (d or {}).items() if nm.get(k) == g["away"]})
        for when in ("o", "c"):
            hm, am = side(gm.get("moneyline"))
            if hm and am:
                po, pu = next(iter(hm.values()))[when][1], next(iter(am.values()))[when][1]
                if sane(po, pu) and m != 0:
                    out.append(dict(base, mkt="ml", when=when, p=pr["home_win"], over=po, under=pu, y=int(m > 0)))
            hs_, as_ = side(gm.get("point_spread"))
            if hs_ and as_:
                pts, po = next(iter(hs_.values()))[when]
                pu = next(iter(as_.values()))[when][1]
                if pts is not None and sane(po, pu) and m + pts != 0:
                    out.append(dict(base, mkt="spread", when=when, p=pr["home_cover"](pts), over=po, under=pu,
                                    y=int(m + pts > 0), line=pts))
            tt = gm.get("total_points") or {}
            if "over" in tt and "under" in tt:
                ln, po = tt["over"][when]
                pu = tt["under"][when][1]
                if ln is not None and sane(po, pu) and tot != ln:
                    out.append(dict(base, mkt="total", when=when, p=pr["over"](ln), over=po, under=pu, y=int(tot > ln), line=ln))
    rep["priced_games"] = len(E)
    if not quiet:
        print(f"  cbb ({prior}): {rep['fixtures']} Onyx games; names {rep['names_mapped']}/{rep['names']} mapped "
              f"({rep['slots_mapped']}/{rep['slots']} team slots); {rep['matched']} matched to ESPN finals "
              f"({rep['score_mismatch']} score mismatches); {len(E)} priced; {len(out)} samples")
    return out, rep


# ── the report ─────────────────────────────────────────────────────────────────────────────────
def game_metrics(S, lo, hi):
    """win log loss, margin and total error on the priced games in [lo, hi] (one row per game)"""
    g = {}
    for r in S:
        if lo <= r["date"] <= hi:
            g[r["gid"]] = r
    ll = mm = mt = 0.0
    for r in g.values():
        p = min(max(1 - L.ncdf(-(r["eh"] - r["ea"]) / M.P["sd_margin"]), 1e-6), 1 - 1e-6)
        ll += -math.log(p if r["hs"] > r["as"] else 1 - p)
        mm += abs(r["eh"] - r["ea"] - (r["hs"] - r["as"]))
        mt += abs(r["eh"] + r["ea"] - r["hs"] - r["as"])
    n = len(g) or 1
    return {"n": len(g), "logloss": round(ll / n, 4), "margin_mae": round(mm / n, 3), "total_mae": round(mt / n, 3)}


def mkt_ll(S, lo, hi, mkt, w):
    rows = [r for r in S if r["when"] == "o" and r["mkt"] == mkt and lo <= r["date"] <= hi]
    a = b = c = 0.0
    for r in rows:
        fo, _ = L.fair_pair(r["over"], r["under"])
        for p, acc in ((L.blend(r["p"], fo, w), 0), (fo, 1), (r["p"], 2)):
            p = min(max(p, 1e-4), 1 - 1e-4)
            v = -math.log(p if r["y"] else 1 - p)
            if acc == 0: a += v
            elif acc == 1: b += v
            else: c += v
    n = len(rows) or 1
    return {"n": len(rows), "blend": round(a / n, 4), "onyx": round(b / n, 4), "model": round(c / n, 4)}


def pick_rows(S, w):
    """the live rows (better side after the blend) through the Top 10 rule, as picks_backtest.cand builds them"""
    import picks_backtest as PB
    ro, rc = [], []
    for r in S:
        ps = L.price_side(r["p"], r["over"], r["under"], w)
        if not ps:
            continue
        c = PB.cand(r["date"], (r["gid"], r["mkt"]), ps["side"], ps["prob"], ps["price"], (r["y"] == 1) == (ps["side"] == "over"))
        (ro if r["when"] == "o" else rc).append(c and dict(c, mkt=r["mkt"]))
    return ro, rc


def roi_table(S, w):
    import picks_backtest as PB
    ro, rc = pick_rows(S, w)
    out = {}
    for mk in ("spread", "total", "ml"):
        co = PB.card([c for c in ro if c and c["mkt"] == mk])
        cc = PB.card([c for c in rc if c and c["mkt"] == mk])
        row = {}
        for nm, (lo, hi) in (("tune", TUNE), ("test", TEST)):
            row[nm] = {"open": PB.tally([b for b in co if lo <= b["date"] <= hi]), "close": PB.tally([b for b in cc if lo <= b["date"] <= hi])}
        months = sorted({b["date"][:7] for b in co + cc})
        row["months"] = {m_: {"open": PB.tally([b for b in co if b["date"][:7] == m_]), "close": PB.tally([b for b in cc if b["date"][:7] == m_])}
                         for m_ in months}
        out[mk] = row
    return out


def fmt(t):
    if not t["n"]:
        return "      0 bets          "
    return f"{t['w']:>3}-{t['l']:<3} n={t['n']:<4} ROI {t['roi'] * 100:+6.1f}%"


def main():
    argv = sys.argv[1:]
    args = [a for i, a in enumerate(argv) if not a.startswith("--") and not (i and argv[i - 1] in ("--prior", "--json"))]
    lines = args[0] if args else LINES
    pp = sys.argv[sys.argv.index("--prior") + 1] if "--prior" in sys.argv else PRIOR
    W_GRID = (0.1, 0.2, 0.3, 0.5)
    rep = {}
    variants = [("v2", "v2", None)]
    if load_prior(pp):
        for k in (0.85, 1.0):
            variants.append((f"blend keep {k}", "blend", k))
    keep0 = M.BLEND_KEEP
    for label, pr, keep in variants:
        if keep is not None:
            M.BLEND_KEEP = keep
        S, mrep = samples(lines, pr, pp)
        M.BLEND_KEEP = keep0
        rep[label] = {"match": mrep, "S": S}
    print("\nname match:", json.dumps({k: v for k, v in rep["v2"]["match"].items() if k != "unmapped"}),
          "unmapped:", rep["v2"]["match"]["unmapped"])
    out = {}
    for label, v in rep.items():
        S = v["S"]
        # the blend weight: Nov-Dec log loss over the three markets (sports_backtest's choice)
        tw = {w: sum(mkt_ll(S, *TUNE, mk, w)["blend"] * mkt_ll(S, *TUNE, mk, w)["n"] for mk in ("ml", "spread", "total")) for w in W_GRID}
        w = min(tw, key=tw.get)
        o = {"w_tuned": w, "tune": game_metrics(S, *TUNE), "test": game_metrics(S, *TEST),
             "ll_test": {mk: mkt_ll(S, *TEST, mk, w) for mk in ("ml", "spread", "total")},
             "ll_tune": {mk: mkt_ll(S, *TUNE, mk, w) for mk in ("ml", "spread", "total")},
             "roi_live_w": roi_table(S, 0.3), "roi_tuned_w": roi_table(S, w) if w != 0.3 else None}
        out[label] = o
        print(f"\n=== {label}  (blend weight tuned on Nov-Dec: {w}) ===")
        for nm in ("tune", "test"):
            g = o[nm]
            print(f"  {nm:5s} games {g['n']:>5}  win log loss {g['logloss']:.4f}  margin MAE {g['margin_mae']:.3f}  total MAE {g['total_mae']:.3f}")
        for mk, x in o["ll_test"].items():
            print(f"  test {mk:6s} log loss: blend {x['blend']:.4f}  Onyx no-vig {x['onyx']:.4f}  model alone {x['model']:.4f}  ({x['n']} lines)")
        for wl, tab in (("0.3 (live default)", o["roi_live_w"]), (str(w) + " (tuned)", o["roi_tuned_w"])):
            if not tab:
                continue
            print(f"  -- Top 10 rule, blend weight {wl}")
            for mk, row in tab.items():
                print(f"   {mk:6s} tune  open {fmt(row['tune']['open'])}  close {fmt(row['tune']['close'])}")
                print(f"   {mk:6s} TEST  open {fmt(row['test']['open'])}  close {fmt(row['test']['close'])}")
                for m_, t in row["months"].items():
                    print(f"      {m_}  open {fmt(t['open'])}  close {fmt(t['close'])}")
    if "--json" in sys.argv:
        json.dump(out, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)


if __name__ == "__main__":
    main()
