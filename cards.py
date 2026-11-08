#!/usr/bin/env python3
"""
cards.py - the team and player cards (11/2): data/<sport>/cards.json.

Jordan, 11/2: "every sport needs this for every team as a whole and player, we should
have team history trends everything we need to explain why we are getting to the number."

Built by sports_build.py (NFL, college football, NHL, college basketball, tennis) and
nba_build.py (NBA teams; NBA players keep their own card in nba_shell.html). The page
(cards.js) fetches the file only when a card opens, so nothing here weighs on load.
Fail-soft everywhere: a team or player that errors is left out, a sport that errors
keeps yesterday's file. Never a pick, never a ledger, never the Top 10.

What a card may show, and only this:
  * numbers the sport's model really uses (its ratings, projections, chances, weights),
  * the facts they rest on (scores, box scores, depth charts, Torvik seasons),
  * Onyx's prices, labelled Onyx, and the closing line from ESPN's line providers
    (data/<sport>/situations_hist.json, written by situations.py), labelled "closing
    line", never Onyx.
An input the data does not carry is left out, never filled in.

Team:  {name, logo, rec, ats, ou, seasons[], recent[], trends[], game{}, inj[], key[]}
Player: {n, team, pos, role, use, proj, seasons[], base{}, last5[], why[], mk[]}
"""

import json, math
from datetime import date, datetime, timezone
from pathlib import Path

from sports_common import nk
import sports_lab as L

V = 1
DEFAULT_W = 0.3          # the lab blend (sports_build.DEFAULT_W) for markets no backtest has weighted
FOOTBALL = ("nfl", "cfb")
HEADSHOT = {"nfl": "https://a.espncdn.com/i/headshots/nfl/players/full/{id}.png",
            "cfb": "https://a.espncdn.com/i/headshots/college-football/players/full/{id}.png",
            "cbb": "https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/{id}.png"}
MKT = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec_yds": "Receiving yards", "rec": "Receptions",
       "pass_td": "Passing TDs", "pass_att": "Pass attempts", "pass_rush_yds": "Pass + rush yards",
       "rush_rec_yds": "Rush + rec yards", "anytime_td": "Anytime TD", "first_td": "First TD", "two_td": "2+ TDs", "three_td": "3+ TDs",
       "points": "Points", "assists": "Assists", "goals": "Goals", "shots": "Shots on goal", "rebounds": "Rebounds",
       "threes": "Threes made", "saves": "Saves"}


def _r(v, d=1):
    return None if v is None else round(v, d)


def _iso(d):
    """'20251103' or '2025-11-03' -> '2025-11-03'."""
    d = str(d or "")
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 and d.isdigit() else d[:10]


def season_label(key, s):
    if s is None:
        return ""
    return str(s) if key in FOOTBALL else f"{int(s) - 1}-{str(s)[2:]}"


def _days(a, b):
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days
    except Exception:
        return None


