import { describe, it, expect } from 'vitest';
import {
  isValidDatabaseName,
  isValidCompanySlug,
  slugToDatabaseName,
  databaseNameToSlug,
} from '../database-name.js';

describe('database-name utilities', () => {
  describe('isValidDatabaseName', () => {
    it('accepts standard valid tenant database names', () => {
      expect(isValidDatabaseName('erp_acme')).toBe(true);
      expect(isValidDatabaseName('erp_steel_trading')).toBe(true);
      expect(isValidDatabaseName('erp_company_123')).toBe(true);
      expect(isValidDatabaseName('erp_123')).toBe(true);
      expect(isValidDatabaseName('erp_a_b_c')).toBe(true);
    });

    it('rejects reserved postgres database names', () => {
      expect(isValidDatabaseName('postgres')).toBe(false);
      expect(isValidDatabaseName('template0')).toBe(false);
      expect(isValidDatabaseName('template1')).toBe(false);
      expect(isValidDatabaseName('defaultdb')).toBe(false);
      expect(isValidDatabaseName('rdsadmin')).toBe(false);
    });

    it('rejects temporary provisioning names starting with erp_tmp_', () => {
      expect(isValidDatabaseName('erp_tmp_acme')).toBe(false);
      expect(isValidDatabaseName('erp_tmp_12345')).toBe(false);
      expect(isValidDatabaseName('erp_tmp_prov_1')).toBe(false);
    });

    it('rejects SQL injection, toxic characters and whitespace', () => {
      expect(isValidDatabaseName('erp_x; drop table users;')).toBe(false);
      expect(isValidDatabaseName('erp_acme--comment')).toBe(false);
      expect(isValidDatabaseName('erp_acme/test')).toBe(false);
      expect(isValidDatabaseName('erp_acme test')).toBe(false);
      expect(isValidDatabaseName('erp_acme\ntest')).toBe(false);
      expect(isValidDatabaseName('erp_acme"')).toBe(false);
      expect(isValidDatabaseName("erp_acme'")).toBe(false);
    });

    it('rejects uppercase letters', () => {
      expect(isValidDatabaseName('ERP_ACME')).toBe(false);
      expect(isValidDatabaseName('erp_Acme')).toBe(false);
    });

    it('rejects consecutive underscores and trailing underscores', () => {
      expect(isValidDatabaseName('erp_foo__bar')).toBe(false);
      expect(isValidDatabaseName('erp_trailing_')).toBe(false);
    });

    it('enforces length boundaries (3 to 40 chars after erp_)', () => {
      expect(isValidDatabaseName('erp_ab')).toBe(false); // only 2 chars after prefix
      expect(isValidDatabaseName('erp_abc')).toBe(true); // 3 chars -> valid
      const exactly40Chars = 'a'.repeat(40);
      expect(isValidDatabaseName(`erp_${exactly40Chars}`)).toBe(true);
      const chars41 = 'a'.repeat(41);
      expect(isValidDatabaseName(`erp_${chars41}`)).toBe(false);
    });

    it('rejects non-strings, null, undefined, empty', () => {
      expect(isValidDatabaseName('')).toBe(false);
      expect(isValidDatabaseName(null)).toBe(false);
      expect(isValidDatabaseName(undefined)).toBe(false);
      expect(isValidDatabaseName(12345)).toBe(false);
      expect(isValidDatabaseName({})).toBe(false);
    });
  });

  describe('isValidCompanySlug', () => {
    it('validates company slugs', () => {
      expect(isValidCompanySlug('acme')).toBe(true);
      expect(isValidCompanySlug('steel_co')).toBe(true);
      expect(isValidCompanySlug('ab')).toBe(false);
      expect(isValidCompanySlug('tmp_test')).toBe(false);
      expect(isValidCompanySlug('test__double')).toBe(false);
    });
  });

  describe('slugToDatabaseName & databaseNameToSlug', () => {
    it('converts valid slug to database name', () => {
      expect(slugToDatabaseName('acme')).toBe('erp_acme');
      expect(slugToDatabaseName('  steel_co  ')).toBe('erp_steel_co');
    });

    it('throws when converting invalid slug', () => {
      expect(() => slugToDatabaseName('ab')).toThrow(/Invalid company slug/);
      expect(() => slugToDatabaseName('tmp_acme')).toThrow(/Invalid company slug/);
      expect(() => slugToDatabaseName('acme;drop')).toThrow(/Invalid company slug/);
    });

    it('extracts slug from valid database name', () => {
      expect(databaseNameToSlug('erp_acme')).toBe('acme');
      expect(databaseNameToSlug('erp_steel_co')).toBe('steel_co');
    });

    it('throws when extracting slug from invalid database name', () => {
      expect(() => databaseNameToSlug('postgres')).toThrow(/Invalid tenant database name/);
      expect(() => databaseNameToSlug('erp_tmp_123')).toThrow(/Invalid tenant database name/);
    });
  });
});
