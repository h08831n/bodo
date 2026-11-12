# دستورالعمل گام S1.3 — زیرساخت چنددیتابیسی (Tenancy)

> مسیر در پروژه: `docs/agent-prompt-s1-3.md`
> شاخه: `step/s1-3-tenancy-infra`
> مرجع اصلی: `docs/stage-1-technical-spec.md` بخش ۲ (۲.۱ تا ۲.۳ و ۲.۶)، `docs/rules.md` بند ۳ و ۹ و ۱۰، و ADR-0003.
> این گام **قلب ایزولاسیون شرکت‌ها** است. خطای اینجا یعنی نشت داده بین شرکت‌ها. هر تصمیم مهم باید با تست ثابت شود.

---

## هدف

ساخت لایه‌ای که هر درخواست و هر job را به **دقیقاً یک دیتابیس شرکت** وصل می‌کند و تضمین می‌کند هیچ کدی نمی‌تواند به دیتابیس دیگری برسد. شامل: `TenantContext`، `TenantClientManager`، رجیستری و اعتبارسنجی نام دیتابیس، حالت نگهداری (Maintenance)، `TenantRunner` برای Worker، `MigrationRunner`، `ConfigStore`، کمک‌کننده‌های ایزوله برای Redis و فایل، و ارتقای Health به بررسی واقعی.

Database Manager (ساخت/کپی/بکاپ/حذف) در S1.4 است. احراز هویت و JWT در S1.6 است. در این گام نباید ساخته شوند.

---

## تصمیم‌های طراحی (قفل‌شده)

1. **Lease به‌جای دسترسی آزاد:** هر درخواست HTTP و هر job یک «اجاره» (lease) روی کلاینت دیتابیس خودش می‌گیرد و با پایان درخواست آزاد می‌کند. کلاینتی که lease فعال دارد هرگز evict یا `$disconnect` نمی‌شود. این جلوی قطع‌شدن اتصال وسط درخواست را می‌گیرد.
2. **Single-flight:** اگر ۵۰ درخواست هم‌زمان برای یک دیتابیس بدون کلاینت برسند، فقط **یک** کلاینت ساخته می‌شود.
3. **اعتبارسنجی نام دیتابیس قبل از هر چیز** و قبل از هر کوئری یا ساخت URL. نام هرگز مستقیم در SQL نمی‌رود (فقط پارامتر)، و در URL با encode قرار می‌گیرد.
4. **Fail-closed:** اگر نتوان وضعیت Maintenance را از Redis خواند، درخواست رد می‌شود (`503`)، نه اینکه ادامه یابد. Redis از قبل وابستگی اجباری ماست. این تصمیم در ADR ثبت شود.
5. **یک منبع حقیقت برای URL اتصال:** منطق ساخت URL (host، port، نقش، رمز، نام دیتابیس) یک‌جا باشد. اگر اسکریپت‌های `scripts/*.mjs` و API هر دو لازم دارند، یا یک پیاده‌سازی مشترک استفاده شود یا دو پیاده‌سازی با تست برابری خروجی.
6. **تشخیص دیتابیس درخواست با `Resolver`های مرتب‌شده:** فعلاً `Host` (از `domains.json`) و سپس هدر `X-Database`. در S1.6 استراتژی JWT اضافه می‌شود که **اولویت بالاتر** دارد و باید با دیتابیس درخواست یکی باشد. طراحی را طوری بکن که افزودن آن بدون تغییر ساختار باشد.

---

## خروجی‌های لازم

### ۱. `apps/api/src/infra/tenancy/`

**`database-name.ts`**

- `isValidDatabaseName(name)`: فقط `^erp_[a-z0-9_]{3,40}$`، بدون `__` متوالی بی‌دلیل نیست ولی بدون پیشوند `erp_tmp_` (آن‌ها موقت Provisioning هستند و هرگز برای درخواست معتبر نیستند)؛ `slugToDatabaseName(slug)` و `databaseNameToSlug(name)`.
- فهرست نام‌های رزروشده (`postgres`، `template0`، `template1` و ...) که از قبل با الگو رد می‌شوند ولی صریحاً تست شوند.

**`tenant-context.ts`**

