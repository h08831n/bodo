import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, USER_TYPE_KEY } from '../decorators/auth.decorators';
import { AccessTokenClaims } from '../auth/token.service';

@Injectable()
export class UserTypeGuard implements CanActivate {
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

    // Admin routes are not governed by UserTypeGuard
    if (pathname.startsWith('/v1/admin')) {
      return true;
    }

    const user = (req as unknown as { user?: AccessTokenClaims }).user;
    if (!user) {
      return true; // Handled by JwtAuthGuard
    }

    const explicitType = this.reflector.getAllAndOverride<'INTERNAL' | 'PORTAL'>(USER_TYPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If route is under /v1/portal or decorated with @PortalOnly(), require PORTAL
    const isPortalRoute = pathname.startsWith('/v1/portal') || explicitType === 'PORTAL';
    const requiredType = isPortalRoute ? 'PORTAL' : 'INTERNAL';

    if (user.typ !== requiredType) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          requiredType === 'PORTAL'
            ? 'این مسیر فقط برای کاربران پورتال مجاز است'
            : 'کاربران پورتال مجاز به دسترسی به سیستم داخلی نیستند',
      });
    }

    return true;
  }
}
