#!/usr/bin/env python3
"""
picks_backtest.py - every market, one pick rule, real Onyx prices. Dev only.

Jordan (11/2): "we need to track plays what it recommends not leans and trials".
Onyx Picks are the plays the home Top 10 rule picks (daily_top.ok):

    Onyx main line priced -150 to +200, our chance beats the price's implied
    chance by 2 to 12 points, expected return +3% or better, chance 40%+

This replays that exact rule on every market where we can rebuild the chance the
live site shows, walk-forward (every chance from data before the game), against
Onyx's real OPENING and CLOSING prices, and writes data/picks/backtest.json:
per sport x market, the bets, W-L, units and ROI at open and close, on the
tuning period and on the held-out period the model never saw, and a verdict.

The card is replayed the way picks.py logs it: one pick per player (or game
market) a game, best expected return first, at most picks.CAP a day.

FINALIZE (a market's picks go live as tracked Onyx Picks) when, on the held-out
period only:
    n >= MIN_N bets at the opening price, ROI >= MIN_ROI (+2%) at the opening price
    AND at the closing price (a logged price lands between the two), AND the market did
    not lose badly in its own tuning months (ROI above TUNE_FLOOR, -5%, at the open and at
    the close, when the tuning period has TUNE_N+ bets).
Tightened 11/3 (Jordan): CBB moneylines had passed the old "ROI > 0" bar at +0.4% on 87
bets after losing -11% / -17% in their tuning months; a pass that thin is noise.
Fewer bets than MIN_N is "not enough yet", never a pass. 60 bets at -110 still
carry about +/-13 points of ROI noise, so a pass is "worth tracking in public",
not proof: the public ledger decides from here.

A market's verdict holds only for the model version it was run on. picks.py
checks the live VERSION against the one recorded here, so a model change sends
the market back to projections until this is re-run.

    python3 tools/picks_backtest.py            # reads data/picks/lines (committed), plus bt/ when present

Re-tested weekly by .github/workflows/picks_retest.yml: it appends the last 8 days of Onyx lines to
data/picks/lines/<sport>.json (tools/picks_lines.py), re-runs this, and commits the verdicts. Every replay
reads the committed lines (merged with the local bt/ caches when present), so a fresh runner re-tests the
team game lines (NFL, CFB, NHL, CBB), the NBA 1st-quarter and 1st-half totals, NBA props (2026-27 rebuilt
from the live box scores; the 2025-26 card from data/picks/lines/nba_frozen.json while the rule matches),
NFL receptions and the college player props. Markets whose inputs are only in bt/ (NFL v11 rows, tennis)
keep their last computed verdict, marked "carried" with the day it was computed.

Sources (data/picks/lines/ committed; bt/ local, see tools/rules_lab_build.py for how bt/ is pulled):
  team game lines  tools/sports_backtest.team_samples on data/picks/lines/{nfl,cfb,nhl}.json (+ bt/nfl_game.json,
                   bt/cfb_lines.json, bt/nhl_lines.json); college basketball from tools/cbb_price_backtest.samples
                   on data/picks/lines/cbb.json (+ bt/cbb_lines.json); chance = the live blend at the backtest lane
                   weight (data/<sport>/backtest.json lane w, sports_build.DEFAULT_W 0.3 without one)
  tennis moneyline tools/sports_backtest.tennis_samples (Elo), same blend
  NBA props        tools/nba_backtest.walk (v8, confirmed lineups, simulated roster): 2025-26 on bt/nba,
                   2026-27 on the live box scores (data/nba/player_games.json, data/nba/prior.json); the live
                   20/80 model / Onyx blend, 28+ projected minutes like the Top 10
  NBA 1Q total     open_lanes.P on Onyx's game total (data/picks/lines/nba.json), graded off ESPN's
                   official 1st-quarter line scores (play-by-play bt/nba_periods.json only where missing)
  NFL v11 lanes    tools/nfl_feature_screen.py rows; statistics as live (nfl_model.V11),
                   coefficients refit on 2025 only, judged on 2026
  more replays     tools/picks_replays.py: NBA 1st-half total, tennis total games and game
                   spread, NFL receptions (unders), college football player props, college basketball
                   player props (tools/cbb_props_backtest.py; 2025-26 card frozen in
                   data/picks/lines/cbb_props_frozen.json for a runner without bt/)
Markets with no replay of the live chance are listed with the reason and never finalized.
A market whose numbers pass but that picks.py cannot grade, or that the live Top 10 never
shows, is marked "passes, not offered" and is not finalized: nothing would ever be logged.
"""
import json, math, os, sys
from collections import defaultdict
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
os.chdir(ROOT)
import daily_top as DT      # noqa: E402  the rule itself, not a copy
import sports_lab as L      # noqa: E402
import picks as PK          # noqa: E402  the card cap
import picks_lines as PL    # noqa: E402  data/picks/lines: the committed Onyx lines (merged with bt/ when present)

