#!/usr/bin/env python3
"""
daily_top.py - each sport's candidates for the home page's Top 10 plays of the day.

Every build (nba_build.py, sports_build.py) hands its priced Onyx sides here and
gets data/<sport>/top.json back: the plays its model likes at a mainstream price.
home.html reads every sport's file and ranks one Top 10 across them.

A candidate must:
  - be an Onyx main line priced -150 to +200 (no -179 / -195 juice; plus money
    welcome, nothing a casual bettor cannot find on any book)
  - be real value by the sport's own model: its chance beats the price's implied
    chance by 2+ points (edge >= 0.02) and the expected return is +3% or better
    (11/2: the old edge >= 0 let 0.2% "value" plays like Over 6 at -102 in)
  - not claim an edge over 12 points (that size is the model missing news, the
    same cap the live tab uses)
  - have a real chance to cash: 40%+ (a +150 play needs 44%+ to clear the +3%
    bar anyway). The old 50% floor shut out every plus-money price.
  - be for a game that has not started

Confidence is the sport's own blended chance (the number its page shows). Each
row says what it is: "tracked" (a graded pick on its page), "trial" (logged at
Onyx's opening price, on trial) or "lean" (the model's read, not graded).

Onyx Picks (11/2, picks.py): write() hands its plays to picks.hook, which logs a
play in a market finalized by tools/picks_backtest.py (this rule, held out, won at
Onyx's opening and closing prices on 60+ bets) once, at the price shown, and marks
it "pick": true. The home Top 10 labels those "Onyx Pick"; everything else is a
projection, not a pick.
Pipeline-safe: json only (picks.py adds requests for grading, fail-soft).
"""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

PRICE = (-150, 200)
MIN_CONF = 0.40
MIN_EDGE, MAX_EDGE, MIN_EV = 0.02, 0.12, 0.03
KEEP = 30
WORD = {"pts": "points", "reb": "rebounds", "ast": "assists", "pass_yds": "passing yards", "rush_yds": "rushing yards",
        "rec_yds": "receiving yards", "rec": "receptions", "pass_td": "passing TDs", "pass_att": "pass attempts", "pass_rush_yds": "passing + rushing yards",
        "rush_rec_yds": "rushing + receiving yards", "two_td": "2+ touchdowns", "three_td": "3+ touchdowns", "q1_total": "1st-quarter points",
        "h1_total": "1st-half points", "threes": "3-pointers made", "pra": "points + rebounds + assists",
        "pr": "points + rebounds", "pa": "points + assists"}


def _num(x):
    return f"{x:g}" if isinstance(x, (int, float)) else str(x)


def label(r):
    """'WPG +1.5', 'Over 6.5 · total', 'A. Jones Over 29.5 rushing yards'."""
    kind = r.get("kind") or "prop"
    side = "Over" if r.get("side") == "over" else "Under"
    if kind == "spread":
        return f"{r['name']} {r.get('line_txt') or ''}".strip()
    if kind == "ml":
        return f"{r['name']} to win"
    if kind == "total":
        return f"{side} {_num(r['line'])} {'total games' if r.get('name') == 'Total games' else 'total'}"
    mkt = r.get("mkt") or r.get("stat")
    if mkt == "anytime_td":
        return f"{r['name']} anytime TD"
    if mkt == "first_td":
        return f"{r['name']} first TD"
    if mkt == "first_basket":
        return f"{r['name']} first basket"
    if mkt in ("dbl_dbl", "trp_dbl"):           # 11/9: double-double / triple-double, a yes bet
        return f"{r['name']} {'double-double' if mkt == 'dbl_dbl' else 'triple-double'}"
    return f"{r['name']} {side} {_num(r['line'])} {WORD.get(mkt, mkt or '')}".strip()


