# دستورالعمل گام S1.4 — Database Manager (API)

> مسیر در پروژه: `docs/agent-prompt-s1-4.md`
> شاخه: `step/s1-4-database-manager`
> مرجع: `docs/stage-1-technical-spec.md` بخش‌های ۲.۳ تا ۲.۵، ۶.۴، ۸.۲ و ۱۲؛ `docs/rules.md` بند ۳، ۶، ۹، ۱۰؛ ADR-0003 و ADR-0004.
> این گام **داده‌ی واقعی را حذف و بازیابی می‌کند.** هر عملیات باید ایمن، قابل‌پیگیری و بدون حالت نیمه‌کاره باشد. اشتباه اینجا یعنی از دست رفتن داده‌ی یک شرکت.

---

## هدف

ساخت بک‌اند مدیریت دیتابیس‌ها (بدون UI): احراز هویت Master، ساخت، فهرست، کپی، بکاپ، بازیابی، حذف، ارتقا و ترمیم، مدیریت دامنه، و اجرای عملیات طولانی به‌صورت job با گزارش پیشرفت. صفحه‌ی UI در S1.12 است؛ در این گام یک CLI موقت می‌سازیم.

---

## اصلاحات مستند (اعمال کن، در کامیت docs جدا)

1. **بکاپ job-based است:** به‌جای `GET /databases/:name/backup` (استریم مستقیم):
   `POST /databases/:name/backups` (ساخت job)، `GET /databases/:name/backups` (فهرست)، `GET /databases/:name/backups/:file` (دانلود استریم)، `DELETE /databases/:name/backups/:file`.
2. **افزودن:** `POST /databases/:name/repair`، `POST /databases/:name/maintenance`، `GET /jobs`، و endpointهای عمومی `GET /v1/public/databases` و `GET /v1/public/tenant-by-host`.
3. **Worker از این گام heartbeat دارد** (بند ۹) و `/health/ready` وضعیت آن را گزارش می‌کند. (قبلاً به S1.9 موکول شده بود؛ چون عملیات مدیریتی به worker وابسته‌اند، همین‌جا لازم است. ADR-0002 اصلاح شود.)

---

## تصمیم‌های طراحی (قفل‌شده)

1. **اجرای عملیات روی Worker (BullMQ)**؛ API فقط اعتبارسنجی می‌کند، job می‌سازد و وضعیت را می‌خواند. صف سراسری `admin-ops` (کلید سراسری، نه tenant). هم‌زمانی کل: ۲؛ **هر دیتابیس در هر لحظه حداکثر یک عملیات مخرب** (قفل Redis با TTL و تمدید؛ عملیات دوم ← ۴۰۹ `CONFLICT`).
2. **Maintenance را قبل از هر عملیات مخرب روشن کن** و بعد از پایان (موفق یا ناموفق) درست خاموش کن، مگر اینکه عملیات شکست خورده و دیتابیس ناسالم است.
3. **تخلیه‌ی کلاینت‌ها بین پردازه‌ها:** کش کلاینت‌ها در حافظه‌ی هر پردازه (api و worker) است. `TenantClientManager` را گسترش بده: کانال Redis pub/sub (`tenant:evict`) تا هر پردازه با دریافت پیام برای یک دیتابیس `evict` کند. پیش از `DROP`/`RENAME`: Maintenance ← publish evict ← صبر برای تخلیه (polling `pg_stat_activity`، timeout) ← `pg_terminate_backend` برای باقی‌مانده‌ها (فقط روی همان دیتابیس، فقط اتصال‌هایی که اتصال خود Manager نیستند).
4. **ایمنی اجرای دستورها:** ابزارهای `pg_dump`/`pg_restore`/`psql` فقط با `spawn` و آرایه‌ی آرگومان، `shell: false`؛ رمز فقط از طریق `PGPASSWORD` در env فرزند؛ نام‌ها قبل از هر استفاده با `isValidDatabaseName` اعتبارسنجی شود؛ هرگز رمز یا Master Password در لاگ، خروجی job یا خطا ظاهر نشود.
5. **لایه‌ی `PgTools` با دو راننده:** `local` (باینری‌ها از `PG_BIN_PATH` یا PATH، برای production در Docker و CI) و `docker` (اجرای ابزارها با `docker exec` داخل کانتینر Postgres، برای توسعه روی ویندوز؛ نام کانتینر از env). انتخاب با `PG_TOOLS_DRIVER`. ورودی/خروجی dump از طریق استریم؛ هر دو راننده تست شوند (راننده‌ی `docker` روی ماشین ویندوز من، `local` در CI).
6. **هیچ فایل نیمه‌کاره‌ای باقی نماند:** فایل‌های موقت در `BACKUP_DIR/.tmp/<jobId>`؛ پاک‌سازی تضمینی در `finally`؛ هنگام بوت، فایل‌ها و دیتابیس‌های `erp_tmp_*` یتیم قدیمی‌تر از ۲۴ ساعت شناسایی و گزارش شوند (حذف خودکار فقط با پرچم `CLEAN_ORPHANS=true`).
7. **بررسی فضای دیسک:** قبل از بکاپ/کپی/بازیابی، فضای آزاد مسیر هدف حداقل ۱.۵ برابر حجم تخمینی باشد (`fs.statfs` و `pg_database_size`)، وگرنه خطای واضح و بدون شروع.
8. **سقف و استریم:** هیچ‌جا فایل بزرگ در حافظه بارگذاری نشود. آپلود بازیابی به فایل موقت استریم شود؛ سقف `MAX_RESTORE_UPLOAD_MB`.

