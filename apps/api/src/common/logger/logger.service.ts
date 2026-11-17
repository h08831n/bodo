import { Injectable, LoggerService as INestLoggerService } from '@nestjs/common';
import pino from 'pino';
import { tryGetCurrentDb, getTenantContext } from '../../infra/tenancy/tenant-context';

const REDACT_PATHS = [
  'password',
  'adminPassword',
  'masterPassword',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apiKey',
  '*.password',
  '*.adminPassword',
  '*.masterPassword',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.cookie',
  '*.apiKey',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

const NATIONAL_ID_REGEX = /\b\d{10}\b/g;
const CARD_NUMBER_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g;

function sanitizeString(str: string): string {
  return str
    .replace(CARD_NUMBER_REGEX, '[CARD-REDACTED]')
    .replace(NATIONAL_ID_REGEX, '[NID-REDACTED]');
}

function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/password|token|secret|authorization|cookie|apikey/i.test(k)) {
        res[k] = '[REDACTED]';
      } else {
        res[k] = sanitizeObject(v);
      }
    }
    return res;
  }
  return obj;
}

@Injectable()
export class LoggerService implements INestLoggerService {
  private pinoLogger: pino.Logger;

  constructor() {
    const isDev = process.env.NODE_ENV !== 'production';
    this.pinoLogger = pino({
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      mixin: () => {
        const ctx = getTenantContext();
        return {
          db: tryGetCurrentDb(),
          requestId: ctx?.requestId,
        };
      },
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
    const sanitizedMsg = sanitizeString(message);
    const sanitizedExtra = extra ? (sanitizeObject(extra) as Record<string, unknown>) : undefined;
    this.pinoLogger.info({ context, ...sanitizedExtra }, sanitizedMsg);
  }

  error(message: string, trace?: string, context?: string, extra?: Record<string, unknown>) {
    const sanitizedMsg = sanitizeString(message);
    const sanitizedExtra = extra ? (sanitizeObject(extra) as Record<string, unknown>) : undefined;
    this.pinoLogger.error({ context, trace, ...sanitizedExtra }, sanitizedMsg);
  }

  warn(message: string, context?: string, extra?: Record<string, unknown>) {
    const sanitizedMsg = sanitizeString(message);
    const sanitizedExtra = extra ? (sanitizeObject(extra) as Record<string, unknown>) : undefined;
    this.pinoLogger.warn({ context, ...sanitizedExtra }, sanitizedMsg);
  }

  debug(message: string, context?: string, extra?: Record<string, unknown>) {
    const sanitizedMsg = sanitizeString(message);
    const sanitizedExtra = extra ? (sanitizeObject(extra) as Record<string, unknown>) : undefined;
    this.pinoLogger.debug({ context, ...sanitizedExtra }, sanitizedMsg);
  }

  verbose(message: string, context?: string, extra?: Record<string, unknown>) {
    const sanitizedMsg = sanitizeString(message);
    const sanitizedExtra = extra ? (sanitizeObject(extra) as Record<string, unknown>) : undefined;
    this.pinoLogger.trace({ context, ...sanitizedExtra }, sanitizedMsg);
  }

  child(bindings: Record<string, unknown>): pino.Logger {
    return this.pinoLogger.child(bindings);
  }
}
