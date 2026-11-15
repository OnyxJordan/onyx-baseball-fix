#!/usr/bin/env python3
"""
nfl_td_value.py - where is the value in Onyx's anytime touchdown prices? Dev only (bt/ files).

Jordan (11/15): "we still want TD scorers though and to find the best value there because that's fun as well".

Every Onyx anytime-TD yes price of 2025 and 2026 (bt/nfl_td.json, opening and closing), graded off ESPN's box score
(rushing + receiving touchdowns, data/nfl/player_games.json); a priced player with no box line is a loss if nflverse
has him on the field (snap share > 0), else void, as Onyx grades it. Each price gets what was known before kickoff:
his team's Onyx team total, his season-to-date touchdowns, touches, red-zone-free usage share and position role.
Segments and value rules are chosen on 2025 and judged on 2026 (and the other way round), at the open and the close.

    python3 tools/nfl_td_value.py
"""
import json, math, os, re, sys, unicodedata
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NICK = {"Cardinals": "ARI", "Falcons": "ATL", "Ravens": "BAL", "Bills": "BUF", "Panthers": "CAR", "Bears": "CHI", "Bengals": "CIN",
        "Browns": "CLE", "Cowboys": "DAL", "Broncos": "DEN", "Lions": "DET", "Packers": "GB", "Texans": "HOU", "Colts": "IND",
        "Jaguars": "JAX", "Chiefs": "KC", "Raiders": "LV", "Chargers": "LAC", "Rams": "LAR", "Dolphins": "MIA", "Vikings": "MIN",
        "Patriots": "NE", "Saints": "NO", "Giants": "NYG", "Jets": "NYJ", "Eagles": "PHI", "Steelers": "PIT", "49ers": "SF",
        "Seahawks": "SEA", "Buccaneers": "TB", "Titans": "TEN", "Commanders": "WSH"}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def pay(p):
    return p / 100 if p > 0 else 100 / -p


def imp(p):
    return 100 / (p + 100) if p > 0 else -p / (-p + 100)


def build():
    PG = json.load(open(os.path.join(ROOT, "data/nfl/player_games.json")))["rows"]
    by_game = defaultdict(dict)            # (date, team) -> name key -> row
    hist = defaultdict(list)               # name key, team -> rows by date
    for r in PG:
        by_game[(r["date"], r["team"])][nk(r["name"])] = r
        hist[nk(r["name"])].append(r)
    for k in hist:
        hist[k].sort(key=lambda r: r["date"])
    V = json.load(open(os.path.join(ROOT, "data/nfl/nflverse.json")))["seasons"]
    snaps = {}
    for s, D in V.items():
        for season, wk, team, key, sh in D.get("snaps") or []:
            snaps[(int(season), int(wk), team, key)] = sh
    wk_of = {(r["date"], r["team"]): (r["season"], r["week"]) for r in PG}
    D = json.load(open(os.path.join(ROOT, "bt/nfl_td.json")))
    out = []
    for fid, g in D.items():
        st = g["start"]
        h, a = NICK.get(g["home"].split()[-1]), NICK.get(g["away"].split()[-1])
        if not h or not a:
            continue
        # the game's date as ESPN dates it (the local day): the start in ET
        from datetime import datetime, timedelta
        dt = datetime.fromisoformat(st.replace("Z", "+00:00")) - timedelta(hours=5)
        date = dt.date().isoformat()
        cand_dates = [date, (dt + timedelta(days=1)).date().isoformat(), (dt - timedelta(days=1)).date().isoformat()]
        tt = {}
        for k, v in ((g.get("game") or {}).get("team_total") or {}).items():
            nm, side = k.split("|")
            if side == "over" and v.get("o"):
                tt[NICK.get(nm.split()[-1])] = v["o"][0]
        for name, mk in (g.get("props") or {}).items():
            v = mk.get("anytime_touchdown_scorer")
            if not v or not v.get("o") or v["o"][1] is None:
                continue
            key = nk(name)
            team = d_ = row = None
            for dd in cand_dates:
                for t in (h, a):
                    if key in by_game.get((dd, t), {}):
                        team, d_, row = t, dd, by_game[(dd, t)][key]
                        break
                if team:
                    break
            if row is not None:
                tds = (row.get("rush_td") or 0) + (row.get("rec_td") or 0)
                played = True
            else:
                # no box line: on the field (snaps) is a loss, else void
                team = next((t for t in (h, a) for dd in cand_dates if (dd, t) in wk_of and
                             snaps.get((*wk_of[(dd, t)], t, key), 0) > 0), None)
                if not team:
                    continue
                d_ = next(dd for dd in cand_dates if (dd, team) in wk_of)
                tds, played = 0, True
            season = 2025 if st < "2026-03-01" else 2026
            prior = [r for r in hist.get(key, []) if r["date"] < d_ and r["season"] == season]
            gp = len(prior)
            ptd = sum((r.get("rush_td") or 0) + (r.get("rec_td") or 0) for r in prior)
            touch = sum((r.get("rush_att") or 0) + (r.get("rec") or 0) for r in prior)
            car = sum(r.get("rush_att") or 0 for r in prior)
            tgt = sum(r.get("tgt") or 0 for r in prior)
            role = "QB" if any("passing" in r["cats"] for r in prior[-3:]) else ("RB" if car >= tgt and car > 0 else "WR/TE" if tgt > 0 else "?")
            c = v.get("c") or [None, None, None]
            out.append({"season": season, "date": d_, "name": name, "team": team, "opp": a if team == h else h,
                        "home": team == h, "po": v["o"][1], "pc": c[1], "y": int(tds >= 1), "tds": tds,
                        "team_total": tt.get(team), "gp": gp, "td_pg": ptd / gp if gp else None,
                        "touch_pg": touch / gp if gp else None, "role": role})
    return out


