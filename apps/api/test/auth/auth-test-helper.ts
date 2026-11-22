import pg from 'pg';
import { INestApplication } from '@nestjs/common';
import { getEnv } from '../../src/config/env.config';
import { PasswordHasher } from '../../src/common/auth/password-hasher';
import { DatabaseManagerService } from '../../src/infra/database-manager/database-manager.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';

export const AUTH_TEST_DB = 'erp_auth_test';
export const AUTH_TEST_DB_B = 'erp_auth_test_b';

export const TEST_PASSWORDS = {
  admin: 'AdminSecurePassword2026!',
  normal: 'NormalSecurePassword2026!',
  inactive: 'InactiveSecurePassword2026!',
  locked: 'LockedSecurePassword2026!',
  mcp: 'McpSecurePassword2026!',
  portal: 'PortalSecurePassword2026!',
};

export const TEST_USER_IDS = {
  admin: '11111111-aaaa-4111-8111-111111111111',
  normal: '22222222-bbbb-4222-8222-222222222222',
  inactive: '33333333-cccc-4333-8333-333333333333',
  locked: '44444444-dddd-4444-8444-444444444444',
  mcp: '55555555-eeee-4555-8555-555555555555',
  portal: '66666666-ffff-4666-8666-666666666666',
};

export async function setupAuthTestEnvironment(app: INestApplication) {
  const env = getEnv();
  const dbManager = app.get(DatabaseManagerService);
  const passwordHasher = app.get(PasswordHasher);
  const redisService = app.get(RedisService);
  const clientManager = app.get(TenantClientManager);

  const superuserPool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: 'postgres',
    max: 2,
  });

  // Ensure clean teardown first
  await superuserPool
    .query(`DROP DATABASE IF EXISTS ${AUTH_TEST_DB} WITH (FORCE);`)
    .catch(() => {});
  await superuserPool
    .query(`DROP DATABASE IF EXISTS ${AUTH_TEST_DB_B} WITH (FORCE);`)
    .catch(() => {});

  try {
    const redis = redisService.getClient();
    const keysA = await redis.keys(`*${AUTH_TEST_DB}*`);
    const keysB = await redis.keys(`*${AUTH_TEST_DB_B}*`);
    const allKeys = [...keysA, ...keysB];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }
  } catch {
    // Redis key cleanup is best effort
  }

  // 1. Provision Primary Test DB via DB Manager
  await dbManager.createDatabase({
    name: 'auth_test',
    adminUsername: 'admin_user',
    adminFullName: 'System Admin',
    adminPassword: TEST_PASSWORDS.admin,
  });

  // 2. Provision Secondary Test DB via DB Manager (for multi-tenant isolation tests)
  await dbManager.createDatabase({
    name: 'auth_test_b',
    adminUsername: 'admin_user', // identical username, different password
    adminFullName: 'Admin Company B',
    adminPassword: 'PasswordCompanyB2026!',
  });

  // 3. Seed specific test users in Primary Test DB
  const clientA = await clientManager.getClient(AUTH_TEST_DB);

  const normalHash = await passwordHasher.hashPassword(TEST_PASSWORDS.normal);
  const inactiveHash = await passwordHasher.hashPassword(TEST_PASSWORDS.inactive);
  const lockedHash = await passwordHasher.hashPassword(TEST_PASSWORDS.locked);
  const mcpHash = await passwordHasher.hashPassword(TEST_PASSWORDS.mcp);
  const portalHash = await passwordHasher.hashPassword(TEST_PASSWORDS.portal);

  // Normal active user
  await clientA.user.create({
    data: {
      id: TEST_USER_IDS.normal,
      username: 'normal_user',
      passwordHash: normalHash,
      fullName: 'Normal User',
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
    },
  });

  // Inactive user
  await clientA.user.create({
    data: {
      id: TEST_USER_IDS.inactive,
      username: 'inactive_user',
      passwordHash: inactiveHash,
      fullName: 'Inactive User',
      type: 'INTERNAL',
      status: 'DISABLED',
      mustChangePassword: false,
    },
  });

  // Locked user
  await clientA.user.create({
    data: {
      id: TEST_USER_IDS.locked,
      username: 'locked_user',
      passwordHash: lockedHash,
      fullName: 'Locked User',
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  // Must change password user
  await clientA.user.create({
    data: {
      id: TEST_USER_IDS.mcp,
      username: 'mcp_user',
      passwordHash: mcpHash,
      fullName: 'MCP User',
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: true,
    },
  });

  // Portal user
  await clientA.user.create({
    data: {
      id: TEST_USER_IDS.portal,
      username: 'portal_user',
      passwordHash: portalHash,
      fullName: 'Portal User',
      type: 'PORTAL',
      status: 'ACTIVE',
      mustChangePassword: false,
    },
  });

  await superuserPool.end();

  return {
    AUTH_TEST_DB,
    AUTH_TEST_DB_B,
    superuserPool,
  };
}

export async function teardownAuthTestEnvironment(app: INestApplication) {
  const env = getEnv();
  const superuserPool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: 'postgres',
    max: 2,
  });

  try {
    await superuserPool
      .query(`DROP DATABASE IF EXISTS ${AUTH_TEST_DB} WITH (FORCE);`)
      .catch(() => {});
    await superuserPool
      .query(`DROP DATABASE IF EXISTS ${AUTH_TEST_DB_B} WITH (FORCE);`)
      .catch(() => {});
    if (app) {
      const redisService = app.get(RedisService);
      const redis = redisService.getClient();
      const keysA = await redis.keys(`*${AUTH_TEST_DB}*`);
      const keysB = await redis.keys(`*${AUTH_TEST_DB_B}*`);
      const allKeys = [...keysA, ...keysB];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    }
  } catch {
    // Redis key cleanup is best effort
  } finally {
    await superuserPool.end();
  }
}
