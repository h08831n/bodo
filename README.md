# سامانه bodo (ERP بازرگانی آهن‌آلات)

> **bodo** یک سامانه‌ی جامع، سریع و سبک ERP برای مدیریت تخصصی بازرگانی آهن‌آلات است که با NestJS، React و PostgreSQL در قالب یک مونوریپوی ساخت‌یافته (pnpm + Turborepo) پیاده‌سازی شده است.  
> اصل کلیدی معماری سیستم: **هر شرکت یک پایگاه‌داده‌ی کاملاً مستقل (Multi-Tenancy بدون `company_id` و بدون RLS)**.

---

## ۱. پیش‌نیازها

پیش از راه‌اندازی، مطمئن شوید نرم‌افزارهای زیر روی سیستم (ویندوز) نصب هستند:

- **Node.js**: نسخه ۲۴ LTS (نسخه ۲۴.۱۲ به بالا)
- **Docker Desktop**: فعال و در حال اجرا (برای کانتینرهای PostgreSQL و Redis)
- **PowerShell**: نسخه ۵ به بالا یا PowerShell 7 (pwsh)

---

## ۲. راه‌اندازی و فعال‌سازی ابزارها (PowerShell)

### ۲.۱. فعال‌سازی مدیر بسته (pnpm)

سیستم از `pnpm` استفاده می‌کند. برای فعال‌سازی آن با `corepack` در PowerShell:

```powershell
corepack enable pnpm
```

> **نکته در صورت خطای دسترسی ادمین در ویندوز:**  
> اگر اجرای دستور فوق به دلیل دسترسی ناموفق بود، می‌توانید PowerShell را به‌صورت Administrator باز کرده و دستور زیر را اجرا کنید، یا pnpm را مستقیماً نصب نمایید:
>
> ```powershell
> npm install -g pnpm
> ```

### ۲.۲. آماده‌سازی فایل متغیرهای محیطی

یک کپی از فایل نمونه پیکربندی بسازید:

```powershell
Copy-Item .env.example .env
```

### ۲.۳. نصب وابستگی‌های مونوریپو

در ریشه‌ی پروژه دستور زیر را اجرا کنید:

```powershell
pnpm install
```

---

## ۳. اجرای پروژه در محیط توسعه (Dev Mode)

برای توسعه محلی، پیشنهاد می‌شود پایگاه‌داده و ردیس را با داکر بالا آورده و برنامه‌های `api` و `web` را روی ماشین محلی اجرا کنید:

### ۳.۱. اجرای سرویس‌های پایه (PostgreSQL و Redis)

```powershell
docker compose -f infra/docker-compose.dev.yml up -d
```

### ۳.۲. اجرای هم‌زمان تمام اپلیکیشن‌ها (API + Web)

```powershell
pnpm dev
```

- **برنامه تحت وب (فرانت‌اند):** `http://localhost:5173`
- **سرویس API (بک‌اند):** `http://localhost:3000`
- **بررسی سلامت سیستم (Live):** `http://localhost:3000/health/live`
- **بررسی اتصال دیتابیس و ردیس (Ready):** `http://localhost:3000/health/ready`

### ۳.۳. اجرای Storybook (محیط ایزوله کامپوننت‌های UI)

```powershell
pnpm --filter @bodo/ui storybook
```

- آدرس Storybook: `http://localhost:6006`

---

## ۴. اجرای آزمون‌ها و بررسی کیفیت کد

تمام فرامین زیر در ریشه پروژه قابل اجرا هستند:

```powershell
# بررسی خطاهای تایپ‌اسکریپت در تمام بسته‌ها
pnpm typecheck

# بررسی و اصلاح خودکار استایل کد (Lint)
pnpm lint

# اجرای کلیه تست‌های واحد و یکپارچگی (Jest برای API و Vitest برای Web/Packages)
pnpm test

# بیلد کامل تمام بسته‌ها و برنامه‌ها
pnpm build

# فرمت‌بندی کدها با Prettier
pnpm format
```

---

## ۵. اجرای کامل با Docker Compose (مشابه محیط تولید)

برای اجرای تمامی سرویس‌ها (Postgres، Redis، API، Worker و Web/Nginx) در قالب کانتینر:

```powershell
docker compose -f infra/docker-compose.yml up --build -d
```

### بررسی وضعیت کانتینرها و سلامت:

```powershell
docker compose -f infra/docker-compose.yml ps
```

- سامانه وب از طریق پورت ۸۰: `http://localhost`
- اندپوینت‌های API از طریق Reverse Proxy Nginx: `http://localhost/health/live` و `http://localhost/health/ready`

برای خاموش کردن سرویس‌ها:

```powershell
docker compose -f infra/docker-compose.yml down
```

---

## ۶. ساختار مونوریپو

```
.
├── apps/
│   ├── api/            # بک‌اند NestJS (اندپوینت‌های سلامت، مانیتورینگ، لاگر pino)
│   └── web/            # فرانت‌اند React + Vite (RTL، فونت وزیرمتن خودمیزبان، Tailwind)
├── packages/
│   ├── contracts/      # شِماهای اعتبارسنجی Zod و قراردادهای API
│   ├── ui/             # کتابخانه‌ی کامپوننت‌های رابط کاربری + Storybook
│   └── utils/          # توابع کمکی مشترک
├── docs/               # مستندات فنی، قوانین و سوابق تصمیمات معماری (ADRs)
└── infra/              # پیکربندی Docker Compose، Nginx و اسکریپت‌های آغازین دیتابیس
```
