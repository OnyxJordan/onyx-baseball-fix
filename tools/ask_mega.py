#!/usr/bin/env python3
"""
ask_mega.py - 100,000+ Ask Onyx requests, built from today's boards, for tools/verify_ask.js (dev only).

11/6 (Jordan: "we need to get through 100000+ search terms of back testing, I have no confidence in its
search ability"). tools/ask_bigcorpus.py writes requests in the reader's own vocabulary; this one is
wider: every sport on the boards (NFL, college football, NBA, college basketball, NHL, tennis), real
teams by nickname and full name, real players, same-game parlays with a minimum total price ("3 leg
same game parlay in NFL tonight with minimum total odds of +300"), touchdown-scorer parlays, payout
targets, matchups, slang ("lock of the day", "hammer"), filler, mixed case, punctuation and typos.

Each request carries only the fields its words pin down (sport, intent, count, team, player, market,
side, payout). verify_ask.js also checks every answer's ticket on its own: the leg count asked for, one
game for a same-game parlay, the payout reached, no leg twice, no both sides of one bet, nothing
started, every play on the board file at its price, and no empty answer when the board has a fit.

  python3 tools/ask_mega.py [n=100000] [seed=7]       -> tools/ask_mega.json (not committed: regenerate)
"""
import json, os, random, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int((sys.argv[1:] or ["100000"])[0])
SEED = int((sys.argv[2:] or ["7"])[0])
R = random.Random(SEED)

SPW = {"nfl": ["nfl", "NFL", "pro football", "football sunday"], "cfb": ["college football", "ncaaf", "cfb", "CFB"],
       "nba": ["nba", "NBA", "basketball", "hoops"], "cbb": ["college basketball", "ncaab", "cbb", "college hoops"],
       "nhl": ["nhl", "NHL", "hockey"], "tennis": ["tennis", "atp", "wta"]}
SPW["tennis"] = ["tennis"]          # "atp"/"wta" narrow a tour the reader may not split
LINEW = {"spread": ["spread", "spreads", "ats", "against the spread", "point spread"], "ml": ["moneyline", "moneylines", "ml", "to win"],
         "total": ["total", "totals", "over under", "o/u"]}
PROPW = {"pts": ["points", "pts"], "reb": ["rebounds", "boards", "rebs"], "ast": ["assists", "dimes"],
         "rec": ["receptions", "catches"], "rec_yds": ["receiving yards", "rec yards"], "rush_yds": ["rushing yards", "rush yards"],
         "pass_yds": ["passing yards", "pass yards"], "anytime_td": ["anytime td", "td scorer", "anytime touchdown", "to score a td"]}
NUMW = {2: ["2", "two"], 3: ["3", "three"], 4: ["4", "four"], 5: ["5", "five"], 6: ["6", "six"]}
PRE = ["", "", "", "", "yo ", "gimme ", "give me ", "can you build ", "i want ", "show me ", "need ", "build me ", "hit me with ",
       "whats ", "what are ", "any ", "looking for ", "find me ", "lemme get ", "can i get ", "pls "]
POST = ["", "", "", "", " pls", " please", "?", " today", " tonight", " for tonight", " !!", " rn", " asap", ".", " thx"]
WHEN = {"today": ["today", "tonight", "for tonight"], None: [""]}
TYPO = {"parlay": ["parly", "parley", "parlya"], "same game": ["samegame", "same gam"], "rebounds": ["rebouds"], "assists": ["asists"],
        "receptions": ["recepitons"], "receiving": ["recieving"], "passing": ["pasing"], "rushing": ["rusing"], "points": ["pionts"],
        "spread": ["sprad", "spred"], "moneyline": ["moneylne", "money line"], "touchdown": ["touchdwn", "tuchdown"], "tonight": ["tonite", "2night"]}
NBA_NICK = {"celtics": "BOS", "hornets": "CHA", "wizards": "WSH", "hawks": "ATL", "76ers": "PHI", "sixers": "PHI", "cavs": "CLE",
            "cavaliers": "CLE", "raptors": "TOR", "bucks": "MIL", "timberwolves": "MIN", "wolves": "MIN", "pelicans": "NO",
            "jazz": "UTAH", "mavs": "DAL", "mavericks": "DAL", "thunder": "OKC", "grizzlies": "MEM", "spurs": "SA", "kings": "SAC",
            "blazers": "POR", "trail blazers": "POR", "lakers": "LAL"}


