#!/usr/bin/env python3
"""
picks_replays.py - more replays of the live site's chance for tools/picks_backtest.py. Dev only.

Every Onyx line is read through tools/picks_lines.lines (the committed data/picks/lines/<sport>.json,
merged with the local bt/ caches when present), so these run on a fresh checkout too.

Each function rebuilds, walk-forward, the exact chance a live build would show for one
market (the same module, the same parameters, the same blend with Onyx's price), and hands
every priced side to picks_backtest.cand / .market, so the one pick rule (daily_top.ok), the
card (one per player or game market a day, best expected return first, picks.CAP a day) and
the finalize test are the same as every other market.

  nba h1_total     50.5% of Onyx's game total, sd 18 (nba_build's qhCard read), Onyx 1st-half
                   lines (data/picks/lines/nba.json), graded off ESPN's official line scores
  tennis games     tennis_model v2 games_markets on the walk-forward Elo chance, blended at the
                   live tennis weight, Onyx total-games and game-spread lines
                   (bt/tennis_*_games.json), graded off the final games (bt/tennis_results_full.json)
  nfl rec          nfl_model v5/v6 receptions: the v4 volume projection averaged with the
                   nflverse projection, blended 50% with Onyx, unders only (TRIAL_SIDES), from
                   ESPN box scores (data/nfl/player_games.json) and nflverse (data/nfl/nflverse.json)
                   known before the game, Onyx's opening spread and total (bt/nfl_game.json)
  cfb props        cfb_players: v1 projections (receptions, receiving and passing yards, 30% blend,
                   the live role guard) and the v2 rushing-yards market model, ESPN box scores
                   (data/cfb/player_games.json), Onyx college props (bt/cfb_props.json)
  cbb props        tools/cbb_props_backtest.py: the cbb_stats preseason projection (2024-25 only) blended
                   with this season's games, negative binomial chance, blended per stat with Onyx's over
                   price (over only in 2025-26), ESPN box scores (bt/cbb_box_2026.json); without bt/ the
                   2025-26 card comes from data/picks/lines/cbb_props_frozen.json while its signature matches
"""
import json, math, os, sys
from collections import defaultdict
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "tools"))
import sports_lab as L      # noqa: E402
import picks_lines as PL    # noqa: E402  data/picks/lines (committed), merged with bt/ when present


def _pb():
    import picks_backtest as PB
    return PB


# ── NBA 1st-half total ───────────────────────────────────────────────────────────
def nba_h1():
    from statistics import NormalDist
    from nba_common import team_abbr
    from picks_lines import et_day
    PB = _pb()
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
        q, t = gm.get("1st_half_total_points") or {}, gm.get("total_points") or {}
        if not g or g.get("h1") is None or "over" not in q or "under" not in q or "over" not in t:
            continue
        for when, dst in (("o", ro), ("c", rc)):
            ln, po = q["over"][when]
            pu = q["under"][when][1]
            tot = t["over"][when][0]
            if ln is None or tot is None or po is None or pu is None or g["h1"] == ln:
                continue
            pov = 1 - NormalDist(tot * 0.505, 18).cdf(ln)
            for side, p, price in (("over", pov, po), ("under", 1 - pov, pu)):
                dst.append(PB.cand(d, (fid, "h1"), side, p, price, (g["h1"] > ln) == (side == "over"), mk=("nba", "h1_total")))
    # the 50.5% share and sd 18 were tuned on Oct-Jan 2025-26 (README, qhCard): held out from Feb, as the 1Q total
    return [PB.market("nba", "h1_total", "h1 0.505/18", "50.5% of Onyx's game total, normal sd 18 (nba_build)",
                      "Onyx lines (data/picks/lines/nba.json), ESPN official 1st-half line scores", "2026-02-01", ro, rc,
                      held="Feb 2026 on: Feb to Jun 2026 and 2026-27 to date (the 50.5% share and sd 18 were tuned on Oct 2025 to Jan 2026)",
                      notes="Its own tuned rule (daily_top.MKT_RULE, 11/6): unders only, edge 4 to 16 points, price -150 to +200.")]


