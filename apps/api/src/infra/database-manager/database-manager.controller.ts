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
  NotFoundException,
  BadRequestException,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
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
import { DatabaseManagerService } from './database-manager.service';
import { JobQueueService } from './job-queue.service';
import { getEnv } from '../../config/env.config';

@Controller('v1/admin')
@UseGuards(MasterAdminGuard)
export class DatabaseManagerController {
  constructor(
    private readonly dbManager: DatabaseManagerService,
    private readonly jobQueue: JobQueueService,
  ) {}

  @Get('databases')
  async listDatabases(): Promise<DatabaseListItem[]> {
    return this.dbManager.listDatabases();
  }

  @Post('databases')
  @HttpCode(HttpStatus.ACCEPTED)
  async createDatabase(@Body() rawBody: unknown): Promise<{ jobId: string }> {
    const body = CreateDatabaseRequestSchema.parse(rawBody);
    const dbName = `erp_${body.name.toLowerCase().trim()}`;

    // Acquire database lock in Redis (Requirement: max 1 destructive op per database)
    const jobId = await this.jobQueue.enqueueJob(
      'create',
      dbName,
      body as unknown as Record<string, unknown>,
    );
    return { jobId };
  }

  @Post('databases/:name/duplicate')
  @HttpCode(HttpStatus.ACCEPTED)
  async duplicateDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ): Promise<{ jobId: string }> {
    const body = DuplicateDatabaseRequestSchema.parse(rawBody);
    const targetDbName = `erp_${body.newName.toLowerCase().trim()}`;

    const jobId = await this.jobQueue.enqueueJob('duplicate', targetDbName, {
      sourceDatabase: name,
      ...body,
    });
    return { jobId };
  }

  @Post('databases/:name/backups')
  @HttpCode(HttpStatus.ACCEPTED)
  async createBackup(@Param('name') name: string): Promise<{ jobId: string }> {
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const jobId = await this.jobQueue.enqueueJob('backup', dbName, {});
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
  ): void {
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    // Sanitize filename against path traversal
    const safeFile = path.basename(file);
    const filePath = path.resolve(getEnv().BACKUP_DIR, dbName, safeFile);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup file "${safeFile}" not found`);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  @Delete('databases/:name/backups/:file')
  deleteBackup(@Param('name') name: string, @Param('file') file: string): { message: string } {
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const safeFile = path.basename(file);
    const filePath = path.resolve(getEnv().BACKUP_DIR, dbName, safeFile);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup file "${safeFile}" not found`);
    }

    fs.unlinkSync(filePath);
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
  ): Promise<{ jobId: string }> {
    let zipPath = file?.path;

    // Alternatively support filePath in body for server-local backups or tests
    if (!zipPath && typeof rawBody?.filePath === 'string') {
      zipPath = rawBody.filePath as string;
    }

    if (!zipPath || !fs.existsSync(zipPath)) {
      throw new BadRequestException('A valid backup zip file or filePath is required');
    }

    const body = RestoreDatabaseRequestSchema.parse(rawBody);
    const targetDbName = `erp_${body.newName.toLowerCase().trim()}`;

    const jobId = await this.jobQueue.enqueueJob('restore', targetDbName, {
      zipPath,
      ...body,
    });

    return { jobId };
  }

  @Delete('databases/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ): Promise<{ jobId: string }> {
    const body = DeleteDatabaseRequestSchema.parse(rawBody);
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;

    const jobId = await this.jobQueue.enqueueJob('delete', dbName, {
      confirmName: body.confirmName,
    });
    return { jobId };
  }

  @Post('databases/:name/upgrade')
  @HttpCode(HttpStatus.ACCEPTED)
  async upgradeDatabase(@Param('name') name: string): Promise<{ jobId: string }> {
    const dbName = name.startsWith('erp_') ? name : `erp_${name}`;
    const jobId = await this.jobQueue.enqueueJob('upgrade', dbName, {});
    return { jobId };
  }

  @Post('databases/:name/repair')
  async repairDatabase(
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ): Promise<{ message: string; rolledBackMigration?: string }> {
    const body = RepairDatabaseRequestSchema.parse(rawBody);
    return this.dbManager.repairDatabase(name, body.confirm, body.migration);
  }

  @Post('databases/:name/maintenance')
  async setMaintenance(
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ): Promise<{ message: string }> {
    const body = SetMaintenanceRequestSchema.parse(rawBody);
    await this.dbManager.setMaintenance(name, body.enabled, body.reason, body.confirm);
    return {
      message: `Maintenance mode ${body.enabled ? 'enabled' : 'disabled'} for ${name}`,
    };
  }

  @Put('databases/:name/domain')
  async setDomain(
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ): Promise<{ message: string }> {
    const body = SetDomainRequestSchema.parse(rawBody);
    await this.dbManager.setDomain(name, body.host);
    return {
      message: body.host
        ? `Domain "${body.host}" mapped to "${name}"`
        : `Domain mapping removed for "${name}"`,
    };
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
