#!/usr/bin/env python3
"""Dev-only probe (temporary): log the SHAPE of OpticOdds NBA responses so
the NBA parsers are built against real payloads. Never prints the key."""
import json, os, sys, time, urllib.parse
sys.path.insert(0, ".")
from fetch_onyx import http_json, OPTIC

H = {"X-Api-Key": os.environ.get("OPTICODDS_API_KEY", "").strip()}
q = "sport=basketball&league=nba"
def get(url):
    try:
        return http_json(url, headers=H)
    except Exception as e:
        print("ERROR", url.split("?")[0], str(e)[:300]); return {}
    finally:
        time.sleep(1.5)

lx = get(f"{OPTIC}/fixtures/player-results/last-x?{q}&player_id=B1E5A70A859B")
r = (lx.get("data") or [{}])[0]
st = r.get("stats") or {}
print("LASTX keys:", sorted(st.keys()))
for k in ("minutes", "points", "total_rebounds", "assists", "three_point_field_goals_made", "fixture_ids", "start_dates", "dates", "status"):
    if k in st: print("  ", k, len(st[k]), st[k][:6])
print("LASTX other top-level:", [k for k in r if k != "stats"])
lx2 = get(f"{OPTIC}/fixtures/player-results/last-x?{q}&player_id=B1E5A70A859B&last_x=82")
print("last_x=82 len:", len(((lx2.get('data') or [{}])[0].get('stats') or {}).get('points', [])))

d = get(f"{OPTIC}/fixtures?{q}&start_date=2026-10-23")
fids = [f["id"] for f in d.get("data", [])]
print("abbr/name pairs:", sorted({(c["abbreviation"], c["name"]) for f in d.get("data", []) for s in ("home_competitors", "away_competitors") for c in f[s]}))
multi = get(f"{OPTIC}/fixtures/player-results?" + "&".join(f"fixture_id={x}" for x in fids[:3]))
rows = multi.get("data") or []
print("multi fixture player-results rows:", len(rows))
if rows:
    res = rows[0].get("results") or []
    print("players in fixture 0:", len(res), "statuses:", sorted({str(x.get('status')) for x in res}))
    low = [x for x in res if not x.get("stats") or all((s.get("stats") or {}).get("minutes", 0) in (0, None) for s in x.get("stats") or [] if s.get("period") == "all")]
    print("no-minute rows:", len(low), json.dumps(low[:1])[:600])
    print("result keys:", list(res[0].keys()) if res else None)
inj = get(f"{OPTIC}/injuries?{q}&page=2")
print("injuries page2:", len(inj.get("data") or []), inj.get("has_more"))
allinj = (get(f"{OPTIC}/injuries?{q}").get("data") or [])
print("injury statuses:", sorted({str(i.get('status')) for i in allinj}))
pl = get(f"{OPTIC}/players?{q}&page=7")
print("players page7:", len(pl.get("data") or []), pl.get("has_more"))
fx = get(f"{OPTIC}/fixtures?{q}&start_date=2026-10-24")
up = [f for f in fx.get("data", []) if f.get("status") == "unplayed"]
if up:
    f0 = up[-1]["id"]
    mk = "".join(f"&market={m}" for m in ("moneyline", "point_spread", "total_points", "player_points", "player_rebounds", "player_assists"))
    o = get(f"{OPTIC}/fixtures/odds?{q}&sportsbook=onyx_odds&odds_format=AMERICAN&fixture_id={f0}{mk}")
    od = ((o.get("data") or [{}])[0].get("odds")) or []
    print("filtered odds:", len(od), sorted({x["market_id"] for x in od}))
    mains = [x for x in od if x.get("is_main")]
    print("main rows:", len(mains))
    for m in ("moneyline", "point_spread", "total_points", "player_points"):
        for x in [y for y in od if y["market_id"] == m and (y.get("is_main") or m == "moneyline")][:2]:
            print("  ", m, x["name"], x["price"], x.get("points"), x.get("selection_line"), x.get("is_main"), x.get("player_id"), (x.get("deep_link") or {}).get("desktop"))
    pp = [x for x in od if x["market_id"] == "player_points"]
    per = {}
    for x in pp: per.setdefault(x["selection"], []).append((x["points"], x["selection_line"], x["price"], x["is_main"]))
    k0 = next(iter(per)) if per else None
    print("player_points ladder sample:", k0, sorted(per.get(k0, [])))
    print("players with a main pts line:", sum(1 for v in per.values() if any(m for *_, m in v)), "of", len(per))
