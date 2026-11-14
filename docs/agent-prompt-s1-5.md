# دستورالعمل گام S1.5 — زیرساخت API

> مسیر در پروژه: `docs/agent-prompt-s1-5.md`
> شاخه: `step/s1-5-api-infrastructure`
> مرجع: `docs/stage-1-technical-spec.md` بخش‌های ۳.۴، ۸.۱، ۸.۲ و ۹؛ `docs/rules.md` بند ۳، ۵، ۸، ۹؛ ADR-0004 و ADR-0005.
> این گام هیچ قابلیت کاربری جدیدی نمی‌سازد؛ **ریل‌هایی** می‌سازد که همه‌ی ماژول‌های بعدی (احراز هویت، کاربران، مخاطبین، فروش) روی آن‌ها سوار می‌شوند. هر ضعف اینجا در همه‌ی ماژول‌ها تکرار می‌شود، پس هر بخش با تست جدی بسته شود.

---

## هدف

یکپارچه‌کردن اعتبارسنجی ورودی/خروجی، OpenAPI، نگاشت خطا، صفحه‌بندی cursor، تراکنش، Idempotency، قفل خوش‌بینانه، Rate Limit، سریالایزر، لاگ و زمینه‌ی درخواست؛ به‌علاوه‌ی قالب ماژول و گارد معماری. بعد از این گام هیچ ماژولی نباید برای این کارها کد اختصاصی بنویسد.

---

## تصمیم‌های طراحی (قفل‌شده)

1. **اعتبارسنجی فقط با Pipe سراسری.** هیچ controller نباید `Schema.parse(...)` صدا بزند. (ریشه‌ی باگ ۵۰۰ رمز ضعیف در S1.4 همین بود.) شِماها فقط از `packages/contracts` می‌آیند.
2. **۵۰۰ فقط برای خطای واقعی برنامه.** هر خطای ورودی، دامنه یا وابستگی قابل‌پیش‌بینی باید ۴xx با قالب استاندارد باشد.
3. **هیچ پیام داخلی (Prisma، SQL، stack، مسیر فایل) هرگز به کلاینت نمی‌رسد.** فقط `code` و پیام فارسی از کاتالوگ.
4. **Cursor امضاشده و مات** (opaque)؛ کلاینت نمی‌تواند آن را بسازد یا دستکاری کند.
5. **تراکنش از طریق ALS:** `TenantPrisma.client` داخل تراکنش خودکار همان `tx` را برمی‌گرداند؛ ریپازیتوری‌ها هیچ تفاوتی حس نمی‌کنند.
6. **Idempotency و Rate Limit روی Redis با کلید tenant-aware** (`tenantKey`)؛ ثبت‌نشدن پاسخ‌های ۵xx تا کلاینت بتواند دوباره تلاش کند.
7. **وابستگی جدید فقط با ADR:** `nestjs-zod`، `@nestjs/swagger`، یک ابزار بررسی مرز ماژول‌ها (`dependency-cruiser` یا `eslint-plugin-boundaries`). سازگاری نسخه‌ی `zod` با `nestjs-zod` را بررسی و در ADR-0006 بنویس.

---

## خروجی‌های لازم

### ۱. اعتبارسنجی و قرارداد

- `ZodValidationPipe` سراسری (از `nestjs-zod`) و DTOها با `createZodDto(schema)` از `contracts`.
- مهاجرت **همه‌ی endpointهای موجود** (ادمین و dev و health) به همین الگو؛ حذف هر `.parse` دستی.
- JSON خراب (malformed) ← ۴۰۰ `VALIDATION_FAILED`؛ `Content-Type` نامناسب ← ۴۱۵؛ بدنه‌ی بزرگ‌تر از سقف ← ۴۱۳ `PAYLOAD_TOO_LARGE`؛ فیلد اضافی در بدنه ← رد (strict) مگر در شِما صریحاً مجاز باشد.
- **اعتبارسنجی خروجی:** رهگیر (interceptor) که در `NODE_ENV !== production` (و همیشه در تست‌ها) پاسخ را با شِمای پاسخ endpoint (متادیتای دکوراتور) اعتبارسنجی و فیلدهای اضافی را حذف می‌کند؛ ناهمخوانی ← در dev/test خطا. هدف: نشت‌نکردن فیلد داخلی و همگام ماندن قرارداد.

