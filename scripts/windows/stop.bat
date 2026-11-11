@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Stop Launcher (stop.bat)
:: ========================================================

title bodo ERP - Stop Services

call "%~dp0common.bat"
if %errorlevel% neq 0 (
    echo [ERROR] Pre-flight checks failed.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  Stopping bodo ERP Services (Preserving Volumes/Data)
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

:: 1. Stop production compose stack
echo [INFO] Stopping production containers...
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" stop
if %errorlevel% neq 0 (
    echo [WARNING] Encountered issue stopping production containers.
)

:: 2. Stop dev compose stack if running
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" stop >nul 2>&1

echo.
echo ========================================================
echo  [SUCCESS] bodo ERP services have stopped cleanly.
echo  Database volumes, configurations, and data are intact.
echo ========================================================
echo.

pause
exit /b 0
