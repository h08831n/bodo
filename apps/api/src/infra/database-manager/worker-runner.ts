import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { Logger } from '@nestjs/common';
import { getEnv } from '../../config/env.config';
import { DatabaseManagerService } from './database-manager.service';
import { JobQueueService, AdminJobData } from './job-queue.service';

export class AdminWorkerRunner {
  private readonly logger = new Logger(AdminWorkerRunner.name);
  private worker?: Worker<AdminJobData, unknown, string>;
  private heartbeatInterval?: NodeJS.Timeout;
  private redisClient?: Redis;
  private isShuttingDown = false;

  constructor(
    private readonly dbManager: DatabaseManagerService,
    private readonly jobQueue: JobQueueService,
  ) {}

  async start(): Promise<void> {
    const env = getEnv();
    this.logger.log('Starting Bodo Admin Worker...');

    // 1. Connect Redis client for Worker heartbeat
    this.redisClient = new Redis(env.REDIS_URL, {
      password: env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });

    // 2. Start Worker Heartbeat (writes worker:heartbeat every 10s with 30s TTL)
    await this.writeHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.writeHeartbeat().catch((err) => {
        this.logger.warn(`Failed to write worker heartbeat: ${err}`);
      });
    }, 10000);

    // 3. Check for orphan temporary databases and leaked ALLOW_CONNECTIONS = false
    try {
      const orphans = await this.dbManager.checkOrphans();
      if (orphans.droppedOrphans.length > 0) {
        this.logger.log(`Cleaned up ${orphans.droppedOrphans.length} orphan temporary databases.`);
      }
      if (orphans.lockedDbs.length > 0) {
        this.logger.warn(
          `Detected ${orphans.lockedDbs.length} databases with datallowconn = false. Run repair if needed.`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(`Orphan check on startup encountered an issue: ${err}`);
    }

    // 4. Start BullMQ Worker on 'admin-ops' queue with concurrency 2
    const workerConnection = new Redis(env.REDIS_URL, {
      password: env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker<AdminJobData, unknown, string>(
      'admin-ops',
      async (job: Job<AdminJobData, unknown, string>) => {
        return this.processJob(job);
      },
      {
        connection: workerConnection as never,
        concurrency: 2,
      },
    );

    this.worker.on('active', (job) => {
      this.logger.log(`Processing job ${job.id} (${job.data.type} on ${job.data.database})...`);
    });

    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} (${job.data.type}) completed successfully.`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} (${job?.data.type}) failed: ${err.message}`);
    });

    this.logger.log('Bodo Admin Worker is active and listening for jobs on "admin-ops" queue.');
  }

  private async processJob(job: Job<AdminJobData, unknown, string>): Promise<unknown> {
    const { type, database, payload } = job.data;
    const jobId = String(job.id);

    // 1. Acquire per-database distributed lock in Redis
    const acquired = await this.jobQueue.acquireDatabaseLock(database, jobId);
    if (!acquired) {
      throw new Error(`Database "${database}" is currently locked by another active operation`);
    }

    const onProgress = async (percent: number, step: string, message: string) => {
      await job.updateProgress({ percent, step, message });
    };

    try {
      switch (type) {
        case 'create':
          return await this.dbManager.createDatabase(
            payload as {
              name: string;
              adminUsername: string;
              adminFullName: string;
              adminPassword: string;
            },
            onProgress,
          );

        case 'duplicate':
          return await this.dbManager.duplicateDatabase(
            payload.sourceDatabase as string,
            payload as { newName: string; neutralize: boolean },
            onProgress,
          );

        case 'backup':
          return await this.dbManager.backupDatabase(database, onProgress);

        case 'restore':
          return await this.dbManager.restoreDatabase(
            payload.zipPath as string,
            payload as { newName: string; neutralize: boolean },
            onProgress,
          );

        case 'delete':
          return await this.dbManager.deleteDatabase(
            database,
            payload.confirmName as string,
            onProgress,
          );

        case 'upgrade':
          return await this.dbManager.upgradeDatabase(database, onProgress);

        default:
          throw new Error(`Unknown job type: "${type}"`);
      }
    } finally {
      // Always release distributed lock in finally
      await this.jobQueue.releaseDatabaseLock(database, jobId);
    }
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.redisClient || this.isShuttingDown) return;
    try {
      await this.redisClient.set('worker:heartbeat', String(Date.now()), 'EX', 30);
    } catch {
      // Ignore network hiccup
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('Shutting down Admin Worker...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }

    if (this.redisClient) {
      // Clear heartbeat key on graceful stop
      await this.redisClient.del('worker:heartbeat').catch(() => {});
      this.redisClient.disconnect();
      this.redisClient = undefined;
    }

    this.logger.log('Admin Worker shut down cleanly.');
  }
}
