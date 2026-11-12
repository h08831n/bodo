#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbConfig, formatDbError } from './db-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function runSeed() {
  const config = getDbConfig();
  const appUrl = config.getAppUrl();

  console.log(`[db:seed] Target database: "${config.targetDb}"`);
  console.log(
    `[db:seed] Executing baseline seed as role "${config.app.user}" (Least Privilege DML)...`,
  );

  const env = {
    ...process.env,
    DATABASE_URL: appUrl,
    SEED_DATABASE_URL: appUrl,
  };

  let tsxCli = path.resolve(projectRoot, 'apps/api/node_modules/tsx/dist/cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    tsxCli = path.resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
  }

  const seedScript = path.resolve(projectRoot, 'apps/api/prisma/seed.ts');
  const res = spawnSync(
    process.execPath,
    [tsxCli, seedScript],
    {
      cwd: projectRoot,
      env,
      stdio: 'inherit',
      shell: false,
    },
  );

  if (res.status !== 0) {
    const errMsg = `Seed execution exited with code ${res.status}`;
    console.error(`[db:seed] ERROR: ${errMsg}`);
    console.error(formatDbError(res.error || new Error(errMsg), config.host, config.port));
    process.exit(res.status || 1);
  }

  console.log(`[db:seed] SUCCESS: Seed data populated cleanly in "${config.targetDb}".`);
}

runSeed().catch((err) => {
  const config = getDbConfig();
  console.error('[db:seed] FATAL ERROR:');
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
