#!/usr/bin/env python3
"""
situations.py - Similar spots: how teams in this game's spot have done against the
closing spread and total, in every season we hold.

    python3 situations.py <sport>          print today's spots (no writes)

Jordan, 11/2: "compare similar teams in similar spots, what happens ATS at X points".
This is CONTEXT, NOT A PICK. Nothing here creates a play, touches a ledger, the Top 10
or Onyx Picks; the page shows it as history with its sample size, a plain significance
read and the out-of-sample backtest (tools/situations_backtest.py) next to it.

History: data/<sport>/situations_hist.json, columnar (HCOLS), every final game with
the closing spread and total from ESPN's line providers (pulled once by
tools/situations_pull.py; this module only appends finished games, fail-soft and
time-capped). Those are not Onyx's prices, so the page calls them "closing line".

Fixed up front, never tuned on results (so nothing is cherry-picked):
  * the features (computed only from what was known before tip):
      spread bucket, home / road / neutral, both teams' rating tier (a walk-forward
      margin rating: last season's rating, college basketball from last season's Torvik
      adj_em, then updated game by game; never the final season rating), conference
      (NFL: division) game, rest and rest edge, previous result (off a win / loss /
      upset loss / blowout), 3-game ATS streak, rematch, season phase, total bucket,
      line move from the open (when the open is known)
  * the templates (TEMPLATES) and their backoff order: the most specific bucket with
    at least CFG.nmin games is shown, else the next broader one
  * which spots a game shows: the core spot, then the first three that apply in the
    fixed order rematch, ATS streak, previous result, rest, line move, tiers
    (totals: core, then rest, line move, tier pair). Never "the best looking ones".
"""
import json, math, sys, time
from datetime import date, datetime, timedelta
from pathlib import Path

VERSION = 1
HCOLS = ["d", "id", "s", "pt", "h", "a", "hs", "as", "neu", "cg", "sp", "sp_open", "tot", "tot_open", "hml",
         "hpr", "apr", "opr", "upr"]   # closing prices: home / away spread, over / under (American)


def parse_odds(items):
    """ESPN core odds items -> the closing line fields (first non-live provider with a line)."""
    items = [i for i in items if "live" not in ((i.get("provider") or {}).get("name") or "").lower()] or items
    for it in items:
        if it.get("spread") is None and it.get("overUnder") is None:
            continue
        ho, ao = it.get("homeTeamOdds") or {}, it.get("awayTeamOdds") or {}
        o = {"sp": it.get("spread"), "tot": it.get("overUnder"), "hml": ho.get("moneyLine"),
             "hpr": ho.get("spreadOdds"), "apr": ao.get("spreadOdds"), "opr": it.get("overOdds"), "upr": it.get("underOdds")}
        try:
            o["sp_open"] = float(ho["open"]["pointSpread"]["american"])
        except Exception:
            o["sp_open"] = None
        try:
            o["tot_open"] = float(it["open"]["total"]["american"])
        except Exception:
            o["tot_open"] = None
        for k in ("hpr", "apr", "opr", "upr"):
            try:
                v = float(o[k])
                o[k] = int(v) if abs(v) >= 100 else None
            except (TypeError, ValueError):
                o[k] = None
        return o
    return None
DATA = Path("data")

NFL_DIV = {}
for _d, _ts in {"AE": "BUF MIA NE NYJ", "AN": "BAL CIN CLE PIT", "AS": "HOU IND JAX TEN", "AW": "DEN KC LV OAK LAC",
                "NE": "DAL NYG PHI WSH", "NN": "CHI DET GB MIN", "NS": "ATL CAR NO TB", "NW": "ARI LAR SF SEA"}.items():
    for _t in _ts.split():
        NFL_DIV[_t] = _d

