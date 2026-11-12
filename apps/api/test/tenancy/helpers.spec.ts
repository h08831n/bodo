import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ConfigStoreService } from '../../src/infra/config-store/config-store.service';
import { DomainMap } from '../../src/infra/config-store/domain-map';
import { filestorePath } from '../../src/infra/filestore/filestore';
import { tenantKey, tenantQueueName, globalKey } from '../../src/infra/redis/redis-keys';

describe('Tenancy Helpers & Isolations (Tests 13, 14, 15)', () => {
  const testDataDir = path.resolve(__dirname, '../temp_test_data');

  beforeAll(() => {
    process.env.CONFIG_DIR = path.join(testDataDir, 'config');
    process.env.FILESTORE_DIR = path.join(testDataDir, 'filestore');
    fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
    fs.mkdirSync(process.env.FILESTORE_DIR, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe('ConfigStore & DomainMap (Test 13)', () => {
    const TestSchema = z.object({
      title: z.string(),
      count: z.number(),
    });

    it('performs atomic writes and verifies content', async () => {
      const store = new ConfigStoreService();
      await store.write('test-atomic.json', { title: 'Bodo', count: 42 }, TestSchema);

      const content = await store.read('test-atomic.json', TestSchema);
      expect(content).toEqual({ title: 'Bodo', count: 42 });

      // Ensure no temp files remain in directory
      const files = fs.readdirSync(process.env.CONFIG_DIR!);
      const tempFiles = files.filter((f) => f.startsWith('.tmp_'));
      expect(tempFiles).toEqual([]);
    });

    it('safely serializes concurrent writes without data loss or corruption', async () => {
      const store = new ConfigStoreService();
      const filename = 'concurrent.json';

      const writes = Array.from({ length: 20 }, (_, i) =>
        store.write(filename, { title: `Iteration ${i}`, count: i }, TestSchema),
      );

      await Promise.all(writes);

      const finalContent = await store.read(filename, TestSchema);
      expect(typeof finalContent.count).toBe('number');
      expect(finalContent.title).toMatch(/^Iteration \d+$/);
    });

    it('uses mtime cache to avoid redundant disk reads, and updates when file changes', async () => {
      const store = new ConfigStoreService();
      const filename = 'cached.json';
      await store.write(filename, { title: 'Initial', count: 1 }, TestSchema);

      const firstRead = await store.read(filename, TestSchema);
      const secondRead = await store.read(filename, TestSchema);
      expect(firstRead).toEqual(secondRead);

      // Delay briefly to ensure distinct mtime timestamp
      await new Promise((r) => setTimeout(r, 50));
      await store.write(filename, { title: 'Updated', count: 2 }, TestSchema);

      const thirdRead = await store.read(filename, TestSchema);
      expect(thirdRead).toEqual({ title: 'Updated', count: 2 });
    });

    it('DomainMap normalizes host, strips port, ignores wildcards, and handles missing/corrupt file', async () => {
      const store = new ConfigStoreService();
      const domainMap = new DomainMap(store);

      // 1. Initially missing file: returns empty without throwing
      const initial = await domainMap.resolve('unknown.local');
      expect(initial).toBeNull();

      // 2. Configure domains
      await domainMap.setDomain('acme.erp.local', 'erp_acme');
      await domainMap.setDomain('steel.bodo.ir', 'erp_steel_trading');

      // 3. Normalization checks: case-insensitive, port stripping
      expect(await domainMap.resolve('ACME.erp.local')).toBe('erp_acme');
      expect(await domainMap.resolve('acme.erp.local:3000')).toBe('erp_acme');
      expect(await domainMap.resolve('STEEL.BODO.IR:8080')).toBe('erp_steel_trading');

      // 4. Wildcards rejected
      await expect(domainMap.setDomain('*.example.com', 'erp_test')).rejects.toThrow(
        /wildcards not allowed/,
      );

      // 5. Corrupt domains.json fallback without crashing
      const domainsFilePath = path.join(process.env.CONFIG_DIR!, 'domains.json');
      fs.writeFileSync(domainsFilePath, '{ corrupted json :::: invalid }', 'utf8');

      // Should return null gracefully rather than throwing
      const fallbackResult = await domainMap.resolve('acme.erp.local');
      expect(fallbackResult).toBeNull();
    });
  });

  describe('filestorePath Traversal Defense (Test 14)', () => {
    it('generates a valid normalized path inside tenant directory', () => {
      const target = filestorePath('erp_acme', 'documents', 'contract.pdf');
      const expectedPrefix = path.resolve(process.env.FILESTORE_DIR!, 'erp_acme');
      expect(target.startsWith(expectedPrefix)).toBe(true);
      expect(target.endsWith('contract.pdf')).toBe(true);
    });

    it('rejects directory traversal attacks and invalid database names', () => {
      const maliciousInputs = [
        '../escaped.txt',
        '..\\escaped.txt',
        '%2e%2e/escaped.txt',
        '%2e%2e\\escaped.txt',
        '/etc/passwd',
        '\\Windows\\System32',
        'C:\\secrets.txt',
        'foo/../../bar',
      ];

      for (const input of maliciousInputs) {
        expect(() => filestorePath('erp_acme', input)).toThrow(/\[SECURITY ERROR\]/);
      }

      // Invalid database names rejected
      expect(() => filestorePath('postgres', 'file.txt')).toThrow(/Invalid tenant database name/);
      expect(() => filestorePath('erp_tmp_x', 'file.txt')).toThrow(/Invalid tenant database name/);
      expect(() => filestorePath('erp_acme;drop', 'file.txt')).toThrow(
        /Invalid tenant database name/,
      );
    });
  });

  describe('Redis Key Isolation (Test 15)', () => {
    it('prefixes tenantKey with tenant:<db>: and enforces validation', () => {
      const key = tenantKey('erp_acme', 'rates', 'eur');
      expect(key).toBe('tenant:erp_acme:rates:eur');

      expect(() => tenantKey('postgres', 'rates')).toThrow(/is not a valid tenant database name/);
      expect(() => tenantKey('erp_tmp_test', 'rates')).toThrow(
        /is not a valid tenant database name/,
      );
    });

    it('prefixes tenantQueueName with queue:<db>: and validates name', () => {
      const q = tenantQueueName('erp_steel_co', 'invoicing');
      expect(q).toBe('queue:erp_steel_co:invoicing');

      expect(() => tenantQueueName('erp_steel_co', 'invalid:queue:name')).toThrow(
        /Invalid queue name/,
      );
    });

    it('constructs documented global keys for maintenance', () => {
      expect(globalKey('maint', 'erp_acme')).toBe('maint:erp_acme');
      expect(() => globalKey('maint', 'postgres')).toThrow(/Invalid database name/);
      expect(globalKey('lock', 'sync_rates')).toBe('global:lock:sync_rates');
    });
  });
});
