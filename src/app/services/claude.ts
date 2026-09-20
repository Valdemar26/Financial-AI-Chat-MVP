import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChartData } from '../components/chart/chart';
import { AuthService } from './auth';

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
  onDone: (result: ClaudeResponse) => void;
  onError: (error: string) => void;
}

export interface PersistedMessage {
  role: string;
  content: string;
  toolUse?: unknown;
}

export interface ConversationDetail {
  id: string;
  title: string | null;
  messages: PersistedMessage[];
}

export interface RestoredMessage {
  role: 'user' | 'assistant';
  text: string;
  chart?: ChartData;
  table?: TableData;
}

const CONVERSATION_STORAGE_KEY = 'activeConversationId';
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
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private dataContext = '';

  readonly conversationId = signal<string | null>(this.readStoredConversationId());

  setDataContext(context: string): void {
    this.dataContext = context;
  }

  async ensureConversation(): Promise<string> {
    const existing = this.conversationId();
    if (existing) return existing;

    const created = await firstValueFrom(
      this.http.post<{ id: string }>(`${environment.apiUrl}/conversations`, {}, { withCredentials: true })
    );
    this.conversationId.set(created.id);
    this.storeConversationId(created.id);
    return created.id;
  }

  async loadConversation(id: string): Promise<ConversationDetail | null> {
    try {
      const conversation = await firstValueFrom(
        this.http.get<ConversationDetail>(`${environment.apiUrl}/conversations/${id}`, { withCredentials: true })
      );
      this.conversationId.set(id);
      return conversation;
    } catch {
      this.resetConversation();
      return null;
    }
  }

  resetConversation(): void {
    this.conversationId.set(null);
    this.storeConversationId(null);
  }

  restoreMessages(messages: PersistedMessage[]): RestoredMessage[] {
    return messages.map(m => {
      if (m.role !== 'assistant') {
        return { role: 'user' as const, text: m.content };
      }
      const result = this.toClaudeResponse(m.content, m.toolUse);
      return { role: 'assistant' as const, text: result.answer, chart: result.chart, table: result.table };
    });
  }

  async chatStream(
    text: string,
    documentIds: string[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const conversationId = await this.ensureConversation();
    await this.streamWithRetry(conversationId, text, documentIds, callbacks, signal, false);
  }

  private async streamWithRetry(
    conversationId: string,
    text: string,
    documentIds: string[],
    callbacks: StreamCallbacks,
    signal: AbortSignal | undefined,
    isRetry: boolean
  ): Promise<void> {
    const token = this.auth.accessToken();

    let response: Response;

    try {
      response = await fetch(`${environment.apiUrl}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        credentials: 'include',
        body: JSON.stringify({ content: text, context: this.dataContext, documentIds }),
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

    if (response.status === 401 && !isRetry) {
      try {
        await this.auth.refreshToken();
      } catch {
        callbacks.onError('Session expired. Please sign in again.');
        return;
      }
      return this.streamWithRetry(conversationId, text, documentIds, callbacks, signal, true);
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

  private readStoredConversationId(): string | null {
    try {
      return sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private storeConversationId(id: string | null): void {
    try {
      if (id) {
        sessionStorage.setItem(CONVERSATION_STORAGE_KEY, id);
      } else {
        sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
      }
    } catch {
      // sessionStorage unavailable (e.g. private browsing) — conversation just won't survive reload.
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

  // Used to reconstruct chart/table results from persisted messages, where
  // the tool name itself isn't stored — only the raw tool input JSON is.
  private toClaudeResponse(content: string, toolUse: unknown): ClaudeResponse {
    if (isChartInput(toolUse)) {
      return {
        answer: toolUse.summary ?? content,
        chart: {
          type: toolUse.type,
          title: toolUse.title,
          labels: toolUse.labels,
          datasets: toolUse.datasets
        }
      };
    }
    if (isTableInput(toolUse)) {
      return {
        answer: toolUse.summary ?? content,
        table: {
          columns: toolUse.columns,
          rows: toolUse.rows
        }
      };
    }
    return { answer: content };
  }
}
