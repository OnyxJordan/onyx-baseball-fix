#!/usr/bin/env python3
"""
nfl_feature_screen.py - which statistics predict NFL props beyond Onyx's own price?
Dev only (needs bt/ files; never runs in the pipeline).

For every Onyx player-prop line in 2025 and 2026 (opening price), it builds ~40
candidate features from what was known before kickoff (nflverse weekly player stats,
team volume, the opponent's defense, Onyx's own game lines) and asks, market by
market, whether each feature adds information to Onyx's no-vig chance:

    P(over) = sigmoid(a + b * logit(p_onyx) + c * z(feature))

fitted on 2025 and judged on 2026 (log loss vs the market-only fit). A feature
earns a place only if it helps in the season it never saw.

    python3 tools/nfl_feature_screen.py            # screen every market
    python3 tools/nfl_feature_screen.py rec        # one market
"""
import csv, json, math, os, re, sys, unicodedata
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sports_lab as L   # noqa: E402
import nfl_features as F   # noqa: E402

BT = "bt/"
MARKETS = {   # our key: (Onyx market id, nflverse stat column or derived, line files)
    "rec": ("player_receptions", "receptions", ["nfl_lines.json", "nfl_2024_mkt.json"]),
    "rec_yds": ("player_receiving_yards", "receiving_yards", ["nfl_lines.json", "nfl_2024_mkt.json"]),
    "rush_yds": ("player_rushing_yards", "rushing_yards", ["nfl_lines.json", "nfl_2024_mkt.json"]),
    "pass_yds": ("player_passing_yards", "passing_yards", ["nfl_lines.json", "nfl_2024_mkt.json"]),
    "pass_att": ("player_passing_attempts", "attempts", ["nfl_combo_a.json", "nfl_combo_b.json"]),
    "pass_td": ("player_passing_touchdowns", "passing_tds", ["nfl_pass_td.json"]),
    "rush_rec_yds": ("player_rushing_+_receiving_yards", "rush_rec_yds", ["nfl_combo_ya.json", "nfl_combo_yb.json"]),
    "pass_rush_yds": ("player_passing_+_rushing_yards", "pass_rush_yds", ["nfl_combo_ya.json", "nfl_combo_yb.json"]),
}
NICK = {"Cardinals": "ARI", "Falcons": "ATL", "Ravens": "BAL", "Bills": "BUF", "Panthers": "CAR", "Bears": "CHI", "Bengals": "CIN",
        "Browns": "CLE", "Cowboys": "DAL", "Broncos": "DEN", "Lions": "DET", "Packers": "GB", "Texans": "HOU", "Colts": "IND",
        "Jaguars": "JAX", "Chiefs": "KC", "Raiders": "LV", "Chargers": "LAC", "Rams": "LA", "Dolphins": "MIA", "Vikings": "MIN",
        "Patriots": "NE", "Saints": "NO", "Giants": "NYG", "Jets": "NYJ", "Eagles": "PHI", "Steelers": "PIT", "49ers": "SF",
        "Seahawks": "SEA", "Buccaneers": "TB", "Titans": "TEN", "Commanders": "WAS"}


def nk(s):  # same as nfl_features.nk
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def num(x):
    try:
        return float(x) if x not in ("", "NA", None) else 0.0
    except ValueError:
        return 0.0


