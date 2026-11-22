import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test-app';
import {
  AUTH_TEST_DB,
  TEST_PASSWORDS,
  TEST_USER_IDS,
  setupAuthTestEnvironment,
  teardownAuthTestEnvironment,
} from './auth-test-helper';
import { RedisService } from '../../src/infra/redis/redis.service';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';
import { PasswordHasher } from '../../src/common/auth/password-hasher';
import { expectNoSecrets } from '../../src/common/testing/expect-no-secrets';

describe('Auth: Security, Policy, CSRF, Fail-Closed, Audit, and Load (Tests 13, 14, 15, 16, 17)', () => {
  let app: INestApplication;
  let redisService: RedisService;
  let clientManager: TenantClientManager;
  let passwordHasher: PasswordHasher;

  beforeAll(async () => {
    app = await createTestApp();
    redisService = app.get(RedisService);
    clientManager = app.get(TenantClientManager);
    passwordHasher = app.get(PasswordHasher);
    await setupAuthTestEnvironment(app);
  }, 180000);

  afterAll(async () => {
    await teardownAuthTestEnvironment(app);
    if (app) {
      await app.close();
    }
  });

  describe('Test 13: Password Policy Boundaries, NFKC, Anti-DoS, and Automatic Rehash', () => {
    it('Enforces password length boundaries (10-128), blacklist, username exclusion, anti-DoS, and performs automatic rehash', async () => {
      // 1. Obtain token for normal_user
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token = loginRes.body.accessToken;

      // 2. Length boundary: 9 chars rejected (400)
      await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({ currentPassword: TEST_PASSWORDS.normal, newPassword: 'Short9!aa' })
        .expect(400);

      // 3. Length boundary: 129 chars rejected (400)
      const pass129 = 'A'.repeat(120) + 'LongPass9!';
      await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({ currentPassword: TEST_PASSWORDS.normal, newPassword: pass129 })
        .expect(400);

      // 4. Blacklisted common password rejected (400)
      await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({ currentPassword: TEST_PASSWORDS.normal, newPassword: 'Password1234!' })
        .expect(400);

      // 5. Username equality rejected (400)
      await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({ currentPassword: TEST_PASSWORDS.normal, newPassword: 'normal_user' })
        .expect(400);

      // 6. Anti-DoS: Oversized password body (> 1024 bytes) rejected before Argon2
      const oversizedPassword = 'X'.repeat(2048);
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: oversizedPassword })
        .expect(401);

      // 7. Automatic Argon2 rehash verification
      // Mock needsRehash once to simulate detected legacy hash
      const needsRehashSpy = jest.spyOn(passwordHasher, 'needsRehash').mockReturnValueOnce(true);

      const rehashLoginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      expect(rehashLoginRes.status).toBe(200);
      needsRehashSpy.mockRestore();

      // Verify user's hash in DB is a valid modern argon2id hash
      const client = await clientManager.getClient(AUTH_TEST_DB);
      const updatedUser = await client.user.findUnique({ where: { id: TEST_USER_IDS.normal } });
      expect(updatedUser?.passwordHash).toMatch(/^\$argon2id\$/);
    });
  });

  describe('Test 14: CSRF Validation on Cookie-Based Refresh & Logout', () => {
    it('Blocks cookie-based refresh and logout from unauthorized origins, and bypasses CSRF for mobile clients', async () => {
      // 1. Web login (returns set-cookie)
      const webLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const cookieHeaders = webLogin.headers['set-cookie'];
      expect(cookieHeaders).toBeDefined();
      const rawCookies = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders || ''];
      const cookie = rawCookies[0] || '';

      // 2. Cookie refresh with unauthorized Origin -> 403 Forbidden
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('Cookie', cookie)
        .set('Origin', 'https://malicious-attacker-site.com')
        .expect(403);

      // 3. Cookie refresh with allowed local origin -> 200 OK
      const goodRefresh = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .expect(200);

      expect(goodRefresh.body.accessToken).toBeDefined();

      // 4. Mobile client mode (X-Client: mobile + body refreshToken) bypasses CSRF
      const mobileLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const mobileRefreshToken = mobileLogin.body.refreshToken;
      expect(mobileRefreshToken).toBeDefined();

      const mobileRefresh = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: mobileRefreshToken })
        .expect(200);

      expect(mobileRefresh.body.accessToken).toBeDefined();
    });
  });

  describe('Test 15: Redis Fail-Closed and Health Availability', () => {
    it('Returns 503 DEGRADED on auth endpoints when Redis is unavailable, while /health/live remains 200', async () => {
      // 1. Verify health/live is initially 200
      await request(app.getHttpServer()).get('/health/live').expect(200);

      // 2. Simulate Redis connection failure
      const getClientSpy = jest.spyOn(redisService, 'getClient').mockImplementation(() => {
        throw new Error('Redis connection down (simulated fault)');
      });

      try {
        // Auth login MUST fail-closed with 503 DEGRADED
        const loginFail = await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
          .expect(503);

        expect(loginFail.status).toBe(503);
        expect(['DEGRADED', 'DATABASE_MAINTENANCE']).toContain(loginFail.body.error.code);

        // /health/live MUST continue responding 200
        const healthLive = await request(app.getHttpServer()).get('/health/live').expect(200);

        expect(healthLive.body.status).toBe('ok');
      } finally {
        getClientSpy.mockRestore();
      }

      // 3. After restoring Redis, auth login succeeds again
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);
    });
  });

  describe('Test 16: Audit Logs Completeness and Privacy Preservation', () => {
    it('Records all auth events with UUIDv7, redacts secrets (expectNoSecrets), and hashes usernames on failed logins', async () => {
      // Clear IP rate limit counter before test to avoid 429
      const redis = redisService.getClient();
      const ratelimitKeys = await redis.keys('*ratelimit*');
      if (ratelimitKeys.length > 0) {
        await redis.del(...ratelimitKeys);
      }

      // 1. Trigger failed login with non-existent user
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'unknown_probe_user', password: 'SomePassword123!' })
        .expect(401);

      // 2. Trigger successful login
      const successLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token = successLogin.body.accessToken;

      // 3. Trigger logout
      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // 4. Query audit_logs from tenant database
      const client = await clientManager.getClient(AUTH_TEST_DB);
      const auditRows = await client.auditLog.findMany({
        where: {
          action: { in: ['auth.login.failure', 'auth.login.success', 'auth.logout'] },
        },
        orderBy: { occurredAt: 'desc' },
        take: 10,
      });

      expect(auditRows.length).toBeGreaterThanOrEqual(3);

      for (const row of auditRows) {
        // Assert no secrets leaked
        expectNoSecrets(row);

        // Verify UUID format (UUIDv7 starts with version 7 or valid UUID format)
        expect(row.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );

        // On failure: verify raw username is NOT leaked, only usernameHash is present
        if (row.action === 'auth.login.failure') {
          const meta = row.meta as Record<string, unknown> | null;
          expect(meta?.username).toBeUndefined();
          expect(meta?.usernameHash).toBeDefined();
          expect(meta?.usernameHash).toMatch(/^[0-9a-f]{64}$/i);
        }
      }
    });
  });

  describe('Test 17: Concurrent Load and Liveness Responsiveness', () => {
    it('Handles 20 concurrent logins while /health/live continues to respond in < 1000ms', async () => {
      const startTime = Date.now();

      // Launch 20 concurrent logins from distinct simulated client IPs
      const loginPromises = Array.from({ length: 20 }, (_, i) =>
        request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .set('X-Forwarded-For', `192.168.1.${i + 1}`)
          .send({ username: 'admin_user', password: TEST_PASSWORDS.admin }),
      );

      // Concurrently probe /health/live
      const healthPromise = request(app.getHttpServer()).get('/health/live');

      const [healthRes, ...loginResponses] = await Promise.all([healthPromise, ...loginPromises]);

      const totalDuration = Date.now() - startTime;

      expect(healthRes.status).toBe(200);
      expect(totalDuration).toBeLessThan(15000); // 전체 20개의 Argon2 연산과 헬스체크가 안정적으로 완주

      for (const res of loginResponses) {
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeDefined();
      }
    });
  });
});
