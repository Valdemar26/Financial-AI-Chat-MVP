import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Document } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseStorageService } from '../supabase-storage/supabase-storage.service.js';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  private async assertOwnsConversation(conversationId: string, userId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userId !== userId) {
      throw new ForbiddenException('You do not have access to this conversation');
    }
  }

  private async findOwnedDocument(documentId: string, userId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { conversation: true },
    });
    if (!document) {
      throw new NotFoundException('Document not found');
    }
    if (document.conversation.userId !== userId) {
      throw new ForbiddenException('You do not have access to this document');
    }
    return document;
  }

  async listForConversation(conversationId: string, userId: string): Promise<Document[]> {
    await this.assertOwnsConversation(conversationId, userId);
    return this.prisma.document.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upload(
    conversationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<Document> {
    await this.assertOwnsConversation(conversationId, userId);

    const storageKey = `${userId}/${conversationId}/${randomUUID()}-${file.originalname}`;
    await this.storage.upload(file.buffer, storageKey);

    return this.prisma.document.create({
      data: {
        conversationId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
      },
    });
  }

  async getSignedUrl(documentId: string, userId: string): Promise<string> {
    const document = await this.findOwnedDocument(documentId, userId);
    return this.storage.getSignedUrl(document.storageKey);
  }

  async remove(documentId: string, userId: string): Promise<void> {
    const document = await this.findOwnedDocument(documentId, userId);
    await this.storage.remove(document.storageKey);
    await this.prisma.document.delete({ where: { id: documentId } });
  }
}
