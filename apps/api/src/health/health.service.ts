import { Inject, Injectable, Optional } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import Redis from 'ioredis';
import { getEnv } from '../config/env.config';
import { HealthStatus } from '@bodo/contracts';
import { buildDatabaseUrl } from '@bodo/utils';
import { TenantClientManager } from '../infra/tenancy/tenant-client-manager';
import { RedisService } from '../infra/redis/redis.service';

@Injectable()
export class HealthService {
  private startTime = Date.now();

  constructor(
    @Optional() @Inject(TenantClientManager) private readonly clientManager?: TenantClientManager,
    @Optional() @Inject(RedisService) private readonly redisService?: RedisService,
  ) {}

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

    // 1. Postgres Ping using erp_app role on maintenance/postgres database
    const appUrl = buildDatabaseUrl({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: 'erp_app',
      password: env.ERP_APP_PASSWORD,
      database: 'postgres',
    });

    const pg = new PgClient({
      connectionString: appUrl,
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

    // 2. Redis Ping
    if (this.redisService) {
      const isPong = await this.redisService.ping();
      redisStatus = isPong ? 'up' : 'down';
    } else {
      const redis = new Redis(env.REDIS_URL, {
        password: env.REDIS_PASSWORD || undefined,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        retryStrategy: () => null,
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
    }

    const isReady = postgresStatus === 'up' && redisStatus === 'up';

    const clientStats = this.clientManager
      ? this.clientManager.stats()
      : { open: 0, maxClients: env.TENANT_MAX_CLIENTS, activeLeases: 0 };

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
        tenantClients: clientStats,
      },
    };
  }
}
