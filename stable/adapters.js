// agent-stable · adapters — one uniform call() across providers.
//
//   const adapters = createAdapters({
//     anthropic:  { fn: (model, prompt, opts) => Promise<text|{text,usage}> },  // host-injected (e.g. Claude CLI)
//     google:     { fn: (model, prompt, opts) => Promise<text|{text,usage}> },  // host-injected (e.g. Vertex)
//     openai:     { apiKey },                                                   // OpenAI-compatible HTTP
//     xai:        { apiKey, baseUrl: 'https://api.x.ai/v1' },
//     openrouter: { apiKey, baseUrl: 'https://openrouter.ai/api/v1' },
//     together:   { apiKey, baseUrl: 'https://api.together.xyz/v1' },
//     ollama:     { baseUrl: 'http://localhost:11434/v1' },                     // local, keyless
//   });
//   const { text, usage, latencyMs } = await adapters.call({ provider:'openai', model:'gpt-5.1', prompt });
//
// Boundary rules: keys/endpoints are INJECTED by the host — nothing here reads env or disk.
// Everything speaking the OpenAI-compatible chat protocol (incl. hosted OS providers and local
// Ollama / LM Studio) shares one implementation; bespoke providers come in as injected fns.

const DEFAULT_BASE = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
};
const KEYLESS = new Set(['ollama', 'lmstudio']);

function createAdapters(cfg = {}, { fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;

  async function openaiCompat(name, c, { model, prompt, maxTokens = 2048, timeoutMs = 90000 }) {
    if (!KEYLESS.has(name) && !c.apiKey) throw new Error(name + ': no apiKey configured');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f((c.baseUrl || DEFAULT_BASE[name] || DEFAULT_BASE.openai) + '/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}: ${j.error?.message || j.error || ''}`);
      const u = j.usage || {};
      return { text: (j.choices?.[0]?.message?.content || '').trim(), usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }, model: j.model || model };
    } finally { clearTimeout(timer); }
  }

  async function call({ provider, model, prompt, maxTokens, timeoutMs } = {}) {
    const name = String(provider || '').toLowerCase();
    const c = cfg[name];
    if (!c) throw new Error('no adapter configured for provider ' + name);
    const t0 = Date.now();
    let out;
    if (typeof c.fn === 'function') {
      const r = await c.fn(model, prompt, { maxTokens, timeoutMs });
      out = typeof r === 'string' ? { text: r, usage: { input: 0, output: 0 }, model } : { usage: { input: 0, output: 0 }, model, ...r };
    } else {
      out = await openaiCompat(name, c, { model, prompt, maxTokens, timeoutMs });
    }
    if (!out.text) throw new Error(name + '/' + model + ': empty response');
    return { ...out, provider: name, latencyMs: Date.now() - t0 };
  }

  return { call, providers: () => Object.keys(cfg).filter(k => cfg[k]) };
}

module.exports = { createAdapters, DEFAULT_BASE };
