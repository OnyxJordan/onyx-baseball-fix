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
// a sign-in link that landed on any page but My Onyx (Supabase sends people to the Site URL, the
// MLB front page, when the link's own address is not on its allow list): carry it to the
// Account page, where accounts.js finishes signing in
(function () {
  try {
    if (/(^|[#&])(access_token|error_description|error_code)=/.test(location.hash) && !/(home|account)\.html$/.test(location.pathname))
      location.replace(location.pathname.replace(/[^\/]*$/, '') + 'account.html' + location.hash);
  } catch (e) {}
})();

(function () {
  'use strict';
  var IS_NBA = /nba\.html/.test(location.pathname) || typeof NBA_DATA !== 'undefined';
  // the Onyx Sports pages that are not a sport site (the hub, Onyx Picks, Account, How it
  // works, the scorecard, the college basketball depth charts): no sport header of their own,
  // so this file gives them the standard one (11/2, "one experience across the board").
  // The hub keeps its own onyxodds.com header and gets the shared controls in it.
  var FILE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var PAGE_KEYS = {'home.html': ['home', 'Sports'], 'picks.html': ['picks', 'Picks'], 'account.html': ['account', 'Account'],
                   'how.html': ['how', 'How it works'], 'scorecard.html': ['scorecard', 'Scorecard'], 'cbb-players.html': ['cbbp', 'College Basketball']};
  var IS_PAGE = !window.OX_SITE && !IS_NBA && !document.querySelector('nav.nav');
  var PAGE = IS_PAGE ? (PAGE_KEYS[FILE] || ['page', 'Sports']) : null;
  var IS_HUB = IS_PAGE && !!document.querySelector('.ox-head .ox-acts');
  // every Onyx Sports page: the sport pages built from sport_shell.html set
  // window.OX_SITE before this script runs; MLB and NBA are detected
  var SITE = window.OX_SITE || (IS_NBA ? 'nba' : IS_PAGE ? 'page' : 'mlb');
  // ranked by daily importance (10/31): NFL, NBA, NHL, Golf, Tennis, College Football, College Basketball (11/2), MLB
  var ALL = [['nfl', 'NFL', 'nfl.html', 'NFL'], ['nba', 'NBA', 'nba.html', 'Basketball'], ['nhl', 'NHL', 'nhl.html', 'NHL'],
             ['golf', 'Golf', 'golf.html', 'Golf'], ['tennis', 'Tennis', 'tennis.html', 'Tennis'],
             ['cfb', 'CFB', 'cfb.html', 'College Football'], ['cbb', 'CBB', 'cbb.html', 'College Basketball'],
             ['mlb', 'MLB', './', 'Baseball']];
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
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
    bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/>',
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
    user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5"/>',
  };
  function svg(k, cls) { return '<svg class="' + (cls || 'oi') + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[k] || '') + '</svg>'; }

  var SITES = {
    mlb: {
      name: 'Baseball', other: {label: 'NBA', href: 'nba.html'},
      // the same bar as every Onyx Sports page: Home, Plays, Games, Board, More (11/2)
      bar: [['home', 'Home', 'home'], ['power', 'Plays', 'plays'], ['gamecenter', 'Games', 'games', 1], ['board', 'Board', 'board']],
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
      bar: [['home', 'Home', 'home'], ['plays', 'Plays', 'plays'], ['games', 'Games', 'games', 1], ['board', 'Board', 'board']],
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
  ALL.filter(function (a) { return a[0] !== 'mlb' && a[0] !== 'nba'; }).forEach(function (a) {   // MLB and NBA have their own shapes above
    SITES[a[0]] = {name: a[3],
      bar: [['home', 'Home', 'home'], ['plays', 'Plays', 'plays'], ['games', 'Games', 'games', 1], ['board', 'Board', 'board']],
      tabs: [['home', 'Home', 'home', 'Tonight at a glance'], ['games', 'Games', 'games', 'Live scores and the gamecenter'],
             ['board', 'Onyx Board', 'board', 'Every Onyx line'], ['plays', 'Plays', 'plays', 'Model leans and picks'],
             ['model', 'Model', 'model', 'How it works, what is tested']]};
  });
  // the pages that are not a sport site: every entry is a link (5th field), '@my' opens My picks
  SITES.page = {name: PAGE ? PAGE[1] : 'Sports',
    bar: [['home', 'Home', 'home', 0, 'home.html'], ['picks', 'Picks', 'plays', 0, 'picks.html'], ['live', 'Live', 'games', 1, 'home.html#live'], ['@my', 'My picks', 'star']],
    tabs: [['home', 'Onyx Sports', 'home', 'Every sport, tonight at a glance', 'home.html'],
           ['picks', 'Onyx Picks', 'plays', "Today's card and the record", 'picks.html'],
           ['alerts', 'Alerts', 'bell', 'Your push control center', 'picks.html#alerts'],
           ['ask', 'Ask Onyx', 'search', 'Plays or a parlay, built for you', 'home.html#ask'],
           ['top10', "Today's top 10", 'trophy', 'Our favorite plays today', 'home.html#top10'],
           ['live', 'Live now', 'games', 'Every game in play', 'home.html#live'],
           ['account', 'Account', 'user', 'Sign in, your record', 'account.html'],
           ['profile', 'Your profile', 'record', 'Best sport, best bets, picks for you', 'account.html#oxProfile'],
           ['scorecard', 'Scorecard', 'record', 'Every lane, graded', 'scorecard.html'],
           ['lab', 'Rules lab', 'ranks', 'Test any rule', 'scorecard.html#lab'],
           ['how', 'How it works', 'model', 'Every model, explained', 'how.html']]};
  var S = SITES[SITE] || SITES.mlb;
  function goLink(href) { if (href) location.href = href; }

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

  /* the app chrome (bottom bar, hamburger header, bottom sheets) runs on phones AND on
     touch screens up to 1024px wide: the iPhone Duo opens to an 890x626 inner screen, which
     used to get the desktop header with its tabs cut off and no bottom bar. Content layouts
     stay width-based; only the navigation follows the hand. */
  /* 11/4: the real Duo's inner screen (about 811x626 once iOS puts the status bar down the
     right edge) still showed the desktop header, so pointer:coarse alone is not trusted:
     any touch signal (coarse or no-hover pointer, touch points, the installed app) counts,
     and html.ox-touch carries the answer to onyx.css. */
  var mm = function (q) { try { return matchMedia(q).matches; } catch (e) { return false; } };
  var TOUCH = mm('(pointer:coarse)') || mm('(any-pointer:coarse)') || mm('(hover:none)') ||
    (navigator.maxTouchPoints || 0) > 0 || navigator.standalone === true || mm('(display-mode: standalone)');
  if (TOUCH) document.documentElement.classList.add('ox-touch');

  /* the fold (11/4): on the iPhone Duo's unfolded screen the page is laid out as a book, two
     panes with a gutter over the hinge, so nothing sits in the crease flat or half-folded.
     html.ox-fold + --fold-x (the hinge, px from the left), --fold-l (left pane width),
     --fold-r (right pane start) and --fold-rw (right pane width). The exact hinge comes from
     the Viewport Segments API when Safari has it on; otherwise the Duo's inner screen is
     recognised (touch, landscape, 700-1024 wide, 500+ tall) and the hinge sits at the
     physical center: iOS puts the status bar strip down the right edge, so on an 811px
     page it is about 445px in, not at 405. */
  // the visible width: innerWidth grows with anything wider than the screen (13px on the hub in a
  // test), which would move the crease; the visual viewport is the screen itself (867 on the Duo)
  function foldW() { var v = window.visualViewport; return Math.round(v && v.width ? Math.min(v.width * (v.scale || 1), innerWidth) : innerWidth); }
  function foldGeom() {
    var w = foldW(), h = innerHeight;
    try {
      var sg = window.viewport && window.viewport.segments;
      if (sg && sg.length === 2 && Math.abs(sg[0].top - sg[1].top) < 2 && sg[1].left > sg[0].left)
        return {x: (sg[0].right + sg[1].left) / 2, gap: Math.max(16, sg[1].left - sg[0].right + 12)};
    } catch (e) {}
    if (!TOUCH || w < 700 || w > 1024 || w <= h || h < 500) return null;
    // the physical inner screen: what screen reports when it is the inner screen; but the installed
    // app on the Duo reports the COVER screen (466x678) while unfolded, so a page 820-890 wide and
    // 600-700 tall is the Duo's 890-point inner screen (Jordan's readout, 11/4: page 867x669,
    // screen 466x678, angle 270, the status strip on the right, the crease 445 from the left)
    var long = Math.max(screen.width || 0, screen.height || 0), x = w / 2, P = 0;
    if (long > w && long - w < 160) P = long;
    else if (w > 820 && w <= 890 && h >= 600 && h <= 700) P = 890;
    if (P) {
      var ang = (screen.orientation && screen.orientation.angle) || 0;
      // angle 270: the status strip is on the right, the page starts at the screen's left edge;
      // turned the other way (90) the strip is on the left, so the crease is measured from the right
      // + 3: on the phone the crease sits a hair right of the screen's exact middle (Jordan's photos,
      // 11/4: the right-hand card started a touch early)
      x = ang === 90 ? w - P / 2 - 3 : P / 2 + 3;
    }
    if (x < w * 0.35 || x > w * 0.65) x = w / 2;
    return {x: x, gap: 24};
  }
  function applyFold() {
    var g = foldGeom(), r = document.documentElement;
    r.classList.toggle('ox-fold', !!g);
    if (!g) return;
    var x = Math.round(g.x), half = Math.round(g.gap / 2);
    r.style.setProperty('--fold-x', x + 'px');
    r.style.setProperty('--fold-l', (x - half) + 'px');
    r.style.setProperty('--fold-r', (x + half) + 'px');
    r.style.setProperty('--fold-rw', (foldW() - x - half) + 'px');
    r.style.setProperty('--fold-gap', (2 * half) + 'px');
    // pad the page so its content is symmetric around the hinge: equal-column grids then
    // split right on the fold, and the left margin mirrors iOS's status strip on the right
    var items = document.querySelectorAll('.obar > .obar-i').length || 5, lft = Math.ceil(items / 2);
    r.style.setProperty('--ob-l', lft); r.style.setProperty('--ob-r', items - lft);
    var fs = document.getElementById('oxFoldBar') || document.head.appendChild(Object.assign(document.createElement('style'), {id: 'oxFoldBar'}));
    fs.textContent = 'html.ox-fold .obar>.obar-i:nth-child(' + (lft + 1) + '){grid-column-start:' + (lft + 2) + '}';
    var sh = 2 * x - foldW();
    r.style.setProperty('--fold-pl', Math.max(0, sh) + 'px');
    r.style.setProperty('--fold-pr', Math.max(0, -sh) + 'px');
  }
  /* foldFit: after the page draws (and whenever it changes), nothing may straddle the hinge.
     Grids that span it get their columns split at the fold; a block of text that crosses it
     is kept to the left page. Tables, tickers and the app chrome are left alone. Every
     change is marked and undone when the screen is no longer a book (folded shut). */
  var FOLD_SKIP = 'header,.ox-head,.ox-head-in,.ox-bar,nav,.nav,.obar,.osheet,.osheet-bg,.cx,.cx-bg,.pc,.pc-bg,table,.tbl,.tbl-wrap,svg,canvas,select,input,textarea,' +
    '[class*="ticker"],[class*="marq"],.tk-strip,.ox-marquee,.ox-giant,.sp-art,.ox-hero-art';
  // every style foldFit sets is recorded with what was there, and put back only if it is still ours
  function foldSet(e, k, v) {
    var o = e.__oxf || (e.__oxf = {});
    if (!(k in o)) o[k] = [e.style[k], ''];
    e.style[k] = v; o[k][1] = e.style[k];      // as the browser stores it ("0" reads back "0px")
    e.setAttribute('data-oxf', '');
  }
  function foldUndo() {
    document.querySelectorAll('[data-oxf]').forEach(function (e) {
      var o = e.__oxf || {};
      Object.keys(o).forEach(function (k) { if (e.style[k] === o[k][1]) e.style[k] = o[k][0]; });
      e.__oxf = null; e.removeAttribute('data-oxf');
    });
  }
  function foldFit() {
    var root = document.documentElement;
    if (!root.classList.contains('ox-fold')) { foldUndo(); return; }
    var cs = getComputedStyle(root), L = parseFloat(cs.getPropertyValue('--fold-l')), R = parseFloat(cs.getPropertyValue('--fold-r'));
    if (!(R > L)) return;
    var gap = R - L, crosses = function (b) { return b.width > 0 && b.left < R - 1 && b.right > L + 1; };
    var all = document.body.getElementsByTagName('*'), i, e, st, b;
    var twoCols = function (e, st, b, n) {
      var cl = b.left + parseFloat(st.paddingLeft) + parseFloat(st.borderLeftWidth), cr = b.right - parseFloat(st.paddingRight) - parseFloat(st.borderRightWidth);
      // already a spread on the crease (two equal columns, a gap that covers it): leave it
      if (n === 2 && parseFloat(st.columnGap) >= gap && Math.abs((cl + cr) / 2 - (L + R) / 2) < 3) return false;
      var lw = L - cl, rw = cr - R; if (lw < 90 || rw < 90) return false;
      var h = Math.max(1, Math.floor(n / 2));
      var cw = function (w) { return 'minmax(0,' + Math.floor((w - (h - 1) * gap) / h) + 'px)'; };
      foldSet(e, 'gridTemplateColumns', 'repeat(' + h + ',' + cw(lw) + ') repeat(' + h + ',' + cw(rw) + ')');
      foldSet(e, 'columnGap', gap + 'px');
      return true;
    };
    // grids that span the hinge split their columns at the fold; a one-column list of like cards
    // (the record, today's picks) becomes two columns, one per page
    for (i = 0; i < all.length; i++) {
      e = all[i]; st = getComputedStyle(e);
      if (st.display !== 'grid' && st.display !== 'inline-grid') continue;
      b = e.getBoundingClientRect(); if (!crosses(b) || st.position === 'fixed' || e.closest(FOLD_SKIP)) continue;
      var cols = st.gridTemplateColumns.split(' ').filter(function (t) { return /px$/.test(t); }).map(parseFloat), n = cols.length;
      var vis = [].filter.call(e.children, function (k) { return k.offsetParent !== null; }).length;
      // one card on its own, or a card's own layout (words and a button, one column much wider than
      // the other): keep the whole thing on the left page, never split it across the crease
      // (11/4: a lone "projection" card and the live "value right now" row had their button smeared
      // over the right page)
      if (vis === 1 || (n === 2 && Math.max(cols[0], cols[1]) > 1.8 * Math.min(cols[0], cols[1]))) { leftPage(e, st); continue; }
      if (n < 2) {
        var ks = [].filter.call(e.children, function (k) { return k.offsetParent !== null; });
        if (ks.length < 2 || ks.some(function (k) { return k.tagName !== ks[0].tagName || String(k.className).split(' ')[0] !== String(ks[0].className).split(' ')[0]; })) continue;
        n = 2;
      }
      twoCols(e, st, b, n);
    }
    // text that still crosses, and rows of buttons that wrap, stay on the left page
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), t, seen = [];
    while ((t = tw.nextNode())) {
      if (!t.textContent.trim()) continue;
      var p = t.parentElement; if (!p || seen.indexOf(p) >= 0) continue;
      var rg = document.createRange(); rg.selectNodeContents(t);
      var hit = [].some.call(rg.getClientRects(), crosses); if (!hit) continue;
      while (p && p !== document.body && /^inline/.test(getComputedStyle(p).display)) p = p.parentElement;
      if (!p || p === document.body || seen.indexOf(p) >= 0 || p.closest(FOLD_SKIP)) continue;
      st = getComputedStyle(p); if (st.position === 'fixed' || st.position === 'absolute') continue;
      seen.push(p); leftPage(p, st);
    }
    for (i = 0; i < all.length; i++) {
      e = all[i]; st = getComputedStyle(e);
      if ((st.display !== 'flex' && st.display !== 'inline-flex') || st.flexWrap !== 'wrap' || (e.__oxf && e.__oxf.maxWidth)) continue;
      b = e.getBoundingClientRect(); if (!crosses(b) || st.position === 'fixed' || st.position === 'absolute' || e.closest(FOLD_SKIP)) continue;
      leftPage(e, st);
    }
    function leftPage(p, st) {
      // measured from where the block will sit once it is aligned left: its parent's content edge
      var par = p.parentElement, pb = par.getBoundingClientRect(), ps = getComputedStyle(par);
      var x0 = pb.left + parseFloat(ps.paddingLeft) + parseFloat(ps.borderLeftWidth);
      if (L - x0 < 140) return;                 // the parent itself starts at the hinge: leave it
      foldSet(p, 'maxWidth', Math.floor(L - x0) + 'px'); foldSet(p, 'marginLeft', '0'); foldSet(p, 'marginRight', 'auto');
      foldSet(p, 'alignSelf', 'flex-start'); if (st.textAlign === 'center') foldSet(p, 'textAlign', 'left');
      if (st.justifyContent === 'center') foldSet(p, 'justifyContent', 'flex-start');
    }
  }
  var foldT = 0;
  function foldSoon() { clearTimeout(foldT); foldT = setTimeout(foldFit, 250); }
  window.OnyxFoldFit = foldFit;
  applyFold();
  addEventListener('resize', function () { foldUndo(); foldSoon(); });
  addEventListener('load', foldSoon);
  try { new MutationObserver(function () { if (document.documentElement.classList.contains('ox-fold')) foldSoon(); })
    .observe(document.documentElement, {childList: true, subtree: true}); } catch (e) {}
  foldSoon();
  // a tab switch only flips which pane shows (no new content), so refit after taps and route changes too
  document.addEventListener('click', function () { if (document.documentElement.classList.contains('ox-fold')) foldSoon(); }, true);
  addEventListener('hashchange', foldSoon);
  if (typeof window.gotoTab === 'function' && !window.gotoTab.__oxf) {
    var gt0 = window.gotoTab; window.gotoTab = function () { var r = gt0.apply(this, arguments); foldSoon(); return r; }; window.gotoTab.__oxf = 1;
  }
  addEventListener('resize', applyFold);
  addEventListener('orientationchange', function () { setTimeout(applyFold, 250); });
  try { if (navigator.devicePosture) navigator.devicePosture.addEventListener('change', applyFold); } catch (e) {}
  window.OnyxFold = applyFold;
  var APP = TOUCH ? '(max-width:1024px)' : '(max-width:760px)';
  var DESK = TOUCH ? '(min-width:1025px)' : '(min-width:761px)';
  window.OnyxAppQuery = APP;

  // ── 2. styles ─────────────────────────────────────────────────────────
  var CSS = [
    ':root{--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px)}',
    '.oi{width:18px;height:18px;flex-shrink:0}',
    '.ogrid[hidden],.ores[hidden],.oact[hidden]{display:none!important}',
    /* pull to refresh */
    '.optr{position:fixed;left:50%;top:calc(var(--sat) + 8px);z-index:10100;display:flex;align-items:center;gap:8px;padding:9px 14px 9px 10px;border-radius:999px;',
    'background:rgba(22,16,32,.94);border:1px solid rgba(176,56,249,.5);color:#eee;font:700 12px monospace;letter-spacing:.04em;pointer-events:none;',
    'transform:translate(-50%,-80px);opacity:0;transition:transform .25s,opacity .2s;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
    '.optr-c{display:flex;width:22px;height:22px;align-items:center;justify-content:center;border-radius:50%;background:rgba(176,56,249,.25);color:#d795ff}',
    '.optr-c .oi{width:15px;height:15px}.optr.ready .optr-c{background:#a24bff;color:#fff}',
    '.optr.busy .optr-c{animation:optrSpin .8s linear infinite;background:#a24bff;color:#fff}',
    '@keyframes optrSpin{to{transform:rotate(360deg)}}',
    /* bottom bar */
    '.obar{display:none}',
    '@media '+APP+'{',
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
    /* unfolded iPhone Duo and other touch screens 761-1024px: the bottom sheet, centered at a readable width */
    '@media (min-width:761px) and (max-width:1024px){html.ox-touch .osheet{left:50%;right:auto;width:640px;margin-left:-320px}}',
    /* the fold (iPhone Duo unfolded): the page is a book. Content symmetric around the hinge,
       the bottom bar split into two groups with the hinge between them, and sheets and cards
       open on the right page so the left page stays readable behind them */
    'html.ox-fold body{padding-left:var(--fold-pl)!important;padding-right:var(--fold-pr)!important;box-sizing:border-box}',
    'html.ox-fold .obar{display:grid;padding-left:6px;padding-right:6px;grid-template-columns:repeat(var(--ob-l,3),calc((var(--fold-l) - 6px) / var(--ob-l,3))) var(--fold-gap) repeat(var(--ob-r,2),calc((var(--fold-rw) - 6px) / var(--ob-r,2)))}',
    'html.ox-fold .obar-i{min-width:0}',
    /* the hub header: Live, Sports and Record are in the bottom bar and the menu; on the book they would sit in the crease */
    'html.ox-fold .ox-head .ox-link,html.ox-fold .ox-head .ox-markc{display:none!important}',
    'html.ox-fold .ox-head-in{display:flex!important;justify-content:space-between;align-items:center}',
    'html.ox-fold .osheet{left:var(--fold-r)!important;right:auto!important;width:var(--fold-rw)!important;margin-left:0!important}',
    'html.ox-fold #cx.cx,html.ox-fold #pc.pc{left:calc(var(--fold-r) + 8px)!important;right:auto!important;width:calc(var(--fold-rw) - 16px)!important;height:calc(100vh - var(--sat,0px) - 24px)!important;top:calc(var(--sat,0px) + 12px)!important;bottom:auto!important;transform:translateY(16px) scale(.97)!important;border-radius:20px}',
    'html.ox-fold #cx.cx.open,html.ox-fold #pc.pc.open{transform:none!important}',
    /* closed = hidden from view, taps, Tab and screen readers; visibility flips
       after the slide-out so the closing animation still plays */
    '.osheet{visibility:hidden;transition:transform .32s cubic-bezier(.2,.9,.25,1),opacity .2s,visibility 0s linear .32s}',
    '.osheet.open{visibility:visible;transition:transform .32s cubic-bezier(.2,.9,.25,1),opacity .2s,visibility 0s}',
    '@media '+DESK+'{.osheet{left:50%;right:auto;width:560px;margin-left:-280px;bottom:auto;top:calc(80px + var(--sat));border-radius:18px;border-bottom:1px solid rgba(176,56,249,.28);transform:translateY(-12px) scale(.98);opacity:0;pointer-events:none;transition:transform .2s,opacity .2s}',
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
    '@media '+DESK+'{.ogrid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
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
    '@media '+APP+'{.otoasts{bottom:auto;top:calc(var(--sat) + 60px)}}',
    '.otoast{pointer-events:auto;display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border-radius:14px;background:rgba(22,18,32,.97);border:1px solid rgba(176,56,249,.4);',
    'box-shadow:0 10px 34px rgba(0,0,0,.5);color:#fff;font:600 13px "Space Grotesk",system-ui,sans-serif;animation:otIn .3s cubic-bezier(.2,.9,.25,1)}',
    '.otoast.out{animation:otOut .25s ease forwards}',
    '.otoast i{width:8px;height:8px;border-radius:50%;background:#61e970;box-shadow:0 0 10px #61e970;flex-shrink:0}',
    '.otoast i.rm{background:#8a8a99;box-shadow:none}',
    '.otoast button{margin-left:auto;background:none;border:0;color:#d795ff;font:800 11px "Space Grotesk",system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;padding:4px}',
    '@keyframes otIn{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}',
    '@media '+APP+'{.otoast{animation-name:otInTop}}',
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
    '@media '+APP+'{.osbtn{display:none}}',
    '@media '+APP+'{.opill{display:inline-flex}.opill a{padding:5px 10px;font-size:10px}}',
    /* the shared header controls (11/2): My picks and Account, one component on every page */
    '.ox-hctl{display:inline-flex;align-items:center;gap:6px;flex-shrink:0}',
    '.ox-mypk,.ox-acct{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 11px;margin:0;box-sizing:border-box;',
    'border-radius:9px;border:1px solid var(--ox-stroke,#2f2f2f);background:rgba(255,255,255,.03);color:var(--ox-white,#fcfcfc);',
    'font:500 11px/1 var(--ox-mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;text-decoration:none;white-space:nowrap;cursor:pointer;flex-shrink:0;',
    '-webkit-tap-highlight-color:transparent;transition:border-color .15s,color .15s}',
    '.ox-mypk:hover,.ox-acct:hover{border-color:var(--ox-purple,#b038f9)}',
    '.ox-mypk .oi,.ox-acct .oi{width:15px;height:15px}.ox-mypk .oi{color:var(--ox-lilac,#d795ff)}.ox-acct .oi{color:var(--ox-lilac,#d795ff)}',
    '.ox-mypk b{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--ox-purple,#b038f9);color:#fff;font:700 10.5px/18px var(--ox-mono,monospace);text-align:center;letter-spacing:0;box-sizing:border-box}',
    '.ox-mypk b[hidden]{display:none}',
    '.ox-acct i{display:none;width:7px;height:7px;border-radius:50%;background:#61e970;box-shadow:0 0 8px rgba(97,233,112,.8)}',
    '.ox-acct.in{border-color:rgba(176,56,249,.6)}.ox-acct.in i{display:block}',
    '@media (max-width:1099px){.ox-mypk,.ox-acct{width:34px;padding:0}.ox-mypk>span,.ox-acct>span{display:none}',
    '.ox-mypk b{position:absolute;top:-7px;right:-7px;min-width:17px;height:17px;line-height:17px;font-size:10px;padding:0 4px;box-shadow:0 0 0 2px #0c0c0c}',
    '.ox-acct i{position:absolute;top:5px;right:5px}}',
    '@media (max-width:374px){.opill{display:none!important}}',
    /* a header that does not fit (fitHeader): the tab row scrolls; if it still does not fit,
       the controls go icon-only and the phone sport pill steps aside (it is in the menu too) */
    '.nav.ox-scroll .nav-tabs{flex:1 1 0;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-mask:linear-gradient(90deg,#000 90%,transparent);mask:linear-gradient(90deg,#000 90%,transparent)}',
    '.nav.ox-scroll .nav-tabs::-webkit-scrollbar{display:none}.nav.ox-scroll .nav-tab{flex-shrink:0}.nav.ox-scroll .nav-right{flex-shrink:0}',
    '.nav.ox-tight .opill{display:none!important}',
    '.nav.ox-tight .ox-mypk,.nav.ox-tight .ox-acct{width:34px;padding:0}.nav.ox-tight .ox-mypk>span,.nav.ox-tight .ox-acct>span{display:none}',
    '.nav.ox-tight .ox-mypk b{position:absolute;top:-7px;right:-7px;min-width:17px;height:17px;line-height:17px;font-size:10px;padding:0 4px;box-shadow:0 0 0 2px #0c0c0c}',
    '.nav.ox-tight .ox-acct i{position:absolute;top:5px;right:5px}',
    /* the hub header (home.html) keeps its own look: the controls sit at its right end */
    '.ox-acts .ox-hctl{margin-left:-6px}',
    '.ox-page .ox-hub{color:var(--ox-purple,#b038f9)}',
    '@media '+APP+'{.ox-acts{gap:8px}.ox-acts .ox-hctl{margin-left:0}}',
    /* the standard Onyx Sports header for pages that are not a sport site (picks, account, ...):
       the sport pages\' header, rebuilt here because those pages do not carry the sport stylesheet */
    '.nav.ox-stdnav{height:calc(58px + var(--sat));padding:var(--sat) 20px 0;display:flex;align-items:center;gap:0;box-sizing:border-box;width:100%;',
    'background:rgba(12,12,12,.92);border-bottom:1px solid rgba(255,255,255,.06);position:sticky;top:0;z-index:200;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);',
    'box-shadow:0 1px 0 rgba(255,255,255,.03),0 4px 32px rgba(0,0,0,.5);font-family:"Space Grotesk",system-ui,sans-serif;color:#fff}',
    '.ox-stdnav .nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0;margin-right:28px;color:#fff}',
    '.ox-stdnav .logo-svg{width:34px;height:34px;flex-shrink:0}.ox-stdnav .logo-words{line-height:1}',
    '.ox-stdnav .logo-onyx{font-size:16px;font-weight:800;letter-spacing:.06em;color:#fff}',
    '.ox-stdnav .logo-sub{font-size:9px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#d795ff;margin-top:1px;white-space:nowrap}',
    '.ox-stdnav .nav-tabs{display:flex;flex:1 1 0;min-width:0;overflow-x:auto;scrollbar-width:none}.ox-stdnav .nav-tabs::-webkit-scrollbar{display:none}',
    '.nav.ox-stdnav .nav-tabs>a.nav-tab[href]{display:flex!important}',
    '.ox-stdnav .nav-tab{height:58px;display:flex;align-items:center;padding:0 14px;color:var(--text3,#8a8a99);border-bottom:2px solid transparent;white-space:nowrap;text-decoration:none;flex-shrink:0;box-sizing:border-box}',
    '.ox-stdnav .nav-tab:hover{color:#ddd}.ox-stdnav .nav-tab.active{color:#fff;border-bottom-color:#b038f9}',
    '.ox-stdnav .nav-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-shrink:0;padding-left:10px}',
    '.ox-stdnav .nav-hamburger{display:none;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:none;border:1px solid rgba(255,255,255,.12);color:#ccc;cursor:pointer;flex-shrink:0;padding:0}',
    '.ox-stdnav .nav-hamburger svg{width:18px;height:18px}',
    '@media '+APP+'{.nav.ox-stdnav{height:calc(50px + var(--sat));padding-left:14px;padding-right:14px}.ox-stdnav .nav-tabs{display:none}',
    '.ox-stdnav .nav-hamburger{display:flex;width:36px;height:36px}.ox-stdnav .logo-svg{width:28px;height:28px}.ox-stdnav .logo-onyx{font-size:14px}.ox-stdnav .nav-logo{margin-right:0;min-width:0}.ox-stdnav .nav-right{gap:6px}}',
    /* follow a player: one button everywhere (sport pages, the NBA card, team and player cards, depth charts) */
    '.fl-btn{background:none;border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:999px;color:var(--text2,#cfc8da);font:700 11px monospace;padding:6px 11px;cursor:pointer;white-space:nowrap}',
    '.fl-btn.on{border-color:#b038f9;color:#d795ff;background:rgba(176,56,249,.12)}',
    /* My picks: the tracker, one slide-over on every page */
    '.otrk-sum{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12.5px;line-height:1.45;color:var(--text3,#b9b2c4);margin-bottom:10px}',
    '.otrk-sum b{color:#fff}.otrk-sum a{margin-left:auto;color:#d795ff;font-weight:700;text-decoration:none;white-space:nowrap}',
    '.otrk-rec{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:12px}',
    '.otrk-rec div{padding:9px 4px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);text-align:center;min-width:0}',
    '.otrk-rec b{display:block;font:800 15px monospace;color:#fff}.otrk-rec b.up{color:#61e970}.otrk-rec b.dn{color:#ff8a8a}',
    '.otrk-rec span{display:block;font:600 9px monospace;letter-spacing:.06em;text-transform:uppercase;color:#8a8399;margin-top:3px}',
    '.otrk-h{font:700 10px monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff;margin:4px 2px 8px}',
    '.otrk-list{display:flex;flex-direction:column;gap:6px}',
    '.otrk-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#fff;text-decoration:none;min-width:0}',
    '.otrk-row.live{border-color:rgba(176,56,249,.5);background:rgba(176,56,249,.07)}',
    '.otrk-w{flex:1;min-width:0}.otrk-w b{display:block;font-size:13.5px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.otrk-w span{display:block;font:600 11px monospace;color:#8a8399;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.otrk-s{text-align:right;flex-shrink:0}.otrk-s em{display:inline-block;font:800 10px monospace;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:#cfc8da;font-style:normal}',
    '.otrk-s em.w{background:rgba(97,233,112,.16);color:#61e970}.otrk-s em.l{background:rgba(255,138,138,.14);color:#ff8a8a}.otrk-s em.live{background:rgba(176,56,249,.22);color:#d795ff}',
    '.otrk-s small{display:block;font:700 11px monospace;color:#cfc8da;margin-top:4px}',
    '.otrk-empty{padding:14px;border-radius:12px;border:1px dashed rgba(255,255,255,.16);color:var(--text3,#b9b2c4);font-size:13px;line-height:1.55}',
    '.pane.active{animation:oPane .28s cubic-bezier(.2,.9,.25,1)}',
    '@keyframes oPane{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    'button,.nav-tab,.sb-card,.score-game,.leg-chip{-webkit-tap-highlight-color:transparent}',
    '.sb-card,.score-game,.home-stat,.factor-card{transition:transform .15s ease,border-color .15s ease,box-shadow .2s ease}',
    '@media (hover:hover){.sb-card:hover,.factor-card:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.35)}}',
    '.sb-card:active,.score-game:active{transform:scale(.98)}',
    /* what's new */
    '.onew{position:fixed;inset:0;z-index:10200;display:flex;align-items:flex-end;justify-content:center;background:rgba(4,4,8,.6);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);padding:0 0 var(--sab);animation:oFade .25s}',
    '@media '+DESK+'{.onew{align-items:center}}',
    '.onew-card{width:min(460px,100vw);border-radius:22px 22px 0 0;padding:22px 20px 20px;background:linear-gradient(180deg,rgba(32,22,48,.99),rgba(14,14,18,.99));border:1px solid rgba(176,56,249,.35);animation:otIn .35s cubic-bezier(.2,.9,.25,1)}',
    '@media '+DESK+'{.onew-card{border-radius:20px}}',
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
        if (b[0] === '@my') { openPicks(); return; }
        if (current === b[0]) { window.scrollTo({top: 0, behavior: reduce ? 'auto' : 'smooth'}); return; }
        if (b[4]) { goLink(b[4]); return; }
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
  /* 11/7 (Jordan's screenshot: the bottom bar stuck two thirds of the way down the installed app, the page
     showing beneath it). iOS in the Home Screen app can leave the page's layout height short after the
     keyboard closes (Ask Onyx, the Account code box) or after a system sheet (the notification prompt), and
     a bottom:0 bar then sits at that short bottom. After each of those moments: nudge the scroll so iOS
     recomputes the layout, then measure where the bar ends against the visible screen and move it down by
     the gap. While a text field has focus nothing is touched (the keyboard owns the bottom then). */
  function anchorBar() {
    var bar = document.querySelector('.obar');
    if (!bar || getComputedStyle(bar).display === 'none') return;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button') { bar.style.transform = ''; return; }
    var vv = window.visualViewport;
    if (vv && vv.scale > 1.05) return;                       // pinch-zoomed: leave it
    bar.style.transform = '';
    var vis = vv ? vv.offsetTop + vv.height : innerHeight;
    var gap = Math.round(vis - bar.getBoundingClientRect().bottom);
    if (gap > 2 && gap < 700) bar.style.transform = 'translateY(' + gap + 'px)';
  }
  function reflowKick() {
    var x = window.scrollX, y = window.scrollY;
    try { window.scrollTo(x, y + 1); window.scrollTo(x, y); } catch (e) {}
  }
  var anchorT = [];
  function anchorSoon() {
    anchorT.forEach(clearTimeout);
    anchorT = [60, 350, 900].map(function (ms, i) { return setTimeout(function () { if (i === 0) reflowKick(); anchorBar(); }, ms); });
  }
  function watchAnchor() {
    document.addEventListener('focusout', anchorSoon, true);
    document.addEventListener('focusin', anchorSoon, true);
    ['resize', 'orientationchange', 'pageshow', 'focus'].forEach(function (e) { window.addEventListener(e, anchorSoon); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) anchorSoon(); });
    if (window.visualViewport) { visualViewport.addEventListener('resize', anchorSoon); visualViewport.addEventListener('scroll', anchorBar); }
    window.addEventListener('scroll', function () { if (document.querySelector('.obar[style*="translate"]')) anchorBar(); }, {passive: true});
    anchorSoon();
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
      '<label class="osearch">' + svg('search') + '<input type="search" placeholder="Search pages' + (SITE === 'nba' ? ', players' : SITE === 'mlb' ? ', hitters' : SITE === 'page' ? '' : ', teams, players') + '" aria-label="Search" autocomplete="off"><kbd>/</kbd></label>' +
      '<div class="ores" hidden></div>' +
      '<div class="ogrid">' + S.tabs.map(function (t, i) {
        return '<button class="otile" data-tab="' + t[0] + '"' + (t[4] ? ' data-href="' + esc(t[4]) + '"' : '') + ' style="transition-delay:' + (reduce ? 0 : 25 * i) + 'ms">' + svg(t[2]) +
          '<div><b>' + esc(t[1]) + '</b><span>' + esc(t[3]) + '</span></div></button>';
      }).join('') + '</div>' +
      '<div class="oacts">' +
      // My picks and Account: the same entries on every page (the header has them too)
      '<button class="oact ox-all" data-act="mypicks">' + OX_MARK + '<span class="oact-my">My picks: saved picks and your record</span></button>' +
      '<a class="oact ox-all" href="account.html" data-act="acct">' + OX_MARK + '<span class="oact-ac">Account: sign in, sync every device</span></a>' +
      '<a class="oact ox-all" href="picks.html">' + OX_MARK + 'Onyx Picks: today\'s card and the record</a>' +
      '<a class="oact ox-all" href="home.html#my">' + OX_MARK + 'My Onyx: players and bets</a>' +
      '<a class="oact ox-all" href="home.html">' + OX_MARK + 'All Onyx sports</a>' +
      (SITE === 'page' ? '' : '<button class="oact pri" data-act="slip">' + svg('slip') + 'Parlay builder</button>') +
      '<button class="oact" data-act="share">' + svg('share') + 'Share Onyx</button>' +
      '<button class="oact" data-act="new">' + svg('spark') + "What's new</button>" +
      '<button class="oact" data-act="alerts" hidden>' + svg('bell') + '<span class="oact-al">Win alerts: off</span></button>' +
      '</div>';
    document.body.appendChild(sheetBg);
    document.body.appendChild(sheet);
    sheetBg.addEventListener('click', closeSheet);
    sheet.querySelector('.osheet-x').addEventListener('click', closeSheet);
    sheet.querySelectorAll('.otile').forEach(function (t) {
      t.addEventListener('click', function () { buzz(); closeSheet(); if (t.dataset.href) goLink(t.dataset.href); else go(t.dataset.tab); });
    });
    sheet.querySelector('[data-act="mypicks"]').addEventListener('click', function () { buzz(); closeSheet(); openPicks(); });
    var slipBtn = sheet.querySelector('[data-act="slip"]');
    if (slipBtn) slipBtn.addEventListener('click', function () {
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
    var al = sheet.querySelector('[data-act="alerts"]');
    if (al) al.addEventListener('click', function () {
      // win alerts (saved.js): a pop-up and a phone alert the moment a saved pick cashes
      if (!window.OnyxSaved || !OnyxSaved.setAlerts) return;
      Promise.resolve(OnyxSaved.setAlerts(!OnyxSaved.alertsOn())).then(function () {
        al.querySelector('.oact-al').textContent = 'Win alerts: ' + (OnyxSaved.alertsOn() ? 'on' : 'off');
      });
    });
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
  /* pull to refresh (11/7, Jordan: "slide down to update, it often gets stuck ... on score pages it would be good
     to update when we like"). The installed app has no browser pull-to-refresh, so: at the top of the page,
     pull down past the line and let go, and the page reloads fresh (sw.js is network-first, so a reload is
     always today's data). Only in the installed app (Safari and Chrome already have their own), never from
     inside an open menu, a text field, a sideways scroller or a box that is itself scrolled down. A page can
     set window.onyxRefresh = function () { return promise } to refresh in place instead of reloading. */
  function pullToRefresh() {
    var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (!standalone && !/[?&]ptr=1/.test(location.search)) return;
    var LIMIT = 70, ind = el('div', 'optr', '<span class="optr-c">' + svg('refresh') + '</span><b>Pull to refresh</b>');
    document.body.appendChild(ind);
    var y0 = null, x0 = 0, dy = 0, on = false, busy = false;
    function blocked(t) {
      if (document.querySelector('.osheet.open, .otrk.open, .ox-modal.open') || document.body.style.overflow === 'hidden') return true;
      if (t.closest && t.closest('input,select,textarea,[contenteditable],.optr')) return true;
      for (var n = t; n && n !== document.body && n.nodeType === 1; n = n.parentNode) {
        var cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2 && n.scrollTop > 0) return true;
      }
      return false;
    }
    function show(d) {
      var pull = Math.min(d * 0.55, 110), ready = pull >= LIMIT;
      ind.style.transform = 'translate(-50%,' + (pull - 56) + 'px)';
      ind.style.opacity = Math.min(1, pull / 40);
      ind.classList.toggle('ready', ready);
      ind.querySelector('b').textContent = ready ? 'Release to refresh' : 'Pull to refresh';
      ind.querySelector('.optr-c').style.transform = 'rotate(' + Math.round(pull * 3) + 'deg)';
      return ready;
    }
    function reset() { ind.classList.remove('ready', 'busy'); ind.style.transform = ''; ind.style.opacity = ''; }
    document.addEventListener('touchstart', function (e) {
      if (busy || e.touches.length !== 1 || (window.scrollY || document.documentElement.scrollTop) > 2 || blocked(e.target)) { y0 = null; return; }
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; on = false;
    }, {passive: true});
    document.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      var t = e.touches[0], d = t.clientY - y0, dx = Math.abs(t.clientX - x0);
      if (!on) {
        if (d < 8) { if (d < -4 || dx > 12) y0 = null; return; }
        if (dx > d) { y0 = null; return; }                  // a sideways swipe
        on = true; ind.style.transition = 'none';
      }
      dy = d; show(dy);
    }, {passive: true});
    function end() {
      if (y0 == null || !on) { y0 = null; return; }
      y0 = null; ind.style.transition = '';
      if (!show(dy)) { reset(); return; }
      busy = true; buzz();
      ind.querySelector('.optr-c').style.transform = '';
      ind.classList.add('busy'); ind.style.transform = 'translate(-50%,' + (LIMIT - 56) + 'px)';
      ind.querySelector('b').textContent = 'Updating...';
      var soft = typeof window.onyxRefresh === 'function' ? window.onyxRefresh() : null;
      if (soft && soft.then) soft.then(function () { busy = false; reset(); toast('Updated'); }, function () { location.reload(); });
      else setTimeout(function () { location.reload(); }, 150);
    }
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', function () { y0 = null; reset(); });
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
      if (norm(t[1] + ' ' + t[3]).indexOf(q) >= 0) hits.push({label: t[1], sub: 'PAGE', run: function () { if (t[4]) goLink(t[4]); else go(t[0]); }});
    });
    // every Onyx page, from any page: My picks, Account, Onyx Picks, the sports
    var shared = [['My picks', 'Saved picks and your record', openPicks], ['Account', 'Sign in, sync every device', 'account.html'],
      ['Onyx Picks', "Today's card and the record", 'picks.html'], ['My Onyx', 'Players and bets', 'home.html#my']]
      .concat(ALL.filter(function (a) { return a[0] !== SITE; }).map(function (a) { return ['Onyx ' + a[3], a[1], a[2]]; }));
    shared.forEach(function (x) {
      if (SITE === 'page' && S.tabs.some(function (t) { return t[1] === x[0]; })) return;
      if (norm(x[0] + ' ' + x[1]).indexOf(q) >= 0) hits.push({label: x[0], sub: 'ONYX', run: function () { if (typeof x[2] === 'function') x[2](); else goLink(x[2]); }});
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
    if (SITE === 'page') return;   // My bets are logged on the sport pages, which know each selection's sport
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

  // ── 5b. one account and one tracker on every page (11/2) ──────────────
  // Jordan: "the account page and tracking should live through all sports and pages ... a
  // uniform experience across the board". Every page gets the same two header controls
  // (My picks with its count, Account with the signed-in state), the same My picks slide-over
  // (saved picks followed live + the permanent record, saved.js), and saved.js / accounts.js
  // are loaded wherever a page did not load them itself, so sync and the save star work everywhere.
  function needScript(src) {
    if (document.querySelector('script[src="' + src + '"]')) return;
    var s = document.createElement('script'); s.src = src; s.async = false;
    s.onload = function () { refreshControls(); };
    document.head.appendChild(s);
  }
  // the standard header, for the pages that are not a sport site
  var STD_TABS = [['home', 'Onyx Sports', 'home.html'], ['picks', 'Onyx Picks', 'picks.html'], ['top10', 'Top 10', 'home.html#top10'],
                  ['live', 'Live', 'home.html#live'], ['scorecard', 'Scorecard', 'scorecard.html'], ['how', 'How it works', 'how.html']];
  function stdNav() {
    if (!IS_PAGE || IS_HUB || document.querySelector('nav.nav')) return;
    var n = el('nav', 'nav ox-stdnav');
    n.setAttribute('aria-label', 'Onyx Sports');
    n.innerHTML = '<a class="nav-logo" href="home.html" aria-label="Onyx Sports home">' +
      '<svg class="logo-svg" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="16" fill="#151018" stroke="rgba(176,56,249,.6)" stroke-width="2"/>' +
      '<g transform="translate(19,13) scale(0.26)"><path fill="#b038f9" d="m39.041 109.178 18.493 9.863-33.972 17.945L0 124.384v-84.11l39.041-20.411zm21.918-81.37-18.493-9.863L76.438 0 100 12.603v84.246L60.959 117.26z"/></g></svg>' +
      '<div class="logo-words"><div class="logo-onyx">ONYX</div><div class="logo-sub">' + esc(PAGE[1]) + '</div></div></a>' +
      '<div class="nav-tabs">' + STD_TABS.map(function (t) {
        return '<a class="nav-tab' + (t[0] === PAGE[0] ? ' active" aria-current="page' : '') + '" href="' + t[2] + '">' + esc(t[1]) + '</a>';
      }).join('') + '</div>' +
      '<div class="nav-right"><button class="nav-hamburger" id="navHamburger" aria-label="Menu">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button></div>';
    document.body.insertBefore(n, document.body.firstChild);
  }
  var ctl = null;
  function mountControls() {
    if (document.querySelector('.ox-hctl')) return;
    ctl = el('span', 'ox-hctl');
    ctl.innerHTML = '<button class="ox-mypk" type="button" aria-label="My picks" title="My picks: your saved picks, live, and your record">' + svg('star') +
      '<span>My picks</span><b hidden></b></button>' +
      '<a class="ox-acct" href="account.html" aria-label="Account">' + svg('user') + '<span>Account</span><i></i></a>';
    ctl.querySelector('.ox-mypk').addEventListener('click', function (e) { e.preventDefault(); buzz(); openPicks(); });
    var right = document.querySelector('.nav .nav-right'), acts = document.querySelector('.ox-head .ox-acts');
    if (right) {
      var ham = right.querySelector('.nav-hamburger');
      right.insertBefore(ctl, ham && ham.parentNode === right ? ham : null);
    } else if (acts) {
      var old = document.getElementById('acctNav'); if (old) old.remove();   // the hub's own Sign in link: this replaces it
      acts.appendChild(ctl);
    } else return;
    refreshControls();
    fitHeader();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitHeader);
  }
  // keep the header on screen: measured, because each sport's tab row is a different length
  function fitHeader() {
    var n = document.querySelector('nav.nav'); if (!n) return;
    var over = function () {
      var r = n.querySelector('.nav-right'), vw = document.documentElement.clientWidth;
      if (n.scrollWidth > n.clientWidth + 1 || (r && r.getBoundingClientRect().right > vw + 0.5)) return true;
      // 11/4: on the Duo's 382px cover screen the logo words ran into the first control
      // without overflowing; under 6px of air counts as not fitting
      var lg = n.querySelector('.nav-logo .logo-words') || n.querySelector('.nav-logo');
      if (!lg || !r) return false;
      var lr = lg.getBoundingClientRect().right, first = Infinity;
      [].forEach.call(r.children, function (e) {
        var b = e.getBoundingClientRect(); if (b.width > 0 && b.left < first) first = b.left;
      });
      return first - lr < 6;
    };
    n.classList.remove('ox-scroll', 'ox-tight');
    if (!over()) return;
    if (!n.querySelector('.nav-dropdown')) { n.classList.add('ox-scroll'); if (!over()) return; }   // a dropdown menu would be clipped by a scrolling row
    n.classList.add('ox-tight');
  }
  var fitT = 0;
  addEventListener('resize', function () { clearTimeout(fitT); fitT = setTimeout(fitHeader, 120); });
  function acctState() {
    try { return window.OnyxAccounts ? OnyxAccounts.state() : null; } catch (e) { return null; }
  }
  function savedCount() { try { return window.OnyxSaved ? OnyxSaved.all().length : 0; } catch (e) { return 0; } }
  function refreshControls() {
    var n = savedCount(), st = acctState();
    // signed in: "Account" with the green dot; accounts on and signed out: "Sign in"; accounts off: "Account" (device only)
    var signed = !!(st && st.signedIn), word = signed ? 'Account' : st && st.enabled ? 'Sign in' : 'Account';
    var tip = signed ? 'Signed in as ' + (st.email || '') : st && st.enabled ? 'Sign in: your picks on every device' : 'Account: your picks and record';
    document.querySelectorAll('.ox-hctl').forEach(function (c) {
      var b = c.querySelector('.ox-mypk b');
      b.hidden = !n; b.textContent = n ? String(n) : '';
      c.querySelector('.ox-mypk').setAttribute('aria-label', 'My picks' + (n ? ', ' + n + ' saved' : ''));
      var a = c.querySelector('.ox-acct');
      a.classList.toggle('in', signed);
      a.querySelector('span').textContent = word;
      a.setAttribute('aria-label', tip); a.title = tip;
      a.setAttribute('data-state', signed ? 'in' : st && st.enabled ? 'out' : 'off');
    });
    if (sheet) {
      var my = sheet.querySelector('.oact-my'); if (my) my.textContent = 'My picks' + (n ? ' (' + n + ')' : '') + ': saved picks and your record';
      var ac = sheet.querySelector('.oact-ac'); if (ac) ac.textContent = signed ? 'Account: signed in as ' + (st.email || '') : st && st.enabled ? 'Sign in: your picks on every device' : 'Account: sign in, sync every device';
      var al = sheet.querySelector('[data-act="alerts"]');
      if (al && window.OnyxSaved && OnyxSaved.setAlerts) { al.hidden = false; al.querySelector('.oact-al').textContent = 'Win alerts: ' + (OnyxSaved.alertsOn() ? 'on' : 'off'); }
    }
    if (trk && trk.classList.contains('open')) drawPicks();
    fitHeader();
  }
  addEventListener('onyx-saved', function () { refreshControls(); });
  addEventListener('onyx-account', function () { refreshControls(); });
  addEventListener('onyx-history', function () { if (trk && trk.classList.contains('open')) drawPicks(); });
  addEventListener('storage', function (e) { if (e.key === 'onyxSaved' || e.key === 'onyxHistory') refreshControls(); });

  // the tracker: My picks, the same slide-over from every header, More menu and bottom bar
  var trk = null, trkBg = null, trkLive = {}, trkFocus = null;
  var PAGE_OF = {}; ALL.forEach(function (a) { PAGE_OF[a[0]] = a[2]; });
  var SPN = {nfl: 'NFL', nba: 'NBA', nhl: 'NHL', cfb: 'College Football', cbb: 'College Basketball', tennis: 'Tennis', golf: 'Golf', mlb: 'MLB'};
  function oddsTxt(a) { return a == null ? '' : (a > 0 ? '+' : '') + a; }
  function gameHref(p) {
    var pg = PAGE_OF[p.sport] || 'home.html';
    var gid = (trkLive[p.id] || {}).gid || p.gid;
    return gid && p.sport !== 'nba' && p.sport !== 'mlb' ? pg + '#games:' + gid : pg;
  }
  function whenTxt(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return '';
    try { return new Date(t).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET'; } catch (e) { return ''; }
  }
  function buildPicks() {
    trkBg = el('div', 'osheet-bg');
    trk = el('section', 'osheet otrk');
    trk.setAttribute('role', 'dialog'); trk.setAttribute('aria-modal', 'true'); trk.setAttribute('aria-label', 'My picks');
    trk.innerHTML = '<div class="osheet-grip"></div><div class="osheet-head"><div class="osheet-title">My picks</div>' +
      '<button class="osheet-x" aria-label="Close My picks">' + svg('x') + '</button></div><div class="otrk-body"></div>';
    document.body.appendChild(trkBg); document.body.appendChild(trk);
    trkBg.addEventListener('click', closePicks);
    trk.querySelector('.osheet-x').addEventListener('click', closePicks);
    swipeDown(trk, closePicks);
  }
  function drawPicks() {
    if (!trk) return;
    var O = window.OnyxSaved, body = trk.querySelector('.otrk-body');
    if (!O) { body.innerHTML = '<div class="otrk-empty">Loading your picks...</div>'; return; }
    var P = O.all().slice().sort(function (a, b) { return String(a.start || '').localeCompare(String(b.start || '')); });
    var st = acctState(), signed = st && st.signedIn;
    var R = O.stats ? O.stats() : null, u = R ? R.units : 0;
    var sum = signed ? '<span>Signed in as <b>' + esc(st.email || '') + '</b>. Your picks and record are on every device.</span><a href="account.html">Account</a>'
      : st && st.enabled ? '<span>Saved on this device. <b>Sign in</b> to keep your picks and record on every device.</span><a href="account.html">Sign in</a>'
      : '<span>Saved on this device: tap the star on any play, in any sport, and follow it here all night.</span><a href="account.html">Account</a>';
    var rec = R && R.picks ? '<div class="otrk-h">Your record</div><div class="otrk-rec">' +
      '<div><b>' + R.w + '-' + R.l + (R.p ? '-' + R.p : '') + '</b><span>Record</span></div>' +
      '<div><b>' + (R.rate == null ? '-' : R.rate + '%') + '</b><span>Win rate</span></div>' +
      '<div><b class="' + (u > 0 ? 'up' : u < 0 ? 'dn' : '') + '">' + (u > 0 ? '+' : '') + u.toFixed(2) + '</b><span>Units</span></div>' +
      '<div><b>' + R.pending + '</b><span>To grade</span></div></div>' : '';
    var list = P.length ? '<div class="otrk-h">Saved picks · ' + P.length + '</div><div class="otrk-list">' + P.map(function (p) {
      var t = trkLive[p.id] || {}, lab = {W: ['Won', 'w'], L: ['Lost', 'l'], P: ['Push', ''], up: ['Winning', 'live'], down: ['Losing', 'l']}[t.res];
      var state = lab ? lab : t.state === 'in' ? ['Live', 'live'] : t.state === 'post' ? ['Final', ''] : ['Upcoming', ''];
      var sub = [SPN[p.sport] || String(p.sport || '').toUpperCase(), p.matchup, t.state === 'in' || t.state === 'post' ? '' : whenTxt(p.start)].filter(Boolean).join(' · ');
      return '<a class="otrk-row' + (t.state === 'in' ? ' live' : '') + '" href="' + esc(gameHref(p)) + '">' + (O.btn ? O.btn(p) : '') +
        '<span class="otrk-w"><b>' + esc(p.label || p.name || '') + '</b><span>' + esc(sub) + '</span></span>' +
        '<span class="otrk-s"><em class="' + state[1] + '">' + state[0] + '</em>' +
        '<small>' + (t.cur != null ? 'Now ' + esc(String(t.cur)) : p.price != null ? 'Onyx ' + esc(oddsTxt(p.price)) : '') + '</small></span></a>';
    }).join('') + '</div>'
      : '<div class="otrk-empty">No saved picks right now. Tap the star on any play, in any sport (the Top 10, a sport\'s Plays, a player card, Onyx Picks) and follow it here, live, all night. Every pick you save also counts toward your record.</div>';
    body.innerHTML = '<div class="otrk-sum">' + sum + '</div>' + rec + list +
      '<div class="oacts"><a class="oact ox-all" href="account.html#record">' + OX_MARK + 'Your full record: every pick you saved, graded</a>' +
      '<a class="oact ox-all" href="home.html#my">' + OX_MARK + 'My Onyx: players and bets</a></div>';
  }
  function trackPicks() {
    var O = window.OnyxSaved; if (!O || !O.track) return;
    var now = Date.now();
    var P = O.all().filter(function (p) { var s = Date.parse(p.start); return isNaN(s) || s - 15 * 60e3 <= now; });
    if (!P.length) return;
    Promise.all(P.map(function (p) { return O.track(p).catch(function () { return {p: p}; }); })).then(function (T) {
      T.forEach(function (t) { if (t && t.p) trkLive[t.p.id] = t; });
      if (trk && trk.classList.contains('open')) drawPicks();
    });
  }
  var trkTimer = null;
  function openPicks() {
    if (!trk) buildPicks();
    closeSheet();
    trkFocus = document.activeElement;
    drawPicks();
    trkBg.classList.add('open'); trk.classList.add('open');
    document.body.style.overflow = 'hidden';
    trackPicks();
    clearInterval(trkTimer); trkTimer = setInterval(function () { if (!document.hidden) trackPicks(); }, 30e3);
    if (window.OnyxSaved && OnyxSaved.grade) OnyxSaved.grade();
    try { if (window.gtag) gtag('event', 'my_picks_open', {sport: SITE}); } catch (e) {}
  }
  function closePicks() {
    if (!trk || !trk.classList.contains('open')) return;
    trk.classList.remove('open'); trkBg.classList.remove('open');
    document.body.style.overflow = '';
    clearInterval(trkTimer);
    if (trkFocus && trkFocus.focus) try { trkFocus.focus({preventScroll: true}); } catch (e) {}
  }
  window.OX_OPEN_PICKS = openPicks;

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
    // one header on every sport page (11/2): the menu button sits last in the
    // right-hand controls, as on the engine pages (MLB and NBA had it before them)
    var navRight = document.querySelector('.nav .nav-right');
    if (ham && navRight && ham.parentNode !== navRight) navRight.appendChild(ham);
    if (ham) {
      ham.removeAttribute('onclick');
      ham.addEventListener('click', function (e) { e.preventDefault(); buzz(); openSheet(); });
    }
    // MLB / NBA switch in the phone header
    var right = document.querySelector('.nav-right');
    if (right) {
      // the phone header pill: this sport and its closest sibling
      var pair = SITE === 'nba' || SITE === 'mlb' ? ['mlb', 'nba'] : SITE === 'nfl' || SITE === 'cfb' ? ['nfl', 'cfb'] : SITE === 'cbb' ? ['nba', 'cbb'] : null;
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
      if (e.key === 'Escape') { closeSheet(); closePicks(); }
      var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      if (!typing && (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'))) { e.preventDefault(); openSheet(true); }
    });
  }

  // ── 6b. the Onyx footer: the giant raster ONYX (onyx.js) and every sport ─
  function siteFooter() {
    if (document.querySelector('.ox-sitefoot, .ox-foot')) return;   // the hub has its own footer
    var sports = ALL.map(function (a) { return [a[3], a[2], a[0] === SITE]; });
    var f = el('footer', 'ox-sitefoot',
      '<div class="row"><div class="links">' + sports.map(function (x) {
        return x[1] ? '<a href="' + x[1] + '"' + (x[2] ? ' class="on" aria-current="page"' : '') + '>Onyx ' + x[0] + '</a>'
                    : '<a class="soon" aria-disabled="true">Onyx ' + x[0] + ' · soon</a>';
      }).join('') + '<a href="picks.html">Onyx Picks</a></div><a class="ox-btn sm" href="home.html">Onyx Sports</a></div>' +
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
    stdNav();
    buildBar(); applyFold(); foldSoon(); watchAnchor(); pullToRefresh();
    buildSheet();
    siteFooter();
    hook();
    mountControls();
    // the save star, My picks and sign-in need saved.js (which loads accounts.js): every page gets them
    if (!window.OnyxSaved) needScript('saved.js');
    else if (!window.OnyxAccounts) needScript('accounts.js');
    var t0 = (location.hash || '').slice(1);
    syncActive(PAGE ? PAGE[0] : typeof currentTab !== 'undefined' ? currentTab : (typeof curTab !== 'undefined' ? curTab : (t0 || 'home')));
    setTimeout(function () { showWhatsNew(false); }, 1200);
    window.OnyxUI = {toast: toast, openMenu: openSheet, closeMenu: closeSheet, swipeDown: swipeDown, buzz: buzz,
                     openPicks: openPicks, closePicks: closePicks, refresh: refreshControls};
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
