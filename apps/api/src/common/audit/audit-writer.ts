import { Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { newId } from '@bodo/utils';
import { TenantClientManager } from '../../infra/tenancy/tenant-client-manager';

export interface AuditWriteEntry {
  actorId?: string | null;
  source?: 'UI' | 'API' | 'IMPORT' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  requestId?: string | null;
  occurredAt?: Date;
}

@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name);

  constructor(private readonly tenantClientManager: TenantClientManager) {}

  /**
   * Hashes a sensitive identifier (such as a username typed during failed login)
   * to a short SHA-256 fingerprint so credentials accidentally typed into the username
   * field are never leaked in plaintext in logs or audit tables.
   */
  static hashIdentifier(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Asynchronously writes an immutable audit record to the tenant's partition of audit_logs.
   */
  async write(db: string, entry: AuditWriteEntry): Promise<void> {
    try {
      const client = await this.tenantClientManager.getClient(db);
      const id = newId();
      const occurredAt = entry.occurredAt || new Date();

      await client.auditLog.create({
        data: {
          id,
          occurredAt,
          actorId: entry.actorId || null,
          source: entry.source || 'API',
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId || null,
          changes: (entry.changes as Prisma.InputJsonValue) || undefined,
          meta: (entry.meta as Prisma.InputJsonValue) || undefined,
          requestId: entry.requestId || null,
        },
      });
    } catch (err) {
      // Audit failure should be logged but never crash the core application flow
      this.logger.error(
        `Failed to record audit log for action "${entry.action}" on db "${db}":`,
        err,
      );
    }
  }
}
