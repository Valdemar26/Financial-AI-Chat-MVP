import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnthropicService } from '../anthropic/anthropic.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, AnthropicService],
})
export class ConversationsModule {}
