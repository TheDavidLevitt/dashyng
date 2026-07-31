<div align="center">

<img src="assets/hero.svg" alt="agent-stable — cost-performance management for a stable of AI models" width="100%">

[![CI](https://github.com/TheDavidLevitt/agent-stable/actions/workflows/test.yml/badge.svg)](https://github.com/TheDavidLevitt/agent-stable/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/agent-stable?color=cb3837&logo=npm)](https://www.npmjs.com/package/agent-stable)
[![node](https://img.shields.io/node/v/agent-stable?color=339933&logo=node.js&logoColor=white)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

**Cost-performance management for a stable of AI models.** Meter every call, classify **whose
money it was** (subscription · credits · out-of-pocket), benchmark the market by use case, and
let a procurement agent test new models and adopt cheaper-or-better ones — automatically,
reversibly, and with every decision logged.

Born inside a personal AI chief-of-staff system that runs a dozen agents across three deployment
tiers; extracted module by module so anyone can run it.

## Why

Every multi-agent app quietly accumulates the same questions:

- *What did my agents actually spend this week — and was it real money or a credit pool that
  expires next month?*
- *A new model shipped yesterday. Is it better than what I'm running? Is it cheaper? Who checks?*
- *Which benchmark actually predicts quality for **my** tasks, and what's the minimum score
  that's good enough?*

agent-stable answers these continuously instead of the night you get the invoice.

## The stable

Downstream agents don't ask for model names — they ask for a **tier**, and the stable answers
with the current model, its real cost, and anything time- or token-sensitive:

- **workhorse** — the cheapest adequate model: mechanical extraction, classification, bulk work.
- **steeldust** — your daily driver; the orchestration layer, escalation from workhorse:
  thesis-led summaries, judgment calls, routing decisions.
- **thoroughbred** — a top-tier reasoning model; hard analysis, escalation from steeldust.
- **secretariat** — the stable *on steroids*: a top long-horizon model for multi-hour
  autonomous work, escalation from thoroughbred. Named for the horse that won the Belmont
  by 31 lengths — the long-distance record that still stands.

```js
const tiers = createTiers({ incumbent: t => store.incumbent(t), priceOf: pricing.priceOf,
  costClass: m => pricing.costClass(m), advisories: (m, t) => myCreditWarnings(m) });
tiers.escalate('workhorse')
// → { tier: 'steeldust', model: 'claude-sonnet-5', price: { in: 3, out: 15 },
//     fundingClass: 'credit', advisories: ['$2/$10 intro pricing through 2026-08-31'] }
```

So a bot can run cheap by default, request escalation when it's out of its depth, and be told
exactly what it will spend — and whose money that is — before it commits.

## How the modules run

```mermaid
flowchart TB
  subgraph you["Your app / agents"]
    CALL["LLM call"]
  end

  subgraph core["agent-stable core"]
    ADP["adapters.js\nuniform call() across providers\n(OpenAI-compat × 8 + injected fns)"]
    MET["meter.js\nnormalize event → cost $ +\nfunding class + latency"]
    PRC["pricing.js\nprice table · costClass()\nself-host estimator"]
    APA["apa.js — decision engine\nevaluate(cand vs incumbent)\nprojectSavings() · adoptGate()"]
    BRD["board.js\ntier assignment over sourced\nbenchmark rows (e.g. AA API)"]
  end

  subgraph sinks["sinks/ (pluggable)"]
    S1[("memory")]
    S2[("JSONL")]
    S3[("Google Sheet")]
  end

  subgraph host["Host app supplies"]
    LLM["judge / scan LLM"]
    STORE["store (overrides, roles,\ncutoffs, credit pools)"]
    NOTIFY["notify (journal, Slack,\nconsole …)"]
    UI["dashboard UI\nplots · use-case editor ·\ncredits panel"]
  end

  CALL --> ADP
  ADP -->|"text + usage + latency"| MET
  PRC --> MET
  MET -->|"record(event)"| S1 & S2 & S3

  SCAN["scan loop (host cron):\nmodel releases · price cuts ·\nbenchmark shifts · credit status"] --> APA
  LLM --> APA
  ADP --> APA
  PRC --> APA
  APA -->|"verdict + projected $/mo"| GATE{"adoptGate\nequal-or-better ∧ cheaper\n∧ autoAdopt?"}
  GATE -->|adopt| STORE
  GATE -->|propose| NOTIFY
  BRD --> LLM
  LLM --> BRD
  BRD -->|"models × cost × scores\n+ cutoff hypotheses"| STORE
  STORE --> UI
  S3 --> UI
```

Data flow in one sentence: **adapters** make any model callable, the **meter** prices and
funding-classifies every call into a **sink**, the **APA engine** uses the same adapters to
head-to-head-test new models against your incumbent and gates adoption, and the **board**
compiles the market (cost × benchmarks × your thresholds) so the whole loop is inspectable.

## What a host builds on it

<img src="assets/board.svg" alt="Mockup of a host dashboard's procurement board: market table with per-tier benchmarks and funding chips, APA adoption proposal with one-click revert, and a funding panel splitting charged vs credit vs included" width="100%">

*The procurement board a host renders from `board.js` output + meter events (mockup, sample
data): the market table with per-tier benchmarks and source-of-funds chips, the APA's gated
adoption proposal, and the funding panel that never confuses expiring credit with cash.*

## The ideas that matter

1. **Source-of-funds, not just cost.** Every event is classified `real` (out-of-pocket),
   `credit` (finite pools — cloud credits, promo allowances), or `included` (flat-rate
   subscription). A dollar of expiring credit is not a dollar of cash; the procurement agent
   treats expiring credits as near-free when weighing arbitrage.
2. **Use cases own thresholds.** Each tier (workhorse, steeldust, thoroughbred — plus any
   custom roles like "X access") owns a benchmark that predicts quality for it and a minimum
   score. The engine's hypothesis fills the gap until you set one; your manual edits are
   provenance-tracked and never silently overridden.
3. **Reversible autonomy.** Auto-adopt fires only when a candidate is *runnable* (a model that
   can't be probed can never be adopted), *equal-or-better* (judged head-to-head on your task
   suite), and *cheaper*. Every adoption logs its rationale and projected monthly saving, and
   reverts in one click.
4. **Stated assumptions.** Hosted open-weight prices name the host. Self-hosting appears as a
   single reference line computed from an editable `watts × tok/s × $/kWh` formula — labeled as
   an electricity-only estimate, never dressed up as per-model truth.

## Quickstart

```js
const { createMeter, createAdapters, createApa, pricing, sinks } = require('agent-stable');

const sink = sinks.memorySink();
const meter = createMeter({ sink, pricing, host: 'my-app' });

const adapters = createAdapters({
  openai: { apiKey: process.env.OPENAI_API_KEY },
  ollama: {},                                        // local, keyless
});

// meter any call
const out = await meter.wrap(
  () => adapters.call({ provider: 'openai', model: 'gpt-5.1', prompt: 'hello' }),
  { module: 'greeter', model: 'gpt-5.1', extract: r => r.usage },
);

// let the engine judge a candidate against your incumbent
const apa = createApa({ adapters, priceOf: pricing.priceOf,
  judge: p => adapters.call({ provider: 'openai', model: 'gpt-5.1', prompt: p }).then(r => r.text),
  usageHistory: async () => sink.query({ type: 'usage' }) });
const verdict = await apa.evaluate({ id: 'candidate', provider: 'ollama' }, { id: 'gpt-5.1', provider: 'openai' });
console.log(apa.adoptGate(verdict, { autoAdopt: true }));
```

Run the no-network demo — `node demo.js` replays the whole loop:

<img src="assets/demo.svg" alt="Animated terminal replay of node demo.js: meter three calls, judge a challenger head-to-head, gate adoption, project $204/mo saving" width="100%">

## Module status

| Module | | What it does |
|---|:---:|---|
| [`pricing.js`](pricing.js) | ✅ | price table (edit for your stack) · `costClass()` · `selfHostPerMTok()` |
| [`meter.js`](meter.js) | ✅ | usage/decision events → cost + funding class + latency → sink; `wrap()` |
| [`sinks/`](sinks) | ✅ | memory · JSONL · Google Sheet (client injected) — SQLite · Postgres planned |
| [`adapters.js`](adapters.js) | ✅ | one OpenAI-compat impl covers openai / xai / openrouter / together / fireworks / groq / ollama / lmstudio; bespoke providers injected as fns; keys injected |
| [`apa.js`](apa.js) | ✅ | `evaluate` · `projectSavings` · `adoptGate` · `considerFinding` — the full decision flow with Store/Notify injected: swap a Sheet+journal for a JSON-file+Slack and it behaves identically. Scan-prompt *assembly* stays host-side by design — it is context-gathering (credit pools, source scoreboard) from host systems. |
| [`tiers.js`](tiers.js) | ✅ | tier-addressed resolution: `resolve('workhorse')` / `escalate()` → model + real cost + funding class + time-sensitive advisories, for downstream agents |
| [`board.js`](board.js) | 🟡 | compile/parse for market board + benchmark knowledge base (persistence host-side) |
| `server.js` | ⬜ | standalone HTTP surface + starter dashboard (second package) |

## Design rules

1. **Pure core.** Modules take data in, return data out. No filesystem, network, env, or key
   access — all I/O is injected by the host.
2. **One-way boundary.** Hosts consume agent-stable outputs; agent-stable never imports host code.
3. **Stated assumptions.** Every cost number carries its basis (API list, scraped-with-source,
   hosted-with-host-name, or the editable self-host formula).
4. **Human-sovereign config.** Roles, benchmarks, thresholds, and credit pools are user-editable;
   the learning loop refines them from outcomes but manual edits win.
5. **Reversible autonomy.** Adopt decisions are gated, probe-guarded, logged with projected
   savings, and revertible per module.

## License

MIT
