#!/usr/bin/env node
import { getDbConfig, connectWithRetry, formatDbError } from './db-env.mjs';

/**
 * Resets the local development company database (e.g. erp_dev) cleanly:
 * Drops connections, drops database, creates database with OWNER erp_migrator.
 */

async function resetDevDb() {
  const config = getDbConfig();
  const targetDb = config.targetDb;

  console.log(`[reset-dev] Resetting database "${targetDb}"...`);

  let conn;
  try {
    conn = await connectWithRetry(config.getSuperuserUrl('postgres'), {
      maxAttempts: 15,
      delayMs: 1000,
    });
  } catch (err) {
    console.error('[reset-dev] Connection Failure:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  }

  const { pool, client } = conn;

  try {
    console.log(`[reset-dev] Terminating active connections to "${targetDb}"...`);
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid();
    `, [targetDb]);

    console.log(`[reset-dev] Dropping database "${targetDb}" if exists...`);
    await client.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE);`);

    console.log(`[reset-dev] Creating clean database "${targetDb}" OWNER erp_migrator...`);
    await client.query(`CREATE DATABASE "${targetDb}" OWNER erp_migrator;`);

    console.log(`[reset-dev] SUCCESS: Database "${targetDb}" cleanly reset.`);
  } catch (err) {
    console.error('[reset-dev] ERROR:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

resetDevDb().catch((err) => {
  const config = getDbConfig();
  console.error('[reset-dev] FATAL ERROR:');
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
