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
 * Then the Onyx Sports hub (home.html, the manifest's start page) at 320
 * and 393px: solid status bar, header in place, all seven sports linked
 * to their sites, no sideways scroll, the raster ONYX drawn. Then the iPhone
 * Duo: cover (382x678) and inner (867x669, the installed app's real page) screens, folded and unfolded live,
 * with a touch pointer and with a misreported fine pointer. Then the fold:
 * unfolded, the page is a book with nothing on the hinge.
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
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
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
  // the hub (home.html): the installed app's start page since 10/26
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const w of [320, 393]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 852 }, isMobile: true, hasTouch: true, userAgent: UA });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
    await p.route('**/*', r => {
      const u = r.request().url();
      return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await p.goto(`http://127.0.0.1:${PORT}/home.html`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const bad = [];
    if (man.start_url !== 'home.html') bad.push(`manifest start_url ${man.start_url}, want home.html`);
    if (!/Onyx Sports/.test(man.name || '')) bad.push(`manifest name "${man.name}"`);
    const st = await p.evaluate(() => {
      const bar = (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content;
      const head = document.querySelector('.ox-head-in').getBoundingClientRect();
      const barEl = document.getElementById('oxBar'), barH = barEl ? barEl.getBoundingClientRect().height : 0;
      const cards = [...document.querySelectorAll('.ox-sport')];
      const live = cards.filter(c => c.tagName === 'A').map(c => c.getAttribute('href'));
      const cv = document.querySelector('.ox-giant canvas');
      if (cv) { cv.scrollIntoView(); }
      return { bar, headTop: head.top - barH, cards: cards.length, live, sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
    });
    await p.waitForTimeout(400);
    const inked = await p.evaluate(() => {
      const cv = document.querySelector('.ox-giant canvas');
      if (!cv || !cv.width) return false;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 40) if (d[i] > 0) return true;
      return false;
    });
    if (st.bar !== 'black') bad.push(`status bar style "${st.bar}"`);
    if (st.headTop < 0 || st.headTop > 40) bad.push(`header at ${Math.round(st.headTop)}px`);
    if (st.cards !== 8) bad.push(`${st.cards} sport cards, want 8`);
    const want = ['nba.html', 'index.html', 'nfl.html', 'cfb.html', 'cbb.html', 'nhl.html', 'tennis.html', 'golf.html'];
    const miss = want.filter(h => !st.live.includes(h));
    if (miss.length) bad.push(`sports not linked: ${miss.join(', ')}`);
    if (st.sw > st.vw) bad.push(`page scrolls sideways (${st.sw}px > ${st.vw}px)`);
    if (!inked) bad.push('ONYX raster wordmark did not draw');
    bad.push(...errs);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} home.html  ${String(w).padEnd(11)} ${st.cards} sports, live: ${st.live.join(' ')}${bad.length ? '  <- ' + bad.join('; ') : ''}`);
    failures += bad.length;
    await ctx.close();
  }
  // iPhone Duo (11/3): the 466x678 cover screen and the 890x626 inner screen, which
  // opens wider than tall. Both must run the app chrome (bottom bar + hamburger, no
  // desktop tab strip, no sideways scroll), including after folding and unfolding
  // mid-session, and the hamburger must open the menu as a sheet on screen.
  // 11/4, from Jordan's screenshots: iOS puts the Duo's status bar down the right edge, so the
  // page gets about 382x678 folded and 811x626 unfolded, and the real inner screen still drew the
  // desktop header. The second flavor reports a fine, hovering pointer with touch points (what
  // the device appears to do): the app chrome must still run.
  for (const flavor of ['touch', 'fine-pointer']) for (const page of ['home.html', 'index.html', 'nba.html', 'cbb.html', 'tennis.html', 'picks.html']) {
    const ctx = await browser.newContext({ viewport: { width: 382, height: 678 }, userAgent: UA,
      ...(flavor === 'touch' ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
    await p.route('**/*', r => {
      const u = r.request().url();
      return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await p.goto(`http://127.0.0.1:${PORT}/${page}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const bad = [];
    for (const [name, w, h] of [['cover', 382, 678], ['unfolded', 867, 669], ['folded', 382, 678], ['unfolded', 867, 669], ['unfolded 890', 890, 626]]) {
      await p.setViewportSize({ width: w, height: h });
      await p.waitForTimeout(350);
      const st = await p.evaluate(() => {
        const vis = s => [...document.querySelectorAll(s)].some(e => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden');
        return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
          obar: vis('.obar'), tabs: vis('.nav .nav-tabs'), ham: vis('.nav .nav-hamburger') };
      });
      if (!st.obar) bad.push(`${name}: no bottom bar`);
      if (st.tabs) bad.push(`${name}: desktop tab strip showing`);
      if (page !== 'home.html' && !st.ham) bad.push(`${name}: no menu button`);
      if (st.sw > st.vw + 1) bad.push(`${name}: scrolls sideways (${st.sw}px > ${st.vw}px)`);
    }
    const more = await p.$('.obar .obar-i:last-child');
    if (more && await more.isVisible()) {
      await more.click({ timeout: 3000 });
      await p.waitForTimeout(450);
      const sh = await p.evaluate(() => {
        const s = document.querySelector('.osheet.open');
        if (!s) return null;
        const r = s.getBoundingClientRect();
        return { l: r.left, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight };
      });
      if (!sh) bad.push('More did not open the menu');
      else if (sh.l < -1 || sh.r > sh.vw + 1 || sh.b > sh.vh + 1) bad.push(`menu off screen (${Math.round(sh.l)}..${Math.round(sh.r)}, bottom ${Math.round(sh.b)})`);
    } else bad.push('no More button on screen');
    bad.push(...errs);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${page.padEnd(11)} iPhone Duo ${flavor.padEnd(12)} cover 382x678 <-> inner 867x669${bad.length ? '  <- ' + bad.join('; ') : ''}`);
    failures += bad.length;
    await ctx.close();
  }
  // the fold (11/4): unfolded, the Duo is a book. The page is 867x669 on the 890-wide inner screen,
  // so the hinge sits 445px in. Nothing that reads or taps may straddle it (tables, tickers and
  // art excepted), the bottom bar splits around it, and the menu opens on the right page.
  // Folded (382 wide) and on a laptop the book layout must be off.
  for (const page of ['home.html', 'picks.html', 'index.html', 'nba.html', 'cbb.html', 'tennis.html']) {
    const ctx = await browser.newContext({ viewport: { width: 867, height: 669 }, screen: { width: 466, height: 678 }, isMobile: true, hasTouch: true, userAgent: UA });
    // the installed app on the real Duo (Jordan's readout, 11/4): page 867x669, screen reported as
    // the cover's 466x678, angle 270, status strip on the right: the crease is 445 from the left
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      Object.defineProperty(screen, 'orientation', { get: () => ({ angle: 270, type: 'landscape-secondary', addEventListener() {} }) });
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
    await p.route('**/*', r => {
      const u = r.request().url();
      return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await p.goto(`http://127.0.0.1:${PORT}/${page}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
    const bad = [];
    const st = await p.evaluate(() => {
      const r = document.documentElement, cs = getComputedStyle(r);
      const L = parseFloat(cs.getPropertyValue('--fold-l')), R = parseFloat(cs.getPropertyValue('--fold-r'));
      const skip = '.ox-bar,table,.tbl,.tbl-wrap,[class*="ticker"],[class*="marq"],.tk-strip,.ox-marquee,.ox-giant,svg,canvas,.sp-art,.ox-hero-art,.osheet,.cx,.pc';
      const H = innerHeight, hits = [];
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let t;
      while ((t = tw.nextNode())) {
        if (!t.textContent.trim()) continue;
        const el = t.parentElement; if (!el || el.closest(skip) || getComputedStyle(el).visibility === 'hidden') continue;
        const rg = document.createRange(); rg.selectNodeContents(t);
        for (const b of rg.getClientRects()) if (b.width > 0 && b.top < H && b.bottom > 0 && b.left < R - 2 && b.right > L + 2) { hits.push((el.className || el.tagName) + ': ' + t.textContent.trim().slice(0, 24)); break; }
      }
      const bar = [...document.querySelectorAll('.obar > .obar-i')].filter(b => { const x = b.getBoundingClientRect(); return x.left < R - 1 && x.right > L + 1; }).length;
      return { fold: r.classList.contains('ox-fold'), x: cs.getPropertyValue('--fold-x').trim(), hits, bar,
        sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
    });
    if (!st.fold) bad.push('book layout off on the unfolded screen');
    if (st.x !== '445px') bad.push(`hinge at ${st.x}, want 445px`);
    if (st.hits.length) bad.push(`${st.hits.length} text on the hinge (${st.hits.slice(0, 3).join(' | ')})`);
    if (st.bar) bad.push(`${st.bar} bottom-bar item(s) on the hinge`);
    if (st.sw > st.vw + 1) bad.push(`scrolls sideways (${st.sw}px > ${st.vw}px)`);
    // 11/4: the NBA player card's fold rule (.pc) also caught Onyx Picks' cards (.pc), each one stretched
    // to the full screen height with its title pushed out of view: a card on the page stays card-sized
    const tall = await p.evaluate(() => [...document.querySelectorAll('.cards .pc, .pk-grid > *, .lv-card')].filter(c => c.getBoundingClientRect().height > innerHeight * 0.7).length);
    if (tall) bad.push(`${tall} card(s) stretched to the screen height`);
    // two live pick cards (Jordan's photo, 11/4): one per page, the same width, meeting at the crease
    const ev = await p.evaluate(async () => {
      const host = document.querySelector('main, .pane.active, body'), list = document.createElement('div');
      list.className = 'lv-list'; list.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px';
      list.innerHTML = '<div class="lv-card" style="height:80px"></div><div class="lv-card" style="height:80px"></div>';
      host.insertBefore(list, host.firstChild); window.OnyxFoldFit && OnyxFoldFit();
      const cs = getComputedStyle(document.documentElement), X = parseFloat(cs.getPropertyValue('--fold-x'));
      const [a, b] = [...list.children].map(c => c.getBoundingClientRect()); list.remove();
      return { l: [a.left, a.right], r: [b.left, b.right], X, top: Math.abs(a.top - b.top) };
    });
    if (ev.top > 1 || ev.l[1] > ev.X - 4 || ev.r[0] < ev.X + 4 || ev.X - ev.l[1] > 12 || ev.r[0] - ev.X > 12)
      bad.push(`live picks not split at the crease (left ${Math.round(ev.l[0])}-${Math.round(ev.l[1])}, right ${Math.round(ev.r[0])}-${Math.round(ev.r[1])}, hinge ${ev.X})`);
    if (Math.abs((ev.l[1] - ev.l[0]) - (ev.r[1] - ev.r[0])) > 2) bad.push(`live picks uneven (${Math.round(ev.l[1] - ev.l[0])} vs ${Math.round(ev.r[1] - ev.r[0])}px)`);
    await p.click('.obar .obar-i:last-child', { timeout: 3000 }).catch(() => bad.push('no More button'));
    await p.waitForTimeout(450);
    const sh = await p.evaluate(() => { const s = document.querySelector('.osheet.open'); if (!s) return null; const b = s.getBoundingClientRect();
      return [b.left, b.right, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fold-r')), innerWidth]; });
    if (!sh) bad.push('More did not open the menu'); else if (sh[0] < sh[2] - 1 || sh[1] > sh[3] + 1) bad.push(`menu not on the right page (${Math.round(sh[0])}..${Math.round(sh[1])})`);
    for (const [w, h, name] of [[382, 678, 'folded'], [1280, 800, 'laptop width']]) {
      await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(450);
      const on = await p.evaluate(() => document.documentElement.classList.contains('ox-fold') || !!document.querySelector('[data-oxf]'));
      if (on) bad.push(`book layout still on when ${name}`);
    }
    bad.push(...errs);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${page.padEnd(11)} the fold: book layout, hinge ${st.x}${bad.length ? '  <- ' + bad.join('; ') : ''}`);
    failures += bad.length;
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
