// agent-stable · meter — normalize usage/decision events, enrich with cost + funding class,
// dispatch to pluggable sinks. Pure logic: auth, clocks, and transports are injected.
//
//   const meter = createMeter({ sink, pricing, host });
//   await meter.usage({ module, model, input, output, costUsd?, latencyMs?, note? });
//   await meter.decision({ module, actor, decision, why?, parent?, taskRef?, costUsd? });
//
// Sink interface: { record(event) → Promise }. Events:
//   { type:'usage',    at, host, module, model, input, output, costUsd, fundingClass, latencyMs, note }
//   { type:'decision', at, host, module, actor, decision, why, parent, taskRef, costUsd }
// `pricing` = { priceOf(model) → {in,out}|null, costClass(model, module, atIso) → 'real'|'credit'|'included' }.
// If costUsd is absent on usage events it is computed from the price table; fundingClass is always stamped.

function createMeter({ sink, pricing, host = '', now = () => new Date() } = {}) {
  if (!sink || typeof sink.record !== 'function') throw new Error('meter needs a sink with record(event)');
  const p = pricing || {};
  const stamp = () => now().toISOString();

  async function usage(e = {}) {
    const at = e.at || stamp();
    let costUsd = e.costUsd;
    if ((costUsd === undefined || costUsd === '' || costUsd === null) && p.priceOf) {
      const pr = p.priceOf(e.model);
      if (pr) costUsd = Math.round(((+e.input || 0) * pr.in + (+e.output || 0) * pr.out) / 1e6 * 1e6) / 1e6;
    }
    return sink.record({
      type: 'usage', at, host: e.host || host,
      module: e.module || '', model: e.model || '',
      input: e.input ?? '', output: e.output ?? '',
      costUsd: costUsd ?? '', note: e.note || '',
      latencyMs: e.latencyMs ?? null,
      fundingClass: p.costClass ? p.costClass(e.model, e.module, at) : 'included',
    });
  }

  async function decision(e = {}) {
    return sink.record({
      type: 'decision', at: e.at || stamp(), host: e.host || host,
      module: e.module || '', actor: e.actor || '',
      decision: e.decision || '', why: e.why || '',
      parent: e.parent || '', taskRef: e.taskRef || '', costUsd: e.costUsd ?? '',
    });
  }

  // wrap an async provider call: meters tokens/latency around it via a caller-supplied extractor
  //   const out = await meter.wrap(() => callModel(...), { module, model, extract: r => ({input, output}) })
  async function wrap(fn, meta = {}) {
    const t0 = Date.now();
    const result = await fn();
    const ex = meta.extract ? (meta.extract(result) || {}) : {};
    usage({ ...meta, ...ex, latencyMs: Date.now() - t0 }).catch(() => {});
    return result;
  }

  return { usage, decision, wrap, record: (e) => sink.record(e) };
}

module.exports = { createMeter };
