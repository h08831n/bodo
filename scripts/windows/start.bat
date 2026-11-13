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
echo [INFO] Starting containers via Docker Compose...
echo.

docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" up -d
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to start Docker Compose services.
    echo.
    pause
    exit /b 1
)

echo.
echo [INFO] Waiting for bodo ERP services to become healthy (up to 60s)...

set /a health_sec=0
:health_loop
ping 127.0.0.1 -n 3 >nul
curl -s -f http://localhost/health/live >nul 2>&1
if !errorlevel! equ 0 (
    echo [INFO] API and Web services are healthy!
    goto ready_success
)

set /a health_sec+=2
if !health_sec! geq 60 (
    echo [WARNING] Services did not report healthy within 60s, but containers may still be initializing.
    goto ready_success
)
goto health_loop

:ready_success
echo.
echo ========================================================
echo  bodo ERP is running successfully!
echo ========================================================
echo  - Web Application: http://localhost
echo  - Live Health:    http://localhost/health/live
echo  - System Health:  http://localhost/health/ready
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
