import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load .env file from current working directory or traverse up to monorepo root
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../../../.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default('3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_PASSWORD: z.string().optional().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),
  MASTER_PASSWORD_INITIAL: z.string().min(8, 'MASTER_PASSWORD_INITIAL must be at least 8 chars'),
  DB_MANAGER_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  DB_MANAGER_ALLOWED_IPS: z.string().default(''),
  DB_LIST_PUBLIC: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  AUTO_MIGRATE: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  PG_BIN_PATH: z.string().optional().default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 chars'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let parsedEnv: EnvConfig | null = null;

export function validateEnv(rawEnv: NodeJS.ProcessEnv): EnvConfig {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => ` - [${issue.path.join('.')}] ${issue.message}`)
      .join('\n');
    const msg = `[CRITICAL] Application failed to boot due to invalid/missing environment variables:\n${errorDetails}`;
    // Direct console.error is intentionally used here during early bootstrapping
    // before the NestJS application context and Pino Logger are initialized.
    console.error(msg);
    throw new Error(msg);
  }
  return result.data;
}

export function getEnv(): EnvConfig {
  if (parsedEnv) {
    return parsedEnv;
  }
  parsedEnv = validateEnv(process.env);
  return parsedEnv;
}
