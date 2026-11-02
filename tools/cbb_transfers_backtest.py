#!/usr/bin/env python3
"""Dev-only: fit and backtest cbb_transfers.py (transfer translation + player-based team prior).

  python3 tools/cbb_transfers_backtest.py <torvik cache dir> [--write]

<cache dir> holds Torvik's preseason ratings from the time machine, tm_YYYYMMDD.gz
(https://barttorvik.com/timemachine/team_results/{YYYYMMDD}_team_results.json.gz, the day
before each season's first games; columns as tools/cbb_history.py documents: 1 team,
4 adj_o, 6 adj_d, 44 tempo). With --write it rewrites data/cbb/history/transfer_fit.json,
which cbb_transfers.py reads.

What it does, every step walk-forward (a season is only ever projected from fits on earlier
seasons):
 1. Translation table: every D1 transfer 2019-2026 with a real prior line (10+ games, 10+ mpg)
    who played 5+ games at the new school: change in ppg, minutes, usage, ORtg, eFG, BPM, by
    direction and size of the level change and by origin tier -> destination tier x scoring role.
 2. Player fits: BPM, OBPM, DBPM, ORtg, usage, eFG, points per 40 for returning players,
    transfers and newcomers (cbb_transfers.feats); tested on 2025 and 2026 transfers vs last
    season's number unchanged.
 3. Team prior: each season's actual roster (players with a game that season; the minutes come
    from cbb_minutes with no recruit ratings, as live), projected OBPM/DBPM x minutes summed,
    calibrated to adj_em on earlier seasons; compared on final adj_em with last season's adj_em
    (regressed), Torvik's own preseason rating and a blend.
 4. Market: 2024-25 and 2025-26 games (games_{S}.json) with closing spreads: ATS when the
    preseason rating disagrees with the close by 3+ / 5+ points, by month.
Caveats it prints: rosters are the players who actually played (a small look-ahead: a player
hurt all season is missing); cbb_minutes.FIT was fitted on seasons through 2025, so 2025
minutes are in-sample for that model.
"""
import gzip, json, math, os, sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cbb_minutes as MIN  # noqa: E402
import cbb_transfers as CT  # noqa: E402

CACHE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else None
WRITE = "--write" in sys.argv
FIRST, LAST = 2010, 2026
PRE_DAY = {2019: "20181105", 2020: "20191104", 2021: "20201124", 2022: "20211108", 2023: "20221106",
           2024: "20231105", 2025: "20241103", 2026: "20251102"}
P = {y: CT.load_players(y) for y in range(FIRST - 2, LAST + 1)}
TT = {y: CT.team_table(y) for y in range(FIRST - 2, LAST + 2)}


def pre_ratings(Y):
    if Y == LAST + 1:
        return {k: (v["adj_em"], v["tempo"]) for k, v in TT[Y].items()}
    if not CACHE or Y not in PRE_DAY:
        return {}
    p = os.path.join(CACHE, f"tm_{PRE_DAY[Y]}.gz")
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return {}
    rows = json.loads(gzip.open(p).read())
    return {r[1]: (r[4] - r[6], r[44]) for r in rows}


# ── 1. pairs ───────────────────────────────────────────────────────────────────────────────────
def pairs(Y):
    out = []
    em_prev = TT[Y - 1]
    for pid, r in P[Y].items():
        prev, ps = P[Y - 1].get(pid), Y - 1
        if prev is None and Y - 2 in P:
            prev, ps = P[Y - 2].get(pid), Y - 2
        new = em_prev.get(r["t"]) or {}
        x = {"Y": Y, "pid": pid, "r": r, "prev": prev, "ps": ps, "team": r["t"], "em_new": new.get("adj_em"),
             "rk_new": new.get("rk")}
        if prev is None:
            x["g"] = "newcomer"
        else:
            old = TT[ps].get(prev["t"]) or {}
            x["em_old"], x["rk_old"], x["conf_old"] = old.get("adj_em"), old.get("rk"), old.get("conf")
            x["g"] = "returning" if prev["t"] == r["t"] else "transfer"
            x["lvl"] = (x["em_new"] - x["em_old"]) if (x["em_new"] is not None and x["em_old"] is not None) else 0.0
        out.append(x)
    return out