def entry(sport, r, tag="lean", start=None):
    return {"sport": sport, "label": label(r), "matchup": r.get("matchup") or "", "start": r.get("start") or start,
            "gid": r.get("gid"), "who": r.get("pid") or r.get("name"), "price": r["price"], "conf": round(r["prob"], 4),
            "edge": round(r["edge"], 4), "ev": round(ev(r["price"], r["prob"]), 4) if r.get("price") and r.get("prob") is not None else None, "sel": r.get("sel"), "tag": tag,
            # what the home page needs to follow a saved pick live (saved.js / My picks)
            "kind": r.get("kind") or "prop", "mkt": r.get("mkt") or r.get("stat") or r.get("kind"), "side": r.get("side"),
            "line": r.get("line"), "hcap": _hcap(r), "name": r.get("name"), "team": r.get("team"),
            # the one-line reason the sport page's "Best plays today" shows (live.js spotHTML), from the model's own inputs
            "why": why(r),
            # 11/5: priced off the fallback market line (Onyx priced nothing): a lean, labelled "Market line"
            **({"src": "market"} if r.get("src") == "market" else {})}


def why(r):
    """One line from the model inputs: a prop's biggest drivers and its projection, else the game
    model's own detail (ratings, form, rest), else the projection against the line. None when the
    row carries none of them (the page then says our chance against Onyx's)."""
    try:
        parts = [f"Backup QB: {r['qb']}"] if r.get("qb") else []      # v15 NFL: a deep backup's receivers
        if r.get("proj") is not None and r.get("line") is not None and (r.get("kind") or "prop") == "prop":
            parts.append(f"Projects {float(r['proj']):.1f} against the {r['line']:g} line")
        drv = sorted([w for w in r.get("why") or [] if isinstance(w, dict) and w.get("k")], key=lambda w: -abs(w.get("pp") or 0))[:2]
        parts += [f"{w['k']} {w.get('v')} (avg {w.get('avg')})" for w in drv]
        if not parts and r.get("detail"):
            parts.append(str(r["detail"]))
        s = "; ".join(str(p) for p in parts if p).replace("\u2014", "-").strip()
        return (s[:157] + "...") if len(s) > 160 else (s or None)
    except Exception:
        return None


def _hcap(r):
    try:
        return float(r["line_txt"]) if r.get("kind") == "spread" and r.get("line_txt") else None
    except ValueError:
        return None


def ev(price, prob):
    """expected return per unit staked: prob x decimal odds - 1"""
    dec = 1 + (price / 100.0 if price > 0 else 100.0 / -price)
    return prob * dec - 1


# 11/6 (Jordan): a market can carry its own tuned rule, chosen on its tuning months by tools/picks_tune.py and
# judged on held-out games by tools/picks_backtest.py like every other. NBA 1st-half totals, unders only, edge
# 4 to 16 points: tuning +22.1% / +22.8% at the open / close on 90 bets, held out +22.3% / +8.1% on 63.
MKT_RULE = {("nba", "h1_total"): {"price": (-150, 200), "min_edge": 0.04, "max_edge": 0.16, "min_ev": 0.0, "min_conf": 0.40, "side": "under"}}


def ok(r, sport=None, mkt=None):
    R = MKT_RULE.get((sport, mkt or r.get("mkt")))
    if R:
        return (r.get("price") is not None and r.get("prob") is not None and r.get("edge") is not None
                and R["price"][0] <= r["price"] <= R["price"][1] and R["min_edge"] <= r["edge"] <= R["max_edge"]
                and r["prob"] >= R["min_conf"] and ev(r["price"], r["prob"]) >= R["min_ev"]
                and (R.get("side", "any") == "any" or r.get("side") == R["side"]))
    return (r.get("price") is not None and r.get("prob") is not None and r.get("edge") is not None
            and PRICE[0] <= r["price"] <= PRICE[1] and MIN_EDGE <= r["edge"] <= MAX_EDGE and r["prob"] >= MIN_CONF
            and ev(r["price"], r["prob"]) >= MIN_EV)


