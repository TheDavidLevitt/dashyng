// Host adapter: decision logging flows through the agent-stable meter (stable/meter.js) with
// the Google Sheet sink. Same exported signature logDecision({module, actor, decision, why,
// parent, taskRef, costUsd}) and CLI:
//   node log-decision.js <module> <actor-model> <decision> <why> [parent] [taskRef] [costUsd]
// The meter (auth + sink) is shared with log-usage.js so there's exactly one construction path.
const { meter } = require('./log-usage');

async function logDecision(e) { return meter().decision(e); }

if (require.main === module) {
  const [, , mod, actor, decision, why, parent, taskRef, costUsd] = process.argv;
  logDecision({ module: mod, actor, decision, why, parent, taskRef, costUsd })
    .then(() => console.log('decision logged')).catch(e => console.error('decision log failed:', e.message));
}

module.exports = { logDecision };
