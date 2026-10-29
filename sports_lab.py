"""
sports_lab.py - the shared model frame for every sport beyond MLB and NBA.

Each sport has a model module, <sport>_model.py, with:
  VERSION                 bumped on every model change, with a changelog
                          entry in the module docstring citing its evidence
  ingest(lane, slate)     optional: fold new results / box scores into the
                          sport's history under data/<sport>/ (called by
                          sports_espn.py after the slate is saved)
  block(lane, slate, odds) the page's model card (model_block below)

The frame supplies what every sport shares:
  probabilities           normal, Poisson, negative binomial, no-vig fair
                          prices, the model / market blend, EV
  the backtest gate       data/<sport>/backtest.json, written by the sport's
                          backtest tool against historical Onyx lines. Picks
                          are LIVE only when it says passed for THIS version.
  the ledger              data/<sport>/picks_history.json: append-only, odds
                          recorded when a play qualifies, graded off final
                          results, summarized as a $10-a-pick record.
                          validate_build.py guards it never-shrink like the
                          MLB and NBA ledgers.
"""

import math
from datetime import datetime, timezone

STAKE = 10.0


# ── probabilities ─────────────────────────────────────────────────────
def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def normal_over(mean, sd, line):
    """P(X > line) for a continuous stat (yards)."""
    sd = max(sd, 1e-6)
    return 1 - ncdf((line - mean) / sd)


def poisson_cdf(k, mean):
    if k < 0:
        return 0.0
    mean = max(mean, 1e-9)
    term = math.exp(-mean)
    tot = term
    for i in range(1, int(k) + 1):
        term *= mean / i
        tot += term
    return min(1.0, tot)


def nb_cdf(k, mean, var):
    """P(X <= k), negative binomial with this mean and variance (Poisson when
    the variance does not exceed the mean)."""
    if k < 0:
        return 0.0
    mean = max(mean, 0.05)
    if var <= mean * 1.0001:
        return poisson_cdf(k, mean)
    r = mean * mean / (var - mean)
    p = r / (r + mean)
    term = p ** r
    tot = term
    for i in range(1, int(k) + 1):
        term *= (r + i - 1) / i * (1 - p)
        tot += term
    return min(1.0, tot)


def count_over(mean, line, var=None):
    """P(X > line) for a count stat (receptions, points, goals)."""
    return 1 - nb_cdf(math.floor(line), mean, var if var is not None else mean)


def implied(price):
    if price is None:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)


def decimal(price):
    return 1 + price / 100 if price > 0 else 1 + 100 / -price


def fair_pair(over, under):
    """No-vig chance of each side of a two-sided price."""
    a, b = implied(over), implied(under)
    if a is None or b is None or a + b <= 0:
        return None, None
    return a / (a + b), b / (a + b)


def blend(p_model, p_fair, w):
    return w * p_model + (1 - w) * p_fair


def ev(p, price):
    return p * decimal(price) - 1


def price_side(p_over_model, over, under, w):
    """The model / market blend on a two-sided Onyx line: the better side,
    its blended chance, the listed implied, edge and EV. None without both
    sides (an over-only line has no clean fair price)."""
    fo, fu = fair_pair(over, under)
    if fo is None:
        return None
    po = blend(p_over_model, fo, w)
    sides = {"over": (po, over), "under": (1 - po, under)}
    best = max(sides, key=lambda s: ev(sides[s][0], sides[s][1]))
    p, price = sides[best]
    return {"side": best, "prob": round(p, 4), "price": price, "implied": round(implied(price), 4),
            "edge": round(p - implied(price), 4), "ev": round(ev(p, price), 4), "model_p": round(p_over_model if best == "over" else 1 - p_over_model, 4)}


# ── the backtest gate ─────────────────────────────────────────────────
def gate(lane, version):
    """The sport's backtest result and whether picks are live: the result
    must be for this model version and marked passed."""
    bt = lane.load("backtest.json", None)
    live = bool(bt and bt.get("version") == version and bt.get("passed"))
    return bt, live


