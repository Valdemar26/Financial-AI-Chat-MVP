import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: string; db: boolean }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: true };
    } catch {
      throw new HttpException({ status: 'error', db: false }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
