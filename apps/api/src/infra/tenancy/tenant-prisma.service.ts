import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { getTenantContext, tryGetCurrentDb } from './tenant-context';

@Injectable()
export class TenantPrismaService {
  /**
   * Returns the PrismaClient or active TransactionClient instance attached to the current execution context.
   * If a transaction is active in the current TenantContext, operations automatically participate in it.
   * @throws Error if called outside a valid tenant scope.
   */
  get client(): PrismaClient {
    const context = getTenantContext();
    if (context?.tx) {
      return context.tx as unknown as PrismaClient;
    }
    const client = context?.client;
    if (!client) {
      const currentDb = tryGetCurrentDb();
      if (!currentDb) {
        throw new Error(
          'No active tenant context found. All tenant database operations must be wrapped within a tenant context (TenantContext / runWithTenant).',
        );
      }
      throw new Error(
        `Tenant context active for database "${currentDb}", but no leased Prisma client is attached to the current context.`,
      );
    }
    return client;
  }
}
