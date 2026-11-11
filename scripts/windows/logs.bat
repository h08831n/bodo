@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Live Container Logs (logs.bat)
:: ========================================================

title bodo ERP - Live Logs

call "%~dp0common.bat"
if %errorlevel% neq 0 (
    echo [ERROR] Pre-flight checks failed.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  bodo ERP Live Container Logs (Tail 100, Follow)
echo  Press Ctrl+C at any time to exit log viewing.
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

:: Check whether production or dev containers are running
docker ps --format "{{.Names}}" | findstr "bodo-api" >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Following production stack logs...
    echo.
    docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" logs -f --tail 100
) else (
    docker ps --format "{{.Names}}" | findstr "bodo-postgres-dev" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO] Following dev database containers logs...
        echo.
        docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" logs -f --tail 100
    ) else (
        echo [WARNING] No running bodo ERP containers detected.
        echo Displaying recent logs from production compose file...
        echo.
        docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.yml" logs --tail 50
    )
)

echo.
pause
exit /b 0
