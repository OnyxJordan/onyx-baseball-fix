#!/usr/bin/env python3
"""
ask_taxonomy.py - every kind of thing a bettor asks the search for, as test questions (dev only).

Where ask_bigcorpus.py mixes a few templates, this builds requests from a map of what bettors want:
  bet type       a straight list, a parlay of N (leg / legger / team / pick / fold / acca / multi /
                 double / treble), a same-game parlay, a round robin, a payout target (+500, 10 to 1,
                 "turn $10 into $100", "$20 to win $100", 3x)
  what to see    the safest, our recommendations, the best value, the longshots, the top scorers
  market         every stat and game line we price, in bettor words and slang, per sport
  side           over / under in its many wordings
  price          plus money, even money, -150 or better, nothing shorter than -200, between two prices,
                 favorites, underdogs
  confidence     60% or better, at least 70 percent
  day            tonight, today, tomorrow, this weekend, a weekday
  who            a team (nickname, abbreviation), a matchup (X vs Y, KC @ DEN), several teams, a player
                 (full name, last name), and who they do NOT want (no X, without X, except the X)
  not priced     teasers, futures and awards, golf, MLB, NHL player props, threes, double-doubles,
                 combined stats, team totals, quarter spreads, later quarters, hedging, exact scores,
                 promos, sports we do not cover: these must say so and offer what we do price
  college (11/2) college basketball and football in every wording; every Division I school by full name,
                 school, nickname, alias and abbreviation, with and without a sport word; mascots several schools
                 share (must ask which); pro teams by full name, nickname and city (never a college team);
                 conferences; depth questions (starters, minutes, pace) on schools and players; college
                 basketball props (not on our board: must say so); Onyx Picks
and wraps each in the ways people type: questions, commands, slang, filler, caps, typos.
Every request carries the exact reading it must get (tools/verify_ask.js grades it).

  python3 tools/ask_taxonomy.py [n=20000] [seed=1] [out=tools/ask_taxonomy.json]
"""
import json, os, random, re, sys, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int((sys.argv[1:] or ["20000"])[0])
R = random.Random(int((sys.argv[2:] or ["1"])[0]))
OUT = (sys.argv[3:] or [os.path.join(ROOT, "tools", "ask_taxonomy.json")])[0]

SPORT = {"nba": ["nba", "NBA", "basketball", "hoops"], "nfl": ["nfl", "NFL", "pro football"],
         "nhl": ["nhl", "NHL", "hockey"], "cfb": ["college football", "ncaaf", "cfb", "NCAAF", "ncaa football", "fbs", "CFB"],
         "cbb": ["college basketball", "ncaab", "cbb", "NCAAB", "college hoops", "ncaa basketball", "men's college basketball", "ncaam",
                 "mens college hoops", "d1 basketball", "college bball", "CBB"],
         "tennis": ["tennis", "atp", "wta"]}
# markets per sport, in the words bettors use
MKT = {
    "nba": {"pts": ["points", "pts", "points props", "scoring"], "reb": ["rebounds", "boards", "rebs"], "ast": ["assists", "dimes", "ast"],
            "q1_total": ["1st quarter totals", "first quarter totals", "1q totals"], "h1_total": ["1st half totals", "first half totals"],
            "first_basket": ["first basket", "first basket scorer"]},
    "nfl": {"rec": ["receptions", "catches"], "rec_yds": ["receiving yards", "rec yards"], "rush_yds": ["rushing yards", "rush yards"],
            "pass_yds": ["passing yards", "pass yards"], "anytime_td": ["anytime td", "td scorers", "anytime touchdown", "touchdown scorers"],
            "pass_td": ["passing tds", "passing touchdowns"], "pass_att": ["pass attempts"], "first_td": ["first td scorer", "first touchdown"]},
    "cfb": {"rush_yds": ["rushing yards"], "rec_yds": ["receiving yards"], "pass_yds": ["passing yards"]},
    "cbb": {},   # college basketball: game lines only on our board (player props are said to be not covered)
    "nhl": {}, "tennis": {},
}
LINES = {"spread": ["spreads", "against the spread", "ats", "covers"], "total": ["game totals", "totals", "over unders"],
         "ml": ["moneylines", "moneyline", "ml"]}
