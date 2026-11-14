import { scrubSensitive } from '../pg-tools.interface';
import { LocalPgToolsDriver } from '../local-pg-tools.driver';
import { DockerPgToolsDriver } from '../docker-pg-tools.driver';

describe('PgTools Drivers & Security', () => {
  describe('scrubSensitive', () => {
    it('scrubs sensitive passwords from text', () => {
      const sensitive = 'SecretPass123!';
      const log = `Error: could not connect with password SecretPass123! at localhost:5432`;
      const scrubbed = scrubSensitive(log, [sensitive]);

      expect(scrubbed).not.toContain(sensitive);
      expect(scrubbed).toContain('******');
    });

    it('handles undefined or short secrets gracefully', () => {
      const text = 'Normal log message';
      expect(scrubSensitive(text, [undefined, 'ab'])).toBe(text);
    });
  });

  describe('LocalPgToolsDriver Validation', () => {
    const driver = new LocalPgToolsDriver();

    it('rejects invalid database names for dump', async () => {
      await expect(
        driver.dump({
          database: 'erp_invalid; DROP DATABASE erp_dev;',
          user: 'postgres',
        }),
      ).rejects.toThrow(/Invalid database name/);
    });

    it('rejects invalid database names for restore', async () => {
      await expect(
        driver.restore({
          database: '$(whoami)',
          user: 'postgres',
        }),
      ).rejects.toThrow(/Invalid database name/);
    });
  });

  describe('DockerPgToolsDriver Validation & Argument Security', () => {
    const driver = new DockerPgToolsDriver('bodo-postgres-dev');

    it('rejects malicious container names', async () => {
      const maliciousDriver = new DockerPgToolsDriver('bad; rm -rf /');
      await expect(
        maliciousDriver.dump({
          database: 'erp_test',
          user: 'postgres',
        }),
      ).rejects.toThrow(/Invalid docker container name/);
    });

    it('rejects invalid database names for dump and restore', async () => {
      await expect(
        driver.dump({
          database: 'not_starting_with_erp',
          user: 'postgres',
        }),
      ).rejects.toThrow(/Invalid database name/);

      await expect(
        driver.restore({
          database: 'erp_test; select 1',
          user: 'postgres',
        }),
      ).rejects.toThrow(/Invalid database name/);
    });
  });
});
