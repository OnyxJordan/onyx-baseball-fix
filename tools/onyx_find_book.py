#!/usr/bin/env python3
"""
onyx_find_book.py - which OpticOdds sportsbook id carries the prices the Onyx app shows?
(dev only; odds_probe.yml job=find)

11/5: the Onyx app showed prices while onyx_odds sent none to OpticOdds. Given a fixture
and the app's prices (a fingerprint), this pulls every sportsbook active for the league on
that fixture and ranks them by how many fingerprint prices they match exactly.

  OPTICODDS_API_KEY=... python3 tools/onyx_find_book.py
"""
import json, os, sys, time, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fetch_onyx import http_json, OPTIC   # noqa: E402

# the Onyx app, 11/5 ~7 PM ET (Jordan's screenshot): (market, selection contains, points, price)
FP = {
    "Jacksonville Jaguars @ Baltimore Ravens": [
        ("point_spread", "jaguars", -10, -110), ("point_spread", "ravens", 10, -110),
        ("total_points", "over", 39.5, -115), ("total_points", "under", 39.5, -105),
        ("moneyline", "jaguars", None, -535), ("moneyline", "ravens", None, 392)],
    "Cincinnati Bengals @ Atlanta Falcons": [
        ("point_spread", "bengals", -3, -112), ("point_spread", "falcons", 3, -108),
        ("total_points", "over", 52.5, -105), ("total_points", "under", 52.5, -115),
        ("moneyline", "bengals", None, -170), ("moneyline", "falcons", None, 142)],
}


def main():
    H = {"X-Api-Key": os.environ["OPTICODDS_API_KEY"]}

    def get(path, q):
        for i in range(4):
            try:
                return http_json(f"{OPTIC}{path}?{q}", headers=H)
            except Exception as e:
                if "429" in str(e) and i < 3:
                    time.sleep(5 * (i + 1)); continue
                print("  !", str(e)[:200]); return {}
            finally:
                time.sleep(0.3)

    books = [b.get("id") for b in (get("/sportsbooks/active", "sport=football&league=nfl").get("data") or [])]
    print(f"{len(books)} books active for NFL")
    fx = {}
    for f in get("/fixtures", "sport=football&league=nfl").get("data") or []:
        nm = f"{f.get('away_team_display')} @ {f.get('home_team_display')}"
        if nm in FP:
            fx[f["id"]] = nm
    print("fixtures:", fx)
    score = {}
    mk = "&market=moneyline&market=point_spread&market=total_points"
    for fid, nm in fx.items():
        for i in range(0, len(books), 5):
            q = f"sport=football&league=nfl&fixture_id={urllib.parse.quote(fid)}&odds_format=AMERICAN{mk}" + "".join(
                f"&sportsbook={urllib.parse.quote(str(b))}" for b in books[i:i + 5])
            for row in get("/fixtures/odds", q).get("data") or []:
                for od in row.get("odds") or []:
                    bk = od.get("sportsbook")
                    sel = f"{od.get('selection') or ''} {od.get('name') or ''} {od.get('selection_line') or ''}".lower()
                    for m, who, pts, price in FP[nm]:
                        if od.get("market_id") == m and who in sel and (pts is None or od.get("points") == pts) and od.get("price") == price:
                            score.setdefault(bk, set()).add((nm, m, who))
    ranked = sorted(score.items(), key=lambda kv: -len(kv[1]))
    n = sum(len(v) for v in FP.values())
    print(f"\nbooks matching the Onyx app's prices (of {n}):")
    for bk, hits in ranked[:15]:
        print(f"  {len(hits):2d}  {bk}")
    os.makedirs("probe", exist_ok=True)
    json.dump({bk: sorted(map(list, h)) for bk, h in ranked}, open("probe/find.json", "w"), indent=1)


if __name__ == "__main__":
    main()
