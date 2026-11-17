#!/usr/bin/env node
/**
 * verify_field.js - the live football field (onyx-field.js) in the NFL and college football gamecenter, dev + CI.
 *
 * A fake ESPN (Playwright route + fulfill) serves the scoreboard and the summary of an in-progress game built on the
 * page's first game: drives of real ESPN shape (start/end spots, possessionText, home-relative yardLine, statYardage,
 * play text in ESPN's own wording) with a kickoff, a run up the middle, a sack, a deep pass right for a touchdown, a
 * penalty (no play), a short pass, an interception, an incompletion, a field goal, a punt with a return, and a current
 * drive. A saved prop on the touchdown catcher sits in OnyxSaved. On nfl.html at 390 and 1280 px:
 *   - the field renders inside the gamecenter (one SVG, 22 players, the ball), labelled as a reconstruction, no sideways
 *     scroll, the drive chart and the play list (one replay button per play)
 *   - every play type animates (the ball's transform changes mid-play) and ends on ESPN's end spot within 1 yard
 *   - the play list replays a tapped play; Follow plays a play that arrives on the next summary refresh
 *   - the saved player is ringed and his running stat shows against his line ("Pittman 88 / 92.5 rec yds")
 *   - prefers-reduced-motion jumps straight to the end state
 * On cfb.html (college text: "#10 J.Mateer pass complete short left to #7 J.Jordan caught at ..."): the field renders
 * and a pass and a run end on their spots. On nhl.html: no football field anywhere, the rink code is still there.
 * No page errors anywhere. Screenshots (several mid-animation frames) with --shots=<dir>.
 *
 *   node tools/verify_field.js [--shots=dir]
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const SHOTS = arg('shots', '');
const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); };

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
function sdOf(page) {
  const h = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const i = h.indexOf('/*SPORT_DATA*/') + 14, j = h.indexOf('/*END_SPORT_DATA*/', i);
  return JSON.parse(h.slice(i, j));
}

