#!/usr/bin/env node
import pg from 'pg';
import process from 'node:process';

/**
 * Creates the local development company database (erp_dev) owned by erp_migrator.
 * Idempotent: checks pg_database first.
 */

const { Pool } = pg;
const superuserUrl = process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@localhost:${process.env.POSTGRES_PORT || 5433}/postgres`;
const targetDb = 'erp_dev';

async function createDevDb() {
  console.log(`[create-dev] Checking if database "${targetDb}" exists...`);
  const pool = new Pool({
    connectionString: superuserUrl,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();

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
  } finally {
    client.release();
    await pool.end();
  }
}

createDevDb().catch((err) => {
  console.error('[create-dev] ERROR:', err.message);
  process.exit(1);
});
