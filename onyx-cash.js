// onyx-cash.js - live chance to cash for every saved pick and saved parlay, plus live leans (11/16, Jordan: "live win
// is huge I want that for all picks ... how is it trending to cash from your picks, and live recommendations").
// Loaded on every page by ui.js (next to onyx-live-rail.js). Every number here is a PROJECTION from the score, the clock
// and the pregame chance, never a guarantee, and a live lean is never an Onyx Pick.
//
// ── API (window.OnyxCash) ─────────────────────────────────────────────────────────────────────────────────────────
//   OnyxCash.chance(pick[, {track}]) -> Promise<{
//       id, state: 'pre'|'live'|'final', p: 0..1|null (chance it cashes), res: 'W'|'L'|'P'|null,
//       status: 'Trending to cash 78%' | 'Cashed' | 'Lost' | 'Push' | 'Pregame 56%' ...,
//       now: '18 pts, 5:00 - 3rd'   (where it stands),
//       need: 'Needs 10 more pts in 17 min' (what it takes; '' when settled),
//       trend: 'up'|'down'|'flat', pts: [{t, p}] (this session's history, kept in sessionStorage),
//       cur: the live stat (props), legs: [{id, label, p, res, state, status, now, need, cur}] and sweat: index of the
//       leg to watch (parlays only)}>
//     pick: a saved pick (OnyxSaved: {id, sport, kind: prop|spread|total|ml, mkt, side, line, hcap, name, team, gid,
//     start, conf, price}) or a saved parlay ticket ({kind: 'parlay', legs: [...]}). A parlay is its legs multiplied:
//     a lost leg makes it 0, a won (or pushed) leg counts as 1. {track} is an OnyxSaved.track() result already in
//     hand (the live rail passes its own so nothing is fetched twice).
//   OnyxCash.mount(el, pick[, {compact}]) -> {stop()}: draws the "chance to cash" meter (percentage, bar, plain-language
//     status, mini win-probability line: purple, green at 60%+, red at 25% or less) into el and keeps it updating
//     (every 30 s live, 15 s for tennis, 2 minutes before the start; paused while the tab is hidden; stops by itself
//     once el leaves the page or the pick is settled).
//   OnyxCash.leans([sport]) -> Promise<[{label, matchup, sport, kind, price, p, edge, sel, href, gid}]>: live leans,
//     the live model against Onyx's live line (live.js bets(), value sides only, best edge first, at most 8). sel is
//     the Onyx selection id when the live feed carries one (href is then the Onyx bet link), else href opens Onyx.
//   OnyxCash.history(id) -> [{t, p}], OnyxCash.text(r) -> one-line summary.
//   window event 'onyx-cash' {detail: {id, p, prev, res}} whenever a pick's chance moves a point or more, or it settles.
//   Hedge / lock profit (11/17): this file loads onyx-hedge.js (OnyxHedge) once the page is idle. Every chance() result
//   goes to OnyxHedge.seen (the live rail's "Lock $X" chip) and every meter to OnyxHedge.decorate (the "Hedge available:
//   lock $X" chip, or a "Hedge calculator" link on an open pick). The hedge math is arithmetic, never a promise.
//
// Models (all from live.js when it is on the page; this file loads it on demand when a saved pick is in play):
//   props: the stat so far plus the pregame projection (backed out of the saved chance) for the time left, with
//     live.js's fitted live prop spread (OnyxLive.propP). A cleared over is 1, a broken under is 0.
//   spreads, totals, moneylines: OnyxLive.model (football, basketball: normal draw over the time left; NHL: Poisson;
//     tennis: the point -> game -> set chain), its pregame number fitted so it starts at the saved chance.
//   MLB: a normal draw by innings left. Anything without a live stat keeps its saved chance until it settles.
(function () {
  'use strict';
  if (window.OnyxCash) return;
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/', REF = 'KR680261';
  // the scoreboards the live rail and saved.js read, so the OnyxESPN cache answers once for all three
  var SB = {nfl: 'football/nfl/scoreboard', nba: 'basketball/nba/scoreboard', nhl: 'hockey/nhl/scoreboard',
    cfb: 'football/college-football/scoreboard?groups=80&limit=300', cbb: 'basketball/mens-college-basketball/scoreboard?groups=50&limit=400',
    mlb: 'baseball/mlb/scoreboard'};
  var SUMP = {nfl: 'football/nfl', nba: 'basketball/nba', cfb: 'football/college-football', cbb: 'basketball/mens-college-basketball', nhl: 'hockey/nhl'};
  var LEN = {nfl: [4, 15], cfb: [4, 15], nba: [4, 12], nhl: [3, 20], cbb: [2, 20]};
  var SDF = {nfl: [16.5, 17.5], cfb: [16, 17], nba: [17, 21.6], cbb: [15.4, 20.2], nhl: [2.3, 2.3], mlb: [4.2, 4.4]};
  var DEFT = {nfl: 44, cfb: 54, nba: 228, nhl: 6, cbb: 145, mlb: 8.5};
  var UNIT = {pts: 'pts', reb: 'reb', ast: 'ast', threes: 'threes', rec: 'catches', rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds',
    pra: 'PRA', pr: 'pts + reb', pa: 'pts + ast', ra: 'reb + ast', anytime_td: 'TD', pass_att: 'attempts', pass_td: 'pass TD'};

  // ── small helpers ────────────────────────────────────────────────────────
  function num(x) { var v = parseFloat(x); return isNaN(v) ? null : v; }
  function clamp(x) { return Math.max(0, Math.min(1, x)); }
  function implied(a) { a = num(a); return a == null || (a > -100 && a < 100) ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100); }
  function phi(z) { return window.OnyxLive && OnyxLive.phi ? OnyxLive.phi(z) : 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z))); }
  function inv(p) { p = Math.min(0.995, Math.max(0.005, p)); var lo = -5, hi = 5; for (var i = 0; i < 44; i++) { var m = (lo + hi) / 2; if (phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
  // the x where fn(x) = target, fn increasing in x
  function solve(fn, lo, hi, target, n) { for (var i = 0; i < (n || 30); i++) { var m = (lo + hi) / 2; if (fn(m) < target) lo = m; else hi = m; } return (lo + hi) / 2; }
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function last(n) { n = String(n || '').trim().split(/\s+/); return n[n.length - 1] || ''; }
  function pct(x) { return x == null ? '' : x >= 0.995 && x < 1 ? '99%' : x > 0 && x < 0.01 ? '1%' : Math.round(100 * x) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function fmtN(x) { return x == null ? '' : String(Math.round(x * 10) / 10); }
  function json(u) {
    if (window.OnyxESPN && OnyxESPN.json && u.indexOf(ESPN) === 0) return OnyxESPN.json(u);
    return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); });
  }
  function preOf(p) { var c = num(p.conf); if (c != null && c > 0 && c < 1) return c; var i = implied(p.price); return i != null ? i : null; }

  // live.js, on demand: the fitted live models live there (sport pages and the hub already load it)
  var LIVE_P = null;
  function ensureLive() {
    if (window.OnyxLive) return Promise.resolve(true);
    if (LIVE_P) return LIVE_P;
    LIVE_P = new Promise(function (res) {
      var s = document.querySelector('script[src="live.js"]');
      var done = function () { res(!!window.OnyxLive); };
      if (!s) { s = document.createElement('script'); s.src = 'live.js'; s.async = true; (document.head || document.documentElement).appendChild(s); }
      s.addEventListener('load', done); s.addEventListener('error', done);
      setTimeout(done, 5000);
    });
    return LIVE_P;
  }

  // ── ESPN: the game a pick is in ──────────────────────────────────────────
  function teamGames(k) {
    if (!SB[k]) return Promise.resolve([]);
    return json(ESPN + SB[k]).then(function (j) {
      return (j.events || []).map(function (e) {
        var c = (e.competitions || [{}])[0] || {}, st = c.status || e.status || {}, ty = st.type || {}, T = {};
        (c.competitors || []).forEach(function (x) { T[x.homeAway] = x; });
        if (!T.home || !T.away) return null;
        var side = function (x) { var t = x.team || {}; return {ab: t.abbreviation || '', name: t.displayName || '', sc: num(x.score) || 0}; };
        return {k: k, id: String(e.id), state: ty.state, detail: ty.shortDetail || ty.detail || '', period: st.period || 0, clock: num(st.clock) || 0,
                a: side(T.away), h: side(T.home)};
      }).filter(Boolean);
    }).catch(function () { return []; });
  }
  function tennisMatches() {
    return Promise.all(['atp', 'wta'].map(function (t) {
      return json(ESPN + 'tennis/' + t + '/scoreboard').then(function (j) {
        var out = [];
        (j.events || []).forEach(function (e) {
          (e.groupings || []).forEach(function (g) {
            var gn = (g.grouping || {}).displayName || '';
            if (!/singles/i.test(gn)) return;
            (g.competitions || []).forEach(function (c) { if ((c.competitors || []).length === 2) out.push({e: e, c: c, women: t === 'wta' || /women/i.test(gn)}); });
          });
        });
        return out;
      }).catch(function () { return []; });
    })).then(function (a) { return a[0].concat(a[1]); });
  }
  function findGame(p, t) {
    return teamGames(p.sport).then(function (G) {
      var id = t && t.gid ? String(t.gid) : p.gid ? String(p.gid) : null, g = null;
      if (id) g = G.filter(function (x) { return x.id === id; })[0] || null;
      if (!g) {
        var tm = p.team || p.name || String(p.matchup || '').split(/ @ | vs /)[0];
        g = G.filter(function (x) { return x.a.ab === tm || x.h.ab === tm; })[0] || null;
      }
      return g;
    });
  }
  // share of the game still to play
  function leftOf(g) {
    if (!g) return null;
    if (g.state === 'post') return 0;
    if (g.state !== 'in') return 1;
    if (g.k === 'mlb') { var inn = Math.max(1, g.period || 1); return Math.max(0.02, Math.min(1, (9.5 - inn) / 9)); }
    if (window.OnyxLive && OnyxLive.left && LEN[g.k]) { var f = OnyxLive.left(g.k, g.period, g.clock); if (f != null) return f; }
    var L = LEN[g.k]; if (!L || !g.period) return null;
    if (g.period > L[0]) return Math.max(0.004, (g.clock || 0) / 60 / (L[1] * L[0]));
    return Math.max(0.004, Math.min(1, ((L[0] - g.period) * L[1] * 60 + (g.clock || 0)) / (L[0] * L[1] * 60)));
  }
  function minsLeft(g, f) {
    var L = LEN[g.k]; if (!L || f == null) return null;
    var m = f * L[0] * L[1]; return m < 1 ? Math.max(1, Math.round(m * 60)) + ' sec' : Math.round(m) + ' min';
  }

  // ── game lines: the live model, started from the saved chance ────────────
  var FIT = {};
  function fallbackModel(sport, g) {     // MLB, or live.js missing: a normal draw over the time left
    var sd = SDF[sport] || [12, 14], f = g.f, sM = sd[0] * Math.sqrt(Math.max(f, 1e-4)), sT = sd[1] * Math.sqrt(Math.max(f, 1e-4));
    var cur = g.hs - g.as, tot = g.hs + g.as, mu = (g.pre_margin || 0) * f, mt = (g.pre_total || DEFT[sport] || 0) * f;
    return {win: function () { return 1 - phi((-cur - mu) / sM); }, cover: function (h) { return 1 - phi((-h - cur - mu) / sM); },
            over: function (l) { return 1 - phi((l - tot - mt) / sT); }};
  }
  function model(sport, g) {
    var m = null;
    if (window.OnyxLive && OnyxLive.model && sport !== 'mlb') { try { m = OnyxLive.model(sport, g); } catch (e) { m = null; } }
    return m || fallbackModel(sport, g);
  }
  // the pregame inputs (home = the pick's own side) that make the model's chance at the start equal the saved chance
  function fitPre(p, pre) {
    var sport = p.sport, key = [p.id, sport, p.kind, p.side, p.line, p.hcap, pre, !!window.OnyxLive].join('|');
    if (FIT[key]) return FIT[key];
    var over = p.side !== 'under', sd = SDF[sport] || [12, 14], T0 = DEFT[sport] || 0, h = +p.hcap || 0;
    var at0 = function (o) { return model(sport, Object.assign({hs: 0, as: 0, f: 1}, o)); };
    var out;
    if (sport === 'nhl') {
      if (p.kind === 'total') out = {pre_home_win: 0.5, pre_total: solve(function (T) { var q = at0({pre_home_win: 0.5, pre_total: T}).over(+p.line); return over ? q : 1 - q; }, 1, 14, pre, 22)};
      else if (p.kind === 'spread') out = {pre_total: T0, pre_home_win: solve(function (w) { return at0({pre_home_win: w, pre_total: T0}).cover(h); }, 0.02, 0.98, pre, 18)};
      else out = {pre_total: T0, pre_home_win: pre};
    } else if (p.kind === 'total') {
      out = {pre_margin: 0, pre_home_win: 0.5, pre_total: +p.line + sd[1] * inv(over ? pre : 1 - pre)};
    } else {
      var m = sd[0] * inv(pre) - (p.kind === 'spread' ? h : 0);
      out = {pre_margin: m, pre_total: T0, pre_home_win: phi(m / sd[0])};
    }
    return (FIT[key] = out);
  }
  function gameLine(p, t, g, pre) {
    var f = leftOf(g); if (f == null) return null;
    var homeIsMe = p.kind === 'total' ? true : (p.name || p.team) === g.h.ab ? true : (p.name || p.team) === g.a.ab ? false : null;
    if (homeIsMe == null) return null;
    var my = homeIsMe ? g.h : g.a, op = homeIsMe ? g.a : g.h;
    var fp = fitPre(p, pre), o = Object.assign({hs: my.sc, as: op.sc, f: Math.max(f, 0.004)}, fp);
    var M = model(p.sport, o), x;
    if (p.kind === 'ml') x = M.win();
    else if (p.kind === 'spread') x = M.cover(+p.hcap || 0);
    else { var q = M.over(+p.line); x = p.side === 'under' ? 1 - q : q; }
    var r = {p: clamp(x), f: f};
    var ml = minsLeft(g, f), when = ml ? ' in ' + ml : '';
    var score = g.a.ab + ' ' + g.a.sc + ', ' + g.h.ab + ' ' + g.h.sc;
    if (p.kind === 'total') {
      var tot = g.a.sc + g.h.sc, need = Math.floor(+p.line - tot) + 1;
      r.now = tot + ' total, ' + g.detail;
      r.need = p.side === 'under' ? (need > 1 ? (need - 1) + ' pts of room' + (ml ? ', ' + ml + ' left' : '') : 'No room left') : 'Needs ' + need + ' more' + when;
    } else {
      var m = my.sc - op.sc, cov = m + (p.kind === 'spread' ? +p.hcap || 0 : 0);
      r.now = score + ', ' + g.detail;
      if (p.kind === 'spread') r.need = cov > 0 ? 'Covering by ' + fmtN(cov) : cov === 0 ? 'On the number' : 'Needs ' + (Math.floor(-cov) + 1) + when;
      else r.need = m > 0 ? 'Up ' + m + (ml ? ', ' + ml + ' left' : '') : m < 0 ? 'Down ' + (-m) + (ml ? ', ' + ml + ' left' : '') : 'Tied' + (ml ? ', ' + ml + ' left' : '');
    }
    return r;
  }

  // ── tennis: the point chain from the live score ──────────────────────────
  function tennisLine(p, pre) {
    return tennisMatches().then(function (C) {
      var me = nk(p.name), hit = null;
      C.forEach(function (x) { if ((x.c.competitors || []).some(function (y) { return nk((y.athlete || {}).displayName) === me; })) hit = x; });
      if (!hit) return null;
      var cs = hit.c.competitors, A = cs.filter(function (y) { return nk((y.athlete || {}).displayName) === me; })[0], B = cs.filter(function (y) { return y !== A; })[0];
      var ty = (hit.c.status || {}).type || {}, la = A.linescores || [], lb = B.linescores || [];
      var sets = la.map(function (l, i) { return [num(l.value) || 0, num((lb[i] || {}).value) || 0]; });
      var srv = A.possession ? 0 : B.possession ? 1 : null, slam = !hit.women && /australian open|roland|french open|wimbledon|us open/i.test(hit.e.name || '');
      var need = slam ? 3 : 2, state = ty.state === 'in' ? 'in' : ty.state === 'post' ? 'post' : 'pre';
      var r = {state: state, now: sets.length ? sets.map(function (s) { return s[0] + '-' + s[1]; }).join(', ') + (state === 'in' ? (srv === 0 ? ', serving' : srv === 1 ? ', returning' : '') : '') : (ty.shortDetail || '')};
      if (state === 'pre') return r;
      var games = sets.reduce(function (m, s) { return m + s[0] + s[1]; }, 0), marg = sets.reduce(function (m, s) { return m + s[0] - s[1]; }, 0);
      if (state === 'post') {
        if (p.kind === 'ml') r.res = A.winner ? 'W' : B.winner ? 'L' : null;
        else if (p.kind === 'spread') { var cv = marg + (+p.hcap || 0); r.res = cv > 0 ? 'W' : cv < 0 ? 'L' : 'P'; }
        else if (p.kind === 'total' && p.line != null) r.res = games === +p.line ? 'P' : (games > +p.line) === (p.side !== 'under') ? 'W' : 'L';
        return r;
      }
      if (!window.OnyxLive || !OnyxLive.tn) return r;
      var tn = OnyxLive.tn, st = tn.state(sets, srv), tour = hit.women ? 'WTA' : 'ATP';
      var mk = function (w) { return OnyxLive.model('tennis', {st: st, need: need, tour: tour, pre_home_win: w}); };
      var x;
      if (p.kind === 'ml') x = mk(pre).win();
      else if (p.kind === 'spread') {
        var key = 'tn|' + p.id + '|' + pre, w0 = FIT[key];
        if (w0 == null) w0 = FIT[key] = solve(function (w) { return OnyxLive.model('tennis', {st: tn.state([]), need: need, tour: tour, pre_home_win: w}).cover(+p.hcap || 0); }, 0.03, 0.97, pre, 12);
        x = mk(w0).cover(+p.hcap || 0);
      } else if (p.kind === 'total' && p.line != null) {
        // one input (who is better) cannot fit a total: the chain's number, nudged toward the saved chance by the share still to play
        var q = mk(0.5).over(+p.line), q0 = OnyxLive.model('tennis', {st: tn.state([]), need: need, tour: tour, pre_home_win: 0.5}).over(+p.line);
        if (p.side === 'under') { q = 1 - q; q0 = 1 - q0; }
        var lg = function (v) { v = Math.min(0.995, Math.max(0.005, v)); return Math.log(v / (1 - v)); };
        var left = Math.max(0, 1 - games / Math.max(1, +p.line)), z = lg(q) + (lg(pre) - lg(q0)) * left;
        x = 1 / (1 + Math.exp(-z));
      } else return r;
      var sa = st.sa, sb = st.sb;
      r.p = clamp(x);
      r.need = p.kind === 'total' ? games + ' games so far' : sa > sb ? 'Up ' + (sa - sb === 1 ? 'a set' : sa - sb + ' sets') : sb > sa ? 'Down ' + (sb - sa === 1 ? 'a set' : sb - sa + ' sets') : 'Sets level';
      return r;
    }).catch(function () { return null; });
  }

  // ── props: the box stat and the pace for the time left ───────────────────
  // markets saved.js does not read (threes, the combos): from the same box score
  var COMBO = {pra: ['PTS', 'REB', 'AST'], pr: ['PTS', 'REB'], pa: ['PTS', 'AST'], ra: ['REB', 'AST'], threes: ['3PT']};
  function boxStat(sport, gid, name, mkt) {
    if (!COMBO[mkt] || !SUMP[sport] || !gid) return Promise.resolve(null);
    return json(ESPN + SUMP[sport] + '/summary?event=' + gid).then(function (j) {
      var v = null;
      ((j && j.boxscore || {}).players || []).forEach(function (t) { (t.statistics || []).forEach(function (b) { (b.athletes || []).forEach(function (a) {
        if (nk((a.athlete || {}).displayName) !== nk(name) || !(a.stats || []).length) return;
        var L = (b.labels || []).map(function (x) { return String(x).toUpperCase(); }), s = 0, ok = true;
        COMBO[mkt].forEach(function (l) { var i = L.indexOf(l), x = i < 0 ? null : num(String(a.stats[i]).split('-')[0]); if (x == null) ok = false; else s += x; });
        if (ok) v = s;
      }); }); });
      return v;
    }).catch(function () { return null; });
  }
  function propP(mkt, cur, proj, f, line) {
    if (window.OnyxLive && OnyxLive.propP) return OnyxLive.propP(mkt, cur, proj, f, line);
    var rem = Math.max(0, proj * f), sd = /yds$/.test(mkt) ? (0.45 * proj + 12) * Math.sqrt(f) : Math.sqrt(Math.max(0.15, rem * 1.5));
    return 1 - phi((line - cur - rem) / Math.max(sd, 0.35));
  }
  function projFor(mkt, line, pOver) { return solve(function (m) { return propP(mkt, 0, m, 1, line); }, 0, Math.max(10, line * 4 + 10), pOver, 40); }
  function propLine(p, t, g, pre, cur) {
    var f = leftOf(g); if (f == null || cur == null) return null;
    var over = p.side !== 'under', u = UNIT[p.mkt] || '', ml = g ? minsLeft(g, f) : null, r = {f: f};
    r.now = fmtN(cur) + (u ? ' ' + u : '') + (g && g.detail ? ', ' + g.detail : '');
    if (p.mkt === 'anytime_td') {
      r.p = cur >= 1 ? 1 : clamp(1 - Math.exp(Math.log(1 - Math.min(0.99, pre)) * f));
      r.need = cur >= 1 ? '' : 'Needs a TD' + (ml ? ' in ' + ml : '');
      return r;
    }
    if (p.line == null) return null;
    var line = +p.line;
    var pOv = cur > line ? 1 : f <= 0 ? 0 : propP(p.mkt, cur, projFor(p.mkt, line, over ? pre : 1 - pre), f, line);
    r.p = clamp(over ? pOv : 1 - pOv);
    var more = Math.floor(line - cur) + 1;
    if (over) r.need = cur > line ? '' : 'Needs ' + more + ' more' + (u ? ' ' + u : '') + (ml ? ' in ' + ml : '');
    else r.need = cur > line ? '' : (more - 1 > 0 ? 'Room for ' + (more - 1) + ' more' : 'No room left') + (ml ? ', ' + ml + ' left' : '');
    return r;
  }

  // ── history (this session, survives a reload) and the change event ───────
  var HK = 'onyxCashPts', H = null, LAST = {};
  function hLoad() { if (H) return H; try { H = JSON.parse(sessionStorage.getItem(HK) || '{}') || {}; } catch (e) { H = {}; } return H; }
  var hTimer = null;
  function hSave() { clearTimeout(hTimer); hTimer = setTimeout(function () { try { sessionStorage.setItem(HK, JSON.stringify(H)); } catch (e) {} }, 250); }
  function history(id) { var a = hLoad()[id] || []; return a.map(function (x) { return {t: x[0], p: x[1]}; }); }
  function note(id, p) {
    if (p == null || !id) return;
    var h = hLoad(), a = h[id] || (h[id] = []), now = Date.now(), l = a[a.length - 1];
    if (l && Math.abs(l[1] - p) < 0.005 && now - l[0] < 60e3) return;
    if (l && Math.abs(l[1] - p) < 0.005 && a.length > 1 && Math.abs(a[a.length - 2][1] - p) < 0.005) { l[0] = now; hSave(); return; }   // flat: slide the last point
    a.push([now, Math.round(p * 1000) / 1000]);
    if (a.length > 120) a.splice(0, a.length - 120);
    var ids = Object.keys(h);
    if (ids.length > 60) ids.sort(function (x, y) { return (h[x][h[x].length - 1] || [0])[0] - (h[y][h[y].length - 1] || [0])[0]; }).slice(0, ids.length - 60).forEach(function (k) { delete h[k]; });
    hSave();
  }
  function fire(id, p, res) {
    var was = LAST[id];
    if (was === undefined) { var hh = history(id); was = hh.length ? hh[hh.length - 1].p : null; }
    LAST[id] = p;
    var moved = p != null && (was == null || Math.abs(p - was) >= 0.01), settled = res === 'W' || res === 'L' || res === 'P';
    if (!moved && !(settled && LAST['res|' + id] !== res)) return;
    LAST['res|' + id] = res;
    try { dispatchEvent(new CustomEvent('onyx-cash', {detail: {id: id, p: p, prev: was, res: res || null}})); } catch (e) {}
  }
  function trendOf(id) {
    var a = history(id); if (a.length < 2) return 'flat';
    var now = a[a.length - 1], ref = a[Math.max(0, a.length - 4)];
    for (var i = a.length - 2; i >= 0; i--) { if (now.t - a[i].t >= 4 * 60e3) { ref = a[i]; break; } }
    var d = now.p - ref.p; return d >= 0.03 ? 'up' : d <= -0.03 ? 'down' : 'flat';
  }
  function statusOf(r) {
    if (r.res === 'W') return 'Cashed';
    if (r.res === 'L') return 'Lost';
    if (r.res === 'P') return 'Push';
    if (r.p == null) return r.state === 'live' ? 'In play' : 'Not started';
    if (r.state === 'pre') return 'Pregame ' + pct(r.p);
    return (r.p >= 0.55 ? 'Trending to cash ' : r.p >= 0.4 ? 'Too close to call ' : r.p > 0.25 ? 'Behind pace ' : 'Long shot ') + pct(r.p);
  }
  function startTxt(s) {
    var t = Date.parse(s); if (isNaN(t)) return 'Not started';
    try { return 'Starts ' + new Date(t).toLocaleString('en-US', {weekday: Math.abs(t - Date.now()) > 20 * 3600e3 ? 'short' : undefined, hour: 'numeric', minute: '2-digit'}); } catch (e) { return 'Not started'; }
  }
  function finish(p, r) {
    r.id = p.id;
    r.status = statusOf(r);
    if (r.res === 'W' || r.res === 'L' || r.res === 'P') { r.need = ''; }
    if (r.state !== 'pre' || !(hLoad()[p.id] || []).length) note(p.id, r.p);
    r.pts = history(p.id); r.trend = trendOf(p.id);
    r.now = r.now || ''; r.need = r.need || '';
    fire(p.id, r.p, r.res);
    if (window.OnyxHedge && OnyxHedge.seen) { try { OnyxHedge.seen(p, r); } catch (e) {} }
    return r;
  }

  // ── one pick ─────────────────────────────────────────────────────────────
  function track(p, opt) {
    if (opt && opt.track) return Promise.resolve(opt.track);
    if (window.OnyxSaved && OnyxSaved.track) return OnyxSaved.track(p).catch(function () { return {p: p, state: 'pre', res: null}; });
    return Promise.resolve({p: p, state: Date.parse(p.start) < Date.now() ? 'in' : 'pre', res: null, cur: null});
  }
  function single(p, opt, raw) {
    var pre = preOf(p);
    return track(p, opt).then(function (t) {
      t = t || {};
      var st = t.state === 'post' ? 'final' : t.state === 'in' ? 'live' : 'pre';
      var r = {state: st, p: pre, res: null, now: '', need: ''};
      if (t.res === 'W' || t.res === 'L' || t.res === 'P') {
        r.res = t.res; r.p = t.res === 'W' ? 1 : t.res === 'L' ? 0 : null;
        if (t.cur != null) r.now = p.kind === 'prop' ? fmtN(t.cur) + ' ' + (UNIT[p.mkt] || '') : p.kind === 'total' ? t.cur + ' total' : 'Score ' + t.cur;
        return r;
      }
      if (p.sport === 'tennis') {
        return ensureLive().then(function () { return tennisLine(p, pre == null ? 0.5 : pre); }).then(function (x) {
          if (!x) return r;
          r.state = x.state === 'post' ? 'final' : x.state === 'in' ? 'live' : 'pre';
          r.now = x.now || ''; r.need = x.need || '';
          if (x.res) { r.res = x.res; r.p = x.res === 'W' ? 1 : x.res === 'L' ? 0 : null; }
          else if (x.p != null) r.p = x.p;
          if (r.state === 'pre') r.now = startTxt(p.start);
          return r;
        });
      }
      if (st === 'pre') { r.now = startTxt(p.start); return r; }
      // an under that is already over its line is dead, whatever the clock says
      if (p.kind === 'prop' && p.side === 'under' && p.line != null && typeof t.cur === 'number' && t.cur > +p.line) {
        r.res = 'L'; r.p = 0; r.now = fmtN(t.cur) + ' ' + (UNIT[p.mkt] || ''); return r;
      }
      if (pre == null) return r;
      return Promise.all([ensureLive(), findGame(p, t)]).then(function (a) {
        var g = a[1];
        if (st === 'final' || (g && g.state === 'post')) { r.state = 'final'; return r; }   // final and not graded yet: hold the last number
        if (p.kind === 'prop') {
          // saved.js reads pts / reb / ast and the football yards; threes and the combos come from the same box score here
          var curP = COMBO[p.mkt] ? boxStat(p.sport, g && g.id, p.name, p.mkt) : typeof t.cur === 'number' ? Promise.resolve(t.cur) : Promise.resolve(num(t.cur));
          return curP.then(function (cur) {
            if (p.mkt === 'q1_total' || p.mkt === 'h1_total') { if (cur != null) r.now = cur + ' so far' + (g ? ', ' + g.detail : ''); return r; }
            var x = propLine(p, t, g, pre, cur);
            if (!x) { if (g) r.now = 'In play, ' + g.detail; return r; }
            if (x.p === 1 && p.side !== 'under') r.res = 'W';
            r.p = x.p; r.now = x.now; r.need = x.need; r.cur = cur; return r;
          });
        }
        if (g && (p.kind === 'ml' || p.kind === 'spread' || p.kind === 'total')) {
          var x = gameLine(p, t, g, pre);
          if (x) { r.p = x.p; r.now = x.now; r.need = x.need; }
          else r.now = g.detail;
        }
        return r;
      });
    }).catch(function () { return {state: 'pre', p: pre, res: null, now: '', need: ''}; });
  }
  function short(p) {
    if (p.kind === 'prop' && p.name && p.line != null) return last(p.name) + ' ' + (p.side === 'under' ? 'u' : 'o') + p.line + (UNIT[p.mkt] ? ' ' + UNIT[p.mkt] : '');
    if (p.kind === 'prop' && p.mkt === 'anytime_td' && p.name) return last(p.name) + ' TD';
    return p.label || p.name || 'Leg';
  }
  function parlay(p, opt) {
    var legs = p.legs || [], T = opt && opt.track && opt.track.legs;
    return Promise.all(legs.map(function (l, j) {
      return single(l, T && T[j] ? {track: T[j]} : null).then(function (r) { r.id = l.id; return r; });
    })).then(function (R) {
      var lost = R.some(function (r) { return r.res === 'L'; }), done = R.every(function (r) { return r.res === 'W' || r.res === 'L' || r.res === 'P'; });
      var pushed = R.filter(function (r) { return r.res === 'P'; }).length, won = R.filter(function (r) { return r.res === 'W'; }).length;
      var prod = R.reduce(function (m, r) { var c = r.res === 'W' || r.res === 'P' ? 1 : r.p; return m == null || c == null ? null : m * c; }, 1);
      var state = R.some(function (r) { return r.state === 'live'; }) ? 'live' : R.every(function (r) { return r.state === 'final' || r.res; }) ? 'final' : R.some(function (r) { return r.state !== 'pre'; }) ? 'live' : 'pre';
      var r = {state: state, p: lost ? 0 : prod, res: lost ? 'L' : done ? (pushed === R.length ? 'P' : 'W') : null};
      if (r.res === 'W') r.p = 1;
      // the sweat: the open leg least likely to land (live ones first)
      var sw = -1, swp = 2;
      R.forEach(function (x, j) { if (x.res) return; var k = (x.state === 'live' ? 0 : 1) + (x.p == null ? 0.99 : x.p); if (k < swp) { swp = k; sw = j; } });
      r.legs = R.map(function (x, j) { return {id: legs[j].id, label: legs[j].label || short(legs[j]), short: short(legs[j]), p: x.p, res: x.res, state: x.state, status: statusOf(x), now: x.now || '', need: x.need || '', cur: x.cur}; });
      r.sweat = lost ? -1 : sw;
      r.now = won + ' of ' + R.length + ' won' + (pushed ? ', ' + pushed + ' push' : '');
      r.need = lost ? 'A leg lost' : sw >= 0 ? (R[sw].state === 'live' ? 'Sweat: ' : 'Next up: ') + short(legs[sw]) + (R[sw].p != null ? ' at ' + pct(R[sw].p) : '') : '';
      return r;
    });
  }
  function chance(p, opt) {
    if (!p) return Promise.resolve({state: 'pre', p: null, res: null, now: '', need: '', trend: 'flat', pts: [], status: 'Not started'});
    var go = p.kind === 'parlay' && (p.legs || []).length ? parlay(p, opt) : single(p, opt);
    return go.then(function (r) { return finish(p, r); });
  }
  function text(r) { return r ? [r.status, r.need, r.now].filter(Boolean).join(' · ') : ''; }

  // ── the meter ────────────────────────────────────────────────────────────
  var CSS = [
    '.ocx{display:grid;grid-template-columns:minmax(0,1fr) minmax(92px,38%);gap:6px 12px;align-items:center;box-sizing:border-box;width:100%;padding:10px 12px;border-radius:12px;',
    'background:linear-gradient(160deg,rgba(176,56,249,.14),rgba(176,56,249,.03));border:1px solid rgba(176,56,249,.35);font-family:"Space Grotesk",system-ui,sans-serif;color:#efeaf7;text-align:left}',
    '.ocx.c{padding:7px 10px;grid-template-columns:minmax(0,1fr) 84px}',
    '.ocx-l{min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.ocx-k{font:700 9.5px/1.2 monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff;display:flex;align-items:center;gap:6px}',
    '.ocx-k i{width:6px;height:6px;border-radius:50%;background:#ff5c8a;box-shadow:0 0 6px #ff5c8a;animation:ocxDot 1.6s ease-in-out infinite}',
    '.ocx[data-state="pre"] .ocx-k i,.ocx[data-state="final"] .ocx-k i{background:#8f879c;box-shadow:none;animation:none}',
    '.ocx-p{display:flex;align-items:baseline;gap:8px;min-width:0}',
    '.ocx-p b{font:800 24px/1 "Space Grotesk",system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#fff}',
    '.ocx.c .ocx-p b{font-size:18px}',
    '.ocx-p span{font:700 12px/1.25 "Space Grotesk",system-ui,sans-serif;color:#e8e2f1;min-width:0;overflow-wrap:anywhere}',
    '.ocx-tr{font:800 11px monospace}.ocx-tr.up{color:#61e970}.ocx-tr.down{color:#ff8a8a}',
    '.ocx-n{font:600 11px/1.35 monospace;color:#cfc8da;overflow-wrap:anywhere}.ocx-n b{color:#fff}',
    '.ocx-bar{grid-column:1/-1;height:5px;border-radius:9px;background:rgba(255,255,255,.1);overflow:hidden}',
    '.ocx-bar i{display:block;height:100%;border-radius:9px;background:#b038f9;transition:width .6s}',
    '.ocx-ch{width:100%;height:46px;display:block;overflow:visible}.ocx.c .ocx-ch{height:34px}',
    '.ocx-ft{grid-column:1/-1;font:600 9.5px/1.3 monospace;color:#8f879c}',
    '.ocx[data-tone="good"]{border-color:rgba(97,233,112,.5)}.ocx[data-tone="good"] .ocx-bar i{background:#61e970}.ocx[data-tone="good"] .ocx-p b{color:#61e970}',
    '.ocx[data-tone="bad"]{border-color:rgba(255,138,138,.45)}.ocx[data-tone="bad"] .ocx-bar i{background:#ff8a8a}.ocx[data-tone="bad"] .ocx-p b{color:#ff8a8a}',
    '.ocx[data-res="W"]{background:linear-gradient(160deg,rgba(97,233,112,.16),rgba(97,233,112,.03))}',
    '.ocx[data-res="L"]{opacity:.85}',
    '.ocx-legs{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px}',
    '.ocx-leg{font:700 10.5px/1 monospace;padding:4px 7px;border-radius:999px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.1);color:#e8e2f1;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ocx-leg.w{border-color:rgba(97,233,112,.55);color:#61e970}.ocx-leg.l{border-color:rgba(255,138,138,.5);color:#ff8a8a}.ocx-leg.s{border-color:#b038f9;box-shadow:0 0 0 1px rgba(176,56,249,.4)}',
    '@keyframes ocxDot{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.ocx-k i{animation:none}.ocx-bar i{transition:none}}'
  ].join('');
  function css() {
    if (document.getElementById('ocx-css')) return;
    var s = document.createElement('style'); s.id = 'ocx-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s);
  }
  function toneOf(r) {
    if (r.res === 'W') return 'good'; if (r.res === 'L') return 'bad';
    if (r.p == null) return 'live';
    return r.p >= 0.6 ? 'good' : r.p <= 0.25 ? 'bad' : 'live';
  }
  var COL = {good: '#61e970', bad: '#ff8a8a', live: '#b038f9'};
  function chart(r, tone) {
    var a = (r.pts || []).slice(-90), W = 100, Hh = 40;
    if (!a.length && r.p != null) a = [{t: Date.now(), p: r.p}];
    if (a.length === 1) a = [{t: a[0].t - 1, p: a[0].p}, a[0]];
    var t0 = a[0].t, t1 = a[a.length - 1].t, span = t1 - t0 || 1;
    var y = function (p) { return (Hh - 3 - (Hh - 6) * clamp(p)).toFixed(1); };
    var pts = a.map(function (x, i) { var xx = span > 1 ? (x.t - t0) / span * W : i / (a.length - 1) * W; return xx.toFixed(1) + ',' + y(x.p); }).join(' ');
    var c = COL[tone] || COL.live, lx = pts.split(' ').pop().split(',');
    return '<svg class="ocx-ch" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" role="img" aria-label="Chance to cash this session, now ' + esc(pct(r.p)) + '">'
      + '<line x1="0" x2="' + W + '" y1="' + y(0.5) + '" y2="' + y(0.5) + '" stroke="rgba(255,255,255,.18)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>'
      + '<polygon points="0,' + Hh + ' ' + pts + ' ' + W + ',' + Hh + '" fill="' + c + '" fill-opacity=".12"/>'
      + '<polyline points="' + pts + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      + '<circle cx="' + lx[0] + '" cy="' + lx[1] + '" r="2.4" fill="' + c + '"/></svg>';
  }
  function meterHTML(pick, r, compact) {
    var tone = toneOf(r), big = r.res === 'W' ? 'Cashed' : r.res === 'L' ? 'Lost' : r.res === 'P' ? 'Push' : r.p != null ? pct(r.p) : '--';
    var words = r.res === 'W' ? (r.state === 'final' ? 'Final' : 'Already cashed') : r.res === 'L' ? (r.state === 'final' ? 'Final' : r.legs ? 'A leg lost' : 'Past the line')
      : r.res === 'P' ? 'Final' : r.p == null ? r.status : r.status.replace(/\s*\d+%$/, '');
    var tr = r.state === 'live' && !r.res && r.trend !== 'flat' ? '<span class="ocx-tr ' + r.trend + '">' + (r.trend === 'up' ? '▲' : '▼') + '</span>' : '';
    var kick = r.state === 'live' && !r.res ? 'Live chance to cash' : r.state === 'pre' ? 'Chance to cash' : 'Chance to cash';
    var legs = '';
    if (r.legs && !compact) legs = '<div class="ocx-legs">' + r.legs.map(function (l, j) {
      var c = l.res === 'W' || l.res === 'P' ? 'w' : l.res === 'L' ? 'l' : j === r.sweat ? 's' : '';
      return '<span class="ocx-leg ' + c + '" title="' + esc(l.label + ': ' + l.status) + '">' + esc(l.short) + ' ' + (l.res === 'W' ? 'Hit' : l.res === 'L' ? 'Lost' : l.res === 'P' ? 'Push' : l.p != null ? pct(l.p) : '') + '</span>';
    }).join('') + '</div>';
    var line = [r.need, r.now].filter(Boolean).map(esc).join(' · ');
    return '<div class="ocx-l"><span class="ocx-k"><i></i>' + kick + '</span>'
      + '<span class="ocx-p"><b>' + esc(big) + '</b><span>' + esc(words) + ' ' + tr + '</span></span>'
      + (line ? '<span class="ocx-n">' + line + '</span>' : '') + '</div>'
      + chart(r, tone)
      + '<div class="ocx-bar"><i style="width:' + Math.round(100 * (r.p == null ? 0 : clamp(r.p))) + '%"></i></div>'
      + legs
      + (compact || r.res ? '' : '<div class="ocx-ft">' + (r.state === 'pre' ? 'Model chance before the start, a projection.' : 'Live projection from the score and the clock, not a guarantee.') + '</div>');
  }
  var MOUNTS = [], tick = null;
  function paint(m, r) {
    if (!m.el || !m.el.isConnected && m.drawn) return;
    var box = m.box;
    if (!box || !box.isConnected) { box = m.box = document.createElement('div'); m.el.appendChild(box); }
    box.className = 'ocx' + (m.compact ? ' c' : '');
    box.setAttribute('data-state', r.state); box.setAttribute('data-tone', toneOf(r)); box.setAttribute('data-res', r.res || '');
    box.setAttribute('data-p', r.p == null ? '' : String(Math.round(r.p * 1000) / 1000));
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Chance to cash: ' + text(r));
    box.innerHTML = meterHTML(m.pick, r, m.compact);
    m.drawn = true; m.r = r;
    // the hedge chip (onyx-hedge.js): only on a worked-out chance (r.id), never on the reload's placeholder line
    if (r.id && !m.compact && window.OnyxHedge && OnyxHedge.decorate) { try { OnyxHedge.decorate(box, m.pick, r); } catch (e) {} }
  }
  function update(m) {
    if (m.dead) return Promise.resolve();
    return chance(m.pick).then(function (r) { if (!m.dead) paint(m, r); return r; }, function () {});
  }
  function schedule() {
    clearTimeout(tick);
    MOUNTS = MOUNTS.filter(function (m) { return !m.dead && (!m.drawn || m.el.isConnected); });
    if (!MOUNTS.length || document.hidden) return;
    var live = MOUNTS.filter(function (m) { return m.r && m.r.state === 'live' && !m.r.res; });
    var tennis = live.some(function (m) { return m.pick.sport === 'tennis' || (m.pick.legs || []).some(function (l) { return l.sport === 'tennis'; }); });
    var open = MOUNTS.filter(function (m) { return !m.r || !(m.r.state === 'final' || m.r.res === 'L' || (m.r.res && m.pick.kind !== 'parlay')); });
    if (!open.length) return;
    var ms = live.length ? (tennis ? 15e3 : 30e3) : 120e3;
    tick = setTimeout(function () { Promise.all(open.map(update)).then(schedule, schedule); }, ms);
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(tick); else { clearTimeout(tick); tick = setTimeout(function () { Promise.all(MOUNTS.map(update)).then(schedule, schedule); }, 700); } });
  function mount(el, pick, o) {
    if (!el || !pick) return {stop: function () {}};
    css();
    var m = {el: el, pick: pick, compact: !!(o && o.compact), dead: false};
    // the last line this session drew, at once (no pop-in on a reload)
    var h = history(pick.id);
    if (h.length) paint(m, {state: 'live', p: h[h.length - 1].p, res: null, status: statusOf({state: 'live', p: h[h.length - 1].p}), now: '', need: '', trend: 'flat', pts: h});
    MOUNTS.push(m);
    update(m).then(schedule, schedule);
    return {stop: function () { m.dead = true; if (m.box && m.box.parentNode) m.box.parentNode.removeChild(m.box); }, refresh: function () { return update(m); }, el: function () { return m.box; }};
  }

  // ── live leans: the live model against Onyx's live line ──────────────────
  var RELAY = null;
  function relayOn() {
    if (!RELAY) RELAY = fetch('ai.json', {cache: 'no-cache'}).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { return !!(j && j.url); }).catch(function () { return false; });
    return RELAY;
  }
  var LEAN_C = {};
  function onyxHref(sel) { return sel ? 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(sel) + '&referrer=' + REF : 'https://app.onyxodds.com/?referrer=' + REF; }
  function leans(sport) {
    var key = sport || 'all', c = LEAN_C[key];
    if (c && Date.now() - c.t < 25e3) return c.p;
    var p = relayOn().then(function (on) {
      if (!on) return [];
      return ensureLive().then(function (ok) {
        if (!ok || !OnyxLive.games) return [];
        var only = sport ? [sport] : null;
        return OnyxLive.games(only).then(function (G) {
          var out = [];
          (G || []).forEach(function (g) {
            (g.bets || []).forEach(function (b) {
              if (!(OnyxLive.isVal ? OnyxLive.isVal(b) : b.edge >= 0.03)) return;
              out.push({label: b.label, matchup: g.name || (g.away + ' @ ' + g.home), sport: g.sport, kind: b.kind, price: b.price, p: Math.round(b.p * 1000) / 1000,
                        edge: b.edge, fair: b.fair, sel: b.sel || null, href: onyxHref(b.sel), gid: g.gid, now: g.detail || ''});
            });
          });
          return out.sort(function (a, b) { return b.edge - a.edge; }).slice(0, 8);
        });
      });
    }).catch(function () { return []; });
    LEAN_C[key] = {t: Date.now(), p: p};
    return p;
  }

  // ── hedge / lock profit (onyx-hedge.js), loaded once the page is idle; meters drawn before it arrives get their chip then ──
  var HEDGE_P = null;
  function ensureHedge() {
    if (window.OnyxHedge) return Promise.resolve(true);
    if (HEDGE_P) return HEDGE_P;
    HEDGE_P = new Promise(function (res) {
      var s = document.querySelector('script[src="onyx-hedge.js"]');
      var done = function () {
        if (window.OnyxHedge) MOUNTS.forEach(function (m) { if (m.r && m.r.id && m.box && m.box.isConnected && !m.compact) { try { OnyxHedge.decorate(m.box, m.pick, m.r); } catch (e) {} } });
        res(!!window.OnyxHedge);
      };
      if (!s) { s = document.createElement('script'); s.src = 'onyx-hedge.js'; s.async = true; (document.head || document.documentElement).appendChild(s); }
      s.addEventListener('load', done); s.addEventListener('error', function () { res(false); });
    });
    return HEDGE_P;
  }
  if ('requestIdleCallback' in window) requestIdleCallback(ensureHedge, {timeout: 4000}); else setTimeout(ensureHedge, 1500);

  window.OnyxCash = {chance: chance, ensureHedge: ensureHedge, mount: mount, leans: leans, history: history, text: text, status: statusOf, ensureLive: ensureLive, css: css,
    _fit: fitPre};
})();