### ۲. OpenAPI

- `@nestjs/swagger` + `nestjs-zod`؛ مسیر `/docs` فقط وقتی `OPENAPI_ENABLED=true` (پیش‌فرض: dev و test روشن، production خاموش، و در nginx هم برای production مسدود).
- طرح امنیتی `bearer` (آماده‌ی S1.6)، تگ هر ماژول، نمونه‌ی خطاهای استاندارد.
- `pnpm openapi:export` فایل `openapi.json` را در `apps/api/dist` یا مسیر مشخص بسازد (commit نشود)؛ CI این را اجرا و خروجی معتبر OpenAPI 3 را بررسی کند و به‌عنوان artifact بگذارد.

### ۳. نگاشت خطا (کامل)

در `GlobalExceptionFilter` (یا یک `ErrorMapper` جدا):

- `ZodError`، خطای validation pipe ← ۴۰۰ + `details: [{path, message}]` فارسی
- Prisma `P2002` (یکتایی) ← ۴۰۹ `CONFLICT` با نام فیلدها (نه مقادیر)؛ `P2025` ← ۴۰۴؛ `P2003`/`P2014` ← ۴۰۹؛ `P2034` (تعارض تراکنش) ← ۴۰۹ قابل‌تلاش؛ خطای اتصال/timeout دیتابیس ← ۵۰۳ (نه ۵۰۰) با `Retry-After`
- `VersionConflictError` ← ۴۰۹ `VERSION_CONFLICT`؛ `RateLimitedError` ← ۴۲۹ + `Retry-After`؛ `IdempotencyKeyReusedError` ← ۴۲۲
- خطای ناشناخته ← ۵۰۰ `INTERNAL`، پیام ثابت، لاگ کامل با stack و `requestId`
- کدهای جدید در `packages/contracts` (با تست): `PAYLOAD_TOO_LARGE`، `UNSUPPORTED_MEDIA_TYPE`، `IDEMPOTENCY_KEY_REUSED`، و هر کد دیگری که لازم شد. تست ساختاری: هر `code`ی که در `apps/api` استفاده می‌شود در enum قرارداد وجود دارد.
- تست «نشت پیام»: یک خطای Prisma ساختگی که متنش SQL و نام جدول دارد ← بدنه‌ی پاسخ هیچ‌کدام را ندارد.

### ۴. Pagination، فیلتر، مرتب‌سازی، جستجو

- `contracts`: `PaginationQuerySchema` (`limit` ۱ تا ۲۰۰ با پیش‌فرض ۵۰، `cursor`، `sort`، `withTotal`)، تابع `paginated(itemSchema)`، و پاسخ `{ items, nextCursor, total? }`.
- `CursorCodec`: ساختار `{v, k:[...], id}` با base64url و **HMAC** (کلید مشتق‌شده با HKDF از `JWT_SECRET`)؛ cursor نامعتبر یا دستکاری‌شده یا مال sort دیگر ← ۴۰۰ `VALIDATION_FAILED` (جزئیات `cursor`).
- `paginate(delegate, config)` عمومی برای Prisma با **Keyset**: مرتب‌سازی چندفیلدی، جهت جدا برای هر فیلد، tie-breaker نهایی `id`، فیلدهای nullable با قرارداد ثابت `NULLS LAST`، و شرط `where` پیوسته از cursor. هیچ `offset` و `skip`.
- `sort` فقط از **لیست سفید** هر منبع؛ `filter[field]`، `filter[field][in|gte|lte|contains]` از لیست سفید و با نوع‌بندی zod؛ `q` با `search.fields` (فعلاً `contains` بی‌حساس؛ نرمال‌سازی فارسی و `pg_trgm` در S1.10 و بعد). ایندکس لازم را در توضیح هر منبع بنویس.
- `withTotal` فقط با درخواست صریح (`count` گران است).

### ۵. تراکنش

- `TenantTransactionService.run(fn, { timeoutMs = 15000, maxWaitMs = 5000, isolationLevel?, retryable? })`.
- `TenantPrisma.client` داخل تراکنش، `tx` را برمی‌گرداند؛ تو‌در‌تو (nested) بدون savepoint به همان تراکنش می‌پیوندد؛ `runInNewTransaction` صریح برای حالت استثنا.
- `afterCommit(fn)`: صف کارهایی که فقط بعد از commit موفق اجرا می‌شوند و در rollback دور ریخته می‌شوند (برای انتشار رویداد/Outbox و ابطال کش در گام‌های بعد).
- Retry محدود (حداکثر ۳، با jitter) فقط وقتی `retryable: true` و خطا از نوع serialization/deadlock (`40001`، `40P01`، `P2034`) باشد.
- تراکنش هرگز lease کلاینت را زودتر آزاد نکند.

