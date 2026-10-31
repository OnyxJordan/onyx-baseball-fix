// verify_ask.js - Ask Onyx against tools/ask_corpus.json on today's boards (dev only).
// Each query passes when the reading matches what the phrase means (sport, market, intent,
// count, side, prices, team, player) AND every play returned honors it AND, when today's boards
// hold anything that fits, the answer is not empty. Prints the pass rate, the failures and timing.
//   node tools/verify_ask.js [--show]          exits 1 below 95%
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const C = JSON.parse(fs.readFileSync(path.join(__dirname, process.argv.includes('--holdout2') ? 'ask_holdout2.json' : process.argv.includes('--holdout') ? 'ask_holdout.json' : 'ask_corpus.json'), 'utf8'));
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.end(b); }); }).listen(0);
(async () => {
  const port = srv.address().port;
  const b = await chromium.launch(); const pg = await b.newPage();
  await pg.route('**/*', rt => rt.request().url().startsWith('http://127.0.0.1:' + port) ? rt.continue() : rt.abort());
  await pg.goto(`http://127.0.0.1:${port}/home.html`, { waitUntil: 'domcontentloaded' });
  const load = await pg.evaluate(async () => { const t = performance.now(); await OnyxAsk.loadBoards(); return performance.now() - t; });
  const res = await pg.evaluate(async (C) => {
    const B = await OnyxAsk.loadBoards(), now = Date.now(), out = [];
    const same = (a, b) => a.length === b.length && a.every(x => b.indexOf(x) >= 0);
    // does today's board hold anything this reading could answer with (sport, market, day, price, side)?
    const avail = (sp, mk, s) => B.some(p => Date.parse(p.start) > now && (!sp || sp.indexOf(p.sport) >= 0)
      && (!mk || mk.some(m => p.mkt === m || p.kind === m || (m === 'two_plus_td' && p.lam != null)))
      && (!s.when || OnyxAsk.whenOk(s.when, p.start)) && (s.min_price == null || p.price >= s.min_price) && (s.max_price == null || p.price <= s.max_price)
      && (!s.side || s.side === 'any' || !(p.kind === 'prop' || p.kind === 'total') || p.side === s.side) && (!s.props_only || p.kind === 'prop'));
    for (const c of C) {
      const t0 = performance.now(); let R;
      try { R = await OnyxAsk.ask(c.q); } catch (e) { out.push({q: c.q, ok: false, why: ['error ' + e.message], ms: 0}); continue; }
      const ms = performance.now() - t0, s = R.spec, e = c.e, why = [];
      if (e.sports && !same(s.sports || [], e.sports)) why.push(`sports ${JSON.stringify(s.sports)} want ${JSON.stringify(e.sports)}`);
      if (e.markets && !same(s.markets || [], e.markets)) why.push(`markets ${JSON.stringify(s.markets)} want ${JSON.stringify(e.markets)}`);
      if (e.intent && s.intent !== e.intent) why.push(`intent ${s.intent} want ${e.intent}`);
      if (e.count != null && s.count !== e.count) why.push(`count ${s.count} want ${e.count}`);
      if (e.side && s.side !== e.side) why.push(`side ${s.side} want ${e.side}`);
      if (e.min_price != null && s.min_price !== e.min_price) why.push(`min_price ${s.min_price} want ${e.min_price}`);
      if (e.max_price != null && s.max_price !== e.max_price) why.push(`max_price ${s.max_price} want ${e.max_price}`);
      if (e.min_conf != null && s.min_conf !== e.min_conf) why.push(`min_conf ${s.min_conf} want ${e.min_conf}`);
      if (e.team && s.team !== e.team) why.push(`team ${s.team} want ${e.team}`);
      if (e.player && s.player !== e.player) why.push(`player ${s.player} want ${e.player}`);
      if (e.props_only && !s.props_only) why.push('props_only not set');
      // every play returned must honor the reading
      const legs = (R.rows || []);
      for (const p of legs) {
        if ((s.sports || []).length && s.sports.indexOf(p.sport) < 0) { why.push(`play from ${p.sport}`); break; }
        const mk = (s.markets || []).slice(); if (mk.indexOf('two_plus_td') >= 0) mk.push('anytime_td');
        if (mk.length && mk.indexOf(p.mkt) < 0 && mk.indexOf(p.kind) < 0) { why.push(`play market ${p.mkt}`); break; }
        if (s.props_only && p.kind !== 'prop') { why.push('game line in a props answer'); break; }
        if (s.side && s.side !== 'any' && (p.kind === 'prop' || p.kind === 'total') && p.side !== s.side) { why.push(`play side ${p.side}`); break; }
        if (!R.two && s.min_price != null && p.price < s.min_price) { why.push(`price ${p.price} under ${s.min_price}`); break; }
        if (!R.two && s.max_price != null && p.price > s.max_price) { why.push(`price ${p.price} over ${s.max_price}`); break; }
        if (Date.parse(p.start) <= now) { why.push('started game'); break; }
        if (s.player && String(p.name || p.label).toLowerCase().indexOf(String(s.player).toLowerCase()) < 0) { why.push(`play not on ${s.player}`); break; }
      }
      // an empty answer is a failure when today's boards have something that fits
      const want = (e.sports || s.sports || []).length ? (e.sports || s.sports) : null, wm = (e.markets || s.markets || []).length ? (e.markets || s.markets) : null;
      const exists = !e.team && !e.player && !s.team && !s.player && avail(want, wm, s);
      if (!legs.length && exists) why.push('empty answer while the board has plays that fit');
      if (s.intent === 'parlay' && legs.length > 1 && R.parlay && R.parlay.price == null) why.push('parlay without a price');
      out.push({q: c.q, ok: !why.length, why, ms: Math.round(ms), n: legs.length, read: R.understood});
    }
    return out;
  }, C);
  const ok = res.filter(r => r.ok).length, ms = res.map(r => r.ms).sort((a, b) => a - b);
  console.log(`boards loaded in ${Math.round(load)} ms; ${res.length} queries, median ${ms[ms.length >> 1]} ms, slowest ${ms[ms.length - 1]} ms`);
  res.filter(r => !r.ok).forEach(r => console.log(`FAIL  ${r.q}\n      ${r.why.join(' | ')}\n      read: ${r.read}`));
  if (process.argv.includes('--slow')) res.slice().sort((a, b) => b.ms - a.ms).slice(0, 8).forEach(r => console.log('slow', r.ms, r.q));
  if (process.argv.includes('--show')) res.filter(r => r.ok).forEach(r => console.log(`ok    ${r.q}  (${r.n}) ${r.read}`));
  const pct = 100 * ok / res.length;
  console.log(`\n${ok}/${res.length} passed: ${pct.toFixed(1)}%`);
  await b.close(); srv.close();
  process.exit(pct >= 95 ? 0 : 1);
})();
