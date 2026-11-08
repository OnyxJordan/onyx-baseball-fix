// cards.js - team and player cards for every Onyx Sports page (11/2).
//
// Jordan, 11/2: "every sport needs this for every team as a whole and player, we should have
// team history trends everything we need to explain why we are getting to the number."
//
// One card, built like the NBA player card (nba_shell.html): a header with the face (headshot or
// logo), the matchup and the model's number, a two-way switch (Player | Bets, Team | Bets), then
// "Why this number" from the model's own inputs, seasons, recent games, and every Onyx line with the
// model's chance, Onyx's implied chance, the blend and EV per $10. Data: data/<sport>/cards.json
// (an index) and data/<sport>/cards/<team>.json (cards.py), fetched only when a card opens.
//
// Opening: any element with data-oxt="<team abbr>" opens that team; data-oxp="<player name>"
// (with data-oxpt="<team>" or data-oxg="<game id>" when known) opens that player. The click is
// taken in the capture phase, so a team name inside a tappable game card opens the team, not the game.
// Nothing here is a pick: projections and context, every price labelled Onyx, the closing-line
// history labelled "closing line" (ESPN's line providers, never Onyx).
(function () {
  'use strict';
  if (window.OXC) return;
  var REF = 'KR680261';
  var PG = window.SD || null, NBA = !PG && window.D && window.D.engine ? window.D : null;
  var SPORT = PG ? PG.sport : NBA ? 'nba' : null;
  if (!SPORT) return;
  var KIND = PG ? ((PG.cfg || {}).kind || '') : 'basketball';
  var GEN = (PG || NBA || {}).generated || '';
  var IDX = null, IDX_P = null, TEAMS = {}, TEAM_P = {};
  var CX = null;          // {type: 'team'|'player', key, face, data}
  var BS = null;          // bets state: {m: market index, side, x}

  // ── tiny helpers (own copies: the page's may differ by sport) ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function odds(o) { return o == null ? '-' : (o > 0 ? '+' : '') + o; }
  function pct(p, d) { return p == null || isNaN(p) ? '-' : (p * 100).toFixed(d == null ? 1 : d) + '%'; }
  function num(v, d) { return v == null || isNaN(v) ? '-' : (+v).toFixed(d == null ? 1 : d); }
  function sg(v, d) { return v == null || isNaN(v) ? '-' : (v > 0 ? '+' : v < 0 ? '' : '') + (+v).toFixed(d == null ? 1 : d); }
  function dec(o) { o = +o; return o > 0 ? 1 + o / 100 : 1 + 100 / -o; }
  function imp(o) { return o == null ? null : 1 / dec(o); }
  function money(v) { v = +v || 0; return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2); }
  function mcls(v) { return v > 0 ? 'cx-pos' : v < 0 ? 'cx-neg' : ''; }
  function shard(t) { return String(t).replace(/[^A-Za-z0-9]/g, '_') || '_'; }
  function when(iso) { try { return new Date(iso).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET'; } catch (e) { return ''; } }
  function track(n, p) { try { if (window.gtag) gtag('event', n, Object.assign({sport: SPORT}, p || {})); } catch (e) {} }
  function share(sels) { return 'https://app.onyxodds.com/share?' + sels.map(function (s) { return 'selection=' + encodeURIComponent(s); }).join('&') + '&referrer=' + REF; }
  function buzz() { try { if (window.OnyxUI && OnyxUI.buzz) OnyxUI.buzz(); } catch (e) {} }
  function gameOf(gid) { return ((PG || NBA || {}).games || []).find(function (g) { return g.gid === gid; }) || null; }
  function teamLogo(t, url) {
    if (NBA) { var src = (NBA.logos || {})[t]; return src ? '<img class="cx-lg" src="' + esc(src) + '" alt="">' : ''; }
    if (!url) { var g = (PG.games || []).find(function (x) { return x.home === t || x.away === t; }); url = g ? g[(g.home === t ? 'home' : 'away') + '_logo'] : null; }
    return url ? '<img class="cx-lg" src="' + esc(url) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '';
  }
  function rec(r) { if (!r || !r.n) return '0-0'; return r.w + '-' + r.l + (r.otl ? '-' + r.otl : r.t ? '-' + r.t : ''); }
  function trip(a, s) { return a && (a[0] + a[1] + a[2]) ? a[0] + '-' + a[1] + (a[2] ? '-' + a[2] : '') + (s ? ' ' + s : '') : '-'; }

  // ── data: a small index, then one file per team ──
  function getJSON(u) { return fetch(u + (u.indexOf('?') < 0 ? '?v=' : '&v=') + encodeURIComponent(GEN)).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function index() { if (!IDX_P) IDX_P = getJSON('data/' + SPORT + '/cards.json').then(function (d) { IDX = d; return d; }).catch(function () { IDX = {teams: [], players: {}}; return IDX; }); return IDX_P; }
  function teamFile(t) {
    if (!TEAM_P[t]) TEAM_P[t] = getJSON('data/' + SPORT + '/cards/' + shard(t) + '.json').then(function (d) { TEAMS[t] = d; return d; }).catch(function () { TEAMS[t] = null; return null; });
    return TEAM_P[t];
  }
  // a player: by team when the tap knows it, else the index (the game breaks a tie)
  function findPlayer(name, team, gid) {
    var k = nk(name);
    return index().then(function (I) {
      if (KIND === 'tennis') return (I.players || {})[k + '|'] || null;
      var ts = team ? [team] : ((I.players || {})[k] || []);
      if (!team && gid && ts.length > 1) { var g = gameOf(gid); if (g) ts = ts.filter(function (t) { return t === g.home || t === g.away; }).concat(ts); }
      if (!ts.length) return null;
      return teamFile(ts[0]).then(function (d) { return d && d.players ? d.players[k + '|' + ts[0]] || null : null; });
    });
  }

  // ── the parlay slip: NBA's own when on nba.html, else a light one shared by this sport's page ──
  var SLIP_KEY = 'onyxCardSlip_' + SPORT, SLIP = [];
  try { SLIP = JSON.parse(localStorage.getItem(SLIP_KEY) || '[]') || []; } catch (e) { SLIP = []; }
  // the save star (saved.js), the same one as every play card: the pick follows you in My picks
  var MKEY = {points: 'pts', rebounds: 'reb', assists: 'ast'};
  function star(pick) { return window.OnyxSaved && pick && (pick.id || pick.label) ? OnyxSaved.btn(pick) : ''; }   // no Onyx id during an outage: saved.js keys it (11/8)
  function sidePick(s, gid) {
    var g = gameOf(gid) || {}, num = parseFloat(String(s.lab || '').split(' ').pop());
    return {id: s.sel, sport: SPORT, label: s.lab, matchup: g.away && g.home ? g.away + ' @ ' + g.home : '', start: g.start, gid: gid,
      team: s.team, price: s.price, conf: s.pb, kind: s.k, mkt: s.k, name: s.team || s.lab,
      side: s.k === 'total' ? (/^Under/.test(s.lab) ? 'under' : 'over') : null, line: s.k === 'total' && !isNaN(num) ? num : null,
      hcap: s.k === 'spread' && !isNaN(num) ? num : null};
  }
  // follow a player from his card: the sport page's own follow list (onyxFollow_<sport>), the same button
  function canFollow(p) { return !NBA && p && p.id && typeof window.toggleF === 'function' && typeof window.isF === 'function'; }
  function followBtn(p) {
    if (!canFollow(p)) return '';
    var on = window.isF(p.id);
    return '<button class="fl-btn' + (on ? ' on' : '') + '" data-cx="follow" style="margin-top:6px">' + (on ? '★ Following' : '☆ Follow') + '</button>';
  }
  function inSlip(sel) {
    if (NBA && typeof window.inSlip === 'function') return window.inSlip(sel);
    return SLIP.some(function (x) { return x.sel === sel; });
  }
  function slipToggle(leg) {
    if (!leg || !leg.sel) return;
    if (NBA && typeof window.regLeg === 'function' && typeof window.slipToggle === 'function') { window.slipToggle(window.regLeg(leg)); return; }
    if (inSlip(leg.sel)) SLIP = SLIP.filter(function (x) { return x.sel !== leg.sel; });
    else if (SLIP.length < 10) { SLIP.push({sel: leg.sel, label: leg.label, odds: leg.price}); track('parlay_add', {selection: leg.label, legs: SLIP.length, source: 'card'}); }
    try { localStorage.setItem(SLIP_KEY, JSON.stringify(SLIP)); } catch (e) {}
    drawSlip();
  }
  function css() {
    if (document.getElementById('cxCss')) return;
    var st = document.createElement('style'); st.id = 'cxCss'; st.textContent = CSS; document.head.appendChild(st);
  }
  function drawSlip() {
    if (NBA) return;
    css();
    var el = document.getElementById('cxSlip');
    if (!SLIP.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'cxSlip'; document.body.appendChild(el); }
    var d = 1; SLIP.forEach(function (x) { d *= dec(x.odds); });
    var am = d >= 2 ? '+' + Math.round((d - 1) * 100) : '-' + Math.round(100 / (d - 1));
    el.innerHTML = '<div class="cx-slip' + (el.dataset.open ? ' open' : '') + '"><button class="cx-slip-tab" data-cx="slip">Parlay <b>' + SLIP.length + '</b> <span>' + esc(am) + '</span></button>' +
      '<div class="cx-slip-body">' + SLIP.map(function (x) { return '<div class="cx-slip-leg"><span>' + esc(x.label) + '</span><em>' + odds(x.odds) + '</em><button data-cx="unslip" data-sel="' + esc(x.sel) + '" aria-label="Remove">×</button></div>'; }).join('') +
      '<div class="cx-slip-ft"><span>$10 pays <b>$' + (10 * d).toFixed(0) + '</b></span><button class="cx-btn p" data-cx="slipgo">⚡ Build on Onyx</button><button class="cx-btn" data-cx="slipclear">Clear</button></div></div></div>';
  }

  // ── the modal ──
  function ensure() {
    if (document.getElementById('cx')) return;
    css();
    var bg = document.createElement('div'); bg.id = 'cxBg'; bg.className = 'cx-bg';
    bg.addEventListener('click', close);
    var el = document.createElement('section'); el.id = 'cx'; el.className = 'cx';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Card');
    el.innerHTML = '<div class="cx-grip"></div><div class="cx-face" id="cxFace"></div>';
    document.body.appendChild(bg); document.body.appendChild(el);
    var face = el.querySelector('.cx-face'), y0 = null, dy = 0;
    face.addEventListener('touchstart', function (e) { y0 = face.scrollTop <= 0 && !e.target.closest('.cx-rail,.cx-dist,.cx-tbl,.bc-mkts,input') ? e.touches[0].clientY : null; dy = 0; }, {passive: true});
    face.addEventListener('touchmove', function (e) { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0 && matchMedia('(max-width:760px)').matches) { el.style.transition = 'none'; el.style.transform = 'translateY(' + dy + 'px)'; } }, {passive: true});
    face.addEventListener('touchend', function () { if (y0 == null) return; el.style.transition = ''; el.style.transform = ''; if (dy > 110) close(); y0 = null; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('open') && !pcUp()) close(); });
  }
  function show(html) {
    ensure();
    var el = document.getElementById('cx'), f = document.getElementById('cxFace');
    f.innerHTML = html; f.scrollTop = 0;
    document.getElementById('cxBg').classList.add('open'); el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    var el = document.getElementById('cx'), bg = document.getElementById('cxBg');
    if (el) el.classList.remove('open'); if (bg) bg.classList.remove('open');
    document.body.style.overflow = '';
    CX = null;
  }
  function loading(title) {
    return '<div class="pc-head"><div class="pc-id"><div class="pc-name">' + esc(title) + '</div><div class="sub">Loading the card...</div></div><span></span><span></span><button class="pc-x" data-cx="close" aria-label="Close">×</button></div><div class="pc-body"><div class="cx-empty">Loading...</div></div>';
  }
  function missing(title, why) {
    return '<div class="pc-head"><div class="pc-id"><div class="pc-name">' + esc(title) + '</div><div class="sub">' + esc(why) + '</div></div><span></span><span></span><button class="pc-x" data-cx="close" aria-label="Close">×</button></div>' +
      '<div class="pc-body"><div class="cx-empty">' + esc(why) + ' Cards cover every team and player on the current slate, rebuilt with every data run.</div></div>';
  }

  // ── open ──
  function openTeam(t) {
    if (!t) return;
    show(loading(t));
    track('team_card_open', {team: t});
    CX = {type: 'team', key: t, face: 'team'};
    index().then(function () { return loadPicks(); }).then(function () { return teamFile(t); }).then(function (d) {
      if (!CX || CX.key !== t) return;
      if (!d || !d.team) { show(missing(t, 'No card for this team yet.')); return; }
      CX.data = d.team; CX.players = d.players || {};
      BS = null; CX.open = undefined; draw();
    });
  }
  function openPlayer(name, team, gid, face) {
    if (!name) return;
    show(loading(name));
    track('player_card_open', {player: name});
    CX = {type: 'player', key: name, face: face || 'front'};
    loadPicks().then(function () { return findPlayer(name, team, gid); }).then(function (p) {
      if (!CX || CX.key !== name) return;
      if (!p) { show(missing(name, 'No card for this player on this slate.')); return; }
      CX.data = p; BS = null; CX.open = undefined; draw();
    });
  }
  function draw() {
    if (!CX || !CX.data) return;
    var html = CX.type === 'team' ? (CX.face === 'bets' ? teamBets(CX.data) : teamFront(CX.data)) : (CX.face === 'bets' ? playerBets(CX.data) : playerFront(CX.data));
    var f = document.getElementById('cxFace'), top = f ? f.scrollTop : 0;
    show(html);
    if (CX.face === 'bets' && BS && document.getElementById('cxMain')) { bindChart(); update(true); }
    if (f && CX.keepScroll) f.scrollTop = top;
    CX.keepScroll = false;
  }

  // ── player card ──
  function seg(a, b, n, on) {
    return '<div class="pc-seg" role="tablist"><button role="tab" class="' + (on === 'front' ? 'on' : '') + '" data-cx="face" data-f="front">' + a + '</button>' +
      '<button role="tab" class="' + (on === 'bets' ? 'on' : '') + '" data-cx="face" data-f="bets">' + b + (n ? ' <i>' + n + '</i>' : '') + '</button></div>';
  }
  function mainMk(p) {
    var mk = (p.mk || []).filter(function (m) { return m.proj != null && m.line != null; });
    return mk[0] || (p.mk || []).find(function (m) { return m.proj != null; }) || null;
  }
  function pHead(p, face) {
    var m = mainMk(p), pj = p.proj || {}, k = Object.keys(pj)[0];
    var badge = p.badge ? [typeof p.badge[0] === 'string' ? esc(p.badge[0]) : num(p.badge[0], p.badge[0] < 10 && p.badge[0] % 1 ? 2 : 1).replace(/(\.\d)0$/, '$1'), p.badge[1]] : m ? [num(m.proj), 'PROJ ' + shortMk(m)] : p.elo ? [num(p.elo, 0), 'ELO'] : k ? [num(pj[k]), 'PROJ ' + k.toUpperCase()] : null;
    var g = gameOf(p.gid) || {};
    var face_ = p.hs ? '<img class="hs" src="' + esc(p.hs) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'hs cx-ini\',textContent:\'' + esc(ini(p.n)) + '\'}))">'
      : p.flag ? '<img class="hs" src="' + esc(p.flag) + '" alt="" style="object-fit:cover" onerror="this.style.visibility=\'hidden\'">' : '<span class="hs cx-ini">' + esc(ini(p.n)) + '</span>';
    var sub = KIND === 'tennis' ? esc(p.tour || '') + ' · vs ' + esc(p.opp) + ' · ' + esc(p.round || '') + ' · ' + when(p.start)
      : teamLogo(p.team) + ' ' + esc(p.pos || '') + (p.pos ? ' · ' : '') + '<a data-oxt="' + esc(p.team) + '" class="cx-tlink">' + esc(p.team) + '</a> ' + (p.home ? 'vs' : '@') + ' <a data-oxt="' + esc(p.opp) + '" class="cx-tlink">' + esc(p.opp) + '</a> · ' + when(p.start || g.start);
    var n = (p.mk || []).filter(function (x) { return x.over != null || x.under != null; }).length;
    return '<div class="pc-head"><div class="pc-logo">' + (p.team ? teamLogo(p.team) : '') + '</div><div class="pc-hs">' + face_ + '</div>' +
      '<div class="pc-id"><div class="pc-name">' + esc(p.n) + '</div><div class="sub">' + sub + '</div>' + followBtn(p) + '</div>' +
      (badge ? '<div class="pc-rate"><b>' + badge[0] + '</b><span>' + esc(badge[1]) + '</span></div>' : '<span></span>') +
      '<button class="pc-x" data-cx="close" aria-label="Close">×</button></div>' + seg(KIND === 'tennis' ? 'Player' : 'Player', 'Bets', n, face);
  }
  function ini(n) { return String(n || '?').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase(); }
  function shortMk(m) { return ({pass_yds: 'PASS YDS', rush_yds: 'RUSH YDS', rec_yds: 'REC YDS', rec: 'REC', pass_td: 'PASS TD', pass_att: 'PASS ATT', pass_rush_yds: 'P+R YDS', rush_rec_yds: 'R+R YDS', points: 'PTS', assists: 'AST', rebounds: 'REB', threes: '3PM', goals: 'G', shots: 'SOG', total: 'GAMES'})[m.m] || String(m.name || m.m).toUpperCase(); }
  function leanOf(m) { return m.pb != null ? (m.pb >= 0.5 ? 'over' : 'under') : m.proj != null && m.line != null ? (m.proj >= m.line ? 'over' : 'under') : 'over'; }
  function playerFront(p) {
    var mk = (p.mk || []).filter(function (m) { return m.proj != null && !m.yes; }).concat((p.mk || []).filter(function (m) { return m.proj == null && m.pb != null; })).slice(0, 3);
    var cells = mk.map(function (m, i) {
      var s = m.yes ? 'over' : leanOf(m), ch = m.pb != null ? (s === 'over' ? m.pb : 1 - m.pb) : null;
      return '<div class="cx-cell" data-cx="mk" data-i="' + (p.mk.indexOf(m)) + '"><div class="v">' + (m.proj != null ? num(m.proj) : pct(m.pb, 0)) + '</div><div class="l">' + esc(shortMk(m)) + '</div>' +
        '<div class="s">' + (m.line != null ? 'line ' + m.line + (ch != null ? ' · ' + (s === 'over' ? 'O ' : 'U ') + pct(ch, 0) : '') : m.over != null ? 'Onyx ' + odds(m.over) : 'no Onyx line') + '</div></div>';
    }).join('');
    var pj = p.proj || {}, row = [];
    if (p.use != null) row.push('<span>' + esc((p.use_lab || 'use').toLowerCase()) + ' <b>' + (p.use_lab && /share/i.test(p.use_lab) ? Math.round(p.use) + '%' : num(p.use)) + '</b></span>');
    if (p.role) row.push('<span>role <b>' + esc(p.role) + '</b></span>');
    if (p.cls) row.push('<span>class <b>' + esc(p.cls) + '</b></span>');
    if (p.ht) row.push('<span>height <b>' + esc(p.ht) + '</b></span>');
    if (p.elo) row.push('<span>Elo <b>' + num(p.elo, 0) + '</b></span><span>matches <b>' + esc(p.n_m) + '</b></span>');
    var html = pHead(p, 'front') + '<div class="pc-body">' +
      (p.tag && (/out|question|doubt|scratch/i.test(p.tag) || p.q) ? '<div class="cx-tagrow"><span class="cx-tag r">' + esc(p.tag) + '</span></div>' : '') +
      (cells ? '<div class="cx-cells">' + cells + '</div>' : '') +
      (row.length ? '<div class="pk-row">' + row.join('') + '</div>' : '') +
      why(p.why, 'Why this number') + seasons(p) + last5(p) + form(p) +
      ((p.mk || []).length ? '<button class="pc-cta" data-cx="face" data-f="bets">See all ' + p.mk.length + ' of his Onyx markets ›</button>' : '<div class="cx-note">No Onyx player lines on him right now.</div>') +
      '</div>';
    return html;
  }
  function why(rows, title) {
    if (!(rows || []).length) return '';
    return '<div class="cx-hdr"><span>' + esc(title) + '</span></div><div class="pdr-why">' + rows.map(function (w) {
      return '<div><span>' + esc(w.k) + '</span><b>' + esc(w.v) + '</b><em>' + esc(w.d || '') + '</em></div>';
    }).join('') + '</div>';
  }
  function seasons(p) {
    var cols = p.cols || [], S = p.seasons || [];
    if (KIND === 'tennis') {
      if (!S.length) return '';
      return '<div class="cx-hdr"><span>Seasons</span><em>matches we hold</em></div><div class="cx-tbl"><table><thead><tr><th>Year</th><th class="r">W</th><th class="r">L</th><th class="r">Win%</th></tr></thead><tbody>' +
        S.map(function (s) { return '<tr><td class="mono dim">' + esc(s.s) + '</td><td class="r mono">' + s.w + '</td><td class="r mono">' + s.l + '</td><td class="r mono">' + pct(s.w / Math.max(1, s.w + s.l), 0) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    if (!S.length && !p.base) return '';
    var b = p.base || {}, hasB = Object.keys(b).some(function (k) { return b[k] != null; });
    return '<div class="cx-hdr"><span>' + (S.length ? 'Last ' + S.length + ' season' + (S.length > 1 ? 's' : '') : 'Seasons') + '</span>' + (p.cls ? '<em>' + esc(p.cls) + '</em>' : '') + '</div>' +
      '<div class="cx-tbl"><table><thead><tr><th>Season</th><th class="hm">Team</th><th class="r">GP</th>' + cols.map(function (c) { return '<th class="r">' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      S.map(function (s) { return '<tr><td class="mono dim">' + esc(s.s) + '</td><td class="hm">' + esc(s.t || '') + '</td><td class="r mono">' + esc(s.gp == null ? '-' : s.gp) + '</td>' + cols.map(function (c) { return '<td class="r mono">' + fmtStat(s[c[0]]) + '</td>'; }).join('') + '</tr>'; }).join('') +
      (hasB ? '<tr class="cx-base"><td>Baseline <span class="dim">' + esc(p.base_lab || 'model') + '</span></td><td class="hm"></td><td></td>' + cols.map(function (c) { return '<td class="r mono">' + fmtStat(b[c[0]]) + '</td>'; }).join('') + '</tr>' : '') +
      (!S.length ? '<tr><td colspan="' + (cols.length + 3) + '" class="dim">No seasons in the box scores we hold yet.</td></tr>' : '') +
      '</tbody></table></div>';
  }
  function fmtStat(v) { return v == null || isNaN(v) ? '-' : Number.isInteger(+v) ? String(+v) : Math.abs(v) >= 100 ? (+v).toFixed(0) : Math.abs(v) >= 10 ? (+v).toFixed(1) : (+v).toFixed(v % 1 ? 2 : 0).replace(/(\.\d)0$/, '$1'); }
  function last5(p) {
    if (KIND === 'tennis') return '';
    var L = p.last5 || [], cols = p.cols || [];
    return '<div class="cx-hdr"><span>Last ' + (L.length || 5) + '</span></div><div class="cx-tbl"><table><thead><tr><th>Date</th><th>Opp</th>' + cols.map(function (c) { return '<th class="r">' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (L.map(function (x) { return '<tr><td class="mono dim">' + esc(x.d) + '</td><td>' + esc((x.ha ? x.ha + ' ' : '') + (x.opp || '')) + '</td>' + cols.map(function (c) { return '<td class="r mono">' + fmtStat(x[c[0]]) + '</td>'; }).join('') + '</tr>'; }).join('')
        || '<tr><td colspan="' + (cols.length + 2) + '" class="dim">No games this season yet.</td></tr>') + '</tbody></table></div>';
  }
  function form(p) {
    if (KIND !== 'tennis' || !(p.form || []).length) return '';
    return '<div class="cx-hdr"><span>Last ' + p.form.length + ' matches</span></div><div class="cx-tbl"><table><thead><tr><th>Date</th><th>Opponent</th><th class="r">Sets</th><th class="r">Result</th></tr></thead><tbody>' +
      p.form.map(function (f) { return '<tr><td class="mono dim">' + esc(f.d) + '</td><td>' + esc(f.opp) + ' <span class="dim">' + esc(f.rd || '') + '</span></td><td class="r mono">' + esc(f.s) + '</td><td class="r"><span class="cx-tag ' + (f.w ? 'g' : 'r') + '">' + (f.w ? 'W' : 'L') + '</span></td></tr>'; }).join('') + '</tbody></table></div>';
  }

  // ── distributions: the shape the model priced the market with (cards.py) ──
  function erf(x) { var t = 1 / (1 + .3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function ncdf(z) { return .5 * (1 + erf(z / Math.SQRT2)); }
  function pmf(d, kMax) {
    var m = Math.max(d.m, .05), out = [], t, k;
    if (d.t === 'nb' && d.v > m * 1.0001) {
      var r = m * m / (d.v - m), q = m / (r + m); t = Math.pow(1 - q, r);
      for (k = 0; k <= kMax; k++) { out.push(t); t *= (r + k) / (k + 1) * q; }
    } else { t = Math.exp(-m); for (k = 0; k <= kMax; k++) { out.push(t); t *= m / (k + 1); } }
    return out;
  }
  function pOver(d, x) {
    if (!d || x == null) return null;
    if (d.t === 'n') return 1 - ncdf((x - d.m) / Math.max(d.s, 1e-6));
    var P = pmf(d, Math.max(0, Math.floor(x))), c = 0; P.forEach(function (v) { c += v; });
    return Math.max(0, 1 - c);
  }
  // the chart's bins: whole counts for counts, a round width for yards
  function bins(d, line) {
    var out = [];
    if (d.t === 'n') {
      var w = d.s <= 4 ? 1 : d.s <= 12 ? 2 : d.s <= 30 ? 5 : d.s <= 60 ? 10 : 20;
      var lo = Math.max(d.m < 0 || d.z ? d.m - 3 * d.s : 0, Math.floor(Math.min(d.m - 2.6 * d.s, line == null ? 1e9 : line - 2 * w) / w) * w);
      var hi = Math.ceil(Math.max(d.m + 2.6 * d.s, line == null ? -1e9 : line + 2 * w) / w) * w;
      for (var a = lo; a < hi; a += w) out.push({a: a, b: a + w, p: ncdf((a + w - d.m) / d.s) - ncdf((a - d.m) / d.s)});
      return out;
    }
    var sd = Math.sqrt(d.t === 'nb' ? d.v : d.m), k1 = Math.max(4, Math.ceil(d.m + 3.5 * sd), line == null ? 0 : Math.ceil(line) + 2);
    pmf(d, k1).forEach(function (v, k) { out.push({a: k - .5, b: k + .5, p: v, k: k}); });
    return out;
  }

  // ── bets: every Onyx market on a player or a team, best value first (11/2) ──
  // Jordan, 11/2: "the bets should be the best bets with this team or players from this team ...
  // with all of the information, the sliding bars, everything." One ranked list, for a team (its
  // game lines and every prop on its players) and for a player (his markets): Onyx Picks first
  // (logged in data/picks/ledger.json), then the markets the Onyx Picks backtest has tested
  // (cards.json "tests", cards.market_tests) by the model's expected return at the Onyx price,
  // the home Top 10's number (blended chance x decimal odds - 1), then long prices, Onyx-only
  // lines and, last, markets never tested against Onyx or that did not beat it: shown and
  // labelled, never called value. A row opens the full bet card: Over / Under, Model / Onyx
  // implied / Blended / EV per $10, the distribution and the line slider that snaps to Onyx's
  // lines (and its alternate lines, where Onyx posts them). NBA player props open nba.html's own
  // bet card (openBetCard) on that line, the one implementation of the NBA card.
  var REC = [-200, 200];       // the NBA card's calibrated range: a long shot's paper EV is not value
  var PICKS = null, PICKS_P = null;
  function loadPicks() {
    if (!PICKS_P) PICKS_P = getJSON('data/picks/ledger.json').then(function (L) {
      PICKS = {}; (Array.isArray(L) ? L : []).forEach(function (r) { if (r && r.sport === SPORT && r.sel) PICKS[r.sel] = r; });
      return PICKS;
    }).catch(function () { PICKS = {}; return PICKS; });
    return PICKS_P;
  }
  function isPick(sel) { return !!(sel && PICKS && PICKS[sel]); }
  var TKEY = {tennis: {total: 'total_games', spread: 'game_spread'}};
  // a market's honesty label and its tier: 1 tested, 2 tested at a long price, 3 Onyx's price
  // only, 4 not tested against Onyx / did not beat it / borrowed shape
  function testOf(m) {
    if (m.fails) return {t: 4, lab: m.fails};
    if (m.nc === 'role') return {t: 4, lab: 'Role change: shown, not priced'};
    if (m.nc === 'nhl') return {t: 4, lab: 'Did not beat Onyx in testing'};
    if (m.nc === 'cbb' || m.untested) return {t: 4, lab: 'Not tested against Onyx'};
    if (m.shape) return {t: 4, lab: m.shape};
    if (m.pm == null || m.pb == null || m.nc === 'onyx' || m.nc === 'td_info' || m.nc === 'td_any')
      return {t: 3, lab: m.nc === 'td_any' ? 'Onyx price, margin removed' : m.nc === 'td_info' ? 'Information only' : 'Onyx price only'};
    var T = (IDX || {}).tests || {}, v = T[(TKEY[SPORT] || {})[m.m] || m.m];
    if (SPORT === 'cbb' && !m.g && !v) v = T.props;
    if (v === 'finalized') return {t: 1, lab: 'Beat Onyx in testing'};
    if (v === 'not enough yet') return {t: 1, lab: 'In testing'};
    if (v === 'fails') return {t: 4, lab: 'Did not beat Onyx in testing'};
    if (v === 'retest') return {t: 4, lab: 'Model changed: back in testing'};
    return {t: 4, lab: 'Not backtested against Onyx'};
  }
  function hc(v) { v = Math.round(v * 2) / 2; return (v > 0 ? '+' : '') + v; }
  // 11/5: while Onyx prices are down the page runs on the market line (no Onyx selection ids), and a
  // card still lists every priced market, labelled as the market line
  function mkt() { var D = window.NBA_DATA || window.D, S = window.SD; return !!((D && D.meta && D.meta.market) || (S && S.odds && S.odds.market)); }
  function sidesOf(m) {
    return ['over', 'under'].filter(function (s) { return (s === 'over' ? m.over : m.under) != null && ((s === 'over' ? m.over_sel : m.under_sel) || mkt()) && !(m.yes && s === 'under'); });
  }
  function evOf(m, side) {
    var pr = side === 'over' ? m.over : m.under;
    if (m.pb == null || m.pm == null || pr == null) return null;
    return (side === 'over' ? m.pb : 1 - m.pb) * dec(pr) - 1;
  }
  // one row: the market on the side a logged pick took, else the side with the better expected return
  function mkRow(p, m, key, who) {
    var S = sidesOf(m);
    if (!S.length) return null;
    var side = S.filter(function (s) { return isPick(s === 'over' ? m.over_sel : m.under_sel); })[0];
    if (!side) side = m.pb != null && m.pm != null ? S.reduce(function (a, b) { var ea = evOf(m, a), eb = evOf(m, b); return eb != null && (ea == null || eb > ea) ? b : a; })
      : S.indexOf(leanOf(m)) >= 0 ? leanOf(m) : S[0];
    var price = side === 'over' ? m.over : m.under, sel = side === 'over' ? m.over_sel : m.under_sel, ts = testOf(m), pk = isPick(sel);
    if (ts.t === 1 && !pk && (price < REC[0] || price > REC[1])) ts = {t: 2, lab: ts.lab + ' · long price, not ranked as value'};
    return {key: key, p: p, m: m, side: side, price: price, sel: sel, ev: evOf(m, side), ch: m.pb == null || m.pm == null ? null : side === 'over' ? m.pb : 1 - m.pb,
      test: ts, pick: pk, rank: pk ? 0 : ts.t, who: who || '', nba: m.nba || null};
  }
  function rank(rows) {
    return rows.filter(Boolean).sort(function (a, b) { return a.rank - b.rank || (b.ev == null ? -9 : b.ev) - (a.ev == null ? -9 : a.ev); });
  }
  // the selection in words, at Onyx's line (x null) or a scrubbed one
  function sideLab(m, side, x) {
    var exact = x == null || m.line == null || Math.abs(x - m.line) < 1e-9;
    if (m.g === 'ml') return side === 'over' ? m.lab_o : m.lab_u;
    if (m.g === 'spread') return exact ? (side === 'over' ? m.lab_o : m.lab_u) : m.sideNames[side === 'over' ? 0 : 1] + ' ' + hc(side === 'over' ? -x : x);
    if (m.yes) return m.name + (side === 'under' ? ': No' : '');
    return (side === 'over' ? 'Over ' : 'Under ') + (exact ? m.line : (+x).toFixed(1)) + ' ' + (m.g ? m.name.toLowerCase() : m.name);
  }
  function rowLab(r) { return (r.who ? r.who + ' ' : '') + sideLab(r.m, r.side); }

  // the team's game lines as markets: this team (or the over) is "over", the other side "under"
  function gameMarkets(t) {
    var G = t.game || {}, S = G.sides || [], M = G.model, out = [], mu = G.home ? G.opp + ' @ ' + t.abbr : t.abbr + ' @ ' + G.opp;
    var w = Math.round(100 * (G.w || 0)), sdOk = M && M.sd_margin && M.sd_total;
    ['ml', 'spread', 'total'].forEach(function (k) {
      var ss = S.filter(function (s) { return s.k === k; });
      if (!ss.length) return;
      var a = k === 'total' ? ss.filter(function (s) { return /^Over/.test(s.lab); })[0] : ss.filter(function (s) { return s.team === t.abbr; })[0];
      a = a || ss[0];
      var b = ss.filter(function (s) { return s !== a; })[0] || null, n = parseFloat(String(a.lab).split(' ').pop());
      if (k !== 'ml' && isNaN(n)) return;
      var m = {m: k, g: k, gid: G.gid, matchup: mu, name: k === 'ml' ? 'Moneyline' : k === 'spread' ? 'Spread' : 'Game total',
        line: k === 'ml' ? null : k === 'spread' ? -n : n, over: a.price, under: b ? b.price : null, over_sel: a.sel, under_sel: b ? b.sel : null,
        pm: a.pm, pb: a.pm != null ? a.pb : null, sides: [a, b], lab_o: a.lab, lab_u: b ? b.lab : '',
        sideNames: k === 'total' ? null : [a.team || 'This side', b ? b.team || 'Other side' : 'Other side']};
      if (k === 'spread' && sdOk) { m.dist = {t: 'n', m: (a.team === t.abbr ? 1 : -1) * M.margin, s: M.sd_margin, z: 1}; m.proj = m.dist.m; }
      if (k === 'total' && sdOk) { m.dist = {t: 'n', m: M.total, s: M.sd_total}; m.proj = M.total; }
      m.note = a.pm == null ? (NBA ? 'The NBA model prices player props and the 1st-quarter total, not sides: this is Onyx\'s own line, ' + esc(a.lab) + ' ' + pct(a.fair, 1) + ' with its margin removed'
        : 'Not enough games for the ratings to price this one yet: Onyx\'s price only')
        : 'Model: the team ratings\' chance. Blended: ' + w + '% model, the rest Onyx\'s price with its margin removed. EV per $10 at Onyx\'s price on the blended chance' +
          (m.dist ? '. Drag the chart or the slider: off Onyx\'s line you see the model\'s chance only, release to snap back' : '');
      out.push(m);
    });
    if (NBA) out = out.concat(nbaPeriods(t));
    return out;
  }
  // NBA 1st quarter and 1st half (nba.html's qhCard read: a share of Onyx's game total, normal spread)
  function nbaPeriods(t) {
    var G = t.game || {}, g = gameOf(G.gid), Q = window.QH_P || {q1: .254, q1_sd: 12, h1: .505, h1_sd: 18, q1m: .34, q1m_sd: 11};
    if (!g || g.total == null || g.state && g.state !== 'pre') return [];
    var out = [], mu = g.away + ' @ ' + g.home;
    [['q1', '1st-quarter total', Q.q1, Q.q1_sd, 'q1_total'], ['h1', '1st-half total', Q.h1, Q.h1_sd, 'h1_total']].forEach(function (q) {
      var line = g[q[0] + '_total'];
      if (line == null || g[q[0] + '_over_price'] == null) return;
      var d = {t: 'n', m: g.total * q[2], s: q[3]}, po = pOver(d, line);
      out.push({m: q[4], g: 'period', gid: g.gid, matchup: mu, name: q[1], line: line, over: g[q[0] + '_over_price'], under: g[q[0] + '_under_price'],
        over_sel: g[q[0] + '_over_sel'], under_sel: g[q[0] + '_under_sel'], pm: po, pb: po, proj: d.m, dist: d,
        note: 'The model\'s chance: ' + Math.round(q[2] * 1000) / 10 + '% of Onyx\'s game total (' + g.total + '), spread ' + q[3] + ' points. This lane bets the model\'s chance itself, so Blended is the same number'});
    });
    if (g.spread != null && (g.q1_home_ml != null || g.q1_away_ml != null)) {
      var mm = -g.spread * Q.q1m, pw = 1 - ncdf((.5 - mm) / Q.q1m_sd), pl = ncdf((-.5 - mm) / Q.q1m_sd), ph = pw / (pw + pl), home = g.home === t.abbr;
      out.push({m: 'q1_ml', g: 'ml', gid: g.gid, matchup: mu, name: '1st-quarter winner', line: null,
        over: home ? g.q1_home_ml : g.q1_away_ml, under: home ? g.q1_away_ml : g.q1_home_ml, over_sel: home ? g.q1_home_ml_sel : g.q1_away_ml_sel, under_sel: home ? g.q1_away_ml_sel : g.q1_home_ml_sel,
        pm: home ? ph : 1 - ph, pb: home ? ph : 1 - ph, lab_o: t.abbr + ' 1st quarter', lab_u: (home ? g.away : g.home) + ' 1st quarter', sideNames: [t.abbr, home ? g.away : g.home],
        fails: 'Did not beat Onyx in testing', note: 'The model\'s chance from 34% of Onyx\'s spread. It did not beat Onyx in testing: shown, never recommended'});
    }
    return out;
  }
  // NBA props: each market the page's bet card prices (nba_build.bet_ladders), on Onyx's main line
  var NBA_NAME = {pts: 'Points', reb: 'Rebounds', ast: 'Assists', pra: 'Pts + Reb + Ast', pr: 'Pts + Reb', pa: 'Pts + Ast', fg3: 'Threes made', dd: 'Double-double', td: 'Triple-double'};
  function nbaRows(abbr) {
    var out = [], MK = window.BC_MKTS || {};
    ((NBA || {}).players || []).forEach(function (p) {
      if (p.team !== abbr || !p.bets) return;
      Object.keys(p.bets).forEach(function (s) {
        var L = p.bets[s] || [], i = -1, ml = ((p.props || {})[s] || {}).line;
        if (ml != null) i = L.findIndex(function (r) { return r[0] === ml; });
        if (i < 0) i = L.findIndex(function (r) { return r[3] != null; });
        if (i < 0) i = 0;
        var r = L[i];
        if (!r) return;
        var m = {m: s, name: (MK[s] || [])[0] || NBA_NAME[s] || s, line: r[0], over: r[1], over_sel: r[2], under: r[3], under_sel: r[4], pm: r[5], pb: r[6],
          nba: {pid: p.pid, s: s, i: i, line: r[0], n: L.length}};
        if (s === 'dd' || s === 'td') m.yes = true;
        if (s === 'fg3') m.shape = 'Threes shape not backtested';
        if (s === 'pra' || s === 'pr' || s === 'pa') m.shape = 'Combined stat, not backtested';
        out.push(mkRow({n: p.name, team: p.team, gid: p.gid}, m, 'n' + p.pid + s, p.name));
      });
    });
    return out;
  }
  function teamRows(t) {
    var G = t.game || {}, out = gameMarkets(t).map(function (m, i) { return mkRow({n: '', team: t.abbr, gid: G.gid, start: G.start}, m, 'g' + i, ''); });
    if (NBA) out = out.concat(nbaRows(t.abbr));
    else Object.keys(CX.players || {}).forEach(function (k) {
      var p = CX.players[k];
      (p.mk || []).forEach(function (m, i) { out.push(mkRow(p, m, k + '#' + i, p.n)); });
    });
    return rank(out);
  }
  function playerRows(p) { return rank((p.mk || []).map(function (m, i) { return mkRow(p, m, 'p' + i, ''); })); }
  function curRows() { return !CX || !CX.data ? [] : CX.type === 'team' ? teamRows(CX.data) : playerRows(CX.data); }
  function openRow(r) {
    if (!r) { CX.open = null; BS = null; return; }
    var m = r.m;
    CX.open = r.key;
    BS = {key: r.key, p: r.p, m: m, side: r.side, x: m.line != null ? m.line : m.proj != null ? Math.round(m.proj * 2) / 2 : 0};
  }
  // NBA: the page's own bet card, on this row's line and side, above the team card
  function nbaOpen(r) {
    if (typeof window.openBetCard !== 'function') return;
    track('bet_card_open', {player: r.who, source: 'team_card'});
    window.openBetCard(r.nba.pid, r.nba.s);
    try {
      var B = window.BC;
      if (B && B.pid === r.nba.pid && B.s === r.nba.s) { B.i = r.nba.i; B.x = r.nba.line; B.side = r.side; if (typeof window.bcRender === 'function') window.bcRender(); }
    } catch (e) {}
    var pc = document.getElementById('pc'), bg = document.getElementById('pcBg');
    if (pc) pc.style.zIndex = '10095';
    if (bg) bg.style.zIndex = '10090';
  }
  if (NBA && typeof window.pcClose === 'function' && !window.pcClose._cx) {
    // closing the NBA card over a team card leaves the team card's page lock in place
    var pcClose0 = window.pcClose;
    window.pcClose = function () { pcClose0.apply(this, arguments); var el = document.getElementById('cx'); if (el && el.classList.contains('open')) document.body.style.overflow = 'hidden'; };
    window.pcClose._cx = 1;
  }
  function pcUp() { var pc = document.getElementById('pc'); return !!(pc && pc.classList.contains('open')); }

  // ── the list ──
  function bestBox(rows) {
    var c = rows.filter(function (r) { return r.test.t === 1 && r.ev != null; });
    var b = c.length ? c.reduce(function (a, x) { return x.ev > a.ev ? x : a; }) : null;
    var scope = 'Across ' + c.length + ' tested market' + (c.length === 1 ? '' : 's') + ' priced ' + REC[0] + ' to +' + REC[1] + ': the blended chance at Onyx\'s price.';
    if (b && b.ev > 0)
      return '<button class="bc-best" data-cx="bb" data-k="' + esc(b.key) + '"><span class="eb">' + (b.pick ? 'Onyx Pick · best expected value' : 'Best bet by expected value') + '</span>' +
        '<span class="bt">' + esc(rowLab(b)) + ' <em>' + odds(b.price) + '</em></span>' +
        '<span class="bv ' + mcls(b.ev) + '">' + money(10 * b.ev) + ' <small>per $10</small></span>' +
        '<span class="bw">' + esc(scope) + ' ' + (b.pick ? 'Logged on the public Onyx Picks record.' : 'A projection, not a tracked pick.') + '</span></button>';
    return '<div class="bc-best none"><span class="eb">Best bet</span><span class="bt">' + (c.length ? 'No tested market shows value at Onyx\'s prices right now' : 'No market here has been tested against Onyx yet') + '</span>' +
      '<span class="bw">' + (b ? esc(scope) + ' Closest to fair: ' + esc(rowLab(b)) + ' ' + odds(b.price) + ', ' + money(10 * b.ev) + ' per $10. Below zero is not a bet we would call value.'
        : 'Every line below is shown with its numbers, labelled, and none is called value.') + '</span></div>';
  }
  function rowHtml(r) {
    var open = CX.open === r.key && !r.nba, t = r.test.t, ev = r.ev;
    // untested or failed markets show the model's chance, never a dollar figure that reads as value
    var pmS = r.m.pm == null ? null : r.side === 'over' ? r.m.pm : 1 - r.m.pm;
    var right = '<b>' + odds(r.price) + '</b>' + (t === 4 && pmS != null ? '<em class="dim">' + pct(pmS, 0) + '</em><small>model</small>' : ev != null && t !== 3 ? '<em class="' + (t === 1 || r.pick ? mcls(ev) : 'dim') + '">' + money(10 * ev) + '</em><small>per $10</small>'
      : r.m.sides && r.m.sides[0] && r.m.sides[0].fair != null ? '<em class="dim">' + pct(r.side === 'over' ? r.m.sides[0].fair : (r.m.sides[1] || {}).fair, 0) + '</em><small>no-vig</small>' : '<em class="dim">-</em><small>Onyx only</small>');
    var sub = [esc(r.test.lab), r.ch != null && t <= 2 ? pct(r.ch, 0) + ' blended' : ''].filter(Boolean).join(' · ');
    return '<div class="cx-bb' + (open ? ' open' : '') + (t >= 3 && !r.pick ? ' lo' : '') + '"><button class="cx-bbr" data-cx="bb" data-k="' + esc(r.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="cx-bbl"><span class="cx-bdg ' + (r.pick ? 'pk' : 'pj') + '">' + (r.pick ? 'Onyx Pick' : 'Projection') + '</span><b>' + esc(rowLab(r)) + '</b><em>' + sub + '</em></span>' +
      '<span class="cx-bbv">' + right + '</span><span class="cx-bbc">' + (r.nba ? '›' : open ? '−' : '+') + '</span></button>' +
      (open ? '<div class="cx-bbp">' + panel(r.m) + '</div>' : '') + '</div>';
  }
  function betList(rows, whose) {
    var q = (CX.q || '').toLowerCase().trim();
    var R = rows.filter(function (r) { return !q || (rowLab(r) + ' ' + r.m.name + ' ' + shortMk(r.m) + ' ' + r.test.lab).toLowerCase().indexOf(q) >= 0; });
    var lim = CX.more || q ? R.length : 25;
    return (rows.length > 6 ? '<label class="bc-search"><input type="search" placeholder="Search ' + whose + ' markets" value="' + esc(CX.q || '') + '" data-cx="search" aria-label="Search markets"></label>' : '') +
      '<div class="cx-bbs">' + (R.slice(0, lim).map(rowHtml).join('') || '<div class="cx-empty">No market matches.</div>') + '</div>' +
      (R.length > lim ? '<button class="cx-btn cx-more" data-cx="more">Show all ' + R.length + ' markets</button>' : '');
  }
  var LEGEND = 'Ranked by expected value: the blended chance at Onyx\'s price, per $10, the number the home Top 10 ranks by. Onyx Pick = logged on the public record (Onyx Picks); Projection = the model\'s number, not a tracked pick. Tested markets come first; long prices, Onyx-only lines and markets not tested against Onyx (or that did not beat it) follow and are never called value. Tap a row for its bet card.';
  function playerBets(p) {
    var rows = playerRows(p);
    if (CX.open === undefined) openRow(rows[0]);
    return pHead(p, 'bets') + '<div class="pc-body">' +
      (rows.length ? bestBox(rows) + betList(rows, 'his') + '<div class="cx-note">' + LEGEND + '</div>' : '<div class="cx-empty">No Onyx line on him right now.</div>') + '</div>';
  }

  // ── the bet card (one market): reads, distribution, slider, Onyx's lines, add / bet ──
  function rungsOf(m) { return m.lad && m.lad.length ? m.lad : m.line != null ? [[m.line, m.over, m.over_sel, m.under, m.under_sel, m.pm, m.pb]] : []; }
  function rangeOf(m) {
    var d = m.dist;
    if (!d || m.yes) return null;
    var sd = d.t === 'n' ? d.s : Math.sqrt(d.t === 'nb' ? d.v : d.m);
    var lo = Math.max(d.t === 'n' && (d.m < 0 || d.z) ? -1e9 : 0, Math.floor((d.m - 2.5 * sd) * 2) / 2 + .5), hi = Math.ceil((d.m + 2.5 * sd) * 2) / 2 - .5;
    rungsOf(m).forEach(function (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[0]); });
    if (hi - lo < 1) hi = lo + 1;
    return [lo, hi];
  }
  function panel(m) {
    var rg = rangeOf(m), R = rungsOf(m), sn = m.sideNames;
    return '<div class="bc-main" id="cxMain"><div class="bc-line"><div><div class="bc-big" id="cxBig"></div>' +
      '<div class="bc-side" id="cxSide"><button data-cx="side" data-s="over">' + esc(sn ? sn[0] : m.yes ? 'Yes' : 'Over') + '</button><button data-cx="side" data-s="under">' + esc(sn ? sn[1] : m.yes ? 'No' : 'Under') + '</button></div><div class="bc-note" id="cxSideNote"></div></div>' +
      '<div class="bc-price" id="cxPrice"></div></div><div class="bc-stats" id="cxStats"></div>' +
      (rg && m.dist ? '<div class="cx-dist" id="cxDist"></div><div class="cx-rail" id="cxRail"><div class="cx-rail-fill"></div>' + R.map(function (r, j) { return '<i class="main" data-j="' + j + '"></i>'; }).join('') + '<b class="cx-thumb"></b>' +
        '<input id="cxRange" type="range" min="' + rg[0] + '" max="' + rg[1] + '" step="0.5" value="' + BS.x + '" aria-label="Line"></div>' : '') +
      (R.length && m.line != null ? '<div class="cx-rungs" id="cxRungs">' + R.map(function (r, j) {
        return '<button data-cx="rung" data-j="' + j + '"><b>' + esc(m.g === 'spread' ? sn[0] + ' ' + hc(-r[0]) : r[0]) + '</b><span></span></button>'; }).join('') + '</div>' : '') +
      '<div class="bc-note">' + esc(noteOf(m)) + (R.length === 1 && m.dist ? ' Onyx posts one line on this market, so the chips hold that line; the slider reads the model\'s chance between lines.' : '') + '</div>' +
      (m.why && m.why.length ? '<div class="cx-whyl">' + m.why.map(function (w) { return '<span>' + esc(Array.isArray(w) ? w.join(' ') : typeof w === 'object' ? (w.k || w.t || '') + ' ' + (w.v != null ? w.v : '') : w) + '</span>'; }).join('') + '</div>' : '') +
      '<div class="bc-acts"><button class="cx-btn" id="cxAdd" data-cx="add">+ Add to parlay</button><button class="cx-btn p" id="cxBet" data-cx="bet">⚡ Bet on Onyx</button><span id="cxSave" style="display:inline-flex"></span></div></div>';
  }
  // market notes by code (cards.py "nc"), so each team's file does not repeat them
  var NOTES = {onyx: 'Not modeled: Onyx\'s price only.', noline: 'No Onyx line yet: projection only.',
    role: 'The projection is far from Onyx\'s line (a role change or a stale line): shown, not priced.',
    td_any: 'Touchdown chance: Onyx\'s price with its margin removed (the touchdown model lost to it in testing); the model\'s own chance is shown beside it.',
    td_info: 'Information only: Onyx\'s price won the backtest on this market.',
    nhl: 'Poisson around his projected scoring rate times his projected ice time. Skater props were tested against Onyx (10/29) and did not beat it: shown, never recommended.',
    cbb: 'Season projection, not adjusted for tonight\'s opponent. Its spread is the NBA model\'s fit, untested in college: shown, never recommended.'};
  function noteOf(m) {
    if (m.nc && NOTES[m.nc]) return NOTES[m.nc];
    if (m.note) return m.note + '.';
    if (m.mm) return 'Market model: Onyx\'s price moved by the statistics that beat it in testing (listed below). Its chance is not a projection, so there is no chart.';
    if (m.pb != null && m.pm != null) return 'Blended = the model\'s chance weighted with Onyx\'s price with the margin removed, the same math as the board. Drag the chart or the slider: off Onyx\'s line you see the model\'s chance only; release to snap back to the line you can bet.';
    return 'Onyx\'s price only.';
  }
  function curMk() { return BS ? BS.m : null; }
  function nearRung(m, x) { var R = rungsOf(m), j = 0; R.forEach(function (r, i) { if (Math.abs(r[0] - x) < Math.abs(R[j][0] - x)) j = i; }); return R.length ? j : -1; }
  // the reading at the slider: an Onyx line (its prices), or between lines (the model's chance only)
  function pick() {
    var m = curMk();
    if (!m) return null;
    var R = rungsOf(m), x = Math.round(BS.x * 2) / 2, r = null;
    if (!m.dist || !R.length) r = R[0] || null;
    else R.forEach(function (q) { if (Math.abs(q[0] - x) < 1e-9) r = q; });
    if (r || !R.length) {
      var o = r ? r[1] : m.over, u = r ? r[3] : m.under, pm = r ? r[5] : m.pm, pb = r ? r[6] : m.pb;
      var side = BS.side === 'under' && u == null ? 'over' : BS.side === 'over' && o == null && u != null ? 'under' : BS.side;
      var pr = side === 'over' ? o : u, ok = pm != null && pb != null;
      return {exact: true, side: side, line: r ? r[0] : m.line, price: pr, sel: r ? (side === 'over' ? r[2] : r[4]) : (side === 'over' ? m.over_sel : m.under_sel),
        pm: pm == null ? null : side === 'over' ? pm : 1 - pm, pb: ok ? (side === 'over' ? pb : 1 - pb) : null,
        imp: imp(pr), ev: ok && pr != null ? (side === 'over' ? pb : 1 - pb) * dec(pr) - 1 : null, under: u != null, over: o != null};
    }
    var po = pOver(m.dist, x);
    return {exact: false, side: BS.side, line: x, pm: po == null ? null : BS.side === 'over' ? po : 1 - po};
  }
  function update(snap) {
    var $ = function (id) { return document.getElementById(id); };
    if (!CX || !BS || !BS.m || !$('cxBig')) return;
    var p = BS.p || {}, m = BS.m, k = pick(), yes = !!m.yes, R = rungsOf(m);
    if (!k) return;
    $('cxBig').innerHTML = m.g === 'ml' ? esc(sideLab(m, k.side)) + ' <span>' + esc(m.name) + '</span>'
      : m.g === 'spread' ? esc(sideLab(m, k.side, k.exact ? null : k.line)) + ' <span>' + esc(m.name) + '</span>'
      : yes ? esc(m.name) + (k.side === 'under' ? ': No' : '') : (k.side === 'over' ? 'Over ' : 'Under ') + (k.line == null ? '' : k.exact ? k.line : k.line.toFixed(1)) + ' <span>' + esc(m.name) + '</span>';
    $('cxPrice').innerHTML = k.exact ? (k.price != null ? odds(k.price) + '<span>' + (mkt() ? 'Market line (Onyx prices are down)' : 'Onyx') + '</span>' : '<i class="na">no Onyx price</i><span>this side</span>') : '<i class="na">not offered</i><span>scrubbing</span>';
    $('cxPrice').classList.toggle('ghost', !k.exact);
    var sb = $('cxSide');
    sb.style.display = k.exact && k.over && k.under ? '' : 'none';
    sb.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.s === k.side); });
    $('cxSideNote').innerHTML = !k.exact ? 'Between Onyx lines' + (R.length === 1 ? ' · Onyx line <b>' + esc(m.g === 'spread' ? (k.side === 'over' ? m.lab_o : m.lab_u) : m.line) + '</b>' : '') + ' · release to snap'
      : !k.under && k.over && !yes && !m.g ? 'Onyx prices the over only here' : '';
    $('cxStats').innerHTML = '<div><span>Model</span><b>' + (k.pm != null ? pct(k.pm, 1) : '-') + '</b></div>' +
      '<div><span>Onyx implied</span><b>' + (k.exact && k.imp != null ? pct(k.imp, 1) : '-') + '</b></div>' +
      '<div><span>Blended</span><b>' + (k.exact && k.pb != null ? pct(k.pb, 1) : '-') + '</b></div>' +
      '<div><span>EV per $10</span>' + (k.exact && k.ev != null ? '<b class="' + (testOf(m).t === 1 ? mcls(k.ev) : '') + '">' + money(10 * k.ev) + '</b>' : '<b class="dim">-</b>') + '</div>';
    var dist = $('cxDist'), rg = rangeOf(m);
    var a0 = 0, a1 = 1, at = function () { return 0; };
    if (dist && m.dist && rg) {
      var B = dist._b;
      if (!B || dist.dataset.k !== BS.key) {
        B = bins(m.dist, m.line); var mx = Math.max.apply(null, B.map(function (b) { return b.p; })) || 1;
        dist._b = B; dist.dataset.k = BS.key;
        dist.innerHTML = '<div class="cx-bars">' + B.map(function (b) { return '<i style="height:' + Math.max(2, b.p / mx * 100) + '%" title="' + (b.k != null ? b.k : Math.round(b.a) + ' to ' + Math.round(b.b)) + ': ' + (b.p * 100).toFixed(1) + '%"></i>'; }).join('') + '<b class="cx-mark"><span></span></b></div>' +
          '<div class="cx-axis"><span>' + fmtStat(B[0].k != null ? B[0].k : B[0].a) + '</span><span>' + (m.g === 'spread' ? esc(m.sideNames[0]) + ' margin ' + sg(m.dist.m) : 'proj ' + num(m.proj != null ? m.proj : m.dist.m)) + '</span><span>' + fmtStat(B[B.length - 1].k != null ? B[B.length - 1].k : B[B.length - 1].b) + '</span></div>';
      }
      a0 = B[0].a; a1 = B[B.length - 1].b; at = function (x) { return Math.min(100, Math.max(0, (x - a0) / (a1 - a0) * 100)); };
      var L = k.line;
      [].forEach.call(dist.querySelectorAll('.cx-bars i'), function (el, j) { var b = B[j], mid = (b.a + b.b) / 2; el.className = k.side === 'over' ? (mid > L ? 'ov' : '') : (mid < L ? 'un' : ''); });
      var mk = dist.querySelector('.cx-mark'); mk.style.left = at(BS.x) + '%'; mk.classList.toggle('ghost', !k.exact);
      var xs = k.exact ? k.line : Math.round(BS.x * 2) / 2;   // a spread reads from the side shown: CHI +3 / SEA -3
      mk.querySelector('span').textContent = m.g === 'spread' ? hc(k.side === 'over' ? -xs : xs) : k.exact ? k.line : (Math.round(BS.x * 2) / 2).toFixed(1);
      var rail = $('cxRail');
      if (rail) {
        rail.querySelector('.cx-thumb').style.left = at(BS.x) + '%'; rail.querySelector('.cx-thumb').classList.toggle('ghost', !k.exact);
        rail.querySelectorAll('i.main').forEach(function (t) { var r = R[+t.dataset.j]; if (r) t.style.left = at(r[0]) + '%'; });
        var f = rail.querySelector('.cx-rail-fill'), z = at(rg[0]); f.style.left = z + '%'; f.style.width = Math.max(0, at(BS.x) - z) + '%';
        var rn = $('cxRange'); if (rn && (document.activeElement !== rn || snap)) rn.value = BS.x;
      }
    }
    var rungs = $('cxRungs');
    if (rungs) {
      var nj = nearRung(m, BS.x);
      rungs.querySelectorAll('button').forEach(function (b) {
        var j = +b.dataset.j, r = R[j], u = k.side === 'under' && r[3] != null;
        b.classList.toggle('on', k.exact && Math.abs(r[0] - k.line) < 1e-9); b.classList.toggle('near', !k.exact && j === nj);
        if (m.g === 'spread') b.querySelector('b').textContent = m.sideNames[k.side === 'over' ? 0 : 1] + ' ' + hc(k.side === 'over' ? -r[0] : r[0]);
        b.querySelector('span').textContent = m.g ? odds(u ? r[3] : r[1] != null ? r[1] : r[3]) : (u ? 'U ' : r[1] != null ? 'O ' : 'U ') + odds(u ? r[3] : r[1] != null ? r[1] : r[3]);
      });
    }
    var g0 = gameOf(p.gid || m.gid) || {}, mu = m.matchup || (g0.away && g0.home ? g0.away + ' @ ' + g0.home : '');
    var leg = k.exact && k.sel && k.price != null ? {sel: k.sel, price: k.price, gid: p.gid || m.gid, market: m.g ? m.m : 'player_' + m.m,
      label: m.g ? (m.g === 'ml' || m.g === 'spread' ? sideLab(m, k.side) : mu + ' ' + sideLab(m, k.side))
        : p.n + ' ' + (yes ? m.name + (k.side === 'under' ? ' No' : '') : (k.side === 'over' ? 'Over ' : 'Under ') + k.line + ' ' + m.name)} : null;
    var add = $('cxAdd'), bet = $('cxBet');
    add.disabled = bet.disabled = !leg;
    add.textContent = leg && inSlip(leg.sel) ? '✓ In your parlay' : '+ Add to parlay';
    CX.leg = leg;
    var sv = $('cxSave');
    if (!sv) return;
    if (!leg) { sv.innerHTML = ''; return; }
    if (m.sides) { var sd0 = m.sides[k.side === 'over' ? 0 : 1]; sv.innerHTML = sd0 ? star(sidePick(sd0, m.gid)) : ''; return; }
    sv.innerHTML = star({id: leg.sel, sport: SPORT, label: leg.label, matchup: mu, start: p.start || g0.start, gid: p.gid || m.gid, team: p.team, price: k.price, conf: k.pb,
      kind: 'prop', mkt: MKEY[m.m] || m.m, side: yes ? 'over' : k.side, line: k.line, name: m.g ? mu : p.n});
  }
  function bindChart() {
    ['cxDist', 'cxRail'].forEach(function (id) {
      var s = document.getElementById(id);
      if (!s) return;
      var drag = false;
      var at = function (e) {
        var m = curMk(), rg = m && rangeOf(m), B = (document.getElementById('cxDist') || {})._b;
        if (!rg || !B) return;
        var r = s.getBoundingClientRect(), a0 = B[0].a, a1 = B[B.length - 1].b;
        var x = a0 + (e.clientX - r.left) / r.width * (a1 - a0);
        x = Math.min(rg[1], Math.max(rg[0], Math.round(x * 2) / 2));
        if (x !== BS.x) { BS.x = x; if (rungsOf(m).some(function (q) { return q[0] === x; })) buzz(); update(false); }
      };
      s.addEventListener('pointerdown', function (e) { if (e.target.tagName === 'INPUT') return; drag = true; try { s.setPointerCapture(e.pointerId); } catch (x) {} at(e); });
      s.addEventListener('pointermove', function (e) { if (drag) at(e); });
      var end = function () { if (!drag) return; drag = false; snapBack(); };
      s.addEventListener('pointerup', end); s.addEventListener('pointercancel', end);
    });
    var rg = document.getElementById('cxRange');
    if (rg) { rg.addEventListener('input', function () { BS.x = +rg.value; update(false); }); rg.addEventListener('change', snapBack); }
  }
  function snapBack() {
    var m = curMk(), j = m ? nearRung(m, BS.x) : -1;
    if (j >= 0) { BS.x = rungsOf(m)[j][0]; var mn = document.getElementById('cxMain'); if (mn) { mn.classList.add('snap'); setTimeout(function () { mn.classList.remove('snap'); }, 260); } }
    update(true);
  }

  // ── team card ──
  function tHead(t, face) {
    var G = t.game || {}, M = G.model, N = G.nba, O = G.onyx || {};
    var badge = M ? [sg(M.margin), 'PROJ MARGIN'] : N && N.net != null ? [sg(N.net), 'NET / 100'] : null;
    var sub = esc(rec(t.rec)) + (t.rec && (t.rec.ats[0] + t.rec.ats[1]) ? ' · ' + trip(t.rec.ats, 'ATS') : '') + (t.rec && (t.rec.ou[0] + t.rec.ou[1]) ? ' · O/U ' + trip(t.rec.ou) : '');
    var nx = G.opp ? (G.home ? 'vs ' : '@ ') + '<a data-oxt="' + esc(G.opp) + '" class="cx-tlink">' + esc(G.opp) + '</a> · ' + when(G.start) : '';
    var n = teamRows(t).length;
    return '<div class="pc-head"><div class="pc-logo">' + teamLogo(t.abbr, t.logo) + '</div><div class="pc-hs"><span class="hs cx-tl">' + (teamLogo(t.abbr, t.logo) || esc(t.abbr)) + '</span></div>' +
      '<div class="pc-id"><div class="pc-name">' + esc(NBA && window.TEAM_NICK && TEAM_NICK[t.abbr] ? TEAM_NICK[t.abbr] : t.name || t.abbr) + '</div><div class="sub">' + sub + '</div>' + (nx ? '<div class="sub">' + nx + '</div>' : '') + '</div>' +
      (badge ? '<div class="pc-rate"><b>' + badge[0] + '</b><span>' + badge[1] + '</span></div>' : '<span></span>') +
      '<button class="pc-x" data-cx="close" aria-label="Close">×</button></div>' + seg('Team', 'Bets', n, face === 'bets' ? 'bets' : 'front');
  }
  function teamWhy(t) {
    var G = t.game, out = [];
    if (!G) return '<div class="cx-hdr"><span>Why this number</span></div><div class="cx-note">No game on this slate.</div>';
    var M = G.model, N = G.nba, O = G.onyx || {}, u = (IDX || {}).unit === 'goals' ? 'goals' : 'pts', opp = G.opp;
    if (M) {
      out.push({k: 'Projected score', v: num(M['for']) + ' - ' + num(M.against), d: t.abbr + ' vs ' + opp + ', from the ratings'});
      out.push({k: 'Margin vs Onyx', v: sg(M.margin), d: t.abbr + '\'s margin by the model' + (O.spread != null ? ' · Onyx has ' + t.abbr + ' ' + sg(O.spread, 1) : '')});
      out.push({k: 'Total vs Onyx', v: num(M.total), d: O.total != null ? 'model total · Onyx total ' + O.total : 'model total'});
      out.push({k: 'Offense', v: sg(M.off, 2), d: u + ' a game above the ' + num(M.mu, 1) + ' average · ' + opp + ' ' + sg(M.opp_off, 2)});
      out.push({k: 'Defense', v: sg(M.def, 2), d: u + ' a game kept off the board · ' + opp + ' ' + sg(M.opp_def, 2)});
      out.push({k: 'Home edge', v: G.neutral ? 'Neutral' : (G.home ? '+' : '-') + num(M.home_edge / 2, 2), d: G.neutral ? 'no home edge at a neutral site' : (G.home ? 'at home' : 'on the road') + ': half of the ' + num(M.home_edge, 1) + ' ' + u + ' edge each way'});
      if (M.poss != null) out.push({k: 'Game pace', v: num(M.poss), d: 'expected possessions · ' + t.abbr + ' ' + num(M.tempo) + ', ' + opp + ' ' + num(M.opp_tempo) + ', D1 ' + num(M.avg_tempo)});
      out.push({k: 'Win chance', v: pct(M.win, 0), d: 'the model alone, before the blend with Onyx'});
      out.push({k: 'Sample', v: String(M.n), d: 'games the rating rests on (a preseason prior counts as a few) · ' + opp + ' ' + M.opp_n});
    }
    if (N) {
      out.push({k: 'Game pace', v: num(N.game_poss), d: 'expected possessions · ' + t.abbr + ' ' + num(N.pace) + ', ' + opp + ' ' + num(N.opp_pace)});
      out.push({k: 'Offense / 100', v: num(N.ortg), d: 'points per 100 possessions, regressed · ' + opp + ' ' + num(N.opp_ortg)});
      out.push({k: 'Defense / 100', v: num(N.drtg), d: 'allowed per 100 possessions · ' + opp + ' ' + num(N.opp_drtg)});
      out.push({k: 'Net rating', v: sg(N.net), d: 'per 100 · ' + opp + ' ' + sg(N.opp_net) + ' · ' + esc(N.gp) + ' games'});
    }
    if (O.implied != null) out.push({k: 'Team total', v: num(O.implied), d: 'implied by Onyx' + (O.spread != null ? ' · spread ' + sg(O.spread, 1) : '')});
    if (G.rest != null) out.push({k: 'Rest', v: G.rest + ' day' + (G.rest === 1 ? '' : 's'), d: 'since the last game · ' + opp + ' ' + (G.opp_rest != null ? G.opp_rest + ' days' : '-') + ' · context, not in the rating'});
    if (t.inj && t.inj.length) out.push({k: 'Injury report', v: String(t.inj.length), d: 'out or questionable (below) · ' + opp + ' ' + (G.opp_inj || 0) + ' · the ratings do not adjust for them'});
    // a team the ratings cannot price yet (too few games) still gets the heading, over the note that says so
    return (out.length ? why(out, 'Why this number') : '<div class="cx-hdr"><span>Why this number</span></div>') + (N ? '<div class="cx-note">The NBA model prices player props, not sides or totals: these are the team inputs it uses, and the game-line chances on the Bets side are Onyx\'s own with the margin removed.</div>'
      : M ? '<div class="cx-note">Ratings: ' + u + ' scored = league average + home edge + the team\'s offense - the opponent\'s defense, fitted on every final with recent games weighing more. Each Onyx line is priced from them and blended with Onyx\'s price (' + Math.round(100 * (G.w || 0)) + '% model).</div>'
        : '<div class="cx-note">Not enough games for the ratings to price this one yet.</div>') + sidesTable(t, true);
  }
  function sideRow(s, i, compact) {
    var ev = s.pb != null && s.price != null ? s.pb * dec(s.price) - 1 : null, noModel = s.pm == null;
    var h = compact ? ' hm' : '';
    return '<tr><td><b>' + esc(s.lab) + '</b></td><td class="r"><button class="cx-odds" data-cx="sidebet" data-i="' + i + '">' + odds(s.price) + '</button></td>' +
      '<td class="r mono">' + (noModel ? '-' : pct(s.pm, 1)) + '</td><td class="r mono' + h + '">' + pct(imp(s.price), 1) + '</td>' +
      '<td class="r mono">' + (noModel ? '-' : pct(s.pb, 1)) + '</td><td class="r mono' + h + ' ' + (noModel ? '' : mcls(ev)) + '">' + (noModel || ev == null ? '-' : money(10 * ev)) + '</td>' +
      (compact ? '' : '<td class="r" style="white-space:nowrap"><button class="cx-add" data-cx="sideadd" data-i="' + i + '">' + (inSlip(s.sel) ? '✓' : '+') + '</button> ' + star(sidePick(s, (t0() || {}).gid)) + '</td>') + '</tr>';
  }
  function t0() { return CX && CX.data ? CX.data.game : null; }
  function sidesTable(t, compact) {
    var S = (t.game || {}).sides || [];
    if (!S.length) return '';
    if (S.every(function (s) { return s.pm == null; }))     // no model on these lines (NBA sides): Onyx's own chances
      return '<div class="cx-tbl"><table><thead><tr><th>Onyx line</th><th class="r">Onyx</th><th class="r">Implied</th><th class="r">No-vig</th>' + (compact ? '' : '<th></th>') + '</tr></thead><tbody>' +
        S.map(function (s, i) { return '<tr><td><b>' + esc(s.lab) + '</b></td><td class="r"><button class="cx-odds" data-cx="sidebet" data-i="' + i + '">' + odds(s.price) + '</button></td><td class="r mono">' + pct(imp(s.price), 1) + '</td><td class="r mono">' + pct(s.fair, 1) + '</td>' +
          (compact ? '' : '<td class="r" style="white-space:nowrap"><button class="cx-add" data-cx="sideadd" data-i="' + i + '">' + (inSlip(s.sel) ? '✓' : '+') + '</button> ' + star(sidePick(s, (t.game || {}).gid)) + '</td>') + '</tr>'; }).join('') + '</tbody></table></div>';
    var h = compact ? ' hm' : '';
    return '<div class="cx-tbl"><table><thead><tr><th>Onyx line</th><th class="r">Onyx</th><th class="r">Model</th><th class="r' + h + '">Implied</th><th class="r">Blended</th><th class="r' + h + '">EV/$10</th>' + (compact ? '' : '<th></th>') + '</tr></thead><tbody>' +
      S.map(function (s, i) { return sideRow(s, i, compact); }).join('') + '</tbody></table></div>';
  }
  function teamFront(t) {
    var S = t.seasons || [], R = t.recent || [], T = t.trends || [];
    var rk = S.some(function (s) { return s.rt; }) ? Object.keys((S.find(function (s) { return s.rt; }) || {}).rt) : [];
    var RL = {off: 'Off', def: 'Def', adj_o: 'AdjO', adj_d: 'AdjD', adj_em: 'AdjEM', tempo: 'Tempo', rank: 'Rank', ortg: 'ORtg', drtg: 'DRtg', pace: 'Pace'};
    var src = (IDX || {}).lines_src;
    var html = tHead(t, 'front') + '<div class="pc-body">' + teamWhy(t) +
      '<div class="cx-hdr"><span>Team history</span><em>' + (src ? 'ATS and O/U vs the closing line' : 'no closing lines held') + '</em></div>' +
      '<div class="cx-tbl"><table><thead><tr><th>Season</th><th class="r">W-L</th><th class="r">ATS</th><th class="r">O/U</th><th class="r hm">PF</th><th class="r hm">PA</th>' + rk.map(function (k) { return '<th class="r">' + esc(RL[k] || k) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (S.map(function (s) { return '<tr><td class="mono dim">' + esc(s.label) + '</td><td class="r mono">' + esc(rec(s)) + '</td><td class="r mono">' + trip(s.ats) + '</td><td class="r mono">' + trip(s.ou) + '</td><td class="r mono hm">' + num(s.pf) + '</td><td class="r mono hm">' + num(s.pa) + '</td>' +
        rk.map(function (k) { var v = (s.rt || {})[k]; return '<td class="r mono">' + (v == null ? '-' : k === 'rank' ? '#' + v : (k === 'off' || k === 'def' || k === 'adj_em') ? sg(v, k === 'adj_em' ? 1 : 2) : num(v)) + '</td>'; }).join('') + '</tr>'; }).join('')
        || '<tr><td colspan="6" class="dim">No finals held for this team yet.</td></tr>') + '</tbody></table></div>' +
      (rk.length ? '<div class="cx-note">' + (rk.indexOf('adj_em') >= 0 ? 'AdjO / AdjD: points per 100 possessions scored and allowed, adjusted for opponent (Bart Torvik); AdjEM the gap; Tempo possessions per 40 minutes. The model starts each season from them.'
        : rk.indexOf('ortg') >= 0 ? 'ORtg / DRtg: points scored and allowed per 100 possessions; Pace possessions per game. The props model reads these as its team prior.'
          : 'Off / Def: the team model\'s ratings at season end (' + (IDX && IDX.unit === 'goals' ? 'goals' : 'points') + ' a game against average, fitted on that season alone).') + '</div>' : '') +
      '<div class="cx-hdr"><span>Recent games</span><em>last ' + R.length + '</em></div><div class="cx-tbl"><table><thead><tr><th>Date</th><th>Opp</th><th class="r">Result</th><th class="r">Line</th><th class="r">ATS</th><th class="r">Total</th><th class="r">O/U</th></tr></thead><tbody>' +
      (R.map(function (g) { return '<tr><td class="mono dim">' + esc(String(g.d).slice(5)) + '</td><td>' + (g.ha === 'A' ? '@ ' : g.ha === 'N' ? 'vs ' : '') + '<a data-oxt="' + esc(g.opp) + '" class="cx-tlink">' + esc(g.opp) + '</a></td>' +
        '<td class="r mono"><span class="cx-tag ' + (g.r === 'W' ? 'g' : g.r === 'T' ? 'n' : 'r') + '">' + esc(g.r) + '</span> ' + num(g.pf, 0) + '-' + num(g.pa, 0) + '</td>' +
        '<td class="r mono">' + (g.sp == null ? '-' : sg(g.sp, 1)) + '</td><td class="r">' + (g.cov ? '<span class="cx-tag ' + (g.cov === 'W' ? 'g' : g.cov === 'P' ? 'n' : 'r') + '">' + g.cov + '</span>' : '-') + '</td>' +
        '<td class="r mono">' + (g.tot == null ? '-' : g.tot) + '</td><td class="r">' + (g.ou ? '<span class="cx-tag n">' + g.ou + '</span>' : '-') + '</td></tr>'; }).join('')
        || '<tr><td colspan="7" class="dim">No finals yet.</td></tr>') + '</tbody></table></div>' +
      (T.length ? '<div class="cx-hdr"><span>Trends</span><em>' + esc(t.trend_window || '') + '</em></div><div class="cx-tbl"><table><thead><tr><th>Spot</th><th class="r">N</th><th class="r">W-L</th><th class="r">ATS</th><th class="r">O/U</th></tr></thead><tbody>' +
        T.map(function (r) { var a = r.ats[0] + r.ats[1]; return '<tr><td>' + esc(r.k) + '</td><td class="r mono">' + r.n + (r.n < 10 ? '<span class="dim">*</span>' : '') + '</td><td class="r mono">' + esc(rec(r)) + '</td>' +
          '<td class="r mono">' + trip(r.ats) + (a ? ' <span class="dim hm">' + Math.round(100 * r.ats[0] / a) + '%</span>' : '') + '</td><td class="r mono">' + trip(r.ou) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="cx-note">Records in each spot over two seasons; N is the sample, * under 10 games. Context, not a pick: small samples swing on luck, and no spot here feeds the model.</div>' : '') +
      sims(t) + injuries(t) + keyPlayers(t) +
      '<div class="cx-acts">' + (depthOk() ? '<button class="cx-btn" data-cx="depth" data-t="' + esc(t.abbr) + '">Depth chart ›</button>' : '') +
      (teamRows(t).length ? '<button class="cx-btn p" data-cx="face" data-f="bets">See the ' + teamRows(t).length + ' best bets ›</button>' : '') + '</div>' +
      '</div>';
    return html;
  }
  function injuries(t) {
    if (!(t.inj || []).length) return '';
    return '<div class="cx-hdr"><span>Injury report</span><em>from the depth chart</em></div><div class="cx-chips">' + t.inj.slice(0, 12).map(function (x) {
      return '<button class="cx-chip" data-oxp="' + esc(x.n) + '" data-oxpt="' + esc(t.abbr) + '"><b>' + esc(x.n) + '</b><span>' + esc((x.pos ? x.pos + ' · ' : '') + x.tag) + '</span></button>'; }).join('') + '</div>';
  }
  function keyPlayers(t) {
    if (!(t.key || []).length) return '';
    return '<div class="cx-hdr"><span>Players</span><em>tap for his card</em></div><div class="cx-chips">' + t.key.map(function (x) {
      return '<button class="cx-chip" data-oxp="' + esc(x[1]) + '" data-oxpt="' + esc(t.abbr) + '"><b>' + esc(x[1]) + '</b><span>' + esc([x[2], x[3]].filter(Boolean).join(' · ')) + '</span></button>'; }).join('') + '</div>';
  }
  // Similar spots: the gamecenter's own card when the page has it (situations.py, another view of
  // the same data), else nothing
  function sims(t) {
    var gid = (t.game || {}).gid;
    if (!gid) return '';
    try {
      if (typeof window.simSpots === 'function') { var h = window.simSpots(gid); if (h) return '<div class="cx-sims">' + h + '</div>'; }
      if (typeof window.nbSimSpots === 'function') { var h2 = window.nbSimSpots(gid); if (h2) return '<div class="cx-sims">' + h2 + '</div>'; }
    } catch (e) {}
    return '';
  }
  function depthOk() { return typeof window.dpPick === 'function' || (NBA && typeof window.gotoTab === 'function' && (NBA.depth || {}).teams); }
  function teamBets(t) {
    var G = t.game || {}, rows = teamRows(t);
    if (CX.open === undefined) openRow(rows[0] && !rows[0].nba ? rows[0] : null);
    return tHead(t, 'bets') + '<div class="pc-body">' +
      (rows.length ? bestBox(rows) + '<div class="cx-hdr"><span>Best bets</span><em>' + rows.length + ' Onyx market' + (rows.length === 1 ? '' : 's') + (G.opp ? ' · ' + (G.home ? 'vs ' : '@ ') + esc(G.opp) : '') + '</em></div>' +
        betList(rows, 'the team\'s') + '<div class="cx-note">' + LEGEND + (NBA ? ' NBA game lines show Onyx\'s own chance with the margin removed: the NBA model prices player props and the 1st-quarter total, not sides. A player row opens his full bet card.' : '') + '</div>' +
        '<div class="cx-acts"><button class="cx-btn p" data-cx="betgame">⚡ Bet this game on Onyx</button></div>'
        : '<div class="cx-empty">No Onyx lines on this team right now.</div>') + '</div>';
  }

  // ── clicks: one delegated handler, capture phase ──
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-oxt],[data-oxp],[data-cx]');
    if (!a) return;
    if (a.hasAttribute('data-oxt') || a.hasAttribute('data-oxp')) {
      e.preventDefault(); e.stopPropagation();
      if (a.hasAttribute('data-oxt')) openTeam(a.getAttribute('data-oxt'));
      else openPlayer(a.getAttribute('data-oxp'), a.getAttribute('data-oxpt'), a.getAttribute('data-oxg'), a.getAttribute('data-oxf'));
      return;
    }
    var c = a.getAttribute('data-cx');
    if (!c) return;
    e.stopPropagation();
    var p = CX && CX.data;
    if (c === 'close') return close();
    if (c === 'slip') { var el = document.getElementById('cxSlip'); el.dataset.open = el.dataset.open ? '' : '1'; drawSlip(); return; }
    if (c === 'unslip') { SLIP = SLIP.filter(function (x) { return x.sel !== a.dataset.sel; }); try { localStorage.setItem(SLIP_KEY, JSON.stringify(SLIP)); } catch (x) {} drawSlip(); return; }
    if (c === 'slipclear') { SLIP = []; try { localStorage.setItem(SLIP_KEY, '[]'); } catch (x) {} drawSlip(); return; }
    if (c === 'slipgo') { track('onyx_click', {link_type: 'parlay', legs: SLIP.length, source: 'card'}); window.open(share(SLIP.map(function (x) { return x.sel; })), '_blank', 'noopener'); return; }
    if (!p) return;
    if (c === 'follow') { if (canFollow(p)) { window.toggleF(String(p.id), p.n, p.gid || ''); CX.keepScroll = true; draw(); } return; }
    if (c === 'face') { CX.face = a.dataset.f === 'bets' ? 'bets' : CX.type === 'team' ? 'team' : 'front'; if (CX.face !== 'bets') { CX.open = undefined; BS = null; } buzz(); draw(); return; }
    if (c === 'mk') { CX.face = 'bets'; openRow(curRows().filter(function (r) { return r.key === 'p' + a.dataset.i; })[0]); draw(); return; }
    if (c === 'bb') {
      var row = curRows().filter(function (r) { return r.key === a.dataset.k; })[0];
      if (!row) return;
      if (row.nba) { nbaOpen(row); return; }
      if (CX.open === row.key && !a.classList.contains('bc-best')) openRow(null); else openRow(row);
      buzz(); CX.keepScroll = true; draw();
      var el2 = document.querySelector('#cx .cx-bb.open');
      if (el2 && a.classList.contains('bc-best')) try { el2.scrollIntoView({block: 'nearest', behavior: 'smooth'}); } catch (x) {}
      return;
    }
    if (c === 'more') { CX.more = true; CX.keepScroll = true; draw(); return; }
    if (c === 'rung') { var mR = curMk(), rR = mR && rungsOf(mR)[+a.dataset.j]; if (rR) { BS.x = rR[0]; snapBack(); buzz(); } return; }
    if (c === 'side') { BS.side = a.dataset.s; update(true); return; }
    if (c === 'add') { if (CX.leg) { slipToggle(CX.leg); update(false); } return; }
    if (c === 'bet') { if (CX.leg) { track('onyx_click', {link_type: 'single', market: CX.leg.market, selection: CX.leg.label, odds: String(CX.leg.price), source: 'player_card'}); window.open(share([CX.leg.sel]), '_blank', 'noopener'); } return; }
    if (c === 'sidebet' || c === 'sideadd') {
      var s = ((p.game || {}).sides || [])[+a.dataset.i];
      if (!s || !s.sel) return;
      var leg = {sel: s.sel, price: s.price, gid: p.game.gid, market: s.k, label: s.lab};
      if (c === 'sidebet') { track('onyx_click', {link_type: 'single', market: s.k, selection: s.lab, odds: String(s.price), source: 'team_card'}); window.open(share([s.sel]), '_blank', 'noopener'); }
      else { slipToggle(leg); CX.keepScroll = true; draw(); }
      return;
    }
    if (c === 'betgame') {
      var g = p.game || {};
      track('onyx_click', {link_type: 'fallback', source: 'team_card'});
      var lg = PG ? ((PG.cfg || {}).onyx_league) : 'NBA';
      window.open('https://app.onyxodds.com/' + (lg ? 'leagues/' + lg : '') + '?utm_source=onyxsports&referrer=' + REF, '_blank', 'noopener');
      return;
    }
    if (c === 'depth') {
      var tm = a.dataset.t; close();
      if (typeof window.dpPick === 'function') { window.DEPTH_TEAM = tm; if (typeof window.gotoTab === 'function') window.gotoTab('depth'); window.dpPick(tm); }
      else if (NBA && typeof window.gotoTab === 'function') { try { window.depSel = tm; } catch (x) {} window.gotoTab('depth'); }
      return;
    }
  }, true);
  document.addEventListener('input', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-cx') === 'search' && CX && CX.data) {
      CX.q = e.target.value; var pos = e.target.selectionStart; CX.keepScroll = true; draw();
      var i = document.querySelector('[data-cx="search"]'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} }
    }
  });

  var CSS = [
    '.cx-bg{position:fixed;inset:0;z-index:10070;background:radial-gradient(120% 80% at 50% 40%,rgba(60,20,90,.55),rgba(4,4,8,.82));backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .25s}',
    '.cx-bg.open{opacity:1;pointer-events:auto}',
    '.cx{position:fixed;left:50%;top:50%;z-index:10080;width:min(580px,calc(100vw - 32px));height:min(800px,calc(100vh - 48px));opacity:0;visibility:hidden;transform:translate(-50%,-46%) scale(.94);transition:opacity .22s,transform .3s cubic-bezier(.2,.9,.25,1),visibility 0s .3s;color:var(--text,#f4f4f6);font-family:\'Space Grotesk\',system-ui,sans-serif}',
    '.cx.open{opacity:1;visibility:visible;transform:translate(-50%,-50%);transition:opacity .22s,transform .3s cubic-bezier(.2,.9,.25,1),visibility 0s}',
    '.cx-grip{display:none}',
    '.cx-face{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;border-radius:22px;background:linear-gradient(180deg,rgba(32,22,48,.995),rgba(13,13,18,.995) 46%);box-shadow:0 0 0 1px rgba(176,56,249,.4),0 30px 90px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.08)}',
    '.cx .pc-head{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:12px;padding:18px 18px 12px;overflow:hidden}',
    '.cx .pc-logo{position:absolute;right:-30px;top:-34px;opacity:.09;pointer-events:none;transform:rotate(-12deg)}',
    '.cx .pc-logo img{width:170px!important;height:170px!important;object-fit:contain}',
    '.cx .pc-hs .hs{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px rgba(176,56,249,.7),0 0 22px rgba(176,56,249,.35);background:var(--bg3,#1c1a26);overflow:hidden}',
    '.cx .pc-hs .cx-tl img{width:46px;height:46px;object-fit:contain}',
    '.cx .cx-ini{font:800 20px monospace;color:#d795ff}',
    '.cx .pc-id{min-width:0}.cx .pc-name{font-size:20px;font-weight:800;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cx .pc-id .sub{font-size:12px;color:var(--text3,#8b8798);margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
    '.cx .pc-id .sub .cx-lg{width:16px;height:16px;object-fit:contain}',
    '.cx .cx-tlink{color:var(--text2,#c9c6d4);text-decoration:underline;text-decoration-color:rgba(176,56,249,.5);text-underline-offset:2px;cursor:pointer}',
    '.cx .pc-rate{text-align:center;padding:6px 10px;border-radius:12px;background:linear-gradient(135deg,rgba(176,56,249,.28),rgba(99,91,255,.18));border:1px solid rgba(176,56,249,.45)}',
    '.cx .pc-rate b{display:block;font:800 22px monospace;color:#fff;line-height:1}.cx .pc-rate span{font:800 8px monospace;letter-spacing:.12em;color:#d795ff;white-space:nowrap}',
    '.cx .pc-x{width:36px;height:36px;border-radius:11px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.05);color:var(--text2,#c9c6d4);font-size:20px;cursor:pointer;align-self:start}',
    '.cx .pc-seg{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 18px;padding:4px;border-radius:14px;background:rgba(14,12,22,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--border2,#2c2a36)}',
    '.cx .pc-seg button{padding:9px 0;border:0;border-radius:10px;background:none;color:var(--text3,#8b8798);font:800 13px \'Space Grotesk\',system-ui,sans-serif;letter-spacing:.02em;cursor:pointer;transition:color .2s,background .2s}',
    '.cx .pc-seg button.on{background:linear-gradient(135deg,#b038f9,#635bff);color:#fff;box-shadow:0 4px 16px rgba(176,56,249,.35)}',
    '.cx .pc-seg i{font-style:normal;font:800 10px monospace;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.18);margin-left:4px}',
    '.cx .pc-body{padding:14px 18px 22px}',
    '.cx .pc-cta{width:100%;margin-top:16px;padding:14px;border-radius:14px;border:1px solid rgba(176,56,249,.5);cursor:pointer;background:linear-gradient(135deg,rgba(176,56,249,.22),rgba(99,91,255,.16));color:#fff;font:800 14px \'Space Grotesk\',system-ui,sans-serif}',
    '.cx .cx-cells{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:2px 0 4px}',
    '.cx .cx-cell{background:var(--bg2,#14131b);border:1px solid var(--border,#24222e);border-radius:14px;padding:12px 8px;text-align:center;cursor:pointer;transition:border-color .18s}',
    '.cx .cx-cell:hover{border-color:rgba(176,56,249,.45)}',
    '.cx .cx-cell .v{font:800 22px monospace}.cx .cx-cell .l{font:800 9px monospace;letter-spacing:.12em;color:#d795ff;margin-top:2px}.cx .cx-cell .s{font-size:11px;color:var(--text3,#8b8798);margin-top:5px}',
    '.cx .pk-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-family:monospace;font-size:12px;color:var(--text2,#c9c6d4)}.cx .pk-row b{color:var(--text,#f4f4f6)}',
    '.cx .cx-hdr{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:18px 0 8px}',
    '.cx .cx-hdr span{font:800 11px \'Space Grotesk\',system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--text2,#c9c6d4)}.cx .cx-hdr em{font-style:normal;font-size:11px;color:var(--text3,#8b8798);text-align:right}',
    '.cx .pdr-why{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:6px}',
    '.cx .pdr-why>div{background:var(--bg3,#1c1a26);border:1px solid var(--border2,#2c2a36);border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.cx .pdr-why span{font-family:monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3,#8b8798)}',
    '.cx .pdr-why b{font-size:17px;font-weight:800;color:var(--text,#f4f4f6);overflow-wrap:anywhere}',
    '.cx .pdr-why em{font-style:normal;font-size:11px;color:var(--text3,#8b8798);line-height:1.35}',
    '.cx .cx-tbl{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border,#24222e);border-radius:14px;background:var(--bg2,#14131b)}',
    '.cx .cx-tbl table{width:100%;border-collapse:collapse;min-width:0}',
    '.cx .cx-tbl th{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--text3,#8b8798);text-align:left;padding:7px 6px;border-bottom:1px solid var(--border,#24222e);white-space:nowrap}',
    '.cx .cx-tbl td{padding:7px 6px;border-bottom:1px solid var(--border,#24222e);white-space:nowrap;font-size:12px}',
    '.cx .cx-tbl th:first-child,.cx .cx-tbl td:first-child{padding-left:10px}.cx .cx-tbl th:last-child,.cx .cx-tbl td:last-child{padding-right:10px}',
    '.cx .cx-tbl tr:last-child td{border-bottom:none}',
    '.cx .cx-tbl .r{text-align:right}.cx .mono{font-family:monospace}.cx .dim{color:var(--text3,#8b8798)}',
    '.cx .cx-base td{border-top:1px solid var(--border2,#2c2a36);color:var(--text,#f4f4f6);font-weight:700}',
    '@media (max-width:420px){.cx .hm{display:none}.cx .cx-tbl th,.cx .cx-tbl td{padding:7px 4px;font-size:11px}.cx .cx-base td:first-child{white-space:normal;min-width:64px}.cx .cx-base .dim{display:block;font-size:9px;font-weight:600}}',
    '.cx .cx-note{font-size:11px;color:var(--text3,#8b8798);margin-top:8px;line-height:1.45}',
    '.cx .cx-empty{padding:24px;border:1px dashed var(--border2,#2c2a36);border-radius:12px;color:var(--text3,#8b8798);text-align:center;line-height:1.6}',
    '.cx .cx-tag{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;font-family:monospace}',
    '.cx .cx-tag.r{background:rgba(239,68,68,.12);color:#f87171}.cx .cx-tag.g{background:rgba(97,233,112,.12);color:#61e970}.cx .cx-tag.n{background:var(--bg4,#26232f);color:var(--text2,#c9c6d4)}',
    '.cx .cx-tagrow{margin:0 0 10px}',
    '.cx .cx-pos{color:#61e970!important}.cx .cx-neg{color:#f87171!important}',
    '.cx .cx-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.cx .cx-chip{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:7px 11px;border-radius:12px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.04);color:var(--text,#f4f4f6);cursor:pointer;text-align:left;max-width:100%}',
    '.cx .cx-chip b{font-size:12px}.cx .cx-chip span{font:600 10px monospace;color:var(--text3,#8b8798)}',
    '.cx .cx-chip:hover{border-color:rgba(176,56,249,.55)}',
    '.cx .cx-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.cx .cx-acts .cx-btn{flex:1;min-width:150px}',
    '.cx .cx-btn{padding:12px 14px;border-radius:12px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.05);color:var(--text,#f4f4f6);font:800 13px \'Space Grotesk\',system-ui,sans-serif;cursor:pointer}',
    '.cx .cx-btn.p,#cxSlip .cx-btn.p{background:linear-gradient(135deg,#b038f9,#635bff);border-color:transparent;color:#fff}',
    '.cx .cx-btn[disabled]{opacity:.4;cursor:not-allowed}',
    '.cx .cx-odds{padding:4px 8px;border-radius:8px;border:1px solid rgba(176,56,249,.45);background:rgba(176,56,249,.12);color:#fff;font:800 12px monospace;cursor:pointer}',
    '.cx .cx-add{width:28px;height:28px;border-radius:8px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.05);color:#d795ff;font:800 14px monospace;cursor:pointer}',
    '.cx .cx-sims .gc-sec{margin:14px 0 0;padding:0}',
    '.cx .cx-whyl{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.cx .cx-whyl span{font:600 10px monospace;color:var(--text2,#c9c6d4);background:var(--bg3,#1c1a26);border:1px solid var(--border2,#2c2a36);border-radius:6px;padding:3px 6px}',
    // bets (the NBA card's .bc-* look)
    '.cx .bc-best{width:100%;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:2px 10px;text-align:left;padding:11px 14px;margin-bottom:12px;border-radius:14px;cursor:pointer;border:1px solid rgba(176,56,249,.45);background:linear-gradient(135deg,rgba(176,56,249,.16),rgba(99,91,255,.1));color:var(--text,#f4f4f6)}',
    '.cx .bc-best .eb{grid-column:1;font:800 9px monospace;letter-spacing:.14em;text-transform:uppercase;color:#d795ff}',
    '.cx .bc-best .bt{grid-column:1;font-weight:800;font-size:15px}.cx .bc-best .bt em{font-style:normal;font-family:monospace;color:var(--text2,#c9c6d4);margin-left:6px}',
    '.cx .bc-best .bw{grid-column:1/3;font-size:10px;color:var(--text3,#8b8798);margin-top:3px}',
    '.cx .bc-best .bv{grid-column:2;grid-row:1/3;align-self:center;font:800 16px monospace;text-align:right}.cx .bc-best .bv small{display:block;font-size:9px;color:var(--text3,#8b8798);font-weight:700}',
    '.cx .bc-search{display:block;margin-bottom:10px}',
    '.cx .bc-search input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid var(--border2,#2c2a36);color:var(--text,#f4f4f6);font:500 14px \'Space Grotesk\',system-ui,sans-serif;outline:0}',
    '.cx .bc-mkts{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px;scrollbar-width:none}.cx .bc-mkts::-webkit-scrollbar{display:none}',
    '.cx .bc-mkts button{flex-shrink:0;padding:8px 12px;border-radius:999px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.04);color:var(--text2,#c9c6d4);font:700 12px \'Space Grotesk\',system-ui,sans-serif;cursor:pointer;white-space:nowrap}',
    '.cx .bc-mkts button span{font-family:monospace;color:#d795ff;margin-left:3px}',
    '.cx .bc-mkts button.on{background:linear-gradient(135deg,#b038f9,#635bff);color:#fff;border-color:transparent}.cx .bc-mkts button.on span{color:#fff}',
    '.cx .bc-main{background:rgba(255,255,255,.03);border:1px solid var(--border2,#2c2a36);border-radius:16px;padding:14px}',
    '.cx .bc-line{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.cx .bc-big{font-size:24px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}.cx .bc-big span{font-size:14px;color:var(--text3,#8b8798);font-weight:700}',
    '.cx .bc-side{display:inline-flex;margin-top:8px;padding:3px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--border2,#2c2a36)}',
    '.cx .bc-side button{padding:5px 14px;border-radius:999px;border:0;background:none;color:var(--text3,#8b8798);font:800 11px \'Space Grotesk\',system-ui,sans-serif;cursor:pointer}',
    '.cx .bc-side button.on{background:linear-gradient(135deg,#b038f9,#635bff);color:#fff}',
    '.cx .bc-price{font:800 22px monospace;text-align:right}.cx .bc-price span{display:block;font:700 9px monospace;letter-spacing:.12em;color:var(--text3,#8b8798);text-transform:uppercase}',
    '.cx .bc-price.ghost .na{font:800 13px monospace;font-style:normal;color:#d795ff}',
    '.cx .bc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0 10px}',
    '.cx .bc-stats div{background:var(--bg3,#1c1a26);border:1px solid var(--border2,#2c2a36);border-radius:10px;padding:8px;min-width:0}',
    '.cx .bc-stats span{display:block;font:700 9px monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--text3,#8b8798)}',
    '.cx .bc-stats b{font:800 15px monospace}',
    '@media (max-width:420px){.cx .bc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.cx .bc-note{font-size:11px;color:var(--text3,#8b8798);margin-top:8px;line-height:1.45}',
    '.cx .bc-acts{display:flex;gap:8px;margin-top:12px}.cx .bc-acts button{flex:1}',
    // best bets list (11/2): a row per market, the bet card opens under it
    '.cx .bc-best.none{cursor:default;background:rgba(255,255,255,.03);border-color:var(--border2,#2c2a36)}.cx .bc-best.none .bt{font-size:14px}',
    '.cx .cx-bbs{display:flex;flex-direction:column;gap:8px}',
    '.cx .cx-bb{border:1px solid var(--border,#24222e);border-radius:14px;background:var(--bg2,#14131b);overflow:hidden;transition:border-color .18s}',
    '.cx .cx-bb.open{border-color:rgba(176,56,249,.55);box-shadow:0 0 0 1px rgba(176,56,249,.2)}.cx .cx-bb.lo .cx-bbl b{color:var(--text2,#c9c6d4)}',
    '.cx .cx-bbr{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto 18px;align-items:center;gap:10px;padding:10px 12px;border:0;background:none;color:var(--text,#f4f4f6);text-align:left;cursor:pointer;font-family:inherit}',
    '.cx .cx-bbl{min-width:0;display:flex;flex-direction:column;gap:3px}.cx .cx-bbl b{font-size:14px;font-weight:800;line-height:1.25;overflow-wrap:anywhere}',
    '.cx .cx-bbl em{font-style:normal;font-size:11px;color:var(--text3,#8b8798);line-height:1.35}',
    '.cx .cx-bdg{align-self:flex-start;font:800 9px monospace;letter-spacing:.12em;text-transform:uppercase;padding:2px 7px;border-radius:999px}',
    '.cx .cx-bdg.pk{background:linear-gradient(135deg,#b038f9,#635bff);color:#fff}.cx .cx-bdg.pj{background:rgba(255,255,255,.06);color:var(--text3,#8b8798);border:1px solid var(--border2,#2c2a36)}',
    '.cx .cx-bbv{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:1px}.cx .cx-bbv b{font:800 15px monospace}.cx .cx-bbv em{font:800 12px monospace;font-style:normal}.cx .cx-bbv small{font:700 8px monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--text3,#8b8798)}',
    '.cx .cx-bbc{font:800 16px monospace;color:#d795ff;text-align:center}',
    '.cx .cx-bbp{padding:0 10px 10px}.cx .cx-bbp .bc-main{background:rgba(255,255,255,.025)}',
    '.cx .cx-more{width:100%;margin-top:10px}',
    '.cx .cx-rungs{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;margin-top:6px;scrollbar-width:none}.cx .cx-rungs::-webkit-scrollbar{display:none}',
    '.cx .cx-rungs button{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 11px;border-radius:10px;border:1px solid var(--border2,#2c2a36);background:rgba(255,255,255,.04);color:var(--text,#f4f4f6);cursor:pointer;font-family:inherit}',
    '.cx .cx-rungs button b{font:800 12px monospace}.cx .cx-rungs button span{font:700 10px monospace;color:var(--text3,#8b8798)}',
    '.cx .cx-rungs button.on{background:linear-gradient(135deg,#b038f9,#635bff);border-color:transparent}.cx .cx-rungs button.on span{color:#fff}.cx .cx-rungs button.near{border-color:#d795ff}',
    '@media (max-width:420px){.cx .cx-bbr{gap:8px;padding:9px 10px}.cx .cx-bbl b{font-size:13px}.cx .cx-bbp{padding:0 6px 8px}.cx .cx-bbp .bc-main{padding:10px}}',
    '.cx .cx-dist{margin:6px 0 4px;touch-action:none;cursor:ew-resize;user-select:none;-webkit-user-select:none}',
    '.cx .cx-bars{position:relative;height:74px;display:flex;align-items:flex-end;gap:2px;padding-top:16px}',
    '.cx .cx-bars i{flex:1;background:rgba(255,255,255,.12);border-radius:2px 2px 0 0;transition:background .15s}',
    '.cx .cx-bars i.ov{background:linear-gradient(180deg,#b038f9,#635bff)}.cx .cx-bars i.un{background:linear-gradient(180deg,#635bff,#3d37b3)}',
    '.cx .cx-mark{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 10px rgba(255,255,255,.7)}',
    '.cx .cx-mark span{position:absolute;top:-2px;left:50%;transform:translateX(-50%);font:800 10px monospace;background:#fff;color:#111;padding:1px 5px;border-radius:5px;white-space:nowrap}',
    '.cx .cx-mark.ghost{background:#d795ff}.cx .cx-mark.ghost span{background:#d795ff}',
    '.cx .cx-axis{display:flex;justify-content:space-between;font:700 9px monospace;color:var(--text3,#8b8798);margin-top:4px}',
    '.cx .cx-rail{position:relative;height:34px;margin:4px 0;touch-action:none;cursor:ew-resize;user-select:none;-webkit-user-select:none}',
    '.cx .cx-rail::before{content:"";position:absolute;left:0;right:0;top:14px;height:6px;border-radius:3px;background:rgba(255,255,255,.1)}',
    '.cx .cx-rail-fill{position:absolute;top:14px;height:6px;border-radius:3px;background:linear-gradient(90deg,#b038f9,#635bff)}',
    '.cx .cx-rail i{position:absolute;top:7px;width:2px;height:20px;margin-left:-1px;border-radius:1px;background:#d795ff;pointer-events:none}',
    '.cx .cx-thumb{position:absolute;top:4px;width:26px;height:26px;margin-left:-13px;border-radius:50%;background:#fff;border:3px solid #b038f9;box-shadow:0 2px 12px rgba(176,56,249,.6);pointer-events:none;z-index:2;box-sizing:border-box}',
    '.cx .cx-thumb.ghost{border-color:#d795ff;transform:scale(.85)}',
    '.cx .cx-rail input[type=range]{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:ew-resize}',
    '.cx .bc-main.snap .cx-thumb,.cx .bc-main.snap .cx-mark{transition:left .22s cubic-bezier(.2,.9,.25,1)}',
    // the light parlay slip (non-NBA pages)
    '#cxSlip{position:fixed;right:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:10060;font-family:\'Space Grotesk\',system-ui,sans-serif}',
    '#cxSlip .cx-slip-tab{padding:10px 14px;border-radius:999px;border:0;background:linear-gradient(135deg,#b038f9,#635bff);color:#fff;font:800 13px \'Space Grotesk\',system-ui,sans-serif;box-shadow:0 8px 24px rgba(176,56,249,.4);cursor:pointer}',
    '#cxSlip .cx-slip-tab b{background:rgba(255,255,255,.22);border-radius:999px;padding:1px 7px;margin-left:4px}#cxSlip .cx-slip-tab span{font-family:monospace;margin-left:6px}',
    '#cxSlip .cx-slip-body{display:none;position:absolute;right:0;bottom:48px;width:min(320px,calc(100vw - 28px));padding:12px;border-radius:16px;background:rgba(18,16,26,.98);border:1px solid rgba(176,56,249,.45);box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '#cxSlip .open .cx-slip-body{display:block}',
    '#cxSlip .cx-slip-leg{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:12px;color:#f4f4f6}',
    '#cxSlip .cx-slip-leg span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#cxSlip .cx-slip-leg em{font-style:normal;font-family:monospace}',
    '#cxSlip .cx-slip-leg button{border:0;background:none;color:#8b8798;font-size:16px;cursor:pointer}',
    '#cxSlip .cx-slip-ft{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#c9c6d4;flex-wrap:wrap}#cxSlip .cx-slip-ft span{flex:1}',
    '#cxSlip .cx-btn{padding:8px 12px;border-radius:10px;border:1px solid #2c2a36;background:rgba(255,255,255,.05);color:#f4f4f6;font:800 12px \'Space Grotesk\',system-ui,sans-serif;cursor:pointer}',
    '[data-oxt],[data-oxp]{cursor:pointer}',
    '@media (max-width:760px){',
    '  .cx{left:0;right:0;top:auto;bottom:0;width:100vw;height:calc(100vh - var(--sat,0px) - 14px);height:calc(100dvh - var(--sat,0px) - 14px);opacity:1;transform:translateY(105%);transition:transform .34s cubic-bezier(.2,.9,.25,1),visibility 0s .34s}',
    '  .cx.open{transform:none;transition:transform .34s cubic-bezier(.2,.9,.25,1),visibility 0s}',
    '  .cx-face{border-radius:24px 24px 0 0}',
    '  .cx-grip{display:block;position:absolute;top:7px;left:50%;z-index:5;width:40px;height:5px;margin-left:-20px;border-radius:3px;background:rgba(255,255,255,.28);pointer-events:none}',
    '  .cx .pc-head{padding:22px 14px 10px;gap:10px}.cx .pc-seg{margin:0 14px}.cx .pc-body{padding:14px 14px calc(22px + env(safe-area-inset-bottom))}',
    '  .cx .pc-hs .hs{width:54px;height:54px}.cx .pc-hs .cx-tl img{width:38px;height:38px}.cx .pc-name{font-size:18px}.cx .pc-rate b{font-size:19px}',
    '}',
    '@media (max-width:400px){.cx .cx-cells{gap:6px}.cx .cx-cell{padding:10px 4px}.cx .cx-cell .v{font-size:19px}}'
  ].join('\n');
  window.OXC = {team: openTeam, player: openPlayer, close: close, isPick: function (sel) { return isPick(sel); }, _state: function () { return CX; },
    // the gates (tools/verify_sports.js, verify_nba.js): the open card's ranked rows
    _rows: function () { return curRows().map(function (r) { return {key: r.key, rank: r.rank, ev: r.ev, dist: !!r.m.dist, player: !!r.who, nba: !!r.nba, pick: r.pick, lab: rowLab(r)}; }); }};
  setTimeout(loadPicks, 2500);   // the Onyx Pick badges (nba.html's own bet card reads OXC.isPick too)
  drawSlip();
})();
