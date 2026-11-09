// verify_live.js - stress test of the Live tab (live.js + home.html's cards) on thousands of
// generated games (dev only). Every sport, every stage of a game, scores near and far, pregame
// lines present and missing, live lines on every market, player props with live box lines.
// Checks, per game:
//   numbers   every chance in (0,1); fair price = our chance as a price; edge = our chance minus the
//             live line's implied chance; bets sorted best first
//   rules     no game-line bet late in a game, no prop bet in the last 8%, no bet we disagree with by
//             more than 12 points, prices inside -500..+500, a scored TD never offered, a fouled-out
//             player never offered
//   models    a bigger home lead never lowers the home chance; a higher total line never raises the
//             over; more points on the home spread never lowers the cover; at the final whistle the
//             leader wins
//   cards     no NaN / undefined / null / Infinity, no em dash, no other book's name, Started / Live
//             line / Our fair present whenever a bet is shown, and a phone-width page with no
//             sideways scroll
//   tennis    (11/3) the point -> game -> set chain: at 0-0 it reproduces the pregame chance, winning
//             the next game never lowers the chance, the games distribution sums to 1, totals and
//             spreads move the right way, best of 3 and 5
//   parity    live_model.py (the live logger) gives the same chances as live.js (to 5e-5, the serve-rate fit's resolution) on a sample
//             of every sport's states; player props too (11/9): propP and the anytime-TD chance on random states,
//             and live_model.prop_bets against live.js bets() on generated games (same bets, same chances), both
//             reading the same data/live/prop_params.json
//   prop gate (11/9) a live prop is called Value only when data/live/props_gate.json passed for the prop params in
//             use: gate off (or passed for another version) -> no Value badge, "Value untested", not in the
//             value sentence or the live record; gate on -> Value badge, the value sentence, in the record
//   pages     (11/3) the Live block on tennis.html and nba.html (the built pages) with a stubbed relay
//             and a live-game fixture (tools/fixtures/live_tennis.json, a real ESPN + relay snapshot;
//             live_nba.json, a game set in play): cards, the value sentence, the untested label, the
//             Onyx link with the referral, no em dash, no book name, no sideways scroll, no page
//             errors, at 390 and 1280px, screenshots to --shots=<dir>
//   node tools/verify_live.js [--n=5000] [--seed=7] [--shots=dir] [--pages=0]
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const N = +arg('n', 5000), SEED = +arg('seed', 7);
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.end(b); }); }).listen(0);
(async () => {
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const b = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; pg.on('pageerror', e => errs.push(String(e)));
  const base = 'http://127.0.0.1:' + srv.address().port;
  await pg.route('**/*', rt => { const u = rt.request().url();
    if (u.startsWith(base + '/ai.json')) return rt.fulfill({ contentType: 'application/json', body: '{"url":""}' });
    return u.startsWith(base) ? rt.continue() : rt.abort(); });
  await pg.goto(base + '/home.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.OnyxLive && typeof lvCard === 'function');
  await pg.evaluate(() => OnyxLive.propFiles());      // data/live/prop_params.json and props_gate.json, as the page loads them
  const res = await pg.evaluate(([N, SEED]) => {
    let x = SEED >>> 0; const R = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = a => a[Math.floor(R() * a.length)], O = OnyxLive;
    const SP = ['nba', 'nfl', 'cfb', 'nhl', 'cbb', 'tennis'];
    const TEAMS = { nba: [['BOS', 'Boston Celtics'], ['LAL', 'Los Angeles Lakers'], ['DEN', 'Denver Nuggets'], ['NY', 'New York Knicks']],
      nfl: [['KC', 'Kansas City Chiefs'], ['DEN', 'Denver Broncos'], ['PHI', 'Philadelphia Eagles'], ['WSH', 'Washington Commanders']],
      cfb: [['UGA', 'Georgia Bulldogs'], ['OSU', 'Ohio State Buckeyes'], ['ORE', 'Oregon Ducks'], ['TEX', 'Texas Longhorns']],
      nhl: [['EDM', 'Edmonton Oilers'], ['NYR', 'New York Rangers'], ['OTT', 'Ottawa Senators'], ['ANA', 'Anaheim Ducks']],
      cbb: [['DUKE', 'Duke Blue Devils'], ['UK', 'Kentucky Wildcats'], ['UNC', 'North Carolina Tar Heels'], ['KU', 'Kansas Jayhawks']],
      tennis: [['Iga Swiatek', 'Iga Swiatek'], ['Coco Gauff', 'Coco Gauff'], ['Jannik Sinner', 'Jannik Sinner'], ['Carlos Alcaraz', 'Carlos Alcaraz']] };
    const TOT = { nba: [205, 245], nfl: [36, 54], cfb: [40, 70], nhl: [5.5, 6.5], cbb: [130, 165] }, LEN = { nba: [4, 12], nfl: [4, 15], cfb: [4, 15], nhl: [3, 20], cbb: [2, 20] };
    const PROPS = { nba: ['pts', 'reb', 'ast', 'threes'], nfl: ['anytime_td', 'rec', 'rec_yds', 'rush_yds', 'pass_yds'], cfb: ['anytime_td', 'rush_yds', 'rec_yds'], nhl: [], cbb: [], tennis: [] };
    const SETS = [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 5], [7, 6]], PAR = [], PROPG = [];
    const PROJ = { pts: [8, 32], reb: [3, 13], ast: [2, 10], threes: [0.8, 4], rec: [2, 8], rec_yds: [20, 95], rush_yds: [15, 110], pass_yds: [180, 300] };
    const FMIN = { nfl: 0.15, cfb: 0.15, nba: 0.15, nhl: 0.15, cbb: 0.15 };
    const BOOKS = /DraftKings|FanDuel|BetMGM|Caesars|Pinnacle|ESPN ?Bet|bet365/i;
    // letter-only names (live.js matches names by their letters, like real box scores)
    const SYL = ['ka', 'lo', 'mi', 'ren', 'to', 'va', 'shi', 'den', 'ro', 'zu'];
    const NAME = n => { let a = '', b = '', k = n; for (let t = 0; t < 4; t++) { a += SYL[k % 10]; k = Math.floor(k / 10); } k = n * 7 + 3; for (let t = 0; t < 3; t++) { b += SYL[k % 10]; k = Math.floor(k / 10); } return a[0].toUpperCase() + a.slice(1) + ' ' + b[0].toUpperCase() + b.slice(1); };
    const am = p => O.american(p), rnd = (a, b) => a + R() * (b - a);
    const fails = [], counts = { games: 0, bets: 0, props: 0, ml: 0, spread: 0, total: 0, value: 0, cards: 0, models: 0 };
    const fail = (g, why) => { if (fails.length < 60) fails.push({ sport: g.sport, f: g.f && +g.f.toFixed(3), hs: g.hs, as: g.as, why }); };
    for (let i = 0; i < N; i++) {
      const sport = pick(SP), T = TEAMS[sport], hi = Math.floor(R() * 4); let ai = Math.floor(R() * 4); if (ai === hi) ai = (ai + 1) % 4;
      const [home, hn] = T[hi], [away, an] = T[ai];
      const havePre = R() < 0.8;
      const g = { sport, gid: 'g' + i, home, away, hn, an, hl: R() < 0.9 ? 'https://a.espncdn.com/x.png' : null, al: null, detail: 'Q', pre: {} };
      if (sport === 'tennis') {
        // a legal score: finished sets (nobody has won yet), the set in play, the server
        const need = R() < 0.2 ? 3 : 2, tour = R() < 0.5 ? 'ATP' : 'WTA', sets = [], w = [0, 0];
        const nf = Math.floor(R() * (2 * need - 1));
        for (let k = 0; k < nf; k++) { const who = R() < 0.5 ? 0 : 1; if (w[who] + 1 >= need) break; w[who]++; const sc = pick(SETS); sets.push(who === 0 ? sc.slice() : [sc[1], sc[0]]); }
        let ga = Math.floor(R() * 7), gb = Math.floor(R() * 7);
        while (O.tn.done(ga, gb)) { ga = Math.floor(R() * 6); gb = Math.floor(R() * 6); }
        if (sets.length === 0 || R() < 0.9) sets.push([ga, gb]); else { ga = 0; gb = 0; }
        const srv = R() < 0.15 ? null : R() < 0.5 ? 0 : 1, st = O.tn.state(sets, srv);
        g.f = null; g.need = need; g.srv = srv; g.state = sets.map(x => x[1] + '-' + x[0]).join(' '); g.hs = st.sa; g.as = st.sb;
        g.pre = havePre ? { home_win: rnd(0.12, 0.88), home_ml: -150, away_ml: 130, margin: rnd(-5, 5), total: Math.round(rnd(19, 26)) + 0.5 } : {};
        g.M = O.model('tennis', { st, need, tour, pre_home_win: g.pre.home_win });
        g.home_win = g.M.win(); g.proj_total = g.M.proj_total; g.fair_spread = home + ' ' + Math.round(-g.M.proj_margin * 2) / 2 + ' games';
        counts.models++;
        const p0 = g.pre.home_win == null ? 0.5 : g.pre.home_win;
        const M0 = O.model('tennis', { st: O.tn.state([]), need, tour, pre_home_win: p0 });
        if (Math.abs(M0.win() - p0) > 0.002) fail(g, 'tennis chain at 0-0 is not the pregame chance: ' + M0.win() + ' vs ' + p0);
        if (Math.abs(g.M.over(-1) - 1) > 1e-6) fail(g, 'tennis games distribution does not sum to 1');
        if (!(g.home_win > 0 && g.home_win < 1)) fail(g, 'tennis chance out of range');
        if (srv != null && sets.length && !O.tn.done(ga, gb) && sets[sets.length - 1][0] === ga && sets[sets.length - 1][1] === gb) {
          const base = sets.slice(0, -1), won = O.model('tennis', { st: O.tn.state(base.concat([[ga + 1, gb]]), 1 - srv), need, tour, pre_home_win: p0 }).win(),
            lost = O.model('tennis', { st: O.tn.state(base.concat([[ga, gb + 1]]), 1 - srv), need, tour, pre_home_win: p0 }).win();
          if (won < lost - 1e-9) fail(g, 'winning the next game lowered the tennis chance');
        }
        const tl = Math.round(g.M.proj_total) + 0.5;
        if (g.M.over(tl + 1) > g.M.over(tl) + 1e-9) fail(g, 'tennis over chance rose with a higher line');
        if (g.M.cover(1.5) < g.M.cover(-1.5) - 1e-9) fail(g, 'tennis cover chance fell with more games');
        if (PAR.length < 400) PAR.push({ sport, sets, srv, need, tour, pre: g.pre.home_win == null ? null : g.pre.home_win, win: g.home_win, cover: g.M.cover(-2.5), over: g.M.over(tl), tl });
      } else {
        const L = LEN[sport], per = 1 + Math.floor(R() * L[0]), clk = Math.floor(R() * L[1] * 60);
        g.f = O.left(sport, per, clk);
        const pt = rnd(TOT[sport][0], TOT[sport][1]), el = 1 - g.f, scale = sport === 'nhl' ? 1 : 1;
        const tot = Math.max(0, Math.round(pt * el * rnd(0.6, 1.4))), mar = Math.round((R() - 0.5) * (sport === 'nhl' ? 4 : sport === 'nba' ? 30 : 24) * Math.sqrt(el) * scale);
        g.hs = Math.max(0, Math.round((tot + mar) / 2)); g.as = Math.max(0, tot - g.hs);
        const hl = Math.round(rnd(-10, 10) * 2) / 2 * (sport === 'nhl' ? 0.15 : 1);
        g.pre = havePre ? { margin: -hl, total: Math.round(pt * 2) / 2, home_win: rnd(0.2, 0.8), home_ml: -140, away_ml: 120,
          spread_txt: home + ' ' + hl, total_txt: String(Math.round(pt * 2) / 2) } : {};
        const sd = { nfl: 13.5, cfb: 16, nba: 12.5 }[sport];
        const pm = g.pre.margin != null ? g.pre.margin : 0;
        g.M = O.model(sport, { hs: g.hs, as: g.as, f: g.f, pre_margin: pm, pre_total: g.pre.total || pt, pre_home_win: g.pre.home_win != null ? g.pre.home_win : 0.5 });
        g.home_win = g.M.win(); g.proj_total = g.M.proj_total; g.fair_spread = home + ' ' + Math.round(-g.M.proj_margin * 2) / 2;
        // the model's shape: a bigger lead never lowers the home chance, a higher line never raises the over
        counts.models++;
        const M2 = O.model(sport, { hs: g.hs + 1, as: g.as, f: g.f, pre_margin: pm, pre_total: g.pre.total || pt, pre_home_win: g.pre.home_win != null ? g.pre.home_win : 0.5 });
        if (M2.win() < g.home_win - 1e-9) fail(g, 'home chance fell with a bigger lead');
        const tl = Math.round(g.M.proj_total) + 0.5;
        if (g.M.over(tl + 1) > g.M.over(tl) + 1e-9) fail(g, 'over chance rose with a higher line');
        if (g.M.cover(1.5) < g.M.cover(-1.5) - 1e-9) fail(g, 'cover chance fell with more points');
        if (PAR.filter(p => p.sport === sport).length < 120) PAR.push({ sport, hs: g.hs, as: g.as, f: g.f, pm, pt: g.pre.total || pt, phw: g.pre.home_win != null ? g.pre.home_win : 0.5,
          win: g.home_win, hl: Math.round(-g.M.proj_margin * 2) / 2 + 0.5, cover: g.M.cover(Math.round(-g.M.proj_margin * 2) / 2 + 0.5), tl, over: g.M.over(tl) });
        const Mend = O.model(sport, { hs: g.hs, as: g.as, f: 0.004, pre_margin: pm, pre_total: g.pre.total || pt, pre_home_win: 0.5 });
        if (Math.abs(g.hs - g.as) >= 3 && Math.abs(Mend.win() - (g.hs > g.as ? 1 : 0)) > 0.02) fail(g, 'a 3+ point leader does not win at the final whistle');
      }
      g.lean = O.lean(g);
      // the live line
      const lines = [];
      const pml = R() < 0.5 ? 1 : 0, hw = Math.min(0.97, Math.max(0.03, g.home_win + (R() - 0.5) * 0.3));
      lines.push({ m: 'ml', sel: hn, price: am(hw) }, { m: 'ml', sel: an, price: am(1 - hw) });
      {
        const ln = Math.round((-g.M.proj_margin + (R() - 0.5) * 6) * 2) / 2 + 0.5;
        lines.push({ m: 'spread', sel: hn, pt: ln, price: pick([-125, -115, -110, -105, 100]) }, { m: 'spread', sel: an, pt: -ln, price: pick([-115, -110, -105]) });
        const tl = Math.floor(g.M.proj_total + (R() - 0.5) * (sport === 'nhl' || sport === 'tennis' ? 2 : 12)) + 0.5;
        lines.push({ m: 'total', sel: 'Over ' + tl, side: 'over', pt: tl, price: pick([-125, -110, 100, 120]) }, { m: 'total', sel: 'Under ' + tl, side: 'under', pt: tl, price: pick([-125, -110, -105]) });
      }
      // player props, pregame captures and the live box
      const pp = {}, bx = {};
      (PROPS[sport] || []).forEach((m, k) => {
        for (let j = 0; j < 2; j++) {
          const nm = NAME(i * 10 + k * 2 + j), key = nm.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
          if (m === 'anytime_td') {
            const lam = rnd(0.15, 0.9);
            pp[nm + '|' + m] = { l: 0.5, lam, o: am(1 - Math.exp(-lam)) };
            const scored = R() < 0.2; bx[key] = { td: scored ? 1 : 0 };
            const price = am(Math.min(0.9, Math.max(0.05, (1 - Math.exp(-lam * (g.f || 0.5))) * rnd(0.7, 1.3))));
            lines.push({ m, sel: nm, price, _scored: scored });
          } else {
            const [a, z] = PROJ[m], j0 = rnd(a, z), l0 = Math.floor(j0 * rnd(0.85, 1.15)) + 0.5;
            pp[nm + '|' + m] = { l: l0, j: j0, o: -110, u: -110 };
            const cur = Math.max(0, Math.round(j0 * (1 - (g.f || 0.5)) * rnd(0.3, 1.7))), fouls = sport === 'nba' && R() < 0.05 ? 6 : 2;
            bx[key] = { [m]: cur, fouls };
            const ll = Math.floor(cur + j0 * (g.f || 0.5) * rnd(0.8, 1.2)) + 0.5;
            lines.push({ m, sel: nm, side: 'over', pt: ll, price: -115, _fo: fouls >= 6 }, { m, sel: nm, side: 'under', pt: ll, price: -115, _fo: fouls >= 6 });
          }
        }
      });
      g.pre.pp = sport === 'tennis' ? null : pp;
      let B;
      try { B = O.bets(g, { lines }, bx); } catch (e) { fail(g, 'bets threw ' + e.message); continue; }
      g.bets = B; counts.games++;
      if (sport !== 'tennis' && g.f != null && PROPG.length < 600)
        PROPG.push({ sport, f: g.f, pp, bx, lines: lines.filter(l => !/^(ml|spread|total)$/.test(l.m)).map(l => ({ m: l.m, sel: l.sel, side: l.side == null ? null : l.side, pt: l.pt == null ? null : l.pt, price: l.price })),
          out: B.filter(b => b.kind === 'prop').map(b => ({ player: b.player, mkt: b.mkt, side: b.side, line: b.line == null ? null : b.line, price: b.price, p: b.p, edge: b.edge })) });
      // numbers and rules
      B.forEach((bt, k) => {
        counts.bets++; counts[bt.kind === 'prop' ? 'props' : bt.kind]++;
        if (bt.edge >= 0.03) counts.value++;
        if (!(bt.p > 0 && bt.p < 1)) fail(g, 'chance out of range ' + bt.p);
        if (bt.fair !== O.american(bt.p)) fail(g, 'fair price is not our chance');
        if (Math.abs(bt.edge - (bt.p - O.implied(bt.price))) > 0.0011) fail(g, 'edge is not our chance minus the implied');
        // best first: bets that can post come first (tennis needs 60%+ to hit, 11/4), then by edge
        const okv = x => O.isVal ? O.isVal(x) : x.edge >= O.VALUE;
        if (k && (okv(B[k - 1]) - okv(bt) || (g.sport === 'tennis' ? B[k - 1].p - bt.p : 0) || B[k - 1].edge - bt.edge) < 0) fail(g, 'bets not sorted best first');
        if (g.sport === 'tennis' && bt.ok !== (bt.p >= O.TN_CONF)) fail(g, 'tennis confidence flag wrong');
        if (g.sport === 'tennis' && O.isVal && O.isVal(bt) && bt.p < O.TN_CONF) fail(g, 'tennis pick under 60% to hit');
        if (bt.price < -500 || bt.price > 500) fail(g, 'price outside -500..+500');
        if (bt.edge > 0.12) fail(g, 'a 12+ point disagreement was offered');
        if (g.f != null && bt.kind !== 'prop' && g.f < FMIN[sport]) fail(g, 'game-line bet late in the game');
        if (g.f != null && bt.kind === 'prop' && g.f < 0.08) fail(g, 'prop bet in the last 8%');
        const src = lines.find(l => l.sel === bt.player && l.m === bt.mkt);
        if (bt.mkt === 'anytime_td' && src && src._scored) fail(g, 'offered a TD that was already scored');
        if (src && src._fo) fail(g, 'offered a fouled-out player');
      });
      // the card
      let html;
      try { html = lvCard(g); } catch (e) { fail(g, 'card threw ' + e.message); continue; }
      counts.cards++;
      const text = html.replace(/<[^>]+>/g, ' ');
      if (/\bNaN\b|\bundefined\b|\bInfinity\b|>null<|\snull\s/.test(text)) fail(g, 'card shows NaN/undefined/null: ' + (text.match(/.{0,40}(NaN|undefined|Infinity|null).{0,20}/) || [''])[0]);
      if (/—/.test(html)) fail(g, 'em dash on the card');
      if (BOOKS.test(text)) fail(g, 'another book named on the card');
      if (B.length && B[0].edge > -0.05 && !(/Started/.test(text) && /Live line/.test(text) && /Our fair/.test(text))) fail(g, 'bet shown without Started / Live line / Our fair');
      if (i < 400) { if (!window.__keep) window.__keep = []; window.__keep.push(g); }
    }
    // propP and the anytime-TD chance on random states, for the Python parity check
    const PROPP = [];
    for (let k = 0; k < 600; k++) {
      const mkt = pick(['pts', 'reb', 'ast', 'threes', 'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'blk']), [a, z] = PROJ[mkt] || [1, 4], proj = rnd(a, z), f = rnd(0.004, 1);
      const cur = Math.round(proj * (1 - f) * rnd(0, 2)), line = Math.floor(cur + proj * f * rnd(0.5, 1.5)) + 0.5, lam = rnd(0.05, 1.2);
      PROPP.push({ mkt, cur, proj, f, line, p: O.propP(mkt, cur, proj, f, line), lam, td: 1 - Math.exp(-lam * f) });
    }
    // the prop gate, both ways: a live prop whose price would be value (edge about 6 points)
    const GATE = [], gate0 = O.propsGate(), V = O.propVersion();
    {
      const nm = 'Kalo Renmi', mkt = 'pts', proj = 24, f = 0.5, cur = 12, line = 20.5, pv = O.propP(mkt, cur, proj, f, line);
      const M = O.model('nba', { hs: 60, as: 58, f, pre_margin: 2, pre_total: 228, pre_home_win: 0.55 });
      const g = { sport: 'nba', gid: 'gate1', home: 'BOS', away: 'NY', hn: 'Boston Celtics', an: 'New York Knicks', hl: null, al: null, detail: 'Q3 0:00', f, hs: 60, as: 58,
        pre: { pp: { [nm + '|' + mkt]: { l: 22.5, j: proj, o: -110, u: -110 } } }, M, home_win: M.win(), proj_total: M.proj_total, fair_spread: 'BOS -2' };
      const lines = { lines: [{ m: mkt, sel: nm, side: 'over', pt: line, price: O.american(pv - 0.06) }] }, bx = { 'kalo renmi': { pts: cur, fouls: 2 } };
      const rec = [{ id: 'x', sport: 'nba', gid: 'gate1', kind: 'prop', result: 'W', price: 100, logged_at: '2026-11-09T00:00:00+00:00' }];
      for (const [name, G, want] of [['gate not passed', { passed: false, version: V }, false], ['gate passed', { passed: true, version: V }, true], ['gate passed for another version', { passed: true, version: V + '-old' }, false]]) {
        O.setPropsGate(G);
        const B = O.bets(g, lines, bx); g.bets = B;
        const b = B[0], card = O.card(g), blk = O.block('nba', [g]), r = O.record(rec, 'all');
        const bad = why => GATE.push(name + ': ' + why);
        if (!b || b.kind !== 'prop' || !(b.edge >= O.VALUE)) { bad('test prop not priced at value (' + JSON.stringify(b) + ')'); continue; }
        if (O.isVal(b) !== want) bad('isVal ' + O.isVal(b));
        if (want) {
          if (!/Value \+\d+%/.test(card)) bad('no Value badge on the card');
          if (/Value untested/.test(card)) bad('"Value untested" on a passed prop');
          if (!/Value right now: /.test(blk)) bad('no value sentence in the block');
          if (r.n !== 1) bad('prop row not in the live record');
        } else {
          if (/Value \+\d+%/.test(card)) bad('Value badge on an untested prop');
          if (!/Value untested/.test(card)) bad('card does not say "Value untested"');
          if (/Live value &middot;/.test(card)) bad('card calls the untested prop live value');
          if (!/Our fair/.test(card) || !/to hit/.test(card)) bad('untested prop card lacks our chance and fair price');
          if (/Value right now: /.test(blk)) bad('value sentence for an untested prop');
          if (!/Value untested/.test(blk)) bad('block does not say "Value untested"');
          if (r.n !== 0) bad('untested prop row counted in the live record');
        }
        if (/—/.test(card + blk)) bad('em dash');
      }
      O.setPropsGate(gate0);
    }
    // a real page of cards at phone width
    LV.games = lvSort(window.__keep); LV.sport = 'all'; lvRender();
    const over = document.documentElement.scrollWidth > innerWidth;
    return { counts, fails, over, rendered: document.querySelectorAll('#lvList .lv-card').length, par: PAR, propg: PROPG, propp: PROPP, gate: GATE,
             params: { version: O.propVersion(), PVAR: O.PVAR, PK: O.PK, YSD: O.YSD, gate: O.propsGate() } };
  }, [N, SEED]);
  // parity: live_model.py (the live logger) against live.js on the same states
  const py = require('child_process').spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
import live_model as LM
bad, n = [], 0
for p in json.load(sys.stdin):
    if p['sport'] == 'tennis':
        M = LM.Tennis(p['pre'], p['need'], LM.tn_state([tuple(x) for x in p['sets']], p['srv']), p['tour'])
        got = (M.win(), M.cover(-2.5), M.over(p['tl']))
        want = (p['win'], p['cover'], p['over'])
    else:
        g = {'hs': p['hs'], 'as': p['as'], 'f': p['f'], 'pre_margin': p['pm'], 'pre_total': p['pt'], 'pre_home_win': p['phw']}
        M = LM.Hockey(g) if p['sport'] == 'nhl' else LM.Normal(p['sport'], g)
        got = (M.win(), M.cover(p['hl']), M.over(p['tl']))
        want = (p['win'], p['cover'], p['over'])
    n += 1
    if max(abs(a - b) for a, b in zip(got, want)) > 5e-5:   # the serve-rate bisection's resolution (a tie at exactly 50% can split either way)
        bad.append({'sport': p['sport'], 'js': want, 'py': got, 'in': {k: v for k, v in p.items() if k not in ('win', 'cover', 'over')}})
print(json.dumps({'n': n, 'bad': bad[:5], 'nbad': len(bad)}))
`], { input: JSON.stringify(res.par), encoding: 'utf8' });
  let par = { n: 0, nbad: 1, bad: [py.stderr] };
  try { par = JSON.parse(py.stdout); } catch (e) {}
  console.log(`parity live_model.py vs live.js: ${par.n} states, ${par.nbad} differ by more than 5e-5`);
  par.bad.forEach(x => console.log('FAIL parity', JSON.stringify(x)));
  // prop parity: live_model.py's prop pricing (live_log.py's prop logging) against live.js
  const py2 = require('child_process').spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(root)})
import live_model as LM
D = json.load(sys.stdin)
bad, n = [], 0
P = D['params']
for k in ('PVAR', 'PK'):
    if {a: float(b) for a, b in P[k].items()} != {a: float(b) for a, b in getattr(LM, k).items()}:
        bad.append({'params': k, 'js': P[k], 'py': getattr(LM, k)})
if {a: [float(x) for x in b] for a, b in P['YSD'].items()} != {a: [float(x) for x in b] for a, b in LM.YSD.items()} or P['version'] != LM.PROP_VERSION:
    bad.append({'params': 'YSD/version', 'js': [P['YSD'], P['version']], 'py': [LM.YSD, LM.PROP_VERSION]})
for s in D['propp']:
    n += 1
    a, b = LM.prop_p(s['mkt'], s['cur'], s['proj'], s['f'], s['line']), LM.td_p(s['lam'], s['f'])
    if abs(a - s['p']) > 5e-5 or abs(b - s['td']) > 1e-9:
        bad.append({'propP': s, 'py': [a, b]})
edge = lambda o: abs(o['p'] - 0.03) < 1e-4 or abs(o['p'] - 0.97) < 1e-4 or abs(o['edge'] - 0.12) < 0.0015
ng = nb = 0
for g in D['propg']:
    ng += 1
    py = LM.prop_bets(g['sport'], g['f'], g['lines'], g['pp'], g['bx'])
    key = lambda o: (o['player'], o['mkt'], o['side'], o.get('line', o.get('pt')), o['price'])
    J, Y = {key(o): o for o in g['out']}, {key(o): o for o in py}
    for k in set(J) | set(Y):
        nb += 1
        j, y = J.get(k), Y.get(k)
        if j and y:
            if abs(j['p'] - y['p']) > 5e-5 or abs(j['edge'] - y['edge']) > 0.0011:
                bad.append({'bet': k, 'js': j, 'py': y})
        elif not edge(j or y):
            bad.append({'bet': k, 'only_in': 'js' if j else 'py', 'row': j or y})
print(json.dumps({'n': n, 'games': ng, 'bets': nb, 'bad': bad[:5], 'nbad': len(bad)}))
`], { input: JSON.stringify({ params: res.params, propp: res.propp, propg: res.propg }), encoding: 'utf8' });
  let par2 = { n: 0, nbad: 1, bad: [py2.stderr] };
  try { par2 = JSON.parse(py2.stdout); } catch (e) {}
  console.log(`prop parity live_model.py vs live.js (params ${res.params.version}): ${par2.n} propP / TD states, ${par2.bets} prop bets on ${par2.games} games, ${par2.nbad} differ`);
  par2.bad.forEach(x => console.log('FAIL prop parity', JSON.stringify(x)));
  console.log(`prop gate (props_gate.json: ${res.params.gate.passed ? 'passed' : 'not passed'}, version ${res.params.gate.version || '-'}): checked both ways, ${res.gate.length} failures`);
  res.gate.forEach(x => console.log('FAIL prop gate', x));
  // the Live block on the built pages, a stubbed relay and a live-game fixture
  const pageFails = [];
  if (arg('pages', '1') !== '0') {
    const FX = { tennis: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live_tennis.json'), 'utf8')),
                 nba: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live_nba.json'), 'utf8')) };
    const shots = arg('shots', '');
    for (const [pageName, sport] of [['tennis.html', 'tennis'], ['nba.html', 'nba']]) {
      for (const w of [390, 1280]) {
        const p2 = await b.newPage({ viewport: { width: w, height: 900 } });
        const e2 = []; p2.on('pageerror', e => e2.push(String(e)));
        await p2.route('**/*', rt => { const u = rt.request().url();
          if (u.startsWith(base + '/ai.json')) return rt.fulfill({ contentType: 'application/json', body: '{"url":"http://relay.stub"}' });
          if (u.startsWith('http://relay.stub/live')) { const sp = new URL(u).searchParams.get('sport');
            return rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(FX[sp] ? FX[sp].relay : { games: [] }) }); }
          const m = /espn\.com\/apis\/site\/v2\/sports\/(tennis\/(atp|wta)|basketball\/nba)\/scoreboard/.exec(u);
          if (m) return rt.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(m[2] ? FX.tennis[m[2]] : { leagues: FX.nba.leagues, events: FX.nba.events }) });
          return u.startsWith(base) ? rt.continue() : rt.abort(); });
        await p2.goto(base + '/' + pageName + '#home', { waitUntil: 'domcontentloaded' });
        const ok = await p2.waitForFunction(() => document.querySelector('#oxLiveHome .lv-card'), null, { timeout: 20000 }).then(() => true, () => false);
        const r = await p2.evaluate(() => {
          const el = document.getElementById('oxLiveHome'), t = el ? el.innerText : '';
          const links = [...(el ? el.querySelectorAll('a') : [])].map(a => a.href);
          return { text: t, html: el ? el.innerHTML : '', cards: el ? el.querySelectorAll('.lv-card').length : 0, val: el ? el.querySelectorAll('.lvb-v:not(.none)').length : 0,
                   onyx: links.filter(h => /app\.onyxodds\.com/.test(h) && /KR680261/.test(h)).length, over: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        const tag = `${pageName} ${w}px`;
        const bad = x => pageFails.push(`${tag}: ${x}`);
        if (!ok) bad('no live card in the Home Live block');
        if (!/untested against live prices/.test(r.text)) bad('missing the untested label');
        if (!/Value right now|No live value right now/.test(r.text)) bad('no value line');
        if (r.val && !/Our chance \d+%, the live line says \d+%: [+-]?\d+ points?\./.test(r.text)) bad('value sentence not worded "Our chance X%, the live line says Y%: +Z points."');
        if (!r.onyx) bad('no Onyx link with the referral');
        if (/—/.test(r.html)) bad('em dash in the block');
        if (/\b(NaN|undefined|Infinity)\b/.test(r.text)) bad('NaN / undefined in the block');
        if (/DraftKings|FanDuel|BetMGM|Caesars|Pinnacle|bet365/i.test(r.text)) bad('a book named in the block');
        if (r.over) bad('sideways scroll');
        // the Games tab carries the same block
        await p2.evaluate(() => gotoTab('games'));
        const gOk = await p2.waitForFunction(() => document.querySelector('#oxLiveGames .lv-card'), null, { timeout: 8000 }).then(() => true, () => false);
        if (!gOk) bad('no live card on the Games tab');
        // owner report 11/3: "Open the game" did nothing on tennis. Clicking it on the page's own Live block
        // must open that game in place (tennis: its match center; others: the gamecenter) without leaving the page
        {
          await p2.evaluate(() => gotoTab('home'));
          const before = p2.url();
          const lk = await p2.$('#oxLiveHome .lv-card a[data-lv-open]');
          if (!lk) bad('no Open the game link on a live card');
          else {
            await lk.click(); await p2.waitForTimeout(700);
            const o = await p2.evaluate(sp => ({ url: location.href, tab: typeof currentTab !== 'undefined' ? currentTab : (document.querySelector('.tab.active, [data-tab].on') || {}).dataset,
              open: sp === 'tennis' ? (typeof OPEN_MATCH !== 'undefined' && OPEN_MATCH) : (typeof gcSel !== 'undefined' && gcSel),
              gc: !!document.querySelector(sp === 'tennis' ? '#gc' : '#pane-games .gc, #pane-games [class*=gc]') }), sport);
            // nba: when the fixture's game is not on the built page's slate (an off night), the honest fallback is the Games tab
            const onSlate = sport !== 'nba' || await p2.evaluate(() => { const l = document.querySelector('#oxLiveHome .lv-card a[data-lv-open]');
              return !!nbaGid(l.getAttribute('data-lv-open'), l.getAttribute('data-lv-a'), l.getAttribute('data-lv-h')); });
            if (!onSlate) { const tb = await p2.evaluate(() => typeof currentTab !== 'undefined' ? currentTab : ''); if (tb !== 'games') bad('Open the game (game not on the slate) did not fall back to the Games tab'); else console.log(`${tag}: Open the game: game not on this slate, opened the Games tab`); }
            else if (!o.open) bad('Open the game did not open the game');
            else if (o.url.split('#')[0] !== before.split('#')[0]) bad('Open the game left the page');
            else console.log(`${tag}: Open the game opened ${o.open}`);
          }
        }
        if (e2.length) bad('page errors: ' + e2.slice(0, 3).join(' | '));
        console.log(`${tag}: ${r.cards} live cards, ${r.val} value lines, Onyx links ${r.onyx}, sideways scroll ${r.over}`);
        // tennis match center (owner report 11/3, Linette vs Falei): win chance after every game, labels inside
        // the plot and clear of the dots, the card's font, the set-score grid with headers
        if (sport === 'tennis') {
          const id = await p2.evaluate(() => { const ids = ['186587'].concat((SD.events || []).flatMap(e => e.matches.filter(m => m.state === 'in').map(m => m.id)));
            for (const i of ids) if ((SD.events || []).some(e => e.matches.some(m => m.id === i && m.state === 'in'))) return i; return null; });
          if (!id) bad('no live fixture match on the tennis slate');
          else {
            await p2.evaluate(i => openMatch(i), id);
            await p2.waitForSelector('#gc .tc-chart', { timeout: 8000 }).catch(() => bad('match center chart missing'));
            const c = await p2.evaluate(() => {
              const svg = document.querySelector('#gc .tc-chart'); if (!svg) return null;
              const R = svg.getBoundingClientRect(), pts = JSON.parse(svg.dataset.pts);
              const txt = [...svg.querySelectorAll('text')].map(t => { const b = t.getBoundingClientRect(); return { t: t.textContent, l: b.left, r: b.right, tp: b.top, bt: b.bottom }; });
              const outside = txt.filter(b => b.l < R.left - 0.5 || b.r > R.right + 0.5 || b.tp < R.top - 0.5 || b.bt > R.bottom + 0.5).map(b => b.t);
              const nowT = svg.querySelector('.tc-now').getBoundingClientRect(), dots = [...svg.querySelectorAll('circle')].map(d => d.getBoundingClientRect());
              const hit = dots.filter(d => !(d.right < nowT.left || d.left > nowT.right || d.bottom < nowT.top || d.top > nowT.bottom)).length;
              const games = (window.SD.events || []).flatMap(e => e.matches).find(m => m.id === OPEN_MATCH).p.reduce((a, p) => a + p.sets.reduce((x, y) => x + y, 0), 0) / 1;
              const ff = getComputedStyle(svg.querySelector('.tc-ax')).fontFamily, cf = getComputedStyle(document.querySelector('#gc')).fontFamily;
              return { n: pts.length, games, outside, hit, ff, cf, head: !!document.querySelector('#gc .mc-h'), heads: [...document.querySelectorAll('#gc .mc-h .mc-sets span')].map(x => x.textContent) };
            });
            if (c) {
              if (c.n < c.games + 1) bad(`chart has ${c.n} points for ${c.games} games`);
              if (c.outside.length) bad('chart labels outside the plot: ' + c.outside.join(', '));
              if (c.hit) bad('the Now label overlaps a dot');
              if (c.ff !== c.cf) bad(`chart font ${c.ff} is not the card font ${c.cf}`);
              if (!c.head) bad('set-score grid has no header');
              console.log(`${tag} match center ${id}: ${c.n} chart points for ${c.games} games, set columns ${c.heads.join(' ')}`);
              if (shots) { const gc = await p2.$('#gc'); fs.mkdirSync(shots, { recursive: true }); if (gc) await gc.screenshot({ path: path.join(shots, `tennis_match_${w}.png`) }); }
            }
          }
        }
        if (shots) { fs.mkdirSync(shots, { recursive: true }); await p2.evaluate(() => gotoTab('home'));
          await p2.waitForTimeout(400);
          const h = await p2.$('#oxLiveHome'); if (h) await h.screenshot({ path: path.join(shots, `${sport}_live_${w}.png`) }); }
        await p2.close();
      }
    }
    pageFails.forEach(f => console.log('FAIL', f));
  }
  const c = res.counts;
  console.log(`${c.games} games, ${c.bets} bets priced (${c.ml} moneyline, ${c.spread} spread, ${c.total} total, ${c.props} player props), ${c.value} marked Value`);
  console.log(`${c.models} model shape checks, ${c.cards} cards rendered as text, ${res.rendered} rendered on a 390px page (sideways scroll: ${res.over})`);
  if (errs.length) console.log('page errors:', errs.slice(0, 5));
  res.fails.forEach(f => console.log('FAIL', JSON.stringify(f)));
  const bad = res.fails.length + errs.length + (res.over ? 1 : 0) + par.nbad + par2.nbad + res.gate.length + pageFails.length;
  console.log(bad ? `\n${bad} failures` : '\nALL CHECKS PASSED');
  await b.close(); srv.close();
  process.exit(bad ? 1 : 0);
})();
