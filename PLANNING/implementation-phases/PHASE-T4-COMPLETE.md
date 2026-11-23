# Phase T4 complete: portal view

- `public/app/js/views/traces.js`: Traces route (works without a GEO project). List with app picker, All or Errors, search, headline numbers, Load more; Sessions tab; trace page with span tree, timeline bars and a detail pane (messages, tool calls, tools offered, retrieved documents, attributes, events); "Send traces" panel with copyable settings.
- `public/app/app.js`, `public/app/js/dom.js`, `public/app/app.css`: route, icon and styles from existing tokens.
- `scripts/demo/traces.ts`: 70 sample traces in two apps for the demo workspace (agent with a tool call, retrieval chain, tool timeouts, conversations).

## Checked in a browser (offline dev server, demo data)

- Desktop 1440px dark: list, trace page, LLM span with messages and tool call, retriever span with three documents, attributes tab.
- 375px light: list fits without sideways scrolling, trace page stacks tree above detail, failed trace opens on the failed span with its message.
- Sessions tab lists 20 conversations; opening one filters the trace list to it.
- Search, the Errors filter and the "Send traces" panel at both widths.

Bugs found and fixed during the check: the first page sent `cursor=null`; a stray "null" on the trace page; tree indentation not applied; code blocks clipped in the panel; the list overflowing at 375px.

## Success criteria

- [x] With demo data, the list, a trace page and a session open.
- [x] The trace page is usable at 375px.
- [x] Light and dark both read well; colours come from tokens.
- [x] `npm run check` passes.
- [ ] Not checked: the browser console was not captured during the walkthrough, and the view has no automated test.
