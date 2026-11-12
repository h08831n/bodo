import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { globalKey } from '../redis/redis-keys';
import { TenantClientManager } from './tenant-client-manager';
import { DatabaseMaintenanceError } from './errors';

export interface MaintenanceStatus {
  inMaintenance: boolean;
  reason?: string;
  since?: string;
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly clientManager: TenantClientManager,
  ) {}

  /**
   * Sets maintenance mode for a given tenant database.
   * If durable=true, also persists the flag into the database's system_settings table.
   */
  async set(db: string, opts?: { reason?: string; durable?: boolean }): Promise<void> {
    const reason = opts?.reason || 'maintenance_mode';
    const since = new Date().toISOString();
    const payload = JSON.stringify({ inMaintenance: true, reason, since });

    const client = this.redisService.getClient();
    await client.set(globalKey('maint', db), payload);

    if (opts?.durable) {
      try {
        await this.clientManager.lease(db, async (prisma) => {
          await prisma.systemSetting.upsert({
            where: { key: 'maintenance' },
            create: {
              key: 'maintenance',
              value: { inMaintenance: true, reason, since },
            },
            update: {
              value: { inMaintenance: true, reason, since },
            },
          });
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to persist durable maintenance flag in "${db}": ${msg}`);
        throw err;
      }
    }

    this.logger.warn(`Maintenance mode ENABLED for database "${db}": ${reason}`);
  }

  /**
   * Clears maintenance mode for a tenant database from Redis and durable storage.
   */
  async clear(db: string): Promise<void> {
    const client = this.redisService.getClient();
    await client.del(globalKey('maint', db));

    try {
      await this.clientManager.lease(db, async (prisma) => {
        await prisma.systemSetting.deleteMany({
          where: { key: 'maintenance' },
        });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to delete durable maintenance flag in "${db}": ${msg}`);
    }

    this.logger.log(`Maintenance mode CLEARED for database "${db}"`);
  }

  /**
   * Checks whether a database is currently in maintenance.
   * Enforces strict FAIL-CLOSED policy: If Redis is unavailable, throws DatabaseMaintenanceError (503).
   */
  async get(db: string): Promise<MaintenanceStatus> {
    try {
      const client = this.redisService.getClient();
      const raw = await client.get(globalKey('maint', db));
      if (!raw) {
        return { inMaintenance: false };
      }

      const parsed = JSON.parse(raw);
      return {
        inMaintenance: true,
        reason: parsed.reason,
        since: parsed.since,
      };
    } catch (err: unknown) {
      if (err instanceof DatabaseMaintenanceError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[FAIL-CLOSED] Failed to read maintenance status from Redis for "${db}": ${msg}`,
      );
      throw new DatabaseMaintenanceError(
        db,
        'عدم امکان ارتباط با سرویس مدیریت وضعیت (Fail-Closed)',
        60,
      );
    }
  }

  /**
   * Rehydrates durable maintenance flags from active tenant databases into Redis.
   * Called during API startup to protect against Redis restart/flush while a migration is in progress.
   */
  async rehydrate(activeDatabases: string[]): Promise<void> {
    this.logger.log(
      `Rehydrating durable maintenance flags for ${activeDatabases.length} databases...`,
    );

    for (const db of activeDatabases) {
      try {
        await this.clientManager.lease(db, async (prisma) => {
          const setting = await prisma.systemSetting.findUnique({
            where: { key: 'maintenance' },
          });

          if (setting && setting.value) {
            const val = setting.value as Record<string, unknown>;
            if (val.inMaintenance) {
              const payload = JSON.stringify({
                inMaintenance: true,
                reason: val.reason || 'durable_maintenance',
                since: val.since || new Date().toISOString(),
              });
              await this.redisService.getClient().set(globalKey('maint', db), payload);
              this.logger.warn(`Rehydrated durable maintenance flag for "${db}"`);
            }
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not check durable maintenance for "${db}" during rehydration: ${msg}`,
        );
      }
    }
  }
}
