#!/usr/bin/env python3
"""
picks_lines.py - the committed Onyx lines history the Onyx Picks re-test reads. Dev only
(tools/picks_backtest.py and the weekly .github/workflows/picks_retest.yml; never the pipeline).

data/picks/lines/<sport>.json holds, per completed fixture, only what the replays read:
  {fixture id: {"start", "home", "away", "hs", "as", "game": {market: {side: {"o": [pts, price], "c": [...]}}},
                "props": {player: {market: {"o": [line, over, under], "c": [...]}}}}}
the same shape tools/onyx_lines_pull.py writes, so a replay can read it in place of a bt/ cache.
Preseason fixtures carry "pre": 1. NBA fixtures also carry "q1" / "h1" (both teams' points in the
1st quarter / 1st half, from ESPN's official line scores: `periods`) so the 1st-quarter and 1st-half totals can be graded.

    python3 tools/picks_lines.py seed                     # build the store from the bt/ research caches
    python3 tools/picks_lines.py pullargs <sport> <days>  # onyx_lines_pull.py args: the last <days> baseball days
    python3 tools/picks_lines.py merge <sport> <pull.json> [...]   # append a pull (superset: never overwrites a price)
    python3 tools/picks_lines.py periods                  # NBA: 1st-quarter / 1st-half scores from ESPN where missing

A merge only fills what is missing: a price already on file is never changed, and a pull that
disagrees with one is counted and reported as a conflict (Onyx's historical open / close for a
completed game does not move, so a conflict means a bad pull, not new information).
"""
import json, os, sys
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
STORE = os.path.join(ROOT, "data", "picks", "lines")

# sport: (OpticOdds sport, league, game markets kept, player markets kept, props kept from this day on)
SPORTS = {
    "nfl": ("football", "nfl", ("moneyline", "point_spread", "total_points"), ("player_receptions",), ""),
    "cfb": ("football", "ncaaf", ("moneyline", "point_spread", "total_points"),
            ("player_receptions", "player_receiving_yards", "player_rushing_yards", "player_passing_yards"), ""),
    "nhl": ("hockey", "nhl", ("moneyline", "puck_line", "total_goals"), (), ""),
    # NBA props only for 2026-27 on: 2025-26 is replayed once from bt/ and kept as its card (nba_frozen.json)
    "nba": ("basketball", "nba", ("point_spread", "total_points", "1st_quarter_total_points", "1st_half_total_points"),
            ("player_points", "player_rebounds", "player_assists"), "2026-08-01"),
    # college player props (11/3): Onyx prices them over only; tools/cbb_props_backtest.py
    "cbb": ("basketball", "ncaab", ("moneyline", "point_spread", "total_points"),
            ("player_points", "player_rebounds", "player_assists", "player_made_threes",
             "player_points_+_rebounds_+_assists"), ""),
}
# the research caches the store was seeded from (and that a local run still reads, merged with the store)
BT = {
    "nfl": ("bt/nfl_game.json", "bt/nfl_lines.json"),
    "cfb": ("bt/cfb_lines.json", "bt/cfb_props.json"),
    "nhl": ("bt/nhl_lines.json",),
    "nba": ("bt/nba_2425_lines.json", "bt/nba_lines_full.json"),
    "cbb": ("bt/cbb_lines.json", "bt/cbb_props.json"),
}
FIELDS = ("start", "home", "away", "hs", "as")


def path(sport):
    return os.path.join(STORE, f"{sport}.json")


def baseball_day():
    """ET - 4h (CLAUDE.md: never UTC 'today'); ET taken as UTC-5 / UTC-4 by the US DST rule."""
    now = datetime.now(timezone.utc)
    y = now.year
    dst0 = datetime(y, 3, 8, 7, tzinfo=timezone.utc) + timedelta(days=(6 - datetime(y, 3, 8).weekday()) % 7)
    dst1 = datetime(y, 11, 1, 6, tzinfo=timezone.utc) + timedelta(days=(6 - datetime(y, 11, 1).weekday()) % 7)
    et = now - timedelta(hours=4 if dst0 <= now < dst1 else 5)
    return (et - timedelta(hours=4)).date()


