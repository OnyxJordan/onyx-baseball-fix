// onyxpicks.js - the one Onyx Picks list, the same on every page (11/6, Jordan: "I'll see lists of
// picks everywhere then I'll see different things tracked, lets nail this down").
//
// Two words on the whole site:
//   Onyx Picks   what we would bet: a market that beat Onyx's real prices on games its model never saw
//                (data/picks/backtest.json), locked once on game day at the price shown the moment it
//                qualified (picks.py), never changed, graded in public. Read from data/picks/ledger.json.
//   Projections  everything else (leans, live chances, the lab's trial lanes): our numbers, never a pick.
//
//   OnyxPicks.mount(el, {sport: 'nba'|null, title: 'Onyx Picks · NBA'})   renders today's card + the record
(function () {
  'use strict';
  var REF = 'KR680261';
  var LG = {nfl: 'NFL', cfb: 'NCAAF', nba: 'NBA', cbb: 'NCAAB', nhl: 'NHL', tennis: 'Tennis', mlb: 'MLB', golf: 'Golf'};
  var MK = {q1_total: '1st-quarter total', rush_yds: 'Rushing yards', rec_yds: 'Receiving yards', rec: 'Receptions', pts: 'Points',
            reb: 'Rebounds', ast: 'Assists', total: 'Game total', spread: 'Spread', ml: 'Moneyline', pass_yds: 'Passing yards',
            anytime_td: 'Anytime TD', sog: 'Shots on goal', goals: 'Goals'};
  var CSS = [
    '.oxp{margin:0 0 18px}',
    '.oxp-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 14px;margin:0 0 10px}',
    '.oxp-h h3{margin:0;font-size:20px;line-height:1.2;color:#fff}.oxp-h h3 i{font-style:normal;color:#d795ff}',
    '.oxp-rec{font:700 12px monospace;color:#cfc8da}.oxp-rec .pos{color:#61e970}.oxp-rec .neg{color:#ff8a8a}',
    '.oxp-sub{margin:0 0 10px;color:#b9b2c4;font-size:13px;line-height:1.55}',
    '.oxp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:10px}',
    '.oxp-c{border:1px solid rgba(176,56,249,.55);border-radius:16px;padding:13px 14px;background:linear-gradient(160deg,rgba(176,56,249,.14),rgba(255,255,255,.02));min-width:0}',
    '.oxp-c.done{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.03)}',
    '.oxp-t{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}',
    '.oxp-tag{display:inline-block;padding:2px 8px;border-radius:999px;font:700 10px monospace;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.08);color:#ddd}',
    '.oxp-tag.pk{background:rgba(176,56,249,.25);color:#e9c8ff}.oxp-tag.W{background:rgba(97,233,112,.16);color:#61e970}.oxp-tag.L{background:rgba(255,92,92,.15);color:#ff8a8a}',
    '.oxp-c b.l{display:block;font-size:17px;line-height:1.3;color:#fff;overflow-wrap:anywhere}',
    '.oxp-c .m{font-size:12.5px;color:#b9b2c4;margin-top:2px;overflow-wrap:anywhere}',
    '.oxp-lk{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;font:600 11.5px monospace;color:#cfc8da}.oxp-lk b{color:#fff}',
    '.oxp-go{display:inline-block;margin-top:10px;font:800 12px monospace;color:#fff;background:#a24bff;border-radius:999px;padding:9px 14px;text-decoration:none}',
    '.oxp-empty{border:1px dashed rgba(176,56,249,.45);border-radius:14px;padding:14px;color:#cfc8da;font-size:13.5px;line-height:1.6}',
    '.oxp-empty a,.oxp-more a{color:#d795ff}.oxp-more{margin-top:8px;font-size:12.5px;color:#9a93a6}'
  ].join('\n');
  function css() {
    if (document.getElementById('onyx-picks-css')) return;
    var s = document.createElement('style'); s.id = 'onyx-picks-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function odds(p) { return p == null ? '-' : p > 0 ? '+' + p : String(p); }
  function pay(p) { return p > 0 ? p / 100 : 100 / -p; }
  function et(iso, withDay) {
    try {
      var d = new Date(iso), o = {hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'};
      if (withDay) o.weekday = 'short';
      return d.toLocaleString('en-US', o) + ' ET';
    } catch (e) { return ''; }
  }
  // the site's day: ET, rolling at 4 AM
  function siteDay(t) { return new Date(t - 4 * 3600e3).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); }
  var LED = null, LED_AT = 0;
  function load() {
    if (LED && Date.now() - LED_AT < 60e3) return Promise.resolve(LED);
    return fetch('data/picks/ledger.json?t=' + Math.floor(Date.now() / 60000), {cache: 'no-store'})
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { LED = Array.isArray(j) ? j : []; LED_AT = Date.now(); return LED; });
  }
  function agg(rs) {
    var w = 0, l = 0, p = 0, u = 0;
    rs.forEach(function (r) { if (r.result === 'W') { w++; u += pay(r.price); } else if (r.result === 'L') { l++; u -= 1; } else if (r.result) p++; });
    return {w: w, l: l, p: p, u: u};
  }
  function status(r) {
    if (r.result) return '<span class="oxp-tag ' + r.result + '">' + ({W: 'Won', L: 'Lost', P: 'Push', V: 'Void'}[r.result] || r.result) + '</span>';
    return Date.parse(r.start) <= Date.now() ? '<span class="oxp-tag">In play</span>' : '<span class="oxp-tag">Pending</span>';
  }
  // the lock time, with its date when the pick locked before game day (picks before 11/6 could lock days ahead)
  function lockTxt(r) {
    try {
      var same = siteDay(Date.parse(r.logged_at)) === siteDay(Date.parse(r.start));
      if (same) return et(r.logged_at);
      return new Date(r.logged_at).toLocaleDateString('en-US', {weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'America/New_York'}) + ' ' + et(r.logged_at);
    } catch (e) { return et(r.logged_at); }
  }
  function card(r) {
    var live = !r.result && Date.parse(r.start) > Date.now();
    var mk = r.src === 'market';
    var url = r.sel ? 'https://app.onyxodds.com/share?selection=' + encodeURIComponent(r.sel) + '&referrer=' + REF : 'https://app.onyxodds.com/?referrer=' + REF;
    return '<div class="oxp-c' + (live ? '' : ' done') + '">'
      + '<div class="oxp-t"><span class="oxp-tag pk">Onyx Pick</span><span class="oxp-tag">' + esc(LG[r.sport] || r.sport) + '</span><span class="oxp-tag">' + esc(MK[r.market] || r.market || '') + '</span>' + status(r) + '</div>'
      + '<b class="l">' + esc(r.label) + '</b>'
      + '<div class="m">' + esc(r.matchup) + ' · ' + esc(et(r.start, true)) + '</div>'
      + '<div class="oxp-lk"><span>Locked <b>' + esc(lockTxt(r)) + '</b> at <b>' + odds(r.price) + '</b>' + (mk ? ' (market line)' : '') + '</span>'
      + '<span>Chance <b>' + Math.round(100 * (r.chance || 0)) + '%</b></span></div>'
      + (live ? '<a class="oxp-go" href="' + url + '" target="_blank" rel="noopener">' + (mk ? 'Find it on Onyx' : odds(r.price) + ' on Onyx') + '</a>' : '')
      + '</div>';
  }
  // today's card for a sport (or every sport): picks dated today, plus any still to start
  function today(rows, sport) {
    var d = siteDay(Date.now());
    return rows.filter(function (r) { return (!sport || r.sport === sport) && (r.date === d || (!r.result && Date.parse(r.start) > Date.now())); })
      .sort(function (a, b) { return (!!a.result - !!b.result) || Date.parse(a.start) - Date.parse(b.start); });
  }
  function html(rows, opt) {
    opt = opt || {};
    css();
    var sp = opt.sport || null, T = today(rows, sp), R = agg(rows.filter(function (r) { return !sp || r.sport === sp; }));
    var rec = R.w + R.l ? '<span class="oxp-rec">Record ' + R.w + '-' + R.l + (R.p ? '-' + R.p : '') + ' · <span class="' + (R.u >= 0 ? 'pos' : 'neg') + '">' + (R.u >= 0 ? '+' : '') + R.u.toFixed(2) + 'u</span></span>' : '';
    var h = '<div class="oxp"><div class="oxp-h"><h3>' + (opt.title || 'Onyx Picks') + ' <i>· today</i></h3>' + rec + '</div>'
      + '<p class="oxp-sub">What we would bet. Each pick locks once, on game day, at the price shown the moment it qualifies, and never changes. Graded in public on the <a href="picks.html" style="color:#d795ff">Onyx Picks record</a>.</p>';
    if (T.length) h += '<div class="oxp-grid">' + T.map(card).join('') + '</div>';
    else h += '<div class="oxp-empty">No Onyx Pick on ' + (sp ? (LG[sp] || sp) + '\'s' : 'today\'s') + ' card yet. A pick locks on game day the moment a play in a tested market qualifies, so the card can fill closer to game time. '
      + 'Everything below is a projection: our numbers, not a pick. <a href="picks.html">How picks are chosen ›</a></div>';
    return h + '</div>';
  }
  function mount(el, opt) {
    if (!el) return Promise.resolve();
    css();
    return load().then(function (rows) { el.innerHTML = html(rows, opt); }).catch(function () {
      el.innerHTML = '<div class="oxp-empty">The Onyx Picks card could not load. <a href="picks.html">Open Onyx Picks ›</a></div>';
    });
  }
  window.OnyxPicks = {mount: mount, load: load, html: html, today: today};
})();
