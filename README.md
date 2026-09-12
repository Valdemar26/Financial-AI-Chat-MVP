# Financial AI Chat

Upload Excel/PDF financial data, ask questions about it in plain English, get back a text answer, a chart, or a table — chosen by the model, not by a UI toggle.

**Live:** https://financial-ai-chat-mvp.vercel.app

## Stack

- Angular 21 (standalone components, signals)
- Chart.js for chart rendering, SheetJS (`xlsx`) for spreadsheet parsing
- Claude (`claude-sonnet-4-6`) via the Anthropic Messages API, called through a Vercel Edge Function (`api/claude.js`) that holds the API key server-side
- Deployed on Vercel

## Running locally

```bash
npm install
ng serve
```

The dev server proxies `/api/*` to the deployed function (see `proxy.conf.json`), so you need a Vercel deployment with `ANTHROPIC_API_KEY` set, or run `vercel dev` locally with a `.env.local` containing that key.

## Engineering decisions

A few choices here aren't defaults you get from reading the Anthropic docs — worth knowing why they're there before an interview asks.

- **`tool_choice: {type: 'any'}` used as the structured-output mechanism.** Every response — even a plain text answer — is forced through one of three tools (`answer_question`, `render_chart`, `render_table`). This removes free-text parsing entirely: the client never has to guess whether a response is prose or data, it only ever handles typed tool input.

- **Streaming is a transport detail here, not a progressive-render feature.** The client (`src/app/services/claude.ts`) reads the SSE stream manually — no Anthropic SDK stream helper — to get `usage` fields as early as possible and to accumulate `input_json_delta` chunks. But because the model is forced to call a tool, there's no plain-text content block to stream token-by-token into the UI; the full tool call is parsed once at `content_block_stop`. So streaming buys early usage data and an open connection, not a typing-indicator effect. Framing it as "token-by-token UI" would be inaccurate.

- **Manual SSE parsing handles chunk boundaries explicitly.** `TextDecoder` runs in streaming mode, the buffer is split on `\n\n`, and the last (possibly incomplete) segment is put back rather than parsed — the standard spot where naive SSE clients silently drop or mis-parse a message that arrives split across two `read()` calls.

- **Prompt caching has two separate breakpoints, not one.** `cache_control: {type: 'ephemeral'}` is set on the system prompt and, independently, on each uploaded PDF document block. The PDF is only ever attached to the latest user message, so the cache breakpoint stays stable across turns instead of moving every time history grows.

- **The server rebuilds the entire API payload — the client only supplies `messages` and raw file text.** `api/claude.js` fixes the model, `max_tokens`, `stream`, the system prompt template, and the tool definitions itself. Nothing in the client's request body — not even the tool schemas — reaches the Anthropic API unmodified. This closed a real gap: an earlier version forwarded the client's `system` string through with only a truthy check, which meant anyone hitting the endpoint directly (no auth exists) could run arbitrary prompts through the server's Anthropic key.

- **There's no rate limiting on the endpoint, and that's a known, accepted gap — not an oversight.** An in-memory per-IP counter used to sit here, but on Vercel's Edge Runtime each instance has its own memory, so it never enforced a real shared limit. It's been removed rather than left in as false reassurance. What actually bounds the blast radius today is that the endpoint can only run one fixed job (fixed model, fixed prompt, fixed tools) — not request volume, which is currently unbounded. A shared counter (Upstash/Vercel KV) is the correct fix and is deliberately not in this codebase yet.
