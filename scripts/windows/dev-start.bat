@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Development Launcher (dev-start.bat)
:: ========================================================

title bodo ERP - Dev Launcher

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
echo  Starting bodo ERP (Development Mode)
echo ========================================================
echo [INFO] Working Directory: %PROJECT_ROOT%
echo.

:: 1. Verify Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was not found in PATH.
    echo Node.js 24+ is required for local development.
    pause
    exit /b 1
)

:: 2. Verify pnpm (via Corepack if needed)
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] pnpm not found in PATH. Attempting to enable via Corepack...
    call corepack enable >nul 2>&1
    call corepack prepare pnpm@12.18.0 --activate >nul 2>&1
    where pnpm >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] pnpm is not available. Please run 'corepack enable' in an elevated terminal.
        pause
        exit /b 1
    )
)

:: 3. Check node_modules dependencies
if not exist "%PROJECT_ROOT%\node_modules" (
    echo [INFO] node_modules folder missing. Running 'pnpm install'...
    cd /d "%PROJECT_ROOT%"
    call pnpm install
    if %errorlevel% neq 0 (
        echo [ERROR] 'pnpm install' failed.
        pause
        exit /b 1
    )
)

:: 4. Start isolated development database & cache containers (PostgreSQL on 5433, Redis on 6379)
echo [INFO] Starting isolated PostgreSQL (port 5433) and Redis (port 6379) for development...
docker compose --env-file "%PROJECT_ROOT%\.env" -f "%PROJECT_ROOT%\infra\docker-compose.dev.yml" up -d
if %errorlevel% neq 0 (
    echo [ERROR] Failed to start dev containers.
    pause
    exit /b 1
)

:: 5. Wait for PostgreSQL and Redis to report healthy
echo [INFO] Waiting for PostgreSQL and Redis dev containers to become healthy...
set /a wait_dev_db=0

:wait_dev_db_loop
ping 127.0.0.1 -n 3 >nul
set "pg_health="
set "redis_health="

for /f "tokens=*" %%i in ('docker inspect --format="{{.State.Health.Status}}" bodo-postgres-dev 2^>nul') do set "pg_health=%%i"
for /f "tokens=*" %%i in ('docker inspect --format="{{.State.Health.Status}}" bodo-redis-dev 2^>nul') do set "redis_health=%%i"

if "%pg_health%"=="healthy" if "%redis_health%"=="healthy" (
    echo [INFO] PostgreSQL and Redis are healthy!
    goto dev_containers_ready
)

set /a wait_dev_db+=2
if %wait_dev_db% geq 45 (
    echo [WARNING] Containers not reporting healthy within 45s, attempting to continue...
    goto dev_containers_ready
)
goto wait_dev_db_loop

:dev_containers_ready
echo.
echo [INFO] Ensuring development database is provisioned and seeded...
cd /d "%PROJECT_ROOT%"
call pnpm db:setup-dev
if %errorlevel% neq 0 (
    echo [ERROR] Development database setup failed.
    pause
    exit /b 1
)
echo.
echo [INFO] Launching pnpm dev in a dedicated window ("bodo-dev-server")...

if exist "%SCRIPT_DIR%launch-dev.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%launch-dev.ps1" -ProjectRoot "%PROJECT_ROOT%"
) else (
    start "bodo-dev-server" cmd /k "title bodo-dev-server && cd /d ""%PROJECT_ROOT%"" && pnpm dev"
)

if exist "%PROJECT_ROOT%\.dev-pid" (
    set /p DEV_PID=<"%PROJECT_ROOT%\.dev-pid"
    echo [INFO] Recorded dev server window PID: !DEV_PID!
)

echo [INFO] Waiting for dev server to initialize (6s)...
ping 127.0.0.1 -n 7 >nul

echo [INFO] Opening Web application in default browser...
start http://localhost:5173

echo.
echo ========================================================
echo  bodo ERP development environment is running!
echo ========================================================
echo  - Web Application: http://localhost:5173
echo  - API Endpoint:    http://localhost:3000/health/live
echo  - PostgreSQL Port: 5433 (127.0.0.1 only)
echo  - Redis Port:      6379 (127.0.0.1 only)
echo.
echo  The dev server process tree is running in the window:
echo    "bodo-dev-server"
echo.
echo  To stop dev servers and database containers cleanly:
echo    Run dev-stop.bat
echo ========================================================
echo.

pause
exit /b 0
