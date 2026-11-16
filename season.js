// season.js - My Season (season.html, 11/16, Jordan: "my season I love").
// Everything is read from the permanent pick history (OnyxSaved.history(), localStorage onyxHistory): every pick and
// parlay ticket saved with the star, graded W/L/P by saved.js as games end, synced to the account by accounts.js when
// signed in (so this page shows every device's picks once signed in, and still works offline from this device alone).
//
// Units: your stake (1 unit unless you set one when saving) at the odds you got (my_price), else the Onyx price when
// you saved it; a win pays stake x the price's profit, a loss costs the stake, a push is 0 and is not risked
// (OnyxSaved.unitsOf, the same rule as account.html's record). ROI = units / units risked. Hit rate = W / (W + L).
// Days are baseball days (ET minus 4 hours, the site rule), so a late West Coast game counts on the night it started.
//
// OnyxSeason.compute(history, {period, sport, now}) is pure (tools/verify_season.js recomputes it independently);
// OnyxSeason.mount(el) draws the page and the Wrapped-style recap. Model numbers are the model's chances, never picks.
(function () {
  'use strict';
  var SPN = {nfl: 'NFL', nba: 'NBA', nhl: 'NHL', cfb: 'College Football', cbb: 'College Basketball', tennis: 'Tennis', golf: 'Golf', mlb: 'MLB', multi: 'Multi-sport'};
  var TYPES = [['props', 'Player props'], ['spreads', 'Spreads'], ['totals', 'Totals'], ['moneylines', 'Moneylines'], ['parlays', 'Parlays'], ['other', 'Other']];
  var PERIODS = [['week', '7 days'], ['month', '30 days'], ['season', 'Season'], ['all', 'All time']];
  var REFERRER = 'KR680261';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null ? '' : (a > 0 ? '+' : '') + a; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function uTxt(u) { u = r2(u); return (u > 0 ? '+' : u < 0 ? '-' : '') + Math.abs(u).toFixed(2) + 'u'; }
  function cls(u) { return u > 0.004 ? 'up' : u < -0.004 ? 'dn' : ''; }
  function pct(x) { return x == null ? '-' : x + '%'; }
  function stakeOf(h) { return +h.stake > 0 ? +h.stake : 1; }
  function priceOf(h) { var v = h.my_price != null ? +h.my_price : h.price != null ? +h.price : null; return v == null || isNaN(v) ? null : v; }
  function unitsOf(h) {
    var s = stakeOf(h), pr = priceOf(h);
    if (h.res === 'W') return s * (pr == null ? 1 : pr > 0 ? pr / 100 : 100 / -pr);
    if (h.res === 'L') return -s;
    return 0;
  }
  function typeOf(h) {
    if (h.kind === 'parlay' || (h.legs && h.legs.length > 1)) return 'parlays';
    if (h.kind === 'prop' || (h.mkt && h.kind !== 'total' && h.kind !== 'spread' && h.kind !== 'ml')) return 'props';
    return {spread: 'spreads', total: 'totals', ml: 'moneylines'}[h.kind] || 'other';
  }
  function timeOf(h) { var t = Date.parse(h.start || h.saved); return isNaN(t) ? Date.parse(h.saved) || 0 : t; }
  // the baseball day (ET minus 4 hours), as YYYY-MM-DD
  function dayOf(t) { try { return new Date(t - 4 * 3600e3).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); } catch (e) { return new Date(t).toISOString().slice(0, 10); } }
  function dayTxt(d) { var p = String(d).split('-'); return p.length === 3 ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + (+p[2]) : d; }
  // the season: the football and basketball year, from August 1
  function seasonStart(now) { var d = new Date(now), y = d.getUTCFullYear(); if (d.getUTCMonth() < 7) y--; return Date.UTC(y, 7, 1, 8); }
  function since(period, now) {
    if (period === 'week') return now - 7 * 864e5;
    if (period === 'month') return now - 30 * 864e5;
    if (period === 'season') return seasonStart(now);
    return -Infinity;
  }
  function grp() { return {n: 0, w: 0, l: 0, p: 0, units: 0, risked: 0}; }
  function add(g, h, u) {
    g.n++; g.units += u;
    if (h.res === 'W') g.w++; else if (h.res === 'L') g.l++; else g.p++;
    if (h.res !== 'P') g.risked += stakeOf(h);
  }
  function fin(g) {
    g.units = r2(g.units); g.risked = r2(g.risked);
    g.roi = g.risked ? Math.round(g.units / g.risked * 1000) / 10 : null;
    g.rate = g.w + g.l ? Math.round(g.w / (g.w + g.l) * 1000) / 10 : null;
    g.record = g.w + '-' + g.l + (g.p ? '-' + g.p : '');
    return g;
  }

  function compute(H, o) {
    o = o || {};
    var now = o.now || Date.now(), from = since(o.period || 'season', now), sp = o.sport || 'all';
    var inScope = (H || []).filter(function (h) { var t = timeOf(h); return t >= from && (sp === 'all' || (h.sport || 'other') === sp); });
    var rows = inScope.filter(function (h) { return h.res === 'W' || h.res === 'L' || h.res === 'P'; })
      .map(function (h) { return {h: h, t: timeOf(h), u: unitsOf(h)}; })
      .sort(function (a, b) { return a.t - b.t || String(a.h.saved).localeCompare(String(b.h.saved)); });
    var all = fin(rows.reduce(function (g, r) { add(g, r.h, r.u); return g; }, grp()));
    var bySport = {}, byType = {}, byFav = {fav: grp(), dog: grp()}, byTag = {}, byDay = {};
    var cum = 0, curve = [], streak = 0, best = 0, bestEnd = null, cur = null;
    rows.forEach(function (r) {
      var h = r.h, k = h.sport || 'other';
      add(bySport[k] = bySport[k] || grp(), h, r.u);
      add(byType[typeOf(h)] = byType[typeOf(h)] || grp(), h, r.u);
      var pr = priceOf(h); if (pr != null) add(pr < 0 ? byFav.fav : byFav.dog, h, r.u);
      (h.tags || []).forEach(function (t) { add(byTag[t] = byTag[t] || grp(), h, r.u); });
      var d = dayOf(r.t); add(byDay[d] = byDay[d] || grp(), h, r.u);
      cum += r.u; curve.push({t: r.t, cum: r2(cum), u: r2(r.u), res: h.res, label: h.label || h.name || ''});
      // streaks: a push neither extends nor breaks one
      if (h.res === 'W') { streak++; if (streak > best) { best = streak; bestEnd = r.t; } }
      else if (h.res === 'L') streak = 0;
      if (h.res !== 'P') cur = cur && cur.res === h.res ? {res: h.res, n: cur.n + 1} : {res: h.res, n: 1};
    });
    Object.keys(bySport).forEach(function (k) { fin(bySport[k]); });
    Object.keys(byType).forEach(function (k) { fin(byType[k]); });
    Object.keys(byTag).forEach(function (k) { fin(byTag[k]); });
    fin(byFav.fav); fin(byFav.dog);
    var days = Object.keys(byDay).map(function (d) { return Object.assign(fin(byDay[d]), {day: d}); });
    var bestDay = days.filter(function (d) { return d.units > 0; }).sort(function (a, b) { return b.units - a.units || b.w - a.w || (a.day < b.day ? 1 : -1); })[0] || null;
    var wins = rows.filter(function (r) { return r.h.res === 'W'; }).sort(function (a, b) { return b.u - a.u || b.t - a.t; });
    var losses = rows.filter(function (r) { return r.h.res === 'L'; }).sort(function (a, b) { return a.u - b.u || (+b.h.conf || 0) - (+a.h.conf || 0) || b.t - a.t; });
    // the model check: picks the model gave a chance to (W or L), its expected wins against what hit
    var M = rows.filter(function (r) { var c = +r.h.conf; return (r.h.res === 'W' || r.h.res === 'L') && c > 0 && c < 1; });
    var exp = M.reduce(function (s, r) { return s + +r.h.conf; }, 0), act = M.filter(function (r) { return r.h.res === 'W'; }).length;
    var B = [[0, 0.4, 'Under 40%'], [0.4, 0.6, '40 to 60%'], [0.6, 1.01, '60% and up']].map(function (b) {
      var x = M.filter(function (r) { return +r.h.conf >= b[0] && +r.h.conf < b[1]; });
      return {label: b[2], n: x.length, exp: x.length ? Math.round(x.reduce(function (s, r) { return s + +r.h.conf; }, 0) / x.length * 1000) / 10 : null,
              act: x.length ? Math.round(x.filter(function (r) { return r.h.res === 'W'; }).length / x.length * 1000) / 10 : null};
    });
    return {
      period: o.period || 'season', sport: sp, total: all, pending: inScope.length - rows.length, curve: curve,
      bySport: bySport, byType: byType, byFav: byFav, byTag: byTag,
      best: wins.slice(0, 3).map(function (r) { return Object.assign({}, r.h, {u: r2(r.u)}); }),
      worst: losses.slice(0, 3).map(function (r) { return Object.assign({}, r.h, {u: r2(r.u)}); }),
      longest: best, longestEnd: bestEnd, current: cur, bestDay: bestDay, days: days.length,
      model: {n: M.length, exp: Math.round(exp * 10) / 10, act: act, diff: Math.round((act - exp) * 10) / 10, buckets: B},
      sports: Object.keys((H || []).reduce(function (m, h) { if (h.res) m[h.sport || 'other'] = 1; return m; }, {}))
    };
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  var ST = {period: 'season', sport: 'all', show: 25};
  try { var sv = JSON.parse(localStorage.getItem('onyxSeasonView') || 'null'); if (sv && sv.period) { ST.period = sv.period; ST.sport = sv.sport || 'all'; } } catch (e) {}
  function remember() { try { localStorage.setItem('onyxSeasonView', JSON.stringify({period: ST.period, sport: ST.sport})); } catch (e) {} }
  var ROOT = null, LAST = null;
  function hist() { try { return window.OnyxSaved && OnyxSaved.history ? OnyxSaved.history() : JSON.parse(localStorage.getItem('onyxHistory') || '[]') || []; } catch (e) { return []; } }
  function spName(k) { return SPN[k] || (k ? String(k).toUpperCase() : 'Other'); }
  function syncLine() {
    var s = window.OnyxSaved && OnyxSaved.syncState ? OnyxSaved.syncState() : {text: 'Saved on this device'};
    return '<span class="se-sy' + (s.ok ? ' ok' : s.bad ? ' bad' : '') + '">' + esc(s.text) + '</span>' +
      (s.on && !s.signedIn ? ' · <a href="account.html">Sign in</a> to keep your season on every device' : !s.on ? ' · works offline' : '');
  }

  function chart(C) {
    var pts = [{cum: 0, t: C.curve.length ? C.curve[0].t : 0, label: 'Start', u: 0}].concat(C.curve);
    var lo = Math.min(0, Math.min.apply(null, pts.map(function (p) { return p.cum; }))), hi = Math.max(0, Math.max.apply(null, pts.map(function (p) { return p.cum; })));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
    var W = 600, Hh = 200, n = pts.length - 1 || 1;
    var X = function (i) { return i / n * W; }, Y = function (v) { return (hi - v) / (hi - lo) * Hh; };
    var line = pts.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.cum).toFixed(1); }).join(' ');
    var area = 'M0,' + Y(0).toFixed(1) + ' L' + line.split(' ').join(' L') + ' L' + W + ',' + Y(0).toFixed(1) + ' Z';
    var end = pts[pts.length - 1].cum;
    return '<div class="se-ch" data-n="' + C.curve.length + '">' +
      '<div class="se-ch-y"><span>' + uTxt(hi - pad) + '</span><span class="z" style="top:' + (Y(0) / Hh * 100).toFixed(1) + '%">0</span><span>' + uTxt(lo + pad) + '</span></div>' +
      '<div class="se-ch-p" id="seChart"><svg viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" aria-label="Cumulative units, ' + uTxt(end) + ' after ' + C.curve.length + ' graded picks" role="img">' +
        '<defs><linearGradient id="seFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b038f9" stop-opacity=".32"/><stop offset="1" stop-color="#b038f9" stop-opacity="0"/></linearGradient></defs>' +
        '<line x1="0" x2="' + W + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="rgba(255,255,255,.28)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>' +
        '<path d="' + area + '" fill="url(#seFill)"/>' +
        '<polyline class="se-line" points="' + line + '" fill="none" stroke="#d795ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '</svg><i class="se-ch-x" hidden></i><i class="se-ch-dot" hidden></i><div class="se-ch-tip" hidden></div>' +
      '<b class="se-ch-end ' + cls(end) + '" style="top:' + (Y(end) / Hh * 100).toFixed(1) + '%">' + uTxt(end) + '</b></div>' +
      '<div class="se-ch-d"><span>' + (C.curve.length ? dayTxt(dayOf(C.curve[0].t)) : '') + '</span><span>' + (C.curve.length ? dayTxt(dayOf(C.curve[C.curve.length - 1].t)) : '') + '</span></div></div>';
  }
  function wireChart(C) {
    var p = document.getElementById('seChart'); if (!p) return;
    var pts = [{cum: 0, label: 'Start', u: 0, t: C.curve.length ? C.curve[0].t : 0}].concat(C.curve);
    var lo = Math.min(0, Math.min.apply(null, pts.map(function (q) { return q.cum; }))), hi = Math.max(0, Math.max.apply(null, pts.map(function (q) { return q.cum; })));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
    var x = p.querySelector('.se-ch-x'), dot = p.querySelector('.se-ch-dot'), tip = p.querySelector('.se-ch-tip'), n = pts.length - 1 || 1;
    var show = function (ev) {
      var R = p.getBoundingClientRect(), f = Math.max(0, Math.min(1, (ev.clientX - R.left) / R.width)), i = Math.round(f * n), q = pts[i];
      var left = i / n * 100, top = (hi - q.cum) / (hi - lo) * 100;
      x.hidden = dot.hidden = tip.hidden = false;
      x.style.left = left + '%'; dot.style.left = left + '%'; dot.style.top = top + '%';
      tip.innerHTML = i ? '<b>' + esc(dayTxt(dayOf(q.t))) + ' · ' + ({W: 'Won', L: 'Lost', P: 'Push'}[q.res] || '') + ' ' + uTxt(q.u) + '</b><span>' + esc(q.label) + '</span><em>Season ' + uTxt(q.cum) + '</em>' : '<b>Start</b><em>0.00u</em>';
      tip.style.left = Math.max(0, Math.min(R.width - tip.offsetWidth, left / 100 * R.width - tip.offsetWidth / 2)) + 'px';
    };
    p.addEventListener('pointermove', show);
    p.addEventListener('pointerdown', show);
    p.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') x.hidden = dot.hidden = tip.hidden = true; });   // a tap keeps it up
  }
  function bars(obj, order, name) {
    var keys = (order || Object.keys(obj)).filter(function (k) { return obj[k] && obj[k].n; });
    if (!keys.length) return '<div class="se-none">Nothing graded here yet.</div>';
    var mx = Math.max.apply(null, keys.map(function (k) { return Math.abs(obj[k].units); }).concat([0.01]));
    if (!order) keys.sort(function (a, b) { return obj[b].units - obj[a].units; });
    return keys.map(function (k) {
      var g = obj[k], w = Math.abs(g.units) / mx * 50;
      return '<div class="se-row" data-row="' + esc(k) + '"><span class="n">' + esc(name(k)) + '</span><span class="r">' + g.record + '</span>' +
        '<span class="b"><i class="' + (g.units < 0 ? 'dn' : 'up') + '" style="' + (g.units < 0 ? 'right:50%' : 'left:50%') + ';width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="u ' + cls(g.units) + '">' + uTxt(g.units) + '</span><span class="o">' + (g.roi == null ? '-' : (g.roi > 0 ? '+' : '') + g.roi + '%') + '</span></div>';
    }).join('');
  }
  function betRow(h, good) {
    var pr = priceOf(h), t = timeOf(h);
    return '<div class="se-bet"><span class="l">' + esc(h.label || h.name || '') + '</span><span class="m">' + esc(dayTxt(dayOf(t))) + ' · ' + esc(spName(h.sport)) +
      (pr != null ? ' · ' + (h.my_price != null ? 'your odds ' : 'Onyx ') + esc(odds(pr)) : '') + (stakeOf(h) !== 1 ? ' · ' + stakeOf(h) + 'u' : '') + '</span>' +
      '<b class="' + (good ? 'up' : 'dn') + '">' + uTxt(h.u) + '</b></div>';
  }
  function settledList(H) {
    var G = H.filter(function (h) { return h.res; }).sort(function (a, b) { return timeOf(b) - timeOf(a); });
    if (!G.length) return '<div class="se-none">Graded picks land here when their games end.</div>';
    return G.slice(0, ST.show).map(function (h) {
      var u = unitsOf(h), pr = priceOf(h);
      return '<div class="se-st"><span class="l">' + esc(h.label || h.name || '') + (h.note ? '<small>' + esc(h.note) + '</small>' : '') + '</span>' +
        '<span class="m">' + esc(dayTxt(dayOf(timeOf(h)))) + ' · ' + esc(spName(h.sport)) + (pr != null ? ' · ' + esc(odds(pr)) : '') + ' · ' + stakeOf(h) + 'u' +
        (h.final != null ? ' · final ' + esc(String(h.final)) : '') + '</span>' +
        '<span class="r ' + h.res + '">' + {W: 'Won', L: 'Lost', P: 'Push'}[h.res] + '</span><b class="' + cls(u) + '">' + uTxt(u) + '</b></div>';
    }).join('') + (G.length > ST.show ? '<button type="button" class="se-more" data-se="more">Show more (' + (G.length - ST.show) + ')</button>' : '');
  }
  function empty(any) {
    return '<div class="se-empty"><h2>' + (any ? 'Nothing graded in this window yet.' : 'Your season starts with one star.') + '</h2>' +
      '<p>' + (any ? 'Try a longer window or all sports. Picks are graded when their games end.' : 'Every pick you save is tracked live, graded when it ends and counted here: your record, units at the odds you got, your best bets and how you did against the model.') + '</p>' +
      '<ol><li><b>Tap the star</b> on any play: the Top 10, Ask Onyx, a sport\'s Plays tab or the Onyx Board.</li>' +
      '<li><b>Enter the odds you got</b> and your units in the sheet that opens (optional; 1 unit at the Onyx price otherwise).</li>' +
      '<li><b>Building a parlay?</b> Save the whole slip as one ticket from the Parlay Builder.</li>' +
      '<li><b>Sign in</b> and your season follows you to every device.</li></ol>' +
      '<div class="se-cta"><a class="se-btn" href="home.html#top10">Today\'s Top 10</a><a class="se-btn ghost" href="home.html#ask">Ask Onyx</a><a class="se-btn ghost" href="picks.html">Onyx Picks</a></div></div>';
  }

  function render() {
    if (!ROOT) return;
    var H = hist(), C = compute(H, {period: ST.period, sport: ST.sport});
    LAST = C;
    var anyGraded = H.some(function (h) { return h.res; });
    var sports = ['all'].concat(C.sports.sort(function (a, b) { return spName(a).localeCompare(spName(b)); }));
    var filt = '<div class="se-f"><div class="se-seg" role="tablist" aria-label="Time window">' + PERIODS.map(function (p) {
        return '<button type="button" role="tab" data-period="' + p[0] + '" aria-selected="' + (ST.period === p[0]) + '"' + (ST.period === p[0] ? ' class="on"' : '') + '>' + p[1] + '</button>'; }).join('') + '</div>' +
      (sports.length > 2 ? '<div class="se-chips" aria-label="Sport">' + sports.map(function (k) {
        return '<button type="button" data-sport="' + esc(k) + '" aria-pressed="' + (ST.sport === k) + '"' + (ST.sport === k ? ' class="on"' : '') + '>' + esc(k === 'all' ? 'All sports' : spName(k)) + '</button>'; }).join('') + '</div>' : '') + '</div>';
    var T = C.total, h = '';
    if (!anyGraded) {
      var pend = H.length;
      h = (pend ? '<div class="se-pend">' + pend + ' pick' + (pend === 1 ? '' : 's') + ' saved, waiting on ' + (pend === 1 ? 'its game' : 'their games') + '. Your season fills in as they are graded.</div>' : '') + empty(false);
    } else if (!T.n) {
      h = filt + empty(true);
    } else {
      var cs = C.current;
      h = filt +
      '<div class="se-kp">' +
        '<div><b data-k="record">' + T.record + '</b><span>Record</span></div>' +
        '<div><b data-k="units" class="' + cls(T.units) + '">' + uTxt(T.units) + '</b><span>Units</span></div>' +
        '<div><b data-k="roi" class="' + cls(T.roi || 0) + '">' + (T.roi == null ? '-' : (T.roi > 0 ? '+' : '') + T.roi + '%') + '</b><span>ROI</span></div>' +
        '<div><b data-k="rate">' + pct(T.rate) + '</b><span>Hit rate</span></div></div>' +
      '<div class="se-sub">' + T.n + ' graded' + (C.pending ? ', ' + C.pending + ' still to play' : '') + ' · ' + T.risked.toFixed(2) + ' units risked at your odds and stakes</div>' +
      '<button type="button" class="se-recap" data-se="recap"><span>Your ' + esc(periodName()) + ' recap</span><em>Swipe through it, then share it</em></button>' +
      '<section class="se-card"><h3>Units over time</h3>' + chart(C) + '</section>' +
      '<div class="se-2">' +
        '<section class="se-card"><h3>By sport</h3><div class="se-rows" id="seSport">' + bars(C.bySport, null, spName) + '</div></section>' +
        '<section class="se-card"><h3>By market</h3><div class="se-rows" id="seType">' + bars(C.byType, TYPES.map(function (t) { return t[0]; }), function (k) { return (TYPES.filter(function (t) { return t[0] === k; })[0] || [0, k])[1]; }) + '</div></section>' +
        '<section class="se-card"><h3>Favorites vs underdogs</h3><div class="se-rows" id="seFav">' + bars(C.byFav, ['fav', 'dog'], function (k) { return k === 'fav' ? 'Favorites' : 'Underdogs'; }) + '</div></section>' +
        (Object.keys(C.byTag).length ? '<section class="se-card"><h3>Your #tags</h3><div class="se-rows">' + bars(C.byTag, null, function (k) { return '#' + k; }) + '</div></section>' : '') +
        '<section class="se-card"><h3>Streaks and days</h3><div class="se-hl">' +
          '<div><b data-k="longest">' + C.longest + '</b><span>Longest win streak</span></div>' +
          '<div><b data-k="current" class="' + (cs ? (cs.res === 'W' ? 'up' : 'dn') : '') + '">' + (cs ? cs.res + cs.n : '-') + '</b><span>Current streak</span></div>' +
          '<div><b data-k="bestday" class="up">' + (C.bestDay ? uTxt(C.bestDay.units) : '-') + '</b><span>' + (C.bestDay ? 'Best day, ' + esc(dayTxt(C.bestDay.day)) + ' (' + C.bestDay.record + ')' : 'Best day') + '</span></div>' +
          '<div><b>' + C.days + '</b><span>Days with a graded pick</span></div></div></section>' +
        '<section class="se-card"><h3>Model check</h3>' + modelBox(C) + '</section>' +
      '</div>' +
      '<div class="se-2">' +
        '<section class="se-card"><h3>Best bets</h3>' + (C.best.length ? C.best.map(function (b) { return betRow(b, true); }).join('') : '<div class="se-none">No wins yet in this window.</div>') + '</section>' +
        '<section class="se-card"><h3>The ones that hurt</h3>' + (C.worst.length ? C.worst.map(function (b) { return betRow(b, false); }).join('') : '<div class="se-none">No losses in this window.</div>') + '</section>' +
      '</div>';
    }
    var scope = H.filter(function (x) { return ST.sport === 'all' || (x.sport || 'other') === ST.sport; }).filter(function (x) { return timeOf(x) >= since(ST.period, Date.now()); });
    if (anyGraded) h += '<section class="se-card se-settled" id="settled"><h3>Settled</h3><p class="se-note">Every graded pick and parlay in this window, at your odds and stake. ' +
      'Picks leave My picks 24 hours after their game starts and stay here for good.</p>' + settledList(scope) + '</section>';
    ROOT.innerHTML = '<div class="se-sync" id="seSync">' + syncLine() + '</div>' + h;
    wireChart(C);
  }
  function periodName() { return {week: '7-day', month: '30-day', season: 'season', all: 'all-time'}[ST.period]; }
  function modelBox(C) {
    var M = C.model;
    if (!M.n) return '<div class="se-none">None of these picks carried a model chance.</div>';
    var d = M.diff;
    return '<div class="se-mc"><div><b data-k="exp">' + M.exp.toFixed(1) + '</b><span>Wins the model expected</span></div><div><b data-k="act" class="' + cls(d) + '">' + M.act + '</b><span>Wins you got</span></div></div>' +
      '<p class="se-note">On ' + M.n + ' picks with a model chance, you ' + (Math.abs(d) < 0.5 ? 'landed right on the model' : d > 0 ? 'beat it by ' + d.toFixed(1) + ' wins' : 'ran ' + Math.abs(d).toFixed(1) + ' wins under it') + '. The model\'s chances are projections, not promises.</p>' +
      '<div class="se-mb">' + M.buckets.filter(function (b) { return b.n; }).map(function (b) {
        return '<div><span>' + b.label + ' (' + b.n + ')</span><em>model ' + b.exp + '% · you ' + b.act + '%</em></div>'; }).join('') + '</div>';
  }

  // ── the recap: 6 big cards, swipe or tap through, the last one shares ──
  function shareCard(C) {
    var T = C.total, b = C.best[0];
    return {kind: 'season', title: 'My Onyx ' + periodName() + (ST.sport !== 'all' ? ' · ' + spName(ST.sport) : ''),
      legs: C.best.map(function (h) { return {label: h.label || h.name || '', matchup: h.matchup || '', price: priceOf(h), conf: h.conf != null ? +h.conf : null, sport: h.sport, res: h.res}; }),
      price: null, chance: null, sels: [],
      stats: {record: T.record, units: T.units, roi: T.roi, rate: T.rate, best: b ? {label: b.label, price: priceOf(b), units: b.u} : null,
        longest: C.longest, model: {exp: C.model.exp, act: C.model.act},
        sports: Object.keys(C.bySport).map(function (k) { var g = C.bySport[k]; return {sport: k, name: spName(k), record: g.record, units: g.units, roi: g.roi}; })}};
  }
  function recapCards(C) {
    var T = C.total, topSport = Object.keys(C.bySport).sort(function (a, b) { return C.bySport[b].units - C.bySport[a].units; })[0];
    var topType = Object.keys(C.byType).sort(function (a, b) { return C.byType[b].units - C.byType[a].units; })[0], b = C.best[0];
    var tn = function (k) { return (TYPES.filter(function (t) { return t[0] === k; })[0] || [0, k])[1]; };
    var M = C.model;
    return [
      ['Your ' + periodName(), T.record, T.n + ' graded picks' + (T.p ? ', ' + T.p + ' push' + (T.p === 1 ? '' : 'es') : '') + '. Hit rate ' + pct(T.rate) + '.'],
      ['Units', uTxt(T.units), 'ROI ' + (T.roi == null ? '-' : (T.roi > 0 ? '+' : '') + T.roi + '%') + ' on ' + T.risked.toFixed(2) + ' units risked, at the odds you got.'],
      ['Best bet', b ? uTxt(b.u) : '-', b ? (b.label || '') + (priceOf(b) != null ? ' at ' + odds(priceOf(b)) : '') : 'Your first winner shows up here.'],
      ['Your lane', topSport ? spName(topSport) : '-', topSport ? C.bySport[topSport].record + ', ' + uTxt(C.bySport[topSport].units) + (topType ? '. Best market: ' + tn(topType) + ' ' + uTxt(C.byType[topType].units) : '') : ''],
      ['Hot hand', C.longest + ' in a row', 'Longest win streak.' + (C.bestDay ? ' Best day ' + dayTxt(C.bestDay.day) + ': ' + uTxt(C.bestDay.units) + ' (' + C.bestDay.record + ').' : '')],
      ['Vs the model', M.n ? M.act + ' of ' + M.exp.toFixed(1) : '-', M.n ? (M.diff >= 0.5 ? 'You beat the model\'s expected wins by ' + M.diff.toFixed(1) + '.' : M.diff <= -0.5 ? 'You ran ' + Math.abs(M.diff).toFixed(1) + ' wins under the model. Variance turns.' : 'Right on the model.') : 'Save model plays to see this.']
    ];
  }
  var RC = null;
  function openRecap() {
    var C = LAST; if (!C || !C.total.n) return;
    closeRecap();
    var cards = recapCards(C), card = shareCard(C);
    var shareHtml = window.OnyxShare && OnyxShare.button ? '<span class="se-rc-share">' + OnyxShare.button(card, 'Share my season') + '</span>' : '<button type="button" class="se-btn" data-rc="share">Share my season</button>';
    var bg = document.createElement('div'); bg.className = 'se-rc'; bg.setAttribute('role', 'dialog'); bg.setAttribute('aria-modal', 'true'); bg.setAttribute('aria-label', 'Your recap');
    bg.innerHTML = '<div class="se-rc-top"><div class="se-rc-dots">' + cards.map(function (_, i) { return '<i data-i="' + i + '"></i>'; }).join('') + '</div><button type="button" class="se-rc-x" data-rc="x" aria-label="Close">×</button></div>' +
      '<div class="se-rc-track" tabindex="0">' + cards.map(function (c, i) {
        return '<section class="se-rc-c c' + i + '" data-i="' + i + '"><span class="eb">' + esc(c[0]) + '</span><b class="big">' + esc(c[1]) + '</b><p>' + esc(c[2]) + '</p>' +
          (i === cards.length - 1 ? '<div class="se-rc-end">' + shareHtml + '<a class="se-btn ghost" href="https://app.onyxodds.com/?utm_source=onyxsports&referrer=' + REFERRER + '" target="_blank" rel="noopener">Build tonight\'s parlay on Onyx</a></div>' : '<span class="nx">Tap or swipe</span>') + '</section>';
      }).join('') + '</div>';
    document.body.appendChild(bg); RC = bg; document.body.style.overflow = 'hidden';
    var tr = bg.querySelector('.se-rc-track'), dots = bg.querySelectorAll('.se-rc-dots i');
    var at = function () { return Math.round(tr.scrollLeft / Math.max(1, tr.clientWidth)); };
    var mark = function () { var i = at(); dots.forEach(function (d, k) { d.classList.toggle('on', k <= i); }); bg.setAttribute('data-at', i); };
    var go = function (i) { i = Math.max(0, Math.min(cards.length - 1, i)); tr.scrollTo({left: i * tr.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); setTimeout(mark, 380); };
    RC._go = go; RC._at = at;
    tr.addEventListener('scroll', function () { clearTimeout(tr._t); tr._t = setTimeout(mark, 60); });
    // the share button: OnyxShare's sheet with the season card (wired here, so it opens once)
    bg.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-rc="x"]')) { closeRecap(); return; }
      if (t.closest('.se-rc-share, [data-rc="share"]')) { e.preventDefault(); e.stopPropagation(); share(card, C); return; }
      if (t.closest('a, button')) return;
      var c = t.closest('.se-rc-c'); if (!c) return;
      var R = c.getBoundingClientRect();
      go(at() + (e.clientX - R.left < R.width * 0.3 ? -1 : 1));
    }, true);
    bg.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') go(at() + 1); else if (e.key === 'ArrowLeft') go(at() - 1); else if (e.key === 'Escape') closeRecap(); });
    mark(); tr.focus({preventScroll: true});
    try { if (window.gtag) gtag('event', 'season_recap', {period: ST.period}); } catch (x) {}
  }
  function closeRecap() { if (RC) { RC.remove(); RC = null; document.body.style.overflow = ''; } }
  function share(card, C) {
    if (window.OnyxShare && OnyxShare.open) { try { OnyxShare.open(card); return; } catch (e) {} }
    var T = C.total, txt = 'My Onyx ' + periodName() + ': ' + T.record + ', ' + uTxt(T.units) + (T.roi != null ? ', ROI ' + (T.roi > 0 ? '+' : '') + T.roi + '%' : '');
    var url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'home.html';
    if (navigator.share) { navigator.share({title: 'My Onyx season', text: txt, url: url}).catch(function () {}); return; }
    try { navigator.clipboard.writeText(txt + ' ' + url).then(function () { if (window.OX_TOAST) OX_TOAST('Copied your season to share'); }); } catch (e) {}
  }

  function mount(el) {
    ROOT = el;
    ROOT.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-period],[data-sport],[data-se]') : null; if (!b) return;
      if (b.hasAttribute('data-period')) { ST.period = b.getAttribute('data-period'); ST.show = 25; remember(); render(); }
      else if (b.hasAttribute('data-sport')) { ST.sport = b.getAttribute('data-sport'); ST.show = 25; remember(); render(); }
      else if (b.getAttribute('data-se') === 'more') { ST.show += 50; render(); }
      else if (b.getAttribute('data-se') === 'recap') openRecap();
    });
    render();
    var again = function () { if (!RC) render(); };
    addEventListener('onyx-history', again);
    addEventListener('onyx-saved', again);
    addEventListener('onyx-account', function () { var s = document.getElementById('seSync'); if (s) s.innerHTML = syncLine(); });
    addEventListener('storage', function (e) { if (e.key === 'onyxHistory') again(); });
    // grade what finished since the last visit, and pull the account's picks when signed in
    setTimeout(function () {
      if (window.OnyxSaved && OnyxSaved.grade) OnyxSaved.grade();
      try { if (window.OnyxAccounts && OnyxAccounts.ready) OnyxAccounts.ready.then(function (s) { if (s && s.signedIn) OnyxAccounts.sync(); }); } catch (e) {}
    }, 400);
  }
  window.OnyxSeason = {compute: compute, mount: mount, render: render, openRecap: openRecap, closeRecap: closeRecap, unitsOf: unitsOf, typeOf: typeOf, dayOf: dayOf,
    state: function () { return {period: ST.period, sport: ST.sport, last: LAST}; }};
})();
