@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Database Setup Launcher (db-setup.bat)
:: ========================================================

title bodo ERP - Database Setup

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
echo  bodo ERP - Setting Up Development Database
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

:: Verify Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was not found in PATH.
    pause
    exit /b 1
)

:: Verify pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] pnpm not found in PATH. Attempting to enable via Corepack...
    call corepack enable >nul 2>&1
    call corepack prepare pnpm@12.18.0 --activate >nul 2>&1
    where pnpm >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] pnpm is not available. Please run 'corepack enable'.
        pause
        exit /b 1
    )
)

:: Run idempotent db:setup-dev
echo [INFO] Executing pnpm db:setup-dev...
cd /d "%PROJECT_ROOT%"
call pnpm db:setup-dev
if %errorlevel% neq 0 (
    echo.
    echo ========================================================
    echo  [ERROR] Database setup failed.
    echo ========================================================
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  [SUCCESS] Development database setup completed cleanly!
echo ========================================================
echo.
pause
exit /b 0
