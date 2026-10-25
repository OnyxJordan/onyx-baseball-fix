#!/usr/bin/env python3
"""Dev-only: regenerate data/nba/team_logos.json, the 30 NBA team logos as
96px PNG data URIs. nba_build.py injects them into nba.html so logos never
depend on a third-party host at page load.

ESPN's source images carry different amounts of empty margin around each
mark (the 76ers sat low and the Bucks high in the score ticker), so every
logo is cropped to its visible pixels, then centered on a square canvas with
the same padding. Needs Pillow (dev only; the pipeline never runs this).

Run only when a team rebrands:  python3 tools/nba_make_logos.py"""
import base64, io, json, sys, urllib.request
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nba_common import TEAM_NAMES

SIZE, PAD = 96, 0.06          # output px, padding as a share of the side


def fetch(ab):
    url = f"https://a.espncdn.com/i/teamlogos/nba/500/{ab.lower()}.png"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGBA")


def normalize(im):
    # crop to pixels that are actually visible (alpha above a faint threshold)
    alpha = im.getchannel("A").point(lambda a: 255 if a > 12 else 0)
    box = alpha.getbbox() or (0, 0, im.width, im.height)
    im = im.crop(box)
    inner = int(SIZE * (1 - 2 * PAD))
    scale = inner / max(im.width, im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
    return canvas


out = {}
for ab in sorted(TEAM_NAMES):
    buf = io.BytesIO()
    normalize(fetch(ab)).save(buf, "PNG", optimize=True)
    out[ab] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
Path("data/nba/team_logos.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {len(out)} logos, {sum(map(len, out.values())) // 1024} KB")
