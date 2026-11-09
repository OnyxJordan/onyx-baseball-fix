"""
live_model.py - the live (in-game) chances, in Python, for the live logger (live_log.py) and the
dev backtests. It is the same math as live.js, line for line, so a play the page shows as live
value is the play the logger records: tools/verify_live.js checks the two agree to 5e-5 on
generated game states (football, NBA, college basketball, NHL, tennis).

  football (NFL, college), NBA, college basketball: the rest of the game as a normal draw around
    Onyx's pregame spread and total, scaled by the share of the game left (SD, PACE, TOTK).
  NHL: Poisson goals for the time left, the rates split so the pregame moneyline holds; a game
    level after regulation adds one goal for the winner (overtime or the shootout).
  player props (prop_p, td_p, prop_bets): live.js propP and the anytime-TD chance, with the
    PVAR / PK / YSD numbers from data/live/prop_params.json when it is there (live.js reads the
    same file), else the built-in defaults below (the same numbers, props-v1).
  tennis: point -> game -> set -> match Markov chain. Each player's chance of winning a point on
    serve is fitted so the chain's pre-match chance equals the pregame chance (Onyx's no-vig
    moneyline, which is the blended chance at the tennis blend weight of 0, else Elo), as two form
    scenarios (the favourite sharp, the favourite flat) around a tour serve baseline. The score so
    far reweights the scenarios, then the rest of the match is played out exactly: holds,
    7-point tiebreaks, sets, best of 3 or 5. TN_P holds the tour baselines and form gap, fitted on
    ESPN set scores of 2025 ATP and WTA matches by tools/tennis_live_backtest.py (see live.js for the numbers).

Pure math, standard library only: the pipeline depends on `requests` alone.
"""

import json
import math
import re
from pathlib import Path

SD = {"nfl": (16.5, 17.5), "cfb": (16, 17), "nba": (17, 21.6), "cbb": (15.4, 20.2)}
LEN = {"nfl": (4, 15), "cfb": (4, 15), "nba": (4, 12), "nhl": (3, 20), "cbb": (2, 20)}
PACE = {"nfl": 0.4, "cfb": 0.6, "nba": 0.2, "cbb": 0.2}
ML_PTS = {"nfl": 10.8, "cfb": 12.8, "nba": 10, "cbb": 11}
TOTK = {"nfl": 1.02, "cfb": 1, "nba": 1, "cbb": 1}
DEF_TOTAL = {"nfl": 44, "cfb": 54, "nba": 228, "nhl": 6, "cbb": 145}
FMIN = {"nfl": 0.15, "cfb": 0.15, "nba": 0.15, "nhl": 0.15, "cbb": 0.15}
# tennis (tools/tennis_live_backtest.py fit): tour point-on-serve baselines and the form gap
TN_P = {"base_atp": 0.62, "base_wta": 0.54, "form_atp": 0.02, "form_wta": 0.034}   # live.js TN_P, same fit
VALUE = 0.03      # the page's Value threshold (home.html LV_VALUE, live.js VALUE)
# 11/6 (Jordan, after a rough run): live markets paused until they test positive, on the page and in the
# record (live.js PAUSED). Graded live plays 11/1-11/6: tennis totals 13-17 (-21%), college basketball
# spreads 24-27 (-12%) and moneylines 6-12 (-13%); every other live market is level or ahead
# (NHL spreads +38%, totals +23%; college basketball totals +7%).
PAUSED = {("tennis", "total"), ("cbb", "spread"), ("cbb", "ml")}
TN_CONF = 0.65    # tennis logs a live pick only at 65%+ to hit (live.js TN_CONF). 11/4: 60%; 11/6 (Jordan): 65%. Graded picks
                  # under the 60% rule: 60-64% went 13-14 (-13.5%, hit 48% vs 62% predicted), 65%+ 20-7 (+13.9%, hit 74% vs 72%)
EDGE_MAX = 0.12   # disagreements bigger than this are where the model is blind


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def implied(p):
    if p is None:
        return None
    return -p / (-p + 100) if p < 0 else 100 / (p + 100)


