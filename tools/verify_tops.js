// verify_tops.js - the sport page's model picks (data/<sport>/tops.json, daily_top.write_tops) must be the same
// plays Ask Onyx returns for the same request ("top 5 nfl spreads" ...), 11/14. Exits non-zero on any difference.
//   node tools/verify_tops.js
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.end(b); }); }).listen(0);
(async () => {
  const base0 = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch(), pg = await b.newPage();
  await pg.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith(base0 + '/ai.json')) return rt.fulfill({contentType: 'application/json', body: '{"url":""}'}); return u.startsWith(base0) ? rt.continue() : rt.abort(); });
  await pg.goto(base0 + '/home.html', {waitUntil: 'domcontentloaded'});
  const res = await pg.evaluate(async () => {
    const B = await OnyxAsk.loadBoards(), T = await (await fetch('data/nfl/tops.json')).json(), now = Date.now(), out = [];
    const Q = {ats: 'top 5 nfl spreads positive value only', totals: 'top 5 nfl totals positive value only', props: 'top 10 nfl player props no touchdowns positive value only', td: 'top 10 nfl anytime td scorers', td2: 'top 5 nfl 2+ td scorers'};   // 11/15: value lists; the TD lists stay most likely (information)
    for (const L of T.lists) {
      // lists Ask cannot phrase are checked against their own rule (11/15): every row the page shows must qualify,
      // in the list's order, and every qualifying play still to start must be in the 4x-deep candidates
      const RULE = {
        rec: {ok: r => r.kind === 'prop' && ['rec', 'pass_att', 'rush_yds'].includes(r.mkt) && r.side === 'under' && r.price >= -150 && r.price <= 150 && r.ev >= 0.10, key: r => -r.ev},
        tdlook: {ok: r => r.mkt === 'anytime_td' && r.role === 'RB' && r.tpg >= 15 && r.tt >= 24 && r.price >= -200, key: r => -(r.conf + (r.edge || 0) / 10)},
      };
      if (!Q[L.key]) {
        const R = RULE[L.key];
        if (!R) { out.push(L.key + ': no rule to check it against DIFF'); continue; }
        const bad = L.rows.filter(r => !R.ok(r));
        const sorted = L.rows.every((r, i) => i === 0 || R.key(L.rows[i - 1]) <= R.key(r) + 1e-9);
        const want = (await (await fetch('data/nfl/board.json')).json()).plays.filter(r => R.ok(r) && Date.parse(r.start) > now).length;
        const ok = !bad.length && sorted && L.rows.length === Math.min(want, 4 * L.n);
        out.push(L.key + ': rule check, ' + L.rows.length + ' candidates of ' + want + ' qualifying' + (bad.length ? ', ' + bad.length + ' break the rule' : '') + (sorted ? '' : ', out of order') + (ok ? ' SAME' : ' DIFF'));
        continue;
      }
      const games = {}, who = {}, page = [];
      for (const r of L.rows) { if (page.length >= L.n) break; const w = r.kind === 'prop' ? r.who : r.gid + ':' + r.kind;
        if (!(Date.parse(r.start) > now) || games[r.gid] || who[w]) continue; games[r.gid] = 1; who[w] = 1; page.push(r.sel); }
      const R = await OnyxAsk.ask(Q[L.key], OnyxAsk.localSpec(Q[L.key], B));
      const ask = (R.rows || []).map(r => r.sel);
      out.push(L.key + ': page ' + page.length + ' ask ' + ask.length + ' ' + (JSON.stringify(page) === JSON.stringify(ask) ? 'SAME' : 'DIFF\n   page ' + L.rows.filter(r => page.includes(r.sel)).map(r => r.label).join(' | ') + '\n   ask  ' + R.rows.map(r => r.label).join(' | ') + '\n   read ' + R.understood));
    }
    return out; });
  console.log(res.join('\n')); await b.close(); srv.close();
  if (res.some(x => !/ SAME$/.test(x))) { console.error('FAIL: the page lists and Ask Onyx disagree'); process.exit(1); }
  console.log('OK: page lists match Ask Onyx');
})();
