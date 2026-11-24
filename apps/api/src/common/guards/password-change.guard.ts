import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { AccessTokenClaims } from '../auth/token.service';

@Injectable()
export class PasswordChangeGuard implements CanActivate {
  private readonly ALLOWED_MCP_PATHS = [
    '/v1/auth/me',
    '/v1/auth/change-password',
    '/v1/auth/logout',
  ];

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const originalUrl = req.originalUrl || req.url || '';
    const pathname = originalUrl.split('?')[0] || '';

    if (pathname.startsWith('/v1/admin')) {
      return true;
    }

    const user = (req as unknown as { user?: AccessTokenClaims }).user;
    if (!user) {
      return true;
    }

    if (user.mcp === true) {
      const isAllowed = this.ALLOWED_MCP_PATHS.some((allowed) => pathname === allowed);
      if (!isAllowed) {
        throw new ForbiddenException({
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'تغییر رمز عبور الزامی است؛ قبل از ادامه کار ابتدا رمز عبور خود را تغییر دهید',
        });
      }
    }

    return true;
  }
}
