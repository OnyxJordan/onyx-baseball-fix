// verify_alerts_ui.js - "Price alerts + line moves" gate (onyx-alerts.js, 11/17). Not tools/verify_alerts.py (the push
// control center gate). On nfl.html at 390 (touch) and 1280 (mouse), every off-origin request aborted, with
// data/nfl/board.json and data/nfl/moves.json served from this script (route + fulfill) so the price path is known:
//   1. tap a real Onyx price: the quick card shows the move chip, the sparkline and "Moved from X to Y since ..." copy
//   2. set an alert from the card (the 20 cents quick chip, one stepper tap, Alert me): it is saved in onyxPriceAlerts
//   3. a poll with the board unchanged fires nothing; the board is rewritten with a better price, the watcher is run
//      through its test hook, and the banner fires once (a second poll adds nothing), the alert is marked hit, its
//      Bet on Onyx link is the right selection with the referral, a phone notification went out (stubbed), and the
//      banner link is not swallowed by the tap card
//   4. a line alert fires when the line moves; the alerts sheet (OnyxAlerts.open) lists both as hit; the More menu
//      carries the Price alerts row; on home.html alerts.js's OnyxAlerts.mount and this open() live side by side
//   no page errors, no sideways scroll.
//   node tools/verify_alerts_ui.js        SHOT=/dir node tools/verify_alerts_ui.js   (screenshots: card, banner, sheet)
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

const cents = a => a > 0 ? a : a + 200, fromCents = x => x >= 100 ? Math.round(x) : Math.round(x) - 200, odds = a => (a > 0 ? '+' : '') + a;
const share = s => 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(s) + '&referrer=KR680261';
const BOARD0 = JSON.parse(fs.readFileSync(path.join(root, 'data/nfl/board.json'), 'utf8'));

