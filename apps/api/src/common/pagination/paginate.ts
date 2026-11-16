import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor-codec';
import type { PaginatedResponse, PaginationQuery } from '@bodo/contracts';

export type SortDirection = 'asc' | 'desc';

export interface SortField {
  field: string;
  direction: SortDirection;
  nullable?: boolean;
}

export interface PaginateOptions<TModel, TWhere, TOrderBy, TSelect, TInclude> {
  model: {
    findMany: (args: {
      where?: TWhere;
      take?: number;
      orderBy?: TOrderBy;
      select?: TSelect;
      include?: TInclude;
    }) => Promise<TModel[]>;
    count?: (args: { where?: TWhere }) => Promise<number>;
  };
  query: Partial<PaginationQuery>;
  defaultSort?: SortField[];
  allowedSortFields?: Record<string, { nullable?: boolean }> | string[];
  baseWhere?: TWhere;
  select?: TSelect;
  include?: TInclude;
  idField?: string;
}

const MAX_USER_SORT_FIELDS = 3;

export function parseSortString(
  sortStr: string | undefined,
  allowedFieldsInput?: Record<string, { nullable?: boolean }> | string[],
  defaultSort: SortField[] = [{ field: 'id', direction: 'asc' }],
  idField = 'id',
): SortField[] {
  const allowedFields: Record<string, { nullable?: boolean }> | undefined = Array.isArray(
    allowedFieldsInput,
  )
    ? Object.fromEntries(allowedFieldsInput.map((f) => [f, { nullable: false }]))
    : allowedFieldsInput;

  if (!sortStr || sortStr.trim() === '') {
    const list = [...defaultSort];
    if (!list.some((s) => s.field === idField)) {
      list.push({ field: idField, direction: 'asc', nullable: false });
    }
    return list;
  }

  const parts = sortStr
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length > MAX_USER_SORT_FIELDS) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `حداکثر ${MAX_USER_SORT_FIELDS} فیلد برای مرتب‌سازی مجاز است.`,
      details: [
        {
          path: 'sort',
          message: `تعداد فیلدهای مرتب‌سازی نمی‌تواند بیشتر از ${MAX_USER_SORT_FIELDS} باشد.`,
        },
      ],
    });
  }

  const result: SortField[] = [];

  for (const part of parts) {
    const [fieldRaw, dirRaw] = part.split(':').map((s) => s.trim());
    if (!fieldRaw) continue;

    if (allowedFields && !allowedFields[fieldRaw]) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `مرتب‌سازی بر اساس فیلد '${fieldRaw}' مجاز نیست.`,
        details: [{ path: 'sort', message: `فیلد ${fieldRaw} در لیست مجاز قرار ندارد.` }],
      });
    }

    const direction: SortDirection = dirRaw?.toLowerCase() === 'desc' ? 'desc' : 'asc';
    const nullable = allowedFields?.[fieldRaw]?.nullable ?? false;
    result.push({ field: fieldRaw, direction, nullable });
  }

  // Append id as tie-breaker if not already present
  if (!result.some((s) => s.field === idField)) {
    result.push({ field: idField, direction: 'asc', nullable: false });
  }

  return result;
}

/**
 * Builds Prisma keyset where clause for a cursor and list of sort fields using NULLS LAST contract.
 */
export function buildKeysetWhere(
  cursorValues: Record<string, unknown>,
  sortFields: SortField[],
): Record<string, unknown> {
  if (sortFields.length === 0) {
    return {};
  }

  // Generate recursive or disjunctive condition:
  // (f1 > c1) OR (f1 == c1 AND f2 > c2) OR ...
  const buildStep = (index: number): Record<string, unknown>[] => {
    if (index >= sortFields.length) {
      return [];
    }

    const current = sortFields[index];
    if (!current) {
      return [];
    }
    const val = cursorValues[current.field];
    const isNullable = current.nullable ?? false;

    // Conditions where current field advances past cursor
    const advances: Record<string, unknown>[] = [];

    if (val === null || val === undefined) {
      // Current cursor value is null. Under NULLS LAST:
      // null is at the end of the list. No non-null value is after null.
      // Only equal nulls can advance on subsequent fields.
      const subsequent = buildStep(index + 1);
      if (subsequent.length > 0) {
        return [
          {
            [current.field]: null,
            OR: subsequent,
          },
        ];
      }
      return [];
    }

    // Non-null cursor value:
    if (current.direction === 'asc') {
      advances.push({ [current.field]: { gt: val } });
    } else {
      advances.push({ [current.field]: { lt: val } });
    }

    if (isNullable) {
      // Under NULLS LAST, null values come after all non-null values
      advances.push({ [current.field]: null });
    }

    // Tie condition on current field
    const subsequent = buildStep(index + 1);
    if (subsequent.length > 0) {
      advances.push({
        [current.field]: val,
        OR: subsequent,
      });
    }

    return advances;
  };

  const conditions = buildStep(0);
  if (conditions.length === 0) {
    return {};
  }
  if (conditions.length === 1 && conditions[0]) {
    return conditions[0];
  }
  return { OR: conditions };
}

/**
 * Executes a keyset-paginated query against a Prisma model delegate.
 */
export async function paginate<
  TModel extends Record<string, unknown>,
  TWhere extends Record<string, unknown> = Record<string, unknown>,
  TOrderBy = unknown,
  TSelect = unknown,
  TInclude = unknown,
>(
  options: PaginateOptions<TModel, TWhere, TOrderBy, TSelect, TInclude>,
): Promise<PaginatedResponse<TModel>> {
  const {
    model,
    query,
    defaultSort,
    allowedSortFields,
    baseWhere = {} as TWhere,
    select,
    include,
    idField = 'id',
  } = options;

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const sortFields = parseSortString(query.sort, allowedSortFields, defaultSort, idField);

  // Build Prisma orderBy array with explicit nulls: 'last'
  const orderBy = sortFields.map((s) => ({
    [s.field]: {
      sort: s.direction,
      nulls: 'last',
    },
  })) as unknown as TOrderBy;

  let where = { ...baseWhere } as Record<string, unknown>;

  if (query.cursor) {
    const cursorValues = decodeCursor(query.cursor);
    const keysetWhere = buildKeysetWhere(cursorValues, sortFields);

    if (Object.keys(keysetWhere).length > 0) {
      where = {
        AND: [baseWhere, keysetWhere],
      };
    }
  }

  // Fetch limit + 1 items to determine hasNextPage
  const itemsPlusOne = await model.findMany({
    where: where as TWhere,
    take: limit + 1,
    orderBy,
    select,
    include,
  });

  const hasNextPage = itemsPlusOne.length > limit;
  const items = hasNextPage ? itemsPlusOne.slice(0, limit) : itemsPlusOne;

  let nextCursor: string | null = null;
  if (hasNextPage && items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem) {
      const cursorValues: Record<string, unknown> = {};
      for (const s of sortFields) {
        cursorValues[s.field] = lastItem[s.field];
      }
      nextCursor = encodeCursor(cursorValues);
    }
  }

  let totalCount: number | undefined;
  if (query.withTotal && model.count) {
    totalCount = await model.count({ where: baseWhere });
  }

  return {
    items,
    nextCursor,
    prevCursor: null, // Keyset forward cursor by default
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
}