def roi(rs, price="po"):
    rs = [r for r in rs if r.get(price) is not None]
    n = len(rs); w = sum(r["y"] for r in rs)
    u = sum(pay(r[price]) if r["y"] else -1.0 for r in rs)
    return n, w, u, (u / n if n else None)


def fmt(t):
    n, w, u, r = t
    return f"{n:4d} bets {w:3d} won ({100*w/max(n,1):4.1f}%) {u:+7.1f}u {('%+.1f%%' % (100*r)) if r is not None else '':>7s}"


def main():
    rows = build()
    print(f"{len(rows)} graded anytime-TD prices: " + ", ".join(f"{y}: {sum(1 for r in rows if r['season'] == y)}" for y in (2025, 2026)))
    for y in (2025, 2026):
        rs = [r for r in rows if r["season"] == y]
        print(f"  {y} every yes at the open: {fmt(roi(rs))}   implied {100*sum(imp(r['po']) for r in rs)/len(rs):.1f}% vs scored {100*sum(r['y'] for r in rs)/len(rs):.1f}%")
    segs = {
        "price -200 or shorter": lambda r: r["po"] <= -200,
        "price -199 to +100": lambda r: -200 < r["po"] <= 100,
        "price +101 to +200": lambda r: 100 < r["po"] <= 200,
        "price +201 to +350": lambda r: 200 < r["po"] <= 350,
        "price +351 to +600": lambda r: 350 < r["po"] <= 600,
        "price +601 or longer": lambda r: r["po"] > 600,
        "RB": lambda r: r["role"] == "RB", "WR/TE": lambda r: r["role"] == "WR/TE", "QB": lambda r: r["role"] == "QB",
        "team total 27+": lambda r: (r["team_total"] or 0) >= 27, "team total under 20": lambda r: (r["team_total"] or 99) < 20,
        "home": lambda r: r["home"], "road": lambda r: not r["home"],
        "scored in 50%+ of games (3+ games)": lambda r: r["gp"] >= 3 and (r["td_pg"] or 0) >= 0.5,
        "no TD yet (3+ games)": lambda r: r["gp"] >= 3 and (r["td_pg"] or 0) == 0,
        "15+ touches a game": lambda r: (r["touch_pg"] or 0) >= 15,
        "RB, 15+ touches, team total 24+": lambda r: r["role"] == "RB" and (r["touch_pg"] or 0) >= 15 and (r["team_total"] or 0) >= 24,
        "RB at plus money": lambda r: r["role"] == "RB" and r["po"] > 100,
        "WR/TE +201 to +400, team total 24+": lambda r: r["role"] == "WR/TE" and 200 < r["po"] <= 400 and (r["team_total"] or 0) >= 24,
        "QB +200 or longer": lambda r: r["role"] == "QB" and r["po"] >= 200,
    }
    print("\nsegment                                  2025 open                                  2026 open                                  2026 close")
    for k, f in segs.items():
        a = [r for r in rows if r["season"] == 2025 and f(r)]; b = [r for r in rows if r["season"] == 2026 and f(r)]
        print(f"  {k:38s} {fmt(roi(a))}   {fmt(roi(b))}   {fmt(roi(b, 'pc'))}")
    # a simple value read: the player's own scoring rate (season to date, shrunk to his role's average over 4 games)
    # scaled by his team total, against the no-margin price; chosen on one season, judged on the other
    base = defaultdict(lambda: [0, 0])
    for r in rows:
        base[(r["season"], r["role"])][0] += r["y"]; base[(r["season"], r["role"])][1] += 1
    def chance(r, k=4.0):
        rate = base[(r["season"], r["role"])]
        prior = rate[0] / max(rate[1], 1)
        p = ((r["td_pg"] or 0) * r["gp"] + prior * k) / (r["gp"] + k) if r["gp"] else prior
        return min(0.95, p * ((r["team_total"] or 22.5) / 22.5) ** 0.8)
    print("\nvalue read (season scoring rate x team total vs Onyx's price with its margin taken out x .82), daily top 10")
    for y in (2025, 2026):
        days = defaultdict(list)
        for r in rows:
            if r["season"] == y and r["gp"] >= 3:
                r["edge"] = chance(r) - imp(r["po"]) * 0.82
                days[r["date"]].append(r)
        for N, lab in ((10, "top 10"), (5, "top 5")):
            sel = [x for d in days.values() for x in sorted([r for r in d if r["edge"] > 0], key=lambda r: -r["edge"])[:N]]
            print(f"  {y} {lab}: open {fmt(roi(sel))}   close {fmt(roi(sel, 'pc'))}")
        for lo, hi in ((0, 0.03), (0.03, 0.06), (0.06, 1)):
            sel = [r for d in days.values() for r in d if lo <= r["edge"] < hi]
            print(f"      edge {int(lo*100)}-{int(hi*100) if hi < 1 else '+'}pp: open {fmt(roi(sel))}")
    json.dump(rows, open(os.path.join(os.environ.get("TMPDIR", "/tmp"), "nfl_td_rows.json"), "w"))


if __name__ == "__main__":
    main()