def board(sp):
    try:
        return json.load(open(os.path.join(ROOT, "data", sp, "board.json"))).get("plays") or []
    except Exception:
        return []


B = {sp: board(sp) for sp in SPW}
# teams on today's boards: (sport, abbreviation, full name); NBA by nickname (its board carries no names)
TEAMS = []
for sp, rows in B.items():
    seen = set()
    for p in rows:
        if p.get("tn") and p.get("team") and (p["team"], p["tn"]) not in seen and sp in ("nfl", "nhl", "cfb"):
            seen.add((p["team"], p["tn"]))
            TEAMS.append((sp, p["team"], p["tn"]))
NBA_ON = {t for p in B["nba"] for t in str(p.get("matchup", "")).replace("@", " ").split()}
TEAMS += [("nba", ab, nk) for nk, ab in NBA_NICK.items() if ab in NBA_ON]
# players with props: (sport, name, market)
PLAYERS = sorted({(sp, p["name"], p["mkt"]) for sp, rows in B.items() for p in rows
                  if p.get("kind") == "prop" and p.get("name") and p.get("mkt") in PROPW and sp in ("nba", "nfl", "cfb")
                  and "D/ST" not in p["name"]})
PROP_SPORTS = {sp: sorted({p["mkt"] for p in rows if p.get("kind") == "prop" and p.get("mkt") in PROPW}) for sp, rows in B.items()}
LIVE_SPORTS = [sp for sp in SPW if B[sp]]


def tname(sp, ab, full):
    """a team the way people say it: the nickname ("Chiefs"), or the full name"""
    if sp == "nba":
        return full
    parts = full.split()
    if sp in ("nfl", "nhl") and R.random() < 0.6:
        return parts[-1] if parts[-1].lower() not in ("sox", "jackets", "knights", "wings", "leafs") else " ".join(parts[-2:])
    return full


def nw(n):
    return R.choice(NUMW[n])


def f_list():
    sp = R.choice(LIVE_SPORTS)
    e = {"sports": [sp], "intent": "list"}
    head = R.choice(["best", "top", "safest", "best {n}", "top {n}", "{n} best", "safest {n}", "give me {n}"])
    n = R.choice([3, 5])
    if "{n}" in head:
        head = head.format(n=nw(n)); e["count"] = n
    mk = R.choice([None, None] + ["spread", "ml", "total"] + PROP_SPORTS.get(sp, []))
    words = [head, R.choice(SPW[sp])]
    if mk in LINEW:
        words.append(R.choice(LINEW[mk])); e["markets"] = [mk]
    elif mk:
        words.append(R.choice(PROPW[mk])); e["markets"] = [mk]
    words.append(R.choice(["picks", "plays", "bets", ""]))
    if mk and mk != "anytime_td" and (mk == "total" or mk in PROPW) and R.random() < 0.3:
        sd = R.choice(["over", "under"]); words.append(sd + "s"); e["side"] = sd
    words.append(R.choice(WHEN[R.choice(["today", None])]))
    return " ".join(w for w in words if w), e


def f_parlay():
    sp = R.choice(LIVE_SPORTS)
    n = R.choice([2, 3, 4, 5, 6])
    e = {"sports": [sp], "intent": "parlay", "count": n}
    t = R.choice(["{n} leg {s} parlay", "{n}-leg {s} parlay", "{s} {n} legger", "parlay of {n} {s}", "{n} team {s} parlay", "{n} pick {s} parlay"])
    q = t.format(n=nw(n), s=R.choice(SPW[sp]))
    mk = R.choice([None, None, None] + ["spread", "ml", "total"] + PROP_SPORTS.get(sp, []))
    if mk and mk != "anytime_td":
        q += " " + R.choice(LINEW.get(mk) or PROPW[mk]); e["markets"] = [mk]
    return q + R.choice(["", " tonight", " today"]), e


