#!/usr/bin/env node
import pg from 'pg';
import process from 'node:process';
import readline from 'node:readline';

/**
 * Drops and recreates ONLY `erp_dev` database.
 * Safety guards:
 * 1. Strictly refuses if NODE_ENV === 'production'
 * 2. Strictly refuses if host is not localhost / 127.0.0.1
 * 3. Strictly refuses if target db does not start with 'erp_'
 * 4. Requires typed confirmation ("yes") unless --force flag is passed
 */

const { Pool } = pg;
const superuserUrl = process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@localhost:${process.env.POSTGRES_PORT || 5433}/postgres`;
const targetDb = 'erp_dev';

// Guard 1: production check
if (process.env.NODE_ENV === 'production') {
  console.error('[reset-dev] ERROR: Refusing to reset database in production environment.');
  process.exit(1);
}

// Guard 2: host check
const parsedUrl = new URL(superuserUrl);
const allowedHosts = ['localhost', '127.0.0.1', '::1'];
if (!allowedHosts.includes(parsedUrl.hostname)) {
  console.error(`[reset-dev] ERROR: Host "${parsedUrl.hostname}" is not local. Refusing to reset non-local database.`);
  process.exit(1);
}

// Guard 3: prefix check
if (!targetDb.startsWith('erp_')) {
  console.error(`[reset-dev] ERROR: Database name "${targetDb}" does not start with "erp_".`);
  process.exit(1);
}

async function promptConfirmation() {
  if (process.argv.includes('--force') || process.argv.includes('-y')) {
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`[reset-dev] CAUTION: This will DROP database "${targetDb}" and all its data.\nType "yes" to proceed: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function resetDevDb() {
  const confirmed = await promptConfirmation();
  if (!confirmed) {
    console.log('[reset-dev] Aborted by user.');
    process.exit(0);
  }

  console.log(`[reset-dev] Terminating active connections to "${targetDb}"...`);
  const pool = new Pool({
    connectionString: superuserUrl,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();

  try {
    // Terminate existing connections
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid();
    `, [targetDb]);

    console.log(`[reset-dev] Dropping database "${targetDb}" if exists...`);
    await client.query(`DROP DATABASE IF EXISTS "${targetDb}";`);

    console.log(`[reset-dev] Creating clean database "${targetDb}" with OWNER erp_migrator...`);
    await client.query(`CREATE DATABASE "${targetDb}" OWNER erp_migrator;`);

    console.log(`[reset-dev] SUCCESS: Database "${targetDb}" has been reset cleanly.`);
  } finally {
    client.release();
    await pool.end();
  }
}

resetDevDb().catch((err) => {
  console.error('[reset-dev] ERROR:', err.message);
  process.exit(1);
});
