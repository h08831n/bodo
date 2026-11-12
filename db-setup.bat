@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%scripts\windows\db-setup.bat" %*
exit /b %errorlevel%
