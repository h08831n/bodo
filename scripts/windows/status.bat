@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Services Status (status.bat)
:: ========================================================

title bodo ERP - Services Status

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

echo.
echo ========================================================
echo  bodo ERP Services Status
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

echo --------------------------------------------------------
echo  [1] Production Stack (infra/docker-compose.yml):
echo --------------------------------------------------------
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" ps
echo.

echo --------------------------------------------------------
echo  [2] Development Stack (infra/docker-compose.dev.yml):
echo --------------------------------------------------------
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" ps
echo.

echo --------------------------------------------------------
echo  [3] Health Endpoints Probes:
echo --------------------------------------------------------

echo [A] Production Nginx Reverse Proxy (http://localhost/health/ready):
set "HEALTH_STATUS=unreachable"
set "PG_STATUS=down"
set "REDIS_STATUS=down"
set "WORKER_STATUS=down"

for /f "tokens=1,2,3,4 delims=|" %%a in ('node -e "fetch('http://localhost/health/ready').then(r=>r.json()).then(d=>console.log([d.status,d.checks?.postgres,d.checks?.redis,d.checks?.worker].join('|'))).catch(()=>console.log('unreachable'))" 2^>nul') do (
    set "HEALTH_STATUS=%%a"
    set "PG_STATUS=%%b"
    set "REDIS_STATUS=%%c"
    set "WORKER_STATUS=%%d"
)

if "!HEALTH_STATUS!"=="ok" (
    echo   [OK] System is healthy and ready. (Postgres: !PG_STATUS!, Redis: !REDIS_STATUS!, Worker: !WORKER_STATUS!)
) else if "!HEALTH_STATUS!"=="degraded" (
    echo   [WARNING] سیستم در وضعیت Degraded است. ورکر قطع است (Worker: !WORKER_STATUS!).
    echo             عملیات پس‌زمینه و مدیریت دیتابیس در دسترس نیستند.
) else if "!HEALTH_STATUS!"=="unreachable" (
    echo   (Endpoint not reachable on port 80 - production stack may be stopped)
) else (
    echo   [ERROR] سیستم آماده نیست! (Status: !HEALTH_STATUS!, Postgres: !PG_STATUS!, Redis: !REDIS_STATUS!)
)
echo.

echo [B] Dev API Direct Port (http://localhost:3000/health/ready):
curl -s -i http://localhost:3000/health/ready 2>nul
if %errorlevel% neq 0 (
    echo   (Endpoint not reachable on port 3000 - dev API server may be stopped)
)
echo.

echo ========================================================
echo  Status check completed.
echo ========================================================
echo.

pause
exit /b 0
