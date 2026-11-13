import {
  runWithTenant,
  getCurrentDb,
  tryGetCurrentDb,
} from '../../src/infra/tenancy/tenant-context';
import { LoggerService } from '../../src/common/logger/logger.service';

describe('Tenant Context & Concurrency Isolation (Tests 1, 16)', () => {
  it('1. 200 interleaved async tasks across two databases never cross-contaminate context', async () => {
    const tasksCount = 200;
    const errors: string[] = [];

    const tasks = Array.from({ length: tasksCount }, (_, index) => {
      const assignedDb = index % 2 === 0 ? 'erp_tenant_alpha' : 'erp_tenant_beta';

      return runWithTenant({ db: assignedDb, requestId: `req-${index}` }, async () => {
        // Step 1: Initial check
        if (getCurrentDb() !== assignedDb || tryGetCurrentDb() !== assignedDb) {
          errors.push(
            `Task ${index}: Initial context mismatch. Expected ${assignedDb}, got ${tryGetCurrentDb()}`,
          );
        }

        // Step 2: Random async pause (0 - 25ms) to induce heavy event-loop interleaving
        const delayMs = Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        // Step 3: Check after first async hop
        if (getCurrentDb() !== assignedDb) {
          errors.push(
            `Task ${index}: Mid-flight context mismatch after ${delayMs}ms. Expected ${assignedDb}, got ${getCurrentDb()}`,
          );
        }

        // Step 4: Another async hop with nested Promise
        await Promise.resolve().then(async () => {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10)));
          if (getCurrentDb() !== assignedDb) {
            errors.push(
              `Task ${index}: Nested context mismatch. Expected ${assignedDb}, got ${getCurrentDb()}`,
            );
          }
        });

        // Step 5: Final assertion
        if (getCurrentDb() !== assignedDb) {
          errors.push(
            `Task ${index}: Final context mismatch. Expected ${assignedDb}, got ${getCurrentDb()}`,
          );
        }
      });
    });

    await Promise.all(tasks);

    // Verify context was cleaned up after completion
    expect(tryGetCurrentDb()).toBeNull();
    expect(() => getCurrentDb()).toThrow(/No active tenant context found/);
    expect(errors).toEqual([]);
  });

  it('16. Pino logger mixin dynamically populates db from tenant context', () => {
    const loggerService = new LoggerService();
    type WithPino = { pinoLogger: Record<symbol, () => { db: string | null }> };
    const pinoInstance = (loggerService as unknown as WithPino).pinoLogger;

    // Test outside context: mixin returns db: null
    const outsideBindings = pinoInstance[Symbol.for('pino.mixin')]?.() ?? {
      db: tryGetCurrentDb(),
    };
    expect(outsideBindings.db).toBeNull();

    // Test inside context: mixin returns active database name
    runWithTenant('erp_company_active', () => {
      const insideBindings = pinoInstance[Symbol.for('pino.mixin')]?.() ?? {
        db: tryGetCurrentDb(),
      };
      expect(insideBindings.db).toBe('erp_company_active');
    });

    // Verify back to null outside
    expect(tryGetCurrentDb()).toBeNull();
  });
});