# per sport: ESPN path, spread buckets (abs points, upper bounds), total buckets,
# rating tiers (rank cut points), rating update, blowout margin, rest buckets, phases,
# the minimum sample for a bucket before it backs off, line-move threshold
CFG = {
    "cbb": {"path": "basketball/mens-college-basketball", "q": "groups=50&limit=400",
            "sb": [3, 6.5, 10], "tb": [134.5, 144.5, 154.5], "tiers": [25, 75, 150], "hca": 3.0, "k": .08,
            "unk": -18.0, "blow": 20, "rest": [(1, "b2b"), (2, "1d"), (4, "2-3d"), (99, "4d+")], "redge": 1,
            "phase": {11: "early", 12: "early", 1: "conf", 2: "conf", 3: "march", 4: "march"},
            "nmin": 150, "mv": 1.5, "tmv": 2.0, "conf": "cg", "season": "end"},
    "nba": {"path": "basketball/nba", "q": "", "sb": [3, 6.5, 10], "tb": [214.5, 224.5, 234.5],
            "tiers": [8, 16, 23], "hca": 2.5, "k": .05, "unk": 0.0, "blow": 20,
            "rest": [(1, "b2b"), (2, "1d"), (99, "2d+")], "redge": 1,
            "phase": {10: "early", 11: "early", 12: "early", 1: "mid", 2: "mid", 3: "mid", 4: "late", 5: "late", 6: "late"},
            "nmin": 120, "mv": 1.5, "tmv": 2.0, "conf": None, "season": "end"},
    "nhl": {"path": "hockey/nhl", "q": "", "sb": None, "tb": [5.5, 6.0], "tiers": [8, 16, 24], "hca": .2, "k": .04,
            "unk": 0.0, "blow": 3, "rest": [(1, "b2b"), (2, "1d"), (99, "2d+")], "redge": 1,
            "phase": {10: "early", 11: "early", 12: "early", 1: "mid", 2: "mid", 3: "mid", 4: "late", 5: "late", 6: "late"},
            "nmin": 120, "mv": None, "tmv": .5, "conf": None, "season": "end"},
    "nfl": {"path": "football/nfl", "q": "", "sb": [3, 7], "tb": [40.5, 44.5, 48.5], "tiers": [8, 16, 24],
            "hca": 1.8, "k": .12, "unk": 0.0, "blow": 17, "rest": [(5, "short"), (8, "normal"), (99, "long")], "redge": 2,
            "phase": {8: "early", 9: "early", 10: "early", 11: "late", 12: "late", 1: "jan", 2: "jan"},
            "nmin": 60, "mv": 1.0, "tmv": 1.5, "conf": "div", "season": "start"},
    "cfb": {"path": "football/college-football", "q": "groups=80&limit=300", "sb": [3, 7, 14], "tb": [44.5, 54.5, 64.5],
            "tiers": [25, 60, 100], "hca": 2.5, "k": .12, "unk": -12.0, "blow": 21,
            "rest": [(5, "short"), (8, "normal"), (99, "long")], "redge": 2,
            "phase": {8: "early", 9: "early", 10: "mid", 11: "mid", 12: "post", 1: "post"},
            "nmin": 100, "mv": 1.5, "tmv": 2.0, "conf": "cg", "season": "start"},
}
PHASE_TXT = {
    "cbb": {"early": "Nov-Dec", "conf": "Jan-Feb", "march": "March and April"},
    "nba": {"early": "Oct-Dec", "mid": "Jan-Mar", "late": "April on"},
    "nhl": {"early": "Oct-Dec", "mid": "Jan-Mar", "late": "April on"},
    "nfl": {"early": "Sep-Oct", "late": "Nov-Dec", "jan": "January on"},
    "cfb": {"early": "August-September", "mid": "Oct-Nov", "post": "December on"},
}
REST_TXT = {"b2b": "on a back-to-back", "1d": "on one day of rest", "2-3d": "on two or three days of rest",
            "4d+": "on four or more days of rest", "2d+": "on two or more days of rest",
            "short": "on a short week", "normal": "on a normal week", "long": "off a bye or long week"}

# ATS templates: levels from most specific to broadest (the backoff order)
TEMPLATES = {
    "spot":   [("ven", "sb", "opp", "conf", "phase"), ("ven", "sb", "opp", "conf"), ("ven", "sb", "opp"), ("ven", "sb")],
    "rev":    [("fd", "rev", "conf"), ("fd", "rev")],
    "streak": [("fd", "ven", "streak"), ("fd", "streak")],
    "form":   [("fd", "ven", "prev"), ("fd", "prev")],
    "rest":   [("fd", "ven", "rest", "redge"), ("fd", "rest", "redge"), ("rest", "redge")],
    "move":   [("fd", "mv")],
    "tiers":  [("fd", "own", "opp")],
}
TTEMPLATES = {
    "tspot":  [("tb", "phase", "conf"), ("tb", "phase"), ("tb",)],
    "trest":  [("tb", "trest")],
    "tmove":  [("tb", "tmv")],
    "tpair":  [("tb", "tpair")],
}
SHOW = ["rev", "streak", "form", "rest", "move", "tiers"]     # after "spot", fixed order
TSHOW = ["trest", "tmove", "tpair"]                          # after "tspot"
NEEDS = {"rev": "rev", "streak": "streak", "move": "mv", "trest": "trest", "tmove": "tmv"}


# ---------------------------------------------------------------- history I/O
def hist_path(sport):
    return DATA / sport / "situations_hist.json"


def load_history(sport):
    try:
        h = json.loads(hist_path(sport).read_text(encoding="utf-8"))
        cols = h["cols"]
        return [dict(zip(cols, r)) for r in h["rows"]]
    except Exception:
        return []


def save_history(sport, rows):
    rows = sorted(rows, key=lambda r: (r["d"], str(r["id"])))
    out = {"v": VERSION, "cols": HCOLS, "n": len(rows), "rows": [[r.get(c) for c in HCOLS] for r in rows],
           "note": "Closing spread (home side) and total from ESPN's line providers. Not Onyx prices."}
    p = hist_path(sport)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)


def merge_history(sport, new_rows):
    """Dev tool entry (tools/situations_pull.py --write): new rows win on the same id."""
    by = {str(r["id"]): r for r in load_history(sport)}
    for r in new_rows:
        r = {c: r.get(c) for c in HCOLS}
        for c in ("hs", "as"):
            if r[c] is not None:
                r[c] = int(r[c])
        by[str(r["id"])] = r
    save_history(sport, list(by.values()))
    print(f"  {sport}: situations_hist.json {len(by)} games")


