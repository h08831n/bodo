import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).optional(),
  sort: z.string().trim().min(1).optional(),
  withTotal: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const lower = val.toLowerCase().trim();
        return lower === 'true' || lower === '1';
      }
      return Boolean(val);
    }, z.boolean())
    .optional()
    .default(false),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function paginated<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative().optional(),
  });
}

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  totalCount?: number;
};
