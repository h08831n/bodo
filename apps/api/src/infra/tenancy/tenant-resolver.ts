import type { Request } from 'express';
import { decodeJwt } from 'jose';
import { DomainMap } from '../config-store/domain-map';

export interface TenantResolver {
  readonly name: string;
  resolve(req: Request): Promise<string | null> | string | null;
}

export class HostResolver implements TenantResolver {
  readonly name = 'host';
  constructor(private readonly domainMap: DomainMap) {}

  async resolve(req: Request): Promise<string | null> {
    const host = req.headers['host'];
    if (!host || typeof host !== 'string') return null;
    return this.domainMap.resolve(host);
  }
}

export class HeaderResolver implements TenantResolver {
  readonly name = 'header';

  resolve(req: Request): string | null {
    const rawHeader = req.headers['x-database'];
    if (!rawHeader) return null;
    const db = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof db !== 'string') return null;
    return db.trim();
  }
}

/**
 * Fallback resolver: extracts unverified tenant database claim `db` from Authorization Bearer token.
 * Strictly used ONLY for routing tenant database selection in the absence of Host or X-Database header.
 * Real signature verification, validity, and database isolation are strictly enforced by JwtAuthGuard.
 */
export class TokenClaimResolver implements TenantResolver {
  readonly name = 'token_claim';

  resolve(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
    const token = parts[1];
    if (!token) return null;

    try {
      const decoded = decodeJwt(token);
      if (
        decoded &&
        typeof decoded === 'object' &&
        'db' in decoded &&
        typeof decoded.db === 'string'
      ) {
        return decoded.db.trim();
      }
    } catch {
      return null;
    }
    return null;
  }
}
