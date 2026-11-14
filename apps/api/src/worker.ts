import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseManagerService } from './infra/database-manager/database-manager.service';
import { JobQueueService } from './infra/database-manager/job-queue.service';
import { AdminWorkerRunner } from './infra/database-manager/worker-runner';
import { AdminAuditLogger } from './infra/admin/admin-audit.logger';
import { LoggerService } from './common/logger/logger.service';

async function bootstrapWorker() {
  const logger = new LoggerService();
  logger.log('Bootstrapping Bodo Background Worker application context...', 'WorkerBootstrap');

  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger,
  });

  const dbManager = appContext.get(DatabaseManagerService);
  const jobQueue = appContext.get(JobQueueService);
  const auditLogger = appContext.get(AdminAuditLogger);

  const runner = new AdminWorkerRunner(dbManager, jobQueue, auditLogger);
  await runner.start();

  // Setup graceful termination handlers
  const shutdown = async (signal: string) => {
    logger.log(`Worker received ${signal}, shutting down gracefully...`, 'WorkerShutdown');
    await runner.stop();
    await appContext.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });
}

bootstrapWorker().catch((err) => {
  console.error('[CRITICAL] Failed to bootstrap Worker:', err);
  process.exit(1);
});
