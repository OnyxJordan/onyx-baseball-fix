#!/usr/bin/env node
/**
 * verify_account_ui.js - one account and one tracker on every Onyx Sports page (dev + CI).
 *
 * Jordan, 11/2: "the account page and tracking should live through all sports and pages, this
 * should feel like a uniform experience across the board, not like you're going to all
 * different sites." Every page, at 390px (phone) and 1280px (desktop):
 *   - ui.js, saved.js and accounts.js are loaded
 *   - the header Account control (.ox-acct, ui.js) is there, on screen, in the header, and
 *     looks the same as on every other page (size, border, font, label)
 *   - My picks is reachable from the header (.ox-mypk) and the More menu, and both open the
 *     same tracker slide-over
 *   - a save star on that page works: the page's own star when it draws one, otherwise the
 *     shared component placed on the page; saving raises the header count, removing lowers it
 *   - no page errors, no sideways scroll
 * Then a sign-in link that lands on any page carries on to account.html.
 *
 *   node tools/verify_account_ui.js            (SHOT=dir also saves header screenshots)
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const PORT = Number(process.env.PROBE_PORT || 8907);
const ROOT = process.argv[2] || process.cwd();
const SHOT = process.env.SHOT || '';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const PAGES = ['home.html', 'index.html', 'nba.html', 'nfl.html', 'cfb.html', 'nhl.html', 'cbb.html', 'tennis.html', 'golf.html',
  'cbb-players.html', 'picks.html', 'account.html', 'how.html', 'scorecard.html', 'mlb-2026.html'];
const SHOTS = ['home.html', 'nba.html', 'nfl.html', 'index.html', 'picks.html', 'account.html'];

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
    // accounts on with a stand-in project, so "Sign in" shows; nothing ever leaves the machine
    if (rel === 'accounts.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"url":"http://127.0.0.1:1","anon":"anon-key"}'); return; }
    if (rel === 'ai.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"url":""}'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function newPage(browser, w) {
  const phone = w < 761;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, ...(phone ? { userAgent: UA } : {}) });
  // never the one-time "What's new" card (it would cover the header)
  await ctx.addInitScript(() => { try { localStorage.setItem('onyx-new-2026-10-26b', '1'); } catch (e) {} });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
  });
  return { ctx, p, errs };
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let failures = 0;
  const looks = {};     // width -> page -> the Account control's look
  for (const w of [390, 1280]) {
    looks[w] = {};
    for (const page of PAGES) {
      if (!fs.existsSync(path.join(ROOT, page))) { console.log(`  skip ${page} (not built)`); continue; }
      const { ctx, p, errs } = await newPage(browser, w);
      const bad = [];
      await p.goto(`http://127.0.0.1:${PORT}/${page}`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => window.OnyxUI && window.OnyxSaved && window.OnyxAccounts, null, { timeout: 10000 }).catch(() => {});
      await p.evaluate(() => window.OnyxAccounts && OnyxAccounts.ready).catch(() => {});
      await p.waitForTimeout(700);
      const st = await p.evaluate(() => {
        const has = { ui: !!window.OnyxUI, saved: !!window.OnyxSaved, accounts: !!window.OnyxAccounts };
        const head = document.querySelector('nav.nav') || document.querySelector('.ox-head');
        const a = document.querySelector('.ox-acct'), m = document.querySelector('.ox-mypk');
        const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
        const cs = a ? getComputedStyle(a) : null;
        return {
          has, head: !!head, headBox: box(head), acct: box(a), mypk: box(m), inHead: !!(a && head && head.contains(a)), mInHead: !!(m && head && head.contains(m)),
          vis: !!(a && a.offsetParent !== null && cs.visibility !== 'hidden'), mvis: !!(m && m.offsetParent !== null),
          look: cs ? [cs.height, cs.width, cs.borderRadius, cs.borderTopWidth, cs.fontSize, cs.fontFamily.split(',')[0], cs.textTransform].join(' | ') : '',
          label: a ? a.querySelector('span').textContent : '', state: a ? a.getAttribute('data-state') : '', href: a ? a.getAttribute('href') : '',
          vw: document.documentElement.clientWidth,
        };
      });
      if (!st.has.ui) bad.push('ui.js not loaded');
      if (!st.has.saved) bad.push('saved.js not loaded');
      if (!st.has.accounts) bad.push('accounts.js not loaded');
      if (!st.head) bad.push('no site header');
      if (!st.acct) bad.push('no Account control');
      else {
        if (!st.inHead) bad.push('Account control is not in the header');
        if (!st.vis) bad.push('Account control hidden');
        if (st.acct.r > st.vw + 0.5 || st.acct.x < 0) bad.push(`Account control off screen (${Math.round(st.acct.x)}-${Math.round(st.acct.r)} of ${st.vw})`);
        if (st.headBox && (st.acct.y < st.headBox.y - 1 || st.acct.b > st.headBox.b + 1)) bad.push('Account control spills out of the header');
        if (st.href !== 'account.html') bad.push(`Account goes to ${st.href}`);
        if (st.label !== 'Sign in' || st.state !== 'out') bad.push(`signed out, accounts on: label "${st.label}" (${st.state}), want "Sign in"`);
        looks[w][page] = st.look;
      }
      if (!st.mypk || !st.mInHead || !st.mvis) bad.push('no My picks button in the header');
      // a save star on this page: the page's own if it draws one, otherwise the shared component
      const before = await p.evaluate(() => OnyxSaved.all().length).catch(() => 0);
      const vis = () => p.evaluate(() => [...document.querySelectorAll('.ox-save:not(.on)')].filter(e => e.offsetParent !== null && !e.closest('.otrk')).length);
      let own = await vis();
      // a sport page draws its stars on the Plays tab
      if (!own && await p.evaluate(() => typeof gotoTab === 'function' && !!document.getElementById('pane-plays'))) {
        await p.evaluate(() => gotoTab('plays')); await p.waitForTimeout(500); own = await vis();
        if (!own) { await p.evaluate(() => gotoTab('home')); await p.waitForTimeout(200); }
      }
      if (!own) {
        await p.evaluate(() => {
          const d = document.createElement('div'); d.id = 'probeStar'; d.style.cssText = 'position:relative;padding:12px';
          d.innerHTML = OnyxSaved.btn({ id: 'probe-' + location.pathname, sport: 'nfl', label: 'Probe pick', start: new Date(Date.now() + 3 * 3600e3).toISOString(), kind: 'ml', name: 'KC', price: 120 });
          (document.querySelector('main') || document.body).prepend(d);
        });
      }
      const star = own ? '.ox-save:not(.on)' : '#probeStar .ox-save';
      const ok1 = await p.evaluate(sel => { const b = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null && !e.closest('.otrk')); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, star);
      await p.waitForTimeout(250);
      const after = await p.evaluate(() => ({ n: OnyxSaved.all().length, badge: (document.querySelector('.ox-mypk b') || {}).textContent || '' }));
      if (!ok1) bad.push('no save star to tap');
      else if (after.n !== before + 1 || after.badge !== String(before + 1)) bad.push(`saving did not raise the shared count (${before} -> ${after.n}, header badge "${after.badge}")`);
      // My picks from the header: the tracker lists the pick; its star takes it back
      await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.ox-mypk').click(); });
      await p.waitForTimeout(400);
      const tr = await p.evaluate(() => { const t = document.querySelector('.otrk'); return { open: !!(t && t.classList.contains('open')), rows: t ? t.querySelectorAll('.otrk-row').length : 0 }; });
      if (!tr.open) bad.push('header My picks did not open the tracker');
      else if (tr.rows !== after.n) bad.push(`tracker shows ${tr.rows} picks, want ${after.n}`);
      if (tr.open) {
        await p.evaluate(() => { const b = document.querySelector('.otrk .otrk-row .ox-save.on'); if (b) b.click(); });
        await p.waitForTimeout(250);
        const back = await p.evaluate(() => ({ n: OnyxSaved.all().length, hidden: document.querySelector('.ox-mypk b').hidden }));
        if (back.n !== before) bad.push(`the tracker's star did not take the pick back (${back.n})`);
        if (!before && !back.hidden) bad.push('the header count did not clear');
        await p.evaluate(() => OnyxUI.closePicks());
        await p.waitForTimeout(350);
      }
      // My picks from the More menu (the bottom bar on phones, the menu everywhere): the same tracker
      await p.evaluate(() => OnyxUI.openMenu());
      await p.waitForTimeout(350);
      const viaMore = await p.evaluate(() => { const b = document.querySelector('.osheet.open [data-act="mypicks"]'); if (!b) return 'none'; b.click(); return 'ok'; });
      await p.waitForTimeout(400);
      const tr2 = await p.evaluate(() => !!document.querySelector('.otrk.open'));
      if (viaMore !== 'ok') bad.push('no My picks in the More menu');
      else if (!tr2) bad.push('More menu My picks did not open the tracker');
      await p.evaluate(() => OnyxUI.closePicks());
      await p.waitForTimeout(350);
      if (SHOT && SHOTS.includes(page)) {
        await p.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.otoast').forEach(t => t.remove()); });
        await p.waitForTimeout(200);
        const clip = await p.evaluate(() => { const h = document.querySelector('nav.nav') || document.querySelector('.ox-head'); const r = h.getBoundingClientRect(); return { x: 0, y: 0, width: document.documentElement.clientWidth, height: Math.ceil(r.bottom) + 4 }; });
        await p.screenshot({ path: path.join(SHOT, `header_${page.replace('.html', '')}_${w}.png`), clip });
      }
      const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
      if (sw.sw > sw.vw) bad.push(`page scrolls sideways (${sw.sw}px > ${sw.vw}px)`);
      bad.push(...errs);
      console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${page.padEnd(17)} ${String(w).padEnd(5)} account "${st.label}" at ${st.acct ? Math.round(st.acct.x) + ',' + Math.round(st.acct.y) : '-'}, star ${own ? 'page' : 'shared'}${bad.length ? '  <- ' + bad.join('; ') : ''}`);
      failures += bad.length;
      await ctx.close();
    }
    // identical: the Account control looks the same on every page at this width
    const L = looks[w], ref = L['nfl.html'] || Object.values(L)[0];
    const off = Object.keys(L).filter(k => L[k] !== ref);
    if (off.length) { failures += off.length; console.log(`  FAIL Account control differs at ${w}px: ${off.map(k => k + ' [' + L[k] + ']').join(', ')} vs [${ref}]`); }
    else console.log(`  ok   Account control identical on ${Object.keys(L).length} pages at ${w}px [${ref}]`);
  }
  // signed in: the same control says Account with the green dot, on a sport page and a plain page
  for (const page of ['nfl.html', 'picks.html']) {
    const { ctx, p, errs } = await newPage(browser, 390);
    await p.goto(`http://127.0.0.1:${PORT}/${page}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.OnyxUI && window.OnyxAccounts, null, { timeout: 10000 }).catch(() => {});
    const s = await p.evaluate(() => {
      const real = OnyxAccounts.state;
      OnyxAccounts.state = () => Object.assign(real(), { enabled: true, signedIn: true, email: 'jordan@example.com' });
      dispatchEvent(new Event('onyx-account'));
      const a = document.querySelector('.ox-acct');
      return { label: a.querySelector('span').textContent, dot: getComputedStyle(a.querySelector('i')).display, title: a.title };
    });
    const bad = [];
    if (s.label !== 'Account' || s.dot === 'none' || !/jordan@example.com/.test(s.title)) bad.push(`signed in shows "${s.label}", dot ${s.dot}, "${s.title}"`);
    bad.push(...errs);
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} signed in on ${page}: "${s.label}" with the dot${bad.length ? '  <- ' + bad.join('; ') : ''}`);
    failures += bad.length;
    await ctx.close();
  }
  // a sign-in link landing on any page carries on to account.html with its tokens
  for (const page of ['picks.html', 'how.html', 'scorecard.html', 'cbb-players.html', 'nba.html']) {
    if (!fs.existsSync(path.join(ROOT, page))) continue;
    const { ctx, p } = await newPage(browser, 390);
    await p.goto(`http://127.0.0.1:${PORT}/${page}#access_token=x&refresh_token=r:x&expires_in=3600&type=magiclink`, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(/account\.html/, { timeout: 8000 }).catch(() => {});
    const ok = /account\.html/.test(p.url());
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} a sign-in link on ${page} goes on to account.html`);
    if (!ok) failures++;
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
