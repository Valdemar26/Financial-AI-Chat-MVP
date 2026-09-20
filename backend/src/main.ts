import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Credentialed requests (needed for the httpOnly refresh-token cookie) are
  // rejected by browsers when the origin is '*', so the frontend's dev origin
  // must be named explicitly here.
  app.enableCors({ origin: ['http://localhost:4200'], credentials: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
