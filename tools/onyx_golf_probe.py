#!/usr/bin/env python3
"""
onyx_golf_probe.py - which golf markets does the Onyx book price, now and in the past?

Dev-only (run by .github/workflows/odds_probe.yml with job=golf, which holds the
OpticOdds key). Read-only: prints a summary and writes probe/golf.json for the
artifact. Nothing is committed or deployed.

The general probe samples four fixtures per league, and for golf those were
head-to-head matchups Onyx does not price. This one scans every upcoming fixture
in each golf league (tournament-level fixtures carry outrights: winner, top 5 /
10 / 20, make the cut) and then asks /fixtures/odds/historical for the last
60 days of completed fixtures, so a backtest knows what history exists.

  OPTICODDS_API_KEY=... python3 tools/onyx_golf_probe.py [league ...]
"""
import json, os, sys, time, urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

BOOK = os.environ.get("ONYX_SPORTSBOOK", "").strip() or "onyx_odds"


def main():
    key = os.environ.get("OPTICODDS_API_KEY", "").strip()
    if not key:
        print("OPTICODDS_API_KEY not set")
        return 1
    hdr = {"X-Api-Key": key}

    def get(path, params):
        for attempt in range(5):
            try:
                return http_json(f"{OPTIC}{path}?sport=golf&{params}", headers=hdr)
            except Exception as e:
                if "429" in str(e) and attempt < 4:
                    time.sleep(6 * (attempt + 1))
                    continue
                print(f"  ! {path} {str(e)[:160]}")
                return None
            finally:
                time.sleep(0.3)

    now = datetime.now(timezone.utc)
    leagues = sys.argv[1:] or ["pga", "lpga", "liv", "dp_world_tour", "korn_ferry", "champions_tour"]
    out = {"book": BOOK, "at": now.isoformat(timespec="seconds"), "leagues": {}}
    mk_all = get("/markets", "") or {}
    out["golf_markets"] = sorted({m.get("id") for m in mk_all.get("data") or [] if m.get("id")})[:400]
    print(f"golf market ids known to OpticOdds: {len(out['golf_markets'])}")

    def scan(fx, historical):
        mk = defaultdict(lambda: {"rows": 0, "fixtures": 0, "player": 0, "sample": None})
        priced = []
        for f in fx:
            q = f"league={urllib.parse.quote(f['_lg'])}&sportsbook={urllib.parse.quote(BOOK)}&fixture_id={urllib.parse.quote(f['id'])}"
            r = get("/fixtures/odds/historical" if historical else "/fixtures/odds",
                    q + ("" if historical else "&odds_format=AMERICAN")) or {}
            seen = set()
            for row in r.get("data") or []:
                for od in row.get("odds") or []:
                    mid = od.get("market_id") or od.get("market")
                    m = mk[mid]
                    m["rows"] += 1
                    m["player"] += bool(od.get("player_id"))
                    if mid not in seen:
                        m["fixtures"] += 1
                        seen.add(mid)
                    if not m["sample"]:
                        m["sample"] = {k: od.get(k) for k in ("name", "selection", "points", "price", "is_main")}
            if seen:
                priced.append(f.get("_name"))
        return mk, priced

    def name_of(f):
        if f.get("home_competitors"):
            a = (f.get("away_competitors") or [{}])[0].get("name", "")
            h = (f.get("home_competitors") or [{}])[0].get("name", "")
            return f"{a} @ {h}"
        return (f.get("tournament") or {}).get("name") or f.get("name") or f.get("id")

    for lg in leagues:
        res = {}
        for label, days, historical in (("upcoming", range(0, 10), False), ("past60", range(-60, 0), True)):
            fx, seen_ids = [], set()
            for d in days:
                day = (now + timedelta(days=d)).strftime("%Y-%m-%d")
                r = get("/fixtures", f"league={urllib.parse.quote(lg)}&start_date={day}") or {}
                for f in r.get("data") or []:
                    if f["id"] in seen_ids:
                        continue
                    st = str(f.get("status")).lower()
                    if historical and st != "completed":
                        continue
                    if not historical and st not in ("unplayed", "live", "none"):
                        continue
                    seen_ids.add(f["id"])
                    f["_lg"], f["_name"] = lg, name_of(f)
                    fx.append(f)
            # tournament-level fixtures (no head-to-head competitors) first: they carry outrights
            fx.sort(key=lambda f: bool(f.get("home_competitors")))
            mk, priced = scan(fx[:80], historical)
            kinds = {"tournament": sum(1 for f in fx if not f.get("home_competitors")),
                     "matchup": sum(1 for f in fx if f.get("home_competitors"))}
            print(f"\n=== {lg} {label}: {len(fx)} fixtures {kinds}, scanned {min(80, len(fx))}, priced by {BOOK}: {len(priced)}")
            for n in priced[:8]:
                print(f"    priced: {n}")
            for mid, m in sorted(mk.items(), key=lambda kv: -kv[1]["rows"])[:40]:
                print(f"    {str(mid):<44} fixtures {m['fixtures']:>4} rows {m['rows']:>6} player {m['player']:>6}  e.g. {m['sample']}")
            res[label] = {"fixtures": len(fx), "kinds": kinds, "priced": priced[:40], "markets": mk}
        out["leagues"][lg] = res
    os.makedirs("probe", exist_ok=True)
    json.dump(out, open("probe/golf.json", "w"), indent=1, default=str)
    print("\nwrote probe/golf.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
