#!/usr/bin/env node
/**
 * verify_sports.js - the gate for the sport pages built from sport_shell.html
 * (nfl, cfb, cbb, nhl, tennis, golf). Dev + CI only.
 *
 * Every page, every tab (home, games, board, plays, model; depth on team sports) at 390px and
 * 1280px: renders, no uncaught errors, no "undefined" / "NaN" /
 * "[object Object]", nothing wider than the screen. For football, hockey and
 * basketball it opens a game's gamecenter too; basketball also renders a
 * finished game's box score from tools/fixtures/cbb_summary.json (a real
 * ESPN summary, trimmed) in both the Live and Box score views. Off-origin requests (ESPN live polling)
 * are aborted, so this checks the built page, not today's feed.
 * Depth (11/2): for every sport whose data/<sport>/depth.json exists, the Depth tab
 * loads it, shows a team's chart in all three views (projected, this season, last
 * season) and a second team, with the usage column and the method note, nothing
 * wider than the screen (tables scroll inside their card), and a Depth tile in the
 * menu drawer that opens it.
 *
 * Cards (11/2): where data/<sport>/cards.json exists, a team card (tapped from a game card's
 * team name, so the tap must open the team and not the gamecenter) and a player card (the
 * player with the most Onyx markets) open, load their data, show "Why this number", their
 * tables and both faces (Team | Bets, Player | Bets, the line chart scrubbed and snapped back),
 * with no undefined / NaN, nothing wider than the screen and no page errors.
 * Bets tabs (11/2): ranked best value first, every row badged Onyx Pick or Projection, an honest
 * "Best bet" (never a negative play), and a player prop row's full bet card: the slider moves the
 * line and the numbers off Onyx's line, release snaps back, Over / Under switches, Bet on Onyx
 * carries the share link with KR680261 (BETS_CHECK).
 *
 *   python3 -B sports_build.py nfl   (and the others)
 *   node tools/verify_sports.js [nfl,cfb,cbb,nhl,tennis,golf]
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
const PORT = Number(process.env.PROBE_PORT || 8913);
const ROOT = process.cwd();
const PAGES = (process.argv[2] || 'nfl,cfb,cbb,nhl,tennis,golf').split(',');
const BB_FIX = path.join(__dirname, 'fixtures', 'cbb_summary.json');
const TABS = ['home', 'games', 'board', 'plays', 'model'];

const KIND_OF = { nfl: 'football', cfb: 'football', cbb: 'basketball', nhl: 'hockey', tennis: 'tennis', golf: 'golf' };
// the team on the slate with the most to show, and the player with the most Onyx markets
function cardPick(pg, idx) {
  const out = { team: null, player: null };
  if (pg === 'tennis') {
    let best = null;
    Object.values(idx.players || {}).forEach(p => { if (!best || (p.mk || []).length > (best.mk || []).length) best = p; });
    if (best) out.player = { n: best.n };
    return out;
  }
  let bt = null, bp = null;
  for (const t of idx.teams || []) {
    const f = path.join(ROOT, 'data', pg, 'cards', String(t).replace(/[^A-Za-z0-9]/g, '_') + '.json');
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const sides = ((d.team || {}).game || {}).sides || [];
    // the Bets tab with the most to rank: its game lines plus every prop on its players
    const nb = sides.length ? sides.length + Object.values(d.players || {}).reduce((a, p) => a + (p.mk || []).length, 0) : 0;
    if (nb && (!bt || nb > bt[1])) bt = [t, nb];
    Object.values(d.players || {}).forEach(p => { const n = (p.mk || []).length + ((p.mk || []).some(m => m.dist) ? 5 : 0); if (!bp || n > bp[1]) bp = [{ n: p.n, t: p.team }, n]; });
  }
  out.team = bt ? bt[0] : (idx.teams || [])[0] || null;
  out.player = bp ? bp[0] : null;
  return out;
}
// the open card: loaded, its sections present, no undefined / NaN, nothing wider than the screen
async function cardCheck(page, face, need) {
  await page.waitForFunction(() => { const c = window.OXC && OXC._state(); return !!document.querySelector('#cx.open .pc-seg') || (c && !c.data && /No card/.test((document.getElementById('cxFace') || {}).innerText || '')); }, null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(120);
  return page.evaluate(need => {
    const el = document.getElementById('cx'), W = document.documentElement.clientWidth;
    if (!el || !el.classList.contains('open')) return 'card did not open';
    const txt = el.innerText, bad = [];
    if (/No card/.test(txt)) return 'no card data';
    if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(txt)) bad.push('undefined/NaN');
    need.forEach(s => { if (txt.toLowerCase().indexOf(s.toLowerCase()) < 0) bad.push('no "' + s + '"'); });
    // the card's face clips sideways, so measure against the face: anything past its edge that is
    // not inside its own scroller (a table, the market chips) is cut off on screen
    const face = document.getElementById('cxFace'), R = Math.min(W, face.getBoundingClientRect().right), wide = [];
    face.querySelectorAll('*').forEach(e => {
      const b = e.getBoundingClientRect();
      if (!b.width || b.right <= R + 1 || getComputedStyle(e).position === 'absolute' && e.closest('.pc-logo')) return;
      let a = e.parentElement;
      while (a && a !== face) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
      wide.push(String(e.className || e.tagName));
    });
    if (wide.length) bad.push('wide: ' + wide.slice(0, 3).join(', '));
    if (document.documentElement.scrollWidth > W + 1) bad.push('page scrolls sideways');
    if (/[\u2014]/.test(txt)) bad.push('em dash in copy');
    return bad.join(', ');
  }, need);
}

// the open card's Bets tab (cards.js, 11/2): ranked best value first, an Onyx Pick / Projection
// badge on every row, an honest "Best bet", and a row's full bet card: chart, slider (the numbers
// move between lines, release snaps to Onyx's line), Over / Under, Add to parlay, Bet on Onyx
const BETS_CHECK = async (wantPlayer) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const face = document.getElementById('cxFace'), bad = [], $ = id => document.getElementById(id);
  const R = OXC._rows();
  if (!R.length) return 'no rows';
  if (!face.querySelector('.bc-best')) bad.push('no Best bet summary');
  if (face.querySelectorAll('.cx-bdg').length < Math.min(R.length, 25)) bad.push('rows without an Onyx Pick / Projection badge');
  for (let i = 1; i < R.length; i++) {
    const a = R[i - 1], b = R[i];
    if (b.rank < a.rank || (b.rank === a.rank && a.rank <= 2 && a.ev != null && b.ev != null && b.ev > a.ev + 1e-9)) { bad.push('not best value first at ' + b.lab); break; }
  }
  const bv = face.querySelector('.bc-best .bv');
  if (bv && /-\$/.test(bv.innerText)) bad.push('a negative play headlined as the best bet');
  const r = R.find(x => x.player === wantPlayer && x.dist && !x.nba) || R.find(x => x.dist && !x.nba);
  if (!r) return bad.join(', ') || 'ok (no charted row)';
  let btn = () => face.querySelector('.cx-bbr[data-k="' + CSS.escape(r.key) + '"]');
  if (!btn() && face.querySelector('[data-cx="more"]')) { face.querySelector('[data-cx="more"]').click(); await sleep(60); }
  if (!btn()) return 'row ' + r.lab + ' not listed';
  if (!btn().closest('.cx-bb').classList.contains('open')) { btn().click(); await sleep(150); }
  const rg = $('cxRange');
  if (!rg || !$('cxDist') || !btn().closest('.cx-bb').contains(rg)) return 'row ' + r.lab + ' opened without its chart and slider';
  const s0 = $('cxStats').innerText, b0 = $('cxBig').innerText;
  if (!/Onyx/i.test($('cxPrice').innerText)) bad.push('bet card not on an Onyx line');
  rg.value = +rg.min === +rg.value ? rg.max : rg.min; rg.dispatchEvent(new Event('input', {bubbles: true}));
  if ($('cxRange') !== rg) bad.push('slider rebuilt mid-drag');
  if ($('cxBig').innerText === b0) bad.push('slider did not move the line');
  if ($('cxStats').innerText === s0) bad.push('numbers did not update off the line');
  if (!/not offered/i.test($('cxPrice').innerText)) bad.push('between lines but shows a price');
  const th = face.querySelector('.cx-thumb'), mk = face.querySelector('.cx-mark');
  if (th && mk) { const a = th.getBoundingClientRect(), m = mk.getBoundingClientRect(), gap = Math.abs(a.left + a.width / 2 - (m.left + m.width / 2)); if (gap > 3) bad.push('slider thumb ' + gap.toFixed(0) + 'px from the chart line'); }
  if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(face.innerText)) bad.push('undefined/NaN while scrubbing');
  rg.dispatchEvent(new Event('change', {bubbles: true}));
  await sleep(40);
  if (!/Onyx/i.test($('cxPrice').innerText) || $('cxBig').innerText !== b0) bad.push('release did not snap back to the Onyx line');
  const other = [...face.querySelectorAll('#cxSide button')].find(b => !b.classList.contains('on'));
  if (other && $('cxSide').style.display !== 'none') { other.click(); await sleep(20); if ($('cxBig').innerText === b0 && !/Yes|No/.test(other.innerText)) bad.push('Over / Under did not switch'); }
  if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(face.innerText)) bad.push('undefined/NaN in the bet card');
  const bet = $('cxBet');
  if (!bet || !$('cxAdd')) bad.push('no Add to parlay / Bet on Onyx');
  else if (!bet.disabled) { const o = window.open; let u = ''; window.open = x => { u = x; return null; }; bet.click(); window.open = o; if (!/app\.onyxodds\.com\/share\?selection=.+referrer=KR680261/.test(u)) bad.push('Bet on Onyx link: ' + u); }
  return bad.join(', ') || 'ok (' + R.length + ' rows, opened ' + r.lab + ')';
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css'
        : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ['--no-sandbox'] });
  let failures = 0;
  for (const pg of PAGES) {
    if (!fs.existsSync(path.join(ROOT, pg + '.html'))) { console.log(`  FAIL ${pg}.html missing`); failures++; continue; }
    for (const [w, h, mob] of [[390, 844, true], [1280, 900, false]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.route('**/*', r => {
        const u = r.request().url();
        return (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) ? r.continue() : r.abort();
      });
      await page.goto(`http://127.0.0.1:${PORT}/${pg}.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const out = [];
      for (const t of TABS) {
        await page.evaluate(t => gotoTab(t), t);
        await page.waitForTimeout(250);
        const r = await page.evaluate(() => {
          const W = document.documentElement.clientWidth, pane = document.querySelector('.pane.active');
          const txt = pane ? pane.innerText : '';
          const wide = [];
          (pane ? pane.querySelectorAll('*') : []).forEach(e => {
            const b = e.getBoundingClientRect();
            if (!b.width || b.right <= W + 1) return;
            let a = e.parentElement;
            while (a && a !== document.body) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
            wide.push(String(e.className || e.tagName));
          });
          return { n: txt.length, bad: /\bundefined\b|\bNaN\b|\[object Object\]/.test(txt), wide: wide.slice(0, 3) };
        });
        const bad = [];
        if (r.n < 60) bad.push('empty pane');
        if (r.bad) bad.push('undefined/NaN in text');
        if (r.wide.length) bad.push('wider than the screen: ' + r.wide.join(', '));
        out.push(`${t}${bad.length ? ' FAIL(' + bad.join('; ') + ')' : ''}`);
        failures += bad.length;
      }
      // depth charts: data/<sport>/depth.json in the shared schema
      if (fs.existsSync(path.join(ROOT, 'data', pg, 'depth.json'))) {
        const dbad = [];
        const tile = await page.evaluate(() => !!document.querySelector('.osheet .otile[data-tab="depth"]'));
        if (!tile) dbad.push('no Depth tile in the menu');
        else {
          await page.evaluate(() => { window.OnyxUI.openMenu(); document.querySelector('.osheet .otile[data-tab="depth"]').click(); });
          await page.waitForTimeout(300);
          if (!(await page.evaluate(() => currentTab === 'depth' && !document.querySelector('.osheet').classList.contains('open')))) dbad.push('menu tile did not open Depth');
        }
        await page.evaluate(() => gotoTab('depth'));
        await page.waitForFunction(() => typeof DEPTH !== 'undefined' && (DEPTH || DEPTH_ERR === true), null, { timeout: 8000 }).catch(() => {});
        const r = await page.evaluate(() => {
          const res = [], W = document.documentElement.clientWidth;
          if (!DEPTH) return { err: 'depth.json did not load' };
          const teams = Object.keys(DEPTH.teams), check = [];
          for (const [t, v] of [[DEPTH_TEAM, 'proj'], [DEPTH_TEAM, 'now'], [DEPTH_TEAM, 'last'], [teams[teams.length - 1], 'proj']]) {
            DEPTH_TEAM = t; DEPTH_VIEW = v; renderDepth();
            const pane = document.getElementById('pane-depth'), txt = pane.innerText;
            const wide = [];
            pane.querySelectorAll('*').forEach(e => {
              const b = e.getBoundingClientRect();
              if (!b.width || b.right <= W + 1) return;
              let a = e.parentElement;
              while (a && a !== document.body) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
              wide.push(String(e.className || e.tagName));
            });
            const bad = [];
            if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(txt)) bad.push('undefined/NaN');
            if (wide.length) bad.push('wide: ' + wide.slice(0, 3).join(', '));
            if (document.documentElement.scrollWidth > W + 1) bad.push('page scrolls sideways');
            const nrow = pane.querySelectorAll('.dp-grp tbody tr').length;
            if (!nrow) bad.push('no players');
            if (!pane.querySelector('.dp-grp th.r')) bad.push('no usage column');
            if (!/How the depth chart works/i.test(txt) || !(DEPTH.method || '').length) bad.push('no method note');
            check.push(`${t}/${v} ${nrow}${bad.length ? ' FAIL(' + bad.join('; ') + ')' : ''}`);
          }
          DEPTH_VIEW = 'proj';
          return { teams: teams.length, check, bt: document.querySelectorAll('#pane-depth .dp-bt tbody tr').length };
        });
        if (r.err) dbad.push(r.err);
        else {
          if (!r.bt) dbad.push('no backtest rows');
          r.check.filter(c => c.includes('FAIL')).forEach(c => dbad.push(c));
        }
        out.push(`depth${dbad.length ? ' FAIL(' + dbad.join('; ') + ')' : ` ok(${r.teams} teams, ${r.check.map(c => c.split(' ')[1]).join('/')} rows)`}`);
        failures += dbad.length;
      }
      let gc = '';
      const team = await page.evaluate(() => (typeof KIND !== 'undefined') && (KIND === 'football' || KIND === 'hockey' || KIND === 'basketball') && (SD.games || []).length);
      if (team) {
        gc = await page.evaluate(() => { gotoTab('games'); openGame(SD.games[0].gid); return !!document.getElementById('gc') ? 'gamecenter ok' : 'gamecenter did not open'; });
        if (gc !== 'gamecenter ok') failures++;
      }
      if (team && await page.evaluate(() => KIND === 'basketball') && fs.existsSync(BB_FIX)) {
        // a finished game's gamecenter from a real ESPN summary: live view, then the box score with minutes
        const fix = JSON.parse(fs.readFileSync(BB_FIX, 'utf8'));
        const r = await page.evaluate(fix => {
          const g = SD.games[0], W = document.documentElement.clientWidth, res = [];
          LIVE[g.gid] = Object.assign({}, LIVE[g.gid] || {}, {state: 'post', detail: 'Final', away_score: '80', home_score: '75'});
          GC_CACHE[g.gid] = fix; OPEN_GAME = g.gid;
          for (const sub of ['live', 'box']) {
            GC_SUB = sub; drawGame(g.gid);
            const gc = document.getElementById('gc'), txt = gc ? gc.innerText : '';
            const wide = [];
            (gc ? gc.querySelectorAll('*') : []).forEach(e => {
              const b = e.getBoundingClientRect();
              if (!b.width || b.right <= W + 1) return;
              let a = e.parentElement;
              while (a && a !== document.body) { if (getComputedStyle(a).overflowX !== 'visible') return; a = a.parentElement; }
              wide.push(String(e.className || e.tagName));
            });
            const bad = [];
            if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(txt)) bad.push('undefined/NaN');
            if (wide.length) bad.push('wide: ' + wide.slice(0, 3).join(', '));
            if (sub === 'box' && !(/MIN/.test(txt) && /PTS/.test(txt) && /3PM/.test(txt) && /starters/i.test(txt) && /bench/i.test(txt))) bad.push('box columns missing');
            if (sub === 'live' && !/by half/i.test(txt)) bad.push('no score by half');
            res.push(sub + (bad.length ? ' FAIL(' + bad.join('; ') + ')' : ' ok'));
          }
          GC_SUB = 'live'; OPEN_GAME = null; delete LIVE[g.gid]; delete GC_CACHE[g.gid];
          return res.join(', ');
        }, fix);
        gc += ' · box ' + r;
        if (r.includes('FAIL')) failures++;
      }
      // team and player cards (cards.js + data/<sport>/cards.json)
      let cards = '';
      const cidx = path.join(ROOT, 'data', pg, 'cards.json');
      if (fs.existsSync(cidx)) {
        const pick = cardPick(pg, JSON.parse(fs.readFileSync(cidx, 'utf8')));
        const cbad = [];
        let teamBets = '';
        await page.evaluate(() => { if (window.OXC) OXC.close(); });
        if (pick.team) {
          // a real tap on a game card's team name: it must open the team card, not the gamecenter
          await page.evaluate(() => { gotoTab('games'); OPEN_GAME = null; renderGames(); });
          const tapped = await page.evaluate(t => { const el = document.querySelector(`#pane-games .gm [data-oxt="${t}"]`) || document.querySelector('#pane-games [data-oxt]'); if (!el) return null; el.click(); return el.getAttribute('data-oxt'); }, pick.team);
          if (!tapped) cbad.push('no tappable team name on the games tab');
          else {
            const r1 = await cardCheck(page, 'front', ['Why this number', 'Team history', 'Recent games']);
            if (r1) cbad.push('team ' + tapped + ': ' + r1);
            if (await page.evaluate(() => typeof OPEN_GAME !== 'undefined' && OPEN_GAME)) cbad.push('team tap also opened the gamecenter');
            const n = await page.evaluate(() => document.querySelectorAll('#cx .pc-seg button').length);
            if (n === 2) {
              await page.click('#cx .pc-seg button:nth-child(2)');
              // a team with no Onyx lines yet (e.g. NFL on a Tuesday, before next week's lines post) shows the
              // honest empty state; anything else must be the full ranked list with a Best bet
              const empty = await page.evaluate(() => { const f = document.getElementById('cxFace'); return !!(f && f.querySelector('.cx-empty')) && !(f && f.querySelector('.bc-row, .bc-best')); });
              if (empty) teamBets = 'no Onyx lines on this team yet';
              else {
                const r2 = await cardCheck(page, 'bets', ['Best bet']); if (r2) cbad.push('team bets: ' + r2);
                const r3 = await page.evaluate(BETS_CHECK, true);
                if (!r3.startsWith('ok')) cbad.push('team bets card: ' + r3); else teamBets = r3;
                const r4 = await cardCheck(page, 'bets', []); if (r4) cbad.push('team bet card open: ' + r4);
              }
            }
          }
          await page.evaluate(() => OXC.close());
        }
        if (pick.player) {
          await page.evaluate(p => OXC.player(p.n, p.t || null), pick.player);
          const r1 = await cardCheck(page, 'front', KIND_OF[pg] === 'tennis' ? ['Why this number'] : ['Why this number', 'Last']);
          if (r1) cbad.push('player ' + pick.player.n + ': ' + r1);
          if (await page.$('#cx .pc-seg button:nth-child(2)')) {
            await page.click('#cx .pc-seg button:nth-child(2)');
            const r2 = await cardCheck(page, 'bets', []);
            if (r2) cbad.push('player bets: ' + r2);
            const r3 = await page.evaluate(BETS_CHECK, false);
            if (!r3.startsWith('ok')) cbad.push('player bets card: ' + r3);
            const r4 = await cardCheck(page, 'bets', []); if (r4) cbad.push('player bet card open: ' + r4);
            const dist = await page.$('#cxDist');
            if (dist) {   // scrub the chart off Onyx's line, then let go: it must snap back to the line
              await dist.scrollIntoViewIfNeeded(); await page.waitForTimeout(60);   // the bet card opens inside its row, maybe below the fold
              const b = await dist.boundingBox();
              await page.mouse.move(b.x + b.width * 0.15, b.y + b.height / 2); await page.mouse.down();
              await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2, { steps: 3 });
              const mid = await page.evaluate(() => document.getElementById('cxPrice').innerText);
              await page.mouse.up(); await page.waitForTimeout(80);
              const end = await page.evaluate(() => document.getElementById('cxPrice').innerText);
              if (!/not offered/i.test(mid) && !/Onyx/i.test(mid)) cbad.push('chart scrub showed nothing');
              if (!/Onyx|no Onyx price/i.test(end)) cbad.push('did not snap back to the Onyx line');
            }
          }
          await page.evaluate(() => OXC.close());
        }
        cards = 'cards ' + (cbad.length ? 'FAIL(' + cbad.join('; ') + ')' : `ok(team ${pick.team || '-'}${teamBets ? ' bets ' + teamBets : ''}, player ${pick.player ? pick.player.n : '-'})`);
        failures += cbad.length;
      }
      failures += errs.length;
      console.log(`  ${errs.length || out.some(x => x.includes('FAIL')) || (gc && (!gc.startsWith('gamecenter ok') || gc.includes('FAIL'))) || cards.includes('FAIL') ? 'FAIL' : 'ok  '} ${pg.padEnd(7)} ${String(w).padEnd(5)} ${out.join(' ')}${gc ? ' · ' + gc : ''}${cards ? ' · ' + cards : ''}${errs.length ? '  <- ' + errs.join(' | ') : ''}`);
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nPASS');
  process.exit(failures ? 1 : 0);
})();
