// jobs widget — CLIENT (loaded verbatim by plugins/jobs.js; runs in the page's global
// scope via the plugin loader). Moved out of an escaped string (sidecar pattern, 2026-08-02).
(el, data) => {
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fetch((window.__BASE__ || '') + '/api/jobs').then(r => r.json()).then(r => {
      const open = (r.jobs || []).filter(j => j.status === 'open').sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
      const applied = (r.jobs || []).filter(j => j.status === 'applied').length;
      if (!open.length) { el.innerHTML = '<div class="empty">No open roles' + (applied ? ' \u00b7 ' + applied + ' applied' : '') + ' \u2014 the search agent adds new ones daily. <a href="/jobs">board \u2192</a></div>'; return; }
      const stamp = Date.parse(localStorage.getItem('jobs-last-visit') || '') || (Date.now() - 48 * 3600e3);
      const cutoff = Math.min(stamp, Date.now() - 24 * 3600e3);
      const fresh = open.filter(j => (Date.parse(j.created || '') || 0) > cutoff);
      const counts = open.length + ' open' + (applied ? ' \u00b7 ' + applied + ' applied' : '') + ' \u00b7 <a href="/jobs">full board \u2192</a>';
      if (!fresh.length) { el.innerHTML = '<div class="tiny">no new openings since your last board visit \u00b7 ' + counts + '</div>'; return; }
      el.innerHTML = fresh.slice(0, 5).map(j =>
        '<div style="margin:2px 0;border-left:2px solid var(--green);padding-left:6px">\ud83d\udcbc ' + (j.url ? '<a href="' + esc(j.url) + '" target="_blank" rel="noopener"><b>' + esc(j.title) + '</b></a>' : '<b>' + esc(j.title) + '</b>')
        + ((j.flags || []).includes('hot') ? ' <span style="font-size:9px;font-weight:700;color:#e9b949">\u26a1</span>' : '')
        + ' <span class="muted">\u2014 ' + esc(j.company) + (j.location ? ' \u00b7 ' + esc(j.location) : '') + '</span></div>').join('')
        + '<div class="tiny" style="margin-top:3px"><b style="color:var(--green)">' + fresh.length + ' new</b>' + (fresh.length > 5 ? ' (top 5 shown)' : '') + ' since your last board visit \u00b7 ' + counts + '</div>';
    }).catch(() => { el.innerHTML = '<div class="empty">Jobs board unreachable</div>'; });
  }
