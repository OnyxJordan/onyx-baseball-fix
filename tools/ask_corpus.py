#!/usr/bin/env python3
"""ask_corpus.py - the Ask Onyx test set (dev only). Writes tools/ask_corpus.json: every phrasing
with what it must be read as. tools/verify_ask.js runs them against today's boards and scores
the reading (sport, market, intent, side, prices, team) and every bet returned."""
import json, itertools, random
random.seed(7)
SPORT = {"nfl": ["nfl", "pro football", "NFL"], "nba": ["nba", "basketball", "NBA"], "nhl": ["nhl", "hockey"],
         "cfb": ["college football", "cfb", "ncaaf"], "tennis": ["tennis", "atp"]}
MKT = {
 "nba": {"pts": ["points", "pts"], "reb": ["rebounds", "boards"], "ast": ["assists", "dimes"], "spread": ["spread", "against the spread"],
         "total": ["game total", "totals"], "ml": ["moneyline", "to win"]},
 "nfl": {"rec": ["receptions", "catches"], "rec_yds": ["receiving yards"], "rush_yds": ["rushing yards"], "pass_yds": ["passing yards"],
         "anytime_td": ["anytime td", "touchdown scorers"], "spread": ["spread", "spreads"], "total": ["totals", "over under"], "ml": ["moneyline", "to win"]},
 "cfb": {"rec": ["receptions"], "rec_yds": ["receiving yards"], "rush_yds": ["rushing yards"], "pass_yds": ["passing yards"],
         "anytime_td": ["anytime touchdown", "td scorers"], "spread": ["spread", "spreads"], "total": ["totals"], "ml": ["moneyline"]},
 "nhl": {"spread": ["puck line"], "total": ["totals", "game totals"], "ml": ["moneyline", "to win"]},
 "tennis": {"ml": ["match winners", "to win", "moneyline"]},
}
out = []
def add(q, **e):
    out.append({"q": q, "e": e})
for sp, words in SPORT.items():
    for m, mws in MKT[sp].items():
        sw, mw = random.choice(words), random.choice(mws)
        add(f"best {sw} {mw}", sports=[sp], markets=[m], intent="list")
        add(f"{sw} {mw} today", sports=[sp], markets=[m], intent="list")
        n = random.choice([2, 3, 4])
        add(f"{n} leg {sw} {mw} parlay", sports=[sp], markets=[m], intent="parlay", count=n)
        if m not in ("ml", "spread", "anytime_td"):
            add(f"{sw} {mw} overs", sports=[sp], markets=[m], side="over")
            add(f"{random.choice(words)} {mw} unders", sports=[sp], markets=[m], side="under")
        add(f"parlay that pays +{random.choice([300, 500, 800, 1000])} {sw} {mw}", sports=[sp], markets=[m], intent="parlay")
        add(f"{sw} {mw} plus money", sports=[sp], markets=[m], min_price=100)
        add(f"safest {sw} {mw}", sports=[sp], markets=[m])
        add(f"round robin 4 {sw} {mw} by 2s", sports=[sp], markets=[m], intent="rr")
        add(f"{mw} {sw} no worse than -150", sports=[sp], markets=[m], min_price=-150)
# sides / game lines / favorites / dogs
for sp in ("nfl", "nba", "nhl", "cfb"):
    w = SPORT[sp][0]
    add(f"{w} sides", sports=[sp], markets=["spread", "ml"])
    add(f"{w} game lines", sports=[sp], markets=["spread", "ml", "total"])
    add(f"{w} favorites", sports=[sp], markets=["ml"], max_price=-101)
    add(f"{w} underdogs", sports=[sp], markets=["ml"], min_price=100)
    add(f"3 leg {w} favorites parlay", sports=[sp], markets=["ml"], intent="parlay", count=3)
    add(f"parlay of {w} dogs", sports=[sp], markets=["ml"], intent="parlay", min_price=100)
    add(f"Parlay that pays +500 only {w} sides", sports=[sp], markets=["spread", "ml"], intent="parlay")
    add(f"Parlay that pays +500 only {w} only totals", sports=[sp], markets=["total"], intent="parlay")
    add(f"{w} player props", sports=[sp], props_only=True)
    add(f"best value {w} props", sports=[sp], props_only=True)
