"""
pick_alerts.py - a push the moment an Onyx Pick locks (11/7, Jordan: "an alerts system for at the open that
sends push notifications when it's over X%, should have a message that sends and track that pick").

Every alert is an Onyx Pick: picks.py has already logged it in data/picks/ledger.json at the price shown when it
qualified, so the alert is on the graded public record by construction (Jordan's call: alerts = Onyx Picks over
X%, never a second tracked list). Subscribers choose X on the site (alerts.js: OneSignal tags picks=1 and
min_conf=55/60/65); each pick goes only to subscribers whose X is at or below its chance.

    python3 pick_alerts.py          run by the refresh and daily builds after picks are logged

Sends at most once per pick (data/picks/alerted.json, ids), only for picks logged in the last 3 hours whose game
has not started, so switching push on never floods old picks. Without the ONESIGNAL_APP_ID / ONESIGNAL_API_KEY
secrets it does nothing but write data/push.json with no app id (the site then shows alerts as coming soon).
Fail-soft: any error prints a warning and exits 0. Depends on requests only.
"""
import json, os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

LEDGER = Path("data/picks/ledger.json")
SENT = Path("data/picks/alerted.json")
PUSH = Path("data/push.json")
SITE = "https://onyxjordan.github.io/onyx-baseball-fix/"
LG = {"nfl": "NFL", "cfb": "NCAAF", "nba": "NBA", "cbb": "NCAAB", "nhl": "NHL", "tennis": "Tennis"}


def _load(p, d):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return d


def _odds(p):
    return f"+{p}" if p > 0 else str(p)


def _when(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def main():
    # a pasted secret can carry a line break or spaces inside it (11/7: the key failed as an invalid header);
    # ids and keys never contain whitespace, so drop all of it
    app = "".join(os.environ.get("ONESIGNAL_APP_ID", "").split())
    key = "".join(os.environ.get("ONESIGNAL_API_KEY", "").split())
    # the site reads the app id here (public, not a secret): empty until push is set up
    want = {"app_id": app or None}
    if _load(PUSH, None) != want:
        PUSH.write_text(json.dumps(want), encoding="utf-8")
    if not app or not key:
        print("pick alerts: push not configured (ONESIGNAL_APP_ID / ONESIGNAL_API_KEY); nothing sent")
        return
    now = datetime.now(timezone.utc)
    sent = set(_load(SENT, []) or [])
    rows = _load(LEDGER, []) or []
    fresh = [r for r in rows if r.get("id") not in sent and not r.get("result")
             and (_when(r.get("logged_at")) or now - timedelta(days=1)) > now - timedelta(hours=3)
             and (_when(r.get("start")) or now) > now]
    n = 0
    for r in fresh:
        pct = int(round(100 * (r.get("chance") or 0)))
        msg = (f"{r['label']} {_odds(r['price'])}{' (market line)' if r.get('src') == 'market' else ''} · {pct}% to hit · "
               f"{LG.get(r['sport'], r['sport'])}" + ("" if r.get("matchup", "") in r["label"] else f" {r.get('matchup', '')}"))
        body = {"app_id": app, "target_channel": "push",
                "headings": {"en": "New Onyx Pick"}, "contents": {"en": msg},
                "url": SITE + "picks.html",
                # subscribers who turned pick alerts on, with X at or below this pick's chance
                "filters": [{"field": "tag", "key": "picks", "relation": "=", "value": "1"},
                            {"field": "tag", "key": "min_conf", "relation": "<", "value": str(pct + 1)}]}
        try:
            res = requests.post("https://api.onesignal.com/notifications", json=body, timeout=20,
                                headers={"Authorization": f"Key {key}", "Content-Type": "application/json"})
            if res.status_code < 300:
                sent.add(r["id"])
                n += 1
            else:
                print(f"::warning::pick alert for {r['id']} not sent: {res.status_code} {res.text[:160]}")
        except Exception as e:
            print(f"::warning::pick alert for {r['id']} failed: {str(e)[:160]}")
    if n:
        SENT.write_text(json.dumps(sorted(sent)), encoding="utf-8")
    print(f"pick alerts: {n} sent, {len(fresh) - n} not sent, {len(fresh)} new picks")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"::warning::pick_alerts failed: {str(e)[:200]}")
