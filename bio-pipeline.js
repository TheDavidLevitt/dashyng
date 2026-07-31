// Biotech tracker — tiered analysis pipeline with confidence-based escalation.
//
//   Haiku (daily) → Sonnet (weekly) → Opus (monthly + on demand)
//
// Every tier returns the same structured verdict: {analysis, confidence, escalate,
// escalate_reason}. A task moves up a tier when EITHER a hard rule fires (phase transition,
// FDA event inside 30 days, >15%/week market-cap move) OR the model's own confidence falls
// below the threshold. The second kind is capped by a circuit breaker: if a run is escalating
// on confidence more than half the time, the threshold is miscalibrated rather than the world
// being unusually uncertain, so confidence escalations stop for the rest of that run and the
// run is flagged for human review. Rule-based escalations always continue — they encode facts,
// not vibes.
//
// Everything is injected via `deps` (see bioPipelineDeps in server.js) so this module runs
// unchanged in-process on the dashboard and standalone in a Cloud Run Job.

// maxTokens rises with the tier: the deeper tiers are asked for multi-paragraph analysis,
// and a cap that truncates them mid-object turns a good answer into a parse failure. (Seen
// for real on 2026-07-30 — a flat 2000 lost 4 of 9 calls.)
const MODELS = {
  haiku: { api: 'claude-haiku-4-5-20251001', or: 'anthropic/claude-haiku-4.5', inK: 1, outK: 5, maxTokens: 2000 },
  sonnet: { api: 'claude-sonnet-5', or: 'anthropic/claude-sonnet-5', inK: 3, outK: 15, maxTokens: 8000 },
  opus: { api: 'claude-opus-5', or: 'anthropic/claude-opus-5', inK: 15, outK: 75, maxTokens: 16000 },
};
const TIER_CHAIN = ['haiku', 'sonnet', 'opus'];
const ENTRY_TIER = { daily: 'haiku', weekly: 'sonnet', monthly: 'opus' };
// Starred (Status=tracked) rows may climb to Opus. Everything else tops out at Sonnet, so a
// 300-row universe can be analysed without any of it reaching the expensive tier.
const ceilingFor = row => (String(row.Status || '').trim() === 'tracked' ? 'opus' : 'sonnet');

