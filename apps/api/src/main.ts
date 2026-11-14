import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import express from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { patchSwagger } from './common/swagger/patch-swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { getEnv } from './config/env.config';
import { LoggerService } from './common/logger/logger.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';

// Patch NestJS Swagger for automatic Zod schema reflection
patchSwagger();

async function bootstrap() {
  // 1. Validate environment configuration on boot
  const env = getEnv();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(LoggerService);
  app.useLogger(logger);

  // Trust proxy for secure and accurate client IP extraction behind Nginx
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  // Configure body limits
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // 2. Global Validation Pipe (nestjs-zod)
  app.useGlobalPipes(new ZodValidationPipe());

  // 3. Global Response Transformer Interceptor (UTC Date, Decimal/BigInt string, strip undefined)
  app.useGlobalInterceptors(new ResponseTransformInterceptor());

  // 4. Global Exception Filter
  app.useGlobalFilters(new GlobalExceptionFilter(logger));

  // 5. Security Headers (helmet)
  app.use(helmet());

  // 6. CORS with allowed origins from env
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

  // 7. Swagger Documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Bodo ERP API')
    .setDescription('Bodo Multi-Tenant Steel Trading ERP API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  // 8. Graceful Shutdown
  app.enableShutdownHooks();

  // 9. Tenancy Bootstrap (Rehydrate durable maintenance flags and optional auto-migrate)
  try {
    const { DatabaseRegistryService } = await import('./infra/tenancy/database-registry.service');
    const { MaintenanceService } = await import('./infra/tenancy/maintenance.service');
    const dbRegistry = app.get(DatabaseRegistryService);
    const maintenanceService = app.get(MaintenanceService);

    const activeDbs = await dbRegistry.listActive().catch(() => []);
    if (activeDbs.length > 0) {
      await maintenanceService.rehydrate(activeDbs).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed during maintenance rehydration: ${msg}`, 'Bootstrap');
      });
    }

    if (env.AUTO_MIGRATE) {
      logger.log(
        'AUTO_MIGRATE enabled: applying pending migrations to all active tenant databases...',
        'Bootstrap',
      );
      const { MigrationRunnerService } = await import('./infra/tenancy/migration-runner.service');
      const migrationRunner = app.get(MigrationRunnerService);
      await migrationRunner.upgradeAll();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Tenancy bootstrap check encountered non-fatal error: ${msg}`, 'Bootstrap');
  }

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