- `AsyncLocalStorage` با محتوای `{ db, requestId?, userId?, client? }`.
- `runWithTenant(db, fn)`، `getCurrentDb()` (اگر context نیست `throw`)، `tryGetCurrentDb()`.
- هیچ‌گاه به متغیر سراسری یا singleton قابل‌تغییر وابسته نباشد.

**`tenant-client-manager.ts`**

- کش LRU از `PrismaClient`، حداکثر `TENANT_MAX_CLIENTS` (پیش‌فرض ۲۰)، pool هر کلاینت `TENANT_POOL_SIZE` (پیش‌فرض ۵)، evict کردن کلاینت بیکار پس از `TENANT_IDLE_MS` (پیش‌فرض ۱۰ دقیقه).
- `lease(db, fn)` طبق تصمیم ۱ و ۲. شمارنده‌ی lease فعال برای هر دیتابیس.
- `evict(db, { timeoutMs })`: صبر تا lease‌های فعال تمام شوند (با timeout و خطای واضح)، سپس `$disconnect` و حذف از کش. این تابع در S1.4 برای کپی/حذف/بازیابی استفاده می‌شود.
- اگر کلاینت از کش LRU بیرون می‌افتد ولی lease دارد، evict تا پایان lease به تعویق می‌افتد (نه قطع فوری).
- `stats()`: تعداد کلاینت باز، lease فعال، و اندازه‌ی کش.
- اتصال با نقش **`erp_app`** (کمترین دسترسی). هیچ نقش دیگری در مسیر درخواست استفاده نشود.
- در زمان بوت، یک **هشدار بودجه‌ی اتصال** لاگ شود: `TENANT_MAX_CLIENTS × TENANT_POOL_SIZE × تعداد پردازه‌ها` در برابر `max_connections` واقعی Postgres؛ اگر بیش از ۸۰٪ بود هشدار بدهد (best-effort، شکستش نباید برنامه را متوقف کند).

**`tenant-prisma.service.ts`**

- سرویس Nest با getter `client` که کلاینت دیتابیس **context جاری** را برمی‌گرداند. اگر context نیست `throw` با پیام واضح. هیچ ماژولی نباید `PrismaClient` را مستقیم import و بسازد (قانون `rules.md` بند ۳).
- ESLint rule یا تست ساختاری: `new PrismaClient` فقط در `TenantClientManager` (و اسکریپت‌ها/تست‌ها) مجاز است. تخلف باید CI را بشکند.

**`database-registry.service.ts`**

- `exists(db)`: کوئری پارامتری روی `pg_database`، با کش کوتاه (۱۰ ثانیه) و نتیجه‌ی منفی هم کش شود (تا حمله‌ی حدس‌زدن نام فشار نیاورد).
- `assertUsable(db)`: نام معتبر، وجود، غیر-tmp، بدون Maintenance.
- `listActive()`: فهرست دیتابیس‌های `erp_*` که `company_profile` دارند و `erp_tmp_*` نیستند و `datistemplate` نیستند (برای `TenantRunner`). برای تشخیص «دیتابیس bodo است» یک کوئری سبک روی خود دیتابیس.
- خطاهای دامنه: `DatabaseRequiredError` (۴۰۰)، `DatabaseNotFoundError` (۴۰۴، پیام یکسان برای «وجود ندارد» و «نام نامعتبر»)، `DatabaseMaintenanceError` (۵۰۳ + هدر `Retry-After`).

**`maintenance.service.ts`**

- `set(db, { reason, durable })`، `clear(db)`، `get(db)`.
- پرچم سریع در Redis (`maint:<db>` با payload `{reason, since}`)، و اگر `durable` بود، نسخه‌ی پایدار در `system_settings` (کلید `maintenance`) همان دیتابیس.
- در بوت API، `rehydrate()` پرچم‌های پایدار را به Redis برمی‌گرداند (تا یک flush یا ری‌استارت Redis یک دیتابیس نیمه‌مایگریت‌شده را باز نکند).
- fail-closed طبق تصمیم ۴.

**`tenant-resolver.ts` و `tenant.middleware.ts`**