def no_vig(a, b):
    x, y = implied(a), implied(b)
    if x is None:
        return None
    return x if y is None else x / (x + y)


def american(p):
    if p is None or p <= 0 or p >= 1:
        return None
    x = -100 * p / (1 - p) if p >= 0.5 else 100 * (1 - p) / p
    x = round(x / 5) * 5
    return 100 if x == -100 else int(x)


def left(sport, period, clock_sec):
    L = LEN.get(sport)
    if not L or not period:
        return None
    if period > L[0]:
        return max(0.004, (clock_sec or 0) / 60 / (L[1] * L[0]))
    rem = (L[0] - period) * L[1] * 60 + (clock_sec or 0)
    return max(0.004, min(1, rem / (L[0] * L[1] * 60)))


class Normal:
    def __init__(self, sport, g):
        sd, f = SD[sport], g["f"]
        self.mu = (g.get("pre_margin") or 0) * f
        self.sM = sd[0] * math.sqrt(f)
        self.cur, self.tot = g["hs"] - g["as"], g["hs"] + g["as"]
        pt = g.get("pre_total") or 0
        pace = self.tot / (1 - f) if f < 1 else pt
        k = PACE.get(sport, 0.6)
        wo = min(k, (1 - f) * k)
        self.mt = (pt * (1 - wo) + pace * wo) * f * TOTK.get(sport, 1)
        self.sT = sd[1] * math.sqrt(f)
        self.proj_total, self.proj_margin = self.tot + self.mt, self.cur + self.mu

    def win(self):
        return 1 - phi((-self.cur - self.mu) / self.sM)

    def cover(self, home_line):
        return 1 - phi((-home_line - self.cur - self.mu) / self.sM)

    def over(self, line):
        return 1 - phi((line - self.tot - self.mt) / self.sT)


def _pois(l, k):
    p = math.exp(-l)
    for i in range(1, k + 1):
        p *= l / i
    return p


class Hockey:
    def __init__(self, g):
        T = g.get("pre_total") or 6.0
        pH = 0.5 if g.get("pre_home_win") is None else g["pre_home_win"]
        lo, hi, lh = 0.0, T, T / 2
        for _ in range(40):
            lh = (lo + hi) / 2
            if self._win(lh, T - lh, 0) < pH:
                lo = lh
            else:
                hi = lh
        self.rh, self.ra, self.d = lh * g["f"], (T - lh) * g["f"], g["hs"] - g["as"]
        self.n = g["hs"] + g["as"]
        tie = sum(_pois(self.rh, i) * _pois(self.ra, i + self.d) for i in range(12) if 0 <= i + self.d < 12)
        self.proj_total, self.proj_margin = self.n + self.rh + self.ra + tie, self.d + self.rh - self.ra

    @staticmethod
    def _win(a, b, lead):
        w = t = 0.0
        for i in range(12):
            for j in range(12):
                p, m = _pois(a, i) * _pois(b, j), lead + i - j
                if m > 0:
                    w += p
                elif m == 0:
                    t += p
        return w + 0.5 * t

    def _dist(self, fn):
        s = 0.0
        for i in range(12):
            for j in range(12):
                p, m, t = _pois(self.rh, i) * _pois(self.ra, j), self.d + i - j, self.n + i + j
                if m != 0:
                    s += p if fn(m, t) else 0
                else:
                    s += (p / 2 if fn(1, t + 1) else 0) + (p / 2 if fn(-1, t + 1) else 0)
        return s

    def win(self):
        return self._win(self.rh, self.ra, self.d)

    def cover(self, hl):
        return self._dist(lambda m, t: m + hl > 0) + 0.5 * self._dist(lambda m, t: m + hl == 0)

    def over(self, line):
        return self._dist(lambda m, t: t > line)


# ── tennis: point -> game -> set -> match ─────────────────────────────────────────────
def hold(p):
    q = 1 - p
    return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * (p * p / (1 - 2 * p * q))


