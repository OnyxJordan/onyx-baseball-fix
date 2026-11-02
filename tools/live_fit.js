// live_fit.js - fits live.js's in-game spreads to finished games (dev only).
// Reads the frozen moments tools/live_backtest.js --dump wrote, and for each sport tries a grid of
//   margin SD (how far the rest of the game can swing the score), total SD, and the most weight the
//   game's own scoring pace gets on the live total,
// scoring each on log loss over every moment where the Live tab shows bets (15%+ of the game left):
// the home side to win, to cover the pregame spread, to go over the pregame total, and to go over our
// own live total line. Prints the current settings' score next to the best.
//   node tools/live_fit.js <states.json>
const path = require('path'), fs = require('fs');
global.window = {}; global.fetch = () => Promise.reject(new Error('offline'));
require(path.join(__dirname, '..', 'live.js'));
const L = window.OnyxLive, ALLS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter(s => s.f >= 0.15);
// fit on half the games, test on the other half (split by game id), so a setting has to hold on games it never saw
const half = s => parseInt(String(s.gid).slice(-2), 10) % 2;
let S = ALLS;
const ll = (p, y) => { p = Math.min(0.999, Math.max(0.001, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
function score(sport) {
  let n = 0, w = 0, c = 0, o = 0, ol = 0, ov = 0;
  for (const s of S) {
    if (s.sport !== sport) continue;
    const sd = L.SD[sport];
    const pm = s.pre.home_line != null ? -s.pre.home_line : s.pre.home_win != null ? (s.pre.home_win - 0.5) * 2 * sd[0] * 0.8 : 0;
    const M = L.model(sport, { hs: s.hs, as: s.as, f: s.f, pre_margin: pm, pre_total: s.pre.total, pre_home_win: s.pre.home_win != null ? s.pre.home_win : 0.5 });
    const win = s.fh > s.fa ? 1 : 0, tot = s.fh + s.fa;
    n++; w += ll(M.win(), win);
    if (s.pre.home_line != null) { const m = s.fh - s.fa + s.pre.home_line; if (m) c += ll(M.cover(s.pre.home_line), m > 0); }
    if (tot !== s.pre.total) o += ll(M.over(s.pre.total), tot > s.pre.total);
    const tl = Math.floor(M.proj_total) + 0.5; ol += ll(M.over(tl), tot > tl); ov += tot > tl ? 1 : 0;
  }
  return { n, win: w / n, cover: c / n, over: o / n, over_live: ol / n, over_rate: ov / n, all: (w + c + o + ol) / n };
}
for (const sport of (process.argv[3] || 'nba,nfl').split(',')) {
  const base = L.SD[sport].slice(), pace0 = L.PACE[sport], cur = score(sport);
  let best = { all: 1e9 };
  S = ALLS.filter(s => half(s) === 0);
  for (const a of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7]) for (const t of [0.9, 1, 1.1, 1.2, 1.35, 1.5]) for (const p of [0, 0.2, 0.4, 0.6]) for (const k of [0.97, 1, 1.03, 1.06, 1.09, 1.12]) {
    L.SD[sport][0] = base[0] * a; L.SD[sport][1] = base[1] * t; L.PACE[sport] = p; L.TOTK[sport] = k;
    const r = score(sport);
    if (r.all < best.all) best = { ...r, sd: [+(base[0] * a).toFixed(2), +(base[1] * t).toFixed(2)], pace: p, k, a, t };
  }
  // the held-out half: current settings vs the fitted ones
  S = ALLS.filter(s => half(s) === 1);
  L.SD[sport][0] = base[0]; L.SD[sport][1] = base[1]; L.PACE[sport] = pace0; L.TOTK[sport] = 1;
  const holdNow = score(sport);
  L.SD[sport][0] = best.sd[0]; L.SD[sport][1] = best.sd[1]; L.PACE[sport] = best.pace; L.TOTK[sport] = best.k;
  const holdBest = score(sport);
  console.log(`  held-out half: now all ${holdNow.all.toFixed(4)} (over rate ${holdNow.over_rate.toFixed(3)})  fitted all ${holdBest.all.toFixed(4)} (over rate ${holdBest.over_rate.toFixed(3)}) win ${holdNow.win.toFixed(4)} -> ${holdBest.win.toFixed(4)}`);
  L.SD[sport][0] = base[0]; L.SD[sport][1] = base[1]; L.PACE[sport] = pace0; L.TOTK[sport] = 1; S = ALLS;
  const f = x => x.toFixed(4);
  console.log(`${sport.toUpperCase()} (${cur.n} moments with 15%+ left)`);
  console.log(`  now:  SD ${base} pace ${pace0}  log loss win ${f(cur.win)} cover ${f(cur.cover)} over ${f(cur.over)} live total ${f(cur.over_live)} (over rate ${cur.over_rate.toFixed(3)})  all ${f(cur.all)}`);
  console.log(`  best: SD ${best.sd} pace ${best.pace} points-to-come x${best.k}  log loss win ${f(best.win)} cover ${f(best.cover)} over ${f(best.over)} live total ${f(best.over_live)} (over rate ${best.over_rate.toFixed(3)})  all ${f(best.all)}`);
}
