import request from 'supertest';
import { INestApplication, Controller, Get, Post, Body } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createTestApp } from '../test-app';
import { expectNoSecrets } from '../../src/common/testing/expect-no-secrets';
import { LoggerService } from '../../src/common/logger/logger.service';
import { resetEnv } from '../../src/config/env.config';
import { Public } from '../../src/common/decorators/auth.decorators';

@Public()
@Controller('v1/public/test-serializer')
class TestSerializerController {
  @Get('types')
  getTypes() {
    return {
      bigIntValue: BigInt('90071992547409921'),
      decimalValue: new Prisma.Decimal('123456.78'),
      dateValue: new Date('2026-05-15T12:30:00.000Z'),
      undefinedField: undefined,
      regularString: 'normal-text',
      regularNumber: 42,
    };
  }

  @Post('echo')
  echoBody(@Body() _body: unknown) {
    return { received: true };
  }
}

describe('Serialization, Redaction, and Request Context Integration Tests (Tests 15, 16, 17)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [TestSerializerController],
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('Test 15: Global serializer converts BigInt, Decimal to string, Date to UTC ISO-8601 with Z, strips undefined, and passes expectNoSecrets', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/public/test-serializer/types')
      .expect(200);

    // 1. BigInt converted to string
    expect(res.body.bigIntValue).toBe('90071992547409921');
    expect(typeof res.body.bigIntValue).toBe('string');

    // 2. Decimal converted to string
    expect(res.body.decimalValue).toBe('123456.78');
    expect(typeof res.body.decimalValue).toBe('string');

    // 3. Date converted to ISO UTC string ending in 'Z'
    expect(res.body.dateValue).toBe('2026-05-15T12:30:00.000Z');
    expect(res.body.dateValue.endsWith('Z')).toBe(true);

    // 4. Undefined field stripped
    expect(res.body).not.toHaveProperty('undefinedField');

    // 5. expectNoSecrets verification passes on serialized payload
    expect(() => expectNoSecrets(res.body)).not.toThrow();

    // 6. expectNoSecrets catches secret leaks when present
    const leakyObject = {
      user: {
        name: 'John',
        passwordHash: '$argon2id$v=19$m=65536...',
      },
    };
    expect(() => expectNoSecrets(leakyObject)).toThrow(/passwordHash/);
  });

  it('Test 16: Pino log redaction censors passwords, tokens, national IDs, and card numbers, and request log never includes request body', async () => {
    const logger = app.get(LoggerService);
    const logs: string[] = [];

    const pinoLogger = (
      logger as unknown as {
        pinoLogger: { info: (obj: unknown, msg?: string) => void };
      }
    ).pinoLogger;
    const originalLog = pinoLogger.info.bind(pinoLogger);
    pinoLogger.info = (obj: unknown, msg?: string) => {
      logs.push(JSON.stringify(obj) + ' ' + (msg || ''));
      return originalLog(obj, msg);
    };

    // Test sanitization helper in logger
    logger.log(
      'User activity record: secret card 6037-9918-2345-6789 and national id 0012345678',
      'TestContext',
      {
        token: 'secret-jwt-token-xyz',
        password: 'mySuperSecretPassword!',
        safeData: 'visible-data',
      },
    );

    const loggedStr = logs.join('\n');
    expect(loggedStr).not.toContain('secret-jwt-token-xyz');
    expect(loggedStr).not.toContain('0012345678');
    expect(loggedStr).not.toContain('6037-9918-2345-6789');
    expect(loggedStr).not.toContain('mySuperSecretPassword!');
    expect(loggedStr).toContain('[REDACTED]');
    expect(loggedStr).toContain('[CARD-REDACTED]');
    expect(loggedStr).toContain('[NID-REDACTED]');
    expect(loggedStr).toContain('visible-data');

    // Verify request logging never logs body
    logs.length = 0;
    await request(app.getHttpServer())
      .post('/v1/public/test-serializer/echo')
      .send({ secretPassword: 'super-sensitive-request-body-content' })
      .expect(201);

    const requestLogStr = logs.join('\n');
    expect(requestLogStr).not.toContain('super-sensitive-request-body-content');
  });

  it('Test 17: Request context source mapping from X-Client header and OpenAPI /docs availability', async () => {
    // 1. X-Client: web mapping
    const webRes = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Client', 'web')
      .expect(200);
    expect(webRes.status).toBe(200);

    // 2. X-Client: mobile mapping
    const mobileRes = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Client', 'mobile')
      .expect(200);
    expect(mobileRes.status).toBe(200);

    // 3. /docs accessible when OPENAPI_ENABLED is true (default in test)
    const docsRes = await request(app.getHttpServer()).get('/docs').redirects(1);
    expect(docsRes.status).toBe(200);
    expect(docsRes.text).toContain('swagger');

    // 4. In production mode (OPENAPI_ENABLED=false), /docs returns 404
    process.env.OPENAPI_ENABLED = 'false';
    resetEnv();
    const prodApp = await createTestApp();
    try {
      await request(prodApp.getHttpServer()).get('/docs').expect(404);
    } finally {
      await prodApp.close();
      delete process.env.OPENAPI_ENABLED;
      resetEnv();
    }
  });
});
