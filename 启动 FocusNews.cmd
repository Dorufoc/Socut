@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ==========================================
echo   FocusNews - dev launcher (hot reload)
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "node_modules\electron-vite\bin\electron-vite.js" goto :no_deps

rem Clear leftover verification switches (SMOKE / PIXELCHECK / REVIEW_SHEET / SHOT*).
rem If any of them is set, the app runs an automated check and exits by itself,
rem which looks like "the window flashes and disappears".
for %%V in (FOCUSNEWS_SMOKE FOCUSNEWS_SMOKE_CANCEL FOCUSNEWS_SMOKE_OVERLAY FOCUSNEWS_SMOKE_GATE FOCUSNEWS_SMOKE_KIND FOCUSNEWS_SMOKE_DELIVERY FOCUSNEWS_SMOKE_AUDIO FOCUSNEWS_SMOKE_REF FOCUSNEWS_SMOKE_FIXTURES FOCUSNEWS_SMOKE_W FOCUSNEWS_SMOKE_H FOCUSNEWS_SMOKE_FPS FOCUSNEWS_SMOKE_SEC FOCUSNEWS_PIXELCHECK FOCUSNEWS_REVIEW_SHEET FOCUSNEWS_REVIEW_BACKDROP FOCUSNEWS_SHOT FOCUSNEWS_SHOT_ERROR FOCUSNEWS_SHOT_REFMISSING FOCUSNEWS_SHOT_DELAY_MS) do set "%%V="

if not exist "resources\ffmpeg\ffmpeg.exe" echo [warn] resources\ffmpeg missing - dev mode falls back to FFmpeg on PATH.
if not exist "resources\fonts\manifest.json" echo [warn] builtin fonts missing - run: npm run fetch:fonts
echo.
echo Starting Electron (first run compiles main/preload, takes a few seconds)...
echo   App window title: FocusNews
echo   Log file: %APPDATA%\focusnews\logs\app.log
echo   Stop: close the app window, or press Ctrl+C in this window.
echo.

node "node_modules\electron-vite\bin\electron-vite.js" dev
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" goto :failed
endlocal & exit /b 0

:no_node
echo [error] node not found in PATH. Install Node.js 22.12+ first.
echo.
pause
exit /b 1

:no_deps
echo [error] dependencies missing in this folder. Run: npm install
echo.
pause
exit /b 1

:failed
echo.
echo [error] launcher exited with code %EXITCODE%.
echo         Read the output above, and %APPDATA%\focusnews\logs\app.log
echo.
pause
endlocal & exit /b %EXITCODE%
