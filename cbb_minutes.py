#!/usr/bin/env python3
"""
cbb_minutes.py - projected minutes and depth charts for men's college basketball.

Every player on a roster gets a projected minutes-per-game for the season, built from what
predicts playing time in the NIL / transfer-portal era:
  last season       his minutes, box value (BPM), usage and efficiency, wherever he played
  class             returning players grow (a freshman's jump to sophomore year is the biggest)
  transfers         the move's level change: last season's adjusted efficiency margin of the new
                    team minus the old one (moving up from a mid-major costs minutes, moving down
                    gains them); a high-major starter landing at another high-major keeps his role
  freshmen          the recruiting rating (Torvik's 0-100, 100 = the top recruit), height
  competition       the team's other claims on minutes: everyone else's projected role
Raw projections are then scaled per team so the roster's minutes add up to a basketball game
(200 a game, less the deep bench), and capped at 37.

The weights are fitted by least squares on two seasons of player-to-player history and tested on
a held-out season (tools/cbb_minutes_backtest.py); FIT below is that fit, rewritten by the tool.
In season, real minutes take over: mpg = (games x actual + K x projection) / (games + K).

Data: data/cbb/history (Torvik player seasons, team ratings, recruit ratings) and ESPN rosters.
"""
import json, math, os

ROOT = os.path.dirname(os.path.abspath(__file__))
HIST = os.path.join(ROOT, "data", "cbb", "history")
CLS = {"Fr": 0, "So": 1, "Jr": 2, "Sr": 3}
TEAM_MIN = 192.0      # the roster's minutes a game, less the deep bench (11/2: Torvik 2026 averages 192)
CAP = 37.0
K_INSEASON = 3.0      # games of real minutes worth one preseason projection
# fitted by tools/cbb_minutes_backtest.py (features in feats(); see its report)
FIT = {"returning": [8.4029, 0.7472, -0.1789, 0.1346, 1.5693, 4.7562, 1.4394, -4.9027, 1.581], "transfer": [15.0312, 0.4168, 0.0358, 0.0764, 1.8593, 1.2286, -0.3194, -4.5375, 0.1935, -2.304, -1.004, 0.5274], "newcomer": [19.0275, -2.178, 15.0704, -0.7295, -4.8374, -1.3677]}


def load_players(season):
    p = os.path.join(HIST, f"players_{season}.json")
    if not os.path.exists(p):
        return []
    d = json.load(open(p))
    return [dict(zip(d["cols"], r)) for r in d["rows"]]


def team_em(season):
    t = json.load(open(os.path.join(HIST, "teams.json"))).get(str(season)) or []
    return {x["team"]: x["adj_em"] for x in t}


def group(prev, transfer):
    return "newcomer" if not prev else "transfer" if transfer else "returning"


def feats(prev, cls_now, rec, ht_in, em_new, em_old, transfer, crowd=0.0):
    """(group, features) for one player. prev = last season's row (or None); crowd = the minutes
    his teammates already proved last season (returning and transferring in), /100"""
    if prev:
        mpg, bpm, usg, gp = prev.get("mpg") or 0, prev.get("bpm") or 0, prev.get("usg") or 0, prev.get("gp") or 0
        was_fr = 1.0 if CLS.get(prev.get("cls")) == 0 else 0.0
        base = [1.0, mpg, mpg * mpg / 40.0, bpm, usg / 10.0, min(gp, 35) / 35.0, was_fr, crowd, crowd * mpg / 30.0]
        if transfer:
            lvl = (em_new - em_old) / 10.0 if (em_new is not None and em_old is not None) else 0.0
            return "transfer", base + [lvl, lvl * mpg / 30.0, (em_new or 0) / 10.0]
        return "returning", base
    r = (rec or 0) / 100.0
    return "newcomer", [1.0, r, r ** 3, (ht_in - 78) / 3.0, crowd, (em_new or 0) / 10.0]


def raw(gf, fit=None):
    g, f = gf
    w = (fit or FIT or {}).get(g)
    if not w:
        return 0.0
    return max(0.0, sum(a * b for a, b in zip(f, w)))


def scale_team(proj, team_min=TEAM_MIN, cap=CAP):
    """scale one team's raw projections to its minutes, capping stars and handing the rest down"""
    tot = sum(proj.values())
    if tot <= 0:
        return proj
    out = {k: v * team_min / tot for k, v in proj.items()}
    for _ in range(6):
        over = {k: v for k, v in out.items() if v > cap}
        if not over:
            break
        spare = sum(v - cap for v in over.values())
        rest = {k: v for k, v in out.items() if v < cap}
        rt = sum(rest.values()) or 1.0
        for k in over:
            out[k] = cap
        for k, v in rest.items():
            out[k] = v + spare * v / rt
    return out


def blend(proj_mpg, games, actual_mpg):
    """in season: real minutes take over as games are played"""
    if not games:
        return proj_mpg
    return (games * actual_mpg + K_INSEASON * proj_mpg) / (games + K_INSEASON)


# ── the live build: every D1 roster today, projected ─────────────────────────────────────────────
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"
UA = {"User-Agent": "Mozilla/5.0 (Onyx Sports research)"}
SEASON_LAST = 2026      # Torvik's label for the season that just ended (2025-26)


def _get(url, as_text=False):
    import requests
    for i in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code == 200:
                return r.text if as_text else r.json()
            if r.status_code in (429, 500, 502, 503):
                import time
                time.sleep(2 * (i + 1))
                continue
            return None
        except Exception:
            import time
            time.sleep(2 * (i + 1))
    return None