(async () => {
  await new Promise(r => srv.listening ? r() : srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch({...(CHROMIUM ? {executablePath: CHROMIUM} : {}), args: ['--no-sandbox']});
  const out = [];
  for (const w of [390, 1280]) {
    const touch = w < 700, tag = `nfl ${String(w).padEnd(5)}`, bad = [], notes = [];
    const ctx = await b.newContext({viewport: {width: w, height: touch ? 844 : 900}, hasTouch: touch, deviceScaleFactor: 1});
    const pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    // the served board and price path: mutable, so the test can move a price
    let board = JSON.parse(JSON.stringify(BOARD0)), moves = {date: BOARD0.date, sel: {}};
    await pg.route('**/*', rt => {
      const u = rt.request().url();
      if (u.startsWith(base + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'});
      if (u.startsWith(base + '/data/nfl/board.json')) return rt.fulfill({contentType: 'application/json', body: JSON.stringify(board)});
      if (u.startsWith(base + '/data/nfl/moves.json')) return rt.fulfill({contentType: 'application/json', body: JSON.stringify(moves)});
      return u.startsWith(base) ? rt.continue() : rt.abort();
    });
    await pg.addInitScript(() => {
      window.__notes = [];
      // phone notifications: granted, and recorded instead of shown
      function N(t, o) { window.__notes.push({title: t, body: o && o.body, tag: o && o.tag}); }
      N.permission = 'granted'; N.requestPermission = () => Promise.resolve('granted');
      window.Notification = N;
      try { Object.defineProperty(navigator, 'serviceWorker', {value: undefined, configurable: true}); } catch (e) {}
      try { localStorage.removeItem('onyxPriceAlerts'); } catch (e) {}
    });
    let what = '';
    try {
      await pg.goto(base + '/nfl.html', {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxTap && window.OnyxTap.accepts && window.OnyxPriceAlerts, null, {timeout: 15000});
      // a real price cell whose selection is on the board, not a moneyline (so a line alert has a line to move)
      const sels = new Set(board.plays.filter(p => p.kind !== 'ml' && p.line != null).map(p => p.sel));
      let cell = null;
      for (let i = 0; i < 30 && !cell; i++) {
        await pg.waitForTimeout(400);
        cell = await pg.evaluate(sels => {
          const els = Array.from(document.querySelectorAll('a[href*="onyxodds.com/share"], [onclick*="bet(\'"]'));
          for (const e of els) {
            const r = e.getBoundingClientRect(); if (!r.width || !r.height || !window.OnyxTap.accepts(e)) continue;
            const m = /selection=([^&]+)/.exec(e.getAttribute('href') || '') || /\bbet\(\s*'([^']+)'/.exec(e.getAttribute('onclick') || '');
            const sel = m && decodeURIComponent(m[1]); if (!sel || !sels.includes(sel)) continue;
            e.setAttribute('data-pa-test', '1'); e.scrollIntoView({block: 'center'});
            return {sel, text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)};
          }
          return null;
        }, Array.from(sels));
      }
      if (!cell) { bad.push('no Onyx price on nfl.html whose selection is on the board'); throw 0; }
      const row = board.plays.find(p => p.sel === cell.sel), now = row.price;
      what = `"${row.label}" ${odds(now)}`;
      // the seeded price path: opened 15 cents longer, stepped in to now
      const o1 = fromCents(cents(now) + 15), o2 = fromCents(cents(now) + 5);
      const t = k => new Date(Date.now() - k * 3600e3).toISOString().slice(0, 16) + 'Z';
      moves.sel[cell.sel] = [[t(5), o1, row.line], [t(3), o2, row.line], [t(1), now, row.line]];
      await pg.waitForTimeout(400);
      const loc = pg.locator('[data-pa-test="1"]').first();
      if (touch) await loc.tap(); else await loc.click();
      await pg.waitForFunction(() => window.OnyxTap.isOpen(), null, {timeout: 4000}).catch(() => {});
      await pg.waitForFunction(() => { const m = document.querySelector('#oxTap [data-pa-move]'); return m && !m.hidden && m.querySelector('svg'); }, null, {timeout: 8000}).catch(() => {});
      await pg.waitForTimeout(300);
      const c1 = await pg.evaluate(() => {
        const q = s => document.querySelector(s), cr = q('#oxTap .oxt-c') && q('#oxTap .oxt-c').getBoundingClientRect();
        return {open: window.OnyxTap.isOpen(), chip: (q('#oxTap [data-pa-chip]') || {}).textContent || '', move: (q('#oxTap [data-pa-move] p') || {}).textContent || '',
                spark: !!q('#oxTap [data-pa-move] svg polyline'), alert: !!q('#oxTap [data-pa-alert]:not([hidden]) [data-pa="set"]'),
                side: document.documentElement.scrollWidth > innerWidth + 1, inView: cr ? cr.left >= -1 && cr.right <= innerWidth + 1 : false,
                copy: ((q('#oxTap [data-pa-alert] .n') || {}).textContent || '')};
      });
      if (!c1.open) bad.push('card did not open');
      if (!/▼\s*15/.test(c1.chip)) bad.push('no move chip (' + c1.chip + ')');
      if (!c1.spark) bad.push('no sparkline');
      if (c1.move.indexOf('Moved from ' + odds(o1) + ' to ' + odds(now)) !== 0 || !/shorter/.test(c1.move)) bad.push('move copy wrong (' + c1.move + ')');
      if (!c1.alert) bad.push('no alert controls in the card');
      if (!/open or in the background/.test(c1.copy) || !/push service/.test(c1.copy)) bad.push('alert copy does not say where it works');
      if (/—/.test(c1.move + c1.copy)) bad.push('em dash in copy');
      if (c1.side) bad.push('sideways scroll'); if (!c1.inView) bad.push('card off screen');
      // set the alert: 20 cents better, then one stepper tap (+5), then Alert me
      const want = fromCents(cents(now) + 25);
      const click = async s => { const l = pg.locator(s).first(); await l.scrollIntoViewIfNeeded(); if (touch) await l.tap(); else await l.click(); await pg.waitForTimeout(150); };
      await click('#oxTap [data-pa="q"][data-c="20"]');
      await click('#oxTap [data-pa="up"]');
      const btn = await pg.evaluate(() => (document.querySelector('#oxTap [data-pa="set"]') || {}).textContent || '');
      if (btn !== 'Alert me at ' + odds(want)) bad.push('target button reads "' + btn + '", want ' + odds(want));
      if (SHOT) { fs.mkdirSync(SHOT, {recursive: true}); await pg.locator('#oxTap [data-pa-alert]').scrollIntoViewIfNeeded(); await pg.screenshot({path: path.join(SHOT, `alerts-card-${w}.png`)}); }
      await click('#oxTap [data-pa="set"]');
      const saved = await pg.evaluate(() => JSON.parse(localStorage.getItem('onyxPriceAlerts') || '[]'));
      const al = saved.find(a => a.sel === cell.sel);
      if (!al || al.st !== 'on' || al.target !== want) bad.push('alert not saved at ' + odds(want) + ' (' + JSON.stringify(al || null).slice(0, 120) + ')');
      const setTxt = await pg.evaluate(() => (document.querySelector('#oxTap [data-pa-alert] .set') || {}).textContent || '');
      if (!/Alert set/.test(setTxt)) bad.push('card does not show the alert as set');
      // close the card; a poll on the unchanged board fires nothing
      if (touch) await pg.locator('#oxTap .oxt-x').tap(); else await pg.keyboard.press('Escape');
      await pg.waitForTimeout(300);
      let fired = await pg.evaluate(() => OnyxPriceAlerts._test.poll().then(f => f.length));
      if (fired) bad.push('fired on an unchanged board');
      // a line alert on another play with a line
      const other = board.plays.find(p => p.sel !== cell.sel && p.kind === 'spread' && p.line != null && Date.parse(p.start) > Date.now());
      if (other) await pg.evaluate(p => OnyxPriceAlerts.add(p, {line: true}), other);
      // the price gets there: rewrite the board (the target exactly), then fast-forward the watcher
      board = JSON.parse(JSON.stringify(BOARD0));
      board.plays.find(p => p.sel === cell.sel).price = want;
      if (other) { const o = board.plays.find(p => p.sel === other.sel); o.line = o.line + 1; o.price = -110; }
      fired = await pg.evaluate(() => OnyxPriceAlerts._test.poll().then(f => f.map(a => a.sel)));
      await pg.waitForTimeout(250);
      const again = await pg.evaluate(() => OnyxPriceAlerts._test.poll().then(f => f.length));
      const h = await pg.evaluate(sel => {
        const L = JSON.parse(localStorage.getItem('onyxPriceAlerts') || '[]'), a = L.find(x => x.sel === sel);
        const bs = Array.from(document.querySelectorAll('#oxPaHit [data-pa-hit]'));
        const mine = bs.find(x => x.getAttribute('data-pa-hit') === (a && a.id));
        return {st: a && a.st, hit: a && a.hit, banners: bs.length, mine: bs.filter(x => x.getAttribute('data-pa-hit') === (a && a.id)).length,
                href: mine ? (mine.querySelector('[data-pa-bet]') || {}).href : '', text: mine ? mine.textContent : '', notes: window.__notes.slice(),
                slip: !!(mine && mine.querySelector('[data-pa-slip]')), lines: L.filter(x => x.kind === 'line').map(x => x.st)};
      }, cell.sel);
      if (!fired.includes(cell.sel)) bad.push('the better price did not fire the alert');
      if (again) bad.push('a second poll fired again');
      if (h.st !== 'hit' || !h.hit || h.hit.price !== want) bad.push('alert not marked hit (' + h.st + ')');
      if (h.mine !== 1) bad.push('banner shown ' + h.mine + ' times');
      if (h.href !== share(cell.sel)) bad.push('banner Onyx link wrong (' + h.href + ')');
      if (!h.slip) bad.push('no parlay slip button on the banner');
      if (!h.notes.some(n => /onyx-win-pa-/.test(n.tag || '') && (n.body || '').indexOf(odds(want)) >= 0)) bad.push('no phone notification');
      if (other && h.lines[0] !== 'hit') bad.push('line alert did not fire on a line move');
      if (/—/.test(h.text)) bad.push('em dash in the banner');
      if (/draftkings|fanduel/i.test(h.text)) bad.push('another book named');
      if (SHOT) await pg.screenshot({path: path.join(SHOT, `alerts-hit-${w}.png`)});
      // the banner's Onyx link goes to Onyx (the tap card leaves it alone)
      const pop = ctx.waitForEvent('page', {timeout: 3000}).catch(() => null);
      await pg.locator(`#oxPaHit [data-pa-hit] [data-pa-bet]`).first().click();
      const pp = await pop; await pg.waitForTimeout(200);
      if (await pg.evaluate(() => window.OnyxTap.isOpen())) bad.push('the banner link opened the tap card');
      if (!pp) bad.push('the banner link opened nothing'); else await pp.close().catch(() => {});
      // the sheet: OnyxAlerts.open(), both alerts listed as hit with Onyx links; the More menu row
      const sh = await pg.evaluate(() => { OnyxAlerts.open(); const s = document.getElementById('oxPa');
        return {open: s && !s.hidden, hits: s.querySelectorAll('.it.hit').length, links: Array.from(s.querySelectorAll('.it.hit [data-pa="bet"]')).map(a => a.href),
                menu: !!document.querySelector('.osheet [data-act="price-alerts"]'), side: document.documentElement.scrollWidth > innerWidth + 1, text: s.textContent}; });
      if (!sh.open) bad.push('alerts sheet did not open');
      if (sh.hits !== (other ? 2 : 1)) bad.push('sheet shows ' + sh.hits + ' hit alerts');
      if (!sh.links.includes(share(cell.sel))) bad.push('sheet Onyx link wrong');
      if (!sh.menu) bad.push('no Price alerts row in the More menu');
      if (sh.side) bad.push('sideways scroll with the sheet open');
      if (/—/.test(sh.text)) bad.push('em dash in the sheet');
      if (SHOT) await pg.screenshot({path: path.join(SHOT, `alerts-sheet-${w}.png`)});
      await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
      if (await pg.evaluate(() => !document.getElementById('oxPa').hidden)) bad.push('sheet did not close on Esc');
      notes.push(`chip ${c1.chip.trim()}`, `alert ${odds(want)} hit`, other ? 'line alert hit' : 'no spread for a line alert');
      // home.html: alerts.js owns OnyxAlerts.mount; this script adds open beside it
      await pg.goto(base + '/home.html', {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxPriceAlerts, null, {timeout: 15000}).catch(() => {});
      const hm = await pg.evaluate(() => ({mount: !!(window.OnyxAlerts && typeof OnyxAlerts.mount === 'function'), open: !!(window.OnyxAlerts && typeof OnyxAlerts.open === 'function')}));
      if (!hm.mount || !hm.open) bad.push('home.html OnyxAlerts: mount ' + hm.mount + ', open ' + hm.open);
      if (errs.length) bad.push('page errors: ' + errs.join(' | ').slice(0, 240));
    } catch (e) {
      if (e !== 0) bad.push('error: ' + String(e && e.message || e).split('\n').slice(0, 8).join(' ').slice(0, 600));
    }
    out.push((bad.length ? 'FAIL' : 'ok  ') + ` ${tag} ${what} -> ${bad.length ? bad.join('; ') : notes.join(' · ')}`);
    await ctx.close();
  }
  console.log(out.join('\n')); await b.close(); srv.close();
  if (out.some(x => x.startsWith('FAIL'))) { console.error('FAIL: alerts ui'); process.exit(1); }
  console.log('PASS');
})();
