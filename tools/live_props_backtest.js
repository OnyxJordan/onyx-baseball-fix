// live_props_backtest.js - replays archived games through live.js's player-prop pricing (dev only).
//
// Input: data/<sport>/prop_archive.json (daily_top.keep_pregame: each game's pregame Onyx props, our
// projection "j", expected TDs "lam", the Onyx over/under prices). For each finished game it fetches
// ESPN's summary, rebuilds every archived player's stat at 10 moments (0%, 10%, ... 90% of the game
// played) from the play-by-play, checks the rebuilt final against the box score (a player-market that
// disagrees beyond a small tolerance is dropped and counted), then at each moment asks live.js's own
// OnyxLive.propP(mkt, cur, proj, f, line) (f = share of the game LEFT, live.js's convention) for the
// over at two lines:
//   the pregame Onyx line, and a 50-50 line at floor(cur + proj x f) + 0.5 (live.js's live mean);
// anytime TD: 1 - exp(-lam x f) while he has not scored (live.js bets()).
// Graded against the box-score final: Brier, log loss, calibration deciles, by stage, per market.
// Value calls: live.js bets() run on the PREGAME Onyx prices at the opening moment only (there is no
// archive of in-game prices), graded at those prices.
//   node tools/live_props_backtest.js [--sports=nba,nfl,cfb] [--cache=dir] [--out=report.json]
//                                     [--dump=moments.json] [--fit] [--write-params] [--gate]
// Pricing uses data/live/prop_params.json (the numbers the page and live_model.py use), else live.js's
// built-in defaults.
//   --fit           also refits PVAR / PK / YSD per market (one half of the games, scored on the other,
//                   both ways). The moments are the archive's rebuilt ones plus, when it has them, every
//                   snapshot in data/live/prop_snaps.json (live_log.py: real live lines and prices, graded
//                   on ESPN's final box score), which also get a calibration report against the live price.
//   --write-params  with --fit: writes data/live/prop_params.json with a bumped version ONLY when, for
//                   at least one market, the refit beats the current numbers on BOTH held-out halves
//                   (by MIN_GAIN log loss each), and only those markets change. A new version resets the
//                   gate's sample (the gate counts plays logged under the version in use).
//   --gate          grades the prop value plays in data/live/ledger.json (live_log.py, kind "prop") for
//                   the current prop_params version and writes data/live/props_gate.json. Rule: 60+
//                   graded plays, ROI +2% or better at the logged price, profitable in both halves
//                   (by date). live.js calls a live prop "Value" only when it says passed. Alone, --gate
//                   reads no network.
// NBA archive keys are date+hash; the ESPN event is found on that day's scoreboard by matchup.
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
global.window = {}; global.fetch = () => Promise.reject(new Error('offline'));
// live.js wires a click handler on load (the page's "Bet" taps); node has no document
global.document = global.document || { addEventListener() {}, querySelector() { return null; }, getElementById() { return null; } };
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'live.js'));
const L = window.OnyxLive;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
const PATHS = { nba: 'basketball/nba', nfl: 'football/nfl', cfb: 'football/college-football' };
const CACHE = arg('cache', path.join(require('os').tmpdir(), 'liveprops-cache'));
// the shared parameters (data/live/prop_params.json), so the fit starts from what is live
const PARAMS_F = path.join(ROOT, 'data', 'live', 'prop_params.json'), GATE_F = path.join(ROOT, 'data', 'live', 'props_gate.json');
const LEDGER_F = path.join(ROOT, 'data', 'live', 'ledger.json'), SNAPS_F = path.join(ROOT, 'data', 'live', 'prop_snaps.json');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const PARAMS0 = readJ(PARAMS_F, null);
if (PARAMS0) L.setPropParams(PARAMS0);
const MIN_GAIN = 0.0005;      // held-out log loss a refit must win by, on each half, to replace a market's numbers
const GATE = { n: 60, roi: 0.02 };
const SPORTS = arg('sports', 'nba,nfl,cfb').split(',');
const ELAPSED = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
fs.mkdirSync(CACHE, { recursive: true });

