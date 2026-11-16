// saved.js - "Save" a pick on this device, follow it live in My Onyx (home.html), and get
// a pop-up the moment it wins, on whatever Onyx page is open.
// One localStorage list (onyxSaved) shared by every page on this origin. A pick:
//   {id: Onyx selection id, sport, label, matchup, start, gid, team, price, conf,
//    kind: prop|spread|total|ml, mkt (pts, rec, rush_yds, q1_total...), side, line,
//    hcap (spread), name (player or team), saved: ISO time}
// Pages call OnyxSaved.btn(pick) for the star button; home.html reads OnyxSaved.all().
//
// Saving, made better (11/16): a save opens a small sheet (openSheet) with Undo, "the odds I got" (my_price), a stake
// in units (stake), an optional note (#tags) and where it is kept (syncState); removing has an Undo toast; every star
// for one pick repaints together; saveSlip() saves the whole parlay slip as one ticket. A pick leaving My picks 24 hours
// after its start stays in the history, graded: the Settled list on My Season (season.html), which counts units at
// your own price and stake (unitsOf).
//
// Win alerts (11/1, the Onyx Baseball home-run alert, for every saved pick): every 45 s
// while a page is open, each saved pick whose game has started is checked against ESPN's
// live scoreboard and box score (OnyxSaved.track, the same rules My picks uses). When one
// wins (a prop's over clears the line, an under or a game line goes final on the right
// side) a celebration pop-up opens once, on any page, and with alerts turned on (the More
// menu, or "Alert me" after saving) a phone notification fires too. Alerts reach the
// phone while the app is open or in the background; a fully closed app needs push (OneSignal),
// as on Onyx Baseball.
// a sign-in link that landed on a page other than My Onyx: carry it there (see ui.js)
(function () { try { if (/(^|[#&])(access_token|error_description|error_code)=/.test(location.hash) && !/(home|account)\.html$/.test(location.pathname)) location.replace(location.pathname.replace(/[^\/]*$/, '') + 'account.html' + location.hash); } catch (e) {} })();
// optional accounts (accounts.js): sign-in and cross-device sync, off until accounts.json is filled in
(function () { try { if (!document.querySelector('script[src="accounts.js"]')) { var a = document.createElement('script'); a.src = 'accounts.js'; a.defer = true; document.head.appendChild(a); } } catch (e) {} })();
(function () {
  var KEY = 'onyxSaved', KEEP_H = 24, REG = [];
  var SHOWN = 'onyxWinShown', ALERTS = 'onyxWinAlerts', REFERRER = 'KR680261';
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
  var LG = {nfl: {path: 'football/nfl', page: 'nfl.html'}, nba: {path: 'basketball/nba', page: 'nba.html'},
    nhl: {path: 'hockey/nhl', page: 'nhl.html'}, cfb: {path: 'football/college-football', page: 'cfb.html', q: 'groups=80&limit=300'},
    cbb: {path: 'basketball/mens-college-basketball', page: 'cbb.html', q: 'groups=50&limit=400'},
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
    // a pick leaving My picks never leaves without a trace: it is in the history (the Settled list, My Season)
    if (keep.length !== a.length) { a.forEach(function (p) { if (keep.indexOf(p) < 0) record(p); }); write(keep); }
    return keep;
  }
  // a play with no Onyx selection id (11/8: Onyx's feed is down, every play is on the market line and none has one,
  // so no star showed anywhere): a stable key from the game, market, player, side and line. Tracking reads the game
  // and the stats, never the id, so these follow live and grade like any other pick.
  function withId(p) {
    if (!p || p.id) return p;
    var k = [p.sport, p.gid || p.matchup, p.kind, p.mkt, p.name || p.team, p.side, p.line, p.hcap].map(function (x) { return x == null ? '' : String(x); }).join('|');
    if (!p.label || k.replace(/\|/g, '') === '') return p;
    return Object.assign({}, p, {id: 'k:' + k.toLowerCase().replace(/\s+/g, '_')});
  }
  function has(id) { return !!id && read().some(function (p) { return p.id === id; }); }
  function remove(id) { write(read().filter(function (p) { return p.id !== id; })); unrecord(id); }

  // ── the permanent pick history (onyxHistory): every pick saved, graded when its game ends.
  // Kept on this device for good (the newest 2,000), synced to the account when signed in
  // (accounts.js), and never cleared by the 24-hour clean-up of the saved list. A pick taken back
  // before its game starts leaves the history; after the start it stays (that pick was ridden).
  var HKEY = 'onyxHistory', HMAX = 2000;
  // what the person adds to a pick (11/16): the odds they got, their stake in units, a note (#tags in it become tags).
  // 'edited' (ms) lets accounts.js send a later edit to the account and take a newer one from another device.
  var USER = ['my_price', 'stake', 'note', 'tags', 'edited'];
  function history() { var a = lsGet(HKEY, []); return Array.isArray(a) ? a : []; }
  function hWrite(a) { lsSet(HKEY, a.slice(-HMAX)); try { dispatchEvent(new Event('onyx-history')); } catch (e) {} }
  function record(p) {
    if (!p || !p.id) return;
    var a = history();
    if (a.some(function (h) { return h.id === p.id; })) return;
    var keep = ['id', 'sport', 'label', 'matchup', 'start', 'gid', 'team', 'price', 'conf', 'kind', 'mkt', 'side', 'line', 'hcap', 'name', 'saved', 'legs'].concat(USER);
    var h = {}; keep.forEach(function (k) { if (p[k] != null) h[k] = p[k]; });
    h.saved = h.saved || new Date().toISOString(); h.res = null;
    a.push(h); hWrite(a);
  }
  function unrecord(id) {
    var a = history(), h = a.filter(function (x) { return x.id === id; })[0];
    if (!h || h.res) return;
    var s = Date.parse(h.start);
    if (isNaN(s) || s > Date.now()) hWrite(a.filter(function (x) { return x.id !== id; }));
  }
  // grade what has finished: picks started 2.5+ hours ago (or reported final), up to 10 days back
  var grading = false;
  function grade() {
    if (grading) return Promise.resolve();
    var now = Date.now(), due = history().filter(function (h) {
      var s = Date.parse(h.start); return !h.res && !isNaN(s) && s < now - 30 * 60e3 && now - s < 10 * 864e5;
    }).slice(-25);
    if (!due.length) return Promise.resolve();
    grading = true;
    return Promise.all(due.map(function (h) { return track(h).catch(function () { return {p: h}; }); })).then(function (T) {
      var by = {}; T.forEach(function (t) { if (t.res === 'W' || t.res === 'L' || t.res === 'P') by[t.p.id] = t; });
      if (!Object.keys(by).length) return;
      var a = history().map(function (h) {
        var t = by[h.id]; if (!t || h.res) return h;
        return Object.assign({}, h, {res: t.res, final: t.cur, graded: new Date().toISOString()});
      });
      hWrite(a);
    }).then(function () { grading = false; }, function () { grading = false; });
  }
  // a pick graded "W" early (an over that cleared) is final; everything else waits for the final whistle
  // ── parlays as one ticket (11/8, Jordan: "save picks to our account including the parlay builder so we know exactly
  // how we're tracking"): {kind: 'parlay', legs: [...]}, kept in My picks and the history like any pick (so it syncs to
  // the account), graded by its legs: any leg lost is a loss, every leg won (pushes drop out) is a win.
  var LEGKEEP = ['id', 'sport', 'label', 'matchup', 'start', 'gid', 'team', 'price', 'conf', 'kind', 'mkt', 'side', 'line', 'hcap', 'name'];
  function ticket(legs, o) {
    o = o || {};
    legs = (legs || []).map(withId).filter(function (x) { return x && x.id; }).map(function (x) { var l = {}; LEGKEEP.forEach(function (k) { if (x[k] != null) l[k] = x[k]; }); return l; });
    if (legs.length < 2) return null;
    var ids = legs.map(function (l) { return l.id; }).sort().join(','), h = 0;
    for (var i = 0; i < ids.length; i++) h = (h * 31 + ids.charCodeAt(i)) >>> 0;
    var sps = legs.map(function (l) { return l.sport; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    var starts = legs.map(function (l) { return Date.parse(l.start); }).filter(function (x) { return !isNaN(x); });
    var prob = legs.reduce(function (m, l) { return l.conf != null && m != null ? m * l.conf : null; }, 1);
    return {id: 't:' + h.toString(36) + ':' + legs.length, kind: 'parlay', legs: legs, label: o.label || legs.length + '-leg parlay',
            sport: sps.length === 1 ? sps[0] : 'multi', matchup: o.matchup || legs.map(function (l) { return l.label; }).join(' + '),
            start: starts.length ? new Date(Math.min.apply(null, starts)).toISOString() : null, price: o.price != null ? o.price : null, conf: prob};
  }
  function saveTicket(legs, o) {
    var t = ticket(legs, o); if (!t) return null;
    if (has(t.id)) { toast('This parlay is already in My picks'); return t; }
    var meta = {};
    if (o && o.my_price != null && o.my_price !== '') meta.my_price = o.my_price;
    if (o && o.stake != null && o.stake !== '') meta.stake = o.stake;
    toggle(t, {meta: meta, quiet: !!(o && o.quiet)});
    return t;
  }
  // the odds you actually got: your record and units use them (11/8)
  function cleanPrice(price) {
    price = price == null || price === '' ? null : Math.round(+String(price).trim().replace(/^\+/, ''));
    if (price != null && (isNaN(price) || (price > -100 && price < 100))) return undefined;
    return price;
  }
  function setMyPrice(id, price) {
    price = cleanPrice(price);
    if (price === undefined) return false;
    return setMeta(id, {my_price: price});
  }
  // what the person adds to a saved pick, on both lists: {my_price, stake (units, above 0 up to 100), note}
  function setMeta(id, patch) {
    var o = {};
    if ('my_price' in patch) { var pr = cleanPrice(patch.my_price); if (pr === undefined) return false; o.my_price = pr; }
    if ('stake' in patch) {
      var st = patch.stake == null || patch.stake === '' ? null : Math.round(+patch.stake * 100) / 100;
      if (st != null && (isNaN(st) || st <= 0 || st > 100)) return false;
      o.stake = st;
    }
    if ('note' in patch) {
      var n = String(patch.note || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      var tg = (n.match(/#[A-Za-z0-9_]{1,24}/g) || []).map(function (t) { return t.slice(1).toLowerCase(); }).filter(function (t, i, a) { return a.indexOf(t) === i; });
      o.note = n || null; o.tags = tg.length ? tg : null;
    }
    o.edited = Date.now();
    var fix = function (p) {
      if (p.id !== id) return p;
      var q = Object.assign({}, p, o); Object.keys(o).forEach(function (k) { if (q[k] == null) delete q[k]; }); return q;
    };
    write(read().map(fix));
    hWrite(history().map(fix));
    return true;
  }
  function find(id) { return read().filter(function (p) { return p.id === id; })[0] || history().filter(function (h) { return h.id === id; })[0] || null; }
  // units won or lost on a graded pick: your stake (1 unit unless you set one) at the odds you got (else the Onyx price
  // when saved; no price at all counts even money). A push is 0 and is not risked.
  function stakeOf(h) { return +h.stake > 0 ? +h.stake : 1; }
  function priceOf(h) { var v = h.my_price != null ? +h.my_price : h.price != null ? +h.price : null; return v == null || isNaN(v) ? null : v; }
  function unitsOf(h) {
    var s = stakeOf(h), pr = priceOf(h);
    if (h.res === 'W') return s * (pr == null ? 1 : pr > 0 ? pr / 100 : 100 / -pr);
    if (h.res === 'L') return -s;
    return 0;
  }
  // graded picks, newest first (the Settled list); days = how far back (none = all)
  function settled(days) {
    var now = Date.now();
    return history().filter(function (h) {
      if (!h.res) return false;
      var t = Date.parse(h.start || h.saved);
      return !days || isNaN(t) || now - t < days * 864e5;
    }).sort(function (a, b) { return (Date.parse(b.start || b.saved) || 0) - (Date.parse(a.start || a.saved) || 0); });
  }
  // the whole parlay slip (parlay.js) as one saved ticket, in one tap
  function saveSlip(o) {
    o = o || {};
    var slip = [];
    try { slip = window.OnyxParlay && OnyxParlay.slip ? OnyxParlay.slip() : (JSON.parse(localStorage.getItem('onyxSlipAll') || '[]') || []); } catch (e) { slip = []; }
    if (slip.length < 2) { toast(slip.length ? 'Add one more leg to save a parlay' : 'Your parlay slip is empty'); return null; }
    var ok = function (v) { return v != null && v !== '' && !isNaN(+v) && (+v >= 100 || +v <= -100); };
    var d = slip.every(function (x) { return ok(x.price); }) ? slip.reduce(function (m, x) { return m * decOf(x.price); }, 1) : null;
    var my = o.my_price;
    if (!ok(my) && slip.some(function (x) { return ok(x.my); })) {
      var dm = slip.every(function (x) { return ok(x.my) || ok(x.price); }) ? slip.reduce(function (m, x) { return m * decOf(ok(x.my) ? x.my : x.price); }, 1) : null;
      if (dm) my = amOf(dm);
    }
    return saveTicket(slip, {price: o.price != null ? o.price : d ? amOf(d) : null, label: o.label, my_price: ok(my) ? my : null, stake: o.stake});
  }
  // where saved picks are kept, in words (the save sheet, My picks, My Season)
  function syncState() {
    var A = window.OnyxAccounts, st = null;
    try { st = A && A.state ? A.state() : null; } catch (e) {}
    if (!st || !st.enabled) return {on: false, signedIn: false, text: 'Saved on this device'};
    if (!st.signedIn) return {on: true, signedIn: false, text: 'On this device only'};
    if (st.error) return {on: true, signedIn: true, bad: true, text: st.error};
    if (st.syncing || !st.last) return {on: true, signedIn: true, text: 'Syncing to your account...'};
    var ago = Math.max(0, Math.round((Date.now() - st.last) / 60000));
    return {on: true, signedIn: true, ok: true, text: 'Synced to your account ' + (ago < 1 ? 'just now' : ago + ' min ago')};
  }
  // value of a price against our chance (11/8: "a tool where we enter the odds and you give us the value")
  function value(prob, price) {
    price = +price; if (!prob || isNaN(price) || (price > -100 && price < 100)) return null;
    var dec = price > 0 ? 1 + price / 100 : 1 + 100 / -price, imp = 1 / dec, ev = prob * (dec - 1) - (1 - prob);
    var fair = prob >= 0.5 ? -Math.round(100 * prob / (1 - prob)) : Math.round(100 * (1 - prob) / prob);
    return {prob: prob, implied: imp, edge: prob - imp, ev100: Math.round(ev * 1000) / 10, fair: fair,
            kelly: ev > 0 ? Math.round(ev / (dec - 1) * 1000) / 10 : 0, good: ev > 0};
  }
  // a parlay's value from the odds (11/8, Jordan: "you can't just add up the percentages, we need actual value
  // based on the odds"): each leg's value is our chance times its decimal odds (x1.00 is break-even), and the
  // ticket's value is those multiplied: our chance all hit times the combined payout. legs: [{prob, price}],
  // price = the odds taken on that leg; total (optional) = the ticket's own price when the book quotes one
  // (a same-game ticket is not the legs multiplied)
  function amOf(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function decOf(p) { p = +p; return p > 0 ? 1 + p / 100 : 1 + 100 / -p; }
  function parlayValue(legs, total) {
    if (!legs || !legs.length || legs.some(function (l) { return !l.prob || l.price == null || isNaN(+l.price) || (+l.price > -100 && +l.price < 100); })) return null;
    var L = legs.map(function (l) {
      var d = decOf(l.price), m = l.prob * d;
      return {prob: l.prob, price: +l.price, dec: d, implied: 1 / d, fair: amOf(1 / l.prob), mult: m, ev100: Math.round((m - 1) * 1000) / 10, good: m > 1};
    });
    var dec = L.reduce(function (a, l) { return a * l.dec; }, 1), prob = L.reduce(function (a, l) { return a * l.prob; }, 1);
    var t = total != null && total !== '' && !isNaN(+total) && (+total >= 100 || +total <= -100) ? +total : null;
    if (t != null) dec = decOf(t);
    var m = prob * dec;
    return {legs: L, prob: prob, dec: dec, price: amOf(dec), implied: 1 / dec, fairDec: 1 / prob, fair: amOf(1 / prob),
            mult: m, ev100: Math.round((m - 1) * 1000) / 10, good: m > 1, quoted: t != null,
            kelly: m > 1 ? Math.round((m - 1) / (dec - 1) * 1000) / 10 : 0};
  }
  function stats(a) {
    a = a || history();
    var g = a.filter(function (h) { return h.res; }), w = 0, l = 0, p = 0, units = 0, risked = 0, by = {};
    g.forEach(function (h) {
      var s = by[h.sport] = by[h.sport] || {w: 0, l: 0, p: 0, units: 0};
      var u = unitsOf(h);                    // the odds you got and your stake, when you entered them (11/8, 11/16)
      units += u; s.units += u;
      if (h.res === 'W') { w++; s.w++; } else if (h.res === 'L') { l++; s.l++; } else { p++; s.p++; }
      if (h.res !== 'P') risked += stakeOf(h);
    });
    return {picks: a.length, graded: g.length, pending: a.length - g.length, w: w, l: l, p: p, units: Math.round(units * 100) / 100,
            roi: risked ? Math.round(units / risked * 1000) / 10 : null, rate: w + l ? Math.round(w / (w + l) * 1000) / 10 : null, by: by};
  }
  function toast(msg, opts) { if (window.OX_TOAST) { try { window.OX_TOAST(msg, opts || {}); return; } catch (e) {} } }
  function alertsOn() { return lsGet(ALERTS, 0) === 1 && typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
  function canAsk() { return typeof Notification !== 'undefined' && Notification.permission !== 'denied'; }
  // o: {quiet: no sheet or toast, meta: {my_price, stake, note} set right away}
  function toggle(p, o) {
    o = o || {};
    p = withId(p);
    if (!p || !p.id) return false;
    if (has(p.id)) {
      var gone = read().filter(function (x) { return x.id === p.id; })[0];
      remove(p.id);
      if (!o.quiet) toast('Removed from My picks', {rm: true, ms: 5000, action: 'Undo', onAction: function () { restore(gone); }});
      return false;
    }
    var a = read(), sp = Object.assign({}, p, {saved: new Date().toISOString()}); a.push(sp); write(a); record(sp);
    if (o.meta && Object.keys(o.meta).length) setMeta(sp.id, o.meta);
    if (!o.quiet) openSheet(find(sp.id) || sp);
    try { if (window.gtag) gtag('event', 'pick_save', {sport: p.sport}); } catch (e) {}
    setTimeout(watch, 1500);
    return true;
  }
  // Undo after a removal: the pick comes back as it was (its odds, stake and note too)
  function restore(p) {
    if (!p || has(p.id)) return;
    var a = read(); a.push(p); write(a); record(p);
    var h = history(), i = -1; h.forEach(function (x, k) { if (x.id === p.id) i = k; });
    if (i >= 0 && USER.some(function (k) { return p[k] != null && h[i][k] == null; })) { USER.forEach(function (k) { if (p[k] != null) h[i][k] = p[k]; }); hWrite(h); }
    toast('Back in My picks');
  }
  // Undo right after a save: gone from My picks and from the history (it was never ridden)
  function undoSave(id) {
    write(read().filter(function (p) { return p.id !== id; }));
    hWrite(history().filter(function (h) { return !(h.id === id && !h.res); }));
    toast('Not saved', {rm: true});
  }
  // remove with an Undo toast (My picks' ×)
  function drop(id) { var p = read().filter(function (x) { return x.id === id; })[0]; if (p) toggle(p); }
  function paint(el, on) {
    el.classList.toggle('on', on); el.innerHTML = on ? '★' : '☆';
    el.setAttribute('aria-label', on ? 'Saved' : 'Save pick'); el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.title = on ? 'Saved to My picks. Tap to remove' : 'Save this pick and follow it live';
  }
  function tap(el, i) {
    var on = toggle(REG[i]);
    paint(el, on);
    if (on) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }
  function btn(p) {
    p = withId(p);
    if (!p || !p.id) return '';
    var i = REG.push(p) - 1, on = has(p.id);
    return '<button type="button" class="ox-save' + (on ? ' on' : '') + '" data-oxid="' + esc(p.id) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Saved' : 'Save pick') + '" title="' +
      (on ? 'Saved to My picks. Tap to remove' : 'Save this pick and follow it live') + '" ' +
      'onclick="event.stopPropagation();event.preventDefault();OnyxSaved.tap(this,' + i + ')">' + (on ? '★' : '☆') + '</button>';
  }
  // every star for one pick shows the same state wherever it was saved or removed (the Top 10, Ask and My picks can
  // all show the same play)
  function repaint() {
    try {
      var ids = {}; read().forEach(function (p) { ids[p.id] = 1; });
      document.querySelectorAll('.ox-save[data-oxid]').forEach(function (b) { var on = !!ids[b.getAttribute('data-oxid')]; if (b.classList.contains('on') !== on) paint(b, on); });
    } catch (e) {}
  }
  addEventListener('onyx-saved', function () { setTimeout(repaint, 0); });
  addEventListener('storage', function (e) { if (e.key === KEY) { repaint(); try { dispatchEvent(new Event('onyx-saved')); } catch (x) {} } });

  // ── right after a save (11/16, Jordan: "make the entirety of the pick saving better"): a small sheet at the bottom
  // with Undo, the odds you got, your stake in units, an optional note, and where it is kept (this device or the
  // account). It never blocks the page and closes itself unless you are using it.
  var SH = null, SHT = null, STAKES = [0.5, 1, 2, 3, 5];
  function closeSheet() {
    clearTimeout(SHT);
    if (!SH) return;
    var s = SH; SH = null; s.classList.remove('open');
    setTimeout(function () { try { s.remove(); } catch (e) {} }, 220);
  }
  function armClose(ms) { clearTimeout(SHT); SHT = setTimeout(function () { if (SH && !SH.contains(document.activeElement) && !SH._hold) closeSheet(); else if (SH) armClose(3000); }, ms || 7000); }
  function openSheet(p) {
    if (!p || !document.body) return;
    closeSheet();
    var cur = find(p.id) || p, sy = syncState(), st = stakeOf(cur);
    var s = document.createElement('div');
    s.className = 'oxsv'; s.setAttribute('role', 'dialog'); s.setAttribute('aria-label', 'Saved to My picks');
    s.innerHTML = '<div class="oxsv-h"><span class="oxsv-ic" aria-hidden="true">★</span><div class="oxsv-t"><b>Saved to My picks</b><span>' + esc(cur.label || cur.name || '') +
        (cur.price != null ? ' · Onyx ' + esc(odds(cur.price)) : '') + '</span></div>' +
        '<button type="button" class="oxsv-undo" data-oxsv="undo">Undo</button><button type="button" class="oxsv-x" data-oxsv="x" aria-label="Close">×</button></div>' +
      '<div class="oxsv-row"><label>Odds you got<input data-oxsv="price" inputmode="text" autocomplete="off" enterkeyhint="done" placeholder="' + esc(cur.price != null ? odds(cur.price) : '-110') + '" value="' + esc(cur.my_price != null ? odds(cur.my_price) : '') + '"></label>' +
        '<div class="oxsv-u" role="group" aria-label="Units"><span>Units</span>' + STAKES.map(function (u) { return '<button type="button" data-oxsv-u="' + u + '"' + (u === st ? ' class="on"' : '') + '>' + u + '</button>'; }).join('') + '</div></div>' +
      '<div class="oxsv-n"><input data-oxsv="note" maxlength="140" autocomplete="off" enterkeyhint="done" placeholder="Note (optional, #tags work)" value="' + esc(cur.note || '') + '"></div>' +
      '<div class="oxsv-f"><span class="oxsv-sy' + (sy.ok ? ' ok' : sy.bad ? ' bad' : '') + '">' + esc(sy.text) + (sy.on && !sy.signedIn ? ' · <a href="account.html">Sign in to sync</a>' : '') + '</span>' +
        (!alertsOn() && canAsk() ? '<button type="button" class="oxsv-l" data-oxsv="alert">Alert me when it wins</button>' : '') +
        '<a class="oxsv-l" href="home.html#my">My picks</a></div>';
    document.body.appendChild(s); SH = s;
    requestAnimationFrame(function () { s.classList.add('open'); });
    var id = cur.id, msg = function (t, bad) { var e = s.querySelector('.oxsv-sy'); if (e) { e.className = 'oxsv-sy ' + (bad ? 'bad' : 'ok'); e.textContent = t; } };
    s.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-oxsv],[data-oxsv-u]') : null; if (!b || b.tagName === 'INPUT') return;
      var a = b.getAttribute('data-oxsv'), u = b.getAttribute('data-oxsv-u');
      if (u) {
        if (setMeta(id, {stake: +u})) { s.querySelectorAll('[data-oxsv-u]').forEach(function (x) { x.classList.toggle('on', x === b); }); msg(u + (u === '1' ? ' unit' : ' units') + ' on it. My Season counts it'); }
        armClose(9000);
      } else if (a === 'undo') { closeSheet(); undoSave(id); }
      else if (a === 'x') closeSheet();
      else if (a === 'alert') { setAlerts(true); b.remove(); }
    });
    var pin = s.querySelector('[data-oxsv="price"]'), nin = s.querySelector('[data-oxsv="note"]');
    var savePrice = function () {
      var v = String(pin.value || '').trim();
      if (setMyPrice(id, v)) { pin.classList.remove('bad'); if (v) msg('Your odds ' + odds(cleanPrice(v)) + ' saved. Your record uses them'); }
      else { pin.classList.add('bad'); msg('Odds look like -110 or +150', true); }
    };
    var saveNote = function () { setMeta(id, {note: nin.value}); msg(nin.value.trim() ? 'Note saved' : 'Note cleared'); };
    pin.addEventListener('change', savePrice);
    nin.addEventListener('change', saveNote);
    [pin, nin].forEach(function (inp) { inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { inp.blur(); armClose(2500); } }); });
    s.addEventListener('focusout', function () { armClose(5000); });
    s.addEventListener('pointerenter', function () { s._hold = true; });
    s.addEventListener('pointerleave', function () { s._hold = false; armClose(4000); });
    armClose(8000);
  }

  // ── live tracking off ESPN (the rules home.html's My picks uses) ──────────
  var SB = {}, SUM = {}, TN = {t: 0, c: []};
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
  function getJSON(u) { return fetch(u).then(function (r) { return r.json(); }); }
  // the game's ET calendar day (ESPN's scoreboard date), so a pick from an earlier day still grades
  function etDay(start) {
    var t = Date.parse(start); if (isNaN(t)) return '';
    try { return new Date(t).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}).replace(/-/g, ''); } catch (e) { return ''; }
  }
  function scoreboard(k, day) {
    var L = LG[k], key = k + (day || ''), s = SB[key];
    if (s && (s.done || Date.now() - s.t < 30e3)) return Promise.resolve(s.ev);
    var qs = [L.q, day ? 'dates=' + day : ''].filter(Boolean).join('&');
    return getJSON(ESPN + L.path + '/scoreboard' + (qs ? '?' + qs : '')).then(function (j) {
      var ev = (j.events || []).map(function (e) {
        var c = (e.competitions || [{}])[0], st = (e.status || {}).type || {}, t = {};
        (c.competitors || []).forEach(function (x) { t[x.homeAway] = x; });
        var T = function (x) { return {ab: ((x || {}).team || {}).abbreviation, sc: (x || {}).score}; };
        return {id: e.id, state: st.state, detail: st.shortDetail || st.detail, a: T(t.away), h: T(t.home)};
      });
      SB[key] = {t: Date.now(), ev: ev, done: !!day && day < etDay(new Date().toISOString()) && ev.every(function (x) { return x.state === 'post'; })};
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
    if (p.kind === 'parlay' && (p.legs || []).length) {
      return Promise.all(p.legs.map(function (l) { return track(l).catch(function () { return {p: l, state: 'pre', res: null}; }); })).then(function (T) {
        var won = T.filter(function (t) { return t.res === 'W'; }).length, lost = T.some(function (t) { return t.res === 'L'; });
        var pushed = T.filter(function (t) { return t.res === 'P'; }).length, done = T.every(function (t) { return t.res === 'W' || t.res === 'L' || t.res === 'P'; });
        var state = T.some(function (t) { return t.state === 'in'; }) ? 'in' : T.every(function (t) { return t.state === 'post' || t.res === 'W' || t.res === 'L' || t.res === 'P'; }) ? 'post' : T.some(function (t) { return t.state !== 'pre'; }) ? 'in' : 'pre';
        var res = lost ? 'L' : done ? (pushed === T.length ? 'P' : 'W') : T.some(function (t) { return t.res === 'down'; }) ? 'down' : won || T.some(function (t) { return t.res === 'up'; }) ? 'up' : null;
        return {p: p, state: state, res: res, cur: won + ' of ' + T.length + ' won' + (pushed ? ', ' + pushed + ' push' : ''), legs: T};
      });
    }
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
    var today = etDay(new Date().toISOString()), day = etDay(p.start);
    return scoreboard(p.sport, day && day < today ? day : '').then(function (E) {
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
    if (p.kind === 'parlay') return String(t.cur);
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
      '<div class="oxw-row"><a href="' + esc(t.gid && p.sport !== 'nba' && p.sport !== 'mlb' ? page + '#games:' + t.gid : page) + '">Open the game</a><a href="home.html#my" class="oxw-my">My picks</a>' +
      (window.OnyxShare || navigator.share ? '<button class="oxw-sh">Share</button>' : '') + '</div></div>';
    document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add('open'); });
    try { if (navigator.vibrate) navigator.vibrate([60, 40, 120]); } catch (e) {}
    var close = function () {
      back.classList.remove('open');
      setTimeout(function () { back.remove(); open = false; if (queue.length) celebrate(queue.shift()); }, 220);
    };
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('.oxw-x').addEventListener('click', close);
    // My picks: the shared tracker (ui.js) on whatever page this is
    back.querySelector('.oxw-my').addEventListener('click', function (e) { if (window.OnyxUI && OnyxUI.openPicks) { e.preventDefault(); close(); OnyxUI.openPicks(); } });
    var sh = back.querySelector('.oxw-sh');
    if (sh) sh.addEventListener('click', function () {
      // the branded CASHED card (onyx-share.js, 11/16), else the plain share
      if (window.OnyxShare && OnyxShare.open) { try { close(); OnyxShare.open({kind: 'cashed', price: p.price, chance: p.conf, sels: p.id && !/^[kt]:/.test(p.id) ? [p.id] : [],
        legs: (p.legs || [p]).map(function (l) { return {label: l.label, matchup: l.matchup, price: l.price, conf: l.conf, sport: l.sport, res: 'W'}; })}); return; } catch (e) {} }
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
    // the saved picks from before the history existed join it
    all().forEach(record);
    timer = setInterval(function () { watch(); grade(); }, 45e3);
    setTimeout(function () { watch(); grade(); }, 2500);
  }
  addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(watch, 800); });

  var css = '.ox-save.pop{animation:oxsPop .42s cubic-bezier(.2,1.6,.4,1)}@keyframes oxsPop{0%{transform:scale(.6)}60%{transform:scale(1.18)}100%{transform:scale(1)}}' +
    // the save sheet: above the bottom bar on a phone, bottom centre on a desktop
    '.oxsv{position:fixed;left:50%;bottom:calc(86px + env(safe-area-inset-bottom,0px));z-index:10150;width:min(420px,calc(100vw - 24px));box-sizing:border-box;transform:translate(-50%,16px);opacity:0;transition:transform .22s,opacity .22s;' +
    'background:#151318;border:1.5px solid rgba(176,56,249,.55);border-radius:16px;padding:12px;box-shadow:0 12px 36px rgba(0,0,0,.6);color:#fff;font-family:"Space Grotesk",system-ui,sans-serif}' +
    '.oxsv.open{transform:translate(-50%,0);opacity:1}@media (min-width:1025px){.oxsv{bottom:18px}}' +
    '.oxsv-h{display:flex;align-items:center;gap:10px}.oxsv-ic{width:30px;height:30px;flex:none;border-radius:999px;background:rgba(176,56,249,.25);border:1px solid rgba(176,56,249,.7);display:flex;align-items:center;justify-content:center;color:#fff}' +
    '.oxsv-t{flex:1;min-width:0}.oxsv-t b{display:block;font-size:14px}.oxsv-t span{display:block;font:600 11px monospace;color:#b9b2c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.oxsv-undo{flex:none;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:#fff;font:800 12px monospace;border-radius:999px;padding:8px 12px;cursor:pointer;min-height:36px}' +
    '.oxsv-x{flex:none;background:none;border:0;color:#8a8399;font-size:22px;cursor:pointer;padding:2px 6px;min-height:36px}' +
    '.oxsv-row{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin-top:10px}' +
    '.oxsv-row label{display:flex;align-items:center;gap:6px;font:700 11px monospace;color:#9a93a6}' +
    '.oxsv input{background:#0d0a12;border:1px solid #3a2a55;border-radius:9px;padding:8px 9px;color:#fff;font:700 16px monospace;min-height:36px;box-sizing:border-box}' +
    '.oxsv-row input{width:84px}.oxsv input.bad{border-color:#ff8a8a}.oxsv input:focus{outline:none;border-color:#b038f9}' +
    '.oxsv-u{display:flex;align-items:center;gap:4px}.oxsv-u span{font:700 11px monospace;color:#9a93a6;margin-right:2px}' +
    '.oxsv-u button{min-width:36px;min-height:36px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#ddd;font:800 12px monospace;cursor:pointer;padding:0 6px}' +
    '.oxsv-u button.on{background:linear-gradient(135deg,#7a2ce0,#b038f9);border-color:transparent;color:#fff}' +
    '.oxsv-n{margin-top:8px}.oxsv-n input{width:100%;font:600 16px "Space Grotesk",system-ui,sans-serif}' +
    '.oxsv-f{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:9px;font:600 11px monospace}' +
    '.oxsv-sy{flex:1 1 180px;color:#9a93a6;line-height:1.4}.oxsv-sy.ok{color:#61e970}.oxsv-sy.bad{color:#ff8a8a}.oxsv-sy a{color:#d795ff}' +
    '.oxsv .oxsv-l,.oxsv a.oxsv-l{background:none;border:0;color:#d795ff;font:700 12px monospace;text-decoration:none;cursor:pointer;padding:6px 0}' +
    '@media (prefers-reduced-motion: reduce){.oxsv,.ox-save.pop{transition:none;animation:none}}' +
    '.ox-save{flex-shrink:0;width:34px;height:34px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);' +
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
    withId: withId, pickAt: function (i) { return REG[i] ? withId(REG[i]) : null; }, ticket: ticket, saveTicket: saveTicket, setMyPrice: setMyPrice, value: value, parlayValue: parlayValue, track: track, celebrate: celebrate, watch: watch, alertsOn: alertsOn, setAlerts: setAlerts,
    history: history, grade: grade, stats: stats, record: record,
    setMeta: setMeta, find: find, drop: drop, unitsOf: unitsOf, stakeOf: stakeOf, priceOf: priceOf, settled: settled, saveSlip: saveSlip,
    syncState: syncState, openSheet: openSheet, closeSheet: closeSheet};
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
