#!/usr/bin/env python3
"""
cbb_transfers.py - transfer impact and a player-based preseason team rating for men's college basketball.

Two outputs, both research (not tracked picks):
  data/cbb/transfers.json    every transfer on a 2026-27 roster: where he came from, the level change
                             (new team's last-season adjusted efficiency margin minus the old team's, plus
                             the conference change), last season's line, the projected line at the new
                             school, projected impact and a confidence, with the historical record of
                             players who made the same kind of move
  data/cbb/team_prior.json   every team's player-based 2026-27 rating: returning production + incoming
                             transfers translated to the new level + freshmen, minus departures, set
                             against last season and Torvik's preseason rating, with the backtest

How a player is translated: each per-player number (BPM, offensive and defensive BPM, ORtg, usage, eFG%,
points per 40) is projected from last season's value, how many minutes it rests on, class, role, and for
transfers the level change (and its size and direction), fitted by least squares on 2010-2026 player
seasons by tools/cbb_transfers_backtest.py, which writes data/cbb/history/transfer_fit.json (weights,
the historical translation table and the backtest). Minutes and per-game points, rebounds and assists
come from data/cbb/depth.json (cbb_stats.py), so the projected line matches the depth charts.

Team rating = a + b x (sum of projected offensive BPM x minutes / 40) + c x (sum of defensive) + d x
last season's adj_em, fitted on earlier seasons. The blend with Torvik's preseason rating is fitted the
same way. The backtest says whether any of it beats the closing spread; the live game model
(cbb_model.py) is NOT changed by this file.

Runs once a day from cbb_stats.py (after depth.json is written), fail-soft. Standard library only.
"""
import json, math, os, re, unicodedata
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
HIST = os.path.join(ROOT, "data", "cbb", "history")
LANE = os.path.join(ROOT, "data", "cbb")
FIT_PATH = os.path.join(HIST, "transfer_fit.json")
SEASON_LAST = 2026            # Torvik label of the season that just ended (2025-26)
CLS = {"Fr": 0, "So": 1, "Jr": 2, "Sr": 3}
STATS = ["bpm", "obpm", "dbpm", "ortg", "usg", "efg", "pts40"]
REL_MIN = 300.0               # minutes at which last season's rate is trusted half way
STEP = 5.0                    # |level change| under this many points of adj_em is "lateral"


# ── data ────────────────────────────────────────────────────────────────────────────────────────
def load_players(season):
    """pid -> that season's row (the team he played most minutes for)"""
    p = os.path.join(HIST, f"players_{season}.json")
    if not os.path.exists(p):
        return {}
    d = json.load(open(p))
    out = {}
    for r in d["rows"]:
        x = dict(zip(d["cols"], r))
        o = out.get(x["pid"])
        if o is None or (x.get("gp") or 0) * (x.get("mpg") or 0) > (o.get("gp") or 0) * (o.get("mpg") or 0):
            out[x["pid"]] = x
    return out


_TEAMS = None


def teams_all():
    global _TEAMS
    if _TEAMS is None:
        _TEAMS = json.load(open(os.path.join(HIST, "teams.json")))
    return _TEAMS


def team_table(season):
    """team -> row, with `rk` = rank by adj_em that season"""
    rows = [dict(x) for x in teams_all().get(str(season)) or []]
    rows.sort(key=lambda x: -(x.get("adj_em") or -99))
    for i, x in enumerate(rows):
        x["rk"] = i + 1
    return {x["team"]: x for x in rows}


def conf_strength(season):
    acc = {}
    for x in teams_all().get(str(season)) or []:
        acc.setdefault(x.get("conf"), []).append(x.get("adj_em") or 0)
    return {c: sum(v) / len(v) for c, v in acc.items() if v}


def tier(rank):
    if rank is None:
        return None
    return "top50" if rank <= 50 else "mid" if rank <= 150 else "low"


TIER_NAME = {"top50": "a top-50 team", "mid": "a 51-150 team", "low": "a 151+ team"}
TIER_SHORT = {"top50": "Top 50", "mid": "51-150", "low": "151+"}


def ppg_band(ppg):
    return "15+" if (ppg or 0) >= 15 else "8-15" if (ppg or 0) >= 8 else "<8"


def direction(lvl):
    if lvl is None:
        return "lateral"
    return "up" if lvl >= STEP else "down" if lvl <= -STEP else "lateral"


def size_band(lvl):
    a = abs(lvl or 0)
    return "lateral" if a < STEP else "5-10" if a < 10 else "10-20" if a < 20 else "20+"


def ht_in(s):
    m = re.match(r"(\d+)\D+(\d+)", str(s or ""))
    return int(m.group(1)) * 12 + int(m.group(2)) if m else 78


