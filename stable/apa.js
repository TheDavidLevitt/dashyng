// agent-stable · apa — the procurement decision engine, host-independent.
// Extracted per README: evaluate (cross-provider head-to-head + judge), projectSavings
// (usage-history extrapolation), and adoptGate (the equal-or-better AND cheaper rule).
// Everything I/O-ish is injected:
//   createApa({
//     adapters,                       // stable/adapters createAdapters() instance
//     priceOf(model) → {in,out}|null, // include any scraped-price overlay the host keeps
//     judge(prompt) → Promise<text>,  // an LLM call for the quality verdict (host picks model)
//     usageHistory() → Promise<[{at, module, input, output}]>,  // for savings projection
//     evalPrompts?: [string],         // fixed benchmark tasks (defaults below)
//   })
// The host keeps: scanning/scraping, storage, notifications, and the adopt WRITE — this module
// returns verdicts and recommendations; committing them is the host's (reversible, logged) act.

const DEFAULT_EVAL_PROMPTS = [
  'Summarize for a busy exec: "The central bank held rates at 4.75% but signaled two cuts in 2026, citing cooling core inflation (3.1%, down from 3.8%)." Lead with the thesis, then the key numbers in context. 3 lines.',
  'Extract the decisions and figures: "The board approved a $2.4bn buyback, raised the dividend 12% to $0.84, and added $500m to R&D." One dense line each.',
  'Give the "so what" of: "A startup open-sourced a 7B model matching GPT-4o-mini on MMLU at 1/20th the inference cost." 3 lines, lead with why it matters.',
];

