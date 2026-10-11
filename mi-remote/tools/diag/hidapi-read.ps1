param([int]$Seconds = 60)

# Windows.Devices.HumanInterfaceDevice —— WinRT 自己的 HID API。
# 为什么试它：GATT 那条路被 Windows 的 HID 驱动挡住（AccessDenied），
# 而 HID 设备本来是允许多个客户端同时读的；这个 API 走的是 HID 栈本身，不是 GATT，
# 所以有可能绕开那把锁，而且**不需要停用任何设备**。
$logPath = Join-Path $PSScriptRoot '_hidapi.log'
try { Start-Transcript -Path $logPath -Force | Out-Null } catch { }

[Windows.Devices.HumanInterfaceDevice.HidDevice, Windows.Devices.HumanInterfaceDevice, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$script:events = New-Object System.Collections.ArrayList

# ⚠️ GetDeviceSelector 有两个重载：(usagePage, usageId) 和 (usagePage, usageId, vendorId, productId)。
# 只传两个参数时前两个会被当成 usagePage/usageId —— 第一次就是这么找出来 0 个设备的。
# 这里四个都给：Generic Desktop(0x01) / Keyboard(0x06) + 小米遥控器的 VID/PID。
# GetDeviceSelector 只用 (usagePage, usageId) 这个重载 —— 传四个参数时拿到的是空串，
# FindAllAsync('') 会返回全机 794 个设备。所以这里只要"所有键盘"，然后自己按 VID/PID 过滤。
$selector = [Windows.Devices.HumanInterfaceDevice.HidDevice]::GetDeviceSelector(0x01, 0x06)
Write-Output ("SELECTOR " + $selector)
$infos = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
Write-Output ("FOUND-ALL " + $infos.Count)

$mine = @($infos | Where-Object { $_.Id -match '32B8' })
Write-Output ("FOUND-MINE " + $mine.Count)

$opened = 0
foreach ($info in $mine) {
  Write-Output ("DEVICE " + $info.Id)
  Write-Output ("  name=" + $info.Name)
  $hid = Await ([Windows.Devices.HumanInterfaceDevice.HidDevice]::FromIdAsync($info.Id, [Windows.Storage.FileAccessMode]::Read)) ([Windows.Devices.HumanInterfaceDevice.HidDevice])
  if ($hid -eq $null) { Write-Output "  OPEN-FAILED"; continue }
  $opened = $opened + 1
  Write-Output ("  OPENED vendor=" + $hid.VendorId + " product=" + $hid.ProductId + " usagePage=" + $hid.UsagePage + " usage=" + $hid.UsageId)
  $handler = [Windows.Foundation.TypedEventHandler[Windows.Devices.HumanInterfaceDevice.HidDevice, Windows.Devices.HumanInterfaceDevice.HidInputReportReceivedEventArgs]] {
    param($sender, $args)
    try {
      $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($args.Report.Data)
      $bytes = New-Object byte[] $reader.UnconsumedBufferLength
      $reader.ReadBytes($bytes)
      $hex = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ' '
      [void]$script:events.Add(("reportId=" + $args.Report.Id + "  " + $hex))
    } catch { }
  }
  $hid.add_InputReportReceived($handler)
}
Write-Output ("OPENED-TOTAL " + $opened)
Write-Output ("WAITING " + $Seconds + " seconds - press remote keys now")

$deadline = (Get-Date).AddSeconds($Seconds)
$last = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if ($script:events.Count -ne $last) {
    while ($last -lt $script:events.Count) {
      Write-Output ("DATA " + $script:events[$last])
      $last = $last + 1
    }
  }
}
Write-Output ("DONE total=" + $script:events.Count)
