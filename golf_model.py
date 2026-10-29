#!/usr/bin/env python3
"""
golf_model.py - Onyx Golf: a rating for every player in this week's field, and the
reasons behind it.

The unit is strokes gained per round against the field (SG): the field's average
score that round minus his. A rating of +1.5 means he is expected to beat the
average player in the field by a stroke and a half a round. The page turns the
ratings into win / top 5 / top 10 / top 20 / make-the-cut chances by simulating the
tournament in the browser, from the first tee or from the live leaderboard.

Layers, each one backtested on its own (walk-forward over 222 PGA TOUR stroke-play
events, 2022-26: tuned on 2023-24, scored on 2025-26):
  form     every past round, weighted by age (a round 240 days old counts half),
           shrunk toward a newcomer prior of -1.0 with 4 rounds of evidence
  history  what form missed by at THIS course before (his residuals there),
           shrunk by 8 rounds, applied at 0.25 strength
  fit      the course's skill demand: which stat profiles (driving distance, accuracy,
           greens hit, putting) beat their form here, learned from past weeks at the
           course (ridge 20) x his profile, at 0.5 strength
Tested and left out: green type (bermuda / paspalum vs bent / poa), no signal.

Data: ESPN's public PGA TOUR feed (hole-by-hole rounds, per-event player stats).
data/golf/history.json holds four years of player-events; update() appends each
finished event once. Pipeline-safe: requests only (no numpy).
"""
import json, os, sys, time
from datetime import date, datetime, timezone
from concurrent.futures import ThreadPoolExecutor

VERSION = "golf-v1"
CHANGELOG = [
    "golf-v1 (10/29): first model. Walk-forward on 222 PGA TOUR stroke-play events (2022-26), tuned on 2023-24 and scored "
    "on 2025-26, which it never saw. Error on each player's strokes gained per round: 3.17 predicting the field average, "
    "2.79 with form, 2.78 with course history, 2.76 with course fit. Head to head (who beats whom over the week) it picks "
    "the winner 58.8% of the time. Finishing chances from 1,000 simulated tournaments per event land close to what "
    "happened: top 10 predicted 13.6% came in 12.3%, make the cut 59% came in 61%, 81% came in 81%. Course history and "
    "course fit tighten the round projection but barely move the finishing chances: golf's week-to-week swing is large. "
    "Green type (bermuda / paspalum vs bent / poa) tested and left out: no signal.",
]
P = {"H": 240, "k": 4, "m0": -1.0, "kc": 8, "a_ch": .25, "lam": 20, "a_fit": .5, "Hs": 365,
     "sr": 2.6, "sp": 0.0}
SK = ["driveDistAvg", "driveAccuracyPct", "gir", "puttsGirAvg"]
SK_NAME = {"driveDistAvg": "Driving distance", "driveAccuracyPct": "Driving accuracy", "gir": "Approach play",
           "puttsGirAvg": "Putting"}
TESTS = [
    {"k": "Round error", "v": "2.76", "d": "strokes gained per round, 2025-26 (field average: 3.17)"},
    {"k": "Head to head", "v": "58.8%", "d": "picks who beats whom over the week, 133k pairs"},
    {"k": "Top 10 chance", "v": "13.6% → 12.3%", "d": "predicted vs happened, 2,800 player-weeks"},
    {"k": "Make the cut", "v": "81% → 81%", "d": "predicted vs happened, 1,273 player-weeks"},
]
KEEP_YEARS = 4
SB = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates={}"
CORE = "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/{}?lang=en"
STAT = "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/{0}/competitions/{0}/competitors/{1}/statistics?lang=en"


