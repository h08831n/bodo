import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { getCurrentTenantClient, tryGetCurrentDb } from './tenant-context';

@Injectable()
export class TenantPrismaService {
  /**
   * Returns the PrismaClient instance attached to the current execution context.
   * @throws Error if called outside a valid tenant scope.
   */
  get client(): PrismaClient {
    const client = getCurrentTenantClient();
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
