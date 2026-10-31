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
  var MKTS = ['pts', 'reb', 'ast', 'q1_total', 'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'anytime_td', 'two_plus_td', 'spread', 'total', 'ml'];
  var BOARD = null, AI = null;

  function getJSON(u) { return fetch(u, {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  function loadBoards() {
    if (BOARD) return Promise.resolve(BOARD);
    return Promise.all(SPORTS.map(function (k) { return getJSON('data/' + k + '/board.json').catch(function () { return null; }); }))
      .then(function (fs) { BOARD = []; fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { BOARD.push(p); }); }); return BOARD; });
  }
  function aiUrl() {
    if (AI !== null) return Promise.resolve(AI);
    return getJSON('ai.json').then(function (j) { AI = (j && j.url) || ''; return AI; }).catch(function () { AI = ''; return AI; });
  }

  // ── the built-in parser: the common requests, no AI needed ──────────────
  var WORDS = [
    [/\b(2|two)\+?\s*(td|tds|touchdowns?)\b|\bmultiple (td|tds|touchdowns)\b/, 'two_plus_td'],
    [/\b(anytime\s*)?(td|tds|touchdowns?)\b/, 'anytime_td'],
    [/\b(1st|first)[\s-]*(quarter|q)\b|\b1q\b/, 'q1_total'],
    [/\brebounds?\b|\breb\b|\bboards\b/, 'reb'],
    [/\bassists?\b|\bast\b|\bdimes\b/, 'ast'],
    [/\breceptions?\b|\bcatches\b/, 'rec'],
    [/\breceiving\b/, 'rec_yds'],
    [/\brushing\b|\brush\b/, 'rush_yds'],
    [/\bpassing\b|\bpass yards\b/, 'pass_yds'],
    [/\bpoints?\b|\bpts\b|\bscorers?\b/, 'pts'],
    [/\bspreads?\b|\bcover\b/, 'spread'],
    [/\btotals?\b|\bo\/u\b/, 'total'],
    [/\bmoneylines?\b|\bml\b|\bto win\b|\bwinners?\b/, 'ml'],
  ];
  function localSpec(q) {
    var t = ' ' + q.toLowerCase().replace(/[’']/g, '') + ' ';
    var s = {intent: /\bsgp\b|same[\s-]*game|correlated/.test(t) ? 'sgp' : /parlay|legs?\b|ticket|slip/.test(t) ? 'parlay' : 'list', count: null, sports: [], markets: [], side: 'any',
             min_price: null, max_price: null, min_conf: null, min_edge: null, player: null, team: null, sort: 'conf', one_per_game: true, summary: ''};
    var n = t.match(/\b(\d{1,2})[\s-]*(leg|legs|picks?|plays?|players?|bets?)\b/) || t.match(/\btop\s*(\d{1,2})\b/);
    var NUM = {two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10};
    var nw = t.match(/\b(two|three|four|five|six|seven|eight|ten)[\s-]*(leg|legs|picks?|plays?)\b/);
    s.count = n ? +n[1] : nw ? NUM[nw[1]] : null;
    if (/\bnba\b|basketball/.test(t)) s.sports.push('nba');
    if (/\bnfl\b|pro football/.test(t)) s.sports.push('nfl');
    if (/college|ncaa|cfb/.test(t)) s.sports.push('cfb');
    if (/\bnhl\b|hockey/.test(t)) s.sports.push('nhl');
    if (/tennis|atp|wta/.test(t)) s.sports.push('tennis');
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i][0].test(t) && s.markets.indexOf(WORDS[i][1]) < 0) {
      if (WORDS[i][1] === 'anytime_td' && s.markets.indexOf('two_plus_td') >= 0) continue;
      s.markets.push(WORDS[i][1]);
    }
    if (/\bovers?\b/.test(t) && !/\bunders?\b/.test(t)) s.side = 'over';
    if (/\bunders?\b/.test(t) && !/\bovers?\b/.test(t)) s.side = 'under';
    // odds: "minimum odds -200" / "no worse than -200" / "at least -200" set the floor;
    // "plus money" / "underdogs" / "+150 or longer" set it above even money
    var o = t.match(/(min(imum)?( odds)?|no (worse|shorter) than|at least|nothing (worse|shorter) than|odds( of)?|above|over)\s*([+-]\d{3,4})/);
    if (o) s.min_price = +o[o.length - 1];
    var mx = t.match(/(max(imum)?( odds)?|no (longer|better) than|under|below|at most)\s*([+-]\d{3,4})/);
    if (mx) s.max_price = +mx[mx.length - 1];
    if (/plus money|underdogs?|long ?shots?|\+ ?odds/.test(t)) s.min_price = Math.max(s.min_price == null ? 100 : s.min_price, 100);
    if (/value|edge|best bets?|beat(s)? (the )?(line|price|onyx)/.test(t)) s.sort = 'edge';
    if (/most likely|safest|locks?|highest (chance|confidence|probability)/.test(t)) s.sort = 'conf';
    if (/recommend|favou?rite|best picks?|top picks?|your picks?|should i (bet|play)/.test(t)) s.sort = 'rec';
    if (/most value|best value|biggest edge/.test(t)) s.sort = 'edge';
    if (/biggest payout|longshots?|long shots?/.test(t)) s.sort = 'price';
    var tm = t.match(/\b(atl|bos|bkn|cha|chi|cle|dal|den|det|gs|hou|ind|lac|lal|mem|mia|mil|min|no|ny|nyk|okc|orl|phi|phx|por|sac|sa|tor|utah|wsh|ari|bal|buf|car|cin|gb|jax|kc|lv|lar|lac|ne|nyg|nyj|pit|sea|sf|tb|ten)\b/);
    if (tm && /\b(game|sgp|same game|parlay|tonight|team)\b/.test(t)) s.team = tm[1].toUpperCase();
    if (s.markets.indexOf('two_plus_td') >= 0) { s.sort = 'two_td'; s.sports = s.sports.length ? s.sports : ['nfl']; }
    var c = t.match(/(\d{2})\s*%/); if (c) s.min_conf = +c[1] / 100;
    if (s.count == null) s.count = s.intent !== 'list' ? 3 : /\b(the|a) (player|play|pick)\b|\bmost likely\b/.test(t) && !/players|plays|picks/.test(t) ? 1 : 5;
    return s;
  }

  // ── the spec, run against today's boards ────────────────────────────────
  function p2(lam) { return lam == null ? null : 1 - Math.exp(-lam) * (1 + lam); }
  function dec(o) { return o > 0 ? 1 + o / 100 : 1 + 100 / -o; }
  function am(d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function run(spec, B) {
    var now = Date.now();
    var mk = (spec.markets || []).slice();
    var two = mk.indexOf('two_plus_td') >= 0 || spec.sort === 'two_td';
    if (two && mk.indexOf('anytime_td') < 0) mk.push('anytime_td');
    var pool = B.filter(function (p) {
      var t = Date.parse(p.start); if (!isNaN(t) && t <= now) return false;
      if (spec.sports && spec.sports.length && spec.sports.indexOf(p.sport) < 0) return false;
      if (mk.length && mk.indexOf(p.mkt) < 0 && mk.indexOf(p.kind) < 0) return false;
      if (spec.side && spec.side !== 'any' && (p.kind === 'prop' || p.kind === 'total') && p.side !== spec.side) return false;
      if (two) return p.lam != null;
      if (spec.min_price != null && p.price < spec.min_price) return false;
      if (spec.max_price != null && p.price > spec.max_price) return false;
      if (spec.min_conf != null && p.conf < spec.min_conf) return false;
      if (spec.min_edge != null && p.edge < spec.min_edge) return false;
      if (spec.player && String(p.name || p.label).toLowerCase().indexOf(String(spec.player).toLowerCase()) < 0) return false;
      if (spec.team && [p.team, p.matchup, p.name].join(' ').toUpperCase().indexOf(String(spec.team).toUpperCase()) < 0) return false;
      return true;
    }).map(function (p) { return two ? Object.assign({}, p, {two: p2(p.lam)}) : p; });
    // "recommended": what this site stands behind first (graded picks, then the
    // on-trial lanes), then the blend of confidence and value
    var REC = {tracked: 0.2, trial: 0.1};
    var key = spec.sort === 'two_td' || two ? function (p) { return -p.two; } : spec.sort === 'edge' ? function (p) { return -p.edge; }
      : spec.sort === 'price' ? function (p) { return -p.price; }
      : spec.sort === 'rec' ? function (p) { return -((REC[p.tag] || 0) + p.conf + 2 * Math.max(-0.05, p.edge)); }
      : function (p) { return -p.conf - p.edge / 10; };
    pool.sort(function (a, b) { return key(a) - key(b); });
    if (spec.intent === 'sgp') return sgp(spec, pool, key);
    var n = Math.max(1, Math.min(spec.intent === 'parlay' ? 8 : 25, spec.count || 5));
    var picked = [], games = {}, who = {};
    for (var i = 0; i < pool.length && picked.length < n; i++) {
      var p = pool[i];
      if (who[p.sport + p.who]) continue;
      if ((spec.one_per_game !== false || spec.intent === 'parlay') && games[p.gid]) continue;
      who[p.sport + p.who] = 1; games[p.gid] = 1; picked.push(p);
    }
    var out = {rows: picked, pool: pool.length, two: two};
    if (spec.intent === 'parlay' && picked.length > 1) out.parlay = ticket(picked);
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
        var legs = [anchor], who = {}; who[anchor.who] = 1;
        var kinds = {}; kinds[anchor.kind + (anchor.kind === 'prop' ? '' : anchor.name)] = 1;
        for (var i = 0; i < G.length && legs.length < n; i++) {
          var p = G[i];
          if (p === anchor || who[p.who] || !fits(story, anchor, p)) continue;
          if (p.kind !== 'prop' && kinds[p.kind]) continue;          // one game line of each kind
          who[p.who] = 1; kinds[p.kind] = 1; legs.push(p);
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
            rush_yds: 'rushing yards', pass_yds: 'passing yards', anytime_td: 'anytime TD', two_plus_td: '2+ touchdowns', spread: 'spreads', total: 'totals', ml: 'moneylines'};
  function describe(s) {
    var b = [];
    b.push(s.intent === 'sgp' ? (s.count || 3) + '-leg same-game parlay, correlated' : s.intent === 'parlay' ? (s.count || 3) + '-leg parlay' : (s.count || 5) === 1 ? 'top play' : 'top ' + (s.count || 5));
    b.push((s.sports || []).length ? s.sports.map(function (k) { return LG[k] || k; }).join(' + ') : 'every sport');
    if ((s.markets || []).length) b.push(s.markets.map(function (m) { return MW[m] || m; }).join(', '));
    if (s.side && s.side !== 'any') b.push(s.side === 'over' ? 'overs only' : 'unders only');
    if (s.min_price != null) b.push((s.default_floor ? 'standard prices, nothing shorter than ' : 'no price shorter than ') + (s.min_price > 0 ? '+' : '') + s.min_price);
    if (s.max_price != null) b.push('no price longer than ' + (s.max_price > 0 ? '+' : '') + s.max_price);
    if (s.min_conf != null) b.push(Math.round(100 * s.min_conf) + '%+ confidence');
    if (s.player) b.push(s.player);
    if (s.team) b.push(s.team);
    b.push(s.sort === 'rec' ? 'what we recommend most first' : s.sort === 'price' ? 'biggest payouts first' : s.sort === 'edge' ? 'best value first' : s.sort === 'two_td' ? 'most likely 2+ TDs first' : 'highest confidence first');
    return b.join(' · ');
  }

  function toSpec(q) {
    return aiUrl().then(function (u) {
      if (!u) return {spec: localSpec(q), via: 'local'};
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 15000);
      return fetch(u, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({q: q}), signal: ctl.signal})
        .then(function (r) { clearTimeout(tm); if (!r.ok) throw new Error('relay ' + r.status); return r.json(); })
        .then(function (j) { if (!j || !j.spec) throw new Error('no spec'); return {spec: j.spec, via: 'ai'}; })
        .catch(function () { return {spec: localSpec(q), via: 'local'}; });
    });
  }
  // mainstream by default: unless the request names its own odds, no parlay leg
  // shorter than -150 and no single shorter than -200 (no -2800 "locks")
  function normalize(spec) {
    var s = Object.assign({intent: 'list', count: 5, sports: [], markets: [], side: 'any', sort: 'conf', one_per_game: true}, spec || {});
    var two = (s.markets || []).indexOf('two_plus_td') >= 0 || s.sort === 'two_td';
    if (s.min_price == null && !two) { s.min_price = s.intent === 'list' ? -200 : -150; s.default_floor = true; }
    return s;
  }
  function ask(q) {
    q = String(q || '').trim().slice(0, 300);
    if (!q) return Promise.resolve(null);
    return Promise.all([toSpec(q), loadBoards()]).then(function (a) {
      var spec = normalize(a[0].spec);
      var res = run(spec, a[1]);
      res.spec = spec; res.via = a[0].via; res.understood = describe(spec);
      return res;
    });
  }
  window.OnyxAsk = {ask: ask, normalize: normalize, localSpec: localSpec, run: run, describe: describe, loadBoards: loadBoards, LG: LG, PAGE: PAGE, MKTS: MKTS};
})();
