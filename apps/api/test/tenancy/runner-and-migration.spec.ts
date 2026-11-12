import * as fs from 'fs';
import * as path from 'path';
import pg from 'pg';
import { TenantRunnerService } from '../../src/infra/tenancy/tenant-runner.service';
import { MigrationRunnerService } from '../../src/infra/tenancy/migration-runner.service';
import { DatabaseRegistryService } from '../../src/infra/tenancy/database-registry.service';
import { MaintenanceService } from '../../src/infra/tenancy/maintenance.service';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';
import { RedisService } from '../../src/infra/redis/redis.service';
import { getEnv } from '../../src/config/env.config';
import { seedBaseline } from '../../src/database/seed/baseline';
import { PrismaClient } from '@prisma/client';
import { buildDatabaseUrl } from '@bodo/utils';
import { globalKey } from '../../src/infra/redis/redis-keys';

jest.setTimeout(120000);

describe('TenantRunner & MigrationRunner Invariants (Tests 10, 11)', () => {
  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';

  const db1 = 'erp_test_runner_1';
  const db2 = 'erp_test_runner_2';
  const db3 = 'erp_test_runner_3';
  const testDatabases = [db1, db2, db3];

  let superuserPool: pg.Pool;
  let redisService: RedisService;
  let clientManager: TenantClientManager;
  let maintenanceService: MaintenanceService;
  let databaseRegistry: DatabaseRegistryService;
  let tenantRunner: TenantRunnerService;
  let migrationRunner: MigrationRunnerService;

  const mockMigrationsDir = path.resolve(__dirname, '../temp_mock_migrations');

  beforeAll(async () => {
    superuserPool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: 'postgres',
    });

    redisService = new RedisService();
    redisService.onModuleInit();

    clientManager = new TenantClientManager();
    maintenanceService = new MaintenanceService(redisService, clientManager);
    databaseRegistry = new DatabaseRegistryService(maintenanceService);
    tenantRunner = new TenantRunnerService(databaseRegistry, maintenanceService, clientManager);
    migrationRunner = new MigrationRunnerService(maintenanceService, databaseRegistry);

    // Prepare migration SQL for base init
    const baseMigrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/migrations/0001_init/migration.sql'),
      'utf8',
    );

    // Setup 3 tenant databases
    for (const db of testDatabases) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
      await superuserPool.query(`CREATE DATABASE ${db} OWNER erp_migrator;`);

      // Run base migration as erp_migrator
      const migClient = new pg.Client({
        host,
        port,
        user: 'erp_migrator',
        password: env.ERP_MIGRATOR_PASSWORD,
        database: db,
      });
      await migClient.connect();
      await migClient.query(baseMigrationSql);
      await migClient.end();

      // Seed baseline
      const seedClient = new PrismaClient({
        datasources: {
          db: {
            url: buildDatabaseUrl({
              host,
              port,
              user: 'erp_app',
              password: env.ERP_APP_PASSWORD,
              database: db,
            }),
          },
        },
      });
      await seedBaseline(seedClient);
      await seedClient.$disconnect();
    }
  });

  afterAll(async () => {
    await clientManager.shutdown();
    await databaseRegistry.onModuleDestroy();
    await redisService.onModuleDestroy();

    for (const db of testDatabases) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`).catch(() => {});
    }
    await superuserPool.end().catch(() => {});

    if (fs.existsSync(mockMigrationsDir)) {
      fs.rmSync(mockMigrationsDir, { recursive: true, force: true });
    }
  });

  it('10. TenantRunner: processes active databases with error isolation, skipping maintenance, and concurrency control', async () => {
    // Put db3 into maintenance mode
    await maintenanceService.set(db3, { reason: 'scheduled_backup' });

    // Track active concurrency
    let currentConcurrent = 0;
    let maxObservedConcurrency = 0;

    const results = await tenantRunner.forEachActiveDatabase(
      async (db) => {
        currentConcurrent++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentConcurrent);

        try {
          if (db === db2) {
            throw new Error(`Simulated task failure on ${db2}`);
          }
          await new Promise((r) => setTimeout(r, 40));
          return `Processed ${db}`;
        } finally {
          currentConcurrent--;
        }
      },
      { concurrency: 2, timeoutMs: 5000 },
    );

    // Clear maintenance on db3
    await maintenanceService.clear(db3);

    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);

    // Find results for each database
    const r1 = results.find((r) => r.db === db1);
    const r2 = results.find((r) => r.db === db2);
    const r3 = results.find((r) => r.db === db3);

    expect(r1).toBeDefined();
    expect(r1?.ok).toBe(true);
    expect(r1?.result).toBe(`Processed ${db1}`);

    expect(r2).toBeDefined();
    expect(r2?.ok).toBe(false);
    expect(r2?.error?.message).toContain(`Simulated task failure on ${db2}`);

    expect(r3).toBeDefined();
    expect(r3?.skipped).toBe(true);
  });

  it('11. MigrationRunner: status tracking, upgrade with mock migration, durable failure state, and Redis rehydration', async () => {
    // 1. Setup mock migrations directory with 0001_init and 0002_add_column
    fs.mkdirSync(path.join(mockMigrationsDir, '0001_init'), { recursive: true });
    fs.mkdirSync(path.join(mockMigrationsDir, '0002_add_column'), { recursive: true });

    // Copy original 0001
    fs.copyFileSync(
      path.resolve(__dirname, '../../prisma/migrations/0001_init/migration.sql'),
      path.join(mockMigrationsDir, '0001_init/migration.sql'),
    );

    // Valid 0002 SQL migration
    fs.writeFileSync(
      path.join(mockMigrationsDir, '0002_add_column/migration.sql'),
      'ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS mock_test_col TEXT;\n',
      'utf8',
    );

    // Status check on db1
    const initialStatus = await migrationRunner.status(db1, mockMigrationsDir);
    expect(initialStatus.pending).toContain('0002_add_column');

    // 2. Test status and durable failure
    // Set up a broken migration on db2
    const brokenMigrationsDir = path.resolve(__dirname, '../temp_broken_migrations');
    fs.mkdirSync(path.join(brokenMigrationsDir, '0001_init'), { recursive: true });
    fs.mkdirSync(path.join(brokenMigrationsDir, '0002_broken'), { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../../prisma/migrations/0001_init/migration.sql'),
      path.join(brokenMigrationsDir, '0001_init/migration.sql'),
    );
    fs.writeFileSync(
      path.join(brokenMigrationsDir, '0002_broken/migration.sql'),
      'INVALID SYNTAX BROKEN SQL STATEMENT;\n',
      'utf8',
    );

    // Create a mock schema pointing to broken migrations
    const mockSchemaPath = path.join(brokenMigrationsDir, 'schema.prisma');
    fs.writeFileSync(
      mockSchemaPath,
      `
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }
      generator client {
        provider = "prisma-client-js"
      }
      `,
      'utf8',
    );

    // Run upgrade on db2 with broken migration
    const brokenResult = await migrationRunner.upgrade(db2, { schemaPath: mockSchemaPath });
    expect(brokenResult.success).toBe(false);

    // Verify db2 is left in durable maintenance mode
    const maintDb2 = await maintenanceService.get(db2);
    expect(maintDb2.inMaintenance).toBe(true);
    expect(maintDb2.reason).toBe('migration_failed');

    // Verify durable setting is stored in db2 system_settings table
    const checkDurablePool = new pg.Pool({
      host,
      port,
      user: 'erp_app',
      password: env.ERP_APP_PASSWORD,
      database: db2,
      max: 1,
    });
    const durableRow = await checkDurablePool.query(
      "SELECT value FROM system_settings WHERE key = 'maintenance';",
    );
    await checkDurablePool.end();
    expect(durableRow.rows[0].value.inMaintenance).toBe(true);
    expect(durableRow.rows[0].value.reason).toBe('migration_failed');

    // 3. Test Redis Rehydration:
    // Flush Redis completely
    await redisService.getClient().flushall();

    // Confirm Redis no longer has maint key
    const rawBefore = await redisService.getClient().get(globalKey('maint', db2));
    expect(rawBefore).toBeNull();

    // Call rehydrate()
    await maintenanceService.rehydrate([db1, db2, db3]);

    // Confirm Redis now has durable flag restored!
    const rawAfter = await redisService.getClient().get(globalKey('maint', db2));
    expect(rawAfter).not.toBeNull();
    const parsed = JSON.parse(rawAfter!);
    expect(parsed.inMaintenance).toBe(true);
    expect(parsed.reason).toBe('migration_failed');

    // Clean up db2 maintenance
    await maintenanceService.clear(db2);

    // Clean up broken migration temp files
    if (fs.existsSync(brokenMigrationsDir)) {
      fs.rmSync(brokenMigrationsDir, { recursive: true, force: true });
    }
  });
});
