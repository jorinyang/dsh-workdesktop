# bt-pair.ps1 -- 蓝牙：列出可连接的设备，以及把指定的一个配对/连上。
#
# 契约与 audio-device.ps1 / probe.ps1 一致：stdout 的**最后一行** `RESULT_JSON=` 是结果，
# 以原始 UTF-8 字节写出（PS 5.1 的管道会把非 ASCII 按 OEM 编，所以不能用 Write-Output 直接吐中文）。
#
# 用法：
#   bt-pair.ps1 scan              列出设备（未配对的 + 已配对但没连上的）
#   bt-pair.ps1 pair <deviceId>   配对一个（Id 从 scan 里拿）
#   bt-pair.ps1 connect <deviceId> 连一个已配对但当前没连上的
#
# 为什么要分 pair / connect：Windows 里这是两件事 ——
#   没配对过 → PairAsync；配对过但断了 → 用已配对的设备对象发起连接。
#   面板上应该一起列出、由用户点哪个就是哪个，但底层动作不同。
#
# ⚠️ 本文件含非 ASCII（设备名过滤、提示文案）⇒ 必须保持 UTF-8 BOM，改完跑 scripts/fix-bom.mjs。

param(
  [Parameter(Position = 0)][string]$Action = 'scan',
  [Parameter(Position = 1)][string]$DeviceId = ''
)

$ErrorActionPreference = 'Continue'

function Write-ResultLine([string]$Text) {
  # 关键：用原始字节写 UTF-8，绕开 PS 5.1 管道的 OEM 编码
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text + "`n")
  $stdout = [System.Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Emit($obj) {
  Write-ResultLine ('RESULT_JSON=' + ($obj | ConvertTo-Json -Depth 6 -Compress))
}

# WinRT 的 AsTask 助手在 System.Runtime.WindowsRuntime 里，不先 Add-Type 就找不到类型
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type, [int]$timeoutMs = 20000) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  if (-not $t.Wait($timeoutMs)) { throw ('timeout after ' + $timeoutMs + 'ms') }
  return $t.Result
}

function Get-Devices([bool]$paired, [int]$timeoutMs = 20000) {
  $sel = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($paired)
  $op = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($sel)
  $col = Await $op ([Windows.Devices.Enumeration.DeviceInformationCollection]) $timeoutMs
  $out = @()
  foreach ($d in $col) {
    $isPaired = $null; $canPair = $null
    try { $isPaired = $d.Pairing.IsPaired } catch { }
    try { $canPair = $d.Pairing.CanPair } catch { }
# ---
# ⚠️ 这里**不查**"当前连没连上"。
# 
# 查它得对每个设备 `BluetoothDevice.FromIdAsync` 再 await —— 每台要几秒，
# 设备一多整个 scan 直接超时（第一次写就是这么挂的：timeout after 20000ms）。
# 而且面板**本来就知道**遥控器连没连：`/link` 里那个 `remote.ok` 就是。
# scan 只负责回答"有哪些设备可以点"，连不连是别处的事。

    $out += [ordered]@{
      id      = $d.Id
      name    = $d.Name
      paired  = $isPaired
      canPair = $canPair
      # 遥控器特征：名字里带这些的，面板上排前面（用户多半就是要点它）
      likely  = [bool]($d.Name -match 'MI RC|Xiaomi|小米|遥控|Remote')
    }
  }
  return $out
}