MIN_N = 60
MIN_ROI = 0.02      # a pass needs a real margin, not a hair above zero (11/3)
TUNE_FLOOR, TUNE_N = -0.05, 30   # and must not have lost badly where its weights were chosen
# 11/6 (Jordan): markets whose picks lock only at Onyx's opening price (picks.OPENER). Judged at the open
# alone (60+ held-out bets, +2% or better, no loss worse than -5% at the open in the tuning months): a pick
# logged at the opener is paid at the opener, so the close does not decide it. NBA points: held-out 30-23,
# +9.4% at the open on 53 bets, +24% in the tuning months, -6.7% at the close (the line moves to our number).
OPENER = set(getattr(PK, "OPENER", {("nba", "pts")}))   # picks.OPENER, the one list
OUT = "data/picks/backtest.json"
NAME = {"ml": "Moneyline", "spread": "Spread", "total": "Game total", "pts": "Points", "reb": "Rebounds", "ast": "Assists",
        "q1_total": "1st-quarter total", "rush_yds": "Rushing yards", "pass_att": "Pass attempts", "pass_yds": "Passing yards",
        "rec": "Receptions", "rec_yds": "Receiving yards", "anytime_td": "Anytime TD", "first_td": "First TD", "pass_td": "Passing TDs",
        "first_basket": "First basket", "h1_total": "1st-half total", "total_games": "Total games", "game_spread": "Game spread",
        "props": "Player props", "all": "Every market", "hr": "Home runs", "k": "Strikeouts", "3pm": "Made threes",
        "pra": "Points + rebounds + assists"}


def payout(price):
    return price / 100.0 if price > 0 else 100.0 / -price


def cand(date_, key, side, prob, price, won, extra_ok=True):
    """One priced side as the live Top 10 sees it, or None when the pick rule turns it away."""
    if prob is None or price is None:
        return None
    r = {"price": price, "prob": prob, "edge": prob - L.implied(price)}
    if not (DT.ok(r) and extra_ok):
        return None
    return {"date": date_, "key": key, "side": side, "price": price, "prob": prob, "ev": DT.ev(price, prob), "won": won}


def card(cands):
    """The card picks.py logs: one per key a day (best expected return), at most PK.CAP a day."""
    by = defaultdict(list)
    for c in cands:
        if c:
            by[c["date"]].append(c)
    out = []
    for d, cs in by.items():
        seen = set()
        for c in sorted(cs, key=lambda c: (-c["ev"], -c["prob"])):
            if c["key"] in seen or len(seen) >= PK.CAP:
                continue
            seen.add(c["key"])
            out.append(c)
    return out


def tally(bets):
    w = sum(1 for b in bets if b["won"] is True)
    l_ = sum(1 for b in bets if b["won"] is False)
    p = sum(1 for b in bets if b["won"] is None)
    u = sum(payout(b["price"]) if b["won"] is True else -1.0 if b["won"] is False else 0.0 for b in bets)
    n = w + l_ + p
    days = sorted({b["date"] for b in bets})
    return {"n": n, "w": w, "l": l_, "p": p, "units": round(u, 2), "roi": round(u / n, 4) if n else None,
            "avg_price": round(sum(b["price"] for b in bets) / n) if n else None,
            "claimed": round(sum(b["prob"] for b in bets) / n, 4) if n else None,
            "hit": round(w / (w + l_), 4) if w + l_ else None, "first": days[0] if days else None, "last": days[-1] if days else None}


