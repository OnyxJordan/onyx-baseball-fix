#!/usr/bin/env python3
"""insights_freq.py - how often each kind of NFL question shows up in the Ask Onyx search sets (dev only, 11/15).

Feeds the NFL Studio's Onyx Insights tab (studio-insights.js: FREQ and the "Trending" strip). The site keeps no log
of what people type into search (ask.js stores nothing; Supabase has no search table), so the frequencies come from
the four question sets the search is tested against:
  tools/ask_corpus.json    535  phrasings per sport x market (ask_corpus.py)
  tools/ask_big.json       3000 requests composed the way people type, with today's names (ask_bigcorpus.py)
  tools/ask_holdout.json   59   hand-written questions, scored once before any fix
  tools/ask_holdout2.json  49   a second hand-written set
A question counts as NFL when it names the NFL, names only football markets, names an NFL player, or names no sport,
market, team or player at all ("quick 2 legger": asked on the NFL page it is an NFL question). Each one is then
tagged with every type it carries (a "3 leg nfl receptions parlay" is both a parlay and a receiving question), and
the counts are printed as the JSON table pasted into studio-insights.js.

  python3 tools/insights_freq.py
"""
import collections, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
FOOT = {'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'pass_td', 'pass_att', 'rush_rec_yds', 'pass_rush_yds',
        'anytime_td', 'first_td', 'two_td', 'two_plus_td', 'three_td'}
SETS = ['ask_corpus', 'ask_big', 'ask_holdout', 'ask_holdout2']


def nfl_names():
    try:
        with open(os.path.join(HERE, '..', 'data', 'nfl', 'names.json')) as f:
            return {r[0].lower() for r in json.load(f)}
    except Exception:
        return set()


def types(q, e):
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


def main():
    names, C, n = nfl_names(), collections.Counter(), 0
    for s in SETS:
        with open(os.path.join(HERE, s + '.json')) as f:
            rows = json.load(f)
        for r in rows:
            e, sp, mk = r['e'], r['e'].get('sports') or [], set(r['e'].get('markets') or [])
            pl = str(e.get('player') or '').lower()
            bare = not sp and not mk and not e.get('team') and not e.get('teams') and not pl
            if not ('nfl' in sp or (not sp and mk and mk <= FOOT) or (pl and pl in names) or bare):
                continue
            n += 1
            for t in types(r['q'], e):
                C[t] += 1
    print(json.dumps({'n': n, 'counts': dict(C.most_common())}))


if __name__ == '__main__':
    main()
