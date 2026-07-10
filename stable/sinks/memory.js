// agent-stable · in-memory sink — ring buffer, for tests / demos / ephemeral dashboards.
function memorySink({ max = 5000 } = {}) {
  const events = [];
  return {
    events,
    async record(e) { events.push(e); if (events.length > max) events.shift(); return e; },
    query({ type, module, since } = {}) {
      const t = since ? new Date(since).getTime() : 0;
      return events.filter(e => (!type || e.type === type) && (!module || e.module === module) && (!t || new Date(e.at).getTime() >= t));
    },
  };
}
module.exports = { memorySink };