// ---------- LLM transport ----------
// FREE FIRST. The claude CLI runs on the owner's subscription and costs nothing per call, so
// it is always tried before any metered API. Getting this order wrong is not a style question:
// the first version of this file preferred OpenRouter and quietly billed ~$5 of work that the
// subscription would have done for free.
//
// A metered transport is therefore OPT-IN (`bioAllowPaidLLM` / BIO_ALLOW_PAID_LLM). With it
// off — the default — a host without the CLI does not silently fall back to a paid API; it
// fails with a message saying so, which is the notification the owner asked for. Turning it
// on is a deliberate "yes, spend money here" for hosts like Cloud Run that have no CLI.
class NoFreeTransport extends Error {}
function paidAllowed() {
  const v = process.env.BIO_ALLOW_PAID_LLM !== undefined ? process.env.BIO_ALLOW_PAID_LLM : safeConfig('bioAllowPaidLLM');
  return v === true || v === '1' || v === 'true';
}
async function callModel(tier, prompt) {
  const m = MODELS[tier];
  const cli = claudeBin();
  if (cli) {
    try { return await claudeCliCall(cli, m, prompt); }
    catch (e) {
      // auth expiry is the expected failure and must be visible, not papered over
      console.error(`[bio-pipeline] claude CLI failed (${e.message.slice(0, 120)})`);
      if (!paidAllowed()) {
        throw new NoFreeTransport(`claude CLI failed and paid fallback is off — check the headless token (claude setup-token). Original error: ${e.message.slice(0, 160)}`);
      }
      console.warn('[bio-pipeline] falling back to a PAID transport because BIO_ALLOW_PAID_LLM is set');
    }
  } else if (!paidAllowed()) {
    throw new NoFreeTransport('no claude CLI on this host and paid fallback is off (set BIO_ALLOW_PAID_LLM=1 to permit metered API calls)');
  }
  if (process.env.ANTHROPIC_API_KEY) return anthropicCall(m, prompt);
  const orKey = process.env.OPENROUTER_API_KEY || safeConfig('openrouterKey');
  if (orKey) return openrouterCall(m, prompt, orKey);
  throw new NoFreeTransport('no LLM transport available: install the claude CLI, or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY with BIO_ALLOW_PAID_LLM=1');
}
function safeConfig(k) { try { return require('./config')[k] || ''; } catch (e) { return ''; } }
function claudeBin() {
  const fs = require('fs');
  if (process.env.CLAUDE_BIN === 'none') return '';
  return [process.env.CLAUDE_BIN, '/opt/homebrew/bin/claude', '/usr/bin/claude', '/usr/local/bin/claude']
    .filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || '';
}
async function anthropicCall(m, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m.api, max_tokens: m.maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic HTTP ${r.status}: ${(j.error || {}).message || ''}`);
  const u = j.usage || {};
  if (j.stop_reason === 'max_tokens') throw new Error(`anthropic output truncated at ${m.maxTokens} tokens`);
  return { text: (j.content || []).map(c => c.text || '').join(''), model: j.model || m.api, cost: cost(m, u.input_tokens, u.output_tokens), via: 'anthropic' };
}
async function openrouterCall(m, prompt, key) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: m.or, max_tokens: m.maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`openrouter HTTP ${r.status}: ${(j.error || {}).message || ''}`);
  const u = j.usage || {};
  if (((j.choices || [])[0] || {}).finish_reason === 'length') throw new Error(`openrouter output truncated at ${m.maxTokens} tokens`);
  return { text: ((j.choices || [])[0] || {}).message?.content || '', model: j.model || m.or, cost: cost(m, u.prompt_tokens, u.completion_tokens), via: 'openrouter' };
}
function claudeCliCall(bin, m, prompt) {
  const { spawn } = require('child_process');
  const os = require('os');
  const env = { ...process.env };
  // systemd and launchd hand the process a bare environment. The CLI resolves its own
  // credentials relative to $HOME, so an unset HOME makes it exit non-zero with nothing
  // useful on stderr — set it from the passwd entry rather than inheriting nothing.
  if (!env.HOME) env.HOME = os.homedir();
  // The headless token also has to come from its file, the same way bin/heartbeat.sh does it.
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const tok = require('fs').readFileSync(`${env.HOME}/.config/dashboard/claude-oauth-token`, 'utf8').trim();
      if (tok.startsWith('sk-ant-')) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    } catch (e) {}
  }
  return new Promise((resolve, reject) => {
    // stdin ignored, not piped: an open pipe makes the CLI wait 3s for input it will never get
    const p = spawn(bin, ['-p', prompt, '--model', m.api], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errText = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude cli: timed out after 300s')); }, 300000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { errText += d; });
    p.on('error', e => { clearTimeout(timer); reject(new Error(`claude cli: ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude cli exited ${code}: ${errText.trim().slice(0, 300) || '(no stderr)'}`));
      resolve({ text: out, model: m.api, cost: 0, via: 'claude-cli' });
    });
  });
}
const cost = (m, inTok, outTok) => +(((inTok || 0) / 1e6) * m.inK + ((outTok || 0) / 1e6) * m.outK).toFixed(4);

// Models wrap JSON in prose or fences however they like; take the outermost object and
// fail loudly rather than silently analysing nothing.
function parseVerdict(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  const slice = body.slice(start, end + 1);
  let o;
  try { o = JSON.parse(slice); }
  catch (e) {
    // Real output fails in two mundane ways: a trailing comma before a closing brace, and
    // raw newlines inside a string. Repair those two and try once more before giving up —
    // the alternative is throwing away an otherwise good analysis.
    const repaired = slice
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/"((?:[^"\\]|\\.)*)"/gs, (m0, inner) => `"${inner.replace(/\n/g, '\\n').replace(/\r/g, '')}"`);
    try { o = JSON.parse(repaired); }
    catch (e2) { throw new Error(`unparseable JSON: ${e.message}`); }
  }
  const conf = Number(o.confidence);
  const targets = Array.isArray(o.priceTargets) ? o.priceTargets.filter(t => t && t.firm &&
    (typeof t.target === 'number' || t.rating)) : null;
  return {
    ticker: typeof o.ticker === 'string' && /^[A-Z.\-]{1,6}$/.test(o.ticker.trim().toUpperCase()) ? o.ticker.trim().toUpperCase() : null,
    priceTargets: targets,
    analysis: o.analysis && typeof o.analysis === 'object' ? o.analysis : {},
    summary: String(o.summary || ''),
    confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    escalate: !!o.escalate,
    escalateReason: String(o.escalate_reason || o.escalateReason || ''),
  };
}

// ---------- hard escalation rules ----------
// These fire on facts, so they survive the circuit breaker.

// A weekly move this size is a market event by itself. Keyless Yahoo endpoint; a ticker we
// cannot price returns null, and a null must never read as "no move".
async function weeklyMove(ticker) {
  if (!ticker) return null;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    const closes = (((j.chart || {}).result || [])[0] || {}).indicators?.quote?.[0]?.close;
    const clean = (closes || []).filter(v => typeof v === 'number' && isFinite(v));
    if (clean.length < 2) return null;
    return ((clean[clean.length - 1] - clean[0]) / clean[0]) * 100;
  } catch (e) { return null; }
}

const FDA_WORDS = /pdufa|adcomm|advisory committee|fda decision|bla |nda |approval decision|crl/i;
// A dated FDA catalyst inside 30 days. Reads the milestone text the analyst tiers maintain;
// only ISO-ish dates are trusted — a vague "2H 2026" is not a 30-day trigger.
function fdaWithin30d(row, now) {
  const text = `${row.NextMilestone || ''} ${row.Notes || ''}`;
  if (!FDA_WORDS.test(text)) return null;
  for (const m of text.matchAll(/(\d{4})-(\d{2})(?:-(\d{2}))?/g)) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3] || '01'}T00:00:00Z`);
    if (isNaN(d)) continue;
    const days = Math.round((d - now) / 86400000);
    if (days >= 0 && days <= 30) return `FDA event in ${days}d (${m[0]})`;
  }
  return null;
}

