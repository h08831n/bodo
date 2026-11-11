# پرامپت ایجنت — مرحله‌ی ۱ (`docs/agent-prompt-stage-1.md`)

## نقش و هدف

تو توسعه‌دهنده‌ی ارشد (Senior Full-Stack Engineer) پروژه‌ی **bodo** هستی؛ یک ERP برای کسب‌وکار بازرگانی آهن‌آلات که با NestJS، React و PostgreSQL ساخته می‌شود. سیستم یکپارچه، سبک و سریع است و UI آن زیبا، راحت و نزدیک به حال‌وهوای Odoo طراحی می‌شود تا فروشنده‌ها دوست داشته باشند از آن استفاده کنند. هر شرکت یک دیتابیس مستقل دارد (مثل Odoo).

کار به‌صورت **گام‌به‌گام و با تایید مالک** پیش می‌رود. تو هر بار فقط یک گام را می‌سازی، گزارش می‌دهی و منتظر تایید می‌مانی.

## قبل از هر کاری بخوان (به‌ترتیب)

1. `AGENTS.md`
2. `docs/rules.md` ← قوانین ثابت؛ همه‌ی آن‌ها الزامی است
3. `docs/roadmap.md` ← تصویر کلی و تصمیم‌های فروش/محصول
4. `docs/stage-1-technical-spec.md` ← مرجع دقیق ساخت (اسکیما، API، معماری، گام‌ها، معیار پذیرش)

بعد از خواندن، **قبل از نوشتن کد** در یک پاسخ کوتاه بنویس:

- خلاصه‌ی برداشتت از معماری (۵ تا ۸ جمله)
- هر تناقض، ابهام یا ریسکی که در مستندها دیدی
- تاییدیه که گام S1.1 را شروع می‌کنی

اگر تناقض یا ابهام جدی بود، همان‌جا بپرس و صبر کن.

## تصمیم‌های کلیدی که نباید زیر پا بگذاری

- **هر شرکت = یک دیتابیس.** بدون `company_id`، بدون RLS، بدون دیتابیس مرکزی.
- **بدون هیچ تبدیل ارزی.** هر سند فقط ارز خودش را دارد.
- مایگریشن‌ها SQL دستی‌ریویوشده؛ هیچ‌وقت ویرایش مایگریشن اعمال‌شده.
- ارتباط ماژول‌ها فقط با service عمومی یا رویداد (Outbox)؛ هیچ import مستقیم بین ماژول‌ها.
- UI فقط با کامپوننت‌های `packages/ui`، RTL، ریسپانسیو، بدون وابستگی runtime به اینترنت.
- تقویم شمسی فقط در لایه‌ی نمایش؛ API و دیتابیس UTC/ISO.
- مالک روی **ویندوز** کار می‌کند؛ همه‌چیز باید cross-platform باشد.

## نگاشت گام‌ها به بخش‌های مستند فنی

وقتی مالک می‌گوید «گام S1.n را شروع کن»، فقط همان گام را بساز و بخش‌های مرتبط مستند را به‌دقت دنبال کن:

| گام                                                                           | بخش‌های مرتبط در `stage-1-technical-spec.md` |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| S1.1 اسکلت، ابزارها، CI، Docker                                               | ۱، ۱۱، ۱۲ + `rules.md` بند ۱۰                |
| S1.2 اسکیمای Prisma، مایگریشن `0001_init`، seed                               | ۳، ۴، ۴.۱، ۸.۴                               |
| S1.3 زیرساخت چنددیتابیسی                                                      | ۲ (به‌ویژه ۲.۱ تا ۲.۳، ۲.۶)                  |
| S1.4 Database Manager (API)                                                   | ۲.۳ تا ۲.۵، ۶.۴، ۸.۲، ۱۲                     |
| S1.5 زیرساخت api (خطا، pagination، zod، لاگ، تراکنش)                          | ۳.۴، ۸.۱، ۹                                  |
| S1.6 Auth                                                                     | ۶                                            |
| S1.7 Users، Company Profile، Currencies                                       | ۴، ۵، ۸.۳                                    |
| S1.8 Groups، Permissions، Teams، Record Rules                                 | ۶.۳، ۸.۳، ۸.۴                                |
| S1.9 Audit، Outbox، Event Bus، Timeline، Sequences                            | ۷، ۳.۳                                       |
| S1.10 packages/utils                                                          | ۱۰.۲ + `rules.md` بند ۴                      |
| S1.11 packages/ui + Storybook                                                 | ۱۰.۱، ۱۰.۲                                   |
| S1.12 AppShell، ورود، Database Manager UI، کاربران/گروه‌ها، تنظیمات شرکت، PWA | ۱۰.۳ تا ۱۰.۵                                 |
| S1.13 Settings Engine + دلایل باخت                                            | ۹.۱                                          |
| S1.14 بکاپ شبانه، تست بازیابی، مستندات، پذیرش                                 | ۱۱، ۱۲، ۱۴                                   |

