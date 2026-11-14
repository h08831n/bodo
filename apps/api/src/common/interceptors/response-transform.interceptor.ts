import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Recursively transforms output values:
 * - Date -> ISO-8601 string with UTC 'Z'
 * - BigInt -> string
 * - Decimal (Prisma or string/number wrapped) -> string
 * - undefined properties -> stripped
 */
export function transformResponseValue(val: unknown): unknown {
  if (val === null || val === undefined) {
    return val;
  }

  if (typeof val === 'bigint') {
    return val.toString();
  }

  if (val instanceof Date) {
    return val.toISOString();
  }

  // Handle Prisma Decimal or similar objects
  if (
    typeof val === 'object' &&
    val !== null &&
    ('toFixed' in val || 'toNumber' in val || 'd' in val) &&
    typeof (val as { toString?: () => string }).toString === 'function' &&
    !(val instanceof Date) &&
    !Array.isArray(val)
  ) {
    const str = (val as { toString: () => string }).toString();
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      return str;
    }
  }

  if (Array.isArray(val)) {
    return val.map(transformResponseValue);
  }

  if (isPlainObject(val)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        result[k] = transformResponseValue(v);
      }
    }
    return result;
  }

  return val;
}

@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => transformResponseValue(data)));
  }
}
