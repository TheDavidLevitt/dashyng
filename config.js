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
  // tab holding the task rows; '' keeps the historical name for existing sheets
  todoTab: pick('todoTab', 'DASHBOARD_TODO_TAB', ''),
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
  // Biotech clinical-trial tracker: the path it mounts at, and the guest emails allowed
  // to sign in and see ONLY that path (comma-separated, or an array in config-local).
  // The owner always has access; '' guests = owner-only.
  bioRoute: (() => { const p = String(pick('bioRoute', 'BIO_ROUTE', '/bio')).trim();
    return ('/' + p.replace(/^\/+|\/+$/g, '')).replace(/\/$/, '') || '/bio'; })(),
  // Dedicated spreadsheet for the tracker ('' → falls back to the main sheet, pre-split
  // behavior, exactly like stableSheetId). The service account cannot CREATE spreadsheets
  // (no Drive quota), so the owner creates one, shares it with the SA, and sets the id here.
  bioSheetId: pick('bioSheetId', 'BIO_SHEET_ID', ''),
  // Escalation threshold for the analysis pipeline: below this confidence a tier hands off
  // to the next one up. Tunable from the logged confidence/outcome data over time.
  bioConfidenceThreshold: Number(pick('bioConfidenceThreshold', 'BIO_CONFIDENCE_THRESHOLD', 0.8)) || 0.8,
  // Circuit breaker: if confidence-based escalation fires on more than this fraction of a
  // run's tasks, the model is miscalibrated rather than the world being uncertain — stop
  // confidence escalations for the rest of the run so one bad threshold can't drain budget.
  bioEscalationCircuitBreaker: Number(pick('bioEscalationCircuitBreaker', 'BIO_ESCALATION_BREAKER', 0.5)) || 0.5,
  // Metered LLM calls are OPT-IN. Off means a host without the free claude CLI refuses to
  // run the analysis pipeline (and says so) rather than silently billing an API.
  bioAllowPaidLLM: pick('bioAllowPaidLLM', 'BIO_ALLOW_PAID_LLM', ''),
  // '1' = reader feedback triggers an Opus run that EDITS public/bio.html and deploys it
  // (bin/bio-apply.sh holds the file-scope, validation and audit rails). Off = propose only.
  bioAutoApply: pick('bioAutoApply', 'BIO_AUTO_APPLY', ''),
  // how many reader-driven page changes one author may trigger per day
  bioApplyPerDay: Number(pick('bioApplyPerDay', 'BIO_APPLY_PER_DAY', 3)) || 3,
  bioEmails: (() => { const v = pick('bioEmails', 'BIO_EMAILS', '');
    return (Array.isArray(v) ? v : String(v).split(','))
      .map(s => String(s).trim().toLowerCase()).filter(Boolean); })(),
  // Hampr donate checklist (/ranmali): guest emails allowed to sign in and see ONLY that
  // page + its API (comma-separated, or an array in config-local). Owner always has access.
  ranmaliEmails: (() => { const v = pick('ranmaliEmails', 'RANMALI_EMAILS', '');
    return (Array.isArray(v) ? v : String(v).split(','))
      .map(s => String(s).trim().toLowerCase()).filter(Boolean); })(),
  // Spreadsheet shared with other people's instances — the sync home for records that are
  // genuinely joint rather than per-owner (e.g. the cycle plugin's state, so two dashboards
  // track one cycle). '' → such plugins fall back to todoSheetId and stay private.
  sharedSheetId: pick('sharedSheetId', 'DASHBOARD_SHARED_SHEET_ID', ''),
  // Reverse-proxy instance routing (both halves generic; values live in env/config-local):
  // guestRoutes (outbound): [{path:'/x', target:'https://…', emails:[…], key:'secret'}] —
  // signed-in guests on a route are served that other dashboard instance for EVERY request;
  // the owner previews it at its entry path. One OAuth client fronts N scoped instances.
  guestRoutes: (() => { const v = pick('guestRoutes', 'DASHBOARD_GUEST_ROUTES', null);
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; } })(),
  // proxyAuthKey (inbound): when set, EVERY request must carry X-Proxy-Auth: <key>
  // (identity arrives as X-Proxy-User) — the instance only answers its fronting proxy.
  proxyAuthKey: pick('proxyAuthKey', 'DASHBOARD_PROXY_AUTH_KEY', ''),
  // News source tiering [{match: regex, tier: 1-4}] — the owner's taste, never shipped
  newsTiers: (() => { const v = pick('newsTiers', 'DASHBOARD_NEWS_TIERS', null);
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; } })(),
  // LLM relay: a tier without the claude CLI forwards its LLM calls to a tier that has it
  // (POST {prompt} + X-Relay-Key), keeping everything on the owner's subscription.
  llmRelayUrl: pick('llmRelayUrl', 'DASHBOARD_LLM_RELAY_URL', ''),
  llmRelayKey: pick('llmRelayKey', 'DASHBOARD_LLM_RELAY_KEY', ''),
  // Guest-CI auto-apply: '1' = a note in the CI box modifies THIS instance's settings
  // immediately (whitelisted layout ops only), logged as an idea; capped per day.
  ciAutoApply: pick('ciAutoApply', 'DASHBOARD_CI_AUTO_APPLY', ''),
  ciApplyPerDay: Number(pick('ciApplyPerDay', 'DASHBOARD_CI_APPLY_PER_DAY', 20)) || 20,
  // Google AI Studio FREE tier (rate-limited, may train on data → non-personal modules only)
  geminiFreeKey: pick('geminiFreeKey', 'GEMINI_API_KEY', ''),
  geminiFreeModel: pick('geminiFreeModel', 'GEMINI_FREE_MODEL', 'gemini-2.5-flash'),
  // Wind & waves widget: the owner's home surf/kite break. '' = section shows a setup hint.
  surfSpotName: pick('surfSpotName', 'DASHBOARD_SURF_SPOT', ''),
  surfSpotLat: Number(pick('surfSpotLat', 'DASHBOARD_SURF_LAT', 0)) || 0,
  surfSpotLon: Number(pick('surfSpotLon', 'DASHBOARD_SURF_LON', 0)) || 0,
  // Sovereign-CDS coverage: base country list + LOCATIONS-tab regex map [{match,country}]
  cdsCountries: (() => { const v = pick('cdsCountries', 'DASHBOARD_CDS_COUNTRIES', null);
    if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } })(),
  cdsLocationMap: (() => { const v = pick('cdsLocationMap', 'DASHBOARD_CDS_LOCATION_MAP', null);
    if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } })(),
  // Multi-spot roster [{key,name,lat,lon}] — the client geolocates and the closest spot wins;
  // falls back to the single spot above when absent. JSON string in the env form.
  surfSpots: (() => { const v = pick('surfSpots', 'DASHBOARD_SURF_SPOTS', null);
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch (e) { return null; } })(),
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
