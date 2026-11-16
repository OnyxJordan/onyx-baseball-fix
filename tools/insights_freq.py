#!/usr/bin/env python3
"""insights_freq.py - how often each kind of question shows up in the Ask Onyx search sets, per sport (dev only).

Feeds the Studio's Onyx Insights tab (studio-insights.js: FREQ and the "Trending" strip, one table per sport). The
counts come from the four question sets the search is tested against (real searches are counted separately by
search_trends.py once enough are logged):
  tools/ask_corpus.json    535  phrasings per sport x market (ask_corpus.py)
  tools/ask_big.json       3000 requests composed the way people type, with today's names (ask_bigcorpus.py)
  tools/ask_holdout.json   59   hand-written questions, scored once before any fix
  tools/ask_holdout2.json  49   a second hand-written set
A question counts for a sport when it names the sport, names only that sport's own markets (football props for the
NFL and college football, basketball props for the NBA; college basketball only by name, since Ask reads unnamed
basketball props as the NBA), names one of that sport's players,
or names no sport, market, team or player at all ("quick 2 legger": asked in that sport's Studio it is that sport's
question). Each one is then tagged with every type it carries (a "3 leg nfl receptions parlay" is both a parlay and
a receiving question), and the counts are printed as the JSON table pasted into studio-insights.js.

  python3 tools/insights_freq.py                 # the NFL (11/15 table, unchanged)
  python3 tools/insights_freq.py --sport nba     # nfl | nba | cfb | cbb | nhl | tennis
  python3 tools/insights_freq.py --sport all     # every sport, one JSON object per line
"""
import collections, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
FOOT = {'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'pass_td', 'pass_att', 'rush_rec_yds', 'pass_rush_yds',
        'anytime_td', 'first_td', 'two_td', 'two_plus_td', 'three_td'}
HOOP = {'pts', 'reb', 'ast', 'threes', 'pra', 'pr', 'pa', 'dbl_dbl', 'trp_dbl', 'first_basket', 'q1_total', 'h1_total'}
OWN = {'nfl': FOOT, 'cfb': FOOT, 'nba': HOOP, 'cbb': set(), 'nhl': set(), 'tennis': set()}   # cbb: Ask reads unnamed hoops props as the NBA
SPORTS = ['nfl', 'nba', 'cfb', 'cbb', 'nhl', 'tennis']
SETS = ['ask_corpus', 'ask_big', 'ask_holdout', 'ask_holdout2']


def names(sport):
    """Lower-case player names for the sport (names.json; the NBA roster; tennis Elo ratings)."""
    try:
        if sport == 'nba':
            with open(os.path.join(DATA, 'nba', 'roster.json')) as f:
                return {p['name'].lower() for p in json.load(f).get('players') or []}
        if sport == 'tennis':
            with open(os.path.join(DATA, 'tennis', 'elo.json')) as f:
                return set((json.load(f).get('r') or {}).keys())
        with open(os.path.join(DATA, sport, 'names.json')) as f:
            return {r[0].lower().strip() for r in json.load(f)}
    except Exception:
        return set()


def types(q, e, sport='nfl'):
    q, mk, t = q.lower(), set(e.get('markets') or []), set()
    if e.get('intent') in ('parlay', 'rr') or re.search(r'\bparlay|legger|\bleg\b', q): t.add('parlay')
    if e.get('intent') == 'sgp' or re.search(r'same game|\bsgp\b', q): t.add('sgp')
    if sport in ('nfl', 'cfb'):
        if mk & {'anytime_td', 'first_td', 'two_td', 'two_plus_td', 'three_td'} or re.search(r'\btds?\b|touchdown|scores? first', q): t.add('td')
        if mk & {'rec', 'rec_yds'}: t.add('receiving')
        if mk & {'rush_yds', 'rush_rec_yds'}: t.add('rushing')
        if mk & {'pass_yds', 'pass_td', 'pass_att', 'pass_rush_yds'}: t.add('passing')
    elif sport in ('nba', 'cbb'):
        if 'pts' in mk or re.search(r'\bpoints\b|\bscorers?\b', q) and not mk & {'total', 'q1_total', 'h1_total'}: t.add('points')
        if 'reb' in mk or re.search(r'rebound|\bboards\b', q): t.add('rebounds')
        if 'ast' in mk or re.search(r'assist|\bdimes\b', q): t.add('assists')
        if 'threes' in mk or re.search(r'three|3s\b|3pt|3-point', q): t.add('threes')
        if mk & {'pra', 'pr', 'pa'} or re.search(r'\bpra\b|pts ?\+ ?reb|points \+', q): t.add('combos')
        if mk & {'first_basket', 'dbl_dbl', 'trp_dbl'} or re.search(r'first basket|double.double|triple.double', q): t.add('specials')
        if mk & {'q1_total', 'h1_total'} or re.search(r'1st (half|quarter)|first (half|quarter)', q): t.add('halves')
    elif sport == 'nhl':
        if re.search(r'\bgoals?\b|\bscorers?\b', q): t.add('goals')
    elif sport == 'tennis':
        if re.search(r'\bsets?\b|straight sets', q): t.add('sets')
    if 'spread' in mk or re.search(r'puck ?line|spread|cover|handicap', q): t.add('spread')
    if mk & {'total'} or (sport in ('nhl', 'tennis') and re.search(r'\btotals?\b|over|under', q) and not mk - {'total'}): t.add('total')
    if 'ml' in mk or re.search(r'moneyline|\bml\b|to win|winners?\b', q): t.add('ml')
    if e.get('player'): t.add('player')
    if e.get('team') or e.get('teams'): t.add('game')
    if (e.get('min_price') or 0) >= 100 or re.search(r'plus money|plus odds|underdog|\bdogs?\b|longshot', q): t.add('plus')
    if e.get('min_conf') or re.search(r'safe|most likely|\block|highest prob', q): t.add('safe')
    if re.search(r'value|\bedge\b|\bev\b|sharp', q): t.add('value')
    if e.get('side') == 'under': t.add('under')
    if e.get('side') == 'over': t.add('over')
    if re.search(r'\bbest\b|\btop\b|of the day|recommend', q): t.add('best')
    return t


