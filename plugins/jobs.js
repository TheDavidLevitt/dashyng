// 💼 Jobs board — extracted from the core (phase 2). The /jobs page stays in public/;
// this plugin owns the API and the dashboard summary card. Job rows live on the instance's
// own sheet; the daily search agent posts through the same routes it always did.
let ctx0 = null;
const fs = require('fs'), path = require('path');
module.exports = {
  key: 'jobsboard',
  core: true,
  title: 'Job Openings',
  desc: 'Agent-curated job board',
  needs: { llm: true, tabs: ['Jobs'] },
  async data() { return { see: '/api/jobs' }; }, // the client fn fetches the real payload
  routes(app, ctx) {
    ctx0 = ctx;
    const { store, asyncRoute, readTab, appendTabRow, colLetter, writeFeedbackEntry, SIGNAL_BY_KIND, nowIso, track } = ctx;
    const SHEET_ID = ctx.sheetId;
    const crypto = require('crypto');
    // Job openings tracked on their own Sheet tab (durable, cross-instance). A daily headless
    // agent (bin/jobsearch.sh, Sonnet-tier with web search) appends new openings via POST
    // /api/jobs; the owner curates on the /jobs page — drag to re-rank, swipe left to remove,
    // 👍 = more like this, checkbox = application done. Every curation action emits a CI
    // feedback signal (job_* kinds above) so the searcher's taste improves.
    // Est = comma-list of LLM-ESTIMATED field names (remote,salary,deadline,posted) — the UI
    // renders those values in purple to keep estimates visually distinct from stated facts.
    const JOBS_TAB = 'Jobs';
    const JOBS_HEADERS = ['Title', 'URL', 'Company', 'CompanyURL', 'Category', 'Location', 'Remote', 'Salary', 'Deadline', 'Posted', 'Est', 'Status', 'Rank', 'Notes', 'Source', 'Created', 'Updated', 'ID', 'Flags', 'Fit'];
    // hint a stable subset so optional new columns (Flags) never break reads of an older tab
    const JOBS_HINT = ['Title', 'Company', 'Status', 'ID'];
    const readJobsTab = () => readTab(SHEET_ID, JOBS_TAB, JOBS_HINT);
    const jobOut = r => ({
      id: r.ID, title: r.Title, url: r.URL, company: r.Company, companyUrl: r.CompanyURL,
      category: r.Category || 'Uncategorized', location: r.Location, remote: r.Remote,
      salary: r.Salary, deadline: r.Deadline, posted: r.Posted,
      est: String(r.Est || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      status: r.Status || 'open', rank: parseFloat(r.Rank) || 0,
      notes: r.Notes, source: r.Source, created: r.Created, updated: r.Updated,
      // Fit: LLM-estimated %-match of the owner's CV vs the posting (required-weighted).
      // A trailing 'i' (e.g. '64i') means the requirements were INFERRED from training
      // knowledge because the posting didn't state them — the UI renders green (stated)
      // vs blue (inferred).
      fit: parseInt(r.Fit) || 0,
      fitInferred: /i\s*$/i.test(String(r.Fit || '')),
      // flags: csv of UI markers; 'hot' = energy-team role AT an AI/compute company (labs,
      // hyperscalers, GPU clouds, DC operators) — rendered prominently on the board
      flags: String(r.Flags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      // ★ tier from the fav token: 0 none / 1 ★ / 2 ★★, plus first-starred epoch for ordering
      fav: (t => t ? (t.startsWith('fav2') ? 2 : 1) : 0)(String(r.Flags || '').toLowerCase().split(',').map(s => s.trim()).find(t => t.startsWith('fav'))),
      favAt: (t => t && t.includes(':') ? Number(t.split(':')[1]) : 0)(String(r.Flags || '').toLowerCase().split(',').map(s => s.trim()).find(t => t.startsWith('fav'))),
    });
    const jobFeedback = (kind, r, context) => writeFeedbackEntry({
      at: nowIso(), kind, signal: SIGNAL_BY_KIND[kind] ?? 0,
      title: `${r.Title || ''} @ ${r.Company || ''}`, url: r.URL || '', source: 'jobs',
      subjects: [r.Category || ''].filter(Boolean), context: context || '',
    }).catch(e => console.error('job feedback:', e.message));
    
    app.get('/api/jobs', asyncRoute(async (req, res) => {
      let rows = [];
      try { rows = (await readJobsTab()).rows; }
      catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; } // tab not created yet = empty board
      const all = String(req.query.all || '') === '1'; // agent dedup wants removed rows too
      const jobs = rows.map(jobOut).filter(j => all || (j.status !== 'removed' && j.status !== 'closed'))
        .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
      res.json({ jobs });
    }));
    
    // Add one opening (daily agent, or a manual paste from the page). Dedup: URL match, or
    // same Title+Company, against ALL rows including removed — a swiped-away job must never
    // be re-added by the next day's search.
    app.post('/api/jobs', asyncRoute(async (req, res) => {
      const b = req.body || {};
      if (!b.title || !b.company) return res.status(400).json({ error: 'title and company required' });
      let existing = [];
      try { existing = (await readJobsTab()).rows; } catch (e) {}
      const norm = s => String(s || '').trim().toLowerCase().replace(/\/+$/, '');
      const dup = existing.find(r => (b.url && norm(r.URL) === norm(b.url))
        || (norm(r.Title) === norm(b.title) && norm(r.Company) === norm(b.company)));
      if (dup) {
        // a role the owner marked CLOSED reposting under a fresh URL is good news, not a
        // duplicate — revive the row in place (NRG-repost pattern). Removed rows stay dead.
        if (dup.Status === 'closed' && b.url && norm(dup.URL) !== norm(b.url)) {
          await updateJobById(dup.ID, {
            URL: b.url, Status: 'open',
            Notes: `reposted ${nowIso().slice(0, 10)} — ` + String(dup.Notes || '').replace(/^⚠[^—]*— */, ''),
            ...(b.fit !== undefined ? { Fit: String(b.fit) } : {}),
          });
          return res.json({ ok: true, revived: true, id: dup.ID });
        }
        return res.json({ ok: true, deduped: true, id: dup.ID });
      }
      const id = crypto.randomUUID();
      const est = Array.isArray(b.est) ? b.est.join(',') : String(b.est || '');
      const flags = Array.isArray(b.flags) ? b.flags.join(',') : String(b.flags || '');
      // default rank: after the current bottom of the job's category
      const catRanks = existing.filter(r => (r.Category || '') === (b.category || '') && r.Status !== 'removed')
        .map(r => parseFloat(r.Rank) || 0);
      const rank = b.rank !== undefined ? Number(b.rank) : (catRanks.length ? Math.max(...catRanks) + 1 : 1);
      await appendTabRow(JOBS_TAB, JOBS_HEADERS, [
        b.title, b.url || '', b.company, b.companyUrl || '', b.category || '', b.location || '',
        b.remote || '', b.salary || '', b.deadline || '', b.posted || '', est,
        'open', String(rank), b.notes || '', b.source || WRITE_SOURCE, nowIso(), nowIso(), id, flags,
        b.fit !== undefined ? String(b.fit) : '',
      ]);
      res.json({ ok: true, id });
    }));
    
    // Update named columns of one job row, located fresh by ID (same pattern as tasks).
    async function updateJobById(id, changes) {
      const { headers, rows } = await readJobsTab();
      const row = rows.find(r => r.ID === id);
      if (!row) return null;
      changes.Updated = nowIso();
      const data = Object.entries(changes)
        .filter(([f]) => headers.indexOf(f) !== -1)
        .map(([f, v]) => ({ range: `'${JOBS_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
      if (data.length) await store.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
      return { ...row, ...changes };
    }
    
    app.patch('/api/jobs/:id', asyncRoute(async (req, res) => {
      const allowed = ['Title', 'URL', 'Company', 'CompanyURL', 'Category', 'Location', 'Remote', 'Salary', 'Deadline', 'Posted', 'Est', 'Status', 'Rank', 'Notes', 'Flags', 'Fit'];
      const changes = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        const f = allowed.find(a => a.toLowerCase() === k.toLowerCase());
        if (f) changes[f] = String(v);
      }
      if (!Object.keys(changes).length) return res.status(400).json({ error: 'no updatable fields' });
      const updated = await updateJobById(req.params.id, changes);
      if (!updated) return res.status(404).json({ error: 'job not found: ' + req.params.id });
      res.json({ ok: true, job: jobOut(updated) });
    }));
    
    // swipe left / ✕ — hide forever + negative CI signal
    app.post('/api/jobs/:id/remove', asyncRoute(async (req, res) => {
      const updated = await updateJobById(req.params.id, { Status: 'removed' });
      if (!updated) return res.status(404).json({ error: 'job not found' });
      await jobFeedback('job_not_interested', updated, req.body?.context || '');
      res.json({ ok: true });
    }));
    
    // checkbox — application completed (toggle; un-checking restores 'open', no signal)
    app.post('/api/jobs/:id/applied', asyncRoute(async (req, res) => {
      const applied = req.body?.applied !== false;
      const updated = await updateJobById(req.params.id, { Status: applied ? 'applied' : 'open' });
      if (!updated) return res.status(404).json({ error: 'job not found' });
      if (applied) await jobFeedback('job_applied', updated);
      res.json({ ok: true });
    }));
    
    // ⊘ rejected — application OUTCOME on an applied role (stays in the applications log,
    // dimmed). Toggling back to applied is silent; rejecting emits a zero-weight outcome
    // signal so the CI can track which application lanes convert.
    app.post('/api/jobs/:id/rejected', asyncRoute(async (req, res) => {
      const rejected = req.body?.rejected !== false;
      const updated = await updateJobById(req.params.id, { Status: rejected ? 'rejected' : 'applied' });
      if (!updated) return res.status(404).json({ error: 'job not found' });
      if (rejected) await jobFeedback('job_rejected', updated, 'application rejected');
      res.json({ ok: true });
    }));

    // 👍 — strong "more like this" (legacy button; the board now uses /star below)
    app.post('/api/jobs/:id/up', asyncRoute(async (req, res) => {
      const { rows } = await readJobsTab();
      const row = rows.find(r => r.ID === req.params.id);
      if (!row) return res.status(404).json({ error: 'job not found' });
      await jobFeedback('job_more_like_this', row);
      res.json({ ok: true });
    }));
    
    // ★ tri-state — level 0 (none) / 1 (★ favorite) / 2 (★★ favorite-favorite). The flag
    // token carries the FIRST-starred epoch (fav:<ts> / fav2:<ts>) so the Favorites section
    // can keep click-chronological order across devices; upgrades preserve the timestamp.
    // Owner-set; the search agent never touches fav tokens. Any upward transition fires the
    // strong "more like this" signal; downgrades/unstars are silent (a de-pin, not a downvote).
    app.post('/api/jobs/:id/star', asyncRoute(async (req, res) => {
      const { rows } = await readJobsTab();
      const row = rows.find(r => r.ID === req.params.id);
      if (!row) return res.status(404).json({ error: 'job not found' });
      const level = Math.max(0, Math.min(2, Number(req.body?.level ?? (req.body?.starred === false ? 0 : 1))));
      const tokens = String(row.Flags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const old = tokens.find(t => t === 'fav' || t.startsWith('fav:') || t === 'fav2' || t.startsWith('fav2:'));
      const oldLevel = old ? (old.startsWith('fav2') ? 2 : 1) : 0;
      const ts = old && old.includes(':') ? old.split(':')[1] : String(Date.now());
      const rest = tokens.filter(t => t !== old);
      if (level) rest.push(`${level === 2 ? 'fav2' : 'fav'}:${ts}`);
      await updateJobById(req.params.id, { Flags: rest.join(',') });
      if (level > oldLevel) await jobFeedback('job_more_like_this', row, level === 2 ? 'double-star' : 'star');
      res.json({ ok: true, flags: rest });
    }));
    
    // ∅ closed — the POSTING died (link dead / req filled): retire the row with ZERO
    // taste signal (job_closed is bookkeeping, not preference — unlike swipe-remove's -1).
    // Kept as its own status so a fresh posting of the same role can auto-revive the row.
    app.post('/api/jobs/:id/closed', asyncRoute(async (req, res) => {
      const closed = req.body?.closed !== false;
      const updated = await updateJobById(req.params.id, { Status: closed ? 'closed' : 'open' });
      if (!updated) return res.status(404).json({ error: 'job not found' });
      if (closed) await jobFeedback('job_closed', updated, 'link dead / job closed');
      res.json({ ok: true });
    }));

    // 🤔 maybe — park the role in the board's collapsed Maybe section (deferred, mildly
    // positive signal when parking; un-parking is silent)
    app.post('/api/jobs/:id/maybe', asyncRoute(async (req, res) => {
      const maybe = req.body?.maybe !== false;
      const updated = await updateJobById(req.params.id, { Status: maybe ? 'maybe' : 'open' });
      if (!updated) return res.status(404).json({ error: 'job not found' });
      if (maybe) await jobFeedback('job_maybe', updated);
      res.json({ ok: true });
    }));
    
    // Drag re-rank: updates[]={id,rank}; movedUp names the dragged job when it moved HIGHER,
    // which doubles as a mild "more like this" signal (owner rule: drag-higher ≈ thumbs up).
    app.post('/api/jobs/reorder', asyncRoute(async (req, res) => {
      const updates = req.body?.updates;
      if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'updates[] required' });
      const { headers, rows } = await readJobsTab();
      const byId = new Map(rows.map(r => [r.ID, r]));
      const ts = nowIso(); const data = []; const missing = [];
      const rankCol = headers.indexOf('Rank'), updCol = headers.indexOf('Updated');
      for (const u of updates) {
        const row = u.id && byId.get(u.id);
        if (!row) { missing.push(u.id || '(blank)'); continue; }
        data.push({ range: `'${JOBS_TAB}'!${colLetter(rankCol)}${row._row}`, values: [[String(u.rank)]] });
        if (updCol !== -1) data.push({ range: `'${JOBS_TAB}'!${colLetter(updCol)}${row._row}`, values: [[ts]] });
      }
      if (data.length) await store.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
      const moved = req.body?.movedUp && byId.get(req.body.movedUp);
      if (moved) await jobFeedback('job_ranked_up', moved);
      res.json({ ok: true, applied: updates.length - missing.length, missing });
    }));
    
    
  },
  client: fs.readFileSync(path.join(__dirname, 'jobs.client.js'), 'utf8'),
};
