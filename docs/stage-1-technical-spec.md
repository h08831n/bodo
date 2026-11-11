# مستند فنی مرحله‌ی ۱ — هسته‌ی سیستم (نسخه‌ی ۲)

> وضعیت: پیش‌نویس برای تایید
> مسیر در پروژه: `docs/stage-1-technical-spec.md`
> این مستند مرجع ایجنت برای ساخت مرحله‌ی ۱ است. هر چیزی که اینجا نیست بدون تایید ساخته نمی‌شود.
> تغییرات نسبت به نسخه‌ی ۱: معماری «یک دیتابیس برای هر شرکت»، حذف `company_id` و RLS، افزودن Database Manager، `CompanyProfile`، و PWA.

---

## ۰. تصمیم‌های قفل‌شده

| موضوع        | تصمیم                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| بک‌اند       | NestJS + TypeScript (strict)                                                                                                                |
| فرانت‌اند    | React + Vite + TypeScript، Tailwind + Radix، TanStack Query/Table، React Hook Form؛ **PWA-ready**                                           |
| دیتابیس      | PostgreSQL ۱۶+                                                                                                                              |
| ORM          | Prisma؛ کوئری‌های سنگین با `$queryRaw`/TypedSQL                                                                                             |
| مایگریشن     | SQL دستی‌ریویوشده                                                                                                                           |
| شناسه‌ها     | UUIDv7 (تولید در اپلیکیشن)                                                                                                                  |
| زبان         | فقط فارسی، RTL، تقویم شمسی در لایه‌ی نمایش                                                                                                  |
| تاریخ        | در دیتابیس و API همیشه UTC/ISO-8601                                                                                                         |
| **چندشرکتی** | **هر شرکت = یک دیتابیس کاملاً مستقل** (کاربران، رمزها، تنظیمات، فایل‌ها، همه جدا). هیچ دیتابیس مرکزی با داده‌ی کسب‌وکار یا کاربر وجود ندارد |
| ارز          | هر سند ارز خودش را دارد؛ **هیچ تبدیل و معادل‌سازی ارزی وجود ندارد**                                                                         |
| احراز هویت   | نام کاربری + رمز عبور، استراتژی‌محور (OTP بعداً)                                                                                            |
| اطلاعات شرکت | **هنگام ساخت دیتابیس وارد نمی‌شود**؛ در تنظیمات (بخش «شرکت») ویرایش می‌شود                                                                  |
| پورتال مشتری | فقط نوع کاربر و گارد؛ صفحات در مرحله‌ی ۶                                                                                                    |
| پیامک        | `SmsProvider` انتزاعی؛ اولین adapter: ملی‌پیامک (مرحله‌ی ۲)                                                                                 |
| استقرار      | سرور شخصی، Docker Compose                                                                                                                   |

---

## ۱. ساختار مونوریپو

```
erp/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/            # guards، interceptors، filters، decorators، pagination
│   │   │   ├── infra/
│   │   │   │   ├── tenancy/       # TenantContext، TenantClientManager، TenantRunner، MigrationRunner
│   │   │   │   ├── config-store/  # فایل‌های پیکربندی سرور (master.json، domains.json)
│   │   │   │   ├── redis/ queue/ storage/ event-bus/
│   │   │   └── modules/
│   │   │       ├── database-manager/   # ساخت/کپی/بکاپ/بازیابی/حذف دیتابیس
│   │   │       ├── auth/
│   │   │       ├── users/
│   │   │       ├── groups/             # گروه، تیم، مجوز
│   │   │       ├── record-rules/
│   │   │       ├── company-profile/    # نام و تنظیمات شرکت
│   │   │       ├── currencies/
│   │   │       ├── audit/
│   │   │       ├── timeline/
│   │   │       ├── sequences/
│   │   │       └── settings/           # Settings Engine + lost-reasons
│   │   ├── prisma/
│   │   │   ├── schema.prisma           # فقط اسکیمای دیتابیس شرکت
│   │   │   └── migrations/             # SQL دستی
│   │   └── test/
│   └── web/
│       ├── public/                     # manifest.webmanifest، آیکون‌ها
│       └── src/
│           ├── app/                    # router، providers، service worker
│           ├── features/               # هر ماژول: pages، hooks، api، manifest
│           └── lib/
├── packages/
│   ├── contracts/                      # zod schemas + تایپ‌ها (منبع حقیقت API)
│   ├── ui/                             # کتابخانه‌ی کامپوننت + storybook
│   └── utils/                          # jalali، validators ایرانی، money، persian-normalize
├── docs/
│   ├── rules.md
│   ├── roadmap.md
│   ├── stage-1-technical-spec.md
│   └── decisions/                      # ADR-0001-....md
├── infra/
│   ├── docker-compose.yml
│   ├── postgres/
│   ├── nginx/
│   └── backup/
└── package.json                        # pnpm workspaces + turborepo
```

ابزارها: pnpm، Turborepo، ESLint + Prettier، Husky + lint-staged، Vitest (فرانت و packages)، Jest (api)، Storybook، Playwright (e2e حداقلی).

---

## ۲. معماری چند دیتابیسی (مثل Odoo)

### ۲.۱ اجزا

هیچ دیتابیس مرکزی نداریم. فقط این‌ها بیرون از دیتابیس‌های شرکت‌ها وجود دارند:

| مورد                                 | محل                                      | توضیح                                                                                                            |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **رمز مدیر اصلی (Master Password)**  | `/data/config/master.json` (هش argon2id) | فقط برای Database Manager. در اولین اجرا از `MASTER_PASSWORD_INITIAL` در env ساخته می‌شود و از UI قابل تغییر است |
| **نگاشت دامنه به دیتابیس** (اختیاری) | `/data/config/domains.json`              | مثلاً `acme.erp.local → erp_acme`                                                                                |
| **فهرست دیتابیس‌ها**                 | خود PostgreSQL                           | همه‌ی دیتابیس‌های با پیشوند `erp_` که جدول `company_profile` دارند                                               |
| **فایل‌ها (پیوست‌ها)**               | `/data/filestore/<db>/`                  | هر دیتابیس پوشه‌ی جدا                                                                                            |
| **بکاپ‌ها**                          | `/data/backups/<db>/`                    |                                                                                                                  |

### ۲.۲ TenantContext

