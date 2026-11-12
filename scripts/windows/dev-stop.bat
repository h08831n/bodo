@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Dev Stop Launcher (dev-stop.bat)
:: ========================================================

title bodo ERP - Stop Development Mode

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
echo  Stopping bodo ERP Development Environment
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

:: 1. Terminate the pnpm dev process tree strictly via recorded PID or window title
if exist "%PROJECT_ROOT%\.dev-pid" (
    set /p DEV_PID=<"%PROJECT_ROOT%\.dev-pid"
    if defined DEV_PID (
        echo [INFO] Terminating dev server process tree with recorded PID: !DEV_PID!...
        taskkill /PID !DEV_PID! /T /F >nul 2>&1
    )
    del /f /q "%PROJECT_ROOT%\.dev-pid" >nul 2>&1
)

:: Terminate by window title if still present
echo [INFO] Ensuring "bodo-dev-server" window is closed...
taskkill /FI "WINDOWTITLE eq bodo-dev-server*" /T /F >nul 2>&1

:: 2. Stop development database containers
echo [INFO] Stopping PostgreSQL and Redis dev containers...
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" stop
if %errorlevel% neq 0 (
    echo [WARNING] Encountered issue stopping dev containers.
)

:: 3. Informational check: Warn if development ports (3000, 5173) are still occupied by external processes.
:: Strictly NO auto-kill of external processes.
if exist "%SCRIPT_DIR%check-ports.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%check-ports.ps1"
)

echo.
echo ========================================================
echo  [SUCCESS] Development environment stopped cleanly.
echo  Dev databases and project node processes are stopped.
echo ========================================================
echo.

pause
exit /b 0
