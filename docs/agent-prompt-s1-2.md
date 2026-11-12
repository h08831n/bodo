# دستورالعمل گام S1.2 — اسکیمای Prisma، مایگریشن `0001_init` و Seed

> مسیر در پروژه: `docs/agent-prompt-s1-2.md`
> شاخه: `step/s1-2-prisma-schema`
> مرجع اصلی: `docs/stage-1-technical-spec.md` بخش‌های ۳، ۴، ۴.۱ و ۲.۶ + `docs/rules.md` بند ۳ و ۴ و ۹.
> این دستورالعمل چند **اصلاح نسبت به مستند فنی** دارد (بخش «اصلاحات مستند»). در تناقض، همین فایل برنده است و باید در یک کامیت docs جدا به مستند فنی هم اعمال شود.

---

## هدف

ساخت اسکیمای Prisma یک دیتابیس شرکت، مایگریشن SQL دستی‌ریویوشده (`0001_init`) شامل پارتیشن‌بندی و سطح دسترسی نقش‌ها، Seed پایه، و **تست‌های یکپارچه‌ی واقعی روی PostgreSQL**. هنوز هیچ endpoint، ماژول یا منطق کسب‌وکار ساخته نمی‌شود، و `TenantClientManager` در S1.3 است.

---

## اصلاحات مستند (اعمال کن)

1. **همه‌ی فیلدهای زمانی باید `@db.Timestamptz(3)` باشند** (مستند فنی فراموش کرده بود). پیش‌فرض Prisma یعنی `timestamp` بدون منطقه‌ی زمانی که با قانون «همه‌چیز UTC» جور نیست. این شامل `createdAt`، `updatedAt`، `deletedAt`، `occurredAt`، `lockedUntil`، `expiresAt` و بقیه می‌شود. ستون‌های پارتیشن هم همین نوع.
2. **Seed شماره‌گذاری‌ها (`sequences`) حذف شد.** هر ماژول در گام خودش ردیف‌های شماره‌گذاری‌اش را می‌سازد (S1.9 مکانیزم `ensureSequence` را می‌دهد). بند ۲.۴ مرحله‌ی ۴ مستند اصلاح شود.
3. **ساخت کاربر مدیر در S1.2 نیست.** ساخت مدیر اولیه با هش argon2id در Provisioning (S1.4) انجام می‌شود. Seed این گام فقط داده‌ی پایه‌ی بدون راز است.
4. **قید `CHECK (username = lower(username))`** روی `users` (نام کاربری همیشه lowercase و نرمال ذخیره می‌شود؛ نرمال‌سازی در لایه‌ی اپلیکیشن).
5. **`audit_logs` فقط‌افزودنی (append-only) برای `erp_app`:** فقط `INSERT` و `SELECT`، بدون `UPDATE` و `DELETE`.
6. **تابع SQL مدیریت پارتیشن** (بند «پارتیشن‌ها» پایین) تا Job ماهانه‌ی S1.9 بدون نیاز به دسترسی DDL برای `erp_app` کار کند.

---

## خروجی‌های لازم

### ۱. راه‌اندازی Prisma

- آخرین نسخه‌ی پایدار Prisma که با Node 24 سازگار است. **اگر نسخه‌ی انتخابی تغییرات پیکربندی دارد** (مثل `prisma.config.ts` یا driver adapter)، آن‌ها را اعمال کن ولی این قرارداد حفظ شود: هر `PrismaClient` فقط به یک دیتابیس وصل است و pool جدا دارد، و URL اتصال در زمان ساخت کلاینت تعیین می‌شود (نیاز S1.3).
- ADR-0003: نسخه‌ی انتخابی، دلیل، و اثر آن بر `TenantClientManager`.
- `apps/api/prisma/schema.prisma` دقیقاً طبق بند ۴ مستند فنی **با اصلاحات بالا** (از جمله `OutboxEvent`).
- کلاینت تولیدشده commit نمی‌شود؛ `prisma generate` به‌صورت خودکار در build و postinstall (در صورت امکان cross-platform) اجرا شود. `pnpm dev` و Docker build و CI باید بدون قدم دستی کار کنند.
- شناسه‌ها: تابع `newId()` (UUIDv7) در `packages/utils` با تست. هیچ `@default(uuid())` یا `dbgenerated` برای شناسه‌ی جدول‌ها نباشد.

