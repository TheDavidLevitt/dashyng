// agent-stable · tiers — tier-addressed model resolution for downstream agents.
// A consumer (a chat bot, a cron agent, an orchestrator) doesn't want to know model names —
// it asks for a TIER ("give me a workhorse", "escalate to steeldust") and gets back the
// current model for that tier, what it really costs (price + whose money it is), and any
// advisories that are time- or token-sensitive (intro pricing ending, credit pool expiring,
// context-window ceilings).
//
//   workhorse    — cheapest adequate model; mechanical extraction, classification, bulk work
//   steeldust    — your daily driver: the orchestration layer, escalation from workhorse;
//                  thesis-led summaries, judgment calls, routing
//   thoroughbred — top-tier reasoning model; hard analysis, escalation from steeldust
//
//   const tiers = createTiers({
//     incumbent: t => store.incumbent(t),        // host store: tier → current model id
//     priceOf, costClass,                        // from ./pricing (or your own)
//     advisories: (model, tier) => [...],        // optional host hook (credit pools, limits)
//   });
//   tiers.resolve('workhorse')   → { tier, model, price, fundingClass, advisories }
//   tiers.escalate('workhorse')  → same shape, one tier up (steeldust)

const TIER_ORDER = ['workhorse', 'steeldust', 'thoroughbred'];

function createTiers({ incumbent, priceOf, costClass, advisories } = {}) {
  if (typeof incumbent !== 'function') throw new Error('createTiers needs { incumbent(tier) → model id }');

  function resolve(tier) {
    if (!TIER_ORDER.includes(tier)) return { tier, error: `unknown tier (use ${TIER_ORDER.join(' | ')})` };
    const model = incumbent(tier);
    if (!model) return { tier, error: 'no model configured for this tier' };
    const price = priceOf ? priceOf(model) : null;
    const out = { tier, model, price };
    if (costClass) out.fundingClass = costClass(model); // 'real' | 'credit' | 'included' — whose money it is
    const adv = [];
    if (price && price.note) adv.push(price.note); // price-table advisories (e.g. intro pricing end date)
    if (advisories) adv.push(...(advisories(model, tier) || [])); // host advisories (credit expiry, rate limits)
    out.advisories = adv;
    return out;
  }

  // one tier up from where the caller is; at the top, returns the top with a note
  function escalate(fromTier) {
    const i = TIER_ORDER.indexOf(fromTier);
    if (i < 0) return { error: `unknown tier (use ${TIER_ORDER.join(' | ')})` };
    if (i === TIER_ORDER.length - 1) {
      const top = resolve(fromTier);
      return { ...top, advisories: [...(top.advisories || []), 'already at the top tier (thoroughbred)'] };
    }
    return resolve(TIER_ORDER[i + 1]);
  }

  return { resolve, escalate, TIER_ORDER };
}

module.exports = { createTiers, TIER_ORDER };
