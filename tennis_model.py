"""
tennis_model.py - Onyx Tennis match model: Elo ratings from every completed
ATP and WTA singles match ESPN reports (data/tennis/results.json).

Changelog (newest first; each entry cites its evidence)

  v2  10/29  Games markets (spread and total games), so tennis plays can be
      spreads and totals, not only match winners. The match is played out
      game by game from each player's chance of winning a point on serve
      (fitted so the match price equals the Elo chance): holds, point-by-
      point tiebreaks, sets, best of five for ATP at the Slams. One fixed
      strength over-projects totals: with Onyx's own moneyline as the match
      chance, it gave the over 60% on 10/29's 30 priced matches against
      Onyx's 49%. Two form scenarios (favourite sharp / flat, GAME_P form
      apart) fix it: form .034 brings the mean over chance to Onyx's within
      a point (+.009 at .032, -.009 at .035; mean |gap| .061) and the spread
      cover chance to +.007. Not yet backtested against historical Onyx
      games lines: leans only, like the match price. The page's live match
      center runs the same chain (sport_shell.html tnRun).

  v1  10/26  Elo, K = 150 / (matches + 5) ** 0.4 (FiveThirtyEight's
      schedule: new players move fast, veterans slowly), from 36,666 ATP and
      WTA singles matches since 2023 (retirements and walkovers dropped).
      Tuned on 2025, judged on 7,875 matches in 2026 the ratings never saw
      (both players 10+ prior matches): log loss 0.627, favourite won 64.0%.
      A Grand Slam weight (1.1, 1.3) tested no better. Leans only until the
      Onyx price backtest passes.
"""

import math

from sports_common import nk

VERSION = "v2"
P = {"k0": 150.0, "shape": 0.4, "k_slam": 1.0, "min_matches": 10}
SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")


def _is_slam(event):
    e = (event or "").lower()
    return any(s in e for s in SLAMS)


class Elo:
    def __init__(self, P=P):
        self.P = P
        self.r, self.n = {}, {}

    def p(self, a, b):
        ra, rb = self.r.get(a, 1500.0), self.r.get(b, 1500.0)
        return 1 / (1 + 10 ** ((rb - ra) / 400))

    def known(self, a):
        return self.n.get(a, 0) >= self.P["min_matches"]

    def update(self, w, l, event=None):
        pw = self.p(w, l)
        m = self.P["k_slam"] if _is_slam(event) else 1.0
        for who, s, pexp in ((w, 1.0, pw), (l, 0.0, 1 - pw)):
            k = self.P["k0"] / (self.n.get(who, 0) + 5) ** self.P["shape"] * m
            self.r[who] = self.r.get(who, 1500.0) + k * (s - pexp)
            self.n[who] = self.n.get(who, 0) + 1


KEEP_DAYS = 45


def load(lane):
    """The Elo state (data/tennis/elo.json) with the recent matches still in
    results.json replayed on top: the ratings as of now."""
    st = lane.load("elo.json", {}) or {}
    E = Elo(P)
    E.r = {k: v[0] for k, v in (st.get("r") or {}).items()}
    E.n = {k: v[1] for k, v in (st.get("r") or {}).items()}
    for m in (lane.load("results.json", {}) or {}).get("matches") or []:
        if m["date"] >= st.get("through", ""):
            E.update(nk(m["w"]), nk(m["l"]), m.get("event"))
    return E


def fold(lane, res, today):
    """Fold matches older than KEEP_DAYS into elo.json and drop them from
    results.json, so the committed history stays small. Matches are folded
    in date order, once (anything dated before the fold line is skipped)."""
    from datetime import timedelta
    cut = (today - timedelta(days=KEEP_DAYS)).isoformat()
    st = lane.load("elo.json", {}) or {}
    through = st.get("through", "")
    E = Elo(P)
    E.r = {k: v[0] for k, v in (st.get("r") or {}).items()}
    E.n = {k: v[1] for k, v in (st.get("r") or {}).items()}
    old = [m for m in res["matches"] if m["date"] < cut]
    for m in old:
        if m["date"] >= through:
            E.update(nk(m["w"]), nk(m["l"]), m.get("event"))
    if old:
        lane.save("elo.json", {"version": VERSION, "through": max(through, cut),
                               "r": {k: [round(E.r[k], 2), E.n[k]] for k in sorted(E.r)}})
        res["matches"] = [m for m in res["matches"] if m["date"] >= cut]
    return len(old)


def ratings(matches, before=None, P=P):
    E = Elo(P)
    for m in matches:
        if before and m["date"] >= before:
            break
        E.update(nk(m["w"]), nk(m["l"]), m.get("event"))
    return E


def evaluate(matches, start, P=P):
    """Log loss and accuracy on matches from start on, each predicted from
    ratings built only on earlier matches (ratings update as the walk goes)."""
    E = Elo(P)
    ll = hit = n = 0
    for m in matches:
        w, l = nk(m["w"]), nk(m["l"])
        if m["date"] >= start and E.known(w) and E.known(l):
            p = min(max(E.p(w, l), 1e-4), 1 - 1e-4)
            ll += -math.log(p)
            hit += p > 0.5
            n += 1
        E.update(w, l, m.get("event"))
    return {"n": n, "logloss": ll / n if n else None, "acc": hit / n if n else None}