// ── the fake game ──────────────────────────────────────────────────────────
// x: 0 = the away goal line, 100 = the home goal line (onyx-field.js's frame). ESPN's yardLine counts from the home goal.
function game(g, ids, college) {
  const A = g.away, H = g.home, AID = ids[0], HID = ids[1];
  const spotTxt = x => x === 50 ? '50' : x < 50 ? `${A} ${x}` : `${H} ${100 - x}`;
  const ord = n => ['', '1st', '2nd', '3rd', '4th'][n] || '';
  const spot = (x, team, down, dist, plain) => {
    const o = { down: down || 0, distance: dist || 0, yardLine: 100 - x, yardsToEndzone: team === AID ? 100 - x : x, team: { id: team } };
    if (!plain && x > 0 && x < 100) { o.possessionText = spotTxt(x); if (down > 0) { o.downDistanceText = `${ord(down)} & ${dist} at ${spotTxt(x)}`; o.shortDownDistanceText = `${ord(down)} & ${dist}`; } }
    return o;
  };
  let seq = 0, clock = 900;
  const P = (key, type, text, x0, x1, off, d0, d1, o) => {
    o = o || {}; clock -= 35;
    const mm = Math.floor(clock / 60), ss = String(clock % 60).padStart(2, '0');
    const p = { id: g.gid + String(++seq).padStart(3, '0'), sequenceNumber: String(seq * 100), type: { text: type }, text,
      period: { number: 1 }, clock: { displayValue: `${mm}:${ss}` }, scoringPlay: !!o.score, isPenalty: !!o.pen, statYardage: o.yds != null ? o.yds : (x1 - x0) * (off === AID ? 1 : -1),
      start: spot(x0, off, d0 ? d0[0] : 0, d0 ? d0[1] : 0, o.plain0), end: spot(x1, o.endTeam || off, d1 ? d1[0] : 0, d1 ? d1[1] : 0, o.plain1),
      awayScore: 0, homeScore: 0 };
    p.key = key; p.expect = x1;
    return p;
  };
  const NFL = !college;
  const AQ = NFL ? 'D.Jones' : '#10 J.Mateer', AW = NFL ? 'M.Pittman' : '#7 J.Jordan', AR = NFL ? 'J.Taylor' : '#9 L.Avant';
  const HQ = NFL ? 'C.Stroud' : '#6 T.Chambliss', HW = NFL ? 'N.Collins' : '#9 L.Hasz', HR = NFL ? 'J.Mixon' : '#33 S.Mills-Knight';
  const d1 = [
    P('kickoff', 'Kickoff', `K.Fairbairn kicks 65 yards from ${H} 35 to ${A} 0. A.Pierce to ${A} 25 for 25 yards (J.Cox).`, 65, 25, HID, null, [1, 10], { plain0: true, endTeam: AID, yds: 25 }),
    P('run', 'Rush', `${AR} up the middle to ${A} 31 for 6 yards (A.Al-Shaair).`, 25, 31, AID, [1, 10], [2, 4]),
    P('sack', 'Sack', `(Shotgun) ${AQ} sacked at ${A} 24 for -7 yards (W.Anderson).`, 31, 24, AID, [2, 4], [3, 11]),
    P('passTD', 'Passing Touchdown', `(Shotgun) ${AQ} pass deep right to ${AW} for 76 yards, TOUCHDOWN. M.Gay extra point is GOOD, Center-L.Rhodes, Holder-R.Sanchez.`, 24, 100, AID, [3, 11], null, { score: 1, plain1: true }),
  ];
  const d2 = [
    P('kickoff2', 'Kickoff', `M.Gay kicks 65 yards from ${A} 35 to ${H} 0. Touchback.`, 35, 65, AID, null, [1, 10], { plain0: true, endTeam: HID, yds: 0 }),
    P('penalty', 'Penalty', `(Shotgun) ${HQ} pass short left to ${HW} to ${H} 45 for 10 yards (K.Moore). PENALTY on ${H}-L.Tunsil, Offensive Holding, 10 yards, enforced at ${H} 35 - No Play.`, 65, 75, HID, [1, 10], [1, 20], { pen: 1, yds: -10 }),
    P('passShort', 'Pass Reception', `${HQ} pass short middle to D.Schultz to ${H} 33 for 8 yards (Z.Franklin).`, 75, 67, HID, [1, 20], [2, 12]),
    P('int', 'Pass Interception Return', `(Shotgun) ${HQ} pass deep left intended for ${HW} INTERCEPTED by K.Moore at ${A} 40. K.Moore to ${H} 48 for 12 yards (${HW}).`, 67, 52, HID, [2, 12], [1, 10], { endTeam: AID, yds: 0 }),
  ];
  const d3 = [
    P('run2', 'Rush', `${AR} right tackle to ${H} 40 for 8 yards (D.Ogunjobi).`, 52, 60, AID, [1, 10], [2, 2]),
    P('inc', 'Pass Incompletion', `(Shotgun) ${AQ} pass incomplete short right to J.Downs (D.Stingley).`, 60, 60, AID, [2, 2], [3, 2]),
    P('scramble', 'Rush', `(Shotgun) ${AQ} scrambles left end to ${H} 40 for no gain (H.Al-Shaair).`, 60, 60, AID, [3, 2], [4, 2], { yds: 0 }),
    P('fg', 'Field Goal Good', `M.Gay 58 yard field goal is GOOD, Center-L.Rhodes, Holder-R.Sanchez.`, 60, 60, AID, [4, 2], null, { score: 1, plain1: true }),
  ];
  const d4 = [
    P('kickoff3', 'Kickoff', `M.Gay kicks 62 yards from ${A} 35 to ${H} 3. ${NFL ? 'D.Ogbonnia' : '#1 I.Sategna III'} to ${H} 30 for 27 yards (N.Cross).`, 35, 70, AID, null, [1, 10], { plain0: true, endTeam: HID, yds: 27 }),
    P('run3', 'Rush', `${HR} left end to ${H} 32 for 2 yards (Z.Franklin).`, 70, 68, HID, [1, 10], [2, 8]),
    P('punt', 'Punt', `T.Johnston punts 50 yards to ${A} 18, Center-J.Weeks. A.Pierce to ${A} 27 for 9 yards (D.Fells).`, 68, 27, HID, [4, 8], [1, 10], { endTeam: AID, yds: 0 }),
  ];
  const cur = [P('run4', 'Rush', `${AR} up the middle to ${A} 33 for 6 yards (D.Ogunjobi).`, 27, 33, AID, [1, 10], [2, 4])];
  const next = P('next', 'Pass Reception', `(Shotgun) ${AQ} pass short right to ${AW} to ${A} 45 for 12 yards (D.Stingley).`, 33, 45, AID, [2, 4], [1, 10]);
  const team = (id, ab) => ({ id, abbreviation: ab, displayName: ab, shortDisplayName: ab, logos: [{ href: 'https://a.espncdn.com/i/teamlogos/nfl/500/' + ab.toLowerCase() + '.png' }] });
  const drv = (id, t, ab, plays, res, desc) => ({ id, team: team(t, ab), description: desc, result: res, displayResult: res, plays });
  const comp = [{ homeAway: 'home', team: team(HID, H), score: '0' }, { homeAway: 'away', team: team(AID, A), score: '10' }];
  const summary = (withNext) => ({
    header: { competitions: [{ competitors: comp, status: { type: { state: 'in' } } }] },
    drives: { previous: [drv('d1', AID, A, d1, 'TD', '4 plays, 75 yards, 2:20'), drv('d2', HID, H, d2, 'INT', '4 plays, 13 yards, 2:20'),
      drv('d3', AID, A, d3, 'FG', '4 plays, 8 yards, 2:20'), drv('d4', HID, H, d4, 'PUNT', '3 plays, 2 yards, 1:45')],
      current: drv('d5', AID, A, withNext ? cur.concat([next]) : cur, '', '') },
    boxscore: { players: [{ team: { id: AID }, statistics: [{ name: 'receiving', labels: ['REC', 'YDS', 'TD', 'TGTS'],
      athletes: [{ athlete: { id: 'p1', displayName: NFL ? 'Michael Pittman Jr.' : 'Jaren Jordan', shortName: 'M. Pittman', position: { abbreviation: 'WR' } }, stats: ['4', '88', '1', '6'] }] }] }] },
    winprobability: [],
  });
  const scoreboard = () => ({ events: [{ id: g.gid, status: { type: { state: 'in', shortDetail: '6:10 - 1st' } },
    competitions: [{ competitors: [{ homeAway: 'home', score: '3', team: { id: HID, abbreviation: H } }, { homeAway: 'away', score: '10', team: { id: AID, abbreviation: A } }],
      situation: { possession: AID, possessionText: `${A} 33`, downDistanceText: `2nd & 4 at ${A} 33`, shortDownDistanceText: '2nd & 4', distance: 4, down: 2, yardLine: 67, isRedZone: false } }] }] });
  const all = d1.concat(d2, d3, d4, cur, [next]);
  const by = {}; all.forEach(p => { by[p.key] = p; });
  return { summary, scoreboard, by, next };
}