# ── tennis games markets (tennis_model v2) ────────────────────────────────────────
def _games_dist(TM, p_win, tour, event, P=None):
    """tennis_model.games_markets, returning the (games, margin for player 0) distribution once."""
    P = P or TM.GAME_P
    need = 3 if tour == "ATP" and any(s in (event or "").lower() for s in TM.SLAM_BO5) else 2
    base = P["base_wta"] if tour == "WTA" else P["base_atp"]
    sg = P["form"]

    def mix(d):
        return [[base + d + sg, base - d - sg], [base + d - sg, base - d + sg]]
    lo, hi = -0.3, 0.3
    for _ in range(18):
        d = (lo + hi) / 2
        pw = sum(TM._match(pt, need)[0] for pt in mix(d)) / 2
        lo, hi = (d, hi) if pw < p_win else (lo, d)
    dist = {}
    for pt in mix((lo + hi) / 2):
        for k, p in TM._match(pt, need)[1].items():
            dist[k] = dist.get(k, 0) + p / 2
    return dist


def tennis_games():
    import tennis_model as TM
    import sports_backtest as SB
    from sports_common import nk
    PB = _pb()
    files = [f for f in ("bt/tennis_atp_games.json", "bt/tennis_wta_games.json") if os.path.exists(f)]
    if not files or not os.path.exists("bt/tennis_results_full.json"):
        return []
    cache = "bt/picks_tennis_games.json"
    if os.path.exists(cache):
        S = json.load(open(cache))
    else:
        allm = json.load(open("bt/tennis_results_full.json"))
        lines = {}
        for f in files:
            lines.update({k: v for k, v in json.load(open(f)).items() if v.get("game")})
        by_pair = {}
        for m in allm:
            by_pair.setdefault((m["date"], frozenset((nk(m["w"]), nk(m["l"])))), m)
        want = defaultdict(list)
        for fid, x in lines.items():
            a, b = nk(x["home"]), nk(x["away"])
            d0 = (x["start"] or "")[:10]
            if not d0:
                continue
            for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat(), (date.fromisoformat(d0) + timedelta(days=1)).isoformat()):
                m = by_pair.get((dd, frozenset((a, b))))
                if m:
                    want[m["id"]].append((fid, x, a, b))
                    break
        E = TM.Elo(TM.P)
        S = []
        for m in allm:
            for fid, x, a, b in want.get(m["id"], []):
                if not (E.known(a) and E.known(b)) or m.get("games_w") is None:
                    continue
                p0 = E.p(a, b)
                dist = _games_dist(TM, p0, m.get("tour"), m.get("event"))
                gw, gl = m["games_w"], m["games_l"]
                tot, mar = gw + gl, (gw - gl) if nk(m["w"]) == a else (gl - gw)
                gm = x["game"]
                for when in ("o", "c"):
                    tg = gm.get("total_games") or {}
                    if "over" in tg and "under" in tg:
                        ln, po = tg["over"][when]
                        ln2, pu = tg["under"][when]
                        if ln is not None and ln == ln2 and SB.sane(po, pu) and tot != ln:
                            pov = sum(p for (g, _), p in dist.items() if g > ln)
                            S.append({"date": m["date"], "gid": fid, "mkt": "total_games", "when": when, "p": pov,
                                      "over": po, "under": pu, "y": 1 if tot > ln else 0})
                    sp = gm.get("game_spread") or {}
                    ka = next((k for k in sp if nk(k) == a), None)
                    kb = next((k for k in sp if nk(k) == b), None)
                    if ka and kb:
                        s0, pa = sp[ka][when]
                        pb = sp[kb][when][1]
                        if s0 is not None and SB.sane(pa, pb) and mar + s0 != 0:
                            pc = sum(p for (_, d), p in dist.items() if d + s0 > 0)
                            S.append({"date": m["date"], "gid": fid, "mkt": "game_spread", "when": when, "p": pc,
                                      "over": pa, "under": pb, "y": 1 if mar + s0 > 0 else 0})
            E.update(nk(m["w"]), nk(m["l"]), m.get("event"))
        json.dump(S, open(cache, "w"))
    bt = json.load(open("data/tennis/backtest.json"))
    w = (bt.get("lane") or {}).get("w") or 0.3
    out = []
    for mk in ("total_games", "game_spread"):
        ro, rc = [], []
        for r in S:
            if r["mkt"] != mk:
                continue
            ps = L.price_side(r["p"], r["over"], r["under"], w)
            if not ps:
                continue
            c = PB.cand(r["date"], (r["gid"], mk), ps["side"], ps["prob"], ps["price"], (r["y"] == 1) == (ps["side"] == "over"))
            (ro if r["when"] == "o" else rc).append(c)
        out.append(PB.market("tennis", mk, TM.VERSION, f"Elo games model (v2) blended {round(w * 100)}% with Onyx's no-vig price",
                             "bt/tennis_*_games.json (Onyx), ATP/WTA final games", SB.SPLIT["tennis"], ro, rc,
                             held="2026 matches (Elo tuned on 2025; GAME_P form set on 10/29/2026 against Onyx's own prices, not results)",
                             notes="picks.py has no tennis grader yet, so a pass here would still need one before tennis is logged."))
    return out


