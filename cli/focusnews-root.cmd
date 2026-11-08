@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0FocusNews.exe" "%~dp0cli\focusnews-cli.mjs" %*
