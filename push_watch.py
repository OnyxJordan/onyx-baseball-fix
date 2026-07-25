#!/usr/bin/env python3
"""
push_watch.py — closed-app push notifications for HRs and finals.

Runs from notify_watch.yml every 30 minutes during game hours and polls the
MLB Stats API every ~45 seconds for its ~28-minute window, so a homer hits
phones within about a minute of leaving the bat. Sends through OneSignal
(free tier) to subscribers tagged by the in-app notification toggles:

  hr=1     modeled-batter home runs, with the ball's Statcast line and what
           the model projected pregame (probability, edge, listed odds)
  final=1  game finals

Needs ONESIGNAL_APP_ID + ONESIGNAL_API_KEY secrets; exits instantly without
them so the workflow is a free no-op until the keys are added. Only plays
that happen DURING this run's window are pushed (no replays of old innings
on startup), and each run keeps an in-memory sent set so nothing doubles.
"""
import json, os, re, sys, time, datetime
import requests

APP_ID = os.environ.get("ONESIGNAL_APP_ID", "").strip()
API_KEY = os.environ.get("ONESIGNAL_API_KEY", "").strip()
SITE = "https://onyxjordan.github.io/onyx-baseball-fix/"
WINDOW_SEC = int(os.environ.get("PUSH_WINDOW_SEC", "1680"))   # ~28 min
POLL_SEC = 45

if not APP_ID or not API_KEY:
    print("push_watch: OneSignal secrets not set — skipping (free no-op)")
    sys.exit(0)


def results_from_index():
    """Model rows baked into index.html -> name-keyed dict."""
    try:
        with open("index.html", encoding="utf-8") as f:
            html = f.read()
        m = re.search(r"const RESULTS\s*=\s*(\[.*?\]);\n", html, re.S)
        rows = json.loads(m.group(1)) if m else []
    except Exception as e:
        print(f"push_watch: no RESULTS ({e})")
        rows = []
    out = {}
    for r in rows:
        n = (r.get("matched_name") or "").lower()
        if n:
            out[n] = r
    return out


def onesignal_send(tag, heading, body, url=SITE):
    try:
        r = requests.post(
            "https://api.onesignal.com/notifications",
            headers={"Authorization": f"Basic {API_KEY}", "Content-Type": "application/json"},
            json={
                "app_id": APP_ID,
                "filters": [{"field": "tag", "key": tag, "relation": "=", "value": "1"}],
                "headings": {"en": heading},
                "contents": {"en": body},
                "url": url,
            }, timeout=15)
        ok = r.status_code < 300
        print(f"push_watch: [{tag}] {'sent' if ok else 'FAILED ' + str(r.status_code)} — {heading}")
        if not ok:
            print(" ", r.text[:300])
        return ok
    except Exception as e:
        print(f"push_watch: send error {e}")
        return False


def live_game_pks():
    today = datetime.datetime.now(datetime.timezone.utc).astimezone(
        datetime.timezone(datetime.timedelta(hours=-4))).date().isoformat()
    r = requests.get("https://statsapi.mlb.com/api/v1/schedule",
                     params={"sportId": 1, "date": today}, timeout=15)
    games = []
    for d in r.json().get("dates", []):
        for g in d.get("games", []):
            games.append({"pk": g["gamePk"],
                          "state": ((g.get("status") or {}).get("abstractGameState") or ""),
                          "away": ((g["teams"]["away"]["team"]) or {}).get("name", ""),
                          "home": ((g["teams"]["home"]["team"]) or {}).get("name", "")})
    return games


def main():
    model = results_from_index()
    start = time.time()
    sent_hr, sent_final = set(), set()
    was_live = set()
    first_pass = True
    print(f"push_watch: watching for {WINDOW_SEC}s, {len(model)} modeled bats")

    while time.time() - start < WINDOW_SEC:
        try:
            games = live_game_pks()
        except Exception as e:
            print(f"push_watch: schedule error {e}")
            time.sleep(POLL_SEC)
            continue

        live = [g for g in games if g["state"] == "Live"]
        for g in games:
            # finals: only games seen live during THIS run transition to final
            if g["state"] == "Final" and g["pk"] in was_live and g["pk"] not in sent_final:
                sent_final.add(g["pk"])
                try:
                    box = requests.get(f"https://statsapi.mlb.com/api/v1.1/game/{g['pk']}/feed/live", timeout=15).json()
                    ls = ((box.get("liveData") or {}).get("linescore") or {})
                    a = ((ls.get("teams") or {}).get("away") or {}).get("runs", "")
                    h = ((ls.get("teams") or {}).get("home") or {}).get("runs", "")
                    onesignal_send("final", f"FINAL: {g['away']} {a} — {g['home']} {h}",
                                   "Full gamecast and recap on Onyx Baseball.")
                except Exception as e:
                    print(f"push_watch: final send error {e}")
        for g in live:
            was_live.add(g["pk"])

        for g in live:
            try:
                feed = requests.get(f"https://statsapi.mlb.com/api/v1.1/game/{g['pk']}/feed/live", timeout=15).json()
            except Exception:
                continue
            plays = ((feed.get("liveData") or {}).get("plays") or {}).get("allPlays") or []
            for p in plays:
                res = (p.get("result") or {})
                if not re.search(r"home run", res.get("event") or "", re.I):
                    continue
                batter = ((p.get("matchup") or {}).get("batter") or {})
                key = f"{g['pk']}|{p.get('atBatIndex')}|{batter.get('id')}"
                if key in sent_hr:
                    continue
                sent_hr.add(key)
                # never replay homers that predate this run
                if first_pass:
                    continue
                name = batter.get("fullName") or ""
                r = model.get(name.lower())
                if not r:
                    continue
                hd = {}
                for ev in (p.get("playEvents") or []):
                    if ev.get("isPitch") and ((ev.get("details") or {}).get("isInPlay")) and ev.get("hitData"):
                        hd = ev["hitData"]
                stat = []
                if hd.get("totalDistance"): stat.append(f"{round(hd['totalDistance'])} ft")
                if hd.get("launchSpeed"):   stat.append(f"{hd['launchSpeed']} mph")
                if hd.get("launchAngle") is not None: stat.append(f"{round(hd['launchAngle'])}°")
                proj = f"Model had him {r.get('hr_prob')}%"
                if r.get("hr_edge") is not None:
                    proj += f" ({'+' if r['hr_edge'] > 0 else ''}{r['hr_edge']} edge)"
                if r.get("dk_hr_odds"):
                    o = r["dk_hr_odds"]
                    proj += f" at {'+' if o > 0 else ''}{o}"
                body = (" · ".join(stat) + (f" vs {r.get('opp_pitcher')}" if r.get('opp_pitcher') else ""))
                body = (body + "\n" if body else "") + proj
                onesignal_send("hr", f"💣 HR — {name} ({r.get('team', '')})", body)

        first_pass = False
        time.sleep(POLL_SEC)

    print("push_watch: window complete")


if __name__ == "__main__":
    main()
