#!/usr/bin/env node
import { getDbConfig, connectWithRetry, formatDbError } from './db-env.mjs';

/**
 * Cross-platform script to idempotently initialize database isolation roles
 * (erp_provisioner, erp_migrator, erp_app) on an existing or new PostgreSQL cluster.
 *
 * Connects using superuser credentials from environment variables.
 */

function escapeSqlLiteral(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

async function initRoles() {
  const config = getDbConfig();
  console.log('[init-roles] Connecting to PostgreSQL superuser database...');

  let conn;
  try {
    conn = await connectWithRetry(config.getSuperuserUrl('postgres'), {
      maxAttempts: 15,
      delayMs: 1000,
    });
  } catch (err) {
    console.error('[init-roles] Connection Failure:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  }

  const { pool, client, url } = conn;
  console.log(`[init-roles] Connected via ${url.replace(/:[^:]+@/, ':****@')}`);

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
      `ALTER ROLE erp_provisioner WITH LOGIN CREATEDB PASSWORD ${escapeSqlLiteral(config.provisioner.password)};`,
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
      `ALTER ROLE erp_migrator WITH LOGIN PASSWORD ${escapeSqlLiteral(config.migrator.password)};`,
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
    await client.query(
      `ALTER ROLE erp_app WITH LOGIN PASSWORD ${escapeSqlLiteral(config.app.password)};`,
    );
    console.log('  ✓ Role erp_app verified (LOGIN)');

    // 4. PostgreSQL 15+ ownership delegation: erp_provisioner must be a member of erp_migrator
    await client.query(`GRANT erp_migrator TO erp_provisioner;`);
    console.log('  ✓ Granted role erp_migrator to erp_provisioner (PG15+ ownership delegation)');

    // 5. Allow erp_app to connect to postgres database for health check
    await client.query(`GRANT CONNECT ON DATABASE postgres TO erp_app;`);
    console.log('  ✓ Granted CONNECT on database postgres to erp_app (Health check)');

    console.log('[init-roles] SUCCESS: All roles successfully initialized.');
  } catch (err) {
    console.error('[init-roles] ERROR:');
    console.error(formatDbError(err, config.host, config.port));
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

initRoles().catch((err) => {
  const config = getDbConfig();
  console.error('[init-roles] FATAL ERROR:');
  console.error(formatDbError(err, config.host, config.port));
  process.exit(1);
});
