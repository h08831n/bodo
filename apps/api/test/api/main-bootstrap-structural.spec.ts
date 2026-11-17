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

  it('HTTP verification: createTestApp rejects malformed JSON with 400 VALIDATION_FAILED, Helmet, requestId, and no X-Powered-By', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/json')
      .send('{"invalid_json: true'); // Malformed JSON string

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_FAILED');
    expect(res.body?.error?.message).toMatch(/قالب داده ارسالی \(JSON\) نامعتبر است/);
    expect(res.body?.error?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Security headers (Helmet)
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Absence of X-Powered-By
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('HTTP verification: createTestApp rejects payload > 1MB with 413 PAYLOAD_TOO_LARGE, Helmet, requestId, and no X-Powered-By', async () => {
    const largePayload = 'a'.repeat(1024 * 1024 + 100); // > 1MB
    const res = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ password: largePayload }));

    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body?.error?.message).toMatch(/حجم بدنه درخواست بیش از حد مجاز است/);
    expect(res.body?.error?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('HTTP verification: createTestApp rejects unsupported media type with 415, Helmet, requestId, and no X-Powered-By', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/xml')
      .send('<xml><body>not json</body></xml>');

    expect(res.status).toBe(415);
    expect(res.body?.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.body?.error?.message).toMatch(/قالب رسانه درخواست پشتیبانی نمی‌شود/);
    expect(res.body?.error?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('HTTP verification: successful response returns raw payload directly (NO { data, meta } wrapper), Helmet headers, and no X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
    // Raw payload directly returned
    expect(res.body?.status).toBe('ok');
    expect(res.body?.data).toBeUndefined();
    expect(res.body?.meta).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
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
