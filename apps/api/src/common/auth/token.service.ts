import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { getEnv } from '../../config/env.config';

export interface AccessTokenClaims {
  sub: string; // User ID
  typ: 'INTERNAL' | 'PORTAL';
  db: string; // Tenant Database Name
  sid: string; // Session ID
  mcp: boolean; // Must Change Password flag
  iat: number;
  exp: number;
  iss: 'bodo';
  aud: 'bodo-user';
}

export interface CreateTokenPayload {
  sub: string;
  typ: 'INTERNAL' | 'PORTAL';
  db: string;
  sid: string;
  mcp: boolean;
}

export interface TokenVerificationResult {
  valid: boolean;
  claims?: AccessTokenClaims;
  expired?: boolean;
  error?: string;
}

@Injectable()
export class TokenService {
  private getSecretKey(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
  }

  /**
   * Signs an access JWT using HS256 with standard bodo claims.
   */
  async signAccessToken(
    payload: CreateTokenPayload,
  ): Promise<{ token: string; expiresIn: number }> {
    const env = getEnv();
    const expiresInSec = env.ACCESS_TOKEN_TTL_SEC;
    const secretKey = this.getSecretKey(env.JWT_SECRET);

    const token = await new SignJWT({
      typ: payload.typ,
      db: payload.db,
      sid: payload.sid,
      mcp: payload.mcp,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'current' })
      .setIssuedAt()
      .setIssuer('bodo')
      .setAudience('bodo-user')
      .setSubject(payload.sub)
      .setExpirationTime(`${expiresInSec}s`)
      .sign(secretKey);

    return { token, expiresIn: expiresInSec };
  }

  /**
   * Verifies an access token strictly enforcing HS256, issuer=bodo, and audience=bodo-user.
   * If verification fails with primary secret and JWT_SECRET_PREVIOUS is configured,
   * falls back to the previous secret for zero-downtime key rotation.
   */
  async verifyAccessToken(token: string): Promise<TokenVerificationResult> {
    const env = getEnv();
    const primaryKey = this.getSecretKey(env.JWT_SECRET);

    try {
      const { payload } = await jwtVerify(token, primaryKey, {
        issuer: 'bodo',
        audience: 'bodo-user',
        algorithms: ['HS256'],
      });

      return {
        valid: true,
        claims: payload as unknown as AccessTokenClaims,
      };
    } catch (err: unknown) {
      // Check for previous secret rotation fallback
      if (env.JWT_SECRET_PREVIOUS) {
        try {
          const previousKey = this.getSecretKey(env.JWT_SECRET_PREVIOUS);
          const { payload } = await jwtVerify(token, previousKey, {
            issuer: 'bodo',
            audience: 'bodo-user',
            algorithms: ['HS256'],
          });
          return {
            valid: true,
            claims: payload as unknown as AccessTokenClaims,
          };
        } catch {
          // Fall through to report failure
        }
      }

      const errorObj = err as { code?: string; message?: string };
      const isExpired = errorObj?.code === 'ERR_JWT_EXPIRED';

      return {
        valid: false,
        expired: isExpired,
        error: errorObj?.message || 'Token verification failed',
      };
    }
  }

  /**
   * Decodes JWT payload without verifying signature.
   * STRICT SECURITY NOTE: Used ONLY by TenantResolver/Middleware when neither Host
   * nor X-Database header is provided, to route the request to the correct tenant database.
   * The actual token signature, validity, and database isolation MUST be strictly verified
   * subsequently by JwtAuthGuard before any data is returned.
   */
  decodeTokenUnverified(token: string): Partial<AccessTokenClaims> | null {
    try {
      return decodeJwt(token) as Partial<AccessTokenClaims>;
    } catch {
      return null;
    }
  }
}
