import type { Request } from 'express';
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
