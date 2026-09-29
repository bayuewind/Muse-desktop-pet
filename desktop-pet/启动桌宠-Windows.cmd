@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\package.json" (
  echo 首次启动，正在安装依赖...
  call npm ci
  if errorlevel 1 (
    echo 依赖安装失败，请检查 Node.js 22.12+ 和网络。
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