def judge(test_o, test_c, tune_o=None, tune_c=None, opener=False):
    n, ro, rc = test_o["n"], test_o["roi"], test_c["roi"]
    if not n:
        return "no bets", "the pick rule found no bet in the held-out period"
    if n < MIN_N:        # a small sample is "not enough yet", either way: never a pass, never a verdict
        return "not enough yet", f"only {n} held-out bets (needs {MIN_N}); ROI {ro * 100:+.1f}% at the open" + \
            (f", {rc * 100:+.1f}% at the close" if rc is not None else "") + " so far" + (" (locks at the opener: judged at the open)" if opener else "")
    if ro <= 0:
        return "fails", f"lost at the opening price ({ro * 100:+.1f}% on {n})"
    if opener:       # locks only at Onyx's opening price (picks.OPENER): the open decides, the close is shown
        if ro < MIN_ROI:
            return "fails", f"too thin to trust at the open: {ro * 100:+.1f}% (needs {MIN_ROI * 100:+.0f}%)"
        if tune_o and (tune_o.get("n") or 0) >= TUNE_N and tune_o.get("roi") is not None and tune_o["roi"] < TUNE_FLOOR:
            return "fails", f"held-out {ro * 100:+.1f}% at the open, but lost {tune_o['roi'] * 100:+.1f}% at the open in its tuning months"
        return "finalized", f"{test_o['w']}-{test_o['l']}{'-' + str(test_o['p']) if test_o['p'] else ''} at the open, ROI {ro * 100:+.1f}%; " \
                            f"locks at the opener only (ROI {rc * 100:+.1f}% at the close)" if rc is not None else "locks at the opener only"
    if rc is None or test_c["n"] == 0:
        return "not enough yet", "no closing prices to check"
    if rc <= 0:
        return "fails", f"won at the open ({ro * 100:+.1f}%) but lost at the close ({rc * 100:+.1f}% on {test_c['n']})"
    if ro < MIN_ROI or rc < MIN_ROI:
        return "fails", f"too thin to trust: {ro * 100:+.1f}% at the open, {rc * 100:+.1f}% at the close (needs {MIN_ROI * 100:+.0f}% at both)"
    for lab, t in (("open", tune_o), ("close", tune_c)):
        if t and (t.get("n") or 0) >= TUNE_N and t.get("roi") is not None and t["roi"] < TUNE_FLOOR:
            return "fails", f"held-out {ro * 100:+.1f}% / {rc * 100:+.1f}%, but lost {t['roi'] * 100:+.1f}% at the {lab} in its tuning months " \
                            f"({t['n']} bets), so the held-out profit looks like luck"
    return "finalized", f"{test_o['w']}-{test_o['l']}{'-' + str(test_o['p']) if test_o['p'] else ''} at the open, ROI {ro * 100:+.1f}%; " \
                        f"ROI {rc * 100:+.1f}% at the close"


def market(sport, mkt, version, chance, source, split, rows_o, rows_c, held="", notes=""):
    """rows_*: candidate dicts (from cand) at the opening / closing price. split: first held-out day."""
    co, cc = card(rows_o), card(rows_c)
    T = lambda bets, test: tally([b for b in bets if (b["date"] >= split) == test])
    res = {"sport": sport, "market": mkt, "name": NAME.get(mkt, mkt), "version": version, "chance": chance, "source": source,
           "held_out_from": split, "held_out": held or f"games on or after {split}",
           "tune": {"open": T(co, False), "close": T(cc, False)}, "test": {"open": T(co, True), "close": T(cc, True)}}
    res["verdict"], res["why"] = judge(res["test"]["open"], res["test"]["close"], res["tune"]["open"], res["tune"]["close"], (sport, mkt) in OPENER)
    if (sport, mkt) in OPENER:
        res["opener"] = True
    if notes:
        res["notes"] = notes
    t = res["test"]["open"]
    print(f"  {sport:6s} {mkt:10s} held-out open {t['w']}-{t['l']} n={t['n']} roi={t['roi']}  close n={res['test']['close']['n']} "
          f"roi={res['test']['close']['roi']}  tune n={res['tune']['open']['n']} roi={res['tune']['open']['roi']}  -> {res['verdict']}")
    return res


