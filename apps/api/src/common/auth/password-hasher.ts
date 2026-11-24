import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { getEnv } from '../../config/env.config';

export interface Argon2Options {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

@Injectable()
export class PasswordHasher {
  private dummyHashPromise: Promise<string> | null = null;

  private getOptions(): Argon2Options {
    const env = getEnv();
    return {
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    };
  }

  /**
   * Hashes a password asynchronously using Argon2id with configured OWASP parameters.
   */
  async hashPassword(password: string, customOptions?: Partial<Argon2Options>): Promise<string> {
    const opts = { ...this.getOptions(), ...customOptions };
    return hash(password, {
      memoryCost: opts.memoryCost,
      timeCost: opts.timeCost,
      parallelism: opts.parallelism,
    });
  }

  /**
   * Verifies a password against an Argon2id hash asynchronously.
   */
  async verifyPassword(passwordHash: string, candidatePassword: string): Promise<boolean> {
    try {
      return await verify(passwordHash, candidatePassword);
    } catch {
      return false;
    }
  }

  /**
   * Performs an asynchronous verify against a pre-computed dummy hash.
   * Ensures non-existent users incur the identical argon2 execution timing
   * as existing users to completely eliminate user-enumeration timing oracles.
   */
  async dummyVerify(candidatePassword: string): Promise<boolean> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.hashPassword('dummy-timing-oracle-shield-bodo-2026');
    }
    const dummyHash = await this.dummyHashPromise;
    try {
      await verify(dummyHash, candidatePassword);
    } catch {
      // Intentionally ignored, always returns false
    }
    return false;
  }

  /**
   * Determines if a password hash needs to be rehashed based on current configured parameters.
   * Argon2 hashes contain $m=...,t=...,p=...
   */
  needsRehash(passwordHash: string): boolean {
    const current = this.getOptions();
    // Parse $m=...,t=...,p=...
    const match = /\$m=(\d+),t=(\d+),p=(\d+)/.exec(passwordHash);
    if (!match || !match[1] || !match[2] || !match[3]) {
      return true;
    }
    const m = parseInt(match[1], 10);
    const t = parseInt(match[2], 10);
    const p = parseInt(match[3], 10);

    return m < current.memoryCost || t < current.timeCost || p < current.parallelism;
  }
}
