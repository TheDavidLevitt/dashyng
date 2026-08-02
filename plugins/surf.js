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

const fs = require('fs'), path = require('path');
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
  client: fs.readFileSync(path.join(__dirname, 'surf.client.js'), 'utf8'),
};
