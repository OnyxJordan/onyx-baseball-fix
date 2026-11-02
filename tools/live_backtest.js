// live_backtest.js - replays finished games through live.js and scores its live numbers (dev only).
//
// For each finished NBA / NFL / NHL game (ESPN scoreboards over a date range), takes the play-by-play
// and the pregame line (ESPN pickcenter: home spread, total, moneylines), freezes the game at up to
// --per (default 20) moments spread through it, and asks live.js for the home team's chance to win,
// to cover the pregame spread, and to go over the pregame total, plus our live total and margin.
// Then grades every frozen moment against how the game ended:
//   Brier score and calibration buckets (we said 70%: did it hit ~70%?) by stage of the game,
//   ESPN's own live win probability at the same play as a benchmark (NBA, NFL),
//   and the live total / margin as a 50-50 line (is our center right, is our spread right).
// The Live tab only calls something Value where this says the model is calibrated.
//
//   node tools/live_backtest.js [--sports=nba,nfl,nhl] [--from=2025-10-21] [--to=2026-11-01]
//                               [--games=400] [--per=20] [--out=path.json]
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
global.window = {}; global.fetch = () => Promise.reject(new Error('offline'));
require(path.join(__dirname, '..', 'live.js'));
const L = window.OnyxLive;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
const PATHS = { nba: 'basketball/nba', nfl: 'football/nfl', nhl: 'hockey/nhl', cfb: 'football/college-football' };
// regular-season windows per sport (last full season plus this one so far)
const WINDOWS = {
  nba: [['2025-10-21', '2026-04-12'], ['2026-10-20', '2026-11-01']],
  nfl: [['2025-09-04', '2026-01-04'], ['2026-09-09', '2026-11-01']],
  nhl: [['2025-10-07', '2026-04-16'], ['2026-10-06', '2026-11-01']],
  cfb: [['2025-08-30', '2025-12-06'], ['2026-08-29', '2026-11-01']],
};
const ALL = [];
const SPORTS = arg('sports', 'nba,nfl,nhl').split(','), GAMES = +arg('games', 400), PER = +arg('per', 20);

