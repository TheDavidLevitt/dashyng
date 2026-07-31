// Escalation-machinery tests. No network, no model spend: the model call is injected.
// Run: node bio-pipeline.test.js
const assert = require('assert');
const { run, fdaWithin30d, parseVerdict } = require('./bio-pipeline');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + e.message); }
};

// A tracked programme with nothing that would trip a hard rule: no ticker to price, no FDA
// wording, and a registry that reports no change.
const trial = i => ({
  ID: 'id' + i, Company: 'Co' + i, Drug: 'drug' + i, Ticker: '', Indication: 'ind',
  Phase: 'Phase 2', TrialStatus: 'RECRUITING', NCTId: '', Enrollment: '100',
  NextMilestone: 'readout later', Status: 'tracked', Provenance: '',
});

function deps(n, verdicts, opts = {}) {
  const rows = Array.from({ length: n }, (_, i) => trial(i));
  const logged = [];
  return {
    rows, logged,
    d: {
      confidenceThreshold: 0.8, breakerRatio: 0.5,
      now: new Date('2026-07-30T00:00:00Z'),
      nowIso: () => '2026-07-30T00:00:00.000Z',
      readTrials: async () => rows,
      updateTrial: async (id, ch) => Object.assign(rows.find(r => r.ID === id) || {}, ch),
      appendLog: async r => logged.push(...r),
      ctgFetch: async () => (opts.ctg ? opts.ctg() : []),
      callModel: async tier => ({
        text: JSON.stringify(verdicts(tier)), model: 'test-' + tier, cost: 0.001,
      }),
    },
  };
}

