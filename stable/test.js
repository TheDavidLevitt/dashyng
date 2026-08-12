// agent-stable tests — plain-Node asserts, no framework, no network.  node test.js
const assert = require('assert');
const { createMeter, createAdapters, createApa, createBoard, createTiers, pricing, sinks } = require('./index');

(async () => {
  // pricing
  assert(pricing.priceOf('claude-sonnet-5').out === 15, 'priceOf');
  assert(pricing.costClass('grok-4', 'x') === 'real', 'grok is out-of-pocket');
  assert(pricing.costClass('anthropic/claude-sonnet-5') === 'real', 'marketplace-routed claude is out-of-pocket');
  assert(pricing.costClass('openrouter:claude-opus-5') === 'real', 'openrouter-prefixed is out-of-pocket');
  assert(pricing.selfHostPerMTok({ kwhPrice: 0.15, watts: 700, tokPerSec: 40 }) === 0.73, 'self-host estimate');

  // meter + memory sink: cost fill-in + funding class + query
  const mem = sinks.memorySink();
  const meter = createMeter({ sink: mem, pricing, host: 't' });
  await meter.usage({ module: 'm', model: 'claude-sonnet-5', input: 1e6, output: 1e5 });
  assert(mem.events[0].costUsd === 4.5, 'cost computed');
  assert(['credit', 'included'].includes(mem.events[0].fundingClass), 'funding class stamped');
  await meter.decision({ module: 'm', actor: 'apa', decision: 'd' });
  assert(mem.query({ type: 'decision' }).length === 1, 'query');

  // sheet sink row shapes (mock client)
  const calls = [];
  const sheet = sinks.sheetSink({ sheets: { spreadsheets: { values: { append: async o => calls.push(o) } } }, spreadsheetId: 'S' });
  const m2 = createMeter({ sink: sheet, pricing, host: 'h', now: () => new Date('2026-01-01T00:00:00Z') });
  await m2.usage({ module: 'mod', model: 'claude-haiku-4-5', input: 5, output: 6, note: 'n' });
  assert.deepStrictEqual(calls[0].requestBody.values[0], ['2026-01-01T00:00:00.000Z', 'h', 'mod', 'claude-haiku-4-5', 5, 6, 0.000035, 'n'], 'usage row shape');

  // adapters: openai-compat protocol via mock fetch; keyless local; unconfigured throws
  const seen = [];
  const mockFetch = async (url, opts) => { seen.push({ url, auth: opts.headers.Authorization }); return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 2 }, model: 'x' }) }; };
  const ad = createAdapters({ openrouter: { apiKey: 'k' }, ollama: {} }, { fetchImpl: mockFetch });
  const r1 = await ad.call({ provider: 'openrouter', model: 'm', prompt: 'p' });
  assert(r1.text === 'hi' && r1.usage.output === 2 && seen[0].auth === 'Bearer k', 'openai-compat');
  await ad.call({ provider: 'ollama', model: 'm', prompt: 'p' });
  assert(!seen[1].auth && seen[1].url.includes('localhost:11434'), 'keyless local');
  await assert.rejects(() => ad.call({ provider: 'together', model: 'm', prompt: 'p' }), /no adapter/, 'unconfigured throws');

  // apa engine: verdict, gate on/off, savings math, probe-guard
  const apa = createApa({
    adapters: { call: async ({ model }) => ({ text: 'answer from ' + model, usage: {} }) },
    priceOf: m => m === 'cand' ? { in: 1, out: 5 } : { in: 3, out: 15 },
    judge: async () => '{"a_better_or_equal": true, "note": "ok"}',
    usageHistory: async () => [{ at: new Date().toISOString(), module: 's', input: 1e6, output: 1e5 }],
  });
  const ev = await apa.evaluate({ id: 'cand', provider: 'x' }, { id: 'inc', provider: 'x' });
  assert(ev.qualityOK && ev.cheaper, 'verdict');
  assert(apa.adoptGate(ev, { autoAdopt: true }).adopt === true, 'gate on');
  assert(apa.adoptGate(ev, { autoAdopt: false }).adopt === false, 'gate off');
  assert(apa.adoptGate(null).adopt === false, 'unrunnable never adopts');
  assert(await apa.projectSavings('s', 'inc', 'cand') === 3, 'savings math');

  // considerFinding: the Store/Notify boundary — all four outcomes via injected hooks
  const ev2 = { info: [], propose: [], adopt: [] };
  const ctx = {
    store: { recordPrice: () => {}, incumbent: () => 'inc', adopt: (m, id) => ev2.adopt.push(m + ':' + id) },
    notify: { info: l => ev2.info.push(l), propose: l => ev2.propose.push(l) },
    log: () => {}, usLabs: ['LabX'], crossProvider: true, autoAdopt: true,
    resolveId: m => m, providerFor: () => 'p', sameFamily: () => false,
  };
  const apa2 = createApa({
    adapters: { call: async ({ model }) => ({ text: 'a ' + model, usage: {} }) },
    priceOf: m => m === 'cand2' ? { in: 1, out: 5 } : { in: 3, out: 15 },
    judge: async () => '{"a_better_or_equal": true, "note": "ok"}',
    usageHistory: async () => [],
  });
  assert(await apa2.considerFinding({ kind: 'price', lab: 'Other', model: 'x', headline: 'h', url: 'u' }, ctx) === 'arbitrage', 'proposal path');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, ctx) === 'adopted', 'adopt path');
  assert(ev2.adopt[0] === 'summary:cand2', 'adopt via store hook');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, { ...ctx, autoAdopt: false }) === 'tested', 'autoAdopt off');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, { ...ctx, crossProvider: false }) === 'test-recommend', 'crossProvider off');

  // board: fromRows normalization + tier assignment, threshold precedence, fuzzy bench names
  const bd = createBoard({ roles: { roles: { steeldust: { primary: 'AA Intelligence', min: 40 } }, all_benchmarks: ['AA Intelligence'], track_non_us_os: 2 }, prices: {}, labs: { us_labs: ['L'], hosting: ['H'] } });
  const rows = bd.fromRows([
    { model: 'm-good', lab: 'L', benchmarks: { 'AA Intelligence (index)': 55 }, priceIn: 1, priceOut: 5 },
    { model: 'm-weak', lab: 'L', benchmarks: { 'AA Intelligence': 12 } },
  ]);
  assert(rows.length === 2 && rows[0].role === 'steeldust' && rows[1].role === '', 'fromRows assigns tiers by threshold');
  assert(bd.thresholdFor('steeldust', {}) === 40, 'user threshold wins');
  assert(bd.sameBench('AA Intelligence (Artificial Analysis)', 'AA Intelligence'), 'fuzzy bench');

  // delisted winners: presence detection (name-normalized) + relaxed replacement search
  const bd2 = createBoard({ roles: { roles: { t: { primary: 'AA Intelligence', min: 50, winner: 'old-star.1' } } } });
  const board2 = [
    { model: 'new-good', lab: 'L', benchmarks: { 'AA Intelligence': 60 }, priceIn: 2, priceOut: 10 },
    { model: 'new-smarter-pricier', lab: 'L', benchmarks: { 'AA Intelligence': 70 }, priceIn: 9, priceOut: 40 },
    { model: 'new-weak', lab: 'L', benchmarks: { 'AA Intelligence': 30 }, priceIn: 0.1, priceOut: 0.5 },
  ];
  assert(bd2.winnerOnBoard(board2, 't').present === false, 'winner absent detected');
  assert(bd2.winnerOnBoard([{ model: 'Old.Star-1', benchmarks: { 'AA Intelligence (index)': 55 } }], 't').score === 55, 'presence is name-normalized, scored on primary');
  const rep = bd2.bestReplacement(board2, 't', { minScore: 50, maxCost: 7.5 });
  assert(rep && rep.model === 'new-good', 'relaxed search: cheapest adequate under the cap');
  assert(bd2.bestReplacement(board2, 't', { minScore: 50 }).model === 'new-good', 'no cap → still cheapest adequate, min does the quality judging');
  assert(bd2.bestReplacement(board2, 't', { minScore: 75, maxCost: 7.5 }) === null, 'nothing above bar → null');

  // usage-weighted cost: an input-heavy mix flips verdicts a flat in+out sum gets wrong
  const mixH = pricing.usageMixOf([{ input: 97e6, output: 3e6 }]);
  assert(Math.abs(mixH.wIn - 0.97) < 1e-9, 'mix derived from usage rows');
  assert(pricing.weightedCost({ in: 2, out: 10 }) === 6, 'no mix → 0.5/0.5 blend (old sum ranking)');
  const wbd = createBoard({ roles: { roles: { w: { primary: 'AA Intelligence', min: 40, winner: 'old-haiku' } } } });
  const wboard = [
    { model: 'muse-like', lab: 'M', benchmarks: { 'AA Intelligence': 56.8 }, priceIn: 1.25, priceOut: 4.25 }, // flat sum $5.5 < $6 but input-PRICIER
    { model: 'flash-like', lab: 'G', benchmarks: { 'AA Intelligence': 52 }, priceIn: 0.3, priceOut: 2.5 },
  ];
  const capH = pricing.weightedCost({ in: 1, out: 5 }, mixH); // incumbent's last-known on the real mix ≈ $1.12
  const pick = wbd.bestReplacement(wboard, 'w', { minScore: 40, maxCost: capH, mix: mixH });
  assert(pick && pick.model === 'flash-like', 'input-heavy mix rejects the input-pricier model, picks cheapest adequate');
  const evM = { qualityOK: true, cheaper: true, cp: { in: 1.25, out: 4.25 }, ip: { in: 1, out: 5 } };
  assert(apa.adoptGate(evM).adopt === true, 'flat blend: candidate adopts');
  assert(apa.adoptGate(evM, { mix: mixH }).adopt === false, 'usage-weighted: same candidate is pricier for this workload');

  // Pareto value walk: steep cheap jumps get captured; the min bar stops deciding the outcome
  const vb = createBoard({ roles: { roles: { v: { primary: 'AA Intelligence', min: 30, winner: 'old' } } } });
  const vboard = [
    { model: 'mimo-ish', benchmarks: { 'AA Intelligence': 38 }, priceIn: 0.14, priceOut: 0.28 },   // ~0.145 blended (mixH)
    { model: 'luna-ish', benchmarks: { 'AA Intelligence': 52.3 }, priceIn: 0.2, priceOut: 1.2 },   // ~0.216 — +14.3 pts for 1.5× = ~24 pts/dbl
    { model: 'opus-ish', benchmarks: { 'AA Intelligence': 62.5 }, priceIn: 5, priceOut: 25 },      // ~5.6 — +10 pts for 26× = ~2 pts/dbl
  ];
  const fr = vb.paretoFrontier(vboard, 'v', { mix: mixH });
  assert(fr.length === 3 && fr[0].model === 'mimo-ish' && fr[2].model === 'opus-ish', 'frontier is cost- and score-ascending');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, mix: mixH }).model === 'luna-ish', 'entry below the jump: walk takes the steep upgrade');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 40, mix: mixH }).model === 'luna-ish', 'entry above the jump: same outcome — bar placement no longer decides');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, mix: mixH, valueBar: Infinity }).model === 'mimo-ish', 'valueBar Infinity ⇒ pure cheapest-adequate');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, maxCost: 0.2, mix: mixH }).model === 'mimo-ish', 'budget cap still binds the walk');

  // adoptGate delisted relaxation: comparable price passes but only ever PROPOSES
  const evD = { qualityOK: true, cheaper: false, cp: { in: 3, out: 15 }, ip: { in: 3, out: 15 } };
  assert(apa.adoptGate(evD).adopt === false, 'strict gate: equal price is not cheaper');
  const gD = apa.adoptGate(evD, { delisted: true });
  assert(gD.adopt === false && gD.propose === true, 'delisted: comparable price proposes, never adopts');
  assert(!apa.adoptGate({ ...evD, cp: { in: 9, out: 40 } }, { delisted: true }).propose, 'delisted: pricier still fails');
  assert(!apa.adoptGate({ ...evD, qualityOK: false }, { delisted: true }).propose, 'delisted: quality bar still applies');

  // considerFinding: delisted incumbent → 'proposed' outcome via the propose hook, no adopt
  const ev3 = { info: [], propose: [], adopt: [] };
  const apa3 = createApa({
    adapters: { call: async ({ model }) => ({ text: 'a ' + model, usage: {} }) },
    priceOf: () => ({ in: 3, out: 15 }), // equal prices: strict gate would freeze forever
    judge: async () => '{"a_better_or_equal": true, "note": "ok"}',
    usageHistory: async () => [],
  });
  const ctx3 = {
    store: { recordPrice: () => {}, incumbent: () => 'inc', adopt: (m, id) => ev3.adopt.push(id) },
    notify: { info: l => ev3.info.push(l), propose: l => ev3.propose.push(l) },
    log: () => {}, usLabs: ['LabX'], crossProvider: true, autoAdopt: true,
    resolveId: m => m, providerFor: () => 'p', sameFamily: () => false,
    incumbentDelisted: (module, incId) => incId === 'inc',
  };
  assert(await apa3.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand3', headline: 'h', url: 'u' }, ctx3) === 'proposed', 'delisted incumbent → proposed');
  assert(ev3.adopt.length === 0 && ev3.propose.some(l => l.includes('incumbent delisted')), 'proposal via notify.propose, no store.adopt');

  // tiers: resolve/escalate with price, funding class, and time-sensitive advisories
  const tiers = createTiers({
    incumbent: t => ({ workhorse: 'claude-haiku-4-5', steeldust: 'claude-sonnet-5', thoroughbred: 'claude-opus-4-8', secretariat: 'claude-fable-5' })[t],
    priceOf: pricing.priceOf, costClass: m => pricing.costClass(m),
    advisories: (m, t) => t === 'workhorse' ? ['gcp credit pool expires 2026-07-16'] : [],
  });
  const wh = tiers.resolve('workhorse');
  assert(wh.model === 'claude-haiku-4-5' && wh.price.out === 5 && wh.advisories[0].includes('credit pool'), 'tier resolve');
  const esc = tiers.escalate('workhorse');
  assert(esc.tier === 'steeldust' && esc.model === 'claude-sonnet-5' && esc.advisories.some(a => a.includes('intro pricing')), 'escalation returns model + real cost + advisories');
  assert(tiers.escalate('thoroughbred').tier === 'secretariat', 'thoroughbred escalates to secretariat');
  assert(tiers.escalate('secretariat').advisories.some(a => a.includes('top tier')), 'top-tier escalation capped');
  assert(tiers.resolve('pony').error, 'unknown tier rejected');

  console.log('all agent-stable tests passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
