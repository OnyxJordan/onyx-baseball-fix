/* ui.js - the shared app shell for both Onyx sites (index.html = MLB,
   nba.html = NBA). Loaded with `defer` after each page's own script, so
   every page global it reads already exists. It adds, without rewriting
   the pages:

   - status-bar fix: installed iPhone apps sometimes report a 0 safe-area
     inset (until a rotation), which put the menu's header and close button
     under the clock and made the menu impossible to close. --sat / --sab
     carry the inset everywhere, with a measured fallback.
   - bottom tab bar + "More" sheet: the menu lives at the bottom, in thumb
     reach and away from the status bar. Swipe down, tap outside or Esc
     closes it. The hamburger opens the same sheet.
   - search (tabs and players), parlay toasts with haptics, page
     transitions, re-tap to scroll top, header shadow on scroll, MLB / NBA
     switch, and a one-time "What's new".

   Site differences live in SITES below. Nothing here throws if a page
   function is missing: every hook is guarded. */
(function () {
  'use strict';
  var IS_NBA = /nba\.html/.test(location.pathname) || typeof NBA_DATA !== 'undefined';
  // every Onyx Sports page: the sport pages built from sport_shell.html set
  // window.OX_SITE before this script runs; MLB and NBA are detected
  var SITE = window.OX_SITE || (IS_NBA ? 'nba' : 'mlb');
  var ALL = [['mlb', 'MLB', './', 'Baseball'], ['nba', 'NBA', 'nba.html', 'Basketball'], ['nfl', 'NFL', 'nfl.html', 'NFL'],
             ['cfb', 'CFB', 'cfb.html', 'College Football'], ['nhl', 'NHL', 'nhl.html', 'NHL'],
             ['tennis', 'Tennis', 'tennis.html', 'Tennis'], ['golf', 'Golf', 'golf.html', 'Golf']];
  function sportSeg(cls) {
    return '<div class="oseg ' + (cls || '') + '" role="tablist" aria-label="Sport">' + ALL.map(function (a) {
      return '<a href="' + a[2] + '"' + (a[0] === SITE ? ' class="on" aria-current="page"' : '') + '>' + a[1] + '</a>';
    }).join('') + '</div>';
  }
  var root = document.documentElement;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var WHATS_NEW = 'onyx-new-2026-10-26b';
  // the Onyx logo mark (onyxodds.com), for the Onyx Sports links
  var OX_MARK = '<svg viewBox="0 0 100 137" fill="currentColor" aria-hidden="true"><path d="m39.041 109.178 18.493 9.863-33.972 17.945L0 124.384v-84.11l39.041-20.411zm21.918-81.37-18.493-9.863L76.438 0 100 12.603v84.246L60.959 117.26z"/></svg>';

  var I = {   // 16px stroke icons
    home: '<path d="M2 6.5L8 2l6 4.5V14H2z"/><path d="M6 14V9h4v5"/>',
    board: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 9h6M5 12h3"/>',
    games: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.5 2 2.5 10 0 12M8 2c-2.5 2-2.5 10 0 12"/>',
    plays: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>',
    markets: '<path d="M2 13l3.5-4 3 2.5L14 5"/><path d="M10.5 5H14v3.5"/>',
    ranks: '<path d="M3 14V9M8 14V4M13 14V7"/>',
    pitch: '<circle cx="8" cy="8" r="6"/><path d="M4.5 4.5q3 3.5 0 7M11.5 4.5q-3 3.5 0 7"/>',
    trophy: '<path d="M4 2h8v4a4 4 0 01-8 0z"/><path d="M8 10v3M5.5 14h5"/>',
    record: '<path d="M2 12l3-5 3 2 3-5 3 2"/>',
    model: '<path d="M2 4h12M2 7h8M2 10h10M2 13h6"/>',
    star: '<path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z"/>',
    more: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    slip: '<rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M6 6h4M6 9h4"/>',
    share: '<path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 9v4h10V9"/>',
    spark: '<path d="M8 1v4M8 11v4M1 8h4M11 8h4M3 3l2.5 2.5M10.5 10.5L13 13M13 3l-2.5 2.5M5.5 10.5L3 13"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  };
  function svg(k, cls) { return '<svg class="' + (cls || 'oi') + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[k] || '') + '</svg>'; }

  var SITES = {
    mlb: {
      name: 'Baseball', other: {label: 'NBA', href: 'nba.html'},
      bar: [['board', 'Board', 'board'], ['power', 'Plays', 'plays'], ['gamecenter', 'Games', 'games', 1], ['markets', 'Markets', 'markets']],
      tabs: [
        ['home', 'Home', 'home', 'Tonight at a glance'],
        ['gamecenter', 'Games', 'games', 'Live gamecasts and box scores'],
        ['board', "Today's Board", 'board', 'Every HR probability vs Onyx'],
        ['power', 'Edge Plays', 'plays', 'Where the model beats the line'],
        ['pitchers', 'Pitchers & Ks', 'pitch', 'Strikeout projections'],
        ['playoffs', 'Playoffs', 'trophy', 'Series odds'],
        ['markets', 'Markets', 'markets', 'Line moves and steam'],
        ['rankings', 'Rankings', 'ranks', 'Power and form'],
        ['record', 'SB Record', 'record', 'Every pick, graded'],
        ['model', 'Model', 'model', 'How the engine works'],
      ],
    },
    nba: {
      name: 'Basketball', other: {label: 'MLB', href: './'},
      bar: [['home', 'Home', 'home'], ['plays', 'Plays', 'plays'], ['games', 'Games', 'games', 1], ['board', 'Props', 'board']],
      tabs: [
        ['home', 'Home', 'home', "Tonight's picks and the Model's Parlay"],
        ['plays', 'Plays', 'plays', 'Recommended plays, ranked, with the why'],
        ['games', 'Games', 'games', 'Live court, possession, box'],
        ['board', 'Props Board', 'board', 'Points, boards, dimes vs Onyx'],
        ['scorers', 'Top Scorers', 'star', "Tonight's biggest scorers"],
        ['record', 'Record', 'record', 'Every pick, graded'],
        ['model', 'Model', 'model', 'Weights, history, evidence'],
      ],
    },
  };
  // the sport pages: one shape, tabs from sport_shell.html
  ALL.slice(2).forEach(function (a) {
    SITES[a[0]] = {name: a[3],
      bar: [['home', 'Home', 'home'], ['plays', 'Plays', 'plays'], ['games', 'Games', 'games', 1], ['board', 'Board', 'board']],
      tabs: [['home', 'Home', 'home', 'Tonight at a glance'], ['games', 'Games', 'games', 'Live scores and the gamecenter'],
             ['board', 'Onyx Board', 'board', 'Every Onyx line'], ['plays', 'Plays', 'plays', 'Model leans and picks'],
             ['model', 'Model', 'model', 'How it works, what is tested']]};
  });
  var S = SITES[SITE] || SITES.mlb;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function buzz() { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function go(tab) { try { if (typeof gotoTab === 'function') gotoTab(tab); } catch (e) { console.error(e); } }

  // ── 1. status bar ─────────────────────────────────────────────────────
  function fixSafeArea() {
    var probe = el('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)';
    document.body.appendChild(probe);
    var sat = probe.getBoundingClientRect().height;
    probe.style.height = 'env(safe-area-inset-bottom,0px)';
    var sab = probe.getBoundingClientRect().height;
    probe.remove();
    var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    var ios = /iPhone|iPod/.test(navigator.userAgent);
    // the pages use the solid "black" status bar, so the app starts below it
    // and the top inset is 0 by design. Only a translucent bar draws the page
    // underneath; then a 0 inset is iOS misreporting, and the real height is
    // used: 59pt on Dynamic Island phones (852pt+ tall), 47pt on notch phones,
    // 20pt on the rest.
    var meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    var translucent = meta && meta.content === 'black-translucent';
    var h = Math.max(screen.height, screen.width);
    root.style.removeProperty('--sat');
    root.style.removeProperty('--sab');
    if (standalone && ios && translucent && sat < 1)
      root.style.setProperty('--sat', (h >= 852 ? 59 : h >= 812 ? 47 : 20) + 'px');
    if (standalone && ios && sab < 1 && h >= 812)
      root.style.setProperty('--sab', '34px');   // home indicator
  }

  // ── 2. styles ─────────────────────────────────────────────────────────
  var CSS = [
    ':root{--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px)}',
    '.oi{width:18px;height:18px;flex-shrink:0}',
    '.ogrid[hidden],.ores[hidden]{display:none!important}',
    /* bottom bar */
    '.obar{display:none}',
    '@media (max-width:760px){',
    '.bnav,.nav-drawer{display:none!important}',
    '.nav>.nav-tab{display:none!important}',
    '.obar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:9000;padding:6px 6px calc(6px + var(--sab));',
    'background:rgba(12,12,12,.88);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);border-top:1px solid rgba(255,255,255,.08)}',
    'body{padding-bottom:calc(74px + var(--sab))!important}',
    '#parlayFab{bottom:calc(84px + var(--sab))!important}',
    '}',
    '.obar-i{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px 0 3px;background:none;border:0;color:var(--text3,#8a8a99);',
    'font:700 9.5px/1 "Space Grotesk",system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent;transition:color .15s,transform .12s}',
    '.obar-i:active{transform:scale(.92)}',
    '.obar-i.on{color:#d795ff}',
    '.obar-i.on::after{content:"";position:absolute;top:-6px;width:22px;height:3px;border-radius:0 0 3px 3px;background:linear-gradient(90deg,#b038f9,#635bff)}',
    '.obar-i.big .oi{width:24px;height:24px}',
    '.obar-i.big .ob-dot{width:50px;height:50px;margin-top:-26px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;',
    'background:linear-gradient(135deg,#b038f9,#635bff);box-shadow:0 6px 18px rgba(176,56,249,.45),0 0 0 4px rgba(12,12,12,.95);transition:box-shadow .2s}',
    '.obar-i.big.on .ob-dot{box-shadow:0 6px 26px rgba(176,56,249,.8),0 0 0 4px rgba(12,12,12,.95)}',
    '.obar-i.big.on::after{display:none}',
    /* sheet */
    '.osheet-bg{position:fixed;inset:0;z-index:10050;background:rgba(4,4,8,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);opacity:0;pointer-events:none;transition:opacity .25s}',
    '.osheet-bg.open{opacity:1;pointer-events:auto}',
    '.osheet{position:fixed;left:0;right:0;bottom:0;z-index:10060;max-height:calc(100vh - var(--sat) - 24px);overflow-y:auto;overscroll-behavior:contain;',
    'background:linear-gradient(180deg,rgba(28,22,40,.98),rgba(14,14,18,.99));border:1px solid rgba(176,56,249,.28);border-bottom:0;border-radius:22px 22px 0 0;',
    'padding:8px 16px calc(18px + var(--sab));transform:translateY(105%);transition:transform .32s cubic-bezier(.2,.9,.25,1);box-shadow:0 -20px 60px rgba(0,0,0,.55)}',
    '.osheet.open{transform:translateY(0)}',
    /* closed = hidden from view, taps, Tab and screen readers; visibility flips
       after the slide-out so the closing animation still plays */
    '.osheet{visibility:hidden;transition:transform .32s cubic-bezier(.2,.9,.25,1),opacity .2s,visibility 0s linear .32s}',
    '.osheet.open{visibility:visible;transition:transform .32s cubic-bezier(.2,.9,.25,1),opacity .2s,visibility 0s}',
    '@media (min-width:761px){.osheet{left:50%;right:auto;width:560px;margin-left:-280px;bottom:auto;top:calc(80px + var(--sat));border-radius:18px;border-bottom:1px solid rgba(176,56,249,.28);transform:translateY(-12px) scale(.98);opacity:0;pointer-events:none;transition:transform .2s,opacity .2s}',
    '.osheet.open{transform:none;opacity:1;pointer-events:auto}.osheet-grip{display:none}}',
    '.osheet-grip{width:40px;height:5px;border-radius:3px;background:rgba(255,255,255,.22);margin:2px auto 12px}',
    '.osheet-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
    '.osheet-title{font-weight:800;font-size:17px;flex:1}',
    '.osheet-x{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:var(--text2,#bbb);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.oseg{display:inline-flex;position:relative;padding:3px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}',
    '.oseg a{position:relative;z-index:1;padding:6px 14px;border-radius:999px;font:800 11px/1 "Space Grotesk",system-ui,sans-serif;letter-spacing:.08em;color:var(--text3,#8a8a99);text-decoration:none}',
    '.oseg a.on{color:#fff;background:linear-gradient(135deg,#b038f9,#635bff);box-shadow:0 2px 10px rgba(176,56,249,.45)}',
    '.osearch{display:flex;align-items:center;gap:8px;padding:11px 13px;border-radius:13px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);margin-bottom:12px;color:var(--text3,#8a8a99)}',
    '.osearch input{flex:1;background:none;border:0;outline:0;color:var(--text,#fff);font:500 15px "Space Grotesk",system-ui,sans-serif;min-width:0}',
    '.osearch kbd{font:700 10px monospace;padding:2px 6px;border-radius:5px;border:1px solid rgba(255,255,255,.15);color:var(--text3,#888)}',
    '.ogrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '@media (min-width:761px){.ogrid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
    '.otile{display:flex;gap:10px;align-items:flex-start;text-align:left;padding:12px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);',
    'color:var(--text,#fff);cursor:pointer;transition:transform .12s,border-color .15s,background .15s;-webkit-tap-highlight-color:transparent;opacity:0;transform:translateY(8px)}',
    '.osheet.open .otile{opacity:1;transform:none;transition:opacity .3s,transform .3s,border-color .15s,background .15s}',
    '.otile:active{transform:scale(.97)!important}',
    '.otile:hover{border-color:rgba(176,56,249,.45);background:rgba(176,56,249,.08)}',
    '.otile.on{border-color:rgba(176,56,249,.6);background:rgba(176,56,249,.12)}',
    '.otile .oi{color:#d795ff;margin-top:1px}',
    '.otile b{display:block;font-size:13.5px;font-weight:700;margin-bottom:2px}',
    '.otile span{display:block;font-size:11px;line-height:1.35;color:var(--text3,#8a8a99)}',
    '.oacts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    '.oseg-all{max-width:100%;overflow-x:auto;scrollbar-width:none;flex-wrap:nowrap}.oseg-all::-webkit-scrollbar{display:none}.oseg-all a{flex-shrink:0}',
    'a.oact{text-decoration:none}.oact.ox-all{flex-basis:100%;color:#d795ff;border-color:rgba(176,56,249,.45)}.oact.ox-all svg{width:11px;height:auto}',
    '.oact{flex:1;min-width:130px;display:flex;align-items:center;justify-content:center;gap:7px;padding:12px;border-radius:13px;border:1px solid rgba(255,255,255,.1);',
    'background:rgba(255,255,255,.04);color:var(--text,#fff);font:700 12.5px "Space Grotesk",system-ui,sans-serif;cursor:pointer;text-decoration:none}',
    '.oact.pri{background:linear-gradient(135deg,#b038f9,#635bff);border-color:transparent;box-shadow:0 6px 20px rgba(176,56,249,.35)}',
    '.ores{display:flex;flex-direction:column;gap:6px}',
    '.ores button{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:var(--text,#fff);text-align:left;cursor:pointer;font:600 13.5px "Space Grotesk",system-ui,sans-serif}',
    '.ores button em{margin-left:auto;font-style:normal;font:700 10px monospace;color:var(--text3,#888);letter-spacing:.06em}',
    '.ores .none{color:var(--text3,#888);font-size:13px;padding:8px 2px}',
    /* toasts */
    '.otoasts{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(20px + var(--sab));z-index:10100;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(420px,calc(100vw - 24px))}',
    '@media (max-width:760px){.otoasts{bottom:auto;top:calc(var(--sat) + 60px)}}',
    '.otoast{pointer-events:auto;display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border-radius:14px;background:rgba(22,18,32,.97);border:1px solid rgba(176,56,249,.4);',
    'box-shadow:0 10px 34px rgba(0,0,0,.5);color:#fff;font:600 13px "Space Grotesk",system-ui,sans-serif;animation:otIn .3s cubic-bezier(.2,.9,.25,1)}',
    '.otoast.out{animation:otOut .25s ease forwards}',
    '.otoast i{width:8px;height:8px;border-radius:50%;background:#61e970;box-shadow:0 0 10px #61e970;flex-shrink:0}',
    '.otoast i.rm{background:#8a8a99;box-shadow:none}',
    '.otoast button{margin-left:auto;background:none;border:0;color:#d795ff;font:800 11px "Space Grotesk",system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;padding:4px}',
    '@keyframes otIn{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}',
    '@media (max-width:760px){.otoast{animation-name:otInTop}}',
    '@keyframes otInTop{from{opacity:0;transform:translateY(-14px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes otOut{to{opacity:0;transform:translateY(10px)}}',
    /* header, panes, press feedback */
    '.nav{transition:box-shadow .25s,background .25s}',
    'body.o-scrolled .nav{background:rgba(10,10,14,.96)!important;box-shadow:0 8px 30px rgba(0,0,0,.55)!important}',
    '.opill{display:none}',
    '.osbtn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 10px 0 11px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);',
    'color:var(--text3,#8a8a99);font:600 12px "Space Grotesk",system-ui,sans-serif;cursor:pointer;margin-right:8px;transition:border-color .15s,color .15s}',
    '.osbtn:hover{border-color:rgba(176,56,249,.5);color:var(--text,#fff)}',
    '.osbtn kbd{font:700 10px monospace;padding:1px 5px;border-radius:4px;border:1px solid rgba(255,255,255,.15)}',
    '.osbtn .oi{width:15px;height:15px}',
    '@media (max-width:760px){.osbtn{display:none}}',
    '@media (max-width:760px){.opill{display:inline-flex}.opill a{padding:5px 10px;font-size:10px}}',
    '.pane.active{animation:oPane .28s cubic-bezier(.2,.9,.25,1)}',
    '@keyframes oPane{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    'button,.nav-tab,.sb-card,.score-game,.leg-chip{-webkit-tap-highlight-color:transparent}',
    '.sb-card,.score-game,.home-stat,.factor-card{transition:transform .15s ease,border-color .15s ease,box-shadow .2s ease}',
    '@media (hover:hover){.sb-card:hover,.factor-card:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.35)}}',
    '.sb-card:active,.score-game:active{transform:scale(.98)}',
    /* what's new */
    '.onew{position:fixed;inset:0;z-index:10200;display:flex;align-items:flex-end;justify-content:center;background:rgba(4,4,8,.6);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);padding:0 0 var(--sab);animation:oFade .25s}',
    '@media (min-width:761px){.onew{align-items:center}}',
    '.onew-card{width:min(460px,100vw);border-radius:22px 22px 0 0;padding:22px 20px 20px;background:linear-gradient(180deg,rgba(32,22,48,.99),rgba(14,14,18,.99));border:1px solid rgba(176,56,249,.35);animation:otIn .35s cubic-bezier(.2,.9,.25,1)}',
    '@media (min-width:761px){.onew-card{border-radius:20px}}',
    '.onew-card h3{margin:6px 0 4px;font-size:21px}',
    '.onew-card .eb{font:800 10px monospace;letter-spacing:.16em;color:#d795ff;text-transform:uppercase}',
    '.onew-card ul{list-style:none;padding:0;margin:14px 0 18px;display:flex;flex-direction:column;gap:10px}',
    '.onew-card li{display:flex;gap:10px;font-size:13.5px;line-height:1.45;color:var(--text2,#ccc)}',
    '.onew-card li .oi{color:#d795ff;margin-top:1px}',
    '@keyframes oFade{from{opacity:0}to{opacity:1}}',
    '@media (prefers-reduced-motion: reduce){.osheet,.otile,.otoast,.pane.active,.onew-card{animation:none!important;transition:none!important}}',
  ].join('\n');

  // ── 3. bottom bar ─────────────────────────────────────────────────────
  var current = null;
  function buildBar() {
    var bar = el('nav', 'obar');
    bar.setAttribute('aria-label', 'Primary');
    S.bar.forEach(function (b) {
      var btn = el('button', 'obar-i' + (b[3] ? ' big' : ''),
        (b[3] ? '<span class="ob-dot">' + svg(b[2]) + '</span>' : svg(b[2])) + '<span>' + b[1] + '</span>');
      btn.dataset.tab = b[0];
      btn.addEventListener('click', function () {
        buzz();
        if (current === b[0]) { window.scrollTo({top: 0, behavior: reduce ? 'auto' : 'smooth'}); return; }
        go(b[0]);
      });
      bar.appendChild(btn);
    });
    var more = el('button', 'obar-i', svg('more') + '<span>More</span>');
    more.dataset.more = '1';
    more.addEventListener('click', function () { buzz(); openSheet(); });
    bar.appendChild(more);
    document.body.appendChild(bar);
  }
  function syncActive(tab) {
    current = tab;
    var inBar = S.bar.some(function (b) { return b[0] === tab; });
    document.querySelectorAll('.obar-i').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === tab || (!inBar && b.dataset.more === '1' && tab !== 'home'));
    });
    document.querySelectorAll('.otile[data-tab]').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === tab); });
  }

  // ── 4. sheet (menu + search) ──────────────────────────────────────────
  var sheet, sheetBg, lastFocus;
  function buildSheet() {
    sheetBg = el('div', 'osheet-bg');
    sheet = el('section', 'osheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Menu');
    var seg = sportSeg('oseg-all');
    sheet.innerHTML =
      '<div class="osheet-grip"></div>' +
      '<div class="osheet-head"><div class="osheet-title">Onyx ' + S.name + '</div>' + seg +
      '<button class="osheet-x" aria-label="Close menu">' + svg('x') + '</button></div>' +
      '<label class="osearch">' + svg('search') + '<input type="search" placeholder="Search pages' + (SITE === 'nba' ? ', players' : SITE === 'mlb' ? ', hitters' : ', teams, players') + '" aria-label="Search" autocomplete="off"><kbd>/</kbd></label>' +
      '<div class="ores" hidden></div>' +
      '<div class="ogrid">' + S.tabs.map(function (t, i) {
        return '<button class="otile" data-tab="' + t[0] + '" style="transition-delay:' + (reduce ? 0 : 25 * i) + 'ms">' + svg(t[2]) +
          '<div><b>' + esc(t[1]) + '</b><span>' + esc(t[3]) + '</span></div></button>';
      }).join('') + '</div>' +
      '<div class="oacts">' +
      '<a class="oact ox-all" href="home.html#my">' + OX_MARK + 'My Onyx: players and bets</a>' +
      '<a class="oact ox-all" href="home.html">' + OX_MARK + 'All Onyx sports</a>' +
      '<button class="oact pri" data-act="slip">' + svg('slip') + 'Parlay builder</button>' +
      '<button class="oact" data-act="share">' + svg('share') + 'Share Onyx</button>' +
      '<button class="oact" data-act="new">' + svg('spark') + "What's new</button></div>";
    document.body.appendChild(sheetBg);
    document.body.appendChild(sheet);
    sheetBg.addEventListener('click', closeSheet);
    sheet.querySelector('.osheet-x').addEventListener('click', closeSheet);
    sheet.querySelectorAll('.otile').forEach(function (t) {
      t.addEventListener('click', function () { buzz(); closeSheet(); go(t.dataset.tab); });
    });
    sheet.querySelector('[data-act="slip"]').addEventListener('click', function () {
      closeSheet();
      try {
        if (typeof parlayMode !== 'undefined' && !parlayMode && typeof parlayToggle === 'function') parlayToggle();
        else if (typeof renderParlaySlip === 'function') renderParlaySlip();
        var fab = document.getElementById('parlayFab');
        if (fab) fab.scrollIntoView({block: 'end'});
        toast(parlayCount() ? 'Parlay builder open · ' + parlayCount() + ' leg' + (parlayCount() > 1 ? 's' : '')
                            : 'Parlay builder on: tap + on any line to add a leg');
      } catch (e) { console.error(e); }
    });
    sheet.querySelector('[data-act="share"]').addEventListener('click', function () {
      var data = {title: 'Onyx Sports · ' + S.name, text: SITE === 'nba' ? 'NBA points, rebounds and assists projected nightly vs Onyx lines'
        : SITE === 'mlb' ? 'Daily MLB home run model vs Onyx lines' : 'Onyx ' + S.name + ': live games, Onyx lines and the model', url: location.href.split('#')[0]};
      if (navigator.share) navigator.share(data).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(data.url).then(function () { toast('Link copied'); }).catch(function () {});
    });
    sheet.querySelector('[data-act="new"]').addEventListener('click', function () { closeSheet(); showWhatsNew(true); });
    var input = sheet.querySelector('input');
    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var f = sheet.querySelector('.ores button'); if (f) f.click(); }
    });
    swipeDown(sheet, closeSheet);
  }
  // swipe down to dismiss a bottom sheet, only from its top (a sheet
  // scrolled into its content scrolls instead)
  function swipeDown(node, close) {
    var y0 = null, dy = 0;
    node.addEventListener('touchstart', function (e) {
      if (node.scrollTop > 0 || e.target.closest('input,select,textarea,.tbl,.tbl-wrap')) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; node.style.transition = 'none';
    }, {passive: true});
    node.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      node.style.transform = 'translateY(' + dy + 'px)';
    }, {passive: true});
    node.addEventListener('touchend', function () {
      if (y0 == null) return;
      node.style.transition = ''; node.style.transform = '';
      if (dy > 90) close();
      y0 = null;
    });
  }
  function openSheet(focusSearch) {
    if (!sheet) return;
    lastFocus = document.activeElement;
    syncActive(current);
    sheetBg.classList.add('open');
    sheet.classList.add('open');
    document.body.style.overflow = 'hidden';
    var input = sheet.querySelector('input');
    input.value = ''; search('');
    if (focusSearch) setTimeout(function () { input.focus(); }, 60);
  }
  function closeSheet() {
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    sheetBg.classList.remove('open');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) try { lastFocus.focus({preventScroll: true}); } catch (e) {}
  }

  function playerIndex() {
    var out = [];
    try {
      if (typeof window.OX_SEARCH === 'function') {
        out = window.OX_SEARCH(go) || [];
      } else if (IS_NBA && typeof D !== 'undefined' && D.players) {
        D.players.forEach(function (p) {
          if (p.out || !p.proj) return;
          out.push({label: p.name, sub: p.team + ' · ' + (p.proj.pts != null ? p.proj.pts.toFixed(1) + ' pts' : ''), run: function () { go('board'); if (typeof openPlayer === 'function') openPlayer(p.pid); }});
        });
      } else if (!IS_NBA && typeof RESULTS !== 'undefined' && RESULTS) {
        RESULTS.forEach(function (r) {
          if (!r.batter_name) return;
          var pr = r.hr_prob != null ? (r.hr_prob * (r.hr_prob <= 1 ? 100 : 1)).toFixed(1) + '% HR' : '';
          out.push({label: r.batter_name, sub: (r.team || '') + (pr ? ' · ' + pr : ''), run: function () { if (typeof openPlayerCard === 'function') openPlayerCard(r.batter_name); }});
        });
      }
    } catch (e) {}
    return out;
  }
  function norm(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function search(q) {
    var res = sheet.querySelector('.ores'), grid = sheet.querySelector('.ogrid');
    q = norm(q).trim();
    if (!q) { res.hidden = true; grid.hidden = false; return; }
    var hits = [];
    S.tabs.forEach(function (t) {
      if (norm(t[1] + ' ' + t[3]).indexOf(q) >= 0) hits.push({label: t[1], sub: 'PAGE', run: function () { go(t[0]); }});
    });
    playerIndex().forEach(function (p) { if (norm(p.label).indexOf(q) >= 0) hits.push(p); });
    hits = hits.slice(0, 12);
    res.innerHTML = hits.length ? '' : '<div class="none">Nothing matches "' + esc(q) + '"</div>';
    hits.forEach(function (h) {
      var b = el('button', '', '<span>' + esc(h.label) + '</span><em>' + esc(h.sub) + '</em>');
      b.addEventListener('click', function () { buzz(); closeSheet(); h.run(); });
      res.appendChild(b);
    });
    res.hidden = false; grid.hidden = true;
  }

  // ── 5. toasts ─────────────────────────────────────────────────────────
  var stack;
  function toast(msg, opts) {
    opts = opts || {};
    if (!stack) { stack = el('div', 'otoasts'); stack.setAttribute('role', 'status'); stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack); }
    var t = el('div', 'otoast', '<i class="' + (opts.rm ? 'rm' : '') + '"></i><span>' + esc(msg) + '</span>');
    if (opts.action) {
      var b = el('button', '', esc(opts.action));
      b.addEventListener('click', function () { opts.onAction && opts.onAction(); t.remove(); });
      t.appendChild(b);
    }
    stack.appendChild(t);
    while (stack.children.length > 3) stack.firstChild.remove();
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 260); }, opts.ms || 2600);
  }
  window.OX_TOAST = toast;   // pages raise live alerts through the same toast
  // ── My bets: every Onyx bet opened from the app, kept on this device ──
  // Pages describe a selection through window.OX_SELINFO(sel) and react to a
  // logged bet through window.OX_ONBET(rec) (a player prop follows the player).
  // This is what was opened on Onyx from here, not the Onyx account itself.
  var lastTap = '';
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button,a,[onclick]') : null;
    if (!t) return;
    lastTap = (t.getAttribute('aria-label') || t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (t.tagName === 'A' && /onyxodds\.com\/share/.test(t.href || '')) logBet(t.href, lastTap);
  }, true);
  // My bets keep 24 hours: last night's bets (and their players' live follows) clear themselves
  var BET_KEEP_MS = 24 * 3600e3;
  function myBets() {
    var all; try { all = JSON.parse(localStorage.getItem('onyxMyBets') || '[]') || []; } catch (e) { return []; }
    var now = Date.now(), keep = all.filter(function (b) { return now - (b.t || Date.parse(b.at) || 0) < BET_KEEP_MS; });
    if (keep.length !== all.length) { try { localStorage.setItem('onyxMyBets', JSON.stringify(keep)); } catch (e) {} }
    return keep;
  }
  function logBet(url, label) {
    var sels = [], m, re = /selection=([^&]+)/g;
    while ((m = re.exec(url))) sels.push(decodeURIComponent(m[1]));
    if (!sels.length) return;
    var legs = sels.map(function (x) {
      var i = null; try { i = window.OX_SELINFO ? window.OX_SELINFO(x) : null; } catch (e) {}
      return Object.assign({sel: x}, i || {});
    });
    var all = myBets(), now = Date.now();
    var key = sels.slice().sort().join(',');
    if (all.some(function (b) { return b.key === key && now - b.t < 60000; })) return;
    var rec = {t: now, at: new Date(now).toISOString(), sport: SITE, key: key, legs: legs,
               label: legs.length === 1 && legs[0].label ? legs[0].label : (legs.length > 1 ? legs.length + '-leg parlay' : label)};
    all.push(rec);
    try { localStorage.setItem('onyxMyBets', JSON.stringify(all.slice(-200))); } catch (e) {}
    try { if (window.OX_ONBET) window.OX_ONBET(rec); } catch (e) {}
    toast('Saved to My bets: ' + rec.label, {action: 'View', onAction: function () { location.href = 'home.html#my'; }});
  }
  var _open = window.open;
  window.open = function (u) {
    try { if (/onyxodds\.com\/share/.test(String(u))) logBet(String(u), lastTap); } catch (e) {}
    return _open.apply(window, arguments);
  };
  window.OX_MYBETS = myBets;
  function parlayCount() { try { return typeof parlaySlip !== 'undefined' && parlaySlip ? parlaySlip.length : 0; } catch (e) { return 0; } }

  // ── 6. hooks into the page ────────────────────────────────────────────
  function hook() {
    if (typeof window.gotoTab === 'function') {
      var og = window.gotoTab;
      window.gotoTab = function (t) {
        var r = og.apply(this, arguments);
        syncActive(t);
        return r;
      };
    }
    if (typeof window.renderParlaySlip === 'function') {
      var orp = window.renderParlaySlip;
      var last = parlayCount();
      window.renderParlaySlip = function () {
        var r = orp.apply(this, arguments);
        var n = parlayCount();
        if (n > last) {
          buzz();
          var leg = parlaySlip[parlaySlip.length - 1] || {};
          toast('Added ' + (leg.label || 'leg') + ' · ' + n + ' leg' + (n > 1 ? 's' : ''),
                n >= 2 && typeof parlayBuild === 'function' ? {action: 'Bet on Onyx', onAction: function () { parlayBuild(); }} : {});
        } else if (n < last) {
          toast(n ? 'Leg removed · ' + n + ' left' : 'Parlay cleared', {rm: true, ms: 1800});
        }
        last = n;
        return r;
      };
    }
    // the NBA player card handles its own swipe-down (it flips, so it needs both faces)
    var ham = document.getElementById('navHamburger');
    if (ham) {
      ham.removeAttribute('onclick');
      ham.addEventListener('click', function (e) { e.preventDefault(); buzz(); openSheet(); });
    }
    // MLB / NBA switch in the phone header
    var right = document.querySelector('.nav-right');
    if (right) {
      // the phone header pill: this sport and its closest sibling
      var pair = SITE === 'nba' || SITE === 'mlb' ? ['mlb', 'nba'] : SITE === 'nfl' || SITE === 'cfb' ? ['nfl', 'cfb'] : null;
      if (pair) {
        var pill = el('div', 'oseg opill', ALL.filter(function (a) { return pair.indexOf(a[0]) > -1; }).map(function (a) {
          return '<a href="' + a[2] + '"' + (a[0] === SITE ? ' class="on" aria-current="page"' : '') + '>' + a[1] + '</a>';
        }).join(''));
        right.insertBefore(pill, right.firstChild);
      }
      // the Onyx mark: back to Onyx Sports, every sport in one place
      var hub = el('a', 'ox-hub', OX_MARK);
      hub.href = 'home.html'; hub.setAttribute('aria-label', 'Onyx Sports: all sports'); hub.title = 'Onyx Sports';
      right.insertBefore(hub, right.firstChild);
      var sb = el('button', 'osbtn', svg('search') + 'Search <kbd>' + (/Mac/.test(navigator.platform) ? '⌘K' : '/') + '</kbd>');
      sb.setAttribute('aria-label', 'Search pages and players');
      sb.addEventListener('click', function () { openSheet(true); });
      right.insertBefore(sb, right.firstChild);
    }
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { document.body.classList.toggle('o-scrolled', window.scrollY > 8); ticking = false; });
    }, {passive: true});
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
      var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (!typing && (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'))) { e.preventDefault(); openSheet(true); }
    });
  }

  // ── 6b. the Onyx footer: the giant raster ONYX (onyx.js) and every sport ─
  function siteFooter() {
    if (document.querySelector('.ox-sitefoot')) return;
    var sports = ALL.map(function (a) { return [a[3], a[2], a[0] === SITE]; });
    var f = el('footer', 'ox-sitefoot',
      '<div class="row"><div class="links">' + sports.map(function (x) {
        return x[1] ? '<a href="' + x[1] + '"' + (x[2] ? ' class="on" aria-current="page"' : '') + '>Onyx ' + x[0] + '</a>'
                    : '<a class="soon" aria-disabled="true">Onyx ' + x[0] + ' · soon</a>';
      }).join('') + '</div><a class="ox-btn sm" href="home.html">Onyx Sports</a></div>' +
      '<div class="ox-giant" data-ox-host><canvas data-ox-art="wordmark" data-ox-tone="purple" aria-label="Onyx"></canvas></div>' +
      '<small>Onyx Sports Data is research: projections are estimates, not guarantees. All prices are Onyx prices. Must be of legal age in your state to play; if you or someone you know has a gambling problem, call 1-800-GAMBLER.</small>');
    document.body.appendChild(f);
    if (window.OnyxArt) OnyxArt.scan(f);
  }

  // ── 7. what's new (once per release, never for automation) ───────────
  function showWhatsNew(force) {
    var seen = false;
    try { seen = localStorage.getItem(WHATS_NEW) === '1'; } catch (e) {}
    if ((seen && !force) || (navigator.webdriver && !force)) return;
    var items = [
      ['more', 'A new menu at the bottom, in thumb reach. Tap More for every page, search and the MLB / NBA switch.'],
      ['search', 'Search any page or player: tap More, or press / on a keyboard.'],
      ['slip', 'Parlay legs confirm with a pop-up, and two or more legs go to Onyx in one tap.'],
      IS_NBA ? ['games', 'Live court: shot chart, possession and play-by-play for every NBA game.']
             : ['games', 'Games is the big button in the middle: live gamecasts one tap away.'],
      ['model', IS_NBA ? 'The NBA model now builds from three seasons of history, aged and regressed to role.'
                       : 'Onyx Basketball is live: points, rebounds and assists vs Onyx lines.'],
    ];
    items.unshift(['plays', 'New: Onyx NFL, College Football, NHL, Tennis and Golf. Live games, every Onyx line, and models switching on as they pass their tests.']);
    items.unshift(['home', 'Onyx Sports: every sport in one place. Tap the Onyx mark up top for the new home, with NFL, NHL, tennis and golf on the way.']);
    var w = el('div', 'onew', '<div class="onew-card" role="dialog" aria-modal="true" aria-label="What\'s new">' +
      '<div class="eb">What\'s new</div><h3>Onyx Sports</h3><ul>' +
      items.map(function (i) { return '<li>' + svg(i[0]) + '<span>' + esc(i[1]) + '</span></li>'; }).join('') +
      '</ul><button class="oact pri" style="width:100%">Let\'s go</button></div>');
    function done() { try { localStorage.setItem(WHATS_NEW, '1'); } catch (e) {} w.remove(); }
    w.querySelector('button').addEventListener('click', done);
    w.addEventListener('click', function (e) { if (e.target === w) done(); });
    document.body.appendChild(w);
  }

  // ── boot ──────────────────────────────────────────────────────────────
  function boot() {
    var st = el('style'); st.id = 'onyx-ui'; st.textContent = CSS; document.head.appendChild(st);
    fixSafeArea();
    window.addEventListener('orientationchange', function () { setTimeout(fixSafeArea, 300); });
    buildBar();
    buildSheet();
    siteFooter();
    hook();
    var t0 = (location.hash || '').slice(1);
    syncActive(typeof currentTab !== 'undefined' ? currentTab : (typeof curTab !== 'undefined' ? curTab : (t0 || 'home')));
    setTimeout(function () { showWhatsNew(false); }, 1200);
    window.OnyxUI = {toast: toast, openMenu: openSheet, closeMenu: closeSheet, swipeDown: swipeDown, buzz: buzz};
  }
  // ticker pace: every score / picks ticker slides its track -50% (two
  // identical halves), so a fixed duration made a 56-game college football
  // slate race and a 3-game night crawl. Measure the real width after each
  // refresh and set the duration for one steady reading speed everywhere.
  var TICK_PX_S = 38;
  function paceTickers() {
    var els = document.querySelectorAll('.score-ticker-track, .hero-ticker');
    Array.prototype.forEach.call(els, function (el) {
      var half = el.scrollWidth / 2;
      if (!half || el.style.animationName === 'none' || el.style.animation === 'none') return;
      var last = +el.getAttribute('data-pace-w') || 0;
      if (last && Math.abs(half - last) / last < 0.04) return;      // same content: leave the loop alone
      el.setAttribute('data-pace-w', String(Math.round(half)));
      el.style.animationDuration = Math.max(20, Math.round(half / TICK_PX_S)) + 's';
    });
  }
  function watchTickers() {
    paceTickers();
    if (!window.MutationObserver) return;
    var pend = 0;
    var mo = new MutationObserver(function () { if (!pend) pend = setTimeout(function () { pend = 0; paceTickers(); }, 120); });
    Array.prototype.forEach.call(document.querySelectorAll('.score-ticker-track, .hero-ticker'), function (el) {
      mo.observe(el, {childList: true, subtree: true, characterData: true});
    });
    window.addEventListener('resize', function () { setTimeout(paceTickers, 200); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(paceTickers);
  }
  window.OX_PACE_TICKERS = paceTickers;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { boot(); watchTickers(); });
  else { boot(); watchTickers(); }
})();
