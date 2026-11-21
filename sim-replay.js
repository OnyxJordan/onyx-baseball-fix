// sim-replay.js - Sim Replay's engine (11/20, Jordan: "I want a better version of this", a rival's simulated-game video).
// Play It Out (studio-sim.js) plays a basketball game 10,000 times. This file takes ONE of those games and writes it out
// as a full play-by-play that lands on that game exactly: its final score, its overtime (if any), and every player's
// points, rebounds, assists and threes as the sim drew them. Nothing here is a new opinion; it is bookkeeping.
//
// How one game is built (build(ctx, k) below; every step is seeded by the game id and the sim index, so a game always
// replays identically):
//   1. The box. Players with an Onyx points / rebounds / assists / threes prop keep the sim's own draw for that game
//      (the very numbers Play It Out graded the prop on). Other board players read their three latents from the same
//      game (points, rebounds, assists move with his minutes and his team's score, as in the sim). Players with no
//      line split the rest of the team's simulated score in proportion to their projections. Then the made shots
//      (threes from the sim or his threes rate, free throws from the points, the rest twos), free-throw trips and
//      and-ones, offensive and defensive rebounds, and misses: a team's missed shots are exactly the rebounds both
//      teams grab off them plus team rebounds, so every rebound in the box has a miss to come off. Turnovers are set
//      so the possession count matches the sim's pace for that game; steals, blocks and fouls fit inside them.
//   2. The possessions. Each team's shots, trips and turnovers are strung into possessions (an offensive rebound keeps
//      the possession alive), split into quarters that alternate possession the NBA way (jump ball, then the loser of
//      the tip starts the 2nd and 3rd), and timed: the game clock adds to exactly 12:00 a quarter and no possession
//      runs past the 24-second clock (14 after an offensive rebound). An overtime game is tied at the end of
//      regulation and each overtime holds exactly the points the sim gave it.
//   3. The rotation. Starters start each half; substitutions happen at timeouts. Minutes follow the model's projected
//      minutes, raised where a player's box needs more floor time; closers finish close games, the bench mops up
//      blowouts.
//   4. Who did what. Every event (each shot, trip, turnover, rebound, assist, block, steal and foul) is handed to a
//      player who is on the floor at that moment by a bipartite matching, so each player's totals are hit exactly.
//      If the rotation cannot fit a player's box, his minutes go up and the rotation is rebuilt.
//   5. The story: shot distances and kinds, the 24-second clock, win probability (state based: margin, time left and
//      the sim's own pre-game edge and spread), callouts and the plus-minus.
// verify(game) re-adds everything from the events alone and reports any mismatch (tools/verify_replay.js runs it).
//
// API (window.SimReplay):
//   SimReplay.context(G, RES, depth, opts) -> ctx   G and RES from Studio.simEngine (prep / run(...).done())
//   SimReplay.scenarios(ctx, legs) -> [{key, title, k, note}]   the chosen sim for each scenario
//   SimReplay.build(ctx, k) -> game | null           the play-by-play (events, possessions, box, win prob, callouts)
//   SimReplay.verify(game, ctx) -> [problems]        empty when the events reproduce the box and the sim exactly
//   SimReplay.boxAt(game, i), SimReplay.grade(leg, game, i), SimReplay.likes(ctx), SimReplay.cfg
(function () {
  'use strict';
  var SR = window.SimReplay = window.SimReplay || {};

  // ── seeded randomness (its own stream: never touches Play It Out's) ─────────────────────────────────
  function mulberry(seed) {
    var s = seed >>> 0;
    function r() { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    r.z = function () { var a = r(), b = r(); return Math.sqrt(-2 * Math.log(a + 1e-12)) * Math.cos(6.283185307179586 * b); };
    r.u = function (a, b) { return a + (b - a) * r(); };
    r.int = function (a, b) { return a + Math.floor(r() * (b - a + 1)); };
    r.pick = function (arr, w) {
      if (!arr.length) return null;
      if (!w) return arr[Math.floor(r() * arr.length)];
      var t = 0, i; for (i = 0; i < arr.length; i++) t += Math.max(0, w(arr[i], i));
      if (t <= 0) return arr[Math.floor(r() * arr.length)];
      var x = r() * t; for (i = 0; i < arr.length; i++) { x -= Math.max(0, w(arr[i], i)); if (x <= 0) return arr[i]; }
      return arr[arr.length - 1];
    };
    r.shuffle = function (a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
    return r;
  }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function nk(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, ''); }
  function lastName(n) { var p = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(' ') : p[0] || ''; }
  function shortName(n) { var p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p[0][0] + '. ' + lastName(n) : n; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function Phi(x) { var t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

  // ── the sports ────────────────────────────────────────────────────────────────────────────────────────────
  // per: period lengths (s); shot: shot clock; oreb: the reset after an offensive rebound; pfMax: the most fouls the
  // box ever gives a player (one under fouling out, so nobody fouls out); wins: timeout windows (elapsed seconds into
  // a period) where substitutions happen; start: the possession arrow after the tip ('J' jump winner, 'L' loser)
  var CFG = {
    nba: {per: [720, 720, 720, 720], ot: 300, shot: 24, oreb: 14, pfMax: 5, foulOut: 6, plabel: 'Q', starts: ['J', 'L', 'L', 'J'], half: 2,
          wins: [[150, 230], [330, 410], [510, 600]], otWins: [[140, 170]], roster: 12, hsDir: 'nba'},
    cbb: {per: [1200, 1200], ot: 300, shot: 30, oreb: 20, pfMax: 4, foulOut: 5, plabel: 'H', starts: ['J', 'L'], half: 1,
          wins: [[220, 260], [460, 500], [700, 740], [940, 980]], otWins: [[140, 170]], roster: 12, hsDir: 'mens-college-basketball'}
  };
  SR.cfg = CFG;
  function glen(C, nOT) { var s = 0; C.per.forEach(function (x) { s += x; }); return s + nOT * C.ot; }
  function periods(C, nOT) { var a = C.per.slice(); for (var i = 0; i < nOT; i++) a.push(C.ot); return a; }
  function perLabel(C, j) { return j < C.per.length ? C.plabel + (j + 1) : (j - C.per.length ? (j - C.per.length + 1) + 'OT' : 'OT'); }
  SR.perLabel = function (game, j) { return perLabel(CFG[game.sport] || CFG.nba, j); };

  // ── rosters: the model's depth chart (minutes, projections, starters) joined to Onyx's board players ──────
  function isBig(pos) { return /C|PF|FC/.test(String(pos || '')); }
  function posRank(pos) { var m = {PG: 1, G: 1.6, SG: 2, GF: 2.6, SF: 3, F: 3.5, PF: 4, FC: 4.4, C: 5}; return m[String(pos || '').toUpperCase()] || 3; }
  function buildRosters(ctx) {
    var G = ctx.G, C = ctx.C, out = {A: [], H: []}, sport = ctx.sport;
    ['A', 'H'].forEach(function (side) {
      var abbr = side === 'A' ? G.A : G.H, team = (ctx.depth || {})[abbr] || {}, list = [], seen = {};
      (team.players || []).forEach(function (p) {
        if (!p || !p.n || p.role === 'Out' || /^out/i.test(p.tag || '') || !(p.use >= 2.5)) return;
        var k = nk(p.n); if (seen[k]) return; seen[k] = 1;
        var hs = sport === 'nba' ? (p.hs ? 'https://a.espncdn.com/i/headshots/nba/players/full/' + p.hs + '.png' : null)
          : (p.hs && p.id ? 'https://a.espncdn.com/i/headshots/' + C.hsDir + '/players/full/' + p.id + '.png' : null);
        var pr = p.proj || {};
        list.push({id: side + ':' + k, k: k, side: side, abbr: abbr, name: p.n, pos: p.pos || '', role: p.role || '', min: +p.use || 0,
                   proj: {pts: +pr.pts || 0, reb: +pr.reb || 0, ast: +pr.ast || 0, tpm: +(pr['3pm'] || 0)}, hs: hs, bp: null});
      });
      // a board player the depth chart missed still plays (his minutes from the board)
      (G.plist || []).forEach(function (bp) {
        if (bp.team !== abbr || seen[bp.k]) return; seen[bp.k] = 1;
        list.push({id: side + ':' + bp.k, k: bp.k, side: side, abbr: abbr, name: bp.name, pos: '', role: '', min: bp.min || 20,
                   proj: {pts: bp.proj.pts || 8, reb: bp.proj.reb || 3, ast: bp.proj.ast || 2, tpm: 1}, hs: bp.hs ? 'https://a.espncdn.com/i/headshots/nba/players/full/' + bp.hs + '.png' : null, bp: null});
      });
      list.forEach(function (p) {
        var bp = (G.P || {})[p.k];
        if (bp && bp.team === abbr) {
          p.bp = bp; if (bp.min != null) p.min = bp.min;
          ['pts', 'reb', 'ast'].forEach(function (s) { if (bp.proj && bp.proj[s] != null) p.proj[s] = bp.proj[s]; });
          var th = bp.rows.filter(function (r) { return r.mkt === 'threes' && r.proj != null; })[0]; if (th) p.proj.tpm = th.proj;
          if (!p.hs && bp.hs) p.hs = 'https://a.espncdn.com/i/headshots/nba/players/full/' + bp.hs + '.png';
        }
      });
      list.sort(function (a, b) { return b.min - a.min; });
      list = list.slice(0, C.roster);
      var st = list.filter(function (p) { return /starter/i.test(p.role); }).slice(0, 5);
      list.forEach(function (p) { if (st.length < 5 && st.indexOf(p) < 0) st.push(p); });
      list.forEach(function (p) { p.starter = st.indexOf(p) >= 0; p.short = shortName(p.name); p.last = lastName(p.name); p.big = isBig(p.pos); p.rank = posRank(p.pos); });
      // starters first (by position), then the bench by minutes: the box score's order
      list.sort(function (a, b) { return (b.starter - a.starter) || (a.starter ? a.rank - b.rank : b.min - a.min); });
      out[side] = list;
    });
    return out;
  }

  // ctx: everything one game's replays share
  SR.context = function (G, RES, depth, o) {
    o = o || {};
    var sport = o.sport || 'nba', C = CFG[sport] || CFG.nba, Dr = RES && RES.draws;
    if (!G || !Dr) return null;
    var ctx = {G: G, RES: RES, Dr: Dr, depth: depth || {}, sport: sport, C: C, BMK: o.BMK, N: Dr.sa.length, gid: G.gid,
               mlChance: o.mlChance ? o.mlChance(G) : null};
    ctx.rost = buildRosters(ctx);
    if (ctx.rost.A.length < 8 || ctx.rost.H.length < 8) { ctx.err = 'Not enough of a roster on file for this game yet.'; return ctx; }
    ctx.byId = {}; ['A', 'H'].forEach(function (s) { ctx.rost[s].forEach(function (p) { ctx.byId[p.id] = p; }); });
    // the distribution: margin and total centers and spreads, from all 10,000 games
    var N = ctx.N, sa = Dr.sa, sh = Dr.sh, m = new Float64Array(N), t = new Float64Array(N), i, mu = 0, tu = 0, sm = 0, st = 0;
    for (i = 0; i < N; i++) { m[i] = sa[i] - sh[i]; t[i] = sa[i] + sh[i]; mu += m[i]; tu += t[i]; }
    mu /= N; tu /= N;
    for (i = 0; i < N; i++) { sm += (m[i] - mu) * (m[i] - mu); st += (t[i] - tu) * (t[i] - tu); }
    var ms = Array.prototype.slice.call(m).sort(function (a, b) { return a - b; }), ts = Array.prototype.slice.call(t).sort(function (a, b) { return a - b; });
    ctx.dist = {muM: mu, sdM: Math.sqrt(sm / N) || 12, medM: ms[N >> 1], muT: tu, sdT: Math.sqrt(st / N) || 18, medT: ts[N >> 1], winA: RES.winA};
    // the prop draws each board player carries (the numbers Play It Out graded his props on)
    // (a player with two lines in one market, a main and an alternate, has a draw for each: the main line's, the one
    // nearest his projection, is his number; the alternate's hit rate is still read from all 10,000 games)
    ctx.fixRows = {}; var near = {};
    (G.cont || []).forEach(function (c) {
      if (!c.pl) return; var m2 = c.row.mkt, y = Dr.ys[c.row.sel || c.row.label];
      if (!y || ['pts', 'reb', 'ast', 'threes'].indexOf(m2) < 0) return;
      var key = m2 === 'threes' ? 'tpm' : m2, gap = Math.abs((c.row.line || 0) - (c.row.proj != null ? c.row.proj : c.row.line || 0)), id = c.pl.k + '|' + key;
      if (near[id] != null && near[id] <= gap) return; near[id] = gap;
      (ctx.fixRows[c.pl.k] = ctx.fixRows[c.pl.k] || {})[key] = y;
      (ctx.fixRow = ctx.fixRow || {})[id] = c.row;
    });
    return ctx;
  };

  // ── 1. the box ─────────────────────────────────────────────────────────────────────────────────────────
  function sd(st, x) { x = Math.max(0.5, x); return st === 'pts' ? Math.max(2.5, 1.45 * Math.sqrt(x)) : st === 'reb' ? Math.max(1.2, 1.1 * Math.sqrt(x)) : Math.max(1, 1.05 * Math.sqrt(x)); }
  // each player's points, rebounds, assists and threes in sim k (null threes: not drawn by the sim)
  function simValues(ctx, k) {
    var Dr = ctx.Dr, r = mulberry(hash(ctx.gid + '|v|' + k)), out = {};
    ['A', 'H'].forEach(function (side) {
      ctx.rost[side].forEach(function (p) {
        var v = {pts: null, reb: null, ast: null, tpm: null, fix: {}}, bp = p.bp, fr = bp ? ctx.fixRows[bp.k] || {} : {};
        ['pts', 'reb', 'ast', 'tpm'].forEach(function (s) { if (fr[s]) { v[s] = fr[s][k]; v.fix[s] = 1; } });
        if (bp && Dr.PL[bp.idx]) {
          var L = Dr.PL[bp.idx], cm = (Dr.X.comp || {})[bp.k] || {pts: 1, reb: 1, ast: 1}, pace = Dr.X.pace || 1;
          ['pts', 'reb', 'ast'].forEach(function (s) { if (v[s] == null) { var pr = (p.proj[s] || 0) * cm[s] * pace; v[s] = Math.max(0, Math.round(pr + sd(s, pr) * L[s][k])); } });
        } else {
          ['pts', 'reb', 'ast'].forEach(function (s) { if (v[s] == null) { var pr = p.proj[s] || 0; v[s] = Math.max(0, Math.round(pr + sd(s, pr) * 0.8 * r.z())); } });
        }
        out[p.id] = v;
      });
    });
    return out;
  }
  // a quick read of how naturally sim k's numbers fit together (for picking scenario games): 0 is perfect
  function strain(ctx, k) {
    var Dr = ctx.Dr, s = 0;
    ['A', 'H'].forEach(function (side) {
      var S = side === 'A' ? Dr.sa[k] : Dr.sh[k], fixed = 0, flex = 0;
      ctx.rost[side].forEach(function (p) {
        var fr = p.bp ? ctx.fixRows[p.bp.k] || {} : {};
        if (fr.pts) { fixed += fr.pts[k]; if (fr.tpm && 3 * fr.tpm[k] > fr.pts[k]) s += 50; } else flex += p.proj.pts || 0;
      });
      var R = S - fixed;
      if (R < 0) s += 100; else if (flex > 0) { var q = R / flex; s += q < 0.45 ? (0.45 - q) * 20 : q > 1.9 ? (q - 1.9) * 8 : 0; } else if (R !== 0) s += 100;
    });
    return s;
  }
  SR.strain = strain;

  function largestRemainder(total, weights, r) {
    var W = 0, n = weights.length, out = [], rem = [], i, given = 0;
    for (i = 0; i < n; i++) W += Math.max(0, weights[i]);
    if (total <= 0 || n === 0) { for (i = 0; i < n; i++) out.push(0); return out; }
    if (W <= 0) { weights = weights.map(function () { return 1; }); W = n; }
    for (i = 0; i < n; i++) { var x = total * Math.max(0, weights[i]) / W; out.push(Math.floor(x)); given += out[i]; rem.push([x - out[i] + (r ? r() * 0.35 : 0), i]); }
    rem.sort(function (a, b) { return b[0] - a[0]; });
    for (i = 0; given < total; i++, given++) out[rem[i % n][1]]++;
    return out;
  }
  // spread `total` across players with weights, never more than cap[i] each
  function spreadCapped(total, w, cap, r) {
    var out = w.map(function () { return 0; }), left = total, guard = 0;
    while (left > 0 && guard++ < 1000) {
      var idx = [], ww = [];
      w.forEach(function (x, i) { if (out[i] < cap[i]) { idx.push(i); ww.push(Math.max(0.01, x)); } });
      if (!idx.length) break;
      var i0 = r.pick(idx, function (_, j) { return ww[j]; }); out[i0]++; left--;
    }
    return out;
  }

  function buildBox(ctx, k, r) {
    var Dr = ctx.Dr, C = ctx.C, vals = simValues(ctx, k), nOT = Dr.ot[k], gmin = glen(C, nOT) / 60;
    var B = {}, T = {A: {}, H: {}}, issues = [];
    var score = {A: Dr.sa[k], H: Dr.sh[k]};
    ['A', 'H'].forEach(function (side) {
      var R = ctx.rost[side], S = score[side], fixed = 0, flex = [];
      R.forEach(function (p) { var v = vals[p.id]; if (v.fix.pts) fixed += v.pts; else flex.push(p); });
      var rest = S - fixed;
      if (rest < 0) { issues.push(side + ' players with Onyx points props drew more than the team scored'); return; }
      if (!flex.length && rest !== 0) { issues.push('no one left to score the rest'); return; }
      var cur = 0; flex.forEach(function (p) { cur += vals[p.id].pts; });
      var guard = 0;
      while (cur < rest && guard++ < 400) { var a = r.pick(flex, function (p) { return (p.proj.pts + 0.6) * Math.max(0.2, p.min / 30); }); vals[a.id].pts++; cur++; }
      while (cur > rest && guard++ < 800) { var b = r.pick(flex.filter(function (p) { return vals[p.id].pts > 0; }), function (p) { return vals[p.id].pts; }); vals[b.id].pts--; cur--; }
      if (cur !== rest) issues.push('could not reconcile points');
      // assists: never more than the team's made shots allow (filled after shots are known, below)
      R.forEach(function (p) {
        var v = vals[p.id], pts = v.pts, tpm;
        if (v.fix.tpm) { tpm = v.tpm; if (3 * tpm > pts) { issues.push(p.name + ' drew more threes than points allow'); tpm = Math.floor(pts / 3); } }
        else {
          var e3 = (p.proj.tpm || 0) * (pts / Math.max(1, p.proj.pts || 1));
          tpm = clamp(Math.round(e3 + 0.7 * Math.sqrt(Math.max(0.05, e3)) * r.z()), 0, Math.floor(pts / 3));
        }
        var rem = pts - 3 * tpm, fs = p.big ? 0.2 : 0.15 + (p.proj.pts > 20 ? 0.05 : 0);
        var ftm = clamp(Math.round(pts * fs + Math.sqrt(Math.max(0.1, pts * fs)) * 0.9 * r.z()), 0, rem);
        if ((rem - ftm) % 2) { if (ftm > 0 && r() < 0.5) ftm--; else ftm++; }
        var fgm2 = (rem - ftm) / 2, fgm = fgm2 + tpm;
        // free throws: misses at a ~77% line, then the trips: and-ones, 2-shot trips, a rare 3-shot trip
        var ftPct = p.big ? 0.7 : 0.8, fta = ftm + Math.max(0, Math.round(ftm * (1 / ftPct - 1) + 0.6 * r.z()));
        if (ftm === 0 && r() < 0.08 * Math.min(1, p.min / 25)) fta += 2;
        var and1 = 0; if (fgm >= 2 && fta >= 1) and1 = r() < 0.35 * Math.min(1, fgm / 6) ? 1 : 0; if (and1 && fgm >= 6 && fta >= 3 && r() < 0.25) and1 = 2;
        var rest2 = fta - and1, three = 0;
        if (rest2 % 2) { if (rest2 >= 3 && tpm > 0 && r() < 0.6) { three = 1; rest2 -= 3; } else if (and1 < fgm && and1 < 3) { and1++; rest2--; } else { fta++; rest2++; } }
        if (rest2 < 0) { fta -= rest2; rest2 = 0; }
        var trips = [], i;
        for (i = 0; i < and1; i++) trips.push({s: 1, and1: 1});
        for (i = 0; i < rest2 / 2; i++) trips.push({s: 2});
        if (three) trips.push({s: 3});
        // made free throws across the trips
        var slots = []; trips.forEach(function (t, ti) { for (var q = 0; q < t.s; q++) slots.push(ti); });
        r.shuffle(slots); trips.forEach(function (t) { t.m = 0; });
        for (i = 0; i < ftm; i++) trips[slots[i]].m++;
        trips.forEach(function (t) { t.lastMiss = t.m === 0 ? true : t.m === t.s ? false : r() < (t.s - t.m) / t.s; });
        // the and-ones ride on made shots: a three or a two
        var a1 = trips.filter(function (t) { return t.and1; }), a2 = 0, a3 = 0;
        a1.forEach(function (t) { if (fgm2 - a2 > 0 && (tpm - a3 <= 0 || r() > 0.12)) { t.fg = 2; a2++; } else { t.fg = 3; a3++; } });
        if (a2 > fgm2 || a3 > tpm) issues.push('and-ones exceed made shots');
        B[p.id] = {pts: pts, fgm: fgm, fgm2: fgm2, tpm: tpm, ftm: ftm, fta: fta, trips: trips, a2: a2, a3: a3, reb: v.reb, ast: v.ast, fix: v.fix,
                   oreb: 0, dreb: 0, miss2: 0, miss3: 0, to: 0, stl: 0, blk: 0, pf: 0};
      });
      // offensive / defensive rebounds
      R.forEach(function (p) {
        var b = B[p.id]; if (!b) return; var orate = p.big ? 0.3 : 0.17, o = 0;
        for (var i = 0; i < b.reb; i++) if (r() < orate) o++;
        b.oreb = o; b.dreb = b.reb - o;
      });
    });
    if (issues.length) return {ok: false, issues: issues};
    // team totals
    ['A', 'H'].forEach(function (side) {
      var t = T[side] = {fgm: 0, fgm2: 0, tpm: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ftlm: 0, trips: 0, and1: 0, ast: 0};
      ctx.rost[side].forEach(function (p) {
        var b = B[p.id]; t.fgm += b.fgm; t.fgm2 += b.fgm2; t.tpm += b.tpm; t.ftm += b.ftm; t.fta += b.fta; t.oreb += b.oreb; t.dreb += b.dreb; t.ast += b.ast;
        b.trips.forEach(function (x) { if (x.lastMiss) t.ftlm++; if (x.and1) t.and1++; else t.trips++; });
      });
    });
    // assists: never more than the made shots of his teammates, and the team's within its made shots
    ['A', 'H'].forEach(function (side) {
      var t = T[side], R = ctx.rost[side];
      R.forEach(function (p) {
        var b = B[p.id], cap = t.fgm - b.fgm;
        if (b.ast > cap) { if (b.fix.ast) issues.push(p.name + ' drew more assists than his teammates made shots'); t.ast -= b.ast - Math.max(0, cap); b.ast = Math.max(0, cap); }
      });
      var limit = Math.floor(t.fgm * 0.92), guard = 0;
      while (t.ast > limit && guard++ < 200) {
        var flex = R.filter(function (p) { return !B[p.id].fix.ast && B[p.id].ast > 0; });
        if (!flex.length) { if (t.ast > t.fgm) issues.push('assists exceed made shots'); break; }
        var q = r.pick(flex, function (p) { return B[p.id].ast; }); B[q.id].ast--; t.ast--;
      }
    });
    if (issues.length) return {ok: false, issues: issues};
    // misses: every rebound needs a miss to come off. A team's rebound-able misses = its own offensive rebounds + the
    // other team's defensive rebounds + team rebounds (out of bounds, end of a quarter)
    var other = {A: 'H', H: 'A'};
    ['A', 'H'].forEach(function (side) {
      var t = T[side], o = T[other[side]];
      var fga = Math.round(t.fgm / r.u(0.44, 0.51));
      var tr = clamp(fga - t.fgm + t.ftlm - t.oreb - o.dreb, 1, 9);
      var miss = t.oreb + o.dreb + tr - t.ftlm;
      if (miss < 0) { tr -= miss; miss = 0; }
      t.tr = tr; t.miss = miss;
    });
    // turnovers: set so the possession count matches the sim's pace for this game; then balanced so the two teams'
    // possessions differ by at most one (they alternate). A possession = its attempts minus the offensive rebounds
    // that kept it alive plus its turnovers; when turnovers hit their bounds, a team rebound (one more miss) moves it
    var target = Dr.poss * (Dr.fp[k] || 1) * glen(C, nOT) / glen(C, 0);
    var poss = {}, pc = function (t) { return t.fgm + t.trips + t.miss - t.oreb + t.to; };
    ['A', 'H'].forEach(function (side) {
      var t = T[side];
      t.to = clamp(Math.round(target + 0.8 * r.z() - (t.fgm + t.trips + t.miss - t.oreb)), 6, 21);
      poss[side] = pc(t);
    });
    var guard = 0;
    while (Math.abs(poss.A - poss.H) > 1 && guard++ < 200) {
      var hi = poss.A > poss.H ? 'A' : 'H', lo = other[hi], th = T[hi], tl = T[lo], u = r();
      if (u < 0.5 && th.to > 5) th.to--;
      else if (tl.to < 22) tl.to++;
      else if (th.tr > 0 && th.miss > 0) { th.tr--; th.miss--; }
      else if (tl.tr < 14) { tl.tr++; tl.miss++; }
      else if (th.to > 2) th.to--;
      poss.A = pc(T.A); poss.H = pc(T.H);
    }
    if (Math.abs(poss.A - poss.H) > 1) return {ok: false, issues: ['possessions could not be balanced']};
    // a sim whose box only fits at a pace far off the sim's own (lopsided blowouts) is skipped; the picker takes the next
    if (Math.abs(poss.A - target) > 7 || Math.abs(poss.H - target) > 7) return {ok: false, issues: ['pace off the sim by ' + Math.round(Math.max(Math.abs(poss.A - target), Math.abs(poss.H - target))) + ' possessions']};
    T.A.poss = poss.A; T.H.poss = poss.H;
    // misses: threes vs twos, by who shoots them
    ['A', 'H'].forEach(function (side) {
      var t = T[side], miss = t.miss;
      var R = ctx.rost[side], w3 = R.map(function (p) { var b = B[p.id]; return 1.75 * b.tpm + 0.9 * (p.proj.tpm || 0) * Math.min(1.2, p.min / 32) + 0.05; });
      var w2 = R.map(function (p) { var b = B[p.id]; return 1.05 * b.fgm2 + 0.28 * p.min / 10 + 0.05; });
      var s3 = 0, s2 = 0; w3.forEach(function (x) { s3 += x; }); w2.forEach(function (x) { s2 += x; });
      var m3 = clamp(Math.round(miss * s3 / (s3 + s2) + 1.5 * r.z()), 0, miss), m2 = miss - m3;
      var d3 = largestRemainder(m3, w3, r), d2 = largestRemainder(m2, w2, r);
      R.forEach(function (p, i) { B[p.id].miss3 = d3[i]; B[p.id].miss2 = d2[i]; });
      t.miss2 = m2; t.miss3 = m3;
    });
    // per-player turnovers, steals, blocks and fouls
    ['A', 'H'].forEach(function (side) {
      var t = T[side], o = T[other[side]], R = ctx.rost[side], i;
      var tw = R.map(function (p) { return Math.max(0.1, p.min / 36) * (0.35 + 0.09 * (p.proj.pts || 0) + 0.3 * (p.proj.ast || 0)); });
      var to = spreadCapped(t.to, tw, R.map(function () { return 8; }), r); R.forEach(function (p, i2) { B[p.id].to = to[i2]; });
      var stl = clamp(Math.round(7.5 * Math.sqrt(o.to / 13) + 2 * r.z()), Math.min(2, o.to), Math.max(Math.min(2, o.to), o.to - 2));
      var sw = R.map(function (p) { return Math.max(0.1, p.min / 36) * (1 + 0.12 * (p.proj.ast || 0)); });
      var sv = spreadCapped(stl, sw, R.map(function () { return 5; }), r); R.forEach(function (p, i2) { B[p.id].stl = sv[i2]; });
      t.stl = stl;
      var blk = clamp(Math.round(5 + 2 * r.z()), 0, Math.floor(o.miss2 * 0.3));
      var bw = R.map(function (p) { return Math.max(0.1, p.min / 36) * (p.big ? 1.6 : 0.35) * (0.6 + (p.proj.reb || 0) / 8); });
      var bv = spreadCapped(blk, bw, R.map(function () { return 6; }), r); R.forEach(function (p, i2) { B[p.id].blk = bv[i2]; });
      t.blk = blk;
      // fouls: one for every trip the other team shot (and-ones included) plus the non-shooting ones
      var shoot = o.trips + o.and1, ns = clamp(Math.round(6.5 + 2 * r.z()), 2, 12), cap = R.map(function () { return C.pfMax; });
      var fw = R.map(function (p) { return Math.max(0.08, p.min / 36) * (p.big ? 1.35 : 1); });
      var tot = shoot + ns, capSum = 0; cap.forEach(function (c) { capSum += c; });
      if (tot > capSum) { ns = Math.max(0, capSum - shoot); tot = shoot + ns; }
      var fv = spreadCapped(tot, fw, cap, r), given = 0; fv.forEach(function (x) { given += x; });
      if (given < shoot) { issues.push('fouls do not fit'); }
      R.forEach(function (p, i2) { B[p.id].pf = fv[i2]; });
      t.ns = given - shoot; t.shoot = shoot;
      for (i = 0; i < R.length; i++) { var b = B[R[i].id]; b.fga = b.fgm + b.miss2 + b.miss3; b.tpa = b.tpm + b.miss3; }
    });
    if (issues.length) return {ok: false, issues: issues};
    return {ok: true, B: B, T: T, nOT: nOT, score: score};
  }

  // ── bipartite matching with capacities: each slot to one allowed player, each player exactly his count ──
  function match(slots, cap, r) {
    // slots: [{allow: [ids]}]; cap: {id: count}; returns {ok, who: [id per slot], short: {id: unmet}}
    var who = new Array(slots.length), used = {}, bySlotOwner = {};
    Object.keys(cap).forEach(function (id) { used[id] = 0; bySlotOwner[id] = []; });
    var order = r.shuffle(slots.map(function (_, i) { return i; }));
    order.sort(function (a, b) { return slots[a].allow.length - slots[b].allow.length; });
    function tryAssign(s, seen) {
      var al = r.shuffle(slots[s].allow.filter(function (p) { return cap[p] > 0 && !seen[p]; }));
      // prefer the players with the most left to give (spreads them through the game)
      al.sort(function (a, b) { return (cap[b] - used[b]) - (cap[a] - used[a]); });
      for (var i = 0; i < al.length; i++) { var p = al[i]; if (used[p] < cap[p]) { who[s] = p; used[p]++; bySlotOwner[p].push(s); return true; } }
      // all full: move one of a player's slots to someone else, then he takes this one
      for (i = 0; i < al.length; i++) {
        p = al[i]; if (seen[p]) continue; seen[p] = 1;
        var owned = bySlotOwner[p].slice();
        for (var j = 0; j < owned.length; j++) {
          var s2 = owned[j];
          if (tryAssign(s2, seen)) { var L = bySlotOwner[p]; L.splice(L.indexOf(s2), 1); L.push(s); who[s] = p; return true; }
        }
      }
      return false;
    }
    var ok = true;
    for (var q = 0; q < order.length; q++) if (!tryAssign(order[q], {})) ok = false;
    var short = {};
    Object.keys(cap).forEach(function (id) { if (used[id] < cap[id]) short[id] = cap[id] - used[id]; });
    if (Object.keys(short).length) ok = false;
    return {ok: ok, who: who, short: short};
  }

  // ── 2. possessions ─────────────────────────────────────────────────────────────────────────────────────
  // a team's attempts: made shots (with and-ones), trips, misses and turnovers, each with what follows it
  // the type fields of an attempt (what a player's box is made of)
  var TYF = ['k', 'fg', 'made', 'and1', 's', 'm', 'lastMiss'];
  function rbl(a) { return (a.k === 'fg' && !a.made) || (a.k === 'ft' && a.lastMiss) || !!(a.and1 && a.and1.lastMiss); }
  function attempts(ctx, bx, side, r) {
    var t = bx.T[side], o = bx.T[side === 'A' ? 'H' : 'A'], list = [], R = ctx.rost[side];
    R.forEach(function (p) {
      var b = bx.B[p.id], i, add = function (a) { a.pid0 = p.id; list.push(a); };
      var a2 = b.trips.filter(function (x) { return x.and1 && x.fg === 2; }), a3 = b.trips.filter(function (x) { return x.and1 && x.fg === 3; });
      for (i = 0; i < b.fgm2 - a2.length; i++) add({k: 'fg', fg: 2, made: 1});
      for (i = 0; i < b.tpm - a3.length; i++) add({k: 'fg', fg: 3, made: 1});
      a2.concat(a3).forEach(function (x) { add({k: 'fg', fg: x.fg, made: 1, and1: {m: x.m, lastMiss: x.lastMiss}}); });
      b.trips.forEach(function (x) { if (!x.and1) add({k: 'ft', s: x.s, m: x.m, lastMiss: x.lastMiss}); });
      for (i = 0; i < b.miss2; i++) add({k: 'fg', fg: 2, made: 0});
      for (i = 0; i < b.miss3; i++) add({k: 'fg', fg: 3, made: 0});
      for (i = 0; i < b.to; i++) add({k: 'to'});
    });
    // rebounds off the rebound-able misses: exactly his team's offensive boards, the other's defensive, team boards
    var rb = list.filter(rbl);
    r.shuffle(rb);
    var need = [t.oreb, o.dreb, t.tr];
    if (rb.length !== need[0] + need[1] + need[2]) return null;
    rb.forEach(function (a, i2) { a.reb = i2 < need[0] ? 'O' : i2 < need[0] + need[1] ? 'D' : 'T'; });
    // its class: what the possession needs from it (points, and whether a rebound follows). Any of a player's attempts
    // in the same class can fill the slot, so the matching below has room: a made two and a 2-for-2 trip both end a
    // possession with 2 points
    list.forEach(function (a) {
      a.cls = a.k === 'to' ? 'to' : pts(a) + (rbl(a) ? 'r' : 't');
      var ty = {}; TYF.forEach(function (f) { if (a[f] != null) ty[f] = a[f]; }); a.ty = ty;
    });
    return list;
  }
  function pts(a) { return a.k === 'fg' ? (a.made ? a.fg : 0) + (a.and1 ? a.and1.m : 0) : a.k === 'ft' ? a.m : 0; }
  function chains(list, r) {
    r.shuffle(list);
    // the last attempt must end its possession
    var cont = function (a) { return a.reb === 'O'; };
    if (list.length && cont(list[list.length - 1])) {
      for (var i = list.length - 2; i >= 0; i--) if (!cont(list[i])) { var t = list[i]; list[i] = list[list.length - 1]; list[list.length - 1] = t; break; }
    }
    var out = [], cur = [];
    list.forEach(function (a) { cur.push(a); if (!cont(a)) { out.push(cur); cur = []; } });
    if (cur.length) out.push(cur);
    return out.map(function (c) { var s = 0; c.forEach(function (a) { s += pts(a); }); return {att: c, pts: s}; });
  }
  // pick `cnt` possessions summing to exactly `want` points (dynamic programming over points and count)
  function pickExact(pool, cnt, want, r) {
    var n = pool.length, i, c, s;
    var idx = r.shuffle(pool.map(function (_, j) { return j; }));
    // reachable[i][c][s]: using the first i (shuffled) possessions
    var W = want + 1, reach = [new Uint8Array((cnt + 1) * W)]; reach[0][0] = 1;
    for (i = 0; i < n; i++) {
      var prev = reach[i], nxt = new Uint8Array(prev), v = pool[idx[i]].pts;
      for (c = 0; c < cnt; c++) for (s = 0; s + v < W; s++) if (prev[c * W + s]) nxt[(c + 1) * W + s + v] = 1;
      reach.push(nxt);
    }
    if (!reach[n][cnt * W + want]) return null;
    var out = []; c = cnt; s = want;
    for (i = n; i > 0 && c > 0; i--) {
      var v2 = pool[idx[i - 1]].pts;
      if (s - v2 >= 0 && reach[i - 1][(c - 1) * W + s - v2]) { out.push(idx[i - 1]); c--; s -= v2; }
    }
    return c === 0 && s === 0 ? out : null;
  }

  // ── the whole game ────────────────────────────────────────────────────────────────────────────────────
  SR.build = function (ctx, k, opt) {
    opt = opt || {};
    if (!ctx || ctx.err) return null;
    for (var tryN = 0; tryN < 6; tryN++) {
      var r = mulberry(hash(ctx.gid + '|' + k + '|' + tryN));
      var g = buildOnce(ctx, k, r);
      if (g && g.ok) { g.tries = tryN + 1; return g; }
      if (g && g.fatal) return g;
    }
    return {ok: false, why: (g && g.why) || 'could not lay this game out'};
  };

  function buildOnce(ctx, k, r) {
    var C = ctx.C, Dr = ctx.Dr;
    var bx = buildBox(ctx, k, r);
    if (!bx.ok) return {ok: false, fatal: true, why: bx.issues.join('; ')};
    var nOT = bx.nOT, PER = periods(C, nOT), nP = PER.length, other = {A: 'H', H: 'A'};
    // each team's possessions
    var poss = {};
    for (var s0 = 0; s0 < 2; s0++) {
      var side = s0 ? 'H' : 'A', at = attempts(ctx, bx, side, r);
      if (!at) return {ok: false, why: 'rebounds do not add up'};
      poss[side] = chains(at, r);
    }
    if (Math.abs(poss.A.length - poss.H.length) > 1) return {ok: false, why: 'possessions differ by ' + Math.abs(poss.A.length - poss.H.length) + ' (' + poss.A.length + '/' + bx.T.A.poss + ' ' + poss.H.length + '/' + bx.T.H.poss + ' to ' + bx.T.A.to + ',' + bx.T.H.to + ')'};
    // who starts each period: the tip (the jump winner leans to the better rebounding center), then the arrow
    var jump = r() < 0.5 ? 'A' : 'H', starts = [];
    for (var j = 0; j < nP; j++) starts.push(j < C.starts.length ? (C.starts[j] === 'J' ? jump : other[jump]) : (r() < 0.5 ? 'A' : 'H'));
    // overtime: each one holds exactly the points the sim gave it, and regulation ends tied
    var per = {A: [], H: []}, poolA = poss.A.slice(), poolH = poss.H.slice();
    var otPts = [];
    for (var o = 0; o < nOT; o++) otPts.push({A: Dr.otp[k * 14 + 2 * o], H: Dr.otp[k * 14 + 2 * o + 1]});
    if (nOT && Dr.otp[k * 14 + 12]) { var wn = Dr.otp[k * 14 + 12] === 1 ? 'A' : 'H'; otPts[nOT - 1][wn] += 1; }   // the sim's coin-flip point after six overtimes
    var otCount = Math.max(4, Math.round((poss.A.length + poss.H.length) / 2 * C.ot / glen(C, 0)));
    for (o = nOT - 1; o >= 0; o--) {
      var jj = C.per.length + o, st = starts[jj], done = null;
      var tries = [[0, 0], [0, -1], [1, 0], [-1, -1], [1, 1], [-1, -2], [2, 1], [-2, -2], [2, 2]];
      for (var q = 0; q < tries.length && !done; q++) {
        var cs = otCount + tries[q][0], co = otCount + tries[q][1];
        if (co > cs || cs - co > 1 || co < 2) continue;
        var cA = st === 'A' ? cs : co, cH = st === 'A' ? co : cs;
        var pa = pickExact(poolA, cA, otPts[o].A, r), ph = pa && pickExact(poolH, cH, otPts[o].H, r);
        if (pa && ph) done = [pa, ph];
      }
      if (!done) return {ok: false, why: 'overtime points could not be placed'};
      per.A[jj] = done[0].map(function (i) { return poolA[i]; }); per.H[jj] = done[1].map(function (i) { return poolH[i]; });
      poolA = poolA.filter(function (_, i) { return done[0].indexOf(i) < 0; }); poolH = poolH.filter(function (_, i) { return done[1].indexOf(i) < 0; });
    }
    // regulation: possession counts per period, alternating from each period's starter
    var nR = C.per.length, RA = poolA.length, RH = poolH.length, Dd = RH - RA;
    var dlt = []; for (j = 0; j < nR; j++) dlt.push(starts[j] === 'A' ? -1 : 1);   // H - A in a period with an odd count
    var odd = null;
    (function find() {
      var n = 1 << nR;
      var order = r.shuffle(Array.apply(null, Array(n)).map(function (_, i) { return i; }));
      for (var x = 0; x < order.length; x++) { var m = order[x], s = 0; for (var b = 0; b < nR; b++) if (m & (1 << b)) s += dlt[b]; if (s === Dd) { odd = m; return; } }
    })();
    if (odd == null) return {ok: false, why: 'possession arrow cannot fit'};
    // a counts: near-even split of RA with noise; h counts follow
    var aC = largestRemainder(RA, C.per.map(function () { return 1 + 0.06 * r.z(); }), r), hC = [];
    for (j = 0; j < nR; j++) hC.push(aC[j] + ((odd & (1 << j)) ? dlt[j] : 0));
    var sumH = 0; hC.forEach(function (x) { sumH += x; });
    if (sumH !== RH || hC.some(function (x) { return x < 1; })) return {ok: false, why: 'regulation counts'};
    r.shuffle(poolA); r.shuffle(poolH);
    var ia = 0, ih = 0;
    for (j = 0; j < nR; j++) { per.A[j] = poolA.slice(ia, ia + aC[j]); ia += aC[j]; per.H[j] = poolH.slice(ih, ih + hC[j]); ih += hC[j]; }
    // the sequence and the clock
    var seq = [], tBase = 0;
    for (j = 0; j < nP; j++) {
      var L = PER[j], first = starts[j], qa = per[first][j].slice(), qb = per[other[first]][j].slice(), list = [];
      while (qa.length || qb.length) { if (qa.length) list.push({team: first, c: qa.shift()}); if (qb.length) list.push({team: other[first], c: qb.shift()}); }
      // raw durations: each attempt a stretch of the shot clock
      var raw = [], tot = 0, prevEnd = 'start';
      list.forEach(function (ps) {
        var d = [];
        ps.c.att.forEach(function (a, ai) {
          var x;
          if (ai === 0) x = prevEnd === 'live' && r() < 0.28 ? r.u(2.5, 7) : r.u(7.5, 19.5);
          else x = r() < 0.4 ? r.u(0.8, 3) : r.u(3, 10.5);
          d.push(x); tot += x;
        });
        var last = ps.c.att[ps.c.att.length - 1];
        prevEnd = (last.k === 'fg' && !last.made) || last.k === 'to' ? 'live' : 'dead';
        raw.push(d);
      });
      var pad = r.u(0.5, 5), f = (L - pad) / tot;
      // scale to the period, keep each stretch under the shot clock (24, or 14 after an offensive rebound)
      for (var it = 0; it < 6; it++) {
        var over = 0, room = 0;
        raw.forEach(function (d) { d.forEach(function (x, ai) { var cap = ai === 0 ? C.shot - 0.6 : C.oreb - 0.6; if (x * f > cap) over += x * f - cap; else room += cap - x * f; }); });
        if (over < 0.05) break;
        raw.forEach(function (d) { d.forEach(function (x, ai) { var cap = ai === 0 ? C.shot - 0.6 : C.oreb - 0.6; d[ai] = x * f > cap ? cap / f : x * (1 + over / Math.max(1, room)); }); });
        tot = 0; raw.forEach(function (d) { d.forEach(function (x) { tot += x; }); }); f = (L - pad) / tot;
      }
      var t = 0;
      list.forEach(function (ps, pi) {
        var P = {team: ps.team, per: j, att: ps.c.att.map(function (a) { return Object.assign({}, a); }), pts: ps.c.pts};
        P.t0 = tBase + t;
        P.att.forEach(function (a, ai) {
          a.t0 = tBase + t; t += raw[pi][ai] * f; a.t1 = tBase + Math.min(L - 0.05, t);
          a.t0 = Math.round(a.t0 * 10) / 10; a.t1 = Math.max(a.t0, Math.round(a.t1 * 10) / 10);
        });
        P.t0 = P.att[0].t0; P.t1 = P.att[P.att.length - 1].t1;
        seq.push(P);
      });
      tBase += L;
    }
    // margins along the way (for closers and garbage time)
    var sa = 0, sh = 0;
    seq.forEach(function (P) { if (P.team === 'A') sa += P.pts; else sh += P.pts; P.after = {A: sa, H: sh}; });
    if (sa !== bx.score.A || sh !== bx.score.H) return {ok: false, fatal: true, why: 'score mismatch ' + sa + '-' + sh};
    // the other team's non-shooting fouls happen while this team has the ball (who: matched later)
    ['A', 'H'].forEach(function (side) {
      var o = bx.T[other[side]], mine = seq.filter(function (P) { return P.team === side; });
      for (var i = 0; i < o.ns; i++) { var P = r.pick(mine); (P.nsf = P.nsf || []).push({t: r.u(P.t0, P.t1), P: P}); }
    });
    // ── 3. rotation, 4. who did what ──
    var plan = rotationPlan(ctx, bx, seq, PER, r);
    var res = null, lu = null, boosts = 0;
    for (var round = 0; round < 60; round++) {
      if (!lu) lu = lineups(ctx, plan, seq, PER, nOT, r);
      res = assign(ctx, bx, seq, lu, r);
      if (res.ok) break;
      // first move the possession to where he is on the floor; failing that, more floor time for him
      if (round % 6 !== 5 && repair(seq, res.fails, C.per.length, r)) continue;
      Object.keys(res.short).forEach(function (id) { if (plan.base[id] == null) return; plan.need[id] = Math.min(Math.max(plan.base[id] + 12, plan.need[id] || 0), Math.min(plan.gmin * 0.86, (plan.need[id] || 0) + 3 + 2 * boosts)); });
      boosts++; lu = null;
    }
    if (!res || !res.ok) return {ok: false, why: 'rotation could not fit ' + Object.keys((res || {}).short || {}).map(function (id) { return (ctx.byId[id] || {}).name || id; }).join(', ')};
    return story(ctx, k, bx, seq, lu, PER, nOT, starts, r);
  }

  // target minutes: the model's projection, raised where the box needs more floor time
  function rotationPlan(ctx, bx, seq, PER, r) {
    var need = {}, base = {}, gmin = 0; PER.forEach(function (x) { gmin += x / 60; });
    ['A', 'H'].forEach(function (side) {
      var R = ctx.rost[side], counts = {};
      // the team's totals of each kind of event, and each player's share
      var kinds = ['pts', 'fga', 'reb', 'ast', 'to', 'stl', 'blk', 'pf', 'fta'];
      kinds.forEach(function (x) { counts[x] = 0; R.forEach(function (p) { counts[x] += bx.B[p.id][x]; }); });
      R.forEach(function (p) {
        var b = bx.B[p.id], sh = 0;
        // the share of the game he must be out there for his events to fit, with a little slack per kind
        kinds.forEach(function (x) { if (counts[x] > 0 && b[x] > 0) sh = Math.max(sh, (b[x] - 1.5) / counts[x]); });
        var any = kinds.some(function (x) { return b[x] > 0; });
        need[p.id] = Math.min(gmin * 0.8, Math.max(0, sh) * gmin * 1.15 + (any ? 3 : 0));
        base[p.id] = p.min * (gmin / 48) * (1 + 0.04 * r.z());
      });
    });
    return {need: need, base: base, gmin: gmin};
  }
  // windows: substitution points (period starts, timeouts), the five on the floor for each
  function lineups(ctx, plan, seq, PER, nOT, r) {
    var C = ctx.C, gsec = 0; PER.forEach(function (x) { gsec += x; });
    var bounds = [];   // possession indices where a window starts
    var tStart = 0, nReg = C.per.length;
    PER.forEach(function (L, j) {
      var ps = []; seq.forEach(function (P, i) { if (P.per === j) ps.push(i); });
      if (!ps.length) return;
      bounds.push({i: ps[0], per: j, start: true});
      (j < nReg ? C.wins : C.otWins).forEach(function (w) {
        var th = tStart + r.u(w[0], w[1]);
        for (var q = 0; q < ps.length; q++) { var P = seq[ps[q]]; if (P.t0 >= th && q > 0) { if (bounds[bounds.length - 1].i !== ps[q]) bounds.push({i: ps[q], per: j, timeout: true}); break; } }
      });
      tStart += L;
    });
    var out = {A: [], H: []}, wins = bounds.map(function (b, wi) {
      var nx = bounds[wi + 1], t0 = seq[b.i].t0, end = nx ? seq[nx.i].t0 : gsec;
      // a period's first window starts at the period start, its last ends at the period end
      if (b.start) { var s = 0; for (var j = 0; j < b.per; j++) s += PER[j]; t0 = s; }
      if (!nx || nx.per !== b.per) { var e = 0; for (j = 0; j <= b.per; j++) e += PER[j]; end = e; }
      return {i: b.i, per: b.per, start: !!b.start, timeout: !!b.timeout, t0: t0, t1: end};
    });
    ['A', 'H'].forEach(function (side) {
      var R = ctx.rost[side], played = {}, tgt = {}, total = 5 * gsec / 60;
      // targets: his projected minutes, never under what his box needs; the extra comes out of the others' slack
      R.forEach(function (p) { played[p.id] = 0; tgt[p.id] = Math.min(plan.gmin * 0.86, Math.max(plan.base[p.id], plan.need[p.id] || 0)); });
      for (var it = 0; it < 4; it++) {
        var sumT = 0, slack = 0; R.forEach(function (p) { sumT += tgt[p.id]; slack += Math.max(0, tgt[p.id] - (plan.need[p.id] || 0)); });
        var ex = sumT - total;
        if (Math.abs(ex) < 0.01) break;
        if (ex > 0 && slack > 0) R.forEach(function (p) { var sl = Math.max(0, tgt[p.id] - (plan.need[p.id] || 0)); tgt[p.id] -= Math.min(sl, ex * sl / slack); });
        else R.forEach(function (p) { tgt[p.id] *= total / sumT; });
      }
      var closers = R.slice().sort(function (a, b) { return tgt[b.id] - tgt[a.id]; }).slice(0, 5).map(function (p) { return p.id; });
      var cur = [];
      wins.forEach(function (w, wi) {
        var len = (w.t1 - w.t0) / 60, left = (gsec - w.t0) / 60, five;
        var P = seq[w.i], m = P ? (side === 'A' ? 1 : -1) * ((P.after.A - P.pts * (P.team === 'A')) - (P.after.H - P.pts * (P.team === 'H'))) : 0;
        var lastReg = w.per === nReg - 1 && !wins.slice(wi + 1).some(function (x) { return x.per === w.per; });
        var inOT = w.per >= nReg;
        if (w.start && (w.per === 0 || w.per === C.half)) five = R.filter(function (p) { return p.starter; }).map(function (p) { return p.id; });
        else {
          var garbage = w.per === nReg - 1 && left <= 6 && Math.abs(m) >= 22, close = (lastReg || inOT) && Math.abs(m) <= 12;
          var pr = R.map(function (p) {
            // closers finish close games (a strong lean, not a rule: a box that needs someone else still gets him)
            var rem = tgt[p.id] - played[p.id], v = rem / Math.max(len, left) + (cur.indexOf(p.id) >= 0 ? 0.04 : 0) + 0.01 * r() + (close && closers.indexOf(p.id) >= 0 ? 0.35 : 0);
            if (garbage) v = (p.starter ? -1 : 1) + rem / Math.max(1, left);
            return [p.id, v];
          });
          pr.sort(function (a, b) { return b[1] - a[1]; });
          five = pr.slice(0, 5).map(function (x) { return x[0]; });
        }
        five.forEach(function (id) { played[id] += len; });
        out[side].push(five); cur = five;
      });
    });
    return {wins: wins, A: out.A, H: out.H};
  }
  function onFloorAt(lu, i) { var w = 0; for (var q = 0; q < lu.wins.length; q++) if (lu.wins[q].i <= i) w = q; return w; }

  // every event handed to a player on the floor (one matching per kind, per team)
  function assign(ctx, bx, seq, lu, r) {
    var short = {}, ok = true, other = {A: 'H', H: 'A'}, fails = [];
    seq.forEach(function (P, i) { var w = onFloorAt(lu, i); P.w = w; P.on = {A: lu.A[w], H: lu.H[w]}; });
    // refs: what each slot sits on ({P, a} or {P, n} for a non-shooting foul), for the repair step
    function run(side, slots, capOf, refs) {
      var cap = {}; ctx.rost[side].forEach(function (p) { var c = capOf(p); if (c > 0) cap[p.id] = c; });
      var n = 0; Object.keys(cap).forEach(function (id) { n += cap[id]; });
      if (n !== slots.length) { ok = false; fails.push({who: side, refs: [], short: {}, count: true}); return null; }   // never expected: the box and the slots disagree
      var m = match(slots, cap, r);
      if (!m.ok) { ok = false; Object.keys(m.short).forEach(function (id) { short[id] = (short[id] || 0) + m.short[id]; }); fails.push({who: side, refs: refs, short: m.short}); return null; }
      return m.who;
    }
    ['A', 'H'].forEach(function (side) {
      var mine = [], B = bx.B, opp = other[side];
      seq.forEach(function (P) { if (P.team === side) P.att.forEach(function (a) { mine.push({P: P, a: a}); }); });
      // shooters, by class; each slot then takes one of its shooter's own attempts of that class
      var byC = {}, pool = {};
      mine.forEach(function (x) {
        (byC[x.a.cls] = byC[x.a.cls] || []).push(x);
        var q = pool[x.a.pid0] = pool[x.a.pid0] || {}; (q[x.a.cls] = q[x.a.cls] || []).push(x.a.ty);
      });
      Object.keys(pool).forEach(function (id) { Object.keys(pool[id]).forEach(function (c) { r.shuffle(pool[id][c]); }); });
      Object.keys(byC).forEach(function (c) {
        var L = byC[c], who = run(side, L.map(function (x) { return {allow: x.P.on[side]}; }), function (p) { return ((pool[p.id] || {})[c] || []).length; }, L);
        if (!who) return;
        var hand = {}; Object.keys(pool).forEach(function (id) { hand[id] = ((pool[id] || {})[c] || []).slice(); });
        L.forEach(function (x, i) {
          var ty = hand[who[i]].pop(), a = x.a;
          TYF.forEach(function (f) { delete a[f]; }); Object.keys(ty).forEach(function (f) { a[f] = ty[f]; });
          a.by = who[i]; a.assisted = a.blocked = a.stolen = a.put = 0; delete a.ast; delete a.blkBy; delete a.stlBy; delete a.rebBy; delete a.foulBy;
        });
      });
      if (!ok) return;
      // putbacks, assisted makes (threes most often, putbacks almost never), blocked misses, stolen turnovers
      var t = bx.T[side], o = bx.T[opp];
      mine.forEach(function (x, i) { var pv = i > 0 && mine[i - 1].P === x.P ? mine[i - 1].a : null; if (x.a.k === 'fg' && x.a.fg === 2 && pv && pv.reb === 'O' && r() < 0.5) x.a.put = 1; });
      var poolM = mine.filter(function (x) { return x.a.k === 'fg' && x.a.made; }), aw = function (x) { return x.a.put ? 0.05 : x.a.fg === 3 ? 0.85 : x.a.and1 ? 0.35 : 0.5; };
      for (var i = 0; i < t.ast; i++) { var pa = r.pick(poolM, aw); if (!pa) break; pa.a.assisted = 1; poolM.splice(poolM.indexOf(pa), 1); }
      var poolX = mine.filter(function (x) { return x.a.k === 'fg' && !x.a.made; }), bw = function (x) { return x.a.fg === 3 ? 0.08 : x.a.put ? 0.6 : 1; };
      for (i = 0; i < o.blk; i++) { var pb = r.pick(poolX, bw); if (!pb) break; pb.a.blocked = 1; poolX.splice(poolX.indexOf(pb), 1); }
      var poolT = mine.filter(function (x) { return x.a.k === 'to'; });
      for (i = 0; i < o.stl; i++) { var ps = r.pick(poolT); if (!ps) break; ps.a.stolen = 1; poolT.splice(poolT.indexOf(ps), 1); }
      var made = mine.filter(function (x) { return x.a.assisted; });
      var wa = run(side, made.map(function (x) { return {allow: x.P.on[side].filter(function (id) { return id !== x.a.by; })}; }), function (p) { return B[p.id].ast; }, made);
      if (wa) made.forEach(function (x, i) { x.a.ast = wa[i]; });
      var orb = mine.filter(function (x) { return x.a.reb === 'O'; });
      var wo = run(side, orb.map(function (x) { return {allow: x.P.on[side]}; }), function (p) { return B[p.id].oreb; }, orb);
      if (wo) orb.forEach(function (x, i) { x.a.rebBy = wo[i]; });
      var drb = mine.filter(function (x) { return x.a.reb === 'D'; });
      var wd = run(opp, drb.map(function (x) { return {allow: x.P.on[opp]}; }), function (p) { return B[p.id].dreb; }, drb);
      if (wd) drb.forEach(function (x, i) { x.a.rebBy = wd[i]; });
      var blk = mine.filter(function (x) { return x.a.blocked; });
      var wb = run(opp, blk.map(function (x) { return {allow: x.P.on[opp]}; }), function (p) { return B[p.id].blk; }, blk);
      if (wb) blk.forEach(function (x, i) { x.a.blkBy = wb[i]; });
      var stl = mine.filter(function (x) { return x.a.stolen; });
      var ws = run(opp, stl.map(function (x) { return {allow: x.P.on[opp]}; }), function (p) { return B[p.id].stl; }, stl);
      if (ws) stl.forEach(function (x, i) { x.a.stlBy = ws[i]; });
      // fouls: one per trip and per and-one, plus the non-shooting ones, all by the defense
      var fl = [];
      mine.forEach(function (x) { if (x.a.k === 'ft' || x.a.and1) fl.push({x: x}); });
      seq.forEach(function (P) { if (P.team === side) (P.nsf || []).forEach(function (n) { fl.push({P: P, n: n}); }); });
      var wf = run(opp, fl.map(function (f) { return {allow: (f.x ? f.x.P : f.P).on[opp]}; }), function (p) { return B[p.id].pf; }, fl.map(function (f) { return f.x ? f.x : {P: f.P, n: f.n}; }));
      if (wf) fl.forEach(function (f, i) { if (f.x) f.x.a.foulBy = wf[i]; else f.n.by = wf[i]; });
    });
    return {ok: ok, short: short, fails: fails};
  }
  // a slot whose player is on the bench: swap its whole possession with one of the same team, the same shape (number
  // of attempts) and the same stretch of the game (regulation, or the same overtime) where he is on the floor. Points
  // per period group, possession counts and the clock all stay as they were
  var SWAPF = TYF.concat(['cls', 'pid0', 'ty', 'reb']);
  function repair(seq, fails, nReg, r) {
    var did = 0;
    fails.forEach(function (f) {
      Object.keys(f.short).forEach(function (X) {
        for (var n = 0; n < f.short[X]; n++) {
          var ref = r.pick(f.refs.filter(function (x) { return x.P.on[f.who].indexOf(X) < 0; })); if (!ref) continue;
          var P = ref.P, Q;
          if (ref.n) {
            P = ref.n.P || P; if (ref.n.moved || P.nsf.indexOf(ref.n) < 0) continue;
            Q = r.pick(seq.filter(function (q) { return q.team === P.team && q.on[f.who].indexOf(X) >= 0; })); if (!Q) continue;
            P.nsf.splice(P.nsf.indexOf(ref.n), 1); ref.n.t = r.u(Q.t0, Q.t1); ref.n.P = Q; ref.n.moved = 1; (Q.nsf = Q.nsf || []).push(ref.n); did++; continue;
          }
          var grp = P.per < nReg ? -1 : P.per;
          Q = r.pick(seq.filter(function (q) { return q !== P && q.team === P.team && (q.per < nReg ? -1 : q.per) === grp && q.att.length === P.att.length && q.on[f.who].indexOf(X) >= 0; }));
          if (!Q) continue;
          for (var i = 0; i < P.att.length; i++) {
            var a = P.att[i], b = Q.att[i];
            SWAPF.forEach(function (fld) { var t = a[fld]; if (b[fld] === undefined) delete a[fld]; else a[fld] = b[fld]; if (t === undefined) delete b[fld]; else b[fld] = t; });
          }
          var tp = P.pts; P.pts = Q.pts; Q.pts = tp; did++;
        }
      });
    });
    seq.forEach(function (P) { (P.nsf || []).forEach(function (n) { n.moved = 0; }); });
    if (did) { var sa = 0, sh = 0; seq.forEach(function (P) { if (P.team === 'A') sa += P.pts; else sh += P.pts; P.after = {A: sa, H: sh}; }); }
    return did;
  }
  // ── 5. the story: events with text, the clock, win probability, callouts, the plus-minus ──────────────
  function shotDesc(a, p, r) {
    if (a.fg === 3) {
      var corner = r() < 0.24, deep = !corner && r() < (a.made ? 0.05 : 0.1);
      a.dist = corner ? r.int(22, 23) : deep ? r.int(28, 34) : clamp(Math.round(23.8 + Math.abs(1.3 * r.z())), 24, 27);
      a.ang = corner ? (r() < 0.5 ? -1 : 1) * r.u(1.38, 1.5) : r.u(-1.15, 1.15);
      a.kind = corner ? 'corner three' : r.pick(['three point jump shot', 'three point pullup jump shot', 'three point step back jump shot', 'three point jumper'], function (x, i) { return [4, 2, 1, 2][i]; });
      return;
    }
    if (a.put) { a.dist = r.int(1, 3); a.kind = a.made && p.big && r() < 0.4 ? 'putback dunk' : 'tip shot'; a.ang = r.u(-0.8, 0.8); return; }
    var big = p.big, u = r(), d;
    if (big) d = u < 0.62 ? r.int(1, 4) : u < 0.9 ? r.int(5, 12) : r.int(13, 20);
    else d = u < 0.42 ? r.int(1, 4) : u < 0.72 ? r.int(5, 14) : r.int(15, 22);
    a.dist = d; a.ang = r.u(-1.3, 1.3);
    if (d <= 3) a.kind = big && r() < 0.45 ? (a.assisted && r() < 0.35 ? 'alley oop dunk' : 'dunk') : r.pick(['driving layup', 'cutting layup', 'layup', 'driving finger roll layup'], function (x, i) { return [4, 2, 3, 1][i]; });
    else if (d <= 9) a.kind = big ? r.pick(['hook shot', 'turnaround hook shot', 'floating jump shot']) : r.pick(['floating jump shot', 'driving floating jump shot', 'pullup jump shot']);
    else a.kind = r.pick(big ? ['jump shot', 'turnaround jump shot', 'fadeaway jumper'] : ['pullup jump shot', 'jump shot', 'step back jump shot', 'fadeaway jumper'], function (x, i) { return [3, 2, 1, 1][i] || 1; });
  }
  var TOK = [['bad pass', 4], ['lost ball', 3], ['traveling', 1.5], ['out of bounds bad pass', 1.5], ['offensive goaltending', 0.1], ['shot clock violation', 0.6], ['3 second violation', 0.4]];
  function clk(sec) { if (sec < 60) return sec.toFixed(1); var m = Math.floor(sec / 60), s = Math.floor(sec - 60 * m); return m + ':' + (s < 10 ? '0' : '') + s; }
  SR.clock = clk;

  function story(ctx, k, bx, seq, lu, PER, nOT, starts, r) {
    var C = ctx.C, ev = [], by = ctx.byId, sc = {A: 0, H: 0}, other = {A: 'H', H: 'A'}, pStart = [0];
    PER.forEach(function (L, j) { pStart.push(pStart[j] + L); });
    var gsec = pStart[PER.length];
    function rem(t, j) { return Math.max(0, pStart[j + 1] - t); }
    var curPoss = null;
    function push(e) { if (curPoss != null && e.poss == null) e.poss = curPoss; e.i = ev.length; e.A = sc.A; e.H = sc.H; if (e.per == null) e.per = perOf(e.t); e.clk = rem(e.t, e.per); ev.push(e); return e; }
    function perOf(t) { for (var j = 0; j < PER.length; j++) if (t < pStart[j + 1] - 1e-6) return j; return PER.length - 1; }
    function nm(id) { return by[id] ? by[id].name : 'Team'; }
    var on = {A: [], H: []}, wi = -1;
    var possRec = [];
    seq.forEach(function (P, i) {
      // period start
      if (!i || seq[i - 1].per !== P.per) {
        if (i) push({t: pStart[P.per] - 0.0001, per: P.per - 1, type: 'end', text: 'End of ' + perLabel(C, P.per - 1)});
        push({t: pStart[P.per], per: P.per, type: 'start', text: 'Start of ' + perLabel(C, P.per)});
      }
      // window change: timeout then substitutions (period starts: the new five check in)
      if (P.w !== wi) {
        var w = lu.wins[P.w];
        if (w.timeout) push({t: P.t0, type: 'timeout', team: r() < 0.5 ? 'A' : 'H', text: r() < 0.6 ? 'Timeout' : 'Full timeout'});
        ['A', 'H'].forEach(function (side) {
          var nx = lu[side][P.w], outs = on[side].filter(function (id) { return nx.indexOf(id) < 0; }), ins = nx.filter(function (id) { return on[side].indexOf(id) < 0; });
          if (!on[side].length) { push({t: P.t0, type: 'five', team: side, five: nx.slice(), text: ctx.rost[side][0].abbr + ' starting five: ' + nx.map(function (id) { return by[id].last; }).join(', ')}); }
          else ins.forEach(function (id, q) { push({t: P.t0, type: 'sub', team: side, pin: id, pout: outs[q], text: nm(id) + ' enters the game for ' + nm(outs[q])}); });
          on[side] = nx.slice();
        });
        wi = P.w;
      }
      if (i === 0) {
        var ca = bigOf(lu.A[P.w]), chh = bigOf(lu.H[P.w]);
        push({t: P.t0, type: 'jump', team: P.team, p: P.team === 'A' ? ca : chh, p2: P.team === 'A' ? chh : ca, text: 'Jump ball: ' + nm(ca) + ' vs. ' + nm(chh) + ' (' + by[P.team === 'A' ? ca : chh].abbr + ' gains possession)'});
      }
      var pr = {i: possRec.length, team: P.team, per: P.per, t0: P.t0, t1: P.t1, on: {A: P.on.A.slice(), H: P.on.H.slice()}, ev0: ev.length, after: P.after};
      var ns = (P.nsf || []).slice().sort(function (a, b) { return a.t - b.t; });
      curPoss = pr.i;
      P.att.forEach(function (a, ai) {
        // non-shooting fouls inside this stretch
        while (ns.length && ns[0].t <= a.t1) { var nf = ns.shift(); push({t: Math.max(a.t0, Math.min(a.t1, Math.round(nf.t * 10) / 10)), type: 'foul', team: other[P.team], p: nf.by, kind: 'personal', text: nm(nf.by) + ' personal foul'}); }
        var shooter = by[a.by], scClock = Math.round(((ai === 0 ? C.shot : C.oreb) - (a.t1 - a.t0)) * 10) / 10;
        if (a.k === 'fg') {
          shotDesc(a, shooter, r);
          var base = {t: a.t1, a0: a.t0, att: ai, type: 'shot', team: P.team, p: a.by, fg: a.fg, made: !!a.made, dist: a.dist, ang: a.ang, kind: a.kind, sc: scClock, poss: pr.i, put: a.put};
          if (a.made) {
            sc[P.team] += a.fg;
            base.pts = a.fg; base.ast = a.ast || null;
            base.text = nm(a.by) + ' makes ' + a.dist + '-foot ' + a.kind + (a.ast ? ' (' + nm(a.ast) + ' assists)' : '');
            push(base);
            if (a.and1) {
              push({t: a.t1, type: 'foul', team: other[P.team], p: a.foulBy, kind: 'shooting', on: a.by, text: nm(a.foulBy) + ' shooting foul'});
              var m1 = a.and1.m === 1;
              if (m1) sc[P.team] += 1;
              push({t: a.t1, type: 'ft', team: P.team, p: a.by, made: m1, n: 1, of: 1, and1: true, pts: m1 ? 1 : 0, text: nm(a.by) + (m1 ? ' makes' : ' misses') + ' and-one free throw'});
              if (!m1) rebound(a, P);
            }
          } else {
            base.blk = a.blkBy || null;
            base.text = a.blkBy ? nm(a.blkBy) + ' blocks ' + nm(a.by) + '\'s ' + a.dist + '-foot ' + a.kind : nm(a.by) + ' misses ' + a.dist + '-foot ' + a.kind;
            push(base);
            rebound(a, P);
          }
        } else if (a.k === 'ft') {
          push({t: a.t1, a0: a.t0, att: ai, type: 'foul', team: other[P.team], p: a.foulBy, kind: 'shooting', on: a.by, text: nm(a.foulBy) + ' shooting foul', sc: scClock});
          // the made/missed order: the last one is decided (lastMiss), the rest shuffled
          var seqF = [], mLeft = a.lastMiss ? a.m : a.m - 1;
          for (var q = 0; q < a.s - 1; q++) seqF.push(q < mLeft ? 1 : 0);
          r.shuffle(seqF); seqF.push(a.lastMiss ? 0 : 1);
          seqF.forEach(function (mk, q2) {
            if (mk) sc[P.team] += 1;
            push({t: a.t1, type: 'ft', team: P.team, p: a.by, made: !!mk, n: q2 + 1, of: a.s, pts: mk, text: nm(a.by) + (mk ? ' makes' : ' misses') + ' free throw ' + (q2 + 1) + ' of ' + a.s});
          });
          if (a.lastMiss) rebound(a, P);
        } else if (a.k === 'to') {
          var long = a.t1 - a.t0 >= (ai === 0 ? C.shot : C.oreb) - 1.5;
          var kd = a.stolen ? r.pick(['bad pass', 'lost ball']) : r.pick(TOK.map(function (x) { return x[0]; }), function (x, q3) { return x === 'shot clock violation' ? (long ? 8 : 0) : TOK[q3][1]; });
          if (kd === 'shot clock violation') scClock = 0;
          push({t: a.t1, a0: a.t0, att: ai, type: 'to', team: P.team, p: a.by, stl: a.stlBy || null, kind: kd, sc: scClock,
                text: nm(a.by) + ' ' + kd + ' turnover' + (a.stlBy ? ' (' + nm(a.stlBy) + ' steals)' : '')});
        }
      });
      while (ns.length) { var nf2 = ns.shift(); push({t: P.t1, type: 'foul', team: other[P.team], p: nf2.by, kind: 'personal', text: nm(nf2.by) + ' personal foul'}); }
      pr.ev1 = ev.length - 1; curPoss = null;
      possRec.push(pr);
      function rebound(a, P2) {
        var tt = a.t1;
        if (a.reb === 'O') push({t: Math.round(tt * 10) / 10, type: 'reb', team: P2.team, p: a.rebBy, off: true, text: nm(a.rebBy) + ' offensive rebound'});
        else if (a.reb === 'D') push({t: Math.round(tt * 10) / 10, type: 'reb', team: other[P2.team], p: a.rebBy, off: false, text: nm(a.rebBy) + ' defensive rebound'});
        else push({t: Math.round(tt * 10) / 10, type: 'reb', team: other[P2.team], p: null, off: false, teamReb: true, text: by[ctx.rost[other[P2.team]][0].id].abbr + ' team rebound'});
      }
    });
    push({t: gsec - 0.0001, per: PER.length - 1, type: 'end', text: 'End of ' + perLabel(C, PER.length - 1)});
    push({t: gsec, per: PER.length - 1, type: 'final', text: 'Final: ' + ctx.rost.A[0].abbr + ' ' + sc.A + ', ' + ctx.rost.H[0].abbr + ' ' + sc.H});
    function bigOf(five) { var b = five.slice().sort(function (x, y) { return (by[y].rank - by[x].rank) || ((by[y].proj.reb || 0) - (by[x].proj.reb || 0)); }); return b[0]; }
    // win probability: final margin ~ margin now + the sim's edge over the time left, with the sim's spread (state
    // based: the score, the clock, who has the ball, and the pre-game distribution of all 10,000 games)
    var D = ctx.dist, nReg = C.per.length, regLen = pStart[nReg];
    ev.forEach(function (e) {
      var m = e.A - e.H, left, frac;
      if (e.type === 'final') { e.wp = e.A > e.H ? 1 : 0; return; }
      if (e.per < nReg) { left = regLen - e.t; frac = left / regLen; }
      else { left = pStart[e.per + 1] - e.t; frac = left / regLen; }
      var ball = e.type === 'shot' && e.made || e.type === 'to' || (e.type === 'reb' && !e.off) ? (e.team === 'A' ? -0.5 : 0.5) : 0;
      if (frac <= 1e-6) { e.wp = m > 0 ? 1 : m < 0 ? 0 : 0.5; if (e.type === 'end' && m === 0) e.wp = Phi(D.muM * C.ot / regLen / (D.sdM * Math.sqrt(C.ot / regLen))); return; }
      // plus a little end-game variance the smooth model misses (fouling, threes, a possession's swing)
      var z = (m + ball + D.muM * frac) / Math.sqrt(D.sdM * D.sdM * frac + 6 * Math.min(1, left / 90));
      e.wp = clamp(Phi(z), 0.001, 0.999);
    });
    // possessions' positions in the event list, and the on-floor sets at every event
    var onA = [], onH = [], cur2 = {A: [], H: []};
    ev.forEach(function (e) {
      if (e.type === 'five') cur2[e.team] = e.five.slice();
      else if (e.type === 'sub') cur2[e.team] = cur2[e.team].map(function (id) { return id === e.pout ? e.pin : id; });
      onA.push(cur2.A); onH.push(cur2.H);
    });
    var game = {ok: true, onA: onA, onH: onH, sport: ctx.sport, gid: ctx.gid, k: k, nOT: nOT, per: PER, pStart: pStart, len: gsec, events: ev, poss: possRec,
                A: ctx.G.A, H: ctx.G.H, score: {A: sc.A, H: sc.H}, box: bx.B, team: bx.T, rost: ctx.rost, byId: ctx.byId, starts: starts};
    callouts(game);
    game.ticks = ev.filter(function (e) { return e.call && e.call.pri >= 3; }).map(function (e) { return {i: e.i, t: e.t, kind: e.call.kind}; });
    return game;
  }

  // ── callouts: what a broadcast would put on screen ──────────────────────────────────────────────────────
  function callouts(game) {
    var ev = game.events, by = game.byId, last3 = {}, runT = null, run = 0, ptsSince = {}, lead = 0, nReg = (CFG[game.sport] || CFG.nba).per.length, pStart = game.pStart;
    var stat = {}; Object.keys(by).forEach(function (id) { stat[id] = {pts: 0, reb: 0, ast: 0, dd: false, m: 0}; });
    var streak = {team: null, p: null, n: 0};
    ev.forEach(function (e) {
      var c = null, before = (e.A - (e.team === 'A' ? e.pts || 0 : 0)) - (e.H - (e.team === 'H' ? e.pts || 0 : 0));
      if (e.p && stat[e.p]) {
        if (e.type === 'shot' && e.made) stat[e.p].pts += e.fg;
        if (e.type === 'ft' && e.made) stat[e.p].pts += 1;
        if (e.type === 'reb') stat[e.p].reb++;
      }
      if (e.type === 'shot' && e.ast && stat[e.ast]) stat[e.ast].ast++;
      var nm = function (id) { return by[id] ? by[id].name : ''; };
      var cand = [];
      if (e.type === 'shot') {
        if (e.fg === 3 && e.made && e.dist >= 27) cand.push({kind: 'downtown', pri: 4, title: 'From way downtown', sub: nm(e.p) + ' · ' + e.dist + ' ft', p: e.p});
        if (e.fg === 3) { if (e.made && last3[e.p]) cand.push({kind: 'heat', pri: 4, title: 'Heating up', sub: nm(e.p) + ' · back-to-back threes', p: e.p}); }
        last3[e.p] = e.fg === 3 && e.made;
        if (e.blk) cand.push({kind: 'block', pri: 3, title: 'Rejected', sub: nm(e.blk) + ' blocks ' + (by[e.p] ? by[e.p].last : ''), p: e.blk});
        if (e.made && /dunk/.test(e.kind) && /alley/.test(e.kind)) cand.push({kind: 'slam', pri: 2, title: 'Alley-oop', sub: (e.ast ? nm(e.ast) + ' to ' : '') + nm(e.p), p: e.p});
        else if (e.made && /dunk/.test(e.kind)) cand.push({kind: 'slam', pri: 1, title: 'Slam', sub: nm(e.p), p: e.p});
      }
      if (e.type === 'ft' && e.and1 && e.made) cand.push({kind: 'and1', pri: 3, title: 'And-one', sub: nm(e.p) + ' · the bucket and the foul', p: e.p});
      // scoring streaks: one player's straight points, a team's unanswered run
      var pts = (e.type === 'shot' && e.made ? e.fg : 0) + (e.type === 'ft' && e.made ? 1 : 0);
      if (pts) {
        if (streak.team === e.team && streak.p === e.p) streak.n += pts; else if (streak.team === e.team) { streak.p = e.p; streak.n = pts; } else { streak = {team: e.team, p: e.p, n: pts}; }
        if (streak.n >= 8 && streak.n - pts < 8) cand.push({kind: 'heat', pri: 4, title: 'Heating up', sub: nm(e.p) + ' · ' + streak.n + ' straight points', p: e.p});
        if (runT === e.team) run += pts; else { runT = e.team; run = pts; }
        [8, 10, 12, 14, 16, 18, 20].forEach(function (x) { if (run >= x && run - pts < x) cand.push({kind: 'run', pri: x >= 10 ? 3 : 2, title: run + '-0 run', sub: (by[e.p] ? by[e.p].abbr : '') + ' · ' + run + ' straight points', team: e.team}); });
        // clutch: last two minutes of the 4th or overtime, a one-possession game before the score
        var tleft = pStart[e.per + 1] - e.t;
        if (e.type === 'shot' && e.per >= nReg - 1 && tleft <= 120 && Math.abs(before) <= 3) cand.push({kind: 'clutch', pri: 5, title: 'Clutch', sub: nm(e.p) + ' · ' + clk(tleft) + ' left', p: e.p});
        var m = e.A - e.H, nl = m > 0 ? 1 : m < 0 ? -1 : 0;
        if (nl && lead && nl !== lead && e.per >= 1) cand.push({kind: 'lead', pri: e.per >= nReg - 1 ? 3 : 2, title: 'Lead change', sub: game.A + ' ' + e.A + ', ' + game.H + ' ' + e.H, team: e.team});
        if (nl) lead = nl;
      }
      if (e.p && stat[e.p] && !stat[e.p].dd) {
        var s = stat[e.p], n10 = (s.pts >= 10) + (s.reb >= 10) + (s.ast >= 10);
        if (n10 >= 2) { s.dd = true; cand.push({kind: 'dd', pri: 2, title: 'Double-double', sub: nm(e.p) + ' · ' + s.pts + ' pts, ' + (s.reb >= 10 ? s.reb + ' reb' : s.ast + ' ast'), p: e.p}); }
      }
      if (e.type === 'shot' && e.made && e.p && stat[e.p]) { var pp = stat[e.p].pts; [30, 40, 50].forEach(function (x) { if (pp >= x && pp - e.fg < x) cand.push({kind: 'milestone', pri: 3, title: x + ' points', sub: nm(e.p), p: e.p}); }); }
      if (cand.length) { cand.sort(function (a, b) { return b.pri - a.pri; }); c = cand[0]; e.call = c; }
    });
  }

  // ── reading a game: the box and on-floor sets at event i, grading a leg ─────────────────────────────────
  SR.boxAt = function (game, upto) {
    var ev = game.events, by = game.byId, B = {}, on = {A: [], H: []}, sc = {A: 0, H: 0}, secs = {}, lastT = 0;
    Object.keys(by).forEach(function (id) { B[id] = {min: 0, sec: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0, pm: 0, played: false}; });
    var T = {A: {tr: 0}, H: {tr: 0}};
    upto = upto == null ? ev.length - 1 : Math.min(upto, ev.length - 1);
    for (var i = 0; i <= upto; i++) {
      var e = ev[i], dt = e.t - lastT;
      if (dt > 0) ['A', 'H'].forEach(function (s) { on[s].forEach(function (id) { B[id].sec += dt; }); });
      lastT = Math.max(lastT, e.t);
      if (e.type === 'five') { on[e.team] = e.five.slice(); e.five.forEach(function (id) { B[id].played = true; }); }
      else if (e.type === 'sub') { on[e.team] = on[e.team].filter(function (id) { return id !== e.pout; }).concat([e.pin]); B[e.pin].played = true; }
      var b = e.p ? B[e.p] : null, pts = 0;
      if (e.type === 'shot') { b.fga++; if (e.fg === 3) b.tpa++; if (e.made) { b.fgm++; if (e.fg === 3) b.tpm++; pts = e.fg; } if (e.ast) B[e.ast].ast++; if (e.blk) B[e.blk].blk++; }
      else if (e.type === 'ft') { b.fta++; if (e.made) { b.ftm++; pts = 1; } }
      else if (e.type === 'reb') { if (b) { b.reb++; if (e.off) b.oreb++; else b.dreb++; } else T[e.team].tr++; }
      else if (e.type === 'to') { b.to++; if (e.stl) B[e.stl].stl++; }
      else if (e.type === 'foul') b.pf++;
      if (pts) {
        b.pts += pts; sc[e.team] += pts;
        on[e.team].forEach(function (id) { B[id].pm += pts; }); on[e.team === 'A' ? 'H' : 'A'].forEach(function (id) { B[id].pm -= pts; });
      }
    }
    Object.keys(B).forEach(function (id) { B[id].min = Math.round(B[id].sec / 60); });
    return {B: B, on: on, score: sc, T: T, t: lastT};
  };

  // a leg (a saved pick, a slip leg or a board row) graded against the game at event i:
  //   {cur, line, side, state: 'hit'|'miss'|'live'|'push', label}
  SR.grade = function (leg, game, i, bx) {
    bx = bx || SR.boxAt(game, i);
    var ev = game.events, fin = i >= ev.length - 1, sc = bx.score, A = game.A, H = game.H;
    var team = leg.team === A || leg.name === A ? 'A' : leg.team === H || leg.name === H ? 'H' : null;
    var res = {cur: null, line: leg.line, side: leg.side, state: 'live'};
    if (leg.kind === 'ml') { var me = leg.name === A ? 'A' : 'H', m = sc[me] - sc[me === 'A' ? 'H' : 'A']; res.cur = m; res.state = fin ? (m > 0 ? 'hit' : 'miss') : 'live'; return res; }
    if (leg.kind === 'spread') { var me2 = leg.name === A ? 'A' : 'H', d = sc[me2] - sc[me2 === 'A' ? 'H' : 'A'] + leg.hcap; res.cur = sc[me2] - sc[me2 === 'A' ? 'H' : 'A']; res.state = fin ? (d > 0 ? 'hit' : d < 0 ? 'miss' : 'push') : 'live'; return res; }
    if (leg.kind === 'total') { var tot = sc.A + sc.H; res.cur = tot; if (leg.side === 'under') res.state = tot > leg.line ? 'miss' : fin ? 'hit' : 'live'; else res.state = tot > leg.line ? 'hit' : fin ? 'miss' : 'live'; return res; }
    if (leg.mkt === 'h1_total' || leg.mkt === 'q1_total') {
      var endP = leg.mkt === 'q1_total' ? game.pStart[1] : game.pStart[game.sport === 'cbb' ? 1 : 2], t = 0, upto = Math.min(i, ev.length - 1);
      for (var q = 0; q <= upto; q++) if (ev[q].t <= endP && ((ev[q].type === 'shot' && ev[q].made) || (ev[q].type === 'ft' && ev[q].made))) t += ev[q].type === 'shot' ? ev[q].fg : 1;
      var over = (ev[upto] || {}).t >= endP; res.cur = t;
      if (leg.side === 'under') res.state = t > leg.line ? 'miss' : over ? 'hit' : 'live'; else res.state = t > leg.line ? 'hit' : over ? 'miss' : 'live';
      return res;
    }
    var p = playerOf(game, leg); if (!p) { res.state = 'unknown'; return res; }
    var b = bx.B[p.id], v;
    if (leg.mkt === 'first_basket') {
      var first = null; for (q = 0; q < ev.length; q++) if (ev[q].type === 'shot' && ev[q].made) { first = ev[q]; break; }
      res.cur = null; res.state = first && first.i <= i ? (first.p === p.id ? 'hit' : 'miss') : 'live'; return res;
    }
    if (leg.mkt === 'dbl_dbl' || leg.mkt === 'trp_dbl') {
      var n = (b.pts >= 10) + (b.reb >= 10) + (b.ast >= 10), need = leg.mkt === 'trp_dbl' ? 3 : 2; res.cur = n;
      res.state = n >= need ? 'hit' : fin ? 'miss' : 'live'; return res;
    }
    v = {pts: b.pts, reb: b.reb, ast: b.ast, threes: b.tpm, pr: b.pts + b.reb, pa: b.pts + b.ast, pra: b.pts + b.reb + b.ast}[leg.mkt];
    if (v == null) { res.state = 'unknown'; return res; }
    res.cur = v;
    if (leg.side === 'under') res.state = v > leg.line ? 'miss' : fin ? (v < leg.line ? 'hit' : 'push') : 'live';
    else res.state = v > leg.line ? 'hit' : fin ? (v < leg.line ? 'miss' : 'push') : 'live';
    return res;
  };
  function playerOf(game, leg) {
    var k = nk(leg.name || ''), out = null;
    Object.keys(game.byId).forEach(function (id) { var p = game.byId[id]; if (p.k === k) out = p; });
    return out;
  }
  SR.playerOf = playerOf;

  // ── verify: re-add everything from the events alone ─────────────────────────────────────────────────────
  SR.verify = function (game, ctx) {
    var bad = [], C = CFG[game.sport] || CFG.nba, ev = game.events, k = game.k;
    var fb = SR.boxAt(game);
    if (fb.score.A !== game.score.A || fb.score.H !== game.score.H) bad.push('final score from events ' + fb.score.A + '-' + fb.score.H + ' vs game ' + game.score.A + '-' + game.score.H);
    if (ctx) {
      if (fb.score.A !== ctx.Dr.sa[k] || fb.score.H !== ctx.Dr.sh[k]) bad.push('final score ' + fb.score.A + '-' + fb.score.H + ' vs sim ' + ctx.Dr.sa[k] + '-' + ctx.Dr.sh[k]);
      if (game.nOT !== ctx.Dr.ot[k]) bad.push('overtimes ' + game.nOT + ' vs sim ' + ctx.Dr.ot[k]);
    }
    // every stat, every player, against the box the game was built to
    Object.keys(game.box).forEach(function (id) {
      var b = game.box[id], e = fb.B[id], nm = game.byId[id].name;
      [['pts', 'pts'], ['fgm', 'fgm'], ['fga', 'fga'], ['tpm', 'tpm'], ['tpa', 'tpa'], ['ftm', 'ftm'], ['fta', 'fta'], ['oreb', 'oreb'], ['dreb', 'dreb'], ['reb', 'reb'],
       ['ast', 'ast'], ['stl', 'stl'], ['blk', 'blk'], ['to', 'to'], ['pf', 'pf']].forEach(function (f) { if (b[f[0]] !== e[f[1]]) bad.push(nm + ' ' + f[0] + ' box ' + b[f[0]] + ' events ' + e[f[1]]); });
      if (e.pf >= C.foulOut) bad.push(nm + ' has ' + e.pf + ' fouls');
      if (e.sec > game.len + 0.01) bad.push(nm + ' played ' + (e.sec / 60).toFixed(1) + ' min');
      if (e.sec > 48 * 60 + game.nOT * 300 + 0.01) bad.push(nm + ' over 48 minutes');
      // the sim's own draws, where it had them
      if (ctx) {
        var p = ctx.byId[id], fr = p && p.bp ? ctx.fixRows[p.bp.k] || {} : {};
        ['pts', 'reb', 'ast', 'tpm'].forEach(function (s) { if (fr[s] && fr[s][k] !== e[s]) bad.push(nm + ' ' + s + ' ' + e[s] + ' vs the sim\'s ' + fr[s][k]); });
      }
    });
    // minutes: on the floor exactly 5 a side at all times, the team's minutes the game's length
    ['A', 'H'].forEach(function (s) {
      var sec = 0; game.rost[s].forEach(function (p) { sec += fb.B[p.id].sec; });
      if (Math.abs(sec - 5 * game.len) > 0.5) bad.push(s + ' floor time ' + (sec / 60).toFixed(2) + ' min vs ' + (5 * game.len / 60));
    });
    var on = {A: [], H: []}, lastT = -1, lastPer = 0, lastClk = Infinity, poss = null;
    ev.forEach(function (e) {
      if (e.t < lastT - 1e-6) bad.push('clock runs backward at event ' + e.i);
      if (e.per === lastPer && e.clk > lastClk + 1e-6) bad.push('game clock goes up at event ' + e.i);
      if (e.per !== lastPer) lastClk = Infinity; else lastClk = e.clk;
      lastT = e.t; lastPer = e.per;
      if (e.type === 'five') on[e.team] = e.five.slice();
      if (e.type === 'sub') { if (on[e.team].indexOf(e.pout) < 0 || on[e.team].indexOf(e.pin) >= 0) bad.push('bad substitution at ' + e.i); on[e.team] = on[e.team].filter(function (x) { return x !== e.pout; }).concat([e.pin]); }
      if (on.A.length && on.H.length && (on.A.length !== 5 || on.H.length !== 5)) bad.push('not five a side at event ' + e.i);
      ['p', 'ast', 'blk', 'stl'].forEach(function (f) {
        var id = e[f]; if (!id) return;
        var side = id.slice(0, 1);
        if (on[side].indexOf(id) < 0 && e.type !== 'jump') bad.push(game.byId[id].name + ' in the play at event ' + e.i + ' while on the bench');
      });
      if (e.sc != null && (e.sc < -0.01 || e.sc > C.shot + 0.01)) bad.push('shot clock ' + e.sc + ' at ' + e.i);
      if (!(e.wp >= 0 && e.wp <= 1)) bad.push('win probability ' + e.wp + ' at ' + e.i);
    });
    var lastE = ev[ev.length - 1];
    if (!(lastE.wp === 0 || lastE.wp === 1)) bad.push('win probability does not end at 0 or 1');
    // possessions per period alternate, and no stretch runs over the shot clock
    game.poss.forEach(function (P) {
      var es = ev.slice(P.ev0, P.ev1 + 1).filter(function (e) { return e.sc != null; });
      es.forEach(function (e) { if (e.sc < 0) bad.push('shot clock violation not called'); });
    });
    // regulation tied when it went to overtime
    if (game.nOT) { var endReg = ev.filter(function (e) { return e.type === 'end' && e.per === C.per.length - 1; })[0]; if (!endReg || endReg.A !== endReg.H) bad.push('overtime game not tied after regulation'); }
    return bad;
  };

  // ── scenarios: which of the 10,000 games to replay ──────────────────────────────────────────────────────
  // legs: the user's saved picks / slip legs for this game (rows with sel, or {kind, mkt, name, line, side})
  SR.scenarios = function (ctx, legs) {
    var Dr = ctx.Dr, N = ctx.N, D = ctx.dist, out = [];
    var favA = D.muM >= 0;
    // each board player with a points draw: how far that game's numbers sit from his projection
    var fx = [];
    ['A', 'H'].forEach(function (s) { ctx.rost[s].forEach(function (p) { var fr = p.bp ? ctx.fixRows[p.bp.k] : null; if (fr) ['pts', 'reb', 'ast'].forEach(function (st) { if (fr[st]) fx.push([fr[st], p.proj[st], sd(st, p.proj[st])]); }); }); });
    function dev(k) { if (!fx.length) return 0; var s = 0; fx.forEach(function (f) { var z = (f[0][k] - f[1]) / f[2]; s += z * z; }); return s / fx.length; }
    function best(filter, center) {
      var cand = [];
      for (var k = 0; k < N; k++) {
        if (!filter(k)) continue;
        var m = Dr.sa[k] - Dr.sh[k], t = Dr.sa[k] + Dr.sh[k];
        var sc = Math.pow((m - center.m) / D.sdM, 2) + Math.pow((t - center.t) / D.sdT, 2) + 0.6 * dev(k);
        cand.push([sc, k]);
      }
      cand.sort(function (a, b) { return a[0] - b[0]; });
      // the closest few, then the one whose numbers fit together most naturally
      var top = cand.slice(0, 40).map(function (c) { return [c[0] + 0.5 * strain(ctx, c[1]), c[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
      return {list: top.map(function (c) { return c[1]; }), n: cand.length};
    }
    function med(filter, f) { var a = []; for (var k = 0; k < N; k++) if (filter(k)) a.push(f(k)); a.sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : null; }
    var all = function () { return true; };
    var regOnly = function (k) { return !Dr.ot[k]; };
    var lk = best(regOnly, {m: D.medM, t: D.medT});
    out.push({key: 'likely', title: 'Most likely', list: lk.list, n: lk.n, note: 'The game closest to the middle of all 10,000: the typical margin and total, with each player\'s numbers nearest his projection.'});
    var dogA = !favA, upset = function (k) { return dogA ? Dr.sa[k] > Dr.sh[k] : Dr.sh[k] > Dr.sa[k]; };
    var um = med(upset, function (k) { return Dr.sa[k] - Dr.sh[k]; });
    if (um != null) { var up = best(upset, {m: um, t: D.medT}); out.push({key: 'upset', title: 'Upset', list: up.list, n: up.n, note: 'The underdog wins: the most typical of the ' + up.n.toLocaleString() + ' games where it happened.'}); }
    var bl = Math.max(18, Math.abs(D.muM) + 12), blow = function (k) { var m = Dr.sa[k] - Dr.sh[k]; return favA ? m >= bl : -m >= bl; };
    var bm = med(blow, function (k) { return Dr.sa[k] - Dr.sh[k]; });
    if (bm != null) { var bo = best(blow, {m: bm, t: med(blow, function (k) { return Dr.sa[k] + Dr.sh[k]; })}); out.push({key: 'blowout', title: 'Blowout', list: bo.list, n: bo.n, note: 'The favorite wins by ' + Math.round(bl) + '+: ' + bo.n.toLocaleString() + ' of the 10,000 games.'}); }
    var ot = function (k) { return Dr.ot[k] > 0; };
    var om = med(ot, function (k) { return Dr.sa[k] - Dr.sh[k]; });
    if (om != null) { var o2 = best(ot, {m: om, t: med(ot, function (k) { return Dr.sa[k] + Dr.sh[k]; })}); out.push({key: 'ot', title: 'Overtime thriller', list: o2.list, n: o2.n, note: 'Tied after regulation: ' + o2.n.toLocaleString() + ' of the 10,000 games went to overtime.'}); }
    // your bets: every leg on this game hits (graded off the sim's own hit arrays where the board has them)
    var hitArr = (legs || []).map(function (l) { var x = l.sel && ctx.RES.byId[l.sel]; return x ? x.h : null; });
    if (legs && legs.length && hitArr.some(Boolean)) {
      var yb = function (k) { for (var q = 0; q < hitArr.length; q++) if (hitArr[q] && !hitArr[q][k]) return false; return true; };
      var ybm = med(yb, function (k) { return Dr.sa[k] - Dr.sh[k]; });
      if (ybm != null) { var y2 = best(yb, {m: ybm, t: med(yb, function (k) { return Dr.sa[k] + Dr.sh[k]; })}); out.push({key: 'bets', title: 'Your bets hit', list: y2.list, n: y2.n, legs: legs, note: 'Every one of your legs on this game cashes: ' + y2.n.toLocaleString() + ' of the 10,000 games.'}); }
      else out.push({key: 'bets', title: 'Your bets hit', list: [], n: 0, legs: legs, note: 'In none of the 10,000 games did all of your legs on this game hit together.'});
    }
    return out;
  };
  // the first game on a scenario's list that lays out cleanly (and, for your bets, cashes every leg in the replay)
  SR.pick = function (ctx, scen) {
    for (var q = 0; q < scen.list.length && q < 25; q++) {
      var g = SR.build(ctx, scen.list[q]);
      if (!g || !g.ok) continue;
      if (scen.key === 'bets' && scen.legs && scen.legs.some(function (l) { var s = SR.grade(l, g, g.events.length - 1).state; return s !== 'hit' && s !== 'unknown'; })) continue;
      g.scenario = scen.key; g.scenarioTitle = scen.title; g.scenarioNote = scen.note; g.rank = q;
      return g;
    }
    return null;
  };

  // ── the plays the sim likes: hit rate across all 10,000 against Onyx's price ─────────────────────────
  // only where the sim mirrors the model's own listed chance (within 4 points), as Play It Out's parlay builder: game
  // lines centered on the model's scores can read stronger than the blended chance the model lists, and that gap is
  // not value. Up to three; the ones that do not beat Onyx's price are marked as the closest to fair
  SR.likes = function (ctx) {
    var rows = (ctx.RES.props || []).filter(function (x) {
      var r = x.row; return r && r.sel && r.price != null && x.p != null && r.mkt !== 'first_basket' && (r.conf == null || Math.abs(x.p - r.conf) <= 0.04);
    });
    rows = rows.map(function (x) { var dec = x.row.price > 0 ? 1 + x.row.price / 100 : 1 + 100 / -x.row.price; return {row: x.row, p: x.p, imp: 1 / dec, ev: x.p * dec - 1, push: x.push || 0}; });
    rows.sort(function (a, b) { return b.ev - a.ev; });
    var list = rows.slice(0, 3); list.forEach(function (x) { x.beats = x.ev > 0; });
    return {beats: list.some(function (x) { return x.beats; }), all: list.every(function (x) { return x.beats; }), list: list};
  };

  SR._internal = {mulberry: mulberry, hash: hash, buildBox: buildBox, match: match, simValues: simValues};
})();
