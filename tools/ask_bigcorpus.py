#!/usr/bin/env python3
"""
ask_bigcorpus.py - thousands of Ask Onyx requests with the reading each one must get (dev only).

Builds tools/ask_big.json for tools/verify_ask.js --corpus=tools/ask_big.json. Requests are
composed from slots the way people actually type: a count and a ticket type, a sport, a market,
over/under, a price rule, a day, a sort, real players and teams from today's boards, filler
("yo", "gimme", "pls"), shuffled word order, mixed case and typos. Each slot carries the field it
must produce, so every request has an exact expectation. Seeded: the same file every run for the
same boards.

  python3 tools/ask_bigcorpus.py [n=3000] [seed=11]
"""
import json, os, random, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int((sys.argv[1:] or ["3000"])[0])
SEED = int((sys.argv[2:] or ["11"])[0])
NEW = "--new" in sys.argv   # add the 11/2 kinds (TD favorites, payout targets, misspellings, last names, two markets, live)
R = random.Random(SEED)

SPORT = {
    "nba": ["nba", "NBA", "basketball", "hoops"],
    "nfl": ["nfl", "NFL", "pro football"],
    "nhl": ["nhl", "NHL", "hockey"],
    "cfb": ["college football", "ncaaf", "cfb"],
    "tennis": ["tennis"],
}
MKT = {
    "nba": {"pts": ["points", "pts", "point"], "reb": ["rebounds", "boards", "rebs"], "ast": ["assists", "dimes", "ast"],
            "q1_total": ["1st quarter totals", "first quarter totals", "1q totals"]},
    "nfl": {"rec": ["receptions", "catches"], "rec_yds": ["receiving yards", "rec yards"], "rush_yds": ["rushing yards", "rush yards"],
            "pass_yds": ["passing yards", "pass yards"], "anytime_td": ["anytime td", "td scorers", "touchdown scorers", "anytime touchdown"],
            "pass_att": ["pass attempts"], "pass_td": ["passing tds", "passing touchdowns"]},
    "cfb": {"rush_yds": ["rushing yards"], "rec_yds": ["receiving yards"], "pass_yds": ["passing yards"], "anytime_td": ["td scorers", "anytime td"]},
    "nhl": {},
    "tennis": {},
}
LINES = {"spread": ["spreads", "against the spread", "ats"], "total": ["totals"], "ml": ["moneylines", "moneyline"]}
LINE_SPORTS = {"spread": ["nba", "nfl", "cfb", "nhl"], "total": ["nba", "nfl", "cfb", "nhl", "tennis"], "ml": ["nba", "nfl", "cfb", "nhl", "tennis"]}
SIDE = {"over": ["overs", "over"], "under": ["unders", "under"]}
PRICE = [  # (phrase, expected fields)
    ("plus money", {"min_price": 100}), ("minimum odds -200", {"min_price": -200}), ("minimum odds -150", {"min_price": -150}),
    ("no worse than -150", {"min_price": -150}), ("nothing worse than -200", {"min_price": -200}), ("-110 or better", {"min_price": -110}),
    ("no odds longer than -150", {"max_price": -150}), ("-150 or shorter", {"max_price": -150}), ("+150 or longer", {"min_price": 150}),
]
CONF = [("60% or better", 0.6), ("70% or better", 0.7), ("65%+", 0.65)]
FILL_PRE = ["", "", "", "yo ", "gimme ", "give me ", "can you build ", "i want ", "show me ", "need ", "build me ", "whats a good ", "hit me with "]
FILL_POST = ["", "", "", " pls", " please", "?", " tonight", " today", " for tonight", " !!"]
NUMW = {2: ["2", "two"], 3: ["3", "three"], 4: ["4", "four"], 5: ["5", "five"], 6: ["6", "six"]}
NICK = {"nfl": {"chiefs": "KC", "broncos": "DEN", "eagles": "PHI", "commanders": "WSH", "bears": "CHI", "seahawks": "SEA", "bills": "BUF",
                "cowboys": "DAL", "packers": "GB", "lions": "DET", "ravens": "BAL", "49ers": "SF", "niners": "SF", "dolphins": "MIA", "jets": "NYJ"},
        "nba": {"lakers": "LAL", "celtics": "BOS", "knicks": "NY", "warriors": "GS", "nuggets": "DEN", "bucks": "MIL", "heat": "MIA",
                "pacers": "IND", "nets": "BKN", "magic": "ORL", "clippers": "LAC", "raptors": "TOR", "thunder": "OKC", "suns": "PHX"},
        "nhl": {"oilers": "EDM", "rangers": "NYR", "bruins": "BOS", "maple leafs": "TOR", "flyers": "PHI", "capitals": "WSH",
                "avalanche": "COL", "lightning": "TB", "senators": "OTT", "ducks": "ANA"}}
