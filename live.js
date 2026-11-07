// live.js - in-game fair chances for every game being played (Onyx Sports live tab, Ask Onyx "live").
//
// The models, per sport, from the game state (ESPN: score, period, clock) and the PREGAME Onyx
// line for that game (our boards: spread, total, moneyline), so a live chance always starts
// from what the market thought before kickoff and moves only with what has happened since:
//   football (NFL, college) and NBA: the rest of the game as a normal draw. Remaining home
//     margin ~ N(pregame expected margin x f, SD^2 x f) and remaining points ~ N(pregame total
//     x f, SD^2 x f), f = share of the game left (the total's pace blends in the pace this game has
//     shown, up to 60% late); SDs are each sport's full-game spread of
//     results (NFL 13.5 / 13.5, college 16 / 17, NBA 12.5 / 18).
//   NHL: goals for each side are Poisson for the time left; the two rates split the pregame
//     total so the pregame moneyline is matched (overtime a coin flip).
//   college basketball: the same normal draw, two 20-minute halves (SDs from 5,344 games against
//     Onyx's closing lines, 11.3 / 16.8, inflated by the in-game factor NBA's fit needed).
//   tennis: point -> game -> set -> match Markov chain (OnyxLive.tn). Each player's chance of winning
//     a point on serve is fitted so the chain's pre-match chance equals Onyx's pregame no-vig
//     moneyline (the blended chance: tennis blends at weight 0), Elo when unpriced, as two form
//     scenarios around a tour serve baseline fitted on ESPN set scores
//     (tools/tennis_live_backtest.py). The sets and games so far reweight the scenarios, then holds,
//     tiebreaks and sets are played out exactly from the current score and server: match winner,
//     game spread and total games. live_model.py is the same math in Python (the live logger).
// These are LEANS: no live model has been tested against Onyx's in-game prices yet, so the page
// says so and never calls one a pick.
(function () {
  // fitted 11/2 on 19,508 frozen moments from 1,391 finished games (tools/live_backtest.js, live_fit.js,
  // held-out half): the old 12.5 / 13.5 margin spreads were overconfident (we said 15%, underdogs won
  // 23-33%). NBA: worst calibration bucket 17% off -> 9%; NFL 18.5% -> 10%.
  // cbb (11/3): full-game residual SDs against Onyx's closing lines (bt/cbb_lines.json, 5,344 games:
  // margin 11.3, total 16.8) x the in-game inflation NBA's held-out fit needed (17 / 12.5, 21.6 / 18).
  // Not yet replayed in-game (tools/live_backtest.js has no college basketball play-by-play).
  var SD = {nfl: [16.5, 17.5], cfb: [16, 17], nba: [17, 21.6], cbb: [15.4, 20.2]};
  var LEN = {nfl: [4, 15], cfb: [4, 15], nba: [4, 12], nhl: [3, 20], cbb: [2, 20]};
  var PACE = {nfl: 0.4, cfb: 0.6, nba: 0.2, cbb: 0.2};
  var ML_PTS = {nfl: 10.8, cfb: 12.8, nba: 10, cbb: 11};   // points per unit of moneyline chance, when only a moneyline was saved
  var TOTK = {nfl: 1.02, cfb: 1, nba: 1, cbb: 1};   // scale on the points still to come   // most weight the game's own scoring pace gets on the total, late

  function erf(x) {   // Abramowitz-Stegun 7.1.26
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function noVig(a, b) {      // two American prices -> the first side's chance without the margin
    var i = function (p) { return p == null ? null : p < 0 ? -p / (-p + 100) : 100 / (p + 100); };
    var x = i(a), y = i(b);
    if (x == null) return null;
    return y == null ? x : x / (x + y);
  }
  function implied(p) { return p == null ? null : p < 0 ? -p / (-p + 100) : 100 / (p + 100); }

  // share of the game still to play, from ESPN's period and clock (seconds)
  function left(sport, period, clockSec) {
    var L = LEN[sport];
    if (!L || !period) return null;
    if (period > L[0]) return Math.max(0.004, (clockSec || 0) / 60 / (L[1] * L[0]));   // overtime
    var rem = (L[0] - period) * L[1] * 60 + (clockSec || 0);
    return Math.max(0.004, Math.min(1, rem / (L[0] * L[1] * 60)));
  }

  // normal model: chances for the home side and the over, from the score and the time left
  function normal(sport, g) {
    var sd = SD[sport], f = g.f;
    var mu = (g.pre_margin || 0) * f, sM = sd[0] * Math.sqrt(f);
    var cur = g.hs - g.as, tot = g.hs + g.as;
    // scoring for the time left: the pregame total's pace blended with the pace this game has shown,
    // trusted more as the game goes on (60% by the end); a 158-point pace in a 230 game is information
    var pace = f < 1 ? tot / (1 - f) : g.pre_total || 0, wo = Math.min(PACE[sport] || 0.6, (1 - f) * (PACE[sport] || 0.6));
    var mt = ((g.pre_total || 0) * (1 - wo) + pace * wo) * f * (TOTK[sport] || 1), sT = sd[1] * Math.sqrt(f);
    return {
      win: function () { return 1 - phi((-cur - mu) / sM); },                              // home wins
      cover: function (homeLine) { return 1 - phi((-homeLine - cur - mu) / sM); },        // home + line > 0
      over: function (line) { return 1 - phi((line - tot - mt) / sT); },
      proj_total: tot + mt, proj_margin: cur + mu,
    };
  }

  // NHL: Poisson goals for the time left
  function pois(l, k) { var p = Math.exp(-l); for (var i = 1; i <= k; i++) p *= l / i; return p; }
  function nhl(g) {
    var T = g.pre_total || 6.0, pH = g.pre_home_win == null ? 0.5 : g.pre_home_win;
    var lo = 0, hi = T, lh = T / 2;
    for (var it = 0; it < 40; it++) {       // split the total so the pregame moneyline holds (OT 50/50)
      lh = (lo + hi) / 2;
      if (winP(lh, T - lh, 0) < pH) lo = lh; else hi = lh;
    }
    var rh = lh * g.f, ra = (T - lh) * g.f, d = g.hs - g.as;
    function winP(a, b, lead) {
      var w = 0, t = 0;
      for (var i = 0; i < 12; i++) for (var j = 0; j < 12; j++) {
        var p = pois(a, i) * pois(b, j), m = lead + i - j;
        if (m > 0) w += p; else if (m === 0) t += p;
      }
      return w + 0.5 * t;
    }
    // final-score margin and total: a game tied after regulation goes to overtime or a shootout, and
    // the winner (a coin flip) gets one more goal on the final score, which decides puck lines and
    // totals (11/2 backtest on 500 games: without it, over and puck-line chances were up to 25% off)
    function tieP() { var s = 0; for (var i = 0; i < 12; i++) { var j = i + d; if (j >= 0 && j < 12) s += pois(rh, i) * pois(ra, j); } return s; }   // regulation ends level
    function distMargin(fn) {
      var s = 0;
      for (var i = 0; i < 12; i++) for (var j = 0; j < 12; j++) {
        var p = pois(rh, i) * pois(ra, j), m = d + i - j, t = g.hs + g.as + i + j;
        if (m !== 0) { if (fn(m, t)) s += p; }
        else { if (fn(1, t + 1)) s += p / 2; if (fn(-1, t + 1)) s += p / 2; }
      }
      return s;
    }
    return {
      win: function () { return winP(rh, ra, d); },
      cover: function (homeLine) { return distMargin(function (m) { return m + homeLine > 0; }) + 0.5 * distMargin(function (m) { return m + homeLine === 0; }); },
      over: function (line) { return distMargin(function (m, t) { return t > line; }); },
      proj_total: g.hs + g.as + rh + ra + tieP(), proj_margin: d + rh - ra,
    };
  }

  // ── tennis: point -> game -> set -> match (the match center on tennis.html runs the same chain) ──
  // TN_P: tour point-on-serve baselines and the form gap between the two scenarios, fitted by the
  // likelihood of every set score on 2025 ATP / WTA matches, grid of 5 x 5 on 800 matches a tour
  // (tools/tennis_live_backtest.py, 11/3; was .64 / .56 and .034 from tennis_model v2). Judged on
  // 4,000 2026 matches it never saw (data/tennis/live_backtest.json): at every set boundary Brier
  // .1695 vs .2244 for the pregame chance alone; inside sets (game order reconstructed) .1622 vs .2217
  // and vs .1898 for the old sets-only model; calibrated within 3 points in every 10% band.
  var TN_P = {base_atp: 0.62, base_wta: 0.54, form_atp: 0.02, form_wta: 0.034};
  var TN_SLAM = /australian open|roland|french open|wimbledon|us open/i;
  function tnHold(p) { var q = 1 - p; return Math.pow(p, 4) * (1 + 4 * q + 10 * q * q) + 20 * Math.pow(p, 3) * Math.pow(q, 3) * (p * p / (1 - 2 * p * q)); }
  function tnTB(a, b) {   // first server wins the 7-point tiebreak; a, b: each server's point-on-serve chance
    var M = {};
    function f(x, y) {
      if (x >= 7 && x - y >= 2) return 1; if (y >= 7 && y - x >= 2) return 0;
      if (x >= 6 && x === y) { var w = a * (1 - b), l = (1 - a) * b; return w / (w + l); }
      var k = x * 20 + y; if (k in M) return M[k];
      var pw = Math.floor((x + y + 1) / 2) % 2 === 0 ? a : 1 - b;
      return (M[k] = pw * f(x + 1, y) + (1 - pw) * f(x, y + 1));
    }
    return f(0, 0);
  }
  function setDone(a, b) { return ((a >= 6 || b >= 6) && Math.abs(a - b) >= 2) || a === 7 || b === 7; }
  // every way a set can finish from (a0, b0) with s0 serving: {w: winner, g: set games, d: set margin, nx: next set's server, p}
  function tnSet(a0, b0, s0, pt, H) {
    H = H || [tnHold(pt[0]), tnHold(pt[1])];
    var M = {}, tb = [tnTB(pt[0], pt[1]), tnTB(pt[1], pt[0])];
    function f(a, b, s) {
      var k = a * 100 + b * 10 + s; if (M[k]) return M[k];
      var o = {};
      if (setDone(a, b)) o[(a > b ? 0 : 1) + '|' + (a + b) + '|' + (a - b) + '|' + s] = 1;
      else if (a === 6 && b === 6) { var w0 = s === 0 ? tb[0] : 1 - tb[1]; o['0|13|1|' + (1 - s)] = w0; o['1|13|-1|' + (1 - s)] = 1 - w0; }
      else {
        var h = H[s], A = f(a + 1, b, 1 - s), B = f(a, b + 1, 1 - s), pa = s === 0 ? h : 1 - h, kk;
        for (kk in A) o[kk] = (o[kk] || 0) + pa * A[kk];
        for (kk in B) o[kk] = (o[kk] || 0) + (1 - pa) * B[kk];
      }
      return (M[k] = o);
    }
    var R = f(a0, b0, s0), out = [];
    for (var key in R) { var v = key.split('|').map(Number); out.push({w: v[0], g: v[1], d: v[2], nx: v[3], p: R[key]}); }
    return out;
  }
  // from sets (sa, sb), games (ga, gb) in the set in play and srv serving (null: unknown, both averaged):
  // P(player 0 wins) and the rest of the match as [games from the start of the set in play, margin, p]
  function tnRun(sa, sb, ga, gb, srv, pt, need) {
    if (sa >= need || sb >= need) return {win: sa >= need ? 1 : 0, dist: [[0, 0, 1]]};   // already decided
    if (srv == null) {
      var r0 = tnRun(sa, sb, ga, gb, 0, pt, need), r1 = tnRun(sa, sb, ga, gb, 1, pt, need);
      return {win: (r0.win + r1.win) / 2, dist: r0.dist.map(function (x) { return [x[0], x[1], x[2] / 2]; }).concat(r1.dist.map(function (x) { return [x[0], x[1], x[2] / 2]; }))};
    }
    var H = [tnHold(pt[0]), tnHold(pt[1])], fresh = {};
    function setD(a, b, s) { return (a || b) ? tnSet(a, b, s, pt, H) : (fresh[s] = fresh[s] || tnSet(0, 0, s, pt, H)); }
    // set by set, merging equal states (sets, server, games so far, margin) so best of five stays small
    var win = 0, end = {}, cur = {}, first = true;
    cur[sa + '|' + sb + '|' + srv + '|0|0'] = 1;
    while (Object.keys(cur).length) {
      var nxt = {};
      for (var k in cur) {
        var v = k.split('|').map(Number), p = cur[k], D = setD(first ? ga : 0, first ? gb : 0, v[2]);
        for (var i = 0; i < D.length; i++) {
          var o = D[i], nx = v[0] + (o.w === 0 ? 1 : 0), ny = v[1] + (o.w === 1 ? 1 : 0), q = p * o.p, g = v[3] + o.g, d = v[4] + o.d;
          if (nx === need || ny === need) { if (nx === need) win += q; var ek = g + '|' + d; end[ek] = (end[ek] || 0) + q; }
          else { var k2 = nx + '|' + ny + '|' + o.nx + '|' + g + '|' + d; nxt[k2] = (nxt[k2] || 0) + q; }
        }
      }
      cur = nxt; first = false;
    }
    var dist = [];
    for (var e in end) { var z = e.split('|').map(Number); dist.push([z[0], z[1], end[e]]); }
    return {win: win, dist: dist};
  }
  // win chance from 0-0 (fast: used to fit the serve rates)
  function tnWin(pt, need) {
    var H = [tnHold(pt[0]), tnHold(pt[1])], T = [0, 1].map(function (s) {
      var o = {}; tnSet(0, 0, s, pt, H).forEach(function (x) { var k = x.w + '|' + x.nx; o[k] = (o[k] || 0) + x.p; }); return o; });
    var M = {};
    function f(x, y, s) {
      if (x === need) return 1; if (y === need) return 0;
      var k = x * 100 + y * 10 + s; if (k in M) return M[k];
      var v = 0; for (var kk in T[s]) { var a = kk.split('|').map(Number); v += T[s][kk] * f(x + (a[0] === 0 ? 1 : 0), y + (a[0] === 1 ? 1 : 0), a[1]); }
      return (M[k] = v);
    }
    return (f(0, 0, 0) + f(0, 0, 1)) / 2;
  }
  function tnBase(tour) { return String(tour || '').toUpperCase() === 'WTA' ? [TN_P.base_wta, TN_P.form_wta] : [TN_P.base_atp, TN_P.form_atp]; }
  // the two form scenarios (favourite sharp, favourite flat) whose average pre-match chance is p
  var TN_FIT = {};
  function tnFit(p, need, base, sg) {
    var key = [p, need, base, sg].join('|'); if (TN_FIT[key]) return TN_FIT[key];
    var lo = -0.3, hi = 0.3;
    for (var i = 0; i < 18; i++) { var d = (lo + hi) / 2; if ((tnWin([base + d + sg, base - d - sg], need) + tnWin([base + d - sg, base - d + sg], need)) / 2 < p) lo = d; else hi = d; }
    var m = (lo + hi) / 2;
    return (TN_FIT[key] = [[base + m + sg, base - m - sg], [base + m - sg, base - m + sg]]);
  }
  // how likely a set score was under one scenario: a finished set (a, b), or reaching (a, b) mid-set
  function tnSetLik(a, b, fin, s0, pt) {
    var H = [tnHold(pt[0]), tnHold(pt[1])];
    function one(s) {
      if (fin) return tnSet(0, 0, s, pt, H).reduce(function (x, o) { return x + (o.g === a + b && o.d === a - b ? o.p : 0); }, 0);
      var R = {'0|0': 1};
      for (var n = 0; n < a + b; n++) for (var x = 0; x <= n; x++) {
        var y = n - x, p = R[x + '|' + y]; if (!p || x > a || y > b || setDone(x, y)) continue;
        var sv = n % 2 === 0 ? s : 1 - s, h = H[sv], pa = sv === 0 ? h : 1 - h;
        R[(x + 1) + '|' + y] = (R[(x + 1) + '|' + y] || 0) + p * pa; R[x + '|' + (y + 1)] = (R[x + '|' + (y + 1)] || 0) + p * (1 - pa);
      }
      return R[a + '|' + b] || 0;
    }
    return s0 == null ? (one(0) + one(1)) / 2 : one(s0);
  }
  // the score as the chain reads it. sets: [[games p0, games p1], ...] (the last may be in play); srv: 0 / 1 / null
  function tnState(sets, srv, final) {
    var S = [], sa = 0, sb = 0, base = 0, diff = 0, G = 0;
    (sets || []).forEach(function (x, j) {
      var a = +x[0] || 0, b = +x[1] || 0, fin = setDone(a, b) || (final && j === sets.length - 1);
      S.push([a, b, fin]); G += a + b;
      if (fin) { if (a > b) sa++; else sb++; base += a + b; diff += a - b; }
    });
    var cur = S.length && !S[S.length - 1][2] ? S[S.length - 1] : null;
    return {sets: S, sa: sa, sb: sb, ga: cur ? cur[0] : 0, gb: cur ? cur[1] : 0, srv: srv == null ? null : srv, G: G, base: base, diff: diff};
  }
  // scenario weights after the sets seen so far; who served each set comes from the server now and the games played
  function tnPost(sc, st) {
    var w = sc.map(function (pt) {
      var L = 0.5, off = 0;
      st.sets.forEach(function (x) {
        var s0 = st.srv == null ? null : ((st.G - off) % 2 === 0 ? st.srv : 1 - st.srv);
        L *= tnSetLik(x[0], x[1], x[2], s0, pt); off += x[0] + x[1];
      });
      return L;
    });
    var t = w[0] + w[1]; return t > 0 ? [w[0] / t, w[1] / t] : [0.5, 0.5];
  }
  // g: {st: tnState(...), need: sets to win, pre_home_win, tour}; games markets are for the whole match
  function tennis(g) {
    var bs = tnBase(g.tour), need = g.need || 2, st = g.st || tnState([]);
    var sc = g.sc || tnFit(g.pre_home_win == null ? 0.5 : g.pre_home_win, need, bs[0], bs[1]);
    var w = st.G ? tnPost(sc, st) : [0.5, 0.5], win = 0, dist = [];
    sc.forEach(function (pt, k) {
      var r = tnRun(st.sa, st.sb, st.ga, st.gb, st.srv, pt, need); win += w[k] * r.win;
      r.dist.forEach(function (x) { dist.push([st.base + x[0], st.diff + x[1], x[2] * w[k]]); });
    });
    var pt_ = 0, pm = 0; dist.forEach(function (x) { pt_ += x[0] * x[2]; pm += x[1] * x[2]; });
    function sum(fn) { var s = 0; for (var i = 0; i < dist.length; i++) if (fn(dist[i])) s += dist[i][2]; return s; }
    return {win: function () { return win; },
            cover: function (homeLine) { return sum(function (x) { return x[1] + homeLine > 0; }) + 0.5 * sum(function (x) { return x[1] + homeLine === 0; }); },
            over: function (line) { return sum(function (x) { return x[0] > line; }); },
            proj_total: pt_, proj_margin: pm, w: w, st: st, need: need};
  }
  var tn = {hold: tnHold, tb: tnTB, set: tnSet, run: tnRun, win: tnWin, fit: tnFit, setLik: tnSetLik, state: tnState, post: tnPost, base: tnBase, done: setDone, P: TN_P, SLAM: TN_SLAM};

  function model(sport, g) {
    if (sport === 'tennis') return tennis(g);
    if (sport === 'nhl') return nhl(g);
    if (SD[sport]) return normal(sport, g);
    return null;
  }

  // every side Onyx prices live on this game, with the model's chance and the edge against
  // Onyx's live price (its own chance less nothing: the edge is model minus the price's implied)
  function plays(sport, g, lines) {
    var m = model(sport, g); if (!m) return [];
    var out = [];
    function add(kind, label, side, price, prob, sel, line) {
      if (price == null || prob == null || isNaN(prob)) return;
      out.push({sport: sport, kind: kind, label: label, side: side, price: price, line: line, sel: sel || null,
                conf: Math.round(prob * 1000) / 1000, edge: Math.round((prob - implied(price)) * 1000) / 1000});
    }
    var H = g.home, A = g.away;
    if (lines.ml) {
      var pw = m.win();
      add('ml', H + ' to win', 'home', lines.ml.home, pw, lines.ml.home_sel);
      add('ml', A + ' to win', 'away', lines.ml.away, 1 - pw, lines.ml.away_sel);
    }
    if (lines.spread && m.cover && lines.spread.home_line != null) {
      var pc = m.cover(lines.spread.home_line), hl = lines.spread.home_line;
      add('spread', H + ' ' + (hl > 0 ? '+' : '') + hl, 'home', lines.spread.home, pc, lines.spread.home_sel, hl);
      add('spread', A + ' ' + (-hl > 0 ? '+' : '') + (-hl), 'away', lines.spread.away, 1 - pc, lines.spread.away_sel, -hl);
    }
    if (lines.total && m.over && lines.total.line != null) {
      var po = m.over(lines.total.line);
      add('total', 'Over ' + lines.total.line, 'over', lines.total.over, po, lines.total.over_sel, lines.total.line);
      add('total', 'Under ' + lines.total.line, 'under', lines.total.under, 1 - po, lines.total.under_sel, lines.total.line);
    }
    return out;
  }

  // ── every game in progress, every sport: ESPN state + our pregame line -> live numbers ──
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
  var LEAGUES = [['nfl', 'football/nfl'], ['cfb', 'football/college-football'], ['nba', 'basketball/nba'], ['nhl', 'hockey/nhl'],
                 ['cbb', 'basketball/mens-college-basketball'], ['tennis', 'tennis/atp'], ['tennis', 'tennis/wta']];
  var SBQ = {cfb: '?groups=80', cbb: '?groups=50&limit=400'};
  var DEF_TOTAL = {nfl: 44, cfb: 54, nba: 228, nhl: 6, cbb: 145};
  var ELO = null;   // data/tennis/elo.json: the pre-match chance when Onyx had no price on a match
  var BOARD = {}, PRE = {}, BOARD_AT = 0;
  function getJSON(u) { return fetch(u, {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  function boards() {
    if (Date.now() - BOARD_AT < 10 * 60e3) return Promise.resolve(BOARD);
    return Promise.all(['nfl', 'cfb', 'nba', 'nhl', 'cbb', 'tennis'].map(function (k) {
      return Promise.all([k === 'tennis' && !ELO ? getJSON('data/tennis/elo.json').then(function (j) { ELO = (j && j.r) || {}; }).catch(function () { ELO = {}; }) : null,
        getJSON('data/' + k + '/board.json').then(function (j) { BOARD[k] = j.plays || []; }).catch(function () { BOARD[k] = BOARD[k] || []; }),
        getJSON('data/' + k + '/pregame.json').then(function (j) { PRE[k] = j || {}; }).catch(function () { PRE[k] = PRE[k] || {}; })]);
    })).then(function () { BOARD_AT = Date.now(); return BOARD; });
  }
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  // the pregame Onyx line for a game: home expected margin, total, home win chance.
  // data/<sport>/pregame.json keeps each game's last line from before its start (the board
  // drops a game once it starts); the board is the fallback. Spreads come from the label
  // ("NE -7"), which is always the team's own handicap.
  var NUM = /([+-]?\d+(?:\.\d+)?)\s*$/;
  function sameGame(m, home, away) { return m === away + ' @ ' + home || m === home + ' vs ' + away || m === away + ' vs ' + home; }
  function pregame(sport, rows, home, away, pre) {
    var out = {margin: null, total: null, home_win: null, spread_txt: null, total_txt: null};
    var hit = null;
    Object.keys(pre || {}).forEach(function (k) { if (sameGame(pre[k].m, home, away)) hit = pre[k]; });
    var sp = {}, ml = {}, tot = null;
    if (hit) { sp = hit.sp || {}; ml = hit.ml || {}; tot = hit.tot; out.pp = hit.pp || null; out.src = hit.src || 'onyx'; }
    else rows.forEach(function (p) {
      if (p.kind === 'prop' || !sameGame(p.matchup, home, away)) return;
      if (p.kind === 'spread') { var m = NUM.exec(String(p.label || '')); if (m) sp[p.name] = +m[1]; }
      else if (p.kind === 'total' && p.line != null) tot = p.line;
      else if (p.kind === 'ml' && p.price != null) ml[p.name] = p.price;
      if (p.src === 'market') out.src = 'market';
    });
    var hn = Object.keys(sp).filter(function (n) { return n === home || nk(n) === nk(home); })[0];
    var an = Object.keys(sp).filter(function (n) { return n === away || nk(n) === nk(away); })[0];
    var hl = hn != null ? sp[hn] : an != null ? -sp[an] : null;
    if (hl != null) { out.margin = -hl; out.spread_txt = home + ' ' + (hl > 0 ? '+' + hl : hl === 0 ? 'pk' : hl); }
    if (tot != null) { out.total = tot; out.total_txt = String(tot); }
    var mh = Object.keys(ml).filter(function (n) { return n === home || nk(n) === nk(home); })[0];
    var ma = Object.keys(ml).filter(function (n) { return n === away || nk(n) === nk(away); })[0];
    out.home_ml = mh != null ? ml[mh] : null; out.away_ml = ma != null ? ml[ma] : null;
    if (mh != null) out.home_win = noVig(ml[mh], ma != null ? ml[ma] : null);
    else if (ma != null) out.home_win = 1 - noVig(ml[ma], null);
    return out;
  }
  function team(c) { var t = c.team || {}; return t.abbreviation || (c.athlete || {}).displayName || t.displayName; }
  function full(c) { var t = c.team || {}, a = c.athlete || {}; return t.displayName || a.displayName || t.abbreviation || ''; }
  function logo(c) { var t = c.team || {}, a = c.athlete || {}; return t.logo || (t.logos && t.logos[0] && t.logos[0].href) || (a.flag && a.flag.href) || null; }
  // a probability as an American price, rounded to 5
  function american(p) {
    if (p == null || p <= 0 || p >= 1) return null;
    var x = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    x = Math.round(x / 5) * 5;
    return x === -100 ? 100 : x;
  }
  // the one bet the card leads with: the side whose chance moved our way since the start (moneyline,
  // while it is still a bettable price), else the total against Onyx's pregame number. Started (Onyx
  // before the game), now (our live number), fair (the price or line where it turns into a good bet).
  function lean(x) {
    var pre = x.pre || {}, hw = x.home_win;
    if (hw == null || isNaN(hw)) return null;
    if (pre.home_win == null && pre.total == null) return {kind: 'none', why: 'nopre'};   // no starting line: nothing to measure from
    var up = pre.home_win != null ? (hw >= pre.home_win ? 'home' : 'away') : (hw >= 0.5 ? 'home' : 'away');
    var p = up === 'home' ? hw : 1 - hw;
    if (pre.home_win != null && p >= 0.08 && p <= 0.93) {
      var p0 = pre.home_win == null ? null : up === 'home' ? pre.home_win : 1 - pre.home_win;
      return {kind: 'ml', side: up, team: up === 'home' ? x.home : x.away, logo: up === 'home' ? x.hl : x.al,
              start: p0, start_price: up === 'home' ? pre.home_ml : pre.away_ml, now: p, fair: american(p)};
    }
    if (x.proj_total != null && pre.total != null && Math.abs(x.proj_total - pre.total) >= 1) {
      var under = x.proj_total < pre.total, fl = Math.round(x.proj_total * 2) / 2;
      return {kind: 'total', side: under ? 'under' : 'over', start: pre.total, now: x.hs + x.as, fair: fl,
              chance: x.over_pre == null ? null : under ? 1 - x.over_pre : x.over_pre};
    }
    return null;
  }
  // one live game -> what the page shows
  // tennis names the way tennis_model keys its ratings (sports_common.nk)
  function enk(n) { return String(n || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[.\u2019'\-]/g, ' ').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function game(sport, e, c, rows, pre0, gname) {
    var st = (c.status || e.status || {}), ty = st.type || {};
    if (ty.state !== 'in') return null;
    var H = {}, cs = c.competitors || [];
    cs.forEach(function (x) { H[x.homeAway || (x.order === 1 ? 'home' : 'away')] = x; });
    if (!H.home || !H.away) { H.away = cs[0]; H.home = cs[1]; }
    if (!H.home || !H.away) return null;
    var home = team(H.home), away = team(H.away), g;
    if (sport === 'tennis') {
      // sets as the feed shows them (the last may be in play), the server, best of 3 or 5 (men at the Slams)
      var la = H.home.linescores || [], lb = H.away.linescores || [], sets = la.map(function (l, i) { return [+l.value || 0, +((lb[i] || {}).value) || 0]; });
      var srv = H.home.possession ? 0 : H.away.possession ? 1 : null, women = /women/i.test(gname || '');
      var need = !women && TN_SLAM.test(e.name || '') ? 3 : 2, st = tnState(sets, srv);
      var pg = pregame(sport, rows, home, away, pre0), src = pg.home_win != null ? 'Onyx' : null;
      if (pg.home_win == null && ELO) {   // no Onyx price saved: Elo, both players rated on 10+ matches
        var ra = ELO[enk(full(H.home))], rb = ELO[enk(full(H.away))];
        if (ra && rb && ra[1] >= 10 && rb[1] >= 10) { pg.home_win = 1 / (1 + Math.pow(10, (rb[0] - ra[0]) / 400)); src = 'Elo'; }
      }
      g = {st: st, need: need, tour: women ? 'WTA' : 'ATP', pre_home_win: pg.home_win, home: home, away: away};
      var m = model('tennis', g);
      var tx = {sport: sport, gid: c.id || e.id, home: home, away: away, hl: logo(H.home), al: logo(H.away), hs: st.sa, as: st.sb,
              state: sets.map(function (x) { return x[1] + '-' + x[0]; }).join(' '), games: [st.ga, st.gb], srv: srv, need: need, pre_src: src,
              detail: ty.shortDetail || ty.detail || '', home_win: m.win(), pre: pg, f: null, name: away + ' vs ' + home,
              proj_total: Math.round(m.proj_total * 10) / 10, fair_spread: home + ' ' + sgn(Math.round(-m.proj_margin * 2) / 2) + ' games',
              over_pre: pg.total != null ? m.over(pg.total) : null};
      tx.M = m; tx.hn = full(H.home); tx.an = full(H.away); tx.lean = lean(tx); return tx;
    }
    var hs = +H.home.score || 0, as = +H.away.score || 0, f = left(sport, st.period, st.clock);
    if (f == null) return null;
    var pre = pregame(sport, rows, home, away, pre0);
    g = {hs: hs, as: as, f: f, pre_margin: pre.margin != null ? pre.margin : pre.home_win != null && sport !== 'nhl' ? (pre.home_win - 0.5) * 2 * ML_PTS[sport] : 0,
         pre_total: pre.total != null ? pre.total : DEF_TOTAL[sport], pre_home_win: pre.home_win != null ? pre.home_win : 0.5, home: home, away: away};
    var M = model(sport, g);
    var r2 = function (x) { return Math.round(x * 2) / 2; };
    var pm = M.proj_margin, fair = r2(-pm);
    var gx = {sport: sport, gid: e.id, home: home, away: away, hl: logo(H.home), al: logo(H.away), hs: hs, as: as, detail: ty.shortDetail || ty.detail || '', f: f,
            home_win: M.win(), proj_total: M.proj_total != null ? Math.round(M.proj_total * 10) / 10 : null,
            fair_spread: home + ' ' + (fair > 0 ? '+' : fair === 0 ? '' : '') + (fair === 0 ? 'pk' : fair), pre: pre,
            over_pre: pre.total != null && M.over ? M.over(pre.total) : null, name: away + ' @ ' + home};
    gx.M = M; gx.hn = full(H.home); gx.an = full(H.away); gx.lean = lean(gx); return gx;
  }

  // ── the live line (relay GET /live, the odds feed's in-game prices, never named) and every bet
  // we can price against it: sides, spreads and totals from the game models; player props from
  // the player's live box line plus our pregame projection for the time left ──
  var RELAY = null;
  function relay() {
    if (RELAY) return RELAY;
    RELAY = getJSON('ai.json').then(function (j) { return (j && j.url) || null; }).catch(function () { return null; });
    return RELAY;
  }
  function lines(sport) {
    return relay().then(function (u) { return u ? getJSON(u.replace(/\/$/, '') + '/live?sport=' + sport) : {games: []}; })
      .then(function (j) { return (j && j.games) || []; }).catch(function () { return []; });
  }
  function pn(n) { return nk(n).replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim(); }
  function sameTeam(a, b) {
    a = nk(a); b = nk(b);
    if (!a || !b) return false;
    if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    // "LA Clippers" / "Los Angeles Clippers": same nickname, both multi-word team names
    var x = a.split(' '), y = b.split(' ');
    return x.length > 1 && y.length > 1 && x[x.length - 1] === y[y.length - 1] && x[x.length - 1].length > 3;
  }
  // the live box: player name -> stats we price ({pts, reb, ast, threes} or {rec, rec_yds, rush_yds, pass_yds, td})
  var SUMPATH = {nfl: 'football/nfl', cfb: 'football/college-football', nba: 'basketball/nba'};
  function box(sport, gid) {
    if (!SUMPATH[sport]) return Promise.resolve({});
    return getJSON(ESPN + SUMPATH[sport] + '/summary?event=' + gid).then(function (j) {
      var out = {};
      ((j.boxscore || {}).players || []).forEach(function (t) {
        (t.statistics || []).forEach(function (cat) {
          var keys = cat.keys || [], lab = (cat.labels || []).map(function (x) { return String(x).toUpperCase(); }), nm = String(cat.name || '').toLowerCase();
          (cat.athletes || []).forEach(function (a) {
            var n = pn((a.athlete || {}).displayName), st = a.stats || [], o = out[n] || (out[n] = {});
            var at = function (k, l) { var i = keys.indexOf(k); if (i < 0 && l) i = lab.indexOf(l); return i >= 0 ? st[i] : null; };
            var num = function (v) { var x = parseFloat(String(v == null ? '' : v).split('-')[0]); return isNaN(x) ? null : x; };
            if (sport === 'nba') {
              if (a.didNotPlay) return;
              o.pts = num(at('points', 'PTS')); o.reb = num(at('rebounds', 'REB')); o.ast = num(at('assists', 'AST'));
              o.threes = num(at('threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'));
              o.fouls = num(at('fouls', 'PF'));
            } else if (nm === 'passing') { o.pass_yds = num(at('passingYards', 'YDS')); o.td = (o.td || 0); }
            else if (nm === 'rushing') { o.rush_yds = num(at('rushingYards', 'YDS')); o.td = (o.td || 0) + (num(at('rushingTouchdowns', 'TD')) || 0); }
            else if (nm === 'receiving') { o.rec = num(at('receptions', 'REC')); o.rec_yds = num(at('receivingYards', 'YDS')); o.td = (o.td || 0) + (num(at('receivingTouchdowns', 'TD')) || 0); }
          });
        });
      });
      return out;
    }).catch(function () { return {}; });
  }
  // variance of what a player adds per unit of their pregame projection (a count-like stat), and a
  // floor; football yards use a wider, proportional spread
  var FMIN = {nfl: 0.15, cfb: 0.15, nba: 0.15, nhl: 0.15, cbb: 0.15};
  var PVAR = {pts: 2.4, reb: 1.6, ast: 1.6, threes: 1.3, rec: 1.3};
  function propP(mkt, cur, proj, f, line) {
    var rem = Math.max(0, proj * f), mean = cur + rem, sd;
    if (/yds$/.test(mkt)) sd = (0.45 * proj + 12) * Math.sqrt(f);
    else sd = Math.sqrt(Math.max(0.15, rem * (PVAR[mkt] || 1.5)));
    sd = Math.max(sd, 0.35);
    return 1 - phi((line - mean) / sd);       // lines are x.5, so this is P(stat >= line + 0.5)
  }
  function price(p) { return american(p); }
  // all bets on one game against the live line, best value first
  function bets(g, L, bx) {
    var out = [], M = g.M, pre = g.pre || {}, f = g.f, ten = g.sport === 'tennis';
    if (!M || !L) return out;
    function add(o) {
      if (o.p == null || isNaN(o.p) || o.price == null) return;
      o.p = Math.min(0.995, Math.max(0.005, o.p));
      o.fair = price(o.p); o.edge = Math.round((o.p - implied(o.price)) * 1000) / 1000;
      if (o.p < 0.03 || o.p > 0.97) return;               // decided: nothing worth betting
      if (o.price < -500 || o.price > 500) return;
      // where the model is blind: late in a game (who has the ball, timeouts and fouls decide it, and
      // the live line sees them) and anywhere we disagree with the live line by more than 12 points
      // (11/1 first run: every 20-50 point "edge" was a late football game the model misread)
      if (f != null && f < (o.kind === 'prop' ? 0.08 : FMIN[g.sport] || 0.15)) return;
      if (o.edge > 0.12) return;
      if (PAUSED[g.sport + '|' + o.kind]) return;
      o.ok = !ten || o.p >= TN_CONF;
      out.push(o);
    }
    var homeSel = function (sel) { return sameTeam(sel, g.hn) || sameTeam(sel, g.home); };
    L.lines.forEach(function (x) {
      if (x.m === 'ml' && M.win) {
        var h = homeSel(x.sel), pw = M.win();
        add({kind: 'ml', team: h ? g.home : g.away, logo: h ? g.hl : g.al, label: (h ? g.home : g.away) + ' to win', p: h ? pw : 1 - pw, price: x.price,
             start: h ? pre.home_ml : pre.away_ml, start_txt: (h ? pre.home_ml : pre.away_ml) != null ? fmt(h ? pre.home_ml : pre.away_ml) : null});
      } else if (x.m === 'spread' && M.cover && x.pt != null) {
        var hs = homeSel(x.sel), hl = hs ? x.pt : -x.pt, pc = M.cover(hl);
        var hp = pre.margin != null ? -pre.margin : null, sp0 = hp == null ? null : hs ? hp : -hp;
        add({kind: 'spread', team: hs ? g.home : g.away, logo: hs ? g.hl : g.al, label: (hs ? g.home : g.away) + ' ' + sgn(x.pt) + (ten ? ' games' : ''), p: hs ? pc : 1 - pc, price: x.price,
             start_txt: sp0 == null ? null : ten ? sgn(sp0) + ' games' : (hs ? g.home : g.away) + ' ' + sgn(sp0)});   // tennis: names are long, the box is narrow
      } else if (x.m === 'total' && M.over && x.pt != null && (x.side === 'over' || x.side === 'under')) {
        var po = M.over(x.pt);
        add({kind: 'total', label: (x.side === 'over' ? 'Over ' : 'Under ') + x.pt + (ten ? ' games' : ''), p: x.side === 'over' ? po : 1 - po, price: x.price,
             start_txt: pre.total != null ? (x.side === 'over' ? 'o' : 'u') + pre.total : null});
      } else if (bx && pre.pp && f != null) {
        var key = Object.keys(pre.pp).filter(function (k) { var a = k.split('|'); return a[1] === x.m && pn(a[0]) === pn(x.sel); })[0];
        if (!key) return;
        var q = pre.pp[key], me = bx[pn(x.sel)] || {}, nm = key.split('|')[0];
        if (x.m === 'anytime_td') {
          if ((me.td || 0) >= 1 || q.lam == null) return;     // already scored: the bet is settled
          add({kind: 'prop', mkt: x.m, player: nm, label: nm + ' anytime TD', p: 1 - Math.exp(-q.lam * f), price: x.price,
               start: q.o, start_txt: q.o != null ? fmt(q.o) : null});
          return;
        }
        if (q.j == null || x.pt == null || (x.side !== 'over' && x.side !== 'under')) return;
        var cur = me[x.m]; if (cur == null) cur = 0;
        if (me.fouls != null && me.fouls >= 6) return;          // fouled out
        var pov = propP(x.m, cur, q.j, f, x.pt), sd0 = x.side === 'over' ? q.o : q.u;
        add({kind: 'prop', mkt: x.m, player: nm, label: nm + ' ' + (x.side === 'over' ? 'over ' : 'under ') + x.pt + ' ' + MKN[x.m], p: x.side === 'over' ? pov : 1 - pov,
             price: x.price, cur: cur, start: sd0, start_txt: q.l != null && sd0 != null ? (x.side === 'over' ? 'o' : 'u') + q.l + ' ' + fmt(sd0) : null});
      }
    });
    // tennis: the most confident pick first (11/4, Jordan), every other sport the biggest edge
    return out.sort(function (a, b) { return (isVal(b) - isVal(a)) || (ten ? b.p - a.p : 0) || b.edge - a.edge; });
  }
  var MKN = {pts: 'points', reb: 'rebounds', ast: 'assists', threes: 'threes', rec: 'catches', rec_yds: 'receiving yds', rush_yds: 'rushing yds', pass_yds: 'passing yds'};
  function fmt(x) { return x == null ? '' : x > 0 ? '+' + x : String(x); }
  function sgn(x) { return x > 0 ? '+' + x : x === 0 ? 'pk' : String(x); }
  // attach .bets (best value first) to every live game; games without a live line keep bets = null
  function withBets(G) {
    var sports = G.map(function (g) { return g.sport; }).filter(function (s, i, a) { return a.indexOf(s) === i; });
    var led = sports.indexOf('tennis') >= 0 ? ledger() : Promise.resolve(null);
    return led.then(function () { return Promise.all(sports.map(lines)); }).then(function (LS) {
      var all = [].concat.apply([], LS);
      return Promise.all(G.map(function (g) {
        var L = all.filter(function (x) { return (sameTeam(x.home, g.hn) && sameTeam(x.away, g.an)) || (sameTeam(x.home, g.an) && sameTeam(x.away, g.hn)); })[0];
        g.L = L || null;
        if (!L) { g.bets = null; return g; }
        var needBox = g.pre && g.pre.pp && L.lines.some(function (x) { return !/^(ml|spread|total)$/.test(x.m); });
        return (needBox ? box(g.sport, g.gid) : Promise.resolve(null)).then(function (bx) { g.bets = bets(g, L, bx); return g; });
      }));
    });
  }

  // every live game across the sports (optionally only some sports)
  function games(only) {
    var L = LEAGUES.filter(function (l) { return !only || only.indexOf(l[0]) >= 0; });
    return boards().then(function (B) {
      return Promise.all(L.map(function (l) {
        return getJSON(ESPN + l[1] + '/scoreboard' + (SBQ[l[0]] || '')).then(function (j) {
          var out = [];
          (j.events || []).forEach(function (e) {
            if (l[0] === 'tennis') ((e.groupings || []).forEach(function (gr) { var gn = (gr.grouping || {}).displayName || ''; if (!/singles/i.test(gn)) return;
              (gr.competitions || []).forEach(function (c) { var x = game('tennis', e, c, B.tennis || [], PRE.tennis, gn); if (x) out.push(x); }); }));
            else { var x = game(l[0], e, (e.competitions || [{}])[0], B[l[0]] || [], PRE[l[0]]); if (x) out.push(x); }
          });
          return out;
        }).catch(function () { return []; });
      })).then(function (a) { return withBets([].concat.apply([], a)); });
    });
  }


  // ── what the pages show: one card per live game, the per-sport Live block, today's spot plays and
  // the live value record. home.html (the Live tab and Ask Onyx), every sport page (sport_shell.html)
  // and nba.html all draw these, so a card reads the same everywhere. ──
  var REF = 'KR680261', VALUE = 0.03;
  // tennis posts a live pick only when the model is confident (11/4, Jordan): 60%+ to hit. Its graded
  // live plays: under 60% went 12-25 (-8.6u, the coin-flip band 50-60% 8-18), 60%+ went 16-7 (+2.2u)
  // 11/6 (Jordan): raised to 65%. Under the 60% rule, 60-64% went 13-14 (-13.5%), 65%+ went 20-7 (+13.9%)
  var TN_CONF = 0.65;
  // 11/6: live markets paused until they test positive (live_model.py PAUSED): tennis totals, college basketball spreads and moneylines
  var PAUSED = {'tennis|total': 1, 'cbb|spread': 1, 'cbb|ml': 1};
  function isVal(b) { return b.edge >= VALUE && b.ok !== false; }
  var NAME = {nfl: 'NFL', cfb: 'NCAAF', nba: 'NBA', nhl: 'NHL', cbb: 'NCAAB', tennis: 'Tennis'};
  var PAGE = {nfl: 'nfl.html', cfb: 'cfb.html', nba: 'nba.html', nhl: 'nhl.html', cbb: 'cbb.html', tennis: 'tennis.html'};
  var LIVE_SPORTS = ['nfl', 'cfb', 'nba', 'nhl', 'cbb', 'tennis'];
  var CSS = [
    '.lv-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px;margin-top:12px}',
    '.lv-card{border:1px solid #2a2236;border-radius:16px;padding:14px 16px;background:#141019;display:flex;flex-direction:column;gap:10px;min-width:0;color:#efeaf7;text-align:left}',
    '.lv-top{display:flex;justify-content:space-between;align-items:center;gap:8px}.lv-clock{font:700 11px monospace;color:#ff6b9a;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.lv-clock:before{content:"";flex:0 0 7px;width:7px;height:7px;border-radius:50%;background:#ff4d7d;box-shadow:0 0 0 0 rgba(255,77,125,.6);animation:lvp 1.6s infinite}',
    '@keyframes lvp{70%{box-shadow:0 0 0 7px rgba(255,77,125,0)}100%{box-shadow:0 0 0 0 rgba(255,77,125,0)}}',
    '.lv-tag{font:800 10px monospace;letter-spacing:.08em;text-transform:uppercase;color:#d795ff;border:1px solid #4a2d7a;border-radius:999px;padding:3px 8px;white-space:nowrap}',
    '.lv-bar{height:8px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;display:flex}.lv-bar i{display:block;height:100%;background:linear-gradient(90deg,#a24bff,#d795ff)}',
    '.lv-teams{display:flex;flex-direction:column;gap:6px}.lv-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto 74px;align-items:center;gap:10px;color:#a79fb5}',
    '.lv-row.up{color:#fff}.lv-lg{width:28px;height:28px;object-fit:contain;border-radius:6px}.lv-lg.sm{width:22px;height:22px}.lv-nolg{display:inline-block;background:rgba(255,255,255,.06)}',
    '.lv-nm{font:700 16px/1.2 inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lv-sc{font:800 22px/1 inherit}.lv-wp{font:700 12px monospace;text-align:right;color:#8f879c}.lv-row.up .lv-wp{color:#d795ff}',
    '.lv-srv{display:inline-block;width:7px;height:7px;border-radius:50%;background:#61e970;margin-left:6px;vertical-align:middle}',
    '.lv-sets{font:600 11px monospace;color:#8f879c}',
    '.lv-lean{border:1px solid #4a2d7a;background:linear-gradient(160deg,rgba(162,75,255,.16),rgba(162,75,255,.04));border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:9px}',
    '.lv-lean.none{border-color:#2a2236;background:rgba(255,255,255,.03)}.lv-k{font:700 10px monospace;letter-spacing:.1em;text-transform:uppercase;color:#d795ff}',
    '.lv-pick{display:flex;align-items:center;gap:8px;font-size:18px;color:#fff;min-width:0}.lv-pick b{min-width:0;overflow-wrap:anywhere}',
    '.lv-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.lv-steps div{background:rgba(0,0,0,.25);border-radius:10px;padding:8px;min-width:0;position:relative}',
    '.lv-steps div+div:before{content:"";position:absolute;left:-6px;top:50%;width:6px;height:2px;background:#4a2d7a}',
    '.lv-steps small{display:block;font:600 9px monospace;letter-spacing:.08em;text-transform:uppercase;color:#8f879c}.lv-steps b{display:block;font:800 18px/1.3 monospace;color:#efeaf7}',
    '.lv-steps span{display:block;font:600 10px/1.3 monospace;color:#a79fb5;overflow-wrap:anywhere}.lv-steps .fair{background:rgba(162,75,255,.22)}.lv-steps .fair b{color:#e9c8ff}',
    '.lv-verdict{font-size:13px;line-height:1.45;color:#cfc8da}.lv-verdict b{color:#fff}',
    '.lv-more{display:flex;flex-wrap:wrap;gap:4px 14px;font:600 11px monospace;color:#8f879c}.lv-more b{color:#cfc8da}',
    '.lv-val{margin-left:auto;font:800 10px monospace;letter-spacing:.05em;color:#0b0710;background:#61e970;border-radius:999px;padding:3px 8px;white-space:nowrap}',
    '.lv-bets{display:flex;flex-direction:column;gap:6px;border-top:1px solid rgba(255,255,255,.08);padding-top:9px}',
    '.lv-bet{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;align-items:center;font-size:13px;color:#e8e2f1}.lv-bet .s{grid-column:1;font:600 11px monospace;color:#a79fb5}.lv-bet .s b{color:#fff}',
    '.lv-bet .lv-val{grid-column:2;grid-row:1/3}',
    '.lv-best{display:flex;flex-direction:column;gap:8px;margin-top:12px}.lv-best .lv-bet{background:#141019;border:1px solid #4a2d7a;border-radius:12px;padding:10px 12px}',
    '.lv-f{display:flex;gap:8px;flex-wrap:wrap}.lv-f a{font:700 11px monospace;color:#d795ff;text-decoration:none;border:1px solid #3a2a55;border-radius:999px;padding:6px 11px}',
    '.lv-f a.go{background:#a24bff;border-color:#a24bff;color:#fff}',
    /* the per-sport Live block and spot plays */
    '.lvb{margin:18px 0 6px;color:#efeaf7}.lvb-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px;margin-bottom:10px}',
    '.lvb-h h3{margin:0;font:800 20px/1.2 inherit;color:#fff}.lvb-eb{display:flex;align-items:center;gap:6px;font:700 10px monospace;letter-spacing:.12em;text-transform:uppercase;color:#ff6b9a}',
    '.lvb-eb.off{color:#8f879c}.lvb-eb i{width:7px;height:7px;border-radius:50%;background:#ff4d7d;animation:lvp 1.6s infinite}.lvb-eb.off i{background:#5d5568;animation:none}',
    '.lvb-note{font:600 10.5px/1.5 monospace;color:#8f879c;margin:2px 0 10px}.lvb-note b{color:#cfc8da}',
    '.lvb-v{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;border:1px solid #4a2d7a;border-radius:14px;padding:12px 14px;margin-bottom:8px;background:linear-gradient(160deg,rgba(162,75,255,.18),rgba(162,75,255,.04))}',
    '.lvb-v p{margin:0;font-size:14px;line-height:1.5;color:#e8e2f1;min-width:0;overflow-wrap:anywhere}.lvb-v p b{color:#fff}.lvb-v p small{display:block;font:600 11px monospace;color:#a79fb5;margin-top:2px}',
    '.lvb-v.none{border-color:#2a2236;background:rgba(255,255,255,.03)}',
    '.lvb-go{font:800 11px monospace;letter-spacing:.04em;color:#fff;background:#a24bff;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}',
    '.lvb-more{font:700 11px monospace;color:#d795ff;background:none;border:1px solid #3a2a55;border-radius:999px;padding:7px 12px;margin-top:10px;cursor:pointer}',
    '.lvb-rec{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;border-top:1px solid rgba(255,255,255,.08);margin-top:12px;padding-top:10px;font:600 11px monospace;color:#8f879c}.lvb-rec b{color:#efeaf7;font-size:13px}',
    '.lvb-rec .pos{color:#61e970}.lvb-rec .neg{color:#ff8a8a}',
    '.sp-list{display:flex;flex-direction:column;gap:8px}.sp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center;border:1px solid #2a2236;border-radius:14px;padding:12px 14px;background:#141019}',
    '.sp-row.pk{border-color:rgba(97,233,112,.5);background:linear-gradient(160deg,rgba(97,233,112,.08),rgba(255,255,255,.02))}',
    '.sp-row .w{min-width:0}.sp-row .t{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;color:#8f879c}',
    '.sp-row .t em{font-style:normal;color:#d795ff;border:1px solid #4a2d7a;border-radius:999px;padding:1px 7px}.sp-row.pk .t em{color:#61e970;border-color:rgba(97,233,112,.5)}',
    '.sp-row b.l{display:block;font-size:16px;line-height:1.3;color:#fff;margin-top:3px;overflow-wrap:anywhere}.sp-row .r{font-size:12.5px;line-height:1.45;color:#cfc8da;margin-top:3px;overflow-wrap:anywhere}',
    '.sp-row .n{font:600 11px monospace;color:#a79fb5;margin-top:4px}.sp-row .n b{color:#fff}',
    '.sp-row a{font:800 11px monospace;color:#fff;background:#a24bff;border-radius:999px;padding:9px 13px;text-decoration:none;white-space:nowrap}',
    '@media(max-width:420px){.lvb-v,.sp-row{grid-template-columns:minmax(0,1fr)}.lvb-go,.sp-row a{justify-self:start}}'
  ].join('\n');
  function css() {
    if (typeof document === 'undefined' || document.getElementById('onyx-live-css')) return;
    var st = document.createElement('style'); st.id = 'onyx-live-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function pct(x) { return x == null ? '-' : x < 0.01 ? 'under 1%' : x > 0.99 ? 'over 99%' : Math.round(100 * x) + '%'; }
  function pr(x) { return x == null ? '-' : x > 0 ? '+' + x : String(x); }
  function badge(b) { return isVal(b) ? '<span class="lv-val">Value +' + Math.round(b.edge * 100) + '%</span>' : ''; }
  function logoImg(u, cls) { return u ? '<img class="' + (cls || 'lv-lg') + '" src="' + esc(u) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<span class="' + (cls || 'lv-lg') + ' lv-nolg"></span>'; }
  var ONYX = 'https://app.onyxodds.com/?referrer=' + REF;
  function onyxSel(sel) { return sel ? 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(sel) + '&referrer=' + REF : ONYX; }
  // "Open the game": the sport page's Games tab on this game (#games:<ESPN id>). On that sport's own page the
  // click is handled in place by the opener the page registers in mount() (a same-page hash change alone does
  // nothing); from another page the target page reads the hash when it loads.
  function gameHref(g) { return (PAGE[g.sport] || 'home.html') + '#games:' + encodeURIComponent(g.gid || ''); }
  var OPEN = {};
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-lv-open]'); if (!a) return;
    var f = OPEN[a.getAttribute('data-lv-sport')]; if (!f) return;      // another sport's page: follow the link
    e.preventDefault();
    try { f(a.getAttribute('data-lv-open'), a.getAttribute('data-lv-a') || '', a.getAttribute('data-lv-h') || ''); } catch (x) { location.href = a.href; }
  });
  // the logged tennis pick, priced by the live model now (ml / spread / total from the row's kind, side, line)
  function pickChance(g, LP) {
    var M = g.M, home = LP.side === 'home', x = null;
    if (!M) return null;
    try {
      if (LP.kind === 'ml' && M.win) x = home ? M.win() : 1 - M.win();
      else if (LP.kind === 'spread' && M.cover && LP.line != null) x = home ? M.cover(LP.line) : 1 - M.cover(-LP.line);
      else if (LP.kind === 'total' && M.over && LP.line != null) x = LP.side === 'over' ? M.over(LP.line) : 1 - M.over(LP.line);
    } catch (e) { x = null; }
    return x == null || isNaN(x) ? null : Math.min(1, Math.max(0, x));
  }
  // the live line on the logged bet: the same line if quoted, else the nearest line on the same side
  function pickLine(g, LP) {
    var L = g.L; if (!L || !L.lines) return null;
    var team = LP.side === 'home' ? g.hn : g.an, alt = LP.side === 'home' ? g.home : g.away;
    var mine = function (x) { return sameTeam(x.sel, team) || sameTeam(x.sel, alt); };
    var C = L.lines.filter(function (x) {
      if (x.price == null || x.m !== LP.kind) return false;
      if (LP.kind === 'total') return x.side === LP.side && x.pt != null;
      if (LP.kind === 'spread') return x.pt != null && mine(x);
      return mine(x);
    });
    if (!C.length) return null;
    if (LP.kind === 'ml' || LP.line == null) return {price: C[0].price, at: null};
    C.sort(function (a, b) { return Math.abs(a.pt - LP.line) - Math.abs(b.pt - LP.line); });
    var b = C[0];
    return {price: b.price, at: b.pt === LP.line ? null : (LP.kind === 'total' ? (LP.side === 'over' ? 'o' : 'u') + b.pt : sgn(b.pt))};
  }
  // the card for one game: the best live bet first (started, live line, our fair), then the score and the rest of our numbers
  function card(g) {
    var hw = g.home_win, aw = 1 - hw, pre = g.pre || {}, L = g.lean, ten = g.sport === 'tennis';
    var row = function (nm, lg, sc, p, win, serving) { return '<div class="lv-row' + (win ? ' up' : '') + '">' + logoImg(lg) + '<span class="lv-nm">' + esc(nm) + (serving ? '<i class="lv-srv" title="serving"></i>' : '') + '</span><b class="lv-sc">' + sc + '</b><span class="lv-wp">' + pct(p) + '</span></div>'; };
    var teams = '<div class="lv-teams">' + row(g.away, g.al, g.as, aw, aw > hw, ten && g.srv === 1) + row(g.home, g.hl, g.hs, hw, hw > aw, ten && g.srv === 0) + '</div>'
      + (ten && g.state ? '<div class="lv-sets">Sets ' + esc(g.state) + (g.need === 3 ? ' &middot; best of 5' : '') + (g.pre_src === 'Elo' ? ' &middot; started from Elo (no Onyx price saved)' : '') + '</div>' : '');
    var lean = '', B = (g.bets || []).filter(function (b) { return b.edge > -0.02; });
    // tennis: one pick per match (11/4, Jordan: three different picks showed on one Musetti match as the
    // live line moved). Once the record has logged this match's pick, that pick is the card's pick,
    // locked, and no other side is suggested.
    var LP = ten && LEDGER ? LEDGER.filter(function (r) { return r.sport === 'tennis' && String(r.gid) === String(g.gid); })
      .sort(function (a, b) { return String(a.logged_at).localeCompare(String(b.logged_at)); })[0] : null;
    if (LP) {
      // 11/6 (Jordan: "these spots need to be filled in"): our chance now comes straight from the live
      // model on the logged bet, whatever the live line is doing, and the live line box shows the logged
      // line when it is quoted, else the nearest line on the same side (marked "at <line>")
      var lc = pickChance(g, LP), ll = pickLine(g, LP);
      lean = '<div class="lv-lean"><div class="lv-k">Live projection &middot; first read</div>'
        + '<div class="lv-pick"><b>' + esc(LP.label) + '</b><span class="lv-val">' + pct(LP.chance) + ' to hit</span></div>'
        + '<div class="lv-steps"><div><small>First read at</small><b>' + pr(LP.price) + '</b><span>' + esc(String(LP.logged_at).slice(11, 16)) + ' UTC</span></div>'
        + '<div><small>Live line</small><b>' + (ll ? pr(ll.price) : '-') + '</b><span>' + (ll ? (ll.at != null ? 'at ' + esc(ll.at) + ' &middot; ' : '') + pct(implied(ll.price)) + ' implied' : LP.result ? 'settled' : 'off the board') + '</span></div>'
        + '<div class="fair"><small>Our chance now</small><b>' + (lc != null ? pct(lc) : '-') + '</b><span>' + (LP.result ? (LP.result === 'W' ? 'won' : LP.result === 'L' ? 'lost' : 'push') : lc != null && LP.chance != null ? (lc >= LP.chance ? 'up ' : 'down ') + Math.abs(Math.round(100 * (lc - LP.chance))) + ' pts since then' : 'in play') + '</span></div></div>'
        + '<div class="lv-verdict">Our first read on this match, kept so you can follow how it moves. A projection, not an Onyx Pick: live markets have not passed the picks test yet.</div></div>';
    } else
    if (g.bets && g.bets.length && g.bets[0].edge > -0.05) {
      var top = B[0] || g.bets[0], rest = (B.length ? B : g.bets).slice(1, 4);
      lean = '<div class="lv-lean' + (isVal(top) ? '' : ' none') + '"><div class="lv-k">' + (isVal(top) ? 'Live value &middot; projection' : top.ok === false && top.edge >= VALUE ? 'Too close to call' : 'No value right now') + '</div>'
        + '<div class="lv-pick">' + (top.logo ? logoImg(top.logo, 'lv-lg sm') : '') + '<b>' + esc(top.label) + '</b>' + badge(top) + '</div>'
        + '<div class="lv-steps"><div><small>Started</small><b>' + esc(top.start_txt || '-') + '</b><span>' + (pre.src === 'market' ? 'Market pregame' : 'Onyx pregame') + '</span></div>'
        + '<div><small>Live line</small><b>' + pr(top.price) + '</b><span>' + pct(implied(top.price)) + ' implied</span></div>'
        + '<div class="fair"><small>Our fair</small><b>' + pr(top.fair) + '</b><span>' + pct(top.p) + ' to hit</span></div></div>'
        + '<div class="lv-verdict">' + (top.ok === false && top.edge >= VALUE ? 'The price has value, but our chance is only ' + pct(top.p) + ': our tennis bar is 65% or better, so this one is a pass.' : isVal(top) ? 'Value by our numbers: the live line of <b>' + pr(top.price) + '</b> pays more than our fair price of <b>' + pr(top.fair) + '</b>.' : 'The closest one: the live line of ' + pr(top.price) + ' pays less than our fair price of ' + pr(top.fair) + '. It turns into value at ' + pr(top.fair) + ' or better.') + '</div>'
        + (rest.length ? '<div class="lv-bets">' + rest.map(function (b) { return '<div class="lv-bet"><span class="n">' + esc(b.label) + '</span><span class="s">' + (b.start_txt ? esc(b.start_txt) + ' &rarr; ' : '') + '<b>' + pr(b.price) + '</b> &middot; fair ' + pr(b.fair) + '</span>' + badge(b) + '</div>'; }).join('') + '</div>' : '') + '</div>';
    } else if (g.bets && g.bets.length) {
      lean = '<div class="lv-lean none"><div class="lv-k">No value right now</div><div class="lv-verdict">Every live line on this game pays less than our fair price. We will flag it here the moment one moves past it.</div></div>';
    } else if (g.bets && g.f != null && g.f < 0.15) {
      lean = '<div class="lv-lean none"><div class="lv-k">No live bet</div><div class="lv-verdict">Too late in the game for our numbers: the live line now knows things our model does not, like ' + (g.sport === 'nhl' ? 'a pulled goalie, power plays and empty nets' : g.sport === 'nba' || g.sport === 'cbb' ? 'possession, the fouls and the timeouts' : 'who has the ball, field position and the timeouts') + '.</div></div>';
    } else if (L && L.kind === 'ml') {
      var moved = L.start == null ? 'no Onyx line saved' : L.now >= L.start ? 'up from ' + pct(L.start) : 'down from ' + pct(L.start);
      lean = '<div class="lv-lean"><div class="lv-k">Our live lean</div><div class="lv-pick">' + logoImg(L.logo, 'lv-lg sm') + '<b>' + esc(L.team) + ' to win</b></div>'
        + '<div class="lv-steps"><div><small>Started</small><b>' + (L.start == null ? '-' : pct(L.start)) + '</b><span>' + (L.start_price != null ? (pre.src === 'market' ? 'Market ' : 'Onyx ') + pr(L.start_price) : (pre.src === 'market' ? 'Market pregame' : 'Onyx pregame')) + '</span></div>'
        + '<div><small>Now</small><b>' + pct(L.now) + '</b><span>' + esc(moved) + '</span></div>'
        + '<div class="fair"><small>Fair price</small><b>' + pr(L.fair) + '</b><span>our number</span></div></div>'
        + '<div class="lv-verdict">' + (L.fair < 0 ? 'Value by our numbers at any price better than <b>' + pr(L.fair) + '</b>, like ' + pr(Math.round(L.fair * 0.85 / 5) * 5) + '.' : 'Value by our numbers at any price of <b>' + pr(L.fair) + ' or longer</b>.') + '</div></div>';
    } else if (L && L.kind === 'total') {
      var u = L.side === 'under';
      lean = '<div class="lv-lean"><div class="lv-k">Our live lean</div><div class="lv-pick"><b>' + (u ? 'Under' : 'Over') + ' the total' + (ten ? ' games' : '') + '</b></div>'
        + '<div class="lv-steps"><div><small>Started</small><b>' + L.start + '</b><span>Onyx total</span></div>'
        + '<div><small>Now</small><b>' + L.now + '</b><span>' + (ten ? 'sets won' : 'scored so far') + '</span></div>'
        + '<div class="fair"><small>Fair total</small><b>' + L.fair + '</b><span>our number</span></div></div>'
        + '<div class="lv-verdict">Value by our numbers: the <b>' + (u ? 'under' : 'over') + '</b> at any live total ' + (u ? 'above' : 'below') + ' <b>' + L.fair + '</b>.</div></div>';
    } else {
      lean = '<div class="lv-lean none"><div class="lv-k">Our live lean</div><div class="lv-verdict">' + (L && L.why === 'nopre' ? 'No lean: Onyx\'s line from before the start was not saved for this game, so there is nothing to measure the move from.' : 'No lean on this one: the game is close to decided.') + '</div></div>';
    }
    var more = '<div class="lv-more"><span>Our ' + (ten ? 'game spread' : 'spread') + ' now <b>' + esc(g.fair_spread || '-') + '</b></span><span>Our total now <b>' + (g.proj_total != null ? g.proj_total.toFixed(1) : '-') + (ten ? ' games' : '') + '</b></span>' + (pre.spread_txt ? '<span>' + (pre.src === 'market' ? 'Market pregame' : 'Onyx pregame') + ' <b>' + esc(pre.spread_txt) + (pre.total_txt ? ' · ' + esc(pre.total_txt) : '') + '</b></span>' : '') + '</div>';
    return '<div class="lv-card"><div class="lv-top"><span class="lv-tag">' + (NAME[g.sport] || '') + '</span><span class="lv-clock">' + esc(g.detail || 'Live') + '</span></div>'
      + teams + '<div class="lv-bar"><i style="width:' + (100 * aw).toFixed(1) + '%"></i></div>' + lean + more
      + '<div class="lv-f"><a class="go" href="' + ONYX + '" target="_blank" rel="noopener">Open on Onyx</a><a href="' + gameHref(g) + '" data-lv-open="' + esc(g.gid || '') + '" data-lv-sport="' + esc(g.sport) + '" data-lv-a="' + esc(g.away || '') + '" data-lv-h="' + esc(g.home || '') + '">Open the game</a></div></div>';
  }
  // the sentence a play leads with: "Value right now: Sinner to win at +120 live. Our chance 52%, the live line says 45%: +7 points."
  function sentence(b, g) {
    var pts = Math.round(b.edge * 100);
    return (isVal(b) ? 'Value right now: ' : 'Closest: ') + '<b>' + esc(b.label) + '</b> at <b>' + pr(b.price) + '</b> live. Our chance ' + pct(b.p) + ', the live line says ' + pct(implied(b.price)) + ': '
      + (pts > 0 ? '+' : '') + pts + ' point' + (Math.abs(pts) === 1 ? '' : 's') + '.<small>' + esc(g.away) + (g.sport === 'tennis' ? ' vs ' : ' @ ') + esc(g.home) + ' &middot; ' + esc(g.detail || 'Live') + (b.start_txt ? ' &middot; started ' + esc(b.start_txt) : '') + ' &middot; our fair ' + pr(b.fair) + '</small>';
  }
  function topEdge(g) { return (g.bets || []).reduce(function (m, b) { return Math.max(m, b.edge); }, -1); }
  function sortGames(G) { return G.sort(function (a, b) { return (topEdge(b) - topEdge(a)) || Math.abs((b.pre || {}).home_win != null ? b.home_win - b.pre.home_win : 0) - Math.abs((a.pre || {}).home_win != null ? a.home_win - a.pre.home_win : 0); }); }
  var UNTESTED = 'Live projections, not picks: live markets have not passed the picks test yet.';
  // the per-sport Live block: value plays worded directly, then the live games as cards
  function blockHTML(sport, G, opt) {
    opt = opt || {};
    var all = [].concat.apply([], G.map(function (g) { return (g.bets || []).map(function (b) { return {b: b, g: g}; }); })).sort(function (x, y) { return y.b.edge - x.b.edge; });
    var val = all.filter(function (x) { return isVal(x.b); }).slice(0, 4), near = all.filter(function (x) { return !isVal(x.b); }).slice(0, 3);
    var priced = G.some(function (g) { return g.bets; });
    var h = '<div class="lvb-h"><div><span class="lvb-eb' + (G.length ? '' : ' off') + '"><i></i>' + (G.length ? 'Live now &middot; ' + G.length + ' ' + (sport === 'tennis' ? 'match' + (G.length === 1 ? '' : 'es') : 'game' + (G.length === 1 ? '' : 's')) + ' in play' : 'Live') + '</span>'
      + '<h3>' + (!G.length ? 'Nothing live right now' : val.length ? 'Value right now' : 'No live value right now') + '</h3></div></div>';
    if (!G.length) return h + '<div class="lvb-note">Live value shows here the moment a ' + (sport === 'tennis' ? 'match' : 'game') + ' starts: our live chance against the live line, every 30 seconds. ' + UNTESTED + '</div>' + (opt.rec || '');
    h += '<div class="lvb-note"><b>' + UNTESTED + '</b> Our live chance starts from Onyx\'s pregame line (the market line when Onyx has none) and moves with the ' + (sport === 'tennis' ? 'sets, games and server' : 'score and the clock') + '. The live line is the in-game market (Onyx\'s in-game prices are not in our feed), so confirm the price in the Onyx app before you bet.</div>';
    if (val.length) h += val.map(function (x) { return '<div class="lvb-v"><p>' + sentence(x.b, x.g) + '</p><a class="lvb-go" href="' + ONYX + '" target="_blank" rel="noopener">Open on Onyx</a></div>'; }).join('');
    else if (near.length) h += '<div class="lvb-v none"><p><b>No live value right now.</b> Every live line pays less than our fair price. The closest lines:<small>' + near.map(function (x) { return esc(x.b.label) + ' ' + pr(x.b.price) + ' (our chance ' + pct(x.b.p) + ', line ' + pct(implied(x.b.price)) + ')'; }).join(' &middot; ') + '</small></p></div>';
    else h += '<div class="lvb-v none"><p><b>No live value right now.</b>' + (priced ? ' No live line we can price right now.' : ' The live line is not posted for these ' + (sport === 'tennis' ? 'matches' : 'games') + ' yet; our live chances are on the cards below.') + '</p></div>';
    var n = opt.limit || 4, shown = sortGames(G.slice()).slice(0, opt.all ? 99 : n);
    h += '<div class="lv-list">' + shown.map(card).join('') + '</div>';
    if (G.length > n) h += '<button type="button" class="lvb-more" data-lvb-more>' + (opt.all ? 'Show fewer' : 'Show all ' + G.length + ' live') + '</button>';
    return h + (opt.rec || '');
  }
  // the live value record (data/live/ledger.json, live_log.py): every value play the pipeline saw, graded
  // Tennis picks are logged the minute they qualify (live_watch.yml) into data/live/tennis_now.json, read
  // straight from the repo so a pick locks on the card within minutes, before the next build copies it
  // into the ledger. The ledger's row wins where both have the match.
  var LEDGER = null, LEDGER_AT = 0, LED0 = null, LED0_AT = 0, NOWROWS = [], NOW_AT = 0;
  var NOW_URL = 'https://raw.githubusercontent.com/OnyxJordan/onyx-baseball-fix/main/data/live/tennis_now.json';
  function ledger() {
    if (LEDGER && Date.now() - LEDGER_AT < 60e3) return Promise.resolve(LEDGER);
    var base = LED0 && Date.now() - LED0_AT < 5 * 60e3 ? Promise.resolve(LED0)
      : getJSON('data/live/ledger.json').then(function (j) { LED0 = Array.isArray(j) ? j : (j && j.plays) || []; LED0_AT = Date.now(); return LED0; }).catch(function () { return LED0 || []; });
    var now = Date.now() - NOW_AT < 60e3 ? Promise.resolve(NOWROWS)
      : fetch(NOW_URL).then(function (r) { if (!r.ok) throw r; return r.json(); }).then(function (j) { NOWROWS = Array.isArray(j) ? j : []; NOW_AT = Date.now(); return NOWROWS; }).catch(function () { return NOWROWS; });
    return Promise.all([base, now]).then(function (r) {
      var have = {};
      r[0].forEach(function (x) { if (x.sport === 'tennis') have[String(x.gid)] = 1; });
      LEDGER = r[0].concat(r[1].filter(function (x) { return x.sport === 'tennis' && !have[String(x.gid)]; }));
      LEDGER_AT = Date.now(); return LEDGER;
    });
  }
  // the record counts at most one pick per tennis match (11/5, Jordan). The ledger keeps every row it
  // ever logged (append-only); before v3 a match could log a moneyline, a spread and a total, or both
  // sides as the line moved. The pick that counts is the one the v3 rule would have taken at the time:
  // from the match's first logging run, the most confident play. Later rows are not counted. Nothing is
  // chosen by result.
  function onePerMatch(rows) {
    var first = {};
    rows.forEach(function (r) {
      if (r.sport !== 'tennis') return;
      var k = String(r.gid), f = first[k], t = String(r.logged_at || '');
      if (!f || t < String(f.logged_at || '') || (t === String(f.logged_at || '') && ((r.chance || 0) > (f.chance || 0) || ((r.chance || 0) === (f.chance || 0) && (r.edge || 0) > (f.edge || 0))))) first[k] = r;
    });
    return rows.filter(function (r) { return r.sport !== 'tennis' || first[String(r.gid)] === r; });
  }
  function record(rows, sport) {
    rows = onePerMatch(rows || []);
    var R = rows.filter(function (r) { return !sport || sport === 'all' || r.sport === sport; }), a = {w: 0, l: 0, p: 0, pend: 0, units: 0, n: R.length};
    R.forEach(function (r) { if (r.result === 'W') { a.w++; a.units += r.price > 0 ? r.price / 100 : 100 / -r.price; } else if (r.result === 'L') { a.l++; a.units -= 1; } else if (r.result === 'P' || r.result === 'V') a.p++; else a.pend++; });
    a.units = Math.round(a.units * 100) / 100; a.roi = a.w + a.l ? a.units / (a.w + a.l) : null; return a;
  }
  function recordHTML(rows, sport) {
    var a = record(rows, sport), u = (a.units > 0 ? '+' : '') + a.units.toFixed(2) + 'u';
    return '<div class="lvb-rec"><span>Live value record (on trial)</span><b>' + a.w + '-' + a.l + (a.p ? '-' + a.p : '') + '</b><span class="' + (a.units > 0 ? 'pos' : a.units < 0 ? 'neg' : '') + '">' + u + (a.roi != null ? ' &middot; ROI ' + (a.roi > 0 ? '+' : '') + (100 * a.roi).toFixed(1) + '%' : '') + '</span><span>'
      + (a.n ? a.n + ' logged' + (a.pend ? ', ' + a.pend + ' open' : '') + ', each at the live line when it first showed as value' : 'Nothing logged yet: every live value play is logged at the live line when it first shows, then graded off the final') + '. Not Onyx Picks.</span></div>';
  }
  // today's spot plays (data/<sport>/top.json, daily_top.py): Onyx Picks first, then the best value, each with its reason
  // the site's day (rolls at 4 AM ET), the same day home.html's Top 10 uses
  function siteDay(t) { return new Date(t - 4 * 3600e3).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); }
  function spotHTML(sport, rows) {
    var now = Date.now(), today = siteDay(now);
    // today's games only (11/5, Jordan: NFL and college football showed Sunday's plays on a Thursday)
    // Onyx Picks have their own card (onyxpicks.js) above this list; this list is projections only (11/6)
    var up = (rows || []).filter(function (r) { return !r.pick && (!r.start || Date.parse(r.start) > now - 5 * 60e3); });
    var nextT = up.reduce(function (m, r) { var t = r.start ? Date.parse(r.start) : NaN; return !isNaN(t) && siteDay(t) !== today && (m == null || t < m) ? t : m; }, null);
    var R = up.filter(function (r) { return !r.start || siteDay(Date.parse(r.start)) === today; })
      .sort(function (a, b) { return (b.ev || 0) - (a.ev || 0); }).slice(0, 5);
    var h = '<div class="lvb-h"><div><span class="lvb-eb off"><i></i>Before the start</span><h3>Top projections today &middot; not picks</h3></div></div>';
    if (!R.length) return h + '<div class="lvb-note">' + (nextT != null && !up.some(function (r) { return r.start && siteDay(Date.parse(r.start)) === today; })
      ? 'No ' + (NAME[sport] || '') + ' games today. The top projections for the next slate post here on game day (' + esc(new Date(nextT).toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York'})) + ').'
      : 'No line on today\'s slate beats our number right now. Projections show here as lines post.') + '</div>';
    var tag = function () { return 'Projection'; };
    var t = function (iso) { try { return new Date(iso).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET'; } catch (e) { return ''; } };
    return h + '<div class="lvb-note">The model\'s best value on today\'s lines, each with the reason it shows. Our numbers, not picks: only the Onyx Picks card above is locked and graded.</div><div class="sp-list">' + R.map(function (r) {
      var why = r.why || ('Our chance ' + pct(r.conf) + ' against Onyx\'s ' + pct(implied(r.price)) + '.');
      return '<div class="sp-row"><div class="w"><div class="t"><em>' + tag(r) + '</em><span>' + esc(r.matchup || '') + '</span>' + (r.start ? '<span>' + esc(t(r.start)) + '</span>' : '') + '</div>'
        + '<b class="l">' + esc(r.label) + '</b><div class="r">' + esc(why) + '</div>'
        + '<div class="n">Onyx <b>' + pr(r.price) + '</b> &middot; our chance <b>' + pct(r.conf) + '</b> &middot; edge <b>' + (r.edge >= 0 ? '+' : '') + (100 * r.edge).toFixed(1) + ' pts</b></div></div>'
        + '<a href="' + onyxSel(r.sel) + '" target="_blank" rel="noopener">See it on Onyx</a></div>';
    }).join('') + '</div>';
  }
  // mount on a sport page: {sport, home: element id (the Live block and today's spot plays: live first while
  // anything is in play, the spot plays first otherwise), games: element id (the Live block only)}.
  // Refreshes every 30 seconds while anything is live, every 2 minutes otherwise, never while the tab is hidden.
  function mount(o) {
    css();
    var sport = o.sport, live = LIVE_SPORTS.indexOf(sport) >= 0;
    if (typeof o.open === 'function') OPEN[sport] = o.open;
    var st = {G: [], all: false, timer: null, rows: null, led: [], sport: sport};
    function draw() {
      var rec = '', lb = live ? '<div class="lvb">' + blockHTML(sport, st.G, {all: st.all, rec: rec}) + '</div>' : '';
      var pk = st.pk && window.OnyxPicks ? '<div class="lvb">' + OnyxPicks.html(st.pk, {sport: sport, title: 'Onyx Picks &middot; ' + (NAME[sport] || '')}) + '</div>' : '';
      var sp = st.rows ? pk + '<div class="lvb">' + spotHTML(sport, st.rows) + '</div>' : '';
      var h = o.home && document.getElementById(o.home), gm = o.games && document.getElementById(o.games);
      if (h) h.innerHTML = st.G.length ? lb + sp : sp ? sp + lb : '';   // nothing live and no spot list (NBA Home): stay out of the way
      if (gm) gm.innerHTML = lb;
    }
    document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-lvb-more]'); if (b) { st.all = !st.all; draw(); } });
    function load() {
      return Promise.all([live ? games([sport]).catch(function () { return st.G; }) : [], live ? ledger() : [],
        o.home && o.spot !== false ? getJSON('data/' + sport + '/top.json').then(function (j) { return (j && j.plays) || []; }).catch(function () { return st.rows || []; }) : null,
        o.home && o.spot !== false && window.OnyxPicks ? OnyxPicks.load().catch(function () { return st.pk || null; }) : null])
        .then(function (r) { st.G = r[0] || []; st.led = r[1] || []; if (o.home && o.spot !== false) { st.rows = r[2]; st.pk = r[3]; } draw(); return st; });
    }
    function tick() { clearTimeout(st.timer); st.timer = setTimeout(function () { (document.hidden ? Promise.resolve() : load()).then(tick, tick); }, st.G.length ? 30e3 : 120e3); }
    st.ready = load().then(function (x) { tick(); return x; }, function () { tick(); });
    st.load = load; st.draw = draw;
    return st;
  }

  window.OnyxLive = {left: left, model: model, plays: plays, noVig: noVig, implied: implied, phi: phi, games: games, pregame: pregame, american: american, lean: lean, bets: bets, propP: propP,
    SD: SD, PACE: PACE, TOTK: TOTK, LEN: LEN, ML_PTS: ML_PTS, DEF_TOTAL: DEF_TOTAL, FMIN: FMIN, tn: tn, VALUE: VALUE, TN_CONF: TN_CONF, isVal: isVal, card: card, block: blockHTML, spot: spotHTML, sentence: sentence, sortGames: sortGames,
    css: css, mount: mount, ledger: ledger, onePerMatch: onePerMatch, record: record, recordHTML: recordHTML, NAME: NAME, PAGE: PAGE, SPORTS: LIVE_SPORTS};
})();