# ── history: one row per player-event ─────────────────────────────────
def event_rows(players, courses):
    """Players ({id, name, pos, rounds: [{v, per, holes}], st}) -> history rows
    [pid, name, pos, [sg per round], [z dist, z acc, z gir, z putt] or None], or None
    when the event is not 72-hole stroke play (Stableford, team formats)."""
    win = players[0] if players else None
    rv = [r["v"] for r in (win or {}).get("rounds") or [] if r.get("v") is not None and (r.get("per") or 0) <= 4
          and len(r.get("holes") or []) >= 9]   # playoff holes arrive as extra 'rounds'
    if not rv or not all(55 <= v <= 90 for v in rv):
        return None
    per_round = {}
    for p in players:
        for r in p["rounds"]:
            if r.get("v") is not None and 55 <= r["v"] <= 95 and len(r.get("holes") or []) == 18:
                per_round.setdefault(r["per"], []).append(r["v"])
    rmean = {k: sum(v) / len(v) for k, v in per_round.items() if len(v) >= 20}
    good = [p for p in players if p.get("st") and (p["st"].get("driveDistAvg") or 0) > 200]
    fm = fsd = None
    if len(good) >= 20:
        fm = {k: sum(p["st"][k] for p in good) / len(good) for k in SK}
        fsd = {k: (sum((p["st"][k] - fm[k]) ** 2 for p in good) / len(good)) ** .5 or 1.0 for k in SK}
    rows = []
    for p in players:
        sg = [round(rmean[r["per"]] - r["v"], 2) for r in p["rounds"]
              if r.get("per") in rmean and r.get("v") is not None and 55 <= r["v"] <= 95 and len(r.get("holes") or []) == 18]
        if not sg:
            continue
        z = None
        if fm and p.get("st") and (p["st"].get("driveDistAvg") or 0) > 200:
            z = [round((p["st"][k] - fm[k]) / fsd[k] * (-1 if k == "puttsGirAvg" else 1), 2) for k in SK]
        rows.append([str(p["id"]), p.get("name"), p.get("pos"), sg, z])
    return rows


def _get(url, tries=3):
    import requests
    for i in range(tries):
        try:
            r = requests.get(url, timeout=25)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def update(path, today=None, since=None):
    """Append every finished PGA TOUR event not yet in history (a few a week at most).
    since=YEAR rebuilds from that season on (python3 golf_model.py data/golf/history.json 2023)."""
    H = json.load(open(path)) if os.path.exists(path) else {"events": {}, "rows": {}}
    yr = (today or date.today()).year
    added = 0
    for y in range(since or yr - 1, yr + 2):
        sb = _get(SB.format(y)) or {}
        for e in sb.get("events") or []:
            eid = str(e.get("id") or "")
            st = ((e.get("status") or {}).get("type") or {}).get("state")
            if not eid or eid in H["events"] or st != "post":
                continue
            comp = (e.get("competitions") or [{}])[0]
            cs = comp.get("competitors") or []
            if not cs or any("athlete" not in c for c in cs):
                H["events"][eid] = {"d": (e.get("date") or "")[:10], "n": e.get("name"), "skip": "team"}
                continue
            meta = _get(CORE.format(eid)) or {}
            courses = meta.get("courses") or []
            players = [{"id": c["id"], "name": c["athlete"].get("fullName"), "pos": c.get("order"),
                        "rounds": [{"v": l.get("value"), "per": l.get("period"),
                                    "holes": [h.get("value") for h in l.get("linescores") or []]}
                                   for l in c.get("linescores") or []]} for c in cs]

            def stat(pid):
                j = _get(STAT.format(eid, pid))
                try:
                    return pid, {x["name"]: x.get("value") for x in j["splits"]["categories"][0]["stats"]}
                except Exception:
                    return pid, None
            with ThreadPoolExecutor(8) as ex:
                S = dict(ex.map(stat, [p["id"] for p in players]))
            for p in players:
                p["st"] = S.get(p["id"])
            rows = event_rows(players, courses)
            c0 = courses[0] if len(courses) == 1 else None
            H["events"][eid] = {"d": (e.get("date") or "")[:10], "n": e.get("name"),
                                "c": str(c0["id"]) if c0 else None, "cn": c0.get("name") if c0 else None,
                                **({"skip": "format"} if rows is None else {})}
            if rows:
                H["rows"][eid] = rows
                added += 1
                print(f"  golf history: + {e.get('name')} ({len(rows)} players)")
    cutoff = date(yr - KEEP_YEARS, 1, 1).isoformat()
    for eid in [k for k, v in H["events"].items() if (v.get("d") or "") < cutoff]:
        H["events"].pop(eid, None)
        H["rows"].pop(eid, None)
    json.dump(H, open(path, "w"), separators=(",", ":"))
    return H, added