### ۲. نقش‌های دیتابیس (اصلاح `infra/postgres/init.sql`)

- `erp_provisioner` باید بتواند دیتابیس بسازد که **owner آن `erp_migrator`** است. پس: `GRANT erp_migrator TO erp_provisioner`، و در S1.4 از `CREATE DATABASE ... OWNER erp_migrator` استفاده می‌شود. (در PostgreSQL ۱۵ به بعد فقط owner دیتابیس روی schema `public` اجازه‌ی CREATE دارد، پس ownership باید درست باشد.) صحت `CREATE`، `ALTER DATABASE ... RENAME` و `DROP DATABASE` با این نقش را با تست ثابت کن.
- اسکریپت idempotent قابل‌اجرا روی کلاستر موجود: `pnpm db:init-roles` (Node، با اتصال superuser از env). چون `init.sql` فقط روی volume خالی اجرا می‌شود و volume فعلی روی ماشین من نقش‌ها را دارد، باید بدون پاک‌کردن volume به‌روز شود.
- رمز نقش‌ها از env؛ هیچ رمز ثابتی در فایل‌ها نباشد.

### ۳. مایگریشن `0001_init` (SQL دستی)

در `apps/api/prisma/migrations/0001_init/migration.sql`. اجرای آن با نقش `erp_migrator` روی دیتابیسی که owner آن همین نقش است.

محتوا:

1. `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;` (هر دو در PG16 trusted هستند و owner می‌تواند بسازد؛ صحتش را تست کن.)
2. enumها، جدول‌های معمولی، کلیدها، ایندکس‌ها و قیدها دقیقاً هم‌ارز `schema.prisma`.
3. **`audit_logs` و `timeline_events` پارتیشن‌دار** (`PARTITION BY RANGE (occurred_at)`)، با کلید اصلی ترکیبی `(id, occurred_at)`، ایندکس‌ها طبق مستند، و ایندکس یکتای `timeline_events (source_event_id, subject_type, subject_id, occurred_at)`.
4. پارتیشن ماه جاری و ۳ ماه بعد و یک پارتیشن `DEFAULT` برای هر دو جدول.
5. **تابع `ensure_monthly_partitions(table_name text, months_ahead int)`** با `SECURITY DEFINER` (owner: `erp_migrator`، `SET search_path` ثابت و امن) که فقط برای دو جدول مجاز (whitelist) پارتیشن ماه‌های آینده را idempotent می‌سازد و `EXECUTE` آن فقط به `erp_app` داده می‌شود. اگر پارتیشن قبلاً وجود دارد، خطا نمی‌دهد.
6. `CHECK (id = 1)` روی `company_profile`، `CHECK (decimals >= 0)` روی `currencies`، `CHECK (failed_login_count >= 0)` و `CHECK (username = lower(username))` روی `users`.
7. سطح دسترسی:
   - `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO erp_app;`
   - `GRANT SELECT, INSERT, UPDATE, DELETE` روی جدول‌های موجود به `erp_app`، و `USAGE` روی sequenceها
   - `ALTER DEFAULT PRIVILEGES` تا جدول‌های مایگریشن‌های بعدی هم خودکار همین دسترسی را بدهند
   - برای `audit_logs`: `REVOKE UPDATE, DELETE` از `erp_app`
   - `erp_app` نباید بتواند `CREATE/ALTER/DROP/TRUNCATE` انجام دهد
8. کامنت فارسی یا انگلیسی کوتاه بالای هر بلوک مهم.