def write(data_dir, sport, date, rows):
    """rows: entry() dicts. Best value first (expected return); one per player or game
    market. Written every build so a quiet night is an empty list, not a stale one."""
    seen, out = set(), []
    for e in sorted(rows, key=lambda e: (-{"tracked": 2, "trial": 1}.get(e["tag"], 0), -e["ev"], -e["conf"])):
        k = (e["gid"], e["who"])
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    out = sorted(out, key=lambda e: (-e["ev"], -e["conf"]))[:KEEP]
    # Onyx Picks (picks.py): grade this sport's finished picks, then log a play in a
    # finalized market once, at this price, before its start; marks logged ones "pick"
    try:
        import picks
        picks.hook(sport, out)
    except Exception as x:
        print(f"  picks: skipped ({str(x)[:120]})")
    p = Path(data_dir) / "top.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"sport": sport, "date": date, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "plays": out}, separators=(",", ":")), encoding="utf-8")
    return out


BOARD_KEEP = 3000   # 11/9: NBA threes, combos, double- and triple-doubles joined the board


_NUM = re.compile(r"([+-]?\d+(?:\.\d+)?)\s*$")


LIVE_PROPS = {"anytime_td", "rec", "rec_yds", "rush_yds", "pass_yds", "pts", "reb", "ast", "goals", "sog", "points"}


def keep_pregame(data_dir, rows, hours=36):
    """data/<sport>/pregame.json: every game's last pregame Onyx line (spread by team, total,
    moneyline by side, and "pp": each player prop the live tab can price, line, our
    projection, and the over "o" and under "u" prices), captured only while the game has not started and kept 36 hours after.
    The board drops a game at its start; the live tab (live.js) starts each live chance from
    this line. Fail-soft: a bad file is rebuilt."""
    p = Path(data_dir) / "pregame.json"
    try:
        P = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        P = {}
    now = datetime.now(timezone.utc)

    def when(s):
        try:
            return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        except ValueError:
            return None
    # 11/6: each run's lines replace the game's saved lines whole (spread both sides, moneyline both
    # sides, total), so the two sides always come from the same moment (24 of 42 saved college
    # basketball spreads had one team's line from one run and the other's from another, e.g. both
    # teams getting points). A market-line run fills games Onyx has not priced (src "market"; the
    # live tab starts from it and says "market pregame"), and never overwrites a saved Onyx line.
    run = {}
    for e in rows:
        k = e.get("kind")
        st = when(e.get("start"))
        if k not in ("spread", "total", "ml", "prop") or not st or st <= now or not e.get("matchup"):
            continue
        mk = e.get("src") == "market"
        if k == "prop":
            if mk or e.get("mkt") not in LIVE_PROPS:
                continue      # props: Onyx prices only (the props archive is an Onyx record)
            g = P.setdefault(str(e.get("gid")), {"m": e["matchup"], "start": e.get("start"), "sp": {}, "ml": {}})
            g["m"], g["start"] = e["matchup"], e.get("start")
            # the player's pregame Onyx price and our projection: where a live player bet "started"
            if e.get("name") and e.get("price") is not None and e.get("side") in ("over", "under"):
                q = g.setdefault("pp", {}).setdefault(f"{e['name']}|{e['mkt']}", {})
                if q.get("l") != e.get("line"):
                    q.clear()
                q.update({"l": e.get("line"), "j": e.get("proj"), "lam": e.get("lam"), e["side"][0]: e["price"]})
            continue
        R = run.setdefault(str(e.get("gid")), {"m": e["matchup"], "start": e.get("start"), "onyx": {"sp": {}, "ml": {}}, "market": {"sp": {}, "ml": {}}})
        L = R["market" if mk else "onyx"]
        if k == "total" and e.get("line") is not None:
            L.setdefault("tot", e["line"])
        elif k == "spread":
            m = _NUM.search(str(e.get("label") or ""))
            if m:
                L["sp"].setdefault(e.get("name"), float(m.group(1)))
        elif k == "ml" and e.get("price") is not None:
            L["ml"].setdefault(e.get("name"), e["price"])
    for gid, R in run.items():
        src = "onyx" if (R["onyx"]["sp"] or R["onyx"]["ml"] or R["onyx"].get("tot") is not None) else "market"
        L = R[src]
        g = P.setdefault(gid, {"m": R["m"], "start": R["start"], "sp": {}, "ml": {}})
        sv = list((g.get("sp") or {}).values())
        whole = not (len(sv) == 2 and abs(sv[0] + sv[1]) > 0.6)       # a saved line whose two sides do not mirror is replaced
        if src == "market" and whole and g.get("src", "onyx") == "onyx" and (g.get("sp") or g.get("ml") or g.get("tot") is not None):
            continue          # a saved Onyx line stays the starting line
        g["m"], g["start"] = R["m"], R["start"]
        if L["sp"]:
            g["sp"] = dict(L["sp"])
        if L["ml"]:
            g["ml"] = dict(L["ml"])
        if L.get("tot") is not None:
            g["tot"] = L["tot"]
        if src == "market":
            g["src"] = "market"
        else:
            g.pop("src", None)
    # the archive the live player-prop backtest replays (tools/live_props_backtest.js): every game's
    # pregame props, kept 21 days (pregame.json itself keeps 36 hours, and the page loads it)
    a = Path(data_dir) / "prop_archive.json"
    try:
        A = json.loads(a.read_text(encoding="utf-8"))
    except Exception:
        A = {}
    for k, v in P.items():
        if v.get("pp"):
            A[k] = {"m": v["m"], "start": v.get("start"), "pp": v["pp"], "tot": v.get("tot"), "sp": v.get("sp")}
    A = {k: v for k, v in A.items() if (when(v.get("start")) or now) > now - timedelta(days=21)}
    a.write_text(json.dumps(A, separators=(",", ":")), encoding="utf-8")
    P = {k: v for k, v in P.items() if (when(v.get("start")) or now) > now - timedelta(hours=hours)}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(P, separators=(",", ":")), encoding="utf-8")


