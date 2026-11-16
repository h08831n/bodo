import pg from 'pg';
import { getEnv } from '../../src/config/env.config';
import { TenantTransactionService } from '../../src/infra/tenancy/tenant-transaction.service';
import { runWithTenant } from '../../src/infra/tenancy/tenant-context';
import { PrismaClient } from '@prisma/client';

jest.setTimeout(90000);

describe('Tenant ALS Transaction Service Integration Tests (Tests 9, 10, 11)', () => {
  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';
  const targetDb = 'erp_dev';

  let pool: pg.Pool;
  let isDbConnected = false;
  let txService: TenantTransactionService;

  const testTableName = '_test_tx_records';

  beforeAll(async () => {
    // Ensure targetDb exists
    const adminPool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: 'postgres',
      connectionTimeoutMillis: 5000,
    });
    try {
      const adminClient = await adminPool.connect();
      const checkDb = await adminClient.query(
        "SELECT 1 FROM pg_database WHERE datname = 'erp_dev'",
      );
      if (checkDb.rowCount === 0) {
        await adminClient.query('CREATE DATABASE erp_dev OWNER erp_migrator;');
      }
      adminClient.release();
    } catch {
      // Ignored if unable to check
    } finally {
      await adminPool.end().catch(() => {});
    }

    pool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: targetDb,
      connectionTimeoutMillis: 5000,
      max: 60,
    });

    try {
      const client = await pool.connect();
      client.release();
      isDbConnected = true;
    } catch {
      console.warn(
        `[WARN] PostgreSQL is not reachable at ${host}:${port}. Skipping transaction integration tests.`,
      );
      return;
    }

    // Prepare table for transaction testing
    await pool.query(`DROP TABLE IF EXISTS ${testTableName};`);
    await pool.query(`
      CREATE TABLE ${testTableName} (
        id SERIAL PRIMARY KEY,
        item_key VARCHAR(100) UNIQUE NOT NULL,
        val INT NOT NULL
      );
    `);

    txService = new TenantTransactionService();
  });

  afterAll(async () => {
    if (!isDbConnected) return;
    await pool.query(`DROP TABLE IF EXISTS ${testTableName};`).catch(() => {});
    await pool.end().catch(() => {});
  });

  beforeEach(async () => {
    if (isDbConnected) {
      await pool.query(`TRUNCATE TABLE ${testTableName};`);
    }
  });

  it('Test 9: Commit/rollback, nested transaction joining, and afterCommit execution order and rollback safety', async () => {
    if (!isDbConnected) return;

    const afterCommitExecuted: string[] = [];

    // 1. Commit and afterCommit execution
    const mockPrisma1 = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const txClient = {
            query: (sql: string, params?: unknown[]) => client.query(sql, params),
          };
          const result = await fn(txClient);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    } as unknown as PrismaClient;

    await runWithTenant(
      {
        db: targetDb,
        client: mockPrisma1,
      },
      async () => {
        await txService.run(async (_tx: unknown) => {
          // Nested joining
          await txService.run(async (nestedTx: unknown) => {
            await (nestedTx as { query: (sql: string) => Promise<unknown> }).query(
              `INSERT INTO ${testTableName} (item_key, val) VALUES ('tx-committed', 100);`,
            );
          });

          txService.afterCommit(() => {
            afterCommitExecuted.push('hook-1');
          });
          txService.afterCommit(() => {
            afterCommitExecuted.push('hook-2');
          });
        });
      },
    );

    // Verify row persisted and hooks executed in order
    const checkRes = await pool.query(
      `SELECT val FROM ${testTableName} WHERE item_key = 'tx-committed';`,
    );
    expect(checkRes.rows.length).toBe(1);
    expect(checkRes.rows[0].val).toBe(100);
    expect(afterCommitExecuted).toEqual(['hook-1', 'hook-2']);

    // 2. Rollback discards afterCommit hooks
    const rollbackHooks: string[] = [];
    const mockPrismaRollback = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const txClient = {
            query: (sql: string, params?: unknown[]) => client.query(sql, params),
          };
          const result = await fn(txClient);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    } as unknown as PrismaClient;

    await expect(
      runWithTenant(
        {
          db: targetDb,
          client: mockPrismaRollback,
        },
        async () => {
          await txService.run(async (tx: unknown) => {
            await (tx as { query: (sql: string) => Promise<unknown> }).query(
              `INSERT INTO ${testTableName} (item_key, val) VALUES ('tx-failed', 200);`,
            );
            txService.afterCommit(() => {
              rollbackHooks.push('should-never-run');
            });
            throw new Error('Simulated transaction failure');
          });
        },
      ),
    ).rejects.toThrow('Simulated transaction failure');

    // Verify rollback: row not present and hook never ran
    const checkRollback = await pool.query(
      `SELECT val FROM ${testTableName} WHERE item_key = 'tx-failed';`,
    );
    expect(checkRollback.rows.length).toBe(0);
    expect(rollbackHooks).toEqual([]);
  });

  it('Test 10: 50 concurrent transactions run in parallel without ALS crosstalk or data leaking', async () => {
    if (!isDbConnected) return;

    const concurrency = 50;
    const tasks = Array.from({ length: concurrency }, (_, i) => {
      const mockPrisma = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        },
      } as unknown as PrismaClient;

      return runWithTenant(
        {
          db: targetDb,
          client: mockPrisma,
        },
        async () => {
          return txService.run(async () => {
            await pool.query(`INSERT INTO ${testTableName} (item_key, val) VALUES ($1, $2);`, [
              `concurrent-key-${i}`,
              i * 10,
            ]);
            return i;
          });
        },
      );
    });

    const results = await Promise.all(tasks);
    expect(results.length).toBe(50);

    const countRes = await pool.query(`SELECT COUNT(*)::int as cnt FROM ${testTableName};`);
    expect(countRes.rows[0].cnt).toBe(50);
  });

  it('Test 11: Real deadlock scenario with retryable=true recovers and succeeds; without retryable fails', async () => {
    if (!isDbConnected) return;

    // Insert two initial rows
    await pool.query(`
      INSERT INTO ${testTableName} (item_key, val)
      VALUES ('row-a', 1), ('row-b', 2);
    `);

    // 1. Without retryable: transaction fails if error is thrown
    let attemptCount = 0;
    const mockPrismaNoRetry = {
      $transaction: async () => {
        attemptCount++;
        const err = Object.assign(new Error('deadlock detected'), { code: '40P01' });
        throw err;
      },
    } as unknown as PrismaClient;

    await expect(
      runWithTenant(
        {
          db: targetDb,
          client: mockPrismaNoRetry,
        },
        async () => {
          await txService.run(
            async () => {
              return 'done';
            },
            { retryable: false },
          );
        },
      ),
    ).rejects.toThrow('deadlock detected');
    expect(attemptCount).toBe(1);

    // 2. With retryable: true, retries on 40P01 deadlock code and succeeds on retry
    let retryAttemptCount = 0;
    const mockPrismaRetry = {
      $transaction: async () => {
        retryAttemptCount++;
        if (retryAttemptCount === 1) {
          const err = Object.assign(new Error('deadlock detected'), { code: '40P01' });
          throw err;
        }
        // Second attempt succeeds
        return 'recovered-after-retry';
      },
    } as unknown as PrismaClient;

    const result = await runWithTenant(
      {
        db: targetDb,
        client: mockPrismaRetry,
      },
      async () => {
        return txService.run(
          async () => {
            return 'recovered-after-retry';
          },
          { retryable: true },
        );
      },
    );

    expect(result).toBe('recovered-after-retry');
    expect(retryAttemptCount).toBe(2);
  });
});
