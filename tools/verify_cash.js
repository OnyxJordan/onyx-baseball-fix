#!/usr/bin/env node
/**
 * verify_cash.js - live chance to cash (onyx-cash.js), dev + CI.
 *
 * Fake ESPN scoreboards and box scores (Playwright route + fulfill) put four games in play: an NBA game (BOS @ NY,
 * 10:00 left in the 4th, BOS up 10), an NFL game (BUF @ KC, 3rd quarter), an NHL game (NYR @ TOR, 2nd period) and an
 * ATP match (Sinner up a set and a break on Alcaraz). The relay's live lines (ai.json -> http://relay.stub/live) are
 * faked too, so live leans have real prices to beat. onyxSaved holds props (live, a cleared over, a broken under, a
 * box-score combo), spreads, totals, moneylines, a pregame pick and two 3-leg parlays (one with a dead leg).
 * On home.html at 390 and 1280 px it checks:
 *   - every OnyxCash.chance() is in [0, 1]; a cleared over is 1 (Cashed); a broken under is 0 (Lost); the dead-leg
 *     parlay is 0 (Lost); the live parlay is its legs multiplied and names the sweat leg; a spread covering by 6.5
 *     with 10 minutes left is over 50%; the pregame pick keeps its saved chance; plain-language need / status text
 *   - the 'onyx-cash' event fires; OnyxCash.mount draws a meter (percentage, bar, mini line) for every pick, no
 *     sideways scroll, no em dash, no NaN / undefined / null in the copy
 *   - a score change moves the meters on the next 30-second tick, the history keeps 2+ points, a big swing (15+
 *     points) raises the rail's "Big swing" toast, and a reload keeps the line (sessionStorage)
 *   - OnyxCash.leans('nba') returns sane live leans with Onyx links (the selection id when the line has one), and
 *     the live rail shows them as "Live leans" chips
 *   - no page errors
 *
 *   node tools/verify_cash.js [--shots=dir] [--w=390,1280]
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

// ── the fake ESPN ──────────────────────────────────────────────────────────
function teamEvent(id, start, st, away, home) {
  const status = { period: st.period, clock: st.clock, type: { state: st.state, shortDetail: st.detail, detail: st.detail } };
  const c = (ab, name, sc, ha) => ({ homeAway: ha, score: String(sc), team: { abbreviation: ab, displayName: name } });
  return { id, date: start, name: away[1] + ' at ' + home[1], status,
    competitions: [{ id, date: start, status, competitors: [c(home[0], home[1], home[2], 'home'), c(away[0], away[1], away[2], 'away')] }] };
}
function nbaBox(S) {
  const row = (n, pts, reb, ast, th) => ({ athlete: { displayName: n }, stats: ['30', String(pts), String(reb), String(ast), th] });
  return {
    header: { competitions: [{ status: { period: S.nba.period, type: { state: S.nba.state } }, competitors: [] }] },
    boxscore: { players: [{ team: { abbreviation: 'BOS' }, statistics: [{ labels: ['MIN', 'PTS', 'REB', 'AST', '3PT'], keys: ['minutes', 'points', 'rebounds', 'assists', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'],
      athletes: [row('Jayson Tatum', S.tatum, 6, 4, '2-6'), row('Jaylen Brown', 22, 5, 2, '3-5'), row('Jrue Holiday', 14, 4, 5, '2-3'), row('Derrick White', 12, 4, 3, '3-7')] }] }] },
  };
}
function tennisBoard(S, start) {
  const pl = (name, sets, ha, srv) => ({ homeAway: ha, possession: srv, athlete: { displayName: name }, linescores: sets.map(v => ({ value: v })) });
  return { events: [{ id: '700', name: 'Rolex Paris Masters', date: start, groupings: [{ grouping: { displayName: "Men's Singles" }, competitions: [{
    id: '701', date: start, status: { type: { state: S.tn.state, shortDetail: S.tn.state === 'in' ? 'In Progress' : 'Final' } },
    competitors: [pl('Jannik Sinner', S.tn.a, 'home', true), pl('Carlos Alcaraz', S.tn.b, 'away', false)] }] }] }] };
}
function liveState() {
  return { nfl: { state: 'in', period: 3, clock: 252, detail: '4:12 - 3rd', a: 17, h: 14 },
           nba: { state: 'in', period: 4, clock: 600, detail: '10:00 - 4th', a: 90, h: 80 },
           nhl: { state: 'in', period: 2, clock: 480, detail: '8:00 - 2nd', a: 2, h: 1 },
           tn: { state: 'in', a: [6, 2], b: [4, 1] }, tatum: 18 };
}
function picks(start, later) {
  const nba = { sport: 'nba', team: 'BOS', matchup: 'BOS @ NY', start, gid: '501' };
  const prop = (id, name, mkt, side, line, conf) => Object.assign({ id, kind: 'prop', name, mkt, side, line, conf, price: -115, label: name + ' ' + (side === 'over' ? 'Over ' : 'Under ') + line + ' ' + mkt, saved: start }, nba);
  const P = {
    tatum: prop('test:tatum', 'Jayson Tatum', 'pts', 'over', 27.5, 0.55),
    brown: prop('test:brown', 'Jaylen Brown', 'pts', 'over', 15.5, 0.6),
    holiday: prop('test:holiday', 'Jrue Holiday', 'pts', 'under', 10.5, 0.55),
    white: prop('test:white', 'Derrick White', 'pra', 'over', 20.5, 0.5),
    spread: Object.assign({ id: 'test:bos-spread', kind: 'spread', name: 'BOS', hcap: -3.5, conf: 0.52, price: -110, label: 'BOS -3.5' }, nba),
    buf: { id: 'test:buf', sport: 'nfl', kind: 'ml', name: 'BUF', team: 'BUF', gid: '401', label: 'BUF to win', matchup: 'BUF @ KC', start, conf: 0.48, price: 110 },
    nflo: { id: 'test:nfl-over', sport: 'nfl', kind: 'total', side: 'over', line: 47.5, name: 'Total', gid: '401', label: 'Over 47.5', matchup: 'BUF @ KC', start, conf: 0.52, price: -110 },
    nyr: { id: 'test:nyr', sport: 'nhl', kind: 'ml', name: 'NYR', team: 'NYR', gid: '601', label: 'NYR to win', matchup: 'NYR @ TOR', start, conf: 0.47, price: 115 },
    nhlo: { id: 'test:nhl-over', sport: 'nhl', kind: 'total', side: 'over', line: 5.5, name: 'Total', gid: '601', label: 'Over 5.5', matchup: 'NYR @ TOR', start, conf: 0.5, price: -105 },
    sinner: { id: 'test:sinner', sport: 'tennis', kind: 'ml', name: 'Jannik Sinner', label: 'Sinner to win', matchup: 'Alcaraz vs Sinner', start, conf: 0.55, price: -125 },
    pre: { id: 'test:pre', sport: 'nba', kind: 'ml', name: 'LAL', team: 'LAL', label: 'LAL to win', matchup: 'LAL @ GS', start: later, conf: 0.58, price: -140 },
  };
  const leg = x => { const l = Object.assign({}, x); delete l.saved; return l; };
  P.dead = { id: 't:test:dead:3', kind: 'parlay', sport: 'multi', label: '3-leg parlay', matchup: 'dead leg', start, conf: 0.15, price: 600, saved: start,
             legs: [leg(P.holiday), leg(P.buf), leg(P.nflo)] };
  P.live = { id: 't:test:live:3', kind: 'parlay', sport: 'multi', label: '3-leg parlay', matchup: 'live legs', start, conf: 0.14, price: 650, saved: start,
             legs: [leg(P.tatum), leg(P.nyr), leg(P.sinner)] };
  return P;
}

async function run(browser, base, w) {
  const bad = [];
  const phone = w < 761;
  const NOW = Date.now(), start = new Date(NOW - 75 * 60e3).toISOString(), later = new Date(NOW + 3 * 3600e3).toISOString();
  const S = liveState(), P = picks(start, later), LINES = { nba: [] };
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, ...(phone ? { userAgent: UA } : {}) });
  await ctx.addInitScript(([list]) => {
    try {
      if (!sessionStorage.getItem('cashSeeded')) {
        localStorage.setItem('onyx-new-2026-10-26b', '1');
        localStorage.setItem('onyxSaved', JSON.stringify(list));
        localStorage.setItem('onyxWinShown', JSON.stringify({'test:brown': Date.now(), 't:test:live:3': Date.now()}));   // the win pop-up is saved.js's; keep it off the screenshots
        sessionStorage.setItem('cashSeeded', '1');
      }
    } catch (e) {}
  }, [Object.values(P)]);
  await ctx.clock.install({ time: NOW });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
    if (u.startsWith('http://relay.stub/live')) {
      const sp = new URL(u).searchParams.get('sport');
      const games = sp === 'nba' && LINES.nba.length ? [{ home: 'New York Knicks', away: 'Boston Celtics', lines: LINES.nba }] : [];
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ sport: sp, games }) });
    }
    const m = /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/([a-z-]+\/[a-z-]+)\/(scoreboard|summary)/.exec(u);
    if (!m) return r.abort();
    const key = m[1] + '/' + m[2];
    let body = { events: [] };
    if (key === 'football/nfl/scoreboard') body = { events: [teamEvent('401', start, S.nfl, ['BUF', 'Buffalo Bills', S.nfl.a], ['KC', 'Kansas City Chiefs', S.nfl.h])] };
    else if (key === 'basketball/nba/scoreboard') body = { events: [teamEvent('501', start, S.nba, ['BOS', 'Boston Celtics', S.nba.a], ['NY', 'New York Knicks', S.nba.h])] };
    else if (key === 'hockey/nhl/scoreboard') body = { events: [teamEvent('601', start, S.nhl, ['NYR', 'New York Rangers', S.nhl.a], ['TOR', 'Toronto Maple Leafs', S.nhl.h])] };
    else if (key === 'tennis/atp/scoreboard') body = tennisBoard(S, start);
    else if (key === 'basketball/nba/summary') body = nbaBox(S);
    else if (m[2] === 'summary') return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await p.goto(`${base}/home.html`, { waitUntil: 'domcontentloaded' });
  const loaded = await p.waitForFunction(() => window.OnyxCash && window.OnyxSaved, null, { timeout: 15000 }).then(() => true, () => false);
  if (!loaded) { bad.push('OnyxCash did not load on home.html'); await ctx.close(); return bad; }
  await p.evaluate(() => { window.__cashEv = 0; addEventListener('onyx-cash', () => window.__cashEv++); window.__toasts = []; const t = window.OX_TOAST; window.OX_TOAST = function (m) { window.__toasts.push(String(m)); return t && t.apply(this, arguments); }; });

  // 1. the numbers
  const R = await p.evaluate(async () => {
    const out = {};
    for (const x of OnyxSaved.all()) out[x.id] = await OnyxCash.chance(x);
    return out;
  });
  const g = id => R[id] || {};
  const all = Object.values(R);
  if (all.length !== Object.keys(P).length) bad.push(`chances for ${all.length} of ${Object.keys(P).length} saved picks`);
  all.forEach(r => { if (r.p != null && !(r.p >= 0 && r.p <= 1)) bad.push(`${r.id}: chance ${r.p} out of [0,1]`); });
  for (const id of ['test:tatum', 'test:white', 'test:bos-spread', 'test:buf', 'test:nfl-over', 'test:nyr', 'test:nhl-over', 'test:sinner']) {
    const r = g(id);
    if (r.state !== 'live') bad.push(`${id}: state ${r.state}, want live`);
    if (r.p == null || r.p <= 0 || r.p >= 1) bad.push(`${id}: live chance ${r.p} should be strictly between 0 and 1`);
    if (!r.status || !/\d+%$/.test(r.status)) bad.push(`${id}: status "${r.status}"`);
    if (!r.now) bad.push(`${id}: no "now" text`);
  }
  if (g('test:brown').p !== 1 || g('test:brown').res !== 'W' || g('test:brown').status !== 'Cashed') bad.push('cleared over: ' + JSON.stringify(g('test:brown')).slice(0, 160));
  if (g('test:holiday').p !== 0 || g('test:holiday').res !== 'L' || g('test:holiday').status !== 'Lost') bad.push('broken under: ' + JSON.stringify(g('test:holiday')).slice(0, 160));
  if (!(g('test:bos-spread').p > 0.5)) bad.push('BOS -3.5 up 10 with 10:00 left: ' + g('test:bos-spread').p);
  if (!(g('test:nyr').p > 0.5)) bad.push('NYR up 2-1 in the 2nd: ' + g('test:nyr').p);
  if (!(g('test:sinner').p > 0.6)) bad.push('Sinner up a set and a break: ' + g('test:sinner').p);
  if (!/^Needs 10 more pts in 10 min$/.test(g('test:tatum').need)) bad.push('Tatum need text: ' + g('test:tatum').need);
  if (!(g('test:tatum').p < 0.5)) bad.push('Tatum needs 10 in 10 min, chance should be under 50%: ' + g('test:tatum').p);
  if (!/^19 PRA/.test(g('test:white').now)) bad.push('White PRA from the box score: ' + g('test:white').now);
  if (!/^Covering by 6\.5/.test(g('test:bos-spread').need)) bad.push('spread need text: ' + g('test:bos-spread').need);
  if (g('test:pre').state !== 'pre' || g('test:pre').p !== 0.58) bad.push('pregame pick: ' + JSON.stringify(g('test:pre')).slice(0, 160));
  const D = g('t:test:dead:3'), L = g('t:test:live:3');
  if (D.p !== 0 || D.res !== 'L') bad.push('dead-leg parlay: p ' + D.p + ' res ' + D.res);
  const prod = ['test:tatum', 'test:nyr', 'test:sinner'].reduce((m, id) => m * g(id).p, 1);
  if (L.p == null || Math.abs(L.p - prod) > 0.02) bad.push(`live parlay ${L.p} vs legs multiplied ${prod}`);
  if (!/^Sweat: /.test(L.need || '')) bad.push('live parlay sweat: ' + L.need);
  if (!L.legs || L.legs.length !== 3) bad.push('live parlay legs missing');
  if (!(await p.evaluate(() => window.__cashEv)) && !(await p.evaluate(() => OnyxCash.history('test:tatum').length))) bad.push('no onyx-cash event');
  console.log(`    @${w} Tatum ${pct(g('test:tatum').p)} (${g('test:tatum').need}), BOS -3.5 ${pct(g('test:bos-spread').p)}, BUF ML ${pct(g('test:buf').p)}, NFL o47.5 ${pct(g('test:nfl-over').p)}, NYR ${pct(g('test:nyr').p)}, NHL o5.5 ${pct(g('test:nhl-over').p)}, Sinner ${pct(g('test:sinner').p)}, parlay ${pct(L.p)} (${L.need})`);

  // 2. the meters
  await p.evaluate(ids => {
    const box = document.createElement('div'); box.id = 'cashTest';
    box.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:10px;padding:12px 16px;background:#0c0c0c;position:relative;z-index:5';
    const h = document.querySelector('body > header.ox-head, body > nav.nav, #onyxRail');
    const at = document.getElementById('onyxRail') || h;
    if (at && at.parentNode) at.parentNode.insertBefore(box, at.nextSibling); else document.body.insertBefore(box, document.body.firstChild);
    window.__m = [];
    OnyxSaved.all().filter(x => ids.indexOf(x.id) >= 0).forEach(x => {
      const c = document.createElement('div'); c.className = 'cash-cell'; c.setAttribute('data-id', x.id);
      c.innerHTML = '<div style="font:700 12px system-ui;color:#fff;margin:0 0 6px">' + x.label + '</div>';
      box.appendChild(c); window.__m.push(OnyxCash.mount(c, x));
    });
  }, ['test:tatum', 'test:bos-spread', 'test:sinner', 't:test:live:3', 'test:brown', 't:test:dead:3', 'test:pre', 'test:nhl-over']);
  const drawn = await p.waitForFunction(() => document.querySelectorAll('#cashTest .ocx').length === 8 && Array.from(document.querySelectorAll('#cashTest .ocx')).every(e => e.querySelector('svg polyline')), null, { timeout: 10000 }).then(() => true, () => false);
  if (!drawn) bad.push('meters did not render (want 8 with a line)');
  const M = await p.evaluate(() => ({
    sw: document.scrollingElement.scrollWidth, iw: innerWidth,
    cells: Array.from(document.querySelectorAll('#cashTest .ocx')).map(e => ({ p: e.getAttribute('data-p'), tone: e.getAttribute('data-tone'), res: e.getAttribute('data-res'), txt: e.innerText, w: e.getBoundingClientRect().width, stroke: (e.querySelector('polyline') || {}).getAttribute && e.querySelector('polyline').getAttribute('stroke') })),
  }));
  if (M.sw > M.iw + 1) bad.push(`sideways scroll ${M.sw} > ${M.iw}`);
  M.cells.forEach(c => {
    if (c.p !== '' && !(+c.p >= 0 && +c.p <= 1)) bad.push('meter data-p ' + c.p);
    if (/—/.test(c.txt)) bad.push('em dash in a meter');
    if (/NaN|undefined|null|Infinity/.test(c.txt)) bad.push('bad value in a meter: ' + c.txt.replace(/\s+/g, ' ').slice(0, 120));
    if (c.w > M.iw) bad.push('meter wider than the screen');
    const want = c.res === 'W' ? '#61e970' : c.res === 'L' ? '#ff8a8a' : +c.p >= 0.6 ? '#61e970' : c.p !== '' && +c.p <= 0.25 ? '#ff8a8a' : '#b038f9';
    if (c.stroke !== want) bad.push(`line color ${c.stroke} for p ${c.p} res ${c.res}, want ${want}`);
  });
  if (!M.cells.some(c => /Cashed/.test(c.txt))) bad.push('no "Cashed" meter');
  if (!M.cells.some(c => /Lost/.test(c.txt))) bad.push('no "Lost" meter');
  if (!M.cells.some(c => /Trending to cash|Too close to call|Behind pace|Long shot/.test(c.txt))) bad.push('no live status words');
  if (SHOTS) {
    const top = await p.evaluate(() => document.getElementById('cashTest').getBoundingClientRect().top + scrollY);
    await p.evaluate(y => scrollTo(0, Math.max(0, y - 60)), top);
    await p.screenshot({ path: path.join(SHOTS, `live-meters-${w}.png`), clip: { x: 0, y: 0, width: w, height: phone ? 844 : 900 } });
    await p.evaluate(() => scrollTo(0, 0));
  }

  // 3. live leans: price the home moneyline 6 points under our live chance, with an Onyx selection id
  // the live spread nearest a coin flip (home line hl), from live.js's own model of this game
  const sp = await p.evaluate(async () => {
    await OnyxCash.ensureLive(); const G = await OnyxLive.games(['nba']); if (!G[0]) return null;
    let best = null; for (let hl = -20; hl <= 20; hl += 1) { const c = G[0].M.cover(hl + 0.5); if (!best || Math.abs(c - 0.5) < Math.abs(best.c - 0.5)) best = { hl: hl + 0.5, c }; }
    return best;
  });
  if (sp == null) bad.push('live.js saw no NBA game');
  else {
    const am = q => { const x = q >= 0.5 ? -100 * q / (1 - q) : 100 * (1 - q) / q; return Math.round(x / 5) * 5; };
    // BOS (away) takes -hl at a price 6 points softer than our chance; NY at a fair price
    LINES.nba = [{ m: 'spread', sel: 'Boston Celtics', pt: -sp.hl, price: am(1 - sp.c - 0.06), id: 'sel-bos-ml' }, { m: 'spread', sel: 'New York Knicks', pt: sp.hl, price: am(sp.c) }];
    await p.clock.runFor(31000);
    const leans = await p.evaluate(() => OnyxCash.leans('nba'));
    if (!leans.length) bad.push('no live leans against a soft live line');
    leans.forEach(x => {
      if (!(x.p > 0 && x.p < 1) || !(x.edge >= 0.03) || x.price == null || !x.label || !x.matchup) bad.push('lean not sane: ' + JSON.stringify(x));
      if (!/^https:\/\/app\.onyxodds\.com\//.test(x.href) || !/referrer=KR680261/.test(x.href)) bad.push('lean link ' + x.href);
    });
    if (leans[0] && (leans[0].sel !== 'sel-bos-ml' || !/selection=sel-bos-ml/.test(leans[0].href))) bad.push('lean selection id not carried: ' + JSON.stringify(leans[0]));
    await p.clock.runFor(91000);
    const chips = await p.waitForFunction(() => document.querySelectorAll('#onyxRail .olr-ln').length, null, { timeout: 8000 }).then(() => true, () => false);
    if (!chips) bad.push('no Live leans chips on the rail');
    else {
      const rr = await p.evaluate(() => ({ h: document.getElementById('onyxRail').getBoundingClientRect().height, t: document.querySelector('#onyxRail .olr-leans').innerText }));
      if (Math.round(rr.h) !== 44) bad.push('rail height with leans ' + rr.h);
      if (!/Live leans/i.test(rr.t)) bad.push('leans label: ' + rr.t);
      if (SHOTS) {
        await p.evaluate(() => { const l = document.querySelector('#onyxRail .olr-leans'), b = document.querySelector('#onyxRail .olr-in'); b.scrollLeft = l.offsetLeft - 16; });
        await p.screenshot({ path: path.join(SHOTS, `live-leans-${w}.png`), clip: { x: 0, y: 0, width: w, height: 200 } });
        await p.evaluate(() => { document.querySelector('#onyxRail .olr-in').scrollLeft = 0; });
      }
    }
  }

  // 4. a swing: BOS falls behind; the meters move on the next tick and the rail raises a big-swing toast
  const before = await p.evaluate(() => +document.querySelector('#cashTest [data-id="test:bos-spread"] .ocx').getAttribute('data-p'));
  S.nba.a = 80; S.nba.h = 95; S.tatum = 22;
  // two ticks: saved.js keeps a scoreboard 30 s, so the first tick after a change can still read the old score
  await p.clock.runFor(31000); await p.waitForTimeout(600); await p.clock.runFor(31000);
  const moved = await p.waitForFunction(b => { const e = document.querySelector('#cashTest [data-id="test:bos-spread"] .ocx'); return e && Math.abs(+e.getAttribute('data-p') - b) > 0.15; }, before, { timeout: 8000 }).then(() => true, () => false);
  if (!moved) bad.push('the spread meter did not move on a score change');
  const swung = await p.waitForFunction(() => (window.__toasts || []).some(t => /^Big swing: /.test(t)), null, { timeout: 8000 }).then(() => true, () => false);
  if (!swung) bad.push('no big-swing toast on the rail (toasts: ' + JSON.stringify(await p.evaluate(() => window.__toasts)) + ')');
  const hist = await p.evaluate(() => OnyxCash.history('test:bos-spread').length);
  if (hist < 2) bad.push('history has ' + hist + ' points after a change');
  const rail = await p.evaluate(() => { const r = document.getElementById('onyxRail'); return r ? { txt: r.innerText, sp: r.querySelectorAll('.olr-sp').length } : null; });
  if (!rail || !rail.sp) bad.push('rail bets have no mini line');
  if (rail && !/19 of 20\.5/.test(rail.txt)) bad.push('rail: White PRA progress from the box score missing');
  if (rail && /NaN|undefined|null|Infinity|—/.test(rail.txt)) bad.push('bad value in the rail: ' + rail.txt.replace(/\s+/g, ' ').slice(0, 160));
  if (SHOTS) {
    await p.screenshot({ path: path.join(SHOTS, `live-rail-${w}.png`), clip: { x: 0, y: 0, width: w, height: 260 } });
    const top = await p.evaluate(() => document.getElementById('cashTest').getBoundingClientRect().top + scrollY);
    await p.evaluate(y => scrollTo(0, Math.max(0, y - 60)), top);
    await p.screenshot({ path: path.join(SHOTS, `live-meters-swing-${w}.png`), clip: { x: 0, y: 0, width: w, height: phone ? 844 : 900 } });
  }

  // 5. a reload keeps the line
  const n0 = await p.evaluate(() => OnyxCash.history('test:bos-spread').length);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.OnyxCash, null, { timeout: 15000 }).catch(() => {});
  const n1 = await p.evaluate(() => window.OnyxCash ? OnyxCash.history('test:bos-spread').length : 0);
  if (n1 < n0 || n1 < 2) bad.push(`history after a reload: ${n1} points (had ${n0})`);

  if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
  await ctx.close();
  return bad;
}
function pct(x) { return x == null ? '-' : Math.round(100 * x) + '%'; }

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
  if (fails) { console.log(`\nverify_cash: ${fails} failing`); process.exit(1); }
  console.log('\nverify_cash: all checks pass');
})().catch(e => { console.error(e); process.exit(1); });
