#!/usr/bin/env python3
"""
nfl_qb_backtest.py - what is a backup quarterback worth? (dev only)

11/5 (Jordan, TNF): the game model projected JAX @ BAL at 46.8 while the line was 39.5, with
Baltimore on its third-string quarterback. The team ratings are fitted on final scores and do
not know who is under centre, so a team rated on its starter's games keeps that rating when he
sits.

For every NFL team-game in data/nfl/player_games.json (2025 and 2026), the starter is the
quarterback with the most pass attempts. The team's usual starter is the quarterback with the
most starts in its previous 10 games (at least 3). A backup start is a game the usual starter did
not start. The team's expected points come from team_model ratings fitted only on games played
before that date (nfl_model.GAME_P), so every residual is out of sample.

Reports, for backup starts vs normal starts: the team's points residual (actual - expected),
the opponent's, and each receiver's catches and receiving yards against his own average with the
usual starter. Then a held-out test: fit the adjustments on 2025, apply them to 2026 (and the
reverse) and compare team-total and game-total errors with and without them.

  python3 tools/nfl_qb_backtest.py
"""
import json, os, sys
from collections import defaultdict
from statistics import mean

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import team_model as T          # noqa: E402
import nfl_model as M           # noqa: E402

D = "data/nfl"


def main():
    rows = json.load(open(f"{D}/player_games.json"))["rows"]
    games = json.load(open(f"{D}/results.json"))["games"]
    byg = {g["id"]: g for g in games}
    # starter per team-game: the quarterback with the most pass attempts
    st = {}
    for r in rows:
        if (r.get("att") or 0) <= 0:
            continue
        k = (r["gid"], r["team"])
        if k not in st or r["att"] > st[k]["att"]:
            st[k] = {"pid": r["pid"], "name": r["name"], "att": r["att"], "date": r["date"], "season": r["season"]}
    tg = defaultdict(list)                     # team -> [(date, gid, starter pid)]
    for (gid, team), s in st.items():
        tg[team].append((s["date"], gid, s["pid"], s["name"]))
    for t in tg:
        tg[t].sort()
    info = {}                                  # (gid, team) -> {"backup": bool, ...}
    for t, L in tg.items():
        for i, (d, gid, pid, nm) in enumerate(L):
            prev = [x[2] for x in L[max(0, i - 10):i]]
            if len(prev) < 3:
                continue
            cnt = defaultdict(int)
            for p in prev:
                cnt[p] += 1
            usual, n = max(cnt.items(), key=lambda kv: kv[1])
            if n < 3:
                continue
            prior_starts = sum(1 for x in L[:i] if x[2] == pid)
            info[(gid, t)] = {"backup": pid != usual, "usual": usual, "starter": pid, "name": nm,
                              "deep": pid != usual and prior_starts <= 1, "date": d}
    # out-of-sample expected points: ratings fitted on games before each date
    dates = sorted({v["date"] for v in info.values()})
    R_at = {d: T.fit(games, d, M.GAME_P) for d in dates}
    rec = []
    for (gid, t), v in info.items():
        g = byg.get(gid)
        if not g or g.get("hs") is None:
            continue
        R = R_at[v["date"]]
        eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
        home = g["home"] == t
        if (R.get("n", {}).get(g["home"], 0) < 3) or (R.get("n", {}).get(g["away"], 0) < 3):
            continue
        pts, opp = (g["hs"], g["as"]) if home else (g["as"], g["hs"])
        e, eo = (eh, ea) if home else (ea, eh)
        rec.append(dict(v, gid=gid, team=t, season=g["season"], pts=pts, opp=opp, e=e, eo=eo, gt=g["hs"] + g["as"], egt=eh + ea))
    print(f"{len(rec)} team-games with a usual starter on record and rated teams")
    for lab, f in (("normal starts", lambda r: not r["backup"]), ("backup starts", lambda r: r["backup"]),
                   ("  of which deep backups (0-1 prior starts)", lambda r: r["deep"])):
        S = [r for r in rec if f(r)]
        if S:
            print(f"  {lab:44s} n={len(S):4d}  team pts vs expected {mean(r['pts'] - r['e'] for r in S):+5.2f}"
                  f"  opponent pts vs expected {mean(r['opp'] - r['eo'] for r in S):+5.2f}")

    # held-out: fit the backup adjustments on one season, test on the other
    def fit_adj(S):
        b = [r for r in S if r["backup"]]
        n = [r for r in S if not r["backup"]]
        base = mean(r["pts"] - r["e"] for r in n) if n else 0.0
        k = 8.0                                   # shrink toward no effect: 8 games' worth of prior
        own = sum(r["pts"] - r["e"] - base for r in b) / (len(b) + k) if b else 0.0
        opp = sum(r["opp"] - r["eo"] for r in b) / (len(b) + k) - (mean(r["opp"] - r["eo"] for r in n) if n else 0) * len(b) / (len(b) + k) if b else 0.0
        return own, opp
    for tr, te in ((2025, 2026), (2026, 2025)):
        A = [r for r in rec if r["season"] == tr]
        B = [r for r in rec if r["season"] == te and r["backup"]]
        if not A or not B:
            continue
        own, opp = fit_adj(A)
        e0 = mean(abs(r["pts"] - r["e"]) for r in B)
        e1 = mean(abs(r["pts"] - (r["e"] + own)) for r in B)
        t0 = mean(abs(r["gt"] - r["egt"]) for r in B)
        t1 = mean(abs(r["gt"] - (r["egt"] + own + opp)) for r in B)
        b0 = mean(r["pts"] - r["e"] for r in B)
        print(f"\nfit on {tr}, test on {te} backup starts (n={len(B)}): adjustment team {own:+.2f} pts, opponent {opp:+.2f}")
        print(f"  team points error {e0:.2f} -> {e1:.2f} | game total error {t0:.2f} -> {t1:.2f} | raw bias {b0:+.2f}")

    # deep backups only (0-1 prior starts): the team adjustment alone, held out by season
    for tr, te in ((2025, 2026), (2026, 2025)):
        A = [r for r in rec if r["season"] == tr]
        B = [r for r in rec if r["season"] == te and r["deep"]]
        n = [r for r in A if not r["backup"]]
        d = [r for r in A if r["deep"]]
        if not B or not d:
            continue
        base = mean(r["pts"] - r["e"] for r in n)
        adj = sum(r["pts"] - r["e"] - base for r in d) / (len(d) + 8.0)
        e0 = mean(abs(r["pts"] - r["e"]) for r in B); e1 = mean(abs(r["pts"] - (r["e"] + adj)) for r in B)
        t0 = mean(abs(r["gt"] - r["egt"]) for r in B); t1 = mean(abs(r["gt"] - (r["egt"] + adj)) for r in B)
        print(f"\ndeep backups: fit on {tr} (n={len(d)}) adj {adj:+.2f} pts; test {te} n={len(B)}: team error {e0:.2f} -> {e1:.2f}, total error {t0:.2f} -> {t1:.2f}, raw bias {mean(r['pts'] - r['e'] for r in B):+.2f}")
    # receivers: catches and yards with a backup vs their own average with the usual starter
    bk = {(r["gid"], r["team"]): r["backup"] for r in rec}
    per = defaultdict(lambda: {"n": [], "b": []})
    for r in rows:
        k = (r["gid"], r["team"])
        if k not in bk or r.get("rec") is None:
            continue
        per[r["pid"]]["b" if bk[k] else "n"].append((r.get("rec") or 0.0, r.get("rec_yds") or 0.0))
    ry, rc = [], []
    for p, v in per.items():
        if len(v["n"]) >= 4 and v["b"] and mean(x[1] for x in v["n"]) >= 20:
            an, ay = mean(x[0] for x in v["n"]), mean(x[1] for x in v["n"])
            for c, y in v["b"]:
                rc.append(c / an if an else 1.0)
                ry.append(y / ay if ay else 1.0)
    # the same with deep backups only, split by season (held out: fit one, test the other on yards error)
    dk = {(r["gid"], r["team"]): r for r in rec}
    for tr, te in ((2025, 2026), (2026, 2025)):
        def ratios(season):
            out = []
            for p, v in per.items():
                pass
            return out
        fit, test = [], []
        for r in rows:
            k = (r["gid"], r["team"])
            x = dk.get(k)
            if not x or not x["deep"] or r.get("rec") is None:
                continue
            v = per.get(r["pid"])
            if not v or len(v["n"]) < 4:
                continue
            ay = mean(y[1] for y in v["n"]); ac = mean(y[0] for y in v["n"])
            if ay < 20:
                continue
            (fit if x["season"] == tr else test).append((r.get("rec") or 0.0, r.get("rec_yds") or 0.0, ac, ay))
        if not fit or not test:
            continue
        fy = sum(y for _, y, _, _ in fit) / sum(a for _, _, _, a in fit)
        fc = sum(c for c, _, _, _ in fit) / sum(a for _, _, a, _ in fit)
        e0 = mean(abs(y - a) for _, y, _, a in test); e1 = mean(abs(y - a * fy) for _, y, _, a in test)
        c0 = mean(abs(c - a) for c, _, a, _ in test); c1 = mean(abs(c - a * fc) for c, _, a, _ in test)
        print(f"\nreceivers with a deep backup: fit {tr} (n={len(fit)}): yards x{fy:.2f}, catches x{fc:.2f}; test {te} n={len(test)}: "
              f"yards error {e0:.1f} -> {e1:.1f}, catches error {c0:.2f} -> {c1:.2f}")
    if ry:
        print(f"\nreceivers (20+ yards a game with the usual starter) in backup starts: n={len(ry)} player-games")
        print(f"  catches at {100 * mean(rc):.0f}% of their usual, receiving yards at {100 * mean(ry):.0f}% (median {100 * sorted(ry)[len(ry) // 2]:.0f}%)")


if __name__ == "__main__":
    main()
