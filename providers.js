// Multi-model API module — provider-agnostic text + image generation.
// Providers: Vertex AI Gemini/Imagen (same SA as Sheets — keyless on Cloud Run),
// local claude CLI (Mac, subscription), Anthropic API (placeholder until a key is set).
// See GEMINI_SETUP.md for the GCP enablement steps and Gemini-API-vs-Vertex explainer.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { GoogleAuth } = require('google-auth-library');

const PROJECT = require('./config').gcpProject; // '' = Vertex features off
// 'global' serves Gemini from the nearest region; override with e.g. europe-west4
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const IMAGEN_MODEL = process.env.IMAGEN_MODEL || 'imagen-3.0-generate-002';
const KEY_FILE = require('./config').keyFile;
const CLAUDE_BIN = process.env.CLAUDE_BIN || ['/opt/homebrew/bin/claude','/usr/bin/claude','/usr/local/bin/claude'].find(x => fs.existsSync(x)) || '';

// Vertex needs the cloud-platform scope — broader than the Sheets client's, so it
// gets its own GoogleAuth (same key-file-or-ADC fallback as server.js).
const vertexAuth = fs.existsSync(KEY_FILE)
  ? new GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

function vertexUrl(model, verb) {
  const host = VERTEX_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:${verb}`;
}

async function vertexFetch(model, verb, body) {
  const client = await vertexAuth.getClient();
  const { token } = await client.getAccessToken();
  const r = await fetch(vertexUrl(model, verb), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`vertex ${model} HTTP ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ---------- text providers ----------

const { logUsage } = require('./bin/log-usage');

// ---------- embeddings (Vertex gemini-embedding-001) ----------
const EMBED_MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIM = parseInt(process.env.EMBED_DIM || '768', 10); // compact, plenty for taste-clustering
// Embed one text → a vector. Batch callers loop with limited concurrency (the model
// takes one instance per predict). Cheap: ~$0.15/1M input tokens, output free.
async function embedText(text) {
  const j = await vertexFetch(EMBED_MODEL, 'predict', {
    instances: [{ task_type: 'SEMANTIC_SIMILARITY', content: String(text || '').slice(0, 2000) }],
    parameters: { outputDimensionality: EMBED_DIM },
  });
  const vec = j.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(vec)) throw new Error('embed: no vector (' + JSON.stringify(j).slice(0, 200) + ')');
  return vec;
}

async function geminiText(prompt, model = GEMINI_MODEL, module = 'generate-text') {
  const j = await vertexFetch(model, 'generateContent', {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // 2.5 models spend "thinking" tokens out of maxOutputTokens too — 4096 was silently
    // truncating long JSON replies (news/describe). The cap is a ceiling, not a spend.
    generationConfig: { temperature: 0.4, maxOutputTokens: 32768 },
  });
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('gemini: empty response');
  const um = j.usageMetadata || {};
  logUsage({ module, model, input: um.promptTokenCount, output: um.candidatesTokenCount, costUsd: '', note: 'vertex' }).catch(() => {});
  return text.trim();
}

function claudeCliText(prompt) {
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_BIN, ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'],
      { timeout: 120000, cwd: os.tmpdir(), maxBuffer: 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
  });
}

async function grokText(prompt) {
  // xAI Grok — reserved for NEWS queries (data-sharing tier accepted by the owner).
  if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY not set');
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.XAI_MODEL || 'grok-4-fast', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`xai HTTP ${r.status}: ${j.error?.message || j.error || ''}`);
  const u = j.usage || {};
  logUsage({ module: 'grok', model: j.model || 'grok-4-fast', input: u.prompt_tokens, output: u.completion_tokens, costUsd: '', note: 'xai' }).catch(() => {});
  return (j.choices?.[0]?.message?.content || '').trim();
}

// xAI Agent Tools API (/v1/responses) — real-time search, grounded with citations.
// Reserved for grok's PROPRIETARY X access: tools defaults to x_search only. Callers that
// genuinely need web search must opt in explicitly with { tools: ['web_search','x_search'] }.
async function grokAgent(prompt, { tools = ['x_search'] } = {}) {
  if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY not set');
  const r = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.XAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.XAI_AGENT_MODEL || 'grok-4.3', input: [{ role: 'user', content: prompt }], tools: tools.map(t => ({ type: t })) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`xai responses HTTP ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`);
  let text = '';
  if (typeof j.output_text === 'string') text = j.output_text;
  else if (Array.isArray(j.output)) for (const item of j.output) {
    if (item.type === 'message' && Array.isArray(item.content)) for (const c of item.content) text += (c.text || c.output_text || '');
  }
  const u = j.usage || {};
  logUsage({ module: 'grok', model: j.model || 'grok-4.3', input: u.input_tokens || u.prompt_tokens, output: u.output_tokens || u.completion_tokens, costUsd: '', note: 'xai+tools' }).catch(() => {});
  return text.trim();
}

