#!/usr/bin/env node
/**
 * verify_shell.js — the headless gate for any shell.html or model.py change.
 *
 *   python3 -B auto_build.py && python3 -B update_stats.py
 *   node tools/verify_shell.js            # checks ./index.html
 *   node tools/verify_shell.js --live     # checks the DEPLOYED page
 *
 * Exits non-zero on any uncaught page error, any tab that fails to render, any
 * 'undefined' / 'NaN' / '[object Object]' in rendered text, or any injected
 * global that is unreadable from an early call site. Wire it into CI and a bad
 * build stops being something a human has to notice.
 *
 * Three things here were learned the hard way; do not "simplify" them away:
 *
 * 1. TABS ARE SWITCHED VIA gotoTab(), NOT BY CLICKING NAV.
 *    At 390px several tabs live only in the hamburger drawer, so clicking
 *    [data-tab=...] silently skips them and the probe reports a pass on tabs it
 *    never opened. There are 9 tabs, not 8.
 *
 * 2. EXTERNAL REQUESTS MUST BE ABORTED.
 *    Otherwise the probe hangs on Google Fonts. Everything off-origin is killed.
 *
 * 3. --live CANNOT NAVIGATE TO https:// DIRECTLY IN THE CLOUD SESSION.
 *    The agent proxy terminates TLS with a CA that Chromium does not trust, so
 *    page.goto() fails ERR_CERT_AUTHORITY_INVALID. Do NOT "fix" that by
 *    disabling certificate checking. Fetch the deployed bytes with curl (which
 *    does trust the proxy CA) and serve them locally instead — same bytes, same
 *    verdict, no TLS hole. See the --live branch below.
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TABS = ['home', 'gamecenter', 'board', 'power', 'pitchers',
              'record', 'markets', 'rankings', 'model'];

// Injected globals that are read through a `typeof` guard somewhere above their
// declaration. A const here is a site-blanker: index.html is ONE <script> block,
// so an early read lands in the temporal dead zone and throws. Keep this list in
// sync with the audit table in README -> Injected globals.
const GUARDED_GLOBALS = ['LINE_HISTORY', 'PICKS', 'TICKET_LOCK', 'DAILY_RECAP',
                         'RESULTS', 'SUMMARIES', 'PITCHER_PROJ', 'ONYX_PLAYER_IDS'];

const LIVE_URL = 'https://onyxjordan.github.io/onyx-baseball-fix/index.html';
const PORT = Number(process.env.PROBE_PORT || 8901);

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(rootDir, rel);
    if (!file.startsWith(path.resolve(rootDir))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const ext = path.extname(file);
      const type = ext === '.html' ? 'text/html'
                 : ext === '.json' ? 'application/json'
                 : ext === '.js' ? 'text/javascript'
                 : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const live = process.argv.includes('--live');
  let rootDir = process.cwd();

  if (live) {
    // see note 3 above: curl the bytes, serve them locally, never relax TLS
    rootDir = fs.mkdtempSync('/tmp/onyx-live-');
    console.log('fetching deployed page (curl trusts the proxy CA; Chromium does not)');
    execFileSync('curl', ['-sS', '--max-time', '60', `${LIVE_URL}?cb=${Date.now()}`,
                          '-o', path.join(rootDir, 'index.html')], { stdio: 'inherit' });
    const bytes = fs.statSync(path.join(rootDir, 'index.html')).size;
    console.log(`  ${bytes} bytes from ${LIVE_URL}`);
    if (bytes < 100000) { console.error('FAIL: deployed page implausibly small'); process.exit(1); }
  }

  const server = await serve(rootDir);
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.constructor.name + ': ' + e.message));

  await page.route('**/*', r => {
    const u = r.request().url();
    return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:') || u.startsWith('blob:'))
      ? r.continue() : r.abort();          // see note 2
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  let failures = 0;

  // ---- injected globals readable from an early call site? (see note above) ----
  const globals = await page.evaluate(names => names.map(n => {
    try {
      const v = eval(n);                                  // eslint-disable-line no-eval
      return { name: n, ok: true, kind: Array.isArray(v) ? `array(${v.length})` : typeof v };
    } catch (e) { return { name: n, ok: false, err: e.message }; }
  }), GUARDED_GLOBALS);
  console.log('\n=== injected globals ===');
  for (const g of globals) {
    console.log(`  ${g.ok ? 'ok  ' : 'FAIL'} ${g.name}${g.ok ? ' -> ' + g.kind : ' -> ' + g.err}`);
    if (!g.ok) failures++;
  }

  // mktHist() is the specific early reader that made LINE_HISTORY a bug
  const mkt = await page.evaluate(() => {
    try { return typeof mktHist === 'function' ? { n: mktHist().length } : { missing: true }; }
    catch (e) { return { threw: e.message }; }
  });
  console.log('  mktHist() -> ' + JSON.stringify(mkt));
  if (mkt.threw) { failures++; }

  // ---- walk every tab (see note 1) ----
  console.log('\n=== tabs ===');
  for (const t of TABS) {
    const sw = await page.evaluate(t => {
      if (typeof gotoTab !== 'function') return 'gotoTab missing';
      try { gotoTab(t); return 'ok'; } catch (e) { return e.message; }
    }, t);
    if (sw !== 'ok') { console.log(`  FAIL ${t} -> ${sw}`); failures++; continue; }
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.body.innerText || '');
    const bad = [];
    if (/\bundefined\b/.test(text)) bad.push('undefined');
    if (/\bNaN\b/.test(text)) bad.push('NaN');
    if (/\[object Object\]/.test(text)) bad.push('[object Object]');
    if (text.length < 200) bad.push('empty pane');
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${t.padEnd(11)} ${String(text.length).padStart(6)} chars${bad.length ? '  <- ' + bad.join(', ') : ''}`);
    if (bad.length) failures++;
  }

  console.log('\n=== uncaught page errors: ' + pageErrors.length + ' ===');
  pageErrors.forEach(e => console.log('  ' + e));
  failures += pageErrors.length;

  await browser.close();
  server.close();
  if (live) fs.rmSync(rootDir, { recursive: true, force: true });

  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