TYPO = {"rebounds": "rebouds", "receptions": "recepitons", "receiving": "recieving", "assists": "asists", "passing": "pasing",
        "rushing": "rusing", "touchdown": "touchdwn", "parlay": "parly", "points": "pionts", "basketball": "basketbal", "hockey": "hocky"}


def typo(s):
    for a, b in TYPO.items():
        if a in s and R.random() < 0.5:
            return s.replace(a, b, 1), True
    return s, False


def players():
    out = []
    for sp, mk in (("nba", ("pts", "reb", "ast")), ("nfl", ("rec", "rec_yds", "rush_yds", "pass_yds"))):
        try:
            B = json.load(open(os.path.join(ROOT, "data", sp, "board.json"))).get("plays") or []
        except Exception:
            continue
        seen = set()
        for p in B:
            if p.get("kind") == "prop" and p.get("mkt") in mk and p.get("name") and (p["name"], p["mkt"]) not in seen:
                seen.add((p["name"], p["mkt"]))
                out.append((sp, p["name"], p["mkt"]))
    return out


def market_word(sp, m):
    if m in LINES:
        return R.choice(LINES[m])
    return R.choice(MKT[sp][m])


def onelett(w):
    """the name one letter off, the way people misspell it: a dropped, doubled or swapped letter"""
    i = R.randrange(1, len(w) - 1)
    k = R.choice(["drop", "double", "swap"])
    if k == "drop":
        return w[:i] + w[i + 1:]
    if k == "double":
        return w[:i] + w[i] + w[i:]
    return w[:i] + w[i + 1] + w[i] + w[i + 2:]


def compose_new():
    """11/2 kinds: TD favorites, payout targets, misspelled and last-name players, two markets, live"""
    kind = R.choice(["td", "td", "target", "typo", "last", "two", "live"])
    e = {}
    if kind == "td":
        ph, srt = R.choice([("favorite td scorers", "rec"), ("your favorite picks to score", "rec"), ("who do you like to score a td", "rec"),
                            ("most likely td scorers", "conf"), ("safest anytime td", "conf"), ("best value td scorers", "edge"),
                            ("anytime td longshots", "price")])
        sp = R.choice(["nfl", "nfl", None])
        q = ph + (" " + R.choice(SPORT[sp]) if sp else "")
        e.update(markets=["anytime_td"], sort=srt)
        if sp:
            e["sports"] = [sp]
        return q, e
    if kind == "target":
        tp = R.choice([300, 500, 1000, 2000])
        sp = R.choice(["nba", "nfl"])
        q = R.choice([f"+{tp} parlay {R.choice(SPORT[sp])}", f"build me a parlay that pays +{tp} {R.choice(SPORT[sp])}",
                      f"{R.choice(SPORT[sp])} parlay to win {tp // 100}x"])
        e.update(intent="parlay", sports=[sp])
        if "x" not in q:
            e["target_price"] = tp
        return q, e
    P = players()
    if kind in ("typo", "last") and P:
        sp, name, m = R.choice(P)
        parts = name.split()
        if kind == "typo":
            if len(parts[-1]) < 6:
                return None
            nm = " ".join(parts[:-1] + [onelett(parts[-1].lower())])
        else:
            core = [w for w in parts if w.lower().strip(".") not in ("jr", "sr", "ii", "iii", "iv")]
            last = core[-1].lower()
            # only last names one player on the boards has, so there is one right answer
            if len(last) < 5 or sum(1 for _, n, _ in P if last in n.lower().split() and n != name):
                return None
            nm = last
        q = f"{nm} {market_word(sp, m)}"
        e.update(player=name, markets=[m])
        return q, e
    if kind == "two":
        sp = R.choice(["nba", "nfl"])
        a, b = R.sample(list(MKT[sp]) if sp == "nfl" else ["pts", "reb", "ast"], 2)
        if "anytime_td" in (a, b) or "q1_total" in (a, b):
            return None
        q = f"{R.choice(SPORT[sp])} {market_word(sp, a)} and {market_word(sp, b)} {R.choice(['overs', 'unders'])}"
        e.update(sports=[sp], markets=sorted([a, b]), side="over" if "overs" in q else "under")
        return q, e
    if kind == "live":
        sp = R.choice(["nba", "nfl", "nhl"])
        q = R.choice([f"live {R.choice(SPORT[sp])} bets", f"best live bets {R.choice(SPORT[sp])}", f"in game {R.choice(SPORT[sp])} value"])
        e.update(sports=[sp])
        return q, e
    return None


