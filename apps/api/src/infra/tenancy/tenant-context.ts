import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';

export interface TenantContextPayload {
  db: string;
  requestId?: string;
  userId?: string;
  client?: PrismaClient;
}

const tenantStorage = new AsyncLocalStorage<TenantContextPayload>();

/**
 * Runs an asynchronous or synchronous function within the scope of a tenant context.
 */
export async function runWithTenant<T>(
  payloadOrDb: TenantContextPayload | string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const payload: TenantContextPayload =
    typeof payloadOrDb === 'string' ? { db: payloadOrDb } : payloadOrDb;

  return tenantStorage.run(payload, fn);
}

/**
 * Returns the current tenant database name.
 * @throws Error if called outside a valid tenant scope.
 */
export function getCurrentDb(): string {
  const store = tenantStorage.getStore();
  if (!store || !store.db) {
    throw new Error(
      'No active tenant context found. Access to tenant database must be wrapped in runWithTenant.',
    );
  }
  return store.db;
}

/**
 * Returns the current tenant database name if present, or null if outside tenant scope.
 */
export function tryGetCurrentDb(): string | null {
  const store = tenantStorage.getStore();
  return store?.db ?? null;
}

/**
 * Returns the entire current tenant context payload, or null if outside tenant scope.
 */
export function getTenantContext(): TenantContextPayload | null {
  return tenantStorage.getStore() ?? null;
}

/**
 * Returns the active PrismaClient attached to the current context, if any.
 */
export function getCurrentTenantClient(): PrismaClient | null {
  const store = tenantStorage.getStore();
  return store?.client ?? null;
}
