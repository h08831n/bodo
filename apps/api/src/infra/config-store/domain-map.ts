import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { isValidDatabaseName } from '@bodo/utils';
import { ConfigStoreService } from './config-store.service';

const DomainMapSchema = z.record(z.string(), z.string());

@Injectable()
export class DomainMap {
  private readonly logger = new Logger(DomainMap.name);
  private static readonly FILENAME = 'domains.json';

  constructor(private readonly configStore: ConfigStoreService) {}

  /**
   * Resolves a raw HTTP Host header to its corresponding tenant database name.
   * Strips port, lowercases, rejects wildcards, and validates the resolved database name.
   */
  async resolve(rawHost: string | undefined): Promise<string | null> {
    if (!rawHost || typeof rawHost !== 'string') {
      return null;
    }

    // 1. Normalize host: lowercase, trim, remove port
    const normalized = rawHost.trim().toLowerCase().split(':')[0];
    if (!normalized || normalized.includes('*')) {
      return null;
    }

    // 2. Read map from config store with safe empty fallback
    const map = await this.getMapping();
    const targetDb = map[normalized];

    if (!targetDb) {
      return null;
    }

    if (!isValidDatabaseName(targetDb)) {
      this.logger.warn(
        `Domain "${normalized}" maps to an invalid database name: "${targetDb}". Ignoring.`,
      );
      return null;
    }

    return targetDb;
  }

  /**
   * Returns the current valid domain mapping.
   * Safe against missing or corrupt file; logs error and returns empty record.
   */
  async getMapping(): Promise<Record<string, string>> {
    try {
      const raw = await this.configStore.read(DomainMap.FILENAME, DomainMapSchema, {});

      // Filter entries: reject wildcards and invalid database names
      const sanitized: Record<string, string> = {};
      for (const [domain, db] of Object.entries(raw)) {
        const cleanDomain = domain.trim().toLowerCase().split(':')[0];
        if (cleanDomain && !cleanDomain.includes('*') && isValidDatabaseName(db)) {
          sanitized[cleanDomain] = db;
        }
      }
      return sanitized;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error loading domain map from domains.json: ${msg}`);
      return {};
    }
  }

  /**
   * Updates or sets a domain mapping.
   */
  async setDomain(domain: string, db: string): Promise<void> {
    const cleanDomain = domain.trim().toLowerCase().split(':')[0];
    if (!cleanDomain || cleanDomain.includes('*')) {
      throw new Error(`Invalid domain name: "${domain}" (wildcards not allowed)`);
    }

    if (!isValidDatabaseName(db)) {
      throw new Error(`Invalid database name for domain mapping: "${db}"`);
    }

    const current = await this.getMapping();
    current[cleanDomain] = db;
    await this.configStore.write(DomainMap.FILENAME, current, DomainMapSchema);
  }
}
