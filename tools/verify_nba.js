#!/usr/bin/env node
/**
 * verify_nba.js - the headless gate for nba.html (dev + CI only, never in the
 * pipeline). Same rules as verify_shell.js: tabs are switched via gotoTab(),
 * every off-origin request is aborted, and the page fails on any uncaught
 * error or 'undefined' / 'NaN' / '[object Object]' in rendered text. Runs at
 * phone and desktop widths, and opens one player drawer.
 *
 *   python3 -B nba_build.py && node tools/verify_nba.js
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const TABS = ['home', 'plays', 'games', 'board', 'scorers', 'record', 'model'];
const PORT = Number(process.env.PROBE_PORT || 8902);
const ROOT = process.argv[2] || process.cwd();

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'nba.html';
    const file = path.join(rootDir, rel);
    if (!file.startsWith(path.resolve(rootDir))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve(ROOT);
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let failures = 0;
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
    await page.route('**/*', r => {
      const u = r.request().url();
      return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await page.goto(`http://127.0.0.1:${PORT}/nba.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const meta = await page.evaluate(() => typeof NBA_DATA === 'object' && NBA_DATA
      ? { games: NBA_DATA.games.length, players: NBA_DATA.players.length, src: NBA_DATA.source } : null);
    console.log(`\n=== ${width}px  NBA_DATA ${JSON.stringify(meta)} ===`);
    if (!meta) failures++;
    for (const t of TABS) {
      const sw = await page.evaluate(t => { try { gotoTab(t); return 'ok'; } catch (e) { return e.message; } }, t);
      await page.waitForTimeout(400);
      const text = await page.evaluate(() => document.body.innerText || '');
      const bad = [];
      if (sw !== 'ok') bad.push(sw);
      if (/\bundefined\b/.test(text)) bad.push('undefined');
      if (/\bNaN\b/.test(text)) bad.push('NaN');
      if (/\[object Object\]/.test(text)) bad.push('[object Object]');
      if (text.length < 200) bad.push('empty pane');
      console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${t.padEnd(8)} ${String(text.length).padStart(6)} chars${bad.length ? '  <- ' + bad.join(', ') : ''}`);
      if (bad.length) failures++;
    }
    const dr = await page.evaluate(() => {
      const p = (NBA_DATA.players || []).find(x => !x.out);
      if (!p) return 'no players';
      try { openPlayer(p.pid); } catch (e) { return e.message; }
      const pc = document.getElementById('pc');
      if (!pc || !pc.classList.contains('open') || pc.dataset.face !== 'front') return 'card did not open on the player side';
      const t = document.getElementById('pcFront').innerText;
      if (/\bundefined\b|\bNaN\b/.test(t)) return 'bad card text';
      pcClose();
      return 'ok';
    });
    console.log(`  ${dr === 'ok' || dr === 'no players' ? 'ok  ' : 'FAIL'} card     ${dr}`);
    if (dr !== 'ok' && dr !== 'no players') failures++;
    // the player bet card: opens from a prop, shows his markets, moves the
    // line when the ladder has more than one rung, closes cleanly
    const bc = await page.evaluate(async () => {
      const p = (NBA_DATA.players || []).find(x => x.bets && Object.keys(x.bets).length);
      if (!p) return 'no priced players';
      try { openBetCard(p.pid, Object.keys(p.bets)[0]); } catch (e) { return e.message; }
      await new Promise(r => setTimeout(r, 350));
      const el = document.getElementById('pc');
      if (!el || !el.classList.contains('open')) return 'did not open';
      if (el.dataset.face !== 'back' || !document.getElementById('pcFlip').classList.contains('flipped')) return 'did not flip to the bets side';
      const back = document.getElementById('pcBack');
      const t = back.innerText;
      if (/\bundefined\b|\bNaN\b/.test(t)) return 'bad card text';
      if (!back.querySelector('.bc-mkts button')) return 'no markets';
      const r = back.querySelector('.bc-slide input[type=range]');
      if (r && +r.max > +r.min) {
        const before = back.querySelector('.bc-big').innerText;
        r.value = +r.value === +r.max ? r.min : r.max; r.dispatchEvent(new Event('input', {bubbles: true}));
        // 10/26: a re-render replaced the slider mid-drag, so a drag moved one rung
        if (back.querySelector('.bc-slide input[type=range]') !== r) return 'slider rebuilt mid-drag';
        if (back.querySelector('.bc-big').innerText === before) return 'slider did not move the line';
        // 10/26: the slider ran on the ladder's scale and the chart on its own,
        // so the thumb sat up to 60px from the line it was showing
        const th = back.querySelector('.bc-thumb'), mk = back.querySelector('.bc-mark');
        if (th && mk) {
          const a = th.getBoundingClientRect(), m = mk.getBoundingClientRect();
          const gap = Math.abs((a.left + a.width / 2) - (m.left + m.width / 2));
          if (gap > 2) return `slider thumb ${gap.toFixed(0)}px from the chart line`;
        }
        // fine steps between offered lines, then a snap on release
        const rungs = [...back.querySelectorAll('.bc-rungs button b')].map(b => +b.innerText);
        if (rungs.length > 1 && rungs[1] - rungs[0] >= 1) {
          r.value = rungs[0] + 0.5 * (rungs[1] - rungs[0]) + 0.01; r.dispatchEvent(new Event('input', {bubbles: true}));
          const off = rungs.includes(Math.round(+r.value * 2) / 2);
          if (!off && !/not offered/.test(back.querySelector('.bc-price').innerText)) return 'between lines but shows a price';
          r.dispatchEvent(new Event('change', {bubbles: true}));
          if (!rungs.includes(+r.value)) return 'release did not snap to an Onyx line';
        }
      }
      pcFlip('front');
      if (el.dataset.face !== 'front') return 'did not flip back';
      closeBetCard();
      return el.classList.contains('open') ? 'did not close' : 'ok';
    });
    console.log(`  ${bc === 'ok' || bc === 'no priced players' ? 'ok  ' : 'FAIL'} bet card ${bc}`);
    if (bc !== 'ok' && bc !== 'no priced players') failures++;
    console.log(`  page errors: ${errs.length}`); errs.forEach(e => console.log('   ' + e));
    failures += errs.length;
    await page.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
