import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../common/types/authenticated-request.js';
import { AnthropicService, extractAnswerText } from '../anthropic/anthropic.service.js';
import { ConversationsService } from './conversations.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { PaginationQueryDto } from './dto/pagination-query.dto.js';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly anthropic: AnthropicService,
  ) {}

  @Get()
  list(@Query() query: PaginationQueryDto, @Req() req: AuthenticatedRequest) {
    return this.conversations.list(req.user.userId, query.limit, query.offset);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest) {
    return this.conversations.create(req.user.userId);
  }

  @Get(':id')
  getOne(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.conversations.getWithMessages(id, req.user.userId, query.limit, query.offset);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.conversations.remove(id, req.user.userId);
  }

  @Post(':id/messages')
  async postMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.conversations.findOwned(id, req.user.userId);
    await this.conversations.addUserMessage(id, dto.content);

    const history = await this.conversations.getHistory(id);

    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    let upstream: globalThis.Response;
    try {
      upstream = await this.anthropic.streamMessage(history, dto.context ?? '', abortController.signal);
    } catch {
      res.status(HttpStatus.BAD_GATEWAY).json({ error: 'Upstream request failed' });
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      res.status(upstream.status || HttpStatus.BAD_GATEWAY).type('application/json').send(detail);
      return;
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const { toolName, input, usage } = await this.anthropic.consumeStream(upstream.body, (chunk) => {
      res.write(chunk);
    });

    res.end();

    const answer = extractAnswerText(toolName, input);
    await this.conversations.addAssistantMessage(id, answer, input, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    });
    await this.conversations.touch(id);
  }
}
