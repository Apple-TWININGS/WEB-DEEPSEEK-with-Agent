@echo off
setlocal
cd /d "%~dp0"
title DeepSeek Web - LAN

set "HOST=0.0.0.0"
if not defined PORT set "PORT=4173"
set "DEEPSEEK_WEB_OPEN_BROWSER=1"

echo.
echo ============================================================
echo  DeepSeek Web - LAN mode
echo ============================================================
echo  PC and phone must be connected to the same Wi-Fi.
echo  The access password and QR code will be printed below.
echo  Do not expose this port on public Wi-Fi or the internet.
echo ============================================================
echo.

if exist "DeepSeek-Web.exe" (
  echo [MODE] Using DeepSeek-Web.exe
  "DeepSeek-Web.exe"
) else if exist "dist\DeepSeek-Web.exe" (
  echo [MODE] Using dist\DeepSeek-Web.exe
  "dist\DeepSeek-Web.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] DeepSeek-Web.exe and Node.js were not found.
    echo Install Node.js 20+ or run build-exe.cmd first.
    pause
    exit /b 1
  )
  echo [MODE] Using node server.mjs
  node server.mjs
)

if errorlevel 1 (
  echo.
  echo [ERROR] The service exited with an error.
  pause
)
