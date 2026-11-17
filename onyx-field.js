// onyx-field.js - the live football field in the NFL and college football gamecenter (11/17, Jordan: "make the live
// in game as realistic as possible especially for nfl moving pieces routes everything we want it to come to life").
//
// One SVG, broadcast look: striped turf, yard numbers, hash marks (NFL or college width), end zones in team colours with
// logos, goal posts, the line of scrimmage, the first-down line and a red zone glow. 22 dots line up at the line of
// scrimmage, offense in its team colour, defense ringed in the other. Every play from ESPN's play-by-play is rebuilt
// and animated: snap, QB drop, route trees and the throw to the catch point and the run after the catch; handoffs and
// the lane; sacks, scrambles, punts and kickoffs (ball arc and return), field goals (through the uprights or wide),
// interceptions and fumbles (possession flips), flags, touchdowns (end zone flash in the scorer's colour) and two-point
// tries. The ball always finishes on ESPN's end spot. Under the field: the drive chart (one bar per play, tap to
// replay), the drive summary, and the play list with a replay button on every play. Follow mode plays new plays as the
// gamecenter's 6 s summary refresh brings them in.
//
// Honesty: ESPN's public feed has no player tracking. The page says so ("Play reconstruction from the play-by-play")
// and the positions are schematic; only the spots, yards, players named and the result come from the feed.
//
// Saved picks: a player in the play with a saved prop (OnyxSaved) is ringed in purple, with his number against his line
// and the live chance to cash from OnyxCash when it has one.
//
// Performance: everything moves by SVG transform inside one <svg>, one requestAnimationFrame loop, no layout reads per
// frame. prefers-reduced-motion jumps every play to its end state. A field that is not on the page stops its loop.
//
// API (sport_shell.html): OnyxField.slot(g) -> placeholder html; OnyxField.attach(summary, g) after the gamecenter
// renders; OnyxField.replay(gid, playId); OnyxField.state(gid); OnyxField.plays(gid) (gates).
(function () {
  'use strict';
  if (window.OnyxField) return;
  var NS = 'http://www.w3.org/2000/svg';
  var MID = 26.65, FW = 53.3;
  var SNAP = 0.14;
  var RM = false;
  try { RM = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var ST = {};                    // per game: the persistent field
  var FOLLOW_KEY = 'onyxFieldFollow';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function X(a) { return (a + 10) * 10; }
  function Y(y) { return y * 10; }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (tag === 'image') e.addEventListener('error', function () { e.style.display = 'none'; });
    if (parent) parent.appendChild(e);
    return e;
  }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // team colours: the page's own gxColor keeps them off yellow and readable on a dark card
  function tcol(hex, fb) {
    if (typeof window.gxColor === 'function') return window.gxColor(hex, fb);
    return /^#?[0-9a-f]{6}$/i.test(String(hex || '')) ? '#' + String(hex).replace('#', '') : fb;
  }
  function rgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [128, 128, 128]; return [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); }); }
  function cdist(a, b) { var x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]); }

  // ── reading ESPN's play-by-play ─────────────────────────────────────────
  // absolute yard: 0 = the away goal line (left), 100 = the home goal line (right). The away team attacks right.
  function ctxOf(s, g) {
    var comp = (((s || {}).header || {}).competitions || [{}])[0] || {};
    var C = {homeId: '', awayId: '', ab: {}, g: g};
    (comp.competitors || []).forEach(function (c) {
      var t = c.team || {}, side = c.homeAway === 'home' ? 'home' : 'away';
      C[side + 'Id'] = String(t.id || '');
      if (t.abbreviation) C.ab[String(t.abbreviation).toUpperCase()] = side;
    });
    if (!C.homeId) C.homeId = String(((window.LIVE || {})[g.gid] || {}).home_id || '');
    if (g.home) C.ab[String(g.home).toUpperCase()] = 'home';
    if (g.away) C.ab[String(g.away).toUpperCase()] = 'away';
    return C;
  }
  function absOf(spot, C) {
    if (!spot) return null;
    var pt = String(spot.possessionText || '').trim();
    var m = pt.match(/^([A-Za-z&]+)\s+(\d+)$/);
    if (m && C.ab[m[1].toUpperCase()]) return C.ab[m[1].toUpperCase()] === 'away' ? +m[2] : 100 - +m[2];
    if (/^50$/.test(pt)) return 50;
    // ESPN's yardLine counts from the home goal line (checked on NFL and college summaries, 11/17)
    if (spot.yardLine != null && spot.yardLine !== '' && !isNaN(+spot.yardLine)) return 100 - +spot.yardLine;
    return null;
  }
  // a spot written in the play text ("to BLT 21", "at the OM35"): ESPN's text sometimes uses other abbreviations, so an
  // unknown team takes whichever reading sits closer to where the play should be
  function textSpot(txt, C, near) {
    var m = String(txt || '').match(/^\s*(?:the\s+)?([A-Z][A-Za-z&]*)\s?(\d{1,2})\b/);
    if (!m) { if (/^\s*(?:the\s+)?50\b/.test(txt || '')) return 50; return null; }
    var n = +m[2], side = C.ab[m[1].toUpperCase()];
    if (side) return side === 'away' ? n : 100 - n;
    if (near == null) return null;
    return Math.abs(n - near) <= Math.abs(100 - n - near) ? n : 100 - n;
  }
  var SUF = "(?:\\s(?:II|III|IV|V|Jr\\.?|Sr\\.?))?";
  var NM = "(?:#\\d+\\s)?([A-Z][A-Za-z'\\-]*\\.?\\s?(?:(?:St\\.|Mc|Van|De|La|Le|Du)\\s?)?[A-Z][A-Za-z'\\-]+" + SUF + ")";
  function rx(src, f) { return new RegExp(src.replace(/NM/g, NM), f || ''); }
  var R_PASSER = rx('NM\\s+(?:pass|sacked|scrambles|spiked|kneels|steps back)');
  var R_TARGET = rx('pass\\s(?:complete\\s|incomplete\\s)?(?:(?:short|deep)\\s)?(?:(?:left|middle|right)\\s)?(?:(?:intended\\s)?(?:for|to))\\s+NM');
  var R_INT = rx('intercepted by\\s+NM', 'i');
  var R_RUSH = rx('NM\\s+(?:(?:left|right)\\s(?:end|tackle|guard)|up the middle|rush(?:es)?\\b|run\\b|scrambles|kneels|for\\s-?\\d+\\syards?)');
  var R_SACKER = rx('sacked\\b[^()]*?(?:by\\s+NM|\\(NM)');
  var R_PUNTER = rx('NM\\s+punts?\\b');
  var R_KICKER = rx('NM\\s+(?:kicks|kickoff|\\d+\\s*(?:yard|yd)s?\\s+(?:field goal|FG)|extra point|onside)');
  var R_RET = rx('(?:[.,]\\s+|fair catch by\\s+|return(?:ed)? by\\s+)NM(?:\\s+(?:to|return|pushed|ran|for|MUFFS|fair))?');
  var R_FUMREC = rx('(?:RECOVERED by\\s+[A-Z]+-|recovered by\\s+)NM');
  function clean(t) {
    return String(t || '').replace(/^\(\d+:\d+\)\s*/, '').replace(/\((?:Shotgun|No Huddle[^)]*|Pistol|Under Center)\)/gi, ' ')
      .replace(/\b(?:No Huddle-)?Shotgun\b|\bNo Huddle\b|\bPistol\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function grab(re, t) { var m = re.exec(t); if (!m) return ''; for (var i = 1; i < m.length; i++) if (m[i]) return m[i].trim(); return ''; }
  function shortN(n) { return String(n || '').replace(/^[A-Z][a-z]?\.\s?(?=[A-Z])/, '').replace(/^[A-Z][a-z]+\s(?=[A-Z])/, ''); }

  function classify(p) {
    var ty = String((p.type || {}).text || ''), tx = clean(p.text), lo = tx.toLowerCase();
    if (!tx || /timeout|end (of )?(period|quarter|half|game|regulation)|two-minute|coin toss|^end\b/i.test(ty) || /^END (QUARTER|GAME|HALF|OF)/.test(tx)) return null;
    var I = {ty: ty, tx: tx, raw: p.text || ''};
    I.penalty = /penalty/i.test(ty) || (!!p.isPenalty && /no play/i.test(tx)) || /^penalty\b/i.test(tx);
    I.noPlay = /no play/i.test(tx);
    I.td = /touchdown/i.test(ty) || /\bTOUCHDOWN\b/i.test(tx);
    I.safety = /safety/i.test(ty) || /\bSAFETY\b/.test(tx);
    I.fumble = /fumble/i.test(ty) || /\bFUMBLES\b/i.test(tx);
    I.fumOpp = /fumble recovery \(opponent\)|fumble return/i.test(ty) || /RECOVERED by/.test(tx) && !/recovers at/i.test(tx);
    I.int = /interception/i.test(ty) || /\bINTERCEPTED\b/i.test(tx);
    I.two = /two[- ]point|2pt|two point/i.test(ty) || /TWO-POINT CONVERSION|two-point/i.test(tx);
    I.twoOk = /ATTEMPT SUCCEEDS|conversion is good|attempt is good|succeeds/i.test(tx);
    I.xp = /extra point is good|PAT good|KICK\)|extra point good/i.test(tx) ? 'good' : /extra point is (no good|blocked)|PAT (failed|missed|blocked)/i.test(tx) ? 'miss' : '';
    I.shotgun = /shotgun/i.test(p.text || '');
    var m;
    if (/kickoff/i.test(ty) || /\bkicks (?:off|onside|\d+)|\bkickoff\b/i.test(tx)) I.kind = 'kickoff';
    else if (/punt/i.test(ty) || /\bpunts?\b/i.test(tx) && !/pass|rush/i.test(ty)) I.kind = 'punt';
    else if (/field goal/i.test(ty) || /\bfield goal\b|\byd FG\b|\bFG (?:GOOD|MISSED|BLOCKED|NO GOOD)/i.test(tx)) I.kind = 'fg';
    else if (/^extra point/i.test(ty) || /^PAT/i.test(ty)) I.kind = 'xp';
    else if (/sack/i.test(ty) || /\bsacked\b/i.test(tx)) I.kind = 'sack';
    else if (/\bkneels\b/i.test(tx)) I.kind = 'kneel';
    else if (/\bspiked\b/i.test(tx)) I.kind = 'spike';
    else if (/\bscrambles\b/i.test(tx)) I.kind = 'scramble';
    else if (/pass|interception/i.test(ty) || /\bpass\b/i.test(tx)) I.kind = 'pass';
    else if (/rush|run/i.test(ty) || R_RUSH.test(tx)) I.kind = 'run';
    else if (I.penalty) I.kind = 'penalty';
    else if (/fumble/i.test(ty)) I.kind = 'run';
    else return null;
    if (I.penalty && I.kind !== 'penalty' && !I.noPlay) I.flagLate = true;
    if (I.penalty && I.noPlay) I.flagLate = true;
    // direction words
    m = lo.match(/(short|deep)\s+(left|middle|right)/) || lo.match(/pass (?:complete |incomplete )?(short|deep)?\s?(left|middle|right)/);
    I.deep = !!(m && m[1] === 'deep');
    I.side = m ? m[2] : '';
    if (I.kind === 'run' || I.kind === 'scramble') {
      m = lo.match(/(left|right)\s(end|tackle|guard)/);
      if (m) { I.side = m[1]; I.gap = m[2]; }
      else if (/up the middle|rush middle|middle for|run middle/.test(lo)) { I.side = 'middle'; I.gap = 'middle'; }
      else if ((m = lo.match(/(?:rush|run|scrambles)\s(left|right)/))) { I.side = m[1]; I.gap = 'tackle'; }
      else { I.side = 'middle'; I.gap = 'guard'; }
    }
    I.passer = grab(R_PASSER, tx);
    I.target = grab(R_TARGET, tx);
    I.picker = grab(R_INT, tx);
    I.rusher = I.kind === 'run' || I.kind === 'scramble' || I.kind === 'kneel' ? grab(R_RUSH, tx) : '';
    I.sacker = grab(R_SACKER, tx);
    I.punter = grab(R_PUNTER, tx);
    I.kicker = grab(R_KICKER, tx);
    var mk = tx.match(/(?:punts?|kicks|kickoff)\s+(-?\d+)\s+yards?/i); I.kickYds = mk ? +mk[1] : null;
    var fg = tx.match(/(\d+)\s*(?:yard|yd)s?\s+(?:field goal|FG)|field goal attempt from (\d+)/i); I.fgYds = fg ? +(fg[1] || fg[2]) : null;
    I.fgGood = /field goal good/i.test(ty) || /\bis GOOD\b|\bFG GOOD\b|field goal (?:attempt )?.*\bGOOD\b/i.test(tx) && !/no good/i.test(tx);
    I.wide = /wide left/i.test(tx) ? -1 : /wide right/i.test(tx) ? 1 : 0;
    I.blocked = /\bblocked\b/i.test(tx);
    I.touchback = /touchback/i.test(tx);
    I.fair = /fair catch/i.test(tx);
    I.oob = /out of bounds/i.test(tx) && (I.kind === 'punt' || I.kind === 'kickoff') && !/ to [A-Z]+ ?\d+ for/.test(tx.split(/punts?|kicks/)[1] || '');
    if (I.kind === 'punt' || I.kind === 'kickoff') {
      var after = tx.split(/\bpunts?\b|\bkicks\b|\bkickoff\b/i).slice(1).join(' ');
      I.returner = I.fair ? grab(rx('fair catch by\\s+NM'), tx) : grab(rx('(?:[.,]\\s+|\\s)NM\\s+(?:to\\s|return|pushed|ran|for\\s|MUFFS)'), after);
    }
    I.recoverer = grab(R_FUMREC, tx);
    var pen = tx.match(/PENALTY on ([A-Z]+)-(?:#\d+\s)?([^,]+?),\s*([^,]+?),\s*(\d+)\s*yards?/i) || tx.match(/PENALTY\s+(?:on\s+)?([A-Z]+)\s+()([A-Za-z \-]+?)\s*(?:\([^)]*\)\s*)?(\d+)\s*yards?/i);
    if (pen) { I.penTeam = pen[1]; I.penWho = pen[2]; I.foul = pen[3].trim(); I.penYds = +pen[4]; }
    else if (I.penalty) { var pm = tx.match(/PENALTY[^,]*?,\s*([^,]+?),/i); I.foul = pm ? pm[1] : 'Penalty'; }
    return I;
  }

  function playsOf(s) {
    var d = (s || {}).drives || {}, out = [], seen = {};
    (d.previous || []).concat(d.current ? [d.current] : []).forEach(function (dr, di) {
      (dr.plays || []).forEach(function (p) {
        if (!p || !p.id || seen[p.id] || !p.text) return;
        seen[p.id] = 1; out.push({p: p, drive: dr, cur: dr === d.current});
      });
    });
    return out;
  }
  // a play with its spots, direction and players: the input every animation is built from
  function info(entry, C) {
    var p = entry.p, I = classify(p);
    if (!I) return null;
    var st = p.start || {}, en = p.end || {};
    var tid = String((st.team || {}).id || ((entry.drive || {}).team || {}).id || '');
    I.offAway = C.homeId ? tid !== C.homeId : tid === C.awayId;
    if (!tid) I.offAway = true;
    I.dir = I.offAway ? 1 : -1;
    I.x0 = absOf(st, C);
    I.x1 = absOf(en, C);
    var sy = p.statYardage != null ? +p.statYardage : 0;
    if (I.x0 == null && I.x1 != null) I.x0 = clamp(I.x1 - I.dir * sy, 0, 100);
    if (I.x0 == null) return null;
    if (I.x1 == null) I.x1 = clamp(I.x0 + I.dir * sy, 0, 100);
    if (I.kind === 'kickoff' && (st.yardLine == null) && !st.possessionText) I.x0 = I.offAway ? 35 : 65;
    I.G = (I.x1 - I.x0) * I.dir;           // yards toward the offense's goal (negative after a turnover return)
    I.yds = sy;
    I.down = st.down; I.dist = st.distance;
    I.ytg = I.dir > 0 ? 100 - I.x0 : I.x0;
    I.dd = st.downDistanceText || '';
    I.sdd = st.shortDownDistanceText || '';
    I.q = (p.period || {}).number; I.clock = (p.clock || {}).displayValue || '';
    I.id = String(p.id); I.p = p; I.drive = entry.drive; I.cur = entry.cur;
    // scorer from geometry: the end zone the ball finished in
    if (I.td || I.safety) I.scoreAway = I.safety ? I.x1 <= 50 ? false : true : I.x1 >= 99 ? true : I.x1 <= 1 ? false : I.offAway;
    if (I.td && I.x1 > 1 && I.x1 < 99) I.x1 = I.scoreAway ? 100 : 0;
    // spots inside the text
    var tx = I.tx;
    var m;
    if ((m = tx.match(/caught at\s+(?:the\s+)?([A-Z][A-Za-z&]*\s?\d{1,2}|50)/i))) I.catchX = textSpot(m[1], C, I.x0 + I.dir * Math.max(1, I.G * 0.6));
    if ((m = tx.match(/INTERCEPTED by[^.]*?\bat\s+(?:the\s+)?([A-Z][A-Za-z&]*\s?\d{1,2}|50)/i))) I.intX = textSpot(m[1], C, I.x0 + I.dir * 15);
    if ((m = tx.match(/thrown to\s+(?:the\s+)?([A-Z][A-Za-z&]*\s?\d{1,2}|50)/i))) I.throwX = textSpot(m[1], C, I.x0 + I.dir * 8);
    if (I.fumble) {
      var pre = tx.split(/FUMBLES/i)[0];
      var all = pre.match(/\bto (?:the )?([A-Z][A-Za-z&]*\s?\d{1,2}|50)\b/g);
      if (all && all.length) I.fumX = textSpot(all[all.length - 1].replace(/^to (?:the )?/, ''), C, I.x0 + I.dir * Math.max(0, I.G));
    }
    if (I.penalty && I.noPlay) {
      var mm = tx.match(/\bto (?:the )?([A-Z][A-Za-z&]*\s?\d{1,2}|50)\b/); var fy = tx.match(/for (-?\d+) yards?/);
      I.nullX = mm ? textSpot(mm[1], C, I.x0 + I.dir * (fy ? +fy[1] : 3)) : fy ? I.x0 + I.dir * +fy[1] : null;
      if (I.kind === 'penalty' && I.nullX != null) I.kind = /pass/i.test(tx) ? 'pass' : 'run';
    }
    if (I.kind === 'punt' || I.kind === 'kickoff') {
      if (I.kickYds != null) I.landX = clamp(I.x0 + I.dir * I.kickYds, -9, 109);
      else if ((m = tx.match(/(?:punts?|kicks|kickoff)[^.]*?\bto (?:the )?([A-Z][A-Za-z&]*\s?\d{1,2}|50)/i))) I.landX = textSpot(m[1], C, I.x0 + I.dir * 45);
      if (I.landX == null) I.landX = clamp(I.x0 + I.dir * (I.kind === 'punt' ? 45 : 62), -9, 109);
    }
    return I;
  }
  function verb(I) {
    var y = function (n) { return (n > 0 ? '' : '') + n + ' yd' + (Math.abs(n) === 1 ? '' : 's'); };
    var S = shortN, h = '';
    var gain = I.nullX != null ? Math.round((I.nullX - I.x0) * I.dir) : I.yds;   // a play wiped out by a flag: the yards it gained before the flag
    switch (I.kind) {
      case 'pass':
        if (I.int) h = (I.passer ? S(I.passer) + ' intercepted' : 'Interception') + (I.picker ? ' by ' + S(I.picker) : '');
        else if (/incomplete/i.test(I.tx)) h = (I.passer ? S(I.passer) + ' incomplete' : 'Incomplete') + (I.target ? ', intended for ' + S(I.target) : '');
        else h = (I.passer ? S(I.passer) : 'Pass') + (I.target ? ' to ' + S(I.target) : ' complete') + ', ' + y(gain);
        break;
      case 'run': h = (I.rusher ? S(I.rusher) : 'Run') + ' ' + (I.gap === 'middle' ? 'up the middle' : I.side + ' ' + I.gap) + ', ' + y(gain); break;
      case 'scramble': h = (I.rusher || I.passer ? S(I.rusher || I.passer) : 'QB') + ' scrambles, ' + y(gain); break;
      case 'kneel': h = (I.passer || I.rusher ? S(I.passer || I.rusher) : 'QB') + ' takes a knee'; break;
      case 'spike': h = (I.passer ? S(I.passer) : 'QB') + ' spikes it'; break;
      case 'sack': h = (I.sacker ? S(I.sacker) + ' sacks ' + (I.passer ? S(I.passer) : 'the QB') : (I.passer ? S(I.passer) : 'QB') + ' sacked') + ', ' + y(gain); break;
      case 'punt': h = (I.punter ? S(I.punter) : 'Punt') + (I.kickYds != null ? ' punts ' + I.kickYds : ' punts') + (I.returner && !I.fair ? ', ' + S(I.returner) + ' returns it' : I.fair ? ', fair catch' : I.touchback ? ', touchback' : ''); break;
      case 'kickoff': h = (I.kicker ? S(I.kicker) + ' kicks off' : 'Kickoff') + (I.touchback ? ', touchback' : I.returner ? ', ' + S(I.returner) + ' returns it' : ''); break;
      case 'fg': h = (I.kicker ? S(I.kicker) + ' ' : '') + (I.fgYds ? I.fgYds + '-yd ' : '') + 'field goal ' + (I.blocked ? 'is blocked' : I.fgGood ? 'is good' : 'is no good'); break;
      case 'xp': h = (I.kicker ? S(I.kicker) + ' ' : '') + 'extra point ' + (I.xp === 'miss' ? 'is no good' : 'is good'); break;
      default: h = 'Flag';
    }
    if (I.fumble) h += I.fumOpp ? ', fumble lost' : ', fumble recovered';
    if (I.td) h += ', TOUCHDOWN';
    if (I.safety) h += ', SAFETY';
    if (I.penalty && I.kind !== 'penalty') h = 'Flag: ' + (I.foul || 'penalty') + (I.noPlay ? ', no play' : '') + ' (' + h + ')';
    else if (I.kind === 'penalty') h = 'Flag: ' + (I.foul || 'penalty') + (I.penTeam ? ' on ' + I.penTeam : '') + (I.penYds ? ', ' + I.penYds + ' yds' : '');
    return h;
  }
  function tagOf(I) {
    var k = {pass: I.int ? 'Interception' : /incomplete/i.test(I.tx) ? 'Pass incomplete' : 'Pass', run: 'Run', scramble: 'Scramble', kneel: 'Kneel', spike: 'Spike', sack: 'Sack', punt: 'Punt',
      kickoff: 'Kickoff', fg: 'Field goal', xp: 'Extra point', penalty: 'Penalty'}[I.kind] || 'Play';
    if (I.two) k = 'Two-point try';
    var d = I.kind === 'pass' && I.side ? ' · ' + (I.deep ? 'deep ' : 'short ') + I.side : I.kind === 'run' && I.side ? ' · ' + (I.gap === 'middle' ? 'up the middle' : I.side + ' ' + I.gap) : '';
    return k + d;
  }
  function names(I) { return [I.passer, I.target, I.rusher, I.picker, I.sacker, I.punter, I.kicker, I.returner, I.recoverer].filter(Boolean); }

  // ── formations (offense-relative: u = yards downfield, v = yards to the offense's right) ─────────────────────────
  // offense: 0 LT 1 LG 2 C 3 RG 4 RT 5 QB 6 RB 7 TE 8 X (wide left) 9 slot 10 Z (wide right)
  // defense: 0-3 line, 4-6 linebackers, 7 corner on X, 8 corner on Z, 9-10 safeties
  function formation(kind, I) {
    var gun = I && I.shotgun, ytg = I ? I.ytg : 50;
    var deepS = clamp(ytg + 8, 4, 14);
    if (kind === 'punt') return {
      o: [[-.6, -4], [-.6, -2], [-.6, 0], [-.6, 2], [-.6, 4], [-14, 0], [-6, -1.6], [-1, -6], [-.8, -22], [-6, 1.6], [-.8, 22]],
      d: [[1, -4], [1, -1.4], [1, 1.4], [1, 4], [3, -8], [3, 8], [7, 0], [1.5, -21], [1.5, 21], [22, -7], [clamp((I.landX - I.x0) * I.dir, 25, 60), 0]]};
    if (kind === 'fg' || kind === 'xp') return {
      o: [[-.6, -4], [-.6, -2], [-.6, 0], [-.6, 2], [-.6, 4], [-7, .4], [-10, -2.5], [-.7, -6], [-1.4, -7.4], [-.7, 6], [-1.4, 7.4]],
      d: [[1, -5], [1, -2], [1, 2], [1, 5], [1.2, -7], [1.2, 7], [3, -3], [3, 3], [5, 0], [6, -13], [6, 13]]};
    if (kind === 'kickoff') {
      var o = [], v = [-23, -18, -13, -8, -3.5, 3.5, 8, 13, 18, 23];
      for (var i = 0; i < 11; i++) o.push(i === 5 ? [-7, 0] : [-1, v[i < 5 ? i : i - 1]]);
      var land = I ? clamp((I.landX - I.x0) * I.dir, 40, 75) : 62;
      return {o: o, d: [[12, -14], [12, -5], [12, 5], [12, 14], [20, -18], [20, 0], [20, 18], [land - 14, -10], [land - 14, 10], [land - 8, -4], [land, 0]]};
    }
    var qb = gun ? [-5, 0] : [-1.3, 0], rb = gun ? [-5, 2.2] : [-7, 0];
    return {
      o: [[-.6, -4.2], [-.6, -2.1], [-.6, 0], [-.6, 2.1], [-.6, 4.2], qb, rb, [-1, 6.4], [-.8, -20], [-1, -12], [-.8, 19]],
      d: [[1.1, -5], [1.1, -1.7], [1.1, 1.7], [1.1, 5], [5, -4.5], [5.5, 0], [5, 4.5], [Math.min(7, deepS), -19.5], [Math.min(7, deepS), 18.5],
          [Math.min(12, deepS), -9], [Math.min(13.5, deepS), 8.5]]};
  }

  // ── the plan: every actor's path and the ball through one play ─────────────────────────────────────────────────
  function Plan(I) {
    this.I = I; this.x0 = I.x0; this.dir = I.dir;
    this.act = {}; this.ball = []; this.lab = {}; this.raw = {}; this.trail = []; this.ev = []; this.kind = I.kind;
    this.oP = I.offAway ? 'A' : 'H'; this.dP = I.offAway ? 'H' : 'A';
  }
  Plan.prototype.O = function (i) { return this.oP + i; };
  Plan.prototype.D = function (i) { return this.dP + i; };
  Plan.prototype.xy = function (u, v) { return [clamp(this.x0 + this.dir * u, -9.6, 109.6), clamp(MID + this.dir * v, -1, FW + 1)]; };
  Plan.prototype.uv = function (x, y) { return [(x - this.x0) * this.dir, (y - MID) * this.dir]; };
  Plan.prototype.set = function (key, pts) { var me = this; this.act[key] = pts.map(function (q) { return [q[0]].concat(me.xy(q[1], q[2])); }); return this; };
  Plan.prototype.at = function (key, t) { return posAt(this.act[key], t); };
  Plan.prototype.f = function (key) { var a = this.act[key][0]; return this.uv(a[1], a[2]); };
  Plan.prototype.carry = function (t0, t1, key) { this.ball.push({t0: t0, t1: t1, key: key}); };
  Plan.prototype.fly = function (t0, t1, a, b, arc, h0, h1) { this.ball.push({t0: t0, t1: t1, a: a, b: b, arc: arc || 0, h0: h0 || 0, h1: h1 || 0}); };
  Plan.prototype.flyUV = function (t0, t1, a, b, arc, h0, h1) { this.fly(t0, t1, this.xy(a[0], a[1]), this.xy(b[0], b[1]), arc, h0, h1); };
  Plan.prototype.label = function (key, txt) { if (txt) { this.lab[key] = shortN(txt); this.raw[key] = txt; } };
  function posAt(P, t) {
    if (!P || !P.length) return null;
    if (t <= P[0][0]) return [P[0][1], P[0][2]];
    for (var i = 1; i < P.length; i++) if (t <= P[i][0]) {
      var a = P[i - 1], b = P[i], s = (t - a[0]) / ((b[0] - a[0]) || 1);
      return [a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
    var z = P[P.length - 1]; return [z[1], z[2]];
  }
  function ballAt(pl, t) {
    var B = pl.ball, seg = null;
    for (var i = 0; i < B.length; i++) { if (B[i].t0 <= t) seg = B[i]; }
    if (!seg) seg = B[0];
    if (!seg) return [pl.x0, MID, 0];
    var tt = clamp(t, seg.t0, seg.t1);
    if (seg.key) { var p = pl.at(seg.key, tt); return [p[0], p[1], 0.3]; }
    var s = (tt - seg.t0) / ((seg.t1 - seg.t0) || 1);
    return [seg.a[0] + (seg.b[0] - seg.a[0]) * s, seg.a[1] + (seg.b[1] - seg.a[1]) * s, seg.h0 + (seg.h1 - seg.h0) * s + seg.arc * 4 * s * (1 - s)];
  }
  // everyone at his spot in the formation, still
  function base(pl, F) {
    for (var i = 0; i < 11; i++) { pl.set(pl.O(i), [[0, F.o[i][0], F.o[i][1]]]); pl.set(pl.D(i), [[0, F.d[i][0], F.d[i][1]]]); }
  }
  // the line: pass sets back, run blocks drive forward
  function block(pl, push, t1) {
    for (var i = 0; i < 5; i++) { var f = pl.f(pl.O(i)); pl.set(pl.O(i), [[0, f[0], f[1]], [SNAP, f[0], f[1]], [SNAP + .16, f[0] + push * .6, f[1]], [t1 || .9, f[0] + push, f[1] + (push > 0 ? 0 : (i - 2) * .3)]]); }
  }
  // the defense flows to the ball: the nearest arrive first, the rest close in from where they started
  function pursue(pl, keys, E, tMid, tEnd, back, tGo) {
    var ranked = keys.map(function (k) { var f = pl.f(k); return {k: k, f: f, d: Math.hypot(f[0] - E[0], f[1] - E[1])}; }).sort(function (a, b) { return a.d - b.d; });
    var R = [1.1, 1.9, 2.8, 3.6, 4.6, 5.8, 7, 8.4, 9.6, 11, 12.5];
    ranked.forEach(function (r, i) {
      var dx = r.f[0] - E[0], dy = r.f[1] - E[1], n = Math.hypot(dx, dy) || 1, rr = R[i] || 12;
      var end = [E[0] + dx / n * rr, E[1] + dy / n * rr];
      var mid = [r.f[0] + (end[0] - r.f[0]) * .45 + (back || 0) * (r.f[0] > 3 ? 1 : 0), r.f[1] + (end[1] - r.f[1]) * .45];
      pl.set(r.k, [[0, r.f[0], r.f[1]], [tGo || SNAP, r.f[0], r.f[1]], [tMid, mid[0], mid[1]], [tEnd, end[0], end[1]]]);
    });
  }
  function route(pl, key, type, t0, t1) {
    var f = pl.f(key), s = f[1] >= 0 ? 1 : -1, P = [[0, f[0], f[1]], [t0, f[0], f[1]]], m = t0 + (t1 - t0) * .6;
    var add = function (t, u, v) { P.push([t, u, clamp(v, -25, 25)]); };
    if (type === 'go') { add(m, 12, f[1] - s); add(t1, 22, f[1] - s * 1.5); }
    else if (type === 'curl') { add(m, 11, f[1]); add(t1, 9, f[1] - s * 1.5); }
    else if (type === 'out') { add(m, 6, f[1]); add(t1, 7, f[1] + s * 7); }
    else if (type === 'in') { add(m, 6, f[1]); add(t1, 7, f[1] - s * 10); }
    else if (type === 'post') { add(m, 10, f[1]); add(t1, 22, f[1] - s * 10); }
    else if (type === 'corner') { add(m, 10, f[1]); add(t1, 20, f[1] + s * 8); }
    else if (type === 'flat') { add(m, 1, f[1] + s * 3); add(t1, 3, f[1] + s * 9); }
    else if (type === 'drag') { add(m, 2, f[1] - s * 3); add(t1, 3, -f[1] * .7); }
    else if (type === 'block') { add(m, f[0] + .5, f[1] * .8); add(t1, f[0] + .8, f[1] * .8); }
    pl.set(key, P);
    pl.trail.push({key: key, t0: t0, t1: t1, dim: true});
  }
  function corners(pl, tEnd) {
    // corners mirror the outside receivers a step behind, safeties drop
    [[7, 8], [8, 10]].forEach(function (pr) {
      var c = pl.D(pr[0]), w = pl.act[pl.O(pr[1])], f = pl.f(c);
      if (!w) return;
      var P = [[0, f[0], f[1]], [SNAP, f[0], f[1]]];
      w.forEach(function (q) { if (q[0] > SNAP) { var uv = pl.uv(q[1], q[2]); P.push([Math.min(q[0] + .05, tEnd), uv[0] + 1.6, uv[1] + (uv[1] > 0 ? -1 : 1)]); } });
      pl.set(c, P);
    });
  }

  function planPass(pl, I) {
    var F = formation('scrim', I); base(pl, F);
    var inc = /incomplete/i.test(I.tx), sv = I.side === 'left' ? -1 : I.side === 'right' ? 1 : 0;
    var G = I.nullX != null ? (I.nullX - I.x0) * I.dir : I.G;
    var tThrow = I.deep ? .44 : .36, tCatch = tThrow + (I.deep ? .2 : .11), tEnd = .88;
    var air;
    if (I.catchX != null) air = (I.catchX - I.x0) * I.dir;
    else if (I.int && I.intX != null) air = (I.intX - I.x0) * I.dir;
    else if (I.throwX != null) air = (I.throwX - I.x0) * I.dir;
    else if (inc || I.int) air = I.deep ? 24 : 7;
    else if (G <= 1) air = Math.min(G, -1);
    else air = I.deep ? Math.min(G, Math.max(16, G * .7)) : Math.min(G, clamp(G * .55, 1, 9));
    air = Math.min(air, I.ytg + 6);
    var tgt = sv < 0 ? (I.deep ? 8 : 9) : sv > 0 ? (I.deep ? 10 : 7) : (I.deep ? 9 : 7);
    if (G <= 1 && !inc && !I.int) tgt = 6;
    var tk = pl.O(tgt), f = pl.f(tk);
    var cv = sv === 0 ? clamp(f[1] * .25, -4, 4) : sv * (I.deep ? 14 : 10);
    if (tgt === 6) cv = sv ? sv * 6 : 3;
    var C = [air, cv];
    // routes: the target's to the catch point, the others decoys
    var stem = I.deep ? [Math.max(2, air - 7), f[1] + (cv - f[1]) * .2] : [Math.max(1, air - 2), f[1] + (cv - f[1]) * .35];
    pl.set(tk, [[0, f[0], f[1]], [SNAP, f[0], f[1]], [tThrow - .03, stem[0], stem[1]], [tCatch, C[0], C[1]]]);
    pl.trail.push({key: tk, t0: SNAP, t1: tCatch, hot: true});
    var decoy = {8: I.deep ? 'post' : 'go', 9: 'drag', 10: 'curl', 7: 'flat', 6: 'block'};
    [6, 7, 8, 9, 10].forEach(function (i) { if (i !== tgt) route(pl, pl.O(i), decoy[i], SNAP, tEnd); });
    // QB: the drop, the throw, a step
    var q = pl.f(pl.O(5));
    pl.set(pl.O(5), [[0, q[0], q[1]], [SNAP, q[0], q[1]], [tThrow - .06, Math.min(q[0], -1) - (I.shotgun ? 2.2 : 6), q[1]], [tThrow, Math.min(q[0], -1) - (I.shotgun ? 2 : 5.6), q[1]], [tEnd, Math.min(q[0], -1) - (I.shotgun ? 1.2 : 4.6), q[1]]]);
    pl.label(pl.O(5), I.passer); pl.label(tk, I.target);
    block(pl, -1.3, tEnd);
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .05, [0, 0], [q[0], q[1]], .4);
    pl.carry(SNAP + .05, tThrow, pl.O(5));
    var qa = pl.at(pl.O(5), tThrow);
    // the defense: the line rushes, linebackers drop, corners mirror
    [0, 1, 2, 3].forEach(function (i) { var d = pl.f(pl.D(i)); pl.set(pl.D(i), [[0, d[0], d[1]], [SNAP, d[0], d[1]], [tThrow, -2.2 - (i % 2), d[1] * .6], [tEnd, -1, d[1] * .5]]); });
    [4, 5, 6].forEach(function (i) { var d = pl.f(pl.D(i)); pl.set(pl.D(i), [[0, d[0], d[1]], [SNAP, d[0], d[1]], [tThrow, d[0] + 3, d[1] * 1.2]]); });
    corners(pl, tCatch);
    var Ca = pl.xy(C[0], C[1]);
    pl.trail.push({ball: true, t0: tThrow, t1: tCatch, a: qa, b: Ca, arc: I.deep ? 7 : 2.4});
    if (I.int) {
      var picker = pl.D(sv < 0 ? 9 : sv > 0 ? 10 : 9);
      if (!I.deep) picker = pl.D(sv < 0 ? 7 : sv > 0 ? 8 : 5);
      var pf = pl.f(picker), E = pl.uv(I.x1, MID + (Ca[1] - MID) * .5);
      pl.set(picker, [[0, pf[0], pf[1]], [SNAP, pf[0], pf[1]], [tCatch, C[0] + .6, C[1] + .3], [tEnd, E[0], E[1]]]);
      pl.label(picker, I.picker || 'INT');
      pl.trail.push({key: picker, t0: tCatch, t1: tEnd, hot: true, flip: true});
      pl.fly(tThrow, tCatch, qa, pl.xy(C[0] + .6, C[1] + .3), I.deep ? 7 : 2.4);
      pl.carry(tCatch, tEnd, picker);
      pl.ev.push({t: tCatch, cap: 'Intercepted!', flip: true});
      // the offense turns to tackle
      for (var i = 0; i < 11; i++) {
        var a = pl.act[pl.O(i)], last = a[a.length - 1], uv = pl.uv(last[1], last[2]);
        a.push([Math.max(last[0] + .02, .95)].concat(pl.xy((uv[0] + E[0]) / 2, (uv[1] + E[1]) / 2)));
      }
      pl.hi = picker;
      return;
    }
    if (inc) {
      var over = pl.xy(C[0] + 2.5, C[1] + sv * 1.5);
      pl.fly(tThrow, tCatch + .06, qa, over, I.deep ? 7 : 2.4, 0, 0);
      pl.fly(.9, .97, over, [I.x1, MID], 0, 0, 0);
      pl.ev.push({t: tCatch, cap: 'Incomplete'});
      pursue(pl, [pl.D(9), pl.D(10)], C, tThrow, tCatch + .05);
      pl.hi = tk; return;
    }
    pl.fly(tThrow, tCatch, qa, Ca, I.deep ? 7 : 2.4);
    var Eu = (I.nullX != null ? (I.nullX - I.x0) * I.dir : I.G);
    var E2 = [Eu + (I.td ? .3 : 0), clamp(cv * .55, -22, 22)];
    var tk2 = pl.act[tk]; tk2.push([tEnd].concat(pl.xy(E2[0], E2[1])));
    pl.trail.push({key: tk, t0: tCatch, t1: tEnd, hot: true, rac: true});
    pl.carry(tCatch, tEnd, tk);
    pl.ev.push({t: tCatch, cap: 'Caught'});
    pursue(pl, [pl.D(7), pl.D(8), pl.D(9), pl.D(10), pl.D(4), pl.D(6)], E2, tCatch, tEnd + .02);
    pl.hi = tk;
    if (I.fumble) fumbleTail(pl, I, tk, tEnd);
  }
  function planRun(pl, I) {
    var F = formation('scrim', I); base(pl, F);
    var sv = I.side === 'left' ? -1 : I.side === 'right' ? 1 : 0;
    var gapV = I.gap === 'middle' ? 0 : I.gap === 'guard' ? 2.2 : I.gap === 'tackle' ? 4.4 : 7.5;
    gapV *= sv || 1; if (!sv) gapV = I.gap === 'middle' ? 0 : 1.5;
    var G = I.nullX != null ? (I.nullX - I.x0) * I.dir : I.G;
    var tH = .26, tHole = .42, tEnd = .88;
    var rb = pl.O(6), qk = pl.O(5), r = pl.f(rb), q = pl.f(qk);
    var H = [Math.min(q[0], -1) - 1.5, gapV * .2];
    var hole = [G < 0 ? Math.max(G * .5, -2) : .6, gapV];
    var E = [G + (I.td ? .3 : 0), clamp(gapV * 1.2, -24, 24)];
    pl.set(rb, [[0, r[0], r[1]], [SNAP, r[0], r[1]], [tH, H[0], H[1] + .4], [tHole, hole[0], hole[1]], [tEnd, E[0], E[1]]]);
    pl.set(qk, [[0, q[0], q[1]], [SNAP, q[0], q[1]], [tH, H[0], H[1] - .4], [.6, H[0] - 1, -gapV * .5 - (sv || 1) * 2.5]]);
    pl.label(rb, I.rusher); pl.hi = rb;
    pl.trail.push({key: rb, t0: tH, t1: tEnd, hot: true});
    block(pl, G < 0 ? .4 : 1.6, tEnd);
    pl.set(pl.O(7), [[0, pl.f(pl.O(7))[0], pl.f(pl.O(7))[1]], [SNAP, pl.f(pl.O(7))[0], pl.f(pl.O(7))[1]], [.5, 1.6, pl.f(pl.O(7))[1] + .8]]);
    [8, 9, 10].forEach(function (i) { var f = pl.f(pl.O(i)); pl.set(pl.O(i), [[0, f[0], f[1]], [SNAP, f[0], f[1]], [.55, 6, f[1] * .9], [tEnd, 8, f[1] * .8]]); });
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .05, [0, 0], [q[0], q[1]], .3);
    pl.carry(SNAP + .05, tH, qk); pl.carry(tH, tEnd, rb);
    var keys = []; for (var i = 0; i < 11; i++) keys.push(pl.D(i));
    pursue(pl, keys, E, tHole, tEnd + .02, -1);
    if (I.fumble) fumbleTail(pl, I, rb, tEnd);
  }
  function planQB(pl, I) {                              // scramble, kneel, spike
    var F = formation('scrim', I); base(pl, F);
    var qk = pl.O(5), q = pl.f(qk), tEnd = .86, G = I.G;
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .05, [0, 0], [q[0], q[1]], .3);
    if (I.kind === 'kneel' || I.kind === 'spike') {
      pl.set(qk, [[0, q[0], q[1]], [SNAP, q[0], q[1]], [.4, Math.min(q[0], G), q[1]]]);
      pl.carry(SNAP + .05, 1, qk); pl.label(qk, I.passer || I.rusher); pl.hi = qk;
      if (I.kind === 'spike') pl.flyUV(.4, .5, [Math.min(q[0], G), 0], [Math.min(q[0], G) + .5, 0], 0, 1, 0);
      return;
    }
    var sv = I.side === 'left' ? -1 : I.side === 'right' ? 1 : 0, out = sv * 8;
    var E = [G + (I.td ? .3 : 0), clamp(out * 1.3, -24, 24)];
    pl.set(qk, [[0, q[0], q[1]], [SNAP, q[0], q[1]], [.32, Math.min(q[0], -1) - 2.5, 0], [.48, -2.5, out], [tEnd, E[0], E[1]]]);
    pl.label(qk, I.rusher || I.passer); pl.hi = qk;
    pl.trail.push({key: qk, t0: SNAP, t1: tEnd, hot: true});
    pl.carry(SNAP + .05, tEnd, qk);
    [7, 8, 9, 10].forEach(function (i, j) { route(pl, pl.O(i), ['flat', 'go', 'in', 'curl'][j], SNAP, tEnd); });
    block(pl, -1.2, tEnd);
    var keys = []; for (var i = 0; i < 11; i++) keys.push(pl.D(i));
    pursue(pl, keys, E, .48, tEnd + .02);
  }
  function planSack(pl, I) {
    var F = formation('scrim', I); base(pl, F);
    var qk = pl.O(5), q = pl.f(qk), tSack = .62;
    var G = Math.min(I.G, -.5), S = [G, 0];
    pl.set(qk, [[0, q[0], q[1]], [SNAP, q[0], q[1]], [.34, Math.min(q[0], -1) - (I.shotgun ? 2.2 : 6), 0], [tSack, S[0], S[1] + .3]]);
    pl.label(qk, I.passer);
    var sk = pl.D(2), d = pl.f(sk);
    pl.set(sk, [[0, d[0], d[1]], [SNAP, d[0], d[1]], [.38, -.8, d[1] + 2.2], [tSack, S[0] + .9, S[1] - .4], [.8, S[0] + .5, S[1] - .2]]);
    pl.label(sk, I.sacker || 'Sack'); pl.hi = sk;
    pl.trail.push({key: sk, t0: SNAP, t1: tSack, hot: true, flip: true});
    [0, 1, 3].forEach(function (i) { var x = pl.f(pl.D(i)); pl.set(pl.D(i), [[0, x[0], x[1]], [SNAP, x[0], x[1]], [.5, -1.6, x[1] * .7], [.8, S[0] + 2.4, x[1] * .3]]); });
    [7, 8, 9, 10].forEach(function (i, j) { route(pl, pl.O(i), ['flat', 'go', 'in', 'curl'][j], SNAP, .8); });
    route(pl, pl.O(6), 'block', SNAP, .6);
    block(pl, -2, tSack);
    [4, 5, 6].forEach(function (i) { var x = pl.f(pl.D(i)); pl.set(pl.D(i), [[0, x[0], x[1]], [SNAP, x[0], x[1]], [.45, x[0] + 3, x[1]], [.85, S[0] + 4, x[1] * .5]]); });
    corners(pl, .7);
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .05, [0, 0], [q[0], q[1]], .3);
    pl.carry(SNAP + .05, 1, qk);
    pl.ev.push({t: tSack, cap: 'Sacked', shake: true});
    if (I.fumble) fumbleTail(pl, I, qk, tSack);
  }
  function fumbleTail(pl, I, carrier, t) {
    var at = pl.at(carrier, t);
    var fx = I.fumX != null ? I.fumX : at[0];
    var loose = [fx + I.dir * 1.5, at[1] + 1.4];
    pl.ball = pl.ball.filter(function (b) { return b.t0 < t - .1; });
    pl.ball.forEach(function (b) { if (b.t1 > t - .1) b.t1 = t - .1; });
    pl.carry(Math.max(0, t - .1), t - .02, carrier);
    var held = pl.at(carrier, t - .02);
    pl.fly(t - .02, t + .06, held, loose, .9);
    var recK = I.fumOpp ? pl.D(4) : pl.O(1), rf = pl.f(recK), lu = pl.uv(loose[0], loose[1]);
    var endUV = pl.uv(I.x1, loose[1]);
    pl.set(recK, [[0, rf[0], rf[1]], [SNAP, rf[0], rf[1]], [t, lu[0] + .5, lu[1] + .5], [t + .06, lu[0], lu[1]], [.95, endUV[0], endUV[1]]]);
    pl.carry(t + .06, .95, recK);
    pl.label(recK, I.recoverer || 'Recovers');
    pl.ev.push({t: t, cap: 'Fumble!', shake: true});
    if (I.fumOpp) pl.ev.push({t: t + .06, cap: 'Turnover', flip: true});
    pl.hi = recK;
  }
  function planPunt(pl, I) {
    var F = formation('punt', I); base(pl, F);
    var tKick = .32, tLand = .64, tEnd = .9, pk = pl.O(5), p = pl.f(pk);
    var L = pl.uv(I.landX, I.oob ? FW + .5 : MID + 3 * pl.dir);
    var ret = pl.D(10), rf = pl.f(ret);
    pl.set(pk, [[0, p[0], p[1]], [SNAP, p[0], p[1]], [tKick, p[0] + 1.5, p[1]], [tEnd, p[0] + 6, p[1]]]);
    pl.label(pk, I.punter); pl.label(ret, I.returner);
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .1, [0, 0], [p[0] + .5, 0], .5);
    pl.carry(SNAP + .1, tKick, pk);
    var Ka = pl.at(pk, tKick), La = pl.xy(L[0], L[1]);
    pl.fly(tKick, tLand, Ka, La, I.blocked ? 1 : 18, .4, 0);
    pl.trail.push({ball: true, t0: tKick, t1: tLand, a: Ka, b: La, arc: 18});
    var E = pl.uv(I.x1, La[1]);
    var returned = !I.fair && !I.touchback && !I.oob && Math.abs(I.x1 - I.landX) > .8;
    pl.set(ret, [[0, rf[0], rf[1]], [SNAP, rf[0], rf[1]], [tLand, L[0], L[1]], [returned ? tEnd : tLand + .02, returned ? E[0] : L[0], returned ? E[1] : L[1]]]);
    if (returned) { pl.carry(tLand, tEnd, ret); pl.trail.push({key: ret, t0: tLand, t1: tEnd, hot: true, flip: true}); pl.hi = ret; }
    else pl.fly(tLand, .96, La, [I.x1, MID], 0, 0, 0);
    // coverage runs down, the return team sets up
    var cov = []; for (var i = 0; i < 11; i++) if (i !== 5) cov.push(pl.O(i));
    pursue(pl, cov, returned ? E : L, tLand - .05, tEnd + .03);
    for (var j = 0; j < 10; j++) { var k = pl.D(j), d = pl.f(k); pl.set(k, [[0, d[0], d[1]], [SNAP, d[0], d[1]], [tLand, d[0] + (L[0] - d[0]) * .55, d[1] * .7], [tEnd, d[0] + (E[0] - d[0]) * .7, d[1] * .5]]); }
    pl.ev.push({t: tKick, cap: 'Punt'});
    if (I.fumble) fumbleTail(pl, I, ret, tLand + .08);
  }
  function planKick(pl, I) {
    var F = formation('kickoff', I); base(pl, F);
    var tKick = .2, tLand = .54, tEnd = .9, kk = pl.O(5), k = pl.f(kk);
    pl.set(kk, [[0, k[0], k[1]], [tKick, -.3, 0], [tEnd, 20, 0]]);
    pl.label(kk, I.kicker);
    pl.fly(0, tKick, pl.xy(0, 0), pl.xy(0, 0), 0, .2, .2);
    var land = I.landX, La = [land, MID + 4 * pl.dir];
    pl.fly(tKick, tLand, pl.xy(0, 0), La, 15, .2, 0);
    pl.trail.push({ball: true, t0: tKick, t1: tLand, a: pl.xy(0, 0), b: La, arc: 15});
    var ret = pl.D(10), rf = pl.f(ret), L = pl.uv(La[0], La[1]);
    var returned = !I.touchback && !I.fair && Math.abs(I.x1 - land) > .8;
    var E = pl.uv(I.x1, MID + 2 * pl.dir);
    pl.set(ret, [[0, rf[0], rf[1]], [tKick, rf[0], rf[1]], [tLand, L[0], L[1]], [returned ? tEnd : tLand + .02, returned ? E[0] : L[0], returned ? E[1] : L[1]]]);
    pl.label(ret, I.returner);
    if (returned) { pl.carry(tLand, tEnd, ret); pl.trail.push({key: ret, t0: tLand, t1: tEnd, hot: true, flip: true}); pl.hi = ret; }
    else pl.fly(tLand, .96, La, [I.x1, MID], 0, 0, 0);
    var cov = []; for (var i = 0; i < 11; i++) if (i !== 5) cov.push(pl.O(i));
    pl.ev.push({t: tKick, cap: 'Kickoff'});
    pursue(pl, cov, returned ? E : L, tLand, tEnd + .03, 0, tKick - .02);
    for (var j = 0; j < 10; j++) { var kj = pl.D(j), d = pl.f(kj); pl.set(kj, [[0, d[0], d[1]], [tKick, d[0], d[1]], [tLand, d[0] + (L[0] - d[0]) * .4, d[1] * .8], [tEnd, d[0] + (E[0] - d[0]) * .5, d[1] * .6]]); }
  }
  function planFG(pl, I) {
    var F = formation('fg', I); base(pl, F);
    var hk = pl.O(5), kk = pl.O(6), h = pl.f(hk), k = pl.f(kk), tKick = .34, tPost = .74;
    pl.set(kk, [[0, k[0], k[1]], [.2, k[0], k[1]], [tKick, h[0] - .6, h[1] - .5], [.6, h[0] + 1.5, h[1]]]);
    pl.set(hk, [[0, h[0], h[1]]]);
    pl.label(kk, I.kicker); pl.hi = kk;
    pl.carry(0, SNAP, pl.O(2)); pl.flyUV(SNAP, SNAP + .08, [0, 0], [h[0], h[1]], .4);
    pl.carry(SNAP + .08, tKick, hk);
    var goalU = I.ytg + 10;                 // the uprights stand on the end line
    var good = I.kind === 'xp' ? I.xp !== 'miss' : I.fgGood;
    var wv = good ? 0 : I.blocked ? 0 : (I.wide || (I.id.charCodeAt(I.id.length - 1) % 2 ? 1 : -1)) * 5.2;
    var Ka = pl.at(hk, tKick);
    if (I.blocked) {
      var bl = pl.xy(1.5, .5), dn = pl.xy(-4, 2);
      pl.fly(tKick, tKick + .06, Ka, bl, .8, .2, 1.4); pl.fly(tKick + .06, .7, bl, dn, 1.5, 1.4, 0);
      pl.ev.push({t: tKick + .06, cap: 'Blocked!', shake: true});
    } else {
      var P = pl.xy(goalU, wv), past = pl.xy(goalU + 4, wv * 1.2);
      pl.fly(tKick, tPost, Ka, P, 4, .2, 6.5);
      pl.fly(tPost, .86, P, past, 0, 6.5, 2);
      pl.trail.push({ball: true, t0: tKick, t1: tPost, a: Ka, b: P, arc: 4, h0: .2, h1: 6.5});
      pl.ev.push({t: tPost, cap: good ? 'It is good!' : 'No good', good: good ? 1 : -1});
    }
    pl.fly(.9, .97, pl.xy(goalU + 4, wv * 1.2), [I.x1, MID], 0, 0, 0);
    [0, 1, 2, 3, 4, 5].forEach(function (i) { var d = pl.f(pl.D(i)); pl.set(pl.D(i), [[0, d[0], d[1]], [SNAP, d[0], d[1]], [tKick, -.4, d[1] * .8], [.7, -1.2, d[1] * .7]]); });
    block(pl, -.6, .6);
  }
  function planFlag(pl, I) {
    var F = formation('scrim', I); base(pl, F);
    var who = /false start|illegal (formation|shift|motion)/i.test(I.foul || '') ? pl.O(4) : /offside|encroach|neutral zone/i.test(I.foul || '') ? pl.D(3) : null;
    if (who) { var f = pl.f(who); pl.set(who, [[0, f[0], f[1]], [.18, f[0], f[1]], [.26, f[0] + (who.charAt(0) === pl.oP ? .9 : -1.4), f[1]], [.5, f[0], f[1]]]); pl.hi = who; }
    pl.carry(0, .6, pl.O(2));
    pl.fly(.62, .92, [I.x0, MID], [I.x1, MID], 0, .2, 0);
  }
  function flagOn(pl, I, t) {
    var side = -1.5 * pl.dir;
    pl.flag = {t: t, a: [I.x0 - pl.dir * 6, side < 0 ? -2 : FW + 2], b: [I.x0 + pl.dir * 1.2, MID + (pl.dir > 0 ? -5 : 5)]};
    pl.ev.push({t: t + .08, cap: 'Flag on the play', flag: true});
    if (I.noPlay) {
      // the ball comes back: no play
      var B = pl.ball, last = ballAt(pl, .9);
      pl.fly(.93, .99, [last[0], last[1]], [I.x1, MID], .3, last[2], 0);
      void B;
    }
  }
  function build(I) {
    var pl = new Plan(I);
    switch (I.kind) {
      case 'pass': planPass(pl, I); break;
      case 'run': planRun(pl, I); break;
      case 'scramble': case 'kneel': case 'spike': planQB(pl, I); break;
      case 'sack': planSack(pl, I); break;
      case 'punt': planPunt(pl, I); break;
      case 'kickoff': planKick(pl, I); break;
      case 'fg': case 'xp': planFG(pl, I); break;
      default: planFlag(pl, I);
    }
    if (I.penalty) flagOn(pl, I, I.kind === 'penalty' ? .2 : .55);
    // the ball finishes on ESPN's end spot, whatever happened on the way
    var z = ballAt(pl, 1);
    if (Math.abs(z[0] - I.x1) > .5 && !(I.kind === 'penalty')) pl.fly(.96, 1, [z[0], z[1]], [I.x1, z[1]], 0, z[2], 0);
    else if (I.kind === 'penalty' && Math.abs(z[0] - I.x1) > .5) pl.fly(.96, 1, [z[0], z[1]], [I.x1, MID], 0, 0, 0);
    if (I.td) pl.ev.push({t: .9, cap: 'TOUCHDOWN', td: I.scoreAway ? 'A' : 'H'});
    if (I.safety) pl.ev.push({t: .9, cap: 'SAFETY', td: I.scoreAway ? 'A' : 'H'});
    if (I.two) pl.ev.push({t: .94, cap: 'Two-point try ' + (I.twoOk ? 'is good' : 'fails')});
    else if (I.td && I.xp) pl.ev.push({t: .97, cap: 'TOUCHDOWN, XP ' + (I.xp === 'good' ? 'good' : 'no good'), td: I.scoreAway ? 'A' : 'H', keep: 1});
    var deep = I.kind === 'punt' || I.kind === 'kickoff' || (I.kind === 'pass' && I.deep) || Math.abs(I.G) > 25;
    pl.dur = I.kind === 'penalty' ? 1700 : I.kind === 'kneel' || I.kind === 'spike' ? 1400 : deep ? 3000 : I.kind === 'fg' || I.kind === 'xp' ? 2600 : 2300;
    pl.endX = I.x1;
    return pl;
  }

  // ── the field ───────────────────────────────────────────────────────────
  var CSS = [
    '.oxf{position:relative}',
    '.oxf-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
    '.oxf-dd{font:800 12px monospace;letter-spacing:.06em;color:#fff;background:rgba(99,91,255,.22);border:1px solid rgba(99,91,255,.55);border-radius:8px;padding:4px 8px}',
    '.oxf-rz{font:800 10px monospace;letter-spacing:.1em;color:#ff8a8a;border:1px solid rgba(255,138,138,.5);border-radius:8px;padding:4px 7px}',
    '.oxf-tag{font:800 10px monospace;letter-spacing:.1em;text-transform:uppercase;color:#d795ff}',
    '.oxf-fol{margin-left:auto;display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#e8e2f1;font:700 11px "Space Grotesk",system-ui,sans-serif;padding:6px 11px;cursor:pointer;min-height:32px}',
    '.oxf-fol i{width:7px;height:7px;border-radius:50%;background:#8f879c}',
    '.oxf-fol.on{border-color:rgba(97,233,112,.6);color:#fff}.oxf-fol.on i{background:#61e970;box-shadow:0 0 8px #61e970}',
    '.oxf-cap{display:flex;align-items:flex-start;gap:10px;min-height:40px;margin-bottom:6px}',
    '.oxf-cap b{flex:1;min-width:0;font:800 15px/1.3 "Space Grotesk",system-ui,sans-serif;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.oxf-cap span{padding-top:3px}',
    '.oxf-cap span{font:700 10px monospace;color:var(--text3,#8f879c);white-space:nowrap}',
    '.oxf-stage{position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(97,233,112,.22);background:#0d2416;max-width:1000px;margin:0 auto;contain:layout paint}',
    '.oxf-stage svg{display:block;width:100%;height:auto;touch-action:pan-y}',
    '.oxf-big{position:absolute;left:0;right:0;top:9%;text-align:center;font:900 clamp(18px,5.6vw,30px)/1.1 "Space Grotesk",system-ui,sans-serif;padding:0 10px;letter-spacing:.06em;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.8);opacity:0;transition:opacity .25s,transform .25s;transform:scale(.9);pointer-events:none}',
    '.oxf-big.on{opacity:1;transform:scale(1)}',
    '.oxf-rp{position:absolute;right:8px;bottom:8px;border:0;border-radius:999px;background:rgba(12,12,12,.72);color:#fff;font:700 11px "Space Grotesk",system-ui,sans-serif;padding:6px 10px;cursor:pointer;min-height:30px}',
    '.oxf-mine{display:none;margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(176,56,249,.55);background:rgba(176,56,249,.12);font-size:12.5px;color:#efeaf7}',
    '.oxf-mine.on{display:block}.oxf-mine b{color:#d795ff;font:800 10px monospace;letter-spacing:.1em;text-transform:uppercase;margin-right:6px}.oxf-mine em{font-style:normal;color:#61e970}',
    '.oxf-note{margin-top:6px;font-size:11px;color:var(--text3,#8f879c)}',
    '.oxf-ds{display:flex;align-items:center;gap:8px;margin:14px 0 6px;font-size:12.5px;color:#e8e2f1;flex-wrap:wrap}',
    '.oxf-ds img{width:20px;height:20px}.oxf-ds b{font-weight:800}.oxf-ds .r{margin-left:auto;font:800 10px monospace;letter-spacing:.08em;text-transform:uppercase;color:#d795ff}',
    '.oxf-ds .r.td{color:#61e970}.oxf-ds .r.to{color:#ff8a8a}',
    '.oxf-dc{display:flex;flex-direction:column;gap:3px}',
    '.oxf-dr{display:grid;grid-template-columns:62px minmax(0,1fr) 40px;gap:8px;align-items:center;min-height:26px;border:0;background:none;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;width:100%}',
    '.oxf-dr .dd{font:700 10px monospace;color:var(--text3,#8f879c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.oxf-dr .tk{position:relative;height:14px;border-radius:4px;background:repeating-linear-gradient(90deg,transparent 0 calc(8.333% - 1px),rgba(255,255,255,.08) calc(8.333% - 1px) 8.333%),#123d22;overflow:hidden}',
    '.oxf-dr .tk:before,.oxf-dr .tk:after{content:"";position:absolute;top:0;bottom:0;width:8.333%;background:var(--ez)}.oxf-dr .tk:before{left:0;background:var(--eza)}.oxf-dr .tk:after{right:0;background:var(--ezh)}',
    '.oxf-dr .tk i{position:absolute;top:3px;height:8px;border-radius:4px;background:#61e970;min-width:4px}',
    '.oxf-dr .tk i.l{background:#ff8a8a}.oxf-dr .tk i.p{background:repeating-linear-gradient(45deg,#ff8a8a 0 4px,#b038f9 4px 8px)}.oxf-dr .tk i.k{background:#d795ff}.oxf-dr .tk i.td{background:#b038f9;box-shadow:0 0 8px #b038f9}.oxf-dr .tk i.z{background:#8f879c}',
    '.oxf-dr .yd{font:800 11px monospace;text-align:right;color:#e8e2f1}',
    '.oxf-dr.on .tk{outline:2px solid #b038f9}',
    '.oxf-pl{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;width:100%;padding:8px 10px;border-radius:10px;background:var(--bg3,#18141c);border:1px solid var(--border2,rgba(255,255,255,.08));font:inherit;font-size:12.5px;color:inherit;text-align:left;cursor:pointer}',
    '.oxf-pl.on{border-color:#b038f9;background:rgba(176,56,249,.14)}',
    '.oxf-pl .t{font:700 10px monospace;color:var(--text3,#8f879c);white-space:nowrap}.oxf-pl .x{min-width:0;overflow-wrap:anywhere}',
    '.oxf-pl .go{font:800 10px monospace;letter-spacing:.06em;color:#d795ff;white-space:nowrap}',
    '.oxf-list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow-y:auto;margin-top:8px}',
    '.oxf-h{margin:16px 0 6px;font:800 11px monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--text3,#8f879c)}',
    '.oxf-lab{font:800 12px "Space Grotesk",system-ui,sans-serif;fill:#fff;stroke:rgba(8,6,10,.85);stroke-width:4px;paint-order:stroke;stroke-linejoin:round}',
    '.oxf-lab.me{fill:#d795ff}',
    '@keyframes oxfRz{0%,100%{opacity:.35}50%{opacity:.75}}',
    '.oxf-rzg{animation:oxfRz 2.2s ease-in-out infinite}',
    '@media (prefers-reduced-motion:reduce){.oxf-rzg{animation:none;opacity:.5}.oxf-big{transition:none}}'
  ].join('');
  function css() { if (document.getElementById('oxfCss')) return; var s = document.createElement('style'); s.id = 'oxfCss'; s.textContent = CSS; document.head.appendChild(s); }

  function create(g, s) {
    css();
    var F = {gid: g.gid, g: g, follow: lsGet(FOLLOW_KEY, '1') !== '0', queue: [], plays: [], byId: {}, lastId: null, cam: null, raf: 0, pl: null};
    var C = F.C = ctxOf(s, g);
    F.col = {A: tcol(g.away_color, '#7d5bd6'), H: tcol(g.home_color, '#b038f9')};
    if (cdist(F.col.A, F.col.H) < 90) F.col.A = '#e8e2f1';
    F.college = (window.SD || {}).sport === 'cfb';
    var node = F.node = document.createElement('div');
    node.className = 'oxf'; node.id = 'oxf-' + g.gid;
    node.innerHTML = '<div class="oxf-top"><span class="oxf-dd"></span><span class="oxf-rz" style="display:none">Red zone</span><span class="oxf-tag"></span>'
      + '<button class="oxf-fol" type="button" aria-pressed="false"><i></i>Follow live</button></div>'
      + '<div class="oxf-cap"><b></b><span></span></div>'
      + '<div class="oxf-stage"><div class="oxf-big"></div><button class="oxf-rp" type="button">↻ Replay</button></div>'
      + '<div class="oxf-mine"></div>'
      + '<div class="oxf-note">Play reconstruction from the play-by-play. Public data has no player tracking, so positions and routes are schematic; the spots, yards and players named come from the feed.</div>'
      + '<div class="oxf-drive"></div><div class="oxf-h">Plays · tap any play to replay it</div><div class="oxf-list"></div>';
    F.q = function (c) { return node.querySelector(c); };
    drawField(F);
    node.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pid]');
      if (b) { replay(F.gid, b.getAttribute('data-pid'), true); return; }
      if (e.target.closest('.oxf-fol')) { F.follow = !F.follow; lsSet(FOLLOW_KEY, F.follow ? '1' : '0'); paintFollow(F); if (F.follow && F.lastId && !F.pl) replay(F.gid, F.lastId); return; }
      if (e.target.closest('.oxf-rp')) { var id = F.sel || F.lastId; if (id) replay(F.gid, id); }
    });
    return F;
  }
  function paintFollow(F) {
    var b = F.q('.oxf-fol'), live = F.g.state === 'in';
    b.style.display = live ? '' : 'none';
    b.classList.toggle('on', F.follow); b.setAttribute('aria-pressed', F.follow ? 'true' : 'false');
  }
  function drawField(F) {
    var stage = F.q('.oxf-stage');
    var svg = F.svg = el('svg', {viewBox: '0 -24 1200 581', role: 'img', 'aria-label': 'Football field, play reconstruction', preserveAspectRatio: 'xMidYMid meet'});
    stage.insertBefore(svg, stage.firstChild);
    var defs = el('defs', {}, svg);
    var rg = el('linearGradient', {id: 'oxfRzG' + F.gid, x1: 0, x2: 1, y1: 0, y2: 0}, defs);
    el('stop', {offset: 0, 'stop-color': '#ff5c6c', 'stop-opacity': .55}, rg); el('stop', {offset: 1, 'stop-color': '#ff5c6c', 'stop-opacity': 0}, rg);
    var cam = F.camG = el('g', {}, svg);
    // sideline apron, turf stripes, end zones
    el('rect', {x: -400, y: -60, width: 2000, height: 653, fill: '#0b1f12'}, cam);
    for (var i = 0; i < 20; i++) el('rect', {x: X(i * 5), y: 0, width: 50, height: Y(FW), fill: i % 2 ? '#1c5530' : '#1f5d34'}, cam);
    var g = F.g;
    var ezA = el('rect', {x: 0, y: 0, width: 100, height: Y(FW), fill: F.col.A, opacity: .82}, cam);
    var ezH = el('rect', {x: 1100, y: 0, width: 100, height: Y(FW), fill: F.col.H, opacity: .82}, cam);
    F.ez = {A: ezA, H: ezH};
    var nmA = String(g.away_short || g.away_name || g.away || '').toUpperCase(), nmH = String(g.home_short || g.home_name || g.home || '').toUpperCase();
    var tA = el('text', {x: 50, y: Y(MID), 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: 'rotate(-90 50 ' + Y(MID) + ')', fill: '#fff', 'fill-opacity': .9, 'font-size': nmA.length > 10 ? 40 : 56, 'font-weight': 900, 'letter-spacing': 6, 'font-family': 'Space Grotesk,system-ui,sans-serif'}, cam); tA.textContent = nmA;
    var tH = el('text', {x: 1150, y: Y(MID), 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: 'rotate(90 1150 ' + Y(MID) + ')', fill: '#fff', 'fill-opacity': .9, 'font-size': nmH.length > 10 ? 40 : 56, 'font-weight': 900, 'letter-spacing': 6, 'font-family': 'Space Grotesk,system-ui,sans-serif'}, cam); tH.textContent = nmH;
    if (g.away_logo) { el('image', {href: g.away_logo, x: 25, y: 40, width: 50, height: 50, opacity: .9}, cam); el('image', {href: g.away_logo, x: 25, y: Y(FW) - 90, width: 50, height: 50, opacity: .9}, cam); }
    if (g.home_logo) { el('image', {href: g.home_logo, x: 1125, y: 40, width: 50, height: 50, opacity: .9}, cam); el('image', {href: g.home_logo, x: 1125, y: Y(FW) - 90, width: 50, height: 50, opacity: .9}, cam);
      el('image', {href: g.home_logo, x: 540, y: Y(MID) - 60, width: 120, height: 120, opacity: .28}, cam); }
    // red zone glow (under the lines)
    F.rz = el('rect', {x: 0, y: 0, width: 200, height: Y(FW), fill: 'url(#oxfRzG' + F.gid + ')', class: 'oxf-rzg', style: 'display:none'}, cam);
    // lines: every 5 yards, goal lines, sidelines, hash marks every yard
    var d = '';
    for (var y = 0; y <= 100; y += 5) d += 'M' + X(y) + ' 0V' + Y(FW);
    el('path', {d: d, stroke: '#fff', 'stroke-opacity': .55, 'stroke-width': 2.2, fill: 'none'}, cam);
    el('path', {d: 'M' + X(0) + ' 0V' + Y(FW) + 'M' + X(100) + ' 0V' + Y(FW), stroke: '#fff', 'stroke-width': 4, fill: 'none'}, cam);
    el('rect', {x: 0, y: 0, width: 1200, height: Y(FW), fill: 'none', stroke: '#fff', 'stroke-width': 5}, cam);
    var hs = F.college ? [20, 33.3] : [23.58, 29.72], hd = '';
    for (var k = 1; k < 100; k++) {
      if (k % 5 === 0) continue;
      var x = X(k);
      hd += 'M' + x + ' 6v8M' + x + ' ' + (Y(FW) - 14) + 'v8';
      hd += 'M' + x + ' ' + (Y(hs[0]) - 4) + 'v8M' + x + ' ' + (Y(hs[1]) - 4) + 'v8';
    }
    el('path', {d: hd, stroke: '#fff', 'stroke-opacity': .6, 'stroke-width': 1.6, fill: 'none'}, cam);
    // yard numbers, both sides, upside down on the far side as on a real field
    for (var n = 10; n <= 90; n += 10) {
      var lab = String(n > 50 ? 100 - n : n), xx = X(n);
      var t1 = el('text', {x: xx, y: Y(FW - 9), 'text-anchor': 'middle', fill: '#fff', 'fill-opacity': .75, 'font-size': 26, 'font-weight': 800, 'font-family': 'Space Grotesk,system-ui,sans-serif', 'letter-spacing': 4}, cam); t1.textContent = lab;
      var t2 = el('text', {x: xx, y: Y(9), 'text-anchor': 'middle', fill: '#fff', 'fill-opacity': .75, 'font-size': 26, 'font-weight': 800, 'font-family': 'Space Grotesk,system-ui,sans-serif', 'letter-spacing': 4, transform: 'rotate(180 ' + xx + ' ' + (Y(9) - 9) + ')'}, cam); t2.textContent = lab;
    }
    // goal posts on the end lines (silver, never yellow)
    [-10, 110].forEach(function (a) {
      var gx = X(a);
      el('path', {d: 'M' + gx + ' ' + Y(MID - 3.08) + 'V' + Y(MID + 3.08), stroke: '#e8e3f0', 'stroke-width': 6, 'stroke-linecap': 'round'}, cam);
      el('circle', {cx: gx, cy: Y(MID), r: 6, fill: '#e8e3f0'}, cam);
    });
    // line of scrimmage, first-down line
    F.los = el('rect', {x: -2.5, y: 0, width: 5, height: Y(FW), fill: '#635bff', opacity: .95}, cam);
    F.fd = el('rect', {x: -2.5, y: 0, width: 5, height: Y(FW), fill: '#d795ff', opacity: .95}, cam);
    F.trails = el('g', {}, cam);
    F.flight = el('path', {fill: 'none', stroke: '#fff', 'stroke-width': 2.4, 'stroke-dasharray': '7 9', opacity: 0}, cam);
    // players: 0-10 away, 11-21 home, always the same dots so they jog from one formation to the next
    F.dots = {};
    var R = F.R = 9;
    ['A', 'H'].forEach(function (t) {
      for (var i = 0; i < 11; i++) {
        var gp = el('g', {transform: 'translate(-99 -99)'}, cam);
        var ring = el('circle', {r: R + 7, fill: 'none', stroke: '#b038f9', 'stroke-width': 4, style: 'display:none'}, gp);
        var c = el('circle', {r: R, fill: F.col[t], stroke: '#fff', 'stroke-width': 2}, gp);
        var lb = el('text', {class: 'oxf-lab', y: -R - 7, 'text-anchor': 'middle', style: 'display:none'}, gp);
        F.dots[t + i] = {g: gp, c: c, ring: ring, lab: lb, x: -50, y: MID};
      }
    });
    // the flag (purple and red: the brand never shows yellow)
    F.flagG = el('g', {style: 'display:none'}, cam);
    el('rect', {x: -6, y: -6, width: 12, height: 12, rx: 2, fill: '#ff8a8a', stroke: '#b038f9', 'stroke-width': 2}, F.flagG);
    // the ball and its shadow
    F.shadow = el('ellipse', {rx: 8, ry: 4, fill: '#000', opacity: .45}, cam);
    F.ballG = el('g', {class: 'oxf-ball'}, cam);
    el('ellipse', {rx: 9, ry: 5.5, fill: '#8a4b22', stroke: '#fff', 'stroke-width': 1.6}, F.ballG);
    el('path', {d: 'M-3.5 0h7M-2 -1.6v3.2M0 -1.6v3.2M2 -1.6v3.2', stroke: '#fff', 'stroke-width': 1}, F.ballG);
    // touchdown burst
    F.burst = el('g', {style: 'display:none'}, cam); F.parts = [];
    for (var b = 0; b < 18; b++) F.parts.push(el('circle', {r: 5 + (b % 3) * 2, fill: b % 3 === 2 ? '#fff' : '#b038f9'}, F.burst));
    F.ball = {x: 50, y: MID, h: 0};
  }

  // the camera: the whole field when there is room, a moving 70-yard window on a phone
  function layout(F) {
    var w = F.q('.oxf-stage').clientWidth || 360;
    var CW = w < 620 ? 70 : 120;
    if (CW !== F.CW) {
      F.CW = CW; F.svg.setAttribute('viewBox', '0 -24 ' + CW * 10 + ' 581');
      F.camX = null;
    }
    var ppu = w / (CW * 10);
    var R = clamp(4.8 / ppu, 8, 11), fs = clamp(11 / ppu, 13, 24);
    if (Math.abs(R - F.R) > .2 || F.fs !== fs) {
      F.R = R; F.fs = fs;
      for (var k in F.dots) { var D = F.dots[k]; D.c.setAttribute('r', R); D.ring.setAttribute('r', R + 7); D.lab.setAttribute('y', -R - 6); D.lab.style.fontSize = fs + 'px'; }
    }
  }
  function camTo(F, bx, snap) {
    if (F.CW >= 120) { if (F.camX !== -10) { F.camX = -10; F.camG.setAttribute('transform', 'translate(0 0)'); } return; }
    var target = clamp(bx - F.CW / 2, -10, 110 - F.CW);
    if (F.camX == null || snap) F.camX = target; else F.camX += (target - F.camX) * .12;
    F.camG.setAttribute('transform', 'translate(' + (-(F.camX + 10) * 10).toFixed(1) + ' 0)');
  }
  function setLines(F, x0, dir, dist, ytg) {
    F.los.setAttribute('x', X(x0) - 2.5);
    var goal = dist == null || dist >= ytg - .5 || dist <= 0;
    F.fd.style.display = goal ? 'none' : '';
    if (!goal) F.fd.setAttribute('x', X(clamp(x0 + dir * dist, 0, 100)) - 2.5);
    var rz = ytg <= 20;
    F.rz.style.display = rz ? '' : 'none';
    if (rz) {
      if (dir > 0) { F.rz.setAttribute('x', X(80)); F.rz.setAttribute('width', 200); F.rz.setAttribute('transform', 'rotate(180 ' + X(90) + ' ' + Y(MID) + ')'); }
      else { F.rz.setAttribute('x', X(0)); F.rz.setAttribute('width', 200); F.rz.removeAttribute('transform'); }
    }
    F.q('.oxf-rz').style.display = rz ? '' : 'none';
  }
  function place(F, key, x, y) {
    var D = F.dots[key]; if (!D) return;
    D.x = x; D.y = y;
    D.g.setAttribute('transform', 'translate(' + X(x).toFixed(1) + ' ' + Y(y).toFixed(1) + ')');
  }
  function placeBall(F, b) {
    F.ball = {x: b[0], y: b[1], h: b[2] || 0};
    var h = Math.max(0, b[2] || 0), sc = 1 + h / 9;
    F.ballG.setAttribute('transform', 'translate(' + X(b[0]).toFixed(1) + ' ' + (Y(b[1]) - h * 7).toFixed(1) + ') scale(' + sc.toFixed(3) + ')');
    F.shadow.setAttribute('transform', 'translate(' + X(b[0]).toFixed(1) + ' ' + Y(b[1]).toFixed(1) + ') scale(' + (1 / (1 + h / 14)).toFixed(3) + ')');
  }
  function big(F, txt, on) { var b = F.q('.oxf-big'); if (txt != null) b.textContent = txt; b.classList.toggle('on', !!on); }

  // ── playing a plan ──────────────────────────────────────────────────────
  function stop(F) { if (F.raf) cancelAnimationFrame(F.raf); F.raf = 0; clearTimeout(F.hold); F.hold = 0; }
  function start(F, I, pl) {
    stop(F);
    F.pl = pl; F.I = I; F.sel = I.id; F.fired = {};
    layout(F);
    var off = I.offAway ? 'A' : 'H';
    setLines(F, I.x0, I.dir, I.kind === 'kickoff' || I.kind === 'punt' || I.kind === 'fg' || I.kind === 'xp' ? null : I.dist, I.ytg);
    F.q('.oxf-dd').textContent = (I.dd || ({kickoff: 'Kickoff', punt: 'Punt', fg: 'Field goal', xp: 'Extra point'}[I.kind] || '')).trim();
    F.q('.oxf-tag').textContent = tagOf(I);
    F.q('.oxf-cap b').textContent = verb(I);
    F.q('.oxf-cap span').textContent = (I.q ? 'Q' + I.q + ' ' : '') + I.clock;
    big(F, '', false);
    // labels: who matters in this play, saved picks ringed
    var mine = mineIn(F, I);
    for (var k in F.dots) { var D = F.dots[k], L = pl.lab[k]; D.lab.style.display = L ? '' : 'none'; if (L) D.lab.textContent = L;
      var me = L && mine.keys[nkey(pl.raw[k])]; D.ring.style.display = me ? '' : 'none'; D.lab.classList.toggle('me', !!me); }
    F.burst.style.display = 'none'; F.flagG.style.display = 'none';
    // trails
    while (F.trails.firstChild) F.trails.removeChild(F.trails.firstChild);
    F.tr = pl.trail.map(function (t) {
      var d;
      if (t.ball) {
        var n = 14, pts = [];
        for (var i = 0; i <= n; i++) { var s = i / n, x = t.a[0] + (t.b[0] - t.a[0]) * s, y = t.a[1] + (t.b[1] - t.a[1]) * s, h = (t.h0 || 0) + ((t.h1 || 0) - (t.h0 || 0)) * s + t.arc * 4 * s * (1 - s); pts.push(X(x).toFixed(1) + ' ' + (Y(y) - h * 7).toFixed(1)); }
        d = 'M' + pts.join('L');
      } else {
        var P = pl.act[t.key].filter(function (q) { return q[0] >= t.t0 - 1e-6 && q[0] <= t.t1 + 1e-6; });
        var first = pl.at(t.key, t.t0);
        d = 'M' + X(first[0]).toFixed(1) + ' ' + Y(first[1]).toFixed(1) + P.map(function (q) { return 'L' + X(q[1]).toFixed(1) + ' ' + Y(q[2]).toFixed(1); }).join('');
      }
      var col = t.ball ? '#fff' : t.flip ? F.col[off === 'A' ? 'H' : 'A'] : t.dim ? '#fff' : '#d795ff';
      var path = el('path', {d: d, fill: 'none', stroke: col, 'stroke-width': t.ball ? 2.4 : t.dim ? 2 : 3.4, 'stroke-opacity': t.dim ? .35 : .9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': t.ball ? '6 8' : null}, F.trails);
      var len = 0; try { len = path.getTotalLength(); } catch (e) {}
      if (!t.ball) { path.style.strokeDasharray = len + ' ' + len; path.style.strokeDashoffset = len; }
      else path.style.opacity = 0;
      return {t: t, el: path, len: len};
    });
    F.t0 = performance.now(); F.camX = null;
    markList(F);
    if (RM) { frame(F, 1); finish(F); return; }
    var tick = function (now) {
      F.raf = 0;
      if (!F.node.isConnected) return;            // the gamecenter moved on: stop drawing
      var t = Math.min(1, (now - F.t0) / pl.dur);
      frame(F, t);
      if (t < 1) F.raf = requestAnimationFrame(tick); else finish(F);
    };
    frame(F, 0);
    F.raf = requestAnimationFrame(tick);
  }
  function frame(F, t) {
    var pl = F.pl;
    for (var k in pl.act) { var p = pl.at(k, t); place(F, k, p[0], p[1]); }
    var b = ballAt(pl, t); placeBall(F, b);
    camTo(F, b[0] + (RM ? 0 : F.I.dir * 4), RM || t === 0);
    (F.tr || []).forEach(function (r) {
      var s = clamp((t - r.t.t0) / ((r.t.t1 - r.t.t0) || 1), 0, 1);
      if (r.t.ball) r.el.style.opacity = s > 0 ? (t > r.t.t1 + .15 ? .25 : .7) : 0;
      else r.el.style.strokeDashoffset = (r.len * (1 - s)).toFixed(1);
    });
    if (pl.flag) {
      var f = pl.flag, s = clamp((t - f.t) / .12, 0, 1);
      F.flagG.style.display = t >= f.t ? '' : 'none';
      if (t >= f.t) { var fx = f.a[0] + (f.b[0] - f.a[0]) * s, fy = f.a[1] + (f.b[1] - f.a[1]) * s, fh = 4 * s * (1 - s) * 4; F.flagG.setAttribute('transform', 'translate(' + X(fx).toFixed(1) + ' ' + (Y(fy) - fh * 7).toFixed(1) + ') rotate(' + (s * 360).toFixed(0) + ')'); }
    }
    pl.ev.forEach(function (e, i) {
      if (t < e.t || F.fired[i]) return;
      F.fired[i] = 1;
      if (e.cap) big(F, e.cap, true);
      if (e.td) tdFlash(F, e.td);
      if (!e.td && !e.keep) setTimeout(function () { if (F.fired[i]) big(F, null, false); }, RM ? 1200 : 700);
    });
    burstStep(F);
  }
  function burstStep(F) {
    if (F.burstOn) {
      var bt = (performance.now() - F.burstOn) / 1100;
      if (bt >= 1 || RM) { F.burst.style.display = 'none'; F.burstOn = 0; if (F.ezFlash) F.ezFlash.setAttribute('opacity', .82); }
      else {
        F.parts.forEach(function (c, i) {
          var a = i / F.parts.length * Math.PI * 2, r = 20 + bt * (80 + (i % 4) * 25);
          c.setAttribute('transform', 'translate(' + (Math.cos(a) * r).toFixed(1) + ' ' + (Math.sin(a) * r).toFixed(1) + ')');
          c.setAttribute('opacity', (1 - bt).toFixed(2));
        });
        if (F.ezFlash) F.ezFlash.setAttribute('opacity', (.82 + .18 * Math.abs(Math.sin(bt * Math.PI * 4))).toFixed(2));
      }
    }
  }
  function tdFlash(F, side) {
    var x = side === 'A' ? X(100) + 50 : X(0) - 50;
    F.burst.setAttribute('transform', 'translate(' + x + ' ' + Y(MID) + ')');
    F.parts.forEach(function (c, i) { c.setAttribute('fill', i % 3 === 2 ? '#fff' : F.col[side]); });
    // the end zone the touchdown was scored in lights up
    F.ezFlash = side === 'A' ? F.ez.H : F.ez.A;
    if (RM) return;
    F.burst.style.display = ''; F.burstOn = performance.now();
    var loop = function () { if (!F.burstOn || !F.node.isConnected) return; if (!F.raf) burstStep(F); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  function finish(F) {
    F.raf = 0;
    var I = F.I, pl = F.pl;
    placeBall(F, [I.x1, ballAt(pl, 1)[1], 0]);
    F.svg.setAttribute('data-end', I.x1.toFixed(1));
    F.done = I.id; F.doneAt = Date.now();
    F.hold = setTimeout(function () {
      F.hold = 0;
      if (!F.node.isConnected) return;
      var next = F.queue.shift();
      if (next && F.byId[next]) { go(F, F.byId[next]); return; }
      F.pl = null; markList(F);
      idle(F, true);
    }, 1500);
  }
  function go(F, I) { start(F, I, build(I)); }

  // ── between plays: line up for the next snap at the live spot ──────────────────────────────────────────────
  function nextSpot(F) {
    var L = ((window.LIVE || {})[F.gid]) || {}, sit = L.situation, last = F.plays[F.plays.length - 1];
    var o = null;
    if (sit && F.g.state === 'in' && (sit.possessionText || sit.yardLine != null)) {
      var x = absOf({possessionText: sit.possessionText, yardLine: sit.yardLine}, F.C);
      if (x != null) { var offAway = String(sit.possession || '') ? String(sit.possession) !== F.C.homeId : true;
        o = {x0: x, offAway: offAway, dist: sit.distance, dd: sit.downDistanceText || sit.shortDownDistanceText || '', kind: 'scrim'}; }
    }
    if (!o && last) {
      var I = last, en = I.p.end || {};
      var scored = I.td || (I.kind === 'fg' && I.fgGood) || I.kind === 'xp' || I.safety;
      if (scored) { var kAway = I.td || I.kind === 'fg' || I.kind === 'xp' ? (I.td ? I.scoreAway : I.offAway) : !I.scoreAway; o = {x0: kAway ? 35 : 65, offAway: kAway, kind: 'kickoff', dd: 'Kickoff'}; }
      else {
        var tid = String((en.team || {}).id || '');
        o = {x0: I.x1, offAway: tid ? tid !== F.C.homeId : I.offAway, dist: en.distance, dd: en.downDistanceText || '', kind: 'scrim'};
      }
    }
    if (!o) return null;
    o.dir = o.offAway ? 1 : -1; o.ytg = o.dir > 0 ? 100 - o.x0 : o.x0; o.shotgun = true;
    if (o.kind === 'kickoff') o.landX = o.x0 + o.dir * 62;
    return o;
  }
  function idle(F, animate) {
    var o = nextSpot(F); if (!o) return;
    layout(F);
    var Fm = formation(o.kind, o), pl = new Plan(o);
    var from = {};
    for (var k in F.dots) from[k] = [F.dots[k].x, F.dots[k].y];
    var fresh = from.A0[0] < -20;
    for (var i = 0; i < 11; i++) {
      [[pl.O(i), Fm.o[i]], [pl.D(i), Fm.d[i]]].forEach(function (r) {
        var to = pl.xy(r[1][0], r[1][1]), f = from[r[0]];
        pl.act[r[0]] = fresh || !animate || RM ? [[0, to[0], to[1]]] : [[0, f[0], f[1]], [1, to[0], to[1]]];
      });
    }
    var bt = [o.x0, MID];
    pl.fly(0, 1, [F.ball.x, F.ball.y], bt, 0, F.ball.h, 0);
    for (var kk in F.dots) { F.dots[kk].lab.style.display = 'none'; F.dots[kk].ring.style.display = 'none'; }
    while (F.trails.firstChild) F.trails.removeChild(F.trails.firstChild);
    F.tr = [];
    setLines(F, o.x0, o.dir, o.kind === 'kickoff' ? null : o.dist, o.ytg);
    F.q('.oxf-dd').textContent = (o.dd || '').trim() || (o.kind === 'kickoff' ? 'Kickoff' : '');
    big(F, '', false);
    var dur = fresh || !animate || RM ? 0 : 800, t0 = performance.now();
    var step = function (now) {
      var t = dur ? Math.min(1, (now - t0) / dur) : 1;
      for (var k2 in pl.act) { var p = pl.at(k2, t); place(F, k2, p[0], p[1]); }
      var b = ballAt(pl, t); placeBall(F, b); camTo(F, b[0], t >= 1 && !dur);
      if (t < 1 && F.node.isConnected && !F.pl) requestAnimationFrame(step);
    };
    F.idleAt = o;
    if (!dur) step(t0); else requestAnimationFrame(step);
  }

  // ── saved picks in the play ─────────────────────────────────────────────
  function nkey(n) {
    var w = String(n || '').replace(/#\d+/g, ' ').replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/g, ' ').split(/[\s.]+/).filter(Boolean);
    if (!w.length) return '';
    return (w[0][0] + ' ' + w[w.length - 1]).toLowerCase();
  }
  function mineIn(F, I) {
    var out = {keys: {}, rows: []};
    var all = [];
    try { all = window.OnyxSaved ? OnyxSaved.all() : []; } catch (e) { all = []; }
    var sport = (window.SD || {}).sport, picks = [];
    all.forEach(function (p) { (p.kind === 'parlay' ? p.legs || [] : [p]).forEach(function (l) { if (l && l.name && l.mkt && (!l.sport || l.sport === sport) && (!l.gid || l.gid === F.gid)) picks.push(l); }); });
    var box = mineEl(F);
    if (!picks.length) { box.classList.remove('on'); return out; }
    var inPlay = {}; names(I).forEach(function (n) { inPlay[nkey(n)] = n; });
    var B = null;
    try { if (typeof window.boxOf === 'function' && F.s) B = window.boxOf(F.s, F.g); } catch (e) { B = null; }
    picks.forEach(function (pk) {
      var k = nkey(pk.name); if (!k || !inPlay[k]) return;
      out.keys[k] = 1;
      var v = null;
      if (B) for (var id in B.byId) { var P = B.byId[id]; if (nkey(P.name) === k) { v = P.st[pk.mkt]; break; } }
      var ab = String(((window.STAT_AB || {})[pk.mkt]) || pk.mkt).toLowerCase().replace('_', ' ');
      var ln = String(pk.name).replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/, '').split(/\s+/).pop();
      out.rows.push({pk: pk, txt: ln + ' ' + (v == null ? 0 : v) + ' / ' + (pk.line != null ? pk.line : '') + ' ' + ab + (pk.side === 'under' ? ' (under)' : '')});
    });
    if (!out.rows.length) { box.classList.remove('on'); return out; }
    box.innerHTML = out.rows.map(function (r, i) { return '<div><b>Your pick</b>' + esc(r.txt) + ' <em data-ch="' + i + '"></em></div>'; }).join('');
    box.classList.add('on');
    if (window.OnyxCash && OnyxCash.chance) out.rows.forEach(function (r, i) {
      try { OnyxCash.chance(r.pk).then(function (c) { var e = box.querySelector('[data-ch="' + i + '"]'); if (e && c && c.p != null) e.textContent = '· ' + Math.round(c.p * 100) + '% live chance to cash'; }, function () {}); } catch (e) {}
    });
    return out;
  }
  function mineEl(F) { return F.q('.oxf-mine'); }

  // ── the drive chart and the play list ───────────────────────────────────
  function barCls(I) { return I.td ? 'td' : I.penalty ? 'p' : I.kind === 'punt' || I.kind === 'kickoff' || I.kind === 'fg' || I.kind === 'xp' ? 'k' : I.int || (I.fumble && I.fumOpp) ? 'l' : I.G < 0 ? 'l' : I.G === 0 ? 'z' : ''; }
  function pctX(a) { return ((a + 10) / 120 * 100).toFixed(2); }
  function renderDrive(F) {
    var host = F.q('.oxf-drive');
    var cur = F.sel && F.byId[F.sel] ? F.byId[F.sel].drive : null;
    var dr = cur || (F.plays.length ? F.plays[F.plays.length - 1].drive : null);
    if (!dr) { host.innerHTML = ''; return; }
    var ps = F.plays.filter(function (I) { return I.drive === dr; });
    var t = dr.team || {}, logo = ((t.logos || [{}])[0] || {}).href;
    var isCur = F.plays.length && F.plays[F.plays.length - 1].drive === dr && F.plays[F.plays.length - 1].cur && F.g.state === 'in';
    var res = dr.displayResult || dr.result || '';
    var rc = /touchdown/i.test(res) ? 'td' : /interception|fumble|downs|safety/i.test(res) ? 'to' : '';
    var ga = F.col.A, gh = F.col.H;
    host.innerHTML = '<div class="oxf-ds">' + (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '')
      + '<b>' + esc(t.abbreviation || t.shortDisplayName || '') + ' drive</b><span class="dim">' + esc(dr.description || (ps.length + ' plays')) + '</span>'
      + '<span class="r ' + rc + '">' + esc(isCur ? 'In progress' : res) + '</span></div>'
      + '<div class="oxf-dc" style="--eza:' + ga + ';--ezh:' + gh + '">' + ps.map(function (I) {
        var a = Math.min(I.x0, I.x1), b = Math.max(I.x0, I.x1);
        var w = Math.max(.6, (b - a) / 120 * 100);
        return '<button type="button" class="oxf-dr' + (F.sel === I.id ? ' on' : '') + '" data-pid="' + esc(I.id) + '" aria-label="Replay: ' + esc(verb(I)) + '"><span class="dd">' + esc(I.sdd || tagOf(I).split(' ·')[0]) + '</span>'
          + '<span class="tk"><i class="' + barCls(I) + '" style="left:' + pctX(a) + '%;width:' + w.toFixed(2) + '%"></i></span><span class="yd">' + (I.kind === 'kickoff' || I.kind === 'punt' ? '' : (I.yds > 0 ? '+' : '') + I.yds) + '</span></button>';
      }).join('') + '</div>';
  }
  function renderList(F) {
    var ps = F.plays.slice(-16).reverse();
    F.q('.oxf-list').innerHTML = ps.map(function (I) {
      return '<button type="button" class="oxf-pl' + (F.sel === I.id ? ' on' : '') + '" data-pid="' + esc(I.id) + '"><span class="t">Q' + esc(I.q || '') + ' ' + esc(I.clock) + '</span>'
        + '<span class="x">' + (I.sdd ? '<b>' + esc(I.sdd) + '</b> ' : '') + esc(I.raw) + '</span><span class="go">▶ ' + (I.kind === 'kickoff' || I.kind === 'punt' ? '' : (I.yds > 0 ? '+' : '') + I.yds) + '</span></button>';
    }).join('');
  }
  function markList(F) {
    F.node.querySelectorAll('[data-pid]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-pid') === F.sel); });
    var inDrive = F.q('.oxf-dr[data-pid="' + (F.sel || '') + '"]');
    if (F.sel && !inDrive) renderDrive(F);
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  function slot(g) { return '<div class="gc-sec" id="oxfSlot" data-gid="' + esc(g.gid) + '"><h4>On the field · play reconstruction</h4></div>'; }
  function attach(s, g) {
    var host = document.getElementById('oxfSlot');
    Object.keys(ST).forEach(function (k) { if (!host || k !== host.getAttribute('data-gid')) stop(ST[k]); });
    if (!host || !s || !g) return;
    var F = ST[g.gid] || (ST[g.gid] = create(g, s));
    F.g = g; F.s = s;
    if (F.node.parentNode !== host) host.appendChild(F.node);
    update(F, s);
  }
  function update(F, s) {
    F.C = ctxOf(s, F.g);
    var es = playsOf(s), out = [], by = {};
    es.forEach(function (e) { var I = null; try { I = info(e, F.C); } catch (er) { I = null; } if (I) { out.push(I); by[I.id] = I; } });
    var prevLast = F.lastId, sig = out.length + ':' + (out.length ? out[out.length - 1].id : '');
    F.plays = out; F.byId = by;
    paintFollow(F);
    if (sig !== F.sig) { F.sig = sig; renderDrive(F); renderList(F); }
    if (!out.length) { F.lastId = null; idle(F, false); return; }
    var newest = out[out.length - 1].id;
    F.lastId = newest;
    if (prevLast == null) {
      // first look: the latest play runs once, then the teams line up for the next snap
      go(F, out[out.length - 1]);
      return;
    }
    if (newest !== prevLast) {
      var idx = -1; for (var i = 0; i < out.length; i++) if (out[i].id === prevLast) idx = i;
      var fresh = out.slice(idx + 1).slice(-3).map(function (I) { return I.id; });
      if (F.follow && F.g.state === 'in') {
        if (F.pl || F.hold) F.queue = F.queue.concat(fresh).slice(-4);
        else { F.queue = fresh.slice(1); go(F, by[fresh[0]]); }
      } else if (!F.pl) idle(F, true);
      return;
    }
    if (!F.pl && !F.hold && !F.raf) idle(F, false);
  }
  function replay(gid, pid, scroll) {
    var F = ST[gid]; if (!F || !F.byId[pid]) return false;
    F.queue = [];
    go(F, F.byId[pid]);
    if (scroll) { var st = F.q('.oxf-stage'); try { var r = st.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight) st.scrollIntoView({behavior: RM ? 'auto' : 'smooth', block: 'center'}); } catch (e) {} }
    return true;
  }
  function state(gid) {
    var F = ST[gid || Object.keys(ST)[0]]; if (!F) return null;
    var b = F.ballG.getAttribute('transform') || '';
    return {gid: F.gid, playing: !!F.raf, play: F.I ? F.I.id : null, kind: F.I ? F.I.kind : null, ballX: F.ball.x, ballY: F.ball.y, endX: F.I ? F.I.x1 : null,
      ballTransform: b, done: F.done || null, follow: F.follow, queue: F.queue.slice(), last: F.lastId, cam: F.camX, CW: F.CW, idle: F.idleAt || null};
  }
  function plays(gid) {
    var F = ST[gid || Object.keys(ST)[0]]; if (!F) return [];
    return F.plays.map(function (I) { return {id: I.id, kind: I.kind, x0: I.x0, x1: I.x1, td: !!I.td, int: !!I.int, penalty: !!I.penalty, headline: verb(I), tag: tagOf(I)}; });
  }
  addEventListener('resize', function () { for (var k in ST) { var F = ST[k]; if (F.node.isConnected) { layout(F); camTo(F, F.ball.x, true); } } });
  window.OnyxField = {slot: slot, attach: attach, replay: replay, state: state, plays: plays, _classify: classify, _info: info};
})();
