# check.ps1 —— 遥控器链路体检。出问题时跑这一条就能定位到哪一段断了。
#
# 背景（2026-10-11 查了一整天才定位到）：
#   这台机器装了 360，它的沙箱驱动（360Box64）与防劫持驱动（360AntiHijack）把
#   **未签名的可执行文件**降级到低完整性（Low 4096）；python.exe 这类有数字签名的不受影响。
#   Windows 的 UIPI 规定：低完整性进程注入到更高完整性的窗口会被**静默丢弃**，
#   而 SendInput 照样返回成功 —— 于是引擎日志全绿、界面毫无反应。
#   卸载 360 后必须**重启**才会真正卸载驱动（已加载的驱动不会自己卸下来）。
#
#   插件对此的应对：起引擎前先探一次完整性，被降级就自动改用 python 版引擎
#   （engine/read-engine.py，python 有签名，实测跑在 High 12288）。
#   所以第 1 项就算[坏]也不影响使用 —— 第 2、6 项才是"现在能不能用"。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File plugins\dsh-mi-remote\tools\check.ps1
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$pyExe = 'D:\.hermes\venv\Scripts\python.exe'
if (-not (Test-Path $pyExe)) { $pyExe = 'python.exe' }

function Line($t) { Write-Host ""; Write-Host "== $t ==" }
function Bad($t) { Write-Host ("   [坏] " + $t) -ForegroundColor Red }
function Good($t) { Write-Host ("   [好] " + $t) -ForegroundColor Green }
function Warn($t) { Write-Host ("   [疑] " + $t) -ForegroundColor Yellow }
function LvName($v) {
  if ($v -lt 0) { '读不到' } elseif ($v -ge 0x3000) { 'High' } elseif ($v -ge 0x2000) { 'Medium' }
  elseif ($v -ge 0x1000) { 'Low' } else { "未知($v)" }
}

Line "1. 360 的沙箱/防劫持驱动还在不在"
$d = @(Get-CimInstance Win32_SystemDriver | Where-Object { $_.Name -match '360' -and $_.State -eq 'Running' })
$f = @(fltmc filters 2>&1 | Select-String '360')
if ($d.Count -eq 0 -and $f.Count -eq 0) {
  Good "系统里没有 360 驱动在跑"
} else {
  Bad "还有 360 驱动在跑 —— 重启才会真正卸载（不影响使用，插件会自动改用 python 版引擎）"
  $d | ForEach-Object { Write-Host ("        " + $_.Name + " " + $_.State) }
  $f | ForEach-Object { Write-Host ("        " + $_.Line.Trim()) }
}

Line "2. 引擎实际会用哪个实现（原版被降级时自动切 python）"
$tmpDir = Join-Path $root 'tmp'
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
$log1 = Join-Path $tmpDir '_check-kb.jsonl'
Remove-Item $log1 -Force
Start-Process -FilePath (Join-Path $root 'engine\KeyBridge.exe') `
  -ArgumentList @('read', '--config', (Join-Path $root 'state\mapping.json'), '--file', (Join-Path $root 'state\keys.jsonl'), '--out', $log1) `
  -WindowStyle Hidden
Start-Sleep -Seconds 4
Get-CimInstance Win32_Process -Filter "Name='KeyBridge.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$lvKb = -1
if (Test-Path $log1) {
  $l = Get-Content $log1 -Encoding UTF8 | Select-Object -First 1
  if ($l -match '"integrity":(\d+)') { $lvKb = [int]$matches[1] }
}
$lvPy = -1
try {
  $src = [System.IO.File]::ReadAllText((Join-Path $root 'engine\diag\fgcheck.py'), [System.Text.Encoding]::UTF8)
  $probe = Join-Path $tmpDir '_py-level.py'
  [System.IO.File]::WriteAllText($probe, $src + "`nprint('LEVEL=%d' % self_integrity())`n", (New-Object System.Text.UTF8Encoding($false)))
  $out = & $pyExe $probe 2>$null
  if (($out -join ' ') -match 'LEVEL=(\d+)') { $lvPy = [int]$matches[1] }
} catch { }

