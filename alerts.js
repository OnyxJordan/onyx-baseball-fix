// alerts.js - the alerts control center (11/7, Jordan: "a push notification control center where you can get
// updates on all your picks and you can select how often"). Two kinds of push, both through OneSignal:
//   Onyx Picks      a push the moment an Onyx Pick locks at or above the chance you choose (55/60/65%);
//                   pick_alerts.py sends them after each build (tags picks=1, min_conf=X)
//   Your saved picks for signed-in people only (Jordan's call): every update, key moments, results only,
//                   a daily recap, or off. Saved on the person's profile (push_level) and this phone is
//                   linked to the account (OneSignal external_id = the Supabase user id); my_alerts.py
//                   grades their saved picks live and sends what their level allows.
// The OneSignal app id comes from data/push.json (written by the build from the ONESIGNAL_APP_ID secret).
//
//   OnyxAlerts.mount(el)
(function () {
  'use strict';
  var KEY = 'onyxPickAlerts';
  var CSS = [
    '.oxa{border:1px solid rgba(176,56,249,.45);border-radius:16px;padding:16px;background:linear-gradient(160deg,rgba(176,56,249,.12),rgba(255,255,255,.02));margin:0 0 18px}',
    '.oxa h3{margin:0 0 4px;font-size:19px;color:#fff}.oxa>p{margin:0 0 12px;color:#b9b2c4;font-size:13px;line-height:1.55}',
    '.oxa-sec{border-top:1px solid rgba(255,255,255,.08);padding:12px 0 2px}',
    '.oxa-hd{display:flex;align-items:center;justify-content:space-between;gap:10px}.oxa-hd b{font-size:15px;color:#fff}',
    '.oxa-sec p{margin:4px 0 10px;color:#a9a2b6;font-size:12.5px;line-height:1.5}',
    '.oxa-sw{position:relative;width:46px;height:27px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);cursor:pointer;flex:none;padding:0}',
    '.oxa-sw::after{content:"";position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#cfc8da;transition:transform .2s,background .2s}',
    '.oxa-sw.on{background:#a24bff;border-color:#a24bff}.oxa-sw.on::after{transform:translateX(19px);background:#fff}.oxa-sw[disabled]{opacity:.45;cursor:default}',
    '.oxa-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}',
    '.oxa-x button{font:700 12px monospace;color:#ddd;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:8px 12px;cursor:pointer}',
    '.oxa-x button.on{background:rgba(176,56,249,.3);border-color:rgba(176,56,249,.7);color:#fff}',
    '.oxa-lv{display:grid;gap:6px;margin:6px 0 8px}',
    '.oxa-lv button{display:grid;grid-template-columns:18px 1fr;gap:2px 10px;align-items:start;text-align:left;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#eee;cursor:pointer;font:inherit}',
    '.oxa-lv button i{grid-row:span 2;width:16px;height:16px;margin-top:2px;border-radius:5px;border:2px solid rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;font:900 11px sans-serif;font-style:normal;color:#fff}',
    '.oxa-qk{display:flex;gap:8px;margin:2px 0 6px}.oxa-qk button{font:700 11.5px monospace;color:#ddd;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 11px;cursor:pointer}.oxa-qk button[disabled]{opacity:.5}',
    '.oxa-lv button b{font-size:14px}.oxa-lv button span{font-size:12px;color:#a9a2b6;line-height:1.4}',
    '.oxa-lv button.on{border-color:rgba(176,56,249,.75);background:rgba(176,56,249,.16)}.oxa-lv button.on i{border-color:#a24bff;background:#a24bff}',
    '.oxa-lv button[disabled]{opacity:.5;cursor:default}',
    '.oxa-in{display:inline-block;margin:2px 0 8px;font:800 12px monospace;color:#fff;background:#a24bff;border-radius:999px;padding:9px 14px;text-decoration:none}',
    '.oxa-s{margin-top:8px;font:600 11.5px monospace;color:#9a93a6;line-height:1.5}'
  ].join('\n');
  function css() { if (document.getElementById('onyx-alerts-css')) return; var s = document.createElement('style'); s.id = 'onyx-alerts-css'; s.textContent = CSS; document.head.appendChild(s); }
  function pref() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {} }
  var APP = null, loaded = false, INIT = null, ERR = '', INITERR = '';
  // the site lives in a subfolder on GitHub Pages (/onyx-baseball-fix/), so OneSignal must be told where
  // our worker (sw.js, which imports OneSignal's) is and what it controls, or it looks at the domain root
  var BASE = location.pathname.replace(/[^/]*$/, '');
  function standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  function iosBrowser() { return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone(); }
  function sdk(app) {
    if (loaded) return; loaded = true;
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    INIT = new Promise(function (ok) {
      var s = document.createElement('script'); s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'; s.defer = true;
      s.onerror = function () { INITERR = 'the alert service did not load (check your connection or content blocker)'; ok(false); };
      document.head.appendChild(s);
      window.OneSignalDeferred.push(function (OneSignal) {
        // the dashboard is a Typical Site whose worker is /OneSignalSDKWorker.js at the domain root, which a
        // GitHub Pages project site cannot serve; v16 uses our path only with serviceWorkerOverrideForTypical
        // (it registers path + '/' + serviceWorkerPath). sw.js imports OneSignal's worker, so the site keeps
        // one worker for offline and push.
        return OneSignal.init({appId: app, serviceWorkerOverrideForTypical: true, path: BASE,
                               serviceWorkerPath: 'sw.js', serviceWorkerParam: {scope: BASE}})
          .then(function () { ok(true); })
          .catch(function (e) { INITERR = 'the alert service would not start (' + String((e && e.message) || e || 'setup failed').slice(0, 120) + ')'; ok(false); });
      });
    });
  }
  // run fn(OneSignal) once the SDK is up; rejects with ERR set when it cannot start
  function withOS(fn) {
    if (!APP || !INIT) return Promise.reject(new Error('not ready'));
    return INIT.then(function (ready) {
      if (!ready) { ERR = INITERR || 'the alert service would not start'; throw new Error(ERR); }
      return new Promise(function (res, rej) {
        window.OneSignalDeferred.push(function (OneSignal) { return Promise.resolve().then(function () { return fn(OneSignal); }).then(res, rej); });
      });
    });
  }
  var OSPERM = null;   // OneSignal's own reading of this phone's permission, once the SDK is up
  function permit(OneSignal) {
    if (OneSignal.Notifications.permission) { OSPERM = true; return Promise.resolve(true); }
    return Promise.resolve(OneSignal.Notifications.requestPermission()).then(function () {
      var ok = OSPERM = !!OneSignal.Notifications.permission;
      if (!ok) ERR = (window.Notification && Notification.permission === 'denied')
        ? 'notifications are blocked for Onyx Sports: allow them in Settings, Notifications' : 'permission was not given';
      return ok;
    });
  }
  function acct() { return window.OnyxAccounts && OnyxAccounts.state ? OnyxAccounts.state() : {enabled: false, signedIn: false}; }
  // this phone follows the signed-in account (external_id), so pushes about saved picks reach it
  function link() {
    var A = window.OnyxAccounts, id = A && A.uid ? A.uid() : null, p = pref();
    if (!APP) return Promise.resolve();
    if (id && p.linked !== id) return withOS(function (OS) { return OS.login(id); }).then(function () { p.linked = id; save(p); }).catch(function () {});
    if (!id && p.linked) return withOS(function (OS) { return OS.logout(); }).then(function () { delete p.linked; save(p); }).catch(function () {});
    return Promise.resolve();
  }
  // what to push about your saved picks: a checklist (11/8, Jordan: "a checklist, not one selection only").
  // Saved on the profile as a comma list ("start,result,recap") or "off"; my_alerts.py reads the same list.
  var EVENTS = [['start', 'Game starts', 'The moment the game your pick is in starts'],
                ['swing', 'Lead changes', 'When your pick goes ahead or falls behind (at most every 15 minutes)'],
                ['half', 'Halftime check', 'Where your pick stands at the break'],
                ['result', 'Results', 'Cashed, missed or push, as soon as it is decided'],
                ['recap', 'Daily recap', 'One push each morning: yesterday\'s record and today\'s picks']];
  var LEGACY = {all: 'start,swing,half,result', key: 'start,result', results: 'result', recap: 'recap', off: ''};
  function evSet(level) {
    var v = String(level || 'off'); if (v in LEGACY) v = LEGACY[v];
    var o = {}; v.split(',').forEach(function (k) { if (k) o[k] = 1; }); return o;
  }
  function evLevel(o) { var k = EVENTS.map(function (e) { return e[0]; }).filter(function (k) { return o[k]; }); return k.length ? k.join(',') : 'off'; }
  var LEVEL = null, LVERR = '', BUSY = false;
  function loadLevel(el) {
    var A = window.OnyxAccounts;
    if (!A || !A.profile || !acct().signedIn) { LEVEL = null; return; }
    A.profile().then(function (r) {
      if (r && r.push_level) { LEVEL = r.push_level; LVERR = ''; }
      else if (r && !('push_level' in r)) { LEVEL = 'off'; LVERR = 'Updates on your saved picks are almost ready. Check back soon.'; }
      draw(el);
    }).catch(function () { LVERR = 'Updates on your saved picks are almost ready. Check back soon.'; draw(el); });
  }
  function draw(el) {
    var p = pref(), x = p.x || 60, on = !!p.on, ready = !!APP, st = acct(), lv = LEVEL || p.my || 'off';
    var perm = window.Notification ? Notification.permission : 'default';
    var lvDisabled = !ready || BUSY || !!LVERR;
    el.innerHTML = '<div class="oxa"><h3>Alerts</h3><p>Your push control center: choose what reaches this phone and how often.</p>'
      + '<div class="oxa-sec"><div class="oxa-hd"><b>Onyx Picks</b><button type="button" class="oxa-sw oxa-pk' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Onyx Pick alerts"' + (ready && !BUSY ? '' : ' disabled') + '></button></div>'
      + '<p>A push the moment an Onyx Pick locks: the pick, its price and its chance. Every one is graded on the public record. Only picks at least this sure:</p>'
      + '<div class="oxa-row"><span class="oxa-x">' + [55, 60, 65].map(function (v) { return '<button type="button" data-x="' + v + '" class="' + (v === x ? 'on' : '') + '">' + v + '%+</button>'; }).join(' ') + '</span></div></div>'
      + '<div class="oxa-sec"><div class="oxa-hd"><b>Your saved picks</b></div>'
      + (!st.enabled ? '<p>Updates on the picks you save, from the first whistle to the result. Coming with accounts.</p>'
        : !st.signedIn ? '<p>Updates on every pick you save: when the game starts, how it is going and the result. Sign in so we know which picks are yours.</p><a class="oxa-in" href="account.html">Sign in</a>'
        : '<p>Updates on every pick you save' + (st.email ? ' as ' + String(st.email).replace(/[<>&"]/g, '') : '') + '. Check everything you want:</p>'
          + '<div class="oxa-qk"><button type="button" data-qk="all"' + (lvDisabled ? ' disabled' : '') + '>Everything</button><button type="button" data-qk="off"' + (lvDisabled ? ' disabled' : '') + '>None</button></div>'
          + '<div class="oxa-lv">' + EVENTS.map(function (E) {
            var onE = !!evSet(lv)[E[0]];
            return '<button type="button" role="checkbox" aria-checked="' + onE + '" data-ev="' + E[0] + '" class="' + (onE ? 'on' : '') + '"' + (lvDisabled ? ' disabled' : '') + '><i>' + (onE ? '&#10003;' : '') + '</i><b>' + E[1] + '</b><span>' + E[2] + '</span></button>';
          }).join('') + '</div>' + (LVERR ? '<p>' + LVERR + '</p>' : ''))
      + '</div>'
      + '<div class="oxa-s">' + (!ready ? 'Push alerts are coming soon. On iPhone, add Onyx Sports to your Home Screen first: Apple only allows web push from an installed app.'
        : BUSY ? 'Saving...'
        : ERR ? 'Could not save: ' + ERR.replace(/[<>&]/g, '') + '.'
        : iosBrowser() ? 'On iPhone, tap Share, then Add to Home Screen, and open Onyx Sports from there: Apple only allows push from the installed app.'
        : perm === 'denied' && OSPERM !== true ? 'Notifications are blocked for Onyx Sports. Allow them in Settings, Notifications.'
        : (on || (evLevel(evSet(lv)) !== 'off' && st.signedIn)) ? 'This phone: ' + [on ? 'Onyx Picks at ' + x + '%+' : '', lv !== 'off' && st.signedIn ? EVENTS.filter(function (E) { return evSet(lv)[E[0]]; }).map(function (E) { return E[1].toLowerCase(); }).join(', ') + ' on your picks' : ''].filter(Boolean).join(', ') + '.'
        : 'Nothing is on yet.') + '</div></div>';
    [].forEach.call(el.querySelectorAll('[data-x]'), function (b) {
      b.onclick = function () { var q = pref(); q.x = +b.getAttribute('data-x'); save(q); if (q.on) withOS(function (OS) { return OS.User.addTags({min_conf: String(q.x)}); }).catch(function () {}); draw(el); };
    });
    var sw = el.querySelector('.oxa-pk');
    if (sw && ready) sw.onclick = function () {
      if (iosBrowser()) { ERR = 'on iPhone, add Onyx Sports to your Home Screen (Share, Add to Home Screen) and turn alerts on from there'; draw(el); return; }
      var q = pref(), want = !q.on; ERR = ''; BUSY = true; draw(el);
      withOS(function (OS) {
        return (want ? permit(OS) : Promise.resolve(true)).then(function (ok) {
          if (!ok) return false;
          return Promise.resolve(OS.User.addTags({picks: want ? '1' : '0', min_conf: String(q.x || 60)})).then(function () { return true; });
        });
      }).then(function (ok) { if (ok) { q.on = want; q.x = q.x || 60; save(q); } }, function () {})
        .then(function () { BUSY = false; draw(el); });
    };
    function saveLevel(want) {
      if (iosBrowser()) { ERR = 'on iPhone, add Onyx Sports to your Home Screen (Share, Add to Home Screen) and turn alerts on from there'; draw(el); return; }
      var A = window.OnyxAccounts; ERR = ''; BUSY = true; LEVEL = want; draw(el);
      (want === 'off' ? Promise.resolve(true) : withOS(permit)).then(function (ok) {
        if (!ok) { LEVEL = lv; return; }
        return link().then(function () { return A.setProfile({push_level: want}); }).then(function () {
          var q = pref(); q.my = want; save(q);
          return withOS(function (OS) { return OS.User.addTags({my: want}); }).catch(function () {});
        });
      }).catch(function (e) {
        // Supabase's own reason (accounts.js throws {status, body}), in plain words where we know it (11/8: "could not
        // save, try again in a minute" hid an old check on push_level that only allowed one choice)
        var b = (e && e.body) || {}, code = String(b.code || ''), msg = String(b.message || b.msg || (e && e.message) || '');
        LEVEL = lv;
        ERR = ERR || (code === '23514' || /check constraint/i.test(msg) ? 'the database still allows one choice only: run the 11/8 push_level check from supabase/schema.sql'
          : code === '42703' || /push_level/.test(msg) ? 'the push settings column is missing: run the 11/7 block of supabase/schema.sql'
          : e && (e.status === 401 || e.status === 403) ? 'your sign-in expired: sign in again on the Account page'
          : (msg ? msg.slice(0, 120) : 'try again in a minute') + (e && e.status ? ' (' + e.status + ')' : ''));
      })
        .then(function () { BUSY = false; draw(el); });
    }
    [].forEach.call(el.querySelectorAll('[data-ev]'), function (b) {
      b.onclick = function () { var o = evSet(lv), k = b.getAttribute('data-ev'); if (o[k]) delete o[k]; else o[k] = 1; saveLevel(evLevel(o)); };
    });
    [].forEach.call(el.querySelectorAll('[data-qk]'), function (b) {
      b.onclick = function () { saveLevel(b.getAttribute('data-qk') === 'all' ? evLevel({start: 1, swing: 1, half: 1, result: 1, recap: 1}) : 'off'); };
    });
  }
  function mount(el) {
    if (!el) return;
    css();
    fetch('data/push.json?t=' + Math.floor(Date.now() / 600000), {cache: 'no-store'}).then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; }).then(function (j) {
        APP = (j && j.app_id) || null;
        if (APP) { sdk(APP); withOS(function (OS) { OSPERM = !!OS.Notifications.permission; }).then(function () { draw(el); }, function () {}); }
        draw(el);
        // the account loads after this card (saved.js -> accounts.js): follow it, link this phone, read the level
        var sync = function () { signed = acct().signedIn; loadLevel(el); draw(el); if (pref().on || pref().my || pref().linked) link(); };
        var A = window.OnyxAccounts;
        if (A && A.ready) A.ready.then(sync); else setTimeout(function () { var B = window.OnyxAccounts; if (B && B.ready) B.ready.then(sync); else sync(); }, 1500);
        var signed = null;
        addEventListener('onyx-account', function () {
          var now = acct().signedIn;
          if (now === signed) return;                       // the minute-by-minute sync: nothing changed here
          signed = now; if (!now) LEVEL = null; sync();
        });
      });
  }
  window.OnyxAlerts = {mount: mount};
})();
