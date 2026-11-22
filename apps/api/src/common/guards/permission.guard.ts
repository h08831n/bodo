import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  REQUIRE_PERMISSION_KEY,
  RequirePermissionMetadata,
} from '../decorators/auth.decorators';
import { PermissionService } from '../permissions/permission.service';
import { AccessTokenClaims } from '../auth/token.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const metadata = this.reflector.getAllAndOverride<RequirePermissionMetadata>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!metadata || metadata.codes.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as unknown as { user?: AccessTokenClaims }).user;
    if (!user) {
      return true; // Let JwtAuthGuard handle unauthenticated requests
    }

    const userPermissions = await this.permissionService.getUserPermissions(user.db, user.sub);

    const hasPermission =
      metadata.mode === 'any'
        ? metadata.codes.some((code) => userPermissions.includes(code))
        : metadata.codes.every((code) => userPermissions.includes(code));

    if (!hasPermission) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'شما دسترسی لازم برای انجام این عملیات را ندارید',
      });
    }

    return true;
  }
}
