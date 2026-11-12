import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DatabaseRegistryService } from './database-registry.service';
import { MaintenanceService } from './maintenance.service';
import { TenantClientManager } from './tenant-client-manager';
import { runWithTenant } from './tenant-context';

export interface TenantRunnerOptions {
  concurrency?: number;
  timeoutMs?: number;
}

export interface TenantRunnerResult<T> {
  db: string;
  ok: boolean;
  result?: T;
  error?: Error;
  durationMs: number;
  skipped?: boolean;
}

@Injectable()
export class TenantRunnerService {
  private readonly logger = new Logger(TenantRunnerService.name);

  constructor(
    private readonly databaseRegistry: DatabaseRegistryService,
    private readonly maintenanceService: MaintenanceService,
    private readonly clientManager: TenantClientManager,
  ) {}

  /**
   * Executes a task for each active tenant database with concurrency control and complete error isolation.
   */
  async forEachActiveDatabase<T>(
    fn: (db: string, client: PrismaClient) => Promise<T>,
    options?: TenantRunnerOptions,
  ): Promise<Array<TenantRunnerResult<T>>> {
    const concurrency = Math.max(1, options?.concurrency ?? 3);
    const timeoutMs = options?.timeoutMs;

    const activeDbs = await this.databaseRegistry.listActive();
    const results: Array<TenantRunnerResult<T>> = [];

    // Worker queue with concurrency limit
    let currentIndex = 0;

    const worker = async (): Promise<void> => {
      while (currentIndex < activeDbs.length) {
        const index = currentIndex++;
        const db = activeDbs[index];
        if (!db) continue;

        const start = Date.now();
        try {
          // Check maintenance mode
          const maint = await this.maintenanceService.get(db);
          if (maint.inMaintenance) {
            results.push({
              db,
              ok: true,
              skipped: true,
              durationMs: Date.now() - start,
            });
            continue;
          }

          // Execute with lease and AsyncLocalStorage context
          const result = await this.clientManager.lease<T>(db, async (client) => {
            return await runWithTenant({ db, client }, async () => {
              if (timeoutMs && timeoutMs > 0) {
                return await Promise.race([
                  fn(db, client),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () =>
                        reject(new Error(`Task on tenant "${db}" timed out after ${timeoutMs}ms`)),
                      timeoutMs,
                    ),
                  ),
                ]);
              }
              return await fn(db, client);
            });
          });

          results.push({
            db,
            ok: true,
            result,
            durationMs: Date.now() - start,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Error in tenant runner task for database "${db}": ${msg}`);
          results.push({
            db,
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
            durationMs: Date.now() - start,
          });
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return results;
  }
}
