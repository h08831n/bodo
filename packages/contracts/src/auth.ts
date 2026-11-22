import { z } from 'zod';

export const UserTypeSchema = z.enum(['INTERNAL', 'PORTAL']);
export type UserType = z.infer<typeof UserTypeSchema>;

export const AuthUserSummarySchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  fullName: z.string(),
  type: UserTypeSchema,
  mustChangePassword: z.boolean(),
});
export type AuthUserSummary = z.infer<typeof AuthUserSummarySchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64, 'Username exceeds maximum length'),
  password: z.string().min(1, 'Password is required').max(1024, 'Password exceeds maximum length'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
  user: AuthUserSummarySchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(1024),
  newPassword: z
    .string()
    .min(10, 'New password must be at least 10 characters')
    .max(128, 'New password exceeds maximum length of 128 characters'),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const ChangePasswordResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
  user: AuthUserSummarySchema,
});
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;

export const CurrentSessionSummarySchema = z.object({
  id: z.string().uuid(),
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
});
export type CurrentSessionSummary = z.infer<typeof CurrentSessionSummarySchema>;

export const CompanySummarySchema = z.object({
  name: z.string(),
  defaultCurrency: z.string(),
});
export type CompanySummary = z.infer<typeof CompanySummarySchema>;

export const MeResponseSchema = z.object({
  user: AuthUserSummarySchema,
  permissions: z.array(z.string()),
  company: CompanySummarySchema,
  session: CurrentSessionSummarySchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const SessionItemSchema = z.object({
  id: z.string().uuid(),
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const SessionsListResponseSchema = z.object({
  items: z.array(SessionItemSchema),
});
export type SessionsListResponse = z.infer<typeof SessionsListResponseSchema>;

export const LogoutResponseSchema = z.object({
  success: z.boolean(),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const LogoutAllResponseSchema = z.object({
  success: z.boolean(),
  revokedCount: z.number().optional(),
});
export type LogoutAllResponse = z.infer<typeof LogoutAllResponseSchema>;

export const DeleteSessionResponseSchema = z.object({
  success: z.boolean(),
});
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;
