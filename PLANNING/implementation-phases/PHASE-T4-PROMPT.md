# Phase T4: portal view

**Read first:** `public/app/app.js` (routes, `ctx`), `public/app/js/views/chats.js`, `public/app/js/dom.js`, `public/app/app.css`.

## Tasks

1. `public/app/js/views/traces.js`: a Traces route that works without a GEO project.
   - List: app picker, All or Errors, search, Traces and Sessions tabs, table with start time, name, input, output, status, latency, tokens, cost, spans. Load more.
   - Trace page (`#/traces/<traceId>`): span tree with a timeline bar per span, and a detail pane with messages, tool calls, retrieved documents, attributes and events.
   - Empty state and a "Send traces" panel with the endpoint and copyable exporter settings.
2. Register the route and icon in `app.js` and `dom.js`; styles in `app.css` using existing tokens only.
3. `scripts/demo/generate.ts`: sample traces for the demo workspace (an agent with tool calls, a retrieval chain, an error).
4. Check in a browser at desktop width, 375px and dark mode, per `CLAUDE.md`.

## Success criteria

- [ ] With demo data, the list, a trace page and a session open without console errors.
- [ ] The trace page is usable at 375px (tree and detail stack).
- [ ] Light and dark both read well; no colours outside the tokens.
- [ ] `npm run check` passes.
