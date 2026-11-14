import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const CURSOR_SALT = 'bodo-keyset-cursor-salt-v1';
const CURSOR_INFO = 'bodo-keyset-cursor-encryption';
const DEFAULT_SECRET = 'dev-insecure-jwt-secret-do-not-use-in-production-min32chars';

let derivedKeyCache: Buffer | null = null;

function getHmacKey(): Buffer {
  if (derivedKeyCache) {
    return derivedKeyCache;
  }
  const secret = process.env.JWT_SECRET || DEFAULT_SECRET;
  const key = hkdfSync('sha256', Buffer.from(secret, 'utf8'), CURSOR_SALT, CURSOR_INFO, 32);
  derivedKeyCache = Buffer.from(key);
  return derivedKeyCache;
}

export interface CursorPayload {
  [key: string]: unknown;
}

/**
 * Encodes a key-value record of cursor values into a signed opaque URL-safe base64 string.
 */
export function encodeCursor(payload: CursorPayload): string {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(jsonStr, 'utf8').toString('base64url');
  const hmac = createHmac('sha256', getHmacKey()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

/**
 * Decodes and verifies a signed opaque cursor string.
 * Throws BadRequestException (400 VALIDATION_FAILED) if invalid or tampered with.
 */
export function decodeCursor<T extends CursorPayload = CursorPayload>(cursor: string): T {
  if (!cursor || typeof cursor !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'مکان‌نمای صفحه‌بندی نامعتبر است.',
    });
  }

  const parts = cursor.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'فرمت مکان‌نمای صفحه‌بندی نامعتبر است.',
    });
  }

  const payloadB64 = parts[0];
  const providedHmac = parts[1];
  const expectedHmac = createHmac('sha256', getHmacKey()).update(payloadB64).digest('base64url');

  const providedBuf = Buffer.from(providedHmac, 'utf8');
  const expectedBuf = Buffer.from(expectedHmac, 'utf8');

  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'مکان‌نمای صفحه‌بندی دستکاری شده یا امضای آن نامعتبر است.',
    });
  }

  try {
    const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cursor payload must be an object');
    }
    return parsed as T;
  } catch {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'محتوای مکان‌نمای صفحه‌بندی نامعتبر است.',
    });
  }
}