def f_target():
    sp = R.choice(LIVE_SPORTS)
    n = R.choice([2, 3, 4, 5])
    tp = R.choice([200, 300, 400, 500, 750, 1000])
    t = R.choice(["{n} leg {s} parlay with minimum total odds of +{p}", "{n} leg {s} parlay at least +{p}", "{s} {n} leg parlay minimum odds +{p}",
                  "{n} leg parlay {s} that pays at least +{p}", "+{p} {s} parlay {n} legs"])
    q = t.format(n=nw(n), s=R.choice(SPW[sp]), p=tp)
    return q, {"sports": [sp], "intent": "parlay", "target_price": tp}


def f_sgp():
    k = R.random()
    if k < 0.45:
        sp = R.choice([s for s in ("nfl", "nba", "cfb", "nhl") if B[s]])
        n = R.choice([2, 3, 4])
        q = R.choice(["{n} leg same game parlay in {s} tonight", "{n} leg same game parlay {s}", "{s} sgp {n} legs", "same game parlay {s} {n} legs",
                      "{n} leg sgp in {s} tonight with minimum total odds of +{p}", "{n} leg same game parlay in {s} with minimum total odds of +{p}"])
        tp = R.choice([200, 300, 400, 500])
        e = {"sports": [sp], "intent": "sgp", "count": n}
        if "{p}" in q:
            e["target_price"] = tp; e.pop("count", None)
        return q.format(n=nw(n), s=R.choice(SPW[sp]), p=tp), e
    T = [t for t in TEAMS if t[0] in ("nfl", "nba", "cfb", "nhl")]
    sp, ab, full = R.choice(T)
    q = R.choice(["{t} sgp", "same game parlay {t}", "{t} same game parlay", "build a {t} sgp", "{t} same-game parlay {n} legs"]).format(t=tname(sp, ab, full), n=nw(3))
    return q, {"intent": "sgp", "team": ab}


def f_td():
    sp = R.choice([s for s in ("nfl", "cfb") if B[s]])
    n = R.choice([2, 3, 4])
    q = R.choice(["{n} leg td scorer parlay {s}", "{n} leg anytime td parlay {s}", "anytime td parlay {s}", "best td scorers {s}",
                  "who scores a td {s} {w}", "{s} anytime touchdown picks"]).format(n=nw(n), s=R.choice(SPW[sp]), w=R.choice(["today", "sunday", ""]))
    e = {"sports": [sp], "markets": ["anytime_td"]}
    if re.search(r"\bleg\b", q):
        e.update(intent="parlay", count=n)
    return q, e


def f_team():
    sp, ab, full = R.choice(TEAMS)
    nm = tname(sp, ab, full)
    mk = R.choice(["spread", "ml", "total", "props", None])
    if mk == "props":
        if not PROP_SPORTS.get(sp):
            mk = "spread"
        else:
            return R.choice(["{t} props", "{t} player props", "best {t} props"]).format(t=nm), {"team": ab}
    if mk is None:
        return R.choice(["{t}", "{t} bets", "what do you like {t}", "{t} picks", "best bet {t}"]).format(t=nm), {"team": ab}
    return f"{nm} {R.choice(LINEW[mk])}", {"team": ab, "markets": [mk]}


def f_player():
    if not PLAYERS:
        return None
    sp, name, mk = R.choice(PLAYERS)
    nm = name
    if R.random() < 0.15:       # without the suffix, the way people type it
        nm = " ".join(w for w in name.split() if w.lower().strip(".") not in ("jr", "sr", "ii", "iii", "iv"))
    sd = R.choice([None, "over", "under"])
    t = R.choice(["{n} {m}", "{n} {s} {m}", "is {n} going {s} his {m}", "{n} {m} {s}", "what about {n} {m}", "{n} {m} line", "should i take {n} {s} {m}"])
    if "{s}" in t and not sd:
        sd = "over"
    q = t.format(n=nm, m=R.choice(PROPW[mk]), s=sd or "")
    e = {"player": name, "markets": [mk]}
    if "{s}" in t and mk != "anytime_td":
        e["side"] = sd
    return " ".join(q.split()), e


def f_matchup():
    sp = R.choice([s for s in ("nfl", "cfb", "nhl", "cbb") if B[s]])
    g = R.choice([p for p in B[sp] if p.get("kind") in ("spread", "ml", "total")])
    a, h = g["matchup"].split(" @ ") if " @ " in g["matchup"] else (None, None)
    if not a:
        return None
    mk = R.choice(["spread", "total", "ml"])
    q = R.choice(["{a} vs {h} {m}", "{a} @ {h} {m}", "{a} {h} {m}", "{m} {a} {h}"]).format(a=a, h=h, m=R.choice(LINEW[mk]))
    return q, {"markets": [mk], "teams": sorted([a, h]), "sports": [sp]}


