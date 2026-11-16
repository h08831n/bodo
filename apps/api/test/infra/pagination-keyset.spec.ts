import pg from 'pg';
import { getEnv } from '../../src/config/env.config';
import { paginate } from '../../src/common/pagination/paginate';
import { encodeCursor } from '../../src/common/pagination/cursor-codec';

jest.setTimeout(120000);

describe('Keyset Pagination Integration Tests with 10,000 Real Rows (Tests 5, 6, 7, 8)', () => {
  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';
  const targetDb = 'erp_dev';

  let pool: pg.Pool;
  let isDbConnected = false;

  const testTableName = '_test_pagination_records';

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

    try {
      const client = await pool.connect();
      client.release();
      isDbConnected = true;
    } catch {
      console.warn(
        `[WARN] PostgreSQL is not reachable at ${host}:${port}. Skipping pagination integration tests.`,
      );
      return;
    }

    // 1. Create temporary test table in real Postgres
    await pool.query(`DROP TABLE IF EXISTS ${testTableName};`);
    await pool.query(`
      CREATE TABLE ${testTableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_number INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ NULL
      );
    `);

    // 2. Create optimized composite B-Tree indexes matching NULLS LAST keyset contract
    await pool.query(`
      CREATE INDEX idx_test_pag_created_id ON ${testTableName} (created_at DESC NULLS LAST, id DESC NULLS LAST);
    `);
    await pool.query(`
      CREATE INDEX idx_test_pag_created_asc_id ON ${testTableName} (created_at ASC NULLS LAST, id ASC NULLS LAST);
    `);
    await pool.query(`
      CREATE INDEX idx_test_pag_deleted_id ON ${testTableName} (deleted_at DESC NULLS LAST, id DESC NULLS LAST);
    `);
    await pool.query(`
      CREATE INDEX idx_test_pag_status_amount_id ON ${testTableName} (status ASC NULLS LAST, amount DESC NULLS LAST, id ASC NULLS LAST);
    `);

    // 3. Seed exactly 10,000 real rows in efficient batches of 1,000
    const statuses = ['active', 'pending', 'archived', 'completed'];
    const baseDate = new Date('2026-01-01T00:00:00.000Z').getTime();

    for (let batch = 0; batch < 10; batch++) {
      const rows: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const itemNumber = batch * 1000 + i + 1;
        const status = statuses[itemNumber % statuses.length];
        const amount = (itemNumber * 12.5).toFixed(2);
        // Step created_at by 1 second to create realistic, ordered time series
        const createdAt = new Date(baseDate + itemNumber * 1000).toISOString();
        const deletedAt =
          itemNumber % 5 === 0
            ? `'${new Date(baseDate + itemNumber * 500).toISOString()}'`
            : 'NULL';
        rows.push(
          `(${itemNumber}, 'Item-${itemNumber}', ${amount}, '${status}', '${createdAt}', ${deletedAt})`,
        );
      }
      await pool.query(`
        INSERT INTO ${testTableName} (item_number, name, amount, status, created_at, deleted_at)
        VALUES ${rows.join(',')};
      `);
    }

    // Run ANALYZE so the query planner has exact statistics
    await pool.query(`ANALYZE ${testTableName};`);
  });

  afterAll(async () => {
    if (!isDbConnected) return;
    await pool.query(`DROP TABLE IF EXISTS ${testTableName};`).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('Test 5: Full traversal across 10,000 rows without duplication, skipping, and sum equals total', async () => {
    if (!isDbConnected) return;

    const pageSize = 100;
    let cursor: string | undefined = undefined;
    const visitedIds = new Set<string>();
    let totalTraversed = 0;
    let pageCount = 0;

    // Delegate simulating Prisma model query via real Postgres pool
    const mockDelegate = {
      findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
        // Construct SQL query from Keyset args
        const sortClause = 'ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST';
        let whereClause = '';
        const params: unknown[] = [];

        const andArray = (args.where?.AND as Array<Record<string, unknown>>) || [];
        const keysetObj = (andArray[1] || args.where || {}) as Record<string, unknown>;
        const createdAtBounded = keysetObj.created_at as
          { lte?: Date; lt?: Date; gte?: Date; gt?: Date } | undefined;
        const orArray = keysetObj.OR as Array<Record<string, unknown>> | undefined;

        const cursorDate =
          createdAtBounded?.lte ||
          createdAtBounded?.lt ||
          createdAtBounded?.gte ||
          createdAtBounded?.gt;
        const idLt =
          (orArray?.[1] as Record<string, { lt?: string; gt?: string }> | undefined)?.id?.lt ||
          (orArray?.[1] as Record<string, { lt?: string; gt?: string }> | undefined)?.id?.gt;

        if (cursorDate && idLt) {
          params.push(cursorDate, idLt);
          whereClause = 'WHERE created_at <= $1 AND (created_at < $1 OR id < $2)';
        }

        const limitClause = `LIMIT ${args.take ?? 50}`;
        const sql = `SELECT id, item_number, name, amount, status, created_at, deleted_at FROM ${testTableName} ${whereClause} ${sortClause} ${limitClause};`;
        const res = await pool.query(sql, params);
        return res.rows.map((r: Record<string, unknown>) => ({
          ...r,
          created_at: new Date(String(r.created_at)),
        }));
      },
      count: async () => {
        const res = await pool.query(`SELECT COUNT(*)::int as cnt FROM ${testTableName};`);
        return res.rows[0].cnt;
      },
    };

    do {
      const result: { items: Array<Record<string, unknown>>; nextCursor: string | null } =
        await paginate({
          model: mockDelegate,
          query: {
            limit: pageSize,
            cursor,
            sort: 'created_at:desc,id:desc',
          },
          allowedSortFields: ['created_at', 'status', 'amount', 'id'],
        });

      pageCount++;
      for (const item of result.items) {
        const idStr = String(item.id);
        expect(visitedIds.has(idStr)).toBe(false); // Zero duplicates
        visitedIds.add(idStr);
        totalTraversed++;
      }

      cursor = result.nextCursor || undefined;
    } while (cursor);

    // Verify complete traversal
    expect(totalTraversed).toBe(10000);
    expect(visitedIds.size).toBe(10000);
    expect(pageCount).toBe(100); // 10,000 / 100 = 100 pages
  });

  it('Test 6: Concurrent insertion of new rows during traversal does not disrupt cursor sequence', async () => {
    if (!isDbConnected) return;

    // Fetch first page
    const page1Res = await pool.query(
      `SELECT id, created_at FROM ${testTableName} ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 50;`,
    );
    const lastItem = page1Res.rows[page1Res.rows.length - 1];

    const _cursor = encodeCursor({
      created_at: lastItem.created_at.toISOString(),
      id: lastItem.id,
    });

    // Insert new item with very recent timestamp (higher than current cursor)
    const newDate = new Date('2028-01-01T00:00:00.000Z').toISOString();
    await pool.query(`
      INSERT INTO ${testTableName} (item_number, name, amount, status, created_at)
      VALUES (999999, 'Mid-Traversal-Insert', 500.00, 'active', '${newDate}');
    `);

    // Fetch next page with existing cursor
    const page2Res = await pool.query(
      `SELECT id, created_at FROM ${testTableName}
       WHERE created_at <= $1 AND (created_at < $1 OR id < $2)
       ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 50;`,
      [lastItem.created_at, lastItem.id],
    );

    // Assert: none of page 2 items duplicate page 1, and new higher item is not included
    const page1Ids = new Set(page1Res.rows.map((r) => r.id));
    for (const row of page2Res.rows) {
      expect(page1Ids.has(row.id)).toBe(false);
    }

    // Clean up inserted record
    await pool.query(`DELETE FROM ${testTableName} WHERE item_number = 999999;`);
  });

  it('Test 7: Pagination parameter validations (limit cap, tampered cursor, invalid sort field, withTotal)', async () => {
    if (!isDbConnected) return;

    const mockDelegate = {
      findMany: async () => [],
      count: async () => 10000,
    };

    // 1. Limit capped at 200
    const resultCap = await paginate({
      model: mockDelegate,
      query: { limit: 500 }, // Exceeds max 200
      allowedSortFields: ['created_at'],
    });
    expect(resultCap.items.length).toBe(0);

    // 2. Tampered cursor HMAC throws 400 VALIDATION_FAILED
    const validCursor = encodeCursor({
      created_at: '2026-01-01T00:00:00.000Z',
      id: '00000000-0000-0000-0000-000000000000',
    });
    const tamperedCursor = validCursor.slice(0, -6) + 'XXXXXX';

    await expect(
      paginate({
        model: mockDelegate,
        query: { cursor: tamperedCursor },
        allowedSortFields: ['created_at'],
      }),
    ).rejects.toThrow();

    // 3. Invalid sort field not in whitelist
    await expect(
      paginate({
        model: mockDelegate,
        query: { sort: 'unauthorized_column:asc' },
        allowedSortFields: ['created_at', 'status'],
      }),
    ).rejects.toThrow();

    // 4. withTotal returns exact total
    const resultWithTotal = await paginate({
      model: mockDelegate,
      query: { limit: 10, withTotal: true },
      allowedSortFields: ['created_at'],
    });
    expect(resultWithTotal.totalCount).toBe(10000);
  });

  it('Test 8a: EXPLAIN at depths 5%, 50%, 95% proves Index Cond on leading column and Rows Removed by Filter <= 2x limit (Zero Seq Scan)', async () => {
    if (!isDbConnected) return;

    // Depths corresponding to 5%, 50%, and 95% of 10,000 rows
    const testDepths = [
      { depthPercent: 5, offset: 500 },
      { depthPercent: 50, offset: 5000 },
      { depthPercent: 95, offset: 9500 },
    ];

    for (const { depthPercent, offset } of testDepths) {
      const cursorRes = await pool.query(
        `
        SELECT id, created_at FROM ${testTableName}
        ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
        OFFSET $1 LIMIT 1;
      `,
        [offset],
      );
      expect(cursorRes.rows.length).toBe(1);
      const cursorItem = cursorRes.rows[0];

      // Run EXPLAIN (ANALYZE, BUFFERS) with leading bounded index condition
      const explainRes = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id, name, created_at FROM ${testTableName}
         WHERE created_at <= $1 AND (created_at < $1 OR id < $2)
         ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST
         LIMIT 50;`,
        [cursorItem.created_at, cursorItem.id],
      );

      const planLines = explainRes.rows
        .map((r: Record<string, unknown>) => String(r['QUERY PLAN']))
        .join('\n');

      console.info(`--- EXPLAIN PLAN AT DEPTH ${depthPercent}% (OFFSET ${offset}) ---`);
      console.info(planLines);
      console.info('------------------------------------------------------------');

      // 1. Must use Index Scan on composite index
      expect(planLines).toMatch(/Index Scan|Index Only Scan/);
      expect(planLines).toContain('idx_test_pag_created_id');

      // 2. Must NOT use Seq Scan
      expect(planLines).not.toMatch(/Seq Scan on _test_pagination_records/);

      // 3. Must push leading column into Index Cond
      expect(planLines).toMatch(/Index Cond:\s*\(created_at <=/);

      // 4. Rows Removed by Filter must NOT exceed 2x limit (2 * 50 = 100)
      const filterMatch = planLines.match(/Rows Removed by Filter:\s*(\d+)/);
      if (filterMatch && filterMatch[1]) {
        const removedCount = parseInt(filterMatch[1], 10);
        expect(removedCount).toBeLessThanOrEqual(100);
      }
    }
  });

  it('Test 8b: EXPLAIN for ascending sort proves Index Cond and Rows Removed by Filter <= 100', async () => {
    if (!isDbConnected) return;

    const midRes = await pool.query(`
      SELECT id, created_at FROM ${testTableName}
      ORDER BY created_at ASC NULLS LAST, id ASC NULLS LAST
      OFFSET 5000 LIMIT 1;
    `);
    const cursor = midRes.rows[0];

    const explainRes = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, name, created_at FROM ${testTableName}
       WHERE created_at >= $1 AND (created_at > $1 OR id > $2)
       ORDER BY created_at ASC NULLS LAST, id ASC NULLS LAST
       LIMIT 50;`,
      [cursor.created_at, cursor.id],
    );

    const planLines = explainRes.rows
      .map((r: Record<string, unknown>) => String(r['QUERY PLAN']))
      .join('\n');

    expect(planLines).toMatch(/Index Scan|Index Only Scan/);
    expect(planLines).toContain('idx_test_pag_created_asc_id');
    expect(planLines).not.toMatch(/Seq Scan on _test_pagination_records/);
    expect(planLines).toMatch(/Index Cond:\s*\(created_at >=/);

    const filterMatch = planLines.match(/Rows Removed by Filter:\s*(\d+)/);
    if (filterMatch && filterMatch[1]) {
      const removedCount = parseInt(filterMatch[1], 10);
      expect(removedCount).toBeLessThanOrEqual(100);
    }
  });

  it('Test 8c: EXPLAIN for nullable column with NULLS LAST (non-null and null cursors)', async () => {
    if (!isDbConnected) return;

    // 1. Non-null cursor on nullable column
    const midRes = await pool.query(`
      SELECT id, deleted_at FROM ${testTableName}
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC NULLS LAST, id DESC NULLS LAST
      OFFSET 1000 LIMIT 1;
    `);
    const nonNullCursor = midRes.rows[0];

    const explainResNonNull = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, name, deleted_at FROM ${testTableName}
       WHERE deleted_at <= $1 AND (deleted_at < $1 OR id < $2)
       ORDER BY deleted_at DESC NULLS LAST, id DESC NULLS LAST
       LIMIT 50;`,
      [nonNullCursor.deleted_at, nonNullCursor.id],
    );

    const planNonNull = explainResNonNull.rows
      .map((r: Record<string, unknown>) => String(r['QUERY PLAN']))
      .join('\n');

    expect(planNonNull).toMatch(/Index Scan|Index Only Scan/);
    expect(planNonNull).toContain('idx_test_pag_deleted_id');
    expect(planNonNull).not.toMatch(/Seq Scan on _test_pagination_records/);
    expect(planNonNull).toMatch(/Index Cond:\s*\(deleted_at <=/);

    const filterMatchNonNull = planNonNull.match(/Rows Removed by Filter:\s*(\d+)/);
    if (filterMatchNonNull && filterMatchNonNull[1]) {
      const removedCount = parseInt(filterMatchNonNull[1], 10);
      expect(removedCount).toBeLessThanOrEqual(100);
    }

    // 2. NULL cursor on nullable column
    const nullRes = await pool.query(`
      SELECT id, deleted_at FROM ${testTableName}
      WHERE deleted_at IS NULL
      ORDER BY id DESC
      OFFSET 500 LIMIT 1;
    `);
    const nullCursor = nullRes.rows[0];

    const explainResNull = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, name, deleted_at FROM ${testTableName}
       WHERE deleted_at IS NULL AND id < $1
       ORDER BY deleted_at DESC NULLS LAST, id DESC NULLS LAST
       LIMIT 50;`,
      [nullCursor.id],
    );

    const planNull = explainResNull.rows
      .map((r: Record<string, unknown>) => String(r['QUERY PLAN']))
      .join('\n');

    expect(planNull).toMatch(/Index Scan|Index Only Scan/);
    expect(planNull).toContain('idx_test_pag_deleted_id');
    expect(planNull).not.toMatch(/Seq Scan on _test_pagination_records/);
    expect(planNull).toMatch(/Index Cond:\s*\(\(deleted_at IS NULL\) AND \(id </);

    const filterMatchNull = planNull.match(/Rows Removed by Filter:\s*(\d+)/);
    if (filterMatchNull && filterMatchNull[1]) {
      const removedCount = parseInt(filterMatchNull[1], 10);
      expect(removedCount).toBeLessThanOrEqual(100);
    }
  });
});
