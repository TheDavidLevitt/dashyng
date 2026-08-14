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
// Tab name is per-deployment: existing sheets keep their historical name, a fresh one
// gets the plain 'Todo'. ("Eisenhower" is jargon that earned its way off the UI.)
const TODO_TAB = CFG.todoTab || 'Todo (Eisenhower Matrix)';
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
  'https://www.googleapis.com/auth/drive',    // rw: /ranmali donate checklist reparents photos between shared Thriftr folders
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
      [TODO_TAB]: ['Task', 'Quadrant', 'Scope', 'Owner', 'Due', 'Status', 'Created', 'Notes', 'Source', 'Updated', 'Tags', 'ID', 'Order', 'Parent'],
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
// Biotech-tracker guests (CFG.bioEmails): same Google sign-in, but confined to the
// tracker's page + its own API namespace. Same shape as the game guests above — a second
// scoped identity, NOT a second auth system. The owner (ALLOWED_EMAIL) always has access.
const BIO_ROUTE = CFG.bioRoute;
const BIO_GUEST_EMAILS = CFG.bioEmails;
const isBioPath = p => p === BIO_ROUTE || p.startsWith(BIO_ROUTE + '/') || p.startsWith('/api/bio/');
// Hampr donate-checklist guests (CFG.ranmaliEmails): same Google sign-in, confined to
// /ranmali + its own API namespace. Third instance of the scoped-guest shape above.
const RANMALI_ROUTE = '/ranmali';
const RANMALI_GUEST_EMAILS = CFG.ranmaliEmails;
const isRanmaliPath = p => p === RANMALI_ROUTE || p.startsWith(RANMALI_ROUTE + '/') || p.startsWith('/api/ranmali/');
// Guest proxy routes (CFG.guestRoutes): another dashboard instance MOUNTED at a path.
// /cha and everything under it forwards to that instance with a shared-secret header pair
// (X-Proxy-Auth / X-Proxy-User), so one OAuth client + one hostname front N scoped
// instances. The mount is a true path prefix — stripped on the way out, re-added to
// redirects, and announced to the page as window.__BASE__ so its own fetches come back
// under /cha. No cookie, no modes: dashyng.com is yours, dashyng.com/cha is theirs, and
// both work in two tabs at once. (An earlier sticky-cookie "preview mode" made visiting
// /cha silently replace your whole dashboard — deleted 2026-07-31.)
const GUEST_ROUTES = (CFG.guestRoutes || []).filter(r => r && r.path && r.target);
const guestRouteOf = em => GUEST_ROUTES.find(r => (r.emails || []).map(normEmail).includes(em));
const routeForPath = p => GUEST_ROUTES.find(r => p === r.path || p.startsWith(r.path + '/'));
// Inbound trust: when CFG.proxyAuthKey is set this instance ONLY answers its fronting proxy.
const PROXY_AUTH_KEY = String(CFG.proxyAuthKey || '');
async function proxyToInstance(route, req, res, email) {
  const upstreamPath = req.originalUrl.slice(route.path.length) || '/';
  const headers = { 'x-proxy-auth': String(route.key || ''), 'x-proxy-user': email };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined
    : (req.headers['content-type'] || '').includes('json') ? JSON.stringify(req.body || {}) : undefined;
  try {
    const r = await fetch(route.target.replace(/\/$/, '') + upstreamPath, { method: req.method, headers, body, redirect: 'manual' });
    res.status(r.status);
    for (const h of ['content-type', 'cache-control']) { const v = r.headers.get(h); if (v) res.set(h, v); }
    const loc = r.headers.get('location'); // upstream thinks it lives at /, so re-mount its redirects
    if (loc) res.set('location', loc.startsWith('/') ? route.path + loc : loc);
    const buf = Buffer.from(await r.arrayBuffer());
    if ((r.headers.get('content-type') || '').includes('text/html')) {
      const html = buf.toString('utf8');
      const inject = `<script>window.__BASE__=${JSON.stringify(route.path)}</script>`;
      const at = html.search(/<head[^>]*>/i);
      return res.send(at === -1 ? inject + html
        : html.slice(0, at + html.match(/<head[^>]*>/i)[0].length) + inject + html.slice(at + html.match(/<head[^>]*>/i)[0].length));
    }
    res.send(buf);
  } catch (e) {
    // A bare "unreachable" once hid a ReferenceError as a network fault and 502'd every
    // proxied page (2026-07-31). A proxy fault must always name itself.
    console.error('proxyToInstance failed:', route.path, e.message);
    res.status(502).send('proxy error: ' + String(e.message || e).slice(0, 200));
  }
}
// Google delivers the SAME account under several spellings: googlemail.com is an alias of
// gmail.com (it is what some regions/older phones return), dots in a gmail local part are
// ignored, and +tags are ignored. An exact string compare therefore locks out a legitimate
// user depending on which device they signed in from — which is exactly what happened to a
// guest on 2026-07-30. Normalise both sides before comparing. Non-Google domains are left
// alone: dots and +tags ARE significant elsewhere.
function normEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at), domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}
const ALLOWED_EMAILS_N = String(ALLOWED_EMAIL || '').split(',').map(x => normEmail(x)).filter(Boolean); // comma list; first = owner
const ALLOWED_EMAIL_N = ALLOWED_EMAILS_N[0] || '';
const emailAllowed = e => ALLOWED_EMAILS_N.includes(normEmail(e || ''));
const GAME_GUEST_N = GAME_GUEST_EMAILS.map(normEmail);
const BIO_GUEST_N = BIO_GUEST_EMAILS.map(normEmail);
const RANMALI_GUEST_N = RANMALI_GUEST_EMAILS.map(normEmail);
const SESSION_SECRET =process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'dev-only-secret';

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
// NOTE (2026-08-12): do NOT prefix this app's own redirects with a mount path. When this
// instance is mounted at a path on someone's front proxy (dashyng.com/cha), the proxy
// strips the prefix inbound and RE-MOUNTS it on Location headers outbound — the app
// always lives at / from its own point of view. A prefixing attempt here double-mounted
// to /cha/cha/... . The real 2026-08-12 bug was client-side: plugin fetches that ignored
// window.__BASE__ and escaped the mount to the front instance's own data.
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
  if (req.query.state === 'gcal') return gcalConsentReturn(req, res);
  if (req.query.state === 'drive') return driveConsentReturn(req, res);
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: OAUTH_ID });
  const rawEmail = (ticket.getPayload().email || '').toLowerCase();
  const email = normEmail(rawEmail);
  const isOwner = email === ALLOWED_EMAIL_N;
  if (!isOwner && !emailAllowed(email) && !GAME_GUEST_N.includes(email) && !BIO_GUEST_N.includes(email) && !RANMALI_GUEST_N.includes(email) && !guestRouteOf(email)) return res.status(403).send(`Not authorized: ${rawEmail}`);
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.set('Set-Cookie', `dash_session=${encodeURIComponent(signSession(email))}; HttpOnly${secure}; SameSite=Lax; Max-Age=${30 * 24 * 3600}; Path=/${cookieDomain(req)}`);
  const next = safeNext(String(req.query.state || '').startsWith('next:') ? String(req.query.state).slice(5) : '');
  if (isOwner) return res.redirect(next || '/');
  const nextPath = next.split('?')[0];
  if (BIO_GUEST_N.includes(email)) return res.redirect(isBioPath(nextPath) ? next : BIO_ROUTE);
  if (RANMALI_GUEST_N.includes(email)) return res.redirect(isRanmaliPath(nextPath) ? next : RANMALI_ROUTE);
  { const gr = guestRouteOf(email); if (gr) return res.redirect(routeForPath(nextPath) ? next : gr.path); }
  res.redirect(isGamePath(nextPath) ? next : '/junglefarm/');
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
// ---------- Google Calendar connect (guest/public instances) ----------
// One button: OAuth with calendar.readonly, refresh token into the settings store (the
// instance's own sheet cell — survives Cloud Run restarts). The owner-tier alternative
// (share the calendar with the service account) keeps working; this is for instances
// whose user has no service account to share with.
// ---------- Drive connect (circle sheets / user-owned datastores) ----------
// drive.file = the NARROWEST Drive scope: only files this app creates. Needed because the
// robot service account cannot own My-Drive files — circle sheets must be created by a
// real user, who then also becomes the circle's Google-side owner/admin.
app.get('/auth/drive/connect', (req, res) => {
  if (!OAUTH_ID) return res.status(501).send('Set GOOGLE_OAUTH_CLIENT_ID/SECRET first — see .env.example.');
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  res.redirect(c.generateAuthUrl({ scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets', 'email'], access_type: 'offline', prompt: 'consent', state: 'drive' }));
});
async function driveConsentReturn(req, res) {
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  if (!tokens.refresh_token) return res.status(400).send('Google did not return a refresh token — revoke prior access at https://myaccount.google.com/permissions and retry.');
  await saveSettings({ ...loadSettings(), driveToken: { refresh_token: tokens.refresh_token, connectedAt: nowIso() } });
  res.send('Drive connected — you can now create shared circles. <a href="/">← back</a>');
}
function userDriveAuth() {
  const t = (loadSettings().driveToken || {}).refresh_token;
  if (!t || !OAUTH_ID) return null;
  const oc = new OAuth2Client(OAUTH_ID, OAUTH_SECRET);
  oc.setCredentials({ refresh_token: t });
  return oc;
}
app.get('/auth/calendar/connect', (req, res) => {
  if (!OAUTH_ID) return res.status(501).send('Set GOOGLE_OAUTH_CLIENT_ID/SECRET first — see .env.example.');
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  res.redirect(c.generateAuthUrl({ scope: ['https://www.googleapis.com/auth/calendar.readonly', 'email'], access_type: 'offline', prompt: 'consent', state: 'gcal' }));
});
async function gcalConsentReturn(req, res) {
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  if (!tokens.refresh_token) return res.status(400).send('Google did not return a refresh token — revoke prior access at https://myaccount.google.com/permissions and try again.');
  const next = { ...loadSettings(), gcalToken: { refresh_token: tokens.refresh_token, connectedAt: nowIso() } };
  await saveSettings(next);
  res.send('Calendar connected. <a href="/">← back</a>');
}
app.get('/auth/calendar/disconnect', asyncRoute(async (req, res) => {
  const next = { ...loadSettings() }; delete next.gcalToken;
  await saveSettings(next); res.redirect('/');
}));

app.get('/auth/gmail/connect', (req, res) => {
  if (!OAUTH_ID) return res.status(501).send('Set GOOGLE_OAUTH_CLIENT_ID/SECRET first (same as Sign-in-with-Google) — see .env.example.');
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  // readonly (triage) + compose (Stage C drafts — create drafts only, NEVER send; the
  // send scope is deliberately not requested). AT009: one re-consent covers both stages.
  res.redirect(c.generateAuthUrl({ scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'email'], access_type: 'offline', prompt: 'consent', state: 'gmail' }));
});
async function gmailConsentReturn(req, res) {
  const c = new OAuth2Client(OAUTH_ID, OAUTH_SECRET, redirectUri(req));
  const { tokens } = await c.getToken(req.query.code);
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: OAUTH_ID }).catch(() => null);
  const email = (ticket?.getPayload()?.email || '').toLowerCase();
  if (ALLOWED_EMAIL_N && email && !emailAllowed(email)) return res.status(403).send(`Not authorized: ${email}`);
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

// ---------- Gmail for the heartbeat (Stage C draft / Stage D triage) ----------
// The headless `claude -p` has NO Gmail/Calendar MCP (only google-sheets is configured), so
// Stages C and D were skipped every run for weeks. They never needed MCP: this instance's
// own OAuth grant already carries gmail.readonly AND gmail.compose. These three endpoints
// expose exactly that much and nothing more.
// ⚠ NEVER-SEND IS STRUCTURAL: the only write path below is drafts.create. There is no call
// to messages.send or drafts.send anywhere in this block, so no prompt, jailbreak, or agent
// mistake can send mail — the capability simply is not wired. Keep it that way.
const gmailApi = async () => { const auth = await gmailAuthClient(); return auth ? google.gmail({ version: 'v1', auth }) : null; };
const hdr = (payload, name) => ((payload && payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function gmailPlainText(payload) { // flatten MIME, prefer text/plain, fall back to stripped HTML
  const flat = []; (function walk(p) { if (!p) return; flat.push(p); (p.parts || []).forEach(walk); })(payload);
  const dec = b => b ? Buffer.from(b, 'base64').toString('utf8') : '';
  const plain = flat.filter(x => x.mimeType === 'text/plain').map(x => dec(x.body?.data)).join('\n');
  if (plain.trim().length > 40) return plain;
  return flat.filter(x => x.mimeType === 'text/html').map(x => dec(x.body?.data)).join('\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}
app.get('/api/gmail/threads', asyncRoute(async (req, res) => {
  const gmail = await gmailApi();
  if (!gmail) return res.status(400).json({ error: 'Gmail not connected — /auth/gmail/connect' });
  const q = String(req.query.q || '(is:starred OR is:important) in:inbox newer_than:21d').slice(0, 300);
  const maxResults = Math.min(50, Math.max(1, parseInt(req.query.max, 10) || 20));
  const list = await gmail.users.threads.list({ userId: 'me', q, maxResults });
  const out = [];
  for (const t of (list.data.threads || [])) {
    try {
      const full = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'] });
      const msgs = full.data.messages || [];
      const last = msgs[msgs.length - 1] || {};
      out.push({ id: t.id, messages: msgs.length, snippet: t.snippet || last.snippet || '',
        subject: hdr(last.payload, 'Subject'), from: hdr(last.payload, 'From'),
        to: hdr(last.payload, 'To'), date: hdr(last.payload, 'Date'),
        unread: (last.labelIds || []).includes('UNREAD') });
    } catch (e) { /* one bad thread never sinks the list */ }
  }
  res.json({ query: q, threads: out });
}));
app.get('/api/gmail/thread/:id', asyncRoute(async (req, res) => {
  const gmail = await gmailApi();
  if (!gmail) return res.status(400).json({ error: 'Gmail not connected' });
  const full = await gmail.users.threads.get({ userId: 'me', id: req.params.id, format: 'full' }).catch(() => null);
  if (!full) return res.status(404).json({ error: 'thread not found' });
  res.json({ id: req.params.id, messages: (full.data.messages || []).map(m => ({
    id: m.id, from: hdr(m.payload, 'From'), to: hdr(m.payload, 'To'), cc: hdr(m.payload, 'Cc'),
    subject: hdr(m.payload, 'Subject'), date: hdr(m.payload, 'Date'),
    body: gmailPlainText(m.payload).slice(0, 6000),
  })) });
}));
app.post('/api/gmail/draft', asyncRoute(async (req, res) => {
  const gmail = await gmailApi();
  if (!gmail) return res.status(400).json({ error: 'Gmail not connected' });
  const { to, subject, body, threadId, cc } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: 'subject or body required' });
  const enc = t => `=?UTF-8?B?${Buffer.from(String(t || ''), 'utf8').toString('base64')}?=`; // RFC2047 for non-ASCII
  const lines = [
    `To: ${String(to || '').slice(0, 300)}`,
    ...(cc ? [`Cc: ${String(cc).slice(0, 300)}`] : []),
    `Subject: ${enc(subject || '')}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '',
    String(body || ''),
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
  // drafts.create ONLY — see the never-send note above
  const d = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } } });
  track('gmail-draft', true, `draft for ${String(to || '(blank)').slice(0, 40)}`);
  res.json({ ok: true, draftId: d.data.id, note: 'draft created — never sent' });
}));

// ---------- native-app support: widget tokens + push registration (iOS/watch) ----------
// WidgetKit timelines and watch complications fetch WITHOUT cookies: a scoped, revocable,
// READ-ONLY token (minted by the signed-in owner, stored in settings) unlocks exactly the
// endpoints a glance needs — nothing that writes, nothing personal beyond the glance.
const WIDGET_TOKEN_PATHS = new Set(['/api/activities', '/api/calendar', '/api/surf', '/api/tasks', '/api/widgets']);
app.post('/api/widget-token', asyncRoute(async (req, res) => {
  const st = loadSettings();
  const token = st.widgetToken || crypto.randomBytes(16).toString('hex');
  if (!st.widgetToken) await saveSettings({ ...st, widgetToken: token });
  res.json({ token, paths: [...WIDGET_TOKEN_PATHS] });
}));
app.post('/api/widget-token/revoke', asyncRoute(async (req, res) => {
  const st = { ...loadSettings() }; delete st.widgetToken;
  await saveSettings(st); res.json({ ok: true });
}));
// Push: devices register their APNs token; the sender (bin/push-send helper below the
// urgent/lead paths) is a no-op until APNS_* env/config exists — registration still works
// so devices are ready the moment the owner's Apple developer keys land.
app.post('/api/push/register', asyncRoute(async (req, res) => {
  const { token, platform } = req.body || {};
  const t = String(token || '').trim().slice(0, 200);
  if (!t) return res.status(400).json({ error: 'token required' });
  const st = loadSettings();
  const devices = (st.pushDevices || []).filter(d => d.token !== t);
  devices.push({ token: t, platform: String(platform || 'ios').slice(0, 12), at: nowIso() });
  await saveSettings({ ...st, pushDevices: devices.slice(-10) });
  res.json({ ok: true, devices: devices.length });
}));

// ---------- share circles: one sheet per shared widget ----------
// Permission model = Google's own, deliberately: the circle CREATOR is the Drive owner and
// sole admin (writersCanShare:false — members cannot re-share); members are writer (joint
// state) or reader (view-only shares). The _members tab is the alert substrate: every
// grant appends a row, every member's instance can diff it and surface "X was added".
async function saEmail() {
  try { return JSON.parse(fs.readFileSync(CFG.keyFile, 'utf8')).client_email || ''; } catch (e) {}
  try { // Cloud Run: ask the metadata server which identity this service runs as
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (r.ok) return (await r.text()).trim();
  } catch (e) {}
  return '';
}
async function createCircleSheet(widgetId, members /* [{email, role:'writer'|'reader'}] */) {
  const auth = userDriveAuth();
  if (!auth) return { error: 'Connect Google Drive first (⚙ → sharing, or /auth/drive/connect) — circles are created and owned by YOU, not the robot.' };
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });
  const title = `dashyng · ${String(widgetId).replace(/^plugin:/, '')} · circle`;
  const created = await sheets.spreadsheets.create({ requestBody: {
    properties: { title },
    sheets: [{ properties: { title: 'data' } }, { properties: { title: '_members' } }],
  } });
  const id = created.data.spreadsheetId;
  await sheets.spreadsheets.values.update({ spreadsheetId: id, range: "'_members'!A1", valueInputOption: 'RAW',
    requestBody: { values: [['At', 'Email', 'Role', 'AddedBy'], [nowIso(), myOwnerEmail(), 'owner', 'creator']] } });
  // members cannot re-share: adding people stays an owner action, visibly
  await drive.files.update({ fileId: id, requestBody: { writersCanShare: false } }).catch(() => {});
  const granted = [];
  for (const m of (members || [])) {
    const role = m.role === 'reader' ? 'reader' : 'writer';
    try {
      await drive.permissions.create({ fileId: id, sendNotificationEmail: true,
        requestBody: { type: 'user', role, emailAddress: m.email } });
      await sheets.spreadsheets.values.append({ spreadsheetId: id, range: "'_members'!A1", valueInputOption: 'RAW',
        requestBody: { values: [[nowIso(), m.email, role, myOwnerEmail()]] } });
      granted.push({ email: m.email, role });
    } catch (e) { granted.push({ email: m.email, error: String(e.message).slice(0, 120) }); }
  }
  // the deployment's robot also needs access — the instance serves the widget through it
  const robot = await saEmail();
  if (robot) {
    await drive.permissions.create({ fileId: id, sendNotificationEmail: false,
      requestBody: { type: 'user', role: 'writer', emailAddress: robot } }).catch(() => {});
    await sheets.spreadsheets.values.append({ spreadsheetId: id, range: "'_members'!A1", valueInputOption: 'RAW',
      requestBody: { values: [[nowIso(), robot, 'robot', 'auto']] } }).catch(() => {});
  }
  return { ok: true, sheetId: id, title, granted };
}
app.post('/api/circles/create', asyncRoute(async (req, res) => {
  const { widgetId, email, role } = req.body || {};
  if (!widgetId || !email) return res.status(400).json({ error: 'widgetId and email required' });
  const r = await createCircleSheet(widgetId, [{ email: String(email), role }]);
  if (r.error) return res.status(400).json(r);
  // migrate current state when the widget knows how (copy, never move)
  const pk = String(widgetId).replace(/^plugin:/, '');
  const p = (typeof PLUGINS === 'object' && PLUGINS[pk]) || null;
  if (p && typeof p.migrateTo === 'function') await p.migrateTo(pluginCtx(), r.sheetId).catch(() => {});
  // remember the pointer locally so subsequent share() calls carry the circle
  const st = loadSettings();
  await saveSettings({ ...st, jointSheets: { ...(st.jointSheets || {}), [pk]: r.sheetId } });
  res.json(r);
}));
// membership status for every circle this instance points at — the "who's in it, who's
// new" feed. A member's instance calls this; additions since last look = the alert.
// self-service exit: drop this instance's pointer to a circle (after being removed, or
// by choice). Data safety: the local/own-sheet copy from before joining is still there;
// for joint-state widgets the last-synced local cache remains until next write.
app.post('/api/circles/detach', asyncRoute(async (req, res) => {
  const w = String((req.body || {}).widget || '');
  const st = loadSettings();
  if (!(st.jointSheets || {})[w]) return res.status(404).json({ error: 'no such circle pointer' });
  const joint = { ...st.jointSheets }; delete joint[w];
  await saveSettings({ ...st, jointSheets: joint });
  res.json({ ok: true, detached: w });
}));
app.get('/api/circles/status', asyncRoute(async (req, res) => {
  const joint = loadSettings().jointSheets || {};
  const out = [];
  for (const [widget, sheetId] of Object.entries(joint)) {
    try {
      const r = await store.values.get({ spreadsheetId: sheetId, range: "'_members'!A1:D50" });
      const rows = (r.data.values || []).slice(1).map(x => ({ at: x[0], email: x[1], role: x[2], addedBy: x[3] }));
      out.push({ widget, sheetId, members: rows });
    } catch (e) { out.push({ widget, sheetId, error: 'unreadable (removed from circle?)' }); }
  }
  res.json({ circles: out });
}));

// ---------- dashyng IDs, invites & widget sharing (phases 3+4) ----------
// Directory: a sheet tab mapping sha256(email) → {dashyngId, instanceUrl, displayName}.
// Friends find each other by EMAIL (hashed at rest); the instance URL is only revealed to
// signed-in users of instances sharing this directory. Invites carry a SHARE BLOB —
// {widgetId, config diff vs repo default, prompt rows} — NEVER code: modified widget code
// travels through the public repo / GitHub, where the community resolves what works best.
const DIR_SHEET = () => CFG.directorySheetId || TODO_SHEET_ID;
const DIR_TAB = 'Directory';
const DIR_HEADERS = ['EmailHash', 'DashyngId', 'InstanceUrl', 'DisplayName', 'At'];
const emailHash = e => crypto.createHash('sha256').update(normEmail(e)).digest('hex').slice(0, 32);
const myOwnerEmail = () => normEmail(CFG.ownerEmail || ALLOWED_EMAILS_N[0] || '');
app.post('/api/directory/register', asyncRoute(async (req, res) => {
  const email = myOwnerEmail();
  if (!email) return res.status(400).json({ error: 'set DASHBOARD_OWNER_EMAIL (or ALLOWED_EMAIL) first' });
  const dashyngId = String((req.body || {}).dashyngId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  const displayName = String((req.body || {}).displayName || '').trim().slice(0, 40);
  const instanceUrl = String((req.body || {}).instanceUrl || process.env.OAUTH_REDIRECT_BASE || '').trim().slice(0, 200);
  if (!dashyngId) return res.status(400).json({ error: 'dashyngId required (letters/digits/dashes)' });
  const { rows } = await readTab(DIR_SHEET(), DIR_TAB, DIR_HEADERS).catch(async e => { await ensureTab(DIR_TAB, DIR_HEADERS, DIR_SHEET()); return { rows: [] }; });
  const mine = rows.find(r => r.EmailHash === emailHash(email));
  const taken = rows.find(r => r.DashyngId === dashyngId && r.EmailHash !== emailHash(email));
  if (taken) return res.status(409).json({ error: 'that dashyng ID is taken' });
  if (mine) await store.values.update({ spreadsheetId: DIR_SHEET(), range: `'${DIR_TAB}'!B${mine._row}:E${mine._row}`, valueInputOption: 'RAW',
    requestBody: { values: [[dashyngId, instanceUrl, displayName, nowIso()]] } });
  else await appendTabRow(DIR_TAB, DIR_HEADERS, [emailHash(email), dashyngId, instanceUrl, displayName, nowIso()], DIR_SHEET());
  res.json({ ok: true, dashyngId });
}));
app.get('/api/directory/lookup', asyncRoute(async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { rows } = await readTab(DIR_SHEET(), DIR_TAB, DIR_HEADERS).catch(() => ({ rows: [] }));
  const hit = rows.find(r => r.EmailHash === emailHash(email));
  if (!hit) return res.json({ found: false });
  res.json({ found: true, dashyngId: hit.DashyngId, displayName: hit.DisplayName || '' });
}));
// SEND an invite: my widget config (diff vs shipped defaults) to a friend's instance.
app.post('/api/share/send', asyncRoute(async (req, res) => {
  const { email, widgetId, note } = req.body || {};
  if (!email || !widgetId) return res.status(400).json({ error: 'email and widgetId required' });
  const { rows } = await readTab(DIR_SHEET(), DIR_TAB, DIR_HEADERS).catch(() => ({ rows: [] }));
  const hit = rows.find(r => r.EmailHash === emailHash(String(email)));
  if (!hit || !hit.InstanceUrl) return res.status(404).json({ error: 'no dashyng instance found for that email' });
  const st = loadSettings();
  const blob = {
    v: 1, widgetId: String(widgetId).slice(0, 40), note: String(note || '').slice(0, 300),
    from: { dashyngId: (rows.find(r => r.EmailHash === emailHash(myOwnerEmail())) || {}).DashyngId || '', email: myOwnerEmail() },
    at: nowIso(),
    // config diff vs repo default: only the pieces that belong to this widget.
    // A plugin can define share(ctx) → arbitrary blob (e.g. a joint-state sheet pointer)
    // and acceptShare(ctx, blob) on the receiving side — sharing is any-widget, not lists.
    config: {
      section: (st.sections || {})[widgetId] || null,
      ...(await (async () => { const pk = String(widgetId).replace(/^plugin:/, '');
        const p = (typeof PLUGINS === 'object' && PLUGINS[pk]) || null;
        if (p && typeof p.share === 'function') { try { return { plugin: await p.share(pluginCtx()) }; } catch (e) {} }
        return {}; })()),
      ...(widgetId === 'acts' ? { activities: (await loadActivitiesConfig()).slice(0, 12) } : {}),
      ...(widgetId === 'todo' ? { quadrants: st.quadrants || null } : {}),
      ...(widgetId === 'surf' ? { surfSpots: CFG.surfSpots || null } : {}),
    },
  };
  const body = JSON.stringify(blob);
  const sig = crypto.createHmac('sha256', String(st.webhookSecret || 'unsigned')).update(body).digest('hex');
  const r = await fetch(hit.InstanceUrl.replace(/\/$/, '') + '/api/share/receive', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-share-sig': sig }, body,
  }).catch(e => null);
  if (!r || !r.ok) return res.status(502).json({ error: 'their instance did not accept the invite' + (r ? ` (HTTP ${r.status})` : '') });
  res.json({ ok: true, to: hit.DashyngId });
}));
// RECEIVE: park it for the owner — showing the diff and requiring approval IS the security
// boundary (the sender is untrusted; nothing applies until the owner accepts).
app.post('/api/share/receive', asyncRoute(async (req, res) => {
  const blob = req.body || {};
  if (!blob.widgetId || !blob.from) return res.status(400).json({ error: 'malformed share' });
  const st = loadSettings();
  const inv = { ...blob, receivedAt: nowIso(), id: crypto.randomUUID().slice(0, 8) };
  await saveSettings({ ...st, invites: [...(st.invites || []), inv].slice(-20) });
  res.json({ ok: true });
}));
app.get('/api/share/inbox', asyncRoute(async (req, res) => res.json({ invites: loadSettings().invites || [] })));
app.post('/api/share/resolve', asyncRoute(async (req, res) => {
  const { id, accept } = req.body || {};
  const st = loadSettings();
  const inv = (st.invites || []).find(i => i.id === id);
  if (!inv) return res.status(404).json({ error: 'invite not found' });
  const next = { ...st, invites: (st.invites || []).filter(i => i.id !== id) };
  if (accept && inv.config && inv.config.plugin) {
    const pk = String(inv.widgetId).replace(/^plugin:/, '');
    const p = (typeof PLUGINS === 'object' && PLUGINS[pk]) || null;
    if (p && typeof p.acceptShare === 'function') await p.acceptShare(pluginCtx(), inv.config.plugin).catch(() => {});
  }
  if (accept && inv.config) {
    if (inv.config.section) next.sections = { ...(next.sections || {}), [inv.widgetId]: { ...inv.config.section, hidden: false } };
    else next.sections = { ...(next.sections || {}), [inv.widgetId]: { ...(next.sections || {})[inv.widgetId], hidden: false } };
    if (inv.config.quadrants && inv.widgetId === 'todo') next.quadrants = { ...(next.quadrants || {}), ...inv.config.quadrants };
    if (inv.config.activities && inv.widgetId === 'acts') {
      // prompt rows append to the ACTIVITIES pref tab (skip dupes by activity name)
      const cur = await loadActivitiesConfig();
      const have = new Set(cur.map(a => a.activity.toLowerCase()));
      for (const a of inv.config.activities) if (a.activity && !have.has(a.activity.toLowerCase()))
        await appendTabRow('ACTIVITIES', EDITABLE_TAB_HEADERS.ACTIVITIES, [a.activity, a.instructions || '', String(a.leadDays || 0), a.show || 'all'], PREFS_SHEET_ID).catch(() => {});
      actCfgMemo = { at: 0, val: null };
    }
  }
  await saveSettings(next);
  res.json({ ok: true, applied: !!accept });
}));

// ---------- widget registry (phase 1 of the widget platform) ----------
// One manifest per section: what it is, what it needs, which settings shape it. This is
// METADATA — rendering stays where it is. Sharing (share blobs), the add-widget gallery,
// and the community flow (widgets as plugins via the public repo / GitHub PRs) all key off
// these ids. Plugins self-register at load with the same shape (plugin:<id>).
const WIDGETS = {
  links:   { title: 'Links',            desc: 'Pinned links & bookmarks',                          needs: {} },
  journal: { title: 'Journal',          desc: 'Daily journal — tracked header fields, agent-readable sections, per-section stash routing', needs: { tabs: ['Journal', 'Journal Tracking'] }, configKeys: ['journal'] },
  habits:  { title: 'Habits',           desc: 'Daily habit tracking with streaks',                 needs: { tabs: ['Habits'] } },
  brief:   { title: 'Agent brief',      desc: 'Agent-written morning brief',                       needs: { llm: true } },
  acts:    { title: 'Activity Preview', desc: 'Scanned event suggestions — swipe to calendar',     needs: { llm: true, location: true, tabs: ['Activity Events'] }, configKeys: ['ACTIVITIES prefs'] },
  today:   { title: 'Today',            desc: 'Calendar cards + day look-ahead + travel strip',    needs: { calendar: true }, configKeys: ['calendars', 'calendarLookahead'] },
  todo:    { title: 'Persistent lists', desc: 'Task lists incl. shared-tab lists & recurrence',    needs: { tabs: ['Todo'] }, configKeys: ['quadrants', 'listShares'] },
  jlists:  { title: 'Ephemeral notes',  desc: 'Quick notes, photos, and LLM-built checklists',     needs: { tabs: ['Ephemeral Lists', 'Ephemeral Notes'] } },
  cinote:  { title: 'Note to CI',       desc: 'Talk to the dashboard — requests apply themselves', needs: { llm: true } },
  agents:  { title: 'Agent stable',     desc: 'Model roster, usage, and procurement',              needs: { tabs: ['Usage', 'Decisions'] } },
  files:   { title: 'File manager',     desc: 'Filesystem overview of configured roots',           needs: {} },
  completed: { title: 'Completed',      desc: 'Recently completed tasks',                          needs: { tabs: ['Todo'] } },
  signals: { title: 'Market signals',   desc: 'Agent-flagged market signals',                      needs: { tabs: ['Signals'] } },
  news:    { title: 'News',             desc: 'Preference-driven news with swipe feedback',        needs: { llm: true, tabs: ['prefs sheet'] }, configKeys: ['SOURCES/SUBJECTS/PEOPLE/LOCATIONS/TOPOFMIND'] },
  week:    { title: 'Week ahead',       desc: 'Seven-day agenda list',                             needs: { calendar: true } },
};
app.get('/api/widgets', (req, res) => {
  const sections = loadSettings().sections || {};
  const reg = Object.entries(WIDGETS).map(([id, w]) => ({ id, ...w, hidden: !!(sections[id] || {}).hidden }));
  for (const [key, p] of Object.entries(typeof PLUGINS === 'object' && PLUGINS ? PLUGINS : {})) {
    const id = p.core ? key : 'plugin:' + key; // core plugins = extracted sections, original key
    reg.push({ id, title: p.title || key, desc: p.desc || 'plugin', needs: p.needs || {}, plugin: true, hidden: !!(sections[id] || {}).hidden });
  }
  res.json({ widgets: reg });
});

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
  // Inbound proxy trust: this instance sits behind a fronting dashboard and answers ONLY it.
  if (PROXY_AUTH_KEY) {
    if (req.headers['x-proxy-auth'] === PROXY_AUTH_KEY) return next();
    // friend instances deliver invites directly (they don't hold the proxy key);
    // receipts only PARK — the owner approves in ⚙ before anything applies
    if (req.method === 'POST' && req.path === '/api/share/receive') return next();
    // bare liveness for warm-up pings (Cloud Scheduler): no data, keeps the instance hot
    if (req.method === 'GET' && req.path === '/warm') return res.send('ok');
    return res.status(403).send('proxy only');
  }
  // one canonical host: www → apex, so the session cookie has a single home
  const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (BASE_HOST && reqHost === 'www.' + BASE_HOST) return res.redirect(301, `https://${BASE_HOST}${req.originalUrl}`);
  if (req.path.startsWith('/auth/')) return next();
  // Public read-only carve-out: the sanitized agent-stable showcase. Exact GET paths only —
  // everything else (all POSTs, all other pages/APIs) stays behind the gate. The payload is
  // allowlist-built in /api/public/agentstable; never widen this to a prefix match.
  if (req.method === 'GET' && PUBLIC_GETS.has(req.path)) return next();
  // Shared-list bridge: token-authed per-list access for EXTERNAL helpers/agents (read,
  // doer-complete, comment). The token IS the auth — checked inside the route; unknown
  // tokens 404 without touching anything else behind the gate.
  if (req.path.startsWith('/api/elists/ext/')) return next();
  // health-data intake + write-back queue (phone exporter/Shortcut, no browser session):
  // the X-Health-Key IS the auth — checked inside each route; no key configured → all 401.
  if (['/api/htrack/intake', '/api/htrack/eat-pending', '/api/htrack/eat-ack'].includes(req.path)) return next();
  // Cross-instance share delivery: another dashboard POSTS an invite here. Nothing is
  // applied on receipt — invites park in ⚙ until the owner reviews the diff — so an
  // unauthenticated drop-box is acceptable; the resolve/apply routes stay behind the gate.
  if (req.method === 'POST' && req.path === '/api/share/receive') return next();
  // native widgets/complications: scoped read-only token on an exact-path whitelist
  if (req.method === 'GET' && WIDGET_TOKEN_PATHS.has(req.path)
      && req.headers['x-widget-token'] && req.headers['x-widget-token'] === (loadSettings().widgetToken || undefined)) return next();
  if (OAUTH_ID && process.env.OAUTH_REDIRECT_BASE) {
    const sess = verifySession(cookieOf(req, 'dash_session'));
    if (sess) {
      const email = normEmail(sess.email);
      if (emailAllowed(email)) {
        // the owner sees a mounted instance by visiting its path. Nothing sticky, nothing
        // to exit: / is always their own dashboard, /cha is always the other one.
        const mr = routeForPath(req.path);
        if (mr) return proxyToInstance(mr, req, res, email);
        return next();
      }
      // Proxied-instance guests: a whole dashboard of their own outranks the single-page
      // carve-outs below — but someone who is ALSO a game guest keeps /junglefarm here.
      const gr = guestRouteOf(email);
      // a mounted instance outranks the single-page carve-outs below, except on the paths
      // those carve-outs own — a guest may hold a whole dashboard AND a page here
      if (gr && !(GAME_GUEST_N.includes(email) && isGamePath(req.path))
             && !(RANMALI_GUEST_N.includes(email) && isRanmaliPath(req.path))) {
        // serve whichever mount the URL names (a guest can be on several), never the
        // guest's home mount regardless of path — that sliced the prefix off the wrong
        // route and forwarded a mangled path upstream
        const mr = routeForPath(req.path);
        if (mr && (mr.emails || []).map(normEmail).includes(email)) return proxyToInstance(mr, req, res, email);
        return res.redirect(gr.path);   // unknown path, or a mount that is not theirs
      }
      // Page carve-outs. Each list owns ITS OWN paths and nothing else — one guest can be
      // on several lists at once (a game, a checklist page, a mounted dashboard), and
      // whichever list was checked first must not swallow the paths of the others.
      const grants = [
        { on: GAME_GUEST_N.includes(email), owns: isGamePath(req.path), home: '/junglefarm/' },
        { on: BIO_GUEST_N.includes(email), owns: isBioPath(req.path), home: BIO_ROUTE },
        { on: RANMALI_GUEST_N.includes(email), owns: isRanmaliPath(req.path), home: RANMALI_ROUTE },
      ].filter(g => g.on);
      if (grants.length) {
        if (grants.some(g => g.owns)) return next();
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'not authorized for this API' });
        return res.redirect(grants[0].home);   // their first grant is their landing page
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
// UI language: a locale like fr-FR makes the page load its translation pack (chrome
// strings only — entries stay in whatever language they were typed in)
const UI_LANG = String(CFG.locale || '').slice(0, 2).toLowerCase();
app.get('/', (req, res, next) => {
  if (UI_LANG === 'en' || !UI_LANG) return next();
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return next();
    const tag = `<script>window.__UI_LANG__=${JSON.stringify(UI_LANG)}</script>`;
    res.type('html').send(html.replace(/<head[^>]*>/i, m => m + tag));
  });
});
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
// Jobs board — clean path (dashyng.com/jobs); behind the same OAuth gate as everything else.
app.get('/jobs', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'jobs.html'));
});
// Biotech clinical-trial tracker — mounts at CFG.bioRoute (default /bio). Same OAuth gate;
// guests listed in CFG.bioEmails reach this path and nothing else.
app.get(BIO_ROUTE, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'bio.html'));
});

