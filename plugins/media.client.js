// media widget — CLIENT (loaded verbatim by plugins/media.js; runs in the page's global
// scope via the plugin loader). Moved out of an escaped string (sidecar pattern, 2026-08-02).
(el, data) => {
    // plugin clients eval in GLOBAL scope: function-declared page helpers (makeSwipeable,
    // flyAway, toast, rpcPoll, newsAgent) are reachable; script-scoped consts are not —
    // so api/esc are defined locally.
    const { api, esc, toast, makeSwipeable, flyAway, rpcPoll, newsAgent } = window.dashyng || {};
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
        item.querySelector('.mq-agent').onclick = () => newsAgent && newsAgent(item);
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
      msg.style.color = 'var(--text2)'; msg.textContent = /https?:\/\//.test(input) ? 'Adding\u2026' : 'Finding a link\u2026';
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
    const refresh = () => api('/api/media').then(x => { mediaRows = x.media || []; renderMedia(); }).catch(e => { el.querySelector('#mediaq').innerHTML = '<div class="err">media: ' + String(e && e.message || e).replace(/</g, '&lt;') + '</div>'; });
    window.refreshMediaWidget = refresh; // news pin / queue-story repaint hook
    refresh();
  }
