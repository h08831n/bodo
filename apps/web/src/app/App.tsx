import React, { useState, useEffect } from 'react';
import { SamplePlaceholder } from '@bodo/ui';
import { Moon, Sun, CheckCircle2, ShieldCheck, Database, Layers } from 'lucide-react';

export function App() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  return (
    <div className="min-h-screen flex flex-col justify-between p-4 sm:p-8">
      <header className="flex justify-between items-center border-b border-slate-200 dark:border-slate-800 pb-4 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-xl shadow-md">
            ب
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">bodo ERP</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              سامانه یکپارچه مدیریت بازرگانی آهن‌آلات
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsDark(!isDark)}
          className="p-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          aria-label="تغییر تم"
        >
          {isDark ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5" />}
        </button>
      </header>

      <main className="max-w-4xl mx-auto w-full space-y-8 flex-1">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 shadow-sm">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold mb-3">
            <CheckCircle2 className="w-5 h-5" />
            <span>اسکلت پروژه با موفقیت راه‌اندازی شد (گام S1.1)</span>
          </div>
          <h2 className="text-2xl font-bold mb-4">به سامانه bodo خوش آمدید</h2>
          <p className="text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
            این برنامه با معماری کاملاً ایزوله «هر شرکت یک دیتابیس مستقل» (Multi-Tenancy بدون
            company_id و بدون RLS)، رابط کاربری کاملاً راست‌چین (RTL)، پشتیبانی آفلاین PWA و فونت
            خودمیزبان وزیرمتن طراحی شده است.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
              <Database className="w-6 h-6 text-blue-600 mb-2" />
              <h3 className="font-semibold text-sm mb-1">دیتابیس مستقل</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                ایزولاسیون کامل داده‌های هر شرکت در PostgreSQL
              </p>
            </div>
            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
              <ShieldCheck className="w-6 h-6 text-indigo-600 mb-2" />
              <h3 className="font-semibold text-sm mb-1">امنیت و مجوزها</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                احراز هویت توکن‌های چرخشی و Record Rules
              </p>
            </div>
            <div className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
              <Layers className="w-6 h-6 text-emerald-600 mb-2" />
              <h3 className="font-semibold text-sm mb-1">سیستم رویدادمحور</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                رویدادهای دامنه‌ای بر بستر الگوی Outbox
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <span className="text-sm text-slate-500">کامپوننت نمونه از packages/ui:</span>
            <SamplePlaceholder label="تست کامپوننت مشترک UI" />
          </div>
        </div>
      </main>

      <footer className="mt-8 border-t border-slate-200 dark:border-slate-800 pt-4 text-center text-xs text-slate-500 dark:text-slate-400">
        نسخه ۰.۱.۰ (گام S1.1 اسکلت، ابزارها و زیرساخت کانتینر)
      </footer>
    </div>
  );
}

export default App;
