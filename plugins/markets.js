// 📈 Markets — quotes, futures strips, yield curve, sovereign CDS, portfolio tiles.
// Extracted from the core (phase 2d, the last big one). Config rides the same
// Heartbeat!N1 envelope it always did; the cloud→Mac resolve queue registers its RPC
// handler through ctx.registerRpc instead of the core table.
const fs = require('fs'), path = require('path');
const DATA = path.join(__dirname, '..', 'data'); // plugin lives in plugins/, data stays at repo root
module.exports = {
  key: 'markets',
  core: true,
  title: 'Markets',
  desc: 'Quotes, futures, portfolio, market plots',
  needs: {},
  async data() { return { see: '/api/markets' }; },
  routes(app, ctx) {
    const cfg = ctx.config;
    const { store, asyncRoute, track, nowIso, pmap, prefRows, enqueueRpc, runLLM } = ctx;
    const TODO_SHEET_ID = ctx.sheetId;
    const runClaude = runLLM;
    // Tiles are GUI-editable (add/remove/drag-reorder/resize) — config lives in
    // data/markets-local.json (gitignored, runtime) synced cross-tier via Heartbeat!N1, same
    // pattern as roles/credits. Sizes: 'ticker' (price only, ~10/row) | 'small' (spark, ~6/row)
    // | 'large' (big plot, 2/row). Types: 'quote' (a symbol, historic plot over `range`) |
    // 'strip' (futures term structure to max available distance) | 'ustcurve' (Treasury curve).
    // Generic first-run tiles (indices/FX/vol only — nothing portfolio-flavored); every
    // instance's real tiles live in markets-local.json + the synced envelope, so existing
    // deployments never see these.
    const DEFAULT_MARKET_TILES = [
      { id: 'spx', type: 'quote', sym: '^GSPC', label: 'S&P 500', fmt: 'int', size: 'small', range: '1y' },
      { id: 'ixic', type: 'quote', sym: '^IXIC', label: 'Nasdaq', fmt: 'int', size: 'small', range: '1y' },
      { id: 'stoxx', type: 'quote', sym: '^STOXX50E', label: 'EuroStoxx 50', fmt: 'int', size: 'small', range: '1y' },
      { id: 'vix', type: 'quote', sym: '^VIX', label: 'VIX', fmt: 'num', size: 'small', range: '1y' },
      { id: 'eurusd', type: 'quote', sym: 'EURUSD=X', label: 'EUR/USD', fmt: 'fx', size: 'small', range: '1y' },
      { id: 'gold', type: 'quote', sym: 'GC=F', label: 'Gold', fmt: 'int', size: 'small', range: '1y' },
    ];
    const MARKETS_LOCAL = path.join(DATA, 'markets-local.json');
    const MARKETS_CELL = "'Heartbeat'!N1";
    // The Sheet cell payload is a versioned envelope {savedAt, tiles} (bare arrays = legacy,
    // savedAt 0). BUG FIX 2026-07-02: without the version stamp, three tiers all doing
    // last-write-wins meant a stale instance (e.g. an old Cloud Run revision, or a tier that
    // booted with an old baked-in config) could push its outdated snapshot to the Sheet and
    // silently revert every other tier's config — this wiped real user tiles in production.
    function parseTilesPayload(raw) {
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j)) return { savedAt: 0, tiles: j };
        if (j && Array.isArray(j.tiles)) return { savedAt: j.savedAt || 0, tiles: j.tiles };
      } catch (e) {}
      return null;
    }
    function readTilesFile() {
      let raw;
      try { raw = fs.readFileSync(MARKETS_LOCAL, 'utf8'); }
      catch (e) { return null; } // no file yet — a genuinely fresh install, not corruption
      const parsed = parseTilesPayload(raw);
      if (!parsed) { console.error('markets-local.json exists but is unreadable — serving defaults, not the saved config'); markersFileCorrupt = true; }
      else markersFileCorrupt = false;
      return parsed;
    }
    let markersFileCorrupt = false; // readTilesFile() sets this; loadMarketTiles() can't return it without
    // breaking every internal caller that expects a plain tiles array — GET /api/markets reads
    // this flag separately so the GUI can attribute "showing defaults" to a real config failure.
    function loadMarketTiles() {
      const f = readTilesFile();
      return f && f.tiles.length ? f.tiles : DEFAULT_MARKET_TILES;
    }
    function saveMarketTiles(tiles) {
      const payload = JSON.stringify({ savedAt: Date.now(), tiles });
      try { fs.writeFileSync(MARKETS_LOCAL, payload); } catch (e) {}
      bustMarketCache(); // so the next GET reflects the edit
      store.values.update({ spreadsheetId: TODO_SHEET_ID, range: MARKETS_CELL, valueInputOption: 'RAW', requestBody: { values: [[payload.slice(0, 49000)]] } }).catch(() => {});
    }
    async function syncMarketsFromSheet() {
      try {
        const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: MARKETS_CELL });
        const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
        const remote = parseTilesPayload(raw);
        if (!remote || !remote.tiles.length) return;
        const local = readTilesFile();
        if (local && remote.savedAt <= local.savedAt) return; // never regress to an older/equal snapshot
        fs.writeFileSync(MARKETS_LOCAL, raw);
        bustMarketCache(); // a config edit on another tier must invalidate THIS process's
        // in-memory quote cache too, or it serves stale data for up to 10 minutes.
      } catch (e) {}
    }
    syncMarketsFromSheet(); setInterval(syncMarketsFromSheet, 10 * 60000);
    let marketCache = { at: 0, data: null };
    // Generation counter closes a race: a GET that started building BEFORE a config edit would
    // finish AFTER the bust and store its stale result back into the cache for 10 more minutes.
    let marketCacheGen = 0;
    function bustMarketCache() { marketCacheGen++; marketCache = { at: 0, data: null }; }
    
    // x-axis ranges: max | 5y | 1y | 1mo | 1wk → Yahoo (range, interval) pairs
    const RANGE_MAP = { max: ['max', '1mo'], '5y': ['5y', '1wk'], '1y': ['1y', '1wk'], '1mo': ['1mo', '1d'], '1wk': ['5d', '60m'] };
    async function fetchYahoo(sym, range = '1y', withTs) {
      const [r0, iv] = RANGE_MAP[range] || RANGE_MAP['1y'];
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${r0}&interval=${iv}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`yahoo ${sym}: HTTP ${r.status}`);
      const j = await r.json();
      const result = j.chart?.result?.[0];
      if (!result) throw new Error(`yahoo ${sym}: empty result`);
      const meta = result.meta || {};
      const rawCloses = result.indicators?.quote?.[0]?.close || [];
      const closes = rawCloses.filter(v => v != null);
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose && closes.length > 1 ? closes[closes.length - 2] : null;
      const changePct = prev ? ((price - prev) / prev) * 100 : null;
      const out = { price, changePct, spark: closes };
      if (withTs) { // dated points, for grouped multi-series plots (one real time axis)
        const ts = result.timestamp || [];
        out.pts = rawCloses.map((v, i) => v != null && ts[i] != null ? { t: ts[i] * 1000, v } : null).filter(Boolean);
      }
      return out;
    }
    
    // last + previous daily close for one symbol (for futures-strip today/yesterday)
    async function fetchLast2(sym) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const res = j?.chart?.result?.[0];
      const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      if (!closes.length) return null;
      return { today: res.meta?.regularMarketPrice ?? closes[closes.length - 1], yday: closes.length > 1 ? closes[closes.length - 2] : null };
    }
    
    // Futures-strip presets: Yahoo monthly contract codes <ROOT><MONTHCODE><YY><suffix>.
    // quarterly roots trade H/M/U/Z only (generating every month just wastes fetches on 404s).
    // SOFR (SR3, CME 3-month SOFR futures — the LIBOR successor curve) quotes as 100 − rate, so
    // invert=true turns the strip into an implied forward-rate curve in %.
    // farYears: beyond `months` of monthly contracts, only December contracts trade liquidly —
    // generate Dec-only out to farYears so oil/gas strips reach the true tradable horizon (~12y)
    // without fetching 144 dead symbols.
    const STRIP_PRESETS = {
      oil: { root: 'BZ', front: 'BZ=F', suffix: '.NYM', label: 'Brent ($/bbl)', months: 24, farYears: 12, cat: 'oil' },
      wti: { root: 'CL', front: 'CL=F', suffix: '.NYM', label: 'WTI ($/bbl)', months: 24, farYears: 12, cat: 'oil' },
      gas: { root: 'NG', front: 'NG=F', suffix: '.NYM', label: 'Henry Hub ($/MMBtu)', months: 24, farYears: 12, cat: 'gas' },
      gold: { root: 'GC', front: 'GC=F', suffix: '.CMX', label: 'Gold ($/oz)', months: 18, farYears: 6, cat: 'metal' },
      btc: { root: 'BTC', front: 'BTC=F', suffix: '.CME', label: 'Bitcoin ($)', months: 12, quarterly: true, cat: 'crypto' },
      sp: { root: 'ES', front: 'ES=F', suffix: '.CME', label: 'S&P 500 fut', months: 15, quarterly: true, cat: 'index' },
      nasdaq: { root: 'NQ', front: 'NQ=F', suffix: '.CME', label: 'Nasdaq fut', months: 15, quarterly: true, cat: 'index' },
      dow: { root: 'YM', front: 'YM=F', suffix: '.CBT', label: 'Dow fut', months: 15, quarterly: true, cat: 'index' },
      sofr: { root: 'SR3', front: 'SR3=F', suffix: '.CME', label: 'SOFR fwd % (LIBOR successor)', months: 48, quarterly: true, invert: true, cat: 'rates' },
      // virtual preset: the UST yield curve as a strip series (tenor → months) so it can be
      // grouped onto the same term axis as SOFR — both are yield-vs-term in %.
      ust: { label: 'UST yield (%)', cat: 'rates', virtual: 'ust' },
    };
    const UST_TENOR_MONTHS = { '1M': 1, '2M': 2, '3M': 3, '4M': 4, '6M': 6, '1Y': 12, '2Y': 24, '3Y': 36, '5Y': 60, '7Y': 84, '10Y': 120, '20Y': 240, '30Y': 360 };
    // months-ahead of a contract label ('front' → 0, 'V26' → Oct 2026 minus now) — gives every
    // strip point a true time coordinate so multi-curve plots share ONE x-axis and curves with
    // shorter listings simply end early instead of being stretched to full width.
    const MONTH_CODES = 'FGHJKMNQUVXZ';
    function monthsAhead(label) {
      const mm = /^([FGHJKMNQUVXZ])(\d\d)$/.exec(String(label));
      if (!mm) return 0;
      const now = new Date();
      return (2000 + +mm[2] - now.getUTCFullYear()) * 12 + (MONTH_CODES.indexOf(mm[1]) - now.getUTCMonth());
    }
    // coarse category for grouping rules: max 2 categories per plot, first category = left axis
    function symCat(sym) {
      const s = String(sym || '');
      if (/^(BZ|CL)=F$/.test(s)) return 'oil';
      if (/^NG=F$/.test(s)) return 'gas';
      if (/=F$/.test(s)) return 'commodity';
      if (/^\^/.test(s)) return 'index';
      if (/=X$/.test(s)) return 'fx';
      return 'stock';
    }
    // One contract's today / prior-day / prior-month closes in a single Yahoo call.
    async function fetchContract(sym) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null);
      if (!r || !r.ok) return null;
      const j = await r.json().catch(() => null);
      const res = j?.chart?.result?.[0];
      const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      if (!closes.length) return null;
      return {
        today: res.meta?.regularMarketPrice ?? closes[closes.length - 1],
        yday: closes.length > 1 ? closes[closes.length - 2] : null,
        monthAgo: closes.length > 5 ? closes[0] : null, // ~21 trading days back
      };
    }
    const stripCacheByKey = {};
    async function fetchStrip(presetKey) {
      const p = STRIP_PRESETS[presetKey];
      if (!p) throw new Error('unknown strip preset: ' + presetKey);
      const c = stripCacheByKey[presetKey];
      if (c && Date.now() - c.at < 30 * 60 * 1000) return c.pts;
      if (p.virtual === 'ust') { // UST yield curve rendered as a term strip (shared m-axis with SOFR)
        const y = await getYieldCurve();
        const prev = t => ((y.prevCurve || []).find(x => x.tenor === t) || {}).yield ?? null;
        const pts = (y.curve || []).filter(x => UST_TENOR_MONTHS[x.tenor] != null && x.yield != null)
          .map(x => ({ label: x.tenor, m: UST_TENOR_MONTHS[x.tenor], today: x.yield, yday: prev(x.tenor), monthAgo: null }));
        stripCacheByKey[presetKey] = { at: Date.now(), pts };
        return pts;
      }
      const near = fwdContracts(p.root, p.months, p.suffix, p.quarterly);
      const far = [];
      if (p.farYears) { // Dec-only contracts from just past the monthly window to the far horizon
        const y0 = new Date().getUTCFullYear();
        for (let y = y0 + Math.ceil(p.months / 12) + (new Date().getUTCMonth() === 11 ? 1 : 0); y <= y0 + p.farYears; y++) {
          far.push({ label: `Z${String(y).slice(2)}`, sym: `${p.root}Z${String(y).slice(2)}${p.suffix}` });
        }
      }
      const months = [...near, ...far.filter(f => !near.some(n => n.label === f.label))];
      const front = p.invert ? null : await fetchContract(p.front); // continuous front anchors non-rate strips
      const raw = await pmap(months, async (m) => { const v = await fetchContract(m.sym); return v ? { label: m.label, ...v } : null; }, 6);
      const inv = v => v == null ? null : 100 - v;
      let pts = [front ? { label: 'front', ...front } : null, ...raw].filter(Boolean);
      pts = pts.map(x => ({ ...x, m: monthsAhead(x.label) })); // true time coordinate (shared x-axis)
      if (p.invert) pts = pts.map(x => ({ ...x, today: inv(x.today), yday: inv(x.yday), monthAgo: inv(x.monthAgo) }));
      stripCacheByKey[presetKey] = { at: Date.now(), pts };
      return pts;
    }
    async function buildMarketTile(t) {
      try {
        if (t.type === 'meta') return t; // config carrier (e.g. hidden-CDS list), no data fetch
        if (t.type === 'strip') {
          // multi-series: tile.presets = ['oil','gas'] plots multiple curves (dual-axis in the UI);
          // legacy single tile.preset still supported.
          const keys = Array.isArray(t.presets) && t.presets.length ? t.presets : [t.preset].filter(Boolean);
          const series = await pmap(keys.filter(k => STRIP_PRESETS[k]), async k => ({
            key: k, label: STRIP_PRESETS[k].label, cat: STRIP_PRESETS[k].cat, invert: !!STRIP_PRESETS[k].invert, pts: await fetchStrip(k).catch(() => []),
          }), 2);
          return { ...t, presets: keys, series, stripLabel: series.map(s => s.label).join(' / ') };
        }
        if (t.type === 'ustcurve') { // reuse the Treasury endpoint's cache/fetcher
          const y = await getYieldCurve();
          return { ...t, curve: y };
        }
        if (t.type === 'cds') { // sovereign CDS — a real tile now (drag/resize/remove like anything else)
          const c = await getCdsRow(t.country);
          return { ...t, cds: c, label: t.label || `${t.country} CDS` };
        }
        if (t.type === 'group') { // drag-merged multi-series plot: dated points, one shared time axis
          const series = await pmap(t.items || [], async it => {
            if (it.kind === 'cds') {
              const c = await getCdsRow(it.country).catch(() => null);
              let pts = cdsHistoryDated(it.country);
              if (c && !c.error && pts.length < 3) { // fresh tier: synthesize 6m/1m anchors
                const now = Date.now();
                pts = [{ t: now - 182 * 86400000, v: c.cds5y / (1 + c.var6m / 100) }, { t: now - 30 * 86400000, v: c.cds5y / (1 + c.var1m / 100) }, { t: now, v: c.cds5y }];
              }
              return { label: it.label, cat: 'cds', pts, last: c && !c.error ? c.cds5y : null, unit: 'bp' };
            }
            const q = await fetchYahoo(it.sym, t.range || '1y', true).catch(() => null);
            return { label: it.label, cat: symCat(it.sym), pts: q ? q.pts : [], last: q ? q.price : null, ...(it.shares > 0 ? { shares: it.shares } : {}) };
          }, 3);
          return { ...t, series };
        }
        const q = await fetchYahoo(t.sym, t.range || '1y');
        return { ...t, ...q };
      } catch (e) { return { ...t, error: e.message }; }
    }
    app.get('/api/markets', asyncRoute(async (req, res) => {
      if (marketCache.data && Date.now() - marketCache.at < 10 * 60 * 1000) return res.json(marketCache.data);
      const gen = marketCacheGen;
      const tiles = loadMarketTiles();
      const out = await pmap(tiles, buildMarketTile, 6);
      // dual-currency: attach the USD value for tiles that ask for it (TTE €/$); the fx source
      // may itself not be a tile anymore, so fetch it directly if missing.
      for (const q of out) {
        if (q.dual && q.price != null) {
          let fx = out.find(x => x.sym === q.dual)?.price;
          if (!fx) { try { fx = (await fetchYahoo(q.dual, '1mo')).price; } catch (e) {} }
          if (fx) q.priceUsd = q.price * fx;
        }
      }
      // Portfolio: synthetic card summing every #shares holding — standalone quote tiles AND
      // series inside grouped plots (holdings survive a drag-merge). USD where known.
      const pfItems = out.filter(x => x.type === 'quote' && x.shares > 0 && x.price != null)
        .map(x => ({ label: x.label, shares: x.shares, value: (x.priceUsd ?? x.price) * x.shares }));
      for (const g of out.filter(x => x.type === 'group'))
        for (const s of g.series || []) if (s.shares > 0 && s.last != null) pfItems.push({ label: s.label, shares: s.shares, value: s.last * s.shares });
      if (pfItems.length) out.push({ id: '_portfolio', type: 'portfolio', label: 'Portfolio', size: 'small', items: pfItems, total: pfItems.reduce((a, b) => a + b.value, 0) });
      const okCount = out.filter(q => !q.error).length;
      track('markets', okCount > 0, `${okCount}/${out.length} tiles`);
      const data = { at: nowIso(), quotes: out };
      if (tiles === DEFAULT_MARKET_TILES && markersFileCorrupt) data.configError = 'saved market config unreadable — showing defaults';
      if (gen === marketCacheGen) marketCache = { at: Date.now(), data }; // don't overwrite a newer bust
      res.json(data);
    }));
    // Build one new tile object from a client-supplied spec — shared by single-add and batch-add.
    function buildNewTile(tile) {
      const nt = { id: crypto.randomUUID().slice(0, 8), type: tile.type || 'quote', size: tile.size || 'small', range: tile.range || '1y' };
      for (const f of ['sym', 'label', 'fmt', 'preset', 'country']) if (tile[f]) nt[f] = String(tile[f]).slice(0, 60);
      if (Array.isArray(tile.presets)) nt.presets = tile.presets.map(String).filter(k => STRIP_PRESETS[k]).slice(0, 4);
      if (nt.type === 'quote') {
        nt.sym = String(nt.sym || '').toUpperCase(); nt.label = nt.label || nt.sym; nt.fmt = nt.fmt || 'stock';
        if (+tile.shares > 0 && symCat(nt.sym) === 'stock') nt.shares = +tile.shares; // holdings → Portfolio card
      }
      if (nt.type === 'strip') {
        if (!nt.presets && nt.preset) nt.presets = [nt.preset];
        nt.showYday = tile.showYday !== false; nt.showMonthAgo = !!tile.showMonthAgo;
        nt.label = nt.label || (nt.presets || []).map(k => (STRIP_PRESETS[k] || {}).label || k).join(' / ');
      }
      if (nt.type === 'ustcurve') nt.label = nt.label || 'UST yield curve';
      if (nt.type === 'cds') nt.label = nt.label || `${nt.country} CDS`;
      return nt;
    }
    function validNewTile(tile) {
      return tile && (tile.sym || tile.preset || tile.presets || tile.type === 'ustcurve' || (tile.type === 'cds' && tile.country));
    }
    // GUI edits: add (single or batch) / update (size, range, curves) / remove / reorder —
    // persisted + cross-tier synced. CDS are now ordinary tiles (type:'cds'), so "remove" IS
    // "hide" for them — no separate hidden-list mechanism needed any more.
    // Serialized: each request does an unlocked read (syncMarketsFromSheet + loadMarketTiles),
    // mutates in memory, then writes (saveMarketTiles). Two concurrent POSTs (double-click, two
    // tabs/devices, agent + human) could otherwise both read before either writes, and the
    // second write silently drops the first edit. A promise-chain queue serializes the whole
    // read-modify-write per request instead of only guarding the final write.
    let marketConfigQueue = Promise.resolve();
    app.post('/api/markets/config', asyncRoute(async (req, res) => {
      const task = marketConfigQueue.catch(() => {}).then(() => runMarketConfig(req, res));
      marketConfigQueue = task;
      await task;
    }));
    async function runMarketConfig(req, res) {
      const { action, tile, tiles: batch, id, order } = req.body || {};
      await syncMarketsFromSheet(); // apply the edit on the newest cross-tier state, not a stale local copy
      let tiles = loadMarketTiles();
      if (action === 'add' && Array.isArray(batch)) {
        for (const t of batch) if (validNewTile(t)) tiles.push(buildNewTile(t));
      } else if (action === 'add' && validNewTile(tile)) {
        tiles.push(buildNewTile(tile));
      } else if (action === 'update' && id) {
        tiles = tiles.map(t => {
          if (t.id !== id) return t;
          const patch = ['size', 'range', 'label'].reduce((o, f) => (req.body[f] != null ? { ...o, [f]: req.body[f] } : o), {});
          if (Array.isArray(req.body.presets)) { // edit a strip's curve list
            patch.presets = req.body.presets.map(String).filter(k => STRIP_PRESETS[k]).slice(0, 4);
            if (patch.presets.length) patch.label = patch.presets.map(k => (STRIP_PRESETS[k] || {}).label || k).join(' / ');
          }
          for (const f of ['showYday', 'showMonthAgo']) if (typeof req.body[f] === 'boolean') patch[f] = req.body[f];
          if (req.body.shares != null) { const sh = +req.body.shares; if (sh > 0) patch.shares = sh; else { const { shares, ...rest } = { ...t, ...patch }; return rest; } }
          return { ...t, ...patch };
        });
      } else if (action === 'merge' && req.body.src && req.body.dst) {
        // drag a tile onto a large plot → merged multi-series plot; the dragged tile is consumed.
        // Rules: ≤4 series, ≤2 categories (oil+gas or oil+stocks, never all three).
        const src = tiles.find(t => t.id === req.body.src), dst = tiles.find(t => t.id === req.body.dst);
        if (!src || !dst || src.id === dst.id) return res.status(400).json({ error: 'bad merge' });
        const stripish = t => t.type === 'strip' || t.type === 'ustcurve'; // ustcurve joins as the virtual 'ust' preset
        if (stripish(src) && stripish(dst)) {
          const presetsOf = t => t.type === 'ustcurve' ? ['ust'] : (t.presets || [t.preset]);
          const uniq = [...new Set([...presetsOf(dst), ...presetsOf(src)].filter(k => STRIP_PRESETS[k]))];
          const cats = [...new Set(uniq.map(k => STRIP_PRESETS[k].cat))];
          if (uniq.length > 4) return res.status(400).json({ error: 'max 4 curves per plot' });
          if (cats.length > 2) return res.status(400).json({ error: 'max 2 categories per plot (' + cats.join(', ') + ')' });
          const merged = { id: dst.id, type: 'strip', size: dst.size || 'large', range: dst.range || '1y',
            showYday: dst.showYday !== false, showMonthAgo: !!dst.showMonthAgo,
            presets: uniq, label: uniq.map(k => STRIP_PRESETS[k].label).join(' / ') };
          tiles = tiles.filter(t => t.id !== src.id).map(t => t.id !== dst.id ? t : merged);
        } else if (['quote', 'cds', 'group'].includes(src.type) && ['quote', 'cds', 'group'].includes(dst.type)) {
          const itemsOf = t => t.type === 'group' ? (t.items || []) : [t.type === 'cds'
            ? { kind: 'cds', country: t.country, label: t.label || `${t.country} CDS` }
            : { kind: 'quote', sym: t.sym, label: t.label || t.sym, fmt: t.fmt, ...(t.shares > 0 ? { shares: t.shares } : {}) }];
          const items = [...itemsOf(dst), ...itemsOf(src)];
          const cats = [...new Set(items.map(i => i.kind === 'cds' ? 'cds' : symCat(i.sym)))];
          if (items.length > 4) return res.status(400).json({ error: 'max 4 series per plot' });
          if (cats.length > 2) return res.status(400).json({ error: 'max 2 categories per plot (' + cats.join(', ') + ')' });
          const g = { id: dst.type === 'group' ? dst.id : crypto.randomUUID().slice(0, 8), type: 'group', size: 'large',
            range: dst.range || '1y', items, label: items.map(i => i.label).join(' / ') };
          tiles = tiles.filter(t => t.id !== src.id).map(t => t.id === dst.id ? g : t);
        } else return res.status(400).json({ error: `can't group ${src.type} with ${dst.type}` });
      } else if (action === 'remove' && id) {
        tiles = tiles.filter(t => t.id !== id);
      } else if (action === 'reorder' && Array.isArray(order)) {
        const byId = new Map(tiles.map(t => [t.id, t]));
        const reordered = order.map(x => byId.get(x)).filter(Boolean);
        for (const t of tiles) if (!order.includes(t.id)) reordered.push(t); // never silently drop
        tiles = reordered;
      } else return res.status(400).json({ error: 'bad action' });
      saveMarketTiles(tiles);
      res.json({ ok: true, tiles });
    }
    // Free-text tile resolution ("oil future strip", "10y bund", …) → agent maps to a tile config.
    // Mac/VM inline; cloud queues via the RPC bridge like reparse/media-find.
    async function doMarketResolve({ text, tiles }) {
      const current = (Array.isArray(tiles) ? tiles : loadMarketTiles()).map(t =>
        ({ id: t.id, label: t.label, type: t.type, sym: t.sym, presets: t.presets, country: t.country, size: t.size, range: t.range }));
      const raw = await runClaude(
        `You manage a market-dashboard tile grid. Request: "${String(text).slice(0, 200)}"\n` +
        `Current tiles: ${JSON.stringify(current).slice(0, 3000)}\n` +
        `If the request MODIFIES an existing tile (change its date range, size, curves, label, share count — e.g. "gold plot 5 years", "make VIX large", "I hold 140 TTE shares"), return {"update":{"id":"<tile id>", <changed fields only: "range":"max|5y|1y|1mo|1wk", "size":"ticker|small|large", "label":"...", "shares":<number, 0 clears>, "presets":[...strip curve keys]}}.\n` +
        `Otherwise ADD one tile: (a) futures term-structure strip — {"tile":{"type":"strip","preset":<one of ${Object.keys(STRIP_PRESETS).join('|')}>}}; ` +
        `(b) US Treasury yield curve — {"tile":{"type":"ustcurve"}}; ` +
        `(c) sovereign CDS — {"tile":{"type":"cds","country":"<English country name>"}}; ` +
        `(d) anything with a real Yahoo Finance symbol — {"tile":{"type":"quote","sym":"<YAHOO SYMBOL>","label":"<short label>","fmt":"stock|int|num|fx","range":"max|5y|1y|1mo|1wk"}}.\n` +
        `Use REAL Yahoo symbols (indices ^GSPC/^IXIC/^DJI/^VIX, futures like BZ=F, fx like EURUSD=X). If genuinely unresolvable return {"error":"why"}.\n` +
        `Return STRICT JSON only.`,
        { timeoutMs: 60000, module: 'market-resolve', model: 'claude-haiku-4-5-20251001' });
      const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || ['{}'])[0];
      let r = null; try { r = JSON.parse(block); } catch (e) {}
      if (r && r.update && r.update.id) return { update: r.update };
      const tile = r && r.tile ? r.tile : r; // tolerate a bare tile object from the model
      if (!tile || tile.error || !(tile.sym || tile.preset || tile.presets || tile.type === 'ustcurve' || (tile.type === 'cds' && tile.country)))
        throw new Error((r && r.error) || (tile && tile.error) || 'could not resolve that to a tile');
      return { tile };
    }
    app.post('/api/markets/resolve', asyncRoute(async (req, res) => {
      const text = String((req.body || {}).text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      if (ctx.hasLlm()) { try { return res.json(await doMarketResolve({ text })); } catch (e) { return res.status(502).json({ error: e.message }); } }
      if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'No LLM configured — set ANTHROPIC_API_KEY (or install the claude CLI)' });
      const id = await enqueueRpc('market_resolve', { text });
      res.json({ queued: true, id });
    }));
    
    
    // ---------- US Treasury yield curve ----------
    
    let yieldsCache = { at: 0, data: null };
    // callable (not just an endpoint) so market tiles of type 'ustcurve' reuse the same cache
    async function getYieldCurve() {
      if (yieldsCache.data && !yieldsCache.data.error && Date.now() - yieldsCache.at < 6 * 3600 * 1000) return yieldsCache.data;
      const months = [0, 1].map(back => {
        const d = new Date(); d.setMonth(d.getMonth() - back);
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      });
      let entries = [];
      for (const ym of months) {
        const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
        const r = await fetch(url).catch(() => null);
        if (!r || !r.ok) continue;
        const xml = await r.text();
        const es = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
        entries = es.concat(entries); // accumulate oldest-first across months
        if (entries.length >= 2) break;
      }
      if (!entries.length) return { error: 'treasury data unavailable' };
      const TENORS = [
        ['1M', 'BC_1MONTH'], ['3M', 'BC_3MONTH'], ['6M', 'BC_6MONTH'], ['1Y', 'BC_1YEAR'],
        ['2Y', 'BC_2YEAR'], ['3Y', 'BC_3YEAR'], ['5Y', 'BC_5YEAR'], ['7Y', 'BC_7YEAR'],
        ['10Y', 'BC_10YEAR'], ['20Y', 'BC_20YEAR'], ['30Y', 'BC_30YEAR'],
      ];
      const parseCurve = entry => {
        const pick = tag => { const m = entry.match(new RegExp(`<d:${tag}[^>]*>([^<]*)<`)); return m ? parseFloat(m[1]) : null; };
        return { date: ((entry.match(/<d:NEW_DATE[^>]*>([^<]*)</) || [])[1] || '').slice(0, 10),
          curve: TENORS.map(([label, tag]) => ({ tenor: label, yield: pick(tag) })).filter(p => p.yield != null) };
      };
      const today = parseCurve(entries[entries.length - 1]);
      const yesterday = entries.length > 1 ? parseCurve(entries[entries.length - 2]) : null;
      const curve = today.curve;
      const y2 = curve.find(p => p.tenor === '2Y')?.yield, y10 = curve.find(p => p.tenor === '10Y')?.yield;
      const data = { at: nowIso(), date: today.date, curve, prevCurve: yesterday?.curve || null, prevDate: yesterday?.date || null, spread2s10s: y2 != null && y10 != null ? Math.round((y10 - y2) * 100) : null };
      track('yields', true, `curve ${data.date}`);
      yieldsCache = { at: Date.now(), data };
      return data;
    }
    app.get('/api/yields', asyncRoute(async (req, res) => res.json(await getYieldCurve())));
    
    // ---------- oil & gas futures strip (term structure, today + yesterday) ----------
    // Yahoo monthly contract symbols: <ROOT><MONTHCODE><YY>.NYM. Oil=Brent (BZ),
    // gas=Henry Hub (NG). Front continuous (BZ=F/NG=F) anchors the near end.
    const MCODE = 'FGHJKMNQUVXZ';
    // Generate forward contract-month symbols. `months` = how far out to look; quarterly roots
    // (ES/NQ/YM/SR3/BTC trade Mar/Jun/Sep/Dec only) skip non-HMUZ months instead of 404ing on them.
    function fwdContracts(root, months = 7, suffix = '.NYM', quarterly = false) {
      const out = []; const d = new Date(); let y = d.getUTCFullYear(), m = d.getUTCMonth();
      for (let i = 0; i < months; i++) {
        m++; if (m > 11) { m = 0; y++; }
        if (quarterly && ![2, 5, 8, 11].includes(m)) continue;
        out.push({ label: `${MCODE[m]}${String(y).slice(2)}`, sym: `${root}${MCODE[m]}${String(y).slice(2)}${suffix}` });
      }
      return out;
    }
    let stripCache = { at: 0, data: null };
    app.get('/api/futures-strip', asyncRoute(async (req, res) => {
      if (stripCache.data && Date.now() - stripCache.at < 30 * 60 * 1000) return res.json(stripCache.data);
      async function strip(root, frontSym) {
        const front = await fetchLast2(frontSym);
        const months = fwdContracts(root, 7);
        const pts = await pmap(months, async (c) => { const v = await fetchLast2(c.sym); return v ? { label: c.label, today: v.today, yday: v.yday } : null; }, 4);
        const arr = [front ? { label: 'front', today: front.today, yday: front.yday } : null, ...pts].filter(Boolean);
        return arr;
      }
      const [oil, gas] = await Promise.all([strip('BZ', 'BZ=F'), strip('NG', 'NG=F')]);
      const data = { at: nowIso(), oil, gas, oilLabel: 'Brent ($/bbl)', gasLabel: 'Henry Hub ($/MMBtu)' };
      track('futures', oil.length > 0 || gas.length > 0, `oil ${oil.length}, gas ${gas.length}`);
      stripCache = { at: Date.now(), data };
      res.json(data);
    }));
    
    // ---------- sovereign CDS (worldgovernmentbonds.com) ----------
    // Countries of interest come from CONFIG (cdsCountries base list + cdsLocationMap
    // [{match, country}] regexes applied to the Preferences LOCATIONS tab) — nothing
    // owner-specific in code. The free source doesn't cover every country; uncovered ones
    // render as "not covered". True trailing-year series isn't freely available, so the
    // server snapshots each fetch into data/cds-history.json and sparklines accumulate.
    
    const CDS_HISTORY = path.join(DATA, 'cds-history.json');
    const COUNTRY_MAP = (Array.isArray(cfg.cdsLocationMap) ? cfg.cdsLocationMap : [])
      .filter(x => x && x.match && x.country)
      .map(x => { try { return [new RegExp(x.match, 'i'), String(x.country)]; } catch (e) { return null; } })
      .filter(Boolean);
    
    async function cdsCountries() {
      const base = (Array.isArray(cfg.cdsCountries) ? cfg.cdsCountries : []).map(String).slice(0, 12);
      try {
        const r = await store.values.get({ spreadsheetId: cfg.prefsSheetId, range: "'LOCATIONS'!A1:B" });
        for (const row of prefRows(r.data.values || [])) {
          for (const [re, country] of COUNTRY_MAP) if (re.test(String(row[0] || '')) && !base.includes(country)) base.push(country);
        }
      } catch (e) { /* fall back to the configured base */ }
      return base;
    }
    
    // Fetch+cache the RAW table once (6h), parse whichever countries are asked for on demand —
    // shared by the legacy /api/cds batch endpoint AND per-country 'cds' market tiles, so CDS
    // tiles can now live in the SAME grid/drag/reorder system as everything else (2026-07-02:
    // "why can't I drag the CDS box in line with the stocks" — because they weren't real tiles).
    let cdsTextCache = { at: 0, text: null };
    async function getCdsTableText() {
      if (cdsTextCache.text && Date.now() - cdsTextCache.at < 6 * 3600 * 1000) return cdsTextCache.text;
      const r = await fetch('https://www.worldgovernmentbonds.com/wp-json/cds/v1/main', {
        method: 'POST',
        headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.worldgovernmentbonds.com', Referer: 'https://www.worldgovernmentbonds.com/sovereign-cds/' },
      }).catch(() => null);
      if (!r || !r.ok) throw new Error('CDS source unavailable');
      const j = await r.json();
      // normalize the table HTML to |Country|RATING|cds|±x.xx %|±x.xx %|pd %|dd Mon| rows
      // (decode entities first — &nbsp; between cells otherwise breaks pipe collapsing)
      const text = decodeEntities(String(j.table || '').replace(/&nbsp;/gi, ' '))
        .replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/( ?\| ?)+/g, '|');
      cdsTextCache = { at: Date.now(), text };
      return text;
    }
    function cdsHistory(country, cds5y) {
      let hist = {};
      try { hist = JSON.parse(fs.readFileSync(CDS_HISTORY, 'utf8')); } catch (e) {}
      if (cds5y != null) {
        hist[country] = hist[country] || {};
        hist[country][today()] = cds5y;
        try { fs.mkdirSync(path.dirname(CDS_HISTORY), { recursive: true }); fs.writeFileSync(CDS_HISTORY, JSON.stringify(hist, null, 1)); } catch (e) {}
      }
      const yearAgo = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
      const h = hist[country] || {};
      return Object.keys(h).sort().filter(d => d >= yearAgo).map(d => h[d]);
    }
    function cdsHistoryDated(country) { // [{t, v}] — for grouped plots that need a real time axis
      let hist = {};
      try { hist = JSON.parse(fs.readFileSync(CDS_HISTORY, 'utf8')); } catch (e) {}
      const h = hist[country] || {};
      return Object.keys(h).sort().map(d => ({ t: Date.parse(d), v: h[d] })).filter(p => Number.isFinite(p.t));
    }
    async function getCdsRow(country) {
      const text = await getCdsTableText();
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc(country) + '\\|([A-Zu+\\- ]{1,10})\\|([\\d.,]+)\\|([+-]?[\\d.,]+) %\\|([+-]?[\\d.,]+) %\\|([\\d.,]+) %\\|(\\d+ \\w+)');
      const m = text.match(re);
      if (!m) { cdsHistory(country); return { country, error: 'not covered by free source' }; }
      const cds5y = parseFloat(m[2]), var1m = parseFloat(m[3]), var6m = parseFloat(m[4]);
      let spark = cdsHistory(country, cds5y);
      // Accumulated daily history lives in a per-tier local file — a fresh tier (Cloud Run/VM)
      // has none, so the plot showed nothing there. Until ≥3 real days exist, synthesize the
      // 6-months-ago and 1-month-ago anchor points from the source's own variation columns.
      let sparkSpan = '1y';
      if (spark.length < 3) { spark = [cds5y / (1 + var6m / 100), cds5y / (1 + var1m / 100), cds5y].map(v => Math.round(v * 100) / 100); sparkSpan = '6m'; }
      return { country, rating: m[1].trim(), cds5y, var1m, var6m, pd: parseFloat(m[5]), asOf: m[6], spark, sparkSpan };
    }
    app.get('/api/cds', asyncRoute(async (req, res) => {
      const wanted = await cdsCountries();
      let out;
      try { out = await pmap(wanted, getCdsRow, 4); }
      catch (e) { return res.json({ error: 'CDS source unavailable', countries: wanted.map(c => ({ country: c, error: 'source unavailable' })) }); }
      const covered = out.filter(c => !c.error).length;
      track('cds', covered > 0, `${covered}/${out.length} countries covered`);
      res.json({ at: nowIso(), countries: out, source: 'worldgovernmentbonds.com (5Y CDS)' });
    }));
    
    
    if (typeof doMarketResolve === 'function') ctx.registerRpc('market_resolve', (p) => doMarketResolve(p));
  },
  client: fs.readFileSync(path.join(__dirname, 'markets.client.js'), 'utf8'),
};
