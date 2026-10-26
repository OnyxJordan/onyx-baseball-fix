#!/usr/bin/env python3
"""
onyx_markets_probe.py - what does the Onyx book actually price, per sport?

Dev-only (run by .github/workflows/odds_probe.yml, which holds the
OpticOdds key). Read-only: prints a summary to the job log and writes
probe/markets.json for the artifact. Nothing is committed or deployed.

For each sport it lists OpticOdds' active leagues, takes a few upcoming
fixtures per league, pulls every market the Onyx book prices on them and
reports, per market id: rows, how many are flagged is_main, whether over /
under (or yes / no) sides exist, whether rows carry a player_id, a sample
selection and whether Onyx share links (selection uuids) are present.

  OPTICODDS_API_KEY=... python3 tools/onyx_markets_probe.py [sport ...]
"""
import json, os, sys, time, urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

SPORTS = ["football", "hockey", "tennis", "golf", "basketball", "baseball"]
LEAGUE_HINT = {"football": ["nfl", "ncaaf"], "hockey": ["nhl"], "basketball": ["nba"], "baseball": ["mlb"]}
BOOK = os.environ.get("ONYX_SPORTSBOOK", "").strip() or "onyx_odds"


def main():
    key = os.environ.get("OPTICODDS_API_KEY", "").strip()
    if not key:
        print("OPTICODDS_API_KEY not set")
        return 1
    hdr = {"X-Api-Key": key}

    def get(url):
        for attempt in range(4):
            try:
                return http_json(url, headers=hdr)
            except Exception as e:
                if "429" in str(e) and attempt < 3:
                    time.sleep(6 * (attempt + 1))
                    continue
                print(f"  ! {str(e)[:160]}")
                return None
            finally:
                time.sleep(0.35)

    sports = sys.argv[1:] or SPORTS
    now = datetime.now(timezone.utc)
    out = {"book": BOOK, "at": now.isoformat(timespec="seconds"), "sports": {}}
    for sport in sports:
        lg = get(f"{OPTIC}/leagues?sport={sport}") or {}
        leagues = [l.get("id") for l in lg.get("data") or [] if l.get("id")]
        active = [l for l in LEAGUE_HINT.get(sport, []) if l in leagues] or leagues
        print(f"\n=== {sport}: {len(leagues)} leagues; probing {len(active[:8])}: {', '.join(active[:8])}")
        out["sports"][sport] = {"leagues": leagues, "probed": {}}
        for league in active[:8]:
            fx = []
            for d in range(0, 8):
                day = (now + timedelta(days=d)).strftime("%Y-%m-%d")
                r = get(f"{OPTIC}/fixtures?sport={sport}&league={urllib.parse.quote(league)}&start_date={day}") or {}
                fx += [f for f in r.get("data") or [] if f.get("status") in (None, "unplayed", "live")]
                if len(fx) >= 4:
                    break
            if not fx:
                print(f"  {league}: no upcoming fixtures")
                continue
            mk = defaultdict(lambda: {"rows": 0, "main": 0, "sides": set(), "player": 0, "sel": 0, "sample": None, "name": None})
            priced = 0
            for f in fx[:4]:
                r = get(f"{OPTIC}/fixtures/odds?sport={sport}&league={urllib.parse.quote(league)}"
                        f"&sportsbook={urllib.parse.quote(BOOK)}&odds_format=AMERICAN&fixture_id={urllib.parse.quote(f['id'])}") or {}
                for row in r.get("data") or []:
                    odds = row.get("odds") or []
                    priced += bool(odds)
                    for od in odds:
                        m = mk[od.get("market_id") or od.get("market")]
                        m["rows"] += 1
                        m["main"] += bool(od.get("is_main"))
                        m["sides"].add(str(od.get("selection_line") or od.get("name") or "")[:12].lower())
                        m["player"] += bool(od.get("player_id"))
                        m["sel"] += "selection=" in json.dumps(od.get("deep_link") or {})
                        m["name"] = m["name"] or od.get("market")
                        if not m["sample"]:
                            m["sample"] = {k: od.get(k) for k in ("name", "selection", "selection_line", "points", "price", "is_main")}
            names = [f"{(f.get('away_competitors') or [{}])[0].get('name', '')} @ {(f.get('home_competitors') or [{}])[0].get('name', '')}"
                     if f.get('home_competitors') else f.get('tournament', {}).get('name') or f.get('id') for f in fx[:4]]
            print(f"  {league}: {len(fx)} upcoming, {priced} of {min(4, len(fx))} priced by {BOOK} · {', '.join(str(n) for n in names)}")
            res = {}
            for mid, m in sorted(mk.items(), key=lambda kv: -kv[1]["rows"]):
                sides = sorted(s for s in m["sides"] if s)[:6]
                print(f"    {mid:<42} rows {m['rows']:>5}  main {m['main']:>4}  player {m['player']:>5}  links {m['sel']:>5}  sides {sides}")
                res[mid] = {**{k: v for k, v in m.items() if k != "sides"}, "sides": sides}
            out["sports"][sport]["probed"][league] = {"fixtures": names, "markets": res}
    os.makedirs("probe", exist_ok=True)
    json.dump(out, open("probe/markets.json", "w"), indent=1, default=str)
    print("\nwrote probe/markets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
