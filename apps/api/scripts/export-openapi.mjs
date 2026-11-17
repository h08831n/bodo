import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function exportOpenApi() {
  process.env.NODE_ENV = 'test';
  process.env.AUTO_MIGRATE = 'false';

  // Import NestJS and compiled modules from dist
  const { NestFactory } = await import('@nestjs/core');
  const { SwaggerModule, DocumentBuilder } = await import('@nestjs/swagger');
  const { patchSwagger } = await import('../dist/common/swagger/patch-swagger.js');
  const { AppModule } = await import('../dist/app.module.js');

  patchSwagger();

  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });

  const config = new DocumentBuilder()
    .setTitle('Bodo ERP API')
    .setDescription('Bodo Multi-Tenant Steel Trading ERP API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outDir = path.resolve(__dirname, '../dist');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'openapi.json');
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2), 'utf8');

  console.info(`[SUCCESS] OpenAPI schema exported successfully to ${outPath}`);
  await app.close();
  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error('[ERROR] Failed to export OpenAPI schema:', err);
  process.exit(1);
});
