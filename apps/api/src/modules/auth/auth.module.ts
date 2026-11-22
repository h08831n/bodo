import { Module, OnModuleInit } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { TokenService } from '../../common/auth/token.service';
import { RefreshTokenService } from '../../common/auth/refresh-token.service';
import { AuthRevocationService } from '../../common/auth/auth-revocation.service';
import { AuthRateLimitService } from '../../common/auth/auth-rate-limit.service';
import { AuditWriter } from '../../common/audit/audit-writer';
import { PermissionService } from '../../common/permissions/permission.service';
import {
  PermissionRegistry,
  BASELINE_PERMISSIONS,
} from '../../common/permissions/permission-registry';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    AuthRevocationService,
    AuthRateLimitService,
    AuditWriter,
    PermissionService,
  ],
  exports: [
    AuthService,
    PasswordHasher,
    TokenService,
    RefreshTokenService,
    AuthRevocationService,
    AuthRateLimitService,
    AuditWriter,
    PermissionService,
  ],
})
export class AuthModule implements OnModuleInit {
  onModuleInit(): void {
    // Register initial baseline permissions from stage-1-technical-spec section 8.4
    // Ensures system admin group dynamically contains all registered permissions at boot
    try {
      PermissionRegistry.registerPermissions(BASELINE_PERMISSIONS);
    } catch {
      // Ignore if already registered during test re-initialization
    }
  }
}