function createApa({ adapters, priceOf, judge, usageHistory, evalPrompts = DEFAULT_EVAL_PROMPTS } = {}) {
  if (!adapters || !priceOf || !judge) throw new Error('createApa needs { adapters, priceOf, judge }');

  // run the fixed benchmark on one model; null = not runnable (bad id / missing provider)
  async function runSuite({ id, provider }) {
    const outs = [];
    for (const p of evalPrompts) {
      let text = '';
      try { text = (await adapters.call({ provider, model: id, prompt: p })).text; } catch (e) { return null; }
      if (!text) return null;
      outs.push(text.slice(0, 1200));
    }
    return outs;
  }

  // head-to-head: candidate vs incumbent → { qualityOK, cheaper, note, cp, ip } | null (unrunnable)
  async function evaluate(cand, inc) {
    const [candOuts, incOuts] = await Promise.all([runSuite(cand), runSuite(inc)]);
    if (!candOuts || !incOuts) return null;
    const judgePrompt = `You are grading two assistants (A and B) on the SAME ${evalPrompts.length} tasks (lead with thesis, contextualize numbers, be dense). ` +
      evalPrompts.map((p, i) => `\n--- Task ${i + 1}: ${p}\nA: ${candOuts[i]}\nB: ${incOuts[i]}`).join('') +
      `\nReturn STRICT JSON only: {"a_better_or_equal": true|false, "note": "one line"}. A must be at least as good as B on quality to be true.`;
    let verdict = { a_better_or_equal: false };
    try { verdict = JSON.parse((String(await judge(judgePrompt)).match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch (e) {}
    const cp = priceOf(cand.id), ip = priceOf(inc.id);
    const cheaper = cp && ip && (cp.in + cp.out) < (ip.in + ip.out);
    return { qualityOK: !!verdict.a_better_or_equal, cheaper, note: verdict.note || '', cp, ip };
  }

  // projected $ saved over the trailing `days` if `module` switched inc→cand (≈ $/month at 30d)
  async function projectSavings(module, incId, candId, days = 30) {
    const inc = priceOf(incId), cand = priceOf(candId);
    if (!inc || !cand || !usageHistory) return null;
    const cutoff = Date.now() - days * 86400000;
    let inTok = 0, outTok = 0;
    for (const r of await usageHistory()) {
      if (r.module === module && new Date(r.at).getTime() >= cutoff) { inTok += r.input || 0; outTok += r.output || 0; }
    }
    return Math.round(((inTok * (inc.in - cand.in) + outTok * (inc.out - cand.out)) / 1e6) * 100) / 100;
  }

  // the adopt rule in one place: adopt ⟺ runnable ∧ quality ≥ incumbent ∧ cheaper ∧ autoAdopt
  function adoptGate(ev, { autoAdopt = true } = {}) {
    if (!ev) return { adopt: false, reason: 'not runnable — recommend for review' };
    if (ev.qualityOK && ev.cheaper) return autoAdopt ? { adopt: true, reason: 'equal-or-better and cheaper' } : { adopt: false, reason: 'better+cheaper (auto-adopt off)' };
    return { adopt: false, reason: ev.cheaper ? 'cheaper but quality not clearly ≥' : 'not cheaper' };
  }

  // The full decision flow for one scraped finding, with the host's MEMORY and VOICE injected
  // (the Store/Notify boundary — see README design rule 2). The engine decides; the host's
  // implementations determine where state lives and where the human hears about it:
  //   ctx.store:  { recordPrice(model, {in,out}),   — scraped prices for cost-compares
  //                 incumbent(module) → model id,   — current selection for the use case
  //                 adopt(module, id, note) }       — commit an adoption (host makes it reversible)
  //   ctx.notify: { info(line), propose(line) }     — journal / Slack / console — host's choice
  //   ctx.log:    ({decision, why, taskRef, costUsd?}) — the decisions audit trail
  //   plus: usLabs[], crossProvider, autoAdopt, module ('summary' default),
  //         resolveId(model, lab) → runnable id|null, providerFor(id, lab) → adapter provider,
  //         sameFamily(finding) → true if candidate runs on the incumbent's own provider
  // finding: { kind, lab, model, headline, url, why, priceIn, priceOut }
  async function considerFinding(f, ctx) {
    const notify = ctx.notify, store = ctx.store;
    const log = e => Promise.resolve(ctx.log(e)).catch(() => {});
    const lab = String(f.lab || '').toLowerCase();
    const isUsRelease = f.kind === 'release' && (ctx.usLabs || []).some(l => lab.includes(String(l).toLowerCase().split('/')[0]));
    if (f.model && (f.priceIn != null || f.priceOut != null)) store.recordPrice(f.model, { in: +f.priceIn || 0, out: +f.priceOut || 0 });
    if (!isUsRelease) { // hosting / other-lab / price / benchmark → proposal for human review
      notify.propose(`- **APA proposal** (${f.kind}): ${f.headline} — ${f.why || ''} <${f.url}>`);
      await log({ decision: `arbitrage proposal: ${f.lab} ${f.model || ''}`.trim(), why: String(f.why || '').slice(0, 200), taskRef: f.url });
      return 'arbitrage';
    }
    const candId = ctx.resolveId(f.model, f.lab);
    const sameFamily = ctx.sameFamily ? ctx.sameFamily(f) : true;
    notify.info(`- **APA**: new ${f.lab} model "${f.model}" detected → testing. <${f.url}>`);
    if (!candId || (!sameFamily && !ctx.crossProvider)) {
      notify.info(`  ↳ ${!candId ? 'no runnable id' : 'cross-provider eval is off'}; queued as a recommendation for review.`);
      await log({ decision: `flag new model ${f.lab} ${f.model}`, why: !candId ? 'no runnable id' : 'crossProvider off', taskRef: f.url });
      return 'test-recommend';
    }
    const module = ctx.module || 'summary';
    const incId = store.incumbent(module);
    const ev = await evaluate({ id: candId, provider: ctx.providerFor(candId, f.lab) }, { id: incId, provider: ctx.providerFor(incId, '') }).catch(() => null);
    if (!ev) {
      notify.info(`  ↳ couldn't run ${candId} (not live, or provider/key missing) — recommending for review.`);
      await log({ decision: `defer eval ${candId}`, why: 'model/provider not runnable', taskRef: f.url });
      return 'test-deferred';
    }
    const savings = await projectSavings(module, incId, candId).catch(() => null);
    const savLine = savings != null ? ` Projected ~$${savings}/mo saved on ${module}.` : '';
    const gate = adoptGate(ev, { autoAdopt: ctx.autoAdopt });
    if (gate.adopt) {
      store.adopt(module, candId, `${gate.reason}: ${ev.note}`);
      notify.info(`  ↳ **ADOPTED** ${candId} (${f.lab}) for ${module} (${gate.reason}).${savLine} Reversible via the dashboard.`);
      await log({ decision: `auto-adopt ${candId} for ${module}`, why: `${gate.reason}. ${ev.note}`, taskRef: f.url, costUsd: savings != null ? -savings : '' });
      return 'adopted';
    }
    notify.info(`  ↳ tested ${candId}: ${gate.reason}.${savLine} Left on ${incId}.`);
    await log({ decision: `tested ${candId}: ${gate.reason}`, why: ev.note, taskRef: f.url });
    return 'tested';
  }

  return { evaluate, projectSavings, adoptGate, runSuite, considerFinding };
}

module.exports = { createApa, DEFAULT_EVAL_PROMPTS };
