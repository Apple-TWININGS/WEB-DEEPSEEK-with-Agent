@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title DeepSeek Web · LAN

set "HOST=0.0.0.0"
if not defined PORT set "PORT=4173"
set "DEEPSEEK_WEB_OPEN_BROWSER=1"

echo.
echo ============================================================
echo  DeepSeek Web · 局域网模式
echo ============================================================
echo  电脑和手机需要连接同一个 Wi-Fi。
echo  服务会监听 0.0.0.0:%PORT%，并自动生成访问口令。
echo  二维码和手机地址会显示在下面的服务日志中。
echo.
if defined ACCESS_PASSWORD (
  echo  使用你设置的 ACCESS_PASSWORD。
) else (
  echo  未设置 ACCESS_PASSWORD，服务会自动生成一个随机口令。
  echo  如果想固定口令，请先执行：set ACCESS_PASSWORD=你的口令
)
echo.
echo  安全提醒：不要在不可信 Wi-Fi 或公网直接开放这个端口。
echo ============================================================
echo.

if exist "DeepSeek-Web.exe" (
  echo [模式] 使用当前目录的 DeepSeek-Web.exe
  "DeepSeek-Web.exe"
) else if exist "dist\DeepSeek-Web.exe" (
  echo [模式] 使用已打包的 dist\DeepSeek-Web.exe
  "dist\DeepSeek-Web.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 没有找到 DeepSeek-Web.exe，也没有找到 Node.js。
    echo 请先运行 build-exe.cmd，或安装 Node.js 20+。
    pause
    exit /b 1
  )
  echo [模式] 使用源码 node server.mjs
  node server.mjs
)

if errorlevel 1 (
  echo.
  echo 服务异常退出，请查看上面的日志。
  pause
)
