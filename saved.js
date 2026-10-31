// saved.js - "Save" a pick on this device and follow it live in My Onyx (home.html).
// One localStorage list (onyxSaved) shared by every page on this origin. A pick:
//   {id: Onyx selection id, sport, label, matchup, start, gid, team, price, conf,
//    kind: prop|spread|total|ml, mkt (pts, rec, rush_yds, q1_total...), side, line,
//    hcap (spread), name (player or team), saved: ISO time}
// Pages call OnyxSaved.btn(pick) for the star button; home.html reads OnyxSaved.all().
(function () {
  var KEY = 'onyxSaved', KEEP_H = 36, REG = [];
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; } }
  function write(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} try { dispatchEvent(new Event('onyx-saved')); } catch (e) {} }
  // a pick drops off 36 hours after its game starts: tonight's picks, followed through the night
  function all() {
    var now = Date.now(), a = read(), keep = a.filter(function (p) { var t = Date.parse(p.start || p.saved); return isNaN(t) || now - t < KEEP_H * 3600e3; });
    if (keep.length !== a.length) write(keep);
    return keep;
  }
  function has(id) { return !!id && read().some(function (p) { return p.id === id; }); }
  function remove(id) { write(read().filter(function (p) { return p.id !== id; })); }
  function toast(msg) { if (window.OX_TOAST) { try { window.OX_TOAST(msg); return; } catch (e) {} } }
  function toggle(p) {
    if (!p || !p.id) return false;
    if (has(p.id)) { remove(p.id); toast('Removed from My picks'); return false; }
    var a = read(); a.push(Object.assign({}, p, {saved: new Date().toISOString()})); write(a);
    toast('Saved. Follow it live in My picks on the home page');
    try { if (window.gtag) gtag('event', 'pick_save', {sport: p.sport}); } catch (e) {}
    return true;
  }
  function tap(el, i) {
    var on = toggle(REG[i]);
    el.classList.toggle('on', on); el.innerHTML = on ? '★' : '☆';
    el.setAttribute('aria-label', on ? 'Saved' : 'Save pick');
  }
  function btn(p) {
    if (!p || !p.id) return '';
    var i = REG.push(p) - 1, on = has(p.id);
    return '<button class="ox-save' + (on ? ' on' : '') + '" aria-label="' + (on ? 'Saved' : 'Save pick') + '" title="Save this pick and follow it live" ' +
      'onclick="event.stopPropagation();event.preventDefault();OnyxSaved.tap(this,' + i + ')">' + (on ? '★' : '☆') + '</button>';
  }
  var css = '.ox-save{flex-shrink:0;width:34px;height:34px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);' +
    'color:#d795ff;font-size:17px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}' +
    '.ox-save.on{background:rgba(176,56,249,.22);border-color:rgba(176,56,249,.7);color:#fff}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);
  window.OnyxSaved = {all: all, has: has, remove: remove, toggle: toggle, tap: tap, btn: btn};
})();
