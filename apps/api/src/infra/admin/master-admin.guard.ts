import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  SetMetadata,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getEnv } from '../../config/env.config';
import { MasterAuthService } from './master-auth.service';
import { AdminAuditLogger } from './admin-audit.logger';
import { isIpAllowed } from './ip-allowlist';

export const IS_PUBLIC_ADMIN_KEY = 'isPublicAdmin';
export const PublicAdmin = () => SetMetadata(IS_PUBLIC_ADMIN_KEY, true);

@Injectable()
export class MasterAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly masterAuth: MasterAuthService,
    @Optional() @Inject(AdminAuditLogger) private readonly auditLogger?: AdminAuditLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const env = getEnv();

    // 1. If DB Manager is disabled, return 404
    if (!env.DB_MANAGER_ENABLED) {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<Request>();

    // 2. IP Allowlist Verification
    const clientIp = this.extractClientIp(request);
    if (!isIpAllowed(clientIp, env.DB_MANAGER_ALLOWED_IPS)) {
      this.auditLogger?.log({
        ip: clientIp,
        action: 'ACCESS_DENIED_ALLOWLIST',
        status: 'FAILURE',
        requestId: request.requestId || (request.headers['x-request-id'] as string) || 'N/A',
        error: 'Access to Database Manager is restricted by IP allowlist',
      });
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Access to Database Manager is restricted by IP allowlist',
      });
    }

    // 3. Check if route is public within admin (e.g. POST /login)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // 4. Extract and verify Admin JWT Token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Missing or malformed admin authorization token',
      });
    }

    const token = authHeader.substring(7).trim();
    const payload = await this.masterAuth.verifyToken(token);

    if (!payload) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Invalid, expired, or revoked admin token',
      });
    }

    // Attach admin session info
    (request as unknown as { adminUser: unknown }).adminUser = payload;
    return true;
  }

  private extractClientIp(req: Request): string {
    // In express with trust proxy, req.ip reflects the client IP as forwarded by trusted proxy (Nginx).
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
  }
}
