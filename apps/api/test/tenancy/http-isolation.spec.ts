import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { buildDatabaseUrl } from '@bodo/utils';
import { AppModule } from '../../src/app.module';
import { getEnv } from '../../src/config/env.config';
import { MaintenanceService } from '../../src/infra/tenancy/maintenance.service';
import { seedBaseline } from '../../src/database/seed/baseline';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { LoggerService } from '../../src/common/logger/logger.service';
import { RedisService } from '../../src/infra/redis/redis.service';

jest.setTimeout(90000);

describe('HTTP Multi-Tenant End-to-End Isolation (Tests 2, 3, 4, 5, 17)', () => {
  let app: INestApplication;
  let superuserPool: pg.Pool;
  let maintenanceService: MaintenanceService;
  let redisService: RedisService;

  const env = getEnv();
  const host = env.POSTGRES_HOST;
  const port = env.POSTGRES_PORT;
  const superuserPass = process.env.POSTGRES_PASSWORD || 'postgres';

  const dbA = 'erp_http_tenant_a';
  const dbB = 'erp_http_tenant_b';

  beforeAll(async () => {
    superuserPool = new pg.Pool({
      host,
      port,
      user: 'postgres',
      password: superuserPass,
      database: 'postgres',
    });

    // 1. Prepare two clean tenant databases with schema and distinct company names
    const migrationSqlPath = path.resolve(
      __dirname,
      '../../prisma/migrations/0001_init/migration.sql',
    );
    const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

    for (const [db, companyName] of [
      [dbA, 'شرکت فولاد البرز (A)'],
      [dbB, 'بازرگانی آهن کویر (B)'],
    ] as const) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`);
      await superuserPool.query(`CREATE DATABASE ${db} OWNER erp_migrator;`);

      // Run migration as erp_migrator
      const migClient = new pg.Client({
        host,
        port,
        user: 'erp_migrator',
        password: env.ERP_MIGRATOR_PASSWORD,
        database: db,
      });
      await migClient.connect();
      await migClient.query(migrationSql);
      await migClient.end();

      // Seed baseline data
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
      await seedClient.companyProfile.update({
        where: { id: 1 },
        data: { name: companyName },
      });
      await seedClient.$disconnect();
    }

    // 2. Bootstrap Nest application
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const logger = app.get(LoggerService);
    app.useGlobalFilters(new GlobalExceptionFilter(logger));
    await app.init();

    maintenanceService = app.get(MaintenanceService);
    redisService = app.get(RedisService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    for (const db of [dbA, dbB]) {
      await superuserPool.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`).catch(() => {});
    }
    await superuserPool.end().catch(() => {});
  });

  it('2. HTTP End-to-End: requests with X-Database A vs B return isolated database data with zero leakage', async () => {
    // Request for Tenant A
    const resA = await request(app.getHttpServer())
      .get('/v1/dev/tenant-info')
      .set('X-Database', dbA)
      .expect(200);

    expect(resA.body).toEqual({
      database: dbA,
      companyName: 'شرکت فولاد البرز (A)',
    });

    // Request for Tenant B
    const resB = await request(app.getHttpServer())
      .get('/v1/dev/tenant-info')
      .set('X-Database', dbB)
      .expect(200);

    expect(resB.body).toEqual({
      database: dbB,
      companyName: 'بازرگانی آهن کویر (B)',
    });

    // Subsequent interleaved requests confirm absolute tenant isolation
    const [repeatA, repeatB] = await Promise.all([
      request(app.getHttpServer()).get('/v1/dev/tenant-info').set('X-Database', dbA),
      request(app.getHttpServer()).get('/v1/dev/tenant-info').set('X-Database', dbB),
    ]);

    expect(repeatA.body.database).toBe(dbA);
    expect(repeatA.body.companyName).toBe('شرکت فولاد البرز (A)');
    expect(repeatB.body.database).toBe(dbB);
    expect(repeatB.body.companyName).toBe('بازرگانی آهن کویر (B)');
  });

  it('3. Error contracts: missing database gives 400 DATABASE_REQUIRED; nonexistent or toxic database names give identical 404', async () => {
    // Missing database -> 400
    const resMissing = await request(app.getHttpServer()).get('/v1/dev/tenant-info').expect(400);

    expect(resMissing.body.error.code).toBe('DATABASE_REQUIRED');

    // Nonexistent, invalid, reserved, and toxic database names -> all 404 with identical error contract
    const invalidInputs = [
      'erp_nonexistent_database',
      'postgres',
      'template1',
      'erp_tmp_provisioning',
      'erp_acme; drop table users;',
      'ERP_UPPERCASE',
      'erp_ab',
      `erp_${'a'.repeat(45)}`,
    ];

    for (const invalidDb of invalidInputs) {
      const res = await request(app.getHttpServer())
        .get('/v1/dev/tenant-info')
        .set('X-Database', invalidDb)
        .expect(404);

      expect(res.body.error.code).toBe('DATABASE_NOT_FOUND');
      expect(res.body.error.message).toBe('دیتابیس شرکت یافت نشد یا معتبر نیست');
    }
  });

  it('4. Single-tenant maintenance: putting A in maintenance yields 503 + Retry-After for A while B remains 100% operational', async () => {
    // Enable maintenance on Tenant A
    await maintenanceService.set(dbA, { reason: 'به‌روزرسانی پایگاه داده' });

    // Request to A -> 503 with Retry-After header
    const resA = await request(app.getHttpServer())
      .get('/v1/dev/tenant-info')
      .set('X-Database', dbA)
      .expect(503);

    expect(resA.headers['retry-after']).toBe('60');
    expect(resA.body.error.code).toBe('DATABASE_MAINTENANCE');

    // Tenant B is completely unaffected -> 200 OK
    const resB = await request(app.getHttpServer())
      .get('/v1/dev/tenant-info')
      .set('X-Database', dbB)
      .expect(200);

    expect(resB.body.database).toBe(dbB);

    // Clear maintenance on A
    await maintenanceService.clear(dbA);

    // Tenant A is healthy and operational again -> 200 OK
    const resARecovered = await request(app.getHttpServer())
      .get('/v1/dev/tenant-info')
      .set('X-Database', dbA)
      .expect(200);

    expect(resARecovered.body.database).toBe(dbA);
  });

  it('5. Fail-Closed behavior: if Redis is unavailable, tenant routes fail-closed (503) while /health endpoints remain responsive', async () => {
    // Simulate Redis failure by temporarily mocking getClient() to throw and ping to return false
    jest.spyOn(redisService, 'getClient').mockImplementation(() => {
      throw new Error('ECONNREFUSED: Redis simulated network partition');
    });
    jest.spyOn(redisService, 'ping').mockResolvedValue(false);

    try {
      // 1. Tenant request MUST fail closed with 503 DATABASE_MAINTENANCE
      const tenantRes = await request(app.getHttpServer())
        .get('/v1/dev/tenant-info')
        .set('X-Database', dbB)
        .expect(503);

      expect(tenantRes.body.error.code).toBe('DATABASE_MAINTENANCE');

      // 2. /health/live remains 200 OK
      const liveRes = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(liveRes.body.status).toBe('ok');

      // 3. /health/ready reflects dependency failure with 503
      const readyRes = await request(app.getHttpServer()).get('/health/ready').expect(503);

      expect(readyRes.body.status).toBe('error');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('17. Real Health checks: live and ready probes verify Postgres, Redis and tenant client stats', async () => {
    // Live probe
    const live = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(live.body.status).toBe('ok');
    expect(typeof live.body.uptime).toBe('number');

    // Ready probe
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(ready.body.status).toBe('ok');
    expect(ready.body.checks).toEqual({
      postgres: 'up',
      redis: 'up',
    });
    expect(ready.body.tenantClients).toBeDefined();
    expect(ready.body.tenantClients.maxClients).toBe(env.TENANT_MAX_CLIENTS);
    expect(ready.body.tenantClients.open).toBeGreaterThanOrEqual(1);
    expect(ready.body.tenantClients.activeLeases).toBe(0); // All HTTP leases released cleanly
  });

  it('Production guard on /v1/dev/tenant-info: strictly 404 NOT_FOUND for existing and nonexistent X-Database', async () => {
    const origEnv = env.NODE_ENV;
    try {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      // 1. Existing database
      const resExisting = await request(app.getHttpServer())
        .get('/v1/dev/tenant-info')
        .set('X-Database', dbA)
        .expect(404);
      expect(resExisting.body.error.code).toBe('NOT_FOUND');

      // 2. Non-existent database
      const resNonExistent = await request(app.getHttpServer())
        .get('/v1/dev/tenant-info')
        .set('X-Database', 'erp_non_existent')
        .expect(404);
      expect(resNonExistent.body.error.code).toBe('NOT_FOUND');

      // 3. Omitted database
      const resOmitted = await request(app.getHttpServer()).get('/v1/dev/tenant-info').expect(404);
      expect(resOmitted.body.error.code).toBe('NOT_FOUND');
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = origEnv;
    }
  });
});