def load_stats():
    """nflverse weekly player stats, regular + post season."""
    rows = []
    for y in (2024, 2025, 2026):
        for p in (f"{BT}nflv/stats_player_week_{y}.csv", f"{BT}nfl24/stats_player_week_{y}.csv"):
            if os.path.exists(p):
                rows += [c for c in (F.compact(r) for r in csv.DictReader(open(p))) if c]
                break
    return rows


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    vj = json.load(open("data/nfl/nflverse.json"))
    IX = F.Index(load_stats(), F.snaps_of(vj))
    by_pid, by_name, snaps = IX.by_pid, IX.by_name, IX.snaps
    if os.path.exists(BT + "nfl24/snap_counts_2024.csv"):
        for r in csv.DictReader(open(BT + "nfl24/snap_counts_2024.csv")):
            if r.get("game_type") == "REG" or r.get("game_type") in ("WC", "DIV", "CON", "SB"):
                snaps[(int(r["season"]), int(r["week"]), r["team"], nk(r["player"]))] = num(r.get("offense_pct"))
    res = json.load(open("data/nfl/results.json"))["games"]
    wk_of = {}
    for r in json.load(open("data/nfl/player_games.json"))["rows"]:
        wk_of[r["gid"]] = (r["season"], r["week"])
    res = [dict(g, season=wk_of[g["id"]][0], week=wk_of[g["id"]][1]) for g in res if g.get("id") in wk_of]
    by_day = defaultdict(list)
    for g in res:
        by_day[g["date"]].append(g)
    if os.path.exists(BT + "nfl24/games.json"):      # 2024 (nflverse game ids and team codes)
        for g in json.load(open(BT + "nfl24/games.json")):
            if g.get("season") == 2024:
                by_day[g["date"]].append({"id": g["gid"], "date": g["date"], "season": 2024, "week": g["week"], "home": g["home"], "away": g["away"]})
    games = json.load(open(BT + "nfl_game.json"))
    ESPN2V = {"WSH": "WAS", "LAR": "LA"}
    ab = lambda s: NICK.get((s or "").split()[-1])

    features = IX.features

    # Onyx's own lines in the player's other markets, same game (opening): a combo priced out
    # of line with its parts, or yards out of line with catches, is information
    XL = defaultdict(dict)
    for fn in ("nfl_lines.json", "nfl_combo_a.json", "nfl_combo_b.json", "nfl_combo_ya.json", "nfl_combo_yb.json", "nfl_pass_td.json"):
        if os.path.exists(BT + fn):
            for fid, x in json.load(open(BT + fn)).items():
                for nm, mk in (x.get("props") or {}).items():
                    for mid_, v in mk.items():
                        if v.get("o") and v["o"][0] is not None and None not in v["o"][1:3]:
                            io_, iu_ = L.implied(v["o"][1]), L.implied(v["o"][2])
                            XL[(fid, nm)][mid_] = (v["o"][0], io_ / (io_ + iu_))

    # --role (11/1): who is ahead of him on the depth chart the day before, and how much
    # volume the teammates ruled Out / Doubtful that week leave behind (nflverse depth charts
    # and injury reports, both known before kickoff)
    DEPTH, INJ = {}, defaultdict(set)
    if "--role" in sys.argv:
        for y in (2025, 2026):
            p_ = f"{BT}nflx/depth_charts_{y}.csv"
            if os.path.exists(p_):
                for r in csv.DictReader(open(p_)):
                    if r["pos_abb"] in ("QB", "RB", "WR", "TE") and r["gsis_id"]:
                        k_ = (r["team"], r["dt"][:10])
                        DEPTH.setdefault(k_, {})[r["gsis_id"]] = min(int(r["pos_rank"] or 9), DEPTH.get(k_, {}).get(r["gsis_id"], 9))
            p_ = f"{BT}nflx/injuries_{y}.csv"
            if os.path.exists(p_):
                for r in csv.DictReader(open(p_)):
                    if r["report_status"] in ("Out", "Doubtful"):
                        INJ[(int(r["season"]), int(r["week"]), r["team"])].add(r["gsis_id"])
                    elif r["report_status"] == "Questionable":
                        INJ[(int(r["season"]), int(r["week"]), r["team"], "q")].add(r["gsis_id"])
    depth_days = defaultdict(list)
    for (t_, d_) in DEPTH:
        depth_days[t_].append(d_)
    for t_ in depth_days:
        depth_days[t_].sort()

    def role(pid, season, week, team, gdate):
        if not DEPTH:
            return {}
        ds = [d_ for d_ in depth_days.get(team, []) if d_ < gdate]
        rank = DEPTH[(team, ds[-1])].get(pid, 5) if ds else 5
        # his rank at his previous game: a move up the chart is a new role
        h = [g for g in by_pid.get(pid, []) if (g["season"], g["week"]) < (season, week)]
        prev = 5
        if h:
            lg_ = h[-1]
            pd = [d_ for d_ in depth_days.get(lg_["team"], []) if d_ < gdate and d_ <= f"{lg_['season'] + (1 if lg_['week'] > 17 else 0)}-12-31"]
            pd = [d_ for d_ in pd if d_ < ds[-1]] if ds else pd
            # the chart about a week before tonight's
            if ds:
                wk_ago = [d_ for d_ in depth_days.get(team, []) if d_ < ds[-1] and d_ <= (date.fromisoformat(ds[-1]) - timedelta(days=6)).isoformat()]
                if wk_ago:
                    prev = DEPTH[(team, wk_ago[-1])].get(pid, 5)
        out_ids = INJ.get((season, week, team), set()) - {pid}
        vt = vc = va = 0.0
        for oid in out_ids:
            oh = [g for g in by_pid.get(oid, []) if (g["season"], g["week"]) < (season, week)][-5:]
            if not oh:
                continue
            for g in oh:
                tw = IX.team_wk[(g["season"], g["week"], g["team"])]
                vt += g["targets"] / max(1.0, tw["targets"]) / len(oh)
                vc += g["carries"] / max(1.0, tw["carries"]) / len(oh)
                va += g["attempts"] / max(1.0, tw["attempts"]) / len(oh)
        return {"depth": float(rank), "depth_up": float(prev - rank), "vac_tgt": vt, "vac_car": vc, "vac_qb": va,
                "own_q": 1.0 if pid in INJ.get((season, week, team, "q"), set()) else 0.0}

    # --pbp (11/1): play-calling and conditions from nflverse play-by-play: pass rate over
    # expected (PROE, a coach's tendency), neutral-situation pace (seconds per play with the
    # game in doubt), the defense's PROE and pace allowed, and the game's wind, temperature
    # and roof. Team numbers are rolling, last 4 games before tonight.
    PB_T, PB_G = {}, {}
    if "--pbp" in sys.argv:
        for y in (2024, 2025, 2026):
            p_ = f"{BT}nflx/play_by_play_{y}.csv"
            if not os.path.exists(p_):
                continue
            agg = defaultdict(lambda: {"poe": 0.0, "n": 0, "sec": 0.0, "np": 0, "dpoe": 0.0, "dn": 0, "dsec": 0.0, "dnp": 0})
            last = {}
            for r in csv.DictReader(open(p_)):
                if r.get("season_type") not in ("REG", "POST") or not r.get("posteam"):
                    continue
                wk_, gid_ = int(r["week"]), r["game_id"]
                if gid_ not in PB_G:
                    roof = r.get("roof") or ""
                    PB_G[gid_] = {"wind": num(r.get("wind")) if roof in ("outdoors", "open") else 0.0,
                                  "temp": num(r.get("temp")) if roof in ("outdoors", "open") and r.get("temp") not in ("", "NA") else 65.0,
                                  "dome": 0.0 if roof in ("outdoors", "open") else 1.0, "teams": (r.get("home_team"), r.get("away_team")), "week": wk_, "season": int(r["season"])}
                if r.get("pass") not in ("1",) and r.get("rush") not in ("1",):
                    continue
                o, d_ = agg[(int(r["season"]), wk_, r["posteam"])], agg[(int(r["season"]), wk_, r["defteam"])]
                if r.get("pass_oe") not in ("", "NA", None):
                    o["poe"] += num(r["pass_oe"]); o["n"] += 1
                    d_["dpoe"] += num(r["pass_oe"]); d_["dn"] += 1
                wp = num(r.get("wp")); hs = num(r.get("half_seconds_remaining")); gs = num(r.get("game_seconds_remaining"))
                k_ = (gid_, r["posteam"], r.get("drive"))
                if 0.2 <= wp <= 0.8 and hs > 120 and k_ in last and 0 < last[k_] - gs < 60:
                    o["sec"] += last[k_] - gs; o["np"] += 1
                    d_["dsec"] += last[k_] - gs; d_["dnp"] += 1
                last[k_] = gs
            for k_, v in agg.items():
                PB_T[k_] = v

    def pbp_feats(season, week, team, opp, gdate):
        if not PB_T:
            return {}
        def roll(t, key, n_key):
            ks = sorted((s_, w_) for (s_, w_, t_) in PB_T if t_ == t and (s_, w_) < (season, week))[-4:]
            num_ = sum(PB_T[(s_, w_, t)][key] for s_, w_ in ks); den = sum(PB_T[(s_, w_, t)][n_key] for s_, w_ in ks)
            return num_ / den if den else None
        proe, dproe = roll(team, "poe", "n"), roll(opp, "dpoe", "dn")
        pace, dpace = roll(team, "sec", "np"), roll(opp, "dsec", "dnp")
        g_ = next((v for v in PB_G.values() if v["season"] == season and v["week"] == week and team in v["teams"]), None) or {}
        f_ = {"proe": proe if proe is not None else 0.0, "opp_proe_allowed": dproe if dproe is not None else 0.0,
              "pace": pace if pace is not None else 29.0, "opp_pace": dpace if dpace is not None else 29.0,
              "wind": g_.get("wind", 0.0), "temp": g_.get("temp", 65.0), "dome": g_.get("dome", 1.0)}
        f_["game_pace"] = (f_["pace"] + f_["opp_pace"]) / 2
        f_["wind_hi"] = 1.0 if f_["wind"] >= 15 else 0.0
        f_["cold"] = 1.0 if f_["temp"] <= 35 else 0.0
        return f_

    def cross(mkt, fid, nm, f, ln):
        o = XL.get((fid, nm), {})
        g = lambda m: o.get(m, (None, None))[0]
        out = {}
        ry, rcy, py, rec = g("player_rushing_yards"), g("player_receiving_yards"), g("player_passing_yards"), g("player_receptions")
        if mkt == "rush_rec_yds":
            out["x_parts"] = (ry or 0) + (rcy or 0) - ln if (ry is not None or rcy is not None) else 0.0
            out["x_has"] = float((ry is not None) + (rcy is not None))
        if mkt == "pass_rush_yds":
            out["x_parts"] = (py or 0) + (ry or 0) - ln if py is not None else 0.0
            out["x_has"] = float((py is not None) + (ry is not None))
        if mkt == "rec_yds":
            out["x_rec_ypr"] = rec * f["ypt"] / max(0.3, f["catch_rate"]) - ln if rec is not None else 0.0
            out["x_rec_line"] = rec or 0.0
            out["x_ypr_line"] = ln / rec if rec else 0.0
        if mkt == "rec":
            out["x_yds_line"] = rcy or 0.0
            out["x_ypc_implied"] = rcy / ln if rcy and ln else 0.0
        if mkt == "pass_td":
            out["x_pass_yds"] = py or 0.0
            out["x_att"] = g("player_passing_attempts") or 0.0
            out["x_td_per_100"] = 100 * ln / py if py else 0.0
        if mkt in ("pass_yds", "pass_att"):
            out["x_att"] = g("player_passing_attempts") or 0.0
            out["x_pass_yds"] = py or 0.0
        if mkt == "rush_yds":
            out["x_rec_yds"] = rcy or 0.0
        return out

    DATA = {}
    for mkt, (mid, stat, files) in MARKETS.items():
        if only and mkt not in only:
            continue
        S = []
        seen = set()
        for fn in files:
            if not os.path.exists(BT + fn):
                continue
            for fid, x in json.load(open(BT + fn)).items():
                if fid in seen and len(files) == 1:
                    continue
                h_, a_ = ab(x["home"]), ab(x["away"])
                d0 = (x.get("start") or "")[:10]
                if not d0:
                    continue
                g = None
                for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
                    g = next((y for y in by_day.get(dd, []) if ESPN2V.get(y["home"], y["home"]) == h_ and ESPN2V.get(y["away"], y["away"]) == a_), None) or g
                if not g:
                    continue
                gl = (games.get(fid) or {}).get("game") or x.get("game") or {}
                sp, tt = gl.get("point_spread") or {}, gl.get("total_points") or {}
                hk = next((k for k in sp if ab(k) == h_), None)
                if not hk or "over" not in tt or tt["over"]["o"][0] is None:
                    continue
                hsp, tot = sp[hk]["o"][0], tt["over"]["o"][0]
                env = {h_: ((tot - hsp) / 2, hsp, True), a_: ((tot + hsp) / 2, -hsp, False)}
                season, week = g["season"], g["week"]
                for nm, mk in (x.get("props") or {}).items():
                    v = mk.get(mid)
                    if not v or v["o"][0] is None or v["o"][1] is None or v["o"][2] is None:
                        continue
                    key = nk(nm)
                    team = next((t for t in (h_, a_) if (season, t, key) in by_name), None)
                    if not team:
                        team = next((t for t in (h_, a_) if (season - 1, t, key) in by_name), None)
                    if not team:
                        continue
                    pid = by_name.get((season, team, key)) or by_name.get((season - 1, team, key))
                    ln, po, pu = v["o"]
                    io, iu = L.implied(po), L.implied(pu)
                    if not (1.0 <= io + iu <= 1.15):
                        continue
                    game_row = next((r for r in by_pid[pid] if (r["season"], r["week"]) == (season, week)), None)
                    if game_row is not None:
                        act = game_row[stat]
                    elif snaps.get((season, week, team, key)):
                        act = 0.0
                    else:
                        continue      # did not play: void
                    if act == ln:
                        continue
                    opp = a_ if team == h_ else h_
                    imp, spr, home = env[team]
                    f = features(pid, season, week, team, opp, stat, ln, imp, spr, home)
                    if f is None:
                        continue
                    if "--cross" in sys.argv:
                        f.update(cross(mkt, fid, nm, f, ln))
                    if "--role" in sys.argv:
                        f.update(role(pid, season, week, team, g["date"]))
                    if "--pbp" in sys.argv:
                        f.update(pbp_feats(season, week, team, opp, g["date"]))
                    c = v.get("c") or [None, None, None]
                    S.append({"season": 2024 if g["date"] < "2025-03-01" else 2025 if g["date"] < "2026-03-01" else 2026, "date": g["date"], "p": io / (io + iu), "po": po, "pu": pu, "line_": ln,
                              "cl": c[0], "co": c[1], "cu": c[2],
                              "line": ln, "y": int(act > ln), "f": f,
                              **({"act": act, "pid": pid, "team": team, "opp": opp, "season_": season, "week": week, "env": (imp, spr, home)}
                                 if "--proj" in sys.argv else {})})
        DATA[mkt] = S
        print(f"{mkt}: {sum(1 for s in S if s['season'] == 2024)} lines 2024 (market), {sum(1 for s in S if s['season'] == 2025)} 2025, {sum(1 for s in S if s['season'] == 2026)} 2026")
    if "--proj" in sys.argv:      # hand the rows (with actuals) to tools/nfl_proj_test.py
        return DATA, IX
    if "--select" not in sys.argv:
        screen(DATA)
    select_and_test(DATA)
    return DATA


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def fit(X, y, ridge=1.0, iters=30):
    """Logistic regression by Newton's method; X rows include the intercept."""
    k = len(X[0])
    w = [0.0] * k
    for _ in range(iters):
        g = [0.0] * k
        H = [[0.0] * k for _ in range(k)]
        for xi, yi in zip(X, y):
            z = sum(a * b for a, b in zip(w, xi))
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            r = p - yi
            for a in range(k):
                g[a] += r * xi[a]
                for b in range(k):
                    H[a][b] += p * (1 - p) * xi[a] * xi[b]
        for a in range(1, k):
            g[a] += ridge * w[a]
            H[a][a] += ridge
        # solve H d = g
        M = [row[:] + [gv] for row, gv in zip(H, g)]
        for c in range(k):
            piv = max(range(c, k), key=lambda r: abs(M[r][c]))
            M[c], M[piv] = M[piv], M[c]
            if abs(M[c][c]) < 1e-12:
                return w
            for r in range(k):
                if r != c:
                    fct = M[r][c] / M[c][c]
                    for cc in range(c, k + 1):
                        M[r][cc] -= fct * M[c][cc]
        d = [M[i][k] / M[i][i] for i in range(k)]
        w = [a - b for a, b in zip(w, d)]
        if max(abs(x) for x in d) < 1e-7:
            break
    return w


