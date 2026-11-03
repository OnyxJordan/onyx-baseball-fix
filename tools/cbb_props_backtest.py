#!/usr/bin/env python3
"""
cbb_props_backtest.py - college basketball player props against Onyx's real 2025-26 prices. Dev only.

The question (11/3): do the college stat projections (cbb_stats.py: per-40 rates x projected
minutes, transfer step up / down, class, roster usage) beat Onyx's player prop prices?

Walk-forward, every number from information before the game:
  preseason   2025-26 projection from 2024-25 only: minutes (cbb_minutes weights fitted on
              2023-2025) x per-40 rates (cbb_stats weights fitted on 2022-2025), from
              tools/cbb_stats_backtest.rows(2026); the same features the live depth chart uses
  in season   minutes  = (minutes played + KMIN x projected mpg) / (games + KMIN)
              rate     = (production x 40 + KRATE x projected rate) / (minutes + KRATE)
              mean     = minutes x rate / 40 (points + rebounds + assists summed for PRA)
              (KMIN / KRATE chosen on Nov-Dec 2025 by mean absolute error)
  chance      negative binomial, sd = a x mean + b per stat (SD: fitted on every Nov-Dec 2025
              player-game of the players Onyx priced, the NBA model's form)
  price       Onyx's 2025-26 college props are OVER ONLY (all of Jan-Mar 2026; 143 of 1,155
              Nov-Dec lines had an under). A one-sided price has no clean fair chance, so the fair
              over is the price's implied chance x ONE_SIDED (Nov-Dec: overs cashed 87.8% as often
              as their price implied; the TD_SCALE idea in sports_build); a two-sided line uses the
              no-vig pair. Blend: W[stat] x model + (1 - W[stat]) x fair, W chosen per stat on
              Nov-Dec 2025 by log loss at the opening line.
  card        tools/picks_backtest.py's rule and card (daily_top.ok, one per player a game, best
              expected return first, picks.CAP a day), at Onyx's open and close; tuned Nov-Dec 2025,
              held out Jan 1 to Apr 9 2026.

Inputs (bt/ is local and git-ignored):
  bt/cbb_props.json            Onyx open / close lines (odds_probe.yml job=lines, tools/onyx_lines_pull.py
                               basketball ncaab ... player_points,player_rebounds,player_assists,
                               player_made_threes,player_points_+_rebounds_+_assists); also merged into
                               data/picks/lines/cbb.json, which the weekly re-test extends
  bt/cbb_box_2026.json         ESPN box scores of every 2025-26 game (built here with --box when missing)
  bt/cbb_props_prior_2026.json the preseason projection (built here with --prior <torvik csv cache>)

    python3 tools/cbb_props_backtest.py [--box] [--prior <torvik cache>]   # report

tools/picks_replays.cbb_props() turns samples() into the Onyx Picks rows and keeps the card in
data/picks/lines/cbb_props_frozen.json so a runner without bt/ can re-test while RULE_SIG matches.
"""
import json, math, os, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))

VERSION = "cbb-props-v1"          # never cbb_model.VERSION: picks.py re-gates on its own module's version
MK = {"player_points": "pts", "player_rebounds": "reb", "player_assists": "ast", "player_made_threes": "3pm",
      "player_threes": "3pm", "player_points_+_rebounds_+_assists": "pra"}
STATS = ("pts", "reb", "ast", "3pm", "pra")
KMIN = 1.0                                                   # games of real minutes worth the preseason minutes
KRATE = {"pts": 50, "reb": 100, "ast": 50, "3pm": 150, "pra": 50}    # minutes of real production worth the preseason rate
SD = {"pts": (0.149, 4.432), "reb": (0.282, 1.220), "ast": (0.350, 0.902), "3pm": (0.480, 0.661), "pra": (0.15, 5.0)}
ONE_SIDED = 0.878
W = {"pts": 0.0, "reb": 0.5, "ast": 1.0, "3pm": 0.0, "pra": 0.7}    # Nov-Dec 2025 log loss at the open
SPLIT, TUNE_FROM, TEST_TO = "2026-01-01", "2025-11-01", "2026-04-09"
LINES_BT = "bt/cbb_props.json"
BOX = os.path.join(ROOT, "bt", "cbb_box_2026.json")
PRIOR = os.path.join(ROOT, "bt", "cbb_props_prior_2026.json")
RULE_SIG = f"{VERSION} k{KMIN}/{sorted(KRATE.items())} sd{sorted(SD.items())} one{ONE_SIDED} w{sorted(W.items())}"


