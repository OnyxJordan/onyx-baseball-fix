#!/usr/bin/env python3
"""
fetch_playoffs.py — the playoff field and its high-leverage profile.

Writes data/playoffs.json: the clinched teams, and for every hitter and pitcher
on their active rosters, the season line plus the situational splits that
actually separate players in October.

WHY THESE SPLITS. Postseason baseball is not regular-season baseball with better
uniforms. Three things change, and each maps to a split the Stats API exposes:

  1. Bullpens shorten and managers matchup-hunt from the 6th on, so a bat with a
     weak platoon side gets that side attacked every night  -> vl / vr
  2. Starters get pulled at the first sign of a third time through the order, so
     a starter's value is how long he holds, not his ERA    -> pi000 / pi076
  3. Runs get scarce, so the innings where games are decided carry far more
     weight than their share of PAs                         -> lc, risp, ig07

The `lc` (Late / Close) code is the API's own high-leverage proxy: 7th inning or
later with the tying run at least on deck. That is as close to a leverage index
as this API gets, and it is the backbone of the playoff projections.

A WARNING THAT IS PART OF THE DESIGN. These split samples are SMALL — a regular
carries roughly 60-110 late/close PA over a full season, and a reliever fewer
batters faced than that. "Clutch" measured off such samples is mostly noise, and
year-over-year it barely correlates. This script therefore stores the raw counts
alongside every rate so model.py can regress the deltas toward zero by sample
size, and so the site can show the sample next to the number. Nothing here should
ever be presented as a clean read on who is "clutch."

Cheap by design: the league-wide statSplits endpoint returns every player for a
situation in ONE call, so this is a couple of dozen requests, not one per player.
"""
import json, subprocess, sys, time
from pathlib import Path

import requests

API = "https://statsapi.mlb.com/api/v1"
OUT = Path(__file__).resolve().parent / "data"
SEASON = 2026

# situations we pull, per group. Keep this list tight: every code is another
# league-wide call, and every code we keep has to earn its place in the score.
HIT_SITS = ["lc", "risp", "vl", "vr", "ig07"]
PIT_SITS = ["lc", "risp", "ig07", "pi000", "pi076"]

S = requests.Session()
S.headers.update({"User-Agent": "onyx-baseball/playoffs"})


def _get(path, **params):
    """GET with a short retry. The Stats API 500s in bursts under load."""
    url = f"{API}/{path}"
    for attempt in range(4):
        try:
            r = S.get(url, params=params, timeout=40)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            print(f"  WARN {path} HTTP {r.status_code}")
            return {}
        except requests.RequestException as e:
            print(f"  WARN {path} {type(e).__name__}")
            time.sleep(2 * (attempt + 1))
    return {}


# ── 1. the field ──────────────────────────────────────────────────────────────
def playoff_field():
    """The clinched teams, with seed line and record.

    `clinched` is the API's own flag and is the only thing we trust here; we do
    NOT try to infer the field from win totals, because tiebreakers and Game 163
    scenarios are exactly the kind of thing that silently produces a wrong board.
    Before clinching starts this simply returns fewer teams (or none), and the
    tab says so rather than inventing a bracket.
    """
    j = _get("standings", leagueId="103,104", season=SEASON,
             standingsTypes="regularSeason", hydrate="team")
    teams = []
    for rec in j.get("records", []):
        for t in rec.get("teamRecords", []):
            if not t.get("clinched"):
                continue
            team = t.get("team", {})
            teams.append({
                "id": team.get("id"),
                "name": team.get("name"),
                "abbr": (team.get("abbreviation") or "").upper(),
                "league": "AL" if rec.get("league", {}).get("id") == 103 else "NL",
                "w": t.get("wins"), "l": t.get("losses"),
                "pct": t.get("winningPercentage"),
                "div_winner": bool(t.get("divisionLeader")),
                "wc_rank": t.get("wildCardRank"),
            })
    # seed within league: division winners by record, then wild cards by record
    for lg in ("AL", "NL"):
        grp = [t for t in teams if t["league"] == lg]
        dv = sorted([t for t in grp if t["div_winner"]],
                    key=lambda t: -(t["w"] / max(t["w"] + t["l"], 1)))
        wc = sorted([t for t in grp if not t["div_winner"]],
                    key=lambda t: -(t["w"] / max(t["w"] + t["l"], 1)))
        for i, t in enumerate(dv):
            t["seed"] = i + 1
        for i, t in enumerate(wc):
            t["seed"] = len(dv) + i + 1
    teams.sort(key=lambda t: (t["league"], t.get("seed") or 99))
    print(f"playoff field: {len(teams)} clinched "
          f"({sum(1 for t in teams if t['league']=='AL')} AL / "
          f"{sum(1 for t in teams if t['league']=='NL')} NL)")
    return teams


