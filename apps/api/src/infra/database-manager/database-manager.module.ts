import { Module } from '@nestjs/common';
import { DatabaseManagerService } from './database-manager.service';
import { DatabaseManagerController } from './database-manager.controller';
import { PublicTenantController } from './public-tenant.controller';
import { JobQueueService } from './job-queue.service';
import { PgToolsModule } from '../pg-tools/pg-tools.module';
import { ZipService } from '../backup/zip.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConfigStoreModule } from '../config-store/config-store.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [PgToolsModule, TenancyModule, ConfigStoreModule, AdminModule],
  controllers: [DatabaseManagerController, PublicTenantController],
  providers: [DatabaseManagerService, JobQueueService, ZipService],
  exports: [DatabaseManagerService, JobQueueService, ZipService],
})
export class DatabaseManagerModule {}
