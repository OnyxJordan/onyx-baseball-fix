// studio-sim.js - Play It Out (NFL Studio tab #sim, 11/15, Jordan: "play it out ... lets go wild").
// Pick a game, play it 10,000 times in the browser, and see what the model's projections look like as real finals:
// win %, cover % against Onyx's spread, over % against Onyx's total, the margin and total histograms with Onyx's
// lines on them, the most likely exact scores, and every player prop's simulated chance against Onyx's price.
// Knobs (starting QB out, wind, pace, sit a player) re-run it at once and show what changed. "Build my parlay from
// this sim" finds the 2-4 legs from the game that hit together most often against the product of their Onyx prices.
//
// How the sim mirrors the model (no new model here):
//   - team scores center on the model's team scores ("model SEA 27.8 LV 15.3" in the spread/total rows' why), or
//     Onyx's total and spread as implied team totals when the model has none. Points are counted the NFL way:
//     touchdowns (7, sometimes 6 or 8) and field goals (3) as binomial counts calibrated to the mean, rare safeties,
//     overtime for ties; one shared game factor moves both teams' pace together.
//   - a player prop is a normal draw around the model projection (proj) with the spread solved so the chance of the
//     side on the board equals the model's chance (conf) at Onyx's line; when no spread can do that (the chance is
//     blended with Onyx's price, or the model has no read) the spread is the market's usual one and the center
//     moves so the chance still matches. Counts and yards are whole numbers. Each prop's draw loads on its team's
//     simulated score, margin (game script), a team passing factor (QB with his receivers) and a rushing factor,
//     and on the player's own simulated touchdowns.
//   - touchdown markets: each team touchdown goes to a player with chance lam / (team's expected touchdowns), so a
//     player's touchdowns average his lam (the model's expected TDs) and rise and fall with his team's score.
//   - starting QB out is the model's v15 deep-backup rule (team points -3.4, receivers' yards x0.86, catches x0.94).
//     Wind and pace are what-if knobs, labeled as such.
// Common random numbers: every run of a game uses the same seeded draws (sim i always reseeds the same way), so a
// knob move shows the knob's effect, not fresh noise.
(function () {
  'use strict';
  if (!window.Studio) return;
  var N = 10000;
  var CSS = [
    '.sim{display:flex;flex-direction:column;gap:12px}',
    '.sim-pick{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:2px 0 4px;margin:0 -16px;padding-left:16px;padding-right:16px}',
    '.sim-pick::-webkit-scrollbar{display:none}',
    '@media (min-width:900px){.sim-pick{flex-wrap:wrap;overflow:visible;margin:0;padding:0}}',
    '.sim-g{flex:0 0 auto;min-width:136px;border:1px solid var(--line);background:var(--card);border-radius:14px;padding:9px 11px;cursor:pointer;color:#fff;text-align:left;font:inherit}',
    '.sim-g.on{border-color:var(--pur);background:rgba(176,56,249,.16);box-shadow:0 0 0 1px var(--pur) inset}',
    '.sim-g .t{display:flex;align-items:center;gap:6px;font:800 13px monospace}.sim-g .t img{width:20px;height:20px;object-fit:contain}',
    '.sim-g .k{font:600 10.5px monospace;color:var(--mute);margin-top:4px;letter-spacing:.03em}',
    '.sim-main{display:grid;grid-template-columns:1fr;gap:12px}',
    '@media (min-width:900px){.sim-main{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}}',
    '.sim-col{display:flex;flex-direction:column;gap:12px;min-width:0}',
    '.sim-hero{position:relative;overflow:hidden;background:radial-gradient(120% 90% at 50% 0,rgba(176,56,249,.22),rgba(255,255,255,.03) 60%)}',
    '.sim-mu{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;text-align:center}',
    '.sim-tm img{width:46px;height:46px;object-fit:contain;display:block;margin:0 auto 2px}',
    '.sim-tm .ab{font:800 14px monospace;letter-spacing:.04em}.sim-tm .sc{font:800 34px monospace;line-height:1.1}.sim-tm .w{font:700 12px monospace;color:var(--dim)}',
    '.sim-tm.fav .w{color:var(--grn)}',
    '.sim-vs{font:700 11px monospace;color:var(--mute);letter-spacing:.08em}',
    '.sim-wb{display:flex;height:10px;border-radius:999px;overflow:hidden;margin:12px 0 6px;background:rgba(255,255,255,.08)}',
    '.sim-wb i{display:block;height:100%;transition:width .45s ease}.sim-wb i.a{background:var(--pur)}.sim-wb i.h{background:#5b4a73}',
    '.sim-src{font:600 11px monospace;color:var(--mute);text-align:center;line-height:1.5}',
    '.sim-tick{display:flex;gap:6px;overflow:hidden;height:28px;margin:12px 0 4px;mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)}',
    '.sim-tick span{flex:0 0 auto;padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--line);font:700 11.5px monospace;white-space:nowrap;animation:simIn .25s ease}',
    '.sim-tick span.up{border-color:rgba(176,56,249,.6);color:var(--pur2)}',
    '@keyframes simIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.sim-ctr{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}',
    '.sim-ctr .n{font:800 12px monospace;color:var(--pur2);letter-spacing:.04em}',
    '.sim-fade{animation:simFade .45s ease}@keyframes simFade{from{opacity:.25}to{opacity:1}}',
    '.sim-ln{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '.sim-ln>div{padding:10px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);min-width:0}',
    '.sim-ln b{display:block;font:800 22px monospace;margin-top:2px}.sim-ln small{display:block;color:var(--dim);font-size:11.5px;margin-top:3px;line-height:1.4}',
    '.sim-sc{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}',
    '.sim-sc>div{padding:8px 6px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center;font:800 14px monospace}',
    '.sim-sc small{display:block;font:600 10.5px monospace;color:var(--mute);margin-top:2px}',
    '.sim-hist svg{display:block;width:100%;height:auto}',
    '.sim-hist .lg{display:flex;gap:12px;flex-wrap:wrap;font:600 11px monospace;color:var(--dim);margin-top:4px}.sim-hist .lg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}',
    '.sim-kn{display:flex;flex-direction:column;gap:12px}',
    '.sim-kn label{display:block}.sim-kn .sx-k{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}.sim-kn .sx-k b{color:var(--pur2)}',
    '.sim-kn input[type=range]{width:100%;accent-color:#b038f9;height:28px;margin:0}',
    '.sim-kn .note{font-size:11.5px;color:var(--mute);line-height:1.45;margin-top:4px}',
    '.sim-sat{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
    '.sim-diff{border-color:rgba(176,56,249,.5);background:rgba(176,56,249,.08)}',
    '.sim-diff ul{margin:4px 0 0;padding:0;list-style:none;font:600 12.5px monospace;line-height:1.75}',
    '.sim-diff .up{color:var(--grn)}.sim-diff .dn{color:var(--red)}',
    '.sim-pl .leg{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid rgba(255,255,255,.07);font-size:13px}',
    '.sim-pl .leg:first-of-type{border-top:0}.sim-pl .leg small{display:block;color:var(--mute);font:600 10.5px monospace;margin-top:2px}',
    '.sim-pl .sim-pst{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}',
    '.sim-pl .sim-pst div{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);font:600 11px monospace;color:var(--dim)}.sim-pl .sim-pst b{display:block;font:800 17px monospace;color:#fff;margin-top:2px}',
    '.sim-pl .sim-pbt{display:flex;gap:8px;flex-wrap:wrap}.sim-pl .sim-pbt>*{flex:1 1 140px;text-align:center;text-decoration:none}',
    '.sim-pl .cap{font-size:11.5px;color:var(--mute);line-height:1.5;margin-top:8px}',
    '.sim-seg{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}.sim-seg .sx-chip.on{background:var(--pur);border-color:var(--pur);color:#fff}',
    '.sim-pr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 0;border-top:1px solid rgba(255,255,255,.07);align-items:center}',
    '.sim-pr:first-child{border-top:0}',
    '.sim-pr .lb{font-size:13px;font-weight:600;min-width:0}.sim-pr .lb small{display:block;color:var(--mute);font:600 10.5px monospace;margin-top:2px}',
    '.sim-pr .rt{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}',
    '.sim-pr .bars{grid-column:1/-1;display:grid;grid-template-columns:52px 1fr 44px;gap:3px 8px;align-items:center;font:600 10.5px monospace;color:var(--mute)}',
    '.sim-pr .bars .sx-bar{height:6px}.sim-pr .bars .sx-bar.o>i{background:#6c6478}.sim-pr .bars em{font-style:normal;text-align:right;color:#fff}',
    '.sim-pr .v{font:800 12px monospace;min-width:48px;text-align:right}',
    '.sim-add{border:1px solid var(--line);background:rgba(255,255,255,.05);color:#fff;border-radius:999px;width:30px;height:30px;font:800 15px monospace;cursor:pointer;padding:0;line-height:1}',
    '.sim-add.on{background:var(--grn);border-color:var(--grn);color:#0c0c0c}',
    '.sim-how summary{cursor:pointer;font:700 12px monospace;letter-spacing:.05em;text-transform:uppercase;color:var(--pur2)}',
    '.sim-how p{font-size:12.5px;color:var(--dim);line-height:1.6;margin:8px 0 0}',
    '.sim-more{margin-top:8px;width:100%}',
    '.sim .sx-chip{white-space:nowrap}'
  ].join('\n');

  // ── math ─────────────────────────────────────────────────────────────────────────────────────
  var S = 1;
  function R() { S = (S + 0x6D2B79F5) | 0; var t = Math.imul(S ^ (S >>> 15), 1 | S); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  function Z() { var a = R(), b = R(); return Math.sqrt(-2 * Math.log(a + 1e-12)) * Math.cos(6.283185307179586 * b); }
  function qnorm(p) {   // Acklam's inverse normal
    p = Math.min(1 - 1e-9, Math.max(1e-9, p));
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
        b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
        c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
        d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q, r;
    if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  var TD_MK = {anytime_td: 1, first_td: 1, two_td: 1, three_td: 1};
  var PASS_MK = {pass_yds: 1, pass_att: 1, pass_td: 1, pass_rush_yds: 1};
  // the market's usual spread around a projection (sd), and how each market's draw loads on the shared factors:
  // s = team score, m = margin (game script; + when leading), p = team passing, r = team rushing, t = his own TDs
  var MK = {
    pass_yds: {sd: function (b) { return Math.max(40, 0.24 * b); }, l: {s: 0.35, m: -0.2, p: 0.5}},
    pass_rush_yds: {sd: function (b) { return Math.max(42, 0.24 * b); }, l: {s: 0.35, m: -0.2, p: 0.5}},
    pass_att: {sd: function (b) { return Math.max(4.5, 0.17 * b); }, l: {s: 0.05, m: -0.45, p: 0.55}},
    pass_td: {sd: function (b) { return Math.max(0.75, 0.85 * Math.sqrt(b)); }, l: {s: 0.55, m: -0.05, p: 0.3}},
    rec: {sd: function (b) { return Math.max(1, 1.05 * Math.sqrt(b)); }, l: {s: 0.2, m: -0.15, p: 0.45, t: 0.15}},
    rec_yds: {sd: function (b) { return Math.max(12, 0.62 * b); }, l: {s: 0.3, m: -0.1, p: 0.45, t: 0.3}},
    rush_yds: {sd: function (b) { return Math.max(14, 0.48 * b); }, l: {s: 0.3, m: 0.35, r: 0.45, t: 0.3}},
    rush_rec_yds: {sd: function (b) { return Math.max(16, 0.45 * b); }, l: {s: 0.3, m: 0.2, r: 0.3, p: 0.1, t: 0.3}}
  };
  var UNIT = {pass_yds: 'pass yds', pass_rush_yds: 'pass + rush yds', pass_att: 'attempts', pass_td: 'pass TDs', rec: 'catches', rec_yds: 'rec yds', rush_yds: 'rush yds', rush_rec_yds: 'rush + rec yds'};
  var QB = {pts: -3.4, rec_yds: 0.86, rec: 0.94, rush_rec_yds: 0.93};   // nfl_model v15 QB_DEEP (rush+rec: its receiving part)
  // wind, what-if: the model found passing unders won at 15+ mph and rushing did not move; sizes are estimates
  var WIND = [{mph: 0, pass: 1, vol: 1, pts: 0}, {mph: 10, pass: 0.98, vol: 0.99, pts: 0.5}, {mph: 15, pass: 0.93, vol: 0.96, pts: 2},
              {mph: 20, pass: 0.89, vol: 0.94, pts: 3.5}, {mph: 25, pass: 0.84, vol: 0.91, pts: 5}];
  var PACE = [0.9, 0.95, 1, 1.05, 1.1], PACE_TXT = ['Slow', 'Slower', 'As projected', 'Faster', 'Fast'];

  // ── one game, prepared once ──────────────────────────────────────────────────────────────────
  function prep(D, gid, u) {
    var g = D.game(gid), rows = D.playsFor(gid);
    if (!g || !rows.length) return null;
    var A = g.away, H = g.home, mu = null, src = 'model';
    rows.forEach(function (r) {
      var m = !mu && /^model (\S+) ([\d.]+) (\S+) ([\d.]+)/.exec(r.why || '');
      if (m) { var o = {}; o[m[1]] = +m[2]; o[m[3]] = +m[4]; if (o[A] != null && o[H] != null) mu = {a: o[A], h: o[H]}; }
    });
    var sp = rows.filter(function (r) { return r.kind === 'spread'; }), tot = rows.filter(function (r) { return r.kind === 'total'; }),
        ml = rows.filter(function (r) { return r.kind === 'ml'; });
    var totLine = tot.length ? tot[0].line : null;
    var fav = sp.filter(function (r) { return r.hcap < 0; })[0] || null;
    if (!mu && totLine != null) {
      var h = fav ? (fav.name === A ? fav.hcap : -fav.hcap) : 0;    // A's handicap
      mu = {a: (totLine - h) / 2, h: (totLine + h) / 2};             // A - H = -hA, A + H = T
      src = 'onyx';
    }
    if (!mu) { mu = {a: 21.5, h: 22.5}; src = 'none'; }
    // players and their props
    var P = {}, plist = [];
    rows.forEach(function (r) {
      if (r.kind !== 'prop' || !r.name) return;
      var k = u.nk(r.name);
      if (!P[k]) { P[k] = {k: k, name: r.name, team: r.team, role: null, rows: [], lam: null, idx: plist.length}; plist.push(P[k]); }
      var p = P[k]; p.rows.push(r);
      if (r.role) p.role = r.role;
      if (r.mkt === 'anytime_td' && r.lam != null) p.lam = r.lam;
    });
    plist.forEach(function (p) {
      if (p.lam == null) {
        var a = p.rows.filter(function (r) { return r.mkt === 'anytime_td'; })[0];
        if (a) p.lam = -Math.log(Math.max(1e-6, 1 - a.conf));
      }
      if (p.rows.some(function (r) { return PASS_MK[r.mkt]; })) p.role = 'QB';
      else if (!p.role) p.role = p.rows.some(function (r) { return r.mkt === 'rush_yds'; }) ? 'RB' : 'WR/TE';
    });
    // continuous props: center and spread solved so the board side's chance = conf at Onyx's line
    var cont = [], tdr = [];
    rows.forEach(function (r) {
      if (r.kind !== 'prop') return;
      var p = P[u.nk(r.name)];
      if (TD_MK[r.mkt]) { if (p && p.lam != null) tdr.push({row: r, pl: p}); return; }
      var M = MK[r.mkt]; if (!M || r.line == null || r.conf == null) return;
      var base = r.proj != null ? r.proj : r.line, sd = M.sd(Math.max(0.5, base)), z = qnorm(r.conf), sgn = r.side === 'under' ? -1 : 1;
      var c = base, s = null, moved = false;
      if (r.proj != null && Math.abs(z) > 0.02) { var s0 = sgn * (r.proj - r.line) / z; if (s0 >= 0.5 * sd && s0 <= 2 * sd) s = s0; }
      if (s == null) { s = sd; c = r.line + sgn * sd * z; moved = r.proj != null && Math.abs(c - r.proj) > 0.15 * sd; }
      var l = M.l, sum = 0; Object.keys(l).forEach(function (k) { sum += l[k] * l[k]; });
      cont.push({row: r, pl: p, c: c, s: s, moved: moved, l: l, w: Math.sqrt(Math.max(0.25, 1 - sum))});
    });
    var lines = sp.concat(tot, ml);
    var logos = {}; logos[A] = g.away_logo; logos[H] = g.home_logo;
    return {gid: gid, g: g, A: A, H: H, mu: mu, src: src, rows: rows, plist: plist, P: P, cont: cont, tdr: tdr, lines: lines,
            sp: sp, tot: tot, ml: ml, fav: fav, totLine: totLine, logos: logos};
  }

  // ── the simulation ───────────────────────────────────────────────────────────────────────────
  function lamTD(m) { return Math.max(0.2, (m - 0.06) * 0.76 / 6.96); }
  function lamFG(m) { return Math.max(0.15, (m - 0.06) * 0.24 / 3); }

  // knobs -> the parameters this run uses
  function params(G, K) {
    var w = WIND[K.wind] || WIND[0], pace = PACE[K.pace] || 1;
    var mu = {a: G.mu.a, h: G.mu.h};
    [['a', G.A], ['h', G.H]].forEach(function (x) { if (K.qb[x[1]]) mu[x[0]] += QB.pts; mu[x[0]] = Math.max(3, (mu[x[0]] - w.pts / 2) * pace); });
    var off = {};      // player key -> out
    Object.keys(K.sit).forEach(function (k) { if (K.sit[k]) off[k] = 1; });
    G.plist.forEach(function (p) { if (p.role === 'QB' && K.qb[p.team]) off[p.k] = 1; });
    // sit a player: 70% of his volume to listed teammates in his role, in proportion to theirs (capped x1.5)
    var bump = {};     // player key + mkt -> multiplier
    Object.keys(off).forEach(function (k) {
      var me = G.P[k]; if (!me || me.role === 'QB') return;
      var mk = {};
      G.cont.forEach(function (c) { if (c.pl === me) mk[c.row.mkt] = c.c; });
      if (me.lam != null) mk.td = me.lam;
      Object.keys(mk).forEach(function (m) {
        var mates = G.plist.filter(function (p) { return p !== me && !off[p.k] && p.team === me.team && p.role === me.role; }), sum = 0, has = [];
        mates.forEach(function (p) {
          var v = m === 'td' ? p.lam : (G.cont.filter(function (c) { return c.pl === p && c.row.mkt === m; })[0] || {}).c;
          if (v > 0) { sum += v; has.push(p); }
        });
        if (!sum) return;
        var f = Math.min(1.5, 1 + 0.7 * mk[m] / sum);
        has.forEach(function (p) { bump[p.k + '|' + m] = (bump[p.k + '|' + m] || 1) * f; });
      });
    });
    var share = {a: [], h: []}, base = {a: lamTD(G.mu.a), h: lamTD(G.mu.h)};
    G.plist.forEach(function (p) {
      if (p.lam == null || off[p.k]) return;
      var side = p.team === G.A ? 'a' : p.team === G.H ? 'h' : null; if (!side) return;
      share[side].push({p: p, s: p.lam * (bump[p.k + '|td'] || 1) / base[side]});
    });
    ['a', 'h'].forEach(function (x) { var t = 0; share[x].forEach(function (o) { t += o.s; }); if (t > 0.95) share[x].forEach(function (o) { o.s *= 0.95 / t; }); });
    var mult = G.cont.map(function (c) {
      var m = c.row.mkt, f = pace;
      if (m === 'pass_yds' || m === 'pass_rush_yds' || m === 'rec_yds' || m === 'pass_td') f *= w.pass;
      else if (m === 'pass_att' || m === 'rec') f *= w.vol;
      else if (m === 'rush_rec_yds' && c.pl && c.pl.role !== 'RB') f *= w.pass;
      if (c.pl && K.qb[c.pl.team] && c.pl.role !== 'QB' && QB[m]) f *= (m === 'rush_rec_yds' && c.pl.role === 'RB') ? 1 : QB[m];
      if (c.pl) f *= bump[c.pl.k + '|' + m] || 1;
      return f;
    });
    return {mu: mu, off: off, share: share, mult: mult, w: w, pace: pace};
  }

  // run(G, K, seed) -> a stepper: step(n) plays n more games, done() finishes and summarizes
  function run(G, K, seed) {
    var X = params(G, K), np = G.plist.length, nc = G.cont.length;
    var sa = new Int16Array(N), sh = new Int16Array(N), fp = new Int16Array(N);
    var zp = [new Float32Array(N), new Float32Array(N)], zr = [new Float32Array(N), new Float32Array(N)];
    var td = []; for (var q = 0; q < np; q++) td.push(new Uint8Array(N));
    var eps = []; for (q = 0; q < nc; q++) eps.push(new Float32Array(N));
    var sides = [['a', X.mu.a, X.share.a], ['h', X.mu.h, X.share.h]], i = 0, list = new Int16Array(24);
    function step(n) {
      var end = Math.min(N, i + n);
      for (; i < end; i++) {
        S = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; R();
        var gf = Math.exp(0.09 * Z() - 0.004), pts = [0, 0], tds = [0, 0], nl = 0;
        for (var t = 0; t < 2; t++) {
          zp[t][i] = Z(); zr[t][i] = Z();
          var m = sides[t][1], sh_ = sides[t][2], pT = Math.min(0.9, lamTD(m) * gf / 8), pF = Math.min(0.9, lamFG(m) * gf / 5), k, u_, p = 0;
          var nT = 0; for (k = 0; k < 8; k++) if (R() < pT) nT++;   // touchdowns: binomial over 8 tries, field goals over 5
          for (k = 0; k < 8; k++) { u_ = R(); if (k < nT) p += u_ < 0.08 ? 6 : u_ < 0.12 ? 8 : 7; }
          for (k = 0; k < 8; k++) {
            u_ = R(); if (k >= nT) continue;
            var who = -1, acc = 0;
            for (var j = 0; j < sh_.length; j++) { acc += sh_[j].s; if (u_ < acc) { who = sh_[j].p.idx; break; } }
            if (who >= 0 && td[who][i] < 250) td[who][i]++;
            if (nl < 24) list[nl++] = who;
          }
          for (k = 0; k < 5; k++) if (R() < pF) p += 3;
          if (R() < 0.03) p += 2;
          pts[t] = p; tds[t] = nT;
        }
        var o1 = R(), o2 = R(), f1 = R();
        if (pts[0] === pts[1]) { var aw = o1 < X.mu.a / (X.mu.a + X.mu.h) ? 0 : 1; pts[aw] += o2 < 0.55 ? 3 : 6; }
        sa[i] = pts[0]; sh[i] = pts[1];
        fp[i] = nl ? list[Math.floor(f1 * nl)] : -1;
        for (q = 0; q < nc; q++) eps[q][i] = Z();
      }
      return i;
    }
    function done() {
      // factors, standardized on this run
      function stat(f) { var m = 0, v = 0, k; for (k = 0; k < N; k++) m += f(k); m /= N; for (k = 0; k < N; k++) { var d = f(k) - m; v += d * d; } return [m, Math.sqrt(v / N) || 1]; }
      var stA = stat(function (k) { return sa[k]; }), stH = stat(function (k) { return sh[k]; }), stM = stat(function (k) { return sa[k] - sh[k]; });
      var hits = {}, avg = {}, raw = new Float32Array(N);
      G.cont.forEach(function (c, ci) {
        var r = c.row; if (c.pl && X.off[c.pl.k]) return;
        var t = c.pl && c.pl.team === G.H ? 1 : 0, L = c.l, tv = c.pl && c.pl.lam != null ? td[c.pl.idx] : null, lam = c.pl && c.pl.lam || 0, sl = Math.sqrt(Math.max(0.05, lam));
        var st = t ? stH : stA, sg = t ? -1 : 1, k, m = 0, v = 0;
        for (k = 0; k < N; k++) {
          var x = c.w * eps[ci][k];
          if (L.s) x += L.s * ((t ? sh[k] : sa[k]) - st[0]) / st[1];
          if (L.m) x += L.m * sg * ((sa[k] - sh[k]) - stM[0]) / stM[1];
          if (L.p) x += L.p * zp[t][k];
          if (L.r) x += L.r * zr[t][k];
          if (L.t && tv) x += L.t * (tv[k] - lam) / sl;
          raw[k] = x; m += x;
        }
        m /= N; for (k = 0; k < N; k++) v += (raw[k] - m) * (raw[k] - m); v = Math.sqrt(v / N) || 1;
        var f = X.mult[ci], cc = c.c * f, ss = c.s * f, h = new Uint8Array(N), tot = 0, over = r.side !== 'under';
        for (k = 0; k < N; k++) {
          var y = Math.max(0, Math.round(cc + ss * (raw[k] - m) / v)); tot += y;
          h[k] = over ? (y > r.line ? 1 : 0) : (y < r.line ? 1 : 0);
        }
        hits[r.sel || r.label] = h; avg[r.sel || r.label] = tot / N;
      });
      G.tdr.forEach(function (o) {
        var r = o.row, p = o.pl; if (X.off[p.k]) return;
        var v = td[p.idx], h = new Uint8Array(N), need = r.mkt === 'two_td' ? 2 : r.mkt === 'three_td' ? 3 : 1, k, tot = 0;
        for (k = 0; k < N; k++) { h[k] = r.mkt === 'first_td' ? (fp[k] === p.idx ? 1 : 0) : (v[k] >= need ? 1 : 0); tot += v[k]; }
        hits[r.sel || r.label] = h; avg[r.sel || r.label] = tot / N;
      });
      var push = {};
      G.lines.forEach(function (r) {
        var h = new Uint8Array(N), pu = 0, k;
        for (k = 0; k < N; k++) {
          var mine = r.name === G.H ? sh[k] : sa[k], opp = r.name === G.H ? sa[k] : sh[k], d;
          if (r.kind === 'ml') d = mine - opp;
          else if (r.kind === 'spread') d = mine + r.hcap - opp;
          else d = r.side === 'under' ? r.line - (sa[k] + sh[k]) : (sa[k] + sh[k]) - r.line;
          h[k] = d > 0 ? 1 : 0; if (d === 0) pu++;
        }
        hits[r.sel || r.label] = h; push[r.sel || r.label] = pu / N;
      });
      return summarize(G, X, sa, sh, hits, avg, push);
    }
    return {step: step, done: done, sa: sa, sh: sh};
  }

  function summarize(G, X, sa, sh, hits, avg, push) {
    var wa = 0, ta = 0, th = 0, sc = new Int32Array(130 * 130), mh = {}, tt = {}, k;
    for (k = 0; k < N; k++) {
      var a = sa[k], h = sh[k]; if (a > h) wa++; ta += a; th += h;
      if (a < 130 && h < 130) sc[a * 130 + h]++;
      mh[a - h] = (mh[a - h] || 0) + 1; tt[a + h] = (tt[a + h] || 0) + 1;
    }
    var top = [];
    for (k = 0; k < sc.length; k++) if (sc[k]) top.push([k, sc[k]]);
    top.sort(function (x, y) { return y[1] - x[1]; });
    top = top.slice(0, 6).map(function (x) { return {a: Math.floor(x[0] / 130), h: x[0] % 130, p: x[1] / N}; });
    var props = [];
    G.rows.forEach(function (r) {
      var id = r.sel || r.label, h = hits[id]; if (!h) return;
      var n = 0; for (var j = 0; j < N; j++) n += h[j];
      var p = n / N, imp = r.price != null ? Studio.u.imp(r.price) : null;
      props.push({id: id, row: r, p: p, imp: imp, ev: r.price != null ? p * Studio.u.dec(r.price) - 1 : null, avg: avg[id], push: push[id] || 0, h: h});
    });
    return {winA: wa / N, winH: 1 - wa / N, avgA: ta / N, avgH: th / N, top: top, mh: mh, tt: tt, props: props, mu: X.mu,
            byId: props.reduce(function (o, x) { o[x.id] = x; return o; }, {}), sample: [sa[0], sh[0], sa[N - 1], sh[N - 1]]};
  }

  // ── the best parlay from the sim: 2-4 legs that hit together most against the product of Onyx prices ──
  // a leg qualifies only where the sim, knobs untouched, mirrors the model's own chance (within 4 points): game lines
  // centered on the model's scores can read stronger than the blended chance the model lists, and that gap is not value
  function parlays(G, Rs, u, base) {
    var cand = Rs.props.filter(function (x) {
      var r = x.row, b = base && base[x.id];
      return r.sel && r.price != null && x.p >= 0.3 && r.mkt !== 'first_td' && r.mkt !== 'three_td' && (b == null || r.conf == null || Math.abs(b - r.conf) <= 0.04);
    });
    var byEv = cand.slice().sort(function (a, b) { return b.ev - a.ev; }).slice(0, 22), byP = cand.slice().sort(function (a, b) { return b.p - a.p; }).slice(0, 10);
    var pool = []; byEv.concat(byP).forEach(function (x) { if (pool.indexOf(x) < 0) pool.push(x); });
    function slot(x) { var r = x.row; return r.kind === 'prop' ? 'p:' + u.nk(r.name) : r.kind === 'total' ? 'tot' : 'side'; }
    function ok(legs, x) { var s = slot(x); return !legs.some(function (l) { return slot(l) === s; }); }
    function score(legs) {
      var n = 0, k, L = legs.length, d = 1, nv = 1;
      for (k = 0; k < N; k++) { var all = 1; for (var j = 0; j < L; j++) if (!legs[j].h[k]) { all = 0; break; } n += all; }
      legs.forEach(function (l) { d *= u.dec(l.row.price); nv *= l.p; });
      var joint = n / N; return {legs: legs, joint: joint, naive: nv, dec: d, ev: joint * d - 1, imp: 1 / d};
    }
    var best = {}, beam = pool.map(function (x) { return [x]; });
    [2, 3, 4].forEach(function (size) {
      var next = [], seen = {};
      beam.forEach(function (legs) {
        pool.forEach(function (x) {
          if (legs.indexOf(x) >= 0 || !ok(legs, x)) return;
          var c = legs.concat([x]), key = c.map(function (l) { return l.id; }).sort().join('|');
          if (seen[key]) return; seen[key] = 1;
          var s = score(c); if (s.joint >= (size === 4 ? 0.1 : 0.14)) next.push(s);
        });
      });
      next.sort(function (a, b) { return b.ev - a.ev; });
      if (next.length) best[size] = next[0];
      beam = next.slice(0, 18).map(function (s) { return s.legs; });
    });
    return best;
  }

  // ── the tab ──────────────────────────────────────────────────────────────────────────────────
  var LAST = null;
  Studio.simLast = function () { return LAST; };   // read-only, for tools/ probes
  Studio.checks.sim = function () {
    if (!LAST) return 'no simulation has run';
    var s = LAST.winA + LAST.winH;
    if (Math.abs(s - 1) > 0.005) return 'win percentages sum to ' + (100 * s).toFixed(1);
    if (!LAST.sample.every(function (x) { return Number.isInteger(x); }) || !LAST.top.every(function (t) { return Number.isInteger(t.a) && Number.isInteger(t.h); })) return 'scores are not whole numbers';
    return '';
  };

  function mount(el, D, u) {
    if (!document.getElementById('sx-sim-css')) { var st = document.createElement('style'); st.id = 'sx-sim-css'; st.textContent = CSS; document.head.appendChild(st); }
    var games = D.games.filter(function (g) { return D.playsFor(g.gid).length && g.state !== 'post'; }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
    if (!games.length) { el.innerHTML = '<div class="sx-card"><h3 class="sx-h">Play It Out</h3><p class="sx-sub">No NFL games with Onyx lines on the board right now. The next slate shows up here once Onyx posts its prices.</p></div>'; return {}; }
    var WX = {};
    fetch('data/nfl/weather.json?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { WX = j || {}; if (G) drawKnobs(); }).catch(function () {});
    var G = null, K = null, BASEP = null, RES = null, PREV = null, SEED = 20261115, CHG = null, legsN = null, FILTER = 'all', ALL = false, busy = false, timer = null;
    function pickDefault() {
      var want = Studio.param('gid'); if (want && games.some(function (g) { return g.gid === want; })) return want;
      var now = Date.now(), next = games.filter(function (g) { return Date.parse(g.start) > now; })[0];
      return (next || games[0]).gid;
    }
    el.innerHTML = '<div class="sim">'
      + '<div class="sim-pick" id="simPick" role="tablist" aria-label="Games"></div>'
      + '<div class="sim-main"><div class="sim-col"><div class="sx-card sim-hero" id="simHero"></div><div id="simRes" class="sim-col"></div></div>'
      + '<div class="sim-col"><div class="sx-card sim-diff" id="simDiff" hidden></div><div class="sx-card" id="simKnobs"></div><div class="sx-card sim-pl" id="simPl"></div></div></div>'
      + '<div class="sx-card" id="simProps"></div>'
      + '<details class="sx-card sim-how"><summary>How it works</summary>'
      + '<p>This is a projection, not a prediction and not an Onyx Pick. Each game is played 10,000 times in your browser. Team scores center on the model\'s projected team scores (or Onyx\'s total and spread when the model has none) and are counted the real way: touchdowns worth 7 (sometimes 6 or 8), field goals worth 3, a rare safety, overtime when tied. One shared factor speeds up or slows down both offenses together.</p>'
      + '<p>Every player prop is drawn around the model\'s projection with its spread set so the chance of the side shown matches the model\'s own chance at Onyx\'s line, so the sim mirrors the model rather than adding a new opinion. Where the model has no read on a market, its chance is Onyx\'s own and the sim follows it. Players move with their team: a quarterback\'s yards with his receivers\', a running back\'s with the game script, everyone\'s with the score. Touchdowns are handed out from the team\'s simulated touchdowns in proportion to each player\'s expected touchdowns.</p>'
      + '<p>Game lines come from the model\'s team scores, which can read stronger than the chance the model lists for them (that one is blended with Onyx\'s price). Starting QB out is the model\'s own deep-backup rule (team -3.4 points, receivers\' yards x0.86 and catches x0.94). Wind and pace are what-ifs: the model found passing unders won at 15+ mph and rushing did not move, but the exact sizes here are estimates. Same seed every run, so a knob move shows the knob, not luck.</p></details>'
      + '</div>';
    var $ = function (id) { return el.querySelector('#' + id); };

    function drawPick() {
      $('simPick').innerHTML = games.map(function (g) {
        var lg = function (src) { return src ? '<img src="' + u.esc(src) + '" alt="" loading="lazy" onerror="this.remove()">' : ''; };
        return '<button class="sim-g' + (G && G.gid === g.gid ? ' on' : '') + '" data-gid="' + u.esc(g.gid) + '" role="tab"><div class="t">' + lg(g.away_logo) + u.esc(g.away) + ' <span style="color:var(--mute)">@</span> ' + lg(g.home_logo) + u.esc(g.home) + '</div><div class="k">' + u.esc(u.fmtTime(g.start)) + '</div></button>';
      }).join('');
    }
    function sideTxt(r) { return r.kind === 'total' ? (r.side === 'under' ? 'Under ' : 'Over ') + r.line : r.kind === 'ml' ? r.name + ' to win' : r.name + ' ' + (r.hcap > 0 ? '+' : '') + r.hcap; }
    function href(sels) { sels = sels.filter(Boolean); return sels.length ? 'https://app.onyxodds.com/share?' + sels.map(function (s) { return 'selection=' + encodeURIComponent(s); }).join('&') + '&referrer=KR680261' : null; }
    function chip(r) { return r.sel ? '<a class="sx-chip onyx" target="_blank" rel="noopener" data-sim-onyx="' + u.esc(r.sel) + '" href="' + u.esc(href([r.sel])) + '">Onyx ' + u.esc(u.odds(r.price)) + '</a>' : '<span class="sx-chip">' + u.esc(u.odds(r.price)) + '</span>'; }
    function inSlip(sel) { try { return !!(window.OnyxParlay && OnyxParlay.slip().some(function (x) { return x.sel === sel; })); } catch (e) { return false; } }

    function drawHero(progress) {
      var g = G.g, R_ = RES, A = G.A, H = G.H;
      var team = function (ab, logo, sc, w, fav) {
        return '<div class="sim-tm' + (fav ? ' fav' : '') + '">' + (logo ? '<img src="' + u.esc(logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') + '<div class="ab">' + u.esc(ab) + '</div>'
          + '<div class="sc">' + (sc == null ? '-' : sc.toFixed(1)) + '</div><div class="w">' + (w == null ? 'avg pts' : u.pct(w) + ' win') + '</div></div>';
      };
      var srcTxt = G.src === 'model' ? 'Centered on the model: ' + A + ' ' + G.mu.a.toFixed(1) + ', ' + H + ' ' + G.mu.h.toFixed(1)
        : G.src === 'onyx' ? 'No model score for this game, so the sim centers on Onyx\'s total and spread' : 'No team lines for this game yet: a league-average game';
      var on = G.fav ? 'Onyx: ' + sideTxt(G.fav) + (G.totLine != null ? ' · total ' + G.totLine : '') : (G.totLine != null ? 'Onyx total ' + G.totLine : '');
      $('simHero').innerHTML = '<div class="sim-ctr"><span class="sx-k">' + u.esc(g.away_name || A) + ' at ' + u.esc(g.home_name || H) + ' · ' + u.esc(u.fmtTime(g.start)) + '</span>'
        + '<span class="n" id="simN">' + (progress != null ? progress.toLocaleString() + ' / 10,000' : RES ? '10,000 games played' : '') + '</span></div>'
        + '<div class="sim-mu" style="margin-top:10px">' + team(A, G.logos[A], R_ ? R_.avgA : null, R_ ? R_.winA : null, R_ && R_.winA > 0.5) + '<div class="sim-vs">AVG<br>FINAL</div>'
        + team(H, G.logos[H], R_ ? R_.avgH : null, R_ ? R_.winH : null, R_ && R_.winH > 0.5) + '</div>'
        + '<div class="sim-wb" aria-label="Win split"><i class="a" style="width:' + (R_ ? 100 * R_.winA : 50) + '%"></i><i class="h" style="width:' + (R_ ? 100 * R_.winH : 50) + '%"></i></div>'
        + '<div class="sim-tick" id="simTick"></div>'
        + '<div class="sim-src">' + u.esc(srcTxt) + (on ? '<br>' + u.esc(on) : '') + '</div>'
        + '<div class="sim-ctr" style="margin-top:12px"><button class="sx-btn" id="simGo"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Playing it out' : RES ? 'Play it out again' : 'Play it out 10,000 times') + '</button>'
        + '<button class="sx-btn ghost" id="simReset">Reset knobs</button></div>';
    }
    function tick(sa, sh, from, to) {
      var t = $('simTick'); if (!t) return;
      var out = [], n = 7;
      for (var k = Math.max(from, to - n); k < to; k++) { var aw = sa[k] > sh[k]; out.push('<span class="' + (aw ? 'up' : '') + '">' + u.esc(G.A) + ' ' + sa[k] + ' - ' + sh[k] + ' ' + u.esc(G.H) + '</span>'); }
      t.innerHTML = out.join('');
    }

    function hist(map, lo, hi, line, label, overGood) {
      var W = Math.max(300, Math.min(760, ($('simRes').clientWidth || 340) - 30)), Hh = W > 500 ? 170 : 120, pad = 16, n = hi - lo + 1, bw = W / n, mx = 0, k;
      for (k = lo; k <= hi; k++) mx = Math.max(mx, map[k] || 0);
      var bars = '';
      for (k = lo; k <= hi; k++) {
        var v = map[k] || 0;
        var hgt = mx ? (Hh - pad - 4) * v / mx : 0, good = overGood ? k > line : k < line;
        bars += '<rect x="' + ((k - lo) * bw + 0.3).toFixed(2) + '" y="' + (Hh - pad - hgt).toFixed(1) + '" width="' + Math.max(0.6, bw - 0.6).toFixed(2) + '" height="' + hgt.toFixed(1) + '" fill="' + (line == null ? '#b038f9' : good ? '#b038f9' : 'rgba(255,255,255,.22)') + '"/>';
      }
      var ticks = '', step = (hi - lo) > 60 ? 10 : 7;
      for (k = Math.ceil(lo / step) * step; k <= hi; k += step) ticks += '<text x="' + ((k - lo + 0.5) * bw).toFixed(1) + '" y="' + (Hh - 3) + '" fill="#9a93a6" font-size="9" font-family="monospace" text-anchor="middle">' + k + '</text>';
      var ln = '';
      if (line != null) { var x = ((line - lo + 0.5) * bw).toFixed(1); ln = '<line x1="' + x + '" x2="' + x + '" y1="2" y2="' + (Hh - pad) + '" stroke="#d795ff" stroke-width="1.5" stroke-dasharray="3 2"/><text x="' + (+x + 4) + '" y="11" fill="#d795ff" font-size="10" font-family="monospace" font-weight="700"' + (+x > W * 0.7 ? ' text-anchor="end" dx="-8"' : '') + '>' + u.esc(label) + '</text>'; }
      return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + u.esc(label || 'histogram') + '">' + bars + ln + ticks + '</svg>';
    }

    function drawResults() {
      var R_ = RES, A = G.A, H = G.H, fav = G.fav, favA = fav ? fav.name === A : R_.avgA >= R_.avgH, F = favA ? A : H, Dg = favA ? H : A;
      var spX = fav ? R_.byId[fav.sel || fav.label] : null, ov = G.tot.filter(function (r) { return r.side !== 'under'; })[0], un = G.tot.filter(function (r) { return r.side === 'under'; })[0];
      var ovX = ov ? R_.byId[ov.sel || ov.label] : null, unX = un ? R_.byId[un.sel || un.label] : null;
      var tiles = '<div class="sim-ln">'
        + '<div><span class="sx-k">' + u.esc(fav ? sideTxt(fav) + ' covers' : F + ' wins') + '</span><b class="sx-pur">' + u.pct(spX ? spX.p : (favA ? R_.winA : R_.winH)) + '</b><small>' + (spX ? 'Onyx ' + u.esc(u.odds(fav.price)) + ' implies ' + u.pct(spX.imp) + (spX.push > 0.004 ? ' · push ' + u.pct(spX.push, 1) : '') : 'no Onyx spread') + '</small></div>'
        + '<div><span class="sx-k">' + (G.totLine != null ? 'Over ' + G.totLine : 'Total') + '</span><b class="sx-pur">' + (ovX ? u.pct(ovX.p) : unX ? u.pct(1 - unX.p - unX.push) : '-') + '</b><small>avg total ' + (R_.avgA + R_.avgH).toFixed(1) + (ov ? ' · Onyx ' + u.esc(u.odds(ov.price)) + ' implies ' + u.pct(u.imp(ov.price)) : '') + ((ovX || unX) && (ovX || unX).push > 0.004 ? ' · push ' + u.pct((ovX || unX).push, 1) : '') + '</small></div></div>';
      var scores = '<div class="sim-sc">' + R_.top.map(function (t) { return '<div>' + u.esc(A) + ' ' + t.a + '<br>' + u.esc(H) + ' ' + t.h + '<small>' + u.pct(t.p, 1) + '</small></div>'; }).join('') + '</div>';
      var mh = {}; Object.keys(R_.mh).forEach(function (k) { var v = favA ? +k : -k; mh[v] = (mh[v] || 0) + R_.mh[k]; });
      var cov = fav ? -fav.hcap : null;
      var lines = G.lines.map(function (r) { var x = R_.byId[r.sel || r.label]; if (!x) return ''; return '<div class="sx-row"><span>' + u.esc(sideTxt(r)) + '<br><small style="color:var(--mute);font:600 10.5px monospace">sim ' + u.pct(x.p) + (r.conf != null ? ' · model lists ' + u.pct(r.conf) : '') + ' · Onyx implies ' + u.pct(x.imp) + '</small></span><span style="display:flex;gap:8px;align-items:center">' + evTag(x.ev, '', '%') + chip(r) + addBtn(r) + '</span></div>'; }).join('');
      $('simRes').innerHTML = '<div class="sx-card sim-fade">' + tiles + '</div>'
        + '<div class="sx-card sim-hist sim-fade"><h3 class="sx-h">' + u.esc(F) + ' margin</h3><p class="sx-sub" style="margin-bottom:6px">How much ' + u.esc(F) + ' wins (or loses, below 0) by in 10,000 games. The 3 and 7 spikes are real football.</p>'
        + hist(mh, -42, 49, cov, fav ? 'Onyx ' + sideTxt(fav) : '', true)
        + '<div class="lg"><span><i style="background:#b038f9"></i>' + u.esc(fav ? F + ' covers' : F + ' wins') + '</span><span><i style="background:rgba(255,255,255,.22)"></i>' + u.esc(Dg) + ' side</span></div></div>'
        + '<div class="sx-card sim-hist sim-fade"><h3 class="sx-h">Total points</h3>'
        + hist(R_.tt, 0, 95, G.totLine, G.totLine != null ? 'Onyx ' + G.totLine : '', true)
        + '<div class="lg"><span><i style="background:#b038f9"></i>Over' + (G.totLine != null ? ' ' + G.totLine : '') + '</span><span><i style="background:rgba(255,255,255,.22)"></i>Under</span></div></div>'
        + '<div class="sx-card sim-fade"><h3 class="sx-h">Most likely finals</h3><p class="sx-sub" style="margin-bottom:8px">Exact scores, out of 10,000 games. No single final is likely: that is football.</p>' + scores + '</div>'
        + (lines ? '<div class="sx-card sim-fade"><h3 class="sx-h">Game lines</h3><p class="sx-sub" style="margin-bottom:4px">Straight from the model\'s team scores. The chance the model lists is blended with Onyx\'s price, so where the two differ, lean on the listed one. The parlay builder only uses legs where they agree.</p>' + lines + '</div>' : '');
    }

    function evTag(ev, cls, suf) { var v = Math.round(100 * ev); return '<b class="' + cls + ' ' + (v > 0 ? 'sx-pos' : v < 0 ? 'sx-neg' : 'sx-pur') + '" style="font:800 12px monospace">' + (v > 0 ? '+' : '') + v + (suf || '') + '</b>'; }
    function addBtn(r) { if (!window.OnyxParlay || !r.sel) return ''; var on = inSlip(r.sel); return '<button class="sim-add' + (on ? ' on' : '') + '" data-sim-add="' + u.esc(r.sel) + '" aria-label="' + (on ? 'On your slip' : 'Add to slip') + '">' + (on ? '&#10003;' : '+') + '</button>'; }

    function drawProps() {
      var all = RES.props.filter(function (x) { return x.row.kind === 'prop'; });
      var grp = function (x) { var m = x.row.mkt; return TD_MK[m] ? 'td' : PASS_MK[m] ? 'pass' : m === 'rec' || m === 'rec_yds' ? 'rec' : 'rush'; };
      var list = all.filter(function (x) { return FILTER === 'all' || grp(x) === FILTER; }).sort(function (a, b) { return b.ev - a.ev; });
      var shown = ALL ? list : list.slice(0, 20);
      var segs = [['all', 'All'], ['pass', 'Passing'], ['rec', 'Receiving'], ['rush', 'Rushing'], ['td', 'Touchdowns']].map(function (s) { return '<button class="sx-chip' + (FILTER === s[0] ? ' on' : '') + '" data-sim-f="' + s[0] + '">' + s[1] + '</button>'; }).join('');
      var mov = {}; G.cont.forEach(function (c) { mov[c.row.sel || c.row.label] = c; });
      $('simProps').innerHTML = '<h3 class="sx-h">Every prop, played out</h3><p class="sx-sub">The sim\'s hit chance against the chance Onyx\'s price implies, best value first. Value is what $100 returns on average at Onyx\'s price if the sim is right.</p>'
        + '<div class="sim-seg">' + segs + '</div>'
        + (shown.length ? shown.map(function (x) {
          var r = x.row, c = mov[x.id], unit = UNIT[r.mkt], meta = [];
          if (x.avg != null && unit) meta.push('sim avg ' + (r.mkt === 'pass_td' || r.mkt === 'rec' ? x.avg.toFixed(1) : Math.round(x.avg)) + ' ' + unit);
          else if (x.avg != null && TD_MK[r.mkt]) meta.push('sim avg ' + x.avg.toFixed(2) + ' TDs');
          if (r.proj != null) meta.push('model ' + r.proj);
          if (r.no_read) meta.push('no model read: Onyx\'s chance');
          return '<div class="sim-pr"><div class="lb">' + u.esc(r.label) + '<small>' + u.esc(r.team || '') + (meta.length ? ' · ' + u.esc(meta.join(' · ')) : '') + '</small></div>'
            + '<div class="rt">' + evTag(x.ev, 'v') + chip(r) + addBtn(r) + '</div>'
            + '<div class="bars"><span>Sim</span><div class="sx-bar"><i style="width:' + (100 * x.p).toFixed(1) + '%"></i></div><em>' + u.pct(x.p) + '</em>'
            + '<span>Onyx</span><div class="sx-bar o"><i style="width:' + (100 * (x.imp || 0)).toFixed(1) + '%"></i></div><em>' + u.pct(x.imp) + '</em></div></div>';
        }).join('') : '<p class="sx-sub">No props in this group for this game.</p>')
        + (list.length > 20 ? '<button class="sx-btn ghost sim-more" data-sim-all="1">' + (ALL ? 'Show the top 20' : 'Show all ' + list.length) + '</button>' : '');
    }

    function drawKnobs() {
      var qbs = function (t) { return G.plist.filter(function (p) { return p.team === t && p.role === 'QB'; }); };
      var qbOpt = [G.A, G.H].map(function (t) {
        var q = qbs(t), who = q.length ? q.map(function (p) { return p.name; }).join(', ') : t + ' starter';
        return '<label class="sx-chip' + (K.qb[t] ? ' onyx' : '') + '" style="cursor:pointer"><input type="checkbox" data-sim-qb="' + u.esc(t) + '"' + (K.qb[t] ? ' checked' : '') + ' style="accent-color:#b038f9;margin:0"> ' + u.esc(t) + ': ' + u.esc(who) + ' out</label>';
      }).join(' ');
      var wx = WX[G.gid] || {}, dome = wx.roof === 'dome', fc = wx.wind != null && !dome ? 'Forecast at kickoff: ' + Math.round(wx.wind) + ' mph' + (wx.gust ? ', gusts ' + Math.round(wx.gust) : '') + '. ' : '';
      var sitters = G.plist.filter(function (p) { return p.role !== 'QB' && !K.sit[p.k] && (p.lam != null || G.cont.some(function (c) { return c.pl === p; })); })
        .sort(function (a, b) { return (b.lam || 0) - (a.lam || 0); });
      var sat = Object.keys(K.sit).filter(function (k) { return K.sit[k]; });
      $('simKnobs').innerHTML = '<h3 class="sx-h">Change the game</h3><p class="sx-sub" style="margin-bottom:4px">Every move re-plays all 10,000 games.</p><div class="sim-kn">'
        + '<div><div class="sx-k"><span>Starting QB out</span></div><div class="sim-sat">' + qbOpt + '</div><div class="note">The model\'s deep-backup rule: that team -3.4 points, its receivers\' yards x0.86 and catches x0.94. His own props come off.</div></div>'
        + '<label><div class="sx-k"><span>Wind</span><b>' + (dome ? 'Dome' : WIND[K.wind].mph ? WIND[K.wind].mph + (K.wind === 4 ? '+' : '') + ' mph' : 'Calm') + '</b></div><input type="range" min="0" max="4" step="1" value="' + K.wind + '" data-sim-k="wind"' + (dome ? ' disabled' : '') + ' aria-label="Wind">'
        + '<div class="note">' + (dome ? 'Closed roof: the wind does not reach this game. ' : u.esc(fc)) + 'Passing and the total come down; rushing does not move. What-if sizes, not a model fit.</div></label>'
        + '<label><div class="sx-k"><span>Pace</span><b>' + PACE_TXT[K.pace] + '</b></div><input type="range" min="0" max="4" step="1" value="' + K.pace + '" data-sim-k="pace" aria-label="Pace">'
        + '<div class="note">Both teams\' scoring and every player\'s volume, up to 10% either way.</div></label>'
        + '<div><div class="sx-k"><span>Sit a player</span></div><select class="sx-sel" data-sim-sit aria-label="Sit a player"><option value="">Pick a player to sit</option>'
        + [G.A, G.H].map(function (t) { return '<optgroup label="' + u.esc(t) + '">' + sitters.filter(function (p) { return p.team === t; }).map(function (p) { return '<option value="' + u.esc(p.k) + '">' + u.esc(p.name + ' (' + p.role + ')') + '</option>'; }).join('') + '</optgroup>'; }).join('')
        + '</select>' + (sat.length ? '<div class="sim-sat">' + sat.map(function (k) { return '<button class="sx-chip onyx" data-sim-unsit="' + u.esc(k) + '">' + u.esc(G.P[k].name) + ' sits &times;</button>'; }).join('') + '</div>' : '')
        + '<div class="note">His volume and touchdowns go to the listed teammates in his role (70% of it, at most +50% each; the rest to players without an Onyx line). His props come off.</div></div>'
        + '</div>';
    }

    function drawDiff() {
      var d = $('simDiff');
      if (!CHG || !PREV) { d.hidden = true; return; }
      var a = PREV, b = RES, items = [], f = function (x) { return Math.round(100 * x); };
      var row = function (lab, x, y) { if (x == null || y == null || f(x) === f(y)) return; items.push('<li>' + u.esc(lab) + ' ' + f(x) + '% &rarr; <span class="' + (y > x ? 'up' : 'dn') + '">' + f(y) + '%</span></li>'); };
      row(G.A + ' win', a.winA, b.winA); row(G.H + ' win', a.winH, b.winH);
      if (G.fav) { var id = G.fav.sel || G.fav.label; row(sideTxt(G.fav) + ' covers', a.byId[id] && a.byId[id].p, b.byId[id] && b.byId[id].p); }
      var ov = G.tot.filter(function (r) { return r.side !== 'under'; })[0]; if (ov) { var oi = ov.sel || ov.label; row('Over ' + ov.line, a.byId[oi] && a.byId[oi].p, b.byId[oi] && b.byId[oi].p); }
      var ta = a.avgA + a.avgH, tb = b.avgA + b.avgH; if (Math.abs(ta - tb) >= 0.1) items.push('<li>Avg total ' + ta.toFixed(1) + ' &rarr; <span class="' + (tb > ta ? 'up' : 'dn') + '">' + tb.toFixed(1) + '</span></li>');
      var moves = b.props.filter(function (x) { return x.row.kind === 'prop' && a.byId[x.id]; }).map(function (x) { return [x, x.p - a.byId[x.id].p]; })
        .filter(function (m) { return Math.abs(m[1]) >= 0.03; }).sort(function (x, y) { return Math.abs(y[1]) - Math.abs(x[1]); }).slice(0, 3);
      moves.forEach(function (m) { row(m[0].row.label, a.byId[m[0].id].p, m[0].p); });
      var gone = a.props.filter(function (x) { return !b.byId[x.id]; }).length;
      if (gone) items.push('<li>' + gone + ' prop' + (gone === 1 ? '' : 's') + ' off the board (player out)</li>');
      d.hidden = false;
      d.innerHTML = '<span class="sx-k">What changed · ' + u.esc(CHG) + '</span>' + (items.length ? '<ul>' + items.join('') + '</ul>' : '<p class="sx-sub" style="margin:6px 0 0">Nothing moved a full point.</p>');
    }

    function drawParlay() {
      var B = parlays(G, RES, u, BASEP), sizes = Object.keys(B).map(Number), el2 = $('simPl');
      if (!sizes.length) { el2.innerHTML = '<h3 class="sx-h">Build my parlay from this sim</h3><p class="sx-sub">No 2-leg combo from this game hits together often enough to suggest. Try another game or move a knob.</p>'; return; }
      var bestN = sizes.slice().sort(function (a, b) { return B[b].ev - B[a].ev; })[0];
      var n = legsN && B[legsN] ? legsN : bestN, P_ = B[n];
      var sels = P_.legs.map(function (l) { return l.row.sel; });
      el2.innerHTML = '<h3 class="sx-h">Build my parlay from this sim</h3><p class="sx-sub" style="margin-bottom:8px">The legs from this game that hit together most often against what Onyx pays. Same-game legs move together, so the joint chance beats the plain product.</p>'
        + '<div class="sim-seg">' + sizes.map(function (s) { return '<button class="sx-chip' + (s === n ? ' on' : '') + '" data-sim-n="' + s + '">' + s + ' legs</button>'; }).join('') + '</div>'
        + P_.legs.map(function (l) { return '<div class="leg"><span>' + u.esc(l.row.label) + '<small>sim ' + u.pct(l.p) + ' alone</small></span>' + chip(l.row) + '</div>'; }).join('')
        + '<div class="sim-pst"><div>Onyx price<b>' + u.esc(u.odds(u.amer(P_.dec))) + '</b></div><div>Hit together<b class="sx-pur">' + u.pct(P_.joint, 1) + '</b></div>'
        + '<div>If independent<b>' + u.pct(P_.naive, 1) + '</b></div><div>Value / $100<b class="' + (P_.ev > 0 ? 'sx-pos' : 'sx-neg') + '">' + (P_.ev > 0 ? '+$' : '-$') + Math.abs(Math.round(100 * P_.ev)) + '</b></div></div>'
        + '<p class="sx-sub" style="margin:0 0 10px">In ' + Math.round(P_.joint * N).toLocaleString() + ' of 10,000 games every leg hit. Onyx\'s price implies ' + u.pct(P_.imp, 1) + '. Correlation lift x' + (P_.joint / Math.max(1e-9, P_.naive)).toFixed(2) + '.</p>'
        + '<div class="sim-pbt"><a class="sx-btn" target="_blank" rel="noopener" data-sim-send="1" href="' + u.esc(href(sels)) + '">Send to Onyx</a>' + (window.OnyxParlay ? '<button class="sx-btn ghost" data-sim-slip="1">Add to slip</button>' : '') + '</div>'
        + '<p class="cap">The model\'s simulation, not an Onyx Pick. Onyx prices same-game legs together, so the ticket price on Onyx can be shorter than the legs multiplied.</p>';
      el2._legs = P_.legs;
    }

    function drawAll() { drawHero(); if (RES) { drawResults(); drawProps(); drawParlay(); drawDiff(); } drawKnobs(); }

    function play(animate, why) {
      if (!G) return;
      clearTimeout(timer);
      var sim = run(G, K, SEED), before = RES;
      if (!animate) {
        sim.step(N); finish(sim, before, why); return;
      }
      busy = true; drawHero(0); var t0 = Date.now(), DUR = 1100;
      (function frame() {
        var target = Math.min(N, Math.ceil(N * Math.min(1, (Date.now() - t0) / DUR))), from = sim.step(0);
        sim.step(Math.max(250, target - from)); var at = sim.step(0);
        tick(sim.sa, sim.sh, from, at);
        var nEl = $('simN'); if (nEl) nEl.textContent = at.toLocaleString() + ' / 10,000';
        if (at < N) timer = setTimeout(frame, 40); else { busy = false; finish(sim, before, why); }
      })();
    }
    function finish(sim, before, why) {
      RES = sim.done(); LAST = RES;
      if (!BASEP && !knobbed()) { BASEP = {}; RES.props.forEach(function (x) { BASEP[x.id] = x.p; }); }
      PREV = why ? before : null; CHG = why || null;
      drawAll();
      var k = Math.floor(N / 2); tick(sim.sa, sim.sh, k - 7, k);
    }

    function knobbed() { return K.wind || K.pace !== 2 || Object.keys(K.qb).some(function (k) { return K.qb[k]; }) || Object.keys(K.sit).some(function (k) { return K.sit[k]; }); }
    function setGame(gid, animate) {
      G = prep(D, gid, u); BASEP = null; K = {qb: {}, wind: 0, pace: 2, sit: {}}; RES = null; PREV = null; CHG = null; legsN = null;
      SEED = 20261115 ^ (parseInt(gid, 10) || 7);
      if (('#sim?gid=' + gid) !== location.hash && location.hash.split('?')[0] === '#sim') history.replaceState(null, '', '#sim?gid=' + gid);
      drawPick(); drawAll(); play(animate !== false);
      var on = $('simPick').querySelector('.on'), pk = $('simPick'); if (on) pk.scrollLeft = Math.max(0, on.offsetLeft - pk.offsetLeft - 16);
    }

    el.addEventListener('click', function (e) {
      var t = e.target.closest('button, a, input'); if (!t || !el.contains(t)) return;
      if (t.dataset.gid) { if (!G || G.gid !== t.dataset.gid) setGame(t.dataset.gid); return; }
      if (t.id === 'simGo' && !busy) { SEED = (SEED * 1103515245 + 12345) >>> 0; PREV = null; CHG = null; play(true); return; }
      if (t.id === 'simReset') { K = {qb: {}, wind: 0, pace: 2, sit: {}}; play(false, 'knobs reset'); return; }
      if (t.dataset.simF) { FILTER = t.dataset.simF; ALL = false; drawProps(); return; }
      if (t.dataset.simAll) { ALL = !ALL; drawProps(); return; }
      if (t.dataset.simN) { legsN = +t.dataset.simN; drawParlay(); return; }
      if (t.dataset.simUnsit) { K.sit[t.dataset.simUnsit] = false; play(false, G.P[t.dataset.simUnsit].name + ' back in'); return; }
      if (t.dataset.simOnyx) { u.onyx([t.dataset.simOnyx], 'sim'); return; }
      if (t.dataset.simSend) { u.onyx(($('simPl')._legs || []).map(function (l) { return l.row.sel; }), 'sim_parlay'); return; }
      if (t.dataset.simAdd && window.OnyxParlay) {
        e.preventDefault(); e.stopPropagation();
        var r = G.rows.filter(function (x) { return x.sel === t.dataset.simAdd; })[0]; if (r) OnyxParlay.add(r);
        setTimeout(function () { var on = inSlip(t.dataset.simAdd); t.classList.toggle('on', on); t.innerHTML = on ? '&#10003;' : '+'; }, 30); return;
      }
      if (t.dataset.simSlip && window.OnyxParlay) {
        var legs = $('simPl')._legs || [], added = 0;
        legs.forEach(function (l) { if (!inSlip(l.row.sel)) { OnyxParlay.add(l.row); added++; } });
        try { if (window.OX_TOAST) OX_TOAST(added ? added + ' leg' + (added === 1 ? '' : 's') + ' added to your slip' : 'Those legs are already on your slip', {}); } catch (x) {}
        drawProps(); drawResults(); return;
      }
    });
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.dataset.simQb) { K.qb[t.dataset.simQb] = t.checked; play(false, t.dataset.simQb + ' starting QB ' + (t.checked ? 'out' : 'back')); return; }
      if (t.hasAttribute('data-sim-sit') && t.value) { K.sit[t.value] = true; play(false, G.P[t.value].name + ' sits'); return; }
      if (t.dataset.simK) { var v = +t.value; K[t.dataset.simK] = v; play(false, t.dataset.simK === 'wind' ? 'wind ' + (WIND[v].mph ? WIND[v].mph + ' mph' : 'calm') : 'pace ' + PACE_TXT[v].toLowerCase()); }
    });
    el.addEventListener('input', function (e) {   // live label while dragging
      var t = e.target; if (!t.dataset || !t.dataset.simK) return;
      var b = t.closest('label').querySelector('b'), v = +t.value;
      if (b) b.textContent = t.dataset.simK === 'wind' ? (WIND[v].mph ? WIND[v].mph + (v === 4 ? '+' : '') + ' mph' : 'Calm') : PACE_TXT[v];
    });
    addEventListener('onyx-slip', function () { if (RES && !busy) { try { drawProps(); } catch (x) {} } });

    setGame(pickDefault());
    return {show: function () { var w = Studio.param('gid'); if (w && G && w !== G.gid && games.some(function (g) { return g.gid === w; })) setGame(w); }};
  }

  Studio.register('sim', {title: 'Play It Out', order: 2, mount: mount});
})();
