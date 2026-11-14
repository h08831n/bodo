import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../logger/logger.service';
import { tryGetCurrentDb } from '../../infra/tenancy/tenant-context';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const db = tryGetCurrentDb() || 'none';
      const requestId = req.requestId || 'unknown';
      const client = (req.headers['x-client'] as string) || req.headers['user-agent'] || 'unknown';
      const statusCode = res.statusCode;

      // Skip spamming logs for health endpoints in test/dev if desired, or log debug/info
      const isHealth = req.originalUrl.startsWith('/health');
      const message = `${req.method} ${req.originalUrl} ${statusCode} - ${durationMs}ms`;

      if (isHealth && statusCode === 200) {
        this.logger.debug(message, 'HTTP', { db, requestId, client, durationMs, statusCode });
      } else {
        this.logger.log(message, 'HTTP', { db, requestId, client, durationMs, statusCode });
      }
    });

    next();
  }
}
