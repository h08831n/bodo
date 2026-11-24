import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { TokenService } from '../auth/token.service';
import { AuthRevocationService } from '../auth/auth-revocation.service';
import { tryGetCurrentDb, setContextUser } from '../../infra/tenancy/tenant-context';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly authRevocationService: AuthRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Explicit @Public() routes are accessible without token
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

    // 2. Master Admin routes (/v1/admin/*) are protected separately by MasterAdminGuard
    if (pathname.startsWith('/v1/admin')) {
      return true;
    }

    // 3. Health & Documentation endpoints exemption
    if (
      pathname === '/health' ||
      pathname.startsWith('/health/') ||
      pathname.startsWith('/docs') ||
      pathname === '/favicon.ico'
    ) {
      return true;
    }

    // 4. Extract Authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن دسترسی ارائه نشده است',
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'قالب هدر احراز هویت نامعتبر است (الگوی Bearer لازم است)',
      });
    }

    const token = parts[1];
    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن دسترسی ارائه نشده است',
      });
    }

    // 5. Verify cryptographic signature, HS256 algorithm, and standard claims
    const verification = await this.tokenService.verifyAccessToken(token);
    if (!verification.valid || !verification.claims) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: verification.expired ? 'توکن دسترسی منقضی شده است' : 'توکن دسترسی نامعتبر است',
      });
    }

    const claims = verification.claims;

    // 6. Strict presence of required claims (sid, sub, db, typ)
    if (!claims.sid || !claims.sub || !claims.db || !claims.typ) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن دسترسی فاقد مشخصه‌های هویتی الزامی است',
      });
    }

    // 7. Strict audience check: bodo-user only (reject admin tokens on tenant routes)
    if (claims.aud !== 'bodo-user') {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نوع توکن برای این مسیر نامعتبر است',
      });
    }

    // 7. Strict multi-tenant isolation: token.db must match current tenant context
    const currentDb = tryGetCurrentDb();
    if (currentDb && claims.db !== currentDb) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'توکن دسترسی متعلق به دیتابیس این شرکت نیست',
      });
    }

    // 8. Instant revocation check via Redis (sid key and user revoked-before timestamp)
    const isSidRevoked = await this.authRevocationService.isSessionRevoked(claims.db, claims.sid);
    if (isSidRevoked) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'این نشست قبلاً باطل شده است',
      });
    }

    const revokedBefore = await this.authRevocationService.getUserRevokedBefore(
      claims.db,
      claims.sub,
    );
    if (revokedBefore !== null && claims.iat * 1000 <= revokedBefore) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'نشست‌های این کاربر باطل شده‌اند؛ لطفاً دوباره وارد شوید',
      });
    }

    // 9. Attach verified claims to request and tenant context
    (req as unknown as { user: unknown }).user = claims;
    setContextUser(claims.sub, claims.typ);

    return true;
  }
}