async function openPage(browser, page, w, opts) {
  opts = opts || {};
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone,
    ...(phone ? { userAgent: UA } : {}), ...(opts.reduced ? { reducedMotion: 'reduce' } : {}) });
  if (opts.saved) await ctx.addInitScript(([P]) => { try { localStorage.setItem('onyxSaved', JSON.stringify(P)); localStorage.setItem('onyxFieldFollow', '1'); } catch (e) {} }, [opts.saved]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  const st = { withNext: false };
  await p.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(opts.base)) return r.continue();
    if (opts.G && /site\.api\.espn\.com\/apis\/site\/v2\/sports\/football\/[^/]+\/scoreboard/.test(u)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(opts.G.scoreboard()) });
    if (opts.G && /site\.api\.espn\.com\/apis\/site\/v2\/sports\/football\/[^/]+\/summary/.test(u)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(opts.G.summary(st.withNext)) });
    if (/site\.api\.espn\.com/.test(u)) return r.fulfill({ contentType: 'application/json', body: '{"events":[]}' });
    return r.abort();
  });
  await p.goto(opts.base + '/' + page, { waitUntil: 'domcontentloaded' });
  return { ctx, p, errs, st };
}
async function openField(p, gid) {
  await p.waitForFunction(() => typeof openGame === 'function' && window.OnyxField);
  await p.waitForTimeout(400);
  await p.evaluate(g => openGame(g), gid);
  await p.waitForSelector('#oxfSlot .oxf svg', { timeout: 15000 }).catch(async e => {
    console.log('DEBUG', await p.evaluate(() => ({ live: JSON.stringify(LIVE).slice(0, 300), d: (document.getElementById('gcDetail') || {}).innerHTML ? document.getElementById('gcDetail').innerHTML.slice(0, 600) : 'no gcDetail', open: OPEN_GAME, tab: currentTab, err: (() => { try { const g = live(game(OPEN_GAME)); const h = gcDetail(GC_CACHE[OPEN_GAME], g); document.getElementById('gcDetail').innerHTML = h; OnyxField.attach(GC_CACHE[OPEN_GAME], g); return 'none'; } catch (e) { return String(e.stack); } })() })));
    throw e;
  });
  await p.waitForFunction(() => OnyxField.plays().length > 5, null, { timeout: 15000 }).catch(async e => {
    console.log('DEBUG plays', await p.evaluate(() => { const s = GC_CACHE[OPEN_GAME]; const all = [].concat(...s.drives.previous.map(d => d.plays)); return { n: OnyxField.plays().length, cls: all.map(x => { try { return JSON.stringify(OnyxField._classify(x) && OnyxField._classify(x).kind); } catch (er) { return String(er); } }) }; }));
    throw e;
  });
}
const S = (p, gid) => p.evaluate(g => OnyxField.state(g), gid);
async function shot(p, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const el = await p.$('#oxfSlot');
  if (el) await el.screenshot({ path: path.join(SHOTS, 'field-' + name.replace(/\s+/g, '-') + '.png') }).catch(() => {});
}
// replay one play: the ball moves during it and stops on the end spot
async function checkPlay(p, gid, play, label, frames) {
  const before = await p.evaluate(() => Date.now());
  await p.evaluate(([g, id]) => OnyxField.replay(g, id), [gid, play.id]);
  const seen = new Set();
  const t0 = Date.now();
  let shotN = 0;
  while (Date.now() - t0 < 6000) {
    const s = await S(p, gid);
    if (s.play === play.id && s.playing) seen.add(s.ballTransform);
    if (frames && shotN < frames.length && Date.now() - t0 >= frames[shotN]) { await shot(p, label + '-' + (shotN + 1)); shotN++; }
    if (s.done === play.id && !s.playing && (await p.evaluate(() => Date.now())) > before && seen.size > 2) {
      const dx = Math.abs(s.ballX - play.expect);
      ok(dx <= 1, `${label}: ends on the end spot (ball ${s.ballX.toFixed(1)} vs ESPN ${play.expect}, ${s.kind})`);
      ok(seen.size > 4, `${label}: the ball moves through the play (${seen.size} positions)`);
      return s;
    }
    await p.waitForTimeout(40);
  }
  ok(false, `${label}: animation never finished (${seen.size} positions seen)`);
  return null;
}