def compose():
    if NEW and R.random() < 0.45:
        return compose_new()
    kind = R.choices(["list", "parlay", "parlay", "rr", "player", "team", "teams", "conf", "sgp"], k=1)[0]
    e, words = {}, []
    sp = R.choice(["nba", "nfl", "nhl", "cfb", "tennis"])
    mkts = list(MKT[sp]) + [m for m in LINES if sp in LINE_SPORTS[m]]
    m = R.choice(mkts)
    if kind == "player":
        P = players()
        if not P:
            return None
        sp, name, m = R.choice(P)
        side = R.choice([None, "over", "under"])
        tmpl = R.choice(["{n} {m}", "{n} {s} {m}", "is {n} going {s1} his {m}", "{n} {m} {s}", "what about {n} {m}"])
        s1 = side or "over"
        q = tmpl.format(n=name, m=market_word(sp, m), s=R.choice(SIDE[side]) if side else "", s1=s1)
        e.update(player=name, markets=[m])
        if "{s1}" in tmpl:
            e["side"] = s1
        elif "{s}" in tmpl and side:
            e["side"] = side
        return " ".join(q.split()), e
    if kind in ("team", "teams", "sgp"):
        sp = R.choice(["nfl", "nba", "nhl"])
        nicks = list(NICK[sp])
        if kind == "teams":
            T = R.sample(nicks, R.choice([2, 3, 4]))
            n = R.choice([2, 3, 4])
            joined = ", ".join(T[:-1]) + R.choice([" or ", " and ", ", "]) + T[-1]
            q = R.choice([f"{n} leg parlay from the {joined}", f"{n} leg parlay {joined}", f"give me a {n} legger from {joined}"])
            e.update(intent="parlay", count=n, teams=sorted({NICK[sp][t] for t in T}), sports=[sp])
            return q, e
        t = R.choice(nicks)
        if kind == "sgp":
            q = R.choice([f"{t} sgp", f"same game parlay {t}", f"{t} same-game parlay", f"build a {t} sgp"])
            e.update(intent="sgp", team=NICK[sp][t])
            return q, e
        mm = R.choice([x for x in list(MKT[sp]) + ["spread", "total", "ml"] if x not in ("q1_total",)] or ["ml"])
        q = f"{t} {market_word(sp, mm)}"
        e.update(team=NICK[sp][t], markets=[mm])
        return q, e
    # list / parlay / rr / conf: compose from slots, shuffled
    parts = []
    if kind == "parlay":
        n = R.choice([2, 3, 4, 5, 6])
        nw = R.choice(NUMW[n])
        parts.append(R.choice([f"{nw} leg parlay", f"{nw}-leg parlay", f"{nw} legger", f"parlay of {nw}"]))
        e.update(intent="parlay", count=n)
    elif kind == "rr":
        n = R.choice([3, 4, 5])
        parts.append(f"round robin {n} picks by 2s")
        e.update(intent="rr")
    elif kind == "conf":
        ph, c = R.choice(CONF)
        parts.append(ph)
        e["min_conf"] = c
    else:
        n = R.choice([None, 3, 5])
        parts.append(R.choice(["best", "top", "safest"]) + (f" {n}" if n else ""))
        e["intent"] = "list"
    parts.append(R.choice(SPORT[sp]))
    e["sports"] = [sp]
    if m:
        parts.append(market_word(sp, m))
        e["markets"] = [m]
    if (m in MKT.get(sp, {}) or m == "total") and m != "anytime_td" and R.random() < 0.4:
        side = R.choice(["over", "under"])
        parts.append(R.choice(SIDE[side]))
        e["side"] = side
    if R.random() < 0.35 and kind != "conf" and m not in ("anytime_td",):
        ph, f = R.choice(PRICE)
        parts.append(ph)
        e.update(f)
    head = parts[0]
    rest = parts[1:]
    if R.random() < 0.3:
        R.shuffle(rest)
    q = " ".join([head] + rest) if R.random() < 0.7 else " ".join(rest + [head])
    return q, e


def main():
    out, seen = [], set()
    tries = 0
    while len(out) < N and tries < N * 20:
        tries += 1
        r = compose()
        if not r:
            continue
        q, e = r
        q = R.choice(FILL_PRE) + q + R.choice(FILL_POST)
        if R.random() < 0.08:
            q, _ = typo(q)
        if R.random() < 0.15:
            q = q.upper() if R.random() < 0.3 else q.capitalize()
        q = " ".join(q.split())
        if q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append({"q": q, "e": e})
    dest = os.environ.get("ASK_OUT") or os.path.join(ROOT, "tools", "ask_big.json")
    json.dump(out, open(dest, "w"), ensure_ascii=False)
    print(f"wrote {dest}: {len(out)} requests")


if __name__ == "__main__":
    main()
