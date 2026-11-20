// verify_replay.js - Sim Replay gate (studio.html?sport=nba#replay, sim-replay.js + studio-replay.js, 11/20).
// 1. The engine, for several real NBA games on the committed board and one faked game (renamed teams and players,
//    injected here, never written to data/): for each scenario the chosen sim's play-by-play must reproduce that sim's
//    final score and overtime, and every player's PTS / REB / AST / 3PM exactly as Play It Out drew them, and the box
//    the replay shows must re-add from the events alone (PTS FG 3PT FT OREB DREB REB AST STL BLK TO PF, and MIN from
//    the substitutions, recomputed independently here). Clocks never run backward, five a side at all times, nobody
//    plays with six fouls or past 48 minutes (plus overtime), the shot clock never runs out unannounced, win
//    probability stays in [0, 1] and ends at 0 or 1, and the same game rebuilt is identical (seeded).
// 2. The page at 390 and 1280: the tab renders and plays, the scrubber moves the game, a scenario switch lays out a
//    different game, the final overlay lists the plays the sim likes with valid Onyx links (selection + KR680261),
//    the share sheet opens, a video export produces a non-empty file (MediaRecorder in Chromium), no page errors,
//    no sideways scroll, no em dash and no other book named.
//   node tools/verify_replay.js [--games=N] [--shots=DIR]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2), opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const NG = +(opt('games') || 4), SHOTS = opt('shots');
const FAKE = 'FAKE0001';

// the faked game: a real game's board rows, teams and players renamed (only inside this gate)
function fake(board, slate, depth) {
  const g = (slate.games || []).find(x => (board.plays || []).some(p => p.gid === x.gid));
  if (!g) return;
  const map = {[g.away]: 'AAA', [g.home]: 'BBB'}, nm = n => 'Test ' + n;
  const rows = board.plays.filter(p => p.gid === g.gid).map(p => {
    const r = JSON.parse(JSON.stringify(p));
    r.gid = FAKE; r.matchup = 'AAA @ BBB'; r.start = new Date(Date.now() + 6 * 3600e3).toISOString();
    if (map[r.team]) r.team = map[r.team];
    if (r.kind === 'prop' && r.name) { r.label = r.label.replace(r.name, nm(r.name)); r.name = nm(r.name); r.who = 'T' + r.who; r.sel = r.sel ? 'fake-' + r.sel : r.sel; }
    else { if (map[r.name]) r.name = map[r.name]; if (map[r.who]) r.who = map[r.who]; r.label = r.label.replace(g.away, 'AAA').replace(g.home, 'BBB'); r.sel = r.sel ? 'fake-' + r.sel : r.sel; }
    if (r.why) r.why = r.why.replace(new RegExp('\\b' + g.away + '\\b'), 'AAA').replace(new RegExp('\\b' + g.home + '\\b'), 'BBB');
    return r;
  });
  board.plays = board.plays.concat(rows);
  slate.games = slate.games.concat([Object.assign({}, g, {gid: FAKE, away: 'AAA', home: 'BBB', state: 'pre', start: rows[0].start})]);
  [g.away, g.home].forEach(t => {
    const tm = depth.teams[t]; if (!tm) return;
    depth.teams[map[t]] = Object.assign({}, tm, {players: tm.players.map(p => Object.assign({}, p, {n: nm(p.n), id: 'T' + p.id, hs: null, gid: FAKE}))});
  });
}

const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]), p = path.join(root, u);
  fs.readFile(p, (e, b) => {
    if (e) { r.statusCode = 404; return r.end(); }
    if (/data\/nba\/(board|slate|depth)\.json$/.test(u)) {
      const read = f => JSON.parse(fs.readFileSync(path.join(root, 'data/nba', f)));
      const bd = read('board.json'), sl = read('slate.json'), dp = read('depth.json'); fake(bd, sl, dp);
      r.setHeader('content-type', 'application/json');
      return r.end(JSON.stringify(/board/.test(u) ? bd : /slate/.test(u) ? sl : dp));
    }
    if (p.endsWith('.js')) r.setHeader('content-type', 'text/javascript');
    r.end(b);
  });
}).listen(0);

