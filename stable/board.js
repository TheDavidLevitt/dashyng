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
      let role = '', roleMin = -Infinity; // highest cleared bar wins, not iteration order —
      for (const [key, rc] of tiers) {    // else a low-bar tier added later claims every model
        if (!rc || !rc.primary || rc.min == null) continue;
        const hit = Object.entries(r.benchmarks || {}).find(([b]) => sameBench(b, rc.primary));
        if (hit && +hit[1] >= +rc.min && +rc.min > roleMin) { role = key; roleMin = +rc.min; }
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

  // Cost is USAGE-WEIGHTED (owner's {wIn,wOut} token mix; absent → 0.5/0.5 flat blend). The
  // search is a PARETO VALUE WALK, not a bare cheapest-adequate pick: a hard min-score bar is
  // somewhat arbitrary, and what the owner actually wants is the (cost, score) frontier and
  // the cheap jumps along it. Entry = cheapest frontier model clearing the bar; then upgrade
  // to any later frontier point while the jump is steep, measured in POINTS PER COST-DOUBLING
  // (Δscore / log2(costRatio) — the natural slope on a log-price axis). So +14 points for
  // 1.5× the price (+24 pts/dbl) is taken, +3 points for 14× (+0.8) is not — and the exact
  // placement of the min bar stops deciding the outcome. valueBar tunes greed (default 8
  // pts/dbl; Infinity ⇒ pure cheapest-adequate). maxCost still caps everything: arbitrage
  // never exceeds the incumbent's budget.
  const { weightedCost } = require('./pricing');
  const effCost = c => Math.max(0.01, c); // log math floor — free models plot/compare at 1¢
  const ptsPerDoubling = (a, b) => b.cost <= a.cost ? Infinity : (b.score - a.score) / Math.log2(effCost(b.cost) / effCost(a.cost));
  function paretoFrontier(rows, roleKey, { mix = null } = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.primary) return [];
    const pts = [];
    for (const m of rows || []) {
      if (!m || normModel(m.model) === normModel(rc.winner || '')) continue;
      const b = Object.entries(m.benchmarks || {}).find(([k, v]) => v != null && !isNaN(+v) && sameBench(k, rc.primary));
      if (!b) continue;
      const cost = weightedCost({ in: m.priceIn != null ? +m.priceIn : null, out: m.priceOut != null ? +m.priceOut : null }, mix);
      if (cost == null) continue;
      pts.push({ model: m.model, lab: m.lab || '', score: +b[1], priceIn: m.priceIn ?? null, priceOut: m.priceOut ?? null, cost });
    }
    pts.sort((a, b) => (a.cost - b.cost) || (b.score - a.score));
    const front = []; let best = -Infinity;
    for (const p of pts) if (p.score > best) { front.push(p); best = p.score; }
    return front; // cost-ascending AND score-ascending: the efficient set
  }
  function bestReplacement(rows, roleKey, { minScore = null, maxCost = null, mix = null, valueBar = 8 } = {}) {
    const front = paretoFrontier(rows, roleKey, { mix }).filter(p => maxCost == null || p.cost <= maxCost);
    let i = front.findIndex(p => minScore == null || p.score >= +minScore);
    if (i < 0) return null;
    for (;;) { // value walk — jumps may skip weak intermediate points to reach a steep one
      let bestJ = -1, bestV = valueBar;
      for (let j = i + 1; j < front.length; j++) {
        const v = ptsPerDoubling(front[i], front[j]);
        if (v >= bestV) { bestV = v; bestJ = j; }
      }
      if (bestJ < 0) break;
      i = bestJ;
    }
    return { ...front[i] };
  }

  return { fromRows, thresholdFor, sameBench, benchPrompt, parseBench, winnerOnBoard, bestReplacement, paretoFrontier, ptsPerDoubling };
}

module.exports = { createBoard, normModel };
