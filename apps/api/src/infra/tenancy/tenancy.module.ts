import { Module, Global } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ConfigStoreModule } from '../config-store/config-store.module';
import { TenantClientManager } from './tenant-client-manager';
import { TenantPrismaService } from './tenant-prisma.service';
import { MaintenanceService } from './maintenance.service';
import { DatabaseRegistryService } from './database-registry.service';
import { TenantRunnerService } from './tenant-runner.service';
import { MigrationRunnerService } from './migration-runner.service';
import { TenantMiddleware } from './tenant.middleware';

@Global()
@Module({
  imports: [RedisModule, ConfigStoreModule],
  providers: [
    TenantClientManager,
    TenantPrismaService,
    MaintenanceService,
    DatabaseRegistryService,
    TenantRunnerService,
    MigrationRunnerService,
    TenantMiddleware,
  ],
  exports: [
    TenantClientManager,
    TenantPrismaService,
    MaintenanceService,
    DatabaseRegistryService,
    TenantRunnerService,
    MigrationRunnerService,
    TenantMiddleware,
  ],
})
export class TenancyModule {}
