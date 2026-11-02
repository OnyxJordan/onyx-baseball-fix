#!/usr/bin/env python3
"""Dev-only: walk-forward backtest of the Similar spots engine (situations.py).

  python3 tools/situations_backtest.py cbb|nfl|cfb|nba|nhl|all [--write] [--team]

--team re-runs only the team-recent rules (situations v2) and merges them into the
existing data/<sport>/situations_bt.json.

For each test season S, the trend tables are built ONLY from seasons before S. Every
game of S is then matched exactly as the page matches it (same templates, same backoff,
same "which spots show" order), and a side is bet when its matched spot's ATS rate is at
or above the threshold with at least n games behind it. Graded against the closing
spread of the game (the same closing line the history holds), pushes excluded, -110
assumed (break-even 52.38%). Totals the same way on the over / under rate.

Rules (fixed before running): threshold 55% or 58%, sample 50+ or 100+, scope "core
spot" (the first card line) or "any shown spot" (one bet per side; a game where both
sides qualify is skipped). Nothing here changes a pick: it writes
data/<sport>/situations_bt.json, which the page quotes in one line under the card.

"Held up" list: every spot (template + bucket) the 55% / 50+ "any shown" rule bet,
pooled over the test seasons it qualified in. A spot is listed only if it qualified in
3+ test seasons, went 55%+ on 100+ out-of-sample bets and won in at least two thirds of
those seasons. The number of spots tried is printed next to it (multiple comparisons:
1 in 20 clears p < .05 by luck alone).
"""
import json, math, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import os
os.chdir(ROOT)
import situations as S

RULES = [(.55, 50), (.55, 100), (.58, 50), (.58, 100)]
WINDOW = 2        # seasons of league history behind each test season (the page's league row, v2)
BE = 110 / 210


def acc():
    return [0, 0, 0.0, 0.0, 0.0]     # wins, losses, profit in units, expected wins, variance


def bet(a, won, e, pr):
    a[0 if won else 1] += 1
    a[2] += (100 / -pr if pr < 0 else pr / 100) if won else -1.0
    a[3] += e
    a[4] += e * (1 - e)


def grade(a):
    w, l, pf, ew, var = a
    n = w + l
    z = (w - ew) / math.sqrt(var) if var > 0 else 0.0
    return {"w": w, "l": l, "n": n, "pct": round(w / n, 4) if n else None, "exp": round(ew / n, 4) if n else None,
            "roi": round(pf / n, 4) if n else None, "z": round(z, 2), "p": round(math.erfc(abs(z) / math.sqrt(2)), 4) if n else None}


