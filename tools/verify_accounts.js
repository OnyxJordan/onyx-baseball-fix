// verify_accounts.js - headless test of accounts.js and the My Onyx account card (dev only).
// Runs the real home page against a stand-in Supabase (auth + REST, each user sees only their own
// rows, like the row-level security in supabase/schema.sql), so it needs no project or keys.
//   1 off: accounts.json empty -> no card, no calls, the site exactly as before
//   2 sign in: the email form asks Supabase for a magic link
//   3 first sign-in on a device with picks, follows and bets: all of it reaches the account
//   4 a second device signs in with its own pick: both devices end with the union
//   5 a pick removed on one device leaves the account, then the other device
//   6 another person sees none of it
//   7 an expired session refreshes itself
//   8 sign out keeps the device's lists; delete account empties the account
//   node tools/verify_accounts.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

// ── the stand-in Supabase ──
const DB = { users: {}, tokens: {}, rows: {}, otp: [], refreshed: 0 };   // rows[user] = {table: {key: row}}
function user(email) { if (!DB.users[email]) DB.users[email] = { id: 'u-' + Object.keys(DB.users).length, email }; return DB.users[email]; }
function token(email, ttl) { const t = 't' + Math.random().toString(36).slice(2); DB.tokens[t] = { email, exp: Date.now() + (ttl || 3600) * 1000 }; return t; }
function rk(table, r) { return table === 'followed_players' ? r.sport + '|' + r.item_id : r.item_id; }
const sb = http.createServer((q, r) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'apikey,authorization,content-type,prefer', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  if (q.method === 'OPTIONS') { r.writeHead(204, cors); return r.end(); }
  let body = ''; q.on('data', d => body += d); q.on('end', () => {
    const u = new URL(q.url, 'http://x'), send = (code, j) => { r.writeHead(code, Object.assign({ 'content-type': 'application/json' }, cors)); r.end(j == null ? '' : JSON.stringify(j)); };
    if (q.headers.apikey !== 'anon-key') return send(401, { msg: 'no apikey' });
    const tok = String(q.headers.authorization || '').replace(/^Bearer /, ''), sess = DB.tokens[tok];
    if (u.pathname === '/auth/v1/settings') return send(200, {});
    if (u.pathname === '/auth/v1/otp') { DB.otp.push({ email: JSON.parse(body).email, redirect: u.searchParams.get('redirect_to') }); return send(200, {}); }
    if (u.pathname === '/auth/v1/token') { const b = JSON.parse(body); const e = b.refresh_token && b.refresh_token.split(':')[1]; if (!e) return send(400, {}); DB.refreshed++; return send(200, { access_token: token(e), refresh_token: 'r:' + e, expires_in: 3600 }); }
    if (!sess || sess.exp < Date.now()) return send(401, { msg: 'jwt expired' });
    const me = user(sess.email), mine = DB.rows[me.id] = DB.rows[me.id] || {};
    if (u.pathname === '/auth/v1/user') return send(200, { id: me.id, email: me.email });
    if (u.pathname === '/auth/v1/logout') return send(204);
    if (u.pathname === '/rest/v1/rpc/delete_me') { delete DB.rows[me.id]; return send(204); }
    const table = u.pathname.replace('/rest/v1/', ''), T = mine[table] = mine[table] || {};
    const sport = (u.searchParams.get('sport') || '').replace(/^eq\./, '');
    if (q.method === 'GET') return send(200, Object.values(T).filter(x => !sport || x.sport === sport).map(x => ({ item_id: x.item_id, data: x.data })));
    if (q.method === 'POST') { for (const x of JSON.parse(body)) { if (x.user_id !== me.id) return send(403, { msg: 'row-level security' }); T[rk(table, x)] = x; } return send(201); }
    if (q.method === 'PATCH') return send(204);
    if (q.method === 'DELETE') {
      const ids = (u.searchParams.get('item_id') || '').replace(/^in\.\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
      Object.keys(T).forEach(k => { if (ids.includes(T[k].item_id) && (!sport || T[k].sport === sport)) delete T[k]; });
      return send(204);
    }
    send(404, {});
  });
}).listen(0);
const SB = 'http://127.0.0.1:' + sb.address().port;

let CFG = { url: '', anon: '' };
const site = http.createServer((q, r) => {
  const p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (p.endsWith('accounts.json')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify(CFG)); }
  if (p.endsWith('ai.json')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end('{"url":""}'); }
  fs.readFile(p, (e, b) => { if (e) { r.statusCode = 404; return r.end(); } r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : p.endsWith('.css') ? 'text/css' : 'text/html' }); r.end(b); });
}).listen(0);
const BASE = 'http://127.0.0.1:' + site.address().port;

