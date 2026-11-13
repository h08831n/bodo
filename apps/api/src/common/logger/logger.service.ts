import { Injectable, LoggerService as INestLoggerService } from '@nestjs/common';
import pino from 'pino';
import { tryGetCurrentDb } from '../../infra/tenancy/tenant-context';

@Injectable()
export class LoggerService implements INestLoggerService {
  private pinoLogger: pino.Logger;

  constructor() {
    const isDev = process.env.NODE_ENV !== 'production';
    this.pinoLogger = pino({
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      mixin: () => ({
        db: tryGetCurrentDb(),
      }),
      transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    });
  }

  log(message: string, context?: string, extra?: Record<string, unknown>) {
    this.pinoLogger.info({ context, ...extra }, message);
  }

  error(message: string, trace?: string, context?: string, extra?: Record<string, unknown>) {
    this.pinoLogger.error({ context, trace, ...extra }, message);
  }

  warn(message: string, context?: string, extra?: Record<string, unknown>) {
    this.pinoLogger.warn({ context, ...extra }, message);
  }

  debug(message: string, context?: string, extra?: Record<string, unknown>) {
    this.pinoLogger.debug({ context, ...extra }, message);
  }

  verbose(message: string, context?: string, extra?: Record<string, unknown>) {
    this.pinoLogger.trace({ context, ...extra }, message);
  }

  child(bindings: Record<string, unknown>): pino.Logger {
    return this.pinoLogger.child(bindings);
  }
}
