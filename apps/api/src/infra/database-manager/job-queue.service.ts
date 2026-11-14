import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '../../config/env.config';
import { AdminJobStatus } from '@bodo/contracts';

export interface AdminJobData {
  type: 'create' | 'duplicate' | 'backup' | 'restore' | 'delete' | 'upgrade';
  database: string;
  payload: Record<string, unknown>;
  createdAt: string;
  requestId?: string;
  clientIp?: string;
}

export interface AdminJobProgress {
  percent: number;
  step: string;
  message: string;
}

@Injectable()
export class JobQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queue: Queue<AdminJobData, unknown, string>;
  private readonly redisClient: Redis;

  constructor() {
    const env = getEnv();
    const redisUrl = env.REDIS_URL;
    const password = env.REDIS_PASSWORD || undefined;

    this.redisClient = new Redis(redisUrl, {
      password,
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue<AdminJobData, unknown, string>('admin-ops', {
      connection: this.redisClient as never,
      defaultJobOptions: {
        removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
        removeOnFail: { count: 100, age: 7 * 24 * 3600 },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.redisClient.disconnect();
  }

  getQueue(): Queue<AdminJobData, unknown, string> {
    return this.queue;
  }

  getRedisClient(): Redis {
    return this.redisClient;
  }

  /**
   * Acquires a distributed lock for a database to ensure only one destructive operation runs at a time.
   * If already locked, returns false.
   */
  async acquireDatabaseLock(database: string, jobId: string, ttlSeconds = 120): Promise<boolean> {
    const key = `admin:lock:${database}`;
    const result = await this.redisClient.set(key, jobId, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Checks if a database is currently locked by an active operation.
   */
  async isDatabaseLocked(database: string): Promise<boolean> {
    const key = `admin:lock:${database}`;
    const current = await this.redisClient.get(key);
    return current !== null;
  }

  /**
   * Releases the distributed lock for a database.
   */
  async releaseDatabaseLock(database: string, jobId: string): Promise<void> {
    const key = `admin:lock:${database}`;
    const current = await this.redisClient.get(key);
    if (current === jobId) {
      await this.redisClient.del(key);
    }
  }

  /**
   * Enqueues an administrative job.
   */
  async enqueueJob(
    type: AdminJobData['type'],
    database: string,
    payload: Record<string, unknown>,
    meta?: { requestId?: string; clientIp?: string },
  ): Promise<string> {
    const jobData: AdminJobData = {
      type,
      database,
      payload,
      createdAt: new Date().toISOString(),
      requestId: meta?.requestId,
      clientIp: meta?.clientIp,
    };

    const job = await this.queue.add(type, jobData);
    if (!job.id) {
      throw new Error('Failed to obtain job id from BullMQ queue');
    }

    return job.id;
  }

  /**
   * Retrieves status and progress of a single job.
   */
  async getJobStatus(jobId: string): Promise<AdminJobStatus | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;

    return this.formatJobStatus(job);
  }

  /**
   * Lists recent administrative jobs (up to limit).
   */
  async listJobs(limit = 100): Promise<AdminJobStatus[]> {
    const jobs = await this.queue.getJobs(
      ['active', 'waiting', 'completed', 'failed', 'delayed'],
      0,
      limit - 1,
      true,
    );

    return jobs.map((j) => this.formatJobStatus(j));
  }

  private formatJobStatus(job: Job<AdminJobData, unknown, string>): AdminJobStatus {
    const progress = (job.progress as AdminJobProgress) || {
      percent: 0,
      step: 'queued',
      message: 'در صف انتظار',
    };

    let status: AdminJobStatus['status'] = 'waiting';
    if (job.failedReason) {
      status = 'failed';
    } else if (job.finishedOn) {
      status = 'completed';
    } else if (job.processedOn) {
      status = 'active';
    }

    const data = job.data;

    let errorObj: { code: string; message: string } | undefined;
    if (job.failedReason) {
      try {
        const parsed = JSON.parse(job.failedReason);
        if (parsed && typeof parsed === 'object' && parsed.message) {
          errorObj = {
            code: parsed.code || 'INTERNAL',
            message: parsed.message,
          };
        }
      } catch {
        // Not a JSON string
      }

      if (!errorObj) {
        let code = 'INTERNAL';
        let message = job.failedReason;
        if (/not found/i.test(job.failedReason)) {
          code = 'DATABASE_NOT_FOUND';
          message = 'پایگاه داده مورد نظر یافت نشد.';
        } else if (/locked|busy/i.test(job.failedReason)) {
          code = 'DATABASE_BUSY';
          message = 'پایگاه داده در حال حاضر توسط عملیات دیگری قفل شده است.';
        } else if (/already exists/i.test(job.failedReason)) {
          code = 'DATABASE_ALREADY_EXISTS';
          message = 'پایگاه داده با این نام از قبل موجود است.';
        } else if (/checksum mismatch|corrupted/i.test(job.failedReason)) {
          code = 'CORRUPTED_ARCHIVE';
          message = 'فایل پشتیبان نامعتبر است یا تمامیت آن مخدوش شده است.';
        }
        errorObj = { code, message };
      }
    }

    return {
      id: String(job.id),
      type: data.type,
      database: data.database,
      status,
      percent: progress.percent || 0,
      step: progress.step || 'queued',
      message: progress.message || '',
      error: errorObj,
      createdAt: data.createdAt,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    };
  }
}
