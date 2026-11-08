// ask_compound_cases.js - compound Ask Onyx searches (11/8, Jordan: "total odds of at least, each leg has minimum
// odds of and maximum odds of, we need to be able to work this all out, like for tomorrow top 4 nfl td scorers
// + 1 PM slate only - Jonathan Taylor + total odds of at least +700 + no more than 4 legs"). Several rules in one
// search, in " + " / " - " clause style, typed +word / -word, and plain words. tools/verify_ask.js runs these with
// its default corpus. Keys beyond the usual: slot (the kickoff window's label), ticket_floor, xmk, no_player,
// max_legs, no_slot.
const C = (q, e) => ({q, e});
module.exports = [
  // ── Jordan's example and its pieces ──
  C('top 4 nfl td scorers + 1 PM slate only - Jonathan Taylor + total odds of at least +700 + no more than 4 legs',
    {sports: ['nfl'], markets: ['anytime_td'], intent: 'parlay', count: 4, slot: '1 PM slate', target_price: 700, ticket_floor: true, exclude: ['jonathan taylor'], no_player: true, max_legs: 4}),
  C('for tomorrow top 4 nfl td scorers + 1 PM slate only - Jonathan Taylor + total odds of at least +700 + no more than 4 legs',
    {sports: ['nfl'], markets: ['anytime_td'], when: 'tomorrow', slot: '1 PM slate', target_price: 700, exclude: ['jonathan taylor'], max_legs: 4}),
  C('nfl td scorers 1pm games only', {sports: ['nfl'], markets: ['anytime_td'], slot: '1 PM slate'}),
  C('nfl anytime td parlay early games', {sports: ['nfl'], markets: ['anytime_td'], intent: 'parlay', slot: '1 PM slate'}),
  C('nfl props late games', {sports: ['nfl'], slot: '4 PM slate'}),
  C('4pm nfl slate parlay', {sports: ['nfl'], intent: 'parlay', slot: '4 PM slate'}),
  C('sunday night football props', {sports: ['nfl'], slot: 'Sunday night'}),
  C('snf td scorers', {sports: ['nfl'], markets: ['anytime_td'], slot: 'Sunday night'}),
  C('monday night football parlay', {sports: ['nfl'], intent: 'parlay', slot: 'Monday night'}),
  C('primetime nfl props', {sports: ['nfl'], slot: 'night games'}),
  // ── the ticket's total and each leg's prices, together ──
  C('4 leg nfl parlay each leg minimum odds of -150 and maximum odds of +200 total odds of at least +700',
    {sports: ['nfl'], intent: 'parlay', count: 4, min_price: -150, max_price: 200, target_price: 700, ticket_floor: true}),
  C('3 leg nba parlay total odds of at least +500', {sports: ['nba'], intent: 'parlay', count: 3, target_price: 500, ticket_floor: true}),
  C('nba parlay ticket odds of at least +1000 each leg max odds +250', {sports: ['nba'], intent: 'parlay', target_price: 1000, max_price: 250}),
  C('nfl parlay combined odds at least +600 no leg shorter than -200', {sports: ['nfl'], intent: 'parlay', target_price: 600, min_price: -200}),
  C('5 leg nfl parlay maximum odds of +150 per leg', {sports: ['nfl'], intent: 'parlay', count: 5, max_price: 150}),
  C('nba props max odds of -110', {sports: ['nba'], max_price: -110}),
  // ── + and - ──
  C('nfl td scorers -Jonathan Taylor', {sports: ['nfl'], markets: ['anytime_td'], exclude: ['jonathan taylor'], no_player: true}),
  C('knicks points -brunson', {sports: ['nba'], exclude: ['jalen brunson'], no_player: true}),
  C('nba parlay +2000 -first basket', {sports: ['nba'], intent: 'parlay', xmk: ['first_basket']}),
  C('nba props + overs only - first basket', {sports: ['nba'], side: 'over', xmk: ['first_basket']}),
  C('nfl parlay + 1 PM slate + no more than 3 legs', {sports: ['nfl'], intent: 'parlay', slot: '1 PM slate', max_legs: 3}),
  C('nfl player props + late games - Christian McCaffrey', {sports: ['nfl'], slot: '4 PM slate', exclude: ['christian mccaffrey']}),
  // ── things that must stay as they were ──
  C('passing + rushing yards overs', {sports: ['nfl'], markets: ['pass_rush_yds'], side: 'over', no_slot: true}),
  C('points + rebounds + assists overs nba', {unsupported: true}),        // combined props: the NBA bet card, not search
  C('3 leg parlay -150 or longer', {intent: 'parlay', count: 3, no_slot: true}),
  C('nba parlay +400', {sports: ['nba'], intent: 'parlay', no_slot: true}),
  C('same-game parlay nfl', {sports: ['nfl'], intent: 'sgp', no_slot: true}),
  // ── 2+ and 3+ touchdowns at Onyx's own prices (11/8, Jordan: "I don't want a +120 3 leg parlay": the
  //    2+ TD legs were priced at their anytime prices, -433/-338/-254, so the ticket fell short of +1000) ──
  C('3 leg nfl parlay value on 2+ TD scorers minimum odds +1000', {sports: ['nfl'], markets: ['two_plus_td'], intent: 'parlay', count: 3, target_price: 1000, ticket_floor: true}),
  C('2+ td parlay paying at least +800', {sports: ['nfl'], markets: ['two_plus_td'], intent: 'parlay', target_price: 800}),
  C('3+ td scorers nfl', {sports: ['nfl'], markets: ['three_td']}),
  C('three or more touchdowns', {sports: ['nfl'], markets: ['three_td']}),
  C('2 or more tds sunday', {sports: ['nfl'], markets: ['two_plus_td']}),
  // ── granular lists (11/8, Jordan) ──
  C('give me your top 10 favorite nfl overs', {sports: ['nfl'], intent: 'list', count: 10, side: 'over', sort: 'rec'}),
  C('give me your favorite 10 value TD scorers', {markets: ['anytime_td'], intent: 'list', count: 10, sort: 'edge'}),
  C('tell me the top 5 QB passing yards projections by value', {sports: ['nfl'], markets: ['pass_yds'], count: 5, sort: 'edge'}),
  C('give me just the top 5 QB passing yard projections', {sports: ['nfl'], markets: ['pass_yds'], count: 5, sort: 'proj'}),
  C('top 10 nfl receiving yards projections', {sports: ['nfl'], markets: ['rec_yds'], count: 10, sort: 'proj'}),
  // ── positive value only, as a rule (11/8, Jordan: "top 5 value plays for TDs in the 1 PM NFL games") ──
  C('top 5 value plays for TDs in the 1 PM NFL games', {sports: ['nfl'], markets: ['anytime_td'], count: 5, slot: '1 PM slate', sort: 'edge'}),
  C('top 5 positive value plays for TDs in the 1 PM NFL games', {sports: ['nfl'], markets: ['anytime_td'], count: 5, slot: '1 PM slate', pos_value: true}),
  C('positive value nfl props only', {sports: ['nfl'], pos_value: true}),
  C('only +ev plays', {pos_value: true}),
  C('nba overs with an edge', {sports: ['nba'], side: 'over', pos_value: true}),
  C('3 leg parlay positive ev legs only', {intent: 'parlay', count: 3, pos_value: true}),
  // ── list sweep (11/8: 2,926 generated list searches, 76% -> 100%; a fresh 3,000 at 99.97%) ──
  C('7 highest projected nfl receiving yards', {sports: ['nfl'], markets: ['rec_yds'], intent: 'list', count: 7, sort: 'proj'}),
  C('3 positive value nfl passing yards in the 1 PM games', {sports: ['nfl'], markets: ['pass_yds'], count: 3, slot: '1 PM slate', pos_value: true}),
  C('top 7 nfl pass attempts +ev', {sports: ['nfl'], markets: ['pass_att'], count: 7, pos_value: true}),
  C('show me 7 rushing yards projections', {markets: ['rush_yds'], count: 7, sort: 'proj'}),
  C('show me 3 2+ td projections sunday night', {sports: ['nfl'], markets: ['two_plus_td'], count: 3, slot: 'Sunday night'}),
  C('5 safest 3+ td in the 1 PM games', {sports: ['nfl'], markets: ['three_td'], count: 5, slot: '1 PM slate'}),
  C('top 3 props in the 1 PM games', {sports: ['nfl'], count: 3, slot: '1 PM slate'}),
  C('10 first td you like most', {markets: ['first_td'], count: 10, sort: 'rec'}),
  C('show me 3 2+ td projections sunday night', {sports: ['nfl'], markets: ['two_plus_td'], count: 3, slot: 'Sunday night', min_rows: 3}),
  C('5 mnf receiving yards projections', {sports: ['nfl'], markets: ['rec_yds'], count: 5, slot: 'Monday night', min_rows: 5})
];
