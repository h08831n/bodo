import { Readable, Writable } from 'node:stream';

export interface PgDumpOptions {
  database: string;
  user: string;
  password?: string;
  host?: string;
  port?: number;
  outputFilePath?: string;
  destinationStream?: Writable;
}

export interface PgRestoreOptions {
  database: string;
  user: string;
  password?: string;
  host?: string;
  port?: number;
  inputFilePath?: string;
  sourceStream?: Readable;
  clean?: boolean;
}

export interface PgToolsDriver {
  readonly name: 'local' | 'docker';
  dump(options: PgDumpOptions): Promise<{ bytesWritten: number }>;
  restore(options: PgRestoreOptions): Promise<void>;
  checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }>;
}

export function scrubSensitive(text: string, secrets: (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length > 2) {
      result = result.split(secret).join('******');
    }
  }
  return result;
}
