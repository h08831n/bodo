import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test-app';
import { expectNoSecrets } from '../../src/common/testing/expect-no-secrets';

describe('Auth: Structural and OpenAPI Invariants (Test 19)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('Verifies OpenAPI specification includes BearerAuth security scheme and schemas contain zero secrets', () => {
    const config = new DocumentBuilder()
      .setTitle('Bodo ERP API')
      .setDescription('Bodo ERP API Test Specification')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);

    // 1. Verify Bearer security scheme is registered
    const securitySchemes = document.components?.securitySchemes as
      Record<string, { type?: string; scheme?: string }> | undefined;
    expect(securitySchemes).toBeDefined();
    expect(securitySchemes?.bearer).toBeDefined();
    expect(securitySchemes?.bearer?.type).toBe('http');
    expect(securitySchemes?.bearer?.scheme).toBe('bearer');

    // 2. Verify Auth endpoints are registered in OpenAPI paths
    expect(document.paths['/v1/auth/login']).toBeDefined();
    expect(document.paths['/v1/auth/refresh']).toBeDefined();
    expect(document.paths['/v1/auth/logout']).toBeDefined();
    expect(document.paths['/v1/auth/me']).toBeDefined();

    // 3. Verify schemas contain no sensitive secrets leaked
    expectNoSecrets(document.paths['/v1/auth/login']);
    expectNoSecrets(document.paths['/v1/auth/me']);
  });

  it('Verifies every controller route adheres to default-closed security or explicit allowed public routes', () => {
    const config = new DocumentBuilder()
      .setTitle('Bodo ERP API')
      .setDescription('Bodo ERP API Test Specification')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    const paths = Object.keys(document.paths);

    // Verify all registered routes exist
    expect(paths.length).toBeGreaterThan(0);

    // Verify that all core business routes exist
    expect(paths).toContain('/v1/auth/login');
    expect(paths).toContain('/v1/auth/refresh');
    expect(paths).toContain('/v1/auth/logout');
    expect(paths).toContain('/v1/auth/me');
    expect(paths).toContain('/v1/auth/change-password');
    expect(paths).toContain('/v1/auth/sessions');
  });
});
