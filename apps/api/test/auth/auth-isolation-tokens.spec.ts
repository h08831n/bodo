import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import * as jose from 'jose';
import { createTestApp } from '../test-app';
import {
  AUTH_TEST_DB,
  AUTH_TEST_DB_B,
  TEST_PASSWORDS,
  setupAuthTestEnvironment,
  teardownAuthTestEnvironment,
} from './auth-test-helper';
import { getEnv } from '../../src/config/env.config';

describe('Auth: Token Invariants and Multi-Tenant Isolation (Tests 8, 9, 10)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await setupAuthTestEnvironment(app);
  }, 180000);

  afterAll(async () => {
    await teardownAuthTestEnvironment(app);
    if (app) {
      await app.close();
    }
  });

  describe('Test 8: Token Tampering, Algorithm Forgery, Expiry, and Claims Resolution', () => {
    it('Rejects tampered tokens, alg:none, RS256, expired tokens, admin aud, missing sid, and cross-db header mismatch', async () => {
      // 1. Obtain a valid token first
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const validToken = loginRes.body.accessToken;

      // 2. Tampered signature
      const tamperedToken = validToken.substring(0, validToken.length - 5) + 'xxxxx';
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 3. alg: none attack
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const payloadB64 = Buffer.from(
        JSON.stringify({
          sub: loginRes.body.user.id,
          typ: 'INTERNAL',
          db: AUTH_TEST_DB,
          sid: crypto.randomUUID(),
          mcp: false,
          iss: 'bodo',
          aud: 'bodo-user',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      const algNoneToken = `${headerB64}.${payloadB64}.`;

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${algNoneToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 4. Asymmetric RS256 algorithm confusion
      const { privateKey } = await jose.generateKeyPair('RS256');
      const rs256Token = await new jose.SignJWT({
        sub: loginRes.body.user.id,
        typ: 'INTERNAL',
        db: AUTH_TEST_DB,
        sid: crypto.randomUUID(),
        mcp: false,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer('bodo')
        .setAudience('bodo-user')
        .setExpirationTime('15m')
        .sign(privateKey);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${rs256Token}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 5. Expired token
      const env = getEnv();
      const expiredSecret = new TextEncoder().encode(env.JWT_SECRET);
      const expiredToken = await new jose.SignJWT({
        sub: loginRes.body.user.id,
        typ: 'INTERNAL',
        db: AUTH_TEST_DB,
        sid: crypto.randomUUID(),
        mcp: false,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setIssuer('bodo')
        .setAudience('bodo-user')
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
        .sign(expiredSecret);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 6. Admin audience token on tenant route
      const adminAudToken = await new jose.SignJWT({
        sub: 'admin-id',
        typ: 'INTERNAL',
        db: AUTH_TEST_DB,
        sid: crypto.randomUUID(),
        mcp: false,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('bodo')
        .setAudience('bodo-admin') // Admin audience!
        .setExpirationTime('15m')
        .sign(expiredSecret);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${adminAudToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 7. Missing sid claim
      const noSidToken = await new jose.SignJWT({
        sub: loginRes.body.user.id,
        typ: 'INTERNAL',
        db: AUTH_TEST_DB,
        mcp: false,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('bodo')
        .setAudience('bodo-user')
        .setExpirationTime('15m')
        .sign(expiredSecret);

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${noSidToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 8. Token of DB A sent with X-Database header of DB B -> 401 mismatch
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${validToken}`)
        .set('X-Database', AUTH_TEST_DB_B) // Cross-tenant spoofing attempt
        .expect(401);

      // 9. Token WITHOUT X-Database header resolves own tenant DB via TokenClaimResolver
      const resolvedRes = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${validToken}`)
        // Intentionally no X-Database or Host header
        .expect(200);

      expect(resolvedRes.body.user.username).toBe('normal_user');
    });
  });

  describe('Test 9: Cross-Tenant Isolation with Identical Usernames', () => {
    it('Supports identical usernames with different passwords across tenant DBs and prevents cross-DB access', async () => {
      // 1. In DB A, login with DB A password succeeds
      const loginA = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'admin_user', password: TEST_PASSWORDS.admin })
        .expect(200);

      // In DB A, login with DB B password fails
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'admin_user', password: 'PasswordCompanyB2026!' })
        .expect(401);

      // 2. In DB B, login with DB B password succeeds
      const loginB = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB_B)
        .send({ username: 'admin_user', password: 'PasswordCompanyB2026!' })
        .expect(200);

      // In DB B, login with DB A password fails
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB_B)
        .send({ username: 'admin_user', password: TEST_PASSWORDS.admin })
        .expect(401);

      const tokenA = loginA.body.accessToken;
      const tokenB = loginB.body.accessToken;

      // 3. Verify cookie isolation
      const rawCookieA = loginA.headers['set-cookie'];
      const rawCookieB = loginB.headers['set-cookie'];
      const cookieA = Array.isArray(rawCookieA) ? rawCookieA : [rawCookieA || ''];
      const cookieB = Array.isArray(rawCookieB) ? rawCookieB : [rawCookieB || ''];

      // Cookie name for DB A should be bodo_rt_auth_test
      // Cookie name for DB B should be bodo_rt_auth_test_b
      expect(cookieA.some((c: string) => c.includes('bodo_rt_auth_test='))).toBe(true);
      expect(cookieB.some((c: string) => c.includes('bodo_rt_auth_test_b='))).toBe(true);

      // 4. Token A cannot access DB B
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Database', AUTH_TEST_DB_B)
        .expect(401);

      // 5. Token B cannot access DB A
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);
    });
  });

  describe('Test 10: Strict Admin vs Tenant Route Boundary Isolation', () => {
    it('Rejects tenant user token on /v1/admin/* and rejects admin token on tenant routes', async () => {
      // 1. Obtain tenant user token
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'admin_user', password: TEST_PASSWORDS.admin })
        .expect(200);

      const tenantToken = loginRes.body.accessToken;

      // 2. Tenant user token on master admin endpoint must be rejected (401 or 403)
      await request(app.getHttpServer())
        .get('/v1/admin/databases')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(401);

      // 3. Obtain Master Admin token
      const adminLoginRes = await request(app.getHttpServer())
        .post('/v1/admin/login')
        .send({ password: process.env.MASTER_PASSWORD || 'MasterSecurePassword2026!' })
        .expect(200);

      const adminToken = adminLoginRes.body.token;

      // 4. Master admin token on tenant route must be rejected (401)
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);
    });
  });
});
