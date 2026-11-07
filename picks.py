#!/usr/bin/env python3
"""
picks.py - Onyx Picks: the plays we would bet, logged once and graded in public.

Jordan (11/2): "we need to track plays what it recommends not leans and trials
this is who I'd pick today with tracking and visibility".

  rule      the home Top 10 rule (daily_top.ok): Onyx main line -150 to +200, our
            chance beats the price by 2 to 12 points, expected return +3%+, 40%+
  finalized only markets whose held-out backtest under that rule won at Onyx's
            opening AND closing prices on 60+ bets (tools/picks_backtest.py ->
            data/picks/backtest.json), for the model VERSION it was run on. A model
            change sends its markets back to projections until the backtest is re-run.
  log       daily_top.write hands every build's qualifying plays here. A play in a
            finalized market is logged ONCE, at the Onyx price shown the moment it
            first qualifies, before its start: one per player (or game market) a game,
            best expected return first, up to CAP a sport a day.
  grade     ESPN final scores and box scores (summary API): W / L / P, or V (void: a
            player who did not play, a game never finished), and profit at the logged
            price, 1 unit a pick. A logged row is never edited except to add its result.

data/picks/ledger.json is append-only (validate_build's ledger list).
Pipeline-safe: json + requests only (zoneinfo for the ET day).

    python3 picks.py grade [sport ...]      # grade pending picks now
    python3 picks.py record                 # print the record
"""
import importlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:                # no tz database: a fixed -5h is within an hour of right
    ET = timezone(timedelta(hours=-5))

ROOT = Path(__file__).resolve().parent
DIR = ROOT / "data" / "picks"
LEDGER = DIR / "ledger.json"
BACKTEST = DIR / "backtest.json"
CAP = 5                          # picks per sport per day: a card, not a flood
ESPN = "https://site.api.espn.com/apis/site/v2/sports/"
PATH = {"nba": "basketball/nba", "nfl": "football/nfl", "cfb": "football/college-football", "nhl": "hockey/nhl",
        "cbb": "basketball/mens-college-basketball"}
# the module whose VERSION a market's backtest was run on
MODULE = {"nba": "nba_model", "nfl": "nfl_model", "cfb": "cfb_model", "nhl": "nhl_model", "tennis": "tennis_model", "cbb": "cbb_model"}
MODULE_MKT = {("cfb", m): "cfb_players" for m in ("rush_yds", "pass_yds", "rec", "rec_yds")}   # (sport, market) -> module, when a market has its own model module
# what the grader can settle (anything else is never logged)
GAME = ("ml", "spread", "total")
BOX = {"nba": {"pts": ("", "PTS"), "reb": ("", "REB"), "ast": ("", "AST")},
       "cbb": {"pts": ("", "PTS"), "reb": ("", "REB"), "ast": ("", "AST")},
       "nfl": {"rush_yds": ("rushing", "YDS"), "pass_yds": ("passing", "YDS"), "pass_att": ("passing", "C/ATT"),
               "rec": ("receiving", "REC"), "rec_yds": ("receiving", "YDS")},
       "cfb": {"rush_yds": ("rushing", "YDS"), "pass_yds": ("passing", "YDS"), "rec": ("receiving", "REC"),
               "rec_yds": ("receiving", "YDS")}}
# 11/6 (Jordan): markets that lock only at Onyx's opening price, the first price of the day the pipeline saw
# (open_lanes writes data/<sport>/opening.json). Their picks win at the open and lose by the close (NBA points:
# +9.4% at the open, -6.7% at the close on 53 held-out bets), so a pick logs only while the line and price
# still match the opener; tools/picks_backtest.py judges these markets at the open alone.
OPENER = {("nba", "pts")}
VOID_AFTER = timedelta(days=4)   # a game with no final 4 days after its start: void


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _when(s):
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def day_of(start):
    """The baseball day (ET minus 4 hours) a game belongs to. Never the UTC date."""
    return (start.astimezone(ET) - timedelta(hours=4)).date().isoformat()


def _load(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def load():
    rows = _load(LEDGER, [])
    return rows if isinstance(rows, list) else []


def save(rows):
    DIR.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(rows, indent=1), encoding="utf-8")


def payout(price):
    return price / 100.0 if price > 0 else 100.0 / -price


def gradable(sport, mkt):
    return sport in PATH and (mkt in GAME or mkt in ("q1_total", "h1_total") and sport == "nba" or mkt in BOX.get(sport, {}))


# ── which markets are finalized ─────────────────────────────────────────────
_FIN = None