def season_of(sport, d):
    y, m = int(d[:4]), int(d[4:6])
    if CFG[sport]["season"] == "start":
        return y if m >= 7 else y - 1
    return y + 1 if m >= 8 else y


def update_history(sport, today, budget=25.0, max_days=10):
    """Pipeline: append the finished games since the history's last day (ESPN scoreboard +
    core odds, `requests` only). Fail-soft and time-capped: anything not reached waits for
    the next run. Returns the number of games added."""
    import requests
    from concurrent.futures import ThreadPoolExecutor
    rows = load_history(sport)
    if not rows:
        return 0
    t0 = time.time()
    cfg = CFG[sport]
    have = {str(r["id"]): r for r in rows}
    last = max(r["d"] for r in rows)
    d = datetime.strptime(last, "%Y%m%d").date() - timedelta(days=1)
    end = today - timedelta(days=1)
    if (end - d).days > 200:   # off-season gap: start at the new season, not every empty day
        d = end - timedelta(days=max_days)
    days = []
    while d <= end and len(days) < max_days:
        days.append(d)
        d += timedelta(days=1)
    sp_, lg = cfg["path"].split("/")
    H = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

    def odds(gid):
        if time.time() - t0 > budget:
            return gid, "skip"
        try:
            r = requests.get(f"https://sports.core.api.espn.com/v2/sports/{sp_}/leagues/{lg}/events/{gid}/competitions/{gid}/odds",
                             headers=H, timeout=10)
            if r.status_code != 200:
                return gid, None
            items = r.json().get("items", [])
        except Exception:
            return gid, "skip"
        return gid, parse_odds(items)

    added = 0
    for day in days:
        if time.time() - t0 > budget:
            break
        ds = day.strftime("%Y%m%d")
        try:
            r = requests.get(f"https://site.api.espn.com/apis/site/v2/sports/{cfg['path']}/scoreboard?dates={ds}"
                             + (f"&{cfg['q']}" if cfg["q"] else ""), headers=H, timeout=20)
            evs = r.json().get("events", []) if r.status_code == 200 else []
        except Exception:
            evs = []
        new = []
        for e in evs:
            c = (e.get("competitions") or [{}])[0]
            if ((c.get("status") or {}).get("type") or {}).get("name") != "STATUS_FINAL":
                continue
            if (e.get("season") or {}).get("type") not in (2, 3, None):   # no preseason / all-star
                continue
            side = {t.get("homeAway"): t for t in c.get("competitors") or []}
            if "home" not in side or "away" not in side:
                continue
            old = have.get(str(e["id"]))
            if old and (old.get("sp") is not None or old.get("tot") is not None):
                continue

            def sc(t):
                try:
                    return int(float(t.get("score")))
                except (TypeError, ValueError):
                    return None
            new.append({"d": ds, "id": str(e["id"]), "s": season_of(sport, ds),
                        "pt": 1 if (e.get("season") or {}).get("type") == 3 else 0,
                        "h": (side["home"].get("team") or {}).get("abbreviation"),
                        "a": (side["away"].get("team") or {}).get("abbreviation"),
                        "hs": sc(side["home"]), "as": sc(side["away"]),
                        "neu": 1 if c.get("neutralSite") else 0, "cg": 1 if c.get("conferenceCompetition") else 0})
        with ThreadPoolExecutor(6) as ex:
            got = dict(ex.map(lambda g: odds(g["id"]), new))
        for g in new:
            o = got.get(g["id"])
            if o == "skip":
                continue
            g.update({c: None for c in HCOLS[10:]})
            g.update(o or {})
            have[g["id"]] = g
            added += 1
    if added:
        save_history(sport, list(have.values()))
    return added


# ---------------------------------------------------------------- features
_DATES = {}


def _date(d):
    v = _DATES.get(d)
    if v is None:
        v = _DATES[d] = date(int(d[:4]), int(d[4:6]), int(d[6:8]))
    return v


def _bucket(v, cuts):
    for i, c in enumerate(cuts):
        if v <= c:
            return i
    return len(cuts)


def _tier(rank, cuts):
    return _bucket(rank, cuts) + 1


def tier_txt(sport, t):
    c = CFG[sport]["tiers"]
    return {1: f"top-{c[0]}", 2: f"{c[0] + 1}-{c[1]}", 3: f"{c[1] + 1}-{c[2]}", 4: f"{c[2] + 1}+"}[t]


def _cbb_prior():
    """College basketball preseason prior: last season's Torvik adj_em, by ESPN abbreviation."""
    try:
        tm = json.loads((DATA / "cbb" / "history" / "team_map.json").read_text())
        tv = json.loads((DATA / "cbb" / "history" / "teams.json").read_text())
    except Exception:
        return {}
    ab = {v["torvik"]: v["abbr"] for v in tm.values() if v.get("torvik") and v.get("abbr")}
    out = {}
    for s, rows in tv.items():
        out[int(s)] = {ab[r["team"]]: r["adj_em"] for r in rows if r.get("team") in ab and r.get("adj_em") is not None}
    return out


