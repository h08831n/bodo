import { validateEnv } from './env.config';

describe('Environment Configuration Validation', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Mock console.error to keep unit test logs clean while testing failure cases
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });
  const validEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGINS: 'http://localhost:5173,http://localhost:3000',
    MASTER_PASSWORD_INITIAL: 'MasterSecurePassword2026!',
    DB_MANAGER_ENABLED: 'true',
    DB_MANAGER_ALLOWED_IPS: '',
    DB_LIST_PUBLIC: 'false',
    AUTO_MIGRATE: 'false',
    PG_BIN_PATH: '',
    JWT_SECRET: 'super_secret_jwt_key_min_16_chars',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  it('successfully validates and parses a valid environment object', () => {
    const config = validateEnv(validEnv);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.DB_MANAGER_ENABLED).toBe(true);
    expect(config.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/postgres');
    expect(config.TENANT_MAX_CLIENTS).toBe(20);
    expect(config.TENANT_POOL_SIZE).toBe(5);
    expect(config.TENANT_IDLE_MS).toBe(600000);
    expect(config.CONFIG_DIR).toBe('./data/config');
    expect(config.FILESTORE_DIR).toBe('./data/filestore');
  });

  it('fails with a readable error when DATABASE_URL is missing', () => {
    const invalid = { ...validEnv, DATABASE_URL: '' };
    expect(() => validateEnv(invalid)).toThrow(
      /\[CRITICAL\] Application failed to boot due to invalid\/missing environment variables:/,
    );
    expect(() => validateEnv(invalid)).toThrow(/DATABASE_URL is required/);
  });

  it('fails when MASTER_PASSWORD_INITIAL is shorter than 8 characters', () => {
    const invalid = { ...validEnv, MASTER_PASSWORD_INITIAL: 'short' };
    expect(() => validateEnv(invalid)).toThrow(/MASTER_PASSWORD_INITIAL must be at least 8 chars/);
  });

  it('fails when JWT_SECRET is shorter than 16 characters', () => {
    const invalid = { ...validEnv, JWT_SECRET: 'too-short' };
    expect(() => validateEnv(invalid)).toThrow(/JWT_SECRET must be at least 16 chars/);
  });

  it('fails when ENCRYPTION_KEY is shorter than 32 characters', () => {
    const invalid = { ...validEnv, ENCRYPTION_KEY: 'short-key' };
    expect(() => validateEnv(invalid)).toThrow(/ENCRYPTION_KEY must be at least 32 chars/);
  });
});
