import fs from 'node:fs';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env.config';

export interface AdminAuditEntry {
  timestamp?: string;
  ip: string;
  action: string;
  target?: string;
  status: 'SUCCESS' | 'FAILURE';
  requestId?: string;
  details?: Record<string, unknown>;
  error?: string;
}

@Injectable()
export class AdminAuditLogger {
  private readonly logger = new Logger(AdminAuditLogger.name);
  private readonly logFilePath: string;
  private readonly maxSizeBytes = 20 * 1024 * 1024; // 20 MB

  constructor() {
    const env = getEnv();
    const logsDir = path.resolve(env.LOGS_DIR);
    if (!fs.existsSync(logsDir)) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to create logs directory "${logsDir}": ${msg}`);
      }
    }
    this.logFilePath = path.join(logsDir, 'admin-audit.log');
  }

  log(entry: AdminAuditEntry): void {
    const record = {
      timestamp: entry.timestamp || new Date().toISOString(),
      ip: entry.ip,
      action: entry.action,
      target: entry.target || 'N/A',
      status: entry.status,
      requestId: entry.requestId || 'N/A',
      details: entry.details,
      error: entry.error,
    };

    // Sanitize any accidental password leaking
    if (record.details) {
      const sanitized = { ...record.details };
      for (const k of Object.keys(sanitized)) {
        if (/pass|secret|token|key/i.test(k)) {
          sanitized[k] = '******';
        }
      }
      record.details = sanitized;
    }

    const line = JSON.stringify(record) + '\n';

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write to admin-audit.log: ${msg}`);
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const stat = fs.statSync(this.logFilePath);
        if (stat.size >= this.maxSizeBytes) {
          const backupPath = `${this.logFilePath}.1`;
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
          fs.renameSync(this.logFilePath, backupPath);
        }
      }
    } catch {
      // Rotation failures should not crash application
    }
  }
}
