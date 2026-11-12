#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbConfig, formatDbError } from './db-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function runStep(stepName, scriptPath, envOverrides = {}) {
  console.log(`\n========================================================`);
  console.log(` [db:setup-dev] Step: ${stepName}`);
  console.log(`========================================================`);

  const res = spawnSync('node', [scriptPath], {
    cwd: projectRoot,
    env: { ...process.env, ...envOverrides },
    stdio: 'inherit',
    shell: true,
  });

  if (res.status !== 0) {
    throw new Error(
      `Step "${stepName}" failed with exit code ${res.status}. Database setup aborted.`,
    );
  }
}

async function setupDevDb() {
  const config = getDbConfig();
  console.log(`[db:setup-dev] Starting idempotent local database setup for "${config.targetDb}"...`);

  const scriptsDir = path.resolve(projectRoot, 'scripts');

  // Step 1: Initialize Database Roles (superuser)
  await runStep('1/4 Initialize Database Roles', path.resolve(scriptsDir, 'init-roles.mjs'));

  // Step 2: Create Target Company Database (owned by erp_migrator)
  await runStep('2/4 Create Development Database', path.resolve(scriptsDir, 'create-dev-db.mjs'));

  // Step 3: Run Database Migrations (executed as erp_migrator)
  await runStep('3/4 Run Database Migrations', path.resolve(scriptsDir, 'migrate.mjs'));

  // Step 4: Seed Baseline Entities (executed as erp_app)
  await runStep('4/4 Seed Baseline Entities', path.resolve(scriptsDir, 'seed.mjs'));

  console.log(`\n========================================================`);
  console.log(` [db:setup-dev] SUCCESS: Database "${config.targetDb}" is fully provisioned and seeded!`);
  console.log(`========================================================\n`);
}

setupDevDb().catch((err) => {
  const config = getDbConfig();
  console.error('\n[db:setup-dev] ERROR:', err.message);
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
