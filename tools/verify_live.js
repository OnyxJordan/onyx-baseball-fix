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
//   node tools/verify_live.js [--n=5000] [--seed=7]
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
  const res = await pg.evaluate(([N, SEED]) => {
    let x = SEED >>> 0; const R = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = a => a[Math.floor(R() * a.length)], O = OnyxLive;
    const SP = ['nba', 'nfl', 'cfb', 'nhl', 'tennis'];
    const TEAMS = { nba: [['BOS', 'Boston Celtics'], ['LAL', 'Los Angeles Lakers'], ['DEN', 'Denver Nuggets'], ['NY', 'New York Knicks']],
      nfl: [['KC', 'Kansas City Chiefs'], ['DEN', 'Denver Broncos'], ['PHI', 'Philadelphia Eagles'], ['WSH', 'Washington Commanders']],
      cfb: [['UGA', 'Georgia Bulldogs'], ['OSU', 'Ohio State Buckeyes'], ['ORE', 'Oregon Ducks'], ['TEX', 'Texas Longhorns']],
      nhl: [['EDM', 'Edmonton Oilers'], ['NYR', 'New York Rangers'], ['OTT', 'Ottawa Senators'], ['ANA', 'Anaheim Ducks']],
      tennis: [['Iga Swiatek', 'Iga Swiatek'], ['Coco Gauff', 'Coco Gauff'], ['Jannik Sinner', 'Jannik Sinner'], ['Carlos Alcaraz', 'Carlos Alcaraz']] };
    const TOT = { nba: [205, 245], nfl: [36, 54], cfb: [40, 70], nhl: [5.5, 6.5] }, LEN = { nba: [4, 12], nfl: [4, 15], cfb: [4, 15], nhl: [3, 20] };
    const PROPS = { nba: ['pts', 'reb', 'ast', 'threes'], nfl: ['anytime_td', 'rec', 'rec_yds', 'rush_yds', 'pass_yds'], cfb: ['anytime_td', 'rush_yds', 'rec_yds'], nhl: [], tennis: [] };
    const PROJ = { pts: [8, 32], reb: [3, 13], ast: [2, 10], threes: [0.8, 4], rec: [2, 8], rec_yds: [20, 95], rush_yds: [15, 110], pass_yds: [180, 300] };
    const FMIN = { nfl: 0.15, cfb: 0.15, nba: 0.15, nhl: 0.15 };
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
        g.hs = Math.floor(R() * 2); g.as = Math.floor(R() * 2); g.state = '6-4 3-6'; g.f = null;
        g.pre = havePre ? { home_win: rnd(0.15, 0.85), home_ml: -150, away_ml: 130 } : {};
        g.M = O.model('tennis', { hs: g.hs, as: g.as, best: 3, pre_home_win: g.pre.home_win });
        g.home_win = g.M.win();
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
        const Mend = O.model(sport, { hs: g.hs, as: g.as, f: 0.004, pre_margin: pm, pre_total: g.pre.total || pt, pre_home_win: 0.5 });
        if (Math.abs(g.hs - g.as) >= 3 && Math.abs(Mend.win() - (g.hs > g.as ? 1 : 0)) > 0.02) fail(g, 'a 3+ point leader does not win at the final whistle');
      }
      g.lean = O.lean(g);
      // the live line
      const lines = [];
      const pml = R() < 0.5 ? 1 : 0, hw = Math.min(0.97, Math.max(0.03, g.home_win + (R() - 0.5) * 0.3));
      lines.push({ m: 'ml', sel: hn, price: am(hw) }, { m: 'ml', sel: an, price: am(1 - hw) });
      if (sport !== 'tennis') {
        const ln = Math.round((-g.M.proj_margin + (R() - 0.5) * 6) * 2) / 2 + 0.5;
        lines.push({ m: 'spread', sel: hn, pt: ln, price: pick([-125, -115, -110, -105, 100]) }, { m: 'spread', sel: an, pt: -ln, price: pick([-115, -110, -105]) });
        const tl = Math.floor(g.M.proj_total + (R() - 0.5) * (sport === 'nhl' ? 2 : 12)) + 0.5;
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
      // numbers and rules
      B.forEach((bt, k) => {
        counts.bets++; counts[bt.kind === 'prop' ? 'props' : bt.kind]++;
        if (bt.edge >= 0.03) counts.value++;
        if (!(bt.p > 0 && bt.p < 1)) fail(g, 'chance out of range ' + bt.p);
        if (bt.fair !== O.american(bt.p)) fail(g, 'fair price is not our chance');
        if (Math.abs(bt.edge - (bt.p - O.implied(bt.price))) > 0.0011) fail(g, 'edge is not our chance minus the implied');
        if (k && B[k - 1].edge < bt.edge) fail(g, 'bets not sorted best first');
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
    // a real page of cards at phone width
    LV.games = lvSort(window.__keep); LV.sport = 'all'; lvRender();
    const over = document.documentElement.scrollWidth > innerWidth;
    return { counts, fails, over, rendered: document.querySelectorAll('#lvList .lv-card').length };
  }, [N, SEED]);
  const c = res.counts;
  console.log(`${c.games} games, ${c.bets} bets priced (${c.ml} moneyline, ${c.spread} spread, ${c.total} total, ${c.props} player props), ${c.value} marked Value`);
  console.log(`${c.models} model shape checks, ${c.cards} cards rendered as text, ${res.rendered} rendered on a 390px page (sideways scroll: ${res.over})`);
  if (errs.length) console.log('page errors:', errs.slice(0, 5));
  res.fails.forEach(f => console.log('FAIL', JSON.stringify(f)));
  const bad = res.fails.length + errs.length + (res.over ? 1 : 0);
  console.log(bad ? `\n${res.fails.length} failures` : '\nALL CHECKS PASSED');
  await b.close(); srv.close();
  process.exit(bad ? 1 : 0);
})();
