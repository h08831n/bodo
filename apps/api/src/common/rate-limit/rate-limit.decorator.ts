import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';

export const RATE_LIMIT_OPTIONS_KEY = 'RATE_LIMIT_OPTIONS';

export interface RateLimitOptions {
  points: number;
  durationSeconds: number;
  keyPrefix?: string;
  failClosed?: boolean;
}

export function RateLimit(options: RateLimitOptions) {
  return applyDecorators(SetMetadata(RATE_LIMIT_OPTIONS_KEY, options), UseGuards(RateLimitGuard));
}
