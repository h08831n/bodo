import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { mergeMap, catchError } from 'rxjs/operators';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { RedisService, tenantKey, globalKey } from '../../infra/redis';
import { tryGetCurrentDb } from '../../infra/tenancy/tenant-context';
import { IDEMPOTENT_OPTIONS_KEY, IdempotentOptions } from './idempotent.decorator';

const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const PENDING_LOCK_TTL_SECONDS = 30;

interface StoredIdempotencyRecord {
  pending: boolean;
  hash: string;
  status?: number;
  body?: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly redisService: RedisService,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const httpContext = context.switchToHttp();
    const req = httpContext.getRequest<Request>();
    const res = httpContext.getResponse<Response>();

    const options =
      this.reflector?.getAllAndOverride<IdempotentOptions>(IDEMPOTENT_OPTIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? {};

    const headerName = (options.headerName ?? 'idempotency-key').toLowerCase();
    const idempotencyKey = req.headers[headerName];

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      return next.handle();
    }

    const key = idempotencyKey.trim();
    const db = tryGetCurrentDb();
    const redisKey = db ? tenantKey(db, 'idemp', key) : globalKey('idemp', key);

    const redis = this.redisService.getClient();

    // Calculate sha256 hash of payload
    const bodyString = JSON.stringify(req.body ?? {});
    const payloadHash = createHash('sha256').update(bodyString).digest('hex');

    const existingRaw = await redis.get(redisKey);
    if (existingRaw) {
      try {
        const stored: StoredIdempotencyRecord = JSON.parse(existingRaw);
        if (stored.pending) {
          throw new ConflictException({
            code: 'DATABASE_BUSY',
            message: 'درخواست هم‌زمان با همین کلید یکتایی در حال پردازش است.',
          });
        }

        if (stored.hash !== payloadHash) {
          throw new UnprocessableEntityException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'کلید یکتایی قبلاً با داده‌های متفاوتی استفاده شده است.',
          });
        }

        // Replay cached response
        res.setHeader('Idempotency-Replayed', 'true');
        res.setHeader('X-Idempotency', 'HIT');
        if (stored.status && typeof res.status === 'function') {
          res.status(stored.status);
        }
        return of(stored.body);
      } catch (err) {
        if (err instanceof ConflictException || err instanceof UnprocessableEntityException) {
          throw err;
        }
        if (!(err instanceof SyntaxError)) {
          throw err;
        }
        // If corrupted JSON in Redis, overwrite below
      }
    }

    // Try to acquire lock
    const pendingRecord: StoredIdempotencyRecord = {
      pending: true,
      hash: payloadHash,
    };

    const acquired = await redis.set(
      redisKey,
      JSON.stringify(pendingRecord),
      'EX',
      PENDING_LOCK_TTL_SECONDS,
      'NX',
    );

    if (!acquired) {
      throw new ConflictException({
        code: 'DATABASE_BUSY',
        message: 'درخواست هم‌زمان با همین کلید یکتایی در حال پردازش است.',
      });
    }

    res.setHeader('X-Idempotency', 'MISS');
    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    return next.handle().pipe(
      mergeMap(async (responseBody) => {
        const statusCode = res.statusCode || 200;
        if (statusCode < 500) {
          const finalRecord: StoredIdempotencyRecord = {
            pending: false,
            hash: payloadHash,
            status: statusCode,
            body: responseBody,
          };
          await redis.set(redisKey, JSON.stringify(finalRecord), 'EX', ttl);
        }
        return responseBody;
      }),
      catchError(async (err) => {
        // If server 5xx error, remove pending lock so user can retry safely
        const status = err?.status || err?.statusCode || 500;
        if (status >= 500) {
          await redis.del(redisKey).catch(() => {});
        }
        throw err;
      }),
    );
  }
}