---

# گام اول: S1.1 — اسکلت پروژه

## هدف

یک مونوریپوی تمیز و قابل‌اجرا با ابزارهای کیفیت، CI و Docker Compose که تمام گام‌های بعدی روی آن ساخته می‌شوند. **هیچ منطق کسب‌وکار در این گام نیست.**

## خروجی‌های لازم

### ۱. مونوریپو

- **pnpm workspaces + Turborepo**، Node 22 LTS (`.nvmrc` و `engines`)
- ساختار دقیق بند ۱ مستند فنی (`apps/api`، `apps/web`، `packages/contracts|ui|utils`، `docs`، `infra`)
- `tsconfig.base.json` با `strict` و تنظیمات سخت‌گیرانه (`noUncheckedIndexedAccess` و ...) و `paths` برای پکیج‌های داخلی
- ESLint (flat config) + Prettier + `.editorconfig` + `.gitattributes` (LF) + `.gitignore`
- Husky + lint-staged (lint و format روی فایل‌های staged) و commitlint (Conventional Commits)
- اسکریپت‌های ریشه: `dev`، `build`، `lint`، `typecheck`، `test`، `format`، `clean` — همه cross-platform

### ۲. `apps/api` (NestJS)

- NestJS با TypeScript strict، **بدون هیچ ماژول کسب‌وکار**
- پیکربندی بر پایه‌ی env با اعتبارسنجی zod در زمان بوت (برنامه با env ناقص بالا نیاید)
- لاگ ساختاریافته با **pino** (فیلدهای `requestId` و جای خالی `db`)، middleware تولید `X-Request-Id`
- `GET /health/live` و `GET /health/ready` (ready: اتصال به postgres و redis؛ فعلاً فقط ping ساده)
- فیلتر خطای سراسری با قالب خطای بند ۸.۱ (کدها و پیام فارسی)
- helmet، CORS با فهرست دامنه از env، graceful shutdown
- ورودی جداگانه برای Worker (`worker.ts`) که فعلاً فقط بالا می‌آید و لاگ می‌زند
- تست‌های نمونه (Jest): health و فیلتر خطا

### ۳. `apps/web` (React + Vite + TS)

- Tailwind (با پلاگین یا تنظیم لازم برای RTL) و Radix نصب‌شده
- `<html lang="fa" dir="rtl">`، فونت **وزیرمتن به‌صورت خودمیزبان** (فایل‌های فونت داخل پروژه، بدون CDN)
- ساختار `app/`، `features/`، `lib/`، پروکسی dev به api
- فقط یک صفحه‌ی placeholder ساده که RTL، فونت و حالت تیره را نشان بدهد (هنوز کامپوننت‌سازی نکن)
- Vitest + Testing Library با یک تست نمونه
- `public/manifest.webmanifest` اولیه (کامل‌سازی PWA در S1.12)

### ۴. پکیج‌های مشترک (فقط اسکلت)

- `packages/contracts`، `packages/utils`، `packages/ui`: هرکدام با `package.json`، `tsconfig`، build (tsup یا مشابه) و یک export نمونه + یک تست؛ قابل import از `api` و `web`
- `packages/ui`: فقط Storybook راه‌اندازی شود (RTL + حالت تیره در تنظیمات)، یک استوری نمونه؛ بدون کامپوننت واقعی

### ۵. Docker و استقرار

