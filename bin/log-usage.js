// Host adapter: usage logging now flows through the agent-stable meter (stable/meter.js)
// with the Google Sheet sink (stable/sinks/sheet.js). This file keeps the original exported
// signature logUsage({module, model, input, output, costUsd, note}) and CLI behavior
// (node log-usage.js <module> <claude-json-file>) so heartbeat.sh/ci.sh/server/providers
// need no changes. Auth stays HERE — agent-stable never sees keys (boundary rule).
const { google } = require('googleapis');
const os = require('os');
const fs = require('fs');
const { createMeter } = require('../stable/meter');
const { sheetSink } = require('../stable/sinks/sheet');
const pricing = require('../stable/pricing');
const KEY = require('../config').keyFile;
// stable data sheet: env → data/stable-sheet.json → master sheet (pre-split fallback)
const ID = process.env.STABLE_SHEET_ID
  || (() => { try { return JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'stable-sheet.json'), 'utf8')).sheetId || ''; } catch (e) { return ''; } })()
  || require('../config').stableSheetId || require('../config').todoSheetId;

let _meter = null;
function meter() {
  if (_meter) return _meter;
  const auth = fs.existsSync(KEY)
    ? new google.auth.GoogleAuth({ keyFile: KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    : new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  _meter = createMeter({ sink: sheetSink({ sheets, spreadsheetId: ID }), pricing, host: os.hostname().split('.')[0] });
  return _meter;
}

// NOTE: when the caller doesn't supply costUsd and the model is in the price table, the meter
// now fills in the estimate (previously left blank and estimated at read time).
async function logUsage(e) { return meter().usage(e); }

if (require.main === module) {
  const [, , mod, file] = process.argv;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const u = j.usage || {};
    logUsage({
      module: mod,
      model: j.model || (j.modelUsage && Object.keys(j.modelUsage)[0]) || '',
      input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
      costUsd: j.total_cost_usd ?? '',
      note: `turns=${j.num_turns ?? '?'} dur=${Math.round((j.duration_ms || 0) / 1000)}s`,
    }).then(() => console.log('usage logged')).catch(e => console.error('usage log failed:', e.message));
  } catch (e) { console.error('usage parse failed:', e.message); }
}

module.exports = { logUsage, meter };
