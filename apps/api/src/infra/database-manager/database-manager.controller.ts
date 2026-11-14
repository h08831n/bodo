import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  Req,
  Query,
  NotFoundException,
  BadRequestException,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreateDatabaseRequestSchema,
  DuplicateDatabaseRequestSchema,
  RestoreDatabaseRequestSchema,
  DeleteDatabaseRequestSchema,
  RepairDatabaseRequestSchema,
  SetMaintenanceRequestSchema,
  SetDomainRequestSchema,
  DatabaseListItem,
  BackupListItem,
  AdminJobStatus,
} from '@bodo/contracts';
import { MasterAdminGuard } from '../admin/master-admin.guard';
import { AdminAuditLogger, AdminAuditEntry } from '../admin/admin-audit.logger';
import { DatabaseManagerService } from './database-manager.service';
import { JobQueueService } from './job-queue.service';
import { getEnv } from '../../config/env.config';

@Controller('v1/admin')
@UseGuards(MasterAdminGuard)
export class DatabaseManagerController {
  constructor(
    private readonly dbManager: DatabaseManagerService,
    private readonly jobQueue: JobQueueService,
    private readonly auditLogger: AdminAuditLogger,
  ) {}

  private getRequestMeta(req: Request) {
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const requestId = req.requestId || (req.headers['x-request-id'] as string) || 'N/A';
    return { clientIp, requestId };
  }

  @Get('databases')
  async listDatabases(): Promise<DatabaseListItem[]> {
    return this.dbManager.listDatabases();
  }

  @Post('databases')
  @HttpCode(HttpStatus.ACCEPTED)
  async createDatabase(@Body() rawBody: unknown, @Req() req: Request): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = CreateDatabaseRequestSchema.parse(rawBody);
    const dbName = `erp_${body.name.toLowerCase().trim()}`;

    // Acquire database lock in Redis (Requirement: max 1 destructive op per database)
    const jobId = await this.jobQueue.enqueueJob(
      'create',
      dbName,
      body as unknown as Record<string, unknown>,
      { requestId, clientIp },
    );

    this.auditLogger.log({
      ip: clientIp,
      action: 'CREATE_DATABASE_QUEUED',
      target: dbName,
      jobId,
      requestId,
      status: 'SUCCESS',
      details: { username: body.adminUsername, fullName: body.adminFullName },
    });

