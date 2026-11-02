#!/usr/bin/env python3
"""
depth_backtest.py - backtest the Depth tab's usage and per-game projections on past
games, each game projected only from games before it. Dev only (never in the pipeline).

    python3 -B tools/depth_backtest.py nfl|cfb|nhl [--tune]

Writes data/<sport>/depth_backtest.json, which the depth builders copy into
depth.json ("backtest") and the Depth tab's method note. Every projection is scored by
mean absolute error against two baselines a bettor would use: the player's
season-to-date average and his last-3 average.

  nfl  snap share (nflverse snap counts 2024-2026; tuned on 2025 with 2024 as the
       prior, judged on 2026), the NFL model's yards and receptions (nfl_model.project,
       its own tuning on 2025), touchdowns (depth_football.TD_P). Weeks 3+, players with
       2+ games this season. Data: bt/nflsnap_<yr>.csv (downloaded once).
  cfb  usage share (passes, carries, catches) and the college model's numbers on 2026,
       weeks 4+ (one season on file: tuned on weeks 4-6, judged on 7+).
  nhl  ice time and goals / assists / points / shots per game from NHL API boxscores
       (bt/nhl_api_box.json, tools/nhl_box_pull.py): tuned on 2025-26 before 1/15/2026,
       judged after it and on 2026-27 to date, 2024-25 as the prior.
"""
import json, os, sys
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import depth_football as DF

OFF = {"QB", "RB", "FB", "WR", "TE", "T", "G", "C", "OL", "OT", "OG"}
DEF = {"DE", "DT", "NT", "LB", "ILB", "OLB", "MLB", "CB", "SS", "FS", "S", "DB", "DL"}
STP = {"K", "P", "LS"}


def mae_row(k, m, a, l3, d=2):
    """Signed errors (projection minus actual) -> MAE and RMSE for the projection and both baselines."""
    import depth_hockey as DH
    return DH.score_row(k, m, a, l3, d)


def fmt(r):
    s = (f"  {r['k']:22s} n={r['n']:6d} MAE model {r['mae']:7.3f} season avg {r['avg']:7.3f} last3 {r['l3']:7.3f}  "
         f"{(1 - r['mae'] / r['avg']) * 100:+5.1f}% / {(1 - r['mae'] / r['l3']) * 100:+5.1f}%")
    if "rmse" in r:
        s += f"  | RMSE {r['rmse']:.3f} vs {r['rmse_avg']:.3f} / {r['rmse_l3']:.3f}"
    return s


def score(rows):
    return sum(r["mae"] / min(r["avg"], r["l3"]) for r in rows) / max(1, len(rows))


