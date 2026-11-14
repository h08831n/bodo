import { Controller, Get, Req, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { getEnv } from '../../config/env.config';
import { DatabaseManagerService } from './database-manager.service';
import { DomainMap } from '../config-store/domain-map';

@Controller('v1/public')
export class PublicTenantController {
  constructor(
    private readonly dbManager: DatabaseManagerService,
    private readonly domainMap: DomainMap,
  ) {}

  @Get('databases')
  @HttpCode(HttpStatus.OK)
  async listPublicDatabases(): Promise<string[]> {
    const env = getEnv();
    if (!env.DB_LIST_PUBLIC) {
      throw new NotFoundException();
    }

    const dbs = await this.dbManager.listDatabases();
    // Return only active slugs, never company names or private metadata
    return dbs.filter((d) => d.state === 'active').map((d) => d.slug);
  }

  @Get('tenant-by-host')
  @HttpCode(HttpStatus.OK)
  async getTenantByHost(@Req() req: Request): Promise<{ database: string | null }> {
    const hostHeader = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
    const cleanHost = (hostHeader.split(':')[0] || '').toLowerCase().trim();

    if (!cleanHost) {
      return { database: null };
    }

    const slug = await this.domainMap.findDatabaseByHost(cleanHost);
    return { database: slug || null };
  }
}