def _nk(n):
    import re, unicodedata
    n = unicodedata.normalize("NFKD", str(n or "")).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", n.replace(".", " ").replace("'", "").replace("-", " "))
    return re.sub(r"\s+", " ", n).strip()


def this_season():
    """this season's Torvik player rows so far (games, minutes) and recruit ratings, by name+team"""
    import csv, io
    yr = SEASON_LAST + 1
    txt = _get(f"https://barttorvik.com/getadvstats.php?year={yr}&csv=1", as_text=True) or ""
    out = {}
    for r in csv.reader(io.StringIO(txt)):
        if len(r) < 55:
            continue
        try:
            out[(_nk(r[0]), r[1])] = {"gp": int(float(r[3] or 0)), "mpg": float(r[54] or 0), "rec": float(r[34]) if r[34] not in ("", "NA") else 0.0}
        except ValueError:
            pass
    return out


def build(out_path=None):
    from concurrent.futures import ThreadPoolExecutor
    tmap = json.load(open(os.path.join(HIST, "team_map.json")))
    last = load_players(SEASON_LAST)
    older = load_players(SEASON_LAST - 1)
    by_name = {}
    for r in older + last:                      # the latest season wins
        by_name.setdefault(_nk(r["n"]), {})[r["t"]] = r
    em = team_em(SEASON_LAST)
    now = this_season()

    def roster(tid):
        j = _get(f"{ESPN}/teams/{tid}/roster") or {}
        return tid, j.get("athletes") or []
    with ThreadPoolExecutor(8) as ex:
        R = dict(ex.map(roster, list(tmap)))

    teams, unmatched, matched = {}, 0, 0
    for tid, athletes in R.items():
        tm = tmap[tid]
        tv = tm.get("torvik")
        rows = []
        for a in athletes:
            nk = _nk(a.get("displayName"))
            cands = by_name.get(nk) or {}
            prev = cands.get(tv) or (list(cands.values())[0] if len(cands) == 1 else None)
            if prev:
                matched += 1
            elif CLS.get((a.get("experience") or {}).get("abbreviation", "").title()[:2], 0) > 0:
                unmatched += 1
            transfer = bool(prev) and prev["t"] != tv
            cur = now.get((nk, tv)) or {}
            rows.append({"a": a, "prev": prev, "transfer": transfer, "cur": cur})
        proven = sum((x["prev"] or {}).get("mpg") or 0 for x in rows)
        players = []
        for x in rows:
            a, prev, cur = x["a"], x["prev"], x["cur"]
            crowd = (proven - ((prev or {}).get("mpg") or 0)) / 100.0
            ht_in = int(a.get("height") or 78)
            gf = feats(prev, None, cur.get("rec"), ht_in, em.get(tv), em.get(prev["t"]) if prev else None, x["transfer"], crowd)
            proj = min(CAP, raw(gf))
            mpg = blend(proj, cur.get("gp") or 0, cur.get("mpg") or 0)
            p = {"id": a.get("id"), "n": a.get("displayName"), "pos": (a.get("position") or {}).get("abbreviation"),
                 "cls": (a.get("experience") or {}).get("abbreviation"), "ht": a.get("displayHeight"), "jersey": a.get("jersey"),
                 "hs": (a.get("headshot") or {}).get("href"), "g": gf[0], "proj": round(proj, 1), "mpg": round(mpg, 1)}
            if prev:
                p["last"] = {"t": prev["t"], "s": SEASON_LAST if prev in last else SEASON_LAST - 1, "mpg": prev.get("mpg"), "ppg": prev.get("ppg"),
                             "rpg": prev.get("rpg"), "apg": prev.get("apg"), "bpm": prev.get("bpm"), "usg": prev.get("usg"), "ortg": prev.get("ortg"), "gp": prev.get("gp")}
                if x["transfer"]:
                    p["from"] = prev["t"]; p["lvl"] = round((em.get(tv) or 0) - (em.get(prev["t"]) or 0), 1)
            if cur.get("rec"):
                p["rec"] = cur["rec"]
            if cur.get("gp"):
                p["now"] = {"gp": cur["gp"], "mpg": cur.get("mpg")}
            players.append(p)
        players.sort(key=lambda p: -p["mpg"])
        for i, p in enumerate(players):
            p["role"] = "Starter" if i < 5 else "Rotation" if i < 9 or p["mpg"] >= 12 else "Bench" if p["mpg"] >= 4 else "Deep bench"
        teams[tm["abbr"]] = {"id": tid, "name": tm["espn"], "torvik": tv, "em_last": em.get(tv), "players": players}
    out = {"season": f"{SEASON_LAST}-{str(SEASON_LAST + 1)[2:]}", "teams": teams,
           "model": {"test": "2025-26 held out: 6.0 min/game off vs 7.4 for last season's minutes; transfers 5.9 vs 8.6", "k_inseason": K_INSEASON},
           "matched": matched, "unmatched_vets": unmatched}
    if out_path:
        json.dump(out, open(out_path, "w"), separators=(",", ":"))
    return out


if __name__ == "__main__":
    import sys
    o = build(os.path.join(ROOT, "data", "cbb", "minutes.json"))
    print(f"{len(o['teams'])} teams, {o['matched']} players matched to last season, {o['unmatched_vets']} returning-class players unmatched")
