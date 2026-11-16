// verify_tap.js - "Tap any price, anywhere" gate (onyx-tap.js, 11/16). On nfl.html, nba.html, index.html (MLB),
// home.html and studio.html, at 390 (touch) and 1280 (mouse), with every off-origin request aborted, it taps a real
// Onyx price and fails unless the quick card opens with a chance, a payout and an Onyx link, opens no Onyx tab on the
// way, and closes again (Esc on desktop, the close button on phones). It also checks the integrations it must not
// break: with the parlay builder armed a tap adds a leg and opens no card, and an NBA player-prop chip still opens
// the NBA page's own bet card instead.
//   node tools/verify_tap.js [nfl nba mlb home studio]     SHOT=/dir node tools/verify_tap.js   (screenshots of each open card)
const fs = require('fs'), path = require('path'), http = require('http');
let chromium; try { ({chromium} = require('playwright-core')); } catch (e) { ({chromium} = require('playwright')); }
const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const root = path.join(__dirname, '..'), SHOT = process.env.SHOT || '';
const TYPES = {'.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml'};
const srv = http.createServer((q, r) => {
  let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
  const p = path.join(root, u);
  if (!p.startsWith(root)) { r.statusCode = 403; return r.end(); }
  fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader('content-type', TYPES[path.extname(p)] || 'application/octet-stream'); r.end(b); });
}).listen(0, '127.0.0.1');

// each page: how to get to its prices, and when they are drawn
const PAGES = [
  {name: 'nfl', url: '/nfl.html'},
  {name: 'nba', url: '/nba.html', prep: async pg => { await pg.evaluate(() => { try { gotoTab('games'); } catch (e) {} }); }, prefer: '.oc'},
  {name: 'mlb', url: '/index.html', prep: async pg => { await pg.evaluate(() => { try { gotoTab('gamecenter'); } catch (e) {} }); }},
  {name: 'home', url: '/home.html', prefer: '.t10-bet'},
  {name: 'studio', url: '/studio.html?sport=nfl#compare'},
];

async function pick(pg, prefer) {
  // the first visible price onyx-tap.js takes (a real cell from the page, never a planted one); the page's
  // preferred kind first (the NBA game-line cells, the home Top 10)
  return pg.evaluate(prefer => {
    const els = Array.from(document.querySelectorAll('a[href*="onyxodds.com/share"], [onclick*="bet(\'"], [onclick*="betLeg("], [onclick*="onyxTicket("]'));
    const ok = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && window.OnyxTap.accepts(e); });
    if (prefer) ok.sort((a, b) => (b.matches(prefer) ? 1 : 0) - (a.matches(prefer) ? 1 : 0));
    if (!ok.length) return null;
    ok[0].scrollIntoView({block: 'center'});
    const r = ok[0].getBoundingClientRect();
    return {what: (ok[0].className || ok[0].tagName) + ' "' + (ok[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '"', x: r.left + r.width / 2, y: r.top + r.height / 2};
  }, prefer || null);
}

