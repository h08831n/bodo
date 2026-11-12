import pg from 'pg';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';
import { getEnv } from '../../src/config/env.config';

jest.setTimeout(60000);

interface TestableClientManager {
  maxClients: number;
  clients: Map<string, unknown>;
}

describe('TenantClientManager Invariants (Tests 6, 7, 8, 9)', () => {
  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';

  const dbA = 'erp_test_cm_a';
  const dbB = 'erp_test_cm_b';
  const dbC = 'erp_test_cm_c';

  let superuserPool: pg.Pool;

  beforeAll(async () => {
    superuserPool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: 'postgres',
    });

    // Create test databases owned by erp_migrator
    for (const db of [dbA, dbB, dbC]) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
      await superuserPool.query(`CREATE DATABASE ${db} OWNER erp_migrator;`);
    }
  });

  afterAll(async () => {
    for (const db of [dbA, dbB, dbC]) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`).catch(() => {});
    }
    await superuserPool.end().catch(() => {});
  });

  it('6. Single-flight: 50 concurrent requests for an uncached database instantiate exactly one PrismaClient', async () => {
    const manager = new TenantClientManager();

    const promises = Array.from({ length: 50 }, () => manager.getClient(dbA));
    const clients = await Promise.all(promises);

    expect(clients).toHaveLength(50);
    const firstClient = clients[0];
    for (const client of clients) {
      expect(client).toBe(firstClient);
    }

    expect(manager.stats().open).toBe(1);
    await manager.shutdown();
  });

  it('7. LRU eviction: capacity limits evict the oldest idle client to 0 pg connections without affecting others', async () => {
    const manager = new TenantClientManager();
    const testable = manager as unknown as TestableClientManager;
    testable.maxClients = 2;

    // Load dbA and dbB
    await manager.getClient(dbA);
    await manager.getClient(dbB);
    expect(manager.stats().open).toBe(2);

    // Now load dbC -> dbA is oldest idle, should be evicted
    await manager.getClient(dbC);
    expect(manager.stats().open).toBe(2);

    // Verify in manager cache
    expect(testable.clients.has(dbA)).toBe(false);
    expect(testable.clients.has(dbB)).toBe(true);
    expect(testable.clients.has(dbC)).toBe(true);

    // Verify in PostgreSQL pg_stat_activity: dbA has 0 active client connections
    const resA = await superuserPool.query(
      `SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND application_name != 'PostgreSQL JDBC Driver';`,
      [dbA],
    );
    expect(parseInt(resA.rows[0].count, 10)).toBe(0);

    await manager.shutdown();
  });

  it('8. Lease preservation: client with active lease is NEVER evicted; evict times out clearly', async () => {
    const manager = new TenantClientManager();
    const testable = manager as unknown as TestableClientManager;
    testable.maxClients = 1;

    // Acquire lease on dbA
    const { client: _leasedClient, release } = await manager.acquireLease(dbA);
    expect(manager.stats().activeLeases).toBe(1);

    // Evict must fail with clear timeout error while lease is held
    await expect(manager.evict(dbA, { timeoutMs: 300 })).rejects.toThrow(
      /Cannot evict database "erp_test_cm_a": 1 active lease\(s\) still open after 300ms/,
    );

    // Requesting dbB while dbA is leased: dbA is marked for pending eviction but NOT evicted yet
    await manager.getClient(dbB);
    expect(testable.clients.has(dbA)).toBe(true);

    // Release lease
    await release();
    expect(manager.stats().activeLeases).toBe(0);

    // Now dbA deferred eviction proceeds
    await new Promise((r) => setTimeout(r, 100));
    expect(testable.clients.has(dbA)).toBe(false);

    // After eviction, requesting dbA again re-instantiates cleanly
    const newClient = await manager.getClient(dbA);
    expect(newClient).toBeDefined();

    await manager.shutdown();
  });

  it('9. Connection leak defense: after shutting down manager, pg_stat_activity shows zero connections for test tenants', async () => {
    const manager = new TenantClientManager();
    await manager.getClient(dbA);
    await manager.getClient(dbB);
    await manager.getClient(dbC);

    expect(manager.stats().open).toBe(3);

    // Shut down all connections cleanly
    await manager.shutdown();

    // Query PostgreSQL to verify zero open connections remain
    const res = await superuserPool.query(`
      SELECT datname, count(*) as count
      FROM pg_stat_activity
      WHERE datname IN ('${dbA}', '${dbB}', '${dbC}')
      GROUP BY datname;
    `);

    expect(res.rows).toEqual([]);
  });
});