# ── team game lines (NFL, college football, NHL) and tennis moneylines ──────────────
def team_markets():
    import importlib
    import sports_backtest as SB
    out = []
    for key, f in (("nfl", "bt/nfl_game.json"), ("cfb", "bt/cfb_lines.json"), ("nhl", "bt/nhl_lines.json")):
        X = PL.lines(key, f)
        if not X:
            continue
        M = importlib.import_module({"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model"}[key])
        GP = M.GAME_P if key == "nfl" else M.P
        bt = json.load(open(f"data/{key}/backtest.json"))
        w = (bt.get("lane") or {}).get("w") or 0.3          # sports_build.team_block / nfl_block: the live blend weight
        S = SB.team_samples(key, X, M, GP)
        for mk in ("ml", "spread", "total"):
            if mk == "total" and getattr(M, "NO_TOTALS", False):
                continue
            ro, rc = [], []
            for r in S:
                if r["mkt"] != mk:
                    continue
                ps = L.price_side(r["p"], r["over"], r["under"], w)     # the live row: the better side after the blend
                if not ps:
                    continue
                won = None if False else ((r["y"] == 1) == (ps["side"] == "over"))
                c = cand(r["date"], (r["gid"], mk), ps["side"], ps["prob"], ps["price"], won)
                (ro if r["when"] == "o" else rc).append(c)
            out.append(market(key, mk, M.VERSION, f"team ratings blended {round(w * 100)}% with Onyx's no-vig price",
                              f"Onyx lines (data/picks/lines/{key}.json), ESPN finals", SB.SPLIT[key], ro, rc))
    X = PL.lines("cbb", "bt/cbb_lines.json")
    if X:
        # college basketball: cbb_model.ratings walk-forward (tools/cbb_price_backtest.py maps Onyx's names to ESPN)
        import cbb_model as CM
        import cbb_price_backtest as CPB
        bt = (json.load(open("data/cbb/backtest.json")) if os.path.exists("data/cbb/backtest.json") else {})
        w = (bt.get("lane") or {}).get("w") or 0.3          # sports_build.team_block: the live blend weight (DEFAULT_W without a backtest)
        S, _ = CPB.samples(X)
        for mk in ("ml", "spread", "total"):
            ro, rc = [], []
            for r in S:
                if r["mkt"] != mk:
                    continue
                ps = L.price_side(r["p"], r["over"], r["under"], w)
                if not ps:
                    continue
                c = cand(r["date"], (r["gid"], mk), ps["side"], ps["prob"], ps["price"], (r["y"] == 1) == (ps["side"] == "over"))
                (ro if r["when"] == "o" else rc).append(c)
            out.append(market("cbb", mk, CM.VERSION, f"team ratings blended {round(w * 100)}% with Onyx's no-vig price",
                              "Onyx lines (data/picks/lines/cbb.json, 2025-26 on), ESPN finals", CPB.SPLIT, ro, rc,
                              held="Jan 1 to Apr 9 2026 (Nov-Dec 2025 tuned the blend weight)"))
    if os.path.exists("bt/tennis_atp_lines.json"):
        import tennis_model as TM
        bt = json.load(open("data/tennis/backtest.json"))
        w = (bt.get("lane") or {}).get("w") or 0.3
        S = SB.tennis_samples([f for f in ("bt/tennis_atp_lines.json", "bt/tennis_wta_lines.json") if os.path.exists(f)])
        ro, rc = [], []
        for r in S:
            ps = L.price_side(r["p"], r["over"], r["under"], w)
            if not ps:
                continue
            c = cand(r["date"], (r["gid"], "ml"), ps["side"], ps["prob"], ps["price"], (r["y"] == 1) == (ps["side"] == "over"))
            (ro if r["when"] == "o" else rc).append(c)
        out.append(market("tennis", "ml", TM.VERSION, f"Elo blended {round(w * 100)}% with Onyx's no-vig price",
                          "bt/tennis_*_lines.json, ATP/WTA results", SB.SPLIT["tennis"], ro, rc))
    return out


# ── NBA player props (the live v8 replay) ───────────────────────────────────────────
FROZEN_NBA = "data/picks/lines/nba_frozen.json"


def _nba_rule_sig():
    import nba_model as M
    import nba_build as NBB
    return f"{M.VERSION} w{M.MODEL_WEIGHT} min{NBB.TICKET_MIN_MIN} price{list(DT.PRICE)} edge{DT.MIN_EDGE}-{DT.MAX_EDGE} " \
           f"ev{DT.MIN_EV} conf{DT.MIN_CONF}"


