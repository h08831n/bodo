import { createZodDto } from 'nestjs-zod';
import {
  CreateDatabaseRequestSchema,
  DuplicateDatabaseRequestSchema,
  RestoreDatabaseRequestSchema,
  DeleteDatabaseRequestSchema,
  UpgradeDatabaseRequestSchema,
  RepairDatabaseRequestSchema,
  SetMaintenanceRequestSchema,
  SetDomainRequestSchema,
} from '@bodo/contracts';

export class CreateDatabaseDto extends createZodDto(CreateDatabaseRequestSchema) {}
export class DuplicateDatabaseDto extends createZodDto(DuplicateDatabaseRequestSchema) {}
export class RestoreDatabaseDto extends createZodDto(RestoreDatabaseRequestSchema) {}
export class DeleteDatabaseDto extends createZodDto(DeleteDatabaseRequestSchema) {}
export class UpgradeDatabaseDto extends createZodDto(UpgradeDatabaseRequestSchema) {}
export class RepairDatabaseDto extends createZodDto(RepairDatabaseRequestSchema) {}
export class SetMaintenanceDto extends createZodDto(SetMaintenanceRequestSchema) {}
export class SetDomainDto extends createZodDto(SetDomainRequestSchema) {}
