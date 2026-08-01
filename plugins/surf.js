// 🌊 Wind & waves — glanceable surf/kite forecast. Extracted from the core (widget-platform
// phase 2): first CORE plugin — key stays 'surf' (no plugin: prefix) so existing section
// settings keep working. Open-Meteo forecast + marine APIs (free, keyless), daylight hours
// only; daily = the day's peak wind + biggest wave. Spots from config surfSpots
// [{key,name,lat,lon,tz?}] or the legacy single-spot fields; client geolocates for 'auto'.
let SPOTS = null;
function spots(cfg) {
  if (SPOTS) return SPOTS;
  let s = Array.isArray(cfg.surfSpots) ? cfg.surfSpots.filter(x => x && +x.lat && +x.lon) : [];
  if (!s.length && (cfg.surfSpotLat || cfg.surfSpotLon))
    s = [{ key: 'home', name: cfg.surfSpotName || 'Home break', lat: cfg.surfSpotLat, lon: cfg.surfSpotLon }];
  SPOTS = s.map((x, i) => ({ key: String(x.key || 'spot' + i).slice(0, 24), name: String(x.name || x.key || 'Spot').slice(0, 60), lat: +x.lat, lon: +x.lon, tz: x.tz ? String(x.tz).slice(0, 40) : '' }));
  return SPOTS;
}
const dist = (a, b, lat, lon) => { const dl = (a - lat), dn = (b - lon) * Math.cos(lat * Math.PI / 180); return dl * dl + dn * dn; };
const cache = {}; // per spot key, 1h

async function forecast(spot) {
  const c = cache[spot.key];
  if (c && Date.now() - c.at < 60 * 60000) return c.data;
  const [w, m] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=7&timezone=auto`).then(r => r.json()),
    fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${spot.lat}&longitude=${spot.lon}&hourly=wave_height,wave_period&forecast_days=7&timezone=auto`).then(r => r.json()).catch(() => null),
  ]);
  const wt = w?.hourly?.time || [];
  if (!wt.length) return { error: 'forecast unavailable' };
  const ws = w.hourly.wind_speed_10m, wd = w.hourly.wind_direction_10m;
  const mIdx = new Map((m?.hourly?.time || []).map((t, i) => [t, i]));
  const byDay = {};
  wt.forEach((t, i) => {
    const [date, hm] = t.split('T'); const h = +hm.slice(0, 2);
    if (h < 6 || h > 20) return; // daylight only
    const mi = mIdx.get(t);
    (byDay[date] = byDay[date] || []).push({ h, wind: ws[i], dir: wd[i],
      wave: mi != null ? m.hourly.wave_height[mi] : null, period: mi != null ? m.hourly.wave_period[mi] : null });
  });
  const dates = Object.keys(byDay).sort();
  const daily = dates.slice(0, 7).map(date => {
    const rows = byDay[date].filter(x => x.wind != null);
    if (!rows.length) return { date };
    const top = rows.reduce((a, b) => b.wind > a.wind ? b : a, rows[0]);
    const wv = rows.reduce((a, b) => (b.wave || 0) > (a.wave || 0) ? b : a, rows[0]);
    return { date, wind: top.wind, dir: top.dir, wave: wv.wave, period: wv.period };
  });
  const hours = dates.slice(0, 2).map(date => ({ date, slots: byDay[date].filter(x => x.h % 3 === 0) }));
  const data = { at: new Date().toISOString(), spot: spot.name, spotKey: spot.key, daily, hours };
  cache[spot.key] = { at: Date.now(), data };
  return data;
}

module.exports = {
  key: 'surf',
  core: true, // pre-existing section: renders under its ORIGINAL key so settings carry over
  title: 'Wind & waves',
  desc: 'Surf/kite forecast for configured spots',
  needs: { location: true },
  async data(ctx) {
    const ss = spots(ctx.config);
    if (!ss.length) return { unconfigured: true, hint: 'Set surfSpots (or surfSpotName/Lat/Lon) to enable the wind & waves check.', spots: [] };
    return { ...(await forecast(ss[0])), spots: ss.map(s => ({ key: s.key, name: s.name, tz: s.tz || undefined })) };
  },
  routes(app, ctx) {
    app.get('/api/surf/spots', (req, res) => res.json({ spots: spots(ctx.config).map(s => ({ key: s.key, name: s.name, tz: s.tz || undefined })) }));
    app.get('/api/surf', async (req, res) => {
      try {
        const ss = spots(ctx.config);
        if (!ss.length) return res.json({ unconfigured: true, hint: 'Set surfSpots (or surfSpotName/Lat/Lon) to enable the wind & waves check.' });
        let spot = ss.find(s => s.key === String(req.query.spot || ''));
        if (!spot && isFinite(+req.query.lat) && isFinite(+req.query.lon) && req.query.lat !== '')
          spot = [...ss].sort((a, b) => dist(a.lat, a.lon, +req.query.lat, +req.query.lon) - dist(b.lat, b.lon, +req.query.lat, +req.query.lon))[0];
        res.json(await forecast(spot || ss[0]));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  },
  // renders in the browser — (el, data) with el = this section's card body
  client: `(el, data) => {
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
      const arrow = dir => dir == null ? '' : '<span class="surf-ar" style="transform:rotate(' + ((dir + 180) % 360) + 'deg)">\\u2191</span>';
      const wv = x => x.wave != null ? x.wave.toFixed(1) + 'm\\u00b7' + Math.round(x.period || 0) + 's' : '\\u2014';
      const dayLbl = iso => { const dd = new Date(iso + 'T12:00:00'); return dd.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + dd.getDate(); };
      const daily = d.daily.map(x => '<div class="surf-d' + cls(x.wind) + '"><div class="surf-lbl">' + esc(dayLbl(x.date)) + '</div><div class="surf-w">' + (x.wind != null ? Math.round(x.wind) + 'kt' : '\\u2014') + ' ' + arrow(x.dir) + '</div><div class="surf-v">' + wv(x) + '</div></div>').join('');
      const hourly = (d.hours || []).map(day => '<div class="surf-hrow"><span class="surf-hlbl">' + esc(dayLbl(day.date)) + '</span>' + day.slots.map(x => '<div class="surf-d surf-h' + cls(x.wind) + '"><div class="surf-lbl">' + String(x.h).padStart(2, '0') + 'h</div><div class="surf-w">' + Math.round(x.wind) + 'kt ' + arrow(x.dir) + '</div><div class="surf-v">' + wv(x) + '</div></div>').join('') + '</div>').join('');
      el.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:3px"><span id="surf-spotname">' + esc(d.spot) + '</span> <select id="surf-spot-sel" class="surf-sel"></select></div><div class="surf-row">' + daily + '</div>' + hourly;
      const sel = el.querySelector('#surf-spot-sel');
      const spots = data.spots || [];
      if (spots.length < 2) sel.style.display = 'none';
      else {
        const cur = localStorage.getItem('surfSpot') || 'auto';
        sel.innerHTML = '<option value="auto">\\ud83d\\udccd auto</option>' + spots.map(s => '<option value="' + esc(s.key) + '"' + (s.key === cur ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('');
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
  }`,
};