- JWT شامل claim `db` است. در هر درخواست، middleware نام دیتابیس را از توکن (یا هنگام login از بدنه/دامنه) می‌خواند و در `AsyncLocalStorage` می‌گذارد.
- `TenantClientManager` یک `PrismaClient` به‌ازای هر دیتابیس نگه می‌دارد (کش LRU با حداکثر ۲۰ کلاینت، pool هر کدام ۵ اتصال، بستن کلاینت بیکار بعد از ۱۰ دقیقه). `getClient()` همیشه کلاینت دیتابیس جاری را برمی‌گرداند.
- هیچ کدی اجازه ندارد مستقیم `new PrismaClient()` بسازد.
- **ایزولاسیون:** هر کلاینت pool مستقل دارد؛ اتصال هیچ‌وقت بین دیتابیس‌ها مشترک نیست. اگر توکن `db` متفاوت از دیتابیسی که کاربر در آن وجود دارد بیاید، درخواست رد می‌شود.
- **MAINTENANCE:** یک پرچم در Redis (`maint:<db>`) که تمام درخواست‌های آن دیتابیس را با `503 DATABASE_MAINTENANCE` رد می‌کند (هنگام کپی/بازیابی/حذف/مایگریشن).
- **TenantRunner:** `forEachActiveDatabase(fn)` برای Worker و زمان‌بندها؛ هر دیتابیس در try/catch جدا، خطای یکی بقیه را متوقف نمی‌کند.
- کلیدهای Redis و نام صف‌ها همه با پیشوند نام دیتابیس.

### ۲.۳ نام دیتابیس

- الگو: `erp_` + slug، حروف کوچک انگلیسی، عدد و `_`، ۳ تا ۴۰ کاراکتر، نام‌های رزروشده ممنوع (`postgres`، `template0`، `template1`، ...).
- کاربر فقط slug را می‌بیند و تایپ می‌کند (پیشوند خودکار اضافه می‌شود).
- نام نمایشی شرکت از `company_profile.name` خوانده می‌شود (کش ۳۰ ثانیه‌ای). تا وقتی خالی است، slug نمایش داده می‌شود.

### ۲.۴ ساخت دیتابیس جدید (Provisioning)

ورودی: slug، نام کاربری مدیر، نام کامل مدیر، رمز مدیر. **هیچ اطلاعات شرکت لازم نیست.**

مراحل (job با گزارش پیشرفت):

1. اعتبارسنجی نام و یکتایی
2. `CREATE DATABASE erp_tmp_<id>` (با نقش `erp_provisioner`)
3. اجرای همه‌ی مایگریشن‌ها (`prisma migrate deploy` با `DATABASE_URL` همان دیتابیس)
4. seed: ارزها (IRR، IRT، USD، EUR)، `company_profile` خالی با ارز پیش‌فرض IRR، گروه «مدیر سیستم» (همه‌ی مجوزها، دسترسی ALL)، کاربر مدیر، شماره‌گذاری‌های پایه، چند دلیل باخت نمونه
5. ساخت پوشه‌ی filestore
6. `ALTER DATABASE erp_tmp_<id> RENAME TO erp_<slug>`
7. پاک‌کردن کش و اعلام آماده

اگر هر مرحله خطا بدهد، دیتابیس موقت و پوشه‌اش پاک می‌شود و هیچ دیتابیس ناقصی در فهرست دیده نمی‌شود. کل فرایند idempotent و قابل‌تکرار است.

### ۲.۵ کپی، بکاپ، بازیابی، حذف

| عملیات              | جزئیات                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **کپی**             | `pg_dump -Fc` از مبدأ + `pg_restore` روی دیتابیس جدید + کپی filestore. (`CREATE DATABASE ... TEMPLATE` استفاده نمی‌شود چون اتصال‌های مبدأ را قطع می‌خواهد.) گزینه‌ی `neutralize` (بند پایین)                                                              |
| **بکاپ**            | فایل `zip` شامل `dump.pgdump` (فرمت custom)، پوشه‌ی `filestore/` و `manifest.json` (`db_name`، `schema_version` = نام آخرین مایگریشن، `app_version`، `created_at`، `checksum`)                                                                            |
| **بازیابی**         | از فایل zip با نام جدید. اگر مایگریشن‌های بکاپ قدیمی‌تر از برنامه بود، مایگریشن‌های باقی‌مانده خودکار اجرا می‌شود؛ اگر جدیدتر بود (برنامه آن را نمی‌شناسد) با خطای واضح رد می‌شود. اگر دیتابیس هم‌نام وجود دارد رد می‌شود (بازنویسی فقط با حذف صریح قبلی) |
| **حذف**             | تایید با تایپ‌کردن نام کامل دیتابیس؛ قبلش یک بکاپ خودکار گرفته می‌شود؛ بعد MAINTENANCE، بستن کلاینت و اتصال‌ها (`pg_terminate_backend`)، `DROP DATABASE`، حذف filestore                                                                                   |
| **ارتقا (Upgrade)** | اجرای مایگریشن‌های جدید روی یک دیتابیس (یا همه)                                                                                                                                                                                                           |
| **Neutralize**      | هنگام کپی یا بازیابی اختیاری: ارسال پیامک/ایمیل/پوش و زمان‌بند یادآورها در آن دیتابیس خاموش می‌شود (`system_settings.neutralized = true`) تا از روی نسخه‌ی آزمایشی پیام واقعی به مشتری‌ها نرود                                                            |

**بکاپ خودکار:** Job شبانه برای همه‌ی دیتابیس‌ها، هرکدام فایل جدا؛ نگهداری قابل‌تنظیم از env (پیش‌فرض: ۷ روزانه، ۴ هفتگی، ۶ ماهانه)؛ هشدار در لاگ اگر بکاپی انجام نشد.

### ۲.۶ نقش‌های دیتابیس

| نقش               | دسترسی                                                        |
| ----------------- | ------------------------------------------------------------- |
| `erp_provisioner` | `CREATEDB` (ساخت، حذف و تغییر نام دیتابیس‌ها)                 |
| `erp_migrator`    | owner جدول‌ها؛ فقط برای مایگریشن                              |
| `erp_app`         | فقط DML (select/insert/update/delete) و استفاده از sequenceها |

### ۲.۷ ورود و تشخیص دیتابیس

