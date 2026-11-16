#!/usr/bin/env node
/**
 * verify_season.js - My Season (season.html, season.js) and the pick-saving flow (saved.js, home.html My picks), 11/16.
 *
 * Seeds a realistic onyxHistory (66 graded picks over 6 weeks: NFL, NBA, NHL, college basketball, tennis, parlays,
 * pushes, the odds you got on some, stakes and #tags on others) plus two picks still to grade, and fakes ESPN's NBA
 * scoreboard so saved.js really grades them (one of them has already left My picks 24 hours after its start: it must
 * land in Settled, not vanish). Then, at 390 and 1280:
 *   - every number on the page (record, units, ROI, hit rate, longest and current streak, best day, the model check)
 *     equals an independent recomputation here, for All time, 7 days, Season and one sport
 *   - the units chart draws one point per graded pick (plus the start) and its hover tooltip shows
 *   - the recap opens with 6 cards, a tap moves it on, the last card shares a 'season' card through OnyxShare
 *   - an empty history shows the how-to-save empty state
 *   - no page errors, no sideways scroll
 * And home.html My picks: the save sheet (units, the odds you got, note, Undo), the Undo toast on remove, the slip saved
 * as one ticket in one tap, OnyxCash meters and live leans, OnyxShare buttons (both stubbed: those files are other work).
 *
 *   node tools/verify_season.js            (SHOT=dir saves screenshots as season-*.png)
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const ROOT = path.join(__dirname, '..');
const SHOT = process.env.SHOT || '';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const NOW = Date.now(), H = 3600e3, D = 864e5;
let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { fails++; console.log('  FAIL ' + m); } };

// ── the seed: deterministic ─────────────────────────────────────────────────
function rng(s) { return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function seed() {
  const R = rng(42), out = [];
  const SP = [['nfl', 'prop', 'rec_yds'], ['nba', 'prop', 'pts'], ['nhl', 'ml', null], ['cbb', 'spread', null], ['nba', 'total', null], ['tennis', 'ml', null], ['nfl', 'spread', null]];
  const PR = [-110, -115, -120, -135, -150, -105, 110, 125, 140, 165, 200, -200, 105];
  for (let i = 0; i < 60; i++) {
    const d = 41 - Math.floor(i * 42 / 60), [sport, kind, mkt] = SP[i % SP.length];
    const price = PR[Math.floor(R() * PR.length)], conf = Math.round((0.3 + R() * 0.45) * 1000) / 1000;
    const res = i % 17 === 5 ? 'P' : R() < conf + 0.04 ? 'W' : 'L';
    const start = new Date(NOW - d * D + 3 * H + (i % 3) * 600e3).toISOString();
    const h = {id: 'sd' + i, sport, kind, label: `${sport.toUpperCase()} pick ${i}`, matchup: 'AAA @ BBB', start, saved: new Date(Date.parse(start) - 2 * H).toISOString(), price, conf, res, graded: start};
    if (mkt) { h.mkt = mkt; h.line = 50.5; h.side = 'over'; h.name = 'Player ' + i; }
    if (i % 3 === 0) h.my_price = price + (price > 0 ? 10 : 5);
    if (i % 4 === 1) h.stake = [2, 0.5, 3][i % 3];
    if (i % 9 === 2) { h.note = 'gut call #fade'; h.tags = ['fade']; }
    out.push(h);
  }
  for (let j = 0; j < 6; j++) {   // parlay tickets
    const d = 39 - j * 7, start = new Date(NOW - d * D + 4 * H).toISOString();
    out.push({id: 't:seed' + j + ':3', kind: 'parlay', sport: j % 2 ? 'multi' : 'nba', label: '3-leg parlay', start, saved: start, price: 450 + j * 60,
      conf: 0.18, res: j % 3 === 0 ? 'W' : 'L', legs: [{id: 'a', label: 'Leg A'}, {id: 'b', label: 'Leg B'}, {id: 'c', label: 'Leg C'}], my_price: j === 0 ? 500 : undefined, stake: j === 3 ? 0.5 : undefined});
  }
  // still to grade: an NBA moneyline that finished (BOS won), graded off the faked scoreboard
  out.push({id: 'pend-ml', sport: 'nba', kind: 'ml', label: 'Celtics to win', name: 'BOS', team: 'BOS', matchup: 'BOS @ NYK', start: new Date(NOW - 5 * H).toISOString(), saved: new Date(NOW - 7 * H).toISOString(), price: -140, conf: 0.6, res: null});
  return out.map(h => JSON.parse(JSON.stringify(h)));
}
// in My picks still, but its game started 30 hours ago: it must leave My picks for Settled, graded (LAL @ GSW went 233)
const STALE = {id: 'stale-total', sport: 'nba', kind: 'total', side: 'over', line: 200.5, label: 'LAL @ GSW over 200.5', team: 'LAL', matchup: 'LAL @ GSW',
  start: new Date(NOW - 30 * H).toISOString(), saved: new Date(NOW - 32 * H).toISOString(), price: -110, conf: 0.55, my_price: -105, stake: 2};
const ESPN_NBA = {events: [
  {id: '9001', status: {type: {state: 'post', shortDetail: 'Final'}}, competitions: [{competitors: [
    {homeAway: 'home', team: {abbreviation: 'NYK'}, score: '101'}, {homeAway: 'away', team: {abbreviation: 'BOS'}, score: '112'}]}]},
  {id: '9002', status: {type: {state: 'post', shortDetail: 'Final'}}, competitions: [{competitors: [
    {homeAway: 'home', team: {abbreviation: 'GSW'}, score: '118'}, {homeAway: 'away', team: {abbreviation: 'LAL'}, score: '115'}]}]}]};

// ── the independent recomputation ───────────────────────────────────────────
function units(h) {
  const s = +h.stake > 0 ? +h.stake : 1, p = h.my_price != null ? +h.my_price : h.price != null ? +h.price : null;
  return h.res === 'W' ? s * (p == null ? 1 : p > 0 ? p / 100 : 100 / -p) : h.res === 'L' ? -s : 0;
}
function bday(t) { return new Date(t - 4 * H).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); }
function expect(hist, period, sport) {
  const from = period === 'week' ? NOW - 7 * D : period === 'month' ? NOW - 30 * D : period === 'season' ? (() => { const d = new Date(NOW); let y = d.getUTCFullYear(); if (d.getUTCMonth() < 7) y--; return Date.UTC(y, 7, 1, 8); })() : -Infinity;
  const g = hist.filter(h => h.res && Date.parse(h.start) >= from && (sport === 'all' || h.sport === sport)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let w = 0, l = 0, p = 0, u = 0, risk = 0, run = 0, best = 0, cur = null;
  const days = {};
  for (const h of g) {
    const x = units(h); u += x;
    if (h.res === 'W') { w++; run++; best = Math.max(best, run); } else if (h.res === 'L') { l++; run = 0; } else p++;
    if (h.res !== 'P') { risk += +h.stake > 0 ? +h.stake : 1; cur = cur && cur[0] === h.res ? [h.res, cur[1] + 1] : [h.res, 1]; }
    const k = bday(Date.parse(h.start)); days[k] = (days[k] || 0) + x;
  }
  const M = g.filter(h => (h.res === 'W' || h.res === 'L') && h.conf > 0 && h.conf < 1);
  const fmt = v => { v = Math.round(v * 100) / 100; return (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(2) + 'u'; };
  const bd = Math.max(...Object.values(days).map(v => Math.round(v * 100) / 100), -Infinity);
  return {n: g.length, record: w + '-' + l + (p ? '-' + p : ''), units: fmt(u),
    roi: risk ? (() => { const r = Math.round(Math.round(u * 100) / 100 / (Math.round(risk * 100) / 100) * 1000) / 10; return (r > 0 ? '+' : '') + r + '%'; })() : '-',
    rate: w + l ? Math.round(w / (w + l) * 1000) / 10 + '%' : '-', longest: String(best), current: cur ? cur[0] + cur[1] : '-',
    bestday: bd > 0 ? fmt(bd) : '-', exp: (Math.round(M.reduce((s, h) => s + h.conf, 0) * 10) / 10).toFixed(1), act: String(M.filter(h => h.res === 'W').length)};
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (rel === 'ai.json' || rel === 'accounts.json') { res.writeHead(200, {'content-type': 'application/json'}).end('{"url":""}'); return; }
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, {'content-type': type}).end(buf);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}
async function open(browser, base, w, init) {
  const phone = w < 761;
  const ctx = await browser.newContext({viewport: {width: w, height: phone ? 844 : 900}, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, ...(phone ? {userAgent: UA} : {})});
  await ctx.addInitScript(init.script, init.arg);
  const p = await ctx.newPage(), errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(base)) return r.continue();
    if (/site\.api\.espn\.com\/.*basketball\/nba\/scoreboard/.test(u)) return r.fulfill({contentType: 'application/json', body: JSON.stringify(ESPN_NBA)});
    if (/site\.api\.espn\.com/.test(u)) return r.fulfill({contentType: 'application/json', body: '{"events":[]}'});
    return r.abort();
  });
  return {ctx, p, errs};
}
const sideways = p => p.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
const shot = async (p, name, full) => { if (SHOT) { fs.mkdirSync(SHOT, {recursive: true}); await p.screenshot({path: path.join(SHOT, 'season-' + name + '.png'), fullPage: !!full}); } };
const stubs = `window.OnyxShare = {open: c => { window.__shared = c; }, button: (c, t) => '<button type="button" class="osh-b">' + (t || 'Share') + '</button>'};`;

(async () => {
  const server = await serve(), base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({...(CHROMIUM ? {executablePath: CHROMIUM} : {}), args: ['--no-sandbox']});
  const HIST = seed();
  console.log(`seed: ${HIST.length} history rows (${HIST.filter(h => h.res).length} graded), one stale saved pick`);
  for (const w of [390, 1280]) {
    console.log(`\nseason.html @ ${w}`);
    const {ctx, p, errs} = await open(browser, base, w, {script: ([h, s, st]) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.clear(); localStorage.setItem('onyx-new-2026-10-26b', '1');
      localStorage.setItem('onyxHistory', JSON.stringify(h)); localStorage.setItem('onyxSaved', JSON.stringify([s]));
      localStorage.setItem('onyxSeasonView', JSON.stringify({period: 'all', sport: 'all'}));
      new Function(st)();
    }, arg: [HIST, STALE, stubs]});
    await p.goto(base + '/season.html', {waitUntil: 'domcontentloaded'});
    await p.waitForFunction(() => window.OnyxSeason && document.querySelector('[data-k="record"]'), null, {timeout: 10000}).catch(() => {});
    // the two to grade: graded off the faked scoreboard (saved.js grade runs ~0.4 s after load)
    const graded = await p.waitForFunction(() => { const H = OnyxSaved.history(); const a = H.find(x => x.id === 'pend-ml'), b = H.find(x => x.id === 'stale-total'); return a && b && a.res && b.res ? [a.res, b.res] : null; }, null, {timeout: 12000}).then(h => h.jsonValue()).catch(() => null);
    ok(graded && graded[0] === 'W' && graded[1] === 'W', `pending picks graded off ESPN: ${JSON.stringify(graded)} (want W, W)`);
    ok(await p.evaluate(() => !OnyxSaved.all().some(x => x.id === 'stale-total')), 'the stale pick left My picks (24 hours after start)');
    await p.waitForTimeout(300);
    const hist = await p.evaluate(() => OnyxSaved.history());
    ok(await p.evaluate(() => !!document.querySelector('#settled') && document.querySelector('#settled').textContent.includes('LAL @ GSW over 200.5')), 'the stale pick is in Settled');
    const cases = [['all', 'all'], ['week', 'all'], ['season', 'all'], ['all', 'nba'], ['month', 'nfl']];
    for (const [period, sport] of cases) {
      await p.evaluate(([a, b]) => { const pb = document.querySelector(`[data-period="${a}"]`); if (pb) pb.click(); const sb = document.querySelector(`[data-sport="${b}"]`); if (sb) sb.click(); }, [period, sport]);
      const E = expect(hist, period, sport);
      const got = await p.evaluate(() => { const o = {}; document.querySelectorAll('[data-k]').forEach(e => { o[e.getAttribute('data-k')] = e.textContent.trim(); }); o.points = (document.querySelector('.se-line') || {getAttribute: () => ''}).getAttribute('points').trim().split(/\s+/).filter(Boolean).length; return o; });
      const keys = ['record', 'units', 'roi', 'rate', 'longest', 'current', 'bestday', 'exp', 'act'];
      const bad = keys.filter(k => String(got[k]) !== String(E[k]));
      ok(!bad.length && E.n > 0, `${period}/${sport}: ${E.n} graded, ${got.record} ${got.units} ROI ${got.roi} hit ${got.rate} streak ${got.longest}/${got.current} best day ${got.bestday} model ${got.exp} vs ${got.act}` +
        (bad.length ? '  MISMATCH ' + bad.map(k => `${k}: page ${got[k]} want ${E[k]}`).join(', ') : ''));
      ok(got.points === E.n + 1, `${period}/${sport}: chart has ${got.points} points (want ${E.n + 1})`);
    }
    await p.evaluate(() => { document.querySelector('[data-period="all"]').click(); document.querySelector('[data-sport="all"]').click(); });
    // the chart's hover tooltip
    const box = await p.locator('#seChart').boundingBox();
    if (w < 761) await p.locator('#seChart').tap({position: {x: box.width * 0.6, y: box.height / 2}});
    else await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    ok(await p.evaluate(() => { const t = document.querySelector('.se-ch-tip'); return t && !t.hidden && /Season/.test(t.textContent); }), 'chart tooltip shows on hover');
    ok(await sideways(p) <= 0, `no sideways scroll (${await sideways(p)}px)`);
    if (w >= 761) await p.mouse.move(1, 1);
    await shot(p, w);
    await shot(p, 'full-' + w, true);
    // the recap
    await p.click('.se-recap');
    await p.waitForSelector('.se-rc', {timeout: 3000}).catch(() => {});
    ok(await p.evaluate(() => document.querySelectorAll('.se-rc-c').length) === 6, 'recap opens with 6 cards');
    await shot(p, 'recap-' + w);
    const c0 = await p.locator('.se-rc-c').first().boundingBox();
    await p.mouse.click(c0.x + c0.width * 0.8, c0.y + c0.height / 2);
    await p.waitForTimeout(600);
    ok(await p.evaluate(() => document.querySelector('.se-rc').getAttribute('data-at')) === '1', 'a tap on the right moves to card 2');
    await p.evaluate(() => { const t = document.querySelector('.se-rc-track'); t.scrollLeft = t.scrollWidth; });
    await p.waitForTimeout(400);
    await p.click('.se-rc-share button');
    const shared = await p.evaluate(() => window.__shared || null);
    const E = expect(hist, 'all', 'all');
    ok(shared && shared.kind === 'season' && shared.stats && shared.stats.record === E.record && Array.isArray(shared.stats.sports) && shared.stats.sports.length >= 5,
      `the last card shares a season card (${shared ? shared.kind + ' ' + shared.stats.record + ', ' + shared.stats.sports.length + ' sports' : 'nothing'})`);
    ok(await sideways(p) <= 0, 'no sideways scroll with the recap open');
    await p.keyboard.press('Escape');
    ok(await p.evaluate(() => !document.querySelector('.se-rc')), 'Escape closes the recap');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    // the empty state
    const e2 = await open(browser, base, w, {script: () => { localStorage.clear(); localStorage.setItem('onyx-new-2026-10-26b', '1'); }, arg: null});
    await e2.p.goto(base + '/season.html', {waitUntil: 'domcontentloaded'});
    await e2.p.waitForSelector('.se-empty', {timeout: 8000}).catch(() => {});
    ok(await e2.p.evaluate(() => !!document.querySelector('.se-empty') && /Tap the star/.test(document.querySelector('.se-empty').textContent)), 'empty history: the how-to-save empty state');
    ok(await sideways(e2.p) <= 0, 'empty state: no sideways scroll');
    if (w === 390) await shot(e2.p, 'empty-390');
    ok(!e2.errs.length, 'empty state: no page errors' + (e2.errs.length ? ': ' + e2.errs.join(' | ') : ''));
    await e2.ctx.close();
  }

  // ── home.html My picks and the save flow ──────────────────────────────────
  const tapEl = (p, sel) => p.$eval(sel, b => b.click());
  for (const w of [390, 1280]) {
    console.log(`\nhome.html My picks @ ${w}`);
    const soon = new Date(NOW + 3 * H).toISOString();
    const saved = [{id: 'live1', sport: 'nba', kind: 'prop', mkt: 'pts', side: 'over', line: 24.5, name: 'Jayson Tatum', team: 'BOS', label: 'Jayson Tatum over 24.5 pts', matchup: 'BOS @ NYK', start: soon, saved: new Date().toISOString(), price: -115, conf: 0.56},
      {id: 't:abc:2', kind: 'parlay', sport: 'nba', label: '2-leg parlay', start: soon, saved: new Date().toISOString(), price: 260, conf: 0.3,
        legs: [{id: 'x1', sport: 'nba', kind: 'ml', name: 'BOS', team: 'BOS', label: 'Celtics to win', matchup: 'BOS @ NYK', start: soon}, {id: 'x2', sport: 'nba', kind: 'total', side: 'over', line: 220.5, team: 'LAL', label: 'LAL @ GSW over 220.5', matchup: 'LAL @ GSW', start: soon}]}];
    const slip = [{id: 's1', sel: 's1', sport: 'nfl', label: 'Leg one', price: -110, conf: 0.55, start: soon, matchup: 'A @ B'}, {id: 's2', sel: 's2', sport: 'nfl', label: 'Leg two', price: 120, conf: 0.45, start: soon, matchup: 'C @ D'}];
    const cash = `window.OnyxCash = {mount: (el, p) => { el.innerHTML = '<div class="cash-stub">Chance to cash ' + p.id + '</div>'; window.__mounts = (window.__mounts || 0) + 1; return {stop() {}}; },
      leans: () => Promise.resolve([{label: 'Knicks +4.5 live', sport: 'nba', matchup: 'BOS @ NYK', p: 0.58, price: -105, edge: 0.06, sel: 'lean-sel-1', now: 'Q3 6:12'}]), chance: () => Promise.resolve({state: 'pre', p: 0.5})};`;
    const {ctx, p, errs} = await open(browser, base, w, {script: ([sv, sl, st]) => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.clear(); localStorage.setItem('onyx-new-2026-10-26b', '1');
      localStorage.setItem('onyxSaved', JSON.stringify(sv)); localStorage.setItem('onyxSlipAll', JSON.stringify(sl));
      new Function(st)();
    }, arg: [saved, slip, stubs + cash]});
    await p.goto(base + '/home.html', {waitUntil: 'domcontentloaded'});
    await p.waitForFunction(() => document.querySelectorAll('#myBody .pk-c').length >= 2, null, {timeout: 15000}).catch(() => {});
    ok(await p.evaluate(() => document.querySelectorAll('#myBody .pk-c').length) === 2, 'My picks shows the saved pick and the parlay ticket');
    ok(await p.evaluate(() => document.querySelectorAll('#myBody .cash-stub').length) === 2, 'OnyxCash meter mounted on each pick');
    ok(await p.evaluate(() => /Knicks \+4\.5 live/.test(document.getElementById('myBody').textContent)), 'Live leans section from OnyxCash.leans()');
    ok(await p.evaluate(() => document.querySelectorAll('#myBody .pk-legs span').length) === 2, 'the parlay ticket lists its legs');
    ok(await p.evaluate(() => !!document.querySelector('#myBody a.pk-season[href="season.html"]')), 'My Season linked from My picks');
    await p.evaluate(() => document.getElementById('my').scrollIntoView());
    await tapEl(p, '#myBody .pk-sh button');
    ok(await p.evaluate(() => window.__shared && window.__shared.kind === 'single' && location.hash !== '#games'), 'share button opens OnyxShare with the pick (and does not follow the card link)');
    const mountsBefore = await p.evaluate(() => window.__mounts);
    await p.evaluate(() => renderMy());
    ok(await p.evaluate(() => window.__mounts) === mountsBefore, 'a redraw keeps the live meters (no remount)');
    await shot(p, 'home-' + w);
    // the slip in one tap
    await tapEl(p, '#myBody .pk-slip');
    await p.waitForSelector('.oxsv.open', {timeout: 3000}).catch(() => {});
    ok(await p.evaluate(() => OnyxSaved.all().some(x => x.kind === 'parlay' && x.legs.length === 2 && x.legs[0].id === 's1' && x.price === 320)), 'the 2-leg slip saved as one ticket at +320');
    // the save sheet: units, the odds you got, a note
    await tapEl(p, '.oxsv [data-oxsv-u="2"]');
    await p.fill('.oxsv [data-oxsv="price"]', '+300');
    await p.press('.oxsv [data-oxsv="price"]', 'Enter');
    await p.fill('.oxsv [data-oxsv="note"]', 'sweat it #sgp');
    await p.press('.oxsv [data-oxsv="note"]', 'Enter');
    const tk = await p.evaluate(() => OnyxSaved.history().find(x => x.kind === 'parlay' && x.legs[0].id === 's1'));
    ok(tk && tk.stake === 2 && tk.my_price === 300 && tk.note === 'sweat it #sgp' && tk.tags && tk.tags[0] === 'sgp' && tk.edited > 0, `save sheet sets units, your odds and a note (${tk ? [tk.stake, tk.my_price, tk.note, tk.tags].join(' / ') : 'none'})`);
    ok(await sideways(p) <= 0, 'no sideways scroll with the save sheet open');
    await shot(p, 'sheet-' + w);
    // Undo on the sheet takes the save back
    await tapEl(p, '.oxsv [data-oxsv="undo"]');
    ok(await p.evaluate(() => !OnyxSaved.all().some(x => x.kind === 'parlay' && x.legs[0].id === 's1') && !OnyxSaved.history().some(x => x.kind === 'parlay' && x.legs[0].id === 's1')), 'Undo removes the save from My picks and the history');
    // the star: save and remove with Undo, every star for the pick repaints
    await p.evaluate(() => { const d = document.createElement('div'); d.id = 'stars'; d.innerHTML = OnyxSaved.btn({id: 'star1', sport: 'nfl', label: 'Test star', price: -110}) + OnyxSaved.btn({id: 'star1', sport: 'nfl', label: 'Test star', price: -110}); document.body.prepend(d); });
    await tapEl(p, '#stars .ox-save');
    ok(await p.evaluate(() => [...document.querySelectorAll('#stars .ox-save')].every(b => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true')), 'a save lights every star for that pick');
    await tapEl(p, '.oxsv [data-oxsv="x"]');
    await p.waitForSelector('#myBody [data-rm="live1"]');
    await tapEl(p, '#myBody [data-rm="live1"]');
    ok(await p.evaluate(() => !OnyxSaved.has('live1')), 'the × removes a pick');
    const undo = p.locator('.otoast button', {hasText: 'Undo'});
    if (await undo.count()) await undo.first().evaluate(b => b.click());
    ok(await p.evaluate(() => OnyxSaved.has('live1')), 'Undo on the toast brings it back');
    ok(await sideways(p) <= 0, 'My picks: no sideways scroll');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();
  }
  await browser.close(); server.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nverify_season: all checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
