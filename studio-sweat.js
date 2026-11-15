// studio-sweat.js - Sunday Sweat (11/15, Jordan: "the live board for your bets during NFL games"). One board for
// everything this device is riding: saved NFL picks and saved parlay tickets (OnyxSaved), the current slip
// (OnyxParlay), and plays added here just to sweat (onyxSweatOnly, nothing bet).
//
// Per leg, live: the stat so far against the line (a bar), the game score and clock, a status (hit, dead, on pace,
// needs X more) and the live chance it hits. Props: the stat so far plus the model's projection for the time left,
// with live.js's fitted live prop spread (OnyxLive.propP: PK scales the projection still to come, YSD / PVAR the
// spread); touchdown markets are Poisson on the model's expected TDs for the time left. Game lines: OnyxLive.model
// (the in-game normal draw fitted on 1,391 finished games) from the score, the time left and the model's pregame
// team scores. A ticket's chance is its legs' chances multiplied (legs treated as independent).
//
// Live data: ESPN's NFL scoreboard and box score (the same feeds saved.js and live.js read), every 35 s while a game
// on the list is live, paused while the tab is hidden. Legs from other sports on a saved parlay follow
// OnyxSaved.track.
//
// Demo replay: a finished game rebuilt from local files only (data/nfl/prop_archive.json: the real pregame Onyx lines
// and model projections that night; data/nfl/player_games.json: the final box lines; data/nfl/results.json: the
// final score). The order of plays is scripted (seeded), the totals are the box score's exactly, so every leg lands
// where it really did. Studio.checks.sweat replays it start to finish headless and returns '' only when every leg
// resolves to the hit or miss the box score says.
(function () {
  'use strict';
  if (!window.Studio) return;
  var SOLO = 'onyxSweatOnly', ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/', REF = 'KR680261';
  var CHECK = 'the demo replay self-test has not finished';
  Studio.checks.sweat = function () { return CHECK; };

  var MW = {rec: 'receptions', rec_yds: 'receiving yards', rush_yds: 'rushing yards', pass_yds: 'passing yards', pass_att: 'pass attempts',
    pass_td: 'passing TDs', rush_rec_yds: 'rushing + receiving yards', pass_rush_yds: 'passing + rushing yards', anytime_td: 'TDs',
    two_td: 'TDs', three_td: 'TDs', first_td: 'first TD'};
  var MS = {rec: 'catches', rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds', pass_att: 'attempts', pass_td: 'pass TD',
    rush_rec_yds: 'rush+rec yds', pass_rush_yds: 'pass+rush yds', anytime_td: 'TD', two_td: 'TD', three_td: 'TD', first_td: 'TD'};
  var TDK = {anytime_td: 1, two_td: 2, three_td: 3};
  var GAME = 3600;

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

  // a game's moment -> {state, f (share left), as, hs, label}
  function clockLabel(G) {
    if (!G) return '';
    if (G.state === 'post') return 'Final';
    if (G.state === 'pre') return G.start ? Studio.u.fmtTime(G.start) : 'Pregame';
    if (G.detail && !G.period) return G.detail;
    var c = Math.max(0, Math.round(G.clock || 0)), m = Math.floor(c / 60), s = c % 60;
    return (G.period > 4 ? 'OT' : 'Q' + G.period) + ' ' + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function score(G) { return G && G.state !== 'pre' && G.away ? G.away + ' ' + G.as + ' · ' + G.home + ' ' + G.hs : ''; }

  // one leg against one moment. L: the normalized leg; G: its game; cur: the stat so far (props); first: first TD scorer
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
    if (G.state === 'pre') { o.note = 'Kicks off ' + clockLabel(G); return o; }
    var f = G.state === 'post' ? 0 : Math.max(0, Math.min(1, G.f)), done = G.state === 'post', el = 1 - f;
    if (L.kind === 'prop') {
      cur = cur == null ? 0 : cur; o.cur = cur;
      var unit = MS[L.mkt] || '', line = L.line, over = L.side !== 'under';
      if (L.mkt === 'first_td') {
        if (first) { o.res = u.nk(first) === u.nk(L.name) ? 'hit' : 'miss'; }
        else if (done) o.res = 'miss';
        o.chance = o.res === 'hit' ? 1 : o.res === 'miss' ? 0 : L.conf0;
        o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'No TD yet';
        o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'live';
        o.note = first ? 'First TD: ' + first : 'Nobody has scored a TD yet';
        o.bar = o.res === 'hit' ? 1 : 0; return o;
      }
      var max = Math.max(line * 1.45, cur * 1.08, line + 1.5);
      o.bar = Math.min(1, cur / max); o.mark = line / max;
      var td = TDK[L.mkt], pOver;
      if (cur > line) pOver = 1;
      else if (done) pOver = 0;
      else if (td) pOver = poisGE(L.lam * f * (L.tdk || 1), Math.ceil(line - cur + 0.0001));
      else pOver = propP(L.mkt, cur, L.proj, f, line);
      var hitNow = over ? cur > line : (done && cur < line), deadNow = over ? (done && cur <= line) : cur > line;
      if (cur === line && done) o.res = 'push';
      else if (hitNow) o.res = 'hit'; else if (deadNow) o.res = 'miss';
      o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(over ? pOver : 1 - pOver);
      var need = Math.floor(line) + 1 - cur, room = Math.floor(line) - cur, pace = el > 0.06 ? cur / el : null;
      var paceTxt = pace != null && !done && !o.res && !td ? ' · pace ' + (pace >= 20 ? Math.round(pace) : pace.toFixed(1)) : '';
      o.note = td ? cur + ' TD' + (cur === 1 ? '' : 's') + (o.res ? '' : ' · needs ' + need + ' more') : cur + ' of ' + line + ' ' + unit + paceTxt;
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
    // game lines
    var mine = L.name === G.home ? 'h' : L.name === G.away ? 'a' : null, m = G.hs - G.as, tot = G.hs + G.as;
    var mdl = window.OnyxLive && !done ? OnyxLive.model('nfl', {f: Math.max(f, 0.004), pre_margin: L.pre_margin, pre_total: L.pre_total, hs: G.hs, as: G.as}) : null;
    if (L.kind === 'total') {
      var ov = L.side !== 'under';
      o.cur = tot; var mx = Math.max(L.line * 1.35, tot * 1.08); o.bar = Math.min(1, tot / mx); o.mark = L.line / mx;
      if (tot > L.line) o.res = ov ? 'hit' : 'miss'; else if (done) o.res = tot === L.line ? 'push' : ov ? 'miss' : 'hit';
      var pov = mdl ? mdl.over(L.line) : (tot > L.line ? 1 : 0);
      o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(ov ? pov : 1 - pov);
      var pt = mdl ? mdl.proj_total : tot;
      o.note = tot + ' of ' + L.line + ' points' + (mdl ? ' · model pace ' + pt.toFixed(1) : '');
      if (o.res) { o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'Push'; o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'pre'; }
      else if (ov) { o.status = pt > L.line ? 'On pace' : 'Needs ' + Math.ceil(L.line - tot + 0.01) + ' more'; o.tone = pt > L.line ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
      else { o.status = pt < L.line ? 'On pace' : 'Over pace'; o.note += ' · ' + Math.floor(L.line - tot) + ' to spare'; o.tone = pt < L.line ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
      return o;
    }
    if (!mine) { o.note = 'Score ' + score(G); return o; }
    var my = mine === 'h' ? m : -m, h = L.kind === 'spread' ? (L.hcap || 0) : 0, by = my + h;
    o.cur = my; o.div = Math.max(-1, Math.min(1, by / 21));
    if (done) o.res = by > 0 ? 'hit' : by === 0 ? 'push' : 'miss';
    var pw = null;
    if (mdl) { var hw = L.kind === 'spread' ? (mine === 'h' ? mdl.cover(h) : 1 - mdl.cover(-h)) : (mine === 'h' ? mdl.win() : 1 - mdl.win()); pw = hw; }
    o.chance = o.res === 'hit' || o.res === 'push' ? 1 : o.res === 'miss' ? 0 : clamp(pw == null ? 0.5 : pw);
    var lead = my > 0 ? 'Up ' + my : my < 0 ? 'Down ' + (-my) : 'Tied';
    o.note = L.name + ' ' + lead.toLowerCase() + (L.kind === 'spread' ? ' · ' + (by > 0 ? 'covering by ' + by : by === 0 ? 'on the number' : 'needs ' + (Math.floor(-by) + 1) + ' more') : '');
    if (o.res) { o.status = o.res === 'hit' ? 'Hit' : o.res === 'miss' ? 'Dead' : 'Push'; o.tone = o.res === 'hit' ? 'hit' : o.res === 'miss' ? 'dead' : 'pre'; }
    else { o.status = by > 0 ? (L.kind === 'spread' ? 'Covering' : 'Leading') : by === 0 ? 'Even' : 'Needs ' + (Math.floor(-by) + 1) + ' more'; o.tone = by > 0 ? 'good' : o.chance < 0.25 ? 'bad' : 'live'; }
    return o;
  }

  // a ticket's legs -> its state and live chance
  function evalTicket(T, frame, u) {
    var E = T.legs.map(function (L) {
      var G = L.other ? null : frame.game(L);
      return evalLeg(L, G, L.kind === 'prop' && G && G.state !== 'pre' ? frame.stat(L) : null, L.mkt === 'first_td' && G ? frame.first(L) : null, u);
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
    rows.some(function (r) { var m = /model (\w+) ([\d.]+) (\w+) ([\d.]+)/.exec(r.why || ''); if (m) { out = {}; out[m[1]] = +m[2]; out[m[3]] = +m[4]; } return !!out; });
    return out;
  }
  function teamsOf(D, p) {
    var g = D.game(p.gid);
    if (g) return {away: g.away, home: g.home, start: g.start};
    var m = String(p.matchup || ''), a = m.split(' @ ');
    if (a.length === 2) return {away: a[0], home: a[1], start: p.start};
    a = m.split(' vs '); return a.length === 2 ? {away: a[1], home: a[0], start: p.start} : {away: null, home: null, start: p.start};
  }
  function norm(D, p, i) {
    var row = boardRow(D, p) || {}, L = {};
    ['sel', 'sport', 'label', 'matchup', 'start', 'gid', 'team', 'price', 'conf', 'kind', 'mkt', 'side', 'line', 'hcap', 'name', 'proj', 'lam', 'why', 'edge', 'no_read'].forEach(function (k) { L[k] = p[k] != null ? p[k] : row[k]; });
    L.sel = L.sel || row.sel || (p.id && !/^(k:|t:)/.test(p.id) ? p.id : null);
    L.lid = p.id || L.sel || ('leg' + i);
    L.sport = L.sport || 'nfl';
    if (L.sport !== 'nfl') { L.other = true; L.conf0 = L.conf != null ? L.conf : L.price != null ? Studio.u.imp(L.price) : 0.5; return L; }
    var tm = teamsOf(D, L); L.away = tm.away; L.home = tm.home; L.start = L.start || tm.start;
    L.conf0 = L.conf != null ? L.conf : L.price != null ? Studio.u.imp(L.price) : 0.5;
    L.confSrc = L.conf != null ? 'model' : 'Onyx implied';
    if (L.kind === 'prop') {
      var pOver = L.side === 'under' ? 1 - L.conf0 : L.conf0;
      if (TDK[L.mkt]) { if (L.lam == null) L.lam = lamFor(L.mkt, pOver); }
      else if (L.mkt !== 'first_td' && L.proj == null && L.line != null) L.proj = projFor(L.mkt, L.line, pOver);
    } else {
      var sc = modelScores(D, L.gid);
      if (sc && L.home && sc[L.home] != null && sc[L.away] != null) { L.pre_margin = sc[L.home] - sc[L.away]; L.pre_total = sc[L.home] + sc[L.away]; }
      else {
        L.pre_margin = L.kind === 'spread' && L.hcap != null ? (L.name === L.home ? -L.hcap : L.hcap) : 0;
        L.pre_total = L.kind === 'total' ? L.line : 44;
      }
    }
    return L;
  }

  function mount(el, D, u) {
    var css = document.createElement('style'); css.id = 'sx-sweat-css'; css.textContent = CSS; document.head.appendChild(css);
    var S = {demo: null, live: {sb: {}, sum: {}, err: null, at: 0, other: {}}, spark: {}, prevRes: {}, base: {}, lastState: {}, sig: null, refs: {}, playing: false, speed: 1, timer: null, poll: null};

    el.innerHTML = '<div class="sw">'
      + '<div class="sx-card sw-hero" id="swHero"></div>'
      + '<div class="sw-cols"><div class="sw-main"><div id="swList"></div></div>'
      + '<aside class="sw-side">'
      + '<div class="sx-card"><h3 class="sx-h">Sweat any play</h3><p class="sx-sub">Add any play on today\'s Onyx board to the sweat without betting it.</p>'
      + '<input class="sx-in" id="swQ" type="search" placeholder="Player, team or market (Kelce, DAL, rushing)" autocomplete="off"><div id="swRes" class="sw-res"></div></div>'
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
          if (!p.legs.some(function (l) { return (l.sport || 'nfl') === 'nfl'; })) return;
          T.push({id: 'p:' + p.id, title: p.label || p.legs.length + '-leg parlay', src: 'Saved parlay', legs: p.legs.map(function (l, i) { return norm(D, l, i); }), price: p.my_price != null ? p.my_price : p.price});
        } else if (p.sport === 'nfl') T.push({id: 's:' + p.id, title: 'My pick', src: 'Saved pick', legs: [norm(D, p, 0)], price: p.my_price != null ? p.my_price : p.price});
      });
      var slip = window.OnyxParlay ? OnyxParlay.slip() : [];
      if (slip.some(function (l) { return (l.sport || 'nfl') === 'nfl'; })) T.push({id: 'slip', title: slip.length > 1 ? 'Your slip · ' + slip.length + ' legs' : 'Your slip', src: 'On your slip, not placed', legs: slip.map(function (l, i) { return norm(D, l, i); }), slip: true});
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
        first: function (L) { return firstTd(LV.sum[L.gid]); }
      };
    }
    function statOf(j, L) {
      if (!j) return null;
      var v = {}, seen = false;
      ((j.boxscore || {}).players || []).forEach(function (t) { (t.statistics || []).forEach(function (b) { (b.athletes || []).forEach(function (a) {
        if (u.nk((a.athlete || {}).displayName) !== u.nk(L.name)) return;
        seen = true;
        var lab = b.labels || b.keys || [], at = function (l) { var i = lab.indexOf(l); return i < 0 ? null : (a.stats || [])[i]; };
        var n = function (l) { var x = parseFloat(at(l)); return isNaN(x) ? 0 : x; };
        if (b.name === 'receiving') { v.rec = n('REC'); v.rec_yds = n('YDS'); v.rec_td = n('TD'); }
        if (b.name === 'rushing') { v.rush_yds = n('YDS'); v.rush_td = n('TD'); }
        if (b.name === 'passing') { v.pass_yds = n('YDS'); v.pass_td = n('TD'); var ca = String(at('C/ATT') || '').split('/'); v.pass_att = parseFloat(ca[1]) || 0; }
      }); }); });
      return pick(v, L.mkt, seen);
    }
    function pick(v, mkt, seen) {
      var g = function (k) { return v[k] || 0; };
      if (!seen) return 0;   // not in the box score yet: nothing so far
      if (TDK[mkt]) return g('rush_td') + g('rec_td');
      if (mkt === 'rush_rec_yds') return g('rush_yds') + g('rec_yds');
      if (mkt === 'pass_rush_yds') return g('pass_yds') + g('rush_yds');
      return g(mkt);
    }
    function firstTd(j) {
      var sp = (j || {}).scoringPlays || [], td = sp.filter(function (s) { return /touchdown/i.test(((s.type || {}).text) || '') || /\bTD\b|touchdown/i.test(s.text || ''); })[0];
      if (!td) return null;
      var m = /^([A-Z][\w.'\- ]+?) \d+ (Yd|Yard)/.exec(td.text || '') || /^([A-Z][\w.'\- ]+?) (pass|run|rush)/i.exec(td.text || '');
      return m ? m[1].trim() : (td.text || '').split(' ').slice(0, 2).join(' ');
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
      if (gids.length) jobs.push(fetch(ESPN + 'scoreboard').then(function (r) { if (!r.ok) throw new Error('ESPN ' + r.status); return r.json(); }).then(function (j) {
        (j.events || []).forEach(function (e) {
          var c = (e.competitions || [{}])[0], st = (e.status || c.status || {}), ty = st.type || {}, H = {};
          (c.competitors || []).forEach(function (x) { H[x.homeAway] = x; });
          var ab = function (x) { return ((x || {}).team || {}).abbreviation; }, sc = function (x) { return parseFloat((x || {}).score) || 0; };
          var per = st.period || 0, clk = parseClock(st.displayClock);
          S.live.sb[e.id] = {state: ty.state, period: per, clock: clk, detail: ty.shortDetail, away: ab(H.away), home: ab(H.home), as: sc(H.away), hs: sc(H.home),
            f: ty.state === 'post' ? 0 : ty.state === 'pre' ? 1 : (window.OnyxLive ? OnyxLive.left('nfl', per, clk) : Math.max(0, (4 - per) * 900 + clk) / GAME), start: e.date};
        });
        S.live.err = null; S.live.at = Date.now();
        return Promise.all(Object.keys(props).filter(function (g) { var s = S.live.sb[g]; return s && s.state !== 'pre' && !(s.state === 'post' && S.live.sum[g] && S.live.sum[g]._post); }).map(function (g) {
          return fetch(ESPN + 'summary?event=' + g).then(function (r) { return r.json(); }).then(function (js) { js._post = S.live.sb[g].state === 'post'; S.live.sum[g] = js; }).catch(function () {});
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
          + '<p class="sx-sub">Save NFL picks or a parlay (the star on any play), build a slip, or sweat any play from the box. They show up here, live, once games kick off.</p>'
          + '<button class="sx-btn" data-act="demo">Watch a demo replay</button> <a class="sx-btn ghost" href="nfl.html">Find plays on Onyx NFL</a></div>';
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
        R.delta.innerHTML = E.state === 'pre' ? 'Pregame chance, from the model' : 'Kickoff ' + u.pct(E.pre, 1) + ' · <b class="' + (dd >= 0 ? 'sx-pos' : 'sx-neg') + '">' + (dd >= 0 ? '+' : '') + dd + ' pts</b>';
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
          + '<input type="range" class="sw-scrub" min="0" max="' + GAME + '" step="15" value="' + Math.round(dm.t) + '" aria-label="Game time">'
          + '<div class="sw-ctl"><button class="sx-btn" data-act="play">' + (S.playing ? 'Pause' : dm.t >= GAME ? 'Replay' : 'Play') + '</button>'
          + '<button class="sx-btn ghost' + (S.speed === 1 ? ' on' : '') + '" data-act="sp1">1x</button><button class="sx-btn ghost' + (S.speed === 4 ? ' on' : '') + '" data-act="sp4">4x</button>'
          + '<button class="sx-btn ghost" data-act="end">Skip to final</button><button class="sx-btn ghost" data-act="exit">Exit demo</button></div>'
          + '<p class="sw-fine">' + u.esc(dm.note) + '</p>';
        if (hero.dataset.mode !== 'demo') { hero.innerHTML = html; hero.dataset.mode = 'demo'; }
        else {
          hero.querySelector('.sw-sb').outerHTML = '<div class="sw-sb"><div class="sw-tm"><span>' + u.esc(G.away) + '</span><b>' + G.as + '</b></div><div class="sw-clock">' + u.esc(clockLabel(G)) + '</div><div class="sw-tm r"><b>' + G.hs + '</b><span>' + u.esc(G.home) + '</span></div></div>';
          var sc = hero.querySelector('.sw-scrub'); if (document.activeElement !== sc) sc.value = Math.round(dm.t);
          var pb = hero.querySelector('[data-act="play"]'); pb.textContent = S.playing ? 'Pause' : dm.t >= GAME ? 'Replay' : 'Play';
          hero.querySelector('[data-act="sp1"]').classList.toggle('on', S.speed === 1); hero.querySelector('[data-act="sp4"]').classList.toggle('on', S.speed === 4);
        }
        return;
      }
      hero.dataset.mode = 'live';
      var live = {}, ended = 0;
      Object.keys(S.live.sb).forEach(function (g) { if (S.live.sb[g].state === 'in') live[g] = S.live.sb[g]; });
      var mine = T.some(function (t) { return t.legs.some(function (L) { return live[L.gid]; }); });
      var nk = nextKick(), nlive = Object.keys(live).length;
      var head = nlive ? '<div class="sw-hk"><span class="sw-dot"></span>Live · ' + nlive + ' NFL game' + (nlive > 1 ? 's' : '') + ' in progress</div><div class="sw-hb t">' + (mine ? 'Your sweat is live' : 'Games are live') + '</div>'
        : nk ? '<div class="sw-hk">Next kickoff · ' + u.esc(nk.away + ' @ ' + nk.home) + ' · ' + u.esc(u.fmtTime(nk.start)) + '</div><div class="sw-hb" id="swCd">' + fmtLeft(Date.parse(nk.start) - Date.now()) + '</div>'
        : '<div class="sw-hk">No NFL game on the board right now</div><div class="sw-hb t">The next slate posts with the board</div>';
      var n = T.length, legs = T.reduce(function (m, t) { return m + t.legs.length; }, 0);
      hero.innerHTML = '<div class="sw-hrow"><div>' + head
        + '<p class="sw-fine">' + (n ? 'Sweating ' + n + ' ticket' + (n > 1 ? 's' : '') + ', ' + legs + ' leg' + (legs > 1 ? 's' : '') + '. ' : '') + (nlive ? 'Live chances update about every 35 seconds and pause while this tab is hidden.' : (n ? 'Your list is ready. ' : 'Nothing on your list yet. ') + 'Watch a finished game replayed to see exactly what Sunday feels like.') + '</p>'
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
      var ok = function (r) { return r.sel && !have[r.sel] && !r.no_read && r.conf != null && r.edge != null && r.edge > 0 && r.price != null && r.price > -250 && r.price < 300 && !/^(first|two|three)_td$/.test(r.mkt); };
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
        p.sport = 'nfl'; a.push(p); toast('info', 'Added to your sweat', r.label + ' · not bet');
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
      if (!DEMO_P) DEMO_P = Promise.all([D.history(), getJSON('data/nfl/prop_archive.json').catch(function () { return {}; }), getJSON('data/nfl/results.json').catch(function () { return {games: []}; })])
        .then(function (a) { return buildDemo(a[0], a[1], a[2], u); });
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
        if (S.demo.t >= GAME) { S.demo.t = 0; S.prevRes = {}; S.base = {}; S.lastState = {}; update(false, true); }
        S.timer = setInterval(function () {
          if (document.hidden) return;
          var dm = S.demo; if (!dm || !dm.on) { clearInterval(S.timer); return; }
          dm.t = Math.min(GAME, dm.t + 12 * S.speed);
          if (dm.t >= GAME) { S.playing = false; clearInterval(S.timer); update(false); finalCheck(dm); return; }
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
      else if (a === 'end') { S.demo.t = GAME; play(false); update(false); finalCheck(S.demo); }
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

  // ── the demo: a finished game, rebuilt from the box score with a scripted clock ──
  function finalStat(r, mkt) {
    var g = function (k) { return r[k] || 0; };
    if (TDK[mkt]) return g('rush_td') + g('rec_td');
    if (mkt === 'rush_rec_yds') return g('rush_yds') + g('rec_yds');
    if (mkt === 'pass_rush_yds') return g('pass_yds') + g('rush_yds');
    if (mkt === 'pass_att') return g('att');
    return g(mkt);
  }
  function split(total, n, R) {   // total into n integer parts that sum exactly
    if (n <= 0) return [];
    var w = [], s = 0, i; for (i = 0; i < n; i++) { w.push(0.35 + R() * 1.3); s += w[i]; }
    var out = [], acc = 0; for (i = 0; i < n; i++) { var v = i === n - 1 ? total - acc : Math.round(total * w[i] / s); out.push(v); acc += v; }
    return out;
  }
  function times(n, R, lo, hi) { var a = []; for (var i = 0; i < n; i++) a.push(Math.round(lo + R() * (hi - lo))); return a.sort(function (x, y) { return x - y; }); }
  function buildDemo(rows, arch, res, u) {
    var byG = {}; (rows || []).forEach(function (r) { (byG[r.gid] = byG[r.gid] || []).push(r); });
    var finals = (res.games || []).filter(function (g) { return arch[g.id] && byG[g.id] && g.hs != null && g.as != null; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    for (var gi = 0; gi < finals.length; gi++) { var dm = demoFor(finals[gi], arch[finals[gi].id], byG[finals[gi].id], u); if (dm) return dm; }
    return null;
  }
  function demoFor(G0, A, box, u) {
    var R = rng(hash(G0.id)), byN = {};
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
      cand.push({lid: 'd:' + k, sport: 'nfl', label: lab, gid: G0.id, matchup: A.m, kind: 'prop', mkt: mkt, side: side, line: v.l, name: nm, team: r.team, price: price, conf: conf, conf0: conf, confSrc: 'model', proj: proj, lam: lam, away: G0.away, home: G0.home, start: A.start, _fin: fin, _hit: side === 'over' ? fin > v.l : fin < v.l});
    });
    var props = cand.filter(function (c) { return !TDK[c.mkt]; }).sort(function (a, b) { return b.conf - a.conf; });
    var tds = cand.filter(function (c) { return TDK[c.mkt]; }).sort(function (a, b) { return b.lam - a.lam; });
    if (props.length < 4) return null;
    var used = {}, A4 = [];
    props.forEach(function (c) { if (A4.length < 3 && !used[c.name]) { used[c.name] = 1; A4.push(c); } });
    var tot = A.tot, pm = A.sp && A.sp[G0.home] != null ? -A.sp[G0.home] : 0;
    var total = tot != null ? {lid: 'd:total', sport: 'nfl', label: 'Over ' + tot + ' total', gid: G0.id, matchup: A.m, kind: 'total', mkt: 'total', side: 'over', line: tot, name: 'Total', price: null, away: G0.away, home: G0.home, start: A.start, pre_margin: pm, pre_total: tot, confSrc: 'Onyx implied'} : null;
    if (total) { total.conf0 = window.OnyxLive ? OnyxLive.model('nfl', {f: 1, pre_margin: pm, pre_total: tot, hs: 0, as: 0}).over(tot) : 0.5; total.confSrc = 'line'; }
    if (total) A4.push(total);
    var hits = props.filter(function (c) { return c._hit && A4.indexOf(c) < 0; }), B2 = [];
    hits.forEach(function (c) { if (B2.length < 2 && !B2.some(function (x) { return x.name === c.name; })) B2.push(c); });
    if (B2.length < 2) props.filter(function (c) { return c._hit; }).forEach(function (c) { if (B2.length < 2 && B2.indexOf(c) < 0) B2.push(c); });
    var T = [], price = function (L) { return L.every(function (l) { return l.price != null; }) ? u.amer(L.reduce(function (m, l) { return m * u.dec(l.price); }, 1)) : null; };
    var clone = function (L, tag) { return L.map(function (l) { return Object.assign({}, l, {lid: l.lid + tag}); }); };
    T.push({id: 'demoA', title: A4.length + '-leg parlay', src: 'Demo ticket', legs: clone(A4, ':a'), price: price(A4)});
    if (B2.length === 2) T.push({id: 'demoB', title: '2-leg parlay', src: 'Demo ticket', legs: clone(B2, ':b'), price: price(B2)});
    if (tds[0]) T.push({id: 'demoC', title: 'Single', src: 'Demo pick', legs: clone([tds[0]], ':c'), price: tds[0].price});

    // the scripted game: every box line spread over the clock, its touchdowns and the final score exactly
    var ev = [], sc = [];
    box.forEach(function (r) {
      var k = u.nk(r.name), tm = r.team;
      var addSeries = function (n, yds, mk, mkY, tdN, tdKey) {
        var cnt = n || (yds ? 1 : 0); if (!cnt) return;
        var tt = times(cnt, R, 40, GAME - 40), ys = split(yds || 0, cnt, R), E = [];
        for (var i = 0; i < cnt; i++) { var d = {}; if (n) d[mk] = 1; if (mkY) d[mkY] = ys[i]; E.push({t: tt[i], k: k, d: d}); }
        var idx = E.map(function (_, i) { return i; }).sort(function () { return R() - 0.5; }).slice(0, Math.min(tdN || 0, cnt));
        idx.forEach(function (i) { E[i].d[tdKey] = 1; if (tdKey !== 'pass_td') sc.push({t: E[i].t, team: tm, td: 1, who: r.name}); });
        ev.push.apply(ev, E);
      };
      addSeries(r.rec, r.rec_yds, 'rec', 'rec_yds', r.rec_td, 'rec_td');
      addSeries(r.rush_att, r.rush_yds, null, 'rush_yds', r.rush_td, 'rush_td');
      if (r.att || r.pass_yds) {
        var na = r.att || 1, nc = Math.min(na, r.cmp || (r.pass_yds ? 1 : 0)), ta = times(na, R, 40, GAME - 40);
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
      times(fgs, R, 120, GAME - 60).forEach(function (t) { sc.push({t: t, team: team, pts: 3, what: 'FG'}); });
      if (rest) sc.push({t: Math.round(GAME * (0.3 + R() * 0.6)), team: team, pts: rest, what: 'points'});
    });
    sc.sort(function (a, b) { return a.t - b.t; }); ev.sort(function (a, b) { return a.t - b.t; });
    var firstTd = sc.filter(function (s) { return s.td; })[0];
    function frame(t) {
      var G = {state: t <= 0 ? 'pre' : t >= GAME ? 'post' : 'in', away: G0.away, home: G0.home, as: 0, hs: 0, start: A.start};
      var p = Math.min(4, Math.floor(Math.min(t, GAME - 1) / 900) + 1);
      G.period = p; G.clock = t >= GAME ? 0 : 900 - (t - (p - 1) * 900); G.f = Math.max(0, (GAME - t) / GAME);
      sc.forEach(function (s) { if (s.t <= t) { if (s.team === G0.home) G.hs += s.pts; else G.as += s.pts; } });
      var st = {}; ev.forEach(function (e) { if (e.t > t) return; var o = st[e.k] = st[e.k] || {}; for (var q in e.d) o[q] = (o[q] || 0) + e.d[q]; });
      return {g: G, game: function () { return G; },
        stat: function (L) { var o = st[u.nk(L.name)] || {}; var g = function (k) { return o[k] || 0; };
          if (TDK[L.mkt]) return g('rush_td') + g('rec_td'); if (L.mkt === 'rush_rec_yds') return g('rush_yds') + g('rec_yds'); if (L.mkt === 'pass_rush_yds') return g('pass_yds') + g('rush_yds'); return g(L.mkt); },
        first: function () { return firstTd && firstTd.t <= t ? firstTd.who : null; }};
    }
    var SPK = {};
    var dm = {gid: G0.id, title: A.m + ' · ' + G0.date + ' final', tickets: T, frame: frame, t: 0, on: false, box: box, final: G0,
      note: 'A finished game replayed from this site\'s own files: the real Onyx pregame lines and the model\'s projections that night, and the final box score. The order of plays and the clock are scripted; every final stat and the final score are the real ones. Demo tickets, not bets.',
      sparkTo: function (tk, t) {
        var s = SPK[tk.id]; if (!s) { s = SPK[tk.id] = []; for (var x = 0; x <= GAME; x += 30) s.push([x, evalTicket(tk, frame(x), u).chance]); }
        var out = s.filter(function (p) { return p[0] <= t; }); out.push([t, evalTicket(tk, frame(t), u).chance]); return out;
      }};
    return dm;
  }
  // the self-check: replay start to finish; every leg must resolve, never flip, and land where the box score says
  function selfTest(dm, u) {
    var prev = {}, bad = '';
    for (var t = 0; t <= GAME && !bad; t += 10) {
      var fr = dm.frame(t);
      dm.tickets.forEach(function (tk) {
        var E = evalTicket(tk, fr, u);
        if (isNaN(E.chance) || E.chance < 0 || E.chance > 1) bad = tk.id + ' chance out of range at ' + t + 's';
        E.legs.forEach(function (e, i) { var k = tk.id + i; if (prev[k] && prev[k] !== e.res) bad = tk.legs[i].label + ' flipped from ' + prev[k] + ' to ' + e.res; if (e.res) prev[k] = e.res; });
      });
    }
    if (bad) return bad;
    var fr2 = dm.frame(GAME), G = fr2.g;
    if (G.as !== Math.round(dm.final.as) || G.hs !== Math.round(dm.final.hs)) return 'final score ' + G.as + '-' + G.hs + ' is not the real ' + dm.final.as + '-' + dm.final.hs;
    var byN = {}; dm.box.forEach(function (r) { byN[u.nk(r.name)] = r; });
    for (var i = 0; i < dm.tickets.length; i++) {
      var tk = dm.tickets[i], E = evalTicket(tk, fr2, u);
      for (var j = 0; j < tk.legs.length; j++) {
        var L = tk.legs[j], e = E.legs[j], want;
        if (L.kind === 'prop') {
          var fin = finalStat(byN[u.nk(L.name)] || {}, L.mkt);
          if (fr2.stat(L) !== fin) return L.label + ': replay ended at ' + fr2.stat(L) + ', the box score says ' + fin;
          want = L.side === 'under' ? (fin < L.line ? 'hit' : 'miss') : (fin > L.line ? 'hit' : 'miss');
        } else { var tt = dm.final.as + dm.final.hs; want = tt === L.line ? 'push' : (L.side === 'under' ? tt < L.line : tt > L.line) ? 'hit' : 'miss'; }
        if (e.res !== want) return L.label + ' resolved ' + e.res + ', the box score says ' + want;
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

  Studio.register('sweat', {title: 'Sunday Sweat', order: 4, mount: mount});
})();
