import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getEnv } from './config/env.config';
import { LoggerService } from './common/logger/logger.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  // 1. Validate environment configuration on boot
  const env = getEnv();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(LoggerService);
  app.useLogger(logger);

  // 2. Global Exception Filter
  app.useGlobalFilters(new GlobalExceptionFilter(logger));

  // 3. Security Headers (helmet)
  app.use(helmet());

  // 4. CORS with allowed origins from env
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS policy'));
      }
    },
    credentials: true,
  });

  // 5. Graceful Shutdown
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  logger.log(
    `API application started successfully on port ${env.PORT} [${env.NODE_ENV}]`,
    'Bootstrap',
  );
}

bootstrap().catch((err) => {
  console.error('[CRITICAL] Failed to bootstrap NestJS application:', err);
  process.exit(1);
});
