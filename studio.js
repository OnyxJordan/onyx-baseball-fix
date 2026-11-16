// studio.js - Onyx NFL Studio (11/15, Jordan: "player & odds comparison tool, play it out, parlay lab, Sunday Sweat,
// and onyx insights ... lets go wild"). The frame every Studio tool plugs into: the tab bar (#compare, #sim, #lab,
// #sweat, #insights), one shared load of the NFL data, and the helpers every tool uses.
//
// A tool registers itself:  Studio.register('sim', {title: 'Play It Out', order: 2, mount: function (el, D) {...}})
// mount() runs once, the first time its tab opens, with D (below); it may return {show: fn} to refresh on revisits.
//
// D = {
//   date, generated,                    board build day and time
//   plays: [...],                       data/nfl/board.json rows (every Onyx price the model reads; see daily_top.write_board)
//   games: [...],                       data/nfl/slate.json games (gid, start, state, away, home, names, logos)
//   pre: [...],                         games still to start
//   game(gid), playsFor(gid), byPlayer(name) -> rows, players() -> [{name, team, pos?, rows}]
//   card(team) -> Promise data/nfl/cards/<TEAM>.json (team record, recent games, players), cached
//   history() -> Promise data/nfl/player_games.json rows (2.4 MB, loaded on demand), cached
//   tops() -> Promise data/nfl/tops.json (the Plays tab lists)
// }
// Helpers on Studio.u: esc, odds(a) "+150", dec(a), amer(d), imp(a) implied chance, pct(x, d), fmtTime(iso),
// onyx(sels[], tag) -> Onyx share URL (one or many selections, referral KR680261), onyxBtn(row, text) -> a chip.
(function () {
  'use strict';
  var REG = {}, D = null, LOADING = null, MOUNTED = {}, REFERRER = 'KR680261';
  var NAMES = {compare: 'Compare', sim: 'Play It Out', lab: 'Parlay Lab', sweat: 'Sunday Sweat', insights: 'Insights'};
  var ORDER = ['compare', 'sim', 'lab', 'sweat', 'insights'];

  var u = {
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); },
    odds: function (a) { return a == null ? '-' : (a > 0 ? '+' : '') + Math.round(a); },
    dec: function (a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; },
    amer: function (d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); },
    imp: function (a) { return a > 0 ? 100 / (a + 100) : -a / (-a + 100); },
    pct: function (x, d) { return x == null || isNaN(x) ? '-' : (100 * x).toFixed(d == null ? 0 : d) + '%'; },
    fmtTime: function (iso) {
      var t = new Date(iso); if (isNaN(t)) return '';
      return t.toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'});
    },
    onyx: function (sels, tag) {
      sels = (sels || []).filter(Boolean); if (!sels.length) return null;
      return 'https://app.onyxodds.com/share?' + sels.map(function (s) { return 'selection=' + encodeURIComponent(s); }).join('&') + '&referrer=' + REFERRER;
    },
    onyxBtn: function (row, text) {
      if (!row || !row.sel) return '<span class="sx-chip">' + u.esc(text || u.odds(row && row.price)) + '</span>';
      return '<a class="sx-chip onyx" target="_blank" rel="noopener" href="' + u.esc(u.onyx([row.sel], 'single')) + '">' + u.esc(text || ('Onyx ' + u.odds(row.price))) + '</a>';
    },
    nk: function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, ''); }
  };

  function getJSON(p) { return fetch(p + (p.indexOf('?') < 0 ? '?' : '&') + 'v=' + Math.floor(Date.now() / 60000)).then(function (r) { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); }); }

  function load() {
    if (LOADING) return LOADING;
    LOADING = Promise.all([getJSON('data/nfl/board.json'), getJSON('data/nfl/slate.json').catch(function () { return {}; })]).then(function (a) {
      var b = a[0] || {}, s = a[1] || {}, plays = b.plays || [];
      // next week's games too (11/16): the board carries their openers from the moment Onyx prices them
      var games = (s.games || []).concat((s.next_games || []).filter(function (g) { return plays.some(function (p) { return p.gid === g.gid; }); }));
      var gi = {}; games.forEach(function (g) { gi[g.gid] = g; });
      var bp = {}; plays.forEach(function (p) { if (p.kind === 'prop' && p.name) (bp[u.nk(p.name)] = bp[u.nk(p.name)] || []).push(p); });
      var cards = {}, hist = null, tops = null;
      D = {
        date: b.date, generated: b.generated, plays: plays, games: games,
        pre: games.filter(function (g) { return g.state === 'pre'; }),
        game: function (gid) { return gi[gid] || null; },
        playsFor: function (gid) { return plays.filter(function (p) { return p.gid === gid; }); },
        byPlayer: function (name) { return bp[u.nk(name)] || []; },
        players: function () {
          return Object.keys(bp).map(function (k) { var r = bp[k]; return {name: r[0].name, team: r[0].team, gid: r[0].gid, matchup: r[0].matchup, role: (r.filter(function (x) { return x.role; })[0] || {}).role || null, rows: r}; })
            .sort(function (x, y) { return x.name.localeCompare(y.name); });
        },
        card: function (team) { if (!cards[team]) cards[team] = getJSON('data/nfl/cards/' + encodeURIComponent(team) + '.json').catch(function () { return null; }); return cards[team]; },
        history: function () { if (!hist) hist = getJSON('data/nfl/player_games.json').then(function (j) { return j.rows || []; }).catch(function () { return []; }); return hist; },
        tops: function () { if (!tops) tops = getJSON('data/nfl/tops.json').catch(function () { return {lists: []}; }); return tops; }
      };
      return D;
    });
    return LOADING;
  }

  function show(key) {
    if (!REG[key]) key = ORDER.filter(function (k) { return REG[k]; })[0];
    if (!key) return;
    Array.prototype.forEach.call(document.querySelectorAll('.st-tab'), function (b) { b.classList.toggle('on', b.dataset.k === key); b.setAttribute('aria-selected', b.dataset.k === key); });
    Array.prototype.forEach.call(document.querySelectorAll('.st-pane'), function (p) { p.classList.toggle('on', p.id === 'st-' + key); });
    if (location.hash.slice(1).split('?')[0] !== key) history.replaceState(null, '', '#' + key);
    var el = document.getElementById('st-' + key);
    if (MOUNTED[key]) { if (MOUNTED[key].show) try { MOUNTED[key].show(); } catch (e) { console.error(e); } return; }
    el.innerHTML = '<div class="st-load">Loading the board</div>';
    load().then(function (d) {
      el.innerHTML = '';
      try { MOUNTED[key] = REG[key].mount(el, d, u) || {}; }
      catch (e) { console.error(e); el.innerHTML = '<div class="st-err">' + u.esc(NAMES[key] || key) + ' could not load: ' + u.esc(e.message) + '</div>'; MOUNTED[key] = {}; }
    }).catch(function (e) { el.innerHTML = '<div class="st-err">The NFL board could not load (' + u.esc(e.message) + '). Pull to refresh.</div>'; });
  }

  // one Onyx click event per tap on any Onyx link in the Studio (counted on the tap, never when a link is drawn)
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="https://app.onyxodds.com/share"]'); if (!a) return;
    try { if (window.gtag) gtag('event', 'onyx_click', {link_type: 'studio_' + (location.hash.slice(1).split('?')[0] || 'tab'), legs: (a.href.match(/selection=/g) || []).length}); } catch (x) {}
  }, true);

  function start() {
    var tabs = document.getElementById('stTabs'), panes = document.getElementById('stPanes');
    var keys = ORDER.filter(function (k) { return REG[k]; }).concat(Object.keys(REG).filter(function (k) { return ORDER.indexOf(k) < 0; }));
    tabs.innerHTML = keys.map(function (k) { return '<button class="st-tab" role="tab" data-k="' + k + '">' + u.esc(REG[k].title || NAMES[k] || k) + '</button>'; }).join('');
    panes.innerHTML = keys.map(function (k) { return '<section class="st-pane" id="st-' + k + '" role="tabpanel"></section>'; }).join('');
    tabs.addEventListener('click', function (e) { var b = e.target.closest('.st-tab'); if (b) show(b.dataset.k); });
    window.addEventListener('hashchange', function () { show(location.hash.slice(1).split('?')[0]); });
    show(location.hash.slice(1).split('?')[0]);
  }

  // query params on the hash (#sim?gid=401873063): tools read them for deep links
  function param(k) { var q = (location.hash.split('?')[1] || ''); var m = q.match(new RegExp('(^|&)' + k + '=([^&]*)')); return m ? decodeURIComponent(m[2]) : null; }

  window.Studio = {register: function (k, def) { REG[k] = def; }, start: start, show: show, load: load, u: u, param: param, checks: {}};
})();
