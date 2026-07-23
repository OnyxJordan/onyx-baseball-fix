#!/usr/bin/env python3
"""
Onyx Baseball - daily recap writer.
Runs after grade_picks in the morning build. For every tracked pick from
yesterday it pulls the boxscore and play by play, then writes a readable
story: who they faced, the batting line, which at bat the homer came in
(with the broadcast description), or how close the misses came (deep fly
outs, wall-scrapers, doubles). Output lands in data/recap.json and
auto_build injects it into the shell as DAILY_RECAP.
"""

import json, re, unicodedata, urllib.request
from datetime import datetime, timedelta, timezone

PICKS = "data/picks_input.json"
OUT   = "data/recap.json"
MLB   = "https://statsapi.mlb.com/api/v1"

def nk(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[.’'\-]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

def yesterday_et():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).date() - timedelta(days=1)

ORDINAL = {1: "1st", 2: "2nd", 3: "3rd"}
def ordinal(n):
    return ORDINAL.get(n, f"{n}th")

NEAR_MISS_PAT = re.compile(
    r"deep|warning track|wall|center field fence|off the top", re.I)

def collect_day(date_iso):
    """Per-player game data for one date: line, opponent, pitcher, plays."""
    sched = get(f"{MLB}/schedule?sportId=1&date={date_iso}")
    players = {}
    for de in sched.get("dates", []):
        for g in de.get("games", []):
            if g.get("status", {}).get("abstractGameState") != "Final":
                continue
            pk = g["gamePk"]
            try:
                box = get(f"{MLB}/game/{pk}/boxscore")
                pbp = get(f"{MLB}/game/{pk}/playByPlay")
            except Exception:
                continue
            teams = box.get("teams", {})
            names = {"home": g["teams"]["home"]["team"].get("name", ""),
                     "away": g["teams"]["away"]["team"].get("name", "")}
            starters = {}
            for side in ("home", "away"):
                pl = (teams.get(side, {}).get("pitchers") or [])
                if pl:
                    p0 = (teams[side]["players"].get("ID" + str(pl[0])) or {})
                    starters[side] = (p0.get("person") or {}).get("fullName", "")
            for side in ("home", "away"):
                opp = "away" if side == "home" else "home"
                for pdata in (teams.get(side, {}).get("players") or {}).values():
                    nm = (pdata.get("person") or {}).get("fullName") or ""
                    bat = (pdata.get("stats") or {}).get("batting") or {}
                    if not nm or not bat:
                        continue
                    key = nk(nm)
                    plays = []
                    for play in pbp.get("allPlays", []):
                        if nk((play.get("matchup", {}).get("batter") or {}).get("fullName") or "") != key:
                            continue
                        res = play.get("result", {})
                        about = play.get("about", {})
                        plays.append({
                            "event": res.get("event", ""),
                            "desc": res.get("description", ""),
                            "inning": about.get("inning"),
                            "half": about.get("halfInning", ""),
                        })
                    players[key] = {
                        "name": nm,
                        "team": names[side],
                        "opp_team": names[opp],
                        "opp_starter": starters.get(opp, ""),
                        "ab": bat.get("atBats", 0), "h": bat.get("hits", 0),
                        "hr": bat.get("homeRuns", 0), "rbi": bat.get("rbi", 0),
                        "bb": bat.get("baseOnBalls", 0), "k": bat.get("strikeOuts", 0),
                        "plays": plays,
                    }
    return players

def story_for(pick, pdata):
    name = pick.get("player") or pick.get("name") or ""
    odds = pick.get("odds")
    odds_s = (f"+{odds}" if isinstance(odds, int) and odds > 0 else str(odds)) if odds else ""
    if not pdata:
        return {
            "player": name, "result": "void",
            "headline": f"{name} did not appear",
            "story": f"{name} was scratched or never got in the game, so the pick carries over as a no-action."}
    line = f"{pdata['h']}-for-{pdata['ab']}"
    extras = []
    if pdata["bb"]: extras.append(f"{pdata['bb']} BB")
    if pdata["rbi"] and not pdata["hr"]: extras.append(f"{pdata['rbi']} RBI")
    if extras: line += " with " + " and ".join(extras)
    vs = f"against {pdata['opp_starter']} and the {pdata['opp_team']}" if pdata["opp_starter"] \
         else f"against the {pdata['opp_team']}"

    if pdata["hr"] >= 1:
        hr_plays = [p for p in pdata["plays"] if p["event"] == "Home Run"]
        ab_no = None
        for i, p in enumerate(pdata["plays"], 1):
            if p["event"] == "Home Run":
                ab_no = i
                break
        hp = hr_plays[0] if hr_plays else {}
        det = hp.get("desc") or ""
        inn = f"in the {ordinal(hp['inning'])}" if hp.get("inning") else ""
        ab_s = f"his {ordinal(ab_no)} at bat" if ab_no else "mid game"
        more = " He added another later in the game." if pdata["hr"] > 1 else ""
        return {
            "player": name, "result": "hit",
            "headline": f"{name} connected at {odds_s}" if odds_s else f"{name} connected",
            "story": (f"{name} cashed. Facing {pdata['opp_starter'] or 'the ' + pdata['opp_team']}"
                      f", he went deep {inn} in {ab_s}. The call: \"{det}\"{more} "
                      f"Final line: {line}.")}

    near = [p for p in pdata["plays"]
            if (p["event"] in ("Double", "Triple") or
                (p["event"] in ("Flyout", "Lineout") and NEAR_MISS_PAT.search(p["desc"] or "")))]
    if near:
        p0 = near[0]
        inn = f"in the {ordinal(p0['inning'])}" if p0.get("inning") else ""
        what = ("a double" if p0["event"] == "Double" else
                "a triple" if p0["event"] == "Triple" else
                "a deep drive that stayed in the park")
        return {
            "player": name, "result": "miss",
            "headline": f"{name} came close",
            "story": (f"{name} went {line} {vs}. Closest call was {what} {inn}: "
                      f"\"{p0['desc']}\" The power showed up; the carry did not.")}

    if pdata["ab"] == 0 and pdata["bb"] > 0:
        return {"player": name, "result": "miss",
                "headline": f"{name} never got a pitch to hit",
                "story": f"{name} was pitched around {vs}, walking {pdata['bb']} time(s) without an official at bat."}
    return {
        "player": name, "result": "miss",
        "headline": f"{name} stayed in the yard",
        "story": f"{name} went {line} {vs}. No real scare on the HR front"
                 + (f", striking out {pdata['k']} times." if pdata["k"] >= 2 else ".")}

def main():
    try:
        picks = json.load(open(PICKS, encoding="utf-8"))
    except Exception:
        picks = []
    ydate = yesterday_et()
    ystr = ydate.strftime("%Y-%m-%d")
    day_picks = [p for p in picks if isinstance(p, dict) and str(p.get("date")) == ystr]
    if not day_picks:
        json.dump({}, open(OUT, "w", encoding="utf-8"))
        print(f"recap: no tracked picks for {ystr} - empty recap")
        return
    try:
        players = collect_day(ystr)
    except Exception as ex:
        print(f"recap: data fetch failed ({ex}) - keeping previous recap")
        return
    entries = [story_for(p, players.get(nk(p.get("player") or p.get("name") or ""))) for p in day_picks]
    hits = sum(1 for e in entries if e["result"] == "hit")
    losses = sum(1 for e in entries if e["result"] == "miss")
    # season running record from all graded picks
    sw = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is True)
    sl = sum(1 for p in picks if isinstance(p, dict) and p.get("hit") is False)
    head = (f"A {hits}-for-{len(entries)} night" if hits else
            "Blanked, but with chances")
    recap = {
        "date": ystr,
        "display_date": ydate.strftime("%B %d, %Y").replace(" 0", " "),
        "headline": head,
        "record_line": f"Yesterday: {hits}-{losses} on the top plays · Season: {sw}-{sl}",
        "entries": entries,
    }
    json.dump(recap, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"recap: wrote {len(entries)} stories for {ystr} ({hits} hits)")

if __name__ == "__main__":
    main()