def _nba_cands(recs):
    """{stat: (open cands, close cands)} from tools/nba_backtest.walk records, as the live Top 10 prices them."""
    import nba_model as M
    import nba_build as NBB
    out = {}
    for s in ("pts", "reb", "ast"):
        ro, rc = [], []
        for r in recs:
            if r["pmin"] < NBB.TICKET_MIN_MIN:          # the Top 10 takes 28+ projected minutes only
                continue
            m = (r["props"] or {}).get(s)
            if not m:
                continue
            act = r["act"][s]
            for when, dst in (("o", ro), ("c", rc)):
                line, po, pu = m[when]
                io, iu = M.implied(po), M.implied(pu)
                if line is None or not io or not iu or not (1.0 <= io + iu <= 1.15) or act == line:
                    continue
                p_over, p_push = M.prob_over(r["proj"][s], float(line), s)
                pm = p_over / (1 - p_push) if p_push < 1 else p_over
                nv = io / (io + iu)
                for side, pmod, nvs, price in (("over", pm, nv, po), ("under", 1 - pm, 1 - nv, pu)):
                    pb = M.MODEL_WEIGHT * pmod + (1 - M.MODEL_WEIGHT) * nvs
                    dst.append(cand(r["d"], (r["gid"], r["pid"]), side, round(pb, 4), int(price), (act > line) == (side == "over")))
        out[s] = ([c for c in ro if c], [c for c in rc if c])
    return out


def _nba_2526():
    """2025-26 walk records (bt/picks_nba_replay.json, built from bt/nba when missing), or None."""
    cache = "bt/picks_nba_replay.json"
    if not os.path.exists(cache):
        if not os.path.exists("bt/nba/lines.json"):
            return None
        import nba_backtest as NB
        from nba_common import nk
        G, lines = NB.load("bt/nba")
        prior = NB.build_prior(G, lines, "2025-08-01")
        mk = json.load(open("bt/nba/lines.json"))
        for gid, g in mk.items():
            NB.NAMEMAP[gid] = {nk(n): v for n, v in (g.get("props") or {}).items()}
        NB.SIM_ROSTER, NB.SIM_LINEUP = True, True
        recs = NB.walk(G, lines, "2025-10-01", "2026-04-30", prior, mk)
        json.dump([{k: r[k] for k in ("d", "gid", "pid", "name", "pmin", "proj", "act", "props")} for r in recs if r["props"]],
                  open(cache, "w"))
    return json.load(open(cache))


def _nba_2627():
    """2026-27 walk records: the same walk (v8, simulated roster, confirmed lineups) on the live box scores
    (data/nba/player_games.json), the live prior (data/nba/prior.json, built from 2025-26 before the season)
    and Onyx's lines on file (data/picks/lines/nba.json). Runs on a fresh checkout."""
    import nba_backtest as NB
    from nba_common import nk
    if not os.path.exists("data/nba/player_games.json") or not os.path.exists("data/nba/prior.json"):
        return []
    pg = json.load(open("data/nba/player_games.json"))
    prior = json.load(open("data/nba/prior.json"))
    X = {fid: x for fid, x in PL.lines("nba", "bt/nba_lines_full.json").items()
         if (x.get("start") or "") >= "2026-08-01" and not x.get("pre")}
    rows = defaultdict(list)
    for pid, r in pg.items():
        if not isinstance(r, dict):
            continue
        for g in r.get("g") or []:
            rows[g[1]].append((pid, r, g))
    G, lines, mk = {}, defaultdict(list), {}
    for fid, rs in rows.items():
        home = next((g[2] for _, _, g in rs if not g[3]), None)       # an away player's opponent is the home team
        away = next((g[2] for _, _, g in rs if g[3]), None)
        if not home or not away or fid not in X:
            continue
        G[fid] = {"gid": fid, "d": rs[0][2][0], "home": home, "away": away, "hs": X[fid].get("hs"), "as": X[fid].get("as")}
        for pid, r, g in rs:
            d, _, opp, hm, mn, pts, reb, ast, fg3, st, fga, fta, tov = g[:13]
            lines[fid].append({"pid": pid, "name": r.get("n"), "pos": (prior.get(pid) or {}).get("pos") or "",
                               "team": home if hm else away, "starter": st, "min": float(mn or 0), "pts": float(pts or 0),
                               "reb": float(reb or 0), "ast": float(ast or 0), "fg3": float(fg3 or 0), "fga": float(fga or 0),
                               "fta": float(fta or 0), "oreb": 0.0, "tov": float(tov or 0),
                               "pm": float(g[13]) if len(g) > 13 and g[13] is not None else None})
        x, gm = X[fid], X[fid].get("game") or {}
        tt, sp = gm.get("total_points") or {}, gm.get("point_spread") or {}
        hk = x.get("home") if x.get("home") in sp else None
        props = {}
        for who, ms in (x.get("props") or {}).items():
            for m, st_ in (("player_points", "pts"), ("player_rebounds", "reb"), ("player_assists", "ast")):
                if m in ms:
                    props.setdefault(who, {})[st_] = ms[m]
        mk[fid] = {"props": props,
                   "total": [tt["over"]["o"][0], tt["over"]["c"][0]] if "over" in tt else [None, None],
                   "spread_home": [sp[hk]["o"][0], sp[hk]["c"][0]] if hk else [None, None]}
        NB.NAMEMAP[fid] = {nk(n): v for n, v in props.items()}
    if not G:
        return []
    NB.SIM_ROSTER, NB.SIM_LINEUP = True, True
    recs = NB.walk(G, lines, "2026-08-01", "2027-07-31", prior, mk)
    print(f"  nba 2026-27 walk: {len(G)} games, {sum(1 for r in recs if r['props'])} priced player-games")
    return [r for r in recs if r["props"]]


