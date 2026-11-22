#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbConfig, formatDbError } from './db-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function ensureRequiredPackagesBuilt() {
  const utilsDist = path.resolve(projectRoot, 'packages/utils/dist/index.cjs');
  const contractsDist = path.resolve(projectRoot, 'packages/contracts/dist/index.cjs');
  if (!fs.existsSync(utilsDist) || !fs.existsSync(contractsDist)) {
    console.log(
      `[db:seed] Required package build outputs missing. Building @bodo/contracts and @bodo/utils...`,
    );
    const buildRes = spawnSync(
      'pnpm',
      ['turbo', 'run', 'build', '--filter=@bodo/contracts', '--filter=@bodo/utils'],
      {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    if (buildRes.status !== 0) {
      throw new Error(`Failed to build @bodo/contracts and @bodo/utils for database seed.`);
    }
  }
}

async function runSeed() {
  ensureRequiredPackagesBuilt();
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
  const tsconfigPath = path.resolve(projectRoot, 'apps/api/tsconfig.json');
  const res = spawnSync(
    process.execPath,
    [tsxCli, '--tsconfig', tsconfigPath, seedScript],
    {
      cwd: path.resolve(projectRoot, 'apps/api'),
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