function curl(u) {
  return new Promise(res => execFile('curl', ['-sS', '-m', '40', '--compressed', u], { maxBuffer: 1 << 28 }, (e, out) => {
    if (e) return res(null);
    try { res(JSON.parse(out)); } catch (_) { res(null); }
  }));
}
// finished games never change, so a cached summary is reused; anything not final is re-fetched
async function cached(name, u, final) {
  const f = path.join(CACHE, name + '.json');
  if (fs.existsSync(f)) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (!final || final(j)) return j; } catch (_) {} }
  const j = await curl(u);
  if (j) fs.writeFileSync(f, JSON.stringify(j));
  return j;
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const isPost = j => (((((j || {}).header || {}).competitions || [])[0] || {}).status || {}).type && j.header.competitions[0].status.type.state === 'post';
function secs(c) { const m = String(c || '').match(/^(\d+):(\d+)(?:\.\d+)?$/); return m ? +m[1] * 60 + +m[2] : (/^\d+(\.\d+)?$/.test(String(c)) ? +c : null); }
const nk = n => String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const pn = n => nk(n).replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();   // live.js pn()
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// NBA: archive key -> ESPN event id, from the scoreboard of the game's ET date (and the day before, to be safe)
async function nbaEvent(v) {
  const t = new Date(new Date(v.start).getTime() - 5 * 3600e3);
  const ds = [t, new Date(t.getTime() - 864e5)].map(d => d.toISOString().slice(0, 10).replace(/-/g, ''));
  const [aw, hm] = String(v.m).split(' @ ');
  for (const d of ds) {
    const sb = await cached('nba_sb_' + d, ESPN + PATHS.nba + '/scoreboard?dates=' + d, j => (j.events || []).every(e => e.status.type.state === 'post'));
    const e = ((sb || {}).events || []).find(e => {
      const c = e.competitions[0].competitors, H = c.find(x => x.homeAway === 'home'), A = c.find(x => x.homeAway === 'away');
      return H.team.abbreviation === hm && A.team.abbreviation === aw;
    });
    if (e) return e.id;
  }
  return null;
}

// box score: athlete id -> {name, team, stats}; plus name -> id
function boxOf(sport, d) {
  const P = {};
  ((d.boxscore || {}).players || []).forEach(t => {
    const tid = String((t.team || {}).id);
    (t.statistics || []).forEach(cat => {
      const keys = cat.keys || [], nm = String(cat.name || '').toLowerCase();
      (cat.athletes || []).forEach(a => {
        const ath = a.athlete || {}, id = String(ath.id);
        const o = P[id] || (P[id] = { id, name: ath.displayName, first: ath.firstName, last: ath.lastName, team: tid, s: {}, dnp: false });
        const st = a.stats || [], at = k => { const i = keys.indexOf(k); return i >= 0 ? parseFloat(String(st[i]).split('-')[0]) : null; };
        if (sport === 'nba') {
          if (a.didNotPlay || !st.length) { o.dnp = true; return; }
          o.s.pts = at('points'); o.s.reb = at('rebounds'); o.s.ast = at('assists');
        } else if (nm === 'passing') { o.s.pass_yds = at('passingYards'); o.cat = true; }
        else if (nm === 'rushing') { o.s.rush_yds = at('rushingYards'); o.s.rtd = at('rushingTouchdowns') || 0; o.cat = true; }
        else if (nm === 'receiving') { o.s.rec = at('receptions'); o.s.rec_yds = at('receivingYards'); o.s.ctd = at('receivingTouchdowns') || 0; o.cat = true; }
        else o.cat = true;
      });
    });
  });
  Object.values(P).forEach(o => {
    if (sport === 'nba') return;
    // in the box at all: a missing category is a zero (a back with no catches is not in "receiving")
    ['pass_yds', 'rush_yds', 'rec', 'rec_yds'].forEach(k => { if (o.s[k] == null) o.s[k] = 0; });
    o.s.td = (o.s.rtd || 0) + (o.s.ctd || 0);
  });
  return P;
}

// NBA play-by-play -> per-play stat events [{e, id, k, v}]
function nbaEvents(d) {
  const ev = [];
  (d.plays || []).forEach(p => {
    if (!p.period || !p.clock) return;
    const f = L.left('nba', p.period.number, secs(p.clock.displayValue)); if (f == null) return;
    const e = 1 - f, pa = p.participants || [], id0 = pa[0] && pa[0].athlete && String(pa[0].athlete.id);
    const ty = String((p.type || {}).text || '');
    if (p.scoringPlay && p.scoreValue > 0 && id0) {
      ev.push({ e, id: id0, k: 'pts', v: p.scoreValue });
      if (!/free throw/i.test(ty) && pa[1] && pa[1].athlete) ev.push({ e, id: String(pa[1].athlete.id), k: 'ast', v: 1 });
    }
    if (/rebound/i.test(ty) && id0) ev.push({ e, id: id0, k: 'reb', v: 1 });
  });
  return ev;
}