# ── closing lines: situations.py's history (ESPN's line providers, never Onyx) ──
def closing_lines(lane, key):
    """{espn game id: {"sp": home closing spread, "tot": closing total}} plus the rows
    themselves (older seasons the results file does not hold)."""
    rows = []
    try:
        H = json.loads((lane.data / "situations_hist.json").read_text(encoding="utf-8"))
        cols = H.get("cols") or []
        rows = [dict(zip(cols, r)) for r in H.get("rows") or []]
    except Exception:
        rows = []
    if not rows and key == "cbb":       # college basketball keeps its own pull (tools/cbb_history.py)
        for p in sorted((lane.data / "history").glob("games_*.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                s = int(p.stem.split("_")[1])
                for g in d if isinstance(d, list) else []:
                    rows.append(dict(g, s=s, neu=g.get("neu")))
            except Exception:
                continue
    by = {}
    for r in rows:
        if r.get("id") is not None:
            by[str(r["id"])] = r
    return by, rows


def team_games(lane, key, lines_by, hist_rows):
    """Every final we hold, one row per game: results.json (this season and last) joined
    to its closing line, plus older seasons from the closing-line history."""
    out = {}
    res = (lane.load("results.json", {}) or {}).get("games") or []
    for g in res:
        if g.get("hs") is None or g.get("as") is None:
            continue
        ln = lines_by.get(str(g.get("id"))) or {}
        out[str(g["id"])] = {"id": str(g["id"]), "d": g["date"][:10], "s": g.get("season"), "h": g["home"], "a": g["away"],
                             "hs": g["hs"], "as": g["as"], "neu": bool(g.get("neutral")), "ot": bool(g.get("ot")),
                             "sp": ln.get("sp"), "tot": ln.get("tot")}
    for r in hist_rows:
        k = str(r.get("id"))
        if k in out or r.get("hs") is None or r.get("as") is None:
            continue
        out[k] = {"id": k, "d": _iso(r.get("d")), "s": r.get("s"), "h": r.get("h"), "a": r.get("a"), "hs": r["hs"], "as": r["as"],
                  "neu": bool(r.get("neu")), "ot": False, "sp": r.get("sp"), "tot": r.get("tot")}
    by_team = {}
    for g in sorted(out.values(), key=lambda g: g["d"]):
        for side in ("h", "a"):
            by_team.setdefault(g[side], []).append(g)
    return by_team


def _view(g, team, key):
    """One game from a team's side: its score, result, its closing spread and the cover."""
    home = g["h"] == team
    pf, pa = (g["hs"], g["as"]) if home else (g["as"], g["hs"])
    res = "W" if pf > pa else "L" if pf < pa else "T"
    if res == "L" and key == "nhl" and g.get("ot"):
        res = "OTL"
    sp = None if g.get("sp") is None else (g["sp"] if home else -g["sp"])
    cov = None
    if sp is not None:
        m = pf - pa + sp
        cov = "W" if m > 0 else "L" if m < 0 else "P"
    ou = None
    if g.get("tot") is not None:
        t = pf + pa
        ou = "O" if t > g["tot"] else "U" if t < g["tot"] else "P"
    return {"d": g["d"], "s": g["s"], "opp": g["a"] if home else g["h"], "ha": "N" if g.get("neu") else ("H" if home else "A"),
            "pf": pf, "pa": pa, "r": res, "sp": sp, "cov": cov, "tot": g.get("tot"), "ou": ou}


def _tally(vs):
    su = {"W": 0, "L": 0, "T": 0, "OTL": 0}
    ats = {"W": 0, "L": 0, "P": 0}
    ou = {"O": 0, "U": 0, "P": 0}
    for v in vs:
        su[v["r"]] += 1
        if v["cov"]:
            ats[v["cov"]] += 1
        if v["ou"]:
            ou[v["ou"]] += 1
    return {"n": len(vs), "w": su["W"], "l": su["L"], "t": su["T"], "otl": su["OTL"],
            "ats": [ats["W"], ats["L"], ats["P"]], "ou": [ou["O"], ou["U"], ou["P"]]}


def _rest_bucket(key, days):
    if days is None:
        return None
    if key in FOOTBALL:
        return "Short week (5 days or less)" if days <= 5 else "Normal week (6 to 8 days)" if days <= 8 else "Long rest (9+ days)"
    return "Back-to-back" if days <= 1 else "One day off" if days == 2 else "Two+ days off"


def _sp_bucket(key, sp):
    if sp is None or sp == 0:
        return None
    cut = {"nfl": (3, 7), "cfb": (7, 14), "cbb": (5, 10), "nba": (5, 10)}.get(key)
    if not cut:
        return None
    a = abs(sp)
    who = "Favored" if sp < 0 else "Underdog"
    if a <= cut[0]:
        return f"{who} by {cut[0]:g} or less"
    if a <= cut[1]:
        return f"{who} by {cut[0] + .5:g} to {cut[1]:g}"
    return f"{who} by more than {cut[1]:g}"


def team_history(key, team, games, season_now, ratings_by_season=None):
    """Header records, last 3 seasons, last 10 games and trends with their sample sizes."""
    vs = [_view(g, team, key) for g in games]
    out = {}
    cur = [v for v in vs if v["s"] == season_now]
    out["rec"] = _tally(cur)
    seasons = sorted({v["s"] for v in vs if v["s"] is not None}, reverse=True)[:3]
    out["seasons"] = []
    for s in seasons:
        sv = [v for v in vs if v["s"] == s]
        t = _tally(sv)
        t.update(s=s, label=season_label(key, s), pf=_r(sum(v["pf"] for v in sv) / len(sv)), pa=_r(sum(v["pa"] for v in sv) / len(sv)))
        rt = (ratings_by_season or {}).get(s)
        if rt:
            t["rt"] = rt
        out["seasons"].append(t)
    out["recent"] = [{k: v[k] for k in ("d", "opp", "ha", "pf", "pa", "r", "sp", "cov", "tot", "ou")} for v in vs[-10:]][::-1]
    # trends: this season and last, each split with its sample
    inwin = lambda v: v["s"] is not None and season_now is not None and v["s"] >= season_now - 1
    prev = None
    rows = {}
    for v in vs:
        if not inwin(v):
            prev = v
            continue
        keys = []
        keys.append({"H": "At home", "A": "On the road", "N": "Neutral site"}[v["ha"]])
        if v["sp"] is not None and v["sp"] != 0:
            keys.append("As the favorite" if v["sp"] < 0 else "As the underdog")
            b = _sp_bucket(key, v["sp"])
            if b:
                keys.append(b)
        if prev is not None and prev["s"] == v["s"]:
            keys.append("Off a win" if prev["r"] == "W" else "Off a loss")
            rb = _rest_bucket(key, _days(prev["d"], v["d"]))
            if rb:
                keys.append(rb)
        for k in keys:
            rows.setdefault(k, []).append(v)
        prev = v
    order = ["At home", "On the road", "Neutral site", "As the favorite", "As the underdog"]
    order += sorted(k for k in rows if k.startswith("Favored"))
    order += sorted(k for k in rows if k.startswith("Underdog"))
    order += ["Off a win", "Off a loss", "Short week (5 days or less)", "Normal week (6 to 8 days)", "Long rest (9+ days)",
              "Back-to-back", "One day off", "Two+ days off"]
    out["trends"] = [dict(_tally(rows[k]), k=k) for k in order if k in rows]
    out["trend_window"] = (f"{season_label(key, season_now - 1)} and {season_label(key, season_now)}"
                           if season_now is not None else "")
    out["last_d"] = vs[-1]["d"] if vs else None
    return out


# ── the game in front of the team: the model's number against Onyx's ───────
def _sides(o, pr, w, home, away):
    """Each side of each Onyx game line: Onyx price and selection, the model's chance,
    the blended chance (the sport's blend weight on the model, the rest on Onyx's price
    with the margin removed)."""
    out = []

    def add(kind, lab, team, price, oprice, sel, pm):
        fo, _ = L.fair_pair(price, oprice)
        if fo is None or price is None:
            return
        out.append({"k": kind, "lab": lab, "team": team, "price": price, "sel": sel,
                    "pm": _r(pm, 4) if pm is not None else None,
                    "pb": _r(L.blend(pm, fo, w), 4) if pm is not None else _r(fo, 4), "fair": _r(fo, 4)})
    if o.get("home_ml") is not None and o.get("away_ml") is not None:
        add("ml", f"{away} moneyline", away, o["away_ml"], o["home_ml"], o.get("away_ml_sel"), None if pr is None else 1 - pr["home_win"])
        add("ml", f"{home} moneyline", home, o["home_ml"], o["away_ml"], o.get("home_ml_sel"), None if pr is None else pr["home_win"])
    sp = o.get("home_spread")
    if sp is not None and o.get("home_spread_price") is not None and o.get("away_spread_price") is not None:
        hc = None if pr is None else pr["home_cover"](sp)
        add("spread", f"{away} {-sp:+g}", away, o["away_spread_price"], o["home_spread_price"], o.get("away_spread_sel"), None if hc is None else 1 - hc)
        add("spread", f"{home} {sp:+g}", home, o["home_spread_price"], o["away_spread_price"], o.get("home_spread_sel"), hc)
    t = o.get("total")
    if t is not None and o.get("over_price") is not None and o.get("under_price") is not None:
        po = None if pr is None else pr["over"](t)
        add("total", f"Over {t:g}", None, o["over_price"], o["under_price"], o.get("over_sel"), po)
        add("total", f"Under {t:g}", None, o["under_price"], o["over_price"], o.get("under_sel"), None if po is None else 1 - po)
    return out


def game_why(key, team, g, R, GP, w, odds, kind):
    """The team's game on this slate: rating components, the projection, Onyx's line,
    and both sides of each market with model, blended and Onyx chances."""
    import team_model as T
    home = g["home"] == team
    opp = g["away"] if home else g["home"]
    o = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
    out = {"gid": g["gid"], "opp": opp, "home": home, "neutral": bool(g.get("neutral")), "start": g.get("start"),
           "state": g.get("state"), "w": w}
    if R is not None and R["n"].get(g["home"], 0) >= GP.get("min_games", 3) and R["n"].get(g["away"], 0) >= GP.get("min_games", 3):
        eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
        pr = (T.hk_probs if kind == "hockey" else T.fb_probs)(eh, ea, GP)
        us, them = (eh, ea) if home else (ea, eh)
        out["model"] = {"for": _r(us, 2), "against": _r(them, 2), "margin": _r(us - them, 2), "total": _r(eh + ea, 2),
                        "win": _r(pr["home_win"] if home else 1 - pr["home_win"], 4),
                        "mu": _r(R.get("mu"), 2), "home_edge": _r(0.0 if g.get("neutral") else R.get("home"), 2),
                        "off": _r(R["off"].get(team), 2), "def": _r(R["def"].get(team), 2),
                        "opp_off": _r(R["off"].get(opp), 2), "opp_def": _r(R["def"].get(opp), 2),
                        "n": R["n"].get(team, 0), "opp_n": R["n"].get(opp, 0)}
        if R.get("pace") and R.get("tempo"):      # college basketball v2: possessions x efficiency
            pc = R["pace"]
            out["model"]["poss"] = _r(R["tempo"] * math.exp(pc.get(g["home"], 0.0) + pc.get(g["away"], 0.0)), 1)
            out["model"]["tempo"] = _r((R.get("poss") or {}).get(team), 1)
            out["model"]["opp_tempo"] = _r((R.get("poss") or {}).get(opp), 1)
            out["model"]["avg_tempo"] = _r(R["tempo"], 1)
        if kind == "hockey":
            out["model"]["sd"] = None
        else:
            out["model"]["sd_margin"], out["model"]["sd_total"] = GP.get("sd_margin"), GP.get("sd_total")
    else:
        pr = None
    if o:
        tsp = o.get("home_spread") if home else o.get("away_spread")
        out["onyx"] = {"spread": tsp, "total": o.get("total"), "ml": o.get("home_ml") if home else o.get("away_ml"),
                       "implied": _r((o["total"] - (tsp or 0.0)) / 2, 1) if o.get("total") is not None else None}
        out["sides"] = _sides(o, pr, w, g["home"], g["away"])
    return out


def _rest(games_by_team, team, day):
    """Days since the team's last game; None for a season opener (more than 30 days)."""
    gs = [g for g in games_by_team.get(team) or [] if g["d"] < day]
    if not gs:
        return None, None
    d = _days(gs[-1]["d"], day)
    return (d if d is not None and d <= 30 else None), gs[-1]["d"]


# ── season ratings for the history table ───────────────────────────────────
def model_ratings_by_season(games_by_team, GP, seasons):
    """The team model's offense and defense at the end of each season (points or goals
    against average), fitted on that season's games only."""
    import team_model as T
    allg = {}
    for gs in games_by_team.values():
        for g in gs:
            allg[g["id"]] = g
    out = {}
    for s in seasons:
        rows = [{"date": g["d"], "home": g["h"], "away": g["a"], "hs": g["hs"], "as": g["as"], "neutral": g.get("neu")}
                for g in allg.values() if g["s"] == s]
        if len(rows) < 20:
            continue
        end = date.fromordinal(date.fromisoformat(max(r["date"] for r in rows)).toordinal() + 1).isoformat()
        R = T.fit(rows, end, GP)            # the day after the last game: every game of the season counts
        out[s] = {t: {"off": _r(R["off"].get(t), 2), "def": _r(R["def"].get(t), 2)} for t in R["n"]}
    return out


def torvik_by_season(lane, seasons):
    """College basketball: Torvik's adjusted ratings per season, keyed by ESPN abbreviation."""
    try:
        teams = json.loads((lane.data / "history" / "teams.json").read_text(encoding="utf-8"))
        tmap = json.loads((lane.data / "history" / "team_map.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    look = {}
    for v in tmap.values():
        if v.get("torvik") and v.get("abbr"):
            look[v["torvik"]] = v["abbr"]
    out = {}
    for s in seasons:
        rows = teams.get(str(s)) or []
        out[s] = {look[r["team"]]: {"adj_o": r.get("adj_o"), "adj_d": r.get("adj_d"), "adj_em": r.get("adj_em"),
                                    "tempo": r.get("tempo"), "rank": r.get("rank"), "rec": r.get("rec")}
                  for r in rows if r.get("team") in look}
    return out


# ── players ───────────────────────────────────────────────────────────────
def _dist_nfl(M, r):
    """The distribution the NFL model priced this market with (None: a market model on
    Onyx's price, which has no distribution of its own)."""
    if r.get("v11") is not None:
        return None
    p = r.get("proj")
    if p is None:
        return None
    if r.get("ptd"):
        return {"t": "p", "m": p}
    if r.get("vol"):
        c = M.VOL_P[r["mkt"]]["c"]
        sd = max(0.6, c * math.sqrt(max(p, 0.3))) if r["mkt"] == "rec" else max(5.0, c * math.sqrt(max(p, 1.0)) * 3.2)
        return {"t": "n", "m": p, "s": round(sd, 2)}
    if r["mkt"] == "rec":
        return {"t": "nb", "m": p, "v": round(M.REC_VAR * p, 3)}
    if r["mkt"] in M.PROP_SD:
        a, b = M.PROP_SD[r["mkt"]]
        return {"t": "n", "m": p, "s": round(a + b * p, 2)}
    return None


def _dist_cfb(C, r):
    if r.get("v2") is not None or r.get("proj") is None:
        return None
    p = r["proj"]
    if r["mkt"] == "rec":
        return {"t": "nb", "m": p, "v": round(C.REC_VAR * max(p, 0.3), 3)}
    if r["mkt"] in C.SD:
        a, b = C.SD[r["mkt"]]
        return {"t": "n", "m": p, "s": round(a + b * p, 2)}
    return None


def _p_over(dist, line):
    if dist is None or line is None:
        return None
    if dist["t"] == "n":
        return L.normal_over(dist["m"], dist["s"], line)
    if dist["t"] == "p":
        return L.count_over(dist["m"], line)
    return L.count_over(dist["m"], line, dist.get("v"))


def _mk_from_row(r, dist, note=None):
    """A market from a priced model row: P(over) by the model and blended, both sides
    priced. Rows keep only the side they lean; the other side is the complement."""
    m = {"m": r["mkt"], "name": MKT.get(r["mkt"], r["mkt"]), "line": r.get("line"), "over": r.get("over"), "under": r.get("under"),
         "over_sel": r.get("over_sel"), "under_sel": r.get("under_sel"), "proj": r.get("proj"), "dist": dist}
    if r.get("side") and r.get("model_p") is not None and r.get("prob") is not None:
        ov = r["side"] == "over"
        m["pm"] = _r(r["model_p"] if ov else 1 - r["model_p"], 4)
        m["pb"] = _r(r["prob"] if ov else 1 - r["prob"], 4)
    elif dist is not None and r.get("line") is not None:
        m["pm"] = _r(_p_over(dist, r["line"]), 4)
    if r.get("why"):
        m["why"] = r["why"]
    if r.get("v11") is not None or r.get("v2") is not None:
        m["mm"] = True       # a market model: Onyx's price moved by statistics, no projection distribution
    if r.get("role_flag"):
        m["nc"] = "role"
    if r.get("inj"):
        m["inj"] = r.get("inj_d") or "Questionable"
    if note:
        m["note"] = note
    return m


def _mk_count(p, mean, var, w, note):
    """A count market (NHL points, college points) priced from a projection the card
    names, blended at the lab weight. Never recommended: not backtested against Onyx."""
    dist = {"t": "p", "m": mean} if var is None else {"t": "nb", "m": mean, "v": round(var, 3)}
    m = {"m": p["mkt"], "name": MKT.get(p["mkt"], p["mkt"]), "line": p.get("line"), "over": p.get("over"), "under": p.get("under"),
         "over_sel": p.get("over_sel"), "under_sel": p.get("under_sel"), "proj": _r(mean, 2), "dist": dist, "nc": note, "untested": True}
    po = _p_over(dist, p.get("line"))
    m["pm"] = _r(po, 4)
    fo, _ = L.fair_pair(p.get("over"), p.get("under"))
    if po is not None and fo is not None:
        m["pb"] = _r(L.blend(po, fo, w), 4)
    return m


def _mk_onyx(p):
    """An Onyx market the model does not price: Onyx's price only."""
    m = {"m": p["mkt"], "name": MKT.get(p["mkt"], p["mkt"]), "line": p.get("line"), "over": p.get("over"), "under": p.get("under"),
         "over_sel": p.get("over_sel"), "under_sel": p.get("under_sel"), "nc": "onyx"}
    if p["mkt"] in ("anytime_td", "first_td", "two_td", "three_td") and p.get("under") is None:
        m["yes"] = True
    return m


def _slate_teams(slate):
    """Teams with a game on this slate that has not finished: team -> game."""
    out = {}
    for g in sorted(slate.get("games") or [], key=lambda g: (g.get("state") == "post", g.get("start") or "")):
        if g.get("state") == "post":
            continue
        for t in (g.get("home"), g.get("away")):
            if t and t not in out:
                out[t] = g
    return out


def _props_by(odds):
    out = {}
    for p in (odds or {}).get("props") or []:
        out.setdefault(nk(p.get("name")), []).append(p)
    return out


def _order(mk, main):
    """His main market first, then the markets the model prices, then Onyx-only lines,
    touchdown scorer markets last."""
    def rank(m):
        return (m["m"] != main, m["m"] in ("anytime_td", "first_td", "two_td", "three_td"), m.get("pm") is None, m.get("line") is None)
    return sorted(mk, key=rank)


def _team_env(odds, g, team):
    o = ((odds or {}).get("games") or {}).get(g["gid"]) or {}
    if o.get("total") is None:
        return None, None
    hsp = o.get("home_spread") or 0.0
    sp = hsp if team == g["home"] else -hsp
    return round((o["total"] - sp) / 2, 1), sp


FB_COLS = {"QB": ["att", "pass_yds", "pass_td", "int", "rush_yds"],
           "RB": ["rush_att", "rush_yds", "rec", "rec_yds"],
           "WR": ["tgt", "rec", "rec_yds", "rec_td"], "TE": ["tgt", "rec", "rec_yds", "rec_td"]}
FB_LAB = {"att": "Att", "cmp": "Cmp", "pass_yds": "Pa Yds", "pass_td": "Pa TD", "int": "Int", "rush_yds": "Ru Yds",
          "rush_att": "Car", "rush_td": "Ru TD", "tgt": "Tgt", "rec": "Rec", "rec_yds": "Re Yds", "rec_td": "TD"}
BADGE = {"pass_yds": "PASS YDS", "rush_yds": "RUSH YDS", "rec_yds": "REC YDS"}
FB_MAIN = {"QB": "pass_yds", "RB": "rush_yds", "WR": "rec_yds", "TE": "rec_yds"}


def football_players(key, lane, slate, odds, model, depth, R, GP):
    import nfl_model as N
    rows = (lane.load("player_games.json", {}) or {}).get("rows") or []
    season = slate.get("season") or max((r["season"] for r in rows), default=None)
    if key == "nfl":
        mrows = [r for r in model.get("_cands") or [] if r.get("pid")]
        dist_of = lambda r: _dist_nfl(N, r)
    else:
        import cfb_players as C
        mrows = [r for r in model.get("rows") or [] if r.get("pid")]
        dist_of = lambda r: _dist_cfb(C, r)
    by_pid = {}
    for r in rows:
        by_pid.setdefault(r["pid"], []).append(r)
    gtot = {}         # (game, team) -> the team's targets and carries in that game
    for r in rows:
        t = gtot.setdefault((r["gid"], r["team"]), [0.0, 0.0])
        t[0] += r.get("tgt") or 0.0
        t[1] += r.get("rush_att") or 0.0
    # what each defense allowed per game this season, by stat, for the opponent rank
    allowed = {}
    for r in rows:
        if r["season"] != season:
            continue
        a = allowed.setdefault(r["opp"], {"g": set()})
        a["g"].add(r["gid"])
        for s in ("pass_yds", "rush_yds", "rec_yds", "rec"):
            a[s] = a.get(s, 0.0) + (r.get(s) or 0.0)
    ranks = {}
    for s in ("pass_yds", "rush_yds", "rec_yds", "rec"):
        per = {t: v.get(s, 0.0) / len(v["g"]) for t, v in allowed.items() if v["g"]}
        order = sorted(per, key=lambda t: per[t])    # 1 = allows the fewest
        ranks[s] = {t: (i + 1, len(order)) for i, t in enumerate(order)}

    def opp_rank(opp, s):
        return ranks.get(s, {}).get(opp, (None, None))
    mby = {}
    for r in mrows:
        mby.setdefault(str(r["pid"]), {})[r["mkt"]] = r
    td = {}
    for r in model.get("td") or []:
        td[str(r.get("pid"))] = r
    props = _props_by(odds)
    weather = lane.load("weather.json", {}) or {}
    slate_t = _slate_teams(slate)
    unit_lab = (depth or {}).get("use_label") or "Usage"
    out = {}
    for team, g in slate_t.items():
        dt = ((depth or {}).get("teams") or {}).get(team) or {}
        opp = g["away"] if g["home"] == team else g["home"]
        imp, tsp = _team_env(odds, g, team)
        for p in dt.get("players") or []:
            pos = p.get("pos") if p.get("pos") in FB_COLS else None
            if not pos or (p.get("tier") in ("Bench", "Out") and nk(p.get("n")) not in props):
                continue      # the rotation and anyone Onyx prices: keeps each team's file small
            try:
                pid = str(p.get("id"))
                gs = by_pid.get(pid) or []
                cols = FB_COLS[pos]
                card = {"id": pid, "n": p.get("n"), "team": team, "opp": opp, "home": g["home"] == team, "gid": g["gid"],
                        "start": g.get("start"), "pos": p.get("pos"), "role": p.get("role"), "tier": p.get("tier"),
                        "tag": p.get("tag"), "q": bool(p.get("q")),
                        "hs": (gs[-1].get("hs") if gs else None) or HEADSHOT[key].format(id=pid),
                        "use": p.get("use"), "use_lab": unit_lab, "proj": p.get("proj") or {}}
                # seasons (box scores we hold) and the model's baseline row
                card["cols"] = [[c, FB_LAB[c]] for c in cols]
                seas = []
                for s in sorted({x["season"] for x in gs}, reverse=True)[:3]:
                    sg = [x for x in gs if x["season"] == s]
                    seas.append({"s": season_label(key, s), "t": sg[-1]["team"], "gp": len(sg),
                                 **{c: _r(sum(x.get(c) or 0.0 for x in sg) / len(sg)) for c in cols}})
                card["seasons"] = seas
                pj = p.get("proj") or {}
                card["base"] = {c: pj.get(c) for c in cols if pj.get(c) is not None}
                card["base_lab"] = "model, per game"
                card["last5"] = [{"d": x["date"][5:], "opp": x["opp"], "ha": "vs" if x.get("home") else "@",
                                  **{c: _r(x.get(c) or 0.0, 0) for c in cols}} for x in gs[-5:]][::-1]
                # why this number
                why = []
                if p.get("use") is not None:
                    why.append({"k": unit_lab, "v": f"{round(p['use'])}%", "d": "projected share of the offense's snaps" if key == "nfl" else "projected share of the team's touches"})
                cur = [x for x in gs if x["season"] == season and x["team"] == team]
                if cur:
                    t_tgt = sum(gtot.get((x["gid"], team), (0.0, 0.0))[0] for x in cur)
                    t_car = sum(gtot.get((x["gid"], team), (0.0, 0.0))[1] for x in cur)
                    my_t = sum(x.get("tgt") or 0.0 for x in cur)
                    my_c = sum(x.get("rush_att") or 0.0 for x in cur)
                    if pos in ("WR", "TE", "RB") and t_tgt and my_t:
                        why.append({"k": "Target share", "v": f"{100 * my_t / t_tgt:.0f}%", "d": f"{my_t:.0f} of {t_tgt:.0f} team targets in his {len(cur)} games"})
                    if pos in ("RB", "QB") and t_car and my_c:
                        why.append({"k": "Carry share", "v": f"{100 * my_c / t_car:.0f}%", "d": f"{my_c:.0f} of {t_car:.0f} team carries in his {len(cur)} games"})
                if dt.get("pace") is not None:
                    why.append({"k": (depth or {}).get("pace_label") or "Team pace", "v": f"{dt['pace']:.1f}", "d": f"{team} offensive plays per game"})
                if imp is not None:
                    why.append({"k": "Team total", "v": f"{imp:.1f}", "d": f"implied by Onyx · spread {tsp:+g}"})
                ms = FB_MAIN[pos]
                mr = (mby.get(pid) or {}).get(ms)
                rk, nt = opp_rank(opp, ms)
                if mr and mr.get("opp_f") is not None:
                    f = mr["opp_f"]
                    why.append({"k": f"{opp} vs {MKT[ms].lower()}", "v": f"{(f - 1) * 100:+.0f}%",
                                "d": (f"ranks {rk} of {nt} (1 = allows fewest)" if rk else "") + (" · " if rk else "") + "the model's opponent adjustment"})
                elif rk:
                    why.append({"k": f"{opp} vs {MKT[ms].lower()}", "v": f"#{rk}", "d": f"of {nt} defenses, 1 = allows the fewest per game"})
                wx = weather.get(g["gid"]) or {}
                if wx.get("roof") in ("dome", "closed"):
                    why.append({"k": "Weather", "v": "Dome", "d": "no wind or rain"})
                elif wx.get("wind") is not None:
                    why.append({"k": "Wind", "v": f"{wx['wind']:.0f} mph", "d": "kickoff forecast" + (f" · {wx['temp']:.0f}°F" if wx.get("temp") is not None else "")})
                card["why"] = why
                # markets: every Onyx line on him, priced where the model prices it
                mk, seen = [], set()
                for pp in props.get(nk(p.get("n"))) or []:
                    if pp.get("gid") != g["gid"] or pp["mkt"] in seen:
                        continue
                    seen.add(pp["mkt"])
                    r = (mby.get(pid) or {}).get(pp["mkt"])
                    if r is not None and r.get("line") == pp.get("line"):
                        mk.append(_mk_from_row(r, dist_of(r)))
                    elif pp["mkt"] in ("anytime_td", "first_td", "two_td", "three_td") and td.get(pid):
                        t = td[pid]
                        kk = {"anytime_td": "any", "first_td": "first", "two_td": "two", "three_td": "three"}[pp["mkt"]]
                        m = _mk_onyx(pp)
                        if t.get(kk) is not None:
                            m.update(pb=t[kk], pm=t.get(kk + "_model"), yes=True, nc="td_any" if kk == "any" else "td_info")
                            m.pop("under", None)
                        mk.append(m)
                    else:
                        mk.append(_mk_onyx(pp))
                for s, r in (mby.get(pid) or {}).items():      # projections Onyx has no line on yet
                    if s not in seen and r.get("proj") is not None:
                        mk.append({"m": s, "name": MKT.get(s, s), "proj": r["proj"], "dist": dist_of(r), "nc": "noline"})
                card["mk"] = _order(mk, ms)
                mr = (mby.get(pid) or {}).get(ms)
                bv = mr["proj"] if mr and mr.get("proj") is not None else pj.get(ms)
                if bv is not None:
                    card["badge"] = [round(bv, 1), "PROJ " + BADGE[ms]]
                out[nk(p.get("n")) + "|" + team] = card
            except Exception as ex:
                print(f"  cards: {key} player {p.get('n')}: {str(ex)[:100]}")
    return out


def hockey_players(lane, slate, odds, depth, R, GP, w):
    import team_model as T
    pg = lane.load("player_games.json", {}) or {}
    cols = pg.get("cols") or []
    rows = [dict(zip(cols, r)) for r in pg.get("rows") or []]
    g_teams = {}
    for r in rows:
        g_teams.setdefault(r["gid"], set()).add(r["team"])
    by = {}
    for r in rows:
        by.setdefault(str(r["pid"]), []).append(r)
    props = _props_by(odds)
    season = str(pg.get("season") or (depth or {}).get("season") or "")
    out = {}
    for team, g in _slate_teams(slate).items():
        dt = ((depth or {}).get("teams") or {}).get(team) or {}
        opp = g["away"] if g["home"] == team else g["home"]
        exp_for = None
        if R is not None and R["n"].get(g["home"], 0) >= GP.get("min_games", 3) and R["n"].get(g["away"], 0) >= GP.get("min_games", 3):
            eh, ea = T.expect(R, g["home"], g["away"], g.get("neutral"))
            exp_for = eh if g["home"] == team else ea
        og = [x for x in (((depth or {}).get("teams") or {}).get(opp) or {}).get("players") or [] if x.get("grp") == "G"]
        for p in dt.get("players") or []:
            if p.get("grp") == "G":
                continue
            try:
                pid = str(p.get("id"))
                gs = sorted(by.get(pid) or [], key=lambda x: x["date"])
                card = {"id": pid, "n": p.get("n"), "team": team, "opp": opp, "home": g["home"] == team, "gid": g["gid"],
                        "start": g.get("start"), "pos": p.get("pos"), "role": p.get("role"), "tier": p.get("tier"), "tag": p.get("tag"),
                        "hs": f"https://assets.nhle.com/mugs/nhl/{season}/{team}/{pid}.png" if season else None,
                        "use": p.get("use"), "use_lab": "Ice time", "proj": p.get("proj") or {}}
                cl = [["toi", "TOI"], ["g", "G"], ["a", "A"], ["pts", "PTS"], ["sog", "SOG"]]
                card["cols"] = cl
                seas = []
                for lab, src in (("This season", p.get("now")), ("Last season", p.get("last"))):
                    if src and src.get("gp"):
                        seas.append({"s": lab, "t": team if lab == "This season" else "", "gp": src.get("gp"), "toi": src.get("use"),
                                     "g": src.get("g"), "a": src.get("a"), "pts": src.get("pts"), "sog": src.get("sog")})
                card["seasons"] = seas
                pj = p.get("proj") or {}
                card["base"] = {"toi": p.get("use"), **{k: pj.get(k) for k in ("g", "a", "pts", "sog")}}
                card["base_lab"] = "model, per game"
                card["last5"] = [{"d": x["date"][5:], "opp": next(iter(g_teams.get(x["gid"], set()) - {team}), ""), "ha": "",
                                  "toi": _r(x.get("toi")), "g": x.get("g"), "a": x.get("a"), "pts": (x.get("g") or 0) + (x.get("a") or 0),
                                  "sog": x.get("sog")} for x in gs[-5:]][::-1]
                why = []
                if p.get("use") is not None:
                    why.append({"k": "Ice time", "v": f"{p['use']:.1f}", "d": "projected minutes a game"})
                if p.get("role"):
                    why.append({"k": "Line", "v": str(p["role"]), "d": f"from {team}'s latest game ({dt.get('lines_from') or 'ice time'})"})
                toi = sum(x.get("toi") or 0 for x in gs)
                if toi >= 60:
                    why.append({"k": "Shots per 60", "v": f"{60 * sum(x.get('sog') or 0 for x in gs) / toi:.1f}", "d": f"this season · {len(gs)} games"})
                    why.append({"k": "Points per 60", "v": f"{60 * sum((x.get('g') or 0) + (x.get('a') or 0) for x in gs) / toi:.2f}", "d": "this season"})
                if exp_for is not None:
                    why.append({"k": "Team goals", "v": f"{exp_for:.2f}", "d": f"the team model's expectation vs {opp} tonight"})
                if og:
                    g1 = og[0]
                    why.append({"k": f"{opp} goalie", "v": shortname(g1.get("n")), "d": f"{round(g1['use'])}% of recent starts" if g1.get("use") is not None else "most recent starts"})
                if dt.get("pace") is not None:
                    why.append({"k": "Team shots", "v": f"{dt['pace']:.1f}", "d": f"{team} shots per game"})
                card["why"] = why
                mk, seen = [], set()
                key_of = {"points": "pts", "assists": "a", "goals": "g", "shots": "sog"}
                for pp in props.get(nk(p.get("n"))) or []:
                    if pp.get("gid") != g["gid"] or pp["mkt"] in seen:
                        continue
                    seen.add(pp["mkt"])
                    st = key_of.get(pp["mkt"])
                    if st and pj.get(st) is not None:
                        mk.append(_mk_count(pp, pj[st], None, w, "nhl"))
                    else:
                        mk.append(_mk_onyx(pp))
                card["mk"] = _order(mk, "points")
                if pj.get("pts") is not None:
                    card["badge"] = [round(pj["pts"], 2), "PROJ POINTS"]
                out[nk(p.get("n")) + "|" + team] = card
            except Exception as ex:
                print(f"  cards: nhl player {p.get('n')}: {str(ex)[:100]}")
    return out


def shortname(n):
    w = str(n or "").split()
    return (w[0][0] + ". " + " ".join(w[1:])) if len(w) > 1 else (n or "")


def cbb_players(lane, slate, odds, depth, R, w):
    pg = lane.load("player_games.json", {}) or {}
    cols = pg.get("cols") or []
    rows = [dict(zip(cols, r)) for r in pg.get("rows") or []]
    by = {}
    for r in rows:
        by.setdefault(str(r["pid"]), []).append(r)
    # Torvik seasons: last season's team and name find him, his id finds the rest
    tv = {}
    for s in (2024, 2025, 2026, 2027):
        try:
            d = json.loads((lane.data / "history" / f"players_{s}.json").read_text(encoding="utf-8"))
            c = d["cols"]
            tv[s] = [dict(zip(c, r)) for r in d["rows"]]
        except Exception:
            tv[s] = []
    tv_key = {s: {(nk(r.get("n")), r.get("t")): r for r in rs} for s, rs in tv.items()}
    tv_pid = {s: {r.get("pid"): r for r in rs} for s, rs in tv.items()}
    try:
        from nba_model import SD as NBA_SD          # the NBA model's fitted spreads, borrowed and labelled
    except Exception:
        NBA_SD = {}
    torvik = torvik_by_season(lane, [max(tv) - 1]) if tv else {}
    props = _props_by(odds)
    out = {}
    for team, g in _slate_teams(slate).items():
        dt = ((depth or {}).get("teams") or {}).get(team) or {}
        opp = g["away"] if g["home"] == team else g["home"]
        for p in dt.get("players") or []:
            if (p.get("use") or 0) < 8 and nk(p.get("n")) not in props:
                continue      # under 8 projected minutes and no Onyx line: the depth chart has him
            try:
                pid = str(p.get("id"))
                last = p.get("last") or {}
                card = {"id": pid, "n": p.get("n"), "team": team, "opp": opp, "home": g["home"] == team, "gid": g["gid"],
                        "start": g.get("start"), "pos": p.get("pos"), "role": p.get("role"), "tier": p.get("tier") or p.get("role"),
                        "tag": p.get("tag"), "hs": HEADSHOT["cbb"].format(id=pid) if p.get("hs") else None,
                        "use": p.get("use"), "use_lab": "Minutes", "proj": p.get("proj") or {}, "cls": p.get("cls"), "ht": p.get("ht")}
                cl = [["mpg", "Min"], ["pts", "Pts"], ["reb", "Reb"], ["ast", "Ast"], ["usg", "USG%"]]
                card["cols"] = cl
                seas = []
                hit = tv_key.get(last.get("s"), {}).get((nk(p.get("n")), last.get("t"))) if last else None
                if hit:
                    tpid = hit.get("pid")
                    for s in sorted(tv, reverse=True):
                        r = tv_pid[s].get(tpid)
                        if r and r.get("gp"):
                            seas.append({"s": season_label("cbb", s), "t": r.get("t"), "gp": r.get("gp"), "mpg": r.get("mpg"),
                                         "pts": r.get("ppg"), "reb": r.get("rpg"), "ast": r.get("apg"), "usg": r.get("usg")})
                        if len(seas) >= 3:
                            break
                elif last.get("gp"):
                    seas.append({"s": season_label("cbb", last.get("s")), "t": last.get("t"), "gp": last.get("gp"), "mpg": last.get("use"),
                                 "pts": last.get("pts"), "reb": last.get("reb"), "ast": last.get("ast")})
                card["seasons"] = seas
                pj = p.get("proj") or {}
                card["base"] = {"mpg": p.get("use"), "pts": pj.get("pts"), "reb": pj.get("reb"), "ast": pj.get("ast")}
                card["base_lab"] = "model, minutes x rate"
                gs = sorted(by.get(pid) or [], key=lambda x: x["date"])
                card["last5"] = [{"d": x["date"][5:], "opp": x.get("opp"), "ha": "vs" if x.get("home") else "@", "mpg": _r(x.get("min"), 0),
                                  "pts": x.get("pts"), "reb": x.get("reb"), "ast": x.get("ast"), "usg": None}
                                 for x in gs[-5:] if not x.get("dnp")][::-1]
                why = []
                if p.get("use") is not None:
                    why.append({"k": "Minutes", "v": f"{p['use']:.1f}", "d": "projected a game" + (f" · {p['role']}" if p.get("role") else "")})
                if seas and seas[0].get("usg") is not None:
                    why.append({"k": "Usage rate", "v": f"{seas[0]['usg']:.1f}%", "d": f"{seas[0]['s']} at {seas[0].get('t') or 'his school'} (Torvik): share of plays he finished"})
                if R is not None and R.get("pace") and R.get("tempo"):
                    pc = R["pace"]
                    poss = R["tempo"] * math.exp(pc.get(g["home"], 0.0) + pc.get(g["away"], 0.0))
                    why.append({"k": "Game pace", "v": f"{poss:.1f}", "d": f"expected possessions · {team} {(R.get('poss') or {}).get(team, '-')}, {opp} {(R.get('poss') or {}).get(opp, '-')}"})
                tvr = (torvik.get(max(tv) - 1) or {}).get(team) if torvik else None
                if tvr and tvr.get("adj_o") is not None:
                    why.append({"k": "Team adj O / D", "v": f"{tvr['adj_o']:.1f} / {tvr['adj_d']:.1f}", "d": f"last season, Torvik rank {tvr.get('rank')}"})
                if R is not None and R["off"].get(team) is not None:
                    why.append({"k": "Team rating", "v": f"{R['off'][team] + R['def'].get(team, 0.0):+.1f}", "d": "the model's net points a game this season, vs average"})
                if p.get("tag") and "ransfer" in str(p.get("tag")):
                    why.append({"k": "Transfer", "v": "step up" if "step up" in p["tag"] else "step down" if "step down" in p["tag"] else "lateral", "d": p["tag"]})
                card["why"] = why
                mk, seen = [], set()
                key_of = {"points": "pts", "rebounds": "reb", "assists": "ast", "threes": "3pm"}
                for pp in props.get(nk(p.get("n"))) or []:
                    if pp.get("gid") != g["gid"] or pp["mkt"] in seen:
                        continue
                    seen.add(pp["mkt"])
                    st = key_of.get(pp["mkt"])
                    mean = pj.get(st) if st else None
                    if mean is not None:
                        if st == "3pm":
                            var = 1.35 * mean
                        elif st in NBA_SD:
                            a, b = NBA_SD[st]
                            var = max(0.8, a * mean + b) ** 2
                        else:
                            var = None
                        mk.append(_mk_count(pp, mean, max(var, mean * 1.0001) if var else None, w,
                                            "cbb"))
                    else:
                        mk.append(_mk_onyx(pp))
                card["mk"] = _order(mk, "points")
                if pj.get("pts") is not None:
                    card["badge"] = [round(pj["pts"], 1), "PROJ PTS"]
                out[nk(p.get("n")) + "|" + team] = card
            except Exception as ex:
                print(f"  cards: cbb player {p.get('n')}: {str(ex)[:100]}")
    return out


def tennis_cards(lane, slate, odds, model, w):
    import tennis_model as TM
    E = TM.load(lane)
    res = (lane.load("results.json", {}) or {}).get("matches") or []
    mo = (odds or {}).get("matches") or {}
    pl = model.get("players") or {}
    out = {}
    form = {}
    for x in res:
        for nm_ in (x.get("w"), x.get("l")):
            form.setdefault(nk(nm_), []).append(x)
    for e in slate.get("events") or []:
        for m in e.get("matches") or []:
            if m.get("state") == "post":
                continue
            names = [x["name"] for x in m["p"]]
            gm_c = {}
            for i, name in enumerate(names):
                try:
                    k, ok_ = nk(name), nk(names[1 - i])
                    o = mo.get(m["id"]) or {}
                    p0 = E.p(nk(names[0]), nk(names[1])) if E.known(nk(names[0])) and E.known(nk(names[1])) else None
                    pw = None if p0 is None else (p0 if i == 0 else 1 - p0)
                    card = {"n": name, "team": "", "opp": names[1 - i], "gid": m["id"], "start": m.get("start"),
                            "event": e.get("name"), "tour": e.get("tour"), "round": m.get("round"),
                            "flag": m["p"][i].get("flag"), "elo": _r(E.r.get(k), 0), "n_m": E.n.get(k, 0),
                            "opp_elo": _r(E.r.get(ok_), 0), "form": (pl.get(k) or {}).get("form") or []}
                    mine = form.get(k) or []
                    seas = {}
                    for x in mine:
                        s = str(x.get("date", ""))[:4]
                        t = seas.setdefault(s, {"s": s, "w": 0, "l": 0})
                        t["w" if nk(x["w"]) == k else "l"] += 1
                    card["seasons"] = [seas[s] for s in sorted(seas, reverse=True)[:3]]
                    why = [{"k": "Elo", "v": f"{card['elo']:.0f}" if card["elo"] else "-", "d": f"from {card['n_m']} matches since 2023"},
                           {"k": f"{shortname(names[1 - i])} Elo", "v": f"{card['opp_elo']:.0f}" if card["opp_elo"] else "-", "d": "his opponent"}]
                    if pw is not None:
                        why.append({"k": "Elo chance", "v": f"{100 * pw:.0f}%", "d": "to win the match, before Onyx's price"})
                    mk = []
                    if o.get("ml0") is not None and o.get("ml1") is not None:
                        a, b = (o["ml0"], o["ml1"]) if i == 0 else (o["ml1"], o["ml0"])
                        fo, _ = L.fair_pair(a, b)
                        mk.append({"m": "ml", "name": "To win", "line": None, "over": a, "under": b, "yes": True,
                                   "over_sel": o.get(f"ml{i}_sel"), "under_sel": o.get(f"ml{1 - i}_sel"),
                                   "pm": _r(pw, 4), "pb": _r(L.blend(pw, fo, w), 4) if pw is not None and fo is not None else None,
                                   "note": f"Opponent {fmt_odds(b)}"})
                    if pw is not None and (o.get("total") is not None or o.get("sp0") is not None):
                        if "gm" not in gm_c:
                            gm_c["gm"] = TM.games_markets(p0, e.get("tour"), e.get("name"), o.get("total"), o.get("sp0"))
                        gm = gm_c["gm"]
                        why.append({"k": "Games expected", "v": f"{gm['exp_games']:.1f}", "d": "the Elo view of the match's length"})
                        if o.get("total") is not None and o.get("over") is not None and o.get("under") is not None:
                            fo, _ = L.fair_pair(o["over"], o["under"])
                            mk.append({"m": "total", "name": "Total games", "line": o["total"], "over": o["over"], "under": o["under"],
                                       "over_sel": o.get("over_sel"), "under_sel": o.get("under_sel"), "proj": _r(gm["exp_games"]),
                                       "pm": _r(gm["p_over"], 4), "pb": _r(L.blend(gm["p_over"], fo, w), 4) if fo else None})
                        if o.get("sp0") is not None and o.get("sp0_price") is not None and o.get("sp1_price") is not None:
                            c0 = gm["p_cover0"]
                            sp, a, b = (o["sp0"], o["sp0_price"], o["sp1_price"]) if i == 0 else (-o["sp0"], o["sp1_price"], o["sp0_price"])
                            pc = c0 if i == 0 else 1 - c0
                            fo, _ = L.fair_pair(a, b)
                            mk.append({"m": "spread", "name": f"Game spread {sp:+g}", "line": None, "over": a, "under": b, "yes": True,
                                       "over_sel": o.get(f"sp{i}_sel"), "under_sel": o.get(f"sp{1 - i}_sel"),
                                       "pm": _r(pc, 4), "pb": _r(L.blend(pc, fo, w), 4) if fo else None, "note": f"Opponent {fmt_odds(b)}"})
                    card["why"] = why
                    card["mk"] = mk
                    if pw is not None:
                        card["badge"] = [f"{100 * pw:.0f}%", "ELO WIN"]
                    out[k + "|"] = card
                except Exception as ex:
                    print(f"  cards: tennis {name}: {str(ex)[:100]}")
    return out


def fmt_odds(v):
    return "-" if v is None else (f"+{v}" if v > 0 else str(v))


# ── injuries from the depth chart (context: the team ratings do not use them) ──
def team_injuries(depth, team):
    out = []
    for p in (((depth or {}).get("teams") or {}).get(team) or {}).get("players") or []:
        tag = str(p.get("tag") or "")
        if p.get("tier") == "Out" or p.get("q") or "uestion" in tag or tag.startswith("Out") or "oubtful" in tag:
            if "ransfer" in tag or tag in ("Returning", "Freshman", "Newcomer"):
                continue
            out.append({"n": p.get("n"), "pos": p.get("pos"), "tag": tag or p.get("tier"), "use": p.get("use")})
    return sorted(out, key=lambda x: -(x.get("use") or 0))


def shard_name(team):
    """data/<sport>/cards/<this>.json: the page builds the same name (cards.js cxShard)."""
    return "".join(c if c.isalnum() else "_" for c in str(team)) or "_"


def _dump(p, obj):
    txt = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    try:
        if p.read_text(encoding="utf-8") == txt:
            return          # unchanged: no rewrite, no churn in the data commit
    except Exception:
        pass
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(txt, encoding="utf-8")
    tmp.replace(p)


def market_tests(sport):
    """{market: verdict} from the Onyx Picks backtest (data/picks/backtest.json, the same
    verdicts picks.py logs by), for the Bets tabs' honesty labels and their "Best bet":
    "finalized" (beat Onyx at the open and the close, held out), "not enough yet" (tested,
    under 60 held-out bets), "fails" (did not beat Onyx), "no replay" (never backtested), and
    "retest" when the verdict was run on another model version than the one live now (a model
    change sends a market back to testing, as it does for picks). Fail-soft: {}."""
    try:
        import picks as PK
        bt = json.loads(Path(PK.BACKTEST).read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for m in bt.get("markets") or []:
        if m.get("sport") != sport or not m.get("market"):
            continue
        v = m.get("verdict") or "no replay"
        if v in ("finalized", "not enough yet", "fails") and m.get("version") is not None:
            try:
                live = PK.live_version(sport, m["market"])
            except Exception:
                live = None
            # a lane with its own signature ("h1 0.505/18") is not a model module's VERSION:
            # only picks.live_version's own signatures (the 1st-quarter total) re-gate it
            own = not str(m["version"]).startswith("v") and m["market"] != "q1_total"
            if live is not None and not own and live != m.get("version"):
                v = "retest"
        out[m["market"]] = v
    return out


def _write(lane_dir, doc):
    """One small index (data/<sport>/cards.json) and one file per team (data/<sport>/cards/
    <team>.json: the team and its players), so a card fetches only its own team. Tennis has
    no teams: its players stay in the index. Team files from earlier slates are removed."""
    lane_dir = Path(lane_dir)
    doc["tests"] = market_tests(doc.get("sport"))
    teams, players = doc.pop("teams", {}) or {}, doc.pop("players", {}) or {}
    if teams:
        d = lane_dir / "cards"
        d.mkdir(exist_ok=True)
        by = {}
        for k, c in players.items():
            by.setdefault(c.get("team"), {})[k] = c
        keep = set()
        for t, tc in teams.items():
            nm = shard_name(t) + ".json"
            keep.add(nm)
            _dump(d / nm, {"team": tc, "players": by.get(t) or {}})
        for f in d.glob("*.json"):
            if f.name not in keep:
                f.unlink()
        doc["teams"] = sorted(teams)
        doc["players"] = {}
        for k, c in players.items():
            n = k.split("|")[0]
            doc["players"].setdefault(n, []).append(c.get("team"))
    else:
        doc["players"] = players
    _dump(lane_dir / "cards.json", doc)


def build(key, lane, slate, odds, model):
    """data/<sport>/cards.json for an engine sport. model is the page's model block with
    the build's private keys still on it (_R ratings, _w blend weight, _cands rows)."""
    import time
    t0 = time.time()
    cfg = lane.cfg
    kind = cfg["kind"]
    doc = {"v": V, "sport": key, "date": slate.get("date"), "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "teams": {}, "players": {}}
    if kind == "tennis":
        doc["players"] = tennis_cards(lane, slate, odds, model, model.get("_w") or DEFAULT_W)
        _write(lane.data, doc)
        print(f"  cards: {len(doc['players'])} tennis players ({int((time.time() - t0) * 1000)} ms)")
        return doc
    if kind not in ("football", "hockey", "basketball"):
        return None
    import importlib
    M = importlib.import_module({"nfl": "nfl_model", "cfb": "cfb_model", "cbb": "cbb_model", "nhl": "nhl_model"}[key])
    GP = M.GAME_P if key == "nfl" else M.P
    R, w = model.get("_R"), model.get("_w") or DEFAULT_W
    depth = lane.load("depth.json", None)
    lines_by, hist_rows = closing_lines(lane, key)
    by_team = team_games(lane, key, lines_by, hist_rows)
    season_now = slate.get("season")
    if season_now is None or key in ("nhl", "cbb"):
        seas = [g["s"] for gs in by_team.values() for g in gs if g.get("s") is not None]
        season_now = max(seas) if seas else None
        if key in ("nhl", "cbb") and slate.get("date"):
            d = date.fromisoformat(slate["date"])
            season_now = d.year + 1 if d.month >= 8 else d.year
    seasons = sorted({g["s"] for gs in by_team.values() for g in gs if g.get("s") is not None}, reverse=True)[:4]
    if key == "cbb":
        tv = torvik_by_season(lane, seasons)
        rts = {s: {t: {"adj_o": v["adj_o"], "adj_d": v["adj_d"], "adj_em": v["adj_em"], "tempo": v["tempo"], "rank": v["rank"]}
                   for t, v in (tv.get(s) or {}).items()} for s in seasons}
    else:
        rts = model_ratings_by_season(by_team, GP, seasons)
    slate_t = _slate_teams(slate)
    teams = set(slate_t)
    names, logos = {}, {}
    for g in slate.get("games") or []:
        for side in ("home", "away"):
            names[g.get(side)] = g.get(side + "_name") or g.get(side)
            logos[g.get(side)] = g.get(side + "_logo")
    # every team the depth chart or the history knows (standings, depth chart taps), the slate first
    teams |= set(((depth or {}).get("teams") or {}).keys()) if key != "cbb" else set()
    pmap = {}
    try:
        if kind == "football":
            pmap = football_players(key, lane, slate, odds, model, depth, R, GP)
        elif kind == "hockey":
            pmap = hockey_players(lane, slate, odds, depth, R, GP, w)
        else:
            pmap = cbb_players(lane, slate, odds, depth, R, w)
    except Exception as ex:
        print(f"  cards: players skipped ({type(ex).__name__}: {str(ex)[:140]})")
    doc["players"] = pmap
    by_tm = {}
    for k, c in pmap.items():
        by_tm.setdefault(c["team"], []).append(c)
    for t in sorted(t for t in teams if t):
        try:
            gs = by_team.get(t) or []
            rt_t = {s: (rts.get(s) or {}).get(t) for s in seasons if (rts.get(s) or {}).get(t)}
            tc = team_history(key, t, gs, season_now, rt_t)
            dt = ((depth or {}).get("teams") or {}).get(t) or {}
            tc.update(name=names.get(t) or dt.get("name") or t, logo=logos.get(t) or dt.get("logo"), abbr=t)
            if R is not None and R["n"].get(t):
                tc["rating"] = {"off": _r(R["off"].get(t), 2), "def": _r(R["def"].get(t), 2), "n": R["n"].get(t)}
            g = slate_t.get(t)
            if g:
                tc["game"] = game_why(key, t, g, R, GP, w, odds, kind)
                day = (g.get("start") or slate.get("date") or "")[:10]
                opp = tc["game"]["opp"]
                r1, d1 = _rest(by_team, t, day)
                r2, d2 = _rest(by_team, opp, day)
                tc["game"]["rest"] = r1
                tc["game"]["opp_rest"] = r2
                tc["inj"] = team_injuries(depth, t)
                tc["game"]["opp_inj"] = len(team_injuries(depth, opp))
            ps = by_tm.get(t) or []
            if ps:
                tc["key"] = [[nk(c["n"]) + "|" + t, c["n"], c.get("pos"), c.get("role")] for c in
                             sorted(ps, key=lambda c: -(c.get("use") or 0))[:8]]
            doc["teams"][t] = tc
        except Exception as ex:
            print(f"  cards: {key} team {t}: {type(ex).__name__}: {str(ex)[:120]}")
    doc["lines_src"] = "closing line (ESPN's line providers, not Onyx)" if lines_by else None
    doc["unit"] = "goals" if kind == "hockey" else "points"
    _write(lane.data, doc)
    print(f"  cards: {len(doc['teams'])} teams, {len(doc['players'])} players, "
          f"{len(lines_by)} games with a closing line ({int((time.time() - t0) * 1000)} ms)")
    return doc


# ── NBA: team cards only (the NBA player card lives in nba_shell.html) ────────
def build_nba(slate, tg, lg, th, hist, engine):
    """data/nba/cards.json: every team on the slate. The NBA model prices player props,
    not sides or totals, so a team's game shows the environment the prop model uses
    (pace, ratings per 100, Onyx's implied total and margin) and Onyx's own chances."""
    import time
    t0 = time.time()
    data = Path("data") / "nba"
    try:
        H = json.loads((data / "situations_hist.json").read_text(encoding="utf-8"))
        hrows = [dict(zip(H.get("cols") or [], r)) for r in H.get("rows") or []]
    except Exception:
        hrows = []
    # closing lines by (date, home, away); ESPN's ids are not Onyx's game ids
    lk = {}
    for r in hrows:
        lk[(_iso(r.get("d")), r.get("h"), r.get("a"))] = r
    games = {}
    for team, rows in (tg or {}).items():
        for x in rows:
            h, a = (team, x["opp"]) if x.get("home") else (x["opp"], team)
            k = x.get("gid") or f"{x['d']}|{h}|{a}"
            if k in games:
                continue
            hs, as_ = (x["pts"], x["opp_pts"]) if x.get("home") else (x["opp_pts"], x["pts"])
            ln = lk.get((x["d"], h, a))
            if ln is None:   # ESPN dates the game in ET, Onyx's feed sometimes a day off
                for dd in (-1, 1):
                    try:
                        d2 = (date.fromisoformat(x["d"]).toordinal() + dd)
                        ln = lk.get((date.fromordinal(d2).isoformat(), h, a))
                    except Exception:
                        ln = None
                    if ln:
                        break
            s_now = NM_season(x["d"])
            games[k] = {"id": k, "d": x["d"], "s": s_now, "h": h, "a": a, "hs": hs, "as": as_, "neu": False, "ot": False,
                        "sp": (ln or {}).get("sp"), "tot": (ln or {}).get("tot")}
    have = {(g["d"], g["h"], g["a"]) for g in games.values()}
    for r in hrows:
        k = (_iso(r.get("d")), r.get("h"), r.get("a"))
        if k in have or r.get("hs") is None:
            continue
        games[str(r.get("id"))] = {"id": str(r.get("id")), "d": k[0], "s": r.get("s"), "h": r.get("h"), "a": r.get("a"),
                                   "hs": r["hs"], "as": r["as"], "neu": bool(r.get("neu")), "ot": False,
                                   "sp": r.get("sp"), "tot": r.get("tot")}
    by_team = {}
    for g in sorted(games.values(), key=lambda g: g["d"]):
        for side in ("h", "a"):
            by_team.setdefault(g[side], []).append(g)
    season_now = NM_season(slate.get("date") or str(date.today()))
    seasons = sorted({g["s"] for g in games.values() if g.get("s")}, reverse=True)[:3]
    # ratings per 100 possessions by season from the box-score history the prop model reads
    rts = {}
    for s in seasons:
        T = ((hist or {}).get("teams") or {}).get(str(s)) or {}
        rts[s] = {t: {"ortg": _r(100 * r["ppg"] / r["poss"]), "drtg": _r(100 * r["opp_ppg"] / r["poss"]), "pace": _r(r["poss"])}
                  for t, r in T.items() if r.get("poss") and r.get("ppg")}
    eng = {(x["team"]): x for x in (engine or {}).get("teams") or []}
    doc = {"v": V, "sport": "nba", "date": slate.get("date"), "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "teams": {}, "players": {}, "unit": "points",
           "lines_src": "closing line (ESPN's line providers, not Onyx)" if hrows else None}
    for g in slate.get("games") or []:
        for t, opp, home in ((g["away"], g["home"], False), (g["home"], g["away"], True)):
            try:
                gs = by_team.get(t) or []
                rt_t = {s: (rts.get(s) or {}).get(t) for s in seasons if (rts.get(s) or {}).get(t)}
                tc = team_history("nba", t, gs, season_now, rt_t)
                tc.update(abbr=t, name=t)
                e, eo = eng.get(t) or {}, eng.get(opp) or {}
                spread, total = g.get("spread"), g.get("total")    # home spread
                tsp = None if spread is None else (spread if home else -spread)
                gw = {"gid": g["gid"], "opp": opp, "home": home, "neutral": False, "start": g.get("start"), "state": g.get("state"),
                      "nba": {"pace": e.get("pace"), "ortg": e.get("ortg"), "drtg": e.get("drtg"), "net": e.get("net"), "gp": e.get("gp"),
                              "opp_pace": eo.get("pace"), "opp_ortg": eo.get("ortg"), "opp_drtg": eo.get("drtg"), "opp_net": eo.get("net"),
                              "game_poss": e.get("game_poss"), "lg_poss": _r((lg or {}).get("poss")), "lg_ppg": _r((lg or {}).get("ppg"))}}
                o = {"home_ml": g.get("home_ml"), "away_ml": g.get("away_ml"), "home_ml_sel": g.get("home_ml_sel"), "away_ml_sel": g.get("away_ml_sel"),
                     "home_spread": spread, "home_spread_price": g.get("home_spread_price"), "away_spread_price": g.get("away_spread_price"),
                     "home_spread_sel": g.get("home_spread_sel"), "away_spread_sel": g.get("away_spread_sel"),
                     "total": total, "over_price": g.get("over_price"), "under_price": g.get("under_price"),
                     "over_sel": g.get("over_sel"), "under_sel": g.get("under_sel")}
                if total is not None or spread is not None or g.get("home_ml") is not None:
                    gw["onyx"] = {"spread": tsp, "total": total, "ml": g.get("home_ml") if home else g.get("away_ml"),
                                  "implied": _r((total - (tsp or 0.0)) / 2, 1) if total is not None else None}
                    gw["sides"] = _sides(o, None, 0.0, g["home"], g["away"])
                day = (g.get("start") or slate.get("date") or "")[:10]
                gw["rest"], _ = _rest(by_team, t, day)
                gw["opp_rest"], _ = _rest(by_team, opp, day)
                tc["game"] = gw
                doc["teams"][t] = tc
            except Exception as ex:
                print(f"  cards: nba team {t}: {type(ex).__name__}: {str(ex)[:120]}")
    _write(data, doc)
    print(f"  cards: {len(doc['teams'])} NBA teams ({int((time.time() - t0) * 1000)} ms)")
    return doc


def NM_season(d):
    """NBA season label (the year it ends) for an ISO date."""
    try:
        x = date.fromisoformat(str(d)[:10])
    except Exception:
        x = date.today()
    return x.year + 1 if x.month >= 8 else x.year