- Resolverها به ترتیب: `HostResolver` (نگاشت `domains.json`؛ حروف کوچک، حذف پورت، wildcard ممنوع)، `HeaderResolver` (`X-Database`، قبل از هر مصرف اعتبارسنجی نام).
- middleware: مسیرهای معاف با دکوراتور `@NoTenant()` (مثل `/health/*`، آینده‌ی `/v1/admin/*` و `/v1/public/*`). بقیه: resolve ← `assertUsable` ← `runWithTenant` + lease، و **آزادسازی lease با پایان پاسخ** (`finish` و `close`؛ و یک سقف زمانی ایمنی برای lease). اگر دیتابیسی resolve نشد: `DatabaseRequiredError`.
- نتیجه‌ی ارزیابی را لاگ کن (db، منبع resolve) بدون اطلاعات حساس.

**`tenant-runner.service.ts`**

- `forEachActiveDatabase(fn, { concurrency = 3, timeoutMs })`: برای هر دیتابیس فعال، داخل `runWithTenant` + lease، try/catch جدا، timeout جدا، و رد‌کردن دیتابیس‌های Maintenance. نتیجه: آرایه‌ی `{ db, ok, error?, durationMs, skipped? }`. خطای یکی هرگز بقیه را متوقف نمی‌کند. محدودیت هم‌زمانی واقعاً اعمال شود.

**`migration-runner.service.ts`**

- `status(db)`: مایگریشن‌های اعمال‌شده در برابر موجود (با نقش `erp_migrator` چون `_prisma_migrations` ممکن است برای `erp_app` قابل‌خواندن نباشد؛ این را بررسی و مستند کن).
- `upgrade(db)`: Maintenance روشن (durable) ← `prisma migrate deploy` با `erp_migrator` (فرایند فرزند **بدون `shell: true`**) ← در موفقیت Maintenance خاموش ← در شکست، دیتابیس در Maintenance با دلیل `migration_failed` می‌ماند و خطا با خروجی کوتاه برمی‌گردد.
- `upgradeAll()`: با `TenantRunner`-مانند منطق (اما با نقش migrator)، اثر خطای یک دیتابیس روی بقیه صفر.
- مسیر پوشه‌ی مایگریشن/اسکیما **قابل‌تزریق** (پارامتر یا env) تا تست بتواند یک مایگریشن ساختگی بدهد.
- `AUTO_MIGRATE=true`: فقط در پردازه‌ی API در بوت، `upgradeAll` پیش از پذیرش ترافیک. Worker هرگز مایگریشن نمی‌زند. (Prisma خودش advisory lock می‌گیرد؛ همین را در ADR ذکر کن.)

### ۲. `ConfigStore` (`apps/api/src/infra/config-store/`)

- خواندن/نوشتن JSON در `CONFIG_DIR` (پیش‌فرض dev: `./data/config`، docker: `/data/config`).
- نوشتن **اتمیک** (فایل موقت + rename)، سریالایز‌کردن نوشتن‌های هم‌زمان، اعتبارسنجی با zod، و کش حافظه با بررسی `mtime`.
- `DomainMap`: خواندن `domains.json` (قالب `{ "acme.erp.local": "erp_acme" }`). فایل خراب یا نامعتبر: خطا لاگ شود و نگاشت خالی در نظر گرفته شود (نه کرش)؛ resolver هدر کار می‌کند.
- `master.json` در S1.4 است؛ فقط ساختار `ConfigStore` عمومی باشد.

### ۳. کمک‌کننده‌های ایزوله

- **Redis (`ioredis`)**: ماژول Redis با اتصال رمزدار؛ تابع `tenantKey(db, ...parts)` و `tenantQueueName(db, name)`. کلید بدون پیشوند دیتابیس نباید به‌راحتی ساخته شود (کلیدهای سراسری مثل `maint:<db>` فقط از طریق یک تابع `globalKey` مستند).
- **فایل**: `filestorePath(db, ...parts)` با `FILESTORE_DIR`؛ نام دیتابیس معتبر، `path.resolve` و بررسی اینکه نتیجه داخل `FILESTORE_DIR/<db>` است. حمله‌ی `../`، مسیر مطلق، `%2e%2e`، بک‌اسلش ویندوز و نام دیتابیس مخرب باید رد شود.
- **لاگر pino**: فیلد `db` از context (mixin) پر شود، نه ثابت `null`.

### ۴. Health واقعی

