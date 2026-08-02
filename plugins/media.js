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
    
    const FEEDS_FILE = path.join(__dirname, 'data', 'feeds.json');
    
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
  client: `(el, data) => {
    // plugin clients eval in GLOBAL scope: function-declared page helpers (makeSwipeable,
    // flyAway, toast, rpcPoll, newsAgent) are reachable; script-scoped consts are not —
    // so api/esc are defined locally.
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const api = (path, opts) => fetch(path, opts ? { headers: { 'Content-Type': 'application/json' }, ...opts } : undefined).then(r => r.json());
    el.innerHTML = '<div id="media-add" style="display:flex;gap:5px;margin:4px 0">'
      + '<input id="media-add-input" placeholder="Paste a link, or type what to find\u2026" style="flex:1;min-width:0;padding:4px 7px;font-size:12px;background:var(--card2);color:var(--text);border:1px solid var(--border);border-radius:5px">'
      + '<button id="media-add-btn" style="cursor:pointer">\uff0b Add</button></div>'
      + '<div id="media-add-msg" class="tiny" style="margin:0 0 4px"></div>'
      + '<div id="media-filters"><span class="fl">Type</span><button data-ftype="all" class="active">All</button><button data-ftype="audio">\ud83c\udfa7</button><button data-ftype="video">\ud83d\udcfa</button><button data-ftype="read">\ud83d\udcd6</button>'
      + '<span class="fl">Time</span><button data-fmin="0" class="active">Any</button><button data-fmin="15">\u226415m</button><button data-fmin="45">\u226445m</button></div>'
      + '<div class="card" id="mediaq"><div class="empty">Loading\u2026</div></div>';
    let mediaRows = [];
    const ICONS = { audio: '\ud83c\udfa7', video: '\ud83d\udcfa', read: '\ud83d\udcd6' };
    const mediaFilter = { type: 'all', maxMin: 0 };
    function renderMedia() {
      let items = mediaRows.filter(r => {
        const st = String(r.Status || 'queued').toLowerCase();
        if (st === 'done' || st === 'archived') return false;
        if (mediaFilter.type !== 'all' && String(r.Type || '').toLowerCase() !== mediaFilter.type) return false;
        if (mediaFilter.maxMin > 0) { const m = parseInt(r.Length_min || '0', 10); if (m && m > mediaFilter.maxMin) return false; }
        return true;
      });
      const prank = p => ({ high: 0, med: 1, medium: 1, low: 2 })[String(p || '').toLowerCase()] ?? 1;
      items.sort((a, b) => prank(a.Priority) - prank(b.Priority) || String(b.Added || '').localeCompare(String(a.Added || '')));
      el.querySelector('#mediaq').innerHTML = items.length ? items.map(r => {
        const icon = ICONS[String(r.Type || '').toLowerCase()] || '\u2022';
        const title = r.URL ? '<a class="nsrc" href="' + esc(r.URL) + '" target="_blank" rel="noopener">' + esc(r.Title) + '\u2197</a>' : esc(r.Title);
        return '<div class="mq-item swipecard" data-id="' + esc(r.ID || '') + '" data-title="' + esc(r.Title) + '" data-url="' + esc(r.URL || '') + '" data-source="' + esc(r.Source || '') + '"><span>' + icon + '</span><span class="mq-title">' + title + '</span>'
          + '<span class="mq-meta">' + esc(r.Source || '') + (r.Length_min ? ' \u00b7 ' + esc(r.Length_min) + 'm' : '') + '</span>'
          + '<button class="ib mq-agent" title="Agent: read &amp; stash in journal">\ud83e\udd16</button>'
          + '<button class="q-btn done" title="Mark consumed (swipe \u2192)">\u2713</button></div>';
      }).join('') : '<div class="empty">Queue empty for this filter.</div>';
      el.querySelectorAll('.mq-item').forEach(item => {
        const done = () => mediaDone(item, false);
        item.querySelector('.q-btn.done').onclick = done;
        item.querySelector('.mq-agent').onclick = () => window.newsAgent && newsAgent(item);
        makeSwipeable(item, { onRight: done, onLeft: () => mediaDone(item, true) });
      });
    }
    async function mediaDone(item, dismiss) {
      const id = item.dataset.id;
      if (id) await api('/api/media/' + encodeURIComponent(id) + '/done', { method: 'POST', body: '{}' });
      if (dismiss) api('/api/feedback', { method: 'POST', body: JSON.stringify({ kind: 'not_interested', title: item.dataset.title, url: item.dataset.url, source: item.dataset.source }) });
      const r = mediaRows.find(x => x.ID === id); if (r) r.Status = 'done';
      flyAway(item, dismiss ? -1 : 1, { label: dismiss ? 'remove' : 'consumed',
        reverse: () => (id ? api('/api/media/' + encodeURIComponent(id) + '/restore', { method: 'POST', body: '{}' }) : Promise.resolve()).then(() => { if (r) r.Status = 'queued'; }) });
      return true;
    }
    el.querySelectorAll('[data-ftype]').forEach(b => b.onclick = () => {
      mediaFilter.type = b.dataset.ftype;
      el.querySelectorAll('[data-ftype]').forEach(x => x.classList.toggle('active', x === b));
      renderMedia();
    });
    el.querySelectorAll('[data-fmin]').forEach(b => b.onclick = () => {
      mediaFilter.maxMin = +b.dataset.fmin;
      el.querySelectorAll('[data-fmin]').forEach(x => x.classList.toggle('active', x === b));
      renderMedia();
    });
    function mediaAdd() {
      const inp = el.querySelector('#media-add-input'), msg = el.querySelector('#media-add-msg'), btn = el.querySelector('#media-add-btn');
      const input = inp.value.trim(); if (!input) return;
      msg.style.color = 'var(--text2)'; msg.textContent = /https?:\\/\\//.test(input) ? 'Adding\u2026' : 'Finding a link\u2026';
      btn.disabled = true;
      const done = r => {
        btn.disabled = false;
        if (!r || r.error) { msg.style.color = 'var(--red)'; msg.textContent = (r && r.error) || 'add failed'; return; }
        inp.value = ''; msg.textContent = '';
        toast && toast('Added: ' + ((r.item || {}).title || 'item'));
        refresh();
      };
      api('/api/media/add', { method: 'POST', body: JSON.stringify({ input }) }).then(r => {
        if (r && r.queued) { msg.textContent = 'Finding a link\u2026'; return rpcPoll(r.id, done); }
        done(r);
      }).catch(e => { btn.disabled = false; msg.style.color = 'var(--red)'; msg.textContent = e.message; });
    }
    el.querySelector('#media-add-btn').onclick = mediaAdd;
    el.querySelector('#media-add-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mediaAdd(); } });
    const refresh = () => api('/api/media').then(x => { mediaRows = x.media || []; renderMedia(); }).catch(() => { el.querySelector('#mediaq').innerHTML = '<div class="empty">Media unreachable</div>'; });
    window.refreshMediaWidget = refresh; // news pin / queue-story repaint hook
    refresh();
  }`,
};
