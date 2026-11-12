#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

/**
 * Cross-platform script to safely initialize a fresh .env file from .env.example
 * with cryptographically secure random credentials.
 *
 * Rule: NEVER overwrite an existing .env file.
 */

const projectRoot = process.cwd();
const envPath = path.resolve(projectRoot, '.env');
const examplePath = path.resolve(projectRoot, '.env.example');

if (fs.existsSync(envPath)) {
  console.log('[init-env] .env file already exists. Preserving existing configuration.');
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error(`[init-env] [ERROR] .env.example not found at ${examplePath}`);
  process.exit(1);
}

console.log('[init-env] Generating fresh .env with cryptographically secure credentials...');

let content = fs.readFileSync(examplePath, 'utf8');

// Generate secure random values
const jwtSecret = crypto.randomBytes(32).toString('hex');
const encryptionKey = crypto.randomBytes(32).toString('hex'); // 32 bytes hex = 64 hex chars
const redisPassword = crypto.randomBytes(16).toString('hex');
const postgresPassword = crypto.randomBytes(16).toString('hex');
const masterPassword = `Bodo_${crypto.randomBytes(9).toString('base64url')}!2026`;

// Replace placeholder secrets
content = content.replace(/POSTGRES_PASSWORD=postgres/g, `POSTGRES_PASSWORD=${postgresPassword}`);
content = content.replace(/REDIS_PASSWORD=redispassword/g, `REDIS_PASSWORD=${redisPassword}`);
content = content.replace(/MASTER_PASSWORD_INITIAL=MasterSecurePassword2026!/g, `MASTER_PASSWORD_INITIAL=${masterPassword}`);
content = content.replace(/JWT_SECRET=super_secret_jwt_key_bodo_2026_min_16_chars/g, `JWT_SECRET=${jwtSecret}`);
content = content.replace(/ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/g, `ENCRYPTION_KEY=${encryptionKey}`);

// Update connection URLs to reflect generated passwords
content = content.replace(
  /DATABASE_URL=postgresql:\/\/postgres:postgres@localhost:5433\/postgres/g,
  `DATABASE_URL=postgresql://postgres:${postgresPassword}@localhost:5433/postgres`
);
content = content.replace(
  /REDIS_URL=redis:\/\/:redispassword@localhost:6379/g,
  `REDIS_URL=redis://:${redisPassword}@localhost:6379`
);

fs.writeFileSync(envPath, content, 'utf8');

console.log('================================================================');
console.log(' [init-env] SUCCESS: .env file created with secure credentials!');
console.log('----------------------------------------------------------------');
console.log(` Initial Master Password : ${masterPassword}`);
console.log(' Location                 : .env (in project root)');
console.log(' Keep this password safe. It is required for /v1/admin endpoints.');
console.log('================================================================');
process.exit(0);
