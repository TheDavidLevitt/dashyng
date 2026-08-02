// 📚 Reading/Listening queue — extracted from the core (phase 2c). Owns the Media tab's
// READ side (queue/done/restore + the podcast feed watcher). The WRITE paths that belong
// to news (pin-to-media, /api/media/add, queue-story) stay in core — news is core — and
// call window.refreshMediaWidget?.() client-side to repaint this widget.
const fs = require('fs'), path = require('path');
module.exports = {
  key: 'media',
  core: true,
  title: 'Reading queue',
  desc: 'Articles, books, podcasts to consume',
  needs: { tabs: ['Media (Reading/Listening)'] },
  async data() { return { see: '/api/media' }; },
  jobs: [], // scheduling handled in routes() so the first run happens at boot too
  routes(app, ctx) {
    const { store, asyncRoute, readMediaTab, readTab, colLetter, track, pmap, prefRows, decodeEntities } = ctx;
    const TODO_SHEET_ID = ctx.sheetId;
    const PREFS_SHEET_ID = ctx.config.prefsSheetId;
    const MEDIA_TAB = 'Media (Reading/Listening)';
    
    app.get('/api/media', asyncRoute(async (req, res) => {
      const { rows } = await readMediaTab();
      res.json({ media: rows });
    }));
    
    app.post('/api/media/:id/done', asyncRoute(async (req, res) => {
      const { headers, rows } = await readMediaTab();
      const item = rows.find(r => r.ID === req.params.id);
      if (!item) return res.status(404).json({ error: 'media item not found' });
      const col = headers.indexOf('Status');
      await store.values.update({
        spreadsheetId: TODO_SHEET_ID,
        range: `'${MEDIA_TAB}'!${colLetter(col)}${item._row}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['done']] },
      });
      res.json({ ok: true });
    }));
    
    // Undo support: put a media item back in the queue.
    app.post('/api/media/:id/restore', asyncRoute(async (req, res) => {
      const { headers, rows } = await readMediaTab();
      const item = rows.find(r => r.ID === req.params.id);
      if (!item) return res.status(404).json({ error: 'media item not found' });
      await store.values.update({
        spreadsheetId: TODO_SHEET_ID,
        range: `'${MEDIA_TAB}'!${colLetter(headers.indexOf('Status'))}${item._row}`,
        valueInputOption: 'RAW', requestBody: { values: [['queued']] },
      });
      res.json({ ok: true });
    }));
    
    
    // "Media I'm following": new podcast episodes / posts appear as rows in the
    // Media tab (→ the Reading/Listening queue) rather than as news coverage.
    // Podcast names come from INSTANCES + any SOURCES row containing "podcast";
    // feeds resolve via the iTunes Search API and the mapping persists in
    // data/feeds.json (edit that file to correct a wrong resolution).
    
    const FEEDS_FILE = path.join(__dirname, '..', 'data', 'feeds.json');
    
    async function resolveFeed(name) {
      let feeds = {};
      try { feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8')); } catch (e) {}
      let entry = feeds[name];
      if (typeof entry === 'string') entry = { feedUrl: entry }; // migrate old shape
      if (entry !== undefined && (entry === null || entry.collectionId !== undefined || entry.feedUrl)) {
        if (entry && entry.collectionId === undefined) { /* fall through to re-resolve for the id */ }
        else return entry; // null = known-unresolvable, skip
      }
      let resolved = null;
      try {
        const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&media=podcast&limit=1`);
        const j = await r.json();
        const hit = j.results?.[0];
        if (hit?.feedUrl) resolved = { feedUrl: hit.feedUrl, collectionId: hit.collectionId || null, showUrl: hit.collectionViewUrl || null };
      } catch (e) {}
      if (resolved === null && entry && entry.feedUrl) resolved = { ...entry, collectionId: null };
      feeds[name] = resolved;
      try { fs.mkdirSync(path.dirname(FEEDS_FILE), { recursive: true }); fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 1)); } catch (e) {}
      return resolved;
    }
    
    // Apple Podcasts episode pages (podcasts.apple.com/...?i=<id>) open the native
    // Podcasts app on iOS — preferred over the publisher web link.
    async function appleEpisodeLinks(collectionId) {
      if (!collectionId) return new Map();
      try {
        const r = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=30`);
        const j = await r.json();
        const map = new Map();
        for (const ep of (j.results || []).slice(1)) {
          if (ep.trackName && ep.trackViewUrl) map.set(normTitle(ep.trackName), ep.trackViewUrl);
        }
        return map;
      } catch (e) { return new Map(); }
    }
    
    function parseDuration(s) {
      if (!s) return '';
      const parts = String(s).trim().split(':').map(Number);
      if (parts.some(isNaN)) return '';
      let sec = 0;
      for (const p of parts) sec = sec * 60 + p;
      if (parts.length === 1) sec = parts[0]; // plain seconds
      return String(Math.round(sec / 60));
    }
    
    async function fetchEpisodes(feedUrl, sinceMs) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal });
        if (!r.ok) return [];
        const xml = await r.text();
        const out = [];
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const block = m[1];
          const pick = tag => decodeEntities((block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)) || [])[1] || '').trim();
          const pub = new Date(pick('pubDate'));
          if (isNaN(pub) || pub.getTime() < sinceMs) continue;
          const enclosure = (block.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || '';
          out.push({
            title: pick('title'),
            url: pick('link') || enclosure,
            lengthMin: parseDuration(pick('itunes:duration')),
            published: pub.toISOString().slice(0, 10),
          });
          if (out.length >= 5) break;
        }
        return out;
      } catch (e) { return []; } finally { clearTimeout(timer); }
    }
    
    async function refreshMediaFeeds() {
      // collect followed shows
      const names = new Set();
      for (const tab of ['INSTANCES', 'SOURCES']) {
        const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` }).catch(() => null);
        const rows = r ? r.data.values || [] : [];
        if (tab === 'INSTANCES') {
          const text = String((rows[0] || [])[0] || '').split(/movies/i)[0]; // podcasts are listed before the Movies/Series note
          text.split(/[,;]/).map(s => s.trim().replace(/\.$/, '')).filter(s => s && s.length < 40).forEach(s => names.add(s));
        } else {
          for (const row of prefRows(rows)) if (/podcast/i.test(String(row[0]))) names.add(String(row[0]).replace(/podcast/i, '').trim());
        }
      }
      const { headers, headerRow, rows } = await readMediaTab().catch(() => ({ headers: null }));
      if (!headers) return { added: 0, error: 'media tab unreadable' };
      const existing = new Set(rows.flatMap(r => [String(r.URL || '').trim(), (String(r.Source || '') + '|' + String(r.Title || '')).toLowerCase()]));
      const since = Date.now() - 14 * 86400000;
      const newRows = [];
      await pmap([...names], async (name) => {
        const feed = await resolveFeed(name);
        if (!feed || !feed.feedUrl) return;
        const episodes = await fetchEpisodes(feed.feedUrl, since);
        const appleLinks = episodes.length ? await appleEpisodeLinks(feed.collectionId) : new Map();
        for (const ep of episodes) {
          if (existing.has(ep.url) || existing.has((name + '|' + ep.title).toLowerCase())) continue;
          existing.add(ep.url);
          const url = appleLinks.get(normTitle(ep.title)) || ep.url; // prefer native Podcasts app link
          const rowObj = {
            Title: ep.title, Source: name, Type: 'audio', URL: url, Length_min: ep.lengthMin,
            Priority: '', Status: 'queued', Added: ep.published, Added_by: 'dashboard',
            Notes: 'auto: new episode detected', ID: crypto.randomUUID(),
          };
          newRows.push(headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
        }
      }, 4);
      if (newRows.length) {
        const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
        await store.values.update({
          spreadsheetId: TODO_SHEET_ID,
          range: `'${MEDIA_TAB}'!A${lastRow + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: newRows },
        });
      }
      console.log(`media feed refresh: ${names.size} shows checked, ${newRows.length} new items`);
      track('feed_watcher', true, `${names.size} shows, +${newRows.length} new`);
      return { added: newRows.length, shows: names.size };
    }
    
    app.post('/api/media/refresh', asyncRoute(async (req, res) => {
      res.json(await refreshMediaFeeds());
    }));
    
    
    // on startup and every 6h, drop new episodes into the Media tab
    setTimeout(() => refreshMediaFeeds().catch(e => console.error('media feed refresh failed:', e.message)), 30e3);
    setInterval(() => refreshMediaFeeds().catch(e => console.error('media feed refresh failed:', e.message)), 6 * 3600 * 1000);
  },
  client: fs.readFileSync(path.join(__dirname, 'media.client.js'), 'utf8'),
};
