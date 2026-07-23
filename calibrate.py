#!/usr/bin/env python3
"""
Onyx Baseball - nightly self-calibration.
Runs after grade_picks. Compares every graded pick's stated model
probability with what actually happened and writes a single shrunk
correction factor to data/calibration.json. model.py applies it to raw
probabilities once enough evidence exists (25+ graded picks), so the
system continually tunes itself toward the numbers that actually cash.
Shrinkage (8 pseudo-picks at expectation) keeps early noise from
whipsawing the model; the factor is clamped to 0.75-1.25.
"""

import json
from datetime import datetime, timezone

PICKS = "data/picks_input.json"
OUT   = "data/calibration.json"

BUCKETS = [(0.0, 0.10, "under 10%"), (0.10, 0.15, "10-15%"),
           (0.15, 0.20, "15-20%"), (0.20, 1.01, "20%+")]

def main():
    try:
        picks = json.load(open(PICKS, encoding="utf-8"))
    except Exception:
        picks = []
    graded = [p for p in picks if isinstance(p, dict)
              and p.get("hit") in (True, False) and p.get("prob")]
    n = len(graded)
    expected = sum(float(p["prob"]) for p in graded)
    actual = sum(1 for p in graded if p["hit"] is True)

    if n:
        pbar = expected / n
        k = 8.0                      # pseudo-picks at expectation
        scale = (actual + k * pbar) / (expected + k * pbar)
        scale = max(0.75, min(1.25, round(scale, 4)))
    else:
        scale = 1.0

    buckets = []
    for lo, hi, label in BUCKETS:
        bp = [p for p in graded if lo <= float(p["prob"]) < hi]
        bh = sum(1 for p in bp if p["hit"] is True)
        buckets.append({
            "range": label, "n": len(bp), "hits": bh,
            "hit_rate": round(bh / len(bp), 4) if bp else None,
            "model_avg": round(sum(float(p["prob"]) for p in bp) / len(bp), 4) if bp else None,
        })

    out = {
        "n": n, "expected_hr": round(expected, 2), "actual_hr": actual,
        "scale": scale, "active": n >= 25,
        "buckets": buckets,
        "updated": datetime.now(timezone.utc).isoformat(),
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), indent=1)
    state = "ACTIVE" if n >= 25 else f"collecting ({n}/25 graded)"
    print(f"calibration: n={n} expected={expected:.1f} actual={actual} "
          f"scale={scale} [{state}]")

if __name__ == "__main__":
    main()