PAIRS = {Y: pairs(Y) for Y in range(FIRST, LAST + 1)}


def X_of(x, s):
    return CT.feats(s, x["g"], x.get("prev"), x.get("lvl", 0.0), x.get("em_old") or 0.0, x.get("em_new") or 0.0,
                    CT.ht_in(x["r"].get("ht")))


def usable(x, s):
    r = x["r"]
    if (r.get("gp") or 0) < 8 or (r.get("mpg") or 0) < 8 or CT.stat_of(r, s) is None:
        return False
    if x["g"] != "newcomer":
        p = x["prev"]
        return (p.get("gp") or 0) >= 5 and (p.get("mpg") or 0) >= 4 and CT.stat_of(p, s) is not None
    return True


def fit_players(years, ridge=3.0):
    W = {}
    for s in CT.STATS:
        W[s] = {}
        for g in ("returning", "transfer", "newcomer"):
            rows = [x for Y in years for x in PAIRS[Y] if x["g"] == g and usable(x, s)]
            if len(rows) < 50:
                continue
            X = np.array([X_of(x, s) for x in rows], float)
            y = np.array([CT.stat_of(x["r"], s) for x in rows], float)
            w = np.array([min((x["r"].get("gp") or 0) * (x["r"].get("mpg") or 0), 800) / 800 for x in rows])
            R = ridge * np.eye(X.shape[1]); R[0, 0] = 0
            A = X.T @ (X * w[:, None]) + R
            W[s][g] = [round(float(v), 5) for v in np.linalg.solve(A, X.T @ (y * w))]
    return {"w": W}


# ── 2. translation table (descriptive) ───────────────────────────────────────────────────────────
def table():
    rows = []
    for Y in range(2019, LAST + 1):
        for x in PAIRS[Y]:
            p, r = x.get("prev"), x["r"]
            if x["g"] != "transfer" or (p.get("gp") or 0) < 10 or (p.get("mpg") or 0) < 10 or (r.get("gp") or 0) < 5:
                continue
            rows.append(x)

    def agg(xs):
        if not xs:
            return None
        def m(f):
            v = [f(x) for x in xs]
            v = [a for a in v if a is not None]
            return round(sum(v) / len(v), 2) if v else None
        d = lambda k: (lambda x: (x["r"].get(k) - x["prev"].get(k)) if x["r"].get(k) is not None and x["prev"].get(k) is not None else None)
        return {"n": len(xs), "ppg0": m(lambda x: x["prev"].get("ppg")), "ppg1": m(lambda x: x["r"].get("ppg")),
                "mpg0": m(lambda x: x["prev"].get("mpg")), "mpg1": m(lambda x: x["r"].get("mpg")),
                "dmpg": m(d("mpg")), "dppg": m(d("ppg")), "dusg": m(d("usg")), "dortg": m(d("ortg")), "defg": m(d("efg")),
                "dbpm": m(d("bpm")),
                "dpts40": m(lambda x: (CT.stat_of(x["r"], "pts40") or 0) - (CT.stat_of(x["prev"], "pts40") or 0)),
                "lvl": m(lambda x: x["lvl"])}
    by = defaultdict(list)
    for x in rows:
        d = CT.direction(x["lvl"])
        by[("dir", d)].append(x)
        by[("size", (d, CT.size_band(x["lvl"])))].append(x)
        ft, tt = CT.tier(x.get("rk_old")), CT.tier(x.get("rk_new"))
        band = CT.ppg_band(x["prev"].get("ppg"))
        if ft and tt:
            by[("tier_band", f"{ft}>{tt}|{band}")].append(x)
            by[("tier", f"{ft}>{tt}")].append(x)
    out = {"n": len(rows), "dir": {}, "size": {}, "tier": {}, "tier_band": {}}
    for (k, key), xs in by.items():
        a = agg(xs)
        if k == "size":
            out["size"][f"{key[0]}|{key[1]}"] = a
        else:
            out[k][key] = a
    return out


