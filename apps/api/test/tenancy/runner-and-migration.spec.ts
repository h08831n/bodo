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
  let host = env.POSTGRES_HOST;
  let port = env.POSTGRES_PORT;
  if (process.env.TEST_DATABASE_URL) {
    try {
      const parsed = new URL(process.env.TEST_DATABASE_URL);
      host = parsed.hostname;
      port = parseInt(parsed.port || '5432', 10);
      process.env.POSTGRES_HOST = host;
      process.env.POSTGRES_PORT = String(port);
    } catch {
      // ignore
    }
  }
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

  const mockSuiteDir = path.resolve(__dirname, '../temp_mock_suite');
  const mockMigrationsDir = path.join(mockSuiteDir, 'migrations');
  const mockSchemaPath = path.join(mockSuiteDir, 'schema.prisma');

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

    // Setup 3 tenant databases and baseline them properly using prisma migrate deploy
    for (const db of testDatabases) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
      await superuserPool.query(`CREATE DATABASE ${db} OWNER erp_migrator;`);

      // Run initial migration 0001_init through MigrationRunner
      const initResult = await migrationRunner.upgrade(db);
      if (!initResult.success) {
        throw new Error(`Failed to baseline initial schema for ${db}: ${initResult.error}`);
      }

      // Seed baseline entities
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

    if (fs.existsSync(mockSuiteDir)) {
      fs.rmSync(mockSuiteDir, { recursive: true, force: true });
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
    // 1. Prepare mock schema and migrations directory with 0001_init and 0002_add_test_table
    fs.mkdirSync(path.join(mockMigrationsDir, '0001_init'), { recursive: true });
    fs.mkdirSync(path.join(mockMigrationsDir, '0002_add_test_table'), { recursive: true });

    // Copy original 0001_init migration SQL
    fs.copyFileSync(
      path.resolve(__dirname, '../../prisma/migrations/0001_init/migration.sql'),
      path.join(mockMigrationsDir, '0001_init/migration.sql'),
    );

    // Valid 0002 SQL migration: creates a new table
    fs.writeFileSync(
      path.join(mockMigrationsDir, '0002_add_test_table/migration.sql'),
      `CREATE TABLE test_migration_table (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL
      );\n`,
      'utf8',
    );

    // Mock schema.prisma pointing to the mock environment
    fs.writeFileSync(
      mockSchemaPath,
      `datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }
      generator client {
        provider = "prisma-client-js"
      }\n`,
      'utf8',
    );

    // Check status before upgrade across all 3 databases
    for (const db of [db1, db2, db3]) {
      const statusBefore = await migrationRunner.status(db, mockMigrationsDir);
      // Assertion: 1 applied, 1 pending
      expect(statusBefore.applied).toEqual(['0001_init']);
      expect(statusBefore.pending).toEqual(['0002_add_test_table']);
    }

    // 2. Pre-create table `test_migration_table` ONLY in db3 to induce a genuine SQL collision failure
    const db3MigPool = new pg.Pool({
      host,
      port,
      user: 'erp_migrator',
      password: env.ERP_MIGRATOR_PASSWORD,
      database: db3,
      max: 1,
    });
    await db3MigPool.query('CREATE TABLE test_migration_table (id INT PRIMARY KEY);');
    await db3MigPool.end();

    // 3. Upgrade db1 and db2 (A and B): both must succeed
    const resDb1 = await migrationRunner.upgrade(db1, { schemaPath: mockSchemaPath });
    const resDb2 = await migrationRunner.upgrade(db2, { schemaPath: mockSchemaPath });

    expect(resDb1.success).toBe(true);
    expect(resDb2.success).toBe(true);

    // 4. Upgrade db3 (C): must fail due to SQL collision
    const resDb3 = await migrationRunner.upgrade(db3, { schemaPath: mockSchemaPath });

    expect(resDb3.success).toBe(false);
    // Assert: error cause is genuine SQL error (relation already exists), NOT P3005
    expect(resDb3.error).toContain('already exists');
    expect(resDb3.error).not.toContain('P3005');

    // 5. Assert status after upgrade
    const statusDb1After = await migrationRunner.status(db1, mockMigrationsDir);
    const statusDb2After = await migrationRunner.status(db2, mockMigrationsDir);
    const statusDb3After = await migrationRunner.status(db3, mockMigrationsDir);

    expect(statusDb1After.applied).toEqual(['0001_init', '0002_add_test_table']);
    expect(statusDb1After.pending).toEqual([]);

    expect(statusDb2After.applied).toEqual(['0001_init', '0002_add_test_table']);
    expect(statusDb2After.pending).toEqual([]);

    expect(statusDb3After.applied).toEqual(['0001_init']);
    expect(statusDb3After.pending).toEqual(['0002_add_test_table']);

    // 6. Assert maintenance states: A and B are healthy, C is in durable maintenance
    const maintDb1 = await maintenanceService.get(db1);
    const maintDb2 = await maintenanceService.get(db2);
    const maintDb3 = await maintenanceService.get(db3);

    expect(maintDb1.inMaintenance).toBe(false);
    expect(maintDb2.inMaintenance).toBe(false);
    expect(maintDb3.inMaintenance).toBe(true);
    expect(maintDb3.reason).toBe('migration_failed');

    // Verify durable setting is stored in db3's system_settings table
    const checkDurablePool = new pg.Pool({
      host,
      port,
      user: 'erp_app',
      password: env.ERP_APP_PASSWORD,
      database: db3,
      max: 1,
    });
    const durableRow = await checkDurablePool.query(
      "SELECT value FROM system_settings WHERE key = 'maintenance';",
    );
    await checkDurablePool.end();

    expect(durableRow.rows[0].value.inMaintenance).toBe(true);
    expect(durableRow.rows[0].value.reason).toBe('migration_failed');

    // 7. Test Redis flush and rehydration
    await redisService.getClient().flushall();

    // Confirm Redis no longer has maint key
    const rawBefore = await redisService.getClient().get(globalKey('maint', db3));
    expect(rawBefore).toBeNull();

    // Rehydrate durable flags across active databases
    await maintenanceService.rehydrate([db1, db2, db3]);

    // Confirm Redis has restored db3's maintenance flag while db1 and db2 remain free
    const rawAfter = await redisService.getClient().get(globalKey('maint', db3));
    expect(rawAfter).not.toBeNull();
    const parsed = JSON.parse(rawAfter!);
    expect(parsed.inMaintenance).toBe(true);
    expect(parsed.reason).toBe('migration_failed');

    const maintDb1After = await maintenanceService.get(db1);
    const maintDb2After = await maintenanceService.get(db2);
    expect(maintDb1After.inMaintenance).toBe(false);
    expect(maintDb2After.inMaintenance).toBe(false);

    // Clean up db3 maintenance state
    await maintenanceService.clear(db3);
  });
});
