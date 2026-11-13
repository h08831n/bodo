import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  PgToolsDriver,
  PgDumpOptions,
  PgRestoreOptions,
  isValidPgToolsDatabaseName,
  scrubSensitive,
} from './pg-tools.interface';

export class LocalPgToolsDriver implements PgToolsDriver {
  readonly name = 'local' as const;

  constructor(private readonly binPath?: string) {}

  private resolveBinary(tool: 'pg_dump' | 'pg_restore' | 'psql'): string {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? `${tool}.exe` : tool;

    if (this.binPath) {
      const fullPath = path.join(this.binPath, binaryName);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return binaryName;
  }

  async checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    const binary = this.resolveBinary('pg_dump');
    return new Promise((resolve) => {
      const child = spawn(binary, ['--version'], { shell: false });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => {
        resolve({ available: false, error: err.message });
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ available: true, version: stdout.trim() });
        } else {
          resolve({ available: false, error: stderr.trim() || `Exit code ${code}` });
        }
      });
    });
  }

  async dump(options: PgDumpOptions): Promise<{ bytesWritten: number }> {
    if (!isValidPgToolsDatabaseName(options.database)) {
      throw new Error(`Invalid database name for pg_dump: "${options.database}"`);
    }

    const binary = this.resolveBinary('pg_dump');
    // pg_dump arguments: custom archive format (-Fc), preserving ACLs (no --no-privileges)
    const args = ['-Fc', '-U', options.user, '-d', options.database];

    if (options.host) {
      args.push('-h', options.host);
    }
    if (options.port) {
      args.push('-p', String(options.port));
    }
    if (options.outputFilePath) {
      args.push('-f', options.outputFilePath);
    }

    const childEnv = { ...process.env };
    if (options.password) {
      childEnv.PGPASSWORD = options.password;
    }

    const child = spawn(binary, args, {
      shell: false,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const streamPromises: Promise<unknown>[] = [];

    if (options.destinationStream) {
      streamPromises.push(pipeline(child.stdout, options.destinationStream));
    } else {
      // Drain if writing directly to file via -f or no stream provided
      child.stdout.resume();
    }

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        const cleanMsg = scrubSensitive(err.message, [options.password]);
        reject(new Error(`Failed to execute pg_dump: ${cleanMsg}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const cleanErr = scrubSensitive(stderr, [options.password]);
          reject(new Error(`pg_dump failed (exit code ${code}): ${cleanErr.trim()}`));
        }
      });
    });

    await Promise.all([exitPromise, ...streamPromises]);
    const bytesWritten =
      options.outputFilePath && fs.existsSync(options.outputFilePath)
        ? fs.statSync(options.outputFilePath).size
        : 0;
    return { bytesWritten };
  }

  async restore(options: PgRestoreOptions): Promise<void> {
    if (!isValidPgToolsDatabaseName(options.database)) {
      throw new Error(`Invalid database name for pg_restore: "${options.database}"`);
    }

    const binary = this.resolveBinary('pg_restore');
    // pg_restore arguments: restoring into target database, preserving privileges
    const args = ['-d', options.database, '-U', options.user];

    if (options.clean) {
      args.push('--clean');
    }
    if (options.host) {
      args.push('-h', options.host);
    }
    if (options.port) {
      args.push('-p', String(options.port));
    }
    if (options.inputFilePath) {
      args.push(options.inputFilePath);
    }

    const childEnv = { ...process.env };
    if (options.password) {
      childEnv.PGPASSWORD = options.password;
    }

    const child = spawn(binary, args, {
      shell: false,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const streamPromises: Promise<unknown>[] = [];

    if (options.sourceStream) {
      streamPromises.push(pipeline(options.sourceStream, child.stdin));
    } else {
      child.stdin.end();
    }

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        const cleanMsg = scrubSensitive(err.message, [options.password]);
        reject(new Error(`Failed to execute pg_restore: ${cleanMsg}`));
      });

      child.on('close', (code) => {
        // pg_restore exit code 0 is complete success. Exit code 1 indicates non-fatal warnings
        // (like objects that could not be dropped if not existing).
        if (code === 0 || code === 1) {
          resolve();
        } else {
          const cleanErr = scrubSensitive(stderr, [options.password]);
          reject(new Error(`pg_restore failed (exit code ${code}): ${cleanErr.trim()}`));
        }
      });
    });

    await Promise.all([exitPromise, ...streamPromises]);
  }
}
