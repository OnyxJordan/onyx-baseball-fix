#!/usr/bin/env python3
"""Gauntlet leaderboard publisher.

Pulls standings from a Retool workflow webhook, bakes them into a
self-contained leaderboard page, and publishes it to tiiny.host.

Environment:
    RETOOL_WEBHOOK_URL   Retool workflow webhook (startTrigger) URL
    RETOOL_WORKFLOW_KEY  Retool workflow API key (X-Workflow-Api-Key header)
    TIINY_API_KEY        tiiny.host API key (Manage Account -> API Key)
    TIINY_DOMAIN         target site, defaults to onyxgamesgauntlet.tiiny.site

Local testing:
    python gauntlet/build_leaderboard.py --sample --no-upload
        renders gauntlet/out/index.html from built-in sample rows
    python gauntlet/build_leaderboard.py --no-upload
        fetches real standings from Retool but skips the tiiny upload
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
TIINY_UPLOAD_URL = "https://ext.tiiny.host/v1/upload"

SAMPLE_ROWS = [
    {"rank": 1, "player": "SampleSlugger", "prize": "$500"},
    {"rank": 2, "player": "MiniGameMike", "prize": "$250"},
    {"rank": 3, "player": "GauntletGrinder", "prize": "$100"},
    {"rank": 4, "player": "FourthPlaceFred", "prize": ""},
]


def fetch_standings(url: str, key: str) -> list:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Workflow-Api-Key"] = key
    resp = requests.post(url, headers=headers, json={}, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    rows = data.get("standings") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        sys.exit(
            "Retool returned no standings; aborting so the live page keeps "
            f"its previous data. Response was: {json.dumps(data)[:500]}"
        )
    return rows


def updated_label() -> str:
    now = datetime.now(ZoneInfo("America/New_York"))
    tz = "EDT" if now.dst() else "EST"
    return f"{now.strftime('%-I:%M %p')} {tz} · {now.strftime('%B %-d, %Y')}"


def render(rows: list) -> str:
    html = TEMPLATE.read_text()
    html = html.replace("__DATA__", json.dumps(rows, default=str))
    html = html.replace("__UPDATED__", updated_label())
    return html


def upload(html: str, api_key: str, domain: str) -> None:
    resp = requests.post(
        TIINY_UPLOAD_URL,
        headers={"x-api-key": api_key},
        files={"files": ("index.html", html, "text/html")},
        data={"domain": domain},
        timeout=120,
    )
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:500]}
    if resp.status_code != 200 or body.get("success") is False:
        sys.exit(f"tiiny.host upload failed (HTTP {resp.status_code}): {body}")
    print(f"Published {len(html):,} bytes to https://{domain}/")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="use built-in sample rows")
    ap.add_argument("--no-upload", action="store_true", help="render only, skip tiiny upload")
    args = ap.parse_args()

    if args.sample:
        rows = SAMPLE_ROWS
    else:
        rows = fetch_standings(
            os.environ["RETOOL_WEBHOOK_URL"],
            os.environ.get("RETOOL_WORKFLOW_KEY", ""),
        )
    print(f"{len(rows)} standings rows")

    html = render(rows)
    out = HERE / "out" / "index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
    print(f"Rendered {out}")

    if not args.no_upload:
        upload(
            html,
            os.environ["TIINY_API_KEY"],
            os.environ.get("TIINY_DOMAIN", "onyxgamesgauntlet.tiiny.site"),
        )


if __name__ == "__main__":
    main()
