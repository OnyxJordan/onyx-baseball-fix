#!/usr/bin/env python3
"""Dev-only: regenerate data/nba/team_logos.json, the 30 NBA team logos as
80px PNG data URIs (ESPN's resizing CDN). nba_build.py injects them into
nba.html so logos never depend on a third-party host at page load.
Run only when a team rebrands:  python3 tools/nba_make_logos.py"""
import base64, json, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nba_common import TEAM_NAMES

out = {}
for ab in sorted(TEAM_NAMES):
    url = f"https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/{ab.lower()}.png&w=80&h=80"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        out[ab] = "data:image/png;base64," + base64.b64encode(r.read()).decode()
Path("data/nba/team_logos.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {len(out)} logos, {sum(map(len, out.values())) // 1024} KB")
