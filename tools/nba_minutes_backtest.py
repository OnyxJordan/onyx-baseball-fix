#!/usr/bin/env python3
"""
nba_minutes_backtest.py - how accurate are the NBA depth chart's minutes and stat lines? (dev only)

Replays the 2025-26 regular season one game day at a time through the LIVE
nba_model.project_slate, exactly as tools/nba_backtest.py does (same loader, same
walk-forward, same reconstructed injury report), set up the way production runs:
  - the v4 three-season history prior (bt/nba/history.json, aged, regressed to role),
  - SIM_ROSTER: the whole roster is on the slate, healthy scratches included,
  - closing Onyx total / spread for the game environment (bt/nba/lines.json),
  - starting fives NOT known (most of the day; run with --lineups for the last hours).
On each day the model sees only box scores from earlier days. Nothing is tuned here
unless --fit is passed (then the depth blend weights are chosen on Oct-Jan only and
printed for nba_build.DEPTH_W).

Every player who logged a minute is scored: projected vs actual minutes, points,
rebounds, assists, made threes and PRA, against two naive guesses built from the same
earlier box scores: his season-to-date average and his last-10 average (both over
games he played; a player with no game yet this season falls back to his prior's
per-game line, so every row has all three numbers). Groups:
  - role, as the depth chart assigns it from the projection: Starter (team's top 5
    projected minutes), Rotation (12+ projected minutes), Bench (the rest);
  - returning from injury: missed his team's last 3+ games, or his season debut after
    the team had played 3+;
  - teammates out: 1+ / 2+ recent rotation players (3 of the last 5 games, 15+ min)
    missing tonight, where the minutes and usage redistribution does the work.
Headline window: Feb-Apr 2026 (the held-out months every NBA change is judged on).

  python3 tools/nba_minutes_backtest.py [bt/nba] [--lineups] [--fit] [--json out.json]

The summary goes into data/nba/depth.json under "backtest" (nba_build.write_depth keeps
it on every build and the Depth and Model tabs show it); --json PATH writes it elsewhere.
"""

import json, sys, time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import nba_backtest as B   # noqa: E402
import nba_model as M      # noqa: E402
import nba_build as NB     # noqa: E402  (depth_line / DEPTH_W: the code the page runs)

STATS = ("min", "pts", "reb", "ast", "fg3", "pra")
SPLIT = B.SPLIT
ROT_MIN = 12.0     # the depth chart's Rotation line, projected minutes


