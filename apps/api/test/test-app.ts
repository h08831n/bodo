import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { INestApplication, Type } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { setupExpressApp } from '../src/common/bootstrap/setup-express';
import { AppModule } from '../src/app.module';
import { getEnv } from '../src/config/env.config';
import { patchSwagger } from '../src/common/swagger/patch-swagger';

patchSwagger();

export interface CreateTestAppOptions {
  controllers?: Type<unknown>[];
  customizeModule?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * Creates and initializes a fully configured NestJS application for integration tests.
 * Guarantees 1:1 parity with production runtime (main.ts) by relying on AppModule's
 * APP_PIPE, APP_FILTER, APP_INTERCEPTOR, express body-parser limits, trust proxy,
 * and OpenAPI Swagger configuration.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  const env = getEnv();

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers || [],
  });

  if (options.customizeModule) {
    builder = options.customizeModule(builder);
  }

  const moduleRef: TestingModule = await builder.compile();
  const app = moduleRef.createNestApplication();

  const expressApp = app.getHttpAdapter().getInstance();
  setupExpressApp(expressApp);

  if (env.OPENAPI_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('Bodo ERP API')
      .setDescription('Bodo Multi-Tenant Steel Trading ERP API Specification')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  await app.init();
  return app;
}