قواعد مایگریشن: فقط رو به جلو (بدون down)، بدون ویرایش بعد از اعمال، و نام و جدول «`_prisma_migrations`» توسط خود Prisma مدیریت می‌شود (اعمال با `prisma migrate deploy`).

### ۴. هماهنگی `schema.prisma` با مایگریشن‌ها (Drift)

یک اسکریپت `pnpm db:check-drift` که بررسی کند `schema.prisma` با نتیجه‌ی اجرای مایگریشن‌ها یکی است (مثلاً با `prisma migrate diff` روی یک دیتابیس موقت). چون Prisma پارتیشن را نمی‌شناسد، ممکن است جدول‌های پارتیشن فرزند یا ایندکس‌های پارتیشن در diff نویز بسازند. اگر این اتفاق افتاد، نویز را با یک فیلتر مستند و محدود حذف کن (نه غیرفعال‌کردن کل بررسی) و در ADR-0003 توضیح بده. این بررسی در CI اجرا شود.

### ۵. Seed پایه (`apps/api/prisma/seed` یا ماژول مشترک)

تابع **idempotent** `seedBaseline(client)` که دوبار اجرا شدنش اثری ندارد:

- ارزها: `IRR` ریال (decimals 0)، `IRT` تومان (0)، `USD` دلار آمریکا با نماد `$` (2)، `EUR` یورو با نماد `€` (2)؛ همه فعال با `sort_order` مناسب
- `company_profile` با `id = 1`، نام خالی، ارز پیش‌فرض `IRR`
- گروه سیستمی «مدیر سیستم» با `is_system = true`
- دلایل باخت نمونه (فارسی، `applies_to = BOTH`): «قیمت بالا»، «رقیب قیمت کمتری داد»، «نیاز مشتری منتفی شد»، «زمان تحویل مناسب نبود»، «شرایط پرداخت مناسب نبود»، «عدم پاسخگویی مشتری»، «سایر»
- `system_settings`: کلید `neutralized` با مقدار `false`

این تابع بعداً در Provisioning (S1.4) استفاده می‌شود، پس مستقل از CLI و قابل‌import باشد.

### ۶. اسکریپت‌های توسعه (cross-platform، Node)

روی Postgres توسعه‌ی پورت ۵۴۳۳؛ برای اتصال از env (متغیرهای جدید را به `.env.example` اضافه کن):

- `pnpm db:init-roles` ← نقش‌ها
- `pnpm db:create-dev` ← ساخت دیتابیس `erp_dev` با owner `erp_migrator` (idempotent)
- `pnpm db:migrate` ← `prisma migrate deploy` روی دیتابیس انتخابی (با `DATABASE_URL` یا آرگومان)
- `pnpm db:seed` ← `seedBaseline` روی دیتابیس انتخابی
- `pnpm db:reset-dev` ← حذف و ساخت دوباره‌ی **فقط** `erp_dev`، با تایید تایپی، و رد شدن اگر host غیر از `localhost/127.0.0.1` باشد یا `NODE_ENV=production`
- هرگز این اسکریپت‌ها به دیتابیس غیر `erp_`-prefixed دست نزنند.

### ۷. تست‌ها (الزامی)

**Integration با Testcontainers (PostgreSQL 16 واقعی؛ ساخت نقش‌ها با همان اسکریپت `init`)**:

