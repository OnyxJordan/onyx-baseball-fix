#!/usr/bin/env python3
"""Dev-only: pull the closing-line game history the Similar spots engine
(situations.py) matches against.

  python3 tools/situations_pull.py nfl|cfb|nba|nhl|cbb [--first 2019] [--last 2026]
                                   [--cache DIR] [--write]

For every final game of each season: ESPN's scoreboard (by day) for the teams,
score, neutral site and the conference-game flag, and ESPN's core odds
(.../events/{id}/competitions/{id}/odds) for the CLOSING spread and total and
the opening spread and total. These are ESPN's line providers (ESPN BET,
DraftKings, Caesars, William Hill, consensus... depending on the season), so
on the site they are called "closing line", never Onyx and never branded.

Season labels: football = the year the season starts (2025 = 2025 season);
basketball and hockey = the year it ends (2026 = 2025-26), like Torvik.

College basketball reuses tools/cbb_history.py's pull (its scoreboard + odds
code and cache layout); data/cbb/history/games_{S}.json is used as-is where
it exists.

--write merges the pulled rows into data/<sport>/situations_hist.json
(columnar, see situations.HCOLS). Without --write it only reports coverage.
Raw downloads are cached in --cache, so reruns only fetch what is new.
"""
import argparse, json, os, sys, tempfile, time
import urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
WORKERS = 8
PATHS = {
    "nfl": ("football", "nfl", ""),
    "cfb": ("football", "college-football", "groups=80&limit=300"),
    "nba": ("basketball", "nba", ""),
    "nhl": ("hockey", "nhl", ""),
}


def season_days(sport, s):
    if sport == "nfl":
        d, end = date(s, 9, 1), date(s + 1, 2, 15)
    elif sport == "cfb":
        d, end = date(s, 8, 20), date(s + 1, 1, 25)
    elif sport == "nba":
        d, end = date(s - 1, 10, 1), date(s, 6, 25)
    elif sport == "nhl":
        d, end = date(s - 1, 10, 1), date(s, 6, 30)
    else:   # cbb
        d, end = date(s - 1, 11, 1), date(s, 4, 10)
    end = min(end, date.today() - timedelta(days=1))
    while d <= end:
        yield d
        d += timedelta(days=1)


def get(url, cache_file=None, tries=6, allow_404=False):
    if cache_file and cache_file.exists():
        b = cache_file.read_bytes()
        return None if b == b"__404__" else b
    b = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404 and allow_404:
                b = None
                break
            if e.code in (429, 500, 502, 503, 504) and i < tries - 1:
                time.sleep(2 ** i)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if i == tries - 1:
                raise
            time.sleep(2 ** i)
    if cache_file:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(b"__404__" if b is None else b)
    return b


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def scoreboard(sport, d, cache, today_ok=False):
    sp, lg, q = PATHS[sport]
    ds = d.strftime("%Y%m%d")
    cf = cache / sport / "sb" / f"{ds}.json"
    if cf.exists():
        return json.loads(cf.read_text())
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sp}/{lg}/scoreboard?dates={ds}" + (f"&{q}" if q else "")
    b = get(url)
    out = []
    for e in json.loads(b).get("events", []):
        c = e["competitions"][0]
        st = c["status"]["type"]
        side = {}
        for t in c["competitors"]:
            tm = t.get("team") or {}
            side[t.get("homeAway")] = {"id": tm.get("id"), "abbr": tm.get("abbreviation"), "score": num(t.get("score"))}
        if "home" not in side or "away" not in side:
            continue
        out.append({"id": e["id"], "d": ds, "final": st.get("name") == "STATUS_FINAL",
                    "neu": 1 if c.get("neutralSite") else 0, "cg": 1 if c.get("conferenceCompetition") else 0,
                    "st": ((e.get("season") or {}).get("type")), "h": side["home"], "a": side["away"]})
    if d < date.today() - timedelta(days=1):     # only cache days that are over
        cf.parent.mkdir(parents=True, exist_ok=True)
        cf.write_text(json.dumps(out))
    return out


