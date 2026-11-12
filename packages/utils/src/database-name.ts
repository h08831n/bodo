export const RESERVED_DATABASE_NAMES = new Set([
  'postgres',
  'template0',
  'template1',
  'defaultdb',
  'rdsadmin',
]);

const DB_NAME_REGEX = /^erp_[a-z0-9_]{3,40}$/;
const SLUG_REGEX = /^[a-z0-9_]{3,40}$/;

/**
 * Validates that a database name conforms strictly to tenant database naming rules:
 * - Must start with 'erp_'
 * - Must be followed by 3 to 40 characters of [a-z0-9_]
 * - Must not start with 'erp_tmp_' (provisioning temporary databases)
 * - Must not contain consecutive underscores ('__')
 * - Must not end with an underscore ('_')
 * - Must not match PostgreSQL reserved database names
 */
export function isValidDatabaseName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name.startsWith('erp_tmp_')) return false;
  if (name.includes('__')) return false;
  if (name.endsWith('_')) return false;
  if (RESERVED_DATABASE_NAMES.has(name.toLowerCase())) return false;
  return DB_NAME_REGEX.test(name);
}

/**
 * Validates that a company slug conforms to slug rules (3-40 chars, [a-z0-9_], no '__', no trailing '_').
 */
export function isValidCompanySlug(slug: unknown): boolean {
  if (typeof slug !== 'string') return false;
  if (slug.startsWith('tmp_')) return false;
  if (slug.includes('__')) return false;
  if (slug.endsWith('_')) return false;
  return SLUG_REGEX.test(slug);
}

/**
 * Converts a company slug to its canonical database name.
 * @throws Error if slug is invalid.
 */
export function slugToDatabaseName(slug: string): string {
  const normalized = (slug || '').trim().toLowerCase();
  if (!isValidCompanySlug(normalized)) {
    throw new Error(`Invalid company slug: "${slug}"`);
  }
  return `erp_${normalized}`;
}

/**
 * Extracts company slug from a valid tenant database name.
 * @throws Error if database name is invalid.
 */
export function databaseNameToSlug(databaseName: string): string {
  if (!isValidDatabaseName(databaseName)) {
    throw new Error(`Invalid tenant database name: "${databaseName}"`);
  }
  return databaseName.slice(4); // Remove 'erp_'
}