def tiebreak(a, b):
    """First server wins a 7-point tiebreak; a, b: each server's point-on-serve chance."""
    M = {}

    def f(x, y):
        if x >= 7 and x - y >= 2:
            return 1.0
        if y >= 7 and y - x >= 2:
            return 0.0
        if x >= 6 and x == y:
            w, l = a * (1 - b), (1 - a) * b
            return w / (w + l)
        k = x * 20 + y
        if k not in M:
            pw = a if ((x + y + 1) // 2) % 2 == 0 else 1 - b
            M[k] = pw * f(x + 1, y) + (1 - pw) * f(x, y + 1)
        return M[k]
    return f(0, 0)


_SETS = {}


def set_dist(a0, b0, s0, pt, H=None):
    """Every way a set can finish from games (a0, b0) with player s0 serving:
    [(winner, set games, set margin for player 0, next set's first server, prob)]."""
    key = (a0, b0, s0, pt[0], pt[1])
    if key in _SETS:
        return _SETS[key]
    if len(_SETS) > 200000:
        _SETS.clear()
    _SETS[key] = out = _set_dist(a0, b0, s0, pt, H)
    return out


def _set_dist(a0, b0, s0, pt, H=None):
    H = H or (hold(pt[0]), hold(pt[1]))
    tb = (tiebreak(pt[0], pt[1]), tiebreak(pt[1], pt[0]))
    M = {}

    def f(a, b, s):
        k = (a, b, s)
        if k in M:
            return M[k]
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
        M[k] = o
        return o
    return [(w, g, d, nx, p) for (w, g, d, nx), p in f(a0, b0, s0).items()]


def tn_run(sa, sb, ga, gb, srv, pt, need):
    """From sets (sa, sb), games (ga, gb) in the set in play and srv serving: P(player 0 wins) and the
    distribution of the rest of the match [(games from the start of the set in play, margin, prob)]."""
    if sa >= need or sb >= need:            # already decided
        return (1.0 if sa >= need else 0.0), [(0, 0, 1.0)]
    if srv is None:
        r0, r1 = tn_run(sa, sb, ga, gb, 0, pt, need), tn_run(sa, sb, ga, gb, 1, pt, need)
        return (r0[0] + r1[0]) / 2, [(g, d, p / 2) for g, d, p in r0[1]] + [(g, d, p / 2) for g, d, p in r1[1]]
    H = (hold(pt[0]), hold(pt[1]))
    fresh = {}
    win, end, cur, first = 0.0, {}, {(sa, sb, srv, 0, 0): 1.0}, True
    while cur:
        nxt = {}
        for (x, y, s, g0, d0), p in cur.items():
            if first and (ga or gb):
                D = set_dist(ga, gb, s, pt, H)
            else:
                if s not in fresh:
                    fresh[s] = set_dist(0, 0, s, pt, H)
                D = fresh[s]
            for w, g, d, nx, q in D:
                X, Y, P_ = x + (w == 0), y + (w == 1), p * q
                G_, D_ = g0 + g, d0 + d
                if X == need or Y == need:
                    if X == need:
                        win += P_
                    end[(G_, D_)] = end.get((G_, D_), 0) + P_
                else:
                    k2 = (X, Y, nx, G_, D_)
                    nxt[k2] = nxt.get(k2, 0) + P_
        cur, first = nxt, False
    return win, [(g, d, p) for (g, d), p in end.items()]


def tn_win0(pt, need):
    """Win chance from 0-0 (fast; used to fit the serve rates)."""
    H = (hold(pt[0]), hold(pt[1]))
    T = []
    for s in (0, 1):
        o = {}
        for w, g, d, nx, p in set_dist(0, 0, s, pt, H):
            o[(w, nx)] = o.get((w, nx), 0) + p
        T.append(o)
    M = {}

    def f(x, y, s):
        if x == need:
            return 1.0
        if y == need:
            return 0.0
        k = (x, y, s)
        if k not in M:
            M[k] = sum(p * f(x + (w == 0), y + (w == 1), nx) for (w, nx), p in T[s].items())
        return M[k]
    return (f(0, 0, 0) + f(0, 0, 1)) / 2


def tn_fit(p_pre, need, base, sg):
    """The two form scenarios whose average pre-match chance equals p_pre."""
    lo, hi = -0.3, 0.3
    for _ in range(18):
        d = (lo + hi) / 2
        if (tn_win0((base + d + sg, base - d - sg), need) + tn_win0((base + d - sg, base - d + sg), need)) / 2 < p_pre:
            lo = d
        else:
            hi = d
    d = (lo + hi) / 2
    return [(base + d + sg, base - d - sg), (base + d - sg, base - d + sg)]


def tn_base(tour):
    w = str(tour or "").upper() == "WTA"
    return (TN_P["base_wta"], TN_P["form_wta"]) if w else (TN_P["base_atp"], TN_P["form_atp"])


def tn_set_lik(a, b, fin, s0, pt):
    """How likely a set score was under one scenario: a finished set (a, b), or reaching (a, b)."""
    H = (hold(pt[0]), hold(pt[1]))

    def one(s):
        if fin:
            return sum(p for w, g, d, nx, p in set_dist(0, 0, s, pt) if g == a + b and d == a - b)
        R = {(0, 0): 1.0}
        for n in range(a + b):
            for x in range(n + 1):
                y = n - x
                p = R.get((x, y))
                if not p or x > a or y > b:
                    continue
                if ((x >= 6 or y >= 6) and abs(x - y) >= 2) or x == 7 or y == 7:
                    continue
                sv = s if n % 2 == 0 else 1 - s
                pa = H[sv] if sv == 0 else 1 - H[sv]
                R[(x + 1, y)] = R.get((x + 1, y), 0) + p * pa
                R[(x, y + 1)] = R.get((x, y + 1), 0) + p * (1 - pa)
        return R.get((a, b), 0)
    return (one(0) + one(1)) / 2 if s0 is None else one(s0)


def set_done(a, b):
    return ((a >= 6 or b >= 6) and abs(a - b) >= 2) or a == 7 or b == 7


def tn_state(sets, srv=None, final=False):
    """sets: [(games p0, games p1), ...] as the feed shows them (the last one may be in play);
    srv: who serves now (0 / 1 / None). -> the state the chain reads."""
    S, n = [], len(sets)
    sa = sb = base = diff = 0
    for j, (a, b) in enumerate(sets):
        fin = set_done(a, b) or (final and j == n - 1)
        S.append((a, b, fin))
        if fin:
            if a > b:
                sa += 1
            else:
                sb += 1
            base += a + b
            diff += a - b
    cur = S[-1] if S and not S[-1][2] else None
    return {"sets": S, "sa": sa, "sb": sb, "ga": cur[0] if cur else 0, "gb": cur[1] if cur else 0,
            "srv": srv, "G": sum(a + b for a, b, _ in S), "base": base, "diff": diff}


def tn_post(sc, st):
    """Scenario weights after the sets seen so far (finished sets and the set in play)."""
    w = []
    for pt in sc:
        L, off = 0.5, 0
        for a, b, fin in st["sets"]:
            s0 = None if st["srv"] is None else (st["srv"] if (st["G"] - off) % 2 == 0 else 1 - st["srv"])
            L *= tn_set_lik(a, b, fin, s0, pt)
            off += a + b
        w.append(L)
    t = sum(w)
    return [x / t for x in w] if t > 0 else [0.5, 0.5]


class Tennis:
    """Live chances for one match. p_pre: pregame chance player 0 (home) wins; need: sets to win;
    st: tn_state(...). Games markets are for the whole match (sets already played included)."""

    def __init__(self, p_pre, need, st, tour=None, sc=None):
        base, sg = tn_base(tour)
        self.sc = sc or tn_fit(0.5 if p_pre is None else p_pre, need, base, sg)
        self.st, self.need = st, need
        self.w = tn_post(self.sc, st) if st["G"] else [0.5, 0.5]
        self.p_win, dist = 0.0, []
        for k, pt in enumerate(self.sc):
            r = tn_run(st["sa"], st["sb"], st["ga"], st["gb"], st["srv"], pt, need)
            self.p_win += self.w[k] * r[0]
            dist += [(st["base"] + g, st["diff"] + d, p * self.w[k]) for g, d, p in r[1]]
        self.dist = dist
        self.proj_total = sum(g * p for g, d, p in dist)
        self.proj_margin = sum(d * p for g, d, p in dist)

    def win(self):
        return self.p_win

    def cover(self, home_line):
        """P(player 0's game margin + home_line > 0), a push counted half."""
        return sum(p for g, d, p in self.dist if d + home_line > 0) + 0.5 * sum(p for g, d, p in self.dist if d + home_line == 0)

    def over(self, line):
        return sum(p for g, d, p in self.dist if g > line)


def model(sport, g):
    if sport == "tennis":
        return Tennis(g.get("pre_home_win"), g.get("need", 2), g["st"], g.get("tour"))
    if sport == "nhl":
        return Hockey(g)
    if sport in SD:
        return Normal(sport, g)
    return None


def bets(sport, g, M, lines, pre):
    """Every game-line bet on one game against the live line, with the same gates as live.js
    bets(): -> [{kind, label, side, sel, pt, price, p, fair, edge}], best value first.
    g: {home, away, hn, an, f}; lines: the relay's [{m, sel, side, pt, price}]; pre: pregame()."""
    out = []
    f = g.get("f")

    def add(o):
        if o["p"] is None or o["price"] is None or o["p"] != o["p"]:
            return
        o["p"] = min(0.995, max(0.005, o["p"]))
        o["fair"] = american(o["p"])
        o["edge"] = round((o["p"] - implied(o["price"])) * 1000) / 1000
        if o["p"] < 0.03 or o["p"] > 0.97 or o["price"] < -500 or o["price"] > 500:
            return
        if f is not None and f < FMIN.get(sport, 0.15):
            return
        if o["edge"] > EDGE_MAX:
            return
        if (sport, o.get("kind")) in PAUSED:
            return
        out.append(o)

    def is_home(sel):
        return same_team(sel, g.get("hn")) or same_team(sel, g.get("home"))
    for x in lines:
        m = x.get("m")
        if m == "ml":
            h = is_home(x.get("sel"))
            pw = M.win()
            add({"kind": "ml", "side": "home" if h else "away", "label": (g["home"] if h else g["away"]) + " to win",
                 "p": pw if h else 1 - pw, "price": x.get("price"), "pt": None, "sel": x.get("sel")})
        elif m == "spread" and x.get("pt") is not None:
            h = is_home(x.get("sel"))
            hl = x["pt"] if h else -x["pt"]
            pc = M.cover(hl)
            add({"kind": "spread", "side": "home" if h else "away", "label": (g["home"] if h else g["away"]) + " " + sgn(x["pt"]) + (" games" if sport == "tennis" else ""),
                 "p": pc if h else 1 - pc, "price": x.get("price"), "pt": x["pt"], "sel": x.get("sel")})
        elif m == "total" and x.get("pt") is not None and x.get("side") in ("over", "under"):
            po = M.over(x["pt"])
            add({"kind": "total", "side": x["side"], "label": ("Over " if x["side"] == "over" else "Under ") + fmt_pt(x["pt"]) + (" games" if sport == "tennis" else ""),
                 "p": po if x["side"] == "over" else 1 - po, "price": x.get("price"), "pt": x["pt"], "sel": x.get("sel")})
    return sorted(out, key=lambda o: -o["edge"])


def fmt_pt(x):
    return str(int(x)) if float(x).is_integer() else str(x)


def sgn(x):
    return "pk" if x == 0 else ("+" if x > 0 else "") + fmt_pt(x)


def nk(n):
    import re
    import unicodedata
    s = unicodedata.normalize("NFKD", str(n or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def same_team(a, b):
    a, b = nk(a), nk(b)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    x, y = a.split(" "), b.split(" ")
    return len(x) > 1 and len(y) > 1 and x[-1] == y[-1] and len(x[-1]) > 3



# ── live player props (live.js propP / bets(), the prop branch) ─────────────────────────
# Built-in defaults: the 11/9 refit (tools/live_props_backtest.js --fit, see live.js for the numbers).
# data/live/prop_params.json replaces them key by key when present (load_prop_params), the same way
# live.js does, so the page and the logger always price a prop with the same numbers.
PVAR = {"pts": 4, "reb": 1.6, "ast": 1.3, "threes": 1.3, "rec": 1.3}
PK = {"pts": 0.95, "reb": 0.9, "ast": 0.85, "rec_yds": 0.85, "rush_yds": 0.9}
YSD = {"rec_yds": (0.3, 12), "rush_yds": (0.35, 18), "pass_yds": (0.45, 12)}
PROP_VERSION = "props-v1"
PROP_PARAMS = Path(__file__).resolve().parent / "data" / "live" / "prop_params.json"
PROP_FMIN = 0.08     # no prop bet in the last 8% of a game (live.js bets())
MKN = {"pts": "points", "reb": "rebounds", "ast": "assists", "threes": "threes", "rec": "catches", "rec_yds": "receiving yds",
       "rush_yds": "rushing yds", "pass_yds": "passing yds"}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def load_prop_params(path=None):
    """Read data/live/prop_params.json into PVAR / PK / YSD / PROP_VERSION. Fail-soft: a missing
    or broken file leaves the defaults. -> True when the file was read."""
    global PROP_VERSION
    try:
        j = json.loads(Path(path or PROP_PARAMS).read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(j, dict):
        return False
    for k, v in (j.get("PVAR") or {}).items():
        if _num(v):
            PVAR[k] = v
    for k, v in (j.get("PK") or {}).items():
        if _num(v):
            PK[k] = v
    for k, v in (j.get("YSD") or {}).items():
        if isinstance(v, (list, tuple)) and len(v) == 2 and _num(v[0]) and isinstance(v[1], (int, float)) and v[1] >= 0:
            YSD[k] = (v[0], v[1])
    if j.get("version"):
        PROP_VERSION = str(j["version"])
    return True


load_prop_params()


def prop_p(mkt, cur, proj, f, line):
    """P(stat > line) for an over / under prop: live.js propP, line for line."""
    rem = max(0.0, proj * PK.get(mkt, 1) * f)
    mean = cur + rem
    y = YSD.get(mkt, (0.45, 12))
    if mkt.endswith("yds"):
        sd = (y[0] * proj + y[1]) * math.sqrt(f)
    else:
        sd = math.sqrt(max(0.15, rem * PVAR.get(mkt, 1.5)))
    sd = max(sd, 0.35)
    return 1 - phi((line - mean) / sd)


def td_p(lam, f):
    """Anytime TD while he has not scored: 1 - exp(-lam x share of the game left) (live.js bets())."""
    return 1 - math.exp(-lam * f)


def pn(n):
    """live.js pn(): player names compared by their letters, suffixes dropped."""
    return re.sub(r"\s+", " ", re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", nk(n))).strip()


def _num_txt(v):
    try:
        x = float(str("" if v is None else v).split("-")[0])
    except ValueError:
        return None
    return None if x != x else x


def box_stats(sport, summary):
    """ESPN summary -> {pn(name): {pts, reb, ast, threes, fouls} or {pass_yds, rush_yds, rec, rec_yds, td}}:
    live.js box(), line for line (a player who did not play has an empty dict)."""
    out = {}
    for t in ((summary or {}).get("boxscore") or {}).get("players") or []:
        for cat in t.get("statistics") or []:
            keys = cat.get("keys") or []
            lab = [str(x).upper() for x in cat.get("labels") or []]
            nm = str(cat.get("name") or "").lower()
            for a in cat.get("athletes") or []:
                n = pn((a.get("athlete") or {}).get("displayName"))
                st = a.get("stats") or []
                o = out.setdefault(n, {})

                def at(k, l=None):
                    i = keys.index(k) if k in keys else -1
                    if i < 0 and l:
                        i = lab.index(l) if l in lab else -1
                    return st[i] if 0 <= i < len(st) else None
                if sport == "nba":
                    if a.get("didNotPlay"):
                        continue
                    o["pts"] = _num_txt(at("points", "PTS"))
                    o["reb"] = _num_txt(at("rebounds", "REB"))
                    o["ast"] = _num_txt(at("assists", "AST"))
                    o["threes"] = _num_txt(at("threePointFieldGoalsMade-threePointFieldGoalsAttempted", "3PT"))
                    o["fouls"] = _num_txt(at("fouls", "PF"))
                elif nm == "passing":
                    o["pass_yds"] = _num_txt(at("passingYards", "YDS"))
                    o["td"] = o.get("td") or 0
                elif nm == "rushing":
                    o["rush_yds"] = _num_txt(at("rushingYards", "YDS"))
                    o["td"] = (o.get("td") or 0) + (_num_txt(at("rushingTouchdowns", "TD")) or 0)
                elif nm == "receiving":
                    o["rec"] = _num_txt(at("receptions", "REC"))
                    o["rec_yds"] = _num_txt(at("receivingYards", "YDS"))
                    o["td"] = (o.get("td") or 0) + (_num_txt(at("receivingTouchdowns", "TD")) or 0)
    return out


def prop_price(x, pp, bx, f):
    """One relay prop line priced, before the page's gates: -> {player, mkt, side, pt, price, p, cur, proj}
    or None (no pregame projection for him, already scored, fouled out, a line we do not price)."""
    m, sel = x.get("m"), x.get("sel")
    key = next((k for k in pp if k.split("|")[1:2] == [m] and pn(k.split("|")[0]) == pn(sel)), None)
    if key is None:
        return None
    q, me, nm = pp[key] or {}, bx.get(pn(sel)) or {}, key.split("|")[0]
    if m == "anytime_td":
        if (me.get("td") or 0) >= 1 or q.get("lam") is None or x.get("side") in ("no", "under"):
            return None
        return {"player": nm, "mkt": m, "side": "yes", "pt": None, "price": x.get("price"), "p": td_p(q["lam"], f),
                "cur": me.get("td") or 0, "proj": q["lam"], "label": nm + " anytime TD"}
    if q.get("j") is None or x.get("pt") is None or x.get("side") not in ("over", "under"):
        return None
    cur = me.get(m)
    if cur is None:
        cur = 0
    if me.get("fouls") is not None and me["fouls"] >= 6:
        return None
    pov = prop_p(m, cur, q["j"], f, x["pt"])
    return {"player": nm, "mkt": m, "side": x["side"], "pt": x["pt"], "price": x.get("price"), "p": pov if x["side"] == "over" else 1 - pov,
            "cur": cur, "proj": q["j"], "label": nm + " " + x["side"] + " " + fmt_pt(x["pt"]) + " " + MKN.get(m, m)}


def prop_bets(sport, f, lines, pp, bx):
    """Every player-prop bet on one game against the live line, with live.js bets()'s gates: chance
    clamped to .005-.995, nothing decided (under 3% / over 97%), prices -500..+500, nothing in the last
    8% of the game, nothing we disagree with by more than 12 points. -> [{kind: 'prop', ...}], best first."""
    out = []
    if not pp or f is None or bx is None:
        return out
    for x in lines or []:
        if x.get("m") in ("ml", "spread", "total"):
            continue
        o = prop_price(x, pp, bx, f)
        if not o or o["price"] is None or o["p"] != o["p"]:
            continue
        o["kind"] = "prop"
        o["p"] = min(0.995, max(0.005, o["p"]))
        o["fair"] = american(o["p"])
        o["edge"] = round((o["p"] - implied(o["price"])) * 1000) / 1000
        if o["p"] < 0.03 or o["p"] > 0.97 or o["price"] < -500 or o["price"] > 500:
            continue
        if f < PROP_FMIN or o["edge"] > EDGE_MAX or (sport, "prop") in PAUSED:
            continue
        out.append(o)
    return sorted(out, key=lambda o: -o["edge"])