- صفحه‌ی ورود: فیلد **دیتابیس** + نام کاربری + رمز. آخرین دیتابیس به‌خاطر سپرده می‌شود.
- اگر دامنه نگاشت شده باشد (`acme.erp.local`)، دیتابیس از دامنه تشخیص داده می‌شود و فیلد مخفی می‌شود.
- `GET /v1/public/databases` فقط وقتی `DB_LIST_PUBLIC=true` فهرست slugها را بدهد؛ پیش‌فرض خاموش است (کاربر slug را تایپ می‌کند).
- API و اپ: فیلد `database` در `POST /auth/login` یا هدر `X-Database`.
- **تعویض شرکت = خروج و ورود به دیتابیس دیگر.** کاربر در چند دیتابیس چند حساب کاملاً جدا دارد.

---

## ۳. اصول مشترک مدل داده

### ۳.۱ ستون‌های استاندارد

هر جدول کسب‌وکار: `id` (UUIDv7)، `created_at`، `created_by_id`، `updated_at`، `updated_by_id`؛ در صورت نیاز `deleted_at` (soft delete)؛ در اسناد `version` (قفل خوش‌بینانه). **`company_id` وجود ندارد.**

### ۳.۲ نام‌گذاری

جدول‌ها `snake_case` جمع با `@@map`؛ ستون‌ها `snake_case` با `@map`؛ فیلدهای Prisma `camelCase`؛ کد مجوز `resource.action`.

### ۳.۳ پارتیشن‌بندی

`audit_logs` و `timeline_events` پارتیشن ماهانه بر اساس `occurred_at`. Prisma پارتیشن را نمی‌شناسد: جدول مادر و پارتیشن‌ها در مایگریشن SQL دستی ساخته می‌شوند و مدل Prisma به جدول مادر نگاشت می‌شود. Job ماهانه پارتیشن ۳ ماه آینده را در هر دیتابیس می‌سازد. چون ایندکس یکتا روی جدول پارتیشن‌دار باید کلید پارتیشن را شامل شود، `occurred_at` در `timeline_events` از **خود رویداد دامنه‌ای** گرفته می‌شود (نه `now()`) تا یکتایی idempotency واقعی باشد.

### ۳.۴ Pagination

Cursor-based در همه‌ی لیست‌ها: `?limit=50&cursor=<opaque>&sort=-createdAt`. پاسخ: `{ items, nextCursor, total? }`؛ `total` فقط با `?withTotal=true`.

---

## ۴. اسکیمای Prisma (یک دیتابیس شرکت)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")   // توسط TenantClientManager برای هر دیتابیس override می‌شود
}

// ───────────── Enums ─────────────

enum UserType {
  INTERNAL
  PORTAL
}

enum UserStatus {
  ACTIVE
  DISABLED
  LOCKED
}

enum RuleScope {
  OWN
  TEAM
  ALL
  CUSTOM
}

enum EventSource {
  UI
  API
  IMPORT
  SYSTEM
}

enum LostAppliesTo {
  LEAD
  QUOTATION
  BOTH
}

// ───────────── شرکت (رکورد یکتا) ─────────────

// دقیقاً یک ردیف (id = 1، با CHECK). هنگام ساخت دیتابیس خالی است و از تنظیمات پر می‌شود.
model CompanyProfile {
  id                  Int      @id @default(1)
  name                String   @default("")
  legalName           String?  @map("legal_name")
  nationalId          String?  @map("national_id")
  registrationNo      String?  @map("registration_no")
  economicCode        String?  @map("economic_code")
  phone               String?
  email               String?
  website             String?
  address             String?
  postalCode          String?  @map("postal_code")
  logoFileId          String?  @map("logo_file_id") @db.Uuid
  defaultCurrencyCode String   @default("IRR") @map("default_currency_code")
  updatedAt           DateTime @updatedAt @map("updated_at")
  updatedById         String?  @map("updated_by_id") @db.Uuid

  defaultCurrency Currency @relation(fields: [defaultCurrencyCode], references: [code])

  @@map("company_profile")
}

// ارزها: هیچ نرخ تبدیلی نگهداری نمی‌شود
model Currency {
  code      String  @id                    // IRR, IRT, USD, EUR
  name      String
  symbol    String
  decimals  Int     @default(0)
  isActive  Boolean @default(true) @map("is_active")
  sortOrder Int     @default(0) @map("sort_order")

  profiles CompanyProfile[]

  @@map("currencies")
}

// تنظیمات کلید-مقدار سطح دیتابیس (مثلاً neutralized)
model SystemSetting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("system_settings")
}

// ───────────── کاربر و نشست (مخصوص همین دیتابیس) ─────────────

model User {
  id                 String     @id @db.Uuid
  type               UserType   @default(INTERNAL)
  username           String     @unique
  passwordHash       String     @map("password_hash")        // argon2id
  fullName           String     @map("full_name")
  mobile             String?    @unique                       // نرمال‌شده +98...
  email              String?    @unique
  avatarFileId       String?    @map("avatar_file_id") @db.Uuid
  status             UserStatus @default(ACTIVE)
  mustChangePassword Boolean    @default(false) @map("must_change_password")
  failedLoginCount   Int        @default(0) @map("failed_login_count")
  lockedUntil        DateTime?  @map("locked_until")
  lastLoginAt        DateTime?  @map("last_login_at")
  passwordChangedAt  DateTime?  @map("password_changed_at")
  // کاربر پورتال به مخاطب وصل می‌شود؛ FK در مرحله‌ی مخاطبین اضافه می‌شود
  portalContactId    String?    @map("portal_contact_id") @db.Uuid
  createdAt          DateTime   @default(now()) @map("created_at")
  updatedAt          DateTime   @updatedAt @map("updated_at")
  deletedAt          DateTime?  @map("deleted_at")

  groupMembers GroupMember[]
  teamMembers  TeamMember[]
  sessions     Session[]

  @@index([type, status])
  @@map("users")
}

model Session {
  id               String    @id @db.Uuid
  userId           String    @map("user_id") @db.Uuid
  refreshTokenHash String    @unique @map("refresh_token_hash")
  familyId         String    @map("family_id") @db.Uuid
  userAgent        String?   @map("user_agent")
  ip               String?
  createdAt        DateTime  @default(now()) @map("created_at")
  lastUsedAt       DateTime  @default(now()) @map("last_used_at")
  expiresAt        DateTime  @map("expires_at")
  revokedAt        DateTime? @map("revoked_at")

  user User @relation(fields: [userId], references: [id])

  @@index([userId, revokedAt])
  @@index([familyId])
  @@map("sessions")
}