def f_price():
    sp = R.choice(LIVE_SPORTS)
    k = R.choice([("plus money", {"min_price": 100}), ("underdogs", {"min_price": 100}), ("+150 or longer", {"min_price": 150}),
                  ("-110 or better", {"min_price": -110}), ("no worse than -150", {"min_price": -150}), ("70% or better", {"min_conf": 0.7}),
                  ("60%+", {"min_conf": 0.6}), ("65% or better", {"min_conf": 0.65})])
    q = R.choice(["{s} {k}", "{k} {s} picks", "best {k} {s}", "{s} plays {k}"]).format(s=R.choice(SPW[sp]), k=k[0])
    return q, dict({"sports": [sp]}, **k[1])


def f_slang():
    sp = R.choice(LIVE_SPORTS + [None])
    q = R.choice(["lock of the day", "best bet tonight", "what do you like tonight", "give me something to bet", "free money", "whats the hammer",
                  "best value on the board", "safest bet today", "sharpest play", "what should i bet", "top play", "my best bet",
                  "what's good tonight", "any value", "best play of the night"])
    e = {}
    if sp:
        q += " " + R.choice(SPW[sp]); e["sports"] = [sp]
    return q, e


FAM = [(f_list, 18), (f_parlay, 18), (f_target, 8), (f_sgp, 12), (f_td, 6), (f_team, 16), (f_player, 12), (f_matchup, 4), (f_price, 4), (f_slang, 2)]

# 11/6 (Jordan: "if you say no that's actually the only thing it focuses on"; "the best over points option for
# the Knicks but not Jalen Brunson"; "top 10 value plays to score a td"): exclusions of every kind, a team's
# best option minus a player, top-N value plays for a market, and payout floors, in every sport on the boards
ROSTER = {}
for sp, rows in B.items():
    for p in rows:
        if p.get("kind") == "prop" and p.get("team") and p.get("name") and "D/ST" not in p["name"] and p.get("mkt") in PROPW:
            ROSTER.setdefault((sp, p["team"]), {}).setdefault(p["mkt"], set()).add(p["name"])
TEAM_NAME = {(sp, ab): full for sp, ab, full in TEAMS}
NEGW = ["no", "without", "but not", "except", "excluding", "not", "leave out", "skip"]
VALUE_MK = {"anytime_td": ["score a td", "score a touchdown", "find the end zone"], "pts": ["points overs", "points"],
            "reb": ["rebounds"], "ast": ["assists"], "rec": ["receptions", "catches"], "rec_yds": ["receiving yards"], "rush_yds": ["rushing yards"],
            "spread": ["cover", "spreads"], "total": ["totals"], "ml": ["moneylines", "win outright"]}


