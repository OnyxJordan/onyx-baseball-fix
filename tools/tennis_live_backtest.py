"""
tools/tennis_live_backtest.py - how well the tennis live model's match-win chance is calibrated
from in-match score states, against final results (dev only, never runs in the pipeline).

  python3 tools/tennis_live_backtest.py --pull    # ESPN set scores, 2025-01-01 on -> bt/tennis_sets.json
  python3 tools/tennis_live_backtest.py           # fit the tour serve baselines, then the backtest
                                                  # -> data/tennis/live_backtest.json

Data: ESPN's ATP and WTA scoreboards carry every finished singles match with its games per set
(tiebreaks marked), never the point score or the order of games inside a set. So:
  - set boundaries (0-0 in set 2 after 6-4, and so on) are EXACT states;
  - in-set states (3-2 in set 2) are RECONSTRUCTED: a game order drawn at random among the
    orders that end at the real set score, server unknown (the model averages both). These are
    approximate and reported separately.
  Retirements and walkovers are dropped.

Pre-match chance: Elo walk-forward (tennis_model, ratings built only on earlier matches, both
players 10+ matches), and where Onyx priced the match (bt/tennis_*_lines.json) its closing
no-vig moneyline. The page uses Onyx's pregame price first (the tennis blend weight is 0, so the
blended chance IS Onyx's), Elo when there is none, so both are reported.

Fit: the tour point-on-serve baseline and the form gap (live_model.TN_P) by the likelihood of every
set score, on matches before 2026-01-01; judged on 2026 on, which the fit never saw.

Baselines: the pre-match chance alone (what a bettor who ignores the score has), and the old
live.js tennis model (sets only: one set-win chance fitted to the pre-match price, games ignored).

There is no historical live-price data, so this says nothing about value against live lines.
"""

import json, math, random, sys, time, os
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_model as LM  # noqa: E402

SETS = "bt/tennis_sets.json"
SPLIT = "2026-01-01"


def pull(start="2025-01-01", step=4):
    import requests
    seen = {}
    try:
        for m in json.load(open(SETS)):
            seen[m["id"]] = m
    except Exception:
        pass
    d, end = date.fromisoformat(start), date.today()
    while d <= end:
        for tour in ("atp", "wta"):
            u = f"https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates={d:%Y%m%d}"
            try:
                j = requests.get(u, timeout=25).json()
            except Exception as e:
                print("  skip", d, tour, str(e)[:60])
                continue
            for e in j.get("events") or []:
                for gr in e.get("groupings") or []:
                    draw = (gr.get("grouping") or {}).get("displayName") or ""
                    if "Singles" not in draw:
                        continue
                    t = "WTA" if "Women" in draw else "ATP"
                    for c in gr.get("competitions") or []:
                        st = ((c.get("status") or {}).get("type") or {})
                        if st.get("name") != "STATUS_FINAL" or c.get("id") in seen:
                            continue
                        ps = c.get("competitors") or []
                        if len(ps) != 2:
                            continue
                        ps = sorted(ps, key=lambda p: p.get("order") or 0)
                        ls = [[int(l.get("value") or 0) for l in p.get("linescores") or []] for p in ps]
                        if not ls[0] or len(ls[0]) != len(ls[1]) or not any(p.get("winner") for p in ps):
                            continue
                        seen[c["id"]] = {"id": c["id"], "date": (c.get("date") or "")[:10], "tour": t, "event": e.get("name"),
                                         "round": (c.get("round") or {}).get("displayName"),
                                         "p": [(p.get("athlete") or {}).get("displayName") for p in ps],
                                         "win": 0 if ps[0].get("winner") else 1, "sets": [[a, b] for a, b in zip(*ls)]}
            time.sleep(0.15)
        print(d, len(seen))
        d += timedelta(days=step)
    json.dump(sorted(seen.values(), key=lambda m: (m["date"], m["id"])), open(SETS, "w"), separators=(",", ":"))


def need_of(m):
    return 3 if m["tour"] == "ATP" and any(s in (m["event"] or "").lower() for s in LM_SLAMS) else 2


LM_SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")


def valid(m):
    """A completed match whose set scores are a legal finish (no retirement)."""
    need, w = need_of(m), [0, 0]
    for a, b in m["sets"]:
        if not LM.set_done(a, b):
            return False
        w[0 if a > b else 1] += 1
    return max(w) == need and w[m["win"]] == need


