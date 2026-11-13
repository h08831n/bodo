import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getEnv } from '../../config/env.config';

interface CacheEntry<T> {
  data: T;
  mtimeMs: number;
}

@Injectable()
export class ConfigStoreService {
  private readonly logger = new Logger(ConfigStoreService.name);
  private readonly configDir: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor() {
    this.configDir = path.resolve(getEnv().CONFIG_DIR);
    if (!fs.existsSync(this.configDir)) {
      try {
        fs.mkdirSync(this.configDir, { recursive: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to create config dir "${this.configDir}": ${msg}`);
      }
    }
  }

  /**
   * Reads and parses a JSON config file with zod validation and mtime-based in-memory caching.
   * If file does not exist, returns fallback if provided, otherwise throws.
   */
  async read<T>(filename: string, schema: z.ZodType<T>, fallback?: T): Promise<T> {
    const filePath = path.join(this.configDir, filename);

    if (!fs.existsSync(filePath)) {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(`Config file not found: "${filename}"`);
    }

    try {
      const stat = await fs.promises.stat(filePath);
      const cached = this.cache.get(filename);

      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.data as T;
      }

      const content = await fs.promises.readFile(filePath, 'utf8');
      const parsedJson = JSON.parse(content);
      const validated = schema.parse(parsedJson);

      this.cache.set(filename, {
        data: validated,
        mtimeMs: stat.mtimeMs,
      });

      return validated;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to read/validate config file "${filename}": ${msg}`);
      if (fallback !== undefined) {
        return fallback;
      }
      throw err;
    }
  }

  /**
   * Atomically writes data to a config file using a temporary file and rename.
   * Serializes concurrent writes to the same file using an in-memory lock chain.
   */
  async write<T>(filename: string, data: T, schema: z.ZodType<T>): Promise<void> {
    const validated = schema.parse(data);
    const filePath = path.join(this.configDir, filename);
    const tempPath = path.join(
      this.configDir,
      `.tmp_${filename}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    );

    const acquireLock = async () => {
      while (this.writeLocks.has(filename)) {
        await this.writeLocks.get(filename);
      }
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.writeLocks.set(filename, promise);
      return release;
    };

    const releaseLock = await acquireLock();

    try {
      const content = JSON.stringify(validated, null, 2);
      await fs.promises.writeFile(tempPath, content, 'utf8');
      await fs.promises.rename(tempPath, filePath);

      const stat = await fs.promises.stat(filePath);
      this.cache.set(filename, {
        data: validated,
        mtimeMs: stat.mtimeMs,
      });
    } catch (err: unknown) {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write config file "${filename}": ${msg}`);
      throw err;
    } finally {
      this.writeLocks.delete(filename);
      releaseLock();
    }
  }
}