# teams
for q, sp, t in [("chiefs spread", "nfl", "KC"), ("eagles moneyline", "nfl", "PHI"), ("bills to win", "nfl", "BUF"), ("lions game total", "nfl", "DET"),
                 ("cowboys player props", "nfl", "DAL"), ("packers receptions", "nfl", "GB"), ("ohio state spread", "cfb", "OSU"),
                 ("georgia to cover", "cfb", "UGA"), ("buckeyes moneyline", "cfb", "OSU"), ("lsu spread", "cfb", "LSU"),
                 ("bruins puck line", "nhl", "BOS"), ("rangers to win", "nhl", "NYR"), ("oilers total", "nhl", "EDM"),
                 ("celtics spread", "nba", "BOS"), ("knicks points props", "nba", "NY"), ("thunder moneyline", "nba", "OKC"),
                 ("lakers rebounds", "nba", "LAL"), ("warriors game total", "nba", "GS")]:
    add(q, sports=[sp], team=t)
# players and stars
for q, sp, p in [("luka points", "nba", "Luka Doncic"), ("giannis rebounds", "nba", "Giannis Antetokounmpo"), ("jokic assists", "nba", "Nikola Jokic"),
                 ("wemby points over", "nba", "Victor Wembanyama"), ("lebron props", "nba", "LeBron James"), ("sga points", "nba", "Shai Gilgeous-Alexander"),
                 ("mahomes passing yards", "nfl", "Patrick Mahomes"), ("josh allen anytime td", "nfl", "Josh Allen"), ("jamarr chase receptions", "nfl", "Ja'Marr Chase"),
                 ("bijan rushing yards", "nfl", "Bijan Robinson"), ("ceedee lamb receiving yards", "nfl", "CeeDee Lamb"), ("saquon touchdown", "nfl", "Saquon Barkley"),
                 ("jeremiah smith receiving yards", "cfb", "Jeremiah Smith"), ("mcdavid points", "nhl", "Connor McDavid")]:
    add(q, sports=[sp], player=p)
# intents and phrasing variety
VAR = [
 ("give me a 3 leg parlay", dict(intent="parlay", count=3)), ("best bet tonight", dict(count=1)), ("pick of the day", dict(count=1)),
 ("lock of the day", dict(count=1)), ("what do you like today", dict()), ("safest picks today", dict()), ("most likely to hit", dict()),
 ("biggest payouts", dict()), ("longshots", dict(min_price=100)), ("plus money plays", dict(min_price=100)), ("even money plays", dict(min_price=-125, max_price=125)),
 ("2 leg parlay plus money", dict(intent="parlay", count=2, min_price=100)), ("4 team parlay", dict(intent="parlay", count=4)),
 ("5 leg parlay no juice", dict(intent="parlay", count=5)), ("sgp for the chiefs game", dict(intent="sgp")), ("same game parlay celtics", dict(intent="sgp")),
 ("correlated sgp", dict(intent="sgp")), ("sgp+", dict(intent="parlay")), ("round robin 5 picks by 3s", dict(intent="rr", count=5)),
 ("round robin by 2s", dict(intent="rr")), ("parlay that pays around +1000", dict(intent="parlay")), ("+300 parlay", dict(intent="parlay")),
 ("first td scorer sunday", dict(markets=["first_td"])), ("player most likely to score 2 tds", dict(markets=["two_plus_td"])),
 ("first basket tonight", dict(markets=["first_basket"])), ("1st quarter totals nba", dict(sports=["nba"], markets=["q1_total"])),
 ("first half total nba", dict(sports=["nba"], markets=["h1_total"])), ("top scorers tonight", dict(markets=["pts"])),
 ("who scores the most points tonight", dict(markets=["pts"])), ("leading rusher sunday", dict(markets=["rush_yds"])),
 ("most receptions this week", dict(markets=["rec"])), ("best value picks", dict()), ("70% or better plays", dict(min_conf=0.7)),
 ("tomorrow's best nfl plays", dict(sports=["nfl"])), ("sunday nfl parlay", dict(sports=["nfl"], intent="parlay")),
 ("what should i bet on", dict()), ("hammer of the day", dict()), ("fade the public", dict()), ("show me unders", dict(side="under")),
 ("overs only", dict(side="over")), ("hit the over", dict(side="over")), ("three team nfl parlay", dict(sports=["nfl"], intent="parlay", count=3)),
 ("a couple nba plays", dict(sports=["nba"], count=2)), ("few nhl picks", dict(sports=["nhl"], count=3)), ("double nba", dict(sports=["nba"], intent="parlay", count=2)),
 ("college football best bets", dict(sports=["cfb"])), ("ncaaf picks", dict(sports=["cfb"])), ("hockey best bets", dict(sports=["nhl"])),
 ("tennis favorites parlay", dict(sports=["tennis"], intent="parlay", markets=["ml"])), ("nfl rushing yards over under", dict(sports=["nfl"], markets=["rush_yds"])),
 ("total receptions nfl", dict(sports=["nfl"], markets=["rec"])), ("total points for jokic", dict(markets=["pts"])),
 ("best value picks to score a touchdown for college football", dict(sports=["cfb"], markets=["anytime_td"])),
 ("Parlay that pays +500 only college football sides", dict(sports=["cfb"], markets=["spread", "ml"], intent="parlay")),
]
for q, e in VAR:
    add(q, **e)
