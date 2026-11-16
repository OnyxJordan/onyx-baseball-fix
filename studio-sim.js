// studio-sim.js - Play It Out (Studio tab #sim, 11/15, Jordan: "play it out ... lets go wild"; every sport 11/16).
// Pick a game, play it 10,000 times in the browser, and see what the model's projections look like as real finals:
// win %, cover % against Onyx's spread, over % against Onyx's total, the margin and total histograms with Onyx's
// lines on them, the most likely exact scores, and every player prop's simulated chance against Onyx's price.
// Knobs re-run it at once and show what changed. "Build my parlay from this sim" finds the 2-4 legs from the game
// that hit together most often against the product of their Onyx prices. One engine per kind of sport:
//
// FOOTBALL (NFL, college football; unchanged from the NFL build)
//   - team scores center on the model's team scores ("model SEA 27.8 LV 15.3" in the spread/total rows' why), or
//     Onyx's total and spread as implied team totals when the model has none. Points are counted the football way:
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
//   - starting QB out is the NFL model's v15 deep-backup rule (team points -3.4, receivers' yards x0.86, catches
//     x0.94; college football borrows it as an estimate). Wind and pace are what-if knobs, labeled as such.
// BASKETBALL (NBA, college basketball)
//   - a team's points = possessions x points per possession. Both teams share one possession count (pace) and
//     each has its own efficiency, centered on the model's team scores (the rows' why) or Onyx's total and spread.
//     The pace and efficiency spreads are solved per game so the margin's spread is 12 points (NBA) or 10.5
//     (college) and the total's 18.5 or 15.5: what those markets do around their closing lines. Ties play overtime.
//   - NBA props: points, rebounds, assists, 3s and the combos are drawn the football way (each matches the model's
//     chance at Onyx's line), from three per-player latents (points, rebounds, assists) that share his minutes
//     factor and load on his team's score and the total, sized to the Parlay Lab's fitted NBA links; a combo reads
//     the sum of its parts, 3s ride with points.
//     Double / triple-doubles are hit at exactly the model's chance off his combined latent; one first basket per
//     game is handed out in proportion to the board's chances; 1st-half and 1st-quarter totals ride the game total.
//   - knobs: pace; a star sits (NBA: his minutes go to his teammates in equal shares and each teammate's points,
//     rebounds and assists move by his own measured on/off split with that star, the model's v5 and v7 rules;
//     the team gives back 0.3 points per point the star scores, an estimate); a team on a back-to-back (-1.5
//     points, and NBA players at 30+ minutes x0.95, the model's own back-to-back minutes rule).
// HOCKEY (NHL)
//   - regulation goals are Poisson per team around the model's team goals (or the split of Onyx's total that
//     matches the model's moneyline), with one shared game factor. Empty net: a team down 1 pulls its goalie most
//     of the time, a team down 2 some of the time; the leader then scores into the empty net half the time and the
//     trailer scores 15% of the time. Ties go to 3-on-3 overtime (a goal 60% of the time) and then a shootout; the
//     winner's final gets one more goal, the way totals and the puck line (+/-1.5) are graded. The means are scaled
//     so the average total, overtime and empty nets included, still matches the center.
//   - knobs: a backup goalie in net (a save rate .010 lower: about 11% more goals against), pace.
// TENNIS
//   - played set by set and game by game: each player holds serve at a rate fitted (exact, by dynamic
//     programming) so his match chance equals the model's moneyline chance and the expected total games equals the
//     model's projection (or Onyx's total). Holds sit at a tour-typical level; a longer projection raises both, a
//     shorter one adds a match-day swing (one player's serve sharper, the other's duller, normal per match), since
//     steady holds between close players cannot make real tennis's lopsided days. Tiebreaks are played point by point from the serve-point chances that
//     produce those hold rates. Best of three; best of five in men's Grand Slam draws (the slate's event and
//     draw), with a 10-point tiebreak at 6-6 in a Slam's deciding set.
//   - knob: serve form, a hold-rate swing for either player.
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

  // ── football ─────────────────────────────────────────────────────────────────────────────────────────
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
  function prepFB(D, gid, u) {
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
    // a defense's TD row names its school; a player the board has no team for scores on his own (11/16, college)
    plist.forEach(function (p) {
      if (p.team === A || p.team === H || !/ D\/ST$/.test(p.name)) return;
      var sch = p.name.replace(/ D\/ST$/, '');
      if ((g.away_name || '').indexOf(sch) === 0) p.team = A; else if ((g.home_name || '').indexOf(sch) === 0) p.team = H;
    });
    var loose = plist.filter(function (p) { return p.lam != null && p.team !== A && p.team !== H; });
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
    return {gid: gid, g: g, A: A, H: H, mu: mu, src: src, short: {}, rows: rows, plist: plist, P: P, cont: cont, tdr: tdr, lines: lines,
            sp: sp, tot: tot, ml: ml, fav: fav, totLine: totLine, logos: logos, loose: loose};
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

  // runFB(G, K, seed) -> a stepper: step(n) plays n more games, done() finishes and summarizes
  function runFB(G, K, seed) {
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
        for (var lq = 0; lq < G.loose.length; lq++) { var lp = G.loose[lq]; td[lp.idx][i] = Math.min(250, pois(lp.lam * gf)); }
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
        var r = o.row, p = o.pl; if (X.off[p.k] || (r.mkt === 'first_td' && G.loose.indexOf(p) >= 0)) return;
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
    return {step: step, done: done, tick: function (k) { return G.A + ' ' + sa[k] + ' - ' + sh[k] + ' ' + G.H; }, up: function (k) { return sa[k] > sh[k]; }};
  }

  // ── shared: one game's Onyx lines and the model's team scores ───────────────────────────────────────
  function pois(l) { if (l <= 0) return 0; var L = Math.exp(-l), k = 0, p = 1; do { k++; p *= R(); } while (p > L && k < 40); return k - 1; }
  function base(D, gid) {
    var g = D.game(gid), rows = D.playsFor(gid);
    if (!g || !rows.length) return null;
    var A = g.away, H = g.home, mu = null, src = 'model';
    rows.forEach(function (r) {
      var m = !mu && /^model (\S+) ([\d.]+) (\S+) ([\d.]+)/.exec(r.why || '');
      if (m) { var o = {}; o[m[1]] = +m[2]; o[m[3]] = +m[4]; if (o[A] != null && o[H] != null) mu = {a: o[A], h: o[H]}; }
    });
    var sp = rows.filter(function (r) { return r.kind === 'spread'; }), tot = rows.filter(function (r) { return r.kind === 'total'; }),
        ml = rows.filter(function (r) { return r.kind === 'ml'; });
    var totLine = tot.length ? tot[0].line : null, fav = sp.filter(function (r) { return r.hcap < 0; })[0] || null;
    var logos = {}; logos[A] = g.away_logo; logos[H] = g.home_logo;
    var short = {}; short[A] = A; short[H] = H;
    return {gid: gid, g: g, A: A, H: H, mu: mu, src: src, rows: rows, sp: sp, tot: tot, ml: ml, fav: fav, totLine: totLine,
            lines: sp.concat(tot, ml), logos: logos, short: short, plist: [], P: {}, cont: [], tdr: [], bin: [], fb: []};
  }
  // the model's (or Onyx's) chance that A wins, from the moneyline rows
  function mlChance(G) {
    var a = G.ml.filter(function (r) { return r.name === G.A; })[0], h = G.ml.filter(function (r) { return r.name === G.H; })[0];
    var pa = a && a.conf != null ? a.conf : null, ph = h && h.conf != null ? 1 - h.conf : null;
    if (pa == null && ph == null && a && h) { var x = Studio.u.imp(a.price), y = Studio.u.imp(h.price); return x / (x + y); }
    return pa != null && ph != null ? (pa + ph) / 2 : pa != null ? pa : ph;
  }
  // every game line's hit array: W = what decides the winner (points, goals, sets), M = what spreads and totals grade
  // (the same arrays in team sports; games won in tennis)
  function lineHits(G, Wa, Wh, Ma, Mh, hits, push) {
    G.lines.forEach(function (r) {
      var h = new Uint8Array(N), pu = 0, k, home = r.name === G.H;
      for (k = 0; k < N; k++) {
        var d;
        if (r.kind === 'ml') d = home ? Wh[k] - Wa[k] : Wa[k] - Wh[k];
        else if (r.kind === 'spread') d = (home ? Mh[k] - Ma[k] : Ma[k] - Mh[k]) + r.hcap;
        else d = r.side === 'under' ? r.line - (Ma[k] + Mh[k]) : (Ma[k] + Mh[k]) - r.line;
        h[k] = d > 0 ? 1 : 0; if (d === 0) pu++;
      }
      hits[r.sel || r.label] = h; push[r.sel || r.label] = pu / N;
    });
  }
  // a continuous prop: center and spread solved so the board side's chance = conf at Onyx's line (as football)
  function solveCont(r, sd) {
    var b = r.proj != null ? r.proj : r.line, s0 = sd(Math.max(0.5, b)), z = qnorm(r.conf), sgn = r.side === 'under' ? -1 : 1, c = b, s = null, moved = false;
    if (r.proj != null && Math.abs(z) > 0.02) { var t = sgn * (r.proj - r.line) / z; if (t >= 0.5 * s0 && t <= 2 * s0) s = t; }
    if (s == null) { s = s0; c = r.line + sgn * s0 * z; moved = r.proj != null && Math.abs(c - r.proj) > 0.15 * s0; }
    return {c: c, s: s, moved: moved};
  }
  function stdz(arr) { var m = 0, v = 0, k; for (k = 0; k < N; k++) m += arr[k]; m /= N; for (k = 0; k < N; k++) v += (arr[k] - m) * (arr[k] - m); v = Math.sqrt(v / N) || 1; var o = new Float32Array(N); for (k = 0; k < N; k++) o[k] = (arr[k] - m) / v; return o; }

  // ── basketball ──────────────────────────────────────────────────────────────────────────────────────
  var BB = {
    nba: {sdM: 12, sdT: 18.5, poss: 99.5, ot: 5 / 48, lg: {a: 113, h: 115}},
    cbb: {sdM: 10.5, sdT: 15.5, poss: 68, ot: 5 / 40, lg: {a: 70, h: 74}}
  };
  // NBA prop markets: usual spread around a projection, and which parts (points / rebounds / assists) it reads
  var BMK = {
    pts: {sd: function (b) { return Math.max(2.5, 1.45 * Math.sqrt(b)); }, parts: ['pts']},
    reb: {sd: function (b) { return Math.max(1.2, 1.1 * Math.sqrt(b)); }, parts: ['reb']},
    ast: {sd: function (b) { return Math.max(1, 1.05 * Math.sqrt(b)); }, parts: ['ast']},
    threes: {sd: function (b) { return Math.max(0.8, 0.95 * Math.sqrt(b)); }, parts: ['pts'], thr: 1},
    pr: {sd: function (b) { return Math.max(3, 1.5 * Math.sqrt(b)); }, parts: ['pts', 'reb']},
    pa: {sd: function (b) { return Math.max(3, 1.5 * Math.sqrt(b)); }, parts: ['pts', 'ast']},
    pra: {sd: function (b) { return Math.max(3.5, 1.5 * Math.sqrt(b)); }, parts: ['pts', 'reb', 'ast']},
    h1_total: {sd: function () { return 11; }, game: 1},
    q1_total: {sd: function () { return 6.5; }, game: 1}
  };
  // a player's three latents: his minutes factor (m), his team's score (s), the game total (t), his own noise. Sized
  // so the links match the Parlay Lab's fitted NBA table (tools/nba_sgp_corr.py): one player's points and rebounds
  // +.28 (fitted +.30), points and assists +.18 (+.15), rebounds and assists +.19 (+.20); points and 3s +.70 (+.75);
  // a team covering and its player's points about +.13 (+.15); the total over and points +.15 (+.15), rebounds -.10
  var BLOAD = {pts: {m: 0.5, s: 0.2, t: 0}, reb: {m: 0.55, s: 0, t: -0.1}, ast: {m: 0.35, s: 0.2, t: 0}};
  var B2B = {pts: -1.5, mins: 30, mult: 0.95}, SIT_PTS = 0.3, OO = {a: 0.6, k: 1500, cap: 0.35};
  var PACE_BB = [0.96, 0.98, 1, 1.02, 1.04], PACE_HK = [0.9, 0.95, 1, 1.05, 1.1];

  function prepBB(D, gid, u, X) {
    var G = base(D, gid); if (!G) return null;
    var C = BB[D.sport] || BB.nba;
    if (!G.mu && G.totLine != null) {
      var hA = G.fav ? (G.fav.name === G.A ? G.fav.hcap : -G.fav.hcap) : 0;
      G.mu = {a: (G.totLine - hA) / 2, h: (G.totLine + hA) / 2}; G.src = 'onyx';
    }
    if (!G.mu) { G.mu = {a: C.lg.a, h: C.lg.h}; G.src = 'none'; }
    // players and their props (NBA)
    var P = G.P, sl = (X && X.slate) || {};
    G.rows.forEach(function (r) {
      if (r.kind !== 'prop' || !r.name || BMK[r.mkt] && BMK[r.mkt].game) return;
      var k = u.nk(r.name);
      if (!P[k]) { P[k] = {k: k, name: r.name, team: r.team, rows: [], idx: G.plist.length, min: null, proj: {}, hs: (sl[r.who] || {}).hs || null}; G.plist.push(P[k]); }
      var p = P[k]; p.rows.push(r);
      if (r.min != null) p.min = r.min;
      if ((r.mkt === 'pts' || r.mkt === 'reb' || r.mkt === 'ast') && r.proj != null) p.proj[r.mkt] = r.proj;
    });
    G.plist.forEach(function (p) {
      var pr = p.rows.filter(function (r) { return r.mkt === 'pra' && r.proj != null; })[0];
      if (p.proj.pts == null) p.proj.pts = pr ? 0.62 * pr.proj : 10;
      if (p.proj.reb == null) p.proj.reb = pr ? 0.24 * pr.proj : 4;
      if (p.proj.ast == null) p.proj.ast = pr ? 0.14 * pr.proj : 2.5;
      p.wt = {pts: BMK.pts.sd(p.proj.pts), reb: BMK.reb.sd(p.proj.reb), ast: BMK.ast.sd(p.proj.ast)};
    });
    G.rows.forEach(function (r) {
      if (r.kind !== 'prop' || r.conf == null) return;
      var M = BMK[r.mkt], p = P[u.nk(r.name)];
      if (r.mkt === 'first_basket') { if (p) G.fb.push({row: r, pl: p}); return; }
      if (r.mkt === 'dbl_dbl' || r.mkt === 'trp_dbl') { if (p) G.bin.push({row: r, pl: p, thr: qnorm(1 - Math.min(0.995, Math.max(0.005, r.conf)))}); return; }
      if (!M || r.line == null || (!M.game && !p)) return;
      var o = solveCont(r, M.sd);
      G.cont.push({row: r, pl: M.game ? null : p, c: o.c, s: o.s, moved: o.moved, M: M});
    });
    // who can sit: NBA from the board (minutes, points); college from the team cards once they load
    G.roster = G.plist.filter(function (p) { return p.min != null; }).map(function (p) { return {k: p.k, name: p.name, team: p.team, min: p.min, pts: p.proj.pts}; })
      .sort(function (a, b) { return b.min - a.min; });
    G.teamN = {}; Object.keys(sl).forEach(function (pid) { var s = sl[pid]; if (s.gid === gid && !/OUT/i.test(s.inj || '')) G.teamN[s.team] = (G.teamN[s.team] || 0) + 1; });
    G.oo = X && X.oo || null; G.C = C;
    return G;
  }
  // his own measured on/off split with a teammate (nba_onoff.log_ratio, shrunk by k minutes on the thinner side)
  function ooRatio(G, p, star, stat) {
    if (!G.oo || !p.hs || !star.hs) return 0;
    var i = {pts: 0, reb: 3, ast: 4}[stat], tot = 0, on = 0, off = 0, a = 0, b = 0;
    ['2026', '2027'].forEach(function (s) {
      var row = ((G.oo.seasons || {})[s] || {})[p.hs + '|' + star.hs]; if (!row) return;
      on += row[0]; off += row[1]; a += row[2 + i]; b += row[8 + i]; tot++;
    });
    if (!tot || on < 1 || off < 1) return 0;
    var lr = Math.log(((b + 0.5) / off) / ((a + 0.5) / on));
    return lr * Math.min(on, off) / (Math.min(on, off) + OO.k);
  }
  function paramsBB(G, K) {
    var pace = PACE_BB[K.pace] || 1, mu = {a: G.mu.a, h: G.mu.h}, off = {}, side = function (t) { return t === G.A ? 'a' : t === G.H ? 'h' : null; };
    Object.keys(K.sit).forEach(function (k) { if (K.sit[k]) off[k] = 1; });
    var sat = (G.roster || []).filter(function (p) { return off[p.k]; });
    sat.forEach(function (p) { var x = side(p.team); if (x) mu[x] -= SIT_PTS * (p.pts || 0); });
    [['a', G.A], ['h', G.H]].forEach(function (x) { if (K.b2b[x[1]]) mu[x[0]] += B2B.pts; mu[x[0]] = Math.max(30, mu[x[0]] * pace); });
    // each listed teammate of a sitting star: his minutes (equal shares across the active roster) and on/off rates
    var comp = {};    // player key -> {pts, reb, ast} multipliers
    G.plist.forEach(function (p) {
      var m = {pts: 1, reb: 1, ast: 1};
      if (!off[p.k]) {
        var mine = sat.filter(function (s) { return s.team === p.team; });
        if (mine.length && p.min) {
          var extra = 0, nn = Math.max(6, (G.teamN[p.team] || 13) - mine.length);
          mine.forEach(function (s) { extra += s.min / nn; });
          var mf = Math.min(48, p.min + extra) / p.min;
          ['pts', 'reb', 'ast'].forEach(function (st) {
            var lr = 0; mine.forEach(function (s) { var sp = G.P[s.k]; if (sp) lr += ooRatio(G, p, sp, st); });
            lr = Math.max(-OO.cap, Math.min(OO.cap, lr));
            m[st] = mf * Math.exp(OO.a * lr);
          });
        }
        if (K.b2b[p.team] && p.min >= B2B.mins) ['pts', 'reb', 'ast'].forEach(function (st) { m[st] *= B2B.mult; });
      }
      comp[p.k] = m;
    });
    var tf = (mu.a + mu.h) / (G.mu.a + G.mu.h);
    var mult = G.cont.map(function (c) {
      if (!c.pl) return tf;
      var m = comp[c.pl.k], parts = c.M.parts, w = 0, f = 0;
      parts.forEach(function (st) { var x = c.M.thr ? 1 : c.pl.proj[st]; w += x; f += x * m[st]; });
      return pace * (w ? f / w : 1);
    });
    return {mu: mu, off: off, mult: mult, pace: pace, comp: comp};
  }
  function runBB(G, K, seed) {
    var X = paramsBB(G, K), C = G.C, np = G.plist.length, nc = G.cont.length;
    var mA = X.mu.a, mH = X.mu.h, VM = C.sdM * C.sdM, VT = C.sdT * C.sdT;
    var vf = Math.max(0.0004, (VT - VM) / (4 * mA * mH)), ve = Math.max(0.0004, (VM - vf * (mA - mH) * (mA - mH)) / (mA * mA + mH * mH));
    var sf = Math.sqrt(vf), se = Math.sqrt(ve), P0 = C.poss * X.pace;
    var sa = new Int16Array(N), sh = new Int16Array(N), fp = new Float32Array(N), fbu = new Float32Array(N), i = 0;
    var lat = []; for (var q = 0; q < np; q++) lat.push([new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)]);
    var eps = []; for (q = 0; q < nc; q++) eps.push(new Float32Array(N));
    X.poss = P0;
    function step(n) {
      var end = Math.min(N, i + n);
      for (; i < end; i++) {
        S = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; R();
        var f = Math.max(0.7, 1 + sf * Z()), ea = se * Z(), eh = se * Z(), poss = P0 * f;
        var a = Math.round(poss * (mA / P0) * (1 + ea)), h = Math.round(poss * (mH / P0) * (1 + eh));
        fp[i] = f;
        for (q = 0; q < np; q++) { var L = lat[q]; L[0][i] = Z(); L[1][i] = Z(); L[2][i] = Z(); L[3][i] = Z(); }
        for (q = 0; q < nc; q++) eps[q][i] = Z();
        fbu[i] = R();
        for (var ot = 0; a === h && ot < 6; ot++) {
          var la = mA * C.ot * f, lh = mH * C.ot * f;
          a += Math.max(0, Math.round(la + 1.15 * Math.sqrt(la) * Z())); h += Math.max(0, Math.round(lh + 1.15 * Math.sqrt(lh) * Z()));
        }
        if (a === h) { if (R() < mA / (mA + mH)) a++; else h++; }
        sa[i] = a; sh[i] = h;
      }
      return i;
    }
    function done() {
      var hits = {}, avg = {}, push = {}, k;
      var SA = stdz(sa), SH = stdz(sh), T = new Float32Array(N);
      for (k = 0; k < N; k++) T[k] = sa[k] + sh[k];
      var TS = stdz(T);
      // three latents per player
      var PL = G.plist.map(function (p, pi) {
        var t = p.team === G.H ? SH : SA, L = lat[pi], o = {};
        ['pts', 'reb', 'ast'].forEach(function (st, si) {
          var l = BLOAD[st], w = Math.sqrt(Math.max(0.05, 1 - l.m * l.m - l.s * l.s - l.t * l.t)), arr = new Float32Array(N);
          for (k = 0; k < N; k++) arr[k] = l.m * L[0][k] + l.s * t[k] + l.t * TS[k] + w * L[si + 1][k];
          o[st] = arr;
        });
        return o;
      });
      var raw = new Float32Array(N);
      G.cont.forEach(function (c, ci) {
        var r = c.row; if (c.pl && X.off[c.pl.k]) return;
        var e = eps[ci];
        if (!c.pl) for (k = 0; k < N; k++) raw[k] = 0.8 * TS[k] + 0.6 * e[k];
        else {
          var L = PL[c.pl.idx];
          if (c.M.thr) for (k = 0; k < N; k++) raw[k] = 0.7 * L.pts[k] + 0.714 * e[k];
          else for (k = 0; k < N; k++) { var x = 0; c.M.parts.forEach(function (st) { x += c.pl.wt[st] * L[st][k]; }); raw[k] = x; }
        }
        var z = stdz(raw), f = X.mult[ci], cc = c.c * f, ss = c.s * Math.sqrt(f), h = new Uint8Array(N), tot = 0, over = r.side !== 'under';
        for (k = 0; k < N; k++) { var y = Math.max(0, Math.round(cc + ss * z[k])); tot += y; h[k] = over ? (y > r.line ? 1 : 0) : (y < r.line ? 1 : 0); }
        hits[r.sel || r.label] = h; avg[r.sel || r.label] = tot / N;
      });
      G.bin.forEach(function (b) {
        var p = b.pl; if (X.off[p.k]) return;
        var L = PL[p.idx], w = {}, need = b.row.mkt === 'trp_dbl' ? 3 : 2;
        // the parts closest to ten carry it
        var order = ['pts', 'reb', 'ast'].sort(function (x, y) { return Math.min(1, p.proj[y] / 10) - Math.min(1, p.proj[x] / 10); });
        order.forEach(function (st, oi) { w[st] = oi < need ? 1 : 0.3; });
        for (k = 0; k < N; k++) raw[k] = w.pts * L.pts[k] + w.reb * L.reb[k] + w.ast * L.ast[k];
        // a knob that moves his numbers moves the latent by the same share of each part's spread
        var z = stdz(raw), cm = X.comp[p.k], shift = 0, h = new Uint8Array(N);
        order.slice(0, need).forEach(function (st) { shift += (cm[st] * X.pace - 1) * p.proj[st] / BMK[st].sd(p.proj[st]) / need; });
        for (k = 0; k < N; k++) h[k] = z[k] + shift > b.thr ? 1 : 0;
        hits[b.row.sel || b.row.label] = h;
      });
      // one first basket a game, in proportion to the board's chances (the rest: players without a line)
      var fb = G.fb.filter(function (o) { return !X.off[o.pl.k]; }), fs = 0;
      fb.forEach(function (o) { fs += o.row.conf; });
      var sc = fs > 0.97 ? 0.97 / fs : 1, acc = 0;
      fb.forEach(function (o) {
        var lo = acc, hi = acc + o.row.conf * sc, h = new Uint8Array(N); acc = hi;
        for (k = 0; k < N; k++) h[k] = fbu[k] >= lo && fbu[k] < hi ? 1 : 0;
        hits[o.row.sel || o.row.label] = h;
      });
      lineHits(G, sa, sh, sa, sh, hits, push);
      return summarize(G, X, sa, sh, hits, avg, push);
    }
    return {step: step, done: done, tick: function (k) { return G.A + ' ' + sa[k] + ' - ' + sh[k] + ' ' + G.H; }, up: function (k) { return sa[k] > sh[k]; }};
  }

  // ── hockey ──────────────────────────────────────────────────────────────────────────────────────────
  var GK = 1 + 0.010 / 0.095;     // a backup's save rate .010 lower: goals against x (1 - .895) / (1 - .905)
  var HK = {pull1: 0.85, pull2: 0.55, en: 0.5, back: 0.15, otGoal: 0.6};
  function hkWin(la, lh) {    // P(A wins) incl. overtime, from regulation Poisson (no empty nets): to split a total
    var pa = 0, pt = 0, fa = [], fh = [], i, j;
    for (i = 0; i < 16; i++) { fa.push(Math.exp(-la + i * Math.log(la) - lgam(i + 1))); fh.push(Math.exp(-lh + i * Math.log(lh) - lgam(i + 1))); }
    for (i = 0; i < 16; i++) for (j = 0; j < 16; j++) { if (i > j) pa += fa[i] * fh[j]; else if (i === j) pt += fa[i] * fh[j]; }
    return pa + pt * (HK.otGoal * la / (la + lh) + (1 - HK.otGoal) * 0.5);
  }
  function lgam(n) { var s = 0; for (var i = 2; i < n; i++) s += Math.log(i); return s; }
  function prepHK(D, gid) {
    var G = base(D, gid); if (!G) return null;
    if (!G.mu && G.totLine != null) {
      var pA = mlChance(G), T = G.totLine, lo = 0.15, hi = 0.85;
      if (pA == null) pA = 0.5;
      for (var t = 0; t < 40; t++) { var m = (lo + hi) / 2; if (hkWin(T * m, T * (1 - m)) < pA) lo = m; else hi = m; }
      G.mu = {a: T * (lo + hi) / 2, h: T * (1 - (lo + hi) / 2)}; G.src = 'onyx';
    }
    if (!G.mu) { G.mu = {a: 2.9, h: 3.1}; G.src = 'none'; }
    // the scale that keeps the average total (overtime and empty nets included) on the center: one seeded pre-run
    var sv = S, x = {a: G.mu.a, h: G.mu.h}, tot = 0, n = 3000;
    for (var i = 0; i < n; i++) { S = (0x51ED ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; R(); var o = hkGame(x.a, x.h); tot += o[0] + o[1]; }
    S = sv;
    G.hkScale = Math.max(0.8, Math.min(1, (G.mu.a + G.mu.h) / (tot / n)));
    return G;
  }
  // one game: [away goals, home goals, how it ended 0 regulation / 1 OT / 2 shootout, empty-net goals]
  function hkGame(la, lh) {
    var gf = Math.exp(0.07 * Z() - 0.00245), a = pois(la * gf), h = pois(lh * gf), u1 = R(), u2 = R(), u3 = R(), u4 = R(), u5 = R(), en = 0, end = 0;
    var d = a - h, ad = Math.abs(d);
    if ((ad === 1 && u1 < HK.pull1) || (ad === 2 && u1 < HK.pull2)) {
      if (u2 < HK.en) { if (d > 0) a++; else h++; en = 1; }
      else if (u3 < HK.back) { if (d > 0) h++; else a++; }
    }
    if (a === h) {
      if (u4 < HK.otGoal) { end = 1; if (u5 < la / (la + lh)) a++; else h++; }
      else { end = 2; if (u5 < 0.5 + 0.3 * (la - lh) / (la + lh)) a++; else h++; }
    }
    return [a, h, end, en];
  }
  function runHK(G, K, seed) {
    var pace = PACE_HK[K.pace] || 1, la = G.mu.a * G.hkScale * pace * (K.gk[G.H] ? GK : 1), lh = G.mu.h * G.hkScale * pace * (K.gk[G.A] ? GK : 1);
    var X = {mu: {a: G.mu.a * pace * (K.gk[G.H] ? GK : 1), h: G.mu.h * pace * (K.gk[G.A] ? GK : 1)}, off: {}};
    var sa = new Int16Array(N), sh = new Int16Array(N), how = new Uint8Array(N), i = 0;
    function step(n) {
      var end = Math.min(N, i + n);
      for (; i < end; i++) { S = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; R(); var o = hkGame(la, lh); sa[i] = o[0]; sh[i] = o[1]; how[i] = o[2] + (o[3] ? 4 : 0); }
      return i;
    }
    function done() {
      var hits = {}, push = {}, ot = 0, so = 0, en = 0;
      for (var k = 0; k < N; k++) { if ((how[k] & 3) === 1) ot++; else if ((how[k] & 3) === 2) so++; if (how[k] & 4) en++; }
      lineHits(G, sa, sh, sa, sh, hits, push);
      var out = summarize(G, X, sa, sh, hits, {}, push);
      out.ot = ot / N; out.so = so / N; out.en = en / N;
      return out;
    }
    var tag = ['', ' OT', ' SO'];
    return {step: step, done: done, tick: function (k) { return G.A + ' ' + sa[k] + ' - ' + sh[k] + ' ' + G.H + tag[how[k] & 3]; }, up: function (k) { return sa[k] > sh[k]; }};
  }

  // ── tennis ──────────────────────────────────────────────────────────────────────────────────────────
  function holdP(p) { var q = 1 - p; return p * p * p * p * (1 + 4 * q + 10 * q * q) + 20 * p * p * p * q * q * q * p * p / (p * p + q * q); }
  function invHold(h) { var lo = 0.2, hi = 0.97; for (var t = 0; t < 40; t++) { var m = (lo + hi) / 2; if (holdP(m) < h) lo = m; else hi = m; } return (lo + hi) / 2; }
  function srv(n) { return ((n + 1) >> 1) % 2 === 0 ? 0 : 1; }    // tiebreak point n: 0 = the player who serves first
  // P(first server wins a first-to-T tiebreak), pf / po = his and the other's serve-point chances
  function tbP(pf, po, T) {
    var W = {}, x = pf * (1 - po), y = (1 - pf) * po, deuce = x / (x + y);
    function f(i, j) {
      if (i >= T && i - j >= 2) return 1; if (j >= T && j - i >= 2) return 0;
      if (i >= T - 1 && i === j) return deuce;
      var key = i * 64 + j; if (W[key] != null) return W[key];
      var p = srv(i + j) === 0 ? pf : 1 - po;
      return (W[key] = p * f(i + 1, j) + (1 - p) * f(i, j + 1));
    }
    return f(0, 0);
  }
  // one set's finals from (A's hold, B's hold, A serves first?): [[gamesA, gamesB, prob], ...]
  function setDist(hA, hB, pa, pb, aFirst, T) {
    var out = [], st = {}, k;
    st['0,0'] = 1;
    for (var n = 0; n < 12; n++) {
      var nx = {};
      Object.keys(st).forEach(function (key) {
        var g = key.split(',').map(Number), pr = st[key], aSrv = (n % 2 === 0) === aFirst, pw = aSrv ? hA : 1 - hB;
        [[g[0] + 1, g[1], pw], [g[0], g[1] + 1, 1 - pw]].forEach(function (o) {
          var i = o[0], j = o[1], p = pr * o[2];
          if ((i >= 6 && i - j >= 2) || (j >= 6 && j - i >= 2)) out.push([i, j, p]);
          else { var kk = i + ',' + j; nx[kk] = (nx[kk] || 0) + p; }
        });
      });
      st = nx;
    }
    k = st['6,6'] || 0;
    if (k) { var w = aFirst ? tbP(pa, pb, T) : 1 - tbP(pb, pa, T); out.push([7, 6, k * w]); out.push([6, 7, k * (1 - w)]); }
    return out;
  }
  // exact match chance for A and expected total games (A serves first in set 1 half the time)
  function tnExact(hA, hB, pa, pb, best, tb10) {
    var need = (best + 1) >> 1, win = 0, eg = 0, cache = {};
    function sd(af, last) { var key = (af ? 1 : 0) + (last ? 2 : 0); return cache[key] || (cache[key] = setDist(hA, hB, pa, pb, af, last && tb10 ? 10 : 7)); }
    function go(a, b, af, pr) {
      if (a === need) { win += pr; return; } if (b === need) return;
      sd(af, a === need - 1 && b === need - 1).forEach(function (o) {
        var p = pr * o[2], n = o[0] + o[1]; eg += p * n;
        go(a + (o[0] > o[1] ? 1 : 0), b + (o[1] > o[0] ? 1 : 0), n % 2 === 0 ? af : !af, p);
      });
    }
    go(0, 0, true, 0.5); go(0, 0, false, 0.5);
    return {win: win, games: eg};
  }
  // the fit: serve-point chances pa / pb around a tour-typical level, plus a match-day swing (one player's day
  // against the other's, sd sg in serve-point chance) when the projected length is shorter than steady holds give:
  // steady holds between close players cannot produce the 6-2 6-1 days real matches have
  var GH5 = [[0, 0.5333333], [1.3556262, 0.2220759], [-1.3556262, 0.2220759], [2.85697, 0.0112574], [-2.85697, 0.0112574]];
  function clp(p) { return Math.max(0.3, Math.min(0.9, p)); }
  function tnSw(pa, pb, sg, best, tb10) {
    var w = 0, g = 0;
    (sg > 0 ? GH5 : [[0, 1]]).forEach(function (n) { var a = clp(pa + sg * n[0]), b = clp(pb - sg * n[0]), e = tnExact(holdP(a), holdP(b), a, b, best, tb10); w += n[1] * e.win; g += n[1] * e.games; });
    return {win: w, games: g};
  }
  function tnFit(pW, gT, best, tb10, men) {
    var fitD = function (m, sg) {
      var lo = -0.5, hi = 0.5;
      for (var t = 0; t < 22; t++) { var d = (lo + hi) / 2; if (tnSw(clp(m + d / 2), clp(m - d / 2), sg, best, tb10).win < pW) lo = d; else hi = d; }
      return (lo + hi) / 2;
    };
    var m0 = men ? 0.64 : 0.565, SGX = 0.07, out = function (m, sg) { var d = fitD(m, sg); return {pa: clp(m + d / 2), pb: clp(m - d / 2), sg: sg}; };
    if (gT == null) return out(m0, 0);
    var f0 = out(m0, 0), g0 = tnSw(f0.pa, f0.pb, 0, best, tb10).games, lo, hi, t, x, f;
    if (gT >= g0) {          // a longer match: steadier holds
      lo = m0; hi = 0.8;
      for (t = 0; t < 14; t++) { x = (lo + hi) / 2; f = out(x, 0); if (tnSw(f.pa, f.pb, 0, best, tb10).games < gT) lo = x; else hi = x; }
      return out((lo + hi) / 2, 0);
    }
    lo = 0; hi = SGX;        // a shorter one: a bigger match-day swing
    for (t = 0; t < 14; t++) { x = (lo + hi) / 2; f = out(m0, x); if (tnSw(f.pa, f.pb, x, best, tb10).games > gT) lo = x; else hi = x; }
    return out(m0, (lo + hi) / 2);
  }
  var SLAMS = /australian open|roland garros|french open|wimbledon|us open/i;
  function prepTN(D, gid, u, X) {
    var G = base(D, gid); if (!G) return null;
    var g = G.g, info = (X && X.tn || {})[gid] || {};
    var shortOf = function (nm, i) { var s = (g.name || '').split(' vs ')[i]; return s || String(nm).split(' ').slice(-1)[0]; };
    G.short[G.A] = shortOf(G.A, 0); G.short[G.H] = shortOf(G.H, 1);
    var slam = info.major === true || SLAMS.test(g.event || '');     // ESPN's "major" = a Grand Slam
    var men = info.draw ? /^men/i.test(info.draw) : info.tour === 'ATP';
    G.best = slam && men ? 5 : 3; G.tb10 = slam; G.slam = slam;
    var pW = mlChance(G); if (pW == null) pW = 0.5;
    var gT = null, gsrc = 'onyx';
    G.rows.forEach(function (r) { var m = /([\d.]+) games projected/.exec(r.why || ''); if (m && gT == null) { gT = +m[1]; gsrc = 'model'; } });
    if (gT == null && G.totLine != null) gT = G.totLine;
    if (gT == null) gsrc = 'none';
    pW = Math.max(0.02, Math.min(0.98, pW));
    var f = tnFit(pW, gT, G.best, G.tb10, men);
    G.pa = f.pa; G.pb = f.pb; G.sg = f.sg; G.hA = holdP(f.pa); G.hB = holdP(f.pb); G.pW = pW; G.gT = gT; G.gsrc = gsrc; G.men = men;
    var ex = tnSw(G.pa, G.pb, G.sg, G.best, G.tb10); G.fitWin = ex.win; G.fitGames = ex.games;
    G.mu = {a: null, h: null}; G.src = mlChance(G) != null ? 'model' : 'none';
    return G;
  }
  var FORM = 0.03, FORM_TXT = ['Off day', 'Shaky', 'As fitted', 'Sharp', 'On fire'];
  function runTN(G, K, seed) {
    var hA = Math.max(0.3, Math.min(0.97, G.hA + FORM * (K.form.a - 2))), hB = Math.max(0.3, Math.min(0.97, G.hB + FORM * (K.form.h - 2)));
    var pa0 = K.form.a === 2 ? G.pa : invHold(hA), pb0 = K.form.h === 2 ? G.pb : invHold(hB), need = (G.best + 1) >> 1, pa, pb;
    var X = {mu: {a: null, h: null}, off: {}, hA: hA, hB: hB};
    var sa = new Int8Array(N), sh = new Int8Array(N), ga = new Int16Array(N), gh = new Int16Array(N), ss = new Int8Array(N * 10), i = 0;
    function step(n) {
      var end = Math.min(N, i + n);
      for (; i < end; i++) {
        S = (seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0; R();
        var aSrv = R() < 0.5, a = 0, b = 0, gA = 0, gB = 0, set = 0, dl = G.sg * Z();
        pa = clp(pa0 + dl); pb = clp(pb0 - dl); hA = holdP(pa); hB = holdP(pb);
        while (a < need && b < need) {
          var x = 0, y = 0, last = a === need - 1 && b === need - 1;
          while (!((x >= 6 && x - y >= 2) || (y >= 6 && y - x >= 2) || x === 7 || y === 7)) {
            if (x === 6 && y === 6) {     // tiebreak, point by point
              var T = last && G.tb10 ? 10 : 7, ti = 0, tj = 0, n2 = 0;
              while (!((ti >= T && ti - tj >= 2) || (tj >= T && tj - ti >= 2))) {
                var first = srv(n2) === 0, aServes = first === aSrv, pw = aServes ? pa : 1 - pb;
                if (R() < pw) ti++; else tj++; n2++;
              }
              if (ti > tj) x++; else y++;
              aSrv = !aSrv;     // the tiebreak's receiver serves first next set (13 games: odd)
              break;
            }
            if (R() < (aSrv ? hA : 1 - hB)) x++; else y++;
            aSrv = !aSrv;
          }
          if (set < 5) { ss[i * 10 + set * 2] = x; ss[i * 10 + set * 2 + 1] = y; }
          set++; gA += x; gB += y; if (x > y) a++; else b++;
        }
        sa[i] = a; sh[i] = b; ga[i] = gA; gh[i] = gB;
      }
      return i;
    }
    function done() {
      var hits = {}, push = {}, ma = new Int16Array(N), ta = new Int16Array(N), k;
      for (k = 0; k < N; k++) { ma[k] = ga[k] - gh[k]; ta[k] = ga[k] + gh[k]; }
      lineHits(G, sa, sh, ga, gh, hits, push);
      var out = summarize(G, X, sa, sh, hits, {}, push, ma, ta);
      var t1 = 0, t2 = 0; for (k = 0; k < N; k++) { t1 += ga[k]; t2 += gh[k]; }
      out.avgA = t1 / N; out.avgH = t2 / N;
      return out;
    }
    function tick(k) {
      var w = sa[k] > sh[k], s = [];
      for (var j = 0; j < 5; j++) { var x = ss[k * 10 + j * 2], y = ss[k * 10 + j * 2 + 1]; if (!x && !y) break; s.push(w ? x + '-' + y : y + '-' + x); }
      return G.short[w ? G.A : G.H] + ' ' + s.join(' ');
    }
    return {step: step, done: done, tick: tick, up: function (k) { return sa[k] > sh[k]; }};
  }

  // ma / ta: what the margin and total histograms count (games in tennis); team sports use the scores themselves
  function summarize(G, X, sa, sh, hits, avg, push, ma, ta) {
    var wa = 0, ta_ = 0, th = 0, mh = {}, tt = {}, k, mx = 0;
    for (k = 0; k < N; k++) mx = Math.max(mx, sa[k], sh[k]);
    var W = Math.min(200, mx + 1), sc = new Int32Array(W * W);
    for (k = 0; k < N; k++) {
      var a = sa[k], h = sh[k], m = ma ? ma[k] : a - h, t = ta ? ta[k] : a + h; if (a > h) wa++; ta_ += a; th += h;
      if (a < W && h < W) sc[a * W + h]++;
      mh[m] = (mh[m] || 0) + 1; tt[t] = (tt[t] || 0) + 1;
    }
    var top = [];
    for (k = 0; k < sc.length; k++) if (sc[k]) top.push([k, sc[k]]);
    top.sort(function (x, y) { return y[1] - x[1]; });
    top = top.slice(0, 6).map(function (x) { return {a: Math.floor(x[0] / W), h: x[0] % W, p: x[1] / N}; });
    var props = [];
    G.rows.forEach(function (r) {
      var id = r.sel || r.label, h = hits[id]; if (!h) return;
      var n = 0; for (var j = 0; j < N; j++) n += h[j];
      var p = n / N, imp = r.price != null ? Studio.u.imp(r.price) : null;
      props.push({id: id, row: r, p: p, imp: imp, ev: r.price != null ? p * Studio.u.dec(r.price) - 1 : null, avg: avg[id], push: push[id] || 0, h: h});
    });
    return {winA: wa / N, winH: 1 - wa / N, avgA: ta_ / N, avgH: th / N, top: top, mh: mh, tt: tt, props: props, mu: X.mu,
            byId: props.reduce(function (o, x) { o[x.id] = x; return o; }, {}), sample: [sa[0], sh[0], sa[N - 1], sh[N - 1]], ties: (function () { var t = 0; for (var q = 0; q < N; q++) if (sa[q] === sh[q]) t++; return t; })()};
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

  // ── the tab ──────────────────────────────────────────────────────────────────────────────────────────
  var SP = Studio.sport, KIND = {nfl: 'fb', cfb: 'fb', nba: 'bb', cbb: 'bb', nhl: 'hk', tennis: 'tn'}[SP] || 'fb';
  var ENG = {fb: {prep: prepFB, run: runFB}, bb: {prep: prepBB, run: runBB}, hk: {prep: prepHK, run: runHK}, tn: {prep: prepTN, run: runTN}}[KIND];
  var NBA_F = [['all', 'All'], ['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['threes', 'Threes'], ['combo', 'Combos'], ['spec', 'Specials']];
  var FB_F = [['all', 'All'], ['pass', 'Passing'], ['rec', 'Receiving'], ['rush', 'Rushing'], ['td', 'Touchdowns']];
  var BUNIT = {pts: 'pts', reb: 'reb', ast: 'ast', threes: '3s', pr: 'pts + reb', pa: 'pts + ast', pra: 'pts + reb + ast', h1_total: '1st-half pts', q1_total: '1st-quarter pts'};
  var LAST = null, CHECK = null;
  Studio.simLast = function () { return LAST; };   // read-only, for tools/ probes
  Studio.checks.sim = function () {
    if (!LAST) return 'no simulation has run';
    var s = LAST.winA + LAST.winH;
    if (Math.abs(s - 1) > 0.005) return 'win percentages sum to ' + (100 * s).toFixed(1);
    if (!LAST.sample.every(function (x) { return Number.isInteger(x); }) || !LAST.top.every(function (t) { return Number.isInteger(t.a) && Number.isInteger(t.h); })) return 'scores are not whole numbers';
    if (LAST.ties) return LAST.ties + ' simulated games ended tied';
    if (KIND === 'tn') {
      var need = (CHECK && CHECK.best + 1) >> 1 || 2;
      if (!LAST.top.every(function (t) { return Math.max(t.a, t.h) === need && Math.min(t.a, t.h) < need; })) return 'a match did not end on ' + need + ' sets';
    }
    if (CHECK) {
      if (KIND === 'tn' && Math.abs(CHECK.win - CHECK.pW) > 0.025) return 'tennis win ' + (100 * CHECK.win).toFixed(1) + '% vs the board\'s ' + (100 * CHECK.pW).toFixed(1) + '%';
      if (KIND === 'bb' && Math.abs(CHECK.tot - CHECK.mu) > 2.5) return 'avg total ' + CHECK.tot.toFixed(1) + ' vs center ' + CHECK.mu.toFixed(1);
      if (KIND === 'hk' && Math.abs(CHECK.tot - CHECK.mu) > 0.2) return 'avg goals ' + CHECK.tot.toFixed(2) + ' vs center ' + CHECK.mu.toFixed(2);
    }
    return '';
  };

  function getJ(p) { return fetch(p + '?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  // what an engine reads beyond the board: NBA the slate's players (ESPN ids) and the on/off splits, tennis the events
  function extras(D) {
    if (SP === 'nba') return Promise.all([getJ(D.dir + 'slate.json'), getJ(D.dir + 'onoff.json')]).then(function (a) {
      var sl = {}; ((a[0] || {}).players || []).forEach(function (p) { if (p && p.pid) sl[p.pid] = p; });
      return {slate: sl, oo: a[1]};
    });
    if (SP === 'tennis') return getJ(D.dir + 'slate.json').then(function (j) {
      var tn = {}; ((j || {}).events || []).forEach(function (e) { (e.matches || []).forEach(function (m) { tn[m.id] = {major: e.major, tour: e.tour, draw: m.draw, event: e.name}; }); });
      return {tn: tn};
    });
    return Promise.resolve({});
  }

  function mount(el, D, u) {
    if (!document.getElementById('sx-sim-css')) { var st = document.createElement('style'); st.id = 'sx-sim-css'; st.textContent = CSS; document.head.appendChild(st); }
    var games = D.games.filter(function (g) { return D.playsFor(g.gid).length && g.state !== 'post'; }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
    var NM = D.sportName, unitW = KIND === 'tn' ? 'matches' : 'games';
    if (!games.length) { el.innerHTML = '<div class="sx-card"><h3 class="sx-h">Play It Out</h3><p class="sx-sub">No ' + u.esc(NM) + ' ' + unitW + ' with Onyx lines on the board right now. The next slate shows up here once Onyx posts its prices.</p></div>'; return {}; }
    var WX = {}, EXT = null;
    if (SP === 'nfl') fetch('data/nfl/weather.json?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { WX = j || {}; if (G && RES) drawKnobs(); }).catch(function () {});
    var G = null, K = null, BASEP = null, RES = null, PREV = null, SEED = 20261115, CHG = null, legsN = null, FILTER = 'all', ALL = false, busy = false, timer = null;
    function freshK() { return {qb: {}, wind: 0, pace: 2, sit: {}, b2b: {}, gk: {}, form: {a: 2, h: 2}}; }
    function pickDefault() {
      var want = Studio.param('gid'); if (want && games.some(function (g) { return g.gid === want; })) return want;
      var now = Date.now(), next = games.filter(function (g) { return Date.parse(g.start) > now; })[0];
      return (next || games[0]).gid;
    }
    el.innerHTML = '<div class="sim">'
      + '<div class="sim-pick" id="simPick" role="tablist" aria-label="Games"></div>'
      + '<div class="sim-main"><div class="sim-col"><div class="sx-card sim-hero" id="simHero"><div class="st-load">Loading the ' + unitW + '</div></div><div id="simRes" class="sim-col"></div></div>'
      + '<div class="sim-col"><div class="sx-card sim-diff" id="simDiff" hidden></div><div class="sx-card" id="simKnobs"></div><div class="sx-card sim-pl" id="simPl"></div></div></div>'
      + '<div class="sx-card" id="simProps" hidden></div>'
      + '<details class="sx-card sim-how"><summary>How it works</summary>' + howHTML() + '</details>'
      + '</div>';
    var $ = function (id) { return el.querySelector('#' + id); };
    function nm(t) { return G && G.short && G.short[t] || t; }

    function drawPick() {
      $('simPick').innerHTML = games.map(function (g) {
        var lg = function (src) { return src ? '<img src="' + u.esc(src) + '" alt="" loading="lazy" onerror="this.remove()">' : ''; };
        var t = KIND === 'tn' ? u.esc(g.name || (g.away + ' vs ' + g.home)) : lg(g.away_logo) + u.esc(g.away) + ' <span style="color:var(--mute)">@</span> ' + lg(g.home_logo) + u.esc(g.home);
        return '<button class="sim-g' + (G && G.gid === g.gid ? ' on' : '') + '" data-gid="' + u.esc(g.gid) + '" role="tab"><div class="t">' + t + '</div><div class="k">' + u.esc(u.fmtTime(g.start)) + (KIND === 'tn' && g.round ? ' · ' + u.esc(g.round) : '') + '</div></button>';
      }).join('');
    }
    function sideTxt(r) { return r.kind === 'total' ? (r.side === 'under' ? 'Under ' : 'Over ') + r.line + (KIND === 'tn' ? ' games' : '') : r.kind === 'ml' ? nm(r.name) + ' to win' : nm(r.name) + ' ' + (r.hcap > 0 ? '+' : '') + r.hcap; }
    function href(sels) { sels = sels.filter(Boolean); return sels.length ? 'https://app.onyxodds.com/share?' + sels.map(function (s) { return 'selection=' + encodeURIComponent(s); }).join('&') + '&referrer=KR680261' : null; }
    function chip(r) { return r.sel ? '<a class="sx-chip onyx" target="_blank" rel="noopener" data-sim-onyx="' + u.esc(r.sel) + '" href="' + u.esc(href([r.sel])) + '">Onyx ' + u.esc(u.odds(r.price)) + '</a>' : '<span class="sx-chip">' + u.esc(u.odds(r.price)) + '</span>'; }
    function inSlip(sel) { try { return !!(window.OnyxParlay && OnyxParlay.slip().some(function (x) { return x.sel === sel; })); } catch (e) { return false; } }

    function srcText() {
      var A = G.A, H = G.H;
      if (KIND === 'tn') {
        var gs = G.gsrc === 'model' ? G.gT + ' games (the model\'s projection)' : G.gsrc === 'onyx' ? G.gT + ' games (Onyx\'s total)' : 'a typical match length';
        return 'Holds fitted to the model\'s ' + u.pct(G.pW) + ' for ' + nm(A) + ' and ' + gs + ': ' + nm(A) + ' holds ' + u.pct(G.hA) + ', ' + nm(H) + ' ' + u.pct(G.hB) + ' on an average day' + (G.sg > 0.004 ? ' (and some days one player is sharper)' : '') + ' · best of ' + G.best + (G.slam ? ', Grand Slam' : '');
      }
      var d = KIND === 'hk' ? 2 : 1;
      return G.src === 'model' ? 'Centered on the model: ' + A + ' ' + G.mu.a.toFixed(d) + ', ' + H + ' ' + G.mu.h.toFixed(d)
        : G.src === 'onyx' ? (KIND === 'hk' ? 'No model score for this game, so the sim splits Onyx\'s total to match the moneyline: ' + A + ' ' + G.mu.a.toFixed(2) + ', ' + H + ' ' + G.mu.h.toFixed(2)
          : 'No model score for this game, so the sim centers on Onyx\'s total and spread: ' + A + ' ' + G.mu.a.toFixed(1) + ', ' + H + ' ' + G.mu.h.toFixed(1))
        : 'No team lines for this game yet: a league-average game';
    }
    function drawHero(progress) {
      var g = G.g, R_ = RES, A = G.A, H = G.H;
      var team = function (ab, logo, sc, w, fav) {
        return '<div class="sim-tm' + (fav ? ' fav' : '') + '">' + (logo ? '<img src="' + u.esc(logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') + '<div class="ab">' + u.esc(ab) + '</div>'
          + '<div class="sc">' + (sc == null ? '-' : sc.toFixed(KIND === 'hk' ? 2 : 1)) + '</div><div class="w">' + (w == null ? 'avg' : u.pct(w) + ' win') + '</div></div>';
      };
      var on = G.fav ? 'Onyx: ' + sideTxt(G.fav) + (G.totLine != null ? ' · total ' + G.totLine : '') : (G.totLine != null ? 'Onyx total ' + G.totLine : '');
      var vs = KIND === 'tn' ? (g.event ? u.esc(g.event) + (g.round ? ', ' + u.esc(g.round) : '') + ' · ' : '') : u.esc(g.away_name || A) + ' at ' + u.esc(g.home_name || H) + ' · ';
      $('simHero').innerHTML = '<div class="sim-ctr"><span class="sx-k">' + vs + u.esc(u.fmtTime(g.start)) + '</span>'
        + '<span class="n" id="simN">' + (progress != null ? progress.toLocaleString() + ' / 10,000' : RES ? '10,000 ' + unitW + ' played' : '') + '</span></div>'
        + '<div class="sim-mu" style="margin-top:10px">' + team(nm(A), G.logos[A], R_ ? R_.avgA : null, R_ ? R_.winA : null, R_ && R_.winA > 0.5) + '<div class="sim-vs">AVG<br>' + (KIND === 'tn' ? 'GAMES' : 'FINAL') + '</div>'
        + team(nm(H), G.logos[H], R_ ? R_.avgH : null, R_ ? R_.winH : null, R_ && R_.winH > 0.5) + '</div>'
        + '<div class="sim-wb" aria-label="Win split"><i class="a" style="width:' + (R_ ? 100 * R_.winA : 50) + '%"></i><i class="h" style="width:' + (R_ ? 100 * R_.winH : 50) + '%"></i></div>'
        + '<div class="sim-tick" id="simTick"></div>'
        + '<div class="sim-src">' + u.esc(srcText()) + (on ? '<br>' + u.esc(on) : '') + (RES && KIND === 'hk' ? '<br>' + u.esc('Overtime ' + u.pct(RES.ot) + ' · shootout ' + u.pct(RES.so) + ' · empty-net goal ' + u.pct(RES.en)) : '') + '</div>'
        + '<div class="sim-ctr" style="margin-top:12px"><button class="sx-btn" id="simGo"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Playing it out' : RES ? 'Play it out again' : 'Play it out 10,000 times') + '</button>'
        + '<button class="sx-btn ghost" id="simReset">Reset knobs</button></div>';
    }
    function tick(sim, from, to) {
      var t = $('simTick'); if (!t) return;
      var out = [], n = 7;
      for (var k = Math.max(from, to - n); k < to; k++) out.push('<span class="' + (sim.up(k) ? 'up' : '') + '">' + u.esc(sim.tick(k)) + '</span>');
      t.innerHTML = out.join('');
    }

    // a histogram's range: football's fixed windows, everything else from where 99.6% of the results fall
    function span(map, line) {
      var ks = Object.keys(map).map(Number).sort(function (a, b) { return a - b; }), c = 0, lo = ks[0], hi = ks[ks.length - 1];
      for (var i = 0; i < ks.length; i++) { c += map[ks[i]]; if (c >= 0.002 * N) { lo = ks[i]; break; } }
      c = 0; for (i = ks.length - 1; i >= 0; i--) { c += map[ks[i]]; if (c >= 0.002 * N) { hi = ks[i]; break; } }
      if (line != null) { lo = Math.min(lo, Math.floor(line) - 1); hi = Math.max(hi, Math.ceil(line) + 1); }
      return [lo, hi];
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
      var r = hi - lo, ticks = '', step = KIND === 'fb' ? (r > 60 ? 10 : 7) : r > 60 ? 10 : r > 24 ? 5 : r > 12 ? 2 : 1;
      for (k = Math.ceil(lo / step) * step; k <= hi; k += step) ticks += '<text x="' + ((k - lo + 0.5) * bw).toFixed(1) + '" y="' + (Hh - 3) + '" fill="#9a93a6" font-size="9" font-family="monospace" text-anchor="middle">' + k + '</text>';
      var ln = '';
      if (line != null) { var x = ((line - lo + 0.5) * bw).toFixed(1); ln = '<line x1="' + x + '" x2="' + x + '" y1="2" y2="' + (Hh - pad) + '" stroke="#d795ff" stroke-width="1.5" stroke-dasharray="3 2"/><text x="' + (+x + 4) + '" y="11" fill="#d795ff" font-size="10" font-family="monospace" font-weight="700"' + (+x > W * 0.7 ? ' text-anchor="end" dx="-8"' : '') + '>' + u.esc(label) + '</text>'; }
      return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + u.esc(label || 'histogram') + '">' + bars + ln + ticks + '</svg>';
    }

    var COPY = {
      fb: {m: ' margin', ms: function (F) { return 'How much ' + F + ' wins (or loses, below 0) by in 10,000 games. The 3 and 7 spikes are real football.'; }, t: 'Total points',
           s: 'Most likely finals', ss: 'Exact scores, out of 10,000 games. No single final is likely: that is football.'},
      bb: {m: ' margin', ms: function (F) { return 'How much ' + F + ' wins (or loses, below 0) by in 10,000 games. No ties: a tied game plays overtime.'; }, t: 'Total points',
           s: 'Most likely finals', ss: 'Exact scores, out of 10,000 games. Any one final is a long shot in basketball.'},
      hk: {m: ' goal margin', ms: function (F) { return 'How much ' + F + ' wins (or loses, below 0) by in 10,000 games. Overtime and shootout wins pile onto 1; empty-net goals push some leads to 2.'; }, t: 'Total goals',
           s: 'Most likely finals', ss: 'Exact scores out of 10,000 games, overtime and shootout winners included (they get one goal, the way Onyx grades it).'},
      tn: {m: ' game margin', ms: function (F) { return 'Games ' + F + ' wins minus games lost across the match, in 10,000 matches. Onyx\'s game spread is graded on this.'; }, t: 'Total games',
           s: 'How it ends in sets', ss: 'Set scores out of 10,000 matches.'}
    }[KIND];
    function drawResults() {
      var R_ = RES, A = G.A, H = G.H, fav = G.fav, favA = fav ? fav.name === A : R_.winA >= R_.winH, F = favA ? A : H, Dg = favA ? H : A;
      var spX = fav ? R_.byId[fav.sel || fav.label] : null, ov = G.tot.filter(function (r) { return r.side !== 'under'; })[0], un = G.tot.filter(function (r) { return r.side === 'under'; })[0];
      var ovX = ov ? R_.byId[ov.sel || ov.label] : null, unX = un ? R_.byId[un.sel || un.label] : null;
      var tiles = '<div class="sim-ln">'
        + '<div><span class="sx-k">' + u.esc(fav ? sideTxt(fav) + ' covers' : nm(F) + ' wins') + '</span><b class="sx-pur">' + u.pct(spX ? spX.p : (favA ? R_.winA : R_.winH)) + '</b><small>' + (spX ? 'Onyx ' + u.esc(u.odds(fav.price)) + ' implies ' + u.pct(spX.imp) + (spX.push > 0.004 ? ' · push ' + u.pct(spX.push, 1) : '') : 'no Onyx spread') + '</small></div>'
        + '<div><span class="sx-k">' + (G.totLine != null ? 'Over ' + G.totLine : 'Total') + '</span><b class="sx-pur">' + (ovX ? u.pct(ovX.p) : unX ? u.pct(1 - unX.p - unX.push) : '-') + '</b><small>avg total ' + (KIND === 'tn' ? (R_.avgA + R_.avgH).toFixed(1) + ' games' : (R_.avgA + R_.avgH).toFixed(KIND === 'hk' ? 2 : 1)) + (ov ? ' · Onyx ' + u.esc(u.odds(ov.price)) + ' implies ' + u.pct(u.imp(ov.price)) : '') + ((ovX || unX) && (ovX || unX).push > 0.004 ? ' · push ' + u.pct((ovX || unX).push, 1) : '') + '</small></div></div>';
      var scores = '<div class="sim-sc">' + R_.top.map(function (t) { return '<div>' + u.esc(nm(A)) + ' ' + t.a + '<br>' + u.esc(nm(H)) + ' ' + t.h + '<small>' + u.pct(t.p, 1) + '</small></div>'; }).join('') + '</div>';
      var mh = {}; Object.keys(R_.mh).forEach(function (k) { var v = favA ? +k : -k; mh[v] = (mh[v] || 0) + R_.mh[k]; });
      var cov = fav ? -fav.hcap : null;
      var mr = SP === 'nfl' ? [-42, 49] : SP === 'cfb' ? [-56, 63] : span(mh, cov), tr = SP === 'nfl' ? [0, 95] : SP === 'cfb' ? [0, 115] : span(R_.tt, G.totLine);
      var lines = G.lines.map(function (r) { var x = R_.byId[r.sel || r.label]; if (!x) return ''; return '<div class="sx-row"><span>' + u.esc(sideTxt(r)) + '<br><small style="color:var(--mute);font:600 10.5px monospace">sim ' + u.pct(x.p) + (r.conf != null ? ' · model lists ' + u.pct(r.conf) : '') + ' · Onyx implies ' + u.pct(x.imp) + '</small></span><span style="display:flex;gap:8px;align-items:center">' + evTag(x.ev, '', '%') + chip(r) + addBtn(r) + '</span></div>'; }).join('');
      var linesSub = KIND === 'tn' ? 'From the fitted hold rates: the moneyline matches the model\'s chance by construction; the game spread and total are what those holds imply. The parlay builder only uses legs where the sim and the model\'s listed chance agree.'
        : 'Straight from the ' + (G.src === 'model' ? 'model\'s team scores' : 'center above') + '. The chance the model lists can be blended with Onyx\'s price, so where the two differ, lean on the listed one. The parlay builder only uses legs where they agree.';
      $('simRes').innerHTML = '<div class="sx-card sim-fade">' + tiles + '</div>'
        + '<div class="sx-card sim-hist sim-fade"><h3 class="sx-h">' + u.esc(nm(F) + COPY.m) + '</h3><p class="sx-sub" style="margin-bottom:6px">' + u.esc(COPY.ms(nm(F))) + '</p>'
        + hist(mh, mr[0], mr[1], cov, fav ? 'Onyx ' + sideTxt(fav) : '', true)
        + '<div class="lg"><span><i style="background:#b038f9"></i>' + u.esc(fav ? nm(F) + ' covers' : nm(F) + ' wins') + '</span><span><i style="background:rgba(255,255,255,.22)"></i>' + u.esc(nm(Dg)) + ' side</span></div></div>'
        + '<div class="sx-card sim-hist sim-fade"><h3 class="sx-h">' + COPY.t + '</h3>'
        + hist(R_.tt, tr[0], tr[1], G.totLine, G.totLine != null ? 'Onyx ' + G.totLine : '', true)
        + '<div class="lg"><span><i style="background:#b038f9"></i>Over' + (G.totLine != null ? ' ' + G.totLine : '') + '</span><span><i style="background:rgba(255,255,255,.22)"></i>Under</span></div></div>'
        + '<div class="sx-card sim-fade"><h3 class="sx-h">' + COPY.s + '</h3><p class="sx-sub" style="margin-bottom:8px">' + COPY.ss + '</p>' + scores + '</div>'
        + (lines ? '<div class="sx-card sim-fade"><h3 class="sx-h">Game lines</h3><p class="sx-sub" style="margin-bottom:4px">' + linesSub + '</p>' + lines + '</div>' : '');
    }

    function evTag(ev, cls, suf) { var v = Math.round(100 * ev); return '<b class="' + cls + ' ' + (v > 0 ? 'sx-pos' : v < 0 ? 'sx-neg' : 'sx-pur') + '" style="font:800 12px monospace">' + (v > 0 ? '+' : '') + v + (suf || '') + '</b>'; }
    function addBtn(r) { if (!window.OnyxParlay || !r.sel) return ''; var on = inSlip(r.sel); return '<button class="sim-add' + (on ? ' on' : '') + '" data-sim-add="' + u.esc(r.sel) + '" aria-label="' + (on ? 'On your slip' : 'Add to slip') + '">' + (on ? '&#10003;' : '+') + '</button>'; }

    function grp(x) {
      var m = x.row.mkt;
      if (KIND === 'bb') return m === 'pts' || m === 'reb' || m === 'ast' || m === 'threes' ? m : m === 'pr' || m === 'pa' || m === 'pra' ? 'combo' : 'spec';
      return TD_MK[m] ? 'td' : PASS_MK[m] ? 'pass' : m === 'rec' || m === 'rec_yds' ? 'rec' : 'rush';
    }
    function drawProps() {
      var all = RES.props.filter(function (x) { return x.row.kind === 'prop'; }), box = $('simProps');
      if (!all.length && !G.rows.some(function (r) { return r.kind === 'prop'; })) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      var list = all.filter(function (x) { return FILTER === 'all' || grp(x) === FILTER; }).sort(function (a, b) { return b.ev - a.ev; });
      var shown = ALL ? list : list.slice(0, 20);
      var segs = (KIND === 'bb' ? NBA_F : FB_F).map(function (s) { return '<button class="sx-chip' + (FILTER === s[0] ? ' on' : '') + '" data-sim-f="' + s[0] + '">' + s[1] + '</button>'; }).join('');
      $('simProps').innerHTML = '<h3 class="sx-h">Every prop, played out</h3><p class="sx-sub">The sim\'s hit chance against the chance Onyx\'s price implies, best value first. Value is what $100 returns on average at Onyx\'s price if the sim is right.</p>'
        + '<div class="sim-seg">' + segs + '</div>'
        + (shown.length ? shown.map(function (x) {
          var r = x.row, meta = [], unit = KIND === 'bb' ? BUNIT[r.mkt] : UNIT[r.mkt];
          if (x.avg != null && unit) meta.push('sim avg ' + (KIND === 'bb' || r.mkt === 'pass_td' || r.mkt === 'rec' ? x.avg.toFixed(1) : Math.round(x.avg)) + ' ' + unit);
          else if (x.avg != null && TD_MK[r.mkt]) meta.push('sim avg ' + x.avg.toFixed(2) + ' TDs');
          if (r.proj != null) meta.push('model ' + r.proj);
          else if (r.conf != null && KIND === 'bb' && !BUNIT[r.mkt]) meta.push('model ' + u.pct(r.conf));
          if (r.no_read) meta.push('no model read: Onyx\'s chance');
          return '<div class="sim-pr"><div class="lb">' + u.esc(r.label) + '<small>' + u.esc(r.team || '') + (meta.length ? ' · ' + u.esc(meta.join(' · ')) : '') + '</small></div>'
            + '<div class="rt">' + evTag(x.ev, 'v') + chip(r) + addBtn(r) + '</div>'
            + '<div class="bars"><span>Sim</span><div class="sx-bar"><i style="width:' + (100 * x.p).toFixed(1) + '%"></i></div><em>' + u.pct(x.p) + '</em>'
            + '<span>Onyx</span><div class="sx-bar o"><i style="width:' + (100 * (x.imp || 0)).toFixed(1) + '%"></i></div><em>' + u.pct(x.imp) + '</em></div></div>';
        }).join('') : '<p class="sx-sub">' + (all.length ? 'No props in this group for this game.' : 'Every player with a prop here is sitting. Bring one back in.') + '</p>')
        + (list.length > 20 ? '<button class="sx-btn ghost sim-more" data-sim-all="1">' + (ALL ? 'Show the top 20' : 'Show all ' + list.length) + '</button>' : '');
    }

    function slider(key, lab, val, txt, note, dis) {
      return '<label><div class="sx-k"><span>' + u.esc(lab) + '</span><b>' + u.esc(txt) + '</b></div><input type="range" min="0" max="4" step="1" value="' + val + '" data-sim-k="' + key + '"' + (dis ? ' disabled' : '') + ' aria-label="' + u.esc(lab) + '">'
        + '<div class="note">' + note + '</div></label>';
    }
    function tog(kind, t, on, text) {
      return '<label class="sx-chip' + (on ? ' onyx' : '') + '" style="cursor:pointer"><input type="checkbox" data-sim-tog="' + kind + '" data-team="' + u.esc(t) + '"' + (on ? ' checked' : '') + ' style="accent-color:#b038f9;margin:0"> ' + u.esc(text) + '</label>';
    }
    function sitBox(sitters, label, note) {
      var sat = Object.keys(K.sit).filter(function (k) { return K.sit[k]; }), who = function (k) { var p = (G.roster || []).filter(function (x) { return x.k === k; })[0] || G.P[k]; return p ? p.name : k; };
      return '<div><div class="sx-k"><span>' + u.esc(label) + '</span></div><select class="sx-sel" data-sim-sit aria-label="' + u.esc(label) + '"><option value="">' + (sitters.length ? 'Pick a player to sit' : 'Loading the rosters') + '</option>'
        + [G.A, G.H].map(function (t) { return '<optgroup label="' + u.esc(nm(t)) + '">' + sitters.filter(function (p) { return p.team === t; }).map(function (p) { return '<option value="' + u.esc(p.k) + '">' + u.esc(p.name + ' (' + p.tag + ')') + '</option>'; }).join('') + '</optgroup>'; }).join('')
        + '</select>' + (sat.length ? '<div class="sim-sat">' + sat.map(function (k) { return '<button class="sx-chip onyx" data-sim-unsit="' + u.esc(k) + '">' + u.esc(who(k)) + ' sits &times;</button>'; }).join('') + '</div>' : '')
        + '<div class="note">' + note + '</div></div>';
    }
    function knobLabel(key, v) {
      if (key === 'wind') return WIND[v].mph ? WIND[v].mph + (v === 4 ? '+' : '') + ' mph' : 'Calm';
      if (key === 'pace') return PACE_TXT[v];
      return FORM_TXT[v] + (v !== 2 ? ' (' + (v > 2 ? '+' : '') + Math.round(100 * FORM * (v - 2)) + ' hold)' : '');
    }
    function drawKnobs() {
      var head = '<h3 class="sx-h">Change the ' + (KIND === 'tn' ? 'match' : 'game') + '</h3><p class="sx-sub" style="margin-bottom:4px">Every move re-plays all 10,000 ' + unitW + '.</p><div class="sim-kn">', body = '';
      if (KIND === 'fb') {
        var qbs = function (t) { return G.plist.filter(function (p) { return p.team === t && p.role === 'QB'; }); };
        var qbOpt = [G.A, G.H].map(function (t) {
          var q = qbs(t), who = q.length ? q.map(function (p) { return p.name; }).join(', ') : t + ' starter';
          return '<label class="sx-chip' + (K.qb[t] ? ' onyx' : '') + '" style="cursor:pointer"><input type="checkbox" data-sim-qb="' + u.esc(t) + '"' + (K.qb[t] ? ' checked' : '') + ' style="accent-color:#b038f9;margin:0"> ' + u.esc(t) + ': ' + u.esc(who) + ' out</label>';
        }).join(' ');
        var wx = WX[G.gid] || {}, dome = wx.roof === 'dome', fc = wx.wind != null && !dome ? 'Forecast at kickoff: ' + Math.round(wx.wind) + ' mph' + (wx.gust ? ', gusts ' + Math.round(wx.gust) : '') + '. ' : '';
        var sitters = G.plist.filter(function (p) { return p.role !== 'QB' && !K.sit[p.k] && (p.lam != null || G.cont.some(function (c) { return c.pl === p; })); })
          .sort(function (a, b) { return (b.lam || 0) - (a.lam || 0); }).map(function (p) { return {k: p.k, name: p.name, team: p.team, tag: p.role}; });
        body = '<div><div class="sx-k"><span>Starting QB out</span></div><div class="sim-sat">' + qbOpt + '</div><div class="note">' + (SP === 'nfl' ? 'The model\'s deep-backup rule' : 'The NFL model\'s deep-backup rule, borrowed as an estimate') + ': that team -3.4 points, its receivers\' yards x0.86 and catches x0.94. His own props come off.</div></div>'
          + slider('wind', 'Wind', K.wind, dome ? 'Dome' : knobLabel('wind', K.wind), (dome ? 'Closed roof: the wind does not reach this game. ' : u.esc(fc)) + 'Passing and the total come down; rushing does not move. What-if sizes, not a model fit.', dome)
          + slider('pace', 'Pace', K.pace, knobLabel('pace', K.pace), 'Both teams\' scoring and every player\'s volume, up to 10% either way.')
          + sitBox(sitters, 'Sit a player', 'His volume and touchdowns go to the listed teammates in his role (70% of it, at most +50% each; the rest to players without an Onyx line). His props come off.');
      } else if (KIND === 'bb') {
        var bs = (G.roster || []).filter(function (p) { return !K.sit[p.k]; }).map(function (p) { return {k: p.k, name: p.name, team: p.team, tag: Math.round(p.min) + ' min'}; });
        body = slider('pace', 'Pace', K.pace, knobLabel('pace', K.pace), 'Possessions for both teams, up to 4% either way: every score and every player\'s numbers move with it.')
          + sitBox(bs, 'A star sits', SP === 'nba'
            ? 'His minutes go to his teammates in equal shares and each teammate\'s points, rebounds and assists move by his own measured on/off split with that star (the model\'s rules). His team gives back 0.3 points per point he scores (an estimate). His props come off.'
            : 'His team gives back 0.3 points per point he averages: an estimate, since about 70% of a star\'s scoring gets replaced. College lines have no player props here.')
          + '<div><div class="sx-k"><span>Rest</span></div><div class="sim-sat">' + [G.A, G.H].map(function (t) { return tog('b2b', t, K.b2b[t], nm(t) + ' on a back-to-back'); }).join(' ') + '</div><div class="note">That team -1.5 points (an estimate)' + (SP === 'nba' ? ', and its 30+ minute players x0.95, the model\'s own back-to-back minutes rule. If tonight is already a back-to-back, the model has it in.' : '.') + '</div></div>';
      } else if (KIND === 'hk') {
        body = '<div><div class="sx-k"><span>Goalie</span></div><div class="sim-sat">' + [G.A, G.H].map(function (t) { return tog('gk', t, K.gk[t], nm(t) + ' backup in net'); }).join(' ') + '</div><div class="note">A backup saves about .010 less: about 11% more goals against. The sim does not know tonight\'s starter; unchecked is the usual mix the model expects.</div></div>'
          + slider('pace', 'Pace', K.pace, knobLabel('pace', K.pace), 'Both teams\' scoring chances, up to 10% either way.');
      } else {
        body = slider('form.a', nm(G.A) + ' serve form', K.form.a, knobLabel('form', K.form.a), 'Moves ' + u.esc(nm(G.A)) + '\'s hold rate (' + u.pct(G.hA) + ' fitted) up to 6 points either way.')
          + slider('form.h', nm(G.H) + ' serve form', K.form.h, knobLabel('form', K.form.h), 'Moves ' + u.esc(nm(G.H)) + '\'s hold rate (' + u.pct(G.hB) + ' fitted) up to 6 points either way. A what-if: the fitted rates already carry the model\'s read.');
      }
      $('simKnobs').innerHTML = head + body + '</div>';
    }

    function drawDiff() {
      var d = $('simDiff');
      if (!CHG || !PREV) { d.hidden = true; return; }
      var a = PREV, b = RES, items = [], f = function (x) { return Math.round(100 * x); };
      var row = function (lab, x, y) { if (x == null || y == null || f(x) === f(y)) return; items.push('<li>' + u.esc(lab) + ' ' + f(x) + '% &rarr; <span class="' + (y > x ? 'up' : 'dn') + '">' + f(y) + '%</span></li>'); };
      row(nm(G.A) + ' win', a.winA, b.winA); row(nm(G.H) + ' win', a.winH, b.winH);
      if (G.fav) { var id = G.fav.sel || G.fav.label; row(sideTxt(G.fav) + ' covers', a.byId[id] && a.byId[id].p, b.byId[id] && b.byId[id].p); }
      var ov = G.tot.filter(function (r) { return r.side !== 'under'; })[0]; if (ov) { var oi = ov.sel || ov.label; row('Over ' + ov.line, a.byId[oi] && a.byId[oi].p, b.byId[oi] && b.byId[oi].p); }
      var ta = a.avgA + a.avgH, tb = b.avgA + b.avgH, dd = KIND === 'hk' ? 2 : 1; if (Math.abs(ta - tb) >= (KIND === 'hk' ? 0.01 : 0.1)) items.push('<li>Avg total ' + ta.toFixed(dd) + ' &rarr; <span class="' + (tb > ta ? 'up' : 'dn') + '">' + tb.toFixed(dd) + '</span></li>');
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
      if (!sizes.length) { el2.innerHTML = '<h3 class="sx-h">Build my parlay from this sim</h3><p class="sx-sub">No 2-leg combo from this ' + (KIND === 'tn' ? 'match' : 'game') + ' hits together often enough to suggest. Try another one or move a knob.</p>'; el2._legs = []; return; }
      var bestN = sizes.slice().sort(function (a, b) { return B[b].ev - B[a].ev; })[0];
      var n = legsN && B[legsN] ? legsN : bestN, P_ = B[n];
      var sels = P_.legs.map(function (l) { return l.row.sel; });
      el2.innerHTML = '<h3 class="sx-h">Build my parlay from this sim</h3><p class="sx-sub" style="margin-bottom:8px">The legs from this ' + (KIND === 'tn' ? 'match' : 'game') + ' that hit together most often against what Onyx pays. Same-game legs move together, so the joint chance can beat the plain product.</p>'
        + '<div class="sim-seg">' + sizes.map(function (s) { return '<button class="sx-chip' + (s === n ? ' on' : '') + '" data-sim-n="' + s + '">' + s + ' legs</button>'; }).join('') + '</div>'
        + P_.legs.map(function (l) { return '<div class="leg"><span>' + u.esc(l.row.label) + '<small>sim ' + u.pct(l.p) + ' alone</small></span>' + chip(l.row) + '</div>'; }).join('')
        + '<div class="sim-pst"><div>Onyx price<b>' + u.esc(u.odds(u.amer(P_.dec))) + '</b></div><div>Hit together<b class="sx-pur">' + u.pct(P_.joint, 1) + '</b></div>'
        + '<div>If independent<b>' + u.pct(P_.naive, 1) + '</b></div><div>Value / $100<b class="' + (P_.ev > 0 ? 'sx-pos' : 'sx-neg') + '">' + (P_.ev > 0 ? '+$' : '-$') + Math.abs(Math.round(100 * P_.ev)) + '</b></div></div>'
        + '<p class="sx-sub" style="margin:0 0 10px">In ' + Math.round(P_.joint * N).toLocaleString() + ' of 10,000 ' + unitW + ' every leg hit. Onyx\'s price implies ' + u.pct(P_.imp, 1) + '. Correlation lift x' + (P_.joint / Math.max(1e-9, P_.naive)).toFixed(2) + '.</p>'
        + '<div class="sim-pbt"><a class="sx-btn" target="_blank" rel="noopener" data-sim-send="1" href="' + u.esc(href(sels)) + '">Send to Onyx</a>' + (window.OnyxParlay ? '<button class="sx-btn ghost" data-sim-slip="1">Add to slip</button>' : '') + '</div>'
        + '<p class="cap">The model\'s simulation, not an Onyx Pick. Onyx prices same-game legs together, so the ticket price on Onyx can be shorter than the legs multiplied.</p>';
      el2._legs = P_.legs;
    }

    function drawAll() { drawHero(); if (RES) { drawResults(); drawProps(); drawParlay(); drawDiff(); } drawKnobs(); }

    function play(animate, why) {
      if (!G) return;
      clearTimeout(timer);
      var sim = ENG.run(G, K, SEED), before = RES;
      if (!animate) {
        sim.step(N); finish(sim, before, why); return;
      }
      busy = true; drawHero(0); var t0 = Date.now(), DUR = 1100;
      (function frame() {
        var target = Math.min(N, Math.ceil(N * Math.min(1, (Date.now() - t0) / DUR))), from = sim.step(0);
        sim.step(Math.max(250, target - from)); var at = sim.step(0);
        tick(sim, from, at);
        var nEl = $('simN'); if (nEl) nEl.textContent = at.toLocaleString() + ' / 10,000';
        if (at < N) timer = setTimeout(frame, 40); else { busy = false; finish(sim, before, why); }
      })();
    }
    function finish(sim, before, why) {
      RES = sim.done(); LAST = RES;
      if (!knobbed()) {
        if (!BASEP) { BASEP = {}; RES.props.forEach(function (x) { BASEP[x.id] = x.p; }); }
        CHECK = {best: G.best, win: RES.winA, pW: G.pW, tot: RES.avgA + RES.avgH, mu: G.mu.a + G.mu.h};
      }
      PREV = why ? before : null; CHG = why || null;
      drawAll();
      var k = Math.floor(N / 2); tick(sim, k - 7, k);
    }

    function knobbed() {
      var on = function (o) { return Object.keys(o).some(function (k) { return o[k]; }); };
      return K.wind || K.pace !== 2 || on(K.qb) || on(K.sit) || on(K.b2b) || on(K.gk) || K.form.a !== 2 || K.form.h !== 2;
    }
    function setGame(gid, animate) {
      G = ENG.prep(D, gid, u, EXT); BASEP = null; K = freshK(); RES = null; PREV = null; CHG = null; legsN = null; FILTER = 'all'; ALL = false;
      SEED = 20261115 ^ (parseInt(gid, 10) || 7);
      if (('#sim?gid=' + gid) !== location.hash && location.hash.split('?')[0] === '#sim') history.replaceState(null, '', '#sim?gid=' + gid);
      drawPick(); drawAll(); play(animate !== false);
      var on = $('simPick').querySelector('.on'), pk = $('simPick'); if (on) pk.scrollLeft = Math.max(0, on.offsetLeft - pk.offsetLeft - 16);
      // college basketball: who can sit comes from the team cards (minutes and points per game)
      if (SP === 'cbb') {
        var g0 = G;
        Promise.all([D.card(G.A), D.card(G.H)]).then(function (cs) {
          if (G !== g0) return;
          var ro = [];
          cs.forEach(function (c, i) {
            var t = i ? g0.H : g0.A, ps = (c && c.players) || {};
            Object.keys(ps).forEach(function (key) { var p = ps[key]; if (p && p.use && p.proj && p.proj.pts != null) ro.push({k: 'c:' + key, name: p.n, team: t, min: p.use, pts: p.proj.pts}); });
          });
          ro.sort(function (a, b) { return b.min - a.min; });
          g0.roster = ro.filter(function (p, i) { return ro.filter(function (q) { return q.team === p.team; }).indexOf(p) < 6; });
          if (!busy) drawKnobs();
        }).catch(function () {});
      }
    }
    function nameOf(k) { var p = (G.roster || []).filter(function (x) { return x.k === k; })[0] || G.P[k]; return p ? p.name : 'Player'; }

    el.addEventListener('click', function (e) {
      var t = e.target.closest('button, a, input'); if (!t || !el.contains(t) || !G) return;
      if (t.dataset.gid) { if (G.gid !== t.dataset.gid) setGame(t.dataset.gid); return; }
      if (t.id === 'simGo' && !busy) { SEED = (SEED * 1103515245 + 12345) >>> 0; PREV = null; CHG = null; play(true); return; }
      if (t.id === 'simReset') { K = freshK(); play(false, 'knobs reset'); return; }
      if (t.dataset.simF) { FILTER = t.dataset.simF; ALL = false; drawProps(); return; }
      if (t.dataset.simAll) { ALL = !ALL; drawProps(); return; }
      if (t.dataset.simN) { legsN = +t.dataset.simN; drawParlay(); return; }
      if (t.dataset.simUnsit) { K.sit[t.dataset.simUnsit] = false; play(false, nameOf(t.dataset.simUnsit) + ' back in'); return; }
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
      var t = e.target; if (!G) return;
      if (t.dataset.simQb) { K.qb[t.dataset.simQb] = t.checked; play(false, t.dataset.simQb + ' starting QB ' + (t.checked ? 'out' : 'back')); return; }
      if (t.dataset.simTog) {
        var tm = t.dataset.team, ky = t.dataset.simTog; K[ky][tm] = t.checked;
        play(false, nm(tm) + (ky === 'gk' ? (t.checked ? ' backup in net' : ' starter back') : (t.checked ? ' on a back-to-back' : ' rested'))); return;
      }
      if (t.hasAttribute('data-sim-sit') && t.value) { K.sit[t.value] = true; play(false, nameOf(t.value) + ' sits'); return; }
      if (t.dataset.simK) {
        var v = +t.value, key = t.dataset.simK;
        if (key === 'form.a' || key === 'form.h') { K.form[key.slice(5)] = v; play(false, nm(key === 'form.a' ? G.A : G.H) + ' serve ' + FORM_TXT[v].toLowerCase()); return; }
        K[key] = v; play(false, key === 'wind' ? 'wind ' + (WIND[v].mph ? WIND[v].mph + ' mph' : 'calm') : 'pace ' + PACE_TXT[v].toLowerCase());
      }
    });
    el.addEventListener('input', function (e) {   // live label while dragging
      var t = e.target; if (!t.dataset || !t.dataset.simK) return;
      var b = t.closest('label').querySelector('b'), v = +t.value;
      if (b) b.textContent = knobLabel(t.dataset.simK.split('.')[0], v);
    });
    addEventListener('onyx-slip', function () { if (RES && !busy) { try { drawProps(); } catch (x) {} } });

    extras(D).catch(function () { return {}; }).then(function (x) { EXT = x || {}; setGame(pickDefault()); });
    return {show: function () { var w = Studio.param('gid'); if (w && G && w !== G.gid && games.some(function (g) { return g.gid === w; })) setGame(w); }};
  }

  function howHTML() {
    var p = function (s) { return '<p>' + s + '</p>'; }, lead = 'This is a projection, not a prediction and not an Onyx Pick. ';
    if (KIND === 'fb') return p(lead + 'Each game is played 10,000 times in your browser. Team scores center on the model\'s projected team scores (or Onyx\'s total and spread when the model has none) and are counted the real way: touchdowns worth 7 (sometimes 6 or 8), field goals worth 3, a rare safety, overtime when tied. One shared factor speeds up or slows down both offenses together.')
      + p('Every player prop is drawn around the model\'s projection with its spread set so the chance of the side shown matches the model\'s own chance at Onyx\'s line, so the sim mirrors the model rather than adding a new opinion. Where the model has no read on a market, its chance is Onyx\'s own and the sim follows it. Players move with their team: a quarterback\'s yards with his receivers\', a running back\'s with the game script, everyone\'s with the score. Touchdowns are handed out from the team\'s simulated touchdowns in proportion to each player\'s expected touchdowns.')
      + p('Game lines come from the model\'s team scores, which can read stronger than the chance the model lists for them (that one is blended with Onyx\'s price). Starting QB out is the ' + (SP === 'nfl' ? 'model\'s own' : 'NFL model\'s') + ' deep-backup rule (team -3.4 points, receivers\' yards x0.86 and catches x0.94' + (SP === 'nfl' ? '' : '; college football borrows it as an estimate') + '). Wind and pace are what-ifs: the model found passing unders won at 15+ mph and rushing did not move, but the exact sizes here are estimates. Same seed every run, so a knob move shows the knob, not luck.');
    if (KIND === 'bb') return p(lead + 'Each game is played 10,000 times in your browser. A team\'s points are possessions times points per possession: both teams share one possession count (the pace) and each has its own shooting night. They center on the model\'s team scores, or on Onyx\'s total and spread when the model has none, and the spreads are set so the final margin swings about ' + (SP === 'nba' ? '12' : '10.5') + ' points and the total about ' + (SP === 'nba' ? '18.5' : '15.5') + ', what those markets do around their closing lines. Tied games play overtime.')
      + (SP === 'nba' ? p('Every player prop is drawn so the chance of the side shown matches the model\'s own chance at Onyx\'s line. A player\'s points, rebounds and assists share his minutes and move with his team\'s score and the pace; a combo reads the sum of its parts and 3s ride with points. Double and triple-doubles hit at exactly the model\'s chance, one first basket a game goes out in proportion to the board\'s chances, and the first-half and first-quarter totals ride the game total.') : '')
      + p('A star sitting: ' + (SP === 'nba' ? 'his minutes go to his teammates in equal shares and each teammate\'s numbers move by his own measured on/off split with that star (both the model\'s own rules); ' : '') + 'his team gives back 0.3 points per point he scores, an estimate. A back-to-back takes 1.5 points off (an estimate)' + (SP === 'nba' ? ' and trims 30+ minute players by 5%, the model\'s minutes rule' : '') + '. Same seed every run, so a knob move shows the knob, not luck.');
    if (KIND === 'hk') return p(lead + 'Each game is played 10,000 times in your browser. Regulation goals are drawn for each team around the model\'s team goals (or Onyx\'s total split to match the moneyline), with one shared factor for a wide-open or tight night.')
      + p('Simple but honest late-game hockey: a team down one pulls its goalie most of the time and a team down two some of the time; the leader then scores into the empty net half the time and the trailer scores 15% of the time. Tied games go to 3-on-3 overtime, which ends with a goal 60% of the time, then a shootout. The winner\'s final gets one more goal, the way totals and the puck line (1.5 goals) are graded. The goal rates are scaled so the average total still matches the center with all of that included.')
      + p('A backup goalie saves about .010 less, about 11% more goals against. The sim does not know tonight\'s starter. Same seed every run, so a knob move shows the knob, not luck.');
    return p(lead + 'Each match is played 10,000 times in your browser, set by set and game by game. Each player holds serve at a rate fitted exactly (by dynamic programming, before a single match is played) so his chance to win the match equals the model\'s moneyline chance and the average match length equals the model\'s projected games (or Onyx\'s total). Tiebreaks are played point by point.')
      + p('Steady hold rates between two close players cannot make the lopsided 6-2 6-1 days real matches have, so when the projected length is shorter than steady serving gives, each match also gets a match-day swing: one player serves a little better and the other a little worse, sized so the average length lands on the projection. The holds shown are an average day.')
      + p('Best of three; best of five in men\'s Grand Slam draws, with a 10-point tiebreak at 6-6 in a Slam\'s deciding set. The moneyline matches the model by construction, so the game spread and total games are where the sim has something to say: they are what those hold rates imply.')
      + p('Serve form is a what-if: it moves one player\'s hold rate by 3 points a step. Same seed every run, so a knob move shows the knob, not luck.');
  }

  Studio.register('sim', {title: 'Play It Out', order: 2, mount: mount});
})();