LINE_SP = {"spread": ["nba", "nfl", "cfb", "cbb", "nhl"], "total": ["nba", "nfl", "cfb", "cbb", "nhl", "tennis"], "ml": ["nba", "nfl", "cfb", "cbb", "nhl", "tennis"]}
SIDEW = {"over": ["overs", "over", "the over", "to go over"], "under": ["unders", "under", "the under", "to stay under"]}
NUMW = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}
TEAMS = {"nfl": {"chiefs": "KC", "broncos": "DEN", "eagles": "PHI", "commanders": "WSH", "bears": "CHI", "seahawks": "SEA", "bills": "BUF",
                 "cowboys": "DAL", "packers": "GB", "lions": "DET", "ravens": "BAL", "niners": "SF", "dolphins": "MIA", "patriots": "NE"},
         "nba": {"lakers": "LAL", "celtics": "BOS", "knicks": "NY", "warriors": "GS", "nuggets": "DEN", "bucks": "MIL", "heat": "MIA",
                 "pacers": "IND", "nets": "BKN", "magic": "ORL", "clippers": "LAC", "raptors": "TOR", "thunder": "OKC", "suns": "PHX"},
         "nhl": {"oilers": "EDM", "rangers": "NYR", "bruins": "BOS", "maple leafs": "TOR", "flyers": "PHI", "capitals": "WSH",
                 "avalanche": "COL", "lightning": "TB", "senators": "OTT", "ducks": "ANA"}}
SORTS = {"conf": ["safest", "most likely", "locks", "highest hit rate", "surest"],
         "rec": ["best bets", "your favorite picks", "what do you like", "top picks", "your picks"],
         "edge": ["best value", "+ev", "biggest edge", "mispriced", "where the model beats the line"],
         "price": ["longshots", "biggest payouts", "lottery tickets"]}
PRICE = [("plus money", {"min_price": 100}), ("plus odds", {"min_price": 100}), ("-150 or better", {"min_price": -150}),
         ("nothing shorter than -200", {"min_price": -200}), ("no worse than -150", {"min_price": -150}),
         ("minimum odds -120", {"min_price": -120}), ("even money", {"min_price": -125, "max_price": 125}),
         ("between -150 and +150", {"min_price": -150, "max_price": 150}), ("+200 or longer", {"min_price": 200}),
         ("max -200", {"max_price": -200}), ("-150 or shorter", {"max_price": -150})]
CONF = [("60% or better", 0.6), ("at least 70%", 0.7), ("65 percent or better", 0.65), ("70%+", 0.7)]
WHEN = [("tonight", "today"), ("today", "today"), ("tomorrow", "tomorrow"), ("this weekend", "weekend"), ("sunday", "sunday"),
        ("monday", "monday"), ("thursday", "thursday"), ("saturday", "saturday")]
NOTPRICED = [
    "6 point teaser nfl", "teaser legs", "super bowl futures", "mvp odds", "who wins the finals", "nba championship odds", "rookie of the year odds",
    "heisman odds", "win totals", "will the chiefs make the playoffs", "golf picks", "pga top 10 finish", "masters odds", "mlb home runs",
    "baseball strikeouts props", "world series odds", "shots on goal", "nhl goal scorers", "anytime goal scorer", "goalie saves", "jokic threes",
    "3 pointers made", "made threes props", "double double bets", "triple double", "pra overs", "points + rebounds", "pts + ast props",
    "rebounds and assists combo", "team total over", "chiefs team total", "1st quarter spread", "first half spread", "2nd half total",
    "4th quarter bets", "3rd quarter over", "hedge my parlay", "should i cash out", "correct score", "exact score nfl", "tennis set betting",
    "odds boosts", "any promos", "parlay insurance", "soccer picks", "premier league", "ufc picks", "boxing odds", "f1 bets", "nascar",
    "wnba props", "esports", "college basketball player props", "ncaab points props", "college hoops rebounds", "cbb assists props",
    "college basketball 1st half totals", "who wins the national title", "big sky spreads", "swac totals"]
