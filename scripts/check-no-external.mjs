#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Script to verify that the build output of apps/web does not contain
 * any unauthorized external URLs (e.g. Google Fonts, external CDNs, analytics).
 *
 * Strict offline / self-hosted compliance guard.
 */

const DIST_DIR = path.resolve(process.cwd(), 'apps/web/dist');

// Documented strict allowlist for standard namespaces and library documentation URLs
const ALLOWLISTED_PREFIXES = [
  'http://www.w3.org/', // W3C XML / SVG namespaces
  'https://www.w3.org/',
  'https://react.dev/', // React 19 embedded error codes and documentation URLs
];

function isAllowlisted(url) {
  return ALLOWLISTED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) {
    console.error(`[ERROR] Directory not found: ${dirPath}. Run build first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dirPath, file.name);
    if (file.isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  }

  return arrayOfFiles;
}

const URL_REGEX = /https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?(?:\/[^\s"'`<>()]*)?/g;

console.log(`[check-no-external] Scanning web build output in ${DIST_DIR}...`);

const files = getAllFiles(DIST_DIR);
let violationsCount = 0;

for (const filePath of files) {
  const relativePath = path.relative(process.cwd(), filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  let match;
  while ((match = URL_REGEX.exec(content)) !== null) {
    const foundUrl = match[0];
    if (!isAllowlisted(foundUrl)) {
      console.error(`[VIOLATION] Unauthorized external URL in ${relativePath}: ${foundUrl}`);
      violationsCount++;
    }
  }
}

if (violationsCount > 0) {
  console.error(`\n[FAIL] Found ${violationsCount} unauthorized external URL(s) in apps/web build artifacts.`);
  console.error(`Only local self-hosted assets are permitted in bodo ERP.`);
  process.exit(1);
}

console.log(`[PASS] Verified ${files.length} build files. Zero unauthorized external requests found.`);
process.exit(0);