# The model's picks by category (11/14, Jordan: "top 5 picks ATS, top 5 totals, top 10 player props, top 10
# players to score TDs, top 5 players to score 2 TDs ... readily available pick information that doesn't need
# the search"). Model picks, not Onyx Picks: no NFL market has passed tools/picks_backtest.py, so they are
# never logged or graded (Jordan's choice, 11/14). Each list is ranked by the same rules Ask Onyx applies to
# "top N nfl <category>" (standard prices: nothing shorter than -200, 50%+ to hit, most likely first; touchdown
# lists have no floors), so the page and the search agree. Candidates are kept 4x deep so the page can drop
# games that have started and still fill each list, one play per game.
# 11/14 (Jordan: "where's tennis record where's nhl record ... no oversight into how it's actually performing"):
# every sport gets the same lists, and every play in them is graded in the Model record (model_record.py,
# data/picks/model_log.json), apart from the Onyx Picks record. Only markets the grader can settle are listed.
TD_MKTS = {"anytime_td", "first_td", "two_td", "three_td"}
NBA_PROPS = {"pts", "reb", "ast", "threes", "pr", "pa", "pra"}
_ATS = ("ats", "Top 5 against the spread", 5, lambda e: e.get("kind") == "spread", True)
_TOT = ("totals", "Top 5 totals", 5, lambda e: e.get("kind") == "total", True)
_ML = ("ml", "Top 5 moneylines", 5, lambda e: e.get("kind") == "ml", True)
_FBP = ("props", "Top 10 player props", 10, lambda e: e.get("kind") == "prop" and e.get("mkt") not in TD_MKTS and not e.get("no_read"), True)   # no_read: nfl_model v16
_TD = ("td", "Top 10 to score a touchdown", 10, lambda e: e.get("mkt") == "anytime_td", False)
TOPS = {
    "nfl": [_ATS, _TOT, _FBP, _TD, ("td2", "Top 5 to score 2+ touchdowns", 5, lambda e: e.get("mkt") == "two_td", False)],
    "cfb": [_ATS, _TOT, _FBP, _TD],
    "nba": [_ATS, _TOT, ("props", "Top 10 player props", 10, lambda e: e.get("kind") == "prop" and e.get("mkt") in NBA_PROPS, True)],
    "cbb": [_ATS, _TOT, _ML],
    "nhl": [("ats", "Top 5 puck lines", 5, lambda e: e.get("kind") == "spread", True), _ML, _TOT],
    "tennis": [("ml", "Top 5 match winners", 5, lambda e: e.get("kind") == "ml", True),
               ("ats", "Top 5 game spreads", 5, lambda e: e.get("kind") == "spread", True),
               ("totals", "Top 5 total games", 5, lambda e: e.get("kind") == "total", True)],
}


