#!/usr/bin/env python3
"""
totals_audit.py - how far off are the game models' totals? (dev only)

11/6 (Jordan: "why are we so far off on totals especially, we need historicals stats and projections to make sure
we're accurate"). For every game in data/picks/lines/<sport>.json with a total and a final score, the model's
projected total walk-forward (ratings fitted only on games before that day, exactly as the live build fits
them), against Onyx's opening and closing totals and the actual final:

    MAE         mean absolute error of each against the final score
    bias        mean (projection - final): + means it projects too high
    worst       the biggest model misses, with the line

    python3 tools/totals_audit.py [nfl cfb nhl cbb]
"""
import json, os, sys
from collections import defaultdict
from datetime import date, timedelta
from statistics import mean

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import team_model as T      # noqa: E402

MOD = {"nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model", "cbb": "cbb_model"}


def pace_fit(res, pace, as_of, P):
    """Pace x efficiency (11/6): each team's offensive plays = league mean + its tempo + the opponent's
    plays allowed, and points per play = league mean + its efficiency - the opponent's, both fitted with
    team_model.fit's weighted ridge least squares on ESPN box stats (data/<sport>/pace.json). Expected
    points = plays x points per play, for each side."""
    G_pl, G_pp = [], []
    for g in res:
        b = pace.get(str(g["id"])) or {}
        h, a = b.get(g["home"]) or {}, b.get(g["away"]) or {}
        if not (h.get("plays") and a.get("plays")) or g.get("hs") is None:
            continue
        base = {"date": g["date"], "home": g["home"], "away": g["away"], "neutral": g.get("neutral")}
        G_pl.append(dict(base, hs=h["plays"], **{"as": a["plays"]}))
        G_pp.append(dict(base, hs=100 * g["hs"] / h["plays"], **{"as": 100 * g["as"] / a["plays"]}))
    Pp = dict(P, home=P.get("home_plays", 0.0), ridge=P.get("ridge_pace", 3))
    Pe = dict(P, home=P.get("home_ppp", 3.0), ridge=P.get("ridge_ppp", 3))
    Rl, Re = T.fit(G_pl, as_of, Pp), T.fit(G_pp, as_of, Pe)

    def expect(home, away, neutral=False):
        ph, pa = T.expect(Rl, home, away, neutral)
        eh, ea = T.expect(Re, home, away, neutral)
        return ph * eh / 100, pa * ea / 100
    return expect, Rl["n"]


def audit(key):
    M = __import__(MOD[key])
    GP = M.GAME_P if key == "nfl" else M.P
    res = json.load(open(f"data/{key}/results.json"))["games"]
    lines = json.load(open(f"data/picks/lines/{key}.json"))
    by = defaultdict(list)
    for g in res:
        if g.get("hs") is not None:
            by[g["date"]].append(g)
    teams = json.load(open(f"data/{key}/teams_espn.json")) if os.path.exists(f"data/{key}/teams_espn.json") else {}
    cache, rows, pcache = {}, [], {}
    PACE = json.load(open(f"data/{key}/pace.json")) if os.path.exists(f"data/{key}/pace.json") and key in ("cfb", "nfl") else None
    for fid, x in lines.items():
        tp = ((x.get("game") or {}).get("total_points") or (x.get("game") or {}).get("total_goals") or {}).get("over") or {}
        lo, lc = (tp.get("o") or [None])[0], (tp.get("c") or [None])[0]
        if (lo is None and lc is None) or x.get("hs") is None or not x.get("start"):
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
        if g["date"] not in cache:
            cache[g["date"]] = M.ratings(f"data/{key}", res, g["date"], teams) if hasattr(M, "ratings") else T.fit(res, g["date"], GP)
        R = cache[g["date"]]
        if R["n"].get(g["home"], 0) < GP.get("min_games", 3) or R["n"].get(g["away"], 0) < GP.get("min_games", 3):
            continue
        eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
        row = {"date": g["date"], "game": f"{g['away']} @ {g['home']}", "model": eh + ea, "open": lo, "close": lc,
               "final": g["hs"] + g["as"], "season": g.get("season")}
        if PACE:
            if g["date"] not in pcache:
                pcache[g["date"]] = pace_fit(res, PACE, g["date"], GP)
            ex, pn = pcache[g["date"]]
            if pn.get(g["home"], 0) >= 3 and pn.get(g["away"], 0) >= 3:
                ph, pa = ex(g["home"], g["away"], g.get("neutral"))
                row["pace"] = ph + pa
        rows.append(row)
    return rows


def report(key, rows):
    if not rows:
        print(f"{key}: no games matched")
        return
    def mae(f):
        v = [abs(f(r) - r["final"]) for r in rows if f(r) is not None]
        return mean(v) if v else None
    def bias(f):
        v = [f(r) - r["final"] for r in rows if f(r) is not None]
        return mean(v) if v else None
    gap = [abs(r["model"] - (r["close"] if r["close"] is not None else r["open"])) for r in rows]
    print(f"\n== {key}: {len(rows)} games ({rows[0]['date']} to {rows[-1]['date']})")
    sub = [r for r in rows if r.get("pace") is not None]
    for lab, f in (("model", lambda r: r["model"]), ("open line", lambda r: r["open"]), ("close line", lambda r: r["close"])):
        print(f"   {lab:11s} MAE {mae(f):6.2f}   bias {bias(f):+6.2f}")
    if sub:
        def m2(rs, f):
            v = [abs(f(r) - r["final"]) for r in rs if f(r) is not None]
            return mean(v)
        print(f"   pace model, on the {len(sub)} games it rates: ratings {m2(sub, lambda r: r['model']):.2f} | pace {m2(sub, lambda r: r['pace']):.2f} | "
              f"half and half {m2(sub, lambda r: (r['pace'] + r['model']) / 2):.2f} | close line {m2(sub, lambda r: r['close']):.2f}")
        for lab, f in (("ratings", lambda r: r["model"]), ("pace", lambda r: r["pace"])):
            big = [r for r in sub if r["close"] is not None and abs(f(r) - r["close"]) >= (7 if key != "nhl" else 1.5)]
            if big:
                mw = sum(1 for r in big if abs(f(r) - r["final"]) < abs(r["close"] - r["final"]))
                print(f"   {lab:8s} 7+ from the line: {len(big)} games, closer than the line in {mw} ({100 * mw / len(big):.0f}%)")
    print(f"   model vs closing line: average gap {mean(gap):.2f}; {sum(1 for x in gap if x >= 7)} games 7+ apart "
          f"({100 * sum(1 for x in gap if x >= 7) / len(gap):.0f}%)")
    # when the model and the line disagree by a lot, who was closer?
    big = [r for r in rows if r["close"] is not None and abs(r["model"] - r["close"]) >= (1.5 if key == "nhl" else 7)]
    if big:
        mw = sum(1 for r in big if abs(r["model"] - r["final"]) < abs(r["close"] - r["final"]))
        print(f"   big disagreements ({len(big)}): model closer {mw}, line closer {len(big) - mw}")
    w = sorted(rows, key=lambda r: -abs(r["model"] - r["final"]))[:5]
    for r in w:
        print(f"     {r['date']} {r['game']:14s} model {r['model']:5.1f} line {r['close'] if r['close'] is not None else r['open']} final {r['final']}")


if __name__ == "__main__":
    for k in (sys.argv[1:] or ["nfl", "cfb", "nhl", "cbb"]):
        try:
            report(k, audit(k))
        except Exception as e:
            print(f"{k}: {e}")