def have_inputs():
    return os.path.exists(BOX) and os.path.exists(PRIOR) and os.path.exists(os.path.join(ROOT, LINES_BT))


# ── inputs ──────────────────────────────────────────────────────────────────────────────────
def build_box():
    """bt/cbb_box_2026.json: {event id: [date, [[team, espn pid, name, dnp, min, pts, reb, ast, 3pm], ...]]}"""
    from concurrent.futures import ThreadPoolExecutor
    from sports_common import espn_get
    from sports_espn import bb_box_rows, BB_COLS
    games = [g for g in json.load(open(os.path.join(ROOT, "data", "cbb", "history", "games_2026.json")))
             if TUNE_FROM.replace("-", "") <= g["d"] <= TEST_TO.replace("-", "")]
    out = json.load(open(BOX)) if os.path.exists(BOX) else {}
    ix = [BB_COLS.index(c) for c in ("team", "pid", "name", "dnp", "min", "pts", "reb", "ast", "tpm")]

    def one(g):
        if g["id"] in out:
            return
        s = espn_get("basketball/mens-college-basketball/summary", f"event={g['id']}")
        if s:
            rows = [[r[i] for i in ix] for r in bb_box_rows(s, g["id"], 2026, g["d"])]
            for r in rows:
                r[3] = int(bool(r[3]))
            out[g["id"]] = [f"{g['d'][:4]}-{g['d'][4:6]}-{g['d'][6:]}", rows]
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(one, games))
    os.makedirs(os.path.dirname(BOX), exist_ok=True)
    json.dump(out, open(BOX, "w"), separators=(",", ":"))
    print(f"box: {len(out)} games")


def build_prior(cache):
    """The 2025-26 preseason projection from 2024-25 only (weights fitted before 2026)."""
    argv = sys.argv
    sys.argv = ["x", cache]                  # cbb_stats_backtest / cbb_minutes_backtest read the cache from argv[1]
    import cbb_stats_backtest as B
    import cbb_minutes as M
    import cbb_stats as S
    sys.argv = argv
    W_, Wmin = B.fit([2022, 2023, 2024, 2025]), B.MB.fit([2023, 2024, 2025])
    cur = {r["pid"]: r for r in M.load_players(2026)}
    out = {}
    for x in B.rows(2026):
        out[x["pid"]] = {"n": cur[x["pid"]]["n"], "t": x["t"], "g": x["g"], "mpg": round(min(M.CAP, M.raw(x["mgf"], Wmin)), 2),
                         "nv_mpg": x["naive_mpg"], "rate": {s: round(S.rate(s, x["g"], x["F"][s], W_), 3) for s in S.STATS},
                         "nv_rate": {s: round(x["F"][s][1], 3) if x["g"] != "newcomer" else None for s in S.STATS}}
    json.dump({"players": out}, open(PRIOR, "w"))
    print(f"prior: {len(out)} players")


# ── the walk ────────────────────────────────────────────────────────────────────────────────
def _nk(n):
    import cbb_minutes as M
    return M._nk(n)


