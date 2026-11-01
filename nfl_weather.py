#!/usr/bin/env python3
"""
nfl_weather.py - the forecast at kickoff for every NFL game on the slate (nfl_model v12).

Open-Meteo (free, no key) hourly forecast at the home stadium: wind at 10 m in mph, gusts,
temperature. Domes and closed-roof stadiums are marked and get no wind. Neutral-site games
(London, Germany, Mexico City) are skipped. Written to data/nfl/weather.json on every build,
so a game's forecast firms up through the week. Pipeline-safe: requests only, fail-soft (a
failed fetch keeps the last forecast).
"""
from datetime import datetime, timezone

import requests

URL = "https://api.open-meteo.com/v1/forecast"
# home stadiums open to the weather (ESPN abbreviations): lat, lon
OPEN = {"BUF": (42.774, -78.787), "MIA": (25.958, -80.239), "NE": (42.091, -71.264), "NYJ": (40.814, -74.074),
        "NYG": (40.814, -74.074), "BAL": (39.278, -76.623), "CIN": (39.095, -84.516), "CLE": (41.506, -81.700),
        "PIT": (40.447, -80.016), "JAX": (30.324, -81.637), "TEN": (36.166, -86.771), "DEN": (39.744, -105.020),
        "KC": (39.049, -94.484), "CHI": (41.862, -87.617), "GB": (44.501, -88.062), "CAR": (35.226, -80.853),
        "TB": (27.976, -82.503), "PHI": (39.901, -75.168), "WSH": (38.908, -76.864), "SF": (37.403, -121.970),
        "SEA": (47.595, -122.332)}
# domes, fixed roofs and retractable roofs (closed in bad weather): no wind
COVERED = {"ARI", "ATL", "DAL", "DET", "HOU", "IND", "LV", "LAR", "LAC", "MIN", "NO"}


def _forecasts(points):
    """points: [(lat, lon, kickoff)] -> [forecast or None], one request for every stadium
    (Open-Meteo takes comma-separated coordinates; one call per game hits its rate limit)."""
    if not points:
        return []
    import time
    params = {"latitude": ",".join(f"{p[0]}" for p in points), "longitude": ",".join(f"{p[1]}" for p in points),
              "hourly": "wind_speed_10m,wind_gusts_10m,temperature_2m", "wind_speed_unit": "mph",
              "temperature_unit": "fahrenheit", "timezone": "UTC", "forecast_days": 16}
    for i in range(3):
        r = requests.get(URL, params=params, timeout=30)
        if r.status_code == 429 and i < 2:
            time.sleep(5 * (i + 1))
            continue
        r.raise_for_status()
        break
    js = r.json()
    js = js if isinstance(js, list) else [js]
    out = []
    for (lat, lon, start), j in zip(points, js):
        h = (j or {}).get("hourly") or {}
        t = start.strftime("%Y-%m-%dT%H:00")
        if t not in (h.get("time") or []):
            out.append(None)
            continue
        k = h["time"].index(t)
        out.append({"wind": h["wind_speed_10m"][k], "gust": h["wind_gusts_10m"][k], "temp": h["temperature_2m"][k]})
    return out


def update(lane, slate):
    """Forecasts for this week's and next week's games still to be played."""
    W = lane.load("weather.json", {}) or {}
    now = datetime.now(timezone.utc)
    ts = now.isoformat(timespec="seconds")
    games = (slate.get("games") or []) + (slate.get("next_games") or [])
    keep, todo = {}, []
    for g in games:
        gid, home = g.get("gid"), g.get("home")
        if not gid or g.get("state") == "post":
            continue
        try:
            start = datetime.fromisoformat(str(g.get("start")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if g.get("neutral"):
            keep[gid] = {"roof": "neutral", "at": ts}
        elif home in COVERED:
            keep[gid] = {"roof": "dome", "wind": 0.0, "at": ts}
        elif home in OPEN and (start - now).days <= 15:
            todo.append((gid, start))
    try:
        got = _forecasts([(*OPEN[[g for g in games if g.get("gid") == gid][0]["home"]], start) for gid, start in todo])
    except Exception as ex:                     # fail-soft: keep the last forecasts
        print(f"  weather: {ex}")
        got = [None] * len(todo)
    for (gid, start), f in zip(todo, got):
        if f:
            keep[gid] = {"roof": "outdoors", **f, "kickoff": start.isoformat(), "at": ts}
        elif gid in W:
            keep[gid] = W[gid]
    lane.save("weather.json", keep, indent=1)
    windy = sum(1 for v in keep.values() if (v.get("wind") or 0) >= 15)
    print(f"  weather: {len(keep)} games forecast, {windy} at 15+ mph")
    return keep
