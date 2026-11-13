import * as path from 'path';
import { isValidDatabaseName } from '@bodo/utils';
import { getEnv } from '../../config/env.config';

/**
 * Constructs a safe, normalized absolute path within a tenant's designated filestore directory.
 * Defends rigorously against directory traversal attacks:
 * - Validates database name strictly
 * - Detects ../ and ..\ traversal
 * - Detects URL-encoded traversals (%2e%2e, %2f, %5c)
 * - Detects absolute paths and drive letters
 * - Verifies that the resolved path is strictly contained within FILESTORE_DIR/<db>
 */
export function filestorePath(db: string, ...parts: string[]): string {
  if (!isValidDatabaseName(db)) {
    throw new Error(`[SECURITY ERROR] Invalid tenant database name for filestore: "${db}"`);
  }

  const baseFilestore = path.resolve(getEnv().FILESTORE_DIR);
  const tenantBase = path.resolve(baseFilestore, db);

  for (const part of parts) {
    if (typeof part !== 'string' || !part) {
      throw new Error(`[SECURITY ERROR] Invalid filestore path segment: "${part}"`);
    }

    // Check URL-encoded attacks
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new Error(`[SECURITY ERROR] Malformed encoded path segment: "${part}"`);
    }

    // Check for traversal tokens, absolute path indicators, and windows drive letters
    if (
      decoded.includes('..') ||
      decoded.startsWith('/') ||
      decoded.startsWith('\\') ||
      /^[a-zA-Z]:/.test(decoded) ||
      part.includes('..') ||
      part.includes('%2e') ||
      part.includes('%2E')
    ) {
      throw new Error(
        `[SECURITY ERROR] Directory traversal attempt detected in path segment: "${part}"`,
      );
    }
  }

  const resolved = path.resolve(tenantBase, ...parts);

  // Path must be inside tenantBase
  const tenantBaseWithSep = tenantBase.endsWith(path.sep) ? tenantBase : `${tenantBase}${path.sep}`;

  if (resolved !== tenantBase && !resolved.startsWith(tenantBaseWithSep)) {
    throw new Error(
      `[SECURITY ERROR] Resolved path "${resolved}" escapes tenant directory "${tenantBase}".`,
    );
  }

  return resolved;
}