try {
  if ($Action -eq 'scan') {
# ---
# ⚠️ **未配对枚举天生慢，要给它足够的预算。**
# 
# 实测（tools/diag/_bt-timing.ps1）：
#     未配对 FindAllAsync    → 20 秒还没回（超时）
#     已配对 FindAllAsync    → 0.1 秒（读缓存）
#     全量 GetDeviceSelector → 0.1 秒
# 原因是枚举未配对设备要网卡做一次**主动搜索（inquiry）**，物理上就要十几秒；
# 已配对的直接读缓存。**这不是 bug，所以不能靠缩短超时解决** ——
# 要给够预算，同时**超时也要能返回可用的东西**（已配对那份 + 一句说明），
# 而不是整个 scan 报失败、界面上一片空白。

    $pairedList = @()
    $pairedError = $null
    try { $pairedList = @(Get-Devices $true 8000) } catch { $pairedError = $_.Exception.Message }
    # 不要按 $_.paired 过滤：这份列表本来就来自「已配对」选择器，
    # 而每项里的 paired 字段取自 Pairing.IsPaired，取不到时是 $null ——
    # 用 `-eq $true` 过滤会把整批滤没（实测：列表里有设备，过滤后变 0）。
    $pairedOffline = $pairedList

    $unpaired = @()
    $unpairedTimedOut = $false
    $unpairedError = $null
    # 未配对要网卡做主动搜索（inquiry），实测 28 秒都不一定够 —— 给到 45 秒。
    # 界面那边必须有"搜索中…"的状态：这个请求本来就要等这么久，不是卡住。
    try { $unpaired = @(Get-Devices $false 45000) } catch { $unpairedTimedOut = $true; $unpairedError = $_.Exception.Message }

    Emit ([ordered]@{
      ok               = $true
      unpaired         = $unpaired
      pairedOffline    = $pairedOffline
      unpairedTimedOut = $unpairedTimedOut
      pairedError      = $pairedError
      unpairedError    = $unpairedError
      hint             = '遥控器要先进配对模式：长按「菜单 + 主页」；搜附近的设备要十几秒'
    })
  }
  elseif ($Action -eq 'pair' -or $Action -eq 'connect') {
    if ([string]::IsNullOrWhiteSpace($DeviceId)) { Emit ([ordered]@{ ok = $false; error = 'need-device-id' }); exit 0 }
    $op = [Windows.Devices.Enumeration.DeviceInformation]::CreateFromIdAsync($DeviceId)
    $info = Await $op ([Windows.Devices.Enumeration.DeviceInformation])
    if ($null -eq $info) { Emit ([ordered]@{ ok = $false; error = 'device-not-found'; id = $DeviceId }); exit 0 }

    if ($Action -eq 'pair') {
      if ($info.Pairing.IsPaired) {
        Emit ([ordered]@{ ok = $true; alreadyPaired = $true; name = $info.Name })
        exit 0
      }
      if (-not $info.Pairing.CanPair) {
        Emit ([ordered]@{ ok = $false; error = 'cannot-pair'; name = $info.Name; hint = '这个设备当前不接受配对，确认遥控器在配对模式' })
        exit 0
      }
      # 用默认的配对方式（ProvidePassword 那种要 PIN 的走不通，遥控器一般是 JustWorks）
      $pop = $info.Pairing.PairAsync()
      $res = Await $pop ([Windows.Devices.Enumeration.DevicePairingResult])
      $status = $res.Status.ToString()
      Emit ([ordered]@{
        ok     = ($status -eq 'Paired')
        status = $status
        name   = $info.Name
        hint   = if ($status -eq 'Paired') { '' } else { '配对没成功。先把遥控器按「菜单+主页」进配对模式，再点一次；若反复失败，去 Windows 设置里配一次' }
      })
    }
    else {
      # connect：已配对但断着 —— 打开设备对象即触发连接
      $bop = [Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($DeviceId)
      $bd = Await $bop ([Windows.Devices.Bluetooth.BluetoothDevice])
      if ($null -eq $bd) { Emit ([ordered]@{ ok = $false; error = 'device-not-found' }); exit 0 }
      $st = $bd.ConnectionStatus.ToString()
      $bd.Dispose()
      Emit ([ordered]@{
        ok        = ($st -eq 'Connected')
        status    = $st
        name      = $info.Name
        hint      = if ($st -eq 'Connected') { '' } else { '连接没建立。把遥控器唤醒一下（按任意键）再点一次' }
      })
    }
  }
  else {
    Emit ([ordered]@{ ok = $false; error = 'unknown-action'; action = $Action })
  }
} catch {
  Emit ([ordered]@{ ok = $false; error = 'exception'; message = $_.Exception.Message })
}
