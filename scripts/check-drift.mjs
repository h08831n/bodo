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
    const rawUrl =
      process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres';
    const parsed = new URL(rawUrl);

    const hosts = [parsed.hostname];
    if (parsed.hostname === 'localhost') hosts.push('127.0.0.1');

    let adminClient = null;
    for (let attempt = 1; attempt <= 20; attempt++) {
      for (const h of hosts) {
        try {
          const client = new Client({
            host: h,
            port: parseInt(parsed.port || '5432', 10),
            user: process.env.POSTGRES_USER || parsed.username || 'postgres',
            password: process.env.POSTGRES_PASSWORD || parsed.password || 'postgres',
            database: 'postgres',
          });
          await client.connect();
          adminClient = client;
          parsed.hostname = h;
          break;
        } catch {
          // retry
        }
      }
      if (adminClient) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (adminClient) {
      try {
        console.log(`[INFO] Creating ephemeral shadow database "${tempDbName}"...`);
        await adminClient.query(`CREATE DATABASE "${tempDbName}" OWNER erp_migrator`);
        createdTempDb = true;

        // Shadow URL with erp_migrator credentials for migration execution
        parsed.username = 'erp_migrator';
        parsed.password = process.env.ERP_MIGRATOR_PASSWORD || 'migrator_secret_change_in_prod';
        parsed.pathname = `/${tempDbName}`;
        shadowUrl = parsed.toString();
      } catch (err) {
        console.warn(`[WARN] Could not create ephemeral shadow database: ${err.message}`);
      } finally {
        await adminClient.end().catch(() => {});
      }
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
        const rawUrl =
          process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres';
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
