import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { tenantKey } from '../../infra/redis/redis-keys';
import { getEnv } from '../../config/env.config';

@Injectable()
export class AuthRevocationService {
  constructor(private readonly redisService: RedisService) {}

  /**
   * Immediately revokes a single session by sid in Redis.
   * TTL is equal to maximum access token lifetime (ACCESS_TOKEN_TTL_SEC).
   */
  async revokeSession(db: string, sid: string): Promise<void> {
    try {
      const env = getEnv();
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'revoked', 'sid', sid);
      await redis.set(key, '1', 'EX', env.ACCESS_TOKEN_TTL_SEC);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for auth revocation',
      });
    }
  }

  /**
   * Revokes all access tokens for a user issued before the specified timestamp.
   * Used during logout-all, password change, and user deactivation.
   */
  async revokeUserBefore(
    db: string,
    userId: string,
    timestamp: number = Date.now(),
  ): Promise<void> {
    try {
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'revoked', 'user', userId, 'before');
      // Store timestamp as string (epoch ms), keep for 30 days
      await redis.set(key, timestamp.toString(), 'EX', 30 * 24 * 60 * 60);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for auth revocation',
      });
    }
  }

  /**
   * Checks whether a session has been revoked in Redis.
   * Fail-closed: Throws ServiceUnavailableException if Redis is down.
   */
  async isSessionRevoked(db: string, sid: string): Promise<boolean> {
    try {
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'revoked', 'sid', sid);
      const exists = await redis.exists(key);
      return exists === 1;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for auth validation',
      });
    }
  }

  /**
   * Gets the revoked-before timestamp for a user.
   * Fail-closed: Throws ServiceUnavailableException if Redis is down.
   */
  async getUserRevokedBefore(db: string, userId: string): Promise<number | null> {
    try {
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'revoked', 'user', userId, 'before');
      const val = await redis.get(key);
      return val ? parseInt(val, 10) : null;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for auth validation',
      });
    }
  }

  /**
   * Clears the revoked-before timestamp when a user establishes a new valid login.
   */
  async clearUserRevokedBefore(db: string, userId: string): Promise<void> {
    try {
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'revoked', 'user', userId, 'before');
      await redis.del(key);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEGRADED',
        message: 'Redis connection unavailable for auth revocation',
      });
    }
  }
}