Write-Host ("   原版 C# 引擎: " + (LvName $lvKb) + " (" + $lvKb + ")")
Write-Host ("   python 版引擎: " + (LvName $lvPy) + " (" + $lvPy + ")")
$chosen = if ($lvKb -ge 0x2000) { '原版 C#' } else { 'python 版' }
$chosenLv = if ($lvKb -ge 0x2000) { $lvKb } else { $lvPy }
if ($chosenLv -ge 0x2000) {
  Good ("实际会用: " + $chosen + "（" + (LvName $chosenLv) + "）—— 能注入到浏览器")
} else {
  Bad ("实际会用: " + $chosen + "（" + (LvName $chosenLv) + "）—— 注入会被系统丢掉")
}

Line "3. 链路进程"
$col = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'rc003-tap' })
$eng = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'read-engine\.py|KeyBridge\.exe read' })
Write-Host ("   采集器: " + $col.Count + " 个" + $(if ($col.Count) { "  PID " + (($col | ForEach-Object { $_.ProcessId }) -join ',') }))
Write-Host ("   引擎:   " + $eng.Count + " 个" + $(if ($eng.Count) { "  PID " + (($eng | ForEach-Object { $_.ProcessId }) -join ',') }))
foreach ($e in $eng) {
  Write-Host ("           PID " + $e.ProcessId + " · " + $(if ($e.CommandLine -match 'read-engine\.py') { 'python 版' } else { '原版 C#' }))
}
if ($col.Count -eq 0 -or $eng.Count -eq 0) { Bad "链路没起来 —— 调一次 POST /mi-remote/api/bridge/auto" }
else {
  /*
   * ★ 引擎实例数必须正好是 1。
   *
   * 2026-10-11 踩过：killStrayPipeline 的清杀名单漏了 python 版引擎，于是每次 /bridge/auto
   * 起新引擎时旧的不被回收（Windows 上父进程死了子进程也不跟着死），实测攒到 4 个实例 ——
   * 每个都读同一个 keys.jsonl、各注入一次，症状是"音量一按触发两次""返回键动作打架""长按没反应"。
   * 每个 python 引擎是 venv 父子两个进程，所以进程数 2 = 1 个实例。
   */
  $colInst = [math]::Ceiling($col.Count / 2)
  $engInst = [math]::Ceiling($eng.Count / 2)
  if ($engInst -gt 1) {
    Bad ("引擎有 " + $engInst + " 个实例在同时跑 —— 每个都会注入一次，按键会重复触发！跑 tools\kill-strays.ps1 清掉")
  } elseif ($engInst -eq 1) {
    Good ("引擎 1 个实例" + $(if ($colInst -eq 1) { "、采集器 1 个实例" } else { "；但采集器有 " + $colInst + " 个实例" }))
  }
}

Line "4. HID 通道 + 电量"
try {
  $link = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/mi-remote/api/link' -TimeoutSec 20
  Write-Host ("   HID: " + ($link.link.remote.hid | ConvertTo-Json -Compress) + "   电量: " + $link.link.remote.battery)
} catch { Warn "读不到 /mi-remote/api/link：$_" }

Line "5. 有没有可见的控制台窗口残留（用户要求一律静默）"
$vis = @(Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.ProcessName -match 'KeyBridge|keywin|conhost|python' })
if ($vis.Count -eq 0) { Good "没有残留窗口" }
else { $vis | ForEach-Object { Bad ($_.ProcessName + " pid=" + $_.Id + " 「" + $_.MainWindowTitle + "」") } }

Line "6. 能不能往当前前台窗口注入（决定按键落不落到浏览器里）"
# 必须用 python 读：未签名的 exe 被降级成 Low 后**读不到**更高完整性进程的令牌，
# 之前就是卡在这里 —— C# 版对浏览器永远显示"读不到"，没法判断。
$fg = @(& $pyExe (Join-Path $root 'engine\diag\fgcheck.py') 2>&1)
$fg | ForEach-Object { Write-Host ("   " + $_) }
if (($fg -join "`n") -match '=\s*能\s*$') { Good "允许注入 —— 按键能落到前台窗口" }
else { Bad "不允许注入 —— 按键会被系统丢掉" }

Write-Host ""
Write-Host "看第 2 项和第 6 项：都是[好]就说明遥控器按键能一路落到浏览器里。"
Write-Host "第 1 项[坏]只表示 360 的驱动还挂在内存里，重启后自然消失。"
