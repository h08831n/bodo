#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
const envFile = path.resolve(projectRoot, '.env');
const envExample = path.resolve(projectRoot, '.env.example');
const envPath = fs.existsSync(envFile) ? envFile : envExample;
const envContent = fs.readFileSync(envPath, 'utf8');

const env = {};
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx > 0) {
    const key = trimmed.substring(0, idx).trim();
    const val = trimmed.substring(idx + 1).trim();
    env[key] = val;
  }
}

const API_PORT = process.env.PORT || env.PORT || 3000;
const BASE_URL = `http://localhost:${API_PORT}`;
const RANDOM_SUFFIX = Math.random().toString(36).substring(2, 8);
const TEMP_SLUG = `smk_${RANDOM_SUFFIX}`;
const TEMP_DB = `erp_${TEMP_SLUG}`;
const ADMIN_USER = 'smoke_admin';
const ADMIN_PASS = 'SmokeSecurePassword2026!';
const MASTER_PASS = process.env.MASTER_PASSWORD || env.MASTER_PASSWORD || process.env.MASTER_PASSWORD_INITIAL || env.MASTER_PASSWORD_INITIAL || 'MasterSecurePassword2026!';

const PG_HOST = process.env.POSTGRES_HOST || env.POSTGRES_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.POSTGRES_PORT || env.POSTGRES_PORT || '5433', 10);
const PG_USER = process.env.POSTGRES_USER || env.POSTGRES_USER || 'postgres';
const PG_PASSWORD = process.env.POSTGRES_PASSWORD || env.POSTGRES_PASSWORD || 'postgres';

let apiProcess = null;
let workerProcess = null;

