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
and wraps each in the ways people type: questions, commands, slang, filler, caps, typos.
Every request carries the exact reading it must get (tools/verify_ask.js grades it).

  python3 tools/ask_taxonomy.py [n=20000] [seed=1] [out=tools/ask_taxonomy.json]
"""
import json, os, random, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int((sys.argv[1:] or ["20000"])[0])
R = random.Random(int((sys.argv[2:] or ["1"])[0]))
OUT = (sys.argv[3:] or [os.path.join(ROOT, "tools", "ask_taxonomy.json")])[0]

SPORT = {"nba": ["nba", "NBA", "basketball", "hoops"], "nfl": ["nfl", "NFL", "pro football"],
         "nhl": ["nhl", "NHL", "hockey"], "cfb": ["college football", "ncaaf", "cfb", "NCAAF"], "tennis": ["tennis", "atp", "wta"]}
# markets per sport, in the words bettors use
MKT = {
    "nba": {"pts": ["points", "pts", "points props", "scoring"], "reb": ["rebounds", "boards", "rebs"], "ast": ["assists", "dimes", "ast"],
            "q1_total": ["1st quarter totals", "first quarter totals", "1q totals"], "h1_total": ["1st half totals", "first half totals"],
            "first_basket": ["first basket", "first basket scorer"]},
    "nfl": {"rec": ["receptions", "catches"], "rec_yds": ["receiving yards", "rec yards"], "rush_yds": ["rushing yards", "rush yards"],
            "pass_yds": ["passing yards", "pass yards"], "anytime_td": ["anytime td", "td scorers", "anytime touchdown", "touchdown scorers"],
            "pass_td": ["passing tds", "passing touchdowns"], "pass_att": ["pass attempts"], "first_td": ["first td scorer", "first touchdown"]},
    "cfb": {"rush_yds": ["rushing yards"], "rec_yds": ["receiving yards"], "pass_yds": ["passing yards"]},
    "nhl": {}, "tennis": {},
}
LINES = {"spread": ["spreads", "against the spread", "ats", "covers"], "total": ["game totals", "totals", "over unders"],
         "ml": ["moneylines", "moneyline", "ml"]}
LINE_SP = {"spread": ["nba", "nfl", "cfb", "nhl"], "total": ["nba", "nfl", "cfb", "nhl", "tennis"], "ml": ["nba", "nfl", "cfb", "nhl", "tennis"]}
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
    "wnba props", "college basketball", "march madness", "esports"]
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
    cat = R.choices(["build", "build", "build", "build", "player", "team", "matchup", "exclude", "notpriced", "favdog"], k=1)[0]
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
        sp = R.choice(["nba", "nfl", "nhl", "cfb"])
        if R.random() < 0.5:
            return "favdog", R.choice([f"{R.choice(SPORT[sp])} favorites to win", f"{R.choice(SPORT[sp])} favorites moneyline", f"chalk {R.choice(SPORT[sp])}"]), \
                {"sports": [sp], "markets": ["ml"], "max_price": -101}
        return "favdog", R.choice([f"{R.choice(SPORT[sp])} underdogs", f"{R.choice(SPORT[sp])} dogs to win", f"best {R.choice(SPORT[sp])} dogs"]), \
            {"sports": [sp], "markets": ["ml"], "min_price": 100}
    # build: a bet type + sport + optional market, side, what-to-see, price, confidence, day
    sp = R.choice(["nba", "nfl", "nhl", "cfb", "tennis"])
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
