import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';
import { TenancyModule } from '../infra/tenancy/tenancy.module';

@Module({
  imports: [TenancyModule],
  controllers: [DevController],
})
export class DevModule {}