def sb_key(sport, team_sp, team_ml=None):
    """Spread bucket from the team's spread: 'F1'..'F4' favorites, 'D1'..'D4' dogs, 'PK'.
    NHL's puck line is always 1.5, so its buckets are by the favorite's moneyline."""
    cfg = CFG[sport]
    if sport == "nhl":
        if team_ml is None:
            return None
        fav = team_ml < 0 if team_ml not in (None, 0) else (team_sp is not None and team_sp < 0)
        big = abs(team_ml) > 150 if fav else team_ml > 140   # a +140 dog sits opposite a ~-160 favorite
        return ("F" if fav else "D") + ("2" if big else "1")
    if team_sp is None:
        return None
    if team_sp == 0:
        return "PK"
    return ("F" if team_sp < 0 else "D") + str(_bucket(abs(team_sp), cfg["sb"]) + 1)


def sb_txt(sport, k):
    cfg = CFG[sport]
    if k == "PK":
        return "pick'em"
    if sport == "nhl":
        return {"F1": "favorites of -150 or less", "F2": "favorites of -151 or more",
                "D1": "dogs of +140 or less", "D2": "dogs of +141 or more"}[k]
    cuts = cfg["sb"]
    i = int(k[1]) - 1
    lo = 0.5 if i == 0 else cuts[i - 1] + 0.5
    rng = f"{lo:g}-{cuts[i]:g}" if i < len(cuts) else f"{lo:g}+"
    return ("favorites" if k[0] == "F" else "dogs") + " of " + rng


def tb_key(sport, tot):
    if tot is None:
        return None
    return "T" + str(_bucket(tot, CFG[sport]["tb"]) + 1)


def tb_txt(sport, k):
    cuts = CFG[sport]["tb"]
    i = int(k[1]) - 1
    if i == 0:
        return f"totals of {cuts[0]:g} or lower"
    if i == len(cuts):
        return f"totals of {cuts[-1] + 0.5:g} or higher"
    return f"totals of {cuts[i - 1] + 0.5:g}-{cuts[i]:g}"


