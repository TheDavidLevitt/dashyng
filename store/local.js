// Local storage adapter — emulates the narrow slice of the Google Sheets values API the
// dashboard uses (get / batchGet / update / append / batchUpdate / clear + tab management)
// over a JSON file, so a fresh clone boots with ZERO Google setup. The server code keeps
// its sheets-shaped call sites; store/index.js decides which backend they hit.
//
// Grid model: data/store/<ns>.json = { "<tab name>": [[row],[row],…] }. Reads trim
// trailing empty cells/rows the way the real API does (header-detection code depends on
// that). Single-process assumption: writes are synchronous write-throughs; don't point two
// live instances at the same file (multi-tier setups belong on the sheets adapter).
const fs = require('fs');
const path = require('path');

const colToIdx = s => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// "'Tab Name'!A2:I" | "Heartbeat!N1" | "'T'!A:I" | "'T'!A1" → {tab, r1, c1, r2, c2} (0-based, inclusive; open ends = Infinity)
function parseRange(range) {
  const m = /^(?:'([^']+)'|([^'!]+))!([A-Z]+)?(\d+)?(?::([A-Z]+)?(\d+)?)?$/.exec(String(range).trim());
  if (!m) throw new Error('local store: unparseable range ' + range);
  const tab = m[1] || m[2];
  const hasSecond = String(range).includes(':');
  const c1 = m[3] ? colToIdx(m[3]) : 0;
  const r1 = m[4] ? +m[4] - 1 : 0;
  const c2 = hasSecond ? (m[5] ? colToIdx(m[5]) : Infinity) : (m[3] ? c1 : Infinity);
  const r2 = hasSecond ? (m[6] ? +m[6] - 1 : Infinity) : (m[4] ? r1 : Infinity);
  return { tab, r1, c1, r2, c2 };
}

module.exports = function localStore(dataDir, ns) {
  const file = path.join(dataDir, (ns || 'local') + '.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const persist = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); };
  const grid = tab => (db[tab] = db[tab] || []);

  const readRect = ({ tab, r1, c1, r2, c2 }) => {
    const g = db[tab] || [];
    const out = [];
    for (let r = r1; r <= Math.min(r2, g.length - 1); r++) {
      const row = (g[r] || []).slice(c1, c2 === Infinity ? undefined : c2 + 1)
        .map(v => v === undefined || v === null ? '' : String(v));
      while (row.length && String(row[row.length - 1]).trim() === '') row.pop(); // API-style trailing-cell trim
      out.push(row);
    }
    while (out.length && !out[out.length - 1].length) out.pop(); // …and trailing-row trim
    return out;
  };
  const writeAt = ({ tab, r1, c1 }, values) => {
    const g = grid(tab);
    values.forEach((row, i) => {
      const gr = (g[r1 + i] = g[r1 + i] || []);
      row.forEach((v, j) => { gr[c1 + j] = v === undefined || v === null ? '' : String(v); });
    });
  };

  return {
    values: {
      async get({ range }) { return { data: { values: readRect(parseRange(range)) } }; },
      async batchGet({ ranges }) { return { data: { valueRanges: ranges.map(r => ({ values: readRect(parseRange(r)) })) } }; },
      async update({ range, requestBody }) { writeAt(parseRange(range), requestBody.values || []); persist(); return { data: {} }; },
      async batchUpdate({ requestBody }) {
        for (const d of (requestBody.data || [])) writeAt(parseRange(d.range), d.values || []);
        persist(); return { data: {} };
      },
      async append({ range, requestBody }) {
        const { tab } = parseRange(range);
        const g = grid(tab);
        let last = -1;
        for (let r = 0; r < g.length; r++) if ((g[r] || []).some(c => String(c ?? '').trim() !== '')) last = r;
        writeAt({ tab, r1: last + 1, c1: 0 }, requestBody.values || []);
        persist(); return { data: {} };
      },
      async clear({ range }) {
        const p = parseRange(range);
        const g = db[p.tab] || [];
        for (let r = p.r1; r <= Math.min(p.r2, g.length - 1); r++) {
          const row = g[r] || [];
          for (let c = p.c1; c <= Math.min(p.c2 === Infinity ? row.length - 1 : p.c2, row.length - 1); c++) row[c] = '';
        }
        persist(); return { data: {} };
      },
    },
    spreadsheets: {
      async get() { return { data: { properties: { title: 'local store (' + path.basename(file) + ')' }, sheets: Object.keys(db).map(title => ({ properties: { title } })) } }; },
      async batchUpdate({ requestBody }) {
        for (const req of (requestBody.requests || []))
          if (req.addSheet && req.addSheet.properties?.title) grid(req.addSheet.properties.title);
        persist(); return { data: {} };
      },
    },
    _file: file,
  };
};