def compact(sport, x):
    """One fixture reduced to what the replays read."""
    _, _, gm, pm, props_from = SPORTS[sport]
    out = {k: x.get(k) for k in FIELDS}
    if str(x.get("season_type") or "").lower() == "preseason" or x.get("pre"):
        out["pre"] = 1
    out["game"] = {m: v for m, v in (x.get("game") or {}).items() if m in gm and v}
    props = {}
    if pm and (x.get("start") or "")[:10] >= props_from:
        for who, ms in (x.get("props") or {}).items():
            keep = {m: v for m, v in ms.items() if m in pm}
            if keep:
                props[who] = keep
    out["props"] = props
    for k in ("q1", "h1"):
        if x.get(k) is not None:
            out[k] = x[k]
    return out


def _fill(old, new, where, rep):
    """Fill None / missing values of old from new; count real disagreements."""
    if isinstance(old, dict) and isinstance(new, dict):
        for k, v in new.items():
            if k not in old or old[k] is None:
                old[k] = v
                rep["filled"] += 1
            else:
                old[k] = _fill(old[k], v, where, rep)
        return old
    if isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        out = []
        for a, b in zip(old, new):
            if a is None and b is not None:
                rep["filled"] += 1
                out.append(b)
            elif a is not None and b is not None and a != b:
                rep["conflicts"] += 1
                if rep["conflicts"] <= 5:
                    print(f"  conflict {where}: kept {old}, pull says {new}")
                out.append(a)
            else:
                out.append(a)
        return out
    if old is not None and new is not None and old != new:
        rep["conflicts"] += 1
        if rep["conflicts"] <= 5:
            print(f"  conflict {where}: kept {old}, pull says {new}")
    return old if old is not None else new


def merge_into(store, sport, pulled, rep=None):
    rep = rep if rep is not None else {"added": 0, "filled": 0, "conflicts": 0}
    for fid, x in pulled.items():
        c = compact(sport, x)
        if not c["game"] and not c["props"]:
            continue            # nothing a replay reads
        if sport == "nba" and not c["props"] and not any(m.startswith("1st_") for m in c["game"]):
            continue            # NBA game lines are read only beside a 1st-quarter / 1st-half line or props
        if fid not in store:
            store[fid] = c
            rep["added"] += 1
        else:
            _fill(store[fid], c, fid, rep)
    return rep


def load(sport):
    p = path(sport)
    return json.load(open(p)) if os.path.exists(p) else {}


def save(sport, store):
    os.makedirs(STORE, exist_ok=True)
    # one fixture a line, oldest first: a weekly append is a small diff
    rows = sorted(store.items(), key=lambda kv: (kv[1].get("start") or "", kv[0]))
    body = "{\n" + ",\n".join(json.dumps(k) + ":" + json.dumps(v, separators=(",", ":")) for k, v in rows) + "\n}\n"
    p = path(sport)
    if os.path.exists(p) and open(p).read() == body:
        return False
    open(p, "w").write(body)
    return True


def lines(sport, *bt_files):
    """What a replay reads: the committed store, with any local bt/ cache merged over it (a superset either way)."""
    out = json.loads(json.dumps(load(sport)))
    for f in bt_files:
        f = os.path.join(ROOT, f)
        if os.path.exists(f):
            for fid, x in json.load(open(f)).items():
                if fid in out:
                    _fill(out[fid], x, fid, {"added": 0, "filled": 0, "conflicts": 0})
                else:
                    out[fid] = x
    return out