function curl(u) {
  return new Promise(res => execFile('curl', ['-sS', '-m', '40', '--compressed', u], { maxBuffer: 1 << 28 }, (e, out) => {
    if (e) return res(null);
    try { res(JSON.parse(out)); } catch (_) { res(null); }
  }));
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
function days(a, b) {
  const out = []; for (let d = new Date(a + 'T12:00:00Z'); d <= new Date(b + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}
function secs(c) { const m = String(c || '').match(/^(\d+):(\d+)(?:\.\d+)?$/); return m ? +m[1] * 60 + +m[2] : (/^\d+(\.\d+)?$/.test(String(c)) ? +c : null); }

// pregame line from pickcenter: home spread (ESPN's `spread` is the home line), total, moneylines
function pregame(d, home) {
  const pc = (d.pickcenter || []).find(p => p.overUnder != null || p.spread != null) || null;
  if (!pc) return null;
  const hml = pc.homeTeamOdds && pc.homeTeamOdds.moneyLine, aml = pc.awayTeamOdds && pc.awayTeamOdds.moneyLine;
  return { home_line: pc.spread == null ? null : +pc.spread, total: pc.overUnder == null ? null : +pc.overUnder,
           home_win: hml != null ? L.noVig(hml, aml != null ? aml : null) : null };
}

async function gamesFor(sport) {
  const ids = [];
  for (const [a, b] of WINDOWS[sport]) {
    const ds = days(a, b);
    const boards = await pool(ds, 8, d => curl(ESPN + PATHS[sport] + '/scoreboard?dates=' + d + (sport === 'cfb' ? '&groups=80' : '')));
    boards.forEach(j => ((j && j.events) || []).forEach(e => {
      const t = ((e.status || {}).type || {});
      if (t.state === 'post' && (e.season || {}).type !== 1) ids.push(e.id);
    }));
  }
  // an even spread across the window, newest included
  const step = Math.max(1, ids.length / GAMES);
  return Array.from({ length: Math.min(GAMES, ids.length) }, (_, i) => ids[Math.floor(i * step)]);
}

function states(sport, d) {
  const comp = ((d.header || {}).competitions || [])[0]; if (!comp) return [];
  const H = comp.competitors.find(c => c.homeAway === 'home'), A = comp.competitors.find(c => c.homeAway === 'away');
  if (!H || !A) return [];
  const fh = +H.score, fa = +A.score; if (isNaN(fh) || isNaN(fa)) return [];
  const pre = pregame(d, H.team.abbreviation); if (!pre || pre.total == null) return [];
  let plays = d.plays || [];
  if (!plays.length && d.drives) plays = [].concat(...(d.drives.previous || []).map(x => x.plays || []));
  plays = plays.filter(p => p.period && p.period.number && p.homeScore != null && p.clock);
  if (plays.length < 20) return [];
  const wp = {}; (d.winprobability || []).forEach(w => { wp[w.playId] = w.homeWinPercentage; });
  const out = [], n = Math.min(PER, plays.length);
  for (let k = 0; k < n; k++) {
    const p = plays[Math.floor((k + 0.5) * plays.length / n)];
    const f = L.left(sport, p.period.number, secs(p.clock.displayValue));
    if (f == null || f <= 0.004 || f >= 0.999) continue;
    out.push({ sport, gid: d.header.id, f, hs: +p.homeScore, as: +p.awayScore, pre, fh, fa, espn: wp[p.id] != null ? wp[p.id] : null });
  }
  return out;
}

// the same inputs live.js's game() builds from a scoreboard
function predict(s) {
  const sd = { nfl: 13.5, cfb: 16, nba: 12.5 }[s.sport];
  const pm = s.pre.home_line != null ? -s.pre.home_line : s.pre.home_win != null && s.sport !== 'nhl' ? (s.pre.home_win - 0.5) * 2 * sd * 0.8 : 0;
  const g = { hs: s.hs, as: s.as, f: s.f, pre_margin: pm, pre_total: s.pre.total, pre_home_win: s.pre.home_win != null ? s.pre.home_win : 0.5 };
  const M = L.model(s.sport, g);
  const tl = Math.floor(M.proj_total) + 0.5, ml = Math.floor(-M.proj_margin) + 0.5;   // our live total / margin as a line
  return { win: M.win(), cover: s.pre.home_line != null ? M.cover(s.pre.home_line) : null, over: M.over(s.pre.total),
           over_live: M.over(tl), tl, cover_live: M.cover(ml), ml };
}

const STAGES = [['first quarter of the game', 0.75, 1], ['second quarter', 0.5, 0.75], ['third quarter', 0.25, 0.5], ['late (15-25% left)', 0.15, 0.25], ['final 15% (no bets shown)', 0, 0.15]];
function grade(rows, key, outcome) {
  const R = rows.filter(r => r.P[key] != null && outcome(r) != null);
  const brier = R.reduce((s, r) => s + (r.P[key] - outcome(r)) ** 2, 0) / (R.length || 1);
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  R.forEach(r => { const b = buckets[Math.min(9, Math.floor(r.P[key] * 10))]; b.n++; b.p += r.P[key]; b.y += outcome(r); });
  const cal = buckets.filter(b => b.n >= 20).map(b => ({ said: +(b.p / b.n).toFixed(3), hit: +(b.y / b.n).toFixed(3), n: b.n }));
  const worst = cal.reduce((m, b) => Math.max(m, Math.abs(b.said - b.hit)), 0);
  return { n: R.length, brier: +brier.toFixed(4), worst_bucket_gap: +worst.toFixed(3), cal };
}

(async () => {
  const report = { at: new Date().toISOString(), per_game: PER, sports: {} };
  for (const sport of SPORTS) {
    const ids = await gamesFor(sport);
    const sums = await pool(ids, 6, id => curl(ESPN + PATHS[sport] + '/summary?event=' + id));
    let S = [].concat(...sums.filter(Boolean).map(d => states(sport, d)));
    S.forEach(s => { s.P = predict(s); }); ALL.push(...S.map(s => ({ ...s, P: undefined })));
    const win = r => r.fh > r.fa ? 1 : r.fh < r.fa ? 0 : null;
    const cover = r => { const m = r.fh - r.fa + r.pre.home_line; return m > 0 ? 1 : m < 0 ? 0 : null; };
    const over = r => r.fh + r.fa > r.pre.total ? 1 : r.fh + r.fa < r.pre.total ? 0 : null;
    const overL = r => r.fh + r.fa > r.P.tl ? 1 : 0, coverL = r => r.fh - r.fa + r.P.ml > 0 ? 1 : 0;
    const R = { games: sums.filter(Boolean).length, states: S.length, stages: {} };
    for (const [nm, lo, hi] of STAGES) {
      const T = S.filter(s => s.f >= lo && s.f < hi);
      const E = T.filter(s => s.espn != null);
      R.stages[nm] = {
        states: T.length,
        win: grade(T, 'win', win), cover_pregame_spread: grade(T, 'cover', cover), over_pregame_total: grade(T, 'over', over),
        over_our_live_total: grade(T, 'over_live', overL), cover_our_live_margin: grade(T, 'cover_live', coverL),
        // our live total and margin as 50-50 lines: about half should go each way if the center is right
        over_rate: +(T.reduce((s, r) => s + overL(r), 0) / (T.length || 1)).toFixed(3),
        cover_rate: +(T.reduce((s, r) => s + coverL(r), 0) / (T.length || 1)).toFixed(3),
        espn_benchmark: E.length ? { n: E.length, ours: +(E.reduce((s, r) => s + (r.P.win - win(r)) ** 2, 0) / E.length).toFixed(4),
                                     espn: +(E.reduce((s, r) => s + (r.espn - win(r)) ** 2, 0) / E.length).toFixed(4) } : null,
      };
    }
    report.sports[sport] = R;
    console.log(`\n${sport.toUpperCase()}: ${R.games} games, ${R.states} frozen moments`);
    for (const [nm, x] of Object.entries(R.stages)) {
      const e = x.espn_benchmark;
      console.log(`  ${nm.padEnd(28)} n=${String(x.states).padStart(5)}  win brier ${x.win.brier} (worst bucket off ${x.win.worst_bucket_gap})` +
        (e ? `  vs ESPN ${e.espn}` : '') + `  | cover ${x.cover_pregame_spread.worst_bucket_gap}  over ${x.over_pregame_total.worst_bucket_gap}` +
        `  | over our live total ${x.over_rate}  home covers our live margin ${x.cover_rate}`);
    }
  }
  if (arg('dump', null)) fs.writeFileSync(arg('dump'), JSON.stringify(ALL));
  const out = arg('out', null);
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
})();
