// studio-lab.js - Parlay Lab, the Studio's parlay workbench (11/15, Jordan: "parlay lab ... lets go wild"; every
// sport 11/16: each sport's own market names, presets and same-game correlation table, below).
// Parlays are the product, so this tab works on the ONE shared slip (parlay.js, window.OnyxParlay, localStorage
// onyxSlipAll), never a second one. Every add, remove, swap or preset goes through OnyxParlay, and every view
// redraws on its 'onyx-slip' event, so the floating slip and this page always show the same legs.
//
//   Leg picker   today's board rows still to start, filtered by game, market, side, price, "model likes" (edge > 0,
//                model read) or "most likely"; each row shows the model's chance, Onyx's price and the edge
//   Presets      value 3-legger, TD long shot, safe-ish 2-legger (-200 or longer), same-game stack: built from the
//                board, labeled "model idea, not an Onyx Pick"
//   Analysis     combined Onyx odds (product of the legs' decimal odds), $10 pays, the model's true chance every
//                leg hits (naive product, plus the same-game correlation below), fair odds, value, a value meter,
//                each leg's pull on the value, flags (move together / fight / Onyx's own chance)
//   Swaps        for the weakest legs, the board's best replacement that raises the slip's value or chance
//   Ladder       the best 2, 3, 4 and 5 leg subsets of the slip by value
//   Send to Onyx one share link with every leg (Studio.u.onyx)
//
// The true chance: a Gaussian copula. Each leg hits when its latent normal falls under the quantile of the model's
// chance, so every leg keeps its own chance exactly. Legs in different games are independent (their chances
// multiply exactly). Legs in one game share a correlation from the table below, the latents are drawn 5,000 times
// (seeded, so the numbers never flicker) through a Cholesky factor, and the joint chance is the share of runs
// where every leg hits. A table that is not positive definite is shrunk toward zero until it is.
//
// Tables by sport (TABLES): NFL fitted (tools/nfl_sgp_corr.py); college football reuses the NFL table; NBA player
// props fitted (tools/nba_sgp_corr.py) and its game lines fitted (tools/sgp_lines_corr.py); college basketball, NHL
// and tennis game lines fitted the same way (the favorite's side with the over, a team's moneyline with its own
// spread, and with the other team's). The few cells no history covers are marked as estimates in the table and
// the "how" panel says so.
(function () {
  'use strict';
  if (!window.Studio) return;
  var RUNS = 5000, QUICK = 2000, SEED = 20261115;
  var D = null, u = null, ROOT = null, ROWS = [], BYID = {}, BYSEL = {}, ROLE = {}, LAST = null, PREVIEW = null, TIMER = null, SWAPJOB = 0;
  var F = {gid: '', mkt: '', side: '', price: '', mode: 'likes', q: '', lim: 40};

  var SPORT = Studio.sport;
  var MK_FB = {spread: 'Spread', ml: 'Moneyline', total: 'Game total', pass_yds: 'Passing yds', pass_att: 'Pass attempts', pass_td: 'Passing TDs',
    pass_rush_yds: 'Pass + rush yds', rush_yds: 'Rushing yds', rec: 'Receptions', rec_yds: 'Receiving yds', rush_rec_yds: 'Rush + rec yds',
    anytime_td: 'Anytime TD', first_td: 'First TD', two_td: '2+ TDs', three_td: '3+ TDs'};
  var MKS = {
    nfl: MK_FB, cfb: MK_FB,
    nba: {spread: 'Spread', ml: 'Moneyline', total: 'Game total', pts: 'Points', reb: 'Rebounds', ast: 'Assists', threes: '3-pointers',
      pr: 'Pts + reb', pa: 'Pts + ast', pra: 'Pts + reb + ast', dbl_dbl: 'Double-double', trp_dbl: 'Triple-double', first_basket: 'First basket',
      h1_total: '1st-half total', q1_total: '1st-quarter total'},
    cbb: {spread: 'Spread', ml: 'Moneyline', total: 'Game total'},
    nhl: {spread: 'Puck line', ml: 'Moneyline', total: 'Total goals'},
    tennis: {spread: 'Game spread', ml: 'Match winner', total: 'Total games'}
  };
  var MK = MKS[SPORT] || MK_FB;
  var MK_ORDER = SPORT === 'nba' ? ['spread', 'ml', 'total', 'h1_total', 'q1_total', 'pts', 'reb', 'ast', 'threes', 'pr', 'pa', 'pra', 'dbl_dbl', 'trp_dbl', 'first_basket']
    : MKS[SPORT] && MKS[SPORT] !== MK_FB ? ['ml', 'spread', 'total']
    : ['spread', 'ml', 'total', 'anytime_td', 'first_td', 'two_td', 'three_td', 'pass_yds', 'pass_att', 'pass_td', 'pass_rush_yds', 'rush_yds', 'rec', 'rec_yds', 'rush_rec_yds'];
  var PROPS = SPORT === 'nfl' || SPORT === 'cfb' || SPORT === 'nba';

  // ── the same-game correlation table ─────────────────────────────────────────────────────────────────────────
  // Every leg gets a category and a direction (+1 wants more of its stat or its team doing well, -1 an under).
  //   side  spread or moneyline (the team)      total  the game total
  //   pass  QB passing yds, TDs, pass+rush yds  att    QB pass attempts (trailing teams throw more)
  //   recv  receptions, receiving yds           rush   rushing yds (and rush+rec yds for a running back)
  //   td    anytime / 2+ / 3+ TD                ftd    first TD (only one player scores it)
  // The correlation of two legs = the table value x both directions. Fitted, not guessed (11/16, Jordan: "build the
  // real same-game correlations for parlay lab"): tools/nfl_sgp_corr.py graded every Onyx opening line of 2025 and 2026
  // (20,853 lines in 471 games: receptions, receiving / rushing / passing yards, pass attempts, anytime TD, spread and
  // total), calibrated each market's chances, and set each cell to the correlation that best predicts how often its
  // real same-game pairs both hit (524,593 pairs), shrunk toward 0 by n / (n + 80). Held out: fitted on 2025 and judged
  // on 2026's 163,750 pairs, then the other way on 2025's 360,843, it beat the old hand-set table overall (log loss
  // .38680 vs .38778 on 2025, .41744 vs .41714 on 2026), and the old table had overstated most links (opponents ~0,
  // not +.12 to +.15; a total over and a receiver +.15, not +.30). First TD (ftd) has no graded history: those few
  // cells keep the earlier hand-set values.
  var SAME_PLAYER = {'recv|td': 0.297, 'recv|recv': 0.785, 'rush|td': 0.337, 'recv|rush': -0.144, 'pass|rush': 0.0, 'pass|td': 0.0, 'att|pass': 0.57,
    'att|td': 0.044, 'att|rush': 0.087, 'pass|pass': 0.6, 'att|att': 0.6, 'rush|rush': 0.7, 'td|td': 0.65, 'ftd|td': 0.5, 'ftd|recv': 0.2, 'ftd|rush': 0.2};
  var TEAMMATES = {'recv|td': 0.0, 'recv|recv': 0.05, 'td|td': -0.1, 'recv|rush': -0.05, 'rush|td': 0.0, 'pass|recv': 0.347, 'pass|td': 0.198,
    'att|recv': 0.247, 'att|td': 0.0, 'rush|rush': 0.0, 'pass|rush': -0.142, 'att|rush': -0.092, 'att|pass': 0.5, 'ftd|ftd': -0.35, 'ftd|td': 0.05, 'ftd|pass': 0.1};
  var OPPONENTS = {'recv|td': 0.0, 'recv|recv': 0.05, 'td|td': 0.0, 'recv|rush': 0.05, 'rush|td': 0.0, 'pass|recv': 0.05, 'pass|td': 0.049,
    'att|recv': -0.049, 'att|td': 0.098, 'rush|rush': -0.097, 'pass|rush': 0.0, 'att|rush': 0.0, 'att|pass': 0.044, 'pass|pass': 0.084, 'att|att': 0.0, 'ftd|ftd': -0.35};
  var SIDE_OWN = {recv: -0.05, td: 0.198, rush: 0.193, pass: 0.136, att: -0.175, ftd: 0.15};   // a team's side and its own players
  var SIDE_OPP = {recv: 0.05, td: -0.198, rush: -0.193, pass: -0.136, att: 0.175, ftd: -0.1};  // a team's side and the other team's players
  var TOTAL = {recv: 0.149, td: 0.247, rush: 0.097, pass: 0.319, att: 0.175, ftd: 0.1, side: 0}; // the game total and anything in it
  var SIDES = {same: 0.8, opp: -0.8, excl: -0.99};   // moneyline / spread pairs (hand-set; excl: both sides of one market, which cannot both win)
  var CAT = {pass_yds: 'pass', pass_td: 'pass', pass_rush_yds: 'pass', pass_att: 'att', rec: 'recv', rec_yds: 'recv', rush_yds: 'rush',
    anytime_td: 'td', two_td: 'td', three_td: 'td', first_td: 'ftd',
    pts: 'pts', reb: 'reb', ast: 'ast', threes: 'thr', pr: 'pr', pa: 'pa', pra: 'pra', dbl_dbl: 'dd', trp_dbl: 'dd', first_basket: 'fb', h1_total: 'gtot', q1_total: 'gtot'};

  // NBA (11/16, tools/nba_sgp_corr.py): the NFL method on every Onyx opening line with a result in 2024-25 and 2025-26
  // (129,475 graded lines in 2,041 games: points, rebounds, assists, 3s, the three combos, spread and total; 4,697,047
  // same-game pairs), each cell the correlation that best predicts how often its real pairs both hit, shrunk toward 0
  // by n / (n + 80). Held out it beat independence both ways (log loss .54055 -> .54034 judging 2024-25 on a 2025-26
  // fit; .54624 -> .54620 the other way, where 2024-25 had no combo or 3s lines to learn from). Strong part: one
  // player's markets (points with a combo +.89, points with 3s +.74). Teammates fight a little (-.05), opponents ~0.
  // Double / triple-doubles, first basket and the half / quarter totals have no graded history: estimates (sp, gtot).
  var NBA = {
    same: {'pts|reb': 0.299, 'ast|pts': 0.149, 'ast|reb': 0.199, 'pr|pts': 0.895, 'pr|reb': 0.497, 'pts|thr': 0.745, 'pra|pts': 0.894, 'pr|pra': 0.894, 'pra|reb': 0.546, 'reb|thr': 0.099, 'pr|thr': 0.645, 'pa|pts': 0.893, 'pa|pra': 0.893, 'ast|pa': 0.447, 'pa|pr': 0.893, 'pa|reb': 0.298, 'ast|pr': 0.149, 'ast|pra': 0.447, 'pra|thr': 0.595, 'pa|thr': 0.595, 'ast|thr': 0.05},
    team: {'pts|reb': -0.05, 'ast|pts': 0.1, 'ast|reb': 0.05, 'pts|pts': -0.05, 'pr|pts': -0.1, 'pr|reb': 0.05, 'reb|reb': 0.0, 'pts|thr': -0.05, 'pra|pts': -0.05, 'pa|pts': -0.05, 'reb|thr': -0.05, 'pra|reb': 0.0, 'pr|thr': -0.05, 'pr|pra': -0.05, 'pa|reb': 0.05, 'pa|pr': -0.05, 'ast|pr': 0.1, 'pra|thr': 0.0, 'pa|thr': -0.05, 'ast|thr': 0.1, 'pa|pra': 0.05, 'ast|pra': 0.05, 'ast|pa': 0.05, 'ast|ast': -0.05, 'pr|pr': -0.05, 'thr|thr': 0.0, 'pra|pra': 0.0, 'pa|pa': 0.0},
    opp: {'pts|reb': 0.05, 'ast|pts': -0.05, 'ast|reb': 0.0, 'pr|pts': 0.0, 'pts|pts': 0.0, 'pr|reb': 0.0, 'reb|reb': -0.05, 'pts|thr': 0.0, 'pra|pts': 0.0, 'pa|pts': 0.0, 'reb|thr': 0.0, 'pra|reb': 0.0, 'pr|thr': 0.0, 'pr|pra': -0.05, 'pa|reb': -0.05, 'pa|pr': 0.0, 'ast|pr': 0.05, 'pra|thr': 0.05, 'pa|thr': 0.0, 'ast|thr': 0.05, 'pa|pra': 0.0, 'ast|pra': 0.05, 'ast|pa': 0.0, 'ast|ast': 0.05, 'pr|pr': 0.0, 'thr|thr': 0.0, 'pra|pra': 0.05, 'pa|pa': 0.05},
    sideOwn: {'pts': 0.15, 'reb': 0.15, 'ast': 0.1, 'pr': 0.199, 'thr': 0.099, 'pra': 0.199, 'pa': 0.149},
    sideOpp: {'pts': -0.1, 'reb': -0.15, 'ast': -0.149, 'pr': -0.149, 'thr': -0.099, 'pra': -0.199, 'pa': -0.099},
    total: {'pts': 0.15, 'reb': -0.1, 'ast': 0.149, 'pr': 0.099, 'thr': 0.099, 'pra': 0.099, 'pa': 0.099}
  };
  // game lines (11/16): tools/sgp_lines_corr.py, from Onyx's opening lines and the finals (NBA 2,323 games, college
  // basketball 5,420, NHL 1,500, tennis 13,928 matches; each beat independence on the later half of its games held out).
  // favMl / favSp = the favorite's moneyline / spread with the over (the underdog's takes the opposite sign); same = a
  // team's moneyline with its own spread; cross = with the other team's spread; excl = two sides of one market.
  var LINES = {
    nba: {same: 0.934, cross: -0.934, excl: -0.99, favMl: 0.147, favSp: 0.098},
    cbb: {same: 0.942, cross: -0.942, excl: -0.99, favMl: 0.0, favSp: -0.099},
    nhl: {same: 0.875, cross: -0.924, excl: -0.99, favMl: -0.049, favSp: -0.097},
    tennis: {same: 0.942, cross: -0.942, excl: -0.99, favMl: -0.149, favSp: -0.595}
  };
  NBA.team['fb|fb'] = NBA.opp['fb|fb'] = -0.35;      // two first baskets: only one player scores it (estimate, as the NFL's first TD)
  var FB_TABLE = {same: SAME_PLAYER, team: TEAMMATES, opp: OPPONENTS, sideOwn: SIDE_OWN, sideOpp: SIDE_OPP, total: TOTAL, sides: SIDES, favOver: TOTAL.side, sp: 0.3};
  var NBA_TABLE = {same: NBA.same, team: NBA.team, opp: NBA.opp, sideOwn: NBA.sideOwn, sideOpp: NBA.sideOpp, total: NBA.total, sides: LINES.nba, gtot: 0.75, sp: 0.3};
  var TABLES = {nfl: FB_TABLE, cfb: FB_TABLE, nba: NBA_TABLE,
    cbb: {sides: LINES.cbb}, nhl: {sides: LINES.nhl}, tennis: {sides: LINES.tennis}};
  var TB = TABLES[SPORT] || FB_TABLE;

  function pk(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function rho(a, b) {
    if (!a.gid || a.gid !== b.gid) return 0;
    var A = a.cat, B = b.cat, base, t = TB, cl = function (o, k) { return o && o[k] != null ? o[k] : null; };
    if (a.kind === 'prop' && b.kind === 'prop' && a.name && a.name === b.name && A !== 'gtot') { var v = cl(t.same, pk(A, B)); base = v != null ? v : (t.sp != null ? t.sp : 0.3); }
    else if (A === 'total' && B === 'total') base = 0.99;                                  // one total: the same bet, or its other side
    else if ((A === 'total' || A === 'gtot') && (B === 'total' || B === 'gtot')) base = t.gtot != null ? t.gtot : 0;
    else if (A === 'total' || B === 'total' || A === 'gtot' || B === 'gtot') {
      var tl = A === 'total' || A === 'gtot' ? a : b, o = tl === a ? b : a;
      if (o.cat === 'side') { var fo = (t.sides || {})[o.kind === 'ml' ? 'favMl' : 'favSp']; base = (fo != null ? fo : t.favOver || 0) * (o.fav ? 1 : -1) * (tl.cat === 'gtot' ? 0.8 : 1); }
      else base = (cl(t.total, o.cat) || 0) * (tl.cat === 'gtot' ? 0.8 : 1);
    }
    else if (A === 'side' && B === 'side') {
      var sd = t.sides || SIDES;
      base = a.team === b.team ? sd.same : a.kind === b.kind && sd.excl != null ? sd.excl : sd.cross != null ? sd.cross : sd.opp;
    }
    else if (A === 'side' || B === 'side') { var s = A === 'side' ? a : b, o2 = A === 'side' ? b : a; base = cl(s.team === o2.team ? t.sideOwn : t.sideOpp, o2.cat) || 0; }
    else if (a.team && a.team === b.team) base = cl(t.team, pk(A, B)) || 0;
    else base = cl(t.opp, pk(A, B)) || 0;
    return base * a.dir * b.dir;
  }

  // ── math ────────────────────────────────────────────────────────────────────────────────────────────────────
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function qnorm(p) {   // inverse normal CDF (Acklam)
    if (p <= 0) return -9; if (p >= 1) return 9;
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q, r;
    if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function chol(A, n) {
    var L = new Float64Array(n * n);
    for (var i = 0; i < n; i++) for (var j = 0; j <= i; j++) {
      var s = A[i * n + j]; for (var k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 1e-9) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
    }
    return L;
  }
  // one block of legs (one game, or one lone leg): f[mask] = chance every leg in mask hits (superset sums)
  function block(legs, idx, runs, opt) {
    var m = idx.length, f;
    if (m === 1 && !opt.mc) { f = new Float64Array(2); f[0] = 1; f[1] = legs[idx[0]].p; return {idx: idx, f: f, shrink: 1}; }
    var A = new Float64Array(m * m), L = null, shrink = 1;
    for (var i = 0; i < m; i++) for (var j = 0; j < m; j++) A[i * m + j] = i === j ? 1 : (opt.indep ? 0 : rho(legs[idx[i]], legs[idx[j]]));
    for (var t = 0; t < 40 && !(L = chol(A, m)); t++) { shrink *= 0.9; for (var i2 = 0; i2 < m; i2++) for (var j2 = 0; j2 < m; j2++) if (i2 !== j2) A[i2 * m + j2] *= 0.9; }
    if (!L) { L = new Float64Array(m * m); for (var i3 = 0; i3 < m; i3++) L[i3 * m + i3] = 1; shrink = 0; }
    var q = idx.map(function (k) { return qnorm(legs[k].p); }), R = rng(opt.seed || SEED), e = new Float64Array(m + 1), N = 1 << m;
    f = new Float64Array(N);
    for (var r = 0; r < runs; r++) {
      for (var g = 0; g < m; g += 2) { var u1 = R() || 1e-12, u2 = R(), rad = Math.sqrt(-2 * Math.log(u1)); e[g] = rad * Math.cos(6.283185307179586 * u2); e[g + 1] = rad * Math.sin(6.283185307179586 * u2); }
      var mask = 0;
      for (var a = 0; a < m; a++) { var z = 0; for (var b = 0; b <= a; b++) z += L[a * m + b] * e[b]; if (z < q[a]) mask |= 1 << a; }
      f[mask] += 1;
    }
    for (var bit = 0; bit < m; bit++) for (var s = 0; s < N; s++) if (!(s & (1 << bit))) f[s] += f[s | (1 << bit)];
    for (var s2 = 0; s2 < N; s2++) f[s2] /= runs;
    return {idx: idx, f: f, shrink: shrink};
  }
  // opt: {runs, oneBlock (every leg in one Monte Carlo block), indep (zero correlation), mc (simulate lone legs too)}
  function simulate(legs, opt) {
    opt = opt || {}; var runs = opt.runs || RUNS, groups = {}, order = [];
    legs.forEach(function (L, i) { var k = opt.oneBlock ? 'all' : (L.gid ? 'g' + L.gid : 'i' + i); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); });
    return {n: legs.length, runs: runs, blocks: order.map(function (k) { return block(legs, groups[k], runs, opt); })};
  }
  function joint(sim, gm) {   // chance every leg in the global bitmask gm hits
    var p = 1;
    sim.blocks.forEach(function (B) { var lm = 0; B.idx.forEach(function (gi, li) { if (gm & (1 << gi)) lm |= 1 << li; }); p *= B.f[lm]; });
    return p;
  }
  function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

  // ── legs ────────────────────────────────────────────────────────────────────────────────────────────────────
  function catOf(r) {
    if (r.kind === 'spread' || r.kind === 'ml') return 'side';
    if (r.kind === 'total') return 'total';
    if (r.mkt === 'rush_rec_yds') return ROLE[u.nk(r.name)] === 'RB' ? 'rush' : 'recv';
    return CAT[r.mkt] || 'recv';
  }
  function teamOf(r) { return r.kind === 'spread' || r.kind === 'ml' ? (r.team || r.name || r.who) : r.kind === 'total' ? null : r.team; }
  function idOf(r) { if (r.sel) return r.sel; var w = window.OnyxSaved && OnyxSaved.withId ? OnyxSaved.withId(Object.assign({sport: SPORT}, r)) : null; return (w && w.id) || ('k:' + r.label); }
  function betKey(l) { return (l.gid || l.matchup) + '|' + (l.kind === 'prop' ? l.mkt + ':' + (l.name || '') : l.kind); }
  function live(r) { return !(Date.parse(r.start) <= Date.now()); }
  function clampP(p) { return Math.min(0.995, Math.max(0.005, p)); }
  function mkLeg(src, extra) {
    var L = {id: idOf(src), sel: src.sel || null, label: src.label, price: src.price, gid: src.gid || null, team: teamOf(src), name: src.name, kind: src.kind,
      mkt: src.mkt, side: src.side, line: src.line, start: src.start, conf: src.conf, edge: src.edge, own: !!src.no_read, off: false, row: src};
    if (extra) Object.keys(extra).forEach(function (k) { L[k] = extra[k]; });
    L.dec = u.dec(L.price); L.p = clampP(L.conf != null ? L.conf : u.imp(L.price)); L.cat = catOf(L);
    L.dir = L.cat === 'side' ? 1 : (L.side === 'under' ? -1 : 1);
    // a side's favorite or underdog (its link with the total turns on it): the spread's sign, the cheaper moneyline
    if (L.cat === 'side') L.fav = src._fav != null ? src._fav : src.kind === 'spread' ? src.hcap < 0 : src.price < 0;
    return L;
  }
  function fromRow(r) { return mkLeg(r); }
  function OP() { return window.OnyxParlay || null; }
  function slipLegs() {
    var s = OP() ? OP().slip() : [];
    return s.filter(function (l) { return l && l.price != null; }).map(function (l) {
      var r = (l.sel && BYSEL[l.sel]) || BYID[l.id] || null;
      if (r) return mkLeg(r, {id: l.id});
      var mine = !l.sport || l.sport === SPORT, own = l.conf == null;
      return mkLeg(l, {id: l.id, gid: mine ? l.gid : null, own: own, off: true, edge: null});
    });
  }

  // ── analysis ────────────────────────────────────────────────────────────────────────────────────────────────
  function analyze(legs, runs) {
    var n = legs.length, full = (1 << n) - 1, sim = simulate(legs, {runs: runs || RUNS});
    var dec = legs.reduce(function (m, l) { return m * l.dec; }, 1), naive = legs.reduce(function (m, l) { return m * l.p; }, 1);
    var trueP = joint(sim, full), value = trueP * dec - 1;
    var A = {n: n, legs: legs, sim: sim, dec: dec, price: u.amer(dec), naive: naive, trueP: trueP, value: value, fairDec: 1 / trueP, fair: u.amer(1 / trueP), pays: 10 * dec};
    A.effects = legs.map(function (l, i) {
      if (n < 2) return {mult: l.p * l.dec, without: null};
      var pm = joint(sim, full & ~(1 << i)), vm = pm * dec / l.dec - 1;
      return {mult: (1 + value) / (1 + vm), without: vm, own: l.p * l.dec};
    });
    A.pairs = [];
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) { var r = rho(legs[i], legs[j]); if (Math.abs(r) >= 0.15) A.pairs.push({i: i, j: j, r: r}); }
    A.sameGame = legs.some(function (l, i) { return l.gid && legs.some(function (m, j) { return j !== i && m.gid === l.gid; }); });
    return A;
  }
  function ladder(A) {
    var out = [], n = A.n;
    for (var k = 2; k <= Math.min(5, n); k++) {
      var best = null;
      for (var m = 1; m < (1 << n); m++) {
        if (popcount(m) !== k) continue;
        var d = 1; for (var i = 0; i < n; i++) if (m & (1 << i)) d *= A.legs[i].dec;
        var p = joint(A.sim, m), v = p * d - 1;
        if (!best || v > best.value + 1e-12) best = {k: k, mask: m, dec: d, p: p, value: v};
      }
      if (best) out.push(best);
    }
    return out;
  }

  // ── swaps ───────────────────────────────────────────────────────────────────────────────────────────────────
  function candidates(legs, j) {
    var L = legs[j], others = legs.filter(function (x, i) { return i !== j; }), keys = {}, ids = {};
    others.forEach(function (x) { keys[betKey(x)] = 1; ids[x.id] = 1; }); ids[L.id] = 1;
    var ok = function (r) { return live(r) && !r.no_read && r.price != null && r.conf != null && !ids[r._id] && !keys[betKey(r)]; };
    var top = function (a, n, why) { return a.filter(ok).sort(function (x, y) { return (y.ev || 0) - (x.ev || 0); }).slice(0, n).map(function (r) { return {row: r, why: why}; }); };
    var out = [];
    if (L.gid) {
      out = out.concat(top(ROWS.filter(function (r) {
        if (r.gid !== L.gid || r.kind !== L.kind) return false;
        if (L.kind === 'prop') return r.mkt === L.mkt && r.name === L.name && r.side !== L.side;
        if (L.kind === 'total') return r.side !== L.side;
        return r._team !== L.team;                                      // spread / moneyline: the other team
      }), 2, 'the other side'));
      if (L.kind === 'prop') {
        out = out.concat(top(ROWS.filter(function (r) { return r.gid === L.gid && r.kind === 'prop' && r.name === L.name && r.mkt !== L.mkt; }), 5, 'same player, other market'));
        out = out.concat(top(ROWS.filter(function (r) { return r.gid === L.gid && r.kind === 'prop' && r.team === L.team && r.name !== L.name && r.mkt === L.mkt; }), 5, 'a teammate'));
      }
    }
    out = out.concat(top(ROWS.filter(function (r) { return r.mkt === L.mkt && r.side === L.side && r.gid !== L.gid; }), 6, 'same market, another game'));
    var seen = {}; return out.filter(function (c) { if (seen[c.row._id]) return false; seen[c.row._id] = 1; return true; });
  }
  function swaps(A) {
    if (A.n < 2) return [];
    var order = A.effects.map(function (e, i) { return {i: i, m: e.mult}; }).sort(function (a, b) { return a.m - b.m; }).slice(0, 2);
    var out = [];
    order.forEach(function (o) {
      var best = null;
      candidates(A.legs, o.i).forEach(function (c) {
        var legs = A.legs.slice(); legs[o.i] = fromRow(c.row);
        var B = analyze(legs);
        var gainV = B.value - A.value, gainP = B.trueP / A.trueP - 1;
        if (gainV <= 0.005 && !(gainP > 0.05 && B.value >= A.value - 0.01)) return;
        var score = gainV + 0.25 * Math.max(0, gainP) * (B.value >= A.value ? 1 : 0);
        if (!best || score > best.score) best = {i: o.i, from: A.legs[o.i], to: c.row, why: c.why, B: B, score: score};
      });
      if (best) out.push(best);
    });
    return out;
  }

  // ── presets ─────────────────────────────────────────────────────────────────────────────────────────────────
  function pool(f) { return ROWS.filter(function (r) { return live(r) && !r.no_read && r.conf != null && r.price != null && f(r); }); }
  function distinctGames(rows, n) { var g = {}, out = []; rows.forEach(function (r) { if (out.length < n && !g[r.gid]) { g[r.gid] = 1; out.push(r); } }); return out; }
  var byEv = function (a, b) { return (b.ev || 0) - (a.ev || 0); };
  var GAME = SPORT === 'tennis' ? 'match' : 'game';
  // the plays the model rates best against Onyx's price: its edges first, then the best of the rest
  function bestValue(f) { var a = pool(f).sort(byEv); return a.filter(function (r) { return r.edge > 0; }).concat(a.filter(function (r) { return !(r.edge > 0); })); }
  var PRESETS = {
    value3: {t: "Model's value 3-legger", d: 'The three plays the model rates best against Onyx\'s price, one per ' + GAME + ' (its edges first).', build: function () {
      return distinctGames(bestValue(function (r) { return r.price >= -250 && r.price <= 250; }), 3);
    }},
    td: {t: 'TD long shot', d: 'Three anytime TD scorers at +150 to +500 that the model rates best against Onyx\'s price, three games.', build: function () {
      return distinctGames(pool(function (r) { return r.mkt === 'anytime_td' && r.price >= 150 && r.price <= 500; }).sort(byEv), 3);
    }},
    unders: {t: "Model's unders", d: 'Three player unders (rebounds, assists, 3s or combos, no points) where the model\'s projection sits 2+ under Onyx\'s line, three games: the NBA model\'s own list rule.', build: function () {
      return distinctGames(pool(function (r) { return r.kind === 'prop' && r.side === 'under' && r.proj != null && r.line - r.proj >= 2 && ['reb', 'ast', 'threes', 'pr', 'pa', 'pra'].indexOf(r.mkt) >= 0 && r.price >= -250; })
        .sort(function (x, y) { return (y.line - y.proj) / y.line - (x.line - x.proj) / x.line; }), 3);
    }},
    dogs: {t: 'Underdog double', d: 'Two underdogs to win at +100 to +300, the two the model rates best against Onyx\'s price, two ' + (GAME === 'match' ? 'matches' : 'games') + '.', build: function () {
      return distinctGames(bestValue(function (r) { return r.kind === 'ml' && r.price >= 100 && r.price <= 300; }), 2);
    }},
    safe: {t: 'Safe-ish 2-legger', d: 'The two likeliest plays at -200 or longer where the model agrees with the side, two ' + (GAME === 'match' ? 'matches' : 'games') + '.', build: function () {
      var a = pool(function (r) { return r.price >= -200 && r.price <= 150; }), byC = function (x, y) { return y.conf - x.conf; };
      var good = a.filter(function (r) { return r.edge >= 0; }).sort(byC), rest = a.filter(function (r) { return r.edge < 0; }).sort(byC);
      return distinctGames(good.concat(rest), 2);
    }},
    pair: {t: 'Side + total', d: 'Pick a ' + GAME + ': the model\'s best side there with the total that moves with it.', build: function (gid) { return pair(gid); }},
    sgp: {t: 'Same-game stack', d: 'Pick a game: the model\'s favorite play there plus two legs that move with it.', build: function (gid) { return stack(gid); }}
  };
  var PRESET_KEYS = {nfl: ['value3', 'td', 'safe', 'sgp'], cfb: ['value3', 'td', 'safe', 'sgp'], nba: ['value3', 'unders', 'safe', 'sgp'],
    cbb: ['value3', 'dogs', 'safe', 'pair'], nhl: ['value3', 'dogs', 'safe', 'pair'], tennis: ['value3', 'dogs', 'safe', 'pair']}[SPORT] || ['value3', 'safe', 'sgp'];
  // a side and the total side its link favors (the favorite with the over when favOver > 0)
  function pair(gid) {
    var a = pool(function (r) { return r.gid === gid && r.price >= -400 && r.price <= 400; });
    var sides = a.filter(function (r) { return r.kind === 'spread' || r.kind === 'ml'; }).sort(function (x, y) { return ((y.edge > 0) - (x.edge > 0)) || (y.ev || 0) - (x.ev || 0); });
    if (!sides.length) return [];
    var s0 = sides[0], L = fromRow(s0), tots = a.filter(function (r) { return r.kind === 'total'; });
    var best = null;
    tots.forEach(function (r) { var c = fromRow(r), sc = rho(L, c) + 0.5 * (r.ev || 0); if (!best || sc > best.s) best = {r: r, s: sc}; });
    return best ? [s0, best.r] : [s0];
  }
  function stack(gid) {
    var a = pool(function (r) { return r.gid === gid && r.price >= -300 && r.price <= 350 && ['first_td', 'two_td', 'three_td', 'first_basket', 'trp_dbl'].indexOf(r.mkt) < 0; });
    if (a.length < 2) return [];
    var lead = a.slice().sort(function (x, y) { return ((y.edge > 0) - (x.edge > 0)) || (y.ev || 0) - (x.ev || 0); })[0], picked = [lead];
    while (picked.length < 3) {
      var legs = picked.map(fromRow), keys = {}, best = null;
      picked.forEach(function (r) { keys[betKey(r)] = 1; });
      a.forEach(function (r) {
        if (keys[betKey(r)] || picked.indexOf(r) >= 0) return;
        var tot = function (x) { return x.kind === 'total' || CAT[x.mkt] === 'gtot'; };      // one total-type leg a stack
        if (tot(r) && picked.some(tot)) return;
        var c = fromRow(r), link = Math.max.apply(null, legs.map(function (l) { return rho(l, c); }));
        if (link < 0.1) return;
        var A = analyze(legs.concat([c]), QUICK), score = A.value + 0.5 * link;
        if (!best || score > best.s) best = {r: r, s: score};
      });
      if (!best) break; picked.push(best.r);
    }
    return picked;
  }

  // ── view helpers ────────────────────────────────────────────────────────────────────────────────────────────
  function gameName(gid, fb) { var g = D.game(gid); return g ? (g.tennis ? g.name || g.away + ' vs ' + g.home : g.away + ' @ ' + g.home) : (fb || ''); }
  function sgn(x, d) { return (x > 0 ? '+' : '') + (100 * x).toFixed(d == null ? 0 : d) + '%'; }
  function cls(x) { return x > 0.0005 ? 'sx-pos' : x < -0.0005 ? 'sx-neg' : ''; }
  function chance(p) { return p < 0.01 ? (100 * p).toFixed(2) + '%' : p < 0.1 ? (100 * p).toFixed(1) + '%' : (100 * p).toFixed(0) + '%'; }
  function money(x) { return '$' + (x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(2)); }
  function meter(v) {
    var w = Math.min(50, Math.abs(v) / 0.5 * 50), t = Math.min(1, Math.max(0, v / 0.3));
    var col = v < 0 ? '#ff8a8a' : 'rgb(' + Math.round(176 + (97 - 176) * t) + ',' + Math.round(56 + (233 - 56) * t) + ',' + Math.round(249 + (112 - 249) * t) + ')';
    return '<div class="lab-meter" role="img" aria-label="Value ' + sgn(v, 1) + '"><i style="' + (v < 0 ? 'right:50%' : 'left:50%') + ';width:' + w.toFixed(1) + '%;background:' + col + '"></i><b></b></div>'
      + '<div class="lab-meter-k"><span>Onyx pays less</span><span>fair</span><span>Onyx pays more</span></div>';
  }
  function onSlipIds() { var o = {}; (OP() ? OP().slip() : []).forEach(function (l) { o[l.id] = 1; }); return o; }
  function sub(r) { return [gameName(r.gid, r.matchup), u.fmtTime(r.start), MK[r.mkt] || r.mkt].filter(Boolean).join(' · '); }
  function rowHTML(r, on) {
    var e = r.no_read ? '<span class="lab-own">Onyx\'s own</span>' : '<span class="' + cls(r.edge) + '"><i>Edge</i>' + (r.edge > 0 ? '+' : '') + (100 * r.edge).toFixed(1) + '</span>';
    return '<div class="lab-r"><div class="lab-rm"><b>' + u.esc(r.label) + '</b><small>' + u.esc(sub(r)) + '</small></div>'
      + '<div class="lab-rn"><span><i>Model</i>' + u.pct(r.conf) + '</span><span><i>Onyx</i>' + u.odds(r.price) + '</span>' + e + '</div>'
      + '<button type="button" class="lab-add' + (on ? ' on' : '') + '" data-add="' + u.esc(r._id) + '">' + (on ? 'On slip' : '+ Add') + '</button></div>';
  }

  // ── leg picker ──────────────────────────────────────────────────────────────────────────────────────────────
  function pickRows() {
    var q = u.nk(F.q), pr = F.price;
    var a = ROWS.filter(function (r) {
      if (!live(r) || r.price == null) return false;
      if (F.gid && r.gid !== F.gid) return false;
      if (F.mkt && r.mkt !== F.mkt) return false;
      if (F.side && !((r.kind === 'prop' || r.kind === 'total') && r.side === F.side)) return false;
      if (pr === 'fav' && !(r.price < 0)) return false;
      if (pr === 'safe' && !(r.price >= -200)) return false;
      if (pr === 'even' && !(r.price >= -200 && r.price <= 200)) return false;
      if (pr === 'plus' && !(r.price >= 100 && r.price <= 300)) return false;
      if (pr === 'long' && !(r.price > 300)) return false;
      if (F.mode === 'likes' && !(r.edge > 0 && !r.no_read)) return false;
      if (q && u.nk(r.label + ' ' + (r.team || '') + ' ' + gameName(r.gid, r.matchup)).indexOf(q) < 0) return false;
      return true;
    });
    if (F.mode === 'likes') a.sort(function (x, y) { return y.edge - x.edge; });
    else if (F.mode === 'likely') a.sort(function (x, y) { return y.conf - x.conf; });
    else a.sort(function (x, y) { return (y.ev || 0) - (x.ev || 0); });
    return a;
  }
  function renderPicker() {
    var box = ROOT.querySelector('#labRows'); if (!box) return;
    var a = pickRows(), on = onSlipIds();
    ROOT.querySelector('#labCount').textContent = a.length + ' play' + (a.length === 1 ? '' : 's');
    Array.prototype.forEach.call(ROOT.querySelectorAll('[data-mode]'), function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === F.mode); });
    box.innerHTML = a.length ? a.slice(0, F.lim).map(function (r) { return rowHTML(r, on[r._id]); }).join('')
      + (a.length > F.lim ? '<button type="button" class="sx-btn ghost lab-more" data-more="1">Show ' + Math.min(40, a.length - F.lim) + ' more</button>' : '')
      : '<p class="lab-empty">' + (ROWS.some(live) ? (F.mode === 'likes' ? 'The model does not like any play with these filters. Try "Most likely" or "All".' : 'No plays match these filters.') : 'Every game on this board has started. The next slate shows here once Onyx posts it.') + '</p>';
  }
  function pickerShell() {
    var games = {}; ROWS.forEach(function (r) { if (live(r)) games[r.gid] = games[r.gid] || {gid: r.gid, t: Date.parse(r.start), m: r.matchup}; });
    var gl = Object.keys(games).map(function (k) { return games[k]; }).sort(function (a, b) { return a.t - b.t; });
    var mk = {}; ROWS.forEach(function (r) { if (live(r)) mk[r.mkt] = (mk[r.mkt] || 0) + 1; });
    return '<div class="sx-card lab-pick"><div class="lab-ph"><h3 class="sx-h">Leg picker</h3><span class="sx-k" id="labCount"></span></div>'
      + '<div class="lab-modes"><button type="button" class="sx-chip" data-mode="likes">Model likes</button><button type="button" class="sx-chip" data-mode="likely">Most likely</button><button type="button" class="sx-chip" data-mode="all">All</button></div>'
      + '<input class="sx-in lab-q" id="labQ" type="search" placeholder="' + (SPORT === 'tennis' ? 'Search a player' : PROPS ? 'Search a player or team' : 'Search a team') + '" autocomplete="off">'
      + '<div class="lab-f">'
      + '<select class="sx-sel" data-f="gid" aria-label="Game"><option value="">Every game</option>' + gl.map(function (g) { return '<option value="' + u.esc(g.gid) + '">' + u.esc(gameName(g.gid, g.m)) + '</option>'; }).join('') + '</select>'
      + '<select class="sx-sel" data-f="mkt" aria-label="Market"><option value="">Every market</option>' + MK_ORDER.filter(function (k) { return mk[k]; }).map(function (k) { return '<option value="' + k + '">' + MK[k] + ' (' + mk[k] + ')</option>'; }).join('') + '</select>'
      + '<select class="sx-sel" data-f="side" aria-label="Side"><option value="">Any side</option><option value="over">Overs</option><option value="under">Unders</option></select>'
      + '<select class="sx-sel" data-f="price" aria-label="Price"><option value="">Any price</option><option value="fav">Favorites</option><option value="safe">-200 or longer</option><option value="even">-200 to +200</option><option value="plus">+100 to +300</option><option value="long">Longer than +300</option></select>'
      + '</div><div id="labRows"></div></div>';
  }

  // ── presets view ────────────────────────────────────────────────────────────────────────────────────────────
  function presetsHTML() {
    var games = {}; ROWS.forEach(function (r) { if (live(r) && !r.no_read) games[r.gid] = games[r.gid] || {gid: r.gid, t: Date.parse(r.start), m: r.matchup}; });
    var gl = Object.keys(games).map(function (k) { return games[k]; }).sort(function (a, b) { return a.t - b.t; });
    var cards = PRESET_KEYS.map(function (k) {
      var P = PRESETS[k];
      return '<div class="lab-pre"><b>' + u.esc(P.t) + '</b><small>' + u.esc(P.d) + '</small>'
        + (k === 'sgp' || k === 'pair' ? '<select class="sx-sel lab-sgp" id="labSgp" aria-label="Game for the stack">' + gl.map(function (g) { return '<option value="' + u.esc(g.gid) + '">' + u.esc(gameName(g.gid, g.m)) + '</option>'; }).join('') + '</select>' : '')
        + '<button type="button" class="sx-btn" data-preset="' + k + '"' + (gl.length ? '' : ' disabled') + '>Build it</button></div>';
    }).join('');
    return '<div class="sx-card lab-pres"><h3 class="sx-h">One-tap ideas</h3><p class="sx-sub">Built from today\'s board by the model. Each one is a model idea, not an Onyx Pick.</p>'
      + '<div class="lab-pgrid">' + cards + '</div><div id="labPreview"></div></div>';
  }
  function renderPreview() {
    var box = ROOT.querySelector('#labPreview'); if (!box) return;
    if (!PREVIEW) { box.innerHTML = ''; return; }
    var rows = PREVIEW.rows;
    if (!rows.length) { box.innerHTML = '<p class="lab-empty">Not enough board plays to build this one right now.</p>'; return; }
    var A = analyze(rows.map(fromRow)), n = (OP() ? OP().slip() : []).length;
    box.innerHTML = '<div class="lab-prev"><div class="lab-ph"><b>' + u.esc(PRESETS[PREVIEW.k].t) + '</b><span class="lab-tag">model idea, not an Onyx Pick</span></div>'
      + rows.map(function (r) { return '<div class="lab-pl"><span><b>' + u.esc(r.label) + '</b><small>' + u.esc(sub(r)) + '</small></span><em>' + u.pct(r.conf) + ' · ' + u.odds(r.price) + '</em></div>'; }).join('')
      + '<div class="lab-mini"><span><i>Onyx</i>' + u.odds(A.price) + '</span><span><i>$10 pays</i>' + money(A.pays) + '</span><span><i>Model chance</i>' + chance(A.trueP) + '</span><span class="' + cls(A.value) + '"><i>Value</i>' + sgn(A.value) + '</span></div>'
      + '<div class="lab-btns"><button type="button" class="sx-btn" data-load="replace">' + (n ? 'Replace my slip with these' : 'Put these on my slip') + '</button>' + (n ? '<button type="button" class="sx-btn ghost" data-load="add">Add to my slip</button>' : '') + '</div></div>';
  }

  // ── analysis view ───────────────────────────────────────────────────────────────────────────────────────────
  function renderSlip() {
    var box = ROOT.querySelector('#labSlip'), sw = ROOT.querySelector('#labSwap'), ld = ROOT.querySelector('#labLadder');
    var legs = slipLegs(), cols = ROOT.querySelector('.lab-cols');
    cols.classList.toggle('empty', !legs.length);
    SWAPJOB++;
    if (!legs.length) {
      LAST = null;
      box.innerHTML = '<div class="sx-card lab-an lab-none"><h3 class="sx-h">Your slip is empty</h3><p class="sx-sub">Tap a one-tap idea or "+ Add" any play and the lab reads it here: the combined Onyx odds, the model\'s true chance every leg hits (same-game legs included), fair odds, value, better swaps and a ladder.</p></div>';
      sw.innerHTML = ''; ld.innerHTML = ''; return;
    }
    if (legs.length > 12) legs = legs.slice(0, 12);
    var A = analyze(legs), n = A.n, worst = -1;
    if (n >= 2) { var wm = Infinity; A.effects.forEach(function (e, i) { if (e.mult < wm) { wm = e.mult; worst = i; } }); }
    LAST = {A: A, shown: n >= 2 ? u.odds(A.price) : u.odds(legs[0].price)};
    var flags = {}; A.pairs.forEach(function (p) { (flags[p.i] = flags[p.i] || []).push(p); (flags[p.j] = flags[p.j] || []).push(p); });
    var legsHTML = legs.map(function (l, i) {
      var e = A.effects[i], f = [];
      if (l.own) f.push('<span class="lab-fl own">this leg\'s chance is Onyx\'s own (no model read)</span>');
      if (l.off) f.push('<span class="lab-fl own">not on today\'s ' + u.esc(D.sportName) + ' board: read on its own</span>');
      if (n >= 2 && i === worst && e.mult < 1) f.push('<span class="lab-fl bad">drags the value down most</span>');
      return '<div class="lab-leg' + (i === worst && n >= 2 && e.mult < 1 ? ' worst' : '') + '"><div class="lab-lm"><b>' + u.esc(l.label) + '</b><small>' + u.esc(sub(l)) + '</small>' + (f.length ? '<div>' + f.join('') + '</div>' : '') + '</div>'
        + '<div class="lab-ln"><span><i>Model</i>' + chance(l.p) + '</span><span><i>Onyx</i>' + u.odds(l.price) + '</span>'
        + (n >= 2 ? '<span class="' + (e.mult >= 1 ? 'sx-pos' : 'sx-neg') + '" title="What this leg does to the slip\'s value"><i>Pull</i>x' + e.mult.toFixed(2) + '</span>' : '<span class="' + cls(l.p * l.dec - 1) + '"><i>Value</i>' + sgn(l.p * l.dec - 1) + '</span>') + '</div>'
        + '<button type="button" class="lab-x" data-rm="' + u.esc(l.id) + '" aria-label="Remove ' + u.esc(l.label) + '">&times;</button></div>';
    }).join('');
    var pairs = A.pairs.map(function (p) {
      var a = legs[p.i], b = legs[p.j], good = p.r > 0;
      return '<li class="' + (good ? 'sx-pos' : 'sx-neg') + '"><b>' + u.esc(short(a)) + '</b> + <b>' + u.esc(short(b)) + '</b>: ' + (good ? 'these two move together (good for you)' : 'these two fight each other') + ' <span class="lab-r0">correlation ' + (p.r > 0 ? '+' : '') + p.r.toFixed(2) + '</span></li>';
    }).join('');
    var sels = legs.map(function (l) { return l.sel; }), missing = legs.filter(function (l) { return !l.sel; });
    var adj = A.trueP / A.naive - 1;
    box.innerHTML = '<div class="sx-card lab-an"><div class="lab-ph"><h3 class="sx-h">Your slip · ' + n + ' leg' + (n === 1 ? '' : 's') + '</h3><button type="button" class="sx-chip" data-clear="1">Clear</button></div>'
      + '<div class="lab-legs">' + legsHTML + '</div>'
      + (n < 2 ? '<p class="sx-sub lab-one">Add one more leg to see the parlay. Below: ideas and the leg picker.</p>' :
        '<div class="lab-stats"><div><span class="sx-k">Onyx odds</span><span class="sx-big" id="labOdds">' + u.odds(A.price) + '</span><small>legs multiplied, x' + A.dec.toFixed(2) + '</small></div>'
        + '<div><span class="sx-k">$10 pays</span><span class="sx-big sx-pos">' + money(A.pays) + '</span><small>stake included</small></div>'
        + '<div><span class="sx-k">Model chance all hit</span><span class="sx-big sx-pur">' + chance(A.trueP) + '</span><small>' + (A.sameGame ? 'legs multiplied ' + chance(A.naive) + ', same game ' + (adj >= 0 ? 'lifts it ' : 'cuts it ') + Math.abs(100 * adj).toFixed(0) + '%' : 'different games, legs multiplied') + '</small></div>'
        + '<div><span class="sx-k">Fair odds</span><span class="sx-big">' + u.odds(A.fair) + '</span><small>what the model says it should pay</small></div></div>'
        + '<div class="lab-val"><div class="lab-ph"><span class="sx-k">Value vs Onyx\'s price</span><b class="' + cls(A.value) + '">' + sgn(A.value, 1) + '</b></div>' + meter(A.value)
        + '<p class="lab-vt">' + (A.value >= 0 ? 'Per $100 the model expects ' + money(100 * A.value) + ' back over many tries: Onyx pays more than the model\'s chance says it should.' : 'Per $100 the model expects to give back ' + money(-100 * A.value) + ' over many tries: Onyx pays less than the model\'s chance says it should.') + '</p></div>'
        + (pairs ? '<ul class="lab-pairs">' + pairs + '</ul>' : '')
        + (A.sameGame ? '<p class="lab-note">Same-game legs: Onyx prices them together, so its ticket can pay less than the legs multiplied shown here.</p>' : ''))
      + '<div class="lab-send">' + (missing.length
        ? '<button type="button" class="sx-btn" disabled>Send to Onyx</button><p class="lab-note">' + missing.length + ' leg' + (missing.length === 1 ? ' has' : 's have') + ' no Onyx selection yet (' + u.esc(missing.map(short).join(', ')) + '), so this slip cannot open on Onyx. Swap ' + (missing.length === 1 ? 'it' : 'them') + ' for a board play to send it.</p>'
        : '<a class="sx-btn lab-go" href="#" target="_blank" rel="noopener" data-send="1">Send ' + (n === 1 ? 'this leg' : 'all ' + n + ' legs') + ' to Onyx · ' + u.odds(n >= 2 ? A.price : legs[0].price) + '</a>') + '</div></div>';
    box.querySelector('[data-send]') && (box.querySelector('[data-send]').dataset.sels = JSON.stringify(sels));
    // ladder
    var L = n >= 3 ? ladder(A) : [];
    ld.innerHTML = L.length ? '<div class="sx-card"><h3 class="sx-h">Ladder</h3><p class="sx-sub">The best ' + (n > 5 ? '2 to 5' : '2 to ' + n) + ' legs of your slip by value: see what each leg adds to the payout and costs in chance.</p>'
      + L.map(function (s) {
        var ls = legs.filter(function (l, i) { return s.mask & (1 << i); });
        return '<div class="lab-lad"><div class="lab-lk">' + s.k + '<small>legs</small></div><div class="lab-lm"><small>' + u.esc(ls.map(short).join(' + ')) + '</small>'
          + '<div class="lab-mini"><span><i>Onyx</i>' + u.odds(u.amer(s.dec)) + '</span><span><i>$10 pays</i>' + money(10 * s.dec) + '</span><span><i>Chance</i>' + chance(s.p) + '</span><span class="' + cls(s.value) + '"><i>Value</i>' + sgn(s.value) + '</span></div></div>'
          + (s.k < n ? '<button type="button" class="sx-chip" data-ladder="' + s.mask + '">Use</button>' : '<span class="lab-tag">your slip</span>') + '</div>';
      }).join('') + '</div>' : '';
    // swaps: computed after paint
    sw.innerHTML = n >= 2 ? '<div class="sx-card"><h3 class="sx-h">Swap suggestions</h3><p class="lab-empty">Checking the board for better legs</p></div>' : '';
    if (n >= 2) { var job = SWAPJOB; setTimeout(function () { if (job === SWAPJOB) renderSwaps(A); }, 30); }
  }
  function short(l) {
    var s = l.label || '';
    if (l.kind === 'prop') s = s.replace(/ (receiving|rushing|passing) (yards|yds)$/, ' $1').replace(/ receptions$/, ' rec').replace(/ pass attempts$/, ' att');
    if (l.kind === 'prop') s = s.replace(/ points \+ rebounds \+ assists$/, ' PRA').replace(/ points \+ rebounds$/, ' P+R').replace(/ points \+ assists$/, ' P+A').replace(/ 3-pointers made$/, ' 3s');
    if (l.kind === 'total') s += ' (' + gameName(l.gid, l.matchup) + ')';
    return s;
  }
  function renderSwaps(A) {
    var sw = ROOT.querySelector('#labSwap'), S = swaps(A);
    sw.innerHTML = '<div class="sx-card"><h3 class="sx-h">Swap suggestions</h3>' + (S.length ? '<p class="sx-sub">For your weakest legs, the board play that lifts the slip most. One tap swaps it on your slip.</p>' + S.map(function (s) {
      var B = s.B;
      return '<div class="lab-sw"><div class="lab-swl"><span class="sx-k">Swap out</span><s>' + u.esc(s.from.label) + '</s><span class="sx-k">for</span><b>' + u.esc(s.to.label) + '</b><small>' + u.esc(s.why + ' · ' + sub(s.to) + ' · model ' + u.pct(s.to.conf) + ' at ' + u.odds(s.to.price)) + '</small></div>'
        + '<div class="lab-ba"><span><i>Value</i><em class="' + cls(A.value) + '">' + sgn(A.value) + '</em> &rarr; <em class="' + cls(B.value) + '">' + sgn(B.value) + '</em></span>'
        + '<span><i>Chance</i>' + chance(A.trueP) + ' &rarr; ' + chance(B.trueP) + '</span><span><i>$10 pays</i>' + money(A.pays) + ' &rarr; ' + money(B.pays) + '</span></div>'
        + '<button type="button" class="sx-btn" data-swap="' + u.esc(s.from.id) + '" data-to="' + u.esc(s.to._id) + '">Swap it</button></div>';
    }).join('') : '<p class="lab-empty">No single swap on the board lifts this slip\'s value or chance. The model is happy with these legs.</p>') + '</div>';
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────────
  function schedule() { clearTimeout(TIMER); TIMER = setTimeout(function () { renderSlip(); renderPicker(); if (PREVIEW) renderPreview(); }, 40); }
  function loadRows(rows, replace) {
    var P = OP(); if (!P) return;
    if (replace) P.clear();
    var on = onSlipIds();
    rows.forEach(function (r) { if (!on[r._id]) P.add(r); });
  }
  function onClick(e) {
    var t = e.target.closest ? e.target : null; if (!t) return;
    var b = t.closest('[data-add],[data-rm],[data-preset],[data-load],[data-swap],[data-ladder],[data-more],[data-mode],[data-clear],[data-send]');
    if (!b || !ROOT.contains(b)) return;
    var P = OP();
    if (b.hasAttribute('data-add')) { var r = BYID[b.getAttribute('data-add')]; if (r && P) P.add(r); }
    else if (b.hasAttribute('data-rm')) { if (P) P.remove(b.getAttribute('data-rm')); }
    else if (b.hasAttribute('data-clear')) { if (P) P.clear(); }
    else if (b.hasAttribute('data-preset')) {
      var k = b.getAttribute('data-preset'), gid = k === 'sgp' || k === 'pair' ? (ROOT.querySelector('#labSgp') || {}).value : null;
      PREVIEW = {k: k, rows: PRESETS[k].build(gid)}; renderPreview();
      var pv = ROOT.querySelector('#labPreview'); if (pv && pv.scrollIntoView) try { pv.scrollIntoView({block: 'nearest', behavior: 'smooth'}); } catch (x) {}
    }
    else if (b.hasAttribute('data-load')) { if (PREVIEW) loadRows(PREVIEW.rows, b.getAttribute('data-load') === 'replace'); }
    else if (b.hasAttribute('data-swap')) { var to = BYID[b.getAttribute('data-to')]; if (P && to) { P.remove(b.getAttribute('data-swap')); P.add(to); } }
    else if (b.hasAttribute('data-ladder')) {
      var mask = +b.getAttribute('data-ladder'), legs = LAST && LAST.A.legs;
      if (P && legs) legs.forEach(function (l, i) { if (!(mask & (1 << i))) P.remove(l.id); });
    }
    else if (b.hasAttribute('data-more')) { F.lim += 40; renderPicker(); }
    else if (b.hasAttribute('data-mode')) { F.mode = b.getAttribute('data-mode'); F.lim = 40; renderPicker(); }
    else if (b.hasAttribute('data-send')) {
      var sels = []; try { sels = JSON.parse(b.dataset.sels || '[]'); } catch (x) {}
      var href = u.onyx(sels, 'lab');
      if (href) b.setAttribute('href', href); else e.preventDefault();
    }
  }
  function css() {
    if (document.getElementById('sx-lab-css')) return;
    var s = document.createElement('style'); s.id = 'sx-lab-css';
    s.textContent = [
      '.lab-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}',
      '.lab-main,.lab-side{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.lab-cols.empty .lab-main{order:2}',
      '@media (min-width:960px){.lab-cols{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);align-items:start}.lab-cols.empty .lab-main{order:0}}',
      '.lab-ph{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.lab-ph .sx-h{margin:0}',
      '.lab-tag{font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--pur2);border:1px solid rgba(176,56,249,.5);border-radius:999px;padding:3px 8px;white-space:nowrap}',
      '.lab-pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));gap:8px}',
      '.lab-pre{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:14px;background:linear-gradient(160deg,rgba(176,56,249,.16),rgba(176,56,249,.03));border:1px solid rgba(176,56,249,.35);min-width:0}',
      '.lab-pre b{font-size:15px}.lab-pre small{color:var(--dim);font-size:12.5px;line-height:1.45;flex:1}.lab-pre .sx-btn{margin-top:4px}',
      '.lab-prev{margin-top:12px;padding:12px;border-radius:14px;border:1px solid var(--pur);background:rgba(176,56,249,.07)}',
      '.lab-pl{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,.07);font-size:13.5px}.lab-pl:first-of-type{border-top:0}',
      '.lab-pl span{min-width:0}.lab-pl small,.lab-rm small,.lab-lm small{display:block;color:var(--mute);font:600 11px monospace;margin-top:2px;overflow-wrap:anywhere}',
      '.lab-pl em{font:700 12px monospace;font-style:normal;color:var(--dim);white-space:nowrap}',
      '.lab-mini{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0;font:800 14px monospace}.lab-mini i,.lab-rn i,.lab-ln i,.lab-ba i{display:block;font:700 9.5px monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--mute);font-style:normal}',
      '.lab-btns{display:flex;gap:8px;flex-wrap:wrap}.lab-btns .sx-btn{flex:1 1 160px}',
      '.lab-modes{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.lab-modes .sx-chip.on{background:var(--pur);border-color:var(--pur)}',
      '.lab-q{margin-bottom:8px}',
      '.lab-f{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}.lab-f .sx-sel{min-width:0;font-size:13px;padding:9px 8px}',
      '.lab-r{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"m b" "n b";gap:4px 10px;align-items:center;padding:10px 0;border-top:1px solid rgba(255,255,255,.07)}',
      '.lab-rm{grid-area:m;min-width:0}.lab-rm b{font-size:14px}.lab-rn{grid-area:n;display:flex;gap:14px;font:800 13px monospace}',
      '.lab-own{font:700 10.5px monospace;color:var(--mute);align-self:flex-end}',
      '.lab-add{grid-area:b;border:1px solid var(--pur);background:transparent;color:var(--pur2);border-radius:12px;padding:10px 12px;font:800 13px system-ui;cursor:pointer;min-width:74px;white-space:nowrap}',
      '.lab-add.on{background:var(--pur);color:#fff}',
      '@media (min-width:640px){.lab-r{grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"m n b"}}',
      '.lab-more{width:100%;margin-top:8px}.lab-empty{color:var(--mute);font-size:13px;line-height:1.5;margin:10px 0 0}',
      '.lab-legs{margin:8px 0 4px}',
      '.lab-leg{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"m x" "n x";gap:4px 8px;align-items:center;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.07);margin-top:6px;background:rgba(255,255,255,.02)}',
      '.lab-leg.worst{border-color:rgba(255,138,138,.45)}.lab-lm{grid-area:m;min-width:0}.lab-lm b{font-size:14px}.lab-ln{grid-area:n;display:flex;gap:14px;font:800 13px monospace;flex-wrap:wrap}',
      '.lab-x{grid-area:x;width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--red);font:800 18px system-ui;cursor:pointer}',
      '.lab-fl{display:inline-block;margin:5px 6px 0 0;font:700 10.5px monospace;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}.lab-fl.bad{color:var(--red);border-color:rgba(255,138,138,.45)}',
      '.lab-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.lab-stats>div{padding:10px;border-radius:12px;background:rgba(255,255,255,.035);min-width:0}',
      '.lab-stats .sx-big{display:block;font-size:24px;margin:2px 0}.lab-stats small{color:var(--mute);font-size:11.5px;line-height:1.35;display:block}',
      '.lab-val{padding:12px;border-radius:12px;background:rgba(255,255,255,.035)}.lab-val .lab-ph b{font:800 22px monospace}',
      '.lab-meter{position:relative;height:12px;border-radius:999px;background:rgba(255,255,255,.08);margin:10px 0 4px;overflow:hidden}.lab-meter i{position:absolute;top:0;bottom:0;border-radius:999px;transition:width .35s ease}',
      '.lab-meter b{position:absolute;left:50%;top:-2px;bottom:-2px;width:2px;background:rgba(255,255,255,.55)}',
      '.lab-meter-k{display:flex;justify-content:space-between;font:700 9.5px monospace;color:var(--mute);letter-spacing:.05em;text-transform:uppercase}',
      '.lab-vt{margin:8px 0 0;color:var(--dim);font-size:12.5px;line-height:1.5}',
      '.lab-pairs{list-style:none;margin:12px 0 0;padding:0;font-size:13px;line-height:1.45}.lab-pairs li{padding:6px 0;border-top:1px solid rgba(255,255,255,.07)}.lab-pairs b{color:#fff}',
      '.lab-r0{font:600 10.5px monospace;color:var(--mute)}',
      '.lab-note{color:var(--pur2);font-size:12px;line-height:1.5;margin:10px 0 0}',
      '.lab-send{margin-top:14px}.lab-send .sx-btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-size:15px;padding:13px}',
      '.lab-sw{padding:12px 0;border-top:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:8px}.lab-sw:nth-of-type(1){border-top:0}',
      '.lab-swl{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:14px}.lab-swl s{color:var(--mute)}.lab-swl small{color:var(--mute);font:600 11px monospace;overflow-wrap:anywhere}',
      '.lab-ba{display:flex;flex-wrap:wrap;gap:6px 16px;font:800 13px monospace}.lab-ba em{font-style:normal}',
      '.lab-lad{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid rgba(255,255,255,.07)}',
      '.lab-lk{font:800 24px monospace;color:var(--pur2);text-align:center;line-height:1}.lab-lk small{display:block;font:700 9px monospace;color:var(--mute);text-transform:uppercase}',
      '.lab-lad .lab-mini{margin:6px 0 0;font-size:13px}',
      '.lab-howto{margin-top:12px;color:var(--dim);font-size:12.5px;line-height:1.55}.lab-howto summary{cursor:pointer;color:var(--pur2);font-weight:700}.lab-howto ul{padding-left:18px;margin:6px 0}',
      '.lab-hero{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.lab-hero h2{margin:0;font-size:22px}.lab-hero p{margin:0;color:var(--dim);font-size:13.5px;line-height:1.5}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function howHTML() {
    var f = function (x) { return (x > 0 ? '+' : '') + (+x).toFixed(2); }, li = function (t) { return '<li>' + t + '</li>'; };
    var open = '<details class="lab-howto sx-card"><summary>How the lab reads same-game legs</summary><p>Legs in different ' + (SPORT === 'tennis' ? 'matches' : 'games') + ' multiply. Legs in the same ' + GAME + ' get a correlation, and the lab plays the slip out 5,000 times with every leg keeping the model\'s own chance. ';
    var close = '</ul><p>Model chances are projections, not Onyx Picks.</p></details>';
    var sd = TB.sides || {};
    var lines = function (nm) {
      return li('A ' + nm + '\'s moneyline and its own ' + (MK.spread || 'spread').toLowerCase() + ': ' + f(sd.same) + '; with the other side\'s ' + (MK.spread || 'spread').toLowerCase() + ': ' + f(sd.cross))
        + li('The favorite\'s moneyline and the over: ' + f(sd.favMl) + ', its ' + (MK.spread || 'spread').toLowerCase() + ' and the over: ' + f(sd.favSp) + ' (the underdog takes the other sign)')
        + li('Both sides of one market cannot both win: the lab treats them as near opposite (-0.99).');
    };
    if (SPORT === 'nba') {
      var S = TB.same || {}, T = TB.team || {}, O = TB.opp || {}, To = TB.total || {}, So = TB.sideOwn || {};
      return open + 'Every player link is measured from real games: how often Onyx\'s own lines hit together across 4.7 million same-game pairs in 2,041 games of 2024-25 and 2025-26 (tools/nba_sgp_corr.py). The game lines are measured from 2,323 games\' finals (tools/sgp_lines_corr.py). The main ones:</p><ul>'
        + li('One player\'s points and his points + rebounds + assists: ' + f(S['pra|pts']) + '; his points and rebounds: ' + f(S['pts|reb']) + ', points and assists: ' + f(S['ast|pts']) + ', points and 3s: ' + f(S['pts|thr']))
        + li('Two teammates\' points: ' + f(T['pts|pts']) + ' (they share the shots); a player\'s assists and a teammate\'s points: ' + f(T['ast|pts']))
        + li('Players on opposite teams, points with points: ' + f(O['pts|pts']))
        + li('The game total over and a player\'s points over: ' + f(To.pts) + '; a team covering and its own player\'s points: ' + f(So.pts))
        + lines('team')
        + li('Estimates, not measured (no graded history): double and triple-doubles with that player\'s other markets (+0.30), first basket, and the first-half and first-quarter totals with the game total (+0.75).')
        + li('Unders flip the sign: a points under with a teammate\'s points over fight less than two overs move together.') + close;
    }
    if (SPORT === 'cbb' || SPORT === 'nhl' || SPORT === 'tennis') {
      var nm = SPORT === 'tennis' ? 'player' : 'team', src = {cbb: '5,420 games', nhl: '1,500 games, overtime and shootouts included', tennis: '13,928 matches, the spread and total graded on games'}[SPORT];
      return open + 'This board is game lines only, so three links matter, each measured from Onyx\'s own opening lines and the finals (' + src + ', tools/sgp_lines_corr.py):</p><ul>'
        + lines(nm) + close;
    }
    return '<details class="lab-howto sx-card"><summary>How the lab reads same-game legs</summary><p>Legs in different games multiply. Legs in the same game get a correlation, and the lab plays the slip out 5,000 times with every leg keeping the model\'s own chance. ' + (SPORT === 'cfb' ? 'College football uses the NFL table: every link below was measured on NFL games (no college history has been graded for it), so treat the college numbers as estimates.' : 'Every link is measured from real games: how often Onyx\'s own lines hit together across 524,593 same-game pairs in 2025 and 2026.') + ' The main ones:</p><ul>'
      + '<li>A player\'s receptions over and his receiving yards over: +0.79</li><li>A QB\'s passing over and his own receiver\'s receiving over: +0.35 (his pass attempts and that receiver: +0.25)</li>'
      + '<li>The game total over and a QB\'s passing over: +0.32, an anytime TD +0.25, a receiver over +0.15</li><li>A team covering and its own running back\'s rushing over: +0.19, its anytime TD scorers +0.20</li>'
      + '<li>A team covering and its QB\'s pass attempts over: -0.18 (trailing teams throw more)</li><li>Two teammates both scoring a TD: -0.10 (they share the end zone)</li>'
      + '<li>Players on opposite teams: about 0. A "shootout" lifts both sides less than it feels like.</li>'
      + '<li>Unders flip the sign: a passing under with a receiving over fight each other.</li></ul><p>First TD links and a moneyline with its own spread (+0.80) are estimates (no graded history measures them). Model chances are projections, not Onyx Picks.</p></details>';
  }
  function mount(el, d, uu) {
    D = d; u = uu; ROOT = el; css();
    ROLE = {}; D.plays.forEach(function (r) { if (r.role && r.name) ROLE[u.nk(r.name)] = r.role; });
    ROWS = D.plays.filter(function (r) { return r && r.label && r.price != null; }).map(function (r) { r._id = idOf(r); r._team = teamOf(r); return r; });
    BYID = {}; BYSEL = {}; ROWS.forEach(function (r) { BYID[r._id] = r; if (r.sel) BYSEL[r.sel] = r; });
    ROWS.forEach(function (r) {
      if (r.kind === 'spread') r._fav = r.hcap < 0;
      else if (r.kind === 'ml') { var o = ROWS.filter(function (x) { return x.kind === 'ml' && x.gid === r.gid && x !== r; })[0]; r._fav = o ? r.price < o.price : r.price < 0; }
    });
    var g = Studio.param('gid'); if (g && ROWS.some(function (r) { return r.gid === g; })) F.gid = g;
    el.innerHTML = '<div class="lab"><div class="lab-hero"><h2>Parlay Lab</h2><p>Build on your one Onyx slip. The lab reads every leg with the model: the true chance it all hits, same-game links included, what it should pay against what Onyx pays, and which legs to swap.</p></div>'
      + '<div class="lab-cols"><div class="lab-main"><div id="labSlip"></div><div id="labSwap"></div><div id="labLadder"></div></div>'
      + '<div class="lab-side">' + presetsHTML() + pickerShell() + '</div></div>' + howHTML() + '</div>';
    if (F.gid) { var gs = el.querySelector('[data-f="gid"]'); if (gs) gs.value = F.gid; var sg = el.querySelector('#labSgp'); if (sg) sg.value = F.gid; }
    el.addEventListener('click', onClick);
    el.addEventListener('change', function (e) { var k = e.target.getAttribute && e.target.getAttribute('data-f'); if (k) { F[k] = e.target.value; F.lim = 40; renderPicker(); } });
    el.addEventListener('input', function (e) { if (e.target.id === 'labQ') { F.q = e.target.value; F.lim = 40; renderPicker(); } });
    window.addEventListener('onyx-slip', schedule);
    window.addEventListener('storage', function (e) { if (e.key === 'onyxSlipAll') schedule(); });
    renderSlip(); renderPicker();
    return {show: function () { renderSlip(); renderPicker(); }};
  }

  // ── self-check: the analysis math on a slip built from board rows, and the slip on screen ─────────────────────
  function check() {
    if (!D) return 'lab never mounted';
    var good = ROWS.filter(function (r) { return r.conf > 0 && r.conf < 1 && !r.no_read; });
    var three = distinctGames(good.slice().sort(byEv), 3);
    if (three.length < 2) return '';
    var legs = three.map(fromRow), A = analyze(legs), prod = legs.reduce(function (m, l) { return m * u.dec(l.price); }, 1), full = (1 << legs.length) - 1;
    if (Math.abs(A.dec - prod) > 1e-9 * prod) return 'combined decimal odds ' + A.dec + ' != product of legs ' + prod;
    if (!(A.trueP > 0 && A.trueP < 1)) return 'true chance out of range: ' + A.trueP;
    if (Math.abs(A.trueP - A.naive) > 1e-12) return 'different-game legs should multiply: ' + A.trueP + ' vs ' + A.naive;
    var mc = joint(simulate(legs, {oneBlock: true, runs: RUNS}), full), se = Math.sqrt(A.naive * (1 - A.naive) / RUNS);
    if (Math.abs(mc - A.naive) > 4 * se + 0.005) return 'Monte Carlo of different-game legs ' + mc.toFixed(4) + ' far from the product ' + A.naive.toFixed(4);
    if (Math.abs(A.fairDec * A.trueP - 1) > 1e-9) return 'fair odds do not match the true chance';
    if (Math.abs(A.value - (A.trueP * A.dec - 1)) > 1e-12) return 'value math off';
    // same-game pairs from this sport's board: each joint chance inside the Frechet bounds [pa + pb - 1, min(pa, pb)],
    // and above the legs multiplied when the table says they move together, below when they fight
    var pairs = [], pick = function (f) { return good.filter(f)[0] || ROWS.filter(f)[0]; };
    var qb = pick(function (r) { return r.mkt === 'pass_yds' && r.side === 'over'; });
    var wr = qb && ROWS.filter(function (r) { return r.gid === qb.gid && r.team === qb.team && r.mkt === 'rec_yds' && r.side === 'over'; })[0];
    if (qb && wr) pairs.push(['QB + WR stack', fromRow(qb), fromRow(wr)], ['QB over + WR under', fromRow(qb), mkLeg(wr, {side: 'under'})]);
    var pts = pick(function (r) { return r.mkt === 'pts' && r.side === 'over'; }) || pick(function (r) { return r.mkt === 'pts'; });
    var pra = pts && ROWS.filter(function (r) { return r.gid === pts.gid && r.name === pts.name && r.mkt === 'pra'; })[0];
    if (pts && pra) pairs.push(['points + PRA, one player', mkLeg(pts, {side: 'over'}), mkLeg(pra, {side: 'over'})], ['points over + PRA under', mkLeg(pts, {side: 'over'}), mkLeg(pra, {side: 'under'})]);
    var sp = pick(function (r) { return r.kind === 'spread' && r.conf > 0.05 && r.conf < 0.95; });
    var ml = sp && ROWS.filter(function (r) { return r.kind === 'ml' && r.gid === sp.gid && r.name === sp.name; })[0];
    var ml2 = sp && ROWS.filter(function (r) { return r.kind === 'ml' && r.gid === sp.gid && r.name !== sp.name; })[0];
    var ov = sp && ROWS.filter(function (r) { return r.kind === 'total' && r.gid === sp.gid && r.side !== 'under'; })[0];
    if (sp && ml) pairs.push(['moneyline + own spread', fromRow(ml), fromRow(sp)]);
    if (ml && ml2) pairs.push(['both moneylines', fromRow(ml), fromRow(ml2)]);
    if (sp && ov) pairs.push(['spread + over', fromRow(sp), fromRow(ov)]);
    for (var pi = 0; pi < pairs.length; pi++) {
      var pr = pairs[pi], S = analyze([pr[1], pr[2]]), pa = S.legs[0].p, pb = S.legs[1].p, r0 = rho(S.legs[0], S.legs[1]), se2 = 0.012;
      if (!(S.trueP <= Math.min(pa, pb) + se2 && S.trueP >= Math.max(0, pa + pb - 1) - se2)) return pr[0] + ': joint ' + S.trueP.toFixed(4) + ' outside [' + Math.max(0, pa + pb - 1).toFixed(4) + ', ' + Math.min(pa, pb).toFixed(4) + ']';
      if (r0 > 0.05 && !(S.trueP > S.naive)) return pr[0] + ' (correlation ' + r0.toFixed(2) + ') should sit above the legs multiplied: ' + S.trueP.toFixed(4) + ' vs ' + S.naive.toFixed(4);
      if (r0 < -0.05 && !(S.trueP < S.naive)) return pr[0] + ' (correlation ' + r0.toFixed(2) + ') should fall under the legs multiplied: ' + S.trueP.toFixed(4) + ' vs ' + S.naive.toFixed(4);
    }
    // every preset builds distinct bets from this board, and a one-game preset stays in its game
    var gid0 = (ROWS.filter(function (r) { return live(r) && !r.no_read; })[0] || {}).gid;
    for (var ki = 0; ki < PRESET_KEYS.length; ki++) {
      var rows = PRESETS[PRESET_KEYS[ki]].build(gid0) || [], seen = {};
      for (var ri = 0; ri < rows.length; ri++) { var bk = betKey(rows[ri]); if (seen[bk]) return 'preset ' + PRESET_KEYS[ki] + ' repeats a bet'; seen[bk] = 1; }
      if ((PRESET_KEYS[ki] === 'sgp' || PRESET_KEYS[ki] === 'pair') && rows.some(function (r) { return r.gid !== gid0; })) return 'preset ' + PRESET_KEYS[ki] + ' left its game';
    }
    if (LAST) {
      var L = LAST.A, p2 = L.legs.reduce(function (m, l) { return m * u.dec(l.price); }, 1);
      if (Math.abs(L.dec - p2) > 1e-9 * p2) return 'slip on screen: combined odds != product of its legs';
      if (!(L.trueP > 0 && L.trueP < 1)) return 'slip on screen: chance out of range';
      if (L.n >= 2) {
        var shown = ROOT.querySelector('#labOdds'); if (!shown || shown.textContent !== u.odds(u.amer(p2))) return 'slip on screen shows ' + (shown && shown.textContent) + ', math says ' + u.odds(u.amer(p2));
        if (!L.sameGame && Math.abs(L.trueP - L.naive) > 1e-12) return 'slip on screen: different-game legs should multiply';
      }
    }
    return '';
  }

  Studio.register('lab', {title: 'Parlay Lab', mount: mount});
  Studio.checks.lab = check;
  window.StudioLab = {analyze: function (rows) { return analyze(rows.map(fromRow)); }, simulate: simulate, rho: rho, ladder: ladder};
})();
