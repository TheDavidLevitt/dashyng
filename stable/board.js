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
//   board.winnerOnBoard(rows, roleKey)                    // → {winner, present, score} | null
//   board.bestReplacement(rows, roleKey, {minScore, maxPriceTotal})  // relaxed delisted-gate search

// model-name equality across sources ("grok-4.3" vs AA's "grok-4-3"): case, dots, spaces → dashes
const normModel = s => String(s || '').toLowerCase().replace(/[\s.]+/g, '-').replace(/-+/g, '-');

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

  // ---- delisted winners ----
  // A role winner absent from the source board has no live price or score, so a strict
  // "equal-or-better AND cheaper" gate can never replace it — the winner freezes forever.
  // The JUDGMENT for that case lives here: presence detection and the relaxed replacement
  // search (equal-or-better on the role's primary benchmark, at comparable-or-better price
  // vs the winner's last-known price — both bars supplied by the host, which keeps that
  // history). The host owns miss-counting, state, and proposal I/O — and never auto-swaps.
  function winnerOnBoard(rows, roleKey) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.winner) return null;
    const hit = (rows || []).find(m => m && normModel(m.model) === normModel(rc.winner));
    if (!hit) return { winner: rc.winner, present: false, score: null };
    const b = Object.entries(hit.benchmarks || {}).find(([k, v]) => v != null && sameBench(k, rc.primary));
    return { winner: rc.winner, present: true, score: b ? +b[1] : null };
  }

  function bestReplacement(rows, roleKey, { minScore = null, maxPriceTotal = null } = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.primary) return null;
    const cands = [];
    for (const m of rows || []) {
      if (!m || normModel(m.model) === normModel(rc.winner || '')) continue;
      const b = Object.entries(m.benchmarks || {}).find(([k, v]) => v != null && !isNaN(+v) && sameBench(k, rc.primary));
      if (!b) continue;
      const score = +b[1];
      if (minScore != null && score < +minScore) continue;
      const total = (m.priceIn != null && m.priceOut != null) ? +m.priceIn + +m.priceOut : null;
      if (maxPriceTotal != null && (total == null || total > maxPriceTotal)) continue;
      cands.push({ model: m.model, lab: m.lab || '', score, priceIn: m.priceIn ?? null, priceOut: m.priceOut ?? null, total });
    }
    cands.sort((a, b) => (b.score - a.score) || ((a.total ?? Infinity) - (b.total ?? Infinity)));
    return cands[0] || null;
  }

  return { fromRows, thresholdFor, sameBench, benchPrompt, parseBench, winnerOnBoard, bestReplacement };
}

module.exports = { createBoard, normModel };
