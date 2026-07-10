// agent-stable demo — no network, no keys: a mock provider + the memory sink walk the full
// loop: meter calls → funding-classified spend → head-to-head eval → adopt gate.
//   node demo.js
const { createMeter, createAdapters, createApa, pricing, sinks } = require('./index');

// a fake provider: "newmodel" answers well and cheap, "oldmodel" answers adequately
const mock = {
  fn: async (model, prompt) => ({
    text: model === 'newmodel'
      ? 'Thesis first: the decision matters because X. Key figures: 4.75% held, two cuts signaled, core 3.1% (was 3.8%).'
      : 'Rates were held at 4.75%. Inflation is 3.1%. Cuts may come.',
    usage: { input: 40, output: model === 'newmodel' ? 35 : 20 },
  }),
};

(async () => {
  const sink = sinks.memorySink();
  // a demo price table: the challenger is 5× cheaper than the incumbent
  const priceOf = m => m === 'newmodel' ? { in: 0.5, out: 2 } : m === 'oldmodel' ? { in: 3, out: 15 } : pricing.priceOf(m);
  const meter = createMeter({ sink, pricing: { priceOf, costClass: () => 'real' }, host: 'demo' });
  const adapters = createAdapters({ demo: mock });

  console.log('1) meter a few calls…');
  for (let i = 0; i < 3; i++) {
    await meter.wrap(() => adapters.call({ provider: 'demo', model: 'oldmodel', prompt: 'summarize the rate decision' }),
      { module: 'summary', model: 'oldmodel', extract: r => r.usage });
  }
  const spent = sink.query({ type: 'usage' }).reduce((n, e) => n + (e.costUsd || 0), 0);
  console.log(`   ${sink.events.length} events metered — $${spent.toFixed(6)} (funding class: ${sink.events[0].fundingClass})`);

  console.log('2) a challenger appears — head-to-head eval, judged…');
  const apa = createApa({
    adapters, priceOf,
    judge: async () => '{"a_better_or_equal": true, "note": "A leads with the thesis and contextualizes every figure"}',
    usageHistory: async () => sink.query({ type: 'usage' }),
  });
  const verdict = await apa.evaluate({ id: 'newmodel', provider: 'demo' }, { id: 'oldmodel', provider: 'demo' });
  console.log('   verdict:', JSON.stringify(verdict));

  console.log('3) the adopt gate…');
  console.log('   autoAdopt on :', JSON.stringify(apa.adoptGate(verdict, { autoAdopt: true })));
  console.log('   autoAdopt off:', JSON.stringify(apa.adoptGate(verdict, { autoAdopt: false })));
  // pretend a month of production volume so the projection is visible
  await meter.usage({ module: 'summary', model: 'oldmodel', input: 40e6, output: 8e6 });
  const savings = await apa.projectSavings('summary', 'oldmodel', 'newmodel');
  console.log(`4) projected saving at ~40M in / 8M out per month: $${savings}/mo`);
  console.log('\nThat is the loop: meter → evaluate → gate → (host commits, reversibly). See README.md.');
})().catch(e => { console.error(e); process.exit(1); });
