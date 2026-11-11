/**
 * Utility helper functions for bodo ERP.
 * Full Jalali, Iranian validators, and Money utils will be implemented in Step S1.10.
 */

export function slugifyDatabaseName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function formatDatabaseIdentifier(slug: string): string {
  return `erp_${slugifyDatabaseName(slug)}`;
}
