"""
tennis_model.py - Onyx Tennis match model: Elo ratings from every completed
ATP and WTA singles match ESPN reports (data/tennis/results.json).

Changelog (newest first; each entry cites its evidence)

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

VERSION = "v1"
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
