// Storage backend chooser (punch list A3). The server talks to `store.values.*` /
// `store.spreadsheets.*` — the same shapes as the Google Sheets API — and this module
// decides what actually answers:
//   sheets — passthrough to the real googleapis client (current multi-tier behavior:
//            append-only protocol, envelope sync, RPC queues all live in the data model)
//   local  — JSON-file emulation (store/local.js): zero-Google blank-canvas boot
// Mode: config `store` = 'sheets' | 'local' | 'auto' (default). auto = sheets when a
// task-hub sheet id is configured, local otherwise.
module.exports = function createStore({ mode, sheetsClient, dataDir }) {
  if (mode === 'local') return require('./local')(dataDir);
  const v = sheetsClient.spreadsheets.values, s = sheetsClient.spreadsheets;
  return {
    values: {
      get: p => v.get(p), batchGet: p => v.batchGet(p), update: p => v.update(p),
      batchUpdate: p => v.batchUpdate(p), append: p => v.append(p), clear: p => v.clear(p),
    },
    spreadsheets: { get: p => s.get(p), batchUpdate: p => s.batchUpdate(p) },
  };
};
