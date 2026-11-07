// alerts.js - "Pick alerts": a push the moment an Onyx Pick locks at or above the chance you choose
// (11/7, Jordan). Every alert is an Onyx Pick, already on the graded public record; pick_alerts.py sends them
// through OneSignal after each build. The OneSignal app id comes from data/push.json (written by the build from
// the ONESIGNAL_APP_ID secret); until it exists the card says alerts are coming soon.
//
//   OnyxAlerts.mount(el)
(function () {
  'use strict';
  var KEY = 'onyxPickAlerts';
  var CSS = [
    '.oxa{border:1px solid rgba(176,56,249,.45);border-radius:16px;padding:14px;background:linear-gradient(160deg,rgba(176,56,249,.12),rgba(255,255,255,.02));margin:0 0 18px}',
    '.oxa h3{margin:0 0 4px;font-size:18px;color:#fff}.oxa p{margin:0 0 10px;color:#b9b2c4;font-size:13px;line-height:1.55}',
    '.oxa-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.oxa-x button{font:700 12px monospace;color:#ddd;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:8px 12px;cursor:pointer}',
    '.oxa-x button.on{background:rgba(176,56,249,.3);border-color:rgba(176,56,249,.7);color:#fff}',
    '.oxa-go{font:800 12px monospace;color:#fff;background:#a24bff;border:0;border-radius:999px;padding:10px 14px;cursor:pointer}',
    '.oxa-go.off{background:rgba(255,255,255,.08);color:#ddd}.oxa-go[disabled]{opacity:.5;cursor:default}',
    '.oxa-s{margin-top:8px;font:600 11.5px monospace;color:#9a93a6}'
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
  function apply(p, done) {
    if (!APP || !INIT) return done && done(false);
    INIT.then(function (ready) {
      if (!ready) { ERR = INITERR || 'the alert service would not start'; return done && done(false); }
      window.OneSignalDeferred.push(function (OneSignal) {
        return (p.on && !OneSignal.Notifications.permission ? OneSignal.Notifications.requestPermission() : Promise.resolve())
          .then(function () { return OneSignal.User.addTags({picks: p.on ? '1' : '0', min_conf: String(p.x || 60)}); })
          .then(function () {
            var ok = !p.on || !!OneSignal.Notifications.permission;
            if (!ok) ERR = (window.Notification && Notification.permission === 'denied')
              ? 'notifications are blocked for Onyx Sports: allow them in Settings, Notifications' : 'permission was not given';
            if (done) done(ok);
          })
          .catch(function (e) { ERR = String((e && e.message) || e).slice(0, 140); if (done) done(false); });
      });
    });
  }
  function draw(el) {
    var p = pref(), x = p.x || 60, on = !!p.on, ready = !!APP;
    el.innerHTML = '<div class="oxa"><h3>Pick alerts</h3>'
      + '<p>A push the moment an Onyx Pick locks: the pick, its price and its chance. Every alert is an Onyx Pick, graded on the public record. Choose how sure a pick has to be.</p>'
      + '<div class="oxa-row"><span class="oxa-x">' + [55, 60, 65].map(function (v) { return '<button type="button" data-x="' + v + '" class="' + (v === x ? 'on' : '') + '">' + v + '%+</button>'; }).join(' ') + '</span>'
      + '<button type="button" class="oxa-go' + (on ? ' off' : '') + '"' + (ready ? '' : ' disabled') + '>' + (on ? 'Turn alerts off' : 'Turn on alerts') + '</button></div>'
      + '<div class="oxa-s">' + (!ready ? 'Push alerts are coming soon. On iPhone, add Onyx Sports to your Home Screen first: Apple only allows web push from an installed app.'
        : ERR ? 'Could not turn alerts on: ' + ERR.replace(/[<>&]/g, '') + '.'
        : on ? 'On: every Onyx Pick at ' + x + '% or better.'
        : iosBrowser() ? 'On iPhone, tap Share, then Add to Home Screen, and open Onyx Sports from there: Apple only allows push from the installed app.'
        : 'Off.') + '</div></div>';
    [].forEach.call(el.querySelectorAll('[data-x]'), function (b) {
      b.onclick = function () { var q = pref(); q.x = +b.getAttribute('data-x'); save(q); if (q.on) apply(q); draw(el); };
    });
    var go = el.querySelector('.oxa-go');
    if (go && ready) go.onclick = function () {
      var q = pref(); q.on = !q.on; q.x = q.x || 60; ERR = '';
      if (q.on && iosBrowser()) { ERR = 'on iPhone, add Onyx Sports to your Home Screen (Share, Add to Home Screen) and turn alerts on from there'; draw(el); return; }
      go.disabled = true; go.textContent = 'Working...';
      apply(q, function (ok) { if (q.on && !ok) q.on = false; save(q); draw(el); });
    };
  }
  function mount(el) {
    if (!el) return;
    css();
    fetch('data/push.json?t=' + Math.floor(Date.now() / 600000), {cache: 'no-store'}).then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; }).then(function (j) {
        APP = (j && j.app_id) || null;
        if (APP) sdk(APP);
        draw(el);
      });
  }
  window.OnyxAlerts = {mount: mount};
})();
