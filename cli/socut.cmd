@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Socut.exe" "%~dp0socut-cli.mjs" %*
