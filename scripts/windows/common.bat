@echo off
:: ========================================================
::  bodo ERP - Windows Launcher Shared Pre-Flight Helper
:: ========================================================

:: 1. Navigate to project root reliably regardless of current working directory
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%..\.."
set "PROJECT_ROOT=%CD%"

:: 2. Ensure .env file exists
if not exist "%PROJECT_ROOT%\.env" (
    echo [INFO] .env file not found. Initializing from .env.example with secure random credentials...
    where node >nul 2>&1
    if %errorlevel% equ 0 (
        node "%PROJECT_ROOT%\scripts\init-env.mjs"
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "$rnd=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $b=New-Object byte[] 32; $rnd.GetBytes($b); $hex=[System.BitConverter]::ToString($b).Replace('-','').ToLower(); $pwd='Bodo_'+$hex.Substring(0,10)+'!2026'; (Get-Content '%PROJECT_ROOT%\.env.example') -replace 'POSTGRES_PASSWORD=postgres', ('POSTGRES_PASSWORD='+$hex.Substring(0,16)) -replace 'REDIS_PASSWORD=redispassword', ('REDIS_PASSWORD='+$hex.Substring(16,16)) -replace 'MASTER_PASSWORD_INITIAL=MasterSecurePassword2026!', ('MASTER_PASSWORD_INITIAL='+$pwd) -replace 'JWT_SECRET=super_secret_jwt_key_bodo_2026_min_16_chars', ('JWT_SECRET='+$hex) -replace 'ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ('ENCRYPTION_KEY='+$hex) | Set-Content '%PROJECT_ROOT%\.env'; Write-Host '[init-env] SUCCESS: .env file created.'; Write-Host ('[init-env] Initial Master Password: ' + $pwd)"
    )
    if not exist "%PROJECT_ROOT%\.env" (
        echo [ERROR] Failed to create .env file.
        exit /b 1
    )
)

:: 3. Check Docker CLI
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker command line tool 'docker' was not found in PATH.
    echo Please install Docker Desktop for Windows.
    exit /b 1
)

:: 4. Check if Docker daemon is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Docker daemon is not responding. Attempting to start Docker Desktop...
    set "DOCKER_EXE="
    if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
        set "DOCKER_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    ) else if exist "%LocalAppData%\Programs\Docker\Docker\Docker Desktop.exe" (
        set "DOCKER_EXE=%LocalAppData%\Programs\Docker\Docker\Docker Desktop.exe"
    )

    if defined DOCKER_EXE (
        echo [INFO] Launching Docker Desktop from "%DOCKER_EXE%"...
        start "" "%DOCKER_EXE%"
    ) else (
        echo [WARNING] Could not locate Docker Desktop executable automatically.
        echo Please launch Docker Desktop manually.
    )

    echo [INFO] Waiting for Docker daemon to become ready: up to 90 seconds...
    set /a wait_sec=0
    goto check_docker_loop
)

exit /b 0

:check_docker_loop
ping 127.0.0.1 -n 4 >nul
docker info >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Docker daemon is ready!
    exit /b 0
)
set /a wait_sec+=3
if %wait_sec% geq 90 (
    echo [ERROR] Docker daemon did not become ready within 90 seconds.
    echo Please verify Docker Desktop is running and try again.
    exit /b 1
)
goto check_docker_loop
