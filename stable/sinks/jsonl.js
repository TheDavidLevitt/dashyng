// agent-stable · JSONL sink — one JSON object per line, append-only. The `fs` module is
// injected so the core stays host-agnostic (pass require('fs') in Node).
function jsonlSink({ fs, path }) {
  if (!fs || !path) throw new Error('jsonlSink needs { fs, path }');
  return {
    async record(e) { fs.appendFileSync(path, JSON.stringify(e) + '\n'); return e; },
  };
}
module.exports = { jsonlSink };