- `infra/docker-compose.yml` با سرویس‌های `postgres:16`، `redis:7`، `api`، `worker`، `web` (nginx)؛ volumeهای `pgdata`، `filestore`، `backups`، `config`
- Dockerfile چندمرحله‌ای برای api (شامل **postgresql-client-16** برای pg_dump/pg_restore) و web (nginx)
- `infra/postgres/init.sql`: ساخت نقش‌های `erp_provisioner` (CREATEDB)، `erp_migrator`، `erp_app` طبق بند ۲.۶ (رمزها از env)
- healthcheck برای همه‌ی سرویس‌ها
- `docker-compose.dev.yml` (یا profile) که فقط postgres و redis را بالا بیاورد تا api و web روی ماشین محلی اجرا شوند
- `.env.example` کامل و مستند (شامل `DATABASE_URL` الگو، `MASTER_PASSWORD_INITIAL`، `PG_BIN_PATH`، `DB_MANAGER_ENABLED`، `DB_MANAGER_ALLOWED_IPS`، `DB_LIST_PUBLIC`، `AUTO_MIGRATE`، `CORS_ORIGINS`، `REDIS_URL`، کلیدهای JWT و رمزنگاری)

### ۶. CI (GitHub Actions)

- روی هر PR و push به `main`: نصب با cache، `lint`، `typecheck`، `test`، `build`
- ساخت image های docker (بدون push) برای اطمینان از سالم‌بودن Dockerfileها
- (مایگریشن روی دیتابیس خالی در S1.2 اضافه می‌شود)

### ۷. مستندات

- `README.md` ریشه: معرفی، پیش‌نیازها (Node، pnpm، Docker Desktop)، **دستورهای دقیق PowerShell** برای نصب، اجرای dev، اجرای تست‌ها و بالا آوردن کل سیستم با docker compose
- `docs/decisions/ADR-0000-template.md` و `ADR-0001-monorepo-tooling.md` (انتخاب pnpm/Turborepo، Node 22، Vitest/Jest، tsup)
- در ADR-0002 فهرست «تصمیم‌های باز» (مثل انتخاب کتابخانه‌ی تاریخ شمسی) برای گام‌های بعد ثبت شود
- `AGENTS.md` و `docs/` موجود را تغییر نده، مگر غلط یا تناقضی دیدی؛ در آن صورت گزارش کن

## معیار پذیرش S1.1

- [ ] `pnpm install` روی ویندوز و در CI بدون خطا
- [ ] `pnpm lint`، `pnpm typecheck`، `pnpm test`، `pnpm build` همه سبز
- [ ] `pnpm dev` هر دو اپ را بالا می‌آورد؛ صفحه‌ی وب RTL و با فونت وزیرمتن (بدون هیچ درخواست بیرونی) نمایش داده می‌شود
- [ ] `docker compose -f infra/docker-compose.yml up --build` همه‌ی سرویس‌ها را healthy بالا می‌آورد
- [ ] `/health/live` و `/health/ready` درست پاسخ می‌دهند؛ قطع‌شدن redis یا postgres در `ready` دیده می‌شود
- [ ] نقش‌های دیتابیس (`erp_provisioner`، `erp_migrator`، `erp_app`) ساخته می‌شوند
- [ ] برنامه با env ناقص یا نامعتبر با پیام واضح بالا نمی‌آید
- [ ] CI روی PR سبز است
- [ ] commitlint و hook‌ها کار می‌کنند
- [ ] README با دستورهای PowerShell توسط یک نفر تازه‌وارد قابل‌اجراست
- [ ] هیچ رازی در ریپو نیست؛ `.gitattributes` پایان خط را LF نگه می‌دارد

## در این گام ممنوع است

- ساخت هر ماژول کسب‌وکار، Prisma schema، مدل داده یا endpoint غیر از health
- ساخت کامپوننت واقعی `packages/ui`
- افزودن کتابخانه‌ی خارج از فهرست مستند بدون ADR
- شروع S1.2

## پایان گام

با **قالب گزارش بند ۱۱ `rules.md`** گزارش بده، لینک PR را بگذار و منتظر تایید مالک برای شروع S1.2 بمان.
