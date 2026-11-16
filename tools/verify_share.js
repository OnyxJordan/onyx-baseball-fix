// verify_share.js - Shareable bet cards gate (onyx-share.js, 11/16). On home.html at 390 (touch) and 1280 (mouse),
// every off-origin request aborted, it draws every kind of card (single, a 4-leg parlay with long names, cashed, a
// live ticket, season) at both sizes and fails unless: the canvas is 1080x1920 / 1080x1080, it is really drawn (the
// share of non-background pixels), and no text box leaves the canvas, overflows its slot or runs into the footer
// (onyx-share.js records every text box it draws). Then the sheet: it opens, shows the preview, switches story /
// square, closes (Esc on desktop, the close button on a phone); with no navigator.share the button saves the PNG
// (a real download) and copies the Onyx link; with a stubbed navigator.share the PNG file and the Onyx link are
// handed over and gtag counts share_card. Hooks: the parlay slip's Share slip, the quick bet card's share icon, the
// Studio Lab's share button (with the lab's true chance), and OnyxShare.button(). No page errors, no sideways scroll.
//   node tools/verify_share.js          SHOT=/dir node tools/verify_share.js   (card PNGs + sheet screenshots)
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

const later = h => new Date(Date.now() + h * 3600e3).toISOString();
const CARDS = {
  single: {kind: 'single', price: 145, chance: 0.47, sels: ['0QA123ABC'],
    legs: [{label: 'Kansas City Chiefs to win', matchup: 'Buffalo Bills @ Kansas City Chiefs · Sun 4:25 PM', price: 145, conf: 0.47, sport: 'nfl', sel: '0QA123ABC'}]},
  parlay: {kind: 'parlay', price: 1265, chance: 0.081, sels: ['s1', 's2', 's3', 's4'], legs: [
    {label: 'Giannis Antetokounmpo Under 11.5 rebounds + assists combined', matchup: 'Milwaukee Bucks @ Oklahoma City Thunder', price: -115, conf: 0.58, sport: 'nba', sel: 's1'},
    {label: 'Amon-Ra St. Brown Over 84.5 receiving yards', matchup: 'Detroit Lions @ Philadelphia Eagles', price: -110, conf: 0.55, sport: 'nfl', sel: 's2'},
    {label: 'Christian McCaffrey anytime touchdown scorer', matchup: 'San Francisco 49ers @ Los Angeles Rams', price: 105, conf: 0.52, sport: 'nfl', sel: 's3'},
    {label: 'Alexander Zverev to win', matchup: 'Alexander Zverev vs Stefanos Tsitsipas · ATP Finals Turin', price: 120, conf: 0.49, sport: 'tennis', sel: 's4'}]},
  cashed: {kind: 'cashed', price: 596, chance: 0.17, sels: ['c1', 'c2', 'c3'], legs: [
    {label: 'Detroit Lions -3.5', matchup: 'Detroit Lions @ Philadelphia Eagles', price: -110, conf: 0.56, sport: 'nfl', res: 'W'},
    {label: 'Over 48.5 total points', matchup: 'Detroit Lions @ Philadelphia Eagles', price: -105, conf: 0.53, sport: 'nfl', res: 'W'},
    {label: 'Connor McDavid Over 1.5 points', matchup: 'Edmonton Oilers @ Dallas Stars', price: 140, conf: 0.44, sport: 'nhl', res: 'W'}]},
  live: {kind: 'parlay', price: 264, chance: 0.29, sels: ['l1', 'l2'], live: {p: 0.64, now: 'Leg 1 cashed · Celtics up 8, 4:12 left in Q3'}, legs: [
    {label: 'Jayson Tatum Over 26.5 points', matchup: 'Boston Celtics @ New York Knicks', price: -105, conf: 0.53, sport: 'nba', res: 'W'},
    {label: 'Boston Celtics -4.5', matchup: 'Boston Celtics @ New York Knicks', price: -110, conf: 0.55, sport: 'nba'}]},
  season: {kind: 'season', title: 'My season', stats: {record: '42-31-2', units: 12.4, roi: 0.084,
    best: {label: 'Christian McCaffrey + Rams Under 44.5, 3-leg parlay', price: 612, sport: 'nfl'},
    sports: [{sport: 'nfl', record: '18-11-1', units: 9.2}, {sport: 'nba', record: '14-12', units: 2.1}, {sport: 'nhl', record: '6-5-1', units: -0.6}, {sport: 'cfb', record: '4-3', units: 1.7}]}},
};
// a 12-leg slip: the card must show what fits and say how many more
CARDS.long = {kind: 'parlay', sels: [], legs: Array.from({length: 12}, (_, i) => ({label: 'Very long player name number ' + (i + 1) + ' Over 249.5 passing yards and more words', matchup: 'Some Extremely Long Team Name @ Another Extremely Long Team Name', price: -110 + i * 7, conf: 0.5, sport: ['nfl', 'nba', 'cbb'][i % 3]}))};