def stat_of(row, s):
    """one per-player number from a Torvik row (pts40 = points per 40 minutes)"""
    if row is None:
        return None
    if s == "pts40":
        m = row.get("mpg") or 0
        return (row.get("ppg") or 0) * 40.0 / m if m > 0 else None
    return row.get(s)


# ── features (shared by the fit and the live build; weights in transfer_fit.json) ────────────────
def feats(stat, group, prev=None, lvl=0.0, em_old=0.0, em_new=0.0, ht=78):
    if group == "newcomer":
        return [1.0, (ht - 78) / 3.0, (em_new or 0) / 10.0]
    v = stat_of(prev, stat)
    v = 0.0 if v is None else float(v)
    mins = (prev.get("gp") or 0) * (prev.get("mpg") or 0)
    rel = mins / (mins + REL_MIN)
    c = CLS.get(prev.get("cls"), 2)
    f = [1.0, v, v * rel, float(c == 0), float(c == 1), float(c == 2), (prev.get("mpg") or 0) / 40.0,
         (prev.get("usg") or 20.0) / 20.0, (prev.get("bpm") or 0) / 10.0]
    if group == "transfer":
        l = (lvl or 0) / 10.0
        f += [l, max(l, 0.0), v * l, (em_old or 0) / 10.0]
    return f


def predict(fit, stat, group, f):
    w = ((fit or {}).get("w") or {}).get(stat, {}).get(group)
    if not w:
        return None
    return sum(a * b for a, b in zip(f, w))


def project(fit, group, prev=None, lvl=0.0, em_old=0.0, em_new=0.0, ht=78):
    out = {}
    for s in STATS:
        v = predict(fit, s, group, feats(s, group, prev, lvl, em_old, em_new, ht))
        if v is not None:
            out[s] = v
    return out


def team_rating(fit, o_sum, d_sum, em_last, pre_em=None):
    """player sums -> projected adj_em (ours) and the blend with Torvik's preseason rating"""
    c = (fit or {}).get("team") or {}
    w = c.get("ours")
    if not w:
        return None, None
    ours = w[0] + w[1] * o_sum + w[2] * d_sum + w[3] * (em_last if em_last is not None else c.get("em_mean", 0.0))
    b = c.get("blend")
    blend = b[0] + b[1] * ours + b[2] * pre_em if (b and pre_em is not None) else None
    return ours, blend


def note_key(fit, from_tier, to_tier, band, d):
    key = f"{from_tier}>{to_tier}|{band}"
    x = (((fit or {}).get("patterns") or {}).get("tier_band") or {}).get(key)
    return key if x and x.get("n", 0) >= 12 else d


def note_for(fit, key):
    """plain-words history for this kind of move, from the translation table"""
    pat = ((fit or {}).get("patterns") or {})
    x = (pat.get("tier_band") or {}).get(key) if "|" in key else None
    if x:
        tiers, band = key.split("|")
        from_tier, to_tier = tiers.split(">")
        who = {"15+": "15+ ppg scorers", "8-15": "8-15 ppg scorers", "<8": "Players under 8 ppg"}[band]
        who += f" moving from {TIER_NAME.get(from_tier, from_tier)} to {TIER_NAME.get(to_tier, to_tier)}"
    else:
        x = (pat.get("dir") or {}).get(key)
        if not x:
            return None
        who = {"up": "Players stepping up 5+ points", "down": "Players stepping down 5+ points",
               "lateral": "Players moving within 5 points"}.get(key, "Transfers")
    def chg(v, unit, lo=0.05):
        if v is None:
            return None
        return f"{abs(v):.1f} {'more' if v > 0 else 'fewer'} {unit}" if abs(v) >= lo else f"the same {unit}"
    bits = [f"averaged {x['ppg1']:.1f} ppg (from {x['ppg0']:.1f})", chg(x.get("dmpg"), "minutes")]
    sg = lambda v: ("+" if round(v, 1) > 0 else "") + f"{round(v, 1) + 0.0:.1f}"
    if x.get("dortg") is not None:
        bits.append(f"ORtg {sg(x['dortg'])}")
    if x.get("dusg") is not None:
        bits.append(f"usage {sg(x['dusg'])}")
    return f"{who} (n={x['n']}) " + ", ".join(b for b in bits if b) + "."


# ── live build ──────────────────────────────────────────────────────────────────────────────────
def _nk(n):
    n = unicodedata.normalize("NFKD", str(n or "")).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", n.replace(".", " ").replace("'", "").replace("-", " "))
    return re.sub(r"\s+", " ", n).strip()


def confidence(prev, lvl, gap=1):
    mins = (prev.get("gp") or 0) * (prev.get("mpg") or 0)
    if mins < 250 or abs(lvl or 0) >= 20 or gap > 1:
        return "Low"
    if mins >= 600 and abs(lvl or 0) < 12:
        return "High"
    return "Medium"


