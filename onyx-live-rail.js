// onyx-live-rail.js - Live everywhere (11/16, Jordan: "make this as interactive as possible the entire site").
// Loaded on every page by ui.js (the way it loads accounts.js). Three things, all from data the site already reads:
//
//   1. The live rail: a slim strip under the header with every game in play for the sports this page cares about
//      (the sport page's own sport; every sport on the hub, Onyx Picks, the Studio's other pages and the rest). Each
//      game shows its score and the period or clock; a score change rolls the number in and flashes the game. A tap
//      opens that game's gamecenter (<sport>.html#games:<ESPN id>; on the sport's own page live.js opens it in place).
//   2. Your bets, pinned: saved picks and saved parlay tickets (OnyxSaved) with a leg in a live game lead the rail.
//      Each leg shows its progress (3 of 5.5), a live chance it hits and a status color. A tap opens the Studio's
//      Live Sweat for that sport (studio.html?sport=<k>#sweat). The chance is a projection: the stat so far plus
//      the pregame chance played out over the time left (live.js's fitted prop spread when live.js is on the page),
//      game lines a normal draw from the score, the time left and the pregame chance.
//   3. Swing alerts: a gentle toast (window.OX_TOAST) when a saved leg hits, dies, or its game goes final. Each fires
//      once per device (onyxRailSeen), only for games this device watched while they were in play.
//
// One ESPN poll, not two: saved.js (every 45 s), live.js (every 30 s) and this rail all read the same ESPN
// scoreboards. OnyxESPN below is one in-memory cache in front of fetch() for site.api.espn.com GETs: a request for a
// URL that was fetched in the last 20 s (8 s for tennis) is answered from memory, and a request already in flight is
// shared. Bets are followed through OnyxSaved.track, so saved.js's own rules (and its caches) decide hit or dead.
//
// Polling: every 30 s while anything is live, 60 s when a game with a saved bet starts soon, 3 minutes otherwise,
// and never while the tab is hidden. When nothing is live the rail is removed from the layout entirely.
(function () {
  'use strict';
  if (window.OnyxRail) return;
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';

  // ── 1. the shared ESPN cache ─────────────────────────────────────────────
  var MEM = {}, FLY = {}, nativeFetch = window.fetch;
  function isEspn(u) { return typeof u === 'string' && u.indexOf(ESPN) === 0; }
  function keyOf(u) { return u.replace(/([?&])v=\d+(&|$)/, function (m, a, b) { return b ? a : ''; }).replace(/[?&]$/, ''); }
  function ttlOf(k) { return /\/tennis\//.test(k) ? 8e3 : 20e3; }
  function grab(u) {
    var k = keyOf(u), c = MEM[k];
    if (c && Date.now() - c.t < ttlOf(k)) return Promise.resolve(c);
    if (FLY[k]) return FLY[k];
    var p = nativeFetch.call(window, u).then(function (r) {
      return r.text().then(function (body) {
        var rec = {t: Date.now(), body: body, status: r.status, statusText: r.statusText, ct: r.headers.get('content-type') || 'application/json'};
        if (r.ok) MEM[k] = rec;
        return rec;
      });
    });
    FLY[k] = p;
    var done = function () { delete FLY[k]; };
    p.then(done, done);
    return p;
  }
  function asResponse(rec) { return new Response(rec.body, {status: rec.status, statusText: rec.statusText, headers: {'content-type': rec.ct}}); }
  if (typeof nativeFetch === 'function' && typeof Response === 'function') {
    window.fetch = function (input, init) {
      try {
        var u = typeof input === 'string' ? input : input instanceof URL ? String(input) : null;
        var m = String((init && init.method) || 'GET').toUpperCase();
        if (isEspn(u) && m === 'GET' && !(init && init.signal)) return grab(u).then(asResponse);
      } catch (e) {}
      return nativeFetch.apply(this, arguments);
    };
  }
  setInterval(function () { var now = Date.now(); Object.keys(MEM).forEach(function (k) { if (now - MEM[k].t > 10 * 60e3) delete MEM[k]; }); }, 5 * 60e3);
  function json(u) { return grab(u).then(function (rec) { if (rec.status < 200 || rec.status >= 300) throw new Error(u); return JSON.parse(rec.body); }); }
  window.OnyxESPN = {json: json, peek: function (u) { var c = MEM[keyOf(u)]; return c ? c.t : 0; }};

  // ── 2. which sports this page cares about ────────────────────────────────
  // the scoreboards, the same URLs saved.js reads, so the cache is shared
  var SB = {nfl: 'football/nfl/scoreboard', nba: 'basketball/nba/scoreboard', nhl: 'hockey/nhl/scoreboard',
    cfb: 'football/college-football/scoreboard?groups=80&limit=300', cbb: 'basketball/mens-college-basketball/scoreboard?groups=50&limit=400',
    mlb: 'baseball/mlb/scoreboard'};
  var TN = ['tennis/atp/scoreboard', 'tennis/wta/scoreboard'];
  var NAME = {nfl: 'NFL', nba: 'NBA', nhl: 'NHL', cfb: 'NCAAF', cbb: 'NCAAB', tennis: 'Tennis', mlb: 'MLB', golf: 'Golf'};
  var PAGEOF = {nfl: 'nfl.html', nba: 'nba.html', nhl: 'nhl.html', cfb: 'cfb.html', cbb: 'cbb.html', tennis: 'tennis.html', mlb: './', golf: 'golf.html'};
  var STUDIO = {nfl: 1, nba: 1, cfb: 1, cbb: 1, nhl: 1, tennis: 1};
  var FILE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var BYFILE = {'nfl.html': 'nfl', 'nba.html': 'nba', 'nhl.html': 'nhl', 'cfb.html': 'cfb', 'cbb.html': 'cbb', 'cbb-players.html': 'cbb',
    'tennis.html': 'tennis', 'golf.html': 'golf', 'index.html': 'mlb', 'mlb-2026.html': 'mlb'};
  function mlbSeason() { var m = new Date().getMonth(); return m >= 2 && m <= 9; }   // late March to the World Series
  function pageSports() {
    var one = window.OX_SITE && NAME[window.OX_SITE] ? window.OX_SITE : BYFILE[FILE];
    if (FILE === 'studio.html') { var q = /[?&]sport=([a-z]+)/.exec(location.search); one = q && NAME[q[1]] ? q[1] : 'nfl'; }
    if (one) return one === 'golf' ? [] : [one];
    return ['nfl', 'nba', 'nhl', 'cfb', 'cbb', 'tennis'].concat(mlbSeason() ? ['mlb'] : []);
  }
  var SPORTS = pageSports(), MULTI = SPORTS.length > 1;

  // ── 3. ESPN -> games ─────────────────────────────────────────────────────
  function num(x) { var v = parseFloat(x); return isNaN(v) ? null : v; }
  function teamGame(k, e) {
    var c = (e.competitions || [{}])[0] || {}, st = c.status || e.status || {}, ty = st.type || {}, T = {};
    (c.competitors || []).forEach(function (x) { T[x.homeAway] = x; });
    if (!T.home || !T.away) return null;
    var side = function (x) { var t = x.team || {}; return {ab: t.abbreviation || t.shortDisplayName || '', sc: num(x.score)}; };
    return {k: k, id: String(e.id), state: ty.state, detail: ty.shortDetail || ty.detail || '', period: st.period || 0, clock: st.clock || 0,
            a: side(T.away), h: side(T.home), start: e.date || c.date || null};
  }
  function last(n) { n = String(n || '').trim().split(/\s+/); return n[n.length - 1] || ''; }
  function tennisGames(j) {
    var out = [];
    (j.events || []).forEach(function (e) {
      (e.groupings || []).forEach(function (g) {
        if (!/singles/i.test((g.grouping || {}).displayName || '')) return;
        (g.competitions || []).forEach(function (c) {
          var cs = c.competitors || [], ty = (c.status || {}).type || {};
          if (cs.length !== 2) return;
          var A = cs[0], H = cs[1];
          cs.forEach(function (x) { if (x.homeAway === 'home') H = x; else if (x.homeAway === 'away') A = x; });
          var sets = function (x) { return (x.linescores || []).map(function (l) { return num(l.value); }); };
          var sa = sets(A), sh = sets(H), won = function (m, o) { var w = 0; m.forEach(function (v, i) { if (v != null && o[i] != null && v > o[i] && (v >= 6 || ty.state === 'post')) w++; }); return w; };
          var ga = sa.length ? sa[sa.length - 1] : null, gh = sh.length ? sh[sh.length - 1] : null;
          out.push({k: 'tennis', id: String(c.id || e.id), state: ty.state, detail: ty.shortDetail || ty.detail || '', period: sa.length, clock: 0,
                    a: {ab: last((A.athlete || {}).displayName), full: (A.athlete || {}).displayName, sc: won(sa, sh), g: ga},
                    h: {ab: last((H.athlete || {}).displayName), full: (H.athlete || {}).displayName, sc: won(sh, sa), g: gh}, start: c.date || e.date || null});
        });
      });
    });
    return out;
  }
  function board(k) {
    if (k === 'tennis') return Promise.all(TN.map(function (p) { return json(ESPN + p).then(tennisGames).catch(function () { return []; }); }))
      .then(function (a) { return a[0].concat(a[1]); });
    if (!SB[k]) return Promise.resolve([]);
    return json(ESPN + SB[k]).then(function (j) { return (j.events || []).map(function (e) { return teamGame(k, e); }).filter(Boolean); }).catch(function () { return []; });
  }

  // ── 4. a saved leg's live chance (a projection) ──────────────────────────
  var LEN = {nfl: [4, 15], cfb: [4, 15], nba: [4, 12], nhl: [3, 20], cbb: [2, 20], mlb: [9, 0]};
  var SDM = {nfl: 16.5, cfb: 16, nba: 17, cbb: 15.4, nhl: 2.3, mlb: 4.2}, SDT = {nfl: 17.5, cfb: 17, nba: 21.6, cbb: 20.2, nhl: 2.3, mlb: 4.4};
  function leftOf(g) {
    if (!g || g.state !== 'in') return g && g.state === 'post' ? 0 : null;
    if (g.k === 'mlb') { var inn = Math.max(1, g.period || 1); return Math.max(0.02, Math.min(1, (9.5 - inn) / 9)); }
    if (window.OnyxLive && OnyxLive.left && OnyxLive.LEN && OnyxLive.LEN[g.k]) return OnyxLive.left(g.k, g.period, g.clock);
    var L = LEN[g.k]; if (!L || !g.period) return null;
    if (g.period > L[0]) return Math.max(0.004, (g.clock || 0) / 60 / (L[1] * L[0]));
    return Math.max(0.004, Math.min(1, ((L[0] - g.period) * L[1] * 60 + (g.clock || 0)) / (L[0] * L[1] * 60)));
  }
  function phi(z) { return window.OnyxLive && OnyxLive.phi ? OnyxLive.phi(z) : 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z))); }
  function inv(p) { p = Math.min(0.995, Math.max(0.005, p)); var lo = -4, hi = 4; for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
  function propP(mkt, cur, proj, f, line) {
    if (window.OnyxLive && OnyxLive.propP) return OnyxLive.propP(mkt, cur, proj, f, line);
    var rem = Math.max(0, proj * f), sd = /yds$/.test(mkt) ? (0.45 * proj + 12) * Math.sqrt(f) : Math.sqrt(Math.max(0.15, rem * 1.5));
    return 1 - phi((line - cur - rem) / Math.max(sd, 0.35));
  }
  function projFor(mkt, line, pOver) {
    var lo = 0, hi = Math.max(10, line * 4 + 10);
    for (var i = 0; i < 40; i++) { var m = (lo + hi) / 2; if (propP(mkt, 0, m, 1, line) < pOver) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function implied(a) { return a == null ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100); }
  function clamp(x) { return Math.max(0, Math.min(1, x)); }
  function chance(p, t, g) {
    if (t.res === 'W') return 1;
    if (t.res === 'L') return 0;
    if (t.res === 'P') return null;
    var f = leftOf(g), pre = p.conf != null ? +p.conf : implied(p.price);
    if (f == null || pre == null || isNaN(pre) || f <= 0) return null;
    var over = p.side !== 'under', cur = typeof t.cur === 'number' ? t.cur : num(t.cur);
    if (p.kind === 'prop') {
      if (cur == null || p.mkt === 'q1_total' || p.mkt === 'h1_total') return null;
      if (p.mkt === 'anytime_td') return cur >= 1 ? 1 : clamp(1 - Math.exp(Math.log(1 - Math.min(0.99, pre)) * f));
      if (p.line == null) return null;
      var pOv = cur > p.line ? 1 : propP(p.mkt, cur, projFor(p.mkt, p.line, over ? pre : 1 - pre), f, p.line);
      return clamp(over ? pOv : 1 - pOv);
    }
    if (p.kind === 'total' && cur != null && p.line != null && SDT[p.sport]) {
      var sd = SDT[p.sport], T = p.line + sd * inv(over ? pre : 1 - pre), po = phi((cur + T * f - p.line) / (sd * Math.sqrt(f)));
      return clamp(over ? po : 1 - po);
    }
    if ((p.kind === 'ml' || p.kind === 'spread') && SDM[p.sport] && /^-?\d+(\.\d+)?-\d+(\.\d+)?$/.test(String(t.cur || ''))) {
      var sc = String(t.cur).split(/(?!^)-/).map(Number), m = sc[0] - sc[1], h = p.kind === 'spread' ? (+p.hcap || 0) : 0, s = SDM[p.sport];
      var mu = s * inv(pre) - h;
      return clamp(phi((m + h + mu * f) / (s * Math.sqrt(f))));
    }
    return null;
  }

  // ── 5. a leg's line on the rail ──────────────────────────────────────────
  var MK = {pts: 'pts', reb: 'reb', ast: 'ast', threes: '3PM', rec: 'rec', rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds',
    pass_att: 'att', pass_td: 'pass TD', rush_rec_yds: 'rush+rec', pass_rush_yds: 'pass+rush', pra: 'PRA', pr: 'P+R', pa: 'P+A', ra: 'R+A'};
  function fmtN(x) { return x == null ? '' : Math.round(x * 10) / 10; }
  function short(p) {
    if (p.kind === 'prop' && p.name && MK[p.mkt] && p.line != null) return last(p.name) + ' ' + (p.side === 'under' ? 'u' : 'o') + p.line + ' ' + MK[p.mkt];
    if (p.kind === 'prop' && p.mkt === 'anytime_td' && p.name) return last(p.name) + ' TD';
    if (p.kind === 'total' && p.line != null) return (p.side === 'under' ? 'Under ' : 'Over ') + p.line;
    return p.label || p.name || 'Your pick';
  }
  function progress(p, t) {
    if (t.state === 'pre') return 'Not started';
    if (t.cur == null) return t.state === 'post' ? 'Final' : 'In play';
    if (p.kind === 'prop' && p.mkt === 'anytime_td') return t.cur + ' TD';
    if (p.kind === 'prop' || p.kind === 'total') return p.line != null ? fmtN(t.cur) + ' of ' + p.line : String(t.cur);
    var sc = String(t.cur).split(/(?!^)-/).map(Number);
    if (sc.length !== 2 || sc.some(isNaN)) return String(t.cur);
    var m = sc[0] - sc[1], h = p.kind === 'spread' ? (+p.hcap || 0) : 0;
    if (p.kind === 'spread') return m + h > 0 ? 'Covering by ' + fmtN(m + h) : m + h === 0 ? 'On the number' : 'Needs ' + (Math.floor(-(m + h)) + 1);
    return m > 0 ? 'Up ' + m : m < 0 ? 'Down ' + (-m) : 'Tied';
  }
  function barOf(p, t) {
    var c = typeof t.cur === 'number' ? t.cur : null;
    if (c == null || p.line == null || !(p.kind === 'prop' || p.kind === 'total') || p.line <= 0) return null;
    return clamp(c / (p.line + 0.5));
  }
  function toneOf(t, ch) {
    if (t.res === 'W') return 'hit';
    if (t.res === 'L') return 'dead';
    if (t.res === 'P' || t.state === 'pre') return 'pre';
    if (ch != null) return ch >= 0.6 ? 'good' : ch < 0.3 ? 'bad' : 'live';
    return t.res === 'up' ? 'good' : t.res === 'down' ? 'bad' : 'live';
  }
  var STATUS = {hit: 'Hit', dead: 'Dead', good: 'Ahead', bad: 'Behind', live: 'Live', pre: 'Later'};

  // ── 6. state, storage, alerts ───────────────────────────────────────────
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var SEEN = 'onyxRailSeen', SNAP = 'onyxRailSnap';
  var GAMES = [], BETS = [], LASTSC = {}, timer = null, busy = false, rail = null, booted = false;
  function toast(msg) { try { if (window.OX_TOAST) window.OX_TOAST(msg, {ms: 4200}); } catch (e) {} }
  function gk(k, id) { return k + ':' + id; }
  // a game seen in play (kept 6 hours): a leg's hit / dead / final alert needs its game watched while live
  function swings(followed, gmap) {
    var s = lsGet(SEEN, {}), now = Date.now(), out = [];
    s.live = s.live || {}; s.done = s.done || {};
    Object.keys(gmap).forEach(function (k) { if (gmap[k].state === 'in') s.live[k] = now; });
    followed.forEach(function (x) {
      var g = x.g, key = g ? gk(g.k, g.id) : null, watched = key && s.live[key] && now - s.live[key] < 6 * 3600e3;
      if (!watched) return;
      var id = x.id;
      if ((x.t.res === 'W' || x.t.res === 'L') && !s.done[id + '|' + x.t.res]) {
        s.done[id + '|' + x.t.res] = now;
        out.push((x.t.res === 'W' ? 'Leg hit: ' : 'Leg died: ') + short(x.p) + (x.t.cur != null && x.p.kind !== 'ml' && x.p.kind !== 'spread' ? ' (' + fmtN(x.t.cur) + ')' : '') + (x.ticket ? ' on your ' + x.ticket : ''));
      }
      if (g.state === 'post' && !s.done['f|' + key]) {
        s.done['f|' + key] = now;
        out.push('Final: ' + g.a.ab + ' ' + (g.a.sc == null ? '' : g.a.sc) + ', ' + g.h.ab + ' ' + (g.h.sc == null ? '' : g.h.sc) + '. Your bets are graded in My picks');
      }
    });
    Object.keys(s.live).forEach(function (k) { if (now - s.live[k] > 6 * 3600e3) delete s.live[k]; });
    Object.keys(s.done).forEach(function (k) { if (now - s.done[k] > 3 * 864e5) delete s.done[k]; });
    lsSet(SEEN, s);
    return out;
  }

  // ── 7. one refresh ───────────────────────────────────────────────────────
  function savedInPlay() {
    if (!window.OnyxSaved || !OnyxSaved.all || !OnyxSaved.track) return [];
    var now = Date.now();
    return OnyxSaved.all().filter(function (p) {
      var st = Date.parse(p.start);
      if (p.kind === 'parlay') return (p.legs || []).some(function (l) { var s = Date.parse(l.start); return isNaN(s) || (s - 10 * 60e3 <= now && now - s < 8 * 3600e3); });
      return isNaN(st) || (st - 10 * 60e3 <= now && now - st < 8 * 3600e3);
    }).slice(0, 20);
  }
  var polls = 0;
  function refresh() {
    if (busy) return Promise.resolve();
    busy = true; polls++;
    var picks = savedInPlay();
    var betSports = [];
    picks.forEach(function (p) { (p.kind === 'parlay' ? p.legs || [] : [p]).forEach(function (l) { if (l.sport && betSports.indexOf(l.sport) < 0) betSports.push(l.sport); }); });
    var need = SPORTS.concat(betSports.filter(function (k) { return SPORTS.indexOf(k) < 0 && (SB[k] || k === 'tennis'); }));
    return Promise.all(need.map(function (k) { return board(k).then(function (G) { return [k, G]; }); })).then(function (R) {
      var gmap = {}, byLeg = {};
      R.forEach(function (r) { r[1].forEach(function (g) { gmap[gk(g.k, g.id)] = g; }); });
      // saved.js picks the game and grades the leg (its rules, its cache); the scoreboards above are already in memory
      return Promise.all(picks.map(function (p) { return OnyxSaved.track(p).catch(function () { return {p: p, state: 'pre', res: null}; }); })).then(function (T) {
        var followed = [], bets = [];
        var findG = function (l, t) {
          if (t.gid) return gmap[gk(l.sport, t.gid)] || null;
          if (l.sport === 'tennis') return Object.keys(gmap).map(function (k) { return gmap[k]; }).filter(function (g) {
            return g.k === 'tennis' && [g.a.full, g.h.full].some(function (n) { return n && l.name && n.toLowerCase() === String(l.name).toLowerCase(); });
          })[0] || null;
          return l.gid ? gmap[gk(l.sport, l.gid)] || null : null;
        };
        T.forEach(function (t, i) {
          var p = picks[i];
          if (p.kind === 'parlay') {
            var legs = (t.legs || []).map(function (lt, j) {
              var l = p.legs[j], g = findG(l, lt), ch = chance(l, lt, g);
              var x = {id: p.id + '#' + j, p: l, t: lt, g: g, ch: ch, tone: toneOf(lt, ch), ticket: (p.legs || []).length + '-leg parlay'};
              followed.push(x); return x;
            });
            if (t.state !== 'in' && !legs.some(function (x) { return x.g && x.g.state === 'in'; })) return;
            var dead = legs.some(function (x) { return x.tone === 'dead'; });
            var all = legs.reduce(function (m, x) { var c = x.ch != null ? x.ch : x.t.res === 'P' ? 1 : x.p.conf != null ? x.p.conf : implied(x.p.price); return c == null || m == null ? null : m * c; }, 1);
            bets.push({ticket: true, id: p.id, sport: legs.map(function (x) { return x.p.sport; }).filter(function (k) { return STUDIO[k]; })[0] || 'nfl',
                       label: legs.length + '-leg parlay', hit: legs.filter(function (x) { return x.tone === 'hit'; }).length, n: legs.length,
                       ch: dead ? 0 : all, tone: dead ? 'dead' : all != null ? (all >= 0.6 ? 'good' : all < 0.15 ? 'bad' : 'live') : 'live', legs: legs});
          } else {
            var g = findG(p, t), ch = chance(p, t, g), x = {id: p.id, p: p, t: t, g: g, ch: ch, tone: toneOf(t, ch)};
            followed.push(x);
            if (t.state === 'in' || (g && g.state === 'in')) bets.push({ticket: false, id: p.id, sport: p.sport, legs: [x], tone: x.tone, ch: ch});
          }
        });
        var games = R.filter(function (r) { return SPORTS.indexOf(r[0]) >= 0; }).reduce(function (a, r) { return a.concat(r[1]); }, []).filter(function (g) { return g.state === 'in'; });
        // games with your bets first
        var mine = {};
        followed.forEach(function (x) { if (x.g) mine[gk(x.g.k, x.g.id)] = 1; });
        games.forEach(function (g) { g.mine = !!mine[gk(g.k, g.id)]; });
        games.sort(function (a, b) { return (b.mine - a.mine) || SPORTS.indexOf(a.k) - SPORTS.indexOf(b.k); });
        GAMES = games; BETS = bets;
        swings(followed, gmap).forEach(function (m, i) { setTimeout(function () { toast(m); }, i * 700); });
        draw();
        lsSet(SNAP, {t: Date.now(), s: SPORTS.join(','), games: GAMES.map(function (g) { return {k: g.k, id: g.id, state: g.state, detail: g.detail, a: g.a, h: g.h, mine: g.mine}; })});
        soon = picks.some(function (p) { var s = Date.parse(p.start); return !isNaN(s) && s > Date.now() && s - Date.now() < 20 * 60e3; });
      });
    }).catch(function () {}).then(function () { busy = false; });
  }
  var soon = false;

  // ── 8. drawing ───────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function pct(x) { return x == null ? '' : x >= 0.995 && x < 1 ? '99%' : x > 0 && x < 0.01 ? '1%' : Math.round(100 * x) + '%'; }
  function href(g) {
    if (g.k === 'mlb') return PAGEOF.mlb;
    return (PAGEOF[g.k] || 'home.html') + '#games:' + encodeURIComponent(g.id);
  }
  function scoreTxt(s, g) { return s.sc == null ? '0' : g.k === 'tennis' && s.g != null ? s.sc + '<small>' + s.g + '</small>' : String(s.sc); }
  function gameHTML(g) {
    return '<a class="olr-g' + (g.mine ? ' mine' : '') + '" data-k="' + esc(gk(g.k, g.id)) + '" href="' + esc(href(g)) + '" data-lv-open="' + esc(g.id) + '" data-lv-sport="' + esc(g.k) + '" data-lv-a="' + esc(g.a.full || g.a.ab) + '" data-lv-h="' + esc(g.h.full || g.h.ab) + '" aria-label="' + esc(g.a.ab + ' ' + (g.a.sc == null ? 0 : g.a.sc) + ', ' + g.h.ab + ' ' + (g.h.sc == null ? 0 : g.h.sc) + ', ' + g.detail + '. Open the gamecenter') + '">'
      + (MULTI ? '<span class="olr-tag">' + esc(NAME[g.k] || '') + '</span>' : '')
      + '<span class="olr-tm" data-side="a">' + esc(g.a.ab) + ' <b class="olr-s">' + scoreTxt(g.a, g) + '</b></span>'
      + '<span class="olr-tm" data-side="h">' + esc(g.h.ab) + ' <b class="olr-s">' + scoreTxt(g.h, g) + '</b></span>'
      + '<span class="olr-c">' + esc(g.detail || 'Live') + '</span></a>';
  }
  function legHTML(x, sport, inTicket) {
    var b = barOf(x.p, x.t);
    return '<span class="olr-leg t-' + x.tone + (inTicket ? ' in' : '') + '">'
      + '<span class="olr-ll">' + esc(short(x.p)) + '</span>'
      + '<span class="olr-lp">' + esc(progress(x.p, x.t)) + '</span>'
      + (b != null ? '<span class="olr-bar"><i style="width:' + Math.round(100 * b) + '%"></i></span>' : '')
      + '<b class="olr-lc" title="' + esc(STATUS[x.tone]) + '">' + (x.tone === 'hit' ? 'Hit' : x.tone === 'dead' ? 'Dead' : x.ch != null ? pct(x.ch) : esc(STATUS[x.tone])) + '</b></span>';
  }
  function betHTML(B) {
    var sp = STUDIO[B.sport] ? B.sport : 'nfl';
    var inner = B.ticket
      ? '<span class="olr-tk t-' + B.tone + '"><span class="olr-ll">' + esc(B.label) + '</span><span class="olr-lp">' + B.hit + ' of ' + B.n + ' hit</span><b class="olr-lc">' + (B.tone === 'dead' ? 'Dead' : B.ch != null ? pct(B.ch) : 'Live') + '</b></span>'
        + B.legs.map(function (x) { return legHTML(x, sp, true); }).join('')
      : legHTML(B.legs[0], sp, false);
    return '<a class="olr-bet" data-b="' + esc(B.id) + '" href="studio.html?sport=' + sp + '#sweat" aria-label="' + esc((B.ticket ? B.label : short(B.legs[0].p)) + ': follow it in the Live Sweat') + '">' + inner + '</a>';
  }
  function css() {
    if (document.getElementById('olr-css')) return;
    var s = document.createElement('style'); s.id = 'olr-css';
    s.textContent = [
      '.olr{display:block;height:44px;box-sizing:border-box;background:rgba(12,10,18,.94);border-bottom:1px solid rgba(176,56,249,.22);font-family:"Space Grotesk",system-ui,sans-serif;color:#fff;overflow:hidden;contain:layout paint;position:relative;z-index:1}',
      '.olr[hidden]{display:none!important}',
      '.olr-in{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;max-width:1240px;margin:0 auto;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}',
      '.olr-in::-webkit-scrollbar{display:none}',
      '.olr-lab{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;font:700 9.5px/1 monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff}',
      '.olr-lab i{width:7px;height:7px;border-radius:50%;background:#ff5c8a;box-shadow:0 0 8px #ff5c8a;animation:olrDot 1.6s ease-in-out infinite}',
      '.olr-lab.b i{background:#b038f9;box-shadow:0 0 8px #b038f9}',
      '.olr-sep{flex-shrink:0;width:1px;height:22px;background:rgba(255,255,255,.12)}',
      '.olr-g,.olr-bet{flex-shrink:0;display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 11px;border-radius:999px;text-decoration:none;color:#fff;box-sizing:border-box;',
      'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);font:600 12px/1 "Space Grotesk",system-ui,sans-serif;white-space:nowrap;-webkit-tap-highlight-color:transparent;transition:background .2s,border-color .2s}',
      '.olr-g:hover,.olr-bet:hover{border-color:rgba(176,56,249,.6)}.olr-g:active,.olr-bet:active{transform:scale(.97)}',
      '.olr-g.mine{border-color:rgba(176,56,249,.55)}',
      '.olr-tag{font:700 9px/1 monospace;letter-spacing:.08em;color:#a99fba}',
      '.olr-tm{display:inline-flex;align-items:center;gap:4px;color:#d9d3e3}',
      '.olr-s{display:inline-block;min-width:1ch;font:800 13px/1 monospace;color:#fff;font-variant-numeric:tabular-nums}',
      '.olr-s small{font:600 10px monospace;color:#a99fba;margin-left:3px}',
      '.olr-s.up{animation:olrRoll .5s cubic-bezier(.2,1.3,.4,1);color:#61e970}',
      '.olr-c{font:700 10.5px/1 monospace;color:#ff8fb0}',
      '.olr-g.olr-flash{animation:olrFlash 1.6s ease-out}',
      '.olr-bet{gap:6px;padding:0 4px 0 4px;background:rgba(176,56,249,.12);border-color:rgba(176,56,249,.45)}',
      '.olr-leg,.olr-tk{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:999px;background:rgba(0,0,0,.25);border:1px solid transparent}',
      '.olr-tk{background:rgba(176,56,249,.22)}',
      '.olr-ll{font-weight:700;color:#fff;max-width:150px;overflow:hidden;text-overflow:ellipsis}',
      '.olr-lp{font:600 10.5px/1 monospace;color:#cfc8da}',
      '.olr-bar{display:inline-block;width:34px;height:4px;border-radius:9px;background:rgba(255,255,255,.12);overflow:hidden}',
      '.olr-bar i{display:block;height:100%;background:#d795ff;border-radius:9px;transition:width .6s}',
      '.olr-lc{font:800 11px/1 monospace;color:#d795ff}',
      '.t-hit{border-color:rgba(97,233,112,.55)}.t-hit .olr-lc,.t-good .olr-lc{color:#61e970}.t-hit .olr-bar i,.t-good .olr-bar i{background:#61e970}',
      '.t-dead{border-color:rgba(255,138,138,.5);opacity:.85}.t-dead .olr-lc,.t-bad .olr-lc{color:#ff8a8a}.t-dead .olr-bar i,.t-bad .olr-bar i{background:#ff8a8a}',
      '.t-pre .olr-lc{color:#a99fba}',
      '@keyframes olrRoll{0%{transform:translateY(70%);opacity:0}100%{transform:none;opacity:1}}',
      '@keyframes olrFlash{0%{background:rgba(176,56,249,.55);box-shadow:0 0 0 2px #b038f9,0 0 18px rgba(176,56,249,.7)}100%{background:rgba(255,255,255,.05);box-shadow:none}}',
      '@keyframes olrDot{0%,100%{opacity:1}50%{opacity:.35}}',
      '@media (prefers-reduced-motion:reduce){.olr-s.up,.olr-g.olr-flash,.olr-lab i{animation:none!important}.olr-g.olr-flash{border-color:#b038f9}}'
    ].join('');
    document.head.appendChild(s);
  }
  // under the page's header: the sport and MLB pages' nav.nav, the hub's .ox-head, ui.js's standard header
  function host() {
    if (rail && rail.isConnected) return rail;
    css();
    rail = document.createElement('div');
    rail.id = 'onyxRail'; rail.className = 'olr'; rail.hidden = true;
    rail.setAttribute('role', 'region'); rail.setAttribute('aria-label', 'Live games and your bets');
    rail.innerHTML = '<div class="olr-in"></div>';
    var h = document.querySelector('body > nav.nav, body > header.ox-head') || document.querySelector('nav.nav, header.ox-head');
    if (h && h.parentNode) h.parentNode.insertBefore(rail, h.nextSibling);
    else document.body.insertBefore(rail, document.body.firstChild);
    return rail;
  }
  function draw() {
    var r = host(), box = r.firstChild, live = GAMES.length || BETS.length;
    if (!live) { if (!r.hidden) { r.hidden = true; box.innerHTML = ''; } r.setAttribute('data-state', 'off'); return; }
    r.setAttribute('data-state', 'on');
    // the bets: rebuilt each time (a few chips); the games: kept by key so a score change animates in place
    var bets = box.querySelector('.olr-bets');
    if (BETS.length) {
      if (!bets) { bets = document.createElement('span'); bets.className = 'olr-bets'; bets.style.cssText = 'display:inline-flex;align-items:center;gap:8px;flex-shrink:0'; box.insertBefore(bets, box.firstChild); }
      bets.innerHTML = '<span class="olr-lab b"><i></i>Your bets</span>' + BETS.map(betHTML).join('') + (GAMES.length ? '<span class="olr-sep"></span>' : '');
    } else if (bets) bets.remove();
    var lab = box.querySelector('.olr-lab.g');
    if (GAMES.length && !lab) { lab = document.createElement('span'); lab.className = 'olr-lab g'; lab.innerHTML = '<i></i>Live'; box.appendChild(lab); }
    else if (!GAMES.length && lab) lab.remove();
    var have = {};
    Array.prototype.forEach.call(box.querySelectorAll('.olr-g'), function (a) { have[a.getAttribute('data-k')] = a; });
    var keep = {};
    GAMES.forEach(function (g) {
      var k = gk(g.k, g.id), el = have[k], sc = (g.a.sc == null ? 0 : g.a.sc) + '-' + (g.h.sc == null ? 0 : g.h.sc), was = LASTSC[k];
      keep[k] = 1;
      var tmp = document.createElement('span'); tmp.innerHTML = gameHTML(g);
      var fresh = tmp.firstChild;
      if (el) el.replaceWith(fresh); else box.appendChild(fresh);
      if (was != null && was !== sc) {
        var o = was.split('-'), sides = {a: +o[0] !== (g.a.sc || 0), h: +o[1] !== (g.h.sc || 0)};
        Object.keys(sides).forEach(function (s) { if (sides[s]) { var b = fresh.querySelector('[data-side="' + s + '"] .olr-s'); if (b) b.classList.add('up'); } });
        fresh.classList.add('olr-flash');
        fresh.setAttribute('data-flashed', String(Date.now()));
        setTimeout(function () { fresh.classList.remove('olr-flash'); }, 1700);
      }
      LASTSC[k] = sc;
    });
    // keep the order (bets' games first), drop what ended
    GAMES.forEach(function (g) { var e = box.querySelector('.olr-g[data-k="' + gk(g.k, g.id).replace(/"/g, '') + '"]'); if (e) box.appendChild(e); });
    Object.keys(have).forEach(function (k) { if (!keep[k] && have[k].isConnected) have[k].remove(); });
    if (r.hidden) r.hidden = false;
  }

  // ── 9. the clock ─────────────────────────────────────────────────────────
  function next() {
    clearTimeout(timer);
    if (document.hidden) return;                  // back off: nothing polls while the tab is hidden
    var ms = GAMES.length || BETS.length ? 30e3 : soon ? 60e3 : 180e3;
    timer = setTimeout(function () { refresh().then(next, next); }, ms);
  }
  function now() { clearTimeout(timer); return refresh().then(next, next); }
  document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(timer); else { clearTimeout(timer); timer = setTimeout(now, 600); } });
  addEventListener('onyx-saved', function () { clearTimeout(timer); timer = setTimeout(now, 400); });

  function boot() {
    if (booted || !document.body) return;
    booted = true;
    // the last picture, when it is fresh (moving between pages mid-game): the rail is there at once, no pop-in
    var s = lsGet(SNAP, null);
    if (s && s.s === SPORTS.join(',') && Date.now() - s.t < 75e3 && (s.games || []).length) {
      GAMES = s.games.filter(function (g) { return g && g.state === 'in' && g.a && g.h; });
      GAMES.forEach(function (g) { LASTSC[gk(g.k, g.id)] = (g.a.sc == null ? 0 : g.a.sc) + '-' + (g.h.sc == null ? 0 : g.h.sc); });
      draw();
    }
    // saved.js comes in through ui.js too: wait a moment for it so the first pass sees the bets
    var tries = 0;
    (function go() { if (window.OnyxSaved || ++tries > 12) now(); else setTimeout(go, 150); })();
  }
  window.OnyxRail = {refresh: now, sports: function () { return SPORTS.slice(); }, games: function () { return GAMES; }, bets: function () { return BETS; },
    chance: chance, el: function () { return rail; }, polls: function () { return polls; }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