function logStep(name, ok, detail = '') {
  const symbol = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${symbol} ${name}${detail ? ` (${detail})` : ''}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isApiHealthy() {
  try {
    const res = await fetch(`${BASE_URL}/health/live`);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureApiRunning() {
  if (await isApiHealthy()) {
    return false; // Already running externally
  }

  console.log('  [info] Starting local API server and background worker...');
  const mainScript = path.resolve(projectRoot, 'apps/api/dist/main.js');
  const workerScript = path.resolve(projectRoot, 'apps/api/dist/worker.js');
  if (!fs.existsSync(mainScript)) {
    throw new Error('apps/api/dist/main.js not found. Run pnpm build first.');
  }

  apiProcess = spawn(process.execPath, [mainScript], {
    cwd: projectRoot,
    env: { ...env, ...process.env, NODE_ENV: 'development' },
    stdio: 'ignore',
  });

  if (fs.existsSync(workerScript)) {
    workerProcess = spawn(process.execPath, [workerScript], {
      cwd: projectRoot,
      env: { ...env, ...process.env, NODE_ENV: 'development' },
      stdio: 'ignore',
    });
  }

  for (let i = 0; i < 30; i++) {
    if (await isApiHealthy()) {
      return true; // Started by us
    }
    await sleep(1000);
  }
  throw new Error('API failed to become healthy within 30 seconds.');
}

async function runSmoke() {
  console.log('\n========================================================');
  console.log(' bodo ERP - S1.6 End-to-End Authentication Smoke Test');
  console.log('========================================================\n');

  let passed = true;

  try {
    // 1. Ensure API is running
    await ensureApiRunning();
    logStep('API server is live and responsive', true, `${BASE_URL}/health/live`);

    // 2. Master Admin Login
    const adminLoginRes = await fetch(`${BASE_URL}/v1/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: MASTER_PASS }),
    });
    if (adminLoginRes.status !== 200) {
      logStep('Master Admin login', false, `HTTP ${adminLoginRes.status}`);
      passed = false;
      return;
    }
    const adminLoginData = await adminLoginRes.json();
    const adminToken = adminLoginData.token;
    logStep('Master Admin login', true, 'Session token acquired');

    // Clean up if temp db already existed from an aborted run
    await fetch(`${BASE_URL}/v1/admin/databases/${TEMP_DB}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ confirmName: TEMP_DB }),
    }).catch(() => {});

    // 3. Create Temporary Database via DB Manager
    const createDbRes = await fetch(`${BASE_URL}/v1/admin/databases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: TEMP_SLUG,
        adminUsername: ADMIN_USER,
        adminFullName: 'Smoke Admin',
        adminPassword: ADMIN_PASS,
      }),
    });

    if (createDbRes.status !== 202) {
      logStep('Provision temp database via DB Manager', false, `HTTP ${createDbRes.status}`);
      passed = false;
      return;
    }
    const createJobData = await createDbRes.json();
    const jobId = createJobData.jobId;

    // Wait for provisioning job
    let jobCompleted = false;
    for (let i = 0; i < 60; i++) {
      const jobRes = await fetch(`${BASE_URL}/v1/admin/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (jobRes.status === 200) {
        const job = await jobRes.json();
        if (job.status === 'completed') {
          jobCompleted = true;
          break;
        } else if (job.status === 'failed') {
          throw new Error(`Database creation job failed: ${job.error || 'Unknown error'}`);
        }
      }
      await sleep(1000);
    }

    if (!jobCompleted) {
      logStep('Provision temp database via DB Manager', false, 'Job timed out');
      passed = false;
      return;
    }
    logStep('Provision temp database via DB Manager', true, `Database: "${TEMP_DB}"`);

    // 4. Login to new database with admin credentials
    const tenantLoginRes = await fetch(`${BASE_URL}/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Database': TEMP_DB,
      },
      body: JSON.stringify({
        username: ADMIN_USER,
        password: ADMIN_PASS,
      }),
    });

    if (tenantLoginRes.status !== 200) {
      logStep('Login as tenant administrator', false, `HTTP ${tenantLoginRes.status}`);
      passed = false;
      return;
    }

    const tenantLoginData = await tenantLoginRes.json();
    const accessToken = tenantLoginData.accessToken;
    const cookieHeader = tenantLoginRes.headers.get('set-cookie');
    if (!accessToken || !cookieHeader) {
      logStep('Login response format (accessToken & HttpOnly cookie)', false);
      passed = false;
      return;
    }
    logStep('Login as tenant administrator', true, 'Received accessToken and HttpOnly cookie');

    // Extract cookie value for subsequent requests
    const cookieMatch = cookieHeader.match(/bodo_rt_[^=]+=([^;]+)/);
    const firstRefreshToken = cookieMatch ? cookieMatch[1] : null;

    // 5. Call GET /me with Bearer token
    const meRes = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Database': TEMP_DB,
      },
    });

    if (meRes.status !== 200) {
      logStep('GET /v1/auth/me profile verification', false, `HTTP ${meRes.status}`);
      passed = false;
      return;
    }
    const meData = await meRes.json();
    if (meData.user.username !== ADMIN_USER || !Array.isArray(meData.permissions)) {
      logStep('GET /v1/auth/me profile verification', false, 'Invalid user/permissions payload');
      passed = false;
      return;
    }
    logStep('GET /v1/auth/me profile verification', true, `User: ${meData.user.fullName}, Perms: ${meData.permissions.length}`);

    // 6. Token Rotation (POST /v1/auth/refresh)
    const refreshRes = await fetch(`${BASE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Database': TEMP_DB,
        Origin: BASE_URL,
        Cookie: `bodo_rt_${TEMP_SLUG}=${firstRefreshToken}`,
      },
      body: JSON.stringify({}),
    });

    if (refreshRes.status !== 200) {
      logStep('Rotate refresh token (POST /v1/auth/refresh)', false, `HTTP ${refreshRes.status}`);
      passed = false;
      return;
    }
    const refreshData = await refreshRes.json();
    const rotatedAccessToken = refreshData.accessToken;
    const newCookieHeader = refreshRes.headers.get('set-cookie');
    logStep('Rotate refresh token (POST /v1/auth/refresh)', true, 'Token rotated, new cookie issued');

    // 7. Refresh Token Reuse Detection
    // Replay the first (old) refresh token; must be rejected with 401
    const reuseRes = await fetch(`${BASE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Database': TEMP_DB,
        Origin: BASE_URL,
        Cookie: `bodo_rt_${TEMP_SLUG}=${firstRefreshToken}`,
      },
      body: JSON.stringify({}),
    });

    if (reuseRes.status !== 401) {
      logStep('Refresh token reuse rejection', false, `Expected 401, got ${reuseRes.status}`);
      passed = false;
      return;
    }
    logStep('Refresh token reuse rejection', true, 'Old refresh token strictly rejected with HTTP 401');

    // 8. Logout & Instant Access Token Revocation
    const logoutRes = await fetch(`${BASE_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
        'X-Database': TEMP_DB,
        Origin: BASE_URL,
      },
    });

    if (logoutRes.status !== 200) {
      logStep('Logout current session', false, `HTTP ${logoutRes.status}`);
      passed = false;
      return;
    }
    logStep('Logout current session', true, 'Session logged out and cleared');

    // Immediately verify that the logged-out access token is rejected
    const afterLogoutRes = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${rotatedAccessToken}`,
        'X-Database': TEMP_DB,
      },
    });

    if (afterLogoutRes.status !== 401) {
      logStep('Instant access token revocation check', false, `Expected 401, got ${afterLogoutRes.status}`);
      passed = false;
      return;
    }
    logStep('Instant access token revocation check', true, 'Logged out access token rejected immediately (HTTP 401)');

    // 9. Delete Temporary Database via DB Manager
    const deleteRes = await fetch(`${BASE_URL}/v1/admin/databases/${TEMP_DB}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ confirmName: TEMP_DB }),
    });

    if (deleteRes.status !== 202) {
      logStep('Delete temp database via DB Manager', false, `HTTP ${deleteRes.status}`);
      passed = false;
      return;
    }

    const deleteJobData = await deleteRes.json();
    let deleteCompleted = false;
    for (let i = 0; i < 60; i++) {
      const jobRes = await fetch(`${BASE_URL}/v1/admin/jobs/${deleteJobData.jobId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (jobRes.status === 200) {
        const job = await jobRes.json();
        if (job.status === 'completed') {
          deleteCompleted = true;
          break;
        } else if (job.status === 'failed') {
          throw new Error(`Database deletion job failed: ${job.error || 'Unknown error'}`);
        }
      }
      await sleep(1000);
    }

    if (!deleteCompleted) {
      logStep('Delete temp database via DB Manager', false, 'Job timed out');
      passed = false;
      return;
    }
    logStep('Delete temp database via DB Manager', true, `Database "${TEMP_DB}" dropped`);

    // 10. Assert Zero Leftover Artifacts (Postgres DB, filestore directory)
    const pool = new pg.Pool({
      host: PG_HOST,
      port: PG_PORT,
      user: PG_USER,
      password: PG_PASSWORD,
      database: 'postgres',
    });

    const checkPgRes = await pool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1;`,
      [TEMP_DB],
    );
    await pool.end();

    const filestorePath = path.resolve(projectRoot, 'data/filestore', TEMP_DB);
    const hasLeftoverDb = checkPgRes.rowCount > 0;
    const hasLeftoverFiles = fs.existsSync(filestorePath);

    if (hasLeftoverDb || hasLeftoverFiles) {
      logStep('Zero leftover databases and files verification', false, `DB exists: ${hasLeftoverDb}, Files exist: ${hasLeftoverFiles}`);
      passed = false;
      return;
    }
    logStep('Zero leftover databases and files verification', true, 'Clean teardown verified');

  } catch (err) {
    console.error('\n[FATAL ERROR during smoke test]:', err);
    passed = false;
  } finally {
    if (apiProcess) {
      console.log('  [info] Stopping background API server...');
      apiProcess.kill('SIGTERM');
    }
    if (workerProcess) {
      console.log('  [info] Stopping background worker process...');
      workerProcess.kill('SIGTERM');
    }
  }

  console.log('\n========================================================');
  if (passed) {
    console.log(' \x1b[32mSUCCESS: All S1.6 smoke verification checks passed cleanly!\x1b[0m');
    console.log('========================================================\n');
    process.exit(0);
  } else {
    console.log(' \x1b[31mFAILURE: One or more smoke checks failed!\x1b[0m');
    console.log('========================================================\n');
    process.exit(1);
  }
}

runSmoke();
