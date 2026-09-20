import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SupabaseStorageService } from '../supabase-storage/supabase-storage.service.js';
import { ConversationDocumentsController } from './conversation-documents.controller.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ConversationDocumentsController, DocumentsController],
  providers: [DocumentsService, SupabaseStorageService],
})
export class DocumentsModule {}