def records(lines=None):
    """One row per Onyx player prop matched to an ESPN box line: date, game, player, stat, open / close
    [line, over, under], what he did, and his games before this one."""
    import picks_lines as PL
    import cbb_price_backtest as CPB
    prior = json.load(open(PRIOR))["players"]
    tm = json.load(open(os.path.join(ROOT, "data", "cbb", "history", "team_map.json")))
    tv_of = {v["abbr"]: v["torvik"] for v in tm.values()}
    pidx, pname = {}, defaultdict(list)
    for pid, p in prior.items():
        pidx[(_nk(p["n"]), p["t"])] = pid
        pname[_nk(p["n"])].append(pid)
    box = json.load(open(BOX))
    logs, e2t = defaultdict(list), {}
    for gid, (d, rows) in box.items():
        for team, ep, name, dnp, mn, pts, reb, ast, tpm in rows:
            if ep not in e2t:
                k = (_nk(name), tv_of.get(team))
                e2t[ep] = pidx.get(k) or (pname[k[0]][0] if len(pname.get(k[0], [])) == 1 else None)
            if not dnp and (mn or 0) > 0:
                logs[ep].append((d, gid, mn or 0, pts or 0, reb or 0, ast or 0, tpm or 0))
    for v in logs.values():
        v.sort()
    lines = lines if lines is not None else PL.lines("cbb", LINES_BT)
    lines = {k: v for k, v in lines.items() if v.get("props") and TUNE_FROM <= (v.get("start") or "")[:10] <= "2026-04-10"}
    _, team_of = CPB.namer()
    games = (json.load(open(os.path.join(ROOT, "data", "cbb", "results.json"))) or {}).get("games") or []
    matched, _ = CPB.match(lines, games, team_of)
    out, miss = [], defaultdict(int)
    for fid, x, g, nm in matched:
        if g["id"] not in box:
            miss["no box"] += 1
            continue
        d, rows = box[g["id"]]
        by = defaultdict(list)
        for r in rows:
            by[_nk(r[2])].append(r)
        for who, ms in (x.get("props") or {}).items():
            k = _nk(who)
            cand = by.get(k) or [r for r in rows if k and _nk(r[2]).split()[-1:] == k.split()[-1:] and _nk(r[2])[:1] == k[:1]]
            if len(cand) != 1:
                miss["name"] += 1
                continue
            team, ep, name, dnp, mn, pts, reb, ast, tpm = cand[0]
            if dnp or not (mn or 0) > 0:
                miss["did not play (void)"] += 1
                continue
            act = {"pts": pts or 0, "reb": reb or 0, "ast": ast or 0, "3pm": tpm or 0}
            act["pra"] = act["pts"] + act["reb"] + act["ast"]
            hist = [q for q in logs[ep] if q[0] < d and q[1] != g["id"]]      # the box score's own date: no same-game leak
            for m, v in ms.items():
                s = MK.get(m)
                if s:
                    out.append({"d": g["date"], "gid": g["id"], "ep": ep, "tp": e2t.get(ep), "name": name, "s": s,
                                "o": v.get("o"), "c": v.get("c"), "act": act[s], "hist": hist})
    return out, prior, dict(miss), len(matched)


def project(r, prior, s, naive=False):
    """Mean of stat s for this game: preseason projection blended with his games so far.
    naive: last season's per-minute rate and minutes in place of the transfer-aware projection."""
    p = prior.get(r["tp"]) if r["tp"] else None
    H = r["hist"]
    n, mins = len(H), sum(q[2] for q in H)
    if p and naive and p["g"] == "newcomer":
        return None
    if p:
        pm = p["nv_mpg"] if naive else p["mpg"]
        if pm is None:
            return None
        mp = (mins + KMIN * pm) / (n + KMIN)
    elif n >= 3:
        mp = mins / n
    else:
        return None
    j = {"pts": 3, "reb": 4, "ast": 5, "3pm": 6}
    mu = 0.0
    for st in (("pts", "reb", "ast") if s == "pra" else (s,)):
        real = sum(q[j[st]] for q in H)
        kr = KRATE[s]
        if p:
            pr = (p["nv_rate"] if naive else p["rate"])[st]
            if pr is None:
                return None
            rate = (real * 40 + kr * pr) / (mins + kr) if mins + kr > 0 else pr
        else:
            rate = real * 40 / mins
        mu += mp * rate / 40
    return mu


def nb_cdf(k, mean, var):
    import nba_model as N
    return N._nb_cdf(k, mean, var)


def p_over(mu, line, s):
    a, b = SD[s]
    sd = max(0.3, a * mu + b)
    return 1 - nb_cdf(math.floor(line), max(mu, 0.05), sd * sd)


