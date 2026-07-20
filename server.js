// Standalone dashboard server — direct Google Sheets API, no intermediary files.
// Replaces the Cowork artifact's Drive-CSV action-queue workaround.
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

// ALL instance-specific values come from config.js (config-local.json > env > generic
// defaults) — no personal fallbacks in code. See docs/starter-dashboard-punchlist.md A2.
const CFG = require('./config');
const PORT = CFG.port;
const KEY_FILE = CFG.keyFile;
const TODO_SHEET_ID = CFG.todoSheetId;
const TODO_TAB = 'Todo (Eisenhower Matrix)';
const MEDIA_TAB = 'Media (Reading/Listening)';
const PREFS_SHEET_ID = CFG.prefsSheetId;
// agent-stable data (Usage/Decisions/APA tabs) may live in its OWN spreadsheet, separated
// from the Task Hub / preferences; empty config ⇒ falls back to the master sheet
// (pre-split behavior) so nothing breaks until a dedicated sheet exists. (The SA cannot
// CREATE spreadsheets — zero Drive quota — so the owner creates + shares it, then the id
// goes in the config. data/stable-sheet.json is the legacy location, still honored.)
const STABLE_SHEET_ID = CFG.stableSheetId
  || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'stable-sheet.json'), 'utf8')).sheetId || ''; } catch (e) { return ''; } })()
  || TODO_SHEET_ID;
const PREFS_TABS = ['MASTERPROMPT', 'TOPOFMIND', 'SUBJECTS', 'LOCATIONS', 'PEOPLE', 'INSTANCES', 'SOURCES', 'REMINDERS'];
const CALENDAR_ID = CFG.calendarId;
// Rows created from this dashboard carry Source=web (a human clicking in a browser,
// distinct from agent-written Source=code rows).
const WRITE_SOURCE = 'web';

// Auth: key file on the Mac; Application Default Credentials on Cloud Run
// (the service account is attached to the Cloud Run service — no key to manage).
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar', // rw: Today-card swipe-right inserts events (user action, never agent-initiated)
];
const auth = fs.existsSync(KEY_FILE)
  ? new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: SCOPES })
  : new google.auth.GoogleAuth({ scopes: SCOPES });
const sheetsClient = google.sheets({ version: 'v4', auth });
// Storage seam (punch list A3): all row/tab I/O goes through `store`, which is either a
// passthrough to the real Sheets API (current multi-tier behavior) or a local JSON
// emulation of the same call shapes (zero-Google blank-canvas boot). See store/index.js.
const STORE_MODE = CFG.store === 'local' ? 'local' : CFG.store === 'sheets' ? 'sheets' : (TODO_SHEET_ID ? 'sheets' : 'local');
const store = require('./store')({ mode: STORE_MODE, sheetsClient, dataDir: path.join(__dirname, 'data', 'store') });
const calendar = google.calendar({ version: 'v3', auth });
// blank-canvas seed: the core tabs exist on a reference Sheet by hand; a fresh local
// store needs their header rows before the first read (readTab requires a header row)
if (STORE_MODE === 'local') {
  (async () => {
    const SEED = {
      'Todo (Eisenhower Matrix)': ['Task', 'Quadrant', 'Scope', 'Owner', 'Due', 'Status', 'Created', 'Notes', 'Source', 'Updated', 'Tags', 'ID', 'Order', 'Parent'],
      'Media (Reading/Listening)': ['Title', 'Source', 'Type', 'URL', 'Length_min', 'Priority', 'Status', 'Added', 'Added_by', 'Notes', 'ID'],
    };
    for (const [tab, headers] of Object.entries(SEED)) {
      const cur = await store.values.get({ spreadsheetId: '', range: `'${tab}'!A1:Z1` }).catch(() => null);
      if (!cur || !(cur.data.values || []).length) {
        await store.spreadsheets.batchUpdate({ spreadsheetId: '', requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
        await store.values.update({ spreadsheetId: '', range: `'${tab}'!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] } });
      }
    }
  })().catch(e => console.error('local store seed failed:', e.message));
}

const app = express();
app.use(express.json());

// ---------- auth: "Sign in with Google" (OpenID Connect) — no GCP org needed ----------
// Activates when GOOGLE_OAUTH_CLIENT_ID is set; until then falls back to the password
// (or open, on the Mac where nothing is set). IAP needs a Workspace org we don't have,
// so we run the OAuth flow in the app itself.
const { OAuth2Client } = require('google-auth-library');
const OAUTH_ID = CFG.oauthClientId || process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_SECRET = CFG.oauthClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const ALLOWED_EMAIL = CFG.allowedEmail;
// Game guests (comma-separated emails, e.g. JUNGLEFARM_EMAILS=kid@x.com,parent@y.com):
// may sign in with Google but are confined to /junglefarm — every other path redirects
// there. Only ALLOWED_EMAIL sees the dashboard itself.
// ⚠ PARALLEL-SESSION NOTE: this block and the /junglefarm/api proxy below were wiped
// twice on 2026-07-12 by tree resets/sweeps from other sessions. Jungle Farm auth
// BREAKS IN PRODUCTION without them — do not remove; see JungleVine/DEPLOY.md.
const GAME_GUEST_EMAILS = String(process.env.JUNGLEFARM_EMAILS || '').toLowerCase()
  .split(',').map(s => s.trim()).filter(Boolean);
const isGamePath = p => p === '/junglefarm' || p.startsWith('/junglefarm/');
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'dev-only-secret';

const b64url = s => Buffer.from(s).toString('base64url');
function signSession(email) {
  const payload = b64url(JSON.stringify({ email, exp: Date.now() + 30 * 24 * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(cookie) {
  if (!cookie || !cookie.includes('.')) return null;
  const [payload, sig] = cookie.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expect) return null;
  try { const o = JSON.parse(Buffer.from(payload, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
const cookieOf = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${n}=([^;]+)`)); return m ? decodeURIComponent(m[1]) : null; };
// OAuth redirect URI must EXACTLY match one registered in the Google OAuth client.
// Cloud Run exposes the same service under two hostnames (legacy *-ww.a.run.app and
// the project-number *.region.run.app form); only one callback is registered. Pin it
// via OAUTH_REDIRECT_BASE so OAuth works no matter which hostname the user hits.
const OAUTH_REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || '';
const redirectUri = req => OAUTH_REDIRECT_BASE
  ? `${OAUTH_REDIRECT_BASE.replace(/\/$/, '')}/auth/callback`
  : `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/auth/callback`;
// The callback is pinned to one hostname (above), but users may arrive on www.<base>:
// a host-only cookie set on the apex never reaches www and login loops forever. The gate
// 301s www → apex (one canonical host); the Domain-scoped cookie is belt-and-braces for
// sessions that predate the redirect. Direct *.run.app hits keep host-only cookies.
const BASE_HOST = OAUTH_REDIRECT_BASE ? new URL(OAUTH_REDIRECT_BASE).hostname.replace(/^www\./, '') : '';
const cookieDomain = req => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  return BASE_HOST && (host === BASE_HOST || host.endsWith('.' + BASE_HOST)) ? `; Domain=${BASE_HOST}` : '';
};
// post-login destination: only same-site relative paths survive the round trip
const safeNext = p => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')) ? p : '';

app.get('/auth/login', (req, res) => {
  if (!OAUTH_ID) return res.status(501).send('OAuth not configured');
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const next = safeNext(req.query.next);
  const url = c.generateAuthUrl({ scope: ['openid', 'email', 'profile'], prompt: 'select_account', ...(next ? { state: 'next:' + next } : {}) });
  if (req.query.go) return res.redirect(url); // direct-redirect escape hatch
  // tiny landing: sign-in + (when configured) a link to the public demo stub
  const demo = process.env.DEMO_URL || '';
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>dashyng</title>
<script>/* canonical host: Cloudflare hides the original Host from the app, so the
browser hops www→apex itself — one cookie home, no login loop */
if (location.hostname.startsWith('www.')) location.replace(location.href.replace('//www.', '//'));</script>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif">
<div style="text-align:center">
  <div style="font-size:28px;font-weight:700;margin-bottom:4px">dashyng</div>
  <div style="opacity:.55;font-size:13px;margin-bottom:22px">It's your world baby, we're just living in it</div>
  <a href="${url.replace(/"/g, '&quot;')}" style="display:inline-block;background:#e6edf3;color:#0d1117;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign in with Google</a>
  ${demo ? `<div style="margin-top:14px"><a href="${demo}" style="color:#8b949e;font-size:12px">demo ↗</a></div>` : ''}
</div></body>`);
});
app.get('/auth/callback', asyncRoute(async (req, res) => {
  if (req.query.state === 'gmail') return gmailConsentReturn(req, res);
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: OAUTH_ID });
  const email = (ticket.getPayload().email || '').toLowerCase();
  const isOwner = email === ALLOWED_EMAIL;
  if (!isOwner && !GAME_GUEST_EMAILS.includes(email)) return res.status(403).send(`Not authorized: ${email}`);
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.set('Set-Cookie', `dash_session=${encodeURIComponent(signSession(email))}; HttpOnly${secure}; SameSite=Lax; Max-Age=${30 * 24 * 3600}; Path=/${cookieDomain(req)}`);
  const next = safeNext(String(req.query.state || '').startsWith('next:') ? String(req.query.state).slice(5) : '');
  if (isOwner) return res.redirect(next || '/');
  res.redirect(isGamePath(next.split('?')[0]) ? next : '/junglefarm/');
}));
app.get('/auth/logout', (req, res) => {
  // clear both scopes — sessions may predate the Domain-scoped cookie
  res.set('Set-Cookie', ['dash_session=; Max-Age=0; Path=/', `dash_session=; Max-Age=0; Path=/${cookieDomain(req)}`]);
  res.redirect('/auth/login');
});

// ---------- Gmail consent (location-tracking evidence — separate from the login above) ----------
// One-time offline-access grant: access_type=offline + prompt=consent guarantees a refresh
// token, which the login flow above never requests (it only needs an identity, not standing
// API access). Requires GOOGLE_OAUTH_CLIENT_ID/SECRET already configured for Sign-in-with-
// Google; the Gmail API must be enabled on the same GCP project (gcloud services enable
// gmail.googleapis.com — already done for the reference project).
app.get('/auth/gmail/connect', (req, res) => {
  if (!OAUTH_ID) return res.status(501).send('Set GOOGLE_OAUTH_CLIENT_ID/SECRET first (same as Sign-in-with-Google) — see .env.example.');
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  res.redirect(c.generateAuthUrl({ scope: ['https://www.googleapis.com/auth/gmail.readonly', 'email'], access_type: 'offline', prompt: 'consent', state: 'gmail' }));
});
async function gmailConsentReturn(req, res) {
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: OAUTH_ID }).catch(() => null);
  const email = (ticket?.getPayload()?.email || '').toLowerCase();
  if (ALLOWED_EMAIL && email && email !== ALLOWED_EMAIL) return res.status(403).send(`Not authorized: ${email}`);
  if (!tokens.refresh_token) return res.status(400).send('Google did not return a refresh token — revoke prior access at https://myaccount.google.com/permissions and try again (prompt=consent should force a fresh one).');
  if (HAS_JOURNAL) { // the durable primary host — write directly
    fs.mkdirSync(path.dirname(GMAIL_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify({ refresh_token: tokens.refresh_token, email, connectedAt: nowIso() }));
    setTimeout(() => scanLocation().catch(() => {}), 3000);
    return res.send('Gmail connected for location tracking — harvesting your travel emails now. <a href="/">← back</a>');
  }
  // stateless tier: relay to the primary host; the payload cell is scrubbed on consumption
  await enqueueRpc('gmail-token', { refresh_token: tokens.refresh_token, email });
  res.send('Gmail consent captured — relaying to the home tier (picked up within ~a minute). <a href="/">← back</a>');
}
app.get('/auth/gmail/disconnect', (req, res) => { try { fs.unlinkSync(GMAIL_TOKEN_FILE); } catch (e) {} res.redirect('/'); });

// The ONLY unauthenticated paths: exact-match read-only GETs (no writes, no LLM in any
// of their request paths). Additions here are a REVIEW event — never widen to a prefix.
// The Form Guide (/agentstable + /api/public/formguide*) was public 07-12→07-14, then
// taken private by owner decision: it stays as the signed-in benchmark-comparison view.
const PUBLIC_GETS = new Set([
  '/public/agentstable', '/api/public/agentstable', '/api/public/agentstable/tiers',
]);
// gate: OAuth session (public tier) → basic-auth (if password set) → open.
// Login is enforced only when OAUTH_REDIRECT_BASE marks this instance as publicly
// reachable — merely POSSESSING the OAuth client creds (the Mac holds them for the
// Gmail-consent relay) must not lock down the open LAN tier.
app.use((req, res, next) => {
  // one canonical host: www → apex, so the session cookie has a single home
  const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (BASE_HOST && reqHost === 'www.' + BASE_HOST) return res.redirect(301, `https://${BASE_HOST}${req.originalUrl}`);
  if (req.path.startsWith('/auth/')) return next();
  // Public read-only carve-out: the sanitized agent-stable showcase. Exact GET paths only —
  // everything else (all POSTs, all other pages/APIs) stays behind the gate. The payload is
  // allowlist-built in /api/public/agentstable; never widen this to a prefix match.
  if (req.method === 'GET' && PUBLIC_GETS.has(req.path)) return next();
  if (OAUTH_ID && process.env.OAUTH_REDIRECT_BASE) {
    const sess = verifySession(cookieOf(req, 'dash_session'));
    if (sess) {
      const email = String(sess.email || '').toLowerCase();
      if (email === ALLOWED_EMAIL) return next();
      // game guests: /junglefarm only — anything else bounces back to the game
      if (GAME_GUEST_EMAILS.includes(email)) {
        if (isGamePath(req.path)) return next();
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'game guests only have /junglefarm' });
        return res.redirect('/junglefarm/');
      }
      // valid signature but email no longer on any list (e.g. guest removed) → re-login
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required', login: '/auth/login' });
    return res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (process.env.DASHBOARD_PASSWORD) {
    const b64 = (req.headers.authorization || '').split(' ')[1] || '';
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pass !== process.env.DASHBOARD_PASSWORD) return res.set('WWW-Authenticate', 'Basic realm="dashboard"').status(401).send('Auth required');
  }
  next();
});
// ---------- EchoChamber → private Cloud Run proxy ----------
// Serves the EchoChamber debate GUI at /echochamber for signed-in users.
// The EchoChamber Cloud Run service is private (--no-allow-unauthenticated);
// this proxy signs every request with this service's ID token (from the
// metadata server), so the OAuth gate above is the only door in. Everything
// is streamed unbuffered — Gradio runs its UI over SSE. Express strips the
// /echochamber mount prefix, matching ECHOCHAMBER_ROOT_PATH on the app side.
const EC_URL = (process.env.ECHOCHAMBER_URL || '').replace(/\/$/, '');
const ecTransport = { 'https:': require('https'), 'http:': require('http') };
let ecIdTok = { v: '', exp: 0 };
async function ecToken() {
  if (!EC_URL || Date.now() < ecIdTok.exp) return ecIdTok.v;
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(EC_URL),
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`metadata ${r.status}`);
    ecIdTok = { v: await r.text(), exp: Date.now() + 45 * 60 * 1000 };
  } catch (e) { ecIdTok = { v: '', exp: Date.now() + 30 * 1000 }; } // local dev: no metadata server
  return ecIdTok.v;
}
app.use('/echochamber', asyncRoute(async (req, res) => {
  if (!EC_URL) return res.status(501).send('EchoChamber not configured (set ECHOCHAMBER_URL)');
  // Without the trailing slash the browser resolves Gradio's relative
  // ./assets against the domain root instead of /echochamber/.
  if (req.originalUrl === '/echochamber') return res.redirect(301, '/echochamber/');
  const target = new URL(EC_URL);
  const token = await ecToken();
  // Cloudflare rewrites Host at the origin, so req.headers.host is the
  // run.app name; the canonical public host comes from OAUTH_REDIRECT_BASE.
  const publicHost = (process.env.OAUTH_REDIRECT_BASE || '')
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '') || req.headers.host;
  const headers = {
    ...req.headers,
    host: target.host,
    // Gradio derives its public root URL from these — without them it
    // generates asset/queue URLs against the private run.app host.
    'x-forwarded-host': publicHost,
    'x-forwarded-proto': 'https',
  };
  delete headers.cookie;        // the dash session cookie stays on this side
  delete headers.authorization;
  if (token) headers.authorization = `Bearer ${token}`;
  // express.json() already consumed JSON bodies — re-serialize those;
  // everything else (uploads, SSE handshakes) streams straight through.
  let body = null;
  if (req._body) {
    body = Buffer.from(JSON.stringify(req.body ?? {}));
    headers['content-length'] = body.length;
  }
  const upstream = ecTransport[target.protocol].request({
    host: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.status(502).send('EchoChamber upstream error: ' + e.message);
    else res.end();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}));


// ---------- Jungle Farm → learning-graph proxy ----------
// The game (static files under /junglefarm) reads/writes Jack's knowledge state
// through here, so it works from any signed-in device. Session-gated by the
// middleware above (owner + game guests). Only the narrow surface the game
// needs is proxied — no domain/concept/goal mutation is reachable from the
// web — and the learner is pinned server-side, ignoring anything the client
// sends. The engine token never leaves the server.
const LG_URL = (process.env.LEARNING_GRAPH_URL || '').replace(/\/$/, '');
const LG_TOKEN = process.env.LEARNING_GRAPH_TOKEN || '';
const LG_LEARNER = process.env.JUNGLEFARM_LEARNER || 'learner';
const lgHeaders = { 'Content-Type': 'application/json', ...(LG_TOKEN ? { Authorization: `Bearer ${LG_TOKEN}` } : {}) };
const lgOk = res => { if (!LG_URL) { res.status(501).json({ error: 'learning graph not configured' }); return false; } return true; };

app.get('/junglefarm/api/:kind(state|frontier|stats)/:domain', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  if (!/^[a-z0-9-]+$/.test(req.params.domain)) return res.status(400).json({ error: 'bad domain' });
  const r = await fetch(`${LG_URL}/api/${req.params.kind}/${req.params.domain}?learner=${encodeURIComponent(LG_LEARNER)}`,
    { headers: lgHeaders, signal: AbortSignal.timeout(8000) });
  res.status(r.status).json(await r.json());
}));

// goals are read-only from the web (the progress page shows them)
app.get('/junglefarm/api/goals', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  const r = await fetch(`${LG_URL}/api/goals?learner=${encodeURIComponent(LG_LEARNER)}`,
    { headers: lgHeaders, signal: AbortSignal.timeout(8000) });
  res.status(r.status).json(await r.json());
}));

const evidenceFields = e => ({
  concept_id: String(e.concept_id || ''),
  result: String(e.result || ''),
  notes: typeof e.notes === 'string' ? e.notes.slice(0, 2000) : undefined,
  external_ref: typeof e.external_ref === 'string' ? e.external_ref.slice(0, 100) : undefined,
});
app.post('/junglefarm/api/evidence', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  const body = { ...evidenceFields(req.body || {}), learner_id: LG_LEARNER };
  const r = await fetch(`${LG_URL}/api/evidence`,
    { method: 'POST', headers: lgHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  res.status(r.status).json(await r.json());
}));
app.post('/junglefarm/api/evidence/batch', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  const events = (Array.isArray(req.body?.events) ? req.body.events : []).slice(0, 300).map(evidenceFields);
  const r = await fetch(`${LG_URL}/api/evidence/batch`,
    { method: 'POST', headers: lgHeaders, body: JSON.stringify({ events, learner_id: LG_LEARNER }), signal: AbortSignal.timeout(15000) });
  res.status(r.status).json(await r.json());
}));
// shared game save — versioned KV on the engine, key fixed server-side
app.get('/junglefarm/api/save', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  const r = await fetch(`${LG_URL}/api/kv/junglefarm:${encodeURIComponent(LG_LEARNER)}`,
    { headers: lgHeaders, signal: AbortSignal.timeout(8000) });
  res.status(r.status).json(await r.json());
}));
app.put('/junglefarm/api/save', asyncRoute(async (req, res) => {
  if (!lgOk(res)) return;
  const body = { value: req.body?.value ?? null, rev: req.body?.rev ?? null, force: req.body?.force === true };
  if (JSON.stringify(body.value ?? null).length > 16384) return res.status(400).json({ error: 'save too large' });
  const r = await fetch(`${LG_URL}/api/kv/junglefarm:${encodeURIComponent(LG_LEARNER)}`,
    { method: 'PUT', headers: lgHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  res.status(r.status).json(await r.json());
}));

// no-cache on HTML so an already-open dashboard always picks up freshly-deployed JS on reload
// (the inline script lives in index.html; stale HTML = stale frontend logic after a deploy).
app.use(express.static(__dirname + '/public', {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));
// The public agent-stable showcase page (unauthenticated; carved out in the gate above).
// Direct hits on /agentstable-public.html are NOT carved out and still require login.
app.get('/public/agentstable', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'agentstable-public.html'));
});
// The Form Guide — community model×task recommendations (Phase 1: read-only).
app.get('/agentstable', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'formguide.html'));
});

// Capability flags — agent features need the claude CLI (subscription auth) and
// the Obsidian vault, both Mac-only. On Cloud Run these report unavailable and
// the frontend hides those panels; the Mac instance stays fully featured.
// env override is validated too — a configured-but-missing binary must not report the
// agent capability as present (it would ENOENT at call time instead of degrading cleanly)
const CLAUDE_BIN = process.env.CLAUDE_BIN === 'none' ? '' // explicit opt-out (also how tests simulate a claude-less machine)
  : [process.env.CLAUDE_BIN, '/opt/homebrew/bin/claude', '/usr/bin/claude', '/usr/local/bin/claude'].filter(Boolean).find(p => fs.existsSync(p)) || '';
const HAS_CLAUDE = !!CLAUDE_BIN;
// Text-only LLM features run on either the claude CLI (subscription) or the Anthropic API
// (key) — tool-needing agent features (WebFetch/WebSearch summaries, media find) are
// CLI-only. With NEITHER, single-tier instances refuse cleanly instead of queueing forever;
// multi-tier (sheets store) instances still queue for a CLI-equipped tier to drain.
const HAS_LLM = HAS_CLAUDE || !!process.env.ANTHROPIC_API_KEY;
// Gmail evidence (flight/train/hotel confirmations) for location tracking: needs a
// one-time offline-consent OAuth grant (separate from the Sign-in-with-Google session
// login above — that one only proves identity, it isn't scoped for background API calls
// or persisted as a refresh token). Until connected, hasGmail() is false and the resolver
// runs on calendar + Location-of-Interest evidence alone. See /auth/gmail/connect.
const GMAIL_TOKEN_FILE = path.join(__dirname, 'data', 'gmail-token.json');
const hasGmail = () => { try { return !!JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')).refresh_token; } catch (e) { return false; } };
const hasImap = () => !!(CFG.imapUser && CFG.imapAppPassword);
// Journal vault (optional; config-local/env). '' = journal features off — the frontend
// hides those panels and habit logs fall back to the durable queue.
const VAULT_DIR = CFG.journalVault;
const HAS_JOURNAL = !!VAULT_DIR && fs.existsSync(path.join(VAULT_DIR, 'Daily Journal'));
app.get('/api/capabilities', (req, res) => res.json({ agent: HAS_CLAUDE, llm: HAS_LLM, journal: HAS_JOURNAL, multiTier: STORE_MODE === 'sheets', gmail: hasGmail() }));

// ---------- helpers ----------

function nowIso() {
  return new Date().toISOString();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function tomorrow() {
  return new Date(Date.now() + 864e5).toISOString().slice(0, 10);
}
function yesterday() {
  return new Date(Date.now() - 864e5).toISOString().slice(0, 10);
}

// Column index (0-based) → A1 letter(s)
function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Read a whole tab and locate the header row (the sheet has blank rows above the
// headers — currently row 3 — so never assume row 1).
async function readTab(spreadsheetId, tab, headerHint) {
  let r;
  try {
    r = await store.values.get({ spreadsheetId, range: `'${tab}'!A1:Z` });
    track('sheets_read', true, tab);
  } catch (e) { track('sheets_read', false, e.message); throw e; }
  const values = r.data.values || [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    const row = (values[i] || []).map(c => String(c).trim());
    if (headerHint.every(h => row.includes(h))) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error(`Header row not found in tab "${tab}" (looked for ${headerHint.join(', ')})`);
  const headers = values[headerIdx].map(h => String(h).trim());
  const rows = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const cells = values[i] || [];
    if (cells.every(c => String(c).trim() === '')) continue;
    const obj = { _row: i + 1 }; // 1-based sheet row
    headers.forEach((h, j) => { if (h) obj[h] = cells[j] !== undefined ? String(cells[j]) : ''; });
    rows.push(obj);
  }
  return { headers, headerRow: headerIdx + 1, rows };
}

const readTodoTab = () => readTab(TODO_SHEET_ID, TODO_TAB, ['Task', 'Quadrant', 'Status', 'ID']);
const readMediaTab = () => readTab(TODO_SHEET_ID, MEDIA_TAB, ['Title', 'Type', 'Status']);

// Cached, coalesced Sheet reads for DISPLAY-ONLY endpoints — the dashboard loads ~10 panels at
// once, and the Sheets API allows only 60 reads/min/user. TTL cache + concurrent-request
// coalescing + serve-stale-on-error keeps us under quota (and resilient when it's briefly hit).
// NEVER use this on a read that feeds an append's row-index math — use raw readTab there.
const _tabCache = new Map();
function readTabCached(spreadsheetId, tab, headerHint, ttlMs = 30000) {
  const key = spreadsheetId + '|' + tab;
  const c = _tabCache.get(key) || {};
  if (c.val && Date.now() - c.at < ttlMs) return Promise.resolve(c.val);
  if (c.p) return c.p; // a fetch is already in flight — coalesce onto it
  c.p = readTab(spreadsheetId, tab, headerHint)
    .then(v => { _tabCache.set(key, { at: Date.now(), val: v }); return v; })
    .catch(e => { const o = _tabCache.get(key); if (o && o.val) return o.val; throw e; }) // serve stale on quota/error
    .finally(() => { const cur = _tabCache.get(key); if (cur) delete cur.p; });
  _tabCache.set(key, c);
  return c.p;
}
// cached raw values.get for cell/range display reads (Usage, Decisions) — same resilience
const _rangeCache = new Map();
async function cachedValues(range, ttlMs = 30000, sheetId = TODO_SHEET_ID) {
  const key = sheetId + '|' + range;
  const c = _rangeCache.get(key) || {};
  if (c.val && Date.now() - c.at < ttlMs) return c.val;
  if (c.p) return c.p;
  c.p = store.values.get({ spreadsheetId: sheetId, range })
    .then(r => { const v = r.data.values || []; _rangeCache.set(key, { at: Date.now(), val: v }); return v; })
    .catch(e => { const o = _rangeCache.get(key); if (o && o.val) return o.val; throw e; })
    .finally(() => { const cur = _rangeCache.get(key); if (cur) delete cur.p; });
  _rangeCache.set(key, c);
  return c.p;
}
// same `{data:{values}}` shape as sheets.values.get, but cached — drop-in for display reads
async function cachedGet(range, ttlMs = 30000, sheetId = TODO_SHEET_ID) { return { data: { values: await cachedValues(range, ttlMs, sheetId) } }; }

// Update named columns of one row, located fresh by ID at write time so a stale
// client row index can never clobber the wrong task.
async function updateTaskById(id, changes) {
  const { headers, rows } = await readTodoTab();
  const task = rows.find(r => r.ID === id);
  if (!task) return null;
  changes.Updated = nowIso();
  const data = [];
  for (const [field, value] of Object.entries(changes)) {
    const col = headers.indexOf(field);
    if (col === -1) continue;
    data.push({ range: `'${TODO_TAB}'!${colLetter(col)}${task._row}`, values: [[value]] });
  }
  if (data.length) {
    try {
      await store.values.batchUpdate({
        spreadsheetId: TODO_SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
      });
      track('sheets_write', true);
    } catch (e) { track('sheets_write', false, e.message); throw e; }
  }
  return { ...task, ...changes };
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
}

// ---------- diagnostics ledger ----------
// Every integration records its last success/failure here; /api/diag reports it
// plus live on-demand checks. Kept in-memory (per-instance — that's the point:
// it describes THIS instance's connections).
const STARTED_AT = nowIso();
const diag = {};
function track(name, ok, info) {
  const d = diag[name] = diag[name] || {};
  if (ok) { d.lastOk = nowIso(); d.info = info || d.info; d.lastError = null; }
  else { d.lastFail = nowIso(); d.lastError = String(info || 'error').slice(0, 300); }
}

// ---------- health ----------

app.get('/api/health', asyncRoute(async (req, res) => {
  const meta = await store.spreadsheets.get({ spreadsheetId: TODO_SHEET_ID });
  res.json({
    ok: true,
    sheet: meta.data.properties.title,
    tabs: meta.data.sheets.map(s => s.properties.title),
  });
}));

// ---------- tasks CRUD ----------

app.get('/api/tasks', asyncRoute(async (req, res) => {
  const { rows } = await readTodoTab();
  res.json({ tasks: rows });
}));

// Per-list outbound hook (⚙): a task list can carry a webhook URL — create/done/update
// events for tasks in that list POST there as {event, at, task}. This is how a list plugs
// into an external system (e.g. a learning-goals list feeding a personal knowledge-graph
// API) without the dashboard knowing that system's schema.
//
// Delivery is SIGNED and RETRIED:
// - X-Dashboard-Signature: sha256=hex(HMAC_SHA256(secret, raw body)). The secret is
//   auto-generated once, lives in the settings envelope (so all tiers sign identically),
//   and is shown in ⚙ for the receiver to verify with.
// - A failed POST goes to a file-backed queue retried on backoff (30s → 4h, ~8h total,
//   then dropped with a log line). Durable across restarts on the Mac/VM; best-effort on
//   Cloud Run (the container may be reaped between retries).
const WEBHOOK_QUEUE_FILE = path.join(__dirname, 'data', 'webhook-retry.json');
const WEBHOOK_BACKOFF_MS = [30e3, 2 * 60e3, 10 * 60e3, 30 * 60e3, 60 * 60e3, 2 * 3600e3, 4 * 3600e3];
const WEBHOOK_QUEUE_MAX = 200; // bounded: oldest dropped first if a receiver is down for days
let webhookQueue = (() => { try { return JSON.parse(fs.readFileSync(WEBHOOK_QUEUE_FILE, 'utf8')); } catch (e) { return []; } })();
function persistWebhookQueue() {
  try { fs.mkdirSync(path.dirname(WEBHOOK_QUEUE_FILE), { recursive: true }); fs.writeFileSync(WEBHOOK_QUEUE_FILE, JSON.stringify(webhookQueue)); } catch (e) {}
}
function webhookSecret() {
  const s = loadSettings();
  if (s.webhookSecret) return s.webhookSecret;
  const secret = crypto.randomBytes(32).toString('hex');
  saveSettings({ ...s, webhookSecret: secret });
  return secret;
}
async function deliverHook(job) {
  const body = JSON.stringify(job.payload);
  const sig = crypto.createHmac('sha256', webhookSecret()).update(body).digest('hex');
  const r = await fetch(job.hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Signature': 'sha256=' + sig, 'X-Dashboard-Event': job.payload.event },
    body, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
function queueHookRetry(job, err) {
  job.attempts = (job.attempts || 0) + 1;
  if (job.attempts > WEBHOOK_BACKOFF_MS.length) {
    console.error(`list hook DROPPED after ${job.attempts - 1} retries (${job.hook}): ${err.message}`);
    track('webhook', false, `dropped after ${job.attempts - 1} retries: ${err.message}`);
    return;
  }
  job.nextAt = Date.now() + WEBHOOK_BACKOFF_MS[job.attempts - 1];
  webhookQueue.push(job);
  if (webhookQueue.length > WEBHOOK_QUEUE_MAX) webhookQueue.splice(0, webhookQueue.length - WEBHOOK_QUEUE_MAX);
  persistWebhookQueue();
}
let webhookDraining = false;
async function drainWebhookQueue() {
  if (webhookDraining || !webhookQueue.length) return;
  webhookDraining = true;
  try {
    const now = Date.now();
    const due = webhookQueue.filter(j => (j.nextAt || 0) <= now);
    if (!due.length) return;
    webhookQueue = webhookQueue.filter(j => (j.nextAt || 0) > now);
    for (const job of due) {
      try { await deliverHook(job); track('webhook', true, `delivered after ${job.attempts} retr${job.attempts > 1 ? 'ies' : 'y'}`); }
      catch (e) { queueHookRetry(job, e); }
    }
    persistWebhookQueue();
  } finally { webhookDraining = false; }
}
setInterval(() => drainWebhookQueue().catch(() => {}), 30e3);
function fireListHook(event, task) {
  try {
    const q = String(task.Quadrant || '').toUpperCase().trim();
    const key = (q === 'MON' || q === 'MONITOR') ? 'M' : q;
    const hook = ((loadSettings().quadrants || {})[key] || {}).hook;
    if (!hook || !/^https?:\/\//.test(hook)) return;
    const job = { hook, payload: { event, at: nowIso(), task }, attempts: 0 };
    deliverHook(job)
      .then(() => track('webhook', true, event + ' → ' + job.hook.slice(0, 60)))
      .catch(e => { console.error('list hook attempt 1 failed (queued for retry):', e.message); queueHookRetry(job, e); });
  } catch (e) {}
}

app.post('/api/tasks', asyncRoute(async (req, res) => {
  const { task, quadrant, due, notes, scope, owner, tags, source } = req.body || {};
  if (!task || !quadrant) return res.status(400).json({ error: 'task and quadrant are required' });
  const { headers, headerRow, rows } = await readTodoTab();
  const id = crypto.randomUUID();
  const rowObj = {
    Task: task, Quadrant: quadrant, Scope: scope || 'Personal', Owner: owner || CFG.owner,
    Due: due || '', Status: 'Open', Created: today(), Notes: notes || '',
    // agent callers (journal-read) pass source:'code'; browser clicks default to 'web'
    Source: source || WRITE_SOURCE, Updated: nowIso(), Tags: tags || '', ID: id,
    Order: req.body.order || '', Parent: req.body.parent || '',
  };
  const row = headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '');
  // Append to the bottom — never re-order existing rows (sheet protocol).
  // Explicit target row: values.append's table detection mis-handles this sheet
  // (blank rows above the headers + blank gap rows inside the data), so write at
  // one past the last occupied data row instead.
  const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID,
    range: `'${TODO_TAB}'!A${lastRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
  fireListHook('created', rowObj);
  res.json({ ok: true, task: rowObj });
}));

app.patch('/api/tasks/:id', asyncRoute(async (req, res) => {
  const allowed = ['Task', 'Quadrant', 'Status', 'Due', 'Notes', 'Scope', 'Owner', 'Tags', 'Order', 'Parent'];
  const changes = {};
  for (const k of allowed) if (req.body[k] !== undefined) changes[k] = req.body[k];
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'no recognized fields' });
  const updated = await updateTaskById(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: 'task not found: ' + req.params.id });
  fireListHook('updated', updated);
  res.json({ ok: true, task: updated });
}));

app.post('/api/tasks/:id/done', asyncRoute(async (req, res) => {
  const updated = await updateTaskById(req.params.id, { Status: 'done' });
  if (!updated) return res.status(404).json({ error: 'task not found: ' + req.params.id });
  fireListHook('done', updated);
  // "click the check instead of writing done": a Todo row linked to an AT### thread
  // auto-closes that thread the moment the Todo is checked off.
  const atId = String(updated.AgentTask || '').match(/^AT\d+$/) ? updated.AgentTask : null;
  if (atId) await closeAgentTask(atId, 'Closed via Todo checkbox').catch(() => {});
  res.json({ ok: true, task: updated, closedAgentTask: atId });
}));

// Batch reorder/regroup: [{id, Order?, Parent?, Quadrant?}, ...] in one Sheets call.
app.post('/api/tasks/reorder', asyncRoute(async (req, res) => {
  const updates = req.body.updates;
  if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'updates[] required' });
  const { headers, rows } = await readTodoTab();
  const byId = new Map(rows.map(r => [r.ID, r]));
  const data = [];
  const ts = nowIso();
  const missing = [];
  for (const u of updates) {
    if (!u.id) { missing.push('(blank id rejected)'); continue; } // never act on a blank id
    const task = byId.get(u.id);
    if (!task) { missing.push(u.id); continue; }
    const changes = { Updated: ts };
    for (const f of ['Order', 'Parent', 'Quadrant']) if (u[f] !== undefined) changes[f] = u[f];
    for (const [field, value] of Object.entries(changes)) {
      const col = headers.indexOf(field);
      if (col !== -1) data.push({ range: `'${TODO_TAB}'!${colLetter(col)}${task._row}`, values: [[value]] });
    }
  }
  if (data.length) {
    await store.values.batchUpdate({
      spreadsheetId: TODO_SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }
  res.json({ ok: true, applied: updates.length - missing.length, missing });
}));

// Drag to Monitor = done + keep tracking (parity with the Cowork artifact rule).
app.post('/api/tasks/:id/monitor', asyncRoute(async (req, res) => {
  const updated = await updateTaskById(req.params.id, { Quadrant: 'Monitor', Status: 'done' });
  if (!updated) return res.status(404).json({ error: 'task not found: ' + req.params.id });
  res.json({ ok: true, task: updated });
}));

// ---------- Agent Tasks (AT###) — cross-day thread tracking ----------
// Owner rule (2026-07-02): heartbeat/CI judgment items and open threads (the kind that
// currently live only as numbered ## Agent Feedback items, which get silently dropped when
// a heartbeat run fails and nobody carries them forward) get a permanent, durable ID here —
// independent of any single day's note. A thread stays 'open' until explicitly closed with an
// outcome; closing it (Sheet or a `> done`-style journal reply, whichever comes first) is the
// only way it leaves this tab, so nothing can vanish just because a heartbeat pass errored out.
// Optionally linked to a Todo row (LinkedTodoID) — when set, checking that Todo off in the
// dashboard auto-closes the Agent Task too, so the owner can "click the check" instead of typing a
// reply. NoteDate + the ID's Obsidian deep-link always point at the MOST RECENT day's note that
// discussed the thread — call relink() whenever a later day's note picks the thread back up.
const AGENT_TASKS_TAB = 'Agent Tasks';
const AGENT_TASKS_HEADERS = ['ID', 'Task', 'Status', 'Opened', 'Closed', 'Outcome', 'Source', 'NoteDate', 'Tags', 'LinkedTodoID'];
const OBSIDIAN_VAULT = path.basename(VAULT_DIR || '') || 'vault';
function obsidianDailyLink(dateStr) {
  return `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent('Daily Journal/' + dateStr)}`;
}
async function nextAgentTaskId() {
  let rows = [];
  try { rows = (await readTab(TODO_SHEET_ID, AGENT_TASKS_TAB, AGENT_TASKS_HEADERS)).rows; } catch (e) {}
  const max = rows.reduce((n, r) => Math.max(n, parseInt((String(r.ID || '').match(/^AT(\d+)$/) || [])[1] || '0', 10)), 0);
  return 'AT' + String(max + 1).padStart(3, '0');
}
// Write/refresh the AT-ID as a clickable HYPERLINK formula in a Todo row's AgentTask column.
// USER_ENTERED (not RAW) so Sheets evaluates the formula instead of storing it as literal text.
async function linkAgentTaskToTodo(todoId, atId, noteDate) {
  if (!todoId) return;
  const { headers, rows } = await readTodoTab();
  const task = rows.find(r => r.ID === todoId);
  const col = headers.indexOf('AgentTask');
  if (!task || col === -1) return;
  const formula = `=HYPERLINK("${obsidianDailyLink(noteDate)}", "${atId}")`;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${TODO_TAB}'!${colLetter(col)}${task._row}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [[formula]] },
  }).catch(e => console.error('linkAgentTaskToTodo:', e.message));
}
async function createAgentTask({ task, source = 'manual', tags = '', noteDate = today(), linkedTodoId = '' }) {
  const id = await nextAgentTaskId();
  await appendTabRow(AGENT_TASKS_TAB, AGENT_TASKS_HEADERS, [id, task, 'open', today(), '', '', source, noteDate, tags, linkedTodoId]);
  if (linkedTodoId) await linkAgentTaskToTodo(linkedTodoId, id, noteDate);
  return { id, task, status: 'open', opened: today(), source, noteDate, tags, linkedTodoId };
}
async function findAgentTaskRow(id) {
  const { headers, rows } = await readTab(TODO_SHEET_ID, AGENT_TASKS_TAB, AGENT_TASKS_HEADERS);
  return { headers, row: rows.find(r => r.ID === id) };
}
async function closeAgentTask(id, outcome = '') {
  const { headers, row } = await findAgentTaskRow(id);
  if (!row) return null;
  const data = [
    { field: 'Status', value: 'closed' }, { field: 'Closed', value: today() }, { field: 'Outcome', value: outcome },
  ].map(({ field, value }) => ({ range: `'${AGENT_TASKS_TAB}'!${colLetter(headers.indexOf(field))}${row._row}`, values: [[value]] }));
  await store.values.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  return { ...row, Status: 'closed', Closed: today(), Outcome: outcome };
}
async function relinkAgentTask(id, noteDate) {
  const { headers, row } = await findAgentTaskRow(id);
  if (!row) return null;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${AGENT_TASKS_TAB}'!${colLetter(headers.indexOf('NoteDate'))}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [[noteDate]] },
  });
  if (row.LinkedTodoID) await linkAgentTaskToTodo(row.LinkedTodoID, id, noteDate);
  return { ...row, NoteDate: noteDate };
}
app.get('/api/agent-tasks', asyncRoute(async (req, res) => {
  let rows = []; try { rows = (await readTab(TODO_SHEET_ID, AGENT_TASKS_TAB, AGENT_TASKS_HEADERS)).rows; } catch (e) {}
  const status = String(req.query.status || '').toLowerCase();
  const out = (status ? rows.filter(r => String(r.Status || '').toLowerCase() === status) : rows)
    .map(r => ({ ...r, link: r.NoteDate ? obsidianDailyLink(r.NoteDate) : null }));
  res.json({ tasks: out });
}));
app.post('/api/agent-tasks', asyncRoute(async (req, res) => {
  const { task, source, tags, noteDate, linkedTodoId } = req.body || {};
  if (!task) return res.status(400).json({ error: 'task required' });
  const created = await createAgentTask({ task, source, tags, noteDate, linkedTodoId });
  res.json({ ok: true, task: created, link: obsidianDailyLink(created.noteDate) });
}));
app.post('/api/agent-tasks/:id/close', asyncRoute(async (req, res) => {
  const closed = await closeAgentTask(req.params.id, (req.body || {}).outcome || '');
  if (!closed) return res.status(404).json({ error: 'agent task not found: ' + req.params.id });
  res.json({ ok: true, task: closed });
}));
app.post('/api/agent-tasks/:id/relink', asyncRoute(async (req, res) => {
  const { noteDate } = req.body || {};
  const relinked = await relinkAgentTask(req.params.id, noteDate || today());
  if (!relinked) return res.status(404).json({ error: 'agent task not found: ' + req.params.id });
  res.json({ ok: true, task: relinked });
}));

// ---------- media queue ----------

app.get('/api/media', asyncRoute(async (req, res) => {
  const { rows } = await readMediaTab();
  res.json({ media: rows });
}));

app.post('/api/media/:id/done', asyncRoute(async (req, res) => {
  const { headers, rows } = await readMediaTab();
  const item = rows.find(r => r.ID === req.params.id);
  if (!item) return res.status(404).json({ error: 'media item not found' });
  const col = headers.indexOf('Status');
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID,
    range: `'${MEDIA_TAB}'!${colLetter(col)}${item._row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['done']] },
  });
  res.json({ ok: true });
}));

// Undo support: put a media item back in the queue.
app.post('/api/media/:id/restore', asyncRoute(async (req, res) => {
  const { headers, rows } = await readMediaTab();
  const item = rows.find(r => r.ID === req.params.id);
  if (!item) return res.status(404).json({ error: 'media item not found' });
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID,
    range: `'${MEDIA_TAB}'!${colLetter(headers.indexOf('Status'))}${item._row}`,
    valueInputOption: 'RAW', requestBody: { values: [['queued']] },
  });
  res.json({ ok: true });
}));

// ---------- preferences (read-only, cached) ----------

let prefsCache = { at: 0, data: null };
// ---------- editable interests: People (PEOPLE) & Deep-Dives (SUBJECTS) ----------
// The owner edits their tracked people / subjects as free text; an agent reparses the edit
// back onto the sheet's real column schema; the UI shows a diff he confirms before any
// write. CLAUDE.md marks Preferences read-only for silent agents — this path is explicit,
// human-confirmed editing, which is the sanctioned exception.
// The Interests editor mirrors the three feed sections: News←SOURCES, Deep dives←SUBJECTS,
// Following←PEOPLE. "aboutCol" = the index whose flag we surface as the short label "About".
// The three user config surfaces (2026-07-02): Sources (what to pull, All/top-N + a
// subject filter per source), Subjects (Google-Alert-style topics that also score every feed
// item), Following (people). The news agent applies all three across News / Deep dives /
// Following when building the feed.
const EDITABLE_TABS = {
  SOURCES: { key: 'Source', label: 'Sources' },
  SUBJECTS: { key: 'Subject', label: 'Subjects' },
  PEOPLE: { key: 'Author', label: 'Following', aboutCol: 9, aboutLabel: 'About' },
  // simple two-column tabs (2026-07-03): TOPOFMIND = temporary, highly salient stories to
  // follow until they die (vs SUBJECTS = standing interests); REMINDERS = dated nudges
  // surfaced in Reminders & Habits; LOCATIONS = geographies the news scan covers.
  TOPOFMIND: { key: 'Subject', label: 'Top of mind' },
  REMINDERS: { key: 'Reminder', label: 'Reminders' },
  LOCATIONS: { key: 'Location', label: 'Geographies' },
  // activities of personal interest the agent SCANS for (events land in the look-ahead):
  // columns Activity | Instructions | Lead days | Show (weekdays or 'all')
  ACTIVITIES: { key: 'Activity', label: 'Activities' },
};
function prefHeaderIdx(values) { for (let i = 0; i < Math.min(values.length, 4); i++) { if ((values[i] || []).length >= 2) return i; } return 0; }
async function loadEditablePref(tab) {
  const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` });
  const values = r.data.values || [];
  const hi = prefHeaderIdx(values);
  const header = values[hi] || [];
  const rows = values.slice(hi + 1).filter(row => (row || []).some(c => String(c).trim()));
  return { header, rows, dataStartRow: hi + 2, oldCount: values.length - (hi + 1) };
}
// header column → short display label (for flags we want to abbreviate, e.g. "About")
function colLabel(tab, header, i) {
  const cfg = EDITABLE_TABS[tab];
  if (cfg && cfg.aboutCol === i) return cfg.aboutLabel;
  return header[i];
}
// human-readable one-line-per-entry rendering the user edits
function renderPrefText(tab, header, rows) {
  return rows.map(r => {
    const name = (r[0] || '').trim();
    if (!name) return '';
    // Line formats (2026-07-02): Sources `Name [All|top N] (subject filter)`,
    // Subjects `Name (filter preference)` — parens = FILTER in both. Category/Trial columns
    // still exist in the sheet but are no longer surfaced (reparse preserves them on
    // unchanged lines; they simply stop being part of the editing language).
    if (tab === 'SUBJECTS') { // Subject, Category, Filter
      const filt = (r[2] || '').trim();
      return name + (filt ? ` (${filt})` : '');
    }
    if (tab === 'TOPOFMIND') { // Subject, Query — `Name: query`
      const query = (r[1] || '').trim();
      return name + (query ? `: ${query}` : '');
    }
    if (tab === 'REMINDERS') { // Reminder, DATES — `Name [dates]`
      const dates = (r[1] || '').trim();
      return name + (dates ? ` [${dates}]` : '');
    }
    if (tab === 'ACTIVITIES') { // Activity, Instructions, Lead days, Show — `Name: instructions [lead Nd] (show: days)`
      const instr = (r[1] || '').trim(), lead = (r[2] || '').trim(), show = (r[3] || '').trim();
      return name + (instr ? `: ${instr}` : '') + (lead ? ` [lead ${lead}d]` : '') + (show ? ` (show: ${show})` : '');
    }
    if (tab === 'LOCATIONS') { // Location, Filter — `Name (filter)`
      const filt = (r[1] || '').trim();
      return name + (filt ? ` (${filt})` : '');
    }
    if (tab === 'SOURCES') { // Source, Trial, Top stories (#), All, Category, Filter
      const topN = (r[2] || '').trim();
      const all = String(r[3] || '').trim() && String(r[3]).trim() !== '0';
      const filt = (r[5] || '').trim();
      let line = name;
      if (all) line += ' [All]';
      else if (topN && topN !== '0') line += ` [top ${topN}]`;
      if (filt) line += ` (${filt})`;
      return line;
    }
    // PEOPLE: list enabled content-type columns (col 9 shown as "About"), then category, filter, notes
    const types = [];
    header.forEach((h, i) => { if (i > 0 && i < 10 && String(r[i] || '').trim() && String(r[i]).trim() !== '0') types.push(colLabel(tab, header, i)); });
    const cat = (r[10] || '').trim(), filt = (r[11] || '').trim(), notes = (r[12] || '').trim();
    let line = name;
    if (types.length) line += ` [${types.join(', ')}]`;
    if (cat) line += ` (${cat})`;
    if (filt) line += `: ${filt}`;
    if (notes) line += ` — ${notes}`;
    return line;
  }).filter(Boolean).join('\n');
}
function prefDiff(tab, oldRows, newRows) {
  const k = r => String((r[0] || '')).trim().toLowerCase();
  // canonicalize for comparison: trim each cell and drop trailing empties, so a raw ragged
  // sheet row (trailing blanks omitted) compares equal to a header-padded reparsed row.
  const canon = r => { const a = (r || []).map(c => String(c == null ? '' : c).trim()); while (a.length && a[a.length - 1] === '') a.pop(); return JSON.stringify(a); };
  const oldMap = new Map(oldRows.map(r => [k(r), r])), newMap = new Map(newRows.map(r => [k(r), r]));
  const added = [], removed = [], changed = [];
  for (const [key, r] of newMap) { if (!oldMap.has(key)) added.push(r[0]); else if (canon(oldMap.get(key)) !== canon(r)) changed.push(r[0]); }
  for (const [key, r] of oldMap) { if (!newMap.has(key)) removed.push(r[0]); }
  return { added, removed, changed };
}
app.get('/api/prefs/editable', asyncRoute(async (req, res) => {
  const tab = String(req.query.tab || '').toUpperCase();
  if (!EDITABLE_TABS[tab]) return res.status(400).json({ error: 'unknown tab' });
  const { header, rows } = await loadEditablePref(tab);
  res.json({ tab, label: EDITABLE_TABS[tab].label, header, rows, text: renderPrefText(tab, header, rows) });
}));
async function doReparse({ tab, text }) {
  tab = String(tab || '').toUpperCase();
  text = String(text || '');
  if (!EDITABLE_TABS[tab]) throw new Error('unknown tab');
  const { header, rows } = await loadEditablePref(tab);
  const prompt =
    `You maintain a Google Sheet tab. Here is its HEADER (column order matters) and its CURRENT rows as JSON:\n` +
    `HEADER: ${JSON.stringify(header)}\n` +
    `CURRENT ROWS: ${JSON.stringify(rows)}\n\n` +
    `The user re-edited this list as free text (one entry per line). Produce the NEW COMPLETE set of rows as JSON, applying the user's additions, deletions, and edits.\n` +
    `RULES:\n` +
    `- Each output row is an array aligned to HEADER exactly (same length; use "" for empty cells).\n` +
    `- For an entry that already existed and is unchanged in meaning, PRESERVE its existing column values verbatim (especially "1" flags in content-type columns, Category, Filter).\n` +
    `- A "1" in a content-type/All column means that content type is followed; keep those conventions.\n` +
    (tab === 'PEOPLE'
      ? `- PEOPLE (the "Following" list): column 0 is the author name. If a NEW person is added with no content type specified, put "1" in the "All" column and leave the rest blank. The bracketed [types] in the text map to content columns by header name — EXCEPT the token "About", which maps to the "Include articles about too?" column (put "1" there when "About" is present). (parens) = Category; text after ":" = Filter; text after "—" = Notes.\n`
      : tab === 'SOURCES'
      ? `- SOURCES (the news sources list): columns are Source, Trial, Top stories (#), All, Category, Filter. Line format: Name [All|top N] (subject filter). "[All]" puts "1" in the All column (clear Top stories); "[top N]" sets "Top stories (#)"=N (clear All). The (parens) text = the FILTER column (a subject filter for that source), NOT Category. Never touch the Trial or Category columns except to preserve their existing values.\n`
      : tab === 'TOPOFMIND'
      ? `- TOPOFMIND (temporary, highly salient stories to follow until they die — e.g. a local issue, a war): columns are Subject, Query. Line format: "Name: query". Text after the first ":" = the Query column (the standing question the news agent answers for this subject).\n`
      : tab === 'REMINDERS'
      ? `- REMINDERS (dated nudges): columns are Reminder, DATES. Line format: "Name [dates]". The [brackets] text = the DATES column — "All" means every day; otherwise a month+year like "May, 2026".\n`
      : tab === 'LOCATIONS'
      ? `- LOCATIONS (geographies the news scan covers): columns are Location, Filter. Line format: "Name (filter)". The (parens) text = the FILTER column describing which news matters for that place.\n`
      : tab === 'ACTIVITIES'
      ? `- ACTIVITIES (things the agent actively scans the web for — local events, sports fixtures, ticket on-sales): columns are Activity, Instructions, Lead days, Show. Line format: "Name: instructions [lead Nd] (show: Fri,Sat|all)". Instructions = how/where to search and what counts as an event; Lead days = how many days before an event it should surface as a heads-up (0 = only on the day boxes); Show = which weekday boxes may display it ('all' or a comma list like Fri,Sat).\n`
      : `- SUBJECTS (topics scanned like Google Alerts + used to score all feed items): columns are Subject, Category, Filter. Line format: Name (filter preference). The (parens) text = the FILTER column, NOT Category. Preserve existing Category values untouched.\n`) +
    `- Do NOT invent entries the user didn't write. Do NOT drop entries the user kept.\n` +
    `Return STRICT JSON only, no prose, no code fences: {"rows": [[...],[...]]}\n\nUSER'S EDITED LIST:\n${text}`;
  const raw = await runClaude(prompt, { timeoutMs: 120000, module: 'prefs-reparse', model: 'claude-sonnet-5' });
  const stripped = String(raw).replace(/```json?/gi, '').replace(/```/g, '').trim();
  const block = (stripped.match(/\{[\s\S]*\}/) || [])[0];
  let parsed = null; try { parsed = JSON.parse(block); } catch (e) {}
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error('agent returned unparseable rows');
  // normalize row length to the header
  const newRows = parsed.rows.map(r => { const a = (Array.isArray(r) ? r : [r]).map(c => c == null ? '' : String(c)); while (a.length < header.length) a.push(''); return a.slice(0, header.length); })
    .filter(r => String(r[0] || '').trim());
  return { tab, header, rows: newRows, text: renderPrefText(tab, header, newRows), diff: prefDiff(tab, rows, newRows) };
}
app.post('/api/prefs/reparse', asyncRoute(async (req, res) => {
  const tab = String(req.body.tab || '').toUpperCase();
  if (!EDITABLE_TABS[tab]) return res.status(400).json({ error: 'unknown tab' });
  // Mac/VM have claude → run inline. Cloud Run has no claude → queue it for the Mac/VM
  // drainer and hand back a job id the frontend polls (works from the cloud URL / phone).
  if (HAS_LLM) { try { return res.json(await doReparse(req.body)); } catch (e) { return res.status(500).json({ error: e.message }); } }
  if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'No LLM configured — set ANTHROPIC_API_KEY (or install the claude CLI)' });
  const id = await enqueueRpc('reparse', { tab, text: String(req.body.text || '') });
  res.json({ queued: true, id });
}));
// ---- "Describe my news" (blank-canvas onboarding): one free-text description of the
// desired news feed → complete row sets for all five driving tabs, previewed as per-tab
// diffs and applied through the same /api/prefs/apply path as the ✎ editors.
const DESCRIBE_TABS = ['SOURCES', 'SUBJECTS', 'PEOPLE', 'LOCATIONS', 'TOPOFMIND'];
async function doNewsDescribe({ text }) {
  // one batchGet, not five reads — the per-minute Sheets read quota is tight when
  // several instances share the service account
  const resp = await store.values.batchGet({
    spreadsheetId: PREFS_SHEET_ID, ranges: DESCRIBE_TABS.map(t => `'${t}'!A1:Z`),
  });
  const cur = {};
  DESCRIBE_TABS.forEach((tab, i) => {
    const values = ((resp.data.valueRanges || [])[i] || {}).values || [];
    const hi = prefHeaderIdx(values);
    cur[tab] = { header: values[hi] || [], rows: values.slice(hi + 1).filter(row => (row || []).some(c => String(c).trim())) };
  });
  const prompt =
    `You configure a personal news dashboard. Its feed is driven by five Google Sheet tabs:\n` +
    `- SOURCES (publications scanned; columns ${JSON.stringify(cur.SOURCES.header)}): "1" in All = every recent story; a number in "Top stories (#)" = only its top N; Filter = subject filter for that source.\n` +
    `- SUBJECTS (standing interests scanned like Google Alerts AND used to score every feed item; columns ${JSON.stringify(cur.SUBJECTS.header)}).\n` +
    `- PEOPLE (authors/voices followed — X, Substack, YouTube; columns ${JSON.stringify(cur.PEOPLE.header)}; "1" flags which content types to follow, "All" = everything).\n` +
    `- LOCATIONS (geographies that matter; columns ${JSON.stringify(cur.LOCATIONS.header)}; Filter = which local news qualifies).\n` +
    `- TOPOFMIND (temporary highly-salient stories followed until they die; columns ${JSON.stringify(cur.TOPOFMIND.header)}; Query = the standing question the news agent answers).\n\n` +
    `CURRENT ROWS:\n` + DESCRIBE_TABS.map(t => `${t}: ${JSON.stringify(cur[t].rows)}`).join('\n') + `\n\n` +
    `The user described the news feed they want:\n"""${String(text || '').slice(0, 2000)}"""\n\n` +
    `Produce the COMPLETE new row set for EVERY tab. RULES:\n` +
    `- MERGE, don't wipe: keep existing rows unless the description clearly replaces or excludes them; add what the description asks for.\n` +
    `- Every row is an array aligned to that tab's header exactly (same length, "" for empty cells).\n` +
    `- Only well-known real publications/people; don't invent niche sources.\n` +
    `- OMIT tabs the description doesn't touch entirely (keeps your output small) — but a tab you DO touch must contain its COMPLETE new row set (existing kept rows + changes).\n` +
    `- ALSO return "subtitles": one grey blurb (≤9 words each) per dashboard section describing how the RESULTING feed is built, based on the FINAL config (current rows + your changes): "News" from SOURCES (tiering/mix, e.g. "tiered: Economist → mainstream → wildcards"), "Deep dives" from SUBJECTS, "Following" from PEOPLE.\n` +
    `Return STRICT JSON only, no prose, no code fences, only the tabs you change plus subtitles: {"SUBJECTS":{"rows":[[...]]}, "subtitles":{"News":"...","Deep dives":"...","Following":"..."}}`;
  const raw = await runClaude(prompt, { timeoutMs: 180000, module: 'prefs-reparse', model: 'claude-sonnet-5' });
  const stripped = String(raw).replace(/```json?/gi, '').replace(/```/g, '').trim();
  const block = (stripped.match(/\{[\s\S]*\}/) || [])[0];
  let parsed = null; try { parsed = JSON.parse(block); } catch (e) {}
  if (!parsed) throw new Error('agent returned unparseable config');
  const tabs = [];
  for (const tab of DESCRIBE_TABS) {
    const { header, rows } = cur[tab];
    const raw2 = parsed[tab] && Array.isArray(parsed[tab].rows) ? parsed[tab].rows : null;
    if (!raw2) continue;
    const newRows = raw2.map(r => { const a = (Array.isArray(r) ? r : [r]).map(c => c == null ? '' : String(c)); while (a.length < header.length) a.push(''); return a.slice(0, header.length); })
      .filter(r => String(r[0] || '').trim());
    tabs.push({ tab, label: EDITABLE_TABS[tab].label, header, rows: newRows, text: renderPrefText(tab, header, newRows), diff: prefDiff(tab, rows, newRows) });
  }
  if (!tabs.length) throw new Error('agent returned no usable tabs');
  const subtitles = {};
  for (const [k, v] of Object.entries(parsed.subtitles || {}))
    if (['News', 'Deep dives', 'Following'].includes(k) && typeof v === 'string' && v.trim()) subtitles[k] = v.trim().slice(0, 90);
  return { tabs, subtitles };
}
app.post('/api/news/describe', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (HAS_LLM) { try { return res.json(await doNewsDescribe({ text })); } catch (e) { return res.status(500).json({ error: e.message }); } }
  if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'No LLM configured — set ANTHROPIC_API_KEY (or install the claude CLI)' });
  const id = await enqueueRpc('news_describe', { text });
  res.json({ queued: true, id });
}));

app.post('/api/prefs/apply', asyncRoute(async (req, res) => {
  const tab = String(req.body.tab || '').toUpperCase();
  const rows = req.body.rows;
  if (!EDITABLE_TABS[tab]) return res.status(400).json({ error: 'unknown tab' });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'no rows' });
  const { header, dataStartRow, oldCount } = await loadEditablePref(tab);
  const norm = rows.map(r => { const a = (Array.isArray(r) ? r : [r]).map(c => c == null ? '' : String(c)); while (a.length < header.length) a.push(''); return a.slice(0, header.length); })
    .filter(r => String(r[0] || '').trim());
  if (!norm.length) return res.status(400).json({ error: 'no non-empty rows' });
  // clear the old data region (generously), then write the new rows below the header
  const clearRows = Math.max(oldCount, norm.length) + 20;
  await store.values.clear({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A${dataStartRow}:Z${dataStartRow + clearRows}` });
  await store.values.update({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A${dataStartRow}`, valueInputOption: 'RAW', requestBody: { values: norm } });
  prefsCache = { at: 0, data: null }; // force refresh so news picks up the change
  res.json({ ok: true, count: norm.length });
}));

app.get('/api/prefs', asyncRoute(async (req, res) => {
  if (prefsCache.data && Date.now() - prefsCache.at < 5 * 60 * 1000) return res.json(prefsCache.data);
  const out = {};
  for (const tab of PREFS_TABS) {
    try {
      const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` });
      out[tab] = r.data.values || [];
    } catch (e) {
      out[tab] = { error: e.message };
    }
  }
  prefsCache = { at: Date.now(), data: out };
  res.json(out);
}));

// ---------- dashboard layout settings (sections / quadrants / calendars) ----------
// GUI-configurable page layout: section order/visibility/titles, quadrant renames + wide
// flag, and the calendar source list (Google calendar ids + iCal URLs). Same cross-tier
// pattern as markets: local file + versioned {savedAt, settings} envelope in Heartbeat!O1.
const SETTINGS_LOCAL = path.join(__dirname, 'data', 'settings-local.json');
const SETTINGS_CELL = "'Heartbeat'!O1";
function parseSettingsPayload(raw) {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.settings === 'object') return { savedAt: j.savedAt || 0, settings: j.settings };
  } catch (e) {}
  return null;
}
function readSettingsFile() {
  try { return parseSettingsPayload(fs.readFileSync(SETTINGS_LOCAL, 'utf8')); } catch (e) { return null; }
}
function loadSettings() {
  const f = readSettingsFile();
  return (f && f.settings) || { sections: {}, quadrants: {}, calendars: [] };
}
function saveSettings(settings) {
  const payload = JSON.stringify({ savedAt: Date.now(), settings });
  try { fs.writeFileSync(SETTINGS_LOCAL, payload); } catch (e) {}
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: SETTINGS_CELL, valueInputOption: 'RAW', requestBody: { values: [[payload.slice(0, 49000)]] } }).catch(() => {});
}
// TWO-WAY envelope sync: pull a newer remote, or push a newer local (edits made while
// offline reach the other tiers when connectivity returns — the 10-min interval retries).
async function syncSettingsFromSheet() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: SETTINGS_CELL });
    const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
    const remote = parseSettingsPayload(raw);
    const local = readSettingsFile();
    if (remote && (!local || remote.savedAt > local.savedAt)) { fs.writeFileSync(SETTINGS_LOCAL, raw); return; }
    if (local && (!remote || local.savedAt > (remote ? remote.savedAt : 0)))
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: SETTINGS_CELL, valueInputOption: 'RAW',
        requestBody: { values: [[JSON.stringify(local).slice(0, 49000)]] } });
  } catch (e) {}
}
syncSettingsFromSheet(); setInterval(syncSettingsFromSheet, 10 * 60000);
// calendar provenance for the ⚙ panel: what the empty-list default is, and which
// service-account email a new user must share their Google calendar with
const SA_EMAIL = (() => { try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).client_email || ''; } catch (e) { return ''; } })();
app.get('/api/settings', asyncRoute(async (req, res) => res.json({
  settings: loadSettings(), calendarDefault: CALENDAR_ID, serviceAccount: SA_EMAIL,
  // instance identity for the client (greeting, footer sheet link) — from config, not code
  userName: CFG.userName, homeLocation: CFG.homeLocation,
  sheetUrl: TODO_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${TODO_SHEET_ID}/edit` : '',
})));

// ---------- plugin sections (plugins/*.js — private, gitignored; see plugins/README.md) ----------
// A plugin = { key, title, data(), client } → appears as a dashboard section on any tier
// that has the file. This is how private bits stay out of the public repo without a fork.
// A plugin (plugins/*.js, gitignored — private, per-tier) may export ANY of (B1 hooks):
//   key, title, data(), client        → a dashboard SECTION (original API, unchanged)
//   routes(app, ctx)                  → register its own API endpoints
//   jobs: [{ everyMs, run(ctx) }]     → recurring background work
//   newsSources: [{ title, build(ctx) }] → extra news sections; build() → items[]
//                 ({title, link, source, age?, desc?}); folded into /api/news responses
//   healthRows(ctx)                   → health-panel rows: [{ name, ok, info }]
// ctx = { store, config, runLLM } — the same injected-I/O philosophy as agent-stable.
const PLUGINS = {};
const PLUGIN_NEWS_SOURCES = [];
const PLUGIN_HEALTH = [];
const PLUGIN_LLM = []; // llm({prompt, module, model, tools}, ctx) → string (answered) | null (pass)
const pluginCtx = () => ({ store, config: CFG, runLLM: (prompt, opts) => runClaude(prompt, opts) });
try {
  for (const f of fs.readdirSync(path.join(__dirname, 'plugins')).filter(f => f.endsWith('.js'))) {
    try {
      const p = require(path.join(__dirname, 'plugins', f));
      if (!p) continue;
      if (p.key && typeof p.data === 'function') PLUGINS[p.key] = p;
      if (typeof p.routes === 'function') p.routes(app, pluginCtx());
      for (const j of (Array.isArray(p.jobs) ? p.jobs : []))
        if (j && j.everyMs > 0 && typeof j.run === 'function')
          setInterval(() => Promise.resolve(j.run(pluginCtx())).catch(e => console.error(`plugin job (${f}):`, e.message)), j.everyMs);
      for (const s of (Array.isArray(p.newsSources) ? p.newsSources : []))
        if (s && s.title && typeof s.build === 'function') PLUGIN_NEWS_SOURCES.push({ ...s, _file: f });
      if (typeof p.healthRows === 'function') PLUGIN_HEALTH.push({ fn: p.healthRows, _file: f });
      if (typeof p.llm === 'function') PLUGIN_LLM.push({ fn: p.llm, _file: f }); // LLM router: return a string to answer, null to pass
    } catch (e) { console.error('plugin load failed:', f, e.message); }
  }
} catch (e) {}
// fold plugin-provided news sections into a news payload (same pattern as Model Watch);
// a failing plugin source never breaks the feed
async function withPluginNews(data) {
  for (const s of PLUGIN_NEWS_SOURCES) {
    try {
      const items = await s.build(pluginCtx());
      if (Array.isArray(items) && items.length)
        data = { ...data, sections: [...(data.sections || []), { title: s.title, items: items.slice(0, 15) }] };
    } catch (e) { console.error(`plugin news source (${s._file}):`, e.message); }
  }
  return data;
}
app.get('/api/plugins', asyncRoute(async (req, res) =>
  res.json({ plugins: Object.values(PLUGINS).map(p => ({ key: p.key, title: p.title || p.key, client: p.client || null })) })));
app.get('/api/plugin/:key', asyncRoute(async (req, res) => {
  const p = PLUGINS[req.params.key];
  if (!p) return res.status(404).json({ error: 'no such plugin' });
  try { res.json({ data: await p.data() }); } catch (e) { res.status(500).json({ error: e.message }); }
}));
app.post('/api/settings', asyncRoute(async (req, res) => {
  // Best-effort freshness: pull the cross-tier envelope only if the network answers fast.
  // NEVER block a save on connectivity — plane wifi turned every rename into a lost edit
  // when this await could hang through gaxios retries (2026-07-05).
  await Promise.race([syncSettingsFromSheet(), new Promise(r => setTimeout(r, 2500))]);
  const cur = loadSettings();
  const s = req.body && req.body.settings;
  if (!s || typeof s !== 'object') return res.status(400).json({ error: 'settings object required' });
  const next = { ...cur };
  if (s.sections && typeof s.sections === 'object') next.sections = s.sections;
  if (s.quadrants && typeof s.quadrants === 'object') {
    // MERGE per list key — full-object replacement let any stale page wipe labels set
    // elsewhere (Q4 rename kept reverting, 2026-07-10). null deletes a key; {} resets it.
    next.quadrants = { ...(cur.quadrants || {}) };
    for (const [k, v] of Object.entries(s.quadrants)) {
      if (v === null) delete next.quadrants[k];
      else if (v && typeof v === 'object') next.quadrants[k] = v;
    }
  }
  if (Array.isArray(s.calendars)) next.calendars = s.calendars.filter(c => c && (c.id || c.url)).slice(0, 10)
    .map(c => ({ type: c.url ? 'ical' : 'gcal', id: String(c.id || '').slice(0, 120), url: String(c.url || '').slice(0, 300), on: c.on !== false }));
  if (typeof s.calendarLookahead === 'string' && ['', 'week', '2weeks', '5days', '7days'].includes(s.calendarLookahead))
    next.calendarLookahead = s.calendarLookahead;
  if (s.newsSubtitles && typeof s.newsSubtitles === 'object') { // ✨ Describe regenerates the section blurbs
    next.newsSubtitles = {};
    for (const [k, v] of Object.entries(s.newsSubtitles))
      if (typeof v === 'string' && v.trim()) next.newsSubtitles[k] = v.trim().slice(0, 90);
  }
  if (typeof s.briefHook === 'string') next.briefHook = s.briefHook.trim().slice(0, 300); // '' = off
  if (Array.isArray(s.clearedLeads)) next.clearedLeads = s.clearedLeads.filter(x => typeof x === 'string').slice(-100);
  if (typeof s.locInputSync === 'boolean') next.locInputSync = s.locInputSync; // sticky "sync to calendar" default
  if (Array.isArray(s.links)) next.links = s.links.filter(l => l && typeof l.url === 'string' && l.url.trim())
    .slice(0, 50).map(l => ({ url: String(l.url).trim().slice(0, 300), label: String(l.label || '').slice(0, 40), icon: String(l.icon || '').slice(0, 8) }));
  if (s.headline && typeof s.headline === 'object') { // greeting override + date-format preset
    next.headline = {};
    if (typeof s.headline.greeting === 'string') next.headline.greeting = s.headline.greeting.trim().slice(0, 60);
    if (['weekday-long', 'weekday-short', 'numeric', 'iso'].includes(s.headline.dateFormat)) next.headline.dateFormat = s.headline.dateFormat;
  }
  saveSettings(next);
  res.json({ ok: true, settings: next });
}));

// ---------- calendar (today + week ahead; sources are GUI-configurable) ----------
// Minimal .ics parsing: unfold lines, take VEVENTs' DTSTART/DTEND/SUMMARY inside the window.
// (No RRULE expansion — subscribed feeds generally ship explicit instances.)
function parseIcs(text, timeMin, timeMax) {
  const out = [];
  for (const block of String(text).replace(/\r\n[ \t]/g, '').split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = k => { const m = body.match(new RegExp('^' + k + '[^:\\n]*:(.*)$', 'mi')); return m ? m[1].trim() : null; };
    const dt = v => {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(v || '');
      if (!m) return null;
      if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}` };
      const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)))
        : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      return { dateTime: d.toISOString() };
    };
    const start = dt(get('DTSTART')), end = dt(get('DTEND')) || start;
    if (!start) continue;
    const t = start.dateTime ? Date.parse(start.dateTime) : Date.parse(start.date + 'T12:00:00');
    if (t < timeMin.getTime() || t > timeMax.getTime()) continue;
    out.push({ summary: get('SUMMARY') || '(untitled)', start, end });
  }
  return out;
}
// Shared calendar fetch (source resolution + iCal/gcal merge) — used by /api/calendar and
// by the location-signal harvester, which needs the same raw events without an HTTP round-trip.
async function fetchCalendarEvents(daysAhead) {
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekEnd = new Date(now.getTime() + daysAhead * 24 * 3600 * 1000);
  const cfg = (loadSettings().calendars || []).filter(c => c.on !== false);
  const sources = cfg.length ? cfg : [{ type: 'gcal', id: CALENDAR_ID }];
  const events = [];
  const errors = [];
  await pmap(sources, async src => {
    try {
      if (src.type === 'ical' && src.url) {
        const r = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) throw new Error(`ical HTTP ${r.status}`);
        events.push(...parseIcs(await r.text(), timeMin, weekEnd).map(e => ({ ...e, source: src.url.slice(0, 40) })));
      } else {
        const r = await calendar.events.list({
          calendarId: src.id || CALENDAR_ID, timeMin: timeMin.toISOString(), timeMax: weekEnd.toISOString(),
          singleEvents: true, orderBy: 'startTime', maxResults: 50,
        });
        events.push(...(r.data.items || []));
      }
    } catch (e) { errors.push(`${src.id || src.url}: ${e.message}`); }
  }, 3);
  events.sort((a, b) => Date.parse(a.start?.dateTime || a.start?.date || 0) - Date.parse(b.start?.dateTime || b.start?.date || 0));
  return { events, errors };
}
app.get('/api/calendar', asyncRoute(async (req, res) => {
  // 14 days: the ⚙ look-ahead strip can show 2 weeks; the Week-ahead list still filters to 7
  const { events, errors } = await fetchCalendarEvents(14);
  track('calendar', events.length > 0 || !errors.length, errors.join(' | ') || `${events.length} events`);
  if (!events.length && errors.length) return res.json({
    error: errors.join(' | '),
    hint: `Share the calendar (Google Calendar → Settings → Share with specific people) with the service account email, or add an iCal URL via ⚙.`,
  });
  res.json({ events, errors: errors.length ? errors : undefined });
}));

// ---------- schedule a Today-box card onto the ACTUAL calendar (swipe right) ----------
// A swipe is the OWNER acting, not agent judgment — the dashboard executes it directly.
// Needs the calendar shared with the service account as "Make changes to events"; a
// read-only share turns into a clear hint instead of a raw 403.
let calTzCache = null;
async function calendarTz() {
  if (calTzCache) return calTzCache;
  try { calTzCache = (await calendar.calendars.get({ calendarId: CALENDAR_ID })).data.timeZone || 'UTC'; }
  catch (e) { calTzCache = 'UTC'; }
  return calTzCache;
}
app.post('/api/events/schedule', asyncRoute(async (req, res) => {
  const { title, date, time, venue, url, note, activity, searchBars } = req.body || {};
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'title + date (YYYY-MM-DD) required' });
  const body = {
    summary: String(title).slice(0, 200),
    location: String(venue || '').slice(0, 200) || undefined,
    description: [note, url, activity ? `(scanned: ${activity})` : ''].filter(Boolean).join('\n').slice(0, 1000) || undefined,
  };
  if (/^\d{2}:\d{2}$/.test(time || '')) {
    const tz = await calendarTz();
    const [H, M] = time.split(':').map(Number);
    const endMin = H * 60 + M + 120; // default 2h block
    const p2 = n => String(n).padStart(2, '0');
    body.start = { dateTime: `${date}T${time}:00`, timeZone: tz };
    body.end = endMin < 1440
      ? { dateTime: `${date}T${p2(Math.floor(endMin / 60))}:${p2(endMin % 60)}:00`, timeZone: tz }
      : { dateTime: `${addDays(date, 1)}T${p2(Math.floor(endMin / 60) - 24)}:${p2(endMin % 60)}:00`, timeZone: tz };
  } else {
    body.start = { date };
    body.end = { date: addDays(date, 1) }; // all-day end is exclusive
  }
  let ev;
  try { ev = (await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: body })).data; }
  catch (e) {
    const msg = /403|forbidden|writer|insufficient/i.test(String(e.message))
      ? 'Calendar write refused — share the calendar with the service account as "Make changes to events" (currently read-only), then retry.'
      : e.message;
    track('schedule', false, msg);
    return res.status(502).json({ error: msg });
  }
  track('schedule', true, `→ calendar: ${body.summary}`);
  // broadcast-sport cards: also hunt for LOCAL bars showing it (fire-and-forget; the
  // result surfaces as an AI-summaries card)
  if (searchBars) barSearchForEvent({ title, date, venue }).catch(e => track('bar-search', false, e.message));
  res.json({ ok: true, eventId: ev.id, htmlLink: ev.htmlLink || '' });
}));
// undo of a JUST-CREATED swipe event only (the client's undo stack calls this) — the
// dashboard never deletes pre-existing calendar entries.
app.delete('/api/events/schedule/:eventId', asyncRoute(async (req, res) => {
  try { await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: req.params.eventId }); }
  catch (e) { return res.status(502).json({ error: e.message }); }
  res.json({ ok: true });
}));
function locationOnDate(dateStr) {
  const b = loadLocationBars().find(b => b.start <= dateStr && dateStr <= b.end && b.location && b.location !== 'Location?');
  return b ? b.location : (typeof HOME_LOCATION !== 'undefined' ? HOME_LOCATION : '');
}
async function barSearchForEvent({ title, date, venue }) {
  const loc = locationOnDate(date) || 'the owner\'s city';
  let text = '', servedBy = 'grok';
  try {
    text = await providers.grokAgent(
      `Use x_search to find bars/pubs in ${loc} likely to SHOW this match live: "${title}" on ${date}${venue ? ` (${venue})` : ''}. ` +
      `Prefer recent X posts by/about sports bars in ${loc}. Return 2-4 concrete venues, one line each: name — neighborhood — why (what the post said). No metadata. If nothing found, say so in one line.`,
      { tools: ['x_search'] });
  } catch (e) {
    if (!HAS_CLAUDE) throw e;
    servedBy = 'claude';
    text = await runClaude(
      `Search the web for bars/pubs in ${loc} showing "${title}" live on ${date}. Return 2-4 concrete venues, one line each: name — neighborhood — why. Brief, no preamble.`,
      { tools: 'WebSearch,WebFetch', timeoutMs: 180000, module: 'activities' });
  }
  await appendTabRow(SUMM_TAB, SUMM_HEADERS_ALL,
    [`barsearch:${date}:${String(title).slice(0, 60)}`, `Where to watch: ${String(title).slice(0, 90)} (${loc})`, 'bar search', String(text).slice(0, 4000), nowIso(), '', servedBy]);
}

// ---------- market data (Yahoo Finance proxy, cached, user-configurable tiles) ----------
// Tiles are GUI-editable (add/remove/drag-reorder/resize) — config lives in
// data/markets-local.json (gitignored, runtime) synced cross-tier via Heartbeat!N1, same
// pattern as roles/credits. Sizes: 'ticker' (price only, ~10/row) | 'small' (spark, ~6/row)
// | 'large' (big plot, 2/row). Types: 'quote' (a symbol, historic plot over `range`) |
// 'strip' (futures term structure to max available distance) | 'ustcurve' (Treasury curve).
// Generic first-run tiles (indices/FX/vol only — nothing portfolio-flavored); every
// instance's real tiles live in markets-local.json + the synced envelope, so existing
// deployments never see these.
const DEFAULT_MARKET_TILES = [
  { id: 'spx', type: 'quote', sym: '^GSPC', label: 'S&P 500', fmt: 'int', size: 'small', range: '1y' },
  { id: 'ixic', type: 'quote', sym: '^IXIC', label: 'Nasdaq', fmt: 'int', size: 'small', range: '1y' },
  { id: 'stoxx', type: 'quote', sym: '^STOXX50E', label: 'EuroStoxx 50', fmt: 'int', size: 'small', range: '1y' },
  { id: 'vix', type: 'quote', sym: '^VIX', label: 'VIX', fmt: 'num', size: 'small', range: '1y' },
  { id: 'eurusd', type: 'quote', sym: 'EURUSD=X', label: 'EUR/USD', fmt: 'fx', size: 'small', range: '1y' },
  { id: 'gold', type: 'quote', sym: 'GC=F', label: 'Gold', fmt: 'int', size: 'small', range: '1y' },
];
const MARKETS_LOCAL = path.join(__dirname, 'data', 'markets-local.json');
const MARKETS_CELL = "'Heartbeat'!N1";
// The Sheet cell payload is a versioned envelope {savedAt, tiles} (bare arrays = legacy,
// savedAt 0). BUG FIX 2026-07-02: without the version stamp, three tiers all doing
// last-write-wins meant a stale instance (e.g. an old Cloud Run revision, or a tier that
// booted with an old baked-in config) could push its outdated snapshot to the Sheet and
// silently revert every other tier's config — this wiped real user tiles in production.
function parseTilesPayload(raw) {
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return { savedAt: 0, tiles: j };
    if (j && Array.isArray(j.tiles)) return { savedAt: j.savedAt || 0, tiles: j.tiles };
  } catch (e) {}
  return null;
}
function readTilesFile() {
  let raw;
  try { raw = fs.readFileSync(MARKETS_LOCAL, 'utf8'); }
  catch (e) { return null; } // no file yet — a genuinely fresh install, not corruption
  const parsed = parseTilesPayload(raw);
  if (!parsed) { console.error('markets-local.json exists but is unreadable — serving defaults, not the saved config'); markersFileCorrupt = true; }
  else markersFileCorrupt = false;
  return parsed;
}
let markersFileCorrupt = false; // readTilesFile() sets this; loadMarketTiles() can't return it without
// breaking every internal caller that expects a plain tiles array — GET /api/markets reads
// this flag separately so the GUI can attribute "showing defaults" to a real config failure.
function loadMarketTiles() {
  const f = readTilesFile();
  return f && f.tiles.length ? f.tiles : DEFAULT_MARKET_TILES;
}
function saveMarketTiles(tiles) {
  const payload = JSON.stringify({ savedAt: Date.now(), tiles });
  try { fs.writeFileSync(MARKETS_LOCAL, payload); } catch (e) {}
  bustMarketCache(); // so the next GET reflects the edit
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: MARKETS_CELL, valueInputOption: 'RAW', requestBody: { values: [[payload.slice(0, 49000)]] } }).catch(() => {});
}
async function syncMarketsFromSheet() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: MARKETS_CELL });
    const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
    const remote = parseTilesPayload(raw);
    if (!remote || !remote.tiles.length) return;
    const local = readTilesFile();
    if (local && remote.savedAt <= local.savedAt) return; // never regress to an older/equal snapshot
    fs.writeFileSync(MARKETS_LOCAL, raw);
    bustMarketCache(); // a config edit on another tier must invalidate THIS process's
    // in-memory quote cache too, or it serves stale data for up to 10 minutes.
  } catch (e) {}
}
syncMarketsFromSheet(); setInterval(syncMarketsFromSheet, 10 * 60000);
let marketCache = { at: 0, data: null };
// Generation counter closes a race: a GET that started building BEFORE a config edit would
// finish AFTER the bust and store its stale result back into the cache for 10 more minutes.
let marketCacheGen = 0;
function bustMarketCache() { marketCacheGen++; marketCache = { at: 0, data: null }; }

// x-axis ranges: max | 5y | 1y | 1mo | 1wk → Yahoo (range, interval) pairs
const RANGE_MAP = { max: ['max', '1mo'], '5y': ['5y', '1wk'], '1y': ['1y', '1wk'], '1mo': ['1mo', '1d'], '1wk': ['5d', '60m'] };
async function fetchYahoo(sym, range = '1y', withTs) {
  const [r0, iv] = RANGE_MAP[range] || RANGE_MAP['1y'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${r0}&interval=${iv}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`yahoo ${sym}: HTTP ${r.status}`);
  const j = await r.json();
  const result = j.chart?.result?.[0];
  if (!result) throw new Error(`yahoo ${sym}: empty result`);
  const meta = result.meta || {};
  const rawCloses = result.indicators?.quote?.[0]?.close || [];
  const closes = rawCloses.filter(v => v != null);
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose && closes.length > 1 ? closes[closes.length - 2] : null;
  const changePct = prev ? ((price - prev) / prev) * 100 : null;
  const out = { price, changePct, spark: closes };
  if (withTs) { // dated points, for grouped multi-series plots (one real time axis)
    const ts = result.timestamp || [];
    out.pts = rawCloses.map((v, i) => v != null && ts[i] != null ? { t: ts[i] * 1000, v } : null).filter(Boolean);
  }
  return out;
}

// last + previous daily close for one symbol (for futures-strip today/yesterday)
async function fetchLast2(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  if (!closes.length) return null;
  return { today: res.meta?.regularMarketPrice ?? closes[closes.length - 1], yday: closes.length > 1 ? closes[closes.length - 2] : null };
}

// Futures-strip presets: Yahoo monthly contract codes <ROOT><MONTHCODE><YY><suffix>.
// quarterly roots trade H/M/U/Z only (generating every month just wastes fetches on 404s).
// SOFR (SR3, CME 3-month SOFR futures — the LIBOR successor curve) quotes as 100 − rate, so
// invert=true turns the strip into an implied forward-rate curve in %.
// farYears: beyond `months` of monthly contracts, only December contracts trade liquidly —
// generate Dec-only out to farYears so oil/gas strips reach the true tradable horizon (~12y)
// without fetching 144 dead symbols.
const STRIP_PRESETS = {
  oil: { root: 'BZ', front: 'BZ=F', suffix: '.NYM', label: 'Brent ($/bbl)', months: 24, farYears: 12, cat: 'oil' },
  wti: { root: 'CL', front: 'CL=F', suffix: '.NYM', label: 'WTI ($/bbl)', months: 24, farYears: 12, cat: 'oil' },
  gas: { root: 'NG', front: 'NG=F', suffix: '.NYM', label: 'Henry Hub ($/MMBtu)', months: 24, farYears: 12, cat: 'gas' },
  gold: { root: 'GC', front: 'GC=F', suffix: '.CMX', label: 'Gold ($/oz)', months: 18, farYears: 6, cat: 'metal' },
  btc: { root: 'BTC', front: 'BTC=F', suffix: '.CME', label: 'Bitcoin ($)', months: 12, quarterly: true, cat: 'crypto' },
  sp: { root: 'ES', front: 'ES=F', suffix: '.CME', label: 'S&P 500 fut', months: 15, quarterly: true, cat: 'index' },
  nasdaq: { root: 'NQ', front: 'NQ=F', suffix: '.CME', label: 'Nasdaq fut', months: 15, quarterly: true, cat: 'index' },
  dow: { root: 'YM', front: 'YM=F', suffix: '.CBT', label: 'Dow fut', months: 15, quarterly: true, cat: 'index' },
  sofr: { root: 'SR3', front: 'SR3=F', suffix: '.CME', label: 'SOFR fwd % (LIBOR successor)', months: 48, quarterly: true, invert: true, cat: 'rates' },
  // virtual preset: the UST yield curve as a strip series (tenor → months) so it can be
  // grouped onto the same term axis as SOFR — both are yield-vs-term in %.
  ust: { label: 'UST yield (%)', cat: 'rates', virtual: 'ust' },
};
const UST_TENOR_MONTHS = { '1M': 1, '2M': 2, '3M': 3, '4M': 4, '6M': 6, '1Y': 12, '2Y': 24, '3Y': 36, '5Y': 60, '7Y': 84, '10Y': 120, '20Y': 240, '30Y': 360 };
// months-ahead of a contract label ('front' → 0, 'V26' → Oct 2026 minus now) — gives every
// strip point a true time coordinate so multi-curve plots share ONE x-axis and curves with
// shorter listings simply end early instead of being stretched to full width.
const MONTH_CODES = 'FGHJKMNQUVXZ';
function monthsAhead(label) {
  const mm = /^([FGHJKMNQUVXZ])(\d\d)$/.exec(String(label));
  if (!mm) return 0;
  const now = new Date();
  return (2000 + +mm[2] - now.getUTCFullYear()) * 12 + (MONTH_CODES.indexOf(mm[1]) - now.getUTCMonth());
}
// coarse category for grouping rules: max 2 categories per plot, first category = left axis
function symCat(sym) {
  const s = String(sym || '');
  if (/^(BZ|CL)=F$/.test(s)) return 'oil';
  if (/^NG=F$/.test(s)) return 'gas';
  if (/=F$/.test(s)) return 'commodity';
  if (/^\^/.test(s)) return 'index';
  if (/=X$/.test(s)) return 'fx';
  return 'stock';
}
// One contract's today / prior-day / prior-month closes in a single Yahoo call.
async function fetchContract(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  if (!closes.length) return null;
  return {
    today: res.meta?.regularMarketPrice ?? closes[closes.length - 1],
    yday: closes.length > 1 ? closes[closes.length - 2] : null,
    monthAgo: closes.length > 5 ? closes[0] : null, // ~21 trading days back
  };
}
const stripCacheByKey = {};
async function fetchStrip(presetKey) {
  const p = STRIP_PRESETS[presetKey];
  if (!p) throw new Error('unknown strip preset: ' + presetKey);
  const c = stripCacheByKey[presetKey];
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.pts;
  if (p.virtual === 'ust') { // UST yield curve rendered as a term strip (shared m-axis with SOFR)
    const y = await getYieldCurve();
    const prev = t => ((y.prevCurve || []).find(x => x.tenor === t) || {}).yield ?? null;
    const pts = (y.curve || []).filter(x => UST_TENOR_MONTHS[x.tenor] != null && x.yield != null)
      .map(x => ({ label: x.tenor, m: UST_TENOR_MONTHS[x.tenor], today: x.yield, yday: prev(x.tenor), monthAgo: null }));
    stripCacheByKey[presetKey] = { at: Date.now(), pts };
    return pts;
  }
  const near = fwdContracts(p.root, p.months, p.suffix, p.quarterly);
  const far = [];
  if (p.farYears) { // Dec-only contracts from just past the monthly window to the far horizon
    const y0 = new Date().getUTCFullYear();
    for (let y = y0 + Math.ceil(p.months / 12) + (new Date().getUTCMonth() === 11 ? 1 : 0); y <= y0 + p.farYears; y++) {
      far.push({ label: `Z${String(y).slice(2)}`, sym: `${p.root}Z${String(y).slice(2)}${p.suffix}` });
    }
  }
  const months = [...near, ...far.filter(f => !near.some(n => n.label === f.label))];
  const front = p.invert ? null : await fetchContract(p.front); // continuous front anchors non-rate strips
  const raw = await pmap(months, async (m) => { const v = await fetchContract(m.sym); return v ? { label: m.label, ...v } : null; }, 6);
  const inv = v => v == null ? null : 100 - v;
  let pts = [front ? { label: 'front', ...front } : null, ...raw].filter(Boolean);
  pts = pts.map(x => ({ ...x, m: monthsAhead(x.label) })); // true time coordinate (shared x-axis)
  if (p.invert) pts = pts.map(x => ({ ...x, today: inv(x.today), yday: inv(x.yday), monthAgo: inv(x.monthAgo) }));
  stripCacheByKey[presetKey] = { at: Date.now(), pts };
  return pts;
}
async function buildMarketTile(t) {
  try {
    if (t.type === 'meta') return t; // config carrier (e.g. hidden-CDS list), no data fetch
    if (t.type === 'strip') {
      // multi-series: tile.presets = ['oil','gas'] plots multiple curves (dual-axis in the UI);
      // legacy single tile.preset still supported.
      const keys = Array.isArray(t.presets) && t.presets.length ? t.presets : [t.preset].filter(Boolean);
      const series = await pmap(keys.filter(k => STRIP_PRESETS[k]), async k => ({
        key: k, label: STRIP_PRESETS[k].label, cat: STRIP_PRESETS[k].cat, invert: !!STRIP_PRESETS[k].invert, pts: await fetchStrip(k).catch(() => []),
      }), 2);
      return { ...t, presets: keys, series, stripLabel: series.map(s => s.label).join(' / ') };
    }
    if (t.type === 'ustcurve') { // reuse the Treasury endpoint's cache/fetcher
      const y = await getYieldCurve();
      return { ...t, curve: y };
    }
    if (t.type === 'cds') { // sovereign CDS — a real tile now (drag/resize/remove like anything else)
      const c = await getCdsRow(t.country);
      return { ...t, cds: c, label: t.label || `${t.country} CDS` };
    }
    if (t.type === 'group') { // drag-merged multi-series plot: dated points, one shared time axis
      const series = await pmap(t.items || [], async it => {
        if (it.kind === 'cds') {
          const c = await getCdsRow(it.country).catch(() => null);
          let pts = cdsHistoryDated(it.country);
          if (c && !c.error && pts.length < 3) { // fresh tier: synthesize 6m/1m anchors
            const now = Date.now();
            pts = [{ t: now - 182 * 86400000, v: c.cds5y / (1 + c.var6m / 100) }, { t: now - 30 * 86400000, v: c.cds5y / (1 + c.var1m / 100) }, { t: now, v: c.cds5y }];
          }
          return { label: it.label, cat: 'cds', pts, last: c && !c.error ? c.cds5y : null, unit: 'bp' };
        }
        const q = await fetchYahoo(it.sym, t.range || '1y', true).catch(() => null);
        return { label: it.label, cat: symCat(it.sym), pts: q ? q.pts : [], last: q ? q.price : null, ...(it.shares > 0 ? { shares: it.shares } : {}) };
      }, 3);
      return { ...t, series };
    }
    const q = await fetchYahoo(t.sym, t.range || '1y');
    return { ...t, ...q };
  } catch (e) { return { ...t, error: e.message }; }
}
app.get('/api/markets', asyncRoute(async (req, res) => {
  if (marketCache.data && Date.now() - marketCache.at < 10 * 60 * 1000) return res.json(marketCache.data);
  const gen = marketCacheGen;
  const tiles = loadMarketTiles();
  const out = await pmap(tiles, buildMarketTile, 6);
  // dual-currency: attach the USD value for tiles that ask for it (TTE €/$); the fx source
  // may itself not be a tile anymore, so fetch it directly if missing.
  for (const q of out) {
    if (q.dual && q.price != null) {
      let fx = out.find(x => x.sym === q.dual)?.price;
      if (!fx) { try { fx = (await fetchYahoo(q.dual, '1mo')).price; } catch (e) {} }
      if (fx) q.priceUsd = q.price * fx;
    }
  }
  // Portfolio: synthetic card summing every #shares holding — standalone quote tiles AND
  // series inside grouped plots (holdings survive a drag-merge). USD where known.
  const pfItems = out.filter(x => x.type === 'quote' && x.shares > 0 && x.price != null)
    .map(x => ({ label: x.label, shares: x.shares, value: (x.priceUsd ?? x.price) * x.shares }));
  for (const g of out.filter(x => x.type === 'group'))
    for (const s of g.series || []) if (s.shares > 0 && s.last != null) pfItems.push({ label: s.label, shares: s.shares, value: s.last * s.shares });
  if (pfItems.length) out.push({ id: '_portfolio', type: 'portfolio', label: 'Portfolio', size: 'small', items: pfItems, total: pfItems.reduce((a, b) => a + b.value, 0) });
  const okCount = out.filter(q => !q.error).length;
  track('markets', okCount > 0, `${okCount}/${out.length} tiles`);
  const data = { at: nowIso(), quotes: out };
  if (tiles === DEFAULT_MARKET_TILES && markersFileCorrupt) data.configError = 'saved market config unreadable — showing defaults';
  if (gen === marketCacheGen) marketCache = { at: Date.now(), data }; // don't overwrite a newer bust
  res.json(data);
}));
// Build one new tile object from a client-supplied spec — shared by single-add and batch-add.
function buildNewTile(tile) {
  const nt = { id: crypto.randomUUID().slice(0, 8), type: tile.type || 'quote', size: tile.size || 'small', range: tile.range || '1y' };
  for (const f of ['sym', 'label', 'fmt', 'preset', 'country']) if (tile[f]) nt[f] = String(tile[f]).slice(0, 60);
  if (Array.isArray(tile.presets)) nt.presets = tile.presets.map(String).filter(k => STRIP_PRESETS[k]).slice(0, 4);
  if (nt.type === 'quote') {
    nt.sym = String(nt.sym || '').toUpperCase(); nt.label = nt.label || nt.sym; nt.fmt = nt.fmt || 'stock';
    if (+tile.shares > 0 && symCat(nt.sym) === 'stock') nt.shares = +tile.shares; // holdings → Portfolio card
  }
  if (nt.type === 'strip') {
    if (!nt.presets && nt.preset) nt.presets = [nt.preset];
    nt.showYday = tile.showYday !== false; nt.showMonthAgo = !!tile.showMonthAgo;
    nt.label = nt.label || (nt.presets || []).map(k => (STRIP_PRESETS[k] || {}).label || k).join(' / ');
  }
  if (nt.type === 'ustcurve') nt.label = nt.label || 'UST yield curve';
  if (nt.type === 'cds') nt.label = nt.label || `${nt.country} CDS`;
  return nt;
}
function validNewTile(tile) {
  return tile && (tile.sym || tile.preset || tile.presets || tile.type === 'ustcurve' || (tile.type === 'cds' && tile.country));
}
// GUI edits: add (single or batch) / update (size, range, curves) / remove / reorder —
// persisted + cross-tier synced. CDS are now ordinary tiles (type:'cds'), so "remove" IS
// "hide" for them — no separate hidden-list mechanism needed any more.
// Serialized: each request does an unlocked read (syncMarketsFromSheet + loadMarketTiles),
// mutates in memory, then writes (saveMarketTiles). Two concurrent POSTs (double-click, two
// tabs/devices, agent + human) could otherwise both read before either writes, and the
// second write silently drops the first edit. A promise-chain queue serializes the whole
// read-modify-write per request instead of only guarding the final write.
let marketConfigQueue = Promise.resolve();
app.post('/api/markets/config', asyncRoute(async (req, res) => {
  const task = marketConfigQueue.catch(() => {}).then(() => runMarketConfig(req, res));
  marketConfigQueue = task;
  await task;
}));
async function runMarketConfig(req, res) {
  const { action, tile, tiles: batch, id, order } = req.body || {};
  await syncMarketsFromSheet(); // apply the edit on the newest cross-tier state, not a stale local copy
  let tiles = loadMarketTiles();
  if (action === 'add' && Array.isArray(batch)) {
    for (const t of batch) if (validNewTile(t)) tiles.push(buildNewTile(t));
  } else if (action === 'add' && validNewTile(tile)) {
    tiles.push(buildNewTile(tile));
  } else if (action === 'update' && id) {
    tiles = tiles.map(t => {
      if (t.id !== id) return t;
      const patch = ['size', 'range', 'label'].reduce((o, f) => (req.body[f] != null ? { ...o, [f]: req.body[f] } : o), {});
      if (Array.isArray(req.body.presets)) { // edit a strip's curve list
        patch.presets = req.body.presets.map(String).filter(k => STRIP_PRESETS[k]).slice(0, 4);
        if (patch.presets.length) patch.label = patch.presets.map(k => (STRIP_PRESETS[k] || {}).label || k).join(' / ');
      }
      for (const f of ['showYday', 'showMonthAgo']) if (typeof req.body[f] === 'boolean') patch[f] = req.body[f];
      if (req.body.shares != null) { const sh = +req.body.shares; if (sh > 0) patch.shares = sh; else { const { shares, ...rest } = { ...t, ...patch }; return rest; } }
      return { ...t, ...patch };
    });
  } else if (action === 'merge' && req.body.src && req.body.dst) {
    // drag a tile onto a large plot → merged multi-series plot; the dragged tile is consumed.
    // Rules: ≤4 series, ≤2 categories (oil+gas or oil+stocks, never all three).
    const src = tiles.find(t => t.id === req.body.src), dst = tiles.find(t => t.id === req.body.dst);
    if (!src || !dst || src.id === dst.id) return res.status(400).json({ error: 'bad merge' });
    const stripish = t => t.type === 'strip' || t.type === 'ustcurve'; // ustcurve joins as the virtual 'ust' preset
    if (stripish(src) && stripish(dst)) {
      const presetsOf = t => t.type === 'ustcurve' ? ['ust'] : (t.presets || [t.preset]);
      const uniq = [...new Set([...presetsOf(dst), ...presetsOf(src)].filter(k => STRIP_PRESETS[k]))];
      const cats = [...new Set(uniq.map(k => STRIP_PRESETS[k].cat))];
      if (uniq.length > 4) return res.status(400).json({ error: 'max 4 curves per plot' });
      if (cats.length > 2) return res.status(400).json({ error: 'max 2 categories per plot (' + cats.join(', ') + ')' });
      const merged = { id: dst.id, type: 'strip', size: dst.size || 'large', range: dst.range || '1y',
        showYday: dst.showYday !== false, showMonthAgo: !!dst.showMonthAgo,
        presets: uniq, label: uniq.map(k => STRIP_PRESETS[k].label).join(' / ') };
      tiles = tiles.filter(t => t.id !== src.id).map(t => t.id !== dst.id ? t : merged);
    } else if (['quote', 'cds', 'group'].includes(src.type) && ['quote', 'cds', 'group'].includes(dst.type)) {
      const itemsOf = t => t.type === 'group' ? (t.items || []) : [t.type === 'cds'
        ? { kind: 'cds', country: t.country, label: t.label || `${t.country} CDS` }
        : { kind: 'quote', sym: t.sym, label: t.label || t.sym, fmt: t.fmt, ...(t.shares > 0 ? { shares: t.shares } : {}) }];
      const items = [...itemsOf(dst), ...itemsOf(src)];
      const cats = [...new Set(items.map(i => i.kind === 'cds' ? 'cds' : symCat(i.sym)))];
      if (items.length > 4) return res.status(400).json({ error: 'max 4 series per plot' });
      if (cats.length > 2) return res.status(400).json({ error: 'max 2 categories per plot (' + cats.join(', ') + ')' });
      const g = { id: dst.type === 'group' ? dst.id : crypto.randomUUID().slice(0, 8), type: 'group', size: 'large',
        range: dst.range || '1y', items, label: items.map(i => i.label).join(' / ') };
      tiles = tiles.filter(t => t.id !== src.id).map(t => t.id === dst.id ? g : t);
    } else return res.status(400).json({ error: `can't group ${src.type} with ${dst.type}` });
  } else if (action === 'remove' && id) {
    tiles = tiles.filter(t => t.id !== id);
  } else if (action === 'reorder' && Array.isArray(order)) {
    const byId = new Map(tiles.map(t => [t.id, t]));
    const reordered = order.map(x => byId.get(x)).filter(Boolean);
    for (const t of tiles) if (!order.includes(t.id)) reordered.push(t); // never silently drop
    tiles = reordered;
  } else return res.status(400).json({ error: 'bad action' });
  saveMarketTiles(tiles);
  res.json({ ok: true, tiles });
}
// Free-text tile resolution ("oil future strip", "10y bund", …) → agent maps to a tile config.
// Mac/VM inline; cloud queues via the RPC bridge like reparse/media-find.
async function doMarketResolve({ text, tiles }) {
  const current = (Array.isArray(tiles) ? tiles : loadMarketTiles()).map(t =>
    ({ id: t.id, label: t.label, type: t.type, sym: t.sym, presets: t.presets, country: t.country, size: t.size, range: t.range }));
  const raw = await runClaude(
    `You manage a market-dashboard tile grid. Request: "${String(text).slice(0, 200)}"\n` +
    `Current tiles: ${JSON.stringify(current).slice(0, 3000)}\n` +
    `If the request MODIFIES an existing tile (change its date range, size, curves, label, share count — e.g. "gold plot 5 years", "make VIX large", "I hold 140 TTE shares"), return {"update":{"id":"<tile id>", <changed fields only: "range":"max|5y|1y|1mo|1wk", "size":"ticker|small|large", "label":"...", "shares":<number, 0 clears>, "presets":[...strip curve keys]}}.\n` +
    `Otherwise ADD one tile: (a) futures term-structure strip — {"tile":{"type":"strip","preset":<one of ${Object.keys(STRIP_PRESETS).join('|')}>}}; ` +
    `(b) US Treasury yield curve — {"tile":{"type":"ustcurve"}}; ` +
    `(c) sovereign CDS — {"tile":{"type":"cds","country":"<English country name>"}}; ` +
    `(d) anything with a real Yahoo Finance symbol — {"tile":{"type":"quote","sym":"<YAHOO SYMBOL>","label":"<short label>","fmt":"stock|int|num|fx","range":"max|5y|1y|1mo|1wk"}}.\n` +
    `Use REAL Yahoo symbols (indices ^GSPC/^IXIC/^DJI/^VIX, futures like BZ=F, fx like EURUSD=X). If genuinely unresolvable return {"error":"why"}.\n` +
    `Return STRICT JSON only.`,
    { timeoutMs: 60000, module: 'market-resolve', model: 'claude-haiku-4-5-20251001' });
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || ['{}'])[0];
  let r = null; try { r = JSON.parse(block); } catch (e) {}
  if (r && r.update && r.update.id) return { update: r.update };
  const tile = r && r.tile ? r.tile : r; // tolerate a bare tile object from the model
  if (!tile || tile.error || !(tile.sym || tile.preset || tile.presets || tile.type === 'ustcurve' || (tile.type === 'cds' && tile.country)))
    throw new Error((r && r.error) || (tile && tile.error) || 'could not resolve that to a tile');
  return { tile };
}
app.post('/api/markets/resolve', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (HAS_LLM) { try { return res.json(await doMarketResolve({ text })); } catch (e) { return res.status(502).json({ error: e.message }); } }
  if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'No LLM configured — set ANTHROPIC_API_KEY (or install the claude CLI)' });
  const id = await enqueueRpc('market_resolve', { text });
  res.json({ queued: true, id });
}));

// ---------- news (Google News RSS per preference query) ----------
// Implements MASTERPROMPT sections 1-4 with real search output. Section 5
// (tracking/look-ahead) needs an LLM pass — skipped per the prompt's own rule
// ("if prompt requests something you are not capable of, ignore it").

const STOPWORDS = new Set(('report any the and or of for in on to from with a an by new past hours days ' +
  'including specifically query scan high ranked posts tagged summarize updates concerning expected coming ' +
  'which could impact today tomorrow top story stories news sources government military x local').split(' '));
function keywords(text, n) {
  const out = [];
  for (const w of String(text || '').split(/[^A-Za-z0-9'-]+/)) {
    const lw = w.toLowerCase();
    if (w.length > 2 && !STOPWORDS.has(lw) && !out.some(o => o.toLowerCase() === lw)) out.push(w);
    if (out.length >= n) break;
  }
  return out.join(' ');
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&apos;/g, "'");
}

async function rssSearch(query, max) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return rssFetch(url, max);
}
async function rssTopic(topic, max) {
  const url = `https://news.google.com/rss/headlines/section/topic/${topic}?hl=en-US&gl=US&ceid=US:en`;
  return rssFetch(url, max);
}
async function rssFetch(url, max) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g)) {
      const block = m[1] || m[2];
      const pick = tag => decodeEntities((block.match(new RegExp(`<${tag}[^>]*>(?:\\s*<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>\\s*)?<\\/${tag}>`)) || [])[1] || '').trim();
      let title = pick('title');
      const source = pick('source');
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      const pub = pick('pubDate') || pick('published') || pick('updated');
      const ageH = pub && !isNaN(new Date(pub)) ? Math.max(0, Math.round((Date.now() - new Date(pub)) / 3600000)) : null;
      const link = pick('link') || (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      // RSS standfirst/summary (strip any HTML) — used as a fallback summary for
      // paywalled feeds (e.g. The Economist) the speed-reader can't fetch in full.
      const desc = (pick('description') || pick('summary') || pick('content:encoded') || '').replace(/<[^>]+>/g, ' ').replace(/\]\]>/g, '').replace(/\s+/g, ' ').trim();
      const author = (pick('dc:creator') || pick('creator') || pick('author') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      items.push({ title, link, source, desc, author, ageHours: ageH, age: ageH == null ? '' : ageH < 24 ? ageH + 'h' : Math.round(ageH / 24) + 'd' });
      if (items.length >= max) break;
    }
    return items;
  } catch (e) { return []; } finally { clearTimeout(timer); }
}

// Google News RSS links are opaque redirects claude can't fetch directly. Decode
// to the real article URL via Google's batchexecute endpoint so the speed-reader
// reads the actual article (and distinct articles get distinct URLs — no dup
// summaries). Best-effort: returns the original URL on any failure.
async function resolveArticleUrl(url) {
  if (!/^https?:\/\/news\.google\.com\/rss\/articles\//.test(url || '')) return url;
  try {
    const artId = url.split('/articles/')[1].split('?')[0];
    const r = await fetch('https://news.google.com/rss/articles/' + artId, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const sig = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    const id = (html.match(/data-n-a-id="([^"]+)"/) || [])[1] || artId;
    if (!sig || !ts) return url;
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`;
    const freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(freq) });
    const text = await res.text();
    const real = JSON.parse(JSON.parse(text.split('\n\n')[1]).slice(0, -2)[0][2])[1];
    return /^https?:/.test(real) ? real : url;
  } catch (e) { return url; }
}

// JS-rendering reader (Jina r.jina.ai): fetches ANY url, runs the page's JavaScript
// in a headless browser, and returns clean article text — getting past the JS-only
// rendering + bot-protection that blocks claude's WebFetch and plain fetch. Needs
// JINA_API_KEY (free tier) for reliable access; returns null on any failure so
// callers fall back gracefully. Reusable for the brief, future agents, etc.
const JINA_KEY = process.env.JINA_API_KEY || '';
async function readArticle(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch('https://r.jina.ai/' + url, {
      signal: ctl.signal,
      headers: {
        ...(JINA_KEY ? { Authorization: 'Bearer ' + JINA_KEY } : {}),
        'X-Return-Format': 'text',
        'X-Timeout': '20',
      },
    });
    if (!r.ok) return null;
    const text = (await r.text()).trim();
    return text.length > 200 ? text : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// Economist subscriber full-text: fetch the page with the owner's session cookie (stored
// in ~/.config/dashboard/economist-cookie, gitignored, NEVER in chat) and pull the article
// body. The cookie file only lives on the Mac tier, so this returns null elsewhere — summaries
// run on the Mac anyway. Re-export the cookie when Economist summaries start coming back thin.
const ECON_COOKIE_FILE = process.env.ECON_COOKIE_FILE || path.join(os.homedir(), '.config', 'dashboard', 'economist-cookie');
let econCookieCache = { at: 0, val: null };
function economistCookie() {
  if (Date.now() - econCookieCache.at < 60000) return econCookieCache.val;
  let val = null;
  try { const t = fs.readFileSync(ECON_COOKIE_FILE, 'utf8').trim(); if (t) val = t; } catch (e) {}
  econCookieCache = { at: Date.now(), val };
  return val;
}
// Economist sits behind Cloudflare, so a plain cookie'd fetch gets a 403 JS-challenge page.
// Route through the jina reader instead: it renders in a real browser (clears Cloudflare) and
// forwards the owner's session cookie via X-Set-Cookie so the render is authenticated (subscriber
// full text). Returns null if the cookie is missing/partial and only the free preview comes back.
async function fetchSubscriberText(url) {
  if (!/economist\.com\//i.test(url || '')) return null;
  const cookie = economistCookie();
  if (!cookie) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 35000);
  try {
    const r = await fetch('https://r.jina.ai/' + url, { signal: ctl.signal, headers: {
      ...(JINA_KEY ? { Authorization: 'Bearer ' + JINA_KEY } : {}),
      'X-Return-Format': 'text', 'X-Timeout': '30', 'X-Set-Cookie': cookie,
    } });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    // Reject the free preview: its bulk is nav chrome with only ~1 real paragraph. A genuine
    // subscriber read has many long prose lines. Require several, else fall through to standfirst.
    const proseParas = t.split('\n').filter(l => l.trim().length > 200).length;
    if (proseParas < 4) return null;
    if (/subscribe to continue|to continue reading|register to (?:read|continue)/i.test(t)) return null;
    return t;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// Paywalled-feed fallback: pull the RSS standfirst for a URL from its source's feed
// (e.g. The Economist — full text is paywalled, but the feed's one-line summary is free).
async function feedStandfirst(url, source) {
  try {
    const feeds = loadNewsFeeds();
    const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(feeds).find(k => { const a = n(k), b = n(source); const sh = a.length < b.length ? a : b; return sh.length >= 5 && (a === b || a.includes(b) || b.includes(a)); });
    if (!key) return null;
    const items = await rssFetch(feeds[key].url, 60);
    const hit = items.find(it => it.link === url) || items.find(it => it.link && url && (it.link.includes(url) || url.includes(it.link)));
    if (!hit || !hit.desc || hit.desc.length <= 20) return null;
    // Cap it: some feeds (e.g. LessWrong) put the FULL post in desc — a standfirst is a blurb,
    // not a 35KB wall. Take the first ~450 chars, trimmed to a word boundary.
    let sf = hit.desc.trim();
    if (sf.length > 450) sf = sf.slice(0, 450).replace(/\s+\S*$/, '') + '…';
    return sf;
  } catch (e) { return null; }
}

// limited-concurrency map
async function pmap(items, fn, limit) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function prefRows(tab) {
  // pref tabs: prompt row, then header row, then data
  if (!Array.isArray(tab) || tab.length < 2) return [];
  let hi = 0;
  for (let i = 0; i < Math.min(tab.length, 4); i++) { if ((tab[i] || []).length >= 2) { hi = i; break; } }
  return tab.slice(hi + 1).filter(r => (r || []).some(c => String(c).trim()));
}

// "Google Alert" semantics: a search only contributes items when the headline
// itself names the tracked thing (or enough of its keywords) — otherwise it's
// noise and is dropped. Sections are flat headline lists; the tracked names are
// returned in `highlight` for the frontend to color inside headlines.
// unicode-aware word boundary (\b breaks on accented names like Müller)
const titleHas = (title, phrase) =>
  new RegExp('(?<![\\p{L}\\p{N}])' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu').test(title);
function dedupe(items, seen) {
  return items.filter(it => {
    const k = it.link || it.title;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// Favorite-source feeds — editable in data/news-feeds.json (name → {url, top, windowH, scan})
const NEWS_FEEDS_FILE = path.join(__dirname, 'data', 'news-feeds.json');
const DEFAULT_NEWS_FEEDS = {
  'The Economist': { url: 'https://www.economist.com/latest/rss.xml', top: 2, windowH: 48, scan: true },
  'Al Jazeera': { url: 'https://www.aljazeera.com/xml/rss/all.xml', top: 1, windowH: 24 },
  'LessWrong': { url: 'https://www.lesswrong.com/feed.xml', top: 2, windowH: 168 },
  'Works in Progress': { url: 'https://www.worksinprogress.news/feed', all: true, windowH: 336 },
  'Karpathy Substack': { url: 'https://karpathy.substack.com/feed', top: 5, windowH: 336 },
};
function loadNewsConfig() {
  try { return JSON.parse(fs.readFileSync(NEWS_FEEDS_FILE, 'utf8')); } catch (e) {}
  try { fs.mkdirSync(path.dirname(NEWS_FEEDS_FILE), { recursive: true }); fs.writeFileSync(NEWS_FEEDS_FILE, JSON.stringify(DEFAULT_NEWS_FEEDS, null, 1)); } catch (e) {}
  return DEFAULT_NEWS_FEEDS;
}
function loadNewsFeeds() {
  const cfg = loadNewsConfig();
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith('_')));
}

// "Following" — recent writing BY the people tracked in the PEOPLE pref tab, from
// three sources by column: Tweets(1)→X, Substack(3)→Substack, Movie/Video/TV(7)→YouTube.
// MODEL POLICY: grok is reserved for its PROPRIETARY X access (x_search only). Substack is
// discovered with the cheapest qualified model (Claude Haiku + WebSearch, subscription-
// included), and YouTube uses free per-channel RSS. The HAS_CLAUDE tiers (Mac/VM) build the
// feed and write it to a Sheet cell; the stateless cloud tier just reads that cell — so grok
// and Claude never run on Cloud Run and Following is identical on every tier.
const FOLLOWING_CELL = "'Heartbeat'!H1";
const YT_FEED_CACHE = path.join(__dirname, 'data', 'youtube-feeds.json'); // name → channel RSS url
let followingCache = { at: 0, items: [] };
let followingBusy = false;
async function peopleRows() {
  try { const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'PEOPLE'!A1:H` }); return prefRows(r.data.values || []); }
  catch (e) { return []; }
}
// tolerant name matcher — TOLERATE the sheet's spelling drift (Lacun→LeCun, Amadei→Amodei…)
// by matching on any shared name token ≥4 chars.
function makeOnList(names) {
  const toks = s => new Set(String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4));
  const tracked = names.map(toks);
  return name => { const t = toks(name); return t.size && tracked.some(ts => [...t].some(w => ts.has(w))); };
}
// X posts — grok's proprietary x_search ONLY (no web_search)
async function buildXFollowing(ppl) {
  if (!process.env.XAI_API_KEY) return [];
  const xPeople = ppl.filter(r => String(r[1] || '').trim() === '1').map(r => r[0]).filter(Boolean);
  if (!xPeople.length) return [];
  const providers = require('./providers');
  const prompt = `Use x_search to find the MOST RECENT genuine X posts (last 4 days) BY the EXACT people listed — ONLY these people, resolve their real @handle, do NOT include posts ABOUT them, never fabricate, omit anyone with nothing recent.\nPEOPLE: ${xPeople.join('; ')}\nReturn STRICT JSON ONLY: {"items":[{"person":"<exact name>","title":"post text (<200 chars)","url":"https://x.com/...","date":"YYYY-MM-DD"}]} — max 2 per person, real URLs only.`;
  let raw;
  try { raw = await providers.grokAgent(prompt, { tools: ['x_search'] }); } catch (e) { console.error('following/grok-x:', e.message); return []; }
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
  let items = []; try { items = JSON.parse(block).items || []; } catch (e) { return []; }
  const onList = makeOnList(xPeople);
  return items.filter(it => it && it.url && /^https?:\/\//.test(it.url) && it.title && onList(it.person)).slice(0, 10)
    .map(it => ({ title: String(it.title).slice(0, 220), link: it.url, source: `${it.person} · X`, desc: '', section: 'Following', age: it.date || '', following: true }));
}
// Substack — grok is X-only, so discover via the cheapest qualified model (Claude Haiku +
// WebSearch). HAS_CLAUDE only; the cloud tier gets it from the Sheet cache.
async function buildSubstackFollowing(ppl) {
  if (!HAS_CLAUDE) return [];
  const subPeople = ppl.filter(r => String(r[3] || '').trim() === '1').map(r => r[0]).filter(Boolean);
  if (!subPeople.length) return [];
  const prompt = `Use WebSearch to find the MOST RECENT (last 21 days) Substack or blog posts written BY these EXACT people — only them, not posts about them: ${subPeople.join('; ')}.\nUse ONLY real URLs that appear in your search results; never invent a URL; omit anyone with nothing recent.\nReturn STRICT JSON ONLY: {"items":[{"person":"<exact name>","title":"article title","url":"https://real-url","date":"YYYY-MM-DD"}]} — max 2 per person.`;
  let raw;
  try { raw = await runClaude(prompt, { tools: 'WebSearch', timeoutMs: 120000, module: 'following-substack', model: 'claude-haiku-4-5-20251001' }); } catch (e) { console.error('following/substack:', e.message); return []; }
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
  let items = []; try { items = JSON.parse(block).items || []; } catch (e) { return []; }
  const onList = makeOnList(subPeople);
  return items.filter(it => it && it.url && /^https?:\/\//.test(it.url) && it.title && onList(it.person)).slice(0, 8)
    .map(it => ({ title: String(it.title).slice(0, 220), link: it.url, source: `${it.person} · Substack`, desc: '', section: 'Following', age: it.date || '', following: true }));
}
// YouTube — a followed channel (PEOPLE row with the Movie/Video/TV Series flag) surfaces its
// recent uploads via YouTube's free per-channel RSS. Resolve name → channel_id once (cached).
async function resolveYouTubeChannel(name) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(YT_FEED_CACHE, 'utf8')); } catch (e) {}
  if (cache[name]) return cache[name];
  const save = feed => { cache[name] = feed; try { fs.writeFileSync(YT_FEED_CACHE, JSON.stringify(cache)); } catch (e) {} return feed; };
  const direct = (name.match(/UC[\w-]{20,}/) || [])[0]; // sheet may already hold a channel id
  if (direct) return save(`https://www.youtube.com/feeds/videos.xml?channel_id=${direct}`);
  const handle = name.replace(/^@/, '').replace(/\s+/g, '');
  for (const u of [`https://www.youtube.com/@${handle}`, `https://www.youtube.com/c/${handle}`, `https://www.youtube.com/user/${handle}`]) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const html = await r.text();
      // use the page's OWN channel id (canonical/og:url/externalId all agree) — NOT the first
      // loose "channelId" match, which is a recommended video's channel, not this page's.
      const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})"/)
        || html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})"/)
        || html.match(/"externalId":"(UC[\w-]{20,})"/);
      if (m) return save(`https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`);
    } catch (e) {}
  }
  return null; // couldn't resolve; retried next build (cheap, hourly)
}
async function buildYouTubeFollowing(ppl) {
  const ytPeople = ppl.filter(r => String(r[7] || '').trim() === '1').map(r => r[0]).filter(Boolean); // Movie/Video/TV Series col
  if (!ytPeople.length) return [];
  const out = [];
  for (const name of ytPeople) {
    const feed = await resolveYouTubeChannel(name);
    if (!feed) continue;
    const vids = await rssFetch(feed, 3);
    for (const v of vids) {
      if (v.ageHours != null && v.ageHours > 21 * 24) continue; // last ~3 weeks
      out.push({ title: v.title, link: v.link, source: `${name} · YouTube`, desc: '', section: 'Following', age: v.age, ageHours: v.ageHours, following: true });
    }
  }
  return out.slice(0, 12);
}
async function buildFollowing() {
  const ppl = await peopleRows();
  if (!ppl.length) return [];
  const [x, sub, yt] = await Promise.all([
    buildXFollowing(ppl).catch(() => []),
    buildSubstackFollowing(ppl).catch(() => []),
    buildYouTubeFollowing(ppl).catch(() => []),
  ]);
  return [...x, ...sub, ...yt];
}
// cross-tier cache in a Sheet cell so the cloud tier reads what the Mac/VM built
async function readFollowingCell() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: FOLLOWING_CELL });
    const obj = JSON.parse((((r.data.values || [[]])[0] || [])[0]) || '{}');
    return { at: obj.at || 0, items: obj.items || [] };
  } catch (e) { return { at: 0, items: [] }; }
}
async function getFollowing() {
  const FRESH = 60 * 60 * 1000;
  if (followingCache.items.length && Date.now() - followingCache.at < FRESH) return followingCache.items;
  const cell = await readFollowingCell();               // pull whatever the Mac/VM last built
  if (cell.items.length && cell.at > followingCache.at) followingCache = { at: cell.at, items: cell.items };
  if (HAS_CLAUDE && Date.now() - followingCache.at > FRESH && !followingBusy) { // only Mac/VM rebuild
    followingBusy = true;
    buildFollowing().then(items => {
      if (items && items.length) {
        followingCache = { at: Date.now(), items };
        store.values.update({ spreadsheetId: TODO_SHEET_ID, range: FOLLOWING_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify({ at: Date.now(), items }).slice(0, 49000)]] } }).catch(() => {});
      }
    }).catch(() => {}).finally(() => { followingBusy = false; });
  }
  return followingCache.items;
}
// Append the Following section (so it appears without waiting for the 30-min news rebuild).
async function withFollowing(data) {
  const items = await getFollowing();
  if (!items.length) return data;
  logArticles(items).catch(() => {});
  return { ...data, sections: [...(data.sections || []), { title: 'Following', items }] };
}

let newsCache = { at: 0, data: null };
async function buildNews() {
  if (newsCache.data && Date.now() - newsCache.at < 30 * 60 * 1000) return newsCache.data;
  const prefs = {};
  for (const tab of ['TOPOFMIND', 'SUBJECTS', 'PEOPLE', 'LOCATIONS', 'SOURCES']) {
    const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` }).catch(() => null);
    prefs[tab] = r ? r.data.values || [] : [];
  }
  // STOP terms: too generic to be useful search/match terms — they pull junk
  // ("Bonestone Chest Locations", "Trump Oil Reserve Price"). Never search/score on these.
  const STOP_TERMS = /^(locations?|local|oil prices?|news|today|update)$/i;
  const subjects = prefRows(prefs.SUBJECTS).map(r => ({ name: r[0], filter: r[2] || '' }))
    .filter(s => s.name && !STOP_TERMS.test(s.name.trim()));
  // dead authors: near-zero NEWS weight (won't publish random news) but kept for Publications.
  const DEAD = /vonnegut|bradbury|roald dahl|asimov|hitchens|feynman/i;
  const people = prefRows(prefs.PEOPLE).filter(r => String(r[2] || '').trim() === '1')
    .map(r => ({ name: r[0], category: r[3] || '', dead: DEAD.test(r[0]) || /deceased|historical/i.test((r[4]||'') + (r[5]||'')) }));
  const locations = prefRows(prefs.LOCATIONS).map(r => r[0]).filter(l => l && !STOP_TERMS.test(String(l).trim()) && !/prompt:/i.test(l));
  const prefSources = [...prefRows(prefs.SOURCES).map(r => r[0]), ...Object.keys(loadNewsFeeds())].filter(Boolean);

  const highlight = [...new Set([
    ...subjects.map(s => s.name), ...people.map(p => p.name), ...locations,
    ...people.map(p => p.name.split(/\s+/).pop()).filter(w => w.length > 3),
  ])].filter(n => /^[A-Z]/.test(String(n || '')) && String(n).length > 2);

  // ---- gather candidates from all query angles ----
  const seen = new Set();
  const all = [];
  const add = items => { for (const it of dedupe(items, seen)) all.push(it); };

  const subjRes = await pmap(subjects, s => rssSearch(`"${s.name}" ${keywords(s.filter, 4)} when:3d`, 4), 5);
  subjRes.forEach((items, i) => add(items.filter(it => titleHas(it.title, subjects[i].name) ||
    keywords(subjects[i].name + ' ' + subjects[i].filter, 6).split(' ').filter(k => titleHas(it.title, k)).length >= 2)));
  const [world, biz, tech] = await Promise.all([rssTopic('WORLD', 3), rssTopic('BUSINESS', 3), rssTopic('TECHNOLOGY', 3)]);
  add([...world, ...biz, ...tech]);
  // TOPOFMIND standing queries (Iran conflict, breaking, local) — high base salience
  const tomRows = prefRows(prefs.TOPOFMIND).filter(r => r[0] && r[0] !== 'REMINDERS' && !STOP_TERMS.test(String(r[0]).trim()));
  const tomRes = await pmap(tomRows, r => rssSearch(`${keywords(r[0] + ' ' + (r[1]||''), 6)} when:2d`, 4), 5);
  tomRes.forEach((items, i) => items.forEach(it => { it.tom = tomRows[i][0]; }));
  add(tomRes.flat());
  // favorite feeds (Economist/AJ/LW/WiP/Karpathy): top items + tracked-name matches
  const feedRes = await pmap(Object.entries(loadNewsFeeds()), async ([name, f]) => {
    let items = (await rssFetch(f.url, 60)).filter(it => it.ageHours == null || it.ageHours <= (f.windowH || 168));
    items.forEach(it => { it.source = name; it.feed = true; });
    // SOURCE MODE: "all" (weekly periodicals → surface EVERYTHING) | "topics" (only matching topics) | default (top N).
    // all/topics/top items are forced so they survive the salience cut (was silently dropping WorksInProgress).
    const force = it => { it.forced = true; it.preferred = true; };
    if (f.all) { items.forEach(it => { force(it); it.srcRule = 'all'; }); return items.slice(0, 14); }
    if (Array.isArray(f.topics) && f.topics.length) {
      const hits = items.filter(it => f.topics.some(t => titleHas(it.title, t) || (it.desc || '').toLowerCase().includes(String(t).toLowerCase())));
      hits.forEach(it => { force(it); it.srcRule = 'topic'; });
      return hits.slice(0, 10);
    }
    const top = items.slice(0, f.top || 2); top.forEach(it => { force(it); it.srcRule = 'top'; });
    return [...top, ...items.slice(f.top || 2).filter(it => highlight.some(n => titleHas(it.title, n))).slice(0, 4)];
  }, 4);
  add(feedRes.flat());
  // HARD RULE ("do what the owner does manually") — the SOURCES pref tab:
  //   All=1  → surface EVERY recent story from that source (forced, bypasses salience)
  //   else   → surface its top N ("Top stories (#)", default 3)
  // Match a configured feed URL by name; otherwise rss-search the source by name.
  const feeds = loadNewsFeeds();
  // strict match: whole normalized name containment, min 6 chars — avoids "al" ⊂
  // "totALenergies" → Al Jazeera false positives. No token splitting.
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const feedKey = name => { const b = norm(name);
    return Object.keys(feeds).find(k => { const a = norm(k); const sh = a.length < b.length ? a : b;
      return sh.length >= 6 && (a === b || a.includes(b) || b.includes(a)); }); };
  const srcRows = prefRows(prefs.SOURCES); // [Source, Trial, Top stories(#), All, Category, Filter]
  const forcedRes = await pmap(srcRows, async r => {
    const name = String(r[0] || '').trim(); if (!name || /^source$/i.test(name)) return [];
    const all = String(r[3] || '').trim() === '1';
    const topN = parseInt(r[2] || '', 10) || (all ? 0 : 3);
    const filt = r[5] || '';
    const k = feedKey(name);
    let items;
    if (k) items = (await rssFetch(feeds[k].url, 40)).map(it => ({ ...it, source: name }));
    else if (name.startsWith('@')) return []; // X/Twitter handle — no usable RSS; skip (handled via PEOPLE/grok)
    else {
      const q = name.replace(/\b(press releases?|podcast|substack|newsletter|blog)\b/gi, '').trim();
      items = (await rssSearch(`"${q}" ${keywords(filt, 3)} when:3d`, all ? 12 : Math.max(topN, 3))).map(it => ({ ...it, source: name }));
    }
    // drop non-news a "top N by name" search drags in (NYT games, horoscopes, recipes)
    const JUNK = /\b(strands|wordle|connections|pips|spelling bee|crossword|sudoku|mini|horoscope|recipe|hints?,?\s*answers|puzzle)\b/i;
    items = items.filter(it => !JUNK.test(it.title));
    if (filt && filt.trim() && !/anything|new/i.test(filt)) {
      const fk = keywords(filt, 4).split(' ').filter(Boolean);
      const filtered = items.filter(it => fk.some(w => titleHas(it.title, w)));
      if (filtered.length) items = filtered;
    }
    const picked = all ? items.filter(it => (it.ageHours ?? 0) <= 48).slice(0, 12) : items.slice(0, topN);
    picked.forEach(it => { it.forced = true; it.preferred = true; it.srcRule = all ? 'all' : 'top'; });
    return picked;
  }, 4);
  add(forcedRes.flat());
  // living people → publication candidates; dead people → only their own-feed posts (none) so skipped for news
  const livePeople = people.filter(p => !p.dead);
  const pplRes = await pmap(livePeople, p => rssSearch(`"${p.name}" ${keywords(p.category, 2)} when:14d`, 2), 6);
  pplRes.forEach((items, i) => { items.forEach(it => { it.person = livePeople[i].name; }); add(items.filter(it => titleHas(it.title, livePeople[i].name))); });

  // ---- score salience + classify ----
  const SOT = { anthropic: 'https://www.anthropic.com/news', openai: 'https://openai.com/news', google: 'https://blog.google',
    microsoft: 'https://news.microsoft.com/source', totalenergies: 'https://totalenergies.com/news', spacex: 'https://www.spacex.com/updates',
    nvidia: 'https://nvidianews.nvidia.com', deepmind: 'https://deepmind.google/discover/blog' };
  const PUB_VERBS = /\b(publishes?|published|releases?|released|announces?|launch(es|ed)?|new book|new paper|out now|debuts?)\b/i;
  // Section 2 (long-format deep dives): essay / longform sources
  const DEEPDIVE_SRC = /lesswrong|works in progress|karpathy|noahpinion|stratechery|new yorker|the atlantic|\batlantic\b|aeon|quanta|asterisk|wait but why|astral codex/i;
  // Section 3 (books & film, extra-long): culture pieces
  const BOOKFILM = /\b(novel|memoir|new book|book review|short story|film festival|new film|new movie|box office|biopic|documentary|movie review|screen adaptation|best films|best books)\b/i;
  // Owner-specified tiering (hard-coded 2026-06-15): T1 Economist · T2 AJ+mainstream ·
  // T3 Asia Times (wildcard) + X posters · T4 the rest. Used to ORDER the News section.
  const sourceTier = it => {
    const s = (it.source || '').toLowerCase();
    if (/economist/.test(s)) return 1; // capped to top 4 below; overflow → T4
    if (/jazeera|nyt|new york times|reuters|associated press|\bap\b|\bbbc\b|guardian|fox news|washington post|wapo|\bnpr\b|politico|the hill|\bcnn\b|cnbc|bloomberg|al jazeera/.test(s)) return 2;
    if (/asia times/.test(s) || it.tweet || /^@/.test(String(it.source || ''))) return 3;
    return 4;
  };

  // map AI product names to the tracked entity so e.g. "Fable/Mythos" → Anthropic
  const ALIAS = { Anthropic: /\b(anthropic|claude|fable|mythos)\b/i, OpenAI: /\b(openai|chatgpt|gpt-?\d)\b/i,
    Google: /\b(google|gemini|deepmind)\b/i, Microsoft: /\b(microsoft|copilot|azure ai)\b/i, 'Frontier AI models': /\b(frontier|llm|foundation model)\b/i };
  for (const it of all) {
    let score = 0; const why = [];
    for (const s of subjects) if (titleHas(it.title, s.name) || (ALIAS[s.name] && ALIAS[s.name].test(it.title))) { score += 3; why.push(s.name); }
    if (it.tom) { score += 3; why.push(it.tom); } // TOPOFMIND standing interest
    for (const l of locations) if (titleHas(it.title, l)) { score += 1; why.push(l); }
    for (const p of people) if (titleHas(it.title, p.name)) { score += (p.dead ? 0.2 : 2.5); why.push(p.name); it.person = p.name; it.personDead = p.dead; }
    if (prefSources.some(src => titleHas(String(it.source||''), src.split(/[ /]/)[0]) || (it.source||'').toLowerCase().includes(src.toLowerCase().split(' ')[0]))) { score += 1.5; it.preferred = true; }
    const ah = it.ageHours ?? 24;
    // time decay: <12h full, 12-24h ×0.6, 24-48h ×0.3, >48h ×0.1 (drops out of News).
    // tweets (X/Grok) decay exponentially with a 6h half-life — freshness is everything.
    const decay = it.tweet ? Math.exp(-ah / 8.66)
      : ah <= 12 ? 1 : ah <= 24 ? 0.6 : ah <= 48 ? 0.3 : 0.1;
    score *= decay;
    // forced (SOURCES hard rule): floor salience so it survives the cut without
    // crowding out the genuinely-top ranked items.
    if (it.forced) { score = Math.max(score, 2); if (!why.length) why.push(it.source); }
    it.fresh = ah <= 12;
    it.salience = score; it.why = [...new Set(why)].slice(0, 3);
    // classify into 3 sections: News / Deep dives / Books & Film
    const isLongform = DEEPDIVE_SRC.test(it.source || '') || (it.person && PUB_VERBS.test(it.title)) || (it.feed && /substack|lesswrong|works in progress/i.test(it.source || ''));
    if (BOOKFILM.test(it.title)) it.section = 'Books & Film';
    else if (isLongform) it.section = 'Deep dives';
    else it.section = 'News';
  }

  // expiry windows: News 48h, Deep dives 96h, Books & Film 14d (extra-long)
  const blockedSrcs = (loadNewsConfig()._blocked_sources || []).map(s => s.toLowerCase());
  const keep = it => !blockedSrcs.some(b => (it.source || '').toLowerCase().includes(b)) &&
    (it.forced || it.salience > 0.3) && (it.section === 'News' ? (it.ageHours ?? 0) <= 48
    : it.section === 'Deep dives' ? (it.ageHours ?? 0) <= 96 : (it.ageHours ?? 0) <= 24 * 14);
  const kept = all.filter(keep).sort((a, b) => b.salience - a.salience);

  const sectionsObj = { 'News': [], 'Deep dives': [], 'Books & Film': [] };
  for (const it of kept) (sectionsObj[it.section] || sectionsObj['News']).push(it);
  // TIER the News section per the tiering spec: T1 = top 4 Economist, then T2/T3/T4 by source;
  // within a tier, by salience. (Rest of Economist drops to T4.)
  const econ = sectionsObj['News'].filter(i => /economist/i.test(i.source || '')).sort((a, b) => b.salience - a.salience);
  econ.forEach((it, idx) => { it.tier = idx < 4 ? 1 : 4; });
  sectionsObj['News'].forEach(it => { if (it.tier == null) it.tier = sourceTier(it); });
  sectionsObj['News'].sort((a, b) => a.tier - b.tier || b.salience - a.salience);
  const sections = ['News', 'Deep dives', 'Books & Film'].map(t => ({ title: t, items: sectionsObj[t].slice(0, t === 'News' ? 22 : 10) })).filter(s => s.items.length);

  // Top of mind is intentionally EMPTY — it focuses the reader on the day's
  // main tasks, not news. Left blank until he decides what goes here.
  const promoted = [];

  const data = { at: nowIso(), sections, promoted, highlight };
  track('news', sections.length > 0, `${sections.length} sections, ${kept.length} items`);
  newsCache = { at: Date.now(), data };
  logArticles(sections.flatMap(s => s.items)).catch(() => {}); // corpus for the taste model (Title+standfirst → embedded by the VM batch)
  return data;
}

// "Cleared today" gate: once the owner has swiped through the day's news, only breaking / very-salient
// NEW stories (a fresh forced/all-source lead, or salience above the bar) + new X surface until the
// next morning. The cleared marker lives in a Sheet cell so it's cross-instance (phone + Mac).
let clearedCache = { at: 0, val: '' };
async function getNewsClearedAt() {
  if (Date.now() - clearedCache.at < 60000) return clearedCache.val;
  let val = '';
  try { const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!G1" }); val = (((r.data.values || [[]])[0] || [])[0]) || ''; } catch (e) {}
  clearedCache = { at: Date.now(), val };
  return val;
}
async function setNewsClearedAt(iso) {
  clearedCache = { at: Date.now(), val: iso };
  try { await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!G1", valueInputOption: 'RAW', requestBody: { values: [[iso]] } }); } catch (e) {}
}
async function gateClearedNews(data) {
  const clearedAt = await getNewsClearedAt();
  const cd = clearedAt ? new Date(clearedAt) : null;
  if (!cd || isNaN(cd) || cd.toDateString() !== new Date().toDateString()) return data; // only same-day
  const hoursSince = (Date.now() - cd.getTime()) / 3600000;
  const keep = it => it.following                                   // new X posts always come through
    || ((it.ageHours == null || it.ageHours <= hoursSince + 0.5)   // published since the clear
        && (it.forced || (it.salience || 0) >= 0.55));             // a fresh lead OR breaking-salient
  const sections = (data.sections || []).map(s => ({ ...s, items: (s.items || []).filter(keep) })).filter(s => (s.items || []).length);
  return { ...data, sections, clearedAt };
}

// blank-canvas guard: with zero SOURCES + SUBJECTS configured there is nothing to build —
// skip the whole pipeline and hand the client a setup hint instead (5-min memo).
let newsCfgMemo = { at: 0, empty: false };
async function newsConfigured() {
  if (Date.now() - newsCfgMemo.at < 300000) return !newsCfgMemo.empty;
  try {
    const [s, j] = await Promise.all([loadEditablePref('SOURCES'), loadEditablePref('SUBJECTS')]);
    newsCfgMemo = { at: Date.now(), empty: !s.rows.length && !j.rows.length };
  } catch (e) { newsCfgMemo = { at: Date.now(), empty: false }; } // unreadable prefs ≠ unconfigured
  return !newsCfgMemo.empty;
}
app.get('/api/news', asyncRoute(async (req, res) => {
  if (!(await newsConfigured())) {
    const base = await withPluginNews({ at: nowIso(), sections: [], hint: 'Nothing configured yet — use ✨ Describe above to tell the agent what news you want, or ✎ the Sources/Subjects lists directly.' });
    return res.json(base);
  }
  // Model Watch (APA's news-worthy output) folds in here — read-only consumption of the APA Feed.
  const data = await withPluginNews(await withModelWatch(await withFollowing(await withDismissals(await buildNews()))));
  res.json(await gateClearedNews(data));
}));
app.post('/api/news/cleared', asyncRoute(async (req, res) => { await setNewsClearedAt(nowIso()); res.json({ ok: true }); }));
app.post('/api/news/uncleared', asyncRoute(async (req, res) => { await setNewsClearedAt(''); res.json({ ok: true }); }));
// Following is grok-built and often not ready on a cold cache, so /api/news returns
// without it. The frontend polls this endpoint and slots the section in when it lands —
// no more "reload twice to see Following". building=true means grok is still fetching.
app.get('/api/following', asyncRoute(async (req, res) => {
  const items = await getFollowing();
  // "building" = the cloud tier is still waiting on the Mac/VM to populate the Sheet cache,
  // or a HAS_CLAUDE tier is mid-rebuild. Either way the frontend keeps polling.
  res.json({ items, building: !items.length, at: followingCache.at || 0 });
}));
// Verify the Economist subscriber cookie loads and pulls full text. Never returns the cookie.
app.get('/api/economist/test', asyncRoute(async (req, res) => {
  const url = String(req.query.url || '').trim();
  const hasCookie = !!economistCookie();
  if (!url) return res.json({ hasCookie, cookieFile: ECON_COOKIE_FILE, hint: 'pass ?url=<economist.com article> to test extraction' });
  const text = await fetchSubscriberText(url);
  res.json({ hasCookie, ok: !!text, chars: text ? text.length : 0, sample: text ? text.slice(0, 240) : null });
}));

// Reusable clean-text reader for any URL (resolves Google News links first).
app.get('/api/read', asyncRoute(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  const real = await resolveArticleUrl(String(url));
  const text = await readArticle(real);
  if (!text) return res.status(502).json({ error: 'could not read', url: real, hasKey: !!JINA_KEY });
  res.json({ url: real, chars: text.length, text });
}));

// ---------- story actions: queue to read / agent summarize / not interested ----------

// Queue a story into the Media tab as a high-priority read (sorts to the top).
app.post('/api/queue-story', asyncRoute(async (req, res) => {
  const { title, url, source } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const { headers, headerRow, rows } = await readMediaTab();
  const rowObj = {
    Title: title, Source: source || '', Type: 'read', URL: url || '', Length_min: '',
    Priority: 'high', Status: 'queued', Added: today(), Added_by: 'dashboard',
    Notes: 'queued from news', ID: crypto.randomUUID(),
  };
  const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID,
    range: `'${MEDIA_TAB}'!A${lastRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '')] },
  });
  res.json({ ok: true, id: rowObj.ID });
}));

// Append a row to the Media (watch/reading) tab. Returns the created id.
async function addMediaRow({ title, url, source, type, notes }) {
  const { headers, headerRow, rows } = await readMediaTab();
  const rowObj = {
    Title: title, Source: source || '', Type: type || 'read', URL: url || '', Length_min: '',
    Priority: 'normal', Status: 'queued', Added: today(), Added_by: 'dashboard',
    Notes: notes || 'added manually', ID: crypto.randomUUID(),
  };
  const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${MEDIA_TAB}'!A${lastRow + 1}`, valueInputOption: 'RAW',
    requestBody: { values: [headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '')] },
  });
  return rowObj.ID;
}
function hostLabel(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
// Resolve a pasted URL's title/source; YouTube via oEmbed, else the page <title>.
async function resolveLinkMeta(url) {
  const isYt = /(?:youtube\.com|youtu\.be)\//i.test(url);
  if (isYt) {
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
      if (r.ok) { const j = await r.json(); return { title: j.title || url, source: j.author_name || 'YouTube', type: 'video' }; }
    } catch (e) {}
    return { title: url, source: 'YouTube', type: 'video' };
  }
  let title = '';
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }).finally(() => clearTimeout(timer));
    if (r.ok) { const h = await r.text(); const m = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (m) title = m[1].replace(/\s+/g, ' ').trim().slice(0, 200); }
  } catch (e) {}
  return { title: title || url, source: hostLabel(url), type: /\b(video|watch|vimeo)\b/i.test(url) ? 'video' : 'read' };
}
// free text → let Sonnet find the best real link, then add it to the watch list
async function doMediaFind({ input }) {
  input = String(input || '').trim();
  const raw = await runClaude(
    `The user wants to save something to their watch/reading list but gave search terms, not a link: "${input}".\n` +
    `WebSearch and return the single BEST real, working link. If it's clearly a video/talk/interview/lecture, return the best YouTube video; otherwise the most authoritative article or page. Verify the URL is real — do NOT fabricate.\n` +
    `Return STRICT JSON only, no prose: {"title":"...","url":"https://...","source":"publisher or channel","type":"watch|read"}`,
    { tools: 'WebSearch', timeoutMs: 120000, module: 'media-add', model: 'claude-sonnet-5' });
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
  let found = null; try { found = JSON.parse(block); } catch (e) {}
  if (!found || !found.url || !/^https?:\/\//.test(found.url)) throw new Error('couldn\'t find a good link for that — try rephrasing or paste a URL');
  const type = found.type === 'watch' || found.type === 'video' || /(?:youtube\.com|youtu\.be)\//i.test(found.url) ? 'video' : 'read';
  const item = { title: found.title || input, url: found.url, source: found.source || hostLabel(found.url), type };
  const id = await addMediaRow({ ...item, notes: `added: found for "${input}"` });
  return { ok: true, item, id, query: input };
}
// Add to the watch list from either a pasted URL or free-text search terms (Sonnet finds the link).
app.post('/api/media/add', asyncRoute(async (req, res) => {
  const input = String((req.body && req.body.input) || '').trim();
  if (!input) return res.status(400).json({ error: 'nothing to add' });
  const urlMatch = input.match(/https?:\/\/\S+/);
  if (urlMatch) {
    // a pasted link needs no claude — resolve + add inline on any tier
    const url = urlMatch[0].replace(/[)\].,]+$/, '');
    const meta = await resolveLinkMeta(url);
    const id = await addMediaRow({ ...meta, url, notes: 'added: pasted link' });
    return res.json({ ok: true, item: { ...meta, url }, id });
  }
  // free text: Mac/VM run inline; Cloud Run queues it for the drainer
  if (HAS_CLAUDE) { try { return res.json(await doMediaFind({ input })); } catch (e) { return res.status(502).json({ error: e.message }); } }
  if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'Link finding needs the claude CLI (web search); paste a URL instead' });
  const id = await enqueueRpc('media_find', { input });
  res.json({ queued: true, id });
}));

// Feedback log — append-only JSONL the CI agent reads to hypothesize misses
// (subject too broad? source low-signal? same-name collision?) and re-weight.
const FEEDBACK_FILE = CFG.feedbackFile || path.join(__dirname, 'data', 'feedback.jsonl');
// signal: numeric weight for the CI learner. left/discard = -1 (downweight),
// right/agent-read = +1 (upweight), pin/read-myself = +2 (strong upweight),
// stash = +2. subjects/why = the matched features so CI can credit-assign per
// subject/source/person rather than just per-story.
const SIGNAL_BY_KIND = {
  not_interested: -1, summary_discarded: -1, brief_down: -1,
  agent_read: 1, brief_up: 1,
  pinned: 2, summary_stashed: 2,
  clicked: 3, // actually opened the article to read it
  followup_asked: 3, // asked the agent for more detail — strong engagement + reveals which detail he wanted
  summary_to_reading: 4, // explicitly curated an AI summary into the reading list — strongest interest signal
  event_up: 2, event_down: -1, // Today-card thumbs
  event_scheduled: 4, // swiped an event onto the ACTUAL calendar — strongest event signal
  event_skipped: -0.5, // swipe left = "just not scheduled" — barely negative by design
};
app.post('/api/feedback', asyncRoute(async (req, res) => {
  const { kind, title, url, source, context, subjects, person, author } = req.body || {};
  if (!kind) return res.status(400).json({ error: 'kind required' });
  const entry = {
    at: nowIso(), kind, signal: SIGNAL_BY_KIND[kind] ?? 0,
    title: title || '', source: source || '', url: url || '',
    subjects: Array.isArray(subjects) ? subjects : [], person: person || '', author: author || '',
    context: context || '',
  };
  const line = JSON.stringify(entry);
  if (HAS_JOURNAL) {
    fs.appendFileSync(FEEDBACK_FILE, line + '\n'); // Mac: CI reads this directly
  } else {
    await appendTabRow(FB_TAB, FB_HEADERS, [line, nowIso(), '']); // cloud: durable; Mac drains
  }
  // swipe-left → also persist to the durable dismissal store so the story is
  // filtered out of every future render/rebuild (any instance). url OR title is enough.
  if (kind === 'not_interested' && (url || title)) {
    await appendTabRow(DISMISS_TAB, DISMISS_HEADERS, [url || '', title || '', nowIso()]).catch(() => {});
    dismissedCache.at = 0; // take effect immediately
  }
  res.json({ ok: true });
}));

// ---------- habits / reminders ----------
// Durable across instances: user-added habits live in the Sheet (cloud writes survive
// the ephemeral container). Pref-defined reminders (REMINDERS tab) render alongside and
// are stoppable too (stop = the row is removed from the REMINDERS tab).
// Freq: '' (legacy: Recurring=1 → daily, else one-off Date) | 'daily' | 'weekly:<0-6>'
// | 'monthly:<1-31>' | 'custom:<json>' where json is one of
//   {"dow":[0-6,...]} | {"dom":[1-31,...]} | {"interval":{"days":N,"anchor":"YYYY-MM-DD"}}
// Track: '' | 'checkbox' (default — ✓ logs true) | 'number' | 'string' | 'untracked'.
const HABITS_TAB = 'Habits';
const HABITS_HEADERS = ['Text', 'Recurring', 'Date', 'Created', 'ID', 'Stopped', 'Freq', 'Track', 'Hidden'];
function freqShowsToday(freq) {
  const f = String(freq || '').trim();
  if (!f || f === 'daily') return true;
  const d = new Date();
  if (f.startsWith('weekly:')) return d.getDay() === (parseInt(f.slice(7), 10) || 0);
  if (f.startsWith('monthly:')) return d.getDate() === (parseInt(f.slice(8), 10) || 1);
  if (f.startsWith('custom:')) {
    try {
      const rule = JSON.parse(f.slice(7));
      if (Array.isArray(rule.dow)) return rule.dow.includes(d.getDay());
      if (Array.isArray(rule.dom)) return rule.dom.includes(d.getDate());
      if (rule.interval && rule.interval.days > 0) {
        const anchor = Date.parse(rule.interval.anchor || '');
        if (!isNaN(anchor)) {
          const days = Math.round((Date.parse(today()) - anchor) / 86400000);
          return days >= 0 && days % rule.interval.days === 0;
        }
      }
    } catch (e) {}
    return true; // unparseable rule: show rather than silently hide
  }
  return true;
}
app.get('/api/habits', asyncRoute(async (req, res) => {
  const out = [];
  // Each source tracks its own success — an empty result because BOTH sources genuinely
  // errored looks identical to "no habits today" unless we say so. Silently showing "All
  // done for today 🎉" on a Sheets outage was a real bug (gui-review 2026-07-07).
  let prefOk = true, userOk = true;
  // pref reminders: DATES == 'All' (daily) or contains current month+year
  try {
    const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'REMINDERS'!A1:B` });
    const rows = (r.data.values || []).slice(2); // prompt row + header row
    const mo = new Date().toLocaleDateString('en-US', { month: 'long' }), yr = String(new Date().getFullYear());
    for (const row of rows) {
      const text = String(row[0] || '').trim(); const dates = String(row[1] || '').trim();
      if (!text) continue;
      if (dates.toLowerCase() === 'all' || (dates.includes(mo) && dates.includes(yr)))
        out.push({ id: 'pref:' + text, text, recurring: dates.toLowerCase() === 'all', source: 'pref', freq: 'daily', track: 'checkbox', hidden: false });
    }
  } catch (e) { prefOk = false; }
  // user habits from the Sheet
  try {
    const tab = await readTab(TODO_SHEET_ID, HABITS_TAB, HABITS_HEADERS);
    for (const row of tab.rows) {
      if (String(row.Stopped || '').trim()) continue;
      const freq = String(row.Freq || '').trim();
      const recurring = String(row.Recurring || '').trim() === '1';
      const show = freq ? freqShowsToday(freq) : (recurring || row.Date === today());
      if (!show) continue;
      out.push({
        id: row.ID, text: row.Text, recurring: recurring || (!!freq && freq !== 'once'), source: 'user',
        freq: freq || (recurring ? 'daily' : ''), track: String(row.Track || '').trim() || 'checkbox',
        hidden: String(row.Hidden || '').trim() === '1',
      });
    }
  } catch (e) { userOk = false; }
  const body = { habits: out };
  if (!prefOk && !userOk) body.error = 'both habit sources unreachable'; // NOT genuinely zero habits — say so
  res.json(body);
}));
app.post('/api/habits', asyncRoute(async (req, res) => {
  const { text, recurring, date, freq, track, hidden } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const id = crypto.randomUUID();
  const f = String(freq || '').trim();
  const isRecurring = f ? true : !!recurring;
  await appendTabRow(HABITS_TAB, HABITS_HEADERS,
    [text, isRecurring ? '1' : '', isRecurring ? '' : (date || tomorrow()), nowIso(), id, '',
     f, String(track || '').trim(), hidden ? '1' : '']);
  res.json({ ok: true, id });
}));
// generic per-habit edit (hide/unhide, retitle, reschedule, retrack) by ID
app.post('/api/habits/update', asyncRoute(async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const tab = await readTab(TODO_SHEET_ID, HABITS_TAB, HABITS_HEADERS).catch(() => null);
  const row = tab && tab.rows.find(r => r.ID === id);
  if (!row) return res.status(404).json({ error: 'habit not found' });
  const ALLOWED = { text: 'Text', freq: 'Freq', track: 'Track', hidden: 'Hidden' };
  const data = [];
  for (const [k, col] of Object.entries(ALLOWED)) {
    if (!(k in req.body)) continue;
    const idx = tab.headers.indexOf(col);
    if (idx === -1) continue;
    const v = k === 'hidden' ? (req.body[k] ? '1' : '') : String(req.body[k] ?? '');
    data.push({ range: `'${HABITS_TAB}'!${colLetter(idx)}${row._row}`, values: [[v]] });
  }
  if (data.length) await store.values.batchUpdate({
    spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data },
  });
  res.json({ ok: true });
}));
// habit slug for the daily note's frontmatter block ("TOML" section): meditate → meditate,
// "Neck & grip exercizes" → neck_grip_exercizes
function habitSlug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'habit';
}
// Upsert `key: value` inside today's note's frontmatter (the --- block up top). Skipped when
// the note is live in Obsidian (no whole-file rewrite of an open buffer) — caller falls back
// to the append-only Stashed-notes line.
function upsertTodayFrontmatter(key, value) {
  if (!HAS_JOURNAL) return false;
  const notePath = path.join(JOURNAL_DIR, today() + '.md');
  try {
    if (!fs.existsSync(notePath)) {
      try { fs.writeFileSync(notePath, dailyNoteSkeleton(), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (noteOpenInObsidian(notePath)) return false;
    const txt = fs.readFileSync(notePath, 'utf8');
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(txt);
    if (!m) return false;
    const line = `${key}: ${value}`;
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*$`, 'm');
    const inner = re.test(m[1]) ? m[1].replace(re, line) : m[1].replace(/\s*$/, '') + '\n' + line;
    fs.writeFileSync(notePath, '---\n' + inner + '\n---' + txt.slice(m.index + m[0].length));
    return true;
  } catch (e) { console.error('frontmatter upsert failed:', e.message); return false; }
}
app.post('/api/habits/log', asyncRoute(async (req, res) => {
  const { text, value } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const v = (value === undefined || value === null || String(value).trim() === '') ? 'yes' : String(value).trim();
  // tracked value lands in today's frontmatter (Mac); fallback = append-only stash line
  if (upsertTodayFrontmatter(habitSlug(text), v === 'yes' ? 'true' : v))
    return res.json({ ok: true, where: 'journal' });
  const where = await stashAnywhere(`- [Habit] ${text} — ${v} (${today()})`, { kind: 'note' });
  res.json({ ok: true, where });
}));
// LLM: free-text schedule ("every other Tuesday") → evaluable custom rule
async function resolveHabitFreq({ text }) {
  const prompt =
    `Convert this habit-schedule description into a JSON rule. Today is ${today()} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}).\n` +
    `DESCRIPTION: ${String(text || '').slice(0, 200)}\n` +
    `Return STRICT JSON only, no prose: {"rule": R, "desc": "<short human summary>"} where R is ONE of:\n` +
    `{"dow":[0-6 ints, 0=Sunday]} — weekdays · {"dom":[1-31 ints]} — days of month · {"interval":{"days":N,"anchor":"YYYY-MM-DD"}} — every N days from anchor.\n` +
    `Examples: "every tuesday and thursday" → {"rule":{"dow":[2,4]},"desc":"Tue & Thu"} · "1st and 15th" → {"rule":{"dom":[1,15]},"desc":"1st & 15th"} · "every other day" → {"rule":{"interval":{"days":2,"anchor":"${today()}"}},"desc":"every 2 days"}`;
  const raw = await runClaude(prompt, { timeoutMs: 60000, module: 'habit-freq' });
  const block = (String(raw).match(/\{[\s\S]*\}/) || [])[0];
  let j = null; try { j = JSON.parse(block); } catch (e) {}
  if (!j || !j.rule) throw new Error('could not parse that schedule');
  return { freq: 'custom:' + JSON.stringify(j.rule), desc: j.desc || text };
}
app.post('/api/habits/resolve-freq', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (HAS_LLM) { try { return res.json(await resolveHabitFreq({ text })); } catch (e) { return res.status(500).json({ error: e.message }); } }
  if (STORE_MODE !== 'sheets') return res.status(400).json({ error: 'No LLM configured — set ANTHROPIC_API_KEY (or install the claude CLI)' });
  const id = await enqueueRpc('habit_freq', { text });
  res.json({ queued: true, id });
}));
app.post('/api/habits/stop', asyncRoute(async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  // pref reminders (REMINDERS tab, no Sheet row of their own): stop = drop the pref row
  if (String(id).startsWith('pref:')) {
    const text = String(id).slice(5);
    const { header, rows, dataStartRow, oldCount } = await loadEditablePref('REMINDERS');
    const keep = rows.filter(r => String(r[0] || '').trim() !== text);
    if (keep.length === rows.length) return res.status(404).json({ error: 'reminder not found' });
    const clearRows = Math.max(oldCount, keep.length) + 20;
    await store.values.clear({ spreadsheetId: PREFS_SHEET_ID, range: `'REMINDERS'!A${dataStartRow}:Z${dataStartRow + clearRows}` });
    if (keep.length) await store.values.update({
      spreadsheetId: PREFS_SHEET_ID, range: `'REMINDERS'!A${dataStartRow}`, valueInputOption: 'RAW',
      requestBody: { values: keep.map(r => { const a = r.map(c => String(c ?? '')); while (a.length < header.length) a.push(''); return a.slice(0, header.length); }) },
    });
    prefsCache = { at: 0, data: null };
    return res.json({ ok: true });
  }
  const tab = await readTab(TODO_SHEET_ID, HABITS_TAB, HABITS_HEADERS).catch(() => null);
  const row = tab && tab.rows.find(r => r.ID === id);
  if (!row) return res.status(404).json({ error: 'habit not found' });
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${HABITS_TAB}'!${colLetter(tab.headers.indexOf('Stopped'))}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [[nowIso()]] },
  });
  res.json({ ok: true });
}));

// ---------- activities of personal interest (agent-scanned events → look-ahead) ----------
// ACTIVITIES pref rows describe what to hunt for (local events, sports fixtures, ticket
// on-sales) and how; a periodic agent scan (WebSearch) writes concrete dated events to the
// 'Activity Events' tab (durable, cross-instance, deduped). The look-ahead strip renders
// them beside calendar events; rows with a lead window surface early as a "Coming up" line.
const ACTEV_TAB = 'Activity Events';
const ACTEV_HEADERS = ['Activity', 'Date', 'Title', 'Time', 'Venue', 'URL', 'Note', 'FoundAt', 'ID'];
const ACTEV_HEADERS_ALL = [...ACTEV_HEADERS, 'ScanLoc'];
let actCfgMemo = { at: 0, val: [] };
async function loadActivitiesConfig() {
  if (Date.now() - actCfgMemo.at < 300000) return actCfgMemo.val;
  try {
    const { rows } = await loadEditablePref('ACTIVITIES');
    actCfgMemo = { at: Date.now(), val: rows.map(r => ({
      activity: (r[0] || '').trim(), instructions: (r[1] || '').trim(),
      leadDays: parseInt(r[2], 10) || 0, show: (r[3] || 'all').trim() || 'all',
    })).filter(a => a.activity) };
  } catch (e) { actCfgMemo = { at: Date.now(), val: [] }; }
  return actCfgMemo.val;
}
let actScanBusy = false;
async function scanActivities() {
  if (actScanBusy || !HAS_CLAUDE || process.env.DASHBOARD_NO_JOBS) return;
  actScanBusy = true;
  try {
    const acts = await loadActivitiesConfig();
    if (!acts.length) return;
    let existing;
    try { existing = (await readTab(TODO_SHEET_ID, ACTEV_TAB, ACTEV_HEADERS)).rows; }
    catch (e) { track('activities', false, 'existing-read failed — pass aborted (dedup would be blind): ' + e.message.slice(0, 80)); return; }
    const key = (act, d, t) => act + '|' + d + '|' + String(t).toLowerCase().slice(0, 60);
    const seen = new Set(existing.map(r => key(r.Activity, r.Date, r.Title)));
    // SEMANTIC dedup: exact-title matching let the same match in 5 phrasings pile up.
    // Token-overlap against same-activity same-date entries kills rewordings.
    const STOP = new Set(['vs', 'v', 'the', 'and', 'at', 'of', 'round', 'rd', 'match', 'live']);
    const toks = t => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
    const nearDupe = (A, B) => {
      const a = new Set(A), b = new Set(B); let n = 0;
      for (const x of a) if (b.has(x)) n++;
      return n / Math.max(1, Math.min(a.size, b.size)) >= 0.7;
    };
    const tokIdx = {}; // activity|date → [token arrays]
    for (const r of existing) (tokIdx[r.Activity + '|' + r.Date] = tokIdx[r.Activity + '|' + r.Date] || []).push(toks(r.Title));
    const projLoc = projectedLocationLine(21);
    for (const a of acts) {
      try {
        const known = existing.filter(r => r.Activity === a.activity && r.Date >= today())
          .slice(0, 40).map(r => `${r.Date} ${r.Title}`).join('\n');
        const raw = await runClaude(
          `Today is ${today()} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}); assume the user's local timezone for event times.\n` +
          (projLoc ? `The owner's PROJECTED LOCATION over the coming weeks: ${projLoc}. If the activity's instructions imply a specific city (e.g. "this weekend in town", a home city) but the owner will be somewhere ELSE on the target date per this projection, search for that date's ACTUAL location instead — the instructions describe the KIND of thing to look for, not necessarily a fixed city.\n` : '') +
          `You scan the web for events matching a personal interest.\nINTEREST: "${a.activity}"\nINSTRUCTIONS: ${a.instructions}\n` +
          `Use WebSearch/WebFetch. Find CONCRETE, DATED events in the NEXT 21 DAYS. Only real events with a source — NEVER invent; an empty list is a fine answer.\n` +
          `NEVER return a physical event in a city the owner will NOT be in on that date (per the projection above). Location-independent events (TV/streamed broadcasts, online) are fine anywhere — mark them "local": false.\n` +
          (known ? `ALREADY KNOWN (do NOT return these again, even reworded — only genuinely NEW events):\n${known}\n` : '') +
          `At most 8 new events. ONE entry per real-world event — use a canonical title (e.g. "Australia v France — Nations Championship R2"), never multiple phrasings.\n` +
          `For TELEVISED matches/tournaments, "note" MUST name the TV channel or streamer carrying it${projLoc ? " in the owner's projected location on that date (per the projection above)" : ''} — e.g. "beIN Sports 1 (QA)", "Canal+ (FR)"; fall back to the primary international broadcaster if the local carrier is unclear.\n` +
          `Return STRICT JSON only, no prose, no code fences: {"events":[{"date":"YYYY-MM-DD","title":"…","time":"HH:MM or ''","venue":"…","url":"https://…","note":"one short practical line (where to watch — channel — / tickets / cost)","local":true|false}]}`,
          { tools: 'WebSearch,WebFetch', timeoutMs: 240000, module: 'activities', model: 'claude-sonnet-5' });
        const block2 = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
        let j = null; try { j = JSON.parse(block2); } catch (e) {}
        const fresh = ((j && Array.isArray(j.events)) ? j.events : [])
          .filter(ev => /^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') && (ev.title || '').trim())
          .filter(ev => !seen.has(key(a.activity, ev.date, ev.title)))
          .filter(ev => !(tokIdx[a.activity + '|' + ev.date] || []).some(T => nearDupe(T, toks(ev.title))))
          .slice(0, 8);
        if (fresh.length) await appendTabRows(ACTEV_TAB, ACTEV_HEADERS_ALL, fresh.map(ev => [
          a.activity, ev.date, String(ev.title).slice(0, 120), String(ev.time || ''), String(ev.venue || '').slice(0, 80),
          String(ev.url || '').slice(0, 300), String(ev.note || '').slice(0, 200), nowIso(), crypto.randomUUID(),
          ev.local === false ? '' : locationOnDate(ev.date), // '' = location-independent (TV/online)
        ]));
        fresh.forEach(ev => { seen.add(key(a.activity, ev.date, ev.title)); (tokIdx[a.activity + '|' + ev.date] = tokIdx[a.activity + '|' + ev.date] || []).push(toks(ev.title)); });
        track('activities', true, `${a.activity}: +${fresh.length} event${fresh.length === 1 ? '' : 's'}`);
      } catch (e) { track('activities', false, `${a.activity}: ${e.message}`); }
    }
  } finally { actScanBusy = false; }
}
if (HAS_CLAUDE) {
  setTimeout(() => scanActivities().catch(() => {}), 90e3); // first pass shortly after boot
  setInterval(() => scanActivities().catch(() => {}), 4 * 3600e3);
}
app.get('/api/activities', asyncRoute(async (req, res) => {
  const acts = await loadActivitiesConfig();
  const leadOf = Object.fromEntries(acts.map(a => [a.activity, a.leadDays]));
  const showOf = Object.fromEntries(acts.map(a => [a.activity, a.show]));
  const tab = await readTabCached(TODO_SHEET_ID, ACTEV_TAB, ACTEV_HEADERS, 120000).catch(() => ({ rows: [] }));
  const t0 = today();
  const horizon = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  const STOP2 = new Set(['vs', 'v', 'the', 'and', 'at', 'of', 'round', 'rd', 'match', 'live']);
  const toks2 = t => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP2.has(w));
  const nearDupe2 = (A, B) => {
    const a = new Set(A), b = new Set(B); let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / Math.max(1, Math.min(a.size, b.size)) >= 0.7;
  };
  const seenKeys = new Set(); const seenToks = {}; // activity|date → [token arrays]
  const homeLC = String(typeof HOME_LOCATION !== 'undefined' ? HOME_LOCATION : '').toLowerCase();
  const events = tab.rows.filter(r => r.Date >= t0 && r.Date <= horizon)
    .filter(r => { // projected-location gate (see ScanLoc column)
      const here = locationOnDate(r.Date); if (!here) return true;
      const scanLoc = String(r.ScanLoc || '').trim();
      if (scanLoc) return scanLoc.toLowerCase() === here.toLowerCase();
      return !(homeLC && here.toLowerCase() !== homeLC && String(r.Activity).toLowerCase().includes(homeLC));
    })
    .filter(r => { // display-side dedup: racing scanners may double-append; dupes never render
      const k = r.Activity + '|' + r.Date + '|' + String(r.Title).toLowerCase().slice(0, 60);
      if (seenKeys.has(k)) return false;
      const T = toks2(r.Title), g = r.Activity + '|' + r.Date;
      if ((seenToks[g] || []).some(x => nearDupe2(x, T))) return false;
      seenKeys.add(k); (seenToks[g] = seenToks[g] || []).push(T);
      return true;
    })
    .map(r => ({ activity: r.Activity, date: r.Date, title: r.Title, time: r.Time, venue: r.Venue, url: r.URL, note: r.Note, show: showOf[r.Activity] || 'all' }))
    .sort((x, y) => x.date.localeCompare(y.date) || String(x.time).localeCompare(String(y.time)));
  const leads = events.filter(ev => {
    const lead = leadOf[ev.activity] || 0;
    if (!lead) return false;
    const start = new Date(Date.parse(ev.date) - lead * 86400000).toISOString().slice(0, 10);
    return t0 >= start && t0 < ev.date;
  });
  res.json({ events, leads });
}));
// "+" travel input above the look-ahead: free text (possibly several legs) → LLM parse →
// evidence signals + PINNED bars (user input is authoritative), optionally back-synced to
// the calendar as all-day events. "JFK->LHR 25/7" = flight arriving London July 25.
app.post('/api/location/parse', asyncRoute(async (req, res) => {
  const { text, syncCalendar } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  if (!HAS_LLM) return res.status(400).json({ error: 'travel parsing needs an LLM tier' });
  const raw = await runClaude(
    `Today is ${today()}. Parse this travel/location note into structured entries. It may contain MULTIPLE legs/stays (commas/newlines/spaces between them). Airport codes become city names (JFK=New York, LHR=London, CDG=Paris…). "JFK->LHR 25/7" is a flight ARRIVING London on July 25. Dates without a year mean the next occurrence. "Lisbon 15-19/7" is a stay.\n` +
    `INPUT: ${String(text).slice(0, 500)}\n` +
    `Return STRICT JSON only: {"entries":[{"kind":"flight|train|car|hotel|stay","date":"YYYY-MM-DD arrival/start","endDate":"YYYY-MM-DD (= date for a one-day leg)","location":"destination/stay city","label":"short display label, e.g. 'TLS → DOH' or 'Pau'"}]}`,
    { timeoutMs: 60000, module: 'location', model: 'claude-haiku-4-5' });
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
  let j = null; try { j = JSON.parse(block); } catch (e) {}
  const entries = ((j && Array.isArray(j.entries)) ? j.entries : []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') && e.location);
  if (!entries.length) return res.status(422).json({ error: 'could not parse — try e.g. "JFK->LHR 25/7" or "Lisbon 15-19/7"' });
  const results = [];
  for (const e of entries) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(e.endDate || '') && e.endDate >= e.date ? e.endDate : e.date;
    const isTravel = ['flight', 'train', 'car'].includes(e.kind);
    await addLocationSignal({ type: isTravel ? e.kind : 'hotel', date: e.date, endDate: end, location: e.location, note: 'manual: ' + String(e.label || text).slice(0, 60) }).catch(() => {});
    const bars = loadLocationBars().filter(b => b.id !== 'input:' + e.date);
    bars.push({ id: 'input:' + e.date, start: e.date, end, location: e.location, sourceUrl: '', pinned: true, note: e.label || '', updatedAt: nowIso() });
    saveLocationBars(bars);
    let eventId = '', calendarError = '';
    if (syncCalendar) {
      try {
        eventId = (await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: {
          summary: (isTravel ? '✈ ' : '📍 ') + (e.label || e.location),
          start: { date: e.date }, end: { date: addDays(end, 1) }, // all-day end exclusive
        } })).data.id;
      } catch (err) { calendarError = String(err.message).slice(0, 120); }
    }
    results.push({ ...e, end, eventId, calendarError: calendarError || undefined });
  }
  res.json({ ok: true, entries: results });
}));
app.post('/api/activities/scan', asyncRoute(async (req, res) => {
  if (!HAS_CLAUDE) return res.status(400).json({ error: 'scanning runs on the agent tier' });
  scanActivities().catch(() => {});
  res.json({ ok: true, started: true });
}));

// ---------- location tracking ("where am I / will I be") ----------
// Evidence-weighted resolver: signals (append-only log, one Sheet tab) get merged into
// continuous date-range BARS (compact, replaced each pass — a versioned Heartbeat cell,
// same two-way offline-first sync as settings/markets). A bar the user has touched
// (renamed or resized) is PINNED and the resolver never overwrites it — "manual edits are
// strong feedback it never overrides," same philosophy as the orchestrator's own rules.
// Evidence priority (highest wins for a directly-covered day), per spec:
//   flight/train confirmation email > precise-time calendar event > default/all-day
//   calendar event > hotel/Airbnb email alone > closest configured Location of Interest.
// Gmail evidence (flight/train/hotel) needs a one-time OAuth consent (see /auth/gmail/*
// below) — until then those types simply never appear and the calendar + LOI tiers carry
// the resolver on their own.
const LOCSIG_TAB = 'Location Signals';
const LOCSIG_HEADERS = ['Type', 'Date', 'EndDate', 'Location', 'Confidence', 'SourceURL', 'Note', 'CreatedAt', 'ID'];
const LOC_WEIGHT = { flight: 100, train: 100, 'cal-precise': 80, car: 70, 'cal-default': 60, hotel: 40, loi: 10, home: 0 };
const { resolveDayLocations } = require('./location-resolve'); // pure gap-fill core, with recency decay
const LOCBARS_LOCAL = path.join(__dirname, 'data', 'location-bars-local.json');
const LOCBARS_CELL = "'Heartbeat'!P1";
const dstr = d => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => dstr(new Date(Date.parse(dateStr + 'T12:00:00Z') + n * 86400000));

function readLocBarsFile() {
  try { const j = JSON.parse(fs.readFileSync(LOCBARS_LOCAL, 'utf8')); return (j && Array.isArray(j.bars)) ? j : null; } catch (e) { return null; }
}
function loadLocationBars() { return (readLocBarsFile() || { bars: [] }).bars; }
// compact "Jul 10–11: Porto; Jul 12–17: London" string for the next N days — feeds the
// activities scanner so "this weekend" resolves against where the owner will actually
// be, not a hardcoded home city (punch list item: weekend curation by projected location)
function projectedLocationLine(daysAhead) {
  const rs = today(), re = addDays(rs, daysAhead);
  const bars = loadLocationBars().filter(b => !(b.end < rs || b.start > re)).sort((a, b) => a.start.localeCompare(b.start));
  if (!bars.length) return '';
  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return bars.map(b => `${fmt(b.start)}${b.end !== b.start ? '–' + fmt(b.end) : ''}: ${b.location}`).join('; ');
}
function saveLocationBars(bars) {
  const payload = { savedAt: Date.now(), bars };
  try { fs.writeFileSync(LOCBARS_LOCAL, JSON.stringify(payload)); } catch (e) {}
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: LOCBARS_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(payload).slice(0, 49000)]] } }).catch(() => {});
}
async function syncLocationBarsFromSheet() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: LOCBARS_CELL });
    const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
    let remote = null; try { remote = JSON.parse(raw); } catch (e) {}
    const local = readLocBarsFile();
    if (remote && Array.isArray(remote.bars) && (!local || remote.savedAt > local.savedAt)) { fs.writeFileSync(LOCBARS_LOCAL, raw); return; }
    if (local && (!remote || local.savedAt > (remote ? remote.savedAt : 0)))
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: LOCBARS_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(local).slice(0, 49000)]] } });
  } catch (e) {}
}
syncLocationBarsFromSheet(); setInterval(syncLocationBarsFromSheet, 10 * 60000);

async function addLocationSignal(sig) {
  await appendTabRows(LOCSIG_TAB, LOCSIG_HEADERS, [[
    sig.type, sig.date, sig.endDate || sig.date, String(sig.location).slice(0, 80),
    String(LOC_WEIGHT[sig.type] || 0), String(sig.sourceUrl || '').slice(0, 300), String(sig.note || '').slice(0, 200),
    nowIso(), crypto.randomUUID(),
  ]]);
}

// Calendar signals: multi-day or out-of-home events are the ONE evidence source that needs
// no external OAuth (the dashboard already reads the configured calendars). An LLM pass
// extracts a clean location from messy titles ("Pau (car pickup)", "Family — France");
// without an LLM configured, falls back to the event's own `location` field verbatim.
async function harvestCalendarSignals() {
  const { events } = await fetchCalendarEvents(45).catch(() => ({ events: [] }));
  const existing = await readTab(TODO_SHEET_ID, LOCSIG_TAB, LOCSIG_HEADERS).catch(() => ({ rows: [] }));
  const seenKey = new Set(existing.rows.filter(r => r.Type?.startsWith('cal-')).map(r => r.Type + '|' + r.Date + '|' + r.Location));
  const candidates = events.filter(ev => {
    const s = ev.start?.dateTime || ev.start?.date, e = ev.end?.dateTime || ev.end?.date;
    if (!s) return false;
    const days = e ? Math.ceil((Date.parse(e) - Date.parse(s)) / 86400000) : 0;
    return days >= 1 || !!ev.location; // multi-day span, or any event carrying a location field
  });
  if (!candidates.length) return;
  let extracted = [];
  if (HAS_CLAUDE || process.env.ANTHROPIC_API_KEY) {
    try {
      const lines = candidates.slice(0, 40).map((ev, i) => `${i}. ${ev.start?.dateTime || ev.start?.date} → ${ev.end?.dateTime || ev.end?.date || ''} | "${ev.summary || ''}"${ev.location ? ' @ ' + ev.location : ''}`);
      const raw = await runClaude(
        `Calendar events. For each one that clearly indicates the OWNER WILL PHYSICALLY BE in a specific real-world PLACE (a real city/region/country — "France", "Pau", "London office"), extract it. ` +
        `Skip anything that ISN'T evidence of the owner's own location: generic meetings/reminders/birthdays, school-holiday zone labels ("Zone A/B/C"), academic-calendar terms, public-holiday names, or any event whose "place" is really a category/classification rather than somewhere a person travels to.\n` +
        `Events:\n${lines.join('\n')}\n\n` +
        `Return STRICT JSON only, no prose: {"locations":[{"i":<index>,"place":"short place name"}]}`,
        { timeoutMs: 60000, module: 'location', model: 'claude-haiku-4-5' });
      const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
      let j = null; try { j = JSON.parse(block); } catch (e) {}
      extracted = ((j && Array.isArray(j.locations)) ? j.locations : [])
        .map(x => ({ ev: candidates[x.i], place: String(x.place || '').trim() })).filter(x => x.ev && x.place);
    } catch (e) {}
  } else {
    extracted = candidates.filter(ev => ev.location).map(ev => ({ ev, place: ev.location }));
  }
  for (const { ev, place } of extracted) {
    const startIso = ev.start?.dateTime || ev.start?.date;
    const endRaw = ev.end?.dateTime || ev.end?.date;
    const date = dstr(new Date(startIso));
    // all-day Google events carry an EXCLUSIVE end date — step back one day
    const endDate = endRaw ? dstr(new Date(Date.parse(endRaw) - (ev.end?.date ? 86400000 : 0))) : date;
    const precise = !!ev.start?.dateTime && !/T00:00:00/.test(ev.start.dateTime);
    const type = precise ? 'cal-precise' : 'cal-default';
    const key = type + '|' + date + '|' + place;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    await addLocationSignal({ type, date, endDate, location: place, note: ev.summary || '' });
  }
}

// Gmail evidence: flight/train/car/hotel confirmations. Reuses the SAME OAuth client id/
// secret as Sign-in-with-Google but a SEPARATE offline-consent grant (see /auth/gmail/*)
// so the refresh token persists for background use. Message IDs already processed are
// cached locally (Mac-only cache; safe to lose — just re-scans a wider window next time).
const GMAIL_PROCESSED_FILE = path.join(__dirname, 'data', 'gmail-processed.json');
function gmailProcessedIds() { try { return new Set(JSON.parse(fs.readFileSync(GMAIL_PROCESSED_FILE, 'utf8'))); } catch (e) { return new Set(); } }
function markGmailProcessed(ids) {
  const cur = [...gmailProcessedIds(), ...ids].slice(-1000);
  try { fs.writeFileSync(GMAIL_PROCESSED_FILE, JSON.stringify(cur)); } catch (e) {}
}
async function gmailAuthClient() {
  if (!hasGmail() || !OAUTH_ID) return null;
  const { refresh_token } = JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8'));
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET);
  c.setCredentials({ refresh_token });
  return c;
}
// One extraction pipeline, two transports. extractTravelSignal is the shared LLM stage.
async function extractTravelSignal(subject, bodyText, sourceUrl) {
  const raw = await runClaude(
    `This is a confirmation email. Extract travel evidence if present.\nSUBJECT: ${subject}\nBODY (may include HTML/tracking noise — ignore it):\n${String(bodyText).slice(0, 4000)}\n\n` +
    `If this is a flight, train, car rental, or hotel/Airbnb confirmation with clear dates and places, return EVERY leg/stay it contains — a round-trip itinerary yields BOTH the outbound AND the return leg as separate entries. Each entry's date/endDate must cover ONLY that single leg or stay (a flight leg is one day, or two for an overnight arrival) — NEVER the whole itinerary's span. If none, return {"signals":[]}.\n` +
    `Return STRICT JSON only: {"signals":[{"type":"flight|train|car|hotel","date":"YYYY-MM-DD","endDate":"YYYY-MM-DD or same as date","location":"the destination/place name — for a flight/train use the ARRIVAL city, for a car rental the DROP-OFF/destination city (NOT the pickup city), for a hotel the stay city","note":"one short line"}]}`,
    { timeoutMs: 60000, module: 'location', model: 'claude-haiku-4-5' });
  const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
  let j = null; try { j = JSON.parse(block); } catch (e) {}
  const sigs = (j && Array.isArray(j.signals)) ? j.signals : (j && j.signal ? [j.signal] : []);
  for (const sig of sigs)
    if (sig && sig.type && /^\d{4}-\d{2}-\d{2}$/.test(sig.date || '') && sig.location)
      await addLocationSignal({ ...sig, sourceUrl });
}
// IMAP fallback: an app password never expires, unlike a Testing-mode OAuth grant.
// Configured by the OWNER ONLY (config-local imapUser/imapAppPassword) — never written here.
async function harvestImapSignals() {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: CFG.imapHost, port: 993, secure: true, logger: false,
    auth: { user: CFG.imapUser, pass: CFG.imapAppPassword } });
  const processed = gmailProcessedIds();
  const newlyProcessed = [];
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - 75 * 86400000);
    const uids = new Set();
    for (const term of ['flight', 'itinerary', 'e-ticket', 'booking', 'reservation', 'hotel', 'car rental', 'your trip'])
      for (const uid of (await client.search({ since, or: [{ subject: term }, { body: term }] }, { uid: true }).catch(() => [])) || [])
        uids.add(uid);
    const recent = [...uids].sort((a, b) => b - a).slice(0, 60).filter(u => !processed.has('imap:' + u));
    for (const uid of recent) {
      newlyProcessed.push('imap:' + uid);
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyParts: ['text'] });
        const subject = msg.envelope?.subject || '';
        const bodyText = String(msg.bodyParts?.get('text') || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        await extractTravelSignal(subject, bodyText, '');
      } catch (e) { /* one bad email never aborts the batch */ }
    }
  } finally { await client.logout().catch(() => {}); }
  markGmailProcessed(newlyProcessed);
}
async function harvestGmailSignals() {
  const auth = await gmailAuthClient();
  if (!auth) { if (hasImap()) await harvestImapSignals(); return; }
  const gmail = google.gmail({ version: 'v1', auth });
  const processed = gmailProcessedIds();
  const q = '(flight OR itinerary OR "e-ticket" OR eticket OR "booking confirmation" OR "reservation confirmation" OR "your trip" OR "hotel confirmation" OR "car rental") newer_than:75d';
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 60 }).catch(() => ({ data: {} }));
  const ids = (list.data.messages || []).map(m => m.id).filter(id => !processed.has(id));
  if (!ids.length) return;
  const newlyProcessed = [];
  for (const id of ids) {
    newlyProcessed.push(id);
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = msg.data.payload?.headers || [];
      const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const decode = p => p ? Buffer.from(p, 'base64').toString('utf8') : '';
      const flat = []; // airline mail is often HTML-only nested in multipart/* — flatten and fall back
      (function walk(p) { if (!p) return; flat.push(p); (p.parts || []).forEach(walk); })(msg.data.payload);
      const plain = flat.filter(p => p.mimeType === 'text/plain').map(p => decode(p.body?.data)).join('\n');
      const html = flat.filter(p => p.mimeType === 'text/html').map(p => decode(p.body?.data)).join('\n')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      const bodyText = (plain.trim().length > 80 ? plain : html) || plain || decode(msg.data.payload?.body?.data) || msg.data.snippet || '';
      await extractTravelSignal(subject, bodyText, `https://mail.google.com/mail/u/0/#all/${id}`);
    } catch (e) { /* one bad email never aborts the batch */ }
  }
  markGmailProcessed(newlyProcessed);
}

// Resolve a continuous set of bars for [rangeStart, rangeEnd]. Days covered by a PINNED bar
// are left untouched; every other day is recomputed from signals + the Location-of-Interest
// fallback + the home-location default, per the priority order documented above.
async function resolveLocationBars(rangeStart, rangeEnd) {
  const bars = loadLocationBars();
  const pinned = bars.filter(b => b.pinned);
  const pinnedOn = d => pinned.find(b => d >= b.start && d <= b.end);

  const lookback = addDays(rangeStart, -60);
  // A failed signals read must ABORT the pass (throw), never resolve from zero evidence:
  // a swallowed read error here once turned every unpinned day into "Location?"/home and
  // the sheet-cell sync replicated the damage to every tier. (A successful read of a
  // genuinely empty tab still resolves — that's real "no evidence", not a failure.)
  const sigRows = (await readTab(TODO_SHEET_ID, LOCSIG_TAB, LOCSIG_HEADERS)).rows
    .filter(r => r.EndDate >= lookback && r.Date <= rangeEnd)
    .map(r => ({ type: r.Type, date: r.Date, endDate: r.EndDate || r.Date, location: r.Location, weight: +r.Confidence || 0, sourceUrl: r.URL || r.SourceURL, note: r.Note, createdAt: r.CreatedAt }));

  let loiNames = [];
  try { loiNames = (await loadEditablePref('LOCATIONS')).rows.map(r => (r[0] || '').trim()).filter(Boolean); } catch (e) {}
  const isLoi = place => loiNames.some(n => n.toLowerCase() === String(place).toLowerCase() || String(place).toLowerCase().includes(n.toLowerCase()));

  // walk the window day by day; nearest-evidence gap fill (with recency decay) lives in
  // location-resolve.js so the rules are testable — see that file for the decay rationale
  const days = [];
  for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) days.push(d);
  const dayLoc = resolveDayLocations({ days, lookback, sigRows, isLoi, homeLocation: CFG.homeLocation, pinnedOn });
  // merge consecutive identical days into bars
  const autoBars = [];
  let run = null;
  for (const d of days) {
    if (pinnedOn(d)) { if (run) { autoBars.push(run); run = null; } continue; }
    const v = dayLoc[d];
    if (run && run.location === v.location && addDays(run.end, 1) === d) { run.end = d; }
    else { if (run) autoBars.push(run); run = { start: d, end: d, location: v.location, sourceUrl: v.sourceUrl || '', note: v.note || '', pinned: false, id: 'auto:' + d }; }
  }
  if (run) autoBars.push(run);
  const kept = bars.filter(b => b.pinned); // pinned bars persist even outside this pass's window
  const final = [...kept, ...autoBars.map(b => ({ ...b, updatedAt: nowIso() }))];
  saveLocationBars(final);
  return final;
}
let locScanBusy = false;
async function scanLocation() {
  if (process.env.DASHBOARD_NO_JOBS) return;
  if (locScanBusy) return;
  locScanBusy = true;
  try {
    await harvestCalendarSignals().catch(e => track('location', false, 'calendar harvest: ' + e.message));
    if (hasGmail() || hasImap()) await harvestGmailSignals().catch(e => track('location', false, 'gmail harvest: ' + e.message));
    const rs = today(), re = addDays(rs, 14);
    try { await resolveLocationBars(rs, re); track('location', true, `resolved ${rs}..${re}`); }
    catch (e) { track('location', false, 'resolve aborted (bars kept): ' + e.message); }
  } finally { locScanBusy = false; }
}
setTimeout(() => scanLocation().catch(() => {}), 120e3);
setInterval(() => scanLocation().catch(() => {}), 4 * 3600e3);

app.get('/api/location', asyncRoute(async (req, res) => {
  const rs = today(), re = addDays(rs, 14);
  let bars = loadLocationBars().filter(b => !(b.end < rs || b.start > re));
  if (!bars.length) { try { bars = await resolveLocationBars(rs, re); } catch (e) {} }
  const headlineBar = bars.find(b => rs >= b.start && rs <= b.end);
  res.json({
    bars, homeLocation: CFG.homeLocation,
    headline: headlineBar ? { text: headlineBar.location, sourceUrl: headlineBar.sourceUrl || '' } : { text: CFG.homeLocation || '', sourceUrl: '' },
  });
}));
app.post('/api/location/bars/:id', asyncRoute(async (req, res) => {
  const { start, end, location, sourceUrl, unpinned } = req.body || {};
  if (!start || !end || !location) return res.status(400).json({ error: 'start, end, location required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) return res.status(400).json({ error: 'bad date range' });
  const bars = loadLocationBars();
  const id = req.params.id === 'new' ? crypto.randomUUID() : req.params.id;
  const idx = bars.findIndex(b => b.id === id);
  // unpinned is used ONLY by the client's gap-filler ("Location?" placeholders) — every
  // real user edit (rename/resize) pins, so the resolver never overwrites it
  const bar = { id, start, end, location: String(location).slice(0, 80), pinned: !unpinned, sourceUrl: sourceUrl || (idx !== -1 ? bars[idx].sourceUrl : ''), note: idx !== -1 ? bars[idx].note : '', updatedAt: nowIso() };
  if (idx !== -1) bars[idx] = bar; else bars.push(bar);
  saveLocationBars(bars);
  res.json({ ok: true, bar });
}));
app.delete('/api/location/bars/:id', asyncRoute(async (req, res) => {
  const bars = loadLocationBars().filter(b => b.id !== req.params.id);
  saveLocationBars(bars);
  res.json({ ok: true });
}));
app.post('/api/location/scan', asyncRoute(async (req, res) => {
  scanLocation().catch(() => {});
  res.json({ ok: true, started: true });
}));

// ---------- agent reader (claude CLI, headless — runs on the subscription) ----------

const { execFile } = require('child_process');
const AGENT_QUEUE_FILE = path.join(__dirname, 'data', 'agent-queue.json');
const SUMMARIES_FILE = path.join(__dirname, 'data', 'agent-summaries.json');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };

const { logUsage } = require('./bin/log-usage');
const { logDecision } = require('./bin/log-decision');

function runClaudeRaw(prompt, { tools, timeoutMs, model } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model || 'claude-haiku-4-5-20251001', '--output-format', 'json'];
    if (tools) args.push('--allowedTools', tools);
    execFile(CLAUDE_BIN, args,
      { timeout: timeoutMs || 180000, cwd: os.tmpdir(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// (The Vertex-Gemini substitution window that was documented here is now a private llm-router plugin.)
// Historical note kept for the CI's context: a GCP free-trial credit
// expires Jul 16 and covers all Vertex usage — so until then, tool-free calls in these modules
// route to Vertex Gemini instead of claude. Doubles as a live A/B: Usage rows carry the real
// gemini model name, and the news-feedback stream (swipes/followups on Gemini-written summaries)
// tells the CI how well it substitutes for Haiku/Sonnet. Tool-needing calls (WebFetch/WebSearch)
// can't route — the Gemini path has no tool wiring. Claude remains the fallback on any error.
// The default LLM runner. Instance-specific routing rules (e.g. "send tool-free calls to
// Vertex while a GCP credit lasts") are PLUGINS via the `llm` hook — a router returning a
// string answers the call; null/throw falls through to the next router, then to core.
// (The dated Gemini-substitution window that lived here moved to plugins/ on 2026-07-05.)
// `served` (optional {}): on return, served.by names the backend that actually answered —
// plugin router / claude model / gemini fallback can all differ from the requested model,
// and surfaces that display the output must be able to attribute it (GUI-LESSONS §2).
async function runClaude(prompt, { tools, timeoutMs, module, model, served } = {}) {
  const mark = by => { if (served) served.by = by; };
  for (const r of PLUGIN_LLM) {
    try {
      const out = await r.fn({ prompt, module, model, tools }, pluginCtx());
      if (typeof out === 'string' && out) { mark('plugin:' + String(r._file || 'llm').replace(/\.js$/, '')); return out; }
    } catch (e) { console.error(`plugin llm router (${r._file}):`, e.message); }
  }
  if (!HAS_CLAUDE) {
    if (tools) throw new Error('agent tools (web fetch/search) require the claude CLI');
    mark(model || 'anthropic-api');
    return await require('./providers').anthropicText(prompt, model, module); // API-key path (stub default)
  }
  try {
    const stdout = await runClaudeRaw(prompt, { tools, timeoutMs, model });
    const j = JSON.parse(stdout);
    const u = j.usage || {};
    mark(model || 'claude-haiku-4-5');
    logUsage({
      module: module || 'claude', model: /sonnet/.test(model || '') ? 'claude-sonnet-5' : 'claude-haiku-4-5',
      input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0, costUsd: j.total_cost_usd ?? '',
      note: `dur=${Math.round((j.duration_ms || 0) / 1000)}s`,
    }).catch(() => {});
    return String(j.result || '').trim();
  } catch (err) {
    if (tools) throw err; // web-fetch jobs can't run on Gemini fallback (no tools wired)
    const providers = require('./providers');
    const text = await providers.generateText(prompt, 'vertex-gemini').then(r => r.text);
    mark('vertex-gemini (fallback)');
    logDecision({
      module: module || 'claude', actor: 'gemini (fallback)',
      decision: 'fell over claude→gemini', why: String(err.message).slice(0, 120),
    }).catch(() => {});
    track('agent', false, 'claude failed; gemini fallback used: ' + String(err.message).slice(0, 100));
    return text;
  }
}

// Append a line to today's daily note under Agent Notes. Honors the heartbeat
// concurrency rule: if the note is open in Obsidian and recently edited, append
// at EOF (pure append, always safe) instead of inserting into the section.
const JOURNAL_DIR = path.join(VAULT_DIR, 'Daily Journal');
function noteOpenInObsidian(notePath) {
  try {
    const ws = path.join(VAULT_DIR, '.obsidian', 'workspace.json');
    const stat = fs.statSync(ws);
    if (Date.now() - stat.mtimeMs > 20 * 60 * 1000) return false;
    return fs.readFileSync(ws, 'utf8').includes(path.basename(notePath));
  } catch (e) { return false; }
}
// Seed a new daily note from the vault template (with the date filled in) so an
// AGENT-created note still has his full structure — otherwise Obsidian won't apply
// the template later (it only templates a brand-new note), and he loses his
// frontmatter / mood / Journal / Todo lanes for the day.
function dailyNoteSkeleton() {
  try {
    const wd = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    return fs.readFileSync(path.join(VAULT_DIR, 'templates', 'Daily Notes.md'), 'utf8')
      .replace(/\{\{date:dddd\}\}/g, wd)
      .replace(/\{\{date(:[^}]*)?\}\}/g, today());
  } catch (e) { return `# ${today()}\n\n## Stashed notes\n\n## Agent Feedback\n\n## CI Log\n\n## Agent Notes\n\n## Agent Log\n\n## Stashed media\n`; }
}
// Append `line` into a named `## <section>` heading of a daily note. Defaults match the
// most common caller (an agent action → today's Agent Log). Reading order
// (2026-07-02): Agent Feedback (follow-up questions) → CI Log → Agent Notes → Agent Log →
// Stashed media, with Stashed notes sitting before Agent Feedback. Retrospective stash
// content (media/notes from dashboard swipes, which can fire at any hour from any device)
// targets YESTERDAY's note, never today's — writing today's note early pre-empts Obsidian's
// own daily-note templating and the owner loses frontmatter/mood/lanes for the day (see
// dailyNoteSkeleton comment). `day: 'today'|'yesterday'`.
function appendToJournal(line, { section = 'Agent Log', day = 'today' } = {}) {
  if (!HAS_JOURNAL) return false; // cloud instance: vault isn't mounted
  const notePath = path.join(JOURNAL_DIR, (day === 'yesterday' ? yesterday() : today()) + '.md');
  try {
    if (!fs.existsSync(notePath)) {
      // seed from the template (O_EXCL so a racing writer can't be clobbered) — only relevant
      // for 'today' in practice; a 'yesterday' target almost always already exists.
      try { fs.writeFileSync(notePath, dailyNoteSkeleton(), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const txt = fs.readFileSync(notePath, 'utf8');
    const heading = `## ${section}`;
    // lastIndexOf, not indexOf: some older notes have a stray duplicate heading (predating a
    // template fix) — always target the LAST one so "at the very bottom" holds even then.
    const idx = txt.lastIndexOf(heading);
    if (idx === -1 || noteOpenInObsidian(notePath)) {
      // heading missing (older note predating this section), or the note is live in Obsidian
      // right now — append raw at the true end of the file rather than risk a read-modify-write
      // race with Obsidian's in-memory buffer.
      fs.appendFileSync(notePath, (idx === -1 ? `\n${heading}\n` : '\n') + line + '\n');
    } else {
      // insert at the end of the named section (before the next ## heading)
      const after = txt.indexOf('\n## ', idx + heading.length);
      const pos = after === -1 ? txt.length : after;
      fs.writeFileSync(notePath, txt.slice(0, pos).replace(/\n*$/, '\n') + line + '\n' + txt.slice(pos));
    }
    return true;
  } catch (e) { console.error('journal append failed:', e.message); return false; }
}

// Stash queue — the journal is Mac-only (E2E), so a stash from the cloud/iPhone
// can't write it directly. Park it in a Sheet tab; the Mac heartbeat drains
// pending rows into the journal (Stage A-stash) and stamps Drained. On the Mac
// itself we still write the journal directly and skip the queue.
// Generic "ensure a tab with a header row exists, then append rows" — used by both
// the stash queue and the cross-instance feedback queue so cloud/iPhone writes are
// durable (the container filesystem is ephemeral) and the Mac can drain them.
const tabReady = {};
async function ensureTab(title, headers, sheetId = TODO_SHEET_ID) {
  if (tabReady[sheetId + '|' + title]) return;
  const meta = await store.spreadsheets.get({ spreadsheetId: sheetId });
  if (!(meta.data.sheets || []).some(s => s.properties.title === title)) {
    await store.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await store.values.update({
      spreadsheetId: sheetId, range: `'${title}'!A1`,
      valueInputOption: 'RAW', requestBody: { values: [headers] },
    });
  }
  tabReady[sheetId + '|' + title] = true;
}
async function appendTabRow(title, headers, rowArray, sheetId) {
  await appendTabRows(title, headers, [rowArray], sheetId);
}
async function appendTabRows(title, headers, rows, sheetId = TODO_SHEET_ID) {
  if (!rows.length) return;
  await ensureTab(title, headers, sheetId);
  await store.values.append({
    spreadsheetId: sheetId, range: `'${title}'!A:${colLetter(headers.length - 1)}`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// Article corpus for the Tier-3 taste model: every article PRESENTED is logged here
// (durable, cross-instance). A nightly VM batch (bin/embed-articles.js) embeds the
// Title+standfirst and appends vectors to embeddings.jsonl. Dedup per-process; the
// embed job dedups by URL globally, so cross-instance overlap is harmless.
const ARTLOG_TAB = 'Article Log';
const ARTLOG_HEADERS = ['URL', 'Title', 'Standfirst', 'Source', 'Section', 'At'];
const loggedUrls = new Set();
async function logArticles(items) {
  const fresh = items.filter(it => it.link && !loggedUrls.has(it.link));
  if (!fresh.length) return;
  const now = nowIso();
  const rows = fresh.map(it => [it.link, it.title || '', (it.desc || '').slice(0, 500), it.source || '', it.section || '', now]);
  fresh.forEach(it => loggedUrls.add(it.link));
  if (loggedUrls.size > 8000) loggedUrls.clear(); // bound memory; embed job dedups anyway
  await appendTabRows(ARTLOG_TAB, ARTLOG_HEADERS, rows).catch(e => console.error('article-log:', e.message));
}
// Drain undrained rows of a queue tab via a per-row side effect; stamp Drained on success.
async function drainTab(title, headers, applyFn) {
  let tab;
  try { tab = await readTab(TODO_SHEET_ID, title, headers); }
  catch (e) { return { drained: 0, note: 'no queue yet' }; }
  // The marker is the LAST column (Stash/Feedback call it 'Drained', Control calls it
  // 'Done'). Keying on it by name caused a runaway: 'Drained' isn't on the Control Queue,
  // so rows were never marked → re-fired every poll. Use the last column generically.
  const marker = headers[headers.length - 1];
  const markerIdx = tab.headers.indexOf(marker);
  if (markerIdx === -1) { console.error(`drainTab: marker col '${marker}' missing in ${title}`); return { drained: 0, error: 'no marker col' }; }
  const markerCol = colLetter(markerIdx);
  let drained = 0;
  for (const r of tab.rows) {
    if (String(r[marker] || '').trim()) continue; // already handled
    if (!(await applyFn(r))) break;
    await store.values.update({
      spreadsheetId: TODO_SHEET_ID, range: `'${title}'!${markerCol}${r._row}`,
      valueInputOption: 'RAW', requestBody: { values: [[nowIso()]] },
    });
    drained++;
  }
  return { drained };
}

const STASH_TAB = 'Stash Queue';
const STASH_HEADERS = ['Text', 'URL', 'Source', 'Added', 'Drained', 'Kind'];
const FB_TAB = 'Feedback Queue';
const FB_HEADERS = ['JSON', 'Added', 'Drained'];
// Durable, cross-instance dismissal store — every swipe-left lands here so dismissed
// stories never come back across reloads / rebuilds / Cloud Run restarts / both
// instances. buildNews output is filtered against this on EVERY render.
const DISMISS_TAB = 'Dismissed';
const DISMISS_HEADERS = ['URL', 'Title', 'At'];
let dismissedCache = { at: 0, set: null };
async function getDismissedSet() {
  if (dismissedCache.set && Date.now() - dismissedCache.at < 30000) return dismissedCache.set;
  const urls = new Set(), titles = new Set();
  try {
    const tab = await readTab(TODO_SHEET_ID, DISMISS_TAB, DISMISS_HEADERS);
    const cutoff = Date.now() - 21 * 864e5; // 21-day window (covers every section's expiry)
    for (const r of tab.rows) {
      if (r.At && new Date(r.At).getTime() < cutoff) continue;
      if (String(r.URL || '').trim()) urls.add(r.URL.trim());
      if (String(r.Title || '').trim()) titles.add(normTitle(r.Title));
    }
  } catch (e) {}
  dismissedCache = { at: Date.now(), set: { urls, titles } };
  return dismissedCache.set;
}
// Filter a built-news payload against the dismissal store (applied post-cache so a
// swipe-left takes effect on the very next render, no full news rebuild needed).
async function withDismissals(data) {
  const { urls, titles } = await getDismissedSet();
  if (!urls.size && !titles.size) return data;
  const keep = it => !urls.has(String(it.link || '').trim()) && !titles.has(normTitle(it.title));
  return { ...data, sections: (data.sections || []).map(s => ({ ...s, items: s.items.filter(keep) })).filter(s => s.items.length) };
}
// Agent reader is cross-instance: the iPhone hits Cloud Run (no claude), so the job
// is parked in a Sheet and the Mac/VM (HAS_CLAUDE) reads it, summarizes, and writes
// the summary back to a Sheet both instances read. SSOT = these two tabs.
const AGENTQ_TAB = 'Agent Queue';
const AGENTQ_HEADERS = ['Title', 'URL', 'Source', 'Added', 'Done'];

// ---------- generic RPC bridge: run claude-only handlers on behalf of the cloud tier ----------
// Cloud Run has no claude, so interactive claude features (reparse, find-a-link) enqueue a job
// here; the Mac/VM drainer runs the handler and writes the result back; the cloud polls /api/rpc/:id.
// Same claim-based dedup as the Agent Queue so Mac + VM never double-run a job.
const RPC_TAB = 'RPC Queue';
const RPC_HEADERS = ['ID', 'Kind', 'Payload', 'Result', 'Error', 'Created', 'Done'];
const RPC_HANDLERS = { reparse: (p) => doReparse(p), media_find: (p) => doMediaFind(p), market_resolve: (p) => doMarketResolve(p), habit_freq: (p) => resolveHabitFreq(p), news_describe: (p) => doNewsDescribe(p),
  ...(HAS_JOURNAL ? { 'gmail-token': (p) => { // journal host only — the VM never holds the gmail grant
    if (!p || !p.refresh_token) throw new Error('no refresh_token in payload');
    fs.mkdirSync(path.dirname(GMAIL_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify({ refresh_token: p.refresh_token, email: p.email || '', connectedAt: nowIso() }));
    setTimeout(() => scanLocation().catch(() => {}), 3000); // harvest immediately, not on the 4h wheel
    return { ok: true };
  } } : {}) };
const RPC_SCRUB = new Set(['gmail-token']); // credential payloads never linger in the sheet
async function enqueueRpc(kind, payload) {
  const id = crypto.randomUUID();
  await appendTabRow(RPC_TAB, RPC_HEADERS, [id, kind, JSON.stringify(payload).slice(0, 45000), '', '', nowIso(), '']);
  return id;
}
app.get('/api/rpc/:id', asyncRoute(async (req, res) => {
  let q; try { q = await readTab(TODO_SHEET_ID, RPC_TAB, RPC_HEADERS); } catch (e) { return res.json({ pending: true }); }
  const row = q.rows.find(r => r.ID === req.params.id);
  if (!row) return res.json({ pending: true });
  if (String(row.Error || '').trim()) return res.json({ done: true, error: row.Error });
  if (String(row.Result || '').trim()) { try { return res.json({ done: true, result: JSON.parse(row.Result) }); } catch (e) { return res.json({ done: true, error: 'bad result payload' }); } }
  return res.json({ pending: true });
}));
let rpcBusy = false;
async function processRpcQueue() {
  if (rpcBusy || !HAS_CLAUDE) return;
  rpcBusy = true;
  try {
    let q; try { q = await readTab(TODO_SHEET_ID, RPC_TAB, RPC_HEADERS); } catch (e) { return; }
    const job = q.rows.find(r => !String(r.Done || '').trim() && RPC_HANDLERS[r.Kind]);
    if (!job) return;
    const cell = name => `'${RPC_TAB}'!${colLetter(q.headers.indexOf(name))}${job._row}`;
    const doneCell = cell('Done');
    const claim = `claim ${os.hostname().slice(0, 18)} ${Date.now()}`;
    await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [[claim]] } });
    await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800)));
    const after = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: doneCell });
    if (((after.data.values || [[]])[0] || [])[0] !== claim) return; // lost the claim to the other tier
    try {
      const result = await RPC_HANDLERS[job.Kind](JSON.parse(job.Payload || '{}'));
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: cell('Result'), valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(result).slice(0, 45000)]] } });
    } catch (e) {
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: cell('Error'), valueInputOption: 'RAW', requestBody: { values: [[String(e.message || e).slice(0, 500)]] } });
    }
    if (RPC_SCRUB.has(job.Kind))
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: cell('Payload'), valueInputOption: 'RAW', requestBody: { values: [['[scrubbed]']] } }).catch(() => {});
    await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [['done ' + nowIso()]] } });
    processRpcQueue().catch(() => {}); // chain to drain any others
  } finally { rpcBusy = false; }
}
if (HAS_CLAUDE) setInterval(() => processRpcQueue().catch(() => {}), 5000);
const SUMM_TAB = 'Summaries';
const SUMM_HEADERS = ['URL', 'Title', 'Source', 'Summary', 'Created', 'State']; // State: ''|dismissed|stashed
// Model: which backend wrote the summary (grok / claude-* / plugin / gemini fallback) — shown
// as a badge on the card. Kept OUT of SUMM_HEADERS: readTab throws if a hinted header is
// missing, and older instances (VM/Cloud Run) still run pre-Model code against this tab.
const SUMM_HEADERS_ALL = [...SUMM_HEADERS, 'Model'];
let summModelHeaderOk = false;
async function ensureSummModelHeader() { // one-time per process: add the Model header cell to an existing tab
  if (summModelHeaderOk) return;
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: `'${SUMM_TAB}'!A1:Z10` });
    const values = r.data.values || [];
    for (let i = 0; i < values.length; i++) {
      const row = (values[i] || []).map(c => String(c).trim());
      if (SUMM_HEADERS.every(h => row.includes(h))) {
        if (!row.includes('Model')) await store.values.update({
          spreadsheetId: TODO_SHEET_ID, range: `'${SUMM_TAB}'!${colLetter(row.length)}${i + 1}`,
          valueInputOption: 'RAW', requestBody: { values: [['Model']] },
        });
        break;
      }
    }
  } catch (e) {} // tab missing → ensureTab creates it with SUMM_HEADERS_ALL on first append
  summModelHeaderOk = true;
}
let summCache = { at: 0, rows: null };
async function readSummariesTab(maxAgeMs = 4000) {
  if (summCache.rows && Date.now() - summCache.at < maxAgeMs) return summCache.rows;
  let rows = [];
  try { rows = (await readTab(TODO_SHEET_ID, SUMM_TAB, SUMM_HEADERS)).rows; } catch (e) {}
  summCache = { at: Date.now(), rows };
  return rows;
}
async function setSummaryState(url, state) {
  const rows = await readSummariesTab(0);
  const row = rows.find(r => r.URL === url && !String(r.State || '').trim());
  if (!row) return null;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${SUMM_TAB}'!${colLetter(SUMM_HEADERS.indexOf('State'))}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [[state]] },
  });
  summCache.at = 0; // invalidate
  return row;
}

// Append a dense follow-up section (below a *** divider) to an existing summary cell.
async function appendToSummary(url, addition) {
  const row = (await readSummariesTab(0)).find(r => r.URL === url && !String(r.State || '').trim());
  if (!row) return false;
  const newText = String(row.Summary || '').trimEnd() + '\n\n***\n' + addition;
  await store.values.update({
    spreadsheetId: TODO_SHEET_ID, range: `'${SUMM_TAB}'!${colLetter(SUMM_HEADERS.indexOf('Summary'))}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [[newText]] },
  });
  summCache.at = 0;
  return true;
}

// Strip grok's X metadata (post IDs, engagement counts, "photos attached") — substance only.
function cleanXSummary(s) {
  return String(s || '')
    .replace(/[,;]?\s*\bPost ID\s+\d+/gi, '')
    .replace(/\s*\(ID\s+\d[^)]*\)/gi, '')
    .replace(/[,;]?\s*[\d.,]+\s*[km]?\s*(?:likes?|views?|reposts?|retweets?|replies)\b/gi, '')
    .replace(/\s*\(\d+\s*photos?\s*attached\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;)])/g, '$1').trim();
}

// kind → which section of the daily note a stash lands in. Both are retrospective (per
// Stashing (06-16) can happen any time from any device, so it always targets
// YESTERDAY's note — see appendToJournal's comment for why).
const STASH_TARGET = {
  media: { section: 'Stashed media', day: 'yesterday' }, // a story/article stash
  note: { section: 'Stashed notes', day: 'yesterday' },  // arbitrary text / habit note
};
// Try journal first (Mac); fall back to the Sheet queue (cloud). Returns where it went.
async function stashAnywhere(line, { url = '', source = '', kind = 'note' } = {}) {
  const target = STASH_TARGET[kind] || STASH_TARGET.note;
  if (appendToJournal(line, target)) return 'journal';
  await appendTabRow(STASH_TAB, STASH_HEADERS, [line, url, source, nowIso(), '', kind]);
  return 'queued';
}

// Process one queued agent job (Mac/VM only). Reads the Sheet queue, summarizes
// with claude, appends the summary to the Summaries tab, marks the job Done.
let agentBusy = false;
async function processAgentQueue() {
  if (agentBusy || !HAS_CLAUDE) return;
  agentBusy = true;
  try {
    let q;
    try { q = await readTab(TODO_SHEET_ID, AGENTQ_TAB, AGENTQ_HEADERS); } catch (e) { return; }
    const job = q.rows.find(r => !String(r.Done || '').trim() && String(r.URL || '').trim());
    if (!job) return;
    const doneCell = `'${AGENTQ_TAB}'!${colLetter(q.headers.indexOf('Done'))}${job._row}`;
    const isFollowup = String(job.Title || '').startsWith('[FOLLOWUP] ');
    // skip if already has a LIVE summary (dismissed ones don't block — e.g. an
    // unfetchable card the user replaced via "Find similar"). Follow-ups EXPECT one.
    if (!isFollowup) {
      const existing = (await readSummariesTab(0)).find(s => s.URL === job.URL && !String(s.State || '').trim());
      if (existing) { await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [['dup ' + nowIso()]] } }); return; }
    }
    // CLAIM the job so Mac + VM never double-process: stamp our claim, wait, re-read;
    // if another processor's claim won the race, back off. (Sheets has no CAS; this
    // last-writer-wins + recheck is sufficient at our low job rate.)
    const claim = `claim ${os.hostname().slice(0, 18)} ${Date.now()}`;
    await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [[claim]] } });
    await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
    const after = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: doneCell });
    if (((after.data.values || [[]])[0] || [])[0] !== claim) return; // lost the claim
    try {
      if (isFollowup) {
        const question = job.Title.slice('[FOLLOWUP] '.length);
        const s = (await readSummariesTab(0)).find(x => x.URL === job.URL && !String(x.State || '').trim());
        if (s) {
          const answer = await runClaude(
            `A reader has this summary of a news article and wants more detail. Research the web and answer with ONLY NEW facts not already in the summary.\n` +
            `Article: "${s.Title}" (${job.URL}). Source: ${s.Source || ''}.\nEXISTING SUMMARY (do NOT repeat any of it):\n${s.Summary}\n\nREADER'S FOLLOW-UP: ${question}\n\n` +
            `Answer DENSELY: 2-6 tight lines, each leading with a concrete fact — numbers, named people/orgs/places, dates, what was decided/said/filed and by whom. Do NOT restate the question, do NOT repeat the summary. No preamble. Cite non-obvious facts with a markdown [source](url) link. If you find nothing genuinely new, reply EXACTLY: NONE.`,
            { tools: 'WebFetch,WebSearch', timeoutMs: 240000, module: 'followup', model: 'claude-sonnet-5' });
          if (answer && !/^\s*NONE\s*$/i.test(answer)) await appendToSummary(job.URL, answer.trim());
        }
        await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [[nowIso()]] } });
        track('agent', true, 'followup ok');
      } else {
      const similar = job.Title.startsWith('[SIMILAR] ');
      const cleanTitle = similar ? job.Title.slice('[SIMILAR] '.length) : job.Title;
      // resolve Google News redirect → real article URL so claude can fetch it
      const realUrl = similar ? job.URL : await resolveArticleUrl(job.URL);
      const FACTS = `The reader wants the ARGUMENT and the PRECISION — the core point of the piece PLUS the hard facts most stories bury under fluff. ` +
        `LINE 1 = the THESIS: one sentence on what the article actually argues, or what happened and why it matters (the "so what"), led by the AUTHOR in bold if identifiable (e.g. "**Ezra Klein** — …"); for an X post use the @handle. ` +
        `THEN 2-4 tight fact lines, each leading with a concrete datum — numbers, %/$ figures, dates, named people/places/orgs, what was decided/filed/shipped and by whom — and briefly what each figure MEANS in context (vs. prior, vs. expectation, share of total), not just the raw number. For a complex/analytical piece, make sure the reasoning or mechanism is clear, not just the data points. ` +
        `RULES: substance over framing. NO empty adjectives, NO "could/may/is expected to" speculation unless it IS the news (then attribute: "X said Y"), NO preamble, NO "the article says". If two sources give different numbers, give both.`;
      let summary;
      let servedBy = ''; // which backend wrote it — stored in the Model column, badged on the card
      // PRIMARY (non-similar): pull clean article text via the JS reader, then summarize
      // the text directly — bypasses claude's WebFetch (blocked by many publishers).
      const isXPost = /\b(?:x|twitter)\.com\//i.test(realUrl) || /\b(?:x|twitter)\.com\//i.test(job.URL) || /·\s*X\s*$/.test(job.Source || '');
      if (isXPost) {
        // X/Twitter: readArticle + claude WebFetch can't read these (auth/JS wall) —
        // use grok's x_search, which can. Needs XAI_API_KEY on the processor. Detect by
        // either URL OR the Following source format ("<person> · X") since resolveArticleUrl
        // can mangle the X url. Pass the post text so grok can find it even with a bad url.
        try {
          const providers = require('./providers');
          const handle = String(job.Source || '').replace(/\s*·.*$/, '').trim();
          const g = await providers.grokAgent(`${FACTS}\nUse x_search to FIND and summarize a specific X/Twitter post for the reader. The URL is only a hint and is often truncated/wrong — find the post by AUTHOR + TEXT instead.\nAuthor: ${handle || job.Source}\nPost text (approximate): "${cleanTitle}"\nURL hint: ${realUrl || job.URL}\nBegin with the @handle and the gist, then the substance. EXCLUDE metadata: NO post IDs, NO exact timestamps, NO like/view/repost counts, NO "(N photos attached)" — only what was actually said (and the quoted/parent tweet's content if it's a reply/QT). Only if you truly cannot find any matching post, reply with EXACTLY the single word UNFETCHABLE.`);
          summary = (g && g.trim()) ? cleanXSummary(g.trim()) : 'UNFETCHABLE';
          servedBy = 'grok';
        } catch (e) { console.error('x/grok summary:', e.message); summary = 'UNFETCHABLE'; }
      } else if (!similar) {
        // Economist: try the owner's subscriber cookie first (full text past the paywall),
        // then fall back to the generic reader for everything else.
        const text = await fetchSubscriberText(realUrl) || await readArticle(realUrl);
        if (text) {
          const served = {};
          summary = await runClaude(
            `${FACTS}\nSummarize the article text below for the reader. If the text is NOT a real news article (paywall/cookie/consent/error page, or near-empty), reply with EXACTLY the single word UNFETCHABLE.\n\nTitle: ${cleanTitle}\n\nARTICLE TEXT:\n${text.slice(0, 9000)}`,
            { timeoutMs: 120000, module: 'summary', model: modelFor('summary', 'claude-sonnet-5'), served });
          servedBy = served.by || '';
        }
      }
      if (summary === undefined) {
        // fallback: no reader text (or a [SIMILAR] job) → claude's own WebFetch/WebSearch
        const prompt = similar
          ? `The original article below could not be fetched. WebSearch the SAME news story and read it from a DIFFERENT provider.\n${FACTS}\n` +
            `PREFER these providers — they reliably allow fetching: Al Jazeera (aljazeera.com), AP (apnews.com), Reuters, BBC, The Guardian, NPR, The Hill, Politico, CBS/ABC/NBC News. AVOID these — they usually block automated fetch: Axios, DW, Time, Bloomberg, WSJ, NYT, FT, The Economist, Forbes.\n` +
            `Try SEVERAL preferred providers — actually WebFetch each candidate and verify you got real article text before summarizing. Only reply with EXACTLY the single word UNFETCHABLE if you have tried at least 4 different preferred providers and none returned readable text.\n` +
            `Begin the summary with the provider you used as a markdown link, e.g. "[via Al Jazeera](https://…)".\n\nStory: ${cleanTitle}\nOriginal (unfetchable) URL: ${job.URL}`
          : `Fetch and read this article. ${FACTS}\n` +
            `IF YOU CANNOT ACTUALLY FETCH AND READ THIS SPECIFIC ARTICLE (paywall, block, the redirect won't resolve, fetch fails): reply with EXACTLY the single word UNFETCHABLE and nothing else. Do NOT fabricate a summary from search results or general knowledge — a wrong/duplicate summary is worse than none.\n\nTitle: ${cleanTitle}\nURL: ${realUrl}`;
        const served = {};
        summary = await runClaude(prompt, { tools: 'WebFetch,WebSearch', timeoutMs: 240000, module: 'summary', model: modelFor('summary', 'claude-sonnet-5'), served });
        servedBy = served.by || '';
      }
      // Paywalled-feed fallback (Economist etc.): if still unfetchable, use the RSS
      // standfirst rather than leaving the card dead. Labeled so the reader knows it's the
      // blurb, not a full read — he can open the linked article on his subscription.
      if (!similar && /^\s*UNFETCHABLE\s*$/i.test(summary || '')) {
        const sf = await feedStandfirst(job.URL, job.Source);
        if (sf) { summary = `[${job.Source || 'source'} preview — couldn't fetch the full text; open the link to read it]\n- ${sf}`; servedBy = 'rss preview'; }
      }
      // store the resolved real URL so the card links to the actual article
      await ensureSummModelHeader();
      await appendTabRow(SUMM_TAB, SUMM_HEADERS_ALL, [realUrl, cleanTitle, job.Source || '', summary, nowIso(), '', servedBy]);
      summCache.at = 0;
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [[nowIso()]] } });
      track('agent', true, 'last summary ok');
      }
    } catch (e) {
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: doneCell, valueInputOption: 'RAW', requestBody: { values: [['error: ' + String(e.message).slice(0, 80)]] } });
      track('agent', false, e.message);
      console.error('agent summarize failed:', e.message);
    }
  } finally { agentBusy = false; }
  processAgentQueue().catch(() => {}); // chain: drain the rest
}
if (HAS_CLAUDE) setInterval(() => processAgentQueue().catch(() => {}), 20000);

app.post('/api/agent/queue', asyncRoute(async (req, res) => {
  const { title, url, source } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });
  // dedup against already-queued + already-summarized
  let pendingUrls = [];
  try { pendingUrls = (await readTab(TODO_SHEET_ID, AGENTQ_TAB, AGENTQ_HEADERS)).rows.filter(r => !String(r.Done || '').trim()).map(r => r.URL); } catch (e) {}
  const done = (await readSummariesTab(0)).some(s => s.URL === url && !String(s.State || '').trim());
  if (!done && !pendingUrls.includes(url)) {
    await appendTabRow(AGENTQ_TAB, AGENTQ_HEADERS, [title, url, source || '', nowIso(), '']);
    pendingUrls.push(url);
  }
  if (HAS_CLAUDE) processAgentQueue().catch(() => {});
  res.json({ ok: true, pending: pendingUrls.length, onMac: HAS_CLAUDE });
}));

// "Find similar": the article was unfetchable — drop that card and queue a job that
// searches OTHER providers for the same story, fetches one, and summarizes it.
app.post('/api/agent/find-similar', asyncRoute(async (req, res) => {
  const { title, url, source } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  await setSummaryState(url, 'dismissed').catch(() => {}); // remove the unfetchable card
  await appendTabRow(AGENTQ_TAB, AGENTQ_HEADERS, [`[SIMILAR] ${title}`, url || '', source || '', nowIso(), '']);
  if (HAS_CLAUDE) processAgentQueue().catch(() => {});
  res.json({ ok: true, onMac: HAS_CLAUDE });
}));

// Follow-up: the reader asks for more detail on an already-summarized story. Queues a
// [FOLLOWUP] job; the Mac/VM processor researches it and appends a dense second section
// to the existing summary (below a *** divider). Cross-instance like the rest.
app.post('/api/agent/summaries/followup', asyncRoute(async (req, res) => {
  const { url, question, source } = req.body || {};
  if (!url || !String(question || '').trim()) return res.status(400).json({ error: 'url and question required' });
  const q = String(question).trim().slice(0, 400);
  await appendTabRow(AGENTQ_TAB, AGENTQ_HEADERS, [`[FOLLOWUP] ${q}`, url, source || '', nowIso(), '']);
  // CI signal: asking a follow-up = strong engagement; the question text (in `context`) trains
  // the learner on the TYPES of detail the reader wants so future summaries can pre-empt them.
  const fb = JSON.stringify({ at: nowIso(), kind: 'followup_asked', signal: SIGNAL_BY_KIND.followup_asked, url, source: source || '', context: q });
  if (HAS_JOURNAL) { try { fs.appendFileSync(FEEDBACK_FILE, fb + '\n'); } catch (e) {} }
  else await appendTabRow(FB_TAB, FB_HEADERS, [fb, nowIso(), '']);
  if (HAS_CLAUDE) processAgentQueue().catch(() => {});
  res.json({ ok: true, onMac: HAS_CLAUDE });
}));

// Undo support: cancel a not-yet-run agent job + dismiss any summary already made.
app.post('/api/agent/cancel', asyncRoute(async (req, res) => {
  const { url } = req.body || {};
  try {
    const q = await readTab(TODO_SHEET_ID, AGENTQ_TAB, AGENTQ_HEADERS);
    const row = q.rows.find(r => r.URL === url && !String(r.Done || '').trim());
    if (row) await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${AGENTQ_TAB}'!${colLetter(q.headers.indexOf('Done'))}${row._row}`, valueInputOption: 'RAW', requestBody: { values: [['cancelled ' + nowIso()]] } });
  } catch (e) {}
  await setSummaryState(url, 'dismissed').catch(() => {});
  res.json({ ok: true });
}));

app.get('/api/agent/summaries', asyncRoute(async (req, res) => {
  const summaries = (await readSummariesTab()).filter(s => !String(s.State || '').trim())
    .map(s => ({ url: s.URL, title: s.Title, source: s.Source, summary: s.Summary, at: s.Created, model: s.Model || '' }))
    .reverse().slice(0, 30);
  let pending = 0;
  try { pending = (await readTab(TODO_SHEET_ID, AGENTQ_TAB, AGENTQ_HEADERS)).rows.filter(r => !String(r.Done || '').trim()).length; } catch (e) {}
  res.json({ summaries, pending });
}));

// Swipe right → stash to journal; swipe left → discard (+ feedback for CI)
app.post('/api/agent/summaries/stash', asyncRoute(async (req, res) => {
  const { url, kind } = req.body || {};
  const k = kind || 'summary_stashed'; // 'summary_to_reading' (+4) when pinned to the reading list
  const rows = await readSummariesTab(0);
  const s = rows.find(x => x.URL === url && !String(x.State || '').trim());
  if (!s) return res.status(404).json({ error: 'summary not found' });
  const where = await stashAnywhere(
    `- [Dashboard] Read for you: **${s.Title}** — ${String(s.Summary).replace(/\n+/g, ' ')} ([link](${s.URL}))`,
    { url: s.URL, source: s.Source, kind: 'media' });
  await setSummaryState(url, 'stashed');
  // feedback: weight from the kind (stash +2; reading-list pin +4) — route durably on cloud (no local jsonl there)
  const fb = JSON.stringify({ at: nowIso(), kind: k, signal: SIGNAL_BY_KIND[k] ?? 2, title: s.Title || '', url: s.URL || '', source: s.Source || '' });
  if (HAS_JOURNAL) { try { fs.appendFileSync(FEEDBACK_FILE, fb + '\n'); } catch (e) {} }
  else await appendTabRow(FB_TAB, FB_HEADERS, [fb, nowIso(), '']);
  res.json({ ok: true, where });
}));

// End-of-day sweep: auto-stash every un-dealt summary to the journal under a dated
// "Unread summaries" block, mark them stashed — but fire NO up/down signal (not engaging
// with something isn't a vote). Triggered nightly by ci.sh.
app.post('/api/agent/summaries/sweep', asyncRoute(async (req, res) => {
  const cutoff = Date.now() - 24 * 3600e3; // a summary gets a FULL DAY on screen before the sweep may take it
  const rows = (await readSummariesTab(0)).filter(s => !String(s.State || '').trim())
    .filter(s => { const t = Date.parse(s.Created || ''); return t && t < cutoff; });
  if (!rows.length) return res.json({ ok: true, swept: 0 });
  const today = nowIso().slice(0, 10);
  const block = `Unread summaries (auto-stashed ${today}):\n` +
    rows.map(s => `  - **${s.Title}** — ${String(s.Summary || '').replace(/\n+/g, ' ').slice(0, 500)} ([link](${s.URL}))`).join('\n');
  const where = await stashAnywhere(block, { kind: 'media' });
  for (const s of rows) await setSummaryState(s.URL, 'stashed').catch(() => {});
  res.json({ ok: true, swept: rows.length, where });
}));

// Generic stash (brief bullets, arbitrary text) — same cloud-safe path.
app.post('/api/stash', asyncRoute(async (req, res) => {
  const { text, url, source } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const where = await stashAnywhere(`- [Dashboard] ${text}${url ? ` ([link](${url}))` : ''}`, { url, source, kind: 'note' });
  res.json({ ok: true, where });
}));

// Drain pending queues — Mac-only (the heartbeat calls these): Stash → journal,
// Feedback → the local jsonl the CI agent reads. This is how iPhone/cloud swipes
// reach the learner even though they were recorded on an ephemeral container.
app.post('/api/stash/drain', asyncRoute(async (req, res) => {
  if (!HAS_JOURNAL) return res.status(501).json({ error: 'journal not on this instance' });
  const r = await drainTab(STASH_TAB, STASH_HEADERS, async row => row.Text && appendToJournal(row.Text, STASH_TARGET[row.Kind] || STASH_TARGET.note));
  res.json({ ok: true, ...r });
}));
app.post('/api/feedback/drain', asyncRoute(async (req, res) => {
  if (!HAS_JOURNAL) return res.status(501).json({ error: 'feedback jsonl not on this instance' });
  const r = await drainTab(FB_TAB, FB_HEADERS, async row => {
    if (!String(row.JSON || '').trim()) return true; // skip blank, count as drained
    fs.appendFileSync(FEEDBACK_FILE, row.JSON.trim() + '\n');
    return true;
  });
  res.json({ ok: true, ...r });
}));

// ---------- on-demand journal read (heartbeat Stage A) ----------
// Mac runs it directly; the phone (cloud) parks a request in the Sheet and the Mac
// drains it — so an early journal read can be fired from the phone when the owner knows
// the Mac is online.
const CTRL_TAB = 'Control Queue';
const CTRL_HEADERS = ['Action', 'Requested', 'Done'];
let journalRead = { running: false, lastStart: null, lastEnd: null, lastResult: '' };
const JOURNAL_MIN_GAP_MS = 10 * 60 * 1000; // throttle: at most one read per 10 min
function spawnJournalRead(force) {
  if (journalRead.running || !HAS_JOURNAL || !HAS_CLAUDE) return false;
  // defense-in-depth: never re-run within 10 min of the last start, so a mis-firing
  // trigger (a stuck queue row, a duplicate instance) can't loop the reader.
  if (!force && journalRead.lastStart && Date.now() - new Date(journalRead.lastStart) < JOURNAL_MIN_GAP_MS) return false;
  journalRead.running = true; journalRead.lastStart = nowIso();
  execFile('/bin/zsh', [path.join(__dirname, 'bin', 'journal-read.sh')], { timeout: 8 * 60 * 1000 },
    (err) => {
      journalRead.running = false; journalRead.lastEnd = nowIso();
      journalRead.lastResult = err ? ('error: ' + String(err.message).slice(0, 120)) : 'done';
      // refresh tasks so new journal todos show without a manual reload
      track('journal-read', !err, journalRead.lastResult);
    });
  return true;
}
app.post('/api/journal-read', asyncRoute(async (req, res) => {
  if (HAS_JOURNAL && HAS_CLAUDE) {
    if (journalRead.running) return res.json({ ok: true, where: 'mac', already: true });
    return res.json({ ok: spawnJournalRead(), where: 'mac', started: true });
  }
  // cloud: queue a request for the Mac to pick up
  await appendTabRow(CTRL_TAB, CTRL_HEADERS, ['journal-read', nowIso(), '']);
  res.json({ ok: true, where: 'queued' });
}));
app.get('/api/journal-read/status', (req, res) => res.json(journalRead));
// Mac drains journal-read requests parked by the phone
if (HAS_JOURNAL && HAS_CLAUDE) setInterval(() => {
  drainTab(CTRL_TAB, CTRL_HEADERS, async row => {
    if (String(row.Action || '').trim() === 'journal-read') spawnJournalRead();
    return true;
  }).catch(() => {});
}, 30000);

app.post('/api/agent/summaries/dismiss', asyncRoute(async (req, res) => {
  const { url } = req.body || {};
  const s = await setSummaryState(url, 'dismissed').catch(() => null);
  const fb = JSON.stringify({ at: nowIso(), kind: 'summary_discarded', signal: -1, title: s?.Title || '', url: url || '', source: s?.Source || '' });
  if (HAS_JOURNAL) { try { fs.appendFileSync(FEEDBACK_FILE, fb + '\n'); } catch (e) {} }
  else await appendTabRow(FB_TAB, FB_HEADERS, [fb, nowIso(), '']).catch(() => {});
  res.json({ ok: true });
}));

// Undo of a discard/stash: clear the row's State so the card reappears on the next poll.
// setSummaryState can't do this — it only matches rows whose State is still empty.
// (The −1 discard feedback is NOT retracted: one stray downweight is harmless, same
// convention as news skips.)
app.post('/api/agent/summaries/restore', asyncRoute(async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const rows = await readSummariesTab(0);
  const row = [...rows].reverse().find(r => r.URL === url && String(r.State || '').trim());
  if (row) {
    await store.values.update({
      spreadsheetId: TODO_SHEET_ID, range: `'${SUMM_TAB}'!${colLetter(SUMM_HEADERS.indexOf('State'))}${row._row}`,
      valueInputOption: 'RAW', requestBody: { values: [['']] },
    });
    summCache.at = 0;
  }
  res.json({ ok: !!row });
}));

// ---------- daily brief: what SHOULD be top of mind (claude over the news) ----------

const BRIEF_FILE = path.join(__dirname, 'data', 'brief.json');
let briefBuilding = false;
app.get('/api/brief', asyncRoute(async (req, res) => {
  if (!HAS_CLAUDE) {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!E1" }).catch(() => null);
    const c = r?.data.values?.[0]?.[0];
    if (c) { try { return res.json(JSON.parse(c)); } catch (e) {} }
    return res.json({ unavailable: true });
  }
  const cached = readJson(BRIEF_FILE, null);
  if (cached && Date.now() - new Date(cached.at) < 30 * 60 * 1000) return res.json(cached);
  if (briefBuilding) return res.json(cached || { building: true });
  briefBuilding = true;
  res.json(cached || { building: true }); // answer immediately; build in background
  try {
    const news = await withDismissals(await buildNews()); // exclude swipe-left dismissals
    // give the LLM ALL candidate headlines and let it judge salience (heuristic count can't)
    const order = { 'News': 0, 'Deep dives': 1, 'Books & Film': 2 };
    const cand = news.sections.flatMap(s => s.items.map(it => ({ ...it, sec: s.title }))).sort((a, b) => ((order[a.sec] ?? 0) - (order[b.sec] ?? 0)) || (b.salience - a.salience)).slice(0, 40);
    const lines = cand.map((it, i) => `${i}. [${it.sec}] ${it.title} — ${it.source}${it.age ? ', ' + it.age : ''} <${it.link}>`);
    const served = {};
    const raw = await runClaude(
      `You are the owner's chief of staff. From the numbered headlines, do TWO things.\n` +
      `(A) Pick the 3 MOST SALIENT HARD-NEWS developments and rank them. EXCLUDE fiction, creative writing, book reviews, routine hiring/funding listicles, and anything >48h old. Salience = genuine consequence to the owner${CFG.profile ? ' — ' + CFG.profile : ''}. Concrete events (an executive order, an IPO filing, a ceasefire step) outrank commentary.\n` +
      `(B) Write the brief: EXACTLY 3 lines, one per top story, each LEADING with the specific fact a headline omits — names, numbers, dates, dollar figures, status. NO humor, NO wordplay, NO preamble, NO hedging. Terse and dense. Hotlink the key noun of each line as a markdown [text](url) using the URL given.\n\n` +
      `The headlines below are self-contained — rank and write from them directly. You MAY use WebSearch/WebFetch to enrich a specific figure, but this is optional; if a fetch fails or a tool is unavailable, proceed anyway from the headline text. NEVER mention tools, access, or your own limitations in the output.\n` +
      `Return STRICT JSON only — no prose before or after, no code fences: {"top":[{"i":<number>,"detail":"the specific fact"}],"brief":"3 lines, one per story, with inline [text](url) links and hard specifics"}\n\nHEADLINES:\n${lines.join('\n')}`,
      { tools: 'WebFetch,WebSearch', timeoutMs: 180000, module: 'brief', model: modelFor('brief', 'claude-sonnet-5'), served });
    // Robustly extract the brief text — NEVER leak raw JSON to the UI. Strip code
    // fences, parse the {...} block; if that fails, regex-pull the "brief" value; if
    // it's plain prose use it; otherwise show a clean fallback (not the JSON dump).
    let text = '';
    const stripped = String(raw).replace(/```json?/gi, '').replace(/```/g, '').trim();
    const block = (stripped.match(/\{[\s\S]*\}/) || [])[0];
    let parsed = null;
    if (block) { try { parsed = JSON.parse(block); } catch (e) {} }
    if (parsed && typeof parsed.brief === 'string') {
      text = parsed.brief;
    } else {
      const bm = stripped.match(/"brief"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (bm) { try { text = JSON.parse('"' + bm[1] + '"'); } catch (e) { text = bm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'); } }
      else if (!/[{}]/.test(stripped)) text = stripped; // plain prose, no JSON → safe to use
      else text = ''; // looked like JSON but unparseable → do NOT show raw JSON
    }
    if (!text.trim()) text = 'Brief unavailable — the summarizer returned an unparseable response; it will refresh on the next build.';
    const briefObj = { at: nowIso(), text, model: served.by || '', promoted: [] }; // Top of mind intentionally empty
    writeJson(BRIEF_FILE, briefObj);
    store.values.update({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!E1", valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(briefObj).slice(0, 49000)]] } }).catch(e => console.error('brief cache:', e.message));
    // ✎ on the Agent brief heading: push each new brief out (signed + retried like list hooks)
    const bh = String(loadSettings().briefHook || '').trim();
    if (/^https?:\/\//.test(bh)) {
      const job = { hook: bh, payload: { event: 'brief', at: briefObj.at, brief: { text: briefObj.text } }, attempts: 0 };
      deliverHook(job)
        .then(() => track('webhook', true, 'brief → ' + bh.slice(0, 60)))
        .catch(e => { console.error('brief hook attempt 1 failed (queued):', e.message); queueHookRetry(job, e); });
    }
    track('brief', true);
  } catch (e) {
    track('brief', false, e.message);
    console.error('brief failed:', e.message);
  } finally { briefBuilding = false; }
}));

// ---------- multi-model providers (Vertex Gemini / Imagen, claude CLI, Anthropic) ----------

const providers = require('./providers');

app.get('/api/providers', asyncRoute(async (req, res) => {
  const p = await providers.listProviders();
  const vertexOk = p.text.find(t => t.id === 'vertex-gemini')?.available;
  track('vertex', !!vertexOk, vertexOk ? `${providers.GEMINI_MODEL} @ ${providers.VERTEX_LOCATION}` : p.text.find(t => t.id === 'vertex-gemini')?.error);
  res.json(p);
}));

app.post('/api/generate-text', asyncRoute(async (req, res) => {
  const { prompt, provider } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const out = await providers.generateText(prompt, provider);
    track('vertex', out.provider === 'vertex-gemini', out.provider);
    res.json(out);
  } catch (e) { track('vertex', false, e.message); throw e; }
}));

app.post('/api/generate-image', asyncRoute(async (req, res) => {
  const { prompt, count, aspectRatio } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const out = await providers.generateImage(prompt, { count, aspectRatio });
    track('imagen', true, providers.IMAGEN_MODEL);
    res.json(out);
  } catch (e) { track('imagen', false, e.message); throw e; }
}));

// ---------- diagnostics panel ----------

app.get('/api/diag', asyncRoute(async (req, res) => {
  const checks = {};
  // live IAM/API check: can we still read AND see write-scope on the master sheet?
  const t0 = Date.now();
  try {
    await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: `'${TODO_TAB}'!A3:A3` });
    checks.sheets = { ok: true, ms: Date.now() - t0 };
  } catch (e) { checks.sheets = { ok: false, error: e.message.slice(0, 200) }; }
  let authMode = 'adc (attached service account)', saEmail = null;
  try {
    if (fs.existsSync(KEY_FILE)) { authMode = 'key file'; saEmail = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).client_email; }
    else { const c = await auth.getClient(); saEmail = c.email || (await c.getAccessToken(), c.email) || null; }
  } catch (e) {}

  // Mac-only checks
  const local = {};
  if (HAS_JOURNAL) {
    try {
      const note = path.join(JOURNAL_DIR, today() + '.md');
      const txt = fs.existsSync(note) ? fs.readFileSync(note, 'utf8') : '';
      local.heartbeatMorning = txt.includes(`heartbeat: morning complete ${today()}`);
      local.heartbeatEvening = txt.includes(`heartbeat: evening complete ${today()}`);
      const hbLog = CFG.heartbeatLog; if (!hbLog) throw new Error('no heartbeat log configured');
      if (fs.existsSync(hbLog)) {
        const lines = fs.readFileSync(hbLog, 'utf8').trim().split('\n');
        local.lastHeartbeatLine = lines.filter(l => l.includes('=== heartbeat')).pop() || null;
      }
    } catch (e) { local.error = e.message; }
  }

  // actionable alerts, assembled server-side so both instances show the same logic
  const alerts = [];
  if (!checks.sheets.ok) alerts.push({ level: 'red', text: 'Sheets API failing — check service-account access to the master Sheet', detail: checks.sheets.error });
  if (diag.calendar?.lastError) alerts.push({ level: 'amber', text: 'Calendar not connected — enable the Calendar API + share the calendar with the SA (see README §Known issues)' });
  if (diag.vertex?.lastError) alerts.push({ level: 'amber', text: 'Vertex AI unavailable — run the GEMINI_SETUP.md enablement steps', detail: diag.vertex.lastError });
  if (diag.cds?.info && /^[01]\//.test(diag.cds.info)) alerts.push({ level: 'amber', text: 'CDS source coverage degraded', detail: diag.cds.info });
  if (HAS_JOURNAL && CFG.heartbeatLog && new Date().getHours() >= 8 && local.heartbeatMorning === false) alerts.push({ level: 'red', text: `Morning heartbeat has NOT run today — check the heartbeat scheduler and ${CFG.heartbeatLog}` });
  if (HAS_CLAUDE && diag.agent?.lastError) alerts.push({ level: 'amber', text: 'Last agent summary failed', detail: diag.agent.lastError });

  const pluginRows = [];
  for (const h of PLUGIN_HEALTH) {
    try { pluginRows.push(...((await h.fn(pluginCtx())) || [])); }
    catch (e) { pluginRows.push({ name: 'plugin ' + h._file, ok: false, info: e.message }); }
  }
  res.json({
    instance: HAS_CLAUDE ? 'mac' : 'cloud-run',
    startedAt: STARTED_AT,
    auth: { mode: authMode, serviceAccount: saEmail },
    checks,
    pluginRows,
    integrations: diag,
    caches: {
      news: newsCache.at ? new Date(newsCache.at).toISOString() : null,
      markets: marketCache.at ? new Date(marketCache.at).toISOString() : null,
      prefs: prefsCache.at ? new Date(prefsCache.at).toISOString() : null,
      yields: yieldsCache.at ? new Date(yieldsCache.at).toISOString() : null,
    },
    local,
    alerts,
  });
}));

// ---------- media feed watcher ----------
// "Media I'm following": new podcast episodes / posts appear as rows in the
// Media tab (→ the Reading/Listening queue) rather than as news coverage.
// Podcast names come from INSTANCES + any SOURCES row containing "podcast";
// feeds resolve via the iTunes Search API and the mapping persists in
// data/feeds.json (edit that file to correct a wrong resolution).

const FEEDS_FILE = path.join(__dirname, 'data', 'feeds.json');

async function resolveFeed(name) {
  let feeds = {};
  try { feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8')); } catch (e) {}
  let entry = feeds[name];
  if (typeof entry === 'string') entry = { feedUrl: entry }; // migrate old shape
  if (entry !== undefined && (entry === null || entry.collectionId !== undefined || entry.feedUrl)) {
    if (entry && entry.collectionId === undefined) { /* fall through to re-resolve for the id */ }
    else return entry; // null = known-unresolvable, skip
  }
  let resolved = null;
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&media=podcast&limit=1`);
    const j = await r.json();
    const hit = j.results?.[0];
    if (hit?.feedUrl) resolved = { feedUrl: hit.feedUrl, collectionId: hit.collectionId || null, showUrl: hit.collectionViewUrl || null };
  } catch (e) {}
  if (resolved === null && entry && entry.feedUrl) resolved = { ...entry, collectionId: null };
  feeds[name] = resolved;
  try { fs.mkdirSync(path.dirname(FEEDS_FILE), { recursive: true }); fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 1)); } catch (e) {}
  return resolved;
}

// Apple Podcasts episode pages (podcasts.apple.com/...?i=<id>) open the native
// Podcasts app on iOS — preferred over the publisher web link.
const normTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
async function appleEpisodeLinks(collectionId) {
  if (!collectionId) return new Map();
  try {
    const r = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=30`);
    const j = await r.json();
    const map = new Map();
    for (const ep of (j.results || []).slice(1)) {
      if (ep.trackName && ep.trackViewUrl) map.set(normTitle(ep.trackName), ep.trackViewUrl);
    }
    return map;
  } catch (e) { return new Map(); }
}

function parseDuration(s) {
  if (!s) return '';
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some(isNaN)) return '';
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  if (parts.length === 1) sec = parts[0]; // plain seconds
  return String(Math.round(sec / 60));
}

async function fetchEpisodes(feedUrl, sinceMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const pick = tag => decodeEntities((block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)) || [])[1] || '').trim();
      const pub = new Date(pick('pubDate'));
      if (isNaN(pub) || pub.getTime() < sinceMs) continue;
      const enclosure = (block.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || '';
      out.push({
        title: pick('title'),
        url: pick('link') || enclosure,
        lengthMin: parseDuration(pick('itunes:duration')),
        published: pub.toISOString().slice(0, 10),
      });
      if (out.length >= 5) break;
    }
    return out;
  } catch (e) { return []; } finally { clearTimeout(timer); }
}

async function refreshMediaFeeds() {
  // collect followed shows
  const names = new Set();
  for (const tab of ['INSTANCES', 'SOURCES']) {
    const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` }).catch(() => null);
    const rows = r ? r.data.values || [] : [];
    if (tab === 'INSTANCES') {
      const text = String((rows[0] || [])[0] || '').split(/movies/i)[0]; // podcasts are listed before the Movies/Series note
      text.split(/[,;]/).map(s => s.trim().replace(/\.$/, '')).filter(s => s && s.length < 40).forEach(s => names.add(s));
    } else {
      for (const row of prefRows(rows)) if (/podcast/i.test(String(row[0]))) names.add(String(row[0]).replace(/podcast/i, '').trim());
    }
  }
  const { headers, headerRow, rows } = await readMediaTab().catch(() => ({ headers: null }));
  if (!headers) return { added: 0, error: 'media tab unreadable' };
  const existing = new Set(rows.flatMap(r => [String(r.URL || '').trim(), (String(r.Source || '') + '|' + String(r.Title || '')).toLowerCase()]));
  const since = Date.now() - 14 * 86400000;
  const newRows = [];
  await pmap([...names], async (name) => {
    const feed = await resolveFeed(name);
    if (!feed || !feed.feedUrl) return;
    const episodes = await fetchEpisodes(feed.feedUrl, since);
    const appleLinks = episodes.length ? await appleEpisodeLinks(feed.collectionId) : new Map();
    for (const ep of episodes) {
      if (existing.has(ep.url) || existing.has((name + '|' + ep.title).toLowerCase())) continue;
      existing.add(ep.url);
      const url = appleLinks.get(normTitle(ep.title)) || ep.url; // prefer native Podcasts app link
      const rowObj = {
        Title: ep.title, Source: name, Type: 'audio', URL: url, Length_min: ep.lengthMin,
        Priority: '', Status: 'queued', Added: ep.published, Added_by: 'dashboard',
        Notes: 'auto: new episode detected', ID: crypto.randomUUID(),
      };
      newRows.push(headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
    }
  }, 4);
  if (newRows.length) {
    const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
    await store.values.update({
      spreadsheetId: TODO_SHEET_ID,
      range: `'${MEDIA_TAB}'!A${lastRow + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log(`media feed refresh: ${names.size} shows checked, ${newRows.length} new items`);
  track('feed_watcher', true, `${names.size} shows, +${newRows.length} new`);
  return { added: newRows.length, shows: names.size };
}

app.post('/api/media/refresh', asyncRoute(async (req, res) => {
  res.json(await refreshMediaFeeds());
}));

// ---------- US Treasury yield curve ----------

let yieldsCache = { at: 0, data: null };
// callable (not just an endpoint) so market tiles of type 'ustcurve' reuse the same cache
async function getYieldCurve() {
  if (yieldsCache.data && !yieldsCache.data.error && Date.now() - yieldsCache.at < 6 * 3600 * 1000) return yieldsCache.data;
  const months = [0, 1].map(back => {
    const d = new Date(); d.setMonth(d.getMonth() - back);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  let entries = [];
  for (const ym of months) {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) continue;
    const xml = await r.text();
    const es = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
    entries = es.concat(entries); // accumulate oldest-first across months
    if (entries.length >= 2) break;
  }
  if (!entries.length) return { error: 'treasury data unavailable' };
  const TENORS = [
    ['1M', 'BC_1MONTH'], ['3M', 'BC_3MONTH'], ['6M', 'BC_6MONTH'], ['1Y', 'BC_1YEAR'],
    ['2Y', 'BC_2YEAR'], ['3Y', 'BC_3YEAR'], ['5Y', 'BC_5YEAR'], ['7Y', 'BC_7YEAR'],
    ['10Y', 'BC_10YEAR'], ['20Y', 'BC_20YEAR'], ['30Y', 'BC_30YEAR'],
  ];
  const parseCurve = entry => {
    const pick = tag => { const m = entry.match(new RegExp(`<d:${tag}[^>]*>([^<]*)<`)); return m ? parseFloat(m[1]) : null; };
    return { date: ((entry.match(/<d:NEW_DATE[^>]*>([^<]*)</) || [])[1] || '').slice(0, 10),
      curve: TENORS.map(([label, tag]) => ({ tenor: label, yield: pick(tag) })).filter(p => p.yield != null) };
  };
  const today = parseCurve(entries[entries.length - 1]);
  const yesterday = entries.length > 1 ? parseCurve(entries[entries.length - 2]) : null;
  const curve = today.curve;
  const y2 = curve.find(p => p.tenor === '2Y')?.yield, y10 = curve.find(p => p.tenor === '10Y')?.yield;
  const data = { at: nowIso(), date: today.date, curve, prevCurve: yesterday?.curve || null, prevDate: yesterday?.date || null, spread2s10s: y2 != null && y10 != null ? Math.round((y10 - y2) * 100) : null };
  track('yields', true, `curve ${data.date}`);
  yieldsCache = { at: Date.now(), data };
  return data;
}
app.get('/api/yields', asyncRoute(async (req, res) => res.json(await getYieldCurve())));

// ---------- oil & gas futures strip (term structure, today + yesterday) ----------
// Yahoo monthly contract symbols: <ROOT><MONTHCODE><YY>.NYM. Oil=Brent (BZ),
// gas=Henry Hub (NG). Front continuous (BZ=F/NG=F) anchors the near end.
const MCODE = 'FGHJKMNQUVXZ';
// Generate forward contract-month symbols. `months` = how far out to look; quarterly roots
// (ES/NQ/YM/SR3/BTC trade Mar/Jun/Sep/Dec only) skip non-HMUZ months instead of 404ing on them.
function fwdContracts(root, months = 7, suffix = '.NYM', quarterly = false) {
  const out = []; const d = new Date(); let y = d.getUTCFullYear(), m = d.getUTCMonth();
  for (let i = 0; i < months; i++) {
    m++; if (m > 11) { m = 0; y++; }
    if (quarterly && ![2, 5, 8, 11].includes(m)) continue;
    out.push({ label: `${MCODE[m]}${String(y).slice(2)}`, sym: `${root}${MCODE[m]}${String(y).slice(2)}${suffix}` });
  }
  return out;
}
let stripCache = { at: 0, data: null };
app.get('/api/futures-strip', asyncRoute(async (req, res) => {
  if (stripCache.data && Date.now() - stripCache.at < 30 * 60 * 1000) return res.json(stripCache.data);
  async function strip(root, frontSym) {
    const front = await fetchLast2(frontSym);
    const months = fwdContracts(root, 7);
    const pts = await pmap(months, async (c) => { const v = await fetchLast2(c.sym); return v ? { label: c.label, today: v.today, yday: v.yday } : null; }, 4);
    const arr = [front ? { label: 'front', today: front.today, yday: front.yday } : null, ...pts].filter(Boolean);
    return arr;
  }
  const [oil, gas] = await Promise.all([strip('BZ', 'BZ=F'), strip('NG', 'NG=F')]);
  const data = { at: nowIso(), oil, gas, oilLabel: 'Brent ($/bbl)', gasLabel: 'Henry Hub ($/MMBtu)' };
  track('futures', oil.length > 0 || gas.length > 0, `oil ${oil.length}, gas ${gas.length}`);
  stripCache = { at: Date.now(), data };
  res.json(data);
}));

// ---------- sovereign CDS (worldgovernmentbonds.com) ----------
// Countries of interest = US + France + Qatar + anything mappable from
// Preferences LOCATIONS. The free source's main table covers the US and France
// but not Qatar or Sri Lanka — those render as "not covered". True trailing-year
// series isn't freely available, so the server snapshots each fetch into
// data/cds-history.json and the sparkline grows from accumulated history.

const CDS_HISTORY = path.join(__dirname, 'data', 'cds-history.json');
const COUNTRY_MAP = [
  [/qatar/i, 'Qatar'], [/france/i, 'France'], [/sri lanka/i, 'Sri Lanka'],
  [/\b(us|usa|md|tx|maryland|texas|bethesda|austin|united states)\b/i, 'United States'],
];

async function cdsCountries() {
  const base = ['United States', 'France', 'Qatar'];
  try {
    const r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: "'LOCATIONS'!A1:B" });
    for (const row of prefRows(r.data.values || [])) {
      for (const [re, country] of COUNTRY_MAP) if (re.test(String(row[0] || '')) && !base.includes(country)) base.push(country);
    }
  } catch (e) { /* fall back to the base three */ }
  return base;
}

// Fetch+cache the RAW table once (6h), parse whichever countries are asked for on demand —
// shared by the legacy /api/cds batch endpoint AND per-country 'cds' market tiles, so CDS
// tiles can now live in the SAME grid/drag/reorder system as everything else (2026-07-02:
// "why can't I drag the CDS box in line with the stocks" — because they weren't real tiles).
let cdsTextCache = { at: 0, text: null };
async function getCdsTableText() {
  if (cdsTextCache.text && Date.now() - cdsTextCache.at < 6 * 3600 * 1000) return cdsTextCache.text;
  const r = await fetch('https://www.worldgovernmentbonds.com/wp-json/cds/v1/main', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.worldgovernmentbonds.com', Referer: 'https://www.worldgovernmentbonds.com/sovereign-cds/' },
  }).catch(() => null);
  if (!r || !r.ok) throw new Error('CDS source unavailable');
  const j = await r.json();
  // normalize the table HTML to |Country|RATING|cds|±x.xx %|±x.xx %|pd %|dd Mon| rows
  // (decode entities first — &nbsp; between cells otherwise breaks pipe collapsing)
  const text = decodeEntities(String(j.table || '').replace(/&nbsp;/gi, ' '))
    .replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/( ?\| ?)+/g, '|');
  cdsTextCache = { at: Date.now(), text };
  return text;
}
function cdsHistory(country, cds5y) {
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(CDS_HISTORY, 'utf8')); } catch (e) {}
  if (cds5y != null) {
    hist[country] = hist[country] || {};
    hist[country][today()] = cds5y;
    try { fs.mkdirSync(path.dirname(CDS_HISTORY), { recursive: true }); fs.writeFileSync(CDS_HISTORY, JSON.stringify(hist, null, 1)); } catch (e) {}
  }
  const yearAgo = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
  const h = hist[country] || {};
  return Object.keys(h).sort().filter(d => d >= yearAgo).map(d => h[d]);
}
function cdsHistoryDated(country) { // [{t, v}] — for grouped plots that need a real time axis
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(CDS_HISTORY, 'utf8')); } catch (e) {}
  const h = hist[country] || {};
  return Object.keys(h).sort().map(d => ({ t: Date.parse(d), v: h[d] })).filter(p => Number.isFinite(p.t));
}
async function getCdsRow(country) {
  const text = await getCdsTableText();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc(country) + '\\|([A-Zu+\\- ]{1,10})\\|([\\d.,]+)\\|([+-]?[\\d.,]+) %\\|([+-]?[\\d.,]+) %\\|([\\d.,]+) %\\|(\\d+ \\w+)');
  const m = text.match(re);
  if (!m) { cdsHistory(country); return { country, error: 'not covered by free source' }; }
  const cds5y = parseFloat(m[2]), var1m = parseFloat(m[3]), var6m = parseFloat(m[4]);
  let spark = cdsHistory(country, cds5y);
  // Accumulated daily history lives in a per-tier local file — a fresh tier (Cloud Run/VM)
  // has none, so the plot showed nothing there. Until ≥3 real days exist, synthesize the
  // 6-months-ago and 1-month-ago anchor points from the source's own variation columns.
  let sparkSpan = '1y';
  if (spark.length < 3) { spark = [cds5y / (1 + var6m / 100), cds5y / (1 + var1m / 100), cds5y].map(v => Math.round(v * 100) / 100); sparkSpan = '6m'; }
  return { country, rating: m[1].trim(), cds5y, var1m, var6m, pd: parseFloat(m[5]), asOf: m[6], spark, sparkSpan };
}
app.get('/api/cds', asyncRoute(async (req, res) => {
  const wanted = await cdsCountries();
  let out;
  try { out = await pmap(wanted, getCdsRow, 4); }
  catch (e) { return res.json({ error: 'CDS source unavailable', countries: wanted.map(c => ({ country: c, error: 'source unavailable' })) }); }
  const covered = out.filter(c => !c.error).length;
  track('cds', covered > 0, `${covered}/${out.length} countries covered`);
  res.json({ at: nowIso(), countries: out, source: 'worldgovernmentbonds.com (5Y CDS)' });
}));

// ---------- market signals (long-term trends to watch; SSOT on the Sheet) ----------
// GUI-editable: add appends a row; edit updates cells by ID; remove sets Status=dropped
// (rows are never deleted, per Sheet protocol).
const SIGNALS_TAB = 'Signals';
const SIGNALS_HEADERS = ['Signal', 'Source', 'Why (one line)', 'AnalysisLink', 'Status', 'Added', 'Updated', 'ID', 'Trend'];
app.get('/api/signals', asyncRoute(async (req, res) => {
  // A2:I (not :H — Trend lives in column I and was silently dropped before)
  const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: "'Signals'!A2:I" });
  res.json({
    signals: (r.data.values || []).filter(v => v[0] && String(v[4] || '').toLowerCase() !== 'dropped').map(v => ({
      signal: v[0], source: v[1], why: v[2], link: v[3], status: v[4] || 'watching', added: v[5], id: v[7], trend: v[8] || '',
    })),
  });
}));
app.post('/api/signals', asyncRoute(async (req, res) => {
  const { signal, source, why, link, trend } = req.body || {};
  if (!signal || !String(signal).trim()) return res.status(400).json({ error: 'signal required' });
  const id = crypto.randomUUID();
  await appendTabRow(SIGNALS_TAB, SIGNALS_HEADERS,
    [String(signal).trim(), String(source || ''), String(why || ''), String(link || ''), 'watching', today(), '', id, String(trend || '')]);
  res.json({ ok: true, id });
}));
app.post('/api/signals/:id/update', asyncRoute(async (req, res) => {
  const tab = await readTab(TODO_SHEET_ID, SIGNALS_TAB, ['Signal', 'Status', 'ID']).catch(() => null);
  const row = tab && tab.rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'signal not found' });
  const ALLOWED = { signal: 'Signal', source: 'Source', why: 'Why (one line)', link: 'AnalysisLink', status: 'Status', trend: 'Trend' };
  const data = [];
  for (const [k, col] of Object.entries(ALLOWED)) {
    if (!(k in (req.body || {}))) continue;
    const idx = tab.headers.indexOf(col);
    if (idx === -1) continue;
    data.push({ range: `'${SIGNALS_TAB}'!${colLetter(idx)}${row._row}`, values: [[String(req.body[k] ?? '')]] });
  }
  const uIdx = tab.headers.indexOf('Updated');
  if (data.length && uIdx !== -1) data.push({ range: `'${SIGNALS_TAB}'!${colLetter(uIdx)}${row._row}`, values: [[today()]] });
  if (data.length) await store.values.batchUpdate({
    spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data },
  });
  res.json({ ok: true });
}));

app.get('/api/decisions', asyncRoute(async (req, res) => {
  const r = await cachedGet("'Decisions'!A2:I", 30000, STABLE_SHEET_ID);
  res.json({
    decisions: (r.data.values || []).slice(-100).map(v => ({
      at: v[0], host: v[1], module: v[2], actor: v[3], decision: v[4], why: v[5], parent: v[6], taskRef: v[7], costUsd: v[8],
    })).reverse(),
  });
}));

// ---------- agent incoming (what other agents did, last 48h, grouped) ----------

const AGENT_LABELS = { claw: 'Claw', mobile: 'Claude mobile', web: 'Claude web / dashboard', cowork: 'Cowork', code: 'Code (orchestrator)', dispatch: 'Dispatch' };
const MODULE_AGENT = { heartbeat: 'Code (orchestrator)', ci: 'Code (orchestrator)', brief: 'Dashboard agent', summary: 'Dashboard agent', 'heartbeat-cloud': 'VM failover', claw: 'Claw', 'generate-text': 'Dashboard agent', 'generate-image': 'Dashboard agent' };

app.get('/api/agent-incoming', asyncRoute(async (req, res) => {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const inWindow = ts => ts && !isNaN(new Date(ts)) && new Date(ts).getTime() >= cutoff;
  const groups = {};
  const g = name => groups[name] = groups[name] || { agent: name, activities: [], costUsd: 0 };
  Object.values(AGENT_LABELS).forEach(g); g('VM failover'); g('Dashboard agent');

  const { rows } = await readTodoTab();
  for (const t of rows) {
    const label = AGENT_LABELS[String(t.Source || '').toLowerCase()] || null;
    if (!label) continue;
    if (inWindow(t.Created) || (String(t.Created).length === 10 && new Date(t.Created + 'T23:59:59Z').getTime() >= cutoff)) {
      g(label).activities.push({ line: `Todo added: ${t.Task}`, cost: 0 });
    }
  }
  const dec = await cachedGet("'Decisions'!A2:I", 30000, STABLE_SHEET_ID).catch(() => null);
  for (const v of dec?.data.values || []) {
    if (!inWindow(v[0])) continue;
    const label = MODULE_AGENT[v[2]] || (CFG.vmHost && v[1] === CFG.vmHost ? 'VM failover' : 'Code (orchestrator)');
    const cost = parseFloat(v[8]) || 0;
    g(label).activities.push({ line: `${v[4]}${v[5] ? ' — ' + v[5] : ''}${v[3] ? ' [' + v[3] + ']' : ''}`, cost });
  }
  const use = await cachedGet("'Usage'!A2:H", 45000, STABLE_SHEET_ID).catch(() => null);
  for (const v of use?.data.values || []) {
    if (!inWindow(v[0])) continue;
    const label = MODULE_AGENT[v[2]] || (CFG.vmHost && v[1] === CFG.vmHost ? 'VM failover' : 'Code (orchestrator)');
    const cost = parseFloat(v[6]) || 0;
    g(label).costUsd += cost;
    g(label).activities.push({ line: `${v[2]} run [${v[3]}] — ${v[4]}+${v[5]} tok`, cost });
  }
  const out = Object.values(groups).map(grp => ({
    ...grp, costUsd: Math.round(grp.costUsd * 100) / 100,
    activities: grp.activities.slice(0, 15),
  })).sort((a, b) => b.activities.length - a.activities.length);
  res.json({ windowH: 48, costThreshold: 0.25, groups: out });
}));

// ---------- model usage breakdown + agent stable + filesystem ----------

// Pricing + source-of-funds classification live in the extracted agent-stable module
// (stable/pricing.js — the spinoff seed; see stable/README.md for the boundary rules).
const { MODEL_PRICES, priceOf, costClass, SELF_HOST_DEFAULTS, selfHostPerMTok } = require('./stable/pricing');

// ================= Agent Procurement Agent (APA) =================
// APA is the agent-stable's model-procurement brain. It scrapes model-release / pricing /
// benchmark news on a dedicated feed, decides when to TEST a new model (auto for the top-5 US
// labs) or propose an ARBITRAGE (hosting / non-US labs, for review), can auto-ADOPT a clearly
// better+cheaper model, and emits every finding + decision to the 'APA Feed' Sheet tab.
// ARCHITECTURAL BOUNDARY: APA never imports the news feed; the news manager is a read-only
// consumer of the APA Feed (withModelWatch). So APA stands alone as a product, and the news feed
// gets model news without searching for it twice.
const APA_SOURCES_FILE = path.join(__dirname, 'data', 'apa-sources.json');
const APA_STATE_FILE = path.join(__dirname, 'data', 'apa-state.json');       // runtime: lastScan, scraped prices
const MODEL_OVERRIDES_FILE = path.join(__dirname, 'data', 'model-overrides.json'); // runtime: adopted overrides
const APA_TAB = 'APA Feed';
const APA_HEADERS = ['ID', 'At', 'Kind', 'Lab', 'Model', 'Headline', 'URL', 'Salience', 'Action', 'Status', 'ForNews', 'Detail'];
function loadApaSources() { try { return JSON.parse(fs.readFileSync(APA_SOURCES_FILE, 'utf8')); } catch (e) { return { us_labs: [], other_labs: [], hosting: [], local: [], sources: [] }; } }
function apaState() { try { return JSON.parse(fs.readFileSync(APA_STATE_FILE, 'utf8')); } catch (e) { return { lastScan: '', prices: {} }; } }
function saveApaState(s) { try { fs.writeFileSync(APA_STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {} }
// module → adopted model. modelFor() is hoisted so the summary/brief calls above can consult it.
function modelFor(module, fallback) {
  try { const o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); if (o && o[module]) return o[module]; } catch (e) {}
  return fallback;
}
function apaFlag(name, dflt) { try { const o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); return o[name] !== undefined ? o[name] !== false : dflt; } catch (e) { return dflt; } }
function apaAutoAdopt() { return apaFlag('autoAdopt', true); }
function apaCrossProvider() { return apaFlag('crossProvider', true); }   // US-only cross-provider eval
const APA_ROLES_FILE = path.join(__dirname, 'data', 'apa-roles.json');           // committed defaults
const APA_ROLES_LOCAL = path.join(__dirname, 'data', 'apa-roles-local.json');    // runtime edits (user + CI), gitignored
const APA_ROLES_CELL = "'Heartbeat'!K1";                                         // cross-tier copy of the local layer
// merged view: user/CI runtime edits win over committed defaults. Roles carry an optional
// user-set `min` threshold (overrides APA's hypothesised cutoff) and `setBy`/`setAt` provenance
// so the CI can tell manual edits from its own. Top-level `selfHost` = OS costing assumptions.
function loadApaRoles() {
  let base = { roles: {}, track_non_us_os: 3 };
  try { base = JSON.parse(fs.readFileSync(APA_ROLES_FILE, 'utf8')); } catch (e) {}
  let local = {};
  try { local = JSON.parse(fs.readFileSync(APA_ROLES_LOCAL, 'utf8')); } catch (e) {}
  const roles = { ...(base.roles || {}) };
  for (const [k, v] of Object.entries(local.roles || {})) roles[k] = v === null ? undefined : { ...(roles[k] || {}), ...v };
  for (const k of Object.keys(roles)) if (!roles[k]) delete roles[k];
  return { ...base, ...local, roles, selfHost: { ...SELF_HOST_DEFAULTS, ...(local.selfHost || {}) }, osCostBasis: local.osCostBasis || 'hosted' };
}
function saveApaRolesLocal(local) {
  try { fs.writeFileSync(APA_ROLES_LOCAL, JSON.stringify(local, null, 2)); } catch (e) {}
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: APA_ROLES_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(local)]] } }).catch(() => {});
}
function apaRolesLocal() { try { return JSON.parse(fs.readFileSync(APA_ROLES_LOCAL, 'utf8')); } catch (e) { return {}; } }
async function syncApaRolesFromSheet() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: APA_ROLES_CELL });
    const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
    if (raw) { JSON.parse(raw); fs.writeFileSync(APA_ROLES_LOCAL, raw); }
  } catch (e) {}
}
// Overrides are cross-tier: written to a Sheet cell AND the local file. Summaries run on
// whichever HAS_CLAUDE tier (Mac or VM) drains the queue, so all tiers must agree on the model —
// syncOverridesFromSheet() pulls the cell into the local file every few minutes.
const OVERRIDE_CELL = "'Heartbeat'!I1";
function writeOverrides(o) {
  try { fs.writeFileSync(MODEL_OVERRIDES_FILE, JSON.stringify(o, null, 2)); } catch (e) {}
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: OVERRIDE_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(o)]] } }).catch(() => {});
}
function setModelOverride(module, model, note) {
  let o = { autoAdopt: true }; try { o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); } catch (e) {}
  o[module] = model; o['_' + module] = note || nowIso();
  writeOverrides(o);
}
async function syncOverridesFromSheet() {
  try {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: OVERRIDE_CELL });
    const raw = (((r.data.values || [[]])[0] || [])[0]) || '';
    if (raw) { JSON.parse(raw); fs.writeFileSync(MODEL_OVERRIDES_FILE, raw); } // parse-guard, then adopt
  } catch (e) {}
}
// price lookup: coded table first, then any price APA scraped for a new model
function apaPriceOf(model) { return priceOf(model) || (apaState().prices || {})[String(model || '').toLowerCase()] || null; }
// close the CI back-prop loop: the nightly CI records an "APA scoreboard" in the learnings file
// (which sources led to adopted/valuable model changes); the scan reads it to favour those sources.
function apaScoreboardHint() {
  try {
    const txt = fs.readFileSync(CFG.learningsFile, 'utf8'); // '' ⇒ throws ⇒ caller's catch treats as absent
    const m = txt.match(/APA scoreboard[\s\S]{0,700}/i);
    return m ? `\nCI-learned source scoreboard (favour high-scoring sources, discount low-signal ones):\n${m[0]}\n` : '';
  } catch (e) { return ''; }
}
function resolveClaudeModelId(name) {
  const s = String(name || '').toLowerCase().trim();
  if (/^claude-[a-z0-9-]+$/.test(s)) return s;
  const m = s.match(/claude\s+(opus|sonnet|haiku|fable)\s+([0-9]+(?:[.\-][0-9]+)?)/);
  if (m) return `claude-${m[1]}-${m[2].replace('.', '-')}`;
  return null;
}
// Evaluation engine extracted to agent-stable (stable/apa.js): head-to-head eval + judge +
// savings projection + the adopt gate. The host injects its adapters, price overlay (scraped
// prices included via apaPriceOf), judge model, and usage history; committing an adoption
// (setModelOverride + journal + Decisions row) stays HERE — the module only returns verdicts.
const { createApa } = require('./stable/apa');
const apaEngine = createApa({
  adapters: require('./providers').apaAdapters,
  priceOf: apaPriceOf,
  judge: (prompt) => runClaude(prompt, { timeoutMs: 60000, module: 'apa-judge', model: 'claude-sonnet-5' }),
  usageHistory: usageRows,
});
const apaProjectedSavings = (module, incId, candId) => apaEngine.projectSavings(module, incId, candId).catch(() => null);
const apaEval = (cand, inc) => { // cand/inc = { id, lab } → module wants { id, provider }
  const { apaProviderFor } = require('./providers');
  return apaEngine.evaluate({ id: cand.id, provider: apaProviderFor(cand.id, cand.lab) }, { id: inc.id, provider: apaProviderFor(inc.id, inc.lab) });
};
// normalize a scraped model name → a runnable id for its lab (best-effort; providers reject bad ids)
function apaModelId(name, lab) {
  const claude = resolveClaudeModelId(name);
  if (claude) return claude;
  const s = String(name || '').toLowerCase().trim().replace(/\s+/g, '-');
  return s || null;
}
// The Store/Notify boundary (2026-07-02 surgery): the decision flow lives in stable/apa.js
// (considerFinding); THIS is where the host's memory and voice plug in. Another deployment
// swaps these three objects (a JSON file, a Slack webhook, console.log) and the APA behaves
// identically — that was the last hard-wired piece before the repo split.
const apaHostDeps = {
  store: {
    recordPrice: (model, p) => { const s = apaState(); s.prices = s.prices || {}; s.prices[String(model).toLowerCase()] = { ...p, tier: 'scraped' }; saveApaState(s); },
    incumbent: (module) => modelFor(module, 'claude-sonnet-5'),
    adopt: (module, id, note) => setModelOverride(module, id, `APA auto-adopt ${nowIso()}: ${note}`), // Sheet-cell backed → reversible, cross-tier
  },
  notify: { // both land in the journal's Agent Log here; a Slack poster elsewhere
    info: line => appendToJournal(line),
    propose: line => appendToJournal(line),
  },
  log: (e) => logDecision({ module: 'apa', actor: 'apa', ...e }),
  resolveId: apaModelId,
  providerFor: (id, lab) => require('./providers').apaProviderFor(id, lab || id), // lab||id so a non-claude incumbent still resolves
  sameFamily: f => /anthropic|claude/.test(String(f.lab || '').toLowerCase()) || /^claude/.test(String(f.model || '').toLowerCase()),
};
async function apaConsider(it, usSet) {
  return apaEngine.considerFinding(it, { ...apaHostDeps, usLabs: [...usSet], crossProvider: apaCrossProvider(), autoAdopt: apaAutoAdopt() });
}
let apaBusy = false;
async function runApaScan({ force } = {}) {
  if (apaBusy || !HAS_CLAUDE) return { skipped: true };
  const st = apaState();
  if (!force && st.lastScan && Date.now() - new Date(st.lastScan).getTime() < 20 * 3600000) return { skipped: 'recent' };
  apaBusy = true;
  try {
    const cfg = loadApaSources();
    let feed = []; try { feed = (await readTab(STABLE_SHEET_ID, APA_TAB, APA_HEADERS)).rows; } catch (e) {}
    // dedup by lab/model but ALLOW re-surfacing after 10 days — a pre-release announcement must
    // not permanently suppress the actual release news (e.g. Fable pre-release vs July 1 GA).
    const seenAt = new Map();
    for (const r of feed) { const k = (String(r.Lab || '') + '/' + String(r.Model || '')).toLowerCase(); const t = new Date(r.At || 0).getTime() || 0; if (t > (seenAt.get(k) || 0)) seenAt.set(k, t); }
    const seen = { has: k => (Date.now() - (seenAt.get(k) || 0)) < 10 * 86400000, add: k => seenAt.set(k, Date.now()) };
    const usSet = new Set((cfg.us_labs || []).map(s => s.toLowerCase().split('/')[0]));
    const prompt = `You are the Agent Procurement Agent (APA) for this multi-model system. The current stable and API-list prices ($/1M in/out): ${JSON.stringify(MODEL_PRICES)}. Default for summaries/brief/orchestration = ${modelFor('summary', 'claude-sonnet-5')}.\n` +
      `Use WebSearch to find, from roughly the last 10 days, GENUINELY NEW developments that could give the owner BETTER and/or CHEAPER thinking:\n` +
      `- New model releases from the top US labs (${(cfg.us_labs || []).join(', ')}).\n` +
      `- Price cuts on models he could use.\n` +
      `- Benchmark/leaderboard shifts (Artificial Analysis, LMArena) where a cheaper model now matches a pricier one.\n` +
      `- Hosting/inference arbitrage (${(cfg.hosting || []).join(', ')}) and non-US labs (${(cfg.other_labs || []).join(', ')}) offering the same quality cheaper.\n` +
      `Prefer these sources: ${(cfg.sources || []).map(s => s.name).join(', ')}.${apaScoreboardHint()}${await apaCreditsSummary()}` +
      `For each item output {kind:"release|price|benchmark", lab, model, headline, url, priceIn, priceOut, salience (0-1, how much it could improve the owner's cost/quality), why}. Only REAL cited items with working URLs; never fabricate. Return STRICT JSON: {"items":[...]}. If nothing new, {"items":[]}.`;
    let raw; try { raw = await runClaude(prompt, { tools: 'WebSearch', timeoutMs: 200000, module: 'apa-scan', model: 'claude-sonnet-5' }); }
    catch (e) { apaBusy = false; return { error: e.message }; }
    const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
    let items = []; try { items = JSON.parse(block).items || []; } catch (e) {}
    const fresh = [];
    for (const it of items) {
      if (!it || !it.url || !/^https?:\/\//.test(it.url) || !it.headline) continue;
      const key = (String(it.lab || '') + '/' + String(it.model || '')).toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      fresh.push(it);
    }
    // write findings first, then act (so the feed reflects everything even if an action is slow)
    for (const it of fresh) {
      const lab = String(it.lab || '').toLowerCase();
      const action = (it.kind === 'release' && [...usSet].some(l => lab.includes(l))) ? 'test' : 'arbitrage';
      await appendTabRow(APA_TAB, APA_HEADERS, [crypto.randomUUID(), nowIso(), it.kind || '', it.lab || '', it.model || '', String(it.headline).slice(0, 200), it.url, String(it.salience ?? ''), action, 'new', (it.salience || 0) >= 0.4 ? '1' : '', String(it.why || '').slice(0, 300)], STABLE_SHEET_ID);
    }
    const outcomes = [];
    for (const it of fresh) outcomes.push(await apaConsider(it, usSet).catch(() => 'error'));
    st.lastScan = nowIso(); saveApaState(st);
    runApaBoard().catch(() => {}); // refresh the cost+benchmark board alongside the news scan
    // benchmark knowledge base refreshes weekly (CI also refines it nightly from outcomes)
    if (!st.benchAt || Date.now() - new Date(st.benchAt).getTime() > 7 * 86400000) {
      runApaBenchmarks().then(r => { if (r && r.found) { const s = apaState(); s.benchAt = nowIso(); saveApaState(s); } }).catch(() => {});
    }
    return { found: fresh.length, outcomes };
  } finally { apaBusy = false; }
}
// The news manager's ONE touch-point on APA: read the APA Feed's news-worthy rows and surface
// them as a "Model Watch" section. Read-only — APA never depends on the news feed.
async function withModelWatch(data) {
  let rows = []; try { rows = (await readTabCached(STABLE_SHEET_ID, APA_TAB, APA_HEADERS, 120000)).rows; } catch (e) { return data; }
  const cutoff = Date.now() - 10 * 86400000;
  const items = rows.filter(r => String(r.ForNews || '').trim() === '1' && r.At && new Date(r.At).getTime() >= cutoff)
    .sort((a, b) => new Date(b.At) - new Date(a.At)).slice(0, 8)
    .map(r => ({ title: r.Headline, link: r.URL, source: `APA · ${r.Lab || r.Kind}`, desc: r.Detail || '', section: 'Model Watch', following: true, apa: true }));
  if (!items.length) return data;
  return { ...data, sections: [...(data.sections || []), { title: 'Model Watch', items }] };
}
app.get('/api/apa/status', asyncRoute(async (req, res) => {
  let rows = []; try { rows = (await readTabCached(STABLE_SHEET_ID, APA_TAB, APA_HEADERS, 30000)).rows; } catch (e) {}
  const recent = rows.filter(r => r.At && Date.now() - new Date(r.At).getTime() < 30 * 86400000)
    .sort((a, b) => new Date(b.At) - new Date(a.At)).slice(0, 12)
    .map(r => ({ at: r.At, kind: r.Kind, lab: r.Lab, model: r.Model, headline: r.Headline, url: r.URL, action: r.Action, detail: r.Detail }));
  let overrides = {}; try { overrides = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); } catch (e) {}
  // lastScan is cross-tier: prefer the local marker, else derive from the newest feed row so the
  // cloud tier (which never scans) doesn't show "never" after the Mac has scanned.
  const lastScan = apaState().lastScan || (recent[0] && recent[0].at) || null;
  res.json({ lastScan, autoAdopt: apaAutoAdopt(), crossProvider: apaCrossProvider(), overrides, hasClaude: HAS_CLAUDE, recent });
}));
app.post('/api/apa/scan', asyncRoute(async (req, res) => {
  if (!HAS_CLAUDE) return res.status(503).json({ error: 'APA scan runs on the Mac/VM agent tier' });
  res.json({ started: true }); runApaScan({ force: true }).catch(e => console.error('apa scan:', e.message));
}));
app.post('/api/apa/revert', asyncRoute(async (req, res) => {
  const module = String((req.body && req.body.module) || 'summary');
  let o = {}; try { o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); } catch (e) {}
  delete o[module]; delete o['_' + module];
  writeOverrides(o);
  await logDecision({ module: 'apa', actor: 'owner', decision: `revert ${module} override`, why: 'manual revert' }).catch(() => {});
  res.json({ ok: true, module });
}));
app.post('/api/apa/config', asyncRoute(async (req, res) => {
  let o = {}; try { o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); } catch (e) {}
  const b = req.body || {};
  if (typeof b.autoAdopt === 'boolean') o.autoAdopt = b.autoAdopt;
  if (typeof b.crossProvider === 'boolean') o.crossProvider = b.crossProvider;
  writeOverrides(o);
  res.json({ ok: true, autoAdopt: o.autoAdopt !== false, crossProvider: o.crossProvider !== false });
}));

// ---- roles (use cases): user-editable benchmarks/thresholds, CI-refinable, cross-tier ----
app.get('/api/apa/roles', asyncRoute(async (req, res) => res.json(loadApaRoles())));
app.post('/api/apa/roles', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const local = apaRolesLocal(); local.roles = local.roles || {};
  const by = b.by === 'ci' ? 'ci' : 'owner';
  if (b.role) { // upsert or delete one role
    const key = String(b.role).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    if (!key) return res.status(400).json({ error: 'bad role key' });
    if (b.delete) local.roles[key] = null; // null tombstone removes a default role too
    else {
      const patch = {};
      for (const f of ['label', 'primary', 'winner']) if (typeof b[f] === 'string') patch[f] = b[f].slice(0, 60);
      if (typeof b.special === 'string') patch.special = b.special.slice(0, 400);
      if (Array.isArray(b.benchmarks)) patch.benchmarks = b.benchmarks.map(String).slice(0, 10);
      if (Array.isArray(b.fallbacks)) patch.fallbacks = b.fallbacks.map(String).filter(Boolean).slice(0, 5);
      if (b.min !== undefined) patch.min = b.min === null ? undefined : +b.min;
      if (Array.isArray(b.modules)) patch.modules = b.modules.map(String).slice(0, 12);
      local.roles[key] = { ...(local.roles[key] || {}), ...patch, setBy: by, setAt: nowIso() };
    }
  }
  if (b.selfHost && typeof b.selfHost === 'object') {
    const sh = {}; for (const f of ['kwhPrice', 'watts', 'tokPerSec']) if (b.selfHost[f] != null && isFinite(+b.selfHost[f])) sh[f] = +b.selfHost[f];
    local.selfHost = { ...(local.selfHost || {}), ...sh };
  }
  if (b.osCostBasis === 'hosted' || b.osCostBasis === 'selfhost') local.osCostBasis = b.osCostBasis;
  saveApaRolesLocal(local);
  // manual edits are first-class feedback for the CI loop — log them like any decision
  logDecision({ module: 'apa', actor: by, decision: `roles config edit${b.role ? ': ' + b.role + (b.delete ? ' (deleted)' : '') : ''}`, why: JSON.stringify({ min: b.min, primary: b.primary, benchmarks: b.benchmarks, selfHost: b.selfHost, osCostBasis: b.osCostBasis }).slice(0, 200) }).catch(() => {});
  res.json({ ok: true, roles: loadApaRoles() });
}));

// ---- main-dashboard agents summary: 24h work + key decisions + cost (funding split) + MTD ----
app.get('/api/agents/summary', asyncRoute(async (req, res) => {
  const now = Date.now(), day = now - 86400000;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const out = { activities: [], decisions: [], day: { input: 0, output: 0, real: 0, credit: 0, included: 0 }, month: { real: 0, credit: 0, included: 0 }, adopted: [] };
  let readFailures = 0;
  try { // usage → 24h tokens/cost split + month-to-date
    for (const v of (await cachedGet("'Usage'!A2:H", 300000, STABLE_SHEET_ID)).data.values || []) {
      const t = new Date(v[0]).getTime(); if (!t || t < monthStart.getTime()) continue;
      let cost = parseFloat(v[6]) || 0;
      if (!cost) { const p = priceOf(v[3]); if (p) cost = ((+v[4] || 0) * p.in + (+v[5] || 0) * p.out) / 1e6; }
      const cls = costClass(v[3], v[2], v[0]);
      out.month[cls] += cost;
      if (t >= day) { out.day.input += +v[4] || 0; out.day.output += +v[5] || 0; out.day[cls] += cost; }
    }
  } catch (e) { readFailures++; }
  try { // decisions → 24h key calls (skip routine chatter)
    const dec = ((await cachedGet("'Decisions'!A2:I", 300000, STABLE_SHEET_ID)).data.values || []).filter(v => new Date(v[0]).getTime() >= day);
    out.decisions = dec.filter(v => !/^(drained|routine|heartbeat: stage)/i.test(v[4] || '')).slice(-6).reverse()
      .map(v => ({ at: v[0], module: v[2], actor: v[3], decision: v[4], why: v[5] }));
    const byMod = {};
    for (const v of dec) byMod[v[2]] = (byMod[v[2]] || 0) + 1;
    out.activities = Object.entries(byMod).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ module: m, n }));
  } catch (e) { readFailures++; }
  try { const o = JSON.parse(fs.readFileSync(MODEL_OVERRIDES_FILE, 'utf8')); out.adopted = Object.keys(o).filter(k => !k.startsWith('_') && !['autoAdopt', 'crossProvider'].includes(k)).map(k => ({ module: k, model: o[k] })); } catch (e) {}
  const r2 = o => { for (const k in o) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100; return o; };
  // both source reads failed with no cached fallback (cold instance in a Sheets-quota
  // storm) → tell the client, which retries — silent zeros looked like a blank section
  res.json({ ...out, unavailable: readFailures >= 2 || undefined, day: r2(out.day), month: r2(out.month) });
}));

// ---- credits & quotas: subscription/credit pools, computed spend vs user-entered allowances ----
// Totals/expiries the APIs don't expose are USER-ENTERED assumptions (edited in the UI, synced
// cross-tier via Heartbeat!L1); "used" is computed live from the Usage tab by funding class.
// Interactive Claude Code (Fable) isn't metered by the stable — shown as an explicit assumption.
const CREDITS_FILE = path.join(__dirname, 'data', 'credits.json');
const CREDITS_CELL = "'Heartbeat'!L1";
const CREDITS_DEFAULT = {
  'claude-pool': { name: 'Claude agent credits (headless)', total: 100, period: 'month', until: '', note: 'Assumed $100/mo pool for headless claude -p runs (post 2026-06-15). Assumes no untracked spend.' },
  'gcp-credits': { name: 'GCP credits (Gemini/Vertex + VM)', total: null, period: 'all', until: '2026-08-31', note: 'ENTER TOTAL — Usage counts Gemini/Vertex calls only; VM runtime is not metered here.' },
  'grok-free': { name: 'xAI/grok monthly free tier', total: null, period: 'month', until: '', note: 'ENTER monthly free allowance — used = metered grok spend this month.' },
  'claude-sub': { name: 'Claude subscription (interactive incl. Fable 5)', total: null, period: 'month', until: '', note: 'Interactive Claude Code (your Fable sessions) is NOT metered by the stable — flat-rate subscription, assumed within plan. Enter a $-equivalent if you want it tracked.' },
};
function creditsCfg() { let o = {}; try { o = JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8')); } catch (e) {} const out = {}; for (const k of Object.keys(CREDITS_DEFAULT)) out[k] = { ...CREDITS_DEFAULT[k], ...(o[k] || {}) }; for (const k of Object.keys(o)) if (!out[k]) out[k] = o[k]; return out; }
function saveCreditsCfg(o) {
  try { fs.writeFileSync(CREDITS_FILE, JSON.stringify(o, null, 2)); } catch (e) {}
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: CREDITS_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(o)]] } }).catch(() => {});
}
async function syncCreditsFromSheet() { try { const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: CREDITS_CELL }); const raw = (((r.data.values || [[]])[0] || [])[0]) || ''; if (raw) { JSON.parse(raw); fs.writeFileSync(CREDITS_FILE, raw); } } catch (e) {} }
syncCreditsFromSheet(); setInterval(syncCreditsFromSheet, 10 * 60000);
// built-in pool matchers; custom pools declare a `match` regex over the model name so their
// metered usage can be computed the same way.
const CREDIT_MATCH = {
  'claude-pool': r => costClass(r.model, r.module, r.at) === 'credit' && /claude|sonnet|haiku|opus|fable/i.test(r.model),
  'gcp-credits': r => /gemini|vertex|imagen/i.test(r.model),
  'grok-free': r => /grok/i.test(r.model),
};
function creditMatcher(key, c) {
  if (CREDIT_MATCH[key]) return CREDIT_MATCH[key];
  if (c && c.match) { try { const re = new RegExp(c.match, 'i'); return r => re.test(r.model || '') || re.test(r.module || ''); } catch (e) {} }
  return null;
}
async function computeCredits() {
  const cfg = creditsCfg();
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const used = {};
  try {
    const rows = await usageRows();
    for (const [k, c] of Object.entries(cfg)) {
      const m = creditMatcher(k, c); if (!m) continue;
      used[k] = 0;
      for (const r of rows) {
        const t = new Date(r.at).getTime(); if (!t || !m(r)) continue;
        if (c.period === 'month' && t < monthStart.getTime()) continue;
        let cost = r.costUsd; if (!cost) { const p = priceOf(r.model); if (p) cost = (r.input * p.in + r.output * p.out) / 1e6; }
        used[k] += cost || 0;
      }
    }
  } catch (e) {}
  return Object.entries(cfg).map(([k, c]) => ({ key: k, ...c, used: used[k] != null ? Math.round(used[k] * 100) / 100 : null, tracked: used[k] != null }));
}
// one-line pool status for APA's scan prompt — expiring credits are an ARBITRAGE INPUT
// ("we have $X of Y expiring on Z — proposals that burn it are effectively free").
async function apaCreditsSummary() {
  try {
    const cs = await computeCredits();
    const lines = cs.filter(c => c.total != null || c.used != null).map(c => {
      const left = c.total != null && c.used != null ? Math.max(0, Math.round((c.total - c.used) * 100) / 100) : null;
      return `${c.name}: ${c.used != null ? '$' + c.used + ' used' : 'unmetered'}${c.total != null ? ` of $${c.total}${left != null ? ` ($${left} left)` : ''}` : ''}${c.until ? `, expires ${c.until}` : ''}${c.period === 'month' ? ', resets monthly' : ''}`;
    });
    return lines.length ? `\nCREDIT POOLS (prefer burning credits that would otherwise expire; treat expiring-credit providers as near-free in arbitrage math): ${lines.join(' | ')}\n` : '';
  } catch (e) { return ''; }
}
app.get('/api/credits', asyncRoute(async (req, res) => res.json({ credits: await computeCredits() })));
app.post('/api/credits', asyncRoute(async (req, res) => {
  const { key, name, total, note, until, match, period, del } = req.body || {};
  if (!key && !name) return res.status(400).json({ error: 'key or name required' });
  const cfg = creditsCfg();
  const k = key || String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  if (del) {
    if (CREDITS_DEFAULT[k]) return res.status(400).json({ error: 'built-in pools can be edited but not deleted' });
    delete cfg[k];
  } else {
    cfg[k] = cfg[k] || { name: name || k };
    if (typeof name === 'string' && name) cfg[k].name = name.slice(0, 60);
    if (total !== undefined) cfg[k].total = total === null || total === '' ? null : +total;
    if (typeof note === 'string') cfg[k].note = note.slice(0, 300);
    if (typeof until === 'string') cfg[k].until = until.slice(0, 20);
    if (typeof match === 'string') cfg[k].match = match.slice(0, 80);
    if (period === 'month' || period === 'all') cfg[k].period = period;
  }
  saveCreditsCfg(cfg);
  logDecision({ module: 'apa', actor: 'owner', decision: `credits config: ${del ? 'delete ' : ''}${k}`, why: del ? '' : `total=${cfg[k]?.total} until=${cfg[k]?.until} match=${cfg[k]?.match || ''}` }).catch(() => {});
  res.json({ ok: true, credits: await computeCredits() });
}));

// ---- APA benchmark board: cost + major benchmarks for the tracked models, grouped by use case ----
const APA_MODELS_TAB = 'APA Models';
const APA_MODELS_HEADERS = ['Model', 'Lab', 'Country', 'OS', 'Role', 'PriceIn', 'PriceOut', 'Benchmarks', 'Updated', 'Source'];
const APA_CUTOFF_CELL = "'Heartbeat'!J1";
let apaBoardBusy = false;
async function runApaBoard() {
  if (apaBoardBusy || !HAS_CLAUDE) return { skipped: true };
  apaBoardBusy = true;
  try {
    // prompt + parse are agent-stable logic (stable/board.js); LLM call + persistence stay here
    const cfg = loadApaSources();
    const bd = require('./stable/board').createBoard({ roles: loadApaRoles(), prices: MODEL_PRICES, labs: cfg });
    let raw; try { raw = await runClaude(bd.compilePrompt({ currentDefault: modelFor('summary', 'claude-sonnet-5') }), { tools: 'WebSearch', timeoutMs: 240000, module: 'apa-board', model: 'claude-sonnet-5' }); }
    catch (e) { return { error: e.message }; }
    const parsed = bd.parseCompile(raw);
    let models = parsed.models;
    if (!models.length) return { found: 0 };
    if (parsed.cutoffs) { // APA's per-task cutoff hypothesis — Sheet cell so the cloud tier gets it
      const s = apaState(); s.cutoffs = parsed.cutoffs; saveApaState(s);
      store.values.update({ spreadsheetId: TODO_SHEET_ID, range: APA_CUTOFF_CELL, valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(parsed.cutoffs)]] } }).catch(() => {});
    }
    await ensureTab(APA_MODELS_TAB, APA_MODELS_HEADERS, STABLE_SHEET_ID);
    await store.values.clear({ spreadsheetId: STABLE_SHEET_ID, range: `'${APA_MODELS_TAB}'!A2:Z1000` }); // replace board
    const rows = models.map(m => [String(m.model).slice(0, 60), m.lab || '', m.country || '', m.os ? '1' : '', m.role || '', String(m.priceIn ?? ''), String(m.priceOut ?? ''), JSON.stringify({ ...(m.benchmarks || {}), ...(m.host ? { _host: String(m.host).slice(0, 30) } : {}) }).slice(0, 900), nowIso(), String(m.source || '').slice(0, 120)]);
    await appendTabRows(APA_MODELS_TAB, APA_MODELS_HEADERS, rows, STABLE_SHEET_ID);
    // seed price table for any board model we don't already price (helps cost-compare later)
    const s = apaState(); s.prices = s.prices || {};
    for (const m of models) if (m.priceIn != null && m.priceOut != null) s.prices[String(m.model).toLowerCase()] = { in: +m.priceIn, out: +m.priceOut, tier: 'board' };
    saveApaState(s);
    return { found: rows.length };
  } finally { apaBoardBusy = false; }
}
app.get('/api/apa/models', asyncRoute(async (req, res) => {
  const roles = loadApaRoles();
  let rows = []; try { rows = (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows; } catch (e) {}
  const models = rows.map(r => {
    let b = {}; try { b = JSON.parse(r.Benchmarks || '{}'); } catch (e) {}
    const host = b._host || null;
    const bm = {}; for (const [k, v] of Object.entries(b)) if (!k.startsWith('_')) bm[k] = v;
    return { model: r.Model, lab: r.Lab, country: r.Country, os: String(r.OS || '').trim() === '1', role: r.Role, priceIn: r.PriceIn === '' ? null : +r.PriceIn, priceOut: r.PriceOut === '' ? null : +r.PriceOut, host, benchmarks: bm, source: r.Source, updated: r.Updated };
  });
  let cutoffs = apaState().cutoffs || null;
  if (!cutoffs) { try { const raw = (((await cachedGet(APA_CUTOFF_CELL, 300000)).data.values || [[]])[0] || [])[0]; if (raw) cutoffs = JSON.parse(raw); } catch (e) {} }
  res.json({ roles: roles.roles || {}, models, cutoffs, selfHost: { ...roles.selfHost, perMTokOut: selfHostPerMTok(roles.selfHost) }, osCostBasis: roles.osCostBasis, updated: models.length ? models[0].updated : null });
}));
app.post('/api/apa/board', asyncRoute(async (req, res) => {
  if (!HAS_CLAUDE) return res.status(503).json({ error: 'board compile runs on the Mac/VM agent tier' });
  res.json({ started: true }); runApaBoard().catch(e => console.error('apa board:', e.message));
}));

// ---- benchmark knowledge base: what each benchmark measures, which use cases it predicts,
// suggested cutoffs, current leader — compiled by APA, refined nightly by the CI, and rendered
// live at /benchmarks.html (so the "Benchmark" link exposes current knowledge, never a stale doc).
const APA_BENCH_TAB = 'APA Benchmarks';
const APA_BENCH_HEADERS = ['Benchmark', 'Measures', 'GoodFor', 'Cutoffs', 'Leader', 'Notes', 'Updated'];
let apaBenchBusy = false;
async function runApaBenchmarks() {
  if (apaBenchBusy || !HAS_CLAUDE) return { skipped: true };
  apaBenchBusy = true;
  try {
    // prompt + parse live in agent-stable (stable/board.js); orchestration + persistence stay here
    const bd = require('./stable/board').createBoard({ roles: loadApaRoles() });
    let raw; try { raw = await runClaude(bd.benchPrompt(), { tools: 'WebSearch', timeoutMs: 240000, module: 'apa-bench', model: 'claude-sonnet-5' }); }
    catch (e) { return { error: e.message }; }
    const items = bd.parseBench(raw);
    if (!items.length) return { found: 0 };
    await ensureTab(APA_BENCH_TAB, APA_BENCH_HEADERS, STABLE_SHEET_ID);
    await store.values.clear({ spreadsheetId: STABLE_SHEET_ID, range: `'${APA_BENCH_TAB}'!A2:Z200` });
    await appendTabRows(APA_BENCH_TAB, APA_BENCH_HEADERS, items.map(b => [b.name, b.measures || '', b.goodFor || '', b.cutoffs || '', b.leader || '', b.notes || '', nowIso()].map(v => String(v).slice(0, 800))), STABLE_SHEET_ID);
    return { found: items.length };
  } finally { apaBenchBusy = false; }
}
app.get('/api/apa/benchmarks', asyncRoute(async (req, res) => {
  let rows = []; try { rows = (await readTabCached(STABLE_SHEET_ID, APA_BENCH_TAB, APA_BENCH_HEADERS, 300000)).rows; } catch (e) {}
  // live leaderboard join: per benchmark, cheapest board model meeting each role's threshold
  let board = []; try { board = (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows; } catch (e) {}
  const roles = loadApaRoles();
  const models = board.map(r => { let b = {}; try { b = JSON.parse(r.Benchmarks || '{}'); } catch (e) {} return { model: r.Model, lab: r.Lab, os: String(r.OS || '').trim() === '1', priceOut: r.PriceOut === '' ? null : +r.PriceOut, benchmarks: b }; });
  let cutoffs = apaState().cutoffs || {};
  // fuzzy benchmark-name match: the knowledge compiler may expand names ("AA Intelligence
  // (Artificial Analysis…)") while board keys / role primaries stay short — prefix-match either way.
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
  const sameBench = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };
  const boardKeys = [...new Set(models.flatMap(m => Object.keys(m.benchmarks)))];
  const bench = rows.map(r => {
    const key = boardKeys.find(k => sameBench(k, r.Benchmark)) || r.Benchmark;
    const scored = models.filter(m => m.priceOut != null && m.benchmarks[key] != null).sort((a, b) => a.priceOut - b.priceOut);
    const top = [...scored].sort((a, b) => b.benchmarks[key] - a.benchmarks[key])[0] || null;
    const cheapestAt = {};
    for (const [role, rc] of Object.entries(roles.roles || {})) {
      const min = rc.min ?? (cutoffs[role] || {}).min;
      if (min == null || !sameBench(rc.primary, r.Benchmark)) continue;
      const hit = scored.find(m => m.benchmarks[key] >= min);
      if (hit) cheapestAt[role] = { model: hit.model, priceOut: hit.priceOut, score: hit.benchmarks[key], min };
    }
    return { name: r.Benchmark, measures: r.Measures, goodFor: r.GoodFor, cutoffs: r.Cutoffs, leader: r.Leader, notes: r.Notes, updated: r.Updated,
      boardTop: top ? { model: top.model, score: top.benchmarks[key] } : null, cheapestQualified: cheapestAt };
  });
  res.json({ benchmarks: bench, updated: rows[0] ? rows[0].Updated : null });
}));
app.post('/api/apa/benchmarks', asyncRoute(async (req, res) => {
  if (!HAS_CLAUDE) return res.status(503).json({ error: 'compile runs on the Mac/VM agent tier' });
  res.json({ started: true }); runApaBenchmarks().catch(e => console.error('apa bench:', e.message));
}));
// Auto-scan runs on the Mac only (HAS_JOURNAL) — single scanner avoids double decisions across
// tiers; the 20h lastScan guard + apaBusy dedup handle restarts. VM can still scan on-demand.
if (HAS_JOURNAL && HAS_CLAUDE) setInterval(() => runApaScan().catch(() => {}), 6 * 3600000);
// All agent tiers (Mac + VM) converge on adopted overrides + role edits from the Sheet cells.
if (HAS_CLAUDE) { syncOverridesFromSheet(); syncApaRolesFromSheet(); setInterval(() => { syncOverridesFromSheet(); syncApaRolesFromSheet(); }, 5 * 60000); }
else { syncApaRolesFromSheet(); } // cloud tier: pick up role edits made on other tiers at boot

async function usageRows() {
  const r = await cachedGet("'Usage'!A2:H", 45000, STABLE_SHEET_ID);
  return (r.data.values || []).map(v => ({
    at: v[0], host: v[1], module: v[2], model: v[3], input: +v[4] || 0, output: +v[5] || 0, costUsd: parseFloat(v[6]) || 0,
  }));
}

app.get('/api/model-usage', asyncRoute(async (req, res) => {
  const win = +req.query.days || 7;
  const cutoff = Date.now() - win * 86400000;
  const rows = (await usageRows()).filter(r => new Date(r.at).getTime() >= cutoff);
  const byModel = {};
  for (const r of rows) {
    const k = String(r.model || 'unknown').replace(/-20\d{6}$/, '');
    const m = byModel[k] = byModel[k] || { model: k, input: 0, output: 0, real: 0, credit: 0, included: 0 };
    m.input += r.input; m.output += r.output;
    // prefer the logged cost; if absent (grok logs none), estimate from the price table
    let cost = r.costUsd;
    if (!cost) { const p = priceOf(r.model); if (p) cost = (r.input * p.in + r.output * p.out) / 1e6; }
    m[costClass(r.model, r.module, r.at)] += cost;
  }
  const rnd = n => Math.round(n * 100) / 100;
  const list = Object.values(byModel).map(m => ({ ...m, real: rnd(m.real), credit: rnd(m.credit), included: rnd(m.included), total: rnd(m.real + m.credit + m.included) }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));
  const sum = k => list.reduce((n, m) => n + m[k], 0);
  res.json({ windowDays: win, models: list, tokIn: sum('input'), tokOut: sum('output'),
    totals: { real: rnd(sum('real')), credit: rnd(sum('credit')), included: rnd(sum('included')) } });
}));

// ---------- public showcase: sanitized agent-stable board ----------
// Feeds /public/agentstable (unauthenticated, carved out in the gate). Reads the SAME
// sheet tabs the private board uses, but the payload is allowlist-built: market data,
// tier config, headline-level APA events. NEVER include: usage history, credit pools/
// balances/expiries, the agent roster/jds, module names, event Detail/URL, any identity/
// calendar/location config, or wording that ties the board to a private deployment.
let pubStableCache = { at: 0, body: null };
app.get('/api/public/agentstable', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (Date.now() - pubStableCache.at < 60000 && pubStableCache.body) return res.json(pubStableCache.body);
  const roles = loadApaRoles();
  const cutoffs = apaState().cutoffs || {};
  const tiers = {};
  for (const [k, rc] of Object.entries(roles.roles || {})) {
    tiers[k] = { label: rc.label || k, primary: rc.primary || null, min: rc.min ?? (cutoffs[k] || {}).min ?? null,
      winner: rc.winner || null, fallbacks: rc.fallbacks || [] };
  }
  let models = [];
  try {
    models = (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows.map(r => {
      let b = {}; try { b = JSON.parse(r.Benchmarks || '{}'); } catch (e) {}
      const bm = {}; for (const [bk, v] of Object.entries(b)) if (!bk.startsWith('_')) bm[bk] = v;
      return { model: r.Model, lab: r.Lab, os: String(r.OS || '').trim() === '1', priceIn: r.PriceIn === '' ? null : +r.PriceIn,
        priceOut: r.PriceOut === '' ? null : +r.PriceOut, host: b._host || null, benchmarks: bm, updated: r.Updated };
    });
  } catch (e) {}
  let events = [];
  try {
    // Free-text guard: APA headlines/actions are compiled WITH private context (credit pools,
    // owner constraints), so the scanner's prose can leak it. Any event whose text brushes
    // against that context is dropped whole — never rewritten. Over-dropping is fine.
    const PRIVATE_TEXT = /credit|expir|\bowner|\bpool|quota|renewal|subscription/i;
    events = (await readTabCached(STABLE_SHEET_ID, APA_TAB, APA_HEADERS, 60000)).rows
      .filter(r => r.At && Date.now() - new Date(r.At).getTime() < 60 * 86400000)
      .filter(r => !PRIVATE_TEXT.test(`${r.Headline} ${r.Action} ${r.Detail} ${r.Kind}`))
      .sort((a, b) => new Date(b.At) - new Date(a.At)).slice(0, 20)
      .map(r => ({ at: r.At, kind: r.Kind, lab: r.Lab, model: r.Model, headline: r.Headline, action: r.Action }));
  } catch (e) {}
  let benchmarks = [];
  try {
    benchmarks = (await readTabCached(STABLE_SHEET_ID, APA_BENCH_TAB, APA_BENCH_HEADERS, 300000)).rows
      .map(r => ({ name: r.Benchmark, measures: r.Measures, goodFor: r.GoodFor, leader: r.Leader, updated: r.Updated }));
  } catch (e) {}
  const body = { generatedAt: nowIso(), tiers,
    board: { models, selfHostPerMTokOut: selfHostPerMTok(roles.selfHost), osCostBasis: roles.osCostBasis },
    events, benchmarks };
  pubStableCache = { at: Date.now(), body };
  res.json(body);
}));

// Machine-readable tier recommendations — what external apps poll to learn the current
// workhorse/steeldust/thoroughbred/etc winner. CORS-open, read-only, no identity: just
// tier → model + list price + fallbacks. Consumers: resolve at config/startup time,
// cache ~1h, walk fallbacks in order when the winner errors.
app.get('/api/public/agentstable/tiers', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const roles = loadApaRoles();
  const cutoffs = apaState().cutoffs || {};
  let board = [];
  try { board = (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows; } catch (e) {}
  const priceRow = m => board.find(r => r.Model === m);
  const tiers = {};
  for (const [k, rc] of Object.entries(roles.roles || {})) {
    const p = rc.winner ? priceRow(rc.winner) : null;
    const pt = !p && rc.winner ? priceOf(rc.winner) : null; // board row first, price table as fallback
    tiers[k] = { model: rc.winner || null,
      priceIn: p && p.PriceIn !== '' ? +p.PriceIn : (pt ? pt.in : null),
      priceOut: p && p.PriceOut !== '' ? +p.PriceOut : (pt ? pt.out : null),
      fallbacks: rc.fallbacks || [], benchmark: rc.primary || null, min: rc.min ?? (cutoffs[k] || {}).min ?? null,
      label: rc.label || k };
  }
  res.json({ generatedAt: nowIso(), tiers });
}));

// ---------- the Form Guide (Phase 1, read-only) ----------
// Community model×task database (spec: agent-stable repo, spec/FORM-GUIDE.md).
// Phase 1 ships no database and NO fabricated thresholds: each task maps to the
// benchmark judged most predictive (basis: prior); recommend() = cheapest of the
// top-3 on that benchmark. NO LLM in any request path — table lookups only.
// Curated L1/L2; community subdivision + reports arrive in Phase 2.
const FORM_GUIDE = {
  code:        { label: 'Code',        bench: 'AA Coding Index', alt: 'SWE-bench Verified',
                 l2: ['generate', 'debug', 'review', 'refactor', 'test-writing', 'architecture', 'completion'] },
  agentic:     { label: 'Agentic',     bench: 'AA Agentic Index', alt: 'AA Intelligence',
                 l2: ['orchestration', 'tool-calling', 'multi-step-planning', 'browser-use', 'computer-use', 'long-horizon'] },
  analysis:    { label: 'Analysis',    bench: 'GPQA Diamond', alt: 'AA Intelligence',
                 l2: ['quantitative', 'legal', 'scientific', 'financial', 'causal-reasoning'] },
  writing:     { label: 'Writing',     bench: 'LMArena', alt: 'AA Intelligence',
                 l2: ['technical', 'creative', 'editing', 'summarization', 'translation'] },
  extraction:  { label: 'Extraction',  bench: 'MMLU-Pro', alt: 'AA Intelligence',
                 l2: ['classification', 'structured-output', 'entity-extraction', 'ocr-cleanup'] },
  research:    { label: 'Research',    bench: 'HLE', alt: 'AA Intelligence',
                 l2: ['web-research', 'literature-review', 'fact-checking', 'synthesis'] },
  conversation:{ label: 'Conversation', bench: 'LMArena', alt: 'AA Intelligence',
                 l2: ['support', 'tutoring', 'roleplay'] },
  math:        { label: 'Math',        bench: 'AIME', alt: 'MATH-500',
                 l2: ['proof', 'computation', 'word-problems', 'formalization'] },
  vision:      { label: 'Vision',      bench: 'AA Intelligence',
                 l2: ['understanding', 'chart-reading', 'document-parsing', 'spatial'] },
  generation:  { label: 'Generation',  bench: 'LMArena Image (t2i)',
                 l2: ['image'] },
};
// Benchmark backbone: Artificial Analysis data API (free tier — standardized indices +
// pricing; attribution required, https://artificialanalysis.ai). Cached 6h in-memory
// (~4 req/day per instance against a 100/day key limit). No key or API failure →
// fall back to the sheet-compiled board so the Form Guide keeps working.
let aaCache = { at: 0, models: null };
async function aaModels() {
  const key = CFG.aaApiKey;
  if (!key) return null;
  if (Date.now() - aaCache.at < 6 * 3600000 && aaCache.models) return aaCache.models;
  try {
    const r = await fetch('https://artificialanalysis.ai/api/v2/language/models/free',
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.data || j.models || []);
    const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;
    const models = rows.map(m => {
      const ev = m.evaluations || m.evals || m;
      const pr = m.pricing || m;
      const bm = {};
      const put = (k, v) => { const n = num(v); if (n != null) bm[k] = Math.round(n * 10) / 10; };
      put('AA Intelligence', ev.artificial_analysis_intelligence_index);
      put('AA Coding Index', ev.artificial_analysis_coding_index);
      put('AA Agentic Index', ev.artificial_analysis_agentic_index);
      return { model: m.slug || m.id || m.name, lab: (m.model_creator && m.model_creator.name) || m.creator || m.organization || '',
        os: !!(m.licensing ? m.licensing.is_open_weights : m.is_open_weights),
        priceIn: num(pr.price_1m_input_tokens), priceOut: num(pr.price_1m_output_tokens), benchmarks: bm };
    }).filter(m => m.model && Object.keys(m.benchmarks).length);
    if (models.length) { aaCache = { at: Date.now(), models }; return models; }
  } catch (e) { console.error('AA api:', e.message); }
  return aaCache.models; // stale beats none; null on cold failure → sheet fallback
}
async function formGuideModels() {
  const aa = await aaModels();
  if (aa) return { source: 'artificialanalysis.ai', models: aa };
  const rows = (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows;
  return { source: 'board', models: rows.map(r => {
    let b = {}; try { b = JSON.parse(r.Benchmarks || '{}'); } catch (e) {}
    const bm = {}; for (const [bk, v] of Object.entries(b)) if (!bk.startsWith('_')) bm[bk] = v;
    return { model: r.Model, lab: r.Lab, os: String(r.OS || '').trim() === '1',
      priceIn: r.PriceIn === '' ? null : +r.PriceIn, priceOut: r.PriceOut === '' ? null : +r.PriceOut, benchmarks: bm };
  }) };
}
app.get('/api/public/formguide', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  let src = { source: 'board', models: [] }; try { src = await formGuideModels(); } catch (e) {}
  res.json({ generatedAt: nowIso(), phase: 1, basis: 'prior', taxonomy: FORM_GUIDE, models: src.models,
    source: src.source, attribution: src.source === 'artificialanalysis.ai' ? 'Benchmark and pricing data: Artificial Analysis (https://artificialanalysis.ai)' : undefined });
}));
app.get('/api/public/formguide/recommend', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const task = String(req.query.task || '').trim().toLowerCase();
  const node = FORM_GUIDE[task.split('.')[0]];
  if (!node) return res.status(404).json({ error: 'unknown task', tasks: Object.keys(FORM_GUIDE) });
  let src = { source: 'board', models: [] }; try { src = await formGuideModels(); } catch (e) {}
  const models = src.models;
  const scored = b => models.filter(m => m.benchmarks[b] != null).sort((x, y) => y.benchmarks[b] - x.benchmarks[b]);
  let bench = node.bench, ranked = scored(bench);
  if (ranked.length < 2 && node.alt) { bench = node.alt; ranked = scored(bench); }
  if (ranked.length < 2 && bench !== 'AA Intelligence') { bench = 'AA Intelligence'; ranked = scored(bench); }
  if (!ranked.length) return res.status(503).json({ error: 'board has no scores yet for this task', task, benchmark: bench });
  const top = ranked.slice(0, 3);
  const priced = top.filter(m => m.priceOut != null);
  const pick = (priced.length ? priced : top).slice().sort((x, y) => (x.priceOut ?? 1e9) - (y.priceOut ?? 1e9))[0];
  res.json({ task, basis: 'prior', benchmark: bench, min_score: null, n_reports: 0,
    model: pick.model, score: pick.benchmarks[bench], priceIn: pick.priceIn, priceOut: pick.priceOut,
    alternatives: top.filter(m => m.model !== pick.model).map(m => ({ model: m.model, score: m.benchmarks[bench], priceIn: m.priceIn, priceOut: m.priceOut })),
    source: src.source,
    attribution: src.source === 'artificialanalysis.ai' ? 'Benchmark and pricing data: Artificial Analysis (https://artificialanalysis.ai)' : undefined,
    note: 'threshold unrated until community reports exist — this is the cheapest of the top-3 on ' + bench });
}));

// Agent stable — declared roster (active + standby) joined with 7d usage by module.
// useCase ties each agent to a board role (winner/fallbacks come from the roles config);
// jd = collapsed job description shown on the agents page.
// Agent roster — instance-specific, loaded from data/agents-roster.json (NOT in the
// public export whitelist and NOT hardcoded here: the roster describes a person's
// actual agent fleet, schedules, and escalation paths — exactly what must never ship
// in the stub or its git history). Fresh installs get an empty stable with a hint.
let AGENT_STABLE = [];
try { AGENT_STABLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'agents-roster.json'), 'utf8')); } catch (e) {}

app.get('/api/agent-stable', asyncRoute(async (req, res) => {
  const cutoff = Date.now() - 7 * 86400000;
  const rows = (await usageRows()).filter(r => new Date(r.at).getTime() >= cutoff);
  const dec = await cachedGet("'Decisions'!A2:I", 30000, STABLE_SHEET_ID).catch(() => null);
  const decRows = (dec?.data.values || []).filter(v => new Date(v[0]).getTime() >= cutoff);
  const rolesCfg = loadApaRoles();
  const out = AGENT_STABLE.map(a => {
    const u = rows.filter(r => a.modules.includes(r.module));
    const acts = [...u.map(r => `${r.module} run [${r.model.replace(/-20\d{6}$/, '')}] — ${r.input}+${r.output} tok`),
                  ...decRows.filter(v => a.modules.includes(v[2])).map(v => v[4])];
    const cost = u.reduce((n, r) => n + r.costUsd, 0);
    const cls = u.length ? costClass(u[0].model, u[0].module, u[0].at) : costClass(a.model, a.modules[0]);
    // effective model = APA override for the agent's primary module, else registry default;
    // useCase label + current role winner/fallbacks come from the roles config so the stable
    // reads e.g. "Summarizer — Daily driver: claude-sonnet-5 (fallback gemini-2.5-pro)"
    const rc = rolesCfg.roles[a.useCase] || {};
    return { ...a, model: modelFor(a.modules[0], a.model), tasks: u.length,
      useCaseLabel: rc.label || a.useCase || '', winner: rc.winner || '', fallbacks: rc.fallbacks || [], special: rc.special || '',
      input: u.reduce((n, r) => n + r.input, 0), output: u.reduce((n, r) => n + r.output, 0),
      costUsd: Math.round(cost * 100) / 100, costClass: cls, activities: acts.slice(0, 8) };
  });
  res.json({ active: out.filter(a => a.status === 'active').length, standby: out.filter(a => a.status !== 'active').length, agents: out });
}));

// Filesystem overview — tracked roots with file counts + changes in the last 24h.
// roots come from config (fsRoots: [{key, path, vm?, note?}]); default = the journal vault
const FS_ROOTS = (CFG.fsRoots.length ? CFG.fsRoots
  : (VAULT_DIR ? [{ key: 'Journal', path: VAULT_DIR, vm: false }] : []));
app.get('/api/filesystem', asyncRoute(async (req, res) => {
  if (HAS_CLAUDE === false) {
    const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!D1" }).catch(() => null);
    const cached = r?.data.values?.[0]?.[0];
    if (cached) { try { return res.json({ ...JSON.parse(cached), cached: true }); } catch (e) {} }
    return res.json({ unavailable: true, note: 'filesystem snapshot not yet cached — open the Mac instance once' });
  }
  const { execSync } = require('child_process');
  const out = FS_ROOTS.filter(r => !r.vm).map(r => {
    try {
      const find = `find ${JSON.stringify(r.path)} -type f ! -name '.DS_Store' ! -path '*/node_modules/*' ! -path '*/.git/*'`;
      const total = parseInt(execSync(`${find} | wc -l`, { encoding: 'utf8' }).trim()) || 0;
      const recent = execSync(`${find} -mtime -1 2>/dev/null | head -12`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        .map(p => p.replace(process.env.HOME, '~').replace(/.*\/My Drive\//, '…/'));
      return { ...r, total, changed: recent.length, recent };
    } catch (e) { return { ...r, error: e.message.slice(0, 60) }; }
  });
  const totalFiles = out.reduce((n, r) => n + (r.total || 0), 0);
  const snapshot = { at: nowIso(), totalFiles, changed24h: out.reduce((n, r) => n + (r.changed || 0), 0), roots: out };
  // cache to the sheet so the Cloud Run instance (no Mac FS) can serve it too
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: "'Heartbeat'!D1",
    valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(snapshot).slice(0, 49000)]] } }).catch(() => {});
  res.json(snapshot);
}));

// ---------- usage ledger (model choice + tokens by module, central on the Sheet) ----------

app.get('/api/usage', asyncRoute(async (req, res) => {
  const r = await cachedGet("'Usage'!A2:H", 45000, STABLE_SHEET_ID);
  const rows = (r.data.values || []).map(v => ({
    at: v[0], host: v[1], module: v[2], model: v[3],
    input: +v[4] || 0, output: +v[5] || 0, costUsd: parseFloat(v[6]) || 0, note: v[7] || '',
  }));
  const cutoff7 = Date.now() - 7 * 86400000;
  const agg = {};
  for (const row of rows) {
    if (new Date(row.at).getTime() < cutoff7) continue;
    const k = row.module + '|' + row.model;
    const a = agg[k] = agg[k] || { module: row.module, model: row.model, runs: 0, input: 0, output: 0, costUsd: 0, hosts: new Set() };
    a.runs++; a.input += row.input; a.output += row.output; a.costUsd += row.costUsd; a.hosts.add(row.host);
  }
  res.json({
    last7d: Object.values(agg).map(a => ({ ...a, hosts: [...a.hosts] }))
      .sort((x, y) => (y.input + y.output) - (x.input + x.output)),
    totalRows: rows.length,
  });
}));

// Reveal a path in Finder (Mac instance only) — FM links call this; browsers block file://
app.get('/api/open', (req, res) => {
  if (!HAS_CLAUDE) return res.status(501).json({ error: 'Mac instance only' });
  const p = req.query.path;
  if (!p || p.includes('..')) return res.status(400).json({ error: 'bad path' });
  require('child_process').execFile('/usr/bin/open', ['-R', p.replace(/^~/, os.homedir())], (e) => e ? res.status(500).json({ error: e.message }) : res.json({ ok: true }));
});

// ---------- startup ----------

function localIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`${a.address} (${name})`);
    }
  }
  return out;
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Dashboard listening on 0.0.0.0:${PORT}`);
  for (const ip of localIPs()) console.log(`  → http://${ip.split(' ')[0]}:${PORT}  ${ip.split(' ')[1] || ''}`);
  try {
    if (fs.existsSync(KEY_FILE)) console.log(`Service account (key file): ${JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).client_email}`);
    else console.log('Auth: Application Default Credentials (attached service account)');
    const meta = await store.spreadsheets.get({ spreadsheetId: TODO_SHEET_ID });
    console.log(`Sheets API OK — "${meta.data.properties.title}" [${meta.data.sheets.map(s => s.properties.title).join(', ')}]`);
  } catch (e) {
    console.error('Sheets API startup check FAILED:', e.message);
  }
  // feed watcher: on startup and every 6h, drop new episodes into the Media tab
  refreshMediaFeeds().catch(e => console.error('media feed refresh failed:', e.message));
  setInterval(() => refreshMediaFeeds().catch(e => console.error('media feed refresh failed:', e.message)), 6 * 3600 * 1000);
});
