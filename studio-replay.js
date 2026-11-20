// studio-replay.js - Sim Replay (Studio tab #replay, NBA and college basketball; 11/20, Jordan: "I want a better version
// of this"). One of Play It Out's 10,000 simulated games, played back possession by possession on an animated court:
// the scoreboard with the game clock and the 24-second clock, Onyx's win-probability bar, both teams' five on the
// floor as headshots in their sets, the ball, passes and shot arcs, the callouts a broadcast would put up, both live
// box scores (starters and who is on the floor marked) and the play log. Scenarios: the most likely game, an upset, a
// blowout, an overtime thriller, and "your bets hit" (a game where every saved / slip leg on this game cashes).
// Controls: play / pause, 1x 4x 16x 60x, highlights (scoring runs, callouts, the last two minutes), a scrubber with the
// quarters and the big moments on it, jump to Q4 / clutch / final. The final: the full box, the top performers, "the
// plays the sim likes" (hit rate across ALL 10,000 games against Onyx's price) with Bet on Onyx and + Parlay slip,
// your bets graded, Share the final (OnyxShare) and Download video (canvas + MediaRecorder, story 1080x1920 or
// landscape 1920x1080, highlights so a game fits in about 75 s). The play-by-play itself comes from sim-replay.js.
//
// Honesty: always labeled "Simulated game, 1 of 10,000 sims, not real highlights" (page, court, video, share card).
// Projections, never Onyx Picks; every price is Onyx's.
//
// Performance: one <canvas>, one requestAnimationFrame loop drawing a cached court and pre-rendered player sprites (no
// layout reads per frame); the DOM (box, log) updates only when an event lands, at most 6 times a second. The 10,000
// games and the play-by-play are built in chunks so the page never freezes. Paused while the tab is hidden; with
// prefers-reduced-motion it starts paused and players and the ball move without tweening.
//
// For gates and tools: Studio.replay = {game, ctx, state, seek, play, pause, speed, mode, scenario, frame, record}.
(function () {
  'use strict';
  if (!window.Studio || !window.SimReplay) return;
  var SP = Studio.sport; if (SP !== 'nba' && SP !== 'cbb') return;
  var SR = window.SimReplay, CF = SR.cfg[SP], N = 10000;
  var COL = {pur: '#b038f9', pur2: '#d795ff', purD: '#7a2ce0', grn: '#61e970', red: '#ff8a8a', bg: '#0c0c0c', ball: '#ff8a3d', A: '#b038f9', H: '#d9d2e6', mute: '#9a93a6', dim: '#b9b2c4'};
  var LABEL = 'Simulated game, 1 of 10,000 sims, not real highlights';
  var DISPLAY = '"Archivo", "Inter", "Helvetica Neue", Arial, system-ui, sans-serif', MONO = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  var RM = false; try { RM = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var MARK = 'm39.041 109.178 18.493 9.863-33.972 17.945L0 124.384v-84.11l39.041-20.411zm21.918-81.37-18.493-9.863L76.438 0 100 12.603v84.246L60.959 117.26z';

  var CSS = [
    '.rp{display:flex;flex-direction:column;gap:12px}',
    '.rp-lab{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;padding:6px 12px;border-radius:999px;border:1px solid rgba(176,56,249,.55);background:rgba(176,56,249,.12);color:#e9d8ff;font:800 10.5px monospace;letter-spacing:.09em;text-transform:uppercase}',
    '.rp-lab i{width:7px;height:7px;border-radius:50%;background:var(--pur);box-shadow:0 0 8px var(--pur)}',
    '.rp-pick{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:2px 16px 4px}.rp-pick::-webkit-scrollbar{display:none}',
    '@media (min-width:900px){.rp-pick{flex-wrap:wrap;overflow:visible;margin:0;padding:0}}',
    '.rp-g{flex:0 0 auto;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:8px 11px;cursor:pointer;color:#fff;font:800 12.5px monospace;display:flex;align-items:center;gap:6px}',
    '.rp-g img{width:18px;height:18px;object-fit:contain}.rp-g.on{border-color:var(--pur);background:rgba(176,56,249,.16)}',
    '.rp-sc{display:flex;gap:6px;flex-wrap:wrap}',
    '.rp-sc button{border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--dim);border-radius:999px;padding:7px 12px;font:700 12px system-ui;cursor:pointer}',
    '.rp-sc button.on{background:var(--pur);border-color:var(--pur);color:#fff}.rp-sc button:disabled{opacity:.4;cursor:default}',
    '.rp-note{font-size:12px;color:var(--mute);line-height:1.5;margin:0}',
    '.rp-main{display:grid;grid-template-columns:1fr;gap:12px}',
    '@media (min-width:1000px){.rp-main{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)}}',
    '.rp-col{display:flex;flex-direction:column;gap:12px;min-width:0}',
    '.rp-board{padding:12px 14px;border-radius:16px;border:1px solid var(--line);background:radial-gradient(120% 140% at 50% 0,rgba(176,56,249,.2),rgba(255,255,255,.03) 65%)}',
    '.rp-sb{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px}',
    '.rp-tm{display:flex;align-items:center;gap:8px;min-width:0}.rp-tm.h{flex-direction:row-reverse;text-align:right}',
    '.rp-tm img{width:34px;height:34px;object-fit:contain;flex:none}.rp-tm .ab{font:800 13px monospace;letter-spacing:.05em}.rp-tm .nm{font-size:11px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.rp-tm .s{font:900 clamp(30px,8vw,44px) system-ui;line-height:1;font-variant-numeric:tabular-nums;margin:0 4px}',
    '.rp-mid{text-align:center;min-width:76px}.rp-clk{font:900 22px monospace;font-variant-numeric:tabular-nums}.rp-per{font:700 10.5px monospace;color:var(--mute);letter-spacing:.08em}',
    '.rp-shot{display:inline-block;margin-top:3px;padding:1px 6px;border-radius:6px;background:rgba(255,138,138,.12);color:var(--red);font:800 11px monospace;font-variant-numeric:tabular-nums}.rp-shot.ok{background:rgba(255,255,255,.06);color:var(--dim)}',
    '.rp-wp{margin-top:10px}.rp-wp .bar{display:flex;height:8px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.08)}',
    '.rp-wp .bar i{display:block;height:100%;transition:width .35s ease}.rp-wp .bar i.a{background:linear-gradient(90deg,#7a2ce0,#b038f9)}.rp-wp .bar i.h{background:#d9d2e6}',
    '.rp-wp .lb{display:flex;justify-content:space-between;font:700 10.5px monospace;color:var(--mute);margin-top:4px;letter-spacing:.04em}.rp-wp .lb b{color:#fff}',
    '.rp-court{position:relative;border-radius:16px;overflow:hidden;border:1px solid var(--line);background:#100d14;touch-action:pan-y}',
    '.rp-court canvas{display:block;width:100%;height:auto}',
    '.rp-load{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(12,12,12,.82);font:700 12px monospace;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;text-align:center;padding:16px}',
    '.rp-load .sx-bar{width:min(260px,70%)}.rp-load[hidden]{display:none}',
    '.rp-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.rp-btn{border:1px solid var(--line);background:rgba(255,255,255,.05);color:#fff;border-radius:10px;padding:8px 11px;font:700 12px system-ui;cursor:pointer;min-height:36px}',
    '.rp-btn.pri{background:var(--pur);border-color:var(--pur)}.rp-btn.on{background:rgba(176,56,249,.25);border-color:var(--pur);color:#fff}',
    '.rp-play{width:44px;height:40px;border-radius:12px;border:0;background:var(--pur);color:#fff;font:900 16px system-ui;cursor:pointer;flex:none}',
    '.rp-spd{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}.rp-spd button{border:0;background:transparent;color:var(--dim);padding:8px 9px;font:800 11.5px monospace;cursor:pointer}.rp-spd button.on{background:var(--pur);color:#fff}',
    '.rp-tl{position:relative;flex:1 1 100%;height:34px;margin-top:2px}',
    '.rp-tl input{position:absolute;inset:0;width:100%;margin:0;opacity:0;cursor:pointer;height:34px}',
    '.rp-tl .tr{position:absolute;left:0;right:0;top:15px;height:5px;border-radius:999px;background:rgba(255,255,255,.1);pointer-events:none}',
    '.rp-tl .fill{position:absolute;left:0;top:15px;height:5px;border-radius:999px;background:linear-gradient(90deg,#7a2ce0,#b038f9);pointer-events:none}',
    '.rp-tl .knob{position:absolute;top:10px;width:15px;height:15px;margin-left:-7px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(176,56,249,.5);pointer-events:none}',
    '.rp-tl .q{position:absolute;top:8px;width:1px;height:19px;background:rgba(255,255,255,.28);pointer-events:none}.rp-tl .ql{position:absolute;top:-1px;font:700 9px monospace;color:var(--mute);transform:translateX(3px);pointer-events:none}',
    '.rp-tl .tk{position:absolute;top:24px;width:5px;height:5px;margin-left:-2px;border-radius:50%;background:var(--pur2);pointer-events:none}.rp-tl .tk.c{background:var(--grn)}',
    '.rp-jump{display:flex;gap:6px;flex-wrap:wrap}',
    '.rp-log{display:flex;flex-direction:column;gap:5px;max-height:260px;overflow:hidden}',
    '.rp-ev{display:grid;grid-template-columns:52px 1fr auto;gap:8px;align-items:center;padding:7px 9px;border-radius:10px;background:rgba(255,255,255,.035);border-left:3px solid transparent;font-size:12.5px;line-height:1.35}',
    '.rp-ev.A{border-left-color:var(--pur)}.rp-ev.H{border-left-color:#d9d2e6}.rp-ev.sc{font-weight:700}.rp-ev.new{animation:rpIn .3s ease}',
    '.rp-ev .t{font:700 10.5px monospace;color:var(--mute)}.rp-ev .s{font:700 10.5px monospace;color:var(--dim);white-space:nowrap}',
    '@keyframes rpIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
    '.rp-box h4{margin:0 0 6px;display:flex;justify-content:space-between;align-items:center;font-size:14px}.rp-box h4 b{font:900 18px monospace}',
    '.rp-tabs{display:flex;gap:6px;margin-bottom:8px}.rp-tabs button{flex:1;border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:10px;padding:7px;font:800 12px monospace;cursor:pointer}.rp-tabs button.on{background:rgba(176,56,249,.2);border-color:var(--pur);color:#fff}',
    '@media (min-width:1000px){.rp-tabs{display:none}.rp-box .tb{display:block!important}}',
    '.rp-bt{width:100%;border-collapse:collapse;font:600 11px monospace;font-variant-numeric:tabular-nums}',
    '.rp-bt th,.rp-bt td{padding:4px 3px;text-align:right;white-space:nowrap;border-top:1px solid rgba(255,255,255,.06)}',
    '.rp-bt th{color:var(--mute);font-size:9.5px;letter-spacing:.06em;border-top:0}.rp-bt th:first-child,.rp-bt td:first-child{text-align:left;max-width:104px;overflow:hidden;text-overflow:ellipsis}',
    '.rp-bt tr.on td:first-child{box-shadow:inset 3px 0 0 var(--pur);padding-left:7px}.rp-bt tr.on td{color:#fff}.rp-bt td{color:var(--dim)}.rp-bt tr.tot td{color:#fff;font-weight:800;border-top:1px solid rgba(255,255,255,.18)}',
    '.rp-bt .st{color:var(--pur2);margin-right:3px}.rp-bt td.pts{color:#fff;font-weight:800}.rp-bt tr.dnp td{opacity:.45}',
    '.rp-likes .lk,.rp-bets .lk{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;padding:10px 0;border-top:1px solid rgba(255,255,255,.07);align-items:center}',
    '.rp-likes .lk:first-of-type,.rp-bets .lk:first-of-type{border-top:0}',
    '.rp-likes .lb,.rp-bets .lb{font-size:13px;font-weight:700;min-width:0}.rp-likes small,.rp-bets small{display:block;color:var(--mute);font:600 10.5px monospace;margin-top:3px;line-height:1.5}',
    '.rp-likes .bt{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}',
    '.rp-st{display:inline-block;padding:3px 8px;border-radius:999px;font:800 10.5px monospace;letter-spacing:.04em}.rp-st.hit{background:rgba(97,233,112,.16);color:var(--grn)}.rp-st.miss{background:rgba(255,138,138,.14);color:var(--red)}.rp-st.live{background:rgba(176,56,249,.18);color:var(--pur2)}.rp-st.push{background:rgba(255,255,255,.08);color:var(--dim)}',
    '.rp-fin{position:fixed;inset:0;z-index:10250;background:rgba(6,5,9,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);overflow-y:auto;padding:calc(14px + env(safe-area-inset-top)) 12px calc(40px + env(safe-area-inset-bottom));box-sizing:border-box}',
    '.rp-fin[hidden]{display:none}',
    '.rp-fin .in{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:12px}',
    '.rp-fin .hd{display:flex;justify-content:space-between;align-items:center;gap:8px}.rp-fin .x{width:38px;height:38px;border-radius:19px;border:0;background:rgba(255,255,255,.08);color:#fff;font:400 22px system-ui;cursor:pointer;flex:none}',
    '.rp-fs{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;text-align:center;gap:8px}.rp-fs .s{font:900 46px system-ui;line-height:1}.rp-fs .w{color:var(--grn)}.rp-fs img{width:42px;height:42px;object-fit:contain}',
    '.rp-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.rp-top>div{padding:10px;border-radius:12px;background:rgba(255,255,255,.04);text-align:center;min-width:0}.rp-top img{width:54px;height:40px;object-fit:cover;object-position:top;display:block;margin:0 auto 4px;border-radius:8px;background:#1d1824}',
    '.rp-top b{display:block;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rp-top span{display:block;font:700 11px monospace;color:var(--pur2);margin-top:2px}',
    '.rp-acts{display:flex;gap:8px;flex-wrap:wrap}.rp-acts>*{flex:1 1 150px;text-align:center;text-decoration:none}',
    '.rp-vid{font-size:11.5px;color:var(--mute);margin-top:6px;line-height:1.5}',
    '.rp .sx-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}'
  ].join('\n');

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────
  var U = Studio.u;
  function esc(s) { return U.esc(s); }
  function getJ(p) { return fetch(p + '?v=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
  function ease(x) { x = Math.max(0, Math.min(1, x)); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function later(f) { return new Promise(function (res) { setTimeout(function () { res(f()); }, 0); }); }

  // the user's legs on this game: saved picks (and saved parlays' legs) and the slip
  function myLegs(gid) {
    var out = [], seen = {};
    function add(l, src) { if (!l || l.gid !== gid || l.sport && l.sport !== SP) return; var k = l.sel || l.id || l.label; if (seen[k]) return; seen[k] = 1; out.push(Object.assign({src: src}, l)); }
    try { if (window.OnyxSaved) OnyxSaved.all().forEach(function (p) { if (p.kind === 'parlay') (p.legs || []).forEach(function (l) { add(l, 'saved'); }); else add(p, 'saved'); }); } catch (e) {}
    try { if (window.OnyxParlay) OnyxParlay.slip().forEach(function (l) { add(l, 'slip'); }); } catch (e) {}
    return out;
  }

  // ── the timeline: real seconds for every stretch of game clock and every dead ball ───────────────────────
  var DEAD = {ft: 1.15, timeout: 0.9, sub: 0.3, five: 1.1, start: 1.2, end: 1.6, jump: 1.3, final: 3};
  // highlights: possessions by tier (the last two minutes and overtime and the tip, then clutch, then the 4-star
  // callouts, then 3, then 2); the lowest tiers drop until the whole game fits in about 80 seconds
  function hlTiers(game) {
    var tier = {}, ev = game.events, nReg = CF.per.length, pStart = game.pStart;
    ev.forEach(function (e) {
      if (e.poss == null) return;
      var late = e.per >= nReg - 1 && pStart[e.per + 1] - e.t <= 120, t = late || e.per >= nReg ? 6 : e.call ? Math.min(5, e.call.pri) : 0;
      if (t >= 2) tier[e.poss] = Math.max(tier[e.poss] || 0, t);
    });
    tier[0] = 6;
    return tier;
  }
  function highlights(game, min) { var t = hlTiers(game), out = {}; Object.keys(t).forEach(function (k) { if (t[k] >= min) out[k] = t[k]; }); return out; }
  function timeline(game, speed, hl, minTier, squeeze) {
    if (hl && minTier == null) {
      for (var mt = 2; mt <= 6; mt++) {
        var t2 = timeline(game, speed, true, mt);
        if (t2.total <= 85) return t2;
        // even the last two minutes and overtime run long (a multi-overtime game): play them faster
        if (mt === 6) return timeline(game, speed, true, 6, 85 / t2.total);
      }
    }
    var sq = squeeze || 1;
    var ev = game.events, items = [], lastT = 0, R = 0, hot = hl ? highlights(game, minTier) : null;
    var deadK = speed >= 60 ? 0.16 : speed >= 16 ? 0.32 : speed >= 4 ? 0.6 : 1;
    function poss(e) { return e.poss != null ? e.poss : null; }
    ev.forEach(function (e) {
      if (e.t > lastT + 1e-6) {
        var g = e.t - lastT, p = poss(e), on = hot ? hot[p] != null : true, d;
        if (hot) d = on ? clamp(g / 2.2, 0.55, 5) * sq : g / 700;
        else d = g / speed;
        items.push({k: 'run', t0: lastT, t1: e.t, d: d, ev: [], p: p, on: on});
        lastT = e.t;
      }
      var dead = DEAD[e.type] && !(e.type === 'sub' && hot && !hot[poss(e)]);
      if (dead) {
        var on2 = hot ? (e.poss != null ? hot[e.poss] != null : e.type === 'final' || e.type === 'end' || e.type === 'start' || e.type === 'jump' || e.type === 'five') : true;
        var dd = hot ? (on2 ? DEAD[e.type] * (e.type === 'end' ? 0.7 : 1) * Math.max(0.5, sq) : 0.015) : DEAD[e.type] * deadK;
        items.push({k: 'dead', t0: e.t, t1: e.t, d: dd, ev: [e], p: poss(e), on: on2, type: e.type});
      } else {
        if (!items.length) items.push({k: 'dead', t0: 0, t1: 0, d: 0.01, ev: [], p: null});
        items[items.length - 1].ev.push(e);
      }
    });
    var RE = new Float64Array(ev.length);   // when each event lands, in this timeline's real seconds
    items.forEach(function (it) {
      it.R0 = R; R += it.d; it.R1 = R;
      it.apply = it.k === 'dead' ? it.R0 + 0.55 * it.d : it.R1;
      it.ev.forEach(function (e) { RE[e.i] = it.apply; });
      it.last = it.ev.length ? it.ev[it.ev.length - 1].i : null;
    });
    // the last event index applied by the end of each item (for quick lookups)
    var lastI = -1; items.forEach(function (it) { if (it.last != null) lastI = it.last; it.upto = lastI; });
    return {items: items, total: R, speed: speed, hl: !!hl, RE: RE};
  }
  function itemAt(TL, R) {
    var a = 0, b = TL.items.length - 1;
    if (R <= 0) return 0; if (R >= TL.total) return b;
    while (a < b) { var m = (a + b) >> 1; if (TL.items[m].R1 <= R) a = m + 1; else b = m; }
    return a;
  }
  // where the game stands at real time R
  function stateAt(game, TL, R) {
    var ii = itemAt(TL, R), it = TL.items[ii], f = it.d > 0 ? clamp((R - it.R0) / it.d, 0, 1) : 1;
    var T = it.k === 'run' ? lerp(it.t0, it.t1, f) : it.t0;
    var prev = ii > 0 ? TL.items[ii - 1].upto : -1, idx = R >= it.apply - 1e-9 ? it.upto : prev;
    if (R >= TL.total - 1e-6) idx = game.events.length - 1;
    return {R: R, ii: ii, it: it, f: f, T: T, idx: idx};
  }
  function timeOfEvent(TL, i) { for (var q = 0; q < TL.items.length; q++) { var it = TL.items[q]; if (it.upto >= i && it.ev.some(function (e) { return e.i >= i; })) return it.apply; } return TL.total; }
  function realForT(TL, T) { for (var q = 0; q < TL.items.length; q++) { var it = TL.items[q]; if (it.t1 >= T) return it.k === 'run' && it.t1 > it.t0 ? it.R0 + it.d * clamp((T - it.t0) / (it.t1 - it.t0), 0, 1) : it.R0; } return TL.total; }

  // ── the court: geometry, sets, the ball ──────────────────────────────────────────────────────────────────
  var HOOP_X = 5.25, LEN = 94, WID = 50;
  var OFF = [[24, 1.5], [14, -18], [3, 21.5], [16, 12.5], [5.5, -7]];   // (feet from the hoop toward half court, across)
  function attacksRight(game, team, per) { var first = per < CF.half; return team === 'A' ? first : !first; }
  function hoop(right) { return {x: right ? LEN - HOOP_X : HOOP_X, y: 25}; }
  function spot(right, u, v) { return right ? {x: LEN - HOOP_X - u, y: 25 + v} : {x: HOOP_X + u, y: 25 - v}; }
  function slotsOf(game, five) { return five.slice().sort(function (a, b) { return (game.byId[a].rank - game.byId[b].rank) || (game.byId[b].proj.ast - game.byId[a].proj.ast); }); }
  function wob(id, T, amp) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997; return {x: amp * Math.sin(T * 0.8 + h), y: amp * Math.cos(T * 0.63 + h * 1.7)}; }

  // the scene at a state: every player's spot, the ball, what to draw on top
  function scene(game, TL, st) {
    var ev = game.events, idx = Math.max(0, st.idx), T = st.T, it = st.it;
    var onA = game.onA[Math.max(0, Math.min(ev.length - 1, idx < 0 ? 0 : idx))] || [], onH = game.onH[Math.max(0, idx)] || [];
    if (onA.length < 5 || onH.length < 5) { var f0 = 0; while (f0 < ev.length - 1 && (game.onA[f0].length < 5 || game.onH[f0].length < 5)) f0++; onA = game.onA[f0]; onH = game.onH[f0]; }
    // the possession in play: this item's, else the next one coming
    var pi = it.p, q = st.ii;
    while (pi == null && q < TL.items.length - 1) { q++; pi = TL.items[q].p; }
    if (pi == null) pi = game.poss.length - 1;
    var P = game.poss[pi], per = P.per, offT = P.team, defT = offT === 'A' ? 'H' : 'A';
    var right = attacksRight(game, offT, per), H = hoop(right);
    var off = slotsOf(game, offT === 'A' ? onA : onH), def = slotsOf(game, defT === 'A' ? onA : onH);
    var pos = {}, out = {P: P, offT: offT, right: right, hoop: H, ball: null, arc: null, pass: null, flash: null, ft: null, hand: null, players: []};
    // the set: offense in its spots, defense between each man and the hoop
    off.forEach(function (id, s) { var o = OFF[s], w = wob(id, T, 1.3); pos[id] = spot(right, o[0] + w.x, o[1] + w.y); });
    def.forEach(function (id, s) { var m = pos[off[s]], w = wob(id, T, 0.8); pos[id] = {x: lerp(m.x, H.x, 0.3) + w.x * 0.5, y: lerp(m.y, H.y, 0.3) + w.y * 0.5}; });
    // the attempt in play: its finishing event and how far through it we are
    var fin = null;
    for (var j = Math.max(0, P.ev0); j <= P.ev1; j++) { var e = ev[j]; if ((e.type === 'shot' || e.type === 'to' || (e.type === 'foul' && e.kind === 'shooting' && e.a0 != null)) && e.t >= T - 1e-6) { fin = e; break; } }
    var u = 1, handler = off[0];
    if (fin && fin.t > fin.a0) u = clamp((T - fin.a0) / (fin.t - fin.a0), 0, 1);
    if (it.k === 'dead' && fin && Math.abs(fin.t - T) < 1e-6) u = 1;
    if (RM) u = u < 0.75 ? 0.4 : 1;
    // transition: the first stretch of a possession runs in from the other end
    var prevP = pi > 0 ? game.poss[pi - 1] : null, first = fin && fin.att === 0;
    if (first && fin && prevP && prevP.team !== offT && !RM) {
      var k = ease(u / 0.38);
      if (k < 1) {
        var pr = !right, pH = hoop(pr);
        off.forEach(function (id, s) { var o = OFF[s], fromP = {x: lerp(spot(pr, o[0], o[1]).x, pH.x, 0.3), y: lerp(spot(pr, o[0], o[1]).y, pH.y, 0.3)}; pos[id] = {x: lerp(fromP.x, pos[id].x, k), y: lerp(fromP.y, pos[id].y, k)}; });
        def.forEach(function (id, s) { var o = OFF[s], fromP = spot(pr, o[0], o[1]); pos[id] = {x: lerp(fromP.x, pos[id].x, k), y: lerp(fromP.y, pos[id].y, k)}; });
      }
      out.pan = {from: pr, to: right, k: k};
    }
    var ballAt = function (id) { var p = pos[id]; return p ? {x: p.x + (right ? -0.9 : 0.9), y: p.y + 0.6} : {x: H.x, y: H.y}; };
    var ball = ballAt(handler), holder = handler;
    // an offensive rebound: the attempt starts with the ball where the rebounder got it
    if (fin && fin.att > 0) { var rb = null; for (var j2 = fin.i - 1; j2 >= P.ev0; j2--) if (ev[j2].type === 'reb') { rb = ev[j2]; break; } if (rb && rb.p) { holder = rb.p; handler = rb.p; } }
    if (fin && fin.type === 'shot') {
      var sh = fin.p, a = fin.ast, d = fin.dist, ang = fin.ang || 0;
      var sp = spot(right, Math.max(0.5, d * Math.cos(ang)), d * Math.sin(ang));
      // the shooter works to his spot
      if (pos[sh]) { var k2 = ease((u - 0.45) / 0.3); pos[sh] = {x: lerp(pos[sh].x, sp.x, k2), y: lerp(pos[sh].y, sp.y, k2)}; }
      // a defender closes out (or the shot blocker rises)
      var dsh = def[off.indexOf(sh)]; if (fin.blk) dsh = fin.blk;
      if (dsh && pos[dsh] && pos[sh]) { var k3 = ease((u - 0.55) / 0.25); pos[dsh] = {x: lerp(pos[dsh].x, lerp(pos[sh].x, H.x, 0.18), k3), y: lerp(pos[dsh].y, pos[sh].y + 1.2, k3)}; }
      // passes: handler -> assister -> shooter
      var chain = [handler]; if (a && a !== handler) chain.push(a); if (sh !== chain[chain.length - 1]) chain.push(sh);
      var tp = chain.length === 3 ? [0.38, 0.62] : chain.length === 2 ? [0.55] : [];
      holder = chain[0];
      for (var c = 0; c < tp.length; c++) {
        if (u >= tp[c] + 0.1) holder = chain[c + 1];
        else if (u >= tp[c]) { var f2 = (u - tp[c]) / 0.1, A0 = ballAt(chain[c]), B0 = ballAt(chain[c + 1]); ball = {x: lerp(A0.x, B0.x, f2), y: lerp(A0.y, B0.y, f2)}; out.pass = {a: A0, b: B0}; holder = null; break; }
      }
      if (holder) ball = ballAt(holder);
      if (u >= 0.78) {
        var S0 = ballAt(sh), s2 = clamp((u - 0.78) / 0.17, 0, 1);
        out.arc = {a: S0, b: H, s: s2, made: fin.made, fg: fin.fg, blk: !!fin.blk};
        holder = null;
        if (fin.blk && s2 > 0.25) { var bx = pos[fin.blk]; ball = {x: lerp(bx.x, bx.x + (right ? 6 : -6), (s2 - 0.25)), y: lerp(bx.y, bx.y + 5, s2 - 0.25)}; out.arc.cut = 0.25; }
        else ball = null;
        if (s2 >= 1) { out.arc = null; ball = {x: H.x, y: H.y}; if (fin.made) out.flash = {x: H.x, y: H.y, k: clamp((u - 0.95) / 0.05, 0, 1), fg: fin.fg, by: sh}; }
      }
      out.shooter = sh;
    } else if (fin && fin.type === 'to') {
      if (u >= 0.72) {
        var f3 = clamp((u - 0.72) / 0.22, 0, 1), A1 = ballAt(handler);
        if (fin.stl && pos[fin.stl]) { var B1 = ballAt(fin.stl); ball = {x: lerp(A1.x, B1.x, f3), y: lerp(A1.y, B1.y, f3)}; }
        else ball = {x: lerp(A1.x, A1.x + (right ? -4 : 4), f3), y: lerp(A1.y, A1.y < 25 ? -1 : 51, f3)};
        holder = null;
      }
    } else if (fin && fin.type === 'foul') {
      var who = fin.on; if (pos[who]) { var k4 = ease((u - 0.4) / 0.4); var sp2 = spot(right, 6, (pos[who].y - 25) * 0.3); pos[who] = {x: lerp(pos[who].x, sp2.x, k4), y: lerp(pos[who].y, sp2.y, k4)}; if (u > 0.5) { holder = who; ball = ballAt(who); } }
    }
    // a free-throw trip (the clock is stopped): the shooter at the line, everyone else on the lane
    var cur = it.ev[0];
    if (it.k === 'dead' && cur && cur.type === 'ft') {
      var line = spot(right, 13.75, 0); pos[cur.p] = line;
      // the lane: defense on the blocks and the third spots, offense in between (a step wider), the rest at the arc
      var dL = [[1.5, 9.4], [1.5, -9.4], [9, 9.4], [9, -9.4], [27, 0]], oL = [[5.2, 12], [5.2, -12], [25, 16], [25, -16]], di = 0, oi = 0;
      def.forEach(function (id) { var L = dL[di++ % dL.length]; pos[id] = spot(right, L[0], L[1]); });
      off.forEach(function (id) { if (id === cur.p) return; var L = oL[oi++ % oL.length]; pos[id] = spot(right, L[0], L[1]); });
      var f4 = it.d > 0 ? clamp((st.R - it.R0) / it.d, 0, 1) : 1, from = ballAt(cur.p);
      if (f4 < 0.3) ball = from; else { out.arc = {a: from, b: H, s: clamp((f4 - 0.3) / 0.3, 0, 1), made: cur.made, fg: 1}; ball = null; if (f4 >= 0.6) { out.arc = null; ball = cur.made ? {x: H.x, y: H.y} : {x: H.x + (right ? -3 : 3), y: H.y + 3}; if (cur.made) out.flash = {x: H.x, y: H.y, k: clamp((f4 - 0.6) / 0.3, 0, 1), fg: 1}; } }
      holder = null; out.ft = cur;
    }
    // the opening tip
    if (it.k === 'dead' && cur && (cur.type === 'jump' || cur.type === 'five' || cur.type === 'start') && cur.per === 0) {
      var cA = cur.type === 'jump' ? cur.p : null;
      off.concat(def).forEach(function (id, n) { var side = game.byId[id].side === 'A' ? -1 : 1, s = n % 5; pos[id] = {x: 47 + side * (s === 4 ? 1.6 : 9 + s * 2), y: 25 + (s === 4 ? 0 : (s - 1.5) * 7)}; });
      if (cA) pos[cA] = {x: 47 - 1.6 * (game.byId[cA].side === 'A' ? 1 : -1), y: 25};
      ball = {x: 47, y: 25 - 3 * Math.sin(Math.PI * clamp(st.f, 0, 1))}; holder = null;
    }
    if (holder) out.hand = holder;
    out.ball = ball;
    off.forEach(function (id) { out.players.push({id: id, x: pos[id].x, y: pos[id].y, team: offT, off: true, hand: id === holder || id === out.shooter && !!out.arc}); });
    def.forEach(function (id) { out.players.push({id: id, x: pos[id].x, y: pos[id].y, team: defT, off: false}); });
    return out;
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────
  var IMG = {}, LOGO = {};
  function headshot(p) {
    if (!p.hs) return null;
    if (IMG[p.id]) return IMG[p.id];
    var im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async';
    var rec = IMG[p.id] = {img: im, ok: false};
    im.onload = function () { rec.ok = true; SPR = {}; };
    im.onerror = function () { rec.bad = true; };
    im.src = p.hs;
    return rec;
  }
  function logoImg(src, key) {
    if (!src) return null;
    if (LOGO[key]) return LOGO[key];
    var im = new Image(); if (!/^data:/.test(src)) im.crossOrigin = 'anonymous';
    var rec = LOGO[key] = {img: im, ok: false}; im.onload = function () { rec.ok = true; }; im.src = src; return rec;
  }
  var SPR = {};
  function sprite(p, r, team, dpr) {
    var key = p.id + '|' + Math.round(r * dpr);
    if (SPR[key]) return SPR[key];
    var R = Math.round(r * dpr), cv = document.createElement('canvas'); cv.width = cv.height = 2 * R + 4;
    var x = cv.getContext('2d'), c = R + 2;
    x.save(); x.beginPath(); x.arc(c, c, R, 0, Math.PI * 2); x.closePath(); x.fillStyle = team === 'A' ? '#24123a' : '#22202a'; x.fill(); x.clip();
    var h = headshot(p);
    if (h && h.ok) { var iw = h.img.naturalWidth, ih = h.img.naturalHeight, s = (2 * R * 1.32) / ih; x.drawImage(h.img, c - iw * s / 2, c - R * 1.05, iw * s, ih * s); }
    else {
      x.fillStyle = team === 'A' ? COL.pur2 : '#ece6f4'; x.font = '800 ' + Math.round(R * 0.82) + 'px ' + DISPLAY; x.textAlign = 'center'; x.textBaseline = 'middle';
      var ini = String(p.name || '').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('');
      x.fillText(ini, c, c + 1);
    }
    x.restore();
    x.beginPath(); x.arc(c, c, R - 0.5, 0, Math.PI * 2); x.lineWidth = Math.max(2, R * 0.13); x.strokeStyle = team === 'A' ? COL.A : COL.H; x.stroke();
    if (!(h && !h.ok && !h.bad)) SPR[key] = cv;   // re-render once the headshot arrives
    return cv;
  }
  var COURT = {};
  function courtImg(scale, dpr) {
    var key = scale.toFixed(3) + '|' + dpr;
    if (COURT[key]) return COURT[key];
    var s = scale * dpr, cv = document.createElement('canvas'); cv.width = Math.ceil(LEN * s); cv.height = Math.ceil(WID * s);
    var x = cv.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, cv.height); g.addColorStop(0, '#16111c'); g.addColorStop(1, '#110e15'); x.fillStyle = g; x.fillRect(0, 0, cv.width, cv.height);
    // floor boards, barely there
    x.globalAlpha = 0.018; x.fillStyle = '#ffffff'; for (var b = 0; b < LEN; b += 2.2) if (Math.floor(b / 2.2) % 2) x.fillRect(b * s, 0, 2.2 * s, cv.height); x.globalAlpha = 1;
    var rg = x.createRadialGradient(cv.width / 2, cv.height / 2, 0, cv.width / 2, cv.height / 2, cv.width * 0.45); rg.addColorStop(0, 'rgba(176,56,249,.16)'); rg.addColorStop(1, 'rgba(176,56,249,0)'); x.fillStyle = rg; x.fillRect(0, 0, cv.width, cv.height);
    x.strokeStyle = 'rgba(232,220,255,.42)'; x.lineWidth = Math.max(1, 0.17 * s);
    var X = function (f) { return f * s; };
    x.strokeRect(X(0.1), X(0.1), X(LEN - 0.2), X(WID - 0.2));
    x.beginPath(); x.moveTo(X(47), 0); x.lineTo(X(47), cv.height); x.stroke();
    x.beginPath(); x.arc(X(47), X(25), X(6), 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(X(47), X(25), X(2), 0, Math.PI * 2); x.stroke();
    // the Onyx mark at center court
    try { x.save(); var mk = new Path2D(MARK), ms = X(7) / 137; x.translate(X(47) - 50 * ms, X(25) - 68 * ms); x.scale(ms, ms); x.fillStyle = 'rgba(176,56,249,.35)'; x.fill(mk); x.restore(); } catch (e) {}
    [false, true].forEach(function (right) {
      var hx = right ? LEN - HOOP_X : HOOP_X, dir = right ? -1 : 1, base = right ? LEN : 0;
      // the paint
      x.fillStyle = 'rgba(176,56,249,.13)'; x.fillRect(X(right ? LEN - 19 : 0), X(17), X(19), X(16)); x.strokeRect(X(right ? LEN - 19 : 0), X(17), X(19), X(16));
      x.beginPath(); x.arc(X(base + dir * 19), X(25), X(6), right ? Math.PI / 2 : -Math.PI / 2, right ? Math.PI * 1.5 : Math.PI / 2); x.stroke();
      // the three-point line: corners, then the arc
      x.beginPath(); x.moveTo(X(base), X(3)); x.lineTo(X(base + dir * 14), X(3)); x.stroke();
      x.beginPath(); x.moveTo(X(base), X(47)); x.lineTo(X(base + dir * 14), X(47)); x.stroke();
      var a0 = Math.asin(22 / 23.75);
      x.beginPath(); if (right) x.arc(X(hx), X(25), X(23.75), Math.PI - a0, Math.PI + a0); else x.arc(X(hx), X(25), X(23.75), -a0, a0); x.stroke();
      // restricted area, backboard, rim
      x.beginPath(); x.arc(X(hx), X(25), X(4), right ? Math.PI / 2 : -Math.PI / 2, right ? Math.PI * 1.5 : Math.PI / 2); x.stroke();
      x.lineWidth = Math.max(1.5, 0.3 * s); x.strokeStyle = 'rgba(255,255,255,.8)'; x.beginPath(); x.moveTo(X(base + dir * 4), X(22)); x.lineTo(X(base + dir * 4), X(28)); x.stroke();
      x.strokeStyle = COL.ball; x.beginPath(); x.arc(X(hx), X(25), X(0.75), 0, Math.PI * 2); x.stroke();
      x.strokeStyle = 'rgba(232,220,255,.42)'; x.lineWidth = Math.max(1, 0.17 * s);
    });
    COURT[key] = cv; return cv;
  }

  // draw the court into rect r of context x: full court, or a half-court camera that follows the ball
  function drawCourt(x, r, game, TL, st, o) {
    o = o || {};
    var dpr = o.dpr || 1, full = !!o.full;
    var sc = scene(game, TL, st);
    var viewW = full ? LEN : 52, scale = Math.min(r.w / viewW, r.h / WID), drawH = WID * scale, oy = r.y + (r.h - drawH) / 2;
    var camX;   // world x at the left of the view
    if (full) camX = 0;
    else {
      var cR = LEN - viewW, cL = 0, target = sc.right ? cR : cL;
      if (sc.pan && sc.pan.k < 1) target = lerp(sc.pan.from ? cR : cL, target, sc.pan.k);
      camX = target;
    }
    var ox = r.x + (r.w - viewW * scale) / 2;
    var W = function (p) { return {x: ox + (p.x - camX) * scale, y: oy + p.y * scale}; };
    x.save(); x.beginPath(); x.rect(r.x, r.y, r.w, r.h); x.clip();
    x.fillStyle = '#100d14'; x.fillRect(r.x, r.y, r.w, r.h);
    var cimg = courtImg(scale, dpr);
    x.drawImage(cimg, camX * scale * dpr, 0, viewW * scale * dpr, WID * scale * dpr, ox, oy, viewW * scale, drawH);
    var pr = Math.max(9, 2.25 * scale) * (o.big || 1);
    // the pass line and the shot arc (dashed, like a telestrator)
    if (sc.pass) { var A = W(sc.pass.a), B = W(sc.pass.b); x.setLineDash([4, 4]); x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(A.x, A.y); x.lineTo(B.x, B.y); x.stroke(); x.setLineDash([]); }
    if (sc.arc) {
      var a = W(sc.arc.a), b = W(sc.arc.b), lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.45 + 12), end = sc.arc.cut ? Math.min(sc.arc.s, sc.arc.cut) : sc.arc.s;
      var pt = function (t) { return {x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) - Math.sin(Math.PI * t) * lift}; };
      x.strokeStyle = sc.arc.made ? 'rgba(97,233,112,.85)' : 'rgba(255,255,255,.6)'; x.lineWidth = 2.2; x.beginPath();
      for (var t = 0; t <= end + 1e-6; t += 0.04) { var p = pt(Math.min(t, end)); if (t === 0) x.moveTo(p.x, p.y); else x.lineTo(p.x, p.y); }
      x.stroke();
      if (!sc.ball) { var bp = pt(end); drawBall(x, bp.x, bp.y, pr * 0.42); }
    }
    // players: defense first, offense on top, the ball handler last
    var ps = sc.players.slice().sort(function (p, q) { return (p.off - q.off) || ((p.hand ? 1 : 0) - (q.hand ? 1 : 0)); });
    ps.forEach(function (pl) {
      var p = game.byId[pl.id], c = W(pl), rr = pl.off ? pr : pr * 0.9;
      if (pl.hand) { x.save(); x.shadowColor = 'rgba(176,56,249,.95)'; x.shadowBlur = 16; x.beginPath(); x.arc(c.x, c.y, rr + 3, 0, Math.PI * 2); x.fillStyle = 'rgba(255,255,255,.95)'; x.fill(); x.restore(); }
      var spr = sprite(p, rr, pl.team, dpr); x.drawImage(spr, c.x - rr - 2 / dpr, c.y - rr - 2 / dpr, (spr.width) / dpr, (spr.height) / dpr);
      if (o.names !== false && (pl.off || full)) {
        var fs = Math.max(9, Math.round(rr * 0.62)); x.font = '800 ' + fs + 'px ' + DISPLAY; x.textAlign = 'center'; x.textBaseline = 'top';
        var nm = String(p.last || '').toUpperCase(); x.lineWidth = 3; x.strokeStyle = 'rgba(12,12,12,.9)'; x.strokeText(nm, c.x, c.y + rr + 3); x.fillStyle = pl.hand ? '#fff' : 'rgba(255,255,255,.82)'; x.fillText(nm, c.x, c.y + rr + 3);
      }
    });
    if (sc.ball) { var bb = W(sc.ball), bounce = sc.hand ? Math.abs(Math.sin(st.T * 9)) * pr * 0.25 : 0; drawBall(x, bb.x, bb.y - bounce, pr * 0.42); }
    if (sc.flash) {
      var f = W(sc.flash); x.save(); x.globalAlpha = 1 - sc.flash.k * 0.6; x.strokeStyle = COL.grn; x.lineWidth = 3; x.beginPath(); x.arc(f.x, f.y, pr * (0.6 + sc.flash.k * 1.4), 0, Math.PI * 2); x.stroke(); x.restore();
    }
    // the made-shot badge, the possession pill, the label
    var lastShot = recentEvent(game, TL, st, function (e) { return (e.type === 'shot' && e.made) || (e.type === 'ft' && e.made && e.and1); }, 1.4);
    if (lastShot && pr) {
      var by = game.byId[lastShot.e.p], pl2 = sc.players.filter(function (q) { return q.id === lastShot.e.p; })[0];
      if (pl2) { var c2 = W(pl2), up = lastShot.age * 18; x.save(); x.globalAlpha = 1 - lastShot.age / 1.4; x.font = '900 ' + Math.round(pr * 1.05) + 'px ' + DISPLAY; x.textAlign = 'center'; x.fillStyle = COL.grn; x.fillText('+' + (lastShot.e.type === 'ft' ? 1 : lastShot.e.fg), c2.x, c2.y - pr - 8 - up); x.restore(); }
      void by;
    }
    if (o.pill !== false) pill(x, r, game, sc, o);
    if (o.label !== false) { var fs2 = Math.max(9, Math.round(r.w / 62)); x.font = '700 ' + fs2 + 'px ' + MONO; x.textAlign = 'right'; x.textBaseline = 'bottom'; x.fillStyle = 'rgba(215,149,255,.7)'; x.fillText(LABEL.toUpperCase(), r.x + r.w - 8, r.y + r.h - 6); }
    callout(x, r, game, TL, st, o);
    x.restore();
    return sc;
  }
  function drawBall(x, cx, cy, r) {
    x.save(); x.shadowColor = 'rgba(0,0,0,.5)'; x.shadowBlur = 4; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = COL.ball; x.fill(); x.restore();
    x.strokeStyle = 'rgba(60,20,0,.6)'; x.lineWidth = Math.max(0.8, r * 0.14); x.beginPath(); x.moveTo(cx - r, cy); x.lineTo(cx + r, cy); x.moveTo(cx, cy - r); x.lineTo(cx, cy + r); x.stroke();
  }
  function rr(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
  function pill(x, r, game, sc, o) {
    var t = sc.offT, ab = game.rost[t][0].abbr, txt = (sc.right ? '' : '◀ ') + ab + ' BALL' + (sc.right ? ' ▶' : ''), fs = Math.max(10, Math.round(r.w / 48));
    x.font = '800 ' + fs + 'px ' + MONO; var w = x.measureText(txt).width + fs * 1.8, h = fs * 2, X = r.x + r.w / 2 - w / 2, Y = r.y + 8;
    rr(x, X, Y, w, h, h / 2); x.fillStyle = t === 'A' ? COL.pur : '#e9e3f2'; x.fill();
    x.fillStyle = t === 'A' ? '#fff' : '#17121d'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, r.x + r.w / 2, Y + h / 2 + 1);
  }
  // the most recent event matching f, applied within `win` real seconds before now
  function recentEvent(game, TL, st, f, win) {
    for (var i = st.idx; i >= 0 && i > st.idx - 14; i--) { var e = game.events[i], at = TL.RE[i]; if (st.R - at > win) break; if (f(e)) return {e: e, age: st.R - at}; }
    return null;
  }
  var EXTRA_CALLS = [];   // [{i, title, sub, kind}] from the UI (your bets)
  function callout(x, r, game, TL, st, o) {
    var hit = recentEvent(game, TL, st, function (e) { return !!e.call || EXTRA_CALLS.some(function (c) { return c.i === e.i; }); }, 2.4);
    if (!hit) return;
    var mine = EXTRA_CALLS.filter(function (c) { return c.i === hit.e.i; })[0], c = mine || hit.e.call;
    var p = game.byId[c.p || hit.e.p], age = hit.age, k = RM ? 1 : Math.min(1, age / 0.18), out = age > 2.0 ? 1 - (age - 2.0) / 0.4 : 1;
    var fsT = Math.max(16, Math.round(r.w / 17)), fsS = Math.max(10, Math.round(r.w / 46)), pad = fsS, hs = fsT * 1.9;
    x.font = '900 ' + fsT + 'px ' + DISPLAY; var tw = x.measureText(c.title.toUpperCase()).width; x.font = '700 ' + fsS + 'px ' + MONO; var sw = x.measureText(c.sub || '').width;
    var w = Math.min(r.w - 24, Math.max(tw, sw) + hs + pad * 3), h = hs + pad * 1.2, X = r.x + (r.w - w) / 2, Y = r.y + r.h * 0.13;
    x.save(); x.globalAlpha = Math.max(0, out); x.translate(X + w / 2, Y + h / 2); x.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k); x.translate(-(X + w / 2), -(Y + h / 2));
    x.shadowColor = 'rgba(176,56,249,.7)'; x.shadowBlur = 28; rr(x, X, Y, w, h, 14);
    var g = x.createLinearGradient(X, Y, X + w, Y + h); g.addColorStop(0, mine ? '#1f7a33' : COL.purD); g.addColorStop(1, mine ? '#2fb34a' : COL.pur); x.fillStyle = g; x.fill(); x.shadowBlur = 0;
    var cx = X + pad + hs / 2, cy = Y + h / 2;
    if (p) { var spr = sprite(p, hs / 2, p.side, o.dpr || 1); x.drawImage(spr, cx - hs / 2 - 2 / (o.dpr || 1), cy - hs / 2 - 2 / (o.dpr || 1), spr.width / (o.dpr || 1), spr.height / (o.dpr || 1)); }
    var tx = X + pad * 2 + hs; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    x.font = '900 ' + fsT + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.fillText(c.title.toUpperCase(), tx, cy - 2, w - (tx - X) - pad);
    x.font = '700 ' + fsS + 'px ' + MONO; x.fillStyle = 'rgba(255,255,255,.88)'; x.fillText(c.sub || '', tx, cy + fsS + 4, w - (tx - X) - pad);
    x.restore();
  }

  // ── the video frame: everything on one canvas (story 1080x1920, landscape 1920x1080) ─────────────────────
  var LAYOUT = {story: [1080, 1920], land: [1920, 1080]};
  function frame(x, W, H, layout, V, R) {
    var game = V.game, TL = V.TL, st = stateAt(game, TL, R), story = layout === 'story', P = story ? 48 : 56;
    var bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#120d18'); bg.addColorStop(1, '#0c0c0c'); x.fillStyle = bg; x.fillRect(0, 0, W, H);
    var glow = x.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.8); glow.addColorStop(0, 'rgba(176,56,249,.28)'); glow.addColorStop(1, 'rgba(176,56,249,0)'); x.fillStyle = glow; x.fillRect(0, 0, W, H * 0.5);
    // header: the mark, Sim Replay, the scenario
    var y = story ? 70 : 52;
    try { x.save(); var mk = new Path2D(MARK), ms = (story ? 52 : 44) / 137; x.translate(P, y - (story ? 44 : 36)); x.scale(ms, ms); x.fillStyle = COL.pur; x.fill(mk); x.restore(); } catch (e) {}
    x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    x.font = '900 ' + (story ? 46 : 38) + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.fillText('ONYX SIM REPLAY', P + (story ? 54 : 48), y);
    x.font = '700 ' + (story ? 26 : 22) + 'px ' + MONO; x.fillStyle = COL.pur2;
    var sub = (V.title || 'Most likely game') + ' · ' + game.rost.A[0].abbr + ' @ ' + game.rost.H[0].abbr;
    if (story) x.fillText(sub.toUpperCase(), P, y + 44); else x.fillText(sub.toUpperCase(), P + 470, y);
    // the honesty label
    var lt = LABEL.toUpperCase(); x.font = '800 ' + (story ? 22 : 19) + 'px ' + MONO; var lw = x.measureText(lt).width + 40, lh = story ? 42 : 36;
    var lx = story ? P : W - P - lw, ly = story ? y + 74 : y - 26;
    rr(x, lx, ly, lw, lh, lh / 2); x.fillStyle = 'rgba(176,56,249,.16)'; x.fill(); x.strokeStyle = 'rgba(176,56,249,.6)'; x.lineWidth = 2; x.stroke();
    x.fillStyle = '#ecdcff'; x.textBaseline = 'middle'; x.fillText(lt, lx + 20, ly + lh / 2); x.textBaseline = 'alphabetic';
    // scoreboard
    var sbY = story ? ly + 64 : 92, sbH = story ? 300 : 196;
    scoreboard(x, {x: P, y: sbY, w: W - 2 * P, h: sbH}, game, st, story);
    var fin = st.idx >= game.events.length - 1 && R >= TL.total - 0.01;
    var finAge = fin ? R - TL.total : -1;
    if (story) {
      var cy = sbY + sbH + 24, chh = 960;
      if (finAge < 0.4) drawCourt(x, {x: P, y: cy, w: W - 2 * P, h: chh}, game, TL, st, {dpr: 1, full: false, big: 1.15, label: false});
      else finalCard(x, {x: P, y: cy, w: W - 2 * P, h: chh}, V, story);
      roundBorder(x, P, cy, W - 2 * P, chh);
      logBlock(x, {x: P, y: cy + chh + 22, w: W - 2 * P, h: 250}, game, st, story);
      cta(x, W, H, P, story);
    } else {
      var cy2 = sbY + sbH + 18, cw = 1180, ch2 = 610;
      if (finAge < 0.4) drawCourt(x, {x: P, y: cy2, w: cw, h: ch2}, game, TL, st, {dpr: 1, full: true, big: 1.05, label: false});
      else finalCard(x, {x: P, y: cy2, w: cw, h: ch2}, V, story);
      roundBorder(x, P, cy2, cw, ch2);
      miniBox(x, {x: P + cw + 30, y: cy2, w: W - 2 * P - cw - 30, h: ch2}, game, st);
      logBlock(x, {x: P, y: cy2 + ch2 + 16, w: cw, h: H - (cy2 + ch2 + 16) - 22}, game, st, story);
      cta(x, W, H, P, story, {x: P + cw + 30, w: W - 2 * P - cw - 30});
    }
    return st;
  }
  function roundBorder(x, X, Y, w, h) { x.save(); rr(x, X, Y, w, h, 22); x.strokeStyle = 'rgba(255,255,255,.12)'; x.lineWidth = 2; x.stroke(); x.restore(); }
  function scoreboard(x, r, game, st, story) {
    rr(x, r.x, r.y, r.w, r.h, 26); x.fillStyle = 'rgba(255,255,255,.045)'; x.fill(); x.strokeStyle = 'rgba(255,255,255,.1)'; x.lineWidth = 2; x.stroke();
    var e = game.events[Math.max(0, st.idx)] || {A: 0, H: 0, wp: 0.5}, cx = r.x + r.w / 2, ty = r.y + r.h * 0.42;
    var fsS = story ? 104 : 84, lg = story ? 92 : 74;
    [['A', -1], ['H', 1]].forEach(function (t) {
      var side = t[0], dir = t[1], ab = game.rost[side][0].abbr, lgX = dir < 0 ? r.x + 36 : r.x + r.w - 36 - lg;
      var li = V_LOGOS[side]; if (li && li.ok) x.drawImage(li.img, lgX, ty - lg / 2 - 18, lg, lg); else { rr(x, lgX, ty - lg / 2 - 18, lg, lg, 18); x.fillStyle = side === 'A' ? COL.pur : '#e9e3f2'; x.fill(); }
      x.font = '900 ' + fsS + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.textAlign = dir < 0 ? 'left' : 'right';
      x.fillText(String(e[side]), dir < 0 ? lgX + lg + 28 : lgX - 28, ty + fsS * 0.36);
    });
    var per = SR.perLabel(game, e.per || 0), clk = clockAt(game, st), fin = st.idx >= game.events.length - 1;
    x.textAlign = 'center'; x.font = '900 ' + (story ? 62 : 52) + 'px ' + MONO; x.fillStyle = '#fff'; x.fillText(fin ? 'FINAL' : clk, cx, ty + 4);
    x.font = '700 ' + (story ? 24 : 20) + 'px ' + MONO; x.fillStyle = COL.mute; x.fillText(fin ? (game.nOT ? 'OT' : '') + ' SIM REPLAY' : per, cx, ty + (story ? 42 : 36));
    // win probability
    var by = r.y + r.h - (story ? 46 : 36), bw = r.w - 72, bx = r.x + 36, wp = e.wp == null ? 0.5 : e.wp;
    rr(x, bx, by, bw, 12, 6); x.fillStyle = 'rgba(255,255,255,.1)'; x.fill();
    rr(x, bx, by, Math.max(12, bw * wp), 12, 6); var g = x.createLinearGradient(bx, 0, bx + bw, 0); g.addColorStop(0, COL.purD); g.addColorStop(1, COL.pur); x.fillStyle = g; x.fill();
    var pc = function (v) { return st.idx >= game.events.length - 1 ? Math.round(100 * v) + '%' : Math.min(99, Math.max(1, Math.round(100 * v))) + '%'; };
    x.font = '800 ' + (story ? 24 : 20) + 'px ' + MONO; x.fillStyle = COL.pur2; x.textAlign = 'left'; x.fillText(game.rost.A[0].abbr + ' ' + pc(wp), bx, by - 12);
    x.fillStyle = '#e9e3f2'; x.textAlign = 'right'; x.fillText(pc(1 - wp) + ' ' + game.rost.H[0].abbr, bx + bw, by - 12);
    x.fillStyle = COL.mute; x.textAlign = 'center'; x.fillText('WIN PROBABILITY', cx, by - 10);
  }
  var V_LOGOS = {};
  function clockAt(game, st) {
    var j = game.pStart.length - 2; for (var q = 0; q < game.pStart.length - 1; q++) if (st.T < game.pStart[q + 1] - 1e-6) { j = q; break; }
    if (st.it.k === 'dead' && st.it.ev[0] && st.it.ev[0].type === 'end') j = st.it.ev[0].per;
    return SR.clock(Math.max(0, game.pStart[j + 1] - st.T));
  }
  function logBlock(x, r, game, st, story) {
    var rows = [], ev = game.events;
    for (var i = st.idx; i >= 0 && rows.length < 3; i--) { var e = ev[i]; if (e.type === 'five' || e.type === 'sub' || e.type === 'timeout') continue; rows.push(e); }
    var rh = (r.h - 16) / 3, fs = story ? 27 : Math.min(20, Math.round(rh * 0.5));
    rows.forEach(function (e, n) {
      var y = r.y + n * (rh + 8);
      rr(x, r.x, y, r.w, rh, 14); x.fillStyle = n === 0 ? 'rgba(176,56,249,.14)' : 'rgba(255,255,255,.04)'; x.fill();
      x.fillStyle = e.team === 'A' ? COL.pur : e.team === 'H' ? '#e9e3f2' : 'transparent'; x.fillRect(r.x, y + 8, 5, rh - 16);
      x.textBaseline = 'middle'; x.textAlign = 'left'; x.font = '700 ' + (fs - 6) + 'px ' + MONO; x.fillStyle = COL.mute;
      x.fillText(SR.perLabel(game, e.per) + ' ' + SR.clock(e.clk), r.x + 20, y + rh / 2);
      x.font = (n === 0 ? '800 ' : '600 ') + fs + 'px ' + DISPLAY; x.fillStyle = n === 0 ? '#fff' : 'rgba(255,255,255,.75)';
      x.fillText(e.text, r.x + (story ? 170 : 150), y + rh / 2, r.w - (story ? 340 : 300));
      if ((e.type === 'shot' && e.made) || (e.type === 'ft' && e.made)) { x.textAlign = 'right'; x.font = '800 ' + (fs - 4) + 'px ' + MONO; x.fillStyle = COL.dim; x.fillText(game.rost.A[0].abbr + ' ' + e.A + '  ' + game.rost.H[0].abbr + ' ' + e.H, r.x + r.w - 18, y + rh / 2); }
    });
    x.textBaseline = 'alphabetic';
  }
  function miniBox(x, r, game, st) {
    var bx = SR.boxAt(game, Math.max(0, st.idx)), y = r.y;
    ['A', 'H'].forEach(function (side) {
      var h = (r.h - 16) / 2;
      rr(x, r.x, y, r.w, h, 18); x.fillStyle = 'rgba(255,255,255,.04)'; x.fill();
      x.font = '800 26px ' + DISPLAY; x.fillStyle = side === 'A' ? COL.pur2 : '#e9e3f2'; x.textAlign = 'left'; x.fillText(game.rost[side][0].abbr, r.x + 20, y + 40);
      x.font = '900 30px ' + MONO; x.textAlign = 'right'; x.fillStyle = '#fff'; x.fillText(String(bx.score[side]), r.x + r.w - 20, y + 40);
      var cols = ['MIN', 'PTS', 'REB', 'AST', '3PM', '+/-'], cw = 54, x0 = r.x + r.w - 20 - cw * (cols.length - 1);
      x.font = '700 15px ' + MONO; x.fillStyle = COL.mute; cols.forEach(function (c, i) { x.fillText(c, x0 + i * cw, y + 70); });
      // the five on the floor first (purple bar), then the next best lines
      var on = bx.on[side], R0 = game.rost[side], list = R0.filter(function (p) { return on.indexOf(p.id) >= 0; })
        .concat(R0.filter(function (p) { return on.indexOf(p.id) < 0; }).sort(function (a, b) { return bx.B[b.id].pts - bx.B[a.id].pts; })).slice(0, 8);
      list.forEach(function (p, n) {
        var b = bx.B[p.id], yy = y + 98 + n * 25, isOn = on.indexOf(p.id) >= 0;
        x.textAlign = 'left'; x.font = '700 18px ' + DISPLAY; x.fillStyle = isOn ? '#fff' : 'rgba(255,255,255,.6)'; x.fillText((p.starter ? '\u2022 ' : '  ') + p.short, r.x + 20, yy, x0 - cw - r.x - 10);
        if (isOn) { x.fillStyle = side === 'A' ? COL.pur : '#e9e3f2'; x.fillRect(r.x + 8, yy - 15, 4, 18); }
        x.textAlign = 'right'; x.font = '700 17px ' + MONO; [b.min, b.pts, b.reb, b.ast, b.tpm, (b.pm > 0 ? '+' : '') + b.pm].forEach(function (v, i) { x.fillStyle = i === 1 ? '#fff' : COL.dim; x.fillText(String(v), x0 + i * cw, yy); });
      });
      y += h + 16;
    });
  }
  function cta(x, W, H, P, story, box) {
    var h = story ? 112 : 86, w = box ? box.w : W - 2 * P, X = box ? box.x : P, y = H - h - (story ? 104 : 40);
    x.save(); rr(x, X, y, w, h, h / 2); var g = x.createLinearGradient(X, y, X + w, y + h); g.addColorStop(0, COL.purD); g.addColorStop(1, COL.pur); x.shadowColor = 'rgba(176,56,249,.6)'; x.shadowBlur = 36; x.fillStyle = g; x.fill(); x.restore();
    x.textBaseline = 'middle'; x.textAlign = 'left'; x.font = '900 ' + (story ? 40 : 30) + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.fillText('BET IT ON ONYX', X + (story ? 44 : 32), y + h / 2, w * 0.55);
    var code = 'CODE KR680261'; x.font = '800 ' + (story ? 26 : 21) + 'px ' + MONO; var cw = x.measureText(code).width + 40, chh = h - 28;
    rr(x, X + w - 14 - cw, y + 14, cw, chh, chh / 2); x.fillStyle = 'rgba(12,12,12,.55)'; x.fill(); x.fillStyle = '#fff'; x.textAlign = 'center'; x.fillText(code, X + w - 14 - cw / 2, y + h / 2);
    x.textBaseline = 'alphabetic';
    if (story) { x.font = '700 26px ' + MONO; x.fillStyle = COL.pur2; x.fillText('onyxodds.com', W / 2, y + h + 46); x.font = '500 17px ' + MONO; x.fillStyle = COL.mute; x.fillText('A simulation of the model\'s projections, not a prediction. 21+. 1-800-GAMBLER.', W / 2, y + h + 80); }
    else { x.font = '500 15px ' + MONO; x.fillStyle = COL.mute; x.textAlign = 'center'; x.fillText('onyxodds.com · a simulation, not a prediction · 21+ · 1-800-GAMBLER', X + w / 2, y + h + 26); }
  }
  function finalCard(x, r, V, story) {
    var game = V.game, bx = SR.boxAt(game);
    rr(x, r.x, r.y, r.w, r.h, 22); x.fillStyle = 'rgba(255,255,255,.035)'; x.fill();
    x.textAlign = 'center'; x.font = '800 ' + (story ? 26 : 22) + 'px ' + MONO; x.fillStyle = COL.pur2; x.fillText('FINAL · SIM REPLAY', r.x + r.w / 2, r.y + 54);
    // top performers
    var tops = topPerf(game, bx), cw = (r.w - 60) / 3, y = r.y + (story ? 90 : 76), th = story ? 250 : 158;
    tops.forEach(function (t, i) {
      var X = r.x + 20 + i * (cw + 10), p = t.p; rr(x, X, y, cw, th, 18); x.fillStyle = 'rgba(176,56,249,.1)'; x.fill();
      var rad = story ? 58 : 36, spr = sprite(p, rad, p.side, 1); x.drawImage(spr, X + cw / 2 - rad - 2, y + (story ? 18 : 12), spr.width, spr.height);
      x.font = '800 ' + (story ? 26 : 20) + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.fillText(p.short, X + cw / 2, y + (story ? 18 : 12) + 2 * rad + (story ? 40 : 32), cw - 16);
      x.font = '700 ' + (story ? 22 : 17) + 'px ' + MONO; x.fillStyle = COL.pur2; x.fillText(t.line, X + cw / 2, y + (story ? 18 : 12) + 2 * rad + (story ? 74 : 58), cw - 16);
    });
    y += th + (story ? 34 : 30);
    x.textAlign = 'left'; x.font = '800 ' + (story ? 30 : 24) + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.fillText('The plays the sim likes', r.x + 24, y);
    x.font = '600 ' + (story ? 19 : 16) + 'px ' + MONO; x.fillStyle = COL.mute; x.fillText('Hit rate across all 10,000 games vs Onyx\'s price', r.x + 24, y + 30);
    y += story ? 54 : 44;
    var L = V.likes || {list: []}, rh = story ? 118 : 64;
    L.list.slice(0, 3).forEach(function (l, i) {
      var Y = y + i * (rh + 10); rr(x, r.x + 20, Y, r.w - 40, rh, 16); x.fillStyle = 'rgba(255,255,255,.05)'; x.fill();
      x.font = '800 ' + (story ? 26 : 21) + 'px ' + DISPLAY; x.fillStyle = '#fff'; x.textAlign = 'left'; x.fillText(l.row.label, r.x + 40, Y + rh * 0.42, r.w * 0.6);
      x.font = '700 ' + (story ? 19 : 16) + 'px ' + MONO; x.fillStyle = COL.dim; x.fillText('Sim ' + Math.round(100 * l.p) + '% · Onyx ' + U.odds(l.row.price) + ' needs ' + Math.round(100 * l.imp) + '%', r.x + 40, Y + rh * 0.78, r.w * 0.62);
      x.textAlign = 'right'; x.font = '900 ' + (story ? 32 : 26) + 'px ' + MONO; x.fillStyle = l.beats ? COL.grn : COL.dim; x.fillText(valTxt(l.ev), r.x + r.w - 40, Y + rh * 0.5);
      x.font = '700 ' + (story ? 16 : 13) + 'px ' + MONO; x.fillStyle = COL.mute; x.fillText(l.beats ? 'VALUE' : 'CLOSEST TO FAIR', r.x + r.w - 40, Y + rh * 0.8);
    });
    x.textAlign = 'left'; x.font = '600 ' + (story ? 19 : 15) + 'px ' + MONO; x.fillStyle = COL.mute;
    x.fillText((L.beats ? '' : 'None beats Onyx\'s price in this game. ') + 'Projections from the model\'s sim, not Onyx Picks. All prices Onyx\'s.', r.x + 24, y + Math.min(3, L.list.length) * (rh + 10) + 28, r.w - 48);
  }
  function valTxt(ev) { var v = 100 * ev, a = Math.abs(v); return (v > 0 ? '+' : v < 0 ? '-' : '') + a.toFixed(a < 0.1 ? 2 : a < 10 ? 1 : 0) + '%'; }
  function topPerf(game, bx) {
    var all = []; ['A', 'H'].forEach(function (s) { game.rost[s].forEach(function (p) { var b = bx.B[p.id]; all.push({p: p, b: b, sc: b.pts + 1.2 * b.reb + 1.5 * b.ast + 2 * (b.stl + b.blk) - b.to}); }); });
    all.sort(function (a, b) { return b.sc - a.sc; });
    return all.slice(0, 3).map(function (t) { return {p: t.p, b: t.b, line: t.b.pts + ' PTS · ' + t.b.reb + ' REB · ' + t.b.ast + ' AST'}; });
  }

  // ── video: record the highlights to a file in the browser ─────────────────────────────────────────────────
  function pickMime() {
    var c = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < c.length; i++) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {} }
    return '';
  }
  function record(V, layout, o) {
    o = o || {};
    if (!window.MediaRecorder) return Promise.reject(new Error('This browser cannot record video'));
    var sz = LAYOUT[layout] || LAYOUT.story, cv = document.createElement('canvas'); cv.width = sz[0]; cv.height = sz[1];
    cv.style.cssText = 'position:fixed;left:-99999px;top:0;width:10px;height:10px;pointer-events:none';
    document.body.appendChild(cv);
    var x = cv.getContext('2d'), TL = timeline(V.game, 60, true), VV = Object.assign({}, V, {TL: TL});
    var total = Math.min(o.maxSec || 1e9, TL.total + 4), mime = pickMime(), stream;
    try { stream = cv.captureStream(30); } catch (e) { cv.remove(); return Promise.reject(e); }
    var rec = new MediaRecorder(stream, mime ? {mimeType: mime, videoBitsPerSecond: 8000000} : {videoBitsPerSecond: 8000000}), chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    return new Promise(function (resolve, reject) {
      var t0 = null, done = false;
      rec.onstop = function () { cv.remove(); resolve(new Blob(chunks, {type: (mime || 'video/webm').split(';')[0]})); };
      rec.onerror = function (e) { cv.remove(); reject(e.error || e); };
      rec.start(500);
      function tick() {
        if (done) return;
        var now = performance.now(); if (t0 == null) t0 = now;
        var R = (now - t0) / 1000;
        frame(x, sz[0], sz[1], layout, VV, Math.min(R, TL.total + Math.max(0, R - TL.total)));
        if (o.progress) o.progress(Math.min(1, R / total));
        if (R >= total) { done = true; setTimeout(function () { try { rec.stop(); } catch (e) { reject(e); } }, 120); return; }
        if (document.hidden) setTimeout(tick, 33); else requestAnimationFrame(tick);
      }
      tick();
    });
  }

  // ── the tab ─────────────────────────────────────────────────────────────────────────────────────────────
  var LAST = {game: null, ctx: null};
  function mount(el, D) {
    if (!document.getElementById('sx-replay-css')) { var stl = document.createElement('style'); stl.id = 'sx-replay-css'; stl.textContent = CSS; document.head.appendChild(stl); }
    var E = Studio.simEngine;
    var games = D.games.filter(function (g) { return D.playsFor(g.gid).length && g.state !== 'post'; }).sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); });
    if (!E) { el.innerHTML = '<div class="sx-card"><p class="sx-sub">Sim Replay needs Play It Out, which did not load.</p></div>'; return {}; }
    if (!games.length) { el.innerHTML = '<div class="sx-card"><h3 class="sx-h">Sim Replay</h3><p class="sx-sub">No ' + esc(D.sportName) + ' games with Onyx lines on the board right now. The next slate shows up here once Onyx posts its prices.</p></div>'; return {}; }
    el.innerHTML = '<div class="rp">'
      + '<span class="rp-lab"><i></i>' + esc(LABEL) + '</span>'
      + '<div class="rp-pick" id="rpPick"></div>'
      + '<div class="rp-sc" id="rpScen"></div><p class="rp-note" id="rpNote"></p>'
      + '<div class="rp-main"><div class="rp-col">'
      + '<div class="rp-board" id="rpBoard"></div>'
      + '<div class="rp-court" id="rpCourt"><canvas id="rpCv" role="img" aria-label="Simulated game court"></canvas><div class="rp-load" id="rpLoad"><span id="rpLoadT">Loading</span><div class="sx-bar"><i id="rpLoadB" style="width:0%"></i></div></div></div>'
      + '<div class="sx-card" id="rpCtl"></div>'
      + '<div class="sx-card"><div class="sx-k" style="margin-bottom:8px">Play-by-play</div><div class="rp-log" id="rpLog" aria-live="polite"></div></div>'
      + '</div><div class="rp-col">'
      + '<div class="sx-card rp-bets" id="rpBets"></div>'
      + '<div class="sx-card rp-box" id="rpBox"></div>'
      + '<div class="sx-card rp-likes" id="rpLikes"></div>'
      + '</div></div>'
      + '<details class="sx-card sim-how"><summary>How Sim Replay works</summary>' + howHTML() + '</details>'
      + '</div><div class="rp-fin" id="rpFin" hidden role="dialog" aria-label="Final"></div>';
    var $ = function (id) { return document.getElementById(id); };
    var cv = $('rpCv'), cx = cv.getContext('2d');
    var EXT = null, DEPTH = null, LOGOS = null, CACHE = {}, G = null, RES = null, CTX = null, SCEN = [], GAME = null, TL = null, LIKES = null, LEGS = [], SKEY = 'likely';
    var R = 0, playing = false, speed = 16, hl = false, raf = 0, lastTs = 0, lastIdx = -2, lastDom = 0, boxTeam = 'A', busy = 0, finShown = false, legHit = [];
    var full = function () { return cv.clientWidth >= 640; };

    function drawPick() {
      var lg = function (t) { var s = (LOGOS || {})[t] || (D.game && null); return s ? '<img src="' + esc(s) + '" alt="">' : ''; };
      $('rpPick').innerHTML = games.map(function (g) { return '<button class="rp-g' + (G && G.gid === g.gid ? ' on' : '') + '" data-rp-gid="' + esc(g.gid) + '">' + lg(g.away) + esc(g.away) + ' <span style="color:var(--mute)">@</span> ' + lg(g.home) + esc(g.home) + '</button>'; }).join('');
    }
    function loader(t, p) { var L = $('rpLoad'); if (t == null) { L.hidden = true; return; } L.hidden = false; $('rpLoadT').textContent = t; $('rpLoadB').style.width = Math.round(100 * (p || 0)) + '%'; }
    function sizeCanvas() {
      var w = cv.clientWidth || el.clientWidth || 360, dpr = Math.min(2, window.devicePixelRatio || 1), h = full() ? Math.round(w * 50 / 94) + 4 : Math.round(w * 0.98);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
      return {w: w, h: h, dpr: dpr};
    }

    function setGame(gid) {
      pause(); var my = ++busy;
      G = E.prep(D, gid, U, EXT); GAME = null; TL = null; CTX = null; SCEN = []; CACHE = {}; R = 0; finShown = false; $('rpFin').hidden = true;
      if (location.hash.split('?')[0] === '#replay' && Studio.param('gid') !== gid) history.replaceState(null, '', '#replay?gid=' + gid);
      drawPick(); $('rpScen').innerHTML = ''; $('rpNote').textContent = '';
      if (!G) { loader('No Onyx lines for this game yet'); return; }
      V_LOGOS = {A: logoImg((LOGOS || {})[G.A] || G.logos[G.A], G.A), H: logoImg((LOGOS || {})[G.H] || G.logos[G.H], G.H)};
      var sim = E.run(G, E.freshK(), E.seed(gid));
      loader('Playing the game 10,000 times', 0);
      (function chunk() {
        if (my !== busy) return;
        var at = sim.step(700); loader('Playing the game 10,000 times', at / N);
        if (at < N) { setTimeout(chunk, 0); return; }
        setTimeout(function () {
          if (my !== busy) return;
          RES = sim.done();
          CTX = SR.context(G, RES, (DEPTH && DEPTH.teams) || {}, {sport: SP, mlChance: E.mlChance, BMK: E.BMK});
          LAST.ctx = CTX;
          if (!CTX || CTX.err) { loader(CTX && CTX.err || 'This game could not be laid out'); return; }
          LIKES = SR.likes(CTX); LEGS = myLegs(gid);
          SCEN = SR.scenarios(CTX, LEGS.filter(function (l) { return l.sel; }));
          drawScen(); drawLikes();
          var want = Studio.param('s'); scenario(SCEN.some(function (s) { return s.key === want; }) ? want : 'likely');
        }, 0);
      })();
    }
    function drawScen() {
      var keys = [['likely', 'Most likely'], ['upset', 'Upset'], ['blowout', 'Blowout'], ['ot', 'Overtime thriller'], ['bets', 'Your bets hit']];
      $('rpScen').innerHTML = keys.map(function (k) {
        var s = SCEN.filter(function (x) { return x.key === k[0]; })[0], dis = !s || !s.list.length;
        if (k[0] === 'bets' && !s) return '<button disabled title="Save a pick or add a leg for this game to your slip">' + k[1] + '</button>';
        return '<button data-rp-s="' + k[0] + '" class="' + (SKEY === k[0] ? 'on' : '') + '"' + (dis ? ' disabled' : '') + '>' + k[1] + '</button>';
      }).join('');
    }
    function scenario(key) {
      var s = SCEN.filter(function (x) { return x.key === key; })[0]; if (!s) return;
      SKEY = key; drawScen(); pause(); finShown = false; $('rpFin').hidden = true;
      $('rpNote').textContent = s.note || '';
      if (CACHE[key]) { load(CACHE[key], s); return; }
      if (!s.list.length) { loader(s.note); return; }
      var my = ++busy, q = 0;
      loader('Writing out the play-by-play', 0.1);
      (function next() {
        if (my !== busy) return;
        var g = null;
        for (var n = 0; n < 2 && q < Math.min(30, s.list.length) && !(g && g.ok); n++, q++) {
          g = SR.build(CTX, s.list[q]);
          if (g && g.ok && key === 'bets' && s.legs && s.legs.some(function (l) { var st2 = SR.grade(l, g, g.events.length - 1).state; return st2 !== 'hit' && st2 !== 'unknown'; })) g = null;
        }
        if (g && g.ok) { g.scenario = key; CACHE[key] = g; load(g, s); return; }
        if (q >= Math.min(30, s.list.length)) { loader('None of these games could be laid out cleanly. Try another scenario.'); return; }
        loader('Writing out the play-by-play', 0.1 + 0.9 * q / Math.min(30, s.list.length)); setTimeout(next, 0);
      })();
    }
    function load(g, s) {
      GAME = g; LAST.game = g; V.game = g; V.title = s.title + (s.key === 'likely' ? ' game' : ''); V.likes = LIKES;
      TL = timeline(g, speed, hl); V.TL = TL; R = 0; lastIdx = -2; loader(null);
      // your legs: when each one cashes in this game (for the callout and the live list)
      legHit = LEGS.map(function (l) { return hitIndex(l, g); });
      EXTRA_CALLS = []; legHit.forEach(function (h, i) { if (h != null) EXTRA_CALLS.push({i: h, title: 'Your bet hits', sub: LEGS[i].label, p: null}); });
      drawCtl(); drawBoard(); drawBox(true); drawBets(); drawLog(true);
      paint();
      // arriving from a "Watch the most likely game" link on a phone: bring the scoreboard and court into view once
      if (!el._scrolled && Studio.param('gid') && innerWidth < 760) { el._scrolled = true; try { var top = $('rpBoard').getBoundingClientRect().top + scrollY - 64; if (top > scrollY + 40) scrollTo({top: top, behavior: RM ? 'auto' : 'smooth'}); } catch (e) {} }
      if (!RM) play();
    }
    function hitIndex(l, g) {
      var n = g.events.length, fin = SR.grade(l, g, n - 1).state; if (fin !== 'hit') return null;
      var lo = 0, hi = n - 1;
      while (lo < hi) { var m = (lo + hi) >> 1; if (SR.grade(l, g, m).state === 'hit') hi = m; else lo = m + 1; }
      return lo;
    }

    // ── controls ──
    function drawCtl() {
      var spd = [1, 4, 16, 60].map(function (v) { return '<button data-rp-v="' + v + '" class="' + (speed === v && !hl ? 'on' : '') + '">' + v + 'x</button>'; }).join('');
      $('rpCtl').innerHTML = '<div class="rp-ctl"><button class="rp-play" id="rpPlay" aria-label="Play">▶</button><div class="rp-spd" role="group" aria-label="Speed">' + spd + '</div>'
        + '<button class="rp-btn' + (hl ? ' on' : '') + '" data-rp-hl="1">Highlights</button>'
        + '<div class="rp-tl" id="rpTl"><div class="tr"></div><div class="fill" id="rpFill"></div>' + marks() + '<div class="knob" id="rpKnob"></div><input type="range" id="rpScrub" min="0" max="1000" step="1" value="0" aria-label="Scrub through the game"></div>'
        + '<div class="rp-jump"><button class="rp-btn" data-rp-j="q4">' + (SP === 'cbb' ? '2nd half' : 'Q4') + '</button><button class="rp-btn" data-rp-j="clutch">Clutch</button><button class="rp-btn" data-rp-j="final">Final</button>'
        + '<button class="rp-btn" data-rp-share="1">Share the final</button><button class="rp-btn pri" data-rp-video="1">Download video</button></div></div>'
        + '<div class="rp-vid" id="rpVid">Video: the highlights (runs, callouts, the last two minutes) in about 75 seconds, with the Onyx label and code. Story 9:16 for phones, landscape 16:9 for everywhere else. <label style="white-space:nowrap"><input type="radio" name="rpLay" value="story" checked> Story</label> <label style="white-space:nowrap"><input type="radio" name="rpLay" value="land"> Landscape</label></div>';
      syncPlay();
    }
    function marks() {
      var h = '', g = GAME, nReg = CF.per.length;
      for (var j = 1; j < g.per.length; j++) { var Rq = realForT(TL, g.pStart[j]) / TL.total * 100; h += '<i class="q" style="left:' + Rq.toFixed(2) + '%"></i><span class="ql" style="left:' + Rq.toFixed(2) + '%">' + esc(SR.perLabel(g, j)) + '</span>'; }
      h += '<span class="ql" style="left:0">' + esc(SR.perLabel(g, 0)) + '</span>';
      (g.ticks || []).forEach(function (t) { var e = g.events[t.i]; h += '<i class="tk' + (t.kind === 'clutch' ? ' c' : '') + '" style="left:' + (100 * TL.RE[t.i] / TL.total).toFixed(2) + '%" title="' + esc(e.call.title) + '"></i>'; });
      void nReg; return h;
    }
    function syncPlay() { var b = $('rpPlay'); if (b) { b.textContent = playing ? '❚❚' : '▶'; b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); } }
    function setR(r2) { R = clamp(r2, 0, TL ? TL.total : 0); if (TL && R < TL.total - 0.01) { finShown = false; } paint(); }
    function play() { if (!GAME) return; if (R >= TL.total - 0.01) { R = 0; finShown = false; $('rpFin').hidden = true; } playing = true; syncPlay(); lastTs = 0; cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); }
    function pause() { playing = false; syncPlay(); cancelAnimationFrame(raf); }
    function loop(ts) {
      if (!playing) return;
      if (!lastTs) lastTs = ts;
      var dt = Math.min(0.1, (ts - lastTs) / 1000); lastTs = ts;
      R += dt;
      if (R >= TL.total) { R = TL.total; paint(); pause(); showFinal(); return; }
      paint();
      raf = requestAnimationFrame(loop);
    }
    function respeed(v, h2) {
      if (!GAME) return;
      var st0 = stateAt(GAME, TL, R), T0 = st0.T;
      speed = v; hl = h2; TL = timeline(GAME, speed, hl); V.TL = TL;
      R = realForT(TL, T0); drawCtl(); paint();
    }

    // ── painting ──
    function paint() {
      if (!GAME || !TL) return;
      var sz = sizeCanvas(), st = stateAt(GAME, TL, R);
      cx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);
      drawCourt(cx, {x: 0, y: 0, w: sz.w, h: sz.h}, GAME, TL, st, {dpr: sz.dpr, full: full()});
      var fill = $('rpFill'), knob = $('rpKnob'), sc = $('rpScrub'), p = TL.total ? R / TL.total : 0;
      if (fill) fill.style.width = (100 * p).toFixed(2) + '%'; if (knob) knob.style.left = (100 * p).toFixed(2) + '%'; if (sc && document.activeElement !== sc) sc.value = Math.round(1000 * p);
      drawBoard(st);
      var now = performance.now();
      if (st.idx !== lastIdx && (now - lastDom > 160 || !playing)) { var back = st.idx < lastIdx; lastIdx = st.idx; lastDom = now; drawBox(); drawLog(back); drawBets(); }
    }
    var SBC = {};
    function drawBoard(st) {
      var b = $('rpBoard'); if (!GAME) { b.innerHTML = ''; return; }
      if (!b.firstChild || b.dataset.gid !== GAME.gid + GAME.k) {
        var tm = function (side) { var ab = GAME.rost[side][0].abbr, logo = (LOGOS || {})[ab] || G.logos[ab]; return '<div class="rp-tm' + (side === 'H' ? ' h' : '') + '">' + (logo ? '<img src="' + esc(logo) + '" alt="">' : '') + '<div><div class="ab">' + esc(ab) + '</div><div class="nm">' + esc(side === 'A' ? G.g.away_name || '' : G.g.home_name || '') + '</div></div><div class="s" id="rpS' + side + '">0</div></div>'; };
        b.innerHTML = '<div class="rp-sb">' + tm('A') + '<div class="rp-mid"><div class="rp-clk" id="rpClk">12:00</div><div class="rp-per" id="rpPer">Q1</div><span class="rp-shot ok" id="rpSc">24</span></div>' + tm('H') + '</div>'
          + '<div class="rp-wp"><div class="bar"><i class="a" id="rpWa" style="width:50%"></i><i class="h" id="rpWh" style="width:50%"></i></div><div class="lb"><span><b id="rpWpa">50%</b> ' + esc(GAME.rost.A[0].abbr) + '</span><span>Win probability</span><span>' + esc(GAME.rost.H[0].abbr) + ' <b id="rpWph">50%</b></span></div></div>';
        b.dataset.gid = GAME.gid + GAME.k; SBC = {};
      }
      if (!st) return;
      var e = GAME.events[Math.max(0, st.idx)], fin = st.idx >= GAME.events.length - 1 && R >= TL.total - 0.01;
      var set = function (id, v) { if (SBC[id] !== v) { SBC[id] = v; var n = $(id); if (n) n.textContent = v; } };
      set('rpSA', String(e.A)); set('rpSH', String(e.H));
      set('rpClk', fin ? 'FINAL' : clockAt(GAME, st)); set('rpPer', fin ? (GAME.nOT ? (GAME.nOT > 1 ? GAME.nOT + 'OT' : 'OT') + ' · ' : '') + 'SIM REPLAY' : SR.perLabel(GAME, e.per || 0));
      // the shot clock: from the attempt in play
      var sc = null, scn = scene(GAME, TL, st);
      if (st.it.k === 'run') { var fe = null; for (var j = scn.P.ev0; j <= scn.P.ev1; j++) { var x2 = GAME.events[j]; if (x2.a0 != null && x2.t >= st.T - 1e-6) { fe = x2; break; } } if (fe) { var base = fe.att === 0 ? CF.shot : CF.oreb; sc = Math.max(0, base - (st.T - fe.a0)); } }
      var left = GAME.pStart[(e.per || 0) + 1] - st.T;
      set('rpSc', sc == null || left < sc ? '' : String(Math.ceil(sc)));
      var scEl = $('rpSc'); if (scEl) { scEl.style.visibility = sc == null || left < sc ? 'hidden' : 'visible'; scEl.className = 'rp-shot' + (sc != null && sc <= 5 ? '' : ' ok'); }
      var wp = e.wp == null ? 0.5 : e.wp, cap = function (v) { return (fin ? Math.round(100 * v) : Math.min(99, Math.max(1, Math.round(100 * v)))) + '%'; }, pa = cap(wp);
      if (SBC.wp !== pa) { SBC.wp = pa; $('rpWa').style.width = (100 * wp).toFixed(1) + '%'; $('rpWh').style.width = (100 - 100 * wp).toFixed(1) + '%'; set('rpWpa', pa); set('rpWph', cap(1 - wp)); }
    }
    function drawLog(reset) {
      var L = $('rpLog'); if (!GAME) return;
      var st = stateAt(GAME, TL, R), rows = [], ev = GAME.events;
      for (var i = st.idx; i >= 0 && rows.length < 7; i--) { var e = ev[i]; if (e.type === 'five' || e.type === 'sub') continue; rows.push(e); }
      var top = L.firstChild && +L.firstChild.dataset.i;
      L.innerHTML = rows.map(function (e, n) {
        var scr = (e.type === 'shot' && e.made) || (e.type === 'ft' && e.made);
        return '<div class="rp-ev ' + (e.team || '') + (scr ? ' sc' : '') + (n === 0 && !reset && e.i !== top ? ' new' : '') + '" data-i="' + e.i + '"><span class="t">' + esc(SR.perLabel(GAME, e.per) + ' ' + SR.clock(e.clk)) + '</span><span>' + esc(e.text) + '</span><span class="s">' + (scr ? esc(GAME.rost.A[0].abbr + ' ' + e.A + ' - ' + GAME.rost.H[0].abbr + ' ' + e.H) : '') + '</span></div>';
      }).join('') || '<p class="rp-note">Tip-off coming up.</p>';
    }
    function boxTable(side, bx, fullCols) {
      var cols = fullCols ? ['MIN', 'PTS', 'FG', '3PT', 'FT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', '+/-'] : ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', '+/-'];
      var on = bx.on[side], T = {min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0};
      var row = function (b) { var v = {MIN: b.min, PTS: b.pts, FG: b.fgm + '-' + b.fga, '3PT': b.tpm + '-' + b.tpa, FT: b.ftm + '-' + b.fta, OREB: b.oreb, DREB: b.dreb, REB: b.reb, AST: b.ast, STL: b.stl, BLK: b.blk, TO: b.to, PF: b.pf, '+/-': b.pm == null ? '' : (b.pm > 0 ? '+' : '') + b.pm}; return cols.map(function (c) { return '<td' + (c === 'PTS' ? ' class="pts"' : '') + '>' + esc(v[c]) + '</td>'; }).join(''); };
      var body = GAME.rost[side].map(function (p) {
        var b = bx.B[p.id]; Object.keys(T).forEach(function (k) { T[k] += k === 'min' ? b.sec / 60 : b[k]; });
        return '<tr class="' + (on.indexOf(p.id) >= 0 ? 'on' : '') + (!b.played ? ' dnp' : '') + '"><td>' + (p.starter ? '<span class="st" title="Starter">●</span>' : '') + esc(p.short) + '</td>' + row(b) + '</tr>';
      }).join('');
      T.min = Math.round(T.min); T.pm = null; T.reb = T.oreb + T.dreb;
      return '<div class="sx-scroll"><table class="rp-bt"><thead><tr><th>' + esc(GAME.rost[side][0].abbr) + '</th>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '<tr class="tot"><td>Team</td>' + row(T) + '</tr></tbody></table></div>';
    }
    function drawBox() {
      if (!GAME) return;
      var st = stateAt(GAME, TL, R), bx = SR.boxAt(GAME, Math.max(0, st.idx));
      var h = function (side) { return '<div class="tb" style="display:' + (boxTeam === side ? 'block' : 'none') + ';margin-bottom:12px"><h4>' + esc((side === 'A' ? G.g.away_name : G.g.home_name) || GAME.rost[side][0].abbr) + ' <b>' + bx.score[side] + '</b></h4>' + boxTable(side, bx) + '</div>'; };
      $('rpBox').innerHTML = '<div class="sx-k" style="margin-bottom:8px">Box score · <span style="color:var(--pur2)">●</span> starter · purple bar: on the floor</div>'
        + '<div class="rp-tabs"><button data-rp-bt="A" class="' + (boxTeam === 'A' ? 'on' : '') + '">' + esc(GAME.rost.A[0].abbr) + ' ' + bx.score.A + '</button><button data-rp-bt="H" class="' + (boxTeam === 'H' ? 'on' : '') + '">' + esc(GAME.rost.H[0].abbr) + ' ' + bx.score.H + '</button></div>'
        + h('A') + h('H');
    }
    function legRow(l, st2, p) {
      var cls = st2.state === 'hit' ? 'hit' : st2.state === 'miss' ? 'miss' : st2.state === 'push' ? 'push' : 'live', txt = {hit: 'Hit', miss: 'Missed', push: 'Push', live: 'Live'}[cls];
      var now = st2.cur != null ? (l.kind === 'spread' || l.kind === 'ml' ? 'margin ' + (st2.cur > 0 ? '+' : '') + st2.cur : st2.cur + (l.line != null ? ' of ' + l.line : '')) : '';
      return '<div class="lk"><div class="lb">' + esc(l.label) + '<small>' + (now ? esc('In this game: ' + now) + ' · ' : '') + (p != null ? 'hits in ' + U.pct(p) + ' of all 10,000' : 'not on tonight\'s board') + (l.price != null ? ' · Onyx ' + esc(U.odds(l.price)) : '') + '</small></div><span class="rp-st ' + cls + '">' + txt + '</span></div>';
    }
    function drawBets() {
      var b = $('rpBets'); if (!GAME) return;
      if (!LEGS.length) { b.innerHTML = '<h3 class="sx-h">Your bets in this sim</h3><p class="sx-sub" style="margin:0">Save a pick or add a leg on this game to your slip and it is tracked right here as the game plays out, with its hit rate across all 10,000 games.</p>'; return; }
      var st = stateAt(GAME, TL, R), bx = SR.boxAt(GAME, Math.max(0, st.idx));
      b.innerHTML = '<h3 class="sx-h">Your bets in this sim</h3>' + LEGS.map(function (l) { var x2 = l.sel && RES.byId[l.sel]; return legRow(l, SR.grade(l, GAME, Math.max(0, st.idx), bx), x2 ? x2.p : null); }).join('');
    }
    function drawLikes() {
      var b = $('rpLikes'); if (!LIKES) return;
      b.innerHTML = '<h3 class="sx-h">The plays the sim likes</h3><p class="sx-sub" style="margin-bottom:4px">' + (LIKES.beats ? 'Hit rate across all 10,000 games against the chance Onyx\'s price needs' + (LIKES.all ? '' : ' (and, after the ones that beat it, the closest to fair)') + '. Projections from the model\'s sim, not Onyx Picks.' : 'Nothing in this game beats Onyx\'s price across the 10,000 games. These come closest to fair. Projections, not Onyx Picks.') + '</p>'
        + likesHTML();
    }
    function likesHTML() {
      return LIKES.list.map(function (l) {
        var r = l.row, href = U.onyx([r.sel]);
        return '<div class="lk"><div class="lb">' + esc(r.label) + '<small>' + (l.beats ? '' : 'closest to fair \u00b7 ') + 'Sim ' + U.pct(l.p, 1) + ' · Onyx ' + esc(U.odds(r.price)) + ' needs ' + U.pct(l.imp, 1) + ' · value <b class="' + (l.ev > 0 ? 'sx-pos' : 'sx-neg') + '">' + valTxt(l.ev) + '</b></small></div>'
          + '<div class="bt"><a class="sx-chip onyx" target="_blank" rel="noopener" data-rp-onyx="1" href="' + esc(href) + '">Bet on Onyx</a>' + (window.OnyxParlay ? '<button class="sx-chip" data-rp-add="' + esc(r.sel) + '">+ Parlay slip</button>' : '') + '</div></div>';
      }).join('');
    }
    function showFinal(force) {
      if ((finShown && !force) || !GAME) return; finShown = true;
      var bx = SR.boxAt(GAME), A = GAME.rost.A[0].abbr, H = GAME.rost.H[0].abbr, wA = bx.score.A > bx.score.H;
      var lg = function (ab) { var s = (LOGOS || {})[ab] || G.logos[ab]; return s ? '<img src="' + esc(s) + '" alt="">' : ''; };
      var tops = topPerf(GAME, bx).map(function (t) { return '<div>' + (t.p.hs ? '<img src="' + esc(t.p.hs) + '" alt="" onerror="this.remove()">' : '') + '<b>' + esc(t.p.short) + '</b><span>' + esc(t.line) + '</span></div>'; }).join('');
      var bets = LEGS.length ? '<div class="sx-card rp-bets"><h3 class="sx-h">Your bets in this sim</h3>' + LEGS.map(function (l) { var x2 = l.sel && RES.byId[l.sel]; return legRow(l, SR.grade(l, GAME, GAME.events.length - 1, bx), x2 ? x2.p : null); }).join('') + '</div>' : '';
      $('rpFin').innerHTML = '<div class="in"><div class="hd"><span class="rp-lab"><i></i>' + esc(LABEL) + '</span><button class="x" data-rp-close="1" aria-label="Close">&times;</button></div>'
        + '<div class="sx-card"><div class="rp-fs"><div>' + lg(A) + '<div class="s' + (wA ? ' w' : '') + '">' + bx.score.A + '</div><div class="sx-k">' + esc(A) + '</div></div><div class="sx-k">FINAL' + (GAME.nOT ? ' / ' + (GAME.nOT > 1 ? GAME.nOT : '') + 'OT' : '') + '<br>' + esc(V.title || '') + '</div><div>' + lg(H) + '<div class="s' + (!wA ? ' w' : '') + '">' + bx.score.H + '</div><div class="sx-k">' + esc(H) + '</div></div></div></div>'
        + '<div class="sx-card"><div class="sx-k" style="margin-bottom:8px">Top performers</div><div class="rp-top">' + tops + '</div></div>'
        + '<div class="sx-card rp-likes"><h3 class="sx-h">The plays the sim likes</h3><p class="sx-sub" style="margin-bottom:4px">' + (LIKES.all ? 'Their hit rate across all 10,000 games beats the chance Onyx\'s price needs.' : LIKES.beats ? 'Hit rate across all 10,000 games against the chance Onyx\'s price needs: the ones that beat it, then the closest to fair.' : 'Nothing here beats Onyx\'s price across the 10,000 games; these come closest to fair.') + ' Projections, not Onyx Picks.</p>' + likesHTML() + '</div>'
        + bets
        + '<div class="rp-acts"><button class="sx-btn" data-rp-share="1">Share the final</button><button class="sx-btn" data-rp-video="1">Download video</button><button class="sx-btn ghost" data-rp-again="1">Watch again</button></div>'
        + '<div class="sx-card"><div class="sx-k" style="margin-bottom:8px">Full box score</div>' + boxTable('A', bx, true) + '<div style="height:12px"></div>' + boxTable('H', bx, true) + '</div>'
        + '</div>';
      $('rpFin').hidden = false;
    }

    // ── share and video ──
    function shareCard() {
      var bx = SR.boxAt(GAME), A = GAME.rost.A[0].abbr, H = GAME.rost.H[0].abbr, legs = LIKES.list.map(function (l) { return {label: l.row.label, matchup: l.row.matchup, price: l.row.price, conf: l.p, sport: SP, sel: l.row.sel}; });
      var joint = null;
      try { var hs = LIKES.list.map(function (l) { return RES.byId[l.row.sel] && RES.byId[l.row.sel].h; }); if (hs.every(Boolean)) { var n = 0; for (var k = 0; k < N; k++) { var all = 1; for (var q = 0; q < hs.length; q++) if (!hs[q][k]) { all = 0; break; } n += all; } joint = n / N; } } catch (e) {}
      return {kind: legs.length > 1 ? 'parlay' : 'single', title: 'Sim Replay final', legs: legs, chance: joint, sport: SP,
              final: {a: {abbr: A, score: bx.score.A}, h: {abbr: H, score: bx.score.H}, note: LABEL, ot: GAME.nOT, scenario: V.title}};
    }
    function video() {
      var lay = (document.querySelector('input[name=rpLay]:checked') || {}).value || 'story', v = $('rpVid'), was = playing; pause();
      v.innerHTML = 'Recording the highlights: <b id="rpVp">0%</b>. Keep this tab open.';
      return record(V, lay, {progress: function (p) { var n = $('rpVp'); if (n) n.textContent = Math.round(100 * p) + '%'; }}).then(function (blob) {
        var ext = /mp4/.test(blob.type) ? 'mp4' : 'webm', url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = 'onyx-sim-replay-' + GAME.rost.A[0].abbr + '-' + GAME.rost.H[0].abbr + '-' + lay + '.' + ext; document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
        v.innerHTML = 'Saved: ' + (blob.size / 1e6).toFixed(1) + ' MB ' + ext.toUpperCase() + ' (' + lay + '). ' + (ext === 'webm' ? 'Some phones need MP4: most editors and every social app take WebM uploads from a computer.' : '');
        try { if (window.gtag) gtag('event', 'replay_video', {layout: lay, ext: ext}); } catch (e) {}
        if (was) play();
        return blob;
      }).catch(function (e) { v.textContent = 'Video could not be recorded here (' + (e && e.message || 'unsupported') + '). Share the final instead.'; });
    }

    // ── events ──
    el.addEventListener('click', function (e) {
      var t = e.target.closest('button, a, input'); if (!t) return;
      if (t.dataset.rpGid) { if (!G || G.gid !== t.dataset.rpGid) setGame(t.dataset.rpGid); return; }
      if (t.dataset.rpS) { scenario(t.dataset.rpS); return; }
      if (t.id === 'rpPlay') { if (playing) pause(); else play(); return; }
      if (t.dataset.rpV) { respeed(+t.dataset.rpV, false); return; }
      if (t.dataset.rpHl) { respeed(speed, !hl); return; }
      if (t.dataset.rpJ && GAME) {
        var j = t.dataset.rpJ, target;
        if (j === 'final') target = TL.total;
        else if (j === 'q4') target = realForT(TL, GAME.pStart[SP === 'cbb' ? 1 : 3]);
        else { var c = GAME.events.filter(function (x) { return x.call && x.call.kind === 'clutch'; })[0]; target = c ? Math.max(0, TL.RE[c.i] - 3) : realForT(TL, GAME.pStart[CF.per.length] - 120); }
        setR(target); if (j === 'final') showFinal(true); return;
      }
      if (t.dataset.rpBt) { boxTeam = t.dataset.rpBt; drawBox(); return; }
      if (t.dataset.rpAdd && window.OnyxParlay) { var row = LIKES.list.filter(function (l) { return l.row.sel === t.dataset.rpAdd; })[0]; if (row) { OnyxParlay.add(row.row); t.textContent = '✓ On your slip'; } return; }
      if (t.dataset.rpShare && GAME && window.OnyxShare) { OnyxShare.open(shareCard()); return; }
      if (t.dataset.rpVideo && GAME) { video(); return; }
    });
    var fin = document.getElementById('rpFin');
    fin.addEventListener('click', function (e) {
      var t = e.target.closest('button, a'); if (!t) { if (e.target === fin) fin.hidden = true; return; }
      if (t.dataset.rpClose) { fin.hidden = true; return; }
      if (t.dataset.rpAgain) { fin.hidden = true; R = 0; finShown = false; play(); return; }
      if (t.dataset.rpShare && window.OnyxShare) { OnyxShare.open(shareCard()); return; }
      if (t.dataset.rpVideo) { fin.hidden = true; video(); return; }
      if (t.dataset.rpAdd && window.OnyxParlay) { var row = LIKES.list.filter(function (l) { return l.row.sel === t.dataset.rpAdd; })[0]; if (row) { OnyxParlay.add(row.row); t.textContent = '✓ On your slip'; } }
    });
    el.addEventListener('input', function (e) { if (e.target.id === 'rpScrub' && TL) { setR(TL.total * (+e.target.value) / 1000); } });
    el.addEventListener('change', function (e) { if (e.target.id === 'rpScrub' && TL) { setR(TL.total * (+e.target.value) / 1000); if (R >= TL.total - 0.01) showFinal(); } });
    document.addEventListener('visibilitychange', function () { if (document.hidden && playing) { pause(); el._resume = true; } else if (!document.hidden && el._resume) { el._resume = false; if (document.getElementById('st-replay').classList.contains('on')) play(); } });
    addEventListener('resize', function () { if (GAME) paint(); });
    addEventListener('hashchange', function () { if (location.hash.split('?')[0] !== '#replay' && playing) pause(); });

    var V = {game: null, TL: null, title: '', likes: null}, HLC = null;
    Studio.replay = {
      game: function () { return GAME; }, ctx: function () { return CTX; }, res: function () { return RES; }, scenarios: function () { return SCEN; },
      state: function () { return GAME ? Object.assign({playing: playing, speed: speed, hl: hl, total: TL.total, key: SKEY}, stateAt(GAME, TL, R)) : null; },
      seek: function (r2) { setR(r2); if (R >= TL.total - 0.01) showFinal(true); }, play: play, pause: pause, speed: function (v) { respeed(v, hl); }, mode: function (h2) { respeed(speed, !!h2); },
      scenario: scenario, setGame: setGame, realOf: function (i) { return TL ? TL.RE[i] : 0; }, legs: function () { return LEGS; }, likes: function () { return LIKES; },
      frame: function (layout, r2, canvas) {
        var sz = LAYOUT[layout] || LAYOUT.story, c2 = canvas || document.createElement('canvas'); if (c2.width !== sz[0]) c2.width = sz[0]; if (c2.height !== sz[1]) c2.height = sz[1];
        if (!HLC || HLC.game !== GAME) HLC = {game: GAME, TL: timeline(GAME, 60, true)};
        frame(c2.getContext('2d'), sz[0], sz[1], layout, Object.assign({}, V, {TL: HLC.TL}), r2); return c2;
      },
      hlTotal: function () { if (!HLC || HLC.game !== GAME) HLC = {game: GAME, TL: timeline(GAME, 60, true)}; return HLC.TL.total; },
      record: function (layout, o) { return record(V, layout || 'story', o); }
    };
    Studio.checks.replay = function () {
      if (!GAME) return busy ? '' : 'no game laid out';
      var v = SR.verify(GAME, CTX); if (v.length) return v.slice(0, 3).join('; ');
      return '';
    };

    Promise.all([E.extras(D).catch(function () { return {}; }), getJ(D.dir + 'depth.json'), SP === 'nba' ? getJ(D.dir + 'team_logos.json') : Promise.resolve(null)]).then(function (a) {
      EXT = a[0] || {}; DEPTH = a[1] || {}; LOGOS = a[2] || {};
      var want = Studio.param('gid'), now = Date.now(), next = games.filter(function (g) { return Date.parse(g.start) > now; })[0];
      setGame(want && games.some(function (g) { return g.gid === want; }) ? want : (next || games[0]).gid);
    });
    return {show: function () { var w = Studio.param('gid'); if (w && G && w !== G.gid && games.some(function (g) { return g.gid === w; })) setGame(w); else if (GAME) paint(); }};
  }

  function howHTML() {
    var p = function (s) { return '<p>' + s + '</p>'; };
    return p('A simulated game, not a prediction, not real highlights and not an Onyx Pick. Play It Out plays this game 10,000 times from the model\'s projections; Sim Replay takes one of those games and writes it out possession by possession so you can watch it. The most likely game is the one closest to the middle of all 10,000: the typical margin and total, with each player\'s numbers nearest his projection.')
      + p('Every number in the replay is that simulated game\'s own: the final score, any overtime, and each player\'s points, rebounds, assists and threes exactly as the sim drew them (the very numbers it graded his Onyx props on). Players without an Onyx line split the rest of their team\'s score by their projections. The made and missed shots, free throws, rebounds, turnovers, steals, blocks and fouls are laid out so every rebound comes off a miss, possessions alternate and match the sim\'s pace, the game clock adds to exactly 48 minutes and nobody holds the ball past the 24-second clock. Each event goes to a player who is on the floor at that moment (minutes follow the model\'s projected minutes; starters start each half, closers finish close games).')
      + p('Win probability comes from the 10,000 games: the score now, the time left, and the sim\'s own pre-game edge and spread. Court positions are schematic: there is no player tracking in a simulation. The plays the sim likes are the ones whose hit rate across all 10,000 games beats the chance Onyx\'s price needs; they are the model\'s projections, never locks and never Onyx Picks.');
  }

  Studio.register('replay', {title: 'Sim Replay', order: 3, mount: mount});
})();