def nfl_types(q, e):
    """The 11/15 NFL tagger, unchanged (search_trends.py tags real NFL searches the same way)."""
    q, mk, t = q.lower(), set(e.get('markets') or []), set()
    if e.get('intent') in ('parlay', 'rr') or re.search(r'\bparlay|legger|\bleg\b', q): t.add('parlay')
    if e.get('intent') == 'sgp' or re.search(r'same game|\bsgp\b', q): t.add('sgp')
    if mk & {'anytime_td', 'first_td', 'two_td', 'two_plus_td', 'three_td'} or re.search(r'\btds?\b|touchdown|scores? first', q): t.add('td')
    if mk & {'rec', 'rec_yds'}: t.add('receiving')
    if mk & {'rush_yds', 'rush_rec_yds'}: t.add('rushing')
    if mk & {'pass_yds', 'pass_td', 'pass_att', 'pass_rush_yds'}: t.add('passing')
    if 'spread' in mk: t.add('spread')
    if 'total' in mk: t.add('total')
    if 'ml' in mk: t.add('ml')
    if e.get('player'): t.add('player')
    if e.get('team') or e.get('teams'): t.add('game')
    if (e.get('min_price') or 0) >= 100 or re.search(r'plus money|plus odds|underdog|\bdogs?\b|longshot', q): t.add('plus')
    if e.get('min_conf') or re.search(r'safe|most likely|\block|highest prob', q): t.add('safe')
    if re.search(r'value|\bedge\b|\bev\b|sharp', q): t.add('value')
    if e.get('side') == 'under': t.add('under')
    if e.get('side') == 'over': t.add('over')
    if re.search(r'\bbest\b|\btop\b|of the day|recommend', q): t.add('best')
    return t


def count(sport, rows):
    nm, own, C, n = names(sport), OWN[sport], collections.Counter(), 0
    for r in rows:
        e, sp, mk = r['e'], r['e'].get('sports') or [], set(r['e'].get('markets') or [])
        pl = str(e.get('player') or '').lower()
        bare = not sp and not mk and not e.get('team') and not e.get('teams') and not pl
        if not (sport in sp or (not sp and mk and own and mk <= own) or (pl and pl in nm) or bare):
            continue
        n += 1
        for t in (nfl_types(r['q'], e) if sport == 'nfl' else types(r['q'], e, sport)):
            C[t] += 1
    return {'sport': sport, 'n': n, 'all': len(rows), 'counts': dict(C.most_common())}


def main():
    rows = []
    for s in SETS:
        with open(os.path.join(HERE, s + '.json')) as f:
            rows += json.load(f)
    sport = 'nfl'
    if '--sport' in sys.argv:
        sport = sys.argv[sys.argv.index('--sport') + 1]
    for s in (SPORTS if sport == 'all' else [sport]):
        if s not in OWN:
            sys.exit('unknown sport ' + s)
        out = count(s, rows)
        if s == 'nfl' and sport == 'nfl':     # the 11/15 output shape
            out = {'n': out['n'], 'counts': out['counts']}
        print(json.dumps(out))


if __name__ == '__main__':
    main()
