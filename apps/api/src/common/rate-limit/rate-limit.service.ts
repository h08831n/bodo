import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infra/redis';

const RATE_LIMIT_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - window

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
    redis.call('ZADD', key, now, tostring(now) .. ':' .. tostring(redis.call('INCR', key .. ':seq')))
    redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
    redis.call('EXPIRE', key .. ':seq', math.ceil(window / 1000) + 1)
    return { 1, limit - currentRequests - 1, math.ceil(window / 1000) }
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfter = 1
    if oldest and #oldest >= 2 and oldest[2] then
        retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000))
    end
    return { 0, 0, retryAfter }
end
`;

export interface RateLimitConsumeOptions {
  limit: number;
  windowSec: number;
  blockSec?: number;
}

export type RateLimitOptions = RateLimitConsumeOptions;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  retryAfterSeconds: number;
  limit: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Consumes a point in sliding window rate limiter atomically.
   */
  async consume(
    key: string,
    limitOrOptions: number | RateLimitOptions,
    durationSeconds?: number,
  ): Promise<RateLimitResult> {
    try {
      const limit = typeof limitOrOptions === 'number' ? limitOrOptions : limitOrOptions.limit;
      const windowSec =
        typeof limitOrOptions === 'number' ? (durationSeconds ?? 60) : limitOrOptions.windowSec;

      const redis = this.redisService.getClient();
      const now = Date.now();
      const windowMs = windowSec * 1000;

      const res = (await redis.eval(RATE_LIMIT_LUA_SCRIPT, 1, key, now, windowMs, limit)) as [
        number,
        number,
        number,
      ];

      const allowed = res[0] === 1;
      const remaining = res[1];
      const retryAfterSeconds = res[2];

      return {
        allowed,
        remaining,
        retryAfterSec: retryAfterSeconds,
        retryAfterSeconds,
        limit,
      };
    } catch (err) {
      this.logger.error(`Redis rate limit evaluation failed: ${err}`);
      throw err;
    }
  }
}
