"""
verify_alerts.py - the notification sweep (11/9, Jordan: "keep running full notification sweep make sure they work").

Runs every push path end to end with nothing sent and no secret needed: my_alerts.py (saved picks: game start,
lead change, halftime, result, the morning recap) against an in-memory Supabase that reads query strings the way
PostgREST does (a raw "+" is a space, so a bad timestamp fails here exactly as it failed in production on 11/8)
and a scripted ESPN feed; and pick_alerts.py (Onyx Pick alerts) against a scratch ledger and a fake OneSignal.

    python3 tools/verify_alerts.py      exits 1 on any failure

Every sport and bet kind the watcher grades is covered: NBA moneyline and points, NFL anytime TD and spread, NHL
total, NBA 1st-quarter total, college football and basketball moneylines by game id, tennis, and a saved parlay;
every push level (all, key, results, a checklist, off); and the rules: one push per event, lead changes at most
every 15 minutes, a pick first seen already decided pushes only its result, the recap once a day.
"""
import json, os, sys, tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import my_alerts as M          # noqa: E402
import pick_alerts as PA       # noqa: E402

FAIL = []
NOW = datetime.now(timezone.utc)


def check(ok, what):
    print(("  ok   " if ok else "  FAIL ") + what)
    if not ok:
        FAIL.append(what)


def ts_ok(v):
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


# ── an in-memory Supabase that reads filters like PostgREST ─────────────────────────────────────
class FakeDB:
    def __init__(self):
        self.t = {"profiles": [], "saved_picks": [], "push_sent": []}
        self.bad = []

    def _match(self, row, col, f):
        op, _, v = f.partition(".")
        x = row.get(col)
        if op in ("gte", "lte") and col.endswith("_at"):
            if not ts_ok(v):
                self.bad.append(f"{col}={f}")
                raise M.requests.HTTPError("400 invalid input syntax for type timestamp with time zone: " + v)
            a, b = datetime.fromisoformat(str(x).replace("Z", "+00:00")), datetime.fromisoformat(v.replace("Z", "+00:00"))
            return a >= b if op == "gte" else a <= b
        if op == "eq":
            return str(x) == v
        if op == "neq":
            return str(x) != v
        if op == "in":
            return str(x) in [s.strip('"') for s in v.strip("()").split(",")]
        raise ValueError("filter " + f)

    def get(self, path):
        u = urlsplit("/" + path)
        table = u.path.strip("/")
        rows = self.t[table]
        for col, f in parse_qsl(u.query, keep_blank_values=True):   # "+" -> " ", as PostgREST reads it
            if col == "select":
                continue
            rows = [r for r in rows if self._match(r, col, f)]
        return [dict(r) for r in rows]

    def put(self, table, rows):
        have = {(r["user_id"], r["item_id"], r["event"]) for r in self.t[table]}
        for r in rows:
            if (r["user_id"], r["item_id"], r["event"]) not in have:
                self.t[table].append(dict(r, sent_at=iso(datetime.now(timezone.utc))))

    def age(self, minutes):
        """every push_sent row back-dated, to step past the 15-minute lead-change gap"""
        for r in self.t["push_sent"]:
            r["sent_at"] = iso(datetime.fromisoformat(r["sent_at"].replace("Z", "+00:00")) - timedelta(minutes=minutes))


# ── a scripted ESPN ────────────────────────────────────────────────────────────────────────────
GAMES, BOX, TENNIS = {}, {}, []


def game(sport, gid, away, home, state="pre", a=0, h=0, detail="", period=1):
    GAMES.setdefault(sport, {})[gid] = {"id": gid, "competitions": [{"competitors": [
        {"homeAway": "away", "team": {"abbreviation": away}, "score": str(a)},
        {"homeAway": "home", "team": {"abbreviation": home}, "score": str(h)}]}],
        "status": {"type": {"state": state, "shortDetail": detail}, "period": period}}


def box(gid, players=(), q1=None, period=1):
    """players: (name, group, labels, stats)"""
    groups = {}
    for name, grp, labels, stats in players:
        groups.setdefault((grp, tuple(labels)), []).append({"athlete": {"displayName": name}, "stats": stats})
    comps = [{"linescores": [{"displayValue": str(q)}]} for q in (q1 or [])]
    BOX[gid] = {"boxscore": {"players": [{"statistics": [{"name": g, "labels": list(l), "athletes": a}
                                                         for (g, l), a in groups.items()]}]},
                "header": {"competitions": [{"competitors": comps, "status": {"period": period}}]}}


