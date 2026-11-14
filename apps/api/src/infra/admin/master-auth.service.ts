import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { ConfigStoreService } from '../config-store/config-store.service';
import { RedisService } from '../redis/redis.service';
import { getEnv } from '../../config/env.config';

export const MasterConfigSchema = z.object({
  passwordHash: z.string(),
  passwordVersion: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MasterConfig = z.infer<typeof MasterConfigSchema>;

export interface AdminJwtPayload {
  aud: 'admin';
  sub: 'master_admin';
  pv: number;
  exp: number;
  iat: number;
}

@Injectable()
export class MasterAuthService implements OnModuleInit {
  private readonly logger = new Logger(MasterAuthService.name);
  private readonly masterFileName = 'master.json';
  private cachedConfig: MasterConfig | null = null;

  constructor(
    private readonly configStore: ConfigStoreService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initMasterPassword();
  }

  async initMasterPassword(): Promise<void> {
    const env = getEnv();

    try {
      this.cachedConfig = await this.configStore.read(this.masterFileName, MasterConfigSchema);
      return;
    } catch {
      // File does not exist yet, initialize from MASTER_PASSWORD_INITIAL
    }

    const initialPassword = env.MASTER_PASSWORD_INITIAL;
    if (!initialPassword) {
      throw new Error(
        'Neither master.json exists nor MASTER_PASSWORD_INITIAL is provided in environment.',
      );
    }

    this.logger.log('Initializing master.json using argon2id from MASTER_PASSWORD_INITIAL...');
    const passwordHash = await hash(initialPassword);
    const now = new Date().toISOString();

    const initialConfig: MasterConfig = {
      passwordHash,
      passwordVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.configStore.write(this.masterFileName, initialConfig, MasterConfigSchema);
    this.cachedConfig = initialConfig;

    this.logger.warn(
      '[SECURITY NOTICE] master.json has been initialized. You should remove MASTER_PASSWORD_INITIAL from .env.',
    );
  }

  async getConfig(): Promise<MasterConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }
    this.cachedConfig = await this.configStore.read(this.masterFileName, MasterConfigSchema);
    return this.cachedConfig;
  }

  async checkRateLimit(ip: string): Promise<{ allowed: boolean; remainingAttempts: number }> {
    const key = `admin:ratelimit:login:${ip}`;
    const redis = this.redisService.getClient();

    const attemptsStr = await redis.get(key);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;

    if (attempts >= 5) {
      return { allowed: false, remainingAttempts: 0 };
    }

    return { allowed: true, remainingAttempts: 5 - attempts };
  }

  async recordLoginAttempt(ip: string, success: boolean): Promise<void> {
    const key = `admin:ratelimit:login:${ip}`;
    const redis = this.redisService.getClient();

    if (success) {
      await redis.del(key);
    } else {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, 900); // 15 minutes lockout window
      }
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    const config = await this.getConfig();
    try {
      return await verify(config.passwordHash, password);
    } catch {
      return false;
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const isValid = await this.validatePassword(currentPassword);
    if (!isValid) {
      throw new Error('Current master password is incorrect');
    }

    if (newPassword.length < 12) {
      throw new Error('New master password must be at least 12 characters');
    }

    const newHash = await hash(newPassword);
    const currentConfig = await this.getConfig();

    const updatedConfig: MasterConfig = {
      passwordHash: newHash,
      passwordVersion: currentConfig.passwordVersion + 1,
      createdAt: currentConfig.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await this.configStore.write(this.masterFileName, updatedConfig, MasterConfigSchema);
    this.cachedConfig = updatedConfig;
    this.logger.log(
      `Master password changed successfully. Incremented passwordVersion to ${updatedConfig.passwordVersion}. All prior tokens invalidated.`,
    );
  }

  generateToken(pv: number): { token: string; expiresIn: number } {
    const expiresIn = 900; // 15 minutes
    const now = Math.floor(Date.now() / 1000);
    const payload: AdminJwtPayload = {
      aud: 'admin',
      sub: 'master_admin',
      pv,
      iat: now,
      exp: now + expiresIn,
    };

    const secret = this.getJwtSecret();
    const token = this.signJwt(payload as unknown as Record<string, unknown>, secret);

    return { token, expiresIn };
  }

  async verifyToken(token: string): Promise<AdminJwtPayload | null> {
    const secret = this.getJwtSecret();
    const payload = this.decodeAndVerifyJwt(token, secret);
    if (!payload) return null;

    if (payload.aud !== 'admin' || payload.sub !== 'master_admin') {
      return null;
    }

    // Verify token version against current passwordVersion
    const config = await this.getConfig();
    if (payload.pv !== config.passwordVersion) {
      return null; // Token invalidated by password change
    }

    return payload;
  }

  private getJwtSecret(): string {
    const env = getEnv();
    if (env.ADMIN_JWT_SECRET && env.ADMIN_JWT_SECRET.trim().length >= 16) {
      return env.ADMIN_JWT_SECRET.trim();
    }
    // Derive via HKDF from JWT_SECRET if ADMIN_JWT_SECRET not provided
    const salt = Buffer.from('bodo-admin-jwt-salt-2026', 'utf8');
    const ikm = Buffer.from(env.JWT_SECRET, 'utf8');
    const derived = Buffer.from(
      crypto.hkdfSync('sha256', ikm, salt, Buffer.from('admin-auth', 'utf8'), 32),
    );
    return derived.toString('hex');
  }

  private signJwt(payload: Record<string, unknown>, secret: string): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  private decodeAndVerifyJwt(token: string, secret: string): AdminJwtPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const encodedHeader = parts[0];
      const encodedPayload = parts[1];
      const signature = parts[2];

      if (!encodedHeader || !encodedPayload || !signature) return null;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null;
      }

      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as AdminJwtPayload;

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }
}
