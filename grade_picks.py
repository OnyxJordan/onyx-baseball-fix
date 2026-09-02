#!/usr/bin/env python3
"""
Onyx Baseball - automatic pick grading.
For every pending pick (hit == null) with a date in the past, pulls that
day's final boxscores from the MLB Stats API and sets hit true/false:
  - player homered that day  -> hit: true
  - player appeared, no HR   -> hit: false
  - player never appeared    -> left pending (voided prop / scratch), reported
Runs before auto_build in the daily workflow so update_stats.py merges the
graded results into the site record the same morning.
"""

import json, re, unicodedata, urllib.request
from datetime import datetime, timedelta, timezone

PICKS = "data/picks_input.json"
TICKETS = "data/ticket_history.json"
KHIST = "data/k_history.json"
MLB = "https://statsapi.mlb.com/api/v1"

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.’'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def today_et():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).date()

def parse_date(d):
    """'2026-07-23' or '7/23' or '7/23/26' -> date, else None."""
    d = str(d).strip()
    try:
        if "-" in d:
            return datetime.strptime(d[:10], "%Y-%m-%d").date()
        parts = d.split("/")
        m, day = int(parts[0]), int(parts[1])
        yr = int(parts[2]) if len(parts) > 2 else today_et().year
        if yr < 100:
            yr += 2000
        return datetime(yr, m, day).date()
    except Exception:
        return None

def day_hr_map(date_str):
    """(hrs, appeared, starter_ks) for one date: batter HR counts, everyone
    who appeared, and each STARTING pitcher's strikeouts (first pitcher in
    the team's boxscore order) — one pull serves pick, ticket, K grading."""
    hrs, appeared, ks = {}, set(), {}
    sched = get(f"{MLB}/schedule?sportId=1&date={date_str}")
    pks = [g["gamePk"] for de in sched.get("dates", []) for g in de.get("games", [])
           if g.get("status", {}).get("abstractGameState") == "Final"]
    for pk in pks:
        try:
            box = get(f"{MLB}/game/{pk}/boxscore")
        except Exception:
            continue
        for side in ("home", "away"):
            t = box.get("teams", {}).get(side, {})
            for pdata in (t.get("players") or {}).values():
                name = nk((pdata.get("person") or {}).get("fullName") or "")
                if not name:
                    continue
                bat = (pdata.get("stats") or {}).get("batting") or {}
                pa = (bat.get("plateAppearances") or 0) + (bat.get("atBats") or 0)
                if pa > 0 or bat.get("gamesPlayed"):
                    appeared.add(name)
                    hrs[name] = hrs.get(name, 0) + (bat.get("homeRuns") or 0)
            order = t.get("pitchers") or []
            if order:
                p0 = (t.get("players") or {}).get("ID" + str(order[0])) or {}
                sname = nk((p0.get("person") or {}).get("fullName") or "")
                st = (p0.get("stats") or {}).get("pitching") or {}
                if sname:
                    ks[sname] = st.get("strikeOuts") or 0
    return hrs, appeared, ks

def _dec(american):
    try:
        a = int(american)
    except (TypeError, ValueError):
        return None
    return 1 + a / 100.0 if a > 0 else 1 + 100.0 / abs(a)

def grade_tickets(day_maps):
    """Settle the daily $10 parlay ledger. A leg whose player never appeared
    is VOIDED (removed from the payout math, book convention); the ticket
    wins only if every non-void leg homered. day_maps caches per-date
    (hrs, appeared) so ticket grading rides the same boxscore pulls."""
    try:
        tickets = json.load(open(TICKETS, encoding="utf-8"))
        assert isinstance(tickets, list)
    except Exception:
        return
    cutoff = today_et()
    changed = 0
    for t in tickets:
        if not isinstance(t, dict) or t.get("result") is not None:
            continue
        d = parse_date(t.get("date"))
        if d is None or d >= cutoff:
            continue
        iso = d.strftime("%Y-%m-%d")
        if iso not in day_maps:
            try:
                day_maps[iso] = day_hr_map(iso)
            except Exception as ex:
                print(f"  ticket {iso}: boxscore fetch failed ({ex}) - retry next run")
                continue
        hrs, appeared, _ks = day_maps[iso]
        live = []
        for l in (t.get("legs") or []):
            key = nk(l.get("player") or "")
            if key in hrs and hrs[key] >= 1:
                l["hit"] = True
            elif key in appeared:
                l["hit"] = False
            else:
                l["hit"] = "void"
            if l["hit"] != "void":
                live.append(l)
        stake = float(t.get("stake") or 10)
        if not live:
            t["result"], t["pnl"] = "void", 0.0
        elif all(l["hit"] is True for l in live):
            dec = 1.0
            for l in live:
                dec *= _dec(l.get("odds")) or 1.0
            t["result"], t["pnl"] = "win", round(stake * dec - stake, 2)
        else:
            t["result"], t["pnl"] = "loss", -stake
        changed += 1
        print(f"  ticket {iso}: {t['result'].upper()} "
              f"({sum(1 for l in live if l['hit'] is True)}/{len(live)} legs) pnl {t['pnl']:+.2f}")
    if changed:
        json.dump(tickets, open(TICKETS, "w", encoding="utf-8"),
                  indent=1, ensure_ascii=False)
    w = sum(1 for t in tickets if isinstance(t, dict) and t.get("result") == "win")
    l = sum(1 for t in tickets if isinstance(t, dict) and t.get("result") == "loss")
    pnl = sum(float(t.get("pnl") or 0) for t in tickets if isinstance(t, dict))
    print(f"tickets: {changed} settled this run, parlay record {w}-{l}, total P&L {pnl:+.2f}")

