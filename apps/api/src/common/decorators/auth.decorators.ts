import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const USER_TYPE_KEY = 'userType';
export const InternalOnly = () => SetMetadata(USER_TYPE_KEY, 'INTERNAL');
export const PortalOnly = () => SetMetadata(USER_TYPE_KEY, 'PORTAL');

export interface RequirePermissionOptions {
  mode?: 'any' | 'all';
}

export interface RequirePermissionMetadata {
  codes: string[];
  mode: 'any' | 'all';
}

export const REQUIRE_PERMISSION_KEY = 'requirePermission';
export function RequirePermission(first: string | string[], ...rest: unknown[]) {
  if (first === 'any' || first === 'all') {
    return SetMetadata(REQUIRE_PERMISSION_KEY, {
      codes: rest.filter((c): c is string => typeof c === 'string'),
      mode: first,
    } as RequirePermissionMetadata);
  }

  const codes = Array.isArray(first) ? first : [first];
  const options = rest[0] as RequirePermissionOptions | undefined;
  return SetMetadata(REQUIRE_PERMISSION_KEY, {
    codes,
    mode: options?.mode || 'all',
  } as RequirePermissionMetadata);
}

export const CurrentUser = createParamDecorator(
  (data: keyof AccessTokenClaims | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AccessTokenClaims | undefined;
    if (!user) return null;
    return data ? user[data] : user;
  },
);