if __import__("datetime").date.today().month != 3:   # the NCAA tournament, out of season
    NOTPRICED += ["march madness", "march madness picks", "final four odds", "ncaa tournament bets", "sweet 16 picks", "bracket picks"]
PRE = ["", "", "", "", "yo ", "gimme ", "give me ", "can you give me ", "i want ", "show me ", "need ", "hit me with ", "lemme get ",
       "whats a good ", "what are the ", "i'm looking for ", "any ", "got any ", "looking for ", "find me ", "build me ", "can you build ",
       "help me find ", "what's the play on ", "who are the "]
POST = ["", "", "", "", "?", " pls", " please", " tonight", " for tonight", " asap", " !!", " rn", " fam", " bro", " 🔥", " 💰"]
TYPO = {"parlay": "parly", "rebounds": "rebouds", "receptions": "recepitons", "receiving": "recieving", "assists": "asists",
        "passing": "pasing", "rushing": "rusing", "points": "pionts", "basketball": "basketbal", "hockey": "hocky"}


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


PL = None


def mword(sp, m):
    return R.choice(LINES[m]) if m in LINES else R.choice(MKT[sp][m])


def bet_type(sp):
    """(phrase, expected) for the kind of bet"""
    k = R.choices(["list", "listn", "parlay", "parlay", "sgp", "rr", "target"], k=1)[0]
    if k == "list":
        return R.choice(["", "picks", "plays", "bets", "straight bets"]), {"intent": "list"}
    if k == "listn":
        n = R.choice([3, 5, 10])
        return R.choice([f"top {n}", f"{n} picks", f"{n} plays", f"{n} bets"]), {"intent": "list", "count": n}
    if k == "parlay":
        n = R.choice([2, 3, 4, 5, 6])
        ph = R.choice([f"{n} leg parlay", f"{n}-leg parlay", f"{n} legger", f"{n} team parlay", f"{n} pick parlay", f"parlay of {n}",
                       f"{NUMW[n]} leg parlay", f"{n} leg acca", f"{n} leg multi", f"{n} fold"])
        return ph, {"intent": "parlay", "count": n}
    if k == "sgp":
        return R.choice(["sgp", "same game parlay", "same-game parlay"]), {"intent": "sgp"}
    if k == "rr":
        n, by = R.choice([(3, 2), (4, 2), (5, 3), (4, 3)])
        return f"round robin {n} picks by {by}s", {"intent": "rr"}
    tp, ph = R.choice([(500, "+500 parlay"), (1000, "parlay that pays +1000"), (1000, "parlay that pays 10 to 1"), (300, "a +300 ticket"),
                       (900, "parlay to turn $10 into $100"), (400, "parlay $25 to win $100"), (200, "parlay to win 3x")])
    return ph, {"intent": "parlay", "target_price": tp}


