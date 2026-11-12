import * as fs from 'fs';
import * as path from 'path';

describe('Structural Tenancy Invariant (Test 18)', () => {
  it('strictly forbids "new PrismaClient" outside TenantClientManager in application source code', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const violations: string[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) &&
          !entry.name.endsWith('.spec.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          // Allowed file: tenant-client-manager.ts
          if (entry.name === 'tenant-client-manager.ts') {
            continue;
          }

          const content = fs.readFileSync(fullPath, 'utf8');
          // Match 'new PrismaClient' without comment prefix
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
              return;
            }
            if (/new\s+PrismaClient\b/.test(trimmed)) {
              violations.push(`${fullPath}:${idx + 1}: ${trimmed}`);
            }
          });
        }
      }
    }

    scanDir(srcDir);

    expect(violations).toEqual([]);
  });
});