def nba_props():
    """2025-26 (bt/, or its card kept in data/picks/lines/nba_frozen.json for a fresh runner) + 2026-27 (always rebuilt)."""
    import nba_model as M
    sig = _nba_rule_sig()
    old = _nba_2526()
    if old is not None:
        C = _nba_cands(old)
        frozen = {"note": "2025-26 Onyx Picks card candidates for NBA props (tools/picks_backtest.py): the v8 walk on bt/nba, "
                          "kept so a runner without bt/ can re-test; used only while the rule signature matches",
                  "sig": sig, "before": "2026-08-01",
                  "cands": {s: {w: [[c["date"], c["key"][0], c["key"][1], c["side"], c["price"], c["prob"], c["won"]] for c in cs]
                                for w, cs in zip(("o", "c"), C[s])} for s in C}}
        body = json.dumps(frozen, separators=(",", ":"))
        if not os.path.exists(FROZEN_NBA) or open(FROZEN_NBA).read() != body:
            os.makedirs(os.path.dirname(FROZEN_NBA), exist_ok=True)
            open(FROZEN_NBA, "w").write(body)
    elif os.path.exists(FROZEN_NBA) and json.load(open(FROZEN_NBA)).get("sig") == sig:
        F = json.load(open(FROZEN_NBA))["cands"]
        mkc = lambda r: {"date": r[0], "key": (r[1], r[2]), "side": r[3], "price": r[4], "prob": r[5],
                         "ev": DT.ev(r[4], r[5]), "won": r[6]}
        C = {s: tuple([mkc(r) for r in F[s][w]] for w in ("o", "c")) for s in F}
    else:
        return []          # no 2025-26 replay for this model / rule: carried from the last run (main)
    new = _nba_cands(_nba_2627())
    out = []
    for s in ("pts", "reb", "ast"):
        ro, rc = C[s][0] + new[s][0], C[s][1] + new[s][1]
        out.append(market("nba", s, M.VERSION, f"projection blended {round(M.MODEL_WEIGHT * 100)}% with Onyx's no-vig price",
                          "tools/nba_backtest.py walk-forward replay: 2025-26 on bt/nba, 2026-27 on the live box scores "
                          "(data/nba/player_games.json); Onyx open and close", "2026-02-01", ro, rc,
                          held="Feb to Apr 2026, then 2026-27 to date (v8 was chosen on Oct 2025 to Jan 2026)",
                          notes="Model tuned on Oct 2025 to Jan 2026; held out Feb to Apr 2026 and every 2026-27 game."))
    return out