def compose():
    global PL
    if PL is None:
        PL = players()
    cat = R.choices(["build", "build", "build", "build", "player", "team", "matchup", "exclude", "notpriced", "favdog",
                     "college", "college", "college", "college"], k=1)[0]
    if cat == "college":
        return college()
    e = {}
    if cat == "notpriced":
        return "notpriced", R.choice(NOTPRICED), {"unsupported": True}
    if cat == "player" and PL:
        sp, name, m = R.choice(PL)
        nm = name if R.random() < 0.7 else name.split()[-1].lower()
        core = [w for w in name.split() if w.lower().strip(".") not in ("jr", "sr", "ii", "iii", "iv")]
        if nm != name:
            nm = core[-1].lower()
        if nm != name and sum(1 for _, n2, _ in PL if nm in n2.lower().split() and n2 != name):
            nm = name
        side = R.choice([None, "over", "under"])
        q = R.choice([f"{nm} {mword(sp, m)}", f"{nm} {R.choice(SIDEW[side])} {mword(sp, m)}" if side else f"{nm} {mword(sp, m)} line",
                      f"should i bet {nm} {mword(sp, m)}", f"is {nm} a good bet for {mword(sp, m)}", f"what do you think about {nm} {mword(sp, m)}",
                      f"{nm} {mword(sp, m)} tonight"])
        e.update(player=name, markets=[m])
        if side and R.choice(SIDEW[side]) and any(w in q for w in ("over", "under")):
            e["side"] = side
        return "player", q, e
    if cat in ("team", "matchup", "exclude"):
        sp = R.choice(["nfl", "nba", "nhl"])
        nicks = list(TEAMS[sp])
        if cat == "team":
            t = R.choice(nicks)
            mm = R.choice(["spread", "ml", "total"] + ([] if sp == "nhl" else ["props"]))
            if mm == "props":
                return "team", R.choice([f"{t} props", f"{t} player props", f"best {t} props"]), {"team": TEAMS[sp][t], "props_only": True}
            return "team", f"{t} {mword(sp, mm)}", {"team": TEAMS[sp][t], "markets": [mm]}
        if cat == "matchup":
            a, b = R.sample(nicks, 2)
            A, Bb = TEAMS[sp][a], TEAMS[sp][b]
            q = R.choice([f"{a} vs {b}", f"{a} {b} best bets", f"who wins {a} {b}", f"{A} @ {Bb} picks", f"{A} vs {Bb}", f"{a} at {b} props",
                          f"whats the line on {a} {b}"])
            return "matchup", q, {"teams": sorted([A, Bb])}
        # exclusions
        if R.random() < 0.5 and PL:
            sp2, name, m = R.choice([x for x in PL if x[0] == R.choice(["nba", "nfl"])] or PL)
            n = R.choice([2, 3, 4])
            word = R.choice(["no", "without", "except", "other than", "skip"])
            q = R.choice([f"{n} leg {R.choice(SPORT[sp2])} parlay {word} {name}", f"{R.choice(SPORT[sp2])} props {word} {name}",
                          f"best {R.choice(SPORT[sp2])} bets {word} {name}"])
            exp = {"exclude": [name], "sports": [sp2]}
            if "parlay" in q:
                exp.update(intent="parlay", count=n)
            return "exclude", q, exp
        t = R.choice(nicks)
        word = R.choice(["no", "without", "except the", "other than the", "nothing from the"])
        q = R.choice([f"best {R.choice(SPORT[sp])} bets {word} {t}", f"3 leg {R.choice(SPORT[sp])} parlay {word} {t}"])
        exp = {"exclude": [TEAMS[sp][t]], "sports": [sp]}
        if "parlay" in q:
            exp.update(intent="parlay", count=3)
        return "exclude", q, exp
    if cat == "favdog":
        sp = R.choice(["nba", "nfl", "nhl", "cfb", "cbb"])
        if R.random() < 0.5:
            return "favdog", R.choice([f"{R.choice(SPORT[sp])} favorites to win", f"{R.choice(SPORT[sp])} favorites moneyline", f"chalk {R.choice(SPORT[sp])}"]), \
                {"sports": [sp], "markets": ["ml"], "max_price": -101}
        return "favdog", R.choice([f"{R.choice(SPORT[sp])} underdogs", f"{R.choice(SPORT[sp])} dogs to win", f"best {R.choice(SPORT[sp])} dogs"]), \
            {"sports": [sp], "markets": ["ml"], "min_price": 100}
    # build: a bet type + sport + optional market, side, what-to-see, price, confidence, day
    sp = R.choice(["nba", "nfl", "nhl", "cfb", "cbb", "tennis"])
    bt, e = bet_type(sp)
    parts = [bt] if bt else []
    parts.append(R.choice(SPORT[sp]))
    e["sports"] = [sp]
    mk = list(MKT[sp]) + [m for m in LINES if sp in LINE_SP[m]]
    m = R.choice(mk) if R.random() < 0.75 else None
    if m:
        parts.append(mword(sp, m))
        e["markets"] = [m]
        if m not in ("anytime_td", "first_td", "first_basket", "ml", "spread") and R.random() < 0.4:
            side = R.choice(["over", "under"])
            parts.append(R.choice(["overs", "unders"]) if side == "over" and False else ("overs" if side == "over" else "unders"))
            e["side"] = side
    if e.get("intent") in ("list", None) and R.random() < 0.35 and not e.get("count"):
        so = R.choice(list(SORTS))
        if not (so == "price" and m in ("ml", "spread")):
            parts.insert(0, R.choice(SORTS[so]))
            e["sort"] = so
    if R.random() < 0.3 and "target_price" not in e and e.get("sort") != "price" and m not in ("anytime_td", "first_td", "first_basket"):
        ph, f = R.choice(PRICE)
        parts.append(ph)
        e.update(f)
    elif R.random() < 0.15 and "target_price" not in e and e.get("sort") != "price":
        ph, c = R.choice(CONF)
        parts.append(ph)
        e["min_conf"] = c
    if R.random() < 0.35:
        ph, w = R.choice(WHEN)
        parts.append(ph)
        e["when"] = w
    head, rest = parts[0], parts[1:]
    if R.random() < 0.25:
        R.shuffle(rest)
    return "build", " ".join([head] + rest), e