// APA cross-provider eval — now routed through the agent-stable adapters (stable/adapters.js).
// The host builds the adapter config from env HERE (keys never enter agent-stable); bespoke
// providers (Claude CLI, Vertex) come in as injected fns; everything OpenAI-compatible —
// including hosted OS providers and local Ollama/LM Studio — shares one implementation.
const { createAdapters } = require('./stable/adapters');
const apaAdapters = createAdapters({
  anthropic: { fn: (model, prompt) => new Promise((resolve, reject) => execFile(CLAUDE_BIN, ['-p', prompt, '--model', model, '--output-format', 'json'],
    { timeout: 90000, cwd: os.tmpdir(), maxBuffer: 2 * 1024 * 1024 },
    (e, out) => { if (e) return reject(e); try { const j = JSON.parse(out); resolve({ text: String(j.result || '').trim(), usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 } }); } catch (x) { reject(x); } })) },
  google: { fn: async (model, prompt) => {
    const j = await vertexFetch(model, 'generateContent', { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } });
    const um = j.usageMetadata || {};
    return { text: (j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '').trim(), usage: { input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0 } };
  } },
  openai: process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : null,
  xai: process.env.XAI_API_KEY ? { apiKey: process.env.XAI_API_KEY } : null,
  // hosted / local paths for OPEN-WEIGHT models (Meta, DeepSeek, Qwen, GLM…) — first configured wins
  openrouter: (require('./config').openrouterKey) ? { apiKey: require('./config').openrouterKey } : null,
  together: process.env.TOGETHER_API_KEY ? { apiKey: process.env.TOGETHER_API_KEY } : null,
  ollama: process.env.OLLAMA_URL ? { baseUrl: process.env.OLLAMA_URL } : { },  // local, keyless — probed at call time
});
// ---------- OpenRouter market feed (keyless — no account needed for prices) ----------
// One cached fetch per 6h of openrouter.ai/api/v1/models (~340 models): live per-token
// prices across hosted providers, and the id catalog. Two uses: (a) live price fallback
// for the tiers / form-guide endpoints when the board has no price; (b) resolving APA's
// scraped model names ("deepseek-v4-pro-max") to runnable OpenRouter ids
// ("deepseek/…") so candidate probes work. Feed failure degrades to the stale cache.
let orCache = { at: 0, list: null };
async function openrouterModels() {
  if (Date.now() - orCache.at < 6 * 3600000 && orCache.list) return orCache.list;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = ((await r.json()).data || []).map(m => ({
      id: m.id,
      priceIn: m.pricing && m.pricing.prompt != null ? +m.pricing.prompt * 1e6 : null,
      priceOut: m.pricing && m.pricing.completion != null ? +m.pricing.completion * 1e6 : null,
    })).filter(m => m.id);
    if (list.length) orCache = { at: Date.now(), list };
  } catch (e) { console.error('openrouter feed:', e.message); }
  return orCache.list || [];
}
const orNorm = s => String(s || '').toLowerCase().replace(/-20\d{6}$/, '').replace(/[^a-z0-9]/g, '');
const orTail = id => orNorm(String(id).split('/').pop());
// exact tail match, else a UNIQUE prefix match (either direction) — ambiguity returns the
// input unchanged so a wrong model is never silently probed ("gpt-5" must not hit "gpt-5-6-luna")
async function openrouterResolveId(model) {
  const want = orNorm(model);
  if (!want) return model;
  const list = await openrouterModels();
  const exact = list.find(m => orTail(m.id) === want);
  if (exact) return exact.id;
  const near = list.filter(m => orTail(m.id).startsWith(want) || want.startsWith(orTail(m.id)));
  return near.length === 1 ? near[0].id : model;
}
async function openrouterPrice(model) {
  const want = orNorm(model);
  if (!want) return null;
  const hit = (await openrouterModels()).find(m => orTail(m.id) === want);
  return hit && hit.priceOut != null ? { in: hit.priceIn, out: hit.priceOut } : null;
}

function apaProviderFor(modelId, lab) {
  const l = String(lab || '').toLowerCase(), id = String(modelId || '').toLowerCase();
  if (/anthropic|claude/.test(l) || /^claude/.test(id)) return 'anthropic';
  if (/openai|gpt/.test(l)) return 'openai';
  if (/google|gemini|deepmind/.test(l)) return 'google';
  if (/xai|grok/.test(l)) return 'xai';
  // open-weight / other labs → hosted or local, whichever is configured
  for (const p of ['openrouter', 'together', 'ollama']) { try { if (apaAdapters.providers().includes(p)) return p; } catch (e) {} }
  return null;
}
// Back-compat signature (returns text). Throws if no runnable path — caller falls back to "recommend".
async function apaModelText(modelId, lab, prompt) {
  const provider = apaProviderFor(modelId, lab);
  if (!provider) throw new Error('no eval path for lab ' + lab);
  const runId = provider === 'openrouter' ? await openrouterResolveId(modelId) : modelId;
  const out = await apaAdapters.call({ provider, model: runId, prompt });
  logUsage({ module: 'apa-eval', model: out.model || modelId, input: out.usage.input, output: out.usage.output, costUsd: '', note: provider + ' ' + out.latencyMs + 'ms' }).catch(() => {});
  return out.text;
}