def write_tops(data_dir, sport, date, rows):
    """data/<sport>/tops.json: the model's picks in each TOPS category, ranked, 4x deep. Fail-soft."""
    if sport not in TOPS:
        return None
    out = tops(sport, date, rows)
    p = Path(data_dir) / "tops.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    try:                      # grade this sport's finished model plays, then log today's (fail-soft)
        import model_record
        model_record.hook(sport, out)
    except Exception as ex:
        print(f"  model record: skipped ({str(ex)[:120]})")
    return out


def tops(sport, date, rows, now=None):
    """The TOPS lists from board rows, as of `now` (tools/model_record_rebuild.py replays past boards)."""
    now = now or datetime.now(timezone.utc)

    def pre(e):
        try:
            return datetime.fromisoformat(str(e.get("start")).replace("Z", "+00:00")) > now
        except ValueError:
            return False
    lists = []
    for key, title, n, want, std in TOPS[sport]:
        c = [e for e in rows if want(e) and pre(e) and e.get("price") is not None and e.get("conf") is not None
             and e.get("src") != "market" and (not std or (e["price"] >= -200 and e["conf"] >= 0.5))]
        c.sort(key=lambda e: -(e["conf"] + (e.get("edge") or 0) / 10))   # Ask Onyx's "most likely first" key
        lists.append({"key": key, "title": title, "n": n, "rows": c[:4 * n]})
    return {"sport": sport, "date": date, "generated": now.isoformat(timespec="seconds"), "lists": lists}


def write_board(data_dir, sport, date, rows, teams=None):
    """data/<sport>/board.json: every priced Onyx side the model reads today,
    any price, for the home page's "Ask Onyx" search (it filters and builds
    parlays from this list; the AI only turns a sentence into a filter).
    rows: entry() dicts, plus "proj" and, for touchdown props, "lam" (expected
    touchdowns, so "2+ touchdowns" can be answered from the same number)."""
    seen, out = set(), []
    for e in rows:     # the team's full name, so "Ohio State" or "Georgia" finds its plays
        nm = (teams or {}).get(e.get("team") or (e.get("name") if e.get("kind") in ("spread", "ml") else None))
        if nm:
            e["tn"] = nm
    for e in sorted(rows, key=lambda e: -e["conf"]):
        k = (e["gid"], e["who"], e.get("mkt"), e.get("side"))
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    keep_pregame(data_dir, out)
    p = Path(data_dir) / "board.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"sport": sport, "date": date, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "plays": out[:BOARD_KEEP]}, separators=(",", ":")), encoding="utf-8")
    try:
        write_tops(data_dir, sport, date, out[:BOARD_KEEP])
    except Exception as ex:   # fail-soft: the board is what matters
        print(f"  tops: skipped ({str(ex)[:120]})")
    return out