// ---------- Hampr donate checklist (/ranmali) ----------
// Phone page for the housekeeper: photos of the clothes in the Thriftr "Donate" Drive
// folder, one checkbox each; "Done" reparents the checked ones into "Donated". The Drive
// tree is shared Editor with this instance's service account (same SA the sheets use).
// Guests in CFG.ranmaliEmails see only this page (gate above); the owner sees everything.
const RANMALI_FOLDERS = {
  donate: process.env.RANMALI_DONATE_ID || '1g8t8ejYrZRthbddL3KU7HR8e0ysc3udO',   // Thriftr/Donate
  donated: process.env.RANMALI_DONATED_ID || '1Ol5S8px2W2dzJ9fWgRU9O2cWz_J5fwEE', // Thriftr/Donated
};
const driveClient = google.drive({ version: 'v3', auth });
const RANMALI_DRIVE_OPTS = { supportsAllDrives: true };
app.get(RANMALI_ROUTE, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'ranmali.html'));
});
app.get('/api/ranmali/items', asyncRoute(async (req, res) => {
  const r = await driveClient.files.list({
    q: `'${RANMALI_FOLDERS.donate}' in parents and trashed = false and mimeType contains 'image/'`,
    orderBy: 'createdTime',
    pageSize: 200,
    fields: 'files(id,name)',
    ...RANMALI_DRIVE_OPTS,
  });
  res.json({ items: (r.data.files || []).map(f => ({ id: f.id, name: f.name, imgUrl: `/api/ranmali/img/${f.id}` })) });
}));
// Image proxy, scoped: only files currently in Donate/Donated are served — the parent
// check stops a guest from using the SA to read arbitrary Drive files by id.
app.get('/api/ranmali/img/:id', asyncRoute(async (req, res) => {
  const fileId = String(req.params.id);
  const meta = await driveClient.files.get({ fileId, fields: 'parents,mimeType,thumbnailLink', ...RANMALI_DRIVE_OPTS });
  const parents = meta.data.parents || [];
  if (!parents.includes(RANMALI_FOLDERS.donate) && !parents.includes(RANMALI_FOLDERS.donated)) {
    return res.status(404).json({ error: 'not found' });
  }
  // Drive's resized thumbnail keeps a 200-photo column light on a phone; fall back to
  // the original bytes when a thumbnail isn't available (same approach as Hampr itself).
  try {
    let link = meta.data.thumbnailLink;
    if (link) {
      link = link.replace(/=s\d+(-c)?$/, '=s800');
      const tok = await auth.getAccessToken();
      const r = await fetch(link, { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) {
        res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=86400');
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
    }
  } catch (e) { /* fall through to original bytes */ }
  res.set('Content-Type', meta.data.mimeType || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  const stream = await driveClient.files.get({ fileId, alt: 'media', ...RANMALI_DRIVE_OPTS }, { responseType: 'stream' });
  stream.data.on('error', e => { if (!res.headersSent) res.status(500).end(e.message); }).pipe(res);
}));
app.post('/api/ranmali/done', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const moved = [], failed = [];
  // parallel in small chunks — a 20-item batch finishes in a couple of seconds instead
  // of freezing the phone's busy state for ~10s of sequential Drive round-trips
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async fileId => {
      try {
        // verify the file really is in Donate before reparenting (same containment rule
        // as the image proxy; also makes a double-submit harmless)
        const meta = await driveClient.files.get({ fileId, fields: 'parents', ...RANMALI_DRIVE_OPTS });
        if (!(meta.data.parents || []).includes(RANMALI_FOLDERS.donate)) { failed.push(fileId); return; }
        await driveClient.files.update({
          fileId, addParents: RANMALI_FOLDERS.donated, removeParents: RANMALI_FOLDERS.donate,
          fields: 'id,parents', ...RANMALI_DRIVE_OPTS,
        });
        moved.push(fileId);
      } catch (e) { failed.push(fileId); }
    }));
  }
  res.json({ ok: failed.length === 0, moved, failed });
}));

// Capability flags — agent features need the claude CLI (subscription auth) and
// the Obsidian vault, both Mac-only. On Cloud Run these report unavailable and
// the frontend hides those panels; the Mac instance stays fully featured.
// env override is validated too — a configured-but-missing binary must not report the
// agent capability as present (it would ENOENT at call time instead of degrading cleanly)
const CLAUDE_BIN = process.env.CLAUDE_BIN === 'none' ? '' // explicit opt-out (also how tests simulate a claude-less machine)
  : [process.env.CLAUDE_BIN, '/opt/homebrew/bin/claude', '/usr/bin/claude', '/usr/local/bin/claude'].filter(Boolean).find(p => fs.existsSync(p)) || '';
const HAS_CLAUDE = !!CLAUDE_BIN;
// AT010 standing rule, automated: the claude CLI's auth is resolved when child processes
// spawn with THIS process's env — a token refresh on disk never reaches a running server.
// So (1) arm the long-lived token file at boot (same file heartbeat.sh uses), and (2) watch
// it: on change, exit cleanly and let launchd (KeepAlive) / systemd (Restart) bring the
// server back with the fresh credential. No manual restart to remember.
const CLAUDE_TOK_FILE = path.join(os.homedir(), '.config', 'dashboard', 'claude-oauth-token');
try {
  const t = fs.readFileSync(CLAUDE_TOK_FILE, 'utf8').trim();
  if (/^sk-ant-/.test(t) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
} catch (e) {}
if (HAS_CLAUDE) fs.watchFile(CLAUDE_TOK_FILE, { interval: 60000 }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs) {
    console.error('claude token file changed — exiting for a supervised restart (AT010)');
    setTimeout(() => process.exit(0), 500);
  }
});
// Text-only LLM features run on either the claude CLI (subscription) or the Anthropic API
// (key) — tool-needing agent features (WebFetch/WebSearch summaries, media find) are
// CLI-only. With NEITHER, single-tier instances refuse cleanly instead of queueing forever;
// multi-tier (sheets store) instances still queue for a CLI-equipped tier to drain.
// a configured llm-relay counts as an inline LLM: runClaude forwards to the subscription
// CLI on another tier, so nothing here needs the Mac RPC queue (whose drainer only serves
// the owner's own sheet — a guest instance queueing there would wait forever).
const hasLlm = () => HAS_CLAUDE || !!(CFG.llmRelayUrl && CFG.llmRelayKey) || !!process.env.ANTHROPIC_API_KEY || require('./providers').hasUserKey('openrouter');
const HAS_LLM = HAS_CLAUDE || !!(CFG.llmRelayUrl && CFG.llmRelayKey) || !!process.env.ANTHROPIC_API_KEY; // static tiers; hasLlm() adds the ⚙ user key
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
    r = await store.values.get({ spreadsheetId, range: `'${tab}'!A1:AZ` }); // 52 cols — the health sheet has >26
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
  // Task Lists bound to a shared tab (settings.quadrants[k].share) contribute their rows
  res.json({ tasks: [...rows, ...await sharedTasksAll()] });
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

// ---------- Recurring tasks ----------
// Rule token in Tags (comma-free so the comma-separated Tags column survives):
//   recur=<days>/<everyNweeks>[+<days>/<n>…]@<anchorDate>
// days = dot-joined mo|tu|we|th|fr|sa|su; the anchor fixes week parity for n>1
// ("alternating thursdays" = th/2@2026-07-31). Checking a recurring task off does NOT
// close it — the row stays open and Due advances to the next occurrence.
const RECUR_DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
function parseRecurTag(tags) {
  const m = String(tags || '').match(/(?:^|,)\s*recur=([^,\s]+)/i);
  if (!m) return null;
  const [body, anchor] = m[1].split('@');
  const parts = String(body || '').split('+').map(p => {
    const [ds, n] = p.split('/');
    const days = String(ds || '').split('.').map(d => RECUR_DAYS.indexOf(d.slice(0, 2).toLowerCase())).filter(i => i >= 0);
    return days.length ? { days, n: Math.max(1, parseInt(n, 10) || 1) } : null;
  }).filter(Boolean);
  return parts.length ? { parts, anchor: /^\d{4}-\d{2}-\d{2}$/.test(anchor || '') ? anchor : null } : null;
}
// Days sharing a cadence belong in ONE part: "monday and wednesday" is mo.we/1, not
// mo/1+we/1. Both mean the same schedule, but only the merged form round-trips through the
// single-cadence editor without dropping days.
function recurToken(parts) {
  const byN = new Map();
  for (const p of parts) byN.set(p.n, [...(byN.get(p.n) || []), ...p.days]);
  return [...byN.entries()]
    .map(([n, days]) => [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(i => RECUR_DAYS[i]).join('.') + '/' + n)
    .join('+');
}
function nextRecurDate(rule, fromIso) {
  const from = new Date((fromIso || today()) + 'T12:00:00Z');
  if (isNaN(from)) return '';
  const weekStart = d => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); x.setUTCHours(0, 0, 0, 0); return x; };
  const anchorWs = weekStart(new Date((rule.anchor || fromIso || today()) + 'T12:00:00Z'));
  for (let i = 1; i <= 120; i++) { // horizon: n≤17 weeks always hits within 120 days
    const d = new Date(from); d.setUTCDate(d.getUTCDate() + i);
    for (const p of rule.parts) {
      if (!p.days.includes(d.getUTCDay())) continue;
      const weeks = Math.round((weekStart(d) - anchorWs) / (7 * 864e5));
      if (((weeks % p.n) + p.n) % p.n === 0) return d.toISOString().slice(0, 10);
    }
  }
  return '';
}
// Capture-time schedule brackets: "water plants [Tuesday and alternating thursdays]".
// Deterministic grammar (day names, daily, alternating/every other, every N weeks) —
// an unrecognized bracket is left in the text untouched rather than guessed at.
function parseScheduleBracket(text) {
  const m = String(text || '').match(/\s*\[([^\]]+)\]\s*$/);
  if (!m) return null;
  const s = m[1].toLowerCase();
  const DAY = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, wednes: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6, satur: 6 };
  const parts = [];
  if (/\bdaily\b|\bevery ?day\b/.test(s)) parts.push({ days: [0, 1, 2, 3, 4, 5, 6], n: 1 });
  else for (const clause of s.split(/\band\b|,|;/)) {
    const wk = clause.match(/every\s+(\d+)\s*(?:weeks?|wks?)/);
    const n = /\b(alternating|every\s+other|biweekly|fortnightly)\b/.test(clause) ? 2 : (wk ? Math.max(1, parseInt(wk[1], 10)) : 1);
    const days = [...clause.matchAll(/\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|satur?)(?:day)?s?\b/g)]
      .map(d => DAY[d[1]]).filter(x => x !== undefined);
    if (days.length) parts.push({ days: [...new Set(days)], n });
  }
  if (!parts.length) return null;
  const token = recurToken(parts) + '@' + today();
  return { stripped: String(text).replace(m[0], '').trim() || String(text).trim(), token };
}

// "describe" in the repeat editor: plain English → a recur= token. The deterministic
// grammar above answers first (free, instant, exact); only what it can't parse goes to an
// LLM, which must reply with the same token shape and is validated before use — a model
// can therefore never invent a schedule the parser wouldn't accept.
app.post('/api/recur/parse', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text required' });
  const direct = parseScheduleBracket('x [' + text + ']');
  if (direct) return res.json({ ok: true, token: direct.token, rule: parseRecurTag('recur=' + direct.token), by: 'grammar' });
  const prompt = `Convert this recurrence description into ONE token and output NOTHING else.
Format: <days>/<everyNweeks>[+<days>/<n>...]
- days: dot-joined from mo tu we th fr sa su
- N: 1 = every week, 2 = every other week, 3 = every third week...
- combine differing cadences with +
Examples:
"every tuesday and alternating thursdays" -> tu/1+th/2
"weekdays" -> mo.tu.we.th.fr/1
"first thing every other monday and friday" -> mo.fr/2
Description: ${JSON.stringify(text)}`;
  let raw = '';
  try { raw = await runClaude(prompt, { module: 'recur-parse', timeoutMs: 25000 }); } catch (e) {}
  const m = String(raw || '').match(/[a-z.]+\/\d+(?:\+[a-z.]+\/\d+)*/i);
  const parsed = m ? parseRecurTag('recur=' + m[0].toLowerCase() + '@' + today()) : null;
  if (!parsed) return res.json({ ok: false, error: "couldn't turn that into a repeat rule — try e.g. \"every tuesday and alternating thursdays\"" });
  const token = recurToken(parsed.parts) + '@' + today();
  res.json({ ok: true, token, rule: parseRecurTag('recur=' + token), by: 'llm' });
}));

app.post('/api/tasks', asyncRoute(async (req, res) => {
  const { task, quadrant, due, notes, scope, owner, tags, source } = req.body || {};
  if (!task || !quadrant) return res.status(400).json({ error: 'task and quadrant are required' });
  // schedule bracket → recur tag + first-occurrence Due; unparsed brackets pass through
  let taskText = task, taskTags = tags || '', taskDue = due || '';
  const sched = parseScheduleBracket(task);
  if (sched) {
    taskText = sched.stripped;
    taskTags = (taskTags ? taskTags + ',' : '') + 'recur=' + sched.token;
    if (!taskDue) taskDue = nextRecurDate(parseRecurTag('recur=' + sched.token), today());
  }
  // shared-tab-backed list: the entry belongs on the family sheet, not the Todo tab
  const bind = sharedBindOfKey(quadrant);
  if (bind) {
    const tab = bind.cfg.tab || bind.slug;
    const uid = crypto.randomUUID();
    const row = await sharedListAddItem(bind.cfg.sheetId, tab, taskText, { due: taskDue, tags: taskTags, uid });
    const task = { ID: `sh:${bind.slug}:${row}`, Task: taskText, Quadrant: bind.key, Status: 'Open',
      Due: taskDue, Tags: taskTags, Source: 'shared', Owner: bind.cfg.name || '', comments: [] };
    fireListHook('created', task);
    return res.json({ ok: true, task });
  }
  const { headers, headerRow, rows } = await readTodoTab();
  const id = crypto.randomUUID();
  const rowObj = {
    Task: taskText, Quadrant: quadrant, Scope: scope || 'Personal', Owner: owner || CFG.owner,
    Due: taskDue, Status: 'Open', Created: today(), Notes: notes || '',
    // agent callers (journal-read) pass source:'code'; browser clicks default to 'web'
    Source: source || WRITE_SOURCE, Updated: nowIso(), Tags: taskTags, ID: id,
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
  const sh = parseSharedId(req.params.id);
  // Cross-store moves (drag & drop between a normal list and a shared-tab list) must move
  // the ROW, not just relabel it — otherwise a task dragged into a shared list would look
  // shared here and be invisible to the other party.
  const dest = changes.Quadrant !== undefined ? sharedBindOfKey(changes.Quadrant) : undefined;
  if (changes.Quadrant !== undefined && (sh || dest) && !(sh && dest && dest.slug === sh.slug)) {
    if (sh && !dest) { // shared → Todo tab
      const { items } = await sharedListRead(sh.cfg.sheetId, sh.tab);
      const it = items.find(i => i.row === sh.row);
      if (!it) return res.status(404).json({ error: 'item not found' });
      const { headers, headerRow, rows } = await readTodoTab();
      const id = crypto.randomUUID();
      const rowObj = { Task: changes.Task || it.text, Quadrant: changes.Quadrant, Scope: 'Personal', Owner: CFG.owner,
        Due: changes.Due !== undefined ? changes.Due : it.due, Status: 'Open', Created: today(), Notes: '',
        Source: WRITE_SOURCE, Updated: nowIso(), Tags: changes.Tags !== undefined ? changes.Tags : it.tags, ID: id, Order: '', Parent: '' };
      const lastRow = rows.length ? Math.max(...rows.map(r => r._row)) : headerRow;
      await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${TODO_TAB}'!A${lastRow + 1}`,
        valueInputOption: 'RAW', requestBody: { values: [headers.map(h => rowObj[h] !== undefined ? rowObj[h] : '')] } });
      await sharedListClearRow(sh.cfg.sheetId, sh.tab, sh.row);
      fireListHook('updated', rowObj);
      return res.json({ ok: true, task: rowObj, moved: 'to-todo' });
    }
    const src = sh ? null : (await readTodoTab()).rows.find(r => r.ID === req.params.id);
    if (dest && (src || sh)) { // Todo tab (or another shared tab) → shared tab
      let text, due, tags;
      if (sh) {
        const { items } = await sharedListRead(sh.cfg.sheetId, sh.tab);
        const it = items.find(i => i.row === sh.row);
        if (!it) return res.status(404).json({ error: 'item not found' });
        ({ text, due, tags } = { text: it.text, due: it.due, tags: it.tags });
      } else ({ text, due, tags } = { text: src.Task, due: src.Due, tags: src.Tags });
      const tab = dest.cfg.tab || dest.slug;
      const row = await sharedListAddItem(dest.cfg.sheetId, tab, changes.Task || text,
        { due: changes.Due !== undefined ? changes.Due : due, tags: changes.Tags !== undefined ? changes.Tags : tags, uid: crypto.randomUUID() });
      if (sh) await sharedListClearRow(sh.cfg.sheetId, sh.tab, sh.row);
      else await updateTaskById(req.params.id, { Status: 'archived' });
      const task = { ID: `sh:${dest.slug}:${row}`, Task: changes.Task || text, Quadrant: dest.key, Status: 'Open', Source: 'shared' };
      fireListHook('updated', task);
      return res.json({ ok: true, task, moved: 'to-shared' });
    }
  }
  if (sh) { // shared-tab row: 'archived' means remove the entry, everything else is a field write
    if (changes.Status === 'archived') await sharedListClearRow(sh.cfg.sheetId, sh.tab, sh.row);
    else await sharedListSetTask(sh.cfg.sheetId, sh.tab, sh.row, changes);
    const task = { ID: req.params.id, ...changes };
    fireListHook('updated', task);
    return res.json({ ok: true, task });
  }
  const updated = await updateTaskById(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: 'task not found: ' + req.params.id });
  fireListHook('updated', updated);
  res.json({ ok: true, task: updated });
}));

