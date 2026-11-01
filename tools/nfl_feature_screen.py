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

BT = "bt/"
MARKETS = {   # our key: (Onyx market id, nflverse stat column or derived, line files)
    "rec": ("player_receptions", "receptions", ["nfl_lines.json"]),
    "rec_yds": ("player_receiving_yards", "receiving_yards", ["nfl_lines.json"]),
    "rush_yds": ("player_rushing_yards", "rushing_yards", ["nfl_lines.json"]),
    "pass_yds": ("player_passing_yards", "passing_yards", ["nfl_lines.json"]),
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


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def num(x):
    try:
        return float(x) if x not in ("", "NA", None) else 0.0
    except ValueError:
        return 0.0


def load_stats():
    """nflverse weekly player stats, regular + post season, keyed for lookups."""
    rows = []
    for y in (2024, 2025, 2026):
        for p in (f"{BT}nflv/stats_player_week_{y}.csv", f"{BT}nfl24/stats_player_week_{y}.csv"):
            if os.path.exists(p):
                for r in csv.DictReader(open(p)):
                    g = {k: num(r.get(k)) for k in ("completions", "attempts", "passing_yards", "passing_tds", "passing_epa",
                         "passing_cpoe", "passing_air_yards", "sacks_suffered", "carries", "rushing_yards", "rushing_tds",
                         "rushing_epa", "receptions", "targets", "receiving_yards", "receiving_tds", "receiving_air_yards",
                         "receiving_yards_after_catch", "receiving_epa", "target_share", "air_yards_share", "wopr", "racr")}
                    g["rush_rec_yds"] = g["rushing_yards"] + g["receiving_yards"]
                    g["pass_rush_yds"] = g["passing_yards"] + g["rushing_yards"]
                    g.update(season=int(r["season"]), week=int(r["week"]), team=r["team"], opp=r["opponent_team"],
                             pid=r["player_id"], key=nk(r["player_display_name"]), pos=r.get("position_group") or r.get("position"))
                    rows.append(g)
                break
    rows.sort(key=lambda g: (g["season"], g["week"]))
    return rows


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    stats = load_stats()
    by_pid = defaultdict(list)
    by_name = {}
    team_wk = defaultdict(lambda: defaultdict(float))     # (season, week, team) -> team totals
    opp_wk = defaultdict(lambda: defaultdict(float))      # (season, week, defense) -> allowed totals
    for g in stats:
        by_pid[g["pid"]].append(g)
        by_name[(g["season"], g["team"], g["key"])] = g["pid"]
        t = team_wk[(g["season"], g["week"], g["team"])]
        o = opp_wk[(g["season"], g["week"], g["opp"])]
        for k in ("attempts", "carries", "targets", "passing_yards", "rushing_yards", "receiving_yards", "passing_epa",
                  "rushing_epa", "receptions", "passing_tds", "sacks_suffered"):
            t[k] += g[k]
            o[k] += g[k]
        o["n_" + (g["pos"] or "x")] += 0   # touch
        if g["pos"] in ("WR", "TE", "RB"):
            o["rec_yds_" + g["pos"]] += g["receiving_yards"]
            o["rec_" + g["pos"]] += g["receptions"]
    snaps = {}
    vj = json.load(open("data/nfl/nflverse.json"))
    for yr, xv in (vj.get("seasons") or {}).items():
        for s_, w_, t_, n_, pct in xv.get("snaps") or []:
            snaps[(s_, w_, t_, n_)] = pct
    res = json.load(open("data/nfl/results.json"))["games"]
    wk_of = {}
    for r in json.load(open("data/nfl/player_games.json"))["rows"]:
        wk_of[r["gid"]] = (r["season"], r["week"])
    res = [dict(g, season=wk_of[g["id"]][0], week=wk_of[g["id"]][1]) for g in res if g.get("id") in wk_of]
    by_day = defaultdict(list)
    for g in res:
        by_day[g["date"]].append(g)
    games = json.load(open(BT + "nfl_game.json"))
    ESPN2V = {"WSH": "WAS", "LAR": "LA"}
    ab = lambda s: NICK.get((s or "").split()[-1])

    def hist(pid, season, week, n=None):
        h = [g for g in by_pid.get(pid, []) if (g["season"], g["week"]) < (season, week)]
        return h[-n:] if n else h

    def team_hist(team, season, week, n=4):
        ks = sorted((s, w) for (s, w, t) in team_wk if t == team and (s, w) < (season, week))[-n:]
        return [team_wk[(s, w, team)] for s, w in ks]

    def opp_hist(team, season, week, n=6):
        ks = sorted((s, w) for (s, w, t) in opp_wk if t == team and s == season and w < week)[-n:]
        return [opp_wk[(s, w, team)] for s, w in ks]

    league = {}

    def lg(season, week, k):
        key = (season, week, k)
        if key not in league:
            vals = [d[k] for (s, w, t), d in opp_wk.items() if s == season and w < week]
            league[key] = (sum(vals) / len(vals)) if vals else 0.0
        return league[key]

    def mean(xs):
        return sum(xs) / len(xs) if xs else 0.0

    def features(pid, season, week, team, opp, stat, line, imp, spread, home):
        h = hist(pid, season, week)
        cur = [g for g in h if g["season"] == season]
        l3, l5, l8 = h[-3:], h[-5:], h[-8:]
        if len(h) < 2:
            return None
        v = lambda gs, k: mean([g[k] for g in gs])
        sd8 = (sum((g[stat] - v(l8, stat)) ** 2 for g in l8) / max(1, len(l8) - 1)) ** 0.5 if len(l8) > 1 else 0.0
        th = team_hist(team, season, week)
        oh = opp_hist(opp, season, week)
        f = {
            "l3": v(l3, stat), "l5": v(l5, stat), "season": v(cur, stat) if cur else v(l8, stat),
            "line_vs_l5": line - v(l5, stat), "line_vs_season": line - (v(cur, stat) if cur else v(l8, stat)),
            "line_z": (line - v(l8, stat)) / sd8 if sd8 > 0 else 0.0,
            "trend": v(l3, stat) - v(l8, stat), "sd8": sd8, "cv8": sd8 / v(l8, stat) if v(l8, stat) else 0.0,
            "tgt_share": v(l5, "target_share"), "air_share": v(l5, "air_yards_share"), "wopr": v(l5, "wopr"),
            "tgt_l3": v(l3, "targets"), "tgt_trend": v(l3, "targets") - v(l8, "targets"),
            "adot": (sum(g["receiving_air_yards"] for g in l8) / max(1.0, sum(g["targets"] for g in l8))),
            "yac_rec": (sum(g["receiving_yards_after_catch"] for g in l8) / max(1.0, sum(g["receptions"] for g in l8))),
            "catch_rate": (sum(g["receptions"] for g in l8) / max(1.0, sum(g["targets"] for g in l8))),
            "ypt": (sum(g["receiving_yards"] for g in l8) / max(1.0, sum(g["targets"] for g in l8))),
            "rec_epa_t": (sum(g["receiving_epa"] for g in l8) / max(1.0, sum(g["targets"] for g in l8))),
            "racr": v(l5, "racr"),
            "carries_l3": v(l3, "carries"), "ypc": (sum(g["rushing_yards"] for g in l8) / max(1.0, sum(g["carries"] for g in l8))),
            "rush_epa_c": (sum(g["rushing_epa"] for g in l8) / max(1.0, sum(g["carries"] for g in l8))),
            "carry_share": mean([g["carries"] / max(1.0, team_wk[(g["season"], g["week"], g["team"])]["carries"]) for g in l5]),
            "att_l3": v(l3, "attempts"), "pass_epa_db": (sum(g["passing_epa"] for g in l8) / max(1.0, sum(g["attempts"] + g["sacks_suffered"] for g in l8))),
            "cpoe": v(l8, "passing_cpoe"), "pass_adot": (sum(g["passing_air_yards"] for g in l8) / max(1.0, sum(g["attempts"] for g in l8))),
            "team_pass_rate": mean([t["attempts"] / max(1.0, t["attempts"] + t["carries"]) for t in th]) if th else 0.0,
            "team_plays": mean([t["attempts"] + t["carries"] for t in th]) if th else 0.0,
            "implied": imp, "spread": spread, "home": 1.0 if home else 0.0, "week": float(week),
            "opp_pass_yds": (mean([o["passing_yards"] for o in oh]) / lg(season, week, "passing_yards")) if oh and lg(season, week, "passing_yards") else 1.0,
            "opp_rush_yds": (mean([o["rushing_yards"] for o in oh]) / lg(season, week, "rushing_yards")) if oh and lg(season, week, "rushing_yards") else 1.0,
            "opp_rec": (mean([o["receptions"] for o in oh]) / lg(season, week, "receptions")) if oh and lg(season, week, "receptions") else 1.0,
            "opp_pass_epa": mean([o["passing_epa"] / max(1.0, o["attempts"]) for o in oh]) if oh else 0.0,
            "opp_rush_epa": mean([o["rushing_epa"] / max(1.0, o["carries"]) for o in oh]) if oh else 0.0,
            "opp_sacks": mean([o["sacks_suffered"] for o in oh]) if oh else 0.0,
            "games_played": float(len(cur)),
        }
        sn = [snaps.get((g["season"], g["week"], g["team"], g["key"]), None) for g in l5]
        sn = [x for x in sn if x is not None]
        f["snap_avg"] = mean(sn)
        f["snap_last"] = sn[-1] if sn else 0.0
        f["snap_trend"] = (sn[-1] - mean(sn)) if sn else 0.0
        if h:
            last = h[-1]
            gap = (season - last["season"]) * 20 + (week - last["week"])
            f["weeks_since"] = float(gap)
        return f

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
                gl = (games.get(fid) or {}).get("game") or {}
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
                    S.append({"season": 2025 if g["date"] < "2026-03-01" else 2026, "date": g["date"], "p": io / (io + iu), "po": po, "pu": pu,
                              "line": ln, "y": int(act > ln), "f": f})
        DATA[mkt] = S
        print(f"{mkt}: {sum(1 for s in S if s['season'] == 2025)} lines 2025, {sum(1 for s in S if s['season'] == 2026)} 2026")
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


def screen(DATA):
    out = {}
    for mkt, S in DATA.items():
        tr = [s for s in S if s["season"] == 2025]
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
    json.dump({m: [list(r) for r in rows] for m, rows in out.items()}, open("bt/nfl_screen.json", "w"))



def select_and_test(DATA, k_max=4):
    """Pick features on 2025 alone (forward selection, judged on the second half of
    2025 after fitting on the first), then fit on all of 2025 and judge on 2026:
    log loss against Onyx and value bets at the opening price."""
    res = {}
    for mkt, S in DATA.items():
        tr = sorted([s for s in S if s["season"] == 2025], key=lambda s: s.get("date", ""))
        te = [s for s in S if s["season"] == 2026]
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
        w = fit(X(tr, chosen), y(tr), R)
        wb = fit(X(tr, []), y(tr))
        base = ll(wb, X(te, []), y(te))
        mdl = ll(w, X(te, chosen), y(te))
        raw = sum(-math.log(s["p"] if s["y"] else 1 - s["p"]) for s in te) / len(te)

        def bets(ss, edge):
            Xs = X(ss, chosen)
            out = {}
            for side in ("over", "under"):
                n = wn = 0
                u = 0.0
                for s, xi in zip(ss, Xs):
                    z = sum(c * d for c, d in zip(w, xi))
                    p = 1 / (1 + math.exp(-z))
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
        print(f"\n## {mkt}  chose {chosen} coef {r['coef']}")
        print(f"   2026 log loss: model {mdl:.4f} vs Onyx {raw:.4f} (Onyx refit {base:.4f})")
        print(f"   2025 (fit) 3pp+: {r['bets_2025_3pp']}")
        print(f"   2026 (unseen) 3pp+: {r['bets_2026_3pp']}   5pp+: {r['bets_2026_5pp']}")
    json.dump(res, open("bt/nfl_select.json", "w"), indent=1)
    return res


if __name__ == "__main__":
    main()