class Walk:
    """One pass over the history in date order, keeping each team's walk-forward rating
    and its season so far. side_feats() reads the state BEFORE the game is applied."""

    def __init__(self, sport):
        self.sport, self.cfg = sport, CFG[sport]
        self.r, self.rs = {}, {}          # rating, season of the rating
        self.st = {}                      # team -> season state
        self.prior = _cbb_prior() if sport == "cbb" else {}
        self.day, self.sorted = None, []
        self.ct = {}                      # (team, season) -> games played
        self.d1 = None
        if sport == "cbb":                # rank Division I teams only (non-D1 opponents sit below them)
            try:
                tm = json.loads((DATA / "cbb" / "history" / "team_map.json").read_text())
                self.d1 = {v["abbr"] for v in tm.values() if v.get("torvik") and v.get("abbr")}
            except Exception:
                self.d1 = None

    def _rating(self, t, s):
        if self.rs.get(t) != s:
            if self.sport == "cbb" and (s - 1) in self.prior:
                p = self.prior[s - 1].get(t)
                base = .7 * p if p is not None else (.6 * self.r[t] if t in self.r else self.cfg["unk"])
            else:
                base = .6 * self.r[t] if t in self.r else self.cfg["unk"]
            self.r[t], self.rs[t] = base, s
        return self.r[t]

    def _state(self, t, s):
        st = self.st.get(t)
        if not st or st["s"] != s:
            st = self.st[t] = {"s": s, "last": None, "prev": None, "ats": [], "met": {}}
        return st

    def new_day(self, d, s):
        if d != self.day:
            self.day = d
            self.sorted = sorted(-v for t, v in self.r.items() if self.in_pool(t, s))

    def in_pool(self, t, s):
        """Teams that count for a rank: D1 in college basketball; in college football the
        teams with a real schedule here (FCS teams show up only once or twice a year)."""
        if self.rs.get(t) not in (s, s - 1):
            return False
        if self.d1 is not None:
            return t in self.d1
        if self.sport == "cfb":
            return self.ct.get((t, s - 1), 0) >= 5 or self.ct.get((t, s), 0) >= 3
        return True

    def rank(self, t, s):
        import bisect
        v = self._rating(t, s)
        return bisect.bisect_left(self.sorted, -v) + 1

    def side_feats(self, g, home):
        sport, cfg = self.sport, self.cfg
        s, d = g["s"], g["d"]
        t, o = (g["h"], g["a"]) if home else (g["a"], g["h"])
        sp = g.get("sp")
        tsp = None if sp is None else (sp if home else -sp)
        ml = g.get("hml")
        tml = None if ml in (None, 0) else (ml if home else (-ml if abs(ml) >= 100 else None))
        if sport == "nhl" and tml is None and tsp is not None:
            tml = -130 if tsp < 0 else 120
        sb = sb_key(sport, tsp, tml)
        f = {"t": t, "o": o, "sb": sb, "fd": None if sb is None else sb[0] if sb != "PK" else "P",
             "ven": "N" if g.get("neu") else ("H" if home else "A")}
        rt, ro = self.rank(t, s), self.rank(o, s)
        f["own"], f["opp"] = _tier(rt, cfg["tiers"]), _tier(ro, cfg["tiers"])
        if cfg["conf"] == "cg":
            f["conf"] = "C" if g.get("cg") else "N"
        elif cfg["conf"] == "div":
            f["conf"] = "C" if NFL_DIV.get(t) and NFL_DIV.get(t) == NFL_DIV.get(o) else "N"
        else:
            f["conf"] = None
        f["phase"] = cfg["phase"].get(int(d[4:6]))
        if sport in ("nfl", "nba", "nhl") and g.get("pt"):
            f["phase"] = {"nfl": "jan", "nba": "late", "nhl": "late"}[sport]
        st, so = self._state(t, s), self._state(o, s)
        dd = _date(d)

        def rest_of(x):
            if not x["last"]:
                return None, None
            n = (dd - x["last"]).days
            for cut, lab in cfg["rest"]:
                if n <= cut:
                    return n, lab
            return n, cfg["rest"][-1][1]
        rn, f["rest"] = rest_of(st)
        on, _ = rest_of(so)
        f["redge"] = None if rn is None or on is None else ("+" if rn - on >= cfg["redge"] else "-" if on - rn >= cfg["redge"] else "=")
        f["prev"] = st["prev"]
        a3 = st["ats"][-3:]
        f["streak"] = "c3" if len(a3) == 3 and all(x == 1 for x in a3) else "f3" if len(a3) == 3 and all(x == 0 for x in a3) else None
        m = st["met"].get(o)
        f["rev"] = None if m is None else ("lost" if m < 0 else "won")
        f["mv"] = None
        if cfg["mv"] and g.get("sp_open") is not None and sp is not None:
            mv = (g["sp_open"] - sp) if home else (sp - g["sp_open"])   # + = the market moved toward this team
            f["mv"] = "to" if mv >= cfg["mv"] else "away" if mv <= -cfg["mv"] else None
        return f

    def game_feats(self, g, fh, fa):
        cfg = self.cfg
        f = {"tb": tb_key(self.sport, g.get("tot")), "phase": fh["phase"], "conf": fh["conf"]}
        short = {"b2b", "short"}
        f["trest"] = "short" if (fh["rest"] in short or fa["rest"] in short) else None
        f["tmv"] = None
        if g.get("tot_open") is not None and g.get("tot") is not None:
            mv = g["tot"] - g["tot_open"]
            f["tmv"] = "up" if mv >= cfg["tmv"] else "down" if mv <= -cfg["tmv"] else None
        hi = lambda x: x <= 2
        f["tpair"] = "hi" if hi(fh["own"]) and hi(fa["own"]) else "lo" if not hi(fh["own"]) and not hi(fa["own"]) else "mix"
        return f

    def apply(self, g):
        """Fold a finished game into the state (after its features were read)."""
        s, cfg = g["s"], self.cfg
        if g.get("hs") is None or g.get("as") is None:
            return
        dd = _date(g["d"])
        h, a = g["h"], g["a"]
        rh, ra = self._rating(h, s), self._rating(a, s)
        hca = 0 if g.get("neu") else cfg["hca"]
        margin = g["hs"] - g["as"]
        cap = 4 * cfg["blow"] / 3
        target = max(-cap, min(cap, margin))
        if g.get("sp") is not None and self.sport != "nhl":
            target = .5 * target + .5 * (-g["sp"])
        err = target - (rh - ra + hca)
        self.r[h], self.r[a] = rh + cfg["k"] * err, ra - cfg["k"] * err
        self.ct[(h, s)] = self.ct.get((h, s), 0) + 1
        self.ct[(a, s)] = self.ct.get((a, s), 0) + 1
        sp = g.get("sp")
        for home in (True, False):
            t, o = (h, a) if home else (a, h)
            st = self._state(t, s)
            m = margin if home else -margin
            tsp = None if sp is None else (sp if home else -sp)
            if m < 0 and tsp is not None and tsp < 0:
                prev = "upset"
            elif m <= -cfg["blow"]:
                prev = "blowL"
            elif m >= cfg["blow"]:
                prev = "blowW"
            else:
                prev = "W" if m > 0 else "L"
            st["prev"], st["last"] = prev, dd
            if tsp is not None and m + tsp != 0:
                st["ats"].append(1 if m + tsp > 0 else 0)
            st["met"][o] = m


def outcome(g, home):
    """(ats 1/0/None, cover margin or None) for a side, against the closing spread."""
    if g.get("sp") is None or g.get("hs") is None or g.get("as") is None:
        return None, None
    m = g["hs"] - g["as"]
    tsp = g["sp"] if home else -g["sp"]
    tm = m if home else -m
    c = tm + tsp
    return (None if c == 0 else 1 if c > 0 else 0), c


def tot_outcome(g):
    if g.get("tot") is None or g.get("hs") is None or g.get("as") is None:
        return None
    t = g["hs"] + g["as"] - g["tot"]
    return None if t == 0 else (1 if t > 0 else 0)


def featurize(sport, rows):
    """Every historical game -> (game, home feats, away feats, game feats), in date order."""
    W = Walk(sport)
    out = []
    for g in sorted(rows, key=lambda r: (r["d"], str(r["id"]))):
        if not g.get("h") or not g.get("a"):
            continue
        W.new_day(g["d"], g["s"])
        fh, fa = W.side_feats(g, True), W.side_feats(g, False)
        out.append((g, fh, fa, W.game_feats(g, fh, fa)))
        W.apply(g)
    return W, out


