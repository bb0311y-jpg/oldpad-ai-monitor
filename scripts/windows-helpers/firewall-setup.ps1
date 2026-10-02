Write-Host "允許 iPad 儀表板通過防火牆"
Write-Host "1. 把被 Windows 當成「公用網路」的 Wi-Fi／有線網路改成「私人網路」（家裡的網路本來就該是私人；公用網路會把區網連線全擋掉）"
Write-Host "2. 在防火牆加一條規則：允許同一個區網的裝置連到本機 3801 埠"
Write-Host ""
Write-Host "[1/2] 檢查網路類別..."
Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" } | ForEach-Object {
  Write-Host ("  " + $_.Name + "（" + $_.InterfaceAlias + "）公用 → 私人")
  $_ | Set-NetConnectionProfile -NetworkCategory Private
}
Get-NetConnectionProfile | ForEach-Object { Write-Host ("  目前：" + $_.Name + " = " + $_.NetworkCategory) }
Write-Host ""
Write-Host "[2/2] 加防火牆規則..."
netsh advfirewall firewall delete rule name="AI用量監控 iPad儀表板 (3801)" | Out-Null
netsh advfirewall firewall add rule name="AI用量監控 iPad儀表板 (3801)" dir=in action=allow protocol=TCP localport=3801 remoteip=localsubnet profile=any | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "完成！回 iPad 重新整理網頁。"
  Write-Host "電腦同時有「有線」和「Wi-Fi」時會有兩個網址，iPad 連哪個網路就用對應那個。"
} else {
  Write-Host ""
  Write-Host "加規則失敗，請確認有按「是」給予系統管理員權限後再試一次。"
}