// ───────────── گروه، تیم، مجوز ─────────────

model Group {
  id          String   @id @db.Uuid
  name        String   @unique
  description String?
  isSystem    Boolean  @default(false) @map("is_system")
  createdAt   DateTime @default(now()) @map("created_at")
  createdById String?  @map("created_by_id") @db.Uuid
  updatedAt   DateTime @updatedAt @map("updated_at")
  updatedById String?  @map("updated_by_id") @db.Uuid

  members     GroupMember[]
  permissions GroupPermission[]
  recordRules RecordRule[]

  @@map("groups")
}

model GroupMember {
  groupId String @map("group_id") @db.Uuid
  userId  String @map("user_id") @db.Uuid

  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id])

  @@id([groupId, userId])
  @@map("group_members")
}

// کاتالوگ مجوزها فقط در کد است؛ اینجا کد رشته‌ای ذخیره می‌شود (بدون جدول Permission)
model GroupPermission {
  groupId        String @map("group_id") @db.Uuid
  permissionCode String @map("permission_code")

  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@id([groupId, permissionCode])
  @@map("group_permissions")
}

model Team {
  id        String   @id @db.Uuid
  name      String   @unique
  leaderId  String?  @map("leader_id") @db.Uuid
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  members TeamMember[]

  @@map("teams")
}

model TeamMember {
  teamId String @map("team_id") @db.Uuid
  userId String @map("user_id") @db.Uuid

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id])

  @@id([teamId, userId])
  @@map("team_members")
}

// اگر کاربر در چند گروه باشد، گسترده‌ترین scope برای هر (resource, action) اعمال می‌شود
model RecordRule {
  id           String    @id @db.Uuid
  groupId      String    @map("group_id") @db.Uuid
  resource     String
  canRead      Boolean   @default(true)  @map("can_read")
  canWrite     Boolean   @default(true)  @map("can_write")
  canCreate    Boolean   @default(true)  @map("can_create")
  canDelete    Boolean   @default(false) @map("can_delete")
  scope        RuleScope @default(OWN)
  ownerField   String    @default("ownerId") @map("owner_field")
  customFilter Json?     @map("custom_filter")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([groupId, resource])
  @@map("record_rules")
}

// ───────────── ممیزی و تاریخچه (پارتیشن ماهانه، مایگریشن دستی) ─────────────

model AuditLog {
  id         String      @db.Uuid
  occurredAt DateTime    @default(now()) @map("occurred_at")
  actorId    String?     @map("actor_id") @db.Uuid
  source     EventSource @default(UI)
  action     String
  entityType String      @map("entity_type")
  entityId   String?     @map("entity_id") @db.Uuid
  changes    Json?
  meta       Json?
  requestId  String?     @map("request_id")

  @@id([id, occurredAt])
  @@index([entityType, entityId, occurredAt(sort: Desc)])
  @@index([actorId, occurredAt(sort: Desc)])
  @@map("audit_logs")
}

model TimelineEvent {
  id            String      @db.Uuid
  occurredAt    DateTime    @map("occurred_at")           // از رویداد دامنه‌ای، نه now()
  subjectType   String      @map("subject_type")
  subjectId     String      @map("subject_id") @db.Uuid
  eventType     String      @map("event_type")
  actorId       String?     @map("actor_id") @db.Uuid
  source        EventSource @default(SYSTEM)
  refType       String?     @map("ref_type")
  refId         String?     @map("ref_id") @db.Uuid
  title         String
  summary       String?
  role          String?
  meta          Json?
  sourceEventId String?     @map("source_event_id") @db.Uuid

  @@id([id, occurredAt])
  @@index([subjectType, subjectId, occurredAt(sort: Desc)])
  @@index([refType, refId])
  @@unique([sourceEventId, subjectType, subjectId, occurredAt])
  @@map("timeline_events")
}

model OutboxEvent {
  id          String    @id @db.Uuid
  type        String
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at")
  processedAt DateTime? @map("processed_at")
  attempts    Int       @default(0)
  lastError   String?   @map("last_error")

  @@index([processedAt, createdAt])
  @@map("outbox_events")
}

// ───────────── شماره‌گذاری اسناد ─────────────

model Sequence {
  id           String   @id @db.Uuid
  code         String   @unique                        // quotation، sale_order، ...
  prefix       String   @default("")
  pattern      String   @default("{prefix}{yyyy}-{seq:5}")   // yyyy شمسی
  nextValue    BigInt   @default(1) @map("next_value")
  resetPolicy  String   @default("YEARLY") @map("reset_policy")   // NEVER | YEARLY
  lastResetKey String?  @map("last_reset_key")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@map("sequences")
}

// ───────────── نمونه‌ی Settings Engine: دلایل باخت ─────────────

