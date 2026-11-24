import request from 'supertest';
import { INestApplication, Controller, Get } from '@nestjs/common';
import { createTestApp } from '../test-app';
import {
  AUTH_TEST_DB,
  TEST_PASSWORDS,
  TEST_USER_IDS,
  setupAuthTestEnvironment,
  teardownAuthTestEnvironment,
} from './auth-test-helper';
import {
  Public,
  InternalOnly,
  PortalOnly,
  RequirePermission,
} from '../../src/common/decorators/auth.decorators';
import { PermissionRegistry } from '../../src/common/permissions/permission-registry';
import { PermissionService } from '../../src/common/permissions/permission.service';
import { TenantClientManager } from '../../src/infra/tenancy/tenant-client-manager';

@Controller('test-guards')
class TestGuardsController {
  @Get('unprotected')
  unprotected() {
    return { status: 'unprotected_ok' };
  }

  @Public()
  @Get('public')
  publicRoute() {
    return { status: 'public_ok' };
  }

  @InternalOnly()
  @Get('internal-only')
  internalOnly() {
    return { status: 'internal_only_ok' };
  }

  @PortalOnly()
  @Get('portal-only')
  portalOnly() {
    return { status: 'portal_only_ok' };
  }

  @RequirePermission('sales.orders.read')
  @Get('perm-single')
  permSingle() {
    return { status: 'perm_single_ok' };
  }

  @RequirePermission('any', 'sales.orders.create', 'purchases.orders.create')
  @Get('perm-any')
  permAny() {
    return { status: 'perm_any_ok' };
  }

  @RequirePermission('all', 'sales.orders.read', 'sales.orders.create')
  @Get('perm-all')
  permAll() {
    return { status: 'perm_all_ok' };
  }

  @RequirePermission('custom.dynamic.perm')
  @Get('perm-dynamic')
  permDynamic() {
    return { status: 'perm_dynamic_ok' };
  }
}

