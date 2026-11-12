/**
 * check-drift.mjs
 * Cross-platform script to detect schema drift between prisma/schema.prisma and migrations.
 * Uses Prisma migrate diff and filters allowed partition noise using check-drift-filter.mjs.
 */

import { execSync } from 'node:child_process';
import pg from 'pg';
import { filterDrift } from './check-drift-filter.mjs';

const { Client } = pg;

async function run() {
  console.log('[INFO] Starting schema drift verification...');

  let shadowUrl = process.env.SHADOW_DATABASE_URL;
  let createdTempDb = false;
  const tempDbName = `erp_drift_shadow_${Date.now()}`;

  // If no shadow database URL is provided, try to create an ephemeral one
  if (!shadowUrl) {
    const rawUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres';
    const parsed = new URL(rawUrl);

    // Use admin/superuser to create temp db
    const adminClient = new Client({
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432', 10),
      user: process.env.POSTGRES_USER || parsed.username || 'postgres',
      password: process.env.POSTGRES_PASSWORD || parsed.password || 'postgres',
      database: 'postgres',
    });

    try {
      await adminClient.connect();
      console.log(`[INFO] Creating ephemeral shadow database "${tempDbName}"...`);
      await adminClient.query(`CREATE DATABASE "${tempDbName}"`);
      createdTempDb = true;

      // Shadow URL with erp_migrator or postgres user
      parsed.pathname = `/${tempDbName}`;
      shadowUrl = parsed.toString();
    } catch (err) {
      console.warn(`[WARN] Could not create ephemeral shadow database: ${err.message}`);
      console.warn('[INFO] Attempting drift diff without explicit shadow-database-url (if supported)...');
    } finally {
      await adminClient.end().catch(() => {});
    }
  }

  try {
    const shadowFlag = shadowUrl ? `--shadow-database-url "${shadowUrl}"` : '';
    const cmd = `pnpm --filter @bodo/api exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma ${shadowFlag} --script`;

    console.log('[INFO] Running prisma migrate diff...');
    let rawOutput = '';
    try {
      rawOutput = execSync(cmd, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (execErr) {
      // If prisma migrate diff exits with non-zero or error
      const stdout = execErr.stdout ? execErr.stdout.toString() : '';
      const stderr = execErr.stderr ? execErr.stderr.toString() : '';
      if (!stdout && stderr) {
        console.error('[ERROR] Failed to execute prisma migrate diff:');
        console.error(stderr);
        process.exit(1);
      }
      rawOutput = stdout;
    }

    const { isClean, unexpectedDiffs } = filterDrift(rawOutput);

    if (!isClean) {
      console.error('[ERROR] Schema drift detected! Found unexpected differences between migrations and schema:');
      for (const diff of unexpectedDiffs) {
        console.error('---');
        console.error(diff.trim());
      }
      process.exit(1);
    }

    console.log('[OK] Database schema and migrations are fully in sync (expected partition noise filtered).');
  } finally {
    if (createdTempDb) {
      try {
        const rawUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres';
        const parsed = new URL(rawUrl);
        const adminClient = new Client({
          host: parsed.hostname,
          port: parseInt(parsed.port || '5432', 10),
          user: process.env.POSTGRES_USER || parsed.username || 'postgres',
          password: process.env.POSTGRES_PASSWORD || parsed.password || 'postgres',
          database: 'postgres',
        });
        await adminClient.connect();
        await adminClient.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`);
        await adminClient.end();
        console.log(`[INFO] Dropped ephemeral shadow database "${tempDbName}".`);
      } catch (cleanupErr) {
        console.warn(`[WARN] Failed to drop ephemeral shadow database: ${cleanupErr.message}`);
      }
    }
  }
}

run().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
