import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { tenantKey } from '../../infra/redis/redis-keys';
import { TenantClientManager } from '../../infra/tenancy/tenant-client-manager';
import { PermissionRegistry } from './permission-registry';

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);
  private readonly CACHE_TTL_SEC = 300; // 5 minutes cache

  constructor(
    private readonly redisService: RedisService,
    private readonly tenantClientManager: TenantClientManager,
  ) {}

  /**
   * Resolves effective permissions for a user:
   * 1. Checks Redis cache.
   * 2. Evaluates user groups: If user belongs to a system group (isSystem: true),
   *    they dynamically receive ALL currently registered permissions.
   * 3. Otherwise, unions permissions from all assigned active groups.
   * 4. Caches in Redis for 5 minutes.
   */
  async getUserPermissions(db: string, userId: string): Promise<string[]> {
    const key = tenantKey(db, 'permissions', 'user', userId);

    try {
      const redis = this.redisService.getClient();
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as string[];
      }
    } catch {
      // Redis cache read error should not stop permission calculation
    }

    const client = await this.tenantClientManager.getClient(db);

    const userWithGroups = await client.user.findUnique({
      where: { id: userId },
      include: {
        groupMembers: {
          include: {
            group: {
              include: {
                permissions: true,
              },
            },
          },
        },
      },
    });

    if (!userWithGroups || userWithGroups.status !== 'ACTIVE') {
      return [];
    }

    const assignedGroups = userWithGroups.groupMembers.map((gm) => gm.group);

    // If user belongs to any system group (e.g. system admin), grant ALL registered permissions dynamically
    const hasSystemGroup = assignedGroups.some((g) => g.isSystem);
    let effectivePermissions: string[] = [];

    if (hasSystemGroup) {
      effectivePermissions = PermissionRegistry.getAllPermissionCodes();
    } else {
      const permsSet = new Set<string>();
      for (const group of assignedGroups) {
        for (const p of group.permissions) {
          permsSet.add(p.permissionCode);
        }
      }
      effectivePermissions = Array.from(permsSet);
    }

    try {
      const redis = this.redisService.getClient();
      await redis.set(key, JSON.stringify(effectivePermissions), 'EX', this.CACHE_TTL_SEC);
    } catch {
      // Redis cache write error should not fail request
    }

    return effectivePermissions;
  }

  /**
   * Invalidates cached permissions for a specific user.
   */
  async invalidateUser(db: string, userId: string): Promise<void> {
    try {
      const redis = this.redisService.getClient();
      const key = tenantKey(db, 'permissions', 'user', userId);
      await redis.del(key);
    } catch (err) {
      this.logger.warn(`Failed to invalidate cached permissions for user ${userId} on ${db}:`, err);
    }
  }

  async invalidateUserPermissionCache(db: string, userId: string): Promise<void> {
    return this.invalidateUser(db, userId);
  }

  /**
   * Invalidates all cached permissions across the tenant database.
   */
  async invalidateAll(db: string): Promise<void> {
    try {
      const redis = this.redisService.getClient();
      const pattern = tenantKey(db, 'permissions', 'user', '*');
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      this.logger.warn(`Failed to invalidate all cached permissions on ${db}:`, err);
    }
  }
}