// Owner reply on a shared row — lands in the same D:G log the helper's page reads, so the
// answer shows inline under their question on every surface — both owners' and the helper's.
app.post('/api/tasks/:id/comment', asyncRoute(async (req, res) => {
  const sh = parseSharedId(req.params.id);
  if (!sh) return res.status(400).json({ error: 'comments live on shared rows only' });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const { items } = await sharedListRead(sh.cfg.sheetId, sh.tab);
  const it = items.find(i => i.row === sh.row);
  if (!it) return res.status(404).json({ error: 'item not found' });
  await sharedListAddComment(sh.cfg.sheetId, sh.tab, it.text, CFG.userName || CFG.owner || 'me', text);
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/done', asyncRoute(async (req, res) => {
  const sh = parseSharedId(req.params.id);
  if (sh) { // shared-tab row: recurring → advance Due (stays open); otherwise owner-check it
    const { items } = await sharedListRead(sh.cfg.sheetId, sh.tab);
    const it = items.find(i => i.row === sh.row);
    if (!it) return res.status(404).json({ error: 'item not found' });
    const rule = parseRecurTag(it.tags);
    if (rule) {
      const next = nextRecurDate(rule, today());
      await sharedListSetTask(sh.cfg.sheetId, sh.tab, sh.row, { Due: next });
      return res.json({ ok: true, task: { ID: req.params.id, Due: next }, recurred: true, nextDue: next });
    }
    await sharedListSetTask(sh.cfg.sheetId, sh.tab, sh.row, { Status: 'done' });
    const task = { ID: req.params.id, Task: it.text, Quadrant: sh.slug, Status: 'done' };
    fireListHook('done', task);
    return res.json({ ok: true, task });
  }
  // recurring task: the check means "done for this occurrence" — stay open, advance Due
  const { rows } = await readTodoTab();
  const cur = rows.find(r => r.ID === req.params.id);
  const rule = cur && parseRecurTag(cur.Tags);
  if (rule) {
    const next = nextRecurDate(rule, today());
    const updated = await updateTaskById(req.params.id, { Due: next });
    fireListHook('recurred', updated);
    return res.json({ ok: true, task: updated, recurred: true, nextDue: next });
  }
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
  // Only a missing/empty tab may bootstrap numbering at AT001. Any OTHER read failure
  // (429, network) must throw: minting AT001 over an existing sheet creates duplicate IDs,
  // and closeAgentTask(id) then closes whichever row matches first (2026-08-08 audit).
  try { rows = (await readTab(TODO_SHEET_ID, AGENT_TASKS_TAB, AGENT_TASKS_HEADERS)).rows; }
  catch (e) { if (!/Unable to parse range|not found/i.test(String(e.message))) throw e; }
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
  // A Sheets read failure must NEVER masquerade as "zero open threads": the heartbeat's
  // Stage E carry-forward trusts this endpoint, and 200 {tasks:[]} on a transient 429 is
  // exactly how open AT threads silently vanished from a day's Agent Feedback.
  let rows;
  try { rows = (await readTab(TODO_SHEET_ID, AGENT_TASKS_TAB, AGENT_TASKS_HEADERS)).rows; }
  catch (e) { return res.status(503).json({ error: 'agent-tasks read failed: ' + e.message }); }
  const status = String(req.query.status || '').trim().toLowerCase();
  const out = (status ? rows.filter(r => String(r.Status || '').trim().toLowerCase() === status) : rows)
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
const EDITABLE_TAB_HEADERS = {
  SOURCES: ['Source', 'URL', 'All', 'Top stories', 'Notes'],
  SUBJECTS: ['Subject', 'Weight', 'Notes'],
  PEOPLE: ['Author', 'Why', 'Deceased', 'Notes'],
  TOPOFMIND: ['Subject', 'Added', 'Notes'],
  REMINDERS: ['Reminder', 'Date', 'Notes'],
  LOCATIONS: ['Location', 'From', 'Notes'],
  ACTIVITIES: ['Activity', 'Instructions', 'Lead days', 'Show'],
};
async function loadEditablePref(tab) {
  let r;
  try { r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` }); }
  catch (e) { // a fresh guest/public prefs sheet: create the tab and start blank
    if (!/Unable to parse range/i.test(String(e.message || ''))) throw e;
    await ensureTab(tab, EDITABLE_TAB_HEADERS[tab] || ['Item'], PREFS_SHEET_ID);
    r = await store.values.get({ spreadsheetId: PREFS_SHEET_ID, range: `'${tab}'!A1:Z` });
  }
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
// A fresh prefs sheet (a guest's own datastore) has none of the driving tabs — create them
// with their standard headers so Describe works from a blank canvas.
const DESCRIBE_TAB_HEADERS = {
  SOURCES: ['Source', 'URL', 'All', 'Top stories', 'Notes'],
  SUBJECTS: ['Subject', 'Weight', 'Notes'],
  PEOPLE: ['Name', 'Why', 'Deceased', 'Notes'],
  LOCATIONS: ['Location', 'From', 'To', 'Notes'],
  TOPOFMIND: ['Item', 'Added', 'Notes'],
};
async function ensureDescribeTabs() {
  for (const t of DESCRIBE_TABS) await ensureTab(t, DESCRIBE_TAB_HEADERS[t], PREFS_SHEET_ID).catch(() => {});
}
async function doNewsDescribe({ text }) {
  // one batchGet, not five reads — the per-minute Sheets read quota is tight when
  // several instances share the service account
  let resp;
  try {
    resp = await store.values.batchGet({ spreadsheetId: PREFS_SHEET_ID, ranges: DESCRIBE_TABS.map(t => `'${t}'!A1:Z`) });
  } catch (e) {
    if (!/Unable to parse range/i.test(String(e.message || ''))) throw e;
    await ensureDescribeTabs();
    resp = await store.values.batchGet({ spreadsheetId: PREFS_SHEET_ID, ranges: DESCRIBE_TABS.map(t => `'${t}'!A1:Z`) });
  }
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

// ---------- API key management (🔑 in ⚙): stored keys hydrate process.env at boot ----------
// Disk tiers (Mac/VM): ~/.config/dashboard/api-keys.json, mode 600 — outside every repo.
// Cloud Run (ephemeral fs): GCP Secret Manager, secret 'dashboard-api-keys', one JSON payload.
// Keys are verified against the provider BEFORE saving, never echoed back (masked last-4 only),
// and never logged. Providers read process.env, so everything downstream just works.
const KEYS_FILE = path.join(os.homedir(), '.config', 'dashboard', 'api-keys.json');
const ON_CLOUD_RUN = !!process.env.K_SERVICE;
const KEYS_SECRET = 'dashboard-api-keys';
const KEY_PROVIDERS = {
  anthropic: { env: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)',
    verify: k => fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) }) },
  google: { env: 'GEMINI_API_KEY', label: 'Google (Gemini)',
    verify: k => fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(k), { signal: AbortSignal.timeout(10000) }) },
  openai: { env: 'OPENAI_API_KEY', label: 'OpenAI',
    verify: k => fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(10000) }) },
  xai: { env: 'XAI_API_KEY', label: 'xAI (Grok)',
    verify: k => fetch('https://api.x.ai/v1/models', { headers: { Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(10000) }) },
  openrouter: { env: 'OPENROUTER_API_KEY', label: 'OpenRouter',
    // /auth/key validates the key itself (the models list is public and would pass any string)
    verify: k => fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(10000) }) },
};
async function smAccess() {
  const auth = new (require('google-auth-library').GoogleAuth)({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return { auth, projectId: await auth.getProjectId(), client: await auth.getClient() };
}
async function smFetch(method, url, body) {
  const { client } = await smAccess();
  const h = await client.getRequestHeaders();
  const r = await fetch(url, { method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`secret-manager ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}
function readKeysFile() { try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (e) { return {}; } }
async function readStoredKeys() {
  if (!ON_CLOUD_RUN) return readKeysFile();
  try {
    const { projectId } = await smAccess();
    const r = await smFetch('GET', `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${KEYS_SECRET}/versions/latest:access`);
    return JSON.parse(Buffer.from(r.payload.data, 'base64').toString());
  } catch (e) { return {}; }
}
async function persistStoredKeys(keys) {
  if (!ON_CLOUD_RUN) {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 1), { mode: 0o600 });
    fs.chmodSync(KEYS_FILE, 0o600);
    return 'config file (mode 600)';
  }
  const { projectId } = await smAccess();
  try { await smFetch('POST', `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${KEYS_SECRET}`, { replication: { automatic: {} } }); }
  catch (e) { if (!/409/.test(e.message)) throw e; } // exists = fine
  await smFetch('POST', `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${KEYS_SECRET}:addVersion`,
    { payload: { data: Buffer.from(JSON.stringify(keys)).toString('base64') } });
  return 'GCP Secret Manager';
}
let keyMeta = {}; // provider → last4 of STORED keys (full keys only in env + storage)
readStoredKeys().then(keys => {
  for (const [p, def] of Object.entries(KEY_PROVIDERS)) if (keys[p] && !process.env[def.env]) process.env[def.env] = keys[p];
  keyMeta = Object.fromEntries(Object.entries(keys).map(([p, v]) => [p, String(v).slice(-4)]));
}).catch(() => {});
app.get('/api/keys', asyncRoute(async (req, res) => res.json({
  storage: ON_CLOUD_RUN ? 'GCP Secret Manager' : '~/.config/dashboard/api-keys.json (600)',
  providers: Object.entries(KEY_PROVIDERS).map(([id, d]) => ({
    id, label: d.label,
    stored: keyMeta[id] ? '••••' + keyMeta[id] : null,        // masked — the key itself never leaves
    fromEnv: !!process.env[d.env] && !keyMeta[id],            // set at deploy time rather than via the panel
  })),
})));
app.post('/api/keys/verify', asyncRoute(async (req, res) => {
  const { provider, key } = req.body || {};
  const d = KEY_PROVIDERS[provider];
  if (!d || !String(key || '').trim()) return res.status(400).json({ error: 'provider + key required' });
  try { const r = await d.verify(String(key).trim()); res.json({ ok: r.ok, status: r.status }); }
  catch (e) { res.json({ ok: false, status: 0, error: e.message.slice(0, 100) }); }
}));
app.post('/api/keys', asyncRoute(async (req, res) => {
  const { provider, key } = req.body || {};
  const d = KEY_PROVIDERS[provider];
  const k = String(key || '').trim();
  if (!d || !k) return res.status(400).json({ error: 'provider + key required' });
  const v = await d.verify(k).catch(() => null);
  if (!v || !v.ok) return res.status(400).json({ error: `key failed verification (${v ? 'HTTP ' + v.status : 'network'})` });
  const keys = await readStoredKeys();
  keys[provider] = k;
  let where;
  try { where = await persistStoredKeys(keys); }
  catch (e) { return res.status(502).json({ error: 'verified OK but could not persist: ' + e.message.slice(0, 140) }); }
  process.env[d.env] = k;
  keyMeta[provider] = k.slice(-4);
  res.json({ ok: true, stored: '••••' + k.slice(-4), where });
}));
app.delete('/api/keys/:provider', asyncRoute(async (req, res) => {
  const p = req.params.provider, d = KEY_PROVIDERS[p];
  if (!d) return res.status(400).json({ error: 'unknown provider' });
  const keys = await readStoredKeys();
  delete keys[p];
  try { await persistStoredKeys(keys); } catch (e) { return res.status(502).json({ error: e.message.slice(0, 140) }); }
  delete keyMeta[p]; delete process.env[d.env];
  res.json({ ok: true });
}));

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
const PLUGIN_BRIEF = []; // briefItems() → [{kind, text}] salient non-news items the Agent Brief may elevate
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
  comment: 0, // freeform note the owner types for the CI to read — context, not a vote
  // Jobs board (/jobs) — the same Tinder-style label stream, applied to job openings.
  // subjects[] carries the job's Category so CI/searcher credit-assign per category.
  job_not_interested: -1, // swipe left / ✕ — wrong kind of role, don't refill with similar
  job_ranked_up: 1, // dragged higher in the list — mild "more like this"
  job_more_like_this: 2, // explicit 👍 — strong "more like this"
  job_applied: 3, // actually applied — the strongest job signal there is
  job_comment: 0, // freeform note typed on the /jobs board — add-job requests, new categories,
  // search steering; consumed by the daily search agent and the nightly CI, not a vote
  job_maybe: 0.5, // parked in the Maybe section — deferred interest, mildly positive
  job_rejected: 0, // application outcome, not a preference — CI learns which applications convert
  job_closed: 0, // posting died / link dead — housekeeping, carries NO taste information
};
// Shared writer: Mac appends to the CI's JSONL directly; stateless tiers queue on the
// Feedback Queue tab for the heartbeat to drain (identical semantics to /api/feedback).
async function writeFeedbackEntry(entry) {
  const line = JSON.stringify(entry);
  if (HAS_JOURNAL) fs.appendFileSync(FEEDBACK_FILE, line + '\n');
  else await appendTabRow(FB_TAB, FB_HEADERS, [line, nowIso(), '']);
}

const PLUGIN_RPC = {}; // cloud→Mac RPC handlers registered by plugins (ctx.registerRpc)
// The widget API: everything an extracted section legitimately needs. Grown deliberately —
// each name here is a commitment to plugin authors (community widgets included).
const pluginCtx = () => ({
  store, config: CFG, sheetId: TODO_SHEET_ID,
  runLLM: (prompt, opts) => runClaude(prompt, opts),
  readTab, readTabCached, appendTabRow, ensureTab, colLetter, readMediaTab, pmap, prefRows, decodeEntities,
  writeFeedbackEntry, SIGNAL_BY_KIND, asyncRoute, track, nowIso, today,
  loadSettings, saveSettings, enqueueRpc, hasLlm,
  registerRpc: (kind, fn) => { PLUGIN_RPC[String(kind)] = fn; },
});
// Load order: plugins-forks/ FIRST, then plugins/. A fork (a per-instance rewrite of a
// widget, produced by the owner-side forge from a trusted user's request) wins by key —
// the base plugin with the same key is skipped entirely (data, routes, jobs, all hooks),
// so fork routes are never shadowed by base ones. Deleting the fork file reverts to base.
// plugins-forks/ sits at the SAME depth as plugins/ so the universal plugin idioms —
// path.join(__dirname, '..', 'data', …) and sidecar readFileSync(__dirname, …) — keep
// resolving identically in a fork. Do not nest forks under plugins/.
try {
  const pluginFiles = [];
  const forksDir = path.join(__dirname, 'plugins-forks');
  if (fs.existsSync(forksDir))
    for (const f of fs.readdirSync(forksDir).filter(f => f.endsWith('.js'))) pluginFiles.push(path.join(forksDir, f));
  for (const f of fs.readdirSync(path.join(__dirname, 'plugins')).filter(f => f.endsWith('.js'))) pluginFiles.push(path.join(__dirname, 'plugins', f));
  const seenKeys = new Set();
  for (const file of pluginFiles) {
    const f = path.basename(file);
    try {
      const p = require(file);
      if (!p) continue;
      if (p.key && seenKeys.has(p.key)) continue; // base skipped where a fork owns the key
      if (p.key) seenKeys.add(p.key);
      if (p.key && typeof p.data === 'function') PLUGINS[p.key] = p;
      if (typeof p.routes === 'function') p.routes(app, pluginCtx());
      for (const j of (Array.isArray(p.jobs) ? p.jobs : []))
        if (j && j.everyMs > 0 && typeof j.run === 'function')
          setInterval(() => Promise.resolve(j.run(pluginCtx())).catch(e => console.error(`plugin job (${f}):`, e.message)), j.everyMs);
      for (const s of (Array.isArray(p.newsSources) ? p.newsSources : []))
        if (s && s.title && typeof s.build === 'function') PLUGIN_NEWS_SOURCES.push({ ...s, _file: f });
      if (typeof p.healthRows === 'function') PLUGIN_HEALTH.push({ fn: p.healthRows, _file: f });
      if (typeof p.llm === 'function') PLUGIN_LLM.push({ fn: p.llm, _file: f }); // LLM router: return a string to answer, null to pass
      if (typeof p.briefItems === 'function') PLUGIN_BRIEF.push({ fn: p.briefItems.bind(p), _file: f }); // salient weather/etc → Agent Brief
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
  res.json({ plugins: Object.values(PLUGINS).map(p => ({ key: p.key, core: !!p.core, title: p.title || p.key, client: p.client || null })) })));
app.get('/api/plugin/:key', asyncRoute(async (req, res) => {
  const p = PLUGINS[req.params.key];
  if (!p) return res.status(404).json({ error: 'no such plugin' });
  try { res.json({ data: await p.data(pluginCtx()) }); } catch (e) { res.status(500).json({ error: e.message }); }
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
  if (s.journal && typeof s.journal === 'object') { // journal widget config — validated shape, full replace
    next.journal = { enabled: !!s.journal.enabled,
      fields: (Array.isArray(s.journal.fields) ? s.journal.fields : []).filter(f => f && f.key).slice(0, 12)
        .map(f => ({ key: String(f.key).slice(0, 30), label: String(f.label || f.key).slice(0, 40), track: !!f.track })),
      sections: (Array.isArray(s.journal.sections) ? s.journal.sections : []).filter(x => x && x.key).slice(0, 10)
        .map(x => ({ key: String(x.key).slice(0, 30), title: String(x.title || x.key).slice(0, 60),
          stash: ['column', 'folder', 'file'].includes(x.stash) ? x.stash : 'column', familyLog: !!x.familyLog })) };
  }
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
  if (s.openrouterKey !== undefined) { // ⚙ LLM access (public tier w/o CLI/relay)
    const v = String(s.openrouterKey || '').trim().slice(0, 200);
    if (v) next.openrouterKey = v; else delete next.openrouterKey;
    require('./providers').setUserKey('openrouter', v);
  }
  if (s.fontScale !== undefined) { // page-wide text scale (⚙ Text size)
    const v = parseFloat(s.fontScale);
    if (v >= 0.8 && v <= 1.4) next.fontScale = String(v); else delete next.fontScale;
  }
  if (s.newsSubtitles && typeof s.newsSubtitles === 'object') { // ✨ Describe regenerates the section blurbs
    next.newsSubtitles = {};
    for (const [k, v] of Object.entries(s.newsSubtitles))
      if (typeof v === 'string' && v.trim()) next.newsSubtitles[k] = v.trim().slice(0, 90);
  }
  if (typeof s.briefHook === 'string') next.briefHook = s.briefHook.trim().slice(0, 300); // '' = off
  if (s.listShares && typeof s.listShares === 'object') { // shared-list tokens {slug:{token,name}}
    next.listShares = {};
    for (const [k, v] of Object.entries(s.listShares))
      if (v && v.token) next.listShares[String(k).slice(0, 60)] = { token: String(v.token).slice(0, 64), name: String(v.name || '').slice(0, 40),
        ...(v.label ? { label: String(v.label).slice(0, 60) } : {}), ...(v.sheetId ? { sheetId: String(v.sheetId).slice(0, 60) } : {}), ...(v.tab ? { tab: String(v.tab).slice(0, 40) } : {}) };
  }
  if (Array.isArray(s.clearedLeads)) next.clearedLeads = s.clearedLeads.filter(x => typeof x === 'string').slice(-100);
  if (typeof s.locInputSync === 'boolean') next.locInputSync = s.locInputSync; // sticky "sync to calendar" default
  if (Array.isArray(s.links)) next.links = s.links.filter(l => l && typeof l.url === 'string' && l.url.trim())
    .slice(0, 50).map(l => ({ url: String(l.url).trim().slice(0, 300), label: String(l.label || '').slice(0, 40), icon: String(l.icon || '').slice(0, 8) }));
  if (s.headline && typeof s.headline === 'object') { // greeting override + date-format preset
    next.headline = {};
    if (typeof s.headline.greeting === 'string') next.headline.greeting = s.headline.greeting.trim().slice(0, 60);
    if (['weekday-long', 'weekday-short', 'numeric', 'iso'].includes(s.headline.dateFormat)) next.headline.dateFormat = s.headline.dateFormat;
  }
  if ('cycle' in s) { // pink-"?" prediction: {lastStart 'YYYY-MM-DD', length days}; null clears
    if (s.cycle === null) delete next.cycle;
    else if (s.cycle && /^\d{4}-\d{2}-\d{2}$/.test(String(s.cycle.lastStart || '')))
      next.cycle = { lastStart: s.cycle.lastStart, length: Math.min(60, Math.max(15, +s.cycle.length || 28)) };
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
  const settings0 = loadSettings();
  const cfg = (settings0.calendars || []).filter(c => c.on !== false);
  const sources = cfg.length ? cfg : [{ type: 'gcal', id: CALENDAR_ID || (settings0.gcalToken ? 'primary' : '') }];
  // user-connected calendar (OAuth refresh token) — used for gcal reads when present
  let userCal = null;
  if (settings0.gcalToken && settings0.gcalToken.refresh_token && OAUTH_ID) {
    const oc = new OAuth2Client(OAUTH_ID, OAUTH_SECRET);
    oc.setCredentials({ refresh_token: settings0.gcalToken.refresh_token });
    userCal = google.calendar({ version: 'v3', auth: oc });
  }
  const events = [];
  const errors = [];
  await pmap(sources, async src => {
    try {
      if (src.type === 'ical' && src.url) {
        const r = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) throw new Error(`ical HTTP ${r.status}`);
        events.push(...parseIcs(await r.text(), timeMin, weekEnd).map(e => ({ ...e, source: src.url.slice(0, 40) })));
      } else {
        const r = await (userCal || calendar).events.list({
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
  // manual/device-set location wins for TODAY (fresh <48h) — the generic path for
  // instances without the owner's evidence pipeline (email bars). Then the bars, then home.
  const man = (loadSettings().manualLocation || {});
  if (man.name && dateStr === today() && Date.now() - (man.at || 0) < 48 * 3600e3) return man.name;
  const b = loadLocationBars().find(b => b.start <= dateStr && dateStr <= b.end && b.location && b.location !== 'Location?');
  return b ? b.location : (typeof HOME_LOCATION !== 'undefined' ? HOME_LOCATION : '') || man.name || '';
}
// manual or device location: {name} (typed) or {lat,lon} (browser geolocation → reverse
// geocoded). Stored in settings so every tier of the instance agrees.
app.post('/api/location/set', asyncRoute(async (req, res) => {
  let name = String((req.body || {}).name || '').trim().slice(0, 80);
  const { lat, lon } = req.body || {};
  if (!name && typeof lat === 'number' && typeof lon === 'number') {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?latitude=${lat}&longitude=${lon}&count=1`).then(x => x.json()).catch(() => null);
      const g = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=${(CFG.languages || [])[0] || 'en'}`,
        { headers: { 'User-Agent': 'dashboard-location/1.0' } }).then(x => x.json()).catch(() => null);
      name = (g && (g.address?.city || g.address?.town || g.address?.village || g.name)) || (r && r.results?.[0]?.name) || '';
    } catch (e) {}
    if (!name) return res.status(422).json({ error: 'could not resolve those coordinates to a place' });
  }
  if (!name) return res.status(400).json({ error: 'name or lat/lon required' });
  const next = { ...loadSettings(), manualLocation: { name, at: Date.now() } };
  await saveSettings(next);
  res.json({ ok: true, name });
}));
app.get('/api/location/current', asyncRoute(async (req, res) => res.json({ location: locationOnDate(today()) })));
// which engine answers LLM work here — drives the ⚙ "LLM access" row
const trialDaysLeft = () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(CFG.trialEnd || '')) return null;
  return Math.ceil((Date.parse(CFG.trialEnd) - Date.now()) / 864e5); };
const trialActive = () => { const d = trialDaysLeft(); return d !== null && d > 0; };
app.get('/api/llm/status', (req, res) => {
  const engine = (trialActive() && CFG.gcpProject) ? 'vertex (GCP trial credits) + claude-cli for tools'
    : HAS_CLAUDE ? 'claude-cli (subscription)'
    : (CFG.llmRelayUrl && CFG.llmRelayKey) ? 'relay (shared subscription)'
    : process.env.ANTHROPIC_API_KEY ? 'anthropic API key'
    : require('./providers').hasUserKey('openrouter') ? 'OpenRouter key (yours)'
    : 'none';
  res.json({ engine, needsKey: engine === 'none', trialDaysLeft: trialDaysLeft(),
    sponsorDaysLeft: runClaude._sponsorDaysLeft ?? null });
});
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
  // ONCE A DAY, morning-gated (David 2026-07-30): the hourly rebuild was ~20 grok x_search
  // calls/day, and xAI bills live search PER SOURCE outside the token meter — the invisible
  // ~$2/day. One morning pull serves all tiers all day via the cross-tier cell.
  const FRESH = 24 * 60 * 60 * 1000;
  if (followingCache.items.length && Date.now() - followingCache.at < FRESH) return followingCache.items;
  const cell = await readFollowingCell();               // pull whatever the Mac/VM last built
  if (cell.items.length && cell.at > followingCache.at) followingCache = { at: cell.at, items: cell.items };
  const morningWindow = (h => h >= 5 && h < 12)(new Date().getHours());
  if (HAS_CLAUDE && Date.now() - followingCache.at > FRESH && !followingBusy && morningWindow) { // only Mac/VM rebuild
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
  // Ephemeral geographies: wherever the owner IS or WILL BE (14d) scores news too — merged
  // at build time, never written to the LOCATIONS tab, so they evaporate the moment the
  // location does. Pin a place on the tab (or keep it in travel plans) to make it stick.
  {
    const eph = new Set([locationOnDate(today())]);
    for (const b of loadLocationBars()) if (b.end >= today() && b.start <= addDays(today(), 14) && b.location && b.location !== 'Location?') eph.add(b.location);
    const have = new Set(locations.map(l => String(l).toLowerCase()));
    for (const l of eph) if (l && !have.has(String(l).toLowerCase())) locations.push(l);
  }
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
  // Source tiering ORDERS the News section. The map is the OWNER'S taste, so it lives in
  // config (newsTiers: [{match: <regex>, tier: 1-4}], config-local/env) — hard-coding a
  // person's subscriptions here once leaked them to every guest instance and the public
  // stub. No config = everything tier 4 (pure salience order); tweets stay tier 3.
  const tierRules = (CFG.newsTiers || []).map(r => { try { return { re: new RegExp(r.match, 'i'), tier: Math.min(4, Math.max(1, +r.tier || 4)) }; } catch (e) { return null; } }).filter(Boolean);
  const sourceTier = it => {
    const s = String(it.source || '');
    for (const r of tierRules) if (r.re.test(s)) return r.tier;
    if (it.tweet || /^@/.test(s)) return 3;
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

// ---- guest CI: "How would you like to change this dashboard?" ----
// On an instance with CFG.ciAutoApply, a freeform suggestion is applied IMMEDIATELY as a
// settings patch (sections shown/hidden/renamed/reordered, list labels/layout) — nothing
// else is reachable: the LLM must answer in a whitelisted patch shape, the patch goes
// through the same sanitizer as the ⚙ panel, and unparseable answers fall back to
// capture-only. Every suggestion is also logged as an idea row. Cap: CFG.ciApplyPerDay.
const CI_APPLY_LOG = path.join(__dirname, 'data', 'ci-apply-log.json');
function ciAppliedToday() {
  try { const j = JSON.parse(fs.readFileSync(CI_APPLY_LOG, 'utf8')); return j.date === today() ? j.n : 0; } catch (e) { return 0; }
}
function ciBumpApplied() {
  const n = ciAppliedToday() + 1;
  try { fs.writeFileSync(CI_APPLY_LOG, JSON.stringify({ date: today(), n })) } catch (e) {}
  return n;
}
function ciSanitizePatch(raw) {
  let p; try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
  if (!p || typeof p !== 'object') return null;
  const out = {};
  if (p.sections && typeof p.sections === 'object') {
    out.sections = {};
    for (const [k, v] of Object.entries(p.sections)) {
      if (!v || typeof v !== 'object') continue;
      const e = {};
      if (typeof v.hidden === 'boolean' && !(k === 'cinote' && v.hidden)) e.hidden = v.hidden; // never let it hide the suggestion box
      if (typeof v.title === 'string' && v.title.trim()) e.title = v.title.trim().slice(0, 60);
      if (Number.isFinite(+v.order)) e.order = +v.order;
      if (typeof v.collapsed === 'boolean') e.collapsed = v.collapsed;
      if (Object.keys(e).length) out.sections[String(k).slice(0, 40)] = e;
    }
    if (!Object.keys(out.sections).length) delete out.sections;
  }
  if (p.quadrants && typeof p.quadrants === 'object') {
    out.quadrants = {};
    for (const [k, v] of Object.entries(p.quadrants)) {
      if (!v || typeof v !== 'object') continue;
      const e = {};
      if (typeof v.label === 'string' && v.label.trim()) e.label = v.label.trim().slice(0, 60);
      if (typeof v.sub === 'string') e.sub = v.sub.slice(0, 120);
      if (Number.isFinite(+v.order)) e.order = +v.order;
      if (v.w >= 1 && v.w <= 12) e.w = Math.round(v.w);
      if (typeof v.collapsed === 'boolean') e.collapsed = v.collapsed;
      if (['bullets', 'ranked'].includes(v.style)) e.style = v.style;
      if (Object.keys(e).length) out.quadrants[String(k).slice(0, 40)] = e;
    }
    if (!Object.keys(out.quadrants).length) delete out.quadrants;
  }
  return Object.keys(out).length ? out : null;
}
async function ciTryApply(suggestion) {
  if (!CFG.ciAutoApply) return { applied: false };
  const perDay = Number(CFG.ciApplyPerDay) || 20;
  if (ciAppliedToday() >= perDay) return { applied: false, reason: 'daily limit reached' };
  const s = loadSettings();
  const prompt = `You configure a personal dashboard. Turn the user's request into a JSON settings patch and output ONLY the JSON (no prose, no fences).
Allowed shape: {"sections":{"<key>":{"hidden":bool,"title":"…","order":num,"collapsed":bool}},"quadrants":{"<key>":{"label":"…","sub":"…","order":num,"w":1-12,"collapsed":bool,"style":"bullets"|"ranked"}}}
Section keys and what they are (match the user's words to the MEANING, in any language):
 todo=persistent task lists (listes persistantes) · jlists=ephemeral notes (notes éphémères) · cinote=this suggestion box · links=links (liens) · habits=habits (habitudes) · brief=agent brief · today=today cards (aujourd'hui) · jobsboard=job openings · agents=agent stable · files=file manager · completed=completed tasks (terminées) · media=reading queue (à lire) · markets=markets (marchés) · signals=market signals · surf=wind & waves (vent & vagues) · news=news (actus) · week=week ahead (la semaine) · plugin:nature-weather=nature & weather (météo) · plugin:cycle=cycle tracking (cycle)
NEVER set cinote.hidden=true — this box is how the user talks to you.
Current sections config: ${JSON.stringify(s.sections || {}).slice(0, 1500)}
Current lists config: ${JSON.stringify(s.quadrants || {}).slice(0, 1500)}
If the request is not about layout/visibility/naming of sections or lists, output exactly {}.
Request (may be in French): ${JSON.stringify(String(suggestion).slice(0, 400))}`;
  let raw = '';
  // runClaude = the owner's subscription everywhere: the CLI where it exists, the relay
  // on tiers that lack it; API keys only as the stub's last resort.
  try { raw = await runClaude(prompt, { module: 'ci-apply', timeoutMs: 45000 }); } catch (e) { return { applied: false, reason: 'no LLM: ' + String(e.message).slice(0, 120) }; }
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  const patch = m && ciSanitizePatch(m[0]);
  if (!patch) return { applied: false, reason: 'not a layout change' };
  const next = loadSettings();
  next.sections = { ...(next.sections || {}), ...Object.fromEntries(Object.entries(patch.sections || {}).map(([k, v]) => [k, { ...(next.sections || {})[k], ...v }])) };
  next.quadrants = { ...(next.quadrants || {}), ...Object.fromEntries(Object.entries(patch.quadrants || {}).map(([k, v]) => [k, { ...(next.quadrants || {})[k], ...v }])) };
  saveSettings(next);
  const n = ciBumpApplied();
  return { applied: true, patch, n, perDay };
}

// ---- widget forge intake (CFG.widgetForge, on top of ciAutoApply trust) ----
// A request the settings-patcher can't express (code change to a widget, a brand-new
// widget, or undoing one) becomes an RPC row that an OWNER-SIDE forge worker drains:
// it writes a per-instance plugin fork, gates it, and redeploys THIS tier only. New
// widgets go through a spec-confirm loop — the plan is shown and must be confirmed in
// the UI before a build row is queued. Nothing here executes code; this is triage only.
async function forgeClassify(request) {
  const keys = Object.keys(PLUGINS);
  const prompt = `You triage a personal-dashboard change request. Forkable widgets on this instance: ${keys.join(', ') || '(none)'}.
Decide what the request is (the request may be in any language; answer spec in the USER'S language):
- a CODE/feature change to one of those widgets (add a button, change a chart, show extra data) → {"kind":"widget_change","widget":"<existing key>","spec":"<one-paragraph plan>"}
- a brand-NEW widget/section that doesn't exist yet → {"kind":"widget_new","widget":"<short-new-kebab-case-key>","spec":"<one-paragraph plan: what it shows, where the data comes from>"}
- UNDO a previous widget change/creation ("remets comme avant", "supprime le widget…") → {"kind":"widget_revert","widget":"<existing key>"}
- anything else (layout/visibility — already handled —, content preferences, general feedback) → {"kind":"none"}
Output ONLY the JSON. Request: ${JSON.stringify(String(request).slice(0, 500))}`;
  try {
    const raw = await runClaude(prompt, { module: 'forge-triage', timeoutMs: 45000 });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const j = m && JSON.parse(m[0]);
    if (j && ['widget_change', 'widget_new', 'widget_revert'].includes(j.kind))
      return { kind: j.kind, widget: String(j.widget || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30),
        spec: String(j.spec || '').slice(0, 900) };
  } catch (e) {}
  return { kind: 'none' };
}
// pending/in-flight forge work for the strip under the suggestion box
app.get('/api/forge/status', asyncRoute(async (req, res) => {
  if (!CFG.widgetForge) return res.json({ items: [] });
  let q; try { q = await readTab(TODO_SHEET_ID, RPC_TAB, RPC_HEADERS); } catch (e) { return res.json({ items: [] }); }
  const items = [];
  for (const r0 of q.rows) {
    if (!['widget_spec', 'widget_forge'].includes(r0.Kind)) continue;
    let p; try { p = JSON.parse(r0.Payload || '{}'); } catch (e) { continue; }
    const done = String(r0.Done || '').trim(), err = String(r0.Error || '').trim();
    if (r0.Kind === 'widget_spec' && !done) items.push({ id: r0.ID, state: 'confirm', widget: p.widget, spec: p.spec || '' });
    else if (r0.Kind === 'widget_forge' && !done.startsWith('done')) items.push({ id: r0.ID, state: 'building', widget: p.widget });
    else if (r0.Kind === 'widget_forge' && err) items.push({ id: r0.ID, state: 'failed', widget: p.widget });
    else if (r0.Kind === 'widget_forge' && done && Date.parse(done.slice(5)) > Date.now() - 86400000)
      items.push({ id: r0.ID, state: 'live', widget: p.widget });
  }
  res.json({ items: items.slice(-8) });
}));
app.post('/api/forge/confirm', asyncRoute(async (req, res) => {
  if (!CFG.widgetForge) return res.status(400).json({ error: 'forge disabled' });
  const { id, ok } = req.body || {};
  let q; try { q = await readTab(TODO_SHEET_ID, RPC_TAB, RPC_HEADERS); } catch (e) { return res.status(502).json({ error: 'queue unreachable' }); }
  const row = q.rows.find(r => r.ID === id && r.Kind === 'widget_spec' && !String(r.Done || '').trim());
  if (!row) return res.status(404).json({ error: 'not found' });
  const cell = name => `'${RPC_TAB}'!${colLetter(q.headers.indexOf(name))}${row._row}`;
  if (ok) {
    let p = {}; try { p = JSON.parse(row.Payload || '{}'); } catch (e) {}
    await enqueueRpc('widget_forge', { ...p, mode: 'new' });
  }
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: cell('Done'), valueInputOption: 'RAW',
    requestBody: { values: [[(ok ? 'confirmed ' : 'cancelled ') + nowIso()]] } });
  res.json({ ok: true, queued: !!ok });
}));

app.post('/api/feedback', asyncRoute(async (req, res) => {
  const { kind, title, url, source, context, subjects, person, author } = req.body || {};
  if (!kind) return res.status(400).json({ error: 'kind required' });
  // guest-CI instance: a comment is a change request — apply it now, remember it as an idea
  if (kind === 'comment' && context && CFG.ciAutoApply) {
    const r = await ciTryApply(context);
    let forge = null;
    if (!r.applied && CFG.widgetForge) {
      const c = await forgeClassify(context);
      if (c.kind === 'widget_change' || c.kind === 'widget_revert') {
        const id = await enqueueRpc('widget_forge', { mode: c.kind === 'widget_revert' ? 'revert' : 'change',
          widget: c.widget, request: String(context).slice(0, 500), spec: c.spec || '' });
        forge = { id, state: 'queued', widget: c.widget, spec: c.spec || '' };
      } else if (c.kind === 'widget_new' && c.widget && c.spec) {
        const id = await enqueueRpc('widget_spec', { mode: 'new', widget: c.widget,
          request: String(context).slice(0, 500), spec: c.spec });
        forge = { id, state: 'confirm', widget: c.widget, spec: c.spec };
      }
    }
    await writeFeedbackEntry({ at: nowIso(), kind: 'idea', signal: 1, title: '', source: 'ci', url: '',
      subjects: [], person: '', author: '', context: String(context).slice(0, 500)
        + (r.applied ? ' [applied]' : forge ? ` [forge:${forge.state}:${forge.widget}]` : '') }).catch(() => {});
    return res.json({ ok: true, applied: !!r.applied, reason: r.reason || '', reload: !!r.applied, forge });
  }
  const entry = {
    at: nowIso(), kind, signal: SIGNAL_BY_KIND[kind] ?? 0,
    title: title || '', source: source || '', url: url || '',
    subjects: Array.isArray(subjects) ? subjects : [], person: person || '', author: author || '',
    context: context || '',
  };
  await writeFeedbackEntry(entry); // Mac: CI reads the JSONL directly; cloud: queued, Mac drains
  // a freeform CI comment also lands in the journal's ## CI Log so it's visible there
  if (HAS_JOURNAL && kind === 'comment' && context) appendToJournal(`- ${nowIso().slice(11, 16)} ${String(context).replace(/\n+/g, ' ')}`, { section: 'CI Log' });
  // swipe-left → also persist to the durable dismissal store so the story is
  // filtered out of every future render/rebuild (any instance). url OR title is enough.
  if (kind === 'not_interested' && (url || title)) {
    await appendTabRow(DISMISS_TAB, DISMISS_HEADERS, [url || '', title || '', nowIso()]).catch(() => {});
    dismissedCache.at = 0; // take effect immediately
  }
  // Activity-event swipes are durable too (David 2026-07-31: phone swipes were resurfacing
  // on the Mac): ANY resolving swipe — skip, down, or scheduled — permanently retires the
  // suggestion across tiers. Key = evt:<norm title>|<activity> in the URL column.
  if (['event_skipped', 'event_down', 'event_scheduled'].includes(kind) && title) {
    await appendTabRow(DISMISS_TAB, DISMISS_HEADERS, ['evt:' + normTitle(title) + '|' + (source || ''), title, nowIso()]).catch(() => {});
    dismissedCache.at = 0;
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
// ---------- Biotech clinical-trial tracker (CFG.bioRoute, default /bio) ----------
// One Sheet tab, same durable cross-tier story as the jobs board: the stateless Cloud Run
// tier and the Mac both read/write the same rows, so nothing depends on container disk.
// Column split that matters: TRIAL FACTS (Phase/TrialStatus/Enrollment/dates/NCTId) are
// machine-refreshed from clinicaltrials.gov and must never be hand-edited — the Tier-1 poll
// overwrites them. ANALYSIS fields (Outcomes/Competition/MarketSize/Background) are
// agent- or human-written estimates the poll never touches.
// The tracker can live on its OWN spreadsheet (CFG.bioSheetId) so the second reader gets
// direct spreadsheet access without seeing the owner's task hub. Empty config falls back to
// the main sheet — same pre-split pattern as STABLE_SHEET_ID. (The service account cannot
// create spreadsheets: the owner creates one, shares it with the SA, sets the id.)
const BIO_SHEET_ID = CFG.bioSheetId || TODO_SHEET_ID;
const BIO_TAB = 'Biotech Trials';
// NOTE (>20 columns, flagged 2026-07-30): this row is already wide. Per-field analysis
// provenance is therefore ONE json column, not four more columns per analysed field —
// {field: {tier, model, confidence, at}}. Anything else per-field goes in there too.
const BIO_HEADERS = [
  'Company', 'Ticker', 'Public', 'Drug', 'DrugType', 'Indication', 'Phase', 'TrialStatus',
  'NCTId', 'TrialTitle', 'Enrollment', 'PhaseHistory', 'NextMilestone', 'Outcomes',
  'Competition', 'MarketSize', 'Background', 'Sources', 'Notes', 'Status', 'Source',
  'Created', 'Updated', 'ID', 'Provenance', 'PriceTargets',
];
const BIO_HINT = ['Company', 'Drug', 'Phase', 'ID'];
const readBioTab = () => readTab(BIO_SHEET_ID, BIO_TAB, BIO_HINT);
// ensureTab only writes headers when it CREATES a tab, so a column added after the tab
// already exists is silently dropped on every write (Provenance was, for one run). Append
// any missing header to the live row — additive only, never reorders or removes.
const bioMigrated = new Set();
async function ensureColumns(tab, wanted, hint) {
  if (bioMigrated.has(tab)) return;
  const t = await readTab(BIO_SHEET_ID, tab, hint).catch(() => null);
  if (!t) return; // tab not created yet — ensureTab will write the full header row
  const missing = wanted.filter(h => !t.headers.includes(h));
  if (missing.length) {
    await store.values.update({
      spreadsheetId: BIO_SHEET_ID,
      range: `'${tab}'!${colLetter(t.headers.length)}${t.headerRow}`, // readTab's headerRow is already 1-based
      valueInputOption: 'RAW', requestBody: { values: [missing] },
    });
    console.log(`[bio] ${tab}: added missing columns ${missing.join(', ')}`);
  }
  bioMigrated.add(tab);
}
const ensureBioColumns = () => ensureColumns(BIO_TAB, BIO_HEADERS, BIO_HINT);
const ensureFeedbackColumns = () => ensureColumns(BIOFB_TAB, BIOFB_HEADERS, BIOFB_HINT);
const bioOut = r => ({
  id: r.ID, company: r.Company, ticker: r.Ticker || '', public: String(r.Public || '') === '1',
  drug: r.Drug, drugType: r.DrugType || '', indication: r.Indication || '',
  phase: r.Phase || '', trialStatus: r.TrialStatus || '', nctId: r.NCTId || '',
  trialTitle: r.TrialTitle || '', enrollment: Number(r.Enrollment) || 0,
  phaseHistory: r.PhaseHistory || '', nextMilestone: r.NextMilestone || '',
  outcomes: r.Outcomes || '', competition: r.Competition || '', marketSize: r.MarketSize || '',
  background: r.Background || '', notes: r.Notes || '',
  sources: String(r.Sources || '').split(/[\s,]+/).filter(s => /^https?:/.test(s)),
  status: r.Status || 'tracked', source: r.Source || '', created: r.Created || '', updated: r.Updated || '',
  // Per-firm analyst targets, e.g. "JPM $52 (2026-06-12); MS $38 (2026-05-30)". No free feed
  // publishes per-bank targets, so the Sonnet/Opus tiers research and cite them; the UI shows
  // them as analyst-sourced with a date, never as live data.
  // [{firm, rating, target, date, source}] — no free feed publishes per-bank targets, so the
  // research tiers scan for them and cite each one. Legacy plain text is passed through as a note.
  priceTargets: (() => {
    const raw = String(r.PriceTargets || '').trim();
    if (!raw) return [];
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (e) { return [{ firm: '', note: raw }]; }
  })(),
  // per-field {tier, model, confidence, at} — the UI badges each analysis cell with it
  provenance: (() => { try { return JSON.parse(r.Provenance || '{}'); } catch (e) { return {}; } })(),
});

// clinicaltrials.gov API v2 — free, keyless. One study → our flat shape.
const CTG_FIELDS = ['NCTId', 'BriefTitle', 'OverallStatus', 'Phase', 'LeadSponsorName',
  'Condition', 'StartDate', 'PrimaryCompletionDate', 'CompletionDate', 'LastUpdatePostDate',
  'InterventionName', 'EnrollmentCount'].join(',');
// CT.gov's phase vocabulary stops at Phase 3 — 'FDA Review'/'Approved'/'Preclinical' are
// ours and live only in the sheet, so the poll must never clobber a row sitting in one.
const BIO_PHASE_ORDER = ['Preclinical', 'Phase 1', 'Phase 1/2', 'Phase 2', 'Phase 2/3', 'Phase 3', 'FDA Review', 'Approved'];
const BEYOND_CTG = new Set(['FDA Review', 'Approved', 'Preclinical']);
function ctgPhase(phases) {
  const p = (phases || []).map(s => String(s).replace('PHASE', '')).filter(s => /^\d$/.test(s)).sort();
  if (!p.length) return '';
  if (p.length === 1) return 'Phase ' + p[0];
  return 'Phase ' + p[0] + '/' + p[p.length - 1];
}
function ctgFlat(study) {
  const ps = study.protocolSection || {};
  const id = ps.identificationModule || {}, st = ps.statusModule || {}, de = ps.designModule || {};
  const date = k => (st[k] || {}).date || '';
  return {
    nctId: id.nctId || '',
    trialTitle: id.briefTitle || '',
    trialStatus: st.overallStatus || '',
    phase: ctgPhase((de.phases || [])),
    sponsor: ((ps.sponsorCollaboratorsModule || {}).leadSponsor || {}).name || '',
    conditions: (ps.conditionsModule || {}).conditions || [],
    interventions: ((ps.armsInterventionsModule || {}).interventions || []).map(i => i.name).filter(Boolean),
    enrollment: ((de.enrollmentInfo || {}).count) || 0,
    startDate: date('startDateStruct'),
    primaryCompletion: date('primaryCompletionDateStruct'),
    completion: date('completionDateStruct'),
    lastUpdate: date('lastUpdatePostDateStruct'),
  };
}
async function ctgFetch(params) {
  const url = 'https://clinicaltrials.gov/api/v2/studies?' + new URLSearchParams({ fields: CTG_FIELDS, ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'dashboard-biotracker' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`clinicaltrials.gov ${r.status}`);
    return ((await r.json()).studies || []).map(ctgFlat);
  } finally { clearTimeout(timer); }
}

// Who is looking: the page hides owner-only affordances (the link back to the dashboard)
// for guests, who would only get bounced by the gate.
app.get('/api/bio/me', (req, res) => {
  const sess = verifySession(cookieOf(req, 'dash_session'));
  const email = normEmail((sess || {}).email);
  const gated = !!(OAUTH_ID && process.env.OAUTH_REDIRECT_BASE);
  res.json({ email, owner: !gated || email === ALLOWED_EMAIL_N, route: BIO_ROUTE });
});

app.get('/api/bio/trials', asyncRoute(async (req, res) => {
  await ensureBioColumns().catch(e => console.error('[bio] column migration:', e.message));
  let rows = [];
  try { rows = (await readBioTab()).rows; }
  catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; } // tab not created yet = empty tracker
  const all = String(req.query.all || '') === '1';
  const scope = String(req.query.scope || 'all'); // all (universe, the default) | tracked
  let trials = rows.map(bioOut).filter(t => all || t.status !== 'removed');
  if (!all && scope !== 'all') trials = trials.filter(t => t.status === 'tracked');
  const counts = rows.reduce((a2, r) => { const k = r.Status || 'tracked'; a2[k] = (a2[k] || 0) + 1; return a2; }, {});
  res.json({ trials, phases: BIO_PHASE_ORDER, counts, scope });
}));

// Search clinicaltrials.gov by company, drug or condition — powers the "add" box.
app.get('/api/bio/search', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const params = /^NCT\d{8}$/i.test(q) ? { 'query.id': q.toUpperCase() } : { 'query.term': q, sort: 'LastUpdatePostDate:desc' };
  const results = await ctgFetch({ ...params, pageSize: '20' });
  res.json({ results });
}));

app.post('/api/bio/trials', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.company || !b.drug) return res.status(400).json({ error: 'company and drug required' });
  let existing = [];
  try { existing = (await readBioTab()).rows; } catch (e) {}
  const norm = s => String(s || '').trim().toLowerCase();
  // dedup against removed rows too — a deliberately dropped program must not come back
  // on the next agent run
  const dup = existing.find(r => (b.nctId && norm(r.NCTId) === norm(b.nctId))
    || (norm(r.Company) === norm(b.company) && norm(r.Drug) === norm(b.drug)));
  if (dup) return res.json({ ok: true, deduped: true, id: dup.ID });
  const id = crypto.randomUUID();
  await appendTabRow(BIO_TAB, BIO_HEADERS, [
    b.company, b.ticker || '', b.public ? '1' : '', b.drug, b.drugType || '', b.indication || '',
    b.phase || '', b.trialStatus || '', b.nctId || '', b.trialTitle || '',
    b.enrollment ? String(b.enrollment) : '', b.phaseHistory || '', b.nextMilestone || '',
    b.outcomes || '', b.competition || '', b.marketSize || '', b.background || '',
    Array.isArray(b.sources) ? b.sources.join(' ') : String(b.sources || ''), b.notes || '',
    'tracked', b.source || WRITE_SOURCE, nowIso(), nowIso(), id, '', b.priceTargets || '',
  ], BIO_SHEET_ID);
  res.json({ ok: true, id });
}));

async function updateBioById(id, changes) {
  const { headers, rows } = await readBioTab();
  const row = rows.find(r => r.ID === id);
  if (!row) return null;
  changes.Updated = nowIso();
  const data = Object.entries(changes)
    .filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIO_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  return { ...row, ...changes };
}

const BIO_EDITABLE = new Set(['Company', 'Ticker', 'Public', 'Drug', 'DrugType', 'Indication',
  'Phase', 'NCTId', 'PhaseHistory', 'NextMilestone', 'Outcomes', 'Competition', 'MarketSize',
  'Background', 'Sources', 'Notes', 'Status', 'Provenance', 'PriceTargets']);
// A human editing an analysis field supersedes whatever tier wrote it — drop that field's
// provenance so the UI stops attributing the reader's own text to a model.
async function bioClearProvenance(row, changedFields) {
  const analysis = changedFields.filter(f => BIO_ANALYSIS_FIELDS.includes(f));
  if (!analysis.length) return null;
  let prov = {};
  try { prov = JSON.parse(row.Provenance || '{}'); } catch (e) {}
  let touched = false;
  for (const f of analysis) if (prov[f]) { delete prov[f]; touched = true; }
  return touched ? JSON.stringify(prov) : null;
}
const BIO_ANALYSIS_FIELDS = ['Outcomes', 'Competition', 'MarketSize', 'Background', 'NextMilestone', 'PriceTargets'];
app.patch('/api/bio/trials/:id', asyncRoute(async (req, res) => {
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    const col = k.charAt(0).toUpperCase() + k.slice(1);
    const name = col === 'NctId' ? 'NCTId' : col;
    if (BIO_EDITABLE.has(name)) changes[name] = Array.isArray(v) ? v.join(' ') : String(v);
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'no editable fields' });
  if (changes.Provenance === undefined) {
    const { rows } = await readBioTab().catch(() => ({ rows: [] }));
    const cur = rows.find(r => r.ID === req.params.id);
    const prov = cur && await bioClearProvenance(cur, Object.keys(changes));
    if (prov !== null && prov !== undefined) changes.Provenance = prov;
  }
  const row = await updateBioById(req.params.id, changes);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));
// Soft-delete only (Sheet protocol: never delete rows).
app.post('/api/bio/trials/:id/remove', asyncRoute(async (req, res) => {
  const row = await updateBioById(req.params.id, { Status: 'removed' });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

// Tier 1 of the refresh pipeline: pure clinicaltrials.gov polling, no LLM, ~$0/run.
// Rewrites only the machine-owned trial-fact columns, and only when they actually changed,
// so the response doubles as the day's change feed (what Tier 3 would be triggered on).
app.post('/api/bio/refresh', asyncRoute(async (req, res) => {
  let rows = [];
  try { rows = (await readBioTab()).rows; } catch (e) { return res.json({ checked: 0, changes: [] }); }
  const live = rows.filter(r => r.Status !== 'removed' && /^NCT\d{8}$/i.test(String(r.NCTId || '').trim()));
  const changes = [];
  for (const r of live) {
    let s;
    try { s = (await ctgFetch({ 'query.id': String(r.NCTId).trim().toUpperCase(), pageSize: '1' }))[0]; }
    catch (e) { changes.push({ id: r.ID, nctId: r.NCTId, error: e.message }); continue; }
    if (!s) continue;
    const upd = {}, diff = [];
    const set = (col, val) => { if (val && String(val) !== String(r[col] || '')) { upd[col] = String(val); diff.push(`${col}: ${r[col] || '—'} → ${val}`); } };
    set('TrialStatus', s.trialStatus);
    set('TrialTitle', s.trialTitle);
    set('Enrollment', s.enrollment || '');
    // never demote a row the sheet has already moved past CT.gov's vocabulary
    if (!BEYOND_CTG.has(String(r.Phase || '').trim())) set('Phase', s.phase);
    // dated milestones accumulate in PhaseHistory rather than overwriting the analyst's text
    const stamp = [s.startDate && `start ${s.startDate}`, s.primaryCompletion && `primary completion ${s.primaryCompletion}`]
      .filter(Boolean).join('; ');
    if (stamp && !String(r.PhaseHistory || '').includes(s.startDate || '\x00')) {
      upd.PhaseHistory = [String(r.PhaseHistory || '').trim(), `[${s.nctId}] ${stamp}`].filter(Boolean).join(' | ');
    }
    if (Object.keys(upd).length) {
      await updateBioById(r.ID, upd);
      if (diff.length) changes.push({ id: r.ID, company: r.Company, drug: r.Drug, nctId: s.nctId, diff });
    }
  }
  track('biotech-refresh', true, `${live.length} trials, ${changes.length} changed`);
  res.json({ checked: live.length, changes });
}));

app.get('/api/bio/trials.csv', asyncRoute(async (req, res) => {
  let rows = [];
  try { rows = (await readBioTab()).rows; } catch (e) {}
  const cell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const body = [BIO_HEADERS.join(',')]
    .concat(rows.filter(r => r.Status !== 'removed').map(r => BIO_HEADERS.map(h => cell(r[h])).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="biotech-tracker-${today()}.csv"`);
  res.send(body);
}));

// ---------- design-input loop ----------
// The tracker is co-designed with its reader, so feedback is a first-class object, not a
// mailto: link. Anyone with access types here; a CI-style agent (bin/bio-ci.sh) reads the
// open rows, proposes a change per item, and writes the proposal back onto the same row.
// Nothing is auto-applied — a proposal is a suggestion the humans accept or reject.
const BIOFB_TAB = 'Bio Feedback';
const BIOFB_HEADERS = ['At', 'Author', 'Kind', 'Text', 'Status', 'Proposal', 'ProposedAt', 'Resolution', 'ID', 'Thread'];
const BIOFB_HINT = ['At', 'Text', 'Status', 'ID'];
const bioFbOut = r => ({
  id: r.ID, at: r.At, author: r.Author || '', kind: r.Kind || 'idea', text: r.Text || '',
  status: r.Status || 'open', proposal: r.Proposal || '', proposedAt: r.ProposedAt || '',
  resolution: r.Resolution || '',
  // [{role:'agent'|'reader', text, at}] — the iteration on this one request
  thread: (() => { try { const p = JSON.parse(r.Thread || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; } })(),
});
app.get('/api/bio/feedback', asyncRoute(async (req, res) => {
  await ensureFeedbackColumns().catch(e => console.error('[bio] feedback migration:', e.message));
  let rows = [];
  try { rows = (await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT)).rows; }
  catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; }
  const all = String(req.query.all || '') === '1';
  res.json({ feedback: rows.map(bioFbOut).filter(f => all || f.status !== 'closed').reverse() });
}));
app.post('/api/bio/feedback', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const sess = verifySession(cookieOf(req, 'dash_session'));
  // author comes from the signed session, never from the request body — a feedback row
  // must not be attributable to someone who did not write it
  const author = String((sess || {}).email || 'local').toLowerCase();
  const kind = ['idea', 'bug', 'question', 'data'].includes(b.kind) ? b.kind : 'idea';
  // one guest cannot spend the owner's subscription in a loop
  const now = Date.now();
  const hits = (bioProposeRate.get(author) || []).filter(t => now - t < 3600000);
  const mayPropose = hits.length < BIO_LIMIT_PROPOSE_HOUR;
  if (mayPropose) { hits.push(now); bioProposeRate.set(author, hits); }
  const id = crypto.randomUUID();
  await appendTabRow(BIOFB_TAB, BIOFB_HEADERS,
    [nowIso(), author, kind, text.slice(0, 2000), 'open', '', '', '', id, '[]'], BIO_SHEET_ID);
  res.json({ ok: true, id });
  // Answer it in the background on the free transport. A guest's message therefore reaches a
  // model on the OWNER's subscription — deliberate, but bounded: one Sonnet call per item,
  // rate-limited per author, and the reply is a PROPOSAL written back to the row. It never
  // edits code, never escalates to Opus on its own, and on a host with no CLI it simply does
  // not run (the VM's daily bio-ci timer picks the item up instead).
  await bioAudit(author, 'feedback', `[${kind}] ${text}`, mayPropose ? 'accepted' : 'rate-limited', id);
  if (mayPropose) bioRespondTo({ id, kind, text, author }).catch(e => console.error('[bio] respond:', e.message));
}));
// ---------- audit: every reader input, every action taken on it ----------
// A guest can trigger an agent that edits source, so "what did they ask for and what did the
// machine then do" has to be a durable record, not a log line on one host. One append-only tab.
const BIOAUD_TAB = 'Bio Audit';
const BIOAUD_HEADERS = ['At', 'Author', 'Event', 'Detail', 'Outcome', 'Ref'];
async function bioAudit(author, event, detail, outcome, ref) {
  await appendTabRow(BIOAUD_TAB, BIOAUD_HEADERS,
    [nowIso(), author || '', event, String(detail || '').slice(0, 900), outcome || '', ref || ''], BIO_SHEET_ID)
    .catch(e => console.error('[bio] audit:', e.message));
}
// bin/bio-apply.sh reports its own outcome here; author comes from the session when a human
// is driving, and is blank for the local agent.
app.post('/api/bio/audit', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const sess = verifySession(cookieOf(req, 'dash_session'));
  await bioAudit(normEmail((sess || {}).email) || 'agent', String(b.event || 'note').slice(0, 40),
    b.detail, b.outcome, b.ref);
  res.json({ ok: true });
}));
app.get('/api/bio/audit', asyncRoute(async (req, res) => {
  let rows = [];
  try { rows = (await readTab(BIO_SHEET_ID, BIOAUD_TAB, ['At', 'Event'])).rows; }
  catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; }
  res.json({
    audit: rows.map(r => ({ at: r.At, author: r.Author, event: r.Event, detail: r.Detail, outcome: r.Outcome, ref: r.Ref }))
      .reverse().slice(0, Number(req.query.limit) || 100),
    limits: { proposalsPerHour: BIO_LIMIT_PROPOSE_HOUR, appliesPerDay: BIO_LIMIT_APPLY_DAY },
  });
}));
// Ring fence, stated in one place so it can be checked rather than assumed:
//  · a guest reaches the tracker route and /api/bio/* only (the gate enforces this)
//  · a reader-triggered agent may write exactly one file, public/bio.html, and it runs with
//    Read/Edit tools only — no shell, no network (bin/bio-apply.sh)
//  · rate limits below bound how often either path can fire
const BIO_LIMIT_PROPOSE_HOUR = 6;
const BIO_LIMIT_APPLY_DAY = CFG.bioApplyPerDay;
const bioApplyRate = new Map(); // author → [timestamps]
const bioProposeRate = new Map(); // author → [timestamps]
async function bioSetFields(id, changes) {
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === id);
  if (!row) return null;
  const data = Object.entries(changes).filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIOFB_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  return row;
}
// Two ways to answer a reader: PROPOSE (write a plan onto the row) or APPLY (an Opus run that
// actually edits the page and deploys it). Apply is the owner's explicit choice via
// bioAutoApply, because it turns a guest's sentence into a source change — bin/bio-apply.sh
// carries the rails that make that safe to mean.
async function bioRespondTo(item) {
  const apply = String(CFG.bioAutoApply) === '1' || CFG.bioAutoApply === true || String(CFG.bioAutoApply) === 'true';
  if (!apply) return bioProposeFor(item);
  const script = path.join(__dirname, 'bin', 'bio-apply.sh');
  if (!fs.existsSync(script)) return bioProposeFor(item); // e.g. the stateless tier
  // an APPLY edits source and deploys, so it is capped far tighter than a proposal
  const now = Date.now();
  const hits = (bioApplyRate.get(item.author) || []).filter(t => now - t < 86400000);
  if (hits.length >= BIO_LIMIT_APPLY_DAY) {
    await bioAudit(item.author, 'apply', item.text, `refused — ${BIO_LIMIT_APPLY_DAY}/day cap reached`, item.id);
    return bioProposeFor(item); // still answer them, just without touching code
  }
  hits.push(now); bioApplyRate.set(item.author, hits);
  await bioAudit(item.author, 'apply', item.text, 'dispatched to bin/bio-apply.sh', item.id);
  // detached: an Opus edit plus a Cloud Run build outlives any request, and every result is
  // written back onto the feedback row rather than returned to a listener
  const child = require('child_process').spawn('/bin/bash', [script, item.id], {
    cwd: __dirname, detached: true, stdio: 'ignore',
    env: { ...process.env, BIO_API: `http://localhost:${PORT}` },
  });
  child.unref();
  console.log(`[bio] layout change requested (${item.id}) — bio-apply.sh running detached`);
  return Promise.resolve();
}
async function bioProposeFor(item) {
  const { id, kind, text } = item;
  const { callModel } = require('./bio-pipeline');
  const prompt = `You are the design-input agent for a biotech clinical-trial tracker. A reader filed this ${kind}:

"${text.slice(0, 1200)}"

Reply with ONE concrete proposal of 2-5 sentences: what specifically to change, roughly how much work it is, what it would break or slow down, and — if the request is vague — the single question that would settle it. If the thing is already possible today, say exactly how to do it instead of proposing new work. If it conflicts with a guardrail (sending mail, moving money, auto-applying changes, publishing data), say so plainly and offer the nearest safe alternative.

You are proposing, not deciding: a human accepts or rejects this. Return the proposal as plain prose, no preamble, no JSON.`;
  let out;
  try { out = await callModel('sonnet', prompt); }
  catch (e) {
    // No CLI on this tier (Cloud Run). Mark it queued so the drain on a capable host picks
    // it up, and record it — a silent return is how a reader's request vanishes.
    console.warn('[bio] no free transport here — queued for a host with the CLI:', e.message.slice(0, 120));
    await bioSetFields(id, { Status: 'queued', Resolution: 'queued — waiting for a host that can run the agent' }).catch(() => {});
    await bioAudit(item && item.author, 'queued', text, 'no LLM transport on this tier', id);
    return;
  }
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === id);
  if (!row) return;
  const data = [['Proposal', String(out.text || '').trim().slice(0, 3000)], ['ProposedAt', nowIso()]]
    .filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIOFB_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  await bioAudit(row.Author, 'proposal', text, `written by ${out.model || 'model'}`, id);
}

app.patch('/api/bio/feedback/:id', asyncRoute(async (req, res) => {
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const changes = {};
  for (const f of ['Status', 'Proposal', 'ProposedAt', 'Resolution', 'Thread']) {
    const k = f.charAt(0).toLowerCase() + f.slice(1);
    if (req.body && req.body[k] !== undefined) changes[f] = String(req.body[k]);
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'no editable fields' });
  const data = Object.entries(changes).filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIOFB_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  // closing or resolving an item is an action on a reader's input — it belongs in the record
  await bioAudit(normEmail((verifySession(cookieOf(req, 'dash_session')) || {}).email) || 'agent',
    'feedback-update', `${row.Kind || ''} ${row.Text || ''}`,
    Object.entries(changes).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(' · '), req.params.id);
  res.json({ ok: true });
}));

// The agent asking the reader something, rather than guessing. Appends to the thread.
app.post('/api/bio/feedback/:id/ask', asyncRoute(async (req, res) => {
  const question = String((req.body || {}).question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  await ensureFeedbackColumns().catch(() => {});
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  let thread = [];
  try { thread = JSON.parse(row.Thread || '[]'); } catch (e) {}
  thread.push({ role: 'agent', text: question.slice(0, 1000), at: nowIso() });
  const data = [['Thread', JSON.stringify(thread.slice(-20))]]
    .filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIOFB_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  await bioAudit('agent', 'question', question, 'waiting on the reader', req.params.id);
  res.json({ ok: true });
}));

app.post('/api/bio/feedback/:id/claim', asyncRoute(async (req, res) => {
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!['open', 'queued'].includes(row.Status || 'open')) return res.json({ claimed: false, status: row.Status });
  const host = String((req.body || {}).host || 'unknown').slice(0, 40);
  const i = headers.indexOf('Status');
  if (i === -1) return res.json({ claimed: true }); // no Status column: nothing to race on
  await store.values.update({
    spreadsheetId: BIO_SHEET_ID, range: `'${BIOFB_TAB}'!${colLetter(i)}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [['running']] },
  });
  await bioAudit('agent', 'claim', row.Text || '', `claimed by ${host}`, req.params.id);
  res.json({ claimed: true });
}));

// A reader answering the agent's question. Appends to the thread and re-runs the agent with
// the whole exchange, so an ambiguous request converges instead of being guessed at.
app.post('/api/bio/feedback/:id/reply', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  await ensureFeedbackColumns().catch(() => {});
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOFB_TAB, BIOFB_HINT);
  const row = rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const sess = verifySession(cookieOf(req, 'dash_session'));
  const author = normEmail((sess || {}).email) || 'local';
  let thread = [];
  try { thread = JSON.parse(row.Thread || '[]'); } catch (e) {}
  thread.push({ role: 'reader', text: text.slice(0, 2000), at: nowIso() });
  const data = [['Thread', JSON.stringify(thread.slice(-20))], ['Status', 'open']]
    .filter(([f]) => headers.indexOf(f) !== -1)
    .map(([f, v]) => ({ range: `'${BIOFB_TAB}'!${colLetter(headers.indexOf(f))}${row._row}`, values: [[v]] }));
  if (data.length) await store.values.batchUpdate({ spreadsheetId: BIO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  await bioAudit(author, 'reply', text, 'answered the agent — re-dispatching', req.params.id);
  res.json({ ok: true });
  bioRespondTo({ id: req.params.id, kind: row.Kind || 'idea', text: row.Text || '', author })
    .catch(e => console.error('[bio] re-dispatch:', e.message));
}));

// ---------- analysis pipeline: log + triggers ----------
// Every tier's verdict is logged with its confidence and why it escalated (or didn't).
// That log IS the calibration dataset: once humans start marking analyses right or wrong
// (HumanAgreed), the 0.80 threshold can be tuned against evidence instead of taste.
const BIOLOG_TAB = 'Bio Analysis Log';
const BIOLOG_HEADERS = ['At', 'RunId', 'Tier', 'Model', 'TrialId', 'NCTId', 'Company', 'Drug',
  'Confidence', 'Escalated', 'EscalateReason', 'RuleFired', 'CircuitBreaker', 'HumanAgreed', 'Cost', 'ID'];
const BIOLOG_HINT = ['At', 'Tier', 'Confidence', 'ID'];
app.get('/api/bio/analysis-log', asyncRoute(async (req, res) => {
  let rows = [];
  try { rows = (await readTab(BIO_SHEET_ID, BIOLOG_TAB, BIOLOG_HINT)).rows; }
  catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; }
  const out = rows.map(r => ({
    id: r.ID, at: r.At, runId: r.RunId, tier: r.Tier, model: r.Model, trialId: r.TrialId,
    nctId: r.NCTId, company: r.Company, drug: r.Drug, confidence: Number(r.Confidence) || 0,
    escalated: String(r.Escalated) === '1', escalateReason: r.EscalateReason || '',
    ruleFired: r.RuleFired || '', circuitBreaker: String(r.CircuitBreaker) === '1',
    humanAgreed: r.HumanAgreed || '', cost: Number(r.Cost) || 0,
  })).reverse();
  // calibration summary: what the threshold is actually doing, so drift is visible
  const scored = out.filter(r => r.confidence > 0);
  const judged = out.filter(r => r.humanAgreed === 'yes' || r.humanAgreed === 'no');
  res.json({
    log: out.slice(0, Number(req.query.limit) || 200),
    calibration: {
      threshold: CFG.bioConfidenceThreshold, breakerAt: CFG.bioEscalationCircuitBreaker,
      n: scored.length,
      meanConfidence: scored.length ? +(scored.reduce((a, r) => a + r.confidence, 0) / scored.length).toFixed(3) : null,
      escalationRate: out.length ? +(out.filter(r => r.escalated).length / out.length).toFixed(3) : null,
      judged: judged.length,
      agreedRate: judged.length ? +(judged.filter(r => r.humanAgreed === 'yes').length / judged.length).toFixed(3) : null,
    },
  });
}));
// Human verdict on one analysis — the label that makes the confidence log trainable.
app.post('/api/bio/analysis-log/:id/judge', asyncRoute(async (req, res) => {
  const verdict = String((req.body || {}).agreed || '').toLowerCase();
  if (!['yes', 'no'].includes(verdict)) return res.status(400).json({ error: 'agreed must be yes or no' });
  const { headers, rows } = await readTab(BIO_SHEET_ID, BIOLOG_TAB, BIOLOG_HINT);
  const row = rows.find(r => r.ID === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  await store.values.update({
    spreadsheetId: BIO_SHEET_ID,
    range: `'${BIOLOG_TAB}'!${colLetter(headers.indexOf('HumanAgreed'))}${row._row}`,
    valueInputOption: 'RAW', requestBody: { values: [[verdict]] },
  });
  res.json({ ok: true });
}));

// Manual pipeline trigger (the UI's "run now" for the Opus review). Scheduled runs go
// through Cloud Scheduler → a Cloud Run Job executing the same module; this path exists so
// a human can force a run from the page, on any tier, on any host.
const bioRuns = new Map(); // runId → {tier, startedAt, done, error, summary}
app.post('/api/bio/pipeline/run', asyncRoute(async (req, res) => {
  const tier = String((req.body || {}).tier || 'daily');
  if (!['daily', 'weekly', 'monthly'].includes(tier)) return res.status(400).json({ error: 'tier must be daily, weekly or monthly' });
  const active = [...bioRuns.values()].find(r => !r.done);
  if (active) return res.status(409).json({ error: `a ${active.tier} run is already in progress`, runId: active.runId });
  const pipeline = require('./bio-pipeline');
  const runId = crypto.randomUUID().slice(0, 8);
  const rec = { runId, tier, startedAt: nowIso(), done: false, error: '', summary: null };
  bioRuns.set(runId, rec);
  // fire and forget: a monthly Opus pass outlives any sane request timeout, and every
  // result is durable on the Sheet regardless of who is still listening
  pipeline.run({ tier, runId, deps: bioPipelineDeps() })
    .then(s => { rec.summary = s; rec.done = true; })
    .catch(e => { rec.error = e.message; rec.done = true; console.error('bio pipeline:', e); });
  res.json({ ok: true, runId, tier });
}));
app.get('/api/bio/pipeline/run/:id', (req, res) => {
  const rec = bioRuns.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'unknown run' });
  res.json(rec);
});

// Everything the pipeline needs from the server, injected — so the same module runs
// in-process here and standalone in a Cloud Run Job without importing this file.
function bioPipelineDeps() {
  return {
    sheetId: BIO_SHEET_ID, tab: BIO_TAB, headers: BIO_HEADERS, hint: BIO_HINT,
    logTab: BIOLOG_TAB, logHeaders: BIOLOG_HEADERS,
    analysisFields: BIO_ANALYSIS_FIELDS,
    confidenceThreshold: CFG.bioConfidenceThreshold,
    breakerRatio: CFG.bioEscalationCircuitBreaker,
    readTrials: async () => {
      await ensureBioColumns().catch(e => console.error('[bio] column migration:', e.message));
      // The whole universe is analysed; bio-pipeline's per-row ceiling reserves Opus for
      // starred rows, so hundreds of screened rows cost Sonnet time and nothing more.
      try { return (await readBioTab()).rows.filter(r => r.Status !== 'removed'); } catch (e) { return []; }
    },
    updateTrial: updateBioById,
    appendLog: rows => appendTabRows(BIOLOG_TAB, BIOLOG_HEADERS, rows, BIO_SHEET_ID),
    ctgFetch, nowIso,
  };
}

// ---------- bulk screening import ----------
// The tracker has two populations, and conflating them is what makes a screener either
// useless or ruinous:
//   Status=screened — the imported universe (hundreds). Registry facts only. No LLM ever
//                     touches these, so the universe is free to be large.
//   Status=tracked  — the watchlist. The analyst tiers run on these, so it stays small.
// A screened row is promoted to tracked with one click; the pipeline reads only `tracked`.
async function ctgPage(params, pageToken) {
  const url = 'https://clinicaltrials.gov/api/v2/studies?' + new URLSearchParams({
    fields: CTG_FIELDS, pageSize: '200', ...(pageToken ? { pageToken } : {}), ...params,
  });
  const r = await fetch(url, { headers: { 'User-Agent': 'dashboard-biotracker' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`clinicaltrials.gov ${r.status}`);
  const j = await r.json();
  return { studies: (j.studies || []).map(ctgFlat), nextPageToken: j.nextPageToken };
}
app.post('/api/bio/import', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const max = Math.min(Number(b.max) || 300, 1000);
  // Default screen: industry-sponsored interventional trials still in flight at Phase 2/3 —
  // i.e. the population where a phase transition is actually a tradeable event.
  const params = {
    'query.term': String(b.query || '').trim() || undefined,
    'filter.overallStatus': (b.status || ['RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION']).join(','),
    'filter.advanced': b.advanced || 'AREA[LeadSponsorClass]INDUSTRY',
    aggFilters: b.aggFilters || 'phase:2 3,studyType:int',
    sort: 'LastUpdatePostDate:desc',
  };
  Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

  let existing = [];
  try { existing = (await readBioTab()).rows; } catch (e) {}
  const known = new Set(existing.map(r => String(r.NCTId || '').trim().toUpperCase()).filter(Boolean));

  const fresh = [];
  let token = null;
  do {
    const page = await ctgPage(params, token);
    for (const s of page.studies) {
      const id = (s.nctId || '').toUpperCase();
      if (!id || known.has(id)) continue;
      known.add(id);
      const drug = (s.interventions || []).find(n => !/placebo|saline|vehicle/i.test(n)) || (s.interventions || [])[0] || '';
      fresh.push([
        s.sponsor || '', '', '', drug, '', (s.conditions || [])[0] || '', s.phase || '', s.trialStatus || '',
        s.nctId, s.trialTitle || '', s.enrollment ? String(s.enrollment) : '', '', '', '', '', '', '', '', '',
        'screened', 'import', nowIso(), nowIso(), crypto.randomUUID(), '', '',
      ]);
      if (fresh.length >= max) break;
    }
    token = page.nextPageToken;
  } while (token && fresh.length < max);

  // One batched append, not one call per row — a few hundred single appends would blow the
  // Sheets write quota and take minutes.
  if (fresh.length) await appendTabRows(BIO_TAB, BIO_HEADERS, fresh, BIO_SHEET_ID);
  track('bio-import', true, `${fresh.length} new of ${known.size} known`);
  res.json({ ok: true, imported: fresh.length, universe: known.size });
}));

// Promote a screened row into the analysed watchlist (or send it back).
app.post('/api/bio/trials/:id/watch', asyncRoute(async (req, res) => {
  const on = (req.body || {}).watch !== false;
  const row = await updateBioById(req.params.id, { Status: on ? 'tracked' : 'screened' });
  if (!row) return res.status(404).json({ error: 'not found' });
  await bioAudit(normEmail((verifySession(cookieOf(req, 'dash_session')) || {}).email), 'watch',
    `${row.Company} / ${row.Drug}`, on ? 'tracked' : 'screened', req.params.id);
  bioQuoteCacheBust();
  res.json({ ok: true, status: on ? 'tracked' : 'screened' });
}));

// ---------- workspace settings: the ⚙ module registry, same shape as the main dashboard ----------
// {sections:{key:{order,hidden,title}}} in one cell of the tracker's own sheet, so the second
// reader configures their modules without touching the owner's dashboard settings.
const BIOSET_CELL = "'Bio Settings'!A1";
async function readBioSettings() {
  try {
    const r = await store.values.get({ spreadsheetId: BIO_SHEET_ID, range: BIOSET_CELL });
    return JSON.parse((((r.data.values || [])[0] || [])[0]) || '{}');
  } catch (e) { return {}; }
}
app.get('/api/bio/settings', asyncRoute(async (req, res) => res.json({ settings: await readBioSettings() })));
app.post('/api/bio/settings', asyncRoute(async (req, res) => {
  const cur = await readBioSettings();
  const next = { ...cur, ...(req.body || {}).settings };
  await ensureTab('Bio Settings', ['settings'], BIO_SHEET_ID);
  await store.values.update({
    spreadsheetId: BIO_SHEET_ID, range: BIOSET_CELL,
    valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(next)]] },
  });
  res.json({ ok: true, settings: next });
}));

// ---------- biotech news config: the tracker's own SUBJECTS / SOURCES ----------
// Same prompt-row + header-row + data-rows shape as the main prefs sheet, but on the
// tracker's sheet and seeded with biotech defaults, so tuning this reader's feed never
// edits the owner's news.
const BIOPREF_TABS = { SUBJECTS: 'Subject', SOURCES: 'Source' };
const BIOPREF_SEED = {
  SUBJECTS: ['clinical trial results', 'FDA approval', 'FDA advisory committee', 'phase 3 readout',
    'biotech M&A', 'drug pricing', 'gene therapy', 'obesity drugs', 'oncology pipeline', 'PDUFA date'],
  SOURCES: ['Endpoints News', 'STAT News', 'FierceBiotech', 'BioSpace', 'Nature Biotechnology',
    'Evaluate Vantage', 'BioPharma Dive'],
};
async function readBioPrefs() {
  const out = {};
  for (const [tab, header] of Object.entries(BIOPREF_TABS)) {
    let rows = [];
    try {
      const r = await store.values.get({ spreadsheetId: BIO_SHEET_ID, range: `'${tab}'!A1:A` });
      rows = (r.data.values || []).slice(2).map(v => String(v[0] || '').trim()).filter(Boolean);
    } catch (e) {}
    if (!rows.length) rows = BIOPREF_SEED[tab]; // first read shows the biotech defaults
    out[tab] = rows;
  }
  return out;
}
app.get('/api/bio/prefs', asyncRoute(async (req, res) => res.json(await readBioPrefs())));
app.post('/api/bio/prefs', asyncRoute(async (req, res) => {
  const tab = String((req.body || {}).tab || '').toUpperCase();
  if (!BIOPREF_TABS[tab]) return res.status(400).json({ error: 'tab must be SUBJECTS or SOURCES' });
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : String(req.body.lines || '').split('\n'))
    .map(l => String(l).trim()).filter(Boolean).slice(0, 100);
  await ensureTab(tab, [`${tab} — one per line`], BIO_SHEET_ID);
  await store.values.clear({ spreadsheetId: BIO_SHEET_ID, range: `'${tab}'!A1:A` }).catch(() => {});
  await store.values.update({
    spreadsheetId: BIO_SHEET_ID, range: `'${tab}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [[`${tab} — one per line`], [BIOPREF_TABS[tab]], ...lines.map(l => [l])] },
  });
  bioNewsCache = { at: 0, items: [] }; // config changed → next read rebuilds
  res.json({ ok: true, count: lines.length });
}));

// ---------- quotes: one mini-tracker per tracked ticker ----------
// Same keyless Yahoo chart endpoint the Markets module uses, same {price, changePct, spark}
// primitive. A ticker that cannot be priced returns an error field — never a fake zero.
const bioQuoteCache = {}; // range → {at, data}
const bioQuoteCacheBust = () => Object.keys(bioQuoteCache).forEach(k => delete bioQuoteCache[k]);
const BIO_RANGES = { '1mo': '1d', '3mo': '1d', '6mo': '1d' };
async function bioQuote(sym, range) {
  try {
    const iv = BIO_RANGES[range] || '1d';
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${iv}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const result = (((await r.json()).chart || {}).result || [])[0];
    if (!result) throw new Error('empty result');
    const meta = result.meta || {};
    const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
    const clean = closes.filter(v => typeof v === 'number' && isFinite(v));
    const price = meta.regularMarketPrice ?? clean[clean.length - 1] ?? null;
    const prev = meta.chartPreviousClose ?? (clean.length > 1 ? clean[clean.length - 2] : null);
    const weekAgo = clean.length > 5 ? clean[clean.length - 6] : clean[0];
    return {
      symbol: sym, price, currency: meta.currency || 'USD',
      changePct: prev ? ((price - prev) / prev) * 100 : null,
      weekPct: weekAgo ? ((price - weekAgo) / weekAgo) * 100 : null,
      spark: clean.slice(-90),
    };
  } catch (e) { return { symbol: sym, error: e.message }; }
}
app.get('/api/bio/quotes', asyncRoute(async (req, res) => {
  const range = BIO_RANGES[String(req.query.range || '')] ? String(req.query.range) : '3mo'; // 3mo default
  const hit = bioQuoteCache[range];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json(hit.data);
  let rows = [];
  try { rows = (await readBioTab()).rows; } catch (e) {}
  const seen = new Set();
  const live = rows.filter(r => r.Status !== 'removed')
    .sort((x, y) => (y.Status === 'tracked') - (x.Status === 'tracked')); // watchlist tickers first
  const BIO_QUOTE_CAP = 30;
  const tickers = live.map(r => String(r.Ticker || '').trim().toUpperCase())
    .filter(t => t && !seen.has(t) && seen.add(t)).slice(0, BIO_QUOTE_CAP);
  const nameOf = t => (live.find(r => String(r.Ticker || '').trim().toUpperCase() === t) || {}).Company || '';
  const quotes = [];
  for (const t of tickers) quotes.push({ ...(await bioQuote(t, range)), company: nameOf(t) }); // small list; serial keeps Yahoo happy
  const data = { at: nowIso(), range, quotes };
  bioQuoteCache[range] = { at: Date.now(), data };
  track('bio-quotes', quotes.some(q => !q.error), `${quotes.filter(q => !q.error).length}/${quotes.length}`);
  res.json(data);
}));

// ---------- news curation: swipe feedback + LLM summaries ----------
// Dismissals are durable on the tracker's own sheet so a story swiped away on the phone
// stays gone everywhere. Every gesture also emits a CI feedback signal (bio_* kinds) so the
// feed learns this reader's taste, exactly like the main dashboard's news.
const BIODIS_TAB = 'Bio Dismissed';
const BIODIS_HEADERS = ['URL', 'Title', 'Kind', 'At'];
let bioDismissCache = { at: 0, urls: new Set() };
async function bioDismissed() {
  if (Date.now() - bioDismissCache.at < 60000) return bioDismissCache.urls;
  const urls = new Set();
  try {
    const r = await store.values.get({ spreadsheetId: BIO_SHEET_ID, range: `'${BIODIS_TAB}'!A2:A` });
    (r.data.values || []).forEach(v => v[0] && urls.add(String(v[0]).trim()));
  } catch (e) {}
  bioDismissCache = { at: Date.now(), urls };
  return urls;
}
const BIO_SIGNAL = { bio_not_interested: -2, bio_agent_read: 1, bio_pinned: 2, bio_clicked: 1 };
app.post('/api/bio/news/feedback', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const kind = BIO_SIGNAL[b.kind] !== undefined ? b.kind : 'bio_not_interested';
  const sess = verifySession(cookieOf(req, 'dash_session'));
  await writeFeedbackEntry({
    at: nowIso(), kind, signal: BIO_SIGNAL[kind], title: b.title || '', url: b.url || '',
    source: 'biotech-tracker', subjects: Array.isArray(b.subjects) ? b.subjects : [],
    author: normEmail((sess || {}).email), context: b.context || '',
  }).catch(e => console.error('bio feedback:', e.message));
  if (kind === 'bio_not_interested' && (b.url || b.title)) {
    await appendTabRow(BIODIS_TAB, BIODIS_HEADERS, [b.url || '', b.title || '', kind, nowIso()], BIO_SHEET_ID).catch(() => {});
    bioDismissCache.at = 0;
  }
  res.json({ ok: true });
}));

// Summaries: the reader swipes right, an LLM reads the story and writes a short brief.
// Uses the pipeline's free-first transport, so with no CLI it refuses rather than billing.
const BIOSUM_TAB = 'Bio Summaries';
const BIOSUM_HEADERS = ['At', 'Title', 'URL', 'Summary', 'Model', 'ID'];
app.get('/api/bio/summaries', asyncRoute(async (req, res) => {
  let rows = [];
  try { rows = (await readTab(BIO_SHEET_ID, BIOSUM_TAB, ['At', 'Title', 'ID'])).rows; }
  catch (e) { if (!/Header row not found|Unable to parse range/i.test(e.message)) throw e; }
  res.json({ summaries: rows.map(r => ({ id: r.ID, at: r.At, title: r.Title, url: r.URL, summary: r.Summary, model: r.Model })).reverse().slice(0, 25) });
}));
app.post('/api/bio/summaries', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.url) return res.status(400).json({ error: 'title or url required' });
  const { callModel } = require('./bio-pipeline');
  const prompt = `Summarise this biotech news story for a clinical-trial tracker's reader in 3-5 sentences.
Title: ${b.title || ''}
Source: ${b.source || ''}
URL: ${b.url || ''}
${b.desc ? `Standfirst: ${b.desc}` : ''}

Say what happened, which company/drug/indication it concerns, and why it matters to someone tracking drug pipelines. If it names a trial, phase or regulatory date, keep those exact. If you do not have enough to go on, say so plainly rather than padding. No investment advice. Return the summary as plain prose with no preamble.`;
  let out;
  try { out = await callModel('haiku', prompt); }
  catch (e) { return res.status(503).json({ error: e.message }); } // free-transport refusal surfaces as-is
  const text = String(out.text || '').trim();
  const id = crypto.randomUUID();
  await appendTabRow(BIOSUM_TAB, BIOSUM_HEADERS, [nowIso(), b.title || '', b.url || '', text, out.model || '', id], BIO_SHEET_ID);
  res.json({ ok: true, id, summary: text, model: out.model });
}));

// Biotech-only news: its own feed set, deliberately NOT the owner's /api/news prefs
// (SUBJECTS/SOURCES there drive a different reader's dashboard).
let bioNewsCache = { at: 0, items: [] };
app.get('/api/bio/news', asyncRoute(async (req, res) => {
  if (Date.now() - bioNewsCache.at < 30 * 60 * 1000 && bioNewsCache.items.length) {
    const dis0 = await bioDismissed();
    return res.json({ items: bioNewsCache.items.filter(i => !dis0.has(i.link)), cached: true });
  }
  // Queries are built from the reader's own SUBJECTS, restricted to their own SOURCES —
  // the same "subjects x sources" idea as the main dashboard's news, scoped to this sheet.
  const prefs = await readBioPrefs();
  const subjects = prefs.SUBJECTS.slice(0, 12);
  const sources = prefs.SOURCES.slice(0, 8);
  const srcClause = sources.length ? ' (' + sources.map(x => '"' + x + '"').join(' OR ') + ')' : '';
  const queries = subjects.map(sub => sub + srcClause);
  // one unrestricted sweep so a big story from an unlisted outlet still lands
  queries.push(subjects.slice(0, 4).join(' OR '));
  const batches = await Promise.all(queries.map(q => rssSearch(q, 6).catch(() => [])));
  const seen = new Set(), items = [];
  for (let i = 0; i < batches.length; i++) {
    for (const it of batches[i]) {
      const k = (it.title || '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      items.push({ ...it, subject: subjects[i] || '' });
    }
  }
  items.sort((x, y) => (x.ageHours ?? 1e9) - (y.ageHours ?? 1e9));
  bioNewsCache = { at: Date.now(), items: items.slice(0, 40) };
  const dis = await bioDismissed();
  const visible = bioNewsCache.items.filter(i => !dis.has(i.link));
  track('bio-news', visible.length > 0, `${visible.length} items from ${subjects.length} subjects`);
  res.json({ items: visible, subjects, sources });
}));

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
const ACTEV_HEADERS_ALL = [...ACTEV_HEADERS, 'ScanLoc', 'EndDate']; // EndDate: multi-day runs (expo, harvest season) — expanded to Fri/Sat instances at read time
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
  const scanAllowed = !process.env.DASHBOARD_NO_JOBS || process.env.DASHBOARD_SCAN_EVENTS;
  if (actScanBusy || !hasLlm() || !scanAllowed) return;
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
          (() => { const ep = loadSettings().eventPrefs || {};
            return (ep.prefer || []).length || (ep.avoid || []).length
              ? `LEARNED TASTE (from the owner's swipes — bias, don't hard-filter): prefer ${JSON.stringify(ep.prefer || [])}; avoid ${JSON.stringify(ep.avoid || [])}.\n` : ''; })() +
          `You scan the web for events matching a personal interest.\nINTEREST: "${a.activity}"\nINSTRUCTIONS: ${a.instructions
            .replace(/\[currentlocation\]/gi, locationOnDate(today()) || 'the user\'s current city')
            .replace(/\[projectedlocation\]/gi, projLoc || locationOnDate(today()) || 'the user\'s current city')}\n` +
          `Use WebSearch/WebFetch. Find CONCRETE, DATED events in the NEXT 21 DAYS. Only real events with a source — NEVER invent; an empty list is a fine answer.\n` +
          `NEVER return a physical event in a city the owner will NOT be in on that date (per the projection above), and SKIP cities where the stay is under one full day (an airport stopover or a few hours in transit gets ZERO proposals). Location-independent events (TV/streamed broadcasts, online) are fine anywhere — mark them "local": false.\n` +
          (known ? `ALREADY KNOWN (do NOT return these again, even reworded — only genuinely NEW events):\n${known}\n` : '') +
          `At most 8 new events. ONE entry per real-world event — use a canonical title (e.g. "Australia v France — Nations Championship R2"), never multiple phrasings.\n` +
          `For TELEVISED matches/tournaments, "note" MUST name the TV channel or streamer carrying it${projLoc ? " in the owner's projected location on that date (per the projection above)" : ''} — e.g. "beIN Sports 1 (QA)", "Canal+ (FR)"; fall back to the primary international broadcaster if the local carrier is unclear.\n` +
          `For an event that RUNS OVER MULTIPLE DAYS (a festival, exhibition, season — e.g. date harvesting weeks), set "date" to its start (or today if already running) and add "endDate" (YYYY-MM-DD, the last day); single-day events omit endDate.\n` +
          `Return STRICT JSON only, no prose, no code fences: {"events":[{"date":"YYYY-MM-DD","endDate":"YYYY-MM-DD or omit","title":"…","time":"HH:MM or ''","venue":"…","url":"https://…","note":"one short practical line (where to watch — channel — / tickets / cost)","local":true|false}]}`,
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
          /^\d{4}-\d{2}-\d{2}$/.test(ev.endDate || '') && ev.endDate > ev.date ? ev.endDate : '',
        ]));
        fresh.forEach(ev => { seen.add(key(a.activity, ev.date, ev.title)); (tokIdx[a.activity + '|' + ev.date] = tokIdx[a.activity + '|' + ev.date] || []).push(toks(ev.title)); });
        track('activities', true, `${a.activity}: +${fresh.length} event${fresh.length === 1 ? '' : 's'}`);
      } catch (e) { track('activities', false, `${a.activity}: ${e.message}`); }
    }
  } finally { actScanBusy = false; }
}
if (HAS_CLAUDE || (CFG.llmRelayUrl && CFG.llmRelayKey)) {
  setTimeout(() => scanActivities().catch(() => {}), 90e3); // first pass shortly after boot
  setInterval(() => scanActivities().catch(() => {}), 4 * 3600e3);
}
// ---- CI event loop: swipes teach the scanner ----
// Nightly (and on demand) the event verdicts (up/down/skip/scheduled) are distilled by an
// LLM into settings.eventPrefs {prefer:[…], avoid:[…], note} — a LEARNED overlay that (a)
// rides the scan prompt so future proposals shift, and (b) ranks what is already proposed.
// The owner's ACTIVITIES spec is never rewritten: their words stay theirs.
function collectEventFeedback(maxLines = 4000) {
  const out = [];
  try {
    const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').trim().split('\n').slice(-maxLines);
    for (const l of lines) { try { const j = JSON.parse(l); if (String(j.kind || '').startsWith('event_')) out.push(j); } catch (e) {} }
  } catch (e) {}
  return out;
}
function eventPrefScore(prefs, title) {
  const T = String(title).toLowerCase();
  let sc = 0;
  for (const p of (prefs.prefer || [])) if (T.includes(String(p).toLowerCase())) sc += 1;
  for (const a of (prefs.avoid || [])) if (T.includes(String(a).toLowerCase())) sc -= 1;
  return sc;
}
async function tuneEventPrefs() {
  const fb = collectEventFeedback();
  if (fb.length < 3) return { skipped: 'not enough event feedback yet' };
  const lines = fb.slice(-120).map(f => `${f.kind.replace('event_', '')}: [${f.source || ''}] ${f.title}`).join('\n');
  const cur = loadSettings().eventPrefs || {};
  const raw = await runClaude(
    `You tune an event scanner from the owner's verdicts (scheduled=went on the calendar — strongest like; up=thumbs up; down=less like this; skipped=mildly negative).\n` +
    `Current learned preferences: ${JSON.stringify({ prefer: cur.prefer || [], avoid: cur.avoid || [] })}\n` +
    `Verdicts (newest last):\n${lines}\n` +
    `Return ONLY JSON {"prefer":[…],"avoid":[…],"note":"one sentence for the owner"} — each list ≤8 SHORT lowercase keyword phrases (substring-matched against titles), evolving the current lists rather than restarting. Never put a specific one-off event title in either list; capture the KIND of thing.`,
    { module: 'event-prefs-tune', timeoutMs: 45000 });
  let j = null; try { j = JSON.parse((raw.match(/\{[\s\S]*\}/) || [''])[0]); } catch (e) {}
  if (!j || !Array.isArray(j.prefer) || !Array.isArray(j.avoid)) return { error: 'tune parse failed' };
  const prefs = { prefer: j.prefer.map(x => String(x).slice(0, 40)).slice(0, 8),
    avoid: j.avoid.map(x => String(x).slice(0, 40)).slice(0, 8),
    note: String(j.note || '').slice(0, 200), at: nowIso() };
  await saveSettings({ ...loadSettings(), eventPrefs: prefs });
  return { ok: true, prefs };
}
app.post('/api/events/tune', asyncRoute(async (req, res) => res.json(await tuneEventPrefs())));
if (!process.env.DASHBOARD_NO_JOBS || process.env.DASHBOARD_SCAN_EVENTS) {
  setTimeout(() => tuneEventPrefs().catch(() => {}), 5 * 60000);           // shortly after boot
  setInterval(() => tuneEventPrefs().catch(() => {}), 24 * 3600e3);        // then daily
}
// batch dismissal for the Clear-all button — ONE Sheets append for the whole pool.
// The old per-item loop made 2 sequential API calls per event with errors swallowed:
// a 38-event pool = ~76 calls, which blows the per-minute Sheets write quota, so every
// click cleared a random subset and the owner had to keep clicking (reported 2026-08-09).
app.post('/api/events/clear-all', asyncRoute(async (req, res) => {
  const items = (Array.isArray((req.body || {}).items) ? req.body.items : [])
    .filter(it => it && it.title).slice(0, 200);
  if (!items.length) return res.json({ ok: true, cleared: 0 });
  const at = nowIso();
  try {
    await appendTabRows(DISMISS_TAB, DISMISS_HEADERS,
      items.map(it => ['evt:' + normTitle(it.title) + '|' + (it.activity || ''), String(it.title).slice(0, 120), at]));
  } catch (e) {
    // the dismissal rows are what actually hides events — if they didn't land, say so
    return res.status(502).json({ error: 'dismissal write failed: ' + e.message });
  }
  const fb = items.map(it => ({ at, kind: 'event_skipped', signal: SIGNAL_BY_KIND.event_skipped,
    title: String(it.title).slice(0, 120), source: String(it.activity || ''), url: '', subjects: [], person: '', author: '', context: 'clear-all' }));
  try {
    if (HAS_JOURNAL) fb.forEach(e => fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(e) + '\n'));
    else await appendTabRows(FB_TAB, FB_HEADERS, fb.map(e => [JSON.stringify(e), at, '']));
  } catch (e) { console.error('clear-all feedback log:', e.message); }
  dismissedCache.at = 0;
  res.json({ ok: true, cleared: items.length });
}));
// per-day dismissal for multi-day runs: hides ONE Fri/Sat instance; the evt: token (swipe
// or "all days") still kills every instance of the run at once.
app.post('/api/events/dismiss-day', asyncRoute(async (req, res) => {
  const { title, activity, date } = req.body || {};
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'title + date required' });
  await appendTabRow(DISMISS_TAB, DISMISS_HEADERS,
    ['evtd:' + normTitle(title) + '|' + (activity || '') + '|' + date, String(title).slice(0, 120), nowIso()]);
  dismissedCache.at = 0;
  res.json({ ok: true });
}));
app.get('/api/activities', asyncRoute(async (req, res) => {
  const acts = await loadActivitiesConfig();
  const leadOf = Object.fromEntries(acts.map(a => [a.activity, a.leadDays]));
  const showOf = Object.fromEntries(acts.map(a => [a.activity, a.show]));
  const tab = await readTabCached(TODO_SHEET_ID, ACTEV_TAB, ACTEV_HEADERS, 120000).catch(() => ({ rows: [] }));
  const dismissedEvt = (await getDismissedSet().catch(() => ({ urls: new Set() }))).urls;
  const dismissedToks = await getDismissedEvtToks().catch(() => ({}));
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
  // time-expiry: a same-day event whose end has passed is over — auto-expire it. Time may be
  // "HH:MM" (assume ≤3h) or "HH:MM-HH:MM"; untimed same-day rows survive until midnight.
  const nowHM = new Date().toTimeString().slice(0, 5); // server-local clock (Mac = owner's TZ; cloud=UTC expires late, never early)
  const stillOn = r => {
    if (r.Date !== t0) return true;
    const m = /^(\d{2}:\d{2})(?:\s*-\s*(\d{2}:\d{2}))?/.exec(String(r.Time || '').trim());
    if (!m) return true;
    const end = m[2] || (String(Math.min(23, +m[1].slice(0, 2) + 3)).padStart(2, '0') + m[1].slice(2));
    return end >= nowHM;
  };
  // Multi-day runs expand FIRST (owner decree 2026-08-09: list on every Fri & Sat until the
  // end date) so every later filter judges each INSTANCE date — expanding after the date
  // filter killed the whole run the day after its start date slipped past "today".
  const expanded = tab.rows.flatMap(r => {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(r.EndDate || '')) ? r.EndDate : '';
    if (!end || end <= r.Date) return [r];
    const out = [];
    for (let t = Math.max(Date.parse(r.Date), Date.parse(t0)); t <= Math.min(Date.parse(end), Date.parse(horizon)); t += 86400000) {
      const dt = new Date(t); const dow = dt.getUTCDay();
      if (dow === 5 || dow === 6) out.push({ ...r, Date: dt.toISOString().slice(0, 10), _runsTo: end, _multi: true });
    }
    return out;
  });
  const events = expanded.filter(r => r.Date >= t0 && r.Date <= horizon).filter(stillOn)
    .filter(r => { // stopover guard (owner, 2026-08-11: "4 hours in Paris and I've had 100
      // proposals"): never propose location-bound events for stays under a full day —
      // require the projected stay containing the event date to span >= 2 consecutive days
      if (r._multi || !String(r.ScanLoc || '').trim()) return true;
      const here = locationOnDate(r.Date); if (!here) return true;
      const shiftD = (d, k) => new Date(Date.parse(d) + k * 864e5).toISOString().slice(0, 10);
      let run = 1;
      for (let k = 1; k < 14 && locationOnDate(shiftD(r.Date, -k)) === here; k++) run++;
      for (let k = 1; k < 14 && locationOnDate(shiftD(r.Date, k)) === here; k++) run++;
      return run >= 2;
    })
    .filter(r => { // projected-location gate (see ScanLoc column); selected multi-day runs
      // bypass it — they are planning-relevant wherever the owner is, and the (location)
      // suffix in the label makes the geography explicit
      if (r._multi) return true;
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
    .filter(r => !dismissedEvt.has('evt:' + normTitle(r.Title) + '|' + r.Activity)) // swiped away = gone, every tier
    .filter(r => !evtNearDismissed(dismissedToks, r.Activity, r.Title)) // …including the rescan's near-clone retitlings
    .filter(r => !r._multi || !dismissedEvt.has('evtd:' + normTitle(r.Title) + '|' + r.Activity + '|' + r.Date)) // per-day ✕
    .map(r => ({ activity: r.Activity, date: r.Date, title: r.Title, time: r.Time, venue: r.Venue, url: r.URL, note: r.Note, show: showOf[r.Activity] || 'all',
      loc: String(r.ScanLoc || '').trim(), runsTo: r._runsTo || '', multi: !!r._multi,
      score: eventPrefScore(loadSettings().eventPrefs || {}, r.Title) }))
    .sort((x, y) => x.date.localeCompare(y.date) || String(x.time).localeCompare(String(y.time)));
  const leads = events.filter(ev => {
    const lead = leadOf[ev.activity] || 0;
    if (!lead) return false;
    const start = new Date(Date.parse(ev.date) - lead * 86400000).toISOString().slice(0, 10);
    return t0 >= start && t0 < ev.date;
  });
  res.json({ events, leads, eventPrefs: loadSettings().eventPrefs || null });
}));
// salient upcoming events (in their lead-alert window) for the Agent Brief — the "events of
// interest, elevated if salient" side of the weather/events brief hook.
async function eventLeadsForBrief() {
  try {
    const acts = await loadActivitiesConfig();
    const leadOf = Object.fromEntries(acts.map(a => [a.activity, a.leadDays]));
    const tab = await readTabCached(TODO_SHEET_ID, ACTEV_TAB, ACTEV_HEADERS, 120000).catch(() => ({ rows: [] }));
    const t0 = today();
    return tab.rows.filter(r => {
      const lead = leadOf[r.Activity] || 0; if (!lead) return false;
      const start = new Date(Date.parse(r.Date) - lead * 864e5).toISOString().slice(0, 10);
      return t0 >= start && t0 < r.Date;
    }).slice(0, 4).map(r => ({ kind: 'event', text: `${r.Title}${r.Venue ? ' @ ' + r.Venue : ''} — ${r.Date}` }));
  } catch (e) { return []; }
}
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
    // WATCH-events are not travel: a short match/show scheduled at a distant venue means
    // the owner watches it (the rugby-in-Argentina incident, 2026-08-02) — a real trip
    // shows up as flights/hotels/multi-day spans, which other evidence already carries.
    const hours = e && ev.start?.dateTime ? (Date.parse(e) - Date.parse(s)) / 36e5 : 24;
    if (hours <= 8 && /\bv\.?s?\b| v |match|championship|cup\b|final\b|concert|festival|grand prix|screening/i.test(String(ev.summary || ''))) return false;
    return days >= 1 || !!ev.location; // multi-day span, or any event carrying a location field
  });
  if (!candidates.length) return;
  let extracted = [];
  if (HAS_CLAUDE || process.env.ANTHROPIC_API_KEY) {
    try {
      const lines = candidates.slice(0, 40).map((ev, i) => `${i}. ${ev.start?.dateTime || ev.start?.date} → ${ev.end?.dateTime || ev.end?.date || ''} | "${ev.summary || ''}"${ev.location ? ' @ ' + ev.location : ''}`);
      const raw = await runClaude(
        `Calendar events. For each one that clearly indicates the OWNER WILL PHYSICALLY BE in a specific real-world PLACE (a real city/region/country — "France", "Pau", "London office"), extract it. ` +
        `Skip anything that ISN'T evidence of the owner's own location: generic meetings/reminders/birthdays, school-holiday zone labels ("Zone A/B/C"), academic-calendar terms, public-holiday names, any event whose "place" is really a category/classification, and SPECTATOR events — a sports match, concert or show at a venue (especially in another country, or timed in the owner's home timezone) means the owner WATCHES it, not that they travel there. Only extract a place when the event itself implies the owner physically goes (flight, hotel, "trip to", multi-day stay).\n` +
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
  // CHEAPEST QUALIFIED FIRST: tool-free work on NON-PERSONAL modules goes to the Google AI
  // Studio free tier ($0, rate-limited). Any failure — rate limit, empty, no key — falls
  // straight through to the paid chain, so this can only ever save money, never block work.
  if (!tools) {
    const pv = require('./providers');
    if (pv.geminiFreeAllowed(module)) {
      try {
        const out = await pv.geminiFreeText(prompt, undefined, module || 'generate-text');
        if (out) { mark('gemini-free (AI Studio)'); return out; }
      } catch (e) { track('agent', true, 'gemini-free unavailable, falling through: ' + String(e.message).slice(0, 80)); }
    }
  }
  // GCP-trial window: Vertex is effectively free while credits last, so it outranks
  // EVERYTHING for plain-text work — including the claw's own claude CLI (subscription
  // capacity is better spent where tools are needed). Tools still go CLI/relay. Expires
  // automatically at DASHBOARD_TRIAL_END — no surprise bills when credits run out.
  if (!tools && trialActive() && CFG.gcpProject) {
    try {
      const r = await require('./providers').generateText(prompt, 'vertex-gemini');
      if (r && r.text) { mark('vertex-gemini (trial credits)'); return r.text; }
    } catch (e) { /* fall through the normal ladder */ }
  }
  if (!HAS_CLAUDE) {
    // subscription first: a configured relay forwards to a tier that HAS the claude CLI,
    // so cloud instances never touch metered API keys for routine LLM work. Web tools
    // (fetch/search) ride the relay too — the CLI on the far end runs them.
    if (tools && !(CFG.llmRelayUrl && CFG.llmRelayKey)) throw new Error('agent tools (web fetch/search) require the claude CLI');
    if (CFG.llmRelayUrl && CFG.llmRelayKey) {
      const r = await fetch(CFG.llmRelayUrl.replace(/\/$/, ''), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-key': CFG.llmRelayKey },
        body: JSON.stringify({ prompt, timeoutMs, ...(tools ? { tools } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text !== undefined) {
        if (j.sponsorDaysLeft !== undefined) runClaude._sponsorDaysLeft = j.sponsorDaysLeft;
        mark('claude (relay)');
        logUsage({ module: module || 'claude', model: 'claude-relay', input: 0, output: 0, costUsd: j.costUsd ?? '', note: 'via llm-relay' }).catch(() => {});
        return String(j.text).trim();
      }
      throw new Error('llm-relay failed: ' + String(j.error || r.status).slice(0, 200));
    }
    const pv = require('./providers');
    if (!process.env.ANTHROPIC_API_KEY && pv.hasUserKey('openrouter')) {
      mark('openrouter (user key)'); // ⚙-entered key — the public tier's own funding
      return await pv.openrouterText(prompt);
    }
    mark(model || 'anthropic-api');
    return await pv.anthropicText(prompt, model, module); // API-key path (stub default)
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

// ---------- journal-driven ad-hoc lists ----------
// A `##` heading in a daily note that ISN'T one of the template's own sections (e.g.
// "## Pack for the trip") becomes an ephemeral todo box on the dashboard, built from
// the bulleted items under it. No LLM — a plain markdown scan on the Mac (the only tier
// with the vault), synced to the cloud tier via a Heartbeat cell like markets/bars. Boxes
// persist until the owner ✕-dismisses them (they don't vanish when the day rolls over);
// a dismissed heading only comes back if its note is edited again after the dismissal.
const JLIST_WINDOW = 30; // scan window widened 7→30 (2026-07-31): recovers lists that the old replace-not-merge scan evaporated; retention keeps them regardless of window now
// template sections that are NEVER ad-hoc lists (lowercased); config can extend for other vaults.
// Confidential rule (2026-07-29): headings ending in "confidential" are skipped entirely —
// enforced below in the heading filter, never surfaced as dashboard boxes.
const KNOWN_HEADINGS = new Set([
  'post-meditation notes', 'health notes', 'family/personal notes', 'journal', 'work', 'todo',
  'stashed notes', 'agent feedback', 'ci log', 'agent notes', 'agent log', 'stashed media',
  ...(Array.isArray(CFG.journalKnownHeadings) ? CFG.journalKnownHeadings.map(h => String(h).toLowerCase()) : []),
]);
const jlSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
// The ## Todo section is itself scanned: a LABELED bulleted group under it (a non-bullet
// label line followed by bullets) becomes a box UNLESS its label routes to an existing
// quadrant (Q1–Q4 / M, or a configured quadrant name) — mirroring how the heartbeat files
// those. An explicit "(new)" / "-new" / "-n" / "start new … box" marker forces a box even
// for a quadrant-named group.
const TODO_SECTION = String(CFG.journalTodoSection || 'todo').toLowerCase();
const jlNewMarker = s => /\(\s*(?:new|start)\b[^)]*\)|(?:^|\s)[-–]\s*n(?:ew)?\s*$|\bnew (?:collapsed )?(?:section|box)\b|\bstart (?:a )?new\b/i.test(String(s));
function jlQuadrantLabels() {
  const s = new Set(['m', 'monitor', 'urgent + important', 'important, schedule', 'delegate to agent', 'neither, eliminate', 'learning goals',
    ...(Array.isArray(CFG.journalQuadrantAliases) ? CFG.journalQuadrantAliases.map(x => String(x).toLowerCase()) : [])]);
  try { const q = (loadSettings().quadrants) || {}; for (const k of Object.keys(q)) { s.add(k.toLowerCase()); if (q[k] && q[k].label) s.add(String(q[k].label).toLowerCase()); } } catch (e) {}
  return s;
}
function jlIsQuadrantLabel(label) {
  const l = String(label).toLowerCase().trim();
  if (/^\(?q[1-9]\)?:?$/.test(l) || /^\(?[lm]\d*\)?:?$/.test(l)) return true;   // "Q3:", "(Q1)", "M", "L6"
  if (/[-–,:]?\s*\(?q[1-9]\)?:?\s*$/.test(l) && l.replace(/[-–,:()\s]|q[1-9]/g, '').length) return true; // "Moulin (Q1)"
  return jlQuadrantLabels().has(l.replace(/[():]/g, '').trim());
}
function jlCleanTodoLabel(s) {
  return String(s)
    .replace(/^\s*\[[ xX]?\]\s*/, '')               // leading [] / [x] checkbox
    .replace(/#[\w-]+/g, '')                          // #todo etc. tags
    .replace(/\(\s*(?:new|start)\b[^)]*\)/ig, '')     // (new …) / (start new … box …)
    .replace(/[-–]\s*n(?:ew)?\s*$/i, '')              // -new / -n suffix
    .replace(/[-–,:]?\s*\(?q[1-9]\)?:?\s*$/i, '')     // trailing quadrant ref
    .replace(/[*_`]+/g, '')                            // markdown emphasis
    .replace(/[:\-–]\s*$/, '')
    .replace(/\s+/g, ' ').trim();
}
// ---- Ephemeral Lists: the Sheet tab IS the store (David 2026-07-31) ----
// The journal is INTAKE only: the scanner picks a new ad-hoc list up ONCE and moves it to
// the 'Ephemeral Lists' tab — two columns per list (items | done), expandable on request.
// Item marks: '' open · 'D' doer-reported complete (external helper) · 'Y' owner-checked.
// Completing a list (all Y, or ✕ on the dashboard) rewrites its second header to
// "completed DD-MM-YY" → inactive; pairs completed >30d are dropped and the sheet condensed
// (daily) so columns never run out. keepStorage: storeValues_update stays (other cells use it).
const ELISTS_TAB = 'Ephemeral Lists';
const ELIST_COMMENTS_TAB = 'List Comments';
const ELIST_COMMENTS_HEADERS = ['At', 'List', 'Item', 'From', 'Text'];
function storeValues_update(cell, raw) {
  store.values.update({ spreadsheetId: TODO_SHEET_ID, range: cell, valueInputOption: 'RAW', requestBody: { values: [[String(raw).slice(0, 49000)]] } }).catch(() => {});
}
let elistsTabReady = false;
async function elistsEnsureTab() {
  if (elistsTabReady) return;
  const meta = await store.spreadsheets.get({ spreadsheetId: TODO_SHEET_ID });
  if (!(meta.data.sheets || []).some(x => x.properties.title === ELISTS_TAB))
    await store.spreadsheets.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: ELISTS_TAB } } }] } });
  elistsTabReady = true;
}
const elistDDMMYY = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}`; };
async function elistsRead() { // → { grid, lists:[{slug,heading,col,persistent,completedAt,items:[{row,text,mark}]}] }
  await elistsEnsureTab();
  // A failed read must THROW, never masquerade as an empty tab: a swallowed quota error
  // here once made the intake scanner believe every list was missing and re-create the
  // whole tab — four times over (2026-08-01). Callers skip a cycle on error; that's fine.
  const r = await store.values.get({ spreadsheetId: TODO_SHEET_ID, range: `'${ELISTS_TAB}'!A1:ZZ300` });
  const grid = r.data.values || [];
  const head = grid[0] || [];
  const lists = [];
  for (let c = 0; c < head.length; c += 2) {
    const heading = String(head[c] || '').trim();
    if (!heading) continue;
    const h2 = String(head[c + 1] || '').trim();
    const cm = /^completed\s+(\d{2}-\d{2}-\d{2,4})/i.exec(h2);
    const items = [];
    for (let rI = 1; rI < grid.length; rI++) {
      const text = String((grid[rI] || [])[c] || '').trim();
      if (!text) continue;
      items.push({ row: rI + 1, text, mark: String((grid[rI] || [])[c + 1] || '').trim().toUpperCase() });
    }
    lists.push({ slug: jlSlug(heading), heading, col: c, persistent: /persistent/i.test(h2), completedAt: cm ? cm[1] : null, items });
  }
  // Belt-and-braces: if past duplication left several column-pairs with one slug, expose a
  // single merged list (earliest column wins; item marks merge, Y > D > ''). Write paths
  // then act on one column and the UI never shows phantom copies.
  const bySlug = new Map();
  for (const l of lists) {
    const prev = bySlug.get(l.slug);
    if (!prev) { bySlug.set(l.slug, l); continue; }
    const strength = m => m === 'Y' ? 2 : m === 'D' ? 1 : 0;
    for (const it of l.items) {
      const mine = prev.items.find(x => x.text === it.text);
      if (!mine) prev.items.push({ ...it, row: 0, foreignCol: l.col });
      else if (strength(it.mark) > strength(mine.mark)) mine.mark = it.mark;
    }
    if (!l.completedAt) prev.completedAt = null; // any active copy keeps the list active
    prev.dupCols = [...(prev.dupCols || []), l.col];
  }
  return { grid, lists: [...bySlug.values()] };
}
async function elistsCreate(heading, texts, doneTexts = new Set(), { persistent = false } = {}) {
  const { grid, lists } = await elistsRead();
  const used = lists.length ? Math.max(...lists.map(l => l.col)) + 2 : 0;
  const col = used; // first free pair
  const values = [[heading, persistent ? 'done (persistent)' : 'done'],
    ...texts.map(t => [t, doneTexts.has(t) ? 'Y' : ''])];
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${ELISTS_TAB}'!${colLetter(col)}1:${colLetter(col + 1)}${values.length}`, valueInputOption: 'RAW', requestBody: { values } });
}
async function elistsAppendItems(list, texts) {
  if (!texts.length) return;
  const startRow = (list.items.length ? Math.max(...list.items.map(i => i.row)) : 1) + 1;
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${ELISTS_TAB}'!${colLetter(list.col)}${startRow}:${colLetter(list.col)}${startRow + texts.length - 1}`, valueInputOption: 'RAW', requestBody: { values: texts.map(t => [t]) } });
}
async function elistsSetMark(list, row, mark) {
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${ELISTS_TAB}'!${colLetter(list.col + 1)}${row}`, valueInputOption: 'RAW', requestBody: { values: [[mark]] } });
}
async function elistsSetHeader2(list, text) {
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${ELISTS_TAB}'!${colLetter(list.col + 1)}1`, valueInputOption: 'RAW', requestBody: { values: [[text]] } });
}
async function elistsCleanup() { // completed >30d → drop the column pair (rightmost first), condensing the sheet
  const { lists } = await elistsRead();
  const cutoff = Date.now() - 30 * 864e5;
  const dead = lists.filter(l => {
    if (!l.completedAt) return false;
    const [dd, mm, yy] = l.completedAt.split('-').map(Number);
    return new Date(2000 + (yy % 100), mm - 1, dd).getTime() < cutoff;
  }).sort((a, b) => b.col - a.col);
  if (!dead.length) return 0;
  const meta = await store.spreadsheets.get({ spreadsheetId: TODO_SHEET_ID });
  const sheetId = meta.data.sheets.find(x => x.properties.title === ELISTS_TAB).properties.sheetId;
  await store.spreadsheets.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { requests: dead.map(l => ({ deleteDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: l.col, endIndex: l.col + 2 } } })) } });
  return dead.length;
}
// Mac-only: parse the recent daily notes, upsert ad-hoc lists, preserve done-state by item text.

async function scanJournalLists() {
  if (!HAS_JOURNAL || process.env.DASHBOARD_NO_JOBS) return;
  let files = [];
  try { files = fs.readdirSync(JOURNAL_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-JLIST_WINDOW); } catch (e) { return; }
  const found = {}; // slug -> { heading, date, mtime, items:[{text,done}] } — newest note wins the items
  for (const f of files) {
    const full = path.join(JOURNAL_DIR, f);
    let mtime, text;
    try { mtime = fs.statSync(full).mtimeMs; text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    let cur = null, items = null;              // ad-hoc H2 section in progress
    let inTodo = false, tLabel = null, tItems = null; // labeled group inside ## Todo
    const bullet = line => line.match(/^\s*(?:[-*+•]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    const flushTodo = () => {                  // decide if the just-parsed ## Todo group is a box
      if (tLabel && tItems && tItems.length) {
        const forced = jlNewMarker(tLabel);
        if (forced || !jlIsQuadrantLabel(tLabel)) {
          const clean = jlCleanTodoLabel(tLabel) || 'Todo';
          found[jlSlug(clean)] = { heading: clean, date: f.slice(0, 10), mtime, items: tItems };
        }
      }
      tLabel = null; tItems = null;
    };
    for (const line of text.split('\n')) {
      const h2 = line.match(/^##\s+(.+?)\s*$/);
      if (h2) {
        cur = null; items = null; flushTodo(); inTodo = false;
        const heading = h2[1].trim();
        if (heading.toLowerCase() === TODO_SECTION) { inTodo = true; continue; }
        if (KNOWN_HEADINGS.has(heading.toLowerCase()) || !heading) continue;
        if (/confidential\s*$/i.test(heading)) continue; // confidential sections never surface (David 2026-07-29)
        cur = heading; items = [];
        found[jlSlug(heading)] = { heading, date: f.slice(0, 10), mtime, items }; // newest file overwrites
        continue;
      }
      if (/^#(?!#)/.test(line) || /^#{3,}\s/.test(line)) { cur = null; flushTodo(); inTodo = false; continue; } // H1 / H3+ ends the section
      if (inTodo) {
        const b = bullet(line);
        if (b && b[2].trim()) { if (tLabel) tItems.push({ text: b[2].trim(), done: /[xX]/.test(b[1] || '') }); } // bullet under a label
        else if (line.trim()) { flushTodo(); tLabel = line.trim(); tItems = []; }                               // a new group label
        continue;
      }
      if (cur) {
        const b = bullet(line);
        if (b && b[2].trim()) items.push({ text: b[2].trim(), done: /[xX]/.test(b[1] || '') });
      }
    }
    flushTodo();
  }
  // INTAKE ONLY (David 2026-07-31): a journal list moves to the Ephemeral Lists tab once;
  // thereafter the TAB is the source of truth — done-marks, doer-marks, completion, comments
  // all live there. A completed list is NOT reopened by its journal section still existing;
  // new bullets added to an ACTIVE list's journal section do flow in.
  try {
    const { lists: tabLists } = await elistsRead();
    const bySlug = Object.fromEntries(tabLists.map(l => [l.slug, l]));
    for (const [slug, v] of Object.entries(found)) {
      if (!v.items.length) continue;
      const existing = bySlug[slug];
      if (!existing) { await elistsCreate(v.heading, v.items.map(i => i.text), new Set(v.items.filter(i => i.done).map(i => i.text))); continue; }
      if (existing.completedAt) continue;
      const have = new Set(existing.items.map(i => i.text));
      await elistsAppendItems(existing, v.items.filter(i => !have.has(i.text)).map(i => i.text));
    }
    // daily housekeeping: drop pairs completed >30d, condensing the sheet
    if (!scanJournalLists._cleanedDay || scanJournalLists._cleanedDay !== today()) {
      scanJournalLists._cleanedDay = today();
      await elistsCleanup().catch(() => {});
    }
  } catch (e) { console.error('elists intake:', e.message); }
}

if (HAS_JOURNAL && !process.env.DASHBOARD_NO_JOBS) {
  setTimeout(() => scanJournalLists().catch(() => {}), 20e3);
  setInterval(() => scanJournalLists().catch(() => {}), 120e3); // journal edits are frequent — low latency
}
// list API — tab-backed; same response shapes the frontend already renders.
async function elistsPayload() {
  const { lists } = await elistsRead();
  // recent comments (external helpers) attach to items by list+item text
  let comments = [];
  try {
    const tab = await readTabCached(TODO_SHEET_ID, ELIST_COMMENTS_TAB, ELIST_COMMENTS_HEADERS, 30000);
    comments = tab.rows.slice(-200);
  } catch (e) {}
  const out = lists.filter(l => !l.completedAt).map(l => ({
    id: 'jl:' + l.slug, heading: l.heading, persistent: l.persistent,
    items: l.items.map(i => ({ text: i.text, done: i.mark === 'Y', doer: i.mark === 'D',
      comments: comments.filter(c => c.List === l.slug && c.Item === i.text).map(c => ({ from: c.From, text: c.Text, at: c.At })) })),
  }));
  // shared lists living on an external sheet (family datastore) join the payload —
  // unless promoted to a Task List (quadrants[k].share), which owns them instead
  const promoted = new Set(sharedBinds().map(b => b.slug));
  for (const [slug, cfg] of Object.entries(loadSettings().listShares || {})) {
    if (!cfg || !cfg.sheetId || promoted.has(slug)) continue;
    try { out.push(await sharedListView(slug, cfg)); } catch (e) {}
  }
  return out;
}
// One shared list in the Ephemeral-payload shape. Kept separate from elistsPayload so the
// EXTERNAL token API can serve a list whether or not it has been promoted to a Task List —
// promotion is an owner-side display choice and must never change the published contract.
// ---------- display-language translation ----------
// CFG.languages = priority list (['en','fr']). Text whose SCRIPT proves a language not on
// the list (Sinhala, Arabic, CJK, …) is translated to languages[0]; anything in an on-list
// language is left exactly as typed — en↔fr never translate into each other. Cached on
// disk by content hash, so each string costs one LLM call ever.
const FOREIGN_SCRIPTS = [[/[\u0D80-\u0DFF]/, 'si'], [/[\u0600-\u06FF]/, 'ar'], [/[\u0900-\u097F]/, 'hi'],
  [/[\u4E00-\u9FFF]/, 'zh'], [/[\u3040-\u30FF]/, 'ja'], [/[\uAC00-\uD7AF]/, 'ko'],
  [/[\u0400-\u04FF]/, 'ru'], [/[\u0E00-\u0E7F]/, 'th'], [/[\u10A0-\u10FF]/, 'ka'], [/[\u0590-\u05FF]/, 'he']];
const foreignLangOf = t => { for (const [re, l] of FOREIGN_SCRIPTS) if (re.test(String(t))) return l; return null; };
const TRANS_FILE = path.join(__dirname, 'data', 'translations.json');
let transCache = null;
function transLoad() { if (!transCache) { try { transCache = JSON.parse(fs.readFileSync(TRANS_FILE, 'utf8')); } catch (e) { transCache = {}; } } return transCache; }
function transSave() { try { fs.writeFileSync(TRANS_FILE, JSON.stringify(transCache)); } catch (e) {} }
const transKey = (t, lang) => lang + ':' + crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 16);
// `target` lets a surface ask for a language that is NOT the owner's first:
// the helper's list page renders her own language; owner/guest pages keep theirs.
// Everything else (script gate, disk cache, one-call-ever) is unchanged.
async function translateForDisplay(texts, target = (CFG.languages || [])[0]) {
  if (!target) return {};
  const cache = transLoad();
  const onList = (CFG.languages || []).includes(target)
    ? (CFG.languages || [])            // owner surface: en/fr pass through untouched
    : [target];                        // guest surface: only the target passes through
  const need = [...new Set(texts.filter((t) => {
    if (!t) return false;
    const script = foreignLangOf(t);
    // script proves the language only when it is non-Latin; Latin text is assumed
    // to be on-list for the owner surface, and to need translating for a guest one
    return script ? !onList.includes(script) : !onList.includes('en');
  }))];
  const out = {};
  const miss = [];
  for (const t of need) { const k = transKey(t, target); if (cache[k]) out[t] = cache[k]; else miss.push(t); }
  if (miss.length) {
    try {
      const raw = await runClaude('Translate each string to ' + target + '. Reply with ONLY a JSON array of the translations, same order, same length.\n'
        + JSON.stringify(miss.slice(0, 20)), { module: 'display-translate', timeoutMs: 30000 });
      const arr = JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0]);
      miss.slice(0, 20).forEach((t, i) => { if (typeof arr[i] === 'string' && arr[i].trim()) { out[t] = arr[i].trim(); cache[transKey(t, target)] = out[t]; } });
      transSave();
    } catch (e) {} // untranslated beats blocked — the original text still shows
  }
  return out;
}

async function sharedListView(slug, cfg) {
  const { items, comments } = await sharedListRead(cfg.sheetId, cfg.tab || slug);
  const tr = await translateForDisplay([...items.map(i => i.text), ...comments.map(c => c.Text)]);
  const disp = t => tr[t] || t;
  return { id: 'jl:' + slug, heading: cfg.label || (cfg.name ? cfg.name + ' tasks' : slug), persistent: true, shared: true,
    items: items.map(i => ({ text: disp(i.text), orig: tr[i.text] ? i.text : undefined, done: i.mark === 'Y', doer: i.mark === 'D',
      comments: comments.filter(c => c.Item === i.text || !c.Item).map(c => ({ from: c.From, text: disp(c.Text), at: c.At })) })) };
}
// ---------- Q3 intern engine (owner decree 2026-08-10; workflow rev 2026-08-11) ----------
// Q3 = "Delegated to Agent" — but attempts are SPEC-GATED (rev): a row added without
// explicit go-words is NOT run; it gets an AT number, an orange [awaiting spec] badge at
// the bottom of Q3, and a morning Agent Feedback line asking for directions. Once
// directions arrive (AF reply or the dashboard thread) the task is attempted ONCE per
// direction — there is NO interval auto-retry (removed 2026-08-11: retries just re-tried
// the same thing). The dashboard thread shows only each run's SUMMARY (essential findings
// + guidance questions); full detail lives in the canonical .md. Per-task stats (runs,
// tokens, cost by model, funding class) ride the thread header. Escalation is recommended,
// never self-granted. Guardrails identical to the heartbeat.
const INTERN_DIR = CFG.internTasksDir || path.join(__dirname, 'data', 'agent-threads');
const ITHREADS_TAB = 'Agent Threads';
const ITHREADS_HEADERS = ['ID', 'Task', 'Thread', 'Status', 'Updated'];
const INTERN_STATS_FILE = path.join(__dirname, 'data', 'intern-stats.json');
const INTERN_TIER_DEFAULTS = {
  'intern-cheap': 'claude-haiku-4-5-20251001', intern: 'claude-sonnet-5', 'intern-super': 'claude-opus-5',
};
// "explicit instructions to go/launch/start/search/etc" — the spec gate
const INTERN_GO_WORDS = /\b(go|launch|start|search|research|investigate|find|draft|write|compile|compare|analy[sz]e|book|prepare|build|fix|create|estimate|summari[sz]e|review|plan|check|propose|look\s*up|get\b)/i;
function internTierFor(task) {
  const tags = String(task.Tags || '').toLowerCase();
  const mod = /agent:secretariat/.test(tags) ? 'intern-super' : /agent:thoroughbred/.test(tags) ? 'intern' : 'intern-cheap';
  const roster = AGENT_STABLE.find(a => (a.modules || []).includes(mod));
  return { module: mod, model: modelFor(mod, (roster && roster.model) || INTERN_TIER_DEFAULTS[mod]), name: (roster && roster.name) || mod };
}
const internThreadPath = id => path.join(INTERN_DIR, id + '.md');
function readInternThread(id) { try { return fs.readFileSync(internThreadPath(id), 'utf8'); } catch (e) { return ''; } }
function internStats() { try { return JSON.parse(fs.readFileSync(INTERN_STATS_FILE, 'utf8')); } catch (e) { return {}; } }
function recordInternRun(taskId, entry) {
  const all = internStats();
  (all[taskId] = all[taskId] || []).push(entry);
  try { fs.writeFileSync(INTERN_STATS_FILE, JSON.stringify(all)); } catch (e) {}
}
const internSpecd = (task, md) => INTERN_GO_WORDS.test(String(task.Task || '') + ' ' + String(task.Notes || '')) || /\*\*Owner ·/.test(md);
const internAttempts = md => (md.match(/\n-------\n\*\*(?!Owner)/g) || []).length;
async function writeInternThread(id, taskTitle, md, status) {
  fs.mkdirSync(INTERN_DIR, { recursive: true });
  fs.writeFileSync(internThreadPath(id), md);
  try { // sheet mirror = the cross-tier read path (phone reads threads from here)
    await ensureTab(ITHREADS_TAB, ITHREADS_HEADERS);
    const { rows } = await readTab(TODO_SHEET_ID, ITHREADS_TAB, ITHREADS_HEADERS);
    const hit = rows.find(r => r.ID === id);
    const vals = [id, String(taskTitle).slice(0, 120), md.slice(0, 45000), status || '', nowIso()];
    if (hit) await store.values.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW',
      data: vals.map((v, i) => ({ range: `'${ITHREADS_TAB}'!${colLetter(i)}${hit._row}`, values: [[v]] })) } });
    else await appendTabRows(ITHREADS_TAB, ITHREADS_HEADERS, [vals]);
    _tabCache.delete(TODO_SHEET_ID + '|' + ITHREADS_TAB);
  } catch (e) { console.error('intern thread mirror:', e.message); }
}
// awaiting-spec bookkeeping: tag the row (orange badge + bottom-sort in the UI), mint the
// AT number once (linked, so checking the todo off auto-closes it)
async function internMarkAwaiting(task) {
  if (/awaiting-spec/.test(String(task.Tags || ''))) return;
  await updateTaskById(task.ID, { Tags: [String(task.Tags || ''), 'awaiting-spec'].filter(Boolean).join(',') }).catch(() => {});
  if (!String(task.AgentTask || '').trim()) {
    await createAgentTask({ task: 'Q3 delegated, awaiting spec: ' + String(task.Task).slice(0, 100) + ' — give directions in AF or the dashboard thread',
      source: 'intern', tags: 'awaiting-spec', linkedTodoId: task.ID }).catch(() => {});
  }
}
async function internClearAwaiting(task) {
  if (!/awaiting-spec/.test(String(task.Tags || ''))) return;
  await updateTaskById(task.ID, { Tags: String(task.Tags).split(',').map(x => x.trim()).filter(x => x && x !== 'awaiting-spec').join(',') }).catch(() => {});
}
const internBusy = new Set();
async function internRun(taskId, trigger = 'drain') {
  if (!HAS_CLAUDE && !(CFG.llmRelayUrl && CFG.llmRelayKey)) return { error: 'no llm on this tier' };
  if (internBusy.has(taskId)) return { busy: true };
  internBusy.add(taskId);
  try {
    const { rows } = await readTodoTab();
    const task = rows.find(r => r.ID === taskId);
    if (!task || String(task.Status).trim().toLowerCase() !== 'open' || String(task.Quadrant).trim() !== 'Q3') return { skipped: 'not an open Q3 task' };
    const tier = internTierFor(task);
    let md = readInternThread(taskId);
    if (!md) md = `# ${task.Task}\n\ntask ${taskId} · opened ${task.Created || '?'} · tags: ${task.Tags || '-'}\n${task.Notes ? '\nOwner notes at delegation:\n' + task.Notes + '\n' : ''}`;
    if (!internSpecd(task, md)) { await internMarkAwaiting(task); await writeInternThread(taskId, task.Task, md, 'awaiting-spec'); return { awaitingSpec: true }; }
    await internClearAwaiting(task);
    // ONE attempt per direction: the drain never re-runs a task that already has an
    // attempt — only a fresh owner reply (or explicit /run) does.
    if (trigger === 'drain' && internAttempts(md) > 0) return { skipped: 'already attempted — waiting on owner' };
    const t0run = Date.now();
    let extraUsed = false;
    for (let iter = 0; iter < 2; iter++) {
      const raw = await runClaude(
        `You are "${tier.name}", an autonomous intern advancing ONE delegated task for your owner, conversationally (a dialogue thread, like a human assistant's task thread).\n` +
        `THE TASK: ${task.Task}\n\nTHE THREAD SO FAR (your past attempts + owner replies — owner replies are your directions):\n${md.slice(-14000)}\n\n` +
        `Advance the task CONCRETELY right now per the owner's directions: research with the tools, compute, draft, compare, verify — never merely restate a plan. If blocked on the owner, ask exactly what you need (crisp questions, never ones already answered in the thread).\n` +
        `GUARDRAILS: draft/queue/propose only — NEVER send email, move money, or change settings. No placeholders pretending to be results.\n` +
        `GMAIL + CALENDAR (owner-granted 2026-08-12, via curl): search threads: curl 'http://localhost:3000/api/gmail/threads?q=<gmail query>&max=10' ; read one: curl 'http://localhost:3000/api/gmail/thread/<id>' ; create a DRAFT (the only write that exists — there is no send endpoint, the never-send guarantee is structural): curl -X POST http://localhost:3000/api/gmail/draft -H 'Content-Type: application/json' -d '{"to":"…","subject":"…","body":"…","threadId":"optional"}' ; calendar: curl http://localhost:3000/api/calendar . If these are unreachable you are not on the owner's Mac — say so instead of guessing.\n` +
        `FORMAT — two parts, both mandatory:\n` +
        `SUMMARY:\n<the dashboard view — ONLY essential findings + questions for guidance, max ~8 short lines. No methodology, no padding.>\n` +
        `DETAILS:\n<everything else — full findings, sources, drafts, workings. This lives in the canonical md only.>\n` +
        `End with EXACTLY these two lines (both mandatory):\nSTATUS: advanced | blocked-on-owner | done-proposed\nOUTCOME: <ONE concrete sentence — what you actually produced, learned, or need; this is the line the owner sees in the collapsed history, so "drafted the MACIF note, needs receipt choice" not "made progress">\n` +
        `Then IF AND ONLY IF warranted, one more line from:\nCONTINUE (you can concretely advance further right now — you get at most one extra pass)\n` +
        `ESCALATE: thoroughbred|secretariat — <one line why a more capable tier would materially help>`,
        { tools: 'WebSearch,WebFetch,Bash(curl *)', timeoutMs: 300000, module: tier.module, model: tier.model });
      const reply = String(raw || '').trim();
      if (!reply) break;
      md += `\n\n-------\n**${tier.name} · ${today()} ${new Date().toTimeString().slice(0, 5)} · ${tier.model.replace(/-20\d{6}$/, '')}**\n\n${reply}`;
      const wantsMore = /\nCONTINUE\s*$/m.test(reply);
      if (!wantsMore || extraUsed) break;
      extraUsed = true; // the single self-granted extra iteration (in-run, owner-approved 2026-08-10)
    }
    recordInternRun(taskId, { at: nowIso(), startedAt: new Date(t0run).toISOString(), model: tier.model, module: tier.module, iters: extraUsed ? 2 : 1, trigger });
    const status = (md.match(/STATUS:\s*(advanced|blocked-on-owner|done-proposed)/g) || []).pop() || '';
    await writeInternThread(taskId, task.Task, md, status.replace('STATUS:', '').trim());
    await updateTaskById(taskId, { Updated: nowIso() }).catch(() => {});
    return { ok: true, status };
  } finally { internBusy.delete(taskId); }
}
async function internDrain() {
  // catch-up only: tag/AT-mint new unspec'd rows, and give spec'd-but-never-attempted rows
  // their single attempt (e.g. created while the server was down). NEVER a retry loop.
  try {
    const { rows } = await readTodoTab();
    const q3 = rows.filter(r => String(r.Status).trim().toLowerCase() === 'open' && String(r.Quadrant).trim() === 'Q3');
    for (const t of q3) {
      const md = readInternThread(t.ID);
      if (!internSpecd(t, md)) { if (!/awaiting-spec/.test(String(t.Tags || ''))) await internRun(t.ID, 'drain').catch(() => {}); continue; }
      if (internAttempts(md) === 0) await internRun(t.ID, 'drain').catch(e => console.error('internRun', t.ID, e.message));
    }
  } catch (e) { console.error('internDrain:', e.message); }
}
if ((HAS_CLAUDE || (CFG.llmRelayUrl && CFG.llmRelayKey)) && !process.env.DASHBOARD_NO_JOBS) {
  setTimeout(() => internDrain().catch(() => {}), 4 * 60000);
  setInterval(() => internDrain().catch(() => {}), 45 * 60000);
}
app.get('/api/intern/thread/:id', asyncRoute(async (req, res) => {
  // per-run stats for the thread header: attribute Usage rows to each recorded run by
  // module + time window (runs are serialized per task, so windows don't overlap)
  const runs = (internStats()[req.params.id] || []);
  // pre-sidecar runs: reconstruct from the md entry headers ('**Name · date time · model**')
  const mdText = readInternThread(req.params.id);
  const mdRuns = [];
  { const re = /\n\*\*([^·*]+) · (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · ([^*]+)\*\*/g; let m;
    while ((m = re.exec(mdText))) if (!/^Owner/.test(m[1].trim()))
      mdRuns.push({ at: `${m[2]}T${m[3]}:00`, startedAt: new Date(Date.parse(`${m[2]}T${m[3]}:00`) - 420000).toISOString(), model: m[4].trim(), module: /^intern/, iters: 1, fromMd: true }); }
  for (const r of mdRuns) if (!runs.some(x => Math.abs(new Date(x.at) - new Date(r.at)) < 600000)) runs.push(r);
  let stats = [];
  try {
    const urows = await usageRows();
    stats = runs.map(r => {
      const t0 = new Date(r.startedAt || r.at).getTime(), t1 = new Date(r.at).getTime() + 600000;
      const modMatch = u => r.fromMd ? /^intern/.test(u.module) : u.module === r.module;
      const mine = urows.filter(u => modMatch(u) && new Date(u.at).getTime() >= t0 && new Date(u.at).getTime() <= t1);
      const input = mine.reduce((n, u) => n + u.input, 0), output = mine.reduce((n, u) => n + u.output, 0);
      let cost = mine.reduce((n, u) => n + u.costUsd, 0);
      const p = priceOf(r.model); if (!cost && p) cost = (input * p.in + output * p.out) / 1e6;
      return { at: r.at, model: String(r.model).replace(/-20\d{6}$/, ''), iters: r.iters || 1, input, output,
        costUsd: Math.round(cost * 1000) / 1000, cls: costClass(r.model, r.fromMd ? 'intern-cheap' : r.module, r.at) };
    });
  } catch (e) {}
  let atId = '';
  try { const { rows } = await readTodoTab(); atId = String((rows.find(t => t.ID === req.params.id) || {}).AgentTask || '').replace(/^.*"(AT\d+)".*$/, '$1'); } catch (e) {}
  const local = readInternThread(req.params.id);
  if (local) return res.json({ id: req.params.id, md: local, source: 'file', stats, atId });
  try { // cross-tier: the sheet mirror
    const { rows } = await readTabCached(TODO_SHEET_ID, ITHREADS_TAB, ITHREADS_HEADERS, 20000);
    const hit = rows.find(r => r.ID === req.params.id);
    if (hit) return res.json({ id: req.params.id, md: hit.Thread || '', status: hit.Status, source: 'sheet' });
  } catch (e) {}
  res.json({ id: req.params.id, md: '' });
}));
app.post('/api/intern/reply/:id', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!HAS_CLAUDE && !(CFG.llmRelayUrl && CFG.llmRelayKey)) { // phone tier: park it, the Mac drains + runs
    const id = await enqueueRpc('intern-reply', { id: req.params.id, text });
    return res.json({ ok: true, queued: true, id });
  }
  const { rows } = await readTodoTab();
  const task = rows.find(r => r.ID === req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  let md = readInternThread(req.params.id) || `# ${task.Task}\n`;
  md += `\n\n-------\n**Owner · ${today()} ${new Date().toTimeString().slice(0, 5)}**\n\n${text}`;
  await writeInternThread(req.params.id, task.Task, md, 'owner-replied');
  setTimeout(() => internRun(req.params.id, 'owner-reply').catch(() => {}), 100); // recursion is immediate
  res.json({ ok: true });
}));
app.post('/api/intern/run/:id', asyncRoute(async (req, res) => res.json(await internRun(req.params.id, 'manual'))));

// ---------- Journal widget (core, 2026-08-10) ----------
// A dashboard-native daily journal for deployments without an Obsidian vault (the vault
// journal above stays the owner-of-record wherever HAS_JOURNAL). Config lives in
// settings.journal: { enabled, fields:[{key,label,track}], sections:[{key,title,stash,familyLog}] }.
// Defaults: OFF, and entries land in the datastore 'Journal' tab — Date + one COLUMN per
// section (owner decree). stash per section: 'column' (default) | 'folder' (obsidian-shaped
// data/journal/YYYY-MM-DD.md) | 'file' (agglomerated single md). Header fields marked
// track:true also upsert 'Journal Tracking' rows (Date + one row per tracked item), which is
// the graphable long-term store. Agents read GET /api/journal/scrape — todos + the
// agent-feedback section (issue tracking = the same AT### /api/agent-tasks machinery).
const JOURNAL_TAB = 'Journal';
const JTRACK_TAB = 'Journal Tracking';
const JTRACK_HEADERS = ['Date', 'Item', 'Value', 'At'];
const JOURNAL_DEFAULTS = {
  enabled: false,
  fields: [{ key: 'mood', label: 'Mood', track: true }, { key: 'energy', label: 'Energy', track: true }],
  sections: [{ key: 'journal', title: 'Journal', stash: 'column' },
             { key: 'todo', title: 'Todo', stash: 'column' },
             { key: 'agent-feedback', title: 'Agent Feedback', stash: 'column' }],
};
function journalCfg() {
  const j = (loadSettings().journal || {});
  const fields = (Array.isArray(j.fields) ? j.fields : JOURNAL_DEFAULTS.fields)
    .filter(f => f && f.key).slice(0, 12)
    .map(f => ({ key: String(f.key).slice(0, 30), label: String(f.label || f.key).slice(0, 40), track: !!f.track }));
  const sections = (Array.isArray(j.sections) ? j.sections : JOURNAL_DEFAULTS.sections)
    .filter(x => x && x.key).slice(0, 10)
    .map(x => ({ key: String(x.key).slice(0, 30), title: String(x.title || x.key).slice(0, 60),
      stash: ['column', 'folder', 'file'].includes(x.stash) ? x.stash : 'column', familyLog: !!x.familyLog }));
  return { enabled: !!j.enabled, fields, sections };
}
const JR_DIR = CFG.journalStashDir || path.join(__dirname, 'data', 'journal');
const JR_FILE = CFG.journalStashFile || path.join(__dirname, 'data', 'journal.md');
async function journalHeaders(cfg) {
  // dynamic columns: Date | <one per section title> | Fields (JSON) | Updated.
  // The header row self-extends when a new section is configured; existing columns never move.
  const want = ['Date', ...cfg.sections.map(x => x.title), 'Fields', 'Updated'];
  await ensureTab(JOURNAL_TAB, want);
  const { headers, headerRow } = await readTab(TODO_SHEET_ID, JOURNAL_TAB, ['Date']);
  const missing = want.filter(h => !headers.includes(h));
  if (missing.length) {
    const all = [...headers, ...missing];
    await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${JOURNAL_TAB}'!A${headerRow}:${colLetter(all.length - 1)}${headerRow}`,
      valueInputOption: 'RAW', requestBody: { values: [all] } });
    return all;
  }
  return headers;
}
function jrMdRender(date, cfg, fields, sections, routed) {
  const fm = Object.entries(fields).filter(([, v]) => String(v).trim() !== '')
    .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`).join('\n');
  const body = routed.map(sec => `## ${sec.title}\n\n${(sections[sec.key] || '').trim()}\n`).join('\n');
  return `+++\ndate = "${date}"\n${fm}\n+++\n\n${body}`;
}
function jrStashMd(date, cfg, fields, sections) {
  const toFolder = cfg.sections.filter(x => x.stash === 'folder');
  const toFile = cfg.sections.filter(x => x.stash === 'file');
  if (toFolder.length) {
    fs.mkdirSync(JR_DIR, { recursive: true });
    fs.writeFileSync(path.join(JR_DIR, date + '.md'), jrMdRender(date, cfg, fields, sections, toFolder));
  }
  if (toFile.length) {
    // agglomerate: one file, one '# YYYY-MM-DD' block per day, replaced in place on re-save
    let txt = ''; try { txt = fs.readFileSync(JR_FILE, 'utf8'); } catch (e) {}
    const blk = `# ${date}\n\n` + toFile.map(sec => `## ${sec.title}\n\n${(sections[sec.key] || '').trim()}\n`).join('\n');
    const re = new RegExp(`(^|\\n)# ${date}\\n[\\s\\S]*?(?=\\n# \\d{4}-\\d{2}-\\d{2}\\n|$)`);
    txt = re.test(txt) ? txt.replace(re, (m, p1) => p1 + blk) : (txt ? txt.replace(/\n*$/, '\n\n') : '') + blk;
    fs.writeFileSync(JR_FILE, txt);
  }
}
app.get('/api/journal/day', asyncRoute(async (req, res) => {
  const cfg = journalCfg();
  if (!cfg.enabled) return res.status(404).json({ error: 'journal disabled on this deployment' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : today();
  let row = null;
  try { row = (await readTab(TODO_SHEET_ID, JOURNAL_TAB, ['Date'])).rows.find(r => r.Date === date) || null; }
  catch (e) {} // tab not created yet = empty day
  let fields = {}; try { fields = JSON.parse((row || {}).Fields || '{}'); } catch (e) {}
  const sections = {};
  for (const x of cfg.sections) sections[x.key] = (row || {})[x.title] || '';
  res.json({ date, cfg, fields, sections });
}));
app.post('/api/journal/day', asyncRoute(async (req, res) => {
  const cfg = journalCfg();
  if (!cfg.enabled) return res.status(404).json({ error: 'journal disabled on this deployment' });
  const { date: d, fields = {}, sections = {} } = req.body || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : today();
  const headers = await journalHeaders(cfg);
  const { rows, headerRow } = await readTab(TODO_SHEET_ID, JOURNAL_TAB, ['Date']);
  const vals = headers.map(h => {
    if (h === 'Date') return date;
    if (h === 'Fields') return JSON.stringify(Object.fromEntries(cfg.fields.map(f => [f.key, String(fields[f.key] ?? '')]))).slice(0, 4000);
    if (h === 'Updated') return nowIso();
    const sec = cfg.sections.find(x => x.title === h);
    return sec ? String(sections[sec.key] ?? '').slice(0, 20000) : null; // null = leave unknown columns alone
  });
  const existing = rows.find(r => r.Date === date);
  if (existing) {
    const data = vals.map((v, i) => v === null ? null : ({ range: `'${JOURNAL_TAB}'!${colLetter(i)}${existing._row}`, values: [[v]] })).filter(Boolean);
    await store.values.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
  } else {
    await appendTabRows(JOURNAL_TAB, headers, [vals.map(v => v === null ? '' : v)]);
  }
  // tracked header fields -> one row per item per day (upsert, so edits do not duplicate)
  const tracked = cfg.fields.filter(f => f.track && String(fields[f.key] ?? '').trim() !== '');
  if (tracked.length) {
    await ensureTab(JTRACK_TAB, JTRACK_HEADERS);
    const t = await readTab(TODO_SHEET_ID, JTRACK_TAB, JTRACK_HEADERS);
    const upd = [], add = [];
    for (const f of tracked) {
      const v = String(fields[f.key]).slice(0, 200);
      const hit = t.rows.find(r => r.Date === date && r.Item === f.key);
      if (hit && hit.Value !== v) upd.push({ range: `'${JTRACK_TAB}'!${colLetter(2)}${hit._row}`, values: [[v]] }, { range: `'${JTRACK_TAB}'!${colLetter(3)}${hit._row}`, values: [[nowIso()]] });
      else if (!hit) add.push([date, f.key, v, nowIso()]);
    }
    if (upd.length) await store.values.batchUpdate({ spreadsheetId: TODO_SHEET_ID, requestBody: { valueInputOption: 'RAW', data: upd } });
    if (add.length) await appendTabRows(JTRACK_TAB, JTRACK_HEADERS, add);
  }
  try { jrStashMd(date, cfg, fields, sections); } catch (e) { console.error('journal md stash:', e.message); }
  _tabCache.delete(TODO_SHEET_ID + '|' + JOURNAL_TAB);
  res.json({ ok: true, date });
}));
// Agent surface: todos + agent-feedback across the last N days. Issue tracking rides the
// existing AT### store — agents mint/close via /api/agent-tasks and reference IDs in the
// feedback text, exactly like the owner-side protocol.
app.get('/api/journal/scrape', asyncRoute(async (req, res) => {
  const cfg = journalCfg();
  if (!cfg.enabled) return res.json({ enabled: false, days: [] });
  const since = new Date(Date.now() - (parseInt(req.query.days, 10) || 7) * 864e5).toISOString().slice(0, 10);
  let rows = []; try { rows = (await readTabCached(TODO_SHEET_ID, JOURNAL_TAB, ['Date'], 60000)).rows; } catch (e) {}
  const afSec = cfg.sections.find(x => x.key === 'agent-feedback') || null;
  const days = rows.filter(r => r.Date >= since).sort((a, b) => a.Date.localeCompare(b.Date)).map(r => {
    const sections = {}; for (const x of cfg.sections) sections[x.key] = r[x.title] || '';
    const todos = Object.values(sections).join('\n').split('\n')
      .filter(l => /^\s*[-*]\s*\[ \]|#todo\b/i.test(l)).map(l => l.replace(/^\s*[-*]\s*\[ \]\s*/, '').trim());
    let fields = {}; try { fields = JSON.parse(r.Fields || '{}'); } catch (e) {}
    return { date: r.Date, fields, todos, agentFeedback: afSec ? (sections[afSec.key] || '') : '', sections };
  });
  res.json({ enabled: true, cfg, days });
}));
app.get('/api/journal-lists', asyncRoute(async (req, res) => res.json({ lists: await elistsPayload() })));
app.post('/api/journal-lists/scan', asyncRoute(async (req, res) => {
  if (!HAS_JOURNAL) return res.status(400).json({ error: 'journal scanning runs on the vault host' });
  await scanJournalLists();
  res.json({ ok: true, lists: await elistsPayload() });
}));
app.post('/api/journal-lists/:id/dismiss', asyncRoute(async (req, res) => {
  const slug = String(req.params.id).replace(/^jl:/, '');
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === slug);
  if (!l) return res.status(404).json({ error: 'list not found' });
  await elistsSetHeader2(l, 'completed ' + elistDDMMYY());
  res.json({ ok: true });
}));
app.post('/api/journal-lists/:id/restore', asyncRoute(async (req, res) => { // undo of a complete
  const slug = String(req.params.id).replace(/^jl:/, '');
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === slug);
  if (!l) return res.status(404).json({ error: 'list not found' });
  await elistsSetHeader2(l, l.persistent ? 'done (persistent)' : 'done');
  res.json({ ok: true, lists: await elistsPayload() });
}));
app.post('/api/journal-lists/:id/item', asyncRoute(async (req, res) => {
  const { text, done } = req.body || {};
  const slug = String(req.params.id).replace(/^jl:/, '');
  const shared = sharedCfgOf(slug);
  if (shared) {
    const { items } = await sharedListRead(shared.sheetId, shared.tab || slug);
    const it = items.find(i => i.text === text);
    if (!it) return res.status(404).json({ error: 'item not found' });
    await sharedListSetMark(shared.sheetId, shared.tab || slug, it.row, done ? 'Y' : '');
    return res.json({ ok: true });
  }
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === slug);
  if (!l) return res.status(404).json({ error: 'list not found' });
  const item = l.items.find(i => i.text === text);
  if (!item) return res.status(404).json({ error: 'item not found' });
  await elistsSetMark(l, item.row, done ? 'Y' : '');   // owner check overrides any doer mark
  // all owner-checked → auto-complete the list ("collectively checked off")
  if (done && l.items.every(i => i.text === text || i.mark === 'Y') && !l.persistent)
    await elistsSetHeader2(l, 'completed ' + elistDDMMYY());
  res.json({ ok: true });
}));