1. مایگریشن‌ها روی دیتابیس خالی از صفر اجرا می‌شوند؛ اجرای دوم هیچ تغییری نمی‌دهد.
2. **دسترسی `erp_app`:** DML روی جدول‌های عادی موفق؛ `CREATE TABLE`، `ALTER TABLE`، `DROP TABLE` و `TRUNCATE` رد می‌شوند؛ `UPDATE` و `DELETE` روی `audit_logs` رد می‌شوند؛ `INSERT` و `SELECT` روی آن موفق.
3. **پارتیشن:** ردیف با تاریخ امروز در پارتیشن ماه جاری قرار می‌گیرد؛ تاریخ دور در آینده در `DEFAULT`؛ `ensure_monthly_partitions` پارتیشن‌های جدید می‌سازد، دوبار اجرا خطا نمی‌دهد، و روی نام جدول غیرمجاز خطا می‌دهد؛ `erp_app` می‌تواند آن را اجرا کند اما نمی‌تواند مستقیم DDL بزند.
4. **قیدها:** `company_profile` با `id = 2` رد می‌شود؛ `users.username` با حروف بزرگ رد می‌شود؛ تکرار `timeline_events` با همان `(source_event_id, subject, occurred_at)` رد می‌شود.
5. **Seed:** دوبار اجرا ← تعداد ردیف‌ها یکسان؛ محتوای مورد انتظار (۴ ارز، یک `company_profile`، یک گروه سیستمی، دلایل باخت).
6. **اثبات کلید قرارداد S1.3:** در یک تست، دو دیتابیس جدا در همان Postgres بساز و دو `PrismaClient` جدا (با URL و pool جدا) در همان پردازه بالا بیاور؛ در هر کدام یک ردیف متفاوت بنویس و ثابت کن داده‌ها قاطی نمی‌شوند و بستن یکی (`$disconnect`) دیگری را خراب نمی‌کند.
7. **نقش provisioner:** `CREATE DATABASE x OWNER erp_migrator`، `ALTER DATABASE x RENAME TO y` و `DROP DATABASE y` با `erp_provisioner` موفق شوند.
8. `newId()`: UUIDv7 معتبر، مرتب‌شده بر اساس زمان (unit test).

**CI:** مرحله‌ی جدید برای اجرای تست‌های integration و `db:check-drift` (روی ubuntu runner با Docker). زمان کل CI معقول بماند.

---

## معیار پذیرش S1.2

- [ ] `schema.prisma` مطابق مستند + اصلاحات؛ همه‌ی `DateTime`ها `Timestamptz(3)`
- [ ] مایگریشن `0001_init` از صفر روی دیتابیس خالی با نقش `erp_migrator` اجرا می‌شود
- [ ] پارتیشن‌ها، تابع `ensure_monthly_partitions` و دسترسی‌های `erp_app` با تست ثابت شده‌اند
- [ ] `audit_logs` برای `erp_app` فقط‌افزودنی است
- [ ] `db:check-drift` در CI سبز و نویز پارتیشن (در صورت وجود) مستند است
- [ ] Seed idempotent و تست شده
- [ ] اثبات دو کلاینت Prisma هم‌زمان روی دو دیتابیس (تست ۶)
- [ ] `pnpm db:init-roles`، `db:create-dev`، `db:migrate`، `db:seed` روی ماشین ویندوز من واقعاً اجرا شده‌اند و خروجی واقعی در گزارش آمده است
- [ ] `pnpm dev`، `start.bat`، `dev-start.bat` و `dev-stop.bat` هنوز سالم کار می‌کنند (سرویس جدیدی اضافه نشده؛ این را تایید کن)
- [ ] ADR-0003 ثبت شده؛ مستند فنی با اصلاحات به‌روز شده (کامیت docs جدا)
- [ ] CI سبز؛ هیچ راز یا فایل تولیدشده‌ای commit نشده

## در این گام ممنوع است

هر endpoint یا ماژول Nest، `TenantClientManager` یا `TenantContext` (S1.3)، Provisioning و Database Manager (S1.4)، ساخت کاربر مدیر یا هش رمز، `packages/ui`، و شروع S1.3.

## پایان گام

گزارش با قالب بند ۱۱ `rules.md`، شامل خروجی واقعی اجرای اسکریپت‌ها، نتیجه‌ی تست‌ها (نام تست‌های تست‌های دسترسی و پارتیشن)، لینک PR و اجرای CI. گزارش باید **صراحتاً** بگوید چه چیزی اجرا نشده. بعد از گزارش، منتظر تایید من بمان.