    return { jobId };
  }

  @Post('databases/:name/duplicate')
  @HttpCode(HttpStatus.ACCEPTED)
  async duplicateDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = DuplicateDatabaseRequestSchema.parse(rawBody);
    const targetDbName = `erp_${body.newName.toLowerCase().trim()}`;

    const jobId = await this.jobQueue.enqueueJob(
      'duplicate',
      targetDbName,
      {
        sourceDatabase: name,
        ...body,
      },
      { requestId, clientIp },
    );

    this.auditLogger.log({
      ip: clientIp,
      action: 'DUPLICATE_DATABASE_QUEUED',
      target: targetDbName,
      jobId,
      requestId,
      status: 'SUCCESS',
      details: { sourceDatabase: name },
    });

    return { jobId };
  }

  @Post('databases/:name/backups')
  @HttpCode(HttpStatus.ACCEPTED)
  async createBackup(@Param('name') name: string, @Req() req: Request): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const jobId = await this.jobQueue.enqueueJob('backup', dbName, {}, { requestId, clientIp });

    this.auditLogger.log({
      ip: clientIp,
      action: 'BACKUP_DATABASE_QUEUED',
      target: dbName,
      jobId,
      requestId,
      status: 'SUCCESS',
    });

    return { jobId };
  }

  @Get('databases/:name/backups')
  listBackups(@Param('name') name: string): BackupListItem[] {
    return this.dbManager.listBackups(name);
  }

  @Get('databases/:name/backups/:file')
  downloadBackup(
    @Param('name') name: string,
    @Param('file') file: string,
    @Res() res: Response,
    @Req() req: Request,
  ): void {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    // Sanitize filename against path traversal
    const safeFile = path.basename(file);
    const filePath = path.resolve(getEnv().BACKUP_DIR, dbName, safeFile);

    if (!fs.existsSync(filePath)) {
      this.auditLogger.log({
        ip: clientIp,
        action: 'DOWNLOAD_BACKUP',
        target: dbName,
        details: { file: safeFile },
        status: 'FAILURE',
        requestId,
        error: `Backup file "${safeFile}" not found`,
      });
      throw new NotFoundException(`Backup file "${safeFile}" not found`);
    }

    this.auditLogger.log({
      ip: clientIp,
      action: 'DOWNLOAD_BACKUP',
      target: dbName,
      details: { file: safeFile },
      status: 'SUCCESS',
      requestId,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  @Delete('databases/:name/backups/:file')
  deleteBackup(
    @Param('name') name: string,
    @Param('file') file: string,
    @Req() req: Request,
  ): { message: string } {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const safeFile = path.basename(file);
    const filePath = path.resolve(getEnv().BACKUP_DIR, dbName, safeFile);

    if (!fs.existsSync(filePath)) {
      this.auditLogger.log({
        ip: clientIp,
        action: 'DELETE_BACKUP',
        target: dbName,
        details: { file: safeFile },
        status: 'FAILURE',
        requestId,
        error: `Backup file "${safeFile}" not found`,
      });
      throw new NotFoundException(`Backup file "${safeFile}" not found`);
    }

    fs.unlinkSync(filePath);
    this.auditLogger.log({
      ip: clientIp,
      action: 'DELETE_BACKUP',
      target: dbName,
      details: { file: safeFile },
      status: 'SUCCESS',
      requestId,
    });
    return { message: `Backup file "${safeFile}" deleted successfully` };
  }

  @Post('databases/restore')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      dest: path.resolve(getEnv().BACKUP_DIR, '.tmp'),
      limits: {
        fileSize: getEnv().MAX_RESTORE_UPLOAD_MB * 1024 * 1024,
      },
    }),
  )
  async restoreDatabase(
    @UploadedFile() file: { path?: string } | undefined,
    @Body() rawBody: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    let zipPath = file?.path;

    // Alternatively support filePath in body for server-local backups or tests
    if (!zipPath && typeof rawBody?.filePath === 'string') {
      zipPath = rawBody.filePath as string;
    }

    if (!zipPath || !fs.existsSync(zipPath)) {
      this.auditLogger.log({
        ip: clientIp,
        action: 'RESTORE_DATABASE_QUEUED',
        status: 'FAILURE',
        requestId,
        error: 'A valid backup zip file or filePath is required',
      });
      throw new BadRequestException('A valid backup zip file or filePath is required');
    }

    const body = RestoreDatabaseRequestSchema.parse(rawBody);
    const targetDbName = `erp_${body.newName.toLowerCase().trim()}`;

    const jobId = await this.jobQueue.enqueueJob(
      'restore',
      targetDbName,
      {
        zipPath,
        ...body,
      },
      { requestId, clientIp },
    );

    this.auditLogger.log({
      ip: clientIp,
      action: 'RESTORE_DATABASE_QUEUED',
      target: targetDbName,
      jobId,
      requestId,
      status: 'SUCCESS',
    });

    return { jobId };
  }

  @Delete('databases/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = DeleteDatabaseRequestSchema.parse(rawBody);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;

    const jobId = await this.jobQueue.enqueueJob(
      'delete',
      dbName,
      {
        confirmName: body.confirmName,
      },
      { requestId, clientIp },
    );

    this.auditLogger.log({
      ip: clientIp,
      action: 'DELETE_DATABASE_QUEUED',
      target: dbName,
      jobId,
      requestId,
      status: 'SUCCESS',
    });

    return { jobId };
  }

  @Post('databases/:name/upgrade')
  @HttpCode(HttpStatus.ACCEPTED)
  async upgradeDatabase(
    @Param('name') name: string,
    @Req() req: Request,
  ): Promise<{ jobId: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const jobId = await this.jobQueue.enqueueJob('upgrade', dbName, {}, { requestId, clientIp });

    this.auditLogger.log({
      ip: clientIp,
      action: 'UPGRADE_DATABASE_QUEUED',
      target: dbName,
      jobId,
      requestId,
      status: 'SUCCESS',
    });

    return { jobId };
  }

  @Post('databases/:name/repair')
  async repairDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ message: string; rolledBackMigration?: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = RepairDatabaseRequestSchema.parse(rawBody);

    try {
      const res = await this.dbManager.repairDatabase(name, body.confirm, body.migration);
      this.auditLogger.log({
        ip: clientIp,
        action: 'REPAIR_DATABASE',
        target: name,
        status: 'SUCCESS',
        requestId,
        details: { rolledBackMigration: res.rolledBackMigration },
      });
      return res;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        ip: clientIp,
        action: 'REPAIR_DATABASE',
        target: name,
        status: 'FAILURE',
        requestId,
        error: errorMsg,
      });
      throw err;
    }
  }

  @Post('databases/:name/maintenance')
  async setMaintenance(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = SetMaintenanceRequestSchema.parse(rawBody);

    try {
      await this.dbManager.setMaintenance(name, body.enabled, body.reason, body.confirm);
      this.auditLogger.log({
        ip: clientIp,
        action: 'SET_MAINTENANCE',
        target: name,
        status: 'SUCCESS',
        requestId,
        details: { enabled: body.enabled, reason: body.reason },
      });
      return {
        message: `Maintenance mode ${body.enabled ? 'enabled' : 'disabled'} for ${name}`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        ip: clientIp,
        action: 'SET_MAINTENANCE',
        target: name,
        status: 'FAILURE',
        requestId,
        error: errorMsg,
      });
      throw err;
    }
  }

  @Put('databases/:name/domain')
  async setDomain(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const { clientIp, requestId } = this.getRequestMeta(req);
    const body = SetDomainRequestSchema.parse(rawBody);

    try {
      await this.dbManager.setDomain(name, body.host);
      this.auditLogger.log({
        ip: clientIp,
        action: 'SET_DOMAIN',
        target: name,
        status: 'SUCCESS',
        requestId,
        details: { host: body.host },
      });
      return {
        message: body.host
          ? `Domain "${body.host}" mapped to "${name}"`
          : `Domain mapping removed for "${name}"`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        ip: clientIp,
        action: 'SET_DOMAIN',
        target: name,
        status: 'FAILURE',
        requestId,
        error: errorMsg,
      });
      throw err;
    }
  }

  @Get('audit-logs')
  getAuditLogs(@Query('tail') tail?: string): AdminAuditEntry[] {
    const n = tail ? parseInt(tail, 10) : 50;
    return this.auditLogger.getRecentLogs(n);
  }

  @Get('jobs')
  async listJobs(): Promise<AdminJobStatus[]> {
    return this.jobQueue.listJobs();
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string): Promise<AdminJobStatus> {
    const job = await this.jobQueue.getJobStatus(id);
    if (!job) {
      throw new NotFoundException(`Job "${id}" not found`);
    }
    return job;
  }
}
