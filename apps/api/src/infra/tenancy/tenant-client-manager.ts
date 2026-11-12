import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { buildDatabaseUrl } from '@bodo/utils';
import { getEnv } from '../../config/env.config';
import pg from 'pg';

interface ClientCacheEntry {
  client: PrismaClient;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
}

export interface TenantClientStats {
  open: number;
  maxClients: number;
  activeLeases: number;
}

export interface LeaseHandle {
  client: PrismaClient;
  release: () => Promise<void>;
}

@Injectable()
export class TenantClientManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantClientManager.name);

  private readonly clients = new Map<string, ClientCacheEntry>();
  private readonly activeLeases = new Map<string, number>();
  private readonly inFlightInit = new Map<string, Promise<PrismaClient>>();
  private readonly pendingEviction = new Set<string>();

  private readonly maxClients: number;
  private readonly poolSize: number;
  private readonly idleMs: number;
  private readonly host: string;
  private readonly port: number;
  private readonly appPassword: string;

  constructor() {
    const env = getEnv();
    this.maxClients = env.TENANT_MAX_CLIENTS;
    this.poolSize = env.TENANT_POOL_SIZE;
    this.idleMs = env.TENANT_IDLE_MS;
    this.host = env.POSTGRES_HOST;
    this.port = env.POSTGRES_PORT;
    this.appPassword = env.ERP_APP_PASSWORD;
  }

  async onModuleInit(): Promise<void> {
    await this.checkConnectionBudget();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  /**
   * Acquires a lease on a tenant database client.
   * Increments active lease counter to ensure the client is not evicted during request/task processing.
   */
  async acquireLease(db: string): Promise<LeaseHandle> {
    const client = await this.getClient(db);
    const currentCount = this.activeLeases.get(db) ?? 0;
    this.activeLeases.set(db, currentCount + 1);

    // Cancel any pending idle eviction timer
    const entry = this.clients.get(db);
    if (entry && entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;

      const remaining = Math.max(0, (this.activeLeases.get(db) ?? 1) - 1);
      if (remaining === 0) {
        this.activeLeases.delete(db);
        await this.handleLeaseZero(db);
      } else {
        this.activeLeases.set(db, remaining);
      }
    };

    return { client, release };
  }

  /**
   * Executes a scoped function with an acquired lease, guaranteeing release in finally.
   */
  async lease<T>(db: string, fn: (client: PrismaClient) => Promise<T>): Promise<T> {
    const { client, release } = await this.acquireLease(db);
    try {
      return await fn(client);
    } finally {
      await release();
    }
  }

  /**
   * Retrieves an existing PrismaClient from LRU cache or creates one using single-flight pattern.
   */
  async getClient(db: string): Promise<PrismaClient> {
    // 1. Check existing in-memory cache
    const existing = this.clients.get(db);
    if (existing) {
      existing.lastUsed = Date.now();
      // Re-insert to keep LRU order (most recently used at end)
      this.clients.delete(db);
      this.clients.set(db, existing);
      return existing.client;
    }

    // 2. Check in-flight single-flight promise
    const inFlight = this.inFlightInit.get(db);
    if (inFlight) {
      return inFlight;
    }

    // 3. Single-flight instantiation
    const initPromise = (async () => {
      await this.enforceCapacity();

      const url = buildDatabaseUrl({
        host: this.host,
        port: this.port,
        user: 'erp_app',
        password: this.appPassword,
        database: db,
        connectionLimit: this.poolSize,
      });

      const client = new PrismaClient({
        datasources: { db: { url } },
      });

      await client.$connect();

      this.clients.set(db, {
        client,
        lastUsed: Date.now(),
      });

      return client;
    })().finally(() => {
      this.inFlightInit.delete(db);
    });

    this.inFlightInit.set(db, initPromise);
    return initPromise;
  }

  /**
   * Evicts a client cleanly. Waits for active leases to finish up to timeoutMs before disconnecting.
   */
  async evict(db: string, options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    const startTime = Date.now();

    while ((this.activeLeases.get(db) ?? 0) > 0) {
      if (Date.now() - startTime >= timeoutMs) {
        const count = this.activeLeases.get(db);
        throw new Error(
          `Cannot evict database "${db}": ${count} active lease(s) still open after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const entry = this.clients.get(db);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    this.clients.delete(db);
    this.pendingEviction.delete(db);

    try {
      await entry.client.$disconnect();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Error disconnecting Prisma client for "${db}": ${msg}`);
    }
  }

  /**
   * Returns stats for health checks and monitoring.
   */
  stats(): TenantClientStats {
    let totalLeases = 0;
    for (const count of this.activeLeases.values()) {
      totalLeases += count;
    }
    return {
      open: this.clients.size,
      maxClients: this.maxClients,
      activeLeases: totalLeases,
    };
  }

  /**
   * Disconnects all clients and cleans up all timers.
   */
  async shutdown(): Promise<void> {
    const entries = Array.from(this.clients.entries());
    this.clients.clear();
    this.activeLeases.clear();
    this.pendingEviction.clear();

    await Promise.allSettled(
      entries.map(async ([, entry]) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
        }
        await entry.client.$disconnect().catch(() => {});
      }),
    );
  }

  private async enforceCapacity(): Promise<void> {
    while (this.clients.size >= this.maxClients) {
      // Find oldest entry that has no active leases
      let evictedOne = false;
      for (const [db] of this.clients.entries()) {
        if ((this.activeLeases.get(db) ?? 0) === 0) {
          await this.evict(db);
          evictedOne = true;
          break;
        }
      }

      if (!evictedOne) {
        // All open clients currently have active leases.
        // Mark the oldest one for deferred eviction as soon as its leases reach 0.
        const oldestDb = this.clients.keys().next().value;
        if (oldestDb) {
          this.pendingEviction.add(oldestDb);
        }
        break;
      }
    }
  }

  private async handleLeaseZero(db: string): Promise<void> {
    if (this.pendingEviction.has(db)) {
      await this.evict(db);
      return;
    }

    const entry = this.clients.get(db);
    if (entry && this.idleMs > 0) {
      entry.idleTimer = setTimeout(async () => {
        if ((this.activeLeases.get(db) ?? 0) === 0) {
          await this.evict(db).catch(() => {});
        }
      }, this.idleMs);
    }
  }

  private async checkConnectionBudget(): Promise<void> {
    const pool = new pg.Pool({
      host: this.host,
      port: this.port,
      user: 'erp_app',
      password: this.appPassword,
      database: 'postgres',
      max: 1,
      connectionTimeoutMillis: 3000,
    });

    try {
      const res = await pool.query('SHOW max_connections;');
      const maxConn = parseInt(res.rows[0]?.max_connections, 10);
      if (!isNaN(maxConn)) {
        const potentialConnections = this.maxClients * this.poolSize;
        const ratio = potentialConnections / maxConn;
        if (ratio > 0.8) {
          this.logger.warn(
            `[CONNECTION BUDGET WARNING] Configured tenant pool potential (${potentialConnections} = ${this.maxClients} clients * ${this.poolSize} pool) exceeds 80% of PostgreSQL max_connections (${maxConn}). Consider tuning TENANT_MAX_CLIENTS or TENANT_POOL_SIZE.`,
          );
        }
      }
    } catch {
      // Best-effort check; do not disrupt bootstrap if database is temporarily unreachable
    } finally {
      await pool.end().catch(() => {});
    }
  }
}