- `/health/ready`: Postgres با `SELECT 1` واقعی (یک pool کوچک با نقش `erp_app` روی دیتابیس `postgres`؛ اگر `CONNECT` لازم است بررسی کن) و Redis با `PING` واقعی (رمزدار). قالب پاسخ فعلی حفظ شود. کد ۵۰۳ هنگام قطع.
- در پاسخ، آمار `tenantClients` (باز/سقف) هم بیاید (بدون نام دیتابیس‌ها، چون endpoint عمومی است).

### ۵. قرارداد خطا

- در `packages/contracts` کدهای `DATABASE_REQUIRED`، `DATABASE_NOT_FOUND`، `DATABASE_MAINTENANCE` اضافه شوند (با تست) و `GlobalExceptionFilter` خطاهای دامنه را به آن‌ها نگاشت کند (۴۰۰/۴۰۴/۵۰۳ + `Retry-After`). پیام‌ها فارسی.

### ۶. Endpoint فقط-توسعه برای تست ایزولاسیون

- `GET /v1/dev/tenant-info` با گارد `DevOnly` (در `NODE_ENV=production` پاسخ ۴۰۴). خروجی: `current_database()` و `company_profile.name` از کلاینت context جاری. این endpoint اثبات می‌کند درخواست واقعاً به دیتابیس درست رفته است.

### ۷. متغیرهای محیطی

`TENANT_MAX_CLIENTS`، `TENANT_POOL_SIZE`، `TENANT_IDLE_MS`، `CONFIG_DIR`، `FILESTORE_DIR`، `AUTO_MIGRATE`، و آنچه برای ساخت URL نقش‌ها لازم است. همه در `.env.example` و در اعتبارسنجی zod (با تست) و در Compose.

### ۸. نظافت (در همین PR، جدا کامیت شوند)

1. **Compose:** برای فایل اصلی `name: bodo` و برای dev `name: bodo-dev` تا هشدار orphan و خطر `--remove-orphans` از بین برود. توجه: نام پروژه نام volumeها را عوض می‌کند. چون هنوز داده‌ی مهمی نیست مشکلی نیست، ولی یادداشت مهاجرت در README بنویس (یک‌بار `docker compose -p infra down` برای پروژه‌ی قدیمی، و اینکه `erp_dev` با `pnpm db:setup-dev` دوباره ساخته می‌شود). لانچرهای ویندوز و README هماهنگ شوند و تست شوند.
2. حذف `shell: true` از اسکریپتی که `DEP0190` می‌دهد.
3. حذف رمز ثابت superuser از تست یکپارچه (استفاده از لودر مشترک `db-env`).

---

## تست‌ها (الزامی؛ Postgres واقعی و Redis واقعی)

**Context و ایزولاسیون**

1. ۲۰۰ تسک async درهم‌تنیده (دو دیتابیس، با تاخیرهای تصادفی) هرگز `db` دیگری نمی‌بینند.
2. **HTTP end-to-end:** دو دیتابیس با نام شرکت متفاوت؛ درخواست با `X-Database: A` ← `current_database()` و نام شرکت A؛ با B ← B. هیچ پاسخی داده‌ی دیگری را نشان ندهد.
3. بدون دیتابیس ← ۴۰۰ `DATABASE_REQUIRED`. دیتابیس ناموجود، نام نامعتبر، `postgres`، `template1`، `erp_tmp_x`، `erp_x; drop table`، نام خیلی بلند، و حروف بزرگ ← همگی ۴۰۴ با بدنه‌ی یکسان.
4. Maintenance روی A ← ۵۰۳ + `Retry-After` برای A، و B کاملاً سالم. پایان Maintenance ← A سالم.
5. Fail-closed: با قطع‌بودن Redis (شبیه‌سازی)، درخواست‌های tenant رد می‌شوند ولی `/health/*` پاسخ می‌دهد (و ready خطا نشان می‌دهد).

**ClientManager** 6. Single-flight: ۵۰ درخواست هم‌زمان برای دیتابیس جدید ← یک کلاینت. 7. LRU: بیش از سقف ← قدیمی‌ترین بیکار evict می‌شود و تعداد اتصال آن دیتابیس در `pg_stat_activity` به ۰ می‌رسد؛ دیتابیس‌های دیگر دست‌نخورده. 8. Lease: کلاینتی با lease فعال evict/disconnect نمی‌شود تا lease تمام شود؛ `evict` با timeout خطای واضح می‌دهد؛ بعد از evict، درخواست بعدی به‌درستی دوباره کلاینت می‌سازد. 9. نشت اتصال: بعد از بستن همه، `pg_stat_activity` برای دیتابیس‌های تست صفر است.

