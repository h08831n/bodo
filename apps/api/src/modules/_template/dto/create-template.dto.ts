import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateTemplateRequestSchema = z.object({
  name: z.string().min(1, 'نام الزامی است'),
  description: z.string().optional(),
});

export class CreateTemplateDto extends createZodDto(CreateTemplateRequestSchema) {}
