// saved.js - "Save" a pick on this device, follow it live in My Onyx (home.html), and get
// a pop-up the moment it wins, on whatever Onyx page is open.
// One localStorage list (onyxSaved) shared by every page on this origin. A pick:
//   {id: Onyx selection id, sport, label, matchup, start, gid, team, price, conf,
//    kind: prop|spread|total|ml, mkt (pts, rec, rush_yds, q1_total...), side, line,
//    hcap (spread), name (player or team), saved: ISO time}
// Pages call OnyxSaved.btn(pick) for the star button; home.html reads OnyxSaved.all().
//
// Win alerts (11/1, the Onyx Baseball home-run alert, for every saved pick): every 45 s
// while a page is open, each saved pick whose game has started is checked against ESPN's
// live scoreboard and box score (OnyxSaved.track, the same rules My picks uses). When one
// wins (a prop's over clears the line, an under or a game line goes final on the right
// side) a celebration pop-up opens once, on any page, and with alerts turned on (the More
// menu, or "Alert me" after saving) a phone notification fires too. Alerts reach the
// phone while the app is open or in the background; a fully closed app needs push (OneSignal),
// as on Onyx Baseball.
(function () {
  var KEY = 'onyxSaved', KEEP_H = 24, REG = [];
  var SHOWN = 'onyxWinShown', ALERTS = 'onyxWinAlerts', REFERRER = 'KR680261';
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
  var LG = {nfl: {path: 'football/nfl', page: 'nfl.html'}, nba: {path: 'basketball/nba', page: 'nba.html'},
    nhl: {path: 'hockey/nhl', page: 'nhl.html'}, cfb: {path: 'football/college-football', page: 'cfb.html', q: 'groups=80&limit=300'},
    mlb: {path: 'baseball/mlb', page: 'index.html'}};
  var STAT = {pts: ['basketball', 'PTS'], reb: ['basketball', 'REB'], ast: ['basketball', 'AST'],
    rec: ['receiving', 'REC'], rec_yds: ['receiving', 'YDS'], rush_yds: ['rushing', 'YDS'], pass_yds: ['passing', 'YDS']};

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; } }
  function write(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} try { dispatchEvent(new Event('onyx-saved')); } catch (e) {} }
  function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // a pick drops off 24 hours after its game starts: tonight's picks, followed through the night
  function all() {
    var now = Date.now(), a = read(), keep = a.filter(function (p) { var t = Date.parse(p.start || p.saved); return isNaN(t) || now - t < KEEP_H * 3600e3; });
    if (keep.length !== a.length) write(keep);
    return keep;
  }
  function has(id) { return !!id && read().some(function (p) { return p.id === id; }); }
  function remove(id) { write(read().filter(function (p) { return p.id !== id; })); }
  function toast(msg, opts) { if (window.OX_TOAST) { try { window.OX_TOAST(msg, opts || {}); return; } catch (e) {} } }
  function alertsOn() { return lsGet(ALERTS, 0) === 1 && typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
  function canAsk() { return typeof Notification !== 'undefined' && Notification.permission !== 'denied'; }
  function toggle(p) {
    if (!p || !p.id) return false;
    if (has(p.id)) { remove(p.id); toast('Removed from My picks'); return false; }
    var a = read(); a.push(Object.assign({}, p, {saved: new Date().toISOString()})); write(a);
    if (!alertsOn() && canAsk()) toast('Saved. We will pop up the moment it wins', {action: 'Alert me', onAction: function () { setAlerts(true); }});
    else toast('Saved. We will pop up the moment it wins');
    try { if (window.gtag) gtag('event', 'pick_save', {sport: p.sport}); } catch (e) {}
    setTimeout(watch, 1500);
    return true;
  }
  function tap(el, i) {
    var on = toggle(REG[i]);
    el.classList.toggle('on', on); el.innerHTML = on ? '★' : '☆';
    el.setAttribute('aria-label', on ? 'Saved' : 'Save pick');
  }
  function btn(p) {
    if (!p || !p.id) return '';
    var i = REG.push(p) - 1, on = has(p.id);
    return '<button class="ox-save' + (on ? ' on' : '') + '" aria-label="' + (on ? 'Saved' : 'Save pick') + '" title="Save this pick and follow it live" ' +
      'onclick="event.stopPropagation();event.preventDefault();OnyxSaved.tap(this,' + i + ')">' + (on ? '★' : '☆') + '</button>';
  }

  // ── live tracking off ESPN (the rules home.html's My picks uses) ──────────
  var SB = {}, SUM = {}, TN = {t: 0, c: []};
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function getJSON(u) { return fetch(u).then(function (r) { return r.json(); }); }
  function scoreboard(k) {
    var L = LG[k], s = SB[k];
    if (s && Date.now() - s.t < 30e3) return Promise.resolve(s.ev);
    return getJSON(ESPN + L.path + '/scoreboard' + (L.q ? '?' + L.q : '')).then(function (j) {
      var ev = (j.events || []).map(function (e) {
        var c = (e.competitions || [{}])[0], st = (e.status || {}).type || {}, t = {};
        (c.competitors || []).forEach(function (x) { t[x.homeAway] = x; });
        var T = function (x) { return {ab: ((x || {}).team || {}).abbreviation, sc: (x || {}).score}; };
        return {id: e.id, state: st.state, detail: st.shortDetail || st.detail, a: T(t.away), h: T(t.home)};
      });
      SB[k] = {t: Date.now(), ev: ev};
      return ev;
    }).catch(function () { return (s || {}).ev || []; });
  }
  function summary(k, id) {
    var s = SUM[id];
    if (s && (s.state === 'post' || Date.now() - s.t < 30e3)) return Promise.resolve(s.j);
    return getJSON(ESPN + LG[k].path + '/summary?event=' + id).then(function (j) {
      SUM[id] = {t: Date.now(), j: j, state: ((((j.header || {}).competitions || [{}])[0].status || {}).type || {}).state};
      return j;
    }).catch(function () { return null; });
  }
  function tennis() {
    if (Date.now() - TN.t < 30e3) return Promise.resolve(TN.c);
    return Promise.all(['atp', 'wta'].map(function (t) { return getJSON(ESPN + 'tennis/' + t + '/scoreboard').catch(function () { return {events: []}; }); })).then(function (js) {
      var c = [];
      js.forEach(function (j) { (j.events || []).forEach(function (e) { (e.groupings || []).forEach(function (g) { if (/Singles/.test((g.grouping || {}).displayName || '')) c = c.concat(g.competitions || []); }); }); });
      TN = {t: Date.now(), c: c};
      return c;
    });
  }
  function statOf(j, p) {
    var v = null, td = 0, seen = false;
    ((j && j.boxscore || {}).players || []).forEach(function (t) { (t.statistics || []).forEach(function (b) { (b.athletes || []).forEach(function (a) {
      if (nk((a.athlete || {}).displayName) !== nk(p.name) || !(a.stats || []).length) return;
      var L = b.labels || b.keys || [], at = function (l) { var i = L.indexOf(l); return i < 0 ? null : (a.stats || [])[i]; };
      seen = true;
      if (p.mkt === 'anytime_td') { if (b.name === 'rushing' || b.name === 'receiving') td += parseFloat(at('TD')) || 0; return; }
      var m = STAT[p.mkt]; if (!m) return;
      if (m[0] === 'basketball' || b.name === m[0]) { var x = parseFloat(at(m[1])); if (!isNaN(x)) v = x; }
    }); }); });
    if (p.mkt === 'anytime_td') return seen ? td : null;
    return v != null ? v : seen ? 0 : null;
  }
  function q1Of(j) {
    var cs = (((j || {}).header || {}).competitions || [{}])[0].competitors || [];
    var q = cs.map(function (c) { var l = (c.linescores || [])[0] || {}; return parseFloat(l.displayValue != null ? l.displayValue : l.value); });
    return q.length === 2 && q.every(function (x) { return !isNaN(x); }) ? q[0] + q[1] : null;
  }
  // {state: pre|in|post, res: W|L|P|up|down|null, cur: the stat or score now}
  function track(p) {
    var out = {p: p, state: 'pre', res: null, cur: null};
    if (p.sport === 'tennis') {
      return tennis().then(function (C) {
        var hit = C.filter(function (c) { return (c.competitors || []).some(function (x) { return nk((x.athlete || {}).displayName) === nk(p.name); }); }).pop();
        if (!hit) return out;
        var st = (hit.status || {}).type || {}, me = hit.competitors.filter(function (x) { return nk((x.athlete || {}).displayName) === nk(p.name); })[0];
        out.state = st.state;
        if (p.kind === 'ml' && st.state === 'post') out.res = me && me.winner ? 'W' : 'L';
        return out;
      });
    }
    var L = LG[p.sport];
    if (!L) return Promise.resolve(out);
    return scoreboard(p.sport).then(function (E) {
      var away = String(p.matchup || '').split(/ @ | vs /)[0];
      var e = p.sport === 'nba' ? E.filter(function (x) { return x.a.ab === (p.team || away) || x.h.ab === (p.team || away); })[0]
        : (E.filter(function (x) { return x.id === p.gid; })[0] || (p.team ? E.filter(function (x) { return x.a.ab === p.team || x.h.ab === p.team; })[0] : null));
      if (!e) return out;
      out.state = e.state; out.gid = e.id;
      if (e.state === 'pre') return out;
      var as = parseFloat(e.a.sc) || 0, hs = parseFloat(e.h.sc) || 0, done = e.state === 'post';
      var mine = p.name === e.a.ab ? [as, hs] : p.name === e.h.ab ? [hs, as] : null;
      var settle = function (win, push, early) {
        if (win != null) out.res = (done || early) ? (push ? 'P' : win ? 'W' : 'L') : (win ? 'up' : 'down');
        return out;
      };
      if (p.kind === 'ml' && mine) { out.cur = mine[0] + '-' + mine[1]; return settle(mine[0] > mine[1], mine[0] === mine[1], false); }
      if (p.kind === 'spread' && mine && p.hcap != null) { var m = mine[0] + p.hcap - mine[1]; out.cur = mine[0] + '-' + mine[1]; return settle(m > 0, m === 0, false); }
      if (p.kind === 'total') { var t = as + hs; out.cur = t; var w = p.side === 'over' ? t > p.line : t < p.line; return settle(w, t === p.line, p.side === 'over' && w); }
      return summary(p.sport, e.id).then(function (j) {
        var v = p.mkt === 'q1_total' ? q1Of(j) : statOf(j, p);
        if (v == null) return out;
        var line = p.mkt === 'anytime_td' ? 0.5 : p.line, win = p.side === 'under' ? v < line : v > line;
        var q1over = p.mkt === 'q1_total' && ((((j || {}).header || {}).competitions || [{}])[0].status || {}).period > 1;
        out.cur = v;
        return settle(win, v === line, q1over || (p.side !== 'under' && win));
      });
    }).catch(function () { return out; });
  }

  // ── the win pop-up ────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(a) { return a == null ? '' : (a > 0 ? '+' : '') + a; }
  function pays(a) { return a == null ? null : 10 + 10 * (a > 0 ? a / 100 : 100 / -a); }
  var MW = {pts: 'points', reb: 'rebounds', ast: 'assists', rec: 'catches', rec_yds: 'receiving yards', rush_yds: 'rushing yards',
    pass_yds: 'passing yards', anytime_td: 'touchdowns', q1_total: 'in the 1st quarter'};
  function finalLine(t) {
    var p = t.p;
    if (t.cur == null) return '';
    if (p.kind === 'ml' || p.kind === 'spread') return 'Score ' + t.cur;
    if (p.kind === 'total') return t.cur + ' total, line ' + p.line;
    return t.cur + ' ' + (MW[p.mkt] || '') + (p.mkt === 'anytime_td' ? '' : ', line ' + p.line);
  }
  var queue = [], open = false;
  function celebrate(t) {
    if (open) { queue.push(t); return; }
    open = true;
    var p = t.p, pay = pays(p.price), page = (LG[p.sport] || {page: p.sport + '.html'}).page;
    var back = document.createElement('div');
    back.className = 'oxw-back';
    var bits = '';
    for (var i = 0; i < 26; i++) bits += '<i style="left:' + (4 + Math.random() * 92).toFixed(1) + '%;animation-delay:' + (Math.random() * .5).toFixed(2) + 's;background:' +
      ['#b038f9', '#d795ff', '#61e970', '#635bff', '#ffffff'][i % 5] + ';transform:rotate(' + Math.round(Math.random() * 180) + 'deg)"></i>';
    back.innerHTML = '<div class="oxw-fx">' + bits + '</div><div class="oxw" role="dialog" aria-modal="true" aria-label="Your pick won">' +
      '<button class="oxw-x" aria-label="Close">×</button>' +
      '<div class="oxw-eb">' + esc(String(p.sport || '').toUpperCase()) + ' · YOUR PICK CASHED</div>' +
      '<div class="oxw-big">WON</div>' +
      '<div class="oxw-l">' + esc(p.label || p.name) + '</div>' +
      (finalLine(t) ? '<div class="oxw-s">' + esc(finalLine(t)) + '</div>' : '') +
      '<div class="oxw-g">' +
        (p.price != null ? '<div><b>' + esc(odds(p.price)) + '</b><span>Onyx price</span></div>' : '') +
        (pay ? '<div><b>$' + pay.toFixed(2) + '</b><span>a $10 bet returns</span></div>' : '') +
        (p.conf ? '<div><b>' + Math.round(100 * p.conf) + '%</b><span>model had it</span></div>' : '') +
      '</div>' +
      '<a class="oxw-go" href="https://app.onyxodds.com/?utm_source=onyxsports&referrer=' + REFERRER + '" target="_blank" rel="noopener">Ride the run: build tonight\'s parlay on Onyx</a>' +
      '<div class="oxw-row"><a href="' + esc(t.gid && p.sport !== 'nba' && p.sport !== 'mlb' ? page + '#games:' + t.gid : page) + '">Open the game</a><a href="home.html#my">My picks</a>' +
      (navigator.share ? '<button class="oxw-sh">Share</button>' : '') + '</div></div>';
    document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add('open'); });
    try { if (navigator.vibrate) navigator.vibrate([60, 40, 120]); } catch (e) {}
    var close = function () {
      back.classList.remove('open');
      setTimeout(function () { back.remove(); open = false; if (queue.length) celebrate(queue.shift()); }, 220);
    };
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('.oxw-x').addEventListener('click', close);
    var sh = back.querySelector('.oxw-sh');
    if (sh) sh.addEventListener('click', function () {
      try { navigator.share({title: 'Cashed on Onyx', text: 'My Onyx pick cashed: ' + (p.label || '') + (p.price != null ? ' (' + odds(p.price) + ')' : ''), url: location.origin + location.pathname.replace(/[^/]*$/, '') + 'home.html'}); } catch (e) {}
    });
    try { if (window.gtag) gtag('event', 'pick_won_popup', {sport: p.sport}); } catch (e) {}
  }
  function pushNote(t) {
    if (!alertsOn()) return;
    var p = t.p, title = 'Cashed: ' + (p.label || p.name), body = [finalLine(t), p.price != null ? 'Onyx ' + odds(p.price) : ''].filter(Boolean).join(' · ');
    var opts = {body: body, tag: 'onyx-win-' + p.id, icon: 'icon-192.png', badge: 'icon-192.png', data: {url: 'home.html#my'}};
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (r) { if (r && r.showNotification) r.showNotification(title, opts); else new Notification(title, opts); })
          .catch(function () { try { new Notification(title, opts); } catch (e) {} });
      } else new Notification(title, opts);
    } catch (e) {}
  }
  function setAlerts(on) {
    if (!on) { lsSet(ALERTS, 0); toast('Win alerts off. The pop-up still shows while the app is open'); return Promise.resolve(false); }
    if (typeof Notification === 'undefined') { toast('This browser cannot send alerts. Add Onyx to your home screen to get them'); return Promise.resolve(false); }
    return Promise.resolve(Notification.requestPermission()).then(function (perm) {
      if (perm === 'granted') { lsSet(ALERTS, 1); toast('Win alerts on. We will tell you the moment a saved pick cashes'); return true; }
      toast('Alerts are blocked for Onyx in your settings'); return false;
    }).catch(function () { return false; });
  }

  // ── the watcher: every 45 s while the page is open ────────────────────────
  var busy = false, timer = null;
  function watch() {
    if (busy || document.hidden) return;
    var now = Date.now(), shown = lsGet(SHOWN, {});
    var P = all().filter(function (p) { var s = Date.parse(p.start); return !shown[p.id] && (isNaN(s) || s - 15 * 60e3 <= now); });
    if (!P.length) return;
    busy = true;
    Promise.all(P.map(function (p) { return track(p).catch(function () { return {p: p}; }); })).then(function (T) {
      var seen = lsGet(SHOWN, {});
      T.forEach(function (t) {
        if (t.res !== 'W' || seen[t.p.id]) return;
        seen[t.p.id] = Date.now();
        celebrate(t);
        pushNote(t);
      });
      // a shown win is kept 3 days so it never pops twice
      Object.keys(seen).forEach(function (k) { if (now - seen[k] > 3 * 864e5) delete seen[k]; });
      lsSet(SHOWN, seen);
    }).then(function () { busy = false; }, function () { busy = false; });
  }
  function start() {
    clearInterval(timer);
    timer = setInterval(watch, 45e3);
    setTimeout(watch, 2500);
  }
  addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(watch, 800); });

  var css = '.ox-save{flex-shrink:0;width:34px;height:34px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);' +
    'color:#d795ff;font-size:17px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}' +
    '.ox-save.on{background:rgba(176,56,249,.22);border-color:rgba(176,56,249,.7);color:#fff}' +
    // the win pop-up: Onyx Baseball's player-card modal (dark card, purple top rule) with a burst
    '.oxw-back{position:fixed;inset:0;z-index:10200;display:flex;align-items:center;justify-content:center;padding:calc(16px + env(safe-area-inset-top,0px)) 16px 16px;' +
    'background:rgba(5,6,10,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .2s}' +
    '.oxw-back.open{opacity:1}' +
    '.oxw{position:relative;width:min(400px,100%);background:#131019;border:1px solid rgba(176,56,249,.45);border-radius:18px;padding:22px 20px 18px;text-align:center;' +
    'box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 40px rgba(176,56,249,.25);transform:scale(.86);transition:transform .32s cubic-bezier(.2,1.4,.4,1);overflow:hidden;font-family:"Space Grotesk",system-ui,sans-serif;color:#fff}' +
    '.oxw::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#635bff,#b038f9,#61e970)}' +
    '.oxw-back.open .oxw{transform:scale(1)}' +
    '.oxw-x{position:absolute;top:8px;right:10px;background:none;border:0;color:#8a8399;font-size:24px;cursor:pointer;line-height:1;padding:4px 8px}' +
    '.oxw-eb{font:700 10px monospace;letter-spacing:.14em;color:#d795ff}' +
    '.oxw-big{font:900 54px/1 "Space Grotesk",system-ui,sans-serif;letter-spacing:.04em;margin:10px 0 6px;background:linear-gradient(135deg,#61e970,#d795ff);-webkit-background-clip:text;background-clip:text;color:transparent;animation:oxwPop .6s cubic-bezier(.2,1.6,.4,1) both}' +
    '.oxw-l{font-weight:800;font-size:17px;line-height:1.3}' +
    '.oxw-s{font:600 12px monospace;color:#b9b2c4;margin-top:6px}' +
    '.oxw-g{display:flex;gap:8px;justify-content:center;margin:14px 0}' +
    '.oxw-g div{flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px 4px}' +
    '.oxw-g b{display:block;font:800 15px monospace}.oxw-g span{display:block;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#8a8399;margin-top:3px}' +
    '.oxw-go{display:block;text-decoration:none;background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff;font-weight:800;font-size:14px;padding:12px;border-radius:12px;box-shadow:0 6px 20px rgba(176,56,249,.35)}' +
    '.oxw-row{display:flex;justify-content:center;gap:18px;margin-top:12px}' +
    '.oxw-row a,.oxw-row button{background:none;border:0;color:#d795ff;font:700 12px "Space Grotesk",system-ui,sans-serif;text-decoration:none;cursor:pointer;padding:4px}' +
    '.oxw-fx{position:absolute;inset:0;pointer-events:none;overflow:hidden}' +
    '.oxw-fx i{position:absolute;top:-12px;width:8px;height:14px;border-radius:2px;opacity:0}' +
    '.oxw-back.open .oxw-fx i{animation:oxwFall 1.8s ease-in forwards}' +
    '@keyframes oxwFall{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(105vh) rotate(540deg)}}' +
    '@keyframes oxwPop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}' +
    '@media (prefers-reduced-motion: reduce){.oxw,.oxw-big,.oxw-fx i{animation:none!important;transition:none!important}.oxw-fx{display:none}}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);
  window.OnyxSaved = {all: all, has: has, remove: remove, toggle: toggle, tap: tap, btn: btn,
    track: track, celebrate: celebrate, watch: watch, alertsOn: alertsOn, setAlerts: setAlerts};
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
