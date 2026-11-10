"""
lines_status.py - where lines are, and where they go missing, and why (11/6, Jordan: "we have to stop
losing lines and if they disappear we need to address why").

    python3 lines_status.py            # every sport: pregame sources and live coverage -> data/lines/status.json
    python3 lines_status.py --live tennis   # the minute watcher: live gaps only -> data/lines/live_gaps.json

Pregame, per sport: how many games and player lines came from Onyx (odds.json / NBA props.json) and how
many from the market fallback (market.json), and every game still to play with no line from either.

Live, per game or match in progress on ESPN: whether the relay's live line (GET <ai.json>/live) has it,
and when not, why:
  feed error          the relay did not answer or answered with an error
  not on the feed     the odds feed lists no live fixture for it (a league or event it does not cover)
  no book pricing it  the feed lists the fixture but no sportsbook prices it right now (a suspension,
                      a weather delay, a medical timeout)
  names differ        the feed has it under other names (the page cannot match it)

status.json is rewritten by the refresh build (current state + the last 400 runs); live_gaps.json is
append-only and written only by the tennis watcher (one row when a gap opens, one when it closes), so the
two never race in a rebase. Fail-soft: any error prints a warning and exits 0.
"""

import json, sys, unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests

import live_log as LL

STATUS = Path("data/lines/status.json")
GAPS = Path("data/lines/live_gaps.json")
PRE_SPORTS = ("nfl", "cfb", "nba", "cbb", "nhl", "tennis")
NAME = {"nfl": "NFL", "cfb": "College football", "nba": "NBA", "cbb": "College basketball", "nhl": "NHL", "tennis": "Tennis"}


def load(p, d):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return d


def save(p, obj, indent=None):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=indent, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def last(n):
    n = unicodedata.normalize("NFKD", str(n or "")).encode("ascii", "ignore").decode().lower().replace("-", " ")
    return (n.split() or [""])[-1]


# ── pregame ─────────────────────────────────────────────────────────────────────────
def pregame(sport):
    slate = load(f"data/{sport}/slate.json", {}) or {}
    if sport == "nba":
        props = load("data/nba/props.json", {}) or {}
        pre = [g for g in slate.get("games") or [] if g.get("state", "pre") == "pre"]
        if not pre:
            esp = load("data/nba/espn/slate.json", {}) or {}
            pre = [g for g in esp.get("games") or [] if g.get("state", "pre") == "pre"]
        gl = props.get("games") or {}
        src = {"onyx": 0, "market": 0}
        for v in (props.get("players") or {}).values():
            for m in v.values():
                if isinstance(m, dict) and m.get("src") in src:
                    src[m["src"]] += 1
        missing = [f"{g.get('away')} @ {g.get('home')}" for g in pre if f"{g.get('away')}_{g.get('home')}" not in gl]
        return {"games": len(pre), "onyx_lines": src["onyx"], "market_lines": src["market"],
                "source": "onyx" if src["onyx"] else "market" if src["market"] else "none",
                "missing": missing, "fetched": props.get("fetched")}
    odds = load(f"data/{sport}/odds.json", {}) or {}
    mkt = load(f"data/{sport}/market.json", {}) or {}
    use_mkt = bool(mkt.get("fallback"))
    if sport == "tennis":
        pre = [m for e in slate.get("events") or [] for m in e.get("matches") or [] if m.get("state") == "pre"]
        have = set(odds.get("matches") or {}) | (set(mkt.get("matches") or {}) if use_mkt else set())
        tbd = lambda m: any((p.get("name") or "TBD").upper() == "TBD" for p in m.get("p") or []) or len(m.get("p") or []) < 2
        n_tbd = sum(1 for m in pre if tbd(m) and m.get("id") not in have)   # draw slots with a player still to be decided
        missing = [" vs ".join(p.get("name", "?") for p in m.get("p") or []) for m in pre if m.get("id") not in have and not tbd(m)]
        n_onyx, n_mkt = len(odds.get("matches") or {}), len(mkt.get("matches") or {}) if use_mkt else 0
    else:
        pre = [g for g in slate.get("games") or [] if g.get("state") == "pre"]
        have = set(odds.get("games") or {}) | (set(mkt.get("games") or {}) if use_mkt else set())
        missing = [f"{g.get('away')} @ {g.get('home')}" for g in pre if g.get("gid") not in have]
        n_onyx = len(odds.get("games") or {}) + len(odds.get("props") or [])
        n_mkt = (len(mkt.get("games") or {}) + len(mkt.get("props") or [])) if use_mkt else 0
    out = {"games": len(pre), "onyx_lines": n_onyx, "market_lines": n_mkt,
           "source": "onyx" if n_onyx else "market" if n_mkt else "none",
           "missing": missing[:40], "n_missing": len(missing), "fetched": odds.get("fetched")}
    if sport == "tennis":
        out["awaiting_players"] = n_tbd
    return out