def run(sport):
    rows = S.load_history(sport)
    if not rows:
        print(f"{sport}: no history")
        return None
    if sport in ("cbb", "cfb"):
        S.CONF_PAIRS[sport] = {}
    W, feats = S.featurize(sport, rows)
    seasons = sorted({g["s"] for g, *_ in feats})
    tests = seasons[2:]
    nmin = S.CFG[sport]["nmin"]
    res = {f"{sc}|{t}|{n}": defaultdict(acc) for sc in ("spot", "any", "tspot", "tany") for t, n in RULES}
    cells = defaultdict(lambda: defaultdict(acc))     # (name, label) -> season -> acc
    tried = set()
    by_season = defaultdict(list)
    for g, fh, fa, fg in feats:
        by_season[g["s"]].append((g, fh, fa, fg))
    for s in tests:
        # the tables hold earlier seasons only; since v2 the page's league row uses the
        # last two seasons, so the test does too (WINDOW)
        T = S.build_table([x for x in feats if s - WINDOW <= x[0]["s"] < s])
        for g, fh, fa, fg in by_season[s]:
            eh = S.novig(g.get("hpr"), g.get("apr"))
            sides = {}
            for f, home in ((fh, True), (fa, False)):
                ats, cov = S.outcome(g, home)
                if ats is None or f.get("sb") is None:
                    continue
                sides[home] = (ats, S.side_spots(T, sport, f, nmin), eh if home else 1 - eh,
                               S.price(g.get("hpr") if home else g.get("apr")))
            for t, n in RULES:
                for sc in ("spot", "any"):
                    flag = {}
                    for home, (ats, spots, e, pr) in sides.items():
                        use = spots[:1] if sc == "spot" else spots
                        hit = [sp for sp in use if sp.get("pct") is not None and sp["w"] + sp["l"] >= n
                               and sp["pct"] - sp["exp"] >= t - .5]
                        if hit:
                            flag[home] = (ats, hit, e, pr)
                    if len(flag) == 1:
                        home, (ats, hit, e, pr) = next(iter(flag.items()))
                        bet(res[f"{sc}|{t}|{n}"][s], ats == 1, e, pr)
                        if sc == "any" and (t, n) == (.55, 50):
                            for sp in hit:
                                key = (sp["k"], sp["t"])
                                tried.add(key)
                                bet(cells[key][s], ats == 1, e, pr)
            ou = S.tot_outcome(g)
            if ou is not None and fg.get("tb") is not None:
                eo = S.novig(g.get("opr"), g.get("upr"))
                tsp = S.total_spots(T, sport, fg, nmin)
                for t, n in RULES:
                    for sc in ("tspot", "tany"):
                        use = tsp[:1] if sc == "tspot" else tsp
                        side = set()
                        for sp in use:
                            if sp["o"] + sp["u"] < n or sp["pct"] is None:
                                continue
                            if sp["pct"] - sp["exp"] >= t - .5:
                                side.add(1)
                            elif sp["exp"] - sp["pct"] >= t - .5:
                                side.add(0)
                        if len(side) == 1:
                            pick = side.pop()
                            bet(res[f"{sc}|{t}|{n}"][s], ou == pick, eo if pick else 1 - eo,
                                S.price(g.get("opr") if pick else g.get("upr")))
    out_rules = []
    for key, per in res.items():
        sc, t, n = key.split("|")
        tot = acc()
        for v in per.values():
            for i in range(5):
                tot[i] += v[i]
        out_rules.append({"scope": sc, "thr": float(t), "nmin": int(n), **grade(tot),
                          "seasons": {str(k): grade(v) for k, v in sorted(per.items())}})
    held = []
    for key, per in cells.items():
        qs = [s for s, v in per.items() if v[0] + v[1] > 0]
        tot = acc()
        for v in per.values():
            for i in range(5):
                tot[i] += v[i]
        gt = grade(tot)
        won = sum(1 for s in qs if per[s][2] > 0)
        if len(qs) >= 3 and gt["n"] >= 100 and gt["roi"] > 0 and gt["p"] < .05 and won * 3 >= 2 * len(qs):
            held.append({"k": key[0], "t": key[1], **gt, "seasons_bet": len(qs), "seasons_won": won,
                         "by": {str(s): grade(per[s]) for s in sorted(qs)}})
    held.sort(key=lambda h: h["p"])
    for h in held:   # survives a Bonferroni correction for every spot the rule bet
        h["mc"] = h["p"] < .05 / max(1, len(tried))
    return {"sport": sport, "v": S.VERSION, "seasons": [S.yrs(sport, s, s) for s in seasons],
            "tests": [S.yrs(sport, s, s) for s in tests], "games": len(rows),
            "lined": sum(1 for r in rows if r.get("sp") is not None),
            "priced": sum(1 for r in rows if r.get("hpr") is not None),
            "rules": out_rules, "held": held, "spots_tried": len(tried)}


# ---------------------------------------------------------------- team-recent rows (v2)
# The card's team rows (situations.team_side / team_total) are built from each team's own
# games before the tip, so a game-by-game walk is already out of sample. Rules fixed up
# front: back a side that is hot, or one that is cold, by its own recent closing-line
# record, and grade the NEXT game at its closing price. A game where both sides trigger
# the same rule is skipped.
TEAM_RULES = [
    ("hot10", "8-2 or better ATS in the last 10"), ("hot20", "15-5 or better ATS in the last 20"),
    ("role", "70%+ ATS in today's role (home / road / neutral, favorite / dog), 10+ games"),
    ("cold10", "2-8 or worse ATS in the last 10"), ("cold20", "5-15 or worse ATS in the last 20"),
    ("over10", "8-2 or better to the over in the last 10 (bet the over)"),
    ("under10", "8-2 or better to the under in the last 10 (bet the under)"),
]


def team_flags(sport, logs, g, f):
    rs = S.recent(logs.get(f["t"]) or [], g["s"])
    lined = [r for r in rs if r["cov"] is not None]
    out = set()
    for n, hi, key in ((10, 8, "10"), (20, 15, "20")):
        x = lined[:n]
        if len(x) == n:
            w, l, _ = S.ats_rec(x)
            if w >= hi:
                out.add("hot" + key)
            if l >= hi:
                out.add("cold" + key)
    if f.get("fd") and f.get("ven"):
        role = [r for r in lined if r["ven"] == f["ven"] and r["fd"] == f["fd"]][:S.TEAM_N]
        w, l, _ = S.ats_rec(role)
        if w + l >= 10 and w / (w + l) >= .7:
            out.add("role")
    t10 = [r for r in rs if r["ou"] is not None][:10]
    if len(t10) == 10:
        o, u, _ = S.ou_rec(t10)
        if o >= 8:
            out.add("over10")
        if u >= 8:
            out.add("under10")
    return out