def ll(w, X, y):
    t = 0.0
    for xi, yi in zip(X, y):
        z = sum(a * b for a, b in zip(w, xi))
        p = 1 / (1 + math.exp(-max(-30, min(30, z))))
        t += -math.log(p if yi else 1 - p)
    return t / len(y)


def screen(DATA, out_path="bt/nfl_screen.json"):
    out = {}
    for mkt, S in DATA.items():
        TRAIN = {int(x) for x in ([a.split("=", 1)[1] for a in sys.argv if a.startswith("--train=")] or ["2025"])[0].split(",")}
        tr = [s for s in S if s["season"] in TRAIN]
        te = [s for s in S if s["season"] == 2026]
        if len(tr) < 150 or len(te) < 60:
            print(f"\n{mkt}: too few lines to screen ({len(tr)} / {len(te)})")
            continue
        ytr, yte = [s["y"] for s in tr], [s["y"] for s in te]
        Xb_tr = [[1.0, logit(s["p"])] for s in tr]
        Xb_te = [[1.0, logit(s["p"])] for s in te]
        wb = fit(Xb_tr, ytr)
        base_tr, base_te = ll(wb, Xb_tr, ytr), ll(wb, Xb_te, yte)
        raw_te = sum(-math.log(s["p"] if s["y"] else 1 - s["p"]) for s in te) / len(te)
        rows = []
        for fk in tr[0]["f"]:
            vals = [s["f"].get(fk, 0.0) for s in tr]
            mu = sum(vals) / len(vals)
            sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1.0
            z = lambda s: (s["f"].get(fk, 0.0) - mu) / sd
            Xtr = [[1.0, logit(s["p"]), z(s)] for s in tr]
            Xte = [[1.0, logit(s["p"]), z(s)] for s in te]
            w = fit(Xtr, ytr)
            w26 = fit(Xte, yte)
            d_te = (ll(w, Xte, yte) - base_te) * 1000
            d_tr = (ll(w, Xtr, ytr) - base_tr) * 1000
            rows.append((d_te, fk, w[2], w26[2], d_tr))
        rows.sort()
        out[mkt] = rows
        print(f"\n== {mkt}: {len(tr)} lines 2025 / {len(te)} 2026 · Onyx-only log loss 2026 {base_te:.4f} (raw no-vig {raw_te:.4f}); "
              f"over rate {sum(yte)/len(yte):.3f}")
        print("   feature          2026 change  2025 change  coef 2025  coef 2026")
        for d_te, fk, c25, c26, d_tr in rows[:10]:
            same = "same sign" if c25 * c26 > 0 else "FLIPS"
            print(f"   {fk:16s} {d_te:+8.2f}     {d_tr:+8.2f}    {c25:+.3f}    {c26:+.3f}  {same}")
    json.dump({m: [list(r) for r in rows] for m, rows in out.items()}, open(out_path.replace(".json", "_pbp.json") if "--pbp" in sys.argv else out_path, "w"))