(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch(), out = [];
  const page = async (w) => {
    const pg = await b.newPage({viewport: {width: w, height: w < 600 ? 860 : 900}}), errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console: ' + m.text()); });
    await pg.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith(base + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'}); return u.startsWith(base) ? rt.continue() : rt.abort(); });
    return {pg, errs};
  };

  // ── 1. the engine ──
  {
    const {pg, errs} = await page(1280);
    await pg.goto(base + '/studio.html?sport=nba#compare', {waitUntil: 'domcontentloaded'});
    await pg.waitForFunction(() => window.Studio && Studio.simEngine && window.SimReplay, null, {timeout: 20000});
    const res = await pg.evaluate(async ({NG, FAKE}) => {
      const D = await Studio.load(), E = Studio.simEngine, u = Studio.u, X = await E.extras(D);
      const depth = await fetch(D.dir + 'depth.json').then(r => r.json());
      let games = D.games.filter(g => D.playsFor(g.gid).length && g.state !== 'post' && g.gid !== FAKE).slice(0, NG);
      const fk = D.game(FAKE); if (fk) games = games.concat([fk]);
      const lines = [];
      // minutes from the substitutions alone (independent of SimReplay.boxAt)
      function minutes(game) {
        const on = {A: [], H: []}, sec = {}; let last = 0;
        game.events.forEach(e => {
          const dt = e.t - last; if (dt > 0) ['A', 'H'].forEach(s => on[s].forEach(id => { sec[id] = (sec[id] || 0) + dt; }));
          last = Math.max(last, e.t);
          if (e.type === 'five') on[e.team] = e.five.slice();
          if (e.type === 'sub') on[e.team] = on[e.team].filter(x => x !== e.pout).concat([e.pin]);
        });
        return sec;
      }
      for (const g of games) {
        const G = E.prep(D, g.gid, u, X), sim = E.run(G, E.freshK(), E.seed(g.gid)); sim.step(E.N); const RES = sim.done();
        const ctx = SimReplay.context(G, RES, depth.teams, {sport: 'nba', mlChance: E.mlChance, BMK: E.BMK});
        if (!ctx || ctx.err) { lines.push(['FAIL', g.away + '@' + g.home, 'context: ' + (ctx && ctx.err)]); continue; }
        const sc = SimReplay.scenarios(ctx, []);
        for (const s of sc) {
          const t0 = performance.now(), gm = SimReplay.pick(ctx, s), ms = Math.round(performance.now() - t0);
          if (!gm) { lines.push([s.key === 'likely' ? 'FAIL' : 'warn', g.away + '@' + g.home, s.key + ': no game laid out from ' + s.list.length]); continue; }
          const bad = SimReplay.verify(gm, ctx);
          const fb = SimReplay.boxAt(gm), mn = minutes(gm);
          Object.keys(gm.byId).forEach(id => { const m = Math.round((mn[id] || 0) / 60); if (m !== fb.B[id].min) bad.push(gm.byId[id].name + ' MIN ' + fb.B[id].min + ' vs subs ' + m); });
          // the board players' sim draws, checked once more straight from Play It Out's arrays
          const Dr = RES.draws; let drawn = 0;
          // (a player's main line in each market: an alternate line is its own draw, graded by its own hit rate)
          (G.cont || []).forEach(c => { if (!c.pl || ['pts', 'reb', 'ast', 'threes'].indexOf(c.row.mkt) < 0) return; const y = Dr.ys[c.row.sel || c.row.label]; if (!y) return;
            const key = c.row.mkt === 'threes' ? 'tpm' : c.row.mkt; if ((ctx.fixRow || {})[c.pl.k + '|' + key] !== c.row) return;
            const p = SimReplay.playerOf(gm, {name: c.pl.name}); if (!p) { bad.push('board player missing: ' + c.pl.name); return; }
            const v = {pts: fb.B[p.id].pts, reb: fb.B[p.id].reb, ast: fb.B[p.id].ast, threes: fb.B[p.id].tpm}[c.row.mkt]; drawn++;
            if (v !== y[gm.k]) bad.push(c.pl.name + ' ' + c.row.mkt + ' ' + v + ' vs sim ' + y[gm.k]); });
          if (fb.score.A !== Dr.sa[gm.k] || fb.score.H !== Dr.sh[gm.k]) bad.push('final ' + fb.score.A + '-' + fb.score.H + ' vs sim ' + Dr.sa[gm.k] + '-' + Dr.sh[gm.k]);
          if (s.key === 'ot' && !gm.nOT) bad.push('overtime scenario without overtime');
          if (s.key === 'upset' && (Dr.sa[gm.k] > Dr.sh[gm.k]) !== (ctx.dist.muM < 0)) bad.push('upset scenario: the favorite won');
          // pace: possessions per team against the sim's possessions for that game
          const pa = gm.poss.filter(P => P.team === 'A').length, target = Dr.poss * Dr.fp[gm.k] * gm.len / (CF => CF.per.reduce((a, b) => a + b, 0))(SimReplay.cfg.nba);
          if (Math.abs(pa - target) > 9) bad.push('pace ' + pa + ' possessions vs the sim\'s ' + target.toFixed(1));
          // seeded: the same game twice is the same game
          const again = SimReplay.build(ctx, gm.k), sig = x => x.events.map(e => e.t + e.type + (e.p || '') + e.A + '-' + e.H).join('|');
          if (!again || sig(again) !== sig(gm)) bad.push('rebuilding the same sim gave a different game');
          lines.push([bad.length ? 'FAIL' : 'ok  ', g.away + '@' + g.home, s.key.padEnd(7) + ' sim #' + gm.k + ' ' + gm.score.A + '-' + gm.score.H + (gm.nOT ? ' OT' : '') + ' ' + gm.events.length + ' events, ' + drawn + ' prop draws matched, ' + ms + ' ms' + (bad.length ? ': ' + bad.slice(0, 4).join(' | ') : '')]);
        }
      }
      return lines;
    }, {NG, FAKE});
    res.forEach(l => out.push(l[0] + ' engine ' + l[1].padEnd(10) + ' ' + l[2]));
    if (!res.some(l => l[1].startsWith('AAA@'))) out.push('FAIL engine: the faked game never ran');
    if (errs.length) out.push('FAIL engine page errors: ' + errs.join(' | ').slice(0, 300));
    await pg.close();
  }

  // ── 2. the page ──
  // a saved pick on one real game (1280 run): the "Your bets hit" scenario must lay out a game where it cashes
  const bd = JSON.parse(fs.readFileSync(path.join(root, 'data/nba/board.json'))), sl = JSON.parse(fs.readFileSync(path.join(root, 'data/nba/slate.json')));
  const realG = (sl.games || []).filter(g => g.state !== 'post' && bd.plays.some(p => p.gid === g.gid && p.kind === 'prop' && p.sel && ['pts', 'reb', 'ast'].includes(p.mkt)))[0];
  const pick = realG && bd.plays.filter(p => p.gid === realG.gid && p.kind === 'prop' && p.sel && ['pts', 'reb', 'ast'].includes(p.mkt)).sort((a, b) => b.conf - a.conf)[0];
  for (const w of [390, 1280]) {
    const {pg, errs} = await page(w), tag = 'ui ' + w;
    const bad = [], withPick = w === 1280 && pick;
    if (withPick) await pg.addInitScript(p => { try { localStorage.setItem('onyxSaved', JSON.stringify([Object.assign({id: p.sel, saved: new Date().toISOString()}, p)])); } catch (e) {} }, pick);
    await pg.goto(base + '/studio.html?sport=nba#replay' + (withPick ? '?gid=' + realG.gid : ''), {waitUntil: 'domcontentloaded'});
    await pg.waitForFunction(() => window.Studio && Studio.replay && Studio.replay.game(), null, {timeout: 60000}).catch(() => bad.push('no game laid out in 60 s'));
    if (!bad.length) {
      await pg.waitForTimeout(1200);
      const s1 = await pg.evaluate(() => Studio.replay.state());
      if (!s1 || !s1.playing) bad.push('not playing on open');
      // the canvas has a court on it
      const ink = await pg.evaluate(() => { const c = document.getElementById('rpCv'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data; let n = 0, s = 0, s2 = 0; for (let i = 0; i < d.length; i += 40) { const v = d[i] + d[i + 1] + d[i + 2]; s += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s / n) * (s / n)); });
      if (!(ink > 6)) bad.push('court canvas looks blank (' + ink.toFixed(1) + ')');
      if (SHOTS) { await pg.evaluate(() => Studio.replay.pause()); await pg.evaluate(() => { const g = Studio.replay.game(); const c = g.events.find(e => e.call && e.call.pri >= 3 && e.per >= 1); Studio.replay.seek(c ? Studio.replay.realOf(c.i) + 0.5 : Studio.replay.state().total * 0.4); }); await pg.waitForTimeout(400); await pg.screenshot({path: path.join(SHOTS, `replay-${w}-play.png`), fullPage: false}); await pg.evaluate(() => Studio.replay.play()); }
      // scrub to the middle: the game moves
      const s2 = await pg.evaluate(() => { const st = Studio.replay.state(); Studio.replay.seek(st.total * 0.5); return Studio.replay.state(); });
      if (!(s2.idx > s1.idx && s2.T > 600)) bad.push('scrub did not move the game (' + s2.idx + ', T ' + Math.round(s2.T) + ')');
      const logN = await pg.evaluate(() => document.querySelectorAll('#rpLog .rp-ev').length);
      if (logN < 3) bad.push('play log empty after scrubbing');
      const boxOk = await pg.evaluate(() => { const t = document.querySelector('#rpBox .rp-bt'); return !!t && t.querySelectorAll('tr.on').length === 5; });
      if (!boxOk) bad.push('box score without five on the floor');
      // speeds and highlights
      const spd = await pg.evaluate(() => { Studio.replay.speed(60); const a = Studio.replay.state().total; Studio.replay.mode(true); const h = Studio.replay.state().total; Studio.replay.mode(false); Studio.replay.speed(16); return {a, h}; });
      if (!(spd.h > 45 && spd.h < 110)) bad.push('highlights run ' + spd.h.toFixed(0) + ' s (want about 75)');
      // a scenario switch lays out another game
      const k0 = await pg.evaluate(() => Studio.replay.game().k);
      const has = await pg.evaluate(() => Studio.replay.scenarios().map(s => s.key));
      const alt = has.indexOf('blowout') >= 0 ? 'blowout' : has.indexOf('upset') >= 0 ? 'upset' : null;
      if (alt) {
        await pg.evaluate(k => Studio.replay.scenario(k), alt);
        await pg.waitForFunction(k0 => Studio.replay.game() && Studio.replay.game().k !== k0, k0, {timeout: 30000}).catch(() => bad.push('scenario ' + alt + ' did not load'));
      }
      if (withPick) {
        const yb = await pg.evaluate(() => { const s = Studio.replay.scenarios().find(x => x.key === 'bets'); return {legs: Studio.replay.legs().length, n: s ? s.list.length : -1}; });
        if (yb.legs !== 1) bad.push('the saved pick was not picked up (' + yb.legs + ' legs)');
        else if (yb.n <= 0) bad.push('no "Your bets hit" game (' + yb.n + ')');
        else {
          const k1 = await pg.evaluate(() => Studio.replay.game().k);
          await pg.evaluate(() => Studio.replay.scenario('bets'));
          await pg.waitForFunction(k1 => Studio.replay.game() && Studio.replay.game().scenario === 'bets', k1, {timeout: 30000}).catch(() => bad.push('"Your bets hit" did not load'));
          const st2 = await pg.evaluate(() => { const g = Studio.replay.game(); Studio.replay.seek(1e9); return SimReplay.grade(Studio.replay.legs()[0], g, g.events.length - 1).state; });
          if (st2 !== 'hit') bad.push('"Your bets hit" game: the saved pick ' + st2);
          await pg.waitForTimeout(300);
          const shown = await pg.evaluate(() => (document.querySelector('#rpFin .rp-bets') || {}).innerText || '');
          if (!/Hit/.test(shown)) bad.push('final does not show the saved pick as hit');
          if (SHOTS) await pg.screenshot({path: path.join(SHOTS, `replay-${w}-yourbets.png`), fullPage: false});
          await pg.evaluate(() => { document.getElementById('rpFin').hidden = true; });
        }
      }
      const chk = await pg.evaluate(() => Studio.checks.replay());
      if (chk) bad.push('self-check: ' + chk);
      // the final
      await pg.evaluate(() => Studio.replay.seek(1e9));
      await pg.waitForTimeout(300);
      const fin = await pg.evaluate(() => {
        const f = document.getElementById('rpFin'), links = Array.from(f.querySelectorAll('.rp-likes a[href]')).map(a => a.href);
        return {open: !f.hidden, links, txt: f.innerText, adds: f.querySelectorAll('[data-rp-add]').length};
      });
      if (!fin.open) bad.push('final overlay did not open');
      if (!fin.links.length) bad.push('final: no plays the sim likes');
      fin.links.forEach(h => { if (!/^https:\/\/app\.onyxodds\.com\/share\?selection=[^&]+.*&referrer=KR680261$/.test(h)) bad.push('bad Onyx link ' + h); });
      if (!/Simulated game, 1 of 10,000 sims, not real highlights/i.test(fin.txt)) bad.push('final without the simulation label');
      if (/Onyx Pick(?!s? ?\b(?:are|is)?\s*not)/.test(fin.txt.replace(/not Onyx Picks/g, ''))) bad.push('final calls something an Onyx Pick');
      if (SHOTS) await pg.screenshot({path: path.join(SHOTS, `replay-${w}-final.png`), fullPage: false});
      // share
      await pg.evaluate(() => { document.getElementById('rpFin').hidden = true; document.querySelector('[data-rp-share]').click(); });
      await pg.waitForFunction(() => window.OnyxShare && OnyxShare.isOpen(), null, {timeout: 5000}).catch(() => bad.push('share sheet did not open'));
      await pg.waitForFunction(() => document.getElementById('oxShare') && document.getElementById('oxShare').getAttribute('data-ready'), null, {timeout: 8000}).catch(() => bad.push('share card never drew'));
      if (SHOTS) await pg.screenshot({path: path.join(SHOTS, `replay-${w}-share.png`), fullPage: false});
      await pg.evaluate(() => OnyxShare.close());
      // video: a short recording must produce a file
      const vid = await pg.evaluate(async () => { try { const bl = await Studio.replay.record('story', {maxSec: 1.6}); return {size: bl.size, type: bl.type}; } catch (e) { return {err: String(e && e.message || e)}; } });
      if (!(vid.size > 1000)) bad.push('video export failed: ' + JSON.stringify(vid));
      // the page itself
      const page2 = await pg.evaluate(() => ({side: document.documentElement.scrollWidth > innerWidth + 1, txt: document.body.innerText}));
      if (page2.side) bad.push('sideways scroll');
      if (/\u2014/.test(page2.txt)) bad.push('em dash on the page');
      if (/DraftKings|FanDuel|DGFantasy|Daily ?Grind|Pinnacle/i.test(page2.txt)) bad.push('another book or site named');
      if (SHOTS && w === 390) { await pg.evaluate(() => { Studio.replay.pause(); Studio.replay.seek(Studio.replay.state().total * 0.62); }); await pg.waitForTimeout(300); await pg.screenshot({path: path.join(SHOTS, `replay-${w}-full.png`), fullPage: true}); }
      out.push((bad.length || errs.length ? 'FAIL ' : 'ok   ') + tag + ' ' + (bad.concat(errs.map(e => 'error: ' + e)).join('; ').slice(0, 600) || 'plays, scrubs, switches scenario (' + alt + '), final with ' + fin.links.length + ' Onyx links, share, video ' + vid.size + ' B ' + vid.type));
    } else out.push('FAIL ' + tag + ' ' + bad.join('; ') + (errs.length ? ' errors: ' + errs.join(' | ').slice(0, 300) : ''));
    await pg.close();
  }
  console.log(out.join('\n')); await b.close(); srv.close();
  if (out.some(x => x.startsWith('FAIL'))) { console.error('FAIL: replay'); process.exit(1); }
  console.log('PASS');
})();
