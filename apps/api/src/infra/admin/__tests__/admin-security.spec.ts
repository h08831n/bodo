import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIpAllowed } from '../ip-allowlist';
import { MasterAuthService } from '../master-auth.service';
import { AdminAuditLogger } from '../admin-audit.logger';

describe('Admin Security & Master Auth', () => {
  describe('IP Allowlist & CIDR matching', () => {
    it('allows all when config is empty', () => {
      expect(isIpAllowed('192.168.1.50', '')).toBe(true);
      expect(isIpAllowed('10.0.0.1', '   ')).toBe(true);
    });

    it('matches exact single IP', () => {
      const allowed = '192.168.1.100, 10.0.0.5';
      expect(isIpAllowed('192.168.1.100', allowed)).toBe(true);
      expect(isIpAllowed('10.0.0.5', allowed)).toBe(true);
      expect(isIpAllowed('192.168.1.101', allowed)).toBe(false);
    });

    it('matches localhost and IPv6 localhost', () => {
      const allowed = '127.0.0.1';
      expect(isIpAllowed('127.0.0.1', allowed)).toBe(true);
      expect(isIpAllowed('::1', allowed)).toBe(true);
      expect(isIpAllowed('::ffff:127.0.0.1', allowed)).toBe(true);
    });

    it('matches CIDR subnets', () => {
      const allowed = '10.0.0.0/8, 192.168.1.0/24';
      expect(isIpAllowed('10.5.20.1', allowed)).toBe(true);
      expect(isIpAllowed('10.254.254.254', allowed)).toBe(true);
      expect(isIpAllowed('192.168.1.42', allowed)).toBe(true);
      expect(isIpAllowed('192.168.2.1', allowed)).toBe(false);
      expect(isIpAllowed('172.16.0.1', allowed)).toBe(false);
    });
  });

  describe('AdminAuditLogger', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodo-audit-test-'));
      process.env.LOGS_DIR = tempDir;
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('writes audit logs without exposing passwords or secrets', () => {
      const logger = new AdminAuditLogger();
      logger.log({
        ip: '127.0.0.1',
        action: 'TEST_ACTION',
        status: 'SUCCESS',
        requestId: 'req-1',
        details: {
          adminPassword: 'SecretPassword123!',
          token: 'jwt.token.secret',
          safeField: 'safeValue',
        },
      });

      const logFile = path.join(tempDir, 'admin-audit.log');
      expect(fs.existsSync(logFile)).toBe(true);

      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).not.toContain('SecretPassword123!');
      expect(content).not.toContain('jwt.token.secret');
      expect(content).toContain('******');
      expect(content).toContain('safeValue');
    });
  });

  describe('MasterAuthService JWT & Version Revocation', () => {
    let authService: MasterAuthService;
    let mockConfigStore: { read: jest.Mock; write: jest.Mock };
    let mockRedis: { getClient: jest.Mock };

    beforeEach(() => {
      mockConfigStore = {
        read: jest.fn().mockResolvedValue({
          passwordHash: 'dummy_hash',
          passwordVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        write: jest.fn().mockResolvedValue(undefined),
      };

      mockRedis = {
        getClient: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue(null),
          incr: jest.fn().mockResolvedValue(1),
          expire: jest.fn().mockResolvedValue(1),
          del: jest.fn().mockResolvedValue(1),
        }),
      };

      authService = new MasterAuthService(
        mockConfigStore as unknown as ConstructorParameters<typeof MasterAuthService>[0],
        mockRedis as unknown as ConstructorParameters<typeof MasterAuthService>[1],
      );
    });

    it('generates a valid admin JWT with aud=admin and sub=master_admin', async () => {
      const { token, expiresIn } = authService.generateToken(1);
      expect(token).toBeDefined();
      expect(expiresIn).toBe(900);

      const verified = await authService.verifyToken(token);
      expect(verified).not.toBeNull();
      expect(verified?.aud).toBe('admin');
      expect(verified?.sub).toBe('master_admin');
      expect(verified?.pv).toBe(1);
    });

    it('rejects a token when passwordVersion has changed (revocation)', async () => {
      const { token } = authService.generateToken(1);

      // Now simulate master password change, incrementing pv to 2
      mockConfigStore.read.mockResolvedValueOnce({
        passwordHash: 'new_hash',
        passwordVersion: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Clear internal cache
      (authService as unknown as { cachedConfig: unknown }).cachedConfig = null;

      const verified = await authService.verifyToken(token);
      expect(verified).toBeNull(); // Old token is invalid!
    });
  });
});
