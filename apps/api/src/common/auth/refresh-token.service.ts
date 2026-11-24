import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { getEnv } from '../../config/env.config';

export interface GeneratedRefreshToken {
  sessionId: string;
  secret: string;
  tokenString: string;
  hash: string;
}

export interface ParsedRefreshToken {
  sessionId: string;
  secret: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly FAMILY_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute limit
  private readonly SESSION_SLIDING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding limit
  private readonly MAX_ACTIVE_SESSIONS_PER_USER = 10;

  /**
   * Hashes a refresh token secret using HMAC-SHA256 with REFRESH_TOKEN_PEPPER.
   */
  hashSecret(secret: string): string {
    const env = getEnv();
    return crypto.createHmac('sha256', env.REFRESH_TOKEN_PEPPER).update(secret).digest('hex');
  }

  /**
   * Generates a new 48-byte cryptographically secure refresh token.
   * Format: <sessionId>.<secret>
   */
  generateToken(sessionId: string): GeneratedRefreshToken {
    const secret = crypto.randomBytes(48).toString('base64url');
    const hash = this.hashSecret(secret);
    return {
      sessionId,
      secret,
      tokenString: `${sessionId}.${secret}`,
      hash,
    };
  }

  /**
   * Parses and validates the format of a refresh token string.
   */
  parseToken(tokenString: string): ParsedRefreshToken | null {
    if (!tokenString || typeof tokenString !== 'string') {
      return null;
    }
    const parts = tokenString.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [sessionId, secret] = parts;
    // Validate UUID format for sessionId
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!sessionId || !secret || !uuidRegex.test(sessionId) || secret.length < 32) {
      return null;
    }
    return { sessionId, secret };
  }

  /**
   * Verifies the secret against the stored hash in constant time.
   */
  verifySecret(secret: string, storedHash: string): boolean {
    const computedHash = this.hashSecret(secret);
    const computedBuffer = Buffer.from(computedHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (computedBuffer.length !== storedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(computedBuffer, storedBuffer);
  }

  /**
   * Checks whether the family has exceeded its 90-day absolute ceiling.
   */
  isFamilyExpired(familyCreatedAt: Date): boolean {
    const ageMs = Date.now() - new Date(familyCreatedAt).getTime();
    return ageMs > this.FAMILY_MAX_LIFETIME_MS;
  }

  /**
   * Checks whether the session has expired past its 30-day lifetime.
   */
  isSessionExpired(expiresAt: Date): boolean {
    return new Date(expiresAt).getTime() < Date.now();
  }

  getSlidingExpirationDate(): Date {
    return new Date(Date.now() + this.SESSION_SLIDING_LIFETIME_MS);
  }

  getMaxActiveSessionsLimit(): number {
    return this.MAX_ACTIVE_SESSIONS_PER_USER;
  }
}
