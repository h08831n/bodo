#!/usr/bin/env node
import { getDbConfig, connectWithRetry, formatDbError } from './db-env.mjs';

/**
 * Creates the local development company database (e.g. erp_dev) owned by erp_migrator.
 * Idempotent: checks pg_database first.
 */

async function createDevDb() {
  const config = getDbConfig();
  const targetDb = config.targetDb;

  console.log(`[create-dev] Checking if database "${targetDb}" exists...`);

  let conn;
  try {
    conn = await connectWithRetry(config.getSuperuserUrl('postgres'), {
      maxAttempts: 15,
      delayMs: 1000,
    });
  } catch (err) {
    console.error('[create-dev] Connection Failure:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  }

  const { pool, client } = conn;

  try {
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1;', [targetDb]);
    if (res.rowCount > 0) {
      console.log(`[create-dev] Database "${targetDb}" already exists.`);
    } else {
      console.log(`[create-dev] Creating database "${targetDb}" with OWNER erp_migrator...`);
      // CREATE DATABASE cannot be executed inside a transaction block or with prepared parameter for name
      await client.query(`CREATE DATABASE "${targetDb}" OWNER erp_migrator;`);
      console.log(`[create-dev] SUCCESS: Database "${targetDb}" created.`);
    }
  } catch (err) {
    console.error('[create-dev] ERROR:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

createDevDb().catch((err) => {
  const config = getDbConfig();
  console.error('[create-dev] FATAL ERROR:');
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
