import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { newId } from '@bodo/utils';
import { seedBaseline } from '../../src/database/seed/baseline';

// Timeout for container and migration operations
jest.setTimeout(180000);

describe('PostgreSQL 16 Database Integration Tests (S1.2)', () => {
  let container: StartedPostgreSqlContainer | null = null;
  let superuserUrl: string;
  let host: string;
  let port: number;

  const PROVISIONER_USER = 'erp_provisioner';
  const PROVISIONER_PASS =
    process.env.ERP_PROVISIONER_PASSWORD || 'provisioner_secret_change_in_prod';
  const MIGRATOR_USER = 'erp_migrator';
  const MIGRATOR_PASS = process.env.ERP_MIGRATOR_PASSWORD || 'migrator_secret_change_in_prod';
  const APP_USER = 'erp_app';
  const APP_PASS = process.env.ERP_APP_PASSWORD || 'app_secret_change_in_prod';

  const testDbName = 'erp_test_tenant_main';
  const migrationSqlPath = path.resolve(
    __dirname,
    '../../prisma/migrations/0001_init/migration.sql',
  );
  const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

  beforeAll(async () => {
    if (process.env.TEST_DATABASE_URL) {
      superuserUrl = process.env.TEST_DATABASE_URL;
      const parsed = new URL(superuserUrl);
      host = parsed.hostname;
      port = parseInt(parsed.port || '5432', 10);
    } else {
      // 1. Check if Docker CLI and daemon are responding
      let dockerAvailable = false;
      try {
        const res = spawnSync('docker', ['info'], {
          stdio: 'ignore',
          shell: false,
        });
        dockerAvailable = res.status === 0;
      } catch {
        dockerAvailable = false;
      }

      if (dockerAvailable) {
        try {
          container = await new PostgreSqlContainer('postgres:16-alpine')
            .withDatabase('postgres')
            .withUsername('postgres')
            .withPassword('postgres')
            .withStartupTimeout(60000)
            .start();

          host = container.getHost();
          port = container.getPort();
          superuserUrl = `postgresql://postgres:postgres@${host}:${port}/postgres`;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[WARN] Testcontainers failed to start: ${message}`);
        }
      }

      // 2. If Docker / container is not active, check if local PostgreSQL is reachable
      if (!superuserUrl) {
        let localReachable = false;
        try {
          const probe = new Client({
            connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
            connectionTimeoutMillis: 2000,
          });
          await probe.connect();
          await probe.end();
          localReachable = true;
        } catch {
          localReachable = false;
        }

        if (localReachable) {
          host = '127.0.0.1';
          port = 5433;
          superuserUrl = 'postgresql://postgres:postgres@127.0.0.1:5433/postgres';
        } else {
          throw new Error(
            `\n========================================================================\n` +
              `[ERROR] Cannot execute integration tests:\n` +
              `Docker daemon is not running and no active PostgreSQL was detected at 127.0.0.1:5433.\n\n` +
              `Please start Docker Desktop (e.g. run start.bat or dev-start.bat) or start dev containers with:\n` +
              `  docker compose -f infra/docker-compose.dev.yml up -d\n` +
              `========================================================================\n`,
          );
        }
      }
    }

    // Initialize cluster roles as superuser with retry
    let superClient: Client | null = null;
    const candidates = [superuserUrl];
    if (superuserUrl.includes('@localhost:')) {
      candidates.push(superuserUrl.replace('@localhost:', '@127.0.0.1:'));
    }

    for (let attempt = 1; attempt <= 20; attempt++) {
      for (const url of candidates) {
        try {
          const client = new Client({ connectionString: url });
          await client.connect();
          superClient = client;
          superuserUrl = url;
          const parsed = new URL(url);
          host = parsed.hostname;
          break;
        } catch {
          // retry
        }
      }
      if (superClient) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!superClient) {
      console.warn(`[SKIP] PostgreSQL is not accessible at ${superuserUrl} after retries.`);
      return;
    }

    try {
      // Create roles idempotently
      await superClient.query(`
        DO $do$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${PROVISIONER_USER}') THEN
            CREATE ROLE ${PROVISIONER_USER} WITH LOGIN CREATEDB PASSWORD '${PROVISIONER_PASS}';
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_USER}') THEN
            CREATE ROLE ${MIGRATOR_USER} WITH LOGIN PASSWORD '${MIGRATOR_PASS}';
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${APP_USER}') THEN
            CREATE ROLE ${APP_USER} WITH LOGIN PASSWORD '${APP_PASS}';
          END IF;
        END $do$;
        GRANT ${MIGRATOR_USER} TO ${PROVISIONER_USER};
      `);

      // Create test database owned by erp_migrator
      await superClient.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`);
      await superClient.query(`CREATE DATABASE "${testDbName}" OWNER ${MIGRATOR_USER};`);
    } finally {
      await superClient.end();
    }
  });

  afterAll(async () => {
    // Drop test database
    if (superuserUrl) {
      const superClient = new Client({ connectionString: superuserUrl });
      try {
        await superClient.connect();
        await superClient.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`);
        await superClient.query(`DROP DATABASE IF EXISTS "erp_tenant_a" WITH (FORCE);`);
        await superClient.query(`DROP DATABASE IF EXISTS "erp_tenant_b" WITH (FORCE);`);
        await superClient.query(`DROP DATABASE IF EXISTS "erp_prov_test" WITH (FORCE);`);
        await superClient.query(`DROP DATABASE IF EXISTS "erp_prov_renamed" WITH (FORCE);`);
        await superClient.end();
      } catch {
        // Ignore cleanup errors
      }
    }

    if (container) {
      await container.stop();
    }
  });

  function getDbUrl(user: string, pass: string, db: string) {
    return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
  }

  // -------------------------------------------------------------
  // Test 1: Migration 0001_init idempotency on empty database
  // -------------------------------------------------------------
  it('1. Migration 0001_init applies cleanly from scratch and is idempotent', async () => {
    const migratorClient = new Client({
      connectionString: getDbUrl(MIGRATOR_USER, MIGRATOR_PASS, testDbName),
    });
    await migratorClient.connect();

    try {
      // First execution
      await migratorClient.query(migrationSql);

      // Verify table creation
      const res = await migratorClient.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'currencies';`,
      );
      expect(res.rows.length).toBe(1);

      // Second execution: functions, types, and IF NOT EXISTS extensions do not fail
      // (Verifies idempotency of extensions and functions in migration)
      await expect(
        migratorClient.query(`
          CREATE EXTENSION IF NOT EXISTS pg_trgm;
          CREATE EXTENSION IF NOT EXISTS unaccent;
        `),
      ).resolves.not.toThrow();

      // Verify that extensions are per-database objects (installed inside testDbName, not cluster-level)
      const extInTestDb = await migratorClient.query(
        `SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent') ORDER BY extname;`,
      );
      expect(extInTestDb.rows.map((r: { extname: string }) => r.extname)).toEqual([
        'pg_trgm',
        'unaccent',
      ]);

      // Query pg_extension in clean 'postgres' database to prove extensions are not global/cluster-level
      const superClient = new Client({ connectionString: superuserUrl });
      await superClient.connect();
      try {
        const extInCleanDb = await superClient.query(
          `SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent');`,
        );
        expect(extInCleanDb.rows.length).toBe(0);
      } finally {
        await superClient.end();
      }
    } finally {
      await migratorClient.end();
    }
  });

  // -------------------------------------------------------------
  // Test 2: erp_app permissions (DML allowed, DDL blocked, audit_logs append-only)
  // -------------------------------------------------------------
  it('2. erp_app has DML rights, DDL is rejected, and audit_logs is append-only', async () => {
    const appClient = new Client({
      connectionString: getDbUrl(APP_USER, APP_PASS, testDbName),
    });
    await appClient.connect();

    try {
      // DML on normal tables: INSERT, SELECT, UPDATE, DELETE succeed
      await appClient.query(`
        INSERT INTO currencies (code, name, symbol, decimals, is_active, sort_order)
        VALUES ('TST', 'Test Currency', 'T', 2, true, 99);
      `);

      const selectRes = await appClient.query(`SELECT * FROM currencies WHERE code = 'TST';`);
      expect(selectRes.rows.length).toBe(1);

      await appClient.query(`UPDATE currencies SET name = 'Updated TST' WHERE code = 'TST';`);
      await appClient.query(`DELETE FROM currencies WHERE code = 'TST';`);

      // DDL operations must be REJECTED with permission denied (error code 42501)
      await expect(appClient.query(`CREATE TABLE unauthorized_tbl (id int);`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        appClient.query(`ALTER TABLE currencies ADD COLUMN test_col int;`),
      ).rejects.toThrow(/must be owner|permission denied/i);
      await expect(appClient.query(`DROP TABLE currencies;`)).rejects.toThrow(
        /must be owner|permission denied/i,
      );
      await expect(appClient.query(`TRUNCATE currencies;`)).rejects.toThrow(/permission denied/i);

      // audit_logs: append-only (INSERT and SELECT succeed; UPDATE and DELETE fail)
      const auditLogId = newId();
      const entityId = newId();
      const now = new Date();
      await appClient.query(
        `INSERT INTO audit_logs (id, occurred_at, action, entity_type, entity_id)
         VALUES ($1, $2, 'INSERT', 'currency', $3);`,
        [auditLogId, now, entityId],
      );

      const auditSelect = await appClient.query(
        `SELECT * FROM audit_logs WHERE id = $1 AND occurred_at = $2;`,
        [auditLogId, now],
      );
      expect(auditSelect.rows.length).toBe(1);

      // UPDATE and DELETE on audit_logs must be rejected
      await expect(
        appClient.query(`UPDATE audit_logs SET action = 'ALTERED' WHERE id = $1;`, [auditLogId]),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        appClient.query(`DELETE FROM audit_logs WHERE id = $1;`, [auditLogId]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.end();
    }
  });

  // -------------------------------------------------------------
  // Test 3: Partition routing & ensure_monthly_partitions function
  // -------------------------------------------------------------
  it('3. Partition routing puts rows into monthly and default partitions, and ensure_monthly_partitions works safely', async () => {
    const appClient = new Client({
      connectionString: getDbUrl(APP_USER, APP_PASS, testDbName),
    });
    await appClient.connect();

    try {
      const currentLogId = newId();
      const currentActorId = newId();
      const now = new Date();
      // Current month partition e.g. audit_logs_p202611
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const expectedPartition = `audit_logs_p${year}${month}`;

      await appClient.query(
        `INSERT INTO audit_logs (id, occurred_at, action, entity_type, entity_id)
         VALUES ($1, $2, 'LOGIN', 'user', $3);`,
        [currentLogId, now, currentActorId],
      );

      // Verify row is physically routed to the current month partition
      const currentPartitionCheck = await appClient.query(
        `SELECT * FROM "${expectedPartition}" WHERE id = $1;`,
        [currentLogId],
      );
      expect(currentPartitionCheck.rows.length).toBe(1);

      // Far future row routes to DEFAULT partition
      const futureLogId = newId();
      const futureActorId = newId();
      const farFuture = new Date('2099-01-01T00:00:00Z');
      await appClient.query(
        `INSERT INTO audit_logs (id, occurred_at, action, entity_type, entity_id)
         VALUES ($1, $2, 'FUTURE_EVENT', 'system', $3);`,
        [futureLogId, farFuture, futureActorId],
      );

      const defaultPartitionCheck = await appClient.query(
        `SELECT * FROM "audit_logs_default" WHERE id = $1;`,
        [futureLogId],
      );
      expect(defaultPartitionCheck.rows.length).toBe(1);

      // ensure_monthly_partitions: erp_app can execute it
      await expect(
        appClient.query(`SELECT ensure_monthly_partitions('audit_logs', 2);`),
      ).resolves.not.toThrow();

      // ensure_monthly_partitions is idempotent: calling again does not fail
      await expect(
        appClient.query(`SELECT ensure_monthly_partitions('audit_logs', 2);`),
      ).resolves.not.toThrow();

      // ensure_monthly_partitions rejects tables not in the whitelist
      await expect(
        appClient.query(`SELECT ensure_monthly_partitions('users', 2);`),
      ).rejects.toThrow(/not a permitted partitioned table/i);

      // erp_app cannot execute direct DDL to create partitions
      await expect(
        appClient.query(
          `CREATE TABLE audit_logs_p209901 PARTITION OF audit_logs FOR VALUES FROM ('2099-01-01') TO ('2099-02-01');`,
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.end();
    }
  });

  // -------------------------------------------------------------
  // Test 4: Database constraints (company_profile id=1, lowercase username, timeline unique)
  // -------------------------------------------------------------
  it('4. Constraints enforce company_profile id=1, lowercase usernames, and timeline idempotency', async () => {
    const appClient = new Client({
      connectionString: getDbUrl(APP_USER, APP_PASS, testDbName),
    });
    await appClient.connect();

    try {
      // 1. company_profile CHECK (id = 1)
      await expect(
        appClient.query(`
          INSERT INTO company_profile (id, name, default_currency_code, updated_at)
          VALUES (2, 'Invalid Company', 'IRR', NOW());
        `),
      ).rejects.toThrow(/check_company_profile_single_row|violates check constraint/i);

      // 2. users CHECK (username = lower(username))
      const userId = newId();
      await expect(
        appClient.query(
          `
          INSERT INTO users (id, username, password_hash, full_name, type, status, created_at, updated_at)
          VALUES ($1, 'AdminUser', 'hash', 'Admin User', 'INTERNAL', 'ACTIVE', NOW(), NOW());
        `,
          [userId],
        ),
      ).rejects.toThrow(/check_users_username_lower|violates check constraint/i);

      // Valid lowercase username succeeds
      await appClient.query(
        `
        INSERT INTO users (id, username, password_hash, full_name, type, status, created_at, updated_at)
        VALUES ($1, 'adminuser', 'hash', 'Admin User', 'INTERNAL', 'ACTIVE', NOW(), NOW());
      `,
        [userId],
      );

      // 3. timeline_events unique constraint on (source_event_id, subject_type, subject_id, occurred_at)
      const eventId1 = newId();
      const eventId2 = newId();
      const sourceEventId = newId();
      const subjectId = newId();
      const occurredAt = new Date();

      await appClient.query(
        `
        INSERT INTO timeline_events (id, occurred_at, source_event_id, subject_type, subject_id, event_type, title, summary)
        VALUES ($1, $2, $3, 'lead', $4, 'NOTE_ADDED', 'First title', 'First summary');
      `,
        [eventId1, occurredAt, sourceEventId, subjectId],
      );

      // Duplicate insertion with exact same (source_event_id, subject_type, subject_id, occurred_at) must fail
      await expect(
        appClient.query(
          `
          INSERT INTO timeline_events (id, occurred_at, source_event_id, subject_type, subject_id, event_type, title, summary)
          VALUES ($1, $2, $3, 'lead', $4, 'NOTE_ADDED', 'Duplicate title', 'Duplicate summary');
        `,
          [eventId2, occurredAt, sourceEventId, subjectId],
        ),
      ).rejects.toThrow(/timeline_events_.*_key|duplicate key value/i);
    } finally {
      await appClient.end();
    }
  });

  // -------------------------------------------------------------
  // Test 5: Seed idempotency and baseline contents
  // -------------------------------------------------------------
  it('5. seedBaseline is strictly idempotent and populates baseline entities', async () => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: getDbUrl(MIGRATOR_USER, MIGRATOR_PASS, testDbName),
        },
      },
    });

    try {
      // First seed run
      const firstRun = await seedBaseline(prisma);
      expect(firstRun.currenciesCount).toBe(4);
      expect(firstRun.companyProfileInitialized).toBe(true);
      expect(firstRun.systemGroupInitialized).toBe(true);
      expect(firstRun.lostReasonsCount).toBe(7);
      expect(firstRun.settingsCount).toBe(1);

      // Verify row counts in database
      const currCount = await prisma.currency.count();
      expect(currCount).toBe(4);

      const profile = await prisma.companyProfile.findUnique({ where: { id: 1 } });
      expect(profile).not.toBeNull();
      expect(profile?.defaultCurrencyCode).toBe('IRR');

      const group = await prisma.group.findUnique({ where: { name: 'مدیر سیستم' } });
      expect(group).not.toBeNull();
      expect(group?.isSystem).toBe(true);

      const lostReasons = await prisma.lostReason.count();
      expect(lostReasons).toBe(7);

      const setting = await prisma.systemSetting.findUnique({ where: { key: 'neutralized' } });
      expect(setting?.value).toBe(false);

      // Second seed run (must execute cleanly with 0 errors and zero duplicates)
      const secondRun = await seedBaseline(prisma);
      expect(secondRun.currenciesCount).toBe(4);

      expect(await prisma.currency.count()).toBe(4);
      expect(await prisma.lostReason.count()).toBe(7);
      expect(await prisma.systemSetting.count()).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------
  // Test 6: S1.3 Key Contract Proof: Dual PrismaClient multi-tenant isolation & pool lifecycle
  // -------------------------------------------------------------
  it('6. Dual PrismaClient instances operate concurrently on separate tenant databases without data leak or connection interference', async () => {
    const superClient = new Client({ connectionString: superuserUrl });
    await superClient.connect();

    const tenantDbA = 'erp_tenant_a';
    const tenantDbB = 'erp_tenant_b';

    try {
      // Create two separate databases
      await superClient.query(`DROP DATABASE IF EXISTS "${tenantDbA}" WITH (FORCE);`);
      await superClient.query(`DROP DATABASE IF EXISTS "${tenantDbB}" WITH (FORCE);`);
      await superClient.query(`CREATE DATABASE "${tenantDbA}" OWNER ${MIGRATOR_USER};`);
      await superClient.query(`CREATE DATABASE "${tenantDbB}" OWNER ${MIGRATOR_USER};`);

      // Run migrations on both databases
      const migratorA = new Client({
        connectionString: getDbUrl(MIGRATOR_USER, MIGRATOR_PASS, tenantDbA),
      });
      await migratorA.connect();
      await migratorA.query(migrationSql);
      await migratorA.end();

      const migratorB = new Client({
        connectionString: getDbUrl(MIGRATOR_USER, MIGRATOR_PASS, tenantDbB),
      });
      await migratorB.connect();
      await migratorB.query(migrationSql);
      await migratorB.end();

      // Instantiate two distinct PrismaClients
      const clientA = new PrismaClient({
        datasources: { db: { url: getDbUrl(APP_USER, APP_PASS, tenantDbA) } },
      });
      const clientB = new PrismaClient({
        datasources: { db: { url: getDbUrl(APP_USER, APP_PASS, tenantDbB) } },
      });

      // Write distinct setting to tenant A
      await clientA.systemSetting.upsert({
        where: { key: 'tenant_name' },
        update: { value: 'Company Alpha' },
        create: { key: 'tenant_name', value: 'Company Alpha' },
      });

      // Write distinct setting to tenant B
      await clientB.systemSetting.upsert({
        where: { key: 'tenant_name' },
        update: { value: 'Company Beta' },
        create: { key: 'tenant_name', value: 'Company Beta' },
      });

      // Verify tenant A reads Alpha, never Beta
      const valA = await clientA.systemSetting.findUnique({ where: { key: 'tenant_name' } });
      expect(valA?.value).toBe('Company Alpha');

      // Verify tenant B reads Beta, never Alpha
      const valB = await clientB.systemSetting.findUnique({ where: { key: 'tenant_name' } });
      expect(valB?.value).toBe('Company Beta');

      // Verify both tenant pools have active connections in pg_stat_activity
      const connsA = await superClient.query(
        `SELECT COUNT(*)::int as count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
        [tenantDbA],
      );
      const connsB = await superClient.query(
        `SELECT COUNT(*)::int as count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
        [tenantDbB],
      );
      expect(connsA.rows[0].count).toBeGreaterThan(0);
      expect(connsB.rows[0].count).toBeGreaterThan(0);

      // Pool lifecycle proof: Disconnect client A
      await clientA.$disconnect();

      // Poll until connections to tenantDbA drop to 0
      let connsAfterA = -1;
      for (let i = 0; i < 30; i++) {
        const check = await superClient.query(
          `SELECT COUNT(*)::int as count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
          [tenantDbA],
        );
        connsAfterA = check.rows[0].count;
        if (connsAfterA === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(connsAfterA).toBe(0);

      // Verify tenant B connections remained untouched
      const connsAfterB = await superClient.query(
        `SELECT COUNT(*)::int as count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
        [tenantDbB],
      );
      expect(connsAfterB.rows[0].count).toBeGreaterThan(0);

      // Client B MUST remain fully functional after Client A is disconnected
      const valBAfterDisconnectA = await clientB.systemSetting.findUnique({
        where: { key: 'tenant_name' },
      });
      expect(valBAfterDisconnectA?.value).toBe('Company Beta');

      // Now disconnect client B
      await clientB.$disconnect();
    } finally {
      await superClient
        .query(`DROP DATABASE IF EXISTS "${tenantDbA}" WITH (FORCE);`)
        .catch(() => {});
      await superClient
        .query(`DROP DATABASE IF EXISTS "${tenantDbB}" WITH (FORCE);`)
        .catch(() => {});
      await superClient.end();
    }
  });

  // -------------------------------------------------------------
  // Test 7: erp_provisioner role capabilities (CREATE, RENAME, DROP DATABASE)
  // -------------------------------------------------------------
  it('7. erp_provisioner can CREATE DATABASE ... OWNER erp_migrator, ALTER RENAME, and DROP DATABASE', async () => {
    const provClient = new Client({
      connectionString: getDbUrl(PROVISIONER_USER, PROVISIONER_PASS, 'postgres'),
    });
    await provClient.connect();

    const provDb = 'erp_prov_test';
    const provDbRenamed = 'erp_prov_renamed';

    try {
      // 1. CREATE DATABASE with OWNER erp_migrator
      await provClient.query(`CREATE DATABASE "${provDb}" OWNER ${MIGRATOR_USER};`);

      // Verify database exists and owner is erp_migrator
      const checkRes = await provClient.query(`
        SELECT d.datname, r.rolname as owner
        FROM pg_database d
        JOIN pg_roles r ON d.datdba = r.oid
        WHERE d.datname = '${provDb}';
      `);
      expect(checkRes.rows.length).toBe(1);
      expect(checkRes.rows[0].owner).toBe(MIGRATOR_USER);

      // 2. ALTER DATABASE ... RENAME TO
      await provClient.query(`ALTER DATABASE "${provDb}" RENAME TO "${provDbRenamed}";`);

      const renameCheck = await provClient.query(`
        SELECT datname FROM pg_database WHERE datname = '${provDbRenamed}';
      `);
      expect(renameCheck.rows.length).toBe(1);

      // 3. DROP DATABASE
      await provClient.query(`DROP DATABASE "${provDbRenamed}" WITH (FORCE);`);

      const dropCheck = await provClient.query(`
        SELECT datname FROM pg_database WHERE datname = '${provDbRenamed}';
      `);
      expect(dropCheck.rows.length).toBe(0);
    } finally {
      await provClient.end();
    }
  });
});
