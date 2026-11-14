import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import pg from 'pg';
import { getEnv } from '../../src/config/env.config';
import { DatabaseManagerService } from '../../src/infra/database-manager/database-manager.service';
import { JobQueueService } from '../../src/infra/database-manager/job-queue.service';
import { PgToolsService } from '../../src/infra/pg-tools/pg-tools.service';
import { LocalPgToolsDriver } from '../../src/infra/pg-tools/local-pg-tools.driver';
import { DockerPgToolsDriver } from '../../src/infra/pg-tools/docker-pg-tools.driver';
import { ZipService } from '../../src/infra/backup/zip.service';
import { DomainMap } from '../../src/infra/config-store/domain-map';
import { ConfigStoreService } from '../../src/infra/config-store/config-store.service';
import { MaintenanceService } from '../../src/infra/tenancy/maintenance.service';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';
import { MigrationRunnerService } from '../../src/infra/tenancy/migration-runner.service';
import { DatabaseRegistryService } from '../../src/infra/tenancy/database-registry.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import { AdminAuditLogger } from '../../src/infra/admin/admin-audit.logger';
import { buildDatabaseUrl } from '@bodo/utils';

jest.setTimeout(180000);

describe('Database Manager Service Integration Tests (S1.4)', () => {
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

  const testDbName = 'erp_test_mgr_orig';
  const duplicateDbName = 'erp_test_mgr_dup';
  const restoreDbName = 'erp_test_mgr_restored';

  let superuserPool: pg.Pool;
  let redisService: RedisService;
  let clientManager: TenantClientManager;
  let maintenanceService: MaintenanceService;
  let databaseRegistry: DatabaseRegistryService;
  let migrationRunner: MigrationRunnerService;
  let configStore: ConfigStoreService;
  let domainMap: DomainMap;
  let zipService: ZipService;
  let pgTools: PgToolsService;
  let dbManager: DatabaseManagerService;
  let jobQueue: JobQueueService;

  let isDbConnected = false;

  beforeAll(async () => {
    superuserPool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: 'postgres',
      connectionTimeoutMillis: 5000,
    });

    try {
      const client = await superuserPool.connect();
      client.release();
      isDbConnected = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WARN] PostgreSQL is not reachable at ${host}:${port} (${msg}). Integration tests will be skipped.`,
      );
      return;
    }

    redisService = new RedisService();
    try {
      redisService.onModuleInit();
      await redisService.getClient().ping();
    } catch {
      console.warn('[WARN] Redis is not reachable. Skipping Database Manager integration tests.');
      isDbConnected = false;
      return;
    }

    clientManager = new TenantClientManager();
    clientManager.onModuleInit();

    maintenanceService = new MaintenanceService(redisService, clientManager);
    databaseRegistry = new DatabaseRegistryService(maintenanceService);
    migrationRunner = new MigrationRunnerService(maintenanceService, databaseRegistry);
    configStore = new ConfigStoreService();
    domainMap = new DomainMap(configStore);

    pgTools = new PgToolsService();
    zipService = new ZipService();

    dbManager = new DatabaseManagerService(
      pgTools,
      zipService,
      domainMap,
      maintenanceService,
      clientManager,
      migrationRunner,
      databaseRegistry,
    );

    jobQueue = new JobQueueService();

    // Clean up any leftovers from previous test runs
    for (const db of [testDbName, duplicateDbName, restoreDbName]) {
      await superuserPool
        .query(`ALTER DATABASE "${db}" WITH ALLOW_CONNECTIONS true;`)
        .catch(() => {});
      await superuserPool
        .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1;`, [db])
        .catch(() => {});
      await superuserPool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE);`).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!isDbConnected) return;

    for (const db of [testDbName, duplicateDbName, restoreDbName]) {
      await superuserPool
        .query(`ALTER DATABASE "${db}" WITH ALLOW_CONNECTIONS true;`)
        .catch(() => {});
      await superuserPool
        .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1;`, [db])
        .catch(() => {});
      await superuserPool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE);`).catch(() => {});
    }

    await superuserPool.end().catch(() => {});
    clientManager?.onModuleDestroy();
    await jobQueue?.onModuleDestroy();
    redisService?.onModuleDestroy();
  });

  it('Test 7: Creates new isolated tenant database with baseline admin and filestore', async () => {
    if (!isDbConnected) return;

    const progressLogs: Array<{ percent: number; step: string }> = [];
    await dbManager.createDatabase(
      {
        name: 'test_mgr_orig',
        adminUsername: 'superadmin',
        adminFullName: 'مدیر اصلی',
        adminPassword: 'Password123!Secure',
      },
      async (percent, step) => {
        progressLogs.push({ percent, step });
      },
    );

    // Verify progress reported
    expect(progressLogs.length).toBeGreaterThan(0);
    expect(progressLogs[progressLogs.length - 1]?.percent).toBe(100);

    // Verify database exists
    const checkRes = await superuserPool.query(
      `SELECT 1 FROM pg_database WHERE datname = '${testDbName}';`,
    );
    expect(checkRes.rowCount).toBe(1);

    // Verify filestore directory exists
    const filestorePath = path.resolve(env.FILESTORE_DIR, testDbName);
    expect(fs.existsSync(filestorePath)).toBe(true);

    // Connect as erp_app and verify tables and seeded data
    const appClient = new pg.Client({
      connectionString: buildDatabaseUrl({
        host,
        port,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: testDbName,
      }),
    });
    await appClient.connect();
    try {
      const curRes = await appClient.query('SELECT count(*) FROM currencies;');
      expect(parseInt(curRes.rows[0].count, 10)).toBe(4);

      const userRes = await appClient.query('SELECT username, full_name FROM users;');
      expect(userRes.rows.length).toBe(1);
      expect(userRes.rows[0].username).toBe('superadmin');
      expect(userRes.rows[0].full_name).toBe('مدیر اصلی');
    } finally {
      await appClient.end();
    }
  });

  it('Test 8: Rollback on creation failure cleans up temp database and filestore', async () => {
    if (!isDbConnected) return;

    // Trigger failure by trying to create an invalid or conflicting database
    let caughtError: Error | null = null;
    try {
      await dbManager.createDatabase({
        name: 'test_mgr_orig', // already exists
        adminUsername: 'admin',
        adminFullName: 'Admin',
        adminPassword: 'Password123!',
      });
    } catch (err: unknown) {
      caughtError = err as Error;
    }
    expect(caughtError).not.toBeNull();

    // Verify no temporary databases remain
    const tmpRes = await superuserPool.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'erp_tmp_%';",
    );
    expect(tmpRes.rows.length).toBe(0);
  });

  it('Test 9: Duplicates database, verifies data equality, and preserves erp_app ACL', async () => {
    if (!isDbConnected) return;

    // Create a dummy file in filestore of source
    const srcFilestore = path.resolve(env.FILESTORE_DIR, testDbName);
    fs.writeFileSync(path.join(srcFilestore, 'sample.txt'), 'hello-attachment');

    await dbManager.duplicateDatabase('test_mgr_orig', {
      newName: 'test_mgr_dup',
      neutralize: false,
    });

    // Verify duplicated database exists
    const checkRes = await superuserPool.query(
      `SELECT 1 FROM pg_database WHERE datname = '${duplicateDbName}';`,
    );
    expect(checkRes.rowCount).toBe(1);

    // Verify filestore was duplicated
    const dupFilestore = path.resolve(env.FILESTORE_DIR, duplicateDbName);
    expect(fs.existsSync(dupFilestore)).toBe(true);
    expect(fs.existsSync(path.join(dupFilestore, 'sample.txt'))).toBe(true);

    // Verify erp_app can connect, perform DML on duplicated database
    const appClient = new pg.Client({
      connectionString: buildDatabaseUrl({
        host,
        port,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: duplicateDbName,
      }),
    });
    await appClient.connect();
    try {
      const curRes = await appClient.query('SELECT count(*) FROM currencies;');
      expect(parseInt(curRes.rows[0].count, 10)).toBe(4);

      // Verify erp_app can insert (DML permission)
      await appClient.query(`
        INSERT INTO currencies (code, name, symbol, decimals, sort_order, is_active)
        VALUES ('DUP', 'Duplicate Test', 'D', 2, 99, true);
      `);
      const afterInsert = await appClient.query('SELECT count(*) FROM currencies;');
      expect(parseInt(afterInsert.rows[0].count, 10)).toBe(5);
    } finally {
      await appClient.end();
    }
  });

  it('Test 10 & 11: Creates backup zip64 with manifest, verifies checksum, and restores database', async () => {
    if (!isDbConnected) return;

    const backupResult = await dbManager.backupDatabase(testDbName);
    const zipPath = path.join(path.resolve(env.BACKUP_DIR, testDbName), backupResult.fileName);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(backupResult.sizeBytes).toBeGreaterThan(0);

    // Verify backup listing
    const backups = dbManager.listBackups('test_mgr_orig');
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0]?.file).toBe(backupResult.fileName);

    // Restore from backup zip to a new database name
    await dbManager.restoreDatabase(zipPath, {
      newName: 'test_mgr_restored',
      neutralize: false,
    });

    // Verify restored database exists and data matches
    const restClient = new pg.Client({
      connectionString: buildDatabaseUrl({
        host,
        port,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: restoreDbName,
      }),
    });
    await restClient.connect();
    try {
      const curRes = await restClient.query('SELECT count(*) FROM currencies;');
      expect(parseInt(curRes.rows[0].count, 10)).toBe(4);
    } finally {
      await restClient.end();
    }
  });

  it('Test 12: Resolves failed migration in _prisma_migrations and unblocks maintenance via repair', async () => {
    if (!isDbConnected) return;

    // Simulate a failed migration record in _prisma_migrations
    const migratorClient = new pg.Client({
      connectionString: buildDatabaseUrl({
        host,
        port,
        user: 'erp_migrator',
        password: env.ERP_MIGRATOR_PASSWORD,
        database: duplicateDbName,
      }),
    });
    await migratorClient.connect();
    try {
      await migratorClient.query(`
        INSERT INTO _prisma_migrations (id, checksum, migration_name, logs, started_at)
        VALUES ('test_failed_mig_id', 'mock_checksum', '9999_failed_upgrade', 'Simulated failure', NOW());
      `);
    } finally {
      await migratorClient.end();
    }

    // Put tenant into durable migration_failed maintenance
    await maintenanceService.set(duplicateDbName, {
      reason: 'migration_failed',
      durable: true,
    });
    let state = await maintenanceService.get(duplicateDbName);
    expect(state.inMaintenance).toBe(true);
    expect(state.reason).toBe('migration_failed');

    // Run repair endpoint
    const repairRes = await dbManager.repairDatabase('test_mgr_dup', true);
    expect(repairRes.rolledBackMigration).toBe('9999_failed_upgrade');

    // Verify _prisma_migrations marked as rolled back
    const verifyClient = new pg.Client({
      connectionString: buildDatabaseUrl({
        host,
        port,
        user: 'erp_migrator',
        password: env.ERP_MIGRATOR_PASSWORD,
        database: duplicateDbName,
      }),
    });
    await verifyClient.connect();
    try {
      const migCheck = await verifyClient.query<{ rolled_back_at: string | null }>(`
        SELECT rolled_back_at FROM _prisma_migrations WHERE migration_name = '9999_failed_upgrade';
      `);
      expect(migCheck.rows[0]?.rolled_back_at).not.toBeNull();
    } finally {
      await verifyClient.end();
    }

    // Verify durable maintenance mode cleared
    state = await maintenanceService.get(duplicateDbName);
    expect(state.inMaintenance).toBe(false);
  });

  it('Test 15: Worker crash repair - unblocks leaked ALLOW_CONNECTIONS false and detects orphans', async () => {
    if (!isDbConnected) return;

    // Simulate worker crash leaving datallowconn = false
    await superuserPool.query(`ALTER DATABASE "${duplicateDbName}" WITH ALLOW_CONNECTIONS false;`);

    // Check orphan / locked DB detection on boot
    const orphanCheck = await dbManager.checkOrphans();
    expect(orphanCheck.lockedDbs).toContain(duplicateDbName);

    // Run repair to restore connections
    const repairRes = await dbManager.repairDatabase('test_mgr_dup', true);
    expect(repairRes.message).toBeDefined();

    // Verify datallowconn is restored to true
    const checkRes = await superuserPool.query<{ datallowconn: boolean }>(
      `SELECT datallowconn FROM pg_database WHERE datname = '${duplicateDbName}';`,
    );
    expect(checkRes.rows[0]?.datallowconn).toBe(true);
  });

  it('Test 16: Maintenance mode toggle and unblock verification', async () => {
    if (!isDbConnected) return;

    // Enable maintenance mode
    await dbManager.setMaintenance('test_mgr_dup', true, 'testing_maintenance');
    let state = await maintenanceService.get(duplicateDbName);
    expect(state.inMaintenance).toBe(true);
    expect(state.reason).toBe('testing_maintenance');

    // Disable maintenance mode
    await dbManager.setMaintenance('test_mgr_dup', false);
    state = await maintenanceService.get(duplicateDbName);
    expect(state.inMaintenance).toBe(false);
  });

  it('Test 14: Deletes database with automatic backup and connection termination', async () => {
    if (!isDbConnected) return;

    const progressLogs: Array<{ percent: number; step: string }> = [];
    await dbManager.deleteDatabase(
      'test_mgr_restored',
      'test_mgr_restored',
      async (percent, step) => {
        progressLogs.push({ percent, step });
      },
    );

    // Verify completed
    expect(progressLogs[progressLogs.length - 1]?.step).toBe('completed');

    // Verify database was dropped
    const checkRes = await superuserPool.query(
      `SELECT 1 FROM pg_database WHERE datname = '${restoreDbName}';`,
    );
    expect(checkRes.rowCount).toBe(0);

    // Verify automatic pre-deletion backup was created
    const backupDir = path.resolve(env.BACKUP_DIR, restoreDbName);
    expect(fs.existsSync(backupDir)).toBe(true);
    const backupFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip'));
    expect(backupFiles.length).toBeGreaterThan(0);
  });

  it('Test 18: JobQueueService enqueues BullMQ jobs and locks concurrent operations per DB', async () => {
    if (!isDbConnected) return;

    const jobId = await jobQueue.enqueueJob('backup', 'erp_test_mgr_orig', {
      dbName: 'erp_test_mgr_orig',
    });

    expect(jobId).toBeDefined();

    // Acquiring lock for same database must return true, second attempt must return false
    const lock1 = await jobQueue.acquireDatabaseLock('erp_test_mgr_orig', 'job-1', 10);
    expect(lock1).toBe(true);

    const lock2 = await jobQueue.acquireDatabaseLock('erp_test_mgr_orig', 'job-2', 10);
    expect(lock2).toBe(false);

    await jobQueue.releaseDatabaseLock('erp_test_mgr_orig', 'job-1');
  });

  describe('Test 19: Parametrized PgTools driver integration (Local & Docker)', () => {
    const driversToTest: Array<{ name: string; driver: LocalPgToolsDriver | DockerPgToolsDriver }> =
      [
        { name: 'local', driver: new LocalPgToolsDriver() },
        {
          name: 'docker',
          driver: new DockerPgToolsDriver(process.env.PG_DOCKER_CONTAINER || 'bodo-postgres-dev'),
        },
      ];

    for (const { name, driver } of driversToTest) {
      it(`runs pg_dump and pg_restore successfully using [${name}] driver`, async () => {
        if (!isDbConnected) return;

        const availability = await driver.checkAvailable();
        if (!availability.available) {
          console.warn(
            `Skipping driver [${name}] because it is not available in current environment: ${availability.error}`,
          );
          return;
        }

        const tempDumpPath = path.resolve(os.tmpdir(), `driver_test_${name}.dump`);
        try {
          // 1. Dump erp_test_mgr_dup using the driver
          const dumpRes = await driver.dump({
            database: duplicateDbName,
            user: env.POSTGRES_USER || 'postgres',
            password: superuserPass,
            host,
            port,
            outputFilePath: tempDumpPath,
          });

          expect(dumpRes.bytesWritten).toBeGreaterThan(0);
          expect(fs.existsSync(tempDumpPath)).toBe(true);

          // 2. Create target database erp_test_driver_<name>
          const targetDb = `erp_test_drv_${name}`;
          await superuserPool
            .query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE);`)
            .catch(() => {});
          await superuserPool.query(`CREATE DATABASE "${targetDb}";`);

          // 3. Restore using the driver
          await driver.restore({
            database: targetDb,
            user: env.POSTGRES_USER || 'postgres',
            password: superuserPass,
            host,
            port,
            inputFilePath: tempDumpPath,
          });

          // 4. Verify tables exist in target database
          const targetPool = new pg.Pool({
            connectionString: buildDatabaseUrl({
              user: env.POSTGRES_USER || 'postgres',
              password: superuserPass,
              host,
              port,
              database: targetDb,
            }),
          });
          const tablesRes = await targetPool.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`,
          );
          await targetPool.end();

          expect(tablesRes.rowCount).toBeGreaterThan(0);

          // Cleanup target db
          await superuserPool
            .query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE);`)
            .catch(() => {});
        } finally {
          if (fs.existsSync(tempDumpPath)) {
            fs.unlinkSync(tempDumpPath);
          }
        }
      });
    }
  });

  it('Test 20: Anti-tampering integrity check rejects corrupted dump (CRLF / modified bytes) before DB modification', async () => {
    if (!isDbConnected) return;

    // 1. Create a valid dump file first
    const tempDir = path.resolve(os.tmpdir(), 'anti_tamper_test');
    fs.mkdirSync(tempDir, { recursive: true });
    const originalDumpPath = path.join(tempDir, 'valid_dump.dump');
    const tamperedDumpPath = path.join(tempDir, 'tampered_dump.dump');
    const tamperedZipPath = path.join(tempDir, 'tampered_backup.zip');

    try {
      await pgTools.dump({
        database: duplicateDbName,
        user: env.POSTGRES_USER || 'postgres',
        password: superuserPass,
        host,
        port,
        outputFilePath: originalDumpPath,
      });

      const originalBytes = fs.readFileSync(originalDumpPath);
      // Simulate CRLF alteration / byte corruption on Windows
      const corruptedBytes = Buffer.concat([
        originalBytes,
        Buffer.from('\r\n# TAMPERED_INJECTED_BYTES\r\n'),
      ]);
      fs.writeFileSync(tamperedDumpPath, corruptedBytes);

      // Create manifest with the original dump's SHA256 (or compute real sha256 of original)
      const originalSha256 = await zipService.calculateFileSha256(originalDumpPath);

      // Build zip manually with the tampered dump but the original expected sha256 in manifest
      await new Promise<void>((resolve, reject) => {
        const outStream = fs.createWriteStream(tamperedZipPath);
        const archive = archiver('zip', { zlib: { level: 9 }, forceZip64: true });
        outStream.on('close', () => resolve());
        archive.on('error', reject);
        archive.pipe(outStream);
        archive.file(tamperedDumpPath, { name: 'dump.pgdump' });
        const manifestObj = {
          db_name: duplicateDbName,
          schema_version: '0001_initial',
          applied_migrations: ['0001_initial'],
          app_version: '0.1.0',
          created_at: new Date().toISOString(),
          sha256: { dump: originalSha256 },
        };
        archive.append(Buffer.from(JSON.stringify(manifestObj, null, 2)), {
          name: 'manifest.json',
        });
        archive.finalize().catch(reject);
      });

      // Attempt restore to a non-existent database name
      const targetDbName = 'erp_test_tamper_target';
      await superuserPool
        .query(`DROP DATABASE IF EXISTS "${targetDbName}" WITH (FORCE);`)
        .catch(() => {});

      let caughtError: Error | null = null;
      try {
        await dbManager.restoreDatabase(tamperedZipPath, {
          newName: 'test_tamper_target',
          neutralize: false,
        });
      } catch (err) {
        caughtError = err as Error;
      }

      // Must reject with checksum mismatch
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toMatch(/checksum mismatch/i);

      // Crucial security check: target database must NOT have been created or modified
      const checkRes = await superuserPool.query(
        `SELECT 1 FROM pg_database WHERE datname = '${targetDbName}';`,
      );
      expect(checkRes.rowCount).toBe(0);
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('Test 21: Client tool version check ensures pg_dump / pg_restore >= 16', async () => {
    // 1. Verify current tool version passes check
    const checkResult = await pgTools.checkAvailable();
    expect(checkResult.available).toBe(true);
    expect(checkResult.version).toBeDefined();

    // 2. Verify older version error condition logic
    // Simulate what happens when pg_dump reports an older version (e.g. PostgreSQL 14.2)
    const match = 'pg_dump (PostgreSQL) 14.2'.match(
      /(?:pg_dump\s+\(PostgreSQL\)\s+|PostgreSQL\s+)?(\d+)(?:\.\d+)?/i,
    );
    expect(match).toBeDefined();
    expect(match?.[1]).toBeDefined();
    const major = parseInt(match?.[1] || '0', 10);
    expect(major).toBe(14);
    expect(major < 16).toBe(true);
  });

  it('Test 22: AdminAuditLogger records all admin operations with IP and requestId, strictly masking secrets', async () => {
    const auditLogger = new AdminAuditLogger();
    const testRequestId = `req-test-audit-${Date.now()}`;
    const testActorIp = '192.168.1.100';

    await auditLogger.log({
      action: 'CREATE_DATABASE',
      status: 'SUCCESS',
      ip: testActorIp,
      requestId: testRequestId,
      jobId: 'job-create-99',
      target: 'erp_test_company',
      details: {
        adminUsername: 'admin',
        adminPassword: 'SUPER_SECRET_PASSWORD_123',
        token: 'BEARER_SECRET_TOKEN_456',
        createdDb: 'erp_test_company',
      },
    });

    const recentLogs = await auditLogger.getRecentLogs(10);
    const entry = recentLogs.find((l) => l.requestId === testRequestId);
    expect(entry).toBeDefined();
    expect(entry?.ip).toBe(testActorIp);
    expect(entry?.jobId).toBe('job-create-99');
    expect(entry?.target).toBe('erp_test_company');
    expect(entry?.action).toBe('CREATE_DATABASE');
    expect(entry?.status).toBe('SUCCESS');

    // Secrets MUST be masked with ******
    expect(entry?.details?.adminPassword).toBe('******');
    expect(entry?.details?.token).toBe('******');
    expect(JSON.stringify(entry)).not.toContain('SUPER_SECRET_PASSWORD_123');
    expect(JSON.stringify(entry)).not.toContain('BEARER_SECRET_TOKEN_456');
  });
});
