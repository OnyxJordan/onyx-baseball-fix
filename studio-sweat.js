// studio-sweat.js - the Studio's live sweat (11/15 NFL "Sunday Sweat", Jordan: "the live board for your bets during NFL
// games"; every sport 11/16 as "Live Sweat"). One board for everything this device is riding in the Studio's sport:
// saved picks and saved parlay tickets (OnyxSaved), the current slip (OnyxParlay), and plays added here just to sweat
// (onyxSweatOnly, nothing bet).
//
// Per leg, live: the stat so far against the line (a bar), the score and clock, a status (hit, dead, on pace, needs X
// more) and the live chance it hits.
//   Props (NFL, college football, NBA; any saved prop in college basketball or the NHL): the stat so far plus the
//   model's projection for the time left, with live.js's fitted live prop spread (OnyxLive.propP: PK scales the
//   projection still to come, YSD / PVAR the spread); touchdown markets are Poisson on the model's expected TDs for the
//   time left. Box-score mapping per sport: football receiving / rushing / passing; basketball points, rebounds,
//   assists, threes (and the combos); hockey goals, assists, shots.
//   Game lines: OnyxLive.model for the sport from the score and the time left (football and basketball: the in-game
//   normal draw; hockey: Poisson goals for the time left with overtime; tennis: the point -> game -> set chain from the
//   set and game score). A ticket's chance is its legs' chances multiplied (legs treated as independent).
//
// Live data: ESPN's scoreboard and box score for the sport (the same feeds saved.js and live.js read), every 35 s while
// a game on the list is live, paused while the tab is hidden. Legs from other sports on a saved parlay follow
// OnyxSaved.track.
//
// Demo replay, per sport, from local files only: a recent finished game with the real pregame Onyx lines.
//   NFL / college football: data/<sport>/prop_archive.json (lines and projections that night), player_games.json (the
//   final box lines), results.json (the final score). NBA: prop_archive.json, player_games.json, team_games.json.
//   College basketball and NHL: results.json (the final), pregame.json (Onyx's spread, total and moneyline), else the
//   home team card's line for that game; player_games.json names the scorers when the box adds up. Tennis: a finished
//   match in slate.json (every set's games) or results.json, with pregame.json's prices.
// The order of plays is scripted (seeded); the totals are the real ones exactly, so every leg lands where it really did.
// Studio.checks.sweat replays it start to finish headless and returns '' only when every leg resolves to the hit or
// miss the final says.
(function () {
  'use strict';
  if (!window.Studio) return;
  var SPORT = Studio.sport || 'nfl', SOLO = 'onyxSweatOnly', REF = 'KR680261';
  var LEAGUE = {nfl: ['football/nfl'], cfb: ['football/college-football'], nba: ['basketball/nba'], cbb: ['basketball/mens-college-basketball'],
                nhl: ['hockey/nhl'], tennis: ['tennis/atp', 'tennis/wta']}[SPORT] || ['football/nfl'];
  var SBQ = {cfb: '?groups=80', cbb: '?groups=50&limit=400'}[SPORT] || '';
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
  var LENS = {nfl: [4, 15], cfb: [4, 15], nba: [4, 12], cbb: [2, 20], nhl: [3, 20]}[SPORT] || [4, 15];
  var FOOTB = SPORT === 'nfl' || SPORT === 'cfb', HOOPS = SPORT === 'nba' || SPORT === 'cbb', TENNIS = SPORT === 'tennis';
  var NAME = SPORT === 'nfl' ? 'Sunday Sweat' : 'Live Sweat';
  var START = FOOTB ? ['Kickoff', 'Kicks off'] : HOOPS ? ['Tip-off', 'Tips off'] : SPORT === 'nhl' ? ['Puck drop', 'Puck drops'] : ['First serve', 'Starts'];
  var UNIT = TENNIS ? 'games' : SPORT === 'nhl' ? 'goals' : 'points';
  var DIV = FOOTB ? 21 : HOOPS ? 25 : SPORT === 'nhl' ? 3 : 8;   // the lead that fills half the bar
  var CHECK = 'the demo replay self-test has not finished';
  Studio.checks.sweat = function () { return CHECK; };

  var MW = {rec: 'receptions', rec_yds: 'receiving yards', rush_yds: 'rushing yards', pass_yds: 'passing yards', pass_att: 'pass attempts',
    pass_td: 'passing TDs', rush_rec_yds: 'rushing + receiving yards', pass_rush_yds: 'passing + rushing yards', anytime_td: 'TDs',
    two_td: 'TDs', three_td: 'TDs', first_td: 'first TD',
    pts: 'points', reb: 'rebounds', ast: 'assists', threes: '3-pointers made', pra: 'points + rebounds + assists', pr: 'points + rebounds', pa: 'points + assists',
    dbl_dbl: 'double-double', trp_dbl: 'triple-double', first_basket: 'first basket', goals: 'goals', assists: 'assists', points: 'points', sog: 'shots on goal'};
  var MS = {rec: 'catches', rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds', pass_att: 'attempts', pass_td: 'pass TD',
    rush_rec_yds: 'rush+rec yds', pass_rush_yds: 'pass+rush yds', anytime_td: 'TD', two_td: 'TD', three_td: 'TD', first_td: 'TD',
    pts: 'pts', reb: 'reb', ast: 'ast', threes: 'threes', pra: 'pts+reb+ast', pr: 'pts+reb', pa: 'pts+ast', dbl_dbl: 'double-digit stats', trp_dbl: 'double-digit stats',
    goals: 'goals', assists: 'assists', points: 'points', sog: 'shots'};
  var SUMS = {rush_rec_yds: ['rush_yds', 'rec_yds'], pass_rush_yds: ['pass_yds', 'rush_yds'], pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], points: ['goals', 'assists']};
  var TDK = {anytime_td: 1, two_td: 2, three_td: 3};
  var FIRST = {first_td: 1, first_basket: 1};
  var DBL = {dbl_dbl: 2, trp_dbl: 3};

  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getJSON(p) { return fetch(p + (p.indexOf('?') < 0 ? '?' : '&') + 'v=' + Math.floor(Date.now() / 60000)).then(function (r) { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); }); }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function clamp(x) { return Math.max(0, Math.min(1, x)); }

  // ── the math ────────────────────────────────────────────────────────────
  function phi(z) { return window.OnyxLive ? OnyxLive.phi(z) : 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z))); }
  function propP(mkt, cur, proj, f, line) {
    if (window.OnyxLive && OnyxLive.propP) return OnyxLive.propP(mkt, cur, proj, f, line);
    var rem = Math.max(0, proj * f), sd = /yds$/.test(mkt) ? (0.45 * proj + 12) * Math.sqrt(f) : Math.sqrt(Math.max(0.15, rem * 1.5));
    return 1 - phi((line - cur - rem) / Math.max(sd, 0.35));
  }
  function poisGE(lam, k) { if (k <= 0) return 1; var p = Math.exp(-lam), c = p; for (var i = 1; i < k; i++) { p *= lam / i; c += p; } return clamp(1 - c); }
  // a projection when a pick carries only a chance: the projection that makes the pregame over chance match
  function projFor(mkt, line, pOver) {
    var lo = 0, hi = Math.max(10, line * 4 + 10);
    for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (propP(mkt, 0, m, 1, line) < pOver) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function lamFor(mkt, pOver) { var k = TDK[mkt] || 1, lo = 0.001, hi = 8; for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (poisGE(m, k) < pOver) lo = m; else hi = m; } return (lo + hi) / 2; }
  // the game model for the sport at a moment (null once final): win / cover / over and the projected total
  function liveModel(L, G) {
    if (!window.OnyxLive || !G || G.state === 'post') return null;
    try {
      if (G.tennis) {
        var key = JSON.stringify(G.sets) + '|' + L.pre_home_win;
        if (G._m && G._m[key]) return G._m[key];
        var m = OnyxLive.model('tennis', {st: OnyxLive.tn.state(G.sets || [], G.srv == null ? null : G.srv), need: G.need || 2, tour: G.tour || L.tour || 'ATP', pre_home_win: L.pre_home_win == null ? 0.5 : L.pre_home_win});
        if (G._m) G._m[key] = m;
        return m;
      }
      return OnyxLive.model(SPORT, {f: Math.max(G.f, 0.004), pre_margin: L.pre_margin || 0, pre_total: L.pre_total, pre_home_win: L.pre_home_win == null ? 0.5 : L.pre_home_win, hs: G.hs, as: G.as});
    } catch (e) { return null; }
  }

  // a game's moment -> its clock: "Q3 8:12", "2nd half 11:40", "P2 4:05", tennis sets "6-4 2-3"
  function setsTxt(G) { return (G.sets || []).map(function (s) { return s[1] + '-' + s[0]; }).join(' '); }
  function clockLabel(G) {
    if (!G) return '';
    if (G.state === 'post') return 'Final' + (G.tennis && G.sets ? ' ' + setsTxt(G) : G.ot ? (SPORT === 'nhl' ? '/OT' : ' OT') : '');
    if (G.state === 'pre') return G.start ? Studio.u.fmtTime(G.start) : 'Pregame';
    if (G.tennis) return setsTxt(G) || 'Live';
    if (G.detail && !G.period) return G.detail;
    var c = Math.max(0, Math.round(G.clock || 0)), m = Math.floor(c / 60), s = c % 60, p = G.period;
    var per = p > LENS[0] ? 'OT' : SPORT === 'nhl' ? 'P' + p : SPORT === 'cbb' ? (p === 1 ? '1st half' : '2nd half') : 'Q' + p;
    return per + ' ' + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function score(G) { return G && G.state !== 'pre' && G.away ? G.away + ' ' + G.as + ' · ' + G.home + ' ' + G.hs + (G.tennis ? ' sets' : '') : ''; }

  // one leg against one moment. L: the normalized leg; G: its game; cur: the stat so far (props); first: the first scorer
  function evalLeg(L, G, cur, first, u) {
    var o = {res: null, chance: L.conf0, cur: null, status: 'Pregame', tone: 'pre', note: '', bar: 0, mark: null, div: null};
    if (L.other) {   // a leg from another sport on a saved parlay (OnyxSaved.track)
      var t = L.track || {};
      o.res = t.res === 'W' ? 'hit' : t.res === 'L' ? 'miss' : t.res === 'P' ? 'push' : null;
      o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : L.conf0;
      o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : t.state === 'in' ? 'Live' : 'Pregame';
      o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : t.state === 'in' ? 'live' : 'pre';
      o.note = (L.sport || '').toUpperCase() + (t.cur != null ? ' · now ' + t.cur : '') + ' · followed in My picks';
      return o;
    }
    if (!G || G.state === 'unknown') { o.status = 'Waiting on scores'; o.tone = 'pre'; o.note = 'Live scores are not reaching this page right now. Showing the pregame chance.'; return o; }
    if (G.state === 'pre') { o.note = START[1] + ' ' + clockLabel(G); return o; }
    var done = G.state === 'post', f = done ? 0 : G.f == null ? 0.5 : Math.max(0, Math.min(1, G.f)), el = 1 - f;
    if (L.kind === 'prop') {
      cur = cur == null ? 0 : cur; o.cur = cur;
      var unit = MS[L.mkt] || '', line = L.line, over = L.side !== 'under';
      if (FIRST[L.mkt]) {
        var what = L.mkt === 'first_td' ? 'TD' : 'basket';
        if (first) { o.res = Studio.u.nk(first) === Studio.u.nk(L.name) ? 'hit' : 'miss'; }
        else if (done) o.res = 'miss';
        o.chance = o.res === 'hit' ? 1 : o.res === 'miss' ? 0 : L.conf0;
        o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'No ' + what + ' yet';
        o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'live';
        o.note = first ? 'First ' + what + ': ' + first : 'Nobody has scored yet';
        o.bar = o.res === 'hit' ? 1 : 0; return o;
      }
      var max = Math.max(line * 1.45, cur * 1.08, line + 1.5);
      o.bar = Math.min(1, cur / max); o.mark = line / max;
      var td = TDK[L.mkt], dbl = DBL[L.mkt], pOver;
      if (cur > line) pOver = 1;
      else if (done) pOver = 0;
      else if (td) pOver = poisGE(L.lam * f * (L.tdk || 1), Math.ceil(line - cur + 0.0001));
      else if (dbl) pOver = clamp(L.conf0 * (0.35 + 0.65 * f) + (cur / dbl) * (1 - f) * 0.6);   // categories in double digits so far, faded by the time left
      else pOver = propP(L.mkt, cur, L.proj, f, line);
      var hitNow = over ? cur > line : (done && cur < line), deadNow = over ? (done && cur <= line) : cur > line;
      if (cur === line && done) o.res = 'push';
      else if (hitNow) o.res = 'hit'; else if (deadNow) o.res = 'miss';
      o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(over ? pOver : 1 - pOver);
      var need = Math.floor(line) + 1 - cur, room = Math.floor(line) - cur, pace = el > 0.06 ? cur / el : null;
      var paceTxt = pace != null && !done && !o.res && !td && !dbl ? ' · pace ' + (pace >= 20 ? Math.round(pace) : pace.toFixed(1)) : '';
      o.note = td ? cur + ' TD' + (cur === 1 ? '' : 's') + (o.res ? '' : ' · needs ' + need + ' more')
        : dbl ? cur + ' of ' + dbl + ' stats in double digits'
        : cur + ' of ' + line + ' ' + unit + paceTxt;
      if (o.res === 'hit') { o.status = 'Hit'; o.tone = 'hit'; }
      else if (o.res === 'miss') { o.status = 'Dead'; o.tone = 'dead'; }
      else if (o.res === 'push') { o.status = 'Push'; o.tone = 'pre'; }
      else if (over) {
        var onp = pace != null && pace > line;
        o.status = onp ? 'On pace' : 'Needs ' + need + ' more'; o.tone = onp ? 'good' : o.chance < 0.25 ? 'bad' : 'live';
        if (onp && !td) o.note += ' · needs ' + need + ' more';
      } else {
        var onu = pace == null || pace < line;
        o.status = onu ? 'On pace' : 'Over pace'; o.tone = onu ? 'good' : o.chance < 0.25 ? 'bad' : 'live';
        o.note += ' · ' + room + ' to spare';
      }
      return o;
    }
    // game lines: points (tennis: games) decide spreads and totals; tennis matches are won in sets
    var ten = !!G.tennis, hp = ten ? G.hg : G.hs, ap = ten ? G.ag : G.as;
    var mine = L.name === G.home ? 'h' : L.name === G.away ? 'a' : null, m = hp - ap, tot = hp + ap;
    var mdl = done ? null : liveModel(L, G);
    if (L.kind === 'total') {
      var ov = L.side !== 'under';
      o.cur = tot; var mx = Math.max(L.line * 1.35, tot * 1.08); o.bar = Math.min(1, tot / mx); o.mark = L.line / mx;
      if (tot > L.line) o.res = ov ? 'hit' : 'miss'; else if (done) o.res = tot === L.line ? 'push' : ov ? 'miss' : 'hit';
      var pov = mdl ? mdl.over(L.line) : (tot > L.line ? 1 : 0);
      o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(ov ? pov : 1 - pov);
      var pt = mdl ? mdl.proj_total : tot;
      o.note = tot + ' of ' + L.line + ' ' + UNIT + (mdl ? ' · model pace ' + pt.toFixed(1) : '');
      if (o.res) { o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'Push'; o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'pre'; }
      else if (ov) { o.status = pt > L.line ? 'On pace' : 'Needs ' + Math.ceil(L.line - tot + 0.01) + ' more'; o.tone = pt > L.line ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
      else { o.status = pt < L.line ? 'On pace' : 'Over pace'; o.note += ' · ' + Math.floor(L.line - tot) + ' to spare'; o.tone = pt < L.line ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
      return o;
    }
    if (!mine) { o.note = 'Score ' + score(G); return o; }
    var my = mine === 'h' ? m : -m, h = L.kind === 'spread' ? (L.hcap || 0) : 0, by = my + h;
    if (ten && L.kind === 'ml') { var sm = mine === 'h' ? G.hs - G.as : G.as - G.hs; by = sm; }   // the match: sets
    o.cur = my; o.div = Math.max(-1, Math.min(1, by / DIV));
    if (done) o.res = by > 0 ? 'hit' : by === 0 ? 'push' : 'miss';
    var pw = null;
    if (mdl) pw = L.kind === 'spread' ? (mine === 'h' ? mdl.cover(h) : 1 - mdl.cover(-h)) : (mine === 'h' ? mdl.win() : 1 - mdl.win());
    o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(pw == null ? 0.5 : pw);
    var lead = my > 0 ? 'Up ' + my : my < 0 ? 'Down ' + (-my) : 'Level';
    if (ten) o.note = L.name + ' ' + (L.kind === 'ml' ? (by > 0 ? 'leads ' : by < 0 ? 'trails ' : 'level at ') + Math.max(G.hs, G.as) + '-' + Math.min(G.hs, G.as) + ' in sets' : my > 0 ? 'up ' + my + ' games' : my < 0 ? 'down ' + (-my) + ' games' : 'level on games')
      + (L.kind === 'spread' ? ' · ' + (by > 0 ? 'covering by ' + by : by === 0 ? 'on the number' : 'needs ' + (Math.floor(-by) + 1) + ' more games') : '');
    else o.note = L.name + ' ' + lead.toLowerCase() + (L.kind === 'spread' ? ' · ' + (by > 0 ? 'covering by ' + by : by === 0 ? 'on the number' : 'needs ' + (Math.floor(-by) + 1) + ' more') : '');
    if (o.res) { o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'Push'; o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'pre'; }
    else { o.status = by > 0 ? (L.kind === 'spread' ? 'Covering' : 'Leading') : by === 0 ? 'Even' : L.kind === 'ml' ? 'Trailing' : 'Needs ' + (Math.floor(-by) + 1) + ' more'; o.tone = by > 0 ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
    return o;
  }

  // a ticket's legs -> its state and live chance
  function evalTicket(T, frame, u) {
    var E = T.legs.map(function (L) {
      var G = L.other ? null : frame.game(L);
      return evalLeg(L, G, L.kind === 'prop' && G && G.state !== 'pre' ? frame.stat(L) : null, FIRST[L.mkt] && G ? frame.first(L) : null, u);
    });
    var chance = E.reduce(function (m, e) { return m * (e.chance == null ? 0.5 : e.chance); }, 1);
    var pre = T.legs.reduce(function (m, L) { return m * (L.conf0 == null ? 0.5 : L.conf0); }, 1);
    var miss = E.some(function (e) { return e.res === 'miss'; }), all = E.every(function (e) { return e.res === 'hit' || e.res === 'push'; });
    var anyHit = E.some(function (e) { return e.res === 'hit'; }), allPre = E.every(function (e) { return e.tone === 'pre' && !e.res; });
    var state = miss ? 'busted' : all ? (anyHit ? 'cashed' : 'push') : allPre ? 'pre' : 'sweat';
    return {legs: E, chance: miss ? 0 : all ? 1 : clamp(chance), pre: pre, state: state};
  }

  // ── legs: anything (a saved pick, a slip leg, a board row) -> one shape, filled from today's board ──
  function boardRow(D, p) {
    var sel = p.sel || (p.id && !/^(k:|t:)/.test(p.id) ? p.id : null);
    var hit = sel ? D.plays.filter(function (r) { return r.sel === sel; })[0] : null;
    if (hit) return hit;
    return D.plays.filter(function (r) { return r.gid === p.gid && r.kind === p.kind && r.mkt === p.mkt && r.side === p.side && r.line === p.line && (r.name || '') === (p.name || ''); })[0] || null;
  }
  function modelScores(D, gid) {   // the model's team scores from a game-line row's why: "model SEA 27.8 LV 15.3 ..."
    var rows = D.playsFor(gid), out = null;
    rows.some(function (r) { var m = /model (\S+) ([\d.]+) (\S+) ([\d.]+)/.exec(r.why || ''); if (m) { out = {}; out[m[1]] = +m[2]; out[m[3]] = +m[4]; } return !!out; });
    return out;
  }
  function teamsOf(D, p) {
    var g = D.game(p.gid);
    if (g) return {away: g.away, home: g.home, start: g.start};
    var m = String(p.matchup || ''), a = m.split(' @ ');
    if (a.length === 2) return {away: a[0], home: a[1], start: p.start};
    a = m.split(' vs '); return a.length === 2 ? (TENNIS ? {away: a[0], home: a[1], start: p.start} : {away: a[1], home: a[0], start: p.start}) : {away: null, home: null, start: p.start};
  }
  // the home side's pregame win chance: this leg's own moneyline, else the board's moneyline on the game
  function homeWin(D, L) {
    if (L.kind === 'ml' && L.conf0 != null && L.home) return L.name === L.home ? L.conf0 : 1 - L.conf0;
    var r = D.playsFor(L.gid).filter(function (x) { return x.kind === 'ml' && x.conf != null; })[0];
    if (r) return r.who === L.home || r.name === L.home ? r.conf : 1 - r.conf;
    return null;
  }
  function norm(D, p, i) {
    var row = boardRow(D, p) || {}, L = {};
    ['sel', 'sport', 'label', 'matchup', 'start', 'gid', 'team', 'price', 'conf', 'kind', 'mkt', 'side', 'line', 'hcap', 'name', 'proj', 'lam', 'why', 'edge', 'no_read'].forEach(function (k) { L[k] = p[k] != null ? p[k] : row[k]; });
    L.sel = L.sel || row.sel || (p.id && !/^(k:|t:)/.test(p.id) ? p.id : null);
    L.lid = p.id || L.sel || ('leg' + i);
    L.sport = L.sport || 'nfl';
    if (L.sport !== SPORT) { L.other = true; L.conf0 = L.conf != null ? L.conf : L.price != null ? Studio.u.imp(L.price) : 0.5; return L; }
    var tm = teamsOf(D, L); L.away = tm.away; L.home = tm.home; L.start = L.start || tm.start;
    L.conf0 = L.conf != null ? L.conf : L.price != null ? Studio.u.imp(L.price) : 0.5;
    L.confSrc = L.conf != null ? 'model' : 'Onyx implied';
    if (L.kind === 'prop') {
      var pOver = L.side === 'under' ? 1 - L.conf0 : L.conf0;
      if (TDK[L.mkt]) { if (L.lam == null) L.lam = lamFor(L.mkt, pOver); }
      else if (!FIRST[L.mkt] && !DBL[L.mkt] && L.proj == null && L.line != null) L.proj = projFor(L.mkt, L.line, pOver);
    } else {
      L.pre_home_win = homeWin(D, L);
      var sc = modelScores(D, L.gid), dt = (window.OnyxLive && OnyxLive.DEF_TOTAL[SPORT]) || (TENNIS ? 22 : 44);
      if (sc && L.home && sc[L.home] != null && sc[L.away] != null) { L.pre_margin = sc[L.home] - sc[L.away]; L.pre_total = sc[L.home] + sc[L.away]; }
      else {
        var tr = D.playsFor(L.gid).filter(function (x) { return x.kind === 'total'; })[0];
        L.pre_margin = L.kind === 'spread' && L.hcap != null ? (L.name === L.home ? -L.hcap : L.hcap) : 0;
        L.pre_total = L.kind === 'total' ? L.line : tr ? tr.line : dt;
      }
    }
    return L;
  }

  function mount(el, D, u) {
    var PH = {nfl: 'Player, team or market (Kelce, DAL, rushing)', cfb: 'Player, team or market (TCU, rushing)', nba: 'Player, team or market (Jokic, DEN, rebounds)',
              cbb: 'Team or market (Kentucky, UK, total)', nhl: 'Team or market (NYR, puck line)', tennis: 'Player or market (Zverev, total)'}[SPORT] || 'Player, team or market';
    var css = document.createElement('style'); css.id = 'sx-sweat-css'; css.textContent = CSS; document.head.appendChild(css);
    var S = {demo: null, live: {sb: {}, sum: {}, err: null, at: 0, other: {}}, spark: {}, prevRes: {}, base: {}, lastState: {}, sig: null, refs: {}, playing: false, speed: 1, timer: null, poll: null};

    el.innerHTML = '<div class="sw">'
      + '<div class="sx-card sw-hero" id="swHero"></div>'
      + '<div class="sw-cols"><div class="sw-main"><div id="swList"></div></div>'
      + '<aside class="sw-side">'
      + '<div class="sx-card"><h3 class="sx-h">Sweat any play</h3><p class="sx-sub">Add any play on today\'s Onyx board to the sweat without betting it.</p>'
      + '<input class="sx-in" id="swQ" type="search" placeholder="' + u.esc(PH) + '" autocomplete="off"><div id="swRes" class="sw-res"></div></div>'
      + '<div class="sx-card" id="swNext"></div>'
      + '</aside></div>'
      + '<div class="sw-toasts" id="swToasts" aria-live="polite"></div></div>';
    var hero = el.querySelector('#swHero'), list = el.querySelector('#swList'), nextEl = el.querySelector('#swNext');

    // ── what is being sweated ──
    function tickets() {
      if (S.demo && S.demo.on) return S.demo.tickets;
      var T = [];
      var sv = window.OnyxSaved ? OnyxSaved.all() : [];
      sv.forEach(function (p) {
        if (p.kind === 'parlay' && (p.legs || []).length) {
          if (!p.legs.some(function (l) { return (l.sport || 'nfl') === SPORT; })) return;
          T.push({id: 'p:' + p.id, title: p.label || p.legs.length + '-leg parlay', src: 'Saved parlay', legs: p.legs.map(function (l, i) { return norm(D, l, i); }), price: p.my_price != null ? p.my_price : p.price});
        } else if ((p.sport || 'nfl') === SPORT) T.push({id: 's:' + p.id, title: 'My pick', src: 'Saved pick', legs: [norm(D, p, 0)], price: p.my_price != null ? p.my_price : p.price});
      });
      var slip = window.OnyxParlay ? OnyxParlay.slip() : [];
      if (slip.some(function (l) { return (l.sport || 'nfl') === SPORT; })) T.push({id: 'slip', title: slip.length > 1 ? 'Your slip · ' + slip.length + ' legs' : 'Your slip', src: 'On your slip, not placed', legs: slip.map(function (l, i) { return norm(D, l, i); }), slip: true});
      lsGet(SOLO, []).forEach(function (p) { T.push({id: 'o:' + p.id, title: 'Sweat only', src: 'Not bet', legs: [norm(D, p, 0)], solo: p.id}); });
      T.forEach(function (t) { if (t.price == null && t.legs.length > 1 && t.legs.every(function (l) { return l.price != null; })) t.price = u.amer(t.legs.reduce(function (m, l) { return m * u.dec(l.price); }, 1)); else if (t.price == null && t.legs.length === 1) t.price = t.legs[0].price; });
      return T;
    }

    // ── live frames off ESPN ──
    function liveFrame() {
      var LV = S.live;
      return {
        game: function (L) {
          var g = LV.sb[L.gid];
          if (g) return g;
          var sl = D.game(L.gid), st = Date.parse(L.start);
          if (sl && sl.state === 'post' && sl.away_score != null) return {state: 'post', away: sl.away, home: sl.home, as: +sl.away_score || 0, hs: +sl.home_score || 0, f: 0};
          if (isNaN(st) || st > Date.now()) return {state: 'pre', start: L.start, away: L.away, home: L.home};
          return {state: 'unknown', start: L.start};
        },
        stat: function (L) { return statOf(LV.sum[L.gid], L); },
        first: function (L) { return firstScore(LV.sum[L.gid]); }
      };
    }
    // a player's line in ESPN's box score, per sport: football receiving / rushing / passing, basketball points,
    // rebounds, assists and threes, hockey goals, assists and shots
    function statOf(j, L) {
      if (!j) return null;
      var v = {}, seen = false;
      ((j.boxscore || {}).players || []).forEach(function (t) { (t.statistics || []).forEach(function (b) { (b.athletes || []).forEach(function (a) {
        if (u.nk((a.athlete || {}).displayName) !== u.nk(L.name)) return;
        seen = true;
        var lab = (b.labels || b.names || []).map(function (x) { return String(x).toUpperCase(); }), keys = b.keys || [];
        var at = function (l, k) { var i = lab.indexOf(l); if (i < 0 && k) i = keys.indexOf(k); return i < 0 ? null : (a.stats || [])[i]; };
        var n = function (l, k) { var x = parseFloat(at(l, k)); return isNaN(x) ? 0 : x; };
        if (FOOTB) {
          if (b.name === 'receiving') { v.rec = n('REC'); v.rec_yds = n('YDS'); v.rec_td = n('TD'); }
          if (b.name === 'rushing') { v.rush_yds = n('YDS'); v.rush_td = n('TD'); }
          if (b.name === 'passing') { v.pass_yds = n('YDS'); v.pass_td = n('TD'); var ca = String(at('C/ATT') || '').split('/'); v.pass_att = parseFloat(ca[1]) || 0; }
        } else if (HOOPS) {
          v.pts = n('PTS', 'points'); v.reb = n('REB', 'rebounds'); v.ast = n('AST', 'assists');
          v.threes = parseFloat(String(at('3PT', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted') || '0').split('-')[0]) || 0;
        } else {
          v.goals = (v.goals || 0) + n('G', 'goals'); v.assists = (v.assists || 0) + n('A', 'assists'); v.sog = (v.sog || 0) + (at('SOG', 'shotsTotal') != null ? n('SOG', 'shotsTotal') : n('S'));
        }
      }); }); });
      return pick(v, L.mkt, seen);
    }
    function pick(v, mkt, seen) {
      var g = function (k) { return v[k] || 0; };
      if (!seen) return 0;   // not in the box score yet: nothing so far
      if (TDK[mkt]) return g('rush_td') + g('rec_td');
      if (SUMS[mkt]) return SUMS[mkt].reduce(function (s, k) { return s + g(k); }, 0);
      if (DBL[mkt]) return [g('pts'), g('reb'), g('ast')].filter(function (x) { return x >= 10; }).length;
      if (mkt === 'anytime_goal' || mkt === 'goal') return g('goals');
      return g(mkt);
    }
    // the first scorer: football's first touchdown, basketball's first basket
    function firstScore(j) {
      if (HOOPS) {
        var pl = ((j || {}).plays || []).filter(function (p) { return p.scoringPlay; })[0];
        var mb = pl && /^([A-Z][\w.'\- ]+?) makes/.exec(pl.text || '');
        return mb ? mb[1].trim() : null;
      }
      var sp = (j || {}).scoringPlays || [], td = sp.filter(function (s) { return /touchdown/i.test(((s.type || {}).text) || '') || /\bTD\b|touchdown/i.test(s.text || ''); })[0];
      if (!td) return null;
      var m = /^([A-Z][\w.'\- ]+?) \d+ (Yd|Yard)/.exec(td.text || '') || /^([A-Z][\w.'\- ]+?) (pass|run|rush)/i.exec(td.text || '');
      return m ? m[1].trim() : (td.text || '').split(' ').slice(0, 2).join(' ');
    }
    function tennisGame(c, e) {
      var g = D.game(c.id); if (!g) return null;
      var cs = c.competitors || [], nm = function (x) { return ((x || {}).athlete || {}).displayName || ((x || {}).team || {}).displayName || ''; };
      var hc = cs.filter(function (x) { return u.nk(nm(x)) === u.nk(g.home); })[0], ac = cs.filter(function (x) { return x !== hc; })[0];
      if (!hc || !ac) return null;
      var ty = ((c.status || e.status || {}).type) || {}, la = hc.linescores || [], lb = ac.linescores || [];
      var sets = la.map(function (l, i) { return [+l.value || 0, +((lb[i] || {}).value) || 0]; });
      var st = window.OnyxLive ? OnyxLive.tn.state(sets, null, ty.state === 'post') : {sa: 0, sb: 0};
      return {gid: g.gid, tennis: true, state: ty.state, detail: ty.shortDetail, away: g.away, home: g.home, sets: sets, hs: st.sa, as: st.sb,
              hg: sets.reduce(function (s, x) { return s + x[0]; }, 0), ag: sets.reduce(function (s, x) { return s + x[1]; }, 0), srv: hc.possession ? 0 : ac.possession ? 1 : null,
              need: /women/i.test(((c.type || {}).text) || '') ? 2 : 2, tour: /wta/i.test((e.name || '') + ' ' + ((e.league || {}).abbreviation || '')) ? 'WTA' : 'ATP', start: c.date || e.date, _m: {}};
    }
    function parseClock(s) { var m = /(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 0; }
    function poll() {
      if (S.demo && S.demo.on) return Promise.resolve();
      var T = tickets(), now = Date.now(), want = {}, props = {}, other = [];
      T.forEach(function (t) { t.legs.forEach(function (L) {
        if (L.other) { other.push(L); return; }
        var st = Date.parse(L.start); if (isNaN(st) || st - 10 * 60e3 > now) return;
        want[L.gid] = 1; if (L.kind === 'prop') props[L.gid] = 1;
      }); });
      var gids = Object.keys(want);
      var jobs = [];
      if (gids.length) jobs.push(Promise.all(LEAGUE.map(function (lg) { return fetch(ESPN + lg + '/scoreboard' + SBQ).then(function (r) { if (!r.ok) throw new Error('ESPN ' + r.status); return r.json(); }); })).then(function (js) {
        js.forEach(function (j) { (j.events || []).forEach(function (e) {
          if (TENNIS) { (e.groupings || []).forEach(function (gr) { (gr.competitions || []).forEach(function (c) { var x = tennisGame(c, e); if (x) S.live.sb[x.gid] = x; }); }); return; }
          var c = (e.competitions || [{}])[0], st = (e.status || c.status || {}), ty = st.type || {}, H = {};
          (c.competitors || []).forEach(function (x) { H[x.homeAway] = x; });
          var ab = function (x) { return ((x || {}).team || {}).abbreviation; }, sc = function (x) { return parseFloat((x || {}).score) || 0; };
          var per = st.period || 0, clk = parseClock(st.displayClock), fl = window.OnyxLive ? OnyxLive.left(SPORT, per, clk) : null;
          S.live.sb[e.id] = {state: ty.state, period: per, clock: clk, detail: ty.shortDetail, away: ab(H.away), home: ab(H.home), as: sc(H.away), hs: sc(H.home),
            f: ty.state === 'post' ? 0 : ty.state === 'pre' ? 1 : fl != null ? fl : 0.5, start: e.date};
        }); });
        S.live.err = null; S.live.at = Date.now();
        return Promise.all(Object.keys(props).filter(function (g) { var s = S.live.sb[g]; return s && s.state !== 'pre' && !(s.state === 'post' && S.live.sum[g] && S.live.sum[g]._post); }).map(function (g) {
          return fetch(ESPN + LEAGUE[0] + '/summary?event=' + g).then(function (r) { return r.json(); }).then(function (js) { js._post = S.live.sb[g].state === 'post'; S.live.sum[g] = js; }).catch(function () {});
        }));
      }).catch(function (e) { S.live.err = 'Live scores could not load (' + (e && e.message || 'network') + '). Retrying.'; }));
      if (other.length && window.OnyxSaved && OnyxSaved.track) jobs.push(Promise.all(other.map(function (L) { return OnyxSaved.track(L).then(function (t) { L.track = t; }).catch(function () {}); })));
      return Promise.all(jobs).then(function () { if (!(S.demo && S.demo.on)) update(true); });
    }
    function anyLive() {
      var now = Date.now();
      return tickets().some(function (t) { return t.legs.some(function (L) { var s = S.live.sb[L.gid], st = Date.parse(L.start); return (s && s.state === 'in') || (!s && !isNaN(st) && st <= now && now - st < 5 * 3600e3); }); });
    }
    function schedule() {
      clearTimeout(S.poll);
      S.poll = setTimeout(function () { if (!document.hidden && !(S.demo && S.demo.on)) poll().then(schedule, schedule); else schedule(); }, anyLive() ? 35e3 : 120e3);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !(S.demo && S.demo.on)) poll(); });

    // ── drawing ──
    function sigOf(T) { return (S.demo && S.demo.on ? 'demo|' : '') + T.map(function (t) { return t.id + ':' + t.legs.map(function (l) { return l.lid; }).join(','); }).join('|'); }
    function onyxFor(L) {
      if (L.sel) return u.onyxBtn({sel: L.sel, price: L.price}, L.price != null ? 'Onyx ' + u.odds(L.price) : 'Bet on Onyx');
      var today = L.kind === 'prop' && L.name ? D.byPlayer(L.name).filter(function (r) { return r.mkt === L.mkt && r.sel; }).sort(function (a, b) { return (b.side === L.side) - (a.side === L.side); })[0] : null;
      if (today) return u.onyxBtn(today, 'Onyx today ' + u.odds(today.price));
      return '<a class="sx-chip onyx" target="_blank" rel="noopener" href="https://app.onyxodds.com/?referrer=' + REF + '">Open Onyx</a>';
    }
    function legHTML(t, L, i) {
      return '<div class="sw-leg" data-k="' + i + '">'
        + '<div class="sw-lt"><div class="sw-ll"><b>' + u.esc(L.label || L.name) + '</b><small data-f="sc"></small></div><span class="sw-pill" data-f="st"></span></div>'
        + '<div class="sw-bar" data-f="barw"><i data-f="fill"></i><em data-f="mark"></em></div>'
        + '<div class="sw-lb"><span data-f="note"></span><span class="sw-ch"><b data-f="ch"></b><small>to hit</small></span></div>'
        + '<div class="sw-la">' + onyxFor(L) + '<span class="sw-src">' + u.esc((L.price != null ? 'Onyx ' + u.odds(L.price) + ' · ' : '') + (L.confSrc === 'line' ? 'from the line ' : L.confSrc === 'Onyx implied' ? 'Onyx implied ' : 'model ') + u.pct(L.conf0) + ' pregame') + '</span></div>'
        + '</div>';
    }
    function ticketHTML(t) {
      var legs = t.legs.length;
      return '<div class="sx-card sw-t" data-t="' + u.esc(t.id) + '"><div class="sw-fx" data-f="fx"></div>'
        + '<div class="sw-th"><div><div class="sx-k">' + u.esc(t.src) + (legs > 1 ? ' · ' + legs + ' legs' : '') + (t.price != null ? ' · Onyx ' + u.odds(t.price) : '') + '</div><h3 class="sw-tt">' + u.esc(legs > 1 ? t.title : (t.legs[0].label || t.title)) + '</h3></div>'
        + '<div class="sw-state" data-f="state"></div></div>'
        + '<div class="sw-tc"><div><div class="sx-k">' + (legs > 1 ? 'Chance all legs hit' : 'Chance it hits') + '</div><div class="sw-big" data-f="chance"></div><div class="sw-delta" data-f="delta"></div></div>'
        + '<svg class="sw-spark" viewBox="0 0 160 44" preserveAspectRatio="none" data-f="spark" aria-hidden="true"></svg></div>'
        + '<div class="sw-legs">' + t.legs.map(function (L, i) { return legHTML(t, L, i); }).join('') + '</div>'
        + (t.solo ? '<button class="sw-x" data-solo="' + u.esc(t.solo) + '" aria-label="Stop sweating">Remove</button>' : '')
        + '</div>';
    }
    function build(T) {
      S.refs = {};
      if (!T.length) {
        list.innerHTML = '<div class="sx-card sw-empty"><div class="sw-ball" aria-hidden="true"></div><h3 class="sx-h">Your sweat list is empty</h3>'
          + '<p class="sx-sub">Save ' + u.esc(D.sportName) + ' picks or a parlay (the star on any play), build a slip, or sweat any play from the box. They show up here, live, once games start.</p>'
          + '<button class="sx-btn" data-act="demo">Watch a demo replay</button> <a class="sx-btn ghost" href="' + u.esc(D.sportPage) + '">Find plays on Onyx ' + u.esc(D.sportName) + '</a></div>';
        return;
      }
      list.innerHTML = T.map(ticketHTML).join('');
      T.forEach(function (t) {
        var card = list.querySelector('[data-t="' + cssq(t.id) + '"]'); if (!card) return;
        var g = function (n, r) { return (r || card).querySelector('[data-f="' + n + '"]'); };
        S.refs[t.id] = {card: card, state: g('state'), chance: g('chance'), delta: g('delta'), spark: g('spark'), fx: g('fx'),
          legs: Array.prototype.map.call(card.querySelectorAll('.sw-leg'), function (lg) { return {el: lg, sc: g('sc', lg), st: g('st', lg), fill: g('fill', lg), mark: g('mark', lg), barw: g('barw', lg), note: g('note', lg), ch: g('ch', lg)}; })};
      });
    }
    function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
    var STATE = {pre: 'Pregame', sweat: 'Sweating', cashed: 'Cashed', busted: 'Busted', push: 'Push'};
    function sparkSVG(pts, pre) {
      if (!pts || pts.length < 2) return '<line x1="0" y1="' + (42 - 40 * (pre || 0)) + '" x2="160" y2="' + (42 - 40 * (pre || 0)) + '" class="sw-sp0"/>';
      var t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1, span = Math.max(1, t1 - t0);
      var xy = pts.map(function (p) { return ((p[0] - t0) / span * 160).toFixed(1) + ',' + (42 - 40 * p[1]).toFixed(1); });
      var last = pts[pts.length - 1][1], up = last >= (pre || 0);
      return '<line x1="0" y1="' + (42 - 40 * (pre || 0)).toFixed(1) + '" x2="160" y2="' + (42 - 40 * (pre || 0)).toFixed(1) + '" class="sw-sp0"/>'
        + '<polyline points="0,44 ' + xy.join(' ') + ' 160,44" class="sw-spa' + (up ? '' : ' dn') + '"/>'
        + '<polyline points="' + xy.join(' ') + '" class="sw-spl' + (up ? '' : ' dn') + '"/>';
    }
    function frameNow() { return S.demo && S.demo.on ? S.demo.frame(S.demo.t) : liveFrame(); }
    function update(fresh, quiet) {
      var T = tickets(), sig = sigOf(T);
      if (sig !== S.sig) { S.sig = sig; build(T); }
      var fr = frameNow(), demoOn = S.demo && S.demo.on, tick = demoOn ? S.demo.t : Date.now();
      T.forEach(function (t) {
        var R = S.refs[t.id]; if (!R) return;
        var E = evalTicket(t, fr, u);
        // the sparkline: the session's chance (the demo: the game so far)
        var sp = demoOn ? S.demo.sparkTo(t, S.demo.t) : (S.spark[t.id] = S.spark[t.id] || []);
        if (!demoOn && E.state !== 'pre') { var lp = sp[sp.length - 1]; if (!lp || Math.abs(lp[1] - E.chance) > 0.0005 || tick - lp[0] > 5 * 60e3) sp.push([tick, E.chance]); if (sp.length > 400) sp.shift(); }
        R.spark.innerHTML = sparkSVG(sp, E.pre);
        R.state.className = 'sw-state ' + E.state; R.state.textContent = STATE[E.state];
        R.chance.textContent = (E.chance * 100).toFixed(E.chance > 0.995 || E.chance < 0.005 ? 0 : 1) + '%';
        R.chance.className = 'sw-big ' + (E.state === 'cashed' ? 'sx-pos' : E.state === 'busted' ? 'sx-neg' : '');
        var dd = Math.round((E.chance - E.pre) * 100);
        R.delta.innerHTML = E.state === 'pre' ? 'Pregame chance, from the model' : START[0] + ' ' + u.pct(E.pre, 1) + ' · <b class="' + (dd >= 0 ? 'sx-pos' : 'sx-neg') + '">' + (dd >= 0 ? '+' : '') + dd + ' pts</b>';
        R.card.classList.toggle('cashed', E.state === 'cashed'); R.card.classList.toggle('busted', E.state === 'busted');
        E.legs.forEach(function (e, i) {
          var L = t.legs[i], r = R.legs[i]; if (!r) return;
          var G = L.other ? null : fr.game(L);
          r.sc.textContent = L.other ? (L.matchup || '') : G && G.state !== 'pre' && G.state !== 'unknown' ? score(G) + ' · ' + clockLabel(G) : (L.away && L.home ? L.away + ' @ ' + L.home : L.matchup || '');
          r.st.textContent = e.status; r.st.className = 'sw-pill ' + e.tone;
          r.note.textContent = e.note;
          r.ch.textContent = e.chance == null ? '-' : u.pct(e.chance);
          r.ch.className = e.res === 'hit' ? 'sx-pos' : e.res === 'miss' ? 'sx-neg' : '';
          if (e.div != null) { r.barw.classList.add('div'); var w = Math.abs(e.div) * 50; r.fill.style.left = (e.div >= 0 ? 50 : 50 - w) + '%'; r.fill.style.width = w + '%'; r.mark.style.left = '50%'; r.mark.style.display = ''; }
          else { r.barw.classList.remove('div'); r.fill.style.left = '0'; r.fill.style.width = (100 * (e.bar || 0)).toFixed(1) + '%'; if (e.mark != null) { r.mark.style.left = (100 * e.mark).toFixed(1) + '%'; r.mark.style.display = ''; } else r.mark.style.display = 'none'; }
          r.el.className = 'sw-leg ' + e.tone;
          // alerts: a leg hits or dies
          var key = t.id + '|' + L.lid, was = S.prevRes[key];
          if (e.res && e.res !== was) {
            S.prevRes[key] = e.res;
            if (was !== undefined && !quiet) {
              if (e.res === 'hit') { toast('good', 'Leg hit: ' + (L.label || L.name), e.note); burst(r.el); }
              else if (e.res === 'miss') toast('bad', 'Leg dead: ' + (L.label || L.name), e.note);
            }
          } else if (!e.res) S.prevRes[key] = S.prevRes[key] === undefined ? null : S.prevRes[key];
        });
        // alerts: a swing of 15+ points on a multi-leg ticket
        if (S.base[t.id] == null || E.state === 'pre' || S.lastState[t.id] === 'pre' || S.lastState[t.id] === undefined) S.base[t.id] = E.chance;
        else if (t.legs.length > 1 && E.state === 'sweat' && Math.abs(E.chance - S.base[t.id]) >= 0.15 && !quiet) {
          var d = E.chance - S.base[t.id];
          toast(d > 0 ? 'good' : 'bad', (t.slip ? 'Your slip' : t.title) + ' swung ' + (d > 0 ? '+' : '') + Math.round(d * 100) + ' pts', 'Now ' + u.pct(E.chance, 1) + ' to hit every leg');
          S.base[t.id] = E.chance;
        }
        var ws = S.lastState[t.id];
        if (E.state !== ws) {
          S.lastState[t.id] = E.state;
          if (ws !== undefined && !quiet && E.state === 'cashed') { confetti(R.fx); toast('good', (t.legs.length > 1 ? t.title : (t.legs[0].label || 'Your pick')) + ' cashed', t.price != null ? 'Onyx ' + u.odds(t.price) + ': $10 returns $' + (10 * u.dec(t.price)).toFixed(2) : 'Every leg hit'); }
          if (ws !== undefined && !quiet && E.state === 'busted' && t.legs.length > 1) toast('bad', t.title + ' busted', 'One leg missed. Bet the next one below.');
        }
      });
      drawHero(T, fr);
      if (fresh) drawNext(T);
    }

    // ── the hero: live count, kickoff countdown, or the demo scoreboard ──
    var countdownT = null;
    function nextKick() {
      var now = Date.now();
      return D.games.filter(function (g) { return g.state === 'pre' && Date.parse(g.start) > now; }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); })[0] || null;
    }
    function fmtLeft(ms) {
      var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d ? d + 'd ' + h + 'h ' + p(m) + 'm' : h ? h + 'h ' + p(m) + 'm ' + p(x) + 's' : m + 'm ' + p(x) + 's';
    }
    function drawHero(T, fr) {
      if (S.demo && S.demo.on) {
        var dm = S.demo, G = dm.frame(dm.t).g;
        var html = '<div class="sw-hk"><span class="sw-dot demo"></span>Demo replay · ' + u.esc(dm.title) + '</div>'
          + '<div class="sw-sb"><div class="sw-tm"><span>' + u.esc(G.away) + '</span><b>' + G.as + '</b></div><div class="sw-clock">' + u.esc(clockLabel(G)) + '</div><div class="sw-tm r"><b>' + G.hs + '</b><span>' + u.esc(G.home) + '</span></div></div>'
          + '<input type="range" class="sw-scrub" min="0" max="' + dm.len + '" step="' + dm.step + '" value="' + Math.round(dm.t) + '" aria-label="Game time">'
          + '<div class="sw-ctl"><button class="sx-btn" data-act="play">' + (S.playing ? 'Pause' : dm.t >= dm.len ? 'Replay' : 'Play') + '</button>'
          + '<button class="sx-btn ghost' + (S.speed === 1 ? ' on' : '') + '" data-act="sp1">1x</button><button class="sx-btn ghost' + (S.speed === 4 ? ' on' : '') + '" data-act="sp4">4x</button>'
          + '<button class="sx-btn ghost" data-act="end">Skip to final</button><button class="sx-btn ghost" data-act="exit">Exit demo</button></div>'
          + '<p class="sw-fine">' + u.esc(dm.note) + '</p>';
        if (hero.dataset.mode !== 'demo') { hero.innerHTML = html; hero.dataset.mode = 'demo'; }
        else {
          hero.querySelector('.sw-sb').outerHTML = '<div class="sw-sb"><div class="sw-tm"><span>' + u.esc(G.away) + '</span><b>' + G.as + '</b></div><div class="sw-clock">' + u.esc(clockLabel(G)) + '</div><div class="sw-tm r"><b>' + G.hs + '</b><span>' + u.esc(G.home) + '</span></div></div>';
          var sc = hero.querySelector('.sw-scrub'); if (document.activeElement !== sc) sc.value = Math.round(dm.t);
          var pb = hero.querySelector('[data-act="play"]'); pb.textContent = S.playing ? 'Pause' : dm.t >= dm.len ? 'Replay' : 'Play';
          hero.querySelector('[data-act="sp1"]').classList.toggle('on', S.speed === 1); hero.querySelector('[data-act="sp4"]').classList.toggle('on', S.speed === 4);
        }
        return;
      }
      hero.dataset.mode = 'live';
      var live = {}, ended = 0;
      Object.keys(S.live.sb).forEach(function (g) { if (S.live.sb[g].state === 'in') live[g] = S.live.sb[g]; });
      var mine = T.some(function (t) { return t.legs.some(function (L) { return live[L.gid]; }); });
      var nk = nextKick(), nlive = Object.keys(live).length;
      var head = nlive ? '<div class="sw-hk"><span class="sw-dot"></span>Live · ' + nlive + ' ' + u.esc(D.sportName) + (TENNIS ? ' match' + (nlive > 1 ? 'es' : '') : ' game' + (nlive > 1 ? 's' : '')) + ' in progress</div><div class="sw-hb t">' + (mine ? 'Your sweat is live' : 'Games are live') + '</div>'
        : nk ? '<div class="sw-hk">Next ' + START[0].toLowerCase() + ' · ' + u.esc(nk.away + (TENNIS ? ' vs ' : ' @ ') + nk.home) + ' · ' + u.esc(u.fmtTime(nk.start)) + '</div><div class="sw-hb" id="swCd">' + fmtLeft(Date.parse(nk.start) - Date.now()) + '</div>'
        : '<div class="sw-hk">No ' + u.esc(D.sportName) + (TENNIS ? ' match' : ' game') + ' on the board right now</div><div class="sw-hb t">The next slate posts with the board</div>';
      var n = T.length, legs = T.reduce(function (m, t) { return m + t.legs.length; }, 0);
      hero.innerHTML = '<div class="sw-hrow"><div>' + head
        + '<p class="sw-fine">' + (n ? 'Sweating ' + n + ' ticket' + (n > 1 ? 's' : '') + ', ' + legs + ' leg' + (legs > 1 ? 's' : '') + '. ' : '') + (nlive ? 'Live chances update about every 35 seconds and pause while this tab is hidden.' : (n ? 'Your list is ready. ' : 'Nothing on your list yet. ') + 'Watch a finished ' + (TENNIS ? 'match' : 'game') + ' replayed to see exactly what ' + (SPORT === 'nfl' ? 'Sunday' : 'a live sweat') + ' feels like.') + '</p>'
        + (S.live.err && T.length && T.some(function (t) { return t.legs.some(function (L) { return Date.parse(L.start) <= Date.now(); }); }) ? '<p class="sw-warn">' + u.esc(S.live.err) + '</p>' : '')
        + '</div><div class="sw-hbtn"><button class="sx-btn" data-act="demo">Demo replay</button>' + (n ? '<button class="sx-btn ghost" data-act="refresh">Refresh</button>' : '') + '</div></div>';
    }
    countdownT = setInterval(function () {
      if (document.hidden || (S.demo && S.demo.on)) return;
      var c = document.getElementById('swCd'), nk = nextKick(); if (c && nk) c.textContent = fmtLeft(Date.parse(nk.start) - Date.now());
    }, 1000);

    // ── "Bet the next one": the model's next lean on the same games, honestly labeled ──
    function drawNext(T) {
      var have = {}, gids = {};
      T.forEach(function (t) { t.legs.forEach(function (L) { if (L.sel) have[L.sel] = 1; if (L.gid) gids[L.gid] = 1; }); });
      var ok = function (r) { return r.sel && !have[r.sel] && !r.no_read && r.conf != null && r.edge != null && r.edge > 0 && r.price != null && r.price > -250 && r.price < 300 && !/^(first|two|three)_td$|^first_basket$|^trp_dbl$|_total$/.test(r.mkt); };
      var same = D.plays.filter(function (r) { return gids[r.gid] && ok(r); }).sort(function (a, b) { return b.edge - a.edge; }).slice(0, 3);
      var now = Date.now(), rows = same, scope = 'Same game as your sweat';
      if (!rows.length) { rows = D.plays.filter(function (r) { return ok(r) && Date.parse(r.start) > now; }).sort(function (a, b) { return b.edge - a.edge; }).slice(0, 3); scope = 'On today\'s board'; }
      nextEl.innerHTML = '<h3 class="sx-h">Bet the next one</h3><p class="sx-sub">' + scope + ': where the model\'s chance beats Onyx\'s price the most. A projection, not an Onyx Pick. Prices are Onyx\'s pregame lines; a live game\'s price on Onyx may differ.</p>'
        + (rows.length ? rows.map(function (r) {
          return '<div class="sw-nx"><div class="sw-nl"><b>' + u.esc(r.label) + '</b><small>' + u.esc(r.matchup + ' · ' + u.fmtTime(r.start)) + '</small><small>Model ' + u.pct(r.conf) + ' · edge +' + (100 * r.edge).toFixed(1) + ' pts' + (r.why && r.kind === 'prop' ? ' · ' + u.esc(String(r.why).split(';')[0]) : '') + '</small></div>'
            + '<div class="sw-nb">' + u.onyxBtn(r) + '<button class="sx-chip" data-sweat="' + u.esc(r.sel) + '">Sweat it</button></div></div>';
        }).join('') : '<p class="sx-sub">Nothing on the board beats Onyx\'s price right now.</p>');
    }

    // ── search: sweat any play ──
    var qEl = el.querySelector('#swQ'), resEl = el.querySelector('#swRes');
    function search() {
      var q = String(qEl.value || '').toLowerCase().trim();
      if (q.length < 2) { resEl.innerHTML = ''; return; }
      var toks = q.split(/\s+/), now = Date.now(), solo = lsGet(SOLO, []).map(function (p) { return p.id; });
      var hits = D.plays.filter(function (r) { var h = (r.label + ' ' + r.matchup + ' ' + (r.team || '') + ' ' + (MW[r.mkt] || '')).toLowerCase(); return toks.every(function (t) { return h.indexOf(t) >= 0; }); })
        .sort(function (a, b) { return (Date.parse(a.start) < now) - (Date.parse(b.start) < now) || (b.conf || 0) - (a.conf || 0); }).slice(0, 8);
      resEl.innerHTML = hits.length ? hits.map(function (r) {
        var on = solo.indexOf(r.sel) >= 0;
        return '<div class="sw-nx"><div class="sw-nl"><b>' + u.esc(r.label) + '</b><small>' + u.esc(r.matchup + ' · ' + u.fmtTime(r.start)) + (r.conf != null ? ' · model ' + u.pct(r.conf) : '') + '</small></div>'
          + '<div class="sw-nb">' + u.onyxBtn(r) + '<button class="sx-chip' + (on ? ' on' : '') + '" data-sweat="' + u.esc(r.sel) + '">' + (on ? 'Sweating' : '+ Sweat') + '</button></div></div>';
      }).join('') : '<p class="sx-sub">No play on today\'s board matches.</p>';
    }
    qEl.addEventListener('input', search);
    function sweatAdd(sel) {
      var r = D.plays.filter(function (x) { return x.sel === sel; })[0]; if (!r) return;
      var a = lsGet(SOLO, []);
      if (a.some(function (p) { return p.id === sel; })) { a = a.filter(function (p) { return p.id !== sel; }); toast('info', 'Stopped sweating', r.label); }
      else {
        var p = {id: sel}; ['sel', 'label', 'matchup', 'start', 'gid', 'kind', 'mkt', 'side', 'line', 'hcap', 'name', 'team', 'price', 'conf', 'proj', 'lam', 'why'].forEach(function (k) { if (r[k] != null) p[k] = r[k]; });
        p.sport = SPORT; a.push(p); toast('info', 'Added to your sweat', r.label + ' · not bet');
      }
      lsSet(SOLO, a.slice(-30));
      if (S.demo && S.demo.on) stopDemo(); else update(true, true);
      search();
    }

    // ── toasts and celebrations ──
    var toasts = el.querySelector('#swToasts');
    function toast(tone, title, sub) {
      var t = document.createElement('div'); t.className = 'sw-toast ' + tone;
      t.innerHTML = '<b>' + u.esc(title) + '</b>' + (sub ? '<small>' + u.esc(sub) + '</small>' : '');
      toasts.appendChild(t);
      while (toasts.children.length > 3) toasts.removeChild(toasts.firstChild);
      requestAnimationFrame(function () { t.classList.add('in'); });
      setTimeout(function () { t.classList.remove('in'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); }, 4200);
    }
    function burst(legEl) { legEl.classList.remove('burst'); void legEl.offsetWidth; legEl.classList.add('burst'); setTimeout(function () { legEl.classList.remove('burst'); }, 1200); }
    function confetti(fx) {
      if (!fx) return;
      var c = ['#b038f9', '#d795ff', '#61e970', '#635bff', '#ffffff'], h = '';
      for (var i = 0; i < 34; i++) h += '<i style="left:' + (2 + Math.random() * 96).toFixed(1) + '%;background:' + c[i % 5] + ';animation-delay:' + (Math.random() * 0.45).toFixed(2) + 's;--r:' + Math.round(Math.random() * 720 - 360) + 'deg;--x:' + Math.round(Math.random() * 60 - 30) + 'px"></i>';
      fx.innerHTML = h; fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
      setTimeout(function () { fx.innerHTML = ''; fx.classList.remove('go'); }, 2600);
    }

    // ── the demo replay ──
    var DEMO_P = null;
    function loadDemo() {
      if (!DEMO_P) DEMO_P = demoData(D).then(function (a) { return buildDemo(D, a, u); });
      return DEMO_P;
    }
    function startDemo(t0) {
      loadDemo().then(function (dm) {
        if (!dm) { toast('bad', 'No finished game to replay', 'The demo needs a recent final in the local data.'); return; }
        S.demo = dm; dm.on = true; dm.t = t0 || 0; S.prevRes = {}; S.base = {}; S.lastState = {}; S.sig = null;
        update(true, true); play(true);
        try { el.scrollIntoView({block: 'start'}); } catch (e) {}
      });
    }
    function play(on) {
      S.playing = on; clearInterval(S.timer);
      if (on && S.demo) {
        if (S.demo.t >= S.demo.len) { S.demo.t = 0; S.prevRes = {}; S.base = {}; S.lastState = {}; update(false, true); }
        S.timer = setInterval(function () {
          if (document.hidden) return;
          var dm = S.demo; if (!dm || !dm.on) { clearInterval(S.timer); return; }
          dm.t = Math.min(dm.len, dm.t + dm.len / 300 * S.speed);
          if (dm.t >= dm.len) { S.playing = false; clearInterval(S.timer); update(false); finalCheck(dm); return; }
          update(false);
        }, 250);
      }
      update(false, true);
    }
    function stopDemo() { if (S.demo) S.demo.on = false; play(false); S.playing = false; S.prevRes = {}; S.base = {}; S.lastState = {}; S.sig = null; hero.dataset.mode = ''; update(true, true); poll(); }
    function finalCheck(dm) { var r = selfTest(dm, u); if (r) CHECK = 'visible replay: ' + r; }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act],[data-sweat],[data-solo]'); if (!b) return;
      var a = b.getAttribute('data-act');
      if (b.hasAttribute('data-sweat')) return sweatAdd(b.getAttribute('data-sweat'));
      if (b.hasAttribute('data-solo')) { lsSet(SOLO, lsGet(SOLO, []).filter(function (p) { return p.id !== b.getAttribute('data-solo'); })); update(true, true); return; }
      if (a === 'demo') startDemo(0);
      else if (a === 'play') play(!S.playing);
      else if (a === 'sp1' || a === 'sp4') { S.speed = a === 'sp1' ? 1 : 4; update(false, true); }
      else if (a === 'end') { S.demo.t = S.demo.len; play(false); update(false); finalCheck(S.demo); }
      else if (a === 'exit') stopDemo();
      else if (a === 'refresh') poll();
    });
    el.addEventListener('input', function (e) {
      if (!e.target.classList.contains('sw-scrub') || !S.demo) return;
      var t = +e.target.value, back = t < S.demo.t;
      S.demo.t = t;
      if (back) { S.prevRes = {}; S.base = {}; S.lastState = {}; }
      update(false, true);
    });
    addEventListener('onyx-slip', function () { if (!(S.demo && S.demo.on)) update(true, true); });
    addEventListener('onyx-saved', function () { if (!(S.demo && S.demo.on)) update(true, true); });

    update(true, true);
    poll().then(schedule, schedule);
    // the self-check: the demo replayed start to finish, headless, against the box score
    loadDemo().then(function (dm) { CHECK = dm ? selfTest(dm, u) : 'no finished game in the local data to replay'; if (Studio.param('demo')) startDemo(+(Studio.param('t') || 0)); })
      .catch(function (e) { CHECK = 'demo replay failed to build: ' + (e && e.message); });
    return {show: function () { if (!(S.demo && S.demo.on)) { update(true, true); poll(); } }};
  }

  // ── the demo: a finished game, rebuilt from local files with a scripted clock ──
  function demoData(D) {
    var j = function (f, d) { return getJSON(D.dir + f).catch(function () { return d; }); };
    if (FOOTB) return Promise.all([D.history(), j('prop_archive.json', {}), j('results.json', {games: []})]);
    if (SPORT === 'nba') return Promise.all([j('player_games.json', {}), j('prop_archive.json', {}), j('team_games.json', {})]);
    if (TENNIS) return Promise.all([j('slate.json', {}), j('results.json', {matches: []}), j('pregame.json', {}), j('elo.json', {})]);
    return Promise.all([j('results.json', {games: []}), j('pregame.json', {})]);
  }
  function buildDemo(D, a, u) {
    if (FOOTB) return footDemo(a[0], a[1], a[2], u);
    if (SPORT === 'nba') return nbaDemo(a[0], a[1], a[2], u);
    if (TENNIS) return tennisDemo(D, a[0], a[1], a[2], a[3], u);
    return linesDemo(D, a[0], a[1], u);
  }
  function split(total, n, R) {   // total into n integer parts that sum exactly
    if (n <= 0) return [];
    var w = [], s = 0, i; for (i = 0; i < n; i++) { w.push(0.35 + R() * 1.3); s += w[i]; }
    var out = [], acc = 0; for (i = 0; i < n; i++) { var v = i === n - 1 ? total - acc : Math.round(total * w[i] / s); out.push(v); acc += v; }
    return out;
  }
  function times(n, R, lo, hi) { var a = []; for (var i = 0; i < n; i++) a.push(Math.round(lo + R() * (hi - lo))); return a.sort(function (x, y) { return x - y; }); }
  function ticketPrice(L, u) { return L.length && L.every(function (l) { return l.price != null; }) ? u.amer(L.reduce(function (m, l) { return m * u.dec(l.price); }, 1)) : null; }
  function clone(L, tag) { return L.map(function (l) { return Object.assign({}, l, {lid: l.lid + tag}); }); }
  function wantProp(side, fin, line) { return fin === line ? 'push' : (side === 'under' ? fin < line : fin > line) ? 'hit' : 'miss'; }
  function wantLine(L, hp, ap, hsets, asets) {   // a game line against the final: points (tennis games) and, for a tennis match, sets
    if (L.kind === 'total') { var t = hp + ap; return t === L.line ? 'push' : (L.side === 'under' ? t < L.line : t > L.line) ? 'hit' : 'miss'; }
    var my = L.name === L.home ? hp - ap : ap - hp;
    if (L.kind === 'ml') { if (hsets != null) my = L.name === L.home ? hsets - asets : asets - hsets; return my > 0 ? 'hit' : my < 0 ? 'miss' : 'push'; }
    var by = my + (L.hcap || 0); return by > 0 ? 'hit' : by < 0 ? 'miss' : 'push';
  }
  function noVig(ml, a, b) { var pa = ml[a], pb = ml[b]; if (pa == null) return null; var ia = Studio.u.imp(pa); return pb == null ? ia : ia / (ia + Studio.u.imp(pb)); }
  // the clock of a scripted game: periods of LENS[1] minutes; past regulation an overtime of 5 minutes
  function clockAt(t, len) {
    var per = LENS[1] * 60, reg = LENS[0] * per;
    if (t >= reg && len > reg) return {period: LENS[0] + 1, clock: Math.max(0, len - t), f: Math.max(0, (len - t) / len)};
    var p = Math.min(LENS[0], Math.floor(Math.min(t, reg - 1) / per) + 1);
    return {period: p, clock: t >= len ? 0 : per - (t - (p - 1) * per), f: Math.max(0, (len - t) / len)};
  }
  // a game line leg for a demo, its pregame chance from the sport's model at the opening whistle
  function lineLeg(o) {
    var L = Object.assign({sport: SPORT, price: null, confSrc: 'line'}, o), m = null;
    try {
      if (window.OnyxLive) m = TENNIS ? OnyxLive.model('tennis', {st: OnyxLive.tn.state([]), need: 2, tour: L.tour || 'ATP', pre_home_win: L.pre_home_win == null ? 0.5 : L.pre_home_win})
        : OnyxLive.model(SPORT, {f: 1, pre_margin: L.pre_margin || 0, pre_total: L.pre_total, pre_home_win: L.pre_home_win == null ? 0.5 : L.pre_home_win, hs: 0, as: 0});
    } catch (e) { m = null; }
    var hw = L.pre_home_win == null ? 0.5 : L.pre_home_win, home = L.name === L.home;
    if (L.kind === 'ml') { L.conf0 = home ? hw : 1 - hw; L.confSrc = L.price != null ? 'Onyx implied' : 'line'; }
    else if (L.kind === 'total') { var po = m ? m.over(L.line) : 0.5; L.conf0 = L.side === 'under' ? 1 - po : po; }
    else { var pc = m ? (home ? m.cover(L.hcap) : 1 - m.cover(-L.hcap)) : 0.5; L.conf0 = pc; }
    L.conf0 = clamp(L.conf0 == null || isNaN(L.conf0) ? 0.5 : L.conf0);
    return L;
  }
  function fmtH(h) { return (h > 0 ? '+' : '') + h; }

  // NFL / college football: the props that night against the final box score
  function finalStat(r, mkt) {
    var g = function (k) { return r[k] || 0; };
    if (TDK[mkt]) return g('rush_td') + g('rec_td');
    if (SUMS[mkt]) return SUMS[mkt].reduce(function (s, k) { return s + g(k); }, 0);
    if (mkt === 'pass_att') return g('att');
    return g(mkt);
  }
  function footDemo(rows, arch, res, u) {
    var byG = {}; (rows || []).forEach(function (r) { (byG[r.gid] = byG[r.gid] || []).push(r); });
    var finals = (res.games || []).filter(function (g) { return arch[g.id] && byG[g.id] && g.hs != null && g.as != null; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    for (var gi = 0; gi < finals.length; gi++) { var dm = footGame(finals[gi], arch[finals[gi].id], byG[finals[gi].id], u); if (dm) return dm; }
    return null;
  }
  function footGame(G0, A, box, u) {
    var R = rng(hash(G0.id)), byN = {}, LEN = LENS[0] * LENS[1] * 60;
    box.forEach(function (r) { byN[u.nk(r.name)] = r; });
    // candidate legs: the model's side of every priced line that night, for a player in the final box score
    var cand = [];
    Object.keys(A.pp || {}).forEach(function (k) {
      var v = A.pp[k], nm = k.split('|')[0], mkt = k.split('|')[1], r = byN[u.nk(nm)];
      if (!r || !MW[mkt] || mkt === 'first_td') return;
      var side, conf, price, proj = v.j, lam = v.lam;
      if (TDK[mkt]) { if (lam == null || v.o == null) return; side = 'over'; price = v.o; conf = poisGE(lam, TDK[mkt]); }
      else { if (proj == null) return; side = proj > v.l ? 'over' : 'under'; price = side === 'over' ? v.o : v.u; if (price == null) return; var po = propP(mkt, 0, proj, 1, v.l); conf = side === 'over' ? po : 1 - po; }
      var lab = TDK[mkt] ? nm + (mkt === 'anytime_td' ? ' anytime TD' : ' ' + TDK[mkt] + '+ TDs') : nm + ' ' + (side === 'over' ? 'Over' : 'Under') + ' ' + v.l + ' ' + MW[mkt];
      var fin = finalStat(r, mkt);
      cand.push({lid: 'd:' + k, sport: SPORT, label: lab, gid: G0.id, matchup: A.m, kind: 'prop', mkt: mkt, side: side, line: v.l, name: nm, team: r.team, price: price, conf: conf, conf0: conf, confSrc: 'model', proj: proj, lam: lam, away: G0.away, home: G0.home, start: A.start, _fin: fin, _want: wantProp(side, fin, v.l)});
    });
    var props = cand.filter(function (c) { return !TDK[c.mkt]; }).sort(function (a, b) { return b.conf - a.conf; });
    var tds = cand.filter(function (c) { return TDK[c.mkt]; }).sort(function (a, b) { return b.lam - a.lam; });
    if (props.length < 4) return null;
    var used = {}, A4 = [];
    props.forEach(function (c) { if (A4.length < 3 && !used[c.name]) { used[c.name] = 1; A4.push(c); } });
    var tot = A.tot, pm = A.sp && A.sp[G0.home] != null ? -A.sp[G0.home] : 0;
    if (tot != null) { var tl = lineLeg({lid: 'd:total', label: 'Over ' + tot + ' total', gid: G0.id, matchup: A.m, kind: 'total', mkt: 'total', side: 'over', line: tot, name: 'Total', away: G0.away, home: G0.home, start: A.start, pre_margin: pm, pre_total: tot}); tl._want = wantLine(tl, G0.hs, G0.as); A4.push(tl); }
    var hits = props.filter(function (c) { return c._want === 'hit' && A4.indexOf(c) < 0; }), B2 = [];
    hits.forEach(function (c) { if (B2.length < 2 && !B2.some(function (x) { return x.name === c.name; })) B2.push(c); });
    if (B2.length < 2) props.filter(function (c) { return c._want === 'hit'; }).forEach(function (c) { if (B2.length < 2 && B2.indexOf(c) < 0) B2.push(c); });
    var T = [];
    T.push({id: 'demoA', title: A4.length + '-leg parlay', src: 'Demo ticket', legs: clone(A4, ':a'), price: ticketPrice(A4, u)});
    if (B2.length === 2) T.push({id: 'demoB', title: '2-leg parlay', src: 'Demo ticket', legs: clone(B2, ':b'), price: ticketPrice(B2, u)});
    if (tds[0]) T.push({id: 'demoC', title: 'Single', src: 'Demo pick', legs: clone([tds[0]], ':c'), price: tds[0].price});

    // the scripted game: every box line spread over the clock, its touchdowns and the final score exactly
    var ev = [], sc = [];
    box.forEach(function (r) {
      var k = u.nk(r.name), tm = r.team;
      var addSeries = function (n, yds, mk, mkY, tdN, tdKey) {
        var cnt = n || (yds ? 1 : 0); if (!cnt) return;
        var tt = times(cnt, R, 40, LEN - 40), ys = split(yds || 0, cnt, R), E = [];
        for (var i = 0; i < cnt; i++) { var d = {}; if (n) d[mk] = 1; if (mkY) d[mkY] = ys[i]; E.push({t: tt[i], k: k, d: d}); }
        var idx = E.map(function (_, i) { return i; }).sort(function () { return R() - 0.5; }).slice(0, Math.min(tdN || 0, cnt));
        idx.forEach(function (i) { E[i].d[tdKey] = 1; if (tdKey !== 'pass_td') sc.push({t: E[i].t, team: tm, td: 1, who: r.name}); });
        ev.push.apply(ev, E);
      };
      addSeries(r.rec, r.rec_yds, 'rec', 'rec_yds', r.rec_td, 'rec_td');
      addSeries(r.rush_att, r.rush_yds, null, 'rush_yds', r.rush_td, 'rush_td');
      if (r.att || r.pass_yds) {
        var na = r.att || 1, nc = Math.min(na, r.cmp || (r.pass_yds ? 1 : 0)), ta = times(na, R, 40, LEN - 40);
        var ci = ta.map(function (_, i) { return i; }).sort(function () { return R() - 0.5; }).slice(0, nc).sort(function (a, b) { return a - b; });
        var ys = split(r.pass_yds || 0, nc, R), tdi = ci.slice().sort(function () { return R() - 0.5; }).slice(0, r.pass_td || 0);
        ta.forEach(function (t, i) { var d = {pass_att: 1}, j = ci.indexOf(i); if (j >= 0) { d.pass_yds = ys[j]; if (tdi.indexOf(i) >= 0) d.pass_td = 1; } ev.push({t: t, k: k, d: d}); });
      }
    });
    // points: 6 a touchdown, then extra points, field goals and anything left so the final matches
    [[G0.away, G0.as], [G0.home, G0.hs]].forEach(function (x) {
      var team = x[0], fin = Math.round(x[1]), mine = sc.filter(function (s) { return s.team === team; });
      var r = fin - 6 * mine.length, pats = 0, fgs = 0, rest = 0;
      for (var p = Math.min(mine.length, Math.max(0, r)); p >= 0; p--) { if ((r - p) >= 0 && (r - p) % 3 === 0) { pats = p; fgs = (r - p) / 3; rest = 0; break; } pats = -1; }
      if (pats < 0) { pats = Math.max(0, Math.min(mine.length, r)); fgs = Math.max(0, Math.floor((r - pats) / 3)); rest = r - pats - 3 * fgs; }
      mine.forEach(function (s, i) { s.pts = 6 + (i < pats ? 1 : 0); s.what = 'TD ' + s.who; });
      times(fgs, R, 120, LEN - 60).forEach(function (t) { sc.push({t: t, team: team, pts: 3, what: 'FG'}); });
      if (rest) sc.push({t: Math.round(LEN * (0.3 + R() * 0.6)), team: team, pts: rest, what: 'points'});
    });
    var firstTd = sc.filter(function (s) { return s.td; }).sort(function (a, b) { return a.t - b.t; })[0];
    return scripted({gid: G0.id, away: G0.away, home: G0.home, start: A.start, final: {as: Math.round(G0.as), hs: Math.round(G0.hs)}, len: LEN, step: 15,
      title: A.m + ' · ' + G0.date + ' final', tickets: T, ev: ev, sc: sc, first: firstTd ? {t: firstTd.t, who: firstTd.who} : null,
      note: 'A finished game replayed from this site\'s own files: the real Onyx pregame lines and the model\'s projections that night, and the final box score. The order of plays and the clock are scripted; every final stat and the final score are the real ones. Demo tickets, not bets.'}, u);
  }

  // the NBA: points, rebounds, assists and threes that night (prop_archive) against the final box (player_games, team_games)
  function nbaDemo(pg, arch, tg, u) {
    var byG = {};
    Object.keys(pg || {}).forEach(function (pid) {
      var rec = pg[pid]; if (pid.charAt(0) === '_' || !rec || !rec.g) return;
      rec.g.forEach(function (x) { (byG[x[1]] = byG[x[1]] || []).push({name: rec.n, home: !!x[3], min: x[4] || 0, pts: x[5] || 0, reb: x[6] || 0, ast: x[7] || 0, threes: x[8] || 0}); });
    });
    var gids = Object.keys(arch || {}).filter(function (k) { return arch[k] && arch[k].pp && /@/.test(arch[k].m || '') && byG[k]; })
      .sort(function (a, b) { return String(arch[b].start).localeCompare(String(arch[a].start)); });
    for (var i = 0; i < gids.length; i++) {
      var A = arch[gids[i]], tm = A.m.split(' @ '), away = tm[0], home = tm[1], box = byG[gids[i]];
      var th = ((tg || {})[home] || []).filter(function (r) { return r.gid === gids[i]; })[0];
      if (!th || box.length < 10) continue;
      var sum = {h: 0, a: 0}; box.forEach(function (r) { r.team = r.home ? home : away; sum[r.home ? 'h' : 'a'] += r.pts; });
      if (sum.h !== Math.round(th.pts) || sum.a !== Math.round(th.opp_pts)) continue;     // the box must add up to the final
      var dm = nbaGame(gids[i], A, away, home, box, {as: sum.a, hs: sum.h}, String(th.d || A.start).slice(0, 10), u);
      if (dm) return dm;
    }
    return null;
  }
  function nbaGame(gid, A, away, home, box, final, date, u) {
    var R = rng(hash(gid)), LEN = LENS[0] * LENS[1] * 60, byN = {};
    box.forEach(function (r) { byN[u.nk(r.name)] = r; });
    var cand = [];
    Object.keys(A.pp || {}).forEach(function (k) {
      var v = A.pp[k], nm = k.split('|')[0], mkt = k.split('|')[1], r = byN[u.nk(nm)];
      if (!r || !r.min || !/^(pts|reb|ast|threes|pra|pr|pa)$/.test(mkt) || v.j == null) return;
      var side = v.j > v.l ? 'over' : 'under', price = side === 'over' ? v.o : v.u; if (price == null) return;
      var po = propP(mkt, 0, v.j, 1, v.l), conf = side === 'over' ? po : 1 - po, fin = finalStat(r, mkt);
      cand.push({lid: 'd:' + k, sport: SPORT, label: nm + ' ' + (side === 'over' ? 'Over' : 'Under') + ' ' + v.l + ' ' + MW[mkt], gid: gid, matchup: A.m, kind: 'prop', mkt: mkt, side: side, line: v.l,
                 name: nm, team: r.team, price: price, conf: conf, conf0: conf, confSrc: 'model', proj: v.j, away: away, home: home, start: A.start, _fin: fin, _want: wantProp(side, fin, v.l)});
    });
    var props = cand.sort(function (a, b) { return b.conf - a.conf; });
    if (props.length < 4) return null;
    var used = {}, A4 = [];
    props.forEach(function (c) { if (A4.length < 3 && !used[c.name]) { used[c.name] = 1; A4.push(c); } });
    var pm = A.sp && A.sp[home] != null ? -A.sp[home] : 0;
    if (A.tot != null) { var tl = lineLeg({lid: 'd:total', label: 'Over ' + A.tot + ' total', gid: gid, matchup: A.m, kind: 'total', mkt: 'total', side: 'over', line: A.tot, name: 'Total', away: away, home: home, start: A.start, pre_margin: pm, pre_total: A.tot}); tl._want = wantLine(tl, final.hs, final.as); A4.push(tl); }
    var B2 = [];
    props.forEach(function (c) { if (B2.length < 2 && c._want === 'hit' && A4.indexOf(c) < 0 && !B2.some(function (x) { return x.name === c.name; })) B2.push(c); });
    var pts = props.filter(function (c) { return c.mkt === 'pts'; }).sort(function (a, b) { return b.line - a.line; })[0];
    var T = [{id: 'demoA', title: A4.length + '-leg parlay', src: 'Demo ticket', legs: clone(A4, ':a'), price: ticketPrice(A4, u)}];
    if (B2.length === 2) T.push({id: 'demoB', title: '2-leg parlay', src: 'Demo ticket', legs: clone(B2, ':b'), price: ticketPrice(B2, u)});
    if (pts) T.push({id: 'demoC', title: 'Single', src: 'Demo pick', legs: clone([pts], ':c'), price: pts.price});
    // every made shot, rebound and assist on the clock; the team score is the sum of its players' points
    var ev = [], sc = [];
    box.forEach(function (r) {
      if (!r.min) return;
      var k = u.nk(r.name), rest = r.pts - 3 * r.threes, twos = Math.max(0, Math.floor(rest / 2)), ones = Math.max(0, rest - 2 * twos);
      var add = function (n, d, pts) { times(n, R, 20, LEN - 20).forEach(function (t) { ev.push({t: t, k: k, d: d}); if (pts) sc.push({t: t, team: r.team, pts: pts, who: r.name}); }); };
      add(r.threes, {pts: 3, threes: 1}, 3); add(twos, {pts: 2}, 2); add(ones, {pts: 1}, 1); add(r.reb, {reb: 1}, 0); add(r.ast, {ast: 1}, 0);
    });
    var f1 = sc.slice().sort(function (a, b) { return a.t - b.t; })[0];
    return scripted({gid: gid, away: away, home: home, start: A.start, final: final, len: LEN, step: 12, title: A.m + ' · ' + date + ' final', tickets: T, ev: ev, sc: sc,
      first: f1 ? {t: f1.t, who: f1.who} : null,
      note: 'A finished game replayed from this site\'s own files: the real Onyx pregame lines and the model\'s projections that night, and the final box score. The order of baskets and the clock are scripted; every player\'s final line and the final score are the real ones. Demo tickets, not bets.'}, u);
  }

  // college basketball and the NHL: Onyx's game lines that night (pregame.json, else the home card's line) against the final
  function linesDemo(D, res, pre, u) {
    var fin = (res.games || []).filter(function (g) { return g.hs != null && g.as != null && g.home && g.away; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)); });
    for (var i = 0; i < fin.length; i++) { var p = pre[fin[i].id]; if (p && p.tot != null && p.sp) { var dm = linesGame(fin[i], p, u); if (dm) return dm; } }
    // no pregame line kept for a recent final: the team cards (today's teams) carry each recent game's score and line
    var teams = [];
    D.games.forEach(function (g) { [g.home, g.away].forEach(function (t) { if (t && teams.indexOf(t) < 0) teams.push(t); }); });
    return teams.slice(0, 10).reduce(function (pr, tm) {
      return pr.then(function (dm) {
        if (dm) return dm;
        return D.card(tm).then(function (c) {
          var r = c && c.team && (c.team.recent || []).filter(function (x) { return x.sp != null && x.tot != null && x.pf != null && x.pa != null && x.pf !== x.pa && x.opp; })[0];
          if (!r) return null;
          var home = r.ha === 'A' ? r.opp : tm, away = r.ha === 'A' ? tm : r.opp, sp = {};
          sp[tm] = r.sp; sp[r.opp] = -r.sp;
          var g = {id: 'card:' + tm + ':' + r.d, date: r.d, home: home, away: away, hs: tm === home ? r.pf : r.pa, as: tm === home ? r.pa : r.pf};
          return linesGame(g, {m: away + ' @ ' + home, start: r.d + 'T00:00Z', sp: sp, tot: r.tot, ml: {}, _card: true}, u);
        });
      });
    }, Promise.resolve(null));
  }
  function linesGame(G0, P, u) {
    var away = G0.away, home = G0.home, hs = Math.round(G0.hs), as = Math.round(G0.as), R = rng(hash(G0.id));
    var reg = LENS[0] * LENS[1] * 60, ot = !!G0.ot || hs === as, LEN = reg + (ot ? 300 : 0);
    var hcH = P.sp[home] != null ? P.sp[home] : P.sp[away] != null ? -P.sp[away] : null; if (hcH == null) return null;
    var ml = P.ml || {}, hw = noVig(ml, home, away);
    if (hw == null) hw = window.OnyxLive ? 1 - OnyxLive.phi(hcH / ((OnyxLive.SD[SPORT] || [12])[0] || 12)) : 0.5;
    if (SPORT === 'nhl' && noVig(ml, home, away) == null) hw = hcH < 0 ? 0.6 : 0.4;
    var base = {gid: G0.id, matchup: away + ' @ ' + home, away: away, home: home, start: P.start, pre_margin: -hcH, pre_total: P.tot, pre_home_win: hw};
    var fav = hcH <= 0 ? home : away, fh = fav === home ? hcH : -hcH;
    var legs = {
      spread: lineLeg(Object.assign({}, base, {lid: 'd:sp', label: fav + ' ' + fmtH(fh) + (SPORT === 'nhl' ? ' puck line' : ''), kind: 'spread', mkt: 'spread', side: 'over', name: fav, hcap: fh})),
      over: lineLeg(Object.assign({}, base, {lid: 'd:ov', label: 'Over ' + P.tot + ' total', kind: 'total', mkt: 'total', side: 'over', line: P.tot, name: 'Total'})),
      under: lineLeg(Object.assign({}, base, {lid: 'd:un', label: 'Under ' + P.tot + ' total', kind: 'total', mkt: 'total', side: 'under', line: P.tot, name: 'Total'}))
    };
    var win = hs > as ? home : away;
    if (ml[win] != null) legs.ml = lineLeg(Object.assign({}, base, {lid: 'd:ml', label: win + ' to win', kind: 'ml', mkt: 'ml', side: 'over', name: win, price: ml[win]}));
    Object.keys(legs).forEach(function (k) { legs[k]._want = wantLine(legs[k], hs, as); });
    var T = [{id: 'demoA', title: '2-leg parlay', src: 'Demo ticket', legs: clone([legs.spread, legs.over], ':a'), price: null},
             legs.ml ? {id: 'demoB', title: 'Single', src: 'Demo pick', legs: clone([legs.ml], ':b'), price: legs.ml.price}
                     : {id: 'demoB', title: 'Single', src: 'Demo ticket', legs: clone([legs.under], ':b'), price: null}];
    // the scoring: goals (hockey) or baskets of 1, 2 and 3 over regulation, level at the end of regulation when it went to overtime
    var sc = [], hockey = SPORT === 'nhl';
    var chunks = function (pts) { var out = []; if (hockey) { for (var i = 0; i < pts; i++) out.push(1); return out; } while (pts > 0) { var v = pts >= 3 && R() < 0.3 ? 3 : pts >= 2 && R() < 0.85 ? 2 : 1; out.push(v); pts -= v; } return out; };
    var lo = Math.min(hs, as), regTie = ot ? (hockey ? lo : Math.max(0, lo - Math.round(6 + R() * 6))) : null;
    [[away, as], [home, hs]].forEach(function (x) {
      var team = x[0], pts = Math.round(x[1]), inReg = ot ? regTie : pts, inOt = pts - inReg;
      var c1 = chunks(inReg), t1 = times(c1.length, R, 25, reg - 25);
      c1.forEach(function (v, i) { sc.push({t: t1[i], team: team, pts: v}); });
      if (inOt > 0) { var c2 = chunks(inOt), t2 = times(c2.length, R, reg + 20, LEN - 20); c2.forEach(function (v, i) { sc.push({t: t2[i], team: team, pts: v}); }); }
    });
    var src = P._card ? 'the line on the team card' : 'Onyx\'s pregame lines';
    return scripted({gid: G0.id, away: away, home: home, start: P.start, final: {as: as, hs: hs}, len: LEN, step: 15, ot: ot,
      title: away + ' @ ' + home + ' · ' + G0.date + ' final', tickets: T, ev: [], sc: sc, first: null,
      note: 'A finished game replayed from this site\'s own files: ' + src + ' that night and the final score. The order of ' + (hockey ? 'goals' : 'baskets') + ' and the clock are scripted; the final score is the real one. Demo tickets, not bets.'}, u);
  }

  // a scripted game (football, basketball, hockey) -> the demo object: frame(t) gives the score, the clock and every stat so far
  function scripted(o, u) {
    o.sc.sort(function (a, b) { return a.t - b.t; }); o.ev.sort(function (a, b) { return a.t - b.t; });
    function frame(t) {
      var c = clockAt(t, o.len), G = {state: t <= 0 ? 'pre' : t >= o.len ? 'post' : 'in', away: o.away, home: o.home, as: 0, hs: 0, start: o.start, period: c.period, clock: c.clock, f: c.f, ot: o.ot};
      o.sc.forEach(function (s) { if (s.t <= t) { if (s.team === o.home) G.hs += s.pts; else G.as += s.pts; } });
      var st = {}; o.ev.forEach(function (e) { if (e.t > t) return; var x = st[e.k] = st[e.k] || {}; for (var q in e.d) x[q] = (x[q] || 0) + e.d[q]; });
      return {g: G, game: function () { return G; },
        stat: function (L) { var x = st[u.nk(L.name)] || {}, g = function (k) { return x[k] || 0; };
          if (TDK[L.mkt]) return g('rush_td') + g('rec_td'); if (SUMS[L.mkt]) return SUMS[L.mkt].reduce(function (s, k) { return s + g(k); }, 0); return g(L.mkt); },
        first: function () { return o.first && o.first.t <= t ? o.first.who : null; }};
    }
    return demoObj(o, frame, u);
  }
  function demoObj(o, frame, u) {
    var SPK = {};
    return {gid: o.gid, title: o.title, tickets: o.tickets, frame: frame, t: 0, on: false, final: o.final, len: o.len, step: o.step || 15, note: o.note, tennis: !!o.tennis,
      sparkTo: function (tk, t) {
        var s = SPK[tk.id], dx = Math.max(1, o.len / 120); if (!s) { s = SPK[tk.id] = []; for (var x = 0; x <= o.len; x += dx) s.push([x, evalTicket(tk, frame(x), u).chance]); }
        var out = s.filter(function (p) { return p[0] <= t; }); out.push([t, evalTicket(tk, frame(t), u).chance]); return out;
      }};
  }

  // tennis: a finished match (every set's games from slate.json, else rebuilt from results.json's totals) at Onyx's prices
  function setOrder(a, b, R) {   // the order the games of one set were won (1: the set's winner), never finished early
    var W = a > b ? a : b, Lg = a > b ? b : a, ok = function (sq) { var x = 0, y = 0; for (var i = 0; i < sq.length - 1; i++) { if (sq[i]) x++; else y++; if (OnyxLive.tn.done(x, y)) return false; } return true; };
    for (var k = 0; k < 12; k++) {
      var sq = []; for (var i = 0; i < W - 1; i++) sq.push(1); for (i = 0; i < Lg; i++) sq.push(0);
      sq.sort(function () { return R() - 0.5; }); sq.push(1);
      if (!window.OnyxLive || ok(sq)) return sq;
    }
    var alt = []; for (i = 0; i < Lg; i++) { alt.push(1); alt.push(0); } for (i = Lg; i < W; i++) alt.push(1); return alt;   // level all the way, then the winner
  }
  function rebuildSets(m, wHome) {   // results.json keeps only totals: winner's sets 6-x, loser's sets x-6 (x up to 4), else nothing
    var sw = m.sets_w || 0, sl = m.sets_l || 0, rw = (m.games_l || 0) - 6 * sl, rl = (m.games_w || 0) - 6 * sw;   // loser's games in sets the winner took; winner's in the loser's
    if (rw < 0 || rl < 0 || rw > 4 * sw || rl > 4 * sl) return null;
    var dist = function (r, n) { var o = []; for (var i = 0; i < n; i++) { var v = Math.min(4, Math.ceil(r / (n - i))); o.push(v); r -= v; } return o; };
    var a = dist(rw, sw), b = dist(rl, sl), sets = [];
    b.forEach(function (x) { sets.push([x, 6]); }); a.forEach(function (x) { sets.push([6, x]); });   // [winner, loser]: the loser's sets first
    return sets.map(function (s) { return wHome ? s : [s[1], s[0]]; });
  }
  function tennisDemo(D, slate, res, pre, elo, u) {
    var cands = [];
    (slate.events || []).forEach(function (e) { (e.matches || []).forEach(function (m) {
      var p = m.p || []; if (m.state !== 'post' || p.length !== 2 || !(p[0].sets || []).length) return;
      var sets = p[1].sets.map(function (h, i) { return [+h || 0, +(p[0].sets[i]) || 0]; });
      cands.push({id: m.id, start: m.start, away: p[0].name, home: p[1].name, sets: sets, tour: e.tour, event: e.name, date: String(m.start).slice(0, 10)});
    }); });
    (res.matches || []).forEach(function (m) {
      if (!pre[m.id] || cands.some(function (c) { return c.id === m.id; })) return;
      var pm = String(pre[m.id].m || '').split(' vs '); if (pm.length !== 2) return;
      var wHome = m.w === pm[1]; if (!wHome && m.w !== pm[0]) return;
      var sets = rebuildSets(m, wHome); if (!sets) return;
      cands.push({id: m.id, start: pre[m.id].start, away: pm[0], home: pm[1], sets: sets, tour: m.tour, event: m.event, date: m.date, rebuilt: true});
    });
    cands.sort(function (a, b) { return (pre[b.id] ? 1 : 0) - (pre[a.id] ? 1 : 0) || String(b.start).localeCompare(String(a.start)); });
    var er = (elo && elo.r) || {}, ek = function (n) { return String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim(); };
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], P = pre[c.id], hw = null, ml = {};
      if (P && P.ml) { ml = P.ml; hw = noVig(ml, c.home, c.away); }
      if (hw == null) { var ra = er[ek(c.home)], rb = er[ek(c.away)]; if (ra && rb) hw = 1 / (1 + Math.pow(10, (rb[0] - ra[0]) / 400)); }
      if (hw == null) continue;
      var dm = tennisMatch(c, P || {}, ml, hw, u); if (dm) return dm;
    }
    return null;
  }
  function tennisMatch(c, P, ml, hw, u) {
    var R = rng(hash(c.id)), seq = [], need = 2, sw = {h: 0, a: 0};
    c.sets.forEach(function (s, si) {
      var hWon = s[0] > s[1]; sw[hWon ? 'h' : 'a']++;
      setOrder(s[0], s[1], R).forEach(function (w) { seq.push({set: si, home: w ? hWon : !hWon}); });
    });
    if (Math.max(sw.h, sw.a) < need) return null;
    var hg = c.sets.reduce(function (s, x) { return s + x[0]; }, 0), ag = c.sets.reduce(function (s, x) { return s + x[1]; }, 0), STEP = 40, LEN = seq.length * STEP;
    var base = {gid: c.id, matchup: c.away + ' vs ' + c.home, away: c.away, home: c.home, start: c.start, pre_home_win: hw, tour: c.tour || 'ATP', tennis: true};
    var fav = hw >= 0.5 ? c.home : c.away, legs = [];
    legs.push(lineLeg(Object.assign({}, base, {lid: 'd:ml', label: fav + ' to win', kind: 'ml', mkt: 'ml', side: 'over', name: fav, price: ml[fav] != null ? ml[fav] : null})));
    if (P.tot != null) legs.push(lineLeg(Object.assign({}, base, {lid: 'd:ov', label: 'Over ' + P.tot + ' total games', kind: 'total', mkt: 'total', side: 'over', line: P.tot, name: 'Total'})));
    var fh = P.sp && P.sp[fav] != null ? P.sp[fav] : null;
    if (fh != null) legs.push(lineLeg(Object.assign({}, base, {lid: 'd:sp', label: fav + ' ' + fmtH(fh) + ' games', kind: 'spread', mkt: 'spread', side: 'over', name: fav, hcap: fh})));
    legs.forEach(function (L) { L._want = wantLine(L, hg, ag, sw.h, sw.a); });
    var win = sw.h > sw.a ? c.home : c.away, T = [{id: 'demoA', title: legs.length > 1 ? legs.length + '-leg parlay' : 'Single', src: 'Demo ticket', legs: clone(legs, ':a'), price: ticketPrice(legs, u)}];
    if (ml[win] != null) { var wl = lineLeg(Object.assign({}, base, {lid: 'd:w', label: win + ' to win', kind: 'ml', mkt: 'ml', side: 'over', name: win, price: ml[win]})); wl._want = 'hit'; T.push({id: 'demoB', title: 'Single', src: 'Demo pick', legs: clone([wl], ':b'), price: wl.price}); }
    var CACHE = {};
    function frame(t) {
      var k = t <= 0 ? 0 : t >= LEN ? seq.length : Math.min(seq.length, Math.floor(t / STEP)), sets = [];
      for (var i = 0; i < k; i++) { var s = seq[i]; while (sets.length <= s.set) sets.push([0, 0]); sets[s.set][s.home ? 0 : 1]++; }
      var st = window.OnyxLive ? OnyxLive.tn.state(sets, null, t >= LEN) : {sa: 0, sb: 0};
      var G = {tennis: true, state: t <= 0 ? 'pre' : t >= LEN ? 'post' : 'in', away: c.away, home: c.home, sets: sets, hs: t >= LEN ? sw.h : st.sa, as: t >= LEN ? sw.a : st.sb,
               hg: sets.reduce(function (s, x) { return s + x[0]; }, 0), ag: sets.reduce(function (s, x) { return s + x[1]; }, 0), need: need, tour: c.tour, start: c.start, srv: null, _m: CACHE};
      return {g: G, game: function () { return G; }, stat: function () { return 0; }, first: function () { return null; }};
    }
    return demoObj({gid: c.id, title: c.away + ' vs ' + c.home + ' · ' + (c.event ? c.event + ' · ' : '') + c.date + ' final', tickets: T, final: {as: sw.a, hs: sw.h, ag: ag, hg: hg},
      len: LEN, step: STEP, tennis: true,
      note: 'A finished match replayed from this site\'s own files: ' + (P.ml ? 'Onyx\'s pregame prices' : 'the Elo ratings') + ' and the final score' + (c.rebuilt ? ' (the set scores rebuilt from the match totals)' : ', set by set') + '. The order of games is scripted; every set score is the real one. Demo tickets, not bets.'}, frame, u);
  }

  // the self-check: replay start to finish; every leg must resolve, never flip, and land where the final says
  function selfTest(dm, u) {
    var prev = {}, bad = '', step = Math.max(1, Math.round(dm.len / 300)), ts = [];
    for (var t = 0; t < dm.len; t += step) ts.push(t);
    ts.push(dm.len);
    for (var i0 = 0; i0 < ts.length && !bad; i0++) {
      var fr = dm.frame(ts[i0]);
      dm.tickets.forEach(function (tk) {
        var E = evalTicket(tk, fr, u);
        if (isNaN(E.chance) || E.chance < 0 || E.chance > 1) bad = tk.id + ' chance out of range at ' + ts[i0];
        E.legs.forEach(function (e, i) { var k = tk.id + i; if (prev[k] && prev[k] !== e.res) bad = tk.legs[i].label + ' flipped from ' + prev[k] + ' to ' + e.res; if (e.res) prev[k] = e.res; });
      });
    }
    if (bad) return bad;
    var fr2 = dm.frame(dm.len), G = fr2.g;
    if (G.as !== dm.final.as || G.hs !== dm.final.hs) return 'final score ' + G.as + '-' + G.hs + ' is not the real ' + dm.final.as + '-' + dm.final.hs;
    if (dm.tennis && (G.ag !== dm.final.ag || G.hg !== dm.final.hg)) return 'final games ' + G.ag + '-' + G.hg + ' are not the real ' + dm.final.ag + '-' + dm.final.hg;
    for (var i = 0; i < dm.tickets.length; i++) {
      var tk = dm.tickets[i], E = evalTicket(tk, fr2, u);
      for (var j = 0; j < tk.legs.length; j++) {
        var L = tk.legs[j], e = E.legs[j];
        if (L.kind === 'prop' && fr2.stat(L) !== L._fin) return L.label + ': replay ended at ' + fr2.stat(L) + ', the box score says ' + L._fin;
        if (!L._want) return L.label + ' has no real result to check against';
        if (e.res !== L._want) return L.label + ' resolved ' + e.res + ', the final says ' + L._want;
      }
      var wantT = E.legs.some(function (e) { return e.res === 'miss'; }) ? 'busted' : 'cashed';
      if (E.state !== wantT && E.state !== 'push') return tk.title + ' ended ' + E.state + ', expected ' + wantT;
      if (E.chance !== (wantT === 'cashed' ? 1 : 0)) return tk.title + ' final chance ' + E.chance;
    }
    return '';
  }

  var CSS = [
    '.sw{position:relative}',
    '.sw-hero{margin-bottom:12px;background:linear-gradient(150deg,rgba(176,56,249,.16),rgba(255,255,255,.03) 60%)}',
    '.sw-hrow{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-end}.sw-hrow>div:first-child{min-width:0;flex:1 1 280px}',
    '.sw-hk{font:700 11px monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--pur2);display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
    '.sw-hb{font:800 clamp(28px,8vw,44px)/1.05 monospace;margin:6px 0 4px;letter-spacing:-.01em}',
    '.sw-hb.t{font:800 clamp(22px,6vw,32px)/1.15 system-ui,sans-serif}',
    '.sw-hbtn{display:flex;gap:8px;flex-wrap:wrap}',
    '.sw-fine{margin:6px 0 0;color:var(--mute);font-size:12px;line-height:1.5}.sw-warn{margin:6px 0 0;color:var(--red);font-size:12px}',
    '.sw-dot{width:8px;height:8px;border-radius:50%;background:#ff4d7d;box-shadow:0 0 0 0 rgba(255,77,125,.6);animation:swp 1.6s infinite;flex:none}.sw-dot.demo{background:var(--pur)}',
    '@keyframes swp{70%{box-shadow:0 0 0 8px rgba(255,77,125,0)}100%{box-shadow:0 0 0 0 rgba(255,77,125,0)}}',
    '.sw-sb{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;margin:12px 0 10px}',
    '.sw-tm{display:flex;align-items:baseline;gap:10px;font:800 15px monospace;color:var(--dim)}.sw-tm b{font:800 clamp(34px,9vw,52px)/1 monospace;color:#fff}.sw-tm.r{justify-content:flex-end}',
    '.sw-clock{font:800 13px monospace;color:#fff;background:rgba(176,56,249,.25);border:1px solid var(--pur);border-radius:999px;padding:6px 12px;white-space:nowrap}',
    '.sw-scrub{width:100%;accent-color:#b038f9;margin:2px 0 8px}',
    '.sw-ctl{display:flex;gap:6px;flex-wrap:wrap}.sw-ctl .sx-btn{padding:8px 12px;font-size:12.5px}.sw-ctl .sx-btn.on{background:rgba(176,56,249,.25)}',
    '.sw-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}',
    '@media (min-width:960px){.sw-cols{grid-template-columns:minmax(0,1fr) 340px}.sw-side{position:sticky;top:64px;align-self:start}}',
    '.sw-main #swList{display:grid;gap:12px}.sw-side{display:grid;gap:12px;min-width:0}',
    '.sw-t{position:relative;overflow:hidden;transition:border-color .3s,box-shadow .3s}',
    '.sw-t.cashed{border-color:rgba(97,233,112,.6);box-shadow:0 0 0 1px rgba(97,233,112,.25),0 0 30px rgba(97,233,112,.12)}.sw-t.busted{border-color:rgba(255,138,138,.45)}',
    '.sw-th{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.sw-th>div:first-child{min-width:0}',
    '.sw-tt{margin:4px 0 0;font-size:17px;line-height:1.3;overflow-wrap:anywhere}',
    '.sw-state{flex:none;font:900 13px monospace;letter-spacing:.1em;text-transform:uppercase;padding:7px 11px;border-radius:10px;border:1px solid var(--line);color:var(--dim)}',
    '.sw-state.sweat{color:#fff;border-color:var(--pur);background:rgba(176,56,249,.2);animation:swg 2s ease-in-out infinite}',
    '@keyframes swg{50%{box-shadow:0 0 18px rgba(176,56,249,.55)}}',
    '.sw-state.cashed{color:#0c0c0c;background:var(--grn);border-color:var(--grn);animation:swpop .5s cubic-bezier(.2,1.6,.4,1)}.sw-state.busted{color:var(--red);border-color:rgba(255,138,138,.5);background:rgba(255,138,138,.08)}',
    '@keyframes swpop{0%{transform:scale(.5)}100%{transform:scale(1)}}',
    '.sw-tc{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:10px 0 6px}.sw-tc>div{min-width:0}',
    '.sw-big{font:800 34px/1.05 monospace}.sw-delta{font:600 11.5px monospace;color:var(--mute);margin-top:3px}',
    '.sw-spark{width:min(46%,180px);height:46px;flex:none}.sw-sp0{stroke:rgba(255,255,255,.22);stroke-dasharray:3 3;stroke-width:1;vector-effect:non-scaling-stroke}',
    '.sw-spl{fill:none;stroke:#d795ff;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round}.sw-spl.dn{stroke:#ff8a8a}',
    '.sw-spa{fill:rgba(176,56,249,.16);stroke:none}.sw-spa.dn{fill:rgba(255,138,138,.1)}',
    '.sw-legs{display:grid;gap:8px;margin-top:8px}',
    '.sw-leg{position:relative;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px;background:rgba(0,0,0,.22);transition:border-color .3s,background .3s}',
    '.sw-leg.hit{border-color:rgba(97,233,112,.55);background:rgba(97,233,112,.07)}.sw-leg.dead{border-color:rgba(255,138,138,.4);background:rgba(255,138,138,.06)}.sw-leg.dead b{text-decoration:line-through;text-decoration-color:rgba(255,138,138,.6)}',
    '.sw-leg.burst::after{content:"";position:absolute;inset:-2px;border-radius:13px;border:2px solid var(--grn);animation:swb 1.1s ease-out forwards;pointer-events:none}',
    '@keyframes swb{0%{opacity:1;transform:scale(.97);box-shadow:0 0 0 0 rgba(97,233,112,.7)}100%{opacity:0;transform:scale(1.04);box-shadow:0 0 0 14px rgba(97,233,112,0)}}',
    '.sw-lt{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.sw-ll{min-width:0}.sw-ll b{display:block;font-size:14px;line-height:1.3;overflow-wrap:anywhere}.sw-ll small{display:block;font:600 11px monospace;color:var(--mute);margin-top:2px;overflow-wrap:anywhere}',
    '.sw-pill{flex:none;font:800 10.5px monospace;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:4px 8px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}',
    '.sw-pill.good{color:var(--grn);border-color:rgba(97,233,112,.45)}.sw-pill.live{color:var(--pur2);border-color:rgba(176,56,249,.55)}.sw-pill.bad{color:var(--red);border-color:rgba(255,138,138,.4)}',
    '.sw-pill.hit{color:#0c0c0c;background:var(--grn);border-color:var(--grn)}.sw-pill.dead{color:#fff;background:#b8404f;border-color:#b8404f}',
    '.sw-bar{position:relative;height:10px;border-radius:999px;background:rgba(255,255,255,.08);margin:9px 0 7px;overflow:visible}',
    '.sw-bar i{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:linear-gradient(90deg,#7a2ce0,#d795ff);transition:width .35s ease,left .35s ease}',
    '.sw-leg.hit .sw-bar i,.sw-leg.good .sw-bar i{background:linear-gradient(90deg,#2f9d3c,#61e970)}.sw-leg.dead .sw-bar i,.sw-leg.bad .sw-bar i{background:linear-gradient(90deg,#9b3442,#ff8a8a)}',
    '.sw-bar em{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:#fff;border-radius:2px;box-shadow:0 0 0 2px rgba(12,12,12,.7)}',
    '.sw-lb{display:flex;justify-content:space-between;align-items:flex-end;gap:8px;font:600 11.5px monospace;color:var(--dim)}.sw-lb>span:first-child{min-width:0;overflow-wrap:anywhere}',
    '.sw-ch{text-align:right;flex:none}.sw-ch b{display:block;font:800 18px monospace;color:#fff}.sw-ch small{font-size:9.5px;color:var(--mute);letter-spacing:.06em;text-transform:uppercase}',
    '.sw-la{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}.sw-src{font:600 10.5px monospace;color:var(--mute)}',
    '.sw-x{margin-top:10px;background:none;border:0;color:var(--mute);font:700 11px monospace;cursor:pointer;padding:4px 0;text-decoration:underline}',
    '.sw-fx{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2}',
    '.sw-fx i{position:absolute;top:-14px;width:7px;height:13px;border-radius:2px;opacity:0}',
    '.sw-fx.go i{animation:swc 2.1s ease-in forwards}',
    '@keyframes swc{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--x),520px) rotate(var(--r))}}',
    '.sw-empty{text-align:center;padding:26px 16px}.sw-empty .sx-btn{margin:4px}.sw-empty a.sx-btn{display:inline-block;text-decoration:none}',
    '.sw-ball{width:54px;height:34px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#7a2ce0,#b038f9);position:relative;transform:rotate(-20deg);box-shadow:0 6px 24px rgba(176,56,249,.4)}',
    '.sw-ball::after{content:"";position:absolute;left:14px;right:14px;top:16px;height:2px;background:#fff;border-radius:2px;box-shadow:0 0 0 0 #fff}',
    '.sw-res{margin-top:8px}.sw-nx{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px 0;border-top:1px solid rgba(255,255,255,.07)}',
    '.sw-nl{min-width:0}.sw-nl b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}.sw-nl small{display:block;font:600 10.5px monospace;color:var(--mute);margin-top:2px;overflow-wrap:anywhere}',
    '.sw-nb{display:flex;flex-direction:column;gap:5px;align-items:flex-end;flex:none}.sw-nb .sx-chip{font-size:11px;padding:5px 9px}.sw-nb .sx-chip.on{border-color:var(--grn);color:var(--grn)}',
    '.sw-toasts{position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:9500;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 24px));pointer-events:none}',
    '.sw-toast{background:#151318;border:1px solid var(--line);border-left:4px solid var(--pur);border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.6);opacity:0;transform:translateY(-10px);transition:opacity .25s,transform .25s}',
    '.sw-toast.in{opacity:1;transform:none}.sw-toast.good{border-left-color:var(--grn)}.sw-toast.bad{border-left-color:var(--red)}',
    '.sw-toast b{display:block;font-size:13.5px}.sw-toast small{display:block;color:var(--dim);font:600 11px monospace;margin-top:2px}',
    '@media (prefers-reduced-motion: reduce){.sw-fx{display:none}.sw-state,.sw-dot,.sw-leg.burst::after{animation:none!important}}'
  ].join('\n');

  Studio.register('sweat', {title: NAME, order: 4, mount: mount});
})();