async function hardRules(row, registryChange, now) {
  const fired = [];
  if (registryChange && registryChange.phaseChanged) fired.push(`phase transition ${registryChange.from} → ${registryChange.to}`);
  const fda = fdaWithin30d(row, now);
  if (fda) fired.push(fda);
  const mv = await weeklyMove(row.Ticker);
  if (mv !== null && Math.abs(mv) > 15) fired.push(`market move ${mv > 0 ? '+' : ''}${mv.toFixed(1)}%/week`);
  return fired;
}

// ---------- prompts ----------
const ANALYST_FIRMS = ['J.P. Morgan', 'Morgan Stanley', 'Goldman Sachs', 'BofA Securities',
  'Citi', 'Jefferies', 'Leerink Partners', 'Evercore ISI', 'TD Cowen', 'Piper Sandler',
  'Stifel', 'Guggenheim', 'Barclays', 'UBS', 'RBC Capital Markets', 'Wells Fargo'];

const VERDICT_CONTRACT = `Return ONLY a JSON object, no prose outside it:
{
  "analysis": { "outcomes": "...", "competition": "...", "marketSize": "...", "background": "...", "nextMilestone": "..." },
  "priceTargets": [ { "firm": "J.P. Morgan", "rating": "Overweight", "target": 62, "date": "2026-06-12", "source": "https://..." } ],
  "summary": "one or two sentences on what changed and why it matters",
  "confidence": 0.0-1.0,
  "escalate": true|false,
  "escalate_reason": "why a deeper tier is needed, or empty"
}
Length limits (hard — an over-long answer is truncated mid-object and thrown away, so brevity is correctness here): each analysis field at most 150 words; "summary" at most 250 words. Do your reasoning before you write, then report the conclusion.
Rules on the analysis object: include ONLY fields you are actually updating — omit a field entirely rather than restating what is already there or padding it. Every figure needs a source and a date; prefer ranges and "~" to false precision; if you cannot source a number, give the qualitative fact instead of inventing one.
Rules on priceTargets: include a firm ONLY if you can point to a specific, dated note from that firm — an actual rating and/or target you have seen reported, with the source you saw it in. NEVER interpolate a target from a share price, never average other firms into a fabricated one, and never carry a firm forward with a guessed date. Fewer, sourced entries beat a full list. Omit the key entirely when you have nothing. "target" is a number in the listed currency, "rating" the firm's own wording (Overweight / Buy / Neutral / Equal-Weight / Underperform). If the programme's company is private or unlisted, omit the key.
Rules on confidence: it is your calibrated probability that your analysis is correct and current, NOT how interesting the programme is. Be honest — a low score routes this to a stronger model, which is the system working, not a failure. Set escalate=true when the question genuinely needs deeper reasoning or evidence you cannot reach.
This is research, not investment advice. Never recommend buying or selling.`;