### ۶. Idempotency

- دکوراتور `@Idempotent()` برای POSTهای حساس و هدر `Idempotency-Key` (۸ تا ۱۲۸ کاراکتر).
- کلید Redis: `tenantKey(db, 'idem', scope, key)` که scope = کاربر (یا IP برای ناشناس) + متد + مسیر الگو. وضعیت `in_progress` (قفل با TTL ۶۰ ثانیه) و `completed` (status، بدنه، هدرهای مجاز) با TTL ۲۴ ساعت.
- همان کلید و همان بدنه (hash کانونی) ← بازپخش پاسخ با هدر `Idempotency-Replayed: true`؛ همان کلید و بدنه‌ی متفاوت ← ۴۲۲؛ هم‌زمان `in_progress` ← ۴۰۹ با `Retry-After`؛ پاسخ ۵xx ثبت نمی‌شود.

### ۷. قفل خوش‌بینانه

- `updateWithVersion(delegate, id, expectedVersion, data)` (و `deleteWithVersion`): `updateMany where {id, version}` با `version: { increment: 1 }`؛ اگر هیچ ردیفی تغییر نکرد ← `VersionConflictError`. قرارداد: بدنه‌ی به‌روزرسانی `version` را می‌گیرد؛ پاسخ GET هدر `ETag` دارد و `If-Match` هم پذیرفته می‌شود.

### ۸. Rate Limit مشترک

- `RateLimitService.consume(key, { limit, windowSec, blockSec? })` با Lua اتمیک در Redis؛ خروجی `{ allowed, remaining, retryAfterSec }`.
- دکوراتور `@RateLimit({...})` با کلید پیش‌فرض tenant + IP و امکان تابع کلید دلخواه (در S1.6 برای `db + username`)؛ هدرهای `RateLimit-Limit`، `RateLimit-Remaining`، `RateLimit-Reset` و `Retry-After`.
- سیاست خطای Redis: برای مسیرهای احراز هویت و ادمین **fail-closed**؛ برای بقیه fail-open با لاگ هشدار (قابل‌تنظیم هر مسیر).
- `AdminRateLimitService` فعلی به همین سرویس منتقل شود (بدون تغییر رفتار؛ تست‌های S1.4 همچنان سبز).

### ۹. سریالایزر

- رهگیر سراسری: `BigInt` ← رشته، `Prisma.Decimal` ← رشته‌ی decimal، `Date` ← ISO-8601 UTC با `Z`، `undefined` حذف.
- کمک‌تست `expectNoSecrets(body)` که کلیدهای ممنوع (`passwordHash`، `refreshTokenHash`، `password`، `secret`، `token` به‌جز فیلد صریح توکن پاسخ login در آینده) را در هر عمق بررسی کند؛ در تست‌های HTTP استفاده شود.

### ۱۰. لاگ و زمینه‌ی درخواست

- پیکربندی مرکزی **redact** در pino برای `authorization`، `cookie`، `set-cookie`، `x-master-password`، هر کلیدی با الگوی `pass|secret|token|key` (بی‌حساس، در هر عمق و آرایه)، و الگوی کد ملی ۱۰ رقمی/شماره‌ی کارت در مقادیر رشته‌ای.
- یک خط لاگ درخواست در پایان پاسخ: متد، **الگوی مسیر** (نه مقادیر پارامتر حساس)، status، مدت، `db`، `userId` (اگر هست)، `requestId`، IP، `userAgent` (کوتاه‌شده). مسیرهای health در سطح debug. بدنه‌ی درخواست هرگز لاگ نشود.
- `RequestContext` (روی `TenantContext`/ALS): `requestId`، `ip`، `userAgent`، `userId?`، `userType?`، `source` (`UI|API|IMPORT|SYSTEM`؛ از هدر `X-Client`: `web` و `mobile` ← `UI`، پیش‌فرض ← `API`، Worker ← `SYSTEM`). تابع `getRequestMeta()` برای Audit در S1.9.

