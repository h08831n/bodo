import { createZodDto } from 'nestjs-zod';
import { AdminLoginRequestSchema, ChangeMasterPasswordRequestSchema } from '@bodo/contracts';

export class AdminLoginDto extends createZodDto(AdminLoginRequestSchema) {}
export class ChangeMasterPasswordDto extends createZodDto(ChangeMasterPasswordRequestSchema) {}
