import { Module, Global } from '@nestjs/common';
import { PgToolsService } from './pg-tools.service';

@Global()
@Module({
  providers: [PgToolsService],
  exports: [PgToolsService],
})
export class PgToolsModule {}
