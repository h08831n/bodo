import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { getTenantContext, runWithTenant } from './tenant-context';
import { LoggerService } from '../../common/logger/logger.service';

export interface TransactionOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 5000;
const SLOW_TRANSACTION_THRESHOLD_MS = 5000;

@Injectable()
export class TenantTransactionService {
  constructor(@Optional() private readonly logger?: LoggerService) {}

  /**
   * Executes a callback within a database transaction.
   * If a transaction is already active in the current TenantContext, joins it (nested join).
   * Otherwise opens a new transaction via PrismaClient.$transaction.
   */
  async run<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const context = getTenantContext();
    if (!context) {
      throw new Error(
        'Cannot execute transaction outside an active tenant context. Ensure runWithTenant or TenantMiddleware is present.',
      );
    }

    // Join existing transaction if active
    if (context.tx) {
      return fn(context.tx);
    }

    const client = context.client;
    if (!client) {
      throw new Error(
        `Active tenant context found for '${context.db}', but no leased PrismaClient is available.`,
      );
    }

    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxWait = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const startTime = Date.now();
    const hooks: Array<() => Promise<void> | void> = [];

    let result: T;

    try {
      result = await client.$transaction(
        async (tx) => {
          return runWithTenant(
            {
              ...context,
              tx,
              afterCommitHooks: hooks,
            },
            async () => {
              return fn(tx);
            },
          );
        },
        {
          timeout,
          maxWait,
        },
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.logger?.debug?.(
        `Transaction rolled back for '${context.db}' after ${durationMs}ms`,
        'TenantTransactionService',
      );
      throw err;
    }

    const durationMs = Date.now() - startTime;
    if (durationMs > SLOW_TRANSACTION_THRESHOLD_MS) {
      this.logger?.warn(
        `Slow transaction detected: db='${context.db}', duration=${durationMs}ms (threshold=${SLOW_TRANSACTION_THRESHOLD_MS}ms)`,
        'TenantTransactionService',
      );
    }

    // Execute afterCommit hooks sequentially
    if (hooks.length > 0) {
      for (const hook of hooks) {
        try {
          await hook();
        } catch (hookErr) {
          const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
          this.logger?.error(
            `afterCommit hook execution failed: ${msg}`,
            hookErr instanceof Error ? hookErr.stack : undefined,
            'TenantTransactionService',
          );
        }
      }
    }

    return result;
  }

  /**
   * Forces a new transaction to be created, isolating it from any currently active transaction.
   */
  async runInNewTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const context = getTenantContext();
    if (!context) {
      throw new Error(
        'Cannot execute transaction outside an active tenant context. Ensure runWithTenant or TenantMiddleware is present.',
      );
    }

    // Temporarily mask existing tx
    const isolatedContext = {
      ...context,
      tx: undefined,
      afterCommitHooks: undefined,
    };

    return runWithTenant(isolatedContext, async () => {
      return this.run(fn, options);
    });
  }

  /**
   * Registers a non-critical side effect (e.g. cache eviction, push notification)
   * to be executed only after the current transaction commits successfully.
   * If called outside a transaction, executes immediately.
   */
  afterCommit(fn: () => Promise<void> | void): void {
    const context = getTenantContext();
    if (context?.afterCommitHooks) {
      context.afterCommitHooks.push(fn);
    } else {
      // Outside transaction: execute immediately with error logging
      Promise.resolve()
        .then(() => fn())
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger?.error(
            `afterCommit direct execution failed: ${msg}`,
            undefined,
            'TenantTransactionService',
          );
        });
    }
  }
}