def odds(sport, gid, cache):
    sp, lg, _ = PATHS[sport]
    url = f"https://sports.core.api.espn.com/v2/sports/{sp}/leagues/{lg}/events/{gid}/competitions/{gid}/odds"
    b = get(url, cache / sport / "odds" / f"{gid}.json", allow_404=True)
    if not b:
        return None
    import situations as S
    return S.parse_odds(json.loads(b).get("items", []))


def pull(sport, s, cache):
    days = list(season_days(sport, s))
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as ex:
        games = [g for day in ex.map(lambda d: scoreboard(sport, d, cache), days) for g in day]
    seen, fin = set(), []
    for g in games:
        if g["id"] not in seen and g["final"] and g.get("st") in (2, 3, None):   # no preseason / all-star
            seen.add(g["id"])
            fin.append(g)
    with ThreadPoolExecutor(WORKERS) as ex:
        od = list(ex.map(lambda g: odds(sport, g["id"], cache), fin))
    rows = []
    for g, o in zip(fin, od):
        o = o or {}
        rows.append({"d": g["d"], "id": g["id"], "s": s, "pt": 1 if g.get("st") == 3 else 0,
                     "h": g["h"]["abbr"], "hid": g["h"]["id"], "hs": g["h"]["score"],
                     "a": g["a"]["abbr"], "aid": g["a"]["id"], "as": g["a"]["score"],
                     "neu": g["neu"], "cg": g["cg"], "sp": o.get("sp"), "sp_open": o.get("sp_open"),
                     "tot": o.get("tot"), "tot_open": o.get("tot_open"), "hml": o.get("hml"),
                     "hpr": o.get("hpr"), "apr": o.get("apr"), "opr": o.get("opr"), "upr": o.get("upr")})
    n_sp = sum(1 for r in rows if r["sp"] is not None)
    print(f"  {sport} {s}: {len(days)} days, {len(fin)} finals, {n_sp} with a closing spread "
          f"({time.time() - t0:.0f}s)", flush=True)
    return rows


def cbb_rows(s, cache):
    """College basketball: data/cbb/history/games_{S}.json if committed, else cbb_history's pull."""
    p = ROOT / "data" / "cbb" / "history" / f"games_{s}.json"
    if p.exists():
        raw = json.loads(p.read_text())
    else:
        import cbb_history as H
        raw, _ = H.pull_games(s, cache)
    out = []
    for r in raw:
        out.append({"d": r["d"], "id": r["id"], "s": s, "pt": 1 if r["d"][4:6] in ("03", "04") and not r.get("cg") else 0,
                    "h": r["h"], "hid": r["hid"], "hs": r["hs"], "a": r["a"], "aid": r["aid"], "as": r["as"],
                    "neu": r.get("neu", 0), "cg": r.get("cg", 0), "sp": r.get("sp"), "sp_open": r.get("sp_open"),
                    "tot": r.get("tot"), "tot_open": None, "hml": None})
        cf = cache / "espn_odds" / f"{r['id']}.json"     # cbb_history's cache: closing prices and the open total
        if cf.exists() and cf.read_bytes() != b"__404__":
            import situations as S
            o = S.parse_odds(json.loads(cf.read_text()).get("items", []))
            if o:
                out[-1].update(o)
    print(f"  cbb {s}: {len(out)} finals, {sum(1 for r in out if r['sp'] is not None)} with a closing spread", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sport", choices=["nfl", "cfb", "nba", "nhl", "cbb"])
    ap.add_argument("--first", type=int, default=2019)
    ap.add_argument("--last", type=int, default=2026)
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "onyx_sit_cache"))
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    cache = Path(a.cache)
    rows = []
    for s in range(a.first, a.last + 1):
        rows += cbb_rows(s, cache) if a.sport == "cbb" else pull(a.sport, s, cache)
    if a.write:
        import situations as S
        S.merge_history(a.sport, rows)


if __name__ == "__main__":
    main()
