import { Injectable } from '@nestjs/common';
import { TenantPrismaService, TenantTransactionService } from '../../infra/tenancy';
import { CreateTemplateDto } from './dto/create-template.dto';

@Injectable()
export class TemplateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly txService: TenantTransactionService,
  ) {}

  async create(data: CreateTemplateDto) {
    return this.txService.run(async () => {
      // Execute in transaction using tenantPrisma
      return { id: 'temp_1', ...data, createdAt: new Date() };
    });
  }

  async findAll() {
    return [];
  }
}
