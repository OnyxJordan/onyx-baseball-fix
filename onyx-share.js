// onyx-share.js - Shareable bet cards (11/16, Jordan: "shareable bet card 100%"). Every slip, quick bet card,
// Studio Lab parlay, cashed ticket and season record can be turned into a branded image, drawn on a <canvas>
// right here (no libraries, no server): the Onyx black with its purple glow and raster art, the real Onyx mark
// and wordmark, every leg with its Onyx price, the ticket price, what $10 pays, the model's chance as a ring,
// the sport chips, a green CASHED stamp or the live chance, and the Onyx footer with the referral code.
// Two sizes: story (1080x1920) and square (1080x1080), switched in the share sheet with a live preview.
// Share: the Web Share API with the PNG and the Onyx link (every selection on the ticket, referrer KR680261);
// without it the image downloads and the link is copied. Counted with gtag('event', 'share_card', {kind}).
// Copy rules: the chance is the model's projection (never a "lock"), all odds are Onyx's, no other book named.
//
//   OnyxShare.open(card)            opens the sheet. card = {kind: 'single'|'parlay'|'season'|'cashed', title,
//                                   legs: [{label, matchup, price, conf, sport, res?, sel?}], price (ticket Onyx price),
//                                   chance (0..1, the model's), sels: [selection ids], stats? (season: {record,
//                                   units, roi (a fraction, 0.084 = +8.4%), best: {label, price, sport} | text,
//                                   sports: [{sport, record, units}]}), live? ({p, now})}
//   OnyxShare.button(card, text)    an HTML string for a share button (the card is kept in a registry and the
//                                   button carries only its key; one delegated click listener opens it)
//   OnyxShare.render(card, size)    the drawn <canvas> ('story' | 'square'); OnyxShare.layout() its text boxes
//   OnyxShare.close(), isOpen(), url(card)
// Loaded on every page by ui.js.
(function () {
  'use strict';
  if (window.OnyxShare) return;
  var REF = 'KR680261';
  var C = {bg: '#0c0c0c', pur: '#b038f9', purD: '#7a2ce0', lil: '#d795ff', grn: '#61e970', red: '#ff8a8a', white: '#fcfcfc', body: '#afa5bd', dim: '#8f879c', line: 'rgba(255,255,255,.09)'};
  var SIZES = {story: [1080, 1920], square: [1080, 1080]};
  var DISPLAY = '"Archivo", "Inter", "Helvetica Neue", Arial, system-ui, sans-serif';
  var MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  var SPORT = {nfl: 'NFL', nba: 'NBA', cfb: 'CFB', cbb: 'CBB', nhl: 'NHL', tennis: 'TENNIS', mlb: 'MLB', golf: 'GOLF'};
  // the real Onyx wordmark and mark (the same paths onyx.js rasterizes)
  var WORD = 'M28.344 0C4.264 0 0 4.076 0 23.472S4.263 46.85 28.344 46.85s28.25-4.03 28.25-23.378C56.595 4.122 52.426 0 28.345 0m12.134 25.018c0 8.948-2.108 11.01-10.447 11.01h-3.326c-8.433 0-10.495-2.015-10.495-11.01v-3.139c0-8.995 2.061-11.057 10.494-11.057h3.327c8.34 0 10.447 2.062 10.447 11.057zM217.667 45.866l-16.852-23.094L216.776.984h-18.459l-7.616 13.618L183.232.984h-34.294l-8.425 15.88-9.097-15.88h-31.39v30.332L84.378.983h-23.19v44.882h14.57V13.741l16.678 32.125h22.067V2.633l17.475 26.742v16.491h16.023V29.61l17.045-26.911 14.796 20.168-16.803 23h19.115l7.97-14.196 8.053 14.196z';
  var MARK = 'm39.041 109.178 18.493 9.863-33.972 17.945L0 124.384v-84.11l39.041-20.411zm21.918-81.37-18.493-9.863L76.438 0 100 12.603v84.246L60.959 117.26z';

  // ── numbers ─────────────────────────────────────────────────────────────────────────────────────────────
  function num(x) { if (x == null || x === '') return null; var n = +String(x).replace(/^\+/, ''); return isFinite(n) ? n : null; }
  function odds(a) { return a == null ? '' : (a > 0 ? '+' : '') + Math.round(a); }
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function amer(d) { return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }
  function pct(p) { return p == null ? '' : p < 0.01 ? (100 * p).toFixed(2) + '%' : p < 0.1 ? (100 * p).toFixed(1) + '%' : Math.round(100 * p) + '%'; }
  function money(x) { return '$' + (x >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2)); }
  function str(s) { return String(s == null ? '' : s).replace(/\s*[\u2014\u2013]\s*/g, ' - ').replace(/\s+/g, ' ').trim(); }   // no em dashes, ever
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function gt(n, o) { try { if (typeof window.gtag === 'function') window.gtag('event', n, o || {}); } catch (e) {} }

  // ── the card, normalized ────────────────────────────────────────────────────────────────────────────────
  function norm(c) {
    c = c || {};
    var legs = (c.legs || []).filter(Boolean).map(function (l) {
      return {label: str(l.label || l.name || 'Leg'), matchup: str(l.matchup), price: num(l.price), conf: num(l.conf), sport: l.sport || c.sport || null,
              res: /^[WLP]$/.test(l.res || '') ? l.res : null, sel: l.sel || null};
    });
    if (!legs.length && c.label) legs = [{label: str(c.label), matchup: str(c.matchup), price: num(c.price), conf: num(c.chance != null ? c.chance : c.conf), sport: c.sport || null, res: c.res || null, sel: c.sel || null}];
    var kind = ['single', 'parlay', 'season', 'cashed'].indexOf(c.kind) >= 0 ? c.kind : legs.length > 1 ? 'parlay' : 'single';
    if (kind === 'single' && legs.length > 1) kind = 'parlay';
    var price = num(c.price);
    if (price == null && legs.length && legs.every(function (l) { return l.price != null; }))
      price = legs.length === 1 ? legs[0].price : amer(legs.reduce(function (m, l) { return m * dec(l.price); }, 1));
    var chance = c.chance !== undefined ? num(c.chance) : legs.length && legs.every(function (l) { return l.conf != null; }) ? legs.reduce(function (m, l) { return m * l.conf; }, 1) : null;
    if (chance != null && !(chance > 0 && chance <= 1)) chance = null;
    legs.forEach(function (l) { if (l.conf != null && !(l.conf > 0 && l.conf <= 1)) l.conf = null; });
    var sels = (c.sels && c.sels.length ? c.sels : legs.map(function (l) { return l.sel; })).filter(Boolean);
    var sp = [];
    legs.forEach(function (l) { if (l.sport && sp.indexOf(l.sport) < 0) sp.push(l.sport); });
    if (!sp.length && c.sport && c.sport !== 'multi') sp.push(c.sport);
    var st = c.stats || {}, rows = (st.sports || st.rows || []).filter(Boolean);
    if (kind === 'season') rows.forEach(function (r) { if (r.sport && sp.indexOf(r.sport) < 0) sp.push(r.sport); });
    var live = c.live && num(c.live.p) != null ? {p: Math.max(0, Math.min(1, num(c.live.p))), now: str(c.live.now)} : null;
    return {kind: kind, title: str(c.title), legs: legs, price: price, chance: chance, sels: sels, sports: sp, live: live, stats: st, rows: rows,
            cashed: kind === 'cashed' || c.res === 'W'};
  }
  function shareUrl(c) {
    var s = (c.sels || []).filter(Boolean);
    return s.length ? 'https://app.onyxodds.com/share?' + s.map(function (x) { return 'selection=' + encodeURIComponent(x); }).join('&') + '&referrer=' + REF
      : 'https://app.onyxodds.com/?referrer=' + REF;
  }
  function headline(c) {
    if (c.kind === 'season') return 'My season on Onyx Sports';
    var n = c.legs.length;
    var what = n > 1 ? n + '-leg parlay' : (c.legs[0] && c.legs[0].label) || 'My Onyx bet';
    return (c.cashed ? 'Cashed on Onyx: ' : 'On Onyx: ') + what + (c.price != null ? ' at ' + odds(c.price) : '');
  }
  function shareText(c) {
    if (c.kind === 'season') {
      var s = c.stats || {};
      return 'My season on Onyx Sports: ' + [recText(s.record), s.units != null ? unitsText(s.units) : '', s.roi != null ? 'ROI ' + roiText(s.roi) : ''].filter(Boolean).join(', ') + '. Bet it on Onyx with code ' + REF + '.';
    }
    var t = headline(c);
    if (c.live) t += '. Live chance to cash ' + pct(c.live.p) + ' (Onyx model)';
    else if (c.chance != null && !c.cashed) t += '. The Onyx model gives it ' + pct(c.chance);
    return t + '. Bet it on Onyx with code ' + REF + '.';
  }

  // ── canvas drawing ──────────────────────────────────────────────────────────────────────────────────────
  var BOXES = [], PANELS = [], W = 0, H = 0;
  function font(x, w, px, fam, wide) {
    x.font = w + ' ' + px + 'px ' + (fam || DISPLAY);
    if ('fontStretch' in x) { try { x.fontStretch = wide ? 'expanded' : 'normal'; } catch (e) {} }
  }
  // shrink to fit, then cut with an ellipsis: returns the text and size that fit maxW
  function fit(x, s, maxW, o) {
    var px = o.px, min = o.min || o.px;
    font(x, o.w, px, o.fam, o.wide);
    while (x.measureText(s).width > maxW && px > min) { px -= 2; font(x, o.w, px, o.fam, o.wide); }
    if (x.measureText(s).width > maxW) {
      while (s.length > 1 && x.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      s = s.replace(/[\s,·]+$/, '') + '…';
    }
    return {s: s, px: px};
  }
  // draw one line of text (fitted to maxW) and record its box for the overflow check
  function text(x, s, X, Y, o) {
    s = str(s); if (!s) return 0;
    if (o.upper) s = s.toUpperCase();
    var maxW = o.maxW || (W - X);
    var f = fit(x, s, maxW, o);
    font(x, o.w, f.px, o.fam, o.wide);
    if (o.ls && 'letterSpacing' in x) x.letterSpacing = o.ls + 'px';
    x.fillStyle = o.color || C.white; x.textAlign = o.align || 'left'; x.textBaseline = 'alphabetic';
    var wd = x.measureText(f.s).width;
    x.fillText(f.s, X, Y);
    if (o.ls && 'letterSpacing' in x) x.letterSpacing = '0px';
    var x0 = o.align === 'right' ? X - wd : o.align === 'center' ? X - wd / 2 : X;
    BOXES.push({s: f.s, x0: x0, x1: x0 + wd, top: Y - f.px * 0.8, bottom: Y + f.px * 0.22, maxW: maxW, zone: o.zone || 'body'});
    return wd;
  }
  // words into at most `lines` lines that fit maxW, shrinking from px to min; the last line is cut if it must be
  function wrap(x, s, maxW, lines, o) {
    s = str(s); if (o.upper) s = s.toUpperCase();
    var words = s.split(' '), px = o.px, out;
    for (;;) {
      font(x, o.w, px, o.fam, o.wide);
      out = []; var cur = '';
      for (var i = 0; i < words.length; i++) {
        var t = cur ? cur + ' ' + words[i] : words[i];
        if (x.measureText(t).width <= maxW || !cur) cur = t; else { out.push(cur); cur = words[i]; }
      }
      if (cur) out.push(cur);
      var ok = out.length <= lines && out.every(function (l) { return x.measureText(l).width <= maxW; });
      if (ok || px <= o.min) break;
      px -= 2;
    }
    if (out.length > lines) { out = out.slice(0, lines); out[lines - 1] += '…'; }
    else if (out.length > 1) {
      // balance the lines (no lone last word): the narrowest width that still takes the same number of lines
      var greedy = function (mw) { var o = [], cur = ''; for (var k = 0; k < words.length; k++) { var t = cur ? cur + ' ' + words[k] : words[k]; if (x.measureText(t).width <= mw || !cur) cur = t; else { o.push(cur); cur = words[k]; } } if (cur) o.push(cur); return o; };
      for (var mw = maxW - 8; mw > maxW * 0.45; mw -= 8) { var o2 = greedy(mw); if (o2.length > out.length || o2.some(function (l) { return x.measureText(l).width > maxW; })) break; out = o2; }
    }
    return {lines: out, px: px};
  }
  function rr(x, X, Y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    x.beginPath(); x.moveTo(X + r, Y); x.lineTo(X + w - r, Y); x.arcTo(X + w, Y, X + w, Y + r, r); x.lineTo(X + w, Y + h - r);
    x.arcTo(X + w, Y + h, X + w - r, Y + h, r); x.lineTo(X + r, Y + h); x.arcTo(X, Y + h, X, Y + h - r, r); x.lineTo(X, Y + r); x.arcTo(X, Y, X + r, Y, r); x.closePath();
  }
  function panel(x, X, Y, w, h, r, strong) {
    rr(x, X, Y, w, h, r);
    PANELS.push({x0: X, y0: Y, x1: X + w, y1: Y + h});
    x.fillStyle = 'rgba(14,11,18,.93)'; x.fill();
    var g = x.createLinearGradient(X, Y, X, Y + h);
    g.addColorStop(0, strong ? 'rgba(176,56,249,.16)' : 'rgba(255,255,255,.045)'); g.addColorStop(1, strong ? 'rgba(176,56,249,.04)' : 'rgba(255,255,255,.015)');
    x.fillStyle = g; x.fill();
    x.lineWidth = 2; x.strokeStyle = strong ? 'rgba(176,56,249,.55)' : 'rgba(255,255,255,.10)'; x.stroke();
  }
  function path(x, d, X, Y, h, vh, color) {
    if (typeof Path2D === 'undefined') return;
    x.save(); x.translate(X, Y); var s = h / vh; x.scale(s, s); x.fillStyle = color; x.fill(new Path2D(d)); x.restore();
  }
  // the Onyx raster art: the mark drawn as a dot field, fading out from the glow
  var RASTER = {};
  function raster(x, X, Y, h, step, alpha) {
    var key = h + ':' + step, pts = RASTER[key];
    if (!pts) {
      pts = [];
      var w = Math.ceil(h * 100 / 137), cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var c = cv.getContext('2d'); path(c, MARK, 0, 0, h, 137, '#fff');
      var d = c.getImageData(0, 0, w, h).data;
      for (var j = 0; j < h; j += step) for (var i = 0; i < w; i += step) if (d[(j * w + i) * 4 + 3] > 128) pts.push([i, j]);
      RASTER[key] = pts;
    }
    pts.forEach(function (p) {
      var wave = 0.55 + 0.45 * Math.sin(p[0] * 0.045 + p[1] * 0.03);
      x.fillStyle = 'rgba(215,149,255,' + (alpha * wave).toFixed(3) + ')';
      x.fillRect(X + p[0], Y + p[1], step * 0.42, step * 0.42);
    });
  }
  function background(x, sq) {
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    var g = x.createRadialGradient(W * 0.92, H * (sq ? 0.02 : 0.03), 0, W * 0.92, H * (sq ? 0.02 : 0.03), W * 0.95);
    g.addColorStop(0, 'rgba(176,56,249,.55)'); g.addColorStop(0.45, 'rgba(176,56,249,.16)'); g.addColorStop(1, 'rgba(176,56,249,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    var g2 = x.createRadialGradient(0, H * 0.82, 0, 0, H * 0.82, W * 0.8);
    g2.addColorStop(0, 'rgba(141,22,184,.30)'); g2.addColorStop(1, 'rgba(141,22,184,0)');
    x.fillStyle = g2; x.fillRect(0, 0, W, H);
    // the mark as raster art, bleeding off the right edge behind everything
    var mh = sq ? 760 : 1180;
    raster(x, W - mh * 0.5, sq ? 140 : 300, mh, sq ? 16 : 18, 0.16);
    // fine top hairline glow and the frame
    x.save(); rr(x, 22, 22, W - 44, H - 44, 40); x.lineWidth = 2; x.strokeStyle = 'rgba(176,56,249,.38)'; x.stroke(); x.restore();
    var hl = x.createLinearGradient(80, 0, W - 80, 0);
    hl.addColorStop(0, 'rgba(215,149,255,0)'); hl.addColorStop(0.5, 'rgba(215,149,255,.9)'); hl.addColorStop(1, 'rgba(215,149,255,0)');
    x.fillStyle = hl; x.fillRect(120, 21, W - 240, 3);
  }
  function header(x, c, P, Y, sq) {
    var mh = sq ? 64 : 76;
    x.save(); x.shadowColor = 'rgba(176,56,249,.8)'; x.shadowBlur = 28; path(x, MARK, P, Y, mh, 137, C.pur); x.restore();
    var wx = P + mh * 100 / 137 + 22, wh = sq ? 30 : 36;
    path(x, WORD, wx, Y + mh / 2 - wh / 2 - 7, wh, 46.85, C.white);
    text(x, 'SPORTS', wx, Y + mh / 2 + wh / 2 + (sq ? 20 : 24), {w: 500, px: sq ? 17 : 20, fam: MONO, color: C.lil, ls: 6, maxW: 260, zone: 'head'});
    // the kind pill on the right
    var k = c.kind === 'season' ? 'MY SEASON' : c.cashed ? 'CASHED TICKET' : c.live ? 'LIVE TICKET' : c.legs.length > 1 ? 'PARLAY · ' + c.legs.length + ' LEGS' : 'SINGLE';
    font(x, 600, sq ? 21 : 24, MONO); var kw = x.measureText(k).width + (sq ? 40 : 48), kh = sq ? 46 : 54, ky = Y + mh / 2 - kh / 2;
    rr(x, W - P - kw, ky, kw, kh, kh / 2);
    x.fillStyle = c.cashed ? 'rgba(97,233,112,.12)' : 'rgba(176,56,249,.16)'; x.fill();
    x.lineWidth = 2; x.strokeStyle = c.cashed ? 'rgba(97,233,112,.7)' : 'rgba(176,56,249,.7)'; x.stroke();
    text(x, k, W - P - kw / 2, ky + kh / 2 + (sq ? 8 : 9), {w: 600, px: sq ? 21 : 24, fam: MONO, align: 'center', color: c.cashed ? C.grn : C.lil, maxW: kw, zone: 'head'});
    return Y + mh;
  }
  function chips(x, list, P, Y, sq, maxW) {
    var X = P, h = sq ? 40 : 48, px = sq ? 18 : 21;
    list.slice(0, 6).forEach(function (sp) {
      var t = SPORT[sp] || String(sp).toUpperCase();
      font(x, 700, px, MONO); var w = x.measureText(t).width + (sq ? 30 : 36);
      if (X + w > P + maxW) return;
      rr(x, X, Y, w, h, 8); x.fillStyle = 'rgba(255,255,255,.06)'; x.fill(); x.lineWidth = 1.5; x.strokeStyle = 'rgba(255,255,255,.16)'; x.stroke();
      text(x, t, X + w / 2, Y + h / 2 + px * 0.36, {w: 700, px: px, fam: MONO, align: 'center', color: C.white, maxW: w});
      X += w + 10;
    });
    return Y + h;
  }
  function ring(x, cx, cy, R, p, label, tone) {
    var lw = Math.round(R * 0.15);
    x.save();
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.lineWidth = lw; x.strokeStyle = 'rgba(255,255,255,.08)'; x.stroke();
    var a0 = -Math.PI / 2, a1 = a0 + Math.PI * 2 * Math.max(0.012, Math.min(1, p));
    var g;
    if (x.createConicGradient) { g = x.createConicGradient(a0, cx, cy); g.addColorStop(0, tone === 'grn' ? '#1f8f2d' : C.purD); g.addColorStop(Math.max(0.05, Math.min(1, p)), tone === 'grn' ? C.grn : C.lil); }
    else { g = x.createLinearGradient(cx - R, cy - R, cx + R, cy + R); g.addColorStop(0, C.purD); g.addColorStop(1, C.lil); }
    x.shadowColor = tone === 'grn' ? 'rgba(97,233,112,.6)' : 'rgba(176,56,249,.75)'; x.shadowBlur = R * 0.22;
    x.beginPath(); x.arc(cx, cy, R, a0, a1); x.lineWidth = lw; x.lineCap = 'round'; x.strokeStyle = g; x.stroke();
    x.restore();
    text(x, pct(p), cx, cy + R * 0.14, {w: 800, px: Math.round(R * 0.46), min: Math.round(R * 0.3), wide: true, align: 'center', maxW: R * 1.5, color: C.white});
    text(x, label, cx, cy + R * 0.46, {w: 600, px: Math.round(R * 0.12), min: 12, fam: MONO, align: 'center', maxW: R * 1.45, color: tone === 'grn' ? C.grn : C.lil, ls: 2});
  }
  function stamp(x, cx, cy, s) {
    x.save(); x.translate(cx, cy); x.rotate(-0.16);
    font(x, 900, 64 * s, DISPLAY, true); var tw = x.measureText('CASHED').width, w = tw + 70 * s, h = 112 * s;
    rr(x, -w / 2, -h / 2, w, h, 18 * s); x.fillStyle = 'rgba(97,233,112,.13)'; x.fill();
    x.shadowColor = 'rgba(97,233,112,.7)'; x.shadowBlur = 26 * s; x.lineWidth = 6 * s; x.strokeStyle = C.grn; x.stroke();
    rr(x, -w / 2 + 12 * s, -h / 2 + 12 * s, w - 24 * s, h - 24 * s, 10 * s); x.lineWidth = 2 * s; x.strokeStyle = 'rgba(97,233,112,.55)'; x.shadowBlur = 0; x.stroke();
    x.fillStyle = C.grn; x.textAlign = 'center'; x.textBaseline = 'middle'; font(x, 900, 64 * s, DISPLAY, true); x.fillText('CASHED', 0, 3 * s);
    x.restore();
    return {w: w * Math.cos(0.16) + h * Math.sin(0.16), h: h * Math.cos(0.16) + w * Math.sin(0.16)};
  }
  function icon(x, cx, cy, r, L, i) {
    x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2);
    if (L.res === 'W') { x.fillStyle = C.grn; x.fill(); x.strokeStyle = '#0c0c0c'; x.lineWidth = r * 0.22; x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath(); x.moveTo(cx - r * 0.42, cy + r * 0.02); x.lineTo(cx - r * 0.1, cy + r * 0.34); x.lineTo(cx + r * 0.46, cy - r * 0.32); x.stroke(); }
    else if (L.res === 'L') { x.lineWidth = r * 0.16; x.strokeStyle = C.red; x.stroke(); x.lineCap = 'round';
      x.beginPath(); x.moveTo(cx - r * 0.34, cy - r * 0.34); x.lineTo(cx + r * 0.34, cy + r * 0.34); x.moveTo(cx + r * 0.34, cy - r * 0.34); x.lineTo(cx - r * 0.34, cy + r * 0.34); x.stroke(); }
    else { x.fillStyle = 'rgba(176,56,249,.14)'; x.fill(); x.lineWidth = r * 0.13; x.strokeStyle = L.res === 'P' ? C.dim : C.pur; x.stroke();
      x.fillStyle = C.lil; x.textAlign = 'center'; x.textBaseline = 'middle'; font(x, 700, Math.round(r * 0.9), MONO); x.fillText(String(i + 1), cx, cy + 1); }
    x.restore();
  }
  function legRow(x, L, i, X, Y, w, h, sq, last) {
    var r = Math.round(Math.min(sq ? 20 : 26, h * 0.2)), cx = X + r + 4, cy = Y + h / 2;
    icon(x, cx, cy, r, L, i);
    var px = Math.round(Math.min(sq ? 26 : 34, h * 0.3)), mpx = Math.round(Math.min(sq ? 18 : 23, h * 0.2));
    // the price pill on the right
    var pr = L.price != null ? odds(L.price) : '';
    font(x, 700, px, MONO); var pw = pr ? x.measureText(pr).width + 30 : 0, ph = px + 22, pxR = X + w;
    var showConf = L.conf != null && h >= (sq ? 84 : 84);
    var py = showConf ? cy - ph / 2 - mpx * 0.62 : cy - ph / 2;
    if (pr) {
      rr(x, pxR - pw, py, pw, ph, 10); x.fillStyle = 'rgba(176,56,249,.14)'; x.fill(); x.lineWidth = 1.5; x.strokeStyle = 'rgba(176,56,249,.5)'; x.stroke();
      text(x, pr, pxR - pw / 2, py + ph / 2 + px * 0.36, {w: 700, px: px, fam: MONO, align: 'center', color: C.white, maxW: pw});
    }
    if (showConf) text(x, 'MODEL ' + pct(L.conf), pxR - (pw || 0) / 2, py + ph + mpx + 8, {w: 500, px: mpx - 2, min: 12, fam: MONO, align: pw ? 'center' : 'right', color: C.lil, maxW: Math.max(pw, 120) + 20});
    var tx = cx + r + (sq ? 18 : 24), tw = pxR - (pw ? pw : 0) - (sq ? 18 : 24) - tx;
    var two = h >= (sq ? 104 : 140);
    var hasM = !!L.matchup && h >= (sq ? 54 : 70);
    var col = L.res === 'L' ? C.body : C.white;
    if (two) {
      var wr = wrap(x, L.label, tw, 2, {w: 700, px: px, min: Math.round(px * 0.72)});
      var lh = wr.px * 1.14, total = wr.lines.length * lh + (hasM ? mpx + 14 : 0), y0 = cy - total / 2 + wr.px * 0.86;
      wr.lines.forEach(function (ln, k) { text(x, ln, tx, y0 + k * lh, {w: 700, px: wr.px, maxW: tw, color: col}); });
      if (hasM) text(x, L.matchup, tx, y0 + (wr.lines.length - 1) * lh + mpx + 18, {w: 500, px: mpx, min: 13, fam: MONO, maxW: tw, color: C.dim});
    } else {
      var ly = hasM ? cy - 4 : cy + px * 0.34;
      text(x, L.label, tx, ly, {w: 700, px: px, min: Math.round(px * 0.7), maxW: tw, color: col});
      if (hasM) text(x, L.matchup, tx, ly + mpx + 12, {w: 500, px: mpx, min: 12, fam: MONO, maxW: tw, color: C.dim});
    }
    if (!last) { x.fillStyle = C.line; x.fillRect(tx, Y + h - 1, X + w - tx, 1.5); }
  }
  function legsBlock(x, c, P, Y, w, h, sq) {
    var pad = sq ? 18 : 26;
    panel(x, P, Y, w, h, sq ? 22 : 28);
    var n = c.legs.length, inner = h - 2 * pad, minH = sq ? 62 : 96, maxH = sq ? 108 : 170, moreH = sq ? 44 : 60;
    var show = Math.floor(inner / minH) >= n ? n : Math.max(1, Math.floor((inner - moreH) / minH)), more = n - show;
    var rh = Math.min(maxH, (inner - (more ? moreH : 0)) / show);
    var y = Y + pad + (inner - show * rh - (more ? moreH : 0)) / 2;
    for (var i = 0; i < show; i++) legRow(x, c.legs[i], i, P + pad, y + i * rh, w - 2 * pad, rh, sq, i === show - 1 && !more);
    if (more) text(x, '+ ' + more + ' more leg' + (more === 1 ? '' : 's') + ' on this ticket', P + w / 2, y + show * rh + moreH / 2 + 8, {w: 600, px: sq ? 19 : 24, fam: MONO, align: 'center', color: C.lil, maxW: w - 2 * pad});
    return {shown: show, more: more};
  }
  // the hero: Onyx price, what $10 pays, and the model's chance ring (or the live chance), centered in its panel
  function hero(x, c, P, Y, w, h, sq) {
    panel(x, P, Y, w, h, sq ? 22 : 28, true);
    var pad = sq ? 28 : 40, ringP = c.live ? c.live.p : c.chance, R = ringP != null ? Math.min(h * 0.36, sq ? 118 : 150) : 0;
    var leftW = w - 2 * pad - (R ? 2 * R + (sq ? 30 : 44) : 0), lx = P + pad;
    var lbl = sq ? 19 : 24, big = Math.min(sq ? 104 : 150, Math.round(h * 0.42)), payPx = sq ? 30 : 38, notePx = sq ? 17 : 21;
    var note = c.price == null ? '' : c.live ? (c.chance != null ? 'PRE-GAME MODEL ' + pct(c.chance) : '')
      : c.chance != null && (c.legs.length > 1 || c.cashed) ? 'ONYX NEEDS ' + pct(1 / dec(c.price)) + ' \u00b7 FAIR ' + odds(amer(1 / c.chance)) : '';
    var gBig = 14 + big * 0.82, gPay = c.price != null ? payPx + (sq ? 22 : 30) : 0, gNote = notePx + (sq ? 16 : 22);
    var blockH = lbl + gBig + gPay + (note ? gNote : 0);
    if (note && blockH > h - 2 * pad + 4) { note = ''; blockH -= gNote; }
    var y = Y + Math.max(pad * 0.7, (h - blockH) / 2) + lbl;
    text(x, c.legs.length > 1 ? 'ONYX TICKET PRICE' : 'ONYX PRICE', lx, y, {w: 600, px: lbl, fam: MONO, color: C.lil, ls: 3, maxW: leftW});
    y += gBig;
    x.save(); x.shadowColor = 'rgba(176,56,249,.55)'; x.shadowBlur = 30;
    text(x, c.price != null ? odds(c.price) : 'NO PRICE', lx, y, {w: 800, px: big, min: 48, wide: true, maxW: leftW, color: C.white});
    x.restore();
    if (c.price != null) { y += gPay; text(x, (c.cashed ? '$10 RETURNED ' : '$10 PAYS ') + money(10 * dec(c.price)), lx, y, {w: 700, px: payPx, min: 18, fam: MONO, color: C.grn, maxW: leftW}); }
    if (note) { y += gNote; text(x, note, lx, y, {w: 500, px: notePx, min: 12, fam: MONO, color: C.body, maxW: leftW}); }
    if (R) ring(x, P + w - pad - R, Y + h / 2, R, ringP, c.live ? 'LIVE CHANCE' : c.cashed ? 'MODEL HAD IT' : 'MODEL CHANCE', c.live || c.cashed ? 'grn' : 'pur');
  }
  function liveStrip(x, c, P, Y, w, h, sq) {
    rr(x, P, Y, w, h, h / 2); x.fillStyle = 'rgba(97,233,112,.07)'; x.fill(); x.lineWidth = 1.5; x.strokeStyle = 'rgba(97,233,112,.45)'; x.stroke();
    var cy = Y + h / 2, dx = P + 34;
    x.save(); x.shadowColor = C.grn; x.shadowBlur = 16; x.beginPath(); x.arc(dx, cy, sq ? 8 : 10, 0, Math.PI * 2); x.fillStyle = C.grn; x.fill(); x.restore();
    var lw = text(x, 'LIVE', dx + 22, cy + (sq ? 7 : 9), {w: 800, px: sq ? 20 : 25, fam: MONO, color: C.grn, maxW: 100, ls: 3});
    var bx = dx + 22 + lw + 26, bw = sq ? 200 : 260;
    var nowX = bx, nowW = P + w - 30 - bx - bw - 24;
    text(x, c.live.now || 'In play', nowX, cy + (sq ? 7 : 8), {w: 500, px: sq ? 19 : 23, min: 12, fam: MONO, color: C.white, maxW: nowW});
    var bX = P + w - 30 - bw, bh = sq ? 12 : 14;
    rr(x, bX, cy - bh / 2, bw, bh, bh / 2); x.fillStyle = 'rgba(255,255,255,.1)'; x.fill();
    rr(x, bX, cy - bh / 2, Math.max(bh, bw * c.live.p), bh, bh / 2); x.fillStyle = C.grn; x.fill();
  }
  // a single: the model's chance against what Onyx's price needs, on one bar
  function breakdown(x, c, P, Y, w, h, sq) {
    panel(x, P, Y, w, h, sq ? 22 : 28);
    var pad = sq ? 28 : 40, imp = 1 / dec(c.price), p = c.chance, up = p > imp, pts = Math.abs(100 * (p - imp));
    var lx = P + pad, iw = w - 2 * pad, y = Y + pad;
    text(x, 'MODEL VS ONYX PRICE', lx, y + (sq ? 17 : 22), {w: 600, px: sq ? 17 : 22, fam: MONO, color: C.lil, ls: 3, maxW: iw * 0.55});
    var verdict = pts < 1 ? 'ABOUT A FAIR PRICE' : (up ? 'MODEL ABOVE BY ' : 'MODEL BELOW BY ') + pts.toFixed(1) + ' PTS';
    text(x, verdict, lx + iw, y + (sq ? 17 : 22), {w: 700, px: sq ? 17 : 22, min: 12, fam: MONO, align: 'right', color: pts < 1 ? C.body : up ? C.grn : C.red, maxW: iw * 0.43});
    if (!sq && h >= 300) {
      // three numbers
      var ty = y + 22 + 54, cw = iw / 3;
      [['ONYX NEEDS', pct(imp), C.white], ['MODEL CHANCE', pct(p), C.lil], ['FAIR ODDS', odds(amer(1 / p)), C.white]].forEach(function (t, i) {
        text(x, t[0], lx + i * cw, ty, {w: 500, px: 19, fam: MONO, color: C.body, ls: 2, maxW: cw - 16});
        text(x, t[1], lx + i * cw, ty + 64, {w: 800, px: 56, min: 28, wide: true, color: t[2], maxW: cw - 16});
      });
    }
    // the bar: 0 to 100%, filled to the model's chance, a tick where Onyx's price breaks even
    var bh = sq ? 16 : 20, by = Y + h - pad - (sq ? 30 : 44) - bh / 2;
    rr(x, lx, by, iw, bh, bh / 2); x.fillStyle = 'rgba(255,255,255,.08)'; x.fill();
    var g = x.createLinearGradient(lx, 0, lx + Math.max(1, iw * p), 0); g.addColorStop(0, C.purD); g.addColorStop(1, C.lil);
    x.save(); x.shadowColor = 'rgba(176,56,249,.7)'; x.shadowBlur = 18; rr(x, lx, by, Math.max(bh, iw * p), bh, bh / 2); x.fillStyle = g; x.fill(); x.restore();
    var tx = lx + iw * imp;
    x.fillStyle = C.white; x.fillRect(tx - 2, by - (sq ? 10 : 14), 4, bh + (sq ? 20 : 28));
    var al = imp < 0.15 ? 'left' : imp > 0.85 ? 'right' : 'center', lxx = al === 'left' ? tx - 2 : al === 'right' ? tx + 2 : tx;
    var ly = by + bh + (sq ? 36 : 46);
    text(x, 'ONYX NEEDS ' + pct(imp), lxx, ly, {w: 600, px: sq ? 16 : 20, min: 12, fam: MONO, align: al, color: C.white, maxW: sq ? 220 : 280});
    if (imp > 0.22) text(x, '0%', lx, ly, {w: 500, px: sq ? 14 : 17, fam: MONO, color: C.dim, maxW: 60});
    if (imp < 0.78) text(x, '100%', lx + iw, ly, {w: 500, px: sq ? 14 : 17, fam: MONO, align: 'right', color: C.dim, maxW: 80});
  }
  function footer(x, P, sq) {
    var h = sq ? 88 : 118, y = sq ? H - h - 126 : H - 96 - h - 70, w = W - 2 * P;
    x.save();
    rr(x, P, y, w, h, h / 2);
    var g = x.createLinearGradient(P, y, P + w, y + h); g.addColorStop(0, C.purD); g.addColorStop(1, C.pur);
    x.shadowColor = 'rgba(176,56,249,.65)'; x.shadowBlur = 40; x.fillStyle = g; x.fill(); x.restore();
    var cy = y + h / 2;
    var bw = text(x, 'BET IT ON ONYX', P + (sq ? 40 : 52), cy + (sq ? 11 : 14), {w: 800, px: sq ? 31 : 40, min: 22, wide: true, maxW: w * 0.56, color: '#fff', zone: 'foot'});
    // the code in a dark inset pill on the right
    var code = 'CODE ' + REF;
    font(x, 700, sq ? 22 : 27, MONO); var cw = x.measureText(code).width + (sq ? 36 : 48), ch = h - (sq ? 26 : 32);
    rr(x, P + w - 14 - cw, y + (h - ch) / 2, cw, ch, ch / 2); x.fillStyle = 'rgba(12,12,12,.55)'; x.fill();
    text(x, code, P + w - 14 - cw / 2, cy + (sq ? 8 : 10), {w: 700, px: sq ? 22 : 27, min: 14, fam: MONO, align: 'center', maxW: cw, color: C.white, zone: 'foot'});
    text(x, 'onyxodds.com', W / 2, y + h + (sq ? 40 : 56), {w: 600, px: sq ? 24 : 30, fam: MONO, align: 'center', color: C.lil, ls: 2, maxW: w, zone: 'foot'});
    text(x, 'Chances are Onyx model projections, not guarantees. Must be of legal age in your state. 1-800-GAMBLER.', W / 2, y + h + (sq ? 70 : 98), {w: 500, px: sq ? 15 : 18, min: 11, fam: MONO, align: 'center', color: C.dim, maxW: w, zone: 'foot'});
    return y;
  }
  function recText(r) {
    if (r == null) return '';
    if (typeof r === 'object') return [r.w || 0, r.l || 0].concat(r.p ? [r.p] : []).join('-');
    return str(r);
  }
  function unitsText(u) { u = num(u); return u == null ? '' : (u > 0 ? '+' : u < 0 ? '-' : '') + Math.abs(u).toFixed(1) + 'u'; }
  function roiText(r) { if (typeof r === 'string' && /%/.test(r)) return str(r); r = num(r); return r == null ? '' : (r > 0 ? '+' : r < 0 ? '-' : '') + (Math.abs(r) * 100).toFixed(1) + '%'; }
  function tone(v) { v = num(v); return v == null ? C.white : v > 0 ? C.grn : v < 0 ? C.red : C.white; }
  function seasonBody(x, c, P, Y, w, bottom, sq) {
    var s = c.stats || {}, rec = recText(s.record), m = /^(\d+)-(\d+)/.exec(rec), wr = m && (+m[1] + +m[2]) ? +m[1] / (+m[1] + +m[2]) : null;
    // hero: the record, units and ROI, and the win rate ring
    var hh = sq ? 270 : 400; panel(x, P, Y, w, hh, sq ? 22 : 28, true);
    var pad = sq ? 28 : 40, R = wr != null ? (sq ? 98 : 140) : 0, lw = w - 2 * pad - (R ? 2 * R + 40 : 0), lx = P + pad;
    text(x, 'RECORD', lx, Y + pad + (sq ? 19 : 24), {w: 600, px: sq ? 19 : 24, fam: MONO, color: C.lil, ls: 3, maxW: lw});
    x.save(); x.shadowColor = 'rgba(176,56,249,.55)'; x.shadowBlur = 30;
    text(x, rec || '0-0', lx, Y + pad + (sq ? 112 : 168), {w: 800, px: sq ? 92 : 138, min: 44, wide: true, maxW: lw}); x.restore();
    var ty = Y + hh - pad - (sq ? 14 : 20), half = lw / 2;
    text(x, 'UNITS', lx, ty - (sq ? 44 : 60), {w: 600, px: sq ? 16 : 20, fam: MONO, color: C.body, ls: 2, maxW: half - 10});
    text(x, unitsText(s.units) || '-', lx, ty, {w: 800, px: sq ? 38 : 52, min: 20, fam: MONO, color: tone(s.units), maxW: half - 10});
    text(x, 'ROI', lx + half, ty - (sq ? 44 : 60), {w: 600, px: sq ? 16 : 20, fam: MONO, color: C.body, ls: 2, maxW: half - 10});
    var roiV = typeof s.roi === 'string' ? num(s.roi.replace('%', '')) : num(s.roi);
    text(x, roiText(s.roi) || '-', lx + half, ty, {w: 800, px: sq ? 38 : 52, min: 20, fam: MONO, color: tone(roiV), maxW: half - 10});
    if (R) ring(x, P + w - pad - R, Y + hh / 2, R, wr, 'WIN RATE', 'pur');
    var y = Y + hh + (sq ? 18 : 28);
    // the best bet
    var b = s.best;
    if (b) {
      var bh = sq ? 96 : 136; panel(x, P, y, w, bh, sq ? 20 : 26);
      var bl = typeof b === 'string' ? b : b.label, bp = typeof b === 'object' && b.price != null ? odds(num(b.price)) : '';
      text(x, 'BEST CASH', P + pad, y + (sq ? 34 : 46), {w: 600, px: sq ? 16 : 20, fam: MONO, color: C.grn, ls: 3, maxW: w - 2 * pad});
      font(x, 800, sq ? 34 : 46, MONO); var bpw = bp ? x.measureText(bp).width : 0;
      text(x, bl, P + pad, y + bh - (sq ? 24 : 34), {w: 700, px: sq ? 30 : 40, min: 18, maxW: w - 2 * pad - bpw - 30});
      if (bp) text(x, bp, P + w - pad, y + bh - (sq ? 24 : 34), {w: 800, px: sq ? 34 : 46, fam: MONO, align: 'right', color: C.grn, maxW: bpw + 4});
      y += bh + (sq ? 18 : 28);
    }
    // by sport
    var rows = c.rows, avail = bottom - y;
    if (rows.length && (sq || avail < 120 + 2 * 74) && avail >= 60) {
      // no room for the table: one strip, each sport and its units
      var sh = Math.min(64, avail), sy = y + sh / 2 + 7, sx = P + pad, sEnd = P + w - pad;
      panel(x, P, y, w, sh, sh / 2);
      for (var q = 0; q < rows.length; q++) {
        var nm = SPORT[rows[q].sport] || String(rows[q].sport || '').toUpperCase(), un = unitsText(rows[q].units);
        font(x, 700, 20, MONO); var need = x.measureText(nm + ' ' + un).width + 10;
        if (sx + need > sEnd) break;
        var a = text(x, nm, sx, sy, {w: 700, px: 20, fam: MONO, color: C.white, maxW: need});
        text(x, un, sx + a + 10, sy, {w: 700, px: 20, fam: MONO, color: tone(rows[q].units), maxW: need});
        sx += need + 26;
      }
      return;
    }
    if (rows.length && avail > (sq ? 90 : 120)) {
      var rh = sq ? 52 : 74, head = sq ? 40 : 54, n = Math.min(rows.length, Math.floor((avail - head - 2 * pad) / rh));
      if (n > 0) {
        var ph = head + n * rh + pad; panel(x, P, y, w, ph, sq ? 20 : 26);
        text(x, 'BY SPORT', P + pad, y + (sq ? 34 : 46), {w: 600, px: sq ? 16 : 20, fam: MONO, color: C.lil, ls: 3, maxW: w - 2 * pad});
        var mx = Math.max.apply(null, rows.slice(0, n).map(function (r) { return Math.abs(num(r.units) || 0); }).concat([1]));
        rows.slice(0, n).forEach(function (r, i) {
          var ry = y + head + i * rh + rh / 2 + (sq ? 6 : 8), cx = P + pad;
          text(x, SPORT[r.sport] || String(r.sport || '').toUpperCase(), cx, ry + (sq ? 8 : 11), {w: 700, px: sq ? 20 : 26, fam: MONO, color: C.white, maxW: sq ? 110 : 150});
          text(x, recText(r.record), cx + (sq ? 120 : 170), ry + (sq ? 8 : 11), {w: 600, px: sq ? 20 : 26, fam: MONO, color: C.body, maxW: sq ? 140 : 190});
          var u = num(r.units) || 0, bx = cx + (sq ? 280 : 390), bw = w - 2 * pad - (sq ? 280 : 390) - (sq ? 120 : 160), bh2 = sq ? 10 : 14;
          rr(x, bx, ry - bh2 / 2, bw, bh2, bh2 / 2); x.fillStyle = 'rgba(255,255,255,.07)'; x.fill();
          rr(x, bx, ry - bh2 / 2, Math.max(bh2, bw * Math.abs(u) / mx), bh2, bh2 / 2); x.fillStyle = u >= 0 ? C.grn : C.red; x.fill();
          text(x, unitsText(r.units), P + w - pad, ry + (sq ? 8 : 11), {w: 800, px: sq ? 22 : 28, fam: MONO, align: 'right', color: tone(r.units), maxW: sq ? 110 : 150});
        });
      }
    }
  }
  function draw(card, size) {
    var c = card.legs ? card : norm(card);
    size = SIZES[size] ? size : 'story';
    var sq = size === 'square', cv = document.createElement('canvas');
    W = cv.width = SIZES[size][0]; H = cv.height = SIZES[size][1];
    var x = cv.getContext('2d'); BOXES = []; PANELS = [];
    var P = sq ? 64 : 80;
    background(x, sq);
    var y = header(x, c, P, sq ? 58 : 84, sq) + (sq ? 30 : 56);
    var fy = footer(x, P, sq), bottom = fy - (sq ? 24 : 40);
    var bw = W - 2 * P;
    if (c.sports.length) y = chips(x, c.sports, P, y, sq, bw) + (sq ? 24 : 36);
    // the title (with the CASHED stamp beside it)
    var stampS = sq ? 0.78 : 1, sw = c.cashed ? 360 * stampS : 0;
    var tmax = bw - sw, single = c.kind !== 'season' && c.legs.length === 1;
    var title = c.kind === 'season' ? (c.title || 'My season') : single ? c.legs[0].label : (c.title || c.legs.length + '-leg parlay');
    var tl = single ? (sq ? 2 : 3) : (sq ? 1 : 2);
    var tw = wrap(x, title, tmax, tl, {w: 800, px: single ? (sq ? 70 : 92) : (sq ? 82 : 104), min: sq ? 40 : 52, wide: true, upper: true});
    var ty = y + tw.px * 0.84, lh = tw.px * 1.02;
    tw.lines.forEach(function (ln, i) { text(x, ln, P, ty + i * lh, {w: 800, px: tw.px, wide: true, maxW: tmax, color: C.white}); });
    if (c.cashed) stamp(x, P + bw - sw / 2 + 6, y + Math.max(tw.lines.length * lh, 110 * stampS) / 2 + 4, stampS);
    y = ty + (tw.lines.length - 1) * lh + tw.px * 0.26;
    var sub = c.kind === 'season' ? 'Tracked and graded on Onyx Sports' : single ? c.legs[0].matchup
      : c.title ? c.legs.length + '-leg parlay' + (sq ? '' : ' \u00b7 every leg at its Onyx price') : sq ? '' : 'Every leg at its Onyx price';
    if (sub) { y += sq ? 34 : 46; text(x, sub, P, y, {w: 500, px: sq ? 22 : 28, min: 14, fam: MONO, color: C.body, maxW: bw}); }
    y += sq ? 26 : 44;
    if (c.kind === 'season') { seasonBody(x, c, P, y, bw, bottom, sq); return finish(cv); }
    if (single) {
      // a single: the hero, then the model against Onyx's price, the block centered in the space it has
      var hasBd = c.chance != null && c.price != null && !c.cashed;
      var heroS = sq ? 250 : 430, bdS = hasBd ? (sq ? 150 : 340) : 0, liveS = c.live ? (sq ? 58 : 80) : 0, gap = sq ? 18 : 28;
      var need = heroS + (bdS ? gap + bdS : 0) + (liveS ? gap + liveS : 0), room = bottom - y;
      if (need > room) { var cut = need - room; if (bdS) { var t2 = Math.min(cut, bdS - (sq ? 110 : 200)); bdS -= t2; cut -= t2; } heroS -= Math.min(cut, heroS - (sq ? 200 : 300)); if (bdS < (sq ? 110 : 200)) bdS = 0; }
      need = heroS + (bdS ? gap + bdS : 0) + (liveS ? gap + liveS : 0);
      y += Math.max(0, Math.min((bottom - y - need) / 2, sq ? 40 : 110));
      hero(x, c, P, y, bw, heroS, sq); y += heroS + gap;
      if (liveS) { liveStrip(x, c, P, y, bw, liveS, sq); y += liveS + gap; }
      if (bdS) breakdown(x, c, P, y, bw, bdS, sq);
      return finish(cv);
    }
    // a parlay: the hero, the live strip, the legs; a short ticket's block is centered, a long one fills the space
    var heroH = sq ? 214 : 360, lh2 = c.live ? (sq ? 56 : 80) : 0, g2 = sq ? 16 : 28;
    var legsNeed = c.legs.length * (sq ? 108 : 170) + 2 * (sq ? 18 : 26);
    var spare = bottom - y - heroH - g2 - (lh2 ? lh2 + g2 : 0) - legsNeed;
    if (spare > 0) y += Math.min(spare / 2, sq ? 40 : 110);
    hero(x, c, P, y, bw, heroH, sq);
    y += heroH + g2;
    if (lh2) { liveStrip(x, c, P, y, bw, lh2, sq); y += lh2 + g2; }
    if (c.legs.length) legsBlock(x, c, P, y, bw, Math.min(bottom - y, legsNeed), sq);
    return finish(cv);
  }
  function finish(cv) { LAST = BOXES.slice(); LASTP = PANELS.slice(); return cv; }
  var LAST = [], LASTP = [];

  // fonts: the site's own (onyx.css loads Archivo and Geist Mono) when they are there, else system bold; a short wait at most
  var FONTS = null;
  function fonts() {
    if (FONTS) return FONTS;
    if (!document.fonts || !document.fonts.load) return (FONTS = Promise.resolve());
    var t = new Promise(function (r) { setTimeout(r, 900); });
    FONTS = Promise.race([Promise.all(['800 40px "Archivo"', '700 40px "Geist Mono"', '500 40px "Geist Mono"'].map(function (f) { return document.fonts.load(f).catch(function () {}); })), t]);
    return FONTS;
  }

  // ── the share sheet ─────────────────────────────────────────────────────────────────────────────────────
  var CSS = [
    '#oxShare{position:fixed;inset:0;z-index:10300;display:flex;align-items:flex-end;justify-content:center}',
    '#oxShare[hidden]{display:none}',
    '#oxShare .oxsh-bg{position:absolute;inset:0;background:rgba(4,4,8,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .2s}',
    '#oxShare.on .oxsh-bg{opacity:1}',
    '#oxShare .oxsh-c{position:relative;width:100%;max-width:480px;max-height:94vh;overflow-y:auto;box-sizing:border-box;background:#121015;border:1.5px solid rgba(176,56,249,.5);border-bottom:0;border-radius:22px 22px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom,0px));color:#eee9f5;box-shadow:0 -12px 50px rgba(0,0,0,.7);transform:translateY(30px);opacity:0;transition:transform .22s ease,opacity .22s;font-family:"Archivo",system-ui,sans-serif;outline:none}',
    '#oxShare.on .oxsh-c{transform:none;opacity:1}',
    '@media (min-width:720px){#oxShare{align-items:center}#oxShare .oxsh-c{border-bottom:1.5px solid rgba(176,56,249,.5);border-radius:22px;max-width:520px}}',
    '#oxShare .oxsh-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px}',
    '#oxShare .oxsh-h b{font:800 13px "Geist Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#d795ff}',
    '#oxShare .oxsh-x{width:36px;height:36px;border-radius:18px;border:0;background:rgba(255,255,255,.07);color:#cfc8da;font:400 22px/1 system-ui,sans-serif;cursor:pointer;flex:none}',
    '#oxShare .oxsh-x:hover,#oxShare .oxsh-x:focus-visible{background:rgba(176,56,249,.3);color:#fff}',
    '#oxShare .oxsh-seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);margin-bottom:12px}',
    '#oxShare .oxsh-seg button{border:0;border-radius:9px;padding:9px 6px;background:transparent;color:#b9b2c4;font:700 12px "Geist Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}',
    '#oxShare .oxsh-seg button.on{background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff}',
    '#oxShare .oxsh-p{display:flex;justify-content:center;align-items:center;min-height:200px;margin-bottom:12px}',
    '#oxShare .oxsh-p img{display:block;max-width:100%;height:auto;border-radius:14px;box-shadow:0 10px 40px rgba(176,56,249,.25);background:#0c0c0c}',
    '#oxShare .oxsh-p.story img{max-height:min(46vh,560px);width:auto}',
    '#oxShare .oxsh-p.square img{max-height:min(42vh,420px);width:auto}',
    '#oxShare .oxsh-b{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '#oxShare .oxsh-b button{min-height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#eee9f5;font:700 13.5px system-ui,-apple-system,sans-serif;cursor:pointer}',
    '#oxShare .oxsh-b button.pri{grid-column:1 / -1;border:0;background:linear-gradient(135deg,#7a2ce0,#b038f9);color:#fff;font-weight:800;font-size:15px;box-shadow:0 6px 22px -6px rgba(176,56,249,.75)}',
    '#oxShare .oxsh-b button:hover{border-color:#b038f9}',
    '#oxShare .oxsh-b button:focus-visible,#oxShare .oxsh-seg button:focus-visible{outline:2px solid #d795ff;outline-offset:2px}',
    '#oxShare .oxsh-n{margin:10px 0 0;max-width:none;width:auto;font:600 10.5px/1.5 "Geist Mono",ui-monospace,monospace;color:#8f879c;text-align:left}',
    '#oxShare .oxsh-ok{color:#61e970}',
    '@media (prefers-reduced-motion: reduce){#oxShare .oxsh-c,#oxShare .oxsh-bg{transition:none!important}}',
    '.ox-share-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}',
    '.ox-share-btn svg{width:15px;height:15px;flex:none}'
  ].join('\n');
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  var ROOT = null, BOX = null, CUR = null, LAST_FOCUS = null, SEQ = 0;
  function build() {
    if (ROOT) return;
    var st = document.createElement('style'); st.id = 'onyx-share'; st.textContent = CSS; document.head.appendChild(st);
    ROOT = document.createElement('div'); ROOT.id = 'oxShare'; ROOT.hidden = true;
    ROOT.innerHTML = '<div class="oxsh-bg" data-x="1"></div><div class="oxsh-c" role="dialog" aria-modal="true" aria-label="Share card" tabindex="-1"></div>';
    document.body.appendChild(ROOT);
    BOX = ROOT.querySelector('.oxsh-c');
    ROOT.addEventListener('click', onClick);
  }
  function canShareFiles() {
    try { if (!navigator.share || !navigator.canShare || typeof File === 'undefined') return false;
      return navigator.canShare({files: [new File([new Blob(['x'], {type: 'image/png'})], 'x.png', {type: 'image/png'})]}); } catch (e) { return false; }
  }
  function sheet() {
    var c = CUR.c, files = canShareFiles(), sh = !!navigator.share;
    BOX.innerHTML = '<div class="oxsh-h"><b>Share card</b><button type="button" class="oxsh-x" data-x="1" aria-label="Close">&times;</button></div>'
      + '<div class="oxsh-seg" role="group" aria-label="Card size"><button type="button" data-size="story" aria-pressed="' + (CUR.size === 'story') + '" class="' + (CUR.size === 'story' ? 'on' : '') + '">Story 9:16</button>'
      + '<button type="button" data-size="square" aria-pressed="' + (CUR.size === 'square') + '" class="' + (CUR.size === 'square' ? 'on' : '') + '">Square 1:1</button></div>'
      + '<div class="oxsh-p ' + CUR.size + '"><img alt="' + esc(headline(c)) + '" data-share-img></div>'
      + '<div class="oxsh-b">'
      + (sh ? '<button type="button" class="pri" data-act="share">' + (files ? 'Share card' : 'Share link') + '</button>' : '<button type="button" class="pri" data-act="share">Save image</button>')
      + (sh ? '<button type="button" data-act="download">Save image</button>' : '')
      + '<button type="button" data-act="copy"' + (sh ? '' : ' style="grid-column:1 / -1"') + '>Copy Onyx link</button></div>'
      + '<p class="oxsh-n" data-share-note>' + (c.kind === 'season' ? 'Your record as graded on Onyx Sports.' : 'The chance is the Onyx model\'s projection, not a guarantee. Every price is Onyx\'s.') + ' The link opens ' + (c.sels.length ? 'this ticket' : 'Onyx') + ' with code ' + REF + '.</p>';
    paint();
  }
  // the PNG: toBlob encodes in idle time, which a page busy with animation can put off for a long while, so
  // after a short wait the canvas is encoded at once instead
  function png(cv) {
    return new Promise(function (r) {
      var done = false, fin = function (b) { if (!done) { done = true; r(b); } };
      var now = function () { try { var d = cv.toDataURL('image/png'), bin = atob(d.split(',')[1]), u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); fin(new Blob([u], {type: 'image/png'})); } catch (e) { fin(null); } };
      try { cv.toBlob(function (b) { if (b) fin(b); else now(); }, 'image/png'); } catch (e) { now(); return; }
      setTimeout(function () { if (!done) now(); }, 1200);
    });
  }
  function paint() {
    var seq = ++SEQ, cur = CUR;
    fonts().then(function () {
      if (!CUR || seq !== SEQ || cur !== CUR) return;
      var cv = draw(CUR.c, CUR.size);
      CUR.canvas = cv; CUR.blob = null;
      cur.png = png(cv);
      return cur.png.then(function (b) {
        if (!CUR || seq !== SEQ) return;
        CUR.blob = b;
        var img = BOX.querySelector('[data-share-img]');
        if (CUR.urlObj) { try { URL.revokeObjectURL(CUR.urlObj); } catch (e) {} CUR.urlObj = null; }
        if (!img) return;
        var sz = CUR.size;
        img.onload = function () { if (CUR && seq === SEQ) ROOT.setAttribute('data-ready', sz); };
        if (b) { CUR.urlObj = URL.createObjectURL(b); img.src = CUR.urlObj; } else img.src = cv.toDataURL('image/png');
      });
    });
  }
  function blob() {
    if (CUR && CUR.blob) return Promise.resolve(CUR.blob);
    if (CUR && CUR.png) return CUR.png;
    return fonts().then(function () { var cv = CUR.canvas || draw(CUR.c, CUR.size); CUR.png = png(cv); return CUR.png; });
  }
  function fname() { return 'onyx-' + CUR.c.kind + '-' + CUR.size + '.png'; }
  function note(m) { var n = BOX && BOX.querySelector('[data-share-note]'); if (n) n.innerHTML = '<span class="oxsh-ok">' + esc(m) + '</span>'; }
  function download() {
    return blob().then(function (b) {
      var u = b ? URL.createObjectURL(b) : CUR.canvas.toDataURL('image/png'), a = document.createElement('a');
      a.href = u; a.download = fname(); a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); if (b) try { URL.revokeObjectURL(u); } catch (e) {} }, 1500);
      return true;
    });
  }
  function copy(t) {
    var done = function () { return true; };
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(done, function () { return legacyCopy(t); }); } catch (e) {}
    return Promise.resolve(legacyCopy(t));
  }
  function legacyCopy(t) {
    try { var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }
  function doShare() {
    var c = CUR.c, url = shareUrl(c), txt = shareText(c), kind = c.kind, size = CUR.size;
    if (!navigator.share) {
      return download().then(function () { return copy(url); }).then(function () { note('Image saved and the Onyx link copied.'); gt('share_card', {kind: kind, method: 'download', size: size}); });
    }
    return blob().then(function (b) {
      var data = {title: headline(c), text: txt, url: url};
      try { var f = b && new File([b], fname(), {type: 'image/png'}); if (f && navigator.canShare && navigator.canShare({files: [f]})) data.files = [f]; } catch (e) {}
      return navigator.share(data).then(function () { gt('share_card', {kind: kind, method: data.files ? 'share_image' : 'share_link', size: size}); note('Shared.'); },
        function (e) { if (e && e.name === 'AbortError') return; return download().then(function () { return copy(url); }).then(function () { note('Image saved and the Onyx link copied.'); gt('share_card', {kind: kind, method: 'download', size: size}); }); });
    });
  }
  function onClick(e) {
    var t = e.target;
    if (t.closest('[data-x]')) { e.preventDefault(); close(); return; }
    if (!CUR) return;
    var s = t.closest('[data-size]');
    if (s) { var v = s.getAttribute('data-size'); if (v !== CUR.size) { CUR.size = v; try { localStorage.setItem('onyxShareSize', v); } catch (x) {} sheet(); var b2 = BOX.querySelector('[data-size="' + v + '"]'); if (b2) b2.focus(); } return; }
    var a = t.closest('[data-act]'); if (!a) return;
    var act = a.getAttribute('data-act');
    if (act === 'share') doShare();
    else if (act === 'download') download().then(function () { note('Image saved. Post it anywhere.'); gt('share_card', {kind: CUR ? CUR.c.kind : '', method: 'download', size: CUR ? CUR.size : ''}); });
    else if (act === 'copy') copy(shareUrl(CUR.c)).then(function (ok) { note(ok === false ? shareUrl(CUR.c) : 'Onyx link copied, code ' + REF + ' included.'); gt('share_card', {kind: CUR ? CUR.c.kind : '', method: 'copy', size: CUR ? CUR.size : ''}); });
  }
  function open(card) {
    build();
    var c = norm(card), size = 'story';
    try { size = localStorage.getItem('onyxShareSize') === 'square' ? 'square' : 'story'; } catch (e) {}
    if (CUR && CUR.urlObj) { try { URL.revokeObjectURL(CUR.urlObj); } catch (e) {} }
    var was = !ROOT.hidden;
    if (!was) LAST_FOCUS = document.activeElement;
    CUR = {c: c, size: size};
    ROOT.removeAttribute('data-ready');
    sheet();
    ROOT.hidden = false;
    if (!was) { void BOX.offsetWidth; ROOT.classList.add('on'); }
    try { BOX.focus({preventScroll: true}); } catch (e) { BOX.focus(); }
    gt('share_card_open', {kind: c.kind});
    return {close: close};
  }
  function close() {
    if (!ROOT || ROOT.hidden) return;
    SEQ++;
    ROOT.classList.remove('on');
    var r = ROOT, cur = CUR; CUR = null;
    setTimeout(function () { if (!r.classList.contains('on')) { r.hidden = true; BOX.innerHTML = ''; r.removeAttribute('data-ready'); if (cur && cur.urlObj) try { URL.revokeObjectURL(cur.urlObj); } catch (e) {} } }, 200);
    var f = LAST_FOCUS; LAST_FOCUS = null;
    if (f && f.focus && document.contains(f)) { try { f.focus({preventScroll: true}); } catch (e) {} }
  }
  document.addEventListener('keydown', function (e) {
    if (!ROOT || ROOT.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(BOX.querySelectorAll('button,a[href]'), function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (!BOX.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (a === first || a === BOX)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }, true);

  // ── share buttons anywhere: the card stays in a registry, the button carries its key ─────────────────────
  var REG = {}, KEYS = [], N = 0;
  function button(card, label, cls) {
    var k = 's' + (++N); REG[k] = card; KEYS.push(k);
    if (KEYS.length > 300) delete REG[KEYS.shift()];
    return '<button type="button" class="ox-share-btn' + (cls ? ' ' + esc(cls) : '') + '" data-oxshare="' + k + '" aria-label="' + esc(label || 'Share card') + '">' + ICON + '<span>' + esc(label || 'Share') + '</span></button>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-oxshare]');
    if (!b) return;
    var card = REG[b.getAttribute('data-oxshare')]; if (!card) return;
    e.preventDefault(); e.stopPropagation();
    open(typeof card === 'function' ? card() : card);
  });
  (function css() { if (document.getElementById('onyx-share-btn')) return; var s = document.createElement('style'); s.id = 'onyx-share-btn'; s.textContent = CSS.split('\n').filter(function (l) { return l.indexOf('.ox-share-btn') === 0; }).join('\n'); (document.head || document.documentElement).appendChild(s); })();

  window.OnyxShare = {
    open: open, close: close, button: button, icon: ICON,
    isOpen: function () { return !!(ROOT && !ROOT.hidden && CUR); },
    render: function (card, size) { return draw(norm(card), size); },
    layout: function () { return LAST.slice(); },
    panels: function () { return LASTP.slice(); },
    current: function () { return CUR ? {card: CUR.c, size: CUR.size} : null; },
    url: function (card) { return shareUrl(norm(card)); },
    text: function (card) { return shareText(norm(card)); },
    fonts: fonts
  };
})();