# ── 3. team prior ────────────────────────────────────────────────────────────────────────────────
def team_sums(Y, pfit):
    """team -> (o_sum, d_sum) from season Y's roster with players projected by pfit"""
    roster = defaultdict(list)
    for x in PAIRS[Y]:
        roster[x["team"]].append(x)
    em_prev = MIN.team_em(Y - 1)
    out = {}
    for team, xs in roster.items():
        proven = sum((x["prev"] or {}).get("mpg") or 0 for x in xs if x["g"] != "newcomer")
        raw = {}
        for x in xs:
            prev = x["prev"] if x["g"] != "newcomer" else None
            crowd = (proven - ((prev or {}).get("mpg") or 0)) / 100.0
            gf = MIN.feats(prev, None, 0.0, CT.ht_in(x["r"].get("ht")), em_prev.get(team),
                           em_prev.get(prev["t"]) if prev else None, x["g"] == "transfer", crowd)
            raw[x["pid"]] = min(MIN.CAP, MIN.raw(gf))
        mins = MIN.scale_team(raw)
        o = d = 0.0
        for x in xs:
            pr = CT.project(pfit, x["g"], x.get("prev"), x.get("lvl", 0.0), x.get("em_old") or 0.0,
                            x.get("em_new") or 0.0, CT.ht_in(x["r"].get("ht")))
            o += (pr.get("obpm") or 0) * mins[x["pid"]] / 40.0
            d += (pr.get("dbpm") or 0) * mins[x["pid"]] / 40.0
        out[team] = (o, d)
    return out


def lstsq(X, y):
    return np.linalg.lstsq(np.array(X, float), np.array(y, float), rcond=None)[0]


def team_rows(Y, sums):
    em_mean = np.mean([v["adj_em"] for v in TT[Y - 1].values()])
    mo1, md1 = (np.mean([v[k] for v in TT[Y - 1].values()]) for k in ("adj_o", "adj_d"))
    mo, md = (np.mean([v[k] for v in TT[Y].values()]) for k in ("adj_o", "adj_d"))
    pre = pre_ratings(Y)
    out = []
    for team, (o, d) in sums.items():
        cur = TT[Y].get(team)
        if not cur:
            continue
        last = (TT[Y - 1].get(team) or {}).get("adj_em")
        lt = TT[Y - 1].get(team) or {}
        out.append({"team": team, "Y": Y, "o": o, "d": d, "last": last if last is not None else em_mean,
                    "last_o": (lt["adj_o"] - mo1) if lt else 0.0, "last_d": (md1 - lt["adj_d"]) if lt else 0.0,
                    "act_o": cur["adj_o"] - mo, "act_d": md - cur["adj_d"],
                    "pre": (pre.get(team) or (None,))[0], "act": cur["adj_em"]})
    return out


def metrics(pred, act):
    e = np.array(pred) - np.array(act)
    return {"mae": round(float(np.mean(np.abs(e))), 2), "rmse": round(float(np.sqrt(np.mean(e * e))), 2),
            "r": round(float(np.corrcoef(pred, act)[0, 1]), 3), "n": len(e)}


def ats(sel, name, side=None):
    """[wins, losses, pct] betting the side `name` favors against the close"""
    w = l = 0
    for r in sel:
        e = r["pr"][name] - r["close"]
        if r["act"] == r["close"]:
            continue
        if (e > 0) == (r["act"] > r["close"]):
            w += 1
        else:
            l += 1
    return [w, l, round(100 * w / (w + l), 1) if w + l else None]


def z_vs(w, l, p0):
    n = w + l
    return round((w / n - p0) / math.sqrt(p0 * (1 - p0) / n), 2) if n else None