# ── college (11/2): every Division I school, the names college and pro teams share, conferences,
# depth questions, Onyx Picks. The school directory, pro teams, nicknames and aliases are read out of
# ask.js itself, so a request is only generated with the reading the page's own tables must give.
def _js(name, kind="str"):
    src = open(os.path.join(ROOT, "ask.js"), encoding="utf8").read()
    if kind == "str":
        return re.search(r"var %s = '((?:[^'\\]|\\.)*)';" % name, src).group(1).replace("\\'", "'")
    if kind == "obj":
        body = re.search(r"var %s = \{(.*?)\};" % name, src, re.S).group(1)
        return {(a or b): c for a, b, c in re.findall(r"(?:'([^']+)'|([\w$]+)):\s*'([^']+)'", body)}
    return re.search(r"var %s = /\^\((.*?)\)\$/;" % name, src).group(1).split("|")


def cnorm(x):
    x = unicodedata.normalize("NFD", str(x).lower())
    x = "".join(ch for ch in x if unicodedata.category(ch) != "Mn")
    x = re.sub(r"\ba ?& ?t\b", "aandt", re.sub(r"[’'`.]", "", x)).replace("&", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9-]+", " ", x)).strip()


COLD = None


def coldata():
    """schools, the keys that name exactly one of them, shared mascots, pro places and nicknames, player-name words"""
    global COLD
    if COLD:
        return COLD
    S = []
    for r in _js("D1").split(";"):
        cbb, cfb, loc, mascot = r.split("|")
        S.append({"cbb": cbb, "cfb": cfb, "loc": loc, "mascot": mascot, "full": loc + " " + mascot})
    pro = [dict(zip(("sport", "abbr", "place", "mascot"), r.split("|"))) for r in _js("PRO").split(";")]
    nick = _js("NICK", "obj")
    alias = _js("CALIAS", "obj")
    common = set(_js("COMMONW", "re"))
    places = {cnorm(p["place"]) for p in pro} | {"la", "los angeles", "tampa", "vegas", "las vegas", "golden st"}
    keys = {}
    for s in S:
        l = cnorm(s["loc"])
        for k, kind in ((cnorm(s["full"]), "full"), (l, "loc"), (cnorm(s["mascot"]), "mascot")):
            keys.setdefault(k.replace("-", " "), []).append((s["cbb"], kind))
    for k, ab in alias.items():
        keys.setdefault(cnorm(k), []).append((ab, "alias"))
    keys.setdefault("miami", []).append(("M-OH", "loc"))
    pw = set()
    try:
        for r in json.load(open(os.path.join(ROOT, "data", "nba", "prior.json"))).values():
            if isinstance(r, dict):
                pw |= {w for w in cnorm(r.get("n", "")).replace("-", " ").split() if len(w) >= 4}
    except Exception:
        pass
    for sp in ("nba", "nfl", "cfb", "cbb", "nhl"):
        try:
            for p in json.load(open(os.path.join(ROOT, "data", sp, "board.json"))).get("plays") or []:
                if p.get("kind") == "prop" and p.get("name"):
                    pw |= {w for w in cnorm(p["name"]).replace("-", " ").split() if len(w) >= 4}
        except Exception:
            pass
    nickset = set(nick) | {k[:-1] for k in nick if k.endswith("s")} | {k + "s" for k in nick}
    byab = {s["cbb"]: s for s in S}
    # a key names one school, safely, alone: no other school, no pro place or nickname, no everyday word, no player's name
    def solo(k):
        e = {ab for ab, _ in keys.get(k, [])}
        return len(e) == 1 and "aandt" not in k and k not in places and k not in nickset and k not in common and len(k) >= 4 and (" " in k or k not in pw)
    names = {}
    for k, ents in keys.items():
        if solo(k) and not any(kind == "mascot" for _, kind in ents):
            names.setdefault(ents[0][0], []).append(k)
        elif solo(k) and all(kind == "mascot" for _, kind in ents):
            names.setdefault(ents[0][0], []).append(k)
    shared = {k: sorted({ab for ab, _ in ents}) for k, ents in keys.items()
              if len({ab for ab, _ in ents}) > 1 and all(kind == "mascot" for _, kind in ents) and k not in nickset and k not in common
              and k not in pw and k not in alias and k not in places}
    COLD = {"S": S, "byab": byab, "names": names, "shared": shared, "pro": pro, "nick": nick, "places": places, "keys": keys,
            "dup": {"jets", "kings", "panthers"}}
    return COLD


