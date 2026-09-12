import { Injectable } from '@angular/core';
import { ChartData } from '../components/chart/chart';
import { UploadedFile } from './excel-parser';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TableData {
  columns: string[];
  rows: any[][];
}

export interface CacheStats {
  cacheRead: number;
  cacheWritten: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClaudeResponse {
  answer: string;
  chart?: ChartData;
  table?: TableData;
  cacheStats?: CacheStats;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onDone: (result: ClaudeResponse) => void;
  onError: (error: string) => void;
}

const CHART_TYPES: ChartData['type'][] = ['bar', 'doughnut', 'pie', 'line'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(v => typeof v === 'number');
}

function isChartInput(input: unknown): input is ChartData & { summary?: string } {
  if (typeof input !== 'object' || input === null) return false;
  const i = input as Record<string, unknown>;
  return (
    typeof i['type'] === 'string' &&
    CHART_TYPES.includes(i['type'] as ChartData['type']) &&
    typeof i['title'] === 'string' &&
    isStringArray(i['labels']) &&
    Array.isArray(i['datasets']) &&
    i['datasets'].every(ds =>
      typeof ds === 'object' && ds !== null &&
      typeof (ds as Record<string, unknown>)['label'] === 'string' &&
      isNumberArray((ds as Record<string, unknown>)['data'])
    )
  );
}

function isTableInput(input: unknown): input is TableData & { summary?: string } {
  if (typeof input !== 'object' || input === null) return false;
  const i = input as Record<string, unknown>;
  return (
    isStringArray(i['columns']) &&
    Array.isArray(i['rows']) &&
    i['rows'].every(row => Array.isArray(row))
  );
}

@Injectable({ providedIn: 'root' })
export class ClaudeService {
  private readonly API_URL = '/api/claude';
  private dataContext = '';

  setDataContext(context: string): void {
    this.dataContext = context;
  }

  async chatStream(
    history: ChatMessage[], 
    pdfs: UploadedFile[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {

    // Build messages array, prepending PDFs to the LATEST user message
    const messages = history.map((msg, idx) => {
      const isLatestUserMessage = idx === history.length - 1 && msg.role === 'user';

      if (isLatestUserMessage && pdfs.length > 0) {
        return {
          role: 'user',
          content: [
            ...pdfs.map(pdf => ({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.base64
              },
              cache_control: { type: 'ephemeral' }
            })),
            { type: 'text', text: msg.content }
          ]
        };
      }

      return msg;
    });

    let response: Response;

    try {
      response = await fetch(this.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Model, system prompt and tools are decided by the server — the
        // client only supplies the conversation and the raw file data.
        body: JSON.stringify({ messages, context: this.dataContext }),
        signal
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        callbacks.onError('⏹ Generation stopped');
        return;
      }
      callbacks.onError(`Network error: ${e?.message ?? e}`);
      return;
    }

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        const message = body?.error?.message ?? '';
        if (message.toLowerCase().includes('credit balance')) {
          errorMsg = '💳 API credits exhausted. Please add credits at console.anthropic.com';
        } else if (response.status === 429) {
          errorMsg = '⏱ Rate limit hit. Please wait a moment and try again.';
        } else if (message) {
          errorMsg = message;
        }
      } catch {}
      callbacks.onError(errorMsg);
      return;
    }

    let currentToolName = '';
    let accumulatedJson = '';
    let lastStreamedText = '';
    let cacheStats: CacheStats | undefined;

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events розділяються через \n\n
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // останній може бути неповний

        for (const eventBlock of events) {
          const dataLine = eventBlock.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;

          const dataStr = dataLine.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          let event: any;
          try { event = JSON.parse(dataStr); } catch { continue; }

          if (event.type === 'message_start') {
            const usage = event.message?.usage;
            if (usage) {
              cacheStats = {
                cacheRead: usage.cache_read_input_tokens ?? 0,
                cacheWritten: usage.cache_creation_input_tokens ?? 0,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: 0
              };
            }
            continue;
          }

          if (event.type === 'message_delta') {
            const outputTokens = event.usage?.output_tokens;
            if (outputTokens && cacheStats) {
              cacheStats.outputTokens = outputTokens;
            }
            continue;
          }

          if (event.type === 'content_block_start') {
            currentToolName = event.content_block?.name ?? '';
            accumulatedJson = '';
            lastStreamedText = '';
            continue;
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            accumulatedJson += event.delta.partial_json ?? '';
            continue;
          }

          if (event.type === 'content_block_stop' && accumulatedJson) {
            try {
              const input = JSON.parse(accumulatedJson);
              const result = this.buildResult(currentToolName, input);
              callbacks.onDone({ ...result, cacheStats });
            } catch (e) {
              callbacks.onError('Failed to parse tool response');
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        callbacks.onError('⏹ Generation stopped');
        return;
      }
      callbacks.onError(`Stream error: ${e?.message ?? e}`);
    }
  }

  private buildResult(toolName: string, input: unknown): ClaudeResponse {
    if (toolName === 'render_chart') {
      if (!isChartInput(input)) {
        return { answer: '⚠️ The model returned chart data in an unexpected format, so it could not be rendered. Try rephrasing the question.' };
      }
      return {
        answer: input.summary ?? '',
        chart: {
          type: input.type,
          title: input.title,
          labels: input.labels,
          datasets: input.datasets
        }
      };
    }
    if (toolName === 'render_table') {
      if (!isTableInput(input)) {
        return { answer: '⚠️ The model returned table data in an unexpected format, so it could not be rendered. Try rephrasing the question.' };
      }
      return {
        answer: input.summary ?? '',
        table: {
          columns: input.columns,
          rows: input.rows
        }
      };
    }
    const text = (input as Record<string, unknown> | null)?.['text'];
    return { answer: typeof text === 'string' ? text : '' };
  }
}
