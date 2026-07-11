# Architecture

One Node process, no build step, one dense HTML page. Everything below is the *pattern* —
your instance fills in the specifics through config and plugins, never by forking.

## The process

`server.js` serves the page and every `/api/*` route. State goes through a **storage
adapter** (`store/`): local JSON files by default (zero accounts, boots blank), or Google
Sheets when you configure a spreadsheet — which is also what unlocks running more than one
instance against the same data.

## Tiers (optional)

A single instance on your own machine is a complete deployment. The multi-tier pattern,
if you grow into it:

- **Serverless container** (e.g. Cloud Run) — the always-reachable web tier. Stateless:
  local JSON is cache only; durable writes ride the shared store. No LLM keys required.
- **Your workstation** — the trusted tier. Holds whatever only you should hold (LLM
  subscription/CLI auth, private files, journal). Runs the scheduled agent jobs.
- **A small always-on VM** — optional failover that watches the workstation's heartbeat
  stamp and covers cloud-capable stages when it's dark.

Tiers converge through the shared store: versioned config envelopes (newest write wins,
manual edits never silently lost) and append-only queues that a capable tier drains.

## LLM access

`runClaude()` resolves in order: plugin routers → claude CLI (subscription) → Anthropic
API key. Each layer is optional; features degrade one by one and say so in the UI
(`/api/capabilities` drives what the frontend shows). No key, no spend — every
LLM-backed route refuses cleanly when nothing is configured.

## Model procurement

The [agent-stable](https://github.com/TheDavidLevitt/agent-stable) modules (`stable/`)
meter every call by source-of-funds, benchmark the market per use-case tier, and gate
model adoption (equal-or-better ∧ cheaper, reversible, logged). Your agent roster is
instance config (`data/agents-roster.json`); the agents page renders it joined with
live usage.

## Plugins

Drop a JS file in `plugins/` to add sections, API routes, jobs, news sources, health
rows, or LLM routing — see `plugins/README.md` for the hook surface. Plugins are
gitignored: your private extensions live beside the code, upgrades stay `git pull`.
