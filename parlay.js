// parlay.js - the Parlay Builder on every page (11/8, Jordan: "we had parlay builder fully working on onyx baseball
// original"). The Onyx Baseball builder (shell.html parlayToggle / renderParlaySlip), brought to every sport:
//   - the floating "Parlay Builder" pill; tap it to arm, and every odds button on the page adds a leg instead of
//     opening Onyx (tap the same play again to take it off); any row with a save star counts, so every sport works
//   - the slip: each leg and its price, combined odds, what $10 pays, and, new: our chance every leg hits, value
//     against the odds you got, and Save parlay to my account (one ticket, tracked and graded, saved.js)
//   - Build on Onyx: every leg in one share link (repeated selection params); while Onyx's feed is down the legs have
//     no Onyx id, so it says so and the ticket can still be saved and tracked
//   - the slip survives a reload (localStorage onyxSlipAll); both sides of one bet are never on it together
// OnyxParlay.add(pick) adds a leg directly (the "+ Add" buttons on picks.html).
(function () {
  'use strict';
  // Onyx Baseball (index.html) and the NBA page keep their own builders (every odds cell there adds a leg)
  if (window.OnyxParlay || document.getElementById('parlayFab') || typeof window.renderParlaySlip === 'function' || /(^|\/)(index|nba)\.html$|\/$/.test(location.pathname)) return;
  var KEY = 'onyxSlipAll', ARMED = false, OPEN = false, REFERRER = 'KR680261';
  var slip = []; try { slip = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { slip = []; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(slip)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null ? '' : (a > 0 ? '+' : '') + a; }
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function amer(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function toast(m) { try { if (window.OX_TOAST) window.OX_TOAST(m, {}); } catch (e) {} }
  var KEEP = ['id', 'sel', 'sport', 'label', 'matchup', 'start', 'gid', 'team', 'price', 'conf', 'kind', 'mkt', 'side', 'line', 'hcap', 'name', 'src'];
  function leg(p) {
    if (window.OnyxSaved && OnyxSaved.withId) p = OnyxSaved.withId(Object.assign({id: p.sel}, p));
    var l = {}; KEEP.forEach(function (k) { if (p[k] != null) l[k] = p[k]; }); return l;
  }
  // one bet: the same game, market and player (or the side of a game line)
  function bet(l) { return [l.sport, l.gid || l.matchup, l.kind === 'prop' ? l.mkt + ':' + (l.name || '') : l.kind].join('|'); }
  function add(p) {
    if (!p || !p.label) return;
    var l = leg(p);
    if (slip.some(function (x) { return x.id === l.id; })) { remove(l.id); return; }          // tap again = remove
    if (Date.parse(l.start) <= Date.now()) { toast('That game has started'); return; }
    var other = slip.filter(function (x) { return bet(x) === bet(l); })[0];
    if (other) { slip = slip.filter(function (x) { return x !== other; }); toast('Swapped to ' + l.label + ' (both sides of one bet cannot ride together)'); }
    if (slip.length >= 12) { toast('12 legs is the most a slip holds'); return; }
    slip.push(l); save(); draw();
    if (!OPEN) toast('Added: ' + l.label + ' · ' + slip.length + ' leg' + (slip.length === 1 ? '' : 's') + ' on your slip (tap the pill to see it)');
    try { if (window.gtag) gtag('event', 'parlay_add', {sport: l.sport, legs: slip.length}); } catch (e) {}
  }
  function remove(id) { slip = slip.filter(function (x) { return x.id !== id; }); save(); draw(); }
  function clear() { slip = []; save(); draw(); }
  function totals() {
    var priced = slip.length > 0 && slip.every(function (x) { return x.price != null; });
    var d = priced ? slip.reduce(function (m, x) { return m * dec(x.price); }, 1) : null;
    var prob = slip.length && slip.every(function (x) { return x.conf != null; }) ? slip.reduce(function (m, x) { return m * x.conf; }, 1) : null;
    var games = {}; slip.forEach(function (x) { var g = x.sport + '|' + (x.gid || x.matchup); games[g] = (games[g] || 0) + 1; });
    return {dec: d, price: d && d > 1 ? amer(d) : null, prob: prob, sameGame: Object.keys(games).some(function (k) { return games[k] > 1; }),
            onyx: slip.length > 0 && slip.every(function (x) { return x.sel; })};
  }
  function build() {
    var T = totals(); if (!T.onyx) return;
    var u = 'https://app.onyxodds.com/share?' + slip.map(function (x) { return 'selection=' + encodeURIComponent(x.sel); }).join('&') + '&referrer=' + REFERRER;
    try { if (window.gtag) gtag('event', 'onyx_click', {link_type: 'parlay', legs: slip.length}); } catch (e) {}
    window.open(u, '_blank', 'noopener');
  }
  function saveTicket() {
    if (!window.OnyxSaved || !OnyxSaved.saveTicket || slip.length < 2) return;
    var T = totals(), my = (document.getElementById('pbMy') || {}).value;
    my = String(my || '').trim().replace(/^\+/, '');
    var t = OnyxSaved.saveTicket(slip, {price: T.price, label: slip.length + '-leg parlay', my_price: my ? +my : null});
    if (t) toast('Saved to My picks: ' + t.label + (my ? ' at ' + odds(+my) : '') + '. Tracked and graded with your picks.');
  }
  // ── the pill and the slip ────────────────────────────────────────────────
  var CSS = [
    '#oxPB{position:fixed;right:12px;bottom:calc(86px + var(--sab,0px));z-index:9100;display:flex;flex-direction:column;align-items:flex-end;gap:8px;width:min(340px,calc(100vw - 24px));pointer-events:none}',
    '@media (min-width:1025px){#oxPB{bottom:18px}}',
    '#oxPB>*{pointer-events:auto}',
    '.pbx-fab{background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff;font:800 12px monospace;letter-spacing:.03em;padding:10px 15px;border-radius:22px;cursor:pointer;box-shadow:0 4px 18px rgba(122,44,224,.45);border:0;user-select:none}',
    '.pbx-fab.on{background:linear-gradient(135deg,#1f8f2d,#61e970);box-shadow:0 4px 18px rgba(97,233,112,.4)}',
    '.pbx-fab b{background:rgba(0,0,0,.25);border-radius:10px;padding:1px 7px;margin-left:5px}',
    '.pbx{background:#151318;border:1.5px solid rgba(176,56,249,.55);border-radius:14px;padding:11px 12px;width:100%;box-sizing:border-box;box-shadow:0 8px 30px rgba(0,0,0,.65);max-height:min(48vh,440px);overflow-y:auto;color:#eee}',
    '.pbx-h{display:flex;justify-content:space-between;align-items:center;font:900 10px monospace;letter-spacing:.12em;color:#d795ff;margin-bottom:6px}',
    '.pbx-h span{cursor:pointer;color:#9a93a6;letter-spacing:0;font-weight:700}',
    '.pbx-l{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:12.5px}',
    '.pbx-l b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pbx-l small{display:block;font:600 10px monospace;color:#8f879c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pbx-l em{font:700 11px monospace;font-style:normal;color:#cfc8da;flex:none}.pbx-l i{color:#ff7a90;font-style:normal;font-weight:900;cursor:pointer;padding:0 4px;flex:none}',
    '.pbx-t{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin:9px 0 6px;font:600 11.5px monospace;color:#b9b2c4}.pbx-t b{display:block;color:#fff;font-size:14px}.pbx-t b.up{color:#61e970}.pbx-t b.dn{color:#ff8a8a}',
    '.pbx-my{display:flex;gap:6px;align-items:center;margin:6px 0;font:600 11px monospace;color:#9a93a6}.pbx-my input{width:84px;background:#0d0a12;border:1px solid #3a2a55;border-radius:8px;padding:6px 8px;color:#fff;font:600 12px monospace}',
    '.pbx-v{font:600 11px monospace;line-height:1.5;color:#cfc8da;margin-bottom:6px}.pbx-v b.up{color:#61e970}.pbx-v b.dn{color:#ff8a8a}',
    '.pbx-b{display:flex;gap:6px;flex-wrap:wrap}.pbx-b button{flex:1;font:800 11.5px monospace;border:0;border-radius:9px;padding:9px 10px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#7a2ce0,#b038f9)}',
    '.pbx-b button.alt{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18)}.pbx-b button[disabled]{opacity:.45;cursor:default}',
    '.pbx-n{font:600 10.5px monospace;color:#d795ff;margin-top:6px;line-height:1.45}',
    'body.pb-armed .t10-bet,body.pb-armed .bet,body.pb-armed .btn-primary,body.pb-armed .oc:not(.dead),body.pb-armed .chipx:not(.dead),body.pb-armed [onclick*="bet(\\\'"],body.pb-armed a[href*="onyxodds.com/share"]{box-shadow:0 0 0 1.5px rgba(97,233,112,.8),0 0 10px rgba(97,233,112,.35)!important}'
  ].join('\n');
  function draw() {
    var el = document.getElementById('oxPB');
    if (!el) {
      if (!document.body) return;
      var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      el = document.createElement('div'); el.id = 'oxPB'; document.body.appendChild(el);
    }
    document.body.classList.toggle('pb-armed', ARMED);
    var n = slip.length, T = totals();
    var myv = (document.getElementById('pbMy') || {}).value || '';
    var V = T.prob && window.OnyxSaved && OnyxSaved.value ? OnyxSaved.value(T.prob, myv ? String(myv).replace(/^\+/, '') : T.price) : null;
    var panel = (OPEN || ARMED) && n ? '<div class="pbx"><div class="pbx-h">PARLAY SLIP · ' + n + ' LEG' + (n === 1 ? '' : 'S') + '<span><span data-pb="clear">clear</span> · <span data-pb="hide">hide</span></span></div>'
      + slip.map(function (x) { return '<div class="pbx-l"><b>' + esc(x.label) + '<small>' + esc([x.sport ? x.sport.toUpperCase() : '', x.matchup].filter(Boolean).join(' · ')) + '</small></b><em>' + esc(odds(x.price)) + '</em><i data-pb-x="' + esc(x.id) + '" aria-label="Remove">×</i></div>'; }).join('')
      + (n >= 2 ? '<div class="pbx-t"><div>Combined<b>' + (T.price != null ? esc(odds(T.price)) : '-') + '</b></div><div>$10 pays<b class="up">' + (T.dec ? '$' + (10 * T.dec).toFixed(0) : '-') + '</b></div>'
        + '<div>Our chance all hit<b>' + (T.prob != null ? (100 * T.prob).toFixed(1) + '%' : '-') + '</b></div><div>Value<b class="' + (V ? (V.good ? 'up' : 'dn') : '') + '">' + (V ? (V.ev100 > 0 ? '+' : '') + V.ev100 + ' / $100' : '-') + '</b></div></div>'
        + '<div class="pbx-my">Odds you got<input id="pbMy" inputmode="text" placeholder="' + esc(odds(T.price)) + '" value="' + esc(myv) + '"><span>' + (V ? 'needs ' + Math.round(100 * V.implied) + '% · fair ' + esc(odds(V.fair)) : '') + '</span></div>'
        + '<div class="pbx-b"><button type="button" data-pb="save">Save parlay to my account</button><button type="button" class="alt" data-pb="onyx"' + (T.onyx ? '' : ' disabled') + '>Build on Onyx</button></div>'
        + (!T.onyx ? '<div class="pbx-n">Onyx\'s lines are down, so these are market prices and cannot open on Onyx yet. Save it to track it.</div>' : '')
        + (T.sameGame ? '<div class="pbx-n">Same-game legs: Onyx prices them together and usually pays less than the legs multiplied.</div>' : '')
        : '<div class="pbx-n">Add one more leg to see the parlay.</div>')
      + '</div>' : '';
    el.innerHTML = panel + '<button type="button" class="pbx-fab' + (ARMED ? ' on' : '') + '" data-pb="fab">' + (ARMED ? 'Building · tap odds to add' : 'Parlay Builder') + (n ? ' <b>' + n + '</b>' : '') + '</button>';
  }
  // the Onyx selection a line carries: a share link's selection=, or bet('<selection>', ...) in its onclick
  function selOf(b) {
    var h = b.getAttribute('href') || '', m = /[?&]selection=([^&]+)/.exec(h);
    if (m) return decodeURIComponent(m[1]);
    var oc = b.getAttribute('onclick') || '', m2 = /bet\(\s*'([^']+)'/.exec(oc);
    return m2 ? m2[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : null;
  }
  // a selection -> the full play: today's boards (every sport, loaded once), else the page's own OX_SELINFO
  var IDX = null;
  function index() {
    if (IDX) return IDX;
    IDX = Promise.all(['nfl', 'cfb', 'nba', 'cbb', 'nhl', 'tennis'].map(function (k) {
      return fetch('data/' + k + '/board.json', {cache: 'no-cache'}).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    })).then(function (fs) { var o = {}; fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { if (p.sel) o[p.sel] = p; }); }); return o; });
    return IDX;
  }
  function bySel(sel, el) {
    return index().then(function (o) {
      if (o[sel]) return o[sel];
      var i = null; try { i = window.OX_SELINFO ? window.OX_SELINFO(sel) : null; } catch (x) {}
      if (!i || !i.label) return null;
      var g = null; try { g = i.gid && typeof window.game === 'function' ? window.game(i.gid) : null; } catch (x) {}
      var sp = window.OX_SITE || (typeof SD !== 'undefined' && SD.sport) || null;
      return Object.assign({sel: sel, sport: sp, kind: i.mkt ? 'prop' : /to win$/.test(i.label) ? 'ml' : /(Over|Under) \d/.test(i.label) ? 'total' : 'spread'}, i,
        g ? {start: g.start, matchup: g.away + ' @ ' + g.home} : {});
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var pb = t.closest && t.closest('[data-pb], [data-pb-x]');
    if (pb && pb.closest('#oxPB')) {
      var a = pb.getAttribute('data-pb');
      if (pb.hasAttribute('data-pb-x')) remove(pb.getAttribute('data-pb-x'));
      else if (a === 'fab') { ARMED = !ARMED; OPEN = ARMED || !OPEN; if (ARMED) toast('Builder on: tap any odds to add a leg'); draw(); }
      else if (a === 'clear') clear();
      else if (a === 'hide') { OPEN = false; ARMED = false; draw(); }
      else if (a === 'save') saveTicket();
      else if (a === 'onyx') build();
      return;
    }
    if (!ARMED || !t.closest) return;
    // armed: every line adds to the ticket (11/8, Jordan: "wherever there's a line there needs to be a connection to
    // add to the ticket"): an Onyx link or bet('<selection>') button anywhere, or a row with a save star
    var b = t.closest('a[href*="onyxodds.com"], .t10-bet, .bet, .btn-primary, .oc, .chipx, [onclick*="bet("], [data-pick]');
    if (!b || b.closest('#oxPB')) return;
    var sel = selOf(b);
    if (sel) { e.preventDefault(); e.stopPropagation(); bySel(sel, b).then(function (p) { if (p) add(p); else toast('That line is not on today\'s Onyx board'); }); return; }
    var star = null;
    for (var n = b.parentElement, i = 0; n && i < 7 && !star; n = n.parentElement, i++) { var ss = n.querySelectorAll('.ox-save'); if (ss.length === 1) star = ss[0]; else if (ss.length > 1) break; }
    var m = star && /OnyxSaved\.tap\(this,(\d+)\)/.exec(star.getAttribute('onclick') || '');
    var p = m && window.OnyxSaved && OnyxSaved.pickAt ? OnyxSaved.pickAt(+m[1]) : null;
    if (!p) return;
    e.preventDefault(); e.stopPropagation();
    add(p);
  }, true);
  document.addEventListener('input', function (e) { if (e.target && e.target.id === 'pbMy') { var pos = e.target.selectionStart; draw(); var i = document.getElementById('pbMy'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} } } });
  // legs whose game has started leave the slip on their own
  function prune() { var n = slip.length; slip = slip.filter(function (x) { return !(Date.parse(x.start) <= Date.now()); }); if (slip.length !== n) { save(); draw(); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { prune(); draw(); }); else { prune(); draw(); }
  setInterval(prune, 60000);
  window.OnyxParlay = {add: add, remove: remove, clear: clear, slip: function () { return slip.slice(); }, arm: function (on) { ARMED = on !== false; draw(); }, armed: function () { return ARMED; }};
})();
