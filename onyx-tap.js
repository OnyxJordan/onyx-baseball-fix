// onyx-tap.js - Tap any price, anywhere (11/16, Jordan: "make this as interactive as possible the entire site").
// Every Onyx price on the site becomes a launch point: tap it and a quick card opens (a bottom sheet on phones,
// a popover on desktop) with the play, its matchup and start, the Onyx price, the model's chance, the fair odds and
// the edge in plain words, a stake slider with the payout, and one tap to Bet on Onyx, add it to the shared parlay
// slip (OnyxParlay), save and track it (OnyxSaved), compare it or simulate the game in the Studio. Player props get
// a strip of the player's last games against the line where that sport has data/<sport>/player_games.json.
//
// What it intercepts (a capture listener on window, so it runs before the page's own handlers):
//   - a single-selection Onyx share link (app.onyxodds.com/share?selection=...) that shows a price
//   - a sport page chip / odds cell: bet('<selection>', ...) with a price on it (.oc, .chipx, live lines)
//   - an NBA game-line cell: betLeg(i) whose leg is not a player prop (props open the NBA page's own bet card)
//   - an MLB odds cell: onyxTicket({...}) that shows a price (the scoreboard moneylines, home run prices)
// What it leaves alone:
//   - anything while the parlay builder is armed (a tap still adds a leg), parlay links (several selections),
//     "Bet ... on Onyx" buttons with no price on them, the NBA bet card cells, anything inside the card or slip
//   - a modifier click (Cmd / Ctrl / Shift / Alt, or a middle click) and a long-press: those open Onyx directly
// Line moves and price alerts (11/17): the card leaves three slots (data-pa-chip by the price, data-pa-move under the
// numbers, data-pa-alert under the buttons) that onyx-alerts.js fills: open -> now with a sparkline, "Alert me at +150".
// Loaded on every page by ui.js. window.OnyxTap = {open(play, anchor), close(), isOpen()}.
(function () {
  'use strict';
  if (window.OnyxTap) return;
  var REF = 'KR680261', STAKE_KEY = 'onyxTapStake', LONG_MS = 500;
  var NAMES = {nfl: 'NFL', nba: 'NBA', cfb: 'College Football', cbb: 'College Basketball', nhl: 'NHL', tennis: 'Tennis', mlb: 'MLB', golf: 'Golf'};
  var STUDIO = {nfl: 1, nba: 1, cfb: 1, cbb: 1, nhl: 1, tennis: 1};
  var BOARDS = ['nfl', 'cfb', 'nba', 'cbb', 'nhl', 'tennis'];
  var FILE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var IS_MLB = FILE === 'index.html' || FILE === '' || FILE === 'mlb-2026.html' || (typeof window.ONYX_HR_MARKET !== 'undefined');
  // the page's own sport: sport pages set OX_SITE; the NBA page and the Studio are detected
  var PAGE_SPORT = window.OX_SITE || (FILE === 'nba.html' ? 'nba' : FILE === 'studio.html' ? ((location.search.match(/[?&]sport=([a-z]+)/) || [])[1] || 'nfl') : IS_MLB ? 'mlb' : null);
  var TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  var PRICE_RE = /(^|[^\d.])([+-]\d{3,5}|EVEN)(?![\d.])/;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null || isNaN(a) ? '-' : (a > 0 ? '+' : '') + Math.round(a); }
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function amer(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function imp(a) { return 1 / dec(a); }
  function pct(x) { return x == null || isNaN(x) ? '-' : (100 * x < 1 ? '<1' : 100 * x > 99 ? '>99' : Math.round(100 * x)) + '%'; }
  function money(x) { return '$' + (x >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2)); }
  function nk(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, ''); }
  function share(sel) { return 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(sel) + '&referrer=' + REF; }
  function toast(m) { try { if (window.OX_TOAST) window.OX_TOAST(m, {}); } catch (e) {} }
  function gt(name, o) { try { if (window.gtag) window.gtag('event', name, o || {}); } catch (e) {} }
  function priceIn(el) { var m = PRICE_RE.exec((el.innerText || el.textContent || '').replace(/−/g, '-')); return m ? (m[2] === 'EVEN' ? 100 : +m[2]) : null; }
  function when(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    if (t <= Date.now()) return 'Started';
    try { return new Date(t).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}).replace(',', '') + ' ET'; } catch (e) { return ''; }
  }

  // ── every play by Onyx selection id: today's boards (mirrors parlay.js index()) ──────────────
  var IDX = null, IDX_READY = null;
  function index() {
    if (IDX) return IDX;
    var ask = window.OnyxAsk && OnyxAsk.loadBoards ? Promise.resolve().then(function () { return OnyxAsk.loadBoards(); }).catch(function () { return null; }) : Promise.resolve(null);
    IDX = ask.then(function (rows) {
      var o = {};
      (rows || []).forEach(function (p) { if (p && p.sel) o[p.sel] = p; });
      var want = PAGE_SPORT && BOARDS.indexOf(PAGE_SPORT) >= 0 && FILE !== 'home.html' && FILE !== 'picks.html' ? [PAGE_SPORT] : BOARDS;
      return Promise.all(want.map(function (k) {
        return fetch('data/' + k + '/board.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      })).then(function (fs) {
        fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { if (p.sel && !o[p.sel]) o[p.sel] = p; }); });
        IDX_READY = o; return o;
      });
    });
    return IDX;
  }
  // a board row may be from another sport than the page (home, picks): load the rest when it is missing
  var IDX_ALL = null;
  function indexAll() {
    if (IDX_ALL) return IDX_ALL;
    IDX_ALL = index().then(function (o) {
      var have = {}; Object.keys(o).forEach(function (s) { have[o[s].sport] = 1; });
      return Promise.all(BOARDS.filter(function (k) { return !have[k]; }).map(function (k) {
        return fetch('data/' + k + '/board.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      })).then(function (fs) { fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { if (p.sel && !o[p.sel]) o[p.sel] = p; }); }); return o; });
    });
    return IDX_ALL;
  }
  // an open Onyx Pick whose line has moved off the board (11/17): its logged ledger row, so the card names the bet
  var LEDGER = null;
  function ledgerRow(sel) {
    if (!LEDGER) LEDGER = fetch('data/picks/ledger.json').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return LEDGER.then(function (L) { var r = (Array.isArray(L) ? L : []).filter(function (x) { return x && x.sel === sel && !x.result && x.label; })[0];
      return r ? {sel: r.sel, label: r.label, sport: r.sport, price: r.price, start: r.start, matchup: r.matchup, gid: r.gid, kind: r.kind, mkt: r.market,
                  side: r.side, line: r.line, name: r.name || r.who, team: r.team, conf: r.chance, pick: true} : null; });
  }
  function find(sel) {
    return index().then(function (o) { return o[sel] || indexAll().then(function (a) { return a[sel] || ledgerRow(sel); }); });
  }

  // ── what a tapped element is ─────────────────────────────────────────────────────────────
  var CAND = 'a[href*="onyxodds.com/share"], [onclick*="bet(\'"], [onclick*="betLeg("], [onclick*="onyxTicket("]';
  var SKIP_IN = '#oxTap, #oxPB, #parlayFab, #pc, .pbx, .pb-slip, [data-no-tap]';
  // -> {sel, url, price, hint: {label?, play?}, mlb?} or null (leave the tap alone)
  function candidate(t) {
    var el = t && t.closest ? t.closest(CAND) : null;
    if (!el || el.closest(SKIP_IN)) return null;
    var inner = t.closest('a,button,[onclick]');
    if (inner && inner !== el && el.contains(inner)) return null;            // a star or other control inside the cell
    var price = priceIn(el), oc = el.getAttribute('onclick') || '';
    if (el.tagName === 'A') {
      var h = el.getAttribute('href') || '', sels = h.match(/[?&]selection=([^&]+)/g) || [];
      if (sels.length !== 1 || price == null) return null;
      var sel = decodeURIComponent(sels[0].replace(/^[?&]selection=/, ''));
      return {el: el, sel: sel, url: el.href, price: price};
    }
    var m = /\bbet\(\s*'([^']+)'\s*(?:,\s*'([^']*)')?/.exec(oc);
    if (m && price != null) {
      var s1 = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      return {el: el, sel: s1, url: share(s1), price: price, label: m[2] ? m[2].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : null};
    }
    var bl = /\bbetLeg\((\d+)\)/.exec(oc);
    if (bl) {
      var leg = window.LEGS && window.LEGS[+bl[1]];
      if (!leg || !leg.sel || (leg.pid && leg.stat)) return null;            // a player prop: the NBA bet card has it
      var play = null; try { play = typeof window.sharedLeg === 'function' ? window.sharedLeg(leg) : null; } catch (e) {}
      return {el: el, sel: leg.sel, url: share(leg.sel), price: leg.price != null ? +leg.price : price, hint: {play: play}};
    }
    if (/onyxTicket\(/.test(oc) && price != null) return mlbCand(el, oc, price);
    return null;
  }
  // MLB: the cell builds its ticket object inline; run it against a stand-in onyxTicket to read it
  function mlbCand(el, oc, price) {
    if (typeof window.onyxTicket !== 'function' || typeof window.onyxSelection !== 'function') return null;
    var real = window.onyxTicket, got = null;
    try {
      window.onyxTicket = function (p) { got = p; };
      if (typeof el.onclick === 'function') el.onclick.call(el, {stopPropagation: function () {}, preventDefault: function () {}, target: el, currentTarget: el});
    } catch (e) { got = null; } finally { window.onyxTicket = real; }
    if (!got || got.odds == null || got.odds === '' || isNaN(+got.odds)) return null;
    if (got.market === 'ML' && got.side === 'no') return null;               // "No" is the other side: its own price is not on the cell
    var s = null; try { s = window.onyxSelection(got); } catch (e) {}
    var url = s ? share(s.sel) : (window.ONYX_FALLBACK_URL || 'https://app.onyxodds.com/?referrer=' + REF);
    return {el: el, sel: s ? s.sel : null, url: url, price: +got.odds, mlb: got};
  }
  function mlbPlay(c) {
    var p = c.mlb, sm = null, rows = [];
    try { sm = (typeof SUMMARIES !== 'undefined' ? SUMMARIES : []).filter(function (x) { return x.away === p.away && x.home === p.home; })[0] || null; } catch (e) {}
    try { rows = typeof RESULTS !== 'undefined' ? RESULTS : []; } catch (e) {}
    var play = {sport: 'mlb', sel: c.sel, price: c.price, matchup: p.away && p.home ? p.away + ' @ ' + p.home : '', start: sm ? sm.start : null, gid: sm ? String(sm.gamePk || '') : null};
    if (p.market === 'HR') {
      var r = rows.filter(function (x) { return x.matched_name === p.pick; })[0];
      Object.assign(play, {kind: 'prop', mkt: 'hr', side: 'over', line: 0.5, name: p.pick, team: r ? r.team : null, label: p.pick + ' to hit a home run',
                           conf: r && r.hr_prob != null ? +r.hr_prob / 100 : null, why: r && (r.ticket_why || []).length ? r.ticket_why.join(' · ') : null});
      if (r && r.away && r.home) play.matchup = r.away + ' @ ' + r.home;
    } else if (p.market === 'ML') {
      Object.assign(play, {kind: 'ml', mkt: 'ml', side: 'over', name: p.pick, team: p.pick, label: p.pick + ' to win', conf: null});
    } else Object.assign(play, {kind: String(p.market || '').toLowerCase(), label: p.pick, conf: null});
    return play;
  }
  function selInfo(sel) { try { return window.OX_SELINFO ? window.OX_SELINFO(sel) : null; } catch (e) { return null; } }
  function textLabel(el) {
    var t = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (t && !/^(add to onyx|bet|over on onyx|under on onyx)/i.test(t)) return t;
    var row = el.closest('.t10-r, .pk, .oxp-r, tr, li, .gm, .pl-card');
    var b = row && row.querySelector('b, strong, .t10-w b');
    return b ? b.textContent.trim() : (el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // ── the card ─────────────────────────────────────────────────────────────────────────────
  var CSS = [
    '#oxTap{position:fixed;inset:0;z-index:10080;pointer-events:none}',
    '#oxTap[hidden]{display:none}',
    '.oxt-bg{position:absolute;inset:0;background:rgba(6,4,10,.55);opacity:0;transition:opacity .18s;pointer-events:auto}',
    '#oxTap.on .oxt-bg{opacity:1}',
    '.oxt-c{position:absolute;pointer-events:auto;box-sizing:border-box;background:#141119;color:#eee9f5;border:1.5px solid rgba(176,56,249,.55);box-shadow:0 18px 50px rgba(0,0,0,.7);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
    '.oxt-c:focus{outline:none}',
    '#oxTap.sheet .oxt-c{left:0;right:0;bottom:0;max-height:min(90vh,calc(100vh - var(--sat,0px) - 24px));border-radius:20px 20px 0 0;border-bottom:0;padding:8px 16px calc(16px + var(--sab,0px));transform:translateY(100%);transition:transform .22s cubic-bezier(.2,.8,.2,1)}',
    '#oxTap.sheet.on .oxt-c{transform:none}',
    '#oxTap.pop .oxt-bg{background:transparent}',
    '#oxTap.pop .oxt-c{width:360px;max-height:calc(100vh - 24px);border-radius:16px;padding:14px 16px 14px;opacity:0;transform:translateY(4px) scale(.98);transition:opacity .14s,transform .14s}',
    '#oxTap.pop.on .oxt-c{opacity:1;transform:none}',
    '.oxt-grab{width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:2px auto 8px}',
    '#oxTap.pop .oxt-grab{display:none}',
    '.oxt-x{position:absolute;top:8px;right:8px;width:36px;height:36px;border-radius:18px;border:0;background:rgba(255,255,255,.07);color:#cfc8da;font:400 22px/1 system-ui,sans-serif;cursor:pointer}',
    '.oxt-x:hover,.oxt-x:focus-visible{background:rgba(176,56,249,.3);color:#fff}',
    '.oxt-k{font:800 10px/1 monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff;margin:4px 92px 6px 0}',
    '.oxt-sh{position:absolute;top:8px;right:52px;width:36px;height:36px;border-radius:18px;border:0;background:rgba(255,255,255,.07);color:#d795ff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
    '.oxt-sh svg{width:17px;height:17px}.oxt-sh:hover,.oxt-sh:focus-visible{background:rgba(176,56,249,.3);color:#fff}',
    '.oxt-c h2{margin:0 44px 2px 0;font:800 18px/1.25 system-ui,-apple-system,sans-serif;color:#fff}',
    '.oxt-m{font:600 12px/1.4 monospace;color:#9a93a6;margin-bottom:12px}',
    '.oxt-n{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}',
    '.oxt-n div{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:8px 9px;min-width:0}',
    '.oxt-n small{display:block;font:700 9px/1.2 monospace;letter-spacing:.08em;text-transform:uppercase;color:#8f879c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.oxt-n b{display:block;font:800 19px/1.25 monospace;color:#fff;margin-top:3px}',
    '.oxt-n .px b{color:#d795ff}',
    '.oxt-e{margin:0 0 12px;font-size:13px;line-height:1.5;color:#d8d1e3}',
    '.oxt-e b.up{color:#61e970}.oxt-e b.dn{color:#ff8a8a}',
    '.oxt-why{margin:-6px 0 12px;font:600 11px/1.45 monospace;color:#8f879c}',
    '.oxt-g{height:92px;margin:0 0 12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);padding:8px 10px;box-sizing:border-box;display:flex;flex-direction:column}',
    '.oxt-g p{margin:0;font:700 10px/1.3 monospace;letter-spacing:.04em;color:#9a93a6;text-transform:uppercase}',
    '.oxt-g p b{color:#fff}',
    '.oxt-bars{position:relative;flex:1;display:flex;align-items:flex-end;gap:4px;margin-top:6px}',
    '.oxt-bars i{flex:1;min-width:0;border-radius:3px 3px 0 0;background:#ff8a8a;opacity:.85;position:relative}',
    '.oxt-bars i.w{background:#61e970}',
    '.oxt-bars i span{position:absolute;bottom:100%;left:0;right:0;text-align:center;font:700 9px/1.3 monospace;color:#cfc8da;font-style:normal}',
    '.oxt-bars em{position:absolute;left:0;right:0;border-top:1.5px dashed rgba(215,149,255,.9);pointer-events:none}',
    '.oxt-g .oxt-gm{flex:1;display:flex;align-items:center;justify-content:center;font:600 11px monospace;color:#8f879c;text-transform:none;letter-spacing:0}',
    '.oxt-s{margin:0 0 12px}',
    '.oxt-s label{display:flex;justify-content:space-between;align-items:baseline;font:700 11px monospace;color:#9a93a6;letter-spacing:.04em;text-transform:uppercase}',
    '.oxt-s label b{font:800 15px monospace;color:#fff;letter-spacing:0;text-transform:none}',
    '.oxt-s input{width:100%;margin:8px 0 6px;accent-color:#b038f9;height:28px;cursor:pointer}',
    '.oxt-pay{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.oxt-pay div{font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;color:#8f879c}',
    '.oxt-pay b{display:block;font:800 17px monospace;color:#61e970;letter-spacing:0;font-variant-numeric:tabular-nums}',
    '.oxt-pay div:first-child b{color:#fff}',
    '.oxt-bet{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;border-radius:13px;background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff!important;font:800 15px system-ui,-apple-system,sans-serif;text-decoration:none!important;box-shadow:0 6px 22px -6px rgba(176,56,249,.75);margin-bottom:8px}',
    '.oxt-bet:focus-visible,.oxt-b button:focus-visible,.oxt-b a:focus-visible{outline:2px solid #d795ff;outline-offset:2px}',
    '.oxt-b{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.oxt-b button,.oxt-b a{display:flex;align-items:center;justify-content:center;min-height:42px;padding:6px 8px;border-radius:11px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#eee9f5!important;font:700 12.5px system-ui,-apple-system,sans-serif;text-decoration:none!important;cursor:pointer;text-align:center;box-sizing:border-box}',
    '.oxt-b button:hover,.oxt-b a:hover{border-color:#b038f9;background:rgba(176,56,249,.18)}',
    '.oxt-b .on{border-color:rgba(97,233,112,.7);color:#61e970!important;background:rgba(97,233,112,.08)}',
    '.oxt-f{margin:10px 0 0;font:600 10.5px/1.45 monospace;color:#7f7889}',
    '@media (prefers-reduced-motion: reduce){#oxTap .oxt-c,#oxTap .oxt-bg{transition:none!important}}',
    // long-press goes straight to Onyx: no iOS link callout on the prices
    'a[href*="onyxodds.com/share"],.oc,.chipx,.sb-ml,.slam-odds{-webkit-touch-callout:none}'
  ].join('\n');

  var ROOT = null, CARD = null, LAST_FOCUS = null, CUR = null, OPEN_SEQ = 0;
  function build() {
    if (ROOT) return;
    var st = document.createElement('style'); st.id = 'onyx-tap'; st.textContent = CSS; document.head.appendChild(st);
    ROOT = document.createElement('div'); ROOT.id = 'oxTap'; ROOT.hidden = true;
    ROOT.innerHTML = '<div class="oxt-bg" data-x="1"></div><div class="oxt-c" role="dialog" aria-modal="true" aria-labelledby="oxtT" tabindex="-1"></div>';
    document.body.appendChild(ROOT);
    CARD = ROOT.querySelector('.oxt-c');
    // the page behind a sheet does not scroll under a finger on the backdrop
    ROOT.querySelector('.oxt-bg').addEventListener('touchmove', function (e) { e.preventDefault(); }, {passive: false});
    ROOT.addEventListener('click', onCardClick);
    CARD.addEventListener('input', function (e) { if (e.target && e.target.id === 'oxtS') stake(+e.target.value, true); });
    swipe(CARD);
  }
  function sheetMode() { return window.innerWidth < 720; }
  function getStake() { var v = 25; try { v = +localStorage.getItem(STAKE_KEY) || 25; } catch (e) {} return Math.min(500, Math.max(5, Math.round(v / 5) * 5)); }
  function stake(v, save) {
    if (!CUR) return;
    v = Math.min(500, Math.max(5, Math.round(v / 5) * 5)); CUR.stake = v;
    var d = dec(CUR.p.price);
    var sv = document.getElementById('oxtSv'), pay = document.getElementById('oxtPay'), pro = document.getElementById('oxtPro');
    if (sv) sv.textContent = '$' + v;
    if (pay) pay.textContent = money(v * d);
    if (pro) pro.textContent = money(v * (d - 1));
    var s = document.getElementById('oxtS'); if (s) s.setAttribute('aria-valuetext', '$' + v + ' stake pays ' + money(v * d));
    if (save) { try { localStorage.setItem(STAKE_KEY, String(v)); } catch (e) {} }
  }

  function edgeWords(p) {
    var i = imp(p.price), c = p.conf, f = c != null && c > 0 && c < 1 ? amer(1 / c) : null;
    if (c == null || p.no_read) return 'No model read on this line, so the chance shown is the one Onyx\'s ' + esc(odds(p.price)) + ' implies' + (STUDIO[p.sport] ? '. Compare it or play the game out in the Studio to make your own call.' : '.');
    var e = c - i, pts = Math.abs(100 * e), ev = 100 * (c * dec(p.price) - 1);
    var evs = (ev >= 0 ? '+' : '-') + '$' + Math.abs(ev).toFixed(0) + ' per $100';
    if (pts < 1) return 'About a fair price: the model gives it <b>' + pct(c) + '</b> and Onyx\'s ' + esc(odds(p.price)) + ' needs ' + pct(i) + '. Fair odds are ' + esc(odds(f)) + '.';
    if (e > 0) return '<b class="up">Value by the model.</b> It gives this <b>' + pct(c) + '</b>; Onyx\'s ' + esc(odds(p.price)) + ' only needs ' + pct(i) + '. That is ' + pts.toFixed(1) + ' points in your favor, about <b class="up">' + evs + '</b> over the long run.';
    return '<b class="dn">Thin price by the model.</b> It gives this <b>' + pct(c) + '</b>, but Onyx\'s ' + esc(odds(p.price)) + ' needs ' + pct(i) + ': ' + pts.toFixed(1) + ' points short (' + evs + '). The fair price would be ' + esc(odds(f)) + '.';
  }
  function studioLinks(p) {
    var k = p.sport; if (!STUDIO[k]) return {cmp: null, sim: null};
    var base = 'studio.html?sport=' + k;
    var cmp;
    if (p.kind === 'prop' && p.name && k !== 'tennis') cmp = base + '#compare?p=' + encodeURIComponent(p.name);
    else {
      var other = null;
      if (IDX_READY && p.gid) {
        var best = null;
        Object.keys(IDX_READY).forEach(function (s) { var r = IDX_READY[s]; if (r.sport === k && r.gid && r.gid !== p.gid && Date.parse(r.start) > Date.now() && (!best || Date.parse(r.start) < Date.parse(best.start))) best = r; });
        other = best && best.gid;
      }
      cmp = base + '#compare?mode=games' + (p.gid && other ? '&g=' + encodeURIComponent(p.gid + '|' + other) : '');
    }
    return {cmp: cmp, sim: base + '#sim' + (p.gid ? '?gid=' + encodeURIComponent(p.gid) : '')};
  }
  function onSlip(p) {
    try {
      if (window.OnyxParlay) return OnyxParlay.slip().some(function (x) { return p.sel ? x.sel === p.sel : false; });
      if (Array.isArray(window.parlaySlip)) return window.parlaySlip.some(function (x) { return x.sel === p.sel; });
    } catch (e) {}
    return false;
  }
  function savePick(p) { var o = Object.assign({id: p.sel || null}, p); delete o.why; return window.OnyxSaved && OnyxSaved.withId ? OnyxSaved.withId(o) : o; }
  function isSaved(p) { try { var s = savePick(p); return !!(window.OnyxSaved && s.id && OnyxSaved.has(s.id)); } catch (e) { return false; } }
  function canSlip() { return !!(window.OnyxParlay || typeof window.parlayAdd === 'function'); }

  function render(p, url, loading) {
    var k = p.sport, model = p.conf != null && !p.no_read, chance = model ? p.conf : (p.price != null ? imp(p.price) : null);
    var fair = model && chance > 0 && chance < 1 ? amer(1 / chance) : null;
    var meta = [p.matchup, when(p.start)].filter(Boolean).join(' · ');
    var S = studioLinks(p), slip = onSlip(p), saved = isSaved(p);
    var hasPG = p.kind === 'prop' && PG_SPORTS[k] && statOf(k, p.mkt) !== null;
    var h = '<div class="oxt-grab" aria-hidden="true"></div><button type="button" class="oxt-x" data-x="1" aria-label="Close">&times;</button>'
      + (window.OnyxShare && p.label && p.price != null ? '<button type="button" class="oxt-sh" data-a="share" aria-label="Share this bet as an image card">' + OnyxShare.icon + '</button>' : '')
      + '<div class="oxt-k">' + esc([NAMES[k] || (k || '').toUpperCase(), !model && !loading ? 'Onyx line' : p.tag === 'trial' ? 'Trial' : 'Projection'].filter(Boolean).join(' · ')) + '</div>'
      + '<h2 id="oxtT">' + esc(p.label || 'Onyx price') + '</h2>'
      + '<div class="oxt-m">' + esc(meta || ' ') + '</div>'
      + '<div class="oxt-n"><div class="px"><small>Onyx price</small><b>' + esc(odds(p.price)) + '</b><span class="oxt-pc" data-pa-chip></span></div>'
      + '<div><small>' + (p.conf != null && !p.no_read ? 'Model chance' : 'Onyx chance') + '</small><b data-tap-chance>' + (loading ? '&hellip;' : pct(chance)) + '</b></div>'
      + '<div><small>Fair odds</small><b>' + (loading ? '&hellip;' : esc(odds(fair))) + '</b></div></div>'
      + '<div class="oxt-mv" data-pa-move hidden></div>'   // the line move, open -> now (onyx-alerts.js fills it)
      + '<p class="oxt-e">' + (loading ? 'Reading the model&hellip;' : edgeWords(p)) + '</p>'
      + (p.why ? '<div class="oxt-why">' + esc(String(p.why).slice(0, 160)) + '</div>' : '')
      + (hasPG ? '<div class="oxt-g" id="oxtG"><p>Last games vs this line</p><div class="oxt-gm">Loading game logs&hellip;</div></div>' : '')
      + '<div class="oxt-s"><label for="oxtS">Stake <b id="oxtSv">$25</b></label><input type="range" id="oxtS" min="5" max="500" step="5" value="' + getStake() + '">'
      + '<div class="oxt-pay"><div>Pays<b id="oxtPay">-</b></div><div>Profit<b id="oxtPro">-</b></div></div></div>'
      + '<a class="oxt-bet" data-tap-bet href="' + esc(url) + '" target="_blank" rel="noopener">Bet on Onyx &middot; ' + esc(odds(p.price)) + '</a>'
      + '<div class="oxt-b">'
      + (canSlip() ? '<button type="button" data-a="slip" class="' + (slip ? 'on' : '') + '">' + (slip ? 'On parlay slip' : '+ Parlay slip') + '</button>' : '')
      + (window.OnyxSaved ? '<button type="button" data-a="save" class="' + (saved ? 'on' : '') + '" aria-pressed="' + saved + '">' + (saved ? 'Saved, tracking' : 'Save / track') + '</button>' : '')
      + (S.cmp ? '<a href="' + esc(S.cmp) + '" data-a="nav">Compare</a>' : '')
      + (S.sim ? '<a href="' + esc(S.sim) + '" data-a="nav">Simulate the game</a>' : '')
      + '</div>'
      + '<div class="oxt-pa" data-pa-alert hidden></div>'   // price alerts (onyx-alerts.js)
      + '<p class="oxt-f">' + (model && p.tag !== 'pick' ? 'The chance is a model projection, not an Onyx Pick. ' : '') + (TOUCH ? 'Long-press a price' : 'Cmd or Ctrl-click a price') + ' to go straight to Onyx.</p>';
    CARD.innerHTML = h;
    CARD.setAttribute('data-pa-sel', p.sel || '');
    stake(getStake(), false);
    if (!loading && window.OnyxPriceAlerts) { try { OnyxPriceAlerts.mountCard(CARD, p); } catch (e) {} }
    if (hasPG) strip(p);
  }

  function place(anchor) {
    var sheet = sheetMode();
    ROOT.classList.toggle('sheet', sheet); ROOT.classList.toggle('pop', !sheet);
    CARD.style.left = CARD.style.top = '';
    if (sheet || !anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect(), W = 360, H = CARD.offsetHeight || 480, vw = innerWidth, vh = innerHeight;
    var left = Math.min(Math.max(12, r.left + r.width / 2 - W / 2), vw - W - 12);
    var top = r.bottom + 8;
    if (top + H > vh - 12) top = r.top - H - 8 >= 12 ? r.top - H - 8 : Math.max(12, vh - H - 12);
    CARD.style.left = Math.round(left) + 'px'; CARD.style.top = Math.round(top) + 'px';
  }

  function open(p, anchor, url, loading) {
    build();
    var was = !ROOT.hidden;
    if (!was) LAST_FOCUS = document.activeElement;
    CUR = {p: p, url: url || (p.sel ? share(p.sel) : 'https://app.onyxodds.com/?referrer=' + REF), anchor: anchor, stake: getStake()};
    render(p, CUR.url, loading);
    ROOT.hidden = false;
    place(anchor);
    // the card grows after it opens (the line-move panel, 11/17): keep the desktop popover on screen as it does
    if (!CARD._ro && window.ResizeObserver) { CARD._ro = new ResizeObserver(function () { if (!ROOT.hidden && CUR && !sheetMode()) place(CUR.anchor); }); CARD._ro.observe(CARD); }
    if (!was) { void CARD.offsetWidth; ROOT.classList.add('on'); }
    try { CARD.focus({preventScroll: true}); } catch (e) { CARD.focus(); }
    gt('tap_card', {sport: p.sport || '', kind: p.kind || ''});
  }
  function close() {
    if (!ROOT || ROOT.hidden) return;
    OPEN_SEQ++;
    ROOT.classList.remove('on');
    var r = ROOT;
    setTimeout(function () { if (!r.classList.contains('on')) { r.hidden = true; CARD.innerHTML = ''; CARD.style.transform = ''; } }, 200);
    CUR = null;
    var f = LAST_FOCUS; LAST_FOCUS = null;
    if (f && f.focus && document.contains(f)) { try { f.focus({preventScroll: true}); } catch (e) {} }
  }

  function onCardClick(e) {
    var t = e.target;
    if (t.closest('[data-x]')) { e.preventDefault(); close(); return; }
    if (!CUR) return;
    var p = CUR.p;
    if (t.closest('[data-tap-bet]')) {
      gt('onyx_click', {link_type: 'tap_card', sport: p.sport || '', selection: p.label || ''});
      setTimeout(close, 60);
      return;
    }
    var b = t.closest('[data-a]'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'slip') {
      if (window.OnyxParlay) OnyxParlay.add(Object.assign({}, p));
      else if (CUR.mlbRaw && typeof window.parlayAdd === 'function') { window.parlayAdd(CUR.mlbRaw); try { if (typeof window.renderParlaySlip === 'function') window.renderParlaySlip(); } catch (x) {} }
      var on = onSlip(p); b.classList.toggle('on', on); b.textContent = on ? 'On parlay slip' : '+ Parlay slip';
      if (on && !window.OnyxParlay) toast('Added to your Onyx ticket: ' + (p.label || ''));
    } else if (a === 'save') {
      var s = window.OnyxSaved ? OnyxSaved.toggle(savePick(p)) : false;
      b.classList.toggle('on', !!s); b.setAttribute('aria-pressed', !!s); b.textContent = s ? 'Saved, tracking' : 'Save / track';
    } else if (a === 'share') {
      // the shareable bet card (onyx-share.js): the card closes so the share sheet has the screen
      var card = {kind: 'single', price: p.price, chance: p.conf != null && !p.no_read ? p.conf : null, sels: p.sel ? [p.sel] : [],
        legs: [{label: p.label, matchup: [p.matchup, when(p.start)].filter(Boolean).join(' \u00b7 '), price: p.price, conf: p.conf != null && !p.no_read ? p.conf : null, sport: p.sport, sel: p.sel}]};
      close();
      if (window.OnyxShare) OnyxShare.open(card);
    } else if (a === 'nav') {
      gt('tap_card_studio', {sport: p.sport || '', to: /#sim/.test(b.getAttribute('href')) ? 'sim' : 'compare'});
      // same page (the Studio): the hash change switches the tool; close so it shows
      if (FILE === 'studio.html' && b.getAttribute('href').split('#')[0] === 'studio.html' + location.search) { close(); }
    }
  }

  // swipe down to close (the sheet), Esc to close, Tab kept inside the card
  function swipe(node) {
    var y0 = null, dy = 0;
    node.addEventListener('touchstart', function (e) {
      if (!ROOT.classList.contains('sheet') || node.scrollTop > 0 || e.target.closest('input,select,textarea')) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; node.style.transition = 'none';
    }, {passive: true});
    node.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      node.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
    }, {passive: true});
    node.addEventListener('touchend', function () {
      if (y0 == null) return;
      node.style.transition = ''; node.style.transform = '';
      if (dy > 80) close();
      y0 = null;
    });
  }
  document.addEventListener('keydown', function (e) {
    if (!ROOT || ROOT.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(CARD.querySelectorAll('a[href],button,input,[tabindex]:not([tabindex="-1"])'), function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (!CARD.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (a === first || a === CARD)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }, true);
  window.addEventListener('resize', function () { if (ROOT && !ROOT.hidden && CUR) place(CUR.anchor); });
  // the popover follows its price when the page scrolls under it
  window.addEventListener('scroll', function () { if (ROOT && !ROOT.hidden && CUR && ROOT.classList.contains('pop')) place(CUR.anchor); }, {passive: true});
  window.addEventListener('pagehide', close);

  // ── last games vs this line (player props) ────────────────────────────────────────────────
  var PG_SPORTS = {nfl: 1, cfb: 1, nba: 1, cbb: 1, nhl: 1}, PG = {};
  function statOf(k, m) {
    if (k === 'nba') return {pts: 1, reb: 1, ast: 1, threes: 1, pra: 1, pr: 1, pa: 1, ra: 1, dbl_dbl: 1, trp_dbl: 1}[m] ? m : null;
    if (k === 'nfl' || k === 'cfb') return {rec: 1, rec_yds: 1, rush_yds: 1, pass_yds: 1, pass_att: 1, pass_td: 1, rush_rec_yds: 1, pass_rush_yds: 1, anytime_td: 1, two_td: 1, three_td: 1}[m] ? m : null;
    if (k === 'cbb') return {pts: 1, reb: 1, ast: 1, threes: 1, pra: 1, pr: 1, pa: 1}[m] ? m : null;
    if (k === 'nhl') return {sog: 1, goals: 1, assists: 1, points: 1, shots: 1}[m] ? m : null;
    return null;
  }
  function pgLoad(k) {
    if (PG[k]) return PG[k];
    PG[k] = fetch('data/' + k + '/player_games.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var by = {}, add = function (id, name, g) { if (id != null) (by['i' + id] = by['i' + id] || []).push(g); if (name) (by['n' + nk(name)] = by['n' + nk(name)] || []).push(g); };
      if (!j) return by;
      if (k === 'nba') Object.keys(j).forEach(function (pid) {
        var r = j[pid]; if (pid.charAt(0) === '_' || !r || !r.g) return;
        r.g.forEach(function (g) { var v = {date: g[0], opp: g[2], min: g[4], pts: g[5], reb: g[6], ast: g[7], threes: g[8]}; if (v.min > 0) add(pid, r.n, v); });
      });
      else if (j.cols && Array.isArray(j.rows)) {
        var c = {}; j.cols.forEach(function (x, i) { c[x] = i; });
        j.rows.forEach(function (row) {
          var o = {}; j.cols.forEach(function (x, i) { o[x] = row[i]; });
          if (o.dnp) return;
          if (k === 'nhl') { o.goals = o.g; o.assists = o.a; o.points = (o.g || 0) + (o.a || 0); o.shots = o.sog; o.name = (j.names || {})[String(o.pid)]; }
          if (k === 'cbb') o.threes = o.tpm;
          add(o.pid, o.name, o);
        });
      } else (j.rows || []).forEach(function (o) { add(o.pid, o.name, o); });
      Object.keys(by).forEach(function (x) { by[x].sort(function (a, b) { return a.date < b.date ? 1 : -1; }); });
      return by;
    }).catch(function () { return {}; });
    return PG[k];
  }
  function val(k, m, g) {
    var z = function (x) { return +g[x] || 0; };
    if (k === 'nfl' || k === 'cfb') {
      var passing = (g.cats || []).indexOf('passing') >= 0;
      switch (m) {
        case 'rec': case 'rec_yds': case 'rush_yds': return z(m);
        case 'pass_yds': return passing ? z('pass_yds') : null;
        case 'pass_att': return passing ? z('att') : null;
        case 'pass_td': return passing ? z('pass_td') : null;
        case 'rush_rec_yds': return z('rush_yds') + z('rec_yds');
        case 'pass_rush_yds': return passing ? z('pass_yds') + z('rush_yds') : null;
        case 'anytime_td': case 'two_td': case 'three_td': return z('rush_td') + z('rec_td');
      }
      return null;
    }
    switch (m) {
      case 'pra': return z('pts') + z('reb') + z('ast');
      case 'pr': return z('pts') + z('reb');
      case 'pa': return z('pts') + z('ast');
      case 'ra': return z('reb') + z('ast');
      case 'dbl_dbl': case 'trp_dbl': var n = ['pts', 'reb', 'ast'].filter(function (x) { return z(x) >= 10; }).length; return n;
    }
    return g[m] == null ? null : z(m);
  }
  function strip(p) {
    var seq = OPEN_SEQ, k = p.sport, m = p.mkt;
    var line = m === 'dbl_dbl' ? 1.5 : m === 'trp_dbl' ? 2.5 : m === 'two_td' ? 1.5 : m === 'three_td' ? 2.5 : m === 'anytime_td' ? 0.5 : p.line;
    pgLoad(k).then(function (by) {
      var box = document.getElementById('oxtG'); if (!box || seq !== OPEN_SEQ) return;
      var gs = (by['i' + p.who] || by['n' + nk(p.name)] || []).map(function (g) { return {g: g, v: val(k, m, g)}; }).filter(function (x) { return x.v != null; }).slice(0, 10).reverse();
      if (!gs.length || line == null) { box.innerHTML = '<p>Last games vs this line</p><div class="oxt-gm">No game logs for ' + esc(p.name || 'this player') + ' yet.</div>'; return; }
      var under = p.side === 'under';
      var hit = function (v) { return under ? v < line : v > line; };
      var n = gs.filter(function (x) { return hit(x.v); }).length;
      var top = Math.max(line * 1.6, Math.max.apply(null, gs.map(function (x) { return x.v; })), 1);
      var lbl = function (v) { return m === 'dbl_dbl' || m === 'trp_dbl' ? (v >= (m === 'dbl_dbl' ? 2 : 3) ? 'Y' : 'N') : (Math.round(v * 10) / 10); };
      box.innerHTML = '<p>Last ' + gs.length + ': <b>' + n + ' of ' + gs.length + '</b> ' + (under ? 'under' : 'over') + ' ' + esc(line) + '</p><div class="oxt-bars" role="img" aria-label="' + esc(n + ' of the last ' + gs.length + ' games cleared this side of ' + line) + '">'
        + gs.map(function (x) { return '<i class="' + (hit(x.v) ? 'w' : '') + '" style="height:' + Math.max(4, Math.round(100 * x.v / top)) + '%" title="' + esc((x.g.date || '') + (x.g.opp ? ' vs ' + x.g.opp : '') + ': ' + x.v) + '"><span>' + esc(lbl(x.v)) + '</span></i>'; }).join('')
        + '<em style="bottom:' + Math.min(100, Math.round(100 * line / top)) + '%"></em></div>';
    });
  }

  // ── the tap ───────────────────────────────────────────────────────────────────────────────
  function armed() {
    try { if (window.OnyxParlay && OnyxParlay.armed && OnyxParlay.armed()) return true; } catch (e) {}
    return window.parlayMode === true;
  }
  var PRESS = null, SUPPRESS = null;
  window.addEventListener('pointerdown', function (e) {
    PRESS = null;
    if (e.button !== 0 || armed()) return;
    var c = candidate(e.target); if (!c) return;
    index();                                                       // warm the board while the finger is down
    PRESS = {el: c.el, t: Date.now(), x: e.clientX, y: e.clientY, type: e.pointerType, url: c.url, long: false};
    if (e.pointerType !== 'mouse') PRESS.timer = setTimeout(function () { if (PRESS && PRESS.el === c.el) PRESS.long = true; }, LONG_MS);
  }, true);
  window.addEventListener('pointermove', function (e) { if (PRESS && Math.abs(e.clientX - PRESS.x) + Math.abs(e.clientY - PRESS.y) > 12) { clearTimeout(PRESS.timer); PRESS = null; } }, true);
  window.addEventListener('pointercancel', function () { if (PRESS) clearTimeout(PRESS.timer); PRESS = null; }, true);
  // a long-press on a touch screen: open Onyx on release (pointerup carries the user gesture), no card
  window.addEventListener('pointerup', function (e) {
    if (!PRESS) return;
    clearTimeout(PRESS.timer);
    var long = PRESS.long || (PRESS.type === 'mouse' ? false : Date.now() - PRESS.t >= LONG_MS);
    if (long && PRESS.url) {
      SUPPRESS = {el: PRESS.el, t: Date.now()};
      gt('onyx_click', {link_type: 'long_press'});
      window.open(PRESS.url, '_blank', 'noopener');
    }
    PRESS = null;
  }, true);
  window.addEventListener('contextmenu', function (e) { if (PRESS && PRESS.type !== 'mouse' && candidate(e.target)) e.preventDefault(); }, true);

  window.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var t = e.target;
    if (SUPPRESS && Date.now() - SUPPRESS.t < 800 && SUPPRESS.el.contains(t)) { SUPPRESS = null; e.preventDefault(); e.stopPropagation(); return; }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // straight to Onyx, the page's own way
    if (armed()) return;                                             // the parlay builder adds the leg
    var c = candidate(t); if (!c) return;
    e.preventDefault(); e.stopPropagation();
    go(c);
  }, true);

  function go(c) {
    if (c.mlb) { var mp = mlbPlay(c); open(mp, c.el, c.url, false); if (CUR) CUR.mlbRaw = c.mlb; return; }
    var hint = c.hint && c.hint.play ? c.hint.play : null;
    var info = !hint ? selInfo(c.sel) : null;
    var base = Object.assign({sport: PAGE_SPORT && PAGE_SPORT !== 'mlb' ? PAGE_SPORT : null, sel: c.sel, price: c.price, label: c.label || textLabel(c.el)}, info || {}, hint || {});
    if (base.price == null) base.price = c.price;
    var have = IDX_READY && IDX_READY[c.sel];
    if (have) { open(Object.assign({}, base, have), c.el, c.url, false); return; }
    open(base, c.el, c.url, true);
    var seq = OPEN_SEQ, el = c.el;
    find(c.sel).then(function (row) {
      if (seq !== OPEN_SEQ || !CUR || CUR.p.sel !== c.sel) return;
      var p = row ? Object.assign({}, base, row) : base;
      CUR.p = p; render(p, CUR.url, false); place(el);
    });
  }

  function boot() {
    build();
    // warm the board once the page is idle, so the first tap opens a full card
    var warm = function () { if (document.querySelector(CAND)) index(); };
    if ('requestIdleCallback' in window) requestIdleCallback(warm, {timeout: 4000}); else setTimeout(warm, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.OnyxTap = {
    open: function (p, anchor) { if (p) open(p, anchor || null, p.sel ? share(p.sel) : null, false); },
    close: close,
    isOpen: function () { return !!(ROOT && !ROOT.hidden && ROOT.classList.contains('on')); },
    accepts: function (el) { return !!candidate(el); }                 // for tools/verify_tap.js
  };
})();