# ── live ────────────────────────────────────────────────────────────────────────────
def relay(url, sport):
    if not url:
        return None, "no relay address (ai.json)"
    try:
        r = requests.get(f"{url}/live?sport={sport}", headers={"origin": "https://onyxjordan.github.io", **LL.UA}, timeout=30)
        j = r.json()
        if r.status_code != 200 or j.get("error"):
            return None, f"feed error ({r.status_code} {j.get('error') or ''})".strip()
        return j, None
    except Exception as ex:
        return None, f"feed error ({str(ex)[:80]})"


def live(sport, url):
    G = LL.live_games(sport)
    if not G:
        return {"in_play": 0, "with_line": 0, "gaps": []}
    j, err = relay(url, sport)
    gaps, ok = [], 0
    for g in G:
        name = f"{g['away']} {'vs' if sport == 'tennis' else '@'} {g['home']}"
        if err:
            gaps.append({"match": name, "reason": "feed error", "detail": err})
            continue
        if LL.match(j.get("games") or [], g):
            ok += 1
            continue
        fx = j.get("fixtures") or []
        if LL.match(fx, g):
            f = LL.match(fx, g)
            gaps.append({"match": name, "reason": "no book pricing it", "detail": f"on the feed ({f.get('league')}, {f.get('status')}) with no sportsbook price right now"})
            continue
        ln = {last(g["hn"]), last(g["an"])}
        near = [x for x in (j.get("games") or []) + fx if {last(x.get("home")), last(x.get("away"))} & ln]
        if near:
            x = near[0]
            gaps.append({"match": name, "reason": "names differ", "detail": f"the feed has {x.get('away')} vs {x.get('home')}"})
        else:
            gaps.append({"match": name, "reason": "not on the feed", "detail": g.get("detail") or ""})
    return {"in_play": len(G), "with_line": ok, "gaps": gaps}


def main():
    url = LL.relay_url()
    if "--live" in sys.argv:
        sport = sys.argv[sys.argv.index("--live") + 1] if len(sys.argv) > sys.argv.index("--live") + 1 else "tennis"
        L = live(sport, url)
        rows = load(GAPS, [])
        if not isinstance(rows, list):
            print("::warning::live_gaps.json does not parse; not touching it")
            return
        # a match's state is its LATEST row (11/10: this kept every match that ever opened as open, so each
        # minute wrote another "closed" row for all of them; 29,522 rows on 11/10 alone, 15 MB). Repeats are
        # squashed once here: a row that only restates the match's previous state is dropped.
        last, keep = {}, []
        for r in rows:
            k = (r.get("sport"), r.get("match"))
            p = last.get(k)
            if p is not None and p.get("state") == r.get("state") and (r.get("state") == "closed" or p.get("reason") == r.get("reason")):
                continue
            last[k] = r
            keep.append(r)
        squashed = len(rows) - len(keep)
        rows = keep
        open_ = {m: r for (sp, m), r in last.items() if sp == sport and r.get("state") == "open"}
        cur = {x["match"]: x for x in L["gaps"]}
        t, added = now_iso(), 0
        for m, x in cur.items():
            if m not in open_ or open_[m].get("reason") != x["reason"]:
                rows.append({"at": t, "sport": sport, "match": m, "state": "open", "reason": x["reason"], "detail": x.get("detail")})
                added += 1
        for m, r in open_.items():
            if m not in cur:
                rows.append({"at": t, "sport": sport, "match": m, "state": "closed", "reason": r.get("reason"),
                             "detail": "line back, or the match ended"})
                added += 1
        if added or squashed:
            save(GAPS, rows, indent=1)
        print(f"lines {sport} live: {L['with_line']} of {L['in_play']} in play with a line"
              + "".join(f"\n  no line: {x['match']} ({x['reason']}: {x.get('detail') or ''})" for x in L["gaps"]))
        return
    st = load(STATUS, {}) or {}
    cur = {"at": now_iso(), "sports": {}}
    for s in PRE_SPORTS:
        try:
            p = pregame(s)
        except Exception as ex:
            p = {"error": str(ex)[:120]}
        try:
            lv = live(s, url)
        except Exception as ex:
            lv = {"error": str(ex)[:120]}
        cur["sports"][s] = {"name": NAME[s], "pregame": p, "live": lv}
        print(f"lines {s}: source {p.get('source')}, onyx {p.get('onyx_lines')}, market {p.get('market_lines')}, "
              f"{p.get('n_missing', len(p.get('missing') or []))} of {p.get('games')} games to play with no line; "
              f"live {lv.get('with_line')} of {lv.get('in_play')} with a line")
    hist = (st.get("history") or [])[-399:] + [{"at": cur["at"], "s": {k: {
        "src": v["pregame"].get("source"), "on": v["pregame"].get("onyx_lines"), "mk": v["pregame"].get("market_lines"),
        "pre": v["pregame"].get("games"), "miss": v["pregame"].get("n_missing", len(v["pregame"].get("missing") or [])),
        "lv": v["live"].get("in_play"), "lvok": v["live"].get("with_line")} for k, v in cur["sports"].items()}}]
    cur["history"] = hist
    save(STATUS, cur)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"::warning::lines_status failed: {str(e)[:200]}")