# ── the ledger ────────────────────────────────────────────────────────
class Ledger:
    """data/<sport>/picks_history.json. Rows are never removed or rewritten
    except to set a result; a pick's price is the one it qualified at."""

    def __init__(self, lane):
        self.lane = lane
        self.rows = lane.load("picks_history.json", []) or []

    def key(self, r):
        # one pick per game, market and side, whatever day it was built on: weekly slates
        # (college football, NFL) rebuild daily, and a date in the key re-logged the same
        # bet each day (10/26-10/28: GT @ PITT, PITT +7.5 three times)
        if r.get("gid"):
            return (r.get("gid"), r.get("name"), r["mkt"], r["side"])
        return (r["date"], r.get("gid"), r.get("name"), r["mkt"], r["side"])

    def add(self, row):
        have = {self.key(r) for r in self.rows}
        if self.key(row) in have:
            return False
        row = dict(row, logged_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), result=None, actual=None)
        self.rows.append(row)
        return True

    def grade(self, resolve):
        """resolve(row) -> actual stat value (float) or None while not final,
        or 'void' (did not play / no result)."""
        n = 0
        for r in self.rows:
            if r.get("result"):
                continue
            act = resolve(r)
            if act is None:
                continue
            if act == "void":
                r["result"] = "V"
            else:
                r["actual"] = act
                if act == r["line"]:
                    r["result"] = "P"
                else:
                    r["result"] = "W" if (act > r["line"]) == (r["side"] == "over") else "L"
            n += 1
        return n

    def save(self):
        self.lane.save("picks_history.json", self.rows, indent=1)

    def record(self):
        w = sum(1 for r in self.rows if r.get("result") == "W")
        l = sum(1 for r in self.rows if r.get("result") == "L")
        p = sum(1 for r in self.rows if r.get("result") in ("P", "V"))
        units = sum((decimal(r["price"]) - 1) if r.get("result") == "W" else -1.0 if r.get("result") == "L" else 0.0
                    for r in self.rows)
        graded = w + l
        by = {}
        for r in self.rows:
            if r.get("result") in ("W", "L"):
                b = by.setdefault(r["mkt"], {"w": 0, "l": 0, "units": 0.0})
                b["w" if r["result"] == "W" else "l"] += 1
                b["units"] += (decimal(r["price"]) - 1) if r["result"] == "W" else -1.0
        return {"w": w, "l": l, "p": p, "pending": sum(1 for r in self.rows if not r.get("result")),
                "units": round(units, 2), "dollars": round(units * STAKE, 2), "roi": round(units / graded, 4) if graded else None,
                "by_mkt": by, "rows": list(reversed(self.rows[-60:]))}


def model_block(**kw):
    """The page's model card. Keys the template reads: status ('lab' or
    'live'), version, title, note, method [paragraphs], tests [{k, v, d}],
    backtest {...} or None, changelog [str], roadmap [str], rows (leans),
    picks (today's tracked picks), record, top."""
    base = {"status": "lab", "version": None, "title": "", "note": "", "method": [], "tests": [], "backtest": None,
            "changelog": [], "roadmap": [], "rows": [], "picks": [], "record": None, "top": []}
    base.update(kw)
    return base


def changelog(module_doc, n=6):
    """The newest changelog entries from a model module's docstring: lines
    that start with a version tag like '  v1  10/27  ...' plus their
    continuation lines."""
    out, cur = [], None
    for line in (module_doc or "").splitlines():
        s = line.strip()
        if s[:1] == "v" and len(s) > 2 and s[1].isdigit() and "  " in s:
            if cur:
                out.append(cur)
            cur = " ".join(s.split())
        elif cur and s and line.startswith("    "):
            cur += " " + s
        elif cur and not s:
            out.append(cur)
            cur = None
    if cur:
        out.append(cur)
    return out[:n]
