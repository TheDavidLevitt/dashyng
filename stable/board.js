// agent-stable · board — benchmark-board logic over EXTERNALLY SOURCED rows.
// v0.4.0: the LLM web-search compile is gone. Benchmark data comes from a real source the
// host injects (the reference deployment uses Artificial Analysis' API) — deterministic,
// fresh, and no scraping machinery to maintain. The board keeps the judgment layers a data
// vendor can't provide: YOUR tier thresholds, role assignment, and fuzzy benchmark matching.
//
//   const board = createBoard({ roles });                 // roles = apa-roles config object
//   const rows = board.fromRows(sourceRows);              // normalize + assign tiers
//   board.thresholdFor(roleKey, cutoffs)                  // → user min ?? hypothesis
//   board.sameBench(a, b)                                 // fuzzy benchmark-name equality
//   const bp = board.benchPrompt();                       // → knowledge-base prompt (optional)
//   const kb = board.parseBench(rawLlmText);              // → [{name, measures, ...}]

function createBoard({ roles = { roles: {}, all_benchmarks: [], track_non_us_os: 3 }, prices = {}, labs = {} } = {}) {
  const benchAll = () => [...new Set([...(roles.all_benchmarks || []), ...Object.values(roles.roles || {}).flatMap(r => r.benchmarks || [])])];
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
  const sameBench = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };

  // Normalize source rows ([{model, lab, os, priceIn, priceOut, benchmarks:{name:score}}])
  // and assign each model the HIGHEST configured tier whose user threshold it clears on that
  // tier's primary benchmark ('' when it clears none or the tier has no threshold yet).
  function fromRows(rows) {
    const tiers = Object.entries(roles.roles || {});
    return (Array.isArray(rows) ? rows : []).filter(r => r && r.model).map(r => {
      let role = '';
      for (const [key, rc] of tiers) {
        if (!rc || !rc.primary || rc.min == null) continue;
        const hit = Object.entries(r.benchmarks || {}).find(([b]) => sameBench(b, rc.primary));
        if (hit && +hit[1] >= +rc.min) role = key;
      }
      return { model: String(r.model), lab: r.lab || '', country: r.country || '', os: !!r.os,
        role, priceIn: r.priceIn ?? null, priceOut: r.priceOut ?? null, benchmarks: r.benchmarks || {} };
    });
  }

  function benchPrompt() {
    return `You maintain a benchmark knowledge base for a multi-model agent system. For EACH benchmark below, produce current, accurate entries (use web search to verify leaders/scores — real figures only, never fabricate):\n` +
      `BENCHMARKS: ${benchAll().join(', ')}\n` +
      `Fields per benchmark: measures (one dense line: what skill it actually tests and its failure modes), goodFor (which agent use cases it PREDICTS well: thoroughbred-reasoning / steeldust-daily / workhorse-mechanical / coding / agentic — and which it misleads on), cutoffs (suggested minimum scores for common tasks with the score scale), leader (current top model + score), notes (saturation status, gaming concerns, update cadence).\n` +
      `Return STRICT JSON only: {"benchmarks":[{"name","measures","goodFor","cutoffs","leader","notes"}]}`;
  }

  function parseBench(raw) {
    const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
    let items = []; try { items = JSON.parse(block).benchmarks || []; } catch (e) {}
    return items.filter(b => b && b.name);
  }

  // effective threshold: user-set min wins over the compiler's hypothesis
  function thresholdFor(roleKey, cutoffs = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    return rc.min ?? (cutoffs[roleKey] || {}).min ?? null;
  }

  return { fromRows, thresholdFor, sameBench, benchPrompt, parseBench };
}

module.exports = { createBoard };