def r1(x, n=1):
    return None if x is None else round(x, n)


def build(write=True):
    fit = json.load(open(FIT_PATH))
    depth = json.load(open(os.path.join(LANE, "depth.json")))
    tmap = json.load(open(os.path.join(HIST, "team_map.json")))
    tv_of = {v["abbr"]: v["torvik"] for v in tmap.values()}
    ab_of = {v["torvik"]: v["abbr"] for v in tmap.values()}
    last = load_players(SEASON_LAST)
    older = load_players(SEASON_LAST - 1)
    by_key = {}
    for s, P in ((SEASON_LAST - 1, older), (SEASON_LAST, last)):
        for r in P.values():
            by_key[(_nk(r["n"]), r["t"], s)] = r
    T = {SEASON_LAST: team_table(SEASON_LAST), SEASON_LAST - 1: team_table(SEASON_LAST - 1)}
    pre = team_table(SEASON_LAST + 1)              # Torvik's 2026-27 preseason rating
    CS = {SEASON_LAST: conf_strength(SEASON_LAST), SEASON_LAST - 1: conf_strength(SEASON_LAST - 1)}
    repl = fit.get("repl_bpm", -4.0)
    rows26 = list(T[SEASON_LAST].values())
    MO = sum(x["adj_o"] for x in rows26) / len(rows26)
    MD = sum(x["adj_d"] for x in rows26) / len(rows26)
    transfers, teams = [], {}
    on_roster = {}                                  # pid -> new team abbr (for departures)
    for ab, t in depth["teams"].items():
        tv = tv_of.get(ab) or t.get("torvik")
        now_row = T[SEASON_LAST].get(tv) or {}
        em_new = now_row.get("adj_em")
        tempo = (pre.get(tv) or {}).get("tempo") or now_row.get("tempo") or 68.0
        o_sum = d_sum = 0.0
        ins = []
        for p in t["players"]:
            l = p.get("last") or {}
            prev = by_key.get((_nk(p.get("n")), l.get("t"), l.get("s"))) if l else None
            g = p.get("g")
            mpg = p.get("use") or 0
            if prev is None or g == "newcomer":
                proj = project(fit, "newcomer", em_new=em_new, ht=ht_in((p.get("ht") or "").replace("' ", "-").replace('"', "")))
                g = "newcomer"
            elif g == "transfer":
                old = T.get(l.get("s"), {}).get(l.get("t")) or {}
                em_old = old.get("adj_em")
                lvl = (em_new or 0) - (em_old or 0)
                proj = project(fit, "transfer", prev, lvl, em_old, em_new)
            else:
                proj = project(fit, "returning", prev)
            if prev is not None:
                on_roster[prev["pid"]] = ab
            o_sum += (proj.get("obpm") or 0) * mpg / 40.0
            d_sum += (proj.get("dbpm") or 0) * mpg / 40.0
            if g != "transfer":
                continue
            old = T.get(l.get("s"), {}).get(l.get("t")) or {}
            em_old = old.get("adj_em")
            lvl = (em_new or 0) - (em_old or 0) if em_new is not None and em_old is not None else 0.0
            d = direction(lvl)
            ft, tt = tier(old.get("rk")), tier(now_row.get("rk"))
            cs_old = CS.get(l.get("s"), {}).get(old.get("conf"))
            cs_new = CS[SEASON_LAST].get(now_row.get("conf"))
            bpm = proj.get("bpm")
            impact = (bpm - repl) * mpg / 40.0 * tempo / 100.0 if bpm is not None else None
            pj = p.get("proj") or {}
            x = {"n": p.get("n"), "id": p.get("id"), "pos": p.get("pos"), "cls": p.get("cls"), "hs": p.get("hs"),
                 "to": ab, "to_name": t.get("name"), "from": l.get("t"), "from_ab": ab_of.get(l.get("t")),
                 "from_conf": old.get("conf"), "to_conf": now_row.get("conf"),
                 "em_old": r1(em_old), "em_new": r1(em_new), "lvl": r1(lvl), "dir": d, "size": size_band(lvl),
                 "from_tier": ft, "to_tier": tt,
                 "conf_lvl": r1(cs_new - cs_old) if cs_new is not None and cs_old is not None else None,
                 "last": {"s": l.get("s"), "gp": prev.get("gp"), "mpg": r1(prev.get("mpg")), "ppg": r1(prev.get("ppg")),
                          "rpg": r1(prev.get("rpg")), "apg": r1(prev.get("apg")), "bpm": r1(prev.get("bpm")),
                          "ortg": r1(prev.get("ortg")), "usg": r1(prev.get("usg")), "efg": r1(prev.get("efg"))},
                 "proj": {"mpg": r1(mpg), "ppg": pj.get("pts"), "rpg": pj.get("reb"), "apg": pj.get("ast"),
                          "bpm": r1(bpm), "ortg": r1(proj.get("ortg")), "usg": r1(proj.get("usg")), "efg": r1(proj.get("efg"))},
                 "impact": r1(impact, 2), "net": r1((bpm or 0) * mpg / 40.0, 2), "conf": confidence(prev, lvl),
                 "role": p.get("role"),
                 "nk": note_key(fit, ft, tt, ppg_band(prev.get("ppg")), d)}
            transfers.append(x)
            ins.append(x)
        ours, blend = team_rating(fit, o_sum, d_sum, em_new, (pre.get(tv) or {}).get("adj_em"))
        adj_o = adj_d = None
        tw = fit.get("team") or {}
        if ours is not None and tw.get("off") and tw.get("def"):
            lo = (now_row["adj_o"] - MO) if now_row else 0.0
            ld = (MD - now_row["adj_d"]) if now_row else 0.0
            po = tw["off"][0] + tw["off"][1] * o_sum + tw["off"][2] * lo
            pdf = tw["def"][0] + tw["def"][1] * d_sum + tw["def"][2] * ld
            share = (ours - po - pdf) / 2.0          # make offense + defense add up to the margin
            adj_o, adj_d = MO + po + share, MD - (pdf + share)
        teams[ab] = {"name": t.get("name"), "torvik": tv, "conf": now_row.get("conf"), "em_last": r1(em_new),
                     "rk_last": now_row.get("rk"), "o_sum": r1(o_sum, 2), "d_sum": r1(d_sum, 2),
                     "ours": r1(ours), "adj_o": r1(adj_o), "adj_d": r1(adj_d), "torvik_pre": r1((pre.get(tv) or {}).get("adj_em")), "blend": r1(blend),
                     "in": sorted([(x["n"], x["from"], x["impact"]) for x in ins], key=lambda z: -(z[2] or -9))}
    # departures: last season's players for each team who are now on another D1 roster
    for pid, r in last.items():
        ab_now = on_roster.get(pid)
        ab_old = ab_of.get(r["t"])
        if ab_now and ab_old and ab_now != ab_old and ab_old in teams:
            mins = r.get("mpg") or 0
            val = ((r.get("bpm") or 0) - repl) * mins / 40.0 * ((T[SEASON_LAST].get(r["t"]) or {}).get("tempo") or 68.0) / 100.0
            teams[ab_old].setdefault("out", []).append((r["n"], ab_now, r1(val, 2)))
    for t in teams.values():
        t["out"] = sorted(t.get("out") or [], key=lambda z: -(z[2] or -9))
        t["portal_in"] = r1(sum(z[2] or 0 for z in t["in"]), 2)
        t["portal_out"] = r1(sum(z[2] or 0 for z in t["out"]), 2)
        t["chg"] = r1(t["ours"] - t["em_last"]) if t["ours"] is not None and t["em_last"] is not None else None
    ranked = sorted([t for t in teams.values() if t["ours"] is not None], key=lambda t: -t["ours"])
    for i, t in enumerate(ranked):
        t["rk"] = i + 1
    transfers.sort(key=lambda x: -(x["impact"] if x["impact"] is not None else -9))
    gen = datetime.now(timezone.utc).isoformat(timespec="seconds")
    season = f"{SEASON_LAST}-{str(SEASON_LAST + 1)[2:]}"
    tj = {"sport": "cbb", "generated": gen, "season": season, "n": len(transfers), "repl_bpm": repl,
          "notes": {k: note_for(fit, k) for k in sorted({x["nk"] for x in transfers})},
          "table": fit.get("table"), "player_backtest": fit.get("player_backtest"), "transfers": transfers}
    pj = {"sport": "cbb", "generated": gen, "season": season, "method": fit.get("method"),
          "backtest": fit.get("team_backtest"), "teams": teams}
    if write:
        if len(transfers) < 300 or len(teams) < 300:
            raise SystemExit(f"cbb transfers: only {len(transfers)} transfers / {len(teams)} teams, not written")
        json.dump(tj, open(os.path.join(LANE, "transfers.json"), "w"), separators=(",", ":"))
        json.dump(pj, open(os.path.join(LANE, "team_prior.json"), "w"), separators=(",", ":"))
    return tj, pj


if __name__ == "__main__":
    tj, pj = build()
    up = sum(1 for x in tj["transfers"] if x["dir"] == "up")
    dn = sum(1 for x in tj["transfers"] if x["dir"] == "down")
    print(f"cbb transfers: {tj['n']} transfers ({up} step up, {dn} step down), {len(pj['teams'])} team priors")
