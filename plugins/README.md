# Private plugin sections

Drop a `<name>.js` file here and it becomes a dashboard section — no fork needed. The public
repo ignores `plugins/*.js`, so private sections (family stuff, client work, anything not for
GitHub) live only on your machines. Copy `example.js.example` to `mything.js` to start.

A plugin exports:

```js
module.exports = {
  key: 'mything',            // unique; section appears as data-sec="plugin:mything"
  title: 'My thing',         // default section heading (renamable via ⚙ like any section)
  async data() { ... },      // server-side; result is served at /api/plugin/mything
  client: `(el, data) => {   // OPTIONAL browser renderer, evaluated as a function
    el.innerHTML = '<pre>' + JSON.stringify(data, null, 1) + '</pre>';
  }`,
};
```

Plugins are trusted local code (they run inside the server process). Order/visibility/title
are managed by the ⚙ panel like built-in sections. Deploy: the file must exist on each tier
that should show it (journal-touching plugins belong on the Mac only — cloud tiers simply
won't have the file and the section won't appear there).

## Beyond sections — the full hook surface (2026-07-05)

A plugin may export ANY combination of the hooks below. `ctx` is always
`{ store, config, runLLM }` — storage, instance config, and the LLM runner injected, same
philosophy as agent-stable (plugins do no raw I/O of their own unless they mean to).

```js
module.exports = {
  // 1. SECTION (original API) — key/title/data/client as above.

  // 2. ROUTES — register your own API endpoints at load time.
  routes(app, ctx) {
    app.get('/api/mything/refresh', async (req, res) => res.json({ ok: true }));
  },

  // 3. JOBS — recurring background work (first run after one interval; errors are logged,
  //    never fatal).
  jobs: [{ everyMs: 15 * 60000, async run(ctx) { /* poll something */ } }],

  // 4. NEWS SOURCES — extra sections folded into every /api/news response (same mechanism
  //    as Model Watch). Keep build() cheap: cache internally, return [] when nothing new.
  newsSources: [{
    title: 'My Feed',
    async build(ctx) { return [{ title: '…', link: 'https://…', source: 'mine', age: '2h' }]; },
  }],

  // 5. HEALTH ROWS — rows for the System-health panel.
  async healthRows(ctx) { return [{ name: 'mything', ok: true, info: 'last sync 07:00' }]; },
};
```

This hook surface is how instance-specific behavior stays out of the core: anything the
public stub shouldn’t ship (a personal feed, a house integration, a provider routing rule)
belongs in a plugin here, not in server.js.
