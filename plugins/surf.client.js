// surf widget — CLIENT (loaded verbatim by plugins/surf.js; runs in the page's global
// scope via the plugin loader). Moved out of an escaped string (sidecar pattern, 2026-08-02).
(el, data) => {
    if (!document.getElementById('surf-css')) {
      const st = document.createElement('style'); st.id = 'surf-css';
      st.textContent = '.surf-row{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px}.surf-hrow{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px}.surf-hlbl{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);min-width:44px}.surf-d{background:var(--card2);border:1px solid var(--border);border-radius:5px;padding:3px 6px;font-size:11px;text-align:center;min-width:58px;font-variant-numeric:tabular-nums}.surf-d.wA{background:rgba(255,170,0,.16);border-color:rgba(255,170,0,.5)}.surf-d.wR{background:rgba(255,70,70,.18);border-color:rgba(255,70,70,.55)}.surf-lbl{font-size:9px;text-transform:uppercase;color:var(--text3);font-weight:700}.surf-w{font-weight:650}.surf-v{font-size:10px;color:var(--text2)}.surf-ar{display:inline-block;font-size:10px}.surf-sel{background:var(--card2);color:var(--text2);border:1px solid var(--border);border-radius:4px;font-size:11px}';
      document.head.appendChild(st);
    }
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const render = d => {
      if (d && d.unconfigured) { el.innerHTML = '<div class="empty">' + esc(d.hint) + '</div>'; return; }
      if (!d || d.error || !(d.daily || []).length) { el.innerHTML = '<div class="empty">' + esc((d && d.error) || 'forecast unavailable') + '</div>'; return; }
      const cls = w => w > 15 ? ' wR' : w > 12 ? ' wA' : '';
      const arrow = dir => dir == null ? '' : '<span class="surf-ar" style="transform:rotate(' + ((dir + 180) % 360) + 'deg)">\u2191</span>';
      const wv = x => x.wave != null ? x.wave.toFixed(1) + 'm\u00b7' + Math.round(x.period || 0) + 's' : '\u2014';
      const dayLbl = iso => { const dd = new Date(iso + 'T12:00:00'); return dd.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + dd.getDate(); };
      const daily = d.daily.map(x => '<div class="surf-d' + cls(x.wind) + '"><div class="surf-lbl">' + esc(dayLbl(x.date)) + '</div><div class="surf-w">' + (x.wind != null ? Math.round(x.wind) + 'kt' : '\u2014') + ' ' + arrow(x.dir) + '</div><div class="surf-v">' + wv(x) + '</div></div>').join('');
      const hourly = (d.hours || []).map(day => '<div class="surf-hrow"><span class="surf-hlbl">' + esc(dayLbl(day.date)) + '</span>' + day.slots.map(x => '<div class="surf-d surf-h' + cls(x.wind) + '"><div class="surf-lbl">' + String(x.h).padStart(2, '0') + 'h</div><div class="surf-w">' + Math.round(x.wind) + 'kt ' + arrow(x.dir) + '</div><div class="surf-v">' + wv(x) + '</div></div>').join('') + '</div>').join('');
      el.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:3px"><span id="surf-spotname">' + esc(d.spot) + '</span> <select id="surf-spot-sel" class="surf-sel"></select></div><div class="surf-row">' + daily + '</div>' + hourly;
      const sel = el.querySelector('#surf-spot-sel');
      const spots = data.spots || [];
      if (spots.length < 2) sel.style.display = 'none';
      else {
        const cur = localStorage.getItem('surfSpot') || 'auto';
        sel.innerHTML = '<option value="auto">\ud83d\udccd auto</option>' + spots.map(s => '<option value="' + esc(s.key) + '"' + (s.key === cur ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('');
        sel.onchange = () => { localStorage.setItem('surfSpot', sel.value); load(); };
      }
    };
    const load = () => {
      const cur = localStorage.getItem('surfSpot') || 'auto';
      const go = q => fetch('/api/surf' + q).then(r => r.json()).then(render).catch(() => { el.innerHTML = '<div class="empty">forecast unreachable</div>'; });
      if (cur !== 'auto') return go('?spot=' + encodeURIComponent(cur));
      if (!navigator.geolocation) return go('');
      navigator.geolocation.getCurrentPosition(
        p => go('?lat=' + p.coords.latitude.toFixed(3) + '&lon=' + p.coords.longitude.toFixed(3)),
        () => go(''), { timeout: 4000, maximumAge: 600000 });
    };
    render(data); // first paint from the server-provided default-spot data
    if ((localStorage.getItem('surfSpot') || 'auto') !== data.spotKey) load();
  }
