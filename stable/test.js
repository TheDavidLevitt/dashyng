// agent-stable tests — plain-Node asserts, no framework, no network.  node test.js
const assert = require('assert');
const { createMeter, createAdapters, createApa, createBoard, createTiers, pricing, sinks } = require('./index');

(async () => {
  // pricing
  assert(pricing.priceOf('claude-sonnet-5').out === 15, 'priceOf');
  assert(pricing.costClass('grok-4', 'x') === 'real', 'grok is out-of-pocket');
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

  // board: prompt build, parse, threshold precedence, fuzzy bench names
  const bd = createBoard({ roles: { roles: { steeldust: { primary: 'AA Intelligence', min: 40 } }, all_benchmarks: ['AA Intelligence'], track_non_us_os: 2 }, prices: {}, labs: { us_labs: ['L'], hosting: ['H'] } });
  const parsed = bd.parseCompile('{"models":[{"model":"m","lab":"L","role":"steeldust","benchmarks":{}}],"cutoffs":{"steeldust":{"min":33}}}');
  assert(parsed.models.length === 1 && bd.thresholdFor('steeldust', parsed.cutoffs) === 40, 'user threshold wins');
  assert(bd.sameBench('AA Intelligence (Artificial Analysis)', 'AA Intelligence'), 'fuzzy bench');

  // tiers: resolve/escalate with price, funding class, and time-sensitive advisories
  const tiers = createTiers({
    incumbent: t => ({ workhorse: 'claude-haiku-4-5', steeldust: 'claude-sonnet-5', thoroughbred: 'claude-opus-4-8' })[t],
    priceOf: pricing.priceOf, costClass: m => pricing.costClass(m),
    advisories: (m, t) => t === 'workhorse' ? ['gcp credit pool expires 2026-07-16'] : [],
  });
  const wh = tiers.resolve('workhorse');
  assert(wh.model === 'claude-haiku-4-5' && wh.price.out === 5 && wh.advisories[0].includes('credit pool'), 'tier resolve');
  const esc = tiers.escalate('workhorse');
  assert(esc.tier === 'steeldust' && esc.model === 'claude-sonnet-5' && esc.advisories.some(a => a.includes('intro pricing')), 'escalation returns model + real cost + advisories');
  assert(tiers.escalate('thoroughbred').advisories.some(a => a.includes('top tier')), 'top-tier escalation capped');
  assert(tiers.resolve('pony').error, 'unknown tier rejected');

  console.log('all agent-stable tests passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
