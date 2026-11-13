@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Production Launcher (start.bat)
:: ========================================================

title bodo ERP - Production Launcher

:: Navigate to project root reliably
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%..\.."
set "PROJECT_ROOT=%CD%"

call "%SCRIPT_DIR%common.bat"
if %errorlevel% neq 0 (
    echo [ERROR] Pre-flight checks failed.
    echo.
    pause
    exit /b 1
)

:: Check for Docker Compose project name collisions (e.g. old containers created under project "infra")
where node >nul 2>&1
if %errorlevel% equ 0 (
    node "%PROJECT_ROOT%\scripts\check-compose-conflict.mjs" bodo
    if !errorlevel! neq 0 (
        echo.
        pause
        exit /b 1
    )
)

echo.
echo ========================================================
echo  Starting bodo ERP (Production Stack)
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo [INFO] Building and starting containers via Docker Compose...
echo.

docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" up -d --build
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to start Docker Compose services.
    echo.
    pause
    exit /b 1
)

echo.
echo [INFO] Waiting for bodo ERP services to become ready (up to 90s)...

set /a health_sec=0
:health_loop
ping 127.0.0.1 -n 3 >nul

set "HEALTH_STATUS=unreachable"
set "PG_STATUS=down"
set "REDIS_STATUS=down"
set "WORKER_STATUS=down"
set "APP_VERSION=unknown"
set "APP_COMMIT=unknown"

for /f "tokens=1,2,3,4,5,6 delims=|" %%a in ('node -e "fetch('http://localhost/health/ready').then(r=>r.json()).then(d=>console.log([d.status,d.checks?.postgres,d.checks?.redis,d.checks?.worker,d.version,d.commit].join('|'))).catch(()=>console.log('unreachable'))" 2^>nul') do (
    set "HEALTH_STATUS=%%a"
    set "PG_STATUS=%%b"
    set "REDIS_STATUS=%%c"
    set "WORKER_STATUS=%%d"
    set "APP_VERSION=%%e"
    set "APP_COMMIT=%%f"
)

if "!HEALTH_STATUS!"=="ok" (
    echo [INFO] All services are healthy (Postgres: !PG_STATUS!, Redis: !REDIS_STATUS!, Worker: !WORKER_STATUS!).
    echo [INFO] Application Version: !APP_VERSION! (Commit: !APP_COMMIT!)
    goto ready_success
)

if "!HEALTH_STATUS!"=="degraded" (
    echo.
    echo [WARNING] ========================================================
    echo [WARNING] سیستم بالا آمد ولی آماده کامل نیست (وضعیت Degraded).
    echo [WARNING] وضعیت اجزا: Postgres: [!PG_STATUS!], Redis: [!REDIS_STATUS!], Worker: [!WORKER_STATUS!]
    echo [WARNING] هشدار: فرآیند پس‌زمینه (Worker) قطع است.
    echo [WARNING] عملیات Database Manager (بکاپ، ساخت، بازیابی) معلق خواهند ماند.
    echo [WARNING] برای بررسی لاگ ورکر، دستور logs.bat را بررسی کنید.
    echo [WARNING] ========================================================
    goto ready_degraded
)

set /a health_sec+=2
if !health_sec! geq 90 (
    echo.
    echo [ERROR] ========================================================
    echo [ERROR] سیستم بالا آمد ولی آماده نیست! (Ready probe failed)
    echo [ERROR] وضعیت فعلی: !HEALTH_STATUS!
    echo [ERROR] جزئیات: Postgres: [!PG_STATUS!], Redis: [!REDIS_STATUS!], Worker: [!WORKER_STATUS!]
    echo [ERROR] راهنما: با status.bat وضعیت کانتینرها و با logs.bat لاگ خطا را بررسی کنید.
    echo [ERROR] ========================================================
    echo.
    pause
    exit /b 1
)
goto health_loop

:ready_success
echo.
echo ========================================================
echo  bodo ERP is running successfully!
echo ========================================================
echo  - Web Application: http://localhost
echo  - Live Health:    http://localhost/health/live
echo  - Ready Probe:    http://localhost/health/ready
echo  - Version:        !APP_VERSION! (Commit: !APP_COMMIT!)
echo.
echo  Useful commands:
echo  - status.bat : View running services and health status
echo  - logs.bat   : Follow live container logs
echo  - stop.bat   : Stop services safely (preserves data)
echo ========================================================
echo.

echo [INFO] Opening Web UI in default browser...
start http://localhost

pause
exit /b 0

:ready_degraded
echo.
echo ========================================================
echo  bodo ERP is running in DEGRADED state!
echo ========================================================
echo  - Web Application: http://localhost (Web & API Active)
echo  - Warning:         Worker is DOWN. Background jobs will not run.
echo ========================================================
echo.

echo [INFO] Opening Web UI in default browser...
start http://localhost

pause
exit /b 0
