#!/usr/bin/env node
/**
 * verify_sports.js - the gate for the sport pages built from sport_shell.html
 * (nfl, cfb, cbb, nhl, tennis, golf). Dev + CI only.
 *
 * Every page, every tab (home, games, board, plays, model) at 390px and
 * 1280px: renders, no uncaught errors, no "undefined" / "NaN" /
 * "[object Object]", nothing wider than the screen. For football, hockey and
 * basketball it opens a game's gamecenter too; basketball also renders a
 * finished game's box score from tools/fixtures/cbb_summary.json (a real
 * ESPN summary, trimmed) in both the Live and Box score views. Off-origin requests (ESPN live polling)
 * are aborted, so this checks the built page, not today's feed.
 *
 *   python3 -B sports_build.py nfl   (and the others)
 *   node tools/verify_sports.js [nfl,cfb,cbb,nhl,tennis,golf]
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const PORT = Number(process.env.PROBE_PORT || 8913);
const ROOT = process.cwd();
const PAGES = (process.argv[2] || 'nfl,cfb,cbb,nhl,tennis,golf').split(',');
const BB_FIX = path.join(__dirname, 'fixtures', 'cbb_summary.json');
const TABS = ['home', 'games', 'board', 'plays', 'model'];

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let failures = 0;
  for (const pg of PAGES) {
    if (!fs.existsSync(path.join(ROOT, pg + '.html'))) { console.log(`  FAIL ${pg}.html missing`); failures++; continue; }
    for (const [w, h, mob] of [[390, 844, true], [1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.route('**/*', r => {
        const u = r.request().url();
        return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
      });
      await page.goto(`http://127.0.0.1:${PORT}/${pg}.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const out = [];
      for (const t of TABS) {
        await page.evaluate(t => gotoTab(t), t);
        await page.waitForTimeout(250);
        const r = await page.evaluate(() => {
          const W = document.documentElement.clientWidth, pane = document.querySelector('.pane.active');
          const txt = pane ? pane.innerText : '';
          const wide = [];
          (pane ? pane.querySelectorAll('*') : []).forEach(e => {
            const b = e.getBoundingClientRect();
            if (!b.width || b.right <= W + 1) return;
            let a = e.parentElement;
            while (a && a !== document.body) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
            wide.push(String(e.className || e.tagName));
          });
          return { n: txt.length, bad: /\bundefined\b|\bNaN\b|\[object Object\]/.test(txt), wide: wide.slice(0, 3) };
        });
        const bad = [];
        if (r.n < 60) bad.push('empty pane');
        if (r.bad) bad.push('undefined/NaN in text');
        if (r.wide.length) bad.push('wider than the screen: ' + r.wide.join(', '));
        out.push(`${t}${bad.length ? ' FAIL(' + bad.join('; ') + ')' : ''}`);
        failures += bad.length;
      }
      let gc = '';
      const team = await page.evaluate(() => (typeof KIND !== 'undefined') && (KIND === 'football' || KIND === 'hockey' || KIND === 'basketball') && (SD.games || []).length);
      if (team) {
        gc = await page.evaluate(() => { gotoTab('games'); openGame(SD.games[0].gid); return !!document.getElementById('gc') ? 'gamecenter ok' : 'gamecenter did not open'; });
        if (gc !== 'gamecenter ok') failures++;
      }
      if (team && await page.evaluate(() => KIND === 'basketball') && fs.existsSync(BB_FIX)) {
        // a finished game's gamecenter from a real ESPN summary: live view, then the box score with minutes
        const fix = JSON.parse(fs.readFileSync(BB_FIX, 'utf8'));
        const r = await page.evaluate(fix => {
          const g = SD.games[0], W = document.documentElement.clientWidth, res = [];
          LIVE[g.gid] = Object.assign({}, LIVE[g.gid] || {}, {state: 'post', detail: 'Final', away_score: '80', home_score: '75'});
          GC_CACHE[g.gid] = fix; OPEN_GAME = g.gid;
          for (const sub of ['live', 'box']) {
            GC_SUB = sub; drawGame(g.gid);
            const gc = document.getElementById('gc'), txt = gc ? gc.innerText : '';
            const wide = [];
            (gc ? gc.querySelectorAll('*') : []).forEach(e => {
              const b = e.getBoundingClientRect();
              if (!b.width || b.right <= W + 1) return;
              let a = e.parentElement;
              while (a && a !== document.body) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
              wide.push(String(e.className || e.tagName));
            });
            const bad = [];
            if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(txt)) bad.push('undefined/NaN');
            if (wide.length) bad.push('wide: ' + wide.slice(0, 3).join(', '));
            if (sub === 'box' && !(/MIN/.test(txt) && /PTS/.test(txt) && /3PM/.test(txt) && /starters/i.test(txt) && /bench/i.test(txt))) bad.push('box columns missing');
            if (sub === 'live' && !/by half/i.test(txt)) bad.push('no score by half');
            res.push(sub + (bad.length ? ' FAIL(' + bad.join('; ') + ')' : ' ok'));
          }
          GC_SUB = 'live'; OPEN_GAME = null; delete LIVE[g.gid]; delete GC_CACHE[g.gid];
          return res.join(', ');
        }, fix);
        gc += ' · box ' + r;
        if (r.includes('FAIL')) failures++;
      }
      failures += errs.length;
      console.log(`  ${errs.length || out.some(x => x.includes('FAIL')) || (gc && (!gc.startsWith('gamecenter ok') || gc.includes('FAIL'))) ? 'FAIL' : 'ok  '} ${pg.padEnd(7)} ${String(w).padEnd(5)} ${out.join(' ')}${gc ? ' · ' + gc : ''}${errs.length ? '  <- ' + errs.join(' | ') : ''}`);
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
