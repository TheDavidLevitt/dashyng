# dashyng — a personal command-center dashboard

One dense, dark, phone-friendly page for running your day — built to pair with
[agent-stable](https://github.com/TheDavidLevitt/agent-stable), the zero-dependency
model-fleet manager. Every section is a blank canvas: rename it, hide it, reorder it,
wire it to your own systems, or leave it empty until you need it.

**Task lists** — N drag-everything lists (Eisenhower quadrants by default): reorder, resize
on a snap lattice, bullets or ranked, per-list webhooks (HMAC-signed, retried) so a list can
feed any external system. **Habits** — daily/weekly/monthly/custom (LLM-parsed) frequency,
checkbox/number/text tracking, JSON export. **Calendar** — Google Calendar and/or iCal URLs,
Today plus a condensed look-ahead strip. **Markets** — GUI-configurable tiles: quotes,
futures strips, yield curves, drag-to-group plots. **News** — describe the feed you want in
one paragraph (✨) and an agent maintains sources/subjects/people/places config; swipe
feedback tunes salience over time. **Agent Stable** — live model-fleet usage, cost split,
and procurement events from agent-stable. **Plugins** — drop a JS file in `plugins/` to add
sections, API routes, jobs, news sources, health rows, or LLM routing — no fork needed.

## Quickstart (5 minutes, zero accounts)

```bash
git clone https://github.com/TheDavidLevitt/dashyng && cd dashyng
npm install
npm start        # → http://localhost:3000
```

That's it — the dashboard boots on **local JSON storage** with empty sections and inline
setup hints. Add capabilities as you want them:

| Capability | How |
|---|---|
| LLM features (✨ Describe, summaries, custom habit schedules) | `ANTHROPIC_API_KEY=…` (or install the claude CLI for web-search-powered features) |
| Google Sheets storage (multi-device/multi-tier sync) | create a service account, share a spreadsheet with it, set `DASHBOARD_SHEET_ID` + `DASHBOARD_KEY_FILE` |
| Calendar | share your Google calendar with the service-account email shown in ⚙, or paste any iCal URL |
| Markets | works out of the box (Yahoo Finance, cached) |
| X/Twitter "Following" section | `XAI_API_KEY=…` |

Copy `.env.example` for the full list, or put the same keys in `data/config-local.json`
(gitignored — the file wins over env).

## Personalizing without forking

Your instance is this repo + untracked local files. Everything below is gitignored:

- `data/config-local.json` — identity, storage IDs, salience profile, filesystem roots
- `plugins/*.js` — private sections/routes/jobs/news-sources/LLM-routers
  (see `plugins/README.md` for the full hook surface)
- `data/*` runtime state

Upgrade = `git pull`. If you can't express a customization through config or a plugin hook,
that's a bug in the hook surface — open an issue.

## Architecture

Single Node process, no build step, one HTML page. Storage is an adapter
(`store/`): local JSON by default, Google Sheets for the multi-tier setup (append-only
protocol, cross-instance settings sync, work queues). LLM calls go
plugin-routers → claude CLI → Anthropic API, degrading feature-by-feature when absent.
`public/ARCHITECTURE.md` has the full map.

## Pairing with agent-stable

The Agent Stable section reads usage/decision/procurement data written in
[agent-stable](https://github.com/TheDavidLevitt/agent-stable)'s conventions (Usage /
Decisions / APA Feed tabs) and renders the fleet: per-module model routing, funding-class
cost split (real / credit / included), auto-adoption events, benchmark board.

## License

MIT
