import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { tenantKey, globalKey } from '../../infra/redis/redis-keys';

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSec?: number;
  reason?: 'ip_limit' | 'user_lockout';
}

@Injectable()
export class AuthRateLimitService {
  private readonly IP_LIMIT_PER_MINUTE = 30;
  private readonly USER_MAX_FAILURES = 5;
  private readonly LOCKOUT_WINDOW_SEC = 15 * 60; // 15 minutes (900 seconds)

  constructor(private readonly redisService: RedisService) {}

  /**
   * Checks if login attempt is allowed based on IP limits and username lockout.
   * Fail-closed: Throws ServiceUnavailableException if Redis is down.
   */
  async checkLoginAllowed(
    db: string,
    ip: string,
    normalizedUsername: string,
  ): Promise<RateLimitCheckResult> {
    try {
      const redis = this.redisService.getClient();

      // 1. Check User Lockout
      const userFailKey = tenantKey(db, 'ratelimit', 'login', 'user', normalizedUsername);
      const userFailuresStr = await redis.get(userFailKey);
      const userFailures = userFailuresStr ? parseInt(userFailuresStr, 10) : 0;

      if (userFailures >= this.USER_MAX_FAILURES) {
        const ttl = await redis.ttl(userFailKey);
        const retryAfter = ttl > 0 ? ttl : this.LOCKOUT_WINDOW_SEC;
        return {
          allowed: false,
          retryAfterSec: retryAfter,
          reason: 'user_lockout',
        };
      }

      // 2. Check Tenant IP Limit (30/min)
      const tenantIpKey = tenantKey(db, 'ratelimit', 'login', 'ip', ip);
      const tenantAttemptsStr = await redis.get(tenantIpKey);
      const tenantAttempts = tenantAttemptsStr ? parseInt(tenantAttemptsStr, 10) : 0;

      if (tenantAttempts >= this.IP_LIMIT_PER_MINUTE) {
        const ttl = await redis.ttl(tenantIpKey);
        return {
          allowed: false,
          retryAfterSec: ttl > 0 ? ttl : 60,
          reason: 'ip_limit',
        };
      }

      // 3. Check Global IP Limit (e.g. 60/min across all tenants)
      const globalIpKey = globalKey('ratelimit', 'login', 'ip', ip);
      const globalAttemptsStr = await redis.get(globalIpKey);
      const globalAttempts = globalAttemptsStr ? parseInt(globalAttemptsStr, 10) : 0;

      if (globalAttempts >= this.IP_LIMIT_PER_MINUTE * 2) {
        const ttl = await redis.ttl(globalIpKey);
        return {
          allowed: false,
          retryAfterSec: ttl > 0 ? ttl : 60,
          reason: 'ip_limit',
        };
      }

      return { allowed: true };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for rate limit check',
      });
    }
  }

  /**
   * Records a login attempt.
   * Increments IP counters.
   * On failure: increments user failure counter (lockout triggers on 5th failure for 15 minutes).
   * On success: resets user failure counter.
   */
  async recordLoginAttempt(
    db: string,
    ip: string,
    normalizedUsername: string,
    success: boolean,
  ): Promise<{ lockedNow: boolean; retryAfterSec?: number }> {
    try {
      const redis = this.redisService.getClient();

      // Record IP rate limits regardless of success/failure
      const tenantIpKey = tenantKey(db, 'ratelimit', 'login', 'ip', ip);
      const globalIpKey = globalKey('ratelimit', 'login', 'ip', ip);

      const p = redis.pipeline();
      p.incr(tenantIpKey);
      p.expire(tenantIpKey, 60);
      p.incr(globalIpKey);
      p.expire(globalIpKey, 60);

      const userFailKey = tenantKey(db, 'ratelimit', 'login', 'user', normalizedUsername);

      if (success) {
        p.del(userFailKey);
        await p.exec();
        return { lockedNow: false };
      } else {
        p.incr(userFailKey);
        p.expire(userFailKey, this.LOCKOUT_WINDOW_SEC);
        const results = await p.exec();

        // Check if this failure locked the account
        const incrResult = results?.[4]?.[1];
        const failCount = typeof incrResult === 'number' ? incrResult : 1;

        if (failCount >= this.USER_MAX_FAILURES) {
          return {
            lockedNow: true,
            retryAfterSec: this.LOCKOUT_WINDOW_SEC,
          };
        }
        return { lockedNow: false };
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for recording login attempt',
      });
    }
  }
}
