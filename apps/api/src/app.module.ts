import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { LoggerService } from './common/logger/logger.service';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { RedisModule } from './infra/redis/redis.module';
import { ConfigStoreModule } from './infra/config-store/config-store.module';
import { TenancyModule } from './infra/tenancy/tenancy.module';
import { TenantMiddleware } from './infra/tenancy/tenant.middleware';
import { DevModule } from './dev/dev.module';
import { AdminModule } from './infra/admin/admin.module';
import { DatabaseManagerModule } from './infra/database-manager/database-manager.module';

@Module({
  imports: [
    RedisModule,
    ConfigStoreModule,
    TenancyModule,
    HealthModule,
    DevModule,
    AdminModule,
    DatabaseManagerModule,
  ],
  providers: [LoggerService],
  exports: [LoggerService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
