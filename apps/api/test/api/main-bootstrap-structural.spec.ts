import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test-app';
import { APP_PIPE, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppModule } from '../../src/app.module';

describe('Structural & Unified Configuration Guard (Rule 3)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('structural check: main.ts must NOT register global pipes, filters, or interceptors independently', () => {
    const mainPath = path.resolve(__dirname, '../../src/main.ts');
    const content = fs.readFileSync(mainPath, 'utf8');

    // Forbidden in main.ts because they must be registered in AppModule via APP_* tokens
    // to ensure 100% parity between main.ts production bootstrap and createTestApp() test runs.
    expect(content).not.toMatch(/app\.useGlobalPipes\s*\(/);
    expect(content).not.toMatch(/app\.useGlobalFilters\s*\(/);
    expect(content).not.toMatch(/app\.useGlobalInterceptors\s*\(/);
    expect(content).not.toMatch(/app\.useGlobalGuards\s*\(/);
  });

  it('AppModule provides APP_PIPE, APP_FILTER, and APP_INTERCEPTOR', () => {
    const providers = Reflect.getMetadata('providers', AppModule) || [];
    const tokens = providers.map((p: unknown) =>
      typeof p === 'object' && p !== null && 'provide' in p
        ? (p as { provide: unknown }).provide
        : p,
    );

    expect(tokens).toContain(APP_PIPE);
    expect(tokens).toContain(APP_FILTER);
    expect(tokens).toContain(APP_INTERCEPTOR);
  });

  it('HTTP verification: createTestApp rejects malformed JSON with 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/json')
      .send('{"invalid_json: true'); // Malformed JSON string

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body?.error?.message).toMatch(/قالب داده ارسالی \(JSON\) نامعتبر است/);
    expect(res.body?.error?.requestId).toBeDefined();
  });

  it('HTTP verification: createTestApp rejects unexpected extra fields with 400 VALIDATION_FAILED (strict schema)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/json')
      .send({
        password: 'anyPassword123!',
        unauthorizedField: 'malicious_extra_payload',
      });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body?.error?.message).toBeDefined();
    // Verify details points to unauthorizedField
    const fieldErrors = (res.body?.error?.details || []) as Array<{
      path?: string | string[];
      message?: string;
    }>;
    const hasExtraField = fieldErrors.some(
      (d) =>
        (typeof d.path === 'string' && d.path.includes('unauthorizedField')) ||
        (Array.isArray(d.path) && d.path.includes('unauthorizedField')) ||
        d.message?.includes('unauthorizedField') ||
        d.message?.includes('Unrecognized key'),
    );
    expect(hasExtraField).toBe(true);
  });
});
