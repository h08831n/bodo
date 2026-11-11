#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Script to verify that:
 * 1) Production build output (apps/web/dist) contains ZERO unauthorized external URLs.
 * 2) Source files (apps/web/src, apps/web/index.html, packages/ui/src, packages/ui/.storybook)
 *    contain ZERO unauthorized external URLs or CDN imports.
 * 3) Storybook build output (packages/ui/storybook-static) contains NO external CDNs or Google font references
 *    (googleapis, gstatic, cdn, unpkg, jsdelivr).
 *
 * Strict offline / self-hosted compliance guard for bodo ERP.
 */

const WEB_DIST_DIR = path.resolve(process.cwd(), 'apps/web/dist');
const STORYBOOK_STATIC_DIR = path.resolve(process.cwd(), 'packages/ui/storybook-static');

const SOURCE_TARGETS = [
  path.resolve(process.cwd(), 'apps/web/src'),
  path.resolve(process.cwd(), 'apps/web/index.html'),
  path.resolve(process.cwd(), 'packages/ui/src'),
  path.resolve(process.cwd(), 'packages/ui/.storybook'),
];

// Documented strict allowlist for standard namespaces and library documentation/error URLs
const ALLOWLISTED_PREFIXES = [
  'http://www.w3.org/', // W3C XML / SVG namespaces
  'https://www.w3.org/',
  'https://react.dev/', // React 19 embedded error codes and documentation URLs
  'http://localhost',
  'http://127.0.0.1',
];

const FORBIDDEN_DOMAINS = [
  'googleapis.com',
  'gstatic.com',
  'jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
];

function isAllowlisted(url) {
  return ALLOWLISTED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function getAllFiles(dirOrFile, arrayOfFiles = [], filterExt = null) {
  if (!fs.existsSync(dirOrFile)) {
    return arrayOfFiles;
  }

  const stat = fs.statSync(dirOrFile);
  if (!stat.isDirectory()) {
    arrayOfFiles.push(dirOrFile);
    return arrayOfFiles;
  }

  const files = fs.readdirSync(dirOrFile, { withFileTypes: true });
  for (const file of files) {
    if (['node_modules', '.git', 'dist'].includes(file.name)) continue;
    const fullPath = path.join(dirOrFile, file.name);
    if (file.isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles, filterExt);
    } else {
      if (!filterExt || filterExt.some((ext) => file.name.endsWith(ext))) {
        arrayOfFiles.push(fullPath);
      }
    }
  }

  return arrayOfFiles;
}

const URL_REGEX = /https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:\/[^\s"'`<>()]*)?/g;

let totalViolations = 0;

// --- STEP 1: Scan apps/web/dist ---
console.log(`[check-no-external] (1/3) Scanning apps/web build output in ${WEB_DIST_DIR}...`);
if (!fs.existsSync(WEB_DIST_DIR)) {
  console.error(`[ERROR] apps/web/dist directory not found. Please run 'pnpm build' first.`);
  process.exit(1);
}

const distFiles = getAllFiles(WEB_DIST_DIR);
for (const filePath of distFiles) {
  const relativePath = path.relative(process.cwd(), filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  let match;
  while ((match = URL_REGEX.exec(content)) !== null) {
    const foundUrl = match[0];
    if (!isAllowlisted(foundUrl)) {
      console.error(`[VIOLATION] Unauthorized external URL in ${relativePath}: ${foundUrl}`);
      totalViolations++;
    }
  }
}
console.log(`  ✓ Checked ${distFiles.length} files in apps/web/dist.`);

// --- STEP 2: Scan Source Files ---
console.log(`[check-no-external] (2/3) Scanning frontend source files (html, css, ts, tsx)...`);
const sourceFiles = [];
for (const target of SOURCE_TARGETS) {
  getAllFiles(target, sourceFiles, ['.ts', '.tsx', '.html', '.css', '.js', '.mjs']);
}

for (const filePath of sourceFiles) {
  const relativePath = path.relative(process.cwd(), filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  let match;
  while ((match = URL_REGEX.exec(content)) !== null) {
    const foundUrl = match[0];
    if (!isAllowlisted(foundUrl)) {
      console.error(`[VIOLATION] Unauthorized external URL in source file ${relativePath}: ${foundUrl}`);
      totalViolations++;
    }
  }
}
console.log(`  ✓ Checked ${sourceFiles.length} source files.`);

// --- STEP 3: Scan Storybook static output ---
console.log(`[check-no-external] (3/3) Scanning Storybook static output in ${STORYBOOK_STATIC_DIR}...`);
if (fs.existsSync(STORYBOOK_STATIC_DIR)) {
  const storybookFiles = getAllFiles(STORYBOOK_STATIC_DIR);
  for (const filePath of storybookFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    for (const forbidden of FORBIDDEN_DOMAINS) {
      if (content.includes(forbidden)) {
        console.error(`[VIOLATION] Forbidden external domain '${forbidden}' found in Storybook artifact: ${relativePath}`);
        totalViolations++;
      }
    }
  }
  console.log(`  ✓ Checked ${storybookFiles.length} Storybook files.`);
} else {
  console.log(`  [NOTE] Storybook static directory not found (skip or run 'pnpm --filter @bodo/ui build-storybook').`);
}

if (totalViolations > 0) {
  console.error(`\n[FAIL] Found ${totalViolations} unauthorized external resource / domain violation(s).`);
  console.error(`bodo ERP enforces 100% self-hosted, offline-capable architecture with zero CDN or external font dependencies.`);
  process.exit(1);
}

console.log(`\n[PASS] All checks passed cleanly. Zero external dependencies / font violations detected.`);
process.exit(0);