def run_team(sport):
    rows = S.load_history(sport)
    if not rows:
        return None
    if sport in ("cbb", "cfb"):
        S.CONF_PAIRS[sport] = {}
    W, feats = S.featurize(sport, rows)
    logs = {}
    res = {k: defaultdict(acc) for k, _ in TEAM_RULES}
    for g, fh, fa, fg in feats:
        fl = {True: team_flags(sport, logs, g, fh), False: team_flags(sport, logs, g, fa)}
        eh = S.novig(g.get("hpr"), g.get("apr"))
        for k, _ in TEAM_RULES:
            if k.startswith(("over", "under")):
                continue
            if (k in fl[True]) == (k in fl[False]):
                continue
            home = k in fl[True]
            ats, cov = S.outcome(g, home)
            if ats is None:
                continue
            bet(res[k][g["s"]], ats == 1, eh if home else 1 - eh, S.price(g.get("hpr") if home else g.get("apr")))
        ou = S.tot_outcome(g)
        if ou is not None:
            eo = S.novig(g.get("opr"), g.get("upr"))
            for k, pick in (("over10", 1), ("under10", 0)):
                other = "under10" if pick else "over10"
                if (k in fl[True] or k in fl[False]) and not (other in fl[True] or other in fl[False]):
                    bet(res[k][g["s"]], ou == pick, eo if pick else 1 - eo, S.price(g.get("opr") if pick else g.get("upr")))
        S.log_game(logs, g, fh, fa)
    seasons = sorted({g["s"] for g, *_ in feats})
    out = {}
    for k, txt in TEAM_RULES:
        tot = acc()
        for v in res[k].values():
            for i in range(5):
                tot[i] += v[i]
        rec2 = acc()
        for s in seasons[-2:]:
            for i in range(5):
                rec2[i] += res[k][s][i] if s in res[k] else 0
        out[k] = {"txt": txt, **grade(tot), "last2": grade(rec2),
                  "seasons": {str(s): grade(v) for s, v in sorted(res[k].items())}}
    return {"rules": out, "span": S.yrs(sport, seasons[0], seasons[-1]) if seasons else "",
            "last2": S.yrs(sport, seasons[-2], seasons[-1]) if len(seasons) > 1 else ""}


def team_line(sport, tb):
    """The one honest line under the card about the team rows."""
    R = tb["rules"]
    f = lambda x: f"{x['w']:,}-{x['l']:,} ({x['roi'] * 100:+.1f}%)"
    bits = []
    for k, lab in (("hot10", "8-2+ ATS in their last 10 went"), ("hot20", "15-5+ in their last 20"),
                   ("role", "70%+ in today's role"), ("cold10", "2-8 or worse")):
        x = R.get(k)
        if x and x["n"]:
            bits.append(f"{lab} {f(x)}")
    if not bits:
        return None
    ats = [R[k] for k in ("hot10", "hot20", "role", "cold10", "cold20") if R.get(k) and R[k]["n"]]
    beat = [x for x in ats if x["roi"] > 0 and x["p"] < .05]
    verdict = ("Team ATS streaks are noise against the closing line" if not beat else
               "One rule cleared p < .05 out of several tried, about what luck alone does; still context, not a pick")
    return (f"Team rows tested on every game {tb['span']}, each judged only on games before it: teams "
            + "; ".join(bits) + f" the next game at closing prices. {verdict}.")


def summary_line(sport, bt):
    get = lambda sc, t, n: next((x for x in bt["rules"] if x["scope"] == sc and x["thr"] == t and x["nmin"] == n), None)
    r, r2, c, tt = get("any", .55, 50), get("any", .58, 100), get("spot", .55, 50), get("tany", .55, 50)
    if not r or not r["n"]:
        return None
    f = lambda x: f"{x['w']:,}-{x['l']:,} ({x['pct'] * 100:.1f}%, {x['roi'] * 100:+.1f}% return)"
    t = bt["tests"]
    span = t[0] if len(t) == 1 else f"{t[0]} to {t[-1]}"
    line = (f"Tested out of sample ({span}, each season judged only on trends from the seasons before it): every side "
            f"with a spot covering 5+ points above what its closing price implied (55%+ at -110) on 50+ games went {f(r)} "
            f"against the closing line")
    if r2 and r2["n"]:
        line += f"; 8+ points (58%+) on 100+ games, {f(r2)}"
    if c and c["n"]:
        line += f"; the first line alone, {f(c)}"
    if tt and tt["n"]:
        line += f". Totals the same way: {f(tt)}"
    rs = [x for x in (r, r2, c, tt) if x and x["n"]]
    if all(x["roi"] > 0 and x["p"] < .05 for x in rs):
        verdict = "they held up on these samples, but past spots are still context, not a pick."
    elif any(x["roi"] > 0 for x in rs):
        verdict = "mixed, near break-even and mostly inside normal luck. Context, not a pick."
    else:
        verdict = "these trends have not beaten the closing line on games they never saw. Context, not a pick."
    return line + ". Graded at each game's closing price: " + verdict


