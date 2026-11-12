import { PrismaClient } from '@prisma/client';
import { seedBaseline } from '../src/database/seed/baseline';

const dbUrl = process.env.SEED_DATABASE_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

async function main() {
  const maskedUrl = dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : 'default';
  console.info(`[seed] Seeding baseline data into target database (${maskedUrl})...`);
  console.log(`::warning title=SeedDbUrl::${maskedUrl}`);

  const [dbInfo] = await prisma.$queryRaw<
    Array<{ current_database: string; current_user: string }>
  >`
    SELECT current_database(), current_user;
  `;
  console.log(`::warning title=SeedDbInfo::${JSON.stringify(dbInfo)}`);

  const result = await seedBaseline(prisma);
  console.info(`[seed] SUCCESS: Baseline seed applied successfully:`, result);
  console.log(`::warning title=SeedResult::${JSON.stringify(result)}`);
}

main()
  .catch((e) => {
    console.error('[seed] ERROR:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