// ---- shared lists on an EXTERNAL spreadsheet (family datastore) ----
// listShares[slug] may carry {sheetId, tab}: the list then lives on that sheet's tab —
// items in A:B (Item | done/'D'/'Y'), comments log in D:G (At | Item | From | Text). One
// tab = one list + its conversation, shareable sheet-level with family members.
// Columns H:J (Due | Tags | ID) carry task metadata so a shared list can be a full Task
// List — recurrence and due dates per entry. The EXTERNAL contract is A:B + D:G only, so
// adding these can never disturb a helper agent reading the list.
async function sharedListRead(sheetId, tab) {
  // K:M are the doer-side occurrence columns (see sharedListSetDoerCols): when the doer
  // last reported this row, when its current occurrence began, and the dates of the
  // occurrences already closed. The mark alone can say neither *when* nor *which round*.
  const r = await store.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:M300` }).catch(() => null);
  const grid = (r && r.data.values) || [];
  const items = [], comments = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const text = String(row[0] || '').trim();
    if (text) items.push({ row: i + 1, text, mark: String(row[1] || '').trim().toUpperCase(), photo: String(row[2] || '').trim(),
      due: String(row[7] || '').trim(), tags: String(row[8] || '').trim(), uid: String(row[9] || '').trim(),
      reportedOn: String(row[10] || '').trim(), occFrom: String(row[11] || '').trim(),
      doneLog: String(row[12] || '').trim() });
    if (String(row[3] || '').trim() || String(row[6] || '').trim())
      comments.push({ row: i + 1, At: row[3] || '', Item: row[4] || '', From: row[5] || '', Text: row[6] || '' });
  }
  return { items, comments };
}
async function sharedListEnsureHeaders(sheetId, tab) {
  await store.values.update({ spreadsheetId: sheetId, range: `'${tab}'!A1:J1`, valueInputOption: 'RAW',
    requestBody: { values: [['Item', 'done', '', 'At', 'Item', 'From', 'Text', 'Due', 'Tags', 'ID']] } }).catch(() => {});
}
async function sharedListSetMark(sheetId, tab, row, mark) {
  await store.values.update({ spreadsheetId: sheetId, range: `'${tab}'!B${row}`, valueInputOption: 'RAW', requestBody: { values: [[mark]] } });
}
// Doer-side occurrence columns, all outside the external A:B + D:G contract and outside
// the task metadata in H:J, so nothing else on the sheet notices them:
//   K ReportedOn     — date the doer last reported this row done ('' = not reported)
//   L OccurrenceFrom — date the CURRENT round began; comments older than it are history
//   M DoneLog        — comma-separated dates of rounds already closed (completion history)
// They exist because "done" is a day-scoped fact, and a recurring row's conversation must
// not follow it into the next occurrence.
async function sharedListSetDoerCols(sheetId, tab, row, cols) {
  const data = [];
  if (cols.reportedOn !== undefined) data.push({ range: `'${tab}'!K${row}`, values: [[cols.reportedOn]] });
  if (cols.occFrom !== undefined) data.push({ range: `'${tab}'!L${row}`, values: [[cols.occFrom]] });
  if (cols.doneLog !== undefined) data.push({ range: `'${tab}'!M${row}`, values: [[cols.doneLog]] });
  if (data.length) await store.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data } }).catch(() => {});
}
// just the report stamp — what both doer paths (this page, the token bridge) reach for
const sharedListSetReported = (sheetId, tab, row, date) => sharedListSetDoerCols(sheetId, tab, row, { reportedOn: date });
async function sharedListAddItem(sheetId, tab, text, meta) {
  const { items } = await sharedListRead(sheetId, tab);
  const row = (items.length ? Math.max(...items.map(i => i.row)) : 1) + 1;
  await store.values.update({ spreadsheetId: sheetId, range: `'${tab}'!A${row}`, valueInputOption: 'RAW', requestBody: { values: [[text]] } });
  if (meta) await store.values.update({ spreadsheetId: sheetId, range: `'${tab}'!H${row}:J${row}`, valueInputOption: 'RAW',
    requestBody: { values: [[meta.due || '', meta.tags || '', meta.uid || crypto.randomUUID()]] } });
  return row;
}
// write named task fields onto a shared row (Task→A, done→B, Due→H, Tags→I)
async function sharedListSetTask(sheetId, tab, row, changes) {
  const data = [];
  const cell = (col, v) => data.push({ range: `'${tab}'!${col}${row}`, values: [[v]] });
  if (changes.Task !== undefined) cell('A', changes.Task);
  if (changes.Status !== undefined) cell('B', changes.Status === 'done' ? 'Y' : '');
  if (changes.Due !== undefined) cell('H', changes.Due);
  if (changes.Tags !== undefined) cell('I', changes.Tags);
  if (data.length) await store.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data } });
}
// remove = clear the item's own cells; the comment log in D:G is history and stays
async function sharedListClearRow(sheetId, tab, row) {
  await store.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: 'RAW', data: [
    { range: `'${tab}'!A${row}:B${row}`, values: [['', '']] },
    { range: `'${tab}'!H${row}:J${row}`, values: [['', '', '']] },
  ] } });
}
async function sharedListAddComment(sheetId, tab, item, from, text) {
  const { items, comments } = await sharedListRead(sheetId, tab);
  // the next free row is past every row actually in use — deriving it from each comment's
  // POSITION in the array instead of its row number lands the write on top of an existing
  // comment as soon as the log has gaps (it silently overwrote a question, 2026-08-01)
  const row = Math.max(1, ...items.map(i => i.row), ...comments.map(c => c.row)) + 1;
  await store.values.update({ spreadsheetId: sheetId, range: `'${tab}'!D${row}:G${row}`, valueInputOption: 'RAW',
    requestBody: { values: [[nowIso(), item || '', from, text]] } });
}
const sharedCfgOf = slug => { const v = (loadSettings().listShares || {})[slug]; return v && v.sheetId ? v : null; };

// ---- a Task List backed by a shared tab ----
// settings.quadrants[key].share = <listShares slug> promotes a shared list out of Ephemeral
// notes into a real Task List: its entries become tasks (due dates, recurrence, the ⇄/🔁
// popover) while still living on the family sheet where the other party — and any helper
// agent — reads them. Task IDs are positional (`sh:<slug>:<row>`), resolved at write time.
function sharedBinds() {
  return Object.entries(loadSettings().quadrants || {})
    .map(([key, q]) => (q && q.share && sharedCfgOf(q.share)) ? { key, slug: q.share, cfg: sharedCfgOf(q.share) } : null)
    .filter(Boolean);
}
const sharedBindOfKey = key => sharedBinds().find(b => b.key === String(key || '').toUpperCase().trim() || b.key === key);
function parseSharedId(id) {
  const m = String(id || '').match(/^sh:([^:]+):(\d+)$/);
  if (!m) return null;
  const cfg = sharedCfgOf(m[1]);
  return cfg ? { slug: m[1], cfg, tab: cfg.tab || m[1], row: +m[2] } : null;
}
// shared rows rendered in the Todo-row shape the whole app already speaks
async function sharedTasksFor(bind) {
  const tab = bind.cfg.tab || bind.slug;
  const { items, comments } = await sharedListRead(bind.cfg.sheetId, tab);
  const tr = await translateForDisplay([...items.map(i => i.text), ...comments.map(c => c.Text)]);
  const disp = x => tr[x] || x;
  const t = today();
  const out = [];
  for (const i of items) {
    // same rollover as the doer's page (ranmaliRollsOver) — whichever surface reads
    // first after a round closes does the reset, so all three stay in step
    if (ranmaliRollsOver(i, t)) {
      const log = (i.doneLog ? i.doneLog.split(',') : []).map(s => s.trim()).filter(Boolean);
      log.push(i.reportedOn);
      const occFrom = (i.due && i.due > i.reportedOn) ? i.due : t;
      await sharedListSetMark(bind.cfg.sheetId, tab, i.row, '');
      await sharedListSetDoerCols(bind.cfg.sheetId, tab, i.row, { reportedOn: '', occFrom, doneLog: log.slice(-30).join(',') });
      Object.assign(i, { mark: '', reportedOn: '', occFrom, doneLog: log.slice(-30).join(',') });
    }
    const mine = comments.filter(c => c.Item === i.text || !c.Item).map(c => ({ from: c.From, text: disp(c.Text), at: c.At }));
    const past = i.occFrom ? mine.filter(c => String(c.at || '').slice(0, 10) < i.occFrom) : [];
    const now = i.occFrom ? mine.filter(c => !(String(c.at || '').slice(0, 10) < i.occFrom)) : mine;
    const doneLog = (i.doneLog || '').split(',').map(s => s.trim()).filter(Boolean);
    out.push({
      ID: `sh:${bind.slug}:${i.row}`, Task: disp(i.text), TaskOrig: tr[i.text] ? i.text : undefined, Quadrant: bind.key,
      Status: i.mark === 'Y' ? 'done' : 'Open', Due: i.due || '', Tags: i.tags || '',
      Scope: 'Shared', Owner: bind.cfg.name || '', Notes: '', Created: '', Updated: '',
      Source: 'shared', Order: '', Parent: '',
      doerDone: i.mark === 'D', reportedOn: i.reportedOn || '',
      lastDone: doneLog[doneLog.length - 1] || '', // greys a recurring row between rounds
      comments: now,
      history: (past.length || doneLog.length) ? { comments: past, done: doneLog } : null,
    });
  }
  return out;
}
async function sharedTasksAll() {
  const out = [];
  for (const b of sharedBinds()) { try { out.push(...await sharedTasksFor(b)); } catch (e) {} }
  return out;
}

// ---- shared-list bridge: token-authed access for EXTERNAL helpers/agents ----
// settings.listShares = { slug: { token, name } } (owner-managed). Contract: the external
// side can READ, mark an item doer-complete ('D' — the owner still checks it off), or leave
// a comment/question. It can never check items off, edit texts, or see anything else.
const shareOf = token => Object.entries(loadSettings().listShares || {}).find(([, v]) => v && v.token === token);
app.get('/api/elists/ext/:token', asyncRoute(async (req, res) => {
  const hit = shareOf(String(req.params.token || ''));
  if (!hit) return res.status(404).json({ error: 'unknown share' });
  const cfg = sharedCfgOf(hit[0]);
  const list = cfg ? await sharedListView(hit[0], cfg) : (await elistsPayload()).find(l => l.id === 'jl:' + hit[0]);
  if (!list) return res.status(404).json({ error: 'list inactive' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ list: list.heading, items: list.items.map(i => ({ item: i.text, status: i.done ? 'done' : i.doer ? 'reported-complete' : 'open', comments: i.comments })) });
}));
app.post('/api/elists/ext/:token/complete', asyncRoute(async (req, res) => {
  const hit = shareOf(String(req.params.token || ''));
  if (!hit) return res.status(404).json({ error: 'unknown share' });
  const want = String((req.body || {}).item || '');
  const shared = sharedCfgOf(hit[0]);
  if (shared) {
    const { items } = await sharedListRead(shared.sheetId, shared.tab || hit[0]);
    const it = items.find(i => i.text === want);
    if (!it) return res.status(404).json({ error: 'item not found — GET the list for exact item texts' });
    if (it.mark !== 'Y') {
      await sharedListSetMark(shared.sheetId, shared.tab || hit[0], it.row, 'D');
      await sharedListSetReported(shared.sheetId, shared.tab || hit[0], it.row, today()); // K: when the doer said so
      // recurring row: the report closes THIS round, so Due advances now — the owners'
      // dashboards grey it out "until next due" off that very date
      const rule = parseRecurTag(it.tags);
      if (rule) await sharedListSetTask(shared.sheetId, shared.tab || hit[0], it.row, { Due: nextRecurDate(rule, today()) });
    }
    return res.json({ ok: true, status: 'reported-complete' });
  }
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === hit[0]);
  const item = l && l.items.find(i => i.text === want);
  if (!item) return res.status(404).json({ error: 'item not found — GET the list for exact item texts' });
  if (item.mark !== 'Y') await elistsSetMark(l, item.row, 'D'); // never downgrade an owner check
  res.json({ ok: true, status: 'reported-complete' });
}));
app.post('/api/elists/ext/:token/comment', asyncRoute(async (req, res) => {
  const hit = shareOf(String(req.params.token || ''));
  if (!hit) return res.status(404).json({ error: 'unknown share' });
  const from = String((req.body || {}).from || (loadSettings().listShares[hit[0]].name || 'helper')).slice(0, 40);
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const shared = sharedCfgOf(hit[0]);
  if (shared) { await sharedListAddComment(shared.sheetId, shared.tab || hit[0], String((req.body || {}).item || '').slice(0, 200), from, text); return res.json({ ok: true }); }
  await appendTabRow(ELIST_COMMENTS_TAB, ELIST_COMMENTS_HEADERS, [nowIso(), hit[0], String((req.body || {}).item || '').slice(0, 200), from, text]);
  res.json({ ok: true });
}));
// LLM-parsed / agentic list creation from the quick-note bar: "moulin todo: water
// plants, close gate" → checklist; "create a checklist for camping in the desert" →
// generated items; a URL in the request → the model fetches it first (web tools).
app.post('/api/enotes/make-list', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  let name, items;
  const m = /^([^:]{2,60}):\s*(.+)$/.exec(text);
  if (m && /[,;]/.test(m[2]) && !/https?:\/\/|www\./i.test(text)) {
    name = m[1].trim();
    items = m[2].split(/[,;]/).map(x => x.trim()).filter(Boolean);
  } else {
    const hasUrl = /https?:\/\/|www\./i.test(text);
    const prompt = 'Turn this request into a checklist. Reply with ONLY JSON: {"name":"...","items":["..."]}. '
      + 'Max 25 items. Items the user dictated keep their exact wording and language; for generative requests invent sensible, concrete items.'
      + (hasUrl ? ' The request references a website — fetch it and base the items on its ACTUAL content (e.g. a school supply list), not guesses.' : '')
      + '\nRequest: ' + JSON.stringify(text);
    const raw = await runClaude(prompt, { module: 'note-list', timeoutMs: hasUrl ? 110000 : 45000, ...(hasUrl ? { tools: 'WebFetch WebSearch' } : {}) });
    let j = null; try { j = JSON.parse((raw.match(/\{[\s\S]*\}/) || [''])[0]); } catch (e) {}
    if (!j || !j.name || !Array.isArray(j.items) || !j.items.length)
      return res.json({ ok: false, error: "couldn't turn that into a list" });
    name = String(j.name).slice(0, 60);
    items = j.items.map(x => String(x).slice(0, 200)).slice(0, 25);
  }
  await elistsCreate(name, items);
  res.json({ ok: true, name, count: items.length });
}));
// owner-side add-item (the ＋ input on each list box)
app.post('/api/journal-lists/:id/add', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required' });
  const slug = String(req.params.id).replace(/^jl:/, '');
  const shared = sharedCfgOf(slug);
  if (shared) { await sharedListAddItem(shared.sheetId, shared.tab || slug, text); return res.json({ ok: true }); }
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === slug);
  if (!l) return res.status(404).json({ error: 'list not found' });
  await elistsAppendItems(l, [text]);
  res.json({ ok: true });
}));
// owner-side REPLY to a doer's question. Same comment log the doer writes to, so the
// answer lands directly under her question (the log is read in time order per item) and
// shows on both her page and this dashboard. Owner-gated: guests never reach /api/journal-lists/*.
app.post('/api/journal-lists/:id/comment', asyncRoute(async (req, res) => {
  const slug = String(req.params.id).replace(/^jl:/, '');
  const item = String((req.body || {}).item || '').slice(0, 200);
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  const from = String((req.body || {}).from || CFG.userName || 'David').slice(0, 40);
  if (!text) return res.status(400).json({ error: 'text required' });
  const shared = sharedCfgOf(slug);
  if (shared) await sharedListAddComment(shared.sheetId, shared.tab || slug, item, from, text);
  else await appendTabRow(ELIST_COMMENTS_TAB, ELIST_COMMENTS_HEADERS, [nowIso(), slug, item, from, text]);
  res.json({ ok: true, from });
}));

// ---- Ranmali task checklist: session-authed view of lists shared to "Ranmali" ----
// David creates/fills lists on his dashboard and shares them (settings.listShares entries
// whose name is "Ranmali"); the /ranmali page renders every such active list above the
// clothes section. Same contract as the token bridge — she can report an item complete
// ('D', undoable while un-confirmed) and comment; only David checks items off ('Y').
// Session-gated by the ranmali guest scope; no share token ever reaches her client.
const ranmaliShareSlugs = () => new Set(Object.entries(loadSettings().listShares || {})
  .filter(([, v]) => v && /^ranmali$/i.test(String(v.name || '').trim()))
  .map(([slug]) => slug));
// A round of a task is over once she has reported it AND the day has turned — for a
// recurring row, or one whose Due has since moved on, the next round starts clean.
// Closing it here (rather than at read time on her page) is what makes the reset real:
// the mark clears, the completion is logged to M, and L starts a fresh comment window so
// last time's conversation does not come back with the task.
function ranmaliRollsOver(i, t) {
  if (i.mark !== 'D' || !i.reportedOn || i.reportedOn >= t) return false;
  return !!parseRecurTag(i.tags) || !!(i.due && i.due > i.reportedOn);
}
// What her page shows for one shared row, or null when it should not appear at all.
// Runs AFTER any rollover above, so a 'D' still standing means "reported, this round".
//   · reported/confirmed today → today's box, checked (stays all day, gone at midnight)
//   · reported/confirmed on an earlier round → hidden (David's dashboard owns the history)
//   · otherwise → open, grouped by Due: ≤today, or 1–3 days ahead
function ranmaliItemView(i, t) {
  const dnum = s => Date.parse(s + 'T00:00:00Z');
  const due = i.due || '', rep = i.reportedOn || '', mark = i.mark;
  if ((mark === 'D' || mark === 'Y') && (rep === t || (mark === 'Y' && due === t)))
    return { day: 0, status: mark === 'Y' ? 'confirmed' : 'reported', late: false };
  if (mark === 'Y' || mark === 'D') return null;
  const d = due ? Math.round((dnum(due) - dnum(t)) / 864e5) : 0;
  if (d > 3) {
    // recurring rows never vanish between rounds: they rest — faded, green-checked, with
    // the last performed date — until the next occurrence comes back inside the horizon
    if (parseRecurTag(i.tags)) {
      const log = String(i.doneLog || '').split(',').map(x => x.trim()).filter(Boolean);
      const last = log[log.length - 1] || rep;
      if (last) return { day: 0, status: 'rested', late: false, lastDone: last };
    }
    return null;
  }
  // a recurring row whose Due is stale means David has not confirmed yet — his lag is
  // not her lateness, so the red chip is for one-off work only
  return { day: Math.max(0, d), status: 'open', late: d < 0 && !parseRecurTag(i.tags) };
}
app.get('/api/ranmali/tasks', asyncRoute(async (req, res) => {
  // Promoted shares (listShares[slug].sheetId — a real Task List on the family sheet)
  // carry Due/Tags per row: today's work plus a 3-day look-ahead.
  // Un-promoted shares still come from Ephemeral Lists (undated → all "today", no expiry).
  const t = today();
  const lists = [];
  let elists = null; // lazy — only read the tab if some share is un-promoted
  for (const slug of ranmaliShareSlugs()) {
    const cfg = sharedCfgOf(slug);
    if (cfg) {
      const tab = cfg.tab || slug;
      const { items, comments } = await sharedListRead(cfg.sheetId, tab);
      const shown = [];
      for (const i of items) {
        // A 'D' with no date is a report from a path that did not stamp K (a helper agent
        // writing the sheet, a hand edit, an older build). Read it as "reported today"
        // rather than letting the row vanish: unseen work is the one failure that matters.
        if (i.mark === 'D' && !i.reportedOn) {
          await sharedListSetDoerCols(cfg.sheetId, tab, i.row, { reportedOn: t });
          i.reportedOn = t;
        }
        if (ranmaliRollsOver(i, t)) {
          const log = (i.doneLog ? i.doneLog.split(',') : []).map(s => s.trim()).filter(Boolean);
          log.push(i.reportedOn);
          const occFrom = (i.due && i.due > i.reportedOn) ? i.due : t;
          await sharedListSetMark(cfg.sheetId, tab, i.row, '');
          await sharedListSetDoerCols(cfg.sheetId, tab, i.row, { reportedOn: '', occFrom, doneLog: log.slice(-30).join(',') });
          Object.assign(i, { mark: '', reportedOn: '', occFrom, doneLog: log.slice(-30).join(',') });
        }
        const v = ranmaliItemView(i, t);
        if (!v) continue;
        // this round's conversation stays inline; everything older folds into history
        const mine = comments.filter(c => c.Item === i.text || !c.Item)
          .map(c => ({ from: c.From, text: c.Text, at: c.At }));
        const past = i.occFrom ? mine.filter(c => String(c.at || '').slice(0, 10) < i.occFrom) : [];
        const now = i.occFrom ? mine.filter(c => !(String(c.at || '').slice(0, 10) < i.occFrom)) : mine;
        const doneLog = (i.doneLog || '').split(',').map(s => s.trim()).filter(Boolean);
        shown.push({ text: i.text, si: '', photo: i.photo || '', due: i.due || '', ...v, comments: now,
          history: (past.length || doneLog.length) ? { comments: past, done: doneLog } : null });
      }
      // translated on the helper's page only — owner/guest pages keep the text as typed
      // (their surface translates to en/fr, and en↔fr never cross). Rendered
      // Sinhala-first with the original beneath, the shape she already knows.
      const si = await translateForDisplay(shown.map(x => x.text), 'si');
      for (const x of shown) x.si = si[x.text] || '';
      lists.push({ id: slug, heading: cfg.label || (cfg.name ? cfg.name + ' tasks' : slug), items: shown });
    } else {
      if (!elists) elists = await elistsPayload();
      const l = elists.find(x => x.id === 'jl:' + slug);
      if (l) lists.push({ id: slug, heading: l.heading,
        items: l.items.map(i => ({ text: i.text, due: '', day: 0, late: false,
          status: i.done ? 'confirmed' : i.doer ? 'reported' : 'open', comments: i.comments })) });
    }
  }
  res.json({ today: t, lists });
}));
app.post('/api/ranmali/tasks/report', asyncRoute(async (req, res) => {
  const { list, item, undo } = req.body || {};
  if (!ranmaliShareSlugs().has(String(list))) return res.status(404).json({ error: 'list not shared' });
  const want = String(item || '');
  const cfg = sharedCfgOf(String(list));
  if (cfg) {
    const tab = cfg.tab || String(list);
    const { items } = await sharedListRead(cfg.sheetId, tab);
    const it = items.find(i => i.text === want);
    if (!it) return res.status(404).json({ error: 'item not found' });
    if (it.mark === 'Y') return res.json({ ok: true, status: 'confirmed' }); // owner check is final
    await sharedListSetMark(cfg.sheetId, tab, it.row, undo ? '' : 'D');
    await sharedListSetReported(cfg.sheetId, tab, it.row, undo ? '' : today());
    return res.json({ ok: true, status: undo ? 'open' : 'reported' });
  }
  const { lists } = await elistsRead();
  const l = lists.find(x => x.slug === String(list) && !x.completedAt);
  const it = l && l.items.find(i => i.text === want);
  if (!it) return res.status(404).json({ error: 'item not found' });
  if (it.mark === 'Y') return res.json({ ok: true, status: 'confirmed' }); // owner check is final
  await elistsSetMark(l, it.row, undo ? '' : 'D');
  res.json({ ok: true, status: undo ? 'open' : 'reported' });
}));
app.post('/api/ranmali/tasks/comment', asyncRoute(async (req, res) => {
  const { list, item } = req.body || {};
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!ranmaliShareSlugs().has(String(list))) return res.status(404).json({ error: 'list not shared' });
  if (!text) return res.status(400).json({ error: 'text required' });
  const cfg = sharedCfgOf(String(list));
  if (cfg) { await sharedListAddComment(cfg.sheetId, cfg.tab || String(list), String(item || '').slice(0, 200), 'Ranmali', text); return res.json({ ok: true }); }
  await appendTabRow(ELIST_COMMENTS_TAB, ELIST_COMMENTS_HEADERS, [nowIso(), String(list), String(item || '').slice(0, 200), 'Ranmali', text]);
  res.json({ ok: true });
}));

// ---------- ephemeral notes: quick captures (text / link / image) ----------
// NOT tasks: dedicated 'Ephemeral Notes' Sheet tab (durable, cross-tier, append-only —
// "delete" stamps the Deleted column per Sheet protocol). Scratch captures that may later
// BECOME tasks/journal/wiki items, but start as their own thing. Image BYTES stay on the
// capturing tier (data/enotes/, gitignored); the tab carries metadata only. Local-store
// mode (the stub, no Google) falls back to a JSON file. History: v1 used Heartbeat!R1 —
// that cell collided with nature-weather's state store AND evaporated on Cloud Run
// redeploys, which is how early notes were lost (2026-07-29 postmortem).
const ENOTES_LOCAL = path.join(__dirname, 'data', 'ephemeral-notes.json');
const ENOTES_DIR = path.join(__dirname, 'data', 'enotes');
const ENOTES_TAB = 'Ephemeral Notes';
const ENOTES_TAB_HEADERS = ['At', 'Type', 'Text', 'Caption', 'Tier', 'ID', 'Deleted'];
const ENOTE_TIER = () => HAS_CLAUDE ? 'mac' : 'cloud';
async function enotesList() {
  if (STORE_MODE !== 'sheets') {
    const j = readJson(ENOTES_LOCAL, null);
    return ((j && j.notes) || []).filter(n => !n.deleted);
  }
  const tab = await readTabCached(TODO_SHEET_ID, ENOTES_TAB, ENOTES_TAB_HEADERS, 20000).catch(() => ({ rows: [] }));
  return tab.rows.filter(r => !String(r.Deleted || '').trim())
    .map(r => ({ id: r.ID, type: r.Type, text: r.Text, caption: r.Caption, tier: r.Tier, at: r.At, ext: r.Type === 'image' ? 'jpg' : undefined }))
    .reverse();
}
async function enotesAdd(note) {
  if (STORE_MODE !== 'sheets') {
    const j = readJson(ENOTES_LOCAL, null) || { notes: [] };
    j.notes = [note, ...(j.notes || [])].slice(0, 200);
    writeJson(ENOTES_LOCAL, j);
    return;
  }
  await appendTabRow(ENOTES_TAB, ENOTES_TAB_HEADERS, [note.at, note.type, note.text || '', note.caption || '', note.tier || '', note.id, '']);
  _tabCache.delete(TODO_SHEET_ID + '|' + ENOTES_TAB); // read-your-write
}
async function enotesDelete(id) {
  if (STORE_MODE !== 'sheets') {
    const j = readJson(ENOTES_LOCAL, null) || { notes: [] };
    for (const n of j.notes || []) if (n.id === id) n.deleted = nowIso();
    writeJson(ENOTES_LOCAL, j);
    return true;
  }
  const tab = await readTab(TODO_SHEET_ID, ENOTES_TAB, ENOTES_TAB_HEADERS).catch(() => null);
  const row = tab && tab.rows.find(r => r.ID === id);
  if (!row) return false;
  await store.values.update({ spreadsheetId: TODO_SHEET_ID, range: `'${ENOTES_TAB}'!G${row._row}`, valueInputOption: 'RAW', requestBody: { values: [[nowIso()]] } });
  _tabCache.delete(TODO_SHEET_ID + '|' + ENOTES_TAB); // read-your-write
  return true;
}
app.get('/api/enotes', asyncRoute(async (req, res) => res.json({ notes: await enotesList(), tier: ENOTE_TIER() })));
app.post('/api/enotes', asyncRoute(async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'text required' });
  const type = /^https?:\/\/\S+$/i.test(text) ? 'link' : 'text';
  const note = { id: crypto.randomUUID().slice(0, 8), type, text, at: nowIso(), tier: ENOTE_TIER() };
  await enotesAdd(note);
  res.json({ ok: true, notes: await enotesList() });
}));
// image capture: client downscales to ≤~900px JPEG and sends a data URL (raised body limit)
app.post('/api/enotes/image', express.json({ limit: '3mb' }), asyncRoute(async (req, res) => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String((req.body || {}).dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'dataUrl (jpeg/png/webp) required' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2.5e6) return res.status(400).json({ error: 'image too large — downscale failed?' });
  const id = crypto.randomUUID().slice(0, 8);
  fs.mkdirSync(ENOTES_DIR, { recursive: true });
  fs.writeFileSync(path.join(ENOTES_DIR, `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`), buf);
  await enotesAdd({ id, type: 'image', caption: String((req.body || {}).caption || '').slice(0, 200), tier: ENOTE_TIER(), at: nowIso() });
  res.json({ ok: true, notes: await enotesList() });
}));
app.get('/api/enotes/img/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9-]/gi, '');
  const f = ['jpg', 'png', 'webp'].map(e => path.join(ENOTES_DIR, `${id}.${e}`)).find(p => fs.existsSync(p));
  if (!f) return res.status(404).json({ error: 'not on this tier' });
  res.sendFile(f);
}));
app.delete('/api/enotes/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const ok = await enotesDelete(id);
  for (const e of ['jpg', 'png', 'webp']) { try { fs.unlinkSync(path.join(ENOTES_DIR, `${id}.${e}`)); } catch (x) {} }
  res.json({ ok });
}));

// ---------- Monitor-list change watcher ----------
// A HIGH-SALIENCE change to the Monitor quadrant (a new watch, or a material change to one)
// gets pushed to the journal's ## Agent Notes so the owner is sure to review it — e.g. a new
// "job openings at X" watch. Low-salience churn never touches the journal; nothing outside
// the Monitor quadrant does either (market-signal ticks stay put). Runs server-side on the
// Mac, INDEPENDENT of the heartbeat's claude auth. Salience = a `salient`/`high` tag, or a
// leading "!" in the task text (the dashboard's ☆/★ toggle sets the tag).
const MONITOR_SNAP = path.join(__dirname, 'data', 'monitor-snapshot.json');
const isMonitorQuad = q => /^(m|mon|monitor)$/i.test(String(q || '').trim());
const isSalientTask = t => /(^|,)\s*(salient|high|⭐|🔔)\s*($|,)/i.test(String(t.Tags || '')) || /^\s*!/.test(String(t.Task || ''));
const monitorSig = t => `${String(t.Task || '').trim().replace(/^\s*!\s*/, '')}|${String(t.Status || '').toLowerCase()}|${String(t.Notes || '').trim().slice(0, 140)}`;
async function monitorWatch() {
  if (!HAS_JOURNAL || process.env.DASHBOARD_NO_JOBS) return;
  let rows;
  try { rows = (await readTodoTab()).rows; } catch (e) { return; }
  const mon = rows.filter(t => isMonitorQuad(t.Quadrant) && String(t.Status || '').toLowerCase() !== 'archived');
  const seen = (readJson(MONITOR_SNAP, null) || {}).seen || {};
  const first = !Object.keys(seen).length && !fs.existsSync(MONITOR_SNAP); // don't dump the whole existing list into the journal on first-ever run
  const pushes = [];
  const next = {};
  for (const t of mon) {
    const sal = isSalientTask(t), sig = monitorSig(t), prev = seen[t.ID];
    if (!first && sal && (!prev || prev.pushed !== sig)) {
      const verb = !prev ? 'New monitor' : 'Monitor updated';
      const done = String(t.Status || '').toLowerCase() === 'done';
      pushes.push(`- 🔔 ${verb}: ${String(t.Task || '').replace(/^\s*!\s*/, '').replace(/\n+/g, ' ').trim()}${done ? ' — resolved' : ''}`);
      next[t.ID] = { sig, pushed: sig };
    } else {
      next[t.ID] = { sig, pushed: (prev && prev.pushed) || (sal ? sig : '') }; // record; low-salience never sets `pushed`
    }
  }
  writeJson(MONITOR_SNAP, { seen: next, at: nowIso() });
  if (pushes.length) appendToJournal([`Monitor changes (${today()}):`, ...pushes].join('\n'), { section: 'Agent Notes' });
}
if (HAS_JOURNAL && !process.env.DASHBOARD_NO_JOBS) {
  setTimeout(() => monitorWatch().catch(() => {}), 35e3);
  setInterval(() => monitorWatch().catch(() => {}), 30 * 60000); // every 30 min
}
app.post('/api/monitor/scan', asyncRoute(async (req, res) => { // manual trigger (testing / on-demand)
  if (!HAS_JOURNAL) return res.status(400).json({ error: 'monitor watch runs on the journal host' });
  await monitorWatch();
  res.json({ ok: true });
}));

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
// Event dismissals need FUZZY matching on top of the exact key: the daily rescan rewrites
// titles with drift ("— 2nd Edition", en-dash vs em-dash, reworded venue) that defeats
// normTitle equality, so a swiped-away event kept resurfacing as its own near-clone.
// Tokens of every dismissed evt: title, grouped by activity; ≥70% overlap = same event.
async function getDismissedEvtToks() {
  const STOP = new Set(['the', 'and', 'at', 'of', 'a', 'in', 'on', 'for', 'to', 'day', 'edition', 'st', 'nd', 'rd', 'th', 'launch', 'closing', 'opening']);
  const toks = t => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  const out = {}; // activity → [Set(tokens)]
  try {
    const tab = await readTabCached(TODO_SHEET_ID, DISMISS_TAB, DISMISS_HEADERS, 30000);
    const cutoff = Date.now() - 21 * 864e5;
    for (const r of tab.rows) {
      const m = /^evt:.*\|(.*)$/.exec(String(r.URL || ''));
      if (!m) continue;
      if (r.At && new Date(r.At).getTime() < cutoff) continue;
      (out[m[1]] = out[m[1]] || []).push(new Set(toks(r.Title || '')));
    }
  } catch (e) {}
  return out;
}
const evtNearDismissed = (dis, activity, title) => {
  const STOPq = new Set(['the', 'and', 'at', 'of', 'a', 'in', 'on', 'for', 'to', 'day', 'edition', 'st', 'nd', 'rd', 'th', 'launch', 'closing', 'opening']);
  const T = new Set(String(title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOPq.has(w)));
  return (dis[activity] || []).some(D => {
    let n = 0; for (const x of T) if (D.has(x)) n++;
    return n / Math.max(1, Math.min(T.size, D.size)) >= 0.7;
  });
};
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
const RPC_HANDLERS = { reparse: (p) => doReparse(p), media_find: (p) => doMediaFind(p), habit_freq: (p) => resolveHabitFreq(p), news_describe: (p) => doNewsDescribe(p),
  'intern-reply': async (p) => { // phone thread replies: append + immediate re-run on the Mac
    const { rows } = await readTodoTab(); const task = rows.find(r => r.ID === p.id);
    if (!task) throw new Error('task not found: ' + p.id);
    let md = readInternThread(p.id) || ('# ' + task.Task + '\n');
    md += '\n\n-------\n**Owner · ' + today() + '**\n\n' + p.text;
    await writeInternThread(p.id, task.Task, md, 'owner-replied');
    internRun(p.id, 'owner-reply').catch(() => {});
    return { ok: true };
  },
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
    const job = q.rows.find(r => !String(r.Done || '').trim() && (RPC_HANDLERS[r.Kind] || PLUGIN_RPC[r.Kind]));
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
    // owner-context items (salient weather from plugins + salient upcoming events) the brief
    // may elevate — folded in only if genuinely more consequential than the weakest news pick
    const extras = [];
    for (const b of PLUGIN_BRIEF) { try { const items = await b.fn(); if (Array.isArray(items)) extras.push(...items); } catch (e) {} }
    try { extras.push(...(await eventLeadsForBrief())); } catch (e) {}
    const extrasBlock = extras.length
      ? `\n\nWEATHER & EVENTS (the owner's OWN situation — geographically/temporally where they are or are going). Include AT MOST ONE of these as a brief line, and ONLY if it is genuinely more consequential to the owner than your weakest news pick (a severe storm/frost/heat where they'll be, or a marquee event they follow). Otherwise ignore this block entirely:\n${extras.map(e => `- [${e.kind}] ${e.text}`).join('\n')}`
      : '';
    const served = {};
    const raw = await runClaude(
      `You are the owner's chief of staff. From the numbered headlines, do TWO things.\n` +
      `(A) Pick the 3 MOST SALIENT developments and rank them. EXCLUDE fiction, creative writing, book reviews, routine hiring/funding listicles, and anything >48h old. Salience = genuine consequence to the owner${CFG.profile ? ' — ' + CFG.profile : ''}. Concrete events (an executive order, an IPO filing, a ceasefire step) outrank commentary. You MAY replace your weakest pick with ONE weather/event item from the WEATHER & EVENTS block IF it outranks that news for the owner.\n` +
      `(B) Write the brief: EXACTLY 3 lines, one per top item, each LEADING with the specific fact a headline omits — names, numbers, dates, dollar figures, status. NO humor, NO wordplay, NO preamble, NO hedging. Terse and dense. Hotlink the key noun of each NEWS line as a markdown [text](url) using the URL given (a weather/event line needs no link).\n\n` +
      `The headlines below are self-contained — rank and write from them directly. You MAY use WebSearch/WebFetch to enrich a specific figure, but this is optional; if a fetch fails or a tool is unavailable, proceed anyway from the headline text. NEVER mention tools, access, or your own limitations in the output.\n` +
      `Return STRICT JSON only — no prose before or after, no code fences: {"top":[{"i":<number or -1 for a weather/event line>,"detail":"the specific fact"}],"brief":"3 lines, one per item, with inline [text](url) links on news lines and hard specifics"}\n\nHEADLINES:\n${lines.join('\n')}${extrasBlock}`,
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

const normTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
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
const apaEval = async (cand, inc) => { // cand/inc = { id, lab } → module wants { id, provider }
  const { apaProviderFor, openrouterResolveId } = require('./providers');
  // openrouter probes need catalog ids ("deepseek/…"), not scraped names — resolve first
  const rid = async (id, prov) => (prov === 'openrouter' ? await openrouterResolveId(id) : id);
  const cp = apaProviderFor(cand.id, cand.lab), ip = apaProviderFor(inc.id, inc.lab);
  return apaEngine.evaluate({ id: await rid(cand.id, cp), provider: cp }, { id: await rid(inc.id, ip), provider: ip });
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
  // incumbent off the AA board (per the winner watch's miss counter) → relaxed propose-only gate
  incumbentDelisted: (module, incId) => apaModelDelisted(incId),
  // the module's trailing-30d input/output token mix → usage-weighted "cheaper" in adoptGate
  usageMix: (module) => apaMixFor(module),
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
  // headline TIER TABLE (owner decree 2026-08-10): month-to-date usage grouped by the
  // roster's funding surface — which model is actually carrying each tier right now,
  // which agents ride it, tokens, and cost twice: REAL (dollars actually paid) vs
  // HYPOTHETICAL (what the same tokens would cost at list API rates — the subscription's
  // shadow price). freshest timestamp per tier makes staleness visible at a glance.
  try {
    const modSurface = {}; const modAgent = {};
    for (const a of AGENT_STABLE) for (const m of (a.modules || [])) { modSurface[m] = a.surface || ''; modAgent[m] = a.name; }
    const tiers = {};
    for (const r of await usageRows()) {
      const t = new Date(r.at).getTime(); if (!t || t < monthStart.getTime()) continue;
      const cls = costClass(r.model, r.module, r.at);
      const tier = modSurface[r.module] || (cls === 'real' ? 'metered' : cls === 'included' ? 'free' : 'subscription');
      const g = tiers[tier] = tiers[tier] || { tier, models: {}, agents: new Set(), input: 0, output: 0, real: 0, hypo: 0, lastAt: '' };
      g.models[r.model] = Math.max(g.models[r.model] || 0, t);
      g.agents.add(modAgent[r.module] || r.module);
      g.input += r.input; g.output += r.output;
      let cost = r.costUsd; const p = priceOf(r.model);
      if (!cost && p) cost = (r.input * p.in + r.output * p.out) / 1e6;
      if (cls === 'real') g.real += cost;
      g.hypo += p ? (r.input * p.in + r.output * p.out) / 1e6 : cost;
      if (r.at > g.lastAt) g.lastAt = r.at;
    }
    out.tiers = Object.values(tiers).map(g => ({ tier: g.tier,
      model: Object.entries(g.models).sort((a, b) => b[1] - a[1])[0][0].replace(/-20\d{6}$/, ''),
      agents: [...g.agents].slice(0, 12), input: g.input, output: g.output,
      real: Math.round(g.real * 100) / 100, hypo: Math.round(g.hypo * 100) / 100, lastAt: g.lastAt }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output));
  } catch (e) { readFailures++; }
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
// ---- usage-weighted cost mix (2026-08-11) ----
// "Cheaper" is judged on the OWNER'S token mix, refreshed weekly from the trailing 30d of the
// Usage tab and cached in apa-state (per module, per role = the role's modules aggregated, plus
// a global fallback). A flat in+out sum mis-ranks lopsided workloads — bulk-tier traffic runs
// ~97% input tokens, where a model $0.25/1M pricier on input is a worse deal no matter how
// cheap its output is. Everything price-gated (adoptGate via ctx.usageMix, the winner watch's
// relaxed search) blends $/1M as in·wIn + out·wOut; no data → 0.5/0.5 ≡ the old flat sum.
const APA_MIX_WINDOW_DAYS = 30, APA_MIX_TTL_DAYS = 7;
async function apaRefreshUsageMix(st) { // mutates st.usageMix when stale; caller persists
  if (st.usageMix && st.usageMix.at && Date.now() - new Date(st.usageMix.at).getTime() < APA_MIX_TTL_DAYS * 86400000) return st.usageMix;
  const { usageMixOf } = require('./stable/pricing');
  const cutoff = Date.now() - APA_MIX_WINDOW_DAYS * 86400000;
  const rows = (await usageRows()).filter(r => new Date(r.at).getTime() >= cutoff);
  const byModule = {};
  for (const r of rows) (byModule[r.module || 'unknown'] = byModule[r.module || 'unknown'] || []).push(r);
  const modules = {}; for (const [m, rs] of Object.entries(byModule)) modules[m] = usageMixOf(rs);
  const roleMix = {};
  for (const [k, rc] of Object.entries(loadApaRoles().roles || {})) {
    const rs = rows.filter(r => (rc.modules || []).includes(r.module));
    roleMix[k] = rs.length ? usageMixOf(rs) : null; // null → global fallback at read time
  }
  st.usageMix = { at: nowIso(), windowDays: APA_MIX_WINDOW_DAYS, global: usageMixOf(rows), modules, roles: roleMix };
  return st.usageMix;
}
function apaMixFor(module) { const um = apaState().usageMix || {}; return (um.modules || {})[module] || um.global || null; }
function apaMixForRole(role) { const um = apaState().usageMix || {}; return (um.roles || {})[role] || um.global || null; }
// ---- delisted-winner watch (2026-08-11) ----
// A role winner absent from the AA board has no live price or score, so the strict
// "equal-or-better AND cheaper" adopt gate can never replace it — the winner freezes forever
// (observed 2026-08-10: thoroughbred/workhorse/x-access still on AA-delisted claude-opus-4-8 /
// claude-haiku-4-5 / grok-4.3 while the feed showed only test/arbitrage actions). Every board
// compile counts consecutive missing days per role (once per UTC day, so manual recompiles stay
// idempotent); at apaDelistN() misses the relaxed gate runs — equal-or-better on the role's
// primary benchmark (bar = the winner's last-seen score if the watch ever recorded one, else the
// effective min) at comparable-or-better price vs the winner's LAST KNOWN price (apaState().prices
// keeps delisted models' prices) — and the best qualifier is PROPOSED: APA Feed row + journal
// propose line + Decisions row. Never auto-swaps — the winner field only changes via a roles
// edit (manual edits win), so this stays reversible and human-decided.
const APA_DELIST_N = 3;
function apaDelistN() { const n = +loadApaRoles().delistN; return n >= 1 ? n : APA_DELIST_N; }
function apaModelDelisted(id) {
  if (!id) return false;
  const { normModel } = require('./stable/board');
  const n = apaDelistN();
  return Object.values(apaState().winnerBoard || {}).some(e => e && normModel(e.winner) === normModel(id) && (e.misses || 0) >= n);
}
async function apaWinnerWatch(bd, models, st) {
  const roles = loadApaRoles();
  const cutoffs = st.cutoffs || {};
  const wb = st.winnerBoard = st.winnerBoard || {};
  const today = nowIso().slice(0, 10);
  const n = apaDelistN();
  for (const k of Object.keys(wb)) if (!(roles.roles || {})[k]) delete wb[k]; // role removed
  for (const [k, rc] of Object.entries(roles.roles || {})) {
    const s = bd.winnerOnBoard(models, k);
    if (!s) { delete wb[k]; continue; } // no winner configured for this role
    if (s.present) {
      wb[k] = { winner: rc.winner, misses: 0, lastScore: s.score, lastSeenAt: nowIso() };
      // cutoff refinement, path 1 (auto-anchor): while the adopted winner is ON the board, keep
      // the role's hypothesised min anchored to its LIVE primary score (floored, so daily jitter
      // never fails the winner against its own bar). Written only when the floor moves; a
      // manually-set rc.min always wins at read time, and manually-authored hypotheses are
      // only replaced, never edited. Refinement paths 2/3 (outcome grading, boundary probes)
      // stay with the nightly CI / future Form Guide outcome posting.
      if (s.score != null) {
        const cuts = st.cutoffs = st.cutoffs || {};
        const want = Math.floor(s.score);
        if (!cuts[k] || cuts[k].min !== want) {
          cuts[k] = { min: want, why: `Auto-anchored to the adopted ${k} winner ${rc.winner}'s live ${rc.primary} score (${s.score}) — a candidate must at least match the model already judged adequate. Floored so the winner's own daily jitter never fails its bar. Manual min overrides.`, method: 'anchor:winner-live', at: nowIso().slice(0, 10) };
        }
      }
      // value arbitrage while the winner is PRESENT: the news-driven gate only sees announced
      // findings, never board drift — so each compile also walks the Pareto frontier for a
      // point at ≤ the winner's live blended cost with a meaningful score jump (≥2 points,
      // above the floor-jitter noise). Proposal only, same 10-day dedup; capability roles skip.
      if (!rc.special && s.score != null) {
        const { weightedCost } = require('./stable/pricing');
        const mixP = apaMixForRole(k);
        const wRow = models.find(m => require('./stable/board').normModel(m.model) === require('./stable/board').normModel(rc.winner));
        const wCost = wRow ? weightedCost({ in: wRow.priceIn != null ? +wRow.priceIn : null, out: wRow.priceOut != null ? +wRow.priceOut : null }, mixP) : null;
        const up = wCost != null ? bd.bestReplacement(models, k, { minScore: s.score + 2, maxCost: wCost, mix: mixP }) : null;
        if (up && !(e2 => e2 && e2.cand === up.model && Date.now() - new Date(e2.at).getTime() < 10 * 86400000)(wb[k].arbProposed)) {
          wb[k].arbProposed = { cand: up.model, at: nowIso() };
          const r2b = v => Math.round(v * 100) / 100;
          const h = `value arbitrage: ${up.model} beats ${k} winner ${rc.winner} by ${r2b(up.score - s.score)} pts on ${rc.primary} at no extra cost (~$${r2b(up.cost)} vs ~$${r2b(wCost)}/1M blended on the role's mix)`;
          try {
            await appendTabRow(APA_TAB, APA_HEADERS, [crypto.randomUUID(), nowIso(), 'arbitrage', up.lab || '', up.model, h.slice(0, 200), 'https://artificialanalysis.ai/models', '0.6', 'proposal', 'new', '1', `Pareto-frontier sweep vs the live winner (equal-or-cheaper usage-weighted cost, ≥2-point jump). Proposal only — edit the winner on /agents.html use-cases to act.`], STABLE_SHEET_ID);
          } catch (err) { console.error('winner arb feed:', err.message); }
          appendToJournal(`- **APA proposal**: ${h}`);
          await logDecision({ module: 'apa', actor: 'apa', decision: `value-arbitrage proposal: ${k} ${rc.winner} → ${up.model}`, why: `+${r2b(up.score - s.score)} pts at ~$${r2b(up.cost)} ≤ winner ~$${r2b(wCost)}/1M blended`.slice(0, 200) }).catch(() => {});
        }
      }
      continue;
    }
    const e = (wb[k] && wb[k].winner === rc.winner) ? wb[k] : { winner: rc.winner, misses: 0 };
    if (e.lastMissDay !== today) { e.misses = (e.misses || 0) + 1; e.lastMissDay = today; e.firstMissAt = e.firstMissAt || nowIso(); }
    wb[k] = e;
    if (e.misses < n) continue;
    const lastP = apaPriceOf(rc.winner);
    const mix = apaMixForRole(k);
    const { weightedCost } = require('./stable/pricing');
    const lastCost = lastP ? weightedCost(lastP, mix) : null;
    const r2 = v => v == null ? null : Math.round(v * 100) / 100;
    const mixStr = mix ? `${Math.round(mix.wIn * 100)}/${Math.round(mix.wOut * 100)} in/out mix` : '50/50 default mix';
    const minScore = e.lastScore ?? rc.min ?? (cutoffs[k] || {}).min ?? null;
    // capability stand-in roles (rc.special — e.g. x-access, where grok's x_search is the point
    // and "no public benchmark measures this") get the delisting FLAGGED but never a
    // benchmark-picked nominee: scores don't measure the capability the role exists for.
    const special = !!rc.special;
    const cand = special ? null : bd.bestReplacement(models, k, { minScore, maxCost: lastCost, mix });
    const cKey = cand ? cand.model : (special ? '(capability role)' : '(none)');
    // one proposal per candidate per 10 days (mirrors the feed's re-surface window), not one per compile
    if (e.proposed && e.proposed.cand === cKey && Date.now() - new Date(e.proposed.at).getTime() < 10 * 86400000) continue;
    e.proposed = { cand: cKey, at: nowIso() };
    const bar = minScore != null ? `${rc.primary} ≥ ${minScore}${e.lastScore != null ? ' (winner\'s last-seen score)' : ' (role min)'}` : `any ${rc.primary} score`;
    const headline = cand
      ? `winner delisted: ${rc.winner} (${k}) off the AA board ${e.misses} compiles — ${cand.model} is cheapest adequate (${rc.primary} ${cand.score}, ~$${r2(cand.cost)}/1M vs last-known ~$${r2(lastCost)}/1M on the role's ${mixStr})`
      : special
        ? `winner delisted: ${rc.winner} (${k}) off the AA board ${e.misses} compiles — capability stand-in role, so no benchmark can nominate a stand-in; review whether the capability still works or a successor exists`
        : `winner delisted: ${rc.winner} (${k}) off the AA board ${e.misses} compiles — no model passes the relaxed gate (${bar} at ≤ last-known ~$${r2(lastCost) ?? '?'}/1M, ${mixStr})`;
    const detail = `Relaxed gate for delisted incumbents: cheapest model at equal-or-better on the role's primary benchmark, cost usage-weighted (in·wIn+out·wOut on the role's trailing-30d token mix) vs the winner's last-known price. Proposal only — edit the winner on /agents.html use-cases to act${rc.setBy ? ` (last edited by ${rc.setBy}; manual edits win)` : ''}.`;
    try {
      await appendTabRow(APA_TAB, APA_HEADERS, [crypto.randomUUID(), nowIso(), 'delisted', cand ? cand.lab : '', cand ? cand.model : rc.winner, headline.slice(0, 200), 'https://artificialanalysis.ai/models', '0.7', 'proposal', 'new', '1', detail.slice(0, 300)], STABLE_SHEET_ID);
    } catch (err) { console.error('winner watch feed:', err.message); }
    appendToJournal(`- **APA proposal**: ${headline}`);
    await logDecision({ module: 'apa', actor: 'apa', decision: `winner-delisted proposal: ${k} ${rc.winner} → ${cKey}`, why: `absent ${e.misses} compiles; relaxed gate: ${bar} at ≤ last-known ~$${r2(lastCost) ?? '?'}/1M (${mixStr})`.slice(0, 200) }).catch(() => {});
  }
}
let apaBoardBusy = false;
async function runApaBoard() {
  // AA is the SOLE benchmark source (David 2026-07-30): fresher and deterministic; the LLM
  // web-search compile is deleted — no fallback machinery for models AA hasn't indexed
  // ("I can't compete with them"). No LLM involved: cheap enough to refresh daily.
  if (apaBoardBusy) return { skipped: true };
  apaBoardBusy = true;
  try {
    const aa = await aaModels();
    if (!aa || !aa.length) { track('apa-board', false, CFG.aaApiKey ? 'AA API unavailable' : 'no aaApiKey configured'); return { error: 'AA unavailable' }; }
    const bd = require('./stable/board').createBoard({ roles: loadApaRoles() });
    const models = bd.fromRows(aa);
    await ensureTab(APA_MODELS_TAB, APA_MODELS_HEADERS, STABLE_SHEET_ID);
    await store.values.clear({ spreadsheetId: STABLE_SHEET_ID, range: `'${APA_MODELS_TAB}'!A2:Z1000` }); // replace board
    const rows = models.map(m => [String(m.model).slice(0, 60), m.lab || '', m.country || '', m.os ? '1' : '', m.role || '',
      m.priceIn == null ? '' : String(m.priceIn), m.priceOut == null ? '' : String(m.priceOut),
      JSON.stringify(m.benchmarks).slice(0, 900), nowIso(), 'artificialanalysis.ai']);
    await appendTabRows(APA_MODELS_TAB, APA_MODELS_HEADERS, rows, STABLE_SHEET_ID);
    // seed price table for any board model we don't already price (helps cost-compare later)
    const st = apaState(); st.prices = st.prices || {};
    for (const m of models) if (m.priceIn != null && m.priceOut != null) st.prices[String(m.model).toLowerCase()] = { in: +m.priceIn, out: +m.priceOut, src: 'aa' };
    st.boardAt = nowIso();
    try { await apaRefreshUsageMix(st); } catch (e) { console.error('usage mix:', e.message); } // weekly TTL; the watch prices on it
    saveApaState(st); // save prices first — the watch reads last-known prices via apaPriceOf (disk)
    try { await apaWinnerWatch(bd, models, st); } catch (e) { console.error('winner watch:', e.message); }
    saveApaState(st); // watch mutates st.winnerBoard
    track('apa-board', true, `${rows.length} models (AA)`);
    return { found: rows.length };
  } finally { apaBoardBusy = false; }
}
// daily refresh on the journal host (single writer); the POST route works from any tier
if (HAS_JOURNAL && !process.env.DASHBOARD_NO_JOBS) {
  setTimeout(() => runApaBoard().catch(() => {}), 90 * 1000); // post-boot, after caches warm
  setInterval(() => runApaBoard().catch(() => {}), 24 * 3600 * 1000);
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
  // config warnings, not silent gaps: (1) a role whose primary benchmark has NO data on the
  // board renders an empty leaderboard/plot (observed: secretariat's METR Long-Horizon — the AA
  // board carries no such column) — say so; (2) a winner past the delist threshold is flagged
  // here too, pointing at the relaxed-gate proposal in the feed.
  const bd = require('./stable/board').createBoard({ roles });
  const warnings = [];
  if (models.length) for (const [k, rc] of Object.entries(roles.roles || {})) {
    if (!rc || !rc.primary) continue;
    const hasData = models.some(m => Object.entries(m.benchmarks || {}).some(([b, v]) => v != null && bd.sameBench(b, rc.primary)));
    if (!hasData) warnings.push({ role: k, kind: 'no-primary-data', text: `${rc.label || k}: primary benchmark "${rc.primary}" has no data from the board source — its leaderboard/plot is empty. Pick a primary the source covers, or treat the role as a ★ capability stand-in.` });
  }
  const wn = apaDelistN();
  for (const [k, e] of Object.entries(apaState().winnerBoard || {})) {
    if (e && (e.misses || 0) >= wn) warnings.push({ role: k, kind: 'winner-delisted', text: `${((roles.roles || {})[k] || {}).label || k}: winner ${e.winner} has been off the board ${e.misses} compiles — relaxed-gate proposal in the APA feed; the winner stays until edited here.` });
  }
  res.json({ roles: roles.roles || {}, models, cutoffs, warnings, usageMix: apaState().usageMix || null, selfHost: { ...roles.selfHost, perMTokOut: selfHostPerMTok(roles.selfHost) }, osCostBasis: roles.osCostBasis, updated: models.length ? models[0].updated : null });
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
    // price chain: board row → static price table → live OpenRouter market feed
    const pt = !p && rc.winner ? priceOf(rc.winner) : null;
    const po = !p && !pt && rc.winner ? await require('./providers').openrouterPrice(rc.winner) : null;
    tiers[k] = { model: rc.winner || null,
      priceIn: p && p.PriceIn !== '' ? +p.PriceIn : (pt ? pt.in : (po ? po.in : null)),
      priceOut: p && p.PriceOut !== '' ? +p.PriceOut : (pt ? pt.out : (po ? po.out : null)),
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
  const src = aa ? { source: 'artificialanalysis.ai', models: aa }
    : { source: 'board', models: (await readTabCached(STABLE_SHEET_ID, APA_MODELS_TAB, APA_MODELS_HEADERS, 300000)).rows.map(r => {
        let b = {}; try { b = JSON.parse(r.Benchmarks || '{}'); } catch (e) {}
        const bm = {}; for (const [bk, v] of Object.entries(b)) if (!bk.startsWith('_')) bm[bk] = v;
        return { model: r.Model, lab: r.Lab, os: String(r.OS || '').trim() === '1',
          priceIn: r.PriceIn === '' ? null : +r.PriceIn, priceOut: r.PriceOut === '' ? null : +r.PriceOut, benchmarks: bm };
      }) };
  // fill missing prices from the live OpenRouter market feed (keyless, cached)
  const { openrouterPrice } = require('./providers');
  for (const m of src.models) {
    if (m.priceOut != null) continue;
    const po = await openrouterPrice(m.model);
    if (po) { m.priceIn = m.priceIn ?? po.in; m.priceOut = po.out; m.priceSource = 'openrouter'; }
  }
  return src;
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
    // prefix-aware join: a roster module 'worker' also claims rows metered as 'worker:<sub>'
    // (external services namespace their per-group runs under one module prefix)
    const owns = mod => a.modules.some(m => mod === m || String(mod || '').startsWith(m + ':'));
    const u = rows.filter(r => owns(r.module));
    const acts = [...u.map(r => `${r.module} run [${r.model.replace(/-20\d{6}$/, '')}] — ${r.input}+${r.output} tok`),
                  ...decRows.filter(v => owns(v[2])).map(v => v[4])];
    const cost = u.reduce((n, r) => n + r.costUsd, 0);
    const cls = u.length ? costClass(u[0].model, u[0].module, u[0].at) : costClass(a.model, a.modules[0]);
    // effective model = APA override for the agent's primary module, else registry default;
    // useCase label + current role winner/fallbacks come from the roles config so the stable
    // reads e.g. "Summarizer — Daily driver: claude-sonnet-5 (fallback gemini-2.5-pro)"
    const rc = rolesCfg.roles[a.useCase] || {};
    // per-model breakdown of THIS agent's window usage — an agent's actual traffic can span
    // models its config never names (quota fallbacks, OpenRouter reroutes); showing only the
    // declared model hid a paid anthropic/claude-sonnet-5 reroute inside "claude-sonnet-5"
    const byModel = {};
    for (const r of u) {
      const k = String(r.model || 'unknown').replace(/-20\d{6}$/, '');
      const b = byModel[k] = byModel[k] || { model: k, input: 0, output: 0, costUsd: 0, runs: 0, costClass: costClass(r.model, r.module, r.at) };
      b.input += r.input; b.output += r.output; b.costUsd += r.costUsd; b.runs++;
    }
    return { ...a, model: modelFor(a.modules[0], a.model), tasks: u.length,
      useCaseLabel: rc.label || a.useCase || '', winner: rc.winner || '', fallbacks: rc.fallbacks || [], special: rc.special || '',
      input: u.reduce((n, r) => n + r.input, 0), output: u.reduce((n, r) => n + r.output, 0),
      costUsd: Math.round(cost * 100) / 100, costClass: cls, activities: acts.slice(0, 8),
      byModel: Object.values(byModel).sort((x, y) => y.costUsd - x.costUsd)
        .map(b => ({ ...b, costUsd: Math.round(b.costUsd * 100) / 100 })) };
  });
  // per-MODEL 7d totals (all modules, incl. ones not mapped to a roster agent)
  const models = {};
  for (const r of rows) {
    const m = models[r.model] = models[r.model] || { input: 0, output: 0, costUsd: 0, runs: 0 };
    m.input += r.input; m.output += r.output; m.costUsd += r.costUsd; m.runs++;
  }
  res.json({ windowDays: 7, active: out.filter(a => a.status === 'active').length, standby: out.filter(a => a.status !== 'active').length, agents: out,
    models: Object.entries(models).sort((a, b) => b[1].costUsd - a[1].costUsd).map(([model, x]) => ({ model, ...x, costUsd: Math.round(x.costUsd * 100) / 100 })) });
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

try { require('./providers').setUserKey('openrouter', (loadSettings().openrouterKey || '')); } catch (e) {}
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
});
