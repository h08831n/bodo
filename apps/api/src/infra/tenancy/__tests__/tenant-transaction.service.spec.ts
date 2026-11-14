import { TenantTransactionService } from '../tenant-transaction.service';
import { runWithTenant, getTenantContext } from '../tenant-context';
import type { PrismaClient } from '@prisma/client';

describe('TenantTransactionService', () => {
  let transactionService: TenantTransactionService;
  let mockPrismaClient: { $transaction: jest.Mock };

  beforeEach(() => {
    transactionService = new TenantTransactionService();
    mockPrismaClient = {
      $transaction: jest.fn(
        async (
          callback: (tx: unknown) => Promise<unknown>,
          _options?: { timeout?: number; maxWait?: number },
        ) => {
          const mockTx = { isTx: true };
          return callback(mockTx);
        },
      ),
    };
  });

  it('throws error when called outside active tenant context', async () => {
    await expect(transactionService.run(async () => 'test')).rejects.toThrow(
      /Cannot execute transaction outside an active tenant context/,
    );
  });

  it('opens a new transaction when no transaction is active', async () => {
    await runWithTenant(
      { db: 'tenant_db_1', client: mockPrismaClient as unknown as PrismaClient },
      async () => {
        const result = await transactionService.run(async (tx) => {
          expect((tx as { isTx?: boolean }).isTx).toBe(true);
          const currentContext = getTenantContext();
          expect(currentContext?.tx).toBeDefined();
          return 'tx_result';
        });

        expect(result).toBe('tx_result');
        expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('joins existing active transaction (nested join) without calling $transaction again', async () => {
    await runWithTenant(
      { db: 'tenant_db_1', client: mockPrismaClient as unknown as PrismaClient },
      async () => {
        await transactionService.run(async (outerTx) => {
          expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1);

          // Nested run
          const innerResult = await transactionService.run(async (innerTx) => {
            expect(innerTx).toBe(outerTx);
            return 'inner_ok';
          });

          expect(innerResult).toBe('inner_ok');
          expect(mockPrismaClient.$transaction).toHaveBeenCalledTimes(1); // Not called twice!
        });
      },
    );
  });

  it('executes afterCommit hooks in order after transaction commits', async () => {
    const executedHooks: number[] = [];

    await runWithTenant(
      { db: 'tenant_db_1', client: mockPrismaClient as unknown as PrismaClient },
      async () => {
        await transactionService.run(async () => {
          transactionService.afterCommit(() => {
            executedHooks.push(1);
          });
          transactionService.afterCommit(async () => {
            executedHooks.push(2);
          });
        });

        expect(executedHooks).toEqual([1, 2]);
      },
    );
  });

  it('does not execute afterCommit hooks if transaction fails and rolls back', async () => {
    const executedHooks: number[] = [];

    mockPrismaClient.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const mockTx = { isTx: true };
      await callback(mockTx);
      throw new Error('Transaction commit failed');
    });

    await runWithTenant(
      { db: 'tenant_db_1', client: mockPrismaClient as unknown as PrismaClient },
      async () => {
        await expect(
          transactionService.run(async () => {
            transactionService.afterCommit(() => {
              executedHooks.push(1);
            });
          }),
        ).rejects.toThrow('Transaction commit failed');

        expect(executedHooks).toEqual([]);
      },
    );
  });
});