### ۱۱. قالب ماژول و گارد معماری

- `apps/api/src/modules/_template/` طبق بند ۹ مستند فنی (controller، service، repository، events، permissions، dto، تست) و `pnpm gen:module <name>`.
- گارد مرز ماژول‌ها (تصمیم ۷): ماژول A فقط می‌تواند از **API عمومی** (`index.ts`) ماژول B import کند، نه از repository یا فایل داخلی آن. اجرا در CI. تخلف‌های موجود را رفع کن (در ADR بنویس اگر ساختار فعلی `database-manager` نیاز به اصلاح داشت).
- تست‌های ساختاری: هیچ `Schema.parse(` در controller؛ هیچ `console.log` در `src/` (به‌جز استثنای مستند env بوت)؛ هیچ `new PrismaClient` (از قبل).

### ۳۱. نظافت‌های موروثی از S1.4 (جدا کامیت شوند)

1. خروجی CLI برای job تمام‌شده `[0%] completed:` می‌داد؛ درصد و پیام نهایی درست (۱۰۰٪ و پیام فارسی) نمایش یابد.
2. در CLI برای `duplicate` فلگ `--pass` استفاده شده بود. معنی دقیق هر فلگ و روش دریافت **Master Password** (پرسش مخفی یا `MASTER_PASSWORD`/`ADMIN_PASSWORD`) را در `--help` و README روشن کن و فلگ‌های بی‌معنی را حذف کن.
3. `DB_MANAGER_ALLOWED_IPS`: در `.env.example` فقط مقدار توسعه (شامل gateway داکر) باشد و در Compose اصلی (production) **بدون مقدار پیش‌فرض و اجباری** (`:?required`) تا کسی ناخواسته دامنه‌ی بزرگ را مجاز نگذارد؛ README توضیح بدهد IP کلاینت در Docker Desktop ویندوز با Linux فرق دارد.

---

## تست‌ها (Postgres و Redis واقعی؛ یک `createTestApp()` مشترک)

**اعتبارسنجی و خطا**

1. جدول‌محور برای همه‌ی endpointها: JSON خراب، `Content-Type` غلط، بدنه‌ی بزرگ، فیلد اضافی، نوع غلط، رشته‌ی خیلی بلند، یونیکد، `null` ← هیچ ۵۰۰.
2. اعتبارسنجی خروجی: یک endpoint آزمایشی که فیلد اضافی برمی‌گرداند ← حذف می‌شود/در test شکست.
3. هر کد Prisma (`P2002`، `P2025`، `P2003`، `P2034`) ← وضعیت و `code` درست؛ تست نشت پیام (بند ۳).
4. ساختاری: `.parse(` در controller، `console.log`، کدهای خطای بدون تعریف در contracts، و مرز ماژول‌ها.

**Pagination** (جدول آزمایشی با ۱۰٬۰۰۰ ردیف که فقط در تست ساخته می‌شود) 5. پیمایش کامل صعودی/نزولی/چندفیلدی با مقادیر مساوی زیاد و `null`: بدون تکرار، بدون جاافتادگی، مجموع برابر شمارش. 6. درج ردیف جدید وسط پیمایش: تکرار یا گم‌شدن ردیف قبلی رخ نمی‌دهد. 7. `limit` بیش از سقف ← ۴۰۰ یا کاهش به سقف (یکی را انتخاب و مستند کن)؛ cursor دستکاری‌شده/منقضی/مال sort دیگر ← ۴۰۰؛ `sort` یا `filter` خارج از لیست سفید ← ۴۰۰؛ `withTotal`. 8. `EXPLAIN` یک صفحه‌ی میانی روی ایندکس درست «Index Scan» است (نه Seq Scan).

**تراکنش** 9. commit/rollback؛ nested می‌پیوندد؛ `afterCommit` بعد از موفقیت و به‌ترتیب، و در rollback دور ریخته می‌شود. 10. ۵۰ درخواست هم‌زمان با تراکنش‌های جدا: ALS نشت نمی‌کند و داده‌ی هر تراکنش جداست؛ تراکنش دیتابیس A هرگز B را نمی‌بیند. 11. timeout تراکنش ← قطع و خطای ۵۰۳/۴۰۹ مناسب؛ سناریوی deadlock واقعی (دو تراکنش با ترتیب معکوس) با `retryable` بعد از retry موفق می‌شود؛ بدون `retryable` خطا می‌دهد.

