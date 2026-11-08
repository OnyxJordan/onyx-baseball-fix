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
  C('same-game parlay nfl', {sports: ['nfl'], intent: 'sgp', no_slot: true})
];
