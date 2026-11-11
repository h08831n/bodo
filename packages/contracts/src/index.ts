import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'DATABASE_MAINTENANCE',
  'DATABASE_NOT_FOUND',
  'INTERNAL',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorDetailSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
});

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ApiErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.array(ErrorDetailSchema).optional(),
  requestId: z.string().optional(),
});

export const ApiErrorResponseSchema = z.object({
  error: ApiErrorPayloadSchema,
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  uptime: z.number().optional(),
  timestamp: z.string(),
  checks: z
    .object({
      postgres: z.enum(['up', 'down']).optional(),
      redis: z.enum(['up', 'down']).optional(),
    })
    .optional(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