CONFS = [("SEC", ["SEC", "sec", "the SEC"], True), ("Big Ten", ["big ten", "Big 10", "b1g"], True), ("Big 12", ["big 12", "Big XII", "big twelve"], True),
         ("ACC", ["ACC", "acc"], True), ("Big East", ["big east", "Big East"], False), ("Pac-12", ["pac-12", "pac 12", "Pac-12"], True),
         ("Mountain West", ["mountain west", "MWC"], True), ("WCC", ["WCC", "west coast conference"], False), ("A-10", ["a-10", "atlantic 10", "A10"], False),
         ("American", ["AAC", "american athletic"], True), ("MAC", ["the MAC", "mac games", "mid-american"], True), ("Sun Belt", ["sun belt", "sunbelt"], True),
         ("C-USA", ["c-usa", "conference usa", "CUSA"], True), ("Ivy League", ["ivy league", "Ivy"], False), ("Missouri Valley", ["missouri valley", "MVC"], False)]
GL = {"spread": ["spread", "spreads", "ats", "to cover", "against the spread"], "total": ["total", "totals", "over under", "o/u"], "ml": ["moneyline", "ml", "to win", "moneylines"]}
COLW = {"cbb": ["college basketball", "basketball", "hoops", "ncaab", "cbb", "college hoops", "men's basketball"], "cfb": ["college football", "football", "ncaaf", "cfb"]}


