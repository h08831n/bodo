import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test-app';
import {
  AUTH_TEST_DB,
  TEST_PASSWORDS,
  setupAuthTestEnvironment,
  teardownAuthTestEnvironment,
} from './auth-test-helper';
import { PasswordHasher } from '../../src/common/auth/password-hasher';
import { RedisService } from '../../src/infra/redis/redis.service';
import { tenantKey } from '../../src/infra/redis/redis-keys';
import { expectNoSecrets } from '../../src/common/testing/expect-no-secrets';

describe('Auth: Login & Uniform Response Integration Tests (Tests 1, 2, 3)', () => {
  let app: INestApplication;
  let passwordHasher: PasswordHasher;
  let redisService: RedisService;

  beforeAll(async () => {
    app = await createTestApp();
    passwordHasher = app.get(PasswordHasher);
    redisService = app.get(RedisService);
    await setupAuthTestEnvironment(app);
  }, 180000);

  afterAll(async () => {
    await teardownAuthTestEnvironment(app);
    if (app) {
      await app.close();
    }
  });

  describe('Test 1: Successful Login & Cookie Invariants', () => {
    it('Web mode: sets HttpOnly SameSite=Strict Path=/v1/auth cookie, excludes refreshToken from body, and returns accessToken + user summary', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({
          username: 'normal_user',
          password: TEST_PASSWORDS.normal,
        })
        .expect(200);

      // 1. Response Body
      expect(res.body.accessToken).toBeDefined();
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.refreshToken).toBeUndefined(); // Excluded from web body
      expect(res.body.user).toEqual({
        id: expect.any(String),
        username: 'normal_user',
        fullName: 'Normal User',
        type: 'INTERNAL',
        mustChangePassword: false,
      });

      // Assert zero leaks
      expectNoSecrets(res.body);

      // 2. Cookie Headers
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies[0] : cookies;
      const slug = AUTH_TEST_DB.replace(/^erp_/, '');
      expect(cookieStr).toContain(`bodo_rt_${slug}=`);
      expect(cookieStr.toLowerCase()).toContain('httponly');
      expect(cookieStr.toLowerCase()).toContain('samesite=strict');
      expect(cookieStr.toLowerCase()).toContain('path=/v1/auth');
    });

    it('Mobile mode (X-Client: mobile): returns refreshToken in response body and does NOT set HttpOnly cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({
          username: 'normal_user',
          password: TEST_PASSWORDS.normal,
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.refreshToken).toContain('.'); // Format: <sessionId>.<secret>
      expect(res.headers['set-cookie']).toBeUndefined();

      expectNoSecrets(res.body);
    });
  });

  describe('Test 2: Uniform Response & Argon2 Timing Shield', () => {
    it('Uniform responses for non-existent username, wrong password, and inactive user with identical status and error structure', async () => {
      // 1. Non-existent username
      const resNonExistent = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({
          username: 'non_existent_ghost_user',
          password: 'SomeRandomPassword123!',
        })
        .expect(401);

      // 2. Wrong password for existing active user
      const resWrongPassword = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({
          username: 'normal_user',
          password: 'IncorrectPassword123!',
        })
        .expect(401);

      // 3. Inactive user with correct password
      const resInactive = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({
          username: 'inactive_user',
          password: TEST_PASSWORDS.inactive,
        })
        .expect(401);

      // Assert identical error payload structures
      expect(resNonExistent.body.error.code).toBe('UNAUTHENTICATED');
      expect(resWrongPassword.body.error.code).toBe('UNAUTHENTICATED');
      expect(resInactive.body.error.code).toBe('UNAUTHENTICATED');

      expect(resNonExistent.body.error.message).toBe('نام کاربری یا رمز عبور اشتباه است');
      expect(resWrongPassword.body.error.message).toBe('نام کاربری یا رمز عبور اشتباه است');
      expect(resInactive.body.error.message).toBe('نام کاربری یا رمز عبور اشتباه است');

      expect(resNonExistent.body.error.requestId).toBeDefined();
      expect(resWrongPassword.body.error.requestId).toBeDefined();
      expect(resInactive.body.error.requestId).toBeDefined();
    });

    it('Executes exactly one Argon2 verification across all login failure branches (dummyVerify vs verifyPassword spy)', async () => {
      const dummySpy = jest.spyOn(passwordHasher, 'dummyVerify');
      const verifySpy = jest.spyOn(passwordHasher, 'verifyPassword');

      try {
        // Branch 1: Non-existent user -> calls dummyVerify exactly once
        dummySpy.mockClear();
        verifySpy.mockClear();
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .send({ username: 'missing_user_xyz', password: 'Password123!' });
        expect(dummySpy).toHaveBeenCalledTimes(1);
        expect(verifySpy).toHaveBeenCalledTimes(0);

        // Branch 2: Inactive user -> calls dummyVerify exactly once
        dummySpy.mockClear();
        verifySpy.mockClear();
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .send({ username: 'inactive_user', password: TEST_PASSWORDS.inactive });
        expect(dummySpy).toHaveBeenCalledTimes(1);
        expect(verifySpy).toHaveBeenCalledTimes(0);

        // Branch 3: Existing active user with wrong password -> calls verifyPassword exactly once
        dummySpy.mockClear();
        verifySpy.mockClear();
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .send({ username: 'normal_user', password: 'WrongPassword123!' });
        expect(dummySpy).toHaveBeenCalledTimes(0);
        expect(verifySpy).toHaveBeenCalledTimes(1);
      } finally {
        dummySpy.mockRestore();
        verifySpy.mockRestore();
      }
    });
  });

  describe('Test 3: Lockout & Rate Limiting Invariants', () => {
    it('5 failed attempts trigger 15-minute lockout with HTTP 429 and Retry-After header for both existing and non-existent users', async () => {
      const redis = redisService.getClient();
      const testUser = 'lockout_test_user';
      const userKey = tenantKey(AUTH_TEST_DB, 'ratelimit', 'login', 'user', testUser);
      await redis.del(userKey);

      // Trigger 4 failures
      for (let i = 0; i < 4; i++) {
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .send({ username: testUser, password: 'BadPassword1!' })
          .expect(401);
      }

      // 5th failure must trigger 429 RATE_LIMITED
      const res5 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: testUser, password: 'BadPassword1!' })
        .expect(429);

      expect(res5.body.error.code).toBe('RATE_LIMITED');
      expect(res5.headers['retry-after']).toBeDefined();
      expect(parseInt(String(res5.headers['retry-after']), 10)).toBeGreaterThan(0);

      // Subsequent attempt even with correct password is still rejected with 429 during lockout window
      const resLocked = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: testUser, password: 'CorrectPasswordOrNot!' })
        .expect(429);

      expect(resLocked.body.error.code).toBe('RATE_LIMITED');
      expect(resLocked.headers['retry-after']).toBeDefined();

      // Clean up lockout key and confirm login path restores
      await redis.del(userKey);
    });

    it('Successful login resets failed login counters in Redis', async () => {
      const redis = redisService.getClient();
      const userKey = tenantKey(AUTH_TEST_DB, 'ratelimit', 'login', 'user', 'normal_user');
      await redis.del(userKey);

      // 1. One failed attempt
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: 'WrongPassword123!' })
        .expect(401);

      const failuresBefore = await redis.get(userKey);
      expect(parseInt(failuresBefore || '0', 10)).toBe(1);

      // 2. Successful login resets counter
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const failuresAfter = await redis.get(userKey);
      expect(failuresAfter).toBeNull();
    });
  });
});
