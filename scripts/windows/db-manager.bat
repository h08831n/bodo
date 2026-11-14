@echo off
setlocal enabledelayedexpansion

:: ========================================================
::  bodo ERP - Database Manager Launcher (db-manager.bat)
:: ========================================================

title bodo ERP - Database Manager

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%..\.."
set "PROJECT_ROOT=%CD%"

:: Check if Node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was not found in PATH.
    pause
    exit /b 1
)

:: If CLI arguments were provided, pass through directly to db-manager.mjs
if not "%~1"=="" (
    node scripts\db-manager.mjs %*
    exit /b %errorlevel%
)

:: Interactive Menu Mode
:menu
cls
echo ========================================================
echo  bodo ERP - Database Manager
echo ========================================================
echo.
echo  [1] List Tenant Databases
echo  [2] Create New Tenant Database
echo  [3] Duplicate Tenant Database
echo  [4] Backup Tenant Database
echo  [5] List Backups of Database
echo  [6] Restore Database from Backup
echo  [7] Delete Tenant Database
echo  [8] Apply Schema Upgrades
echo  [9] Repair Database / Unblock
echo  [10] View Background Jobs
echo  [11] View Admin Audit Log
echo  [0] Exit
echo.
set /p "CHOICE=Select an option [0-11]: "

if "%CHOICE%"=="1" goto opt_list
if "%CHOICE%"=="2" goto opt_create
if "%CHOICE%"=="3" goto opt_duplicate
if "%CHOICE%"=="4" goto opt_backup
if "%CHOICE%"=="5" goto opt_backups
if "%CHOICE%"=="6" goto opt_restore
if "%CHOICE%"=="7" goto opt_delete
if "%CHOICE%"=="8" goto opt_upgrade
if "%CHOICE%"=="9" goto opt_repair
if "%CHOICE%"=="10" goto opt_jobs
if "%CHOICE%"=="11" goto opt_audit
if "%CHOICE%"=="0" exit /b 0

echo Invalid choice.
pause
goto menu

:opt_list
echo.
node scripts\db-manager.mjs list
echo.
pause
goto menu

:opt_create
echo.
set /p "DBNAME=Enter new tenant database name (slug): "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs create %DBNAME% --watch
echo.
pause
goto menu

:opt_duplicate
echo.
set /p "SRCDB=Enter source database name: "
set /p "TGTDB=Enter target database name: "
if "%SRCDB%"=="" goto menu
if "%TGTDB%"=="" goto menu
node scripts\db-manager.mjs duplicate %SRCDB% %TGTDB% --watch
echo.
pause
goto menu

:opt_backup
echo.
set /p "DBNAME=Enter database name to backup: "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs backup %DBNAME% --watch
echo.
pause
goto menu

:opt_backups
echo.
set /p "DBNAME=Enter database name: "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs backups %DBNAME%
echo.
pause
goto menu

:opt_restore
echo.
set /p "DBNAME=Enter database name: "
set /p "ZIPPATH=Enter full path to backup zip file: "
if "%DBNAME%"=="" goto menu
if "%ZIPPATH%"=="" goto menu
node scripts\db-manager.mjs restore %DBNAME% "%ZIPPATH%" --watch
echo.
pause
goto menu

:opt_delete
echo.
set /p "DBNAME=Enter database name to delete: "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs delete %DBNAME% --watch
echo.
pause
goto menu

:opt_upgrade
echo.
set /p "DBNAME=Enter database name to upgrade: "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs upgrade %DBNAME% --watch
echo.
pause
goto menu

:opt_repair
echo.
set /p "DBNAME=Enter database name to repair: "
if "%DBNAME%"=="" goto menu
node scripts\db-manager.mjs repair %DBNAME%
echo.
pause
goto menu

:opt_jobs
echo.
node scripts\db-manager.mjs jobs
echo.
pause
goto menu

:opt_audit
echo.
node scripts\db-manager.mjs audit
echo.
pause
goto menu
