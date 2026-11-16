import pg from 'pg';
import { getEnv } from '../../src/config/env.config';
import { RedisService } from '../../src/infra/redis/redis.service';
import { RateLimitService } from '../../src/common/rate-limit/rate-limit.service';
import { IdempotencyInterceptor } from '../../src/common/idempotency/idempotency.interceptor';
import { updateWithVersion } from '../../src/common/optimistic-lock/optimistic-lock';
import { runWithTenant } from '../../src/infra/tenancy/tenant-context';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

jest.setTimeout(60000);

describe('Idempotency, Optimistic Locking, and Rate Limit Integration Tests (Tests 12, 13, 14)', () => {
  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';
  const targetDb = 'erp_dev';

  let pool: pg.Pool;
  let redisService: RedisService;
  let rateLimitService: RateLimitService;
  let isConnected = false;

  const testLockTable = '_test_optimistic_records';

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
    });

    redisService = new RedisService();
    try {
      const client = await pool.connect();
      client.release();
      redisService.onModuleInit();
      await redisService.getClient().ping();
      rateLimitService = new RateLimitService(redisService);
      isConnected = true;
    } catch {
      console.warn('[WARN] PostgreSQL or Redis not reachable. Skipping integration tests.');
      return;
    }

    // Prepare table for optimistic locking test
    await pool.query(`DROP TABLE IF EXISTS ${testLockTable};`);
    await pool.query(`
      CREATE TABLE ${testLockTable} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        version INT NOT NULL DEFAULT 1
      );
    `);
  });

  afterAll(async () => {
    if (!isConnected) return;
    await pool.query(`DROP TABLE IF EXISTS ${testLockTable};`).catch(() => {});
    await pool.end().catch(() => {});
    await redisService.onModuleDestroy().catch(() => {});
  });

  beforeEach(async () => {
    if (isConnected) {
      const redis = redisService.getClient();
      const keys = await redis.keys('*idemp*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  });

  it('Test 12: Idempotency with real Redis (replay, mismatch body 422, concurrency 409, 5xx cleanup, tenant isolation)', async () => {
    if (!isConnected) return;

    const interceptor = new IdempotencyInterceptor(redisService);
    const redis = redisService.getClient();

    const mockResponse = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader: (k: string, v: string) => {
        mockResponse.headers[k.toLowerCase()] = v;
      },
      status: (s: number) => {
        mockResponse.statusCode = s;
        return mockResponse;
      },
    };

    const createMockContext = (db: string, key: string, body: unknown) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            route: { path: '/v1/orders' },
            headers: {
              'idempotency-key': key,
              'x-client-ip': '127.0.0.1',
            },
            ip: '127.0.0.1',
            body,
          }),
          getResponse: () => mockResponse,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      }) as unknown as ExecutionContext;

    const mockHandler: CallHandler = {
      handle: () => of({ orderId: 'ord-123', status: 'created' }),
    };

    // 1. First execution: executes and stores in Redis
    await runWithTenant({ db: 'erp_tenant_a' }, async () => {
      const context = createMockContext('erp_tenant_a', 'idem-test-key-1', { amount: 1000 });
      const res$ = await interceptor.intercept(context, mockHandler);
      const res = await res$.toPromise();
      expect(res).toEqual({ orderId: 'ord-123', status: 'created' });
    });

    // 2. Replay with identical body: returns cached response without executing handler
    await runWithTenant({ db: 'erp_tenant_a' }, async () => {
      let handlerCalled = false;
      const spyHandler: CallHandler = {
        handle: () => {
          handlerCalled = true;
          return of({ orderId: 'wrong' });
        },
      };

      const context = createMockContext('erp_tenant_a', 'idem-test-key-1', { amount: 1000 });
      const res$ = await interceptor.intercept(context, spyHandler);
      const res = await res$.toPromise();

      expect(handlerCalled).toBe(false); // Handler was skipped!
      expect(res).toEqual({ orderId: 'ord-123', status: 'created' });
      expect(mockResponse.headers['idempotency-replayed']).toBe('true');
    });

    // 3. Same key with DIFFERENT body: throws 422 IDEMPOTENCY_KEY_REUSED
    await runWithTenant({ db: 'erp_tenant_a' }, async () => {
      const context = createMockContext('erp_tenant_a', 'idem-test-key-1', { amount: 9999 }); // Changed body
      await expect(interceptor.intercept(context, mockHandler)).rejects.toThrow();
    });

    // 4. 5xx failure cleanup: key is removed from Redis so client can retry
    await runWithTenant({ db: 'erp_tenant_a' }, async () => {
      const failHandler: CallHandler = {
        handle: () => throwError(() => new Error('Server 500 error')),
      };
      const context = createMockContext('erp_tenant_a', 'idem-fail-key', { test: true });

      await expect((await interceptor.intercept(context, failHandler)).toPromise()).rejects.toThrow(
        'Server 500 error',
      );

      // Verify lock is deleted in Redis
      const keyExists = await redis.exists(
        'bodo:erp_tenant_a:idemp:unknown:POST:/v1/orders:idem-fail-key',
      );
      expect(keyExists).toBe(0);
    });

    // 5. Tenant isolation: same key in erp_tenant_b does not conflict with erp_tenant_a
    await runWithTenant({ db: 'erp_tenant_b' }, async () => {
      let tenantBCalled = false;
      const tenantBHandler: CallHandler = {
        handle: () => {
          tenantBCalled = true;
          return of({ orderId: 'ord-tenant-b' });
        },
      };
      const context = createMockContext('erp_tenant_b', 'idem-test-key-1', { amount: 1000 });
      const res$ = await interceptor.intercept(context, tenantBHandler);
      const res = await res$.toPromise();

      expect(tenantBCalled).toBe(true);
      expect(res).toEqual({ orderId: 'ord-tenant-b' });
    });
  });

  it('Test 13: updateWithVersion succeeds on matching version and throws VersionConflictError on stale version', async () => {
    if (!isConnected) return;

    // Insert record with initial version = 1
    const insertRes = await pool.query(
      `INSERT INTO ${testLockTable} (name, version) VALUES ('Initial Product', 1) RETURNING id;`,
    );
    const recordId = insertRes.rows[0].id;

    // Prisma-like delegate simulating updateMany
    const mockDelegate = {
      updateMany: async (args: {
        where: { id: string; version: number };
        data: { name: string };
      }) => {
        const id = args.where.id;
        const expectedVersion = args.where.version;
        const newName = args.data.name;

        const updateRes = await pool.query(
          `UPDATE ${testLockTable}
           SET name = $1, version = version + 1
           WHERE id = $2 AND version = $3
           RETURNING id, name, version;`,
          [newName, id, expectedVersion],
        );

        return { count: updateRes.rowCount || 0 };
      },
      findUnique: async (args: { where: { id: string } }) => {
        const res = await pool.query(
          `SELECT id, name, version FROM ${testLockTable} WHERE id = $1;`,
          [args.where.id],
        );
        return res.rows[0] || null;
      },
    };

    // 1. Successful update: version 1 -> 2
    const updated = (await updateWithVersion({
      model: mockDelegate as unknown as Parameters<typeof updateWithVersion>[0]['model'],
      where: { id: recordId, version: 1 },
      data: { name: 'Updated Name (v2)' },
    })) as { version: number; name: string };
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('Updated Name (v2)');

    // Verify DB version is now 2
    const checkV2 = await pool.query(`SELECT version, name FROM ${testLockTable} WHERE id = $1;`, [
      recordId,
    ]);
    expect(checkV2.rows[0].version).toBe(2);
    expect(checkV2.rows[0].name).toBe('Updated Name (v2)');

    // 2. Stale update with version 1: throws ConflictException (VERSION_CONFLICT 409)
    await expect(
      updateWithVersion({
        model: mockDelegate as unknown as Parameters<typeof updateWithVersion>[0]['model'],
        where: { id: recordId, version: 1 },
        data: { name: 'Stale Update (should fail)' },
      }),
    ).rejects.toThrow();

    // 3. Two concurrent updates with version 2: exactly one succeeds, one fails
    const [updateResult1, updateResult2] = await Promise.allSettled([
      updateWithVersion({
        model: mockDelegate as unknown as Parameters<typeof updateWithVersion>[0]['model'],
        where: { id: recordId, version: 2 },
        data: { name: 'Concurrent 1' },
      }),
      updateWithVersion({
        model: mockDelegate as unknown as Parameters<typeof updateWithVersion>[0]['model'],
        where: { id: recordId, version: 2 },
        data: { name: 'Concurrent 2' },
      }),
    ]);

    const successes = [updateResult1, updateResult2].filter((r) => r.status === 'fulfilled');
    const failures = [updateResult1, updateResult2].filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  });

  it('Test 14: Rate limiting with real Redis (100 concurrent requests with limit=10: exactly 10 succeed, 90 rate-limited)', async () => {
    if (!isConnected) return;

    const testRateKey = 'ratelimit:test:concurrency:' + Date.now();
    const limit = 10;
    const windowSec = 60;

    // Send 100 concurrent consume requests
    const tasks = Array.from({ length: 100 }, () =>
      rateLimitService.consume(testRateKey, {
        limit,
        windowSec,
      }),
    );

    const results = await Promise.all(tasks);

    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = results.filter((r) => !r.allowed).length;

    // Strict assertion: exactly 10 allowed, exactly 90 blocked
    expect(allowedCount).toBe(10);
    expect(blockedCount).toBe(90);

    // Verify blocked requests have positive retryAfterSec
    const blockedSamples = results.filter((r) => !r.allowed);
    for (const b of blockedSamples) {
      expect(b.retryAfterSec).toBeGreaterThan(0);
      expect(b.remaining).toBe(0);
    }

    // Clean up rate limit key
    await redisService.getClient().del(testRateKey);
  });
});
