@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Launcher Shared Pre-Flight Helper
:: ========================================================

:: 1. Navigate to project root reliably regardless of current working directory
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%..\.."
set "PROJECT_ROOT=%CD%"

:: 2. Ensure .env file exists
if not exist "%PROJECT_ROOT%\.env" (
    call :init_env
    if !errorlevel! neq 0 exit /b 1
)

:: 3. Check Docker CLI
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ========================================================
    echo  [ERROR] Docker CLI tool 'docker' was not found in PATH.
    echo ========================================================
    echo  Please install Docker Desktop for Windows:
    echo  https://www.docker.com/products/docker-desktop/
    echo ========================================================
    echo.
    exit /b 1
)

:: 4. Check if Docker daemon is running
docker info >nul 2>&1
if !errorlevel! equ 0 (
    endlocal & set "PROJECT_ROOT=%PROJECT_ROOT%" & exit /b 0
)

:: Docker daemon is not responding, attempt to locate and launch Docker Desktop
call :launch_docker_desktop
if !errorlevel! neq 0 (
    endlocal & exit /b 1
)

:: Wait for daemon to become ready (up to 180s)
call :wait_for_docker_daemon
if !errorlevel! neq 0 (
    endlocal & exit /b 1
)

endlocal & set "PROJECT_ROOT=%PROJECT_ROOT%" & exit /b 0


:: ========================================================
:: Subroutines
:: ========================================================

:init_env
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
exit /b 0


:find_docker_desktop
set "FOUND_DOCKER="

:: Simulation override for testing scenario (b)
if defined BODO_MOCK_DOCKER_NOT_FOUND (
    exit /b 1
)

:: 1. Standard Program Files
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    set "FOUND_DOCKER=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    exit /b 0
)

:: 2. LocalAppData Programs
if exist "%LOCALAPPDATA%\Programs\Docker\Docker\Docker Desktop.exe" (
    set "FOUND_DOCKER=%LOCALAPPDATA%\Programs\Docker\Docker\Docker Desktop.exe"
    exit /b 0
)

:: 3. Registry Uninstall Key
for /f "tokens=2*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop" /v InstallLocation 2^>nul') do (
    if exist "%%~B\Docker Desktop.exe" (
        set "FOUND_DOCKER=%%~B\Docker Desktop.exe"
        exit /b 0
    )
)

:: 4. Registry Docker Inc Keys
for /f "tokens=2*" %%A in ('reg query "HKLM\SOFTWARE\Docker Inc.\Docker Desktop" /v AppPath 2^>nul') do (
    if exist "%%~B" (
        set "FOUND_DOCKER=%%~B"
        exit /b 0
    )
)
for /f "tokens=2*" %%A in ('reg query "HKCU\SOFTWARE\Docker Inc.\Docker Desktop" /v AppPath 2^>nul') do (
    if exist "%%~B" (
        set "FOUND_DOCKER=%%~B"
        exit /b 0
    )
)

:: 5. Traverse up from docker.exe location
for /f "delims=" %%D in ('where docker 2^>nul') do (
    if exist "%%~dpD..\..\Docker Desktop.exe" (
        set "FOUND_DOCKER=%%~dpD..\..\Docker Desktop.exe"
        exit /b 0
    )
)

exit /b 1


:launch_docker_desktop
echo [INFO] Docker daemon is not responding. Searching for Docker Desktop...
call :find_docker_desktop

if not defined FOUND_DOCKER (
    echo.
    echo ========================================================
    echo  [ERROR] Docker Desktop executable was not found.
    echo ========================================================
    echo  Searched locations:
    echo  1. %ProgramFiles%\Docker\Docker\Docker Desktop.exe
    echo  2. %LOCALAPPDATA%\Programs\Docker\Docker\Docker Desktop.exe
    echo  3. Windows Registry [Docker Desktop InstallLocation / AppPath]
    echo  4. Parent directories of docker.exe
    echo.
    echo  Docker Desktop not found. Please start it manually, then run this script again.
    echo ========================================================
    echo.
    exit /b 1
)

echo [INFO] Found Docker Desktop at: "%FOUND_DOCKER%"
echo [INFO] Launching Docker Desktop...
where powershell >nul 2>&1
if !errorlevel! equ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '\"%FOUND_DOCKER%\"' } | Out-Null" 2>nul
) else (
    start "" "%FOUND_DOCKER%"
)
exit /b 0


:wait_for_docker_daemon
echo [INFO] Waiting for Docker daemon to initialize (timeout: 180 seconds)...
set /a elapsed=0

:wait_loop
ping 127.0.0.1 -n 3 >nul
docker info >nul 2>&1
if !errorlevel! equ 0 (
    echo.
    echo [INFO] Docker daemon is ready and responding!
    exit /b 0
)

set /a elapsed+=2
set /a mod10=elapsed %% 10

if !mod10! equ 0 (
    echo [INFO] Still waiting for Docker daemon... (!elapsed!s / 180s)
)

if !elapsed! geq 180 (
    echo.
    echo ========================================================
    echo  [ERROR] Docker daemon did not become ready within 180 seconds.
    echo ========================================================
    echo  Troubleshooting suggestions:
    echo  1. Open Docker Desktop manually from the Windows Start Menu.
    echo  2. Open PowerShell and check WSL status by running: wsl --status
    echo  3. Check WSL distributions by running: wsl --list --verbose
    echo  4. If WSL is unresponsive, try restarting WSL with: wsl --shutdown
    echo  5. Ensure hardware virtualization is enabled in BIOS/UEFI.
    echo ========================================================
    echo.
    exit /b 1
)
goto wait_loop