def nba_q1():
    """1st-quarter totals: 25.4% of Onyx's game total, sd 12 (open_lanes.P), as nba_build.write_top prices them."""
    import open_lanes as OL
    from nba_common import team_abbr
    from picks_lines import et_day
    per = {(g["d"], tuple(g["teams"])): g for g in PL.nba_periods()}
    if not per:
        return []
    ro, rc = [], []
    for fid, x in PL.lines("nba", *PL.BT["nba"]).items():
        if not x.get("start"):
            continue
        d = et_day(x["start"])
        g = per.get((d, tuple(sorted([team_abbr(x.get("home")) or "", team_abbr(x.get("away")) or ""]))))
        gm = x.get("game") or {}
        q, t = gm.get("1st_quarter_total_points") or {}, gm.get("total_points") or {}
        if not g or "over" not in q or "under" not in q or "over" not in t:
            continue
        for when, dst in (("o", ro), ("c", rc)):
            ln, po = q["over"][when]
            pu = q["under"][when][1]
            tot = t["over"][when][0]
            if ln is None or tot is None or po is None or pu is None or g["q1"] == ln:
                continue
            pov = 1 - OL._phi((ln - tot * OL.P["q1"]) / OL.P["q1_sd"])
            for side, p, price in (("over", pov, po), ("under", 1 - pov, pu)):
                dst.append(cand(d, (fid, "q1"), side, p, price, (g["q1"] > ln) == (side == "over")))
    return [market("nba", "q1_total", PK.q1_signature(OL.P), "25.4% of Onyx's game total, normal sd 12 (open_lanes)",
                   "Onyx lines (data/picks/lines/nba.json), ESPN official 1st-quarter line scores", "2026-02-01", ro, rc,
                   held="Feb 2026 on: Feb to Jun 2026 and 2026-27 to date (the 25.4% share and sd 12 were tuned on Oct 2025 to Jan 2026)")]


# ── NFL v11 market models (rushing yards unders, pass attempts unders) ───────────────
def nfl_v11():
    """bt/picks_nfl_v11.json: tools/nfl_feature_screen.py rows (cached; built here when missing)."""
    import nfl_model as M
    import nfl_feature_screen as NFS
    cache = "bt/picks_nfl_v11.json"
    if not os.path.exists(cache):
        if not os.path.exists("bt/nfl_lines.json"):
            return []
        argv = sys.argv
        sys.argv = ["x"] + list(M.V11) + ["--proj"]
        DATA, _ = NFS.main()
        sys.argv = argv
        json.dump({m: [{k: s[k] for k in ("season", "date", "p", "po", "pu", "line_", "cl", "co", "cu", "y", "f", "pid")} for s in S]
                   for m, S in DATA.items()}, open(cache, "w"))
    DATA = json.load(open(cache))
    out = []
    for mkt, S in DATA.items():
        if mkt not in M.V11:
            continue
        spec = M.V11[mkt]
        tr = [s for s in S if s["season"] == 2025]
        if len(tr) < 150:
            continue
        fs = spec["features"]
        mu = {f: sum(s["f"].get(f, 0.0) for s in tr) / len(tr) for f in fs}
        sd = {f: (sum((s["f"].get(f, 0.0) - mu[f]) ** 2 for s in tr) / len(tr)) ** 0.5 or 1.0 for f in fs}
        X = lambda s: [1.0, NFS.logit(s["p"])] + [(s["f"].get(f, 0.0) - mu[f]) / sd[f] for f in fs]
        w = NFS.fit([X(s) for s in tr], [s["y"] for s in tr], 5.0)     # 2025 only: 2026 is unseen
        show = getattr(M, "V11_SHOW", {}).get(mkt, 1.0)
        ro, rc = [], []
        for s in S:
            if s["season"] not in (2025, 2026):
                continue
            pv = 1 / (1 + math.exp(-max(-30, min(30, sum(a * b for a, b in zip(w, X(s)))))))
            for when, dst in (("o", ro), ("c", rc)):
                if when == "o":
                    po, pu = s["po"], s["pu"]
                else:
                    if s.get("cl") != s.get("line_") or s.get("co") is None or s.get("cu") is None:
                        continue
                    po, pu = s["co"], s["cu"]
                ps = L.price_side(pv, po, pu, show)
                if not ps or ps["side"] != spec["side"]:
                    continue
                dst.append(cand(s["date"], (s["date"], s["pid"]), ps["side"], ps["prob"], ps["price"],
                                (s["y"] == 1) == (ps["side"] == "over"), extra_ok=ps["edge"] >= M.V11_EDGE))
        out.append(market("nfl", mkt, M.VERSION, f"Onyx's price moved by {', '.join(fs)} ({spec['side']}s only, {round(show * 100)}% shown)",
                          "tools/nfl_feature_screen.py rows (nflverse, Onyx open and close)", "2026-03-01", ro, rc,
                          held="2026 season (statistics and coefficients from 2025)",
                          notes="Close only where the closing line equals the opening line."))
    return out


