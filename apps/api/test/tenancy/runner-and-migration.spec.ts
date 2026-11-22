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
    // 1. Prepare mock schema and migrations directory dynamically from all real migrations
    const realMigrationsDir = path.resolve(__dirname, '../../prisma/migrations');
    const realMigrations = fs
      .readdirSync(realMigrationsDir)
      .filter((f) => fs.statSync(path.join(realMigrationsDir, f)).isDirectory())
      .sort();

    for (const dir of realMigrations) {
      fs.mkdirSync(path.join(mockMigrationsDir, dir), { recursive: true });
      fs.copyFileSync(
        path.join(realMigrationsDir, dir, 'migration.sql'),
        path.join(mockMigrationsDir, dir, 'migration.sql'),
      );
    }

    const mockTestMigrationName = '9999_add_test_table';
    fs.mkdirSync(path.join(mockMigrationsDir, mockTestMigrationName), { recursive: true });
    fs.writeFileSync(
      path.join(mockMigrationsDir, `${mockTestMigrationName}/migration.sql`),
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
      // Dynamically matches all real migrations applied, and only the mock migration pending
      expect(statusBefore.applied).toEqual(realMigrations);
      expect(statusBefore.pending).toEqual([mockTestMigrationName]);
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

    const expectedAllApplied = [...realMigrations, mockTestMigrationName];
    expect(statusDb1After.applied).toEqual(expectedAllApplied);
    expect(statusDb1After.pending).toEqual([]);

    expect(statusDb2After.applied).toEqual(expectedAllApplied);
    expect(statusDb2After.pending).toEqual([]);

    expect(statusDb3After.applied).toEqual(realMigrations);
    expect(statusDb3After.pending).toEqual([mockTestMigrationName]);

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

  it('12. MigrationRunner: upgrades a database created only with 0001_init to latest, preserving existing session rows and setting family_created_at = created_at', async () => {
    const legacyDb = 'erp_test_legacy_upgrade';
    const legacySuiteDir = path.resolve(__dirname, '../temp_legacy_suite');
    const legacyMigrationsDir = path.join(legacySuiteDir, 'migrations');
    const legacySchemaPath = path.join(legacySuiteDir, 'schema.prisma');

    try {
      // 1. Prepare legacy environment with ONLY 0001_init
      fs.mkdirSync(path.join(legacyMigrationsDir, '0001_init'), { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, '../../prisma/migrations/0001_init/migration.sql'),
        path.join(legacyMigrationsDir, '0001_init/migration.sql'),
      );

      fs.writeFileSync(
        legacySchemaPath,
        `datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }
        generator client {
          provider = "prisma-client-js"
        }\n`,
        'utf8',
      );

      // Create legacy database
      await superuserPool.query(`DROP DATABASE IF EXISTS ${legacyDb} WITH (FORCE);`);
      await superuserPool.query(`CREATE DATABASE ${legacyDb} OWNER erp_migrator;`);

      // Baseline legacy DB with only 0001_init
      const baselineResult = await migrationRunner.upgrade(legacyDb, {
        schemaPath: legacySchemaPath,
      });
      expect(baselineResult.success).toBe(true);

      const statusBaseline = await migrationRunner.status(legacyDb, legacyMigrationsDir);
      expect(statusBaseline.applied).toEqual(['0001_init']);
      expect(statusBaseline.pending).toEqual([]);

      // 2. Insert a legacy user and session row with specific created_at
      const testUserId = '11111111-1111-1111-1111-111111111111';
      const testSessionId = '22222222-2222-2222-2222-222222222222';
      const testFamilyId = '33333333-3333-3333-3333-333333333333';
      const specificCreatedAt = new Date('2026-01-15T08:30:00.000Z');

      const appPool = new pg.Pool({
        host,
        port,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: legacyDb,
        max: 1,
      });

      await appPool.query(`
        INSERT INTO users (id, username, password_hash, full_name, type, must_change_password, created_at, updated_at)
        VALUES ('${testUserId}', 'legacy_test_user', 'mock_hash', 'Legacy User', 'INTERNAL', false, NOW(), NOW());
      `);

      await appPool.query(`
        INSERT INTO sessions (id, user_id, refresh_token_hash, family_id, created_at, last_used_at, expires_at)
        VALUES (
          '${testSessionId}',
          '${testUserId}',
          'legacy_token_hash_abc',
          '${testFamilyId}',
          '${specificCreatedAt.toISOString()}',
          '${specificCreatedAt.toISOString()}',
          '2026-02-15T08:30:00.000Z'
        );
      `);

      // 3. Upgrade legacy database to latest migrations (using real default migrations)
      const upgradeToLatest = await migrationRunner.upgrade(legacyDb);
      expect(upgradeToLatest.success).toBe(true);

      // Verify status against real default migrations
      const statusAfterUpgrade = await migrationRunner.status(legacyDb);
      expect(statusAfterUpgrade.pending).toEqual([]);
      expect(statusAfterUpgrade.applied).toContain('0001_init');
      expect(statusAfterUpgrade.applied).toContain('0002_auth_sessions');

      // 4. Assert session row: family_created_at must equal created_at, new columns exist and are null
      const sessionRowRes = await appPool.query<{
        id: string;
        created_at: Date;
        family_created_at: Date;
        rotated_at: Date | null;
        revoked_reason: string | null;
        last_ip: string | null;
      }>(`
        SELECT id, created_at, family_created_at, rotated_at, revoked_reason, last_ip
        FROM sessions
        WHERE id = '${testSessionId}';
      `);

      expect(sessionRowRes.rowCount).toBe(1);
      const sessionRow = sessionRowRes.rows[0];
      expect(new Date(sessionRow.family_created_at).getTime()).toBe(specificCreatedAt.getTime());
      expect(sessionRow.rotated_at).toBeNull();
      expect(sessionRow.revoked_reason).toBeNull();
      expect(sessionRow.last_ip).toBeNull();

      // 5. Run second upgrade: must be an idempotent no-op with 0 pending
      const secondUpgrade = await migrationRunner.upgrade(legacyDb);
      expect(secondUpgrade.success).toBe(true);

      const statusAfterSecond = await migrationRunner.status(legacyDb);
      expect(statusAfterSecond.pending).toEqual([]);
      expect(statusAfterSecond.applied).toEqual(statusAfterUpgrade.applied);

      await appPool.end();
    } finally {
      await superuserPool
        .query(`DROP DATABASE IF EXISTS ${legacyDb} WITH (FORCE);`)
        .catch(() => {});
      if (fs.existsSync(legacySuiteDir)) {
        fs.rmSync(legacySuiteDir, { recursive: true, force: true });
      }
    }
  });
});