function taskPrompt(tier, row, registryChange, rulesFired) {
  const facts = [
    `Company: ${row.Company}${row.Ticker ? ` (${row.Ticker})` : ' (private)'}`,
    `Drug: ${row.Drug} — ${row.DrugType || 'type unknown'}`,
    `Indication: ${row.Indication}`,
    `Phase: ${row.Phase} · registry status: ${row.TrialStatus} · trial ${row.NCTId} (n=${row.Enrollment || '?'})`,
    `Phase history: ${row.PhaseHistory || '—'}`,
    `Current next milestone: ${row.NextMilestone || '—'}`,
  ].join('\n');
  const analysisKeys = ['outcomes', 'competition', 'marketSize', 'background'];
  const existing = analysisKeys
    .map(k => `${k}: ${String(row[k.charAt(0).toUpperCase() + k.slice(1)] || '—').slice(0, 600)}`).join('\n');
  const emptyFields = analysisKeys.filter(k => !String(row[k.charAt(0).toUpperCase() + k.slice(1)] || '').trim());
  const firstPass = emptyFields.length === analysisKeys.length;
  const depth = tier === 'haiku'
    ? (firstPass
      ? 'You are the daily tier, and this programme has NO analysis yet — every analyst field is empty. Populate what you can state accurately and briefly; leave a field out rather than guessing at it. If the programme needs research you cannot do from what you know, set escalate=true and say which fields need it.'
      : 'You are the cheap daily triage tier. Decide whether anything meaningfully changed. Update a field only if you are confident it is stale or wrong; otherwise return an empty analysis object and say so. Escalate rather than guess.')
    : tier === 'sonnet'
      ? `You are the weekly research tier. Refresh the analyst fields against what you know of recent company news, the FDA calendar, and the competitive landscape. Be specific about dates and sources. If the company is publicly listed, also scan for the current sell-side view from the major firms that actually cover biotech — ${ANALYST_FIRMS.slice(0, 10).join(', ')} — and report each rating/target you can source, per the priceTargets rules below.`
      : 'You are the deep-analysis tier. Work the primary evidence: trial design and endpoints, effect size against standard of care, each competitor\'s most recent readout, approval probability and timing, and a realistic revenue ramp. State the bear case explicitly and what would falsify your read.';
  return `${depth}

REGISTRY FACTS (authoritative, do not contradict or restate as your own analysis):
${facts}

CURRENT ANALYST TEXT (yours to correct):
${existing}

${emptyFields.length ? `FIELDS CURRENTLY EMPTY (populate these, do not skip them as "unchanged"): ${emptyFields.join(', ')}` : ''}
${!String(row.Ticker || '').trim() && !/university|hospital|institut|nih|national|centre|center|foundation|college/i.test(String(row.Company || '')) ? 'The Ticker column is empty. If this sponsor is publicly listed, return its exchange ticker as "ticker" at the top level of your JSON; if it is private, a subsidiary, or academic, omit the key.' : ''}
${registryChange ? `WHAT THE REGISTRY POLL JUST CHANGED: ${registryChange.diff.join('; ')}` : 'The registry poll found no change on this trial.'}
${rulesFired.length ? `HARD TRIGGERS ALREADY FIRED (this is being escalated regardless of your confidence): ${rulesFired.join('; ')}` : ''}

${VERDICT_CONTRACT}`;
}

