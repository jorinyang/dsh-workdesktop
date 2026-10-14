# cable-activate.ps1 -- 把 VB-CABLE 弄回可用状态。
#
# 「离线」不是一个状态，是三种，能做的事完全不同：
#
#   ① 驱动装了、设备被禁用或处于 Error  → **能修**：Enable-PnpDevice / 重启设备
#   ② 驱动装了、设备正常，但不是默认录音设备 → **能修**：切默认（那步在宿主侧走 voice/apply）
#   ③ 驱动压根没装                       → **修不了**：装驱动要管理员 + 安装包，
#                                          浏览器上一次点击没法静默完成。如实告诉用户怎么办。
#
# 这个脚本负责诊断 + 尝试 ①，并把结论以 RESULT_JSON= 打出（契约同 probe.ps1）。
#
# ⚠️ 本文件含非 ASCII ⇒ 必须保持 UTF-8 BOM，改完跑 scripts/fix-bom.mjs。
# ⚠️ PowerShell 的注释是 `#`，不是 `/* */`（这个坑在本插件里踩过一次）。

param(
  [Parameter(Position = 0)][string]$Action = 'activate'
)

$ErrorActionPreference = 'Continue'

function Write-ResultLine([string]$Text) {
  # 用原始字节写 UTF-8，绕开 PS 5.1 管道的 OEM 编码（同 probe.ps1）
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text + "`n")
  $stdout = [System.Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
function Emit($obj) {
  Write-ResultLine ('RESULT_JSON=' + ($obj | ConvertTo-Json -Depth 6 -Compress))
}

# ── 诊断：把和 VB-CABLE 相关的设备全捞出来，按状态分类 ──
$all = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  $_.FriendlyName -match 'CABLE|VB-Audio'
})
$audioEndpoints = @($all | Where-Object { $_.Class -eq 'AudioEndpoint' })
$mediaDevices = @($all | Where-Object { $_.Class -eq 'MEDIA' })

$hasAny = ($all.Count -gt 0)
$hasEndpoint = ($audioEndpoints.Count -gt 0)
# 有端点但状态不是 OK 的，就是"装了但没起来"
$badOnes = @($all | Where-Object { $_.Status -ne 'OK' })

if (-not $hasAny) {
  Emit ([ordered]@{
    ok      = $false
    reason  = 'not-installed'
    message = '没找到 VB-CABLE。它是个虚拟声卡驱动，得先装。'
    action  = 'install'
    # 安装包不在仓库里（第三方软件，见 assets/vendor/README.md）
    howto   = '从 vb-audio.com/Cable 下 VB-CABLE Driver Pack，解压后管理员运行 VBCABLE_Setup_x64.exe，装完重启一次'
  })
  exit 0
}

if (-not $hasEndpoint) {
  Emit ([ordered]@{
    ok      = $false
    reason  = 'no-endpoint'
    message = '驱动在，但没看到 CABLE 的音频端点 —— 驱动可能没装完或需要重启。'
    action  = 'reinstall'
    devices = @($all | ForEach-Object { [ordered]@{ name = $_.FriendlyName; class = $_.Class; status = $_.Status } })
    howto   = '管理员跑一次 VBCABLE_Setup_x64.exe 选 Install Driver，然后重启'
  })
  exit 0
}

# ── 到了这里说明端点在。看看有没有需要修的设备 ──
$fixed = @()
$failed = @()

if ($badOnes.Count -gt 0 -and $Action -eq 'activate') {
  foreach ($d in $badOnes) {
    try {
      # Enable-PnpDevice 需要管理员。dsh 一般以管理员跑，所以通常可用；
      # 不是管理员时会抛，下面 catch 住并如实回报（不假装成功）。
      Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop
      $after = Get-PnpDevice -InstanceId $d.InstanceId -ErrorAction SilentlyContinue
      if ($null -ne $after -and $after.Status -eq 'OK') {
        $fixed += $d.FriendlyName
      } else {
        $failed += ($d.FriendlyName + ' → 启用后状态仍是 ' + $after.Status)
      }
    } catch {
      $failed += ($d.FriendlyName + ' → ' + $_.Exception.Message)
    }
  }
}

$badNow = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  ($_.FriendlyName -match 'CABLE|VB-Audio') -and $_.Status -ne 'OK'
})

# 判据按**音频端点**算，不按"每一个相关设备"。
#
# 为什么：本机实测有一个 Class=MEDIA 的残留条目常年是 Error，而三个 AudioEndpoint
# 全是 OK —— 声音链路是通的。若按"所有设备都 OK"判，会把这个幻影报成"离线"，
# 用户点半天也修不好（Enable-PnpDevice 对它无效），徒增困惑。真正的可用性取决于端点。
$badEndpoints = @($audioEndpoints | Where-Object { $_.Status -ne 'OK' })
$usable = ($badEndpoints.Count -eq 0)

Emit ([ordered]@{
  ok        = $usable
  reason    = if ($usable) { 'ready' } else { 'endpoint-bad' }
  message   = if ($usable) { 'CABLE 的音频端点是好的。若还是没声音，检查系统默认录音设备有没有选 CABLE Output。' }
              else { 'CABLE 的音频端点不正常，可能需要重装驱动或重启。' }
  action    = if ($usable) { 'set-default' } else { 'reinstall' }
  fixed     = $fixed
  failed    = $failed
  endpoints = @($audioEndpoints | ForEach-Object { [ordered]@{ name = $_.FriendlyName; status = $_.Status } })
  # MEDIA 那类残留条目单独列出来，并写明"不参与判据"
  strayMedia = @($mediaDevices | Where-Object { $_.Status -ne 'OK' } | ForEach-Object {
    [ordered]@{ name = $_.FriendlyName; status = $_.Status; note = '不参与判据：音频端点是好的就说明 CABLE 能用' }
  })
  howto     = '还不行就：管理员跑 VBCABLE_Setup_x64.exe → Install Driver → 重启'
})
