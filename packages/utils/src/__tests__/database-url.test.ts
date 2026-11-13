import { describe, it, expect } from 'vitest';
import { buildDatabaseUrl } from '../database-url.js';

describe('buildDatabaseUrl', () => {
  it('builds standard postgresql URL with 127.0.0.1 normalized host', () => {
    const url = buildDatabaseUrl({
      host: 'localhost',
      port: 5433,
      user: 'erp_app',
      password: 'secret_password',
      database: 'erp_acme',
    });
    expect(url).toBe('postgresql://erp_app:secret_password@127.0.0.1:5433/erp_acme');
  });

  it('encodes special characters in user and password', () => {
    const url = buildDatabaseUrl({
      host: '10.0.0.5',
      port: 5432,
      user: 'user@domain.com',
      password: 'p@ss:w/o?r#d',
      database: 'erp_test',
    });
    expect(url).toBe(
      'postgresql://user%40domain.com:p%40ss%3Aw%2Fo%3Fr%23d@10.0.0.5:5432/erp_test',
    );
  });

  it('appends connection limit and ssl mode when specified', () => {
    const url = buildDatabaseUrl({
      host: 'db.example.internal',
      port: 5432,
      user: 'erp_app',
      password: 'pwd',
      database: 'erp_prod',
      connectionLimit: 10,
      ssl: 'require',
    });
    expect(url).toBe(
      'postgresql://erp_app:pwd@db.example.internal:5432/erp_prod?sslmode=require&connection_limit=10',
    );
  });

  it('handles empty password correctly', () => {
    const url = buildDatabaseUrl({
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
    });
    expect(url).toBe('postgresql://postgres@127.0.0.1:5432/postgres');
  });
});
