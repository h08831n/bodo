import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MasterAuthService } from './master-auth.service';
import { MasterAdminGuard } from './master-admin.guard';
import { AdminAuditLogger } from './admin-audit.logger';
import { AdminAuthController } from './admin-auth.controller';
import { ConfigStoreModule } from '../config-store/config-store.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [ConfigStoreModule, RedisModule],
  controllers: [AdminAuthController],
  providers: [Reflector, MasterAuthService, MasterAdminGuard, AdminAuditLogger],
  exports: [Reflector, MasterAuthService, MasterAdminGuard, AdminAuditLogger],
})
export class AdminModule {}