// football play-by-play (no participants on ESPN's football plays): the player is found by name in
// the play text, among the offense's box-score players ("J.Daniels", "#11 C.Broughton", "Jordan Gant")
function forms(o) {
  const dn = String(o.name || ''), sp = dn.indexOf(' '), fn = o.first || (sp > 0 ? dn.slice(0, sp) : ''), rest = sp > 0 ? dn.slice(sp + 1) : dn;
  const last = o.last || rest, F = new Set([dn]);
  for (const ln of [rest, last, rest.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/, ''), last.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/, '')]) {
    if (!ln || !fn) continue;
    F.add(fn[0] + '.' + ln); F.add(fn[0] + '. ' + ln); if (fn.length > 1) F.add(fn.slice(0, 2) + '.' + ln);
  }
  return [...F].filter(x => x.length > 3).map(x => new RegExp('(^|[^A-Za-z.\'-])' + esc(x) + '(?![A-Za-z])'));
}
function yardsIn(t) {
  let m;
  if (/for no gain/i.test(t) && !/for -?\d+ y/i.test(t)) return 0;
  if ((m = t.match(/for a loss of (\d+) y/i))) return -m[1];
  if ((m = t.match(/for (-?\d+) y(?:ar)?ds?( loss)?/i))) return m[2] ? -Math.abs(+m[1]) : +m[1];
  if ((m = t.match(/for (\d+) y(?:ar)?ds? loss/i))) return -m[1];
  return null;
}
function fbEvents(sport, d, box) {
  let plays = [].concat(...(((d.drives || {}).previous) || []).map(x => x.plays || []));
  const seen = new Set(); plays = plays.filter(p => !seen.has(p.id) && seen.add(p.id));
  const byTeam = {};
  Object.values(box).forEach(o => { (byTeam[o.team] || (byTeam[o.team] = [])).push({ o, re: forms(o) }); });
  const find = (team, t) => {
    const hits = [];
    for (const r of byTeam[team] || []) for (const re of r.re) { const m = re.exec(t); if (m) { hits.push({ id: r.o.id, i: m.index + m[1].length }); break; } }
    return hits.sort((a, b) => a.i - b.i);
  };
  const ev = [];
  plays.forEach(p => {
    if (!p.period || !p.clock) return;
    const f = L.left(sport, p.period.number, secs(p.clock.displayValue)); if (f == null) return;
    const e = 1 - f, ty = String((p.type || {}).text || ''), t0 = String(p.text || '');
    if (/no play/i.test(t0) || /kickoff|punt|field goal|extra point|two-point|conversion|timeout|end (of )?(period|half|game|quarter)|two-minute|coin toss/i.test(ty)) return;
    if (/two-point|2pt|two point/i.test(t0.slice(0, 40))) return;
    // the play itself: drop the pre-snap notes ("C.Vinson reported in as eligible.", "Direct snap to D.Henry.")
    // and everything after it (the try after a touchdown, a penalty enforced after the play)
    const t = t0.replace(/[A-Z][\w.' -]{0,30}? reported in as eligible\.?\s*/g, '').replace(/Direct snap to [^.]+\.\s*/g, '')
      .split(/TWO-POINT CONVERSION|two-point|\bPENALTY\b|extra point|kick attempt|\bPAT\b/i)[0];
    const team = String((((p.start || {}).team) || {}).id || ''); if (!team) return;
    const H = find(team, t); if (!H.length) return;
    const td = /touchdown/i.test(t) && !/intercept|fumble/i.test(t.split(/touchdown/i)[0].slice(-120)) ? 1 : 0;
    // yards: ESPN's statYardage on a clean run or catch (college marks a penalty-shortened gain "(5)"), else the text
    // NFL statYardage folds in penalty yards, so the text's "for N yards" leads; college marks a gain cut
    // back by a penalty "(5)"; an NFL foul enforced at a spot short of the end of the run caps the gain there
    const clean = /^(rush|pass reception|rushing touchdown|passing touchdown)$/i.test(ty);
    let y = yardsIn(t);
    const cut = t0.match(/for \d+ y(?:ar)?ds? (?:gain|loss)? ?\((-?\d+)\)/i);
    if (cut) y = +cut[1];
    else if (sport === 'nfl' && y != null && /PENALTY/.test(t0) && !/declined|offsetting/i.test(t0)) {
      const sp = t0.match(/enforced at ([A-Z]{2,4}) (\d+)/), st = p.start || {}, pt = String(st.possessionText || '').match(/^([A-Z]{2,4}) (\d+)$/);
      if (sp && pt && st.yardsToEndzone != null) {
        const own = st.yardsToEndzone === 100 - +pt[2] ? pt[1] : null;     // the offense's own half label, when the ball starts there
        const yte = (lab, n) => own ? (lab === own ? 100 - n : n) : (lab === pt[1] ? n : 100 - n);
        const g = st.yardsToEndzone - yte(sp[1], +sp[2]);
        if (g < y) y = g;
      }
    }
    const yy = y == null ? (clean && p.statYardage != null ? p.statYardage : 0) : y;
    if (/\bsack(ed)?\b/i.test(t)) {      // college charges a sack to the passer's rushing; the NFL does not
      if (sport === 'cfb') ev.push({ e, id: H[0].id, k: 'rush_yds', v: y != null ? y : (p.statYardage || 0) });   // statYardage on sacks is unreliable
      return;
    }
    if (/incomplete|intercept/i.test(t) || /spiked/i.test(t)) return;
    if (/\bpass(es)?\b/i.test(t)) {
      if (H.length < 2) return;
      const qb = H[0], wr = H.find(h => h.id !== qb.id && h.i > qb.i); if (!wr) return;
      ev.push({ e, id: qb.id, k: 'pass_yds', v: yy }, { e, id: wr.id, k: 'rec', v: 1 }, { e, id: wr.id, k: 'rec_yds', v: yy });
      if (td) ev.push({ e, id: wr.id, k: 'td', v: 1 });
    } else if (/rush|run|scramble|kneel|up the middle|left end|right end|left tackle|right tackle|left guard|right guard|\bleft\b|\bright\b|middle/i.test(t) && (y != null || clean)) {
      ev.push({ e, id: H[0].id, k: 'rush_yds', v: yy });
      if (td) ev.push({ e, id: H[0].id, k: 'td', v: 1 });
    }
  });
  return ev;
}

const TOL = { pts: 2, reb: 1, ast: 1, rec: 0, rec_yds: 5, rush_yds: 5, pass_yds: 10, td: 0 };
const noVig = (o, u) => (o != null && u != null) ? L.noVig(o, u) : null;

async function sportRows(sport) {
  const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', sport, 'prop_archive.json'), 'utf8'));
  const keys = Object.keys(A), R = { sport, archived: keys.length, games: 0, not_final: 0, no_event: 0, players: new Set(), props: 0,
    agree: {}, dropped: [], rows: [], values: [] };
  await pool(keys, 6, async key => {
    const v = A[key];
    const eid = sport === 'nba' ? await nbaEvent(v) : key;
    if (!eid) { R.no_event++; return; }
    const d = await cached(sport + '_' + eid, ESPN + PATHS[sport] + '/summary?event=' + eid, isPost);
    if (!d || !isPost(d)) { R.not_final++; return; }
    R.games++;
    const box = boxOf(sport, d), byName = {};
    Object.values(box).forEach(o => { byName[pn(o.name)] = o; });
    const ev = sport === 'nba' ? nbaEvents(d) : fbEvents(sport, d, box);
    const at = (id, k, e) => ev.reduce((s, x) => s + (x.id === id && x.k === k && x.e <= e + 1e-9 ? x.v : 0), 0);
    const tdAt = id => { const x = ev.filter(x => x.id === id && x.k === 'td').map(x => x.e); return x.length ? Math.min(...x) : null; };
    for (const [pk, q] of Object.entries(v.pp || {})) {
      const [nm, mkt] = pk.split('|'), o = byName[pn(nm)];
      if (!o || o.dnp || (sport !== 'nba' && !o.cat)) continue;    // did not play: books void it
      const sk = mkt === 'anytime_td' ? 'td' : mkt, fin = o.s[sk];
      if (fin == null || isNaN(fin)) continue;
      const rb = ev.reduce((s, x) => s + (x.id === o.id && x.k === sk ? x.v : 0), 0);
      const A_ = R.agree[mkt] || (R.agree[mkt] = { n: 0, exact: 0, tol: 0, err: 0 });
      A_.n++; if (rb === fin) A_.exact++; A_.err += Math.abs(rb - fin);
      if (Math.abs(rb - fin) > TOL[sk]) { R.dropped.push({ gid: eid, player: nm, mkt, rebuilt: rb, box: fin }); continue; }
      A_.tol++;
      R.players.add(eid + '|' + nm); R.props++;
      const gid = String(eid);
      if (mkt === 'anytime_td') {
        if (q.lam == null) continue;
        const t0 = tdAt(o.id), y = fin >= 1 ? 1 : 0;
        for (const e of ELAPSED) {
          if (t0 != null && t0 <= e) break;           // already scored: settled, live.js prices nothing
          const f = 1 - e;
          R.rows.push({ sport, gid, player: nm, mkt, e, f, cur: 0, j: q.lam, line: 0.5, kind: 'td', p: 1 - Math.exp(-q.lam * f), y });
        }
        if (q.o != null) R.values.push(valueCall(sport, gid, nm, mkt, q, 0, y, null));
        continue;
      }
      if (q.j == null) continue;
      for (const e of ELAPSED) {
        const f = 1 - e, cur = e === 0 ? 0 : at(o.id, sk, e);
        const lines = [];
        if (q.l != null && Math.round(q.l * 2) % 2 === 1) lines.push(['pregame', q.l]);
        lines.push(['live50', Math.floor(cur + Math.max(0, q.j * f)) + 0.5]);
        for (const [kind, line] of lines) {
          if (cur > line && kind === 'pregame') { /* already cashed: still priced (p ~ 1), kept for honesty */ }
          R.rows.push({ sport, gid, player: nm, mkt, e, f, cur, j: q.j, line, kind, p: L.propP(mkt, cur, q.j, f, line), y: fin > line ? 1 : 0,
                       nv: e === 0 && kind === 'pregame' ? noVig(q.o, q.u) : null });
        }
      }
      if (q.l != null && (q.o != null || q.u != null)) R.values.push(valueCall(sport, gid, nm, mkt, q, 0, fin, null));
    }
  });
  R.players = R.players.size;
  return R;
}

// live.js bets() on the pregame Onyx prices at the opening moment (f = 1: nothing played yet)
function valueCall(sport, gid, nm, mkt, q, cur, fin) {
  const lines = mkt === 'anytime_td' ? [{ m: mkt, sel: nm, side: 'over', price: q.o }]
    : ['over', 'under'].filter(s => q[s[0]] != null).map(s => ({ m: mkt, sel: nm, side: s, pt: q.l, price: q[s[0]] }));
  const g = { sport, f: 1, M: {}, pre: { pp: { [nm + '|' + mkt]: q } } };
  const bx = { [pn(nm)]: mkt === 'anytime_td' ? { td: 0 } : { [mkt]: cur } };
  const B = L.bets(g, { lines }, bx).filter(b => L.isVal(b));
  return B.map(b => {
    const side = mkt === 'anytime_td' ? 'over' : /\bunder\b/.test(b.label) ? 'under' : 'over';
    const won = mkt === 'anytime_td' ? fin >= 1 : side === 'over' ? fin > q.l : fin < q.l;
    const push = mkt !== 'anytime_td' && fin === q.l;
    const dec = b.price > 0 ? b.price / 100 : 100 / -b.price;
    return { sport, gid, mkt, side, p: b.p, edge: b.edge, price: b.price, won: push ? null : won, units: push ? 0 : won ? dec : -1 };
  });
}

// prop_snaps.json (live_log.py) -> moments with a real live line and its prices, graded on ESPN's final
async function snapRows() {
  const S = readJ(SNAPS_F, null), out = [];
  if (!S || !S.days) return out;
  const fin = {};
  for (const day of Object.values(S.days)) {
    for (const r of day.r || []) {
      const k = (day.k || [])[r[1]]; if (!k) continue;
      const [sport, gid, player, mkt, proj] = k, [t, , line, over, under, p, cur, f] = r;
      if (!PATHS[sport]) continue;
      if (!(gid in fin)) {
        const d = await cached(sport + '_' + gid, ESPN + PATHS[sport] + '/summary?event=' + gid, isPost);
        fin[gid] = d && isPost(d) ? boxOf(sport, d) : null;
      }
      const B = fin[gid]; if (!B) continue;
      const o = Object.values(B).find(x => pn(x.name) === pn(player));
      if (!o || o.dnp || (sport !== 'nba' && !o.cat)) continue;
      const sk = mkt === 'anytime_td' ? 'td' : mkt, v = o.s[sk];
      if (v == null || isNaN(v)) continue;
      if (mkt === 'anytime_td') { out.push({ sport, gid, player, mkt, f, cur: 0, j: proj, line: 0.5, kind: 'td', p, y: v >= 1 ? 1 : 0, over, under, t }); continue; }
      if (line == null || v === line) continue;
      out.push({ sport, gid, player, mkt, f, cur, j: proj, line, kind: 'snap', p, y: v > line ? 1 : 0, over, under, nv: over != null && under != null ? L.noVig(over, under) : null, t });
    }
  }
  return out;
}

// --gate: the prop value plays live_log.py logged, for the prop parameters in use
function gate() {
  const led = readJ(LEDGER_F, []), ver = L.propVersion();
  const R = (Array.isArray(led) ? led : []).filter(r => r.kind === 'prop' && r.prop_model === ver && (r.result === 'W' || r.result === 'L'))
    .sort((a, b) => String(a.logged_at).localeCompare(String(b.logged_at)));
  const units = r => r.result === 'W' ? (r.price > 0 ? r.price / 100 : 100 / -r.price) : -1;
  const sum = X => { const w = X.filter(r => r.result === 'W').length, u = X.reduce((s, r) => s + units(r), 0);
    return { n: X.length, w, l: X.length - w, units: +u.toFixed(2), roi: X.length ? +(u / X.length).toFixed(4) : null,
             from: X.length ? String(X[0].date || X[0].logged_at).slice(0, 10) : null, to: X.length ? String(X[X.length - 1].date || X[X.length - 1].logged_at).slice(0, 10) : null }; };
  // halves by date: the earlier days and the later days, a day never split (the split day goes to the half that keeps them closest in size)
  const days = [...new Set(R.map(r => String(r.date || r.logged_at).slice(0, 10)))].sort();
  let cut = 0, best = Infinity;
  for (let i = 1; i < days.length; i++) { const a = R.filter(r => String(r.date || r.logged_at).slice(0, 10) < days[i]).length, d = Math.abs(2 * a - R.length); if (d < best) { best = d; cut = i; } }
  const H = days.length > 1 ? [R.filter(r => String(r.date || r.logged_at).slice(0, 10) < days[cut]), R.filter(r => String(r.date || r.logged_at).slice(0, 10) >= days[cut])] : [R, []];
  const all = sum(R), by_half = H.map(sum);
  const passed = all.n >= GATE.n && all.roi >= GATE.roi && by_half.every(h => h.n > 0 && h.units > 0);
  const out = { passed, n: all.n, w: all.w, l: all.l, units: all.units, roi: all.roi, by_half, version: ver, at: new Date().toISOString().slice(0, 19) + 'Z',
    pending: (Array.isArray(led) ? led : []).filter(r => r.kind === 'prop' && r.prop_model === ver && !r.result).length,
    rule: `${GATE.n}+ graded live prop value plays (data/live/ledger.json, kind prop) logged under prop params ${ver}, ROI +${GATE.roi * 100}% or better at the logged price, profitable in both halves split by date. Until it passes, the pages show live props as projections, "Value untested".` };
  fs.writeFileSync(GATE_F, JSON.stringify(out, null, 1) + '\n');
  console.log(`\nGATE ${ver}: ${out.passed ? 'PASSED' : 'not passed'}: ${all.n} graded (${all.w}-${all.l}, ${all.units}u, ROI ${all.roi == null ? '-' : (100 * all.roi).toFixed(1) + '%'}), halves ` +
    by_half.map(h => `${h.n} ${h.units}u`).join(' / ') + `, ${out.pending} open -> ${path.relative(ROOT, GATE_F)}`);
  return out;
}

// --write-params: adopt a market's refit only when it beats the current numbers on both held-out halves
function writeParams(F, nGames) {
  const P = PARAMS0 || { version: L.propVersion(), PVAR: Object.assign({}, L.PVAR), PK: Object.assign({}, L.PK), YSD: JSON.parse(JSON.stringify(L.YSD)) };
  const nx = { PVAR: Object.assign({}, L.PVAR), PK: Object.assign({}, L.PK), YSD: JSON.parse(JSON.stringify(L.YSD)) }, changed = [];
  for (const [mkt, x] of Object.entries(F)) {
    if (!x.folds.every(f => f.n_test > 0 && f.test_fit <= f.test_now - MIN_GAIN)) continue;
    const b = x.all_best.P, yds = /yds$/.test(mkt);
    const before = yds ? { k: x.now.k, a: x.now.a, b: x.now.b } : { k: x.now.k, v: x.now.v }, after = yds ? { k: b.k, a: b.a, b: b.b } : { k: b.k, v: b.v };
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    nx.PK[mkt] = b.k;
    if (yds) nx.YSD[mkt] = [b.a, b.b]; else nx.PVAR[mkt] = b.v;
    changed.push(`${mkt} ${JSON.stringify(before)} -> ${JSON.stringify(after)} (held-out LL ${x.folds.map(f => f.test_now + ' -> ' + f.test_fit).join(', ')})`);
  }
  if (!changed.length) { console.log('\nwrite-params: no market beat the current numbers on both held-out halves; ' + path.relative(ROOT, PARAMS_F) + ' unchanged'); return false; }
  const m = /^(.*?)(\d+)$/.exec(String(P.version || 'props-v1')), ver = m ? m[1] + (+m[2] + 1) : 'props-v2';
  const out = { version: ver, at: new Date().toISOString().slice(0, 10), replaces: P.version || null,
    evidence: `Weekly refit (tools/live_props_backtest.js --fit --write-params) on ${nGames}; each change won on both held-out halves by ${MIN_GAIN}+ log loss: ` + changed.join('; ') + '. A new version starts the prop value gate over.',
    PVAR: nx.PVAR, PK: nx.PK, YSD: nx.YSD };
  fs.writeFileSync(PARAMS_F, JSON.stringify(out, null, 1) + '\n');
  L.setPropParams(out);
  console.log(`\nwrite-params: ${P.version} -> ${ver}\n  ` + changed.join('\n  '));
  return true;
}

// ── grading ──
const ll = (p, y) => { p = Math.min(0.999, Math.max(0.001, p)); return -(y ? Math.log(p) : Math.log(1 - p)); };
function grade(R, key = 'p') {
  const n = R.length; if (!n) return { n: 0 };
  const brier = R.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / n, lo = R.reduce((s, r) => s + ll(r[key], r.y), 0) / n;
  const base = R.reduce((s, r) => s + r.y, 0) / n;
  const B = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  R.forEach(r => { const b = B[Math.min(9, Math.floor(r[key] * 10))]; b.n++; b.p += r[key]; b.y += r.y; });
  const cal = B.map((b, i) => b.n ? { b: i / 10, said: +(b.p / b.n).toFixed(3), hit: +(b.y / b.n).toFixed(3), n: b.n } : null).filter(Boolean);
  const ece = B.reduce((s, b) => s + (b.n ? Math.abs(b.p - b.y) : 0), 0) / n;
  return { n, brier: +brier.toFixed(4), logloss: +lo.toFixed(4), hit_rate: +base.toFixed(3), mean_p: +(R.reduce((s, r) => s + r[key], 0) / n).toFixed(3), ece: +ece.toFixed(4), cal };
}
const STAGES = [['opening (f=1, pregame)', 1, 1.01], ['1st quarter played (f .7-.9)', 0.7, 1], ['middle (f .4-.6)', 0.4, 0.7], ['late (f .1-.3)', 0.1, 0.4]];
// live moments the card can show (8%+ left, after tip/kickoff)
const live = r => r.f < 0.999 && r.f >= 0.08;

// ── fit: PVAR per count market, the yards SD (a x proj + b) and the projection scale PK, per market, on one
// half of the games (split by a hash of the game id), scored on the other half, then the halves swapped ──
const half = r => { let h = 0; for (const c of String(r.gid)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 2; };
function propPx(r, P) {      // live.js propP with its constants as parameters
  const rem = Math.max(0, r.j * P.k * r.f), mean = r.cur + rem;
  let sd;
  if (/yds$/.test(r.mkt)) sd = (P.a * r.j + P.b) * Math.sqrt(r.f);
  else sd = Math.sqrt(Math.max(0.15, rem * P.v));
  sd = Math.max(sd, 0.35);
  return 1 - L.phi((r.line - mean) / sd);
}
function fit(rows) {
  const out = {}, groups = {};
  rows.filter(r => r.kind !== 'td' && live(r)).forEach(r => { (groups[r.mkt] || (groups[r.mkt] = [])).push(r); });
  const score = (R, P) => R.reduce((s, r) => s + ll(propPx(r, P), r.y), 0) / (R.length || 1);
  for (const [mkt, R] of Object.entries(groups)) {
    const yds = /yds$/.test(mkt), Y = (L.YSD || {})[mkt] || [0.45, 12];
    const now = { v: (L.PVAR || {})[mkt] || 1.5, k: (L.PK || {})[mkt] || 1, a: Y[0], b: Y[1] };   // live.js as it stands
    const grid = [];
    for (const k of [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1])
      if (yds) { for (const a of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) for (const b of [0, 4, 8, 12, 16, 20, 24]) grid.push({ k, a, b, v: now.v }); }
      else for (const v of [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.4, 2.8, 3.2, 4, 5]) grid.push({ k, v, a: now.a, b: now.b });
    const folds = [0, 1].map(h => {
      const tr = R.filter(r => half(r) === h), te = R.filter(r => half(r) !== h);
      let best = null; for (const P of grid) { const s = score(tr, P); if (!best || s < best.s) best = { s, P }; }
      return { fit_on: h, n_train: tr.length, n_test: te.length, games_test: new Set(te.map(r => r.gid)).size, fitted: best.P,
               test_now: +score(te, now).toFixed(4), test_fit: +score(te, best.P).toFixed(4) };
    });
    let all_best = null; for (const P of grid) { const s = score(R, P); if (!all_best || s < all_best.s) all_best = { s: +s.toFixed(4), P }; }
    out[mkt] = { now, all_now: +score(R, now).toFixed(4), all_best, n: R.length, games: new Set(R.map(r => r.gid)).size, folds };
  }
  return out;
}

(async () => {
  const FIT = process.argv.includes('--fit'), GATE_ONLY = process.argv.includes('--gate') && !FIT;
  console.log(`prop params ${L.propVersion()}${PARAMS0 ? ' (data/live/prop_params.json)' : ' (live.js defaults)'}`);
  if (GATE_ONLY) { gate(); return; }
  const report = { at: new Date().toISOString(), params: L.propVersion(), moments: ELAPSED, sports: {} }, ALL = [];
  for (const sport of SPORTS) {
    const R = await sportRows(sport);
    ALL.push(...R.rows);
    const S = { archived_games: R.archived, finished_games: R.games, not_final: R.not_final, no_espn_event: R.no_event, players: R.players, props: R.props,
      moments: R.rows.length, rebuild: {}, dropped: R.dropped.length, dropped_sample: R.dropped.slice(0, 12), markets: {}, value: {} };
    for (const [m, a] of Object.entries(R.agree)) S.rebuild[m] = { n: a.n, exact: +(a.exact / a.n).toFixed(3), within_tol: +(a.tol / a.n).toFixed(3), mean_abs_err: +(a.err / a.n).toFixed(2) };
    const mk = [...new Set(R.rows.map(r => r.mkt))];
    for (const m of mk) {
      const M = R.rows.filter(r => r.mkt === m), X = { };
      for (const kind of [...new Set(M.map(r => r.kind))]) {
        const K = M.filter(r => r.kind === kind);
        X[kind] = { live: grade(K.filter(live)), stages: {} };
        for (const [nm, lo, hi] of STAGES) X[kind].stages[nm] = grade(K.filter(r => r.f >= lo && r.f < hi));
      }
      // opening moment vs Onyx's own no-vig price at the same pregame line
      const O = M.filter(r => r.kind === 'pregame' && r.e === 0 && r.nv != null);
      if (O.length) X.opening_vs_onyx = { ours: grade(O), onyx_novig: grade(O, 'nv') };
      S.markets[m] = X;
    }
    const V = [].concat(...R.values);
    for (const m of [...new Set(V.map(v => v.mkt)), 'all']) {
      const W = V.filter(v => m === 'all' || v.mkt === m), G = W.filter(v => v.won != null);
      if (!W.length) continue;
      S.value[m] = { calls: W.length, won: G.filter(v => v.won).length, lost: G.filter(v => !v.won).length, pushes: W.length - G.length,
        units: +W.reduce((s, v) => s + v.units, 0).toFixed(2), roi: +(W.reduce((s, v) => s + v.units, 0) / W.length).toFixed(3),
        mean_p: +(W.reduce((s, v) => s + v.p, 0) / W.length).toFixed(3), mean_edge: +(W.reduce((s, v) => s + v.edge, 0) / W.length).toFixed(3),
        overs: W.filter(v => v.side === 'over').length, unders: W.filter(v => v.side === 'under').length };
    }
    report.sports[sport] = S;
    console.log(`\n${sport.toUpperCase()}: ${S.finished_games}/${S.archived_games} games final (${S.not_final} not final, ${S.no_espn_event} no ESPN event), ${S.players} players, ${S.props} props, ${S.moments} priced moments, ${S.dropped} dropped by the rebuild check`);
    for (const [m, a] of Object.entries(S.rebuild)) console.log(`  rebuild ${m.padEnd(10)} n=${a.n} exact ${a.exact} within tol ${a.within_tol} mean abs err ${a.mean_abs_err}`);
    for (const [m, X] of Object.entries(S.markets)) for (const [kind, G] of Object.entries(X)) {
      if (kind === 'opening_vs_onyx') { console.log(`  ${m.padEnd(10)} opening vs Onyx no-vig: ours LL ${G.ours.logloss} Brier ${G.ours.brier} | Onyx LL ${G.onyx_novig.logloss} Brier ${G.onyx_novig.brier} (n=${G.ours.n})`); continue; }
      const g = G.live;
      console.log(`  ${m.padEnd(10)} ${kind.padEnd(8)} live n=${g.n} LL ${g.logloss} Brier ${g.brier} said ${g.mean_p} hit ${g.hit_rate} ECE ${g.ece}  ` +
        Object.entries(G.stages).map(([nm, s]) => `${nm.split(' ')[0]} ${s.n ? s.logloss + '/' + s.mean_p + '>' + s.hit_rate : '-'}`).join('  '));
    }
    for (const [m, x] of Object.entries(S.value)) console.log(`  value ${m.padEnd(10)} ${x.calls} calls ${x.won}-${x.lost}-${x.pushes} ${x.units}u ROI ${x.roi} (said ${x.mean_p}, edge ${x.mean_edge}; ${x.overs} overs ${x.unders} unders)`);
  }
  if (FIT) {
    const SN = await snapRows();
    if (SN.length) {
      ALL.push(...SN);
      const P = SN.filter(r => r.kind === 'snap' && r.nv != null && live(r));
      report.snaps = { moments: SN.length, games: new Set(SN.map(r => r.gid)).size, ours: grade(SN.filter(live)), priced_both_sides: P.length,
        vs_live_price: P.length ? { ours: grade(P), live_novig: grade(P, 'nv') } : null };
      console.log(`\nSNAPSHOTS (data/live/prop_snaps.json): ${SN.length} graded moments from ${report.snaps.games} games` +
        (P.length ? `; against the live line's no-vig price on ${P.length}: ours LL ${report.snaps.vs_live_price.ours.logloss} vs live ${report.snaps.vs_live_price.live_novig.logloss}` : ''));
    }
    report.fit = fit(ALL);
    console.log('\nFIT (live moments 8%+ left, both lines; fit on one half of the games, scored on the other, both ways):');
    for (const [m, x] of Object.entries(report.fit))
      console.log(`  ${m.padEnd(9)} live.js now ${JSON.stringify(x.now)} LL ${x.all_now}  ` + x.folds.map(f => `| fit ${JSON.stringify(f.fitted)} held-out ${f.test_now} -> ${f.test_fit} (${f.games_test} games)`).join('  '));
  }
  if (FIT && process.argv.includes('--write-params')) {
    const ng = Object.entries(report.sports).map(([s, x]) => `${x.finished_games} ${s.toUpperCase()}`).join(', ') + ' archived games' + (report.snaps ? ` + ${report.snaps.games} games of live snapshots` : '');
    report.params_written = writeParams(report.fit, ng);
  }
  if (process.argv.includes('--gate')) report.gate = gate();
  if (arg('dump', null)) fs.writeFileSync(arg('dump'), JSON.stringify(ALL));
  if (arg('out', null)) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 1));
})();