def q1_signature(P):
    """The 1st-quarter total's own model: its share of the game total and its spread. A change to
    another open_lanes lane (first basket, assists) must not re-gate it, a change to these must."""
    return f"q1 {P['q1']}/{P['q1_sd']}"


H1_SIG = "h1 0.505/18"       # nba_build's 1st-half read (50.5% of the game total, sd 18), as tools/picks_replays records it


def live_version(sport, mkt):
    if (sport, mkt) == ("nba", "h1_total"):
        return H1_SIG
    if (sport, mkt) == ("nba", "q1_total"):
        try:
            OL = sys.modules.get("open_lanes") or importlib.import_module("open_lanes")
            return q1_signature(OL.P)
        except Exception:
            return None
    mod = MODULE_MKT.get((sport, mkt)) or MODULE.get(sport)
    if not mod:
        return None
    try:
        return getattr(sys.modules.get(mod) or importlib.import_module(mod), "VERSION", None)
    except Exception:
        return None


def finalized():
    """{(sport, market): backtest row} for markets that passed on the model version running now."""
    global _FIN
    if _FIN is None:
        bt = _load(BACKTEST, {}) or {}
        _FIN = {}
        for m in bt.get("markets") or []:
            if m.get("verdict") != "finalized":
                continue
            k = (m["sport"], m["market"])
            if gradable(*k) and live_version(*k) == m.get("version"):
                _FIN[k] = m
    return _FIN


def key(r):
    return (r["sport"], str(r.get("gid")), str(r.get("who")))


# ── log ─────────────────────────────────────────────────────────────────────
_OPEN = {}


def at_opener(sport, e, today):
    """True when this play's line and price are still Onyx's opening ones today (data/<sport>/opening.json,
    open_lanes.py): the first price the pipeline saw, never a baseline (a line already up at the first look)."""
    if sport not in _OPEN:
        _OPEN[sport] = _load(Path(f"data/{sport}/opening.json"), {}) or {}
    O = _OPEN[sport]
    if O.get("date") != today:
        return False
    op = (O.get(e.get("mkt")) or {}).get(f"{e.get('gid')}|{e.get('who')}")
    if not op or op.get("baseline") or op.get("line") != e.get("line"):
        return False
    return op.get(e.get("side")) == e.get("price")
def log(sport, plays, now=None, mark_only=False):
    """plays: daily_top entries from this build (already Top 10 qualified). Logs the
    finalized ones not logged before, up to CAP a sport a day, and marks every play that
    is a logged pick with "pick": True. Returns how many were added. mark_only: write
    nothing (the NBA lines-only run, whose commit carries no ledger file)."""
    now = now or _now()
    fin = finalized()
    rows = load()
    have = {key(r) for r in rows}
    per_day = {}
    for r in rows:
        if r["sport"] == sport:
            per_day[r["date"]] = per_day.get(r["date"], 0) + 1
    added = 0
    # 11/6 (Jordan: "we have a pick we lock in that shouldn't change ... we need recommendations at the
    # right time"): a pick locks on its own game day, at the price shown when it first qualifies that day,
    # never days early. While Onyx prices nothing in this sport (every play this build is on the market
    # line), a finalized market locks at the market line instead, marked src "market" ("Market line" on
    # picks.html); when Onyx is back, only Onyx prices lock again.
    today = (now.astimezone(ET) - timedelta(hours=4)).date().isoformat()
    outage = bool(plays) and all(e.get("src") == "market" for e in plays)
    for e in sorted(plays, key=lambda e: (-(e.get("ev") or 0), -(e.get("conf") or 0))):
        k = (sport, str(e.get("gid")), str(e.get("who")))
        if k in have:
            e["pick"] = True
            continue
        if mark_only or (sport, e.get("mkt")) not in fin:
            continue
        if e.get("src") == "market" and not outage:
            continue          # a market-line price locks only while Onyx prices nothing in this sport
        st = _when(e.get("start"))
        if not st or st <= now or e.get("price") is None or e.get("conf") is None:
            continue          # logged only before the start, at a real price
        d = day_of(st)
        if d != today:
            continue          # locked on game day, not days ahead
        if (sport, e.get("mkt")) in OPENER and not at_opener(sport, e, today):
            continue          # an opener market logs only at Onyx's first price of the day
        if per_day.get(d, 0) >= CAP:
            continue
        rows.append({"id": f"{sport}-{e.get('gid')}-{e.get('who')}-{e.get('mkt')}", "sport": sport, "date": d,
                     "logged_at": _iso(now), "start": e.get("start"), "gid": e.get("gid"), "matchup": e.get("matchup"),
                     "label": e.get("label"), "market": e.get("mkt"), "kind": e.get("kind"), "name": e.get("name"),
                     "team": e.get("team"), "who": e.get("who"), "side": e.get("side"), "line": e.get("line"),
                     "hcap": e.get("hcap"), "price": e["price"], "chance": e["conf"], "edge": e.get("edge"),
                     "ev": e.get("ev"), "sel": e.get("sel"), "model": fin[(sport, e.get("mkt"))].get("version"),
                     "result": None, "actual": None, "profit": None, "graded_at": None,
                     **({"src": "market"} if e.get("src") == "market" else {})})
        have.add(k)
        per_day[d] = per_day.get(d, 0) + 1
        e["pick"] = True
        added += 1
    if added:
        save(rows)
        print(f"  picks: logged {added} {sport} Onyx Pick(s){' at the market line (Onyx prices nothing)' if outage else ''}")
    return added


