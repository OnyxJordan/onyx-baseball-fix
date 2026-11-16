// studio-insights.js - Onyx Insights, the Studio's FAQ feed (11/15 NFL, Jordan: "onyx insights where we type the most
// frequently asked questions that come up in the search (can generate them randomly) and put out the responses,
// highlight pages"; every sport 11/16).
//
// Every visit deals 8 to 12 questions in the Studio's sport from that sport's bank below, weighted by how often that
// kind of question is asked, and answers each one live from today's board with Ask Onyx (ask.js) on its built-in
// reader only: the spec comes from OnyxAsk.localSpec and is handed to OnyxAsk.ask as a forced spec, so no question ever
// takes the AI round trip. Each answer is a highlight card (headline, a one-line takeaway written from the numbers, the
// top plays with Onyx chips and "+ Slip", chance bars); tapping one opens its page at #insights?q=<question> (every
// play, the board's "why" lines, Share, "Bet this on Onyx", "Parlay the top 3"). "Ask your own" runs any question the
// same way. Templates fill with today's names in the sport (players, teams, matches still to play).
//
// Where the frequencies come from (CFG[sport].freq): the questions in the four sets Ask Onyx is tested on,
// tools/ask_corpus.json (535), tools/ask_big.json (3,000 requests written the way people type), tools/ask_holdout.json
// (59) and tools/ask_holdout2.json (49, both hand-written), 3,643 in all. `python3 tools/insights_freq.py --sport all`
// tags each sport's questions with every type they carry and prints these tables (a question counts for a sport when
// it names it, names only its own markets or players, or names nothing at all). Re-run it when the sets grow and
// paste the counts here. Real searches: search_trends.py counts what people typed (data/insights/trending.json); with
// REAL_MIN+ searches in the sport, its real counts replace the corpus ones (per-sport types when the file carries
// them as by_sport[sport], else the NFL's own; for other sports without per-sport types it says how many real
// searches there were and that the ranking is still the test set's).
(function () {
  'use strict';
  var SPORT = (window.Studio && Studio.sport) || 'nfl', FREQ_ALL = 3643;
  var pick = function (a) { return a.length ? a[Math.floor(Math.random() * a.length)] : null; };
  var NBA_NICK = {ATL: 'Hawks', BOS: 'Celtics', BKN: 'Nets', CHA: 'Hornets', CHI: 'Bulls', CLE: 'Cavaliers', DAL: 'Mavericks', DEN: 'Nuggets', DET: 'Pistons',
    GS: 'Warriors', HOU: 'Rockets', IND: 'Pacers', LAC: 'Clippers', LAL: 'Lakers', MEM: 'Grizzlies', MIA: 'Heat', MIL: 'Bucks', MIN: 'Timberwolves', NO: 'Pelicans',
    NY: 'Knicks', OKC: 'Thunder', ORL: 'Magic', PHI: '76ers', PHX: 'Suns', POR: 'Trail Blazers', SAC: 'Kings', SA: 'Spurs', TOR: 'Raptors', UTAH: 'Jazz', WSH: 'Wizards'};
  // a team's name the way people type it (and Ask reads it): NFL abbreviations, NBA nicknames, schools, NHL nicknames, tennis names
  function tn(g, side) {
    var ab = g[side];
    if (SPORT === 'nba') return NBA_NICK[ab] || ab;
    if (SPORT === 'cfb' || SPORT === 'cbb') return g[side + '_loc'] || g[side + '_short'] || ab;
    if (SPORT === 'nhl') return g[side + '_short'] || ab;
    return ab;
  }
  function gm(g) { return g ? tn(g, 'away') + ' vs ' + tn(g, 'home') : null; }
  var COMMON_T = {parlay: 'Parlays', game: 'Team and game questions', safe: 'Safest plays', best: 'Best bets', spread: 'Spreads', over: 'Overs', under: 'Unders',
    ml: 'Moneylines', plus: 'Plus money', total: 'Game totals', player: 'Player lookups', sgp: 'Same-game parlays', value: 'Value plays', own: 'Your question'};
  var FOOT_T = {passing: 'Passing yards', receiving: 'Receptions and receiving', td: 'Touchdown scorers', rushing: 'Rushing yards'};
  var HOOP_T = {points: 'Points', rebounds: 'Rebounds', assists: 'Assists', threes: 'Threes', combos: 'Points + rebounds + assists', specials: 'Double-doubles and first baskets', halves: 'Halves and quarters'};

  // ── per sport: the search word, the corpus counts (tools/insights_freq.py --sport <k>), the type names and the
  // question bank [type, template]. A template is a string or fn(names) -> string|null (null: nothing on today's
  // board to fill it, so it sits this deal out). Each type's weight is split across its templates. ─────
  var CFG = {
    nfl: {n: 802, word: 'NFL', ph: 'Josh Allen passing yards', fallback: 'best nfl bets today',
      freq: {parlay: 392, game: 191, passing: 160, receiving: 132, td: 126, safe: 98, best: 94, spread: 65, over: 63, rushing: 63, under: 56, ml: 54, plus: 37, total: 36, player: 31, sgp: 12, value: 6},
      types: FOOT_T,
      bank: [
        ['parlay', 'safest 3 leg nfl parlay'],
        ['parlay', function () { return pick([2, 3, 4]) + ' leg nfl parlay'; }],
        ['parlay', 'nfl parlay that pays +500'],
        ['parlay', function (N) { var g = pick(N.games); return g ? {q: '3 leg parlay ' + g.away + ' vs ' + g.home, gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: 'who scores a td in ' + g.away + ' vs ' + g.home, gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: g.away + ' vs ' + g.home + ' best bets', gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: g.away + ' vs ' + g.home + ' total', gid: g.gid} : null; }],
        ['passing', function (N) { var p = pick(N.qb); return p ? {q: p + ' passing yards', name: p} : null; }],
        ['passing', 'nfl passing yards unders'],
        ['passing', 'nfl passing yards overs'],
        ['receiving', 'best nfl receptions unders today'],
        ['receiving', function (N) { var p = pick(N.wr); return p ? {q: p + ' receptions', name: p} : null; }],
        ['receiving', 'nfl receiving yards overs'],
        ['receiving', 'top 5 nfl receptions overs'],
        ['td', 'top 10 nfl anytime td scorers'],
        ['td', 'most likely nfl anytime td scorer'],
        ['td', 'top 5 nfl 2+ td scorers'],
        ['td', function (N) { var p = pick(N.td); return p ? {q: p + ' anytime td', name: p} : null; }],
        ['safe', 'safest nfl props today'],
        ['safe', 'safest nfl rushing yards'],
        ['best', 'best nfl bets today'],
        ['best', 'top 10 nfl player props no touchdowns positive value only'],
        ['spread', 'top 5 nfl spreads positive value only'],
        ['spread', function (N) { var t = pick(N.teams); return t ? {q: t + ' spread', team: N.tab[t]} : null; }],
        ['over', 'nfl player props over'],
        ['rushing', 'nfl rushing yards unders'],
        ['rushing', function (N) { var p = pick(N.rb); return p ? {q: p + ' rushing yards', name: p} : null; }],
        ['under', 'nfl unders today'],
        ['ml', 'nfl underdogs to win outright'],
        ['ml', function (N) { var t = pick(N.teams); return t ? {q: t + ' moneyline', team: N.tab[t]} : null; }],
        ['plus', '3 leg nfl parlay plus money'],
        ['plus', 'nfl plus money props'],
        ['total', 'top 5 nfl totals positive value only'],
        ['player', function (N) { var p = pick(N.all); return p ? {q: p + ' props', name: p} : null; }],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: g.away + ' vs ' + g.home + ' same game parlay', gid: g.gid} : null; }],
        ['value', 'best nfl value plays']
      ]},
    cfb: {n: 636, word: 'college football', ph: 'Ohio State spread', fallback: 'best college football bets today',
      freq: {parlay: 254, safe: 110, passing: 102, receiving: 94, td: 88, game: 84, ml: 77, rushing: 75, spread: 71, best: 70, total: 59, under: 56, over: 46, plus: 35, player: 13, sgp: 11, value: 6},
      types: FOOT_T,
      bank: [
        ['parlay', 'safest 3 leg college football parlay'],
        ['parlay', function () { return pick([2, 3, 4]) + ' leg college football parlay'; }],
        ['parlay', 'college football parlay that pays +500'],
        ['safe', 'safest college football bets today'],
        ['safe', 'safest college football props'],
        ['passing', 'college football passing yards overs'],
        ['passing', function (N) { var p = pick(N.qb); return p ? {q: p + ' passing yards', name: p} : null; }],
        ['receiving', 'college football receiving yards overs'],
        ['receiving', function (N) { var p = pick(N.wr); return p ? {q: p + ' receiving yards', name: p} : null; }],
        ['td', 'most likely college football anytime td scorer'],
        ['td', 'top 5 college football anytime td scorers'],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' best bets', gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' total', gid: g.gid} : null; }],
        ['ml', 'college football underdogs to win outright'],
        ['ml', function (N) { var t = pick(N.teams); return t ? {q: t + ' moneyline', team: N.tab[t]} : null; }],
        ['rushing', 'college football rushing yards unders'],
        ['rushing', function (N) { var p = pick(N.rb); return p ? {q: p + ' rushing yards', name: p} : null; }],
        ['spread', 'top 5 college football spreads positive value only'],
        ['spread', function (N) { var t = pick(N.teams); return t ? {q: t + ' spread', team: N.tab[t]} : null; }],
        ['best', 'best college football bets today'],
        ['total', 'college football totals overs'],
        ['under', 'college football unders today'],
        ['over', 'college football player props over'],
        ['plus', 'college football plus money bets'],
        ['player', function (N) { var p = pick(N.all); return p ? {q: p + ' props', name: p} : null; }],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' same game parlay', gid: g.gid} : null; }],
        ['value', 'best college football value plays']
      ]},
    nba: {n: 1048, word: 'NBA', ph: 'Nikola Jokic rebounds', fallback: 'best nba bets today',
      freq: {parlay: 370, player: 357, rebounds: 213, points: 210, assists: 180, game: 162, over: 148, under: 122, safe: 102, best: 75, spread: 67, ml: 65, total: 53, halves: 52, plus: 45, threes: 18, sgp: 11, value: 7, specials: 5, combos: 2},
      types: HOOP_T,
      bank: [
        ['parlay', 'safest 3 leg nba parlay'],
        ['parlay', function () { return pick([2, 3, 4]) + ' leg nba parlay'; }],
        ['parlay', 'nba parlay that pays +500'],
        ['parlay', function (N) { var g = pick(N.games); return g ? {q: '3 leg parlay ' + gm(g), gid: g.gid} : null; }],
        ['player', function (N) { var p = pick(N.all); return p ? {q: p + ' props', name: p} : null; }],
        ['player', function (N) { var p = pick(N.pts); return p ? {q: p + ' points', name: p} : null; }],
        ['rebounds', 'nba rebounds overs'],
        ['rebounds', 'top 5 nba rebounds unders'],
        ['rebounds', function (N) { var p = pick(N.reb); return p ? {q: p + ' rebounds', name: p} : null; }],
        ['points', 'best nba points props today'],
        ['points', 'nba points unders'],
        ['points', function (N) { var p = pick(N.pts); return p ? {q: p + ' points over', name: p} : null; }],
        ['assists', 'nba assists overs'],
        ['assists', function (N) { var p = pick(N.ast); return p ? {q: p + ' assists', name: p} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' best bets', gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' total', gid: g.gid} : null; }],
        ['over', 'nba player props over'],
        ['under', 'nba unders today'],
        ['safe', 'safest nba props today'],
        ['safe', 'safest nba rebounds'],
        ['best', 'best nba bets today'],
        ['spread', 'top 5 nba spreads positive value only'],
        ['spread', function (N) { var t = pick(N.teams); return t ? {q: t + ' spread', team: N.tab[t]} : null; }],
        ['ml', 'nba underdogs to win outright'],
        ['ml', function (N) { var t = pick(N.teams); return t ? {q: t + ' moneyline', team: N.tab[t]} : null; }],
        ['total', 'top 5 nba totals positive value only'],
        ['halves', 'nba first quarter totals'],
        ['halves', 'nba first half totals'],
        ['plus', 'nba plus money props'],
        ['threes', 'nba threes overs'],
        ['threes', function (N) { var p = pick(N.threes); return p ? {q: p + ' threes', name: p} : null; }],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' same game parlay', gid: g.gid} : null; }],
        ['value', 'best nba value plays'],
        ['specials', 'nba double double props'],
        ['combos', 'nba points rebounds assists props']
      ]},
    cbb: {n: 97, word: 'college basketball', ph: 'Kentucky college basketball spread', fallback: 'best college basketball bets today',
      freq: {parlay: 27, best: 16, sgp: 11, spread: 8, plus: 8, player: 7, game: 6, ml: 6, safe: 6, points: 5, over: 4, value: 3, under: 3, rebounds: 2, threes: 1},
      types: HOOP_T,
      bank: [
        ['parlay', 'safest 3 leg college basketball parlay'],
        ['parlay', function () { return pick([2, 3]) + ' leg college basketball parlay'; }],
        ['parlay', 'college basketball parlay that pays +400'],
        ['best', 'best college basketball bets today'],
        ['best', 'top 5 college basketball bets'],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' same game parlay', gid: g.gid} : null; }],
        ['spread', 'top 5 college basketball spreads positive value only'],
        ['spread', function (N) { var t = pick(N.teams); return t ? {q: t + ' spread', team: N.tab[t]} : null; }],
        ['plus', 'college basketball underdogs plus money'],
        ['player', 'college basketball player props'],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' best bets', gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' total', gid: g.gid} : null; }],
        ['ml', 'college basketball moneylines'],
        ['ml', function (N) { var t = pick(N.teams); return t ? {q: t + ' moneyline', team: N.tab[t]} : null; }],
        ['safe', 'safest college basketball bets'],
        ['points', 'college basketball points props'],
        ['over', 'college basketball overs'],
        ['under', 'college basketball unders'],
        ['value', 'best college basketball value plays']
      ]},
    nhl: {n: 585, word: 'NHL', ph: 'Rangers puck line', fallback: 'best nhl bets today',
      freq: {parlay: 354, total: 143, ml: 140, spread: 126, game: 104, safe: 98, best: 71, plus: 40, over: 33, under: 26, sgp: 11, value: 4, player: 3, goals: 2},
      types: {spread: 'Puck lines', total: 'Total goals', goals: 'Goal scorers'},
      bank: [
        ['parlay', 'safest 3 leg nhl parlay'],
        ['parlay', function () { return pick([2, 3]) + ' leg nhl parlay'; }],
        ['parlay', 'nhl parlay that pays +400'],
        ['total', 'nhl totals overs'],
        ['total', 'nhl unders today'],
        ['ml', 'nhl moneylines today'],
        ['ml', function (N) { var t = pick(N.teams); return t ? {q: t + ' moneyline', team: N.tab[t]} : null; }],
        ['spread', 'nhl puck lines'],
        ['spread', function (N) { var t = pick(N.teams); return t ? {q: t + ' puck line', team: N.tab[t]} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' best bets', gid: g.gid} : null; }],
        ['game', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' total', gid: g.gid} : null; }],
        ['safe', 'safest nhl bets today'],
        ['best', 'best nhl bets today'],
        ['plus', 'nhl underdogs plus money'],
        ['over', 'nhl overs'],
        ['under', 'nhl under 6.5'],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' same game parlay', gid: g.gid} : null; }],
        ['value', 'best nhl value plays'],
        ['goals', 'nhl anytime goal scorers']
      ]},
    tennis: {n: 436, word: 'tennis', ph: 'Zverev to win', fallback: 'best tennis bets today',
      freq: {parlay: 232, ml: 191, total: 168, safe: 99, best: 67, over: 44, plus: 33, under: 32, sgp: 11, value: 3, spread: 3, player: 1},
      types: {game: 'Match questions', ml: 'Match winners', total: 'Total games', spread: 'Game spreads'},
      bank: [
        ['parlay', 'safest 3 leg tennis parlay'],
        ['parlay', function () { return pick([2, 3]) + ' leg tennis parlay'; }],
        ['parlay', 'tennis parlay that pays +300'],
        ['ml', 'tennis match winners today'],
        ['ml', 'atp to win'],
        ['ml', function (N) { var p = pick(N.all); return p ? {q: p + ' to win', name: p} : null; }],
        ['total', 'tennis total games overs'],
        ['total', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' total games', gid: g.gid} : null; }],
        ['safe', 'safest tennis bets today'],
        ['best', 'best tennis bets today'],
        ['over', 'tennis overs'],
        ['under', 'tennis total games unders'],
        ['plus', 'tennis underdogs plus money'],
        ['sgp', function (N) { var g = pick(N.games); return g ? {q: gm(g) + ' same game parlay', gid: g.gid} : null; }],
        ['value', 'best tennis value plays'],
        ['spread', 'tennis game spreads'],
        ['player', function (N) { var p = pick(N.all); return p ? {q: p + ' odds', name: p} : null; }]
      ]}
  };
  var C = CFG[SPORT] || CFG.nfl, BANK = C.bank;
  var FREQ_N = C.n, FREQ = Object.assign({}, C.freq);
  var TYPE = Object.assign({}, COMMON_T, FOOT_T, HOOP_T, {goals: 'Goal scorers', sets: 'Sets'}, C.types);
  var SNAME = {nfl: 'NFL', cfb: 'college football', nba: 'NBA', cbb: 'college basketball', nhl: 'NHL', tennis: 'tennis'}[SPORT] || 'NFL';

  // how a question reads as a headline: league and bet words in capitals ("nfl" -> "NFL", "td" -> "TD")
  function headline(q) {
    var t = String(q || '').replace(/\b(nfl|nba|nhl|atp|wta|sgp|pra)\b/gi, function (m) { return m.toUpperCase(); }).replace(/\btds?\b/gi, function (m) { return m.toUpperCase(); }).replace(/\bml\b/g, 'ML');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  var rnd = pick;
  function weigh() { var per = {}; BANK.forEach(function (b) { per[b[0]] = (per[b[0]] || 0) + 1; }); BANK.forEach(function (b) { b[2] = Math.max(1, FREQ[b[0]] || 0) / per[b[0]]; }); }
  weigh();
  // real searches (11/16): search_trends.py counts what people typed into Ask Onyx over the last 7 days
  // (data/insights/trending.json). With REAL_MIN+ searches in the sport those counts replace the test-corpus ones above.
  var REAL_MIN = 30, REAL = null;

  // the kind of question a typed one is (the kicker on its card), the same tags tools/insights_freq.py counts
  function typeOf(q) {
    var t = String(q || '').toLowerCase();
    if (/same game|\bsgp\b/.test(t)) return 'sgp';
    if (/parlay|legger|\bleg\b/.test(t)) return 'parlay';
    if (/\btds?\b|touchdown|scores? first/.test(t)) return 'td';
    if (/\bvs\b|\b@\b/.test(t)) return 'game';
    if (/passing|pass yds|pass att/.test(t)) return 'passing';
    if (/reception|receiving|catches/.test(t)) return 'receiving';
    if (/rushing|rush yds/.test(t)) return 'rushing';
    if (/double double|triple double|first basket/.test(t)) return 'specials';
    if (/points rebounds assists|\bpra\b/.test(t)) return 'combos';
    if (/rebound/.test(t)) return 'rebounds';
    if (/assist/.test(t) && SPORT !== 'nhl') return 'assists';
    if (/three|3s\b|3pt/.test(t)) return 'threes';
    if (/first (half|quarter)/.test(t)) return 'halves';
    if (/goal scorer|anytime goal/.test(t)) return 'goals';
    if (/\bpoints\b/.test(t) && (SPORT === 'nba' || SPORT === 'cbb')) return 'points';
    if (/spread|puck line/.test(t)) return 'spread';
    if (/moneyline|to win|underdog|winners?\b/.test(t)) return 'ml';
    if (/totals?\b|total games/.test(t)) return 'total';
    if (/safe|most likely/.test(t)) return 'safe';
    if (/value|edge/.test(t)) return 'value';
    if (/plus money/.test(t)) return 'plus';
    if (/\bprops?\b|\bodds\b/.test(t)) return 'player';
    return 'best';
  }

  var CSS = [
    '.ins-asked{display:flex;flex-wrap:wrap;gap:6px}.ins-q{white-space:normal;text-align:left}.ins-ask{display:flex;gap:8px;margin:0 0 12px}.ins-ask .sx-in{flex:1;min-width:0}',
    '.ins-top{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:18px 0 10px}',
    '.ins-top h2{margin:0;font-size:20px}.ins-top p{margin:4px 0 0;color:var(--dim);font-size:12.5px}',
    '.ins-trend{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:2px 0 4px;margin:0 0 6px}.ins-trend::-webkit-scrollbar{display:none}',
    '.ins-tr{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:10px 12px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:#fff;cursor:pointer;text-align:left;font:inherit;min-width:128px}',
    '.ins-tr b{font-size:13px}.ins-tr span{font:700 11px monospace;color:var(--pur2)}.ins-tr i{font-style:normal;font:700 10px monospace;color:var(--mute);letter-spacing:.06em}',
    '.ins-tr .ins-mini{width:100%;height:4px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden}.ins-tr .ins-mini>u{display:block;height:100%;background:var(--pur)}',
    '.ins-note{color:var(--mute);font-size:11.5px;line-height:1.55;margin:4px 0 0}',
    '.ins-card{cursor:pointer;display:flex;flex-direction:column;gap:8px;transition:border-color .2s,transform .2s}.ins-card:hover{border-color:rgba(176,56,249,.6)}',
    '.ins-card:active{transform:scale(.995)}.ins-card.own{border-color:var(--pur)}',
    '.ins-kick{display:flex;justify-content:space-between;gap:8px;font:700 10.5px monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--mute)}.ins-kick b{color:var(--pur2);font-weight:700}',
    '.ins-q{margin:0;font-size:18px;line-height:1.25;overflow-wrap:anywhere}',
    '.ins-take{margin:0;color:#e9e2f2;font-size:13.5px;line-height:1.5}.ins-take b{color:#fff}',
    '.ins-honest{margin:0;color:var(--dim);font-size:13px;line-height:1.5;padding:10px 12px;border-radius:12px;border:1px dashed rgba(255,255,255,.18)}',
    '.ins-small{margin:0;color:var(--mute);font-size:11.5px;line-height:1.5}',
    '.ins-pl{display:flex;flex-direction:column;gap:6px;padding:8px 0 0;border-top:1px solid rgba(255,255,255,.07)}.ins-pl:first-child{border-top:0;padding-top:0}',
    '.ins-pr{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.ins-pr>div{min-width:0}',
    '.ins-lab{font-weight:700;font-size:13.5px;overflow-wrap:anywhere}.ins-sub{display:block;color:var(--mute);font-size:11.5px;margin-top:2px}',
    '.ins-pc{font:800 15px monospace;white-space:nowrap}.ins-pc small{display:block;font:700 9px monospace;color:var(--mute);letter-spacing:.06em;text-align:right}',
    '.ins-bar{position:relative;height:7px;border-radius:999px;background:rgba(255,255,255,.08)}.ins-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#7d22c2,var(--pur))}',
    '.ins-bar>s{position:absolute;top:-3px;bottom:-3px;width:2px;background:#fff;opacity:.75;border-radius:2px}',
    '.ins-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ins-acts .sx-chip{padding:6px 11px}',
    '.ins-add{background:transparent}.ins-add.on{background:var(--pur);border-color:var(--pur);color:#fff}',
    '.ins-tag{font:700 9.5px monospace;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid var(--pur);color:var(--pur2)}',
    '.ins-more{margin-top:auto;font:700 11px monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--pur2)}',
    '.ins-skel{min-height:150px;display:flex;align-items:center;justify-content:center;color:var(--mute);font:600 12px monospace;letter-spacing:.06em;text-transform:uppercase}',
    '.ins-page{max-width:760px}.ins-back{background:none;border:0;color:var(--pur2);font:700 12px monospace;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;padding:6px 0;margin:0 0 8px}',
    '.ins-ph{margin:6px 0 10px;font-size:clamp(26px,6.5vw,42px);line-height:1.08;letter-spacing:-.01em;overflow-wrap:anywhere}',
    '.ins-hero{padding:16px;border-radius:18px;border:1px solid rgba(176,56,249,.45);background:linear-gradient(135deg,rgba(176,56,249,.16),rgba(176,56,249,.03));margin:0 0 12px}',
    '.ins-hero .ins-take{font-size:15.5px}.ins-big{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0 0}.ins-big div{min-width:0}',
    '.ins-cta{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}.ins-cta a,.ins-cta button{text-decoration:none;display:inline-flex;align-items:center;justify-content:center}',
    '.ins-why{margin:2px 0 0;color:var(--dim);font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}.ins-why b{color:var(--pur2);font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;margin-right:6px}',
    '.ins-copied{color:var(--grn);font:700 12px monospace}',
    '@media(max-width:420px){.ins-q{font-size:17px}.ins-tr{min-width:118px}}'
  ].join('\n');

  Studio.register('insights', {
    title: 'Insights',
    mount: function (el, D, u) {
      if (!document.getElementById('sx-insights-css')) { var st = document.createElement('style'); st.id = 'sx-insights-css'; st.textContent = CSS; document.head.appendChild(st); }
      var B = null, SEQ = 0, CACHE = {}, ROWS = {}, RN = 0, CARDS = [], FROM_FEED = false;

      el.innerHTML = '<div id="insFeed">' +
        '<p class="sx-sub" style="margin-top:0">The questions people ask search most, answered live from today\'s Onyx board by the model. Tap any card for its full page.</p>' +
        '<form class="ins-ask" id="insAsk" autocomplete="off"><input class="sx-in" id="insQ" type="search" enterkeyhint="go" placeholder="Ask your own: ' + u.esc(C.ph) + '" aria-label="Ask your own ' + u.esc(SNAME) + ' question"><button class="sx-btn" type="submit">Ask</button></form>' +
        '<div id="insOwn"></div>' +
        '<div class="ins-top" style="margin-top:6px"><div><h2>Trending in search</h2><p id="insTrendLead">The most asked kinds of ' + u.esc(SNAME) + ' question, out of ' + FREQ_N.toLocaleString() + ' ' + u.esc(SNAME) + ' questions in Ask Onyx\'s test set</p></div></div>' +
        '<div class="ins-trend" id="insTrend"></div><div id="insAsked"></div>' +
        '<div class="ins-top"><div><h2>Today\'s answers</h2><p id="insLead">Dealing questions</p></div><button class="sx-btn ghost" id="insShuffle" type="button">Shuffle</button></div>' +
        '<div class="sx-grid" id="insGrid"></div>' +
        '<p class="ins-note" id="insNote">Every answer is the model\'s projection on Onyx\'s current prices, built by Ask Onyx\'s own reader: the same plays a search returns. Projections are not Onyx Picks. Trending counts come from the ' + FREQ_ALL.toLocaleString() + ' questions Ask Onyx is tested against, ' + FREQ_N.toLocaleString() + ' of them ' + u.esc(SNAME) + ' (or naming no sport), until enough real searches are logged.' + (FREQ_N < 200 ? ' That is a small sample, so read the ranking loosely.' : '') + '</p>' +
        '</div><div id="insPage" class="ins-page" hidden></div>';
      var feed = el.querySelector('#insFeed'), page = el.querySelector('#insPage'), grid = el.querySelector('#insGrid');

      // ── trending strip ──────────────────────────────────────────────
      function drawTrend() {
        var top5 = Object.keys(FREQ).filter(function (k) { return TYPE[k] && FREQ[k] > 0; }).sort(function (a, b) { return FREQ[b] - FREQ[a]; }).slice(0, 5), mx = FREQ[top5[0]] || 1;
        el.querySelector('#insTrend').innerHTML = top5.map(function (k, i) {
          return '<button class="ins-tr" type="button" data-t="' + k + '"><i>#' + (i + 1) + '</i><b>' + u.esc(TYPE[k]) + '</b><span>' + FREQ[k] + ' asks</span>' +
            '<div class="ins-mini"><u style="width:' + Math.round(100 * FREQ[k] / mx) + '%"></u></div></button>';
        }).join('');
        // the real questions asked most (3+ times this week), each opens its highlight page
        var top = REAL && (REAL.top || []).slice(0, 8);
        el.querySelector('#insAsked').innerHTML = top && top.length ? '<p class="sx-k" style="margin:10px 0 6px">Asked most this week</p><div class="ins-asked">' +
          top.map(function (t) { return '<button class="sx-chip ins-q" type="button" data-q="' + u.esc(t.q) + '">' + u.esc(headline(t.q)) + ' <span class="sx-pur">' + t.n + '</span></button>'; }).join(' ') + '</div>' : '';
      }
      drawTrend();
      fetch('data/insights/trending.json?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : null; }).then(function (T) {
        if (!T) return;
        // the sport's own real counts: by_sport[sport] when search_trends.py writes it, the NFL's top-level counts, else only how many
        var bs = T.by_sport && T.by_sport[SPORT], R = bs && bs.types ? {n: bs.n, types: bs.types, top: bs.top} : SPORT === 'nfl' && T.types ? {n: T.nfl, types: T.types, top: T.top} : null;
        var n = R ? R.n : (T.sports || {})[SPORT], days = T.days || 7;
        if (!(n >= REAL_MIN)) return;
        var noteHead = 'Every answer is the model\'s projection on Onyx\'s current prices, built by Ask Onyx\'s own reader: the same plays a search returns. Projections are not Onyx Picks. ';
        if (!R) {      // real searches in the sport, but no per-sport kinds yet: say so, keep the test set's ranking
          el.querySelector('#insTrendLead').textContent = n.toLocaleString() + ' real ' + SNAME + ' searches in the last ' + days + ' days. The kinds below are still ranked from Ask Onyx\'s test set (' + FREQ_N.toLocaleString() + ' ' + SNAME + ' questions) until search counts kinds per sport.';
          el.querySelector('#insNote').innerHTML = noteHead + 'Trending kinds come from the ' + FREQ_ALL.toLocaleString() + ' questions Ask Onyx is tested against; the search count is real (only the question is kept, never who asked).';
          return;
        }
        REAL = R; FREQ = {}; Object.keys(R.types).forEach(function (k) { if (TYPE[k]) FREQ[k] = R.types[k]; }); FREQ_N = n; weigh();
        el.querySelector('#insTrendLead').textContent = 'What people asked Ask Onyx in the last ' + days + ' days: ' + n.toLocaleString() + ' ' + SNAME + ' searches';
        el.querySelector('#insNote').innerHTML = noteHead + 'Trending counts are real searches from the last ' + days + ' days (only the question is kept, never who asked).';
        drawTrend();
      }).catch(function () {});

      // today's names for the templates: games, teams and players still to play
      function names() {
        var now = Date.now(), fut = D.plays.filter(function (p) { return Date.parse(p.start) > now; });
        var N = {tab: {}, games: [], teams: [], qb: [], wr: [], rb: [], td: [], pts: [], reb: [], ast: [], threes: [], all: []};
        var gids = {}; fut.forEach(function (p) { gids[p.gid] = 1; });
        D.games.forEach(function (g) {
          if (!gids[g.gid] || !(Date.parse(g.start) > now)) return;
          N.games.push(g);
          if (SPORT === 'nfl') [['away_short', 'away'], ['home_short', 'home']].forEach(function (k) { var t = g[k[0]]; if (t) { N.teams.push(t); N.tab[t] = g[k[1]]; } });
          else if (SPORT === 'tennis') [g.away, g.home].forEach(function (t) { if (t && N.all.indexOf(t) < 0) N.all.push(t); });
          else ['away', 'home'].forEach(function (k) { var t = tn(g, k); if (t && N.teams.indexOf(t) < 0) { N.teams.push(t); N.tab[t] = g[k]; } });
        });
        var seen = {};
        fut.forEach(function (p) {
          if (p.kind !== 'prop' || !p.name || p.name === p.matchup) return;
          var add = function (L) { if (L.indexOf(p.name) < 0) L.push(p.name); };
          if (p.mkt === 'pass_yds') add(N.qb);
          if (p.mkt === 'rec' && p.line >= 3.5 || SPORT === 'cfb' && p.mkt === 'rec_yds' && p.line >= 40) add(N.wr);
          if (p.mkt === 'rush_yds' && p.line >= 40) add(N.rb);
          if (p.mkt === 'anytime_td' && p.conf >= 0.4) add(N.td);
          if (p.mkt === 'pts' && p.line >= 15) add(N.pts);
          if (p.mkt === 'reb' && p.line >= 6) add(N.reb);
          if (p.mkt === 'ast' && p.line >= 4) add(N.ast);
          if (p.mkt === 'threes' && p.line >= 1.5) add(N.threes);
          if (!seen[p.name] && /^(pass_yds|rec_yds|rush_yds|pts|reb)$/.test(p.mkt)) { seen[p.name] = 1; N.all.push(p.name); }
        });
        return N;
      }

      // a weighted random order of the whole bank (each template drawn by key = r^(1/weight))
      function order() {
        var N = names();
        return BANK.map(function (b) { return {t: b[0], w: b[2], f: b[1], k: Math.pow(Math.random(), 1 / b[2])}; })
          .sort(function (a, b) { return b.k - a.k; })
          .map(function (b) {
            var q = typeof b.f === 'function' ? b.f(N) : b.f; if (!q) return null;
            var it = typeof q === 'object' ? Object.assign({type: b.t}, q) : {type: b.t, q: q};
            if ((SPORT === 'cfb' || SPORT === 'cbb') && (it.gid || it.team) && it.q.indexOf('college') < 0) it.q = C.word + ' ' + it.q;   // "Kentucky" alone is read as football
            return it;
          }).filter(Boolean);
      }

      // ── Ask Onyx, local reader only ─────────────────────────────────
      function waitAsk(ms) {
        return new Promise(function (res, rej) {
          var t0 = Date.now();
          (function go() { if (window.OnyxAsk && OnyxAsk.localSpec && OnyxAsk.loadBoards) return res(window.OnyxAsk); if (Date.now() - t0 > ms) return rej(new Error('search did not load')); setTimeout(go, 100); })();
        });
      }
      var QUEUE = Promise.resolve();
      function answer(q) {
        var key = q.toLowerCase().trim();
        if (CACHE[key]) return Promise.resolve(CACHE[key]);
        // one at a time: Ask keeps the last answer for follow-ups, so questions never interleave
        var p = QUEUE.then(function () {
          return waitAsk(15000).then(function (A) { return B ? B : A.loadBoards().then(function (b) { B = b; return b; }); }).then(function () {
            if (OnyxAsk.reset) OnyxAsk.reset();
            return OnyxAsk.ask(q, OnyxAsk.localSpec(q, B));       // forced spec: never the AI relay
          }).then(function (R) { R = R || {rows: [], note: 'Search could not read that question.'}; CACHE[key] = R; return R; });
        });
        QUEUE = p.catch(function () {});
        return p;
      }

      // ── the numbers, in words ───────────────────────────────────────
      function chance(R, p) { return R.two && p.two != null ? p.two : p.conf; }
      function lab(R, p) {
        if (R.two) return p.name + ' 2+ touchdowns';
        if (p.kind === 'total') return p.label + ' (' + p.matchup + ')';
        return String(p.label || '').replace(/ Over 1\.5 2\+ touchdowns$/, ' 2+ touchdowns').replace(/ Over 2\.5 3\+ touchdowns$/, ' 3+ touchdowns');
      }
      function ok(R) { return !!(R && (R.rows || []).length && !R.clarify && !R.depth); }
      // a dealt question must be answered in this sport, and a question that names a player, team or game must be answered
      // about it (Ask reads some names as someone else: those questions sit the deal out instead of showing a wrong answer)
      function fits(it, R) {
        if (!ok(R)) return !(it.name || it.gid || it.team);   // a named question with no answer: Ask may have read another name
        var rows = R.rows.slice(0, 4), has = function (fn) { return rows.some(fn); };
        if (has(function (r) { return r.sport && r.sport !== SPORT; })) return false;
        if (it.name && !has(function (r) { return u.nk(r.name) === u.nk(it.name) || String(r.label || '').indexOf(it.name) >= 0 || String(r.matchup || '').indexOf(it.name) >= 0; })) return false;
        if (it.gid && !has(function (r) { return r.gid === it.gid; })) return false;
        if (it.team && !has(function (r) { return r.who === it.team || r.team === it.team || String(r.matchup || '').split(/ @ | vs /).indexOf(it.team) >= 0; })) return false;
        return true;
      }
      function valueNone(R) { return R.widened && R.spec && R.asked && R.asked.pos_value && R.rows.every(function (r) { return !(r.edge > 0); }); }
      function takeaway(R) {
        if (!ok(R)) return '';
        var p = R.rows[0], c = u.pct(chance(R, p)), o = u.odds(p.price), L = '<b>' + u.esc(lab(R, p)) + '</b>';
        if (valueNone(R)) return 'Nothing beats Onyx\'s price right now. The closest: ' + L + ', ' + c + ' at ' + o + ', edge ' + (100 * p.edge).toFixed(1) + '.';
        if (R.parlay && R.rows.length > 1) {
          var SG = R.parlay.same_game;
          return (SG ? 'A ' + R.rows.length + '-leg same-game parlay in ' + u.esc(R.parlay.matchup || p.matchup) : R.rows.length + ' legs') + ' pay <b>' + u.odds(R.parlay.price) + '</b> on Onyx; the model gives ' +
            (SG ? 'the ticket at least ' : 'all ' + R.rows.length + ' together ') + '<b>' + u.pct(R.parlay.prob, 1) + '</b>. Anchor leg: ' + L + ', ' + c + '.';
        }
        var sp = R.spec || {};
        if (p.no_read) return 'Top of the list: ' + L + ' at ' + o + ', ' + c + ' by Onyx\'s own price (the model has no read on this one).';
        if (sp.pos_value || sp.sort === 'edge') return 'Best value: ' + L + ', ' + c + ' against ' + u.pct(u.imp(p.price)) + ' implied at ' + o + ' (edge ' + (p.edge >= 0 ? '+' : '') + (100 * p.edge).toFixed(1) + ').';
        if (/^(anytime|first|two|three)_td$/.test(p.mkt || '')) return 'Most likely to score' + (p.mkt === 'two_td' ? ' 2+' : p.mkt === 'three_td' ? ' 3+' : p.mkt === 'first_td' ? ' first' : '') + ': <b>' + u.esc(p.name || lab(R, p)) + '</b>' + ', ' + c + ' at ' + o + '.' + (R.rows[1] ? ' Next: ' + u.esc(R.rows[1].name || R.rows[1].label) + ', ' + u.pct(chance(R, R.rows[1])) + '.' : '');
        if (R.rows.length === 1) return 'The one play that fits: ' + L + ', ' + c + ' at ' + o + '.';
        return 'The model\'s favorite: ' + L + ', ' + c + ' at ' + o + '.';
      }
      function honest(R) {
        if (!R) return 'Search could not read that question.';
        if (R.clarify && R.clarify.question) return (R.note ? R.note + ' ' : '') + R.clarify.question.replace(/ What should I build instead\?.*$/, '').replace(/ Want one of these instead\?.*$/, '');
        if (R.depth) return 'That is a depth chart question: the full chart is on the ' + D.sportName + ' page.';
        return R.note || 'Nothing on today\'s Onyx board fits that right now.';
      }
      function shortNote(R) {
        if (!R || !R.note || !ok(R)) return '';
        if (valueNone(R)) return '';
        var asked = R.spec && R.spec.count && R.spec.intent === 'list' && R.rows.length < R.spec.count;
        return R.widened || asked ? R.note.replace(/Touchdown prices carry[^]*$/, '').trim() : '';
      }

      // one play: label, chance bar against Onyx's implied chance, Onyx chip, + Slip
      function slipOn(p) { try { return !!(window.OnyxParlay && OnyxParlay.slip().some(function (x) { return x.sel === p.sel || x.id === p.sel; })); } catch (e) { return false; } }
      function play(R, p, opts) {
        var id = 'r' + (++RN); ROWS[id] = p;
        var c = chance(R, p), im = p.price != null ? u.imp(p.price) : null;
        var why = opts.why && p.why ? '<p class="ins-why"><b>Why</b>' + u.esc(String(p.why).replace(/^model ([A-Z]{2,3}) ([\d.]+) ([A-Z]{2,3}) ([\d.]+)/, 'The model scores it $1 $2, $3 $4')) + '</p>' : '';
        return '<div class="ins-pl">' +
          '<div class="ins-pr"><div><div class="ins-lab">' + u.esc(lab(R, p)) + '</div><span class="ins-sub">' + u.esc(p.matchup || '') + (p.start ? ' · ' + u.esc(u.fmtTime(p.start)) : '') +
            (p.edge != null && !R.two ? ' · edge <span class="' + (p.edge > 0 ? 'sx-pos' : 'sx-neg') + '">' + (p.edge >= 0 ? '+' : '') + (100 * p.edge).toFixed(1) + '</span>' : '') + '</span></div>' +
          '<div class="ins-pc">' + u.pct(c) + '<small>' + (p.no_read ? 'ONYX CHANCE' : R.two ? '2+ TD CHANCE' : 'MODEL') + '</small></div></div>' +
          '<div class="ins-bar" title="' + u.esc((p.no_read ? 'Onyx chance ' : 'Model chance ') + u.pct(c) + (im != null ? ', Onyx implied ' + u.pct(im) : '')) + '"><i style="width:' + Math.max(2, Math.min(100, 100 * (c || 0))).toFixed(1) + '%"></i>' +
            (im != null && !p.no_read ? '<s style="left:calc(' + (100 * im).toFixed(1) + '% - 1px)"></s>' : '') + '</div>' +
          why +
          '<div class="ins-acts">' + u.onyxBtn(p) + (p.sel ? '<button type="button" class="sx-chip ins-add' + (slipOn(p) ? ' on' : '') + '" data-r="' + id + '">' + (slipOn(p) ? 'On slip' : '+ Slip') + '</button>' : '') +
            (p.pick ? '<span class="ins-tag">Onyx Pick</span>' : '') + '</div>' +
        '</div>';
      }

      function cardHTML(it, R) {
        var good = ok(R), n = good ? Math.min(R.rows.length, R.parlay ? 5 : 4) : 0;
        return '<div class="ins-kick"><b>' + u.esc(TYPE[it.type] || 'Question') + '</b><span>' + (it.type !== 'own' && FREQ[it.type] ? FREQ[it.type] + ' asks' : 'Live answer') + '</span></div>' +
          '<h3 class="ins-q">' + u.esc(headline(it.q)) + '</h3>' +
          (good ? '<p class="ins-take">' + takeaway(R) + '</p>' + (shortNote(R) ? '<p class="ins-small">' + u.esc(shortNote(R)) + '</p>' : '') +
            '<div>' + R.rows.slice(0, n).map(function (p) { return play(R, p, {}); }).join('') + '</div>'
            : '<p class="ins-honest">' + u.esc(honest(R)) + '</p>') +
          '<span class="ins-more">' + (good ? (R.rows.length > n ? 'All ' + R.rows.length + ' plays and the why' : 'Open the highlight') : 'Open the highlight') + ' &rarr;</span>';
      }
      function cardState(R) { return ok(R) ? 'ok' : 'none'; }

      // ── the feed ────────────────────────────────────────────────────
      function deal() {
        var seq = ++SEQ, want = 8 + Math.floor(Math.random() * 5), list = order(), shown = 0, sigs = {}, per = {}, i = 0;
        CARDS = []; CACHE = {}; ROWS = {}; grid.innerHTML = '';
        var lead = el.querySelector('#insLead'); lead.textContent = 'Answering ' + want + ' questions from today\'s board';
        function next() {
          if (seq !== SEQ) return;
          if (shown >= want || i >= list.length) { lead.textContent = shown + ' questions, answered from Onyx\'s current prices'; return; }
          var it = list[i++];
          if ((per[it.type] || 0) >= 2) return next();      // at most two of one kind a hand, so the feed stays a mix
          var box = document.createElement('div');
          box.className = 'sx-card ins-card ins-skel'; box.textContent = 'Reading the board'; grid.appendChild(box);
          answer(it.q).then(function (R) {
            if (seq !== SEQ) return;
            // the same plays as a card already up (two phrasings, one answer): draw another question instead
            var sig = ok(R) ? R.rows.slice(0, 3).map(function (r) { return r.sel; }).join('|') : 'none:' + honest(R).slice(0, 40);
            if (sigs[sig] || !fits(it, R)) { box.remove(); return next(); }
            sigs[sig] = 1; shown++; per[it.type] = (per[it.type] || 0) + 1;
            fill(box, it, R); CARDS.push({q: it.q, state: cardState(R), via: R.via}); next();
          }, function (e) {
            if (seq !== SEQ) return;
            box.className = 'sx-card ins-card'; box.innerHTML = '<h3 class="ins-q">' + u.esc(headline(it.q)) + '</h3><p class="ins-honest">Search is still loading (' + u.esc(e.message) + '). Tap Shuffle to try again.</p>';
            lead.textContent = 'Search did not load';
          });
        }
        next();
      }
      function fill(box, it, R) {
        box.className = 'sx-card ins-card' + (it.type === 'own' ? ' own' : ''); box.dataset.q = it.q; box.dataset.state = cardState(R); box.dataset.via = R.via || '';
        box.setAttribute('role', 'link'); box.tabIndex = 0;
        box.innerHTML = cardHTML(it, R);
      }

      // ── highlight page ──────────────────────────────────────────────
      function renderPage(q) {
        feed.hidden = true; page.hidden = false; window.scrollTo(0, 0);
        page.innerHTML = '<button class="ins-back" type="button" data-back="1">&larr; All insights</button><div class="sx-k">' + u.esc(TYPE[typeOf(q)]) + ' · Onyx Insights</div>' +
          '<h2 class="ins-ph">' + u.esc(headline(q)) + '</h2><div class="ins-skel sx-card">Reading the board</div>';
        answer(q).then(function (R) {
          if (Studio.param('q') !== q) return;
          var good = ok(R), url = location.href.split('#')[0] + '#insights?q=' + encodeURIComponent(q), top = good ? R.rows[0] : null;
          var legs = [], used = {};
          if (good) R.rows.forEach(function (p) {
            if (legs.length >= 3 || !p.sel) return;
            var k = p.kind === 'prop' ? p.gid + ':' + (p.name || p.who) + ':' + p.mkt : p.gid + ':' + (p.kind === 'total' ? 'total' : 'side');
            if (used[k]) return; used[k] = 1; legs.push(p);
          });
          var T = legs.length >= 2 ? legs.reduce(function (m, p) { return {d: m.d * u.dec(p.price), pr: m.pr * chance(R, p)}; }, {d: 1, pr: 1}) : null;
          var sameG = legs.length >= 2 && legs.every(function (p) { return p.gid === legs[0].gid; });
          var tk = R.parlay && R.parlay.sels && R.parlay.sels.length > 1;
          var cta = '';
          if (good) {
            cta = '<div class="ins-cta">' +
              (top.sel ? '<a class="sx-btn" target="_blank" rel="noopener" href="' + u.esc(u.onyx([top.sel], 'insights_top')) + '">Bet this on Onyx ' + u.esc(u.odds(top.price)) + '</a>' : '') +
              (tk ? '<a class="sx-btn ghost" target="_blank" rel="noopener" href="' + u.esc(u.onyx(R.parlay.sels, 'insights_parlay')) + '">Bet the ' + R.parlay.sels.length + '-leg parlay ' + u.esc(u.odds(R.parlay.price)) + '</a>'
                : T ? '<a class="sx-btn ghost" target="_blank" rel="noopener" href="' + u.esc(u.onyx(legs.map(function (p) { return p.sel; }), 'insights_parlay')) + '">Parlay the top ' + legs.length + ' ' + u.esc(u.odds(u.amer(T.d))) + '</a>' : '') +
              '<button class="sx-btn ghost" type="button" data-share="1">Share</button><span class="ins-copied" id="insCopied"></span></div>';
          }
          var parl = tk ? '' : T ? '<p class="ins-small">Top ' + legs.length + ' as a parlay: ' + u.odds(u.amer(T.d)) + ' at Onyx\'s prices, model chance all hit ' + u.pct(T.pr, 1) + (sameG ? ' (same game: Onyx prices those legs together, so its price can differ)' : '') + '.</p>' : '';
          page.innerHTML = '<button class="ins-back" type="button" data-back="1">&larr; All insights</button><div class="sx-k">' + u.esc(TYPE[typeOf(q)]) + ' · Onyx Insights</div>' +
            '<h2 class="ins-ph">' + u.esc(headline(q)) + '</h2>' +
            '<div class="ins-hero">' + (good ? '<p class="ins-take">' + takeaway(R) + '</p>' +
              '<div class="ins-big">' + (tk ? '<div><div class="sx-k">Ticket pays</div><div class="sx-big sx-pur">' + u.odds(R.parlay.price) + '</div></div><div><div class="sx-k">Model chance</div><div class="sx-big">' + u.pct(R.parlay.prob, 1) + '</div></div>'
                : '<div><div class="sx-k">Top play</div><div class="sx-big">' + u.pct(chance(R, top)) + '</div></div><div><div class="sx-k">Onyx price</div><div class="sx-big sx-pur">' + u.odds(top.price) + '</div></div>' +
                  (top.edge != null && !R.two ? '<div><div class="sx-k">Edge</div><div class="sx-big ' + (top.edge > 0 ? 'sx-pos' : 'sx-neg') + '">' + (top.edge >= 0 ? '+' : '') + (100 * top.edge).toFixed(1) + '</div></div>' : '')) +
                '<div><div class="sx-k">Plays</div><div class="sx-big">' + R.rows.length + '</div></div></div>' + cta + parl
              : '<p class="ins-honest">' + u.esc(honest(R)) + '</p><div class="ins-cta"><button class="sx-btn ghost" type="button" data-share="1">Share</button><span class="ins-copied" id="insCopied"></span></div>') + '</div>' +
            (good ? '<div class="sx-card">' + R.rows.map(function (p) { return play(R, p, {why: true}); }).join('') + '</div>' : '') +
            (good && R.note ? '<p class="ins-note">' + u.esc(R.note) + '</p>' : '') +
            (R.understood ? '<p class="ins-note">Read as: ' + u.esc(R.understood) + '</p>' : '') +
            '<p class="ins-note">Chance bars: the purple fill is the model\'s chance, the white tick is the chance Onyx\'s price implies. Projections, not Onyx Picks.</p>';
          page.dataset.url = url; page.dataset.title = q;
        });
      }
      function showFeed() { page.hidden = true; page.innerHTML = ''; feed.hidden = false; }
      function route() { var q = Studio.param('q'); if (q) renderPage(q); else showFeed(); }
      function open(q) { FROM_FEED = true; location.hash = '#insights?q=' + encodeURIComponent(q); }
      function share() {
        var url = page.dataset.url || location.href, t = page.dataset.title || 'Onyx Insights', done = function (m) { var c = el.querySelector('#insCopied'); if (c) c.textContent = m; };
        if (navigator.share) { navigator.share({title: 'Onyx Insights: ' + t, text: t + ' (the Onyx ' + D.sportName + ' model on today\'s board)', url: url}).catch(function () {}); return; }
        var fb = function () { try { var i = document.createElement('input'); i.value = url; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); done('Link copied'); } catch (e) { done(url); } };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { done('Link copied'); }, fb); else fb();
      }

      // ── events ──────────────────────────────────────────────────────
      el.addEventListener('click', function (e) {
        var a = e.target.closest('[data-r]');
        if (a) { e.preventDefault(); e.stopPropagation(); var p = ROWS[a.dataset.r]; if (p && window.OnyxParlay) { OnyxParlay.add(p); var on = slipOn(p); a.classList.toggle('on', on); a.textContent = on ? 'On slip' : '+ Slip'; } return; }
        if (e.target.closest('a')) return;
        if (e.target.closest('[data-back]')) { if (FROM_FEED && history.length > 1) { FROM_FEED = false; history.back(); } else location.hash = '#insights'; return; }
        if (e.target.closest('[data-share]')) { share(); return; }
        var aq = e.target.closest('.ins-q'); if (aq && aq.dataset.q) { open(aq.dataset.q); return; }
        var tr = e.target.closest('.ins-tr');
        if (tr) { var cand = order().filter(function (x) { return x.type === tr.dataset.t; }); open(cand.length ? cand[0].q : C.fallback); return; }
        var c = e.target.closest('.ins-card');
        if (c && c.dataset.q && !e.target.closest('button')) open(c.dataset.q);
      });
      el.addEventListener('keydown', function (e) { var c = e.target.closest && e.target.closest('.ins-card'); if (c && c.dataset.q && (e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); open(c.dataset.q); } });
      el.querySelector('#insShuffle').addEventListener('click', deal);
      el.querySelector('#insAsk').addEventListener('submit', function (e) {
        e.preventDefault();
        var inp = el.querySelector('#insQ'), q = inp.value.trim().slice(0, 200); if (!q) return;
        inp.blur();
        var own = el.querySelector('#insOwn'), box = document.createElement('div'); own.innerHTML = ''; own.appendChild(box);
        box.className = 'sx-card ins-card ins-skel'; box.textContent = 'Reading the board'; box.style.marginBottom = '6px';
        delete CACHE[q.toLowerCase()];
        answer(q).then(function (R) { fill(box, {type: 'own', q: q}, R); box.style.marginBottom = '6px'; if (OnyxAsk.logSearch) OnyxAsk.logSearch(q, R, 'studio'); }, function (e2) { box.className = 'sx-card'; box.innerHTML = '<p class="ins-honest">Search is still loading (' + u.esc(e2.message) + '). Try again in a moment.</p>'; });
      });
      // the slip changed elsewhere (the floating slip, another tab): keep "+ Slip" honest
      window.addEventListener('onyx-slip', function () {
        Array.prototype.forEach.call(el.querySelectorAll('[data-r]'), function (b) { var p = ROWS[b.dataset.r]; if (!p) return; var on = slipOn(p); b.classList.toggle('on', on); b.textContent = on ? 'On slip' : '+ Slip'; });
      });

      // self-check (tools/verify_studio.js): at least 6 cards answered or honestly empty, none through the AI
      Studio.checks.insights = function () {
        if (!page.hidden) return '';
        var cards = Array.prototype.slice.call(grid.querySelectorAll('.ins-card[data-state]'));
        var bad = cards.filter(function (c) {
          if (c.dataset.state === 'ok') return !c.querySelector('.ins-take') || !c.querySelector('.ins-take').textContent.trim() || !c.querySelector('.ins-pl');
          return !c.querySelector('.ins-honest') || !c.querySelector('.ins-honest').textContent.trim();
        });
        var ai = cards.filter(function (c) { return c.dataset.via === 'ai'; }).concat(CARDS.filter(function (x) { return x.via === 'ai'; }));
        if (cards.length < 6) return 'only ' + cards.length + ' insight cards rendered';
        if (bad.length) return bad.length + ' card(s) with no answer and no note: ' + bad[0].dataset.q;
        if (ai.length) return ai.length + ' card(s) used the AI path';
        return '';
      };

      deal();
      route();
      return {show: route};
    }
  });
})();
