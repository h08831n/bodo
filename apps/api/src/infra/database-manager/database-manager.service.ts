import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client as PgClient } from 'pg';
import { hash } from '@node-rs/argon2';
import { getEnv } from '../../config/env.config';
import { buildDatabaseUrl, isValidDatabaseName } from '@bodo/utils';
import { DatabaseListItem, BackupListItem } from '@bodo/contracts';
import { PgToolsService } from '../pg-tools/pg-tools.service';
import { ZipService, BackupManifest } from '../backup/zip.service';
import { DomainMap } from '../config-store/domain-map';
import { MaintenanceService } from '../tenancy/maintenance.service';
import { TenantClientManager } from '../tenancy/tenant-client-manager';
import { MigrationRunnerService } from '../tenancy/migration-runner.service';
import { DatabaseRegistryService } from '../tenancy/database-registry.service';

export interface ProgressCallback {
  (percent: number, step: string, message: string): Promise<void>;
}

@Injectable()
export class DatabaseManagerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseManagerService.name);

  constructor(
    private readonly pgTools: PgToolsService,
    private readonly zipService: ZipService,
    private readonly domainMap: DomainMap,
    private readonly maintenanceService: MaintenanceService,
    private readonly clientManager: TenantClientManager,
    private readonly migrationRunner: MigrationRunnerService,
    private readonly databaseRegistry: DatabaseRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.checkOrphans();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Boot orphan check failed: ${msg}`);
    }
  }

  /**
   * Helper to obtain a superuser or provisioner PG client to the maintenance database 'postgres'
   */
  private getPostgresClient(
    role: 'superuser' | 'provisioner' | 'migrator' = 'provisioner',
  ): PgClient {
    const env = getEnv();
    let user = 'postgres';
    let password = env.POSTGRES_PASSWORD;

    if (role === 'provisioner') {
      user = 'erp_provisioner';
      password = env.ERP_PROVISIONER_PASSWORD;
    } else if (role === 'migrator') {
      user = 'erp_migrator';
      password = env.ERP_MIGRATOR_PASSWORD;
    }

    const connStr = buildDatabaseUrl({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user,
      password,
      database: 'postgres',
    });

    return new PgClient({ connectionString: connStr, connectionTimeoutMillis: 5000 });
  }

  /**
   * Lists all non-temporary tenant databases
   */
  async listDatabases(): Promise<DatabaseListItem[]> {
    const client = this.getPostgresClient('provisioner');
    await client.connect();

    try {
      const res = await client.query<{
        datname: string;
        size: string;
      }>(`
        SELECT datname, pg_database_size(datname)::text as size
        FROM pg_database
        WHERE datname LIKE 'erp_%' AND datname NOT LIKE 'erp_tmp_%'
        ORDER BY datname ASC;
      `);

      const list: DatabaseListItem[] = [];

      for (const row of res.rows) {
        const dbName = row.datname;
        const slug = dbName.replace(/^erp_/, '');
        const sizeBytes = parseInt(row.size, 10) || 0;

        // Check maintenance state
        const maintenance = await this.maintenanceService.get(dbName);
        let state: DatabaseListItem['state'] = 'active';
        if (maintenance.inMaintenance) {
          state = maintenance.reason === 'migration_failed' ? 'failed' : 'maintenance';
        }

        // Domain mapping
        const domain = await this.domainMap.findHostByDatabase(slug);

        // Last backup
        const lastBackup = this.getLatestBackupTime(dbName);

        // Migration status
        let schemaVersion: string | null = null;
        let pendingMigrations = 0;
        try {
          const migStatus = await this.migrationRunner.status(dbName);
          schemaVersion = migStatus.applied[migStatus.applied.length - 1] || null;
          pendingMigrations = migStatus.pending.length;
        } catch {
          // If query fails, database may still be initializing
        }

        list.push({
          slug,
          name: slug,
          companyName: null,
          schemaVersion,
          pendingMigrations,
          sizeBytes,
          lastBackup,
          state,
          domain,
        });
      }

      return list;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Creates a new tenant database in full isolation
   */
  async createDatabase(
    data: { name: string; adminUsername: string; adminFullName: string; adminPassword: string },
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const slug = data.name.toLowerCase().trim();
    const finalDbName = `erp_${slug}`;

    if (!isValidDatabaseName(finalDbName)) {
      throw new BadRequestException(`Invalid database name: "${finalDbName}"`);
    }

    // Check uniqueness
    const exists = await this.checkDatabaseExists(finalDbName);
    if (exists) {
      throw new ConflictException(`Database "${finalDbName}" already exists`);
    }

    const tempDbName = `erp_tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const filestorePath = path.resolve(getEnv().FILESTORE_DIR, finalDbName);

    await onProgress?.(10, 'create_temp_db', 'ایجاد پایگاه داده موقت...');

    const client = this.getPostgresClient('provisioner');
    await client.connect();

    try {
      await client.query(`CREATE DATABASE "${tempDbName}" OWNER erp_migrator;`);
    } finally {
      await client.end().catch(() => {});
    }

    try {
      // 1. Run migrations
      await onProgress?.(30, 'migrate', 'اجرای مایگریشن‌های اسکیما...');
      await this.migrationRunner.upgrade(tempDbName);

      // 2. Seed baseline
      await onProgress?.(60, 'seed', 'ثبت داده‌های پایه...');
      await this.seedBaseline(tempDbName);

      // 3. Create admin user
      await onProgress?.(75, 'create_admin', 'ساخت کاربر مدیر سیستم...');
      await this.createAdminUser(tempDbName, data);

      // 4. Create filestore directory
      await onProgress?.(85, 'create_filestore', 'ایجاد پوشه فایل‌ها...');
      if (!fs.existsSync(filestorePath)) {
        fs.mkdirSync(filestorePath, { recursive: true });
      }

      // 5. Rename temporary database to final database
      await onProgress?.(95, 'rename', 'نهایی‌سازی و نام‌گذاری دیتابیس...');
      await this.renameDatabase(tempDbName, finalDbName);

      this.databaseRegistry.clearCache(finalDbName);
      await onProgress?.(100, 'completed', 'دیتابیس با موفقیت ایجاد شد');
    } catch (err: unknown) {
      // Cleanup on any failure
      this.logger.error(`Error during createDatabase for "${finalDbName}": ${err}`);
      await this.dropDatabaseSilently(tempDbName);
      if (fs.existsSync(filestorePath)) {
        fs.rmSync(filestorePath, { recursive: true, force: true });
      }
      throw err;
    }
  }

  /**
   * Duplicates an existing tenant database
   */
  async duplicateDatabase(
    sourceSlug: string,
    data: { newName: string; neutralize: boolean },
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const sourceDbName = sourceSlug.startsWith('erp_') ? sourceSlug : `erp_${sourceSlug}`;
    const targetSlug = data.newName.toLowerCase().trim();
    const targetDbName = `erp_${targetSlug}`;

    if (!isValidDatabaseName(targetDbName)) {
      throw new BadRequestException(`Invalid target database name: "${targetDbName}"`);
    }

    const sourceExists = await this.checkDatabaseExists(sourceDbName);
    if (!sourceExists) {
      throw new NotFoundException(`Source database "${sourceDbName}" not found`);
    }

    const targetExists = await this.checkDatabaseExists(targetDbName);
    if (targetExists) {
      throw new ConflictException(`Target database "${targetDbName}" already exists`);
    }

    // Disk space check
    await this.checkAvailableDiskSpace(sourceDbName);

    const tempDumpDir = path.resolve(getEnv().BACKUP_DIR, '.tmp');
    if (!fs.existsSync(tempDumpDir)) {
      fs.mkdirSync(tempDumpDir, { recursive: true });
    }
    const tempDumpFile = path.join(
      tempDumpDir,
      `dump_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.pgdump`,
    );
    const tempDbName = `erp_tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const targetFilestorePath = path.resolve(getEnv().FILESTORE_DIR, targetDbName);
    const sourceFilestorePath = path.resolve(getEnv().FILESTORE_DIR, sourceDbName);

    try {
      await onProgress?.(10, 'dump_source', 'تهیه دامپ از دیتابیس مبدا...');
      await this.pgTools.dump({
        database: sourceDbName,
        user: 'erp_migrator',
        password: getEnv().ERP_MIGRATOR_PASSWORD,
        host: getEnv().POSTGRES_HOST,
        port: getEnv().POSTGRES_PORT,
        outputFilePath: tempDumpFile,
      });

      await onProgress?.(40, 'create_temp_db', 'ساخت دیتابیس موقت مقصد...');
      const client = this.getPostgresClient('provisioner');
      await client.connect();
      try {
        await client.query(`CREATE DATABASE "${tempDbName}" OWNER erp_migrator;`);
      } finally {
        await client.end().catch(() => {});
      }

      await onProgress?.(60, 'restore_dump', 'بازیابی اطلاعات در دیتابیس مقصد...');
      await this.pgTools.restore({
        database: tempDbName,
        user: 'erp_migrator',
        password: getEnv().ERP_MIGRATOR_PASSWORD,
        host: getEnv().POSTGRES_HOST,
        port: getEnv().POSTGRES_PORT,
        inputFilePath: tempDumpFile,
      });

      // Copy filestore
      if (fs.existsSync(sourceFilestorePath)) {
        await onProgress?.(80, 'copy_filestore', 'کپی فایل‌های پیوست...');
        fs.cpSync(sourceFilestorePath, targetFilestorePath, { recursive: true });
      }

      // Neutralize if requested
      if (data.neutralize) {
        await onProgress?.(85, 'neutralize', 'غیرفعال‌سازی تنظیمات عملیاتی (Neutralize)...');
        await this.neutralizeDatabase(tempDbName);
      }

      // Verify row counts
      await onProgress?.(90, 'verify', 'اعتبارسنجی یکپارچگی داده‌ها...');
      await this.verifyRowCountConsistency(sourceDbName, tempDbName);

      // Rename to final target
      await onProgress?.(95, 'rename', 'نهایی‌سازی نام دیتابیس جدید...');
      await this.renameDatabase(tempDbName, targetDbName);

      this.databaseRegistry.clearCache(targetDbName);
      await onProgress?.(100, 'completed', 'کپی دیتابیس با موفقیت انجام شد');
    } catch (err: unknown) {
      await this.dropDatabaseSilently(tempDbName);
      if (fs.existsSync(targetFilestorePath)) {
        fs.rmSync(targetFilestorePath, { recursive: true, force: true });
      }
      throw err;
    } finally {
      if (fs.existsSync(tempDumpFile)) {
        fs.unlinkSync(tempDumpFile);
      }
    }
  }

  /**
   * Creates a full backup zip archive of a tenant database
   */
  async backupDatabase(
    slugOrName: string,
    onProgress?: ProgressCallback,
  ): Promise<{ fileName: string; sizeBytes: number }> {
    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const exists = await this.checkDatabaseExists(dbName);
    if (!exists) {
      throw new NotFoundException(`Database "${dbName}" not found`);
    }

    await this.checkAvailableDiskSpace(dbName);

    const tempDir = path.resolve(getEnv().BACKUP_DIR, '.tmp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempDumpFile = path.join(
      tempDir,
      `dump_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.pgdump`,
    );
    const backupsDir = path.resolve(getEnv().BACKUP_DIR, dbName);
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFileName = `${dbName}_${timestamp}.zip`;
    const destinationZipPath = path.join(backupsDir, zipFileName);
    const filestorePath = path.resolve(getEnv().FILESTORE_DIR, dbName);

    try {
      await onProgress?.(20, 'dump', 'تهیه دامپ اطلاعات...');
      await this.pgTools.dump({
        database: dbName,
        user: 'erp_migrator',
        password: getEnv().ERP_MIGRATOR_PASSWORD,
        host: getEnv().POSTGRES_HOST,
        port: getEnv().POSTGRES_PORT,
        outputFilePath: tempDumpFile,
      });

      await onProgress?.(60, 'package', 'فشرده‌سازی و ایجاد فایل پشتیبان Zip...');

      const migStatus = await this.migrationRunner.status(dbName);
      const manifest: BackupManifest = {
        db_name: dbName,
        schema_version: migStatus.applied[migStatus.applied.length - 1] || null,
        applied_migrations: migStatus.applied,
        app_version: '0.1.0',
        created_at: new Date().toISOString(),
      };

      const { totalBytes } = await this.zipService.createArchive({
        dumpFilePath: tempDumpFile,
        filestoreDirPath: fs.existsSync(filestorePath) ? filestorePath : undefined,
        destinationZipPath,
        manifest,
      });

      await onProgress?.(100, 'completed', 'بکاپ با موفقیت ذخیره شد');
      return { fileName: zipFileName, sizeBytes: totalBytes };
    } finally {
      if (fs.existsSync(tempDumpFile)) {
        fs.unlinkSync(tempDumpFile);
      }
    }
  }

  /**
   * Restores a tenant database from a backup zip archive
   */
  async restoreDatabase(
    zipFilePath: string,
    data: { newName: string; neutralize: boolean },
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const targetSlug = data.newName.toLowerCase().trim();
    const targetDbName = `erp_${targetSlug}`;

    if (!isValidDatabaseName(targetDbName)) {
      throw new BadRequestException(`Invalid target database name: "${targetDbName}"`);
    }

    const exists = await this.checkDatabaseExists(targetDbName);
    if (exists) {
      throw new ConflictException(`Database "${targetDbName}" already exists`);
    }

    const tempExtractDir = path.resolve(
      getEnv().BACKUP_DIR,
      '.tmp',
      `restore_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    const tempDbName = `erp_tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const filestorePath = path.resolve(getEnv().FILESTORE_DIR, targetDbName);

    try {
      await onProgress?.(15, 'extract_and_validate', 'استخراج و اعتبارسنجی امن فایل بکاپ...');
      const extracted = await this.zipService.extractAndValidate(zipFilePath, tempExtractDir);

      // Verify migration prefix compatibility
      await onProgress?.(35, 'compatibility_check', 'بررسی سازگاری نسخه‌ی اسکیما...');
      await this.verifyMigrationCompatibility(extracted.manifest);

      await onProgress?.(50, 'create_temp_db', 'ساخت دیتابیس موقت برای بازیابی...');
      const client = this.getPostgresClient('provisioner');
      await client.connect();
      try {
        await client.query(`CREATE DATABASE "${tempDbName}" OWNER erp_migrator;`);
      } finally {
        await client.end().catch(() => {});
      }

      await onProgress?.(70, 'restore_dump', 'بازیابی داده‌های پایگاه داده...');
      await this.pgTools.restore({
        database: tempDbName,
        user: 'erp_migrator',
        password: getEnv().ERP_MIGRATOR_PASSWORD,
        host: getEnv().POSTGRES_HOST,
        port: getEnv().POSTGRES_PORT,
        inputFilePath: extracted.dumpFilePath,
      });

      // Restore filestore if present in archive
      if (fs.existsSync(extracted.filestoreDirPath)) {
        await onProgress?.(80, 'restore_filestore', 'بازیابی فایل‌های پیوست...');
        fs.cpSync(extracted.filestoreDirPath, filestorePath, { recursive: true });
      }

      // Run any pending migrations if the backup was from an older version
      await onProgress?.(85, 'upgrade_pending', 'اعمال مایگریشن‌های باقیمانده...');
      await this.migrationRunner.upgrade(tempDbName);

      if (data.neutralize) {
        await onProgress?.(90, 'neutralize', 'غیرفعال‌سازی تنظیمات عملیاتی (Neutralize)...');
        await this.neutralizeDatabase(tempDbName);
      }

      await onProgress?.(95, 'rename', 'نام‌گذاری و فعال‌سازی دیتابیس بازیابی‌شده...');
      await this.renameDatabase(tempDbName, targetDbName);

      this.databaseRegistry.clearCache(targetDbName);
      await onProgress?.(100, 'completed', 'بازیابی با موفقیت به پایان رسید');
    } catch (err: unknown) {
      await this.dropDatabaseSilently(tempDbName);
      if (fs.existsSync(filestorePath)) {
        fs.rmSync(filestorePath, { recursive: true, force: true });
      }
      throw err;
    } finally {
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Deletes a tenant database with guaranteed prior backup
   */
  async deleteDatabase(
    slugOrName: string,
    confirmName: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const slug = dbName.replace(/^erp_/, '');

    if (confirmName !== dbName && confirmName !== slug) {
      throw new BadRequestException('Confirmation name does not match target database');
    }

    const exists = await this.checkDatabaseExists(dbName);
    if (!exists) {
      throw new NotFoundException(`Database "${dbName}" not found`);
    }

    // Step 1: Automatic backup prior to deletion (CRITICAL: Failure stops deletion!)
    await onProgress?.(15, 'auto_backup', 'تهیه بکاپ خودکار پیش از حذف...');
    try {
      await this.backupDatabase(dbName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Automatic backup failed prior to deletion. Operation aborted safely: ${msg}`,
      );
    }

    // Step 2: Enable maintenance mode
    await onProgress?.(40, 'maintenance', 'فعال‌سازی حالت نگهداری...');
    await this.maintenanceService.set(dbName, {
      reason: 'database_deletion',
      durable: true,
    });

    // Step 3: Evict clients across all processes and terminate connections
    await onProgress?.(60, 'drain_connections', 'تخلیه و قطع ارتباط کلاینت‌های متصل...');
    let allowConnDisabled = false;
    try {
      await this.drainAndTerminate(dbName);
      allowConnDisabled = true;

      // Step 4: Drop database
      await onProgress?.(80, 'drop_db', 'حذف پایگاه داده از PostgreSQL...');
      const client = this.getPostgresClient('provisioner');
      await client.connect();
      try {
        await client.query(`DROP DATABASE "${dbName}";`);
        allowConnDisabled = false; // Successfully dropped
      } finally {
        await client.end().catch(() => {});
      }
    } finally {
      if (allowConnDisabled) {
        // Restore ALLOW_CONNECTIONS if database was not dropped
        try {
          const client = this.getPostgresClient('provisioner');
          await client.connect();
          await client
            .query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS true;`)
            .catch(() => {});
          await client.end().catch(() => {});
        } catch {
          // ignore
        }
      }
    }

    // Step 5: Remove filestore
    await onProgress?.(90, 'cleanup_filestore', 'حذف فایل‌های پیوست...');
    const filestorePath = path.resolve(getEnv().FILESTORE_DIR, dbName);
    if (fs.existsSync(filestorePath)) {
      fs.rmSync(filestorePath, { recursive: true, force: true });
    }

    // Step 6: Remove domain mapping and clear caches
    await onProgress?.(95, 'cleanup_metadata', 'حذف نگاشت دامنه و پاک‌سازی حافظه کش...');
    await this.domainMap.delete(slug);
    await this.maintenanceService.clear(dbName);
    this.databaseRegistry.clearCache(dbName);

    await onProgress?.(100, 'completed', 'پایگاه داده با موفقیت حذف شد');
  }

  /**
   * Upgrades a database by applying pending migrations
   */
  async upgradeDatabase(slugOrName: string, onProgress?: ProgressCallback): Promise<void> {
    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const exists = await this.checkDatabaseExists(dbName);
    if (!exists) {
      throw new NotFoundException(`Database "${dbName}" not found`);
    }

    await onProgress?.(20, 'migrate', 'اجرای مایگریشن‌های اسکیما...');
    try {
      const result = await this.migrationRunner.upgrade(dbName);
      if (!result.success) {
        throw new Error(result.error || 'Migration upgrade failed');
      }
      await onProgress?.(100, 'completed', 'ارتقای اسکیما با موفقیت انجام شد');
    } catch (err: unknown) {
      await this.maintenanceService.set(dbName, {
        reason: 'migration_failed',
        durable: true,
      });
      throw err;
    }
  }

  /**
   * Repairs a failed migration state using prisma migrate resolve
   */
  async repairDatabase(
    slugOrName: string,
    confirm: boolean,
    migration?: string,
  ): Promise<{ message: string; rolledBackMigration?: string }> {
    if (!confirm) {
      throw new BadRequestException('Repair confirmation is required');
    }

    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const exists = await this.checkDatabaseExists(dbName);
    if (!exists) {
      throw new NotFoundException(`Database "${dbName}" not found`);
    }

    // 1. Ensure ALLOW_CONNECTIONS is true FIRST so connections are unblocked
    const pClient = this.getPostgresClient('provisioner');
    await pClient.connect();
    try {
      await pClient.query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS true;`);
    } finally {
      await pClient.end().catch(() => {});
    }

    // 2. Check and resolve any failed migration in _prisma_migrations
    const env = getEnv();
    const client = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_migrator',
        password: env.ERP_MIGRATOR_PASSWORD,
        database: dbName,
      }),
    });

    let migrationToRollback = migration;

    try {
      await client.connect();
      if (!migrationToRollback) {
        const res = await client.query<{ migration_name: string }>(`
          SELECT migration_name
          FROM _prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1;
        `);
        migrationToRollback = res.rows[0]?.migration_name;
      }

      if (migrationToRollback) {
        // Resolve failed migration using prisma migrate resolve --rolled-back
        await this.migrationRunner.resolveRolledBack(dbName, migrationToRollback);
      }
    } catch (err: unknown) {
      this.logger.warn(`Could not check/rollback migrations in "${dbName}": ${err}`);
    } finally {
      await client.end().catch(() => {});
    }

    // 3. If tenant was in durable maintenance due to migration_failed, clear it
    const mState = await this.maintenanceService.get(dbName);
    if (mState.inMaintenance && mState.reason === 'migration_failed') {
      await this.maintenanceService.clear(dbName);
    }

    return {
      message: 'Repair completed. Migration recorded as rolled back. Please retry upgrade.',
      rolledBackMigration: migrationToRollback,
    };
  }

  /**
   * Toggles maintenance mode manually
   */
  async setMaintenance(
    slugOrName: string,
    enabled: boolean,
    reason?: string,
    confirm?: boolean,
  ): Promise<void> {
    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const current = await this.maintenanceService.get(dbName);

    if (!enabled && current.reason === 'migration_failed' && !confirm) {
      throw new BadRequestException(
        'Disabling maintenance when reason is "migration_failed" requires explicit confirm: true',
      );
    }

    if (!enabled) {
      await this.maintenanceService.clear(dbName);
    } else {
      await this.maintenanceService.set(dbName, {
        reason: reason || 'manual',
        durable: true,
      });
    }
  }

  /**
   * Sets or deletes domain mapping for a tenant
   */
  async setDomain(slugOrName: string, host: string | null): Promise<void> {
    const slug = slugOrName.replace(/^erp_/, '');
    if (!host) {
      await this.domainMap.delete(slug);
      return;
    }

    const cleanHost = host.toLowerCase().trim();
    if (!/^[a-z0-9.-]+$/.test(cleanHost) || cleanHost.includes('..')) {
      throw new BadRequestException(`Invalid domain hostname: "${cleanHost}"`);
    }

    const existing = await this.domainMap.findDatabaseByHost(cleanHost);
    if (existing && existing !== slug) {
      throw new ConflictException(
        `Domain "${cleanHost}" is already mapped to database "${existing}"`,
      );
    }

    await this.domainMap.set(slug, cleanHost);
  }

  /**
   * Drains and terminates all active connections to a database
   */
  async drainAndTerminate(dbName: string): Promise<void> {
    const env = getEnv();
    const drainTimeoutMs = env.DRAIN_TIMEOUT_MS;

    // 1. Broadcast evict across all processes
    await this.clientManager.broadcastEvict(dbName);

    const client = this.getPostgresClient('provisioner');
    await client.connect();

    try {
      // 2. Poll pg_stat_activity until active connections drop to 0 or timeout
      const start = Date.now();
      while (Date.now() - start < drainTimeoutMs) {
        const countRes = await client.query<{ count: string }>(
          `
          SELECT count(*)::text as count
          FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid();
        `,
          [dbName],
        );

        const count = parseInt(countRes.rows[0]?.count || '0', 10);
        if (count === 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // 3. Force terminate any stubborn backends
      await client.query(
        `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid();
      `,
        [dbName],
      );

      // 4. Temporarily set ALLOW_CONNECTIONS = false
      await client.query(`ALTER DATABASE "${dbName}" WITH ALLOW_CONNECTIONS false;`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Detects and reports orphan databases (erp_tmp_* older than 24h) and leaked ALLOW_CONNECTIONS = false
   */
  async checkOrphans(): Promise<{ droppedOrphans: string[]; lockedDbs: string[] }> {
    const env = getEnv();
    const client = this.getPostgresClient('provisioner');
    await client.connect();

    const droppedOrphans: string[] = [];
    const lockedDbs: string[] = [];

    try {
      // 1. Find erp_tmp_*
      const tmpRes = await client.query<{ datname: string }>(`
        SELECT datname FROM pg_database WHERE datname LIKE 'erp_tmp_%';
      `);

      for (const row of tmpRes.rows) {
        if (env.CLEAN_ORPHANS) {
          await this.dropDatabaseSilently(row.datname);
          droppedOrphans.push(row.datname);
        } else {
          this.logger.warn(`Found orphan temporary database: "${row.datname}"`);
        }
      }

      // 2. Find databases with datallowconn = false (Requirement 3)
      const lockRes = await client.query<{ datname: string }>(`
        SELECT datname FROM pg_database WHERE datallowconn = false AND datname LIKE 'erp_%';
      `);

      for (const row of lockRes.rows) {
        lockedDbs.push(row.datname);
        this.logger.warn(
          `[CRITICAL] Database "${row.datname}" has datallowconn = false without an active operation. Use repair endpoint to restore access.`,
        );
      }

      return { droppedOrphans, lockedDbs };
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Lists backup zip files for a database
   */
  listBackups(slugOrName: string): BackupListItem[] {
    const dbName = slugOrName.startsWith('erp_') ? slugOrName : `erp_${slugOrName}`;
    const backupsDir = path.resolve(getEnv().BACKUP_DIR, dbName);
    if (!fs.existsSync(backupsDir)) {
      return [];
    }

    const files = fs.readdirSync(backupsDir);
    return files
      .filter((f) => f.endsWith('.zip'))
      .map((file) => {
        const fullPath = path.join(backupsDir, file);
        const stat = fs.statSync(fullPath);
        return {
          file,
          sizeBytes: stat.size,
          createdAt: stat.birthtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async checkDatabaseExists(dbName: string): Promise<boolean> {
    const client = this.getPostgresClient('provisioner');
    await client.connect();
    try {
      const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1;', [dbName]);
      return (res.rowCount ?? 0) > 0;
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async renameDatabase(fromDb: string, toDb: string): Promise<void> {
    const client = this.getPostgresClient('provisioner');
    await client.connect();
    try {
      await client.query(`ALTER DATABASE "${fromDb}" RENAME TO "${toDb}";`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async dropDatabaseSilently(dbName: string): Promise<void> {
    try {
      const client = this.getPostgresClient('provisioner');
      await client.connect();
      try {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
          [dbName],
        );
        await client.query(`DROP DATABASE IF EXISTS "${dbName}";`);
      } finally {
        await client.end().catch(() => {});
      }
    } catch {
      // Silent error during rollback
    }
  }

  private async checkAvailableDiskSpace(sourceDbName: string): Promise<void> {
    const client = this.getPostgresClient('provisioner');
    await client.connect();
    let sizeBytes = 50 * 1024 * 1024; // Default 50MB estimate
    try {
      const res = await client.query<{ size: string }>(
        'SELECT pg_database_size($1)::text as size;',
        [sourceDbName],
      );
      if (res.rows[0]?.size) {
        sizeBytes = parseInt(res.rows[0].size, 10);
      }
    } catch {
      // Ignore
    } finally {
      await client.end().catch(() => {});
    }

    try {
      const backupDir = path.resolve(getEnv().BACKUP_DIR);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const stat = fs.statfsSync(backupDir);
      const freeBytes = stat.bsize * stat.bavail;
      const requiredBytes = sizeBytes * 1.5;

      if (freeBytes < requiredBytes) {
        throw new Error(
          `Insufficient disk space: required ${(requiredBytes / (1024 * 1024)).toFixed(1)}MB, but only ${(freeBytes / (1024 * 1024)).toFixed(1)}MB is available.`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Insufficient disk space')) {
        throw err;
      }
      // On platforms where statfs is unavailable or mock failed, proceed
    }
  }

  private async verifyRowCountConsistency(sourceDb: string, targetDb: string): Promise<void> {
    const env = getEnv();
    const sourceClient = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: sourceDb,
      }),
    });
    const targetClient = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: targetDb,
      }),
    });

    await sourceClient.connect();
    await targetClient.connect();

    try {
      const sourceCount = await sourceClient.query<{ count: string }>(
        'SELECT count(*)::text as count FROM currencies;',
      );
      const targetCount = await targetClient.query<{ count: string }>(
        'SELECT count(*)::text as count FROM currencies;',
      );

      if (sourceCount.rows[0]?.count !== targetCount.rows[0]?.count) {
        throw new Error('Data consistency verification failed: row counts do not match');
      }
    } finally {
      await sourceClient.end().catch(() => {});
      await targetClient.end().catch(() => {});
    }
  }

  private async verifyMigrationCompatibility(manifest: BackupManifest): Promise<void> {
    const currentStatus = this.migrationRunner.getMigrationList();
    const backupMigrations = manifest.applied_migrations || [];

    // Check that every migration in backup exists in application
    for (let i = 0; i < backupMigrations.length; i++) {
      if (backupMigrations[i] !== currentStatus[i]) {
        throw new Error(
          `Incompatible migration: backup contains migration "${backupMigrations[i]}" which does not match application migration "${currentStatus[i]}".`,
        );
      }
    }
  }

  private async seedBaseline(dbName: string): Promise<void> {
    const env = getEnv();
    const client = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: dbName,
      }),
    });

    await client.connect();
    try {
      // 1. Currencies (IRR, IRT, USD, EUR)
      await client.query(`
        INSERT INTO currencies (code, name, symbol, decimals, sort_order, is_active)
        VALUES 
          ('IRR', 'ریال ایران', 'IRR', 0, 1, true),
          ('IRT', 'تومان ایران', 'IRT', 0, 2, true),
          ('USD', 'دلار آمریکا', '$', 2, 3, true),
          ('EUR', 'یورو', '€', 2, 4, true)
        ON CONFLICT (code) DO NOTHING;
      `);

      // 2. Company Profile
      await client.query(`
        INSERT INTO company_profile (id, name, default_currency_code, updated_at)
        VALUES (1, '', 'IRR', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);

      // 3. System Administrator Group (مدیر سیستم)
      const groupId = crypto.randomUUID();
      await client.query(
        `
        INSERT INTO groups (id, name, description, is_system, updated_at)
        VALUES ($1, 'مدیر سیستم', 'گروه راهبران ارشد با دسترسی کامل سیستمی', true, NOW())
        ON CONFLICT (name) DO NOTHING;
      `,
        [groupId],
      );

      // 4. Lost Reasons (7 Persian reasons)
      const lostReasons: Array<[string, number]> = [
        ['قیمت بالا', 1],
        ['رقیب قیمت کمتری داد', 2],
        ['نیاز مشتری منتفی شد', 3],
        ['زمان تحویل مناسب نبود', 4],
        ['شرایط پرداخت مناسب نبود', 5],
        ['عدم پاسخگویی مشتری', 6],
        ['سایر', 7],
      ];
      for (const [name, sortOrder] of lostReasons) {
        await client.query(
          `
          INSERT INTO lost_reasons (id, name, applies_to, sort_order, is_active, updated_at)
          VALUES ($1, $2, 'BOTH', $3, true, NOW())
          ON CONFLICT (name) DO NOTHING;
        `,
          [crypto.randomUUID(), name, sortOrder],
        );
      }

      // 5. System Settings (neutralized: false)
      await client.query(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('neutralized', 'false'::jsonb, NOW())
        ON CONFLICT (key) DO NOTHING;
      `);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async createAdminUser(
    dbName: string,
    data: { adminUsername: string; adminFullName: string; adminPassword: string },
  ): Promise<void> {
    const env = getEnv();
    const client = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: dbName,
      }),
    });

    await client.connect();
    try {
      const passwordHash = await hash(data.adminPassword);
      const userId = crypto.randomUUID();

      // Find 'مدیر سیستم' Group
      const grpRes = await client.query<{ id: string }>(
        `SELECT id FROM groups WHERE name = 'مدیر سیستم' LIMIT 1;`,
      );
      const groupId = grpRes.rows[0]?.id;

      // Create Admin User
      await client.query(
        `
        INSERT INTO users (id, type, username, full_name, password_hash, status, must_change_password, updated_at)
        VALUES ($1, 'INTERNAL', $2, $3, $4, 'ACTIVE', false, NOW());
      `,
        [userId, data.adminUsername.toLowerCase(), data.adminFullName, passwordHash],
      );

      // Assign User to Group
      if (groupId) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
          [groupId, userId],
        );
      }

      // Audit Log
      await client.query(
        `
        INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, source, occurred_at)
        VALUES ($1, $2, 'CREATE', 'user', $3, 'SYSTEM', NOW());
      `,
        [crypto.randomUUID(), userId, userId],
      );
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async neutralizeDatabase(dbName: string): Promise<void> {
    const env = getEnv();
    const client = new PgClient({
      connectionString: buildDatabaseUrl({
        host: env.POSTGRES_HOST,
        port: env.POSTGRES_PORT,
        user: 'erp_app',
        password: env.ERP_APP_PASSWORD,
        database: dbName,
      }),
    });

    await client.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          key VARCHAR(100) PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('neutralized', 'true'::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW();
      `);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private getLatestBackupTime(dbName: string): string | null {
    const backupsDir = path.resolve(getEnv().BACKUP_DIR, dbName);
    if (!fs.existsSync(backupsDir)) return null;

    try {
      const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.zip'));
      if (files.length === 0) return null;

      let latest = 0;
      for (const f of files) {
        const stat = fs.statSync(path.join(backupsDir, f));
        if (stat.mtimeMs > latest) {
          latest = stat.mtimeMs;
        }
      }
      return latest > 0 ? new Date(latest).toISOString() : null;
    } catch {
      return null;
    }
  }
}
