"""
my_alerts.py - pushes about each signed-in person's own saved picks, at the frequency they chose (11/7, Jordan:
"a push notification control center where you can get updates on all your picks and you can select how often").

Who gets what: signed-in people only (Jordan's call). The control center (alerts.js) links the phone's OneSignal
subscription to the account (OneSignal external_id = the Supabase user id) and saves the level on the person's
profile (profiles.push_level), a checklist since 11/8 saved as a comma list of these (or "off"); the single
levels below are still read:

    all      every update: game starts, lead changes (game lines and totals), halftime check, the result
    key      key moments: game starts and the result
    results  results only: cashed, missed or push
    recap    one morning push (--recap): yesterday's record and today's saved picks
    off      nothing

    python3 my_alerts.py --watch 20400   poll every 75 s for 5h40m (my_alerts.yml hands off to the next run)
    python3 my_alerts.py --once          one poll
    python3 my_alerts.py --recap         the morning recap

Picks are graded live off ESPN with the same rules as My picks (saved.js track()): a prop over that clears its line
is cashed at once, everything else waits for the final. Every event is written to push_sent before the next poll
(primary key user, pick, event), so a restart never repeats a push and the recap can count results. Needs
SUPABASE_URL (or accounts.json) and SUPABASE_SERVICE_KEY (server only, never in the site) and the OneSignal
secrets; without them it prints why and exits 0. Depends on requests only.
"""
import json, os, re, sys, time, unicodedata
from datetime import datetime, timedelta, timezone

import requests

from pick_alerts import clean_key, post as os_post

ESPN = "https://site.api.espn.com/apis/site/v2/sports/"
SITE = "https://onyxjordan.github.io/onyx-baseball-fix/"
LG = {"nfl": ("football/nfl", ""), "nba": ("basketball/nba", ""), "nhl": ("hockey/nhl", ""),
      "cfb": ("football/college-football", "groups=80&limit=300"),
      "cbb": ("basketball/mens-college-basketball", "groups=50&limit=400"), "mlb": ("baseball/mlb", "")}
STAT = {"pts": ("basketball", "PTS"), "reb": ("basketball", "REB"), "ast": ("basketball", "AST"),
        "rec": ("receiving", "REC"), "rec_yds": ("receiving", "YDS"), "rush_yds": ("rushing", "YDS"),
        "pass_yds": ("passing", "YDS")}
MW = {"pts": "points", "reb": "rebounds", "ast": "assists", "rec": "catches", "rec_yds": "receiving yards",
      "rush_yds": "rushing yards", "pass_yds": "passing yards", "anytime_td": "touchdowns", "q1_total": "in the 1st quarter"}
LEGACY = {"all": "start,swing,half,result", "key": "start,result", "results": "result", "recap": "recap", "off": ""}
EVENTS = ("start", "swing", "half", "result", "recap")


def wants(level):
    """push_level -> the set of events: a checklist ("start,result,recap", 11/8) or a legacy single level."""
    v = str(level or "off")
    v = LEGACY.get(v, v)
    return {k for k in v.split(",") if k in EVENTS}
ET = timezone(timedelta(hours=-5))          # ESPN's scoreboard day; DST is a one-hour edge the 4 AM roll covers
SWING_GAP = 15 * 60                          # a lead change pushes at most every 15 minutes per pick
SWING_MAX = 4                                # and at most 4 times per pick


# ── config ───────────────────────────────────────────────────────────────────────────────────
def config():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not url:
        try:
            url = (json.load(open("accounts.json")).get("url") or "").rstrip("/")
        except Exception:
            url = ""
    svc = "".join(os.environ.get("SUPABASE_SERVICE_KEY", "").split())
    app = "".join(os.environ.get("ONESIGNAL_APP_ID", "").split())
    key, scheme = clean_key(os.environ.get("ONESIGNAL_API_KEY", ""))
    return url, svc, app, key, scheme


class Supa:
    def __init__(self, url, svc):
        self.url, self.h = url, {"apikey": svc, "Authorization": f"Bearer {svc}", "Content-Type": "application/json"}

    def get(self, path):
        r = requests.get(self.url + "/rest/v1/" + path, headers=self.h, timeout=20)
        r.raise_for_status()
        return r.json()

    def put(self, table, rows):
        if not rows:
            return
        r = requests.post(self.url + "/rest/v1/" + table + "?on_conflict=user_id,item_id,event", data=json.dumps(rows),
                          headers=dict(self.h, Prefer="resolution=ignore-duplicates,return=minimal"), timeout=20)
        r.raise_for_status()


