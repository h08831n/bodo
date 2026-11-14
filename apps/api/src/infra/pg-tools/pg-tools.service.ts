import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env.config';
import { PgToolsDriver, PgDumpOptions, PgRestoreOptions } from './pg-tools.interface';
import { LocalPgToolsDriver } from './local-pg-tools.driver';
import { DockerPgToolsDriver } from './docker-pg-tools.driver';

@Injectable()
export class PgToolsService {
  private readonly logger = new Logger(PgToolsService.name);
  private driver: PgToolsDriver;

  constructor() {
    this.driver = this.createDriver();
  }

  private createDriver(driverName?: 'local' | 'docker'): PgToolsDriver {
    const env = getEnv();
    const selected = driverName || env.PG_TOOLS_DRIVER;

    if (selected === 'docker') {
      this.logger.log(`Using Docker PgTools driver (container: ${env.PG_DOCKER_CONTAINER})`);
      return new DockerPgToolsDriver(env.PG_DOCKER_CONTAINER);
    }

    this.logger.log(`Using Local PgTools driver (binPath: ${env.PG_BIN_PATH || 'PATH'})`);
    return new LocalPgToolsDriver(env.PG_BIN_PATH || undefined);
  }

  getDriver(): PgToolsDriver {
    return this.driver;
  }

  getDriverForType(type: 'local' | 'docker'): PgToolsDriver {
    return this.createDriver(type);
  }

  setDriver(driver: PgToolsDriver): void {
    this.driver = driver;
  }

  async checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    return this.driver.checkAvailable();
  }

  async dump(options: PgDumpOptions): Promise<{ bytesWritten: number }> {
    return this.driver.dump(options);
  }

  async restore(options: PgRestoreOptions): Promise<void> {
    return this.driver.restore(options);
  }
}
