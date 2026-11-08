// verify_ask.js - Ask Onyx against tools/ask_corpus.json on today's boards (dev only).
// Each query passes when the reading matches what the phrase means (sport, market, intent,
// count, side, prices, team, player) AND every play returned honors it AND, when today's boards
// hold anything that fits, the answer is not empty. Prints the pass rate, the failures and timing.
// The default run adds tools/ask_college_cases.js (hand-written college and team-name cases;
// --college runs them alone). Every answer, in every corpus, is also checked for (11/2):
//   - every play on today's board file (data/<sport>/board.json, read here on its own) at the
//     same Onyx price, selection and sport, and tagged an Onyx Pick only if it is in the ledger
//   - no cross-league leak: no play outside the sports read, none on a team that was not named
//   - no em dash and no other sportsbook's name in anything the answer says
//   node tools/verify_ask.js [--show]          exits 1 below 95%
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
// --corpus=tools/ask_big.json (thousands, tools/ask_bigcorpus.py); --ai=<relay url> sends every request through
// the live AI relay (curl, paced by --pace=ms, default 3400: under the relay's 20 a minute); --sample=N
const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('=');
const CORPUS = arg('corpus') ? path.resolve(arg('corpus')) : path.join(__dirname, process.argv.includes('--holdout2') ? 'ask_holdout2.json' : process.argv.includes('--holdout') ? 'ask_holdout.json' : 'ask_corpus.json');
let C = process.argv.includes('--college') ? [] : JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
if (process.argv.includes('--college') || (!arg('corpus') && !process.argv.includes('--holdout') && !process.argv.includes('--holdout2'))) C = C.concat(require('./ask_college_cases.js'));
if (!arg('corpus') && !process.argv.includes('--holdout') && !process.argv.includes('--holdout2') && !process.argv.includes('--college')) C = C.concat(require('./ask_compound_cases.js'));
if (arg('sample')) { const n = +arg('sample'), step = C.length / n; C = Array.from({length: Math.min(n, C.length)}, (_, i) => C[Math.floor(i * step)]); }
const AI = arg('ai'), PACE = +(arg('pace') || (AI ? 3400 : 0));
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.end(b); }); }).listen(0);
(async () => {
  const port = srv.address().port, base0 = 'http://127.0.0.1:' + port;
  const b = await chromium.launch(); const pg = await b.newPage();
  const { execFileSync } = require('child_process');
  await pg.route('**/*', rt => { const u = rt.request().url();
    if (AI && u.startsWith(base0 + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: JSON.stringify({url: AI})});
    if (AI && u.startsWith(AI)) { try { return rt.fulfill({status: 200, contentType: 'application/json', body: execFileSync('curl', ['-sS', '-m', '30', '-X', 'POST', u, '-H', 'origin: https://onyxjordan.github.io', '-H', 'content-type: application/json', '--data-binary', rt.request().postData() || '{}']).toString()}); } catch (e) { return rt.fulfill({status: 502, body: '{}'}); } }
    if (!AI && u.startsWith(base0 + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'});
    return u.startsWith(base0) ? rt.continue() : rt.abort(); });
  await pg.goto(`http://127.0.0.1:${port}/home.html`, { waitUntil: 'domcontentloaded' });
  const load = await pg.evaluate(async () => { const t = performance.now(); await OnyxAsk.loadBoards(); return performance.now() - t; });
  const res = await pg.evaluate(async ([C, PACE]) => {
    const B = await OnyxAsk.loadBoards(), now = Date.now(), out = [];
    // today's boards and the Onyx Picks ledger, read straight from the files: every play shown must be one of these rows
    const FILE = {}, LEDGER = {};
    for (const sp of Object.keys(OnyxAsk.LG)) { try { const j = await (await fetch('data/' + sp + '/board.json', {cache: 'no-cache'})).json(); (j.plays || []).forEach(p => { FILE[sp + '|' + p.sel + '|' + p.label + '|' + p.matchup] = p; }); } catch (e) {} }
    try { const L = await (await fetch('data/picks/ledger.json', {cache: 'no-cache'})).json(); (Array.isArray(L) ? L : []).forEach(r => { if (r && r.sel) LEDGER[r.sel] = 1; }); } catch (e) {}
    const teamsFor = (s, sp) => s.tabbr ? (s.tabbr[sp] || []) : ((s.teams || []).length ? s.teams : s.team ? [s.team] : []);
    const onT = (p, T) => { const hay = [p.team, p.matchup, p.name].join(' ').toUpperCase(); return T.some(x => new RegExp('(^|[^A-Z])' + String(x).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z]|$)').test(hay)); };
    const same = (a, b) => a.length === b.length && a.every(x => b.indexOf(x) >= 0);
    // does today's board hold anything this reading could answer with (sport, market, day, price, side)?
    // checked at each question's own time: a 40-minute --ai run outlasts kickoffs
    const avail = (sp, mk, s) => B.some(p => Date.parse(p.start) > Date.now() && (!sp || sp.indexOf(p.sport) >= 0)
      && (!mk || mk.some(m => p.mkt === m || p.kind === m || (m === 'two_plus_td' && p.lam != null)))
      && (!s.when || OnyxAsk.whenOk(s.when, p.start)) && (s.min_price == null || p.price >= s.min_price) && (s.max_price == null || p.price <= s.max_price) && (s.min_conf == null || p.conf >= s.min_conf)
      && (!s.side || s.side === 'any' || !(p.kind === 'prop' || p.kind === 'total') || p.side === s.side) && (!s.props_only || p.kind === 'prop'));
    for (const c of C) {
      if (PACE) await new Promise(r => setTimeout(r, PACE));
      const t0 = performance.now(); let R;
      try { R = await OnyxAsk.ask(c.q); } catch (e) { out.push({q: c.q, ok: false, why: ['error ' + e.message], ms: 0}); continue; }
      const ms = performance.now() - t0, s = R.asked || R.spec, e = c.e, why = [];   // the reading before any widening (11/6)
      if (e.sports && !same(s.sports || [], e.sports)) why.push(`sports ${JSON.stringify(s.sports)} want ${JSON.stringify(e.sports)}`);
      if (e.markets && !same(s.markets || [], e.markets)) why.push(`markets ${JSON.stringify(s.markets)} want ${JSON.stringify(e.markets)}`);
      if (e.intent && s.intent !== e.intent) why.push(`intent ${s.intent} want ${e.intent}`);
      if (e.count != null && s.count !== e.count) why.push(`count ${s.count} want ${e.count}`);
      if (e.count_not != null && s.count === e.count_not) why.push(`count ${s.count}: a conference number read as a count`);
      if (e.side && s.side !== e.side) why.push(`side ${s.side} want ${e.side}`);
      if (e.min_price != null && s.min_price !== e.min_price) why.push(`min_price ${s.min_price} want ${e.min_price}`);
      if (e.max_price != null && s.max_price !== e.max_price) why.push(`max_price ${s.max_price} want ${e.max_price}`);
      if (e.min_conf != null && s.min_conf !== e.min_conf) why.push(`min_conf ${s.min_conf} want ${e.min_conf}`);
      if (e.team && s.team !== e.team && !Object.values(s.tabbr || {}).some(v => (v || []).indexOf(e.team) >= 0)) why.push(`team ${s.team} want ${e.team}`);   // a school on two boards (football and basketball)
      const nmS = x => String(x || '').toLowerCase().replace(/[.']/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();   // "Terrance Carter Jr." is Terrance Carter (11/8)
      if (e.player && nmS(s.player) !== nmS(e.player)) why.push(`player ${s.player} want ${e.player}`);
      if (e.teams) { const got = ((s.teams || []).length ? s.teams : s.team ? [s.team] : []).map(x => String(x).toUpperCase()).sort(); if (!same(got, e.teams)) why.push(`teams ${JSON.stringify(got)} want ${JSON.stringify(e.teams)}`); }
      if (e.props_only && !s.props_only) why.push('props_only not set');
      if (e.sort && s.sort !== e.sort) why.push(`sort ${s.sort} want ${e.sort}`);
      if (e.pos_value != null && !!s.pos_value !== e.pos_value) why.push(`pos_value ${!!s.pos_value} want ${e.pos_value}`);
      if (e.when && s.when !== e.when) why.push(`when ${s.when} want ${e.when}`);
      if (e.exclude && !e.exclude.every(x => (s.exclude || []).some(y => String(y).toLowerCase() === String(x).toLowerCase()))) why.push(`exclude ${JSON.stringify(s.exclude || [])} want ${JSON.stringify(e.exclude)}`);
      if (e.unsupported && !s.unsupported) why.push('should say we do not price this');
      if (!e.unsupported && s.unsupported && Object.keys(e).length) why.push(`wrongly says not priced: ${s.unsupported}`);
      if (e.unsupported && !R.clarify) why.push('no follow-up offered for a bet we do not price');
      if (e.target_price != null && s.target_price !== e.target_price) why.push(`target_price ${s.target_price} want ${e.target_price}`);
      // compound searches (11/8, tools/ask_compound_cases.js): a kickoff window, a ticket minimum, exclusions, xmk
      if (e.slot && (!s.slot || s.slot.label !== e.slot)) why.push(`slot ${s.slot ? s.slot.label : '-'} want ${e.slot}`);
      if (e.no_slot && s.slot) why.push(`read a slot nobody asked for: ${s.slot.label}`);
      if (e.ticket_floor && !s.ticket_floor) why.push('total odds not read as the ticket minimum');
      if (e.xmk && !e.xmk.every(m => (s.xmk || []).indexOf(m) >= 0)) why.push(`xmk ${JSON.stringify(s.xmk || [])} want ${JSON.stringify(e.xmk)}`);
      if (e.no_player && s.player) why.push(`read a player ${s.player}: should be excluded`);
      if (e.max_legs && (R.rows || []).length > e.max_legs) why.push(`${R.rows.length} legs, no more than ${e.max_legs} asked`);
      // college and team-name expectations (tools/ask_college_cases.js, tools/ask_taxonomy.py)
      if (e.school && s.school !== e.school) why.push(`school ${s.school} want ${e.school}`);
      if (e.ambig && !R.ambig) why.push(`should ask which team (read: ${R.understood})`);
      if (!e.ambig && R.ambig && Object.keys(e).length && !e.ambig_ok) why.push(`asked which team: ${(R.clarify && R.clarify.options || []).map(o => o.label).join(' | ')}`);
      if (e.ambig_has) { const labs = (R.clarify && R.clarify.options || []).map(o => o.label).join(' | '); e.ambig_has.forEach(n => { if (labs.indexOf(n) < 0) why.push(`no button for ${n}`); }); }
      if (e.conf && s.conf !== e.conf) why.push(`conf ${s.conf} want ${e.conf}`);
      if (e.depth && !R.depth) why.push('not answered from the depth charts');
      if (e.depth && R.depth && !R.depth.length) why.push('depth chart found nothing');
      if (e.depth_team && !(R.depth || []).some(d => d.team === e.depth_team)) why.push(`depth team ${(R.depth || []).map(d => d.team)} want ${e.depth_team}`);
      if (e.depth_player && !(R.depth || []).some(d => d.focus === e.depth_player)) why.push(`depth player ${(R.depth || []).map(d => d.focus)} want ${e.depth_player}`);
      if (!e.depth && R.depth && Object.keys(e).length) why.push('answered as a depth chart');
      if (e.onyx_picks && !s.onyx_picks) why.push('not read as Onyx Picks');
      if (e.min_rows) { const g = {}; Object.values(FILE).forEach(f => { if (Date.parse(f.start) > Date.now() && (!e.sports || e.sports.indexOf(f.sport) >= 0) && (!e.markets || e.markets.indexOf(f.mkt) >= 0) && (!s.min_price || f.price >= s.min_price) && (!s.min_conf || f.conf >= s.min_conf) && (!s.when || OnyxAsk.whenOk(s.when, f.start))) g[f.gid] = 1; });
        const need = Math.min(e.min_rows, Object.keys(g).length); if ((R.rows || []).length < need) why.push(`${(R.rows || []).length} plays, want ${need} (the board has ${Object.keys(g).length} games)`); }
      if (e.sports_in && !R.ambig && !((s.sports || []).length && s.sports.every(x => e.sports_in.indexOf(x) >= 0))) why.push(`sports ${JSON.stringify(s.sports)} want within ${JSON.stringify(e.sports_in)}`);
      if (e.no_sports && (s.sports || []).some(x => e.no_sports.indexOf(x) >= 0)) why.push(`read as ${JSON.stringify(s.sports)}, never ${JSON.stringify(e.no_sports)}`);
      if (e.no_sports && (R.rows || []).some(p => e.no_sports.indexOf(p.sport) >= 0)) why.push('a play from a league it must not touch');
      if (e.no_sports && R.clarify && (R.clarify.options || []).some(o => o.spec && (o.spec.sports || []).some(x => e.no_sports.indexOf(x) >= 0)) && !R.ambig && !/Did you mean/.test(R.clarify.question || '')) why.push('offered a team from a league it must not touch');
      if (e.team_in && !(e.team_in.indexOf(s.team) >= 0 || R.clarify)) why.push(`team ${s.team} want one of ${e.team_in}`);
      // nothing the answer says has an em dash or another book's name
      const said = [R.understood, R.note, R.say, R.clarify && R.clarify.question].concat((R.clarify && R.clarify.options || []).map(o => o.label)).join(' ');
      if (/\u2014/.test(said)) why.push('em dash in the answer');
      if (/draftkings|fanduel|betmgm|caesars|bet365|espn ?bet|fanatics/i.test(said)) why.push('another sportsbook named');
      // every play returned must honor the reading
      const legs = (R.rows || []);
      for (const p of legs) {
        if ((s.sports || []).length && s.sports.indexOf(p.sport) < 0) { why.push(`play from ${p.sport}`); break; }
        const mk = (s.markets || []).slice(); if (mk.indexOf('two_plus_td') >= 0) mk.push('anytime_td', 'two_td');
        if (mk.length && !R.widened && mk.indexOf(p.mkt) < 0 && mk.indexOf(p.kind) < 0) { why.push(`play market ${p.mkt}`); break; }   // a widened SGP says so
        if (s.props_only && p.kind !== 'prop') { why.push('game line in a props answer'); break; }
        if (!R.widened && s.side && s.side !== 'any' && (p.kind === 'prop' || p.kind === 'total') && p.side !== s.side) { why.push(`play side ${p.side}`); break; }
        // a widened answer (11/6: nothing matched, so the closest, said in its note) may leave the asked price or side
        const F = R.spec || s;      // plays honor the rules the answer states (after any widening it announces)
        if (!R.widened && !R.two && F.min_price != null && p.price < F.min_price && !(F.target_price && F.default_floor)) { why.push(`price ${p.price} under ${F.min_price}`); break; }   // a payout target moves the default floor
        if (!R.widened && !R.two && F.max_price != null && p.price > F.max_price) { why.push(`price ${p.price} over ${F.max_price}`); break; }
        if (R.widened && !R.note) { why.push('widened without saying so'); break; }
        if (s.pos_value && !R.widened && !(p.edge > 0)) { why.push(`positive value only, but ${p.label} has edge ${p.edge}`); break; }
        if (Date.parse(p.start) <= now) { why.push('started game'); break; }
        if (s.slot && !R.widened && !OnyxAsk.slotOk(s.slot, p.start)) { why.push(`play outside the ${s.slot.label}: ${p.label} ${p.start}`); break; }
        if ((s.exclude || []).some(x => String(p.name || p.label).toLowerCase().indexOf(String(x).toLowerCase()) >= 0)) { why.push(`excluded ${p.name || p.label} is in the answer`); break; }
        if (s.player && String(p.name || p.label).toLowerCase().indexOf(String(s.player).toLowerCase()) < 0) { why.push(`play not on ${s.player}`); break; }
        // on today's board file, at the same Onyx price, with its league's tag
        // keyed by game too: a market-line play (Onyx down, 11/5) has no selection id, and the same label
        // ("Under 155.5 total") sits in several games
        const f = FILE[p.sport + '|' + p.sel + '|' + p.label + '|' + p.matchup];
        if (!f) { why.push(`play not on the ${p.sport} board file: ${p.label}`); break; }
        if (f.price !== p.price || f.sport !== p.sport || f.matchup !== p.matchup) { why.push(`price or game differs from the board file: ${p.label} ${p.price} vs ${f.price}`); break; }
        if (!OnyxAsk.LG[p.sport]) { why.push(`no league tag for ${p.sport}`); break; }
        if (p.pick && !LEDGER[p.sel]) { why.push(`tagged an Onyx Pick but not in the ledger: ${p.label}`); break; }
        if (s.onyx_picks && !p.pick) { why.push(`not an Onyx Pick: ${p.label}`); break; }
        // no cross-league or wrong-team leak: a play is on a team the request named (each sport's own abbreviations)
        const T = teamsFor(s, p.sport);
        if ((s.tabbr || (s.teams || []).length || s.team) && !s.player && !R.widened) {
          if (!T.length) { why.push(`play from ${p.sport}, a league no named team is in`); break; }
          if (!onT(p, T)) { why.push(`play not on a named team: ${p.label} [${p.matchup}]`); break; }
          if ((p.kind === 'spread' || p.kind === 'ml') && T.map(x => String(x).toUpperCase()).indexOf(String(p.team || p.name).toUpperCase()) < 0) { why.push(`the other side of a named team's game: ${p.label}`); break; }
        }
      }
      // 11/6 outcome checks (Jordan: "I have no confidence in its search ability"): the ticket itself must be right
      const LAB = legs.map(p => p.label + '|' + p.matchup);
      if (new Set(LAB).size !== LAB.length) why.push('the same leg twice');
      const sideKey = {}; for (const p of legs) {
        const k = p.matchup + '|' + (p.kind === 'prop' ? p.mkt + '|' + p.name + '|' + p.line : p.kind);
        if (sideKey[k] && sideKey[k] !== p.side + '|' + (p.team || p.name)) { why.push(`both sides of one bet: ${p.label}`); break; }
        sideKey[k] = p.side + '|' + (p.team || p.name);
      }
      // only a count the question asked for (a number of legs or picks), never the reader's default of 5
      const NUMRE = /\b(top|best|safest|surest|give me|gimme|parlay of)\s+(\d{1,2}|two|three|four|five|six)\b(?!\s*%)|\b(\d{1,2}|two|three|four|five|six)[ -]?(leg|legs|legger|pick|picks|plays|bets|team|best|safest|top)\b|\b(\d{1,2})\s+(nba|nfl|nhl|hockey|basketball|football|hoops|ncaab|ncaaf|cbb|cfb|college|tennis)\b/i;
      const askedN = NUMRE.test(c.q) ? s.count : null;   // only a number the question says, never the reader's default of 5
      if (askedN && !s.target_price && (s.intent === 'parlay' || s.intent === 'sgp' || s.intent === 'list') && legs.length) {
        if (legs.length > askedN) why.push(`${legs.length} legs, asked for ${askedN}`);
        else if (legs.length < askedN && !R.note) why.push(`${legs.length} legs, asked for ${askedN}, and no note saying why`);
      }
      if ((s.intent === 'sgp' || R.parlay && R.parlay.same_game) && legs.length > 1 && new Set(legs.map(p => p.gid)).size > 1) why.push('same-game parlay with legs from different games');
      if (s.target_price != null && legs.length > 1 && R.parlay && R.parlay.price != null && R.parlay.price < s.target_price && !R.note) why.push(`ticket pays ${R.parlay.price}, asked for at least +${s.target_price}`);
      // exclusions (11/6, Jordan: "if you say no that's actually the only thing it focuses on")
      if (e.xmk) {
        e.xmk.forEach(m => { if ((s.xmk || []).indexOf(m) < 0) why.push(`did not rule out ${m} (read ${JSON.stringify(s.xmk || [])}, markets ${JSON.stringify(s.markets || [])})`); });
        const bad = legs.find(p => e.xmk.indexOf(p.mkt) >= 0 || e.xmk.indexOf(p.kind) >= 0);
        if (bad) why.push(`a ruled-out market in the answer: ${bad.label}`);
      }
      if (e.exclude_player) {
        const nn = x => String(x || '').toLowerCase().replace(/[’'.]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
        const xp = nn(e.exclude_player);
        if (!(s.exclude || []).some(x => xp.indexOf(nn(x)) >= 0 || nn(x).indexOf(xp) >= 0)) why.push(`did not rule out ${e.exclude_player} (read ${JSON.stringify(s.exclude || [])})`);
        const bad = legs.find(p => nn(p.name || p.label).indexOf(xp) >= 0);
        if (bad) why.push(`the ruled-out player is in the answer: ${bad.label}`);
      }
      if (e.exclude_team) {
        const bad = legs.find(p => String(p.team || '').toUpperCase() === e.exclude_team || ((p.kind === 'spread' || p.kind === 'ml') && String(p.name || '').toUpperCase() === e.exclude_team));
        if (bad) why.push(`the ruled-out team is in the answer: ${bad.label}`);
      }
      // a named team's props are its own players (a same-game parlay keeps the whole game)
      if (s.team && !(s.teams || []).length && s.intent !== 'sgp' && !R.widened) {
        const bad = legs.find(p => p.kind === 'prop' && p.team && String(p.team).toUpperCase() !== String(s.team).toUpperCase() && !Object.values(s.tabbr || {}).some(v => (v || []).indexOf(String(p.team).toUpperCase()) >= 0));
        if (bad) why.push(`another team's player on a ${s.team} ask: ${bad.label} (${bad.team})`);
      }
      // a named team, player or same-game ask that comes back empty while the board has it
      const fut = B.filter(p => Date.parse(p.start) > Date.now() && (!(s.sports || []).length || s.sports.indexOf(p.sport) >= 0));
      const onTM = (p, T) => { const hay = ' ' + [p.team, p.matchup].join(' ').toUpperCase() + ' '; return T.some(x => new RegExp('[^A-Z]' + String(x).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^A-Z]').test(hay)); };   // team field and matchup, never a player named Duke
      const hasTeam = (s.tabbr || (s.teams || []).length || s.team) && !s.player && fut.some(p => { const T = teamsFor(s, p.sport); return T.length && onTM(p, T); });
      const hasPlayer = s.player && fut.some(p => String(p.name || p.label).toLowerCase().indexOf(String(s.player).toLowerCase()) >= 0);
      if (!legs.length && !R.clarify && !R.ambig && !R.depth && (hasTeam || hasPlayer)) why.push(`empty answer while the board has ${hasPlayer ? s.player : 'that team'}`);
      // an empty answer is a failure when today's boards have something that fits
      const want = (e.sports || s.sports || []).length ? (e.sports || s.sports) : null, wm = (e.markets || s.markets || []).length ? (e.markets || s.markets) : null;
      const exists = !e.team && !e.player && !s.team && !(s.teams || []).length && !s.player && !s.conf && !s.tabbr && !s.onyx_picks && !R.depth && !R.ambig && s.intent !== 'sgp' && avail(want, wm, s);   // an SGP needs it all in one game
      if (!legs.length && exists && !R.clarify) why.push('empty answer while the board has plays that fit');   // a question back (R.clarify) is an answer
      if (s.intent === 'parlay' && legs.length > 1 && R.parlay && R.parlay.price == null) why.push('parlay without a price');
      out.push({q: c.q, ok: !why.length, why, ms: Math.round(ms), n: legs.length, read: R.understood, via: R.via, spec: JSON.stringify(Object.assign({}, s, {summary: undefined}))});
    }
    return out;
  }, [C, PACE]);
  if (AI) console.log('answered by the AI:', res.filter(r => r.via === 'ai').length, 'of', res.length);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(res));
  const ok = res.filter(r => r.ok).length, ms = res.map(r => r.ms).sort((a, b) => a - b);
  console.log(`boards loaded in ${Math.round(load)} ms; ${res.length} queries, median ${ms[ms.length >> 1]} ms, slowest ${ms[ms.length - 1]} ms`);
  res.filter(r => !r.ok).forEach(r => console.log(`FAIL  ${r.q}\n      ${r.why.join(' | ')}\n      read: ${r.read}`));
  if (process.argv.includes('--slow')) res.slice().sort((a, b) => b.ms - a.ms).slice(0, 8).forEach(r => console.log('slow', r.ms, r.q));
  if (process.argv.includes('--show')) res.filter(r => r.ok).forEach(r => console.log(`ok    ${r.q}  (${r.n}) ${r.read}`));
  const pct = 100 * ok / res.length;
  console.log(`\n${ok}/${res.length} passed: ${pct.toFixed(1)}%`);
  await b.close(); srv.close();
  process.exit(pct >= 95 ? 0 : 1);
})();
