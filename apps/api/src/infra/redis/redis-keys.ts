import { isValidDatabaseName } from '@bodo/utils';

/**
 * Builds an isolated Redis cache/store key prefixed with the tenant database name.
 * Strictly guarantees multi-tenant data isolation in Redis.
 */
export function tenantKey(db: string, ...parts: string[]): string {
  if (!isValidDatabaseName(db)) {
    throw new Error(
      `[SECURITY ERROR] Cannot construct tenant Redis key: "${db}" is not a valid tenant database name.`,
    );
  }

  const sanitizedParts = parts.map((part) => {
    if (!part || typeof part !== 'string') {
      throw new Error(`[SECURITY ERROR] Invalid Redis key segment: "${part}"`);
    }
    return part.trim();
  });

  return `tenant:${db}:${sanitizedParts.join(':')}`;
}

/**
 * Builds an isolated queue name for background workers (e.g. BullMQ).
 */
export function tenantQueueName(db: string, queueName: string): string {
  if (!isValidDatabaseName(db)) {
    throw new Error(
      `[SECURITY ERROR] Cannot construct tenant queue name: "${db}" is not a valid tenant database name.`,
    );
  }

  if (!queueName || typeof queueName !== 'string' || queueName.includes(':')) {
    throw new Error(`[SECURITY ERROR] Invalid queue name: "${queueName}"`);
  }

  return `queue:${db}:${queueName.trim()}`;
}

/**
 * Explicit global key constructor for strictly documented cluster-wide keys
 * such as maintenance flags (e.g. "maint:<db>") or system locks.
 */
export function globalKey(category: string, ...parts: string[]): string {
  if (!category || typeof category !== 'string') {
    throw new Error(`[SECURITY ERROR] Invalid global key category: "${category}"`);
  }

  if (category === 'maint') {
    const db = parts[0];
    if (!db || !isValidDatabaseName(db)) {
      throw new Error(`[SECURITY ERROR] Invalid database name for maint global key: "${db}"`);
    }
    return `maint:${db}`;
  }

  return `global:${category}:${parts.join(':')}`;
}
