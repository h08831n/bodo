import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor';

export const IDEMPOTENT_OPTIONS_KEY = 'IDEMPOTENT_OPTIONS';

export interface IdempotentOptions {
  ttlSeconds?: number;
  headerName?: string;
}

export function Idempotent(options: IdempotentOptions = {}) {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_OPTIONS_KEY, options),
    UseInterceptors(IdempotencyInterceptor),
  );
}
