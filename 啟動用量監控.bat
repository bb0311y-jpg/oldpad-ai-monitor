@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI 用量監控啟動器

if not exist node_modules (
  echo 第一次啟動，正在安裝必要元件，大約需要一兩分鐘，請稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo 安裝失敗了，請確認電腦有網路、有安裝 Node.js，再重新執行一次。
    pause
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo 找不到主程式元件，請把 node_modules 資料夾整個刪掉後，再重新執行一次。
  pause
  exit /b 1
)

echo 正在啟動 AI 用量監控...（這個視窗會自動關閉，程式在右下角系統列）
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
