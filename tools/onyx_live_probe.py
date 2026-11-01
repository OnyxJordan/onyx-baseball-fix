#!/usr/bin/env python3
"""
onyx_live_probe.py - does the Onyx book price games while they are being played, and how often
do those prices move? (dev only; run by .github/workflows/odds_probe.yml, job=live)

For every fixture OpticOdds reports as live (football nfl/ncaaf, basketball nba, hockey nhl,
tennis), pulls every market Onyx prices on it, twice, `GAP` seconds apart, and reports per
fixture: markets priced, rows, player props or not, whether selection ids are present (bet
buttons), and how many prices changed between the two pulls. Read-only: prints to the log and
writes probe/live.json for the artifact.

  OPTICODDS_API_KEY=... python3 tools/onyx_live_probe.py [gap_seconds]
"""
import json, os, sys, time, urllib.parse
from collections import Counter
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

BOOK = os.environ.get("ONYX_SPORTSBOOK", "").strip() or "onyx_odds"
ALT = [b for b in os.environ.get("ALT_BOOKS", "draftkings,fanduel,pinnacle").split(",") if b]
LEAGUES = [("football", "nfl"), ("football", "ncaaf"), ("basketball", "nba"), ("hockey", "nhl"), ("tennis", None)]


def main():
    key = os.environ.get("OPTICODDS_API_KEY", "").strip()
    if not key:
        print("OPTICODDS_API_KEY not set")
        return 1
    gap = int((sys.argv[1:] or ["60"])[0])
    hdr = {"X-Api-Key": key}

    def get(url):
        for attempt in range(4):
            try:
                return http_json(url, headers=hdr)
            except Exception as e:
                if "429" in str(e) and attempt < 3:
                    time.sleep(6 * (attempt + 1))
                    continue
                print(f"  ! {str(e)[:200]}")
                return None
            finally:
                time.sleep(0.35)

    now = datetime.now(timezone.utc)
    days = [(now + timedelta(days=d)).strftime("%Y-%m-%d") for d in (-1, 0)]
    live, controls = [], []
    for sport, lg in LEAGUES:
        leagues = [lg] if lg else [l.get("id") for l in (get(f"{OPTIC}/leagues?sport={sport}") or {}).get("data") or []][:12]
        for league in leagues:
            for d in days:
                r = get(f"{OPTIC}/fixtures?sport={sport}&league={league}&start_date={d}") or {}
                for f in r.get("data") or []:
                    st = str(f.get("status") or "").lower()
                    if st == "live" or f.get("is_live"):
                        live.append((sport, league, f))
                    elif st == "unplayed" and not any(c[1] == league for c in controls):
                        controls.append((sport, league, f))   # control: a game not started yet should show prices
    seen = set()
    live = [x for x in live if not (x[2]["id"] in seen or seen.add(x[2]["id"]))]
    print(f"{len(live)} live fixtures at {now.isoformat(timespec='seconds')}")
    if not live:
        return 0

    def pull(sport, league, fid, book=None):
        u = f"{OPTIC}/fixtures/odds?sport={sport}&league={league}&sportsbook={urllib.parse.quote(book or BOOK)}&odds_format=AMERICAN&fixture_id={urllib.parse.quote(fid)}"
        r = get(u) or {}
        rows = []
        for row in r.get("data") or []:
            rows += row.get("odds") or []
        return rows

    out = {"book": BOOK, "at": now.isoformat(timespec="seconds"), "gap": gap, "fixtures": [], "controls": []}
    for sport, league, f in controls[:6]:
        c = pull(sport, league, f["id"])
        nm = f"{f.get('away_team_display') or ''} @ {f.get('home_team_display') or ''}"
        print(f"control (not started) {league} {nm} [{f.get('status')}, {f.get('start_date')}]: {len(c)} priced rows")
        out["controls"].append({"league": league, "name": nm, "rows": len(c)})
    first = {}
    for sport, league, f in live[:14]:
        first[f["id"]] = pull(sport, league, f["id"])
    time.sleep(gap)
    for sport, league, f in live[:14]:
        a = first[f["id"]]
        b = pull(sport, league, f["id"])
        pa = {(o.get("id") or (o.get("market_id"), o.get("name"), o.get("points"))): o.get("price") for o in a}
        moved = sum(1 for o in b if pa.get(o.get("id") or (o.get("market_id"), o.get("name"), o.get("points"))) not in (None, o.get("price")))
        mk = Counter(o.get("market_id") for o in b)
        props = sum(1 for o in b if o.get("player_id"))
        sels = sum(1 for o in b if (o.get("deep_link") or {}) or o.get("sgp") or o.get("selection_id") or o.get("id"))
        name = f"{f.get('away_team_display') or ''} @ {f.get('home_team_display') or ''}".strip()
        rec = {"sport": sport, "league": league, "fixture": f["id"], "name": name, "status": f.get("status"),
               "rows_first": len(a), "rows_second": len(b), "moved": moved, "props": props, "with_ids": sels,
               "markets": mk.most_common(25), "sample": b[:3]}
        out["fixtures"].append(rec)
        # control: the same live fixture from other books, to tell "Onyx does not price live" from "the feed has no live odds"
        alt = {bk: len(pull(sport, league, f["id"], bk)) for bk in ALT}
        rec["alt_books"] = alt
        print(f"\n{league} {name} [{f.get('status')}]: other books on this live game: {alt}")
        print(f"{league} {name} [{f.get('status')}]: {len(a)} -> {len(b)} priced rows, {moved} prices moved in {gap}s, "
              f"{props} player-prop rows; markets: {', '.join(f'{m}({n})' for m, n in mk.most_common(12))}")
        if b:
            print("  sample:", json.dumps(b[0])[:500])
    os.makedirs("probe", exist_ok=True)
    json.dump(out, open("probe/live.json", "w"), indent=1, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
