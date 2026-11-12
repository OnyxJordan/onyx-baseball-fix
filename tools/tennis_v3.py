#!/usr/bin/env python3
"""
tennis_v3.py - the tennis v3 match price: Onyx's own no-vig moneyline, adjusted (dev only; 11/12, Jordan: "go on
tennis", then "backtest all sports and finalize where we can on positive results").

    python3 tools/tennis_v3.py --fit      fit tennis_model.V3 on 2025 Onyx closing prices and print it
    python3 tools/tennis_v3.py            the v3 samples' fit diagnostics (log loss against Onyx, 2025 / 2026)

samples(): one row per Onyx moneyline (opening and closing price) matched to an ATP/WTA result, with player a's v3
features from tennis_model.v3_features on an Elo walk that only sees earlier matches. tools/picks_backtest.py prices
these with tennis_model.p_v3 (model weight 1: v3 already starts from Onyx's price) under the Onyx Picks rule.
"""
import json, math, os, sys
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tennis_model as TM            # noqa: E402
import sports_lab as L               # noqa: E402
from sports_common import nk         # noqa: E402

SPLIT = "2026-01-01"
FILES = ("bt/tennis_atp_lines.json", "bt/tennis_wta_lines.json")
KEYS = ("m7", "s3", "form", "qual", "layoff", "rest", "elo")


def sane(a, b):
    return a is not None and b is not None and -2000 <= a <= 2000 and -2000 <= b <= 2000 and abs(a) >= 100 and abs(b) >= 100


def samples(files=FILES):
    allm = json.load(open("bt/tennis_results_full.json"))
    lines = {}
    for f in files:
        if os.path.exists(f):
            lines.update(json.load(open(f)))
    by_pair = {}
    for m in allm:
        by_pair.setdefault((m["date"], frozenset((nk(m["w"]), nk(m["l"])))), m)
    want = defaultdict(list)
    for fid, x in lines.items():
        a, b = nk(x["home"]), nk(x["away"])
        d0 = (x.get("start") or "")[:10]
        if not d0:
            continue
        for dd in (d0, (date.fromisoformat(d0) - timedelta(days=1)).isoformat(), (date.fromisoformat(d0) + timedelta(days=1)).isoformat()):
            m = by_pair.get((dd, frozenset((a, b))))
            if m:
                want[m["id"]].append((x, a, b))
                break
    E = TM.Elo(TM.P)
    out = []
    for m in allm:
        for x, a, b in want.get(m["id"], []):
            if not (E.known(a) and E.known(b)):
                continue
            ml = (x.get("game") or {}).get("moneyline") or {}
            ka = next((k for k in ml if nk(k) == a), None)
            kb = next((k for k in ml if nk(k) == b), None)
            if not (ka and kb):
                continue
            for when in ("o", "c"):
                pa, pb = ml[ka][when][1], ml[kb][when][1]
                if not sane(pa, pb):
                    continue
                fa, _ = L.fair_pair(pa, pb)
                out.append({"date": m["date"], "gid": m["id"], "when": when, "over": pa, "under": pb, "fair": fa,
                            "f": TM.v3_features(E, a, b, m["date"], fa, m.get("round")), "y": 1 if nk(m["w"]) == a else 0})
        E.update(nk(m["w"]), nk(m["l"]), m.get("event"), m)
    return out


def fit(rows, keys=KEYS, it=400, lr=0.3):
    lg = lambda p: math.log(p / (1 - p))
    a, B = 1.0, {k: 0.0 for k in keys}
    for _ in range(it):
        ga, gB, n = 0.0, {k: 0.0 for k in keys}, len(rows)
        for r in rows:
            z = a * lg(r["fair"]) + sum(B[k] * r["f"][k] * TM.V3_SC[k] for k in keys)
            e = 1 / (1 + math.exp(-z)) - r["y"]
            ga += e * lg(r["fair"])
            for k in keys:
                gB[k] += e * r["f"][k] * TM.V3_SC[k]
        a -= lr * ga / n
        for k in keys:
            B[k] -= lr * gB[k] / n
    return {"a": round(a, 4), "B": {k: round(v, 4) for k, v in B.items()}}


def logloss(rows, C):
    s = m = 0.0
    for r in rows:
        p = min(max(TM.p_v3(r["fair"], r["f"], C), 1e-6), 1 - 1e-6)
        s -= math.log(p if r["y"] else 1 - p)
        m -= math.log(r["fair"] if r["y"] else 1 - r["fair"])
    return s / len(rows), m / len(rows), len(rows)


if __name__ == "__main__":
    S = samples()
    tune = [r for r in S if r["date"] < SPLIT and r["when"] == "c"]
    test = [r for r in S if r["date"] >= SPLIT and r["when"] == "c"]
    C = fit(tune) if "--fit" in sys.argv else TM.V3
    print("V3 =", json.dumps(C))
    for lab, rs in (("2025 (fit)", tune), ("2026 (held out)", test)):
        v, o, n = logloss(rs, C)
        print(f"  {lab}: log loss v3 {v:.5f} vs Onyx {o:.5f} on {n} closing prices")
