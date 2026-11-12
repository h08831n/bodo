#!/usr/bin/env node
/**
 * check-drift.mjs
 * Cross-platform script to detect schema drift between prisma/schema.prisma and migrations.
 * Uses Prisma migrate diff and filters allowed partition noise using check-drift-filter.mjs.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterDrift } from './check-drift-filter.mjs';
import { getDbConfig, connectWithRetry, formatDbError } from './db-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function run() {
  console.log('[INFO] Starting schema drift verification...');
  const config = getDbConfig();

  let shadowUrl = process.env.SHADOW_DATABASE_URL;
  let createdTempDb = false;
  const tempDbName = `erp_drift_shadow_${Date.now()}`;

  // If no shadow database URL is provided, create an ephemeral one
  if (!shadowUrl) {
    let conn;
    try {
      conn = await connectWithRetry(config.getSuperuserUrl('postgres'), {
        maxAttempts: 15,
        delayMs: 1000,
      });
    } catch (err) {
      console.error('[ERROR] Could not connect to PostgreSQL to create shadow database:');
      console.error(formatDbError(err, config.host, config.port));
      process.exit(1);
    }

    const { pool, client } = conn;
    try {
      console.log(`[INFO] Creating ephemeral shadow database "${tempDbName}"...`);
      await client.query(`CREATE DATABASE "${tempDbName}" OWNER erp_migrator;`);
      createdTempDb = true;
      shadowUrl = config.getMigratorUrl(tempDbName);
    } catch (err) {
      console.error(`[ERROR] Could not create ephemeral shadow database:`);
      console.error(formatDbError(err, config.host, config.port));
      process.exit(1);
    } finally {
      client.release();
      await pool.end().catch(() => {});
    }
  }

  try {
    let prismaCli = path.resolve(projectRoot, 'apps/api/node_modules/prisma/build/index.js');
    if (!fs.existsSync(prismaCli)) {
      prismaCli = path.resolve(projectRoot, 'node_modules/prisma/build/index.js');
    }

    const schemaPath = path.resolve(projectRoot, 'apps/api/prisma/schema.prisma');
    const migrationsPath = path.resolve(projectRoot, 'apps/api/prisma/migrations');

    const prismaArgs = [
      prismaCli,
      'migrate',
      'diff',
      `--from-migrations=${migrationsPath}`,
      `--to-schema-datamodel=${schemaPath}`,
      '--script',
    ];
    if (shadowUrl) {
      prismaArgs.push(`--shadow-database-url=${shadowUrl}`);
    }

    console.log('[INFO] Running prisma migrate diff...');
    const res = spawnSync(process.execPath, prismaArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    if (res.status !== 0) {
      console.error('[ERROR] Failed to execute prisma migrate diff:');
      if (res.stderr) console.error(res.stderr);
      if (res.stdout) console.error(res.stdout);
      process.exit(res.status || 1);
    }

    const rawOutput = res.stdout || '';

    const { isClean, unexpectedDiffs } = filterDrift(rawOutput);

    if (!isClean) {
      console.error(
        '[ERROR] Schema drift detected! Found unexpected differences between migrations and schema:',
      );
      for (const diff of unexpectedDiffs) {
        console.error('---');
        console.error(diff.trim());
      }
      process.exit(1);
    }

    console.log(
      '[OK] Database schema and migrations are fully in sync (expected partition noise filtered).',
    );
  } finally {
    if (createdTempDb) {
      try {
        const conn = await connectWithRetry(config.getSuperuserUrl('postgres'), {
          maxAttempts: 5,
          delayMs: 500,
        });
        await conn.client.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE);`);
        conn.client.release();
        await conn.pool.end().catch(() => {});
        console.log(`[INFO] Dropped ephemeral shadow database "${tempDbName}".`);
      } catch (cleanupErr) {
        console.warn(`[WARN] Failed to drop ephemeral shadow database: ${cleanupErr.message}`);
      }
    }
  }
}

run().catch((err) => {
  const config = getDbConfig();
  console.error('[FATAL]', formatDbError(err, config.host, config.port));
  process.exit(1);
});