# ---------------------------------------------------------------- tables
def keys_for(f, levels):
    """The cell key at each level, or None where a feature is missing."""
    ks = []
    for i, lv in enumerate(levels):
        vals = tuple(f.get(x) for x in lv)
        ks.append(None if any(v is None for v in vals) else (i, vals))
    return ks


def applies(name, f):
    need = NEEDS.get(name)
    return need is None or f.get(need) is not None


def novig(a, b):
    """No-vig chance of side a from two American prices; a coin flip when a price is missing."""
    def imp(x):
        return 100 / (x + 100) if x > 0 else -x / (-x + 100)
    try:
        ia, ib = imp(float(a)), imp(float(b))
        return ia / (ia + ib)
    except (TypeError, ValueError, ZeroDivisionError):
        return .5


def price(x, default=-110):
    try:
        v = float(x)
        return v if abs(v) >= 100 else default
    except (TypeError, ValueError):
        return default


# a cell: [ats W, L, push, sum of cover margins, over, under, first season, last season,
#          sum of the closing price's no-vig chance (W/L games), games in that sum]
def _cell():
    return [0, 0, 0, 0.0, 0, 0, 9999, 0, 0.0, 0]


class Table:
    def __init__(self):
        self.c = {}
        self.memo = {}

    def out(self, sport, name, m):
        """spot_out, memoized per cell (a built table never changes)."""
        key = (name, m[0], m[2])
        o = self.memo.get(key)
        if o is None:
            o = self.memo[key] = spot_out(sport, name, m)
        return o

    def add_side(self, f, ats, cov, ou, s, e=.5):
        if f.get("sb") is None or cov is None:
            return
        for name, lv in TEMPLATES.items():
            if not applies(name, f):
                continue
            for k in keys_for(f, lv):
                if k is None:
                    continue
                c = self.c.get((name, k))
                if c is None:
                    c = self.c[(name, k)] = _cell()
                if ats is None:
                    c[2] += 1
                else:
                    c[0 if ats == 1 else 1] += 1
                    c[8] += e
                    c[9] += 1
                c[3] += cov
                if ou == 1:
                    c[4] += 1
                elif ou == 0:
                    c[5] += 1
                if s < c[6]:
                    c[6] = s
                if s > c[7]:
                    c[7] = s

    def add_game(self, f, ou, s, e=.5):
        if f.get("tb") is None or ou is None:
            return
        for name, lv in TTEMPLATES.items():
            if not applies(name, f):
                continue
            for k in keys_for(f, lv):
                if k is None:
                    continue
                c = self.c.get((name, k))
                if c is None:
                    c = self.c[(name, k)] = _cell()
                c[4 if ou == 1 else 5] += 1
                c[8] += e
                c[9] += 1
                if s < c[6]:
                    c[6] = s
                if s > c[7]:
                    c[7] = s

    def match(self, name, f, nmin, levels):
        """The most specific cell with n >= nmin; else the broadest that exists (flagged small)."""
        if not applies(name, f):
            return None
        best = None
        for k in keys_for(f, levels):
            if k is None:
                continue
            c = self.c.get((name, k))
            if not c:
                continue
            n = (c[0] + c[1]) if name in TEMPLATES else (c[4] + c[5])
            if n >= nmin:
                return k, c, False
            best = (k, c, True)
        return best


def binom_p(k, n, p0=.5):
    """Two-sided binomial p-value of k successes in n against chance p0 (exact up to 400,
    normal approximation past 400)."""
    if n == 0:
        return 1.0
    p0 = min(max(p0, 1e-6), 1 - 1e-6)
    if n > 400:
        z = abs(k - n * p0) / math.sqrt(n * p0 * (1 - p0))
        return math.erfc(z / math.sqrt(2))
    lg, l1, l0 = math.lgamma, math.log(p0), math.log(1 - p0)
    pmf = [lg(n + 1) - lg(i + 1) - lg(n - i + 1) + i * l1 + (n - i) * l0 for i in range(n + 1)]
    ref = pmf[k] + 1e-9
    return min(1.0, sum(math.exp(x) for x in pmf if x <= ref))


def sig_txt(p):
    return "very unusual" if p < .01 else "unusual" if p < .05 else "within normal luck"


def yrs(sport, a, b):
    f = (lambda s: f"{s - 1}-{str(s)[2:]}") if CFG[sport]["season"] == "end" else str
    return f(a) if a == b else f"{f(a)} to {f(b)}"


# ---------------------------------------------------------------- labels
VEN = {"H": "Home", "A": "Road", "N": "Neutral-site"}
PREV = {"W": "off a win", "L": "off a loss", "upset": "off an upset loss (lost as the favorite)",
        "blowL": "off a loss by {b}+", "blowW": "off a win by {b}+"}