async function openaiText(prompt) {
  // OpenAI — GPT-5-nano = cheapest frontier; comparator for low-cost eval.
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5-nano', messages: [{ role: 'user', content: prompt }], max_completion_tokens: 2048 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${j.error?.message || ''}`);
  const u = j.usage || {};
  logUsage({ module: 'openai', model: j.model || 'gpt-5-nano', input: u.prompt_tokens, output: u.completion_tokens, costUsd: '', note: 'openai' }).catch(() => {});
  return (j.choices?.[0]?.message?.content || '').trim();
}

async function anthropicText(prompt, model, module) {
  // Activates when ANTHROPIC_API_KEY is set — the stub's default LLM path when no claude
  // CLI is installed. Accepts the same loose model hints runClaude passes ("claude-sonnet-5"
  // etc.); anything unrecognized falls back to the env/model default.
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const m = model && /^claude-/.test(model) ? model : (process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: m,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`anthropic HTTP ${r.status}: ${j.error?.message || ''}`);
  const u = j.usage || {};
  logUsage({ module: module || 'anthropic-api', model: j.model || m, input: u.input_tokens, output: u.output_tokens, costUsd: '', note: 'api' }).catch(() => {});
  return (j.content || []).map(b => b.text || '').join('').trim();
}

// ---------- image (Imagen text-to-image via Vertex :predict) ----------

async function imagenImage(prompt, { count = 1, aspectRatio = '1:1' } = {}) {
  const j = await vertexFetch(IMAGEN_MODEL, 'predict', {
    instances: [{ prompt }],
    parameters: { sampleCount: Math.min(count, 4), aspectRatio },
  });
  const preds = j.predictions || [];
  if (!preds.length) throw new Error('imagen: no predictions (prompt may have been safety-filtered)');
  logUsage({ module: 'generate-image', model: IMAGEN_MODEL, input: '', output: '', costUsd: '', note: `${preds.length} image(s) ~$0.03 ea` }).catch(() => {});
  return preds.map(p => ({
    mime: p.mimeType || 'image/png',
    dataUrl: `data:${p.mimeType || 'image/png'};base64,${p.bytesBase64Encoded}`,
  }));
}

// ---------- detection + fallback chains ----------

let vertexProbe = null; // { ok, error, at }
async function probeVertex() {
  if (vertexProbe && Date.now() - vertexProbe.at < 10 * 60 * 1000) return vertexProbe;
  try {
    await geminiText('Reply with exactly: ok');
    vertexProbe = { ok: true, at: Date.now() };
  } catch (e) {
    vertexProbe = { ok: false, error: e.message, at: Date.now() };
  }
  return vertexProbe;
}

async function listProviders() {
  const v = await probeVertex();
  return {
    text: [
      { id: 'vertex-gemini', model: GEMINI_MODEL, location: VERTEX_LOCATION, available: v.ok, error: v.error },
      { id: 'claude-cli', model: 'haiku (subscription)', available: fs.existsSync(CLAUDE_BIN) },
      { id: 'anthropic-api', model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5', available: !!process.env.ANTHROPIC_API_KEY, note: 'set ANTHROPIC_API_KEY to activate' },
      { id: 'grok', model: process.env.XAI_MODEL || 'grok-4-fast', available: !!process.env.XAI_API_KEY, note: 'news/X queries only; set XAI_API_KEY' },
      { id: 'openai', model: process.env.OPENAI_MODEL || 'gpt-5-nano', available: !!process.env.OPENAI_API_KEY, note: 'low-cost frontier eval; set OPENAI_API_KEY' },
    ],
    image: [
      { id: 'vertex-imagen', model: IMAGEN_MODEL, available: v.ok, error: v.error },
    ],
  };
}

const TEXT_CHAIN = { 'vertex-gemini': geminiText, 'claude-cli': claudeCliText, 'anthropic-api': anthropicText, 'grok': grokText, 'openai': openaiText };

// Try the requested provider first (if any), then the rest of the chain in order.
async function generateText(prompt, preferred) {
  const order = [...new Set([preferred, 'vertex-gemini', 'claude-cli', 'anthropic-api'].filter(Boolean))];
  const errors = {};
  for (const id of order) {
    const fn = TEXT_CHAIN[id];
    if (!fn) { errors[id] = 'unknown provider'; continue; }
    try {
      const text = await fn(prompt);
      return { provider: id, text, fallbacksTried: errors };
    } catch (e) { errors[id] = e.message; }
  }
  throw new Error('all text providers failed: ' + JSON.stringify(errors));
}

async function generateImage(prompt, opts) {
  // single image provider today; chain extends here when another lands
  const images = await imagenImage(prompt, opts || {});
  return { provider: 'vertex-imagen', images };
}

module.exports = { listProviders, generateText, generateImage, embedText, geminiText, grokText, grokAgent, apaModelText, apaAdapters, apaProviderFor, probeVertex, openrouterModels, openrouterResolveId, openrouterPrice, GEMINI_MODEL, EMBED_MODEL, EMBED_DIM, IMAGEN_MODEL, VERTEX_LOCATION };
