import { z } from 'zod';

export const AdminLoginRequestSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
export type AdminLoginRequest = z.infer<typeof AdminLoginRequestSchema>;

export const AdminLoginResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number(),
});
export type AdminLoginResponse = z.infer<typeof AdminLoginResponseSchema>;

export const ChangeMasterPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(12, 'New password must be at least 12 characters'),
});
export type ChangeMasterPasswordRequest = z.infer<typeof ChangeMasterPasswordRequestSchema>;

export const DatabaseListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  companyName: z.string().nullable(),
  schemaVersion: z.string().nullable(),
  pendingMigrations: z.number(),
  sizeBytes: z.number(),
  lastBackup: z.string().nullable(),
  state: z.enum(['active', 'maintenance', 'failed']),
  domain: z.string().nullable(),
});
export type DatabaseListItem = z.infer<typeof DatabaseListItemSchema>;

export const CreateDatabaseRequestSchema = z.object({
  name: z.string().min(3).max(63),
  adminUsername: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9_]+$/, 'Username must be lowercase alphanumeric or underscore'),
  adminFullName: z.string().min(2).max(100),
  adminPassword: z.string().min(10, 'Password must be at least 10 characters'),
});
export type CreateDatabaseRequest = z.infer<typeof CreateDatabaseRequestSchema>;

export const DuplicateDatabaseRequestSchema = z.object({
  newName: z.string().min(3).max(63),
  neutralize: z.boolean().default(false),
});
export type DuplicateDatabaseRequest = z.infer<typeof DuplicateDatabaseRequestSchema>;

export const BackupListItemSchema = z.object({
  file: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});
export type BackupListItem = z.infer<typeof BackupListItemSchema>;

export const RestoreDatabaseRequestSchema = z.object({
  newName: z.string().min(3).max(63),
  neutralize: z.boolean().default(false),
});
export type RestoreDatabaseRequest = z.infer<typeof RestoreDatabaseRequestSchema>;

export const DeleteDatabaseRequestSchema = z.object({
  confirmName: z.string().min(1, 'Database confirmation name is required'),
});
export type DeleteDatabaseRequest = z.infer<typeof DeleteDatabaseRequestSchema>;

export const UpgradeDatabaseRequestSchema = z.object({
  targetMigration: z.string().optional(),
});
export type UpgradeDatabaseRequest = z.infer<typeof UpgradeDatabaseRequestSchema>;

export const RepairDatabaseRequestSchema = z.object({
  confirm: z.boolean(),
  migration: z.string().optional(),
});
export type RepairDatabaseRequest = z.infer<typeof RepairDatabaseRequestSchema>;

export const SetMaintenanceRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
  confirm: z.boolean().optional(),
});
export type SetMaintenanceRequest = z.infer<typeof SetMaintenanceRequestSchema>;

export const SetDomainRequestSchema = z.object({
  host: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+$/, 'Hostname must be valid lowercase domain name')
    .nullable(),
});
export type SetDomainRequest = z.infer<typeof SetDomainRequestSchema>;

export const AdminJobStatusSchema = z.object({
  id: z.string(),
  type: z.enum(['create', 'duplicate', 'backup', 'restore', 'delete', 'upgrade']),
  database: z.string(),
  status: z.enum(['waiting', 'active', 'completed', 'failed']),
  percent: z.number().min(0).max(100),
  step: z.string(),
  message: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type AdminJobStatus = z.infer<typeof AdminJobStatusSchema>;

export const PublicDatabasesResponseSchema = z.array(z.string());
export type PublicDatabasesResponse = z.infer<typeof PublicDatabasesResponseSchema>;

export const TenantByHostResponseSchema = z.object({
  database: z.string().nullable(),
});
export type TenantByHostResponse = z.infer<typeof TenantByHostResponseSchema>;