---

## خروجی‌های لازم

### ۱. Master Password و دسترسی ادمین

- `master.json` در `ConfigStore` (قالب: `{ passwordHash, passwordVersion, createdAt, updatedAt }`)؛ هش با **argon2id** (کتابخانه‌ی جدید؛ ADR کوتاه. اگر باینری native روی Docker Debian مشکل داشت از جایگزین `@node-rs/argon2` استفاده کن و دلیلش را بنویس).
- بوت: اگر `master.json` نیست و `MASTER_PASSWORD_INITIAL` تنظیم است، هش بساز و بنویس. بعد از آن مقدار env نادیده گرفته می‌شود؛ هشدار لاگ بده که از `.env` حذف شود.
- `POST /v1/admin/login`: مقایسه‌ی ایمن، rate limit در Redis (۵ تلاش ناموفق ← قفل ۱۵ دقیقه برای IP)، توکن ۱۵ دقیقه‌ای با `aud=admin`، امضای جدا از JWT کاربران (کلید `ADMIN_JWT_SECRET`، یا مشتق‌شده با HKDF از `JWT_SECRET`)، و claim `pv` = `passwordVersion` (تغییر رمز همه‌ی توکن‌های قبلی را باطل می‌کند).
- `POST /v1/admin/change-master-password` (رمز فعلی لازم، حداقل ۱۲ کاراکتر).
- `MasterAdminGuard`، `DB_MANAGER_ENABLED=false` ← همه‌ی `/v1/admin/*` پاسخ ۴۰۴ بدهند، `DB_MANAGER_ALLOWED_IPS` (فهرست IP و CIDR). IP واقعی کلاینت فقط از طریق proxy مورد اعتماد (nginx)؛ `trust proxy` را درست تنظیم کن و nginx هدر IP را بفرستد؛ تست کن که جعل `X-Forwarded-For` از بیرون اثر ندارد.
- **لاگ ممیزی ادمین:** فایل JSON-lines append-only (`/data/logs/admin-audit.log`، مسیر قابل‌تنظیم)، شامل زمان، IP، عمل، هدف، نتیجه، requestId (هرگز رمز). چرخش فایل ساده (اندازه‌ی سقف).
- مسیرهای ادمین `@NoTenant` هستند. توکن ادمین هرگز برای مسیر tenant معتبر نیست (یادداشت برای S1.6).

### ۲. عملیات (سرویس `DatabaseManagerService` + پردازنده‌های Worker)

**فهرست:** `GET /v1/admin/databases`: برای هر دیتابیس `slug`، `name`، `companyName`، `schemaVersion` (آخرین مایگریشن کامل)، `pendingMigrations`، `sizeBytes`، `lastBackup`، `state` (`active|maintenance|failed`)، `domain`. دیتابیس‌های `erp_tmp_*` و غیر-bodo در فهرست نیایند.

**ساخت (`POST /databases`):** `{ name, adminUsername, adminFullName, adminPassword }`. طبق بند ۲.۴ مستند:

