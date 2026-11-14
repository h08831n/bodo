import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'DATABASE_REQUIRED',
  'DATABASE_MAINTENANCE',
  'DATABASE_NOT_FOUND',
  'DATABASE_ALREADY_EXISTS',
  'DATABASE_BUSY',
  'PAYLOAD_TOO_LARGE',
  'DEGRADED',
  'INTERNAL',
  'DISK_SPACE_EXCEEDED',
  'BACKUP_FAILED',
  'RESTORE_FAILED',
  'CORRUPTED_ARCHIVE',
  'INCOMPATIBLE_MIGRATION',
  'ZIP_SLIP_ATTEMPT',
  'ZIP_BOMB_DETECTED',
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
  status: z.enum(['ok', 'degraded', 'error']),
  uptime: z.number().optional(),
  timestamp: z.string(),
  version: z.string().optional(),
  commit: z.string().optional(),
  buildTime: z.string().optional(),
  checks: z
    .object({
      postgres: z.enum(['up', 'down']).optional(),
      redis: z.enum(['up', 'down']).optional(),
      worker: z.enum(['up', 'down']).optional(),
    })
    .optional(),
  tenantClients: z
    .object({
      open: z.number(),
      maxClients: z.number(),
      activeLeases: z.number(),
    })
    .optional(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export * from './admin.js';
