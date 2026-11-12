#!/usr/bin/env node
import pg from 'pg';
import process from 'node:process';

/**
 * Cross-platform script to idempotently initialize database isolation roles
 * (erp_provisioner, erp_migrator, erp_app) on an existing or new PostgreSQL cluster.
 *
 * Connects using superuser credentials from environment variables.
 */

const { Pool } = pg;

// Read configuration from environment
const superuserUrl =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@localhost:${process.env.POSTGRES_PORT || 5433}/postgres`;

const provisionerPassword =
  process.env.ERP_PROVISIONER_PASSWORD || 'provisioner_secret_change_in_prod';
const migratorPassword = process.env.ERP_MIGRATOR_PASSWORD || 'migrator_secret_change_in_prod';
const appPassword = process.env.ERP_APP_PASSWORD || 'app_secret_change_in_prod';

function escapeSqlLiteral(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

async function initRoles() {
  console.log('[init-roles] Connecting to PostgreSQL superuser database...');
  const pool = new Pool({
    connectionString: superuserUrl,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();

  try {
    console.log(
      '[init-roles] Ensuring database isolation roles exist and passwords are synchronized...',
    );

    // 1. erp_provisioner (LOGIN CREATEDB)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_provisioner') THEN
          CREATE ROLE erp_provisioner WITH LOGIN CREATEDB;
        END IF;
      END $$;
    `);
    await client.query(
      `ALTER ROLE erp_provisioner WITH LOGIN CREATEDB PASSWORD ${escapeSqlLiteral(provisionerPassword)};`,
    );
    console.log('  ✓ Role erp_provisioner verified (LOGIN CREATEDB)');

    // 2. erp_migrator (LOGIN)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_migrator') THEN
          CREATE ROLE erp_migrator WITH LOGIN;
        END IF;
      END $$;
    `);
    await client.query(
      `ALTER ROLE erp_migrator WITH LOGIN PASSWORD ${escapeSqlLiteral(migratorPassword)};`,
    );
    console.log('  ✓ Role erp_migrator verified (LOGIN)');

    // 3. erp_app (LOGIN)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'erp_app') THEN
          CREATE ROLE erp_app WITH LOGIN;
        END IF;
      END $$;
    `);
    await client.query(`ALTER ROLE erp_app WITH LOGIN PASSWORD ${escapeSqlLiteral(appPassword)};`);
    console.log('  ✓ Role erp_app verified (LOGIN)');

    // 4. PostgreSQL 15+ ownership grant: erp_provisioner must be a member of erp_migrator
    await client.query(`GRANT erp_migrator TO erp_provisioner;`);
    console.log('  ✓ Granted role erp_migrator to erp_provisioner (PG15+ ownership delegation)');

    console.log('[init-roles] SUCCESS: All roles successfully initialized.');
  } finally {
    client.release();
    await pool.end();
  }
}

initRoles().catch((err) => {
  console.error('[init-roles] ERROR:', err.message);
  process.exit(1);
});
