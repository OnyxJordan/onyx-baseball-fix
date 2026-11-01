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

  window.OnyxLive = {left: left, model: model, plays: plays, noVig: noVig, implied: implied, phi: phi};
})();
