// profile.js - your betting profile (11/8, Jordan: "a whole profile history: best picks, best sport, best type of bet,
// studying the profile habits and making a profile on them, and recommend the types of bets they're interested in").
//
// Built from the permanent pick history (saved.js OnyxSaved.history(): every pick saved, graded W / L / P, on this
// device and synced to the account when signed in) and today's boards (data/<sport>/board.json):
//   - who you are as a bettor: your sports, bet types, sides and prices, from every pick saved
//   - what wins for you: record, units and ROI by sport, bet type, price range and side, best and coldest spots
//   - your best picks (the biggest prices that cashed) and your streak
//   - picks for you today: plays on today's boards that fit your habits, weighted toward what has paid you,
//     ranked by our model's chance, with the reason for each
//   - "Search my kind of bets": Ask Onyx with your profile filled in
// Units: 1 unit on each pick at the Onyx price saved. Projections, not Onyx Picks.
//
//   OnyxProfile.mount(el)
(function () {
  'use strict';
  var SPORTS = ['nfl', 'cfb', 'nba', 'cbb', 'nhl', 'tennis'];
  var LG = {nfl: 'NFL', cfb: 'College football', nba: 'NBA', cbb: 'College basketball', nhl: 'NHL', tennis: 'Tennis', golf: 'Golf', mlb: 'MLB'};
  var MW = {pts: 'points', reb: 'rebounds', ast: 'assists', rec: 'receptions', rec_yds: 'receiving yards', rush_yds: 'rushing yards',
            pass_yds: 'passing yards', pass_td: 'passing TDs', pass_att: 'pass attempts', anytime_td: 'anytime TD', first_td: 'first TD',
            first_basket: 'first basket', q1_total: '1st-quarter totals', h1_total: '1st-half totals', rush_rec_yds: 'rush + rec yards',
            spread: 'spreads', ml: 'moneylines', total: 'totals', parlay: 'parlays'};
  var ASKW = {pts: 'points', reb: 'rebounds', ast: 'assists', rec: 'receptions', rec_yds: 'receiving yards', rush_yds: 'rushing yards',
              pass_yds: 'passing yards', anytime_td: 'anytime td', q1_total: '1st quarter totals', h1_total: '1st half totals',
              spread: 'spreads', ml: 'moneylines', total: 'totals'};
  var ASKS = {nfl: 'nfl', cfb: 'college football', nba: 'nba', cbb: 'college basketball', nhl: 'nhl', tennis: 'tennis'};
  var REFERRER = 'KR680261';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null ? '' : (a > 0 ? '+' : '') + a; }
  function win(a) { return a == null ? 0.909 : a > 0 ? a / 100 : 100 / -a; }
  function u2(x) { return (x > 0 ? '+' : '') + x.toFixed(2) + 'u'; }
  function type(h) { return h.kind === 'prop' ? (h.mkt || 'prop') : (h.kind || h.mkt || 'other'); }
  function typeName(k) { return MW[k] || String(k).replace(/_/g, ' '); }
  function band(price) {
    if (price == null) return 'std';
    return price <= -200 ? 'heavy' : price < -120 ? 'fav' : price < 100 ? 'std' : price < 200 ? 'plus' : 'long';
  }
  var BANDN = {heavy: 'Heavy favorites (-200 or shorter)', fav: 'Favorites (-199 to -121)', std: 'Standard prices (-120 to -101)',
               plus: 'Plus money (+100 to +199)', long: 'Longshots (+200 and up)'};
  function sideOf(h) { return h.side === 'over' || h.side === 'under' ? h.side : (h.kind === 'spread' || h.kind === 'ml') ? 'side' : 'other'; }
  var SIDEN = {over: 'Overs', under: 'Unders', side: 'Sides (spreads and moneylines)', other: 'Other'};

  // ── the numbers ──────────────────────────────────────────────────────────
  function tally(rows) {
    var t = {n: rows.length, w: 0, l: 0, p: 0, units: 0};
    rows.forEach(function (h) { if (h.res === 'W') { t.w++; t.units += win(h.my_price != null ? h.my_price : h.price); } else if (h.res === 'L') { t.l++; t.units -= 1; } else if (h.res === 'P') t.p++; });
    t.g = t.w + t.l + t.p; t.roi = t.w + t.l ? t.units / (t.w + t.l) * 100 : null; t.rate = t.w + t.l ? t.w / (t.w + t.l) * 100 : null;
    return t;
  }
  function by(rows, key) {
    var o = {}; rows.forEach(function (h) { var k = key(h); (o[k] = o[k] || []).push(h); });
    return Object.keys(o).map(function (k) { return Object.assign({k: k, rows: o[k]}, tally(o[k])); });
  }
  function share(rows, key) {
    var o = {}, n = rows.length || 1; rows.forEach(function (h) { var k = key(h); o[k] = (o[k] || 0) + 1; });
    var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k] / n; }); return out;
  }
  function median(a) { a = a.filter(function (x) { return x != null; }).sort(function (x, y) { return x - y; }); return a.length ? a[Math.floor(a.length / 2)] : null; }
  function study(H) {
    var G = H.filter(function (h) { return h.res === 'W' || h.res === 'L' || h.res === 'P'; });
    var P = {all: H, graded: G, total: tally(G)};
    P.sport = by(G, function (h) { return h.sport; });
    P.type = by(G, function (h) { return h.sport + ':' + type(h); });
    P.band = by(G.filter(function (h) { return h.kind !== 'parlay'; }), function (h) { return band(h.my_price != null ? h.my_price : h.price); });
    P.side = by(G, function (h) { return sideOf(h); });
    // habits: every pick saved, graded or not
    P.hSport = share(H, function (h) { return h.sport; });
    P.hType = share(H, function (h) { return h.sport + ':' + type(h); });
    P.hSide = share(H, function (h) { return sideOf(h); });
    P.hBand = share(H, function (h) { return band(h.price); });
    P.medPrice = median(H.filter(function (h) { return h.kind !== 'parlay'; }).map(function (h) { return h.my_price != null ? h.my_price : h.price; }));
    P.props = H.filter(function (h) { return h.kind === 'prop'; }).length / (H.length || 1);
    var days = {}; H.forEach(function (h) { var d = String(h.saved || h.start || '').slice(0, 10); if (d) days[d] = 1; });
    P.perDay = H.length / Math.max(1, Object.keys(days).length);
    var names = {}; H.forEach(function (h) { var nm = h.kind === 'prop' ? h.name : null; if (nm) names[nm] = (names[nm] || 0) + 1; });
    P.names = Object.keys(names).filter(function (k) { return names[k] >= 2; }).sort(function (a, b) { return names[b] - names[a]; }).slice(0, 5).map(function (k) { return [k, names[k]]; });
    // best and coldest spots: 3+ graded, by units
    var spots = P.sport.concat(P.type.filter(function (x) { return x.g >= 3; })).filter(function (x) { return x.g >= 3; });
    P.best = spots.slice().sort(function (a, b) { return b.units - a.units; })[0] || null;
    P.cold = spots.slice().sort(function (a, b) { return a.units - b.units; })[0] || null;
    if (P.cold && P.best && P.cold.k === P.best.k) P.cold = null;
    if (P.cold && P.cold.units >= 0) P.cold = null;
    P.bestPicks = G.filter(function (h) { return h.res === 'W'; }).sort(function (a, b) { return (b.price || -999) - (a.price || -999); }).slice(0, 3);
    var seq = G.slice().sort(function (a, b) { return Date.parse(b.start || b.saved) - Date.parse(a.start || a.saved); }), st = 0, sk = null;
    for (var i = 0; i < seq.length; i++) { var r = seq[i].res; if (r === 'P') continue; if (sk == null) sk = r; if (r !== sk) break; st++; }
    P.streak = sk ? {k: sk, n: st} : null;
    return P;
  }
  function top(o) { var k = Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }); return k.length ? [k[0], o[k[0]]] : null; }
  function headline(P) {
    var bits = [], ts = top(P.hSport), tt = top(P.hType), sd = top(P.hSide);
    if (ts) bits.push((LG[ts[0]] || ts[0]) + (ts[1] >= 0.6 ? ' first' : ' and more'));
    if (tt) bits.push(typeName(tt[0].split(':')[1]) + ' ' + Math.round(100 * tt[1]) + '% of picks');
    if (sd && (sd[0] === 'over' || sd[0] === 'under') && sd[1] >= 0.55) bits.push('leans ' + sd[0] + 's (' + Math.round(100 * sd[1]) + '%)');
    if (P.medPrice != null) bits.push(P.medPrice >= 100 ? 'likes plus money' : P.medPrice <= -150 ? 'plays favorites' : 'standard prices');
    bits.push(P.props >= 0.6 ? 'props bettor' : P.props <= 0.3 ? 'game-lines bettor' : 'props and game lines');
    return bits.join(' · ');
  }

  // ── picks for you today ─────────────────────────────────────────────────────
  var BOARD = null;
  function boards() {
    if (BOARD) return Promise.resolve(BOARD);
    return Promise.all(SPORTS.map(function (k) { return fetch('data/' + k + '/board.json', {cache: 'no-cache'}).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }))
      .then(function (fs) { BOARD = []; fs.forEach(function (f) { (f && f.plays || []).forEach(function (p) { BOARD.push(p); }); }); return BOARD; });
  }
  function recs(P, B, saved) {
    var now = Date.now(), have = {}; (saved || []).forEach(function (s) { if (s.id) have[s.id] = 1; });
    var res = function (list, k) { var x = list.filter(function (y) { return y.k === k; })[0]; return x && x.g >= 3 ? Math.max(-0.4, Math.min(0.4, x.units / x.g)) : 0; };
    var out = B.filter(function (p) {
      return Date.parse(p.start) > now && !(p.sel && have[p.sel]) && p.conf != null && p.price != null && (p.conf >= 0.5 || (p.price >= 100 && (p.edge || 0) > 0));
    }).map(function (p) {
      var ty = p.sport + ':' + type(p), fit = 0.4 * (P.hSport[p.sport] || 0) + 0.35 * (P.hType[ty] || 0) + 0.15 * (P.hSide[sideOf(p)] || 0) + 0.1 * (P.hBand[band(p.price)] || 0);
      var paid = 1 + res(P.sport, p.sport) + res(P.type, ty);
      var score = fit * paid * 0.65 + p.conf * 0.35;
      var why = [];
      var tT = P.type.filter(function (y) { return y.k === ty; })[0], tS = P.sport.filter(function (y) { return y.k === p.sport; })[0];
      if (tT && tT.g >= 3) why.push('your ' + typeName(type(p)) + ' ' + tT.w + '-' + tT.l + (tT.p ? '-' + tT.p : '') + ', ' + u2(tT.units));
      else if (P.hType[ty]) why.push(Math.round(100 * P.hType[ty]) + '% of your picks are ' + (LG[p.sport] || p.sport) + ' ' + typeName(type(p)));
      else if (tS && tS.g >= 3) why.push('your ' + (LG[p.sport] || p.sport) + ' ' + tS.w + '-' + tS.l + ', ' + u2(tS.units));
      else if (P.hSport[p.sport]) why.push('you play ' + (LG[p.sport] || p.sport));
      if ((P.hSide[sideOf(p)] || 0) >= 0.55 && (p.side === 'over' || p.side === 'under')) why.push('you lean ' + p.side + 's');
      return {p: p, score: score, fit: fit, why: why.join(' · ')};
    }).filter(function (x) { return x.fit > 0.05; }).sort(function (a, b) { return b.score - a.score; });
    var seen = {}, pick = [];
    for (var i = 0; i < out.length && pick.length < 5; i++) { var g = out[i].p.sport + ':' + (out[i].p.gid || out[i].p.matchup); if (seen[g]) continue; seen[g] = 1; pick.push(out[i]); }
    return pick;
  }
  function askQuery(P) {
    var ts = top(P.hSport), tt = top(P.hType), sd = top(P.hSide), q = [];
    if (ts) q.push(ASKS[ts[0]] || ts[0]);
    if (tt && tt[0].split(':')[0] === (ts || [])[0]) { var m = tt[0].split(':')[1]; if (ASKW[m]) q.push(ASKW[m]); }
    if (sd && (sd[0] === 'over' || sd[0] === 'under') && sd[1] >= 0.55) q.push(sd[0] + 's');
    if (P.medPrice != null && P.medPrice >= 100) q.push('plus money');
    q.push('3 leg parlay');
    return q.join(' ');
  }

  // ── the page ──────────────────────────────────────────────────────────────
  var CSS = [
    '.oxp{margin:28px 0}.oxp h2{margin:4px 0 6px}.oxp .lead{color:#b9b2c4;font-size:14px;line-height:1.55;margin:0 0 14px}',
    '.oxp-id{padding:14px 16px;border-radius:16px;border:1px solid rgba(176,56,249,.45);background:linear-gradient(160deg,rgba(176,56,249,.14),rgba(255,255,255,.02));margin-bottom:14px}',
    '.oxp-id small{display:block;font:700 10px monospace;letter-spacing:.1em;text-transform:uppercase;color:#d795ff;margin-bottom:6px}.oxp-id b{font-size:16px;line-height:1.45;color:#fff}',
    '.oxp-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}',
    '.oxp-c{padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}',
    '.oxp-c small{display:block;font:700 10px monospace;letter-spacing:.08em;text-transform:uppercase;color:#9a93a6;margin-bottom:5px}',
    '.oxp-c b{display:block;font-size:15px;color:#fff;line-height:1.3}.oxp-c span{display:block;font:600 11.5px monospace;color:#b9b2c4;margin-top:4px}',
    '.oxp-c .up{color:#61e970}.oxp-c .dn{color:#ff8a8a}',
    '.oxp h3{font-size:15px;margin:18px 0 8px;color:#fff}',
    '.oxp-t{width:100%;border-collapse:collapse;font:600 12px monospace}.oxp-t th{text-align:left;color:#9a93a6;font-weight:700;padding:6px 6px;border-bottom:1px solid rgba(255,255,255,.1)}',
    '.oxp-t td{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.05);color:#ddd}.oxp-t td.up{color:#61e970}.oxp-t td.dn{color:#ff8a8a}.oxp-tw{overflow-x:auto}',
    '.oxp-r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);margin-bottom:8px}',
    '.oxp-r b{font-size:14.5px;color:#fff}.oxp-r span{display:block;font:600 11px monospace;color:#9a93a6;margin-top:3px}.oxp-r em{display:block;font:600 11px monospace;font-style:normal;color:#d795ff;margin-top:3px}',
    '.oxp-r .pc{text-align:right}.oxp-r .pc b{font:800 18px monospace;color:#61e970}.oxp-r .pc small{display:block;font:700 9px monospace;color:#9a93a6}',
    '.oxp-r a.bet{grid-column:1/-1;justify-self:start;font:800 12px monospace;padding:6px 11px;border-radius:999px;background:linear-gradient(135deg,#b038f9,#635bff);color:#fff;text-decoration:none}',
    '.oxp-go{display:inline-block;margin:6px 0 4px;font:800 12px monospace;color:#fff;background:#a24bff;border-radius:999px;padding:10px 14px;text-decoration:none}',
    '.oxp-n{font:600 11.5px monospace;color:#8f879c;line-height:1.55;margin-top:8px}',
    '.oxp-e{padding:16px;border-radius:14px;border:1px dashed rgba(255,255,255,.18);color:#b9b2c4;font-size:14px;line-height:1.55}'
  ].join('\n');
  function css() { if (document.getElementById('onyx-profile-css')) return; var s = document.createElement('style'); s.id = 'onyx-profile-css'; s.textContent = CSS; document.head.appendChild(s); }
  function card(label, big, sub, cls) { return '<div class="oxp-c"><small>' + esc(label) + '</small><b class="' + (cls || '') + '">' + esc(big) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>'; }
  function rec(x) { return x.w + '-' + x.l + (x.p ? '-' + x.p : ''); }
  function table(rows, name) {
    rows = rows.filter(function (x) { return x.g; }).sort(function (a, b) { return b.units - a.units; });
    if (!rows.length) return '';
    return '<div class="oxp-tw"><table class="oxp-t"><tr><th></th><th>Record</th><th>Win</th><th>Units</th><th>ROI</th></tr>' + rows.map(function (x) {
      var c = x.units > 0 ? 'up' : x.units < 0 ? 'dn' : '';
      return '<tr><td>' + esc(name(x.k)) + '</td><td>' + rec(x) + '</td><td>' + (x.rate == null ? '-' : Math.round(x.rate) + '%') + '</td><td class="' + c + '">' + u2(x.units) + '</td><td class="' + c + '">' + (x.roi == null ? '-' : (x.roi > 0 ? '+' : '') + Math.round(x.roi) + '%') + '</td></tr>';
    }).join('') + '</table></div>';
  }
  function spotName(k) { var a = String(k).split(':'); return a.length > 1 ? (LG[a[0]] || a[0]) + ' ' + typeName(a[1]) : (LG[k] || k); }
  function draw(el) {
    var O = window.OnyxSaved;
    if (!O || !O.history) { el.innerHTML = ''; return; }
    var H = O.history(), P = study(H);
    if (!H.length) {
      el.innerHTML = '<section class="oxp"><span class="ox-eyebrow">Your profile</span><h2>The bettor you are.</h2><div class="oxp-e">Save picks with the star on any sport page and this fills in: your best sport, your best type of bet, the prices and sides you win with, your best picks, and picks for you every day that fit how you bet.</div></section>';
      return;
    }
    var T = P.total, c = T.units > 0 ? 'up' : T.units < 0 ? 'dn' : '';
    var bs = P.sport.filter(function (x) { return x.g >= 2; }).sort(function (a, b) { return b.units - a.units; })[0];
    var bt = P.type.filter(function (x) { return x.g >= 2; }).sort(function (a, b) { return b.units - a.units; })[0];
    var bb = P.band.filter(function (x) { return x.g >= 2; }).sort(function (a, b) { return b.units - a.units; })[0];
    var bside = P.side.filter(function (x) { return x.g >= 2 && x.k !== 'other'; }).sort(function (a, b) { return b.units - a.units; })[0];
    var html = '<section class="oxp"><span class="ox-eyebrow">Your profile</span><h2>The bettor you are.</h2>'
      + '<p class="lead">Built from every pick you have saved (' + H.length + ', ' + T.g + ' graded). Units are 1 unit on each pick at the Onyx price when you saved it.</p>'
      + '<div class="oxp-id"><small>How you bet</small><b>' + esc(headline(P)) + '</b></div>'
      + '<div class="oxp-g">'
      + card('Record', T.g ? rec(T) : 'No results yet', T.rate == null ? '' : Math.round(T.rate) + '% wins', '')
      + card('Units', T.g ? u2(T.units) : '-', T.roi == null ? '' : 'ROI ' + (T.roi > 0 ? '+' : '') + Math.round(T.roi) + '%', c)
      + card('Best sport', bs ? (LG[bs.k] || bs.k) : '-', bs ? rec(bs) + ' · ' + u2(bs.units) : 'needs 2+ graded picks', bs && bs.units > 0 ? 'up' : '')
      + card('Best type of bet', bt ? spotName(bt.k) : '-', bt ? rec(bt) + ' · ' + u2(bt.units) : 'needs 2+ graded picks', bt && bt.units > 0 ? 'up' : '')
      + card('Best prices', bb ? BANDN[bb.k].replace(/ \(.*/, '') : '-', bb ? rec(bb) + ' · ' + u2(bb.units) : '', bb && bb.units > 0 ? 'up' : '')
      + card('Best side', bside ? SIDEN[bside.k].replace(/ \(.*/, '') : '-', bside ? rec(bside) + ' · ' + u2(bside.units) : '', bside && bside.units > 0 ? 'up' : '')
      + (P.streak && P.streak.n >= 2 ? card('Streak', P.streak.n + ' ' + (P.streak.k === 'W' ? 'wins' : 'losses') + ' in a row', '') : '')
      + card('Pace', (Math.round(P.perDay * 10) / 10) + ' picks a day', 'median price ' + (P.medPrice == null ? '-' : odds(P.medPrice)))
      + '</div>';
    if (P.cold) html += '<div class="oxp-n">Coldest spot: ' + esc(spotName(P.cold.k)) + ' ' + rec(P.cold) + ', ' + u2(P.cold.units) + '. Worth a second look before the next one.</div>';
    html += '<h3>Picks for you today</h3><div id="oxpRecs"><div class="oxp-n">Reading today\'s boards...</div></div>';
    html += '<a class="oxp-go" href="home.html?ask=' + encodeURIComponent(askQuery(P)) + '#ask">Search my kind of bets: ' + esc(askQuery(P)) + '</a>';
    if (P.bestPicks.length) html += '<h3>Your best picks</h3>' + P.bestPicks.map(function (h) {
      return '<div class="oxp-r"><div><b>' + esc(h.label || h.name) + '</b><span>' + esc([LG[h.sport] || h.sport, h.matchup, h.final != null ? 'final ' + h.final : ''].filter(Boolean).join(' · ')) + '</span></div><div class="pc"><b>' + esc(odds(h.price)) + '</b><small>CASHED</small></div></div>';
    }).join('');
    if (P.names.length) html += '<div class="oxp-n">Players you come back to: ' + P.names.map(function (x) { return esc(x[0]) + ' (' + x[1] + ')'; }).join(', ') + '</div>';
    html += '<h3>By sport</h3>' + (table(P.sport, function (k) { return LG[k] || k; }) || '<div class="oxp-n">Results show here as your picks are graded.</div>')
      + '<h3>By type of bet</h3>' + table(P.type, spotName)
      + '<h3>By price</h3>' + table(P.band, function (k) { return BANDN[k] || k; })
      + '<h3>By side</h3>' + table(P.side.filter(function (x) { return x.k !== 'other'; }), function (k) { return SIDEN[k] || k; })
      + '<div class="oxp-n">Picks for you are our projections chosen to fit how you bet, not Onyx Picks. Onyx Picks are on the Onyx Picks page.</div></section>';
    el.innerHTML = html;
    boards().then(function (B) {
      var R = recs(P, B, O.all ? O.all() : []), box = el.querySelector('#oxpRecs');
      if (!box) return;
      if (!R.length) { box.innerHTML = '<div class="oxp-n">Nothing on today\'s boards fits your profile yet. Check back when the next slate posts.</div>'; return; }
      window.OXP_RECS = R.map(function (x) { return x.p; });
      box.innerHTML = R.map(function (x, i) {
        var p = x.p, url = p.sel ? 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(p.sel) + '&referrer=' + REFERRER : 'home.html';
        var star = O.btn ? O.btn(Object.assign({id: p.sel}, p)) : '';
        return '<div class="oxp-r"><div><b>' + esc(p.label) + '</b><span>' + esc([LG[p.sport] || p.sport, p.matchup].join(' · ')) + '</span>' + (x.why ? '<em>Why you: ' + esc(x.why) + '</em>' : '') + '</div>'
          + '<div class="pc"><b>' + Math.round(100 * p.conf) + '%</b><small>TO HIT</small></div>'
          + '<a class="bet" href="' + url + '" target="_blank" rel="noopener">' + esc(odds(p.price)) + (p.src === 'market' ? ' market line' : ' on Onyx') + '</a>' + star + '</div>';
      }).join('');
    });
  }
  function mount(el) {
    if (!el) return;
    css(); draw(el);
    ['onyx-history', 'onyx-saved'].forEach(function (e) { addEventListener(e, function () { draw(el); }); });
    if (window.OnyxSaved && OnyxSaved.grade) OnyxSaved.grade().then(function () { draw(el); });
  }
  window.OnyxProfile = {mount: mount, study: study, recs: recs, headline: headline, askQuery: askQuery};
})();
