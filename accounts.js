// accounts.js - optional Onyx Sports accounts: sign in with your email (a one-time link, no
// password) and your saved picks, followed players and My bets follow you to every device.
//
// The site stays static and works signed out exactly as before: until accounts.json holds a
// Supabase project URL and its public (anon) key, this file does nothing. The anon key is meant
// to be public; supabase/schema.sql turns on row-level security so a signed-in person can only
// ever read or write their own rows. No library: Supabase Auth and its REST API over fetch.
//
// Sync, per list (the same localStorage lists the pages already use):
//   on sign-in, page load and every 60 s, and 2 s after the page changes a list:
//   - an item this device removed since the last sync is deleted from the account
//   - an item the account lost since the last sync (removed on another device) leaves this device
//   - everything else is the union: the account gains this device's items, this device gains the
//     account's. The first sign-in is the same rule with nothing synced before: a merge.
// The pages keep pruning their own lists (24 hours for picks and bets), and a pruned item is
// deleted from the account on the next sync.
(function () {
  var CFG = null, S = null, BUSY = false, TIMER = null, LAST = 0, ERR = '', WRITING = false;
  var SESSION = 'onyxSession', SNAP = 'onyxSyncSnap_';
  var LISTS = [
    {key: 'onyxSaved', table: 'saved_picks', id: function (x) { return x && x.id; }},
    {key: 'onyxMyBets', table: 'bets', id: function (x) { return x && x.key; }},
    // the permanent history: grades travel both ways, and only a pick taken back before its game
    // (never graded) is ever deleted from the account
    {key: 'onyxHistory', table: 'pick_history', id: function (x) { return x && x.id; }, merge: true},
    {key: 'onyxNbaFollow', table: 'followed_players', sport: 'nba', id: function (x) { return x == null ? null : String(typeof x === 'object' ? x.pid || x.id : x); }},
    {key: 'onyxFollow_nfl', table: 'followed_players', sport: 'nfl', id: function (x) { return x && x.id; }},
    {key: 'onyxFollow_cfb', table: 'followed_players', sport: 'cfb', id: function (x) { return x && x.id; }},
    {key: 'onyxFollow_cbb', table: 'followed_players', sport: 'cbb', id: function (x) { return x && x.id; }},
    {key: 'onyxFollow_nhl', table: 'followed_players', sport: 'nhl', id: function (x) { return x && x.id; }},
    {key: 'onyxFollow_tennis', table: 'followed_players', sport: 'tennis', id: function (x) { return x && x.id; }},
    {key: 'onyxFollow_golf', table: 'followed_players', sport: 'golf', id: function (x) { return x && x.id; }}
  ];
  var KEYS = LISTS.map(function (l) { return l.key; });

  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function emit() { try { dispatchEvent(new Event('onyx-account')); } catch (e) {} }
  function toast(m) { try { if (window.OX_TOAST) window.OX_TOAST(m, {}); } catch (e) {} }

  function config() {
    if (CFG) return Promise.resolve(CFG);
    return fetch('accounts.json', {cache: 'no-cache'}).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (j) { CFG = {url: String((j && j.url) || '').replace(/\/$/, ''), anon: String((j && j.anon) || '')}; return CFG; });
  }
  function on() { return !!(CFG && CFG.url && CFG.anon); }
  function hdr(extra) {
    var h = {apikey: CFG.anon, 'content-type': 'application/json'};
    if (S && S.access_token) h.authorization = 'Bearer ' + S.access_token;
    return Object.assign(h, extra || {});
  }
  function call(path, opt) {
    return fetch(CFG.url + path, Object.assign({}, opt, {headers: hdr((opt || {}).headers)})).then(function (r) {
      if (r.status === 204) return null;
      return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {} if (!r.ok) throw {status: r.status, body: j}; return j; });
    });
  }

  // ── session: the magic link lands back here with the tokens in the address bar ──
  function readHash() {
    var h = String(location.hash || '');
    if (!/access_token=|error_description=/.test(h)) return false;
    var p = {}; h.replace(/^#/, '').split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) p[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); });
    try { history.replaceState(null, '', location.pathname + location.search + (/account\.html$/.test(location.pathname) ? '' : '#my')); } catch (e) {}
    if (p.error_description || p.error_code) {
      // the usual one: an email app or scanner opened the one-time link first, or it is over an hour old
      ERR = /expired|invalid/i.test(p.error_code + ' ' + p.error_description) ? 'That sign-in link expired or was already used. Send yourself a new one.' : 'Sign-in link problem: ' + (p.error_description || p.error_code);
      toast(ERR); return false;
    }
    S = {access_token: p.access_token, refresh_token: p.refresh_token, expires_at: Date.now() + (+p.expires_in || 3600) * 1000};
    lsSet(SESSION, S);
    return true;
  }
  function fresh() {
    if (!S) return Promise.resolve(null);
    if (S.expires_at - Date.now() > 60000) return Promise.resolve(S);
    return call('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: JSON.stringify({refresh_token: S.refresh_token})})
      .then(function (j) { S = Object.assign({}, S, {access_token: j.access_token, refresh_token: j.refresh_token || S.refresh_token, expires_at: Date.now() + (+j.expires_in || 3600) * 1000}); lsSet(SESSION, S); return S; })
      .catch(function (e) { if (e && (e.status === 400 || e.status === 401)) { S = null; try { localStorage.removeItem(SESSION); } catch (x) {} emit(); } return null; });
  }
  function who() {
    return call('/auth/v1/user', {method: 'GET'}).then(function (u) {
      S.user = {id: u.id, email: u.email}; lsSet(SESSION, S); return S.user;
    });
  }

  // ── sync ──
  function rows(L) {
    var q = '/rest/v1/' + L.table + '?select=item_id,data' + (L.sport ? '&sport=eq.' + encodeURIComponent(L.sport) : '');
    return call(q, {method: 'GET'}).then(function (r) { return r || []; });
  }
  function inList(ids) { return 'in.(' + ids.map(function (x) { return '"' + String(x).replace(/["\\]/g, '') + '"'; }).join(',') + ')'; }
  function one(L) {
    var local = lsGet(L.key, []); if (!Array.isArray(local)) local = [];
    var snap = lsGet(SNAP + L.key, null), first = snap == null; snap = snap || [];
    var ids = {}; local.forEach(function (x) { var i = L.id(x); if (i) ids[i] = x; });
    return rows(L).catch(function (e) {
      if (L.merge && e && (e.status === 404 || (e.body && /PGRST205|42P01|does not exist|schema cache/.test(JSON.stringify(e.body))))) return null;   // table not created yet
      throw e;
    }).then(function (R) {
      if (R == null) return {changed: 0, first: first};
      var remote = {}; R.forEach(function (r) { remote[r.item_id] = r.data; });
      var gone = snap.filter(function (i) { return !ids[i]; });                         // removed on this device
      if (L.merge) gone = gone.filter(function (i) { return !(remote[i] && remote[i].res); });   // a graded pick is never removed
      var lost = snap.filter(function (i) { return ids[i] && !(i in remote); });          // removed on another device
      if (L.merge) lost = lost.filter(function (i) { return !(ids[i] && ids[i].res); });
      var merged = local.filter(function (x) { return lost.indexOf(L.id(x)) < 0; });
      var added = 0;
      if (L.merge) merged = merged.map(function (x) { var r = remote[L.id(x)]; if (r && r.res && !x.res) { added++; return r; } return x; });   // graded elsewhere
      Object.keys(remote).forEach(function (i) { if (!ids[i] && gone.indexOf(i) < 0) { merged.push(remote[i]); added++; } });
      var up = merged.filter(function (x) {
        var i = L.id(x); if (!i) return false;
        if (!(i in remote)) return true;
        return L.merge && x.res && !(remote[i] && remote[i].res);                       // graded here: send the grade
      }).map(function (x) {
        var r = {user_id: S.user.id, item_id: String(L.id(x)), data: x, updated_at: new Date().toISOString()};
        if (L.sport) r.sport = L.sport;
        return r;
      });
      var del = gone.filter(function (i) { return i in remote; });
      var jobs = [];
      if (up.length) jobs.push(call('/rest/v1/' + L.table + '?on_conflict=' + (L.sport ? 'user_id,sport,item_id' : 'user_id,item_id'),
        {method: 'POST', headers: {prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify(up)}));
      if (del.length) jobs.push(call('/rest/v1/' + L.table + '?item_id=' + encodeURIComponent(inList(del)) + (L.sport ? '&sport=eq.' + L.sport : ''), {method: 'DELETE'}));
      return Promise.all(jobs).then(function () {
        if (added || lost.length) { WRITING = true; lsSet(L.key, merged); WRITING = false; }
        lsSet(SNAP + L.key, merged.map(L.id).filter(Boolean).map(String));
        return {changed: added + lost.length, first: first};
      });
    });
  }
  function sync() {
    if (!on() || !S || BUSY) return Promise.resolve(false);
    BUSY = true;
    return fresh().then(function (s) {
      if (!s) return false;
      return (S.user ? Promise.resolve(S.user) : who()).then(function () {
        return LISTS.reduce(function (p, L) { return p.then(function (acc) { return one(L).then(function (r) { acc.push(r); return acc; }); }); }, Promise.resolve([]));
      }).then(function (res) {
        LAST = Date.now(); ERR = '';
        var ch = res.reduce(function (n, r) { return n + r.changed; }, 0);
        call('/rest/v1/profiles?id=eq.' + S.user.id, {method: 'PATCH', headers: {prefer: 'return=minimal'}, body: JSON.stringify({last_seen: new Date().toISOString()})}).catch(function () {});
        if (ch) { try { dispatchEvent(new Event('onyx-saved')); } catch (e) {} }
        return true;
      });
    }).catch(function (e) { ERR = 'Could not sync right now' + (e && e.status ? ' (' + e.status + ')' : ''); return false; })
      .then(function (ok) { BUSY = false; emit(); return ok; });
  }
  function soon() { if (!S) return; clearTimeout(TIMER); TIMER = setTimeout(sync, 2000); }
  // a page changing one of the lists: sync it shortly after
  var _set = Storage.prototype.setItem, _rm = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { _set.apply(this, arguments); if (!WRITING && this === window.localStorage && KEYS.indexOf(k) >= 0) soon(); };
  Storage.prototype.removeItem = function (k) { _rm.apply(this, arguments); if (!WRITING && this === window.localStorage && KEYS.indexOf(k) >= 0) soon(); };
  addEventListener('storage', function (e) { if (KEYS.indexOf(e.key) >= 0) soon(); if (e.key === SESSION) { S = lsGet(SESSION, null); emit(); } });

  // ── what pages call ──
  function signIn(email) {
    email = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Promise.reject(new Error('Enter your email address'));
    var back = location.origin + location.pathname.replace(/[^\/]*$/, '') + 'account.html';   // links land on the Account page
    return call('/auth/v1/otp?redirect_to=' + encodeURIComponent(back), {method: 'POST', body: JSON.stringify({email: email, create_user: true})})
      .catch(function (e) {
        // Supabase's reasons, in plain words
        var b = (e && e.body) || {}, code = String(b.error_code || b.code || ''), msg = String(b.msg || b.message || b.error_description || '');
        var err = new Error(
          /over_email_send_rate_limit/.test(code) || /email rate limit/i.test(msg) ? 'Too many sign-in emails went out in the last hour, so Supabase is holding new ones. Try again later.' :
          /over_request_rate_limit/.test(code) || (e && e.status === 429) ? 'Too many tries in a row. Wait a minute, then send the link again.' :
          /email_address_not_authorized/.test(code) ? 'Sign-in emails are only going to the Onyx team for now. They open to everyone once Onyx\'s email sender is connected.' :
          /signup_disabled|otp_disabled/.test(code) ? 'New sign-ups are switched off right now.' :
          /email_address_invalid|validation_failed/.test(code) ? 'That email address does not look right. Check it and try again.' :
          'Could not send the link right now' + (msg ? ' (' + msg + ')' : '') + '. Try again in a minute.');
        err.code = code; err.status = e && e.status; throw err;
      });
  }
  // ── signing in inside the installed app (11/7): on iPhone the emailed link always opens Safari, and Safari and
  // the Home Screen app keep separate storage, so a link can never sign the app in. Two ways in, typed in the app:
  //   - the 6-digit code in the sign-in email (once the Supabase Magic Link template shows {{ .Token }})
  //   - an app code: Safari, signed in by the link, shows its session's one-time refresh token; the app trades it
  //     for its own session and Safari drops its copy, so the two never share a rotating token.
  function _take(j) {
    S = {access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (+j.expires_in || 3600) * 1000};
    if (j.user) S.user = {id: j.user.id, email: j.user.email};
    lsSet(SESSION, S); ERR = '';
    return (S.user ? Promise.resolve(S.user) : who()).then(function () { emit(); sync(); every(); return true; });
  }
  function useCode(email, code) {
    code = String(code || '').replace(/\s+/g, '');
    if (!code) return Promise.reject(new Error('Enter the code'));
    return config().then(function () {
      if (/^\d{6,10}$/.test(code)) {
        email = String(email || '').trim();
        if (!email) throw new Error('Enter your email above first, then the code from the email');
        return call('/auth/v1/verify', {method: 'POST', body: JSON.stringify({type: 'email', email: email, token: code})});
      }
      return call('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: JSON.stringify({refresh_token: code})});
    }).then(_take).catch(function (e) {
      if (e instanceof Error) throw e;
      throw new Error(e && (e.status === 400 || e.status === 401 || e.status === 403)
        ? 'That code did not work: it may be mistyped, used already or expired. Get a new one and try again.'
        : 'Could not sign in right now' + (e && e.status ? ' (' + e.status + ')' : '') + '. Try again in a minute.');
    });
  }
  // the code Safari shows for the app; handing it over signs Safari out here (no server logout: that would end
  // the session the app is about to take)
  function appCode() { return S && S.refresh_token ? S.refresh_token : null; }
  function handOff() {
    S = null;
    try { localStorage.removeItem(SESSION); } catch (e) {}
    KEYS.forEach(function (k) { try { _rm.call(localStorage, SNAP + k); } catch (e) {} });
    emit();
  }
  // the push control center (alerts.js, 11/7): the person's profile row holds push_level, which
  // my_alerts.py reads with the service key to decide what to push about their saved picks
  function uid() { return S && S.user ? S.user.id : null; }
  function profile() {
    if (!on() || !S) return Promise.resolve(null);
    return fresh().then(function (s) { if (!s) return null; return (S.user ? Promise.resolve(S.user) : who()).then(function () {
      return call('/rest/v1/profiles?select=push_level&id=eq.' + S.user.id, {method: 'GET'}); }).then(function (r) { return (r && r[0]) || {}; }); });
  }
  function setProfile(patch) {
    if (!on() || !S) return Promise.reject(new Error('Sign in first'));
    return fresh().then(function () { return (S.user ? Promise.resolve(S.user) : who()); }).then(function () {
      return call('/rest/v1/profiles?id=eq.' + S.user.id, {method: 'PATCH', headers: {prefer: 'return=minimal'}, body: JSON.stringify(patch)}); });
  }
  var FROM_LINK = false, IV = null;
  function every() { if (!IV) IV = setInterval(function () { if (!document.hidden) sync(); }, 60000); }
  function fromLink() { return FROM_LINK; }

  function signOut() {
    var s = S;
    S = null;
    try { localStorage.removeItem(SESSION); } catch (e) {}
    KEYS.forEach(function (k) { try { _rm.call(localStorage, SNAP + k); } catch (e) {} });   // this device keeps its lists
    emit();
    if (s && on()) return fetch(CFG.url + '/auth/v1/logout', {method: 'POST', headers: {apikey: CFG.anon, authorization: 'Bearer ' + s.access_token}}).catch(function () {});
    return Promise.resolve();
  }
  function deleteAccount() {
    if (!S) return Promise.resolve();
    return fresh().then(function () { return call('/rest/v1/rpc/delete_me', {method: 'POST', body: '{}'}); }).then(function () { return signOut(); });
  }
  function state() {
    return {enabled: on(), signedIn: !!(S && S.user), email: S && S.user ? S.user.email : null, syncing: BUSY, last: LAST, error: ERR};
  }
  window.OnyxAccounts = {ready: null, signIn: signIn, signOut: signOut, deleteAccount: deleteAccount, sync: sync, state: state,
                         useCode: useCode, appCode: appCode, handOff: handOff, fromLink: fromLink,
                         uid: uid, profile: profile, setProfile: setProfile};
  window.OnyxAccounts.ready = config().then(function () {
    if (!on()) { emit(); return state(); }
    var landed = readHash();
    FROM_LINK = landed;
    S = S || lsGet(SESSION, null);
    var go = S ? (S.user && !landed ? Promise.resolve() : fresh().then(function (s) { return s ? who() : null; }).catch(function () {})) : Promise.resolve();
    return go.then(function () {
      if (landed && S && S.user) toast('Signed in as ' + S.user.email + '. Syncing your picks and players.');
      emit();
      if (S) { sync(); every(); }
      return state();
    });
  });
})();
