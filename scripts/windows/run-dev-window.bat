@echo off
title bodo-dev-server
cd /d "%~dp0..\.."
echo ========================================================
echo  bodo ERP - Development Server
echo  Running: pnpm dev
echo  Close this window or run dev-stop.bat to stop servers.
echo ========================================================
call pnpm dev
if errorlevel 1 (
    echo.
    echo [ERROR] pnpm dev exited with error.
    pause
)
