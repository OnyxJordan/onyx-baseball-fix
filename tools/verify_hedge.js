#!/usr/bin/env node
/**
 * verify_hedge.js - hedge / lock profit, live (onyx-hedge.js, hooked into onyx-cash.js), dev + CI.
 *
 * 1. The math (OnyxHedge.math, in the page): the equal-profit hedge (R = stake x dec(ticket), H = R / dec(hedge),
 *    lock = R - H - stake, the same profit both ways), a partial hedge at $0 (ride it) and at the full hedge, and a
 *    negative lock when the hedge price is bad. American odds in, both signs.
 * 2. A faked live night (Playwright route + fulfill for ESPN and the live relay): a 3-leg parlay saved in My picks
 *    (+600, 2 units = $20) whose first two legs won (Jaylen Brown over 15.5 pts at 22; BUF to win, final 27-20) and
 *    whose last leg, BOS -3.5, is live (BOS up 10, 10:00 left in the 4th). The relay quotes NY +3.5 at +150 with an
 *    Onyx selection id. On home.html at 390 and 1280 px:
 *      - the OnyxCash meter on My picks shows "Hedge available: lock $64" (R $140, H $56, lock $64)
 *      - the chip opens the sheet: hedge $56.00 on NY +3.5 at +150, locked +$64.00, the math lines, the ride-it read
 *        with the live chance and the projection caveat; "Hedge on Onyx" links the selection with referrer KR680261
 *      - the slider: $0 -> +$120.00 / -$20.00, full -> +$64.00 / +$64.00; a bad typed price shows "No lock"
 *      - "Copy amounts" copies the amounts
 *      - the live rail shows a "Lock $64" chip next to the bet, and the rail stays 44 px tall
 *      - the standalone calculator (OnyxHedge.calc) works for any price + stake + hedge price, and the quick bet card
 *        (OnyxTap) carries a "Hedge calculator" link that opens it with the card's price
 *      - no sideways scroll, sheet on screen, no em dash, no NaN / undefined / null, no yellow, no page errors
 *
 *   node tools/verify_hedge.js [--shots=dir] [--w=390,1280]
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const SHOTS = arg('shots', process.env.SHOT || '');
const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (rel === 'ai.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"url":"http://relay.stub"}'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function teamEvent(id, start, st, away, home) {
  const status = { period: st.period, clock: st.clock, type: { state: st.state, shortDetail: st.detail, detail: st.detail, completed: st.state === 'post' } };
  const c = (ab, name, sc, ha) => ({ homeAway: ha, score: String(sc), team: { abbreviation: ab, displayName: name } });
  return { id, date: start, name: away[1] + ' at ' + home[1], status,
    competitions: [{ id, date: start, status, competitors: [c(home[0], home[1], home[2], 'home'), c(away[0], away[1], away[2], 'away')] }] };
}
function nbaBox() {
  const row = (n, pts, reb, ast, th) => ({ athlete: { displayName: n }, stats: ['30', String(pts), String(reb), String(ast), th] });
  return {
    header: { competitions: [{ status: { period: 4, type: { state: 'in' } }, competitors: [] }] },
    boxscore: { players: [{ team: { abbreviation: 'BOS' }, statistics: [{ labels: ['MIN', 'PTS', 'REB', 'AST', '3PT'], keys: ['minutes', 'points', 'rebounds', 'assists', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'],
      athletes: [row('Jaylen Brown', 22, 5, 2, '3-5'), row('Jayson Tatum', 18, 6, 4, '2-6')] }] }] },
  };
}

const TICKET = 't:hedge:3';
function saved(start) {
  const brown = { id: 'h:brown', sport: 'nba', kind: 'prop', name: 'Jaylen Brown', team: 'BOS', mkt: 'pts', side: 'over', line: 15.5, conf: 0.6, price: -115,
                  label: 'Jaylen Brown Over 15.5 points', matchup: 'BOS @ NY', start, gid: '501' };
  const buf = { id: 'h:buf', sport: 'nfl', kind: 'ml', name: 'BUF', team: 'BUF', gid: '401', label: 'BUF to win', matchup: 'BUF @ KC', start, conf: 0.48, price: 110 };
  const bos = { id: 'h:bos', sport: 'nba', kind: 'spread', name: 'BOS', team: 'BOS', hcap: -3.5, conf: 0.52, price: -110, label: 'BOS -3.5', matchup: 'BOS @ NY', start, gid: '501' };
  return [{ id: TICKET, kind: 'parlay', sport: 'multi', label: '3-leg parlay', matchup: 'Brown o15.5 + BUF + BOS -3.5', start, conf: 0.2, price: 550, my_price: 600, stake: 2,
            saved: start, legs: [brown, buf, bos] }];
}

async function run(browser, base, w) {
  const bad = [];
  const phone = w < 761;
  const NOW = Date.now(), start = new Date(NOW - 90 * 60e3).toISOString();
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, ...(phone ? { userAgent: UA } : {}) });
  await ctx.addInitScript(([list, tk]) => {
    try {
      localStorage.setItem('onyx-new-2026-10-26b', '1');
      if (!sessionStorage.getItem('hedgeSeeded')) { localStorage.setItem('onyxSaved', JSON.stringify(list)); sessionStorage.setItem('hedgeSeeded', '1'); }
      localStorage.setItem('onyxWinShown', JSON.stringify({ 'h:brown': Date.now(), 'h:buf': Date.now(), [tk]: Date.now() }));
    } catch (e) {}
  }, [saved(start), TICKET]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
    const J = body => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.startsWith('http://relay.stub/live')) {
      const sp = new URL(u).searchParams.get('sport');
      return J({ sport: sp, games: sp === 'nba' ? [{ home: 'New York Knicks', away: 'Boston Celtics', lines: [
        { m: 'spread', sel: 'New York Knicks', pt: 3.5, price: 150, id: 'sel-ny-plus', age: 12 },
        { m: 'spread', sel: 'Boston Celtics', pt: -3.5, price: -190, id: 'sel-bos-minus', age: 12 }] }] : [] });
    }
    const m = /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/([a-z-]+\/[a-z-]+)\/(scoreboard|summary)/.exec(u);
    if (!m) return r.abort();
    const key = m[1] + '/' + m[2];
    if (key === 'football/nfl/scoreboard') return J({ events: [teamEvent('401', start, { state: 'post', period: 4, clock: 0, detail: 'Final' }, ['BUF', 'Buffalo Bills', 27], ['KC', 'Kansas City Chiefs', 20])] });
    if (key === 'basketball/nba/scoreboard') return J({ events: [teamEvent('501', start, { state: 'in', period: 4, clock: 600, detail: '10:00 - 4th' }, ['BOS', 'Boston Celtics', 90], ['NY', 'New York Knicks', 80])] });
    if (key === 'basketball/nba/summary') return J(nbaBox());
    if (m[2] === 'summary') return r.abort();
    return J({ events: [] });
  });
  await p.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
  const loaded = await p.waitForFunction(() => window.OnyxCash && window.OnyxSaved && window.OnyxHedge, null, { timeout: 15000 }).then(() => true, () => false);
  if (!loaded) { bad.push('OnyxHedge did not load on home.html (onyx-cash.js loads it)'); await ctx.close(); return bad; }

  // 1. the math
  const U = await p.evaluate(() => {
    const M = OnyxHedge.math, out = [];
    const near = (a, b, t) => Math.abs(a - b) < (t || 0.005);
    let f = M.full(20, 600, 150);                                   // R 140, H 56, lock 64
    if (!f || !near(f.R, 140) || !near(f.H, 56) || !near(f.lock, 64)) out.push('full(20, +600, +150): ' + JSON.stringify(f));
    if (f && (!near(f.win, f.lock) || !near(f.lose, f.lock))) out.push('equal-profit hedge is not equal both ways: ' + JSON.stringify(f));
    f = M.full(100, -120, 200);                                     // R 183.33, H 61.11, lock 22.22
    if (!f || !near(f.R, 183.333, 0.01) || !near(f.H, 61.111, 0.01) || !near(f.lock, 22.222, 0.01)) out.push('full(100, -120, +200): ' + JSON.stringify(f));
    if (f && (!near(f.win, f.lock) || !near(f.lose, f.lock))) out.push('equal-profit hedge (favorite) not equal both ways');
    const z = M.at(20, 600, 150, 0);
    if (!z || !near(z.ifTicket, 120) || !near(z.ifHedge, -20)) out.push('partial hedge at $0: ' + JSON.stringify(z));
    const fu = M.at(20, 600, 150, 56);
    if (!fu || !near(fu.ifTicket, 64) || !near(fu.ifHedge, 64)) out.push('partial hedge at full: ' + JSON.stringify(fu));
    const half = M.at(20, 600, 150, 28);
    if (!half || !near(half.ifTicket, 92) || !near(half.ifHedge, 22)) out.push('partial hedge at half: ' + JSON.stringify(half));
    const b = M.full(10, -110, -1000);                              // R 19.09, H 17.36, lock -8.26
    if (!b || !(b.lock < 0) || !near(b.lock, 19.0909 - 17.3554 - 10, 0.01)) out.push('bad hedge price should lock a loss: ' + JSON.stringify(b));
    if (M.full(20, 600, 50) !== null || M.full(0, 600, 150) !== null || M.full(20, null, 150) !== null) out.push('invalid input should give null');
    const ev0 = M.ev(20, 600, 150, 0, 0.5), evF = M.ev(20, 600, 150, 56, 0.5);
    if (!near(ev0, 0.5 * 120 - 0.5 * 20) || !near(evF, 64)) out.push('ev: ride ' + ev0 + ' full ' + evF);
    if (M.odds('+150') !== 150 || M.odds('-120') !== -120 || M.odds('EVEN') !== 100 || M.odds('50') !== null) out.push('odds parsing');
    return out;
  });
  bad.push(...U);

  // 2. the chip on My picks
  const chipSel = `#myBody .pk-cash[data-cash="${TICKET}"] .ohg-chip`;
  const chip = await p.waitForFunction(s => { const c = document.querySelector(s); return c && /lock/i.test(c.textContent) ? c.textContent : null; }, chipSel, { timeout: 25000 }).then(h => h.jsonValue(), () => null);
  if (!chip) {
    const dbg = await p.evaluate(async tk => { const t = OnyxSaved.all().find(x => x.id === tk); const r = t ? await OnyxCash.chance(t) : null; const o = t ? await OnyxHedge.offer(t, r) : null;
      return { r: r && { state: r.state, p: r.p, res: r.res, legs: (r.legs || []).map(l => [l.res, l.state, l.p]) }, o: o && { hp: o.hp, src: o.src, lock: o.lock }, cash: !!document.querySelector('#myBody .pk-cash') }; }, TICKET);
    bad.push('no "Hedge available" chip on the My picks meter: ' + JSON.stringify(dbg));
    await ctx.close(); return bad;
  }
  if (!/^Hedge available: lock \$64$/.test(chip.trim())) bad.push('chip text: ' + chip);
  const o = await p.evaluate(tk => OnyxHedge.known(tk), TICKET);
  if (!o || o.src !== 'live' || o.hp !== 150 || o.tp !== 600 || o.stake !== 20 || Math.abs(o.lock - 64) > 0.01 || o.sel !== 'sel-ny-plus' || !/NY \+3\.5/.test(o.hedgeLabel))
    bad.push('offer: ' + JSON.stringify(o && { src: o.src, hp: o.hp, tp: o.tp, stake: o.stake, lock: o.lock, sel: o.sel, hedgeLabel: o.hedgeLabel }));
  if (SHOTS) {
    await p.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), chipSel);
    await p.waitForTimeout(250);
    await p.screenshot({ path: path.join(SHOTS, `hedge-chip-${w}.png`) });
  }

  // 3. the sheet
  await p.click(chipSel);
  const open = await p.waitForFunction(() => { const r = document.getElementById('ohgRoot'); return r && !r.hidden && r.classList.contains('on') && document.querySelector('[data-ohg-lock]'); }, null, { timeout: 5000 }).then(() => true, () => false);
  if (!open) { bad.push('the chip did not open the hedge sheet'); await ctx.close(); return bad; }
  await p.waitForTimeout(300);
  const q = async () => p.evaluate(() => {
    const t = s => (document.querySelector(s) || {}).textContent || '';
    const c = document.querySelector('#ohgRoot .ohg-c'), cr = c.getBoundingClientRect();
    return { H: t('[data-ohg-h]'), lock: t('[data-ohg-lock]'), W: t('#ohgW'), L: t('#ohgL'), math: t('.ohg-math'), ride: t('.ohg-ride'), sub: t('.ohg-sub'),
             href: (document.querySelector('.ohg-bet') || {}).href || '', txt: c.innerText, sheet: document.getElementById('ohgRoot').classList.contains('sheet'),
             inView: cr.left >= -1 && cr.right <= innerWidth + 1 && cr.top >= -1 && cr.bottom <= innerHeight + 1, side: document.documentElement.scrollWidth > innerWidth + 1,
             focus: c.contains(document.activeElement), lockCls: (document.querySelector('.ohg-lock') || {}).className || '' };
  });
  let S = await q();
  if (S.H !== '$56.00') bad.push('hedge amount ' + S.H + ', want $56.00');
  if (S.lock !== '+$64.00') bad.push('locked ' + S.lock + ', want +$64.00');
  if (S.W !== '+$64.00' || S.L !== '+$64.00') bad.push(`full hedge outcomes ${S.W} / ${S.L}, want +$64.00 both`);
  if (!/\$20\.00 x 7\.000 = \$140\.00/.test(S.math) || !/\$140\.00 \/ 2\.500 = \$56\.00/.test(S.math) || !/\$140\.00 - \$56\.00 - \$20\.00 = \+\$64\.00/.test(S.math)) bad.push('math lines: ' + S.math);
  if (!/2 of 3 won/.test(S.sub) || !/BOS -3\.5/.test(S.sub) || !/NY \+3\.5/.test(S.sub) || !/live chance \d+%/.test(S.sub)) bad.push('sheet header: ' + S.sub);
  if (!/Ride it/.test(S.ride) || !/projection/.test(S.ride) || !/not advice or a guarantee/.test(S.ride)) bad.push('ride-it read: ' + S.ride);
  if (!/^https:\/\/app\.onyxodds\.com\/share\?selection=sel-ny-plus&referrer=KR680261$/.test(S.href)) bad.push('Onyx link ' + S.href);
  if (!/Onyx live price/.test(S.txt)) bad.push('price source not shown');
  if (S.sheet !== phone) bad.push(phone ? 'not a bottom sheet on a phone' : 'not a centered dialog on desktop');
  if (!S.inView) bad.push('sheet off screen');
  if (S.side) bad.push('sideways scroll with the sheet open');
  if (!S.focus) bad.push('focus is not in the sheet');
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `hedge-sheet-${w}.png`) });

  // slider: $0 rides it, full locks it
  await p.evaluate(() => { const s = document.getElementById('ohgH'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  S = await q();
  if (S.W !== '+$120.00' || S.L !== '-$20.00') bad.push(`slider at $0: ${S.W} / ${S.L}, want +$120.00 / -$20.00`);
  await p.evaluate(() => { const s = document.getElementById('ohgH'); s.value = '28'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  S = await q();
  if (S.W !== '+$92.00' || S.L !== '+$22.00') bad.push(`slider at $28: ${S.W} / ${S.L}, want +$92.00 / +$22.00`);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `hedge-partial-${w}.png`) });
  await p.click('[data-ohg-full]');
  S = await q();
  if (S.W !== '+$64.00' || S.L !== '+$64.00') bad.push(`full hedge button: ${S.W} / ${S.L}`);
  // copy
  await p.click('[data-ohg-copy]');
  const copied = await p.evaluate(() => window.__ohgCopied || '');
  if (!/\$56\.00 on NY \+3\.5 at Onyx \+150/.test(copied) || !/\+\$64\.00/.test(copied)) bad.push('copied text: ' + copied);
  // a bad hedge price: no lock
  await p.fill('[data-ohg-in="hp"]', '-1000');
  S = await q();
  if (!/^-\$/.test(S.lock) || !/bad/.test(S.lockCls) || !/No lock at this price/i.test(S.txt)) bad.push('bad price should show a losing lock: ' + S.lock + ' ' + S.lockCls);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `hedge-nolock-${w}.png`) });
  if (/—/.test(S.txt)) bad.push('em dash in the sheet');
  if (/NaN|undefined|null|Infinity/.test(S.txt)) bad.push('bad value in the sheet: ' + S.txt.replace(/\s+/g, ' ').slice(0, 160));
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.getElementById('ohgRoot').hidden, null, { timeout: 3000 }).catch(() => bad.push('Escape did not close the sheet'));

  // 4. the live rail
  const rc = await p.waitForFunction(() => { const b = document.querySelector('#onyxRail .ohg-rc'); return b ? b.textContent : null; }, null, { timeout: 40000 }).then(h => h.jsonValue(), () => null);
  if (!rc) bad.push('no "Lock" chip on the live rail');
  else {
    if (rc !== 'Lock $64') bad.push('rail chip: ' + rc);
    const rr = await p.evaluate(() => { const r = document.getElementById('onyxRail'), b = r.querySelector('.ohg-rc'), prev = b.previousElementSibling; return { h: r.getBoundingClientRect().height, after: prev && prev.getAttribute('data-b') }; });
    if (Math.round(rr.h) !== 44) bad.push('rail height ' + rr.h);
    if (rr.after !== TICKET) bad.push('rail chip is not next to its bet: ' + rr.after);
    if (SHOTS) {
      await p.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('.otoasts').forEach(e => { e.style.display = 'none'; }); });
      await p.evaluate(() => { const b = document.querySelector('#onyxRail .ohg-rc'), box = document.querySelector('#onyxRail .olr-in'); if (box) box.scrollLeft = Math.max(0, b.offsetLeft - box.clientWidth + b.offsetWidth + 16); });
      await p.screenshot({ path: path.join(SHOTS, `hedge-rail-${w}.png`), clip: { x: 0, y: 0, width: w, height: 220 } });
    }
    await p.click('#onyxRail .ohg-rc');
    const ok = await p.waitForFunction(() => { const r = document.getElementById('ohgRoot'); return r && !r.hidden && (document.querySelector('[data-ohg-lock]') || {}).textContent === '+$64.00'; }, null, { timeout: 5000 }).then(() => true, () => false);
    if (!ok) bad.push('the rail chip did not open the sheet at +$64.00');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
  }

  // 5. the standalone calculator: $100 at +200, hedge -150 -> R $300, H $180, lock +$20
  await p.evaluate(() => OnyxHedge.calc({}));
  await p.waitForSelector('[data-ohg-in="stake"]');
  await p.fill('[data-ohg-in="stake"]', '100'); await p.fill('[data-ohg-in="tp"]', '+200'); await p.fill('[data-ohg-in="hp"]', '-150'); await p.fill('[data-ohg-in="p"]', '60');
  await p.waitForTimeout(300);
  S = await q();
  if (S.H !== '$180.00' || S.lock !== '+$20.00') bad.push(`standalone: hedge ${S.H} lock ${S.lock}, want $180.00 / +$20.00`);
  if (!/Ride it/.test(S.ride)) bad.push('standalone ride read with a typed chance missing');
  if (!/^https:\/\/app\.onyxodds\.com\/\?referrer=KR680261$/.test(S.href)) bad.push('standalone Onyx link ' + S.href);
  if (S.side || !S.inView) bad.push('standalone calculator layout: ' + JSON.stringify({ side: S.side, inView: S.inView, r: await p.evaluate(() => { const r = document.querySelector('#ohgRoot .ohg-c').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight, document.documentElement.scrollWidth]; }) }));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `hedge-calc-${w}.png`) });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);

  // 6. the quick bet card's link
  const tap = await p.evaluate(() => !!(window.OnyxTap && OnyxTap.open));
  if (tap) {
    await p.evaluate(() => OnyxTap.open({ label: 'NY +3.5', price: 150, sport: 'nba', kind: 'spread', matchup: 'BOS @ NY' }));
    const link = await p.waitForSelector('#oxTap .ohg-tap', { timeout: 6000 }).then(() => true, () => false);
    if (!link) bad.push('no "Hedge calculator" link on the quick bet card');
    else {
      await p.click('#oxTap .ohg-tap');
      const ok = await p.waitForFunction(() => { const i = document.querySelector('[data-ohg-in="tp"]'); return i && i.value === '+150' && !document.getElementById('ohgRoot').hidden; }, null, { timeout: 4000 }).then(() => true, () => false);
      if (!ok) bad.push('the quick bet card link did not open the calculator with its price');
      await p.keyboard.press('Escape');
    }
  } else bad.push('OnyxTap missing on home.html');

  // no yellow anywhere in our styles
  const css = await p.evaluate(() => (document.getElementById('ohg-css') || {}).textContent || '');
  if (/#ff[cd]|#f[0-9a-f]c0|yellow|#ffd|#fe[0-9a-f]{4}|gold/i.test(css)) bad.push('yellow-ish color in the hedge styles');

  if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
  await ctx.close();
  return bad;
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let fails = 0;
  for (const w of arg('w', '390,1280').split(',').map(Number)) {
    const bad = await run(browser, base, w);
    console.log(`${bad.length ? 'FAIL' : 'ok  '} home.html @${w}${bad.length ? '\n      ' + bad.join('\n      ') : ''}`);
    fails += bad.length ? 1 : 0;
  }
  await browser.close(); server.close();
  if (fails) { console.log(`\nverify_hedge: ${fails} failing`); process.exit(1); }
  console.log('\nverify_hedge: all checks pass');
})().catch(e => { console.error(e); process.exit(1); });
