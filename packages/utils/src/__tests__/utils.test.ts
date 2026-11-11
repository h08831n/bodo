import { describe, it, expect } from 'vitest';
import { slugifyDatabaseName, formatDatabaseIdentifier } from '../index.js';

describe('Utils Database Helpers', () => {
  it('slugifies database input properly', () => {
    expect(slugifyDatabaseName('My Company-123')).toBe('my_company_123');
    expect(slugifyDatabaseName('__sample__db__')).toBe('sample__db');
  });

  it('formats database identifier with erp_ prefix', () => {
    expect(formatDatabaseIdentifier('acme')).toBe('erp_acme');
    expect(formatDatabaseIdentifier('iron_trade')).toBe('erp_iron_trade');
  });
});
