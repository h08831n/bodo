import path from 'node:path';
import { createRequire } from 'node:module';
import { patchNestJsSwagger as originalPatch } from 'nestjs-zod';

export function patchSwagger(): void {
  try {
    const require = createRequire(__filename);
    const swaggerPkgPath = require.resolve('@nestjs/swagger/package.json');
    const swaggerDir = path.dirname(swaggerPkgPath);
    const { SchemaObjectFactory } = require(
      path.join(swaggerDir, 'dist/services/schema-object-factory.js'),
    );
    originalPatch(SchemaObjectFactory);
  } catch {
    originalPatch();
  }
}
