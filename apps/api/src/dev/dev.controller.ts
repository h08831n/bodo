import { Controller, Get, UseGuards } from '@nestjs/common';
import { DevOnlyGuard } from '../common/guards/dev-only.guard';
import { TenantPrismaService } from '../infra/tenancy/tenant-prisma.service';

export interface TenantInfoResponse {
  database: string;
  companyName: string | null;
}

@Controller('v1/dev')
@UseGuards(DevOnlyGuard)
export class DevController {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  @Get('tenant-info')
  async getTenantInfo(): Promise<TenantInfoResponse> {
    const rawResult = await this.tenantPrisma.client.$queryRaw<
      Array<{ current_database: string }>
    >`SELECT current_database();`;

    const companyProfile = await this.tenantPrisma.client.companyProfile.findFirst();

    return {
      database: rawResult[0]?.current_database ?? '',
      companyName: companyProfile?.name ?? null,
    };
  }
}
