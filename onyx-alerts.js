// onyx-alerts.js - Price alerts and line moves (11/17, Jordan: "Price alerts + line moves").
// Line moves: every Onyx price in the quick bet card (onyx-tap.js) shows how it moved, open -> now: an arrow chip by
// the price, a mini sparkline and one plain sentence ("Moved from -110 to -125 since open (shorter: ...)"). Where the
// line opened: data/<sport>/opening.json when it has this bet (NFL, NBA and college football lanes), else the first
// price in data/<sport>/moves.json, the per-selection Onyx price path the build writes next to board.json
// (daily_top.keep_moves: [[utc minute, price, line], ...], a point only when the price or line changed).
// Price alerts: "Alert me at +150" from the card (10, 20 or 50 cents better than now, a stepper, or any line move),
// kept on this device (localStorage onyxPriceAlerts). While Onyx Sports is open it checks the sports' board.json every
// 3 minutes (every 10 for up to an hour in the background, nothing after); when the price gets there: a banner with one
// tap to the Onyx bet link or the parlay slip, and a phone notification when notifications are on. Closed-app alerts
// need a push service, and the copy says so. Every price here is Onyx's; no other book is named.
//   window.OnyxPriceAlerts = {open(), mountCard(card, play), list(), add(), remove(id), poll()}; OnyxAlerts.open() too
//   (alerts.js owns OnyxAlerts.mount, the push control center; this only adds open to it).
(function () {
  'use strict';
  if (window.OnyxPriceAlerts) return;
  var KEY = 'onyxPriceAlerts', PUSH = 'onyxPriceAlertsPush', REF = 'KR680261';
  var BOARDS = {nfl: 1, cfb: 1, nba: 1, cbb: 1, nhl: 1, tennis: 1}, OPENING = {nfl: 1, nba: 1, cfb: 1};
  var NAMES = {nfl: 'NFL', nba: 'NBA', cfb: 'College Football', cbb: 'College Basketball', nhl: 'NHL', tennis: 'Tennis'};
  var POLL_MS = 3 * 60e3, BG_MS = 10 * 60e3, BG_MAX = 60 * 60e3, MAX_ALERTS = 40;
  var COPY_WHERE = 'Works while Onyx Sports is open or in the background. With the app fully closed, alerts need a push service, which is not on yet.';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null || isNaN(a) ? '-' : (a > 0 ? '+' : '') + Math.round(a); }
  function share(sel) { return 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(sel) + '&referrer=' + REF; }
  // American odds on one straight scale in cents: -110 -> 90, -100 and +100 -> 100, +150 -> 150 (bigger pays more)
  function cents(a) { return a > 0 ? a : a + 200; }
  function fromCents(x) { x = Math.round(x); return x >= 100 ? x : x - 200; }
  function better(a, c) { return fromCents(cents(a) + c); }
  function reached(now, target) { return now != null && target != null && cents(now) >= cents(target); }
  function lnKey(x) { return x == null || x === '' ? '' : String(+x); }
  function toast(m) { try { if (window.OX_TOAST) window.OX_TOAST(m, {}); } catch (e) {} }
  function gt(name, o) { try { if (window.gtag) window.gtag('event', name, o || {}); } catch (e) {} }
  function clock(t) { try { return new Date(t).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}).replace(',', '') + ' ET'; } catch (e) { return ''; } }
  function lineText(p, line) {
    if (line == null || line === '') return '';
    if (p.kind === 'spread') { var h = -(+line); return (h > 0 ? '+' : '') + h; }
    return String(+line);
  }
  function betKey(p) { return [p.gid, p.mkt, p.who || p.name, p.side].join('|'); }

  // ── storage ───────────────────────────────────────────────────────────────────────────────
  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a.slice(-MAX_ALERTS))); } catch (e) {} changed(); }
  function activeFor(sel) { return load().filter(function (a) { return a.st === 'on' && a.sel === sel; })[0] || null; }
  function snap(p) {
    var o = {};
    ['sport', 'sel', 'label', 'matchup', 'start', 'gid', 'kind', 'mkt', 'side', 'line', 'name', 'who', 'team', 'conf', 'tag'].forEach(function (k) { if (p[k] != null) o[k] = p[k]; });
    return o;
  }
  function add(p, o) {
    if (!p || !p.sel || !BOARDS[p.sport] || p.price == null) return null;
    var A = load().filter(function (a) { return !(a.st === 'on' && a.sel === p.sel); });
    var a = {id: 'pa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sel: p.sel, sport: p.sport, key: betKey(p),
             kind: o.line ? 'line' : 'price', target: o.line ? null : o.target, price0: p.price, line0: p.line == null ? null : p.line,
             start: p.start || null, play: snap(p), st: 'on', t: Date.now()};
    A.push(a); save(A);
    gt('price_alert_set', {sport: p.sport, kind: a.kind});
    schedule(true);
    return a;
  }
  function remove(id) { save(load().filter(function (a) { return a.id !== id; })); }

  // ── data: boards, the per-selection price path, the opening lines ─────────────────────────
  function getJSON(u, fresh) { return fetch(u, fresh ? {cache: 'no-store'} : {}).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  var MOVES = {}, OPEN = {};
  function moves(k, fresh) { if (fresh || !MOVES[k]) MOVES[k] = getJSON('data/' + k + '/moves.json', fresh); return MOVES[k]; }
  function opening(k) { if (!OPENING[k]) return Promise.resolve(null); if (!OPEN[k]) OPEN[k] = getJSON('data/' + k + '/opening.json'); return OPEN[k]; }
  function nm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  // the opening line for this exact bet, when the sport's opening.json has it -> {price, line, t}
  function openFor(p, O) {
    if (!O || !p.gid) return null;
    var r = null, price = null;
    if (p.sport === 'nfl' && p.name) { r = O[p.gid + '|' + nm(p.name) + '|' + p.mkt]; if (r) price = p.side === 'under' ? r.under : r.over; }
    else if (p.sport === 'cfb') { r = O[p.gid + '|' + p.mkt + '|' + p.side]; if (r) price = r.price; }
    else if (p.sport === 'nba' && O[p.mkt] && typeof O[p.mkt] === 'object') { r = O[p.mkt][p.gid + '|' + p.who]; if (r) price = p.side === 'under' ? r.under : (r.over != null ? r.over : r.yes); }
    if (!r || price == null || isNaN(+price)) return null;
    return {price: +price, line: r.line != null ? r.line : p.line, t: Date.parse(r.ts) || null, src: 'open'};
  }
  // -> {from, now, pts: [{t, price, line}], src: 'open' | 'seen'} or null (no history for this price yet)
  function moveOf(p) {
    if (!p || !p.sel || !BOARDS[p.sport] || p.price == null) return Promise.resolve(null);
    return Promise.all([moves(p.sport), opening(p.sport)]).then(function (x) {
      var M = x[0], h = M && M.sel && Array.isArray(M.sel[p.sel]) ? M.sel[p.sel] : [];
      var pts = h.map(function (q) { return {t: Date.parse(q[0]) || null, price: +q[1], line: q[2]}; }).filter(function (q) { return !isNaN(q.price); });
      var op = openFor(p, x[1]);
      if (op && (!pts.length || !op.t || !pts[0].t || op.t <= pts[0].t)) pts.unshift(op);
      if (!pts.length) return null;
      var now = {t: Date.now(), price: +p.price, line: p.line == null ? pts[pts.length - 1].line : p.line};
      var last = pts[pts.length - 1];
      if (last.price !== now.price || lnKey(last.line) !== lnKey(now.line)) pts.push(now);
      return {from: pts[0], now: now, pts: pts, src: pts[0].src === 'open' ? 'open' : 'seen'};
    });
  }
  function moveWords(p, m) {
    var since = m.src === 'open' ? 'since open' : 'since first seen' + (m.from.t ? ' ' + clock(m.from.t) : '');
    var d = cents(m.now.price) - cents(m.from.price), lc = lnKey(m.from.line) !== lnKey(m.now.line) && p.kind !== 'ml';
    var lw = lc ? 'Line moved from ' + lineText(p, m.from.line) + ' to ' + lineText(p, m.now.line) + ' ' + since + ', price ' + odds(m.from.price) + ' to ' + odds(m.now.price) + '.' : '';
    if (lc) return lw;
    if (!d) return 'Holding at ' + odds(m.now.price) + ' ' + since + '.';
    return 'Moved from ' + odds(m.from.price) + ' to ' + odds(m.now.price) + ' ' + since + (d < 0 ? ' (shorter: the market moved toward this side).' : ' (longer: it pays more now than at open).');
  }
  function chip(m) {
    var d = cents(m.now.price) - cents(m.from.price);
    if (!d) return '<span class="oxa-ch eq" title="No price move since open">&#9644; 0</span>';
    return '<span class="oxa-ch ' + (d > 0 ? 'up' : 'dn') + '" title="' + esc('Onyx price moved ' + Math.abs(d) + ' cents ' + (m.src === 'open' ? 'since open' : 'since first seen') + ', from ' + odds(m.from.price)) + '">'
      + (d > 0 ? '&#9650; ' : '&#9660; ') + Math.abs(d) + '</span>';
  }
  function spark(m) {
    var P = m.pts, n = P.length;
    if (n < 2) return '';
    var ys = P.map(function (q) { return cents(q.price); }), lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), span = Math.max(hi - lo, 4);
    var W = 200, H = 36, pad = 4;
    var xy = ys.map(function (y, i) { return [Math.round((pad + (W - 2 * pad) * i / (n - 1)) * 10) / 10, Math.round((H - pad - (H - 2 * pad) * (y - lo) / span) * 10) / 10]; });
    var d = cents(m.now.price) - cents(m.from.price), col = d > 0 ? '#61e970' : d < 0 ? '#d795ff' : '#9a93a6';
    return '<svg class="oxa-sp" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc('Onyx price path: ' + P.map(function (q) { return odds(q.price); }).join(', ')) + '">'
      + '<polyline fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="' + xy.map(function (q) { return q.join(','); }).join(' ') + '"/>'
      + '<circle cx="' + xy[0][0] + '" cy="' + xy[0][1] + '" r="2.6" fill="#9a93a6"/><circle cx="' + xy[n - 1][0] + '" cy="' + xy[n - 1][1] + '" r="3" fill="' + col + '"/></svg>';
  }

  // ── styles ────────────────────────────────────────────────────────────────────────────────
  var CSS = [
    '.oxa-ch{display:inline-block;vertical-align:middle;margin-left:6px;padding:2px 6px;border-radius:999px;font:800 10px/1.3 monospace;letter-spacing:0;white-space:nowrap}',
    '.oxa-ch.up{background:rgba(97,233,112,.14);color:#61e970}.oxa-ch.dn{background:rgba(176,56,249,.22);color:#d795ff}.oxa-ch.eq{background:rgba(255,255,255,.08);color:#9a93a6}',
    '.oxt-mv{margin:-2px 0 12px;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}',
    '.oxt-mv[hidden],.oxt-pa[hidden]{display:none}',
    '.oxt-n .oxt-pc{display:block;line-height:1}.oxt-n .oxt-pc .oxa-ch{margin:5px 0 0}',
    '.oxt-mv p{margin:0;font:600 12px/1.45 system-ui,-apple-system,sans-serif;color:#d8d1e3}',
    '.oxt-mv small{display:block;font:700 9px/1.3 monospace;letter-spacing:.08em;text-transform:uppercase;color:#8f879c;margin-bottom:3px}',
    '.oxa-sp{display:block;width:100%;height:34px;margin:4px 0 6px}',
    '.oxt-pa{margin:10px 0 0;padding:10px;border-radius:12px;border:1px solid rgba(176,56,249,.35);background:rgba(176,56,249,.07)}',
    '.oxt-pa .h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}',
    '.oxt-pa .h b{font:800 12px monospace;letter-spacing:.06em;text-transform:uppercase;color:#d795ff}',
    '.oxt-pa .h button{background:none;border:0;color:#cfc8da;font:700 11.5px system-ui,sans-serif;text-decoration:underline;cursor:pointer;padding:4px}',
    '.oxt-pa .r{display:flex;align-items:center;gap:6px}',
    '.oxt-pa .r button.st{flex:none;width:38px;height:38px;border-radius:11px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;font:800 18px/1 system-ui,sans-serif;cursor:pointer}',
    '.oxt-pa output{flex:none;min-width:58px;text-align:center;font:800 17px monospace;color:#fff}',
    '.oxt-pa .go{flex:1;min-height:38px;border-radius:11px;border:1px solid rgba(176,56,249,.8);background:rgba(176,56,249,.28);color:#fff;font:800 12.5px system-ui,sans-serif;cursor:pointer;padding:4px 8px}',
    '.oxt-pa .q{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.oxt-pa .q button{font:700 11px monospace;color:#ddd;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:7px 10px;cursor:pointer}',
    '.oxt-pa .q button.on{background:rgba(176,56,249,.3);border-color:rgba(176,56,249,.7);color:#fff}',
    '.oxt-pa .set{margin:0;font:600 12.5px/1.45 system-ui,sans-serif;color:#eee9f5}.oxt-pa .set b{color:#61e970}',
    '.oxt-pa .set button{margin-left:6px;background:none;border:0;color:#ff8a8a;font:700 12px system-ui,sans-serif;text-decoration:underline;cursor:pointer;padding:2px}',
    '.oxt-pa .n{margin:8px 0 0;font:600 10.5px/1.45 monospace;color:#8f879c}',
    '.oxt-pa button:focus-visible,#oxPa button:focus-visible,#oxPa a:focus-visible,#oxPaHit a:focus-visible,#oxPaHit button:focus-visible{outline:2px solid #d795ff;outline-offset:2px}',
    // the alerts sheet
    '#oxPa{position:fixed;inset:0;z-index:10090}#oxPa[hidden]{display:none}',
    '#oxPa .bg{position:absolute;inset:0;background:rgba(6,4,10,.6)}',
    '#oxPa .c{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:min(100%,520px);max-height:min(88vh,calc(100vh - var(--sat,0px) - 24px));overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;background:#141119;color:#eee9f5;border:1.5px solid rgba(176,56,249,.55);border-bottom:0;border-radius:20px 20px 0 0;padding:14px 16px calc(16px + var(--sab,0px));font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 -18px 50px rgba(0,0,0,.6)}',
    '@media (min-width:720px){#oxPa .c{top:50%;bottom:auto;transform:translate(-50%,-50%);border-bottom:1.5px solid rgba(176,56,249,.55);border-radius:18px;max-height:calc(100vh - 48px)}}',
    '#oxPa h2{margin:0 44px 4px 0;font:800 19px/1.25 system-ui,sans-serif;color:#fff}',
    '#oxPa .x{position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:18px;border:0;background:rgba(255,255,255,.07);color:#cfc8da;font:400 22px/1 system-ui,sans-serif;cursor:pointer}',
    '#oxPa .sub{margin:0 0 10px;color:#a9a2b6;font-size:12.5px}',
    '#oxPa .nt{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);margin-bottom:12px;font-size:13px}',
    '#oxPa .nt button{flex:none;font:700 12px system-ui,sans-serif;color:#fff;background:rgba(176,56,249,.3);border:1px solid rgba(176,56,249,.7);border-radius:999px;padding:7px 12px;cursor:pointer}',
    '#oxPa .it{padding:11px 12px;border-radius:13px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);margin-bottom:8px}',
    '#oxPa .it.hit{border-color:rgba(97,233,112,.55);background:rgba(97,233,112,.06)}#oxPa .it.old{opacity:.6}',
    '#oxPa .it b{display:block;color:#fff;font-size:14px}#oxPa .it .m{font:600 11px/1.4 monospace;color:#9a93a6;margin:2px 0 6px}',
    '#oxPa .it .s{font-size:12.5px;color:#d8d1e3}#oxPa .it .s em{font-style:normal;color:#61e970;font-weight:800}',
    '#oxPa .it .a{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}',
    '#oxPa .it .a a,#oxPa .it .a button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:4px 12px;border-radius:11px;font:700 12.5px system-ui,sans-serif;cursor:pointer;text-decoration:none;box-sizing:border-box}',
    '#oxPa .it .a a{background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff;border:0}',
    '#oxPa .it .a button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#eee9f5}',
    '#oxPa .it .a button.rm{color:#ff8a8a}',
    '#oxPa .none{padding:18px 12px;text-align:center;color:#a9a2b6;font-size:13px;border:1px dashed rgba(255,255,255,.14);border-radius:13px}',
    '#oxPa .ft{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;font:600 10.5px/1.45 monospace;color:#7f7889}',
    '#oxPa .ft button{flex:none;background:none;border:0;color:#cfc8da;text-decoration:underline;font:700 11.5px system-ui,sans-serif;cursor:pointer}',
    // the fired alert banner
    '#oxPaHit{position:fixed;left:50%;top:calc(10px + var(--sat,0px));transform:translateX(-50%);z-index:10100;width:min(calc(100% - 24px),440px);display:grid;gap:8px}',
    '#oxPaHit .b{position:relative;box-sizing:border-box;padding:12px 44px 12px 14px;border-radius:15px;background:#16121c;border:1.5px solid rgba(97,233,112,.7);box-shadow:0 14px 40px rgba(0,0,0,.65);color:#eee9f5;font:13px/1.45 system-ui,-apple-system,sans-serif;animation:oxpaIn .22s ease-out}',
    '#oxPaHit .k{font:800 10px/1 monospace;letter-spacing:.12em;text-transform:uppercase;color:#61e970;margin-bottom:5px}',
    '#oxPaHit .b b{color:#fff}#oxPaHit .b p{margin:2px 0 0;color:#a9a2b6;font-size:12px}',
    '#oxPaHit .a{display:flex;gap:8px;margin-top:9px}',
    '#oxPaHit .a a,#oxPaHit .a button{flex:1;display:flex;align-items:center;justify-content:center;min-height:40px;border-radius:11px;font:800 12.5px system-ui,sans-serif;cursor:pointer;text-decoration:none;box-sizing:border-box;padding:4px 8px}',
    '#oxPaHit .a a{background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff;border:0}',
    '#oxPaHit .a button{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#eee9f5}',
    '#oxPaHit .x{position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:16px;border:0;background:rgba(255,255,255,.07);color:#cfc8da;font:400 20px/1 system-ui,sans-serif;cursor:pointer}',
    '@keyframes oxpaIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion: reduce){#oxPaHit .b{animation:none}}'
  ].join('\n');
  var styled = false;
  function style() { if (styled) return; styled = true; var s = document.createElement('style'); s.id = 'onyx-alerts'; s.textContent = CSS; document.head.appendChild(s); }

  // ── the quick bet card: the move and the alert controls (onyx-tap.js leaves the slots) ───────
  // card: the card element; p: the play it shows. Safe to call on every render.
  function mountCard(card, p) {
    style();
    var mv = card.querySelector('[data-pa-move]'), ch = card.querySelector('[data-pa-chip]'), pa = card.querySelector('[data-pa-alert]');
    var ok = p && p.sel && BOARDS[p.sport] && p.price != null;
    if (mv) mv.hidden = true;
    if (pa) { pa.hidden = !ok; if (ok) alertBlock(pa, p, null); }
    if (!ok) return;
    moveOf(p).then(function (m) {
      if (!card.isConnected || card.getAttribute('data-pa-sel') !== p.sel) return;
      if (!m) return;
      if (ch) ch.innerHTML = chip(m);
      if (mv) { mv.innerHTML = '<small>Onyx line move</small>' + spark(m) + '<p>' + esc(moveWords(p, m)) + '</p>'; mv.hidden = false; }
    });
  }
  function pushState() {
    if (typeof Notification === 'undefined') return 'none';
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission === 'granted') { var off = false; try { off = localStorage.getItem(PUSH) === '0'; } catch (e) {} return off ? 'off' : 'on'; }
    return 'ask';
  }
  function askPush() {
    if (typeof Notification === 'undefined') { toast('This browser cannot send alerts. Add Onyx Sports to your home screen to get them'); return Promise.resolve(false); }
    return Promise.resolve(Notification.requestPermission()).then(function (perm) {
      if (perm === 'granted') { try { localStorage.setItem(PUSH, '1'); } catch (e) {} return true; }
      toast('Notifications are blocked for Onyx in your settings. Alerts still show while the app is open'); return false;
    }).catch(function () { return false; });
  }
  function alertBlock(el, p, st) {
    var cur = activeFor(p.sel), n = load().filter(function (a) { return a.st === 'on'; }).length;
    st = st || el._pa || {target: better(p.price, 10), mode: 10};
    el._pa = st;
    var h = '<div class="h"><b>Price alert</b><button type="button" data-pa="manage">My alerts' + (n ? ' (' + n + ')' : '') + '</button></div>';
    if (cur) {
      h += '<p class="set">' + (cur.kind === 'line' ? 'Alert set: we will tell you when this line moves off ' + esc(lineText(p, cur.line0) || odds(cur.price0)) + '.'
        : 'Alert set: we will tell you at <b>' + esc(odds(cur.target)) + '</b> or better (now ' + esc(odds(p.price)) + ').') + '<button type="button" data-pa="rm">Remove</button></p>';
    } else {
      var lineOk = p.line != null && p.kind !== 'ml';
      h += '<div class="r"><button type="button" class="st" data-pa="dn" aria-label="Lower the alert price">&minus;</button><output aria-live="polite">' + esc(st.mode === 'line' ? 'Line' : odds(st.target)) + '</output>'
        + '<button type="button" class="st" data-pa="up" aria-label="Raise the alert price">+</button>'
        + '<button type="button" class="go" data-pa="set">' + (st.mode === 'line' ? 'Alert me if the line moves' : 'Alert me at ' + esc(odds(st.target))) + '</button></div>'
        + '<div class="q" role="group" aria-label="Quick alert prices">' + [10, 20, 50].map(function (c) {
          return '<button type="button" data-pa="q" data-c="' + c + '" class="' + (st.mode === c ? 'on' : '') + '">' + c + '&cent; better (' + esc(odds(better(p.price, c))) + ')</button>'; }).join('')
        + (lineOk ? '<button type="button" data-pa="line" class="' + (st.mode === 'line' ? 'on' : '') + '">Any line move</button>' : '') + '</div>';
    }
    h += '<p class="n">' + esc(COPY_WHERE) + '</p>';
    el.innerHTML = h;
    el.onclick = function (e) {
      var b = e.target.closest('[data-pa]'); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var a = b.getAttribute('data-pa'), min = better(p.price, 5);
      if (a === 'manage') { if (window.OnyxTap && OnyxTap.close) OnyxTap.close(); open(); return; }
      if (a === 'rm') { if (cur) remove(cur.id); alertBlock(el, p, null); toast('Alert removed'); return; }
      if (a === 'q') { st.mode = +b.getAttribute('data-c'); st.target = better(p.price, st.mode); }
      else if (a === 'line') { st.mode = 'line'; }
      else if (a === 'up') { st.target = st.mode === 'line' ? better(p.price, 10) : fromCents(cents(st.target) + 5); st.mode = 'step'; }
      else if (a === 'dn') { st.target = st.mode === 'line' ? better(p.price, 10) : fromCents(Math.max(cents(min), cents(st.target) - 5)); st.mode = 'step'; }
      else if (a === 'set') {
        var made = add(p, st.mode === 'line' ? {line: true} : {target: st.target});
        if (!made) return;
        var msg = made.kind === 'line' ? 'Alert set: we will tell you when ' + (p.label || 'this line') + ' moves' : 'Alert set: we will tell you if ' + (p.label || 'this bet') + ' reaches ' + odds(made.target) + ' on Onyx';
        toast(msg);
        if (pushState() === 'ask') askPush().then(function () { alertBlock(el, p, null); });
        el._pa = null; alertBlock(el, p, null); return;
      }
      alertBlock(el, p, st);
    };
  }

  // ── the alerts sheet: OnyxAlerts.open() ───────────────────────────────────────────────────
  var SHEET = null, LAST_FOCUS = null, SEEN = {};
  function open() {
    style();
    if (!SHEET) {
      SHEET = document.createElement('div'); SHEET.id = 'oxPa'; SHEET.hidden = true; SHEET.setAttribute('data-no-tap', '');
      SHEET.innerHTML = '<div class="bg" data-pax="1"></div><div class="c" role="dialog" aria-modal="true" aria-labelledby="oxPaT" tabindex="-1"></div>';
      document.body.appendChild(SHEET);
      SHEET.addEventListener('click', onSheet);
      SHEET.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); } });
    }
    if (SHEET.hidden) LAST_FOCUS = document.activeElement;
    drawSheet();
    SHEET.hidden = false;
    var c = SHEET.querySelector('.c'); try { c.focus({preventScroll: true}); } catch (e) {}
    gt('price_alerts_open', {});
    if (load().some(function (a) { return a.st === 'on'; })) poll();
  }
  function closeSheet() {
    if (!SHEET || SHEET.hidden) return;
    SHEET.hidden = true;
    var f = LAST_FOCUS; LAST_FOCUS = null;
    if (f && f.focus && document.contains(f)) { try { f.focus({preventScroll: true}); } catch (e) {} }
  }
  function playOf(a) { var h = a.hit || {}; return Object.assign({}, a.play, {sel: h.sel || a.sel, price: h.price != null ? h.price : a.price0, line: h.line !== undefined ? h.line : a.line0}); }
  function onSlip(sel) { try { return !!(window.OnyxParlay && OnyxParlay.slip().some(function (x) { return x.sel === sel; })); } catch (e) { return false; } }
  function slipAdd(a, btn) {
    if (!window.OnyxParlay) return;
    var p = playOf(a);
    if (!onSlip(p.sel)) OnyxParlay.add(p);
    if (btn) { btn.textContent = onSlip(p.sel) ? 'On parlay slip' : '+ Parlay slip'; }
  }
  function drawSheet() {
    if (!SHEET || SHEET.hidden && arguments[0] === 'ifOpen') return;
    var A = load().slice().reverse(), on = A.filter(function (a) { return a.st === 'on'; }), hit = A.filter(function (a) { return a.st === 'hit'; }), old = A.filter(function (a) { return a.st === 'gone'; });
    var ps = pushState();
    var nt = ps === 'on' ? '<span>Phone notifications are on for price alerts.</span><button type="button" data-pa="poff">Turn off</button>'
      : ps === 'off' ? '<span>Phone notifications are off for price alerts. The banner still shows in the app.</span><button type="button" data-pa="pon">Turn on</button>'
      : ps === 'ask' ? '<span>Get a phone notification when an alert hits.</span><button type="button" data-pa="pon">Turn on</button>'
      : ps === 'blocked' ? '<span>Notifications are blocked for Onyx in your settings. Alerts show as a banner in the app.</span>'
      : '<span>This browser cannot send notifications. Add Onyx Sports to your home screen to get them.</span>';
    var item = function (a) {
      var p = a.play || {}, s = SEEN[a.sel], meta = [NAMES[a.sport] || '', p.matchup, p.start ? clock(Date.parse(p.start)) : ''].filter(Boolean).join(' · ');
      var want = a.kind === 'line' ? 'when the line moves off ' + (lineText(p, a.line0) || odds(a.price0)) : 'at ' + odds(a.target) + ' or better';
      var body = '', acts = '';
      if (a.st === 'hit') {
        var h = a.hit || {};
        body = '<em>Hit ' + esc(odds(h.price)) + '</em>' + (a.kind === 'line' && h.line != null ? ', line now ' + esc(lineText(p, h.line)) : '') + ' at ' + esc(clock(h.t)) + '. You asked ' + esc(want) + '.';
        acts = '<a href="' + esc(share(h.sel || a.sel)) + '" target="_blank" rel="noopener" data-pa="bet" data-id="' + a.id + '">Bet on Onyx &middot; ' + esc(odds(h.price)) + '</a>'
          + (window.OnyxParlay ? '<button type="button" data-pa="slip" data-id="' + a.id + '">' + (onSlip(h.sel || a.sel) ? 'On parlay slip' : '+ Parlay slip') + '</button>' : '')
          + '<button type="button" class="rm" data-pa="del" data-id="' + a.id + '">Remove</button>';
      } else if (a.st === 'gone') {
        body = 'The game started before it got there. You asked ' + esc(want) + '.';
        acts = '<button type="button" class="rm" data-pa="del" data-id="' + a.id + '">Remove</button>';
      } else {
        body = 'Tell me ' + esc(want) + '. Set at ' + esc(odds(a.price0)) + (s ? ', now <b style="display:inline;color:#d795ff">' + esc(odds(s.price)) + '</b>' + (s.missing ? ' (off the board right now)' : '') : '') + '.';
        acts = '<a href="' + esc(share(a.sel)) + '" target="_blank" rel="noopener" data-pa="bet" data-id="' + a.id + '">Bet on Onyx now</a>'
          + '<button type="button" class="rm" data-pa="del" data-id="' + a.id + '">Remove</button>';
      }
      return '<div class="it ' + (a.st === 'hit' ? 'hit' : a.st === 'gone' ? 'old' : '') + '"><b>' + esc(p.label || 'Onyx price') + '</b><div class="m">' + esc(meta) + '</div><div class="s">' + body + '</div><div class="a">' + acts + '</div></div>';
    };
    var h = '<button type="button" class="x" data-pax="1" aria-label="Close">&times;</button><h2 id="oxPaT">Price alerts</h2>'
      + '<p class="sub">Tap any Onyx price, then set the price you want. We check Onyx\'s board every few minutes.</p>'
      + '<div class="nt">' + nt + '</div>'
      + (A.length ? hit.concat(on, old).map(item).join('') : '<div class="none">No price alerts yet. Tap any Onyx price and choose Alert me.</div>')
      + '<div class="ft"><span>' + esc(COPY_WHERE) + '</span>' + (hit.length + old.length ? '<button type="button" data-pa="clear">Clear finished</button>' : '') + '</div>';
    SHEET.querySelector('.c').innerHTML = h;
  }
  function onSheet(e) {
    var t = e.target;
    if (t.closest('[data-pax]')) { e.preventDefault(); closeSheet(); return; }
    var b = t.closest('[data-pa]'); if (!b) return;
    var a = b.getAttribute('data-pa'), id = b.getAttribute('data-id'), al = load().filter(function (x) { return x.id === id; })[0];
    if (a === 'bet') { gt('onyx_click', {link_type: 'price_alert', sport: al ? al.sport : ''}); return; }
    e.preventDefault();
    if (a === 'del') { remove(id); drawSheet(); }
    else if (a === 'slip' && al) slipAdd(al, b);
    else if (a === 'clear') { save(load().filter(function (x) { return x.st === 'on'; })); drawSheet(); }
    else if (a === 'pon') askPush().then(drawSheet);
    else if (a === 'poff') { try { localStorage.setItem(PUSH, '0'); } catch (x) {} drawSheet(); }
  }

  // ── the watcher ───────────────────────────────────────────────────────────────────────────
  var timer = null, lastPoll = 0, hiddenAt = 0, busy = null, SHOWN = {};
  function schedule(soon) {
    clearTimeout(timer); timer = null;
    if (!load().some(function (a) { return a.st === 'on'; })) return;
    if (document.hidden && hiddenAt && Date.now() - hiddenAt > BG_MAX) return;            // an hour in the background: stop until it is back
    var ms = soon ? 1500 : document.hidden ? BG_MS : POLL_MS;
    timer = setTimeout(function () { poll().then(function () { schedule(); }, function () { schedule(); }); }, ms);
  }
  function poll() {
    if (busy) return busy;
    var A = load().filter(function (a) { return a.st === 'on'; });
    if (!A.length) return Promise.resolve([]);
    var ks = {}; A.forEach(function (a) { ks[a.sport] = 1; });
    busy = Promise.all(Object.keys(ks).map(function (k) { return getJSON('data/' + k + '/board.json', true).then(function (b) { return [k, b]; }); })).then(function (bs) {
      var bySel = {}, byKey = {}, got = {};
      bs.forEach(function (x) { if (!x[1]) return; got[x[0]] = 1; (x[1].plays || []).forEach(function (p) { if (!p || !p.sel || p.price == null) return; bySel[p.sel] = p; var k = betKey(p); if (!byKey[k]) byKey[k] = []; byKey[k].push(p); }); });
      Object.keys(ks).forEach(function (k) { if (got[k]) MOVES[k] = null; });                 // the card re-reads the price path
      var fired = [], now = Date.now();
      // read-modify-write on the freshest list, so two open tabs fire an alert once
      var L = load(), dirty = false;
      L.forEach(function (a) {
        if (a.st !== 'on' || !got[a.sport]) return;
        var row = bySel[a.sel], hitRow = null;
        if (row) SEEN[a.sel] = {price: row.price, line: row.line, t: now}; else if (SEEN[a.sel]) SEEN[a.sel].missing = true;
        if (a.kind === 'line') {
          if (row && lnKey(row.line) !== lnKey(a.line0)) hitRow = row;
          else if (!row) hitRow = (byKey[a.key] || []).filter(function (p) { return lnKey(p.line) !== lnKey(a.line0); })[0] || null;
        } else if (row && lnKey(row.line) === lnKey(a.line0) && reached(row.price, a.target)) hitRow = row;
        if (hitRow) { a.st = 'hit'; a.hit = {price: hitRow.price, line: hitRow.line == null ? null : hitRow.line, sel: hitRow.sel, t: now}; dirty = true; fired.push(a); }
        else if (!row && a.start && Date.parse(a.start) <= now) { a.st = 'gone'; dirty = true; }
      });
      if (dirty) save(L);
      lastPoll = now;
      fired.forEach(fire);
      drawSheet('ifOpen');
      return fired;
    }).catch(function () { return []; }).then(function (r) { busy = null; return r; });
    return busy;
  }
  function fire(a) {
    if (SHOWN[a.id]) return; SHOWN[a.id] = 1;
    var p = a.play || {}, h = a.hit, want = a.kind === 'line' ? 'any line move' : odds(a.target) + ' or better';
    var head = a.kind === 'line' ? (p.label || 'Your line') + ' moved: ' + (h.line != null ? lineText(p, h.line) + ' at ' : '') + odds(h.price) + ' on Onyx' : (p.label || 'Your bet') + ' hit ' + odds(h.price) + ' on Onyx';
    gt('price_alert_hit', {sport: a.sport, kind: a.kind});
    style();
    var box = document.getElementById('oxPaHit');
    if (!box) { box = document.createElement('div'); box.id = 'oxPaHit'; box.setAttribute('data-no-tap', ''); box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'assertive'); document.body.appendChild(box); }
    var b = document.createElement('div'); b.className = 'b'; b.setAttribute('data-pa-hit', a.id);
    b.innerHTML = '<div class="k">Price alert &middot; ' + esc(NAMES[a.sport] || '') + '</div><b>' + esc(head) + '</b>'
      + '<p>You asked for ' + esc(want) + '. It was ' + esc(odds(a.price0)) + ' when you set it. Prices move, so check it on Onyx.</p>'
      + '<div class="a"><a href="' + esc(share(h.sel || a.sel)) + '" target="_blank" rel="noopener" data-pa-bet>Bet on Onyx &middot; ' + esc(odds(h.price)) + '</a>'
      + (window.OnyxParlay ? '<button type="button" data-pa-slip>' + (onSlip(h.sel || a.sel) ? 'On parlay slip' : '+ Parlay slip') + '</button>' : '') + '</div>'
      + '<button type="button" class="x" aria-label="Dismiss" data-pa-x>&times;</button>';
    b.addEventListener('click', function (e) {
      if (e.target.closest('[data-pa-x]')) { b.remove(); return; }
      if (e.target.closest('[data-pa-bet]')) { gt('onyx_click', {link_type: 'price_alert_hit', sport: a.sport}); setTimeout(function () { b.remove(); }, 80); return; }
      var s = e.target.closest('[data-pa-slip]'); if (s) { slipAdd(a, s); }
    });
    box.appendChild(b);
    while (box.children.length > 2) box.firstChild.remove();
    notify(a, head);
  }
  function notify(a, head) {
    if (pushState() !== 'on') return;
    var title = 'Onyx price alert', opts = {body: head + '. Tap to see it.', tag: 'onyx-win-pa-' + a.id, icon: 'icon-192.png', badge: 'icon-192.png', data: {url: 'home.html?oxpa=1'}};
    // the tag rides sw.js's existing notificationclick (tags onyx-win-*), which opens data.url: the alerts sheet
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (r) { if (r && r.showNotification) r.showNotification(title, opts); else new Notification(title, opts); })
          .catch(function () { try { new Notification(title, opts); } catch (e) {} });
      } else new Notification(title, opts);
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); schedule(); return; }
    hiddenAt = 0;
    if (Date.now() - lastPoll > 60e3 && load().some(function (a) { return a.st === 'on'; })) poll().then(function () { schedule(); }); else schedule();
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY) { drawSheet('ifOpen'); menuCount(); schedule(); } });

  // ── the More menu entry (ui.js builds the sheet; this adds one row to its actions) ─────────
  function menuEntry() {
    var acts = document.querySelector('.osheet .oacts');
    if (!acts || acts.querySelector('[data-act="price-alerts"]')) return !!acts;
    var b = document.createElement('button'); b.className = 'oact'; b.setAttribute('data-act', 'price-alerts');
    var bell = acts.querySelector('[data-act="alerts"] svg');
    b.innerHTML = (bell ? bell.outerHTML : '') + '<span class="oact-pa">Price alerts</span>';
    b.addEventListener('click', function () { try { if (window.OnyxUI && OnyxUI.closeMenu) OnyxUI.closeMenu(); } catch (e) {} open(); });
    var after = acts.querySelector('[data-act="new"]');
    if (after && after.nextSibling) acts.insertBefore(b, after.nextSibling); else acts.appendChild(b);
    menuCount();
    return true;
  }
  function menuCount() {
    var s = document.querySelector('.osheet .oact-pa'); if (!s) return;
    var n = load().filter(function (a) { return a.st === 'on'; }).length;
    s.textContent = 'Price alerts' + (n ? ': ' + n + ' on' : ': set one from any Onyx price');
  }
  function changed() { menuCount(); }

  var API = {
    open: open, close: closeSheet, mountCard: mountCard, list: load, add: function (p, o) { return add(p, o || {target: better(p.price, 10)}); }, remove: remove,
    poll: poll, moveOf: moveOf,
    // for tools/verify_alerts_ui.js: run the watcher now, read its timing
    _test: {poll: poll, pollMs: function () { return POLL_MS; }, better: better}
  };
  window.OnyxPriceAlerts = API;
  // OnyxAlerts belongs to alerts.js (the push control center: mount). Add open to it, whichever script loads first.
  (function () {
    var mix = function (o) { if (o && typeof o === 'object' && !o.open) o.open = open; return o; };
    var cur = mix(window.OnyxAlerts || null) || {open: open, mount: function () {}};
    try { Object.defineProperty(window, 'OnyxAlerts', {configurable: true, enumerable: true, get: function () { return cur; }, set: function (v) { cur = mix(v); }}); }
    catch (e) { window.OnyxAlerts = cur; }
  })();

  function boot() {
    if (!menuEntry()) { var n = 0, iv = setInterval(function () { if (menuEntry() || ++n > 20) clearInterval(iv); }, 500); }
    if (/[?&]oxpa=1/.test(location.search)) {
      setTimeout(open, 300);
      try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&]oxpa=1/, '').replace(/^&/, '?') + location.hash); } catch (e) {}
    }
    if (load().some(function (a) { return a.st === 'on'; })) schedule(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