1. اعتبارسنجی: slug، یکتایی، نام کاربری (حروف کوچک، الگوی مجاز)، سیاست رمز (حداقل ۱۰ کاراکتر، رد رمزهای رایج با فهرست کوچک داخلی)
2. `CREATE DATABASE erp_tmp_<id> OWNER erp_migrator` با `erp_provisioner`
3. مایگریشن (MigrationRunner با نام صریح؛ نباید به `assertUsable` وابسته باشد)
4. `seedBaseline`
5. ساخت کاربر مدیر: هش argon2id (سرویس `PasswordHasher` مشترک در `common`؛ در S1.6 هم استفاده می‌شود)، عضویت در گروه «مدیر سیستم»، `mustChangePassword=false`، یک رکورد `audit_logs` با `source=SYSTEM`
6. ساخت پوشه‌ی filestore (`filestorePath`)
7. بستن همه‌ی کلاینت‌های موقت، سپس `ALTER DATABASE ... RENAME TO erp_<slug>`
8. پاک‌کردن کش registry و اعلام آماده
   در **هر** خطا: حذف دیتابیس موقت و پوشه‌ی filestore؛ دیتابیس ناقص هرگز در فهرست یا registry دیده نشود. رمز مدیر هرگز لاگ نشود. تکرار همان نام ← ۴۰۹؛ دو ساخت هم‌زمان همان نام ← فقط یکی موفق.

**کپی (`POST /databases/:name/duplicate`):** `{ newName, neutralize }`. مبدأ در دسترس می‌ماند (بدون Maintenance). `pg_dump -Fc` از مبدأ ← ساخت دیتابیس موقت ← `pg_restore` با `erp_migrator` (**ACLها حفظ شوند** تا `erp_app` دسترسی DML داشته باشد؛ نه `--no-privileges`) ← کپی filestore ← در صورت `neutralize` ثبت `system_settings.neutralized=true` ← بررسی شمارش ردیف جدول‌های اصلی ← rename. خطا ← پاک‌سازی کامل.

**بکاپ (`POST /databases/:name/backups`):** فایل zip در `BACKUP_DIR/<db>/<timestamp>.zip` شامل `dump.pgdump`، پوشه‌ی `filestore/` و `manifest.json` (`db_name`, `schema_version`، فهرست مایگریشن‌های اعمال‌شده، `app_version`, `created_at`، `sha256` هر بخش). zip64 برای حجم بالا؛ استریمی. دانلود با `Content-Disposition` درست و پشتیبانی از Range اختیاری. فهرست و حذف بکاپ.

**بازیابی (`POST /databases/restore`):** multipart `{ file, newName, neutralize }`:

- اعتبارسنجی zip **ضد Zip Slip** (هر مسیر خارج از پوشه‌ی هدف، مسیر مطلق و symlink رد شود)، سقف تعداد/حجم اعضا (ضد zip bomb)، تایید `sha256`
- سازگاری: فهرست مایگریشن‌های بکاپ باید **پیشوند** فهرست برنامه باشد؛ اگر مایگریشن ناشناخته دارد ← خطای واضح و بدون هیچ تغییر؛ اگر قدیمی‌تر است ← بعد از بازیابی مایگریشن‌های باقی‌مانده اجرا شود
- نام موجود ← ۴۰۹ (بازنویسی فقط با حذف صریح قبلی)
- ساخت موقت ← `pg_restore` ← filestore ← مایگریشن ← neutralize اختیاری ← rename. خطا ← پاک‌سازی.

**حذف (`DELETE /databases/:name`):** `{ confirmName }` باید دقیقاً نام کامل باشد. ترتیب: بکاپ خودکار (شکست آن ← **عملیات متوقف و هیچ‌چیز حذف نمی‌شود**) ← Maintenance ← evict بین پردازه‌ای ← تخلیه ← `pg_terminate_backend` ← `DROP DATABASE` ← حذف filestore ← حذف نگاشت دامنه ← پاک‌کردن پرچم‌ها. بکاپ پیش از حذف در `BACKUP_DIR` می‌ماند.

**ارتقا و ترمیم:**