def grade_ks(day_maps):
    """Settle the K-projection ledger: the model's side of the listed line
    (over when projection > line) vs the starter's actual strikeouts. A
    scratched starter voids (actual 'dnp', win stays null, excluded from
    the record)."""
    try:
        kh = json.load(open(KHIST, encoding="utf-8"))
        assert isinstance(kh, list)
    except Exception:
        return
    cutoff = today_et()
    changed = 0
    for p in kh:
        if not isinstance(p, dict) or p.get("win") is not None or p.get("actual") is not None:
            continue
        d = parse_date(p.get("date"))
        if d is None or d >= cutoff:
            continue
        iso = d.strftime("%Y-%m-%d")
        if iso not in day_maps:
            try:
                day_maps[iso] = day_hr_map(iso)
            except Exception as ex:
                print(f"  k {iso}: boxscore fetch failed ({ex}) - retry next run")
                continue
        ks = day_maps[iso][2]
        a = ks.get(nk(p.get("pitcher") or ""))
        if a is None:
            p["actual"] = "dnp"    # scratched / never started: void
        else:
            p["actual"] = a
            if a != p.get("line"):
                p["win"] = (a > p["line"]) if p.get("side") == "over" else (a < p["line"])
        changed += 1
    if changed:
        json.dump(kh, open(KHIST, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    w = sum(1 for p in kh if isinstance(p, dict) and p.get("win") is True)
    l = sum(1 for p in kh if isinstance(p, dict) and p.get("win") is False)
    pct = f" ({w / (w + l) * 100:.1f}%)" if (w + l) else ""
    print(f"k plays: {changed} settled this run, K record {w}-{l}{pct}")

HRHIST = "data/hr_history.json"

def grade_hrs(day_maps):
    """Settle the HR edge ledger: every positive-edge bat, straight up —
    win only if he homered. Never-appeared bats void."""
    try:
        hh = json.load(open(HRHIST, encoding="utf-8"))
        assert isinstance(hh, list)
    except Exception:
        return
    cutoff = today_et()
    changed = 0
    for p in hh:
        if not isinstance(p, dict) or p.get("win") is not None or p.get("hr") is not None:
            continue
        d = parse_date(p.get("date"))
        if d is None or d >= cutoff:
            continue
        iso = d.strftime("%Y-%m-%d")
        if iso not in day_maps:
            try:
                day_maps[iso] = day_hr_map(iso)
            except Exception as ex:
                print(f"  hr {iso}: boxscore fetch failed ({ex}) - retry next run")
                continue
        hrs, appeared, _ = day_maps[iso]
        k = nk(p.get("player") or "")
        if k not in appeared:
            p["hr"] = "dnp"    # scratched: void
        else:
            p["hr"] = 1 if hrs.get(k, 0) >= 1 else 0
            p["win"] = bool(p["hr"])
        changed += 1
    if changed:
        json.dump(hh, open(HRHIST, "w", encoding="utf-8"), ensure_ascii=False)
    st = [p for p in hh if isinstance(p, dict) and p.get("win") is not None]
    sw = sum(1 for p in st if p["win"])
    pnl = sum((10.0 * (p.get("odds") or 0) / 100.0) if p["win"] else -10.0 for p in st)
    print(f"hr edges: {changed} settled this run, record {sw}-{len(st) - sw}, $10-flat P&L {pnl:+.2f}")

def main():
    day_maps = {}
    try:
        picks = json.load(open(PICKS, encoding="utf-8"))
    except Exception:
        picks = None
        print("no picks_input.json - no picks to grade")
    if picks is not None and not isinstance(picks, list):
        picks = None
        print("picks_input.json is not a list - skipping picks")

    if picks is not None:
        cutoff = today_et()
        pending_dates = sorted({str(p.get("date")) for p in picks
                                if isinstance(p, dict) and p.get("hit") is None
                                and (parse_date(p.get("date")) or cutoff) < cutoff})
        graded = voided = 0
        for dstr in pending_dates:
            d = parse_date(dstr)
            iso = d.strftime("%Y-%m-%d")
            if iso not in day_maps:
                try:
                    day_maps[iso] = day_hr_map(iso)
                except Exception as ex:
                    print(f"  {iso}: boxscore fetch failed ({ex}) - will retry next run")
                    continue
            hrs, appeared, _ks = day_maps[iso]
            for p in picks:
                if not isinstance(p, dict) or p.get("hit") is not None:
                    continue
                if str(p.get("date")) != dstr:
                    continue
                key = nk(p.get("player") or p.get("name") or "")
                if key in hrs and hrs[key] >= 1:
                    p["hit"] = True; graded += 1
                elif key in appeared:
                    p["hit"] = False; graded += 1
                elif (cutoff - d).days >= 2:
                    # two full days with no appearance = scratch. Mark it void
                    # (excluded from the record by the strict true/false
                    # checks) instead of leaving an eternal 'pending' row —
                    # B. Rice 8/30 sat pending for 3 days.
                    p["hit"] = "void"; graded += 1
                    print(f"  {iso}: {p.get('player') or p.get('name')} scratched - voided")
                else:
                    voided += 1
                    print(f"  {iso}: {p.get('player') or p.get('name')} never appeared - left pending")
        if graded:
            json.dump(picks, open(PICKS, "w", encoding="utf-8"),
                      indent=1, ensure_ascii=False)
        wins = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is True)
        losses = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is False)
        print(f"graded: {graded}, still pending: {voided}, record now {wins}-{losses}")

    grade_tickets(day_maps)
    grade_ks(day_maps)
    grade_hrs(day_maps)

if __name__ == "__main__":
    main()
