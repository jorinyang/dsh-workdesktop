# kill-strays.ps1 —— 清掉所有残留的采集器与引擎（限本插件的，不误伤别的 python）。
#
# 2026-10-11：引擎一度攒到 4 个实例同时在跑，每个都读同一个按键流、各注入一次，
# 症状是"音量一按触发两次""返回键动作打架"。根因是 killStrayPipeline 的名单漏了
# python 版引擎 read-engine.py。这个脚本就是那条名单的独立可跑版本。
$targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'KeyBridge.exe' -and $_.CommandLine -match 'read') -or
  ($_.Name -eq 'python.exe' -and ($_.CommandLine -match 'rc003-tap' -or $_.CommandLine -match 'read-engine'))
}
Write-Host ("  找到 " + @($targets).Count + " 个残留进程")
foreach ($t in $targets) {
  $kind = if ($t.CommandLine -match 'rc003-tap') { '采集器' }
          elseif ($t.CommandLine -match 'read-engine') { 'python 引擎' }
          else { 'C# 引擎' }
  Write-Host ("    收掉 PID " + $t.ProcessId + " (" + $kind + ")")
  Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'KeyBridge.exe' -and $_.CommandLine -match 'read') -or
  ($_.Name -eq 'python.exe' -and ($_.CommandLine -match 'rc003-tap' -or $_.CommandLine -match 'read-engine'))
})
Write-Host ("  剩余 " + $left.Count + " 个")