# ── grade ───────────────────────────────────────────────────────────────────
def _get(url, params):
    import requests
    for _ in range(2):
        try:
            r = requests.get(url, params=params, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
    return None


def _abbr(sport, a):
    a = (a or "").upper()
    if sport == "nba":
        try:
            from nba_common import team_abbr
            return (team_abbr(a) or a).upper()
        except Exception:
            return a
    return a


def _event_id(sport, r, cache):
    """ESPN's event id: the gid itself for the engine sports; NBA ids come from the odds feed,
    so its game is found on ESPN's scoreboard for that day by the two teams."""
    if sport != "nba":
        return str(r["gid"])
    st = _when(r.get("start"))
    teams = [t.strip() for t in str(r.get("matchup") or "").replace(" vs ", " @ ").split(" @ ")]
    if not st or len(teams) != 2:
        return None
    want = {_abbr(sport, t) for t in teams}
    for d in {st.astimezone(ET).date(), (st.astimezone(ET) - timedelta(hours=4)).date()}:
        ds = d.strftime("%Y%m%d")
        if ("sb", sport, ds) not in cache:
            cache[("sb", sport, ds)] = _get(ESPN + PATH[sport] + "/scoreboard", {"dates": ds}) or {}
        for ev in cache[("sb", sport, ds)].get("events") or []:
            cs = (ev.get("competitions") or [{}])[0].get("competitors") or []
            if {_abbr(sport, (c.get("team") or {}).get("abbreviation")) for c in cs} == want:
                return str(ev.get("id"))
    return None


def _num(v):
    try:
        return float(str(v).split("/")[-1]) if "/" in str(v) else float(v)
    except (TypeError, ValueError):
        return None


def _box_stat(sport, summ, r):
    """The player's number off ESPN's box score; 'void' when he did not play."""
    grp, lab = BOX[sport][r["market"]]
    name = _nk(r.get("name"))
    who = str(r.get("who") or "")
    played = False
    val = None
    for t in (summ.get("boxscore") or {}).get("players") or []:
        for st in t.get("statistics") or []:
            labels = st.get("labels") or []
            for a in st.get("athletes") or []:
                at = a.get("athlete") or {}
                if str(at.get("id")) != who and _nk(at.get("displayName")) != name:
                    continue
                if a.get("didNotPlay") or not a.get("stats"):
                    continue
                played = True
                if (not grp or st.get("name") == grp) and lab in labels:
                    raw = a["stats"][labels.index(lab)]
                    val = _num(raw.split("/")[1]) if lab == "C/ATT" and "/" in str(raw) else _num(raw)
    if not played:
        return "void"
    if val is None:
        if sport in ("nfl", "cfb") and r["market"] in ("rush_yds", "rec", "rec_yds"):
            return 0.0       # played, no carry or catch: 0 (a sure under, as Onyx settles it)
        return "void"
    return val


def _nk(s):
    import unicodedata
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = "".join(ch for ch in s if ch.isalnum() or ch == " ")
    for suf in (" jr", " sr", " ii", " iii", " iv"):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return " ".join(s.split())


def resolve(r, cache, now):
    """(result, actual) for a finished pick, or None while it is not final."""
    sport = r["sport"]
    st = _when(r.get("start"))
    if not st or now < st + timedelta(hours=2):
        return None
    eid = _event_id(sport, r, cache)
    summ = None
    if eid:
        if ("sum", sport, eid) not in cache:
            cache[("sum", sport, eid)] = _get(ESPN + PATH[sport] + "/summary", {"event": eid}) or {}
        summ = cache[("sum", sport, eid)]
    comp = (((summ or {}).get("header") or {}).get("competitions") or [{}])[0]
    stt = ((comp.get("status") or {}).get("type") or {})
    if stt.get("state") != "post" or not stt.get("completed", True):
        if now > st + VOID_AFTER:
            return "V", None                 # postponed / never final
        return None
    side = {c.get("homeAway"): c for c in comp.get("competitors") or []}
    try:
        score = {_abbr(sport, (c.get("team") or {}).get("abbreviation")): float(c.get("score")) for c in side.values()}
    except (TypeError, ValueError):
        return None
    m, line = r["market"], r.get("line")
    if m == "total":
        act = sum(score.values())
    elif m == "q1_total":
        try:
            act = sum(float((c.get("linescores") or [{}])[0].get("displayValue", (c.get("linescores") or [{}])[0].get("value")))
                      for c in side.values())
        except (TypeError, ValueError, IndexError):
            return None
    elif m == "h1_total":         # the 1st and 2nd quarters (11/6)
        try:
            act = sum(sum(float(q.get("displayValue", q.get("value"))) for q in (c.get("linescores") or [])[:2])
                      for c in side.values())
            if any(len(c.get("linescores") or []) < 2 for c in side.values()):
                return None
        except (TypeError, ValueError):
            return None
    elif m in ("ml", "spread"):
        me = _abbr(sport, r.get("name"))
        if me not in score or len(score) != 2:
            return None
        other = next(v for k, v in score.items() if k != me)
        margin = score[me] - other
        if m == "ml":
            return ("W" if margin > 0 else "L" if margin < 0 else "P"), margin
        adj = margin + float(r.get("hcap") or 0.0)
        return ("W" if adj > 0 else "L" if adj < 0 else "P"), margin
    elif m in BOX.get(sport, {}):
        act = _box_stat(sport, summ, r)
        if act == "void":
            return "V", None
    else:
        return None
    if line is None:
        return None
    if act == line:
        return "P", act
    return ("W" if (act > line) == (r.get("side") == "over") else "L"), act


def grade(sports=None, now=None):
    """Settle every pending pick whose game is final. Returns how many were graded."""
    now = now or _now()
    rows = load()
    cache, n = {}, 0
    for r in rows:
        if r.get("result") or (sports and r["sport"] not in sports):
            continue
        try:
            got = resolve(r, cache, now)
        except Exception as x:
            print(f"  picks: grade {r.get('id')}: {x}")
            got = None
        if not got:
            continue
        r["result"], r["actual"] = got
        r["profit"] = round(payout(r["price"]), 4) if got[0] == "W" else -1.0 if got[0] == "L" else 0.0
        r["graded_at"] = _iso(now)
        n += 1
    if n:
        save(rows)
        print(f"  picks: graded {n}")
    return n


def record(rows=None):
    rows = load() if rows is None else rows

    def agg(rs):
        w = sum(1 for r in rs if r.get("result") == "W")
        l_ = sum(1 for r in rs if r.get("result") == "L")
        u = sum(r.get("profit") or 0.0 for r in rs if r.get("result"))
        return {"w": w, "l": l_, "p": sum(1 for r in rs if r.get("result") in ("P", "V")),
                "pending": sum(1 for r in rs if not r.get("result")), "units": round(u, 2),
                "roi": round(u / (w + l_), 4) if w + l_ else None}
    out = {"all": agg(rows), "sport": {}, "market": {}}
    for r in rows:
        out["sport"].setdefault(r["sport"], []).append(r)
        out["market"].setdefault(f"{r['sport']}:{r['market']}", []).append(r)
    out["sport"] = {k: agg(v) for k, v in out["sport"].items()}
    out["market"] = {k: agg(v) for k, v in out["market"].items()}
    return out


def hook(sport, plays):
    """daily_top.write's hook: grade this sport's finished picks, then log today's. Fail-soft.
    The NBA lines-only run (NBA_LINES_ONLY=1, nba_lines.yml) commits no ledger, so it only
    marks plays already logged; the full builds (daily / refresh) log and grade."""
    if os.environ.get("NBA_LINES_ONLY") == "1" or os.environ.get("ONYX_PICKS_DRY") == "1":
        try:
            log(sport, plays, mark_only=True)
        except Exception:
            pass
        return
    try:
        if sport in PATH and any(not r.get("result") and r["sport"] == sport for r in load()):
            grade([sport])
    except Exception as x:
        print(f"  picks: grading skipped ({str(x)[:120]})")
    try:
        log(sport, plays)
    except Exception as x:
        print(f"  picks: logging skipped ({str(x)[:120]})")


if __name__ == "__main__":
    cmd = (sys.argv[1:] or ["record"])[0]
    if cmd == "grade":
        print(f"graded {grade(sys.argv[2:] or None)}")
    print(json.dumps(record(), indent=1))