# markets the live site prices that have no replay of the live chance (never finalized; the reason is shown)
NO_REPLAY = [
    ("nba", "first_basket", "Board only, never a Top 10 play. The corrected first-basket backtest (open-v4, 11/2: the earlier +38% "
                            "used a wrong first-scorer label) found no rule that beats Onyx's closing price (-8.7%), so it is never a pick."),
    ("nfl", "pass_td", "Nothing to replay: the live build marks passing TDs never-value (nfl_model NO_VALUE, v9: value bets too few, "
                       "blanket sides lost), so the Top 10 rule can never pick one."),
    ("nfl", "rec_yds", "Nothing to replay: excluded from plays by the model's own re-test (v6/v7, value_min 1.0), so the Top 10 rule can never pick one."),
    ("nfl", "pass_yds", "Nothing to replay: excluded from plays by the model's own re-test (v7, v12 dropped the v11 overs), so the Top 10 rule can never pick one."),
    ("nfl", "anytime_td", "Nothing to replay: the chance shown is Onyx's own price x .82 (v6), always below the price, so it is never value and never a pick."),
    ("cfb", "anytime_td", "Nothing to replay: the chance shown is Onyx's own price x .82, on the Ask Onyx board only, never value."),
    ("golf", "all", "Onyx prices no golf markets."),
    ("mlb", "all", "Season closed 10/29; MLB markets return with the 2027 season (HR and K lanes keep their own records)."),
]


def main():
    print("picks_backtest: one rule, every market")
    res = []
    res += nba_props()
    res += nba_q1()
    res += team_markets()
    res += nfl_v11()
    import picks_replays as PR
    res += PR.nba_h1()
    res += PR.nfl_rec()
    res += PR.cfb_props()
    res += PR.tennis_games()
    res += PR.cbb_props()
    for r in res:      # a pass that could never be logged is not a finalized market
        if r["verdict"] == "finalized" and (not PK.gradable(r["sport"], r["market"]) or r.get("board_only")):
            r["verdict"] = "passes, not offered"
            r["why"] += ("; not finalized: " + ("picks.py has no grader for it" if not PK.gradable(r["sport"], r["market"])
                                                else "the live Top 10 never shows it"))
    # a market whose inputs live only in bt/ (NFL v11 rows, tennis, the 2025-26 NBA walk under a new rule) cannot be
    # replayed on a fresh runner: keep its last verdict as it was computed, marked with the day it was computed
    today = PL.baseball_day().isoformat()
    prev = json.load(open(OUT)) if os.path.exists(OUT) else {}
    have = {(r["sport"], r["market"]) for r in res}
    for r in prev.get("markets") or []:
        if r.get("verdict") == "no replay" or (r["sport"], r["market"]) in have:
            continue
        r = dict(r)
        r["carried"] = r.get("carried") or prev.get("built")
        if r.get("test") and r["verdict"] in ("finalized", "fails", "not enough yet"):   # its numbers are kept; today's rule judges them
            v, w = judge(r["test"]["open"], r["test"]["close"], (r.get("tune") or {}).get("open"), (r.get("tune") or {}).get("close"), (r["sport"], r["market"]) in OPENER)
            if v != r["verdict"]:
                r["verdict"], r["why"] = v, w
        res.append(r)
        print(f"  {r['sport']:6s} {r['market']:10s} not replayable here (inputs in bt/ only): kept from {r['carried']} -> {r['verdict']}")
    order = {(r["sport"], r["market"]): i for i, r in enumerate(prev.get("markets") or [])}
    res.sort(key=lambda r: order.get((r["sport"], r["market"]), len(order)))
    for sp, mk, why in NO_REPLAY:
        res.append({"sport": sp, "market": mk, "name": NAME.get(mk, mk), "verdict": "no replay", "why": why})
    fin = [f"{r['sport']}:{r['market']}" for r in res if r["verdict"] == "finalized"]
    out = {"built": today,
           "rule": {"price": list(DT.PRICE), "edge": [DT.MIN_EDGE, DT.MAX_EDGE], "ev": DT.MIN_EV, "chance": DT.MIN_CONF,
                    "card": f"one per player or game market, best expected return first, up to {PK.CAP} a sport a day"},
           "finalize": {"min_n": MIN_N, "min_roi": MIN_ROI, "tune_floor": TUNE_FLOOR,
                        "text": f"held-out period: {MIN_N}+ bets and ROI of {MIN_ROI * 100:+.0f}% or better at Onyx's opening price AND at its closing price, and no loss worse than {TUNE_FLOOR * 100:.0f}% in its own tuning months"},
           "finalized": fin, "markets": res}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}: {len(res)} markets, finalized {fin}")


if __name__ == "__main__":
    main()
