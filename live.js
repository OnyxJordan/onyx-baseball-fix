// live.js - in-game fair chances for every game being played (Onyx Sports live tab, Ask Onyx "live").
//
// The models, per sport, from the game state (ESPN: score, period, clock) and the PREGAME Onyx
// line for that game (our boards: spread, total, moneyline), so a live chance always starts
// from what the market thought before kickoff and moves only with what has happened since:
//   football (NFL, college) and NBA: the rest of the game as a normal draw. Remaining home
//     margin ~ N(pregame expected margin x f, SD^2 x f) and remaining points ~ N(pregame total
//     x f, SD^2 x f), f = share of the game left; SDs are each sport's full-game spread of
//     results (NFL 13.5 / 13.5, college 16 / 17, NBA 12.5 / 18).
//   NHL: goals for each side are Poisson for the time left; the two rates split the pregame
//     total so the pregame moneyline is matched (overtime a coin flip).
//   tennis: sets. The pregame match price gives a set-win chance; the sets already won decide
//     the rest (best of 3, or 5 at the men's majors).
// These are LEANS: no live model has been tested against Onyx's in-game prices yet, so the page
// says so and never calls one a pick.
(function () {
  var SD = {nfl: [13.5, 13.5], cfb: [16, 17], nba: [12.5, 18]};
  var LEN = {nfl: [4, 15], cfb: [4, 15], nba: [4, 12], nhl: [3, 20]};

  function erf(x) {   // Abramowitz-Stegun 7.1.26
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function noVig(a, b) {      // two American prices -> the first side's chance without the margin
    var i = function (p) { return p == null ? null : p < 0 ? -p / (-p + 100) : 100 / (p + 100); };
    var x = i(a), y = i(b);
    if (x == null) return null;
    return y == null ? x : x / (x + y);
  }
  function implied(p) { return p == null ? null : p < 0 ? -p / (-p + 100) : 100 / (p + 100); }

  // share of the game still to play, from ESPN's period and clock (seconds)
  function left(sport, period, clockSec) {
    var L = LEN[sport];
    if (!L || !period) return null;
    if (period > L[0]) return Math.max(0.004, (clockSec || 0) / 60 / (L[1] * L[0]));   // overtime
    var rem = (L[0] - period) * L[1] * 60 + (clockSec || 0);
    return Math.max(0.004, Math.min(1, rem / (L[0] * L[1] * 60)));
  }

  // normal model: chances for the home side and the over, from the score and the time left
  function normal(sport, g) {
    var sd = SD[sport], f = g.f;
    var mu = (g.pre_margin || 0) * f, sM = sd[0] * Math.sqrt(f);
    var mt = (g.pre_total || 0) * f, sT = sd[1] * Math.sqrt(f);
    var cur = g.hs - g.as, tot = g.hs + g.as;
    return {
      win: function () { return 1 - phi((-cur - mu) / sM); },                              // home wins
      cover: function (homeLine) { return 1 - phi((-homeLine - cur - mu) / sM); },        // home + line > 0
      over: function (line) { return 1 - phi((line - tot - mt) / sT); },
      proj_total: tot + mt, proj_margin: cur + mu,
    };
  }

  // NHL: Poisson goals for the time left
  function pois(l, k) { var p = Math.exp(-l); for (var i = 1; i <= k; i++) p *= l / i; return p; }
  function nhl(g) {
    var T = g.pre_total || 6.0, pH = g.pre_home_win == null ? 0.5 : g.pre_home_win;
    var lo = 0, hi = T, lh = T / 2;
    for (var it = 0; it < 40; it++) {       // split the total so the pregame moneyline holds (OT 50/50)
      lh = (lo + hi) / 2;
      if (winP(lh, T - lh, 0) < pH) lo = lh; else hi = lh;
    }
    var rh = lh * g.f, ra = (T - lh) * g.f, d = g.hs - g.as;
    function winP(a, b, lead) {
      var w = 0, t = 0;
      for (var i = 0; i < 12; i++) for (var j = 0; j < 12; j++) {
        var p = pois(a, i) * pois(b, j), m = lead + i - j;
        if (m > 0) w += p; else if (m === 0) t += p;
      }
      return w + 0.5 * t;
    }
    function distMargin(fn) {
      var s = 0;
      for (var i = 0; i < 12; i++) for (var j = 0; j < 12; j++) { var p = pois(rh, i) * pois(ra, j); if (fn(d + i - j, g.hs + g.as + i + j)) s += p; }
      return s;
    }
    return {
      win: function () { return winP(rh, ra, d); },
      cover: function (homeLine) { return distMargin(function (m) { return m + homeLine > 0; }) + 0.5 * distMargin(function (m) { return m + homeLine === 0; }); },
      over: function (line) { return distMargin(function (m, t) { return t > line; }); },
      proj_total: g.hs + g.as + rh + ra, proj_margin: d + rh - ra,
    };
  }

  // tennis: the rest of the match in sets
  function tennis(g) {
    var best = g.best || 3, need = (best + 1) / 2, pm = g.pre_home_win == null ? 0.5 : g.pre_home_win;
    function match(ps, a, b) {   // chance to reach `need` sets first from a-b
      if (a >= need) return 1; if (b >= need) return 0;
      return ps * match(ps, a + 1, b) + (1 - ps) * match(ps, a, b + 1);
    }
    var lo = 0.01, hi = 0.99, ps = 0.5;
    for (var it = 0; it < 40; it++) { ps = (lo + hi) / 2; if (match(ps, 0, 0) < pm) lo = ps; else hi = ps; }
    return {win: function () { return match(ps, g.hs, g.as); }, cover: null, over: null, proj_total: null, proj_margin: null};
  }

  function model(sport, g) {
    if (sport === 'tennis') return tennis(g);
    if (sport === 'nhl') return nhl(g);
    if (SD[sport]) return normal(sport, g);
    return null;
  }

  // every side Onyx prices live on this game, with the model's chance and the edge against
  // Onyx's live price (its own chance less nothing: the edge is model minus the price's implied)
  function plays(sport, g, lines) {
    var m = model(sport, g); if (!m) return [];
    var out = [];
    function add(kind, label, side, price, prob, sel, line) {
      if (price == null || prob == null || isNaN(prob)) return;
      out.push({sport: sport, kind: kind, label: label, side: side, price: price, line: line, sel: sel || null,
                conf: Math.round(prob * 1000) / 1000, edge: Math.round((prob - implied(price)) * 1000) / 1000});
    }
    var H = g.home, A = g.away;
    if (lines.ml) {
      var pw = m.win();
      add('ml', H + ' to win', 'home', lines.ml.home, pw, lines.ml.home_sel);
      add('ml', A + ' to win', 'away', lines.ml.away, 1 - pw, lines.ml.away_sel);
    }
    if (lines.spread && m.cover && lines.spread.home_line != null) {
      var pc = m.cover(lines.spread.home_line), hl = lines.spread.home_line;
      add('spread', H + ' ' + (hl > 0 ? '+' : '') + hl, 'home', lines.spread.home, pc, lines.spread.home_sel, hl);
      add('spread', A + ' ' + (-hl > 0 ? '+' : '') + (-hl), 'away', lines.spread.away, 1 - pc, lines.spread.away_sel, -hl);
    }
    if (lines.total && m.over && lines.total.line != null) {
      var po = m.over(lines.total.line);
      add('total', 'Over ' + lines.total.line, 'over', lines.total.over, po, lines.total.over_sel, lines.total.line);
      add('total', 'Under ' + lines.total.line, 'under', lines.total.under, 1 - po, lines.total.under_sel, lines.total.line);
    }
    return out;
  }

  // ── every game in progress, every sport: ESPN state + our pregame line -> live numbers ──
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
  var LEAGUES = [['nfl', 'football/nfl'], ['cfb', 'football/college-football'], ['nba', 'basketball/nba'], ['nhl', 'hockey/nhl'],
                 ['tennis', 'tennis/atp'], ['tennis', 'tennis/wta']];
  var DEF_TOTAL = {nfl: 44, cfb: 54, nba: 228, nhl: 6};
  var BOARD = {}, PRE = {}, BOARD_AT = 0;
  function getJSON(u) { return fetch(u, {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  function boards() {
    if (Date.now() - BOARD_AT < 10 * 60e3) return Promise.resolve(BOARD);
    return Promise.all(['nfl', 'cfb', 'nba', 'nhl', 'tennis'].map(function (k) {
      return Promise.all([
        getJSON('data/' + k + '/board.json').then(function (j) { BOARD[k] = j.plays || []; }).catch(function () { BOARD[k] = BOARD[k] || []; }),
        getJSON('data/' + k + '/pregame.json').then(function (j) { PRE[k] = j || {}; }).catch(function () { PRE[k] = PRE[k] || {}; })]);
    })).then(function () { BOARD_AT = Date.now(); return BOARD; });
  }
  function nk(n) { return String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  // the pregame Onyx line for a game: home expected margin, total, home win chance.
  // data/<sport>/pregame.json keeps each game's last line from before its start (the board
  // drops a game once it starts); the board is the fallback. Spreads come from the label
  // ("NE -7"), which is always the team's own handicap.
  var NUM = /([+-]?\d+(?:\.\d+)?)\s*$/;
  function sameGame(m, home, away) { return m === away + ' @ ' + home || m === home + ' vs ' + away || m === away + ' vs ' + home; }
  function pregame(sport, rows, home, away, pre) {
    var out = {margin: null, total: null, home_win: null, spread_txt: null, total_txt: null};
    var hit = null;
    Object.keys(pre || {}).forEach(function (k) { if (sameGame(pre[k].m, home, away)) hit = pre[k]; });
    var sp = {}, ml = {}, tot = null;
    if (hit) { sp = hit.sp || {}; ml = hit.ml || {}; tot = hit.tot; }
    else rows.forEach(function (p) {
      if (p.kind === 'prop' || !sameGame(p.matchup, home, away)) return;
      if (p.kind === 'spread') { var m = NUM.exec(String(p.label || '')); if (m) sp[p.name] = +m[1]; }
      else if (p.kind === 'total' && p.line != null) tot = p.line;
      else if (p.kind === 'ml' && p.price != null) ml[p.name] = p.price;
    });
    var hn = Object.keys(sp).filter(function (n) { return n === home || nk(n) === nk(home); })[0];
    var an = Object.keys(sp).filter(function (n) { return n === away || nk(n) === nk(away); })[0];
    var hl = hn != null ? sp[hn] : an != null ? -sp[an] : null;
    if (hl != null) { out.margin = -hl; out.spread_txt = home + ' ' + (hl > 0 ? '+' + hl : hl === 0 ? 'pk' : hl); }
    if (tot != null) { out.total = tot; out.total_txt = String(tot); }
    var mh = Object.keys(ml).filter(function (n) { return n === home || nk(n) === nk(home); })[0];
    var ma = Object.keys(ml).filter(function (n) { return n === away || nk(n) === nk(away); })[0];
    out.home_ml = mh != null ? ml[mh] : null; out.away_ml = ma != null ? ml[ma] : null;
    if (mh != null) out.home_win = noVig(ml[mh], ma != null ? ml[ma] : null);
    else if (ma != null) out.home_win = 1 - noVig(ml[ma], null);
    return out;
  }
  function team(c) { var t = c.team || {}; return t.abbreviation || (c.athlete || {}).displayName || t.displayName; }
  function logo(c) { var t = c.team || {}, a = c.athlete || {}; return t.logo || (t.logos && t.logos[0] && t.logos[0].href) || (a.flag && a.flag.href) || null; }
  // a probability as an American price, rounded to 5
  function american(p) {
    if (p == null || p <= 0 || p >= 1) return null;
    var x = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    x = Math.round(x / 5) * 5;
    return x === -100 ? 100 : x;
  }
  // the one bet the card leads with: the side whose chance moved our way since the start (moneyline,
  // while it is still a bettable price), else the total against Onyx's pregame number. Started (Onyx
  // before the game), now (our live number), fair (the price or line where it turns into a good bet).
  function lean(x) {
    var pre = x.pre || {}, hw = x.home_win;
    if (hw == null || isNaN(hw)) return null;
    if (pre.home_win == null && pre.total == null) return {kind: 'none', why: 'nopre'};   // no starting line: nothing to measure from
    var up = pre.home_win != null ? (hw >= pre.home_win ? 'home' : 'away') : (hw >= 0.5 ? 'home' : 'away');
    var p = up === 'home' ? hw : 1 - hw;
    if (pre.home_win != null && p >= 0.08 && p <= 0.93) {
      var p0 = pre.home_win == null ? null : up === 'home' ? pre.home_win : 1 - pre.home_win;
      return {kind: 'ml', side: up, team: up === 'home' ? x.home : x.away, logo: up === 'home' ? x.hl : x.al,
              start: p0, start_price: up === 'home' ? pre.home_ml : pre.away_ml, now: p, fair: american(p)};
    }
    if (x.proj_total != null && pre.total != null && Math.abs(x.proj_total - pre.total) >= 1) {
      var under = x.proj_total < pre.total, fl = Math.round(x.proj_total * 2) / 2;
      return {kind: 'total', side: under ? 'under' : 'over', start: pre.total, now: x.hs + x.as, fair: fl,
              chance: x.over_pre == null ? null : under ? 1 - x.over_pre : x.over_pre};
    }
    return null;
  }
  // one live game -> what the page shows
  function game(sport, e, c, rows, pre0) {
    var st = (c.status || e.status || {}), ty = st.type || {};
    if (ty.state !== 'in') return null;
    var H = {}, cs = c.competitors || [];
    cs.forEach(function (x) { H[x.homeAway || (x.order === 1 ? 'home' : 'away')] = x; });
    if (!H.home || !H.away) { H.away = cs[0]; H.home = cs[1]; }
    if (!H.home || !H.away) return null;
    var home = team(H.home), away = team(H.away), g;
    if (sport === 'tennis') {
      var sets = function (me, op) { var w = 0; (me.linescores || []).forEach(function (l, i) { var a = +l.value, b = +((op.linescores || [])[i] || {}).value;
        if ((a >= 6 && a - b >= 2) || a === 7) w++; }); return w; };
      var pg = pregame(sport, rows, home, away, pre0);
      g = {hs: sets(H.home, H.away), as: sets(H.away, H.home), best: /grand slam|open/i.test(e.name || '') && (e.groupings || [{}])[0] && /men/i.test(((e.groupings || [{}])[0].grouping || {}).displayName || '') ? 5 : 3,
           pre_home_win: pg.home_win, home: home, away: away};
      var m = model('tennis', g);
      var tx = {sport: sport, gid: e.id, home: home, away: away, hl: logo(H.home), al: logo(H.away), hs: g.hs, as: g.as, state: (H.away.linescores || []).map(function (l, i) { return l.value + '-' + (((H.home.linescores || [])[i] || {}).value || 0); }).join(' '),
              detail: ty.shortDetail || ty.detail || '', home_win: m.win(), pre: pg, f: null, name: away + ' vs ' + home};
      tx.lean = lean(tx); return tx;
    }
    var hs = +H.home.score || 0, as = +H.away.score || 0, f = left(sport, st.period, st.clock);
    if (f == null) return null;
    var pre = pregame(sport, rows, home, away, pre0);
    g = {hs: hs, as: as, f: f, pre_margin: pre.margin != null ? pre.margin : pre.home_win != null && sport !== 'nhl' ? (pre.home_win - 0.5) * 2 * SD[sport][0] * 0.8 : 0,
         pre_total: pre.total != null ? pre.total : DEF_TOTAL[sport], pre_home_win: pre.home_win != null ? pre.home_win : 0.5, home: home, away: away};
    var M = model(sport, g);
    var r2 = function (x) { return Math.round(x * 2) / 2; };
    var pm = M.proj_margin, fair = r2(-pm);
    var gx = {sport: sport, gid: e.id, home: home, away: away, hl: logo(H.home), al: logo(H.away), hs: hs, as: as, detail: ty.shortDetail || ty.detail || '', f: f,
            home_win: M.win(), proj_total: M.proj_total != null ? Math.round(M.proj_total * 10) / 10 : null,
            fair_spread: home + ' ' + (fair > 0 ? '+' : fair === 0 ? '' : '') + (fair === 0 ? 'pk' : fair), pre: pre,
            over_pre: pre.total != null && M.over ? M.over(pre.total) : null, name: away + ' @ ' + home};
    gx.lean = lean(gx); return gx;
  }
  // every live game across the sports (optionally only some sports)
  function games(only) {
    var L = LEAGUES.filter(function (l) { return !only || only.indexOf(l[0]) >= 0; });
    return boards().then(function (B) {
      return Promise.all(L.map(function (l) {
        return getJSON(ESPN + l[1] + '/scoreboard' + (l[0] === 'cfb' ? '?groups=80' : '')).then(function (j) {
          var out = [];
          (j.events || []).forEach(function (e) {
            if (l[0] === 'tennis') ((e.groupings || []).forEach(function (gr) { (gr.competitions || []).forEach(function (c) { var x = game('tennis', e, c, B.tennis || [], PRE.tennis); if (x) out.push(x); }); }));
            else { var x = game(l[0], e, (e.competitions || [{}])[0], B[l[0]] || [], PRE[l[0]]); if (x) out.push(x); }
          });
          return out;
        }).catch(function () { return []; });
      })).then(function (a) { return [].concat.apply([], a); });
    });
  }

  window.OnyxLive = {left: left, model: model, plays: plays, noVig: noVig, implied: implied, phi: phi, games: games, pregame: pregame, american: american, lean: lean};
})();