# ── NFL receptions (nfl_model v5 / v6 volume + nflverse, unders) ──────────────────
def nfl_rec():
    import nfl_model as M
    import nfl_feature_screen as NFS
    from sports_common import nk
    PB = _pb()
    lines = PL.lines("nfl", "bt/nfl_lines.json")
    if not lines or not os.path.exists("data/nfl/player_games.json"):
        return []
    rows = json.load(open("data/nfl/player_games.json"))["rows"]
    vidx = M.verse_index(json.load(open("data/nfl/nflverse.json")))
    games = PL.lines("nfl", "bt/nfl_game.json")
    by_game = defaultdict(list)
    for r in rows:
        by_game[r["gid"]].append(r)
    g_of = {}
    for gid, rs in by_game.items():
        r = rs[0]
        teams = {x["team"] for x in rs}
        g_of[(r["date"], frozenset(teams))] = (gid, r["season"], r["week"])
    ab = lambda s: NFS.NICK.get((s or "").split()[-1])
    V2E = {"WAS": "WSH", "LA": "LAR"}
    _, _, SN = vidx
    ro, rc = [], []
    nlines = nvoid = 0
    for fid, x in lines.items():
        h_, a_ = ab(x["home"]), ab(x["away"])
        h_, a_ = V2E.get(h_, h_), V2E.get(a_, a_)
        d0 = (x.get("start") or "")[:10]
        if not d0 or not h_ or not a_:
            continue
        hit = None
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
            hit = g_of.get((dd, frozenset((h_, a_)))) or hit
        if not hit:
            continue
        gid, season, week = hit
        gdate = by_game[gid][0]["date"]
        gl = (games.get(fid) or {}).get("game") or x.get("game") or {}
        sp, tt = gl.get("point_spread") or {}, gl.get("total_points") or {}
        hk = next((k for k in sp if V2E.get(ab(k), ab(k)) == h_), None)
        if not hk or "over" not in tt or tt["over"]["o"][0] is None or sp[hk]["o"][0] is None:
            continue
        hsp, tot = sp[hk]["o"][0], tt["over"]["o"][0]
        env = {h_: ((tot - hsp) / 2, hsp), a_: ((tot + hsp) / 2, -hsp)}     # the live team_env: (implied points, spread)
        prior = [r for r in rows if r["date"] < gdate]
        ph, th = M.volume_history(prior)
        name_pid = {}
        for r in prior:
            if r["team"] in (h_, a_):
                name_pid[(r["team"], nk(r["name"]))] = r["pid"]
        box = {(r["team"], nk(r["name"])): r for r in by_game[gid]}
        for nm, mk in (x.get("props") or {}).items():
            v = mk.get("player_receptions")
            if not v or v["o"][0] is None:
                continue
            key = nk(nm)
            team = next((t for t in (h_, a_) if (t, key) in name_pid), None)
            if not team:
                continue
            pid = name_pid[(team, key)]
            pv = M.project_volume("rec", ph.get(pid, []), th.get(team, []), *env[team])
            if pv is None:
                continue
            wk_v = week                 # player_games holds regular-season weeks only
            pvv = M.project_verse(vidx, team, nm, season, wk_v, *env[team])
            if pvv is not None:
                pv = M.VERSE_P["w"] * pvv + (1 - M.VERSE_P["w"]) * pv
            b = box.get((team, key))
            if b is not None:
                act = b.get("rec") or 0.0
            else:
                vt = M.VERSE_TEAM.get(team, team)
                sn = [p for k_, p in SN.get((vt, M._vk(nm)), []) if k_ == season * 100 + wk_v]
                if sn and sn[0] > 0:
                    act = 0.0           # snaps, no catch: the under wins (as Onyx and the trial lane grade it)
                else:
                    nvoid += 1
                    continue            # did not play: void
            nlines += 1
            for when, dst in (("o", ro), ("c", rc)):
                ln, po, pu = v[when]
                if ln is None or po is None or pu is None or act == ln:
                    continue
                if when == "c" and ln != v["o"][0]:
                    continue            # the close only where the line held (as the v11 rows)
                ps = L.price_side(M.prob_over_volume("rec", pv, ln), po, pu, M.VOL_P["rec"]["w"])
                if not ps or ps["side"] not in M.TRIAL_SIDES:
                    continue            # v6: overs are never a play (value_min 1.0)
                dst.append(PB.cand(gdate, (gid, pid), ps["side"], ps["prob"], ps["price"], (act > ln) == (ps["side"] == "over")))
    print(f"  nfl rec: {nlines} priced player-games graded, {nvoid} voids")
    return [PB.market("nfl", "rec", M.VERSION, "volume + nflverse projection blended 50% with Onyx's no-vig price (unders only)",
                      "data/nfl/player_games.json + nflverse.json (known before kickoff), bt/nfl_lines.json (Onyx open and close)",
                      "2026-03-01", ro, rc, held="2026 season (v4 / v5 parameters and the unders-only rule chosen on 2025)",
                      notes="Close only where the closing line equals the opening line. Players with snaps and no catch count as 0.")]