function portfolioPrompt(rows) {
  const list = rows.map(r => `- ${r.Company}${r.Ticker ? ` (${r.Ticker})` : ''}: ${r.Drug}, ${r.Indication}, ${r.Phase} (${r.TrialStatus}), next: ${r.NextMilestone || '—'}`).join('\n');
  return `You are the monthly portfolio-review tier for a biotech clinical-trial tracker. Review the whole watchlist as a portfolio, not programme by programme.

WATCHLIST:
${list}

Assess: concentration risk (indication, modality, catalyst timing), which programmes have the most consequential catalysts in the next quarter, where the watchlist is thin or redundant, and which programmes no longer earn their place. This is research, not investment advice — never recommend buying or selling.

Return ONLY a JSON object:
{ "analysis": {}, "summary": "the portfolio review, 15-25 lines", "confidence": 0.0-1.0, "escalate": false, "escalate_reason": "" }`;
}

// ---------- the run ----------
async function run({ tier = 'daily', runId = String(Date.now()), deps }) {
  const now = deps.now || new Date();
  // deps.callModel lets tests drive the escalation machinery without spending anything
  const model = deps.callModel || callModel;
  const log = [];
  const summary = { runId, tier, at: deps.nowIso(), trials: 0, registryChanges: 0, byTier: {}, escalations: { rule: 0, confidence: 0 }, circuitBreaker: false, cost: 0, errors: [] };

  const rows = (await deps.readTrials()).filter(r => r.Status !== 'removed');
  summary.trials = rows.length;
  if (!rows.length) return summary;

  // Stage 0 — the deterministic registry poll. No model, no cost, and it produces the
  // phase-transition facts the hard rules key on.
  const registryChanges = {};
  for (const r of rows) {
    if (!/^NCT\d{8}$/i.test(String(r.NCTId || '').trim())) continue;
    let s;
    try { s = (await deps.ctgFetch({ 'query.id': String(r.NCTId).trim().toUpperCase(), pageSize: '1' }))[0]; }
    catch (e) { summary.errors.push(`registry ${r.NCTId}: ${e.message}`); continue; }
    if (!s) continue;
    const upd = {}, diff = [];
    const set = (col, val) => { if (val && String(val) !== String(r[col] || '')) { upd[col] = String(val); diff.push(`${col}: ${r[col] || '—'} → ${val}`); } };
    set('TrialStatus', s.trialStatus);
    set('Enrollment', s.enrollment || '');
    const BEYOND = ['Approved', 'FDA Review', 'Preclinical'];
    const prevPhase = String(r.Phase || '').trim(); // captured before the row is mutated below
    const phaseChanged = !BEYOND.includes(prevPhase) && s.phase && s.phase !== prevPhase;
    if (phaseChanged) set('Phase', s.phase);
    if (Object.keys(upd).length) {
      await deps.updateTrial(r.ID, upd).catch(e => summary.errors.push(`update ${r.ID}: ${e.message}`));
      Object.assign(r, upd);
      registryChanges[r.ID] = { diff, phaseChanged, from: prevPhase, to: s.phase };
      summary.registryChanges++;
    }
  }

  // Monthly is a portfolio pass, not a per-trial sweep — one Opus call over everything.
  if (tier === 'monthly') {
    const res = await model('opus', portfolioPrompt(rows)).catch(e => ({ error: e.message }));
    if (res.error) {
      if (/paid fallback is off|no LLM transport|no claude CLI/.test(res.error)) summary.notify = `analysis pipeline could not run: ${res.error}`;
      summary.errors.push(`portfolio: ${res.error}`);
      return summary;
    }
    let v; try { v = parseVerdict(res.text); } catch (e) { summary.errors.push(`portfolio parse: ${e.message}`); return summary; }
    summary.cost += res.cost || 0;
    summary.portfolioReview = v.summary;
    summary.byTier.opus = 1;
    log.push([deps.nowIso(), runId, 'opus', res.model, '', '', 'PORTFOLIO', '', v.confidence, '0', '', 'monthly review', '0', '', res.cost || 0, cryptoId()]);
    await deps.appendLog(log).catch(e => summary.errors.push(`log: ${e.message}`));
    return summary;
  }

  // Per-trial escalation chain. The breaker counts only confidence escalations, and only
  // once enough tasks have run for the ratio to mean anything.
  const entry = ENTRY_TIER[tier] || 'haiku';
  // A "task" is one TRIAL, not one tier call — otherwise a single trial escalating twice
  // reads as a 2-of-3 escalation rate and trips the breaker on its own.
  let tasksDone = 0, tasksConfidenceEscalated = 0, breakerTripped = false;
  const BREAKER_MIN_TASKS = 4; // below this the ratio is noise, not calibration evidence

  for (const row of rows) {
    const change = registryChanges[row.ID] || null;
    const rulesFired = await hardRules(row, change, now);
    let tierIdx = TIER_CHAIN.indexOf(entry);
    let thisTrialEscalatedOnConfidence = false;

    while (tierIdx < TIER_CHAIN.length) {
      const t = TIER_CHAIN[tierIdx];
      let res, v;
      const prompt = taskPrompt(t, row, change, tierIdx === TIER_CHAIN.indexOf(entry) ? rulesFired : []);
      try {
        res = await model(t, prompt);
        v = parseVerdict(res.text);
      } catch (e) {
        // No transport is a whole-run condition, not a per-trial one: retrying it nine times
        // just produces nine copies of the same message. Stop and surface it for notification.
        if (e instanceof NoFreeTransport || /paid fallback is off|no LLM transport/.test(e.message)) {
          summary.notify = `analysis pipeline could not run: ${e.message}`;
          summary.errors.push(summary.notify);
          console.error('[bio-pipeline]', summary.notify);
          await deps.appendLog(log).catch(() => {});
          summary.cost = +summary.cost.toFixed(4);
          return summary;
        }
        // One retry with the failure quoted back. Bad JSON and truncation are stochastic,
        // and re-asking is far cheaper than losing the trial from the run.
        try {
          res = await model(t, `${prompt}\n\nYour previous attempt failed with: ${e.message}\nReturn ONLY the JSON object, nothing else, and keep every field short enough to finish.`);
          v = parseVerdict(res.text);
          summary.retries = (summary.retries || 0) + 1;
        } catch (e2) {
          summary.errors.push(`${t} ${row.Company}/${row.Drug}: ${e2.message} (after retry)`);
          break;
        }
      }
      summary.cost += res.cost || 0;
      summary.byTier[t] = (summary.byTier[t] || 0) + 1;

      // Rules first: they fire regardless of confidence and regardless of the breaker.
      const ceiling = TIER_CHAIN.indexOf(ceilingFor(row));
      const canClimb = tierIdx < ceiling; // the ceiling, not the end of the chain
      const ruleEscalate = rulesFired.length > 0 && canClimb;
      // Confidence escalation is the discretionary kind — the breaker gates exactly this.
      const wantsConfidenceEscalation = (v.confidence < deps.confidenceThreshold || v.escalate) && canClimb;
      const confidenceEscalate = wantsConfidenceEscalation && !breakerTripped;
      if (wantsConfidenceEscalation) thisTrialEscalatedOnConfidence = true;

      const escalated = ruleEscalate || confidenceEscalate;
      if (ruleEscalate) summary.escalations.rule++;
      if (confidenceEscalate) summary.escalations.confidence++;

      log.push([deps.nowIso(), runId, t, res.model, row.ID, row.NCTId || '', row.Company, row.Drug,
        v.confidence, escalated ? '1' : '0',
        escalated ? (ruleEscalate ? rulesFired.join('; ') : (v.escalateReason || `confidence ${v.confidence} < ${deps.confidenceThreshold}`)) : '',
        rulesFired.join('; ') + (canClimb ? '' : ` [ceiling ${ceilingFor(row)}]`),
        breakerTripped ? '1' : '0', '', res.cost || 0, cryptoId()]);

      // Write the analysis through, stamping which tier produced each field. The highest
      // tier to touch a field wins, because it ran last.
      await writeAnalysis(deps, row, v, t, res.model).catch(e => summary.errors.push(`write ${row.ID}: ${e.message}`));

      if (!escalated) break;
      tierIdx++;
    }

    // One trial finished its chain — now the ratio has a well-defined denominator.
    tasksDone++;
    if (thisTrialEscalatedOnConfidence) tasksConfidenceEscalated++;
    if (!breakerTripped && tasksDone >= BREAKER_MIN_TASKS && (tasksConfidenceEscalated / tasksDone) > deps.breakerRatio) {
      breakerTripped = true;
      summary.circuitBreaker = true;
      summary.calibrationNote = `calibration needed — model may be too conservative: ${tasksConfidenceEscalated}/${tasksDone} tasks escalated on confidence (threshold ${deps.confidenceThreshold}). Confidence escalations paused for the rest of this run; rule-based escalations continue.`;
      console.warn('[bio-pipeline]', summary.calibrationNote);
    }
  }

  await deps.appendLog(log).catch(e => summary.errors.push(`log: ${e.message}`));
  summary.cost = +summary.cost.toFixed(4);
  return summary;
}