ALLG = {}


def prior_season(Y, out_path):
    """The preseason team prior for season Y exactly as cbb_transfers.build makes it live (ours, the
    offense / defense split, the blend with Torvik's preseason rating), but with every weight fitted
    on seasons before Y only: what the live file would have said the day before Y began. Written as
    {"season": Y, "teams": {ESPN abbr: {ours, blend, torvik_pre, adj_o, adj_d}}} for
    tools/cbb_price_backtest.py (the cbb_model v3 test). Rosters are the players who actually played
    that season (the same small look-ahead the team backtest notes)."""
    PFY = {y: fit_players(range(FIRST, y)) for y in range(2012, Y + 1)}
    TR_ = {y: team_rows(y, team_sums(y, PFY[y])) for y in range(2012, Y + 1)}
    train = [r for y in range(2012, Y) for r in TR_[y]]
    a_ours = lstsq([[1, r["o"], r["d"], r["last"]] for r in train], [r["act"] for r in train])
    a_off = lstsq([[1, r["o"], r["last_o"]] for r in train], [r["act_o"] for r in train])
    a_def = lstsq([[1, r["d"], r["last_d"]] for r in train], [r["act_d"] for r in train])
    cache = {}

    def ow(r):          # each earlier season projected with the fit it would have had
        if r["Y"] not in cache:
            cache[r["Y"]] = lstsq([[1, q["o"], q["d"], q["last"]] for y in range(2012, r["Y"]) for q in TR_[y]],
                                  [q["act"] for y in range(2012, r["Y"]) for q in TR_[y]])
        at = cache[r["Y"]]
        return at[0] + at[1] * r["o"] + at[2] * r["d"] + at[3] * r["last"]
    btrain = [r for y in range(2019, Y) for r in TR_[y] if r["pre"] is not None]
    bl = lstsq([[1, ow(r), r["pre"]] for r in btrain], [r["act"] for r in btrain])
    mo1 = float(np.mean([v["adj_o"] for v in TT[Y - 1].values()]))
    md1 = float(np.mean([v["adj_d"] for v in TT[Y - 1].values()]))
    tmap = json.load(open(os.path.join(CT.HIST, "team_map.json")))
    ab_of = {v["torvik"]: v["abbr"] for v in tmap.values()}
    teams = {}
    for r in TR_[Y]:
        ab = ab_of.get(r["team"])
        if not ab:
            continue
        ours = a_ours[0] + a_ours[1] * r["o"] + a_ours[2] * r["d"] + a_ours[3] * r["last"]
        po = a_off[0] + a_off[1] * r["o"] + a_off[2] * r["last_o"]
        pdf = a_def[0] + a_def[1] * r["d"] + a_def[2] * r["last_d"]
        share = (ours - po - pdf) / 2.0
        blend = (bl[0] + bl[1] * ours + bl[2] * r["pre"]) if r["pre"] is not None else None
        teams[ab] = {"torvik": r["team"], "ours": round(float(ours), 2), "blend": None if blend is None else round(float(blend), 2),
                     "torvik_pre": None if r["pre"] is None else round(float(r["pre"]), 2),
                     "adj_o": round(mo1 + po + share, 2), "adj_d": round(md1 - (pdf + share), 2)}
    json.dump({"season": Y, "generated": "tools/cbb_transfers_backtest.py --prior", "blend_w": [round(float(v), 4) for v in bl],
               "teams": teams}, open(out_path, "w"), indent=1)
    print(f"wrote {out_path}: {len(teams)} teams, {sum(1 for t in teams.values() if t['blend'] is not None)} with a blend, "
          f"blend weights {[round(float(v), 3) for v in bl]}")