- `POST /databases/:name/upgrade` (و `upgradeAll` از طریق job)
- `POST /databases/:name/repair` `{ confirm, migration }`: وقتی `prisma migrate deploy` شکست می‌خورد، Prisma آن مایگریشن را «ناموفق» ثبت می‌کند و ارتقای بعدی را (P3009) رد می‌کند؛ **بدون ترمیم، Maintenance بن‌بست است.** این endpoint فقط برای مایگریشنی که `finished_at IS NULL AND rolled_back_at IS NULL` است `prisma migrate resolve --rolled-back` را اجرا می‌کند (با `erp_migrator`)، در لاگ ممیزی ثبت می‌شود، و Maintenance را خودکار برنمی‌دارد؛ بعد از آن مدیر `upgrade` را دوباره اجرا می‌کند.
- `POST /databases/:name/maintenance` `{ enabled, reason }` برای روشن/خاموش‌کردن دستی (با تایید برای خاموش‌کردن وقتی دلیل `migration_failed` است).

**دامنه:** `PUT /databases/:name/domain` `{ host | null }`: hostname معتبر (بدون wildcard، بدون IP، حروف کوچک)، یکتا بین همه‌ی دیتابیس‌ها، نوشتن اتمیک `domains.json`.

**Jobs:** `GET /jobs/:id` و `GET /jobs`: `status`، `step`، `percent`، `message` فارسی، `error` ({code, message} بدون راز)، زمان‌ها. progress یکنواخت (فقط افزایشی). نگهداری ۱۰۰ job یا ۷ روز.

**عمومی:** `GET /v1/public/databases` فقط وقتی `DB_LIST_PUBLIC=true` (وگرنه ۴۰۴؛ فقط slug)، و `GET /v1/public/tenant-by-host` (خروجی `{ database: slug | null }` بر اساس `domains.json`)؛ هر دو rate-limit شوند و تنها slug (بدون نام شرکت) برگردانند.

### ۳. تغییرات زیرساخت

- **nginx:** `client_max_body_size` بزرگ فقط برای `location /v1/admin/databases/restore`، timeout بالا برای مسیرهای ادمین، ارسال `X-Real-IP`/`X-Forwarded-For` (مبنای IP allowlist)، و **حذف هدرهای امنیتی تکراری** روی مسیرهای proxy‌شده‌ی API (در پاسخ‌های فعلی `X-Frame-Options`, `Referrer-Policy` و CSP هم از helmet و هم از nginx می‌آیند و دو مقدار متناقض دارند؛ فقط یک منبع باقی بماند).
- **Compose:** worker و api هر دو volumeهای `config`، `filestore`، `backups` را mount کنند؛ worker متغیرهای نقش‌های provisioner/migrator/app و ابزارهای pg را داشته باشد؛ بررسی کن image نسخه‌ی ۱۶ ابزارها را دارد.
- **متغیرها (`.env.example`، zod، تست):** `DB_MANAGER_ENABLED`، `DB_MANAGER_ALLOWED_IPS`، `DB_LIST_PUBLIC`، `BACKUP_DIR`، `MAX_RESTORE_UPLOAD_MB`، `PG_BIN_PATH`، `PG_TOOLS_DRIVER`، `PG_DOCKER_CONTAINER`، `ADMIN_JWT_SECRET` (اختیاری)، `CLEAN_ORPHANS`.
- **قرارداد:** همه‌ی ورودی/خروجی‌ها شِمای zod در `packages/contracts`، کدهای خطای لازم (`CONFLICT`، `RATE_LIMITED` و ...).

### ۴. Worker heartbeat

Worker هر ۱۰ ثانیه کلید `worker:heartbeat` را با TTL ۳۰ ثانیه می‌نویسد؛ `/health/ready` فیلد `worker: up|down` را برمی‌گرداند. قطع worker فقط عملیات مدیریتی را مختل می‌کند، پس وضعیت کلی `ready` را قرمز نکند ولی در پاسخ دیده شود. (در گزارش و ADR-0002 اصلاح کن.)

### ۵. CLI موقت (تا UI در S1.12)

- `pnpm db:manager <دستور>`: `list`، `create`، `duplicate`، `backup`، `backups`، `download`، `restore`، `delete`، `upgrade`، `repair`، `domain`، `jobs`، `watch <jobId>` (نمایش پیشرفت زنده). رمز Master با پرسش مخفی (readline بدون echo) یا env برای اسکریپت‌ها؛ هرگز در history یا لاگ.
- `db-manager.bat` (کنار بقیه‌ی bat ها، ریشه و `scripts/windows/`): منوی تعاریف ساده برای فهرست/ساخت/بکاپ/حذف.
- README: راهنمای کامل با نمونه‌های PowerShell.

