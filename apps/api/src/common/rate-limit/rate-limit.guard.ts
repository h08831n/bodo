import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_OPTIONS_KEY, RateLimitOptions } from './rate-limit.decorator';
import { tryGetCurrentDb } from '../../infra/tenancy/tenant-context';
import { tenantKey, globalKey } from '../../infra/redis';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_OPTIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
    const db = tryGetCurrentDb();
    const prefix = options.keyPrefix || 'rl';

    // Construct rate limit key with tenant isolation if db is present
    const redisKey = db ? tenantKey(db, prefix, ip) : globalKey(prefix, ip);

    try {
      const result = await this.rateLimitService.consume(
        redisKey,
        options.points,
        options.durationSeconds,
      );

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(result.retryAfterSeconds));

      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی صبر کنید.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }

      // Redis error handling: fail-closed for auth/admin or explicit flag, fail-open otherwise
      const failClosed = options.failClosed ?? false;
      this.logger.warn(`Rate limiter encountered Redis error: ${err}. failClosed=${failClosed}`);

      if (failClosed) {
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message: 'سیستم کنترل ترافیک موقتاً در دسترس نیست. لطفاً بعداً تلاش کنید.',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      return true;
    }
  }
}