def main():
    print("== player fits, walk-forward ==")
    PF = {}
    for Y in range(2012, LAST + 2):
        PF[Y] = fit_players(range(FIRST, Y))           # used to project season Y (fitted on < Y)
    # player backtest on 2025 and 2026 transfers
    pb = {}
    for Y in (2025, 2026):
        xs = [x for x in PAIRS[Y] if x["g"] == "transfer"]
        res = {}
        for s in CT.STATS:
            us = [x for x in xs if usable(x, s)]
            pm = [CT.predict(PF[Y], s, "transfer", X_of(x, s)) for x in us]
            act = [CT.stat_of(x["r"], s) for x in us]
            nv = [CT.stat_of(x["prev"], s) for x in us]
            res[s] = {"model": round(float(np.mean(np.abs(np.array(pm) - act))), 2),
                      "naive": round(float(np.mean(np.abs(np.array(nv) - act))), 2), "n": len(us)}
        pb[str(Y)] = res
        print(Y, json.dumps(res))

    print("== translation table ==")
    TB = table()
    for k in ("dir", "size", "tier"):
        for key, a in sorted(TB[k].items()):
            print(k, key, a)

    print("== team prior ==")
    SUMS = {Y: team_sums(Y, PF[Y]) for Y in range(2012, LAST + 1)}
    TR = {Y: team_rows(Y, SUMS[Y]) for Y in SUMS}
    tb = {"seasons": {}}
    for T in range(2020, LAST + 1):
        train = [r for Y in range(2012, T) for r in TR[Y]]
        a_ours = lstsq([[1, r["o"], r["d"], r["last"]] for r in train], [r["act"] for r in train])
        a_play = lstsq([[1, r["o"], r["d"]] for r in train], [r["act"] for r in train])
        a_naive = lstsq([[1, r["last"]] for r in train], [r["act"] for r in train])
        test = TR[T]
        ours = lambda r, a=a_ours: a[0] + a[1] * r["o"] + a[2] * r["d"] + a[3] * r["last"]
        tp = [r for r in test if r["pre"] is not None]
        btrain = [r for Y in range(2019, T) for r in TR[Y] if r["pre"] is not None]
        # blend fitted on earlier seasons (each projected with the walk-forward fit for its season)
        bl = None
        if btrain:
            cache = {}
            def ow(r):
                if r["Y"] not in cache:
                    cache[r["Y"]] = lstsq([[1, q["o"], q["d"], q["last"]] for Y in range(2012, r["Y"]) for q in TR[Y]],
                                          [q["act"] for Y in range(2012, r["Y"]) for q in TR[Y]])
                at = cache[r["Y"]]
                return at[0] + at[1] * r["o"] + at[2] * r["d"] + at[3] * r["last"]
            bl = lstsq([[1, ow(r), r["pre"]] for r in btrain], [r["act"] for r in btrain])
        row = {"n": len(test),
               "naive": metrics([a_naive[0] + a_naive[1] * r["last"] for r in test], [r["act"] for r in test]),
               "players_only": metrics([a_play[0] + a_play[1] * r["o"] + a_play[2] * r["d"] for r in test], [r["act"] for r in test]),
               "ours": metrics([ours(r) for r in test], [r["act"] for r in test])}
        if tp:
            row["torvik_pre"] = metrics([r["pre"] for r in tp], [r["act"] for r in tp])
            row["ours_same_teams"] = metrics([ours(r) for r in tp], [r["act"] for r in tp])
            if bl is not None:
                row["blend"] = metrics([bl[0] + bl[1] * ours(r) + bl[2] * r["pre"] for r in tp], [r["act"] for r in tp])
                row["blend_w"] = [round(float(v), 3) for v in bl]
        row["ours_w"] = [round(float(v), 3) for v in a_ours]
        tb["seasons"][str(T)] = row
        for r in test:
            r["p_ours"] = ours(r)
            r["p_naive"] = a_naive[0] + a_naive[1] * r["last"]
            r["p_blend"] = (bl[0] + bl[1] * r["p_ours"] + bl[2] * r["pre"]) if (bl is not None and r["pre"] is not None) else None
        print(T, json.dumps({k: v for k, v in row.items()}))

    print("== market: preseason ratings vs closing spread ==")
    tmap = json.load(open(os.path.join(CT.HIST, "team_map.json")))
    mk = {}
    MONTHS = [("Nov", "11"), ("Dec", "12"), ("Jan", "01"), ("Feb-Apr", "02,03,04")]
    for S in (2025, 2026):
        g = json.load(open(os.path.join(CT.HIST, f"games_{S}.json")))
        R = {r["team"]: r for r in TR[S]}
        pre = pre_ratings(S)
        tempo = {k: v[1] for k, v in pre.items()}
        # home edge from the other season's results with final ratings (a scalar; no same-season look)
        O = 2026 if S == 2025 else 2025
        go = json.load(open(os.path.join(CT.HIST, f"games_{O}.json")))
        res = []
        for x in go:
            h, a = tmap.get(x["hid"]), tmap.get(x["aid"])
            if not h or not a or x.get("neu"):
                continue
            th, ta = TT[O].get(h["torvik"]), TT[O].get(a["torvik"])
            if th and ta:
                poss = (th["tempo"] + ta["tempo"]) / 2
                res.append((x["hs"] - x["as"]) - (th["adj_em"] - ta["adj_em"]) * poss / 100)
        hca = float(np.mean(res))
        out = {"hca": round(hca, 2)}
        srcs = {"ours": "p_ours", "torvik_pre": "pre", "blend": "p_blend", "naive": "p_naive"}
        G = []
        for x in g:
            if x.get("sp") is None:
                continue
            h, a = tmap.get(x["hid"]), tmap.get(x["aid"])
            rh, ra = (R.get(h["torvik"]) if h else None), (R.get(a["torvik"]) if a else None)
            if not rh or not ra:
                continue
            poss = ((tempo.get(h["torvik"]) or 68) + (tempo.get(a["torvik"]) or 68)) / 2
            pr = {n: (rh[k] - ra[k]) * poss / 100 + (0 if x.get("neu") else hca)
                  for n, k in srcs.items() if rh.get(k) is not None and ra.get(k) is not None}
            G.append({"m": x["d"][4:6], "close": -x["sp"], "act": x["hs"] - x["as"], "pr": pr})
        ALLG[S] = G
        for name in srcs:
            o = {}
            for mname, ms in MONTHS:
                sel = [r for r in G if r["m"] in ms.split(",") and name in r["pr"]]
                o[mname] = {"games": len(sel)}
                if sel:
                    o[mname]["mae_model"] = round(float(np.mean([abs(r["pr"][name] - r["act"]) for r in sel])), 2)
                    o[mname]["mae_close"] = round(float(np.mean([abs(r["close"] - r["act"]) for r in sel])), 2)
                for th in (0, 3, 5):
                    o[mname][f"ats{th}"] = ats([r for r in sel if abs(r["pr"][name] - r["close"]) >= max(th, 0.01)], name)
            out[name] = o
        mk[str(S)] = out
        print(S, json.dumps(out))
    # pooled Nov-Dec
    pooled = {}
    for name in ("ours", "torvik_pre", "blend", "naive"):
        pooled[name] = {}
        for th in (0, 3, 5):
            w = sum(mk[s][name][m][f"ats{th}"][0] for s in mk for m in ("Nov", "Dec"))
            l = sum(mk[s][name][m][f"ats{th}"][1] for s in mk for m in ("Nov", "Dec"))
            pooled[name][f"ats{th}"] = [w, l, round(100 * w / (w + l), 1) if w + l else None]
    for name in pooled:
        for k, v in pooled[name].items():
            v += [z_vs(v[0], v[1], 0.5), z_vs(v[0], v[1], 0.5238)]
    mk["nov_dec_pooled"] = pooled
    # does the transfer-aware projection know something Torvik's preseason (and the close) does not?
    # games where ours is 3+ (5+) off the close but Torvik's preseason is within 1.5 of it or on the other side
    inc = {}
    for th in (3, 5):
        for mname, ms in MONTHS:
            sel = []
            for S in ALLG:
                for r in ALLG[S]:
                    if r["m"] not in ms.split(",") or "ours" not in r["pr"] or "torvik_pre" not in r["pr"]:
                        continue
                    eo, et = r["pr"]["ours"] - r["close"], r["pr"]["torvik_pre"] - r["close"]
                    if abs(eo) >= th and (abs(et) < 1.5 or (et > 0) != (eo > 0)):
                        sel.append(r)
            v = ats(sel, "ours")
            inc[f"{mname}|{th}"] = v + [z_vs(v[0], v[1], 0.5238)]
    mk["ours_not_torvik"] = inc
    print("ours disagrees, Torvik does not", json.dumps(inc))
    print("pooled Nov-Dec", json.dumps(pooled))

    # live weights: players fitted on every season, team on every season, blend on 2019+
    live = fit_players(range(FIRST, LAST + 1))
    allr = [r for Y in range(2012, LAST + 1) for r in TR[Y]]
    a_ours = lstsq([[1, r["o"], r["d"], r["last"]] for r in allr], [r["act"] for r in allr])
    a_off = lstsq([[1, r["o"], r["last_o"]] for r in allr], [r["act_o"] for r in allr])
    a_def = lstsq([[1, r["d"], r["last_d"]] for r in allr], [r["act_d"] for r in allr])
    br = [r for Y in range(2020, LAST + 1) for r in TR[Y] if r.get("p_blend") is not None or (r["pre"] is not None and "p_ours" in r)]
    bl = lstsq([[1, r["p_ours"], r["pre"]] for r in br], [r["act"] for r in br])
    repl = [x["r"]["bpm"] for Y in range(2019, LAST + 1) for x in PAIRS[Y]
            if 5 <= (x["r"].get("mpg") or 0) < 12 and (x["r"].get("gp") or 0) >= 10 and x["r"].get("bpm") is not None]
    out = {"generated": "tools/cbb_transfers_backtest.py", "w": live["w"],
           "team": {"ours": [round(float(v), 4) for v in a_ours], "blend": [round(float(v), 4) for v in bl],
                    "off": [round(float(v), 4) for v in a_off], "def": [round(float(v), 4) for v in a_def],
                    "em_mean": round(float(np.mean([v["adj_em"] for v in TT[LAST].values()])), 2)},
           "repl_bpm": round(float(np.median(repl)), 2),
           "patterns": {"dir": TB["dir"], "tier_band": TB["tier_band"]},
           "table": TB, "player_backtest": pb,
           "team_backtest": {"seasons": tb["seasons"], "market": mk,
                             "caveats": ["Rosters are the players who actually played that season (a player hurt all year is missing).",
                                         "cbb_minutes was fitted on seasons through 2025, so 2025 minutes are in-sample for that piece.",
                                         "Torvik preseason ratings come from his time machine the day before each season's first games."]},
           "method": ("Every player on the roster is projected from last season wherever he played: BPM split into offense and "
                      "defense, translated for transfers by the size and direction of the level change, freshmen from height and "
                      "the team's level. Projected minutes come from the depth-chart model. Offense and defense are summed by "
                      "minutes and turned into an adjusted efficiency margin with weights fitted on earlier seasons, alongside "
                      "last season's margin. The blend adds Torvik's preseason rating with weights fitted the same way.")}
    print("live team weights", out["team"], "repl", out["repl_bpm"])
    if WRITE:
        json.dump(out, open(CT.FIT_PATH, "w"), separators=(",", ":"))
        print("wrote", CT.FIT_PATH)


if __name__ == "__main__":
    if "--prior" in sys.argv:      # --prior 2026 bt/cbb_prior_2026.json: one season's walk-forward prior only
        i = sys.argv.index("--prior")
        prior_season(int(sys.argv[i + 1]), sys.argv[i + 2])
    else:
        main()
