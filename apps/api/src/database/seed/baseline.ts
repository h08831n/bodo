import type { PrismaClient } from '@prisma/client';
import { newId } from '@bodo/utils';

/**
 * Idempotent baseline seed for a new company database.
 * Can be executed multiple times safely without duplicate rows or errors.
 * Used during initial company provisioning (Step S1.4) and dev seed scripts.
 */
export async function seedBaseline(client: PrismaClient): Promise<{
  currenciesCount: number;
  companyProfileInitialized: boolean;
  systemGroupInitialized: boolean;
  lostReasonsCount: number;
  settingsCount: number;
}> {
  // 1. Currencies (IRR, IRT, USD, EUR)
  const currenciesData = [
    { code: 'IRR', name: 'ریال ایران', symbol: 'IRR', decimals: 0, sortOrder: 1, isActive: true },
    { code: 'IRT', name: 'تومان ایران', symbol: 'IRT', decimals: 0, sortOrder: 2, isActive: true },
    { code: 'USD', name: 'دلار آمریکا', symbol: '$', decimals: 2, sortOrder: 3, isActive: true },
    { code: 'EUR', name: 'یورو', symbol: '€', decimals: 2, sortOrder: 4, isActive: true },
  ];

  for (const curr of currenciesData) {
    await client.currency.upsert({
      where: { code: curr.code },
      update: {
        name: curr.name,
        symbol: curr.symbol,
        decimals: curr.decimals,
        sortOrder: curr.sortOrder,
        isActive: curr.isActive,
      },
      create: curr,
    });
  }

  // 2. Company Profile (single record, id = 1)
  await client.companyProfile.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: '',
      defaultCurrencyCode: 'IRR',
    },
  });

  // 3. System Administrator Group (مدیر سیستم)
  const systemGroupName = 'مدیر سیستم';
  const existingGroup = await client.group.findUnique({
    where: { name: systemGroupName },
  });

  if (!existingGroup) {
    await client.group.create({
      data: {
        id: newId(),
        name: systemGroupName,
        description: 'گروه راهبران ارشد با دسترسی کامل سیستمی',
        isSystem: true,
      },
    });
  }

  // 4. Lost Reasons (7 Persian reasons, appliesTo: BOTH)
  const lostReasonsData = [
    { name: 'قیمت بالا', sortOrder: 1 },
    { name: 'رقیب قیمت کمتری داد', sortOrder: 2 },
    { name: 'نیاز مشتری منتفی شد', sortOrder: 3 },
    { name: 'زمان تحویل مناسب نبود', sortOrder: 4 },
    { name: 'شرایط پرداخت مناسب نبود', sortOrder: 5 },
    { name: 'عدم پاسخگویی مشتری', sortOrder: 6 },
    { name: 'سایر', sortOrder: 7 },
  ];

  for (const reason of lostReasonsData) {
    await client.lostReason.upsert({
      where: { name: reason.name },
      update: {
        sortOrder: reason.sortOrder,
        appliesTo: 'BOTH',
        isActive: true,
      },
      create: {
        id: newId(),
        name: reason.name,
        appliesTo: 'BOTH',
        sortOrder: reason.sortOrder,
        isActive: true,
      },
    });
  }

  // 5. System Settings (neutralized: false)
  await client.systemSetting.upsert({
    where: { key: 'neutralized' },
    update: { value: false },
    create: {
      key: 'neutralized',
      value: false,
    },
  });

  const [currenciesCount, lostReasonsCount, settingsCount] = await Promise.all([
    client.currency.count(),
    client.lostReason.count(),
    client.systemSetting.count(),
  ]);

  return {
    currenciesCount,
    companyProfileInitialized: true,
    systemGroupInitialized: true,
    lostReasonsCount,
    settingsCount,
  };
}
