import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Ported from the original root-level api/claude.js proxy: same model, same
// max_tokens, same fixed tool set with tool_choice: 'any', and the same
// ephemeral cache_control on the system prompt. The client can only ever
// influence `messages` and `context` — model/system/tools stay fixed here.
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

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

function systemPrompt(context: string): string {
  return `You are a financial data analyst. Analyze the data below and answer questions accurately.

  The user has uploaded one or more files. Each file is marked with "=== FILE: filename ===".
  When relevant, treat them as related data sources — for example, financial data and location data may correlate. Mention which file the answer comes from when it adds clarity.

  ${context}

  Always call exactly one tool per response:
  - answer_question → for text answers
  - render_chart → when user asks for chart/graph/visualization
  - render_table → when user asks for list, top-N, ranking, or comparison table`;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrittenTokens: number;
}

export interface AnthropicStreamResult {
  toolName: string;
  input: unknown;
  usage: AnthropicUsage;
}

@Injectable()
export class AnthropicService {
  constructor(private readonly config: ConfigService) {}

  async streamMessage(
    messages: AnthropicMessage[],
    context: string,
    signal?: AbortSignal,
  ): Promise<globalThis.Response> {
    const apiKey = this.config.getOrThrow<string>('ANTHROPIC_API_KEY');

    const payload = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: [
        {
          type: 'text',
          text: systemPrompt(context),
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: TOOLS,
      tool_choice: { type: 'any' },
      messages,
    };

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal,
    });
  }

  // Consumes the upstream SSE body exactly once: forwards every raw chunk to
  // `onChunk` unmodified (so the client gets the identical wire format the
  // Angular ClaudeService already knows how to parse) while accumulating the
  // same content_block/message events client-side parsing relies on, so the
  // finished tool call and token usage can be persisted server-side too.
  async consumeStream(
    body: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<AnthropicStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let currentToolName = '';
    let accumulatedJson = '';
    let finalToolName = '';
    let finalInput: unknown;

    const usage: AnthropicUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrittenTokens: 0,
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value);

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const eventBlock of events) {
        const dataLine = eventBlock.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;

        const dataStr = dataLine.slice(6).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        let event: Record<string, any>;
        try {
          event = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (event['type'] === 'message_start') {
          const u = event['message']?.usage;
          if (u) {
            usage.inputTokens = u.input_tokens ?? 0;
            usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
            usage.cacheWrittenTokens = u.cache_creation_input_tokens ?? 0;
          }
          continue;
        }

        if (event['type'] === 'message_delta') {
          const outputTokens = event['usage']?.output_tokens;
          if (outputTokens) usage.outputTokens = outputTokens;
          continue;
        }

        if (event['type'] === 'content_block_start') {
          currentToolName = event['content_block']?.name ?? '';
          accumulatedJson = '';
          continue;
        }

        if (event['type'] === 'content_block_delta' && event['delta']?.type === 'input_json_delta') {
          accumulatedJson += event['delta'].partial_json ?? '';
          continue;
        }

        if (event['type'] === 'content_block_stop' && accumulatedJson) {
          try {
            finalInput = JSON.parse(accumulatedJson);
            finalToolName = currentToolName;
          } catch {
            // Malformed tool JSON: leave finalInput unset, caller falls back.
          }
        }
      }
    }

    return { toolName: finalToolName, input: finalInput, usage };
  }
}

export function extractAnswerText(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;

  if (toolName === 'answer_question') {
    return typeof record['text'] === 'string' ? record['text'] : '';
  }
  if (toolName === 'render_chart' || toolName === 'render_table') {
    return typeof record['summary'] === 'string' ? record['summary'] : '';
  }
  return '';
}
