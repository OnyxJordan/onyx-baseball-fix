#!/usr/bin/env node
/**
 * verify_live_rail.js - "Live everywhere" (onyx-live-rail.js, loaded on every page by ui.js), dev + CI.
 *
 * Fake ESPN scoreboards and a box score are fed through Playwright routes: an NFL game (BUF @ KC) and an NBA game
 * (BOS @ NYK) in play, a saved NBA prop (Tatum over 27.5 points, 18 so far) and a saved 2-leg NFL parlay ticket
 * (BUF to win + over 47.5) in OnyxSaved. The page clock is faked so the 30-second refreshes run on demand.
 * On home.html, nfl.html, nba.html and index.html, at 390 and 1280 px:
 *   - the rail renders under the header (never under it or over the bottom bar), 44 px tall, no sideways scroll
 *   - its games are this page's sport (every sport on the hub), each linking to its gamecenter
 *   - Your bets shows the prop's progress ("18 of 27.5"), a live chance and a status color, and the parlay's legs,
 *     each linking to studio.html?sport=<k>#sweat
 *   - a score change rolls the score in and flashes that game; the prop clearing its line turns the leg "Hit" and
 *     raises a toast; the rail's height does not change on an update
 *   - every game final: the rail collapses to nothing (0 px) and a "Final" toast shows
 *   - no page errors
 * On the hub at 390 px also: a hidden tab polls nothing, and saved.js + the rail share one ESPN scoreboard request
 * per refresh (the OnyxESPN cache).
 *
 *   node tools/verify_live_rail.js [--shots=dir] [--pages=home.html,nfl.html] [--w=390,1280]
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
const PAGES = [['home.html', ['NFL', 'NBA']], ['nfl.html', ['NFL']], ['nba.html', ['NBA']], ['index.html', []]];

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (rel === 'ai.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"url":""}'); return; }
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
function fixtures(S, start) {
  return {
    nfl: { events: [teamEvent('401', start, S.nfl, ['BUF', 'Buffalo Bills', S.nfl.a], ['KC', 'Kansas City Chiefs', S.nfl.h])] },
    nba: { events: [teamEvent('501', start, S.nba, ['BOS', 'Boston Celtics', S.nba.a], ['NY', 'New York Knicks', S.nba.h])] },
    nbaSummary: {
      header: { competitions: [{ status: { period: S.nba.period, type: { state: S.nba.state } }, competitors: [] }] },
      boxscore: { players: [{ team: { abbreviation: 'BOS' }, statistics: [{ labels: ['MIN', 'PTS', 'REB', 'AST'], keys: ['minutes', 'points', 'rebounds', 'assists'],
        athletes: [{ athlete: { displayName: 'Jayson Tatum' }, stats: ['28', String(S.tatum), '6', '4'] }] }] }] },
    },
  };
}
function liveState() {
  return { nfl: { state: 'in', period: 3, clock: 252, detail: '4:12 - 3rd', a: 17, h: 14 },
           nba: { state: 'in', period: 3, clock: 300, detail: '5:00 - 3rd', a: 70, h: 66 }, tatum: 18 };
}

function picks(start) {
  return [
    { id: 'test:tatum', sport: 'nba', kind: 'prop', mkt: 'pts', side: 'over', line: 27.5, name: 'Jayson Tatum', team: 'BOS',
      label: 'Jayson Tatum Over 27.5 points', matchup: 'BOS @ NY', start, conf: 0.55, price: -115, saved: start },
    { id: 't:test:2', kind: 'parlay', sport: 'nfl', label: '2-leg parlay', matchup: 'BUF to win + Over 47.5 total', start, conf: 0.25, price: 260, saved: start,
      legs: [{ id: 'leg:buf', sport: 'nfl', kind: 'ml', name: 'BUF', team: 'BUF', gid: '401', label: 'BUF to win', matchup: 'BUF @ KC', start, conf: 0.48, price: 110 },
             { id: 'leg:ovr', sport: 'nfl', kind: 'total', side: 'over', line: 47.5, name: 'Total', gid: '401', label: 'Over 47.5 total', matchup: 'BUF @ KC', start, conf: 0.52, price: -110 }] },
  ];
}

async function run(browser, base, page, wantTags, w, extra) {
  const bad = [];
  const phone = w < 761;
  const NOW = Date.now(), start = new Date(NOW - 75 * 60e3).toISOString();
  const S = liveState();
  const hits = { sb: {}, total: 0 };
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, ...(phone ? { userAgent: UA } : {}) });
  await ctx.addInitScript(([P]) => {
    try {
      if (!sessionStorage.getItem('railSeeded')) {
        localStorage.setItem('onyx-new-2026-10-26b', '1');
        localStorage.setItem('onyxSaved', JSON.stringify(P));
        sessionStorage.setItem('railSeeded', '1');
      }
    } catch (e) {}
  }, [picks(start)]);
  await ctx.clock.install({ time: NOW });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.constructor.name + ': ' + e.message));
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
    const m = /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/([a-z-]+\/[a-z-]+)\/(scoreboard|summary)/.exec(u);
    if (!m) return r.abort();
    hits.total++;
    const F = fixtures(S, start), key = m[1] + '/' + m[2];
    hits.sb[key] = (hits.sb[key] || 0) + 1;
    let body = { events: [] };
    if (key === 'football/nfl/scoreboard') body = F.nfl;
    else if (key === 'basketball/nba/scoreboard') body = F.nba;
    else if (key === 'basketball/nba/summary') body = F.nbaSummary;
    else if (m[2] === 'summary') return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await p.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' });
  const ok = await p.waitForFunction(() => {
    const r = document.getElementById('onyxRail');
    return r && r.getAttribute('data-state') === 'on' && r.querySelector('.olr-bet') && /of 27\.5/.test(r.textContent);
  }, null, { timeout: 15000 }).then(() => true, () => false);
  if (!ok) { bad.push('rail did not render with the saved bets'); }
  // every toast the page raises, kept (a toast leaves the screen after a few seconds of page time)
  await p.evaluate(() => { window.__toasts = []; const t = window.OX_TOAST; window.OX_TOAST = function (m, o) { window.__toasts.push(String(m)); return t && t.apply(this, arguments); }; });

  const geo = () => p.evaluate(() => {
    const r = document.getElementById('onyxRail'), q = s => document.querySelector(s);
    const hd = q('body > nav.nav, body > header.ox-head') || q('nav.nav, header.ox-head');
    const bar = q('.obar'), rb = r ? r.getBoundingClientRect() : null, hb = hd ? hd.getBoundingClientRect() : null;
    const barR = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect() : null;
    return { has: !!r, hidden: r ? r.hidden : true, h: rb ? rb.height : 0, top: rb ? rb.top : 0, bottom: rb ? rb.bottom : 0,
             headBottom: hb ? hb.bottom : null, barTop: barR ? barR.top : null, prev: r && r.previousElementSibling ? r.previousElementSibling.tagName + '.' + r.previousElementSibling.className : '',
             sw: document.scrollingElement.scrollWidth, iw: innerWidth,
             tags: Array.from(document.querySelectorAll('#onyxRail .olr-g')).map(a => ({ href: a.getAttribute('href'), txt: a.textContent })),
             bets: Array.from(document.querySelectorAll('#onyxRail .olr-bet')).map(a => ({ href: a.getAttribute('href'), txt: a.textContent, tones: Array.from(a.querySelectorAll('[class*="t-"]')).map(x => (x.className.match(/t-(\w+)/) || [])[1]) })),
             toasts: Array.from(document.querySelectorAll('.otoast')).map(t => t.textContent) };
  });
  let g = await geo();
  if (ok) {
    if (Math.round(g.h) !== 44) bad.push('rail height ' + g.h + ', want 44');
    if (g.headBottom != null && g.top < g.headBottom - 1) bad.push(`rail top ${g.top} is under the header (bottom ${g.headBottom})`);
    if (g.barTop != null && g.bottom > g.barTop) bad.push('rail runs into the bottom bar');
    if (g.sw > g.iw + 1) bad.push(`sideways scroll ${g.sw} > ${g.iw}`);
    const games = g.tags;
    const wantNfl = wantTags.includes('NFL'), wantNba = wantTags.includes('NBA');
    if (wantNfl !== games.some(x => /BUF/.test(x.txt))) bad.push('NFL game ' + (wantNfl ? 'missing' : 'should not show'));
    if (wantNba !== games.some(x => /BOS/.test(x.txt))) bad.push('NBA game ' + (wantNba ? 'missing' : 'should not show'));
    const nflG = games.find(x => /BUF/.test(x.txt));
    if (nflG && nflG.href !== 'nfl.html#games:401') bad.push('NFL gamecenter link ' + nflG.href);
    if (nflG && !/17/.test(nflG.txt) || nflG && !/3rd/.test(nflG.txt)) bad.push('NFL score or clock missing: ' + nflG.txt);
    const tat = g.bets.find(b => /Tatum/.test(b.txt)), tk = g.bets.find(b => /parlay/.test(b.txt));
    if (!tat) bad.push('Tatum bet missing');
    else {
      if (!/18 of 27\.5/.test(tat.txt)) bad.push('Tatum progress: ' + tat.txt);
      if (!/\d+%/.test(tat.txt)) bad.push('Tatum live chance missing: ' + tat.txt);
      if (tat.href !== 'studio.html?sport=nba#sweat') bad.push('Tatum sweat link ' + tat.href);
      if (!tat.tones.length) bad.push('Tatum status color missing');
    }
    if (!tk) bad.push('parlay ticket missing');
    else {
      if (!/BUF/.test(tk.txt) || !/Over 47\.5/.test(tk.txt) || !/31 of 47\.5/.test(tk.txt)) bad.push('parlay legs: ' + tk.txt);
      if (tk.href !== 'studio.html?sport=nfl#sweat') bad.push('parlay sweat link ' + tk.href);
    }
    const txt = await p.evaluate(() => document.getElementById('onyxRail').innerText);
    if (/—/.test(txt)) bad.push('em dash in the rail');
    if (/NaN|undefined|null|Infinity/.test(txt)) bad.push('bad value in the rail: ' + txt.replace(/\s+/g, ' ').slice(0, 200));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `rail_${page.replace('.html', '')}_${w}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(phone ? 844 : 900, Math.ceil(g.bottom) + 160) } });

    // a score change: rolls in, flashes the game, the prop clears its line (Hit + a toast), the height holds
    S.nfl.a = 24; S.nba.a = 73; S.tatum = 30;
    const before = await p.evaluate(() => (window.__shifts = 0, new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__shifts += e.value; })).observe({ type: 'layout-shift' }), 1));
    await p.clock.runFor(31000);
    const flashed = await p.waitForFunction(() => {
      const f = document.querySelector('#onyxRail .olr-g[data-flashed]'); return f && f.querySelector('.olr-s.up') ? f.textContent : null;
    }, null, { timeout: 8000 }).then(h => h.jsonValue(), () => null);
    if (wantTags.length && !flashed) bad.push('no flash on a score change');
    if (flashed && !/24|73/.test(flashed)) bad.push('flashed game shows the old score: ' + flashed);
    const hit = await p.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll('#onyxRail .olr-bet')).find(a => /Tatum/.test(a.textContent));
      return b && b.querySelector('.t-hit') && (window.__toasts || []).some(t => /^Leg hit: Tatum/.test(t));
    }, null, { timeout: 8000 }).then(() => true, () => false);
    if (!hit) bad.push('Tatum clearing 27.5 did not show Hit with a toast');
    g = await geo();
    if (Math.round(g.h) !== 44) bad.push('rail height changed on update: ' + g.h);
    const shift = await p.evaluate(() => window.__shifts || 0);
    if (shift > 0.001) bad.push('layout shift on a rail update: ' + shift.toFixed(4));

    if (extra) await extra(p, hits, bad, S);

    // every game final: the rail collapses to nothing and the final toast shows
    S.nfl.state = 'post'; S.nfl.detail = 'Final'; S.nba.state = 'post'; S.nba.detail = 'Final';
    await p.clock.runFor(31000);
    const gone = await p.waitForFunction(() => { const r = document.getElementById('onyxRail'); return r && r.hidden && r.offsetHeight === 0; }, null, { timeout: 8000 }).then(() => true, () => false);
    if (!gone) bad.push('rail did not collapse when nothing is live');
    const fin = await p.waitForFunction(() => (window.__toasts || []).some(t => /^Final: /.test(t)), null, { timeout: 8000 }).then(() => true, () => false);
    if (!fin) bad.push('no Final toast');
  }
  if (errs.length) bad.push('page errors: ' + errs.slice(0, 3).join(' | '));
  await ctx.close();
  return bad;
}

// the hub at 390 also: shared ESPN requests, and nothing polls while the tab is hidden
async function hubExtra(p, hits, bad) {
  const nba0 = hits.sb['basketball/nba/scoreboard'] || 0;
  for (let i = 0; i < 3; i++) { await p.clock.runFor(30000); await p.waitForTimeout(700); }
  const nba = (hits.sb['basketball/nba/scoreboard'] || 0) - nba0;
  // three rail refreshes and two saved.js passes (45 s) plus live.js on the hub: one request per refresh, at most one stray
  if (nba > 4) bad.push(`NBA scoreboard fetched ${nba} times in 90 s: saved.js and the rail are not sharing`);
  console.log(`    shared cache: NBA scoreboard ${nba} requests in 90 s of play`);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  // the rail's own refreshes (home.html's My picks keeps its own timer; that one is the page's)
  const t0 = await p.evaluate(() => OnyxRail.polls());
  await p.clock.runFor(200000); await p.waitForTimeout(700);
  const t1 = await p.evaluate(() => OnyxRail.polls());
  if (t1 !== t0) bad.push(`${t1 - t0} rail refreshes while the tab was hidden`);
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.clock.runFor(2000); await p.waitForTimeout(700);
  if (await p.evaluate(() => OnyxRail.polls()) === t1) bad.push('no refresh when the tab came back');
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let fails = 0;
  const only = arg('pages', ''), widths = arg('w', '390,1280').split(',').map(Number);
  for (const w of widths) {
    for (const [page, tags] of PAGES) {
      if (only && !only.split(',').includes(page)) continue;
      if (!fs.existsSync(path.join(ROOT, page))) { console.log(`  skip ${page} (not built)`); continue; }
      const bad = await run(browser, base, page, tags, w, page === 'home.html' && w === 390 ? hubExtra : null);
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${page} @${w}${bad.length ? '\n      ' + bad.join('\n      ') : ''}`);
      fails += bad.length ? 1 : 0;
    }
  }
  await browser.close(); server.close();
  if (fails) { console.log(`\nverify_live_rail: ${fails} failing`); process.exit(1); }
  console.log('\nverify_live_rail: all pages pass');
})().catch(e => { console.error(e); process.exit(1); });
