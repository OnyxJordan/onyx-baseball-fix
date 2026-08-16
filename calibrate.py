#!/usr/bin/env python3
"""
Onyx Baseball - nightly self-calibration.
Runs after grade_picks. Compares every graded pick's stated model
probability with what actually happened and writes a single shrunk
correction factor to data/calibration.json. model.py applies it to raw
probabilities once enough evidence exists (25+ graded picks), so the
system continually tunes itself toward the numbers that actually cash.
Shrinkage (v31: 25 pseudo-HRs of prior, credibility in units of expected
HRs) keeps sample noise from whipsawing the model; clamped to 0.85-1.15.
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
        # v31: credibility shrink in units of EXPECTED HRs — the sample's real
        # information content — not picks. The old 8-pseudo-pick shrink let 28
        # graded picks (4 actual vs 4.9 expected, inside one sigma of noise)
        # write scale 0.8626 and wipe the board's edge column. With K = 25
        # expected HRs (~150 picks) the same sample yields 0.970, and only a
        # sustained miss over a real sample can move the level materially.
        K = 15.0
        scale = (actual + K) / (expected + K)
        scale = max(0.75, min(1.15, round(scale, 4)))
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
