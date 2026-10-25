#!/usr/bin/env node
/**
 * verify_pwa.js - the installed-iPhone gate for both sites (dev + CI only).
 *
 * Simulates the home-screen app: iPhone user agent, navigator.standalone,
 * an 852pt (Dynamic Island) screen, and a safe-area inset of 0. On 10/25 the
 * MLB and NBA headers and menus sat under the status bar and could not be
 * tapped, then sat in the band iOS blurs under a translucent status bar.
 * Each page runs twice:
 *   shipped      the page as built: the status bar must be the solid "black"
 *                style (the app starts below it), so the header must NOT be
 *                padded again (--sat empty, controls near the top)
 *   translucent  the meta forced to "black-translucent": ui.js must treat the
 *                0 inset as iOS misreporting and push the header below a
 *                59pt bar
 * and in both: More opens the menu, a tile navigates and closes it, the
 * hamburger opens the same menu, search finds something, no page errors.
 *
 *   python3 -B nba_build.py && node tools/verify_pwa.js
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const PORT = Number(process.env.PROBE_PORT || 8903);
const ROOT = process.argv[2] || process.cwd();
const ISLAND = 59;    // Dynamic Island status bar, pt
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const PAGES = [['index.html', 'rankings'], ['nba.html', 'model']];

function serve() {
  const server = http.createServer((req, res) => {
    const translucent = req.url.includes('translucent=1');
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript'
        : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      if (translucent && type === 'text/html')
        buf = Buffer.from(String(buf).replace('content="black"', 'content="black-translucent"'));
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let failures = 0;
  for (const [page, tile] of PAGES) for (const mode of ['shipped', 'translucent']) {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: UA });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      Object.defineProperty(screen, 'height', { get: () => 852 });
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
    await p.route('**/*', r => {
      const u = r.request().url();
      return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await p.goto(`http://127.0.0.1:${PORT}/${page}${mode === 'translucent' ? '?translucent=1' : ''}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const bad = [];
    const bar = await p.evaluate(() => (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content);
    const sat = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sat').trim());
    const loaded = await p.evaluate(() => !!window.OnyxUI);
    if (!loaded) bad.push('ui.js not loaded');
    if (mode === 'shipped' && bar !== 'black') bad.push(`status bar style "${bar}", want solid "black" (translucent is blurred by iOS)`);
    const want = mode === 'shipped' ? 0 : ISLAND;
    if (mode === 'translucent' && sat !== ISLAND + 'px') bad.push(`--sat ${sat || 'unset'}, want ${ISLAND}px`);
    if (mode === 'shipped' && parseFloat(sat) > 0) bad.push(`--sat ${sat}: padded twice under a solid status bar`);
    const navTop = await p.evaluate(() => {
      const items = [...document.querySelectorAll('.nav .nav-logo, .nav .nav-hamburger, .nav .nav-right')]
        .filter(e => e.offsetParent !== null);
      return items.length ? Math.min(...items.map(e => e.getBoundingClientRect().top)) : -1;
    });
    if (navTop < want) bad.push(`header controls at ${Math.round(navTop)}px, under the status bar`);
    if (navTop > want + 20) bad.push(`header controls at ${Math.round(navTop)}px, pushed too far down`);
    const more = await p.$('.obar-i[data-more="1"]');
    if (!more) bad.push('no More button');
    else {
      await more.tap();
      await p.waitForTimeout(450);
      const st = await p.evaluate(() => ({
        open: document.querySelector('.osheet').classList.contains('open'),
        x: document.querySelector('.osheet-x').getBoundingClientRect().top,
      }));
      if (!st.open) bad.push('More did not open the menu');
      if (st.x < want) bad.push(`menu close button at ${Math.round(st.x)}px, under the status bar`);
      await p.tap(`.otile[data-tab="${tile}"]`);
      await p.waitForTimeout(450);
      const nav = await p.evaluate(t => ({
        pane: document.getElementById('pane-' + t).classList.contains('active'),
        closed: !document.querySelector('.osheet').classList.contains('open'),
      }), tile);
      if (!nav.pane) bad.push(`tile did not open ${tile}`);
      if (!nav.closed) bad.push('menu did not close after a tile');
      const ham = await p.evaluate(() => {
        const h = document.getElementById('navHamburger');
        if (!h) return true;
        h.click();
        const o = document.querySelector('.osheet').classList.contains('open');
        window.OnyxUI.closeMenu();
        return o;
      });
      if (!ham) bad.push('hamburger did not open the menu');
      await p.evaluate(() => window.OnyxUI.openMenu(true));
      await p.fill('.osearch input', 'mo');
      await p.waitForTimeout(150);
      const hits = await p.$$eval('.ores button', b => b.length);
      if (!hits) bad.push('search found nothing for "mo"');
    }
    bad.push(...errs);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${page.padEnd(10)} ${mode.padEnd(11)} bar ${bar}, --sat ${sat || '0'}, header top ${Math.round(navTop)}px${bad.length ? '  <- ' + bad.join('; ') : ''}`);
    failures += bad.length;
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
