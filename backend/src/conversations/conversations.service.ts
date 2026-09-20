import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AnthropicMessage } from '../anthropic/anthropic.service.js';

const DEFAULT_CONVERSATIONS_LIMIT = 20;
const DEFAULT_MESSAGES_LIMIT = 50;

export interface AssistantMessageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

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
      },
    });
  }

  async touch(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({ where: { id: conversationId }, data: {} });
  }
}