(async () => {
  await new Promise(r => srv.listening ? r() : srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch({...(CHROMIUM ? {executablePath: CHROMIUM} : {}), args: ['--no-sandbox']});
  const out = [];
  const ONLY = process.argv.slice(2).filter(a => !a.startsWith('-'));
  for (const P of PAGES.filter(x => !ONLY.length || ONLY.includes(x.name))) for (const w of [390, 1280]) {
    const touch = w < 700;
    const ctx = await b.newContext({viewport: {width: w, height: touch ? 844 : 900}, hasTouch: touch, deviceScaleFactor: 1});
    const pg = await ctx.newPage(), errs = [];
    let popups = 0; ctx.on('page', () => popups++);
    pg.on('pageerror', e => errs.push(e.message));
    await pg.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith(base + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'}); return u.startsWith(base) ? rt.continue() : rt.abort(); });
    await pg.addInitScript(() => { window.open = function () { window.__opened = (window.__opened || 0) + 1; return null; }; });
    let what = null; const notes = [], bad = [], tag = `${P.name.padEnd(6)} ${String(w).padEnd(5)}`;
    try {
      await pg.goto(base + P.url, {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxTap && window.OnyxTap.accepts, null, {timeout: 15000});
      if (P.prep) await P.prep(pg);
      // wait for the page to draw a price the card takes
      what = null;
      let at = null;
      for (let i = 0; i < 30 && !at; i++) { await pg.waitForTimeout(500); at = await pick(pg, P.prefer); }
      if (!at) { bad.push('no Onyx price on the page that the card takes'); throw 0; }
      what = at.what;
      // tap the price where it is drawn (pages redraw their lists, so no handle is kept on the node)
      const tapIt = async () => {
        let a = await pick(pg, P.prefer); await pg.waitForTimeout(450); a = await pick(pg, P.prefer);       // pick scrolls it into view: measure once it settles
        if (!a) throw new Error('the price left the page');
        if (touch) await pg.touchscreen.tap(a.x, a.y); else await pg.mouse.click(a.x, a.y); };
      await pg.waitForTimeout(300);
      await tapIt();
      await pg.waitForFunction(() => window.OnyxTap.isOpen(), null, {timeout: 4000}).catch(() => {});
      await pg.waitForFunction(() => { const c = document.querySelector('[data-tap-chance]'); return c && /\d%/.test(c.textContent); }, null, {timeout: 8000}).catch(() => {});
      await pg.waitForTimeout(350);
      const r = await pg.evaluate(() => {
        const c = document.querySelector('#oxTap .oxt-c'), q = s => (document.querySelector(s) || {}).textContent || '';
        const bet = document.querySelector('#oxTap [data-tap-bet]'), cr = c ? c.getBoundingClientRect() : null;
        return {open: window.OnyxTap.isOpen(), title: q('#oxtT'), chance: q('[data-tap-chance]'), pay: q('#oxtPay'), profit: q('#oxtPro'),
                href: bet ? bet.href : '', sheet: document.getElementById('oxTap').classList.contains('sheet'), opened: window.__opened || 0,
                inView: cr ? cr.top >= -1 && cr.bottom <= innerHeight + 1 && cr.left >= -1 && cr.right <= innerWidth + 1 : false,
                side: document.documentElement.scrollWidth > innerWidth + 1, focusIn: c ? c.contains(document.activeElement) : false,
                btns: Array.from(document.querySelectorAll('#oxTap .oxt-b [data-a]')).map(x => x.textContent.trim())};
      });
      if (!r.open) bad.push('card did not open');
      if (!/\d%/.test(r.chance)) bad.push('no chance (' + r.chance + ')');
      if (!/^\$\d/.test(r.pay) || !/^\$\d/.test(r.profit)) bad.push('no payout (' + r.pay + ' / ' + r.profit + ')');
      if (!/^https:\/\/app\.onyxodds\.com\//.test(r.href) || !/KR680261|leagues/.test(r.href)) bad.push('no Onyx link (' + r.href.slice(0, 60) + ')');
      if (r.opened || popups) bad.push('the tap opened Onyx as well as the card');
      if (!r.inView) bad.push('card is off screen');
      if (r.side) bad.push('sideways scroll');
      if (r.sheet !== touch) bad.push(touch ? 'not a bottom sheet on a phone' : 'not a popover on desktop');
      if (!r.focusIn) bad.push('focus is not in the card');
      // the stake slider moves the payout
      const pay0 = r.pay;
      await pg.evaluate(() => { const s = document.getElementById('oxtS'); s.value = 500; s.dispatchEvent(new Event('input', {bubbles: true})); });
      const pay1 = await pg.evaluate(() => document.getElementById('oxtPay').textContent);
      if (pay1 === pay0) bad.push('stake slider does not move the payout');
      await pg.evaluate(() => { const s = document.getElementById('oxtS'); s.value = 25; s.dispatchEvent(new Event('input', {bubbles: true})); });
      if (SHOT) { fs.mkdirSync(SHOT, {recursive: true}); await pg.screenshot({path: path.join(SHOT, `tap-${P.name}-${w}.png`)}); }
      // close: Esc on desktop, the close button on a phone
      if (touch) await pg.locator('#oxTap .oxt-x').tap(); else await pg.keyboard.press('Escape');
      await pg.waitForTimeout(400);
      if (await pg.evaluate(() => window.OnyxTap.isOpen() || !document.getElementById('oxTap').hidden)) bad.push('card did not close');
      // straight to Onyx: a long-press on a phone, Ctrl-click on desktop (no card, Onyx opens)
      if (P.name === 'nfl') {
        const o0 = await pg.evaluate(() => window.__opened || 0);
        let a = await pick(pg, P.prefer); await pg.waitForTimeout(450); a = await pick(pg, P.prefer);
        if (touch) {
          const cdp = await ctx.newCDPSession(pg);
          await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: a.x, y: a.y}]});
          await pg.waitForTimeout(700);
          await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        } else { await pg.keyboard.down('Control'); await pg.mouse.click(a.x, a.y); await pg.keyboard.up('Control'); }
        await pg.waitForTimeout(500);
        const d = await pg.evaluate(() => ({open: window.OnyxTap.isOpen(), n: window.__opened || 0}));
        if (d.open) bad.push((touch ? 'long-press' : 'ctrl-click') + ' opened the card');
        else if (d.n <= o0) bad.push((touch ? 'long-press' : 'ctrl-click') + ' did not open Onyx');
        else notes.push(touch ? 'long-press: Onyx' : 'ctrl-click: Onyx');
      }
      // armed parlay builder: the tap adds a leg, no card
      const armed = await pg.evaluate(() => !!(window.OnyxParlay && OnyxParlay.arm));
      if (armed) {
        const n0 = await pg.evaluate(() => { OnyxParlay.clear(); OnyxParlay.arm(true); return OnyxParlay.slip().length; });
        await tapIt();
        await pg.waitForTimeout(1500);
        const a = await pg.evaluate(() => ({open: window.OnyxTap.isOpen(), n: OnyxParlay.slip().length}));
        await pg.evaluate(() => { OnyxParlay.arm(false); OnyxParlay.clear(); });
        if (a.open) bad.push('armed builder: the card opened instead of adding a leg');
        if (a.n !== n0 + 1) bad.push('armed builder: the tap did not add a leg (' + n0 + ' -> ' + a.n + ')');
        else notes.push('armed: leg added');
      }
      // NBA: a player-prop chip keeps the page's own bet card
      if (P.name === 'nba') {
        await pg.evaluate(() => { try { gotoTab('home'); } catch (e) {} }); await pg.waitForTimeout(900);
        const has = await pg.evaluate(() => {
          const c = Array.from(document.querySelectorAll('[onclick*="betLeg("]')).find(e => { const m = /betLeg\((\d+)\)/.exec(e.getAttribute('onclick')); const l = m && window.LEGS[+m[1]]; return l && l.pid && l.stat && e.getBoundingClientRect().width > 0; });
          if (!c) return false; c.setAttribute('data-tap-prop', '1'); c.scrollIntoView({block: 'center'}); return true;
        });
        if (has) {
          const l2 = pg.locator('[data-tap-prop="1"]').first();
          if (touch) await l2.tap(); else await l2.click();
          await pg.waitForTimeout(700);
          const s = await pg.evaluate(() => ({tap: window.OnyxTap.isOpen(), pc: !!(document.getElementById('pc') && document.getElementById('pc').classList.contains('open'))}));
          if (s.tap) bad.push('NBA prop chip opened the tap card over the NBA bet card');
          if (!s.pc) bad.push('NBA prop chip no longer opens the NBA bet card');
          else if (!s.tap) notes.push('prop chip: NBA bet card');
        } else bad.push('no NBA player-prop chip to check the bet card against');
      }
      if (errs.length) bad.push('page errors: ' + errs.join(' | ').slice(0, 240));
      out.push((bad.length ? 'FAIL' : 'ok  ') + ` ${tag} ${what} -> ${bad.length ? bad.join('; ') : `"${r.title.slice(0, 34)}" chance ${r.chance} $25 pays ${pay0} · ${r.btns.join(' / ')}${notes.length ? ' · ' + notes.join(', ') : ''}`}`);
    } catch (e) {
      if (e !== 0) bad.push('error: ' + String(e && e.message || e).split('\n').slice(0, 12).join(' ').slice(0, 900));
      out.push(`FAIL ${tag} ${what || ""} ${bad.join("; ")}`);
    }
    await ctx.close();
  }
  console.log(out.join('\n')); await b.close(); srv.close();
  if (out.some(x => x.startsWith('FAIL'))) { console.error('FAIL: tap'); process.exit(1); }
  console.log('PASS');
})();
