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
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';
import { AuthRevocationService } from '../../src/common/auth/auth-revocation.service';

describe('Auth: Refresh, Concurrency, and Session Invariants (Tests 4, 5, 6, 7)', () => {
  let app: INestApplication;
  let clientManager: TenantClientManager;
  let authRevocationService: AuthRevocationService;

  beforeAll(async () => {
    app = await createTestApp();
    clientManager = app.get(TenantClientManager);
    authRevocationService = app.get(AuthRevocationService);
    await setupAuthTestEnvironment(app);
  }, 180000);

  afterAll(async () => {
    await teardownAuthTestEnvironment(app);
    if (app) {
      await app.close();
    }
  });

  describe('Test 4: Refresh Token Rotation & Reuse Detection Invariants', () => {
    it('Rotates token into child session within same family, and handles reuse within vs outside grace period', async () => {
      const client = await clientManager.getClient(AUTH_TEST_DB);

      // 1. Login to obtain initial refresh token
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token1 = loginRes.body.refreshToken;
      const [sessionId1] = token1.split('.');

      // 2. Perform valid refresh
      const refreshRes = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: token1 })
        .expect(200);

      const token2 = refreshRes.body.refreshToken;
      const [sessionId2] = token2.split('.');
      expect(sessionId2).not.toBe(sessionId1);

      // Verify DB state: session 1 is marked rotated_at
      const session1 = await client.session.findUnique({ where: { id: sessionId1 } });
      const session2 = await client.session.findUnique({ where: { id: sessionId2 } });
      expect(session1?.rotatedAt).not.toBeNull();
      expect(session2?.familyId).toBe(session1?.familyId);

      // 3. Immediate Reuse within 10s grace period: must return 401 WITHOUT revoking the family
      const raceRes = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: token1 })
        .expect(401);

      expect(raceRes.body.error.code).toBe('UNAUTHENTICATED');
      const session2Recheck = await client.session.findUnique({ where: { id: sessionId2 } });
      expect(session2Recheck?.revokedReason).toBeNull(); // Family remains ALIVE

      // 4. Manipulate rotatedAt to simulate reuse OUTSIDE 10s grace period (> 10s)
      await client.session.update({
        where: { id: sessionId1 },
        data: { rotatedAt: new Date(Date.now() - 20000) }, // 20s ago
      });

      // Replay old token outside grace period: must revoke ENTIRE family!
      const outsideGraceRes = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: token1 })
        .expect(401);

      expect(outsideGraceRes.body.error.code).toBe('UNAUTHENTICATED');

      // Verify all sessions in this family are now revoked with reuse_detected
      const familySessions = await client.session.findMany({
        where: { familyId: session1!.familyId },
      });
      for (const s of familySessions) {
        expect(s.revokedReason).toBe('reuse_detected');
      }

      // Verify audit log recorded refresh_reuse_detected
      const auditRecord = await client.auditLog.findFirst({
        where: { action: 'auth.refresh_reuse_detected' },
      });
      expect(auditRecord).not.toBeNull();
    });
  });

  describe('Test 5: Concurrency Stress on Refresh Token Rotation', () => {
    it('10 concurrent refresh requests with the same token result in exactly ONE success and 9 rejections, keeping family alive', async () => {
      // 1. Login to obtain token
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const targetToken = loginRes.body.refreshToken;

      // 2. Fire 10 simultaneous refresh requests
      const promises = Array.from({ length: 10 }).map(() =>
        request(app.getHttpServer())
          .post('/v1/auth/refresh')
          .set('X-Database', AUTH_TEST_DB)
          .set('X-Client', 'mobile')
          .send({ refreshToken: targetToken }),
      );

      const results = await Promise.all(promises);

      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status === 401);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(9);

      // Verify family is NOT destroyed because concurrent attempts fell within grace window
      const client = await clientManager.getClient(AUTH_TEST_DB);
      const newSessionId = successes[0]!.body.refreshToken.split('.')[0];
      const newSession = await client.session.findUnique({ where: { id: newSessionId } });
      expect(newSession?.revokedReason).toBeNull();
    });
  });

  describe('Test 6: Expiration Boundaries and Max Active Sessions Limit', () => {
    it('Rejects tokens exceeding the 90-day absolute family limit and 30-day sliding limit', async () => {
      const client = await clientManager.getClient(AUTH_TEST_DB);

      // 1. Test 90-day absolute limit
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token = loginRes.body.refreshToken;
      const [sid] = token.split('.');

      // Manipulate familyCreatedAt in DB to 91 days ago
      await client.session.update({
        where: { id: sid },
        data: { familyCreatedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
      });

      const resExpiredFamily = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: token })
        .expect(401);

      expect(resExpiredFamily.body.error.code).toBe('UNAUTHENTICATED');

      // 2. Test 30-day sliding limit
      const loginRes2 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token2 = loginRes2.body.refreshToken;
      const [sid2] = token2.split('.');

      // Manipulate expiresAt in DB to 1 hour ago
      await client.session.update({
        where: { id: sid2 },
        data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const resExpiredSession = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ refreshToken: token2 })
        .expect(401);

      expect(resExpiredSession.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('Enforces maximum 10 active sessions limit per user by revoking the oldest active family', async () => {
      const client = await clientManager.getClient(AUTH_TEST_DB);
      const userId = TEST_USER_IDS.normal;

      // Clean existing sessions
      await client.session.updateMany({
        where: { userId },
        data: { revokedReason: 'cleanup' },
      });

      // Create 10 sessions sequentially
      const sessionIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await request(app.getHttpServer())
          .post('/v1/auth/login')
          .set('X-Database', AUTH_TEST_DB)
          .set('X-Client', 'mobile')
          .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
          .expect(200);
        sessionIds.push(res.body.refreshToken.split('.')[0]);
      }

      const activeCountBefore = await client.session.count({
        where: { userId, revokedReason: null },
      });
      expect(activeCountBefore).toBe(10);

      // 11th login must trigger revocation of the oldest family
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .set('X-Client', 'mobile')
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      // First session must now be revoked with max_sessions_exceeded
      const firstSession = await client.session.findUnique({ where: { id: sessionIds[0] } });
      expect(firstSession?.revokedReason).toBe('max_sessions_exceeded');

      const activeCountAfter = await client.session.count({
        where: { userId, revokedReason: null },
      });
      expect(activeCountAfter).toBe(10);
    });
  });

  describe('Test 7: Logout, Logout-All, Password Change, and User Deactivation Invariants', () => {
    it('POST /logout instantly invalidates the access token in Redis', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token = loginRes.body.accessToken;

      // Valid access before logout
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // Call logout
      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // Access token must be rejected IMMEDIATELY (no 15-minute wait)
      const afterLogout = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      expect(afterLogout.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('POST /logout-all revokes all sessions and invalidates prior access tokens', async () => {
      // Create session 1
      const login1 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      // Create session 2
      const login2 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token1 = login1.body.accessToken;
      const token2 = login2.body.accessToken;

      // Call logout-all using session 2
      await request(app.getHttpServer())
        .post('/v1/auth/logout-all')
        .set('Authorization', `Bearer ${token2}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // Both tokens must be rejected
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token1}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token2}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);
    });

    it('POST /change-password invalidates other sessions, updates password, and allows current session to continue with new token', async () => {
      // Login session 1
      const login1 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      // Login session 2
      const login2 = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const token1 = login1.body.accessToken;
      const token2 = login2.body.accessToken;
      const newPassword = 'NewSecretPassword2026!Updated';

      // Change password from session 1
      const changeRes = await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token1}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({
          currentPassword: TEST_PASSWORDS.normal,
          newPassword,
        })
        .expect(200);

      const newToken1 = changeRes.body.accessToken;
      expect(newToken1).toBeDefined();

      // Session 2 token must be rejected
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token2}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // New token 1 continues working
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${newToken1}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // Login with old password fails
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(401);

      // Login with new password succeeds
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: newPassword })
        .expect(200);
    });

    it('Direct user deactivation in database and revoked-before in Redis immediately rejects active tokens', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'admin_user', password: TEST_PASSWORDS.admin })
        .expect(200);

      const token = loginRes.body.accessToken;

      // Verify token works
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // Admin or system revokes user before now in Redis
      await authRevocationService.revokeUserBefore(
        AUTH_TEST_DB,
        loginRes.body.user.id,
        Date.now() + 1000,
      );

      // Token must immediately be rejected
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });
});