# ── 2. who is actually on those rosters ───────────────────────────────────────
def rosters(teams):
    """player id -> {team abbr, position type}. The league-wide splits endpoint
    returns no team, so this is how a split row gets attached to a playoff club."""
    who = {}
    for t in teams:
        j = _get(f"teams/{t['id']}/roster", rosterType="active", season=SEASON)
        for p in j.get("roster", []):
            pid = p.get("person", {}).get("id")
            if not pid:
                continue
            who[pid] = {
                "name": p["person"].get("fullName"),
                "team": t["abbr"], "team_id": t["id"],
                "league": t["league"], "seed": t.get("seed"),
                "pos": p.get("position", {}).get("abbreviation"),
                "is_pitcher": p.get("position", {}).get("type") == "Pitcher",
            }
    print(f"playoff rosters: {len(who)} players "
          f"({sum(1 for v in who.values() if v['is_pitcher'])} pitchers)")
    return who


# ── 3. splits ─────────────────────────────────────────────────────────────────
# counting stats we sum. The API returns one row per team a player appeared for
# (plus an aggregate); summing the counters and recomputing the rates ourselves
# is robust to that shape, where trusting a single row is not.
HIT_COUNTS = ["plateAppearances", "atBats", "hits", "homeRuns", "doubles",
              "triples", "totalBases", "baseOnBalls", "strikeOuts",
              "hitByPitch", "sacFlies"]
# NOTE the two outs keys: the statSplits endpoint returns `outsPitched` while
# the season endpoint returns `outs` for the same quantity. Summing both and
# taking whichever is non-zero is what keeps innings (and therefore HR/9) from
# silently coming out as None on one path and fine on the other.
PIT_COUNTS = ["battersFaced", "hits", "homeRuns", "baseOnBalls", "strikeOuts",
              "outsPitched", "outs", "numberOfPitches", "earnedRuns",
              "gamesStarted", "gamesPitched"]


def _sum_rows(rows, counts):
    out = {k: 0 for k in counts}
    for r in rows:
        st = r.get("stat", {}) or {}
        for k in counts:
            try:
                out[k] += int(st.get(k) or 0)
            except (TypeError, ValueError):
                pass
    return out


def _hit_rates(c):
    pa, ab = c["plateAppearances"], c["atBats"]
    if pa <= 0:
        return None
    avg = c["hits"] / ab if ab else 0.0
    slg = c["totalBases"] / ab if ab else 0.0
    obp_den = ab + c["baseOnBalls"] + c["hitByPitch"] + c["sacFlies"]
    obp = (c["hits"] + c["baseOnBalls"] + c["hitByPitch"]) / obp_den if obp_den else 0.0
    return {
        "pa": pa, "ops": round(obp + slg, 4), "iso": round(slg - avg, 4),
        "hr_pa": round(c["homeRuns"] / pa, 5), "k_pct": round(c["strikeOuts"] / pa, 4),
        "bb_pct": round(c["baseOnBalls"] / pa, 4), "hr": c["homeRuns"],
    }


def _pit_rates(c):
    bf = c["battersFaced"]
    if bf <= 0:
        return None
    outs = c.get("outsPitched") or c.get("outs") or 0
    ip = outs / 3.0
    # OPS-against needs AB, which this endpoint does not give for pitchers; BF
    # minus walks is close enough for a relative read and we label it as such.
    ab_ish = max(bf - c["baseOnBalls"], 1)
    return {
        "bf": bf, "ip": round(ip, 1),
        "k_bf": round(c["strikeOuts"] / bf, 4),
        "bb_bf": round(c["baseOnBalls"] / bf, 4),
        "hr9": round(c["homeRuns"] * 9 / ip, 3) if ip else None,
        "hr_bf": round(c["homeRuns"] / bf, 5),
        "oppavg": round(c["hits"] / ab_ish, 4),
        "pitches": c["numberOfPitches"],
        # role comes from games started, not from whether a pi076 sample exists:
        # a starter who was hurt or on an innings limit still starts in October.
        "gs": c.get("gamesStarted") or 0,
        "g": c.get("gamesPitched") or 0,
    }


def splits_for(group, sits, who):
    """{player_id: {sitCode: rates}} for playoff-roster players only."""
    counts = HIT_COUNTS if group == "hitting" else PIT_COUNTS
    rate_fn = _hit_rates if group == "hitting" else _pit_rates
    out = {}
    for code in sits:
        j = _get("stats", stats="statSplits", sitCodes=code, group=group,
                 season=SEASON, playerPool="All", limit=3000, gameType="R")
        by_player = {}
        for st in j.get("stats", []):
            for row in st.get("splits", []):
                pid = (row.get("player") or {}).get("id")
                if pid in who:
                    by_player.setdefault(pid, []).append(row)
        kept = 0
        for pid, rows in by_player.items():
            r = rate_fn(_sum_rows(rows, counts))
            if r:
                out.setdefault(pid, {})[code] = r
                kept += 1
        print(f"  {group}/{code}: {kept} playoff players")
        time.sleep(0.4)          # the API is shared; do not hammer it
    return out


