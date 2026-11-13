/**
 * Shared utility functions for bodo ERP.
 * Detailed Jalali, Iranian validators, and Money utils will be implemented in Step S1.10.
 */

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

export { newId } from './uuid.js';
export {
  RESERVED_DATABASE_NAMES,
  isValidDatabaseName,
  isValidCompanySlug,
  slugToDatabaseName,
  databaseNameToSlug,
} from './database-name.js';
export { buildDatabaseUrl, type DatabaseConnectionOptions } from './database-url.js';