**Runner و Migration** 10. `TenantRunner`: سه دیتابیس، یکی خطا، یکی کند (timeout)، یکی Maintenance ← نتایج درست، بقیه اجرا می‌شوند، سقف هم‌زمانی رعایت می‌شود. 11. `MigrationRunner`: با مایگریشن ساختگی `0002` از مسیر تزریق‌شده؛ `status` قبل و بعد؛ `upgradeAll` روی ۳ دیتابیس که یکی `0002` خراب دارد ← آن یکی در Maintenance با دلیل `migration_failed` و بقیه مایگریت شده؛ پرچم پایدار بعد از «flush Redis و rehydrate» برمی‌گردد.

**کمک‌کننده‌ها** 12. `database-name`: جدول کامل نام‌های معتبر و نامعتبر (unit). 13. `ConfigStore`: نوشتن اتمیک، نوشتن‌های هم‌زمان، فایل خراب، تغییر `mtime`. `DomainMap`: حروف بزرگ/کوچک، پورت، دامنه‌ی ناشناخته، فایل خراب. 14. `filestorePath`: مجموعه‌ی کامل حملات مسیر (بند ۳). 15. `tenantKey`/`tenantQueueName`: همیشه پیشوند دیتابیس. 16. لاگ: خط لاگ داخل context شامل `db` درست است. 17. Health: `SELECT 1` و `PING` واقعی؛ قطع هرکدام ← ۵۰۳ با وضعیت درست. 18. ساختاری: `new PrismaClient` خارج از مجاز ← شکست.

**CI:** همه‌ی تست‌ها در CI (Redis و Postgres واقعی) و روی ماشین ویندوز من اجرا شوند.

---

## معیار پذیرش S1.3

- [ ] درخواست‌های دو دیتابیس هم‌زمان هرگز قاطی نمی‌شوند (تست ۱ و ۲ با `current_database()`)
- [ ] نام نامعتبر یا سمی هرگز به کوئری یا URL نمی‌رسد؛ پاسخ یکسان
- [ ] Single-flight، LRU، lease و نبود نشت اتصال با `pg_stat_activity` ثابت شده
- [ ] Maintenance تک‌دیتابیسی، fail-closed و پایدار (rehydrate) با تست
- [ ] `TenantRunner` و `MigrationRunner` ایزوله‌ی خطا، با مایگریشن ساختگی
- [ ] `ConfigStore` اتمیک؛ `DomainMap` ایمن در برابر فایل خراب
- [ ] کلید Redis و مسیر فایل همیشه ایزوله؛ حملات مسیر رد می‌شوند
- [ ] Health واقعی (`SELECT 1` و `PING`)
- [ ] کدهای خطای جدید در `contracts`، فیلتر و تست
- [ ] هیچ `new PrismaClient` بیرون از مجاز (CI می‌شکند)
- [ ] نظافت: Compose با نام پروژه، `DEP0190`، رمز ثابت تست
- [ ] ADR-0004 (Lease، single-flight، fail-closed، Maintenance پایدار، ترتیب Resolverها، بودجه‌ی اتصال، اثر نام پروژه‌ی Compose)
- [ ] `start.bat`، `stop.bat`، `dev-start.bat`، `dev-stop.bat`، `status.bat` و `db-setup.bat` بعد از تغییر Compose روی ماشین ویندوز **واقعاً** اجرا شده‌اند و خروجی در گزارش آمده است (سرویس جدیدی اضافه نشده؛ همین را تایید کن)
- [ ] CI سبز؛ هیچ رازی commit نشده

## در این گام ممنوع است

Database Manager و هر endpoint `/v1/admin`، Provisioning، master password، احراز هویت و JWT و کاربر، BullMQ و صف واقعی (فقط نام‌گذاری)، `packages/ui`، و شروع S1.4.

## پایان گام

گزارش با قالب بند ۱۱ `rules.md`: خروجی واقعی اجرای تست‌ها روی ماشین ویندوز، خروجی `docker compose ps` بعد از اصلاح نام پروژه، آمار `/health/ready`، لینک PR و CI. صراحتاً بگو چه چیزی اجرا نشده. بعد از گزارش منتظر تایید من بمان.
