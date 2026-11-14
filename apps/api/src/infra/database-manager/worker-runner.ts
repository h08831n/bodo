import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { Logger, HttpException } from '@nestjs/common';
import { getEnv } from '../../config/env.config';
import { DatabaseManagerService } from './database-manager.service';
import { JobQueueService, AdminJobData } from './job-queue.service';
import { AdminAuditLogger } from '../admin/admin-audit.logger';

export class AdminWorkerRunner {
  private readonly logger = new Logger(AdminWorkerRunner.name);
  private worker?: Worker<AdminJobData, unknown, string>;
  private heartbeatInterval?: NodeJS.Timeout;
  private redisClient?: Redis;
  private isShuttingDown = false;

  constructor(
    private readonly dbManager: DatabaseManagerService,
    private readonly jobQueue: JobQueueService,
    private readonly auditLogger?: AdminAuditLogger,
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
    const { type, database, payload, requestId = 'N/A', clientIp = '127.0.0.1' } = job.data;
    const jobId = String(job.id);
    const actionName = `${type.toUpperCase()}_DATABASE`;

    // 1. Acquire per-database distributed lock in Redis
    const acquired = await this.jobQueue.acquireDatabaseLock(database, jobId);
    if (!acquired) {
      const lockError = `Database "${database}" is currently locked by another active operation`;
      this.auditLogger?.log({
        ip: clientIp,
        action: actionName,
        target: database,
        status: 'FAILURE',
        jobId,
        requestId,
        error: lockError,
      });
      throw new Error(lockError);
    }

    const onProgress = async (percent: number, step: string, message: string) => {
      await job.updateProgress({ percent, step, message });
    };

    try {
      let result: unknown;
      switch (type) {
        case 'create':
          result = await this.dbManager.createDatabase(
            payload as {
              name: string;
              adminUsername: string;
              adminFullName: string;
              adminPassword: string;
            },
            onProgress,
          );
          break;

        case 'duplicate':
          result = await this.dbManager.duplicateDatabase(
            payload.sourceDatabase as string,
            payload as { newName: string; neutralize: boolean },
            onProgress,
          );
          break;

        case 'backup':
          result = await this.dbManager.backupDatabase(database, onProgress);
          break;

        case 'restore':
          result = await this.dbManager.restoreDatabase(
            payload.zipPath as string,
            payload as { newName: string; neutralize: boolean },
            onProgress,
          );
          break;

        case 'delete':
          result = await this.dbManager.deleteDatabase(
            database,
            payload.confirmName as string,
            onProgress,
          );
          break;

        case 'upgrade':
          result = await this.dbManager.upgradeDatabase(database, onProgress);
          break;

        default:
          throw new Error(`Unknown job type: "${type}"`);
      }

      this.auditLogger?.log({
        ip: clientIp,
        action: actionName,
        target: database,
        status: 'SUCCESS',
        jobId,
        requestId,
      });

      return result;
    } catch (err: unknown) {
      let code = 'INTERNAL';
      let message = err instanceof Error ? err.message : String(err);

      if (err instanceof HttpException) {
        const res = err.getResponse();
        if (typeof res === 'object' && res !== null) {
          const obj = res as Record<string, unknown>;
          if (typeof obj.code === 'string') code = obj.code;
          if (typeof obj.message === 'string') message = obj.message;
        }
      } else {
        if (/not found/i.test(message)) {
          code = 'DATABASE_NOT_FOUND';
          message = 'پایگاه داده مورد نظر یافت نشد.';
        } else if (/already exists/i.test(message)) {
          code = 'DATABASE_ALREADY_EXISTS';
          message = 'پایگاه داده با این نام از قبل موجود است.';
        } else if (/locked|busy/i.test(message)) {
          code = 'DATABASE_BUSY';
          message = 'پایگاه داده در حال حاضر توسط عملیات دیگری قفل شده است.';
        } else if (/checksum mismatch/i.test(message)) {
          code = 'CORRUPTED_ARCHIVE';
          message = 'فایل پشتیبان نامعتبر است یا تمامیت آن مخدوش شده است.';
        }
      }

      const serializedErr = JSON.stringify({ code, message });
      this.auditLogger?.log({
        ip: clientIp,
        action: actionName,
        target: database,
        status: 'FAILURE',
        jobId,
        requestId,
        error: `${code}: ${message}`,
      });
      throw new Error(serializedErr);
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
