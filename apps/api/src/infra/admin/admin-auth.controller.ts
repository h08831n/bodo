import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AdminLoginRequestSchema,
  AdminLoginResponse,
  ChangeMasterPasswordRequestSchema,
} from '@bodo/contracts';
import { MasterAuthService } from './master-auth.service';
import { MasterAdminGuard, PublicAdmin } from './master-admin.guard';
import { AdminAuditLogger } from './admin-audit.logger';

@Controller('v1/admin')
@UseGuards(MasterAdminGuard)
export class AdminAuthController {
  constructor(
    private readonly masterAuth: MasterAuthService,
    private readonly auditLogger: AdminAuditLogger,
  ) {}

  @PublicAdmin()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() rawBody: unknown, @Req() req: Request): Promise<AdminLoginResponse> {
    const body = AdminLoginRequestSchema.parse(rawBody);
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const requestId = (req.headers['x-request-id'] as string) || 'N/A';

    // 1. Rate Limiting Check
    const rateLimit = await this.masterAuth.checkRateLimit(clientIp);
    if (!rateLimit.allowed) {
      this.auditLogger.log({
        ip: clientIp,
        action: 'ADMIN_LOGIN_LOCKED',
        status: 'FAILURE',
        requestId,
        error: 'Too many failed login attempts. Locked for 15 minutes.',
      });
      throw new HttpException(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many failed login attempts. Please try again after 15 minutes.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Validate Password
    const isValid = await this.masterAuth.validatePassword(body.password);
    if (!isValid) {
      await this.masterAuth.recordLoginAttempt(clientIp, false);
      this.auditLogger.log({
        ip: clientIp,
        action: 'ADMIN_LOGIN',
        status: 'FAILURE',
        requestId,
        error: 'Incorrect master password',
      });
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Invalid master password',
      });
    }

    // 3. Success
    await this.masterAuth.recordLoginAttempt(clientIp, true);
    const config = await this.masterAuth.getConfig();
    const tokenInfo = this.masterAuth.generateToken(config.passwordVersion);

    this.auditLogger.log({
      ip: clientIp,
      action: 'ADMIN_LOGIN',
      status: 'SUCCESS',
      requestId,
    });

    return tokenInfo;
  }

  @Post('change-master-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const body = ChangeMasterPasswordRequestSchema.parse(rawBody);
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const requestId = (req.headers['x-request-id'] as string) || 'N/A';

    try {
      await this.masterAuth.changePassword(body.currentPassword, body.newPassword);
      this.auditLogger.log({
        ip: clientIp,
        action: 'CHANGE_MASTER_PASSWORD',
        status: 'SUCCESS',
        requestId,
      });
      return { message: 'Master password changed successfully. All previous tokens revoked.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        ip: clientIp,
        action: 'CHANGE_MASTER_PASSWORD',
        status: 'FAILURE',
        requestId,
        error: msg,
      });
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: msg,
      });
    }
  }
}