def short_line(sport, bt):
    """The one line under the card."""
    r = next((x for x in bt["rules"] if x["scope"] == "spot" and x["thr"] == .55 and x["nmin"] == 50), None)
    if not r or not r["n"]:
        return None
    t = bt["tests"]
    span = t[0] if len(t) == 1 else f"{t[0]} to {t[-1]}"
    v = ("held up so far" if r["roi"] > 0 and r["p"] < .05 else
         "about break-even, inside normal luck" if r["roi"] > -.03 else "lost against the closing line")
    return (f"League row out of sample ({span}, each season judged on the two seasons before it): sides whose spot ran "
            f"55%+ (5+ points over the price) on 50+ games went {r['w']:,}-{r['l']:,} ({r['pct'] * 100:.1f}%, "
            f"{r['roi'] * 100:+.1f}% return), {v}.")


def main():
    a = sys.argv[1:]
    sports = ["cbb", "nfl", "cfb", "nba", "nhl"] if not a or a[0] == "all" else [a[0]]
    for sp in sports:
        if "--team" in a:       # team rows only, merged into the existing file
            try:
                bt = json.loads((ROOT / "data" / sp / "situations_bt.json").read_text(encoding="utf-8"))
            except Exception:
                bt = None
            if not bt:
                print(f"{sp}: run the full backtest first")
                continue
        else:
            bt = run(sp)
        if not bt:
            continue
        tb = run_team(sp)
        if tb:
            bt["team"], bt["team_line"] = tb, team_line(sp, tb)
            bt["v"] = S.VERSION
            print(f"\n=== {sp} team rows ({tb['span']}; last two seasons {tb['last2']})")
            for k, x in tb["rules"].items():
                l2 = x["last2"]
                print(f"  {k:8} {x['w']:>5}-{x['l']:<5} {(x['pct'] or 0) * 100:5.1f}% (exp {(x['exp'] or 0) * 100:4.1f}) "
                      f"roi {(x['roi'] or 0) * 100:+5.1f}% p={x['p']}   last2 {l2['w']}-{l2['l']} roi {(l2['roi'] or 0) * 100:+.1f}%")
            print("  " + (bt["team_line"] or ""))
        if "--team" in a:
            if "--write" in a:
                (ROOT / "data" / sp / "situations_bt.json").write_text(json.dumps(bt, separators=(",", ":")), encoding="utf-8")
            continue
        bt["line"] = summary_line(sp, bt)
        bt["short"] = short_line(sp, bt)
        h = bt["held"]
        strong = [x for x in h if x["mc"]]
        bt["held_line"] = (
            (f"Of {bt['spots_tried']} spots the rule bet, {len(h)} made money at closing prices in 3+ later seasons with p < .05"
             + (f", and {len(strong)} still clears that bar after correcting for how many spots were tried: "
                + "; ".join(f"{x['t']} {x['w']}-{x['l']} ({x['roi'] * 100:+.1f}%)" for x in strong) + "." if strong else
                ", none of them after correcting for how many spots were tried."))
            if h else f"None of the {bt['spots_tried']} spots the rule bet made money in 3+ later seasons with p < .05.")
        print(f"\n=== {sp}: {bt['games']} games, {bt['lined']} lined, seasons {bt['seasons'][0]}..{bt['seasons'][-1]}, "
              f"tests {', '.join(bt['tests'])}")
        for r in sorted(bt["rules"], key=lambda r: (r["scope"], r["thr"], r["nmin"])):
            print(f"  {r['scope']:5} {r['thr']:.0%} n>={r['nmin']:<3} {r['w']:>5}-{r['l']:<5} "
                  f"{(r['pct'] or 0) * 100:5.1f}% (exp {(r['exp'] or 0) * 100:4.1f})  roi {(r['roi'] or 0) * 100:+5.1f}%  p={r['p']}  "
                  + " ".join(f"{k}:{v['w']}-{v['l']}({v['roi'] * 100:+.0f}%)" for k, v in r["seasons"].items()))
        print("  " + bt["held_line"])
        for x in h:
            print(f"    {x['t']} [{x['k']}]: {x['w']}-{x['l']} ({x['pct'] * 100:.1f}%, exp {x['exp'] * 100:.1f}), roi {x['roi'] * 100:+.1f}%, "
                  f"profit in {x['seasons_won']}/{x['seasons_bet']} seasons, p={x['p']}{' (survives correction)' if x['mc'] else ''} "
                  + " ".join(f"{k}:{v['w']}-{v['l']}" for k, v in x["by"].items()))
        print("  " + (bt["line"] or ""))
        if "--write" in a:
            (ROOT / "data" / sp / "situations_bt.json").write_text(json.dumps(bt, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