# ── NFL ──────────────────────────────────────────────────────────────
def nfl_snaps(yr):
    local = {2024: "bt/nfl24/snap_counts_2024.csv"}.get(yr) or f"bt/nflsnap_{yr}.csv"
    if os.path.exists(local):
        return DF.snap_csv(yr, local)
    rows = DF.snap_csv(yr)
    if rows:
        import csv
        with open(local, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    return rows


def snap_seq(rows):
    """{pfr id: [(week, unit share)]} for one season (REG), the unit by listed position."""
    out = defaultdict(list)
    for r in rows:
        if r.get("game_type") != "REG":
            continue
        pos = (r.get("position") or "").upper()
        u = "offense_pct" if pos in OFF else "defense_pct" if pos in DEF else "st_pct" if pos in STP else None
        v = float(r.get(u) or 0) if u else 0
        if v > 0:
            out[r["pfr_player_id"]].append((int(r["week"]), v))
    for v in out.values():
        v.sort()
    return out


def eval_snaps(cur, prev, p, w0=3):
    m, a, l3 = [], [], []
    prior = {k: sum(x for _, x in v) / len(v) for k, v in prev.items() if len(v) >= 4}
    for pid, seq in cur.items():
        for i, (wk, act) in enumerate(seq):
            if wk < w0 or i < 2:
                continue
            past = [x for _, x in seq[:i]]
            pr = DF.shrink(past, prior.get(pid), p["dec"], p["k"])
            m.append((pr - act) * 100); a.append((sum(past) / len(past) - act) * 100)
            l3.append((sum(past[-3:]) / len(past[-3:]) - act) * 100)
    return m, a, l3


def eval_td(rows, season, p, kind="td", w0=3):
    import nfl_model as M
    by = M._games_by_player(rows)
    f = DF.td_of if kind == "td" else (lambda g: g.get("pass_td") or 0)
    m, a, l3 = [], [], []
    for pid, gs in by.items():
        for i, g in enumerate(gs):
            if g["season"] != season or g["week"] < w0:
                continue
            cur = [x for x in gs[:i] if x["season"] == season]
            if len(cur) < 2:
                continue
            if kind == "pass" and sum(x.get("att") or 0 for x in cur[-4:]) / len(cur[-4:]) < 15:
                continue
            if kind == "td" and sum((x.get("rush_att") or 0) + (x.get("tgt") or x.get("rec") or 0) for x in cur[-4:]) / len(cur[-4:]) < 3:
                continue
            pr = DF.proj_td(gs[:i], season, g["week"], p, kind)
            act = f(g)
            vals = [f(x) for x in cur]
            m.append(pr - act); a.append(sum(vals) / len(vals) - act); l3.append(sum(vals[-3:]) / len(vals[-3:]) - act)
    return m, a, l3


def run_nfl(tune):
    import nfl_model as M
    s24, s25, s26 = (snap_seq(nfl_snaps(y) or []) for y in (2024, 2025, 2026))
    print(f"snap players: 2024 {len(s24)}, 2025 {len(s25)}, 2026 {len(s26)}")
    p = dict(DF.SNAP_P)
    if tune:
        best = None
        for dec in (0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
            for k in (0.0, 0.5, 1.0, 2.0, 4.0):
                m, a, l3 = eval_snaps(s25, s24, {"dec": dec, "k": k})
                sc = sum(abs(x) for x in m) / len(m)
                if best is None or sc < best[0]:
                    best = (sc, {"dec": dec, "k": k})
        print("snap tuned on 2025:", best)
        p = best[1]
    rows = (json.load(open("data/nfl/player_games.json")) or {})["rows"]
    tp = dict(DF.TD_P)
    if tune:
        best = None
        for dec in (0.8, 0.9, 0.95, 1.0):
            for k in (0.0, 1.0, 3.0, 6.0, 10.0):
                m, a, l3 = eval_td(rows, 2025, {"dec": dec, "k": k})
                sc = sum(x * x for x in m) / len(m)      # touchdowns: the mean (squared error); MAE rewards guessing 0
                if best is None or sc < best[0]:
                    best = (sc, {"dec": dec, "k": k})
        print("td tuned on 2025:", best)
        tp = best[1]
    res = {}
    for season, cur, prev in ((2025, s25, s24), (2026, s26, s25)):
        out = [mae_row("Snap share (points)", *eval_snaps(cur, prev, p), d=1)]
        ev = M._eval(rows, {season}, 3, M.P)
        names = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec": "Receptions", "rec_yds": "Receiving yards"}
        for s in ("pass_yds", "rush_yds", "rec", "rec_yds"):
            v = ev.get(s)
            if v:
                d = 2 if s == "rec" else 1
                out.append({"k": names[s], "n": v["n"], "mae": round(v["mae"], d), "avg": round(v["avg"], d), "l3": round(v["l3"], d)})
        out.append(mae_row("Touchdowns", *eval_td(rows, season, tp), d=3))
        out.append(mae_row("Passing touchdowns", *eval_td(rows, season, tp, "pass"), d=3))
        res[season] = out
    for s, out in res.items():
        print(f"== {s}")
        for r in out:
            print(fmt(r))
    return {"window": "2026 weeks 3 to 8, tuned on 2025", "rows": res[2026], "tune": res[2025],
            "params": {"snap": p, "td": tp}}


# ── college football ─────────────────────────────────────────────────
def run_cfb(tune):
    import cfb_players as CP
    import nfl_model as N
    rows = (json.load(open("data/cfb/player_games.json")) or {})["rows"]
    season = max(r["season"] for r in rows)
    rows = [r for r in rows if r["season"] == season]
    tv = DF.team_volume(rows)
    by = N._games_by_player(rows)
    ros = (json.load(open("data/cfb/rosters.json")) if os.path.exists("data/cfb/rosters.json") else {}).get("teams") or {}

    tweeks = DF.team_weeks(tv)

    def ev_share(dec, w0, w1):
        """Every team game in weeks w0..w1 after a player's first two appearances, while he has
        appeared in at least one of the team's last three games; 0 share when he has no box line."""
        m, a, l3 = [], [], []
        for pid, gs in by.items():
            pos = DF.CFB_POS.get(((ros.get(gs[-1]["team"]) or {}).get("pos") or {}).get(pid) or "") or DF.guess_pos(gs)
            vol = DF.CFB_VOL[pos]
            team = gs[-1]["team"]
            mine = {g["week"] for g in gs if g["team"] == team}
            for w in tweeks.get(team, []):
                if not (w0 <= w <= w1):
                    continue
                past, n = DF.share_all(gs, tv, vol, tweeks, before=w)
                prev3 = [x for x in tweeks[team] if x < w][-3:]
                if n < 2 or len(past) < 2 or max(past) < 0.05 or not any(x in mine for x in prev3):
                    continue
                t = tv.get((team, w), {}).get(vol) or 0
                if t <= 0:
                    continue
                act = (next((g.get(vol) or 0 for g in gs if g["week"] == w and g["team"] == team), 0)) / t
                pr = DF.shrink(past, None, dec, 0)
                m.append((pr - act) * 100); a.append((sum(past) / len(past) - act) * 100)
                l3.append((sum(past[-3:]) / len(past[-3:]) - act) * 100)
        return m, a, l3
    dec = DF.CFB_SHARE_P["dec"]
    if tune:
        best = min(((sum(abs(x) for x in ev_share(d, 4, 6)[0]) / len(ev_share(d, 4, 6)[0]), d) for d in (0.3, 0.4, 0.5, 0.6, 0.75, 0.85, 0.95, 1.0)))
        print("share tuned on weeks 4-6:", best)
        dec = best[1]

    def ev_td(w0, w1):
        m, a, l3 = [], [], []
        for pid, gs in by.items():
            for i, g in enumerate(gs):
                if not (w0 <= g["week"] <= w1) or i < 2:
                    continue
                cur = gs[:i]
                if sum((x.get("rush_att") or 0) + (x.get("rec") or 0) for x in cur[-4:]) / len(cur[-4:]) < 3:
                    continue
                pr = DF.proj_td(cur, season, g["week"])
                vals = [DF.td_of(x) for x in cur]
                act = DF.td_of(g)
                m.append(pr - act); a.append(sum(vals) / len(vals) - act); l3.append(sum(vals[-3:]) / len(vals[-3:]) - act)
        return m, a, l3
    wmax = max(r["week"] for r in rows)
    out = [mae_row("Usage share (points)", *ev_share(dec, 7, wmax), d=1)]
    test, _ = CP.evaluate(rows, season, 7, wmax)
    names = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec": "Receptions", "rec_yds": "Receiving yards"}
    for s in ("pass_yds", "rush_yds", "rec", "rec_yds"):
        v = test.get(s)
        if v:
            d = 2 if s == "rec" else 1
            out.append({"k": names[s], "n": v["n"], "mae": round(v["mae"], d), "avg": round(v["avg"], d), "l3": round(v["l3"], d)})
    out.append(mae_row("Touchdowns", *ev_td(7, wmax), d=3))
    for r in out:
        print(fmt(r))
    return {"window": f"{season} weeks 7 to {wmax}, tuned on weeks 4 to 6", "rows": out,
            "params": {"share_dec": dec}}


# ── NHL ──────────────────────────────────────────────────────────────
def run_nhl(tune):
    import depth_hockey as DH
    box = json.load(open("bt/nhl_api_box.json"))
    games = sorted((g for g in box.values() if g.get("type") == 2), key=lambda g: (g["date"], g["id"]))
    seasons = {}
    for g in games:
        y = int(g["date"][:4]) - (1 if int(g["date"][5:7]) < 8 else 0)
        seasons.setdefault(y, []).append(g)
    logs = {y: DH.logs_from_box(gs) for y, gs in seasons.items()}
    prior25 = DH.prior_from_logs(logs[2024])
    prior26 = DH.prior_from_logs(logs[2025])
    p = dict(DH.P)
    if tune:   # ice time first (it scores on the TOI row), then the per-60 rates (goals, assists, points, shots)
        best = None
        for td in (0.7, 0.8, 0.85, 0.9, 0.95):
            for tk in (0.0, 2.0, 5.0, 10.0):
                q = dict(p, toi_dec=td, toi_k=tk)
                r = DH.evaluate(logs[2025], prior25, q, d0=None, d1="2026-01-15")
                sc = r[0]["mae"]
                if best is None or sc < best[0]:
                    best = (sc, q)
        p = best[1]
        print("ice time tuned on 2025-26 before 1/15/2026:", best)
        best = None
        for rd in (0.95, 0.98, 1.0):
            for rk in (3.0, 6.0, 10.0, 20.0):
                for pk in (2.0, 5.0, 10.0):
                    q = dict(p, rate_dec=rd, rate_k=rk, pos_k=pk)
                    r = DH.evaluate(logs[2025], prior25, q, d0=None, d1="2026-01-15")
                    sc = sum(x["rmse"] / x["rmse_avg"] for x in r[1:]) / len(r[1:])   # the mean, not the median
                    if best is None or sc < best[0]:
                        best = (sc, q)
        p = best[1]
        print("rates tuned on 2025-26 before 1/15/2026:", best)
    test = DH.evaluate(logs[2025], prior25, p, d0="2026-01-15", d1=None)
    tune_r = DH.evaluate(logs[2025], prior25, p, d0=None, d1="2026-01-15")
    now = DH.evaluate(logs.get(2026, {}), prior26, p) if logs.get(2026) else []
    for nm, out in (("tune 2025-26 before 1/15", tune_r), ("TEST 2025-26 from 1/15", test), ("2026-27 to date", now)):
        print("==", nm)
        for r in out:
            print(fmt(r))
    return {"window": "2025-26 games from 1/15/2026, tuned on the games before it", "rows": test,
            "tune": tune_r, "season_to_date": now, "params": p}


def main():
    key = (sys.argv[1:] or ["nfl"])[0]
    tune = "--tune" in sys.argv
    res = {"nfl": run_nfl, "cfb": run_cfb, "nhl": run_nhl}[key](tune)
    res["run"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    os.makedirs(f"data/{key}", exist_ok=True)
    json.dump(res, open(f"data/{key}/depth_backtest.json", "w"), indent=1)
    print(f"-> data/{key}/depth_backtest.json")


if __name__ == "__main__":
    main()