def label(sport, name, k):
    i, vals = k
    lv = (TEMPLATES.get(name) or TTEMPLATES.get(name))[i]
    f = dict(zip(lv, vals))
    cfg = CFG[sport]
    who = None
    if "sb" in f:
        who = sb_txt(sport, f["sb"])
        who = (VEN[f["ven"]] + " " + who) if "ven" in f else who.capitalize()
        if f["sb"] == "PK":
            who = (VEN[f["ven"]] + " sides in pick'em games") if "ven" in f else "Pick'em sides"
    elif "fd" in f:
        base = {"F": "favorites", "D": "dogs", "P": "pick'em sides"}[f["fd"]]
        who = (VEN[f["ven"]] + " " + base) if "ven" in f else base.capitalize()
    bits = []
    if "own" in f:
        who = f"{who} rated {tier_txt(sport, f['own'])}"
    if "opp" in f:
        bits.append(f"vs a {tier_txt(sport, f['opp'])} team")
    if "rev" in f:
        bits.append("in a rematch they " + ("lost" if f["rev"] == "lost" else "won") + " earlier this season")
    if "streak" in f:
        bits.append("after covering 3 straight" if f["streak"] == "c3" else "after failing to cover 3 straight")
    if "prev" in f:
        bits.append(PREV[f["prev"]].format(b=cfg["blow"]))
    if "rest" in f:
        bits.append(REST_TXT[f["rest"]])
    if "redge" in f:
        bits.append({"+": "with more rest than the opponent", "=": "with the same rest as the opponent",
                     "-": "with less rest than the opponent"}[f["redge"]])
    if "mv" in f:
        bits.append(f"when the line moved {cfg['mv']:g}+ " + ("toward them" if f["mv"] == "to" else "against them") + " from the open")
    if "tb" in f:
        who = tb_txt(sport, f["tb"]).capitalize()
    if "trest" in f:
        bits.append("with a team on a back-to-back" if sport in ("cbb", "nba", "nhl") else "with a team on a short week")
    if "tmv" in f:
        bits.append(f"that moved {cfg['tmv']:g}+ " + ("up" if f["tmv"] == "up" else "down") + " from the open")
    if "tpair" in f:
        t2 = tier_txt(sport, 2).split("-")[-1]
        bits.append({"hi": f"between two top-{t2} teams", "lo": f"between two teams outside the top {t2}",
                     "mix": f"between a top-{t2} team and one outside it"}[f["tpair"]])
    who = who or "Teams"
    tail = []
    if "conf" in f:
        tail.append({"C": "division games" if sport == "nfl" else "conference play",
                     "N": "non-division" if sport == "nfl" else "non-conference"}[f["conf"]])
    if "phase" in f:
        tail.append(PHASE_TXT[sport][f["phase"]])
    return who + (" " + bits[0] if bits else "") + "".join(", " + b for b in bits[1:] + tail)


def spot_out(sport, name, m):
    k, c, small = m
    w, l, p = c[0], c[1], c[2]
    n = w + l
    e = c[8] / c[9] if c[9] else .5
    o = {"k": name, "t": label(sport, name, k), "n": n + p, "yrs": yrs(sport, c[6], c[7]), "small": small,
         "exp": round(e, 3)}
    if name in TEMPLATES:
        pv = binom_p(w, n, e)
        o.update({"w": w, "l": l, "p": p, "pct": round(w / n, 3) if n else None,
                  "cov": round(c[3] / (n + p), 1) if n + p else None, "ou": [c[4], c[5]], "pv": round(pv, 4), "sig": sig_txt(pv)})
    else:
        ov, un = c[4], c[5]
        pv = binom_p(ov, ov + un, e)
        o.update({"o": ov, "u": un, "n": ov + un, "pct": round(ov / (ov + un), 3) if ov + un else None,
                  "pv": round(pv, 4), "sig": sig_txt(pv)})
    return o


def side_spots(T, sport, f, nmin, limit=4):
    out = []
    m = T.match("spot", f, nmin, TEMPLATES["spot"])
    if m:
        out.append(T.out(sport, "spot", m))
    for name in SHOW:
        if len(out) >= limit:
            break
        m = T.match(name, f, nmin, TEMPLATES[name])
        if m:
            out.append(T.out(sport, name, m))
    return out


def total_spots(T, sport, f, nmin, limit=3):
    out = []
    for name in ["tspot"] + TSHOW:
        if len(out) >= limit:
            break
        m = T.match(name, f, nmin, TTEMPLATES[name])
        if m:
            out.append(T.out(sport, name, m))
    return out


def build_table(feats, before_season=None, before_day=None):
    T = Table()
    for g, fh, fa, fg in feats:
        if before_season is not None and g["s"] >= before_season:
            continue
        if before_day is not None and g["d"] >= before_day:
            continue
        ou = tot_outcome(g)
        eh = novig(g.get("hpr"), g.get("apr"))
        for f, home in ((fh, True), (fa, False)):
            ats, cov = outcome(g, home)
            if cov is None:
                continue
            T.add_side(f, ats, cov, ou, g["s"], eh if home else 1 - eh)
        T.add_game(fg, ou, g["s"], novig(g.get("opr"), g.get("upr")))
    return T


