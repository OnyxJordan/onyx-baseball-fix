// render_sim_video.js - dev only, never in the pipeline (11/20): renders a Sim Replay to a video file for Jordan's social
// posts, the same frames the in-browser "Download video" records (Onyx branding, the "Simulated game, 1 of 10,000
// sims, not real highlights" label, the CTA), but frame by frame, so it is smooth at any machine speed.
//   node tools/render_sim_video.js [--team=PHX | --gid=<id>] [--scenario=likely|upset|blowout|ot] [--layout=story|land|both]
//                                  [--out=DIR] [--fps=30] [--recorder] [--stills]
// Default: the next NBA game on the committed board, the most likely game, both layouts, into ./sim-video/.
// With ffmpeg on the PATH the frames become an H.264 MP4; --recorder uses the browser's MediaRecorder instead (WebM or
// MP4, real time). --stills also writes a few PNG frames. Headshots come from ESPN's CDN when the network allows.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2), opt = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; }, flag = k => args.includes('--' + k);
const OUT = path.resolve(opt('out', 'sim-video')), FPS = +opt('fps', 30), SCEN = opt('scenario', 'likely');
const LAYOUTS = opt('layout', 'both') === 'both' ? ['story', 'land'] : [opt('layout')];
fs.mkdirSync(OUT, {recursive: true});
const hasFF = (() => { try { cp.execFileSync('ffmpeg', ['-version'], {stdio: 'ignore'}); return true; } catch (e) { return false; } })();

const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } if (p.endsWith('.js')) r.setHeader('content-type', 'text/javascript'); r.end(b); }); }).listen(0);
(async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch();
  const pg = await b.newPage({viewport: {width: 1280, height: 900}});
  pg.on('pageerror', e => console.error('page error:', e.message));
  const cache = {};
  await pg.route('**/*', rt => {
    const u = rt.request().url();
    if (u.startsWith(base)) return rt.continue();
    // headshots: fetched here (curl honors the machine's proxy and CA) and served with CORS so the canvas stays clean
    if (/^https:\/\/a\.espncdn\.com\//.test(u)) {
      try { const body = cache[u] || (cache[u] = cp.execFileSync('curl', ['-sSf', '--max-time', '8', u])); return rt.fulfill({status: 200, contentType: 'image/png', headers: {'access-control-allow-origin': '*'}, body}); }
      catch (e) { return rt.abort(); }
    }
    return rt.abort();
  });
  let gid = opt('gid', null);
  if (!gid) {
    const board = JSON.parse(fs.readFileSync(path.join(root, 'data/nba/board.json'))), slate = JSON.parse(fs.readFileSync(path.join(root, 'data/nba/slate.json')));
    const team = opt('team', null), games = (slate.games || []).filter(g => board.plays.some(p => p.gid === g.gid) && g.state !== 'post');
    const g = team ? games.find(x => x.away === team || x.home === team) : games.sort((x, y) => Date.parse(x.start) - Date.parse(y.start))[0];
    if (!g) { console.error('no NBA game on the board' + (team ? ' for ' + team : '')); process.exit(1); }
    gid = g.gid;
  }
  await pg.goto(base + '/studio.html?sport=nba#replay?gid=' + encodeURIComponent(gid) + '&s=' + SCEN, {waitUntil: 'domcontentloaded'});
  await pg.waitForFunction(() => window.Studio && Studio.replay && Studio.replay.game(), null, {timeout: 120000});
  await pg.evaluate(() => Studio.replay.pause());
  await pg.waitForTimeout(2500);   // headshots
  const info = await pg.evaluate(() => { const g = Studio.replay.game(); return {a: g.A, h: g.H, sa: g.score.A, sh: g.score.H, k: g.k, ot: g.nOT, total: Studio.replay.hlTotal(), key: Studio.replay.state().key}; });
  console.log(`${info.a} @ ${info.h}: ${info.key} game (sim #${info.k}) ${info.sa}-${info.sh}${info.ot ? ' OT' : ''}, highlights ${info.total.toFixed(1)} s`);
  for (const lay of LAYOUTS) {
    const name = `onyx-sim-replay-${info.a}-${info.h}-${info.key}-${lay}`;
    if (flag('recorder') || !hasFF) {
      const b64 = await pg.evaluate(async lay => { const bl = await Studio.replay.record(lay); const buf = new Uint8Array(await bl.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return {type: bl.type, data: btoa(s)}; }, lay);
      const file = path.join(OUT, name + (/mp4/.test(b64.type) ? '.mp4' : '.webm'));
      fs.writeFileSync(file, Buffer.from(b64.data, 'base64')); console.log('wrote', file); continue;
    }
    const total = info.total + 4, n = Math.ceil(total * FPS), file = path.join(OUT, name + '.mp4');
    const ff = cp.spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], {stdio: ['pipe', 'inherit', 'inherit']});
    await pg.evaluate(() => { window.__rv = document.createElement('canvas'); });
    for (let i = 0; i < n; i++) {
      const url = await pg.evaluate(([lay, R]) => Studio.replay.frame(lay, R, window.__rv).toDataURL('image/jpeg', 0.9), [lay, i / FPS]);
      const buf = Buffer.from(url.split(',')[1], 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (flag('stills') && [0.1, 0.35, 0.6, 0.85].some(f => i === Math.floor(n * f))) fs.writeFileSync(path.join(OUT, name + '-' + String(i).padStart(5, '0') + '.jpg'), buf);
      if (i % (FPS * 10) === 0) process.stdout.write(`  ${lay} ${(i / FPS).toFixed(0)}s / ${total.toFixed(0)}s\r`);
    }
    if (flag('stills')) { const last = await pg.evaluate(([lay, R]) => Studio.replay.frame(lay, R, window.__rv).toDataURL('image/jpeg', 0.9), [lay, total - 0.5]); fs.writeFileSync(path.join(OUT, name + '-final.jpg'), Buffer.from(last.split(',')[1], 'base64')); }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
    console.log('wrote', file, (fs.statSync(file).size / 1e6).toFixed(1) + ' MB');
  }
  await b.close(); srv.close();
})();