def college():
    D = coldata()
    k = R.choices(["school", "school", "school", "school", "ambig", "pro", "pro", "conf", "conf", "depth", "props", "picks", "exclude"], k=1)[0]
    m = R.choice(list(GL))
    mw = R.choice(GL[m])
    mq = "" if R.random() < 0.15 else mw
    e = {"markets": [m]} if mq else {}
    if k in ("school", "exclude"):
        ab = R.choice(list(D["names"]))
        s = D["byab"][ab]
        nm = R.choice(D["names"][ab] + [s["full"]] * 2)
        sp = None
        if R.random() < 0.35:
            sp = R.choice(["cbb", "cfb"] if s["cfb"] else ["cbb"])
        spw = R.choice(COLW[sp]) if sp else ""
        exp_sp = [sp] if sp else (["cfb", "cbb"] if s["cfb"] else ["cbb"])
        if k == "exclude":
            w = R.choice(["no", "without", "except", "other than"])
            q = f"{R.choice(['best', '3 leg', 'safest'])} {R.choice(COLW['cbb'][:1] + ['college basketball', 'ncaab'])} {mw} {w} {s['full']}"
            e = {"exclude": [s["cbb"]], "sports": ["cbb"], "markets": [m]}
            if "3 leg" in q:
                e.update(intent="parlay", count=3)
            return "college", q, e
        q = R.choice([f"{nm} {spw} {mq}", f"{spw} {nm} {mq}", f"{nm} {mq} {spw}", f"best bet on {nm} {mq} {spw}", f"should i take {nm} {mq} {spw}"])
        e.update(school=s["full"], sports=exp_sp)
        return "college", q, e
    if k == "ambig":
        word = R.choice(list(D["shared"]))
        sch = [D["byab"][a] for a in D["shared"][word]]
        sp = R.choice([None, None, "cbb", "cfb"])
        if sp == "cfb":
            sch = [s for s in sch if s["cfb"]]
        if len(sch) < 2:
            sp, sch = None, [D["byab"][a] for a in D["shared"][word]]
        spw = R.choice(COLW[sp]) if sp else ""
        q = R.choice([f"{word} {mq} {spw}", f"{spw} {word} {mq}", f"{word} {spw}"])
        return "college", q, {"ambig": True}
    if k == "pro":
        p = R.choice(D["pro"])
        form = R.choice(["full", "full", "nick", "place"])
        if form == "full":
            q = f"{p['place']} {p['mascot']} {mq}"
            e.update(team=p["abbr"], sports=[p["sport"]], no_sports=["cfb", "cbb"])
            if p["place"] == "Utah" and p["sport"] == "nhl" and R.random() < 0.5:
                q = f"utah hockey {mq}"
            return "college", q, e
        if form == "nick":
            nk = [n for n, ab in D["nick"].items() if ab == p["abbr"] and (n not in D["dup"])]
            if not nk:
                return college()
            n = R.choice(nk)
            from_sp = "nfl" if n in ("cardinals", "falcons", "ravens", "bills", "panthers", "bears", "bengals", "browns", "cowboys", "broncos", "lions",
                                     "packers", "texans", "colts", "jaguars", "jags", "chiefs", "raiders", "chargers", "rams", "dolphins", "vikings",
                                     "patriots", "pats", "saints", "giants", "jets", "eagles", "steelers", "49ers", "niners", "seahawks", "bucs",
                                     "buccaneers", "titans", "commanders") else None
            q = f"{n} {mq}"
            e.update(no_sports=["cfb", "cbb"], ambig_ok=True, sports_in=["nba", "nfl", "nhl"])
            if from_sp:
                e.update(sports=[from_sp])
            return "college", q, e
        q = f"{p['place']} {mq}"
        e.update(no_sports=["cfb", "cbb"], sports_in=["nba", "nfl", "nhl"], ambig_ok=True)
        return "college", q, e
    if k == "conf":
        name, words, foot = R.choice(CONFS)
        sp = R.choice([None, None, "cbb", "cfb"] if foot else [None, "cbb"])
        spw = {"cbb": R.choice(["basketball", "college basketball", "hoops"]), "cfb": R.choice(["football", "college football"]), None: ""}[sp]
        bt = R.choice(["", "", "3 leg", "best", "safest", "top 3"])
        q = f"{bt} {R.choice(words)} {spw} {mq}"
        e.update(conf=name, sports=[sp] if sp else (["cfb", "cbb"] if foot else ["cbb"]))
        if bt == "3 leg":
            e.update(intent="parlay", count=3)
        elif bt == "top 3":
            e.update(count=3)
        cn = re.search(r"(?i)\b(?:big|pac|a|atlantic)[\s-]?(10|12)\b", q)
        if cn:
            e.update(count_not=int(cn.group(1)))     # "big 12 spreads" is not 12 picks
        return "college", q, e
    if k == "depth":
        D2 = DEPTHS()
        if R.random() < 0.55 and D2["teams"]:
            ab = R.choice([a for a in D["names"] if a in D2["teams"]])
            s = D["byab"][ab]
            nm = R.choice(D["names"][ab] + [s["full"]])
            q = R.choice([f"who starts for {nm}", f"{nm} starters", f"{nm} pace", f"{nm} depth chart", f"{nm} rotation", f"{nm} projected minutes",
                          f"whats {nm}{chr(39) if nm.endswith('s') else chr(39) + 's'} pace", f"starting lineup for {nm}"])
            return "college", q, {"depth": True, "depth_team": s["full"]}
        n = R.choice(D2["players"])
        q = R.choice([f"projected minutes {n}", f"how many minutes does {n} play", f"{n} minutes", f"{n} projected minutes", f"{n} playing time"])
        return "college", q, {"depth": True, "depth_player": n}
    if k == "props":
        q = f"{R.choice(['college basketball', 'ncaab', 'cbb', 'college hoops'])} {R.choice(['points props', 'rebounds', 'assists props', 'player props', 'pts overs', '1st half totals'])}"
        return "college", q, {"unsupported": True}
    if k == "picks":
        q = R.choice(["onyx picks", "onyx picks today", "official picks", "tracked picks tonight", "whats onyx's pick of the day", "graded picks"])
        return "college", q, {"onyx_picks": True}
    return college()