def pre_elo(matches):
    """Elo walk-forward over every match ESPN reports (bt/tennis_results_full.json + the set file):
    each target match gets the chance its player 0 wins from ratings built only on earlier days."""
    import tennis_model as TM
    from sports_common import nk
    hist = json.load(open("bt/tennis_results_full.json"))
    try:
        hist += json.load(open("data/tennis/results.json"))["matches"]
    except Exception:
        pass
    by = {}
    for h in hist:
        by.setdefault(h["date"], []).append(h)
    tgt = {}
    for m in matches:
        tgt.setdefault(m["date"], []).append(m)
    E, out, ids = TM.Elo(TM.P), {}, set()
    for d in sorted(set(by) | set(tgt)):
        for m in tgt.get(d, []):
            a, b = nk(m["p"][0]), nk(m["p"][1])
            if E.known(a) and E.known(b):
                out[m["id"]] = E.p(a, b)
        for h in by.get(d, []):
            if h["id"] in ids:
                continue
            ids.add(h["id"])
            E.update(nk(h["w"]), nk(h["l"]), h.get("event"))
    return out


def pre_onyx(matches):
    """Onyx's closing no-vig moneyline, where it priced the match (same day, same two players)."""
    from sports_common import nk
    idx = {}
    for f in ("bt/tennis_atp_lines.json", "bt/tennis_wta_lines.json"):
        try:
            G = json.load(open(f))
        except Exception:
            continue
        for v in G.values():
            ml = (v.get("game") or {}).get("moneyline") or {}
            if len(ml) != 2:
                continue
            for dd in (0, -1, 1):
                day = (date.fromisoformat(v["start"][:10]) + timedelta(days=dd)).isoformat()
                idx[(day, frozenset((nk(v["home"]), nk(v["away"]))))] = {nk(k): (x.get("c") or x.get("o") or [None, None])[1] for k, x in ml.items()}
    out = {}
    for m in matches:
        a, b = nk(m["p"][0]), nk(m["p"][1])
        x = idx.get((m["date"], frozenset((a, b))))
        if x and x.get(a) is not None and x.get(b) is not None:
            out[m["id"]] = LM.no_vig(x[a], x[b])
    return out


def match_ll(m, p, base, sg):
    """log P(the set scores seen | pre-match p, base, sg): first server a coin flip, then the
    server of every set from the games before it; the two form scenarios averaged."""
    need = need_of(m)
    sc = LM.tn_fit(p, need, base, sg)
    tot = 0.0
    for pt in sc:
        for s_first in (0, 1):
            L, off = 0.5 * 0.5, 0
            for a, b in m["sets"]:
                s0 = s_first if off % 2 == 0 else 1 - s_first
                L *= LM.tn_set_lik(a, b, True, s0, pt)
                off += a + b
            tot += L
    return math.log(max(tot, 1e-300))


def fit(train, pre):
    """Grid search per tour: the serve baseline and the form gap."""
    best = {}
    for tour in ("ATP", "WTA"):
        ms = [m for m in train if m["tour"] == tour and m["id"] in pre][:800]
        res = []
        for base in ((0.60, 0.62, 0.64, 0.66, 0.68) if tour == "ATP" else (0.52, 0.54, 0.56, 0.58, 0.60)):
            for sg in (0.0, 0.02, 0.034, 0.05, 0.07):
                ll = sum(match_ll(m, pre[m["id"]], base, sg) for m in ms) / len(ms)
                res.append((ll, base, sg))
                print(f"  {tour} base {base:.2f} form {sg:.3f}: set-score log lik {ll:.4f} ({len(ms)} matches)")
        res.sort(reverse=True)
        best[tour] = {"base": res[0][1], "form": res[0][2], "ll": round(res[0][0], 4), "n": len(ms),
                      "default_ll": round(next(r[0] for r in res if r[1] == (0.64 if tour == "ATP" else 0.56) and r[2] == 0.034), 4)}
    return best


def sets_only(p, need, sa, sb):
    """The old live.js tennis model: one set-win chance fitted to the pre-match price."""
    def mt(ps, a, b):
        if a >= need:
            return 1.0
        if b >= need:
            return 0.0
        return ps * mt(ps, a + 1, b) + (1 - ps) * mt(ps, a, b + 1)
    lo, hi = 0.01, 0.99
    for _ in range(40):
        ps = (lo + hi) / 2
        if mt(ps, 0, 0) < p:
            lo = ps
        else:
            hi = ps
    return mt((lo + hi) / 2, sa, sb)


def mid_states(a, b, rng):
    """A random game order ending at the set score (a, b), the set never over before its last game:
    the in-set states it passes through (excluding 0-0 and the end)."""
    for _ in range(50):
        seq = [0] * a + [1] * b
        if a + b == 13:                       # tiebreak set: the tiebreak is the last game, 6-6 before it
            seq = [0] * 6 + [1] * 6
            rng.shuffle(seq)
            seq.append(0 if a > b else 1)
        else:
            rng.shuffle(seq)
        x = y = 0
        out, ok = [], True
        for k, g in enumerate(seq):
            if k and k < len(seq):
                if LM.set_done(x, y):
                    ok = False
                    break
                out.append((x, y))
            x, y = x + (g == 0), y + (g == 1)
        if ok and (x, y) == (a, b):
            return out
    return []


