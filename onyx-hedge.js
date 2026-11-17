// onyx-hedge.js - hedge / lock profit, live (11/17, Jordan: "Hedge / lock profit live").
// Loaded on demand by onyx-cash.js (which every page has through ui.js). For a saved single or parlay (OnyxSaved) that is
// live and still alive, it works out the bet on the other side that locks the same profit whichever way it lands:
//   - a parlay down to its last open leg (every other leg won or pushed): the hedge is the other side of that leg;
//     a single: the other side of the same market.
//   - the hedge price: Onyx's live line on the other side (the live relay, live.js games() -> g.L.lines), else the board's
//     other-side Onyx price (data/<sport>/board.json) while that game has not started, else the price the person types.
//   - the math, shown on the sheet (all arithmetic, never a promise):
//       ticket returns   R = stake x dec(ticket price)
//       equal hedge      H = R / dec(hedge price)
//       locked profit    R - H - stake, whichever side wins
//     a slider from $0 to H shows a partial hedge (both outcomes update), and a "ride it" read compares the expected
//     value of riding with hedging using OnyxCash's live chance: arithmetic plus a projection, not advice or a guarantee.
//
// What it draws:
//   - a "Hedge available: lock $X" chip on the OnyxCash meter (My picks) and a "Lock $X" chip next to the bet on the
//     live rail, when a lock is positive; either opens the sheet with the full calculator.
//   - a "Hedge calculator" link on every open meter and on the quick bet card (onyx-tap.js), and #hedge on any page:
//     the standalone calculator (any ticket price + stake + hedge price).
//
// ── API (window.OnyxHedge) ────────────────────────────────────────────────────────────────────────────────────────
//   OnyxHedge.math: {dec(am), am(dec), full(stake, tp, hp) -> {R, H, lock, win, lose}, at(stake, tp, hp, h) ->
//     {ifTicket, ifHedge}, ev(stake, tp, hp, h, p) -> expected profit}. Prices are American odds.
//   OnyxHedge.offer(pick[, r]) -> Promise<offer|null>: r is an OnyxCash.chance() result (fetched when missing).
//     offer: {id, pick, leg, legIdx, label, hedgeLabel, tp, stake, hp, src: 'live'|'board'|null, age, sel, href, p,
//     R, H, lock}. null when the ticket is settled, lost, not live, or a parlay with 2+ open legs.
//   OnyxHedge.open(pick | offer), OnyxHedge.calc({price, stake, hedge, label, chance}), OnyxHedge.close(),
//     OnyxHedge.decorate(meterEl, pick, r) (onyx-cash.js paint), OnyxHedge.seen(pick, r) (onyx-cash.js chance),
//     OnyxHedge.stakeOf(pick) -> dollars, OnyxHedge.href(sel).
(function () {
  'use strict';
  if (window.OnyxHedge) return;
  var REF = 'KR680261', UNIT_KEY = 'onyxUnitUsd', STAKE_KEY = 'onyxHedgeStake';
  var UNIT = {pts: 'pts', reb: 'reb', ast: 'ast', threes: 'threes', rec: 'catches', rec_yds: 'rec yds', rush_yds: 'rush yds', pass_yds: 'pass yds',
    pra: 'PRA', pr: 'pts + reb', pa: 'pts + ast', ra: 'reb + ast', pass_att: 'attempts', pass_td: 'pass TD'};

  // ── the math ───────────────────────────────────────────────────────────────
  function odds(x) {   // "+150", "-120", "150", "EVEN" -> a number, or null
    if (x == null || x === '') return null;
    var s = String(x).trim().replace(/[−–]/g, '-').replace(/^\+/, '');
    if (/^even$/i.test(s)) return 100;
    var v = Math.round(+s);
    return isNaN(v) || (v > -100 && v < 100) ? null : v;
  }
  function dec(a) { a = odds(a); return a == null ? null : a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function am(d) { return d == null || !(d > 1) ? null : d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function full(stake, tp, hp) {
    var dt = dec(tp), dh = dec(hp);
    if (!(stake > 0) || !dt || !dh) return null;
    var R = stake * dt, H = R / dh, lock = R - H - stake;
    return {R: R, H: H, lock: lock, win: R - stake - H, lose: H * (dh - 1) - stake};
  }
  function at(stake, tp, hp, h) {
    var dt = dec(tp), dh = dec(hp);
    if (!(stake > 0) || !dt || !dh) return null;
    h = Math.max(0, +h || 0);
    return {ifTicket: stake * dt - stake - h, ifHedge: h * (dh - 1) - stake};
  }
  function ev(stake, tp, hp, h, p) {
    var o = at(stake, tp, hp, h);
    if (!o || p == null || !(p >= 0 && p <= 1)) return null;
    return p * o.ifTicket + (1 - p) * o.ifHedge;
  }
  var math = {dec: dec, am: am, full: full, at: at, ev: ev, odds: odds};

  // ── small helpers ────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sameTeam(a, b) {
    a = nk(a); b = nk(b);
    if (!a || !b) return false;
    if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    var x = a.split(' '), y = b.split(' ');
    return x.length > 1 && y.length > 1 && x[x.length - 1] === y[y.length - 1] && x[x.length - 1].length > 3;
  }
  function last(n) { n = String(n || '').trim().split(/\s+/); return n[n.length - 1] || ''; }
  function sgn(x) { x = +x; return x > 0 ? '+' + x : x === 0 ? 'pk' : String(x); }
  function pr(a) { return a == null ? '' : a > 0 ? '+' + a : String(a); }
  function pct(x) { return x == null ? '' : x >= 0.995 && x < 1 ? '99%' : x > 0 && x < 0.01 ? '1%' : Math.round(100 * x) + '%'; }
  function money(x, whole) {
    if (x == null || isNaN(x)) return '';
    var n = Math.abs(x), s = whole ? String(Math.round(n)) : n.toFixed(2);
    var parts = s.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (x < 0 && (whole ? Math.round(n) : Math.round(n * 100)) !== 0 ? '-' : '') + '$' + parts.join('.');
  }
  function signed(x) { return x == null || isNaN(x) ? '' : (x > 0.004 ? '+' : '') + money(x); }
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function href(sel) { return sel ? 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(sel) + '&referrer=' + REF : 'https://app.onyxodds.com/?referrer=' + REF; }
  function toast(m) { try { if (window.OX_TOAST) window.OX_TOAST(m, {}); } catch (e) {} }
  function gt(name, o) { try { if (window.gtag) window.gtag('event', name, o || {}); } catch (e) {} }

  // ── the stake, in dollars: what the person set here, else their saved units x their unit size ($10 unless set) ──
  function unitUsd() { var u = +lsGet(UNIT_KEY, 10); return u > 0 ? u : 10; }
  function stakeOf(p) {
    if (!p) return null;
    var o = lsGet(STAKE_KEY, {}), v = o && +o[p.id];
    if (v > 0) return v;
    var units = window.OnyxSaved && OnyxSaved.stakeOf ? OnyxSaved.stakeOf(p) : +p.stake > 0 ? +p.stake : 1;
    return Math.round(units * unitUsd() * 100) / 100;
  }
  function stakeSet(p) { var o = lsGet(STAKE_KEY, {}); return !!(p && o && +o[p.id] > 0) || !!(p && +p.stake > 0); }
  function setStake(id, v) {
    var o = lsGet(STAKE_KEY, {}) || {};
    if (v > 0) o[id] = Math.round(v * 100) / 100; else delete o[id];
    var ks = Object.keys(o); if (ks.length > 80) ks.slice(0, ks.length - 80).forEach(function (k) { delete o[k]; });
    lsSet(STAKE_KEY, o);
  }
  // the ticket's price: the odds the person got, else the Onyx price saved, else (a parlay) the legs multiplied
  function priceOf(p) {
    var v = window.OnyxSaved && OnyxSaved.priceOf ? OnyxSaved.priceOf(p) : (p.my_price != null ? +p.my_price : p.price != null ? +p.price : null);
    if (odds(v) != null) return odds(v);
    if (p.kind === 'parlay' && (p.legs || []).length && p.legs.every(function (l) { return dec(l.price); })) return am(p.legs.reduce(function (m, l) { return m * dec(l.price); }, 1));
    return null;
  }

  // ── the other side of a leg ──────────────────────────────────────────────
  function teamsOf(l) { return String(l.matchup || '').split(/\s+@\s+|\s+vs\.?\s+|\s+at\s+/i).map(function (s) { return s.trim(); }).filter(Boolean); }
  function other(l) {
    var k = l.kind, me = l.name || l.team, T = teamsOf(l);
    var opp = T.filter(function (t) { return t !== me && nk(t) !== nk(me) && nk(last(t)) !== nk(last(me)); })[0] || null;
    if (k === 'ml') return {kind: 'ml', team: opp, label: (opp || 'The other side') + ' to win'};
    if (k === 'spread') { var h = l.hcap != null ? -l.hcap : null; return {kind: 'spread', team: opp, hcap: h, label: (opp || 'The other side') + (h != null ? ' ' + sgn(h) : '')}; }
    if (k === 'total') { var s = l.side === 'under' ? 'over' : 'under'; return {kind: 'total', side: s, line: l.line, label: (s === 'over' ? 'Over ' : 'Under ') + l.line + (l.mkt && l.mkt !== 'total' ? ' ' + l.mkt.replace(/_/g, ' ') : '')}; }
    if (k === 'prop') {
      if (l.mkt === 'anytime_td') return {kind: 'prop', mkt: l.mkt, name: l.name, none: true, label: 'No ' + (l.name || 'player') + ' TD'};
      var sd = l.side === 'under' ? 'over' : 'under';
      return {kind: 'prop', mkt: l.mkt, name: l.name, side: sd, line: l.line, label: (l.name || '') + ' ' + (sd === 'over' ? 'Over ' : 'Under ') + l.line + (UNIT[l.mkt] ? ' ' + UNIT[l.mkt] : '')};
    }
    return {kind: k, label: 'The other side of ' + (l.label || 'this bet')};
  }

  // ── the hedge price: Onyx's live line first ──────────────────────────────
  function ensureLive() {
    if (window.OnyxLive) return Promise.resolve(true);
    if (window.OnyxCash && OnyxCash.ensureLive) return OnyxCash.ensureLive();
    return Promise.resolve(false);
  }
  var GAMES = {};   // sport -> {t, p}: OnyxLive.games, shared by every offer for 20 s
  function liveGames(sport) {
    var c = GAMES[sport];
    if (c && Date.now() - c.t < 20e3) return c.p;
    var p = ensureLive().then(function (ok) { return ok && OnyxLive.games ? OnyxLive.games([sport]) : []; }).catch(function () { return []; });
    GAMES[sport] = {t: Date.now(), p: p};
    return p;
  }
  function gameFor(G, l) {
    var id = l.gid != null ? String(l.gid) : null, T = teamsOf(l);
    return (G || []).filter(function (g) { return id && String(g.gid) === id; })[0]
      || (G || []).filter(function (g) {
        if (l.sport === 'tennis') return [g.hn, g.an, g.home, g.away].some(function (n) { return n && nk(n) === nk(l.name); });
        return T.length === 2 && T.indexOf(g.home) >= 0 && T.indexOf(g.away) >= 0;
      })[0] || null;
  }
  function livePrice(l, o) {
    if (o.none) return Promise.resolve(null);
    return liveGames(l.sport).then(function (G) {
      var g = gameFor(G, l); if (!g || !g.L || !(g.L.lines || []).length) return null;
      var me = l.name || l.team, homeMe = me === g.home || (l.sport === 'tennis' && nk(me) === nk(g.hn)) ? true : me === g.away || (l.sport === 'tennis' && nk(me) === nk(g.an)) ? false : null;
      var oppFull = homeMe == null ? null : homeMe ? g.an : g.hn, meFull = homeMe == null ? null : homeMe ? g.hn : g.an;
      var isOpp = function (sel) { return oppFull && sameTeam(sel, oppFull) && !sameTeam(sel, meFull); };
      var hit = g.L.lines.filter(function (x) {
        if (x.price == null || odds(x.price) == null) return false;
        if (o.kind === 'ml') return x.m === 'ml' && isOpp(x.sel);
        if (o.kind === 'spread') return x.m === 'spread' && x.pt != null && +x.pt === +o.hcap && isOpp(x.sel);
        if (o.kind === 'total') return x.m === 'total' && x.side === o.side && x.pt != null && +x.pt === +o.line;
        if (o.kind === 'prop') return x.m === o.mkt && x.side === o.side && x.pt != null && +x.pt === +o.line && nk(x.sel) === nk(o.name);
        return false;
      })[0];
      if (!hit) return null;
      return {price: odds(hit.price), src: 'live', age: hit.age != null ? +hit.age : null, sel: hit.id || hit.sid || hit.selection_id || null};
    }).catch(function () { return null; });
  }
  // ── else the board's other side, before that game starts ─────────────────
  var BOARDS = {};
  function board(k) {
    if (!BOARDS[k]) BOARDS[k] = fetch('data/' + k + '/board.json', {cache: 'no-cache'}).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.plays) || []; }).catch(function () { return []; });
    return BOARDS[k];
  }
  function boardPrice(l, o) {
    if (o.none || !l.sport || l.sport === 'multi') return Promise.resolve(null);
    var me = l.name || l.team;
    return board(l.sport).then(function (P) {
      var same = function (x) { return (l.gid != null && String(x.gid) === String(l.gid)) || (l.matchup && x.matchup === l.matchup); };
      var hit = P.filter(function (x) {
        if (!same(x) || odds(x.price) == null) return false;
        if (o.kind === 'ml') return x.kind === 'ml' && x.name !== me;
        if (o.kind === 'spread') return x.kind === 'spread' && x.name !== me && x.hcap != null && +x.hcap === +o.hcap;
        if (o.kind === 'total') return x.kind === 'total' && x.side === o.side && +x.line === +o.line && (x.mkt || 'total') === (l.mkt || 'total');
        if (o.kind === 'prop') return x.kind === 'prop' && x.mkt === o.mkt && x.side === o.side && +x.line === +o.line && nk(x.name) === nk(o.name);
        return false;
      })[0];
      return hit ? {price: odds(hit.price), src: 'board', age: null, sel: hit.sel || null} : null;
    }).catch(function () { return null; });
  }

  // ── the offer for one saved ticket ───────────────────────────────────────
  var OFF = {}, LAST_R = {}, LISTEN = [];
  function legOf(pick, r) {
    if (!r || r.res) return null;                        // settled, cashed or lost
    if (pick.kind === 'parlay') {
      var legs = pick.legs || [], R = r.legs || [];
      if (!legs.length || R.length !== legs.length || R.some(function (x) { return x.res === 'L'; })) return null;
      var open = []; R.forEach(function (x, j) { if (!x.res) open.push(j); });
      if (open.length !== 1) return null;               // not down to its last leg
      var j = open[0];
      return {leg: legs[j], idx: j, state: R[j].state, p: R[j].p, pushedLegs: legs.filter(function (l, i) { return R[i].res === 'P'; })};
    }
    return {leg: pick, idx: -1, state: r.state, p: r.p, pushedLegs: []};
  }
  function offer(pick, r) {
    if (!pick) return Promise.resolve(null);
    var rp = r ? Promise.resolve(r) : window.OnyxCash && OnyxCash.chance ? OnyxCash.chance(pick).catch(function () { return null; }) : Promise.resolve(null);
    return rp.then(function (r) {
      if (!r || r.state !== 'live') return null;         // live and still alive only
      var L = legOf(pick, r); if (!L) return null;
      var key = pick.id + '|' + L.idx + '|' + L.state, c = OFF[pick.id];
      if (c && c.key === key && Date.now() - c.t < 25e3) return c.p.then(function (o) { return o ? withMath(Object.assign({}, o, {p: r.p, stake: stakeOf(pick)})) : o; });
      var l = L.leg, o = other(l);
      var pp = livePrice(l, o).then(function (x) { return x || (L.state === 'pre' ? boardPrice(l, o) : null); });
      var p = pp.then(function (x) {
        var tp = priceOf(pick);
        // a pushed leg drops out of the payout: take its price back out when it is known
        L.pushedLegs.forEach(function (pl) { var d = dec(pl.my_price != null ? pl.my_price : pl.price); if (tp != null && d && dec(tp) / d > 1) tp = am(dec(tp) / d); });
        return withMath({id: pick.id, pick: pick, leg: l, legIdx: L.idx, label: pick.kind === 'parlay' ? (pick.legs || []).length + '-leg parlay' : (pick.label || l.label || 'Your bet'),
          legLabel: l.label || l.name || '', legState: L.state, hedgeLabel: o.label, none: !!o.none, tp: tp, stake: stakeOf(pick), stakeSet: stakeSet(pick),
          hp: x ? x.price : null, src: x ? x.src : null, age: x ? x.age : null, sel: x ? x.sel : null, p: r.p, legP: L.p,
          won: (r.legs || []).filter(function (y) { return y.res === 'W'; }).length, n: (pick.legs || []).length});
      });
      OFF[pick.id] = {key: key, t: Date.now(), p: p};
      return p;
    }).catch(function () { return null; });
  }
  function withMath(o) {
    var f = full(o.stake, o.tp, o.hp);
    o.R = f ? f.R : null; o.H = f ? f.H : null; o.lock = f ? f.lock : null; o.href = href(o.sel);
    return o;
  }
  // the latest offer we know of, without waiting (chips repaint at once on a redraw)
  var KNOWN = {};
  function remember(o) { if (o && o.id) KNOWN[o.id] = o; return o; }

  // ── the chip on the OnyxCash meter ───────────────────────────────────────
  function rowHTML(pick, o, r) {
    var chip = o && o.lock != null && o.lock > 0.005
      ? '<button type="button" class="ohg-chip" data-ohg-open="' + esc(pick.id) + '" aria-label="' + esc('Hedge available: lock ' + money(o.lock) + ' either way. Open the hedge calculator') + '">'
        + '<span class="ohg-dot"></span>Hedge available: lock <b>' + esc(money(o.lock, o.lock >= 10)) + '</b></button>'
      : '';
    var link = '<button type="button" class="ohg-link" data-ohg-calc="' + esc(pick.id) + '">Hedge calculator</button>';
    return chip + (chip ? '' : link);
  }
  function decorate(box, pick, r) {
    if (!box || !pick) return;
    css();
    var row = box.querySelector('.ohg-row');
    var settled = r && (r.res === 'W' || r.res === 'L' || r.res === 'P' || r.state === 'final');
    if (settled) { if (row) row.remove(); return; }
    if (!row) { row = document.createElement('div'); row.className = 'ohg-row'; box.appendChild(row); }
    var known = KNOWN[pick.id];
    if (!(r && r.state === 'live')) known = null;
    row.innerHTML = rowHTML(pick, known, r);
    if (!(r && r.state === 'live')) return;
    offer(pick, r).then(function (o) {
      remember(o); if (!o) delete KNOWN[pick.id];
      if (!row.isConnected) return;
      row.innerHTML = rowHTML(pick, o, r);
      paintRail();
    });
  }
  // onyx-cash.js tells us every chance it works out (the live rail calls chance(), not mount())
  function seen(pick, r) {
    if (!pick || !pick.id || !r) return;
    LAST_R[pick.id] = {pick: pick, r: r};
    if (r.state !== 'live' || r.res) { if (KNOWN[pick.id]) { delete KNOWN[pick.id]; railSoon(); } return; }
    offer(pick, r).then(function (o) { if (o) remember(o); else delete KNOWN[pick.id]; railSoon(); });
  }

  // ── the live rail: a "Lock $X" chip after the pinned bet (onyx-live-rail.js redraws its bets; we follow) ──
  var railTimer = null, railObs = null, railEl = null;
  function railSoon() { clearTimeout(railTimer); railTimer = setTimeout(paintRail, 60); }
  function paintRail() {
    var r = document.getElementById('onyxRail') || (window.OnyxRail && OnyxRail.el && OnyxRail.el());
    if (!r) return;
    if (r !== railEl) {
      railEl = r;
      if (railObs) railObs.disconnect();
      if (window.MutationObserver) { railObs = new MutationObserver(function (m) { if (m.some(function (x) { return Array.prototype.some.call(x.addedNodes, function (n) { return n.nodeType === 1 && !(n.classList && n.classList.contains('ohg-rc')); }); })) railSoon(); }); railObs.observe(r, {childList: true, subtree: true}); }
    }
    css();
    Array.prototype.forEach.call(r.querySelectorAll('.olr-bet[data-b]'), function (a) {
      var id = a.getAttribute('data-b'), o = KNOWN[id], nx = a.nextElementSibling, has = nx && nx.classList.contains('ohg-rc') ? nx : null;
      if (!o || !(o.lock > 0.005)) { if (has) has.remove(); return; }
      var txt = 'Lock ' + money(o.lock, true);
      if (has && has.getAttribute('data-ohg-open') === id && has.textContent === txt) return;
      var b = has || document.createElement('button');
      b.type = 'button'; b.className = 'ohg-rc'; b.setAttribute('data-ohg-open', id); b.textContent = txt;
      b.setAttribute('aria-label', 'Hedge available: lock ' + money(o.lock) + ' either way. Open the hedge calculator');
      if (!has) a.parentNode.insertBefore(b, a.nextSibling);
    });
  }

  // ── the sheet: the full calculator ───────────────────────────────────────
  var ROOT = null, CARD = null, CUR = null, LASTF = null, TICK = null;
  function build() {
    if (ROOT) return;
    css();
    ROOT = document.createElement('div'); ROOT.id = 'ohgRoot'; ROOT.hidden = true;
    ROOT.innerHTML = '<div class="ohg-bg" data-ohg-x="1"></div><div class="ohg-c" role="dialog" aria-modal="true" aria-labelledby="ohgT" tabindex="-1"></div>';
    document.body.appendChild(ROOT);
    CARD = ROOT.querySelector('.ohg-c');
    ROOT.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-ohg-x]')) { close(); return; }
      if (t.closest('[data-ohg-copy]')) { copy(); return; }
      if (t.closest('[data-ohg-full]')) { if (CUR) { CUR.h = null; CUR.hTouched = false; numbers(); } return; }
      if (t.closest('[data-ohg-bet]')) { gt('onyx_click', {link_type: 'hedge', sport: CUR && CUR.o && CUR.o.leg ? CUR.o.leg.sport || '' : ''}); }
    });
    ROOT.addEventListener('input', function (e) {
      var t = e.target, k = t.getAttribute('data-ohg-in'); if (!k || !CUR) return;
      if (k === 'h') { CUR.h = +t.value; CUR.hTouched = true; numbers(); return; }
      if (k === 'stake') { var v = +String(t.value).replace(/[$,\s]/g, ''); CUR.stake = v > 0 ? v : null; if (CUR.o && v > 0) setStake(CUR.o.id, v); }
      if (k === 'tp') CUR.tp = odds(t.value);
      if (k === 'hp') { CUR.hp = odds(t.value); CUR.hpTyped = true; }
      if (k === 'p') { var q = +String(t.value).replace(/%/g, ''); CUR.p = q > 0 && q < 100 ? q / 100 : null; }
      CUR.h = null; CUR.hTouched = false;
      numbers();
    });
    document.addEventListener('keydown', function (e) {
      if (!ROOT || ROOT.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        var f = Array.prototype.filter.call(CARD.querySelectorAll('a[href],button,input'), function (x) { return x.offsetParent !== null && !x.disabled; });
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
  }
  function srcTxt(o) {
    if (!o) return '';
    if (o.src === 'live') return 'Onyx live price' + (o.age != null ? ', ' + (o.age < 60 ? o.age + 's old' : Math.round(o.age / 60) + 'm old') : '');
    if (o.src === 'board') return 'Onyx price before the start';
    return o.none ? 'Onyx may not post this side; type the price you see' : 'No live Onyx price found; type the price you see at Onyx';
  }
  function show() {
    var was = !ROOT.hidden;
    if (!was) LASTF = document.activeElement;
    ROOT.hidden = false;
    ROOT.classList.toggle('sheet', innerWidth < 761);
    if (!ROOT.classList.contains('on')) { void CARD.offsetWidth; ROOT.classList.add('on'); }   // also when reopened mid-close
    try { CARD.focus({preventScroll: true}); } catch (e) { CARD.focus(); }
  }
  function close() {
    if (!ROOT || ROOT.hidden) return;
    clearTimeout(TICK); CUR = null;
    ROOT.classList.remove('on');
    setTimeout(function () { if (!ROOT.classList.contains('on')) { ROOT.hidden = true; CARD.innerHTML = ''; } }, 180);
    try { if (LASTF && LASTF.focus) LASTF.focus({preventScroll: true}); } catch (e) {}
  }
  // open(pick | offer): the calculator for a saved ticket, filled with what we know
  function open(x) {
    if (!x) return calc();
    build();
    var pick = x.pick || x, o0 = x.pick ? x : KNOWN[pick.id] || null;
    CUR = {o: o0, pick: pick, stake: o0 ? o0.stake : stakeOf(pick), tp: o0 ? o0.tp : priceOf(pick), hp: o0 ? o0.hp : null, p: o0 ? o0.p : null, h: null, standalone: false};
    draw(); show();
    gt('hedge_open', {from: 'ticket'});
    refresh();
  }
  function refresh() {
    clearTimeout(TICK);
    if (!CUR || CUR.standalone || !CUR.pick) return;
    var pick = CUR.pick;
    var go = function () {
      if (!CUR || CUR.pick !== pick || document.hidden) return Promise.resolve();
      return (window.OnyxCash && OnyxCash.chance ? OnyxCash.chance(pick).catch(function () { return null; }) : Promise.resolve(null)).then(function (r) {
        return offer(pick, r).then(function (o) {
          if (!CUR || CUR.pick !== pick) return;
          if (o) { remember(o); CUR.o = o; CUR.p = o.p; if (!CUR.hpTyped && o.hp != null) CUR.hp = o.hp; if (CUR.tp == null) CUR.tp = o.tp; }
          else if (r && CUR.o) { CUR.o = Object.assign({}, CUR.o, {gone: true, p: r.p}); CUR.p = r.p; }
          draw(true);
        });
      });
    };
    go().then(function () { if (CUR && CUR.pick === pick) TICK = setTimeout(refresh, 30e3); });
  }
  // calc({price, stake, hedge, label, chance}): the standalone calculator, any ticket
  function calc(o) {
    o = o || {};
    build();
    CUR = {o: null, pick: null, stake: +o.stake > 0 ? +o.stake : lsGet('onyxHedgeLastStake', 25), tp: odds(o.price), hp: odds(o.hedge), p: o.chance > 0 && o.chance < 1 ? +o.chance : null,
           h: null, standalone: true, label: o.label || ''};
    draw(); show();
    gt('hedge_open', {from: o.from || 'calculator'});
  }
  function field(k, label, val, hint, mode) {
    return '<label class="ohg-f"><span>' + esc(label) + '</span><input data-ohg-in="' + k + '" inputmode="' + (mode || 'text') + '" autocomplete="off" enterkeyhint="done" value="' + esc(val) + '"'
      + (hint ? ' placeholder="' + esc(hint) + '"' : '') + '></label>';
  }
  function draw(keepInputs) {
    if (!CUR) return;
    var o = CUR.o, pick = CUR.pick;
    if (keepInputs && CARD.querySelector('[data-ohg-in="tp"]')) {
      // a refresh: update the price we found (unless typed) and the read, never the person's half-typed input
      var hpIn = CARD.querySelector('[data-ohg-in="hp"]');
      if (!CUR.hpTyped && hpIn && document.activeElement !== hpIn) hpIn.value = CUR.hp != null ? pr(CUR.hp) : '';
      var src = CARD.querySelector('.ohg-src'); if (src) src.textContent = srcTxt(o);
      var sub = CARD.querySelector('.ohg-sub'); if (sub) sub.innerHTML = subHTML();
      numbers(); return;
    }
    var title = CUR.standalone ? 'Hedge calculator' : 'Hedge, lock profit';
    var h = '<div class="ohg-grab" aria-hidden="true"></div><button type="button" class="ohg-x" data-ohg-x="1" aria-label="Close">&times;</button>'
      + '<div class="ohg-k">' + (CUR.standalone ? 'Any ticket' : 'Live hedge') + '</div>'
      + '<h2 id="ohgT">' + esc(title) + '</h2>'
      + '<div class="ohg-sub">' + subHTML() + '</div>'
      + '<div class="ohg-in">'
      + field('stake', 'Your stake $', CUR.stake != null ? String(CUR.stake) : '', '25', 'decimal')
      + field('tp', 'Ticket odds', CUR.tp != null ? pr(CUR.tp) : '', '+600')
      + field('hp', 'Hedge price at Onyx', CUR.hp != null ? pr(CUR.hp) : '', '+150')
      + (CUR.standalone ? field('p', 'Chance it cashes % (optional)', CUR.p != null ? String(Math.round(CUR.p * 100)) : '', '60', 'decimal') : '')
      + '</div>'
      + (CUR.standalone ? '' : '<div class="ohg-src">' + esc(srcTxt(o)) + (pick && !(o && o.stakeSet) && !stakeSet(pick) ? '<br>No stake saved on this pick: set yours above.' : '') + '</div>')
      + '<div class="ohg-out" aria-live="polite"></div>'
      + '<div class="ohg-sl"><label for="ohgH">Hedge amount <b id="ohgHv"></b></label><input type="range" id="ohgH" data-ohg-in="h" min="0" max="100" step="1" value="100">'
      + '<div class="ohg-sx"><span>$0, ride it</span><button type="button" data-ohg-full="1">Full hedge</button></div>'
      + '<div class="ohg-two"><div><small>If the ticket cashes</small><b id="ohgW"></b></div><div><small>If the hedge wins</small><b id="ohgL"></b></div></div></div>'
      + '<div class="ohg-ride"></div>'
      + '<div class="ohg-math"></div>'
      + '<div class="ohg-acts"><a class="ohg-bet" data-ohg-bet="1" target="_blank" rel="noopener" href="' + esc(href(o && o.sel)) + '">Hedge on Onyx</a>'
      + '<button type="button" class="ohg-cp" data-ohg-copy="1">Copy amounts</button></div>'
      + '<p class="ohg-f2">Hedge math is arithmetic on the prices above, and the chance is a model projection. Not advice and not a guarantee: prices move and Onyx may not take every bet.</p>';
    CARD.innerHTML = h;
    numbers();
  }
  function subHTML() {
    var o = CUR.o;
    if (CUR.standalone) return CUR.label ? esc(CUR.label) : 'Any ticket: your stake and odds, and the price on the other side.';
    if (!o) return esc((CUR.pick && (CUR.pick.label || CUR.pick.matchup)) || 'Your bet') + '. Not down to one open bet right now: the numbers below use the prices you type.';
    var who = o.pick.kind === 'parlay' ? esc(o.label) + ': ' + o.won + ' of ' + o.n + ' won, last leg <b>' + esc(o.legLabel) + '</b>' : '<b>' + esc(o.label) + '</b>';
    var ch = CUR.p != null ? ' &middot; live chance ' + pct(CUR.p) : '';
    return who + ch + (o.gone ? '<br>This ticket has moved on (settled or more legs open): the numbers are from the prices on screen.' : '')
      + '<br>The hedge: <b>' + esc(o.hedgeLabel) + '</b>';
  }
  function numbers() {
    if (!CUR || !CARD) return;
    var S = CUR.stake, f = full(S, CUR.tp, CUR.hp), out = CARD.querySelector('.ohg-out'), sl = CARD.querySelector('#ohgH');
    var ride = CARD.querySelector('.ohg-ride'), mth = CARD.querySelector('.ohg-math'), bet = CARD.querySelector('.ohg-bet');
    if (!f) {
      out.innerHTML = '<div class="ohg-need">' + (!(S > 0) ? 'Enter your stake.' : CUR.tp == null ? 'Enter the ticket odds.' : 'Enter the hedge price you see at Onyx.') + '</div>';
      sl.disabled = true; CARD.querySelector('.ohg-sl').classList.add('off');
      CARD.querySelector('#ohgHv').textContent = ''; CARD.querySelector('#ohgW').textContent = ''; CARD.querySelector('#ohgL').textContent = '';
      ride.innerHTML = ''; mth.innerHTML = ''; CUR.f = null;
      return;
    }
    CUR.f = f;
    var max = Math.max(1, Math.ceil(f.H));
    sl.disabled = false; CARD.querySelector('.ohg-sl').classList.remove('off');
    sl.max = String(max); sl.step = max > 400 ? '5' : '1';
    var h = CUR.h == null ? f.H : Math.min(f.H, Math.max(0, CUR.h));
    if (CUR.h == null) sl.value = String(max);
    var good = f.lock > 0.005;
    out.innerHTML = '<div class="ohg-big ' + (good ? 'good' : 'bad') + '"><small>' + (good ? 'Bet this to lock a profit either way' : 'No lock at this price') + '</small>'
      + '<b data-ohg-h>' + esc(money(f.H)) + '</b><span>on ' + esc(CUR.o ? CUR.o.hedgeLabel : 'the other side') + ' at ' + esc(pr(CUR.hp)) + '</span></div>'
      + '<div class="ohg-lock ' + (good ? 'good' : 'bad') + '"><small>' + (good ? 'Locked profit, whichever side wins' : 'A full hedge loses, whichever side wins') + '</small><b data-ohg-lock>' + esc(signed(f.lock)) + '</b></div>';
    var o2 = at(S, CUR.tp, CUR.hp, h);
    CARD.querySelector('#ohgHv').textContent = money(h) + (Math.abs(h - f.H) < 0.01 ? ' (full)' : h < 0.01 ? ' (none)' : '');
    var W = CARD.querySelector('#ohgW'), L = CARD.querySelector('#ohgL');
    W.textContent = signed(o2.ifTicket); L.textContent = signed(o2.ifHedge);
    W.className = o2.ifTicket >= 0 ? 'good' : 'bad'; L.className = o2.ifHedge >= 0 ? 'good' : 'bad';
    // the ride-it read: expected value with the live chance (a projection)
    var p = CUR.p;
    if (p != null && p > 0 && p < 1) {
      var evR = ev(S, CUR.tp, CUR.hp, 0, p), evH = f.lock, evP = ev(S, CUR.tp, CUR.hp, h, p), cost = evR - evH;
      ride.innerHTML = '<div class="ohg-rk">Ride it or hedge? <span>' + (CUR.standalone ? 'your chance ' : 'live chance ') + pct(p) + ', a projection</span></div>'
        + '<div class="ohg-rg"><div><small>Ride it, expected</small><b>' + esc(signed(evR)) + '</b></div><div><small>Full hedge, certain</small><b>' + esc(signed(evH)) + '</b></div>'
        + '<div><small>This hedge, expected</small><b>' + esc(signed(evP)) + '</b></div></div>'
        + '<p>' + (cost > 0.005 ? 'At ' + pct(p) + ', riding is worth about ' + esc(money(cost)) + ' more on average than locking, with the risk of losing ' + esc(money(S)) + '. ' + (evH > 0.005 ? 'Locking trades that for a sure ' + esc(signed(evH)) + '.' : 'At this hedge price a full hedge loses ' + esc(money(-evH)) + ' either way.')
          : cost < -0.005 ? 'At ' + pct(p) + ', the hedge price is generous: locking is worth about ' + esc(money(-cost)) + ' more on average than riding.'
          : 'At ' + pct(p) + ', riding and locking are worth about the same on average.') + ' Arithmetic plus a projection, not advice or a guarantee.</p>';
    } else ride.innerHTML = CUR.standalone ? '' : '<div class="ohg-rk">Ride it or hedge? <span>no live chance yet</span></div>';
    mth.innerHTML = '<div class="ohg-mk">The math</div>'
      + '<div>Ticket returns: ' + esc(money(S)) + ' x ' + dec(CUR.tp).toFixed(3) + ' = <b>' + esc(money(f.R)) + '</b></div>'
      + '<div>Equal hedge: ' + esc(money(f.R)) + ' / ' + dec(CUR.hp).toFixed(3) + ' = <b>' + esc(money(f.H)) + '</b></div>'
      + '<div>Locked: ' + esc(money(f.R)) + ' - ' + esc(money(f.H)) + ' - ' + esc(money(S)) + ' = <b>' + esc(signed(f.lock)) + '</b></div>'
      + '<div class="ohg-dim">Decimal odds: ' + esc(pr(CUR.tp)) + ' is ' + dec(CUR.tp).toFixed(3) + ', ' + esc(pr(CUR.hp)) + ' is ' + dec(CUR.hp).toFixed(3) + '.</div>';
    if (bet) bet.textContent = 'Hedge on Onyx' + (h > 0.005 ? ': ' + money(h) + ' at ' + pr(CUR.hp) : '');
    if (CUR.standalone && S > 0) lsSet('onyxHedgeLastStake', S);
  }
  function copyText() {
    if (!CUR || !CUR.f) return '';
    var f = CUR.f, h = CUR.h == null ? f.H : Math.min(f.H, CUR.h), o2 = at(CUR.stake, CUR.tp, CUR.hp, h);
    var what = CUR.o ? CUR.o.hedgeLabel : 'the other side';
    return 'Hedge: ' + money(h) + ' on ' + what + ' at Onyx ' + pr(CUR.hp) + '. Ticket: ' + money(CUR.stake) + ' at ' + pr(CUR.tp) + ' returns ' + money(f.R) + '. '
      + 'If the ticket cashes: ' + signed(o2.ifTicket) + '. If the hedge wins: ' + signed(o2.ifHedge) + '. (Arithmetic, not a guarantee.)';
  }
  function copy() {
    var t = copyText(); if (!t) { toast('Enter the prices first'); return; }
    var done = function () { toast('Hedge amounts copied'); var b = CARD && CARD.querySelector('.ohg-cp'); if (b) { b.textContent = 'Copied'; setTimeout(function () { if (b.isConnected) b.textContent = 'Copy amounts'; }, 1600); } };
    var legacy = function () { try { var a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.cssText = 'position:fixed;top:-1000px;opacity:0'; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } catch (e) {} done(); };
    window.__ohgCopied = t;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, legacy); return; } } catch (e) {}
    legacy();
  }

  // ── the quick bet card (onyx-tap.js): a "Hedge calculator" link under its buttons, unless it has its own ──
  var tapObs = null;
  function tapHook() {
    var root = document.getElementById('oxTap'); if (!root || tapObs || !window.MutationObserver) return !!root;
    var add = function () {
      var c = root.querySelector('.oxt-c'), b = c && c.querySelector('.oxt-b');
      if (!b || c.querySelector('[data-a="hedge"],.ohg-tap')) return;
      var x = document.createElement('button'); x.type = 'button'; x.className = 'ohg-tap'; x.textContent = 'Hedge calculator';
      b.parentNode.insertBefore(x, b.nextSibling);
      // the desktop popover was placed before this link was added: keep its bottom on screen
      if (root.classList.contains('pop')) {
        var top = parseFloat(c.style.top), over = top + c.offsetHeight - (innerHeight - 12);
        if (!isNaN(top) && over > 0) c.style.top = Math.round(Math.max(12, top - over)) + 'px';
      }
    };
    tapObs = new MutationObserver(add); tapObs.observe(root, {childList: true, subtree: true}); add();
    return true;
  }
  function tapCalc(btn) {
    var c = btn.closest('.oxt-c'), q = function (s) { var e = c && c.querySelector(s); return e ? (e.value != null && e.tagName === 'INPUT' ? e.value : e.textContent) : ''; };
    var o = {price: odds(q('.oxt-n .px b')), stake: +q('#oxtS') || null, label: q('#oxtT'), from: 'tap_card'};
    try { if (window.OnyxTap && OnyxTap.close) OnyxTap.close(); } catch (e) {}
    setTimeout(function () { calc(o); }, 30);
  }

  // ── clicks anywhere: the chips, the links ────────────────────────────────
  function pickById(id) {
    var a = window.OnyxSaved && OnyxSaved.all ? OnyxSaved.all() : [];
    return a.filter(function (p) { return p.id === id; })[0] || (LAST_R[id] && LAST_R[id].pick) || null;
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var a = t.closest('[data-ohg-open],[data-ohg-calc],.ohg-tap');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    if (a.classList.contains('ohg-tap')) { tapCalc(a); return; }
    var id = a.getAttribute('data-ohg-open') || a.getAttribute('data-ohg-calc'), p = pickById(id);
    if (!p) { calc({}); return; }
    if (a.hasAttribute('data-ohg-open') || KNOWN[id]) { open(KNOWN[id] || p); return; }
    // the calculator for an open pick that is not live: its price, stake and the board's other side when it has one
    var pr0 = priceOf(p), o = {price: pr0, stake: stakeOf(p), label: p.label || p.matchup || '', from: 'my_picks'};
    if (p.kind !== 'parlay') {
      boardPrice(p, other(p)).then(function (x) { if (x) o.hedge = x.price; calc(o); });
    } else calc(o);
  }, true);

  // ── styles ───────────────────────────────────────────────────────────────
  var CSS = [
    '.ohg-row{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:0}',
    '.ohg-chip{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:6px 12px;border-radius:999px;border:1px solid rgba(97,233,112,.55);background:rgba(97,233,112,.1);color:#eafbe9;font:700 12.5px/1.1 "Space Grotesk",system-ui,sans-serif;cursor:pointer;max-width:100%;text-align:left;-webkit-tap-highlight-color:transparent}',
    '.ohg-chip b{color:#61e970;font-weight:800;font-variant-numeric:tabular-nums}.ohg-chip:hover{background:rgba(97,233,112,.18)}',
    '.ohg-dot{width:7px;height:7px;border-radius:50%;background:#61e970;box-shadow:0 0 8px #61e970;flex-shrink:0}',
    '.ohg-link{background:none;border:0;padding:4px 0;color:#d795ff;font:700 11px/1.2 monospace;letter-spacing:.04em;cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:24px}',
    '.ohg-link:hover{color:#fff}',
    '.ohg-rc{flex-shrink:0;display:inline-flex;align-items:center;height:32px;padding:0 11px;border-radius:999px;border:1px solid rgba(97,233,112,.6);background:rgba(97,233,112,.1);color:#61e970;font:800 12px/1 "Space Grotesk",system-ui,sans-serif;white-space:nowrap;cursor:pointer;box-sizing:border-box}',
    '.ohg-tap{display:block;width:100%;margin:8px 0 0;padding:8px;border:0;background:none;color:#d795ff;font:700 12px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
    '#ohgRoot{position:fixed;inset:0;z-index:2147483000}#ohgRoot[hidden]{display:none}',
    '.ohg-bg{position:absolute;inset:0;background:rgba(5,3,9,.62);opacity:0;transition:opacity .18s}#ohgRoot.on .ohg-bg{opacity:1}',
    '.ohg-c{position:absolute;left:50%;top:50%;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;box-sizing:border-box;padding:20px 20px 16px;border-radius:18px;',
    'background:#141019;border:1px solid rgba(176,56,249,.45);box-shadow:0 24px 60px rgba(0,0,0,.6);color:#efeaf7;font-family:"Space Grotesk",system-ui,sans-serif;transform:translate(-50%,-48%);opacity:0;transition:transform .18s,opacity .18s;outline:none;overscroll-behavior:contain}',
    '#ohgRoot.on .ohg-c{transform:translate(-50%,-50%);opacity:1}',
    '#ohgRoot.sheet .ohg-c{left:0;right:0;top:auto;bottom:0;width:100%;max-height:92vh;border-radius:18px 18px 0 0;transform:translateY(30px);padding:10px 16px calc(16px + env(safe-area-inset-bottom))}',
    '#ohgRoot.sheet.on .ohg-c{transform:none}',
    '.ohg-grab{display:none;width:40px;height:4px;border-radius:9px;background:rgba(255,255,255,.25);margin:0 auto 10px}#ohgRoot.sheet .ohg-grab{display:block}',
    '.ohg-x{position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:400 22px/1 system-ui;cursor:pointer}',
    '.ohg-k{font:700 10px/1.2 monospace;letter-spacing:.14em;text-transform:uppercase;color:#d795ff}',
    '.ohg-c h2{margin:4px 44px 6px 0;font:800 21px/1.15 "Space Grotesk",system-ui,sans-serif;color:#fff}',
    '.ohg-sub{font:500 13px/1.45 system-ui,-apple-system,sans-serif;color:#cfc8da;overflow-wrap:anywhere}.ohg-sub b{color:#fff}',
    '.ohg-in{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0 4px}',
    '.ohg-f{display:flex;flex-direction:column;gap:4px;min-width:0}.ohg-f span{font:700 10px/1.2 monospace;letter-spacing:.06em;text-transform:uppercase;color:#a99fba}',
    '.ohg-f input{width:100%;box-sizing:border-box;min-height:42px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#0c0c0c;color:#fff;font:700 16px/1 "Space Grotesk",system-ui,sans-serif;font-variant-numeric:tabular-nums}',
    '.ohg-f input:focus{outline:none;border-color:#b038f9;box-shadow:0 0 0 2px rgba(176,56,249,.35)}',
    '.ohg-in .ohg-f:nth-child(4){grid-column:1/-1}',
    '.ohg-src{font:600 11px/1.4 monospace;color:#a99fba;margin:2px 0 8px}',
    '.ohg-out{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:8px;margin:8px 0}',
    '.ohg-need{grid-column:1/-1;padding:12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.16);color:#cfc8da;font:600 13px/1.4 system-ui,sans-serif}',
    '.ohg-big,.ohg-lock{padding:10px 12px;border-radius:12px;background:rgba(176,56,249,.12);border:1px solid rgba(176,56,249,.4);display:flex;flex-direction:column;gap:3px;min-width:0}',
    '.ohg-big small,.ohg-lock small,.ohg-two small,.ohg-rg small{font:700 9.5px/1.25 monospace;letter-spacing:.06em;text-transform:uppercase;color:#cfc8da}',
    '.ohg-big b,.ohg-lock b{font:800 24px/1.05 "Space Grotesk",system-ui,sans-serif;color:#fff;font-variant-numeric:tabular-nums}',
    '.ohg-big span{font:600 12px/1.3 system-ui,sans-serif;color:#e8e2f1;overflow-wrap:anywhere}',
    '.ohg-lock.good{background:rgba(97,233,112,.1);border-color:rgba(97,233,112,.5)}.ohg-lock.good b{color:#61e970}',
    '.ohg-lock.bad{background:rgba(255,138,138,.08);border-color:rgba(255,138,138,.45)}.ohg-lock.bad b{color:#ff8a8a}',
    '.ohg-sl{margin:6px 0 4px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)}',
    '.ohg-sl.off{opacity:.45}',
    '.ohg-sl label{display:flex;justify-content:space-between;font:700 12px/1.2 system-ui,sans-serif;color:#cfc8da}.ohg-sl label b{color:#fff;font-variant-numeric:tabular-nums}',
    '.ohg-sl input[type=range]{width:100%;margin:10px 0 4px;accent-color:#b038f9;min-height:24px}',
    '.ohg-sx{display:flex;justify-content:space-between;align-items:center;font:600 10.5px/1 monospace;color:#8f879c}',
    '.ohg-sx button{background:none;border:1px solid rgba(176,56,249,.5);border-radius:999px;color:#d795ff;font:700 11px/1 monospace;padding:6px 10px;cursor:pointer;min-height:28px}',
    '.ohg-two,.ohg-rg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.ohg-rg{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.ohg-two div,.ohg-rg div{display:flex;flex-direction:column;gap:3px;min-width:0}',
    '.ohg-two b,.ohg-rg b{font:800 17px/1.1 "Space Grotesk",system-ui,sans-serif;color:#fff;font-variant-numeric:tabular-nums}',
    '.ohg-two b.good{color:#61e970}.ohg-two b.bad{color:#ff8a8a}',
    '.ohg-ride{margin:8px 0;padding:0 2px}.ohg-ride:empty{display:none}',
    '.ohg-rk{font:700 12.5px/1.3 system-ui,sans-serif;color:#fff}.ohg-rk span{font:600 11px monospace;color:#a99fba;margin-left:4px}',
    '.ohg-ride p{margin:8px 0 0;font:500 12.5px/1.45 system-ui,sans-serif;color:#cfc8da}',
    '.ohg-math{margin:8px 0;padding:10px 12px;border-radius:12px;background:#0c0c0c;border:1px solid rgba(255,255,255,.08);font:600 11.5px/1.65 monospace;color:#cfc8da;overflow-wrap:anywhere}.ohg-math:empty{display:none}',
    '.ohg-math b{color:#fff}.ohg-mk{font:700 9.5px/1.4 monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff}.ohg-dim{color:#8f879c}',
    '.ohg-acts{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:8px;margin-top:10px}',
    '.ohg-bet,.ohg-cp{display:flex;align-items:center;justify-content:center;min-height:46px;padding:8px 10px;border-radius:12px;box-sizing:border-box;font:800 13.5px/1.15 "Space Grotesk",system-ui,sans-serif;text-align:center;cursor:pointer;text-decoration:none}',
    '.ohg-bet{background:#b038f9;color:#fff!important;border:1px solid #b038f9}.ohg-bet:hover{background:#9a2ee0}',
    '.ohg-cp{background:rgba(255,255,255,.06);color:#eee9f5;border:1px solid rgba(255,255,255,.16)}.ohg-cp:hover{border-color:#b038f9}',
    '.ohg-f2{margin:10px 0 0;font:500 10.5px/1.45 system-ui,sans-serif;color:#8f879c}',
    '.ohg-c button:focus-visible,.ohg-c a:focus-visible,.ohg-chip:focus-visible,.ohg-rc:focus-visible,.ohg-link:focus-visible{outline:2px solid #d795ff;outline-offset:2px}',
    '@media (max-width:420px){.ohg-in{grid-template-columns:1fr 1fr}.ohg-in .ohg-f:first-child{grid-column:1/-1}.ohg-out{grid-template-columns:1fr}.ohg-big b,.ohg-lock b{font-size:22px}}',
    '@media (prefers-reduced-motion:reduce){.ohg-c,.ohg-bg{transition:none}}'
  ].join('');
  function css() {
    if (document.getElementById('ohg-css')) return;
    var s = document.createElement('style'); s.id = 'ohg-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s);
  }

  // ── boot: #hedge opens the calculator; the quick bet card gets its link; the rail its chips ──
  function hashOpen() { if (/^#hedge$/i.test(location.hash)) calc({from: 'link'}); }
  function boot() {
    hashOpen();
    addEventListener('hashchange', hashOpen);
    var tries = 0, t = setInterval(function () { if (tapHook() || ++tries > 20) clearInterval(t); }, 1500);
    tapHook();
    paintRail();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.OnyxHedge = {math: math, offer: function (p, r) { return offer(p, r).then(remember); }, open: open, calc: calc, close: close, decorate: decorate, seen: seen,
    stakeOf: stakeOf, href: href, known: function (id) { return KNOWN[id] || null; }, other: other, isOpen: function () { return !!(ROOT && !ROOT.hidden); }, copyText: copyText};
})();
