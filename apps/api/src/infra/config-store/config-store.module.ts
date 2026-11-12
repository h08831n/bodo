import { Module, Global } from '@nestjs/common';
import { ConfigStoreService } from './config-store.service';
import { DomainMap } from './domain-map';

@Global()
@Module({
  providers: [ConfigStoreService, DomainMap],
  exports: [ConfigStoreService, DomainMap],
})
export class ConfigStoreModule {}