(async () => {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  const start = new Date(Date.now() - 3600e3).toISOString();

  // ── NFL ──
  const sd = sdOf('nfl.html'), g0 = (sd.games || [])[0];
  if (!g0) { console.log('nfl.html has no games: nothing to test'); process.exit(1); }
  const G = game(g0, ['9001', '9002'], false);
  const saved = [{ id: 'test:pit', sport: 'nfl', kind: 'prop', mkt: 'rec_yds', side: 'over', line: 92.5, name: 'Michael Pittman Jr.', team: g0.away, gid: g0.gid,
    label: 'Michael Pittman Jr. Over 92.5 receiving yards', matchup: `${g0.away} @ ${g0.home}`, start, conf: 0.55, price: -115, saved: start }];
  for (const w of [390, 1280]) {
    console.log(`\nnfl.html @ ${w}`);
    const { ctx, p, errs, st } = await openPage(browser, 'nfl.html', w, { base, G, saved });
    await openField(p, g0.gid);
    const dom = await p.evaluate(() => {
      const f = document.querySelector('#oxfSlot .oxf');
      return { svg: f.querySelectorAll('svg').length, dots: f.querySelectorAll('svg circle[stroke="#fff"]').length, ball: !!f.querySelector('.oxf-ball'),
        note: (f.querySelector('.oxf-note') || {}).textContent || '', list: f.querySelectorAll('.oxf-pl[data-pid]').length, drive: f.querySelectorAll('.oxf-dr').length,
        sw: document.scrollingElement.scrollWidth, iw: innerWidth, text: document.body.innerText,
        fieldW: f.querySelector('.oxf-stage').getBoundingClientRect().width };
    });
    ok(dom.svg === 1 && dom.dots === 22 && dom.ball, `field: one svg, 22 players, the ball (${dom.svg} svg, ${dom.dots} dots)`);
    ok(/Play reconstruction from the play-by-play/.test(dom.note), 'labelled "Play reconstruction from the play-by-play"');
    ok(dom.list >= 10 && dom.drive >= 1, `play list (${dom.list} replay buttons) and drive chart (${dom.drive} bars)`);
    ok(dom.sw <= dom.iw, `no sideways scroll (${dom.sw} <= ${dom.iw})`);
    ok(!/—/.test(dom.text), 'no em dash on the page');
    ok(dom.fieldW > 300, `field is ${Math.round(dom.fieldW)} px wide`);
    // the first look runs the latest play by itself
    await p.waitForFunction(() => OnyxField.state().done, null, { timeout: 8000 }).catch(() => {});
    await shot(p, `nfl-${w}-open`);
    const order = ['passTD', 'run', 'sack', 'punt', 'fg', 'int', 'penalty', 'kickoff', 'inc', 'passShort', 'scramble'];
    for (const k of order) {
      const frames = w === 390 && ['passTD', 'punt', 'fg', 'int', 'run', 'sack', 'penalty'].includes(k) ? [600, 1300, 2000] : w === 1280 && k === 'passTD' ? [900, 1700] : null;
      await checkPlay(p, g0.gid, G.by[k], `${w} ${k}`, frames ? frames.map(x => x) : null);
      if (k === 'passTD') {
        const mine = await p.evaluate(() => { const m = document.querySelector('#oxfSlot .oxf-mine'); return { on: m && m.classList.contains('on'), t: m ? m.textContent : '',
          ring: [...document.querySelectorAll('#oxfSlot svg circle[stroke="#b038f9"]')].some(c => c.style.display !== 'none') }; });
        ok(mine.on && /Pittman 88 \/ 92\.5 rec yds/.test(mine.t), `saved pick in the play: "${mine.t.trim()}"`);
        ok(mine.ring, 'the saved player is ringed on the field');
        const head = await p.evaluate(() => document.querySelector('#oxfSlot .oxf-cap b').textContent);
        ok(/Jones to Pittman, 76 yds, TOUCHDOWN/.test(head), `caption names the players: "${head}"`);
        await shot(p, `nfl-${w}-td-end`);
      }
    }
    // the play list replays a tapped play
    await p.evaluate(id => { const b = document.querySelector(`#oxfSlot .oxf-pl[data-pid="${id}"]`); b.scrollIntoView({ block: 'center' }); }, G.by.run2.id);
    await p.click(`#oxfSlot .oxf-pl[data-pid="${G.by.run2.id}"]`);
    await p.waitForTimeout(250);
    let s = await S(p, g0.gid);
    ok(s.play === G.by.run2.id && s.playing, `tapping a play in the list replays it (${s.play}, playing ${s.playing})`);
    await p.waitForFunction(id => OnyxField.state().done === id, G.by.run2.id, { timeout: 6000 }).catch(() => {});
    // the drive chart replays too
    const dr = await p.$(`#oxfSlot .oxf-dr[data-pid]`);
    if (dr) { const id = await dr.getAttribute('data-pid'); await dr.click(); await p.waitForTimeout(200); s = await S(p, g0.gid); ok(s.play === id, 'tapping a drive chart bar replays that play'); }
    await p.waitForFunction(() => !OnyxField.state().playing, null, { timeout: 6000 }).catch(() => {});
    await p.waitForTimeout(2600);
    // Follow: the next summary refresh brings a new play, it plays on its own
    st.withNext = true;
    await p.evaluate(gid => loadSummary(gid), g0.gid);
    await p.waitForFunction(id => OnyxField.state().play === id, G.next.id, { timeout: 8000 }).catch(() => {});
    s = await S(p, g0.gid);
    ok(s.play === G.next.id, `Follow plays the new play as it arrives (${s.play})`);
    await p.waitForFunction(id => OnyxField.state().done === id, G.next.id, { timeout: 6000 }).catch(() => {});
    s = await S(p, g0.gid);
    ok(Math.abs(s.ballX - G.next.expect) <= 1, `Follow play ends on its spot (${s.ballX.toFixed(1)} vs ${G.next.expect})`);
    await p.waitForTimeout(2500);
    await shot(p, `nfl-${w}-next-snap`);
    const sw2 = await p.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
    ok(sw2 <= 0, 'still no sideways scroll after the plays');
    ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    if (w === 390 && SHOTS) await p.screenshot({ path: path.join(SHOTS, 'field-nfl-390-page.png'), fullPage: false });
    await ctx.close();
  }

  // ── reduced motion ──
  {
    console.log('\nnfl.html @ 390, prefers-reduced-motion');
    const { ctx, p, errs } = await openPage(browser, 'nfl.html', 390, { base, G, saved, reduced: true });
    await openField(p, g0.gid);
    for (const k of ['passTD', 'punt', 'int']) {
      await p.evaluate(([g, id]) => OnyxField.replay(g, id), [g0.gid, G.by[k].id]);
      const s = await S(p, g0.gid);
      ok(!s.playing && s.done === G.by[k].id && Math.abs(s.ballX - G.by[k].expect) <= 1, `reduced motion: ${k} jumps to its end state (${s.ballX.toFixed(1)} vs ${G.by[k].expect})`);
    }
    await shot(p, 'nfl-390-reduced');
    ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ── college football ──
  {
    const sdc = sdOf('cfb.html'), c0 = (sdc.games || [])[0];
    if (!c0) ok(false, 'cfb.html has no games');
    else {
      for (const w of [390, 1280]) {
        console.log(`\ncfb.html @ ${w}`);
        const GC = game(c0, ['7001', '7002'], true);
        const { ctx, p, errs } = await openPage(browser, 'cfb.html', w, { base, G: GC });
        await openField(p, c0.gid);
        for (const k of ['passTD', 'run', 'int', 'punt']) await checkPlay(p, c0.gid, GC.by[k], `cfb ${w} ${k}`, w === 390 && k === 'passTD' ? [800, 1600] : null);
        const head = await p.evaluate(() => document.querySelector('#oxfSlot .oxf-cap b').textContent);
        ok(/Avant up the middle/.test(head) || /Moore|Mateer|punts/.test(head), `college caption reads the play text: "${head}"`);
        const sw = await p.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
        ok(sw <= 0, 'no sideways scroll');
        ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
        await shot(p, `cfb-${w}`);
        await ctx.close();
      }
    }
  }

  // ── NHL: the rink stays the rink ──
  {
    console.log('\nnhl.html @ 390');
    const { ctx, p, errs } = await openPage(browser, 'nhl.html', 390, { base });
    await p.waitForFunction(() => typeof gotoTab === 'function');
    await p.evaluate(() => gotoTab('games'));
    await p.waitForTimeout(500);
    const r = await p.evaluate(() => ({ rink: typeof rinkSvg === 'function', field: !!document.querySelector('.oxf'), kind: KIND }));
    ok(r.rink && !r.field && r.kind === 'hockey', 'nhl.html: rink code present, no football field');
    ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(fails.length ? `\nverify_field: ${fails.length} FAILED` : '\nverify_field: all checks passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