def role_of(rank, mins, starter=None):
    if starter is True:
        return "Starter"
    if starter is None and rank < 5:
        return "Starter"
    return "Rotation" if mins >= ROT_MIN else "Bench"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    bt = Path(args[0] if args else "bt/nba")
    out_json = None
    if "--json" in sys.argv:
        i = sys.argv.index("--json")
        out_json = sys.argv[i + 1] if i + 1 < len(sys.argv) else None
        args = [a for a in args if a != out_json]
    to_depth = out_json is None
    G, lines = B.load(bt)
    hist = json.load(open(bt / "history.json"))
    prior, th, roles, _, hit, n = B.build_hist_prior(lines, hist, target=2026)
    B.HIST_CTX.update(team_hist=th, roles=roles)
    mkt = json.load(open(bt / "lines.json")) if (bt / "lines.json").exists() else {}
    B.SIM_ROSTER = True
    B.SIM_LINEUP = "--lineups" in sys.argv
    print(f"loaded {len(G)} games; history prior for {hit} of {n} players; lineups known: {B.SIM_LINEUP}")

    # capture every projected row (DNPs included) so roles rank the whole roster
    proj_rows = {}
    orig = M.project_slate

    def cap(slate, *a, **k):
        rows, lg = orig(slate, *a, **k)
        for r in rows:
            proj_rows[(r["gid"], r["pid"])] = (r["team"], r["min"], r["out"])
        return rows, lg
    M.project_slate = cap
    t0 = time.time()
    recs = B.walk(G, lines, "2025-10-01", "2026-04-30", prior, mkt)
    M.project_slate = orig
    print(f"walk-forward: {len(recs)} player-games in {time.time() - t0:.0f}s")

    # roles from the projection, per (game, team)
    by_team = defaultdict(list)
    for (gid, pid), (team, mn, out) in proj_rows.items():
        if not out:
            by_team[(gid, team)].append((mn, pid))
    role = {}
    starters = {(fid, l["pid"]): bool(l["starter"]) for fid, ls in lines.items() for l in ls}
    for (gid, team), lst in by_team.items():
        lst.sort(key=lambda x: -x[0])
        for rank, (mn, pid) in enumerate(lst):
            role[(gid, pid)] = role_of(rank, mn, starters.get((gid, pid)) if B.SIM_LINEUP else None)

    # this season's box rows per player (for baselines) and team schedules (for "returning")
    act = {(fid, l["pid"]): l for fid, ls in lines.items() for l in ls}
    played = defaultdict(list)    # pid -> [(d, line)]
    team_days = defaultdict(list)
    for fid, ls in lines.items():
        d = G[fid]["d"]
        if not ("2025-10-01" <= d <= "2026-04-30"):
            continue
        for t in {G[fid]["home"], G[fid]["away"]}:
            team_days[t].append(d)
        for l in ls:
            if l["min"] > 0:
                played[l["pid"]].append((d, l))
    for v in played.values():
        v.sort(key=lambda x: x[0])
    for v in team_days.values():
        v.sort()

    def val(l, s):
        return l["pts"] + l["reb"] + l["ast"] if s == "pra" else l[s]

    rows = []
    for r in recs:
        a = act[(r["gid"], r["pid"])]
        team = a["team"]
        prev = [(d, l) for d, l in played[r["pid"]] if d < r["d"]]
        before = [l for _, l in prev]
        pri = prior.get(r["pid"])
        pv = {}
        if pri and pri.get("gp"):
            for s in ("min", "pts", "reb", "ast", "fg3"):
                pv[s] = (pri.get(s) or 0.0) / pri["gp"]
            pv["pra"] = pv["pts"] + pv["reb"] + pv["ast"]
        base = {}
        for s in STATS:
            if before:
                szn = sum(val(l, s) for l in before) / len(before)
                l10 = sum(val(l, s) for l in before[-10:]) / len(before[-10:])
            else:
                szn = l10 = pv.get(s)
            base[s] = (szn, l10)
        if any(v[0] is None for v in base.values()):
            continue    # no NBA history at all and no game yet: nothing naive to compare with
        proj = dict(r["proj"])
        proj["min"] = r["pmin"]
        proj["pra"] = proj["pts"] + proj["reb"] + proj["ast"]
        last_d = prev[-1][0] if prev else None
        tdays = [d for d in team_days[team] if d < r["d"]]
        missed = len([d for d in tdays if last_d is None or d > last_d])
        rows.append({"d": r["d"], "gid": r["gid"], "team": team, "role": role.get((r["gid"], r["pid"]), "Bench"),
                     "ret": missed >= 3, "out": r.get("team_out", 0), "gp": len(before),
                     "p": proj, "a": {s: val(a, s) for s in STATS}, "b": base})
    print(f"scored {len(rows)} player-games (logged a minute, with a naive guess to compare)")

    BASE = ("min", "pts", "reb", "ast", "fg3")

    def seg(x):
        return "Returning" if x["ret"] else x["role"]

    def depth_of(x, W):
        """the depth chart's line: nba_build.depth_line, the same code production runs"""
        # production: no game yet this season -> no last 10, the model alone
        l10 = {s: (x["b"][s][1] if x["gp"] else None) for s in BASE}
        return NB.depth_line({s: x["p"][s] for s in BASE}, l10, x["role"], x["ret"], W)

    W = NB.DEPTH_W
    if "--fit" in sys.argv:
        tr = [x for x in rows if x["d"] < SPLIT]
        W = {}
        for g in ("Starter", "Rotation", "Bench", "Returning"):
            sel = [x for x in tr if seg(x) == g]
            W[g] = {}
            for s in BASE:
                best = None
                for w in [i / 20 for i in range(21)]:
                    e = sum(abs(w * x["p"][s] + (1 - w) * x["b"][s][1] - x["a"][s]) for x in sel) / len(sel)
                    if best is None or e < best[1] - 1e-9:
                        best = (w, e)
                W[g][s] = best[0]
        print("\nweights on the model (rest on the last-10 average), chosen on Oct-Jan:")
        print("DEPTH_W = " + json.dumps(W))
    for x in rows:
        x["q"] = depth_of(x, W)

    # team minutes after the blend: the model's minutes fit 240 a team, but a last-10 counts
    # only games played, so the blended chart can sum past 240. Measured, not assumed:
    tsum = defaultdict(float)
    for (gid, team), lst in by_team.items():
        d = G[gid]["d"]
        tdays = [x for x in team_days[team] if x < d]
        for rank, (mn, pid) in enumerate(sorted(lst, key=lambda z: -z[0])):
            prev = [l for dd, l in played[pid] if dd < d]
            last_d = max((dd for dd, _ in played[pid] if dd < d), default=None)
            ret = len([x for x in tdays if last_d is None or x > last_d]) >= 3
            l10 = sum(l["min"] for l in prev[-10:]) / len(prev[-10:]) if prev else None
            tsum[(gid, team)] += NB.depth_line({"min": mn}, {"min": l10}, role.get((gid, pid), "Bench"), ret, W)["min"]
    sums = sorted(tsum.values())
    print(f"\nblended team minutes: median {sums[len(sums) // 2]:.0f}, 10th-90th pct {sums[len(sums) // 10]:.0f}-{sums[9 * len(sums) // 10]:.0f}")
    te = [x for x in rows if x["d"] >= SPLIT]
    tm = {"median_sum": round(sums[len(sums) // 2])}
    for lab, f in (("as blended", lambda k: 1.0), ("scaled to 240", lambda k: 240.0 / tsum[k]),
                   ("capped at 240", lambda k: min(1.0, 240.0 / tsum[k]))):
        e = sum(abs(x["q"]["min"] * f((x["gid"], x["team"])) - x["a"]["min"]) for x in te) / len(te)
        print(f"  Feb-Apr minutes MAE, team total {lab:14s} {e:.3f}")
        tm[lab] = round(e, 3)

    def table(sel):
        res = {"n": len(sel)}
        if not sel:
            return res
        for s in STATS:
            mae = lambda f: round(sum(abs(f(x) - x["a"][s]) for x in sel) / len(sel), 2)
            res[s] = [mae(lambda x: x["q"][s]), mae(lambda x: x["p"][s]),
                      mae(lambda x: x["b"][s][0]), mae(lambda x: x["b"][s][1]),
                      round(sum(x["q"][s] - x["a"][s] for x in sel) / len(sel), 2)]
        return res

    GROUPS = [
        ("All who played", lambda x: True),
        ("Starters", lambda x: x["role"] == "Starter"),
        ("Rotation", lambda x: x["role"] == "Rotation"),
        ("Bench", lambda x: x["role"] == "Bench"),
        ("Returning from injury", lambda x: x["ret"]),
        ("1+ rotation teammate out", lambda x: x["out"] >= 1),
        ("2+ rotation teammates out", lambda x: x["out"] >= 2),
        ("No teammate out", lambda x: x["out"] == 0),
    ]
    summary = {}
    for win, lo, hi in (("test", SPLIT, "9999"), ("train", "0000", SPLIT)):
        print(f"\n=== {'Feb-Apr 2026 (held out)' if win == 'test' else 'Oct-Jan 2025-26 (weights chosen here)'} ===")
        print("  MAE  depth (shipped) / model alone / season avg / last 10")
        summary[win] = {}
        for name, f in GROUPS:
            sel = [x for x in rows if lo <= x["d"] < hi and f(x)]
            t = table(sel)
            summary[win][name] = t
            if not sel:
                continue
            print(f"  {name:26s} n={t['n']:6d}")
            for s in STATS:
                q, m, z, l, b = t[s]
                flag = "  <- depth loses to a naive guess" if q > min(z, l) + 1e-9 else \
                       ("  (model alone loses; the blend fixes it)" if m > min(z, l) + 1e-9 else "")
                print(f"     {s:4s} {q:6.2f} {m:6.2f} {z:6.2f} {l:6.2f}   bias {b:+.2f}{flag}")
    summary["meta"] = {"season": "2025-26", "test": "Feb-Apr 2026", "train": "Oct-Jan 2025-26",
                       "lineups_known": B.SIM_LINEUP, "player_games": len(rows),
                       "cols": ["depth", "model", "season avg", "last 10", "depth bias"],
                       "model": M.VERSION, "weights": W, "team_minutes": tm}
    if to_depth:
        p = Path(__file__).resolve().parent.parent / "data" / "nba" / "depth.json"
        cur = json.load(open(p)) if p.exists() else {"sport": "nba", "unit": "min", "teams": {}}
        cur["backtest"] = summary
        json.dump(cur, open(p, "w"), indent=1, ensure_ascii=False)
        print(f"\nwrote the backtest block into {p}")
    else:
        json.dump(summary, open(out_json, "w"), indent=1)
        print(f"\nwrote {out_json}")


if __name__ == "__main__":
    main()
