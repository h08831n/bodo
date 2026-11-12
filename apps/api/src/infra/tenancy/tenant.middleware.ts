import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { DatabaseRegistryService } from './database-registry.service';
import { TenantClientManager } from './tenant-client-manager';
import { HostResolver, HeaderResolver, TenantResolver } from './tenant-resolver';
import { DomainMap } from '../config-store/domain-map';
import { DatabaseRequiredError } from './errors';
import { runWithTenant } from './tenant-context';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly resolvers: TenantResolver[];

  // Paths exempt from tenant database context
  private readonly exemptPaths = ['/health', '/health/live', '/health/ready', '/favicon.ico'];

  constructor(
    private readonly databaseRegistry: DatabaseRegistryService,
    private readonly clientManager: TenantClientManager,
    domainMap: DomainMap,
  ) {
    this.resolvers = [new HostResolver(domainMap), new HeaderResolver()];
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const originalUrl = req.originalUrl || req.url || '';
    const pathname = originalUrl.split('?')[0] || '';

    // Check path exemption
    if (
      this.exemptPaths.includes(pathname) ||
      pathname.startsWith('/health/') ||
      pathname.startsWith('/v1/admin/') ||
      pathname.startsWith('/v1/public/')
    ) {
      return next();
    }

    try {
      // 1. Resolve database identifier through configured resolvers
      let resolvedDb: string | null = null;

      for (const resolver of this.resolvers) {
        const candidate = await resolver.resolve(req);
        if (candidate) {
          resolvedDb = candidate;
          break;
        }
      }

      if (!resolvedDb) {
        throw new DatabaseRequiredError();
      }

      // 2. Validate database name and availability
      await this.databaseRegistry.assertUsable(resolvedDb);

      // 3. Acquire execution lease on database connection client
      const { client, release } = await this.clientManager.acquireLease(resolvedDb);

      let released = false;
      let safetyTimer: NodeJS.Timeout | null = null;

      const doRelease = async () => {
        if (released) return;
        released = true;
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
        await release().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Error releasing lease on "${resolvedDb}": ${msg}`);
        });
      };

      // 4. Hook lease release to response completion or early client disconnect
      res.once('finish', doRelease);
      res.once('close', doRelease);

      // 5. Safety watchdog timer (60s) to prevent leaks if connection drops without finish/close
      safetyTimer = setTimeout(() => {
        doRelease();
      }, 60_000);

      // 6. Execute remaining pipeline within AsyncLocalStorage tenant scope
      const requestId =
        (req.headers['x-request-id'] as string) || (req as Request & { id?: string }).id;

      await runWithTenant(
        {
          db: resolvedDb,
          requestId,
          client,
        },
        () => next(),
      );
    } catch (err) {
      next(err);
    }
  }
}
