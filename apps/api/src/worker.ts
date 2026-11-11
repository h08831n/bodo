import { getEnv } from './config/env.config';
import { LoggerService } from './common/logger/logger.service';

async function bootstrapWorker() {
  const env = getEnv();
  const logger = new LoggerService();

  logger.log(
    `Bodo Background Worker started successfully in environment: ${env.NODE_ENV}`,
    'WorkerBootstrap',
  );

  // Setup graceful termination handlers
  const shutdown = (signal: string) => {
    logger.log(`Worker received ${signal}, shutting down gracefully...`, 'WorkerShutdown');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.log('Worker is idling, waiting for jobs...', 'Worker');
}

bootstrapWorker().catch((err) => {
  console.error('[CRITICAL] Failed to bootstrap Worker:', err);
  process.exit(1);
});
