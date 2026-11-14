import { ConflictException, NotFoundException } from '@nestjs/common';

export interface OptimisticLockModel<T> {
  updateMany(args: {
    where: { id: string | number; version: number; [key: string]: unknown };
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUnique(args: { where: { id: string | number; [key: string]: unknown } }): Promise<T | null>;
}

export interface UpdateWithVersionOptions<T> {
  model: OptimisticLockModel<T>;
  where: { id: string | number; version: number };
  data: Record<string, unknown>;
  versionField?: string;
  notFoundMessage?: string;
  conflictMessage?: string;
}

/**
 * Executes an atomic update guarded by an optimistic locking version number.
 * Increments the version upon update. If version mismatch occurs, throws VERSION_CONFLICT (409).
 */
export async function updateWithVersion<T>(options: UpdateWithVersionOptions<T>): Promise<T> {
  const {
    model,
    where,
    data,
    versionField = 'version',
    notFoundMessage = 'منبع مورد نظر یافت نشد.',
    conflictMessage = 'تداخل نسخه‌بندی رخ داده است. داده‌ها توسط فرآیند دیگری تغییر یافته‌اند.',
  } = options;

  const currentVersion = where.version;
  const nextVersion = currentVersion + 1;

  const updateResult = await model.updateMany({
    where: {
      id: where.id,
      version: currentVersion,
      [versionField]: currentVersion,
    },
    data: {
      ...data,
      [versionField]: nextVersion,
    },
  });

  if (updateResult.count === 0) {
    const existing = await model.findUnique({
      where: { id: where.id },
    });

    if (!existing) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: notFoundMessage,
      });
    }

    throw new ConflictException({
      code: 'VERSION_CONFLICT',
      message: conflictMessage,
    });
  }

  const updated = await model.findUnique({
    where: { id: where.id },
  });

  return updated as T;
}

/**
 * Generates an HTTP ETag string for a given version.
 */
export function generateETag(version: number | string): string {
  return `W/"${version}"`;
}

/**
 * Parses an incoming If-Match HTTP header into an integer version.
 */
export function parseIfMatch(ifMatchHeader?: string): number | null {
  if (!ifMatchHeader || typeof ifMatchHeader !== 'string') {
    return null;
  }
  const clean = ifMatchHeader.replace(/^W\//, '').replace(/"/g, '').trim();
  const parsed = parseInt(clean, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
