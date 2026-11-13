import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import pg from 'pg';
import { buildDatabaseUrl } from '@bodo/utils';
import { getEnv } from '../../config/env.config';
import { MaintenanceService } from './maintenance.service';
import { DatabaseRegistryService } from './database-registry.service';

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

export interface UpgradeResult {
  db: string;
  success: boolean;
  output?: string;
  error?: string;
}

@Injectable()
export class MigrationRunnerService {
  private readonly logger = new Logger(MigrationRunnerService.name);

  private readonly host: string;
  private readonly port: number;
  private readonly migratorPassword: string;
  private defaultSchemaPath: string;
  private defaultMigrationsPath: string;

  constructor(
    private readonly maintenanceService: MaintenanceService,
    private readonly databaseRegistry: DatabaseRegistryService,
  ) {
    const env = getEnv();
    this.host = env.POSTGRES_HOST;
    this.port = env.POSTGRES_PORT;
    this.migratorPassword = env.ERP_MIGRATOR_PASSWORD;

    const projectRoot = path.resolve(process.cwd());
    this.defaultSchemaPath = path.resolve(projectRoot, 'apps/api/prisma/schema.prisma');
    if (!fs.existsSync(this.defaultSchemaPath)) {
      this.defaultSchemaPath = path.resolve(projectRoot, 'prisma/schema.prisma');
    }

    this.defaultMigrationsPath = path.resolve(projectRoot, 'apps/api/prisma/migrations');
    if (!fs.existsSync(this.defaultMigrationsPath)) {
      this.defaultMigrationsPath = path.resolve(projectRoot, 'prisma/migrations');
    }
  }

  /**
   * Sets custom schema and migrations paths (e.g. for testing mock migrations).
   */
  setCustomPaths(schemaPath: string, migrationsPath: string): void {
    this.defaultSchemaPath = schemaPath;
    this.defaultMigrationsPath = migrationsPath;
  }

