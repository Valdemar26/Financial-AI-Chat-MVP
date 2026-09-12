export const config = { runtime: 'edge' };

// Server-side policy — the client cannot override any of this. The client only
// ever sends `messages` (chat history, plus any PDF documents already embedded
// in the last user message) and `context` (the raw extracted file data as
// plain text). It never sends system, tools, or tool_choice — those are fixed
// here so a request can never be turned into a proxy for arbitrary prompts.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_BODY_BYTES = 6 * 1024 * 1024; // uploaded PDFs arrive base64-encoded

const TOOLS = [
  {
    name: 'answer_question',
    description: 'Return a plain text answer to the user question',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'render_chart',
    description: 'Render a chart when user asks for visualization, graph, or chart',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'doughnut', 'pie', 'line'] },
        title: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        datasets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              data: { type: 'array', items: { type: 'number' } },
            },
          },
        },
        summary: { type: 'string' },
      },
      required: ['type', 'title', 'labels', 'datasets', 'summary'],
    },
  },
  {
    name: 'render_table',
    description: 'Render a data table when user asks for a list, top-N, or comparison',
    input_schema: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
        summary: { type: 'string' },
      },
      required: ['columns', 'rows', 'summary'],
    },
  },
];

function systemPrompt(context) {
  return `You are a financial data analyst. Analyze the data below and answer questions accurately.

  The user has uploaded one or more files. Each file is marked with "=== FILE: filename ===".
  When relevant, treat them as related data sources — for example, financial data and location data may correlate. Mention which file the answer comes from when it adds clarity.

  ${context}

  Always call exactly one tool per response:
  - answer_question → for text answers
  - render_chart → when user asks for chart/graph/visualization
  - render_table → when user asks for list, top-N, ranking, or comparison table`;
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'API key not configured' }, 500);
  }

  // No rate limiting here — see note below the payload rebuild for why that's
  // an intentional gap, not an oversight.

  let raw;
  try {
    raw = await req.text();
  } catch {
    return json({ error: 'Could not read request body' }, 400);
  }

  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'Payload too large' }, 413);
  }

  let incoming;
  try {
    incoming = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(incoming.messages) || incoming.messages.length === 0) {
    return json({ error: 'messages must be a non-empty array' }, 400);
  }

  if (incoming.context !== undefined && typeof incoming.context !== 'string') {
    return json({ error: 'context must be a string' }, 400);
  }

  // Rebuild the payload from scratch. The client cannot influence model,
  // max_tokens, stream, system, tools, or tool_choice — only `messages` and
  // `context` (raw file text) cross the wire from it. This is what keeps the
  // endpoint from being repurposed as a general-purpose proxy to the key: even
  // with no auth, a caller can only ever run "financial data analyst over the
  // data it sends" through these three fixed tools, never an arbitrary prompt
  // or an arbitrary tool schema.
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: [
      {
        type: 'text',
        text: systemPrompt(incoming.context ?? ''),
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: TOOLS,
    tool_choice: { type: 'any' },
    messages: incoming.messages,
  };

  // There is deliberately no rate limiter here anymore (the previous in-memory
  // per-IP counter didn't work anyway — Edge Runtime spins up multiple
  // isolated instances, each with its own Map, so it never actually enforced
  // a shared limit). What bounds abuse now is that this endpoint can only do
  // one fixed job — the model, system prompt and tools above are not
  // negotiable from the request — not request volume. Volume itself is
  // unbounded until a real shared counter (Upstash/Vercel KV) is added; that
  // is a known, accepted gap, not something to route around.

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      // Pass the status through, but do not leak upstream headers.
      return new Response(detail, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return json({ error: 'Client disconnected' }, 499);
    }
    return json({ error: 'Upstream request failed' }, 502);
  }
}