### ۶. نظافت‌های موروثی از S1.3 (جدا کامیت شوند)

1. `start.bat` فقط `live` را می‌سنجد؛ باید `/health/ready` را بسنجد و اگر `status` غیر `ok` بود صریحاً بنویسد «سیستم بالا آمد ولی آماده نیست» با بخش خراب (مثلاً postgres) و راهنما، نه «running successfully». همین رفتار در `status.bat`.
2. دستورهای Compose در README و لانچرها با `--env-file .env` (یا مسیر درست) نوشته شوند؛ `ps/down/logs` بدون متغیرهای اجباری شکست نخورند (راه‌حل مناسب را انتخاب و مستند کن؛ مثلاً env-file ثابت در همه‌ی دستورها).
3. `MaintenanceService.set()` در حالت P2021 (جدول `system_settings` هنوز نیست): پرچم Redis همچنان **باید** ثبت شود، و یک هشدار صریح لاگ شود که ثبت پایدار انجام نشد. توضیح بده این مورد فقط برای دیتابیس‌های خام/در حال ساخت رخ می‌دهد.
4. تضمین کن گارد `DevOnly` **قبل** از resolve شدن tenant اجرا می‌شود تا `/v1/dev/*` در production همیشه ۴۰۴ بدهد (حتی وقتی دیتابیس خراب است؛ در اجرای قبلی من ۵۰۰ دیدم).

---

## تست‌ها (الزامی؛ Postgres و Redis واقعی، هر دو راننده‌ی PgTools)

**امنیت و دسترسی**

1. بوت: ساخت `master.json` از env؛ بوت بعدی بدون env؛ هش نه متن ساده.
2. login: رمز غلط، قفل بعد از ۵ تلاش، انقضا، `pv` بعد از تغییر رمز (توکن قدیمی رد شود)، توکن ادمین روی مسیر عادی رد شود.
3. `DB_MANAGER_ENABLED=false` ← ۴۰۴؛ IP allowlist (IP و CIDR)؛ جعل `X-Forwarded-For` از بیرون بی‌اثر.
4. تزریق: نام‌هایی مثل `a; drop database x`، `$(whoami)`، بک‌تیک و فاصله ← رد؛ رمز مدیر حاوی `' " @ : / \ ;`، فاصله و یونیکد ← ساخت موفق و ورود درست (هش)، و لاگ‌ها (از جمله خروجی job و لاگ ممیزی) هرگز رمز را ندارند (assert روی متن لاگ‌ها).

**ساخت** 5. مسیر موفق: دیتابیس نهایی با `X-Database` پاسخ می‌دهد، کاربر مدیر با هش argon2id و عضویت گروه، seed، filestore. 6. تزریق خطا در هر مرحله (مایگریشن، seed، کاربر، rename) ← هیچ `erp_tmp_*`، هیچ پوشه، و فهرست بدون ردیف اضافه. 7. نام تکراری ۴۰۹؛ دو ساخت هم‌زمان ← یکی موفق.

**کپی و بکاپ و بازیابی** 8. کپی: شمارش‌ها و یک ردیف نشانه برابر؛ استقلال (تغییر در کپی در مبدأ نیست)؛ ACL حفظ شده (`erp_app` DML بله، DDL نه)؛ افزونه‌ها؛ `neutralize`؛ filestore؛ مبدأ **هم‌زمان** به درخواست‌ها پاسخ می‌دهد. 9. بکاپ: محتوای zip، `manifest`، `sha256`؛ بازیابی روی نام جدید ← شمارش، ردیف نشانه و هش فایل‌های filestore برابر. 10. بازیابی بکاپ قدیمی‌تر (با مایگریشن آزمایشی) ← مایگریشن می‌شود؛ بکاپ با مایگریشن ناشناخته ← رد و **هیچ تغییری**؛ checksum خراب ← رد؛ **zip slip** ← رد؛ آپلود بزرگ‌تر از سقف ← رد؛ نام موجود ← ۴۰۹.

