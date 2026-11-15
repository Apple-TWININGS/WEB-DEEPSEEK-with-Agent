@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title DeepSeek Web

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [DeepSeek Web] 没有找到 Node.js。
  echo 请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "agent-workspace" mkdir "agent-workspace"

echo.
echo [DeepSeek Web] 正在启动本地服务...
echo 页面地址：http://127.0.0.1:4173
echo 按 Ctrl+C 停止服务。
echo.

start "" cmd /c "ping 127.0.0.1 -n 3 >nul & explorer http://127.0.0.1:4173"
node server.mjs

if errorlevel 1 (
  echo.
  echo [DeepSeek Web] 服务异常退出，请查看上面的日志。
  pause
)
