@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\FocusNews.exe" "%~dp0focusnews-cli.mjs" %*