const NO_SHARE = () => { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch (e) {} };
const STUB_SHARE = () => {
  window.__shared = null; window.__gt = [];
  window.gtag = function () { window.__gt.push(Array.from(arguments)); };
  Navigator.prototype.canShare = function (d) { return !!d; };
  Navigator.prototype.share = function (d) { window.__shared = {title: d.title, text: d.text, url: d.url, files: (d.files || []).map(f => ({name: f.name, type: f.type, size: f.size}))}; return Promise.resolve(); };
};

(async () => {
  await new Promise(r => srv.listening ? r() : srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch({...(CHROMIUM ? {executablePath: CHROMIUM} : {}), args: ['--no-sandbox']});
  const out = [];
  if (SHOT) fs.mkdirSync(SHOT, {recursive: true});
  for (const w of [390, 1280]) {
    const touch = w < 700, tag = String(w).padEnd(5);
    const mk = async (init) => {
      const ctx = await b.newContext({viewport: {width: w, height: touch ? 844 : 900}, hasTouch: touch, deviceScaleFactor: 1, acceptDownloads: true});
      const pg = await ctx.newPage(), errs = [];
      pg.on('pageerror', e => errs.push(e.message));
      await pg.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith(base + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'}); return u.startsWith(base) ? rt.continue() : rt.abort(); });
      await pg.addInitScript(() => { window.open = function () { window.__opened = (window.__opened || 0) + 1; return null; }; });
      if (init) await pg.addInitScript(init);
      return {ctx, pg, errs};
    };
    // ── 1. the cards themselves ────────────────────────────────────────────────────────────────────────────
    {
      const {ctx, pg, errs} = await mk(NO_SHARE), bad = [], notes = [];
      await pg.goto(base + '/home.html', {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxShare && window.OnyxShare.render, null, {timeout: 15000}).catch(() => bad.push('OnyxShare never loaded'));
      await pg.evaluate(() => window.OnyxShare && OnyxShare.fonts());
      for (const kind of Object.keys(CARDS)) for (const size of ['story', 'square']) {
        const r = await pg.evaluate(([card, size]) => {
          const cv = OnyxShare.render(card, size), x = cv.getContext('2d'), d = x.getImageData(0, 0, cv.width, cv.height).data;
          let ink = 0, n = 0;
          for (let i = 0; i < d.length; i += 4 * 37) { n++; if (Math.abs(d[i] - 12) + Math.abs(d[i + 1] - 12) + Math.abs(d[i + 2] - 12) > 40) ink++; }
          const B = OnyxShare.layout(), foot = Math.min.apply(null, B.filter(b => b.zone === 'foot').map(b => b.top));
          const over = B.filter(b => b.x0 < 24 || b.x1 > cv.width - 24 || b.top < 0 || b.bottom > cv.height || b.x1 - b.x0 > b.maxW + 1).map(b => b.s);
          const intoFoot = B.filter(b => b.zone === 'body' && b.bottom > foot - 40).map(b => b.s);
          const cut = B.filter(b => /…$/.test(b.s)).length;
          // a text box is inside a panel or clear of it, never half in (a line spilling out of its box)
          const Pn = OnyxShare.panels(), straddle = B.filter(b => Pn.some(p => {
            const inside = b.x0 >= p.x0 - 1 && b.x1 <= p.x1 + 1 && b.top >= p.y0 - 1 && b.bottom <= p.y1 + 1;
            const clear = b.x1 <= p.x0 || b.x0 >= p.x1 || b.bottom <= p.y0 || b.top >= p.y1;
            return !inside && !clear; })).map(b => b.s);
          return {w: cv.width, h: cv.height, ink: ink / n, over, intoFoot, straddle, n: B.length, cut, url: cv.toDataURL('image/png'),
                  text: B.map(b => b.s).join(' | ')};
        }, [CARDS[kind], size]);
        const want = size === 'story' ? [1080, 1920] : [1080, 1080];
        const t = kind + '/' + size;
        if (r.w !== want[0] || r.h !== want[1]) bad.push(t + ': canvas ' + r.w + 'x' + r.h);
        if (r.ink < 0.05) bad.push(t + ': looks blank (' + (100 * r.ink).toFixed(1) + '% ink)');
        if (r.over.length) bad.push(t + ': text overflows: ' + r.over.slice(0, 3).join(' / '));
        if (r.straddle.length) bad.push(t + ': text spills out of its panel: ' + r.straddle.slice(0, 3).join(' / '));
        if (r.intoFoot.length) bad.push(t + ': text runs into the footer: ' + r.intoFoot.slice(0, 3).join(' / '));
        if (/—/.test(r.text)) bad.push(t + ': em dash in the card');
        if (!/KR680261/.test(r.text) || !/onyxodds\.com/.test(r.text)) bad.push(t + ': no Onyx footer');
        if (/\block\b|draftkings|fanduel|caesars|betmgm/i.test(r.text)) bad.push(t + ': banned word in copy');
        if (kind === 'cashed' && !/MODEL HAD IT/.test(r.text)) bad.push(t + ': cashed card has no model line');
        if (kind === 'live' && !/LIVE CHANCE/.test(r.text)) bad.push(t + ': live card has no live chance');
        if (kind === 'long' && !/more legs? on this ticket/.test(r.text)) bad.push(t + ': 12 legs and no "more legs" line');
        if (kind === 'season' && !/42-31-2/.test(r.text)) bad.push(t + ': season card has no record');
        if (SHOT && w === 1280) fs.writeFileSync(path.join(SHOT, `share-${kind}-${size}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
        notes.push(`${t} ${(100 * r.ink).toFixed(0)}%ink ${r.n}txt${r.cut ? ' ' + r.cut + 'cut' : ''}`);
      }
      // ── 2. the sheet: open, preview, size toggle, close; the download fallback with no navigator.share ──
      for (const kind of ['parlay', 'season']) {
        await pg.evaluate(c => { try { localStorage.removeItem('onyxShareSize'); } catch (e) {} OnyxShare.open(c); }, CARDS[kind]);
        await pg.waitForFunction(() => { const r = document.getElementById('oxShare'); return r && r.getAttribute('data-ready'); }, null, {timeout: 6000}).catch(() => bad.push(kind + ' sheet: preview never drew'));
        await pg.waitForTimeout(350);
        let s = await pg.evaluate(() => {
          const c = document.querySelector('#oxShare .oxsh-c'), im = document.querySelector('#oxShare [data-share-img]'), cr = c.getBoundingClientRect();
          return {open: OnyxShare.isOpen(), size: document.getElementById('oxShare').getAttribute('data-ready'), iw: im.naturalWidth, ih: im.naturalHeight,
                  inView: cr.top >= -1 && cr.bottom <= innerHeight + 1 && cr.left >= -1 && cr.right <= innerWidth + 1, side: document.documentElement.scrollWidth > innerWidth + 1,
                  pri: (document.querySelector('#oxShare .pri') || {}).textContent, focus: c.contains(document.activeElement)};
        });
        if (!s.open) bad.push(kind + ' sheet did not open');
        if (s.iw !== 1080 || s.ih !== 1920) bad.push(kind + ' sheet: preview is ' + s.iw + 'x' + s.ih + ' (want story 1080x1920)');
        if (!s.inView) bad.push(kind + ' sheet is off screen');
        if (s.side) bad.push(kind + ' sheet: sideways scroll');
        if (!s.focus) bad.push(kind + ' sheet: focus not in the sheet');
        if (SHOT) await pg.screenshot({path: path.join(SHOT, `share-sheet-${kind}-story-${w}.png`)});
        if (touch) await pg.locator('#oxShare [data-size="square"]').tap(); else await pg.click('#oxShare [data-size="square"]');
        await pg.waitForFunction(() => document.getElementById('oxShare').getAttribute('data-ready') === 'square', null, {timeout: 6000}).catch(() => bad.push(kind + ' sheet: square never drew'));
        await pg.waitForTimeout(200);
        s = await pg.evaluate(() => { const im = document.querySelector('#oxShare [data-share-img]'), cr = document.querySelector('#oxShare .oxsh-c').getBoundingClientRect();
          return {iw: im.naturalWidth, ih: im.naturalHeight, inView: cr.top >= -1 && cr.bottom <= innerHeight + 1}; });
        if (s.iw !== 1080 || s.ih !== 1080) bad.push(kind + ' sheet: square preview is ' + s.iw + 'x' + s.ih);
        if (!s.inView) bad.push(kind + ' sheet (square) is off screen');
        if (SHOT) await pg.screenshot({path: path.join(SHOT, `share-sheet-${kind}-square-${w}.png`)});
        if (kind === 'parlay') {
          // no navigator.share here: the main button saves the PNG and copies the link
          if (!/Save image/.test(s.pri || (await pg.evaluate(() => document.querySelector('#oxShare .pri').textContent)))) bad.push('no-share: main button is not Save image');
          const dl = pg.waitForEvent('download', {timeout: 6000}).catch(() => null);
          if (touch) await pg.locator('#oxShare .pri').tap(); else await pg.click('#oxShare .pri');
          const d = await dl;
          if (!d) bad.push('download fallback: no download');
          else {
            const fp = await d.path().catch(() => null), sz = fp ? fs.statSync(fp).size : 0;
            if (!/^onyx-parlay-square\.png$/.test(d.suggestedFilename()) || sz < 20000) bad.push('download fallback: ' + d.suggestedFilename() + ' ' + sz + ' bytes');
            else notes.push('download ' + Math.round(sz / 1024) + 'KB');
          }
          await pg.waitForTimeout(300);
          const nt = await pg.evaluate(() => document.querySelector('#oxShare [data-share-note]').textContent);
          if (!/link copied/.test(nt)) bad.push('download fallback: link not copied (' + nt + ')');
          const u = await pg.evaluate(c => OnyxShare.url(c), CARDS.parlay);
          if (u !== 'https://app.onyxodds.com/share?selection=s1&selection=s2&selection=s3&selection=s4&referrer=KR680261') bad.push('share url: ' + u);
        }
        if (touch) await pg.locator('#oxShare .oxsh-x').tap(); else await pg.keyboard.press('Escape');
        await pg.waitForTimeout(400);
        if (await pg.evaluate(() => OnyxShare.isOpen() || !document.getElementById('oxShare').hidden)) bad.push(kind + ' sheet did not close');
      }
      // OnyxShare.button(): a delegated click opens the sheet
      await pg.evaluate(c => { const d = document.createElement('div'); d.id = 'shTest'; d.style.cssText = 'position:fixed;top:120px;left:20px;z-index:5000'; d.innerHTML = OnyxShare.button(c, 'Share my season'); document.body.appendChild(d); }, CARDS.season);
      await pg.click('#shTest .ox-share-btn');
      await pg.waitForTimeout(300);
      if (!(await pg.evaluate(() => OnyxShare.isOpen() && OnyxShare.current().card.kind === 'season'))) bad.push('OnyxShare.button did not open the season card');
      await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
      if (await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) bad.push('sideways scroll');
      if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
      out.push(`${bad.length ? 'FAIL' : 'ok  '} cards  ${tag} ${bad.length ? bad.join('; ') : notes.join(', ')}`);
      await ctx.close();
    }
    // ── 3. navigator.share: the PNG file and the Onyx link are handed over, gtag counts it ───────────────────
    {
      const {ctx, pg, errs} = await mk(STUB_SHARE), bad = [];
      await pg.goto(base + '/home.html', {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxShare && window.OnyxShare.open, null, {timeout: 15000});
      await pg.evaluate(c => OnyxShare.open(c), CARDS.cashed);
      await pg.waitForFunction(() => document.getElementById('oxShare').getAttribute('data-ready'), null, {timeout: 6000}).catch(() => {});
      const pri = await pg.evaluate(() => document.querySelector('#oxShare .pri').textContent);
      if (pri !== 'Share card') bad.push('main button with Web Share is "' + pri + '"');
      if (touch) await pg.locator('#oxShare .pri').tap(); else await pg.click('#oxShare .pri');
      await pg.waitForFunction(() => window.__shared, null, {timeout: 5000}).catch(() => {});
      const r = await pg.evaluate(() => ({s: window.__shared, gt: window.__gt}));
      if (!r.s) bad.push('navigator.share was not called');
      else {
        if (!r.s.files.length || r.s.files[0].type !== 'image/png' || r.s.files[0].size < 20000) bad.push('no PNG file shared ' + JSON.stringify(r.s.files));
        if (r.s.url !== 'https://app.onyxodds.com/share?selection=c1&selection=c2&selection=c3&referrer=KR680261') bad.push('shared url ' + r.s.url);
        if (/\block\b|—/i.test(r.s.text + r.s.title)) bad.push('share text: ' + r.s.text);
      }
      if (!r.gt.some(a => a[0] === 'event' && a[1] === 'share_card' && a[2] && a[2].kind === 'cashed')) bad.push('gtag share_card not counted');
      if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
      out.push(`${bad.length ? 'FAIL' : 'ok  '} share  ${tag} ${bad.length ? bad.join('; ') : 'PNG ' + Math.round(r.s.files[0].size / 1024) + 'KB + link, "' + r.s.text.slice(0, 70) + '..."'}`);
      await ctx.close();
    }
    // ── 4. the hooks: parlay slip, quick bet card, Studio Lab ────────────────────────────────────────────────
    {
      const {ctx, pg, errs} = await mk(), bad = [], notes = [];
      await pg.goto(base + '/nfl.html', {waitUntil: 'domcontentloaded'});
      await pg.waitForFunction(() => window.OnyxShare && window.OnyxParlay && window.OnyxTap, null, {timeout: 15000}).catch(() => bad.push('scripts did not load'));
      // the slip: two legs, open it, Share slip
      await pg.evaluate(([a, b]) => { OnyxParlay.clear(); OnyxParlay.add(a); OnyxParlay.add(b); }, [
        {sel: 'x1', label: 'Detroit Lions -3.5', matchup: 'Detroit Lions @ Philadelphia Eagles', price: -110, conf: 0.56, sport: 'nfl', kind: 'spread', gid: 'g1', start: later(30)},
        {sel: 'x2', label: 'Over 44.5', matchup: 'Rams @ 49ers', price: -105, conf: 0.52, sport: 'nfl', kind: 'total', gid: 'g2', start: later(31)}].map(x => Object.assign({}, x)));
      await pg.evaluate(() => { const f = document.querySelector('#oxPB [data-pb="fab"]'); f.click(); f.click(); });   // arm then disarm leaves it open
      await pg.waitForTimeout(300);
      const hasBtn = await pg.evaluate(() => !!document.querySelector('#oxPB [data-pb="share"]'));
      if (!hasBtn) bad.push('slip has no Share slip button');
      else {
        await pg.evaluate(() => document.querySelector('#oxPB [data-pb="share"]').click());
        await pg.waitForTimeout(300);
        const c = await pg.evaluate(() => OnyxShare.current());
        if (!c || c.card.kind !== 'parlay' || c.card.legs.length !== 2 || c.card.sels.join() !== 'x1,x2') bad.push('slip share card wrong: ' + JSON.stringify(c && c.card).slice(0, 120));
        else notes.push('slip: parlay ' + c.card.price + ' ' + (100 * c.card.chance).toFixed(1) + '%');
        await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
      }
      await pg.evaluate(() => OnyxParlay.clear());
      // the quick bet card: share icon
      await pg.evaluate(t => OnyxTap.open({sel: 'q1', label: 'Jahmyr Gibbs Over 72.5 rushing yards', matchup: 'Detroit Lions @ Philadelphia Eagles', price: -115, conf: 0.57, sport: 'nfl', kind: 'prop', start: t}, null), later(30));
      await pg.waitForTimeout(300);
      const tapSh = await pg.$('#oxTap .oxt-sh');
      if (!tapSh) bad.push('quick bet card has no share icon');
      else {
        if (SHOT) await pg.screenshot({path: path.join(SHOT, `share-tapcard-${w}.png`)});
        if (touch) await tapSh.tap(); else await tapSh.click();
        await pg.waitForTimeout(400);
        const c = await pg.evaluate(() => ({cur: OnyxShare.current(), tap: OnyxTap.isOpen()}));
        if (!c.cur || c.cur.card.kind !== 'single' || c.cur.card.price !== -115 || Math.abs(c.cur.card.chance - 0.57) > 1e-9) bad.push('tap share card wrong: ' + JSON.stringify(c.cur && c.cur.card).slice(0, 120));
        else notes.push('tap card: single');
        if (c.tap) bad.push('quick bet card stayed open under the share sheet');
        await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
      }
      if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
      // the Studio Lab: two legs from the board, then share with the lab's true chance
      const st = await ctx.newPage(), serr = [];
      st.on('pageerror', e => serr.push(e.message));
      await st.goto(base + '/studio.html?sport=nfl', {waitUntil: 'domcontentloaded'});
      await st.waitForFunction(() => window.Studio && window.OnyxParlay && window.OnyxShare && document.querySelectorAll('.st-tab').length, null, {timeout: 15000}).catch(() => bad.push('studio did not load'));
      await st.evaluate(() => { OnyxParlay.clear(); Studio.show('lab'); });
      await st.waitForFunction(() => document.querySelectorAll('#st-lab [data-add]').length >= 2, null, {timeout: 10000}).catch(() => {});
      await st.evaluate(() => { const a = document.querySelectorAll('#st-lab [data-add]'); a[0].click(); });
      await st.waitForTimeout(300);
      await st.evaluate(() => { const a = Array.from(document.querySelectorAll('#st-lab [data-add]')).filter(b => !b.classList.contains('on')); if (a[3]) a[3].click(); });
      await st.waitForTimeout(600);
      const lab = await st.evaluate(() => { const b = document.querySelector('#st-lab [data-share]'); return b ? {n: OnyxParlay.slip().length} : null; });
      if (!lab) bad.push('studio lab has no share button');
      else {
        await st.evaluate(() => document.querySelector('#st-lab [data-share]').click());
        await st.waitForTimeout(400);
        const c = await st.evaluate(() => { const c = OnyxShare.current(); const big = document.querySelector('#st-lab .sx-big.sx-pur'); return {c: c && c.card, shown: big ? big.textContent : null}; });
        if (!c.c) bad.push('studio lab share did not open');
        else {
          const want = c.shown ? parseFloat(c.shown) : null, got = c.c.chance != null ? 100 * c.c.chance : null;
          if (lab.n >= 2 && (want == null || got == null || Math.abs(want - got) > (want < 10 ? 0.06 : 0.6))) bad.push('lab chance ' + got + ' vs shown ' + c.shown);
          else notes.push('lab: ' + c.c.kind + ' ' + c.c.legs.length + ' legs, chance ' + (got == null ? '-' : got.toFixed(2) + '%') + ' (lab shows ' + c.shown + ')');
        }
        if (SHOT) await st.screenshot({path: path.join(SHOT, `share-lab-sheet-${w}.png`)});
        await st.keyboard.press('Escape'); await st.waitForTimeout(300);
      }
      await st.evaluate(() => OnyxParlay.clear());
      if (serr.length) bad.push('studio page errors: ' + serr.slice(0, 3).join(' | '));
      out.push(`${bad.length ? 'FAIL' : 'ok  '} hooks  ${tag} ${bad.length ? bad.join('; ') : notes.join(', ')}`);
      await ctx.close();
    }
  }
  await b.close(); srv.close();
  console.log(out.join('\n'));
  const fail = out.filter(l => l.startsWith('FAIL')).length;
  console.log(fail ? `\n${fail} FAILED` : '\nverify_share: all passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