DEP = None


def DEPTHS():
    """depth-chart players a request can name alone: a full name only one player in any depth chart has, with no team or place word in it"""
    global DEP
    if DEP:
        return DEP
    D = coldata()
    seen, teams = {}, set()
    bad = set(D["places"]) | set(D["nick"]) | {w for k in D["keys"] for w in k.split()}
    for sp in ("cbb", "nba"):
        try:
            T = json.load(open(os.path.join(ROOT, "data", sp, "depth.json")))["teams"]
        except Exception:
            continue
        if sp == "cbb":
            teams = set(T)
        for ab, t in T.items():
            for p in t.get("players") or []:
                n = p.get("n") or ""
                seen[cnorm(n)] = seen.get(cnorm(n), 0) + 1
    for sp in ("cfb", "nfl", "nhl"):
        try:
            for t in json.load(open(os.path.join(ROOT, "data", sp, "depth.json")))["teams"].values():
                for p in t.get("players") or []:
                    seen[cnorm(p.get("n") or "")] = seen.get(cnorm(p.get("n") or ""), 0) + 9
        except Exception:
            pass
    out = []
    for sp in ("cbb", "nba"):
        try:
            T = json.load(open(os.path.join(ROOT, "data", sp, "depth.json")))["teams"]
        except Exception:
            continue
        for t in T.values():
            for p in t.get("players") or []:
                n = p.get("n") or ""
                c = cnorm(n)
                if seen.get(c) == 1 and len(c.split()) == 2 and re.fullmatch(r"[A-Za-z][A-Za-z' .-]+", n) \
                        and not any(w in bad for w in c.replace("-", " ").split()) and not re.search(r"\b(jr|sr|ii|iii|iv)\b", c):
                    out.append(n)
    DEP = {"players": out, "teams": teams}
    return DEP

def main():
    out, seen, tries = [], set(), 0
    while len(out) < N and tries < N * 30:
        tries += 1
        cat, q, e = compose()
        if cat != "notpriced":
            pre, post = R.choice(PRE), R.choice(POST)
            if "tonight" in post and e.get("when") not in (None, "today"):
                post = ""
            if "tonight" in post:
                e = dict(e, when="today") if cat == "build" else e
            q = pre + q + post
        if R.random() < 0.06:
            for a, b in TYPO.items():
                if a in q:
                    q = q.replace(a, b, 1)
                    break
        if R.random() < 0.12:
            q = q.upper() if R.random() < 0.3 else q.capitalize()
        q = " ".join(q.split())
        if q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append({"q": q, "e": e, "cat": cat})
    json.dump(out, open(OUT, "w"), ensure_ascii=False)
    print(f"wrote {OUT}: {len(out)} requests")


if __name__ == "__main__":
    main()
