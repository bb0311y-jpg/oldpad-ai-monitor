$lhm = "C:\Tools\LibreHardwareMonitor\LibreHardwareMonitor.exe"
Write-Host "安裝溫度監測（LibreHardwareMonitor）"
Write-Host "這會把它登錄成「開機自動啟動（系統管理員）」並立刻執行。"
Write-Host ""
if (-not (Test-Path $lhm)) {
  Write-Host "找不到 $lhm"
  Write-Host "請先把 LibreHardwareMonitor 解壓到 C:\Tools\LibreHardwareMonitor（設定檔 LibreHardwareMonitor.config 也放進去）再執行。"
  exit 1
}
schtasks /Create /TN "LibreHardwareMonitor" /SC ONLOGON /RL HIGHEST /TR "`"$lhm`"" /F | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "登錄開機啟動失敗。"; exit 1 }
Write-Host "已登錄開機自動啟動。"
Stop-Process -Name LibreHardwareMonitor -Force -ErrorAction SilentlyContinue
schtasks /Run /TN "LibreHardwareMonitor" | Out-Null
Write-Host "正在啟動，最多等 30 秒讓它讀完感測器..."
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8085/data.json" -UseBasicParsing -TimeoutSec 3
    if ($r.Content -match "Temperatures") { $ok = $true; break }
  } catch {}
}
Write-Host ""
if ($ok) {
  Write-Host "完成！溫度資料已經在 8085 埠提供，iPad 儀表板重新整理就會看到 CPU 溫度／風扇。"
} else {
  Write-Host "程式已啟動，但資料介面還沒回應；再等一下到 iPad 重新整理看看。"
  Write-Host "若一直沒有，請看右下角系統列的 LibreHardwareMonitor 圖示是否存在。"
}
