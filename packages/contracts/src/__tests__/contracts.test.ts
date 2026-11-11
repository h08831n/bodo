import { describe, it, expect } from 'vitest';
import { ApiErrorResponseSchema, HealthStatusSchema } from '../index.js';

describe('Contracts Schema Validation', () => {
  it('validates a correct error response structure', () => {
    const validError = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'ورودی نامعتبر است',
        details: [{ path: 'mobile', message: 'شماره موبایل اشتباه است' }],
        requestId: 'req-12345',
      },
    };

    const parsed = ApiErrorResponseSchema.safeParse(validError);
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid error code', () => {
    const invalidError = {
      error: {
        code: 'UNKNOWN_ERROR',
        message: 'خطا',
      },
    };

    const parsed = ApiErrorResponseSchema.safeParse(invalidError);
    expect(parsed.success).toBe(false);
  });

  it('validates health response structure', () => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: 'up',
        redis: 'up',
      },
    };

    const parsed = HealthStatusSchema.safeParse(health);
    expect(parsed.success).toBe(true);
  });
});