def fake_getj(url):
    if "/tennis/" in url:
        return {"events": [{"groupings": [{"grouping": {"displayName": "Men's Singles"}, "competitions": TENNIS}]}]} \
            if "/atp/" in url else {"events": []}
    if "/summary?event=" in url:
        return BOX.get(url.split("event=")[1], {})
    for sp, (path, _) in M.LG.items():
        if "/" + path + "/scoreboard" in url:
            return {"events": list(GAMES.get(sp, {}).values())}
    return {"events": []}


SENT = []


class Res:
    def __init__(self, code, j):
        self.status_code, self._j, self.text = code, j, json.dumps(j)

    def json(self):
        return self._j


def fake_os_post(body, key, scheme):
    SENT.append(body)
    return Res(200, {"id": "n-%d" % len(SENT)})


M.getj, M.os_post = fake_getj, fake_os_post


def step(db, what, expect):
    """one poll; expect = [(uid, title starts with, body contains)]"""
    for c in (M._SB, M._SUM):
        c.clear()
    M._TN["t"] = 0
    SENT.clear()
    n = M.poll(db, "app", "key", "Key")
    got = [(b["include_aliases"]["external_id"][0], b["headings"]["en"], b["contents"]["en"]) for b in SENT]
    ok = len(got) == len(expect) and all(any(g[0] == u and g[1].startswith(t) and c in g[2] for g in got) for u, t, c in expect)
    ok = ok and n == len(expect) and all(b.get("target_channel") == "push" and b.get("url", "").endswith("home.html#my") for b in SENT)
    check(ok, what + ("" if ok else f"  got {got}"))


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    print("my_alerts: saved picks")
    db = FakeDB()
    ALL, KEY, RES, LIST, OFF = "u-all", "u-key", "u-res", "u-list", "u-off"
    for u, lv in ((ALL, "all"), (KEY, "key"), (RES, "results"), (LIST, "start,result,recap"), (OFF, "off")):
        db.t["profiles"].append({"id": u, "push_level": lv})
    live = iso(NOW - timedelta(minutes=20))
    soon = iso(NOW + timedelta(hours=2))

    def save(uid, iid, **p):
        p.setdefault("start", live)
        db.t["saved_picks"].append({"user_id": uid, "item_id": iid, "data": p})

    # NBA moneyline, every update
    save(ALL, "ml-lal", sport="nba", kind="ml", name="LAL", team="LAL", matchup="LAL @ ATL", label="Lakers ML", price=-120)
    # NBA points over, key moments
    save(KEY, "pts-luka", sport="nba", kind="prop", mkt="pts", name="Luka Doncic", team="LAL", side="over", line=30.5,
         matchup="LAL @ ATL", label="Luka Doncic Over 30.5 points", price=-115)
    # NFL anytime TD and spread, results only
    save(RES, "td-cmc", sport="nfl", kind="prop", mkt="anytime_td", name="Christian McCaffrey", team="SF", gid="401",
         matchup="SF @ SEA", label="Christian McCaffrey anytime TD", price=-140)
    save(RES, "sp-sea", sport="nfl", kind="spread", name="SEA", team="SEA", hcap=3.5, gid="401", matchup="SF @ SEA",
         label="SEA +3.5", price=-110, my_price=-105)
    # NHL total, NBA 1Q total, college moneylines, tennis, a parlay: the checklist level
    save(LIST, "tot-nhl", sport="nhl", kind="total", side="under", line=5.5, gid="501", matchup="BOS @ TOR",
         label="BOS @ TOR Under 5.5", price=-105)
    save(LIST, "q1-nba", sport="nba", kind="prop", mkt="q1_total", side="over", line=55.5, team="BOS", matchup="BOS @ NYK",
         label="BOS @ NYK 1Q Over 55.5", price=-110)
    save(LIST, "ml-cfb", sport="cfb", kind="ml", name="OSU", gid="601", matchup="OSU @ MICH", label="Ohio State ML", price=-200)
    save(LIST, "ml-cbb", sport="cbb", kind="ml", name="DUKE", gid="701", matchup="DUKE @ UNC", label="Duke ML", price=-150)
    save(LIST, "ml-ten", sport="tennis", kind="ml", name="Jannik Sinner", label="Jannik Sinner ML", price=-300)
    save(LIST, "par-2", sport="nba", kind="parlay", label="2-leg parlay", price=264, legs=[
        {"sport": "nba", "kind": "ml", "name": "LAL", "team": "LAL", "matchup": "LAL @ ATL", "start": live},
        {"sport": "nba", "kind": "ml", "name": "BOS", "team": "BOS", "matchup": "BOS @ NYK", "start": live}])
    # off: never pushed; a game three hours away: not watched yet
    save(OFF, "ml-off", sport="nba", kind="ml", name="LAL", team="LAL", matchup="LAL @ ATL", label="Lakers ML", price=-120)
    save(ALL, "ml-later", sport="nba", kind="ml", name="DEN", team="DEN", matchup="DEN @ HOU", label="Nuggets ML", start=soon)

    BL = ["MIN", "PTS", "REB", "AST"]
    for sp, gid, a, h in (("nba", "1", "LAL", "ATL"), ("nba", "2", "BOS", "NYK"), ("nba", "3", "DEN", "HOU"),
                          ("nfl", "401", "SF", "SEA"), ("nhl", "501", "BOS", "TOR"), ("cfb", "601", "OSU", "MICH"),
                          ("cbb", "701", "DUKE", "UNC")):
        game(sp, gid, a, h)
    TENNIS[:] = [{"status": {"type": {"state": "pre", "shortDetail": ""}}, "competitors": [
        {"athlete": {"displayName": "Jannik Sinner"}}, {"athlete": {"displayName": "Carlos Alcaraz"}}]}]

    step(db, "nothing before tip-off", [])
    check(not db.bad, "every Supabase filter is a valid timestamp")

    game("nba", "1", "LAL", "ATL", "in", 20, 24, "5:00 - 1st", 1)
    box("1", [("Luka Doncic", "", BL, ["10", "12", "2", "3"])])
    step(db, "tip-off: start pushes for every-update, key-moments and checklist people (the parlay's first leg), not results-only or off",
         [(ALL, "Your pick is live", "Lakers ML"), (KEY, "Your pick is live", "Luka Doncic Over 30.5"),
          (LIST, "Your pick is live", "2-leg parlay")])
    step(db, "the same state again sends nothing (push_sent dedupe)", [])
    check(not db.bad, "the dedupe query's timestamp is valid (the 11/8 bug: '+00:00' read as ' 00:00')")

    game("nba", "1", "LAL", "ATL", "in", 40, 30, "8:00 - 2nd", 2)
    step(db, "a lead change inside 15 minutes of the last push waits", [])
    db.age(16)
    step(db, "a lead change after 15 minutes: one push, every-update only", [(ALL, "Your pick is ahead", "Score 40-30")])
    db.age(16)
    game("nba", "1", "LAL", "ATL", "in", 50, 52, "Halftime", 2)
    box("1", [("Luka Doncic", "", BL, ["20", "31", "4", "5"])])
    step(db, "halftime: the check, the swing behind, and the points over cashed early",
         [(ALL, "Halftime check", "behind"), (ALL, "Your pick fell behind", "50-52"), (KEY, "Cashed: Luka Doncic", "31 points, line 30.5")])
    game("nba", "1", "LAL", "ATL", "post", 110, 104, "Final", 4)
    step(db, "final: moneyline cashed at the Onyx price", [(ALL, "Cashed: Lakers ML", "Onyx -120")])
    step(db, "a graded pick is never pushed twice", [])

    # results-only person: NFL is already final when first seen; McCaffrey scored, SEA lost by 7
    game("nfl", "401", "SF", "SEA", "post", 27, 20, "Final", 4)
    box("401", [("Christian McCaffrey", "rushing", ["CAR", "YDS", "TD"], ["20", "98", "1"]),
                ("Christian McCaffrey", "receiving", ["REC", "YDS", "TD"], ["4", "30", "0"])])
    step(db, "NFL: TD cashed and spread missed (at the price they took), result only",
         [(RES, "Cashed: Christian McCaffrey", "1 touchdowns"), (RES, "Missed: SEA +3.5", "at -105")])

    # checklist person: start and result only, no swings or halftime
    game("nhl", "501", "BOS", "TOR", "in", 1, 1, "10:00 - 2nd", 2)
    game("nba", "2", "BOS", "NYK", "in", 30, 31, "End of 1st", 2)
    box("2", q1=[30, 31], period=2)
    game("cfb", "601", "OSU", "MICH", "in", 7, 3, "2:00 - 1st", 1)
    game("cbb", "701", "DUKE", "UNC", "in", 10, 12, "12:00 - 1st", 1)
    TENNIS[0]["status"] = {"type": {"state": "in", "shortDetail": "1st set"}}
    step(db, "checklist (start, result): NHL, 1Q total cashed, CFB, CBB and tennis start", [
        (LIST, "Your pick is live", "BOS @ TOR"), (LIST, "Cashed: BOS @ NYK 1Q Over 55.5", "61 in the 1st quarter"),
        (LIST, "Your pick is live", "Ohio State ML"), (LIST, "Your pick is live", "Duke ML"),
        (LIST, "Your pick is live", "Jannik Sinner ML")])
    db.age(16)
    game("nhl", "501", "BOS", "TOR", "post", 3, 2, "Final/OT", 4)
    game("nba", "2", "BOS", "NYK", "post", 99, 101, "Final", 4)
    game("cfb", "601", "OSU", "MICH", "post", 24, 27, "Final", 4)
    game("cbb", "701", "DUKE", "UNC", "post", 80, 70, "Final", 2)
    TENNIS[0]["status"] = {"type": {"state": "post", "shortDetail": "Final"}}
    TENNIS[0]["competitors"][0]["winner"] = True
    step(db, "finals: NHL under 5.5 cashed, CFB missed, CBB cashed, tennis cashed, parlay missed (BOS lost)", [
        (LIST, "Cashed: BOS @ TOR Under 5.5", "5 total"), (LIST, "Missed: Ohio State ML", "24-27"),
        (LIST, "Cashed: Duke ML", "80-70"), (LIST, "Cashed: Jannik Sinner ML", "Onyx -300"),
        (LIST, "Missed: 2-leg parlay", "1 of 2 won")])
    check(not any(r["user_id"] == OFF for r in db.t["push_sent"]), "push level off: nothing sent or logged")
    check(not any(r["item_id"] == "ml-later" for r in db.t["push_sent"]), "a game hours away is not watched yet")
    check(not db.bad, "no Supabase filter was rejected in the whole run")

    print("my_alerts: morning recap")
    ybday = (NOW.astimezone(M.ET) - timedelta(hours=4)).date() - timedelta(days=1)
    y_start = iso(datetime(ybday.year, ybday.month, ybday.day, 23, 0, tzinfo=timezone.utc))
    for i, (r, pr) in enumerate((("W", -110), ("W", 150), ("L", -120))):
        db.t["push_sent"].append({"user_id": LIST, "item_id": f"y{i}", "event": "result", "res": r, "pushed": True,
                                  "data": {"start": y_start, "price": pr}, "sent_at": iso(NOW - timedelta(hours=10))})
    bday = (NOW.astimezone(M.ET) - timedelta(hours=4)).date()
    db.t["saved_picks"].append({"user_id": LIST, "item_id": "today-1", "data": {
        "start": iso(datetime(bday.year, bday.month, bday.day, 23, 30, tzinfo=timezone.utc)), "sport": "nba"}})
    SENT.clear()
    n = M.recap(db, "app", "key", "Key")
    body = SENT[0]["contents"]["en"] if SENT else ""
    check(n == 1 and "Yesterday 2-1, +1.41 units" in body and "Today: 7 saved picks" in body,
          f"recap for the checklist person: {body!r}")
    check(not db.bad, "recap filters are valid timestamps (the 11/8 recap failed here)")
    SENT.clear()
    check(M.recap(db, "app", "key", "Key") == 0 and not SENT, "the recap goes once a day (push_sent recap row)")
    et = lambda h, m: datetime(2026, 11, 9, h + 5, m, tzinfo=timezone.utc)
    check(M.recap_due(et(9, 45)) and M.recap_due(et(12, 59)) and not M.recap_due(et(9, 44)) and not M.recap_due(et(13, 0)),
          "the watcher sends the recap between 9:45 AM and 1 PM ET")

    print("pick_alerts: Onyx Pick alerts")
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        Path("data/picks").mkdir(parents=True)
        rows = [
            {"id": "new", "sport": "nba", "label": "Luka Doncic Over 30.5 points", "price": -115, "chance": 0.62,
             "matchup": "LAL @ ATL", "logged_at": iso(NOW - timedelta(minutes=10)), "start": soon},
            {"id": "mkt", "sport": "nfl", "label": "SF -3.5", "price": -110, "chance": 0.58, "src": "market",
             "matchup": "SF @ SEA", "logged_at": iso(NOW - timedelta(minutes=5)), "start": soon},
            {"id": "old", "sport": "nba", "label": "Old pick", "price": 100, "chance": 0.7, "matchup": "A @ B",
             "logged_at": iso(NOW - timedelta(hours=5)), "start": soon},
            {"id": "started", "sport": "nba", "label": "Started pick", "price": 100, "chance": 0.7, "matchup": "A @ B",
             "logged_at": iso(NOW - timedelta(minutes=10)), "start": live},
            {"id": "graded", "sport": "nba", "label": "Graded", "price": 100, "chance": 0.7, "result": "W",
             "matchup": "A @ B", "logged_at": iso(NOW - timedelta(minutes=10)), "start": soon},
            {"id": "done", "sport": "nba", "label": "Already sent", "price": 100, "chance": 0.7, "matchup": "A @ B",
             "logged_at": iso(NOW - timedelta(minutes=10)), "start": soon}]
        Path("data/picks/ledger.json").write_text(json.dumps(rows))
        Path("data/picks/alerted.json").write_text(json.dumps(["done"]))
        posts = []

        def fake_post(url, json=None, timeout=None, headers=None):
            posts.append(json)
            return Res(200, {"id": "x"} if len(posts) == 1 else {"id": "", "errors": ["All included players are not subscribed"]})
        real = PA.requests.post
        PA.requests.post, PA.SCHEME = fake_post, None
        os.environ.update(ONESIGNAL_APP_ID="app-1", ONESIGNAL_API_KEY="os_v2_app_abc")
        try:
            PA.main()
        finally:
            PA.requests.post = real
            for k in ("ONESIGNAL_APP_ID", "ONESIGNAL_API_KEY"):
                os.environ.pop(k, None)
        msgs = [p["contents"]["en"] for p in posts]
        check(len(posts) == 2, f"only fresh, unstarted, ungraded, unsent picks are pushed ({len(posts)} of 6)")
        check(any(m.startswith("Luka Doncic Over 30.5 points -115 · 62% to hit · NBA LAL @ ATL") for m in msgs),
              "the pick, its Onyx price, its chance and the league")
        check(any("(market line)" in m for m in msgs), "a market-priced pick says so")
        f = posts[0]["filters"] if posts else []
        check({"field": "tag", "key": "picks", "relation": "=", "value": "1"} in f and
              {"field": "tag", "key": "min_conf", "relation": "<", "value": "63"} in f,
              "sent only to Pick alerts subscribers whose X is at or below the chance")
        check(all(p["headings"]["en"] == "New Onyx Pick" and p["url"].endswith("picks.html") for p in posts), "title and link")
        al = set(json.loads(Path("data/picks/alerted.json").read_text()))
        check({"new", "mkt", "done"} <= al and not al & {"old", "started", "graded"}, "each pick is marked sent once")
        check(json.loads(Path("data/push.json").read_text()) == {"app_id": "app-1"}, "data/push.json carries the app id")
        posts.clear()
        PA.requests.post = fake_post
        os.environ.update(ONESIGNAL_APP_ID="app-1", ONESIGNAL_API_KEY="os_v2_app_abc")
        try:
            PA.main()
        finally:
            PA.requests.post = real
            for k in ("ONESIGNAL_APP_ID", "ONESIGNAL_API_KEY"):
                os.environ.pop(k, None)
        check(not posts, "a second build sends nothing again")
        os.chdir(cwd)
    check(PA.clean_key(" os_v2_app_ab\n cd ")[0] == "os_v2_app_abcd" and PA.clean_key("Basic abc123")[1] == "Basic",
          "the OneSignal key is read through pasted whitespace")

    print()
    print("FAIL: %d" % len(FAIL) if FAIL else "PASS")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