# ── college football player props (cfb_players v1 projections, v2 rushing yards) ──
def cfb_props():
    import cfb_players as C
    import nfl_model as N
    from sports_common import nk
    PB = _pb()
    props = PL.lines("cfb", "bt/cfb_props.json")
    if not props or not os.path.exists("data/cfb/player_games.json"):
        return []
    rows = json.load(open("data/cfb/player_games.json"))["rows"]
    lines = PL.lines("cfb", "bt/cfb_lines.json")
    by_day_name = {(r["date"], nk(r["name"])): r for r in rows}
    by = N._games_by_player(rows)
    MI = C.MarketIndex(rows)
    allowed = N._team_allowed(rows)
    lgc = {}
    MID = {"rec": "player_receptions", "rec_yds": "player_receiving_yards", "rush_yds": "player_rushing_yards",
           "pass_yds": "player_passing_yards"}
    R = {s: ([], []) for s in MID}
    for fid, x in props.items():
        gl = (lines.get(fid) or x).get("game") or {}
        sp, tt = gl.get("point_spread") or {}, gl.get("total_points") or {}
        d0 = (x.get("start") or "")[:10]
        if not d0:
            continue
        hsp = sp[x["home"]]["o"][0] if x["home"] in sp else None
        tot = tt["over"]["o"][0] if "over" in tt else None
        for nm, mk in (x.get("props") or {}).items():
            for st, mid in MID.items():
                v = mk.get(mid)
                if not v or None in v["o"]:
                    continue
                r = None
                for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat()):
                    r = by_day_name.get((dd, nk(nm))) or r
                if r is None:
                    continue           # no box line: did not play or not found, void
                act = r.get(st) or 0.0
                season, wk, gd = r["season"], r["week"], r["date"]
                gs = by.get(r["pid"], [])
                pr, info = C.project(gs, st, season, wk, r["opp"], allowed, C.P, lgc)
                if pr is None:
                    continue           # the live build lists a player only with a projection (v2 included)
                for when, dst in (("o", R[st][0]), ("c", R[st][1])):
                    ln, po, pu = v[when] if v.get(when) else (None, None, None)
                    if ln is None or po is None or pu is None or act == ln:
                        continue
                    io, iu = L.implied(po), L.implied(pu)
                    if not (1.0 <= io + iu <= 1.15):
                        continue
                    ps, extra = None, True
                    if st in getattr(C, "V2", {}) and hsp is not None and tot is not None:
                        fo, _ = L.fair_pair(po, pu)
                        f = MI.features(r["pid"], r["team"], r["opp"], r["home"], gd, ln, st, hsp if r["home"] else -hsp, tot) if fo else None
                        if f is not None:
                            ps = L.price_side(C.prob_v2(st, fo, f), po, pu, 1.0)
                            if ps:
                                extra = ps["side"] == C.V2[st]["side"]      # value_min 1.0 on the other side
                    if ps is None:
                        pr_ = max(0.0, pr)
                        sd_ = (C.SD[st][0] + C.SD[st][1] * pr_) if st in C.SD else math.sqrt(C.REC_VAR * max(pr_, 0.3))
                        ratio = pr_ / ln if ln else 1.0
                        if abs(pr_ - ln) > 1.0 * sd_ or not (0.6 <= ratio <= 1.67):
                            continue           # the live role guard: shown, never priced
                        ps = L.price_side(C.prob_over(st, pr_, ln), po, pu, 0.3)     # sports_build.DEFAULT_W
                    if not ps:
                        continue
                    dst.append(PB.cand(gd, (r["gid"], r["pid"]), ps["side"], ps["prob"], ps["price"],
                                       (act > ln) == (ps["side"] == "over"), extra_ok=extra))
    out = []
    for st in MID:
        split = "2026-10-01"
        why = ("v2 market model chosen on lines before 10/1" if st in getattr(C, "V2", {}) else
               "v1 projection parameters tuned on weeks 4-6 (to 10/4)")
        if st not in getattr(C, "V2", {}):
            split = "2026-10-05"
        out.append(PB.market("cfb", st, C.VERSION, ("Onyx's price moved by the v2 statistics (unders only)" if st in getattr(C, "V2", {})
                                                    else "projection blended 30% with Onyx's no-vig price, live role guard"),
                             "data/cfb/player_games.json (ESPN box), bt/cfb_props.json (Onyx open and close)", split, *R[st],
                             held=f"games on or after {split} ({why})",
                             notes="Players with no box line are voids here (Onyx settles them at 0)."))
    return out