# ── game-level match model (v2): spreads and totals ────────────────────
# The match is played out game by game: each player's chance of winning a
# point on serve sets his hold chance, tiebreaks are played point by point,
# sets and the match follow exactly. Two form scenarios (the favourite sharp,
# the favourite flat; GAME_P["form"] apart) keep it from over-projecting the
# games total, as one fixed strength does by 2-3 games. Point-on-serve
# chances are fitted so the match price equals the Elo chance, so spreads
# and totals are the Elo view, not a copy of Onyx's.
GAME_P = {"base_atp": 0.64, "base_wta": 0.56, "form": 0.034}
SLAM_BO5 = ("australian open", "roland garros", "french open", "wimbledon", "us open")


def _hold(p):
    q = 1 - p
    return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * (p * p / (1 - 2 * p * q))


def _tiebreak(a, b):
    """First server wins a 7-point tiebreak; a, b: each server's point-on-serve chance."""
    memo = {}

    def f(x, y):
        if x >= 7 and x - y >= 2:
            return 1.0
        if y >= 7 and y - x >= 2:
            return 0.0
        if x >= 6 and x == y:
            w, l = a * (1 - b), (1 - a) * b
            return w / (w + l)
        k = (x, y)
        if k not in memo:
            pw = a if ((x + y + 1) // 2) % 2 == 0 else 1 - b
            memo[k] = pw * f(x + 1, y) + (1 - pw) * f(x, y + 1)
        return memo[k]
    return f(0, 0)


def _set(pt, s0):
    """Every way a set from 0-0 with player s0 serving can finish:
    {(winner, games, margin for player 0, next server): prob}."""
    H = (_hold(pt[0]), _hold(pt[1]))
    tb = (_tiebreak(pt[0], pt[1]), _tiebreak(pt[1], pt[0]))
    memo = {}

    def f(a, b, s):
        k = (a, b, s)
        if k in memo:
            return memo[k]
        if ((a >= 6 or b >= 6) and abs(a - b) >= 2) or a == 7 or b == 7:
            o = {(0 if a > b else 1, a + b, a - b, s): 1.0}
        elif a == 6 and b == 6:
            w0 = tb[0] if s == 0 else 1 - tb[1]
            o = {(0, 13, 1, 1 - s): w0, (1, 13, -1, 1 - s): 1 - w0}
        else:
            pa = H[s] if s == 0 else 1 - H[s]
            o = {}
            for kk, p in f(a + 1, b, 1 - s).items():
                o[kk] = o.get(kk, 0) + pa * p
            for kk, p in f(a, b + 1, 1 - s).items():
                o[kk] = o.get(kk, 0) + (1 - pa) * p
        memo[k] = o
        return o
    return f(0, 0, s0)


def _match(pt, need):
    """P(player 0 wins) and the distribution of (total games, margin for player 0)."""
    sets = [_set(pt, 0), _set(pt, 1)]
    win, end = 0.0, {}
    for s0 in (0, 1):                       # who serves first is a coin toss
        cur = {(0, 0, s0, 0, 0): 0.5}
        while cur:
            nxt = {}
            for (x, y, s, g0, d0), p in cur.items():
                for (w, g, d, nx), q in sets[s].items():
                    X, Y, P_ = x + (w == 0), y + (w == 1), p * q
                    if X == need or Y == need:
                        if X == need:
                            win += P_
                        end[(g0 + g, d0 + d)] = end.get((g0 + g, d0 + d), 0) + P_
                    else:
                        k2 = (X, Y, nx, g0 + g, d0 + d)
                        nxt[k2] = nxt.get(k2, 0) + P_
            cur = nxt
    return win, end


def games_markets(p_win, tour, event, total=None, spread0=None, P=GAME_P):
    """The Elo view of a match's games markets: P(over total), P(player 0
    covers spread0) and the expected games. p_win: Elo chance player 0 wins."""
    need = 3 if tour == "ATP" and any(s in (event or "").lower() for s in SLAM_BO5) else 2
    base = P["base_wta"] if tour == "WTA" else P["base_atp"]
    sg = P["form"]

    def mix(d):
        return [[base + d + sg, base - d - sg], [base + d - sg, base - d + sg]]
    lo, hi = -0.3, 0.3
    for _ in range(18):
        d = (lo + hi) / 2
        pw = sum(_match(pt, need)[0] for pt in mix(d)) / 2
        lo, hi = (d, hi) if pw < p_win else (lo, d)
    dist = {}
    for pt in mix((lo + hi) / 2):
        for k, p in _match(pt, need)[1].items():
            dist[k] = dist.get(k, 0) + p / 2
    out = {"exp_games": sum(g * p for (g, _), p in dist.items())}
    if total is not None:
        out["p_over"] = sum(p for (g, _), p in dist.items() if g > total)
    if spread0 is not None:
        out["p_cover0"] = sum(p for (_, d), p in dist.items() if d + spread0 > 0)
    return out
