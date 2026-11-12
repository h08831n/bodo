import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { isValidDatabaseName } from '@bodo/utils';
import { getEnv } from '../../config/env.config';
import { MaintenanceService } from './maintenance.service';
import { DatabaseNotFoundError, DatabaseMaintenanceError } from './errors';

interface CacheEntry {
  exists: boolean;
  expiresAt: number;
}

@Injectable()
export class DatabaseRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseRegistryService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 10_000; // 10 seconds TTL
  private pool: pg.Pool | null = null;

  constructor(private readonly maintenanceService: MaintenanceService) {}

  private getPool(): pg.Pool {
    if (!this.pool) {
      const env = getEnv();
      this.pool = new pg.Pool({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: 'postgres',
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }
    this.cache.clear();
  }

  /**
   * Checks whether a database exists in the PostgreSQL cluster.
   * Includes 10-second TTL cache for both positive and negative results
   * to protect against name-guessing denial of service attacks.
   */
  async exists(db: string): Promise<boolean> {
    if (!isValidDatabaseName(db)) {
      return false;
    }

    const now = Date.now();
    const cached = this.cache.get(db);
    if (cached && cached.expiresAt > now) {
      return cached.exists;
    }

    try {
      const pool = this.getPool();
      const res = await pool.query(
        'SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate = false LIMIT 1;',
        [db],
      );
      const exists = (res.rowCount ?? 0) > 0;

      this.cache.set(db, {
        exists,
        expiresAt: now + this.cacheTtlMs,
      });

      return exists;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error querying pg_database for "${db}": ${msg}`);
      throw err;
    }
  }

  /**
   * Asserts that a database name is valid, exists, is not temporary, and is not in maintenance mode.
   * Throws DatabaseNotFoundError or DatabaseMaintenanceError.
   */
  async assertUsable(db: string): Promise<void> {
    if (!isValidDatabaseName(db)) {
      throw new DatabaseNotFoundError();
    }

    const dbExists = await this.exists(db);
    if (!dbExists) {
      throw new DatabaseNotFoundError();
    }

    const maint = await this.maintenanceService.get(db);
    if (maint.inMaintenance) {
      throw new DatabaseMaintenanceError(db, maint.reason);
    }
  }

  /**
   * Returns a list of all active tenant databases (matching erp_*, non-tmp, non-template,
   * and containing the bodo company_profile schema).
   */
  async listActive(): Promise<string[]> {
    const pool = this.getPool();
    const res = await pool.query(`
      SELECT datname
      FROM pg_database
      WHERE datname LIKE 'erp_%'
        AND datname NOT LIKE 'erp_tmp_%'
        AND datistemplate = false
      ORDER BY datname;
    `);

    const candidates = res.rows.map((r: { datname: string }) => r.datname);
    const active: string[] = [];

    for (const db of candidates) {
      if (!isValidDatabaseName(db)) continue;

      // Quick check to confirm it is an initialized bodo database
      const env = getEnv();
      const client = new pg.Client({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: db,
        connectionTimeoutMillis: 3000,
      });

      try {
        await client.connect();
        const check = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'company_profile' LIMIT 1;",
        );
        if ((check.rowCount ?? 0) > 0) {
          active.push(db);
        }
      } catch {
        // Skip uninitialized or inaccessible database
      } finally {
        await client.end().catch(() => {});
      }
    }

    return active;
  }
}