model LostReason {
  id          String        @id @db.Uuid
  name        String        @unique
  appliesTo   LostAppliesTo @default(BOTH) @map("applies_to")
  sortOrder   Int           @default(0) @map("sort_order")
  isActive    Boolean       @default(true) @map("is_active")
  createdAt   DateTime      @default(now()) @map("created_at")
  createdById String?       @map("created_by_id") @db.Uuid
  updatedAt   DateTime      @updatedAt @map("updated_at")
  updatedById String?       @map("updated_by_id") @db.Uuid

  @@map("lost_reasons")
}
```

### ۴.۱ نکات مایگریشن دستی (SQL)

مایگریشن اول (`0001_init`) شامل موارد زیر است که Prisma تولید نمی‌کند:

1. `CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;`
2. پارتیشن‌دارکردن `audit_logs` و `timeline_events` (`PARTITION BY RANGE (occurred_at)`) + پارتیشن‌های ۳ ماه اول + پارتیشن `DEFAULT`
3. `CHECK (id = 1)` روی `company_profile`
4. `GRANT`های نقش `erp_app` (فقط DML) و تنظیم owner به `erp_migrator`
5. قیدهای `CHECK` (مثلاً `decimals >= 0`)

نقش‌های دیتابیس یک‌بار در `infra/postgres/init.sql` ساخته می‌شوند، نه در مایگریشن هر دیتابیس.

---

## ۵. ارز (بدون تبدیل)

اصل: **سیستم هیچ‌وقت ارزی را به ارز دیگر تبدیل نمی‌کند.**

- هر سند مالی یک `currency_code` دارد و همه‌ی مبالغش به همان ارز ذخیره می‌شوند (`Decimal(20,4)`؛ دقت مجاز را `Currency.decimals` در اعتبارسنجی اعمال می‌کند).
- ریال، تومان، دلار، یورو ارزهای مستقل‌اند و هیچ ضریبی بینشان نیست.
- ارز پیش‌فرض اسناد جدید: `company_profile.default_currency_code` (قابل تغییر در تنظیمات)؛ ارزهای فعال: `currencies.is_active`.
- مخاطب می‌تواند ارز پیش‌فرض خودش را داشته باشد (مرحله‌ی مخاطبین)؛ کاربر همیشه می‌تواند ارز سند را در لحظه‌ی ساخت تغییر دهد.
- **قفل ارز:** بعد از افزودن اولین سطر، ارز سند قابل تغییر نیست.
- تبدیل پیش‌فاکتور به سفارش همان ارز را به ارث می‌برد.
- گزارش‌ها همیشه به تفکیک ارز؛ هرگز جمع بین ارزها.
- `MoneyInput` و `formatMoney(amount, currencyCode)` تنها راه ورود و نمایش مبلغ هستند.

---

## ۶. احراز هویت و امنیت

### ۶.۱ جریان

| مورد          | تصمیم                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------- |
| رمز عبور      | argon2id، حداقل ۱۰ کاراکتر، بررسی لیست رمزهای رایج                                                  |
| Access token  | JWT، ۱۵ دقیقه؛ claimها: `sub`، `type`، `db`، `sessionId` (بدون مجوزها)                              |
| Refresh token | تصادفی ۶۴ بایت، فقط هش در دیتابیس شرکت، ۳۰ روز، **چرخشی** با تشخیص استفاده‌ی مجدد (ابطال کل family) |
| ارسال         | کوکی `HttpOnly + Secure + SameSite=Strict` برای وب؛ در بدنه برای اپ (هدر `X-Client: mobile`)        |
| قفل حساب      | ۵ تلاش ناموفق ← قفل ۱۵ دقیقه؛ ثبت در `audit_logs`                                                   |
| Rate limit    | روی login بر اساس `db + ip` و `db + username` (Redis)                                               |
| خروج          | از این دستگاه / از همه‌ی دستگاه‌ها                                                                  |
| مجوزها        | کش Redis با کلید `db:userId`، ابطال هنگام تغییر گروه/مجوز                                           |

### ۶.۲ استراتژی‌ها

`AuthStrategy` یک interface است: `PasswordStrategy` فعلی؛ `OtpStrategy` بعداً بدون تغییر بقیه‌ی سیستم.

### ۶.۳ گاردها

| گارد                | کار                                                            |
| ------------------- | -------------------------------------------------------------- |
| `TenantMiddleware`  | تشخیص دیتابیس (توکن/دامنه/هدر)، بررسی وجود و وضعیت MAINTENANCE |
| `JwtAuthGuard`      | اعتبار توکن، تطابق `db` توکن با دیتابیس درخواست، اعتبار نشست   |
| `UserTypeGuard`     | جداسازی `INTERNAL` و `PORTAL`                                  |
| `PermissionGuard`   | `@RequirePermission('contact.read')`                           |
| `RecordRuleService` | تبدیل قانون به `where` (خواندن) و بررسی (نوشتن)                |
| `MasterAdminGuard`  | فقط برای `/v1/admin/*`؛ توکن کوتاه‌عمر با `aud=admin`          |

مسیر پورتال: `/v1/portal/*` فقط `PORTAL`؛ مسیرهای داخلی فقط `INTERNAL`.

### ۶.۴ سایر

CORS فقط دامنه‌های مجاز، helmet، اعتبارسنجی ورودی با zod. لاگ هرگز رمز، توکن یا کد ملی کامل را ننویسد. Database Manager قابل‌خاموش‌کردن (`DB_MANAGER_ENABLED=false`) و محدود به IPهای مجاز (`DB_MANAGER_ALLOWED_IPS`) است. همه‌ی عملیات آن در لاگ فایل سرور ثبت می‌شود (چون دیتابیس مرکزی نداریم).

---

## ۷. Event Bus و Timeline

### ۷.۱ اصل

ماژول‌ها همدیگر را import نمی‌کنند؛ ارتباط فقط با رویداد دامنه‌ای است.

```ts
type DomainEvent<T = unknown> = {
  id: string; // UUIDv7، برای idempotency
  type: string; // 'quotation.created'
  actorId: string | null;
  source: 'UI' | 'API' | 'IMPORT' | 'SYSTEM';
  occurredAt: string; // ISO
  payload: T;
};
```

### ۷.۲ پیاده‌سازی

- **Outbox:** ماژول مبدأ رویداد را در همان تراکنش تغییر داده در `outbox_events` می‌نویسد؛ worker (از طریق `TenantRunner`) روی هر دیتابیس آن را منتشر می‌کند. polling هر ۲ ثانیه در حالت فعال و تا ۱۰ ثانیه در حالت بیکار.
- مشترکین idempotent‌اند (کلید: `event.id`).
- `TimelineModule` رویدادهای قابل‌نمایش را ثبت می‌کند. هر ماژول در زمان بوت یک تعریف ثبت می‌کند:

```ts
registerTimelineEvent({
  type: 'quotation.created',
  subjectResolver: (e) => [{ type: 'contact', id: e.payload.customerId, role: 'مشتری' }],
  title: (e) => `پیش‌فاکتور ${e.payload.number} ایجاد شد`,
  ref: (e) => ({ type: 'quotation', id: e.payload.quotationId }),
});
```

- اگر سندی چند مخاطب داشته باشد، برای هرکدام یک رکورد ثبت می‌شود.
- فرانت: هر `refType` یک resolver مسیر دارد که در `features/*` ثبت می‌شود؛ `TimelineItem` بدون دانستن ماژول‌ها لینک می‌سازد.
- `POST /v1/dev/test-event` (فقط توسعه) برای تست چرخه‌ی کامل Outbox ← Timeline.

---

## ۸. قرارداد API

### ۸.۱ قواعد عمومی

- پیشوند `/v1`؛ OpenAPI در `/docs` (فقط توسعه/داخلی)؛ شِماها از `packages/contracts` با zod.
- پاسخ موفق: خود داده؛ لیست‌ها `{ items, nextCursor, total? }`.
- قالب خطا:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "پیام فارسی قابل‌نمایش",
    "details": [{ "path": "mobile", "message": "شماره موبایل معتبر نیست" }],
    "requestId": "..."
  }
}
```

- کدهای خطا: `UNAUTHENTICATED`، `FORBIDDEN`، `NOT_FOUND`، `VALIDATION_FAILED`، `CONFLICT`، `VERSION_CONFLICT`، `RATE_LIMITED`، `DATABASE_MAINTENANCE`، `DATABASE_NOT_FOUND`، `INTERNAL`.
- هدر `X-Request-Id` در همه‌ی پاسخ‌ها؛ `Idempotency-Key` برای POSTهای حساس.
- فیلتر لیست‌ها: `?q=...&filter[field]=...&sort=-field&limit=&cursor=`.

### ۸.۲ Database Manager (`/v1/admin`، فقط با master password)

| متد    | مسیر                         | توضیح                                                                 |
| ------ | ---------------------------- | --------------------------------------------------------------------- |
| POST   | `/login`                     | ورود با master password ← توکن ۱۵ دقیقه‌ای                            |
| GET    | `/databases`                 | فهرست: slug، نام شرکت، نسخه‌ی اسکیما، حجم، آخرین بکاپ، وضعیت          |
| POST   | `/databases`                 | ساخت؛ بدنه: `name`، `adminUsername`، `adminFullName`، `adminPassword` |
| POST   | `/databases/:name/duplicate` | بدنه: `newName`، `neutralize`                                         |
| GET    | `/databases/:name/backup`    | دانلود zip (استریم)                                                   |
| POST   | `/databases/restore`         | multipart: فایل، `newName`، `neutralize`                              |
| DELETE | `/databases/:name`           | بدنه: `confirmName`                                                   |
| POST   | `/databases/:name/upgrade`   | اجرای مایگریشن                                                        |
| PUT    | `/databases/:name/domain`    | تنظیم یا حذف دامنه                                                    |
| POST   | `/change-master-password`    |                                                                       |
| GET    | `/jobs/:id`                  | وضعیت و پیشرفت عملیات طولانی                                          |

عملیات طولانی (ساخت، کپی، بکاپ، بازیابی، حذف) به‌صورت job اجرا می‌شوند و UI پیشرفت را نشان می‌دهد.

### ۸.۳ Endpointهای دیتابیس شرکت

**Auth** (`/v1/auth`): `POST /login` (با `database`)، `POST /refresh`، `POST /logout`، `POST /logout-all`، `GET /me`، `POST /change-password`، `GET /sessions`، `DELETE /sessions/:id`.

**Users** (`user.read/create/update/delete`): `GET /v1/users`، `GET /v1/users/:id`، `POST`، `PATCH /:id`، `POST /:id/reset-password`، `POST /:id/disable`، `/enable`، `/unlock`، `PUT /:id/groups`.

**Groups / Permissions / Teams / Record Rules:**

| متد              | مسیر                                     | مجوز                                  |
| ---------------- | ---------------------------------------- | ------------------------------------- |
| GET/POST         | `/v1/groups`                             | `group.read/create`                   |
| GET/PATCH/DELETE | `/v1/groups/:id`                         | `group.read/update/delete`            |
| PUT              | `/v1/groups/:id/permissions`             | `group.update`                        |
| GET              | `/v1/permissions`                        | کاتالوگ مجوزها (از کد، گروه‌بندی‌شده) |
| GET              | `/v1/groups/:id/record-rules`            |                                       |
| PUT              | `/v1/groups/:id/record-rules/:resource`  | `group.update`                        |
| CRUD             | `/v1/teams`، `/v1/teams/:id`، `/members` | `team.*`                              |

**شرکت و ارز:**

| متد   | مسیر                                    | مجوز                            |
| ----- | --------------------------------------- | ------------------------------- |
| GET   | `/v1/settings/company`                  | همه‌ی کاربران داخلی (نام، لوگو) |
| PATCH | `/v1/settings/company`                  | `company.manage`                |
| POST  | `/v1/settings/company/logo`             | `company.manage`                |
| GET   | `/v1/currencies`                        |                                 |
| PATCH | `/v1/currencies/:code` (فعال/غیرفعال)   | `currency.manage`               |
| PUT   | `/v1/settings/company/default-currency` | `company.manage`                |

**Settings (نمونه): دلایل باخت:** `GET/POST /v1/settings/lost-reasons`، `PATCH/DELETE /:id` (غیرفعال‌سازی)، `POST /reorder`.

**Audit / Timeline / Sequences / سیستم:** `GET /v1/audit?entityType=&entityId=&actorId=&from=&to=` (`audit.read`)، `GET /v1/timeline?subjectType=&subjectId=&types=&cursor=`، `GET/PATCH /v1/settings/sequences`، `GET /health/live`، `GET /health/ready`، `POST /v1/dev/test-event`.

### ۸.۴ مجوزهای اولیه‌ی seed

`user.*`، `group.*`، `team.*`، `company.manage`، `currency.manage`، `audit.read`، `settings.manage`. هر ماژول بعدی مجوزهای خودش را با `registerPermissions([...])` در زمان بوت ثبت می‌کند. چون کاتالوگ در کد است، گروه «مدیر سیستم» در هر دیتابیس همیشه **همه‌ی مجوزهای ثبت‌شده** را به‌صورت پویا دارد (منطق `isSystem` در PermissionGuard).

---

## ۹. الگوی ماژول بک‌اند

```
modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts      # فقط HTTP: اعتبارسنجی، گارد، فراخوانی service
├── <name>.service.ts         # منطق کسب‌وکار
├── <name>.repository.ts      # تنها جایی که به Prisma/SQL دسترسی دارد (از TenantContext کلاینت می‌گیرد)
├── <name>.events.ts
├── <name>.permissions.ts
├── dto/                      # فقط re-export از contracts
└── __tests__/
```

قواعد: controller منطق ندارد؛ service مستقیم Prisma نمی‌خواند؛ ماژول‌ها فقط از طریق service عمومی یا رویداد با هم حرف می‌زنند؛ `@Tracked([...])` برای ثبت خودکار قبل/بعد در `audit_logs`؛ همه‌ی نوشتن‌ها در تراکنش همراه با ثبت outbox در صورت نیاز.

### ۹.۱ Settings Engine

`createSettingsCrud({ model, resource, schema, permission })` یک کنترلر/سرویس CRUD استاندارد (لیست، ایجاد، ویرایش، غیرفعال‌سازی، ترتیب) می‌سازد. فرانت: `SettingsListPage` و `SettingsFormDialog` با تعریف ستون‌ها و فیلدها. حذف فیزیکی ممنوع؛ فقط غیرفعال‌سازی.

---

## ۱۰. فرانت‌اند و PWA

### ۱۰.۱ پکیج `packages/ui`

قواعد: TypeScript، RTL-safe (فقط `ms-/me-/ps-/pe-/start/end`)، استوری در Storybook، قابل‌دسترسی (Radix)، حالت تیره، بدون وابستگی به API، **ریسپانسیو (موبایل‌فرست)**.

| دسته           | کامپوننت                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ساختار         | `AppShell`، `Sidebar` (منوی ماژولار از رجیستری)، `Topbar`، `Breadcrumb`، `ControlPanel` (جستجو، فیلتر، گروه‌بندی)                                                                    |
| داده           | `DataTable`، `ListView`، `FormView`، `StatusBar`، `Badge`                                                                                                                            |
| فرم            | `FormField`، `TextInput`، `TextArea`، `Select`، `ComboBox`، `Checkbox`، `Switch`، `MoneyInput`، `NumberInput`، `PhoneInput`، `JalaliDatePicker`، `JalaliDateRangePicker`، `TagInput` |
| بازخورد        | `Toast`، `ConfirmDialog`، `Dialog`، `Drawer`، `EmptyState`، `Skeleton`، `ErrorState`، `ProgressJob` (نمایش پیشرفت job)                                                               |
| تاریخچه (پایه) | `Chatter` (پوسته)، `TimelineItem`، `LostDialog`                                                                                                                                      |

`CompanySwitcher` وجود ندارد. نام شرکت (از `company_profile`) و لوگو در Topbar و Sidebar نمایش داده می‌شود.

### ۱۰.۲ تقویم شمسی و اعداد

- کتابخانه: `jalaali-js` یا `date-fns-jalali` (در ADR انتخاب شود).
- `packages/utils/jalali`: `toJalali`، `fromJalali`، `formatDate`، `formatRelative`، `parseJalaliInput`.
- `JalaliDatePicker`: ورودی و خروجی ISO؛ نمایش شمسی، شروع هفته شنبه، ورود تایپی با اعداد فارسی/انگلیسی.
- اعداد: نمایش فارسی (قابل‌تنظیم)، ورودی هر دو (نرمال‌سازی خودکار).

### ۱۰.۳ ساختار برنامه‌ی وب

- `features/<module>/` شامل `pages`، `components`، `api` (hooks بر پایه‌ی contracts)، و `module.manifest.ts` (مسیرها، منو، مجوز لازم).
- احراز هویت: provider، refresh خودکار روی ۴۰۱ با صف درخواست‌ها.
- `<Can permission="...">` برای مسیرها و دکمه‌ها.
- نوع کاربر `PORTAL` وارد برنامه‌ی داخلی نمی‌شود.

### ۱۰.۴ PWA

- `manifest.webmanifest` (نام فارسی، آیکون‌ها، `display: standalone`، `dir: rtl`، `lang: fa`)، قابل نصب روی موبایل و دسکتاپ.
- Service worker: فقط cache برای app shell و فایل‌های ثابت (stale-while-revalidate)؛ **پاسخ API هرگز cache نمی‌شود**. صفحه‌ی «آفلاین» ساده و پیام فارسی.
- ریسپانسیو: Sidebar در موبایل Drawer؛ جدول‌ها در موبایل به نمای کارتی تبدیل می‌شوند (`DataTable` این حالت را دارد).
- نیاز به HTTPS (گواهی داخلی/Let's Encrypt).
- به‌روزرسانی نسخه: اعلان «نسخه‌ی جدید آماده است».

### ۱۰.۵ صفحات مرحله‌ی ۱

- **ورود** (با فیلد دیتابیس؛ مخفی در حالت دامنه‌ی اختصاصی)
- **Database Manager** (`/database-manager`، با master password): فهرست، ساخت، کپی، بکاپ، بازیابی، حذف، ارتقا، دامنه
- داشبورد خالی (placeholder)
- کاربران (لیست/فرم)، گروه‌ها (لیست/فرم + ماتریس مجوزها + Record Rule)، تیم‌ها
- **تنظیمات ← شرکت:** نام، نام حقوقی، شناسه ملی، شماره ثبت، کد اقتصادی، تلفن، ایمیل، آدرس، کدپستی، لوگو، ارز پیش‌فرض و ارزهای فعال
- تنظیمات ← دلایل باخت، شماره‌گذاری
- پروفایل من (تغییر رمز، نشست‌ها)
- صفحه‌ی نمایش کامپوننت‌ها (فقط توسعه)

---

## ۱۱. زیرساخت و استقرار (Docker Compose)

سرویس‌ها: `postgres:16`، `redis:7`، `api`، `worker` (همان image با دستور دیگر)، `web` (nginx)، و `minio` (از مرحله‌ی پیوست‌ها، اختیاری).

Volumeها: `pgdata`، `filestore`، `backups`، `config` (master.json و domains.json؛ **این پوشه باید جزو بکاپ سرور باشد**).

- متغیرها در `.env` (نمونه در `.env.example`)؛ هیچ رازی در git نباشد.
- Postgres: `max_connections` متناسب تعداد دیتابیس‌ها (حدود تعداد دیتابیس × ۵ × تعداد پردازه‌ها)؛ در صورت زیاد شدن، PgBouncer در حالت transaction.
- **بکاپ سرور:** علاوه بر بکاپ هر دیتابیس، کپی خارج از ماشین (مسئولیت خودت است).
- `docker compose up` باید کل سیستم را بالا بیاورد؛ دیتابیس‌های موجود در صورت `AUTO_MIGRATE=true` ارتقا می‌یابند و بدون هیچ دیتابیسی هم سیستم بالا می‌آید (فقط Database Manager در دسترس است).
- لاگ ساختاریافته JSON (pino) با `requestId` و `db`؛ `/health/ready` وضعیت postgres و redis را بررسی می‌کند.

---

## ۱۲. تست و کیفیت

| سطح                                 | الزام                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                | منطق service، utils (جلالی، اعتبارسنجی‌ها، cursor)                                                                                                                        |
| Integration                         | با Postgres واقعی (Testcontainers)                                                                                                                                        |
| **ایزولاسیون چنددیتابیسی (اجباری)** | کاربر دیتابیس A نمی‌تواند با توکن خود به B برسد؛ ورود با کاربر A در دیتابیس B رد می‌شود؛ کلاینت‌ها هیچ‌وقت pool مشترک ندارند؛ کوئری یک درخواست فقط به دیتابیس خودش می‌رود |
| **Provisioning**                    | خطا در هر مرحله ← هیچ دیتابیس یا پوشه‌ی ناقصی باقی نماند                                                                                                                  |
| **بکاپ ← بازیابی**                  | بازیابی روی نام جدید، شمارش جدول‌ها و صحت چند رکورد، و فایل‌ها یکسان باشد؛ بکاپ قدیمی‌تر مایگریشن می‌شود؛ جدیدتر رد می‌شود                                                |
| **مایگریشن چندگانه**                | خطا در یک دیتابیس بقیه را متوقف نکند                                                                                                                                      |
| Contract                            | هر endpoint در برابر شِمای zod                                                                                                                                            |
| دسترسی                              | تست‌های PermissionGuard و Record Rule                                                                                                                                     |
| e2e                                 | ساخت دیتابیس، ورود، ساخت کاربر/گروه، تنظیم مجوز، ویرایش نام شرکت، CRUD دلایل باخت                                                                                         |
| CI                                  | lint + typecheck + test + build؛ مایگریشن روی دیتابیس خالی                                                                                                                |

---

## ۱۳. ترتیب گام‌ها

هر گام با چک‌لیست تایید بسته می‌شود و commit/tag جدا دارد.

| گام   | محتوا                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------- |
| S1.1  | اسکلت مونوریپو، ابزارها، CI، Docker Compose، health                                                  |
| S1.2  | اسکیمای Prisma، مایگریشن `0001_init` (پارتیشن، GRANT، CHECK)، seed                                   |
| S1.3  | زیرساخت چنددیتابیسی: TenantContext، TenantClientManager، TenantRunner، MigrationRunner، config-store |
| S1.4  | Database Manager (API): ساخت، فهرست، کپی، بکاپ، بازیابی، حذف، ارتقا + تست‌های بند ۱۲                 |
| S1.5  | زیرساخت api: خطاها، pagination، zod، لاگ، تراکنش و مدیریت context                                    |
| S1.6  | Auth کامل (login با دیتابیس، refresh چرخشی، logout، قفل، sessions)                                   |
| S1.7  | Users، Company Profile، Currencies                                                                   |
| S1.8  | Groups، Permissions، Teams، Record Rules + تست‌های دسترسی                                            |
| S1.9  | Audit، Outbox، Event Bus، Timeline، Sequences                                                        |
| S1.10 | `packages/utils` (جلالی، اعتبارسنجی ایرانی، money) + تست                                             |
| S1.11 | `packages/ui`: کامپوننت‌های پایه + Storybook + RTL                                                   |
| S1.12 | AppShell، ورود، رجیستری ماژول، Database Manager UI، مدیریت کاربران/گروه‌ها، تنظیمات شرکت، PWA        |
| S1.13 | Settings Engine + دلایل باخت                                                                         |
| S1.14 | بکاپ شبانه، تست بازیابی، مستندات نهایی، تست پذیرش                                                    |

---

## ۱۴. معیار پذیرش پایان مرحله‌ی ۱

- [ ] از Database Manager دو دیتابیس با دو مدیر ساخته می‌شود، بدون وارد کردن هیچ اطلاعات شرکت؛ در ورود هرکدام فقط داده‌ی خودش دیده می‌شود
- [ ] نام و تنظیمات شرکت از بخش تنظیمات ویرایش می‌شود و در Topbar نمایش داده می‌شود
- [ ] کپی، بکاپ، بازیابی (روی نام جدید) و حذف کار می‌کنند؛ خطای وسط ساخت هیچ دیتابیس ناقصی نمی‌گذارد
- [ ] ورود، خروج، refresh چرخشی و قفل حساب کار می‌کند؛ توکن یک دیتابیس در دیتابیس دیگر بی‌اعتبار است
- [ ] ساخت کاربر/گروه/تیم، تنظیم مجوز و Record Rule از UI
- [ ] Record Rule (فقط خودم / تیم / همه) روی یک منبع نمونه با تست ثابت شده
- [ ] AppShell کامل RTL و ریسپانسیو، تقویم شمسی و `MoneyInput` در Storybook و صفحه‌ی نمونه
- [ ] اپ نصب‌پذیر (PWA) است و بدون cache شدن API کار می‌کند
- [ ] دلایل باخت: لیست ← فرم ← ذخیره ← غیرفعال‌سازی با کامپوننت‌های ui
- [ ] رویداد تستی از Outbox به Timeline می‌رسد و idempotent است
- [ ] `docker compose up` کل سیستم را بالا می‌آورد؛ بکاپ شبانه و تست بازیابی انجام شده
- [ ] CI سبز، پوشش تست‌های حیاتی (auth، ایزولاسیون، دسترسی، بکاپ/بازیابی) کامل
- [ ] مستندات (`rules.md`، ADRها، README اجرا) به‌روز

---

## ۱۵. چیزهایی که عمداً در مرحله‌ی ۱ نیست

نوتیفیکیشن و یادآور (مرحله‌ی ۲)، مخاطبین و CRM (۳)، محصولات و واحدها (۴)، فروش (۵)، پورتال و API عمومی (۶)، خرید و مراحل بعد از سفارش (۷)، پیوست فایل با MinIO، گزارش‌ها، مانیتورینگ Grafana/Prometheus.
