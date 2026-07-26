// agent-stable · pricing — model price table, source-of-funds classification, and
// open-weight self-host cost estimation. Pure module: no I/O, no globals, no host deps.
// This is the first extracted slice of the agent-stable spinoff (see stable/README.md).

// API-list prices per 1M tokens. Update when prices change; runtime-scraped prices
// (APA board / findings) are layered on top by the host app, not written here.
const MODEL_PRICES = {
  'claude-opus-4-8':    { in: 5,  out: 25,  tier: 'opus' },
  'claude-opus-4-6':    { in: 5,  out: 25,  tier: 'opus' },
  'claude-sonnet-5':    { in: 3,  out: 15,  tier: 'sonnet', note: '$2/$10 intro pricing through 2026-08-31' },
  'claude-haiku-4-5':   { in: 1,  out: 5,   tier: 'haiku' },
  // Google has THREE distinct access routes and they bill completely differently — the
  // classification below (and costClass) depends on getting this right:
  //   1. AI Studio FREE tier  — $0, no card. Rate-limited (single-digit RPM, ~hundreds–1k
  //      requests/day, per model). CAVEAT: on the free tier Google may use submitted data to
  //      improve its products — so it is suitable ONLY for non-personal content.
  //   2. Vertex / AI Studio PAID — the per-token prices below (billed to GCP).
  //   3. Google One / Gemini Advanced — a CONSUMER CHAT subscription with NO API access at
  //      all. It cannot back any agent workload; never model it as capacity.
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, tier: 'gemini' },
  'gemini-2.5-flash':   { in: 0.30, out: 2.50, tier: 'gemini' },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50, tier: 'gemini' },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50, tier: 'gemini' },
  'gemini-3.6-flash':   { in: 1.50, out: 7.50, tier: 'gemini' },
  'gemini-2.5-pro':     { in: 1.25, out: 10, tier: 'gemini' },
  // free-tier route: same models, zero marginal cost, hard rate limits. Address a call to
  // '<model>-free' (or set FREE_TIER_SUFFIX on the module) to price it at zero.
  'gemini-free':        { in: 0, out: 0, tier: 'gemini-free', note: 'AI Studio free tier — rate-limited; data may train Google models, non-personal content only' },
  // grok is out-of-pocket (xAI paid API, reserved for X). Estimate — grok-4-fast list rate;
  // the grok-4.3 agent + x_search calls cost more. Refine when the real invoice lands.
  'grok':               { in: 0.20, out: 0.50, tier: 'grok' },
};
function priceOf(model) {
  const k = Object.keys(MODEL_PRICES).find(p => String(model || '').includes(p));
  return k ? MODEL_PRICES[k] : null;
}

// Source-of-funds classification — the distinctive idea of agent-stable: not just how much a
// call cost, but WHOSE money it was. 'real' = out-of-pocket (paid API keys); 'credit' = finite
// free credit pools (cloud credits, promo agent pools); 'included' = flat-rate subscription.
// NOTE: the rules below are the REFERENCE DEPLOYMENT'S policy (module names like 'claw', a
// subscription-terms change date) — shipped as a worked example. Edit costClass for your own
// billing reality; the rest of agent-stable only relies on the three class names.
const CREDIT_SPLIT_DAY = Date.UTC(2026, 5, 15);
function costClass(model, module, atIso) {
  const m = String(model || '').toLowerCase();
  if (module === 'claw' || (/opus/.test(m) && String(module || '').includes('esc'))) return 'real';
  if (/grok/.test(m)) return 'real';   // xAI is a paid API — out-of-pocket, not a credit or subscription
  if (/gemini|vertex/.test(m)) return /free/.test(m) ? 'included' : 'credit'; // AI Studio free tier costs nothing; Vertex/paid draws GCP credit
  if (/claude|sonnet|haiku|opus/.test(m)) return (atIso ? new Date(atIso).getTime() : Date.now()) >= CREDIT_SPLIT_DAY ? 'credit' : 'included';
  return 'included';
}

// Open-weight self-host cost estimate, $ per 1M OUTPUT tokens:
//   energy(kWh) = watts/1000 × (1e6 tokens ÷ tokPerSec ÷ 3600s)  →  cost = energy × $/kWh
// Defaults: one ~700W GPU rig sustaining ~40 tok/s on a large OS model. Deliberately simple
// and fully user-editable — the point is a stated, tweakable assumption, not a TCO study
// (no hardware amortization, cooling, or batch-throughput effects).
const SELF_HOST_DEFAULTS = { kwhPrice: 0.15, watts: 700, tokPerSec: 40 };
function selfHostPerMTok(a = {}) {
  const { kwhPrice, watts, tokPerSec } = { ...SELF_HOST_DEFAULTS, ...a };
  const kwh = (watts / 1000) * (1e6 / Math.max(1, tokPerSec) / 3600);
  return Math.round(kwh * kwhPrice * 100) / 100;
}

module.exports = { MODEL_PRICES, priceOf, costClass, CREDIT_SPLIT_DAY, SELF_HOST_DEFAULTS, selfHostPerMTok };
