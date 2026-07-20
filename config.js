// Single config surface for everything instance-specific. Layering (first hit wins):
//   1. data/config-local.json — per-host, gitignored (Mac/VM carry one)
//   2. environment variables   — the Cloud Run way (ephemeral fs, env persists on the service)
//   3. generic defaults        — NEVER personal; a fresh clone must boot without secrets
// The stub extraction (docs/starter-dashboard-punchlist.md A2) forbids personal fallbacks
// in code: names, emails, sheet IDs, and machine paths all live in layers 1–2.
const fs = require('fs');
const path = require('path');

let local = {};
try { local = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config-local.json'), 'utf8')); } catch (e) {}
const env = process.env;
const pick = (l, e, d) => (local[l] !== undefined && local[l] !== '' ? local[l] : (env[e] !== undefined && env[e] !== '' ? env[e] : d));

module.exports = {
  port: Number(pick('port', 'PORT', 3000)),
  // identity — greeting name and the default Owner written on task rows ('' = omitted)
  userName: pick('userName', 'DASHBOARD_USER_NAME', ''),
  owner: pick('owner', 'DASHBOARD_OWNER', ''),
  locale: pick('locale', 'DASHBOARD_LOCALE', 'en-GB'),
  // Google service-account key file (Mac); absent file ⇒ Application Default Credentials
  keyFile: pick('keyFile', 'DASHBOARD_KEY_FILE', path.join(__dirname, 'service-account.json')),
  // storage backend: 'sheets' | 'local' | 'auto' (auto = sheets when a sheet id is
  // configured, local-JSON otherwise — the zero-Google blank-canvas default)
  store: pick('store', 'DASHBOARD_STORE', 'auto'),
  todoSheetId: pick('todoSheetId', 'DASHBOARD_SHEET_ID', ''),
  prefsSheetId: pick('prefsSheetId', 'DASHBOARD_PREFS_SHEET_ID', ''),
  stableSheetId: pick('stableSheetId', 'STABLE_SHEET_ID', ''), // '' → resolved to todoSheetId (pre-split behavior)
  calendarId: pick('calendarId', 'DASHBOARD_CALENDAR_ID', ''), // '' = calendar section shows its setup hint
  allowedEmail: String(pick('allowedEmail', 'ALLOWED_EMAIL', '')).toLowerCase(),
  // optional journal vault (Obsidian-style markdown daily notes); '' = journal features off
  journalVault: pick('journalVault', 'JOURNAL_VAULT', ''),
  // one-line salience profile for agent prompts (brief ranking, APA relevance):
  // who the owner is / what genuinely matters to them. '' = prompts stay generic.
  profile: pick('profile', 'DASHBOARD_PROFILE', ''),
  // filesystem-overview roots [{key, path, vm?, note?}] — local config only (array)
  fsRoots: Array.isArray(local.fsRoots) ? local.fsRoots : [],
  // GCP project for Vertex (Gemini/Imagen/embeddings); '' = those providers unavailable
  gcpProject: pick('gcpProject', 'GCP_PROJECT', ''),
  // Artificial Analysis data API key (free tier) — benchmark backbone for the Form Guide;
  // '' = fall back to the sheet-compiled board. https://artificialanalysis.ai/data-api
  aaApiKey: pick('aaApiKey', 'AA_API_KEY', ''),
  // OpenRouter API key — unlocks APA candidate probes across ~all hosted models via one
  // account. The keyless price feed works without it. '' = openrouter adapter disabled.
  openrouterKey: pick('openrouterKey', 'OPENROUTER_API_KEY', ''),
  // failover VM hostname (labels its Usage/Decisions rows in the agents summary)
  vmHost: pick('vmHost', 'DASHBOARD_VM_HOST', ''),
  // location-tracking baseline: where the owner is assumed to be absent contrary evidence
  homeLocation: pick('homeLocation', 'DASHBOARD_HOME_LOCATION', ''),
  // Sign-in-with-Google OAuth client (also reused for the one-time Gmail consent grant);
  // Cloud Run carries these as env vars, the Mac in config-local.json
  oauthClientId: pick('oauthClientId', 'GOOGLE_OAUTH_CLIENT_ID', ''),
  oauthClientSecret: pick('oauthClientSecret', 'GOOGLE_OAUTH_CLIENT_SECRET', ''),
  // CI feedback sink + orchestrator learnings source ('' = off) — host-side files, never shipped
  feedbackFile: pick('feedbackFile', 'DASHBOARD_FEEDBACK_FILE', ''),
  learningsFile: pick('learningsFile', 'DASHBOARD_LEARNINGS_FILE', ''),
  heartbeatLog: pick('heartbeatLog', 'DASHBOARD_HEARTBEAT_LOG', ''), // '' = heartbeat health row off
  // IMAP fallback for travel-email evidence — an app password never expires, unlike a
  // Testing-mode OAuth grant. The owner pastes the app password here themselves.
  imapHost: pick('imapHost', 'DASHBOARD_IMAP_HOST', 'imap.gmail.com'),
  imapUser: pick('imapUser', 'DASHBOARD_IMAP_USER', ''),
  imapAppPassword: pick('imapAppPassword', 'DASHBOARD_IMAP_APP_PASSWORD', ''),
};
