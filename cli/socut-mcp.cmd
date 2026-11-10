@echo off
rem M10：以 Node 模式跑 MCP stdio server（不需要单独装 Node，也不需要拉起 Electron 窗口）
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\Socut.exe" "%~dp0socut-mcp.mjs" %*