async function writeAnalysis(deps, row, verdict, tier, model) {
  const map = { outcomes: 'Outcomes', competition: 'Competition', marketSize: 'MarketSize', background: 'Background', nextMilestone: 'NextMilestone' };
  const changes = {};
  let prov = {};
  try { prov = JSON.parse(row.Provenance || '{}'); } catch (e) {}
  for (const [k, col] of Object.entries(map)) {
    const val = verdict.analysis[k];
    if (typeof val !== 'string' || !val.trim()) continue;
    changes[col] = val.trim();
    prov[col] = { tier, model, confidence: verdict.confidence, at: deps.nowIso() };
  }
  if (verdict.ticker && !String(row.Ticker || '').trim()) {
    changes.Ticker = verdict.ticker;
    changes.Public = '1';
  }
  if (Array.isArray(verdict.priceTargets) && verdict.priceTargets.length) {
    changes.PriceTargets = JSON.stringify(verdict.priceTargets.slice(0, 16));
    prov.PriceTargets = { tier, model, confidence: verdict.confidence, at: deps.nowIso() };
  }
  if (!Object.keys(changes).length) return;
  changes.Provenance = JSON.stringify(prov);
  await deps.updateTrial(row.ID, changes);
  Object.assign(row, changes);
}

const cryptoId = () => require('crypto').randomUUID();

module.exports = { run, callModel, NoFreeTransport, parseVerdict, hardRules, fdaWithin30d, weeklyMove, MODELS, TIER_CHAIN, ENTRY_TIER };

// Cloud Run Job entrypoint: `node bio-pipeline.js --tier=daily`. Builds its own deps from
// the Sheets API so the Job needs no dashboard instance to be up.
if (require.main === module) {
  (async () => {
    const tier = (process.argv.find(a => a.startsWith('--tier=')) || '--tier=daily').split('=')[1];
    const deps = await require('./bio-pipeline-standalone')();
    const summary = await run({ tier, runId: `job-${Date.now().toString(36)}`, deps });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.errors.length) process.exitCode = 1;
  })().catch(e => { console.error(e); process.exit(1); });
}
