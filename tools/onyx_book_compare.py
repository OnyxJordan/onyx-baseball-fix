#!/usr/bin/env python3
"""
onyx_book_compare.py - do Onyx's two books on OpticOdds price the same? (dev only;
odds_probe.yml job=compare)

11/5: every Onyx price moved from onyx_odds (the sweeps book the site was built on) to
onyx_predictions (the prediction product) between 14:11 and 16:01 UTC. Before the site prices
from onyx_predictions, this checks that the two books post the same numbers: for finished
fixtures in the last few days, each book's opening and closing price on every market and
selection, side by side, from the historical endpoint (both books at the same moments).

  OPTICODDS_API_KEY=... python3 tools/onyx_book_compare.py [days]
"""
import json, os, sys, time, urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

A, B = "onyx_odds", "onyx_predictions"
LEAGUES = [("football", "nfl"), ("football", "ncaaf"), ("basketball", "nba"), ("basketball", "ncaab"), ("hockey", "nhl")]
MAX_FX = 6


def main():
    key = os.environ.get("OPTICODDS_API_KEY", "").strip()
    days = int((sys.argv[1:] or ["4"])[0])
    H = {"X-Api-Key": key}

    def get(path, q=""):
        for attempt in range(4):
            try:
                return http_json(f"{OPTIC}{path}?{q.lstrip('&')}", headers=H)
            except Exception as e:
                if "429" in str(e) and attempt < 3:
                    time.sleep(6 * (attempt + 1))
                    continue
                print("  !", path, str(e)[:200])
                return {}
            finally:
                time.sleep(0.3)

    now = datetime.now(timezone.utc)
    report = {}
    for sport, lg in LEAGUES:
        fx = []
        for d in range(days, -1, -1):
            day = (now - timedelta(days=d)).strftime("%Y-%m-%d")
            for f in get("/fixtures", f"sport={sport}&league={lg}&start_date={day}").get("data") or []:
                if str(f.get("status")).lower() == "completed":
                    fx.append(f)
        fx = fx[-MAX_FX:]
        cmp = {"open": [], "close": []}
        both = only_a = only_b = 0
        sample = []
        for f in fx:
            P = {}
            for bk in (A, B):
                r = get("/fixtures/odds/historical", f"sport={sport}&league={lg}&fixture_id={urllib.parse.quote(f['id'])}&sportsbook={bk}&odds_format=AMERICAN")
                rows = r.get("data") or []
                P[bk] = {}
                for od in (rows[0].get("odds") if rows else None) or []:
                    k = (od.get("market_id"), str(od.get("selection") or od.get("name")), str(od.get("selection_line") or ""), od.get("points"))
                    P[bk][k] = ((od.get("olv") or {}).get("price"), (od.get("clv") or {}).get("price"),
                                (od.get("olv") or {}).get("timestamp"), (od.get("clv") or {}).get("timestamp"))
            ka, kb = set(P[A]), set(P[B])
            both += len(ka & kb); only_a += len(ka - kb); only_b += len(kb - ka)
            for k in ka & kb:
                a, b = P[A][k], P[B][k]
                if a[0] is not None and b[0] is not None:
                    cmp["open"].append(a[0] - b[0] if (a[0] > 0) == (b[0] > 0) else None)
                if a[1] is not None and b[1] is not None:
                    cmp["close"].append(a[1] - b[1] if (a[1] > 0) == (b[1] > 0) else None)
                    if len(sample) < 8 and k[0] in ("moneyline", "point_spread", "total_points", "puck_line", "total_goals"):
                        sample.append(f"{f.get('away_team_display')} @ {f.get('home_team_display')} {k[0]} {k[1]} {k[2]} {k[3]}: "
                                      f"sweeps open {a[0]} close {a[1]} ({a[3]}) | predictions open {b[0]} close {b[1]} ({b[3]})")
        out = {"fixtures": len(fx), "markets_both": both, "only_sweeps": only_a, "only_predictions": only_b}
        for w in ("open", "close"):
            d = [x for x in cmp[w] if x is not None]
            flips = sum(1 for x in cmp[w] if x is None)
            same = sum(1 for x in d if x == 0)
            out[w] = {"compared": len(cmp[w]), "identical": same, "within_5": sum(1 for x in d if abs(x) <= 5),
                      "sign_flip": flips, "biggest": sorted(d, key=abs)[-3:] if d else []}
        report[f"{sport}/{lg}"] = out
        print(f"\n== {sport}/{lg}: {len(fx)} finished fixtures, {both} market-selections on both books "
              f"({only_a} sweeps only, {only_b} predictions only)")
        for w in ("open", "close"):
            o = out[w]
            pct = (100 * o["identical"] / o["compared"]) if o["compared"] else 0
            print(f"   {w:5}: {o['compared']} compared, {o['identical']} identical ({pct:.0f}%), {o['within_5']} within 5 cents, "
                  f"{o['sign_flip']} favorite/underdog flips, biggest gaps {o['biggest']}")
        for s in sample:
            print("   ", s)
    os.makedirs("probe", exist_ok=True)
    json.dump(report, open("probe/compare.json", "w"), indent=1)


if __name__ == "__main__":
    main()
