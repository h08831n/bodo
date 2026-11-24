export interface PermissionDefinition {
  code: string;
  resource: string;
  action: string;
  module: string;
  label: string;
}

export class PermissionRegistry {
  private static readonly registry = new Map<string, PermissionDefinition>();

  /**
   * Registers an array of permission definitions during module bootstrap.
   * Throws an error immediately on duplicate code detection to fail early at boot.
   */
  static registerPermissions(definitions: PermissionDefinition[]): void {
    for (const def of definitions) {
      if (this.registry.has(def.code)) {
        throw new Error(
          `[CRITICAL BOOT ERROR] Duplicate permission code registered: "${def.code}" in module "${def.module}". Each permission code must be globally unique.`,
        );
      }
      this.registry.set(def.code, def);
    }
  }

  /**
   * Returns all registered permission definitions.
   */
  static getAllPermissions(): PermissionDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Returns a list of all registered permission codes.
   */
  static getAllPermissionCodes(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Checks if a permission code has been registered.
   */
  static isRegistered(code: string): boolean {
    return this.registry.has(code);
  }

  /**
   * Resets registry (primarily for test environments).
   */
  static reset(): void {
    this.registry.clear();
  }
}

/**
 * Baseline permission definitions from stage-1-technical-spec section 8.4
 */
export const BASELINE_PERMISSIONS: PermissionDefinition[] = [
  // User Management
  { code: 'user.read', resource: 'user', action: 'read', module: 'users', label: 'مشاهده کاربران' },
  {
    code: 'user.create',
    resource: 'user',
    action: 'create',
    module: 'users',
    label: 'ایجاد کاربر جدید',
  },
  {
    code: 'user.update',
    resource: 'user',
    action: 'update',
    module: 'users',
    label: 'ویرایش اطلاعات کاربر',
  },
  {
    code: 'user.delete',
    resource: 'user',
    action: 'delete',
    module: 'users',
    label: 'حذف یا غیرفعال‌سازی کاربر',
  },
  {
    code: 'user.manage',
    resource: 'user',
    action: 'manage',
    module: 'users',
    label: 'مدیریت کامل کاربران',
  },

  // Group Management
  {
    code: 'group.read',
    resource: 'group',
    action: 'read',
    module: 'groups',
    label: 'مشاهده گروه‌ها',
  },
  {
    code: 'group.create',
    resource: 'group',
    action: 'create',
    module: 'groups',
    label: 'ایجاد گروه جدید',
  },
  {
    code: 'group.update',
    resource: 'group',
    action: 'update',
    module: 'groups',
    label: 'ویرایش گروه و مجوزها',
  },
  {
    code: 'group.delete',
    resource: 'group',
    action: 'delete',
    module: 'groups',
    label: 'حذف گروه',
  },

  // Team Management
  { code: 'team.read', resource: 'team', action: 'read', module: 'teams', label: 'مشاهده تیم‌ها' },
  {
    code: 'team.create',
    resource: 'team',
    action: 'create',
    module: 'teams',
    label: 'ایجاد تیم جدید',
  },
  {
    code: 'team.update',
    resource: 'team',
    action: 'update',
    module: 'teams',
    label: 'ویرایش تیم و اعضا',
  },
  { code: 'team.delete', resource: 'team', action: 'delete', module: 'teams', label: 'حذف تیم' },

  // Company Settings & Currencies
  {
    code: 'company.read',
    resource: 'company',
    action: 'read',
    module: 'settings',
    label: 'مشاهده تنظیمات شرکت',
  },
  {
    code: 'company.manage',
    resource: 'company',
    action: 'manage',
    module: 'settings',
    label: 'مدیریت و ویرایش مشخصات شرکت',
  },
  {
    code: 'currency.read',
    resource: 'currency',
    action: 'read',
    module: 'settings',
    label: 'مشاهده لیست ارزها',
  },
  {
    code: 'currency.manage',
    resource: 'currency',
    action: 'manage',
    module: 'settings',
    label: 'مدیریت و تغییر وضعیت ارزها',
  },

  // Audit Logs
  {
    code: 'audit.read',
    resource: 'audit',
    action: 'read',
    module: 'audit',
    label: 'مشاهده لاگ‌های ممیزی',
  },

  // System Settings
  {
    code: 'settings.read',
    resource: 'settings',
    action: 'read',
    module: 'settings',
    label: 'مشاهده تنظیمات سیستم',
  },
  {
    code: 'settings.manage',
    resource: 'settings',
    action: 'manage',
    module: 'settings',
    label: 'مدیریت تنظیمات عمومی',
  },
];