def nba_periods():
    """{d, teams, q1, h1} rows: the store's ESPN line scores (what Onyx and picks.py grade on) first, then
    bt/nba_periods.json (play-by-play: 164 of 2,460 games differ from the line score, mostly by a free throw at the horn) for any game the store lacks."""
    from nba_common import team_abbr
    rows, seen = [], set()
    for fid, x in load("nba").items():
        if x.get("q1") is None or not x.get("start"):
            continue
        k = (et_day(x["start"]), tuple(sorted([team_abbr(x.get("home")) or "", team_abbr(x.get("away")) or ""])))
        if k not in seen:
            seen.add(k)
            rows.append({"d": k[0], "teams": list(k[1]), "q1": x["q1"], "h1": x.get("h1")})
    f = os.path.join(ROOT, "bt", "nba_periods.json")
    if os.path.exists(f):
        for g in json.load(open(f)):
            if (g["d"], tuple(g["teams"])) not in seen:
                rows.append(g)
    return rows


def et_day(iso):
    """tools/rules_lab_build.et_day: start - 8h (UTC -> ET -> the -4h baseball day)."""
    return (datetime.fromisoformat(str(iso).replace("Z", "+00:00")) - timedelta(hours=8)).date().isoformat()


def periods():
    """Fill q1 / h1 for finished NBA fixtures from ESPN's scoreboard line scores."""
    from nba_common import team_abbr
    from sports_common import espn_get
    store = load("nba")
    want = {}
    for fid, x in store.items():
        if x.get("q1") is not None or not x.get("start") or x.get("hs") is None:
            continue                # (the feed's own "Preseason" label is wrong on some games: ESPN's season type decides)
        k = (et_day(x["start"]), tuple(sorted([team_abbr(x.get("home")) or "", team_abbr(x.get("away")) or ""])))
        want.setdefault(k[0], []).append((fid, k[1]))
    got = 0
    for d, fx in sorted(want.items()):
        j = espn_get("basketball/nba/scoreboard", f"dates={d.replace('-', '')}") or {}
        for ev in j.get("events") or []:
            comp = (ev.get("competitions") or [{}])[0]
            if not ((comp.get("status") or {}).get("type") or {}).get("completed"):
                continue
            if (ev.get("season") or {}).get("type") == 1:
                continue            # preseason: never graded (the 1st-quarter and 1st-half tests are on real games)
            cs = comp.get("competitors") or []
            teams = tuple(sorted((c.get("team") or {}).get("abbreviation") or "" for c in cs))
            ls = [[float(p.get("value") or 0) for p in (c.get("linescores") or [])] for c in cs]
            if len(ls) != 2 or any(len(a) < 2 for a in ls):
                continue
            for fid, t in fx:
                if t == teams:
                    store[fid]["q1"] = int(ls[0][0] + ls[1][0])
                    store[fid]["h1"] = int(sum(ls[0][:2]) + sum(ls[1][:2]))
                    got += 1
    print(f"periods: {got} NBA games scored from ESPN ({sum(len(v) for v in want.values()) - got} still missing)")
    return save("nba", store)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "seed":
        for sport, files in BT.items():
            store = load(sport)
            for f in files:
                if os.path.exists(os.path.join(ROOT, f)):
                    rep = merge_into(store, sport, json.load(open(os.path.join(ROOT, f))))
                    print(f"seed {sport} <- {f}: {rep}")
            save(sport, store)
            print(f"  {path(sport)}: {len(store)} fixtures, {os.path.getsize(path(sport)) // 1024} KB")
    elif cmd == "pullargs":
        sport, days = sys.argv[2], int(sys.argv[3])
        sp, lg, gm, pm, _ = SPORTS[sport]
        end = baseball_day()
        print(sp, lg, (end - timedelta(days=days - 1)).isoformat(), end.isoformat(), ",".join(gm + pm), f"pulls/{sport}.json")
    elif cmd == "merge":
        sport = sys.argv[2]
        store = load(sport)
        rep = {"added": 0, "filled": 0, "conflicts": 0}
        for f in sys.argv[3:]:
            if os.path.exists(f):
                merge_into(store, sport, json.load(open(f)), rep)
            else:
                print(f"  {f}: no pull file (pull failed?), skipped")
        changed = save(sport, store)
        print(f"merge {sport}: {rep['added']} fixtures added, {rep['filled']} values filled, {rep['conflicts']} conflicts "
              f"(kept the line on file); {len(store)} on file{'' if changed else ', unchanged'}")
    elif cmd == "periods":
        periods()
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
