import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_PIPE, APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { HealthModule } from './health/health.module';
import { LoggerService } from './common/logger/logger.service';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { ContentTypeValidationMiddleware } from './common/middleware/content-type.middleware';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { RedisModule } from './infra/redis/redis.module';
import { ConfigStoreModule } from './infra/config-store/config-store.module';
import { TenancyModule } from './infra/tenancy/tenancy.module';
import { TenantMiddleware } from './infra/tenancy/tenant.middleware';
import { DevModule } from './dev/dev.module';
import { AdminModule } from './infra/admin/admin.module';
import { DatabaseManagerModule } from './infra/database-manager/database-manager.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { UserTypeGuard } from './common/guards/user-type.guard';
import { PasswordChangeGuard } from './common/guards/password-change.guard';
import { PermissionGuard } from './common/guards/permission.guard';

@Module({
  imports: [
    RedisModule,
    ConfigStoreModule,
    TenancyModule,
    RateLimitModule,
    AuthModule,
    HealthModule,
    DevModule,
    AdminModule,
    DatabaseManagerModule,
  ],
  providers: [
    LoggerService,
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: UserTypeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PasswordChangeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
  exports: [LoggerService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
    consumer.apply(ContentTypeValidationMiddleware).forRoutes('*');
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