  /**
   * Reads available migration directory names from filesystem in sorted order.
   */
  getMigrationList(migrationsDir = this.defaultMigrationsPath): string[] {
    const diskMigrations: string[] = [];
    if (fs.existsSync(migrationsDir)) {
      const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const sqlFile = path.join(migrationsDir, entry.name, 'migration.sql');
          if (fs.existsSync(sqlFile)) {
            diskMigrations.push(entry.name);
          }
        }
      }
    }
    diskMigrations.sort();
    return diskMigrations;
  }

  /**
   * Checks the migration status for a tenant database by connecting as erp_migrator
   * and comparing applied migrations in _prisma_migrations with directories on disk.
   */
  async status(db: string, migrationsDir = this.defaultMigrationsPath): Promise<MigrationStatus> {
    const pool = new pg.Pool({
      host: this.host,
      port: this.port,
      user: 'erp_migrator',
      password: this.migratorPassword,
      database: db,
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    const applied: string[] = [];
    try {
      const res = await pool.query(`
        SELECT migration_name
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY finished_at ASC;
      `);
      for (const row of res.rows) {
        applied.push(row.migration_name);
      }
    } catch (err: unknown) {
      // Table _prisma_migrations might not exist yet if no migrations ran
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Could not read _prisma_migrations in "${db}": ${msg}`);
    } finally {
      await pool.end().catch(() => {});
    }

    const diskMigrations = this.getMigrationList(migrationsDir);
    const appliedSet = new Set(applied);
    const pending = diskMigrations.filter((m) => !appliedSet.has(m));

    return { applied, pending };
  }

  /**
   * Upgrades a database schema by running prisma migrate deploy using erp_migrator credentials.
   * Enables durable maintenance during upgrade. If failed, remains in durable maintenance.
   */
  async upgrade(
    db: string,
    options?: { schemaPath?: string; skipMaintenance?: boolean },
  ): Promise<UpgradeResult> {
    const schema = options?.schemaPath || this.defaultSchemaPath;
    const isTempDb = db.startsWith('erp_tmp_');
    const shouldManageMaintenance = !isTempDb && !options?.skipMaintenance;

    this.logger.log(`Starting schema upgrade for database "${db}"...`);

    // 1. Enable durable maintenance mode for real tenant databases
    if (shouldManageMaintenance) {
      await this.maintenanceService.set(db, {
        reason: 'migration_in_progress',
        durable: true,
      });
    }

    const migratorUrl = buildDatabaseUrl({
      host: this.host,
      port: this.port,
      user: 'erp_migrator',
      password: this.migratorPassword,
      database: db,
    });

    let prismaCli = path.resolve(process.cwd(), 'apps/api/node_modules/prisma/build/index.js');
    if (!fs.existsSync(prismaCli)) {
      prismaCli = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
    }

    const res = spawnSync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', `--schema=${schema}`],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: migratorUrl,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
    );

    const output = (res.stdout || '') + (res.stderr || '');

    if (res.status !== 0) {
      const errMsg = `Prisma migration failed with exit code ${res.status}: ${output.slice(-500)}`;
      this.logger.error(`Migration upgrade FAILED for "${db}": ${errMsg}`);

      // Keep database in durable maintenance mode if not temporary
      if (shouldManageMaintenance) {
        await this.maintenanceService.set(db, {
          reason: 'migration_failed',
          durable: true,
        });
      }

      return {
        db,
        success: false,
        output,
        error: errMsg,
      };
    }

    // 2. Clear maintenance mode on success
    if (shouldManageMaintenance) {
      await this.maintenanceService.clear(db);
    }
    this.logger.log(`Schema upgrade successfully applied to "${db}".`);

    return {
      db,
      success: true,
      output,
    };
  }

  /**
   * Resolves a failed migration in a tenant database using `prisma migrate resolve --rolled-back`
   * or direct SQL update if prisma CLI is not directly accessible.
   */
  async resolveRolledBack(
    db: string,
    migrationName: string,
    options?: { schemaPath?: string },
  ): Promise<{ success: boolean; output: string }> {
    const schema = options?.schemaPath || this.defaultSchemaPath;
    const migratorUrl = buildDatabaseUrl({
      host: this.host,
      port: this.port,
      user: 'erp_migrator',
      password: this.migratorPassword,
      database: db,
    });

    let prismaCli = path.resolve(process.cwd(), 'apps/api/node_modules/prisma/build/index.js');
    if (!fs.existsSync(prismaCli)) {
      prismaCli = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
    }

    if (fs.existsSync(prismaCli)) {
      const res = spawnSync(
        process.execPath,
        [prismaCli, 'migrate', 'resolve', `--rolled-back=${migrationName}`, `--schema=${schema}`],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: migratorUrl,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        },
      );

      const output = (res.stdout || '') + (res.stderr || '');
      if (res.status === 0) {
        this.logger.log(`Prisma migration "${migrationName}" marked as rolled back for "${db}".`);
        return { success: true, output };
      }
      this.logger.warn(
        `prisma migrate resolve exited with code ${res.status}: ${output}. Falling back to SQL update.`,
      );
    }

    // Direct SQL fallback if CLI could not resolve
    const pool = new pg.Pool({
      host: this.host,
      port: this.port,
      user: 'erp_migrator',
      password: this.migratorPassword,
      database: db,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool.query(
        `
        UPDATE _prisma_migrations
        SET rolled_back_at = NOW()
        WHERE migration_name = $1 AND rolled_back_at IS NULL;
      `,
        [migrationName],
      );
      return { success: true, output: 'Marked rolled back via database query' };
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /**
   * Upgrades all active tenant databases sequentially or with concurrency,
   * guaranteeing that a failure on one database does not prevent the others from migrating.
   */
  async upgradeAll(options?: {
    schemaPath?: string;
    concurrency?: number;
  }): Promise<UpgradeResult[]> {
    const activeDbs = await this.databaseRegistry.listActive();
    this.logger.log(`Running upgradeAll across ${activeDbs.length} active database(s)...`);

    const results: UpgradeResult[] = [];
    for (const db of activeDbs) {
      try {
        const res = await this.upgrade(db, { schemaPath: options?.schemaPath });
        results.push(res);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          db,
          success: false,
          error: msg,
        });
      }
    }

    return results;
  }
}
