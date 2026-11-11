import { Injectable } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import Redis from 'ioredis';
import { getEnv } from '../config/env.config';
import { HealthStatus } from '@bodo/contracts';

@Injectable()
export class HealthService {
  private startTime = Date.now();

  checkLive(): HealthStatus {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  async checkReady(): Promise<{ isReady: boolean; data: HealthStatus }> {
    const env = getEnv();
    let postgresStatus: 'up' | 'down' = 'down';
    let redisStatus: 'up' | 'down' = 'down';

    // 1. Lightweight Postgres Ping
    const pg = new PgClient({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });

    try {
      await pg.connect();
      await pg.query('SELECT 1');
      postgresStatus = 'up';
    } catch {
      postgresStatus = 'down';
    } finally {
      await pg.end().catch(() => {});
    }

    // 2. Lightweight Redis Ping
    const redis = new Redis(env.REDIS_URL, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null, // don't keep reconnecting in health check
    });

    try {
      await redis.connect();
      const res = await redis.ping();
      if (res === 'PONG') {
        redisStatus = 'up';
      }
    } catch {
      redisStatus = 'down';
    } finally {
      redis.disconnect();
    }

    const isReady = postgresStatus === 'up' && redisStatus === 'up';

    return {
      isReady,
      data: {
        status: isReady ? 'ok' : 'error',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        timestamp: new Date().toISOString(),
        checks: {
          postgres: postgresStatus,
          redis: redisStatus,
        },
      },
    };
  }
}