def select_and_test(DATA, k_max=4, out="bt/nfl_select.json"):
    """Pick features on 2025 alone (forward selection, judged on the second half of
    2025 after fitting on the first), then fit on all of 2025 and judge on 2026:
    log loss against Onyx and value bets at the opening price."""
    res = {}
    for mkt, S in DATA.items():
        TRAIN = {int(x) for x in ([a.split("=", 1)[1] for a in sys.argv if a.startswith("--train=")] or ["2025"])[0].split(",")}
        tr = sorted([s for s in S if s["season"] in TRAIN], key=lambda s: s.get("date", ""))
        TEST = int(([a.split("=", 1)[1] for a in sys.argv if a.startswith("--test=")] or ["2026"])[0])
        te = [s for s in S if s["season"] == TEST]
        if len(tr) < 150 or len(te) < 60:
            continue
        keys = list(tr[0]["f"])
        stats_ = {}
        for fk in keys:
            vals = [s["f"].get(fk, 0.0) for s in tr]
            mu = sum(vals) / len(vals)
            sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1.0
            stats_[fk] = (mu, sd)
        X = lambda ss, fs: [[1.0, logit(s["p"])] + [(s["f"].get(f, 0.0) - stats_[f][0]) / stats_[f][1] for f in fs] for s in ss]
        y = lambda ss: [s["y"] for s in ss]
        half = len(tr) // 2
        a, b = tr[:half], tr[half:]
        R = 5.0      # stronger ridge: shrink every feature toward "no effect"

        def cv(fs):   # both directions: fit on one half of 2025, judge on the other
            return (ll(fit(X(a, fs), y(a), R), X(b, fs), y(b)) + ll(fit(X(b, fs), y(b), R), X(a, fs), y(a))) / 2

        def each_half(fs, base_a, base_b):
            return (ll(fit(X(a, fs), y(a), R), X(b, fs), y(b)) < base_b - 0.0003 and
                    ll(fit(X(b, fs), y(b), R), X(a, fs), y(a)) < base_a - 0.0003)
        chosen = []
        best = cv([])
        for _ in range(k_max):
            base_b = ll(fit(X(a, chosen), y(a), R), X(b, chosen), y(b))
            base_a = ll(fit(X(b, chosen), y(b), R), X(a, chosen), y(a))
            cand = None
            for fk in keys:
                if fk in chosen or not each_half(chosen + [fk], base_a, base_b):
                    continue
                v = cv(chosen + [fk])
                if cand is None or v < cand[0]:
                    cand = (v, fk)
            if cand and cand[0] < best - 0.0005:
                best = cand[0]
                chosen.append(cand[1])
            else:
                break
        forced = [x.split("=", 1)[1] for x in sys.argv if x.startswith("--force=")]
        if forced:      # judge a fixed set of statistics (chosen by the screen) instead of selecting
            chosen = [k for k in forced[0].split(",") if k in keys]
        w = fit(X(tr, chosen), y(tr), R)
        wb = fit(X(tr, []), y(tr))
        base = ll(wb, X(te, []), y(te))
        mdl = ll(w, X(te, chosen), y(te))
        raw = sum(-math.log(s["p"] if s["y"] else 1 - s["p"]) for s in te) / len(te)

        def bets(ss, edge, close=False):
            Xs = X(ss, chosen)
            out = {}
            for side in ("over", "under"):
                n = wn = 0
                u = 0.0
                for s, xi in zip(ss, Xs):
                    z = sum(c * d for c, d in zip(w, xi))
                    p = 1 / (1 + math.exp(-z))
                    if close:     # the same model judged at Onyx's closing price, where the closing line is the opening one
                        if s.get("cl") != s.get("line_") or s.get("co") is None or s.get("cu") is None:
                            continue
                        pr, price = (p, s["co"]) if side == "over" else (1 - p, s["cu"])
                    else:
                        pr, price = (p, s["po"]) if side == "over" else (1 - p, s["pu"])
                    if pr - L.implied(price) >= edge:
                        won = (s["y"] == 1) == (side == "over")
                        n += 1
                        wn += won
                        u += (price / 100 if price > 0 else 100 / -price) if won else -1
                out[side] = (wn, n - wn, round(100 * u / n, 1) if n else None)
            return out
        res[mkt] = {"features": chosen, "coef": [round(c, 3) for c in w[2:]], "ll_2026": round(mdl, 4), "onyx_2026": round(raw, 4),
                    "onyx_refit_2026": round(base, 4), "bets_2025_3pp": bets(tr, 0.03), "bets_2026_3pp": bets(te, 0.03),
                    "bets_2026_5pp": bets(te, 0.05), "n": (len(tr), len(te))}
        r = res[mkt]
        r["bets_2025_close"], r["bets_2026_close"] = bets(tr, 0.03, True), bets(te, 0.03, True)
        # the production spec: features chosen on 2025, coefficients refit on both seasons
        allS = tr + te
        r["spec"] = {"features": chosen, "mu": [stats_[f][0] for f in chosen], "sd": [stats_[f][1] for f in chosen],
                     "w": fit(X(allS, chosen), y(allS), R)}
        # edge buckets with the production spec's selection weights (fit on 2025): do bigger gaps win more?
        def buckets(ss):
            Xs = X(ss, chosen)
            out = {}
            for s, xi in zip(ss, Xs):
                p = 1 / (1 + math.exp(-sum(c * d for c, d in zip(w, xi))))
                for side, pr, price in (("over", p, s["po"]), ("under", 1 - p, s["pu"])):
                    e = pr - L.implied(price)
                    if e < 0.03:
                        continue
                    bk = "3-5" if e < .05 else "5-8" if e < .08 else "8-12" if e < .12 else "12+"
                    won = (s["y"] == 1) == (side == "over")
                    o = out.setdefault(side, {}).setdefault(bk, [0, 0, 0.0])
                    o[0] += won; o[1] += 1 - won; o[2] += (price / 100 if price > 0 else 100 / -price) if won else -1
            return {sd: {bk: (v[0], v[1], round(100 * v[2] / (v[0] + v[1]), 1)) for bk, v in d.items()} for sd, d in out.items()}
        r["buckets"] = {"2025": buckets(tr), "2026": buckets(te)}
        print(f"\n## {mkt}  chose {chosen} coef {r['coef']}")
        print(f"   edge buckets 2025 {r['buckets']['2025']}\n   edge buckets 2026 {r['buckets']['2026']}")
        print(f"   3pp+ at the CLOSE (same line as open): 2025 {r['bets_2025_close']}  2026 {r['bets_2026_close']}")
        print(f"   2026 log loss: model {mdl:.4f} vs Onyx {raw:.4f} (Onyx refit {base:.4f})")
        print(f"   2025 (fit) 3pp+: {r['bets_2025_3pp']}")
        print(f"   2026 (unseen) 3pp+: {r['bets_2026_3pp']}   5pp+: {r['bets_2026_5pp']}")
    tag = "_cross" if "--cross" in sys.argv else "_role" if "--role" in sys.argv else "_pbp" if "--pbp" in sys.argv else ""
    tag += "_3y" if any(a.startswith("--train=") for a in sys.argv) else ""
    json.dump(res, open(out.replace(".json", tag + ".json"), "w"), indent=1)
    return res


if __name__ == "__main__":
    main()