# ── college basketball player props (11/3) ──────────────────────────────────────────────
FROZEN_CBB = os.path.join(ROOT, "data", "picks", "lines", "cbb_props_frozen.json")


def cbb_props():
    """Points, rebounds, assists, made threes, PRA: the 2025-26 walk (tools/cbb_props_backtest.py) when bt/
    holds its inputs, else its card kept in data/picks/lines/cbb_props_frozen.json while the rule matches."""
    import cbb_props_backtest as CP
    PB = _pb()
    DT = PB.DT
    sig = f"{CP.RULE_SIG} price{list(DT.PRICE)} edge{DT.MIN_EDGE}-{DT.MAX_EDGE} ev{DT.MIN_EV} conf{DT.MIN_CONF} cap{PB.PK.CAP}"
    if CP.have_inputs():
        S = CP.samples()
        C = {}
        for st in CP.STATS:
            C[st] = tuple([c for c in (PB.cand(x["date"], x["key"], x["side"], x["prob"], x["price"], x["won"])
                                       for x in S if x["s"] == st and x["when"] == w) if c] for w in ("o", "c"))
        frozen = {"note": "2025-26 Onyx Picks card candidates for college basketball player props (tools/picks_backtest.py "
                          "via tools/cbb_props_backtest.py), kept so a runner without bt/ can re-test; used only while the "
                          "rule signature matches", "sig": sig,
                  "cands": {st: {w: [[c["date"], c["key"][0], c["key"][1], c["side"], c["price"], c["prob"], c["won"]] for c in cs]
                                 for w, cs in zip(("o", "c"), C[st])} for st in C}}
        body = json.dumps(frozen, separators=(",", ":"))
        if not os.path.exists(FROZEN_CBB) or open(FROZEN_CBB).read() != body:
            open(FROZEN_CBB, "w").write(body)
    elif os.path.exists(FROZEN_CBB) and json.load(open(FROZEN_CBB)).get("sig") == sig:
        F = json.load(open(FROZEN_CBB))["cands"]
        mk = lambda r: {"date": r[0], "key": (r[1], r[2]), "side": r[3], "price": r[4], "prob": r[5],
                        "ev": DT.ev(r[4], r[5]), "won": r[6]}
        C = {st: tuple([mk(r) for r in F[st][w]] for w in ("o", "c")) for st in F}
    else:
        return []          # no replay for this rule here: carried from the last run
    out = []
    for st in CP.STATS:
        w = CP.W[st]
        chance = ("Onyx's over price only (the projection did not help on Nov-Dec 2025 log loss)" if w == 0 else
                  f"projection blended {round(w * 100)}% with Onyx's over price (implied x {CP.ONE_SIDED}, over-only lines)")
        out.append(PB.market("cbb", st, CP.VERSION, chance,
                             "tools/cbb_props_backtest.py walk-forward: cbb_stats preseason projection + 2025-26 ESPN box "
                             "scores; Onyx open and close (data/picks/lines/cbb.json)", CP.SPLIT, *C[st],
                             held="Jan 1 to Apr 9 2026 (blend weight, in-season weights and spread chosen on Nov-Dec 2025)",
                             notes="Onyx listed only the over on college props from Jan 2026 (143 of 1,155 Nov-Dec lines had an "
                                   "under); overs cashed 45% against 52% implied. Model alone (100%): points 64-73 -9.8% open / "
                                   "-8.6% close, rebounds 32-34 +1.7% / +0.5% held out. Live site does not price these yet."))
    return out
