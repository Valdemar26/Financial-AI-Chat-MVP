import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseStorageService } from '../supabase-storage/supabase-storage.service.js';
import type { AnthropicContentBlock, AnthropicMessage } from '../anthropic/anthropic.service.js';

const PDF_MIME_TYPE = 'application/pdf';

const DEFAULT_CONVERSATIONS_LIMIT = 20;
const DEFAULT_MESSAGES_LIMIT = 50;

export interface AssistantMessageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrittenTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  list(userId: string, limit?: number, offset?: number) {
    return this.prisma.conversation.findMany({
      where: { userId },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: limit ?? DEFAULT_CONVERSATIONS_LIMIT,
      skip: offset ?? 0,
    });
  }

  create(userId: string): Promise<Conversation> {
    return this.prisma.conversation.create({ data: { userId } });
  }

  async findOwned(id: string, userId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id } });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userId !== userId) {
      throw new ForbiddenException('You do not have access to this conversation');
    }
    return conversation;
  }

  async getWithMessages(id: string, userId: string, limit?: number, offset?: number) {
    const conversation = await this.findOwned(id, userId);
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: limit ?? DEFAULT_MESSAGES_LIMIT,
      skip: offset ?? 0,
    });
    return { ...conversation, messages };
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findOwned(id, userId);
    await this.prisma.conversation.delete({ where: { id } });
  }

  async getHistory(conversationId: string): Promise<AnthropicMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  // Ported from the old client-side ClaudeService.chatStream: PDFs are sent
  // to Anthropic as ephemeral-cached document blocks. Excel/CSV documents are
  // skipped here — they keep going through the plain-text `context` field.
  async resolveDocumentBlocks(documentIds: string[] | undefined, userId: string): Promise<AnthropicContentBlock[]> {
    if (!documentIds || documentIds.length === 0) return [];

    const blocks: AnthropicContentBlock[] = [];

    for (const documentId of documentIds) {
      const document = await this.prisma.document.findUnique({
        where: { id: documentId },
        include: { conversation: true },
      });
      if (!document) {
        throw new NotFoundException(`Document ${documentId} not found`);
      }
      if (document.conversation.userId !== userId) {
        throw new ForbiddenException(`You do not have access to document ${documentId}`);
      }
      if (document.mimeType !== PDF_MIME_TYPE) {
        continue;
      }

      const buffer = await this.storage.download(document.storageKey);
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: PDF_MIME_TYPE, data: buffer.toString('base64') },
        cache_control: { type: 'ephemeral' },
      });
    }

    return blocks;
  }

  // Prepends the document blocks to the latest (just-added) user message,
  // matching the { content: [...documents, {type:'text', ...}] } shape the
  // frontend used to build before this moved server-side.
  withDocumentBlocks(messages: AnthropicMessage[], documentBlocks: AnthropicContentBlock[]): AnthropicMessage[] {
    if (documentBlocks.length === 0) return messages;

    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (!last) return messages;

    const merged: AnthropicMessage = {
      role: last.role,
      content: [...documentBlocks, { type: 'text', text: last.content as string }],
    };

    return [...messages.slice(0, lastIndex), merged];
  }

  addUserMessage(conversationId: string, content: string) {
    return this.prisma.message.create({
      data: { conversationId, role: 'user', content },
    });
  }

  addAssistantMessage(
    conversationId: string,
    content: string,
    toolUse: unknown,
    tokens: AssistantMessageTokens,
  ) {
    return this.prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content,
        ...(toolUse !== undefined ? { toolUse: toolUse as Prisma.InputJsonValue } : {}),
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheWrittenTokens: tokens.cacheWrittenTokens,
        costUsd: tokens.costUsd,
        durationMs: tokens.durationMs,
      },
    });
  }

  async touch(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: {} });
  }
}