# the hard set: how people actually type (typos, slang, run-ons, nicknames, mixed asks)
HARD = [
 ("gimme a 3 legger nba overs", dict(sports=["nba"], intent="parlay", count=3, side="over")),
 ("3 leg parlay NBA points overs minimum odds -200", dict(sports=["nba"], markets=["pts"], intent="parlay", count=3, side="over", min_price=-200)),
 ("whats the best nfl bet sunday", dict(sports=["nfl"])), ("best nfl bet for sunday", dict(sports=["nfl"])),
 ("nfl lock", dict(sports=["nfl"])), ("lock of the night nba", dict(sports=["nba"], count=1)),
 ("i want a parlay with 4 nba legs all overs", dict(sports=["nba"], intent="parlay", count=4, side="over")),
 ("build me a 5 leg parlay for sunday nfl", dict(sports=["nfl"], intent="parlay", count=5)),
 ("can you make a parlay that pays 500 with college football spreads", dict(sports=["cfb"], markets=["spread"], intent="parlay")),
 ("cfb parlay +600", dict(sports=["cfb"], intent="parlay")), ("hockey parlay plus money", dict(sports=["nhl"], intent="parlay", min_price=100)),
 ("nba unders tonight", dict(sports=["nba"], side="under")), ("nba overs tonite", dict(sports=["nba"], side="over")),
 ("rebound unders", dict(markets=["reb"], side="under")), ("assist overs", dict(markets=["ast"], side="over")),
 ("pts overs", dict(markets=["pts"], side="over")), ("points unders for tonight", dict(markets=["pts"], side="under")),
 ("best player prop tonight", dict(props_only=True)), ("top 10 props", dict(props_only=True, count=10)),
 ("top 3 nfl props", dict(sports=["nfl"], props_only=True, count=3)), ("give me 2 nhl sides", dict(sports=["nhl"], markets=["spread", "ml"], count=2)),
 ("nfl dogs", dict(sports=["nfl"], markets=["ml"], min_price=100)), ("college dogs to win outright", dict(sports=["cfb"], markets=["ml"], min_price=100)),
 ("biggest favorite tonight", dict(markets=["ml"])), ("heavy favorites parlay", dict(markets=["ml"], intent="parlay")),
 ("who is most likely to score a td sunday", dict(markets=["anytime_td"])), ("anytime td parlay", dict(markets=["anytime_td"], intent="parlay")),
 ("td scorers plus money", dict(markets=["anytime_td"], min_price=100)), ("anytime touchdown longshots", dict(markets=["anytime_td"])),
 ("first td bets", dict(markets=["first_td"])), ("2+ td scorers", dict(markets=["two_plus_td"])), ("multi td parlay", dict(markets=["two_plus_td"])),
 ("most receiving yards sunday", dict(markets=["rec_yds"])), ("best qb passing yards", dict(markets=["pass_yds"])),
 ("rb rushing overs", dict(markets=["rush_yds"], side="over")), ("wr receptions unders", dict(markets=["rec"], side="under")),
 ("luke doncic points", dict(player="Luka Doncic")), ("lukas points", dict(player="Luka Doncic")), ("jokick rebounds", dict(player="Nikola Jokic")),
 ("greek freak points", dict(player="Giannis Antetokounmpo")), ("steph threes", dict(player="Stephen Curry")), ("kd points over", dict(player="Kevin Durant")),
 ("ant edwards points", dict(player="Anthony Edwards")), ("shai points tonight", dict(player="Shai Gilgeous-Alexander")),
 ("bron rebounds", dict(player="LeBron James")), ("tatum props", dict(player="Jayson Tatum")), ("embiid points", dict(player="Joel Embiid")),
 ("chiefs sgp", dict(intent="sgp", team="KC")), ("eagles same game parlay", dict(intent="sgp", team="PHI")),
 ("sgp for the lakers game", dict(intent="sgp", team="LAL")), ("give me an sgp", dict(intent="sgp")), ("sgp plus", dict(intent="parlay")),
 ("round robin nfl 6 picks by 3s", dict(sports=["nfl"], intent="rr", count=6)), ("rr 4 by 2", dict(intent="rr")),
 ("parlay that pays +1000 nba", dict(sports=["nba"], intent="parlay")), ("nba parlay paying around 400", dict(sports=["nba"], intent="parlay")),
 ("something that pays 2 to 1", dict()), ("safe 2 leg parlay", dict(intent="parlay", count=2)), ("safest parlay tonight", dict(intent="parlay")),
 ("60% or better nba props", dict(sports=["nba"], min_conf=0.6, props_only=True)), ("over 55 percent nfl", dict(sports=["nfl"], min_conf=0.55)),
 ("no juice nba", dict(sports=["nba"])), ("nothing worse than -130", dict(min_price=-130)), ("-110 or better", dict(min_price=-110)),
 ("+150 or longer", dict(min_price=150)), ("odds between -150 and +150", dict(min_price=-150, max_price=150)),
 ("what do you like in hockey tonight", dict(sports=["nhl"])), ("any good tennis bets", dict(sports=["tennis"])),
 ("atp matches today", dict(sports=["tennis"])), ("wta favorites", dict(sports=["tennis"], markets=["ml"])),
 ("college football totals", dict(sports=["cfb"], markets=["total"])), ("cfb overs", dict(sports=["cfb"], side="over")),
 ("ncaa football spreads", dict(sports=["cfb"], markets=["spread"])), ("college ats", dict(sports=["cfb"], markets=["spread"])),
 ("nfl ats picks", dict(sports=["nfl"], markets=["spread"])), ("against the spread nfl", dict(sports=["nfl"], markets=["spread"])),
 ("nfl over unders", dict(sports=["nfl"], markets=["total"])), ("o/u nhl", dict(sports=["nhl"], markets=["total"])),
 ("puck lines", dict(markets=["spread"])), ("nhl ml", dict(sports=["nhl"], markets=["ml"])), ("nba ml parlay", dict(sports=["nba"], markets=["ml"], intent="parlay")),
 ("first quarter overs nba", dict(sports=["nba"], markets=["q1_total"], side="over")), ("1q unders", dict(markets=["q1_total"], side="under")),
 ("1st half nba totals", dict(sports=["nba"], markets=["h1_total"])), ("first basket scorer", dict(markets=["first_basket"])),
 ("who gets the first bucket", dict(markets=["first_basket"])), ("first to score nba", dict(markets=["first_basket"])),
 ("best edges today", dict()), ("where does the model beat the line", dict()), ("most value nba", dict(sports=["nba"])),
 ("highest confidence plays", dict()), ("your top picks", dict()), ("recommended plays nfl", dict(sports=["nfl"])),
 ("tonights best bets", dict()), ("plays for tomorrow", dict()), ("this weekend's best bets", dict()),
 ("sunday parlay", dict(intent="parlay")), ("saturday college football parlay", dict(sports=["cfb"], intent="parlay")),
 ("celtics player props", dict(team="BOS")), ("knicks overs", dict(team="NY", side="over")), ("bucks game total", dict(team="MIL")),
 ("packers vs bears total", dict()), ("bills chiefs sgp", dict(intent="sgp")), ("chiefs -3", dict(team="KC")),
 ("mahomes over passing yards", dict(player="Patrick Mahomes", side="over")), ("kelce receptions over", dict(player="Travis Kelce", side="over")),
 ("cmc rushing", dict(player="Christian McCaffrey")), ("jefferson receiving yards", dict(player="Justin Jefferson")),
 ("lamar rushing yards", dict(player="Lamar Jackson")), ("burrow passing", dict(player="Joe Burrow")), ("saquon over rushing", dict(player="Saquon Barkley", side="over")),
 ("ovi goals", dict(player="Alex Ovechkin")), ("mcdavid to score", dict(player="Connor McDavid")), ("alcaraz to win", dict(player="Carlos Alcaraz")),
 ("give me something good", dict()), ("help me build a parlay", dict(intent="parlay")), ("i need a bet", dict()), ("parlay", dict(intent="parlay")),
]
for q, e in HARD:
    out.append({"q": q, "e": e, "hard": True})
json.dump(out, open("tools/ask_corpus.json", "w"), indent=0)
print(len(out), "queries")