**Idempotency، قفل خوش‌بینانه، Rate Limit** 12. بازپخش، بدنه‌ی متفاوت (۴۲۲)، هم‌زمانی (۴۰۹)، عدم ثبت ۵xx، انقضا، جداسازی بین دو دیتابیس و دو کاربر. 13. `updateWithVersion`: موفق، ناموفق با `VersionConflictError`، و دو به‌روزرسانی هم‌زمان فقط یکی موفق. 14. Rate Limit: ۱۰۰ درخواست هم‌زمان با سقف ۱۰ ← دقیقاً ۱۰ مجاز؛ `Retry-After`؛ fail-closed در قطع Redis برای مسیر ادمین و fail-open برای مسیر عادی؛ تست‌های S1.4 ادمین همچنان سبز.

**سریالایزر، لاگ، OpenAPI** 15. `BigInt`، `Decimal`، `Date`؛ `expectNoSecrets` روی خروجی همه‌ی endpointهای موجود. 16. redact: payload ساختگی تودرتو و آرایه‌ای حاوی رمز/توکن/کد ملی ← در خروجی لاگ نیست؛ لاگ درخواست شامل `db` و `requestId` و بدون بدنه است. 17. `source` از `X-Client`؛ `/docs` در production ← ۴۰۴؛ `openapi:export` معتبر؛ تولید ماژول با `gen:module` کامپایل و تست‌هایش سبز.

**CI:** همه‌ی تست‌ها، خروجی OpenAPI به‌عنوان artifact، و گارد مرز ماژول‌ها. روی ماشین ویندوز من هم اجرا شود.

---

## معیار پذیرش S1.5

- [ ] هیچ endpoint ورودی نامعتبر ۵۰۰ نمی‌دهد (تست ۱) و هیچ پیام داخلی نشت نمی‌کند (تست ۳)
- [ ] هیچ `Schema.parse(` در controller (تست ساختاری)؛ همه‌ی endpointها از Pipe و `contracts` استفاده می‌کنند
- [ ] Pagination: ۱۰ هزار ردیف بدون تکرار و جاافتادگی، cursor امضاشده، ایندکس درست (تست ۵ تا ۸)
- [ ] تراکنش با ALS، `afterCommit`، retry کنترل‌شده و بدون نشت (تست ۹ تا ۱۱)
- [ ] Idempotency، قفل خوش‌بینانه و Rate Limit اتمیک (تست ۱۲ تا ۱۴)
- [ ] سریالایزر، `expectNoSecrets` و redact لاگ (تست ۱۵ و ۱۶)
- [ ] OpenAPI در dev/test فعال و در production بسته؛ export در CI
- [ ] `gen:module` و گارد مرز ماژول‌ها در CI
- [ ] ADR-0006 (کتابخانه‌ها و نسخه‌ها، قرارداد cursor، سیاست خطای Rate Limit، تراکنش و ALS، Idempotency، مرز ماژول‌ها)
- [ ] نظافت‌های ۳۱-۱ تا ۳۱-۳ انجام و تست شده
- [ ] `start.bat`، `stop.bat`، `status.bat`، `dev-start.bat`، `dev-stop.bat`، `db-setup.bat` و `db-manager.bat` روی ماشین ویندوز **واقعاً** اجرا شده‌اند (سرویس جدیدی اضافه نشده؛ تایید کن) و خروجی در گزارش آمده است
- [ ] CI سبز؛ لینک اجرای سبز **همان PR** (هر چهار job) در گزارش

## در این گام ممنوع است

احراز هویت و JWT و کاربر (S1.6)، Audit و Outbox و Timeline (S1.9)، صفحات UI، Record Ruleها، مجوزها و گروه‌ها، و شروع S1.6. شِمای دیتابیس تغییر نکند (جدول‌های آزمایشی فقط داخل تست و با تمیزکاری).

## پایان گام

گزارش با قالب بند ۱۱ `rules.md`: خروجی واقعی jest با `--verbose` (نام تک‌تک تست‌ها)، لینک PR واقعی، لینک اجرای CI سبز همان PR، و صراحتاً هر چیزی که اجرا نشد. بعد از گزارش منتظر تایید من بمان.
