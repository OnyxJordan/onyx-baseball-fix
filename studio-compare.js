// studio-compare.js - NFL Studio "Compare" (11/15, Jordan: "player & odds comparison tool"). Two or three players
// side by side, market by market: Onyx's line and price on both sides, the model's projection, chance, fair odds and
// edge, recent form against the line, the matchup, and a "better bet by the model" verdict built from the model's EV at
// Onyx's price (never called a pick). A second mode compares two games (spread, total, moneyline at Onyx prices against
// the model's team scores). Every price opens Onyx; "+ Slip" puts the leg on the shared parlay slip (parlay.js), and
// selected rows go out as one Onyx link.
// Deep links: #compare?p=Name1|Name2[|Name3]   #compare?mode=games&g=gid1|gid2
(function () {
  'use strict';
  if (!window.Studio) return;

  var MK = {
    rec: 'Receptions', rec_yds: 'Receiving yards', rush_yds: 'Rushing yards', rush_rec_yds: 'Rush + rec yards',
    pass_yds: 'Passing yards', pass_att: 'Pass attempts', pass_td: 'Passing TDs', pass_rush_yds: 'Pass + rush yards',
    anytime_td: 'Anytime TD', two_td: '2+ TDs', three_td: '3+ TDs', first_td: 'First TD'
  };
  var ORDER = ['rec', 'rec_yds', 'rush_yds', 'rush_rec_yds', 'pass_yds', 'pass_att', 'pass_td', 'pass_rush_yds', 'anytime_td', 'two_td', 'three_td', 'first_td'];
  var TDM = {anytime_td: 1, two_td: 1, three_td: 1, first_td: 1};

  var CSS = [
    '.cmp{--tc:#b038f9;--cmp-top:54px}',
    '.cmp-mode{display:inline-flex;padding:3px;border-radius:999px;border:1px solid var(--line);background:var(--card);margin-bottom:12px}',
    '.cmp-mode button{border:0;background:transparent;color:var(--dim);font:700 12px monospace;letter-spacing:.05em;text-transform:uppercase;padding:8px 14px;border-radius:999px;cursor:pointer;transition:background .2s,color .2s}',
    '.cmp-mode button.on{background:var(--pur);color:#fff}',
    '.cmp-view{display:none}.cmp-view.on{display:block;animation:cmpIn .28s ease}',
    '@keyframes cmpIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.cmp-find{position:relative;margin-bottom:10px}',
    '.cmp-find .sx-in{padding-left:38px}',
    '.cmp-find svg{position:absolute;left:12px;top:12px;width:16px;height:16px;stroke:var(--mute);fill:none;stroke-width:2}',
    '.cmp-ac{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;background:#16111d;border:1px solid rgba(176,56,249,.45);border-radius:14px;box-shadow:0 12px 30px rgba(0,0,0,.6);max-height:320px;overflow-y:auto;display:none}',
    '.cmp-ac.on{display:block}',
    '.cmp-ac button{display:flex;width:100%;align-items:center;gap:10px;border:0;border-top:1px solid rgba(255,255,255,.06);background:transparent;color:#fff;text-align:left;padding:10px 12px;cursor:pointer;font:600 14px system-ui}',
    '.cmp-ac button:first-child{border-top:0}.cmp-ac button.hi,.cmp-ac button:hover{background:rgba(176,56,249,.16)}',
    '.cmp-ac i{width:4px;align-self:stretch;border-radius:4px;flex:none}',
    '.cmp-ac span{flex:1;min-width:0}.cmp-ac small{display:block;color:var(--mute);font:600 11px monospace;margin-top:2px}',
    '.cmp-ac em{font:700 11px monospace;color:var(--pur2);font-style:normal;flex:none}',
    '.cmp-sug{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}',
    '.cmp-sug button{border:1px dashed rgba(176,56,249,.45);background:transparent;color:var(--dim);border-radius:999px;padding:6px 11px;font:600 12px system-ui;cursor:pointer;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-sug button:hover{color:#fff;border-style:solid}',
    '.cmp-stick{position:sticky;top:var(--cmp-top);z-index:15;margin:0 -16px 10px;padding:6px 16px 8px;background:linear-gradient(var(--bg) 88%,rgba(12,12,12,0))}',
    '.cmp-head{display:grid;gap:8px}',
    '.cmp-pc{position:relative;min-width:0;border-radius:14px;padding:10px 10px 9px 12px;border:1px solid var(--line);background:linear-gradient(135deg,color-mix(in srgb,var(--tc) 22%,transparent),rgba(255,255,255,.03) 70%);overflow:hidden;transition:transform .2s}',
    '.cmp-pc:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--tc)}',
    '.cmp-pc b{display:block;font-size:14px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:18px}',
    '.cmp-pc small{display:block;font:600 10.5px monospace;color:var(--dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-pc .cmp-x{position:absolute;right:4px;top:4px;border:0;background:transparent;color:var(--mute);font:700 16px system-ui;cursor:pointer;width:26px;height:26px;border-radius:50%}',
    '.cmp-pc .cmp-x:hover{color:#fff;background:rgba(255,255,255,.08)}',
    '.cmp-av{float:left;width:30px;height:30px;border-radius:50%;margin:0 8px 0 0;background:color-mix(in srgb,var(--tc) 55%,#222);display:flex;align-items:center;justify-content:center;font:800 11px monospace;color:#fff;overflow:hidden;position:relative}',
    '.cmp-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.cmp-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border-radius:12px;border:1px solid rgba(97,233,112,.45);background:rgba(97,233,112,.07);font:600 12px system-ui;animation:cmpIn .2s ease}',
    '.cmp-bar span{color:var(--dim)}.cmp-bar span b{color:#fff}',
    '.cmp-bar div{display:flex;gap:6px;flex-wrap:wrap}',
    '.cmp-ctx{display:grid;gap:8px;margin-bottom:12px}',
    '.cmp-ci{min-width:0;border-radius:12px;padding:9px 10px;background:var(--card);border:1px solid var(--line);border-top:2px solid var(--tc);font-size:12px;line-height:1.5}',
    '.cmp-ci div{display:flex;justify-content:space-between;gap:6px}.cmp-ci span{color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cmp-ci b{font-family:monospace;white-space:nowrap}',
    '.cmp-sec{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:18px 0 8px}',
    '.cmp-sec h3{margin:0;font-size:16px}.cmp-sec span{color:var(--mute);font-size:11.5px}',
    '.cmp-m{border:1px solid var(--line);background:var(--card);border-radius:16px;padding:10px;margin-bottom:10px;animation:cmpIn .3s ease both}',
    '.cmp-mh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
    '.cmp-mh b{font-size:14px}.cmp-mh button{border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:999px;padding:4px 10px;font:700 10.5px monospace;letter-spacing:.04em;cursor:pointer;flex:none}',
    '.cmp-mh button.on{border-color:var(--pur);color:var(--pur2)}',
    '.cmp-cols{display:grid;gap:6px}',
    '.cmp-cell{min-width:0;position:relative;border-radius:12px;padding:8px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-top:2px solid var(--tc);transition:border-color .25s,box-shadow .25s,background .25s}',
    '.cmp-cell.likes{border-color:rgba(97,233,112,.75);background:rgba(97,233,112,.06);box-shadow:0 0 0 1px rgba(97,233,112,.25),0 6px 18px rgba(97,233,112,.08)}',
    '.cmp-cell.none{display:flex;align-items:center;justify-content:center;color:var(--mute);font:600 11px monospace;text-align:center;min-height:80px}',
    '.cmp-like{display:inline-block;font:800 9.5px monospace;letter-spacing:.05em;text-transform:uppercase;color:#0c0c0c;background:var(--grn);border-radius:6px;padding:2px 6px;margin-bottom:5px}',
    '.cmp-nr{display:inline-block;font:700 9.5px monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);border:1px solid var(--line);border-radius:6px;padding:1px 5px;margin-bottom:5px}',
    '.cmp-sd{font:800 13px monospace;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-cell .sx-chip{padding:6px 9px;font-size:12px;max-width:100%;box-sizing:border-box}',
    '.cmp-kv{display:flex;justify-content:space-between;gap:4px;font-size:11.5px;line-height:1.75}',
    '.cmp-kv span{color:var(--mute);white-space:nowrap}.cmp-kv b{font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-gauge{position:relative;height:5px;border-radius:5px;background:rgba(255,255,255,.08);margin:3px 0 5px}',
    '.cmp-gauge i{position:absolute;top:0;bottom:0;border-radius:5px;transition:left .35s,width .35s}',
    '.cmp-gauge u{position:absolute;top:-3px;bottom:-3px;width:2px;left:50%;margin-left:-1px;background:#fff;opacity:.6}',
    '.cmp-alt{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.1);font-size:11px;color:var(--mute);line-height:1.5}',
    '.cmp-alt a{color:var(--pur2);font:700 11px monospace;text-decoration:none}',
    '.cmp-acts{display:flex;gap:4px;margin-top:7px}',
    '.cmp-acts button{flex:1;min-width:0;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--dim);border-radius:9px;padding:7px 2px;font:700 10.5px monospace;cursor:pointer;white-space:nowrap;transition:background .2s,color .2s,border-color .2s}',
    '.cmp-acts button.on{border-color:var(--grn);color:var(--grn);background:rgba(97,233,112,.08)}',
    '.cmp-l8{margin-top:6px;font:600 10.5px monospace;color:var(--mute)}',
    '.cmp-v{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(176,56,249,.08);border:1px solid rgba(176,56,249,.22);font-size:12.5px;line-height:1.5;color:var(--dim);display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
    '.cmp-v p{margin:0;flex:1 1 220px;min-width:0}.cmp-v p b{color:#fff}',
    '.cmp-only{font-size:12px;color:var(--mute);line-height:1.6;margin:4px 0 0}',
    '.cmp-form{display:grid;gap:8px}',
    '.cmp-fc{min-width:0;border-radius:14px;padding:10px;background:var(--card);border:1px solid var(--line);border-top:2px solid var(--tc)}',
    '.cmp-fc>b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-fc>small{display:block;color:var(--dim);font:600 11px monospace;margin:2px 0 8px}',
    '.cmp-spark{position:relative;height:64px;display:flex;align-items:flex-end;gap:3px;border-bottom:1px solid rgba(255,255,255,.12)}',
    '.cmp-spark>i{flex:1;min-width:0;border-radius:4px 4px 0 0;background:rgba(255,255,255,.18);transition:height .4s ease;position:relative}',
    '.cmp-spark>i.hit{background:linear-gradient(var(--grn),rgba(97,233,112,.55))}',
    '.cmp-spark>u{position:absolute;left:0;right:0;border-top:1.5px dashed var(--pur2);pointer-events:none}',
    '.cmp-spark>u:after{content:attr(data-l);position:absolute;right:0;top:-15px;font:700 9.5px monospace;color:var(--pur2);background:var(--bg);padding:0 3px;border-radius:4px}',
    '.cmp-opp{display:flex;gap:3px;margin-top:3px}.cmp-opp span{flex:1;min-width:0;text-align:center;font:600 8.5px monospace;color:var(--mute);overflow:hidden;white-space:nowrap}',
    '.cmp-fchips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
    '.cmp-gsel{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:10px}',
    '.cmp-gh{min-width:0;border-radius:14px;padding:9px 10px;border:1px solid var(--line);background:var(--card);overflow:hidden}',
    '.cmp-gh .tm{display:flex;align-items:center;gap:6px;font:800 14px monospace;justify-content:space-between}',
    '.cmp-gh .tm i{width:10px;height:10px;border-radius:3px;flex:none}',
    '.cmp-gh .tm span{display:flex;align-items:center;gap:6px;min-width:0}',
    '.cmp-gh .tm em{font:700 12px monospace;font-style:normal;color:var(--dim)}',
    '.cmp-gh small{display:block;font:600 10.5px monospace;color:var(--mute);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cmp-gstripe{height:3px;border-radius:3px;margin:-2px 0 7px}',
    '.cmp-gside+.cmp-gside{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)}',
    '.cmp-note{font-size:11.5px;color:var(--mute);line-height:1.55;margin:12px 0 0}',
    '.cmp-short{display:none}',
    '@media (max-width:600px){.cmp-n3 .cmp-full{display:none}.cmp-n3 .cmp-short{display:inline}.cmp-n3 .cmp-av{display:none}.cmp-n3 .cmp-pc{padding:9px 6px 8px 9px}.cmp-n3 .cmp-pc small{font-size:9.5px}.cmp-n3 .cmp-cell{padding:7px 6px}.cmp-n3 .cmp-kv{flex-wrap:wrap;font-size:11px;line-height:1.5;column-gap:2px}.cmp-n3 .cmp-kv b{margin-left:auto}.cmp-n3 .cmp-ci{padding:8px 7px;font-size:11px}.cmp-n3 .cmp-sd{font-size:12px}.cmp-n3 .cmp-acts{flex-direction:column}.cmp-n3 .cmp-cell .sx-chip{padding:5px 7px;font-size:11px}}',
    '@media (min-width:760px){.cmp-st{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));column-gap:22px}.cmp-acts{max-width:340px}.cmp-cell{padding:10px 12px}.cmp-kv{font-size:12.5px}.cmp-pc b{font-size:16px}.cmp-sd{font-size:14px}}'
  ].join('\n');

  Studio.register('compare', {title: 'Compare', order: 1, mount: function (el, D, u) {
    if (!document.getElementById('sx-compare-css')) { var st = document.createElement('style'); st.id = 'sx-compare-css'; st.textContent = CSS; document.head.appendChild(st); }

    var PLAYERS = D.players(), BYK = {};
    PLAYERS.forEach(function (p) { BYK[u.nk(p.name)] = p; });
    var CARD = {}, CST = {}, HIST = null, HIST_P = null;
    var S = {mode: 'players', keys: [], focus: null, games: [], picked: {}};
    var sign = function (x, d) { var t = Math.abs(x).toFixed(d == null ? 1 : d); return (+t === 0 ? '' : x > 0 ? '+' : '-') + t; };
    var num = function (x) { return x == null || isNaN(x) ? '-' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1); };

    // ── data helpers ───────────────────────────────────────────────────────
    function color(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#b038f9';
      var n = parseInt(m[1], 16), r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = 0, h = 0, d = mx - mn;
      if (d) { s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
      if (h >= 32 && h <= 75 && s > .18) return '#d795ff';            // no yellow or gold anywhere: purple instead
      if (s < .12) return l < .5 ? '#9a93a6' : '#e6e1ee';              // black / white / grey teams: a neutral that shows
      return 'hsl(' + Math.round(h) + ',' + Math.round(Math.min(1, s) * 100) + '%,' + Math.round(Math.max(.5, Math.min(.68, l)) * 100) + '%)';
    }
    function gameOf(gid) { return D.game(gid) || null; }
    function teamColor(gid, team) { var g = gameOf(gid); if (!g) return '#b038f9'; return color(team === g.home ? g.home_color : g.away_color); }
    function lines(gid) {
      var rows = D.playsFor(gid), o = {spread: [], total: [], ml: [], model: null};
      rows.forEach(function (r) {
        if (r.kind === 'spread' || r.kind === 'total' || r.kind === 'ml') o[r.kind].push(r);
        var m = r.why && /model ([A-Z]{2,4}) ([\d.]+) ([A-Z]{2,4}) ([\d.]+)/.exec(r.why);
        if (m && !o.model) { o.model = {}; o.model[m[1]] = +m[2]; o.model[m[3]] = +m[4]; }
      });
      var tot = o.total[0] ? o.total[0].line : null;
      o.totalLine = tot;
      o.implied = function (team) {
        var s = o.spread.filter(function (r) { return r.who === team; })[0];
        return tot != null && s && s.hcap != null ? (tot - s.hcap) / 2 : null;
      };
      return o;
    }
    function info(p) {
      var r0 = p.rows[0], g = gameOf(r0.gid), opp = g ? (r0.team === g.home ? g.away : g.home) : null;
      var has = function (m) { return p.rows.some(function (r) { return r.mkt === m; }); };
      var pos = has('pass_yds') || has('pass_att') ? 'QB' : p.role === 'RB' ? 'RB' : p.role === 'WR/TE' ? 'WR/TE' : has('rush_yds') && !has('rec') ? 'RB' : has('rec') ? 'WR/TE' : '';
      return {key: u.nk(p.name), name: p.name, team: r0.team, gid: r0.gid, game: g, opp: opp, home: g ? r0.team === g.home : null,
              start: r0.start, pid: r0.who, pos: pos, rows: p.rows, color: teamColor(r0.gid, r0.team)};
    }
    function rowOf(P, m) { return P.rows.filter(function (r) { return r.mkt === m; })[0] || null; }
    // the other side of a two-way prop, from the team card's Onyx prices (cards carry both sides; the board only the better one)
    function altOf(row) {
      var c = CARD[row.team]; if (!c || !c.players || TDM[row.mkt]) return null;
      var pl = null; Object.keys(c.players).some(function (k) { if (c.players[k].id === row.who) { pl = c.players[k]; return true; } return false; });
      var mk = pl && (pl.mk || []).filter(function (x) { return x.m === row.mkt; })[0];
      if (!mk || mk.over == null || mk.under == null || Math.abs(mk.line - row.line) > .01) return null;
      var over = row.side !== 'over', price = over ? mk.over : mk.under, sel = over ? mk.over_sel : mk.under_sel;
      if (!sel || price == null) return null;
      var conf = 1 - row.conf, nv = u.imp(price) / (u.imp(price) + u.imp(row.price));
      return Object.assign({}, row, {side: over ? 'over' : 'under', price: price, sel: sel, conf: conf, ev: conf * u.dec(price) - 1, edge: conf - nv,
        label: row.label.replace(/\b(Over|Under)\b/, over ? 'Over' : 'Under'), _alt: true});
    }
    function sideTxt(r) {
      if (r.kind === 'ml') return r.who + ' ML';
      if (r.kind === 'spread') return r.who + ' ' + (r.hcap > 0 ? '+' : '') + r.hcap;
      if (r.kind === 'total') return (r.side === 'over' ? 'Over ' : 'Under ') + r.line;
      if (r.mkt === 'anytime_td') return 'Anytime TD';
      if (TDM[r.mkt]) return MK[r.mkt];
      return (r.side === 'over' ? 'Over ' : 'Under ') + r.line;
    }
    function shortName(n) { var a = String(n).split(' '); return a.length > 1 ? a[0][0] + '. ' + a.slice(1).join(' ').replace(/ (Jr\.|Sr\.|II|III|IV)$/, '') : n; }

    // game logs (data/nfl/player_games.json, loaded once)
    function stat(g, m) {
      var z = function (k) { return g[k] || 0; }, passing = (g.cats || []).indexOf('passing') >= 0;
      switch (m) {
        case 'rec': case 'rec_yds': case 'rush_yds': return z(m);
        case 'pass_yds': return passing ? z('pass_yds') : null;
        case 'pass_att': return passing ? z('att') : null;
        case 'pass_td': return passing ? z('pass_td') : null;
        case 'rush_rec_yds': return z('rush_yds') + z('rec_yds');
        case 'pass_rush_yds': return passing ? z('pass_yds') + z('rush_yds') : null;
        case 'anytime_td': case 'two_td': case 'three_td': return z('rush_td') + z('rec_td');
      }
      return null;
    }
    function logs(pid, m) {
      if (!HIST || !HIST[pid]) return [];
      return HIST[pid].map(function (g) { return {g: g, v: stat(g, m)}; }).filter(function (x) { return x.v != null; }).slice(0, 8).reverse();
    }
    function loadHist() {
      if (!HIST_P) HIST_P = D.history().then(function (rows) {
        var o = {}; rows.forEach(function (r) { if (r.pid) (o[r.pid] = o[r.pid] || []).push(r); });
        Object.keys(o).forEach(function (k) { o[k].sort(function (a, b) { return a.date < b.date ? 1 : -1; }); });
        HIST = o; draw();
      });
      return HIST_P;
    }
    function loadCards(teams) {
      var need = teams.filter(function (t) { return t && !(t in CARD); });
      if (!need.length) return;
      need.forEach(function (t) { CARD[t] = null; CST[t] = 'load'; });
      Promise.all(need.map(function (t) { return D.card(t).then(function (c) { CARD[t] = c; CST[t] = c ? 'ok' : 'fail'; }); })).then(draw);
    }

    // ── value ──────────────────────────────────────────────────────────────
    function best(rows) {   // the side the model rates best by EV at Onyx's price; null when the model has no read
      var r = rows.filter(function (x) { return x && !x.no_read && x.ev != null; });
      return r.sort(function (a, b) { return b.ev - a.ev; })[0] || null;
    }
    function evTxt(x) { return sign(100 * x, 1) + '%'; }
    function verdict(sets, who) {
      // sets: [{name, rows:[sides]}]
      var ok = sets.map(function (s) { return {name: s.name, b: best(s.rows)}; });
      var read = ok.filter(function (x) { return x.b; });
      if (!read.length) return 'No model read on ' + (sets.length > 2 ? 'any of these' : 'either') + ' (the chances shown are Onyx\'s own), so the model has no verdict here.';
      read.sort(function (a, b) { return b.b.ev - a.b.ev; });
      var top = read[0], rest = read.slice(1), nr = ok.filter(function (x) { return !x.b; });
      var what = function (x) { return '<b>' + u.esc(x.name + ' ' + sideTxt(x.b)) + '</b> (' + evTxt(x.b.ev) + ' EV at Onyx ' + u.odds(x.b.price) + ')'; };
      var s;
      if (top.b.ev > 0) s = 'Better bet by the model: ' + what(top) + (rest.length ? ', ahead of ' + rest.map(function (x) { return u.esc(x.name + ' ' + sideTxt(x.b)) + ' ' + evTxt(x.b.ev); }).join(', ') : '') + '.';
      else s = 'Neither is a value at Onyx\'s prices. ' + (rest.length ? 'The model rates ' + what(top) + ' closest; ' + rest.map(function (x) { return u.esc(x.name + ' ' + sideTxt(x.b)) + ' ' + evTxt(x.b.ev); }).join(', ') + '.' : 'Best side: ' + what(top) + '.');
      if (nr.length) s += ' ' + nr.map(function (x) { return u.esc(x.name.replace(/:$/, '')); }).join(', ') + ': no model read.';
      return s;
    }

    // ── selection (rows bet together) ─────────────────────────────────────
    var ROWS = {};   // sel -> row, every row drawn this render
    function onSlip(sel) { try { return !!(window.OnyxParlay && OnyxParlay.slip().some(function (x) { return x.sel === sel; })); } catch (e) { return false; } }
    function acts(r) {
      if (!r.sel) return '';
      ROWS[r.sel] = r;
      return '<div class="cmp-acts"><button type="button" data-slip="' + u.esc(r.sel) + '" class="' + (onSlip(r.sel) ? 'on' : '') + '">' + (onSlip(r.sel) ? 'On slip' : '+ Slip') + '</button>'
        + '<button type="button" data-pick="' + u.esc(r.sel) + '" class="' + (S.picked[r.sel] ? 'on' : '') + '">' + (S.picked[r.sel] ? 'Selected' : 'Select') + '</button></div>';
    }
    function pickBar() {
      var ids = Object.keys(S.picked).filter(function (k) { return S.picked[k]; });
      if (!ids.length) return '';
      var rows = ids.map(function (k) { return S.picked[k]; });
      var d = rows.reduce(function (m, r) { return m * u.dec(r.price); }, 1);
      var href = u.onyx(ids, 'compare_selected');
      return '<div class="cmp-bar"><span><b>' + ids.length + ' selected</b>' + (ids.length > 1 ? ' · one Onyx link, ' + u.odds(u.amer(d)) + ' together' : ' · Onyx ' + u.odds(rows[0].price)) + '</span><div>'
        + '<a class="sx-chip onyx" target="_blank" rel="noopener" href="' + u.esc(href) + '">' + (ids.length > 1 ? 'Bet ' + (ids.length === 2 ? 'both' : 'all') + ' on Onyx' : 'Bet on Onyx') + '</a>'
        + '<button type="button" class="sx-chip" data-slipall="1">+ Slip all</button><button type="button" class="sx-chip" data-clearpick="1">Clear</button></div></div>';
    }

    // ── one side of a market (one player's row, or one side of a game line) ─────────────
    function sideHTML(r, likes, compact) {
      var nr = !!r.no_read, h = '';
      if (likes) h += '<span class="cmp-like">The model likes</span><br>';
      else if (nr) h += '<span class="cmp-nr">no model read</span><br>';
      h += '<div class="cmp-sd">' + u.esc(sideTxt(r)) + '</div>' + u.onyxBtn(r, 'Onyx ' + u.odds(r.price));
      if (r.kind === 'prop' && r.proj != null && !TDM[r.mkt]) {
        var diff = r.line ? (r.proj - r.line) / Math.max(1, r.line) : 0, w = Math.min(50, Math.abs(diff) * 100);
        var good = (r.side === 'over') === (r.proj > r.line);
        h += '<div class="cmp-kv" style="margin-top:6px"><span>Proj</span><b class="' + (good ? 'sx-pos' : 'sx-neg') + '">' + num(r.proj) + ' vs ' + r.line + '</b></div>'
          + '<div class="cmp-gauge"><i style="left:' + (diff >= 0 ? 50 : 50 - w) + '%;width:' + w + '%;background:' + (good ? 'var(--grn)' : 'var(--red)') + '"></i><u></u></div>';
      } else if (r.mkt === 'anytime_td' && r.lam != null) {
        h += '<div class="cmp-kv" style="margin-top:6px"><span>Proj TDs</span><b>' + r.lam.toFixed(2) + '</b></div>';
      } else h += '<div style="height:6px"></div>';
      h += '<div class="cmp-st">';
      if (nr) {
        h += '<div class="cmp-kv"><span>Onyx chance</span><b>' + u.pct(r.conf) + '</b></div><div class="cmp-kv"><span>Fair · edge</span><b>-</b></div>';
      } else {
        h += '<div class="cmp-kv"><span>Model</span><b>' + u.pct(r.conf, 1) + '</b></div>'
          + '<div class="cmp-kv"><span>Fair</span><b>' + (r.conf > 0 && r.conf < 1 ? u.odds(u.amer(1 / r.conf)) : '-') + '</b></div>'
          + '<div class="cmp-kv"><span>Edge</span><b class="' + (r.edge > 0 ? 'sx-pos' : 'sx-neg') + '">' + (r.edge == null ? '-' : sign(100 * r.edge, 1)) + '</b></div>'
          + (compact ? '' : '<div class="cmp-kv"><span>EV</span><b class="' + (r.ev > 0 ? 'sx-pos' : 'sx-neg') + '">' + (r.ev == null ? '-' : evTxt(r.ev)) + '</b></div>');
      }
      return h + '</div>' + acts(r);
    }

    // ── players view ───────────────────────────────────────────────────────
    function sel() { return S.keys.map(function (k) { return BYK[k]; }).filter(Boolean).map(info); }
    function cols(n) { return 'grid-template-columns:repeat(' + n + ',minmax(0,1fr))'; }
    function shared(Ps) { return ORDER.filter(function (m) { return Ps.every(function (P) { return rowOf(P, m); }); }); }

    function headCards(Ps) {
      return '<div class="cmp-head" style="' + cols(Math.max(2, Ps.length)) + '">' + Ps.map(function (P) {
        var ini = P.name.split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2);
        return '<div class="cmp-pc" style="--tc:' + P.color + '"><button type="button" class="cmp-x" data-rm="' + u.esc(P.key) + '" aria-label="Remove ' + u.esc(P.name) + '">×</button>'
          + '<span class="cmp-av">' + u.esc(ini) + (P.pid ? '<img alt="" loading="lazy" src="https://a.espncdn.com/i/headshots/nfl/players/full/' + u.esc(P.pid) + '.png" onerror="this.remove()">' : '') + '</span>'
          + '<b><span class="cmp-full">' + u.esc(P.name) + '</span><span class="cmp-short">' + u.esc(P.name.split(' ').slice(-1)[0].replace(/^(Jr\.|Sr\.|II|III|IV)$/, P.name.split(' ').slice(-2)[0])) + '</span></b><small>' + u.esc([P.team, P.pos].filter(Boolean).join(' · ')) + ' · ' + (P.home ? 'vs ' : '@ ') + u.esc(P.opp || '') + '</small></div>';
      }).join('') + (Ps.length < 2 ? '<div class="cmp-pc" style="--tc:#3a2a55"><b>Add a player</b><small>search above</small></div>' : '') + '</div>';
    }
    function ctxHTML(Ps) {
      var n3 = Ps.length > 2;
      return '<div class="cmp-ctx" style="' + cols(Ps.length) + '">' + Ps.map(function (P) {
        var L = lines(P.gid), imp = L.implied(P.team), mod = L.model && L.model[P.team], oc = CARD[P.opp], pa5 = null, paS = null;
        if (oc && oc.team) {
          var rec = (oc.team.recent || []).slice(0, 5).filter(function (g) { return g.pa != null; });
          if (rec.length) pa5 = rec.reduce(function (m, g) { return m + g.pa; }, 0) / rec.length;
          paS = oc.team.seasons && oc.team.seasons[0] ? oc.team.seasons[0].pa : null;
        }
        return '<div class="cmp-ci" style="--tc:' + P.color + '">'
          + '<div><span>' + (n3 ? '' : P.home ? 'vs ' : '@ ') + u.esc(P.opp || '') + '</span><b>' + u.esc(u.fmtTime(P.start)) + '</b></div>'
          + '<div><span>' + (n3 ? 'Implied' : u.esc(P.team) + ' implied (Onyx)') + '</span><b>' + num(imp) + '</b></div>'
          + '<div><span>' + (n3 ? 'Model' : u.esc(P.team) + ' model score') + '</span><b>' + num(mod) + '</b></div>'
          + '<div><span>' + (n3 ? 'D L5' : u.esc(P.opp || 'Opp') + ' allows, L5') + '</span><b>' + (oc ? num(pa5) : CST[P.opp] === 'load' ? '...' : '-') + '</b></div>'
          + '<div><span>' + (n3 ? 'D year' : u.esc(P.opp || 'Opp') + ' allows, season') + '</span><b>' + (oc ? num(paS) : '-') + '</b></div></div>';
      }).join('') + '</div>';
    }
    function l8(P, r) {
      if (!HIST || r.mkt === 'first_td') return '';
      var L = logs(P.pid, r.mkt); if (!L.length) return '';
      var hit = L.filter(function (x) { return x.v > r.line; }).length;
      return '<div class="cmp-l8">L' + L.length + ' over ' + r.line + ': ' + hit + '/' + L.length + '</div>';
    }
    function marketHTML(Ps, m, i) {
      var cells = Ps.map(function (P) { var r = rowOf(P, m); return {P: P, r: r, alt: r ? altOf(r) : null}; });
      var bestAll = best([].concat.apply([], cells.map(function (c) { return [c.r, c.alt]; })));
      var likeSel = bestAll && bestAll.ev > 0 ? bestAll.sel : null;
      var both = cells.map(function (c) { return c.r && c.r.sel; }).filter(Boolean);
      var h = '<div class="cmp-m" data-m="' + m + '" data-shared="1" style="animation-delay:' + Math.min(i, 8) * 40 + 'ms"><div class="cmp-mh"><b>' + u.esc(MK[m]) + '</b>'
        + (m !== 'first_td' ? '<button type="button" data-focus="' + m + '" class="' + (S.focus === m ? 'on' : '') + '">Form</button>' : '') + '</div>'
        + '<div class="cmp-cols" style="' + cols(Ps.length) + '">' + cells.map(function (c) {
          var r = c.r, likeMain = likeSel && r.sel === likeSel, likeAlt = likeSel && c.alt && c.alt.sel === likeSel;
          var x = '<div class="cmp-cell' + (likeMain || likeAlt ? ' likes' : '') + '" style="--tc:' + c.P.color + '">' + sideHTML(r, likeMain, Ps.length > 2);
          if (c.alt) {
            ROWS[c.alt.sel] = c.alt;
            x += '<div class="cmp-alt">' + (likeAlt ? '<span class="cmp-like">The model likes</span><br>' : '') + u.esc(sideTxt(c.alt)) + ' <a target="_blank" rel="noopener" href="' + u.esc(u.onyx([c.alt.sel], 'single')) + '">Onyx ' + u.odds(c.alt.price) + '</a>'
              + (c.alt.no_read ? '' : '<br>model ' + u.pct(c.alt.conf, 1) + ' · EV <span class="' + (c.alt.ev > 0 ? 'sx-pos' : 'sx-neg') + '">' + evTxt(c.alt.ev) + '</span>') + acts(c.alt) + '</div>';
          }
          return x + l8(c.P, r) + '</div>';
        }).join('') + '</div>'
        + '<div class="cmp-v"><p>' + verdict(cells.map(function (c) { return {name: shortName(c.P.name), rows: [c.r, c.alt]}; })) + '</p>'
        + (both.length > 1 ? '<a class="sx-chip onyx" target="_blank" rel="noopener" href="' + u.esc(u.onyx(both, 'compare_both')) + '">Bet ' + (both.length === 2 ? 'both' : 'all') + '</a>' : '') + '</div></div>';
      return h;
    }
    function formHTML(Ps, ms) {
      var fm = ms.filter(function (m) { return m !== 'first_td'; });
      if (!fm.length) return '';
      if (fm.indexOf(S.focus) < 0) S.focus = fm[0];
      var h = '<div class="cmp-sec" id="cmpForm"><h3>Recent form</h3><span>last 8 games · dashed line = Onyx line</span></div>'
        + '<div class="cmp-fchips">' + fm.map(function (m) { return '<button type="button" class="sx-chip' + (m === S.focus ? ' onyx' : '') + '" data-focus="' + m + '">' + u.esc(MK[m]) + '</button>'; }).join('') + '</div>';
      if (!HIST) return h + '<div class="st-load">Loading game logs</div>';
      return h + '<div class="cmp-form" style="' + cols(Ps.length) + '">' + Ps.map(function (P) {
        var r = rowOf(P, S.focus), L = logs(P.pid, S.focus);
        if (!r) return '<div class="cmp-fc" style="--tc:' + P.color + '"><b>' + u.esc(P.name) + '</b><small>no Onyx line</small></div>';
        if (!L.length) return '<div class="cmp-fc" style="--tc:' + P.color + '"><b>' + u.esc(P.name) + '</b><small>no game log yet</small></div>';
        var line = r.line, mx = Math.max(line * 1.5, 1, Math.max.apply(null, L.map(function (x) { return x.v; })) * 1.08);
        var hit = L.filter(function (x) { return x.v > line; }).length, avg = L.reduce(function (s, x) { return s + x.v; }, 0) / L.length;
        return '<div class="cmp-fc" style="--tc:' + P.color + '"><b>' + u.esc(P.name) + '</b><small>Over ' + line + ' in <span class="' + (hit / L.length >= .5 ? 'sx-pos' : 'sx-neg') + '">' + hit + ' of ' + L.length + '</span> · avg ' + num(avg) + '</small>'
          + '<div class="cmp-spark">' + L.map(function (x) {
            return '<i class="' + (x.v > line ? 'hit' : '') + '" style="height:' + Math.max(3, 100 * x.v / mx).toFixed(1) + '%" title="' + u.esc(x.g.date + ' ' + (x.g.home ? 'vs ' : '@ ') + x.g.opp + ': ' + x.v) + '"></i>';
          }).join('') + '<u style="bottom:' + (100 * line / mx).toFixed(1) + '%" data-l="' + line + '"></u></div>'
          + '<div class="cmp-opp">' + L.map(function (x) { return '<span>' + u.esc(x.g.opp) + '</span>'; }).join('') + '</div>'
          + '<div class="cmp-opp">' + L.map(function (x) { return '<span style="color:' + (x.v > line ? 'var(--grn)' : 'var(--dim)') + '">' + u.esc(num(x.v).replace(/\.0$/, '')) + '</span>'; }).join('') + '</div></div>';
      }).join('') + '</div>';
    }
    function suggestions() {
      return defaults(3).map(function (pair) {
        return '<button type="button" data-pair="' + u.esc(pair.join('|')) + '">' + u.esc(pair.map(shortName).join(' vs ')) + '</button>';
      }).join('');
    }
    function playersHTML() {
      var Ps = sel();
      var h = '<div class="cmp-find"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'
        + '<input class="sx-in" id="cmpQ" type="search" autocomplete="off" placeholder="' + (Ps.length >= 3 ? 'Three players max: remove one to add' : 'Add a player: name or team') + '"' + (Ps.length >= 3 ? ' disabled' : '') + ' aria-label="Search players">'
        + '<div class="cmp-ac" id="cmpAc"></div></div><div class="cmp-sug">' + suggestions() + '</div>';
      h += '<div class="cmp-stick">' + headCards(Ps) + pickBar() + '</div>';
      if (Ps.length < 2) return h + '<p class="sx-sub">Pick at least two players to compare them market by market.</p>';
      var ms = shared(Ps);
      h += ctxHTML(Ps);
      h += '<div class="cmp-sec"><h3>Market by market</h3><span>' + ms.length + ' shared market' + (ms.length === 1 ? '' : 's') + '</span></div>';
      if (!ms.length) h += '<p class="sx-sub">These players share no Onyx market today. Try two players at the same position.</p>';
      h += ms.map(function (m, i) { return marketHTML(Ps, m, i); }).join('');
      var only = Ps.map(function (P) { var o = P.rows.filter(function (r) { return ms.indexOf(r.mkt) < 0; }); return o.length ? '<b>' + u.esc(shortName(P.name)) + '</b> also: ' + o.map(function (r) { return u.onyxBtn(r, MK[r.mkt] + ' ' + u.odds(r.price)); }).join(' ') : ''; }).filter(Boolean);
      if (only.length) h += '<p class="cmp-only">' + only.join('<br>') + '</p>';
      h += formHTML(Ps, ms);
      h += '<p class="cmp-note">Chances, fair odds and edges are the model\'s projections against Onyx\'s prices, never Onyx Picks. "No model read" means the chance shown is Onyx\'s own, so the model takes no side there. EV is what $1 returns on average at Onyx\'s price if the model\'s chance is right.</p>';
      return h;
    }

    // ── games view ─────────────────────────────────────────────────────────
    function gameOpt(g) { var L = lines(g.gid); return g.away + ' @ ' + g.home + ' · ' + u.fmtTime(g.start) + (L.totalLine != null ? ' · total ' + L.totalLine : ''); }
    function gameHead(g) {
      var L = lines(g.gid), ca = color(g.away_color), ch = color(g.home_color);
      var row = function (t, c, rec) { return '<div class="tm"><span><i style="background:' + c + '"></i>' + u.esc(t) + '</span><em>' + (L.model && L.model[t] != null ? num(L.model[t]) : '-') + '</em></div>'; };
      return '<div class="cmp-gh"><div class="cmp-gstripe" style="background:linear-gradient(90deg,' + ca + ',' + ch + ')"></div>'
        + row(g.away, ca) + row(g.home, ch)
        + '<small>model score · ' + u.esc(u.fmtTime(g.start)) + '</small>'
        + '<small>Onyx implied ' + u.esc(g.away) + ' ' + num(L.implied(g.away)) + ' · ' + u.esc(g.home) + ' ' + num(L.implied(g.home)) + '</small></div>';
    }
    function gameProj(g, L, kind) {
      if (!L.model || L.model[g.away] == null || L.model[g.home] == null) return '';
      var a = L.model[g.away], hm = L.model[g.home];
      if (kind === 'spread') { var fav = a >= hm ? g.away : g.home; return 'Model: ' + fav + ' by ' + Math.abs(a - hm).toFixed(1); }
      if (kind === 'total') return 'Model total ' + (a + hm).toFixed(1) + (L.totalLine != null ? ' vs ' + L.totalLine : '');
      return 'Model score ' + g.away + ' ' + a.toFixed(1) + ', ' + g.home + ' ' + hm.toFixed(1);
    }
    function gamesHTML() {
      var gs = S.games.map(gameOf).filter(Boolean), pre = D.pre.length ? D.pre : D.games;
      var opts = function (cur) { return pre.map(function (g) { return '<option value="' + u.esc(g.gid) + '"' + (g.gid === cur ? ' selected' : '') + '>' + u.esc(gameOpt(g)) + '</option>'; }).join(''); };
      var h = '<div class="cmp-gsel"><select class="sx-sel" data-g="0" aria-label="First game">' + opts(S.games[0]) + '</select><select class="sx-sel" data-g="1" aria-label="Second game">' + opts(S.games[1]) + '</select></div>';
      if (gs.length < 2) return h + '<p class="sx-sub">Not enough games on the board to compare.</p>';
      h += '<div class="cmp-stick"><div class="cmp-head" style="' + cols(2) + '">' + gs.map(gameHead).join('') + '</div>' + pickBar() + '</div>';
      [['spread', 'Spread'], ['total', 'Total'], ['ml', 'Moneyline']].forEach(function (k, i) {
        var per = gs.map(function (g) { var L = lines(g.gid); return {g: g, L: L, rows: L[k[0]].slice().sort(function (a, b) { return k[0] === 'total' ? (a.side === 'over' ? -1 : 1) : (a.who === g.away ? -1 : 1); })}; });
        var bestAll = best([].concat.apply([], per.map(function (p) { return p.rows; })));
        var likeSel = bestAll && bestAll.ev > 0 ? bestAll.sel : null;
        h += '<div class="cmp-m" style="animation-delay:' + i * 50 + 'ms"><div class="cmp-mh"><b>' + k[1] + '</b></div><div class="cmp-cols" style="' + cols(2) + '">' + per.map(function (p) {
          if (!p.rows.length) return '<div class="cmp-cell none">No Onyx ' + k[1].toLowerCase() + '</div>';
          var like = p.rows.some(function (r) { return r.sel === likeSel; });
          return '<div class="cmp-cell' + (like ? ' likes' : '') + '" style="--tc:' + color(p.g.home_color) + '"><div class="cmp-l8" style="margin:0 0 6px">' + u.esc(gameProj(p.g, p.L, k[0])) + '</div>'
            + p.rows.map(function (r) { return '<div class="cmp-gside">' + sideHTML(r, r.sel === likeSel, false) + '</div>'; }).join('') + '</div>';
        }).join('') + '</div><div class="cmp-v"><p>' + verdict(per.map(function (p) { return {name: p.g.away + ' @ ' + p.g.home + ':', rows: p.rows}; })) + '</p></div></div>';
      });
      h += '<p class="cmp-note">Model scores come from the model\'s game read; Onyx implied points come from Onyx\'s spread and total. Chances and fair odds are projections, never Onyx Picks.</p>';
      return h;
    }

    // ── defaults and deep links ────────────────────────────────────────────
    function totalOf(gid) { var L = lines(gid); return L.totalLine == null ? 0 : L.totalLine; }
    function defaults(n) {
      var pre = D.pre.slice(); if (!pre.length) return [];
      var first = Math.min.apply(null, pre.map(function (g) { return Date.parse(g.start); }));
      var today = pre.filter(function (g) { return Date.parse(g.start) < first + 20 * 3600e3; });
      today.sort(function (a, b) { return totalOf(b.gid) - totalOf(a.gid); });
      var out = [];
      today.forEach(function (g) {
        if (out.length >= n) return;
        [['rec_yds', 'WR/TE'], ['rush_yds', 'RB'], ['rec_yds', null], ['pass_yds', null]].some(function (mr) {
          var m = mr[0], c = PLAYERS.filter(function (p) { return p.gid === g.gid && (!mr[1] || p.role === mr[1]) && p.rows.some(function (r) { return r.mkt === m; }); });
          c.sort(function (a, b) { return (b.rows.length - a.rows.length) || (rowOf(b, m).line - rowOf(a, m).line); });
          if (c.length < 2) return false;
          var a = c[0], b = c.filter(function (p) { return p.team !== a.team; })[0] || c[1];
          out.push([a.name, b.name]); return true;
        });
      });
      if (!out.length && PLAYERS.length > 1) out.push([PLAYERS[0].name, PLAYERS[1].name]);
      return out;
    }
    function defaultGames() {
      var pre = (D.pre.length ? D.pre : D.games).slice().sort(function (a, b) { return totalOf(b.gid) - totalOf(a.gid); });
      return pre.slice(0, 2).map(function (g) { return g.gid; });
    }
    function readLink() {
      var mode = Studio.param('mode'), p = Studio.param('p'), g = Studio.param('g');
      if (p) { var ks = p.split('|').map(u.nk).filter(function (k) { return BYK[k]; }); if (ks.length) S.keys = ks.slice(0, 3); }
      if (g) { var gs = g.split('|').filter(gameOf); if (gs.length === 2) S.games = gs; }
      if (mode === 'games' || (g && !p)) S.mode = 'games'; else if (p) S.mode = 'players';
    }
    function writeLink() {
      if ((location.hash.slice(1).split('?')[0] || '') !== 'compare') return;
      var h = '#compare?' + (S.mode === 'games' ? 'mode=games&g=' + S.games.join('|') : 'p=' + S.keys.map(function (k) { return encodeURIComponent(BYK[k].name); }).join('|'));
      if (location.hash !== h) history.replaceState(null, '', h);
    }

    // ── render ─────────────────────────────────────────────────────────────
    el.innerHTML = '<div class="cmp"><div class="cmp-mode" role="tablist"><button type="button" data-mode="players">Compare players</button><button type="button" data-mode="games">Compare games</button></div>'
      + '<div class="cmp-view cmp-pview"></div><div class="cmp-view cmp-gview"></div></div>';
    var root = el.querySelector('.cmp'), pv = el.querySelector('.cmp-pview'), gv = el.querySelector('.cmp-gview');
    function setTop() { var t = document.getElementById('stTabs'); if (t) root.style.setProperty('--cmp-top', (t.offsetHeight || 54) + 'px'); }
    function draw() {
      ROWS = {};
      var y = window.scrollY, ae = document.activeElement && document.activeElement.id === 'cmpQ' ? document.getElementById('cmpQ').value : null;
      pv.innerHTML = playersHTML(); pv.classList.toggle('cmp-n3', S.keys.length > 2); gv.innerHTML = gamesHTML();
      pv.classList.toggle('on', S.mode === 'players'); gv.classList.toggle('on', S.mode === 'games');
      Array.prototype.forEach.call(root.querySelectorAll('[data-mode]'), function (b) { b.classList.toggle('on', b.dataset.mode === S.mode); });
      if (ae != null) { var q = document.getElementById('cmpQ'); if (q && !q.disabled) { q.value = ae; q.focus(); } }
      if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
      writeLink();
    }
    function apply() {
      var Ps = sel(), teams = [];
      Ps.forEach(function (P) { teams.push(P.team, P.opp); });
      S.games.forEach(function (gid) { var g = gameOf(gid); if (g) teams.push(g.home, g.away); });
      // drop selections whose rows are no longer drawn
      draw(); loadCards(teams);
      if (S.mode === 'players' && Ps.length >= 2) loadHist();
    }
    function addKey(k) { if (!BYK[k] || S.keys.indexOf(k) >= 0 || S.keys.length >= 3) return; S.keys.push(k); apply(); }

    // search autocomplete
    var acIdx = 0, acList = [];
    function acDraw(q) {
      var ac = document.getElementById('cmpAc'); if (!ac) return;
      var k = u.nk(q), up = String(q || '').trim().toUpperCase();
      if (!k) { ac.classList.remove('on'); ac.innerHTML = ''; acList = []; return; }
      acList = PLAYERS.map(function (p) {
        var nk = u.nk(p.name), last = u.nk(p.name.split(' ').slice(1).join(' ')), sc = 0;
        if (nk.indexOf(k) === 0 || last.indexOf(k) === 0) sc = 3; else if (nk.indexOf(k) >= 0) sc = 2; else if (p.team === up) sc = 1;
        return {p: p, sc: sc};
      }).filter(function (x) { return x.sc && S.keys.indexOf(u.nk(x.p.name)) < 0; })
        .sort(function (a, b) { return (b.sc - a.sc) || (b.p.rows.length - a.p.rows.length) || a.p.name.localeCompare(b.p.name); }).slice(0, 8).map(function (x) { return x.p; });
      acIdx = 0;
      ac.innerHTML = acList.length ? acList.map(function (p, i) {
        var ms = ORDER.filter(function (m) { return !TDM[m] && rowOf(p, m); }).map(function (m) { return MK[m]; });
        return '<button type="button" data-add="' + u.esc(u.nk(p.name)) + '" class="' + (i === 0 ? 'hi' : '') + '"><i style="background:' + teamColor(p.gid, p.team) + '"></i><span>' + u.esc(p.name)
          + '<small>' + u.esc(p.team + ' · ' + (p.matchup || '') + ' · ' + u.fmtTime(p.rows[0].start)) + '</small></span><em>' + (ms.length ? u.esc(ms.slice(0, 2).join(', ')) : p.rows.length + ' lines') + '</em></button>';
      }).join('') : '<button type="button" disabled><span>No player on today\'s Onyx board matches</span></button>';
      ac.classList.add('on');
    }
    root.addEventListener('input', function (e) { if (e.target.id === 'cmpQ') acDraw(e.target.value); });
    root.addEventListener('keydown', function (e) {
      if (e.target.id !== 'cmpQ') return;
      var bs = root.querySelectorAll('#cmpAc button[data-add]');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % Math.max(1, bs.length); Array.prototype.forEach.call(bs, function (b, i) { b.classList.toggle('hi', i === acIdx); }); }
      else if (e.key === 'Enter' && bs[acIdx]) { e.preventDefault(); e.target.value = ''; addKey(bs[acIdx].dataset.add); }
      else if (e.key === 'Escape') acDraw('');
    });
    document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.cmp-find')) { var ac = document.getElementById('cmpAc'); if (ac) ac.classList.remove('on'); } });
    root.addEventListener('change', function (e) {
      var g = e.target.getAttribute && e.target.getAttribute('data-g');
      if (g != null) { S.games[+g] = e.target.value; apply(); }
    });
    root.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-mode],[data-add],[data-rm],[data-pair],[data-focus],[data-slip],[data-pick],[data-slipall],[data-clearpick]');
      if (!t) return;
      var d = t.dataset;
      if (d.mode) { S.mode = d.mode; apply(); }
      else if (d.add) { var q = document.getElementById('cmpQ'); if (q) q.value = ''; addKey(d.add); }
      else if (d.rm) { S.keys = S.keys.filter(function (k) { return k !== d.rm; }); apply(); }
      else if (d.pair) { S.keys = d.pair.split('|').map(u.nk).filter(function (k) { return BYK[k]; }); apply(); }
      else if (d.focus) {
        S.focus = d.focus; draw();
        if (t.closest('.cmp-mh')) { var f = document.getElementById('cmpForm'); if (f) f.scrollIntoView({behavior: 'smooth', block: 'start'}); }
      }
      else if (d.slip) { var r = ROWS[d.slip]; if (r && window.OnyxParlay) { OnyxParlay.add(Object.assign({sport: 'nfl'}, r)); draw(); } }
      else if (d.pick) { var r2 = ROWS[d.pick]; if (S.picked[d.pick]) delete S.picked[d.pick]; else if (r2) S.picked[d.pick] = r2; draw(); }
      else if (d.slipall) { if (window.OnyxParlay) Object.keys(S.picked).forEach(function (k) { if (!onSlip(k)) OnyxParlay.add(Object.assign({sport: 'nfl'}, S.picked[k])); }); draw(); }
      else if (d.clearpick) { S.picked = {}; draw(); }
    });
    window.addEventListener('onyx-slip', function () { if (root.isConnected) Array.prototype.forEach.call(root.querySelectorAll('[data-slip]'), function (b) { var on = onSlip(b.dataset.slip); b.classList.toggle('on', on); b.textContent = on ? 'On slip' : '+ Slip'; }); });
    window.addEventListener('resize', setTop);

    // first load: the deep link, else the two top receivers in today's biggest game
    var d0 = defaults(1)[0] || [];
    S.keys = d0.map(u.nk).filter(function (k) { return BYK[k]; });
    S.games = defaultGames();
    readLink();
    setTop();
    apply();

    Studio.checks.compare = function () {
      var n = pv.querySelectorAll('.cmp-head .cmp-pc .cmp-x').length, m = pv.querySelectorAll('.cmp-m[data-shared="1"]').length;
      if (n < 2) return 'only ' + n + ' player(s) rendered';
      if (!m) return 'no shared market row for the players shown';
      return '';
    };
    return {show: function () {
      var before = S.keys.join('|') + S.mode + S.games.join('|');
      readLink(); setTop();
      if (S.keys.join('|') + S.mode + S.games.join('|') !== before) apply(); else writeLink();
    }};
  }});
})();
