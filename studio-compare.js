// studio-compare.js - Studio "Compare" (11/15 NFL, Jordan: "player & odds comparison tool"; every sport 11/16). Side by
// side, market by market: Onyx's line and price, the model's projection, chance, fair odds and edge, recent form, the
// matchup, and a "better bet by the model" verdict built from the model's EV at Onyx's price (never called a pick).
//   Player-prop sports (NFL, college football, NBA): two or three players, each sport's own markets; recent form from
//   that sport's data/<sport>/player_games.json (NFL / college rows, the NBA's per-player game lists).
//   Game-line sports (college basketball, NHL, tennis): two or three teams (tennis: players), each one's game today at
//   Onyx's prices against the model's chance, and recent results (the team card's last games; tennis: the player's
//   matches in data/tennis/results.json, with the Elo rating).
//   Every sport: a second mode compares two games (spread, total, moneyline at Onyx prices against the model).
// Every price opens Onyx; "+ Slip" puts the leg on the shared parlay slip (parlay.js), and selected rows go out as one
// Onyx link.
// Deep links: #compare?p=Name1|Name2[|Name3]   #compare?mode=teams&t=A|B   #compare?mode=games&g=gid1|gid2
(function () {
  'use strict';
  if (!window.Studio) return;

  var FOOT = {
    MK: {rec: 'Receptions', rec_yds: 'Receiving yards', rush_yds: 'Rushing yards', rush_rec_yds: 'Rush + rec yards',
         pass_yds: 'Passing yards', pass_att: 'Pass attempts', pass_td: 'Passing TDs', pass_rush_yds: 'Pass + rush yards',
         anytime_td: 'Anytime TD', two_td: '2+ TDs', three_td: '3+ TDs', first_td: 'First TD'},
    ORDER: ['rec', 'rec_yds', 'rush_yds', 'rush_rec_yds', 'pass_yds', 'pass_att', 'pass_td', 'pass_rush_yds', 'anytime_td', 'two_td', 'three_td', 'first_td'],
    PREF: [['rec_yds', 'WR/TE'], ['rush_yds', 'RB'], ['rec_yds', null], ['pass_yds', null]]
  };
  var HOOP = {
    MK: {pts: 'Points', reb: 'Rebounds', ast: 'Assists', threes: '3-pointers made', pra: 'Pts + reb + ast', pr: 'Pts + reb', pa: 'Pts + ast',
         dbl_dbl: 'Double-double', trp_dbl: 'Triple-double', first_basket: 'First basket'},
    ORDER: ['pts', 'reb', 'ast', 'threes', 'pra', 'pr', 'pa', 'dbl_dbl', 'trp_dbl', 'first_basket'],
    PREF: [['pts', null], ['reb', null], ['ast', null], ['threes', null]]
  };
  var CFB_PREF = [['rec_yds', null], ['rush_yds', null], ['pass_yds', null], ['rec', null], ['anytime_td', null]];
  var YES = {anytime_td: 1, two_td: 1, three_td: 1, first_td: 1, dbl_dbl: 1, trp_dbl: 1, first_basket: 1};   // yes / no markets
  var NOFORM = {first_td: 1, first_basket: 1};
  var HS = {nfl: 'nfl', cfb: 'college-football', nba: 'nba'};
  var GL = {_: {spread: 'Spread', total: 'Total', ml: 'Moneyline', unit: 'points', side: 'team', sides: 'teams'},
            nhl: {spread: 'Puck line', total: 'Total goals', ml: 'Moneyline', unit: 'goals', side: 'team', sides: 'teams'},
            tennis: {spread: 'Game spread', total: 'Total games', ml: 'Match winner', unit: 'games', side: 'player', sides: 'players'}};
  var TINT = ['#b038f9', '#7aa2ff', '#d795ff'];

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
    '@media (min-width:760px){.cmp-st{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));column-gap:22px}.cmp-acts{max-width:340px}.cmp-cell{padding:10px 12px}.cmp-kv{font-size:12.5px}.cmp-pc b{font-size:16px}.cmp-sd{font-size:14px}}',
    '.cmp-gh .tm span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.cmp-mg{position:relative;height:56px;display:flex;gap:3px;margin:4px 0 6px}',
    '.cmp-mg:before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid rgba(255,255,255,.18)}',
    '.cmp-mg>i{flex:1;min-width:0;position:relative}',
    '.cmp-mg s{position:absolute;left:0;right:0;border-radius:3px;text-decoration:none}.cmp-mg s.w{background:linear-gradient(var(--grn),rgba(97,233,112,.5))}.cmp-mg s.l{background:linear-gradient(rgba(255,138,138,.5),var(--red))}',
    '.cmp-rl{font:600 11px monospace;line-height:1.7;color:#fff}.cmp-rl div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cmp-rl em{font-style:normal;color:var(--mute)}'
  ].join('\n');

  Studio.register('compare', {title: 'Compare', order: 1, mount: function (el, D, u) {
    if (!document.getElementById('sx-compare-css')) { var st = document.createElement('style'); st.id = 'sx-compare-css'; st.textContent = CSS; document.head.appendChild(st); }

    var SP = D.sport, TEN = SP === 'tennis', CFG = SP === 'nba' ? HOOP : FOOT, MK = CFG.MK, ORDER = CFG.ORDER, PREF = SP === 'cfb' ? CFB_PREF : CFG.PREF;
    var W = GL[SP] || GL._;
    var PLAYERS = D.players().map(function (p) { return Object.assign({}, p, {rows: p.rows.filter(function (r) { return MK[r.mkt]; })}); }).filter(function (p) { return p.rows.length; });
    var HAS_P = PLAYERS.length >= 2, BYK = {};
    PLAYERS.forEach(function (p) { BYK[u.nk(p.name)] = p; });
    var CARD = {}, CST = {}, HIST = null, HIST_P = null, PRE = {}, NBAP = {}, RES = null, ELO = null, EXTRA_P = null;
    var S = {mode: HAS_P ? 'players' : 'teams', keys: [], tkeys: [], focus: null, games: [], picked: {}};
    var sign = function (x, d) { var t = Math.abs(x).toFixed(d == null ? 1 : d); return (+t === 0 ? '' : x > 0 ? '+' : '-') + t; };
    var num = function (x) { return x == null || isNaN(x) ? '-' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1); };
    function getJSON(p) { return fetch(p + (p.indexOf('?') < 0 ? '?' : '&') + 'v=' + Math.floor(Date.now() / 60000)).then(function (r) { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); }); }

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
    function tint(c, i) { return c === '#b038f9' ? TINT[i % TINT.length] : c; }   // teams with no color on file: one tint per column
    function lines(gid) {
      var rows = D.playsFor(gid), o = {spread: [], total: [], ml: [], model: null};
      rows.forEach(function (r) {
        if (r.kind === 'spread' || r.kind === 'total' || r.kind === 'ml') o[r.kind].push(r);
        var m = r.why && /model (\S+) ([\d.]+) (\S+) ([\d.]+)/.exec(r.why);
        if (m && !o.model) { o.model = {}; o.model[m[1]] = +m[2]; o.model[m[3]] = +m[4]; }
      });
      var tot = o.total[0] ? o.total[0].line : null;
      o.totalLine = tot;
      o.implied = function (team) {
        var s = o.spread.filter(function (r) { return r.who === team; })[0], sgn = 1;
        if (!s) { s = o.spread[0]; sgn = -1; }      // the board carries one side: the other is its mirror
        return tot != null && s && s.hcap != null ? (tot - sgn * s.hcap) / 2 : null;
      };
      return o;
    }
    function pidOf(rows) { var r = rows.filter(function (x) { return x.who && x.who !== x.name; })[0]; return r ? r.who : null; }
    function info(p) {
      var r0 = p.rows[0], g = gameOf(r0.gid), opp = g ? (r0.team === g.home ? g.away : g.home) : null, pid = pidOf(p.rows);
      var has = function (m) { return p.rows.some(function (r) { return r.mkt === m; }); };
      var pos = SP === 'nba' ? ((NBAP[pid] || {}).pos || '')
        : has('pass_yds') || has('pass_att') ? 'QB' : p.role === 'RB' ? 'RB' : p.role === 'WR/TE' ? 'WR/TE' : has('rush_yds') && !has('rec') ? 'RB' : has('rec') ? 'WR/TE' : '';
      return {key: u.nk(p.name), name: p.name, team: r0.team, gid: r0.gid, game: g, opp: opp, home: g ? r0.team === g.home : null,
              start: r0.start, pid: pid, pos: pos, rows: p.rows, color: teamColor(r0.gid, r0.team)};
    }
    function headshot(P) {
      if (SP === 'nba') { var h = (NBAP[P.pid] || {}).hs; return h ? 'https://a.espncdn.com/i/headshots/nba/players/full/' + h + '.png' : null; }
      return P.pid && /^\d+$/.test(P.pid) && HS[SP] ? 'https://a.espncdn.com/i/headshots/' + HS[SP] + '/players/full/' + P.pid + '.png' : null;
    }
    function rowOf(P, m) { return P.rows.filter(function (r) { return r.mkt === m; })[0] || null; }
    // the other side of a two-way prop, from the team card's Onyx prices (cards carry both sides; the board only the better one)
    function altOf(row) {
      var c = CARD[row.team]; if (!c || !c.players || YES[row.mkt]) return null;
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
      if (r.kind === 'ml') return (r.who || r.name) + (TEN ? ' to win' : ' ML');
      if (r.kind === 'spread') return r.who + ' ' + (r.hcap > 0 ? '+' : '') + r.hcap + (TEN ? ' games' : '');
      if (r.kind === 'total') return (r.side === 'over' ? 'Over ' : 'Under ') + r.line + (TEN ? ' games' : '');
      if (r.mkt === 'anytime_td') return 'Anytime TD';
      if (YES[r.mkt]) return MK[r.mkt];
      return (r.side === 'over' ? 'Over ' : 'Under ') + r.line;
    }
    function shortName(n) { var a = String(n).split(' '); return a.length > 1 ? a[0][0] + '. ' + a.slice(1).join(' ').replace(/ (Jr\.|Sr\.|II|III|IV)$/, '') : n; }
    function teamShort(k) { return TEN ? shortName(k) : k; }

    // game logs: NFL / college football rows (D.history()), the NBA's per-player lists (player_games.json {pid: {g: [...]}})
    function stat(g, m) {
      var z = function (k) { return g[k] || 0; };
      if (SP === 'nba') {
        switch (m) {
          case 'pts': case 'reb': case 'ast': case 'threes': return z(m);
          case 'pra': return z('pts') + z('reb') + z('ast');
          case 'pr': return z('pts') + z('reb');
          case 'pa': return z('pts') + z('ast');
          case 'dbl_dbl': case 'trp_dbl': var c = [z('pts'), z('reb'), z('ast')].filter(function (v) { return v >= 10; }).length; return c >= (m === 'dbl_dbl' ? 2 : 3) ? 1 : 0;
        }
        return null;
      }
      var passing = (g.cats || []).indexOf('passing') >= 0;
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
      if (HIST_P) return HIST_P;
      if (SP === 'nba') HIST_P = getJSON(D.dir + 'player_games.json').then(function (j) {
        var o = {};
        Object.keys(j || {}).forEach(function (pid) {
          var g = (j[pid] || {}).g; if (pid.charAt(0) === '_' || !g || !g.length) return;
          o[pid] = g.filter(function (x) { return x[4] > 0; }).map(function (x) { return {date: x[0], opp: x[2], home: !!x[3], min: x[4], pts: x[5], reb: x[6], ast: x[7], threes: x[8]}; })
            .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        });
        HIST = o; draw();
      }).catch(function () { HIST = {}; draw(); });
      else HIST_P = D.history().then(function (rows) {
        var o = {}; rows.forEach(function (r) { if (r.pid) (o[r.pid] = o[r.pid] || []).push(r); });
        Object.keys(o).forEach(function (k) { o[k].sort(function (a, b) { return a.date < b.date ? 1 : -1; }); });
        HIST = o; draw();
      });
      return HIST_P;
    }
    function loadCards(teams) {
      if (TEN) return;
      var need = teams.filter(function (t) { return t && !(t in CARD); });
      if (!need.length) return;
      need.forEach(function (t) { CARD[t] = null; CST[t] = 'load'; });
      Promise.all(need.map(function (t) { return D.card(t).then(function (c) { CARD[t] = c; CST[t] = c ? 'ok' : 'fail'; }); })).then(draw);
    }
    // per sport, once: Onyx's pregame prices on both sides (game-line sports), NBA headshots and positions, tennis results and Elo
    function loadExtra() {
      if (EXTRA_P) return EXTRA_P;
      var jobs = [];
      if (!HAS_P) jobs.push(getJSON(D.dir + 'pregame.json').then(function (j) { PRE = j || {}; }).catch(function () {}));
      if (SP === 'nba') jobs.push(getJSON(D.dir + 'slate.json').then(function (j) { (j.players || []).forEach(function (p) { NBAP[p.pid] = {hs: p.hs, pos: p.pos}; }); }).catch(function () {}));
      if (TEN) jobs.push(getJSON(D.dir + 'results.json').then(function (j) { RES = j.matches || []; }).catch(function () { RES = []; }),
                         getJSON(D.dir + 'elo.json').then(function (j) { ELO = (j && j.r) || {}; }).catch(function () { ELO = {}; }));
      EXTRA_P = Promise.all(jobs).then(draw);
      return EXTRA_P;
    }

    // ── value ──────────────────────────────────────────────────────────────
    function best(rows) {   // the side the model rates best by EV at Onyx's price; null when the model has no read
      var r = rows.filter(function (x) { return x && !x.no_read && x.ev != null; });
      return r.sort(function (a, b) { return b.ev - a.ev; })[0] || null;
    }
    function evTxt(x) { return sign(100 * x, 1) + '%'; }
    function verdict(sets) {
      // sets: [{name, rows:[sides]}]
      var ok = sets.map(function (s) { return {name: s.name, rows: (s.rows || []).filter(Boolean), b: best(s.rows)}; });
      var read = ok.filter(function (x) { return x.b; });
      if (!read.length) return 'No model read at an Onyx price on ' + (sets.length > 2 ? 'any of these' : 'either') + ', so the model has no verdict here.';
      read.sort(function (a, b) { return b.b.ev - a.b.ev; });
      var top = read[0], rest = read.slice(1), nr = ok.filter(function (x) { return !x.b; });
      var nm = function (x) { return (x.name ? x.name + ' ' : '') + sideTxt(x.b); };
      var what = function (x) { return '<b>' + u.esc(nm(x)) + '</b> (' + evTxt(x.b.ev) + ' EV at Onyx ' + u.odds(x.b.price) + ')'; };
      var s;
      if (top.b.ev > 0) s = 'Better bet by the model: ' + what(top) + (rest.length ? ', ahead of ' + rest.map(function (x) { return u.esc(nm(x)) + ' ' + evTxt(x.b.ev); }).join(', ') : '') + '.';
      else s = 'Neither is a value at Onyx\'s prices. ' + (rest.length ? 'The model rates ' + what(top) + ' closest; ' + rest.map(function (x) { return u.esc(nm(x)) + ' ' + evTxt(x.b.ev); }).join(', ') + '.' : 'Best side: ' + what(top) + '.');
      if (nr.length) s += ' ' + nr.map(function (x) { return u.esc((x.name || (x.rows[0] ? sideTxt(x.rows[0]) : '')).replace(/:$/, '')); }).join(', ') + ': no model read at an Onyx price.';
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
      var chip = r.sel ? u.onyxBtn(r, 'Onyx ' + u.odds(r.price))
        : '<span class="sx-chip">' + u.esc(r.price != null ? 'Onyx ' + u.odds(r.price) : 'Onyx prices ' + teamShort(r._opp || 'the other side')) + '</span>';
      h += '<div class="cmp-sd">' + u.esc(sideTxt(r)) + '</div>' + chip;
      if (r.kind === 'prop' && r.proj != null && !YES[r.mkt]) {
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

    // ── players view (player-prop sports) ──────────────────────────────────
    function sel() { return S.keys.map(function (k) { return BYK[k]; }).filter(Boolean).map(info); }
    function cols(n) { return 'grid-template-columns:repeat(' + n + ',minmax(0,1fr))'; }
    function shared(Ps) { return ORDER.filter(function (m) { return Ps.every(function (P) { return rowOf(P, m); }); }); }
    function ini(n) { return String(n).split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2); }

    function headCards(Ps) {
      return '<div class="cmp-head" style="' + cols(Math.max(2, Ps.length)) + '">' + Ps.map(function (P) {
        var img = headshot(P);
        return '<div class="cmp-pc" style="--tc:' + P.color + '"><button type="button" class="cmp-x" data-rm="' + u.esc(P.key) + '" aria-label="Remove ' + u.esc(P.name) + '">×</button>'
          + '<span class="cmp-av">' + u.esc(ini(P.name)) + (img ? '<img alt="" loading="lazy" src="' + u.esc(img) + '" onerror="this.remove()">' : '') + '</span>'
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
          + (mod != null ? '<div><span>' + (n3 ? 'Model' : u.esc(P.team) + ' model score') + '</span><b>' + num(mod) + '</b></div>' : '')
          + '<div><span>' + (n3 ? 'D L5' : u.esc(P.opp || 'Opp') + ' allows, L5') + '</span><b>' + (oc ? num(pa5) : CST[P.opp] === 'load' ? '...' : '-') + '</b></div>'
          + '<div><span>' + (n3 ? 'D year' : u.esc(P.opp || 'Opp') + ' allows, season') + '</span><b>' + (oc ? num(paS) : '-') + '</b></div></div>';
      }).join('') + '</div>';
    }
    function l8(P, r) {
      if (!HIST || NOFORM[r.mkt]) return '';
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
        + (!NOFORM[m] ? '<button type="button" data-focus="' + m + '" class="' + (S.focus === m ? 'on' : '') + '">Form</button>' : '') + '</div>'
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
      var fm = ms.filter(function (m) { return !NOFORM[m]; });
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
        return '<div class="cmp-fc" style="--tc:' + P.color + '"><b>' + u.esc(P.name) + '</b><small>' + (YES[S.focus] ? 'Hit' : 'Over ' + line) + ' in <span class="' + (hit / L.length >= .5 ? 'sx-pos' : 'sx-neg') + '">' + hit + ' of ' + L.length + '</span>' + (YES[S.focus] ? '' : ' · avg ' + num(avg)) + '</small>'
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
    function findBox(ph, dis, lab) {
      return '<div class="cmp-find"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'
        + '<input class="sx-in" id="cmpQ" type="search" autocomplete="off" placeholder="' + u.esc(ph) + '"' + (dis ? ' disabled' : '') + ' aria-label="' + u.esc(lab) + '">'
        + '<div class="cmp-ac" id="cmpAc"></div></div>';
    }
    function playersHTML() {
      var Ps = sel();
      var h = findBox(Ps.length >= 3 ? 'Three players max: remove one to add' : 'Add a player: name or team', Ps.length >= 3, 'Search players') + '<div class="cmp-sug">' + suggestions() + '</div>';
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

    // ── teams view (game-line sports: college basketball, NHL; tennis compares players) ──
    var TEAMS = (function () {
      var out = {}, gs = D.games.filter(function (g) { return D.playsFor(g.gid).length; })
        .sort(function (a, b) { return ((a.state === 'pre' ? 0 : 1) - (b.state === 'pre' ? 0 : 1)) || (Date.parse(a.start) - Date.parse(b.start)); });
      gs.forEach(function (g) {
        [['away', g.away, g.home], ['home', g.home, g.away]].forEach(function (x) {
          if (!x[1] || out[x[1]]) return;
          out[x[1]] = {key: x[1], full: g[x[0] + '_name'] || x[1], gid: g.gid, game: g, opp: x[2], home: x[0] === 'home', start: g.start, color: color(g[x[0] + '_color'])};
        });
      });
      return out;
    })();
    var TK = Object.keys(TEAMS);
    function tsel() { return S.tkeys.map(function (k, i) { var T = TEAMS[k]; return T ? Object.assign({}, T, {color: tint(T.color, i)}) : null; }).filter(Boolean); }
    // a team's side of its game's market: the board row when it is this side, else the mirror of the side the board carries
    function teamSide(T, kind) {
      var rows = D.playsFor(T.gid).filter(function (r) { return r.kind === kind; });
      if (kind === 'total') return rows[0] || null;
      var mine = rows.filter(function (r) { return r.who === T.key; })[0]; if (mine) return mine;
      var o = rows[0]; if (!o || o.conf == null) return null;
      var pg = PRE[T.gid] || {}, price = kind === 'ml' ? (pg.ml || {})[T.key] : null;
      var d = {kind: kind, mkt: kind, who: T.key, name: T.key, gid: T.gid, matchup: o.matchup, start: o.start, conf: 1 - o.conf, no_read: o.no_read,
               price: price != null ? price : null, sel: null, _derived: true, _opp: o.who};
      if (kind === 'spread') d.hcap = o.hcap != null ? -o.hcap : null;
      if (price != null) { d.edge = d.conf - u.imp(price); d.ev = d.conf * u.dec(price) - 1; }
      return d;
    }
    function winChance(T) { var r = teamSide(T, 'ml'); return r && !r.no_read ? r.conf : null; }
    function recOf(T) {
      if (TEN) {
        var ms = (RES || []).filter(function (m) { return m.w === T.key || m.l === T.key; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        return ms.map(function (m) { var w = m.w === T.key; return {d: m.date, opp: w ? m.l : m.w, r: w ? 'W' : 'L', pf: w ? m.games_w : m.games_l, pa: w ? m.games_l : m.games_w, sets: w ? m.sets_w + '-' + m.sets_l : m.sets_l + '-' + m.sets_w, ev: m.event}; });
      }
      var c = CARD[T.key]; return c && c.team ? (c.team.recent || []) : null;
    }
    function eloOf(T) { if (!ELO) return null; var k = String(T.key).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim(); return ELO[k] || null; }
    function teamHead(Ts) {
      return '<div class="cmp-head" style="' + cols(Math.max(2, Ts.length)) + '">' + Ts.map(function (T) {
        var c = CARD[T.key], rec = c && c.team && c.team.rec ? c.team.rec.w + '-' + c.team.rec.l + (c.team.rec.otl ? '-' + c.team.rec.otl : '') : null;
        var sub = TEN ? [T.game.event, T.game.round].filter(Boolean).join(' · ') : [rec, (T.home ? 'vs ' : '@ ') + T.opp].filter(Boolean).join(' · ');
        return '<div class="cmp-pc" style="--tc:' + T.color + '"><button type="button" class="cmp-x" data-rmt="' + u.esc(T.key) + '" aria-label="Remove ' + u.esc(T.key) + '">×</button>'
          + '<span class="cmp-av">' + u.esc(TEN ? ini(T.key) : String(T.key).slice(0, 3)) + '</span>'
          + '<b><span class="cmp-full">' + u.esc(TEN ? T.key : T.full) + '</span><span class="cmp-short">' + u.esc(TEN ? T.key.split(' ').slice(-1)[0] : T.key) + '</span></b><small>' + u.esc(sub) + '</small></div>';
      }).join('') + (Ts.length < 2 ? '<div class="cmp-pc" style="--tc:#3a2a55"><b>Add a ' + W.side + '</b><small>search above</small></div>' : '') + '</div>';
    }
    function teamCtx(Ts) {
      var n3 = Ts.length > 2;
      return '<div class="cmp-ctx" style="' + cols(Ts.length) + '">' + Ts.map(function (T) {
        var L = lines(T.gid), mod = L.model && L.model[T.key], wc = winChance(T), e = TEN ? eloOf(T) : null, c = CARD[T.key], s0 = c && c.team && c.team.seasons ? c.team.seasons[0] : null;
        return '<div class="cmp-ci" style="--tc:' + T.color + '">'
          + '<div><span>' + (TEN ? 'vs ' : T.home ? 'vs ' : '@ ') + u.esc(teamShort(T.opp || '')) + '</span><b>' + u.esc(u.fmtTime(T.start)) + '</b></div>'
          + '<div><span>' + (n3 ? 'Win' : 'Model win chance') + '</span><b>' + (wc == null ? '-' : u.pct(wc)) + '</b></div>'
          + (mod != null ? '<div><span>' + (n3 ? 'Model' : 'Model ' + W.unit) + '</span><b>' + num(mod) + '</b></div>' : '')
          + (!TEN && SP !== 'nhl' ? '<div><span>' + (n3 ? 'Implied' : 'Onyx implied ' + W.unit) + '</span><b>' + num(L.implied(T.key)) + '</b></div>' : '')
          + (s0 ? '<div><span>' + (n3 ? 'For / vs' : 'Scores / allows, season') + '</span><b>' + num(s0.pf) + ' / ' + num(s0.pa) + '</b></div>' : '')
          + (TEN ? '<div><span>Elo rating</span><b>' + (e ? Math.round(e[0]) : ELO ? '-' : '...') + '</b></div>' : '')
          + '</div>';
      }).join('') + '</div>';
    }
    function teamMarket(Ts, kind, label, i) {
      var cells = Ts.map(function (T) { return {T: T, r: teamSide(T, kind)}; });
      var one = kind === 'total' && cells.length > 1 && cells.every(function (c) { return c.T.gid === cells[0].T.gid; });   // one game: one total
      var bestAll = best(cells.map(function (c) { return c.r; })), likeSel = bestAll && bestAll.ev > 0 ? bestAll.sel : null;
      var both = cells.map(function (c) { return c.r && c.r.sel; }).filter(function (s, j, a) { return s && a.indexOf(s) === j; });
      if (cells.some(function (c, j) { return cells.some(function (d, k) { return k !== j && d.T.gid === c.T.gid; }); })) both = [];   // opposite sides of one game: never both
      var cell = function (c, span) {
        if (!c.r) return '<div class="cmp-cell none"' + (span ? ' style="grid-column:1/-1"' : '') + '>No Onyx ' + label.toLowerCase() + '</div>';
        var like = likeSel && c.r.sel === likeSel;
        return '<div class="cmp-cell' + (like ? ' likes' : '') + '" style="--tc:' + c.T.color + (span ? ';grid-column:1/-1' : '') + '">' + sideHTML(c.r, like, Ts.length > 2)
          + (c.r._derived ? '<div class="cmp-l8">Onyx\'s board side is ' + u.esc(teamShort(c.r._opp)) + '; this is its mirror</div>' : '') + '</div>';
      };
      return '<div class="cmp-m" data-m="' + kind + '" data-shared="1" style="animation-delay:' + i * 50 + 'ms"><div class="cmp-mh"><b>' + u.esc(label) + '</b></div>'
        + '<div class="cmp-cols" style="' + cols(Ts.length) + '">' + (one ? cell(cells[0], true) : cells.map(function (c) { return cell(c); }).join('')) + '</div>'
        + '<div class="cmp-v"><p>' + verdict(one ? [{name: Ts.map(function (T) { return teamShort(T.key); }).join(' vs ') + ':', rows: [cells[0].r]}] : cells.map(function (c) { return {name: kind === 'total' ? teamShort(c.T.key) + ':' : '', rows: [c.r]}; })) + '</p>'
        + (both.length > 1 ? '<a class="sx-chip onyx" target="_blank" rel="noopener" href="' + u.esc(u.onyx(both, 'compare_both')) + '">Bet ' + (both.length === 2 ? 'both' : 'all') + '</a>' : '') + '</div></div>';
    }
    function formTeams(Ts) {
      var h = '<div class="cmp-sec"><h3>Recent results</h3><span>' + (TEN ? 'last 8 matches · bars = games won minus lost' : 'last 8 games · bars = margin') + '</span></div>';
      return h + '<div class="cmp-form" style="' + cols(Ts.length) + '">' + Ts.map(function (T) {
        var R = recOf(T);
        if (R == null) return '<div class="cmp-fc" style="--tc:' + T.color + '"><b>' + u.esc(T.key) + '</b><small>' + ((TEN ? !RES : CST[T.key] === 'load') ? 'Loading' : 'no results on file') + '</small></div>';
        if (!R.length) return '<div class="cmp-fc" style="--tc:' + T.color + '"><b>' + u.esc(T.key) + '</b><small>no results on file yet</small></div>';
        var L = R.slice(0, 8).reverse(), w = R.slice(0, 10).filter(function (g) { return g.r === 'W'; }).length, n = Math.min(10, R.length);
        var mx = Math.max(1, Math.max.apply(null, L.map(function (g) { return Math.abs((g.pf || 0) - (g.pa || 0)); })));
        var c = CARD[T.key], rc = c && c.team && c.team.rec, ats = rc && rc.ats ? rc.ats[0] + '-' + rc.ats[1] : null, ou = rc && rc.ou ? rc.ou[0] + '-' + rc.ou[1] : null;
        return '<div class="cmp-fc" style="--tc:' + T.color + '"><b>' + u.esc(TEN ? T.key : T.full) + '</b><small>Won <span class="' + (w / n >= .5 ? 'sx-pos' : 'sx-neg') + '">' + w + ' of ' + n + '</span>' + (ats ? ' · ATS ' + ats : '') + (ou ? ' · O/U ' + ou : '') + '</small>'
          + '<div class="cmp-mg">' + L.map(function (g) {
            var m = (g.pf || 0) - (g.pa || 0), hh = Math.max(4, 50 * Math.abs(m) / mx);
            return '<i title="' + u.esc(g.d + ' ' + g.r + ' ' + g.pf + '-' + g.pa + ' vs ' + g.opp) + '"><s class="' + (g.r === 'W' ? 'w' : 'l') + '" style="height:' + hh.toFixed(1) + '%;' + (m >= 0 ? 'bottom:50%' : 'top:50%') + '"></s></i>';
          }).join('') + '</div>'
          + '<div class="cmp-rl">' + R.slice(0, 5).map(function (g) {
            return '<div><span class="' + (g.r === 'W' ? 'sx-pos' : 'sx-neg') + '">' + u.esc(g.r) + '</span> ' + (TEN ? u.esc(g.sets) + ' · ' + num(g.pf).replace(/\.0$/, '') + '-' + num(g.pa).replace(/\.0$/, '') + ' games'
              : num(g.pf).replace(/\.0$/, '') + '-' + num(g.pa).replace(/\.0$/, '')) + ' <em>' + (TEN ? 'vs ' : g.ha === 'A' ? '@ ' : 'vs ') + u.esc(TEN ? shortName(g.opp) : g.opp) + '</em>'
              + (!TEN && g.cov ? ' <em>' + (g.cov === 'W' ? 'covered' : g.cov === 'L' ? 'no cover' : 'push') + (g.ou ? ', ' + (g.ou === 'O' ? 'over' : g.ou === 'U' ? 'under' : 'push') : '') + '</em>' : '') + '</div>';
          }).join('') + '</div></div>';
      }).join('') + '</div>';
    }
    function teamSugs() {
      return teamDefaults(3).map(function (pair) { return '<button type="button" data-tpair="' + u.esc(pair.join('|')) + '">' + u.esc(pair.map(teamShort).join(' vs ')) + '</button>'; }).join('');
    }
    function teamsHTML() {
      var Ts = tsel();
      var h = findBox(Ts.length >= 3 ? 'Three max: remove one to add' : 'Add a ' + W.side + ': ' + (TEN ? 'name' : 'name or abbreviation'), Ts.length >= 3, 'Search ' + W.sides) + '<div class="cmp-sug">' + teamSugs() + '</div>';
      h += '<div class="cmp-stick">' + teamHead(Ts) + pickBar() + '</div>';
      if (Ts.length < 2) return h + '<p class="sx-sub">Pick at least two ' + W.sides + ' to compare them.</p>';
      h += teamCtx(Ts);
      h += '<div class="cmp-sec"><h3>Their games today</h3><span>Onyx\'s prices against the model\'s chance</span></div>';
      h += [['ml', W.ml], ['spread', W.spread], ['total', W.total]].map(function (k, i) { return teamMarket(Ts, k[0], k[1], i); }).join('');
      h += formTeams(Ts);
      h += '<p class="cmp-note">Chances, fair odds and edges are the model\'s projections against Onyx\'s prices, never Onyx Picks. Onyx\'s board carries one side of each market; the other side is shown as its mirror (the rest of the chance), with Onyx\'s price when it is on file.' + (TEN ? ' Recent matches and Elo ratings come from this site\'s tennis results.' : '') + '</p>';
      return h;
    }

    // ── games view ─────────────────────────────────────────────────────────
    function vs(g) { return g.tennis ? g.away + ' vs ' + g.home : g.away + ' @ ' + g.home; }
    function gameOpt(g) { var L = lines(g.gid); return vs(g) + ' · ' + u.fmtTime(g.start) + (L.totalLine != null ? ' · ' + W.total.toLowerCase() + ' ' + L.totalLine : ''); }
    function gameHead(g) {
      var L = lines(g.gid), ca = color(g.away_color), ch = color(g.home_color);
      if (ca === ch) ch = TINT[1];
      var row = function (t, c) { return '<div class="tm"><span><i style="background:' + c + '"></i>' + u.esc(teamShort(t)) + '</span><em>' + (L.model && L.model[t] != null ? num(L.model[t]) : '-') + '</em></div>'; };
      return '<div class="cmp-gh"><div class="cmp-gstripe" style="background:linear-gradient(90deg,' + ca + ',' + ch + ')"></div>'
        + row(g.away, ca) + row(g.home, ch)
        + '<small>' + (L.model ? 'model ' + W.unit + ' · ' : '') + u.esc(u.fmtTime(g.start)) + '</small>'
        + (TEN || SP === 'nhl' ? '<small>' + u.esc(TEN ? [g.event, g.round].filter(Boolean).join(' · ') : (L.totalLine != null ? 'Onyx total ' + L.totalLine : '')) + '</small>'
          : '<small>Onyx implied ' + u.esc(g.away) + ' ' + num(L.implied(g.away)) + ' · ' + u.esc(g.home) + ' ' + num(L.implied(g.home)) + '</small>') + '</div>';
    }
    function gameProj(g, L, kind) {
      if (!L.model || L.model[g.away] == null || L.model[g.home] == null) return '';
      var a = L.model[g.away], hm = L.model[g.home];
      if (kind === 'spread') { var fav = a >= hm ? g.away : g.home; return 'Model: ' + fav + ' by ' + Math.abs(a - hm).toFixed(1); }
      if (kind === 'total') return 'Model total ' + (a + hm).toFixed(1) + (L.totalLine != null ? ' vs ' + L.totalLine : '');
      return 'Model score ' + g.away + ' ' + a.toFixed(1) + ', ' + g.home + ' ' + hm.toFixed(1);
    }
    function boardGames() {
      var pre = (D.pre.length ? D.pre : D.games).filter(function (g) { return D.playsFor(g.gid).length; });
      return pre.length ? pre : D.games.filter(function (g) { return D.playsFor(g.gid).length; });
    }
    function gamesHTML() {
      var gs = S.games.map(gameOf).filter(Boolean), pre = boardGames();
      var opts = function (cur) { return pre.map(function (g) { return '<option value="' + u.esc(g.gid) + '"' + (g.gid === cur ? ' selected' : '') + '>' + u.esc(gameOpt(g)) + '</option>'; }).join(''); };
      var h = '<div class="cmp-gsel"><select class="sx-sel" data-g="0" aria-label="First game">' + opts(S.games[0]) + '</select><select class="sx-sel" data-g="1" aria-label="Second game">' + opts(S.games[1]) + '</select></div>';
      if (gs.length < 2) return h + '<p class="sx-sub">Not enough games on the board to compare.</p>';
      h += '<div class="cmp-stick"><div class="cmp-head" style="' + cols(2) + '">' + gs.map(gameHead).join('') + '</div>' + pickBar() + '</div>';
      [['spread', W.spread], ['total', W.total], ['ml', W.ml]].forEach(function (k, i) {
        var per = gs.map(function (g) { var L = lines(g.gid); return {g: g, L: L, rows: L[k[0]].slice().sort(function (a, b) { return k[0] === 'total' ? (a.side === 'over' ? -1 : 1) : (a.who === g.away ? -1 : 1); })}; });
        var bestAll = best([].concat.apply([], per.map(function (p) { return p.rows; })));
        var likeSel = bestAll && bestAll.ev > 0 ? bestAll.sel : null;
        h += '<div class="cmp-m" data-gm="1" style="animation-delay:' + i * 50 + 'ms"><div class="cmp-mh"><b>' + u.esc(k[1]) + '</b></div><div class="cmp-cols" style="' + cols(2) + '">' + per.map(function (p) {
          if (!p.rows.length) return '<div class="cmp-cell none">No Onyx ' + u.esc(k[1].toLowerCase()) + '</div>';
          var like = p.rows.some(function (r) { return r.sel === likeSel; });
          return '<div class="cmp-cell' + (like ? ' likes' : '') + '" style="--tc:' + color(p.g.home_color) + '"><div class="cmp-l8" style="margin:0 0 6px">' + u.esc(gameProj(p.g, p.L, k[0])) + '</div>'
            + p.rows.map(function (r) { return '<div class="cmp-gside">' + sideHTML(r, r.sel === likeSel, false) + '</div>'; }).join('') + '</div>';
        }).join('') + '</div><div class="cmp-v"><p>' + verdict(per.map(function (p) { return {name: (TEN ? shortName(p.g.away) + ' vs ' + shortName(p.g.home) : vs(p.g)) + ':', rows: p.rows}; })) + '</p></div></div>';
      });
      h += '<p class="cmp-note">' + (TEN ? 'Model chances come from the tennis model (Elo and Onyx\'s match price); ' : 'Model scores come from the model\'s game read; Onyx implied ' + W.unit + ' come from Onyx\'s spread and total. ') + 'Chances and fair odds are projections, never Onyx Picks.</p>';
      return h;
    }

    // ── defaults and deep links ────────────────────────────────────────────
    function totalOf(gid) { var L = lines(gid); return L.totalLine == null ? 0 : L.totalLine; }
    function defaults(n) {
      var pre = D.pre.slice(); if (!pre.length) pre = D.games.slice(); if (!pre.length) return [];
      var first = Math.min.apply(null, pre.map(function (g) { return Date.parse(g.start); }));
      var today = pre.filter(function (g) { return Date.parse(g.start) < first + 20 * 3600e3; });
      today.sort(function (a, b) { return totalOf(b.gid) - totalOf(a.gid); });
      var out = [];
      today.forEach(function (g) {
        if (out.length >= n) return;
        PREF.some(function (mr) {
          var m = mr[0], c = PLAYERS.filter(function (p) { return p.gid === g.gid && (!mr[1] || p.role === mr[1]) && p.rows.some(function (r) { return r.mkt === m; }); });
          // the NBA: the biggest lines (the stars); football: the players with the most markets
          c.sort(SP === 'nba' ? function (a, b) { return (rowOf(b, m).line - rowOf(a, m).line) || (b.rows.length - a.rows.length); }
                              : function (a, b) { return (b.rows.length - a.rows.length) || (rowOf(b, m).line - rowOf(a, m).line); });
          if (c.length < 2) return false;
          var a = c[0], b = c.filter(function (p) { return p.team !== a.team; })[0] || c[1];
          out.push([a.name, b.name]); return true;
        });
      });
      if (!out.length && PLAYERS.length > 1) out.push([PLAYERS[0].name, PLAYERS[1].name]);
      return out;
    }
    function teamDefaults(n) {
      var gs = boardGames().slice().sort(function (a, b) { return (D.playsFor(b.gid).length - D.playsFor(a.gid).length) || (Date.parse(a.start) - Date.parse(b.start)); });
      var out = gs.filter(function (g) { return TEAMS[g.away] && TEAMS[g.home] && TEAMS[g.away].gid === g.gid && TEAMS[g.home].gid === g.gid; }).slice(0, Math.max(1, n - 1)).map(function (g) { return [g.away, g.home]; });
      // and today's two biggest favorites by the model, from different games
      var fav = TK.map(function (k) { return {k: k, w: winChance(TEAMS[k])}; }).filter(function (x) { return x.w != null && x.w < 0.97; }).sort(function (a, b) { return b.w - a.w; });
      if (fav.length > 1 && out.length < n) { var b = fav.filter(function (x) { return TEAMS[x.k].gid !== TEAMS[fav[0].k].gid; })[0]; if (b) out.push([fav[0].k, b.k]); }
      if (!out.length && TK.length > 1) out.push([TK[0], TK[1]]);
      return out.slice(0, n);
    }
    function defaultGames() {
      var pre = boardGames().slice().sort(function (a, b) { return (totalOf(b.gid) - totalOf(a.gid)) || (D.playsFor(b.gid).length - D.playsFor(a.gid).length); });
      return pre.slice(0, 2).map(function (g) { return g.gid; });
    }
    function readLink() {
      var mode = Studio.param('mode'), p = Studio.param('p'), g = Studio.param('g'), t = Studio.param('t');
      if (p && HAS_P) { var ks = p.split('|').map(u.nk).filter(function (k) { return BYK[k]; }); if (ks.length) S.keys = ks.slice(0, 3); }
      if (t) { var ts = t.split('|').filter(function (k) { return TEAMS[k]; }); if (ts.length) S.tkeys = ts.slice(0, 3); }
      if (g) { var gs = g.split('|').filter(gameOf); if (gs.length === 2) S.games = gs; }
      if (mode === 'games' || (g && !p && !t)) S.mode = 'games';
      else if (mode === 'teams' || t) S.mode = HAS_P ? 'players' : 'teams';
      else if (p) S.mode = HAS_P ? 'players' : 'teams';
    }
    function writeLink() {
      if ((location.hash.slice(1).split('?')[0] || '') !== 'compare') return;
      var h = '#compare?' + (S.mode === 'games' ? 'mode=games&g=' + S.games.join('|')
        : S.mode === 'teams' ? 'mode=teams&t=' + S.tkeys.map(encodeURIComponent).join('|')
        : 'p=' + S.keys.map(function (k) { return encodeURIComponent(BYK[k].name); }).join('|'));
      if (location.hash !== h) history.replaceState(null, '', h);
    }

    // ── render ─────────────────────────────────────────────────────────────
    var M1 = HAS_P ? ['players', 'Compare players'] : ['teams', TEN ? 'Compare players' : 'Compare teams'];
    el.innerHTML = '<div class="cmp"><div class="cmp-mode" role="tablist"><button type="button" data-mode="' + M1[0] + '">' + M1[1] + '</button><button type="button" data-mode="games">Compare games</button></div>'
      + '<div class="cmp-view cmp-pview"></div><div class="cmp-view cmp-gview"></div></div>';
    var root = el.querySelector('.cmp'), pv = el.querySelector('.cmp-pview'), gv = el.querySelector('.cmp-gview');
    function setTop() { var t = document.getElementById('stTabs'); if (t) root.style.setProperty('--cmp-top', (t.offsetHeight || 54) + 'px'); }
    function draw() {
      ROWS = {};
      var y = window.scrollY, ae = document.activeElement && document.activeElement.id === 'cmpQ' ? document.getElementById('cmpQ').value : null;
      pv.innerHTML = HAS_P ? playersHTML() : teamsHTML(); pv.classList.toggle('cmp-n3', (HAS_P ? S.keys : S.tkeys).length > 2); gv.innerHTML = gamesHTML();
      pv.classList.toggle('on', S.mode !== 'games'); gv.classList.toggle('on', S.mode === 'games');
      Array.prototype.forEach.call(root.querySelectorAll('[data-mode]'), function (b) { b.classList.toggle('on', b.dataset.mode === S.mode); });
      if (ae != null) { var q = document.getElementById('cmpQ'); if (q && !q.disabled) { q.value = ae; q.focus(); } }
      if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
      writeLink();
    }
    function apply() {
      var Ps = HAS_P ? sel() : [], teams = [];
      Ps.forEach(function (P) { teams.push(P.team, P.opp); });
      if (!HAS_P) tsel().forEach(function (T) { teams.push(T.key); });
      S.games.forEach(function (gid) { var g = gameOf(gid); if (g) teams.push(g.home, g.away); });
      draw(); loadCards(teams); loadExtra();
      if (S.mode === 'players' && Ps.length >= 2) loadHist();
    }
    function addKey(k) {
      if (HAS_P) { if (!BYK[k] || S.keys.indexOf(k) >= 0 || S.keys.length >= 3) return; S.keys.push(k); }
      else { if (!TEAMS[k] || S.tkeys.indexOf(k) >= 0 || S.tkeys.length >= 3) return; S.tkeys.push(k); }
      apply();
    }

    // search autocomplete: players (prop sports) or teams / tennis players (game-line sports)
    var acIdx = 0;
    function acDraw(q) {
      var ac = document.getElementById('cmpAc'); if (!ac) return;
      var k = u.nk(q), up = String(q || '').trim().toUpperCase();
      if (!k) { ac.classList.remove('on'); ac.innerHTML = ''; return; }
      acIdx = 0;
      if (!HAS_P) {
        var tl = TK.map(function (key) {
          var T = TEAMS[key], nk = u.nk(T.full), ab = u.nk(key), sc = 0;
          if (ab === k) sc = 4; else if (nk.indexOf(k) === 0 || ab.indexOf(k) === 0 || u.nk(String(T.full).split(' ').slice(1).join(' ')).indexOf(k) === 0) sc = 3; else if (nk.indexOf(k) >= 0) sc = 2;
          return {T: T, sc: sc};
        }).filter(function (x) { return x.sc && S.tkeys.indexOf(x.T.key) < 0; }).sort(function (a, b) { return (b.sc - a.sc) || a.T.key.localeCompare(b.T.key); }).slice(0, 8);
        ac.innerHTML = tl.length ? tl.map(function (x, i) {
          var T = x.T, wc = winChance(T);
          return '<button type="button" data-add="' + u.esc(T.key) + '" class="' + (i === 0 ? 'hi' : '') + '"><i style="background:' + T.color + '"></i><span>' + u.esc(TEN ? T.key : T.full + ' (' + T.key + ')')
            + '<small>' + u.esc((TEN ? 'vs ' : T.home ? 'vs ' : '@ ') + T.opp + ' · ' + u.fmtTime(T.start)) + '</small></span><em>' + (wc != null ? 'model ' + u.pct(wc) : '') + '</em></button>';
        }).join('') : '<button type="button" disabled><span>No ' + W.side + ' on today\'s Onyx board matches</span></button>';
        ac.classList.add('on'); return;
      }
      var acList = PLAYERS.map(function (p) {
        var nk = u.nk(p.name), last = u.nk(p.name.split(' ').slice(1).join(' ')), sc = 0;
        if (nk.indexOf(k) === 0 || last.indexOf(k) === 0) sc = 3; else if (nk.indexOf(k) >= 0) sc = 2; else if (p.team === up) sc = 1;
        return {p: p, sc: sc};
      }).filter(function (x) { return x.sc && S.keys.indexOf(u.nk(x.p.name)) < 0; })
        .sort(function (a, b) { return (b.sc - a.sc) || (b.p.rows.length - a.p.rows.length) || a.p.name.localeCompare(b.p.name); }).slice(0, 8).map(function (x) { return x.p; });
      ac.innerHTML = acList.length ? acList.map(function (p, i) {
        var ms = ORDER.filter(function (m) { return !YES[m] && rowOf(p, m); }).map(function (m) { return MK[m]; });
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
      var t = e.target.closest && e.target.closest('[data-mode],[data-add],[data-rm],[data-rmt],[data-pair],[data-tpair],[data-focus],[data-slip],[data-pick],[data-slipall],[data-clearpick]');
      if (!t) return;
      var d = t.dataset;
      if (d.mode) { S.mode = d.mode; apply(); }
      else if (d.add) { var q = document.getElementById('cmpQ'); if (q) q.value = ''; addKey(d.add); }
      else if (d.rm) { S.keys = S.keys.filter(function (k) { return k !== d.rm; }); apply(); }
      else if (d.rmt) { S.tkeys = S.tkeys.filter(function (k) { return k !== d.rmt; }); apply(); }
      else if (d.pair) { S.keys = d.pair.split('|').map(u.nk).filter(function (k) { return BYK[k]; }); apply(); }
      else if (d.tpair) { S.tkeys = d.tpair.split('|').filter(function (k) { return TEAMS[k]; }); apply(); }
      else if (d.focus) {
        S.focus = d.focus; draw();
        if (t.closest('.cmp-mh')) { var f = document.getElementById('cmpForm'); if (f) f.scrollIntoView({behavior: 'smooth', block: 'start'}); }
      }
      else if (d.slip) { var r = ROWS[d.slip]; if (r && window.OnyxParlay) { OnyxParlay.add(Object.assign({sport: SP}, r)); draw(); } }
      else if (d.pick) { var r2 = ROWS[d.pick]; if (S.picked[d.pick]) delete S.picked[d.pick]; else if (r2) S.picked[d.pick] = r2; draw(); }
      else if (d.slipall) { if (window.OnyxParlay) Object.keys(S.picked).forEach(function (k) { if (!onSlip(k)) OnyxParlay.add(Object.assign({sport: SP}, S.picked[k])); }); draw(); }
      else if (d.clearpick) { S.picked = {}; draw(); }
    });
    window.addEventListener('onyx-slip', function () { if (root.isConnected) Array.prototype.forEach.call(root.querySelectorAll('[data-slip]'), function (b) { var on = onSlip(b.dataset.slip); b.classList.toggle('on', on); b.textContent = on ? 'On slip' : '+ Slip'; }); });
    window.addEventListener('resize', setTop);

    // first load: the deep link, else the sport's default matchup (never an empty tab)
    if (HAS_P) { var d0 = defaults(1)[0] || []; S.keys = d0.map(u.nk).filter(function (k) { return BYK[k]; }); }
    else S.tkeys = (teamDefaults(1)[0] || []).filter(function (k) { return TEAMS[k]; });
    S.games = defaultGames();
    readLink();
    setTop();
    apply();

    Studio.checks.compare = function () {
      var n = pv.querySelectorAll('.cmp-head .cmp-pc .cmp-x').length, m = pv.querySelectorAll('.cmp-m[data-shared="1"]').length, gm = gv.querySelectorAll('.cmp-m[data-gm="1"]').length;
      var what = HAS_P ? 'player(s)' : W.side + '(s)';
      if (n < 2) return 'only ' + n + ' ' + what + ' rendered';
      if (!m) return 'no shared market row for the ' + W.sides + ' shown';
      if (boardGames().length >= 2 && !gm) return 'compare games rendered no market row';
      return '';
    };
    return {show: function () {
      var before = S.keys.join('|') + S.tkeys.join('|') + S.mode + S.games.join('|');
      readLink(); setTop();
      if (S.keys.join('|') + S.tkeys.join('|') + S.mode + S.games.join('|') !== before) apply(); else writeLink();
    }};
  }});
})();
