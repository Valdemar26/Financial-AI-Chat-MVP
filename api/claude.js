export const config = { runtime: 'edge' };

// Server-side policy — the client cannot override any of this.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_BODY_BYTES = 6 * 1024 * 1024; // uploaded PDFs arrive base64-encoded
const ALLOWED_TOOLS = new Set(['answer_question', 'render_chart', 'render_table']);

// Simple in-memory per-IP limiter. Edge instances are short-lived, so this is a
// speed bump against casual abuse, not a hard guarantee. For anything stronger,
// move the counter to Vercel KV / Upstash.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
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

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  if (rateLimited(ip)) {
    return json({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
  }

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

  // Only forward the tools this app actually defines.
  const tools = Array.isArray(incoming.tools)
    ? incoming.tools.filter((t) => ALLOWED_TOOLS.has(t?.name))
    : undefined;

  // Rebuild the payload explicitly. Anything the client sent that is not on this
  // list is dropped — model, max_tokens and stream are decided here.
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: incoming.messages,
    ...(incoming.system ? { system: incoming.system } : {}),
    ...(tools?.length ? { tools, tool_choice: { type: 'any' } } : {}),
  };

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