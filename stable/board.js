// agent-stable · board — benchmark-board compilation logic, host-independent.
// Pure functions: build the compile prompts, parse/normalize the LLM's results, and merge
// role thresholds. The host supplies the LLM call and persists rows wherever its sink lives.
//
//   const board = createBoard({ roles, prices });        // roles = apa-roles config object
//   const p  = board.compilePrompt();                     // → prompt string for a web-search LLM
//   const r  = board.parseCompile(rawLlmText);            // → { models:[...], cutoffs:{...} }
//   const bp = board.benchPrompt();                       // → knowledge-base prompt
//   const kb = board.parseBench(rawLlmText);              // → [{name, measures, ...}]
//   board.thresholdFor(roleKey, cutoffs)                  // → user min ?? APA hypothesis
//   board.sameBench(a, b)                                 // fuzzy benchmark-name equality

function createBoard({ roles = { roles: {}, all_benchmarks: [], track_non_us_os: 3 }, prices = {}, labs = {} } = {}) {
  const benchAll = () => [...new Set([...(roles.all_benchmarks || []), ...Object.values(roles.roles || {}).flatMap(r => r.benchmarks || [])])];
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
  const sameBench = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };

  function compilePrompt({ currentDefault = '' } = {}) {
    return `You are a model-board compiler building a live cost+benchmark comparison for a multi-model agent system.\n` +
      `Track, for EACH of these labs (${(labs.us_labs || []).join(', ')}): their current TOP-TIER REASONING model (role "thoroughbred"), their DAILY-DRIVER general model (role "steeldust"), and their CHEAPEST usable model (role "workhorse"). ALSO include the top ${roles.track_non_us_os || 3} non-US OPEN-WEIGHT models (role "watch", os=true) for comparison.\n` +
      `For each model provide: model (exact API id if known), lab, country, os (true/false), role, priceIn, priceOut ($/1M tokens), and a benchmarks object using these keys where a real value exists: ${benchAll().join(', ')} (numbers only; OMIT any score you can't verify).\n` +
      `PRICING BASIS: for closed models use the lab's own API list price. For OPEN-WEIGHT models use the CHEAPEST major hosting provider's serverless price (${(labs.hosting || []).join(', ')}) and set "host" to that provider's name — never the lab's own premium endpoint.\n` +
      `Current price table for reference ($/1M in/out): ${JSON.stringify(prices)}. Current system default: ${currentDefault}.\n` +
      `Use web search — Artificial Analysis, LMArena, and the lab pages. Real current figures only; never fabricate.\n` +
      `ALSO hypothesize, for each role, the MINIMUM score on its primary benchmark that a model needs to be ADEQUATE for that task (thoroughbred = hard analysis; steeldust = thesis-led summaries with contextualized numbers; workhorse = mechanical extraction). Give a one-line rationale each.\n` +
      `Return STRICT JSON only: {"models":[{"model","lab","country","os","role","priceIn","priceOut","benchmarks":{...},"host","source"}], "cutoffs":{"thoroughbred":{"min":<number>,"why":"..."},"steeldust":{...},"workhorse":{...}}}. Aim for ~18-22 model rows.`;
  }

  function parseCompile(raw) {
    const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
    let parsed = {}; try { parsed = JSON.parse(block); } catch (e) {}
    const models = (parsed.models || []).filter(m => m && m.model && m.role).map(m => ({
      model: String(m.model).slice(0, 60), lab: m.lab || '', country: m.country || '', os: !!m.os,
      role: m.role || '', priceIn: m.priceIn ?? null, priceOut: m.priceOut ?? null,
      host: m.host ? String(m.host).slice(0, 30) : null,
      benchmarks: m.benchmarks || {}, source: String(m.source || '').slice(0, 120),
    }));
    return { models, cutoffs: parsed.cutoffs || null };
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

  return { compilePrompt, parseCompile, benchPrompt, parseBench, thresholdFor, sameBench, benchAll };
}

module.exports = { createBoard };