# ---------------------------------------------------------------- today's slate
def build(sport, slate, odds=None, today=None, refresh=True, budget=25.0):
    """The page payload: {gid: {"home": [...], "away": [...], "total": [...]}} plus meta.
    Fail-soft by design: the caller wraps it, and an error leaves the card off the page."""
    t0 = time.time()
    games = (slate or {}).get("games") or []
    if today is None:
        try:
            from sports_common import game_day   # the baseball day (ET - 4h), never the runner's UTC date
            today = game_day()
        except Exception:
            today = date.today()
    added = 0
    if refresh:
        try:
            added = update_history(sport, today, budget=budget)
        except Exception as ex:
            print(f"  situations: history update skipped ({str(ex)[:120]})")
    rows = load_history(sport)
    if not rows:
        return None
    cut = today.strftime("%Y%m%d")
    rows = [r for r in rows if r["d"] < cut]
    W, feats = featurize(sport, rows)
    T = build_table(feats)
    cfg = CFG[sport]
    og = ((odds or {}).get("games") or {}) if isinstance((odds or {}).get("games"), dict) else {}
    s_now = season_of(sport, cut)
    out = {}
    W.new_day(cut, s_now)
    for g in games:
        if g.get("state") not in (None, "pre"):
            continue
        gid = str(g.get("gid") or g.get("id"))
        o = og.get(gid) or {}
        sp = o.get("home_spread", g.get("spread"))
        tot = o.get("total", g.get("total"))
        hml = o.get("home_ml", g.get("home_ml"))
        if sp is None and tot is None:
            continue
        gd = cut
        try:   # the game's own ET date: rest is counted to the day it is played
            from zoneinfo import ZoneInfo
            st = datetime.fromisoformat(str(g.get("start")).replace("Z", "+00:00"))
            gd = max(cut, (st.astimezone(ZoneInfo("America/New_York")) - timedelta(hours=4)).strftime("%Y%m%d"))
        except Exception:
            pass
        x = {"d": gd, "s": s_now, "h": g.get("home"), "a": g.get("away"), "neu": 1 if g.get("neutral") else 0,
             "cg": 1 if g.get("conf") or g.get("conference") else 0, "sp": sp, "tot": tot, "hml": hml, "pt": 0}
        if sport == "cbb" and not g.get("conf"):
            # the slate does not carry ESPN's conference flag: two teams that already met in
            # conference play this season, or share a conference in last season's games, are
            # treated as a conference game
            x["cg"] = 1 if CONF_PAIRS.get(sport, {}).get(frozenset((x["h"], x["a"]))) else 0
        fh, fa = W.side_feats(x, True), W.side_feats(x, False)
        fg = W.game_feats(x, fh, fa)
        rec = {}
        if sp is not None:
            rec["home"], rec["away"] = side_spots(T, sport, fh, cfg["nmin"]), side_spots(T, sport, fa, cfg["nmin"])
            rec["line"] = sp
        if tot is not None:
            rec["total"] = total_spots(T, sport, fg, cfg["nmin"])
            rec["tot"] = tot
        rec["rank"] = {"home": W.rank(x["h"], s_now), "away": W.rank(x["a"], s_now)}
        out[gid] = rec
    seasons = sorted({r["s"] for r in rows})
    lined = sum(1 for r in rows if r.get("sp") is not None)
    bt = None
    try:
        bt = json.loads((DATA / sport / "situations_bt.json").read_text(encoding="utf-8"))
    except Exception:
        pass
    meta = {"v": VERSION, "games": len(rows), "lined": lined, "seasons": yrs(sport, seasons[0], seasons[-1]) if seasons else "",
            "nmin": cfg["nmin"], "added": added, "ms": int((time.time() - t0) * 1000),
            "bt": (bt or {}).get("line"), "bt_short": (bt or {}).get("short"), "bt_held": (bt or {}).get("held_line")}
    return {"meta": meta, "games": out}


CONF_PAIRS = {}


def conf_pairs(sport, rows):
    """Pairs of teams that played a conference game in the last two seasons (college sports)."""
    if not rows:
        return {}
    smax = max(r["s"] for r in rows)
    return {frozenset((r["h"], r["a"])): 1 for r in rows if r.get("cg") and r["s"] >= smax - 1}


def for_page(sport, slate, odds=None, refresh=True):
    """Wrapper the builds call: never raises."""
    try:
        if sport in ("cbb", "cfb"):
            CONF_PAIRS[sport] = conf_pairs(sport, load_history(sport))
        import os
        if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
            refresh = False      # CI builds from committed data only
        res = build(sport, slate, odds, refresh=refresh)
        if res:
            m = res["meta"]
            print(f"  situations: {len(res['games'])} games matched against {m['lined']} lined games "
                  f"({m['seasons']}), +{m['added']} new, {m['ms']} ms")
        return res
    except Exception as ex:
        print(f"  situations: skipped ({type(ex).__name__}: {str(ex)[:160]})")
        return None


if __name__ == "__main__":
    sp = (sys.argv[1:] or ["cbb"])[0]
    sl = json.loads((DATA / sp / "slate.json").read_text())
    try:
        od = json.loads((DATA / sp / "odds.json").read_text())
    except Exception:
        od = None
    r = for_page(sp, sl, od, refresh=False)
    if r:
        for gid, v in list(r["games"].items())[:3]:
            print(gid, json.dumps(v, indent=1)[:2500])
