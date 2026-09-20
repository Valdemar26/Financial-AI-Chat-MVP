import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../common/types/authenticated-request.js';
import { DocumentsService } from './documents.service.js';

@UseGuards(JwtAuthGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id/url')
  async getSignedUrl(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ url: string }> {
    const url = await this.documents.getSignedUrl(id, req.user.userId);
    return { url };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.documents.remove(id, req.user.userId);
  }
}
