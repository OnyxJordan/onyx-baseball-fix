"""tennis_paper.py - the tennis paper test (11/15, Jordan: "build the tennis paper test").

The tennis audit found nothing in tennis statistics that beats Onyx's price, but Onyx's moneyline against a sharp
book's (Pinnacle, on the same odds feed) did: on about 17,000 matches of 2025 and 2026, betting Onyx where its price
pays 2%+ more than the sharp book's no-vig chance made +9.3% (2025, 1,544 bets) and +9.2% (2026, 2,091 bets) at the
two books' opening prices, and +9.5% / +7.6% where 4%+ better at their closing prices (screening out in-play closes).
What the history cannot show is timing: it holds each book's opening and closing price, not when each was posted.

So this logs the rule live, with both prices taken in the same odds run: every match still to start where Onyx's
moneyline pays 2%+ more than the sharp no-vig chance (priced -250 to +300), once per match and side, at the moment it
first qualifies. It is a paper test, never shown as picks, never an Onyx Pick: data/tennis/paper.json is append-only
and graded off ESPN results (data/tennis/results.json). The site never names the other book (CLAUDE.md rule 3).

    python3 tennis_paper.py        the paper record
"""
import json
from datetime import datetime, timezone
from pathlib import Path

PAPER = Path(__file__).resolve().parent / "data" / "tennis" / "paper.json"
RESULTS = Path(__file__).resolve().parent / "data" / "tennis" / "results.json"
SHARP_BOOK = "pinnacle"
MIN_EV, PRICE = 0.02, (-250, 300)


def _imp(p):
    return 100 / (p + 100) if p > 0 else -p / (-p + 100)


def _pay(p):
    return p / 100 if p > 0 else 100 / -p


def load():
    try:
        rows = json.loads(PAPER.read_text(encoding="utf-8"))
        return rows if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


def _when(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def candidates(onyx, sharp, now=None):
    """Plays that qualify now: {match id: ...} from sports_odds matches (Onyx and the sharp book, same run)."""
    now = now or datetime.now(timezone.utc)
    out = []
    for mid, o in (onyx or {}).items():
        s = (sharp or {}).get(mid)
        st = _when(o.get("start"))
        if not s or not st or st <= now:
            continue
        if None in (o.get("ml0"), o.get("ml1"), s.get("ml0"), s.get("ml1")):
            continue
        f0, f1 = _imp(s["ml0"]), _imp(s["ml1"])
        fair = (f0 / (f0 + f1), f1 / (f0 + f1))
        for i in (0, 1):
            price = o[f"ml{i}"]
            ev = fair[i] * (1 + _pay(price)) - 1
            if ev >= MIN_EV and PRICE[0] <= price <= PRICE[1]:
                out.append({"id": f"{mid}-{i}", "match": str(mid), "start": o.get("start"), "players": o.get("p"),
                            "pick": (o.get("p") or [None, None])[i], "side": i, "price": price, "sharp": s[f"ml{i}"],
                            "sharp_other": s[f"ml{1 - i}"], "fair": round(fair[i], 4), "ev": round(ev, 4)})
    return out


def grade(rows):
    try:
        res = {str(m["id"]): m for m in json.loads(RESULTS.read_text(encoding="utf-8")).get("matches") or []}
    except (OSError, ValueError):
        return 0
    n = 0
    for r in rows:
        if r.get("result"):
            continue
        m = res.get(r["match"])
        if not m:
            continue
        won = m.get("w") == r.get("pick")
        if not won and m.get("l") != r.get("pick"):
            continue            # names do not line up: leave it for a look, never guess
        r["result"] = "W" if won else "L"
        r["profit"] = round(_pay(r["price"]), 4) if won else -1.0
        r["graded_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        n += 1
    return n


def log(onyx, sharp, now=None):
    """sports_odds.py tennis: log what qualifies now, grade what finished. Fail-soft; returns (added, graded)."""
    now = now or datetime.now(timezone.utc)
    rows = load()
    have = {r["id"] for r in rows}
    added = 0
    for c in candidates(onyx, sharp, now):
        if c["id"] in have:
            continue
        rows.append(dict(c, logged_at=now.isoformat(timespec="seconds"), result=None, profit=None))
        have.add(c["id"])
        added += 1
    graded = grade(rows)
    if added or graded:
        PAPER.parent.mkdir(parents=True, exist_ok=True)
        PAPER.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return added, graded


def record(rows=None):
    rows = load() if rows is None else rows
    g = [r for r in rows if r.get("result")]
    w = sum(1 for r in g if r["result"] == "W")
    u = sum(r["profit"] for r in g)
    return {"logged": len(rows), "graded": len(g), "w": w, "l": len(g) - w, "units": round(u, 2),
            "roi": round(u / len(g), 4) if g else None, "pending": len(rows) - len(g)}


if __name__ == "__main__":
    print(json.dumps(record(), indent=1))
