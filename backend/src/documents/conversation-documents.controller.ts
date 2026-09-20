import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../common/types/authenticated-request.js';
import { DocumentsService } from './documents.service.js';
import { documentUploadOptions } from './file-upload.options.js';

@UseGuards(JwtAuthGuard)
@Controller('conversations/:id/documents')
export class ConversationDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@Param('id') conversationId: string, @Req() req: AuthenticatedRequest) {
    return this.documents.listForConversation(conversationId, req.user.userId);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  upload(
    @Param('id') conversationId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.documents.upload(conversationId, req.user.userId, file);
  }
}