**حذف و ارتقا** 11. `confirmName` اشتباه ← رد؛ شکست بکاپ ← حذف انجام نمی‌شود و Maintenance برمی‌گردد؛ حذف موفق ← بکاپ موجود، DB و filestore و دامنه رفته؛ با یک کلاینت دارای lease فعال در پردازه‌ی دیگر، `DROP` معطل نمی‌ماند و درخواست‌های بعدی ۴۰۴/۵۰۳ می‌گیرند. 12. ارتقای خراب ← Maintenance؛ `repair` سپس `upgrade` ← سالم؛ خاموش‌کردن Maintenance با دلیل `migration_failed` بدون تایید ← رد. 13. pub/sub: دو `TenantClientManager` مستقل؛ publish evict یکی را تخلیه می‌کند.

**Jobs و زیرساخت** 14. progress یکنواخت؛ خطا بدون راز؛ قفل هر دیتابیس (عملیات دوم ← ۴۰۹)؛ سقف هم‌زمانی ۲. 15. فضای دیسک ناکافی (mock `statfs`) ← رد قبل از شروع. 16. دامنه: تنظیم/حذف، تکراری ← رد، و `HostResolver` بعد از تنظیم همان را می‌یابد (بدون ری‌استارت). 17. endpointهای عمومی: پرچم `DB_LIST_PUBLIC`؛ فقط slug. 18. heartbeat: قطع worker ← `worker: down` در `/health/ready`. 19. CLI: smoke test برای `list`، `create` و `watch`.

**CI:** همه‌ی تست‌ها با راننده‌ی `local` (نصب `postgresql-client-16`). روی ماشین ویندوز من با راننده‌ی `docker`.

---

## معیار پذیرش S1.4

- [ ] ساخت دیتابیس با یک دستور CLI، بدون هیچ ورودی اطلاعات شرکت؛ نتیجه با `X-Database` قابل‌استفاده
- [ ] خطا در هر مرحله هیچ دیتابیس، پوشه یا فایل موقتی باقی نمی‌گذارد (تست ۶)
- [ ] کپی، بکاپ و بازیابی با برابری شمارش/هش و ACL (تست ۸ تا ۱۰)
- [ ] حذف با بکاپ خودکار؛ شکست بکاپ از حذف جلوگیری می‌کند؛ بدون معطلی روی اتصال‌های باز (تست ۱۱)
- [ ] Zip Slip، zip bomb، تزریق نام و رمز در لاگ‌ها پوشش داده شده‌اند
- [ ] ارتقای خراب قابل‌ترمیم است (Maintenance بن‌بست نیست)
- [ ] هر دو راننده‌ی PgTools روی ماشین ویندوز من (docker) و در CI (local) سبزند
- [ ] دو مورد از نظافت: `start.bat` روی `ready` می‌سنجد و `DevOnly` قبل از tenant اجرا می‌شود (تست دستی با خروجی)
- [ ] nginx بدون هدر امنیتی تکراری و با سقف آپلود فقط برای restore
- [ ] heartbeat worker در `/health/ready`
- [ ] ADR-0005 (Master، jobs روی worker، PgTools، evict بین پردازه‌ای، فرمت بکاپ، سازگاری بازیابی، معنای حذف) و ADR-0002 به‌روز؛ مستند فنی طبق «اصلاحات مستند»
- [ ] `start.bat`، `stop.bat`، `status.bat`، `dev-start.bat`، `dev-stop.bat`، `db-setup.bat` و `db-manager.bat` روی ماشین ویندوز **واقعاً** اجرا شده‌اند و خروجی در گزارش آمده است
- [ ] CI سبز؛ هیچ رازی commit نشده

## در این گام ممنوع است

UI (صفحه‌ی Database Manager در S1.12)، احراز هویت و JWT کاربران tenant (S1.6)، زمان‌بندی بکاپ شبانه (S1.14)، تغییر نام دیتابیس موجود، مدیریت چندسروری، و شروع S1.5.

## پایان گام

گزارش با قالب بند ۱۱ `rules.md`: خروجی واقعی روی ماشین ویندوز برای هر دو راننده‌ی `PgTools`؛ یک سناریوی کامل واقعی با CLI (ساخت ← بکاپ ← کپی ← حذف ← بازیابی) با خروجی‌ها؛ لینک PR و CI؛ و صراحتاً هر چیزی که اجرا نشد. بعد از گزارش منتظر تایید من بمان.
