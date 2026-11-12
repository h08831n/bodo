#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Loads environment variables from the root .env file if present.
 * Does not overwrite existing environment variables.
 */
export function loadRootEnv() {
  const envPath = process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.resolve(projectRoot, '.env');

  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch (err) {
      console.warn(`[WARN] Failed to read ${envPath}: ${err.message}`);
    }
  }
}

// Automatically load .env upon importing this module
loadRootEnv();

/**
 * Parses target database from CLI arguments or environment.
 * Default: 'erp_dev'
 * Guard: Name MUST begin with 'erp_'.
 */
export function resolveTargetDb(overrideName) {
  let dbName = overrideName;

  if (!dbName) {
    // Check command line arguments: --db=<name> or --database=<name>
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith('--db=')) {
        dbName = arg.slice(5).trim();
        break;
      }
      if (arg.startsWith('--database=')) {
        dbName = arg.slice(11).trim();
        break;
      }
      if (!arg.startsWith('-') && !dbName) {
        dbName = arg.trim();
      }
    }
  }

  if (!dbName) {
    dbName = process.env.TARGET_DB || process.env.TARGET_DATABASE || 'erp_dev';
  }

  // Guard: Must start with 'erp_'
  if (!dbName.startsWith('erp_')) {
    throw new Error(
      `[SECURITY GUARD] Target company database name must begin with 'erp_' prefix (got: "${dbName}"). Operation aborted.`,
    );
  }

  return dbName;
}

/**
 * Returns structured configuration and role URLs.
 */
export function getDbConfig(targetDbOverride) {
  const targetDb = resolveTargetDb(targetDbOverride);

  // If a template DATABASE_URL was provided, parse host & port from it as fallback
  let parsedFromUrl = null;
  if (process.env.DATABASE_URL) {
    try {
      parsedFromUrl = new URL(process.env.DATABASE_URL);
    } catch {
      // ignore
    }
  }

  let host = process.env.POSTGRES_HOST || parsedFromUrl?.hostname || '127.0.0.1';
  if (host === 'localhost') {
    host = '127.0.0.1';
  }
  const port = parseInt(
    process.env.POSTGRES_PORT || parsedFromUrl?.port || '5433',
    10,
  );

  const superuser = {
    user: process.env.POSTGRES_USER || parsedFromUrl?.username || 'postgres',
    password: process.env.POSTGRES_PASSWORD || parsedFromUrl?.password || 'postgres',
  };

  const provisioner = {
    user: 'erp_provisioner',
    password: process.env.ERP_PROVISIONER_PASSWORD || 'provisioner_secret_change_in_prod',
  };

  const migrator = {
    user: 'erp_migrator',
    password: process.env.ERP_MIGRATOR_PASSWORD || 'migrator_secret_change_in_prod',
  };

  const app = {
    user: 'erp_app',
    password: process.env.ERP_APP_PASSWORD || 'app_secret_change_in_prod',
  };

  function buildUrl(u, p, db) {
    const encUser = encodeURIComponent(u);
    const encPass = encodeURIComponent(p);
    return `postgresql://${encUser}:${encPass}@${host}:${port}/${db}`;
  }

  return {
    host,
    port,
    targetDb,
    superuser,
    provisioner,
    migrator,
    app,
    getSuperuserUrl: (db = 'postgres') => buildUrl(superuser.user, superuser.password, db),
    getProvisionerUrl: (db = 'postgres') => buildUrl(provisioner.user, provisioner.password, db),
    getMigratorUrl: (db = targetDb) => buildUrl(migrator.user, migrator.password, db),
    getAppUrl: (db = targetDb) => buildUrl(app.user, app.password, db),
  };
}

/**
 * Formats database errors comprehensively with individual AggregateError details and actionable guidance.
 */
export function formatDbError(err, host = '127.0.0.1', port = 5433) {
  const lines = [];

  const mainMessage =
    (err && err.message) || (err && String(err)) || 'Unknown PostgreSQL error occurred';
  const code = (err && err.code) || 'N/A';

  lines.push(`Error: ${mainMessage} (code: ${code})`);

  if (err && err.detail) {
    lines.push(`Detail: ${err.detail}`);
  }

  // Handle AggregateError or multiple nested errors
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    lines.push('Inner Errors:');
    err.errors.forEach((innerErr, idx) => {
      const innerMsg = innerErr?.message || String(innerErr);
      const innerCode = innerErr?.code || 'N/A';
      lines.push(`  [${idx + 1}] ${innerMsg} (code: ${innerCode})`);
    });
  }

  // Connection troubleshooting guidance
  const isConnError =
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === '57P03' ||
    /timeout|connect|refused/i.test(mainMessage);

  if (isConnError) {
    lines.push(
      `[GUIDE] Cannot reach PostgreSQL at ${host}:${port}. Is Docker Desktop running?`,
    );
    lines.push(
      '       Try running dev-start.bat or start containers manually with:',
    );
    lines.push(
      '       docker compose -f infra/docker-compose.dev.yml up -d',
    );
  }

  return lines.join('\n');
}

/**
 * Connects to PostgreSQL with retries and IPv4/IPv6 candidate fallbacks.
 */
export async function connectWithRetry(
  connectionStringOrConfig,
  { maxAttempts = 15, delayMs = 1000 } = {},
) {
  const { Pool } = pg;
  let connectionString =
    typeof connectionStringOrConfig === 'string'
      ? connectionStringOrConfig
      : connectionStringOrConfig.connectionString;

  const parsed = new URL(connectionString);
  const candidates = [connectionString];

  if (parsed.hostname === 'localhost') {
    const ipv4 = new URL(connectionString);
    ipv4.hostname = '127.0.0.1';
    candidates.push(ipv4.toString());
  } else if (parsed.hostname === '127.0.0.1') {
    const lh = new URL(connectionString);
    lh.hostname = 'localhost';
    candidates.push(lh.toString());
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const url of candidates) {
      try {
        const pool = new Pool({
          connectionString: url,
          connectionTimeoutMillis: 3000,
        });
        const client = await pool.connect();
        return { pool, client, url };
      } catch (err) {
        lastError = err;
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError;
}