def season_totals(group, who):
    """Full-season line — the large sample the splits get regressed toward."""
    counts = HIT_COUNTS if group == "hitting" else PIT_COUNTS
    rate_fn = _hit_rates if group == "hitting" else _pit_rates
    j = _get("stats", stats="season", group=group, season=SEASON,
             playerPool="All", limit=3000, gameType="R")
    by_player = {}
    for st in j.get("stats", []):
        for row in st.get("splits", []):
            pid = (row.get("player") or {}).get("id")
            if pid in who:
                by_player.setdefault(pid, []).append(row)
    out = {}
    for pid, rows in by_player.items():
        r = rate_fn(_sum_rows(rows, counts))
        if r:
            out[pid] = r
    print(f"  {group}/season: {len(out)} playoff players")
    return out


def _fresh_enough(hours):
    """True when playoffs.json was last COMMITTED within `hours`.

    The ratings are built from FINAL regular-season stats, so once the season
    ends they barely move — re-pulling ~25 league-wide calls every 30 minutes
    would be pure waste against an API we share with production. The refresh
    workflow therefore passes --if-stale and this becomes a cheap no-op, the
    same way grading is a no-op when nothing is pending.

    AGE COMES FROM GIT, NOT FILE MTIME. `actions/checkout` writes every file
    fresh, so in CI an mtime check reports "just written" forever and the guard
    would skip on every single run — the ratings would never refresh again.
    fetch_odds.py learned this exact lesson on odds.json ("year-old odds look
    minutes old"); this mirrors its fix. mtime is only the local fallback for a
    file git has never seen.
    """
    f = OUT / "playoffs.json"
    if not f.exists() or f.stat().st_size < 200:
        return False
    ts = None
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%ct", "--", str(f)],
                             capture_output=True, text=True, timeout=15)
        if out.returncode == 0 and out.stdout.strip():
            ts = float(out.stdout.strip())
    except Exception:
        pass
    if ts is None:
        ts = f.stat().st_mtime          # never committed: fall back to mtime
    age_h = (time.time() - ts) / 3600.0
    if age_h < hours:
        print(f"playoffs.json last changed {age_h:.1f}h ago (< {hours}h) — skipping fetch")
        return True
    print(f"playoffs.json is {age_h:.1f}h old (>= {hours}h) — refreshing")
    return False


def main():
    # --if-stale N: only do the work when the payload is older than N hours.
    # --force overrides it, so a run can always be forced from the Actions tab.
    argv = sys.argv[1:]
    if "--if-stale" in argv and "--force" not in argv:
        try:
            hrs = float(argv[argv.index("--if-stale") + 1])
        except (IndexError, ValueError):
            hrs = 12.0
        if _fresh_enough(hrs):
            return 0

    field = playoff_field()
    if not field:
        # Not an error: before the first clinch there is simply no field yet.
        OUT.mkdir(exist_ok=True)
        (OUT / "playoffs.json").write_text(json.dumps(
            {"season": SEASON, "field": [], "hitters": [], "pitchers": [],
             "note": "no team has clinched yet"}), encoding="utf-8")
        print("no clinched teams yet — wrote empty playoff payload")
        return 0

    who = rosters(field)
    if not who:
        print("FATAL: clinched teams but no rosters resolved", file=sys.stderr)
        return 1

    print("hitting splits:")
    hit_sp = splits_for("hitting", HIT_SITS, who)
    hit_tot = season_totals("hitting", who)
    print("pitching splits:")
    pit_sp = splits_for("pitching", PIT_SITS, who)
    pit_tot = season_totals("pitching", who)

    hitters, pitchers = [], []
    for pid, meta in who.items():
        if meta["is_pitcher"]:
            tot = pit_tot.get(pid)
            if not tot or tot["bf"] < 60:      # bench arms are noise
                continue
            pitchers.append({"id": pid, **meta, "season": tot,
                             "splits": pit_sp.get(pid, {})})
        else:
            tot = hit_tot.get(pid)
            if not tot or tot["pa"] < 120:     # bench bats are noise
                continue
            hitters.append({"id": pid, **meta, "season": tot,
                            "splits": hit_sp.get(pid, {})})

    OUT.mkdir(exist_ok=True)
    payload = {"season": SEASON, "field": field,
               "hitters": hitters, "pitchers": pitchers}
    (OUT / "playoffs.json").write_text(json.dumps(payload), encoding="utf-8")
    print(f"playoffs.json: {len(field)} teams, {len(hitters)} hitters, "
          f"{len(pitchers)} pitchers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