def score(rows):
    n = len(rows)
    if not n:
        return None
    br = sum((p - y) ** 2 for p, y in rows) / n
    ll = -sum(math.log(min(max(p if y else 1 - p, 1e-6), 1)) for p, y in rows) / n
    return {"n": n, "brier": round(br, 4), "logloss": round(ll, 4)}


def buckets(rows):
    out = []
    for lo in range(0, 100, 10):
        b = [(p, y) for p, y in rows if lo / 100 <= p < (lo + 10) / 100 or (lo == 90 and p == 1)]
        if b:
            out.append({"band": f"{lo}-{lo + 10}%", "n": len(b), "said": round(100 * sum(p for p, _ in b) / len(b), 1),
                        "won": round(100 * sum(y for _, y in b) / len(b), 1)})
    return out


def main():
    if "--pull" in sys.argv:
        pull()
        return
    ms = [m for m in json.load(open(SETS)) if valid(m)]
    print(len(ms), "complete matches with set scores")
    elo, onyx = pre_elo(ms), pre_onyx(ms)
    print(len(elo), "with an Elo pre-match chance;", len(onyx), "with an Onyx closing price")
    train = [m for m in ms if m["date"] < SPLIT]
    test = [m for m in ms if m["date"] >= SPLIT]
    F = fit(train, elo)
    print("fit:", F)
    LM.TN_P.update({"base_atp": F["ATP"]["base"], "form_atp": F["ATP"]["form"],
                    "base_wta": F["WTA"]["base"], "form_wta": F["WTA"]["form"]})
    rng = random.Random(11)
    R = {}   # state -> {model, pre, sets_only} -> [(p, y)]

    def put(key, which, p, y):
        R.setdefault(key, {}).setdefault(which, []).append((p, y))
    limit = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--n=")), "6000"))
    T = [m for m in test if m["id"] in elo]
    rng.shuffle(T)
    T = T[:limit]
    t0 = time.time()
    for i, m in enumerate(T):
        need, y = need_of(m), 1 if m["win"] == 0 else 0
        for src, P in (("elo", elo), ("onyx", onyx)):
            p0 = P.get(m["id"])
            if p0 is None:
                continue
            base, sg = LM.tn_base(m["tour"])
            sc = LM.tn_fit(p0, need, base, sg)
            done = []
            for j, (a, b) in enumerate(m["sets"]):
                # set boundary before set j+1 (exact), j sets finished
                if j:
                    st = LM.tn_state(done)
                    T_ = LM.Tennis(p0, need, st, m["tour"], sc)
                    lab = f"after set {j}: sets {st['sa']}-{st['sb']}" if need == 2 else f"after set {j} (best of 5)"
                    for key in (lab, "every set boundary"):
                        put((src, key), "live", T_.win(), y)
                        put((src, key), "pre", p0, y)
                        put((src, key), "sets_only", sets_only(p0, need, st["sa"], st["sb"]), y)
                # in-set states (reconstructed order, server unknown): two per set
                mids = mid_states(a, b, rng)
                for (x, z) in rng.sample(mids, min(2, len(mids))):
                    st = LM.tn_state(done + [(x, z)])
                    T_ = LM.Tennis(p0, need, st, m["tour"], sc)
                    lead = "level" if x == z else ("player ahead in games" if True else "")
                    for key in (f"in set {j + 1} (reconstructed)", "every in-set state (reconstructed)"):
                        put((src, key), "live", T_.win(), y)
                        put((src, key), "pre", p0, y)
                        put((src, key), "sets_only", sets_only(p0, need, st["sa"], st["sb"]), y)
                done.append((a, b))
            put((src, "pre-match (0-0)"), "live", LM.Tennis(p0, need, LM.tn_state([]), m["tour"], sc).win(), y)
            put((src, "pre-match (0-0)"), "pre", p0, y)
        if i % 500 == 0:
            print(f"  {i}/{len(T)} {time.time() - t0:.0f}s")
    out = {"run": date.today().isoformat(), "matches_with_sets": len(ms), "train": len([m for m in train if m["id"] in elo]),
           "test": len(T), "split": SPLIT, "fit": F, "states": {}}
    for (src, key), d in sorted(R.items()):
        out["states"].setdefault(src, {})[key] = {k: score(v) for k, v in d.items()}
        if key in ("every set boundary", "every in-set state (reconstructed)"):
            out["states"][src][key]["calibration"] = buckets(d["live"])
    json.dump(out, open("data/tennis/live_backtest.json", "w"), indent=1)
    for src in out["states"]:
        print("\n== pre-match from", src)
        for key, d in out["states"][src].items():
            L, P, S = d.get("live"), d.get("pre"), d.get("sets_only")
            print(f"  {key:42s} n={L['n']:5d}  live Brier {L['brier']:.4f} LL {L['logloss']:.4f} | pre-only {P['brier']:.4f} {P['logloss']:.4f}"
                  + (f" | sets-only {S['brier']:.4f} {S['logloss']:.4f}" if S else ""))


if __name__ == "__main__":
    main()
