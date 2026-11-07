// sidesday.js - sides and totals of the day, every sport, with the numbers and an AI write-up
// (11/6, Jordan: "a section with an AI writeup for picks of the day on sides and totals, be transparent
// on the % and why we're picking it in every sport").
//
// For each sport: the best-value side (spread or moneyline) and the best-value total on today's games that
// have not started, from data/<sport>/board.json. Every number is shown: our chance, the chance the price
// implies, the edge, the model's projected score and what moved it, the market's record against real prices
// in testing (data/picks/backtest.json), and whether it is an Onyx Pick (data/picks/ledger.json) or a
// projection. The write-up comes from the AI relay ({writeup}), written only from those numbers and cached for
// the day; without the relay, a plain write-up from the same numbers.
//
//   OnyxSides.mount(el, {sports: ['nba']})     every sport when sports is omitted
(function () {
  'use strict';
  var SP = [['nfl', 'NFL'], ['nba', 'NBA'], ['nhl', 'NHL'], ['tennis', 'Tennis'], ['cfb', 'College football'], ['cbb', 'College basketball']];
  var NAME = {}; SP.forEach(function (x) { NAME[x[0]] = x[1]; });
  var MK = {spread: 'spreads', ml: 'moneylines', total: 'totals'};
  var CSS = [
    '.oxs{margin:0 0 18px}.oxs-h h3{margin:0 0 4px;font-size:20px;color:#fff}.oxs-sub{margin:0 0 12px;color:#b9b2c4;font-size:13px;line-height:1.55}',
    '.oxs-sp{margin:14px 0 6px;font:800 12px monospace;letter-spacing:.08em;text-transform:uppercase;color:#d795ff}',
    '.oxs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:10px}',
    '.oxs-c{border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:13px 14px;background:rgba(255,255,255,.035);min-width:0}',
    '.oxs-c.pk{border-color:rgba(176,56,249,.55);background:linear-gradient(160deg,rgba(176,56,249,.14),rgba(255,255,255,.02))}',
    '.oxs-t{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}',
    '.oxs-tag{display:inline-block;padding:2px 8px;border-radius:999px;font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.08);color:#ddd}',
    '.oxs-tag.pk{background:rgba(176,56,249,.25);color:#e9c8ff}.oxs-tag.ai{background:rgba(97,233,112,.12);color:#61e970}',
    '.oxs-c b.l{display:block;font-size:17px;line-height:1.3;color:#fff;overflow-wrap:anywhere}.oxs-c .m{font-size:12.5px;color:#b9b2c4;margin-top:2px}',
    '.oxs-n{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:10px 0}',
    '.oxs-n div{padding:7px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center;min-width:0}',
    '.oxs-n b{display:block;font:800 15px monospace;color:#fff}.oxs-n span{font:600 9px monospace;letter-spacing:.06em;text-transform:uppercase;color:#9a93a6}',
    '.oxs-n .pos{color:#61e970}.oxs-n .neg{color:#ff8a8a}',
    '.oxs-why{font-size:13px;line-height:1.6;color:#e6e1ee}.oxs-f{margin-top:8px;font:600 11px monospace;color:#9a93a6;line-height:1.55}',
    '.oxs-empty{color:#9a93a6;font-size:13px;padding:6px 0}.oxs [hidden]{display:none!important}',
    '.oxs-tag.nv{background:rgba(255,255,255,.05);color:#9a93a6}'
  ].join('\n');
  function css() { if (document.getElementById('onyx-sides-css')) return; var s = document.createElement('style'); s.id = 'onyx-sides-css'; s.textContent = CSS; document.head.appendChild(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(p) { return p == null ? '-' : p > 0 ? '+' + p : String(p); }
  function pay(p) { return p > 0 ? p / 100 : 100 / -p; }
  function implied(p) { return p > 0 ? 100 / (p + 100) : -p / (-p + 100); }
  function pc(x) { return Math.round(100 * x) + '%'; }
  function siteDay(t) { return new Date(t - 4 * 3600e3).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); }
  function et(iso) { try { return new Date(iso).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET'; } catch (e) { return ''; } }
  function getJSON(u) { return fetch(u + '?t=' + Math.floor(Date.now() / 60000), {cache: 'no-store'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  // "model ARI 14.2 SEA 30.3 · ARI Gardner Minshew II at QB (1 prior start) -3.4" -> projected score + factors
  function split(why) {
    var w = String(why || ''), m = w.match(/^model\s+(\S+)\s+([\d.]+)\s+(\S+)\s+([\d.]+)/);
    var rest = w.split(' · ').slice(m ? 1 : 0).filter(function (x) { return x && !/^model /.test(x); });
    var tot = rest.filter(function (x) { return /^total [\d.]+$/.test(x); })[0];
    rest = rest.filter(function (x) { return x !== tot; });
    var proj = m ? m[1] + ' ' + m[2] + ', ' + m[3] + ' ' + m[4] + ' (total ' + (tot ? tot.slice(6) : (+m[2] + +m[4]).toFixed(1)) + ')' : null;
    return {proj: proj, factors: rest.join('; ') || null};
  }
  function testTxt(BT, sport, kind) {
    var m = (BT || []).filter(function (x) { return x.sport === sport && x.market === kind; })[0];
    if (!m) return 'not tested against real prices yet';
    var o = (m.test || {}).open || {};
    var rec = o.n ? o.w + '-' + o.l + ' on games the model never saw, ' + (o.roi >= 0 ? '+' : '') + (100 * o.roi).toFixed(1) + '% at the opening price' : 'no held-out bets yet';
    return ({finalized: 'passed its test (' + rec + ')', 'not enough yet': 'not enough tested games yet (' + rec + ')', fails: 'failed its test (' + rec + ')'})[m.verdict] || (m.verdict + ' (' + rec + ')');
  }
  function pick(rows, sport, kinds, LED) {
    var now = Date.now(), d = siteDay(now);
    // only lines the model priced: the other side of a model-priced game borrows that game's reading
    // (both_sides gives it the complement chance); a market price with no model behind it is not a read
    var W = {}; rows.forEach(function (p) { if (p.why && /^(model |Elo )/.test(p.why)) W[p.gid + '|' + p.kind] = p.why; });
    var C = rows.filter(function (p) {
      return kinds.indexOf(p.kind) >= 0 && p.price != null && p.conf != null && p.price >= -250 && p.price <= 250
        && W[p.gid + '|' + p.kind] && Date.parse(p.start) > now && siteDay(Date.parse(p.start)) === d;
    }).map(function (p) { return p.why ? p : Object.assign({}, p, {why: W[p.gid + '|' + p.kind]}); });
    if (!C.length) return null;
    var ev = function (p) { return p.conf * (1 + pay(p.price)) - 1; };
    C.sort(function (a, b) { return ev(b) - ev(a) || b.conf - a.conf; });
    var p = C[0], sp = split(p.why);
    var isPick = (LED || []).some(function (r) { return r.sport === sport && String(r.gid) === String(p.gid) && r.label === p.label; });
    return {p: p, proj: sp.proj, factors: sp.factors, pick: isPick, imp: implied(p.price), edge: p.conf - implied(p.price), ev: ev(p), none: ev(p) <= 0 && p.conf - implied(p.price) <= 0};
  }
  function plain(x, test) {
    var p = x.p, e = Math.round(1000 * x.edge) / 10;
    return p.label + ': our chance is ' + pc(p.conf) + ' against the ' + pc(x.imp) + ' the ' + odds(p.price) + ' price implies, '
      + (e > 0 ? 'an edge of ' + e + ' points.' : e === 0 ? 'no edge.' : e + ' points: no value at this price.')
      + (x.proj ? ' The model projects ' + x.proj + '.' : '') + (x.factors ? ' What moved it: ' + x.factors + '.' : '')
      + ' This market has ' + test + '. ' + (x.pick ? 'It is an Onyx Pick, on the graded record.' : 'A projection, not an Onyx Pick.');
  }
  function card(x, sport, kindLab, BT) {
    var p = x.p, test = testTxt(BT, sport, p.kind), e = 100 * x.edge;
    return '<div class="oxs-c' + (x.pick ? ' pk' : '') + '" data-oxs="' + esc(sport + '|' + p.gid + '|' + p.label) + '">'
      + '<div class="oxs-t"><span class="oxs-tag ' + (x.pick ? 'pk' : '') + '">' + (x.pick ? 'Onyx Pick' : 'Projection') + '</span><span class="oxs-tag">' + kindLab + '</span>'
      + (x.none ? '<span class="oxs-tag nv">No value today · the closest</span>' : '')
      + (p.src === 'market' ? '<span class="oxs-tag">Market line</span>' : '') + '<span class="oxs-tag ai" hidden>AI write-up</span></div>'
      + '<b class="l">' + esc(p.label) + ' ' + odds(p.price) + '</b><div class="m">' + esc(p.matchup) + ' · ' + esc(et(p.start)) + '</div>'
      + '<div class="oxs-n"><div><b>' + pc(p.conf) + '</b><span>Our chance</span></div><div><b>' + pc(x.imp) + '</b><span>Price implies</span></div>'
      + '<div><b class="' + (e > 0 ? 'pos' : 'neg') + '">' + (e > 0 ? '+' : '') + e.toFixed(1) + '</b><span>Edge, pts</span></div></div>'
      + '<div class="oxs-why">' + esc(plain(x, test)) + '</div>'
      + '<div class="oxs-f">' + (x.proj ? 'Model score: ' + esc(x.proj) + '<br>' : '') + (x.factors ? 'Factors: ' + esc(x.factors) + '<br>' : '') + 'Test record: ' + esc(test) + '</div></div>';
  }
  function aiUrl() { return getJSON('ai.json').then(function (j) { return (j && j.url) || ''; }).catch(function () { return ''; }); }
  function mount(el, opt) {
    if (!el) return Promise.resolve();
    css(); opt = opt || {};
    var sports = SP.filter(function (x) { return !opt.sports || opt.sports.indexOf(x[0]) >= 0; });
    el.innerHTML = '<div class="oxs-empty">Loading today\'s sides and totals...</div>';
    return Promise.all([Promise.all(sports.map(function (x) { return getJSON('data/' + x[0] + '/board.json').then(function (j) { return j.plays || []; }).catch(function () { return []; }); })),
                        getJSON('data/picks/backtest.json').then(function (j) { return j.markets || []; }).catch(function () { return []; }),
                        getJSON('data/picks/ledger.json').catch(function () { return []; })]).then(function (r) {
      var B = r[0], BT = r[1], LED = r[2], items = [], html = '';
      sports.forEach(function (x, i) {
        var side = pick(B[i], x[0], ['spread', 'ml'], LED), tot = pick(B[i], x[0], ['total'], LED);
        if (!side && !tot) {
          if (sports.length === 1 || B[i].some(function (p) { return p.kind === 'spread' || p.kind === 'total'; }))
            html += (sports.length > 1 ? '<div class="oxs-sp">' + esc(x[1]) + '</div>' : '') + '<div class="oxs-empty">' + (x[0] === 'nba'
              ? 'No NBA game model yet: the NBA model reads players and the 1st quarter, so its sides and totals are the market price, not a read.'
              : 'No ' + esc(x[1]) + ' side or total our model priced on today\'s games that have not started.') + '</div>';
          return;
        }
        html += (sports.length > 1 ? '<div class="oxs-sp">' + esc(x[1]) + '</div>' : '') + '<div class="oxs-grid">'
          + (side ? card(side, x[0], 'Side', BT) : '') + (tot ? card(tot, x[0], 'Total', BT) : '') + '</div>';
        [side, tot].forEach(function (y) {
          if (!y) return;
          items.push({id: x[0] + '|' + y.p.gid + '|' + y.p.label, sport: x[1], play: y.p.label, game: y.p.matchup, price: y.p.price,
                      chance: Math.round(1000 * y.p.conf) / 10, implied: Math.round(1000 * y.imp) / 10, edge: Math.round(1000 * y.edge) / 10,
                      proj: y.proj, factors: y.factors, status: y.pick ? 'Onyx Pick' : 'Projection', test: testTxt(BT, x[0], y.p.kind)});
        });
      });
      el.innerHTML = '<div class="oxs"><div class="oxs-h"><h3>' + esc(opt.title || 'Sides and totals of the day') + '</h3></div>'
        + '<p class="oxs-sub">One side and one total per sport: the best value on today\'s games by our numbers, with every number shown. Each write-up is AI, written only from the numbers on its card. Projections unless marked Onyx Pick.</p>'
        + (html || '<div class="oxs-empty">No side or total on today\'s games is priced right now. They show here as lines post.</div>') + '</div>';
      if (!items.length) return;
      return aiUrl().then(function (u) {
        if (!u) return;
        return fetch(u, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({writeup: {items: items}})})
          .then(function (rs) { return rs.ok ? rs.json() : null; }).then(function (j) {
            ((j && j.items) || []).forEach(function (w) {
              if (!w || !w.text || /—/.test(w.text)) return;
              var c = [].slice.call(el.querySelectorAll('[data-oxs]')).filter(function (n) { return n.getAttribute('data-oxs') === w.id; })[0];
              if (!c) return;
              c.querySelector('.oxs-why').textContent = w.text;
              var t = c.querySelector('.oxs-tag.ai'); if (t) t.hidden = false;
            });
          }).catch(function () {});
      });
    }).catch(function () { el.innerHTML = '<div class="oxs-empty">Sides and totals could not load right now.</div>'; });
  }
  window.OnyxSides = {mount: mount};
})();
