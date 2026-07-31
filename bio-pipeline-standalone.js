// Dependency bundle for running bio-pipeline.js OUTSIDE the dashboard process — i.e. as a
// Cloud Run Job fired by Cloud Scheduler. Talks to the Sheets API directly (ADC on GCP, key
// file on a workstation) so a scheduled run does not require the web tier to be awake.
const fs = require('fs');
const { google } = require('googleapis');
const CFG = require('./config');

const nowIso = () => new Date().toISOString();
const colLetter = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

// Same header-row discovery as the server: real sheets keep headers below a title row.
function findHeaderRow(values, hint) {
  for (let i = 0; i < Math.min(10, values.length); i++) {
    const row = (values[i] || []).map(c => String(c).trim());
    if (hint.every(h => row.includes(h))) return i;
  }
  return -1;
}

module.exports = async function buildDeps() {
  const auth = fs.existsSync(CFG.keyFile)
    ? new google.auth.GoogleAuth({ keyFile: CFG.keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    : new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = CFG.bioSheetId || CFG.todoSheetId;
  if (!sheetId) throw new Error('no sheet configured: set bioSheetId (BIO_SHEET_ID) or todoSheetId');

  const TAB = 'Biotech Trials';
  const HINT = ['Company', 'Drug', 'Phase', 'ID'];
  const LOG_TAB = 'Bio Analysis Log';
  const LOG_HEADERS = ['At', 'RunId', 'Tier', 'Model', 'TrialId', 'NCTId', 'Company', 'Drug',
    'Confidence', 'Escalated', 'EscalateReason', 'RuleFired', 'CircuitBreaker', 'HumanAgreed', 'Cost', 'ID'];

  async function readTab(tab, hint) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:Z` });
    const values = r.data.values || [];
    const hi = findHeaderRow(values, hint);
    if (hi === -1) throw new Error(`Header row not found in ${tab}`);
    const headers = values[hi].map(h => String(h).trim());
    const rows = values.slice(hi + 1).map((v, i) => {
      const o = { _row: hi + 2 + i };
      headers.forEach((h, c) => { o[h] = v[c] === undefined ? '' : String(v[c]); });
      return o;
    }).filter(o => headers.some(h => o[h]));
    return { headers, rows };
  }

  async function ensureTab(title, headers) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    if ((meta.data.sheets || []).some(s => s.properties.title === title)) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `'${title}'!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] } });
  }

  // clinicaltrials.gov v2 — same field set and flattening as the server, kept here so the
  // Job has no dependency on the web tier being reachable.
  const CTG_FIELDS = ['NCTId', 'BriefTitle', 'OverallStatus', 'Phase', 'LeadSponsorName', 'Condition',
    'StartDate', 'PrimaryCompletionDate', 'CompletionDate', 'LastUpdatePostDate', 'InterventionName', 'EnrollmentCount'].join(',');
  function ctgPhase(phases) {
    const p = (phases || []).map(s => String(s).replace('PHASE', '')).filter(s => /^\d$/.test(s)).sort();
    if (!p.length) return '';
    return p.length === 1 ? 'Phase ' + p[0] : 'Phase ' + p[0] + '/' + p[p.length - 1];
  }
  async function ctgFetch(params) {
    const url = 'https://clinicaltrials.gov/api/v2/studies?' + new URLSearchParams({ fields: CTG_FIELDS, ...params });
    const r = await fetch(url, { headers: { 'User-Agent': 'dashboard-biotracker-job' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`clinicaltrials.gov ${r.status}`);
    return ((await r.json()).studies || []).map(study => {
      const ps = study.protocolSection || {};
      const st = ps.statusModule || {}, de = ps.designModule || {};
      return {
        nctId: (ps.identificationModule || {}).nctId || '',
        trialTitle: (ps.identificationModule || {}).briefTitle || '',
        trialStatus: st.overallStatus || '',
        phase: ctgPhase(de.phases || []),
        enrollment: ((de.enrollmentInfo || {}).count) || 0,
      };
    });
  }

  return {
    sheetId, tab: TAB, logTab: LOG_TAB, logHeaders: LOG_HEADERS,
    analysisFields: ['Outcomes', 'Competition', 'MarketSize', 'Background', 'NextMilestone'],
    confidenceThreshold: CFG.bioConfidenceThreshold,
    breakerRatio: CFG.bioEscalationCircuitBreaker,
    nowIso, ctgFetch,
    readTrials: async () => { try { return (await readTab(TAB, HINT)).rows.filter(r => r.Status !== 'removed'); } catch (e) { return []; } },
    updateTrial: async (id, changes) => {
      const { headers, rows } = await readTab(TAB, HINT);
      const row = rows.find(r => r.ID === id);
      if (!row) return null;
      changes.Updated = nowIso();
      const data = Object.entries(changes).filter(([f]) => headers.indexOf(f) !== -1)
        .map(([f, v]) => ({ range: `'${TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
      if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data } });
      return { ...row, ...changes };
    },
    appendLog: async rows => {
      if (!rows.length) return;
      await ensureTab(LOG_TAB, LOG_HEADERS);
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId, range: `'${LOG_TAB}'!A:${colLetter(LOG_HEADERS.length - 1)}`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows },
      });
    },
  };
};
