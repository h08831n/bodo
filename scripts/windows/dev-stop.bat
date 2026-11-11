@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Dev Stop Launcher (dev-stop.bat)
:: ========================================================

title bodo ERP - Stop Development Mode

call "%~dp0common.bat"
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

:: 1. Terminate the pnpm dev process tree via window title and cleanup listening ports
echo [INFO] Terminating pnpm dev process tree ("bodo-dev-server")...
taskkill /FI "WINDOWTITLE eq bodo-dev-server*" /T /F >nul 2>&1

:: Cleanly terminate any remaining dev server processes on ports 3000 and 5173
powershell -NoProfile -Command "$ports=@(3000, 5173); foreach ($p in $ports) { $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>&1

:: Remove dev active marker if present
if exist "%PROJECT_ROOT%\.dev-server.active" (
    del /f /q "%PROJECT_ROOT%\.dev-server.active" >nul 2>&1
)

:: 2. Stop development database containers
echo [INFO] Stopping PostgreSQL and Redis dev containers...
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" stop
if %errorlevel% neq 0 (
    echo [WARNING] Encountered issue stopping dev containers.
)

echo.
echo ========================================================
echo  [SUCCESS] Development environment stopped cleanly.
echo  Dev databases and node processes are stopped.
echo ========================================================
echo.

pause
exit /b 0