def inlist(xs):
    return "in.(" + ",".join('"' + str(x).replace('"', "") + '"' for x in xs) + ")"


# ── ESPN, ported from saved.js ───────────────────────────────────────────────────────────────
_SB, _SUM, _TN = {}, {}, {"t": 0, "c": []}


def nk(n):
    s = unicodedata.normalize("NFKD", str(n or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[.'’-]", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def et_day(start):
    try:
        t = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
    except ValueError:
        return ""
    return t.astimezone(ET).strftime("%Y%m%d")


def getj(url):
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    return r.json()


def scoreboard(sport, day):
    key, s = sport + day, _SB.get(sport + day)
    if s and time.time() - s["t"] < 30:
        return s["ev"]
    path, q = LG[sport]
    qs = "&".join(x for x in (q, "dates=" + day if day else "") if x)
    try:
        j = getj(ESPN + path + "/scoreboard" + ("?" + qs if qs else ""))
    except Exception:
        return (s or {}).get("ev", [])
    ev = []
    for e in j.get("events", []):
        c = (e.get("competitions") or [{}])[0]
        st = (e.get("status") or {}).get("type") or {}
        t = {x.get("homeAway"): x for x in c.get("competitors", [])}
        T = lambda x: {"ab": ((x or {}).get("team") or {}).get("abbreviation"), "sc": (x or {}).get("score")}
        ev.append({"id": e.get("id"), "state": st.get("state"), "detail": st.get("shortDetail") or st.get("detail") or "",
                   "period": (e.get("status") or {}).get("period"), "a": T(t.get("away")), "h": T(t.get("home"))})
    _SB[key] = {"t": time.time(), "ev": ev}
    return ev


def summary(sport, gid):
    s = _SUM.get(gid)
    if s and time.time() - s["t"] < 30:
        return s["j"]
    try:
        j = getj(ESPN + LG[sport][0] + "/summary?event=" + str(gid))
    except Exception:
        return (s or {}).get("j")
    _SUM[gid] = {"t": time.time(), "j": j}
    return j


def tennis():
    if time.time() - _TN["t"] < 30:
        return _TN["c"]
    c = []
    for tour in ("atp", "wta"):
        try:
            j = getj(ESPN + "tennis/" + tour + "/scoreboard")
        except Exception:
            continue
        for e in j.get("events", []):
            for g in e.get("groupings", []):
                if "Singles" in ((g.get("grouping") or {}).get("displayName") or ""):
                    c += g.get("competitions", [])
    _TN.update(t=time.time(), c=c)
    return c


def stat_of(j, p):
    v, td, seen = None, 0.0, False
    for t in ((j or {}).get("boxscore") or {}).get("players", []):
        for b in t.get("statistics", []):
            for a in b.get("athletes", []):
                if nk((a.get("athlete") or {}).get("displayName")) != nk(p.get("name")) or not a.get("stats"):
                    continue
                L = b.get("labels") or b.get("keys") or []
                at = lambda l: a["stats"][L.index(l)] if l in L and L.index(l) < len(a["stats"]) else None
                seen = True
                if p.get("mkt") == "anytime_td":
                    if b.get("name") in ("rushing", "receiving"):
                        try:
                            td += float(at("TD") or 0)
                        except ValueError:
                            pass
                    continue
                m = STAT.get(p.get("mkt"))
                if not m:
                    continue
                if m[0] == "basketball" or b.get("name") == m[0]:
                    try:
                        v = float(at(m[1]))
                    except (TypeError, ValueError):
                        pass
    if p.get("mkt") == "anytime_td":
        return td if seen else None
    return v if v is not None else (0.0 if seen else None)


def q1_of(j):
    cs = (((j or {}).get("header") or {}).get("competitions") or [{}])[0].get("competitors", [])
    q = []
    for c in cs:
        l = (c.get("linescores") or [{}])[0]
        try:
            q.append(float(l.get("displayValue", l.get("value"))))
        except (TypeError, ValueError):
            return None
    return q[0] + q[1] if len(q) == 2 else None


def track(p):
    """{state: pre|in|post, res: W|L|P|up|down|None, cur, detail, period} - saved.js track(), in Python."""
    out = {"state": "pre", "res": None, "cur": None, "detail": "", "period": None}
    sp = p.get("sport")
    if sp == "tennis":
        hits = [c for c in tennis() if any(nk((x.get("athlete") or {}).get("displayName")) == nk(p.get("name"))
                                           for x in c.get("competitors", []))]
        if not hits:
            return out
        c = hits[-1]
        st = (c.get("status") or {}).get("type") or {}
        me = [x for x in c["competitors"] if nk((x.get("athlete") or {}).get("displayName")) == nk(p.get("name"))][0]
        out.update(state=st.get("state"), detail=st.get("shortDetail") or "")
        if p.get("kind") == "ml" and st.get("state") == "post":
            out["res"] = "W" if me.get("winner") else "L"
        return out
    if sp not in LG:
        return out
    E = scoreboard(sp, et_day(p.get("start")))
    away = re.split(r" @ | vs ", str(p.get("matchup") or ""))[0]
    team = p.get("team") or away
    if sp == "nba":
        e = next((x for x in E if team in (x["a"]["ab"], x["h"]["ab"])), None)
    else:
        e = next((x for x in E if str(x["id"]) == str(p.get("gid"))), None) or \
            (next((x for x in E if p.get("team") in (x["a"]["ab"], x["h"]["ab"])), None) if p.get("team") else None)
    if not e:
        return out
    out.update(state=e["state"], detail=e["detail"], period=e["period"])
    if e["state"] == "pre":
        return out
    num = lambda x: float(x) if x not in (None, "") else 0.0
    as_, hs, done = num(e["a"]["sc"]), num(e["h"]["sc"]), e["state"] == "post"
    mine = [as_, hs] if p.get("name") == e["a"]["ab"] else [hs, as_] if p.get("name") == e["h"]["ab"] else None

    def settle(win, push, early):
        if win is not None:
            out["res"] = ("P" if push else "W" if win else "L") if (done or early) else ("up" if win else "down")
        return out
    kind = p.get("kind")
    if kind == "ml" and mine:
        out["cur"], out["tie"] = f"{mine[0]:g}-{mine[1]:g}", mine[0] == mine[1]
        return settle(mine[0] > mine[1], mine[0] == mine[1], False)
    if kind == "spread" and mine and p.get("hcap") is not None:
        m = mine[0] + float(p["hcap"]) - mine[1]
        out["cur"], out["tie"] = f"{mine[0]:g}-{mine[1]:g}", m == 0
        return settle(m > 0, m == 0, False)
    if kind == "total" and p.get("line") is not None:
        t, line = as_ + hs, float(p["line"])
        out["cur"] = t
        w = t > line if p.get("side") == "over" else t < line
        return settle(w, t == line, p.get("side") == "over" and w)
    j = summary(sp, e["id"])
    v = q1_of(j) if p.get("mkt") == "q1_total" else stat_of(j, p)
    if v is None:
        return out
    line = 0.5 if p.get("mkt") == "anytime_td" else float(p.get("line") or 0)
    win = v < line if p.get("side") == "under" else v > line
    q1over = p.get("mkt") == "q1_total" and (((((j or {}).get("header") or {}).get("competitions") or [{}])[0].get("status") or {}).get("period") or 0) > 1
    out["cur"] = v
    return settle(win, v == line, q1over or (p.get("side") != "under" and win))


# ── words ──────────────────────────────────────────────────────────────────────────────────────
def odds(a):
    return "" if a is None else (f"+{a}" if a > 0 else str(a))


def status_line(p, t):
    if t["cur"] is None:
        return ""
    k = p.get("kind")
    if k in ("ml", "spread"):
        return f"Score {t['cur']}"
    if k == "total":
        return f"{t['cur']:g} total, line {p.get('line')}"
    s = f"{t['cur']:g} {MW.get(p.get('mkt'), '')}".strip()
    return s if p.get("mkt") == "anytime_td" else f"{s}, line {p.get('line')}"


def message(ev, p, t):
    lab, st = p.get("label") or p.get("name") or "Your pick", status_line(p, t)
    if ev == "start":
        return "Your pick is live", f"{lab} · {p.get('matchup') or ''}".rstrip(" ·")
    if ev == "half":
        side = {"up": "on track", "down": "behind"}.get(t["res"], "")
        return "Halftime check", " · ".join(x for x in (lab, st, side) if x)
    if ev == "swing":
        return ("Your pick is ahead" if t["res"] == "up" else "Your pick fell behind"), " · ".join(x for x in (lab, st) if x)
    head = {"W": "Cashed: ", "L": "Missed: ", "P": "Push: "}[t["res"]]
    price = f"Onyx {odds(p.get('price'))}" if p.get("price") is not None else ""
    return head + lab, " · ".join(x for x in (st, price) if x)


# ── one poll ─────────────────────────────────────────────────────────────────────────────────
def send(app, key, scheme, uid, title, body):
    if not app or not key:
        return False
    res = os_post({"app_id": app, "target_channel": "push", "include_aliases": {"external_id": [uid]},
                   "headings": {"en": title}, "contents": {"en": body}, "url": SITE + "home.html#my"}, key, scheme)
    try:
        j = res.json()
    except Exception:
        j = {}
    ok = res.status_code < 300 and bool(j.get("id"))
    if not ok:
        print(f"  push to {uid[:8]} not delivered: {res.status_code} {str(j)[:160]}")
    return ok


ACTIVE = 0      # saved picks live or starting within 25 minutes, as of the last poll


def poll(db, app, key, scheme, dry=False):
    global ACTIVE
    ACTIVE = 0
    now = datetime.now(timezone.utc)
    users = {u["id"]: u["push_level"] for u in db.get("profiles?select=id,push_level&push_level=neq.off")
             if wants(u["push_level"])}
    if not users:
        return 0
    rows = db.get("saved_picks?select=user_id,item_id,data&user_id=" + inlist(users))
    live = []
    for r in rows:
        p = r.get("data") or {}
        try:
            s = datetime.fromisoformat(str(p.get("start")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if now - timedelta(hours=8) < s < now + timedelta(minutes=25):
            ACTIVE += 1
        if now - timedelta(hours=8) < s < now + timedelta(minutes=5):
            live.append((r["user_id"], r["item_id"], p, s))
    if not live:
        return 0
    seen = {}
    for x in db.get("push_sent?select=user_id,item_id,event,res,sent_at&user_id=" + inlist({u for u, *_ in live})
                    + "&sent_at=gte." + (now - timedelta(days=2)).isoformat()):
        seen.setdefault((x["user_id"], x["item_id"]), []).append(x)
    out, n = [], 0
    for uid, iid, p, s in live:
        try:
            t = track(p)
        except Exception as e:
            print(f"  track {iid}: {str(e)[:120]}")
            continue
        if t["state"] == "pre":
            continue
        want, done = wants(users[uid]), {x["event"]: x for x in seen.get((uid, iid), [])}
        evs = []
        if t["state"] == "in" and "start" not in done and now - s < timedelta(hours=3):
            evs.append("start")
        if t["res"] in ("W", "L", "P") and "result" not in done:
            evs.append("result")
        if t["state"] == "in" and re.search(r"\bhalftime\b", t["detail"], re.I) and "half" not in done and p.get("sport") != "tennis":
            evs.append("half")
        if t["state"] == "in" and t["res"] in ("up", "down") and not t.get("tie"):
            sw = sorted((x for e, x in done.items() if e.startswith("swing")), key=lambda x: x["sent_at"])
            last = sw[-1] if sw else done.get("start")
            last_res = (sw[-1]["res"] if sw else (done.get("start") or {}).get("res"))
            if last_res in ("up", "down") and last_res != t["res"] and len(sw) < SWING_MAX and \
                    (now - datetime.fromisoformat(last["sent_at"].replace("Z", "+00:00"))).total_seconds() > SWING_GAP:
                evs.append(f"swing{len(sw) + 1}")
        for ev in evs:
            base = "swing" if ev.startswith("swing") else ev
            # a pick already decided when first seen: only the result is pushed
            push = base in want and not (base != "result" and "result" in evs)
            ok = False
            if push:
                title, body = message(base, p, t)
                print(f"  {users[uid][:12]:12s} {uid[:8]} {ev:7s} {title} | {body}")
                ok = dry or send(app, key, scheme, uid, title, body)
                n += ok
            out.append({"user_id": uid, "item_id": iid, "event": ev, "res": t["res"], "pushed": bool(push and ok),
                        "data": {k: p.get(k) for k in ("label", "sport", "price", "start", "matchup")}})
    if out and not dry:
        db.put("push_sent", out)
    return n


def recap(db, app, key, scheme, dry=False):
    """One push per 'recap' person: yesterday's graded picks and today's saved ones (baseball day, ET - 4h)."""
    now = datetime.now(timezone.utc)
    bday = (now.astimezone(ET) - timedelta(hours=4)).date()
    users = [u["id"] for u in db.get("profiles?select=id,push_level&push_level=neq.off") if "recap" in wants(u["push_level"])]
    n = 0
    for uid in users:
        res = db.get(f"push_sent?select=item_id,res,data&user_id=eq.{uid}&event=eq.result&sent_at=gte."
                     + (now - timedelta(hours=36)).isoformat())
        y = [r for r in res if r.get("data") and r["data"].get("start") and
             (datetime.fromisoformat(r["data"]["start"].replace("Z", "+00:00")).astimezone(ET) - timedelta(hours=4)).date()
             == bday - timedelta(days=1)]
        w, l, pu = (sum(1 for r in y if r["res"] == c) for c in ("W", "L", "P"))
        units = sum((((r["data"].get("price") or -110) / 100) if (r["data"].get("price") or -110) > 0
                     else 100 / -(r["data"].get("price") or -110)) if r["res"] == "W" else -1 if r["res"] == "L" else 0 for r in y)
        today = [r["data"] for r in db.get(f"saved_picks?select=data&user_id=eq.{uid}")
                 if (r.get("data") or {}).get("start") and
                 (datetime.fromisoformat(r["data"]["start"].replace("Z", "+00:00")).astimezone(ET) - timedelta(hours=4)).date() == bday]
        if not y and not today:
            continue
        parts = []
        if y:
            parts.append(f"Yesterday {w}-{l}{f'-{pu}' if pu else ''}, {units:+.2f} units")
        if today:
            first = min(datetime.fromisoformat(p["start"].replace("Z", "+00:00")) for p in today).astimezone(ET)
            parts.append(f"Today: {len(today)} saved pick{'s' if len(today) != 1 else ''}, first at {first.strftime('%-I:%M%p').lower()} ET")
        body = " · ".join(parts)
        print(f"  recap {uid[:8]} | {body}")
        if dry or send(app, key, scheme, uid, "Your Onyx recap", body):
            n += 1
    return n


def main(argv):
    url, svc, app, key, scheme = config()
    if not url or not svc:
        print("my_alerts: SUPABASE_SERVICE_KEY (or the Supabase URL) is not set; nothing to do")
        return
    if not app or not key:
        print("my_alerts: OneSignal secrets are not set; nothing to do")
        return
    db, dry = Supa(url, svc), "--dry" in argv
    if "--recap" in argv:
        print(f"my_alerts recap: {recap(db, app, key, scheme, dry)} sent")
        return
    secs = int(argv[argv.index("--watch") + 1]) if "--watch" in argv else 0
    end, total = time.time() + secs, 0
    while True:
        try:
            total += poll(db, app, key, scheme, dry)
        except requests.HTTPError as e:
            body = e.response.text[:200] if e.response is not None else ""
            print(f"::warning::my_alerts poll: {e} {body}")
            if e.response is not None and e.response.status_code in (400, 401, 403, 404):
                print("my_alerts: check SUPABASE_SERVICE_KEY and that supabase/schema.sql (11/7 part) has been run")
                break
        except Exception as e:
            print(f"::warning::my_alerts poll: {str(e)[:200]}")
        if time.time() + 75 > end:
            break
        # (11/8: GitHub ran the 20-minute schedule twice in 13 hours, so the watcher no longer stops when nothing is
        # live: one long run covers the day, a pick saved minutes before kickoff included, and hands off to the next)
        time.sleep(75)
    print(f"my_alerts: {total} pushes sent")


if __name__ == "__main__":
    main(sys.argv[1:])