describe('Auth: Guards, Permission Registry, and Password Change Invariants (Tests 11, 12)', () => {
  let app: INestApplication;
  let clientManager: TenantClientManager;
  let permissionService: PermissionService;

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [TestGuardsController],
    });
    clientManager = app.get(TenantClientManager);
    permissionService = app.get(PermissionService);
    await setupAuthTestEnvironment(app);
  }, 180000);

  afterAll(async () => {
    await teardownAuthTestEnvironment(app);
    if (app) {
      await app.close();
    }
  });

  describe('Test 11: Guard Enforcement, User Types, and Dynamic Permission Evaluation', () => {
    it('Enforces default-closed security, @Public, @InternalOnly vs @PortalOnly, any/all permissions, and system group dynamic permissions', async () => {
      // 1. Unprotected route without token -> 401 default closed
      await request(app.getHttpServer())
        .get('/test-guards/unprotected')
        .set('X-Database', AUTH_TEST_DB)
        .expect(401);

      // 2. @Public route without token -> 200 OK
      const pubRes = await request(app.getHttpServer())
        .get('/test-guards/public')
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);
      expect(pubRes.body.status).toBe('public_ok');

      // 3. Login normal user (INTERNAL) and portal user (PORTAL)
      const normalLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'normal_user', password: TEST_PASSWORDS.normal })
        .expect(200);

      const portalLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'portal_user', password: TEST_PASSWORDS.portal })
        .expect(200);

      const adminLogin = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'admin_user', password: TEST_PASSWORDS.admin })
        .expect(200);

      const normalToken = normalLogin.body.accessToken;
      const portalToken = portalLogin.body.accessToken;
      const adminToken = adminLogin.body.accessToken;

      // Unprotected route with valid token -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/unprotected')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // 4. @InternalOnly vs @PortalOnly
      // INTERNAL user on InternalOnly -> 200
      await request(app.getHttpServer())
        .get('/test-guards/internal-only')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // PORTAL user on InternalOnly -> 403 Forbidden
      await request(app.getHttpServer())
        .get('/test-guards/internal-only')
        .set('Authorization', `Bearer ${portalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      // PORTAL user on PortalOnly -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/portal-only')
        .set('Authorization', `Bearer ${portalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // INTERNAL user on PortalOnly -> 403 Forbidden
      await request(app.getHttpServer())
        .get('/test-guards/portal-only')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      // 5. Permission checks for normal user (initially has 0 permissions)
      await request(app.getHttpServer())
        .get('/test-guards/perm-single')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      // Grant normal user a custom group with 'sales.orders.read'
      const client = await clientManager.getClient(AUTH_TEST_DB);
      const customGroup = await client.group.create({
        data: {
          id: crypto.randomUUID(),
          name: 'فروشندگان تست',
          description: 'گروه تست فروشندگان',
          isSystem: false,
          permissions: {
            create: [{ permissionCode: 'sales.orders.read' }],
          },
          members: {
            create: [{ userId: TEST_USER_IDS.normal }],
          },
        },
      });

      // Invalidate cache
      await permissionService.invalidateUserPermissionCache(AUTH_TEST_DB, TEST_USER_IDS.normal);

      // Now normal user has 'sales.orders.read' -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/perm-single')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // But does NOT have 'sales.orders.create' or 'purchases.orders.create' -> permAny 403
      await request(app.getHttpServer())
        .get('/test-guards/perm-any')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      // Add 'sales.orders.create' to group
      await client.groupPermission.create({
        data: {
          groupId: customGroup.id,
          permissionCode: 'sales.orders.create',
        },
      });
      await permissionService.invalidateUserPermissionCache(AUTH_TEST_DB, TEST_USER_IDS.normal);

      // Now permAny matches ('sales.orders.create') -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/perm-any')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // And permAll matches (both 'sales.orders.read' AND 'sales.orders.create') -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/perm-all')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);

      // 6. System group dynamic permission test
      // Dynamically register a new permission at runtime
      PermissionRegistry.registerPermissions([
        {
          code: 'custom.dynamic.perm',
          resource: 'custom',
          action: 'perm',
          module: 'custom',
          label: 'دسترسی آزمایشی پویا',
        },
      ]);

      // Normal user does not have this permission -> 403
      await request(app.getHttpServer())
        .get('/test-guards/perm-dynamic')
        .set('Authorization', `Bearer ${normalToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      // Admin user (member of is_system = true group) dynamically has ALL permissions without DB update!
      await request(app.getHttpServer())
        .get('/test-guards/perm-dynamic')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);
    });
  });

  describe('Test 12: Password Change Required (mustChangePassword) Invariants', () => {
    it('Blocks non-password routes with 403 PASSWORD_CHANGE_REQUIRED when mcp is true, and restores normal access after change', async () => {
      // 1. Login with mcp_user (seeded with mustChangePassword: true)
      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Database', AUTH_TEST_DB)
        .send({ username: 'mcp_user', password: TEST_PASSWORDS.mcp })
        .expect(200);

      expect(loginRes.body.user.mustChangePassword).toBe(true);
      const mcpToken = loginRes.body.accessToken;

      // 2. /v1/auth/me is ALLOWED with mcp: true
      const meRes = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${mcpToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);
      expect(meRes.body.user.mustChangePassword).toBe(true);

      // 3. Regular protected business route MUST BE REJECTED with 403 PASSWORD_CHANGE_REQUIRED
      const blockedRes = await request(app.getHttpServer())
        .get('/test-guards/unprotected')
        .set('Authorization', `Bearer ${mcpToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(403);

      expect(blockedRes.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      // 4. Change password to unblock
      const newPassword = 'NewSecretPassword2026!Updated';
      const changeRes = await request(app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${mcpToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .send({
          currentPassword: TEST_PASSWORDS.mcp,
          newPassword,
        })
        .expect(200);

      expect(changeRes.body.user.mustChangePassword).toBe(false);
      const cleanToken = changeRes.body.accessToken;

      // 5. With cleanToken, protected business route is now ALLOWED -> 200 OK
      await request(app.getHttpServer())
        .get('/test-guards/unprotected')
        .set('Authorization', `Bearer ${cleanToken}`)
        .set('X-Database', AUTH_TEST_DB)
        .expect(200);
    });
  });
});
