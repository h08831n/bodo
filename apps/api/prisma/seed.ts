import { PrismaClient } from '@prisma/client';
import { seedBaseline } from '../src/database/seed/baseline';

const prisma = new PrismaClient();

async function main() {
  console.info('[seed] Seeding baseline data into target database...');
  const result = await seedBaseline(prisma);
  console.info(`[seed] SUCCESS: Baseline seed applied successfully:`, result);
}

main()
  .catch((e) => {
    console.error('[seed] ERROR:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
