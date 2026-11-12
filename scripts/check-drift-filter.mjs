/**
 * check-drift-filter.mjs
 * Filters expected partition child tables and helper routines from Prisma diff output.
 */

// Strict anchored regex for allowed partitioned tables
export const ALLOWED_PARTITION_TABLE_REGEX = /^(audit_logs|timeline_events)_(p\d{6}|default)$/;

// Strict anchored regex for allowed indexes on partition tables
export const ALLOWED_PARTITION_INDEX_REGEX = /^(audit_logs|timeline_events)_(p\d{6}|default)_.+$/;

// Allowed functions and extensions
export const ALLOWED_FUNCTION_REGEX = /^ensure_monthly_partitions(\(.*\))?$/;
export const ALLOWED_EXTENSION_REGEX = /^(pg_trgm|unaccent)$/;

/**
 * Strips quotes and schema qualification.
 * e.g. '"public"."audit_logs_p202611"' -> 'audit_logs_p202611'
 */
export function sanitizeIdentifier(identifier) {
  if (!identifier) return '';
  return identifier
    .trim()
    .replace(/"/g, '')
    .replace(/^public\./, '')
    .replace(/;$/, '');
}

/**
 * Checks whether an identifier is an allowed noise object (partition child table, partition index, etc.)
 */
export function isAllowedNoiseIdentifier(rawIdentifier) {
  const name = sanitizeIdentifier(rawIdentifier);
  if (!name) return false;

  if (ALLOWED_PARTITION_TABLE_REGEX.test(name)) return true;
  if (ALLOWED_PARTITION_INDEX_REGEX.test(name)) return true;
  if (ALLOWED_FUNCTION_REGEX.test(name)) return true;
  if (ALLOWED_EXTENSION_REGEX.test(name)) return true;

  return false;
}

/**
 * Filters diff output (supporting both SQL script diff and human-readable summary).
 * Returns { isClean: boolean, unexpectedDiffs: string[] }
 */
export function filterDrift(diffOutput) {
  if (!diffOutput || typeof diffOutput !== 'string') {
    return { isClean: true, unexpectedDiffs: [] };
  }

  const trimmed = diffOutput.trim();
  if (!trimmed || trimmed === '-- This is an empty migration.' || trimmed.includes('No difference detected')) {
    return { isClean: true, unexpectedDiffs: [] };
  }

  const unexpectedDiffs = [];

  // Check if it's SQL script format or human-readable format
  const lines = trimmed.split('\n');

  // If output contains SQL DDL statements (e.g. DROP TABLE, ALTER TABLE, CREATE TABLE)
  const hasSql = /\b(DROP|CREATE|ALTER|TRUNCATE)\b/i.test(trimmed);

  if (hasSql) {
    // Process SQL statements separated by semicolon
    const statements = trimmed
      .split(';')
      .map((s) => s.trim())
      .filter((s) => {
        // Strip out pure comment blocks
        const withoutComments = s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim();
        return withoutComments.length > 0;
      });

    for (const stmt of statements) {
      const cleanStmt = stmt
        .split('\n')
        .map((l) => (l.trim().startsWith('--') ? '' : l))
        .join(' ')
        .trim();

      // Check DROP TABLE [IF EXISTS] <identifier>
      const dropTableMatch = cleanStmt.match(/^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+("[^"]+"|[a-zA-Z0-9_."]+)/i);
      if (dropTableMatch) {
        const tableId = dropTableMatch[1];
        if (isAllowedNoiseIdentifier(tableId)) {
          // Allowed partition table drop
          continue;
        }
      }

      // Check DROP INDEX [IF EXISTS] <identifier>
      const dropIndexMatch = cleanStmt.match(/^DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+("[^"]+"|[a-zA-Z0-9_."]+)/i);
      if (dropIndexMatch) {
        const indexId = dropIndexMatch[1];
        if (isAllowedNoiseIdentifier(indexId)) {
          // Allowed partition index drop
          continue;
        }
      }

      // Check DROP FUNCTION [IF EXISTS] <identifier>
      const dropFuncMatch = cleanStmt.match(/^DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?\s+("[^"]+"|[a-zA-Z0-9_."]+)/i);
      if (dropFuncMatch) {
        const funcId = dropFuncMatch[1];
        if (isAllowedNoiseIdentifier(funcId)) {
          // Allowed function drop
          continue;
        }
      }

      // Check DROP EXTENSION [IF EXISTS] <identifier>
      const dropExtMatch = cleanStmt.match(/^DROP\s+EXTENSION(?:\s+IF\s+EXISTS)?\s+("[^"]+"|[a-zA-Z0-9_."]+)/i);
      if (dropExtMatch) {
        const extId = dropExtMatch[1];
        if (isAllowedNoiseIdentifier(extId)) {
          continue;
        }
      }

      // If it reaches here, this SQL statement represents real drift
      unexpectedDiffs.push(stmt);
    }
  } else {
    // Process human readable lines (Prisma human readable summary)
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Check for human-readable dropped table: [-] Dropped table "..." or Dropped table ...
      const droppedTableMatch = trimmedLine.match(/(?:\[-\]\s+)?(?:Dropped|Removed)\s+table\s+["']?([^"'\s]+)["']?/i);
      if (droppedTableMatch && isAllowedNoiseIdentifier(droppedTableMatch[1])) {
        continue;
      }

      // Check for human-readable dropped index
      const droppedIndexMatch = trimmedLine.match(/(?:\[-\]\s+)?(?:Dropped|Removed)\s+index\s+["']?([^"'\s]+)["']?/i);
      if (droppedIndexMatch && isAllowedNoiseIdentifier(droppedIndexMatch[1])) {
        continue;
      }

      // Anything else is unexpected drift
      unexpectedDiffs.push(trimmedLine);
    }
  }

  return {
    isClean: unexpectedDiffs.length === 0,
    unexpectedDiffs,
  };
}
