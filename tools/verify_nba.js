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
const TABS = ['home', 'board', 'scorers', 'games', 'record', 'model'];
const PORT = Number(process.env.PROBE_PORT || 8902);
const ROOT = process.argv[2] || process.cwd();

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'nba.html';
    const file = path.join(rootDir, rel);
    if (!file.startsWith(path.resolve(rootDir))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(buf);
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
      const t = document.getElementById('drawer').innerText;
      return /\bundefined\b|\bNaN\b/.test(t) ? 'bad drawer text' : 'ok';
    });
    console.log(`  ${dr === 'ok' || dr === 'no players' ? 'ok  ' : 'FAIL'} drawer   ${dr}`);
    if (dr !== 'ok' && dr !== 'no players') failures++;
    console.log(`  page errors: ${errs.length}`); errs.forEach(e => console.log('   ' + e));
    failures += errs.length;
    await page.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
