@echo off
chcp 65001 >nul
setlocal enableextensions
cd /d "%~dp0"

echo ==========================================
echo   Socut one-click packaging (x64)
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "node_modules\electron-vite\bin\electron-vite.js" goto :no_deps
if not exist "node_modules\electron-builder\out\cli\cli.js" goto :no_deps

rem Pass-through flags: --verify / --dir / --no-open / --skip-check / --help
node "scripts\package-win.mjs" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" goto :failed

echo [done] Installer is ready in the release\ folder.
if "%~1"=="" pause
exit /b 0

:no_node
echo [error] Node.js not found. Install Node.js 22.12 or newer first.
echo         Download: https://nodejs.org/
echo.
pause
exit /b 1

:no_deps
echo [error] Dependencies are missing. Run this in the project folder:
echo         npm install
echo.
pause
exit /b 1

:failed
echo [error] Packaging failed with exit code %EXITCODE%. See the log above.
echo.
pause
exit /b %EXITCODE%
