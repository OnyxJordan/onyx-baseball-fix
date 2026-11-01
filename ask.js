// ask.js - "Ask Onyx": type what you want, get plays or a parlay built from today's boards.
//
// The plays always come from our models and Onyx's live prices (data/<sport>/board.json,
// written by every build through daily_top.write_board). Language is only turned into a
// FILTER SPEC, never into picks:
//   1. if ai.json names a relay URL (ai/worker.js, deployed by .github/workflows/ai_worker.yml),
//      the sentence goes there and comes back as a spec
//   2. otherwise (or if the relay fails) a built-in parser reads the common requests
// The spec is the one contract between the two (ai/worker.js holds the same schema):
//   {intent: "parlay"|"sgp"|"list", count, sports[], markets[], side: "over"|"under"|"any",
//    min_price, max_price, min_conf, min_edge, player, team, sort: "conf"|"rec"|"edge"|"price"|"two_td",
//    one_per_game, summary}
(function () {
  var SPORTS = ['nba', 'nfl', 'cfb', 'nhl', 'tennis'];
  var LG = {nba: 'NBA', nfl: 'NFL', cfb: 'NCAAF', nhl: 'NHL', tennis: 'Tennis'};
  var PAGE = {nba: 'nba.html', nfl: 'nfl.html', cfb: 'cfb.html', nhl: 'nhl.html', tennis: 'tennis.html'};
  var MKTS = ['pts', 'reb', 'ast', 'q1_total', 'h1_total', 'first_basket', 'first_td', 'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'pass_td', 'anytime_td', 'two_plus_td', 'spread', 'total', 'ml'];
  var BOARD = null, AI = null, PRIOR = [];

  function getJSON(u) { return fetch(u, {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  function loadBoards() {
    if (BOARD) return Promise.resolve(BOARD);
    var prior = getJSON('data/nba/prior.json').then(function (P) {
      PRIOR = Object.keys(P || {}).map(function (k) { var r = P[k]; return {n: r.n, ppg: r.gp ? r.pts / r.gp : 0}; });
    }).catch(function () {});
    return Promise.all(SPORTS.map(function (k) { return getJSON('data/' + k + '/board.json').catch(function () { return null; }); }).concat([prior]))
      .then(function (fs) { BOARD = []; fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { BOARD.push(p); }); }); return BOARD; });
  }
  function aiUrl() {
    if (AI !== null) return Promise.resolve(AI);
    return getJSON('ai.json').then(function (j) { AI = (j && j.url) || ''; return AI; }).catch(function () { AI = ''; return AI; });
  }

  // ── the built-in parser: no AI, no keys. Reads the request against today's
  // boards, so it knows every player and team that has a line today. ─────────
  var WORDS = [
    [/\b(1st|first)\s*(td|touchdown|scorer of the game|to score)\b|\bftd\b|\bfirst (td|touchdown) scorer\b/, 'first_td'],
    [/\b(1st|first)\s*(basket|bucket|field goal|points? of the game|to score in)\b|\bfirst baskets?\b/, 'first_basket'],
    [/\b(1st|first)[\s-]*half\b|\b1h\b|\bh1\b|\bhalftime\b/, 'h1_total'],
    [/\bpass(ing)?\s*(td|tds|touchdowns?)\b|\b(td|touchdown) pass(es)?\b|\b(qb|quarterback)s?('s)? (td|tds|touchdowns?)\b/, 'pass_td'],
    [/\b(2|two)\+?\s*(td|tds|touchdowns?)\b|\bmultiple (td|tds|touchdowns)\b|\bmulti[\s-]?td\b|\bdouble (td|tds|touchdown)/, 'two_plus_td'],
    [/\b(anytime\s*)?(td|tds|touchdowns?)\b|\b(td|touchdown) scorers?\b|\bfind the end ?zone\b|\bscore a td\b/, 'anytime_td'],
    [/\b(1st|first)[\s-]*(quarter|q)\b|\b1q\b|\bq1\b/, 'q1_total'],
    [/\brebound(s|ing|er|ers)?\b|\breb\b|\bboards\b|\brebs\b/, 'reb'],
    [/\bassists?\b|\bast\b|\bdimes\b|\bdishes\b/, 'ast'],
    [/\breceptions?\b|\bcatches\b|\brecs\b/, 'rec'],
    [/\breceiving\b|\brec(eiving)? yds\b|\breceivers?\b|\bwideouts?\b|\bwrs?\b|\btight ends?\b/, 'rec_yds'],
    [/\brushing\b|\brush\b|\brushers?\b|\bcarries\b|\bground game\b|\brunning backs?\b|\brbs?\b/, 'rush_yds'],
    [/\bpassing\b|\bpass yards\b|\bpassers?\b|\bqbs?\b|\bquarterbacks?\b|\bthrowing\b/, 'pass_yds'],
    [/\bpoints?\b(?!\s*guards?)|\bpts\b|\bscorers?\b|\bbuckets\b/, 'pts'],
    [/\bspreads?\b|\bcover(s|ing)?\b|\bpuck ?lines?\b|\bhandicap\b|\bats\b/, 'spread'],
    [/\b(game )?totals?\b|\bo\/u\b|\bover ?\/? ?unders?\b|\bover[\s-]unders?\b/, 'total'],
    [/\bmoney ?lines?\b|\bml\b|\bto win\b(?!\s*(about|around)?\s*\+?\$?\d)|\bwinners?\b|\bstraight up\b|\boutright\b/, 'ml'],
  ];
  var NICK = {
    // NBA
    hawks: 'ATL', celtics: 'BOS', nets: 'BKN', hornets: 'CHA', bulls: 'CHI', cavs: 'CLE', cavaliers: 'CLE', mavs: 'DAL', mavericks: 'DAL',
    nuggets: 'DEN', pistons: 'DET', warriors: 'GS', dubs: 'GS', rockets: 'HOU', pacers: 'IND', clippers: 'LAC', lakers: 'LAL', grizzlies: 'MEM',
    heat: 'MIA', bucks: 'MIL', wolves: 'MIN', timberwolves: 'MIN', pelicans: 'NO', knicks: 'NY', thunder: 'OKC', magic: 'ORL', sixers: 'PHI',
    '76ers': 'PHI', suns: 'PHX', blazers: 'POR', 'trail blazers': 'POR', kings: 'SAC', spurs: 'SA', raptors: 'TOR', jazz: 'UTAH', wizards: 'WSH',
    // NFL
    cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI', bengals: 'CIN', browns: 'CLE', cowboys: 'DAL',
    broncos: 'DEN', lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND', jaguars: 'JAX', jags: 'JAX', chiefs: 'KC', raiders: 'LV',
    chargers: 'LAC', rams: 'LAR', dolphins: 'MIA', vikings: 'MIN', patriots: 'NE', pats: 'NE', saints: 'NO', giants: 'NYG', jets: 'NYJ',
    eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', niners: 'SF', seahawks: 'SEA', bucs: 'TB', buccaneers: 'TB', titans: 'TEN', commanders: 'WSH',
    // NHL
    bruins: 'BOS', sabres: 'BUF', flames: 'CGY', hurricanes: 'CAR', blackhawks: 'CHI', avalanche: 'COL', avs: 'COL', 'blue jackets': 'CBJ', stars: 'DAL',
    'red wings': 'DET', oilers: 'EDM', canes: 'CAR', ducks: 'ANA', 'golden knights': 'VGK', knights: 'VGK', canadiens: 'MTL', habs: 'MTL', predators: 'NSH',
    preds: 'NSH', devils: 'NJ', islanders: 'NYI', rangers: 'NYR', senators: 'OTT', flyers: 'PHI', penguins: 'PIT', pens: 'PIT', sharks: 'SJ', kraken: 'SEA',
    blues: 'STL', lightning: 'TB', bolts: 'TB', 'maple leafs': 'TOR', leafs: 'TOR', canucks: 'VAN', capitals: 'WSH', caps: 'WSH', winnipeg: 'WPG', 'utah hockey': 'UTAH'
  };
  var SPORT_OF_NICK = {jets: 'nfl', kings: 'nba', panthers: 'nfl', rangers: 'nhl', cardinals: 'nfl', giants: 'nfl'};
  // every nickname's league, from the order NICK lists them in (NBA, then NFL, then NHL)
  (function () {
    var cur = 'nba';
    Object.keys(NICK).forEach(function (k) {
      if (k === 'cardinals') cur = 'nfl'; else if (k === 'bruins') cur = 'nhl';
      if (!SPORT_OF_NICK[k]) SPORT_OF_NICK[k] = cur;
    });
  })();
  // the sport a team or player is in today: from today's boards first
  function sportsOn(B, test) {
    var o = {}; (B || []).forEach(function (p) { if (test(p)) o[p.sport] = 1; }); return Object.keys(o);
  }
  var NUMW = {one: 1, a: 1, two: 2, couple: 2, double: 2, three: 3, few: 3, triple: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
  var DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // what people call stars: always the player they mean
  var FAMOUS = {giannis: 'Giannis Antetokounmpo', 'the greek freak': 'Giannis Antetokounmpo', 'greek freak': 'Giannis Antetokounmpo', luka: 'Luka Doncic', lebron: 'LeBron James', bron: 'LeBron James',
    steph: 'Stephen Curry', kd: 'Kevin Durant', wemby: 'Victor Wembanyama', sga: 'Shai Gilgeous-Alexander', shai: 'Shai Gilgeous-Alexander',
    jokic: 'Nikola Jokic', joker: 'Nikola Jokic', embiid: 'Joel Embiid', ant: 'Anthony Edwards', 'ant man': 'Anthony Edwards', ad: 'Anthony Davis',
    'the brow': 'Anthony Davis', dame: 'Damian Lillard', kat: 'Karl-Anthony Towns', jb: 'Jaylen Brown', cp3: 'Chris Paul', harden: 'James Harden',
    booker: 'Devin Booker', tatum: 'Jayson Tatum', mahomes: 'Patrick Mahomes', 'josh allen': 'Josh Allen', lamar: 'Lamar Jackson', burrow: 'Joe Burrow',
    cmc: 'Christian McCaffrey', jj: 'Justin Jefferson', 'ja\'marr': "Ja'Marr Chase", jamarr: "Ja'Marr Chase", ceedee: 'CeeDee Lamb', bijan: 'Bijan Robinson',
    saquon: 'Saquon Barkley', kelce: 'Travis Kelce', henry: 'Derrick Henry', gibbs: 'Jahmyr Gibbs', jalen: 'Jalen Hurts', hurts: 'Jalen Hurts', puka: 'Puka Nacua', 'amon-ra': 'Amon-Ra St. Brown', 'st brown': 'Amon-Ra St. Brown', ovi: 'Alex Ovechkin',
    mcdavid: 'Connor McDavid', mackinnon: 'Nathan MacKinnon', alcaraz: 'Carlos Alcaraz', sinner: 'Jannik Sinner', djokovic: 'Novak Djokovic'};
  function clean(n) { return String(n || '').toLowerCase().replace(/[’']/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim(); }
  // everyone a request could name: players with a line today, plus every NBA player on
  // record (data/nba/prior.json) so a star without a line tonight is still recognised.
  // prominence = points a game last season, plus a little for each line Onyx prices on him
  function names(B, P) {
    var C = {};
    function add(name, score) {
      var k = clean(name); if (!k || k.split(' ').length < 2) return;
      var c = C[k] || (C[k] = {name: name, score: 0});
      c.score += score;
    }
    // NFL / college players have no points-a-game on file: their lines say how big a part they are
    var YW = {pass_yds: 0.1, rush_yds: 0.25, rec_yds: 0.25, rec: 3};
    (B || []).forEach(function (p) {
      if (p.kind !== 'prop' || !p.name || /_total$/.test(p.mkt) || /\bD\/ST\b|\bdefense\b/i.test(p.name)) return;
      add(p.name, 0.5 + (YW[p.mkt] && p.side === 'over' ? YW[p.mkt] * (p.line || 0) : 0));
    });
    (P || []).forEach(function (r) { add(r.n, r.ppg); });
    return C;
  }
  // team names on today's boards (daily_top.write_board adds "tn": the full name): the full
  // name, the school or city (name minus the mascot), and the mascot, each pointing to the
  // abbreviation the board uses. Built once per board.
  var TIDX = null;
  function teamIndex(B) {
    if (TIDX && TIDX.b === B) return TIDX.i;
    var I = {};
    function put(k, abbr, sport, pri) {
      k = clean(k); if (!k || k.length < 4 || NOT_NAMES.test(k) || NICK[k]) return;
      if (!I[k] || I[k].pri > pri) I[k] = {abbr: abbr, sport: sport, pri: pri};
    }
    (B || []).forEach(function (p) {
      if (!p.tn) return;
      var abbr = p.kind === 'prop' ? p.team : (p.team || p.name); if (!abbr) return;
      var w = clean(p.tn).split(' ');
      put(w.join(' '), abbr, p.sport, 0);
      if (w.length >= 2) put(w.slice(0, -1).join(' '), abbr, p.sport, 1);     // "ohio state", "green bay"
      if (w.length >= 3) put(w.slice(-2).join(' '), abbr, p.sport, 2);         // "crimson tide"
      put(w[w.length - 1], abbr, p.sport, 3);                                   // "buckeyes"
      if (w.length >= 3) put(w.slice(0, -2).join(' '), abbr, p.sport, 4);     // "alabama" (from "Alabama Crimson Tide")
    });
    TIDX = {b: B, i: I};
    return I;
  }
  function lev1(a, b) {                    // true when a and b are at most one edit apart
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  var NOT_NAMES = /^(will|wills|rebound|rebounds|assist|catch|rush|pass|likely|likes|half|halves|quarter|quarters|scorer|scorers|rusher|rushers|receiver|receivers|passer|leading|leader|top|round|robin|basket|bucket|touchdown|touchdowns|totals|chance|chances|safest|lock|locks|tonight|tomorrow|night|slate|card|board|sharp|steam|juice|payout|pays|winner|winners|underdog|underdogs|favorite|favorites|again|every|other|their|there|these|those|about|around|would|could|should|shot|shots|star|stars|over|under|overs|unders|most|plus|game|games|best|safe|safest|team|teams|with|tonight|today|points|value|parlay|legs|leg|lock|bets|plays|picks|money|line|lines|odds|total|totals|spread|score|scores|win|wins|first|anytime|rebounds|assists|yards|receptions|sunday|monday|tuesday|wednesday|thursday|friday|saturday|week|weekend|give|what|which|who|like|need|want|good|more|less|than|from|this|that|the|and|for|nba|nfl|nhl|tennis|college|longshots|dogs|favorites|fade|stack|sgp|props|prop|player|players|ticket|double|triple|edge|bet|play|pick|side|sides|only|just|ats|ml|moneyline|moneylines|spreads|run|runs|puck|goal|goals|alt|alts|alternate|ladder|live|hedge|cover|covers|dog|fav|favs|chalk|lean|leans|model|onyx|parlays|sgps|plus|minus|even|safe|hammer|nuke|banker|bankers|longshot|sleeper|sleepers|fades|tail|tails|boost|boosts|power|prime|primetime|early|late|slate|main|night|afternoon|morning|home|away|road|big|small|low|high|long|short|hot|cold|streak|streaks|trend|trends|units|unit|bankroll|book|books|price|prices|number|numbers|key|keys|half|full|period|periods|inning|innings|set|sets|match|matches|fight|fights|card|cards|round|rounds|teaser|teasers|correlated|stacked|same|different|any|all|both|each|either|neither|one|two|three|four|five|six|seven|eight|nine|ten|twelve|dozen|couple|few|some|many|much|pair|guard|guards|center|centers|forward|forwards|wing|wings|qb|qbs|rb|rbs|wr|wrs|te|tes|upset|upsets|value|sharp|sharpest|night|monday|sunday)$/;
  function findPlayer(t, C) {
    var keys = Object.keys(C), words = t.trim().split(/\s+/);
    var best = function (cands) { return cands.sort(function (a, b) { return C[b].score - C[a].score; })[0]; };
    // 1. a full name ("Luka Garza" is Garza, even though "Luka" alone is Doncic)
    var full = keys.filter(function (k) { return t.indexOf(' ' + k + ' ') >= 0; });
    if (full.length) return C[best(full)].name;
    // 2. a nickname or a star's one word name
    var fam = Object.keys(FAMOUS).sort(function (a, b) { return b.length - a.length; });
    for (var f = 0; f < fam.length; f++) if (new RegExp('(^|\\s)' + esc(fam[f]) + 's?(\\s|$)').test(t)) return FAMOUS[fam[f]];
    // 3. a last name: the most prominent player who has it
    var lastHit = keys.filter(function (k) { var l = k.split(' ').pop(); return l.length >= 3 && !NICK[l] && !NOT_NAMES.test(l) && words.some(function (w) { return !NOT_NAMES.test(w) && (w === l || w === l + 's'); }); });
    if (lastHit.length) return C[best(lastHit)].name;
    // 4. a first name, or a name one letter off ("luke", "jokick"): every player it could
    // mean competes and the most prominent wins, so "luke" is Luka Doncic, not a bench Luke
    var loose = keys.filter(function (k) {
      var parts = k.split(' ');
      return words.some(function (w) {
        if (w.length < 3 || NOT_NAMES.test(w) || NICK[w] || NICK[w.replace(/s$/, '')]) return false;
        if (w === parts[0]) return true;
        return w.length >= 5 && parts.some(function (n) { return n.length >= 5 && lev1(w, n); });
      });
    });
    if (loose.length) return C[best(loose)].name;
    return null;
  }

  function localSpec(q, B) {
    var t = ' ' + q.toLowerCase().replace(/[’']/g, '').replace(/[?!,]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var s = {intent: 'list', count: null, sports: [], markets: [], side: 'any', min_price: null, max_price: null, min_conf: null,
             min_edge: null, player: null, team: null, sort: 'conf', one_per_game: true, when: null, summary: ''};
    // what kind of answer
    if (/sgp ?(\+|plus)/.test(t)) s.intent = 'parlay';
    else if (/\bsgp\b|same[\s-]*game|correlated|stack/.test(t)) s.intent = 'sgp';
    else if (/parlay|\blegs?\b|legger|ticket|\bslip\b|\bcombo\b|\bdouble\b|\btriple\b|\bteaser\b/.test(t)) s.intent = 'parlay';
    // a round robin: "round robin 4 picks by 2s", "rr of 5 by 3s"
    var rr = t.match(/\b(round[\s-]*robin|\brr\b)/);
    if (rr) {
      s.intent = 'rr';
      var by = t.match(/\bby\s*(\d|twos|threes|fours|2s|3s|4s)\b/) || t.match(/\b(\d)s\b/);
      s.rr_size = by ? ({twos: 2, threes: 3, fours: 4})[by[1]] || parseInt(by[1], 10) : 2;
    }
    // a payout target: "parlay that pays +500", "to win around +1000", "a +300 parlay"
    var tg = t.match(/\b(pays?|paying|payout( of)?|to (win|pay)|around|about|returns?)\s*\+?(\d{3,5})\b/) || t.match(/\+(\d{3,5})\s*(parlay|ticket|sgp|legger)\b/);
    var tgv = tg ? +(tg.slice(1).filter(function (x) { return x && /^\d+$/.test(x); })[0]) : null;
    if (tgv && /parlay|ticket|legs?\b|legger|sgp|round/.test(t)) { if (s.intent === 'list') s.intent = 'parlay'; s.target_price = tgv; }
    // how many
    var n = t.match(/\b(\d{1,2})[\s-]*(leg|legs|legger|picks?|plays?|players?|bets?|team|man|teamer)\b/) || t.match(/\btop\s*(\d{1,2})\b/)
      || t.match(/\bparlay of (\d{1,2})\b/) || t.match(/\b(\d{1,2})\s+(nba|nfl|nhl|college|tennis)\b/);
    var nw = t.match(/\b(two|three|four|five|six|seven|eight|nine|ten|couple|few)( of)?[\s-]*(leg|legs|legger|picks?|plays?|bets?|team|man)\b/);
    if (!n && !nw) {
      var n2 = t.match(/\b(\d{1,2})\s+(?:\w+\s+){0,2}?(overs|unders|props|plays|picks|bets|players|teams|sides|dogs|favorites|favs|scorers|rebounds|assists|points|receptions|touchdowns|tds|totals|spreads)\b/);
      if (n2 && +n2[1] <= 12 && !/\b\d{1,2}\s+(points|rebounds|assists|receptions|tds|touchdowns)\s+(or|and|in|a|per)\b/.test(t)) n = [n2[0], n2[1]];
      else if (/\b(a )?pair of\b/.test(t)) nw = [null, 'two'];
      else if (/\b(one|a single|1)\s+(\w+\s+){0,2}?(bet|play|pick|prop|leg)\b(?!s)/.test(t)) nw = [null, 'one'];
    }
    s.count_set = !!(n || nw);
    s.count = n ? +n[1] : nw ? NUMW[nw[1]] : /\bdouble\b/.test(t) && s.intent === 'parlay' ? 2 : /\btriple\b/.test(t) && s.intent === 'parlay' ? 3 : null;
    // which sport
    if (/\bnba\b|basketball|hoops/.test(t)) s.sports.push('nba');
    if (/\bnfl\b|pro football|\bfootball\b(?! college)/.test(t) && !/college football|ncaa ?f?\b|ncaa football/.test(t)) s.sports.push('nfl');
    if (/college|ncaa|\bcfb\b|ncaaf/.test(t)) s.sports.push('cfb');
    if (/\bnhl\b|hockey/.test(t)) s.sports.push('nhl');
    if (/tennis|\batp\b|\bwta\b/.test(t)) s.sports.push('tennis');
    // which markets
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i][0].test(t) && s.markets.indexOf(WORDS[i][1]) < 0) {
      if (WORDS[i][1] === 'anytime_td' && (s.markets.indexOf('two_plus_td') >= 0 || s.markets.indexOf('first_td') >= 0 || s.markets.indexOf('pass_td') >= 0)) continue;
      if (WORDS[i][1] === 'pass_yds' && s.markets.indexOf('pass_td') >= 0 && !/\byards\b|\byds\b/.test(t)) continue;
      if (WORDS[i][1] === 'q1_total' && (s.markets.indexOf('first_td') >= 0 || s.markets.indexOf('first_basket') >= 0)) continue;
      // "total receptions", "total points for Jokic": a player's total, not the game total
      if (WORDS[i][1] === 'total' && /\btotal (receptions|catches|yards|rushing|passing|receiving|rebounds|assists|boards|dimes|tds|touchdowns|points|pts|bases|hits)\b/.test(t)) continue;
      if (WORDS[i][1] === 'pts' && /\b(first|1st) (basket|bucket|points? of)/.test(t) && !/\bpoints\b(?! of)/.test(t.replace(/(first|1st) points? of/, ''))) continue;
      if (WORDS[i][1] === 'pts' && (/\b(score|scorer)s? (a |an )?(td|touchdown)/.test(t) || /td|touchdown/.test(t))) continue;
      if (WORDS[i][1] === 'total' && /(first|1st)[\s-]*(half|quarter)|\b1h\b|\b1q\b/.test(t)) continue;
      s.markets.push(WORDS[i][1]);
    }
    // "sides", "game lines", "ATS": the game, not a player (spreads and moneylines; totals too for "game lines")
    if (/\bsides?\b|\bteams? to (win|cover)\b|\bteam bets?\b/.test(t) && !/\bboth sides\b/.test(t)) ['spread', 'ml'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    if (/\bgame lines?\b|\bmain lines?\b|\bgame bets?\b|\bstraight bets? on games\b/.test(t)) ['spread', 'ml', 'total'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    // "rushing yards over under" is the player's line, not the game total
    if (s.markets.indexOf('total') >= 0 && !/\b(game )?totals?\b/.test(t) && s.markets.some(function (m) { return /^(pts|reb|ast|rec|rec_yds|rush_yds|pass_yds|pass_td)$/.test(m); })) s.markets.splice(s.markets.indexOf('total'), 1);
    // a position word only names a market when no stat was named ("wr receptions" is receptions)
    if (s.markets.indexOf('rec') >= 0 && s.markets.indexOf('rec_yds') >= 0 && !/receiving|\byards\b|\byds\b/.test(t)) s.markets.splice(s.markets.indexOf('rec_yds'), 1);
    if (s.markets.indexOf('first_td') >= 0 && /\bnba\b|basketball|bucket|basket|hoops/.test(t) && !/\btds?\b|touchdown/.test(t)) s.markets[s.markets.indexOf('first_td')] = 'first_basket';
    if (/\byards\b|\byds\b/.test(t) && !s.markets.some(function (m) { return /yds/.test(m); })) s.markets.push('rec_yds', 'rush_yds', 'pass_yds');
    if (/\bscore (the )?most\b|\bmost points\b|\btop (point )?scorers?\b|\bleading scorer\b|\bdrop (the )?most\b|\bhighest scor/.test(t)) { if (s.markets.indexOf('pts') < 0) s.markets.push('pts'); s.sort = 'proj'; s.side = 'over'; }
    if (/\bpra\b|pts ?\+ ?reb ?\+ ?ast/.test(t)) ['pts', 'reb', 'ast'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    // "favorites" / "dogs" with no market named: to win (moneyline); "favorite play / pick / prop" is a recommendation, not this
    var favW = /\bfavou?rites\b|\bfavs\b|\bchalk\b|\bfavou?rite\b(?!\s+(\w+\s+){0,2}(plays?|picks?|props?|bets?|sgps?|parlays?|tickets?|leans?|sides?|legs?))/.test(t) && !/\b(your|our|onyx'?s?|the model'?s?|my) favou?rites?\b/.test(t);
    var dogW = /\bunderdogs?\b|\bdogs\b/.test(t);
    var propsW = /\bprops?\b|\bplayer (bets?|lines?|markets?)\b/.test(t) && !/\bgame props?\b/.test(t);
    if ((favW || dogW) && !s.markets.length && !propsW) s.markets.push('ml');
    if (favW && !dogW && s.markets.length === 1 && s.markets[0] === 'ml') s.max_price = s.max_price == null ? -101 : Math.min(s.max_price, -101);
    if (propsW) s.props_only = true;
    // over / under
    var ov = /\bovers?\b|\bhit the over\b|\bgo over\b|\bclear\b/.test(t.replace(/\bover\s*[+-]\d/g, '').replace(/over\/under/g, '')),
        un = /\bunders?\b|\bstay under\b|\bfade\b/.test(t.replace(/\bunder\s*[+-]\d/g, '').replace(/over\/under/g, ''));
    if (/over ?(\/|or|and|-)? ?under|o\/u/.test(t)) { ov = false; un = false; }
    if (ov && !un) s.side = 'over';
    if (un && !ov) s.side = 'under';
    // odds, in any wording. A floor: "-200 or better", "min -200", "nothing worse than -200",
    // "no -200 juice". A ceiling: "+300 or less", "max +300", "under +300".
    var fl = t.match(/(min(imum)?( odds)?( of)?|no (worse|shorter|juicier) than|nothing (worse|shorter|juicier) than|at least|odds( of)?|better than|above)\s*([+-]?\d{3,4})/)
      || t.match(/([+-]\d{3,4})\s*(or better|or longer|and up|or more|minimum|min\b|floor)/) || t.match(/\bno\s*(-\d{3,4})\s*(juice|or worse)?/);
    if (fl) { var v = +(fl[fl.length - 1] && /\d/.test(fl[fl.length - 1]) ? fl[fl.length - 1] : (fl[1] || fl[fl.length - 1])); if (!isNaN(v)) s.min_price = v; }
    var fl2 = t.match(/([+-]\d{3,4})\s*(or better|or longer|and up|or more|minimum|floor)/); if (fl2) s.min_price = +fl2[1];
    var nojuice = t.match(/\bno\s*(-\d{3,4})/); if (nojuice) s.min_price = +nojuice[1] + 1;
    var btw = t.match(/between\s*([+-]?\d{3,4})\s*(and|to|-)\s*([+-]?\d{3,4})/);
    if (btw) { s.min_price = Math.min(+btw[1], +btw[3]); s.max_price = Math.max(+btw[1], +btw[3]); }
    var mx = btw ? null : t.match(/(max(imum)?( odds)?|no (longer|better) than|below|at most|or less than)\s*([+-]\d{3,4})/) || t.match(/([+-]\d{3,4})\s*(or less|or shorter|max|cap)/);
    if (mx) { var w = +(mx[mx.length - 1] && /\d/.test(mx[mx.length - 1]) ? mx[mx.length - 1] : mx[1]); if (!isNaN(w)) s.max_price = w; }
    if (/plus money|plus[\s-]odds|\+ ?odds|underdogs?|\bdogs\b|long ?shots?|\bvalue dogs?\b/.test(t)) s.min_price = Math.max(s.min_price == null ? 100 : s.min_price, 100);
    if (/even money|around even|near even|pick ?em/.test(t)) { s.min_price = -125; s.max_price = 125; }
    if (/\bfavou?rites?\b|\bchalk\b/.test(t) && /\bml\b|money ?line|to win|\bwin\b/.test(t)) s.max_price = Math.min(s.max_price == null ? -101 : s.max_price, -101);
    // ordering
    if (/most likely|safest|safe\b|locks?\b|highest (chance|confidence|probability|hit rate)|sure ?thing|surest|can.?t lose|banker/.test(t)) s.sort = 'conf';
    if (/recommend|favou?rite (play|pick|bet|sgp|parlay)|best (picks?|plays?|bets?)|top picks?|your picks?|should i (bet|play)|what do you like|you like|pick of the (day|night)|play of the (day|night)|best bet/.test(t)) s.sort = 'rec';
    if (/\bvalue\b|most value|best value|biggest edge|\bedge\b|beats? (the )?(line|price|onyx|book)|mispriced|soft line|\b\+ev\b|positive ev/.test(t)) s.sort = 'edge';
    if (/biggest payout|longshots?|long shots?|lottery|moonshot|highest odds|big payout/.test(t)) s.sort = 'price';
    if (/lock of the|pick of the|play of the|bet of the|prop of the|best bet\b|the lock\b|(highest|best|top|most likely|safest) (\w+ ){0,3}(prop|play|pick|bet|scorer)\b(?!s)/.test(t) && s.count == null && s.intent === 'list') s.count = 1;
    // confidence floor: "60%", "60 percent", "over 60%"
    var c = t.match(/(\d{2})\s*(%|percent)/); if (c) s.min_conf = +c[1] / 100;
    // time: tonight / today / tomorrow / a weekday / this weekend
    if (/tonight|today|this evening/.test(t)) s.when = 'today';
    else if (/tomorrow/.test(t)) s.when = 'tomorrow';
    else if (/this weekend|weekend/.test(t)) s.when = 'weekend';
    else for (var d = 0; d < 7; d++) if (new RegExp('\\b' + DAYS[d] + '\\b').test(t)) { s.when = DAYS[d]; break; }
    // a team by its name on today's boards ("ohio state", "georgia tech", "buckeyes", "green bay"):
    // the longest name in the request wins, so "georgia tech" is not Georgia
    var TI = teamIndex(B), tkeys = Object.keys(TI).sort(function (a, b) { return b.length - a.length || TI[a].pri - TI[b].pri; });
    var tPlayer = t;
    for (var ti = 0; ti < tkeys.length; ti++) {
      if (new RegExp('(^|\\s)' + esc(tkeys[ti]) + 's?(\\s|$)').test(t)) {
        s.team = TI[tkeys[ti]].abbr;
        if (!s.sports.length) s.sports.push(TI[tkeys[ti]].sport);
        tPlayer = t.replace(new RegExp('(^|\\s)' + esc(tkeys[ti]) + 's?(?=\\s|$)'), ' ');
        break;
      }
    }
    // a team, by nickname or abbreviation
    var keys = Object.keys(NICK).sort(function (a, b) { return b.length - a.length; });
    for (var k = 0; k < keys.length && !s.team; k++) {
      var nk_ = keys[k];
      if (new RegExp('\\b' + esc(nk_) + '\\b').test(t)) {
        s.team = NICK[keys[k]];
        if (!s.sports.length) {
          var lg = SPORT_OF_NICK[nk_], on = sportsOn(B, function (p) { return (p.team || (p.kind !== 'prop' ? p.name : '')) === s.team && (!lg || p.sport === lg); });
          s.sports.push(on.length === 1 ? on[0] : lg || 'nba');
        }
        if (nk_ === 'jets' && /hockey|nhl|winnipeg/.test(t)) s.team = 'WPG';
        break;
      }
    }
    if (!s.team) {
      // big college programs by name, any day (today's boards cover the rest)
      var CFBN = {alabama: 'ALA', 'crimson tide': 'ALA', michigan: 'MICH', wolverines: 'MICH', 'notre dame': 'ND', texas: 'TEX', longhorns: 'TEX',
        'ohio state': 'OSU', buckeyes: 'OSU', georgia: 'UGA', bulldogs: 'UGA', clemson: 'CLEM', oregon: 'ORE', ducks: 'ORE', 'penn state': 'PSU',
        tennessee: 'TENN', auburn: 'AUB', florida: 'FLA', gators: 'FLA', oklahoma: 'OU', sooners: 'OU', miami: 'MIA', wisconsin: 'WIS', iowa: 'IOWA',
        nebraska: 'NEB', 'texas a&m': 'TA&M', 'texas am': 'TA&M', aggies: 'TA&M', 'florida state': 'FSU', seminoles: 'FSU', 'michigan state': 'MSU',
        'ole miss': 'MISS', 'mississippi state': 'MSST', kentucky: 'UK', arkansas: 'ARK', missouri: 'MIZ', 'south carolina': 'SC', vanderbilt: 'VAN',
        'virginia tech': 'VT', louisville: 'LOU', 'north carolina': 'UNC', duke: 'DUKE', stanford: 'STAN', washington: 'WASH', utah: 'UTAH',
        colorado: 'COLO', 'arizona state': 'ASU', arizona: 'ARIZ', 'kansas state': 'KSU', kansas: 'KU', 'iowa state': 'ISU', baylor: 'BAY',
        'texas tech': 'TTU', 'oklahoma state': 'OKST', 'boise state': 'BSU', byu: 'BYU', 'west virginia': 'WVU', purdue: 'PUR', indiana: 'IU',
        minnesota: 'MINN', illinois: 'ILL', northwestern: 'NU', rutgers: 'RUTG', maryland: 'MD', 'georgia tech': 'GT', pitt: 'PITT', syracuse: 'SYR'};
      if (!s.team) {
        var ck = Object.keys(CFBN).sort(function (a, b) { return b.length - a.length; });
        for (var ci = 0; ci < ck.length; ci++) if (new RegExp('(^|\\s)' + esc(ck[ci]) + '(\\s|$)').test(t) && !(ck[ci] === 'miami' && /dolphins|heat|marlins/.test(t)) && !(ck[ci] === 'utah' && /jazz|hockey|nhl|mammoth/.test(t))) {
          s.team = CFBN[ck[ci]]; if (!s.sports.length) s.sports.push('cfb'); tPlayer = tPlayer.replace(ck[ci], ' '); break;
        }
      }
      // college abbreviations nobody types as a word: any case ("lsu spread")
      var col = t.match(/\b(lsu|usc|ucla|tcu|smu|byu|ucf|fsu|unlv|utsa|utep|uconn|umass|unc|ole miss)\b/);
      if (col) { s.team = ({unc: 'UNC', 'ole miss': 'MISS'})[col[1]] || col[1].toUpperCase(); if (!s.sports.length) s.sports.push('cfb'); }
      // abbreviations only when typed in capitals ("MIN -200" is odds, "MIN" is Minnesota)
      var tm = s.team ? null : String(q).match(/\b(ATL|BOS|BKN|CHA|CHI|CLE|DAL|DEN|DET|GS|GSW|HOU|IND|LAC|LAL|MEM|MIA|MIL|MIN|NOP|NYK|OKC|ORL|PHI|PHX|POR|SAC|SAS|TOR|UTAH|UTA|WSH|WAS|ARI|BAL|BUF|CAR|CIN|GB|JAX|KC|LV|LAR|NE|NYG|NYJ|PIT|SEA|SF|TB|TEN|VGK|EDM|COL|NYR|NYI|NJ|CBJ|WPG|VAN|CGY|OTT|MTL|NSH|STL|SJ|ANA|LSU|USC|UCLA|TCU|SMU|BYU|UCF|OSU|PSU|UGA|FSU)\b/);
      if (tm) s.team = ({GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH'})[tm[1]] || tm[1];
    }
    // a player: a nickname, a full name, a last or first name (the most prominent one), or one letter off
    s.player = findPlayer(tPlayer, names(B, PRIOR));
    if (s.player) {
      s.team = null; if (s.intent === 'list' && s.count == null && !/props|plays|lines|bets/.test(t)) s.count = 5;
      if (!s.sports.length) {
        var pl = String(s.player).toLowerCase(), on2 = sportsOn(B, function (p) { return p.kind === 'prop' && String(p.name || '').toLowerCase() === pl; });
        if (on2.length) s.sports = on2;
        else if ((PRIOR || []).some(function (r) { return String(r.n).toLowerCase() === pl; })) s.sports = ['nba'];
        else if (/mcdavid|ovechkin|mackinnon|matthews|draisaitl|kucherov|makar|crosby/.test(pl)) s.sports = ['nhl'];
        else if (/alcaraz|sinner|djokovic|sabalenka|swiatek|gauff/.test(pl)) s.sports = ['tennis'];
      }
    }
    // defaults that follow from the rest
    if (s.markets.indexOf('two_plus_td') >= 0) { s.sort = 'two_td'; if (!s.sports.length) s.sports = ['nfl']; }
    if (s.markets.indexOf('anytime_td') >= 0 && !s.sports.length) s.sports = ['nfl', 'cfb'];
    if (s.markets.some(function (m) { return /^(pts|reb|ast|q1_total)$/.test(m); }) && !s.sports.length) s.sports = ['nba'];
    if (s.markets.some(function (m) { return /^(rec|rec_yds|rush_yds|pass_yds|pass_td)$/.test(m); }) && !s.sports.length) s.sports = ['nfl'];
    if (s.intent === 'rr' && s.count == null) s.count = 4;
    if (/(rebound|assist|catch|rush|pass|score)s? the most|most (receptions|catches|rushing|passing|receiving|yards|rebounds|assists|boards|dimes)|leading (rusher|receiver|passer|rebounder|scorer)s?|top( \d+)? (rusher|receiver|passer|rebounder|scorer|qb|wr|rb)s?/.test(t)) { s.sort = 'proj'; if (s.side === 'any') s.side = 'over'; }
    if (s.markets.indexOf('first_td') >= 0 && !s.sports.length) s.sports = ['nfl'];
    if ((s.markets.indexOf('first_basket') >= 0 || s.markets.indexOf('h1_total') >= 0) && !s.sports.length) s.sports = ['nba'];
    if (s.count == null && /\bcouple\b/.test(t)) s.count = 2;
    if (s.count == null && /\b(a )?few\b/.test(t)) s.count = 3;
    if (s.count == null) s.count = s.intent !== 'list' ? 3 : /\b(the|a|one) (player|play|pick|bet|guy|team)\b|\bwho (is|will|gets|has)\b|\bmost likely\b/.test(t) && !/players|plays|picks|guys|teams|scorers|receivers|rushers|passers|options|bets|choices/.test(t) ? 1 : 5;
    return s;
  }

  // ── the spec, run against today's boards ────────────────────────────────
  // who a play is about: a player, or for a game line the game and the market (every game total
  // is named "Total", so keying on the name alone kept one total across the whole board)
  function WHO(p) { return p.kind === 'prop' ? p.sport + ':' + p.who : p.sport + ':' + p.gid + ':' + (p.kind === 'spread' || p.kind === 'ml' ? 'side' : p.kind); }
  function p2(lam) { return lam == null ? null : 1 - Math.exp(-lam) * (1 + lam); }
  function dec(o) { return o > 0 ? 1 + o / 100 : 1 + 100 / -o; }
  function am(d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  // the ET calendar day of a start time vs "today" / "tomorrow" / a weekday / the weekend
  // ET wall-clock date for a timestamp; cached, since toLocaleString is slow and every play shares a few start times
  var ETC = {};
  function etDay(t) { var k = typeof t === 'number' ? Math.floor(t / 60000) : t; return ETC[k] || (ETC[k] = new Date(new Date(t).toLocaleString('en-US', {timeZone: 'America/New_York'}))); }
  function whenOk(when, start) {
    var t = Date.parse(start); if (isNaN(t)) return true;
    var g = etDay(t), now = etDay(Date.now() - 4 * 3600e3);   // the site's day rolls at 4 AM ET
    var days = Math.round((new Date(g.getFullYear(), g.getMonth(), g.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    if (g.getHours() < 4) days -= 1;                            // a 1 AM tip belongs to the night before
    if (when === 'today') return days <= 0;
    if (when === 'tomorrow') return days === 1;
    if (when === 'weekend') return g.getDay() === 0 || g.getDay() === 6;
    var wd = DAYS.indexOf(when); return wd < 0 || (g.getDay() === wd && days < 7);
  }
  function run(spec, B) {
    var now = Date.now();
    // "2 legs paying +300": each leg has to carry its share of the payout
    if (spec.intent === 'parlay' && spec.target_price && spec.count_set && spec.count >= 1) {
      var per = Math.pow(1 + spec.target_price / 100, 1 / spec.count);
      var floor = am(per * 0.97);
      if (spec.min_price == null || spec.default_floor || spec.min_price < floor) spec = Object.assign({}, spec, {min_price: floor});
    }
    var mk = (spec.markets || []).slice();
    var two = mk.indexOf('two_plus_td') >= 0 || spec.sort === 'two_td';
    if (two && mk.indexOf('anytime_td') < 0) mk.push('anytime_td');
    var pool = B.filter(function (p) {
      var t = Date.parse(p.start); if (!isNaN(t) && t <= now) return false;
      if (spec.sports && spec.sports.length && spec.sports.indexOf(p.sport) < 0) return false;
      if (mk.length && mk.indexOf(p.mkt) < 0 && mk.indexOf(p.kind) < 0) return false;
      if (spec.props_only && p.kind !== 'prop') return false;
      if (spec.side && spec.side !== 'any' && (p.kind === 'prop' || p.kind === 'total') && p.side !== spec.side) return false;
      if (two) return p.lam != null;
      if (spec.min_price != null && p.price < spec.min_price) return false;
      if (spec.max_price != null && p.price > spec.max_price) return false;
      if (spec.min_conf != null && p.conf < spec.min_conf) return false;
      if (spec.min_edge != null && p.edge < spec.min_edge) return false;
      if (spec.player && String(p.name || p.label).toLowerCase().indexOf(String(spec.player).toLowerCase()) < 0) return false;
      if (spec.team && !new RegExp('(^|[^A-Z])' + String(spec.team).toUpperCase() + '([^A-Z]|$)').test([p.team, p.matchup, p.name].join(' ').toUpperCase())) return false;
      if (spec.team && (p.kind === 'spread' || p.kind === 'ml') && String(p.team || p.name).toUpperCase() !== String(spec.team).toUpperCase()) return false;   // "Georgia to cover" is Georgia's side
      if (spec.when && !whenOk(spec.when, p.start)) return false;
      return true;
    }).map(function (p) { return two ? Object.assign({}, p, {two: p2(p.lam)}) : p; });
    // "recommended": what this site stands behind first (graded picks, then the
    // on-trial lanes), then the blend of confidence and value
    var REC = {tracked: 0.2, trial: 0.1};
    var key = spec.sort === 'two_td' || two ? function (p) { return -p.two; } : spec.sort === 'edge' ? function (p) { return -p.edge; }
      : spec.sort === 'price' ? function (p) { return -p.price; }
      : spec.sort === 'proj' ? function (p) { return -(p.proj || 0); }
      : spec.sort === 'rec' ? function (p) { return -((REC[p.tag] || 0) + p.conf + 2 * Math.max(-0.05, p.edge)); }
      : function (p) { return -p.conf - p.edge / 10; };
    pool.sort(function (a, b) { return key(a) - key(b); });
    // "best value" when nothing in the pool beats Onyx's price (touchdown scorers: none did in
    // testing): ranking by the least-negative edge would just surface longshots, so show the
    // most likely instead and say so
    var note = '';
    if (spec.sort === 'edge' && !two && pool.length && pool[0].edge <= 0) {
      key = function (p) { return -p.conf - p.edge / 10; };
      pool.sort(function (a, b) { return key(a) - key(b); });
      note = (mk.length && mk.every(function (m) { return /td$/.test(m); }) ? 'No touchdown scorer beats Onyx\'s price in our testing' : 'Nothing that matches beats Onyx\'s price right now')
        + ', so these are the most likely instead.';
    }
    if (spec.intent === 'sgp') return sgp(spec, pool, key);
    var n = Math.max(1, Math.min(spec.intent === 'list' ? 25 : 8, spec.count || 5));
    if (spec.intent === 'parlay' && spec.target_price && !spec.count_set) n = 10;   // no leg count asked: add legs until the payout is reached
    var picked = [], games = {}, who = {};
    for (var i = 0; i < pool.length && picked.length < n; i++) {
      var p = pool[i];
      var mine = spec.player && spec.intent === 'list';            // "Mahomes": every line on him
      if (who[WHO(p) + (mine ? p.mkt : '')]) continue;
      if (!mine && (spec.one_per_game !== false || spec.intent === 'parlay') && games[p.gid]) continue;
      who[WHO(p) + (mine ? p.mkt : '')] = 1; games[p.gid] = 1; picked.push(p);
      if (spec.intent === 'parlay' && spec.target_price && !spec.count_set && picked.length >= 2 && ticket(picked).price >= spec.target_price) break;
    }
    // a parlay short of its legs (few games left on the board) fills from games it
    // already uses: an SGP+ (same-game legs plus other games), never one player twice
    if ((spec.intent === 'parlay' || spec.intent === 'rr') && picked.length < n) {
      for (var j = 0; j < pool.length && picked.length < n; j++) {
        var q = pool[j];
        if (who[WHO(q)] || picked.indexOf(q) >= 0) continue;
        if (picked.some(function (x) { return x.gid === q.gid && x.kind === q.kind && q.kind !== 'prop'; })) continue;  // one game line of each kind
        who[WHO(q)] = 1; picked.push(q);
      }
    }
    if (spec.intent === 'parlay' && spec.target_price && !spec.count_set) {          // the filler pass can overshoot: stop at the target
      for (var z = 2; z <= picked.length; z++) if (ticket(picked.slice(0, z)).price >= spec.target_price) { picked = picked.slice(0, z); break; }
    }
    var out = {rows: picked, pool: pool.length, two: two, note: note};
    if (spec.intent === 'rr' && picked.length >= 2) {
      var k = Math.max(2, Math.min(picked.length - 1 || 2, spec.rr_size || 2)), combos = [];
      (function pick(start, cur) {
        if (cur.length === k) { combos.push(Object.assign(ticket(cur), {legs: cur.map(function (x) { return picked.indexOf(x) + 1; })})); return; }
        for (var c2 = start; c2 < picked.length; c2++) pick(c2 + 1, cur.concat([picked[c2]]));
      })(0, []);
      out.rr = {by: k, combos: combos, hit: combos.reduce(function (a, c3) { return a + c3.prob; }, 0) / combos.length};
    }
    if (spec.intent === 'parlay' && picked.length > 1) {
      out.parlay = ticket(picked);
      var g = {}; picked.forEach(function (x) { g[x.gid] = (g[x.gid] || 0) + 1; });
      out.parlay.sgp_plus = Object.keys(g).length < picked.length;
    }
    return out;
  }
  function ticket(legs) {
    var d = 1, pr = 1;
    legs.forEach(function (p) { d *= dec(p.price); pr *= p.conf; });
    return {price: am(d), prob: pr, sels: legs.map(function (p) { return p.sel; }).filter(Boolean)};
  }

  // ── same-game parlay: legs from one game that win TOGETHER ───────────────
  // Every game gets one storyline, set by its best leg (the anchor): a shootout
  // (the total over, players' overs, the anchor team covering) or a grinder (the
  // total under, players' unders). Only legs that fit the story join, one per
  // player, best first; the game whose story the models like most wins.
  // The product of the chances understates a correlated ticket (when the story
  // happens, its legs hit together), so the page calls it a floor.
  function fits(story, anchor, p) {
    if (p.kind === 'total' || p.mkt === 'q1_total') return p.side === story;
    if (p.kind === 'prop') {
      if (p.mkt === 'anytime_td') return story === 'over' && (!anchor.team || p.team === anchor.team || anchor.kind === 'total');
      return p.side === story && (story === 'under' || !anchor.team || anchor.kind === 'total' || p.team === anchor.team || anchor.kind !== 'prop');
    }
    if (p.kind === 'spread' || p.kind === 'ml') return story === 'over' && (anchor.kind === 'total' || p.name === anchor.team || p.name === anchor.name);
    return false;
  }
  function sgp(spec, pool, key) {
    var n = Math.max(2, Math.min(6, spec.count || 3)), by = {};
    pool.forEach(function (p) { if (p.kind !== 'ml' || p.price >= -150) (by[p.gid] = by[p.gid] || []).push(p); });
    var best = null;
    Object.keys(by).forEach(function (gid) {
      var G = by[gid];
      for (var a = 0; a < Math.min(3, G.length); a++) {           // try the game's top three anchors
        var anchor = G[a], story = anchor.kind === 'prop' || anchor.kind === 'total' ? anchor.side : 'over';
        var legs = [anchor], who = {}; who[WHO(anchor)] = 1;
        var kinds = {}; kinds[anchor.kind + (anchor.kind === 'prop' ? '' : anchor.name)] = 1;
        for (var i = 0; i < G.length && legs.length < n; i++) {
          var p = G[i];
          if (p === anchor || who[WHO(p)] || !fits(story, anchor, p)) continue;
          if (p.kind !== 'prop' && kinds[p.kind]) continue;          // one game line of each kind
          who[WHO(p)] = 1; kinds[p.kind] = 1; legs.push(p);
        }
        if (legs.length < 2) continue;
        var t = ticket(legs), score = legs.length * 10 + t.prob;    // the full ticket first, then the likeliest
        if (!best || score > best.score) best = {legs: legs, story: story, t: t, score: score};
      }
    });
    if (!best) return {rows: [], pool: pool.length, sgp: true};
    var g = best.legs[0];
    return {rows: best.legs, pool: pool.length, sgp: true, parlay: Object.assign(best.t, {same_game: true,
      story: best.story === 'over' ? 'Shootout script: every leg wins together if this game runs high-scoring' : 'Grinder script: every leg wins together if this game stays slow and low-scoring',
      matchup: g.matchup})};
  }

  // ── what the spec understood, in plain words ────────────────────────────
  var MW = {pts: 'points', reb: 'rebounds', ast: 'assists', q1_total: '1st-quarter totals', rec: 'receptions', rec_yds: 'receiving yards',
            rush_yds: 'rushing yards', pass_yds: 'passing yards', pass_td: 'passing TDs', anytime_td: 'anytime TD', first_td: 'first TD', first_basket: 'first basket', h1_total: '1st-half totals', two_plus_td: '2+ touchdowns', spread: 'spreads', total: 'totals', ml: 'moneylines'};
  function describe(s) {
    var b = [];
    b.push(s.intent === 'parlay' && s.target_price && !s.count_set ? 'parlay' : s.intent === 'rr' ? 'round robin of ' + (s.count || 4) + ' by ' + (s.rr_size || 2) + 's' : s.intent === 'sgp' ? (s.count || 3) + '-leg same-game parlay, correlated' : s.intent === 'parlay' ? (s.count || 3) + '-leg parlay' : (s.count || 5) === 1 ? 'top play' : 'top ' + (s.count || 5));
    b.push((s.sports || []).length ? s.sports.map(function (k) { return LG[k] || k; }).join(' + ') : 'every sport');
    if ((s.markets || []).length) b.push(s.markets.map(function (m) { return MW[m] || m; }).join(', '));
    if (s.side && s.side !== 'any') b.push(s.side === 'over' ? 'overs only' : 'unders only');
    if (s.target_price) b.push('pays about +' + s.target_price);
    if (s.min_price != null) b.push((s.default_floor ? 'standard prices, nothing shorter than ' : 'no price shorter than ') + (s.min_price > 0 ? '+' : '') + s.min_price);
    if (s.max_price != null) b.push('no price longer than ' + (s.max_price > 0 ? '+' : '') + s.max_price);
    if (s.min_conf != null) b.push(Math.round(100 * s.min_conf) + '%+ confidence');
    if (s.player) b.push(s.player);
    if (s.when) b.push(s.when === 'today' ? 'tonight' : s.when);
    if (s.team) b.push(s.team);
    b.push(s.sort === 'proj' ? 'highest projection first' : s.sort === 'rec' ? 'what we recommend most first' : s.sort === 'price' ? 'biggest payouts first' : s.sort === 'edge' ? 'best value first' : s.sort === 'two_td' ? 'most likely 2+ TDs first' : 'highest confidence first');
    return b.join(' · ');
  }

  function toSpec(q, B) {
    return aiUrl().then(function (u) {
      if (!u) return {spec: localSpec(q, B), via: 'local'};
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 15000);
      return fetch(u, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({q: q}), signal: ctl.signal})
        .then(function (r) { clearTimeout(tm); if (!r.ok) throw new Error('relay ' + r.status); return r.json(); })
        .then(function (j) { if (!j || !j.spec) throw new Error('no spec'); return {spec: j.spec, via: 'ai'}; })
        .catch(function () { return {spec: localSpec(q, B), via: 'local'}; });
    });
  }
  // mainstream by default: unless the request names its own odds, no parlay leg
  // shorter than -150 and no single shorter than -200 (no -2800 "locks")
  function normalize(spec) {
    var s = Object.assign({intent: 'list', count: 5, sports: [], markets: [], side: 'any', sort: 'conf', one_per_game: true}, spec || {});
    var two = (s.markets || []).indexOf('two_plus_td') >= 0 || s.sort === 'two_td';
    var longMkt = (s.markets || []).some(function (m) { return m === 'first_td' || m === 'first_basket'; });
    // a named team or player: every line on them, at any price ("Buckeyes moneyline" at -400 is still the answer)
    if (s.min_price == null && !two && !longMkt && !s.team && !s.player) { s.min_price = s.intent === 'list' ? -200 : -150; s.default_floor = true; }
    if (s.team && s.intent === 'list') s.one_per_game = false;      // "Ohio State player props": several from the one game
    return s;
  }
  function ask(q) {
    q = String(q || '').trim().slice(0, 300);
    if (!q) return Promise.resolve(null);
    return loadBoards().then(function (B) { return Promise.all([toSpec(q, B), B]); }).then(function (a) {
      var spec = normalize(a[0].spec);
      var res = run(spec, a[1]);
      // the standard-price floor left the ticket short (favorites, a thin board): widen it once and say so
      var want = spec.intent === 'list' ? 1 : (spec.count || 3);
      if (spec.default_floor && res.rows.length < want && spec.intent !== 'sgp') {
        var wide = Object.assign({}, spec, {min_price: -250});
        var r2 = run(wide, a[1]);
        if (r2.rows.length > res.rows.length) { res = r2; spec = wide; res.note = (res.note ? res.note + ' ' : '') + 'Not enough at standard prices (-150 or longer), so this reaches to -250.'; }
      }
      res.spec = spec; res.via = a[0].via; res.understood = describe(spec);
      return res;
    });
  }
  window.OnyxAsk = {whenOk: whenOk, ask: ask, normalize: normalize, localSpec: localSpec, run: run, describe: describe, loadBoards: loadBoards, LG: LG, PAGE: PAGE, MKTS: MKTS};
})();