(async () => {
  console.log('escalation:');

  await test('high confidence never escalates and never trips the breaker', async () => {
    const { d } = deps(6, () => ({ analysis: {}, confidence: 0.95, escalate: false }));
    const s = await run({ tier: 'daily', runId: 'r1', deps: d });
    assert.strictEqual(s.circuitBreaker, false, 'breaker should stay closed');
    assert.strictEqual(s.escalations.confidence, 0, 'no confidence escalations');
    assert.strictEqual(s.byTier.haiku, 6, 'all six handled by haiku');
    assert.ok(!s.byTier.sonnet, 'nothing reached sonnet');
  });

  await test('low confidence escalates, then the breaker halts further confidence escalation', async () => {
    const { d } = deps(10, () => ({ analysis: {}, confidence: 0.3, escalate: false }));
    const s = await run({ tier: 'daily', runId: 'r2', deps: d });
    assert.strictEqual(s.circuitBreaker, true, 'breaker should trip');
    assert.ok(/calibration needed/.test(s.calibrationNote || ''), 'calibration note explains why');
    // The first few tasks escalate the whole chain; once tripped, later tasks stop at haiku.
    assert.ok(s.escalations.confidence > 0, 'some confidence escalations happened before the trip');
    assert.ok(s.byTier.haiku === 10, 'every trial still got a haiku pass');
    assert.ok(s.byTier.opus < 10, 'the breaker stopped opus running on all ten');
  });

  await test('breaker needs a minimum sample — 3 uncertain trials do not trip it', async () => {
    const { d } = deps(3, () => ({ analysis: {}, confidence: 0.1, escalate: false }));
    const s = await run({ tier: 'daily', runId: 'r3', deps: d });
    assert.strictEqual(s.circuitBreaker, false, 'too few tasks to judge calibration');
  });

  await test('a hard rule escalates even after the breaker has tripped', async () => {
    // every trial carries a dated PDUFA inside 30 days → the rule fires on all of them
    const { d, rows } = deps(10, () => ({ analysis: {}, confidence: 0.3, escalate: false }));
    rows.forEach(r => { r.NextMilestone = 'PDUFA date 2026-08-10'; });
    const s = await run({ tier: 'daily', runId: 'r4', deps: d });
    assert.strictEqual(s.circuitBreaker, true, 'breaker still trips on the confidence signal');
    assert.strictEqual(s.escalations.rule, 20, 'rule escalations continue for all 10 (haiku→sonnet→opus)');
    assert.strictEqual(s.byTier.opus, 10, 'every trial reached opus via the rule path');
  });

  await test('analysis writes through with per-field tier provenance', async () => {
    const { d, rows } = deps(2, tier => ({
      analysis: { outcomes: 'updated by ' + tier }, confidence: 0.95, escalate: false,
    }));
    await run({ tier: 'daily', runId: 'r5', deps: d });
    assert.strictEqual(rows[0].Outcomes, 'updated by haiku');
    const prov = JSON.parse(rows[0].Provenance);
    assert.strictEqual(prov.Outcomes.tier, 'haiku');
    assert.strictEqual(prov.Outcomes.confidence, 0.95);
    assert.ok(!prov.Competition, 'fields the model omitted get no provenance');
  });

  await test('every task lands in the analysis log with its confidence', async () => {
    const { d, logged } = deps(4, () => ({ analysis: {}, confidence: 0.9, escalate: false }));
    await run({ tier: 'daily', runId: 'r6', deps: d });
    assert.strictEqual(logged.length, 4);
    assert.strictEqual(logged[0][1], 'r6', 'run id recorded');
    assert.strictEqual(logged[0][2], 'haiku', 'tier recorded');
    assert.strictEqual(logged[0][8], 0.9, 'confidence recorded');
    assert.strictEqual(logged[0][9], '0', 'escalation flag recorded');
  });

  await test('a phase transition from the registry poll is a hard trigger', async () => {
    const { d, rows } = deps(1, () => ({ analysis: {}, confidence: 0.99, escalate: false }),
      { ctg: () => [{ nctId: 'NCT00000001', trialStatus: 'RECRUITING', phase: 'Phase 3', enrollment: 100 }] });
    rows[0].NCTId = 'NCT00000001';
    const s = await run({ tier: 'daily', runId: 'r7', deps: d });
    assert.strictEqual(s.registryChanges, 1, 'poll detected the phase move');
    assert.strictEqual(rows[0].Phase, 'Phase 3', 'row updated to the registry phase');
    assert.strictEqual(s.escalations.rule, 2, 'escalated on the rule despite 0.99 confidence');
  });

  await test('weekly enters at sonnet, monthly is a single opus portfolio pass', async () => {
    const w = deps(3, () => ({ analysis: {}, confidence: 0.95, escalate: false }));
    const sw = await run({ tier: 'weekly', runId: 'r8', deps: w.d });
    assert.ok(!sw.byTier.haiku, 'weekly skips haiku');
    assert.strictEqual(sw.byTier.sonnet, 3);

    const m = deps(5, () => ({ analysis: {}, summary: 'portfolio text', confidence: 0.9, escalate: false }));
    const sm = await run({ tier: 'monthly', runId: 'r9', deps: m.d });
    assert.strictEqual(sm.byTier.opus, 1, 'one call for the whole portfolio, not one per trial');
    assert.strictEqual(sm.portfolioReview, 'portfolio text');
  });

  await test('a bad first response is retried once, not lost', async () => {
    let calls = 0;
    const { d } = deps(2, () => ({ analysis: {}, confidence: 0.95, escalate: false }));
    d.callModel = async () => {
      calls++;
      // first call of each trial returns prose, the retry returns valid JSON
      return calls % 2 === 1
        ? { text: 'Sorry, here are my thoughts in prose.', model: 'm', cost: 0 }
        : { text: '{"analysis":{},"confidence":0.9,"escalate":false}', model: 'm', cost: 0 };
    };
    const s = await run({ tier: 'daily', runId: 'r10', deps: d });
    assert.strictEqual(s.retries, 2, 'both trials recovered on retry');
    assert.strictEqual(s.errors.length, 0, 'nothing lost');
    assert.strictEqual(s.byTier.haiku, 2);
  });

  await test('a task that fails twice is reported, not silently dropped', async () => {
    const { d } = deps(1, () => ({}));
    d.callModel = async () => ({ text: 'still prose', model: 'm', cost: 0 });
    const s = await run({ tier: 'daily', runId: 'r11', deps: d });
    assert.strictEqual(s.errors.length, 1);
    assert.ok(/after retry/.test(s.errors[0]), 'error says the retry was used up');
  });

  await test('no free transport aborts the run once and notifies, instead of billing', async () => {
    const { d } = deps(9, () => ({ analysis: {}, confidence: 0.9, escalate: false }));
    let calls = 0;
    d.callModel = async () => { calls++; throw new (require('./bio-pipeline').NoFreeTransport)('claude CLI failed and paid fallback is off'); };
    const s2 = await run({ tier: 'daily', runId: 'r12', deps: d });
    assert.strictEqual(calls, 1, 'stops after the first failure, not once per trial');
    assert.ok(/could not run/.test(s2.notify || ''), 'sets a notification');
    assert.strictEqual(s2.cost, 0, 'spends nothing');
  });

  await test('an unstarred row tops out at sonnet however uncertain it is', async () => {
    const { d, rows } = deps(3, () => ({ analysis: {}, confidence: 0.1, escalate: true }));
    rows.forEach(r => { r.Status = 'screened'; });
    const s2 = await run({ tier: 'daily', runId: 'r13', deps: d });
    assert.strictEqual(s2.byTier.haiku, 3);
    assert.strictEqual(s2.byTier.sonnet, 3, 'climbs to sonnet');
    assert.ok(!s2.byTier.opus, 'never reaches opus');
  });

  await test('a starred row still climbs to opus', async () => {
    const { d, rows } = deps(1, () => ({ analysis: {}, confidence: 0.1, escalate: true }));
    rows[0].Status = 'tracked';
    const s2 = await run({ tier: 'daily', runId: 'r14', deps: d });
    assert.strictEqual(s2.byTier.opus, 1, 'starred rows may use the expensive tier');
  });

  await test('a hard rule cannot punch through the ceiling either', async () => {
    const { d, rows } = deps(2, () => ({ analysis: {}, confidence: 0.99, escalate: false }));
    rows.forEach(r => { r.Status = 'screened'; r.NextMilestone = 'PDUFA date 2026-08-10'; });
    const s2 = await run({ tier: 'daily', runId: 'r15', deps: d });
    assert.ok(!s2.byTier.opus, 'rules escalate, but not past the ceiling');
    assert.strictEqual(s2.byTier.sonnet, 2);
  });

  console.log('\nrules:');
  await test('only dated FDA events inside 30 days fire', () => {
    const now = new Date('2026-07-30T00:00:00Z');
    assert.ok(fdaWithin30d({ NextMilestone: 'PDUFA 2026-08-09' }, now));
    assert.strictEqual(fdaWithin30d({ NextMilestone: 'PDUFA 2026-12-09' }, now), null);
    assert.strictEqual(fdaWithin30d({ NextMilestone: 'readout 2026-08-09' }, now), null, 'non-FDA event');
    assert.strictEqual(fdaWithin30d({ NextMilestone: 'FDA decision 2H 2026' }, now), null, 'undated');
    assert.strictEqual(fdaWithin30d({ NextMilestone: 'PDUFA 2026-07-01' }, now), null, 'already passed');
  });

  await test('malformed model output is rejected, not silently treated as empty', () => {
    assert.throws(() => parseVerdict('I think the drug looks good!'));
    assert.strictEqual(parseVerdict('{"confidence":"nonsense"}').confidence, 0);
    assert.strictEqual(parseVerdict('{"confidence":5}').confidence, 1, 'clamped to [0,1]');
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
