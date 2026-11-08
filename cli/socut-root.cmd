@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Socut.exe" "%~dp0cli\socut-cli.mjs" %*
