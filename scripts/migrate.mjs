#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbConfig, formatDbError } from './db-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function runMigrate() {
  const config = getDbConfig();
  const migratorUrl = config.getMigratorUrl();

  console.log(`[db:migrate] Target database: "${config.targetDb}"`);
  console.log(
    `[db:migrate] Executing migrations as role "${config.migrator.user}"...`,
  );

  const env = {
    ...process.env,
    DATABASE_URL: migratorUrl,
  };

  const schemaPath = path.resolve(projectRoot, 'apps/api/prisma/schema.prisma');
  const res = spawnSync(
    'pnpm',
    ['--filter', '@bodo/api', 'exec', 'prisma', 'migrate', 'deploy', `--schema=${schemaPath}`],
    {
      cwd: projectRoot,
      env,
      stdio: 'inherit',
      shell: true,
    },
  );

  if (res.status !== 0) {
    const errMsg = `Prisma migrate deploy exited with code ${res.status}`;
    console.error(`[db:migrate] ERROR: ${errMsg}`);
    console.error(formatDbError(res.error || new Error(errMsg), config.host, config.port));
    process.exit(res.status || 1);
  }

  console.log(`[db:migrate] SUCCESS: Migrations applied cleanly to "${config.targetDb}".`);
}

runMigrate().catch((err) => {
  const config = getDbConfig();
  console.error('[db:migrate] FATAL ERROR:');
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
