import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('Module Boundaries & Architecture Rules', () => {
  it('forbids importing TenantTransactionService directly inside any *.controller.ts', () => {
    const invalidSnippet =
      "import { TenantTransactionService } from './infra/tenancy/tenant-transaction.service';";
    let failed = false;
    let output = '';

    try {
      execSync(`pnpm eslint --stdin --stdin-filename apps/api/src/test.controller.ts`, {
        input: invalidSnippet,
        cwd: path.resolve(__dirname, '../../../../'),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      failed = true;
      output = (err as { stdout?: string; stderr?: string }).stdout || '';
    }

    expect(failed).toBe(true);
    expect(output).toContain('Controllers must not manage database transactions directly');
  });

  it('guarantees all infra directories expose a public index.ts', () => {
    const infraDir = path.resolve(__dirname, '../../infra');
    const entries = fs.readdirSync(infraDir, { withFileTypes: true });

    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_'));
    for (const sub of subdirs) {
      const indexPath = path.join(infraDir, sub.name, 'index.ts');
      expect(fs.existsSync(indexPath)).toBe(true);
    }
  });

  it('guarantees module template contains standard files and index.ts', () => {
    const templateDir = path.resolve(__dirname, '../../modules/_template');
    expect(fs.existsSync(path.join(templateDir, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(templateDir, 'template.module.ts'))).toBe(true);
    expect(fs.existsSync(path.join(templateDir, 'template.service.ts'))).toBe(true);
    expect(fs.existsSync(path.join(templateDir, 'template.controller.ts'))).toBe(true);
  });
});
