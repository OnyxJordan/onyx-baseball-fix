// verify_studio.js - Onyx NFL Studio gate (studio.html, 11/15). Opens every tab at phone (390) and desktop (1280)
// widths, off-origin requests aborted, and fails on: a page error, a tab that renders nothing or an error box, a
// sideways scroll, or a tool's own self-check (window.Studio.checks[key](), optional, returns '' when fine).
//   node tools/verify_studio.js [tab ...]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } if (p.endsWith('.js')) r.setHeader('content-type', 'text/javascript'); r.end(b); }); }).listen(0);
(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch(), out = [];
  const args = process.argv.slice(2), sp = args.find(a => a.startsWith('--sport='));
  const only = args.filter(a => !a.startsWith('--'));
  // every sport's Studio (11/16): studio.html?sport=<k>; --sport=nba,cfb to narrow
  const SPORTS = sp ? sp.slice(8).split(',') : ['nfl', 'nba', 'cfb', 'cbb', 'nhl', 'tennis'];
  for (const sport of SPORTS) for (const w of [390, 1280]) {
    const pg = await b.newPage({viewport: {width: w, height: 900}}), errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console: ' + m.text()); });
    await pg.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith(base + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'}); return u.startsWith(base) ? rt.continue() : rt.abort(); });
    await pg.goto(base + '/studio.html?sport=' + sport, {waitUntil: 'domcontentloaded'});
    await pg.waitForFunction(() => document.querySelectorAll('.st-tab').length > 0, null, {timeout: 15000}).catch(() => {});
    const keys = await pg.evaluate(() => Array.from(document.querySelectorAll('.st-tab')).map(b => b.dataset.k));
    if (!keys.length) out.push(`FAIL ${sport} ${w}: no tabs registered`);
    for (const k of keys) {
      if (only.length && !only.includes(k)) continue;
      const n0 = errs.length;
      await pg.evaluate(k => Studio.show(k), k);
      await pg.waitForTimeout(2500);
      const r = await pg.evaluate(k => {
        const el = document.getElementById('st-' + k);
        const txt = (el && el.innerText || '').trim();
        const chk = window.Studio.checks && window.Studio.checks[k] ? window.Studio.checks[k]() : '';
        return {len: txt.length, err: !!(el && el.querySelector('.st-err')), errTxt: el && el.querySelector('.st-err') ? el.querySelector('.st-err').innerText : '',
                side: document.documentElement.scrollWidth > innerWidth + 1, chk: chk || '', head: txt.slice(0, 80).replace(/\s+/g, ' ')};
      }, k);
      const bad = [];
      if (errs.length > n0) bad.push('errors: ' + errs.slice(n0).join(' | ').slice(0, 300));
      if (r.len < 40) bad.push('nearly empty (' + r.len + ' chars)');
      if (r.err) bad.push('error box: ' + r.errTxt.slice(0, 160));
      if (r.side) bad.push('sideways scroll');
      if (r.chk) bad.push('self-check: ' + r.chk);
      out.push((bad.length ? 'FAIL' : 'ok  ') + ` ${sport.padEnd(7)} ${String(w).padEnd(5)} ${k.padEnd(9)} ${bad.length ? bad.join('; ') : r.head}`);
    }
    await pg.close();
  }
  console.log(out.join('\n')); await b.close(); srv.close();
  if (out.some(x => x.startsWith('FAIL'))) { console.error('FAIL: studio'); process.exit(1); }
  console.log('PASS');
})();
