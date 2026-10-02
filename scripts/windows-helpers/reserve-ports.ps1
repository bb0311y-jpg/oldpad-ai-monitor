# 修「CPU 溫度消失／iPad 儀表板埠號被搶」：
# 根因：Windows 的 Hyper-V／WSL 開機時會從「動態埠範圍」隨機劃走幾段埠號當保留區；
#       這台電腦的動態範圍被設成從低號碼開始，所以 3801、8085 這種埠常被劃走。
# 做法（2026-10-02 實測定案）：
#   1. 把動態埠範圍改回 Windows 預設的 49152～65535 → 以後開機不會再搶低號碼埠
#   2. 刪掉之前加的 8085「排除」——實測排除範圍會讓 LibreHardwareMonitor 這種走 http.sys 的程式反而綁不到
#      （純 socket 的程式像 AI用量監控 不受影響，所以 3801／1455 的排除可留）
#   3. 幫 8085 加 URL 保留（urlacl），LibreHardwareMonitor 就算不是用管理員身分開也能開網頁
#   4. 重新用「管理員身分的排程」啟動 LibreHardwareMonitor，確認 8085 有起來

function Get-Excluded {
  $out = @()
  foreach ($l in ((netsh interface ipv4 show excludedportrange protocol=tcp | Out-String) -split "`r?`n")) {
    if ($l -match '^\s*(\d+)\s+(\d+)\s*(\*?)') { $out += @{ From = [int]$Matches[1]; To = [int]$Matches[2]; Admin = ($Matches[3] -eq '*') } }
  }
  $out
}
function Test-AdminExcluded($port) {
  foreach ($r in (Get-Excluded)) { if ($r.Admin -and $r.From -le $port -and $r.To -ge $port) { return $true } }
  $false
}

Write-Host "[1/4] 動態埠範圍改回 49152～65535（Hyper-V 以後只會在這段裡抓保留區）..."
netsh int ipv4 set dynamicport tcp start=49152 num=16384 | Out-Null
netsh int ipv6 set dynamicport tcp start=49152 num=16384 | Out-Null
netsh int ipv4 show dynamicport tcp | Select-String '^\s*(Start|Number|起始|數目)' | ForEach-Object { "      " + $_.Line.Trim() }

Write-Host "[2/4] 8085 的排除設定要拿掉（會害 LibreHardwareMonitor 綁不到）..."
if (Test-AdminExcluded 8085) {
  netsh interface ipv4 delete excludedportrange protocol=tcp startport=8085 numberofports=1 | Out-Null
  if (Test-AdminExcluded 8085) { Write-Host "      拿不掉，請到 GitHub 開 issue 並附上這個視窗的內容" } else { Write-Host "      已拿掉" }
} else { Write-Host "      本來就沒有，略過" }

Write-Host "[3/4] 幫 8085 加 URL 保留（非管理員身分也能開網頁）..."
$acl = netsh http show urlacl url=http://+:8085/ | Out-String
if ($acl -match '8085') { Write-Host "      已經有了" }
else {
  netsh http add urlacl url=http://+:8085/ user=Everyone | Out-Null
  Write-Host "      已加入"
}

Write-Host "[4/4] 用管理員排程重新啟動 LibreHardwareMonitor..."
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
schtasks /run /tn "LibreHardwareMonitor" | Out-Null
$ok = $false
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8085/data.json; $ok = ($r.StatusCode -eq 200) } catch { }
}
Write-Host ""
if ($ok) { Write-Host "完成！溫度網頁已恢復，iPad 儀表板幾秒內會再出現 CPU 溫度。" }
else {
  Write-Host "溫度網頁還沒起來。請在系統列找到 LibreHardwareMonitor → Options → Remote Web Server → Run 打勾，"
  Write-Host "再看一次 iPad；還是沒有就到 GitHub 開 issue 並附上這個視窗的內容。"
}