def f_exclude():
    sp = R.choice(LIVE_SPORTS)
    k = R.random()
    mks = [m for m in ["spread", "total", "ml"] + PROP_SPORTS.get(sp, []) if m != "q1_total"]
    if k < 0.35 and mks:                                    # a market ruled out, maybe with a payout floor
        xm = R.choice(mks)
        word = R.choice(LINEW.get(xm) or PROPW[xm])
        if xm == "anytime_td":
            word = R.choice(["td scorers", "anytime td", "touchdowns"])
        n = R.choice([2, 3, 4, 5])
        tp = R.choice([None, None, 500, 1000, 2000])
        neg = R.choice(NEGW[:6])
        if tp:
            q = R.choice([f"{neg} {word} to make a parlay of +{tp} or longer in {{s}}", f"{{s}} parlay +{tp} or longer {neg} {word}",
                          f"{{s}} parlay at least +{tp} {neg} {word}"]).format(s=R.choice(SPW[sp]))
            return q, {"sports": [sp], "intent": "parlay", "target_price": tp, "xmk": [xm]}
        q = R.choice([f"{nw(n)} leg {{s}} parlay {neg} {word}", f"{{s}} picks {neg} {word}", f"best {{s}} bets {neg} {word}"]).format(s=R.choice(SPW[sp]))
        e = {"sports": [sp], "xmk": [xm]}
        if "leg" in q.split():
            e.update(intent="parlay", count=n)
        return q, e
    if k < 0.55:                                            # a side ruled out
        sd = R.choice(["over", "under"])
        mk = R.choice([m for m in PROP_SPORTS.get(sp, []) if m != "anytime_td"] or ["total"])
        q = f"{R.choice(SPW[sp])} {R.choice(PROPW.get(mk) or LINEW[mk])} no {'unders' if sd == 'over' else 'overs'}"
        return q, {"sports": [sp], "side": sd, "markets": [mk]}
    if k < 0.85 and ROSTER:                                 # a team's best option, minus one of its players
        (tsp, ab), mm = R.choice(sorted(ROSTER.items(), key=lambda x: (x[0][0], x[0][1])))
        mk = R.choice(sorted(mm))
        if len(mm[mk]) < 2:
            return None
        who = R.choice(sorted(mm[mk]))
        tn = TEAM_NAME.get((tsp, ab))
        if not tn:
            return None
        sd = R.choice(["over", "under"]) if mk != "anytime_td" else None
        mw = R.choice(PROPW[mk])
        q = R.choice(["best {sd}{m} option for the {t} but not {p}", "{t} {sd}{m} {neg} {p}", "give me the {t} {m} {sd}but not {p}",
                      "{t} {m} picks {neg} {p}"]).format(sd=(sd + " ") if sd else "", m=mw, t=tname(tsp, ab, tn), p=who, neg=R.choice(NEGW[:4]))
        e = {"team": ab, "markets": [mk], "exclude_player": who}
        if sd and "{sd}" not in "":
            e["side"] = sd if (sd + " ") in q or (sd + "s") in q else e.get("side")
            if e.get("side") is None:
                e.pop("side")
        return " ".join(q.split()), e
    T = [t for t in TEAMS if t[0] == sp]                     # a team ruled out
    if not T:
        return None
    _, ab, full = R.choice(T)
    q = f"{R.choice(SPW[sp])} {R.choice(['picks', 'parlay', 'bets'])} {R.choice(NEGW[:5])} {tname(sp, ab, full)}"
    return q, {"sports": [sp], "exclude_team": ab}


def f_value():
    sp = R.choice(LIVE_SPORTS)
    mks = [m for m in VALUE_MK if m in PROP_SPORTS.get(sp, []) or m in ("spread", "total", "ml")]
    mk = R.choice(mks)
    n = R.choice([3, 5, 10])
    q = R.choice(["give me top {n} value plays to {m} in {s} {w}", "top {n} value {m} {s} {w}", "best {n} value plays {m} {s}",
                  "{n} best value {s} {m} plays {w}"]).format(n=nw(n) if n < 7 else n, m=R.choice(VALUE_MK[mk]), s=R.choice(SPW[sp]), w=R.choice(["today", "tonight", ""]))
    return " ".join(q.split()), {"sports": [sp], "markets": [mk], "count": n}


FAM += [(f_exclude, 22), (f_value, 8)]


def perturb(q):
    if R.random() < 0.12:
        for a, bs in TYPO.items():
            if a in q:
                q = q.replace(a, R.choice(bs), 1)
                break
    q = R.choice(PRE) + q + R.choice(POST)
    r = R.random()
    if r < 0.12:
        q = q.lower()
    elif r < 0.18:
        q = q.upper()
    elif r < 0.3:
        q = q[:1].upper() + q[1:]
    return " ".join(q.split())


def main():
    fams, wts = zip(*FAM)
    out, seen, tries = [], set(), 0
    while len(out) < N and tries < N * 30:
        tries += 1
        r = R.choices(fams, weights=wts)[0]()
        if not r:
            continue
        q, e = r
        q = perturb(q)
        if q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append({"q": q, "e": e})
    dest = os.environ.get("ASK_OUT") or os.path.join(ROOT, "tools", "ask_mega.json")
    json.dump(out, open(dest, "w"), ensure_ascii=False)
    print(f"wrote {dest}: {len(out)} requests from {len(TEAMS)} teams and {len(PLAYERS)} player markets ({tries} drawn)")


if __name__ == "__main__":
    main()
