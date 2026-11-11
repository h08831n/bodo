@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Windows Services Status (status.bat)
:: ========================================================

title bodo ERP - Services Status

call "%~dp0common.bat"
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
curl -s -i http://localhost/health/ready 2>nul
if %errorlevel% neq 0 (
    echo  (Endpoint not reachable on port 80 - production stack may be stopped)
)
echo.
echo.

echo [B] Dev API Direct Port (http://localhost:3000/health/ready):
curl -s -i http://localhost:3000/health/ready 2>nul
if %errorlevel% neq 0 (
    echo  (Endpoint not reachable on port 3000 - dev API server may be stopped)
)
echo.

echo ========================================================
echo  Status check completed.
echo ========================================================
echo.

pause
exit /b 0