# ── the walk: form, course history and course fit at any point in time ─
def _solve(A, b):
    n = len(b)
    M = [A[i][:] + [b[i]] for i in range(n)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12:
            return [0.0] * n
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


class Walk:
    """Replays history in date order so every residual (what form missed by) is the one
    the model would have seen at the time: course history and course fit learn from those."""

    def __init__(self, H, log=None):
        self.H, self.log = H, log      # log: list to receive (event, player, rating, actual, rounds)
        self.S = {}      # pid -> [t, w, wx]          form (rounds, half-life H days)
        self.PF = {}     # pid -> [t, w, [4]]         stat profile (half-life Hs)
        self.CH = {}     # (pid, course) -> [sum res x rounds, rounds]
        self.CX = {}     # course -> [A 4x4, b 4]
        self.last = {}   # pid -> recent [date, event, pos] (newest last)
        order = sorted(H["rows"], key=lambda k: H["events"][k]["d"])
        for eid in order:
            self._event(eid, H["events"][eid])

    @staticmethod
    def _t(d):
        return date.fromisoformat(d).toordinal()

    def form(self, pid, t):
        s = self.S.get(pid)
        if not s:
            return P["m0"], 0.0
        f = 0.5 ** ((t - s[0]) / P["H"])
        w, wx = s[1] * f, s[2] * f
        return (wx + P["k"] * P["m0"]) / (w + P["k"]), w

    def profile(self, pid, t):
        s = self.PF.get(pid)
        if not s:
            return [0.0] * 4
        f = 0.5 ** ((t - s[0]) / P["Hs"])
        return [v * f / (s[1] * f + 3) for v in s[2]]

    def history(self, pid, course):
        s = self.CH.get((pid, course))
        return (s[0] / (s[1] + P["kc"]), s[1]) if s else (0.0, 0)

    def fit(self, course, prof):
        cx = self.CX.get(course)
        if not cx or not any(prof):
            return 0.0
        A = [[cx[0][i][j] + (P["lam"] if i == j else 0) for j in range(4)] for i in range(4)]
        beta = _solve(A, cx[1])
        return sum(b * p for b, p in zip(beta, prof))

    def _event(self, eid, ev):
        t, c = self._t(ev["d"]), ev.get("c")
        pre = {}
        for pid, name, pos, sg, z in self.H["rows"][eid]:
            f, _ = self.form(pid, t)
            pre[pid] = (f, self.profile(pid, t))
            if self.log is not None:
                ch = self.history(pid, c)[0] if c else 0.0
                ft = self.fit(c, pre[pid][1]) if c else 0.0
                self.log.append((eid, pid, f + P["a_ch"] * ch + P["a_fit"] * ft, sum(sg) / len(sg), len(sg)))
        for pid, name, pos, sg, z in self.H["rows"][eid]:
            f, prof = pre[pid]
            n = len(sg)
            res = sum(sg) / n - f
            if c:
                h = self.CH.setdefault((pid, c), [0.0, 0])
                h[0] += res * n
                h[1] += n
                if any(prof):
                    A, b = self.CX.setdefault(c, [[[0.0] * 4 for _ in range(4)], [0.0] * 4])
                    for i in range(4):
                        b[i] += n * prof[i] * res
                        for j in range(4):
                            A[i][j] += n * prof[i] * prof[j]
            s = self.S.get(pid)
            if s:
                f0 = 0.5 ** ((t - s[0]) / P["H"])
                s[:] = [t, s[1] * f0 + n, s[2] * f0 + sum(sg)]
            else:
                self.S[pid] = [t, n, sum(sg)]
            if z:
                q = self.PF.get(pid)
                if q:
                    f0 = 0.5 ** ((t - q[0]) / P["Hs"])
                    q[:] = [t, q[1] * f0 + 1, [v * f0 + zz for v, zz in zip(q[2], z)]]
                else:
                    self.PF[pid] = [t, 1, list(z)]
            self.last.setdefault(pid, []).append([ev["d"], ev.get("n"), pos if n >= 3 else "MC", round(sum(sg) / n, 2)])


def wins_here(H, course):
    """What separated the top of the board at this course: same-week stats (z vs the
    field) regressed on the week's strokes gained, past events here. Descriptive."""
    X, Y = [], []
    for eid, ev in H["events"].items():
        if ev.get("c") != course or eid not in H["rows"]:
            continue
        for pid, name, pos, sg, z in H["rows"][eid]:
            if z and len(sg) >= 2:
                X.append(z)
                Y.append(sum(sg) / len(sg))
    if len(X) < 120:
        return None
    A = [[sum(x[i] * x[j] for x in X) + (5.0 if i == j else 0) for j in range(4)] for i in range(4)]
    b = [sum(x[i] * y for x, y in zip(X, Y)) for i in range(4)]
    beta = _solve(A, b)
    tot = sum(abs(v) for v in beta) or 1
    return {"n": len(X), "events": len({k for k, e in H["events"].items() if e.get("c") == course and k in H["rows"]}),
            "skills": sorted([{"k": k, "name": SK_NAME[k], "share": round(abs(v) / tot, 3), "beta": round(v, 3)}
                              for k, v in zip(SK, beta)], key=lambda s: -s["share"])}


def tour_wins(H):
    """The same split across every course: the 'typical week' to compare against."""
    X, Y = [], []
    for eid, rows in H["rows"].items():
        for pid, name, pos, sg, z in rows:
            if z and len(sg) >= 2:
                X.append(z)
                Y.append(sum(sg) / len(sg))
    if len(X) < 500:
        return None
    A = [[sum(x[i] * x[j] for x in X) + (5.0 if i == j else 0) for j in range(4)] for i in range(4)]
    beta = _solve(A, [sum(x[i] * y for x, y in zip(X, Y)) for i in range(4)])
    tot = sum(abs(v) for v in beta) or 1
    return {k: round(abs(v) / tot, 3) for k, v in zip(SK, beta)}


def cut_rule(name, signature, cut_round):
    """The cut line after 36 holes: top N and ties (the page's simulation scores whole
    strokes, so ties fall through exactly as they do on Friday). 0 = no cut."""
    n = (name or "").lower()
    if cut_round == 0:
        return 0
    if "masters" in n:
        return 50
    if "u.s. open" in n or "us open" in n:
        return 60
    if "pga championship" in n or "open championship" in n:
        return 70
    return 50 if signature else 65


def field_ratings(H, board, course, when):
    """Ratings for this week's field (the ESPN leaderboard's players)."""
    W = Walk(H)
    t = date.fromisoformat(when).toordinal()
    out = []
    for r in board:
        pid = str(r.get("id") or "")
        f, w = W.form(pid, t)
        ch, chn = W.history(pid, course) if course else (0.0, 0)
        prof = W.profile(pid, t)
        ft = W.fit(course, prof) if course else 0.0
        rating = f + P["a_ch"] * ch + P["a_fit"] * ft
        last = W.last.get(pid, [])[-5:]
        out.append({"id": pid, "name": r.get("name"), "r": round(rating, 3), "form": round(f, 3),
                    "ch": round(P["a_ch"] * ch, 3), "ch_rounds": chn, "fit": round(P["a_fit"] * ft, 3),
                    "rounds": round(w, 1), "prof": [round(v, 2) for v in prof],
                    "last": [[d[5:], n, pos, sg] for d, n, pos, sg in reversed(last)]})
    out.sort(key=lambda x: -x["r"])
    return out


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else "data/golf/history.json"
    H, n = update(p, since=int(sys.argv[2]) if len(sys.argv) > 2 else None)
    print(f"golf history: {len(H['rows'])} events, +{n}")