def fair_over(v):
    import sports_lab as L
    if v[2] is not None:
        return L.fair_pair(v[1], v[2])[0]
    return L.implied(v[1]) * ONE_SIDED


def samples(naive=False, w=None):
    """Priced sides: {date, key, s, side, prob, price, won, when} for every prop at the open and the close
    (the over always; the under only where Onyx listed one). w: {stat: weight} in place of W."""
    recs, prior, _, _ = records()
    out = []
    for r in recs:
        mu = project(r, prior, r["s"], naive)
        if mu is None:
            continue
        for when in ("o", "c"):
            v = r.get(when)
            if not v or v[0] is None or v[1] is None or r["act"] == v[0]:
                continue
            ww = (w or W)[r["s"]]
            po = ww * p_over(mu, v[0], r["s"]) + (1 - ww) * fair_over(v)
            for side, p, price in (("over", po, v[1]), ("under", 1 - po, v[2])):
                if price is not None:
                    out.append({"date": r["d"], "key": (r["gid"], r["ep"]), "s": r["s"], "side": side, "prob": round(p, 4),
                                "price": int(price), "won": (r["act"] > v[0]) == (side == "over"), "when": when})
    return out


# ── report ──────────────────────────────────────────────────────────────────────────────────
def main():
    if "--box" in sys.argv or not os.path.exists(BOX):
        build_box()
    if "--prior" in sys.argv:
        build_prior(sys.argv[sys.argv.index("--prior") + 1])
    if not have_inputs():
        raise SystemExit(f"needs {LINES_BT}, {BOX} and {PRIOR}")
    os.chdir(ROOT)
    import picks_backtest as PB
    import sports_lab as L
    recs, prior, miss, nm = records()
    print(f"{nm} Onyx games matched to ESPN; {len(recs)} player props with a box line ({miss})")
    by = defaultdict(int)
    for r in recs:
        by[r["s"]] += 1
    print("props per stat:", dict(by))
    for s in STATS:
        for per, f in (("Nov-Dec", lambda r: r["d"] < SPLIT), ("Jan-Apr", lambda r: r["d"] >= SPLIT)):
            X = [(L.implied(r["o"][1]), r["act"] > r["o"][0]) for r in recs if r["s"] == s and f(r) and r["act"] != r["o"][0]]
            if X:
                print(f"  {s:4s} {per}: {len(X)} overs at the open, implied {sum(a for a, _ in X) / len(X):.3f}, cashed {sum(b for _, b in X) / len(X):.3f}")
    fmt = lambda t: f"{t['w']}-{t['l']} ({t['n']}) {t['roi'] * 100:+.1f}%" if t["n"] else "no bets"
    for lab, naive, w in (("live blend W", False, None), ("model alone", False, {s: 1.0 for s in STATS}),
                          ("naive baseline, model alone", True, {s: 1.0 for s in STATS})):
        S = samples(naive, w)
        print(f"\n{lab}")
        for s in STATS:
            C = {k: PB.card([PB.cand(x["date"], x["key"], x["side"], x["prob"], x["price"], x["won"]) for x in S
                             if x["s"] == s and x["when"] == k]) for k in ("o", "c")}
            T = lambda bets, test: PB.tally([b for b in bets if (b["date"] >= SPLIT) == test])
            print(f"  {s:4s} tune open {fmt(T(C['o'], False)):20s} close {fmt(T(C['c'], False)):20s} | held out open "
                  f"{fmt(T(C['o'], True)):20s} close {fmt(T(C['c'], True))}")
    for s in ("pts", "reb", "ast", "3pm"):
        X = [r for r in recs if r["s"] == s and r["d"] >= SPLIT]
        X = [(project(r, prior, s), project(r, prior, s, True), r["act"]) for r in X]
        X = [x for x in X if None not in x]
        if X:
            print(f"  MAE held out {s}: transfer-aware {sum(abs(a - c) for a, _, c in X) / len(X):.3f}, "
                  f"naive {sum(abs(b - c) for _, b, c in X) / len(X):.3f} ({len(X)} props)")


if __name__ == "__main__":
    main()