(async () => {
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const b = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
  const errs = [];
  async function device(local) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.route('**/*', rt => { const u = rt.request().url(); return u.startsWith(BASE) || u.startsWith(SB) ? rt.continue() : rt.abort(); });
    if (local) await pg.addInitScript(L => { if (!sessionStorage.getItem('seeded')) { for (const k in L) localStorage.setItem(k, JSON.stringify(L[k])); sessionStorage.setItem('seeded', '1'); } }, local);
    return pg;
  }
  const open = async (pg, hash) => { await pg.goto(BASE + '/home.html' + (hash || ''), { waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => window.OnyxAccounts); await pg.evaluate(() => OnyxAccounts.ready); await pg.waitForTimeout(400); };
  const settle = async pg => { await pg.evaluate(() => OnyxAccounts.sync()); await pg.waitForTimeout(200); };
  const ls = (pg, k) => pg.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k);
  const land = email => `#access_token=${token(email)}&refresh_token=r:${encodeURIComponent(email)}&expires_in=3600&token_type=bearer&type=magiclink`;
  const soon = new Date(Date.now() + 2 * 3600e3).toISOString();
  const pick = id => ({ id, sport: 'nfl', label: 'Pick ' + id, start: soon, kind: 'prop', mkt: 'rec', side: 'over', line: 4.5, price: -110, name: 'Player ' + id, saved: new Date().toISOString() });

  // 1 off
  let pg = await device();
  let calls = 0; pg.on('request', q => { if (q.url().startsWith(SB)) calls++; });
  await open(pg);
  ok(await pg.$eval('#acct', e => e.hidden), 'accounts off: no account card');
  ok(calls === 0, 'accounts off: no calls to Supabase');
  await pg.context().close();

  CFG = { url: SB, anon: 'anon-key' };
  // 2 sign in: the home header and My Onyx point to the Account page, which sends the link
  pg = await device();
  await open(pg);
  ok(!(await pg.$eval('#acct', e => e.hidden)) && /Sign in/.test(await pg.$eval('#acct', e => e.innerText)), 'signed out: My Onyx offers sign-in');
  ok(!(await pg.$eval('#acctNav', e => e.hidden)) && (await pg.$eval('#acctNav', e => e.textContent)) === 'Sign in', 'signed out: the home header has a Sign in link');
  await pg.click('#acct a.acct-go'); await pg.waitForURL(/account\.html/); await pg.waitForFunction(() => window.OnyxAccounts); await pg.evaluate(() => OnyxAccounts.ready); await pg.waitForTimeout(300);
  await pg.fill('#acEmail', 'jordan@example.com'); await pg.click('#acSend'); await pg.waitForTimeout(400);
  ok(DB.otp.length === 1 && DB.otp[0].email === 'jordan@example.com' && /account\.html$/.test(DB.otp[0].redirect), 'Account page: magic link requested, back to account.html');
  ok(/Link sent to jordan@example.com/.test(await pg.$eval('#acBody', e => e.innerText)), 'Account page: tells them the link is on its way');
  if (process.env.SHOT) await (await pg.$('main')).screenshot({path: path.join(process.env.SHOT, 'account_page_sent.png')});
  await pg.context().close();

  // 3 device A: first sign-in merges its lists into the account
  const A = await device({ onyxSaved: [pick('p1')], onyxFollow_nfl: [{ id: '4241', name: 'Travis Kelce', gid: '401' }], onyxNbaFollow: ['1628983'],
    onyxMyBets: [{ t: Date.now(), at: new Date().toISOString(), sport: 'nfl', key: 'sel-a', legs: [{ sel: 'sel-a' }], label: 'Kelce over' }] });
  await open(A, land('jordan@example.com')); await settle(A);
  const J = DB.users['jordan@example.com'].id, R = () => DB.rows[J] || {};
  ok(Object.keys(R().saved_picks || {}).join() === 'p1', 'device A: saved pick reached the account');
  ok(Object.keys(R().followed_players || {}).sort().join() === 'nba|1628983,nfl|4241', 'device A: followed players (NBA and NFL) reached the account');
  ok(Object.keys(R().bets || {}).join() === 'sel-a', 'device A: My bets reached the account');
  if (process.env.SHOT) await (await A.$('#acct')).screenshot({path: path.join(process.env.SHOT, 'acct_signed_in.png')});
  ok(/Signed in as jordan@example.com/.test(await A.$eval('#acct', e => e.innerText)) && !/access_token/.test(A.url()) && (await A.$eval('#acctNav', e => e.textContent)) === 'Account', 'device A: My Onyx and the header say signed in; the link tokens are cleared from the address');

  // 3b a link that lands on another page (Supabase's Site URL is the MLB front page) still signs in
  for (const pageName of ['index.html', 'nfl.html']) {
    const X = await device();
    await X.goto(BASE + '/' + pageName + land('jordan@example.com'), { waitUntil: 'domcontentloaded' });
    await X.waitForURL(/account\.html/, { timeout: 15000 }).catch(() => {});
    await X.waitForFunction(() => window.OnyxAccounts, null, { timeout: 15000 }).catch(() => {});
    if (/account\.html/.test(X.url())) { await X.evaluate(() => OnyxAccounts.ready); await X.waitForTimeout(500); }
    ok(/account\.html/.test(X.url()) && /jordan@example.com/.test(await X.$eval('#acBody', e => e.innerText).catch(() => '')), `a sign-in link landing on ${pageName} carries on to the Account page and signs in`);
    await X.context().close();
  }
  // 3c an expired or already-used link says so on the card
  const E = await device();
  await E.goto(BASE + '/account.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { waitUntil: 'domcontentloaded' });
  await E.evaluate(() => OnyxAccounts.ready); await E.waitForTimeout(300);
  ok(/expired or was already used/.test(await E.$eval('#acBody', e => e.innerText)), 'an expired link: the Account page says so and offers a new one');
  await E.context().close();

  // 4 device B with its own pick: both end with the union
  const B = await device({ onyxSaved: [pick('p2')] });
  await open(B, land('jordan@example.com')); await settle(B);
  ok((await ls(B, 'onyxSaved')).map(x => x.id).sort().join() === 'p1,p2', 'device B: has its own pick and device A\'s');
  ok((await ls(B, 'onyxFollow_nfl') || []).some(f => f.name === 'Travis Kelce') && (await ls(B, 'onyxNbaFollow') || []).includes('1628983'), 'device B: follows device A\'s players');
  await settle(A);
  ok((await ls(A, 'onyxSaved')).map(x => x.id).sort().join() === 'p1,p2', 'device A: picks up device B\'s pick');

  // 5 removal travels: A removes p1
  await A.evaluate(() => { const a = JSON.parse(localStorage.getItem('onyxSaved')); localStorage.setItem('onyxSaved', JSON.stringify(a.filter(x => x.id !== 'p1'))); });
  await A.waitForTimeout(2600);   // the 2 s debounce after a page edit
  ok(!(R().saved_picks || {}).p1, 'removal: device A\'s removal left the account (auto-sync after the edit)');
  await settle(B);
  ok((await ls(B, 'onyxSaved')).map(x => x.id).join() === 'p2', 'removal: device B drops it too');

  // 6 another person
  const C = await device({ onyxSaved: [pick('c1')] });
  await open(C, land('someone@example.com')); await settle(C);
  ok((await ls(C, 'onyxSaved')).map(x => x.id).join() === 'c1', 'privacy: another person sees none of Jordan\'s picks');
  ok(Object.keys(R().saved_picks || {}).join() === 'p2', 'privacy: and Jordan\'s account has none of theirs');

  // 7 an expired session refreshes itself
  const before = DB.refreshed;
  await A.evaluate(() => { const s = JSON.parse(localStorage.getItem('onyxSession')); s.expires_at = Date.now() - 1000; localStorage.setItem('onyxSession', JSON.stringify(s)); });
  await open(A); await settle(A);
  ok(DB.refreshed > before && /Signed in/.test(await A.$eval('#acct', e => e.innerText)), 'session: an expired session refreshes and stays signed in');

  // 8 sign out keeps the device's lists; delete account empties it
  await A.evaluate(() => OnyxAccounts.signOut()); await A.waitForTimeout(200);
  ok(!(await ls(A, 'onyxSession')) && (await ls(A, 'onyxSaved')).length === 1 && /Sign in/.test(await A.$eval('#acct', e => e.innerText)), 'sign out: signed out, this device keeps its picks');
  B.on('dialog', d => d.accept());
  await B.goto(BASE + '/account.html', { waitUntil: 'domcontentloaded' }); await B.evaluate(() => OnyxAccounts.ready); await B.waitForTimeout(400);
  const acTxt = await B.$eval('#acBody', e => e.innerText).catch(() => '');
  ok(/Signed in as/i.test(acTxt) && /Saved picks/i.test(acTxt), 'Account page: signed in, with what is synced' + (/Signed in as/i.test(acTxt) ? '' : ': ' + acTxt.replace(/\s+/g, ' ').slice(0, 160)));
  if (process.env.SHOT) await (await B.$('main')).screenshot({path: path.join(process.env.SHOT, 'account_page_in.png')});
  await B.click('#acDel'); await B.waitForTimeout(500);
  const left = DB.rows[J] || {};
  ok(!Object.values(left).some(t => Object.keys(t || {}).length) && !(await ls(B, 'onyxSession')), 'delete account: the account is emptied and the device signed out' + (Object.keys(left).length ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(left).map(([k, v]) => [k, Object.keys(v)]))) : ''));

  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  const wide = await (await device()).evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  ok(wide, 'no sideways scroll at 390px');
  await b.close(); sb.close(); site.close();
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
