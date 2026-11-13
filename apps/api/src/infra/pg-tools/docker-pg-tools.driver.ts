import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isValidDatabaseName } from '@bodo/utils';
import {
  PgToolsDriver,
  PgDumpOptions,
  PgRestoreOptions,
  scrubSensitive,
} from './pg-tools.interface';

export class DockerPgToolsDriver implements PgToolsDriver {
  readonly name = 'docker' as const;

  constructor(private readonly containerName: string = 'bodo-postgres-dev') {}

  private validateContainerName(name: string): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid docker container name: "${name}"`);
    }
  }

  async checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    this.validateContainerName(this.containerName);

    return new Promise((resolve) => {
      // Execute `docker exec -i <container> pg_dump --version`
      const child = spawn('docker', ['exec', '-i', this.containerName, 'pg_dump', '--version'], {
        shell: false,
      });

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
          resolve({
            available: false,
            error: stderr.trim() || `Docker exec exited with code ${code}`,
          });
        }
      });
    });
  }

  async dump(options: PgDumpOptions): Promise<{ bytesWritten: number }> {
    if (!isValidDatabaseName(options.database)) {
      throw new Error(`Invalid database name for pg_dump: "${options.database}"`);
    }
    this.validateContainerName(this.containerName);

    // Security requirement: pass `-e PGPASSWORD` without value in argument list,
    // and provide the value in process environment so it never appears in process arguments.
    // -t is strictly forbidden to preserve pure binary stream (no CRLF injection).
    const dockerArgs = [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      this.containerName,
      'pg_dump',
      '-Fc',
      '-U',
      options.user,
      '-d',
      options.database,
    ];

    const childEnv = { ...process.env };
    if (options.password) {
      childEnv.PGPASSWORD = options.password;
    }

    const child = spawn('docker', dockerArgs, {
      shell: false,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    let bytesWritten = 0;
    child.stdout.on('data', (chunk) => {
      bytesWritten += chunk.length;
    });

    const streamPromises: Promise<unknown>[] = [];

    if (options.destinationStream) {
      streamPromises.push(pipeline(child.stdout, options.destinationStream));
    } else if (options.outputFilePath) {
      const outStream = fs.createWriteStream(options.outputFilePath);
      streamPromises.push(pipeline(child.stdout, outStream));
    } else {
      child.stdout.resume();
    }

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        const cleanMsg = scrubSensitive(err.message, [options.password]);
        reject(new Error(`Failed to execute docker exec pg_dump: ${cleanMsg}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const cleanErr = scrubSensitive(stderr, [options.password]);
          reject(new Error(`docker exec pg_dump failed (exit code ${code}): ${cleanErr.trim()}`));
        }
      });
    });

    await Promise.all([exitPromise, ...streamPromises]);
    return { bytesWritten };
  }

  async restore(options: PgRestoreOptions): Promise<void> {
    if (!isValidDatabaseName(options.database)) {
      throw new Error(`Invalid database name for pg_restore: "${options.database}"`);
    }
    this.validateContainerName(this.containerName);

    // Security requirement: `-e PGPASSWORD` without value, value in child env.
    // -t is strictly forbidden.
    const dockerArgs = [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      this.containerName,
      'pg_restore',
      '-d',
      options.database,
      '-U',
      options.user,
    ];

    if (options.clean) {
      dockerArgs.push('--clean');
    }

    const childEnv = { ...process.env };
    if (options.password) {
      childEnv.PGPASSWORD = options.password;
    }

    const child = spawn('docker', dockerArgs, {
      shell: false,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const streamPromises: Promise<unknown>[] = [];

    if (options.sourceStream) {
      streamPromises.push(pipeline(options.sourceStream, child.stdin));
    } else if (options.inputFilePath) {
      const inStream = fs.createReadStream(options.inputFilePath);
      streamPromises.push(pipeline(inStream, child.stdin));
    } else {
      child.stdin.end();
    }

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        const cleanMsg = scrubSensitive(err.message, [options.password]);
        reject(new Error(`Failed to execute docker exec pg_restore: ${cleanMsg}`));
      });

      child.on('close', (code) => {
        if (code === 0 || code === 1) {
          resolve();
        } else {
          const cleanErr = scrubSensitive(stderr, [options.password]);
          reject(
            new Error(`docker exec pg_restore failed (exit code ${code}): ${cleanErr.trim()}`),
          );
        }
      });
    });

    await Promise.all([exitPromise, ...streamPromises]);
  }
}
